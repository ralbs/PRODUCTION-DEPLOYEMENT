const { calculateAQI, aqiCategory, sanitizePollutants, cpcbConcentrations, subIndex } = require("./aqi");
const Telemetry = require("../models/Telemetry");
const deployment = require("../config/deployment");

const HOUR_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;
const AQI_MAX = 500; // CPCB AQI scale ceiling (lib/aqi.js caps sub-indices here)

// Holt's linear method, smoothing constants as before.
const HW_ALPHA = 0.3;
const HW_BETA = 0.1;
// Damping of the EXTRAPOLATED trend (Gardner & McKenzie style). Undamped,
// a 24-step extrapolation adds 24x the latest slope -- from six noisy
// hours that runs away. With phi = 0.9 the slope's total future
// contribution is bounded by phi/(1-phi) = 9 steps' worth, however long
// the horizon. (Hyndman & Athanasopoulos note phi is rarely below 0.8.)
// Applied to the forecast only, NOT inside the fit: damping in the fit
// recursion underestimated a real, steady 2 AQI/h rise as 1.1-1.3 AQI/h
// and inflated sigma -- mislabelling the trend it's meant to describe.
const HW_PHI = 0.9;
// No line, no band, no trend label (and so no hero trend clause) from
// fewer REAL hours than this -- interpolated hours don't count.
const MIN_REAL_HOURS = 6;
// The band can't be narrower than the index's own resolution (integer AQI).
const SIGMA_FLOOR_AQI = 1;

// Holt linear smoothing (level + trend, no seasonality), fitted undamped;
// the extrapolation's trend is damped by `phi` (see HW_PHI).
//
// sigma is the RMS of the IN-SAMPLE ONE-STEP residuals: at every step the
// model predicts the next value before seeing it, and sigma is the size of
// those misses. (It replaces the old "RMS distance of the last 24 values
// from the FINAL level", which grew with any trend and wasn't a forecast
// error at all.) It's still in-sample -- the initial slope uses the last
// point -- so it's optimistic, not a calibrated interval.
//
// sd[h-1] is the h-step-ahead SD of the fitted (undamped) additive-error
// Holt model, sigma^2 * (1 + sum_{j<h} (alpha*(1 + beta*j))^2) (Hyndman et
// al. 2008, class-1 ETS(A,A,N); alpha*beta is ETS's beta). It is never
// narrower than the damped-trend equivalent, so the band errs wide.
function holtWinters(series, alpha = HW_ALPHA, beta = HW_BETA, horizon = 24, phi = HW_PHI) {
  if (!series || series.length < 3) return null;

  let L = series[0];
  let b = (series[series.length - 1] - series[0]) / (series.length - 1);
  const residuals = [];

  for (let i = 1; i < series.length; i++) {
    const pred = L + b;
    residuals.push(series[i] - pred);
    const prevL = L;
    L = alpha * series[i] + (1 - alpha) * pred;
    b = beta * (L - prevL) + (1 - beta) * b;
  }

  const rms = Math.sqrt(residuals.reduce((acc, r) => acc + r * r, 0) / residuals.length);
  const sigma = Math.max(SIGMA_FLOOR_AQI, rms);

  const forecast = [], sd = [];
  let phiSum = 0, cSq = 0;
  for (let h = 1; h <= horizon; h++) {
    if (h > 1) { const c = alpha * (1 + beta * (h - 1)); cSq += c * c; }
    phiSum += Math.pow(phi, h);
    forecast.push(Math.min(AQI_MAX, Math.max(0, Math.round(L + phiSum * b))));
    sd.push(sigma * Math.sqrt(1 + cSq));
  }

  return { level: L, trend: b, forecast, sigma, sd, residualCount: residuals.length };
}

function trendLabel(b) {
  if (b > 1.5) return "rapidly rising";
  if (b > 0.5) return "rising";
  if (b < -1.5) return "rapidly falling";
  if (b < -0.5) return "falling";
  return "stable";
}

