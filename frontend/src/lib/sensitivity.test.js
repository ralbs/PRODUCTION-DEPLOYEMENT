import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, resolveSensitivity, loadSensitivity, saveSensitivity, personalLine } from "./sensitivity.js";
import { cpcbBand } from "./heroModel.js";

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test("presets sit on the CPCB category edge whose impact names that group", () => {
  assert.equal(cpcbBand(PRESETS.sensitive.threshold).category, "Satisfactory");
  assert.equal(cpcbBand(PRESETS.sensitive.threshold - 1).category, "Good");
  assert.match(cpcbBand(PRESETS.sensitive.threshold).impact, /sensitive people/);
  assert.equal(cpcbBand(PRESETS.general.threshold).category, "Poor");
  assert.equal(cpcbBand(PRESETS.general.threshold - 1).category, "Moderately polluted");
});

test("malformed prefs fall back to the general preset", () => {
  for (const bad of [null, {}, { kind: "nope" }, { kind: "custom", threshold: 0 },
    { kind: "custom", threshold: 501 }, { kind: "custom", threshold: 42.5 }, { kind: "custom", threshold: "abc" }]) {
    assert.equal(resolveSensitivity(bad).threshold, 201, JSON.stringify(bad));
  }
  assert.deepEqual(resolveSensitivity({ kind: "custom", threshold: "30" }), { kind: "custom", label: "Your own threshold", threshold: 30 });
});

test("round-trips through storage; missing or throwing storage still works", () => {
  const s = memStore();
  saveSensitivity({ kind: "custom", threshold: 30 }, s);
  assert.equal(loadSensitivity(s).threshold, 30);
  saveSensitivity({ kind: "sensitive" }, s);
  assert.equal(loadSensitivity(s).kind, "sensitive");
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(loadSensitivity(throwing).kind, "general");
  assert.equal(saveSensitivity({ kind: "sensitive" }, throwing).kind, "sensitive");
  assert.equal(loadSensitivity(undefined).kind, "general");
  const junk = { getItem: () => "{not json", setItem() {} };
  assert.equal(loadSensitivity(junk).kind, "general");
});

test("personal line: comparison only, past tense when stale, none without a reading", () => {
  const sens = resolveSensitivity({ kind: "sensitive" });
  assert.deepEqual(personalLine(72, "current", sens),
    { above: true, text: "This is at or above your alert level (AQI 51+, sensitive groups)." });
  assert.equal(personalLine(51, "current", sens).above, true);   // edge is inclusive
  assert.equal(personalLine(50, "current", sens).above, false);
  assert.match(personalLine(33, "stale", sens).text, /^That reading was below your alert level/);
  assert.equal(personalLine(null, "current", sens), null);
  assert.equal(personalLine(40, "loading", sens), null);
  assert.doesNotMatch(personalLine(300, "current", sens).text, /mask|indoors|avoid|window/i);
});
