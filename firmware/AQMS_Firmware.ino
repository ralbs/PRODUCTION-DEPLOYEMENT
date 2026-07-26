#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Adafruit_ADS1X15.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME680.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <time.h>
#include <vector>

#define TINY_GSM_MODEM_SIM800
#include <TinyGsmClient.h>

#include "config.h"

// ---------------- Globals ----------------
Adafruit_ADS1115 ads1;   // 0x48
Adafruit_ADS1115 ads2;   // 0x49
Adafruit_BME680  bme;

HardwareSerial pmsSerial(1);
HardwareSerial gsmSerial(2);
TinyGsm modem(gsmSerial);
TinyGsmClient gsmClient(modem);

bool wifiOk = false;
bool gprsOk = false;
bool ads1Ok = false;
bool ads2Ok = false;
bool bmeOk  = false;
bool lastSendDelayed = false;
int  lastRecalDay = -1;

struct PMSData {
  uint16_t pm1 = 0, pm2_5 = 0, pm10 = 0;
  bool valid = false;
};

struct MQBaseline {
  float mq135 = NAN, mq131 = NAN, mq136 = NAN, mq7 = NAN, mq8 = NAN;
  float mics_co = NAN, mics_nh3 = NAN, mics_no2 = NAN;
};
MQBaseline baseline;
PMSData cachedPMS;

// ---------------- Forward Declarations ----------------
void  connectWiFi();
bool  connectGPRS();
PMSData readPMS();
float adsToVoltage(Adafruit_ADS1115 &ads, uint8_t ch);
void  runCalibration();
void  loadBaselineFromFlash();
void  checkMidnightCalibration();
float estimatePPM(float vNow, float vBaseline, float sensitivity);
float estimateCO2FromGasResistance(uint32_t gasRes);
String buildTelemetryJSON();
bool  sendTelemetry(const String &json);
void  bufferOffline(const String &json);
void  flushBufferedIfOnline();
void  syncTimeFromModem();

// Synchronize system RTC from SIM800C
void syncTimeFromModem() {
  modem.sendAT(GF("+CCLK?"));
  String resp = "";
  modem.waitResponse(3000L, resp);
  int q1 = resp.indexOf('"');
  int q2 = resp.lastIndexOf('"');
  if (q1 < 0 || q2 <= q1) return;
  String dt = resp.substring(q1 + 1, q2);
  if (dt.length() < 17) return;

  struct tm t = {};
  t.tm_year = dt.substring(0,  2).toInt() + 100;
  t.tm_mon  = dt.substring(3,  5).toInt() - 1;
  t.tm_mday = dt.substring(6,  8).toInt();
  t.tm_hour = dt.substring(9,  11).toInt();
  t.tm_min  = dt.substring(12, 14).toInt();
  t.tm_sec  = dt.substring(15, 17).toInt();
  
  int qh   = dt.substring(17).toInt();
  time_t utc = mktime(&t) - (long)qh * 15 * 60;

  struct timeval tv = { .tv_sec = utc };
  settimeofday(&tv, nullptr);
  Serial.println("[INFO] ESP32 time synced from modem RTC.");
}

