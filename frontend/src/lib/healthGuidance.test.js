import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CPCB_BANDS, cpcbBand, NAAQS, advisory, voiceSummary, crossingAlert, CPCB_IMPACT_SOURCE,
} from "./healthGuidance.js";
import * as hero from "./heroModel.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CPCB impacts are verbatim (National AQI report 2014, p.38) on the published edges", () => {
  assert.deepEqual(CPCB_BANDS.map((b) => [b.min, b.max, b.category]), [
    [0, 50, "Good"], [51, 100, "Satisfactory"], [101, 200, "Moderately polluted"],
    [201, 300, "Poor"], [301, 400, "Very Poor"], [401, Infinity, "Severe"],
  ]);
  assert.equal(cpcbBand(50).impact, "Minimal Impact");
  assert.equal(cpcbBand(51).impact, "May cause minor breathing discomfort to sensitive people");
  assert.match(cpcbBand(401).impact, /^May cause respiratory effects even on healthy people/);
});

test("NAAQS 2009 standards with the right averaging periods (old card had NO2 'annual', CO '8h' at 4)", () => {
  assert.deepEqual([NAAQS.no2.standard, NAAQS.no2.period], ["80 µg/m³", "24-hour"]);
  assert.deepEqual([NAAQS.co.standard, NAAQS.co.period], ["2 mg/m³", "8-hour"]);
  assert.deepEqual([NAAQS.pm2_5.standard, NAAQS.pm2_5.period], ["60 µg/m³", "24-hour"]);
});

test("hero reads from the module: same function, same strings, every band", () => {
  assert.equal(hero.cpcbBand, cpcbBand);
  const NOW = Date.parse("2026-09-28T12:00:00Z");
  for (const b of CPCB_BANDS) {
    const aqi = Math.min(b.min + 5, 480);
    const m = hero.buildHeroModel({ stationId: "S", latest: { timestamp: new Date(NOW - 60e3).toISOString(), aqi: { aqi } }, nowMs: NOW });
    assert.equal(m.headline, b.headline);
    assert.equal(m.secondary, b.impact);
  }
});

test("advisory reads from the module: CPCB impact + NAAQS, no actions, no per-group advice", () => {
  const a = advisory(150, "pm2_5");
  assert.equal(a.impact, cpcbBand(150).impact);
  assert.equal(a.source, CPCB_IMPACT_SOURCE);
  assert.equal(a.dominant.standard, NAAQS.pm2_5.standard);
  assert.deepEqual(Object.keys(a).sort(), ["category", "dominant", "headline", "impact", "source"]);
  assert.equal(advisory(null), null);
});

test("voice reads from the module; stale readings are past tense with no impact or trend", () => {
  const now = voiceSummary({ station: "NEL-001", aqi: 150, trend: "rising", horizonHours: 6, peak: 180, peakTime: "03:00 pm" });
  assert.ok(now.includes(cpcbBand(150).impact));
  assert.match(now, /the next 6 hours look rising/); // the server's capped horizon, not a hard-coded 24
  assert.match(now, /is AQI 150, Moderately polluted/);
  assert.match(now, /extrapolated peak is AQI 180 around 03:00 pm/);
  const stale = voiceSummary({ station: "NEL-001", aqi: 33, stale: true, age: "19 days ago", trend: "rising" });
  assert.equal(stale, "No current reading from NEL-001 station. The last reading, 19 days ago, was AQI 33, Good.");
});

test("alert toast reads from the module: fires on real CPCB edges, upward only", () => {
  assert.equal(crossingAlert(100, 101).category, "Moderately polluted");
  assert.equal(crossingAlert(250, 300), null);          // 300 is still Poor (the old toast said Very Poor)
  assert.equal(crossingAlert(300, 301).category, "Very Poor");
  assert.equal(crossingAlert(310, 150), null);          // downward: no alert
  assert.ok(crossingAlert(90, 210, "NEL-001").body.includes(cpcbBand(210).impact));
});

// ---- the guard: nothing else in src/ may word health guidance -----------
const stripComments = (code) => code
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const ADVICE = /\bN95\b|wear (an? )?mask|mask (needed|outdoors|mandatory)|stays? indoors|windows? (closed|open)|close (all )?windows|seal windows|air purifier|evacuate|avoid (all )?outdoor|outdoor (exercise|activit)|limit (outdoor|long runs|prolonged)|seek (immediate )?medical|go(ing)? outside|should take precautions/i;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(jsx?|mjs)$/.test(e.name) && !/\.test\.js$/.test(e.name) ? [p] : [];
  });
}

test("no file outside healthGuidance.js carries health advice or CPCB impact wording", () => {
  const offenders = [];
  for (const f of sourceFiles(SRC)) {
    if (f.endsWith(`${path.sep}healthGuidance.js`)) continue;
    const code = stripComments(fs.readFileSync(f, "utf8"));
    const m = code.match(ADVICE) || code.match(/May cause (minor )?(breathing|respiratory)/);
    if (m) offenders.push(`${path.relative(SRC, f)}: "${m[0]}"`);
  }
  assert.deepEqual(offenders, []);
});

test("the three consumers import the module (and the voice no longer reads backend text)", () => {
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
  assert.match(read("components/HealthAdvisory.jsx"), /import \{ advisory \} from "\.\.\/lib\/healthGuidance"/);
  assert.match(read("components/ForecastPanel.jsx"), /import \{ voiceSummary \} from "\.\.\/lib\/healthGuidance"/);
  assert.match(read("components/AlertToast.jsx"), /import \{ crossingAlert \} from "\.\.\/lib\/healthGuidance"/);
  assert.doesNotMatch(stripComments(read("components/ForecastPanel.jsx")), /voice_text/);
});
