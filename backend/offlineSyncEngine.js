const db = require('./database');
const { verifyDeviceTelemetry, appendAuditLog } = require('./security');
const { processTelemetryHeatExposure } = require('./heatBudgetEngine');
const config = require('./config');

/**
 * OFFLINE SYNC & DEDUPLICATION ENGINE
 *
 * Requirements:
 * - Buffer at least 30 minutes of readings during Wi-Fi loss.
 * - Sync them in order without duplicates.
 * - Backfill heat exposure calculations chronologically.
 */

/**
 * Sync offline telemetry buffer
 * @param {Array} packetBuffer Array of telemetry packets [{ payload, timestamp, nonce, signature }]
 * @param {string} secretKey Device HMAC secret key
 */
function syncOfflineTelemetryBuffer(packetBuffer, secretKey = config.DEVICE_HMAC_SECRET) {
  if (!Array.isArray(packetBuffer) || packetBuffer.length === 0) {
    return {
      syncedCount: 0,
      skippedCount: 0,
      totalCount: 0,
      message: 'Buffer is empty.'
    };
  }

  // 1. Sort buffer chronologically by timestamp ASC
  const sortedBuffer = [...packetBuffer].sort((a, b) => a.timestamp - b.timestamp);

  let syncedCount = 0;
  let duplicateCount = 0;
  let invalidSignatureCount = 0;

  const insertTelemetry = db.prepare(`
    INSERT INTO telemetry_logs (fridge_id, temperature, door_state, door_open_seconds, power_source, compressor_state, timestamp, nonce)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const checkDuplicate = db.prepare(`
    SELECT id FROM telemetry_logs WHERE fridge_id = ? AND timestamp = ?
  `);

  // Use an atomic transaction for syncing the entire buffer
  const syncTransaction = db.transaction(() => {
    let lastTimestamp = null;

    for (const packet of sortedBuffer) {
      const { payload, timestamp, nonce, signature } = packet;

      if (!payload || !timestamp || !nonce) {
        continue;
      }

      // Check if duplicate in database (by nonce or fridge_id + timestamp)
      const existingNonce = db.prepare('SELECT nonce FROM device_nonces WHERE nonce = ?').get(nonce);
      const existingReading = checkDuplicate.get(payload.fridge_id, timestamp);

      if (existingNonce || existingReading) {
        duplicateCount++;
        continue; // Skip duplicate without throwing
      }

      // For offline buffers, verify HMAC signature with relaxed timestamp window
      // (because buffered readings are from the past)
      const expectedSig = require('./security').signPayload(payload, timestamp, nonce, secretKey);
      if (expectedSig !== signature) {
        invalidSignatureCount++;
        continue; // Reject invalid signature
      }

      // Record nonce
      db.prepare('INSERT INTO device_nonces (nonce, timestamp) VALUES (?, ?)').run(nonce, timestamp);

      // Insert telemetry
      insertTelemetry.run(
        payload.fridge_id,
        payload.temperature,
        payload.door_state || 'CLOSED',
        payload.door_open_seconds || 0,
        payload.power_source || 'GRID',
        payload.compressor_state || 'OFF',
        timestamp,
        nonce
      );

      // Calculate elapsed seconds since last buffered reading (or default 5s)
      const elapsedSeconds = lastTimestamp ? Math.max(1, (timestamp - lastTimestamp) / 1000) : 5;
      lastTimestamp = timestamp;

      // Update heat exposure budget for all batches in this fridge
      processTelemetryHeatExposure(payload.fridge_id, payload.temperature, elapsedSeconds);

      // Update current fridge status to the latest reading
      db.prepare(`
        UPDATE fridges
        SET current_temp = ?, door_state = ?, power_source = ?, compressor_state = ?, last_seen = ?
        WHERE id = ?
      `).run(
        payload.temperature,
        payload.door_state || 'CLOSED',
        payload.power_source || 'GRID',
        payload.compressor_state || 'OFF',
        timestamp,
        payload.fridge_id
      );

      syncedCount++;
    }

    if (syncedCount > 0) {
      // Record sync event into cryptographic hash chain
      appendAuditLog('OFFLINE_BUFFER_SYNC', {
        syncedCount,
        duplicateCount,
        invalidSignatureCount,
        startTime: sortedBuffer[0].timestamp,
        endTime: sortedBuffer[sortedBuffer.length - 1].timestamp
      }, 'system');
    }
  });

  syncTransaction();

  return {
    success: true,
    syncedCount,
    duplicateCount,
    invalidSignatureCount,
    totalCount: packetBuffer.length,
    message: `Successfully synchronized ${syncedCount} readings. Skipped ${duplicateCount} duplicates.`
  };
}

module.exports = {
  syncOfflineTelemetryBuffer
};