// =====================================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  // Non-blocking ADC Initializations
  if (ads1.begin(ADS1115_ADDR_1)) {
    ads1.setGain(GAIN_ONE);
    ads1Ok = true;
    Serial.println("[OK] ADS1115 #1 (0x48) initialized.");
  } else {
    Serial.println("[WARN] ADS1115 #1 (0x48) not found.");
  }

  if (ads2.begin(ADS1115_ADDR_2)) {
    ads2.setGain(GAIN_ONE);
    ads2Ok = true;
    Serial.println("[OK] ADS1115 #2 (0x49) initialized.");
  } else {
    Serial.println("[WARN] ADS1115 #2 (0x49) not found.");
  }

  // Non-blocking BME680 Initialization
  if (bme.begin(BME680_ADDR)) {
    bmeOk = true;
    bme.setTemperatureOversampling(BME680_OS_8X);
    bme.setHumidityOversampling(BME680_OS_2X);
    bme.setPressureOversampling(BME680_OS_4X);
    bme.setIIRFilterSize(BME680_FILTER_SIZE_3);
    bme.setGasHeater(320, 150);
    Serial.println("[OK] BME680 initialized.");
  } else {
    Serial.println("[WARN] BME680 not found.");
  }

  pinMode(MQ135_DOUT_PIN, INPUT);
  pinMode(MQ136_DOUT_PIN, INPUT);
  pinMode(MQ131_DOUT_PIN, INPUT);
  pinMode(MQ8_DOUT_PIN, INPUT);
  pinMode(MQ7_DOUT_PIN, INPUT);

  pmsSerial.begin(9600, SERIAL_8N1, PMS_RX_PIN, PMS_TX_PIN);
  gsmSerial.begin(115200, SERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN);

  pinMode(GSM_PWRKEY_PIN, OUTPUT);
  digitalWrite(GSM_PWRKEY_PIN, HIGH);

  if (!LittleFS.begin(true)) {
    Serial.println("[ERROR] LittleFS mount failed");
  }

  connectWiFi();
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);

  loadBaselineFromFlash();
  if (isnan(baseline.mq135) && (ads1Ok || ads2Ok)) {
    Serial.println("[INFO] No stored baseline — warming up gas sensors for first calibration...");
    delay(RECALIBRATION_WARMUP_MS);
    runCalibration();
  }
}

// =====================================================================
void loop() {
  static unsigned long lastSend = 0;

  wifiOk = (WiFi.status() == WL_CONNECTED);
  checkMidnightCalibration();

  PMSData fresh = readPMS();
  if (fresh.valid) cachedPMS = fresh;
  static unsigned long lastPmsDbg = 0;
  if (millis() - lastPmsDbg >= 5000) {
    lastPmsDbg = millis();
    Serial.printf("[DEBUG] PMS5003 — valid: %d, pm1: %d, pm2_5: %d, pm10: %d\n",
                  fresh.valid, cachedPMS.pm1, cachedPMS.pm2_5, cachedPMS.pm10);
  }

  if (millis() - lastSend >= TELEMETRY_INTERVAL_MS) {
    lastSend = millis();

    String payload = buildTelemetryJSON();
    Serial.println(payload);

    lastSendDelayed = false;
    bool online = wifiOk || gprsOk;

    if (online) {
      if (sendTelemetry(payload)) {
        flushBufferedIfOnline();
      } else {
        bufferOffline(payload);
      }
    } else {
      bufferOffline(payload);
    }
  }
}

// =====================================================================
// Network Management
// =====================================================================
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[INFO] Connecting to WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    delay(300);
    Serial.print(".");
  }
  wifiOk = (WiFi.status() == WL_CONNECTED);
  Serial.println(wifiOk ? " connected" : " failed");
  if (!wifiOk) gprsOk = connectGPRS();
}

bool connectGPRS() {
  Serial.println("[INFO] Bringing up SIM800C...");
  digitalWrite(GSM_PWRKEY_PIN, LOW);
  delay(1200);
  digitalWrite(GSM_PWRKEY_PIN, HIGH);
  delay(3000);

  if (!modem.restart()) {
    Serial.println("[WARN] Modem restart failed");
    return false;
  }
  Serial.println("[INFO] Connecting GPRS...");
  if (!modem.gprsConnect(GPRS_APN, GPRS_USER, GPRS_PASS)) {
    Serial.println("[WARN] GPRS connect failed");
    return false;
  }
  if (!modem.isGprsConnected()) return false;

  syncTimeFromModem();
  return true;
}

