import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "./api";

import Header            from "./components/Header";
import HeroSection       from "./components/HeroSection";
import AQICategoryBar    from "./components/AQICategoryBar";
import InsightsBanner    from "./components/InsightsBanner";
import StationTable      from "./components/StationTable";
import MapPanel          from "./components/MapPanel";
import AQIGauge          from "./components/AQIGauge";
import SubIndexPanel     from "./components/SubIndexPanel";
import HealthAdvisory    from "./components/HealthAdvisory";
import ForecastPanel     from "./components/ForecastPanel";
import WeatherPanel      from "./components/WeatherPanel";
import PollutantCharts   from "./components/PollutantCharts";
import PlumeVisualizer   from "./components/PlumeVisualizer";
import FullscreenCard    from "./components/FullscreenCard";
import AlertToast        from "./components/AlertToast";
import KeyboardShortcuts from "./components/KeyboardShortcuts";

const REFRESH_MS  = 60_000;
const FORECAST_MS = 5 * 60_000;

/* ── icon helpers ── */
const I = (d, extra = "") => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d}/>{extra && <path d={extra}/>}
  </svg>
);
const MapIcon      = () => I("M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6", "M9 3v15M15 6v15");
const GaugeIcon    = () => I("M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10", "M12 6v6l4 2");
const ForecastIcon = () => I("M23 6L13.5 15.5 8.5 10.5 1 18", "M17 6h6v6");
const WeatherIcon  = () => I("M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z");
const ChartIcon    = () => I("M22 12l-4 0-3 9-6-18-3 9-4 0");
const PlumeIcon    = () => I("M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z");

/* ── data freshness hook ── */
function useDataFreshness(timestamp) {
  const [age, setAge] = useState(null);
  useEffect(() => {
    if (!timestamp) return;
    const update = () => {
      const sec = Math.round((Date.now() - new Date(timestamp)) / 1000);
      if (sec < 60)  setAge(`${sec}s ago`);
      else if (sec < 3600) setAge(`${Math.floor(sec / 60)}m ago`);
      else setAge(`${Math.floor(sec / 3600)}h ago`);
    };
    update();
    const t = setInterval(update, 5000);
    return () => clearInterval(t);
  }, [timestamp]);
  return age;
}

