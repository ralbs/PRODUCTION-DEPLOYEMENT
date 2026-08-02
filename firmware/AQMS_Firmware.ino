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

// ── Gas channel stuck-detection state ──
// Each analog gas channel is read once per telemetry cycle. If a channel's raw
// voltage never moves beyond STUCK_DEADBAND_V for STUCK_SAMPLES consecutive
// minutes it is treated as frozen (dead sensor / open ADC path) and the field
// is sent as -1 instead of a constant fake reading.
enum GasCh { CH_NH3, CH_NO2, CH_MQ135, CH_MQ131, CH_MQ136, CH_MQ7, CH_MQ8, GAS_CH_COUNT };
struct GasChanState {
  float  lastVolt = NAN;
  uint8_t frozen  = 0;
};
static GasChanState gasState[GAS_CH_COUNT];

// ── Calibration scheduling ──
// Baselines must be captured only after the sensors have settled. First boot,
// the serial "CAL"/"WIPE" commands, and the midnight job all go through this
// pending timer so the main loop keeps streaming telemetry during warm-up.
static bool          calibrationPending = false;
static unsigned long calibrationDueAt   = 0;

// ---------------- Forward Declarations ----------------
void  connectWiFi();
bool  connectGPRS();
PMSData readPMS();
float adsToVoltage(Adafruit_ADS1115 &ads, uint8_t ch);
float rsRatio(float vNow, float vBaseline, float vc = GAS_VC);
float estimatePPM(float vNow, float vBaseline, float a, float b, float vc = GAS_VC);
void  runCalibration();
void  requestCalibration(unsigned long warmupMs);
void  handleCommand(const String &cmd);
void  loadBaselineFromFlash();
void  checkMidnightCalibration();
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
    ads1.setGain(GAIN_TWOTHIRDS);  // ±6.144V — prevents clipping on 5V MQ dividers
    ads1Ok = true;
    Serial.println("[OK] ADS1115 #1 (0x48) initialized.");
  } else {
    Serial.println("[WARN] ADS1115 #1 (0x48) not found.");
  }

  if (ads2.begin(ADS1115_ADDR_2)) {
    ads2.setGain(GAIN_TWOTHIRDS);  // ±6.144V — prevents clipping on 5V MQ dividers
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
  // Block until NTP syncs (up to 5s) — timestamps will be valid from the first reading
  {
    struct tm t;
    if (getLocalTime(&t, NTP_TIMEOUT_MS)) {
      Serial.printf("[INFO] NTP synced: %04d-%02d-%02d %02d:%02d:%02d\n",
                    t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
                    t.tm_hour, t.tm_min, t.tm_sec);
    } else {
      Serial.println("[WARN] NTP sync timed out — will retry via modem fallback.");
    }
  }

  loadBaselineFromFlash();
  if (isnan(baseline.mq135) && (ads1Ok || ads2Ok)) {
    Serial.println("[INFO] No stored baseline — calibration scheduled after warm-up (telemetry keeps running).");
    requestCalibration(RECALIBRATION_WARMUP_MS);
  }
}

