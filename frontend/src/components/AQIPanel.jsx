const CATEGORY_COLORS = {
  Good: "#639922",
  Satisfactory: "#97C459",
  Moderate: "#EF9F27",
  Poor: "#D85A30",
  "Very Poor": "#E24B4A",
  Severe: "#791F1F",
};

const LABELS = {
  pm2_5: "PM2.5", pm10: "PM10", no2: "NO₂", o3: "O₃", co: "CO",
  nh3: "NH₃", h2s: "H₂S", h2: "H₂", mq135: "MQ-135", voc_gas_ohm: "VOC",
};

export default function AQIPanel({ aqi, timestamp }) {
  if (!aqi) {
    return (
      <div className="card">
        <h2>Air Quality Index</h2>
        <p className="muted">No data available for this station yet.</p>
      </div>
    );
  }

  const color = CATEGORY_COLORS[aqi.category] || "#5f5e5a";

  return (
    <div className="card">
      <h2>Air Quality Index (CPCB)</h2>
      <div className="aqi-row">
        <div>
          <div className="aqi-number" style={{ color }}>{aqi.aqi}</div>
          <div className="aqi-category" style={{ color }}>{aqi.category}</div>
          {aqi.dominant_pollutant && (
            <div className="muted">Dominant: {LABELS[aqi.dominant_pollutant] || aqi.dominant_pollutant}</div>
          )}
        </div>
        <div className="subindex-grid">
          {Object.entries(aqi.sub_indices || {}).map(([pollutant, value]) => (
            <div className="subindex-cell" key={pollutant}>
              <div className="label">{LABELS[pollutant] || pollutant}</div>
              <div className="value">{value ?? "—"}</div>
            </div>
          ))}
        </div>
      </div>
      {timestamp && (
        <p className="muted" style={{ marginTop: 12 }}>
          As of {new Date(timestamp).toLocaleString()}
        </p>
      )}
    </div>
  );
}
