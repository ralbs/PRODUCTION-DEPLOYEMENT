import { conv } from "../api";

const POLLUTANTS = [
  { key: "pm1",     label: "PM1",     unit: "µg/m³", max: 1000, fmt: (v) => v?.toFixed(1) ?? "–" },
  { key: "pm2_5",   label: "PM2.5",   unit: "µg/m³", max: 1000, fmt: (v) => v?.toFixed(1) ?? "–" },
  { key: "pm10",    label: "PM10",    unit: "µg/m³", max: 1000, fmt: (v) => v?.toFixed(1) ?? "–" },
  { key: "co",      label: "CO",      unit: "µg/m³", max: 1000, fmt: (v) => v?.toFixed(1) ?? "–" },
  { key: "no2",     label: "NO₂",     unit: "µg/m³", max: 3000, fmt: (v) => conv.no2_ugm3(v) ?? "–" },
  { key: "o3",      label: "O₃",      unit: "µg/m³", max: 3000, fmt: (v) => conv.o3_ugm3(v) ?? "–" },
  { key: "nh3",     label: "NH₃",     unit: "µg/m³", max: 3000, fmt: (v) => v?.toFixed(1) ?? "–" },
  { key: "h2s",     label: "H₂S",     unit: "µg/m³", max: 3000, fmt: (v) => v?.toFixed(1) ?? "–" },
  { key: "mq135",   label: "MQ-135",  unit: "proxy", max: 3000, fmt: (v) => v?.toFixed(2) ?? "–" },
  { key: "h2",      label: "H₂",      unit: "µg/m³", max: 3000, fmt: (v) => v?.toFixed(1) ?? "–" },
  { key: "mq7_co",  siKey: "co", label: "MQ-7 CO", unit: "µg/m³", max: 5000, fmt: (v) => v?.toFixed(1) ?? "–" },
  { key: "voc_gas_ohm", label: "VOC", unit: "Ω",     max: 50000, fmt: (v) => v?.toFixed(0) ?? "–" },
];

function siColor(si) {
  if (si == null) return "var(--text-dim)";
  if (si <= 50)  return "#22c55e";
  if (si <= 100) return "#a3e635";
  if (si <= 200) return "#facc15";
  if (si <= 300) return "#f97316";
  if (si <= 400) return "#ef4444";
  return "#9f1239";
}

export default function SubIndexPanel({ pollutants, subIndices }) {
  return (
    <div className="si-bar-list">
      {POLLUTANTS.map((p) => {
        const raw = pollutants?.[p.key];
        const si  = subIndices?.[p.siKey ?? p.key];
        const displayVal = p.fmt(raw);
        const numVal = typeof displayVal === "number" ? displayVal : parseFloat(displayVal);
        const pct = !isNaN(numVal) ? Math.min((numVal / p.max) * 100, 100) : 0;
        const color = siColor(si);

        return (
          <div key={p.key} className="si-bar-row">
            <div className="si-bar-header">
              <span className="si-bar-label">{p.label}</span>
              {si != null && (
                <span className="si-index-badge" style={{ color, borderColor: color }}>
                  SI {si}
                </span>
              )}
            </div>
            <div className="si-bar-value-row">
              <div className="si-bar-track">
                <div
                  className="si-bar-fill"
                  style={{
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, ${color}aa, ${color})`,
                  }}
                />
              </div>
              <span className="si-bar-val" style={{ color: si != null ? color : "var(--text-dim)" }}>
                {displayVal}
              </span>
              <span className="si-bar-unit">{p.unit}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