// Devices post every 60 s (firmware/config.h TELEMETRY_INTERVAL_MS). Used
// only to size the DB read for a lookback window; the window itself is
// enforced by timestamp below, so a faster device can't stretch it.
const READINGS_PER_HOUR = 60;
// Consecutive hourly buckets further apart than this are not bridged:
// the fit uses only the contiguous run ending at the newest hour. Up to
// this, missing hours are linearly interpolated (a dropped hour or two of
// Wi-Fi shouldn't throw away a week of history).
const MAX_BRIDGED_GAP_H = 3;

// Readings -> fixed LOCAL-hour buckets (the deployment's UTC offset; for
// IST, +5:30, UTC-hour buckets labelled every hour "x:30"). Each
// pollutant is averaged over the
// hour (after the same sanitising calculateAQI applies, so one garbage
// value can't poison an hour), THEN the AQI is computed on those means --
// CPCB defines the index on averaged concentrations, not averaged indices.
// Returns non-empty buckets oldest-first; `aqi` is null for an hour whose
// readings carried no AQI-bearing pollutant.
function hourlyBuckets(orderedDocs, utcOffsetHours = deployment.utcOffsetHours) {
  const off = utcOffsetHours * HOUR_MS;
  const byHour = new Map();
  for (const d of orderedDocs) {
    const t = new Date(d.timestamp).getTime();
    if (!Number.isFinite(t)) continue;
    const start = Math.floor((t + off) / HOUR_MS) * HOUR_MS - off;
    let b = byHour.get(start);
    if (!b) byHour.set(start, (b = { start, readings: 0, sums: {}, counts: {} }));
    b.readings++;
    for (const [k, v] of Object.entries(sanitizePollutants(d.pollutants || {}))) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      b.sums[k] = (b.sums[k] || 0) + v;
      b.counts[k] = (b.counts[k] || 0) + 1;
    }
  }
  return [...byHour.values()]
    .sort((a, b) => a.start - b.start)
    .map((b) => {
      const means = {};
      for (const k of Object.keys(b.sums)) means[k] = b.sums[k] / b.counts[k];
      return { start: b.start, readings: b.readings, aqi: calculateAQI(means)?.aqi ?? null };
    });
}

// The evenly-spaced hourly series Holt-Winters is fitted on: the
// contiguous run of buckets ending at the newest one, short gaps
// interpolated (flagged), stopping at the first gap > MAX_BRIDGED_GAP_H.
function contiguousHourlySeries(buckets) {
  const real = buckets.filter((b) => b.aqi != null);
  if (!real.length) return [];
  const out = [real[real.length - 1]];
  for (let i = real.length - 2; i >= 0; i--) {
    const cur = real[i], next = out[0];
    const gapH = Math.round((next.start - cur.start) / HOUR_MS);
    if (gapH > MAX_BRIDGED_GAP_H) break;
    for (let h = gapH - 1; h >= 1; h--) {
      out.unshift({ start: cur.start + h * HOUR_MS, aqi: cur.aqi + ((next.aqi - cur.aqi) * h) / gapH, interpolated: true });
    }
    out.unshift(cur);
  }
  return out;
}

// Reads a station's telemetry for the `windowMs` ending at its NEWEST
// reading (by time, not count), oldest-first.
async function recentDocs(stationId, windowMs) {
  const docs = await Telemetry.find({ "meta.station_id": stationId }, { timestamp: 1, pollutants: 1 })
    .sort({ timestamp: -1 })
    .limit(Math.ceil((windowMs / HOUR_MS) * READINGS_PER_HOUR))
    .lean();
  if (!docs.length) return [];
  const newest = new Date(docs[0].timestamp).getTime();
  return docs
    .filter((d) => newest - new Date(d.timestamp).getTime() < windowMs)
    .reverse();
}

// "03:00 pm" in the deployment's local time -- never the server's own
// timezone (Render runs in UTC, which put peak times 5.5 h off).
function localTimeLabel(ms, utcOffsetHours = deployment.utcOffsetHours) {
  return new Date(ms + utcOffsetHours * HOUR_MS)
    .toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "UTC" });
}

