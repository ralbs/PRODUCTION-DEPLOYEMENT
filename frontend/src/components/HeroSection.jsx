export default function HeroSection({ stations, selected, onSelect, aqi, onRunAnalysis }) {
  const value = aqi?.aqi;
  const cat   = aqi?.category;

  const catColor = {
    Good: "#22c55e", Satisfactory: "#a3e635", Moderate: "#facc15",
    Poor: "#f97316", "Very Poor": "#ef4444", Severe: "#9f1239",
  }[cat] || "#7b93b8";

  return (
    <section className="hero">
      <div className="hero-inner">
        <div>
          <div className="hero-location">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
            </svg>
            Bangalore, Karnataka
          </div>
          <h1 className="hero-heading">
            Air Quality<br />Intelligence
          </h1>
          <p className="hero-sub">
            Real-time health indices, AI forecast, and pollution dispersion
            from the KSPCB monitoring network.
          </p>
        </div>

        <div className="hero-card">
          <div className="hero-card-label">Monitoring Station</div>
          <select className="hero-select" value={selected || ""} onChange={(e) => onSelect(e.target.value)}>
            {stations.map((s) => (
              <option key={s.station_id} value={s.station_id}>{s.station_id.replace("KSPCB-", "")}</option>
            ))}
          </select>

          <button className="hero-btn" onClick={onRunAnalysis}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            View Dashboard
          </button>

          {value != null && (
            <div style={{
              marginTop: 14, padding: "12px 16px", borderRadius: 12,
              background: "rgba(0,229,160,0.06)", border: "1px solid rgba(0,229,160,0.14)",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--text-dim)" }}>
                  Current AQI
                </div>
                <div style={{ fontSize: 28, fontFamily: "var(--font-mono)", fontWeight: 800, color: catColor, lineHeight: 1.1 }}>
                  {value}
                </div>
              </div>
              <div style={{
                padding: "4px 14px", borderRadius: 20,
                fontSize: 11, fontWeight: 700, color: catColor,
                background: `${catColor}18`, border: `1px solid ${catColor}40`,
              }}>
                {cat}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
