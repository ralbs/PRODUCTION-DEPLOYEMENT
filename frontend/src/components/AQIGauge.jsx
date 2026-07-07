const SEGMENTS = [
  { label: "Good",       max: 50,  color: "#22c55e" },
  { label: "Satisfactory", max: 100, color: "#84cc16" },
  { label: "Moderate",   max: 200, color: "#eab308" },
  { label: "Poor",       max: 300, color: "#f97316" },
  { label: "Very Poor",  max: 400, color: "#ef4444" },
  { label: "Severe",     max: 500, color: "#991b1b" },
];

const BADGE_COLORS = {
  Good: { bg: "rgba(34,197,94,0.15)", color: "#22c55e", border: "rgba(34,197,94,0.3)" },
  Satisfactory: { bg: "rgba(132,204,22,0.15)", color: "#84cc16", border: "rgba(132,204,22,0.3)" },
  Moderate: { bg: "rgba(234,179,8,0.15)", color: "#eab308", border: "rgba(234,179,8,0.3)" },
  Poor: { bg: "rgba(249,115,22,0.15)", color: "#f97316", border: "rgba(249,115,22,0.3)" },
  "Very Poor": { bg: "rgba(239,68,68,0.15)", color: "#ef4444", border: "rgba(239,68,68,0.3)" },
  Severe: { bg: "rgba(153,27,27,0.15)", color: "#fca5a5", border: "rgba(153,27,27,0.4)" },
};

// SVG arc helpers
function polarToXY(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx, cy, r1, r2, startDeg, endDeg) {
  const [x1, y1] = polarToXY(cx, cy, r1, startDeg);
  const [x2, y2] = polarToXY(cx, cy, r1, endDeg);
  const [x3, y3] = polarToXY(cx, cy, r2, endDeg);
  const [x4, y4] = polarToXY(cx, cy, r2, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${x1},${y1} A${r1},${r1},0,${large},1,${x2},${y2} L${x3},${y3} A${r2},${r2},0,${large},0,${x4},${y4} Z`;
}

// Map AQI 0-500 to angle 180°-360° (full semicircle)
function aqiToAngle(aqi) {
  return 180 + Math.min(Math.max(aqi / 500, 0), 1) * 180;
}

const CX = 110, CY = 108, R_OUT = 90, R_IN = 68;
const TOTAL = 500;
let prev = 0;
const segAngles = SEGMENTS.map((s) => {
  const startDeg = 180 + (prev / TOTAL) * 180;
  const endDeg = 180 + (s.max / TOTAL) * 180;
  prev = s.max;
  return { ...s, startDeg, endDeg };
});

export default function AQIGauge({ aqi }) {
  const value = aqi?.aqi ?? 0;
  const category = aqi?.category ?? "–";
  const badgeStyle = BADGE_COLORS[category] || {};
  const needleAngle = aqiToAngle(value);
  const [nx, ny] = polarToXY(CX, CY, R_OUT - 6, needleAngle);

  return (
    <div className="gauge-wrap">
      <svg viewBox="0 0 220 125" width="220" height="125" style={{ overflow: "visible" }}>
        {/* Background arc */}
        <path d={arcPath(CX, CY, R_OUT, R_IN, 180, 360)} fill="rgba(255,255,255,0.03)" />

        {/* Colored segments */}
        {segAngles.map((s) => (
          <path key={s.label} d={arcPath(CX, CY, R_OUT, R_IN, s.startDeg, s.endDeg - 0.5)} fill={s.color} opacity={0.85} />
        ))}

        {/* Needle */}
        <line
          x1={CX} y1={CY}
          x2={nx} y2={ny}
          stroke="white" strokeWidth="2.5" strokeLinecap="round"
          style={{ filter: "drop-shadow(0 0 4px rgba(255,255,255,0.5))" }}
        />
        <circle cx={CX} cy={CY} r="5" fill="white" style={{ filter: "drop-shadow(0 0 4px rgba(255,255,255,0.4))" }} />

        {/* AQI value */}
        <text x={CX} y={CY - 18} textAnchor="middle" fill="white" fontSize="36" fontWeight="700" fontFamily="JetBrains Mono, monospace">
          {aqi ? value : "–"}
        </text>
        <text x={CX} y={CY - 4} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="9" letterSpacing="2">
          CPCB AQI
        </text>

        {/* Tick marks */}
        {[0, 100, 200, 300, 400, 500].map((v) => {
          const a = aqiToAngle(v);
          const [x1, y1] = polarToXY(CX, CY, R_OUT + 4, a);
          const [x2, y2] = polarToXY(CX, CY, R_OUT + 10, a);
          return (
            <g key={v}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" />
              <text
                x={polarToXY(CX, CY, R_OUT + 17, a)[0]}
                y={polarToXY(CX, CY, R_OUT + 17, a)[1] + 3}
                textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="8"
              >
                {v}
              </text>
            </g>
          );
        })}
      </svg>

      {aqi && (
        <span
          className="aqi-category-badge"
          style={{ background: badgeStyle.bg, color: badgeStyle.color, border: `1px solid ${badgeStyle.border}` }}
        >
          {category}
        </span>
      )}
      {!aqi && <span className="muted" style={{ marginTop: 6 }}>No data</span>}
    </div>
  );
}
