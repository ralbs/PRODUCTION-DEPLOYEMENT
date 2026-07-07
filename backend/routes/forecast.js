const express = require("express");
const { buildForecast } = require("../lib/forecast");

const router = express.Router();

// GET /api/forecast?station_id=KSPCB-Hebbal&lookback=168&horizon=24
router.get("/", async (req, res) => {
  const { station_id, lookback = 168, horizon = 24 } = req.query;
  if (!station_id) return res.status(400).json({ error: "station_id query param required" });

  try {
    const result = await buildForecast(station_id, Number(lookback), Math.min(Number(horizon), 48));
    if (!result) return res.status(404).json({ error: "Not enough data to build forecast" });
    res.json(result);
  } catch (err) {
    console.error("[forecast] error:", err.message);
    res.status(500).json({ error: "Forecast failed" });
  }
});

module.exports = router;
