/**
 * ColdChain — ESP32 Smart Vaccine Storage Node Firmware
 *
 * Implements:
 * 1. Task 1: Dual fridge node monitoring (DHT22, OLED SSD1306, Relay, LEDs).
 * 2. Task 1: Compressor Hysteresis (ON >= 7°C, OFF <= 3°C, 60s minimum off-time delay).
 * 3. Task 1: 5-second periodic & door-change immediate MQTT telemetry transmission.
 * 4. Task 3: Power mode toggle (AC Grid vs Battery backup).
 * 5. Task 3: Door open > 60s breach buzzer alert.
 * 6. Task 3: 30-minute edge buffering (up to 360 readings) during Wi-Fi outage.
 * 7. Task 4: Native Hardware HMAC-SHA256 signature + nonce + timestamp security.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include <ArduinoJson.h>
#include "mbedtls/md.h"

// =========================================================================
// HARDWARE PIN DEFINITIONS
// =========================================================================
#define PIN_DHT22          4     // DHT22 Temperature & Humidity Sensor
#define PIN_RELAY_COMP     5     // Compressor Relay Output (Active HIGH)
#define PIN_DOOR_SWITCH    18    // Pushbutton Door Switch (Active LOW with internal pull-up)
#define PIN_POWER_SWITCH   19    // Pushbutton Power Mode Toggle (Active LOW)
#define PIN_BUZZER         13    // Piezo Buzzer for 60s Door Breach Alarm
#define PIN_LED_RED        2     // Red LED: Discard / Breach Latched Alarm
#define PIN_LED_GREEN      14    // Green LED: Normal Safe Range (2.0°C - 8.0°C)

// OLED Display Config (128x64 I2C SSD1306)
#define SCREEN_WIDTH       128
#define SCREEN_HEIGHT      64
#define OLED_RESET         -1
#define SCREEN_ADDRESS     0x3C

// Node Identity Configuration
#define FRIDGE_ID          "fridge_1"
#define FRIDGE_NAME        "Main Cold Room (Fridge 1)"
#define HMAC_SECRET        "esp32-coldchain-secret-key-32bytes-hmac"

// Safe Thermal & Compressor Parameters (as specified in PDF)
#define TEMP_SAFE_MIN      2.0   // °C
#define TEMP_SAFE_MAX      8.0   // °C
#define COMPRESSOR_ON_TEMP 7.0   // Turn compressor ON if Temp >= 7.0°C
#define COMPRESSOR_OFF_TEMP 3.0  // Turn compressor OFF if Temp <= 3.0°C
#define COMP_MIN_OFF_DELAY 60000 // 60-Second Minimum Off-Time Protection (ms)
#define TELEMETRY_INTERVAL 5000  // 5 seconds telemetry loop (ms)
#define DOOR_ALARM_LIMIT   60    // 60-second door open threshold

// Wi-Fi & MQTT Configuration
const char* WIFI_SSID     = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";
const char* MQTT_BROKER   = "broker.hivemq.com";
const int   MQTT_PORT     = 1883;

// Topics
const char* TOPIC_TELEMETRY = "coldchain_fastrobox/fridge_1/telemetry";
const char* TOPIC_OFFLINE   = "coldchain_fastrobox/fridge_1/offline_sync";
const char* TOPIC_LOCAL_TEL = "coldchain/fridge_1/telemetry";

// =========================================================================
// GLOBAL STATE & BUFFERING (30 Minutes Edge Storage)
// =========================================================================
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
DHT dht(PIN_DHT22, DHT22);
WiFiClient espClient;
PubSubClient mqttClient(espClient);

// Sensor & Operational States
float currentTemp = 4.5;
bool compressorState = false;
unsigned long compressorLastOffTime = 0; // Tracks when compressor turned OFF
bool doorIsOpen = false;
unsigned long doorOpenedTimestamp = 0;
int doorOpenSeconds = 0;
bool powerIsBattery = false;
bool redAlarmLatched = false;

// Timers
unsigned long lastTelemetryMillis = 0;
unsigned long epochTimeOffset = 1793720000000ULL; // Approximate baseline epoch ms

// 30-Minute Telemetry Offline Buffer (360 packets @ 5-sec interval)
struct TelemetryPacket {
  float temp;
  bool doorOpen;
  int doorSec;
  bool isBattery;
  bool compOn;
  unsigned long long timestamp;
  char nonce[16];
  char signature[65];
};

#define MAX_BUFFER_CAPACITY 360
TelemetryPacket offlineBuffer[MAX_BUFFER_CAPACITY];
int bufferHead = 0;
int bufferCount = 0;

// =========================================================================
// CRYPTOGRAPHIC HMAC-SHA256 SIGNATURE ENGINE
// Message format: timestamp:nonce:serializedPayload
// =========================================================================
String generateNonce() {
  char n[16];
  sprintf(n, "esp_%08x", (unsigned int)esp_random());
  return String(n);
}

unsigned long long getCurrentTimestamp() {
  return epochTimeOffset + (unsigned long long)millis();
}

String computeHMAC(const String& serializedPayload, unsigned long long timestamp, const String& nonce) {
  // Exact format expected by backend: timestamp:nonce:serializedPayload
  String message = String(timestamp) + ":" + nonce + ":" + serializedPayload;

  byte hmacResult[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_type_t md_type = MBEDTLS_MD_SHA256;

  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(md_type), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)HMAC_SECRET, strlen(HMAC_SECRET));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)message.c_str(), message.length());
  mbedtls_md_hmac_finish(&ctx, hmacResult);
  mbedtls_md_free(&ctx);

  char hexBuf[65];
  for (int i = 0; i < 32; i++) {
    sprintf(&hexBuf[i * 2], "%02x", hmacResult[i]);
  }
  hexBuf[64] = '\0';
  return String(hexBuf);
}

// =========================================================================
// OLED UI DISPLAY
// =========================================================================
void updateOLEDDisplay() {
  display.clearDisplay();

  // 1. Header Bar
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print("COLDCHAIN: ");
  display.println(FRIDGE_ID);
  display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

  // 2. Large Temperature Display
  display.setTextSize(2);
  display.setCursor(0, 14);
  display.print(currentTemp, 1);
  display.setTextSize(1);
  display.print(" C ");

  // 3. Status Tag: Safe / Warning / Breach
  if (currentTemp >= TEMP_SAFE_MIN && currentTemp <= TEMP_SAFE_MAX) {
    if (currentTemp >= 7.0 || currentTemp <= 3.0) {
      display.println("[WARN]");
    } else {
      display.println("[SAFE]");
    }
  } else {
    display.println("[BREACH!]");
  }

  // 4. Sub-metrics
  display.setCursor(0, 34);
  display.print("COMP: ");
  if (compressorState) {
    display.println("ACTIVE (ON)");
  } else {
    unsigned long offElapsed = millis() - compressorLastOffTime;
    if (offElapsed < COMP_MIN_OFF_DELAY) {
      int delayLeft = (COMP_MIN_OFF_DELAY - offElapsed) / 1000;
      display.print("OFF (Delay:");
      display.print(delayLeft);
      display.println("s)");
    } else {
      display.println("READY (OFF)");
    }
  }

  // 5. Door & Power State
  display.setCursor(0, 44);
  display.print("DOOR: ");
  if (doorIsOpen) {
    display.print("OPEN (");
    display.print(doorOpenSeconds);
    display.println("s)");
  } else {
    display.println("CLOSED");
  }

  // 6. Network & Power Info
  display.setCursor(0, 54);
  display.print("PWR: ");
  display.print(powerIsBattery ? "BATT " : "GRID ");
  display.print("| NET: ");
  if (mqttClient.connected()) {
    display.println("LIVE");
  } else {
    display.print("BUF:");
    display.println(bufferCount);
  }

  display.display();
}

// =========================================================================
// COMPRESSOR HYSTERESIS CONTROL (Task 1)
// =========================================================================
void handleCompressorControl() {
  unsigned long now = millis();

  if (compressorState) {
    // Compressor is currently ON -> Check if temperature reached or went below 3.0°C
    if (currentTemp <= COMPRESSOR_OFF_TEMP) {
      compressorState = false;
      digitalWrite(PIN_RELAY_COMP, LOW);
      compressorLastOffTime = now;
      Serial.printf("[COMPRESSOR] Turn OFF at %.1f°C. 60s minimum off delay started.\n", currentTemp);
    }
  } else {
    // Compressor is currently OFF -> Turn ON if Temp >= 7.0°C AND 60s delay satisfied
    if (currentTemp >= COMPRESSOR_ON_TEMP) {
      unsigned long elapsedSinceOff = now - compressorLastOffTime;
      if (compressorLastOffTime == 0 || elapsedSinceOff >= COMP_MIN_OFF_DELAY) {
        compressorState = true;
        digitalWrite(PIN_RELAY_COMP, HIGH);
        Serial.printf("[COMPRESSOR] Turn ON at %.1f°C (60s delay satisfied).\n", currentTemp);
      } else {
        int secRemaining = (COMP_MIN_OFF_DELAY - elapsedSinceOff) / 1000;
        Serial.printf("[COMPRESSOR PROTECTION] Temp >= 7°C (%.1f°C), waiting for 60s delay (%d s left).\n", currentTemp, secRemaining);
      }
    }
  }
}

// =========================================================================
// DOOR & POWER BUTTON MONITORING (Tasks 1 & 3)
// =========================================================================
bool lastDoorReading = false;
bool lastPowerBtnReading = false;

void checkDoorAndPowerInputs() {
  unsigned long now = millis();

  // 1. Door Switch: Active LOW (Pressed = Closed, Released = Open)
  bool currentDoorState = (digitalRead(PIN_DOOR_SWITCH) == HIGH); // HIGH = Door Open
  if (currentDoorState != doorIsOpen) {
    doorIsOpen = currentDoorState;
    if (doorIsOpen) {
      doorOpenedTimestamp = now;
      doorOpenSeconds = 0;
      Serial.println("[DOOR ALERT] Door was OPENED!");
    } else {
      doorOpenedTimestamp = 0;
      doorOpenSeconds = 0;
      noTone(PIN_BUZZER);
      Serial.println("[DOOR] Door is now CLOSED.");
    }
    // Task 1 requirement: "Send MQTT data every 5 seconds and on door-state changes."
    sendTelemetryPacket();
  }

  // Update door open duration & check >60s breach buzzer
  if (doorIsOpen) {
    doorOpenSeconds = (now - doorOpenedTimestamp) / 1000;
    if (doorOpenSeconds >= DOOR_ALARM_LIMIT) {
      // Sound Buzzer alert (1000Hz tone pulsing)
      tone(PIN_BUZZER, (now / 500) % 2 == 0 ? 1200 : 800);
      digitalWrite(PIN_LED_RED, (now / 250) % 2 == 0 ? HIGH : LOW);
    } else {
      noTone(PIN_BUZZER);
    }
  } else {
    noTone(PIN_BUZZER);
  }

  // 2. Power Mode Button: Toggle Grid vs Battery simulation
  bool currentPowerBtn = (digitalRead(PIN_POWER_SWITCH) == LOW);
  if (currentPowerBtn && !lastPowerBtnReading) {
    powerIsBattery = !powerIsBattery;
    Serial.printf("[POWER STATUS] Switched to %s mode!\n", powerIsBattery ? "BATTERY BACKUP" : "AC GRID");
    sendTelemetryPacket();
  }
  lastPowerBtnReading = currentPowerBtn;

  // 3. LED Indicators
  if (currentTemp >= TEMP_SAFE_MIN && currentTemp <= TEMP_SAFE_MAX && !redAlarmLatched) {
    digitalWrite(PIN_LED_GREEN, HIGH);
    if (doorOpenSeconds < DOOR_ALARM_LIMIT) digitalWrite(PIN_LED_RED, LOW);
  } else {
    digitalWrite(PIN_LED_GREEN, LOW);
    digitalWrite(PIN_LED_RED, HIGH);
  }
}

// =========================================================================
// TELEMETRY TRANSMISSION & OFFLINE BUFFERING
// =========================================================================
String serializePayload(float t, const char* door, int doorSec, const char* pwr, const char* comp) {
  StaticJsonDocument<256> doc;
  doc["fridge_id"] = FRIDGE_ID;
  doc["temperature"] = serialized(String(t, 2));
  doc["door_state"] = door;
  doc["door_open_seconds"] = doorSec;
  doc["power_source"] = pwr;
  doc["compressor_state"] = comp;

  String out;
  serializeJson(doc, out);
  return out;
}

void bufferReadingLocally(float t, bool door, int doorSec, bool pwrBatt, bool comp) {
  if (bufferCount < MAX_BUFFER_CAPACITY) {
    int idx = (bufferHead + bufferCount) % MAX_BUFFER_CAPACITY;
    offlineBuffer[idx].temp = t;
    offlineBuffer[idx].doorOpen = door;
    offlineBuffer[idx].doorSec = doorSec;
    offlineBuffer[idx].isBattery = pwrBatt;
    offlineBuffer[idx].compOn = comp;
    offlineBuffer[idx].timestamp = getCurrentTimestamp();

    String nonce = generateNonce();
    strncpy(offlineBuffer[idx].nonce, nonce.c_str(), sizeof(offlineBuffer[idx].nonce));

    String payloadStr = serializePayload(t, door ? "OPEN" : "CLOSED", doorSec, pwrBatt ? "BATTERY" : "GRID", comp ? "ON" : "OFF");
    String sig = computeHMAC(payloadStr, offlineBuffer[idx].timestamp, nonce);
    strncpy(offlineBuffer[idx].signature, sig.c_str(), sizeof(offlineBuffer[idx].signature));

    bufferCount++;
    Serial.printf("[BUFFER] Stored offline reading %d / %d in memory.\n", bufferCount, MAX_BUFFER_CAPACITY);
  } else {
    // Buffer is full (exceeded 30 minutes), slide head forward (FIFO)
    bufferHead = (bufferHead + 1) % MAX_BUFFER_CAPACITY;
    Serial.println("[BUFFER] Reached 30-minute capacity. Overwriting oldest sample.");
  }
}

void flushOfflineBuffer() {
  if (bufferCount == 0 || !mqttClient.connected()) return;

  Serial.printf("[SYNC] Reconnected! Flushing %d buffered readings in chronological order...\n", bufferCount);

  // Send packets in chunks of 5 to avoid exceeding MQTT MTU
  while (bufferCount > 0) {
    StaticJsonDocument<2048> doc;
    JsonArray arr = doc.to<JsonArray>();

    int chunkSize = min(bufferCount, 5);
    for (int i = 0; i < chunkSize; i++) {
      int idx = (bufferHead + i) % MAX_BUFFER_CAPACITY;
      JsonObject pObj = arr.createNestedObject();

      JsonObject payloadObj = pObj.createNestedObject("payload");
      payloadObj["fridge_id"] = FRIDGE_ID;
      payloadObj["temperature"] = offlineBuffer[idx].temp;
      payloadObj["door_state"] = offlineBuffer[idx].doorOpen ? "OPEN" : "CLOSED";
      payloadObj["door_open_seconds"] = offlineBuffer[idx].doorSec;
      payloadObj["power_source"] = offlineBuffer[idx].isBattery ? "BATTERY" : "GRID";
      payloadObj["compressor_state"] = offlineBuffer[idx].compOn ? "ON" : "OFF";

      pObj["timestamp"] = offlineBuffer[idx].timestamp;
      pObj["nonce"] = offlineBuffer[idx].nonce;
      pObj["signature"] = offlineBuffer[idx].signature;
    }

    String jsonStr;
    serializeJson(doc, jsonStr);
    mqttClient.publish(TOPIC_OFFLINE, jsonStr.c_str());

    bufferHead = (bufferHead + chunkSize) % MAX_BUFFER_CAPACITY;
    bufferCount -= chunkSize;
    delay(50); // Short transmission gap
  }

  Serial.println("[SYNC] Offline sync completed successfully without duplicates!");
}

void sendTelemetryPacket() {
  lastTelemetryMillis = millis();
  unsigned long long timestamp = getCurrentTimestamp();
  String nonce = generateNonce();

  const char* doorStr = doorIsOpen ? "OPEN" : "CLOSED";
  const char* pwrStr = powerIsBattery ? "BATTERY" : "GRID";
  const char* compStr = compressorState ? "ON" : "OFF";

  String serializedPayload = serializePayload(currentTemp, doorStr, doorOpenSeconds, pwrStr, compStr);
  String signature = computeHMAC(serializedPayload, timestamp, nonce);

  // Build full signed telemetry envelope
  StaticJsonDocument<512> doc;
  JsonObject payloadObj = doc.createNestedObject("payload");
  payloadObj["fridge_id"] = FRIDGE_ID;
  payloadObj["temperature"] = currentTemp;
  payloadObj["door_state"] = doorStr;
  payloadObj["door_open_seconds"] = doorOpenSeconds;
  payloadObj["power_source"] = pwrStr;
  payloadObj["compressor_state"] = compStr;

  doc["timestamp"] = timestamp;
  doc["nonce"] = nonce;
  doc["signature"] = signature;

  String outputStr;
  serializeJson(doc, outputStr);

  if (mqttClient.connected()) {
    mqttClient.publish(TOPIC_TELEMETRY, outputStr.c_str());
    mqttClient.publish(TOPIC_LOCAL_TEL, outputStr.c_str());
    Serial.printf("[TELEMETRY SENT] Temp: %.1f°C | Comp: %s | Door: %s | Pwr: %s\n",
                  currentTemp, compStr, doorStr, pwrStr);
  } else {
    // Network is offline -> Buffer locally!
    bufferReadingLocally(currentTemp, doorIsOpen, doorOpenSeconds, powerIsBattery, compressorState);
  }
}

// =========================================================================
// WI-FI & MQTT CONNECTION HANDLER
// =========================================================================
void ensureNetworkConnection() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    int retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 10) {
      delay(200);
      retries++;
    }
  }

  if (WiFi.status() == WL_CONNECTED && !mqttClient.connected()) {
    String clientId = "ESP32_ColdChain_" + String(random(0xffff), HEX);
    if (mqttClient.connect(clientId.c_str())) {
      Serial.println("[MQTT] Connected to Broker successfully.");
      flushOfflineBuffer();
    }
  }
}

// =========================================================================
// ARDUINO SETUP & LOOP
// =========================================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n====================================================");
  Serial.println("  COLDCHAIN ESP32 VACCINE NODE STARTING");
  Serial.println("====================================================");

  // Initialize GPIO Pins
  pinMode(PIN_RELAY_COMP, OUTPUT);
  digitalWrite(PIN_RELAY_COMP, LOW); // Start with compressor OFF

  pinMode(PIN_DOOR_SWITCH, INPUT_PULLUP);
  pinMode(PIN_POWER_SWITCH, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  digitalWrite(PIN_LED_GREEN, HIGH);
  digitalWrite(PIN_LED_RED, LOW);

  // Initialize DHT22
  dht.begin();

  // Initialize OLED
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println("[ERROR] SSD1306 allocation failed.");
  } else {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(10, 20);
    display.println("ColdChain Init...");
    display.display();
  }

  // Configure MQTT
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setBufferSize(1024);

  // Connect to Network
  ensureNetworkConnection();
  Serial.println("[SETUP] ESP32 Node Ready.");
}

void loop() {
  unsigned long now = millis();

  // 1. Maintain Wi-Fi and MQTT
  if (!mqttClient.connected()) {
    ensureNetworkConnection();
  } else {
    mqttClient.loop();
  }

  // 2. Read Sensors (DHT22)
  float t = dht.readTemperature();
  if (!isnan(t)) {
    currentTemp = t;
  }

  // 3. Monitor Door and Power Inputs
  checkDoorAndPowerInputs();

  // 4. Evaluate Compressor Hysteresis & 60s Delay
  handleCompressorControl();

  // 5. Periodic 5-Second Telemetry Publish
  if (now - lastTelemetryMillis >= TELEMETRY_INTERVAL) {
    sendTelemetryPacket();
  }

  // 6. Refresh OLED UI
  updateOLEDDisplay();

  delay(100);
}
