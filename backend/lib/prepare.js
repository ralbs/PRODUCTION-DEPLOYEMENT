/*
 * prepare.js — the single read-path pipeline for pollutants.
 *
 * Order matters:
 *   1. applyCalibration()   — overwrite firmware gas placeholders with any stored
 *                             per-device calibration (recomputed from raw
 *                             diagnostics voltage + baseline).
 *   2. normalizeGasUnits()  — the board ships gas channels in ppm; convert to
 *                             µg/m³ so downstream always honors the units
 *                             contract (the dashboard and AQI are µg/m³-only).
 *   3. sanitizePollutants() — null disabled/faulted/out-of-range channels and
 *                             every gas channel not in TRUSTED_GAS_CHANNELS.
 *
 * Every read path (REST telemetry, REST aqi, GraphQL) must use this helper so
 * the dashboard and AQI always see the same, corrected, trusted values.
 */

const { sanitizePollutants } = require("./aqi");
const { applyCalibration } = require("./gasCal");

// ppm -> µg/m³ at 25 °C, 1 atm: µg/m³ = ppm × (MW × 1000) / 24.45.
// Only the gas channels that actually come from the ADC in ppm are listed.
// PM (µg/m³) and voc_gas_ohm (Ω) are untouched. mq135 has no single species;
// it's the firmware's uncalibrated VOC/air-quality proxy, so use toluene as a
// representative VOC for the display-conversion only.
const PPM_TO_UGM3 = {
  co:     28.01 * 1000 / 24.45, // ≈ 1145.63
  mq7_co: 28.01 * 1000 / 24.45, // ≈ 1145.63
  no2:    46.01 * 1000 / 24.45, // ≈ 1881.80
  o3:     48.00 * 1000 / 24.45, // ≈ 1963.19
  nh3:    17.03 * 1000 / 24.45, // ≈  696.52
  h2s:    34.08 * 1000 / 24.45, // ≈ 1393.87
  h2:      2.02 * 1000 / 24.45, // ≈   82.62
  mq135:  92.14 * 1000 / 24.45, // ≈ 3768.51 (toluene proxy)
};

function normalizeGasUnits(pollutants) {
  if (!pollutants || typeof pollutants !== "object") return pollutants || {};
  const out = { ...pollutants };
  for (const key of Object.keys(PPM_TO_UGM3)) {
    const v = out[key];
    if (typeof v !== "number" || !isFinite(v) || v <= 0) continue; // -1 sentinel / disabled
    out[key] = +(v * PPM_TO_UGM3[key]).toFixed(2);
  }
  return out;
}

async function preparePollutants(pollutants, diagnostics, deviceId) {
  const calibrated = await applyCalibration(pollutants, diagnostics, deviceId);
  return sanitizePollutants(normalizeGasUnits(calibrated));
}

module.exports = { preparePollutants, normalizeGasUnits };
