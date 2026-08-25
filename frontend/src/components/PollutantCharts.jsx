import { useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { conv } from "../api";

const RANGES = [
  { label: "6H",  hours: 6 },
  { label: "24H", hours: 24 },
  { label: "7D",  hours: 168 },
  { label: "30D", hours: 720 },
];

function fmtTs(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) +
    " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

const TOOLTIP_STYLE = {
  contentStyle: { background: "#1a2234", border: "1px solid rgba(0,229,160,0.2)", borderRadius: 10, fontSize: 11 },
  labelStyle: { color: "#7b93b8" },
};

export default function PollutantCharts({ history, chartType = "pm" }) {
  const [rangeIdx, setRangeIdx] = useState(1);

  function handleRange(i) { setRangeIdx(i); }

  // Filter relative to the newest data point so historical datasets work too
  const latestMs = history.length
    ? Math.max(...history.map((h) => new Date(h.timestamp).getTime()))
    : Date.now();
  const cutoff = latestMs - RANGES[rangeIdx].hours * 3_600_000;
  const slice  = history.filter((h) => new Date(h.timestamp).getTime() >= cutoff);

  const pmData = slice.map((h) => ({
    time:    fmtTs(h.timestamp),
    "PM2.5": h.pollutants?.pm2_5 ?? null,
    "PM10":  h.pollutants?.pm10  ?? null,
  }));

  const gasData = slice.map((h) => ({
    time: fmtTs(h.timestamp),
    "NO₂ (µg/m³)": conv.no2_ugm3(h.pollutants?.no2),
    "O₃ (µg/m³)":  conv.o3_ugm3(h.pollutants?.o3),
    "CO (mg/m³)":  conv.co_mgm3(h.pollutants?.mq7_co ?? h.pollutants?.co),
  }));

  const rangeButtons = (
    <div className="range-btns">
      {RANGES.map((r, i) => (
        <button key={r.label} className={`range-btn${i === rangeIdx ? " active" : ""}`} onClick={() => handleRange(i)}>
          {r.label}
        </button>
      ))}
    </div>
  );

  if (chartType === "gas") {
    return (
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={gasData} margin={{ top: 4, right: 8, bottom: 0, left: -22 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="time" tick={{ fontSize: 9, fill: "var(--text-dim)" }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: "var(--text-dim)" }} domain={[0, "auto"]} />
          <Tooltip {...TOOLTIP_STYLE} />
          <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-dim)" }} />
          <Line type="monotone" dataKey="NO₂ (µg/m³)" stroke="#f97316" strokeWidth={1.8} dot={false} connectNulls />
          {/* <Line type="monotone" dataKey="O₃ (µg/m³)" stroke="#22c55e" strokeWidth={1.8} dot={false} connectNulls /> disabled (hardware not connected) */}
          <Line type="monotone" dataKey="CO (mg/m³)"  stroke="#facc15" strokeWidth={1.8} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  return (
    <>
      <div className="chart-header" style={{ marginBottom: 10 }}>
        {rangeButtons}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={pmData} margin={{ top: 4, right: 8, bottom: 0, left: -22 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="time" tick={{ fontSize: 9, fill: "var(--text-dim)" }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: "var(--text-dim)" }} domain={[0, "auto"]} allowDataOverflow={false} />
          <Tooltip {...TOOLTIP_STYLE} formatter={(v, name) => [v != null ? `${(+v).toFixed(1)} µg/m³` : "—", name]} />
          <Legend wrapperStyle={{ fontSize: 10, color: "var(--text-dim)" }} />
          <Line type="monotone" dataKey="PM2.5" stroke="#00e5a0" strokeWidth={2} dot={false} connectNulls
            style={{ filter: "drop-shadow(0 0 3px rgba(0,229,160,0.5))" }} />
          <Line type="monotone" dataKey="PM10"  stroke="#38bdf8" strokeWidth={1.5} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}
