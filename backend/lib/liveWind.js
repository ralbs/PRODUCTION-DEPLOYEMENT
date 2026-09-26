/*
 * liveWind.js — live current-conditions wind for a lat/lon, ported from
 * ctm-core/met/live_wind.py (read that module's docstring for the evidence
 * behind every choice below; nothing here is re-derived).
 *
 * Ported rather than shelled out to Python: the Render web service runs the
 * Node runtime with rootDir backend/, so neither Python nor that module's
 * numpy/requests dependencies exist there. The logic is one HTTP GET plus
 * finiteness checks, so a straight port stays faithful.
 *
 * Carried over exactly from live_wind.py:
 *   - Source: Open-Meteo forecast API, no key. A real NWP model NOWCAST, not
 *     a ground-station reading -> source_tier "live_model_nowcast".
 *   - wind_direction_10m is the meteorological FROM-direction -- verified
 *     empirically in live_wind.py against Meteostat station 43245 (~18 deg
 *     consistent offset, not ~180). Returned UNCONVERTED as dir_from_deg.
 *   - wind_speed_unit=ms requested explicitly (never the km/h default).
 *   - Timestamps in UTC; "now" is the provider's own current.time.
 *   - Non-finite values rejected before any other use.
 *   - Any failure returns null. Never a fabricated fallback reading.
 */

const LIVE_WIND_BASE_URL = "https://api.open-meteo.com/v1/forecast";
const LIVE_WIND_STATION_ID = "open-meteo-live-nowcast";

// Open-Meteo's current conditions update every 15 min; 10 min keeps any one
// location from being refetched on every page view without serving a
// reading older than one model update.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function buildUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    timezone: "UTC",
  });
  return `${LIVE_WIND_BASE_URL}?${params}`;
}

/**
 * @returns {Promise<null | {speed_m_s, dir_from_deg, as_of, grid_lat, grid_lon}>}
 */
async function fetchLiveWind(lat, lon, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let payload;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(buildUrl(lat, lon), { signal: ctrl.signal });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null; // network error, timeout, or non-JSON body
  } finally {
    clearTimeout(timer);
  }

  const cur = payload?.current;
  const units = payload?.current_units;
  if (!cur || typeof cur.time !== "string") return null;
  // Guard the units contract rather than trusting the request param alone.
  if (units && units.wind_speed_10m && units.wind_speed_10m !== "m/s") return null;

  const speed = Number(cur.wind_speed_10m);
  const dir = Number(cur.wind_direction_10m);
  if (cur.wind_speed_10m == null || cur.wind_direction_10m == null) return null;
  if (!Number.isFinite(speed) || !Number.isFinite(dir)) return null;
  if (speed < 0 || dir < 0 || dir > 360) return null;

  // timezone=UTC returns naive "YYYY-MM-DDTHH:MM" -- mark it UTC explicitly.
  const asOf = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(cur.time) ? cur.time : `${cur.time}Z`);
  if (Number.isNaN(asOf.getTime())) return null;

  const value = {
    speed_m_s: speed,
    dir_from_deg: dir % 360,
    as_of: asOf.toISOString(),
    grid_lat: Number.isFinite(payload.latitude) ? payload.latitude : null,
    grid_lon: Number.isFinite(payload.longitude) ? payload.longitude : null,
  };
  cache.set(key, { at: Date.now(), value }); // successes only; failures are retried
  return value;
}

module.exports = { fetchLiveWind, buildUrl, LIVE_WIND_BASE_URL, LIVE_WIND_STATION_ID, _cache: cache };