// =====================================================================
// Sensor Acquisition
// =====================================================================
float adsToVoltage(Adafruit_ADS1115 &ads, uint8_t ch) {
  int16_t raw = ads.readADC_SingleEnded(ch);
  return ads.computeVolts(raw);
}

// PMS5003 streaming state machine
enum PMSState { PMS_WAIT_H1, PMS_WAIT_H2, PMS_READ_PAYLOAD };
static PMSState pmsState = PMS_WAIT_H1;
static uint8_t  pmsBuf[30];
static uint8_t  pmsIdx = 0;

PMSData readPMS() {
  PMSData data;
  while (pmsSerial.available()) {
    uint8_t b = pmsSerial.read();
    switch (pmsState) {
      case PMS_WAIT_H1:
        if (b == 0x42) pmsState = PMS_WAIT_H2;
        break;
      case PMS_WAIT_H2:
        pmsState = (b == 0x4D) ? PMS_READ_PAYLOAD : PMS_WAIT_H1;
        pmsIdx = 0;
        break;
      case PMS_READ_PAYLOAD:
        pmsBuf[pmsIdx++] = b;
        if (pmsIdx >= 30) {
          uint16_t checksum = 0x42 + 0x4D;
          for (int i = 0; i < 28; i++) checksum += pmsBuf[i];
          uint16_t recvChecksum = (pmsBuf[28] << 8) | pmsBuf[29];
          if (checksum == recvChecksum) {
            data.pm1   = (pmsBuf[2] << 8) | pmsBuf[3];
            data.pm2_5 = (pmsBuf[4] << 8) | pmsBuf[5];
            data.pm10  = (pmsBuf[6] << 8) | pmsBuf[7];
            data.valid = true;
          }
          pmsState = PMS_WAIT_H1;
          return data;
        }
        break;
    }
  }
  return data;
}

// =====================================================================
// Calibration Routines
// =====================================================================
void runCalibration() {
  Serial.println("[INFO] Running sensor recalibration (baseline capture)...");

  double sMQ135 = 0, sMQ131 = 0, sMQ136 = 0, sMQ7 = 0, sMQ8 = 0;
  double sNH3 = 0, sNO2 = 0;
  const int n = RECALIBRATION_SAMPLES;

  for (int i = 0; i < n; i++) {
    if (ads1Ok) {
      sNH3   += adsToVoltage(ads1, CH_NH3_MICS);
      sNO2   += adsToVoltage(ads1, CH_NO2_MICS);
      sMQ135 += adsToVoltage(ads1, CH_MQ135_AOUT);
      sMQ131 += adsToVoltage(ads1, CH_MQ131_AOUT);
    }
    if (ads2Ok) {
      sMQ136 += adsToVoltage(ads2, CH_MQ136_AOUT);
      sMQ7   += adsToVoltage(ads2, CH_MQ7_AOUT);
      sMQ8   += adsToVoltage(ads2, CH_MQ8_AOUT);
    }
    delay(200);
  }

  baseline.mq135   = sMQ135 / n;
  baseline.mq131   = sMQ131 / n;
  baseline.mq136   = sMQ136 / n;
  baseline.mq7     = sMQ7 / n;
  baseline.mq8     = sMQ8 / n;
  baseline.mics_co  = NAN;
  baseline.mics_nh3 = sNH3 / n;
  baseline.mics_no2 = sNO2 / n;

  File f = LittleFS.open("/baseline.dat", "w");
  if (f) {
    f.write((uint8_t *)&baseline, sizeof(baseline));
    f.close();
  }
  Serial.println("[INFO] Calibration complete.");
}

void loadBaselineFromFlash() {
  if (!LittleFS.exists("/baseline.dat")) return;
  File f = LittleFS.open("/baseline.dat", "r");
  if (!f || f.size() != sizeof(baseline)) { if (f) f.close(); return; }
  f.read((uint8_t *)&baseline, sizeof(baseline));
  f.close();
  Serial.println("[INFO] Loaded gas-sensor baseline from flash.");
}

