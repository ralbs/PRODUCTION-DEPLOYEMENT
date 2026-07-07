import { useMemo } from "react";

function Chip({ label, value, color, sub }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 18px",
      borderRight: "1px solid var(--border)",
    }}>
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 2 }}>
          {label}
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: color || "var(--text)", fontFamily: "var(--font-mono)" }}>
          {value}
          {sub && <span style={{ fontSize: 10, fontWeight: 400, color: "var(--text-dim)", marginLeft: 5, fontFamily: "inherit" }}>{sub}</span>}
        </div>
      </div>
    </div>
  );
}

const AQI_COLOR = (aqi) => {
  if (aqi == null) return "var(--text-dim)";
  if (aqi <= 50)  return "#22c55e";
  if (aqi <= 100) return "#a3e635";
  if (aqi <= 200) return "#facc15";
  if (aqi <= 300) return "#f97316";
  if (aqi <= 400) return "#ef4444";
  return "#9f1239";
};

export default function InsightsBanner({ stations, stationsAQI }) {
  const insights = useMemo(() => {
    const entries = Object.entries(stationsAQI).filter(([, v]) => v.aqi != null);
    if (!entries.length) return null;

    const sorted  = entries.sort((a, b) => a[1].aqi - b[1].aqi);
    const best    = sorted[0];
    const worst   = sorted[sorted.length - 1];
    const avg     = Math.round(entries.reduce((s, [, v]) => s + v.aqi, 0) / entries.length);
    const online  = entries.length;

    return { best, worst, avg, online, total: stations.length };
  }, [stations, stationsAQI]);

  if (!insights) return null;

  const { best, worst, avg, online, total } = insights;
  const bestName  = best[0].replace("KSPCB-", "");
  const worstName = worst[0].replace("KSPCB-", "");

  return (
    <div style={{
      background: "rgba(19,25,41,0.7)",
      borderBottom: "1px solid var(--border)",
      backdropFilter: "blur(10px)",
    }}>
      <div style={{
        maxWidth: 1400, margin: "0 auto", width: "100%",
        display: "flex", alignItems: "stretch", overflowX: "auto",
      }}>
        <Chip
          label="Cleanest Station"
          value={bestName}
          color="#22c55e"
          sub={`AQI ${best[1].aqi}`}
        />
        <Chip
          label="Most Polluted"
          value={worstName}
          color={AQI_COLOR(worst[1].aqi)}
          sub={`AQI ${worst[1].aqi}`}
        />
        <Chip
          label="City Avg AQI"
          value={avg}
          color={AQI_COLOR(avg)}
          sub={worst[1].category}
        />
        <Chip
          label="Stations Online"
          value={`${online} / ${total}`}
          color="var(--accent)"
        />
        <div style={{ padding: "10px 18px", display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.5px" }}>
            Press <kbd style={{ padding: "1px 5px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-card2)", fontSize: 10, color: "var(--text-sub)" }}>?</kbd> for shortcuts
          </span>
        </div>
      </div>
    </div>
  );
}
