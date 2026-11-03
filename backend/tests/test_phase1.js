/**
 * Phase 1 Comprehensive Validation Test Suite
 * Validates Database, RBAC, HMAC Device Security, and Cryptographic Hash Chain.
 */
const assert = require('assert');
const crypto = require('crypto');
const db = require('../database');
const { loginUser, authenticateToken, requireRoles } = require('../auth');
const {
  signPayload,
  verifyDeviceTelemetry,
  appendAuditLog,
  verifyHashChainIntegrity,
  simulateTamperRecord
} = require('../security');
const config = require('../config');

async function runTests() {
  console.log('====================================================');
  console.log('  STARTING COLDCHAIN PHASE 1 VALIDATION TESTS');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✔ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✘ [FAIL] ${name}`);
      console.error(`    -> Error: ${err.message}`);
      failed++;
    }
  }

  // TEST 1: Database Tables & Seeds
  test('DB Tables & Initial Seeds exist', () => {
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const fridgeCount = db.prepare('SELECT COUNT(*) as count FROM fridges').get().count;
    const batchCount = db.prepare('SELECT COUNT(*) as count FROM vaccine_batches').get().count;
    const auditCount = db.prepare('SELECT COUNT(*) as count FROM audit_log_chain').get().count;

    assert.ok(userCount >= 3, 'Should have at least 3 users');
    const defaultUsers = db.prepare("SELECT username FROM users WHERE username IN ('admin', 'pharmacist', 'inspector')").all();
    assert.strictEqual(defaultUsers.length, 3, 'Default users admin, pharmacist, and inspector must exist');
    assert.strictEqual(fridgeCount, 2, 'Should have 2 fridges (Fridge 1 & Fridge 2)');
    assert.ok(batchCount >= 5, 'Should have at least 5 vaccine batches');
    assert.ok(auditCount >= 1, 'Should have at least 1 audit block (Genesis block)');
  });

  // TEST 2: RBAC & User Login
  test('User authentication with bcrypt & JWT', () => {
    // Valid Admin Login
    const adminRes = loginUser('admin', 'Admin@123');
    assert.strictEqual(adminRes.success, true);
    assert.strictEqual(adminRes.user.role, 'Admin');
    assert.ok(adminRes.token, 'Token must be issued');

    // Valid Pharmacist Login
    const pharmaRes = loginUser('pharmacist', 'Pharma@123');
    assert.strictEqual(pharmaRes.success, true);
    assert.strictEqual(pharmaRes.user.role, 'Pharmacist');

    // Invalid Password
    const failRes = loginUser('admin', 'WrongPass123');
    assert.strictEqual(failRes.success, false);
    assert.strictEqual(failRes.error, 'INVALID_CREDENTIALS');
  });

  // TEST 3: Device HMAC-SHA256 Signature Validation
  test('HMAC-SHA256 device telemetry validation', () => {
    const timestamp = Date.now();
    const nonce = 'test-nonce-' + crypto.randomBytes(8).toString('hex');
    const payload = {
      fridge_id: 'fridge_1',
      temperature: 4.5,
      door_state: 'CLOSED',
      power_source: 'GRID',
      compressor_state: 'OFF'
    };

    const signature = signPayload(payload, timestamp, nonce, config.DEVICE_HMAC_SECRET);
    const packet = { payload, timestamp, nonce, signature };

    const result = verifyDeviceTelemetry(packet, config.DEVICE_HMAC_SECRET);
    assert.strictEqual(result.valid, true, 'Valid telemetry must pass');
  });

  // TEST 4: HMAC Rejection on Tampered Payload
  test('HMAC rejects tampered payload', () => {
    const timestamp = Date.now();
    const nonce = 'test-nonce-tamper-' + crypto.randomBytes(8).toString('hex');
    const payload = {
      fridge_id: 'fridge_1',
      temperature: 4.5,
      door_state: 'CLOSED',
      power_source: 'GRID',
      compressor_state: 'OFF'
    };

    const signature = signPayload(payload, timestamp, nonce, config.DEVICE_HMAC_SECRET);

    // Attacker modifies temperature in transit from 4.5 to 15.0
    const tamperedPayload = { ...payload, temperature: 15.0 };
    const packet = { payload: tamperedPayload, timestamp, nonce, signature };

    const result = verifyDeviceTelemetry(packet, config.DEVICE_HMAC_SECRET);
    assert.strictEqual(result.valid, false, 'Tampered payload must be rejected');
    assert.strictEqual(result.error, 'INVALID_SIGNATURE');
  });

  // TEST 5: Replay Attack Defense (Duplicate Nonce)
  test('Replay attack protection rejects reused nonce', () => {
    const timestamp = Date.now();
    const nonce = 'replay-nonce-' + crypto.randomBytes(8).toString('hex');
    const payload = {
      fridge_id: 'fridge_1',
      temperature: 5.0,
      door_state: 'CLOSED',
      power_source: 'GRID',
      compressor_state: 'OFF'
    };

    const signature = signPayload(payload, timestamp, nonce, config.DEVICE_HMAC_SECRET);
    const packet = { payload, timestamp, nonce, signature };

    // First transmission: must pass
    const firstResult = verifyDeviceTelemetry(packet, config.DEVICE_HMAC_SECRET);
    assert.strictEqual(firstResult.valid, true);

    // Replay transmission with identical nonce: must fail!
    const replayResult = verifyDeviceTelemetry(packet, config.DEVICE_HMAC_SECRET);
    assert.strictEqual(replayResult.valid, false);
    assert.strictEqual(replayResult.error, 'REPLAY_ATTACK_DETECTED');
  });

  // TEST 6: Freshness Window (Reject Stale Timestamps)
  test('Reject stale timestamps older than 5 minutes', () => {
    const staleTimestamp = Date.now() - (6 * 60 * 1000); // 6 minutes ago
    const nonce = 'stale-nonce-' + crypto.randomBytes(8).toString('hex');
    const payload = { fridge_id: 'fridge_1', temperature: 4.0 };

    const signature = signPayload(payload, staleTimestamp, nonce, config.DEVICE_HMAC_SECRET);
    const packet = { payload, timestamp: staleTimestamp, nonce, signature };

    const result = verifyDeviceTelemetry(packet, config.DEVICE_HMAC_SECRET);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, 'STALE_TIMESTAMP');
  });

  // TEST 7: Cryptographic Hash Chain Append & Integrity Verification
  test('Cryptographic Hash Chain append and full ledger verification', () => {
    // Append 3 sample audit events
    appendAuditLog('VACCINE_CHECK', { batch: 'BATCH-CV19-001', temp: 4.2 }, 'pharmacist');
    appendAuditLog('COMPRESSOR_TOGGLE', { fridge: 'fridge_1', state: 'ON' }, 'system');
    appendAuditLog('ADMIN_OVERRIDE', { note: 'Routine scheduled inspection' }, 'admin');

    const integrityResult = verifyHashChainIntegrity();
    assert.strictEqual(integrityResult.valid, true, 'Hash chain integrity should be valid');
    assert.ok(integrityResult.totalRecords >= 4, 'Should have at least 4 records including genesis');
    assert.ok(integrityResult.headHash.length === 64, 'Head hash must be 64-character SHA-256');
  });

  // TEST 8: Hash Chain Tampering Detection
  test('Hash Chain detects tampered database record', () => {
    // Add an audit log to tamper with
    const newEntry = appendAuditLog('SECURITY_CHECK', { status: 'NORMAL' }, 'inspector');

    // Verify chain is valid initially
    assert.strictEqual(verifyHashChainIntegrity().valid, true);

    // Malicious attacker directly modifies the record data in SQLite without re-hashing
    simulateTamperRecord(newEntry.id, { status: 'ALTERED_BY_ATTACKER' });

    // Verify chain now flags corruption!
    const tamperedResult = verifyHashChainIntegrity();
    assert.strictEqual(tamperedResult.valid, false, 'Tampered ledger must be caught!');
    assert.strictEqual(tamperedResult.compromisedRowId, newEntry.id, 'Must pinpoint exact tampered row ID');
    assert.strictEqual(tamperedResult.reason, 'DATA_TAMPERED');

    // Restore original state
    simulateTamperRecord(newEntry.id, { status: 'NORMAL' });
    assert.strictEqual(verifyHashChainIntegrity().valid, true, 'Restored ledger should verify as valid again');
  });

  console.log('\n====================================================');
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
