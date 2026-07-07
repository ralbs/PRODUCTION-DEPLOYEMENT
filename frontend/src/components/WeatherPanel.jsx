export default function WeatherPanel({ weather, timestamp }) {
  const fmt = (v, d = 1) => v != null ? v.toFixed(d) : "–";

  return (
    <div className="section">
      <div className="card-title">Weather Conditions</div>
      <div className="weather-grid">
        <div className="w-metric">
          <div className="w-value">{fmt(weather?.temperature)}</div>
          <div className="w-unit">°C</div>
          <div className="w-label">Temperature</div>
        </div>
        <div className="w-metric">
          <div className="w-value">{fmt(weather?.humidity, 0)}</div>
          <div className="w-unit">%</div>
          <div className="w-label">Humidity</div>
        </div>
        <div className="w-metric">
          <div className="w-value">{fmt(weather?.pressure, 0)}</div>
          <div className="w-unit">hPa</div>
          <div className="w-label">Pressure</div>
        </div>
      </div>
      {timestamp && (
        <p className="muted" style={{ marginTop: 10, fontSize: 10 }}>
          Last updated: {new Date(timestamp).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
        </p>
      )}
    </div>
  );
}
