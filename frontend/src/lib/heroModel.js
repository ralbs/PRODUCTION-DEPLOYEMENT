// What the hero says -- pure logic, per docs/HERO_SPEC.md. Every string is
// either quoted from a primary source (CPCB's National AQI report) or built
// from real data; nothing here states more than the data supports.
import { aqiToRgb } from "./aqiColor.js";
import { isInconclusive } from "./sourceDirection.js";
import { personalLine, resolveSensitivity } from "./sensitivity.js";
import { MIN_REAL_HOURS } from "./forecastChart.js";

// The device reports every 60 s (firmware/config.h TELEMETRY_INTERVAL_MS).
// Past 10x that, the hero stops speaking in the present tense.
export const STALE_AFTER_MIN = 10;
const TREND_HORIZON_H = 2;
const SPIKE_FRESH_H = 2;

// CPCB category thresholds (backend/lib/aqi.js aqiCategory()), with CPCB's
// "Associated Health Impacts", verbatim from the National AQI report (2014)
// p.38. CPCB publishes impacts, not actions -- so no actions are invented.
export const CPCB = [
  { max: 50,  category: "Good", headline: "Air quality is Good.", impact: "Minimal Impact" },
  { max: 100, category: "Satisfactory", headline: "Air quality is Satisfactory.",
    impact: "May cause minor breathing discomfort to sensitive people" },
  { max: 200, category: "Moderately polluted", headline: "Air is moderately polluted.",
    impact: "May cause breathing discomfort to the people with lung disease such as asthma and discomfort to people with heart disease, children and older adults" },
  { max: 300, category: "Poor", headline: "Air quality is Poor.",
    impact: "May cause breathing discomfort to people on prolonged exposure and discomfort to people with heart disease with short exposure" },
  { max: 400, category: "Very Poor", headline: "Air quality is Very Poor.",
    impact: "May cause respiratory illness to the people on prolonged exposure. Effect may be more pronounced in people with lung and heart diseases" },
  { max: Infinity, category: "Severe", headline: "Air quality is Severe.",
    impact: "May cause respiratory effects even on healthy people and serious health impacts on people with lung/heart diseases. The health impacts may be experienced even during light physical activity" },
];

export function cpcbBand(aqi) {
  return CPCB.find((b) => aqi <= b.max);
}

const HOUR = 3600e3;

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
}
function fmtDateTime(ms) {
  return new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}
// Floors, like ConfidenceBadge's formatAgo -- the hero shows both side by
// side, and rounding here once put "20 days ago" next to the badge's "19d ago".
export function fmtAge(ms) {
  const min = Math.floor(ms / 60e3);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

const TREND_TEXT = {
  "falling": "Improving over the next 2 hours",
  "rapidly falling": "Improving quickly over the next 2 hours",
  "stable": "Steady over the next 2 hours",
  "rising": "Worsening over the next 2 hours",
  "rapidly rising": "Worsening quickly over the next 2 hours",
};
const TREND_SIGN = { "falling": -1, "rapidly falling": -1, "stable": 0, "rising": 1, "rapidly rising": 1 };

// The trend clause, or why there isn't one. Gated per HERO_SPEC.md s.2.
// Key gate (P0-a): the clause says "next 2 hours", so it needs forecast
// steps that really are hours. Two independent checks, both required:
//  1. the server declares resolution_minutes === 60 -- backends before the
//     hourly resampling fix treated each 1-minute reading as an hour and
//     don't send this field, so they can never get a clause;
//  2. the history it returned is actually ~hourly-spaced.
export function trendClause(forecast, readingAtMs) {
  if (!forecast) return { text: null, why: "no_forecast" };
  if (forecast.resolution_minutes !== 60) return { text: null, why: "not_hourly" };
  const hist = (forecast.history_aqi || [])
    .map((h) => ({ t: Date.parse(h.timestamp), aqi: h.aqi }))
    .filter((h) => Number.isFinite(h.t) && h.aqi != null);
  // MIN_REAL_HOURS: the server must declare that many real (not
  // interpolated) hours, AND the history must show them.
  if (!(forecast.real_hours >= MIN_REAL_HOURS) || hist.length < MIN_REAL_HOURS) {
    return { text: null, why: "too_few_points" };
  }

  const gaps = hist.slice(1).map((h, i) => h.t - hist[i].t).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median < 0.75 * HOUR || median > 1.5 * HOUR) return { text: null, why: "not_hourly" };

  const trend = forecast.trend;
  if (!(trend in TREND_TEXT)) return { text: null, why: "no_trend" };

  // Holt-Winters' smoothed slope can lag a real turn: if the last three real
  // steps all move against it, don't claim a direction.
  const last = hist.slice(-4);
  const deltas = last.slice(1).map((h, i) => h.aqi - last[i].aqi);
  const sign = TREND_SIGN[trend];
  if (sign !== 0 && deltas.length === 3 && deltas.every((d) => Math.sign(d) === -sign)) {
    return { text: "Direction unclear right now", why: "contradicted" };
  }

  let text = TREND_TEXT[trend];
  const cur = hist[hist.length - 1].aqi;
  const curBand = cpcbBand(cur);
  const within = (forecast.predictions || []).filter((p) => {
    const t = Date.parse(p.timestamp);
    return Number.isFinite(t) && t - readingAtMs <= TREND_HORIZON_H * HOUR;
  });
  for (const p of within) {
    const pb = cpcbBand(p.aqi);
    if (pb.category === curBand.category) continue;
    const lo = cpcbBand(p.aqi_low), hi = cpcbBand(p.aqi_high);
    const certain = lo.category === pb.category && hi.category === pb.category;
    text += ` — ${certain ? "likely" : "may reach"} ${pb.category} by ${fmtTime(Date.parse(p.timestamp))}`;
    break;
  }
  return { text: `${text}.`, why: null, generatedAt: forecast.generated_at };
}