// =====================================================================
void loop() {
  static unsigned long lastSend = 0;

  wifiOk = (WiFi.status() == WL_CONNECTED);
  checkMidnightCalibration();

  // Run a pending calibration once its warm-up window has elapsed.
  if (calibrationPending && millis() >= calibrationDueAt) {
    calibrationPending = false;
    runCalibration();
  }

  // Serial Monitor commands: CAL / WIPE / HELP (115200 baud, newline terminated)
  while (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.length()) handleCommand(cmd);
  }

  // Periodic NTP re-sync to prevent clock drift
  static unsigned long lastNtpSync = 0;
  if (wifiOk && millis() - lastNtpSync >= NTP_RESYNC_MS) {
    lastNtpSync = millis();
    struct tm t;
    if (getLocalTime(&t, NTP_TIMEOUT_MS)) {
      Serial.println("[INFO] NTP re-sync OK.");
    }
  }

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
  if (!ads1Ok && !ads2Ok) {
    Serial.println("[WARN] No ADC present — skipping calibration.");
    return;
  }

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

  // Sanity check: reject if any channel drifted >50% from stored baseline
  // (indicates dirty air during calibration, not a valid clean-air reference)
  {
    MQBaseline stored;
    File fCheck = LittleFS.open(BASELINE_FILE, "r");
    if (fCheck && fCheck.size() == sizeof(stored)) {
      fCheck.read((uint8_t *)&stored, sizeof(stored));
      fCheck.close();
      float checks[] = {
        fabs(baseline.mq135  - stored.mq135)  / (stored.mq135  + 0.001f),
        fabs(baseline.mq131  - stored.mq131)  / (stored.mq131  + 0.001f),
        fabs(baseline.mq136  - stored.mq136)  / (stored.mq136  + 0.001f),
        fabs(baseline.mq7    - stored.mq7)    / (stored.mq7    + 0.001f),
        fabs(baseline.mq8    - stored.mq8)    / (stored.mq8    + 0.001f),
        fabs(baseline.mics_nh3 - stored.mics_nh3) / (stored.mics_nh3 + 0.001f),
        fabs(baseline.mics_no2 - stored.mics_no2) / (stored.mics_no2 + 0.001f),
      };
      for (float d : checks) {
        if (d > 0.50f) {
          Serial.printf("[WARN] Baseline sanity FAILED (%.0f%% drift). Keeping old baseline.\n", d * 100);
          return;
        }
      }
      Serial.println("[INFO] Baseline sanity check passed.");
    }
  }

  File f = LittleFS.open(BASELINE_FILE, "w");
  if (f) {
    f.write((uint8_t *)&baseline, sizeof(baseline));
    f.close();
  }
  Serial.printf("[INFO] New baseline — nh3:%.3f no2:%.3f mq135:%.3f mq131:%.3f mq136:%.3f mq7:%.3f mq8:%.3f V\n",
                baseline.mics_nh3, baseline.mics_no2, baseline.mq135,
                baseline.mq131, baseline.mq136, baseline.mq7, baseline.mq8);
  Serial.println("[INFO] Calibration complete.");
}

// Schedule a baseline capture after a sensor-settle warm-up. Non-blocking:
// the main loop triggers runCalibration() once warmupMs elapses.
void requestCalibration(unsigned long warmupMs) {
  calibrationPending = true;
  calibrationDueAt = millis() + warmupMs;
}

// Serial Monitor commands (115200 baud, newline terminator):
//   CAL   — recalibrate gas baselines after a 10 min warm-up
//   WIPE  — delete the stored baseline and recalibrate after a 30 min warm-up
//   HELP  — print this list
void handleCommand(const String &cmd) {
  if (cmd == "CAL" || cmd == "cal") {
    Serial.printf("[INFO] Manual calibration scheduled after %lu ms warm-up.\n", (unsigned long)MANUAL_CAL_WARMUP_MS);
    requestCalibration(MANUAL_CAL_WARMUP_MS);
  } else if (cmd == "WIPE" || cmd == "wipe") {
    Serial.println("[INFO] Wiping stored baseline — recalibrating...");
    LittleFS.remove(BASELINE_FILE);
    requestCalibration(RECALIBRATION_WARMUP_MS);
  } else if (cmd == "HELP" || cmd == "help") {
    Serial.println("[CMD] CAL   — recalibrate gas baselines (10 min warm-up)");
    Serial.println("[CMD] WIPE  — delete baseline.dat and recalibrate (30 min warm-up)");
    Serial.println("[CMD] HELP  — this list");
  }
}

void loadBaselineFromFlash() {
  if (!LittleFS.exists(BASELINE_FILE)) return;
  File f = LittleFS.open(BASELINE_FILE, "r");
  if (!f || f.size() != sizeof(baseline)) { if (f) f.close(); return; }
  f.read((uint8_t *)&baseline, sizeof(baseline));
  f.close();
  Serial.println("[INFO] Loaded gas-sensor baseline from flash.");
}

