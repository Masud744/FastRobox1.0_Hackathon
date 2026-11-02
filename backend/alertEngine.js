const db = require('./database');
const config = require('./config');
const { appendAuditLog } = require('./security');

/**
 * ALERT & NOTIFICATION ENGINE
 * Handles:
 * 1. Door open >60 seconds -> buzzer trigger + remote notifications (Telegram/SMS/Email).
 * 2. Power failure / battery status alerts.
 */

// In-memory tracking of door open start times { fridgeId: timestamp }
const doorOpenTracker = {};

// Mock notification delivery logs
const notificationLogs = [];

/**
 * Dispatch remote notification (Telegram / Email / SMS)
 */
function sendRemoteNotification(channel, recipient, subject, message) {
  const notification = {
    id: 'NOTIF-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
    channel, // 'TELEGRAM' | 'EMAIL' | 'SMS'
    recipient,
    subject,
    message,
    timestamp: Date.now(),
    delivered: true
  };

  notificationLogs.unshift(notification);
  if (notificationLogs.length > 50) notificationLogs.pop(); // Keep last 50

  console.log(`[ALERT DISPATCHED][${channel}] To: ${recipient} | ${subject}: ${message}`);
  return notification;
}

/**
 * Process Door & Power State Changes from Telemetry
 */
function processDoorAndPowerState(fridgeId, doorState, powerSource, timestamp = Date.now()) {
  const fridge = db.prepare('SELECT * FROM fridges WHERE id = ?').get(fridgeId);
  if (!fridge) return null;

  const results = {
    fridgeId,
    doorState,
    powerSource,
    doorOpenSeconds: 0,
    doorAlarmTriggered: false,
    powerAlertTriggered: false
  };

  // 1. Door Monitoring & 60-Second Breach Alert
  if (doorState === 'OPEN') {
    if (!doorOpenTracker[fridgeId]) {
      doorOpenTracker[fridgeId] = timestamp;
    }

    const openDurationSec = Math.floor((timestamp - doorOpenTracker[fridgeId]) / 1000);
    results.doorOpenSeconds = openDurationSec;

    if (openDurationSec >= config.DOOR_ALERT_THRESHOLD_SEC) {
      results.doorAlarmTriggered = true;

      // Check if unresolved door alert already exists for this breach
      const existingAlert = db.prepare(`
        SELECT id FROM alerts
        WHERE fridge_id = ? AND alert_type = 'DOOR_OPEN_BREACH' AND resolved = 0
      `).get(fridgeId);

      if (!existingAlert) {
        const alertMsg = `CRITICAL: ${fridge.name} door has been OPEN for ${openDurationSec}s (exceeds ${config.DOOR_ALERT_THRESHOLD_SEC}s threshold)! Buzzer activated.`;
        
        db.prepare(`
          INSERT INTO alerts (fridge_id, alert_type, message, severity, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run(fridgeId, 'DOOR_OPEN_BREACH', alertMsg, 'CRITICAL', timestamp);

        // Send multi-channel remote alerts (Telegram & Email)
        sendRemoteNotification(
          'TELEGRAM',
          '@coldchain_pharmacist_alerts',
          '🚨 DOOR OPEN BREACH ALERT',
          alertMsg
        );
        sendRemoteNotification(
          'EMAIL',
          'pharmacy-director@hospital.org',
          'URGENT: ColdChain Fridge Door Breach',
          alertMsg
        );

        appendAuditLog('DOOR_BREACH_ALARM', {
          fridgeId,
          openDurationSec,
          thresholdSec: config.DOOR_ALERT_THRESHOLD_SEC
        }, 'system');
      }
    }
  } else {
    // Door is CLOSED: resolve any open door alerts
    if (doorOpenTracker[fridgeId]) {
      delete doorOpenTracker[fridgeId];

      db.prepare(`
        UPDATE alerts SET resolved = 1 WHERE fridge_id = ? AND alert_type = 'DOOR_OPEN_BREACH'
      `).run(fridgeId);
    }
  }

  // 2. Power Failure & Battery Mode Alerting
  if (powerSource === 'BATTERY' && fridge.power_source !== 'BATTERY') {
    results.powerAlertTriggered = true;
    const powerMsg = `WARNING: AC Grid Power Lost for ${fridge.name}. Switched to Backup Battery power mode!`;

    db.prepare(`
      INSERT INTO alerts (fridge_id, alert_type, message, severity, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(fridgeId, 'POWER_OUTAGE', powerMsg, 'WARNING', timestamp);

    sendRemoteNotification(
      'SMS',
      '+8801700000000',
      'POWER FAILURE',
      powerMsg
    );

    appendAuditLog('POWER_SOURCE_CHANGE', {
      fridgeId,
      oldPower: fridge.power_source,
      newPower: 'BATTERY'
    }, 'system');
  }

  return results;
}

/**
 * Get recent notification logs
 */
function getRecentNotifications() {
  return notificationLogs;
}

module.exports = {
  processDoorAndPowerState,
  sendRemoteNotification,
  getRecentNotifications
};