// One sentence about an unusual rise -- never a bearing or a source
// (HERO_SPEC.md s.3: no confidence value currently identifies accurate
// estimates; interior "High" was the LEAST accurate in tonight's run).
export function directionSentence(sourceDirection, lastRun, nowMs) {
  const fresh = (ts) => Number.isFinite(ts) && nowMs - ts <= SPIKE_FRESH_H * HOUR;
  if (sourceDirection?.status === "ok" && sourceDirection.doc) {
    const t = Date.parse(sourceDirection.doc.timestamp);
    if (fresh(t)) {
      return isInconclusive(sourceDirection.doc)
        ? `An unusual rise was detected at ${fmtTime(t)}; its direction is inconclusive.`
        : `An unusual rise was detected at ${fmtTime(t)} — see Source Direction for a screening estimate.`;
    }
  }
  const run = lastRun?.status === "ok" ? lastRun.doc : null;
  if (run?.spike_detected && run.wind_failure_reason) {
    const t = Date.parse(run.spike_timestamp);
    if (fresh(t)) return `An unusual rise was detected at ${fmtTime(t)}, but its direction couldn't be estimated.`;
  }
  return null; // no estimate is not evidence of no source -- say nothing
}

export function buildHeroModel({ stationId, latest, latestStatus, forecast, sourceDirection, lastRun, sensitivity, nowMs = Date.now() }) {
  const sens = sensitivity ?? resolveSensitivity(null);
  const aqi = latest?.aqi?.aqi;
  const readingAtMs = Date.parse(latest?.timestamp);
  const base = { stationId, direction: directionSentence(sourceDirection, lastRun, nowMs) };

  if (!latest) {
    return { ...base, mode: latestStatus === "error" ? "no_data" : "loading",
      headline: latestStatus === "error" ? `No readings from ${stationId ?? "this station"} yet.` : "Loading the latest reading…",
      secondary: null, trend: null };
  }
  if (aqi == null || !Number.isFinite(readingAtMs)) {
    return { ...base, mode: "no_data", headline: `No usable reading from ${stationId}.`,
      secondary: "The latest reading has no pollutant the official AQI can use.", trend: null };
  }

  const band = cpcbBand(aqi);
  const ageMs = nowMs - readingAtMs;
  const common = { ...base, aqi, category: band.category, readingAtMs, ageMs, rgb: aqiToRgb(aqi) };

  if (ageMs > STALE_AFTER_MIN * 60e3) {
    return { ...common, mode: "stale", personal: personalLine(aqi, "stale", sens),
      headline: `No current reading from ${stationId}.`,
      secondary: `Latest reading: ${band.category}, ${fmtDateTime(readingAtMs)} (${fmtAge(ageMs)}).`,
      trend: null };
  }
  return { ...common, mode: "current", headline: band.headline, secondary: band.impact,
    personal: personalLine(aqi, "current", sens),
    trend: trendClause(forecast, readingAtMs) };
}
