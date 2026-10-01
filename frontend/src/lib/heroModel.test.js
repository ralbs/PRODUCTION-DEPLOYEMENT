import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHeroModel, trendClause, directionSentence, cpcbBand, fmtAge, STALE_AFTER_MIN } from "./heroModel.js";
import { MIN_REAL_HOURS } from "./forecastChart.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const H = 3600e3, MIN = 60e3;
const reading = (aqi, ageMs = 1 * MIN) => ({ timestamp: new Date(NOW - ageMs).toISOString(), aqi: { aqi } });
const hourly = (aqis, endMs = NOW - MIN) =>
  aqis.map((a, i) => ({ timestamp: new Date(endMs - (aqis.length - 1 - i) * H).toISOString(), aqi: a }));

test("CPCB bands and verbatim impact strings (National AQI report p.38)", () => {
  assert.equal(cpcbBand(33).category, "Good");
  assert.equal(cpcbBand(33).impact, "Minimal Impact");
  assert.equal(cpcbBand(150).category, "Moderately polluted");
  assert.match(cpcbBand(150).impact, /^May cause breathing discomfort to the people with lung disease such as asthma/);
  assert.equal(cpcbBand(250).category, "Poor");
  assert.equal(cpcbBand(450).category, "Severe");
  assert.equal(cpcbBand(50).category, "Good");      // band edges match backend aqiCategory()
  assert.equal(cpcbBand(51).category, "Satisfactory");
});

test("current reading -> present-tense headline + CPCB impact", () => {
  const m = buildHeroModel({ stationId: "NEL-001", latest: reading(33), nowMs: NOW });
  assert.equal(m.mode, "current");
  assert.equal(m.headline, "Air quality is Good.");
  assert.equal(m.secondary, "Minimal Impact");
});

test("stale reading -> never present tense, no guidance, no trend (NEL-001's real 19-day-old reading)", () => {
  const m = buildHeroModel({ stationId: "NEL-001", latest: reading(33, 19 * 24 * H),
    forecast: { trend: "falling", resolution_minutes: 60, real_hours: 6, history_aqi: hourly([40, 38, 36, 35, 34, 33]) }, nowMs: NOW });
  assert.equal(m.mode, "stale");
  assert.equal(m.headline, "No current reading from NEL-001.");
  assert.match(m.secondary, /^Latest reading: Good, .* \(19 days ago\)\.$/);
  assert.equal(m.trend, null);
  assert.doesNotMatch(`${m.headline} ${m.secondary}`, /Air quality is/);
});

test("staleness boundary is 10 minutes", () => {
  assert.equal(buildHeroModel({ stationId: "S", latest: reading(33, STALE_AFTER_MIN * MIN), nowMs: NOW }).mode, "current");
  assert.equal(buildHeroModel({ stationId: "S", latest: reading(33, STALE_AFTER_MIN * MIN + 1000), nowMs: NOW }).mode, "stale");
});

test("trend clause is suppressed for minute-spaced data (the forecast treats each reading as an hour)", () => {
  const perMinute = [40, 39, 38, 37, 36, 35].map((a, i) => ({ timestamp: new Date(NOW - (5 - i) * MIN).toISOString(), aqi: a }));
  assert.deepEqual(trendClause({ trend: "falling", history_aqi: perMinute }, NOW), { text: null, why: "not_hourly" });
  // Even if a server claimed hourly resolution, minute-spaced history still blocks it.
  assert.deepEqual(trendClause({ trend: "falling", resolution_minutes: 60, real_hours: 6, history_aqi: perMinute }, NOW), { text: null, why: "not_hourly" });
});

test("P0-a gate: no clause unless the server declares 60-minute steps, even for hourly-looking history", () => {
  const f = { trend: "falling", real_hours: 6, history_aqi: hourly([60, 58, 57, 55, 54, 53]), predictions: [] };
  for (const resolution of [undefined, null, 1, 30, "60"]) {
    assert.deepEqual(trendClause({ ...f, resolution_minutes: resolution }, NOW - MIN), { text: null, why: "not_hourly" }, String(resolution));
  }
  assert.equal(trendClause({ ...f, resolution_minutes: 60 }, NOW - MIN).text, "Improving over the next 2 hours.");
  // ...and through the full model: current reading, old-shape forecast -> hero renders no trend text.
  const m = buildHeroModel({ stationId: "S", latest: reading(53), forecast: f, nowMs: NOW });
  assert.equal(m.mode, "current");
  assert.equal(m.trend.text, null);
});

test("hourly data -> wording follows the backend trend label", () => {
  const f = (trend, aqis) => trendClause({ trend, resolution_minutes: 60, real_hours: 6, history_aqi: hourly(aqis), predictions: [] }, NOW - MIN).text;
  assert.equal(f("falling", [60, 58, 57, 55, 54, 53]), "Improving over the next 2 hours.");
  assert.equal(f("stable", [60, 60, 61, 60, 60, 61]), "Steady over the next 2 hours.");
  assert.equal(f("rapidly rising", [40, 44, 49, 55, 60, 66]), "Worsening quickly over the next 2 hours.");
});

