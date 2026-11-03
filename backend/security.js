const crypto = require('crypto');
const db = require('./database');
const config = require('./config');

/**
 * =========================================================================
 * 1. DEVICE SECURITY: HMAC-SHA256 + TIMESTAMP + NONCE (Replay Protection)
 * =========================================================================
 */

/**
 * Sign payload with HMAC-SHA256 (used by ESP32 devices or simulator)
 */
function signPayload(payload, timestamp, nonce, secretKey = config.DEVICE_HMAC_SECRET) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const message = `${timestamp}:${nonce}:${serialized}`;
  return crypto.createHmac('sha256', secretKey).update(message).digest('hex');
}

/**
 * Verify Device Telemetry Packet
 * - Checks freshness against REPLAY_WINDOW_MS
 * - Rejects replayed nonces
 * - Verifies HMAC-SHA256 signature using timing-safe comparison
 */
function verifyDeviceTelemetry(packet, secretKey = config.DEVICE_HMAC_SECRET) {
  const { payload, timestamp, nonce, signature } = packet;

  if (!payload || !timestamp || !nonce || !signature) {
    return {
      valid: false,
      error: 'MISSING_SECURITY_HEADERS',
      message: 'Packet must contain payload, timestamp, nonce, and signature.'
    };
  }

  // 1. Check timestamp freshness
  const now = Date.now();
  const timeDifference = Math.abs(now - timestamp);
  if (timeDifference > config.REPLAY_WINDOW_MS) {
    return {
      valid: false,
      error: 'STALE_TIMESTAMP',
      message: `Timestamp skew (${timeDifference}ms) exceeds allowed window (${config.REPLAY_WINDOW_MS}ms).`
    };
  }

  // 2. Check for Replay Attack (Nonce Verification)
  const existingNonce = db.prepare('SELECT nonce FROM device_nonces WHERE nonce = ?').get(nonce);
  if (existingNonce) {
    // Record alert in database for tamper audit
    db.prepare(`
      INSERT INTO alerts (fridge_id, alert_type, message, severity, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      payload.fridge_id || 'UNKNOWN',
      'REPLAY_ATTACK_BLOCKED',
      `Blocked replay attack with duplicate nonce: ${nonce}`,
      'CRITICAL',
      now
    );

    return {
      valid: false,
      error: 'REPLAY_ATTACK_DETECTED',
      message: `Duplicate nonce ${nonce} detected. Telemetry rejected.`
    };
  }

  // 3. Verify HMAC-SHA256 Signature
  const expectedSignature = signPayload(payload, timestamp, nonce, secretKey);
  let expectedBuf = Buffer.from(expectedSignature, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');

  let signatureValid = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

  // If float serialization formatting difference (e.g. 21.9 vs 21.90 on C++ ArduinoJson), check 2-decimal format
  if (!signatureValid && payload && typeof payload.temperature === 'number') {
    const fixedPayload = JSON.stringify(payload).replace(
      new RegExp(`"temperature":${payload.temperature}`),
      `"temperature":${Number(payload.temperature).toFixed(2)}`
    );
    const fixedSig = crypto.createHmac('sha256', secretKey).update(`${timestamp}:${nonce}:${fixedPayload}`).digest('hex');
    const fixedBuf = Buffer.from(fixedSig, 'hex');
    if (fixedBuf.length === actualBuf.length && crypto.timingSafeEqual(fixedBuf, actualBuf)) {
      signatureValid = true;
    }
  }

  if (!signatureValid) {
    return {
      valid: false,
      error: 'INVALID_SIGNATURE',
      message: 'HMAC-SHA256 signature mismatch. Message was tampered with or key is wrong.'
    };
  }

  // Store nonce to prevent future replay of this exact packet
  db.prepare('INSERT INTO device_nonces (nonce, timestamp) VALUES (?, ?)').run(nonce, timestamp);

  return { valid: true };
}

/**
 * =========================================================================
 * 2. TAMPER-EVIDENT HASH CHAIN AUDIT LOG
 * =========================================================================
 */

/**
 * Calculate single block hash
 */
function calculateBlockHash(previousHash, timestamp, eventType, actor, recordDataStr) {
  const message = `${previousHash}:${timestamp}:${eventType}:${actor}:${recordDataStr}`;
  return crypto.createHash('sha256').update(message).digest('hex');
}

/**
 * Append an entry to the cryptographic hash chain
 */
function appendAuditLog(eventType, recordData, actor = 'system') {
  const recordDataStr = typeof recordData === 'string' ? recordData : JSON.stringify(recordData);
  const timestamp = Date.now();

  // Get the latest block in the chain
  const latestBlock = db.prepare('SELECT current_hash FROM audit_log_chain ORDER BY id DESC LIMIT 1').get();
  const previousHash = latestBlock ? latestBlock.current_hash : '0'.repeat(64);

  const currentHash = calculateBlockHash(previousHash, timestamp, eventType, actor, recordDataStr);

  const stmt = db.prepare(`
    INSERT INTO audit_log_chain (timestamp, event_type, record_data, actor, previous_hash, current_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(timestamp, eventType, recordDataStr, actor, previousHash, currentHash);
  return {
    id: result.lastInsertRowid,
    timestamp,
    eventType,
    actor,
    previousHash,
    currentHash
  };
}

/**
 * Verify Integrity of the entire Hash Chain
 * Traverses from genesis block to current head and validates every link.
 */
function verifyHashChainIntegrity() {
  const records = db.prepare('SELECT * FROM audit_log_chain ORDER BY id ASC').all();

  if (records.length === 0) {
    return { valid: true, totalRecords: 0, message: 'Ledger is empty.' };
  }

  for (let i = 0; i < records.length; i++) {
    const current = records[i];

    // 1. Verify link to previous hash
    if (i === 0) {
      if (current.previous_hash !== '0'.repeat(64)) {
        return {
          valid: false,
          compromisedRowId: current.id,
          reason: 'GENESIS_PREVIOUS_HASH_CORRUPTED',
          details: `Genesis block previous_hash must be 64 zeros, got: ${current.previous_hash}`
        };
      }
    } else {
      const previous = records[i - 1];
      if (current.previous_hash !== previous.current_hash) {
        return {
          valid: false,
          compromisedRowId: current.id,
          reason: 'HASH_CHAIN_DISCONNECTED',
          details: `Row ID ${current.id} previous_hash does not match Row ID ${previous.id} current_hash.`
        };
      }
    }

    // 2. Recompute and verify current hash
    const recomputedHash = calculateBlockHash(
      current.previous_hash,
      current.timestamp,
      current.event_type,
      current.actor,
      current.record_data
    );

    if (recomputedHash !== current.current_hash) {
      return {
        valid: false,
        compromisedRowId: current.id,
        reason: 'DATA_TAMPERED',
        details: `Row ID ${current.id} payload or metadata was tampered with. Expected hash: ${recomputedHash}, Recorded hash: ${current.current_hash}`
      };
    }
  }

  return {
    valid: true,
    totalRecords: records.length,
    headHash: records[records.length - 1].current_hash,
    message: 'Cryptographic ledger integrity verified. All hash chains match.'
  };
}

/**
 * Utility for demo / judges: intentionally modify a record in SQLite
 * to prove that the hash chain detector immediately catches tampering!
 */
function simulateTamperRecord(rowId, fakeRecordData) {
  const stmt = db.prepare('UPDATE audit_log_chain SET record_data = ? WHERE id = ?');
  stmt.run(typeof fakeRecordData === 'string' ? fakeRecordData : JSON.stringify(fakeRecordData), rowId);
  return { tamperedRowId: rowId };
}

/**
 * Cleanup expired nonces (older than replay window)
 */
function cleanupExpiredNonces() {
  const cutoff = Date.now() - config.REPLAY_WINDOW_MS;
  const result = db.prepare('DELETE FROM device_nonces WHERE timestamp < ?').run(cutoff);
  return result.changes;
}

module.exports = {
  signPayload,
  verifyDeviceTelemetry,
  appendAuditLog,
  verifyHashChainIntegrity,
  simulateTamperRecord,
  cleanupExpiredNonces
};
