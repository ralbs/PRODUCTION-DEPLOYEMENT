// LOCAL DESIGN PREVIEW -- MOCK DATA ONLY, never deployed (see
// hero-preview.html). Every hero below is the real HeroSection rendering
// the real buildHeroModel() output; only the INPUTS are invented.
import ReactDOM from "react-dom/client";
import HeroSection from "../components/HeroSection";
import { buildHeroModel } from "../lib/heroModel";
import { resolveSensitivity } from "../lib/sensitivity";
import "../index.css";

const NOW = Date.now();
const H = 3600e3, MIN = 60e3;
const iso = (ms) => new Date(ms).toISOString();
const hourStart = Math.floor((NOW - 2 * MIN) / H) * H;

function mockForecast(hist, trend, preds) {
  return {
    trend, resolution_minutes: 60, generated_at: iso(NOW - 12 * MIN),
    history_aqi: hist.map((aqi, i) => ({ timestamp: iso(hourStart - (hist.length - 1 - i) * H), aqi })),
    predictions: preds.map(([aqi, lo, hi], i) => ({ timestamp: iso(hourStart + (i + 1) * H), aqi, aqi_low: lo, aqi_high: hi })),
  };
}
const spike = { status: "ok", doc: { timestamp: iso(NOW - 40 * MIN), confidence: 0.6, estimate_tier: "interior", bearing_deg: 250 } };

const CASES = [
  { name: "Good", aqi: 38, forecast: mockForecast([44, 42, 41, 40, 39, 38], "stable", [[38, 30, 46], [38, 27, 49]]) },
  { name: "Moderate", aqi: 185, forecast: mockForecast([160, 166, 171, 176, 181, 185], "rapidly rising", [[190, 184, 196], [205, 191, 219]]) },
  { name: "Poor", aqi: 262, forecast: mockForecast([290, 284, 279, 272, 268, 262], "falling", [[258, 249, 267], [253, 240, 266]]) },
];

const general = resolveSensitivity({ kind: "general" });
const stations = [{ station_id: "MOCK-001" }];

function Case({ c, full }) {
  const model = buildHeroModel({
    stationId: "MOCK-001",
    latest: { timestamp: iso(NOW - 2 * MIN), aqi: { aqi: c.aqi } },
    forecast: full ? c.forecast : null,
    sourceDirection: full ? spike : { status: "not_found" },
    lastRun: null, sensitivity: general, nowMs: NOW,
  });
  const id = `${c.name.toLowerCase()}-${full ? "full" : "bare"}`;
  return (
    <section data-case={id} style={{ marginBottom: 28 }}>
      <div style={{ background: "#b91c1c", color: "#fff", font: "700 12px/1 Inter, sans-serif", letterSpacing: 1, padding: "8px 14px" }}>
        MOCK DATA — DESIGN PREVIEW, NOT REAL READINGS · {c.name} · {full ? "with trend + source-direction sentence" : "no trend, no source-direction sentence"}
      </div>
      <HeroSection stations={stations} selected="MOCK-001" onSelect={() => {}} model={model}
        sensitivity={general} onSensitivityChange={() => {}} onShowDetails={() => {}} />
    </section>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <div style={{ padding: "24px 0" }}>
    {CASES.flatMap((c) => [<Case key={c.name + "b"} c={c} full={false} />, <Case key={c.name + "f"} c={c} full />])}
  </div>
);
