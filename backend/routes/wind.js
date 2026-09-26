const express = require("express");
const { fetchLiveWind, LIVE_WIND_STATION_ID } = require("../lib/liveWind");
const { WIND_SOURCE_LABELS } = require("../lib/windSource");

const router = express.Router();

/*
 * GET /api/wind?lat=14.442&lon=79.986      (also /api/wind/live, same handler)
 *
 * Live model-nowcast wind for any lat/lon (see lib/liveWind.js). The body is
 * EXACTLY the shape of SourceDirection's `wind` sub-object
 * (models/SourceDirection.js), so every consumer reads one shape:
 *
 *   { speed_m_s, dir_from_deg, station_id, as_of, source_tier, source_label,
 *     meta: { requested, grid_lat, grid_lon, direction_convention } }
 *
 * dir_from_deg is the meteorological FROM-direction, unconverted -- a caller
 * wanting the downwind (plume travel) bearing adds 180 itself.
 * `meta` holds what SourceDirection's wind doesn't have, kept apart so the
 * shared shape stays identical.
 *
 * 400 -> lat/lon missing or out of range
 * 503 -> provider unreachable or returned nothing usable. Deliberately no
 *        fallback wind: the caller shows its no-data state instead.
 */
async function handler(req, res) {
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
      speed_m_s: wind.speed_m_s,
      dir_from_deg: wind.dir_from_deg,
      station_id: LIVE_WIND_STATION_ID,
      as_of: wind.as_of,
      source_tier: "live_model_nowcast",
      source_label: WIND_SOURCE_LABELS.live_model_nowcast,
      meta: {
        requested: { lat, lon },
        grid_lat: wind.grid_lat,
        grid_lon: wind.grid_lon,
        direction_convention: "meteorological FROM-direction (degrees, 0 = from north)",
      },
    });
  } catch (err) {
    console.error("[wind] live lookup failed:", err.message);
    res.status(503).json({ error: "Live wind unavailable", status: "unavailable" });
  }
}

router.get("/", handler);
router.get("/live", handler);

module.exports = router;
