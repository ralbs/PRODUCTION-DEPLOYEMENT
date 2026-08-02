/**
 * fit-co.js — calibrate the MQ-7 CO channel against KSPCB reference data.
 *
 * The firmware ships mq7_co from datasheet coefficients that are orders of
 * magnitude off. This script fits a per-device power law
 *
 *      ppm = a * ratio^b        (ratio = Rs/R0 from raw ADC voltage + baseline)
 *
 * using the KSPCB reference already seeded in the telemetries collection.
 *
 * ── Reference caveat (read this) ────────────────────────────────────────────
 * The seeded KSPCB data is historical (2018–2023); the device is live now, so
 * timestamps never overlap. Instead of a true co-located regression this fits
 * the DIURNAL CLIMATOLOGY: the device's hour-of-day mean ratio against the
 * nearest KSPCB station's hour-of-day mean CO (all seeded years). That anchors
 * the sensor's scale to typical urban CO levels but is NOT a same-place,
 * same-time calibration — expect a rough, imperfect fit. A span-gas bump test
 * or a live co-located reference would be the rigorous upgrade.
 *
 * Acceptance (all required, else nothing is saved):
 *   - enough hours of device coverage            (MIN_HOURS)
 *   - enough R² on the log-log fit               (MIN_R2)
 *   - a physically-sane negative exponent        (-20 < b < -0.5)
 *
 * Usage:  node backend/scripts/fit-co.js
 * Env:    DEVICE_ID (default ESP32-001), FROM_DAYS (default 14),
 *         MIN_HOURS (12), MIN_R2 (0.25)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Telemetry    = require("../models/Telemetry");
const Calibration  = require("../models/Calibration");

// ── config ────────────────────────────────────────────────────────────────────
const DEVICE_ID      = process.env.DEVICE_ID || "ESP32-001";
const FROM_DAYS      = parseInt(process.env.FROM_DAYS || "14", 10);
const MIN_HOURS      = parseInt(process.env.MIN_HOURS || "12", 10);
const MIN_R2         = parseFloat(process.env.MIN_R2 || "0.25");
const MIN_ROWS_HOUR  = 10;   // min 1-min device rows to trust an hour-of-day mean
const DEFAULT_LAT    = 14.442;
const DEFAULT_LON    = 79.986;

const GAS_VC = 5.0;
const RATIO_MIN = 0.02;
const RATIO_MAX = 20.0;
const MW_CO = 28.01;
const MOLAR_VOL_25C = 24.45;
const UG_PER_PPM_CO = (MW_CO * 1000) / MOLAR_VOL_25C; // ≈ 1145.5

const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Mirror of firmware rsRatio() with the operating-range clamp. */
function ratioFromDiag(diag) {
  const v = diag?.ads2_voltages?.mq7;
  const bl = diag?.baselines?.mq7;
  if (typeof v !== "number" || typeof bl !== "number") return null;
  if (v <= 0.01 || v >= GAS_VC || bl <= 0.01 || bl >= GAS_VC) return null;
  const r = ((GAS_VC - v) * bl) / (v * (GAS_VC - bl));
  if (r < RATIO_MIN || r > RATIO_MAX) return null;
  return r;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

async function main() {
  await connectDB();

  const from = new Date(Date.now() - FROM_DAYS * 86400_000);

  // ── device location (fall back to config) ──
  const latestDev = await Telemetry.findOne({ "meta.device_id": DEVICE_ID })
    .sort({ timestamp: -1 })
    .select("location")
    .lean();
  const devLat = latestDev?.location?.lat ?? DEFAULT_LAT;
  const devLon = latestDev?.location?.lon ?? DEFAULT_LON;

  // ── nearest KSPCB station ──
  const stations = await Telemetry.aggregate([
    { $match: { "meta.station_id": /^KSPCB-/ } },
    {
      $group: {
        _id: "$meta.station_id",
        lat: { $first: "$location.lat" },
        lon: { $first: "$location.lon" },
      },
    },
  ]);
  let nearest = null;
  let nearestKm = Infinity;
  for (const s of stations) {
    if (s.lat == null || s.lon == null) continue;
    const d = haversineKm(devLat, devLon, s.lat, s.lon);
    if (d < nearestKm) { nearestKm = d; nearest = s._id; }
  }
  if (!nearest) {
    console.error("[fit] No KSPCB stations found in DB — run scripts/seed-kspcb.js first.");
    process.exit(1);
  }
  console.log(`[fit] Device ${DEVICE_ID} @ (${devLat}, ${devLon})`);
  console.log(`[fit] Nearest KSPCB station: ${nearest} — ${nearestKm.toFixed(1)} km away`);
  console.log(`[fit] Window: last ${FROM_DAYS} days (from ${from.toISOString()})`);
  console.log("");

  // ── device ratios, bucketed by hour-of-day ──
  const devRows = await Telemetry.find({
    "meta.device_id": DEVICE_ID,
    timestamp: { $gte: from },
    "diagnostics.ads2_voltages.mq7": { $type: "number" },
    "diagnostics.baselines.mq7": { $type: "number" },
  })
    .select("timestamp diagnostics")
    .lean();
  console.log(`[fit] Device rows with diagnostics: ${devRows.length}`);

  const allRatios = [];
  const hourRatios = Array.from({ length: 24 }, () => []);
  for (const row of devRows) {
    const r = ratioFromDiag(row.diagnostics);
    if (r == null) continue;
    allRatios.push(r);
    hourRatios[new Date(row.timestamp).getHours()].push(r);
  }
  console.log(`[fit] Valid device ratios: ${allRatios.length}`);

  const devHour = hourRatios
    .map((arr, hour) =>
      arr.length >= MIN_ROWS_HOUR ? { hour, ratio: mean(arr), n: arr.length } : null
    )
    .filter(Boolean);

  // ── KSPCB CO climatology (hour-of-day mean, all seeded years) ──
  const refRows = await Telemetry.find({
    "meta.station_id": nearest,
    "pollutants.mq7_co": { $gt: 0 },
  })
    .select("timestamp pollutants.mq7_co")
    .lean();
  const refHour = Array.from({ length: 24 }, () => []);
  for (const row of refRows) {
    const ug = row.pollutants.mq7_co;
    if (ug > 0) refHour[new Date(row.timestamp).getHours()].push(ug);
  }
  const refByHour = refHour
    .map((arr, hour) => (arr.length ? { hour, ugm3: mean(arr), n: arr.length } : null))
    .filter(Boolean);
  console.log(`[fit] KSPCB reference CO rows: ${refRows.length}`);
  console.log(`[fit] Device hours covered: ${devHour.length}, KSPCB hours with data: ${refByHour.length}`);
  console.log("");

  // ── join + log-log regression ──
  const points = [];
  for (const d of devHour) {
    const ref = refByHour.find((r) => r.hour === d.hour);
    if (!ref) continue;
    const ppm = ref.ugm3 / UG_PER_PPM_CO;
    if (ppm <= 0) continue;
    points.push({ hour: d.hour, ratio: d.ratio, devN: d.n, refUgm3: ref.ugm3, refPpm: ppm });
  }

  console.log("[fit] Hour | devRatio(mean) | refCO µg/m³ (mean) | ref ppm");
  for (const p of points) {
    console.log(
      `[fit]  ${String(p.hour).padStart(2)}  |    ${p.ratio.toFixed(4)}      |     ${p.refUgm3.toFixed(1)}       | ${p.refPpm.toFixed(3)}`
    );
  }

  if (points.length < MIN_HOURS) {
    console.log(`\n[fit] ✗ Only ${points.length} hours of device coverage — need ≥ ${MIN_HOURS}. Collect more data and re-run.`);
    console.log("[fit] Nothing saved.");
    await mongoose.disconnect();
    return;
  }

  const n = points.length;
  const xs = points.map((p) => Math.log(p.ratio));
  const ys = points.map((p) => Math.log(p.refPpm));
  const sx = xs.reduce((s, v) => s + v, 0);
  const sy = ys.reduce((s, v) => s + v, 0);
  const sxx = xs.reduce((s, v) => s + v * v, 0);
  const sxy = xs.reduce((s, v, i) => s + v * ys[i], 0);

  const denom = n * sxx - sx * sx;
  const b = denom !== 0 ? (n * sxy - sx * sy) / denom : NaN;
  const a = (sy - b * sx) / n;
  const A = Math.exp(a);

  // R² (log-log)
  const yMean = sy / n;
  const ssRes = ys.reduce((s, v, i) => s + (v - (a + b * xs[i])) ** 2, 0);
  const ssTot = ys.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;

  // MAE in µg/m³
  const mae = mean(
    points.map((p) => {
      const predUgm3 = A * Math.pow(p.ratio, b) * UG_PER_PPM_CO;
      return Math.abs(predUgm3 - p.refUgm3);
    })
  );

  const sortedRatios = [...allRatios].sort((x, y) => x - y);
  const validRatioMin = percentile(sortedRatios, 0.02);
  const validRatioMax = percentile(sortedRatios, 0.98);

  console.log(`\n[fit] Fit (log-log):  ln(ppm) = ${a.toFixed(4)} + ${b.toFixed(4)} · ln(ratio)`);
  console.log(`[fit] Power law:      ppm = ${A.toFixed(4)} · ratio^${b.toFixed(4)}`);
  console.log(`[fit] R² = ${r2.toFixed(4)}   (n = ${n} hours)   MAE = ${mae.toFixed(1)} µg/m³`);
  console.log(`[fit] Valid ratio window: [${validRatioMin.toFixed(4)}, ${validRatioMax.toFixed(4)}]`);

  const saneB = b < -0.5 && b > -20;
  const pass = points.length >= MIN_HOURS && r2 >= MIN_R2 && saneB && A > 0;

  if (!pass) {
    console.log("\n[fit] ✗ Fit did NOT pass acceptance bar:");
    if (points.length < MIN_HOURS) console.log(`       - hours ${points.length} < ${MIN_HOURS}`);
    if (r2 < MIN_R2) console.log(`       - R² ${r2.toFixed(3)} < ${MIN_R2} (reference is ~${nearestKm.toFixed(0)} km away and historical)`);
    if (!saneB) console.log(`       - exponent b=${b.toFixed(3)} not in (−20, −0.5)`);
    console.log("[fit] Nothing saved.");
    await mongoose.disconnect();
    return;
  }

  await Calibration.updateOne(
    { device_id: DEVICE_ID, channel: "mq7_co" },
    {
      $set: {
        model: { a: A, b },
        validRatioMin,
        validRatioMax,
        metrics: { r2, mae, n },
        fittedAt: new Date(),
      },
    },
    { upsert: true }
  );

  console.log("\n[fit] ✓ Calibration SAVED for " + DEVICE_ID + "/mq7_co");
  console.log("[fit] To let CO enter the AQI, set TRUSTED_GAS_CHANNELS=mq7_co on the backend.");
  console.log(`[fit] Reminder: reference is ${nearest} climatology (2018–2023), ${nearestKm.toFixed(0)} km away — treat as a rough scale correction, not a certified measurement.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[fit] Fatal:", err);
  process.exit(1);
});