export default function App() {
  const [stations, setStations]       = useState([]);
  const [selected, setSelected]       = useState(null);
  const [latest, setLatest]           = useState(null);
  const [history, setHistory]         = useState([]);
  const [forecast, setForecast]       = useState(null);
  const [stationsAQI, setStationsAQI] = useState({});
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [error, setError]             = useState(null);
  const forecastTimer = useRef(null);
  const mainRef       = useRef(null);

  const dataAge = useDataFreshness(latest?.timestamp);

  // Load stations once
  useEffect(() => {
    api.getStations()
      .then((list) => { setStations(list); if (list.length) setSelected(list[0].station_id); })
      .catch((e) => setError(e.message));
  }, []);

  // Load AQI for all stations
  useEffect(() => {
    if (!stations.length) return;
    stations.forEach((s) => {
      api.getLatest(s.station_id)
        .then((d) => setStationsAQI((prev) => ({
          ...prev,
          [s.station_id]: {
            aqi:                d.aqi?.aqi,
            category:           d.aqi?.category,
            dominant_pollutant: d.aqi?.dominant_pollutant,
            pm2_5:              d.pollutants?.pm2_5,
            timestamp:          d.timestamp,
          },
        })))
        .catch(() => {});
    });
  }, [stations]);

  const refreshStation = useCallback(async () => {
    if (!selected) return;
    try {
      const [lat, hist] = await Promise.all([
        api.getLatest(selected),
        api.getHistory(selected),
      ]);
      setLatest(lat);
      setHistory([...hist].reverse());
      setStationsAQI((prev) => ({
        ...prev,
        [selected]: {
          aqi:                lat.aqi?.aqi,
          category:           lat.aqi?.category,
          dominant_pollutant: lat.aqi?.dominant_pollutant,
          pm2_5:              lat.pollutants?.pm2_5,
          timestamp:          lat.timestamp,
        },
      }));
      setError(null);
    } catch (e) { setError(e.message); }
  }, [selected]);

  const refreshForecast = useCallback(async () => {
    if (!selected) return;
    try { setForecast(await api.getForecast(selected)); } catch {}
  }, [selected]);

  useEffect(() => {
    setLatest(null); setHistory([]); setForecast(null);
    refreshStation(); refreshForecast();
    const t1 = setInterval(refreshStation, REFRESH_MS);
    clearInterval(forecastTimer.current);
    forecastTimer.current = setInterval(refreshForecast, FORECAST_MS);
    return () => { clearInterval(t1); clearInterval(forecastTimer.current); };
  }, [selected]);


  const stationName = selected?.replace("KSPCB-", "") ?? "–";
  const currentCat  = latest?.aqi?.category;

  const freshnessLabel = dataAge ? (
    <span className="freshness-bar">
      <span className="freshness-dot" />
      Updated {dataAge}
    </span>
  ) : null;

  return (
    <div className="app-shell">
      {/* ── Keyboard shortcuts (global listener) ── */}
      <KeyboardShortcuts
        stations={stations}
        selected={selected}
        onSelect={setSelected}
        onVoiceToggle={() => setVoiceEnabled((v) => !v)}
        onRefresh={refreshStation}
      />

      {/* ── AQI threshold alert toast ── */}
      <AlertToast aqi={latest?.aqi} station={selected} />

      {/* ── Header ── */}
      <Header voiceEnabled={voiceEnabled} onVoiceToggle={() => setVoiceEnabled((v) => !v)} />

      {/* ── Hero ── */}
      <HeroSection
        stations={stations}
        selected={selected}
        onSelect={setSelected}
        onRunAnalysis={() => mainRef.current?.scrollIntoView({ behavior: "smooth" })}
      />

      {/* ── AQI Category Legend Bar ── */}
      <AQICategoryBar currentCategory={currentCat} />

      {/* ── City-wide Insights Banner ── */}
      <InsightsBanner stations={stations} stationsAQI={stationsAQI} />

      {error && <div className="error-bar">{error}</div>}

      {/* ── Station Comparison Table ── */}
      <StationTable
        stations={stations}
        stationsAQI={stationsAQI}
        selected={selected}
        onSelect={setSelected}
      />

      {/* ── Main Dashboard Grid ── */}
      <div ref={mainRef} className="content-grid">

        {/* LEFT: Map + Weather */}
        <div className="left-col">
          <FullscreenCard
            title="Station Network"
            icon={<MapIcon />}
            meta="Bangalore · 5 KSPCB stations"
            style={{ padding: 0 }}
            bodyStyle={{ height: 340 }}
          >
            <MapPanel
              stations={stations}
              stationsAQI={stationsAQI}
              selectedStation={selected}
              onSelect={setSelected}
            />
          </FullscreenCard>

          <FullscreenCard
            title="Weather Conditions"
            icon={<WeatherIcon />}
            meta={freshnessLabel}
          >
            <WeatherPanel weather={latest?.weather} timestamp={latest?.timestamp} />
          </FullscreenCard>
        </div>

        {/* RIGHT: AQI + Sub-indices + Health + Forecast */}
        <div className="right-col">
          <FullscreenCard
            title={`${stationName} — Air Quality Index`}
            icon={<GaugeIcon />}
            meta={currentCat}
          >
            <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 24, alignItems: "start" }}>
              <AQIGauge aqi={latest?.aqi} />
              <div>
                <div style={{
                  fontSize: 10, fontWeight: 600, letterSpacing: "1px",
                  textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 14,
                }}>
                  Pollutant Sub-Indices
                </div>
                <SubIndexPanel
                  pollutants={latest?.pollutants}
                  subIndices={latest?.aqi?.sub_indices}
                />
                {latest?.aqi?.dominant_pollutant && (
                  <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-dim)" }}>
                    Dominant: <strong style={{ color: "var(--text-sub)" }}>
                      {latest.aqi.dominant_pollutant.toUpperCase()}
                    </strong>
                    {latest?.location && (
                      <span style={{ marginLeft: 16 }}>
                        {latest.location.lat?.toFixed(4)}°N {latest.location.lon?.toFixed(4)}°E
                      </span>
                    )}
                  </div>
                )}
                {/* ── Health Advisory ── */}
                <HealthAdvisory aqi={latest?.aqi} />
              </div>
            </div>
          </FullscreenCard>

          <FullscreenCard
            title="AI Forecast · 24 h"
            icon={<ForecastIcon />}
            meta="Holt-Winters · voice every 5 min"
          >
            <ForecastPanel forecast={forecast} voiceEnabled={voiceEnabled} />
          </FullscreenCard>
        </div>
      </div>

      {/* ── Historical Charts ── */}
      <div className="charts-band">
        <FullscreenCard title="Particulate Matter" icon={<ChartIcon />} meta="µg/m³">
          <PollutantCharts history={history} chartType="pm" />
        </FullscreenCard>
        <FullscreenCard title="Gas Pollutants" icon={<ChartIcon />} meta="NO₂ · O₃ · CO">
          <PollutantCharts history={history} chartType="gas" />
        </FullscreenCard>
      </div>

      {/* ── Gaussian Plume ── */}
      <div style={{ padding: "0 28px 32px", maxWidth: 1400, margin: "0 auto", width: "100%" }}>
        <FullscreenCard
          title="Gaussian Plume Dispersion"
          icon={<PlumeIcon />}
          meta="Pasquill-Gifford · Briggs rural σ"
          style={{ padding: 0 }}
        >
          <PlumeVisualizer />
        </FullscreenCard>
      </div>
    </div>
  );
}