void checkMidnightCalibration() {
  struct tm t;
  if (!getLocalTime(&t, NTP_TIMEOUT_MS)) return;

  if (t.tm_hour == RECALIBRATION_HOUR &&
      t.tm_min  == RECALIBRATION_MINUTE &&
      t.tm_mday != lastRecalDay) {
    lastRecalDay = t.tm_mday;
    if (!calibrationPending) {
      Serial.println("[INFO] Midnight calibration scheduled (warm-up)...");
      requestCalibration(MIDNIGHT_CAL_WARMUP_MS);
    }
  }
}

float rsRatio(float vNow, float vBaseline, float vc) {
  if (vBaseline <= 0.01 || vBaseline >= vc || vNow <= 0.01 || vNow >= vc) return NAN;
  float ratio = ((vc - vNow) * vBaseline) / (vNow * (vc - vBaseline));
  // Outside the datasheet curve's valid operating range the power-law fit
  // extrapolates to absurd values — treat as a sensor fault instead.
  if (ratio < RATIO_MIN || ratio > RATIO_MAX) return NAN;
  return ratio;
}

float estimatePPM(float vNow, float vBaseline, float a, float b, float vc) {
  float ratio = rsRatio(vNow, vBaseline, vc);
  if (isnan(ratio) || ratio <= 0) return -1;
  float ppm = a * pow(ratio, b);
  return ppm < 0 ? 0 : round(ppm * 10) / 10.0;
}

// ppm → µg/m³ at 25°C / 1 atm. Standard formula: mg/m³ = ppm·MW/24.45, so
// µg/m³ = ppm·MW·1000/24.45 (e.g. 1 ppm NO₂ ≈ 1881 µg/m³). mw <= 0 means a
// unitless proxy channel (e.g. MQ-135 air-quality index) — returned as-is.
float ppmToUgm3(float ppm, float mw) {
  if (mw <= 0) return ppm;
  return ppm * mw * 1000.0f / MOLAR_VOL_25C;
}

// Frozen-channel check. Warns once on the transition so the serial log stays
// readable while the channel keeps reporting FAULT.
bool isChannelStuck(GasCh ch, float vNow) {
  GasChanState &s = gasState[ch];
  if (isnan(s.lastVolt)) { s.lastVolt = vNow; return false; }
  bool frozen = fabs(vNow - s.lastVolt) <= STUCK_DEADBAND_V;
  s.lastVolt = vNow;
  if (frozen) {
    if (s.frozen < 255) s.frozen++;
    if (s.frozen == STUCK_SAMPLES) {
      Serial.printf("[WARN] Gas channel %d frozen at %.4f V — reporting FAULT\n", ch, vNow);
    }
    return s.frozen >= STUCK_SAMPLES;
  }
  s.frozen = 0;
  return false;
}

// One gas channel → µg/m³ (or raw proxy value), or -1 on any fault:
// unavailable ADC, ratio outside operating range, or a frozen channel.
float gasUgm3(float vNow, float vBaseline, float a, float b, float mw, GasCh ch) {
  if (isnan(vNow) || isnan(vBaseline)) return -1;
  if (isChannelStuck(ch, vNow)) return -1;
  float ppm = estimatePPM(vNow, vBaseline, a, b);
  if (ppm < 0) return -1;
  return ppmToUgm3(ppm, mw);
}

