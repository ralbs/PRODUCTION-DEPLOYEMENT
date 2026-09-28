const mongoose = require("mongoose");

// The LAST run of a worker for one station -- one document per
// (worker, station_id), overwritten on every run, including skips.
//
// Why it exists: the source-direction worker used to leave no trace when it
// skipped, so on the dashboard "no spike this hour" and "spike detected but
// the wind fetch failed (provider_http_429)" looked identical -- the
// centerpiece feature could fail silently. This record is what lets the
// panel tell those apart.
const OUTCOMES = ["ingested", "skipped", "error"];

const workerRunSchema = new mongoose.Schema(
  {
    worker: { type: String, required: true, enum: ["source-direction"] },
    station_id: { type: String, required: true },
    device_id: { type: String, required: true }, // authenticated worker identity (req.deviceId), never from the body
    outcome: { type: String, required: true, enum: OUTCOMES },
    reason: { type: String, default: null }, // the worker's own skip/error text, e.g. "no spike"
    // Machine-readable cause when wind was the problem, e.g. "provider_http_429",
    // "window has no coverage" -- null for any skip that isn't about wind.
    wind_failure_reason: { type: String, default: null },
    // Whether the spike check fired, so "spike, but no estimate" never reads
    // like "no spike". null when the check itself couldn't run.
    spike_detected: { type: Boolean, default: null },
    spike_timestamp: { type: Date, default: null }, // the triggering reading, when a spike fired
    // The windowed spike rule's own numbers (lib/forecast.js checkSpike),
    // recorded whenever the check ran -- so a near-miss is visible too.
    spike_z: { type: Number, default: null },
    spike_jump_aqi: { type: Number, default: null },
    ran_at: { type: Date, required: true },
  },
  { timestamps: true },
);

workerRunSchema.index({ worker: 1, station_id: 1 }, { unique: true });

module.exports = mongoose.model("WorkerRun", workerRunSchema);
module.exports.OUTCOMES = OUTCOMES;
