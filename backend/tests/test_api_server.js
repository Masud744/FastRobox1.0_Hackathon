/**
 * API Server Integration Test Suite
 * Tests all REST endpoints, Public QR Check, RBAC Route Protection, HMAC intake, and WebSocket.
 */
const assert = require('assert');
const crypto = require('crypto');
const { app, server } = require('../server');
const { signPayload } = require('../security');
const config = require('../config');

// Simple native test helper using Node's http/fetch
async function runApiTests() {
  console.log('====================================================');
  console.log('  STARTING COLDCHAIN API ENDPOINTS INTEGRATION TESTS');
  console.log('====================================================\n');

  // Start test server on an ephemeral port
  const testPort = 5999;
  await new Promise(resolve => server.listen(testPort, resolve));
  const baseUrl = `http://127.0.0.1:${testPort}`;

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✔ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✘ [FAIL] ${name}`);
      console.error(`    -> Error: ${err.message}`);
      failed++;
    }
  }

  let adminToken = '';
  let pharmacistToken = '';
  let inspectorToken = '';

  // TEST 1: Login & Token Issuance
  await test('POST /api/auth/login handles valid and invalid credentials', async () => {
    // Admin Login
    const adminRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@123' })
    });
    const adminData = await adminRes.json();
    assert.strictEqual(adminRes.status, 200);
    assert.strictEqual(adminData.user.role, 'Admin');
    adminToken = adminData.token;

    // Pharmacist Login
    const pharmaRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pharmacist', password: 'Pharma@123' })
    });
    const pharmaData = await pharmaRes.json();
    assert.strictEqual(pharmaRes.status, 200);
    assert.strictEqual(pharmaData.user.role, 'Pharmacist');
    pharmacistToken = pharmaData.token;

    // Inspector Login
    const inspectRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'inspector', password: 'Inspect@123' })
    });
    const inspectData = await inspectRes.json();
    assert.strictEqual(inspectRes.status, 200);
    assert.strictEqual(inspectData.user.role, 'Inspector');
    inspectorToken = inspectData.token;

    // Invalid Login
    const failRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'WrongPassword' })
    });
    assert.strictEqual(failRes.status, 401);
  });

  // TEST 2: GET /api/fridges and /api/batches
  await test('GET /api/fridges and /api/batches return live inventory', async () => {
    const fridgesRes = await fetch(`${baseUrl}/api/fridges`);
    const fridges = await fridgesRes.json();
    assert.strictEqual(fridgesRes.status, 200);
    assert.strictEqual(fridges.length, 2);

    const batchesRes = await fetch(`${baseUrl}/api/batches`);
    const batches = await batchesRes.json();
    assert.strictEqual(batchesRes.status, 200);
    assert.ok(batches.length >= 4);
  });

  // TEST 3: PUBLIC QR CHECK (Task 4: Zero login required)
  await test('GET /api/batches/public-verify/:idOrQr is accessible WITHOUT login', async () => {
    // Check by QR code
    const res = await fetch(`${baseUrl}/api/batches/public-verify/QR-CV19-001-A9Z`);
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.verified, true);
    assert.strictEqual(data.batchId, 'BATCH-CV19-001');
    assert.ok(['Safe', 'At Risk', 'Discard'].includes(data.status), `Status must be a valid state: ${data.status}`);
    assert.ok(data.safetyVerdict);
    assert.ok(data.heatExposure.totalBudgetMinutes === 60);

    // Check invalid QR code
    const invalidRes = await fetch(`${baseUrl}/api/batches/public-verify/NON-EXISTENT-QR`);
    assert.strictEqual(invalidRes.status, 404);
  });

  // TEST 4: POST /api/telemetry with HMAC Validation
  await test('POST /api/telemetry accepts valid HMAC and rejects tampered packet', async () => {
    const timestamp = Date.now();
    const nonce = 'api-nonce-' + crypto.randomBytes(6).toString('hex');
    const payload = {
      fridge_id: 'fridge_1',
      temperature: 4.2,
      door_state: 'CLOSED',
      power_source: 'GRID',
      compressor_state: 'OFF'
    };

    const signature = signPayload(payload, timestamp, nonce, config.DEVICE_HMAC_SECRET);

    // 1. Valid transmission
    const validRes = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, timestamp, nonce, signature })
    });
    const validData = await validRes.json();
    assert.strictEqual(validRes.status, 200);
    assert.strictEqual(validData.status, 'ACCEPTED');

    // 2. Tampered transmission
    const tamperedRes = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: { ...payload, temperature: 99.0 },
        timestamp,
        nonce: 'another-nonce-' + Date.now(),
        signature // Original signature does not match tampered payload!
      })
    });
    assert.strictEqual(tamperedRes.status, 403);
  });

  // TEST 5: AI Forecast & Compressor Health Endpoints
  await test('GET /api/ai/forecast & /api/ai/compressor-health return valid predictions', async () => {
    const forecastRes = await fetch(`${baseUrl}/api/ai/forecast/fridge_1`);
    const forecast = await forecastRes.json();
    assert.strictEqual(forecastRes.status, 200);
    assert.ok(typeof forecast.predictedTemp30Min === 'number');

    const healthRes = await fetch(`${baseUrl}/api/ai/compressor-health/fridge_1`);
    const health = await healthRes.json();
    assert.strictEqual(healthRes.status, 200);
    assert.ok(health.score >= 0 && health.score <= 100);

    const reportRes = await fetch(`${baseUrl}/api/ai/report`);
    const report = await reportRes.json();
    assert.strictEqual(reportRes.status, 200);
    assert.ok(report.models.length >= 2);
  });

  // TEST 6: RBAC Route Enforcement (1-Click Relocation by Pharmacist)
  await test('POST /api/ai/relocation-confirm enforces Pharmacist/Admin role', async () => {
    // Get a recommendation
    const planRes = await fetch(`${baseUrl}/api/ai/relocation-recommendation/fridge_1`);
    const plan = await planRes.json();

    // Inspector cannot confirm (403 Forbidden)
    const inspectConfirm = await fetch(`${baseUrl}/api/ai/relocation-confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${inspectorToken}`
      },
      body: JSON.stringify({ planId: plan.planId })
    });
    assert.strictEqual(inspectConfirm.status, 403);

    // Pharmacist can confirm (200 OK)
    const pharmaConfirm = await fetch(`${baseUrl}/api/ai/relocation-confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pharmacistToken}`
      },
      body: JSON.stringify({ planId: plan.planId })
    });
    assert.strictEqual(pharmaConfirm.status, 200);
  });

  // TEST 7: Cryptographic Hash Chain Live Verification
  await test('GET /api/audit/verify-integrity returns valid ledger state', async () => {
    const res = await fetch(`${baseUrl}/api/audit/verify-integrity`);
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.valid, true, 'Cryptographic chain must be valid');
    assert.ok(data.totalRecords >= 1);
  });

  // Close test server
  server.close();

  console.log('\n====================================================');
  console.log(`  API TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runApiTests();
