const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const db = require('./database');
const config = require('./config');
const { loginUser, registerUser, authenticateToken, requireRoles } = require('./auth');
const {
  verifyDeviceTelemetry,
  appendAuditLog,
  verifyHashChainIntegrity,
  simulateTamperRecord
} = require('./security');
const {
  processTelemetryHeatExposure,
  adminResetDiscardAlarm
} = require('./heatBudgetEngine');
const { syncOfflineTelemetryBuffer } = require('./offlineSyncEngine');
const {
  processDoorAndPowerState,
  getRecentNotifications
} = require('./alertEngine');
const {
  predict30MinAhead,
  calculateCompressorHealthScore,
  generateRelocationRecommendation,
  confirmRelocation,
  getAIReport
} = require('./aiEngine');
const { startMQTTBroker } = require('./mqttBroker');
const { generateClinicalBrief, generateCompressorDiagnostic } = require('./groqAdvisor');

const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Public QR direct route
app.get('/verify/:identifier', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Real-time WebSocket broadcasting
 */
function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

wss.on('connection', ws => {
  console.log('[WebSocket] Client connected.');
  // Send initial snapshot
  const fridges = db.prepare('SELECT * FROM fridges').all();
  const batches = db.prepare('SELECT * FROM vaccine_batches').all();
  ws.send(JSON.stringify({
    type: 'INITIAL_SNAPSHOT',
    fridges,
    batches,
    timestamp: Date.now()
  }));
});

// =========================================================================
// 1. AUTHENTICATION & ROLES
// =========================================================================

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const result = loginUser(username, password);
  if (!result.success) {
    return res.status(401).json(result);
  }

  appendAuditLog('USER_LOGIN', { username: result.user.username, role: result.user.role }, result.user.username);
  res.json(result);
});

