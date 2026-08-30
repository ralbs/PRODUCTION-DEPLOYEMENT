/*
 * prepare.js — the single read-path pipeline for pollutants.
 *
 * Order matters:
 *   1. applyCalibration()  — overwrite firmware gas placeholders with any stored
 *                            per-device calibration (recomputed from raw
 *                            diagnostics voltage + baseline).
 *   2. sanitizePollutants()— null disabled/faulted/out-of-range channels.
 *
 * No unit conversion happens here: the firmware already ships every gas
 * channel in µg/m³ (and mq135 as a unitless proxy, voc_gas_ohm in Ω), which is
 * exactly the units contract the AQI and dashboard expect. Storage and reads
 * are µg/m³ end-to-end.
 *
 * Every read path (REST telemetry, REST aqi, GraphQL) must use this helper so
 * the dashboard and AQI always see the same, corrected values.
 */

const { sanitizePollutants } = require("./aqi");
const { applyCalibration } = require("./gasCal");

async function preparePollutants(pollutants, diagnostics, deviceId) {
  const calibrated = await applyCalibration(pollutants, diagnostics, deviceId);
  return sanitizePollutants(calibrated);
}

/**
 * Display variant: returns the calibrated pollutants WITHOUT sanity/trust
 * filtering so the dashboard can show every channel (even faulted or
 * out-of-range ones, which the frontend renders as "–"). The AQI is always
 * computed from preparePollutants()' filtered subset.
 */
async function prepareDisplayPollutants(pollutants, diagnostics, deviceId) {
  const calibrated = await applyCalibration(pollutants, diagnostics, deviceId);
  return calibrated;
}

module.exports = { preparePollutants, prepareDisplayPollutants };
