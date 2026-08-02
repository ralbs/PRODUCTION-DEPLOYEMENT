const express = require("express");
const rateLimit = require("express-rate-limit");
const Telemetry = require("../models/Telemetry");
const { authenticateDevice } = require("../middleware/auth");
const { calculateAQI, sanitizePollutants } = require("../lib/aqi");
const { forwardToThingSpeak } = require("../lib/thingspeak");

const router = express.Router();

// Device ingest gets its own, tighter rate limit — one station posting every
// minute is nowhere near this ceiling, but it blocks a compromised or
// misbehaving device from hammering the DB. Scoped to POST only so it never
// throttles the dashboard's GET /latest and GET /history reads.
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// Fields required in every payload — mirrors the ESP32 firmware's JSON schema.
const REQUIRED_TOP = ["device_id", "station_id", "timestamp", "pollutants"];

function validatePayload(body) {
  for (const field of REQUIRED_TOP) {
    if (!(field in body)) return `Missing required field: ${field}`;
  }
  if (body.device_id !== undefined && typeof body.device_id !== "string") {
    return "device_id must be a string";
  }
  const ts = new Date(body.timestamp);
  if (isNaN(ts.getTime())) return "timestamp is not a valid ISO date string";
  return null;
}

/**
 * Scan the device `health` object for any "FAULT" flags.
 * Returns { hasFault, faulty } where `faulty` is the list of failing channels.
 */
function checkHealthFaults(health) {
  if (!health || typeof health !== "object") return { hasFault: false, faulty: [] };
  const faulty = Object.entries(health)
    .filter(([, v]) => String(v).toUpperCase() === "FAULT")
    .map(([k]) => k);
  return { hasFault: faulty.length > 0, faulty };
}

// -------------------------------------------------------------------
// POST /api/telemetry — called by the ESP32 station
// -------------------------------------------------------------------
router.post("/", ingestLimiter, authenticateDevice, async (req, res) => {
  const body = req.body;

  const validationError = validatePayload(body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  if (body.device_id !== req.deviceId) {
    return res.status(403).json({ error: "device_id does not match authenticated device" });
  }

  // Sensor faults are stored as null (never -1), so downstream metrics and
  // aggregations never see the firmware's sentinel values.
  const pollutants = sanitizePollutants(body.pollutants);

  // Health alert flag: surface FAULT channels in the response + console so the
  // ESP32 can log it and ops can spot a failing sensor immediately.
  const alert = checkHealthFaults(body.health);
  if (alert.hasFault) {
    console.warn(`[telemetry] HEALTH FAULT ${body.device_id}: ${alert.faulty.join(", ")}`);
  }

  try {
    const doc = await Telemetry.create({
      timestamp: new Date(body.timestamp),
      meta: {
        device_id: body.device_id,
        station_id: body.station_id,
      },
      location: body.location,
      weather: body.weather,
      pollutants,
      battery: body.battery,
      signal: body.signal,
      health: body.health,
      flags: body.flags,
    });

    // Fire-and-forget live republish — ingestion succeeds even if either sink is down.
    req.app.get("mqttPublish")?.(body.station_id, body);
    forwardToThingSpeak(pollutants, body.weather, calculateAQI(pollutants)?.aqi);

    res.status(201).json({ status: "success", id: doc._id, alert });
  } catch (err) {
    console.error("[telemetry] insert failed:", err.message);
    res.status(500).json({ error: "Failed to store telemetry" });
  }
});

// -------------------------------------------------------------------
// GET /api/telemetry/latest?device_id=ESP32-001   (also accepts station_id)
// -------------------------------------------------------------------
router.get("/latest", async (req, res) => {
  const { device_id, station_id } = req.query;
  const idField = device_id ? "meta.device_id" : "meta.station_id";
  const idValue = device_id || station_id;
  if (!idValue) {
    return res.status(400).json({ error: "device_id (or station_id) query param required" });
  }

  const doc = await Telemetry.findOne({ [idField]: idValue })
    .sort({ timestamp: -1 })
    .lean();

  if (!doc) return res.status(404).json({ error: "No telemetry found for this device" });
  res.json({ ...doc, pollutants: sanitizePollutants(doc.pollutants), aqi: calculateAQI(doc.pollutants) });
});

// -------------------------------------------------------------------
// GET /api/telemetry/history?device_id=...&from=...&to=...&limit=500
// -------------------------------------------------------------------
router.get("/history", async (req, res) => {
  const { device_id, station_id, from, to, limit = 500 } = req.query;
  const idField = device_id ? "meta.device_id" : "meta.station_id";
  const idValue = device_id || station_id;
  if (!idValue) {
    return res.status(400).json({ error: "device_id (or station_id) query param required" });
  }

  const query = { [idField]: idValue };
  if (from || to) {
    query.timestamp = {};
    if (from) query.timestamp.$gte = new Date(from);
    if (to) query.timestamp.$lte = new Date(to);
  }

  const docs = await Telemetry.find(query)
    .sort({ timestamp: -1 })
    .limit(Math.min(Number(limit) || 500, 5000))
    .lean();

  res.json(docs.map((d) => ({ ...d, pollutants: sanitizePollutants(d.pollutants), aqi: calculateAQI(d.pollutants) })));
});

module.exports = router;