app.post('/api/auth/register', (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const result = registerUser(username, password, role || 'Pharmacist');
  if (!result.success) {
    return res.status(400).json(result);
  }

  appendAuditLog('USER_REGISTERED', { username: result.user.username, role: result.user.role }, result.user.username);
  res.status(201).json(result);
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// =========================================================================
// 2. LIVE DASHBOARD & FRIDGES
// =========================================================================

app.get('/api/fridges', (req, res) => {
  const fridges = db.prepare('SELECT * FROM fridges').all();
  res.json(fridges);
});

app.get('/api/fridges/:id', (req, res) => {
  const fridge = db.prepare('SELECT * FROM fridges WHERE id = ?').get(req.params.id);
  if (!fridge) return res.status(404).json({ error: 'Fridge not found' });
  res.json(fridge);
});

app.get('/api/telemetry/recent/:fridgeId', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = db.prepare(`
    SELECT * FROM telemetry_logs
    WHERE fridge_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(req.params.fridgeId, limit).reverse();
  res.json(logs);
});

// =========================================================================
// 3. SECURE DEVICE TELEMETRY INTAKE (HMAC + Timestamp + Nonce)
// =========================================================================

app.post('/api/telemetry', (req, res) => {
  const packet = req.body; // { payload, timestamp, nonce, signature }

  // 1. Verify Device Security
  const verification = verifyDeviceTelemetry(packet);
  if (!verification.valid) {
    console.warn(`[SECURITY WARNING] Invalid telemetry packet: ${verification.error}`);
    return res.status(403).json(verification);
  }

  const { payload, timestamp, nonce } = packet;
  const {
    fridge_id,
    temperature,
    door_state = 'CLOSED',
    door_open_seconds = 0,
    power_source = 'GRID',
    compressor_state = 'OFF'
  } = payload;

  // 2. Insert into telemetry log
  db.prepare(`
    INSERT INTO telemetry_logs
    (fridge_id, temperature, door_state, door_open_seconds, power_source, compressor_state, timestamp, nonce)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fridge_id,
    temperature,
    door_state,
    door_open_seconds,
    power_source,
    compressor_state,
    timestamp,
    nonce
  );

  // 3. Update Fridge Status
  db.prepare(`
    UPDATE fridges
    SET current_temp = ?, door_state = ?, power_source = ?, compressor_state = ?, last_seen = ?
    WHERE id = ?
  `).run(temperature, door_state, power_source, compressor_state, timestamp, fridge_id);

  // 4. Process Heat Exposure Budget for Batches in this Fridge
  const heatResult = processTelemetryHeatExposure(fridge_id, temperature, 5);

  // 5. Process Door & Power Alerts
  const alertResult = processDoorAndPowerState(fridge_id, door_state, power_source, timestamp);

  // 6. Broadcast updated state to all connected web clients
  broadcast({
    type: 'TELEMETRY_UPDATE',
    fridgeId: fridge_id,
    temperature,
    door_state,
    power_source,
    compressor_state,
    heatResult,
    alertResult,
    timestamp
  });

  res.json({
    status: 'ACCEPTED',
    fridge_id,
    temperature,
    heatResult,
    alertResult
  });
});

// =========================================================================
// 4. OFFLINE SYNC (30-Minute Buffer Synchronization)
// =========================================================================

app.post('/api/telemetry/offline-sync', (req, res) => {
  const { buffer } = req.body; // Array of packets
  if (!buffer || !Array.isArray(buffer)) {
    return res.status(400).json({ error: 'Buffer array required' });
  }

  const syncResult = syncOfflineTelemetryBuffer(buffer);

  // Broadcast sync event
  broadcast({
    type: 'OFFLINE_SYNC_COMPLETED',
    syncResult,
    timestamp: Date.now()
  });

  res.json(syncResult);
});

// =========================================================================
// 5. VACCINE INVENTORY & PUBLIC QR VERIFICATION
// =========================================================================

app.get('/api/batches', (req, res) => {
  const batches = db.prepare('SELECT * FROM vaccine_batches ORDER BY id ASC').all();
  res.json(batches);
});

app.post('/api/batches', authenticateToken, requireRoles('Pharmacist', 'Admin'), (req, res) => {
  const { id, name, type, fridge_id, expiry_date, total_budget_mins } = req.body;
  if (!id || !name || !type || !fridge_id || !expiry_date) {
    return res.status(400).json({ error: 'Missing required batch fields (id, name, type, fridge_id, expiry_date)' });
  }

  const existing = db.prepare('SELECT id FROM vaccine_batches WHERE id = ?').get(id);
  if (existing) {
    return res.status(400).json({ error: `Batch ID '${id}' already exists.` });
  }

  const qr_code = id;
  const budget = parseFloat(total_budget_mins) || 60.0;

  try {
    const stmt = db.prepare(`
      INSERT INTO vaccine_batches (id, name, type, fridge_id, expiry_date, total_budget_mins, consumed_budget_mins, status, qr_code)
      VALUES (?, ?, ?, ?, ?, ?, 0.0, 'Safe', ?)
    `);
    stmt.run(id, name, type, fridge_id, expiry_date, budget, qr_code);

    // Asynchronously mirror new batch to Supabase
    try {
      const { supabase } = require('./supabaseClient');
      if (supabase) {
        supabase.from('vaccine_batches').insert({
          id, name, type, fridge_id, expiry_date, total_budget_mins: budget, consumed_budget_mins: 0.0, status: 'Safe', qr_code
        }).then(({ error }) => {
          if (error) console.error('[Supabase Mirror] Batch insert error:', error.message);
        });
      }
    } catch (e) {}

    appendAuditLog('BATCH_REGISTERED', { batchId: id, name, type, fridgeId: fridge_id }, req.user.username);

    broadcast({
      type: 'BATCH_REGISTERED',
      batch: { id, name, type, fridge_id, expiry_date, total_budget_mins: budget, consumed_budget_mins: 0.0, status: 'Safe', qr_code }
    });

    res.status(201).json({
      success: true,
      message: `Batch ${id} (${name}) registered successfully.`,
      batch: { id, name, type, fridge_id, expiry_date, total_budget_mins: budget, consumed_budget_mins: 0.0, status: 'Safe', qr_code }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUBLIC QR CHECK ROUTE: Zero login required (Task 4 requirement)
app.get('/api/batches/public-verify/:identifier', (req, res) => {
  const idOrQr = req.params.identifier;
  const batch = db.prepare(`
    SELECT b.*, f.name as fridge_name, f.current_temp as fridge_temp
    FROM vaccine_batches b
    JOIN fridges f ON b.fridge_id = f.id
    WHERE b.id = ? OR b.qr_code = ?
  `).get(idOrQr, idOrQr);

  if (!batch) {
    return res.status(404).json({
      verified: false,
      error: 'BATCH_NOT_FOUND',
      message: 'No vaccine batch found matching this QR code or identifier.'
    });
  }

  const remainingMinutes = Math.max(0, batch.total_budget_mins - batch.consumed_budget_mins);
  const remainingPercent = (remainingMinutes / batch.total_budget_mins) * 100.0;

  res.json({
    verified: true,
    batchId: batch.id,
    name: batch.name,
    type: batch.type,
    status: batch.status, // 'Safe' | 'At Risk' | 'Discard'
    expiryDate: batch.expiry_date,
    isExpired: new Date(batch.expiry_date) < new Date(),
    fridgeLocation: batch.fridge_name,
    currentStorageTemp: batch.fridge_temp,
    heatExposure: {
      totalBudgetMinutes: batch.total_budget_mins,
      consumedMinutes: Number(batch.consumed_budget_mins.toFixed(2)),
      remainingMinutes: Number(remainingMinutes.toFixed(2)),
      remainingPercent: Number(remainingPercent.toFixed(1))
    },
    safetyVerdict: batch.status === 'Safe'
      ? 'POTENT & SAFE TO ADMINISTER'
      : batch.status === 'At Risk'
      ? 'WARNING: AT RISK - REDUCED SHELF LIFE'
      : 'DO NOT USE - DISCARD (HEAT EXPOSURE EXCEEDED)'
  });
});

// =========================================================================
// 6. AI BREACH PREDICTION & RELOCATION ENDPOINTS
// =========================================================================

app.get('/api/ai/forecast/:fridgeId', (req, res) => {
  try {
    const forecast = predict30MinAhead(req.params.fridgeId);
    res.json(forecast);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ai/compressor-health/:fridgeId', (req, res) => {
  try {
    const health = calculateCompressorHealthScore(req.params.fridgeId);
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ai/relocation-recommendation/:fridgeId', (req, res) => {
  try {
    const plan = generateRelocationRecommendation(req.params.fridgeId);
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1-Click Relocation Confirmation: Pharmacist or Admin only
app.post('/api/ai/relocation-confirm', authenticateToken, requireRoles('Pharmacist', 'Admin'), (req, res) => {
  try {
    const { planId } = req.body;
    if (!planId) return res.status(400).json({ error: 'planId required' });

    const result = confirmRelocation(req.user, planId);

    // Broadcast updated state
    broadcast({
      type: 'BATCH_RELOCATION_COMPLETED',
      result,
      timestamp: Date.now()
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ai/report', (req, res) => {
  res.json(getAIReport());
});

app.get('/api/ai/clinical-brief/:fridgeId', async (req, res) => {
  try {
    const fridgeId = req.params.fridgeId;
    const plan = generateRelocationRecommendation(fridgeId);
    const prediction = predict30MinAhead(fridgeId);
    const brief = await generateClinicalBrief({
      sourceFridgeName: plan.sourceFridgeName,
      targetFridgeName: plan.targetFridgeName,
      currentTemp: prediction.currentTemp,
      predictedTemp30Min: prediction.predictedTemp30Min,
      batches: plan.batchesToRelocate,
      reason: plan.reason
    });
    res.json({ plan, brief });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// 7. CRYPTOGRAPHIC HASH CHAIN AUDIT & TAMPER DETECTION
// =========================================================================

app.get('/api/audit/chain', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const records = db.prepare(`
    SELECT * FROM audit_log_chain
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
  res.json(records);
});

// "Verify Integrity" API
app.get('/api/audit/verify-integrity', (req, res) => {
  const result = verifyHashChainIntegrity();
  res.json(result);
});

// Demo/Testing endpoint: intentionally tamper with a row to prove verification works!
app.post('/api/audit/simulate-tamper', authenticateToken, requireRoles('Admin', 'Inspector'), (req, res) => {
  const { rowId, fakeData } = req.body;
  if (!rowId) return res.status(400).json({ error: 'rowId required' });

  const result = simulateTamperRecord(rowId, fakeData || { note: 'Tampered by simulated malicious actor' });
  res.json({
    message: `Record ID ${rowId} was intentionally modified in SQLite without recomputing hash chain. Click 'Verify Integrity' now to see detection in action!`,
    tamperedRowId: rowId
  });
});

// =========================================================================
// 8. ADMIN ACTIONS & ALERTS
// =========================================================================

// Admin Reset of Latched Red LED / Discard Alarm
app.post('/api/admin/reset-discard-alarm', authenticateToken, requireRoles('Admin'), (req, res) => {
  try {
    const { fridgeId, note } = req.body;
    if (!fridgeId) return res.status(400).json({ error: 'fridgeId required' });

    const result = adminResetDiscardAlarm(req.user, fridgeId, note);

    broadcast({
      type: 'DISCARD_ALARM_RESET',
      fridgeId,
      timestamp: Date.now()
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/alerts', (req, res) => {
  const alerts = db.prepare(`
    SELECT * FROM alerts
    ORDER BY timestamp DESC
    LIMIT 50
  `).all();
  res.json(alerts);
});

app.get('/api/notifications', (req, res) => {
  res.json(getRecentNotifications());
});

// =========================================================================
// START SERVER
// =========================================================================

if (require.main === module) {
  server.listen(config.PORT, () => {
    console.log(`====================================================`);
    console.log(`  COLDCHAIN REST API & WEBSOCKET SERVER ACTIVE`);
    console.log(`  HTTP Port: ${config.PORT}`);
    console.log(`  WebSocket Server: ws://localhost:${config.PORT}`);
    console.log(`====================================================`);
    startMQTTBroker(broadcast);
  });
}

module.exports = { app, server };
