const CAT_STYLE = {
  Good:        { color: "#22c55e", bg: "rgba(34,197,94,0.12)",   border: "rgba(34,197,94,0.3)" },
  Satisfactory:{ color: "#a3e635", bg: "rgba(163,230,53,0.12)",  border: "rgba(163,230,53,0.3)" },
  Moderate:    { color: "#facc15", bg: "rgba(250,204,21,0.12)",  border: "rgba(250,204,21,0.3)" },
  Poor:        { color: "#f97316", bg: "rgba(249,115,22,0.12)",  border: "rgba(249,115,22,0.3)" },
  "Very Poor": { color: "#ef4444", bg: "rgba(239,68,68,0.12)",   border: "rgba(239,68,68,0.3)" },
  Severe:      { color: "#9f1239", bg: "rgba(159,18,57,0.12)",   border: "rgba(159,18,57,0.3)" },
};

function aqiColor(aqi) {
  if (aqi == null) return "var(--text-dim)";
  if (aqi <= 50)  return "#22c55e";
  if (aqi <= 100) return "#a3e635";
  if (aqi <= 200) return "#facc15";
  if (aqi <= 300) return "#f97316";
  if (aqi <= 400) return "#ef4444";
  return "#9f1239";
}

export default function StationTable({ stations, stationsAQI, selected, onSelect }) {
  return (
    <div className="station-table-wrap">
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Station AQI</span>
        </div>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>CPCB daily average · all stations</span>
      </div>

      <table className="station-table">
        <thead>
          <tr>
            <th>Station</th>
            <th>AQI</th>
            <th>Category</th>
            <th>Dominant</th>
            <th>Last Reading</th>
          </tr>
        </thead>
        <tbody>
          {stations.map((s) => {
            const info = stationsAQI?.[s.station_id];
            const aqi  = info?.aqi;
            const cat  = info?.category;
            const cs   = CAT_STYLE[cat] || {};
            const name = s.station_id.replace("KSPCB-", "");
            const isSelected = s.station_id === selected;

            return (
              <tr
                key={s.station_id}
                className={isSelected ? "selected-row" : ""}
                onClick={() => onSelect(s.station_id)}
              >
                <td>
                  <span className="station-name" style={{ color: isSelected ? "var(--accent)" : undefined }}>
                    {name}
                  </span>
                </td>
                <td>
                  <span className="aqi-value" style={{ color: aqiColor(aqi) }}>
                    {aqi != null ? aqi : "–"}
                  </span>
                </td>
                <td>
                  {cat ? (
                    <span className="category-pill" style={{
                      color: cs.color, background: cs.bg, borderColor: cs.border,
                    }}>
                      {cat}
                    </span>
                  ) : (
                    <span className="category-pill" style={{
                      color: "var(--text-dim)", background: "rgba(255,255,255,0.04)",
                      borderColor: "var(--border)",
                    }}>
                      No data
                    </span>
                  )}
                </td>
                <td className="dominant-cell">
                  {info?.dominant_pollutant ?? (info ? "–" : "–")}
                </td>
                <td className="date-cell">
                  {info?.timestamp
                    ? new Date(info.timestamp).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
                    : "–"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
