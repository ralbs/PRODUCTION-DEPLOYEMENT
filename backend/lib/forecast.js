const { calculateAQI, aqiCategory, sanitizePollutants } = require("./aqi");
const Telemetry = require("../models/Telemetry");

// Holt-Winters double exponential smoothing (level + trend, no seasonality)
function holtWinters(series, alpha = 0.3, beta = 0.1, horizon = 24) {
  if (!series || series.length < 3) return null;

  let L = series[0];
  let b = (series[series.length - 1] - series[0]) / (series.length - 1);

  for (let i = 1; i < series.length; i++) {
    const prevL = L;
    L = alpha * series[i] + (1 - alpha) * (L + b);
    b = beta * (L - prevL) + (1 - beta) * b;
  }

  const forecast = [];
  for (let h = 1; h <= horizon; h++) {
    forecast.push(Math.max(0, Math.round(L + h * b)));
  }

  // Simple confidence interval: ±1 std dev of residuals scaled by horizon
  const residuals = series.slice(-24).map((v) => Math.abs(v - L));
  const sigma = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length) || 10;

  return { level: L, trend: b, forecast, sigma };
}

function trendLabel(b) {
  if (b > 1.5) return "rapidly rising";
  if (b > 0.5) return "rising";
  if (b < -1.5) return "rapidly falling";
  if (b < -0.5) return "falling";
  return "stable";
}

const HOUR_MS = 3600 * 1000;
// Devices post every 60 s (firmware/config.h TELEMETRY_INTERVAL_MS). Used
// only to size the DB read for a lookback window; the window itself is
// enforced by timestamp below, so a faster device can't stretch it.
const READINGS_PER_HOUR = 60;
// Consecutive hourly buckets further apart than this are not bridged:
// the fit uses only the contiguous run ending at the newest hour. Up to
// this, missing hours are linearly interpolated (a dropped hour or two of
// Wi-Fi shouldn't throw away a week of history).
const MAX_BRIDGED_GAP_H = 3;

