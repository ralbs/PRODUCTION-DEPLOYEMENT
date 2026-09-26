import { test } from "node:test";
import assert from "node:assert/strict";
import { calcAQHI, ugm3ToPpb } from "./healthIndices.js";

test("µg/m³ -> ppb uses 24.45 / MW (25 °C, 1 atm)", () => {
  // Standard reference factors: 1 ppb NO2 = 1.88 µg/m³, 1 ppb O3 = 1.96 µg/m³.
  assert.ok(Math.abs(ugm3ToPpb(1.88, "no2") - 1) < 0.001);
  assert.ok(Math.abs(ugm3ToPpb(1.963, "o3") - 1) < 0.001);
});

test("NEL-001's real reading gives AQHI 1.6, not the unconverted 2.2", () => {
  // Live NEL-001 document 2026-09-08T20:45Z: pm2_5 20, no2 15 µg/m³, o3 -1
  // (O3 pin not connected -> treated as absent).
  const aqhi = calcAQHI({ pm2_5: 20, no2: 15, o3: null });
  assert.equal(aqhi, 1.6);
  assert.notEqual(aqhi, 2.2, "2.2 is what feeding µg/m³ straight into the ppb coefficient gives");
});

test("O3 is converted too, not just NO2", () => {
  // 100 µg/m³ O3 = 50.94 ppb -> (1000/10.4) × (exp(0.000537 × 50.94) − 1) = 2.66 -> 2.7.
  // Unconverted it would be (1000/10.4) × (exp(0.0537) − 1) = 5.3.
  assert.equal(calcAQHI({ pm2_5: 0, no2: 0, o3: 100 }), 2.7);
});

test("PM2.5 is NOT converted (Stieb's PM2.5 coefficient is per µg/m³)", () => {
  // (1000/10.4) × (exp(0.000487 × 35) − 1) = 1.653 -> 1.7
  assert.equal(calcAQHI({ pm2_5: 35, no2: 0, o3: 0 }), 1.7);
});
