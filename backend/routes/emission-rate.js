const express = require("express");
const EmissionRate = require("../models/EmissionRate");
const { authenticateDevice } = require("../middleware/auth");

const router = express.Router();

const REQUIRED_TOP = [
  "timestamp", "station_id", "species", "zone", "observations", "x_hat", "marginal_std",
];

function validatePayload(body) {
  for (const field of REQUIRED_TOP) {
    if (!(field in body)) return `Missing required field: ${field}`;
  }
  const ts = new Date(body.timestamp);
  if (isNaN(ts.getTime())) return "timestamp is not a valid ISO date string";
  if (typeof body.station_id !== "string" || !body.station_id) return "station_id must be a non-empty string";
  if (typeof body.marginal_std !== "number" || !(body.marginal_std >= 0)) {
    return "marginal_std must be a non-negative number -- an uncertainty-free estimate is never accepted";
  }
  return null;
}

// -------------------------------------------------------------------
// POST /api/emission-rate/ingest -- called by
// scripts/emission_rate_worker.py. Same auth pattern as
// routes/source-direction.js and routes/telemetry.js: authenticateDevice
// checks X-Device-Id / X-Device-Key against DEVICE_KEYS (device_id only
// -- station_id in the body is for grouping/storage, never auth).
// -------------------------------------------------------------------
router.post("/ingest", authenticateDevice, async (req, res) => {
  const body = req.body;

  const validationError = validatePayload(body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const doc = await EmissionRate.create({
      timestamp: new Date(body.timestamp),
      station_id: body.station_id,
      device_id: req.deviceId, // from auth, never trust the body for this
      species: body.species,
      zone: body.zone,
      observations: body.observations,
      x_hat: body.x_hat,
      marginal_std: body.marginal_std,
      chi2_per_obs: body.chi2_per_obs,
      fit_residuals: body.fit_residuals,
      species_advisory: body.species_advisory,
      // label is deliberately NOT taken from body -- schema default enforces it.
    });

    res.status(201).json({ status: "success", id: doc._id, label: doc.label });
  } catch (err) {
    console.error("[emission-rate] insert failed:", err.message);
    res.status(500).json({ error: "Failed to store emission-rate estimate" });
  }
});

// GET /api/emission-rate/latest?station_id=NEL-001
router.get("/latest", async (req, res) => {
  const { station_id } = req.query;
  if (!station_id) return res.status(400).json({ error: "station_id query param required" });

  // Express 4 doesn't catch a rejected promise from an async handler -- without
  // this, a DB error leaves the request hanging instead of returning 500.
  try {
    const doc = await EmissionRate.findOne({ station_id }).sort({ timestamp: -1 }).lean();
    if (!doc) return res.status(404).json({ error: "No emission-rate estimate found for this station" });
    res.json(doc);
  } catch (err) {
    console.error("[emission-rate] latest lookup failed:", err.message);
    res.status(500).json({ error: "Failed to load emission-rate estimate" });
  }
});

module.exports = router;
