const assert = require('assert');
const mqtt = require('mqtt');
const db = require('../database');
const config = require('../config');
const { signPayload } = require('../security');
const { startMQTTBroker, stopMQTTBroker } = require('../mqttBroker');

async function runMqttTests() {
  console.log('====================================================');
  console.log('  STARTING COLDCHAIN MQTT PIPELINE VALIDATION TESTS');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  const TEST_PORT = 1888;

  // Start MQTT broker on isolated test port
  let lastBroadcast = null;
  await startMQTTBroker(data => { lastBroadcast = data; }, TEST_PORT);

  // Give broker 500ms to bind
  await new Promise(r => setTimeout(r, 500));

  const client = mqtt.connect(`mqtt://localhost:${TEST_PORT}`, {
    clientId: 'test_client_' + Date.now(),
    connectTimeout: 4000
  });

  await new Promise((resolve, reject) => {
    client.on('connect', () => {
      console.log('  ✔ [PASS] Connected to embedded Aedes MQTT broker on port ' + TEST_PORT);
      passed++;
      resolve();
    });
    client.on('error', reject);
  });

  // Test 1: Publish valid telemetry packet
  try {
    const time = Date.now();
    const nonce = 'mqtt_nonce_' + Math.random().toString(36).substring(2, 9);
    const payload = {
      fridge_id: 'fridge_1',
      temperature: 5.4,
      door_state: 'CLOSED',
      door_open_seconds: 0,
      power_source: 'GRID',
      compressor_state: 'OFF'
    };
    const signature = signPayload(payload, time, nonce, config.DEVICE_HMAC_SECRET);
    const packet = { payload, timestamp: time, nonce, signature };

    client.publish('coldchain/fridge_1/telemetry', JSON.stringify(packet));

    // Wait for processing
    await new Promise(r => setTimeout(r, 500));

    const fridge = db.prepare('SELECT current_temp, compressor_state FROM fridges WHERE id = ?').get('fridge_1');
    assert.strictEqual(fridge.current_temp, 5.4, 'Fridge temp must update from MQTT telemetry');
    assert.ok(lastBroadcast !== null, 'Must trigger WebSocket broadcast on MQTT publish');
    console.log('  ✔ [PASS] Valid HMAC telemetry published via MQTT and processed');
    passed++;
  } catch (err) {
    console.error('  ✘ [FAIL] Valid MQTT telemetry:', err.message);
    failed++;
  }

  // Test 2: Publish tampered telemetry packet (should be rejected)
  try {
    const time = Date.now();
    const nonce = 'tampered_nonce_' + Math.random();
    const payload = { fridge_id: 'fridge_1', temperature: 25.0 };
    const invalidSignature = 'bad_tampered_signature_12345';
    const packet = { payload, timestamp: time, nonce, signature: invalidSignature };

    client.publish('coldchain/fridge_1/telemetry', JSON.stringify(packet));
    await new Promise(r => setTimeout(r, 400));

    const log = db.prepare('SELECT id FROM telemetry_logs WHERE nonce = ?').get(nonce);
    assert.strictEqual(log, undefined, 'Tampered packet must not be logged');
    console.log('  ✔ [PASS] Tampered MQTT packet successfully rejected');
    passed++;
  } catch (err) {
    console.error('  ✘ [FAIL] Tampered MQTT packet:', err.message);
    failed++;
  }

  client.end();
  stopMQTTBroker();

  console.log('\n====================================================');
  console.log(`  MQTT RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) process.exit(1);
}

runMqttTests().catch(err => {
  console.error('Fatal MQTT test error:', err);
  process.exit(1);
});
