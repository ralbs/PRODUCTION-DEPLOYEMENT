const CATEGORIES = [
  { label: "Good",       range: "0 – 50",   color: "#22c55e", bg: "rgba(34,197,94,0.08)" },
  { label: "Satisfactory", range: "51 – 100", color: "#a3e635", bg: "rgba(163,230,53,0.08)" },
  { label: "Moderate",   range: "101 – 200", color: "#facc15", bg: "rgba(250,204,21,0.08)" },
  { label: "Poor",       range: "201 – 300", color: "#f97316", bg: "rgba(249,115,22,0.08)" },
  { label: "Very Poor",  range: "301 – 400", color: "#ef4444", bg: "rgba(239,68,68,0.08)" },
  { label: "Severe",     range: "401 – 500", color: "#9f1239", bg: "rgba(159,18,57,0.08)" },
];

export default function AQICategoryBar({ currentCategory }) {
  return (
    <div className="aqi-legend-bar">
      {CATEGORIES.map((cat) => {
        const isActive = currentCategory === cat.label;
        return (
          <div
            key={cat.label}
            className="aqi-legend-cell"
            style={{
              borderTopColor: cat.color,
              background: isActive ? cat.bg : undefined,
            }}
          >
            <div className="aqi-legend-name" style={{ color: isActive ? cat.color : "var(--text-sub)" }}>
              {cat.label}
            </div>
            <div className="aqi-legend-range">{cat.range}</div>
          </div>
        );
      })}
    </div>
  );
}