// Forecast on HOURLY means. Before this, the series was raw readings and
// every step was treated as an hour -- with 1-minute telemetry the "24h
// forecast" was ~24 minutes of extrapolation stamped as 24 hours, and
// trendLabel's per-hour thresholds were really per-minute. Now a step,
// a prediction timestamp and `lookbackHours` all genuinely mean one hour.
//
// This is a statistical EXTRAPOLATION of the recent trend (damped Holt),
// not a model of the atmosphere -- the response says so (`method`), and
// nothing is returned at all below MIN_REAL_HOURS.
async function buildForecast(stationId, lookbackHours = 168, horizon = 24) {
  const orderedDocs = await recentDocs(stationId, Math.min(lookbackHours, 720) * HOUR_MS);
  if (!orderedDocs.length) return null;

  const buckets = hourlyBuckets(orderedDocs);
  const series = contiguousHourlySeries(buckets);
  const realHours = series.filter((b) => !b.interpolated).length;
  if (realHours < MIN_REAL_HOURS) return null;

  const hw = holtWinters(series.map((b) => b.aqi), HW_ALPHA, HW_BETA, horizon, HW_PHI);
  if (!hw) return null;

  const lastDoc = orderedDocs[orderedDocs.length - 1];
  const currentAQI = calculateAQI(lastDoc.pollutants);
  // Predictions are hourly buckets too, labelled by their start, like history.
  const lastTs = new Date(series[series.length - 1].start);

  const predictions = hw.forecast.map((aqi, i) => {
    const ci = Math.round(hw.sd[i]);
    return {
      timestamp: new Date(lastTs.getTime() + (i + 1) * HOUR_MS).toISOString(),
      aqi,
      aqi_low: Math.max(0, aqi - ci),
      aqi_high: Math.min(AQI_MAX, aqi + ci),
      category: aqiCategory(aqi),
    };
  });

  const trend = trendLabel(hw.trend);
  const peak = Math.max(...hw.forecast);
  const peakIdx = hw.forecast.indexOf(peak);
  const peakTime = localTimeLabel(lastTs.getTime() + (peakIdx + 1) * HOUR_MS);

  const station = stationId.replace("KSPCB-", "");
  const curAqi = currentAQI?.aqi ?? "–";
  const curCat = currentAQI?.category ?? "Unknown";
  const dom = (currentAQI?.dominant_pollutant || "PM2.5").toUpperCase().replace("_", ".");

  let voiceText =
    `Air quality at ${station} station is currently ${curAqi}, ${curCat}. ` +
    `The dominant pollutant is ${dom}. ` +
    `Extrapolating the recent trend, the next 24 hours look ${trend}. `;

  if (peak > (currentAQI?.aqi ?? 0)) {
    voiceText += `The extrapolated peak is AQI ${peak} around ${peakTime}. `;
  }

  if (peak > 300)
    voiceText += "Severe air quality expected. Avoid all outdoor activities.";
  else if (peak > 200)
    voiceText += "Poor air quality expected. Sensitive groups should stay indoors.";
  else if (peak > 100)
    voiceText += "Moderate air quality expected. Consider reducing prolonged outdoor exposure.";
  else
    voiceText += "Air quality should remain acceptable throughout the forecast period.";

  // History for the chart: the last 24 real hourly buckets, each at its own
  // hour (gaps stay gaps -- interpolated fit points are never shown as
  // data; an hour with no AQI-bearing reading is kept as aqi:null).
  const historyAqi = buckets.slice(-24).map((b) => ({
    timestamp: new Date(b.start).toISOString(),
    aqi: b.aqi,
  }));

  return {
    station_id: stationId,
    current_aqi: currentAQI,
    trend,
    peak_predicted: peak,
    peak_time: peakTime,
    predictions,
    history_aqi: historyAqi,
    // Explicit, so a client can refuse to label steps as hours unless the
    // server says they are (the hero's trend clause does exactly that).
    resolution_minutes: 60,
    fit_hours: series.length,
    real_hours: realHours,
    interpolated_hours: series.length - realHours,
    min_real_hours: MIN_REAL_HOURS,
    method: {
      kind: "extrapolation",
      model: "Holt linear fitted on hourly means; extrapolated trend damped by phi",
      alpha: HW_ALPHA, beta: HW_BETA, phi: HW_PHI,
      band: "aqi_low/aqi_high = +/-1 SD; SD from in-sample one-step residuals, widened per step (Holt h-step variance)",
      sigma: Math.round(hw.sigma * 10) / 10,
    },
    voice_text: voiceText,
    generated_at: new Date().toISOString(),
  };
}

