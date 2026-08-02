# AQMS Firmware

Firmware for the `AQMS_CRPF_PCB` board (ESP32-WROOM-32 + MQ-135/131/136/7/8 +
MICS-6814 + BME680 + PMS5003 + SIM800C), built against your telemetry schema.

## Files
- `AQMS_Firmware.ino` — all sensor reading, JSON building, calibration, and networking logic
- `config.h` — every pin assignment, credential, and tunable constant (this is the only file you should normally need to edit)

## Libraries (Arduino Library Manager)
- ArduinoJson (v6.x)
- Adafruit ADS1X15
- Adafruit BME680
- Adafruit Unified Sensor
- TinyGSM

Board package: `esp32` by Espressif (tested against the WROOM-32 core).

## Before you flash: verify the pin map
The schematic PDF's net labels for a few connections (`RX_PMS`/`TX_PMS`,
`RX_ESP`/`TX_ESP`, and the individual `MQ-xxx_Dout` lines) didn't carry
legible pin-number callouts in the export, so `config.h` uses a
conflict-free but *assumed* GPIO assignment. Do a continuity check against
the physical board (or your `.kicad_pcb`) and correct the `#define`s at the
top of `config.h` if anything differs — nothing else in the firmware
depends on which physical pin a signal lands on.

Two schema fields also don't map 1:1 to the hardware as drawn:
- **`co2`** — there's no dedicated CO2 sensor on this board. The firmware
  derives a rough estimate from the BME680's gas resistance (VOC proxy),
  which is *not* a certified ppm reading. For real CO2 data, add an NDIR
  sensor (MH-Z19, SCD30, etc.) and read it directly — swap in that value
  where `estimateCO2FromGasResistance()` is called.
- **`health`** — the board uses a BME680, not a DHT22. The firmware reports
  the BME680's read status under `health.bme680` (along with `mq_ads1`,
  `mq_ads2`, `pms5003`), so the health fields are `"OK"` or `"FAULT"`.

## How calibration works
MQ- and MICS-series sensors output a voltage, not a ppm value — you need a
clean-air baseline (R0) to compare against, run through each gas's
datasheet Rs/Ro-vs-ppm curve.

- On first boot (no stored baseline), the firmware warms up for
  `RECALIBRATION_WARMUP_MS` (default 60s — MQ sensors typically want much
  longer, 24–48h, for a *true* first calibration; treat the first day's
  ppm numbers as provisional) then captures a baseline.
- Every night at `RECALIBRATION_HOUR:RECALIBRATION_MINUTE` (default
  00:00 local time, via NTP), it re-samples `RECALIBRATION_SAMPLES`
  readings per sensor and stores the new baseline to LittleFS, so a reboot
  right after midnight won't lose that day's calibration.
- The voltage→ppm conversion in `estimatePPM()` uses each gas's datasheet
  log-linear curve; every gas channel is shipped in **µg/m³** (the backend's
  units contract) via `ppmToUgm3()` using the molar masses in `config.h`.
- A channel is reported as `-1` (fault) when its ADC is unavailable, its
  `Rs/Ro` ratio falls outside `RATIO_MIN..RATIO_MAX` (curve out of range), or
  its raw voltage stays within `STUCK_DEADBAND_V` for `STUCK_SAMPLES`
  consecutive minutes (frozen ADC — dead sensor / open trace).
- Every payload also carries a `diagnostics` block (raw ADC voltages per
  channel + stored baselines) to be consumed via the backend's
  `GET /api/telemetry/raw` — never used for AQI. Use it to confirm channels
  actually move before trusting a calibrated curve.

## Connectivity & offline buffering
WiFi is primary; if it's unreachable at boot or a send fails, the firmware
brings up the SIM800C over GPRS as a fallback. If both are down, telemetry
is appended to `/buffer.jsonl` on LittleFS and flushed (with `delayed`
flipped to `true`) as soon as a connection is available again.

## Server endpoint
Set `SERVER_URL` (WiFi/HTTPS path) and `SERVER_HOST`/`SERVER_PORT`/`SERVER_PATH`
(GPRS path) in `config.h` to point at your ingestion API.
