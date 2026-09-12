const express = require("express");
const SourceDirection = require("../models/SourceDirection");
const { authenticateDevice } = require("../middleware/auth");

const router = express.Router();

const REQUIRED_TOP = [
  "timestamp", "station_id", "trigger", "wind",
  "bearing_deg", "distance_m", "confidence", "boundary_inflow_fraction", "estimate_tier",
];

function validatePayload(body) {
  for (const field of REQUIRED_TOP) {
    if (!(field in body)) return `Missing required field: ${field}`;
  }
  const ts = new Date(body.timestamp);
  if (isNaN(ts.getTime())) return "timestamp is not a valid ISO date string";
  if (typeof body.station_id !== "string" || !body.station_id) return "station_id must be a non-empty string";
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
    const doc = await SourceDirection.create({
      timestamp: new Date(body.timestamp),
      station_id: body.station_id,
      device_id: req.deviceId, // from authenticateDevice, never trust the body for this
      trigger: body.trigger,
      wind: body.wind,
      bearing_deg: body.bearing_deg,
      distance_m: body.distance_m,
      confidence: body.confidence,
      boundary_inflow_fraction: body.boundary_inflow_fraction,
      estimate_tier: body.estimate_tier,
      n_particles: body.n_particles,
      seed: body.seed,
      // label is deliberately NOT taken from body -- schema default enforces
      // the exact verbatim string regardless of what the caller sends.
    });

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

  const doc = await SourceDirection.findOne({ station_id }).sort({ timestamp: -1 }).lean();
  if (!doc) return res.status(404).json({ error: "No source-direction estimate found for this station" });
  res.json(doc);
});

module.exports = router;
