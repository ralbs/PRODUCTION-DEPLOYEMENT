import { test } from "node:test";
import assert from "node:assert/strict";
import { isTestStation, pickDefaultStation } from "./stations.js";

const NEL = { station_id: "NEL-001", device_id: "ESP32-001", last_seen: "2026-09-08T20:45:00Z" };
const TEST = { station_id: "TEST-STATION-001", device_id: "TEST-DEVICE-001", last_seen: "2026-09-08T20:50:00Z" };

test("test/stub stations are recognised by station or device id", () => {
  assert.equal(isTestStation(TEST), true);
  assert.equal(isTestStation({ station_id: "X-1", device_id: "stub_dev" }), true);
  assert.equal(isTestStation(NEL), false);
  // "test" inside a word is not a test station
  assert.equal(isTestStation({ station_id: "CONTEST-01", device_id: "ESP32-9" }), false);
});

test("defaults to NEL-001 even when a test station is first and newer", () => {
  assert.equal(pickDefaultStation([TEST, NEL]), "NEL-001");
});

test("never defaults to a test station: only test stations -> null", () => {
  assert.equal(pickDefaultStation([TEST]), null);
  assert.equal(pickDefaultStation([]), null);
  assert.equal(pickDefaultStation(undefined), null);
});

test("without NEL-001, the most recently seen real station", () => {
  const a = { station_id: "NEL-002", device_id: "ESP32-002", last_seen: "2026-09-01T00:00:00Z" };
  const b = { station_id: "NEL-003", device_id: "ESP32-003", last_seen: "2026-09-05T00:00:00Z" };
  assert.equal(pickDefaultStation([TEST, a, b]), "NEL-003");
});

test("a real station with no last_seen has never reported -> not a default", () => {
  assert.equal(pickDefaultStation([{ station_id: "NEL-001", device_id: "ESP32-001" }, TEST]), null);
});
