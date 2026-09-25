// Chart rows for ForecastPanel's recharts ComposedChart, built from a
// GET /api/forecast response (backend/lib/forecast.js buildForecast()).
//
// Every row is keyed by `t`, the reading's REAL epoch-ms timestamp, and the
// chart plots it on a numeric time axis. The earlier version keyed rows by
// a formatted "hh:mm am" string on a category axis, which recharts spaces
// evenly by index -- so a 5-hour gap between readings drew the same width
// as a 1-hour one (an implicit constant-dt-per-index x-axis).
//
// A reading with no computable AQI (history_aqi[].aqi === null) stays in
// as `historical: null` at its own `t`: recharts breaks the line there
// (connectNulls is off), so it shows as a real gap -- never dropped (which
// would silently join its neighbours) and never coerced to 0.

export const HISTORY_POINTS = 12;

export function buildForecastChartData(forecast) {
  if (!forecast) return [];

  const hist = (forecast.history_aqi || [])
    .slice(-HISTORY_POINTS)
    .map((h) => ({ t: Date.parse(h.timestamp), historical: h.aqi ?? null }))
    .filter((r) => Number.isFinite(r.t));

  const fcast = (forecast.predictions || [])
    .map((p) => ({
      t: Date.parse(p.timestamp),
      forecast: p.aqi,
      // [low, high] tuple -> recharts draws a true range area between them
      band: [p.aqi_low, p.aqi_high],
    }))
    .filter((r) => Number.isFinite(r.t));

  // Start the dashed forecast line from the last REAL reading, so it
  // visually continues the history. Skip trailing nulls rather than
  // starting the forecast line from a missing value.
  for (let k = hist.length - 1; k >= 0; k--) {
    if (hist[k].historical !== null) {
      hist[k] = { ...hist[k], forecast: hist[k].historical };
      break;
    }
  }

  return [...hist, ...fcast].sort((a, b) => a.t - b.t);
}
