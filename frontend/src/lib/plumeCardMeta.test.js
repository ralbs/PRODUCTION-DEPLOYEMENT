import { test } from "node:test";
import assert from "node:assert/strict";
import { plumeCardMeta } from "./plumeCardMeta.js";

const reading = { pollutants: { pm2_5: 20 } };
const okWind = (speed) => ({ status: "ok", data: { speed_m_s: speed, dir_from_deg: 297 } });

test("never claims live calculation when there is no live wind", () => {
  const m = plumeCardMeta({ status: "unavailable", data: null }, reading);
  assert.equal(m, "Not calculated — no live wind");
  assert.doesNotMatch(m, /calculated from|live data/i);
});

test("loading, calm, and missing-reading states each say so", () => {
  assert.equal(plumeCardMeta({ status: "loading", data: null }, reading), "Loading live wind…");
  assert.equal(plumeCardMeta(okWind(0), reading), "Not calculated — calm air");
  assert.equal(plumeCardMeta(okWind(4.38), null), "Not calculated — no sensor reading");
  assert.equal(plumeCardMeta(undefined, reading), "Not calculated — no live wind");
});

test("when a plume is drawn: live wind + LATEST reading, not 'live data'", () => {
  const m = plumeCardMeta(okWind(4.38), reading);
  assert.equal(m, "From live wind + latest reading");
  assert.doesNotMatch(m, /live data/i);
});
