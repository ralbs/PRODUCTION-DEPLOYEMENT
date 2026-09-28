const express = require("express");
const { buildForecast, checkSpike } = require("../lib/forecast");

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

// GET /api/forecast/spike-check?station_id=NEL-001
// Used by scripts/source_direction_worker.py as the spike trigger -- the
// windowed rule in lib/forecast.js checkSpike() (its constants and why are
// documented there). A `lookback` param from older workers is ignored: the
// rule's windows are fixed by its own named constants.
router.get("/spike-check", async (req, res) => {
  const { station_id } = req.query;
  if (!station_id) return res.status(400).json({ error: "station_id query param required" });

  try {
    const result = await checkSpike(station_id);
    if (!result) return res.status(404).json({ error: "Not enough data to check for a spike" });
    res.json(result);
  } catch (err) {
    console.error("[forecast] spike-check error:", err.message);
    res.status(500).json({ error: "Spike check failed" });
  }
});

module.exports = router;
