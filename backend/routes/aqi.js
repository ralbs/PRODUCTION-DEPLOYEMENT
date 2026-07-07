const express = require("express");
const Telemetry = require("../models/Telemetry");
const { calculateAQI } = require("../lib/aqi");

const router = express.Router();

// GET /api/aqi/latest?station_id=NEL-001
router.get("/latest", async (req, res) => {
  const { station_id } = req.query;
  if (!station_id) return res.status(400).json({ error: "station_id query param required" });

  const doc = await Telemetry.findOne({ "meta.station_id": station_id })
    .sort({ timestamp: -1 })
    .lean();
  if (!doc) return res.status(404).json({ error: "No telemetry found for this station" });

  const aqi = calculateAQI(doc.pollutants);
  res.json({ timestamp: doc.timestamp, station_id, ...aqi });
});

// GET /api/aqi/history?station_id=NEL-001&from=...&to=...&limit=500
// Returns AQI computed per reading, for a trend chart.
router.get("/history", async (req, res) => {
  const { station_id, from, to, limit = 500 } = req.query;
  if (!station_id) return res.status(400).json({ error: "station_id query param required" });

  const query = { "meta.station_id": station_id };
  if (from || to) {
    query.timestamp = {};
    if (from) query.timestamp.$gte = new Date(from);
    if (to) query.timestamp.$lte = new Date(to);
  }

  const docs = await Telemetry.find(query)
    .sort({ timestamp: 1 })
    .limit(Math.min(Number(limit) || 500, 5000))
    .lean();

  const series = docs.map((d) => ({
    timestamp: d.timestamp,
    ...calculateAQI(d.pollutants),
  }));

  res.json(series);
});

module.exports = router;