// =====================================================================
// Payload Builder & Exporter
// =====================================================================
String buildTelemetryJSON() {
  StaticJsonDocument<2048> doc;

  doc["device_id"]  = DEVICE_ID;
  doc["station_id"] = STATION_ID;

  struct tm t;
  char tsBuf[25] = "1970-01-01T00:00:00Z";
  if (getLocalTime(&t, NTP_TIMEOUT_MS)) {
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

  // Read each analog gas channel once per cycle; the voltage is reused for the
  // ppm estimate AND the diagnostics block below (calibration aid).
  float vNH3   = ads1Ok ? adsToVoltage(ads1, CH_NH3_MICS)   : NAN;
  float vNO2   = ads1Ok ? adsToVoltage(ads1, CH_NO2_MICS)   : NAN;
  float vMQ135 = ads1Ok ? adsToVoltage(ads1, CH_MQ135_AOUT) : NAN;
  float vMQ131 = ads1Ok ? adsToVoltage(ads1, CH_MQ131_AOUT) : NAN;
  float vMQ136 = ads2Ok ? adsToVoltage(ads2, CH_MQ136_AOUT) : NAN;
  float vMQ7   = ads2Ok ? adsToVoltage(ads2, CH_MQ7_AOUT)   : NAN;
  float vMQ8   = ads2Ok ? adsToVoltage(ads2, CH_MQ8_AOUT)   : NAN;

  // All gases are shipped in µg/m³ (backend units contract). -1 = fault.
  // MiCS-6814 CO (RED) pin is not connected on this PCB — always faulted.
  pollutants["co"]      = -1;
  pollutants["no2"]     = gasUgm3(vNO2,   baseline.mics_no2, GAS_A_NO2,   GAS_B_NO2,   MW_NO2, CH_NO2);
  pollutants["nh3"]     = gasUgm3(vNH3,   baseline.mics_nh3, GAS_A_NH3,   GAS_B_NH3,   MW_NH3, CH_NH3);
  pollutants["o3"]      = gasUgm3(vMQ131, baseline.mq131,    GAS_A_O3,    GAS_B_O3,    MW_O3,  CH_MQ131);
  pollutants["mq135"]   = gasUgm3(vMQ135, baseline.mq135,    GAS_A_MQ135, GAS_B_MQ135, 0.0f,   CH_MQ135); // unitless proxy
  pollutants["h2s"]     = gasUgm3(vMQ136, baseline.mq136,    GAS_A_H2S,   GAS_B_H2S,   MW_H2S, CH_MQ136);
  pollutants["h2"]      = gasUgm3(vMQ8,   baseline.mq8,      GAS_A_H2,    GAS_B_H2,    MW_H2,  CH_MQ8);
  pollutants["mq7_co"]  = gasUgm3(vMQ7,   baseline.mq7,      GAS_A_CO,    GAS_B_CO,    MW_CO,  CH_MQ7);

  // Raw gas resistance from BME680 (not a CO2 measurement)
  pollutants["voc_gas_ohm"] = readingOk ? bme.gas_resistance : 0;

  // Diagnostics for the calibration workflow: raw ADC voltages + baselines.
  // Consumed by GET /api/telemetry/raw; never used for AQI.
  JsonObject diag = doc.createNestedObject("diagnostics");
  JsonObject d1 = diag.createNestedObject("ads1_voltages");
  d1["nh3"]   = ads1Ok ? vNH3   : -1;
  d1["no2"]   = ads1Ok ? vNO2   : -1;
  d1["mq135"] = ads1Ok ? vMQ135 : -1;
  d1["mq131"] = ads1Ok ? vMQ131 : -1;
  JsonObject d2 = diag.createNestedObject("ads2_voltages");
  d2["mq136"] = ads2Ok ? vMQ136 : -1;
  d2["mq7"]   = ads2Ok ? vMQ7   : -1;
  d2["mq8"]   = ads2Ok ? vMQ8   : -1;
  JsonObject bl = diag.createNestedObject("baselines");
  bl["mics_nh3"] = baseline.mics_nh3;
  bl["mics_no2"] = baseline.mics_no2;
  bl["mq135"]    = baseline.mq135;
  bl["mq131"]    = baseline.mq131;
  bl["mq136"]    = baseline.mq136;
  bl["mq7"]      = baseline.mq7;
  bl["mq8"]      = baseline.mq8;

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