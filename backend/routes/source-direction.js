const express = require("express");
const SourceDirection = require("../models/SourceDirection");
const WorkerRun = require("../models/WorkerRun");
const { WIND_SOURCE_TIERS, WIND_SOURCE_LABELS } = require("../lib/windSource");
const { authenticateDevice } = require("../middleware/auth");

const router = express.Router();

const REQUIRED_TOP = [
  "timestamp", "station_id", "trigger", "wind",
  "bearing_deg", "distance_m", "confidence", "boundary_inflow_fraction", "estimate_tier",
  "idempotency_key",
];

function validatePayload(body) {
  for (const field of REQUIRED_TOP) {
    if (!(field in body)) return `Missing required field: ${field}`;
  }
  const ts = new Date(body.timestamp);
  if (isNaN(ts.getTime())) return "timestamp is not a valid ISO date string";
  if (typeof body.station_id !== "string" || !body.station_id) return "station_id must be a non-empty string";
  if (typeof body.idempotency_key !== "string" || !body.idempotency_key) {
    return "idempotency_key must be a non-empty string";
  }
  // Explicit 400 here, same reasoning as estimate_tier's fix: wind.source_tier
  // is also `required: true` on the Mongoose schema, so without this check a
  // caller omitting/misspelling it would hit schema validation and get a 500
  // instead of this route's own 400.
  if (!body.wind || typeof body.wind !== "object" || !WIND_SOURCE_TIERS.includes(body.wind.source_tier)) {
    return `wind.source_tier must be one of: ${WIND_SOURCE_TIERS.join(", ")}`;
  }
  return null;
}

// -------------------------------------------------------------------
// POST /api/source-direction/ingest — called by
// scripts/source_direction_worker.py. Same auth pattern as
// routes/telemetry.js's POST /: authenticateDevice checks X-Device-Id /
// X-Device-Key against DEVICE_KEYS (device_id only -- station_id in the
// body is for grouping/storage, never for authentication).
// -------------------------------------------------------------------
router.post("/ingest", authenticateDevice, async (req, res) => {
  const body = req.body;

  const validationError = validatePayload(body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    // Upsert keyed on idempotency_key, NOT create(): the worker retries a
    // timed-out POST (see the 2026-09-21 cold-start/retry fix) with the
    // exact same key, so a resend must overwrite this same document rather
    // than insert a second one. The unique index on idempotency_key
    // (models/SourceDirection.js) is the actual dedup guarantee; this
    // upsert is what makes a resend land on it instead of erroring.
    const doc = await SourceDirection.findOneAndUpdate(
      { idempotency_key: body.idempotency_key },
      {
        $set: {
          timestamp: new Date(body.timestamp),
          station_id: body.station_id,
          device_id: req.deviceId, // from authenticateDevice, never trust the body for this
          idempotency_key: body.idempotency_key,
          trigger: body.trigger,
          wind: {
            ...body.wind,
            // source_label is deliberately NOT taken from the body -- server-enforced
            // from the validated source_tier, same "never trust caller prose" pattern
            // as the top-level label below.
            source_label: WIND_SOURCE_LABELS[body.wind.source_tier],
          },
          bearing_deg: body.bearing_deg,
          distance_m: body.distance_m,
          confidence: body.confidence,
          boundary_inflow_fraction: body.boundary_inflow_fraction,
          estimate_tier: body.estimate_tier,
          n_particles: body.n_particles,
          seed: body.seed,
          // label is deliberately NOT taken from body -- schema default enforces
          // the exact verbatim string regardless of what the caller sends.
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ status: "success", id: doc._id, label: doc.label });
  } catch (err) {
    console.error("[source-direction] insert failed:", err.message);
    res.status(500).json({ error: "Failed to store source-direction estimate" });
  }
});

// GET /api/source-direction/latest?station_id=NEL-001
router.get("/latest", async (req, res) => {
  const { station_id } = req.query;
  if (!station_id) return res.status(400).json({ error: "station_id query param required" });

  // Express 4 doesn't catch a rejected promise from an async handler -- without
  // this, a DB error leaves the request hanging instead of returning 500.
  try {
    const doc = await SourceDirection.findOne({ station_id }).sort({ timestamp: -1 }).lean();
    if (!doc) return res.status(404).json({ error: "No source-direction estimate found for this station" });
    res.json(doc);
  } catch (err) {
    console.error("[source-direction] latest lookup failed:", err.message);
    res.status(500).json({ error: "Failed to load source-direction estimate" });
  }
});

// -------------------------------------------------------------------
// Worker run records -- see models/WorkerRun.js for why these exist.
// -------------------------------------------------------------------
const MAX_REASON_LEN = 500;

function validateRun(body) {
  if (typeof body.station_id !== "string" || !body.station_id) return "station_id must be a non-empty string";
  if (!WorkerRun.OUTCOMES.includes(body.outcome)) return `outcome must be one of: ${WorkerRun.OUTCOMES.join(", ")}`;
  if (isNaN(new Date(body.ran_at).getTime())) return "ran_at is not a valid ISO date string";
  for (const f of ["reason", "wind_failure_reason"]) {
    if (body[f] != null && (typeof body[f] !== "string" || body[f].length > MAX_REASON_LEN)) {
      return `${f} must be a string of at most ${MAX_REASON_LEN} chars`;
    }
  }
  if (body.spike_detected != null && typeof body.spike_detected !== "boolean") return "spike_detected must be boolean or null";
  if (body.spike_timestamp != null && isNaN(new Date(body.spike_timestamp).getTime())) return "spike_timestamp is not a valid ISO date string";
  return null;
}

// POST /api/source-direction/runs -- the worker records EVERY run, skips
// included. Same device auth as /ingest: an open write here would let
// anyone forge "last run" status for a station.
router.post("/runs", authenticateDevice, async (req, res) => {
  const body = req.body || {};
  const err = validateRun(body);
  if (err) return res.status(400).json({ error: err });

  try {
    const doc = await WorkerRun.findOneAndUpdate(
      { worker: "source-direction", station_id: body.station_id },
      {
        $set: {
          worker: "source-direction",
          station_id: body.station_id,
          device_id: req.deviceId, // from auth, never the body
          outcome: body.outcome,
          reason: body.reason ?? null,
          wind_failure_reason: body.wind_failure_reason ?? null,
          spike_detected: body.spike_detected ?? null,
          spike_timestamp: body.spike_timestamp ? new Date(body.spike_timestamp) : null,
          ran_at: new Date(body.ran_at),
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
    res.status(201).json({ status: "success", id: doc._id });
  } catch (e) {
    console.error("[source-direction] run record failed:", e.message);
    res.status(500).json({ error: "Failed to store worker run record" });
  }
});

// GET /api/source-direction/last-run?station_id=NEL-001 -- auth-free read,
// same pattern as /latest, stations.js and forecast.js.
router.get("/last-run", async (req, res) => {
  const { station_id } = req.query;
  if (!station_id) return res.status(400).json({ error: "station_id query param required" });
  try {
    const doc = await WorkerRun.findOne({ worker: "source-direction", station_id }).lean();
    if (!doc) return res.status(404).json({ error: "No worker run recorded for this station" });
    res.json(doc);
  } catch (e) {
    console.error("[source-direction] last-run lookup failed:", e.message);
    res.status(500).json({ error: "Failed to load worker run record" });
  }
});

module.exports = router;
