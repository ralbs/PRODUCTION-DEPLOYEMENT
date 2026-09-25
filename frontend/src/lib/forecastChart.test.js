// Run: npm test  (node's built-in runner -- no test framework dependency)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForecastChartData } from "./forecastChart.js";

const T0 = Date.parse("2026-09-10T00:00:00Z");
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

test("irregular gaps: each point sits at its reading's ACTUAL time, not a constant step per index", () => {
  const offsetsH = [1, 3, 4, 9]; // gaps of 2h, 1h, 5h -- deliberately uneven
  const forecast = {
    history_aqi: offsetsH.map((h, i) => ({ timestamp: iso(T0 + h * H), aqi: 60 + i })),
    predictions: [{ timestamp: iso(T0 + 10 * H), aqi: 70, aqi_low: 60, aqi_high: 80 }],
  };

  const hist = buildForecastChartData(forecast).filter((r) => "historical" in r);
  const actual = hist.map((r) => r.t);
  assert.deepEqual(actual, offsetsH.map((h) => T0 + h * H));

  // Discrimination: every plausible constant-dt reconstruction lands at a
  // DIFFERENT x for at least one reading, so none of them could pass above.
  const n = offsetsH.length;
  const first = T0 + offsetsH[0] * H, last = T0 + offsetsH[n - 1] * H;
  const constantDt = {
    "first + i*1h": offsetsH.map((_, i) => first + i * H),
    "last - (n-1-i)*1h": offsetsH.map((_, i) => last - (n - 1 - i) * H),
    "evenly spaced first..last": offsetsH.map((_, i) => first + (i * (last - first)) / (n - 1)),
  };
  for (const [name, xs] of Object.entries(constantDt)) {
    assert.notDeepEqual(actual, xs, `a "${name}" x-axis would have matched -- test not discriminating`);
  }
  // And the spacing the chart gets really is uneven.
  assert.deepEqual(actual.slice(1).map((t, i) => (t - actual[i]) / H), [2, 1, 5]);
});

test("null AQI mid-history: kept as null at its own time -- not dropped, not 0, neighbours not shifted", () => {
  const readings = [
    { h: 0, aqi: 50 }, { h: 1, aqi: 52 }, { h: 2, aqi: null }, { h: 3, aqi: 54 }, { h: 4, aqi: 56 },
  ];
  const forecast = {
    history_aqi: readings.map((r) => ({ timestamp: iso(T0 + r.h * H), aqi: r.aqi })),
    predictions: [{ timestamp: iso(T0 + 5 * H), aqi: 58, aqi_low: 50, aqi_high: 66 }],
  };

  const hist = buildForecastChartData(forecast).filter((r) => "historical" in r);
  assert.equal(hist.length, 5, "the null reading must not be dropped (that would join 52 -> 54 with no gap)");
  assert.deepEqual(hist.map((r) => r.t), readings.map((r) => T0 + r.h * H), "no reading may shift position");
  assert.strictEqual(hist[2].historical, null, "must be null (a line break), never 0 or undefined");
  assert.deepEqual(hist.map((r) => r.historical), [50, 52, null, 54, 56]);
});

test("a real AQI of 0 stays 0 -- the null handling must not swallow genuine zeros", () => {
  const forecast = { history_aqi: [{ timestamp: iso(T0), aqi: 0 }], predictions: [] };
  assert.strictEqual(buildForecastChartData(forecast)[0].historical, 0);
});

test("forecast line starts from the last REAL reading when the newest reading is null", () => {
  const forecast = {
    history_aqi: [{ timestamp: iso(T0), aqi: 61 }, { timestamp: iso(T0 + H), aqi: null }],
    predictions: [{ timestamp: iso(T0 + 2 * H), aqi: 63, aqi_low: 55, aqi_high: 71 }],
  };
  const rows = buildForecastChartData(forecast);
  assert.equal(rows.find((r) => r.t === T0).forecast, 61);
  assert.equal(rows.find((r) => r.t === T0 + H).forecast, undefined);
});
