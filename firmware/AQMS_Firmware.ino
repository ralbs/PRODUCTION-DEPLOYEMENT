/*
 * AQMS Firmware — INVIHUB TECHNOSOLUTIONS
 * Board: AQMS_CRPF_PCB (ESP32-WROOM-32)
 *
 * Sensors : MQ-135, MQ-131 (O3), MQ-136, MQ-7, MQ-8, MICS-6814, BME680, PMS5003
 * ADC     : 2x ADS1115 (analog gas outputs)
 * Comms   : WiFi (primary) with SIM800C/GPRS fallback
 * Storage : LittleFS offline buffer (JSON-lines) for outage resilience
 *
 * Behavior:
 *  - Publishes telemetry every TELEMETRY_INTERVAL_MS on the JSON schema below.
 *  - Recalibrates gas-sensor baselines automatically at 00:00 local time.
 *  - If WiFi and GPRS are both down, telemetry is appended to a buffer file
 *    and flushed (with delayed=true) once connectivity returns.
 *
 * Libraries required (Library Manager):
 *   ArduinoJson, Adafruit ADS1X15, Adafruit BME680, Adafruit Unified Sensor,
 *   TinyGSM
 *
 * See config.h for every pin assignment and network credential — that is
 * the only file you should need to edit for your specific board revision.
 */

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

// ---------------- Forward decls ----------------
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

// Reads SIM800C clock (set by NITZ or AT+CNTP) and syncs the ESP32's
// internal time so getLocalTime() works even without WiFi.
void syncTimeFromModem() {
  modem.sendAT(GF("+CCLK?"));
  String resp = "";
  modem.waitResponse(3000L, resp);
  // Response: +CCLK: "26/07/04,15:30:00+22"
  int q1 = resp.indexOf('"');
  int q2 = resp.lastIndexOf('"');
  if (q1 < 0 || q2 <= q1) return;
  String dt = resp.substring(q1 + 1, q2);  // "YY/MM/DD,HH:MM:SS+TZ"
  if (dt.length() < 17) return;

  struct tm t = {};
  t.tm_year = dt.substring(0,  2).toInt() + 100;  // years since 1900
  t.tm_mon  = dt.substring(3,  5).toInt() - 1;
  t.tm_mday = dt.substring(6,  8).toInt();
  t.tm_hour = dt.substring(9,  11).toInt();
  t.tm_min  = dt.substring(12, 14).toInt();
  t.tm_sec  = dt.substring(15, 17).toInt();
  // tz offset in dt[17..] is in quarter-hours; convert to seconds and subtract
  int qh   = dt.substring(17).toInt();
  time_t utc = mktime(&t) - (long)qh * 15 * 60;

  struct timeval tv = { .tv_sec = utc };
  settimeofday(&tv, nullptr);
  Serial.println("[INFO] ESP32 time synced from modem RTC.");
}

// =====================================================================
void setup() {
  Serial.begin(115200);
  delay(200);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  if (!ads1.begin(ADS1115_ADDR_1)) Serial.println("[WARN] ADS1115 #1 (0x48) not found");
  if (!ads2.begin(ADS1115_ADDR_2)) Serial.println("[WARN] ADS1115 #2 (0x49) not found");
  ads1.setGain(GAIN_ONE);
  ads2.setGain(GAIN_ONE);

  if (!bme.begin(BME680_ADDR)) {
    Serial.println("[WARN] BME680 not found");
  } else {
    bme.setTemperatureOversampling(BME680_OS_8X);
    bme.setHumidityOversampling(BME680_OS_2X);
    bme.setPressureOversampling(BME680_OS_4X);
    bme.setIIRFilterSize(BME680_FILTER_SIZE_3);
    bme.setGasHeater(320, 150); // 320C for 150ms
  }

  pinMode(MQ135_DOUT_PIN, INPUT);
  pinMode(MQ136_DOUT_PIN, INPUT);
  pinMode(MQ131_DOUT_PIN, INPUT);
  pinMode(MQ8_DOUT_PIN, INPUT);
  pinMode(MQ7_DOUT_PIN, INPUT);

  pmsSerial.begin(9600, SERIAL_8N1, PMS_RX_PIN, PMS_TX_PIN);
  gsmSerial.begin(9600, SERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN);

  pinMode(GSM_PWRKEY_PIN, OUTPUT);
  digitalWrite(GSM_PWRKEY_PIN, HIGH); // idle high, pulsed low in connectGPRS()

  if (!LittleFS.begin(true)) {
    Serial.println("[ERROR] LittleFS mount failed");
  }

  connectWiFi();
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);

  loadBaselineFromFlash();
  if (isnan(baseline.mq135)) {
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
// Connectivity
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
  // SIM800C PWRKEY needs an active-low pulse to power on per datasheet.
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

  // Many operators push NITZ time automatically on registration; try reading
  // modem RTC directly first. If the year comes back as 1980 (factory default)
  // the modem hasn't received NITZ yet — in that case the timestamp falls back
  // to epoch (1970) which the backend still stores; correct it on next cycle.
  syncTimeFromModem();
  return true;
}

