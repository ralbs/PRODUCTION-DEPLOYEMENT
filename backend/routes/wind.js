const express = require("express");
const { fetchLiveWind, LIVE_WIND_STATION_ID } = require("../lib/liveWind");
const { WIND_SOURCE_LABELS } = require("../lib/windSource");

const router = express.Router();

/*
 * GET /api/wind/live?lat=14.442&lon=79.986
 *
 * Live model-nowcast wind for any lat/lon (see lib/liveWind.js). The
 * direction is the meteorological FROM-direction, unconverted -- a caller
 * that needs the downwind (plume travel) bearing must add 180 itself.
 *
 * 200 -> { speed_m_s, dir_from_deg, as_of, grid_lat, grid_lon, requested,
 *          direction_convention, station_id, source_tier, source_label }
 * 400 -> lat/lon missing or out of range
 * 503 -> provider unreachable or returned nothing usable. Deliberately no
 *        fallback wind: a caller shows its no-data state instead.
 */
router.get("/live", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (req.query.lat == null || req.query.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)
      || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: "lat and lon query params required (lat -90..90, lon -180..180)" });
  }

  try {
    const wind = await fetchLiveWind(lat, lon);
    if (!wind) {
      return res.status(503).json({ error: "Live wind unavailable -- provider unreachable or returned no usable reading", status: "unavailable" });
    }
    res.json({
      ...wind,
      requested: { lat, lon },
      direction_convention: "meteorological FROM-direction (degrees, 0 = from north)",
      station_id: LIVE_WIND_STATION_ID,
      source_tier: "live_model_nowcast",
      source_label: WIND_SOURCE_LABELS.live_model_nowcast,
    });
  } catch (err) {
    console.error("[wind] live lookup failed:", err.message);
    res.status(503).json({ error: "Live wind unavailable", status: "unavailable" });
  }
});

module.exports = router;
