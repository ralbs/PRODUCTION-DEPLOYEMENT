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

// ============ Gas curve constants: ppm = a * (Rs/RO)^b ============
// Datasheet curve fits. NO2 is positive exponent (oxidizing gas).
#define GAS_VC             5.0f
#define GAS_A_NH3          102.2f
#define GAS_B_NH3          -1.673f
#define GAS_A_NO2          1.007f
#define GAS_B_NO2          0.489f
#define GAS_A_O3           23.943f
#define GAS_B_O3           -1.11f
#define GAS_A_MQ135        102.2f
#define GAS_B_MQ135        -2.473f
#define GAS_A_H2S          127.4f
#define GAS_B_H2S          -2.862f
#define GAS_A_H2           976.97f
#define GAS_B_H2           -0.688f
#define GAS_A_CO           99.042f
#define GAS_B_CO           -1.518f

// ============ Gas units & sanity guards ============
// The telemetry API units contract: gases are stored in µg/m³. The firmware
// converts ppm → µg/m³ using the molar volume at 25°C / 1 atm (24.45 L/mol).
#define MOLAR_VOL_25C      24.45f
#define MW_NH3             17.031f
#define MW_NO2             46.0055f
#define MW_O3              48.00f
#define MW_H2S             34.08f
#define MW_H2              2.016f
#define MW_CO              28.01f

// rsRatio operating-range clamp. The log-log datasheet fits are only defined
// over a bounded Rs/RO range; outside it the power-law extrapolates to absurd
// values (that is what produced O3 ~11,000 and NH3 ~740,000). Out-of-range
// ratios are treated as a sensor fault (-1).
#define RATIO_MIN          0.02f
#define RATIO_MAX          20.0f

// Stuck-channel detection: a gas channel whose raw ADC voltage stays within
// STUCK_DEADBAND_V across STUCK_SAMPLES consecutive minute-readings is frozen
// (dead sensor / broken ADC path) and reported as FAULT instead of a constant
// fake reading.
#define STUCK_DEADBAND_V   0.001f
#define STUCK_SAMPLES      5

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
// Sensor settle time before capturing a baseline. First boot has no stored
// baseline, so its warm-up runs non-blocking (telemetry keeps flowing) for
// RECALIBRATION_WARMUP_MS. MQ/MiCS sensors need a long settle — this is a
// minimum; prefer the serial "CAL" command in known-clean air.
#define RECALIBRATION_WARMUP_MS   1800000UL // 30 min, first boot / WIPE
#define MANUAL_CAL_WARMUP_MS      600000UL  // 10 min, serial "CAL"
#define MIDNIGHT_CAL_WARMUP_MS    60000UL   // 1 min, sensors already hot at 00:00
#define RECALIBRATION_SAMPLES     30

// ============ NTP ============
#define NTP_SERVER            "pool.ntp.org"
#define GMT_OFFSET_SEC         19800   // IST +5:30
#define DAYLIGHT_OFFSET_SEC    0
#define NTP_TIMEOUT_MS         5000    // getLocalTime() wait (ms)
#define NTP_RESYNC_MS          21600000UL  // re-sync every 6 hours

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
#define BASELINE_FILE         "/baseline.dat"