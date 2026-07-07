#pragma once
/*
 * AQMS_CRPF_PCB — pin map & constants
 *
 * IMPORTANT: several nets in the uploaded schematic (RX_PMS/TX_PMS,
 * RX_ESP/TX_ESP, the individual MQ-xxx_Dout lines) could not be tied to
 * exact GPIO numbers from the PDF alone — the labels are there but the
 * pin-number callouts on those specific nets were not legible/consistent
 * in the export. The values below are a reasonable, conflict-free
 * assignment on the free ESP32-WROOM-32 GPIOs. Before flashing hardware,
 * verify each of these against a continuity check on the physical board
 * (or the .kicad_pcb / netlist if you have it) and correct here — nothing
 * else in the firmware needs to change.
 */

// ============ Identity ============
#define DEVICE_ID       "ESP32-001"
#define STATION_ID      "NEL-001"
#define STATION_LAT      14.442
#define STATION_LON      79.986

// ============ I2C bus: BME680 + 2x ADS1115 ============
#define I2C_SDA_PIN      21
#define I2C_SCL_PIN      22
#define ADS1115_ADDR_1   0x48   // MQ-7, MQ-8, MQ-135, MQ-131 analog outs
#define ADS1115_ADDR_2   0x49   // MQ-136 analog out + MICS-6814 CO/NH3/NO2
#define BME680_ADDR      0x76

// ============ MQ sensor digital (threshold) outputs ============
#define MQ135_DOUT_PIN   4
#define MQ136_DOUT_PIN   5
#define MQ131_DOUT_PIN   18
#define MQ8_DOUT_PIN     19
#define MQ7_DOUT_PIN     23

// ============ ADS1115 #1 (0x48) channel map ============
#define CH_MQ7_AOUT      0
#define CH_MQ8_AOUT      1
#define CH_MQ135_AOUT    2
#define CH_MQ131_AOUT    3   // O3 sensor per schematic note

// ============ ADS1115 #2 (0x49) channel map ============
#define CH_MQ136_AOUT    0
#define CH_MICS_CO       1
#define CH_MICS_NH3      2
#define CH_MICS_NO2      3

// ============ PMS5003 — Serial1 ============
#define PMS_RX_PIN       16   // ESP32 RX <- PMS5003 TX
#define PMS_TX_PIN       17   // ESP32 TX -> PMS5003 RX

// ============ SIM800C — Serial2 ============
#define GSM_RX_PIN       26
#define GSM_TX_PIN       27
#define GSM_PWRKEY_PIN   25

// ============ Battery sense ============
// Schematic shows VBat Filter + RPS_OP net but no explicit divider into an
// ESP32 ADC pin. Add a 100k/100k (or similar) divider from VBAT to this pin
// and set VBAT_DIVIDER_RATIO to match.
#define VBAT_ADC_PIN         34
#define VBAT_DIVIDER_RATIO   2.0f
#define VBAT_FULL            4.2f
#define VBAT_EMPTY           3.3f

// ============ Timing ============
#define TELEMETRY_INTERVAL_MS     60000UL   // 1 minute
#define RECALIBRATION_HOUR        0          // 12 AM local time
#define RECALIBRATION_MINUTE      0
#define RECALIBRATION_WARMUP_MS   60000UL    // sensor settle time before first baseline
#define RECALIBRATION_SAMPLES     30

// ============ NTP ============
#define NTP_SERVER            "pool.ntp.org"
#define GMT_OFFSET_SEC         19800   // IST +5:30
#define DAYLIGHT_OFFSET_SEC    0

// ============ WiFi (primary uplink — leave blank if SIM-only) ============
// If WiFi fails after 10 s the firmware automatically falls back to SIM800C.
// Set to a non-existent SSID if you want to skip WiFi entirely.
#define WIFI_SSID         "NO_WIFI"
#define WIFI_PASSWORD     ""
// WiFi HTTP client uses this full URL (only reached if WiFi connects)
#define SERVER_URL        "http://your-server.example.com/api/telemetry"

// Must match one "device_id:key" pair in the backend's DEVICE_KEYS env var
#define DEVICE_API_KEY    "change-this-to-a-long-random-string"

// ============ SIM800C — primary data path ============
// APN for common Indian operators:
//   Airtel  →  airtelgprs.com
//   Jio     →  jionet
//   BSNL    →  bsnlnet
//   Vi      →  www
//   Aircel  →  aircelgprs
#define GPRS_APN          "airtelgprs.com"   // ← change to your operator
#define GPRS_USER         ""
#define GPRS_PASS         ""

// Public backend address — SIM connects over the internet, NOT LAN.
// Deploy the backend (Render / Railway / VPS) and put its domain here.
#define SERVER_HOST       "your-server.example.com"
#define SERVER_PORT       80                         // 443 if HTTPS
#define SERVER_PATH       "/api/telemetry"

// ============ Offline buffering (LittleFS) ============
#define OFFLINE_BUFFER_FILE   "/buffer.jsonl"
