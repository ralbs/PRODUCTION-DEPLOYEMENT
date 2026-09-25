const mongoose = require("mongoose");

// Single-zone emission-rate (Q) estimate -- see PROMPT_FLOW_INTEGRATION.md,
// Phase I4. Screening-grade, same posture as SourceDirection: a point
// estimate ALONE is never stored/returned without its real posterior
// uncertainty (marginal_std) alongside it.
const emissionRateSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true }, // end of the 2-hour observation window
    station_id: { type: String, required: true, index: true }, // grouping/storage key ONLY -- never used for auth
    device_id: { type: String, required: true }, // the authenticated device identity (req.deviceId)

    species: { type: String, required: true },

    zone: {
      name: { type: String, required: true },
      lat: { type: Number, required: true },
      lon: { type: Number, required: true },
      distance_from_sensor_m: { type: Number, required: true },
    },

    observations: [
      {
        time_index: Number,
        timestamp: Date,
        enhancement: Number, // real telemetry reading minus the city config's background_conc
      },
    ],

    x_hat: { type: Number, required: true }, // point estimate, species rate-unit / m^2 / s
    marginal_std: { type: Number, required: true }, // real posterior std -- never omitted
    chi2_per_obs: Number,
    fit_residuals: [Number],

    species_advisory: {
      quasi_conservative: Boolean,
      half_life_s: Number,
      transit_time_s: Number,
      message: String,
    },

    label: {
      type: String,
      required: true,
      default: "estimated single-zone emission rate -- screening only, not a validated emission-inventory number",
    },
  },
  { timestamps: { createdAt: "ingested_at", updatedAt: false } }
);

module.exports = mongoose.model("EmissionRate", emissionRateSchema);
