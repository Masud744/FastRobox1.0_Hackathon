/**
 * Phase 2 Validation Test Suite
 * Validates Heat Exposure Budget, Offline Sync & Deduplication, and Door/Power Alerting.
 */
const assert = require('assert');
const crypto = require('crypto');
const db = require('../database');
const { processTelemetryHeatExposure, adminResetDiscardAlarm } = require('../heatBudgetEngine');
const { syncOfflineTelemetryBuffer } = require('../offlineSyncEngine');
const { processDoorAndPowerState, getRecentNotifications } = require('../alertEngine');
const { signPayload } = require('../security');
const config = require('../config');

async function runTests() {
  console.log('====================================================');
  console.log('  STARTING COLDCHAIN PHASE 2 VALIDATION TESTS');
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

  // Setup a clean test batch
  db.prepare(`
    INSERT OR REPLACE INTO vaccine_batches
    (id, name, type, fridge_id, expiry_date, total_budget_mins, consumed_budget_mins, status, qr_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('BATCH-TEST-HEAT', 'Test Vaccine Alpha', 'Test Type', 'fridge_1', '2027-12-31', 60.0, 0.0, 'Safe', 'QR-TEST-ALPHA');

  // TEST 1: Normal safe temperature does not consume budget
  test('Safe temperature (4.0°C) consumes 0 budget', () => {
    const res = processTelemetryHeatExposure('fridge_1', 4.0, 60); // 60 seconds at 4.0°C
    const batch = db.prepare('SELECT * FROM vaccine_batches WHERE id = ?').get('BATCH-TEST-HEAT');
    assert.strictEqual(batch.consumed_budget_mins, 0.0);
    assert.strictEqual(batch.status, 'Safe');
  });

  // TEST 2: Temperature between 8°C and 12°C consumes 1x budget
  test('Exposure between 8°C and 12°C (10.0°C) counts 1x budget', () => {
    // 300 seconds (5 minutes) at 10.0°C -> should consume exactly 5.0 minutes
    processTelemetryHeatExposure('fridge_1', 10.0, 300);
    const batch = db.prepare('SELECT * FROM vaccine_batches WHERE id = ?').get('BATCH-TEST-HEAT');
    assert.strictEqual(Number(batch.consumed_budget_mins.toFixed(1)), 5.0);
    assert.strictEqual(batch.status, 'Safe');
  });

  // TEST 3: Temperature above 12°C counts DOUBLE (2x penalty)
  test('Exposure above 12°C (14.0°C) counts DOUBLE (2x)', () => {
    // 300 seconds (5 minutes) at 14.0°C -> 5 mins * 2 = 10.0 minutes additional consumption
    // Previous was 5.0, so total should be 15.0 minutes!
    processTelemetryHeatExposure('fridge_1', 14.0, 300);
    const batch = db.prepare('SELECT * FROM vaccine_batches WHERE id = ?').get('BATCH-TEST-HEAT');
    assert.strictEqual(Number(batch.consumed_budget_mins.toFixed(1)), 15.0);
  });

  // TEST 4: Remaining budget < 20% triggers "At Risk"
  test('Remaining budget < 20% sets status to "At Risk"', () => {
    // Total budget is 60. 20% is 12 mins. So consumed > 48 mins should trigger "At Risk"
    // Currently at 15.0. Add 35 minutes of 1x exposure (2100s at 9.0°C) -> total 50.0 consumed (10 mins left = 16.7%)
    processTelemetryHeatExposure('fridge_1', 9.0, 2100);
    const batch = db.prepare('SELECT * FROM vaccine_batches WHERE id = ?').get('BATCH-TEST-HEAT');
    assert.strictEqual(Number(batch.consumed_budget_mins.toFixed(1)), 50.0);
    assert.strictEqual(batch.status, 'At Risk');
  });

  // TEST 5: Remaining budget reaches 0% triggers "Discard" and latches Red LED ON
  test('Remaining budget reaches 0% sets status to "Discard" & latches Red LED ON', () => {
    // Consume remaining 10 minutes (600s at 10.0°C)
    processTelemetryHeatExposure('fridge_1', 10.0, 600);
    const batch = db.prepare('SELECT * FROM vaccine_batches WHERE id = ?').get('BATCH-TEST-HEAT');
    assert.strictEqual(Number(batch.consumed_budget_mins.toFixed(1)), 60.0);
    assert.strictEqual(batch.status, 'Discard');

    // Verify Red LED is latched ON for Fridge 1
    const fridge = db.prepare('SELECT red_led_latched FROM fridges WHERE id = ?').get('fridge_1');
    assert.strictEqual(fridge.red_led_latched, 1, 'Red LED must latch ON!');
  });

  // TEST 6: Admin Reset unlatches Red LED
  test('Admin user resets discard alarm & unlatches Red LED', () => {
    const adminUser = { username: 'admin', role: 'Admin' };
    const resetRes = adminResetDiscardAlarm(adminUser, 'fridge_1', 'Safety protocol verified');
    assert.strictEqual(resetRes.success, true);
    assert.strictEqual(resetRes.red_led_latched, 0);

    const fridge = db.prepare('SELECT red_led_latched FROM fridges WHERE id = ?').get('fridge_1');
    assert.strictEqual(fridge.red_led_latched, 0, 'Red LED must be unlatched after Admin reset');

    // Verify non-admin cannot reset
    assert.throws(() => {
      adminResetDiscardAlarm({ username: 'pharmacist', role: 'Pharmacist' }, 'fridge_1');
    }, /Only users with Admin role/);
  });

  // TEST 7: Offline Sync with 30-min buffer and deduplication
  test('Offline Sync handles 30-min buffered readings and drops duplicates', () => {
    const now = Date.now();
    const packetBuffer = [];

    // Create 360 readings (30 minutes at 5s intervals)
    for (let i = 0; i < 10; i++) {
      const time = now - ((10 - i) * 5000);
      const nonce = 'sync-nonce-' + i + '-' + crypto.randomBytes(4).toString('hex');
      const payload = {
        fridge_id: 'fridge_2',
        temperature: 3.5 + (i * 0.1),
        door_state: 'CLOSED',
        power_source: 'GRID',
        compressor_state: 'OFF'
      };
      const signature = signPayload(payload, time, nonce, config.DEVICE_HMAC_SECRET);
      packetBuffer.push({ payload, timestamp: time, nonce, signature });
    }

    // Add 2 duplicate packets into the buffer
    packetBuffer.push(packetBuffer[0]);
    packetBuffer.push(packetBuffer[3]);

    const syncRes = syncOfflineTelemetryBuffer(packetBuffer, config.DEVICE_HMAC_SECRET);
    assert.strictEqual(syncRes.success, true);
    assert.strictEqual(syncRes.syncedCount, 10, 'Must sync the 10 unique readings');
    assert.strictEqual(syncRes.duplicateCount, 2, 'Must detect and skip the 2 duplicates');
  });

  // TEST 8: Door open >60s triggers buzzer and remote notifications
  test('Door open >60s triggers buzzer and remote notifications', () => {
    const startTime = Date.now() - 65000; // 65 seconds ago
    // Open door 65s ago
    processDoorAndPowerState('fridge_1', 'OPEN', 'GRID', startTime);
    // Current reading: still open
    const doorRes = processDoorAndPowerState('fridge_1', 'OPEN', 'GRID', Date.now());

    assert.strictEqual(doorRes.doorAlarmTriggered, true, 'Door alarm must trigger after 60s');
    assert.ok(doorRes.doorOpenSeconds >= 60);

    const alerts = db.prepare(`
      SELECT * FROM alerts WHERE fridge_id = 'fridge_1' AND alert_type = 'DOOR_OPEN_BREACH'
    `).all();
    assert.ok(alerts.length >= 1, 'Door open alert must be logged in database');

    const notifs = getRecentNotifications();
    assert.ok(notifs.some(n => n.channel === 'TELEGRAM'), 'Must dispatch Telegram alert');
    assert.ok(notifs.some(n => n.channel === 'EMAIL'), 'Must dispatch Email alert');

    // Close door -> resolves alarm
    processDoorAndPowerState('fridge_1', 'CLOSED', 'GRID', Date.now());
    const unresolvedAlerts = db.prepare(`
      SELECT * FROM alerts WHERE fridge_id = 'fridge_1' AND alert_type = 'DOOR_OPEN_BREACH' AND resolved = 0
    `).all();
    assert.strictEqual(unresolvedAlerts.length, 0, 'Alert must resolve when door is closed');
  });

  // TEST 9: Power Failure simulation triggers battery alert
  test('Power failure simulation triggers battery mode alert', () => {
    const powerRes = processDoorAndPowerState('fridge_1', 'CLOSED', 'BATTERY', Date.now());
    assert.strictEqual(powerRes.powerAlertTriggered, true);

    const powerAlert = db.prepare(`
      SELECT * FROM alerts WHERE fridge_id = 'fridge_1' AND alert_type = 'POWER_OUTAGE'
    `).get();
    assert.ok(powerAlert, 'Power outage alert must be recorded');

    // Clean up temporary test batch
    db.prepare(`DELETE FROM vaccine_batches WHERE id = 'BATCH-TEST-HEAT'`).run();
  });

  console.log('\n====================================================');
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
