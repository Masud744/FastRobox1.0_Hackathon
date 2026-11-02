/**
 * Phase 3 Validation Test Suite
 * Validates AI Breach Prediction, Compressor Health Scoring, Smart Relocation, and Pharmacist 1-Click Action.
 */
const assert = require('assert');
const db = require('../database');
const {
  predict30MinAhead,
  calculateCompressorHealthScore,
  generateRelocationRecommendation,
  confirmRelocation,
  getAIReport
} = require('../aiEngine');

async function runTests() {
  console.log('====================================================');
  console.log('  STARTING COLDCHAIN PHASE 3 (AI) VALIDATION TESTS');
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

  // Setup isolated test state
  db.prepare('DELETE FROM telemetry_logs').run();
  db.prepare("UPDATE vaccine_batches SET fridge_id = 'fridge_1' WHERE id = 'BATCH-CV19-001'").run();
  db.prepare("UPDATE vaccine_batches SET fridge_id = 'fridge_2' WHERE id = 'BATCH-HEPB-004'").run();

  // TEST 1: 30-Minute Temperature Forecasting on Normal Baseline
  test('30-minute ahead forecast predicts safe status when fridge is stable', () => {
    // Set fridge 2 to stable 3.8°C with stable telemetry
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO telemetry_logs (fridge_id, temperature, door_state, power_source, compressor_state, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('fridge_2', 3.8, 'CLOSED', 'GRID', 'OFF', now - ((5 - i) * 60000));
    }
    db.prepare('UPDATE fridges SET current_temp = ?, door_state = ?, compressor_state = ? WHERE id = ?')
      .run(3.8, 'CLOSED', 'OFF', 'fridge_2');

    const forecast = predict30MinAhead('fridge_2');
    assert.strictEqual(forecast.fridgeId, 'fridge_2');
    assert.ok(typeof forecast.predictedTemp30Min === 'number');
    assert.strictEqual(forecast.isBreachPredicted, false, `Stable fridge should not breach 8°C (predicted: ${forecast.predictedTemp30Min})`);
  });

  // TEST 2: 30-Minute Temperature Forecasting Detects Breach
  test('30-minute forecast detects breach warning when door is open or slope is rising', () => {
    // Set fridge 1 to 6.8°C with door open (fast heating)
    db.prepare('UPDATE fridges SET current_temp = ?, door_state = ? WHERE id = ?')
      .run(6.8, 'OPEN', 'fridge_1');

    const forecast = predict30MinAhead('fridge_1');
    assert.strictEqual(forecast.isBreachPredicted, true, 'Rising slope must trigger breach warning');
    assert.ok(forecast.predictedTemp30Min > 8.0, `Predicted temp (${forecast.predictedTemp30Min}) must exceed 8°C`);
    assert.ok(forecast.minutesToBreach !== null && forecast.minutesToBreach < 30);
    assert.ok(forecast.warning.includes('PREDICTIVE ALERT'));
  });

  // TEST 3: Compressor Health Scoring (0 - 100)
  test('Compressor health scoring returns 0-100 score and diagnostic', () => {
    // Seed telemetry where compressor is ON but temperature is rising (degraded)
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      db.prepare(`
        INSERT INTO telemetry_logs
        (fridge_id, temperature, door_state, power_source, compressor_state, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('fridge_1', 7.0 + (i * 0.1), 'CLOSED', 'GRID', 'ON', now - ((10 - i) * 60000));
    }

    const health = calculateCompressorHealthScore('fridge_1');
    assert.ok(health.score >= 0 && health.score <= 100, 'Score must be between 0 and 100');
    assert.ok(health.status, 'Must have a diagnostic status');
    assert.ok(health.score < 50, 'Failing cooling must produce degraded/low health score');
  });

  // TEST 4: Smart Relocation Recommendation
  test('Smart Relocation Engine suggests optimal target fridge and batches', () => {
    // Ensure Fridge 1 has breach predicted
    db.prepare('UPDATE fridges SET current_temp = ?, door_state = ? WHERE id = ?')
      .run(7.5, 'OPEN', 'fridge_1');
    // Ensure Fridge 2 is cool and safe
    db.prepare('UPDATE fridges SET current_temp = ?, door_state = ?, compressor_state = ? WHERE id = ?')
      .run(3.5, 'CLOSED', 'OFF', 'fridge_2');

    const plan = generateRelocationRecommendation('fridge_1');
    assert.ok(plan.planId, 'Plan must have unique ID');
    assert.strictEqual(plan.isRelocationRecommended, true);
    assert.strictEqual(plan.sourceFridgeId, 'fridge_1');
    assert.strictEqual(plan.targetFridgeId, 'fridge_2', 'Should pick safe Fridge 2 as destination');
    assert.ok(plan.batchesToRelocate.length > 0, 'Must list batches needing evacuation');
  });

  // TEST 5: Pharmacist 1-Click Confirmation
  test('Pharmacist confirms batch relocation with 1-click', () => {
    // Create a relocation plan
    const plan = generateRelocationRecommendation('fridge_1');
    assert.ok(plan.planId);

    const pharmacist = { username: 'pharmacist', role: 'Pharmacist' };
    const result = confirmRelocation(pharmacist, plan.planId);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.confirmedBy, 'pharmacist');

    // Verify batches are now in fridge_2!
    for (const b of plan.batchesToRelocate) {
      const movedBatch = db.prepare('SELECT fridge_id FROM vaccine_batches WHERE id = ?').get(b.batchId);
      assert.strictEqual(movedBatch.fridge_id, 'fridge_2', `Batch ${b.batchId} must be moved to fridge_2`);
    }

    // Verify non-pharmacist cannot confirm
    assert.throws(() => {
      confirmRelocation({ username: 'inspector', role: 'Inspector' }, 'FAKE-PLAN');
    }, /Only Pharmacists or Admins/);
  });

  // TEST 6: AI Documentation Report
  test('AI report generation contains dataset, features, and performance metrics', () => {
    const report = getAIReport();
    assert.ok(report.title);
    assert.strictEqual(report.models.length, 2);
    assert.ok(report.models[0].features.length >= 4);
    assert.ok(report.models[0].performanceMetrics.meanAbsoluteError);
    assert.ok(report.models[1].scoringTiers.length === 3);
  });

  console.log('\n====================================================');
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
