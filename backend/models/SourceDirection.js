const mongoose = require("mongoose");
const { WIND_SOURCE_TIERS, WIND_SOURCE_LABELS } = require("../lib/windSource");

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

    // Deterministic hash of (station_id, timestamp) computed by the worker
    // (see ctm-core/scripts/source_direction_worker.py's make_idempotency_key()).
    // The unique index is what makes routes/source-direction.js's upsert
    // safe: a retried POST after a read-timeout (see the 2026-09-21
    // cold-start/retry fix) carries the SAME key, so it overwrites the same
    // document instead of inserting a duplicate.
    idempotency_key: { type: String, required: true, unique: true },

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
      station_id: String, // the REAL met station id the wind came from (e.g. "43245", or "open-meteo-live-nowcast")
      as_of: Date, // end of the real wind window used (see met/ingest_real_met.py's disclosed staleness)
      source_tier: { type: String, enum: WIND_SOURCE_TIERS, required: true },
      // Server-enforced from source_tier via lib/windSource.js's
      // WIND_SOURCE_LABELS, never taken from the request body -- see
      // that module's docstring.
      source_label: { type: String, required: true },
    },

    bearing_deg: { type: Number, required: true }, // direction FROM receptor TO the estimated upwind source region
    // NOT required: a boundary_sector_fallback estimate (see estimate_tier)
    // gives a direction but genuinely no distance -- null here, never a
    // fabricated number, distinct from a value that happens to be 0.
    distance_m: { type: Number, default: null },
    confidence: { type: Number, required: true, min: 0, max: 1 }, // interior: 1-boundary_inflow_fraction; boundary fallback: sector concentration
    boundary_inflow_fraction: { type: Number, required: true },

    // "interior" (probability-weighted centroid, real distance) or
    // "boundary_sector_fallback" (dominant compass sector only, no
    // distance) -- see attribution/adjoint.py's boundary_exit_by_sector
    // and scripts/source_direction_worker.py's run_adjoint_tracer().
    estimate_tier: { type: String, enum: ["interior", "boundary_sector_fallback"], required: true },

    n_particles: Number,
    seed: mongoose.Schema.Types.Mixed,

    label: { type: String, required: true, default: SOURCE_DIRECTION_LABEL },
  },
  { timestamps: { createdAt: "ingested_at", updatedAt: false } }
);

module.exports = mongoose.model("SourceDirection", sourceDirectionSchema);
module.exports.SOURCE_DIRECTION_LABEL = SOURCE_DIRECTION_LABEL;
module.exports.WIND_SOURCE_TIERS = WIND_SOURCE_TIERS;
module.exports.WIND_SOURCE_LABELS = WIND_SOURCE_LABELS;
