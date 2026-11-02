const db = require('./database');
const config = require('./config');
const { appendAuditLog } = require('./security');

/**
 * HEAT EXPOSURE BUDGET ENGINE
 *
 * Rules:
 * 1. Each batch has a 60-minute budget above 8°C.
 * 2. Exposure above 12°C counts DOUBLE (2x penalty).
 * 3. Below 20% (<12 minutes remaining): Status becomes "At Risk".
 * 4. At 0%: Status becomes "Discard" and the physical red LED latches ON
 *    until an Admin explicitly resets it.
 */

/**
 * Process temperature exposure for all batches in a fridge
 * @param {string} fridgeId 
 * @param {number} temperature Current temperature in °C
 * @param {number} elapsedSeconds Seconds elapsed since last reading (default 5s)
 */
function processTelemetryHeatExposure(fridgeId, temperature, elapsedSeconds = 5) {
  const batches = db.prepare('SELECT * FROM vaccine_batches WHERE fridge_id = ?').all(fridgeId);
  const now = Date.now();
  const results = [];

  // Check if temperature is in heat breach zone (> 8.0°C)
  const isHeatExposure = temperature > config.TEMP_SAFE_MAX;
  const isSevereHeat = temperature > config.TEMP_SEVERE_THRESHOLD; // > 12°C

  // Multiplier: 2.0 if > 12°C, 1.0 if > 8°C, 0.0 if safe (<= 8°C)
  let penaltyMultiplier = 0.0;
  if (isSevereHeat) {
    penaltyMultiplier = 2.0; // Counts double!
  } else if (isHeatExposure) {
    penaltyMultiplier = 1.0;
  }

  const minutesDeduction = (elapsedSeconds / 60.0) * penaltyMultiplier;

  for (const batch of batches) {
    let newConsumed = batch.consumed_budget_mins;
    if (minutesDeduction > 0 && batch.status !== 'Discard') {
      newConsumed = Math.min(batch.total_budget_mins, batch.consumed_budget_mins + minutesDeduction);
    }

    const remainingMinutes = Math.max(0, batch.total_budget_mins - newConsumed);
    const remainingPercent = (remainingMinutes / batch.total_budget_mins) * 100.0;

    let newStatus = 'Safe';
    let triggerDiscardAlarm = false;

    if (remainingMinutes <= 0.0) {
      newStatus = 'Discard';
      triggerDiscardAlarm = true;
    } else if (remainingPercent < config.BUDGET_AT_RISK_PERCENT) {
      newStatus = 'At Risk';
    } else {
      newStatus = 'Safe';
    }

    // Check if status changed
    const statusChanged = batch.status !== newStatus;

    if (statusChanged || minutesDeduction > 0) {
      db.prepare(`
        UPDATE vaccine_batches
        SET consumed_budget_mins = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newConsumed, newStatus, batch.id);

      if (statusChanged) {
        // Log to cryptographic audit chain
        appendAuditLog('BATCH_STATUS_CHANGE', {
          batchId: batch.id,
          batchName: batch.name,
          fridgeId,
          oldStatus: batch.status,
          newStatus,
          temperature,
          remainingMinutes: Number(remainingMinutes.toFixed(2)),
          remainingPercent: Number(remainingPercent.toFixed(1))
        }, 'system');

        // If batch reached 0% Discard: latch Red LED ON and create critical alert
        if (newStatus === 'Discard') {
          // Latch the red LED on the fridge
          db.prepare('UPDATE fridges SET red_led_latched = 1 WHERE id = ?').run(fridgeId);

          // Insert alert
          db.prepare(`
            INSERT INTO alerts (fridge_id, alert_type, message, severity, timestamp)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            fridgeId,
            'BATCH_DISCARD',
            `CRITICAL: Batch ${batch.name} (${batch.id}) has expired its 60-min heat budget at ${temperature}°C. Red LED latched ON!`,
            'CRITICAL',
            now
          );
        } else if (newStatus === 'At Risk') {
          db.prepare(`
            INSERT INTO alerts (fridge_id, alert_type, message, severity, timestamp)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            fridgeId,
            'BATCH_AT_RISK',
            `WARNING: Batch ${batch.name} (${batch.id}) remaining heat budget < 20% (${remainingMinutes.toFixed(1)} mins left).`,
            'WARNING',
            now
          );
        }
      }
    }

    results.push({
      batchId: batch.id,
      name: batch.name,
      status: newStatus,
      consumedMinutes: Number(newConsumed.toFixed(2)),
      remainingMinutes: Number(remainingMinutes.toFixed(2)),
      remainingPercent: Number(remainingPercent.toFixed(1)),
      penaltyMultiplier
    });
  }

  return {
    fridgeId,
    temperature,
    isHeatExposure,
    penaltyMultiplier,
    batches: results
  };
}

/**
 * Admin Reset of Discard Alarm & Red LED Latch
 * Only Admin role is permitted to reset the latched Red LED
 */
function adminResetDiscardAlarm(adminUser, fridgeId, note = 'Admin manual inspection and verification') {
  if (adminUser.role !== 'Admin') {
    throw new Error('Only users with Admin role can reset the latched discard alarm.');
  }

  const fridge = db.prepare('SELECT * FROM fridges WHERE id = ?').get(fridgeId);
  if (!fridge) {
    throw new Error(`Fridge ${fridgeId} not found.`);
  }

  // Unlatch the physical red LED
  db.prepare('UPDATE fridges SET red_led_latched = 0 WHERE id = ?').run(fridgeId);

  // Mark related alerts as resolved
  db.prepare(`
    UPDATE alerts SET resolved = 1 WHERE fridge_id = ? AND alert_type = 'BATCH_DISCARD'
  `).run(fridgeId);

  // Append entry to cryptographic hash chain
  const auditEntry = appendAuditLog('ADMIN_ALARM_RESET', {
    fridgeId,
    adminUsername: adminUser.username,
    note,
    timestamp: Date.now()
  }, adminUser.username);

  return {
    success: true,
    fridgeId,
    red_led_latched: 0,
    resetBy: adminUser.username,
    auditHash: auditEntry.currentHash
  };
}

module.exports = {
  processTelemetryHeatExposure,
  adminResetDiscardAlarm
};