// Readings -> fixed UTC-hour buckets. Each pollutant is averaged over the
// hour (after the same sanitising calculateAQI applies, so one garbage
// value can't poison an hour), THEN the AQI is computed on those means --
// CPCB defines the index on averaged concentrations, not averaged indices.
// Returns non-empty buckets oldest-first; `aqi` is null for an hour whose
// readings carried no AQI-bearing pollutant.
function hourlyBuckets(orderedDocs) {
  const byHour = new Map();
  for (const d of orderedDocs) {
    const t = new Date(d.timestamp).getTime();
    if (!Number.isFinite(t)) continue;
    const start = Math.floor(t / HOUR_MS) * HOUR_MS;
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

// Reads the newest `lookbackHours` of a station's telemetry, by time.
async function recentDocs(stationId, lookbackHours) {
  const hours = Math.min(lookbackHours, 720);
  const docs = await Telemetry.find({ "meta.station_id": stationId }, { timestamp: 1, pollutants: 1 })
    .sort({ timestamp: -1 })
    .limit(hours * READINGS_PER_HOUR)
    .lean();
  if (!docs.length) return [];
  const newest = new Date(docs[0].timestamp).getTime();
  return docs
    .filter((d) => newest - new Date(d.timestamp).getTime() < hours * HOUR_MS)
    .reverse();
}

// Forecast on HOURLY means. Before this, the series was raw readings and
// every step was treated as an hour -- with 1-minute telemetry the "24h
// forecast" was ~24 minutes of extrapolation stamped as 24 hours, and
// trendLabel's per-hour thresholds were really per-minute. Now a step,
// a prediction timestamp and `lookbackHours` all genuinely mean one hour.
async function buildForecast(stationId, lookbackHours = 168, horizon = 24) {
  const orderedDocs = await recentDocs(stationId, lookbackHours);
  if (!orderedDocs.length) return null;

  const buckets = hourlyBuckets(orderedDocs);
  const series = contiguousHourlySeries(buckets);
  if (series.length < 3) return null;

  const hw = holtWinters(series.map((b) => b.aqi), 0.3, 0.1, horizon);
  if (!hw) return null;

  const lastDoc = orderedDocs[orderedDocs.length - 1];
  const currentAQI = calculateAQI(lastDoc.pollutants);
  // Predictions are hourly buckets too, labelled by their start, like history.
  const lastTs = new Date(series[series.length - 1].start);

  const predictions = hw.forecast.map((aqi, i) => {
    const ci = Math.round(hw.sigma * Math.sqrt(i + 1));
    return {
      timestamp: new Date(lastTs.getTime() + (i + 1) * HOUR_MS).toISOString(),
      aqi,
      aqi_low: Math.max(0, aqi - ci),
      aqi_high: aqi + ci,
      category: aqiCategory(aqi),
    };
  });

  const trend = trendLabel(hw.trend);
  const peak = Math.max(...hw.forecast);
  const peakIdx = hw.forecast.indexOf(peak);
  const peakTs = new Date(lastTs.getTime() + (peakIdx + 1) * HOUR_MS);
  const peakTime = peakTs.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

  const station = stationId.replace("KSPCB-", "");
  const curAqi = currentAQI?.aqi ?? "–";
  const curCat = currentAQI?.category ?? "Unknown";
  const dom = (currentAQI?.dominant_pollutant || "PM2.5").toUpperCase().replace("_", ".");

  let voiceText =
    `Air quality at ${station} station is currently ${curAqi}, ${curCat}. ` +
    `The dominant pollutant is ${dom}. ` +
    `The 24-hour forecast trend is ${trend}. `;

  if (peak > (currentAQI?.aqi ?? 0)) {
    voiceText += `Peak AQI of ${peak} is expected at ${peakTime}. `;
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
    interpolated_hours: series.filter((b) => b.interpolated).length,
    voice_text: voiceText,
    generated_at: new Date().toISOString(),
  };
}

// -------------------------------------------------------------------
// checkSpike — is the LATEST real reading for a station outside its own
// one-step-ahead Holt-Winters confidence interval? Reuses holtWinters()
// verbatim (same function buildForecast() above uses) -- fit EXCLUDES the
// latest reading (so the interval is a genuine before-the-fact forecast,
// not one that already saw the point it's being tested against), then
// compares the actual latest AQI against [predicted +/- sigma*sqrt(1)].
// This is the spike trigger for the source-direction worker
// (scripts/source_direction_worker.py) -- see PROMPT_FLOW_INTEGRATION.md.
// -------------------------------------------------------------------
async function checkSpike(stationId, lookbackHours = 168) {
  const docs = await Telemetry.find({ "meta.station_id": stationId })
    .sort({ timestamp: -1 })
    .limit(Math.min(lookbackHours, 720))
    .lean();

  if (!docs.length) return null;

  const orderedDocs = [...docs].reverse();
  const aqiSeries = orderedDocs
    .map((d) => calculateAQI(d.pollutants)?.aqi ?? null)
    .filter((v) => v !== null);

  // Need at least 3 points to FIT (same floor holtWinters() itself enforces)
  // plus 1 more held out to test against.
  if (aqiSeries.length < 4) return null;

  const actualAqi = aqiSeries[aqiSeries.length - 1];
  const fitSeries = aqiSeries.slice(0, -1);

  const hw = holtWinters(fitSeries, 0.3, 0.1, 1); // horizon=1: only need the next step
  if (!hw) return null;

  const predictedAqi = hw.forecast[0];
  const band = hw.sigma * Math.sqrt(1); // sigma*sqrt(h), h=1
  const predictedLow = Math.max(0, predictedAqi - band);
  const predictedHigh = predictedAqi + band;
  const isSpike = actualAqi < predictedLow || actualAqi > predictedHigh;

  const lastDoc = orderedDocs[orderedDocs.length - 1];

  return {
    station_id: stationId,
    is_spike: isSpike,
    actual_aqi: actualAqi,
    predicted_aqi: predictedAqi,
    predicted_low: predictedLow,
    predicted_high: predictedHigh,
    sigma: hw.sigma,
    timestamp: lastDoc.timestamp,
  };
}

module.exports = { buildForecast, checkSpike, holtWinters, hourlyBuckets, contiguousHourlySeries };
