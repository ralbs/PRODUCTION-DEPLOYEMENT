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
 *   - Source: Open-Meteo forecast API. A real NWP model NOWCAST, not a
 *     ground-station reading -> source_tier "live_model_nowcast".
 *
 * API key (optional, server-side only): with OPEN_METEO_API_KEY set, requests
 * go to Open-Meteo's commercial endpoint (customer-api.open-meteo.com, key as
 * the `apikey` query param -- the only way Open-Meteo accepts it); unset, the
 * free endpoint, exactly as before. The free tier is rate-limited per IP, and
 * Render's shared outbound IP hit it for real (provider_http_429). The key
 * rides in the request URL, so that URL is never logged, thrown or returned:
 * failures stay fixed reason codes, and callers see only which endpoint
 * ("free"/"customer") served the reading -- never the key.
 *   - wind_direction_10m is the meteorological FROM-direction -- verified
 *     empirically in live_wind.py against Meteostat station 43245 (~18 deg
 *     consistent offset, not ~180). Returned UNCONVERTED as dir_from_deg.
 *   - wind_speed_unit=ms requested explicitly (never the km/h default).
 *   - Timestamps in UTC; "now" is the provider's own current.time.
 *   - Non-finite values rejected before any other use.
 *   - Any failure returns null. Never a fabricated fallback reading.
 */

const LIVE_WIND_BASE_URL = "https://api.open-meteo.com/v1/forecast";
const LIVE_WIND_CUSTOMER_BASE_URL = "https://customer-api.open-meteo.com/v1/forecast";

// Read per call (not at load) so setting the env var needs no code change,
// and tests can pass their own env. Blank/whitespace counts as unset.
function apiKey(env = process.env) {
  const k = typeof env.OPEN_METEO_API_KEY === "string" ? env.OPEN_METEO_API_KEY.trim() : "";
  return k || null;
}
const LIVE_WIND_STATION_ID = "open-meteo-live-nowcast";

// Open-Meteo's current conditions update every 15 min; 10 min keeps any one
// location from being refetched on every page view without serving a
// reading older than one model update.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

// Contains the key when one is set -- never log or return this URL.
function buildUrl(lat, lon, key = apiKey()) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    timezone: "UTC",
  });
  if (key) params.set("apikey", key);
  return `${key ? LIVE_WIND_CUSTOMER_BASE_URL : LIVE_WIND_BASE_URL}?${params}`;
}

/**
 * @returns {Promise<null | {speed_m_s, dir_from_deg, as_of, grid_lat, grid_lon, endpoint}>}
 */
async function fetchLiveWind(lat, lon, opts) {
  return (await fetchLiveWindDetailed(lat, lon, opts)).value;
}

/**
 * Same as fetchLiveWind, but also says WHY there's no value, as a short
 * fixed code (never a secret, never a raw provider body) -- so a failure in
 * production is diagnosable from the route's 503 and the server log instead
 * of being an indistinguishable null.
 * @returns {Promise<{value: object|null, reason: string|null}>}
 */
async function fetchLiveWindDetailed(lat, lon, { fetchImpl = globalThis.fetch, timeoutMs = 10000, env = process.env } = {}) {
  const fail = (reason) => ({ value: null, reason });
  const key = apiKey(env);
  const endpoint = key ? "customer" : "free";
  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { value: hit.value, reason: null };

  // Global fetch only exists on Node >= 18.
  if (typeof fetchImpl !== "function") return fail(`fetch_unavailable (node ${process.version})`);

  let payload;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(buildUrl(lat, lon, key), { signal: ctrl.signal });
    if (!res.ok) return fail(`provider_http_${res.status}`);
    try {
      payload = await res.json();
    } catch {
      return fail("provider_non_json");
    }
  } catch (err) {
    if (err?.name === "AbortError") return fail(`timeout_${timeoutMs}ms`);
    const code = err?.cause?.code || err?.code || err?.name || "unknown";
    return fail(`network_error_${code}`);
  } finally {
    clearTimeout(timer);
  }

  const cur = payload?.current;
  const units = payload?.current_units;
  if (!cur || typeof cur.time !== "string") return fail("payload_missing_current");
  // Guard the units contract rather than trusting the request param alone.
  if (units && units.wind_speed_10m && units.wind_speed_10m !== "m/s") return fail("payload_wrong_speed_unit");

  const speed = Number(cur.wind_speed_10m);
  const dir = Number(cur.wind_direction_10m);
  if (cur.wind_speed_10m == null || cur.wind_direction_10m == null) return fail("payload_missing_wind");
  if (!Number.isFinite(speed) || !Number.isFinite(dir)) return fail("payload_non_finite");
  if (speed < 0 || dir < 0 || dir > 360) return fail("payload_out_of_range");

  // timezone=UTC returns naive "YYYY-MM-DDTHH:MM" -- mark it UTC explicitly.
  const asOf = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(cur.time) ? cur.time : `${cur.time}Z`);
  if (Number.isNaN(asOf.getTime())) return fail("payload_bad_time");

  const value = {
    speed_m_s: speed,
    dir_from_deg: dir % 360,
    as_of: asOf.toISOString(),
    grid_lat: Number.isFinite(payload.latitude) ? payload.latitude : null,
    grid_lon: Number.isFinite(payload.longitude) ? payload.longitude : null,
    endpoint,
  };
  cache.set(cacheKey, { at: Date.now(), value }); // successes only; failures are retried
  return { value, reason: null };
}

module.exports = {
  fetchLiveWind, fetchLiveWindDetailed, buildUrl, apiKey,
  LIVE_WIND_BASE_URL, LIVE_WIND_CUSTOMER_BASE_URL, LIVE_WIND_STATION_ID, _cache: cache,
};
