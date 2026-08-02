/*
 * prepare.js — the single read-path pipeline for pollutants.
 *
 * Order matters:
 *   1. applyCalibration()  — overwrite firmware gas placeholders with any stored
 *                            per-device calibration (recomputed from raw
 *                            diagnostics voltage + baseline).
 *   2. sanitizePollutants()— null disabled/faulted/out-of-range channels and
 *                            every gas channel not in TRUSTED_GAS_CHANNELS.
 *
 * Every read path (REST telemetry, REST aqi, GraphQL) must use this helper so
 * the dashboard and AQI always see the same, corrected, trusted values.
 */

const { sanitizePollutants } = require("./aqi");
const { applyCalibration } = require("./gasCal");

async function preparePollutants(pollutants, diagnostics, deviceId) {
  const calibrated = await applyCalibration(pollutants, diagnostics, deviceId);
  return sanitizePollutants(calibrated);
}

module.exports = { preparePollutants };
