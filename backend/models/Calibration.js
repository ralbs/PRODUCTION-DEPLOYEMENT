const mongoose = require("mongoose");

/*
 * Per-device, per-channel gas calibration curves.
 *
 * The MQ-7 CO channel is calibrated against the KSPCB reference data seeded in
 * the telemetries collection (see backend/scripts/fit-co.js). The fit is a
 * log-log power law:  ppm = a * ratio^b  where `ratio` is the sensor's Rs/Ro
 * derived from the raw ADC voltage + baseline that the firmware reports in its
 * `diagnostics` block.
 *
 * A calibration document only exists once a fit passes its acceptance bar
 * (R², sample size, physically-sane exponent). Reads that find one replace the
 * firmware's datasheet placeholder for that channel with the fitted value.
 * Until a channel appears in TRUSTED_GAS_CHANNELS (env) it is still nulled by
 * sanitizePollutants(), so storing a Calibration never forces it into the AQI.
 */
const calibrationSchema = new mongoose.Schema(
  {
    device_id: { type: String, required: true },
    channel:   { type: String, required: true },   // e.g. "mq7_co"

    model: {
      a: { type: Number, required: true },          // ppm = a * ratio^b
      b: { type: Number, required: true },
    },

    // Ratios outside this window are treated as uncalibrated (null), so the
    // power-law is never extrapolated beyond the data it was fit on.
    validRatioMin: { type: Number, required: true },
    validRatioMax: { type: Number, required: true },

    metrics: {
      r2:  { type: Number },                        // log-log R²
      mae: { type: Number },                        // mean abs error, µg/m³
      n:   { type: Number },                        // points used in the fit
    },

    fittedAt: { type: Date, default: Date.now },
  },
  { collection: "calibrations" }
);

calibrationSchema.index({ device_id: 1, channel: 1 });

module.exports = mongoose.model("Calibration", calibrationSchema);
