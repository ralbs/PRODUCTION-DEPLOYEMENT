const mongoose = require("mongoose");

// Every result this collection stores is a SCREENING estimate, never
// confirmed source attribution -- see PROMPT_FLOW_INTEGRATION.md. The
// label below is enforced verbatim by routes/source-direction.js
// regardless of what a caller sends, so it can never drift per-document.
const SOURCE_DIRECTION_LABEL = "estimated upwind direction -- screening only, not confirmed source attribution";

const sourceDirectionSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true }, // timestamp of the triggering telemetry reading
    station_id: { type: String, required: true, index: true }, // grouping/storage key ONLY -- never used for auth
    device_id: { type: String, required: true }, // the authenticated device identity (req.deviceId)

    trigger: {
      actual_aqi: { type: Number, required: true },
      predicted_aqi: { type: Number, required: true },
      predicted_low: { type: Number, required: true },
      predicted_high: { type: Number, required: true },
      sigma: { type: Number, required: true },
    },

    wind: {
      speed_m_s: Number,
      dir_from_deg: Number,
      station_id: String, // the REAL met station id the wind came from (e.g. "43245")
      as_of: Date, // end of the real wind window used (see met/ingest_real_met.py's disclosed staleness)
    },

    bearing_deg: { type: Number, required: true }, // direction FROM receptor TO the estimated upwind source region
    distance_m: { type: Number, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 }, // 1 - boundary_inflow_fraction
    boundary_inflow_fraction: { type: Number, required: true },

    n_particles: Number,
    seed: mongoose.Schema.Types.Mixed,

    label: { type: String, required: true, default: SOURCE_DIRECTION_LABEL },
  },
  { timestamps: { createdAt: "ingested_at", updatedAt: false } }
);

module.exports = mongoose.model("SourceDirection", sourceDirectionSchema);
module.exports.SOURCE_DIRECTION_LABEL = SOURCE_DIRECTION_LABEL;