// =====================================================================
// Sensor reads
// =====================================================================
float adsToVoltage(Adafruit_ADS1115 &ads, uint8_t ch) {
  int16_t raw = ads.readADC_SingleEnded(ch);
  return ads.computeVolts(raw);
}

PMSData readPMS() {
  PMSData data;
  while (pmsSerial.available() >= 32) {
    if (pmsSerial.read() != 0x42) continue;
    if (pmsSerial.peek() != 0x4D) continue;

    uint8_t buf[30];
    buf[0] = 0x4D;
    pmsSerial.readBytes(buf + 1, 29);

    uint16_t checksum = 0x42 + buf[0];
    for (int i = 1; i < 28; i++) checksum += buf[i];
    uint16_t recvChecksum = (buf[28] << 8) | buf[29];
    if (checksum != recvChecksum) continue;

    data.pm1   = (buf[4] << 8) | buf[5];   // "standard" PM values, indices 4-9
    data.pm2_5 = (buf[6] << 8) | buf[7];
    data.pm10  = (buf[8] << 8) | buf[9];
    data.valid = true;
    break;
  }
  return data;
}

// =====================================================================
// Gas-sensor calibration
//
// MQ-series and MICS-6814 sensors don't output ppm directly — you get a
// voltage that has to be compared against a clean-air baseline (R0) and
// run through each gas's datasheet Rs/Ro-vs-ppm curve. This firmware
// captures that baseline automatically every night (when ambient air is
// typically at its cleanest and most stable) and stores it in flash so a
// reboot doesn't lose it until the next scheduled recalibration.
// =====================================================================
void runCalibration() {
  Serial.println("[INFO] Running sensor recalibration (baseline capture)...");

  double sMQ135 = 0, sMQ131 = 0, sMQ136 = 0, sMQ7 = 0, sMQ8 = 0;
  double sCO = 0, sNH3 = 0, sNO2 = 0;
  const int n = RECALIBRATION_SAMPLES;

  for (int i = 0; i < n; i++) {
    sMQ135 += adsToVoltage(ads1, CH_MQ135_AOUT);
    sMQ131 += adsToVoltage(ads1, CH_MQ131_AOUT);
    sMQ7   += adsToVoltage(ads1, CH_MQ7_AOUT);
    sMQ8   += adsToVoltage(ads1, CH_MQ8_AOUT);
    sMQ136 += adsToVoltage(ads2, CH_MQ136_AOUT);
    sCO    += adsToVoltage(ads2, CH_MICS_CO);
    sNH3   += adsToVoltage(ads2, CH_MICS_NH3);
    sNO2   += adsToVoltage(ads2, CH_MICS_NO2);
    delay(200);
  }

  baseline.mq135 = sMQ135 / n;
  baseline.mq131 = sMQ131 / n;
  baseline.mq136 = sMQ136 / n;
  baseline.mq7   = sMQ7 / n;
  baseline.mq8   = sMQ8 / n;
  baseline.mics_co  = sCO / n;
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
  if (!getLocalTime(&t, 5)) return; // NTP not synced yet, skip this cycle

  if (t.tm_hour == RECALIBRATION_HOUR &&
      t.tm_min  == RECALIBRATION_MINUTE &&
      t.tm_mday != lastRecalDay) {
    runCalibration();
    lastRecalDay = t.tm_mday;
  }
}

