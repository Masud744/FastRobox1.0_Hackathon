/**
 * ColdChain System Configuration
 */
module.exports = {
  PORT: process.env.PORT || 5000,
  WS_PORT: process.env.WS_PORT || 5001,
  MQTT_PORT: process.env.MQTT_PORT || 1883,
  
  // Security Secrets
  JWT_SECRET: process.env.JWT_SECRET || 'coldchain-super-secret-jwt-key-2026',
  DEVICE_HMAC_SECRET: process.env.DEVICE_HMAC_SECRET || 'esp32-coldchain-secret-key-32bytes-hmac',
  
  // Cold Chain Safe Temperature Limits
  TEMP_SAFE_MIN: 2.0,   // °C
  TEMP_SAFE_MAX: 8.0,   // °C
  TEMP_SEVERE_THRESHOLD: 12.0, // °C (Exposure >12°C counts DOUBLE)
  
  // Compressor Logic Limits
  COMPRESSOR_ON_TEMP: 7.0,  // Turn compressor ON if Temp >= 7°C
  COMPRESSOR_OFF_TEMP: 3.0, // Turn compressor OFF if Temp <= 3°C
  COMPRESSOR_MIN_OFF_TIME_SEC: 60, // Minimum 60-second compressor delay
  
  // Heat Exposure Budget
  BATCH_TOTAL_BUDGET_MINUTES: 60, // 60 minutes above 8°C
  BUDGET_AT_RISK_PERCENT: 20,     // <20% is "At Risk"
  
  // Alert Thresholds
  DOOR_ALERT_THRESHOLD_SEC: 60, // Door open >60s triggers alerts
  
  // Device Replay Protection Window (in milliseconds)
  REPLAY_WINDOW_MS: 5 * 60 * 1000 // 5 minutes freshness window
};
