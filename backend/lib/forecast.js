const { calculateAQI, aqiCategory } = require("./aqi");
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

async function buildForecast(stationId, lookbackHours = 168, horizon = 24) {
  const docs = await Telemetry.find({ "meta.station_id": stationId })
    .sort({ timestamp: -1 })
    .limit(Math.min(lookbackHours, 720))
    .lean();

  if (!docs.length) return null;

  const orderedDocs = [...docs].reverse();
  const aqiSeries = orderedDocs
    .map((d) => calculateAQI(d.pollutants)?.aqi ?? null)
    .filter((v) => v !== null);

  if (aqiSeries.length < 3) return null;

  const hw = holtWinters(aqiSeries);
  if (!hw) return null;

  const lastDoc = orderedDocs[orderedDocs.length - 1];
  const currentAQI = calculateAQI(lastDoc.pollutants);
  const lastTs = new Date(lastDoc.timestamp);

  const predictions = hw.forecast.map((aqi, i) => {
    const ci = Math.round(hw.sigma * Math.sqrt(i + 1));
    return {
      timestamp: new Date(lastTs.getTime() + (i + 1) * 3600 * 1000).toISOString(),
      aqi,
      aqi_low: Math.max(0, aqi - ci),
      aqi_high: aqi + ci,
      category: aqiCategory(aqi),
    };
  });

  const trend = trendLabel(hw.trend);
  const peak = Math.max(...hw.forecast);
  const peakIdx = hw.forecast.indexOf(peak);
  const peakTs = new Date(lastTs.getTime() + (peakIdx + 1) * 3600 * 1000);
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

  // History sample for the combined chart (last 24 readings)
  const historyAqi = orderedDocs.slice(-24).map((d, i) => ({
    timestamp: new Date(orderedDocs[orderedDocs.length - 24 + i]?.timestamp).toISOString(),
    aqi: calculateAQI(d.pollutants)?.aqi ?? null,
  }));

  return {
    station_id: stationId,
    current_aqi: currentAQI,
    trend,
    peak_predicted: peak,
    peak_time: peakTime,
    predictions,
    history_aqi: historyAqi,
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

module.exports = { buildForecast, checkSpike, holtWinters };
