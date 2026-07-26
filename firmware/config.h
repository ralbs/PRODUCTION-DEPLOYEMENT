#pragma once
/*
 * AQMS_CRPF_PCB — pin map & constants
 * Board: ESP32-WROOM-32
 */

// ============ Identity ============
#define DEVICE_ID         "ESP32-001"
#define STATION_ID        "NEL-001"
#define STATION_LAT       14.442
#define STATION_LON       79.986

// ============ I2C bus: BME680 + 2x ADS1115 ============
#define I2C_SDA_PIN       21
#define I2C_SCL_PIN       22
#define ADS1115_ADDR_1    0x48   // NH3, NO2, MQ-135, MQ-131
#define ADS1115_ADDR_2    0x49   // MQ-136, MQ-7, MQ-8
#define BME680_ADDR       0x77

// ============ MQ sensor digital (threshold) outputs ============
#define MQ135_DOUT_PIN    34
#define MQ136_DOUT_PIN    13
#define MQ131_DOUT_PIN    35
#define MQ8_DOUT_PIN      33
#define MQ7_DOUT_PIN      32

// ============ ADS1115 #1 (0x48) channel map ============
#define CH_NH3_MICS       0   // NH3 from MiCS-6814
#define CH_NO2_MICS       1   // NO2 from MiCS-6814
#define CH_MQ135_AOUT     2   // MQ-135
#define CH_MQ131_AOUT     3   // MQ-131 (O3)

// ============ ADS1115 #2 (0x49) channel map ============
#define CH_MQ136_AOUT     0   // MQ-136 (H2S)
#define CH_MQ7_AOUT       1   // MQ-7 (CO)
#define CH_MQ8_AOUT       2   // MQ-8 (H2)
// AIN3: unconnected

// ============ PMS5003 — Serial1 ============
#define PMS_RX_PIN        25   // ESP32 RX <- PMS5003 TX
#define PMS_TX_PIN        26   // ESP32 TX -> PMS5003 RX

// ============ SIM800C — Serial2 ============
#define GSM_RX_PIN        16   // ESP32 RX <- SIM800C TX
#define GSM_TX_PIN        17   // ESP32 TX -> SIM800C RX
#define GSM_PWRKEY_PIN    27   // SIM800C PWRKEY

// ============ Timing ============
#define TELEMETRY_INTERVAL_MS     60000UL   // 1 minute
#define RECALIBRATION_HOUR        0         // 12 AM local time
#define RECALIBRATION_MINUTE      0
#define RECALIBRATION_WARMUP_MS   60000UL    // sensor settle time before first baseline
#define RECALIBRATION_SAMPLES     30

// ============ NTP ============
#define NTP_SERVER            "pool.ntp.org"
#define GMT_OFFSET_SEC         19800   // IST +5:30
#define DAYLIGHT_OFFSET_SEC    0

// ============ WiFi Config ============
#define WIFI_SSID         "Vinni"
#define WIFI_PASSWORD     "vinay123"
#define SERVER_URL        "https://aqms-dedk.onrender.com/api/telemetry"
#define DEVICE_API_KEY    "AQMI-DEVICE-01"

// ============ SIM800C GPRS Config ============
#define GPRS_APN          "airtelgprs.com"
#define GPRS_USER         ""
#define GPRS_PASS         ""

#define SERVER_HOST       "aqms-dedk.onrender.com"
#define SERVER_PORT       443
#define SERVER_PATH       "/api/telemetry"

// ============ Offline buffering ============
#define OFFLINE_BUFFER_FILE   "/buffer.jsonl"