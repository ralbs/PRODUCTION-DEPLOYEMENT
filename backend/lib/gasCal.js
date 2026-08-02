/*
 * gasCal.js — apply a stored per-channel calibration to telemetry on read.
 *
 * The firmware ships MQ-7 CO computed from datasheet curve coefficients, which
 * are orders of magnitude off. Once a Calibration document exists for a device
 * (written by scripts/fit-co.js), every read path recomputes mq7_co from the
 * raw diagnostic voltage + baseline the firmware already sends:
 *
 *   ratio = ((VCC - V_now) * R0) / (V_now * (VCC - R0))
 *   ppm   = a * ratio^b
 *   µg/m³ = ppm * MW_CO * 1000 / 24.45
 *
 * If the calibration is present but the row lacks diagnostics (or the ratio is
 * outside the fitted window) mq7_co is set to null rather than trusting the
 * firmware's placeholder. Calibration lookups are cached with a short TTL.
 */

const Calibration = require("../models/Calibration");

const MW_CO = 28.01;
const MOLAR_VOL_25C = 24.45;
const GAS_VC = 5.0;
const UG_PER_PPM_CO = (MW_CO * 1000) / MOLAR_VOL_25C; // ≈ 1145.5 µg/m³ per ppm

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // "device:channel" -> { value, expiresAt }

/**
 * Cached lookup of the newest calibration for a device+channel.
 * Returns a lean doc, or null when none exists.
 */
async function getCalibration(deviceId, channel) {
  const key = `${deviceId}:${channel}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let doc = null;
  try {
    doc = await Calibration.findOne({ device_id: deviceId, channel })
      .sort({ fittedAt: -1 })
      .lean();
  } catch (err) {
    console.error("[gasCal] calibration lookup failed:", err.message);
  }
  cache.set(key, { value: doc || null, expiresAt: Date.now() + CACHE_TTL_MS });
  return doc || null;
}

/** Mirror of the firmware's rsRatio() — returns NaN-like null on guard trip. */
function rsRatio(vNow, vBaseline) {
  if (vBaseline <= 0.01 || vBaseline >= GAS_VC || vNow <= 0.01 || vNow >= GAS_VC) return null;
  return ((GAS_VC - vNow) * vBaseline) / (vNow * (GAS_VC - vBaseline));
}

/**
 * Returns a copy of `pollutants` with mq7_co replaced by the calibrated value
 * when a valid calibration exists for this device. Never mutates the stored doc.
 */
async function applyCalibration(pollutants, diagnostics, deviceId) {
  if (!pollutants || typeof pollutants !== "object") return pollutants || {};
  const out = { ...pollutants };
  if (!deviceId || !diagnostics) return out;

  const cal = await getCalibration(deviceId, "mq7_co");
  if (!cal) return out; // no calibration yet — sanitize will null the gas channel

  const vNow = diagnostics.ads2_voltages && diagnostics.ads2_voltages.mq7;
  const vBase = diagnostics.baselines && diagnostics.baselines.mq7;

  if (vNow == null || vBase == null ||
      typeof vNow !== "number" || typeof vBase !== "number") {
    out.mq7_co = null; // calibration exists but no raw data to calibrate with
    return out;
  }

  const ratio = rsRatio(vNow, vBase);
  if (ratio == null ||
      ratio < cal.validRatioMin || ratio > cal.validRatioMax) {
    out.mq7_co = null; // outside the fitted window — do not extrapolate
    return out;
  }

  const ppm = cal.model.a * Math.pow(ratio, cal.model.b);
  out.mq7_co = Math.round(ppm * UG_PER_PPM_CO * 10) / 10;
  return out;
}

module.exports = { applyCalibration, getCalibration, rsRatio };
