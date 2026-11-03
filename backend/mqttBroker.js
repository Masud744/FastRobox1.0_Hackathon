const net = require('net');
const { Aedes } = require('aedes');
const mqtt = require('mqtt');
const db = require('./database');
const config = require('./config');
const { verifyDeviceTelemetry } = require('./security');
const { processTelemetryHeatExposure } = require('./heatBudgetEngine');
const { processDoorAndPowerState } = require('./alertEngine');
const { syncOfflineTelemetryBuffer } = require('./offlineSyncEngine');
const { mirrorFridgeState, mirrorTelemetryLog } = require('./supabaseClient');

let aedesBroker = null;
let tcpServer = null;
let publicMqttClient = null;
let broadcastCallback = null;

// Track last telemetry timestamp per fridge to compute delta seconds
const lastFridgeTimestamps = {};

/**
 * Handle incoming telemetry packet from either local Aedes or public HiveMQ
 */
function handleIncomingTelemetry(topic, messageBuffer) {
  try {
    const rawStr = messageBuffer.toString();
    const packet = JSON.parse(rawStr);

    if (topic.endsWith('/offline_sync')) {
      console.log(`[MQTT] Received offline sync buffer on ${topic}: ${Array.isArray(packet) ? packet.length : 0} readings.`);
      const result = syncOfflineTelemetryBuffer(Array.isArray(packet) ? packet : packet.buffer || []);
      if (broadcastCallback) {
        broadcastCallback({
          type: 'OFFLINE_SYNC_COMPLETED',
          result,
          timestamp: Date.now()
        });
      }
      return;
    }

    // Normal live telemetry packet
    const { payload, timestamp, nonce, signature } = packet;
    if (!payload || !timestamp || !nonce || !signature) {
      console.warn('[MQTT] Packet missing required security fields.');
      return;
    }

    // Verify HMAC-SHA256 signature & freshness
    const authResult = verifyDeviceTelemetry(packet);
    if (!authResult.valid) {
      console.warn(`[MQTT SECURITY WARNING] Rejected invalid packet: ${authResult.message || authResult.error}`);
      return;
    }

    const fridgeId = payload.fridge_id;
    const now = Date.now();

    // Calculate elapsed seconds since last reading for precise heat budget consumption
    const lastTime = lastFridgeTimestamps[fridgeId] || now;
    const elapsedSeconds = Math.max(1, Math.min(60, Math.floor((now - lastTime) / 1000)));
    lastFridgeTimestamps[fridgeId] = now;

    // 1. Process Door & Power Alerts
    const doorPowerResult = processDoorAndPowerState(
      fridgeId,
      payload.door_state || 'CLOSED',
      payload.power_source || 'GRID',
      timestamp
    );

    // 2. Process Heat Exposure Budget
    const heatResult = processTelemetryHeatExposure(fridgeId, payload.temperature, elapsedSeconds);

    // 3. Update Fridge in SQLite
    db.prepare(`
      UPDATE fridges
      SET current_temp = ?,
          door_state = ?,
          door_last_opened = ?,
          power_source = ?,
          compressor_state = ?,
          last_seen = ?
      WHERE id = ?
    `).run(
      payload.temperature,
      payload.door_state || 'CLOSED',
      doorPowerResult ? doorPowerResult.doorOpenSeconds : 0,
      payload.power_source || 'GRID',
      payload.compressor_state || 'OFF',
      now,
      fridgeId
    );

    // 4. Insert into SQLite telemetry_logs
    const insertLog = db.prepare(`
      INSERT INTO telemetry_logs (fridge_id, temperature, door_state, door_open_seconds, power_source, compressor_state, timestamp, nonce)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fridgeId,
      payload.temperature,
      payload.door_state || 'CLOSED',
      payload.door_open_seconds || 0,
      payload.power_source || 'GRID',
      payload.compressor_state || 'OFF',
      timestamp,
      nonce
    );

    const updatedFridge = db.prepare('SELECT * FROM fridges WHERE id = ?').get(fridgeId);

    // 5. Asynchronously Mirror to Supabase Cloud
    mirrorFridgeState(updatedFridge);
    mirrorTelemetryLog({
      fridge_id: fridgeId,
      temperature: payload.temperature,
      door_state: payload.door_state,
      door_open_seconds: payload.door_open_seconds || 0,
      power_source: payload.power_source,
      compressor_state: payload.compressor_state,
      timestamp,
      nonce
    });

    // 6. Broadcast live via WebSocket to frontend UI
    if (broadcastCallback) {
      broadcastCallback({
        type: 'TELEMETRY_UPDATE',
        fridgeId,
        reading: payload,
        fridge: updatedFridge,
        heatResult,
        timestamp: now
      });
    }

    console.log(`[MQTT] Ingested ${fridgeId} | Temp: ${payload.temperature}°C | Comp: ${payload.compressor_state} | Door: ${payload.door_state}`);
  } catch (err) {
    console.error('[MQTT] Ingestion error:', err.message);
  }
}

/**
 * Start Embedded Aedes MQTT Broker & Optional Public Cloud Bridge
 */
async function startMQTTBroker(broadcastFn, customPort = null) {
  broadcastCallback = broadcastFn;
  const mqttPort = customPort || config.MQTT_PORT || 1883;

  // 1. Embedded Aedes MQTT Broker (Local TCP Port 1883)
  aedesBroker = await Aedes.createBroker();
  tcpServer = net.createServer(aedesBroker.handle.bind(aedesBroker));

  tcpServer.listen(mqttPort, () => {
    console.log(`[MQTT BROKER] Embedded Aedes MQTT Broker listening on port ${mqttPort}`);
  });

  tcpServer.on('error', err => {
    console.error(`[MQTT BROKER] TCP Server error on port ${mqttPort}:`, err.message);
  });

  aedesBroker.on('client', client => {
    console.log(`[MQTT BROKER] Client connected: ${client ? client.id : 'unknown'}`);
  });

  aedesBroker.on('publish', (packet, client) => {
    if (client && packet && packet.topic) {
      if (packet.topic.startsWith('coldchain/')) {
        handleIncomingTelemetry(packet.topic, packet.payload);
      }
    }
  });

  // 2. Public Bridge (HiveMQ) for seamless browser-based Wokwi simulation without port forwarding
  try {
    const publicBrokerUrl = 'mqtt://broker.hivemq.com:1883';
    publicMqttClient = mqtt.connect(publicBrokerUrl, {
      clientId: 'coldchain_backend_' + Math.random().toString(16).substring(2, 8),
      clean: true,
      connectTimeout: 5000,
      reconnectPeriod: 10000
    });

    publicMqttClient.on('connect', () => {
      console.log(`[MQTT BRIDGE] Connected to Public HiveMQ Broker for Wokwi simulation.`);
      publicMqttClient.subscribe('coldchain_fastrobox/+/telemetry');
      publicMqttClient.subscribe('coldchain_fastrobox/+/offline_sync');
      publicMqttClient.subscribe('coldchain/+/telemetry');
      publicMqttClient.subscribe('coldchain/+/offline_sync');
    });

    publicMqttClient.on('message', (topic, message) => {
      handleIncomingTelemetry(topic, message);
    });

    publicMqttClient.on('error', err => {
      console.warn('[MQTT BRIDGE] HiveMQ warning:', err.message);
    });
  } catch (err) {
    console.warn('[MQTT BRIDGE] Public bridge init failed:', err.message);
  }
}

function stopMQTTBroker() {
  if (publicMqttClient) {
    try { publicMqttClient.end(); } catch (e) {}
  }
  if (tcpServer) {
    try { tcpServer.close(); } catch (e) {}
  }
  if (aedesBroker) {
    try { aedesBroker.close(); } catch (e) {}
  }
}

module.exports = {
  startMQTTBroker,
  stopMQTTBroker,
  handleIncomingTelemetry
};
