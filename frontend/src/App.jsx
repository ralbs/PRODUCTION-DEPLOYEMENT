import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { api } from "./api";
import { aqiToRgb } from "./lib/aqiColor";

import HeroSection       from "./components/HeroSection";
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
import HealthIntelligencePanel from "./components/HealthIntelligencePanel";
import SourceDirectionPanel   from "./components/SourceDirectionPanel";
import { useLiveWind } from "./lib/useLiveWind";
import { plumeCardMeta } from "./lib/plumeCardMeta";
import { SOURCE_DIRECTION_CADENCE_MIN } from "./lib/lastRun";
import { buildHeroModel, fmtAge } from "./lib/heroModel";
import { pickDefaultStation } from "./lib/stations";
import { loadSensitivity, saveSensitivity } from "./lib/sensitivity";

const REFRESH_MS  = 60_000;
const FORECAST_MS = 5 * 60_000;

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
const HealthIcon   = () => I("M22 12h-4l-3 9L9 3l-3 9H2");
const DirectionIcon = () => I("M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z");

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

// A clock for age-dependent UI: the hero has to go stale on its own even
// when no new reading (and so no re-render) ever arrives.
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function App() {
  const [stations, setStations]         = useState([]);
  const [selected, setSelected]         = useState(null);
  // "loading"|"ok"|"no_real_station" -- the last when only test stations
  // have reported (lib/stations.js); the hero says so instead of picking one.
  const [stationsStatus, setStationsStatus] = useState("loading");
  const [latest, setLatest]             = useState(null);
  const [history, setHistory]           = useState([]);
  const [forecast, setForecast]         = useState(null);
  // "loading"|"ok"|"not_found"|"error" -- without this, a 404 ("not enough
  // data to build forecast") left ForecastPanel on "Loading forecast..."
  // forever, since the catch below used to swallow every failure.
  const [forecastStatus, setForecastStatus] = useState("loading");
  // { status: "idle"|"loading"|"ok"|"not_found"|"error", doc, error } --
  // see SourceDirectionPanel.jsx for how each status renders.
  const [sourceDirection, setSourceDirection] = useState({ status: "idle", doc: null, error: null });
  // { status: "idle"|"ok"|"not_found"|"error", doc } -- see refreshLastRun.
  const [lastRun, setLastRun] = useState({ status: "idle", doc: null });
  // PROMPT_FLOW_UI.md Phase U5's map-move: PlumeVisualizer still owns
  // fetching (it already derives Q/H/windDir from `latest`), but the raw
  // result is lifted here so MapPanel can draw the same real grid as a geo
  // overlay -- same lift-and-share pattern already used for sourceDirection
  // above (SourceDirectionPanel + MapPanel's bearing wedge).
  const [plumeResult, setPlumeResult]   = useState(null);
  const [stationsAQI, setStationsAQI]   = useState({});
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [error, setError]               = useState(null);
  const forecastTimer = useRef(null);
  const mainRef       = useRef(null);
  // Stale-response guard for refreshStation/refreshForecast/
  // refreshSourceDirection below: none of the three cancel their in-flight
  // fetch when `selected` changes, so a slow response for a station the
  // user has since switched away from would otherwise commit its data
  // under the NEW station's name -- confirmed as a real bug (not
  // hypothetical): switching while a fetch is genuinely in flight let a
  // stale response silently overwrite `latest` for up to REFRESH_MS
  // (60s) before the next periodic refresh happened to correct it.
  // Read/written like MapPanel.jsx's dataRef -- assigned every render,
  // not via a useEffect, so it's always current by the time an async
  // callback checks it.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const dataAge = useDataFreshness(latest?.timestamp);

  useEffect(() => {
    api.getStations()
      .then((list) => {
        setStations(list);
        const def = pickDefaultStation(list);
        setSelected(def);
        setStationsStatus(def ? "ok" : "no_real_station");
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!stations.length) return;
    stations.forEach((s) => {
      api.getLatest(s.station_id)
        .then((d) => setStationsAQI((prev) => ({
          ...prev,
          [s.station_id]: {
            aqi: d.aqi?.aqi, category: d.aqi?.category,
            dominant_pollutant: d.aqi?.dominant_pollutant,
            pm2_5: d.pollutants?.pm2_5, timestamp: d.timestamp,
          },
        })))
        .catch(() => {});
    });
  }, [stations]);

  const refreshStation = useCallback(async () => {
    if (!selected) return;
    const requestedFor = selected;
    try {
      const [lat, hist] = await Promise.all([api.getLatest(selected), api.getHistory(selected)]);
      // Stale-response guard: the user may have switched stations while
      // this was in flight -- see selectedRef's comment above. Discard
      // rather than commit a slower station's data under a newer one's name.
      if (selectedRef.current !== requestedFor) return;
      setLatest(lat);
      setHistory([...hist].reverse());
      setStationsAQI((prev) => ({
        ...prev,
        [requestedFor]: {
          aqi: lat.aqi?.aqi, category: lat.aqi?.category,
          dominant_pollutant: lat.aqi?.dominant_pollutant,
          pm2_5: lat.pollutants?.pm2_5, timestamp: lat.timestamp,
        },
      }));
      setError(null);
    } catch (e) {
      if (selectedRef.current !== requestedFor) return;
      setError(e.message);
    }
  }, [selected]);

  const refreshForecast = useCallback(async () => {
    if (!selected) return;
    const requestedFor = selected;
    try {
      const data = await api.getForecast(selected);
      if (selectedRef.current !== requestedFor) return;
      setForecast(data);
      setForecastStatus("ok");
    } catch (e) {
      if (selectedRef.current !== requestedFor) return;
      if (e.message.startsWith("404")) {
        setForecast(null);
        setForecastStatus("not_found");
      } else {
        // A failed periodic refresh keeps any forecast already on screen;
        // the panel only shows the error when there's nothing to show.
        setForecastStatus("error");
      }
    }
  }, [selected]);

  // PROMPT_FLOW_UI.md Phase U3 -- no fixed polling interval here, unlike
  // REFRESH_MS/FORECAST_MS above. A source-direction document is only ever
  // produced by ctm-core/scripts/source_direction_worker.py on a real
  // statistical spike (see PROMPT_FLOW_INTEGRATION.md's Phase I3), not on
  // any schedule the frontend could usefully match -- polling it every
  // REFRESH_MS would almost always just re-fetch the same document.
  // Re-fetch on station change only; the "Direction inconclusive"/
  // "not found" states already make a stale-looking result impossible to
  // misread as fresh (ConfidenceBadge ages from the document's own
  // timestamp regardless of when this fetch ran).
  const refreshSourceDirection = useCallback(async () => {
    if (!selected) return;
    const requestedFor = selected;
    setSourceDirection((s) => ({ ...s, status: "loading" }));
    try {
      const doc = await api.getSourceDirection(selected);
      if (selectedRef.current !== requestedFor) return;
      setSourceDirection({ status: "ok", doc, error: null });
    } catch (e) {
      if (selectedRef.current !== requestedFor) return;
      if (e.message.startsWith("404")) setSourceDirection({ status: "not_found", doc: null, error: null });
      else setSourceDirection({ status: "error", doc: null, error: e.message });
    }
  }, [selected]);

  // The worker's LAST RUN for this station (every run, skips included) --
  // what lets the panel tell "no spike" from "spike, but no wind". Unlike an
  // estimate, this record is rewritten on the cron's own cadence, so it IS
  // polled on that cadence. Same stale-station guard as above.
  const refreshLastRun = useCallback(async () => {
    if (!selected) return;
    const requestedFor = selected;
    try {
      const doc = await api.getSourceDirectionLastRun(selected);
      if (selectedRef.current !== requestedFor) return;
      setLastRun({ status: "ok", doc });
    } catch (e) {
      if (selectedRef.current !== requestedFor) return;
      setLastRun({ status: e.message.startsWith("404") ? "not_found" : "error", doc: null });
    }
  }, [selected]);

  useEffect(() => {
    setLatest(null); setHistory([]); setForecast(null); setForecastStatus("loading");
    setSourceDirection({ status: "idle", doc: null, error: null });
    setLastRun({ status: "idle", doc: null });
    // Same guard as sourceDirection above, and for the same reason:
    // MapPanel's buildPlumeGeoCells anchors plumeResult's grid to
    // `selectedStation`'s real coordinates, not to whichever station the
    // grid data actually came from -- without this, the OLD station's
    // stale dispersion estimate would render anchored at the NEW
    // station's real position for the gap between selecting it and
    // PlumeVisualizer's re-fetch resolving. Found during Phase U5's
    // coordinate-alignment spot-check, not from the original U5 build.
    setPlumeResult(null);
    refreshStation(); refreshForecast(); refreshSourceDirection(); refreshLastRun();
    const tRun = setInterval(refreshLastRun, SOURCE_DIRECTION_CADENCE_MIN * 60 * 1000);
    const t1 = setInterval(refreshStation, REFRESH_MS);
    clearInterval(forecastTimer.current);
    forecastTimer.current = setInterval(refreshForecast, FORECAST_MS);
    return () => { clearInterval(t1); clearInterval(tRun); clearInterval(forecastTimer.current); };
  }, [selected]);

  const stationName = selected?.replace("KSPCB-", "") ?? "–";
  const currentCat  = latest?.aqi?.category;

  // Live wind for the selected station's real coordinates (GET /api/wind,
  // same shape as SourceDirection's `wind`). Fetched once here and shared by
  // the ambient field, PlumeVisualizer and the Ventilation Index, so they
  // can't disagree about the wind.
  const liveWind = useLiveWind(stations.find((s) => s.station_id === selected)?.location);

  // The Pollution Dispersion caption is computed ONCE, here, and the same
  // string is handed to both places that show it (the card header and
  // PlumeVisualizer's params box) -- one value, not two call sites that
  // could be given different inputs and drift apart.
  const plumeCaption = plumeCardMeta(liveWind, latest);

  // PROMPT_FLOW_UI.md Phase U5's ambient wind field. It used to read wind
  // only from a SourceDirection document, which exists only after a real
  // spike -- so for any station without a recent spike it sat at opacity 0
  // permanently. It now uses the station's live wind, independent of any
  // estimate. Opacity still encodes provenance: 0.4 for a model nowcast
  // (live_model_nowcast), 1 for real ground-station wind, 0 when there is
  // no wind at all -- never a fabricated bearing.
  // docs/HERO_SPEC.md: what the hero says, and whether it may speak in the
  // present tense at all (stale after 10 min without a reading).
  const nowMs = useNow();
  // The viewer's own alert level -- this browser only, no account.
  const [sensitivity, setSensitivity] = useState(() => loadSensitivity());
  const changeSensitivity = useCallback((pref) => setSensitivity(saveSensitivity(pref)), []);
  const heroModel = buildHeroModel({
    stationId: selected, latest,
    latestStatus: latest ? "ok" : error ? "error"
      : !selected && stationsStatus === "no_real_station" ? "no_real_station" : "loading",
    forecast: forecastStatus === "ok" ? forecast : null,
    sourceDirection, lastRun, sensitivity, nowMs,
  });
  const heroLive = heroModel.mode === "current";

  const ambientStyle = useMemo(() => {
    const wind = liveWind.status === "ok" ? liveWind.data : null;
    const hasWind = wind?.speed_m_s != null && wind?.dir_from_deg != null;
    // A stale reading's category colour must not tint the page as if it
    // were current (HERO_SPEC.md s.4) -- neutral grey instead.
    const [r, g, b] = heroLive ? (aqiToRgb(latest?.aqi?.aqi) || [0, 0, 0]) : [148, 163, 184];
    return {
      "--wind-bearing-deg": `${wind?.dir_from_deg ?? 0}deg`,
      "--wind-drift-duration": `${Math.max(8, 40 - (wind?.speed_m_s ?? 0) * 3)}s`,
      "--aqi-tint": `rgba(${r}, ${g}, ${b}, 0.08)`,
      "--wind-ambient-opacity": !hasWind
        ? 0
        : wind.source_tier === "historical_ground_station" ? 1 : 0.4,
    };
  }, [liveWind, latest?.aqi?.aqi, heroLive]);

  return (
    <div className="app-shell">
      <div className="ambient-wind-field" style={ambientStyle} />
      <KeyboardShortcuts stations={stations} selected={selected} onSelect={setSelected}
        onVoiceToggle={() => setVoiceEnabled((v) => !v)} onRefresh={refreshStation} />
      <AlertToast aqi={latest?.aqi} station={selected} />
      {/* One <main> landmark for the page (axe landmark-one-main / region). */}
      <main>
      <HeroSection stations={stations} selected={selected} onSelect={setSelected}
        model={heroModel} sensitivity={sensitivity} onSensitivityChange={changeSensitivity}
        onShowDetails={() => mainRef.current?.scrollIntoView({ behavior: "smooth" })}
        voiceEnabled={voiceEnabled} onVoiceToggle={() => setVoiceEnabled((v) => !v)} />

      {error && <div className="error-bar">{error}</div>}

      {/* Station comparison */}
      <StationTable stations={stations} stationsAQI={stationsAQI} selected={selected} onSelect={setSelected} />

      {/* Main dashboard */}
      <div ref={mainRef} className="content-grid">
        <div className="left-col">
          <FullscreenCard title="Station Map" icon={<MapIcon />}
            meta={`${stations.length} stations`} className="card-flush" bodyStyle={{ height: 340 }}>
            <MapPanel stations={stations} stationsAQI={stationsAQI} selectedStation={selected} onSelect={setSelected}
              sourceDirection={sourceDirection.status === "ok" ? sourceDirection.doc : null}
              plumeResult={plumeResult} />
          </FullscreenCard>
          <FullscreenCard title="Weather" icon={<WeatherIcon />}
            meta={dataAge ? `Updated ${dataAge}` : ""}>
            <WeatherPanel weather={latest?.weather} timestamp={latest?.timestamp} />
          </FullscreenCard>
        </div>

        <div className="right-col">
          <FullscreenCard title={`${stationName} Air Quality`} icon={<GaugeIcon />} meta={currentCat}>
            <div className="aq-card-grid">
              <AQIGauge aqi={latest?.aqi} />
              <div>
                <SubIndexPanel pollutants={latest?.pollutants} subIndices={latest?.aqi?.sub_indices} />
                {latest?.aqi?.dominant_pollutant && (
                  <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-dim)" }}>
                    Dominant: <strong style={{ color: "var(--text-sub)" }}>{latest.aqi.dominant_pollutant.toUpperCase()}</strong>
                  </div>
                )}
                <HealthAdvisory aqi={latest?.aqi} />
              </div>
            </div>
          </FullscreenCard>

          <FullscreenCard title="Trend Extrapolation" icon={<ForecastIcon />} meta="statistical, not a physics model">
            <ForecastPanel forecast={forecast} status={forecastStatus} voiceEnabled={voiceEnabled}
              reading={{ station: stationName, aqi: heroModel.aqi, stale: heroModel.mode === "stale",
                age: heroModel.ageMs != null ? fmtAge(heroModel.ageMs) : null }} />
          </FullscreenCard>

          <FullscreenCard title="Source Direction" icon={<DirectionIcon />}
            meta={sourceDirection.status === "ok" ? sourceDirection.doc.estimate_tier.replace(/_/g, " ") : ""}
            bodyStyle={{ padding: 0 }}>
            <SourceDirectionPanel state={sourceDirection} lastRun={lastRun} />
          </FullscreenCard>
        </div>
      </div>

      {/* Health Intelligence */}
      <div className="section-pad" style={{ marginBottom: 20 }}>
        <FullscreenCard title="Health Intelligence" icon={<HealthIcon />}
          meta="AQHI: published formula · rest: this dashboard's scores" bodyStyle={{ padding: 0 }}>
          <HealthIntelligencePanel latest={latest} forecast={forecast} wind={liveWind} />
        </FullscreenCard>
      </div>

      {/* Charts */}
      <div className="charts-band">
        <FullscreenCard title="Particulate Matter" icon={<ChartIcon />} meta="µg/m³">
          <PollutantCharts history={history} chartType="pm" />
        </FullscreenCard>
        <FullscreenCard title="Gas Pollutants" icon={<ChartIcon />} meta="NO₂ · CO">
          <PollutantCharts history={history} chartType="gas" />
        </FullscreenCard>
      </div>

      {/* Pollution Spread */}
      <div className="section-pad" style={{ paddingBottom: 32 }}>
        <FullscreenCard title="Pollution Dispersion" icon={<PlumeIcon />}
          meta={plumeCaption} className="card-flush" bodyStyle={{ padding: 0 }}>
          <PlumeVisualizer latest={latest} wind={liveWind} caption={plumeCaption} onResult={setPlumeResult} />
        </FullscreenCard>
      </div>
      </main>
    </div>
  );
}
