const ADVISORIES = {
  Good: {
    color: "#22c55e", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.2)",
    icon: "✓",
    headline: "Air quality is good — enjoy outdoor activities freely.",
    general:   "No restrictions for the general population.",
    sensitive: "Sensitive groups can also engage in normal outdoor activity.",
    actions: ["Ideal for outdoor exercise", "Windows can stay open", "No mask needed"],
    actionColors: ["#22c55e", "#22c55e", "#22c55e"],
  },
  Satisfactory: {
    color: "#a3e635", bg: "rgba(163,230,53,0.08)", border: "rgba(163,230,53,0.2)",
    icon: "✓",
    headline: "Air quality is satisfactory with minor concerns for very sensitive groups.",
    general:   "Most people can engage in normal outdoor activities.",
    sensitive: "Unusually sensitive people should consider reducing prolonged exertion.",
    actions: ["Safe for most outdoor activities", "Sensitive groups: limit long runs", "No mask for general public"],
    actionColors: ["#a3e635", "#facc15", "#a3e635"],
  },
  Moderate: {
    color: "#facc15", bg: "rgba(250,204,21,0.08)", border: "rgba(250,204,21,0.2)",
    icon: "⚠",
    headline: "Moderate air quality — sensitive individuals should take precautions.",
    general:   "People with respiratory or heart disease, elderly and children should reduce prolonged outdoor exertion.",
    sensitive: "Avoid strenuous outdoor activities. Stay indoors if possible.",
    actions: ["Sensitive groups: stay indoors", "Limit outdoor exercise", "Consider N95 mask outdoors"],
    actionColors: ["#facc15", "#f97316", "#facc15"],
  },
  Poor: {
    color: "#f97316", bg: "rgba(249,115,22,0.08)", border: "rgba(249,115,22,0.2)",
    icon: "⚠",
    headline: "Poor air quality — everyone may experience health effects.",
    general:   "Members of sensitive groups may experience serious health effects. Reduce outdoor activity.",
    sensitive: "Everyone should avoid prolonged outdoor exertion. Stay indoors with windows closed.",
    actions: ["Wear N95 mask outdoors", "Close windows", "Avoid outdoor exercise"],
    actionColors: ["#f97316", "#f97316", "#ef4444"],
  },
  "Very Poor": {
    color: "#ef4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.2)",
    icon: "✕",
    headline: "Very Poor — serious health effects likely on prolonged exposure.",
    general:   "Everyone should avoid outdoor exertion. Sensitive groups should stay indoors.",
    sensitive: "Stay indoors. Run air purifier if available. Seek medical attention if symptomatic.",
    actions: ["Stay indoors", "Run air purifier", "Seek medical help if symptomatic", "N95 mandatory if going out"],
    actionColors: ["#ef4444", "#ef4444", "#ef4444", "#9f1239"],
  },
  Severe: {
    color: "#9f1239", bg: "rgba(159,18,57,0.08)", border: "rgba(159,18,57,0.3)",
    icon: "✕",
    headline: "SEVERE — health emergency. Avoid all outdoor activity.",
    general:   "Avoid all outdoor activity. Close all windows. If symptoms develop, seek immediate medical care.",
    sensitive: "Evacuate outdoor spaces immediately. Medical emergency protocols may apply.",
    actions: ["Do NOT go outdoors", "Seal windows & doors", "Emergency medical attention", "N95 + avoid exertion"],
    actionColors: ["#9f1239", "#9f1239", "#9f1239", "#9f1239"],
  },
};

const POLLUTANT_INFO = {
  pm2_5: { name: "PM2.5", limit: "60 µg/m³ (24h avg)", note: "Fine particles — penetrate deep into lungs" },
  pm10:  { name: "PM10",  limit: "100 µg/m³ (24h avg)", note: "Coarse particles — irritate respiratory tract" },
  no2:   { name: "NO₂",   limit: "80 µg/m³ (annual)",  note: "Nitrogen dioxide — from combustion sources" },
  // o3:  { name: "O₃",    limit: "100 µg/m³ (8h avg)",  note: "Ground-level ozone — triggers asthma" },  // disabled (hardware not connected)
  co:    { name: "CO",    limit: "4 mg/m³ (8h avg)",    note: "Carbon monoxide — impairs oxygen delivery" },
};

export default function HealthAdvisory({ aqi }) {
  if (!aqi?.category) {
    return (
      <div style={{ padding: "14px 0", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
        Awaiting data…
      </div>
    );
  }

  const adv  = ADVISORIES[aqi.category] || ADVISORIES.Moderate;
  const dom  = aqi.dominant_pollutant;
  const info = dom ? POLLUTANT_INFO[dom] : null;

  return (
    <div style={{
      marginTop: 18, padding: "14px 16px", borderRadius: 12,
      background: adv.bg, border: `1px solid ${adv.border}`,
    }}>
      {/* Headline */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
        <span style={{
          fontSize: 14, fontWeight: 800, color: adv.color,
          width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center",
          background: `${adv.color}22`, borderRadius: 6, flexShrink: 0,
        }}>
          {adv.icon}
        </span>
        <p style={{ fontSize: 12, fontWeight: 600, color: adv.color, lineHeight: 1.5 }}>
          {adv.headline}
        </p>
      </div>

      {/* Groups */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 4 }}>General Public</div>
          <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.5 }}>{adv.general}</div>
        </div>
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 4 }}>Sensitive Groups</div>
          <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.5 }}>{adv.sensitive}</div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: info ? 10 : 0 }}>
        {adv.actions.map((action, i) => (
          <span key={i} style={{
            fontSize: 10, fontWeight: 600, padding: "3px 10px", borderRadius: 20,
            background: `${adv.actionColors[i]}15`,
            border: `1px solid ${adv.actionColors[i]}40`,
            color: adv.actionColors[i],
          }}>
            {action}
          </span>
        ))}
      </div>

      {/* Dominant pollutant */}
      {info && (
        <div style={{
          marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)",
          fontSize: 11, color: "var(--text-dim)", display: "flex", gap: 16, flexWrap: "wrap",
        }}>
          <span>Primary pollutant: <strong style={{ color: adv.color }}>{info.name}</strong></span>
          <span>CPCB safe limit: <strong style={{ color: "var(--text-sub)" }}>{info.limit}</strong></span>
          <span style={{ color: "var(--text-dim)" }}>{info.note}</span>
        </div>
      )}
    </div>
  );
}
