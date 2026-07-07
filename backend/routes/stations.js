const express = require("express");
const Telemetry = require("../models/Telemetry");

const router = express.Router();

// GET /api/stations — distinct station IDs plus their most recent reading time
router.get("/", async (_req, res) => {
  const stationIds = await Telemetry.distinct("meta.station_id");

  const stations = await Promise.all(
    stationIds.map(async (id) => {
      const latest = await Telemetry.findOne({ "meta.station_id": id })
        .sort({ timestamp: -1 })
        .select("timestamp location meta.device_id")
        .lean();
      return {
        station_id: id,
        device_id: latest?.meta?.device_id,
        last_seen: latest?.timestamp,
        location: latest?.location,
      };
    })
  );

  res.json(stations);
});

module.exports = router;
