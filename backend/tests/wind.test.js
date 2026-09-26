const express = require("express");
const request = require("supertest");
const { fetchLiveWind, fetchLiveWindDetailed, buildUrl, _cache } = require("../lib/liveWind");
// Loaded at module scope (it pulls in Mongoose): requiring it inside a test
// put a cold module load inside that test's 5s timeout.
const SourceDirection = require("../models/SourceDirection");

// A real Open-Meteo response shape, values from a live call for NEL-001
// (14.442, 79.986) on 2026-09-26: current.time 09:15 UTC, 4.63 m/s from 298.
const REAL_PAYLOAD = {
  latitude: 14.446397, longitude: 79.99074,
  current_units: { time: "iso8601", interval: "seconds", wind_speed_10m: "m/s", wind_direction_10m: "°" },
  current: { time: "2026-09-26T09:15", interval: 900, wind_speed_10m: 4.63, wind_direction_10m: 298 },
};
const okFetch = (payload) => jest.fn(async () => ({ ok: true, json: async () => payload }));

beforeEach(() => _cache.clear());

describe("fetchLiveWind (port of ctm-core/met/live_wind.py)", () => {
  test("parses the real response shape; FROM-direction passed through unconverted", async () => {
    const w = await fetchLiveWind(14.442, 79.986, { fetchImpl: okFetch(REAL_PAYLOAD) });
    expect(w).toEqual({
      speed_m_s: 4.63, dir_from_deg: 298, as_of: "2026-09-26T09:15:00.000Z",
      grid_lat: 14.446397, grid_lon: 79.99074,
    });
  });

  test("requests m/s and UTC explicitly, same params live_wind.py verified", () => {
    const u = new URL(buildUrl(14.442, 79.986));
    expect(u.origin + u.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(u.searchParams.get("wind_speed_unit")).toBe("ms");
    expect(u.searchParams.get("timezone")).toBe("UTC");
    expect(u.searchParams.get("current")).toBe("wind_speed_10m,wind_direction_10m");
  });

  test("rejects a response whose speed unit isn't m/s (the km/h bug class)", async () => {
    const kmh = { ...REAL_PAYLOAD, current_units: { ...REAL_PAYLOAD.current_units, wind_speed_10m: "km/h" } };
    expect(await fetchLiveWind(14.442, 79.986, { fetchImpl: okFetch(kmh) })).toBeNull();
  });

  test.each([
    ["null speed", { wind_speed_10m: null }],
    ["NaN direction", { wind_direction_10m: NaN }],
    ["negative speed", { wind_speed_10m: -1 }],
    ["direction > 360", { wind_direction_10m: 400 }],
    ["missing time", { time: undefined }],
  ])("%s -> null, never a fabricated reading", async (_label, patch) => {
    const bad = { ...REAL_PAYLOAD, current: { ...REAL_PAYLOAD.current, ...patch } };
    expect(await fetchLiveWind(14.442, 79.986, { fetchImpl: okFetch(bad) })).toBeNull();
  });

  test("HTTP error and network failure -> null", async () => {
    expect(await fetchLiveWind(1, 2, { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) })).toBeNull();
    expect(await fetchLiveWind(1, 2, { fetchImpl: async () => { throw new Error("ECONNRESET"); } })).toBeNull();
  });

  test("caches successes (no second provider call), never failures", async () => {
    const f = okFetch(REAL_PAYLOAD);
    await fetchLiveWind(14.442, 79.986, { fetchImpl: f });
    await fetchLiveWind(14.442, 79.986, { fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(1);

    _cache.clear();
    const failing = jest.fn(async () => ({ ok: false }));
    await fetchLiveWind(3, 4, { fetchImpl: failing });
    await fetchLiveWind(3, 4, { fetchImpl: failing });
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/wind", () => {
  const app = express();
  app.use("/api/wind", require("../routes/wind"));
  // The route calls the real fetchLiveWind, which uses global fetch: stub the
  // network there and put the real one back afterwards.
  const realFetch = global.fetch;
  afterAll(() => { global.fetch = realFetch; });

  test("200: live wind labelled as a model nowcast, FROM-direction convention stated", async () => {
    global.fetch = okFetch(REAL_PAYLOAD);
    const res = await request(app).get("/api/wind?lat=14.442&lon=79.986");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      speed_m_s: 4.63, dir_from_deg: 298, as_of: "2026-09-26T09:15:00.000Z",
      source_tier: "live_model_nowcast", station_id: "open-meteo-live-nowcast",
    });
    expect(res.body.source_label).toMatch(/NOT a ground-station reading/);
    expect(res.body.meta).toMatchObject({ requested: { lat: 14.442, lon: 79.986 }, grid_lat: 14.446397 });
    expect(res.body.meta.direction_convention).toMatch(/FROM-direction/);
  });

  test("top-level shape is EXACTLY SourceDirection's wind sub-object (read from the real schema)", async () => {
    const windKeys = Object.keys(SourceDirection.schema.paths)
      .filter((p) => p.startsWith("wind."))
      .map((p) => p.slice("wind.".length))
      .sort();
    expect(windKeys).toEqual(["as_of", "dir_from_deg", "source_label", "source_tier", "speed_m_s", "station_id"]);

    global.fetch = okFetch(REAL_PAYLOAD);
    const res = await request(app).get("/api/wind?lat=14.442&lon=79.986");
    const { meta, ...shared } = res.body;
    expect(Object.keys(shared).sort()).toEqual(windKeys);
    expect(meta).toBeDefined();
  });

  test("/api/wind/live is the same handler (alias kept)", async () => {
    global.fetch = okFetch(REAL_PAYLOAD);
    const a = await request(app).get("/api/wind?lat=14.442&lon=79.986");
    const b = await request(app).get("/api/wind/live?lat=14.442&lon=79.986");
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
  });

  test("503 (no fallback wind) when the provider fails, with a diagnosable reason", async () => {
    _cache.clear();
    const err = new TypeError("fetch failed"); err.cause = { code: "ENOTFOUND" };
    global.fetch = async () => { throw err; };
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(app).get("/api/wind?lat=14.442&lon=79.986");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unavailable");
    expect(res.body.reason).toBe("network_error_ENOTFOUND");
    expect(res.body).not.toHaveProperty("speed_m_s");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("network_error_ENOTFOUND"));
    console.warn.mockRestore();
  });

  test.each([
    ["missing lon", "lat=14.4"],
    ["non-numeric", "lat=abc&lon=79"],
    ["lat out of range", "lat=91&lon=79"],
    ["lon out of range", "lat=14&lon=181"],
  ])("400 on %s", async (_l, qs) => {
    const res = await request(app).get(`/api/wind?${qs}`);
    expect(res.status).toBe(400);
  });
});

describe("fetchLiveWindDetailed -- failure reasons", () => {
  beforeEach(() => _cache.clear());

  test.each([
    ["no global fetch (Node < 18)", { fetchImpl: undefined, noFetch: true }, /^fetch_unavailable \(node v/],
    ["HTTP 429 from the provider", { fetchImpl: async () => ({ ok: false, status: 429 }) }, /^provider_http_429$/],
    ["non-JSON body", { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError("x"); } }) }, /^provider_non_json$/],
    ["timeout", { fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } }, /^timeout_/],
    ["missing current block", { fetchImpl: okFetch({}) }, /^payload_missing_current$/],
  ])("%s -> value null, reason %p", async (_l, { fetchImpl, noFetch }, reasonRe) => {
    const opts = noFetch ? { fetchImpl: null } : { fetchImpl };
    const { value, reason } = await fetchLiveWindDetailed(14.442, 79.986, opts);
    expect(value).toBeNull();
    expect(reason).toMatch(reasonRe);
  });

  test("success -> reason null, value identical to fetchLiveWind", async () => {
    const d = await fetchLiveWindDetailed(14.442, 79.986, { fetchImpl: okFetch(REAL_PAYLOAD) });
    _cache.clear();
    const v = await fetchLiveWind(14.442, 79.986, { fetchImpl: okFetch(REAL_PAYLOAD) });
    expect(d.reason).toBeNull();
    expect(d.value).toEqual(v);
  });
});
