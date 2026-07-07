const POLLUTANTS_LIST = ["PM2.5", "PM10", "NO₂", "O₃", "CO", "NH₃"];

export default function HeroSection({ stations, selected, onSelect, onRunAnalysis }) {
  return (
    <section className="hero">
      <div className="hero-inner">
        {/* Left: heading */}
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
            CPCB AQI, pollutant sub-indices, AI forecast, Gaussian plume dispersion,
            and real-time station monitoring from the KSPCB network.
          </p>
        </div>

        {/* Right: control card */}
        <div className="hero-card">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div>
              <div className="hero-card-label">Station</div>
              <select
                className="hero-select"
                value={selected || ""}
                onChange={(e) => onSelect(e.target.value)}
              >
                {stations.map((s) => (
                  <option key={s.station_id} value={s.station_id}>
                    {s.station_id.replace("KSPCB-", "")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="hero-card-label">Pollutant</div>
              <select className="hero-select" defaultValue="PM2.5">
                {POLLUTANTS_LIST.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>

          <button className="hero-btn" onClick={onRunAnalysis}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Run Analysis
          </button>

          <div style={{
            marginTop: 14, padding: "10px 14px",
            background: "rgba(0,229,160,0.06)", borderRadius: 10,
            border: "1px solid rgba(0,229,160,0.14)",
            fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6,
          }}>
            Pipeline: Input → Preprocess → AQI → Forecast → Plume → Zones
          </div>
        </div>
      </div>
    </section>
  );
}
