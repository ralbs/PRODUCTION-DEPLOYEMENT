import { test } from "node:test";
import assert from "node:assert/strict";
import { downwindBearing, compassPoint } from "./wind.js";

test("FROM-direction -> downwind (plume travel) bearing is +180", () => {
  // Wind FROM the west blows the plume TOWARD the east, etc.
  assert.equal(downwindBearing(270), 90);
  assert.equal(downwindBearing(0), 180);
  assert.equal(downwindBearing(90), 270);
  assert.equal(downwindBearing(180), 0);
  // NEL-001's real live reading: 298 (from WNW) -> plume heads 118 (ESE).
  assert.equal(downwindBearing(298), 118);
  assert.equal(downwindBearing(360), 180);
});

test("compass point labels, including wraparound", () => {
  assert.equal(compassPoint(298), "WNW");
  assert.equal(compassPoint(118), "ESE");
  assert.equal(compassPoint(0), "N");
  assert.equal(compassPoint(359), "N");
  assert.equal(compassPoint(360), "N");
  assert.equal(compassPoint(22.5), "NNE");
});