void checkMidnightCalibration() {
  struct tm t;
  if (!getLocalTime(&t, 5)) return;

  if (t.tm_hour == RECALIBRATION_HOUR &&
      t.tm_min  == RECALIBRATION_MINUTE &&
      t.tm_mday != lastRecalDay) {
    runCalibration();
    lastRecalDay = t.tm_mday;
  }
}

float estimatePPM(float vNow, float vBaseline, float sensitivity) {
  if (isnan(vBaseline) || vBaseline <= 0.01) return -1;
  float ratio = vNow / vBaseline;
  if (ratio <= 0) ratio = 0.01;
  float ppm = sensitivity * pow(ratio, -1.5) * 100.0;
  return ppm < 0 ? 0 : round(ppm * 10) / 10.0;
}

float estimateCO2FromGasResistance(uint32_t gasRes) {
  if (gasRes == 0) return 400;
  float est = 400.0 + (50000.0 / (float)gasRes) * 1000.0;
  return constrain(est, 400, 5000);
}

// =====================================================================
// Payload Builder & Exporter
// =====================================================================
String buildTelemetryJSON() {
  StaticJsonDocument<1024> doc;

  doc["device_id"]  = DEVICE_ID;
  doc["station_id"] = STATION_ID;

  struct tm t;
  char tsBuf[25] = "1970-01-01T00:00:00Z";
  if (getLocalTime(&t, 5)) {
    strftime(tsBuf, sizeof(tsBuf), "%Y-%m-%dT%H:%M:%SZ", &t);
  }
  doc["timestamp"] = tsBuf;

  JsonObject location = doc.createNestedObject("location");
  location["lat"] = STATION_LAT;
  location["lon"] = STATION_LON;

  float temp = NAN, hum = NAN, pres = NAN;
  bool readingOk = bmeOk ? bme.performReading() : false;
  if (readingOk) {
    temp = bme.temperature;
    hum  = bme.humidity;
    pres = bme.pressure / 100.0f;
  }
  JsonObject weather = doc.createNestedObject("weather");
  weather["temperature"] = isnan(temp) ? 0 : round(temp * 10) / 10.0;
  weather["humidity"]    = isnan(hum)  ? 0 : (int)round(hum);
  weather["pressure"]    = isnan(pres) ? 0 : (int)round(pres);

  PMSData pms = cachedPMS;
  JsonObject pollutants = doc.createNestedObject("pollutants");
  pollutants["pm1"]     = pms.pm1;
  pollutants["pm2_5"]   = pms.pm2_5;
  pollutants["pm10"]    = pms.pm10;
  
  // MiCS-6814 channels (on ADS1115 #1)
  pollutants["co"]      = -1;  // MiCS-6814 CO (RED) pin not connected on PCB
  pollutants["no2"]     = ads1Ok ? estimatePPM(adsToVoltage(ads1, CH_NO2_MICS), baseline.mics_no2, 0.05) : -1;
  pollutants["nh3"]     = ads1Ok ? estimatePPM(adsToVoltage(ads1, CH_NH3_MICS), baseline.mics_nh3, 1.0) : -1;

  // MQ-series channels
  pollutants["o3"]      = ads1Ok ? estimatePPM(adsToVoltage(ads1, CH_MQ131_AOUT), baseline.mq131, 0.05) : -1;
  pollutants["mq135"]   = ads1Ok ? estimatePPM(adsToVoltage(ads1, CH_MQ135_AOUT), baseline.mq135, 1.0) : -1;
  pollutants["h2s"]     = ads2Ok ? estimatePPM(adsToVoltage(ads2, CH_MQ136_AOUT), baseline.mq136, 1.0) : -1;
  pollutants["h2"]      = ads2Ok ? estimatePPM(adsToVoltage(ads2, CH_MQ8_AOUT), baseline.mq8, 1.0) : -1;
  pollutants["mq7_co"]  = ads2Ok ? estimatePPM(adsToVoltage(ads2, CH_MQ7_AOUT), baseline.mq7, 1.0) : -1;

  // eCO2 from BME680 gas resistance
  pollutants["co2"]     = readingOk ? estimateCO2FromGasResistance(bme.gas_resistance) : 400;

  JsonObject battery = doc.createNestedObject("battery");
  battery["voltage"] = 0;
  battery["percent"] = 0;

  JsonObject signal = doc.createNestedObject("signal");
  signal["wifi_rssi"] = wifiOk ? WiFi.RSSI() : (gprsOk ? -999 : 0);

  JsonObject health = doc.createNestedObject("health");
  health["mq_ads1"] = ads1Ok ? "OK" : "FAULT";
  health["mq_ads2"] = ads2Ok ? "OK" : "FAULT";
  health["pms5003"] = pms.valid ? "OK" : "FAULT";
  health["bme680"]  = readingOk ? "OK" : "FAULT";

  JsonObject flags = doc.createNestedObject("flags");
  flags["offline_buffered"] = !(wifiOk || gprsOk);
  flags["delayed"] = lastSendDelayed;

  String out;
  serializeJson(doc, out);
  return out;
}

