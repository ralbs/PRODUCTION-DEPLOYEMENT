import { test } from "node:test";
import assert from "node:assert/strict";
import { liveStatus } from "./liveStatus.js";
import { buildHeroModel, STALE_AFTER_MIN } from "./heroModel.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const MIN = 60e3;
const at = (ageMs) => new Date(NOW - ageMs).toISOString();

test("LIVE only while the latest reading is within STALE_AFTER_MIN", () => {
  assert.deepEqual(liveStatus(at(30e3), NOW), { live: true, label: "LIVE" });
  assert.deepEqual(liveStatus(at(STALE_AFTER_MIN * MIN), NOW), { live: true, label: "LIVE" });
  assert.deepEqual(liveStatus(at(STALE_AFTER_MIN * MIN + 1000), NOW), { live: false, label: "OFFLINE", age: "10m ago" });
});

test("offline shows the age: minutes, hours, days (floored)", () => {
  assert.equal(liveStatus(at(47 * MIN), NOW).age, "47m ago");
  assert.equal(liveStatus(at(5.9 * 60 * MIN), NOW).age, "5h ago");
  assert.equal(liveStatus(at(19.5 * 24 * 60 * MIN), NOW).age, "19d ago"); // NEL-001's real case
});

test("no reading yet -> null (no badge), never a guessed LIVE", () => {
  assert.equal(liveStatus(null, NOW), null);
  assert.equal(liveStatus(undefined, NOW), null);
  assert.equal(liveStatus("not a date", NOW), null);
});

test("header and hero agree at every age around the boundary", () => {
  for (const ageMs of [0, 9 * MIN, STALE_AFTER_MIN * MIN, STALE_AFTER_MIN * MIN + 1, 11 * MIN, 3 * 3600e3]) {
    const hero = buildHeroModel({ stationId: "S", latest: { timestamp: at(ageMs), aqi: { aqi: 40 } }, nowMs: NOW });
    assert.equal(liveStatus(at(ageMs), NOW).live, hero.mode === "current", `age ${ageMs}`);
  }
});