test("trend contradicted by the last three real hours -> 'Direction unclear'", () => {
  const t = trendClause({ trend: "rising", resolution_minutes: 60, real_hours: 6, history_aqi: hourly([50, 60, 70, 65, 60, 55]), predictions: [] }, NOW - MIN);
  assert.equal(t.text, "Direction unclear right now");
});

test("category change within 2 h: 'likely' only when the whole interval crosses, else 'may reach'", () => {
  const hist = hourly([80, 84, 88, 92, 95, 98]);
  const pred = (aqi, lo, hi, h) => ({ timestamp: new Date(NOW - MIN + h * H).toISOString(), aqi, aqi_low: lo, aqi_high: hi });
  const likely = trendClause({ trend: "rising", resolution_minutes: 60, real_hours: 6, history_aqi: hist, predictions: [pred(104, 101, 108, 1)] }, NOW - MIN).text;
  assert.match(likely, /^Worsening over the next 2 hours — likely Moderately polluted by /);
  const may = trendClause({ trend: "rising", resolution_minutes: 60, real_hours: 6, history_aqi: hist, predictions: [pred(104, 90, 118, 1)] }, NOW - MIN).text;
  assert.match(may, / — may reach Moderately polluted by /);
  const beyond = trendClause({ trend: "rising", resolution_minutes: 60, real_hours: 6, history_aqi: hist, predictions: [pred(130, 120, 140, 3)] }, NOW - MIN).text;
  assert.equal(beyond, "Worsening over the next 2 hours.");
});

test("direction: fresh confident-looking estimate -> pointer only, never a bearing or confidence word", () => {
  const sd = { status: "ok", doc: { timestamp: new Date(NOW - 30 * MIN).toISOString(), confidence: 0.99,
    estimate_tier: "interior", bearing_deg: 247 } };
  const s = directionSentence(sd, null, NOW);
  assert.match(s, /^An unusual rise was detected at .* — see Source Direction for a screening estimate\.$/);
  assert.doesNotMatch(s, /247|WSW|west|confiden|high|likely/i);
});

test("direction: inconclusive, spike-without-wind, stale, and none", () => {
  const at = (ms) => new Date(NOW - ms).toISOString();
  assert.match(directionSentence({ status: "ok", doc: { timestamp: at(20 * MIN), confidence: 0.05 } }, null, NOW), /its direction is inconclusive\.$/);
  const run = { status: "ok", doc: { spike_detected: true, wind_failure_reason: "provider_http_429", spike_timestamp: at(15 * MIN) } };
  assert.match(directionSentence({ status: "not_found" }, run, NOW), /but its direction couldn't be estimated\.$/);
  assert.equal(directionSentence({ status: "ok", doc: { timestamp: at(5 * H), confidence: 0.9 } }, null, NOW), null);
  assert.equal(directionSentence({ status: "not_found" }, { status: "ok", doc: { spike_detected: false } }, NOW), null);
});

test("fmtAge floors, matching ConfidenceBadge (19.5 days is '19 days ago', not 20)", () => {
  assert.equal(fmtAge(19.5 * 24 * H), "19 days ago");
  assert.equal(fmtAge(47.9 * H), "47 h ago");
  assert.equal(fmtAge(59.9 * MIN), "59 min ago");
});

test("MIN_REAL_HOURS gate on the trend clause: below -> none, at/above -> shown", () => {
  assert.equal(MIN_REAL_HOURS, 6);
  const base = { trend: "falling", resolution_minutes: 60, predictions: [] };
  const falling = [62, 60, 59, 58, 56, 55, 54, 53];
  // server says 5 real hours (even if history looks long enough)
  assert.deepEqual(trendClause({ ...base, real_hours: 5, history_aqi: hourly(falling.slice(-6)) }, NOW - MIN), { text: null, why: "too_few_points" });
  // server omits it (older backend)
  assert.deepEqual(trendClause({ ...base, history_aqi: hourly(falling.slice(-6)) }, NOW - MIN), { text: null, why: "too_few_points" });
  // server says 6 but only 5 history points came back
  assert.deepEqual(trendClause({ ...base, real_hours: 6, history_aqi: hourly(falling.slice(-5)) }, NOW - MIN), { text: null, why: "too_few_points" });
  assert.equal(trendClause({ ...base, real_hours: 6, history_aqi: hourly(falling.slice(-6)) }, NOW - MIN).text, "Improving over the next 2 hours.");
  assert.equal(trendClause({ ...base, real_hours: 8, history_aqi: hourly(falling) }, NOW - MIN).text, "Improving over the next 2 hours.");
});

test("only test stations reported: honest no-real-station hero, not a loading spinner", () => {
  const m = buildHeroModel({ stationId: null, latest: null, latestStatus: "no_real_station", nowMs: NOW });
  assert.equal(m.mode, "no_data");
  assert.equal(m.headline, "No real station reporting yet.");
});