// -------------------------------------------------------------------
// checkSpike -- the source-direction worker's trigger
// (ctm-core/scripts/source_direction_worker.py, via GET
// /api/forecast/spike-check). WINDOWED rule, PER POLLUTANT, rises only.
// For each CPCB pollutant's CONCENTRATION:
//
//   recent   = the last SPIKE_RECENT_MIN (the worker's own interval, so a
//              short plume between two runs is still seen), as
//              SPIKE_ROLLING_MIN rolling means; the HIGHEST one is tested
//   baseline = the SPIKE_BASELINE_MIN before that: median, and a robust
//              spread 1.4826*MAD (floored at the channel's resolution)
//   spike    = z >= SPIKE_Z (z = (peak - baseline median) / spread, in
//              concentration) AND that pollutant's CPCB sub-index rose
//              >= SPIKE_MIN_JUMP_AQI
//
// Any pollutant triggers. A drop never triggers (a falling reading isn't a
// new source). If no pollutant has enough baseline/recent points -> null,
// which the route turns into a 404 and the worker records as a skip.
//
// It replaced a one-step Holt-Winters test on the single latest reading
// with a +/-1 sigma band, which on steady 1-minute noise fired on ~29% of
// readings (~1.2 false worker triggers/hour) and still missed most short
// plumes. backend/scripts/spike_threshold_sim.js reproduces the numbers.
// -------------------------------------------------------------------
const SPIKE_RECENT_MIN = 15;          // = worker cron interval (render.yaml "*/15 * * * *")
const SPIKE_ROLLING_MIN = 5;
const SPIKE_ROLLING_MIN_POINTS = 3;   // a "5-min mean" of 1-2 readings is just a reading
const SPIKE_BASELINE_MIN = 60;
const SPIKE_MIN_BASELINE_POINTS = 30; // half the hour at the 60 s device cadence
const SPIKE_Z = 3;
const SPIKE_MIN_JUMP_AQI = 20;        // on the triggering pollutant's CPCB sub-index

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// PER POLLUTANT, IN CONCENTRATION. The AQI is max(sub-indices), so testing
// it hides a large rise in any pollutant that isn't dominant (an NO2 plume
// under a high PM2.5 AQI doesn't move the AQI at all), and its piecewise
// slopes change the noise scale at every breakpoint. So each pollutant is
// tested on its own concentration (where sensor noise lives), and the
// +SPIKE_MIN_JUMP_AQI gate is applied to THAT pollutant's CPCB sub-index
// (where health relevance lives). Any pollutant can trigger.
const SPIKE_POLLUTANTS = ["pm2_5", "pm10", "no2", "o3", "co", "nh3"];
// Spread floors at each channel's resolution: PMS5003 reports integer
// ug/m3; gas channels are derived floats (ug/m3; CO in mg/m3).
const SPIKE_SPREAD_FLOOR = { pm2_5: 1, pm10: 1, no2: 1, o3: 1, co: 0.01, nh3: 1 };

// Pure: the windowed statistics over {t, v} points (oldest-first) of ONE
// series. Returns null when there aren't enough points to judge.
function windowedSpike(points, spreadFloor = 1) {
  if (!points.length) return null;
  const T = points[points.length - 1].t;
  const recentStart = T - SPIKE_RECENT_MIN * MIN_MS;
  const baseStart = recentStart - SPIKE_BASELINE_MIN * MIN_MS;
  const recent = points.filter((p) => p.t > recentStart);
  const baseline = points.filter((p) => p.t > baseStart && p.t <= recentStart).map((p) => p.v);
  if (baseline.length < SPIKE_MIN_BASELINE_POINTS) return null;

  let peak = null;
  for (const p of recent) {
    const w = recent.filter((q) => q.t > p.t - SPIKE_ROLLING_MIN * MIN_MS && q.t <= p.t);
    if (w.length < SPIKE_ROLLING_MIN_POINTS) continue;
    const mean = w.reduce((acc, q) => acc + q.v, 0) / w.length;
    if (!peak || mean > peak.mean) peak = { mean, t: p.t };
  }
  if (!peak) return null;

  const base = median(baseline);
  const spread = Math.max(spreadFloor, 1.4826 * median(baseline.map((x) => Math.abs(x - base))));
  return { peak_mean: peak.mean, peak_t: peak.t, base, spread, z: (peak.mean - base) / spread, baseline_points: baseline.length };
}