// Placeholder Rs/Ro -> ppm model. Replace slope/exponent per sensor once you
// have datasheet curve-fit values (or a gas-chamber calibration run) —
// everything else in the firmware is agnostic to how this function works.
float estimatePPM(float vNow, float vBaseline, float sensitivity) {
  if (isnan(vBaseline) || vBaseline <= 0.01) return -1;
  float ratio = vNow / vBaseline;
  if (ratio <= 0) ratio = 0.01;
  float ppm = sensitivity * pow(ratio, -1.5) * 100.0;
  return ppm < 0 ? 0 : round(ppm * 10) / 10.0;
}

// BME680 has no dedicated CO2 sensor — this converts gas resistance into a
// rough eCO2-style proxy, NOT a certified reading. For a real co2 field,
// add a dedicated NDIR sensor (e.g. MH-Z19, SCD30) and read it directly.
float estimateCO2FromGasResistance(uint32_t gasRes) {
  if (gasRes == 0) return 400;
  float est = 400.0 + (50000.0 / (float)gasRes) * 1000.0;
  return constrain(est, 400, 5000);
}

// =====================================================================
// Telemetry
// =====================================================================
String buildTelemetryJSON() {
  StaticJsonDocument<768> doc;

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
  bool bmeOk = bme.performReading();
  if (bmeOk) {
    temp = bme.temperature;
    hum  = bme.humidity;
    pres = bme.pressure / 100.0f;
  }
  JsonObject weather = doc.createNestedObject("weather");
  weather["temperature"] = isnan(temp) ? 0 : round(temp * 10) / 10.0;
  weather["humidity"]    = isnan(hum)  ? 0 : (int)round(hum);
  weather["pressure"]    = isnan(pres) ? 0 : (int)round(pres);

  PMSData pms = readPMS();
  JsonObject pollutants = doc.createNestedObject("pollutants");
  pollutants["pm1"]   = pms.pm1;
  pollutants["pm2_5"] = pms.pm2_5;
  pollutants["pm10"]  = pms.pm10;
  pollutants["co"]    = estimatePPM(adsToVoltage(ads2, CH_MICS_CO), baseline.mics_co, 1.0);
  pollutants["co2"]   = bmeOk ? estimateCO2FromGasResistance(bme.gas_resistance) : 400;
  pollutants["no2"]   = estimatePPM(adsToVoltage(ads2, CH_MICS_NO2), baseline.mics_no2, 0.05);
  pollutants["o3"]    = estimatePPM(adsToVoltage(ads1, CH_MQ131_AOUT), baseline.mq131, 0.05);

  JsonObject battery = doc.createNestedObject("battery");
  float vbat = analogRead(VBAT_ADC_PIN) / 4095.0f * 3.3f * VBAT_DIVIDER_RATIO;
  battery["voltage"] = round(vbat * 100) / 100.0;
  battery["percent"] = constrain((int)round((vbat - VBAT_EMPTY) / (VBAT_FULL - VBAT_EMPTY) * 100), 0, 100);

  JsonObject signal = doc.createNestedObject("signal");
  signal["wifi_rssi"] = wifiOk ? WiFi.RSSI() : (gprsOk ? -999 : 0);

  JsonObject health = doc.createNestedObject("health");
  health["mq135"]   = !isnan(baseline.mq135) ? "OK" : "FAULT";
  health["pms5003"] = pms.valid ? "OK" : "FAULT";
  // Board uses BME680, not a DHT22 — this field reports BME680 status under
  // the schema's original key so downstream consumers don't need to change.
  health["dht22"]   = bmeOk ? "OK" : "FAULT";

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
    lastSendDelayed = true; // GPRS path implies degraded link, not a clean primary send
    return true;
  }

  return false;
}

// =====================================================================
// Offline buffering (LittleFS, JSON-lines)
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
