import { useEffect, useRef, useState, useCallback } from "react";
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, ResponsiveContainer,
} from "recharts";

const VOICE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 0.93;
  utt.pitch = 1.0;
  utt.volume = 1;
  window.speechSynthesis.speak(utt);
}

function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

const TREND_ICON = {
  rising: "↗",
  "rapidly rising": "⇈",
  falling: "↘",
  "rapidly falling": "⇊",
  stable: "→",
};

export default function ForecastPanel({ forecast, voiceEnabled }) {
  const [speaking, setSpeaking] = useState(false);
  const intervalRef = useRef(null);

  const doSpeak = useCallback(() => {
    if (!forecast?.voice_text) return;
    setSpeaking(true);
    speak(forecast.voice_text);
    const utt = window.speechSynthesis;
    // Detect end of speech
    const check = setInterval(() => {
      if (!utt.speaking) { setSpeaking(false); clearInterval(check); }
    }, 300);
  }, [forecast]);

  // Auto-speak every 5 min when voice enabled
  useEffect(() => {
    clearInterval(intervalRef.current);
    if (voiceEnabled && forecast) {
      doSpeak();
      intervalRef.current = setInterval(doSpeak, VOICE_INTERVAL_MS);
    }
    return () => clearInterval(intervalRef.current);
  }, [voiceEnabled, forecast?.generated_at]);

  if (!forecast) {
    return (
      <div className="forecast-section">
        <div className="card-title">AI Forecast · 24h</div>
        <div style={{ color: "var(--text-dim)", fontSize: 12, padding: "20px 0" }}>
          Loading forecast…
        </div>
      </div>
    );
  }

  // Build chart data: last 12h history + 24h forecast
  const histData = (forecast.history_aqi || []).slice(-12).map((h) => ({
    time: fmtTime(h.timestamp),
    historical: h.aqi,
  }));

  const fcastData = (forecast.predictions || []).map((p) => ({
    time: fmtTime(p.timestamp),
    forecast: p.aqi,
    // [low, high] tuple -> recharts draws a true range area between them
    band: [p.aqi_low, p.aqi_high],
  }));

  // Stitch together with a join point
  const joinPoint = histData.length
    ? { time: histData[histData.length - 1].time, historical: histData[histData.length - 1].historical, forecast: histData[histData.length - 1].historical }
    : null;

  const chartData = [...histData, ...(joinPoint ? [joinPoint] : []), ...fcastData];

  const trend = forecast.trend || "stable";
  const trendClass = trend.replace(/ /g, "\\ ");

  return (
    <div className="forecast-section">
      <div className="forecast-header">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="card-title" style={{ marginBottom: 0 }}>AI Forecast · 24h (Holt-Winters)</div>
          <div className="forecast-meta">
            <span className={`trend-badge ${trendClass}`}>
              {TREND_ICON[trend] || "→"} {trend.charAt(0).toUpperCase() + trend.slice(1)}
            </span>
            {forecast.peak_predicted && (
              <span style={{ fontSize: 11, color: "var(--text-sub)" }}>
                Peak: <strong style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{forecast.peak_predicted}</strong>
                {forecast.peak_time && <span style={{ color: "var(--text-dim)" }}> @ {forecast.peak_time}</span>}
              </span>
            )}
          </div>
        </div>

        <button
          className={`speak-btn${speaking ? " active" : ""}`}
          onClick={doSpeak}
          title="Read forecast aloud"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
          </svg>
          {speaking ? "Speaking…" : "Speak"}
        </button>
      </div>

      <ResponsiveContainer width="100%" height={190}>
        <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(65,100,175,0.12)" />
          <XAxis dataKey="time" tick={{ fontSize: 9, fill: "var(--text-dim)" }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: "var(--text-dim)" }} domain={[0, "auto"]} />
          <Tooltip
            contentStyle={{ background: "#141e30", border: "1px solid rgba(79,142,247,0.3)", borderRadius: 8, fontSize: 11 }}
            labelStyle={{ color: "var(--text-sub)" }}
          />
          <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-dim)" }} />

          {/* AQI threshold reference lines */}
          <ReferenceLine y={100} stroke="#eab308" strokeDasharray="4 2" strokeWidth={0.8} />
          <ReferenceLine y={200} stroke="#f97316" strokeDasharray="4 2" strokeWidth={0.8} />
          <ReferenceLine y={300} stroke="#ef4444" strokeDasharray="4 2" strokeWidth={0.8} />

          {/* Confidence band: one range area spanning aqi_low..aqi_high. The
              old high-area + bg-colored low-area "mask" rendered at recharts'
              default 0.6 fill-opacity over a non-bg-deep card, so the band
              read as 0..high instead of low..high. */}
          <Area dataKey="band" fill="rgba(79,142,247,0.14)" fillOpacity={1} stroke="none"
            name="Forecast range" legendType="none" isAnimationActive={false} />

          {/* Forecast line */}
          <Line
            dataKey="forecast" stroke="#4f8ef7" strokeWidth={2} dot={false}
            strokeDasharray="6 3" name="Forecast AQI"
            style={{ filter: "drop-shadow(0 0 4px rgba(79,142,247,0.4))" }}
          />

          {/* Historical line */}
          <Line
            dataKey="historical" stroke="rgba(148,163,184,0.7)" strokeWidth={1.5} dot={false}
            name="Actual AQI"
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Voice summary text */}
      <div style={{
        marginTop: 10, padding: "8px 12px", borderRadius: 6,
        background: "rgba(79,142,247,0.06)", border: "1px solid rgba(79,142,247,0.12)",
        fontSize: 11, color: "var(--text-sub)", lineHeight: 1.6,
      }}>
        {forecast.voice_text}
      </div>
    </div>
  );
}