// Pure: every pollutant's verdict, from readings [{t, conc}] oldest-first
// (conc = aqi.js cpcbConcentrations()). `trigger` is the pollutant that
// fired with the biggest sub-index jump, or, if none fired, the closest
// (highest z) so near-misses are still reported.
function perPollutantSpike(readings) {
  const results = [];
  for (const p of SPIKE_POLLUTANTS) {
    const pts = readings.filter((r) => Number.isFinite(r.conc[p])).map((r) => ({ t: r.t, v: r.conc[p] }));
    const w = windowedSpike(pts, SPIKE_SPREAD_FLOOR[p]);
    if (!w) continue;
    const siBase = subIndex(p, w.base) ?? 0, siPeak = subIndex(p, w.peak_mean) ?? 0;
    const jump = siPeak - siBase;
    results.push({
      pollutant: p, ...w, si_base: siBase, si_peak: siPeak, jump_aqi: jump,
      si_threshold: Math.max(subIndex(p, w.base + SPIKE_Z * w.spread) ?? 0, siBase + SPIKE_MIN_JUMP_AQI),
      is_spike: w.z >= SPIKE_Z && jump >= SPIKE_MIN_JUMP_AQI,
    });
  }
  if (!results.length) return null;
  const fired = results.filter((r) => r.is_spike).sort((a, b) => b.jump_aqi - a.jump_aqi);
  const trigger = fired[0] ?? [...results].sort((a, b) => b.z - a.z)[0];
  return { is_spike: fired.length > 0, trigger, results };
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

async function checkSpike(stationId) {
  const docs = await recentDocs(stationId, (SPIKE_RECENT_MIN + SPIKE_BASELINE_MIN) * MIN_MS);
  const readings = docs
    .map((d) => ({ t: new Date(d.timestamp).getTime(), ts: d.timestamp, conc: cpcbConcentrations(d.pollutants) }))
    .filter((r) => Number.isFinite(r.t));
  const r = perPollutantSpike(readings);
  if (!r) return null;
  const tr = r.trigger;

  return {
    station_id: stationId,
    rule: "windowed-per-pollutant",
    is_spike: r.is_spike,
    pollutant: tr.pollutant,
    // Field names kept for the worker's trigger payload (SourceDirection
    // requires all five). All in the TRIGGERING pollutant's CPCB sub-index
    // units, except sigma (its concentration units, see sigma_unit):
    actual_aqi: round1(tr.si_peak),           // sub-index of the peak 5-min mean
    predicted_aqi: round1(tr.si_base),        // sub-index of the baseline median
    predicted_low: round1(tr.si_base),        // rises only: there is no lower trigger bound
    predicted_high: round1(tr.si_threshold),  // sub-index the peak had to reach
    sigma: tr.pollutant === "co" ? round2(tr.spread) : round1(tr.spread),
    sigma_unit: tr.pollutant === "co" ? "mg/m3" : "ug/m3",
    z: round2(tr.z),
    jump_aqi: round1(tr.jump_aqi),
    baseline_points: tr.baseline_points,
    timestamp: readings.find((x) => x.t === tr.peak_t).ts, // reading that ends the peak window
    // Every pollutant's verdict, for the record.
    pollutants: Object.fromEntries(r.results.map((x) => [x.pollutant, { z: round2(x.z), jump_aqi: round1(x.jump_aqi), is_spike: x.is_spike }])),
  };
}

module.exports = {
  buildForecast, checkSpike, windowedSpike, perPollutantSpike, holtWinters, hourlyBuckets, contiguousHourlySeries,
  MIN_REAL_HOURS, HW_PHI, AQI_MAX,
  SPIKE_RECENT_MIN, SPIKE_ROLLING_MIN, SPIKE_BASELINE_MIN, SPIKE_MIN_BASELINE_POINTS, SPIKE_Z, SPIKE_MIN_JUMP_AQI,
  SPIKE_POLLUTANTS,
};