bool sendTelemetry(const String &json) {
  if (wifiOk) {
    HTTPClient http;
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Id", DEVICE_ID);
    http.addHeader("X-Device-Key", DEVICE_API_KEY);
    int code = http.POST(json);
    http.end();
    if (code > 0 && code < 300) return true;
    Serial.printf("[WARN] WiFi POST failed, code=%d\n", code);
    wifiOk = false;
    gprsOk = connectGPRS();
    return false;
  }

  if (gprsOk) {
    if (!gsmClient.connect(SERVER_HOST, SERVER_PORT)) {
      Serial.println("[WARN] GPRS connect to server failed");
      gprsOk = false;
      return false;
    }
    gsmClient.print(String("POST ") + SERVER_PATH + " HTTP/1.1\r\n" +
                     "Host: " + SERVER_HOST + "\r\n" +
                     "Content-Type: application/json\r\n" +
                     "X-Device-Id: " + DEVICE_ID + "\r\n" +
                     "X-Device-Key: " + DEVICE_API_KEY + "\r\n" +
                     "Content-Length: " + json.length() + "\r\n" +
                     "Connection: close\r\n\r\n" + json);
    unsigned long t0 = millis();
    while (gsmClient.connected() && millis() - t0 < 8000) {
      if (gsmClient.available()) gsmClient.read();
    }
    gsmClient.stop();
    lastSendDelayed = true;
    return true;
  }

  return false;
}

// =====================================================================
// Storage Buffer Management
// =====================================================================
void bufferOffline(const String &json) {
  File f = LittleFS.open(OFFLINE_BUFFER_FILE, FILE_APPEND);
  if (!f) { Serial.println("[ERROR] Could not open buffer file"); return; }
  f.println(json);
  f.close();
  Serial.println("[INFO] Buffered telemetry offline.");
}

void flushBufferedIfOnline() {
  if (!LittleFS.exists(OFFLINE_BUFFER_FILE)) return;

  File f = LittleFS.open(OFFLINE_BUFFER_FILE, "r");
  if (!f) return;

  std::vector<String> remaining;
  int sent = 0;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    line.replace("\"delayed\":false", "\"delayed\":true");
    if (sendTelemetry(line)) {
      sent++;
    } else {
      remaining.push_back(line);
    }
  }
  f.close();

  LittleFS.remove(OFFLINE_BUFFER_FILE);
  if (!remaining.empty()) {
    File out = LittleFS.open(OFFLINE_BUFFER_FILE, FILE_WRITE);
    for (auto &l : remaining) out.println(l);
    out.close();
  }
  if (sent > 0) Serial.printf("[INFO] Flushed %d buffered records.\n", sent);
}