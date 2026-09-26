import { useState, useEffect, useMemo } from "react";
import { api } from "../api";
import ConfidenceBadge from "./ConfidenceBadge";
import { pm25ToRgb } from "../lib/aqiColor";
import { downwindBearing, compassPoint } from "../lib/wind";
import { WIND_REFRESH_MIN } from "../lib/useLiveWind";
import { plumeCardMeta } from "../lib/plumeCardMeta";

const STABILITY_LABELS = {
  A: "Very Unstable — strong daytime sun, light wind",
  B: "Unstable — moderate sun, light wind",
  C: "Slightly Unstable — overcast day or moderate wind",
  D: "Neutral — cloudy day or strong wind",
  E: "Slightly Stable — clear night, moderate wind",
  F: "Stable — clear night, light wind",
};

// PROMPT_FLOW_UI.md Phase U5's map-move decision: the dispersion grid now
// renders as a real geo-anchored overlay on MapPanel.jsx (see that file's
// own comment on why), not a standalone canvas here. This component keeps
// the plain-language explanation/params and a static legend + distance
// scale as the primary readout, per the phase's "replacing raw µg/m³
// grid-cell values as the primary readout" requirement -- `onResult`
// forwards the fetched grid up to App.jsx, which is the only other
// consumer (MapPanel) that needs the raw cell data.
const LEGEND_STOPS = [0, 30, 60, 90, 120, 200, 300]; // µg/m³, spans the CPCB PM2.5 bands
function legendGradientCss(maxC) {
  const stops = LEGEND_STOPS.filter((c) => c <= Math.max(maxC, 30));
  if (!stops.includes(maxC)) stops.push(maxC);
  return stops
    .map((c) => {
      const [r, g, b] = pm25ToRgb(c);
      return `rgb(${r},${g},${b}) ${((c / maxC) * 100).toFixed(0)}%`;
    })
    .join(", ");
}

// `wind` is App.jsx's shared live-wind state (lib/useLiveWind.js):
// { status: "loading"|"ok"|"unavailable", data } with data in the
// SourceDirection wind shape. The board has no wind sensor and telemetry
// carries no wind field, so this is the ONLY wind source -- if it's
// unavailable there is deliberately no default-city fallback.
export default function PlumeVisualizer({ latest, wind = { status: "loading", data: null }, onResult }) {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [result,  setResult]  = useState(null);

  const windOk = wind.status === "ok";
  // A Gaussian plume is undefined in calm air (u is in the denominator), so a
  // real 0 m/s reading is reported as calm, not replaced with a guess.
  const calm = windOk && !(wind.data.speed_m_s > 0);

  // Auto-derive parameters from sensor data + live wind
  const params = useMemo(() => {
    if (!windOk || calm) return null;
    const pollutants = latest?.pollutants || {};

    const pm25 = pollutants.pm2_5 || 0;
    const windSpeed = wind.data.speed_m_s;
    const isDaytime = (() => {
      const h = new Date().getHours();
      return h >= 6 && h < 18;
    })();

    // Estimate emission rate from PM2.5 (heuristic for urban area)
    // Higher PM2.5 → higher implied nearby source strength
    const Q = Math.max(0.5, pm25 * 0.002);

    // Source height: typical urban ground-level + traffic mix
    const H = 15;

    // Max distance: scale with wind speed
    const maxDistance = Math.min(10000, Math.max(3000, windSpeed * 2000));

    // The plume grid wants the bearing the plume TRAVELS toward; the API
    // gives where the wind comes FROM. See lib/wind.js.
    const windDir = downwindBearing(wind.data.dir_from_deg);

    return { Q: +Q.toFixed(3), u: windSpeed, H, isDaytime, windDir, maxDistance };
  }, [latest?.pollutants, windOk, calm, wind.data]);

  // Auto-calculate whenever params change
  useEffect(() => {
    if (!latest?.pollutants || !params) { setResult(null); onResult?.(null); return; }

    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const data = await api.estimatePlume({
          Q:              params.Q,
          u:              params.u,
          H:              params.H,
          isDaytime:      params.isDaytime,
          windDir:        params.windDir,
          maxDistance:    params.maxDistance,
          grid:           true,
          xSteps:         80,
          ySteps:         60,
        });
        if (!cancelled) { setResult(data); onResult?.(data); }
      } catch (err) {
        if (!cancelled) { setError(err.message); onResult?.(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onResult is a setState from App.jsx, stable per render cycle, not a real dep
  }, [latest?.pollutants, params]);

  const pm25 = latest?.pollutants?.pm2_5;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, minHeight: 380 }}>
      {/* ── Left: Explanation + Parameters ── */}
      <div style={{
        padding: "22px 24px", borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column", gap: 14,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
            How Pollution Spreads in the Air
          </div>
          <p style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.7 }}>
            This model shows how pollutants from nearby sources (traffic, construction, industry)
            travel and spread downwind. The <strong style={{ color: "var(--text)" }}>brighter the area</strong>,
            the higher the pollutant concentration at that spot.
          </p>
        </div>

        {/* Auto-derived parameters */}
        <div style={{
          padding: "12px 14px", borderRadius: 10,
          background: "rgba(0,229,160,0.05)", border: "1px solid rgba(0,229,160,0.12)",
        }}>
          {/* Same caption as the card header (lib/plumeCardMeta.js) -- the
              fixed "Auto-Calculated from Live Data" sat above "No data"
              whenever live wind was unavailable. */}
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--accent)", marginBottom: 8 }}>
            {plumeCardMeta(wind, latest)}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <ParamItem
              label="Wind"
              value={windOk
                ? `${wind.data.speed_m_s} m/s from ${compassPoint(wind.data.dir_from_deg)}`
                : wind.status === "loading" ? "Loading…" : "No data"}
              sub={
                /* Confidence treatment (root CLAUDE.md): a live NWP model
                   nowcast is ESTIMATED, never "measured" -- the same mapping
                   SourceDirectionPanel uses for live_model_nowcast -- and its
                   age comes from the provider's own as_of, with Open-Meteo's
                   15-min update cadence as next-expected. */
                windOk
                  ? <ConfidenceBadge state="estimated" label="MODEL NOWCAST WIND"
                      timestamp={wind.data.as_of} cadenceMinutes={WIND_REFRESH_MIN} />
                  // Nothing was estimated here, so never an "estimated" badge:
                  // no badge while loading, the distinct no-data state after.
                  : wind.status === "unavailable"
                    ? <ConfidenceBadge state="unavailable" label="NO LIVE WIND" />
                    : null
              } />
            <ParamItem label="Source Height" value={params ? `${params.H} m` : "–"} sub="Urban average" />
            <ParamItem label="Emission Rate" value={params ? `${params.Q} g/s` : "–"} sub={`From PM2.5: ${pm25 ?? "–"} µg/m³`} />
            <ParamItem label="Time of Day" value={params ? (params.isDaytime ? "Daytime" : "Night") : "–"} sub="Affects air stability" />
          </div>
        </div>

        {/* What this means */}
        {result && (
          <div style={{
            padding: "10px 14px", borderRadius: 10,
            background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)",
          }}>
            {/* --text-dim on this card's bg is the same real WCAG AA
                contrast failure (2.03:1, needs 4.5:1) as the Air Stability
                caption below -- also pre-existing, also fixed here while
                already in this file for the same reason. */}
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--text-sub)", marginBottom: 6 }}>
              What This Means
            </div>
            <p style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.7, margin: 0 }}>
              Peak pollution of <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                {result.maxC_ugm3.toFixed(1)} µg/m³</strong> is expected{" "}
              <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                {result.peakX_m}m</strong> downwind.
              {" "}{result.maxC_ugm3 > 60
                ? "This exceeds healthy limits — sensitive groups should avoid outdoor activity in the downwind area."
                : result.maxC_ugm3 > 30
                ? "Moderate levels — sensitive individuals may want to limit prolonged outdoor activity downwind."
                : "Levels are within acceptable range for most people."}
            </p>
          </div>
        )}

        {/* Stability class explanation. --text-dim on --bg-card is a real
            WCAG AA contrast failure (2.19:1, needs 4.5:1) -- confirmed via
            axe in Phase U5's verification pass, pre-existing (this div's
            color was untouched by U5's own recolor work), fixed here since
            it was already in the file being touched. */}
        {result && (
          <div style={{ fontSize: 10, color: "var(--text-sub)", lineHeight: 1.6 }}>
            <strong style={{ color: "var(--text-sub)" }}>Air Stability:</strong>{" "}
            {STABILITY_LABELS[result.cls] || result.cls} —{" "}
            {["A", "B"].includes(result.cls) && "pollutants disperse quickly in turbulent air."}
            {["C", "D"].includes(result.cls) && "moderate dispersion — pollutants spread at a medium rate."}
            {["E", "F"].includes(result.cls) && "pollutants stay concentrated near ground level — poor dispersion."}
          </div>
        )}
      </div>

      {/* ── Right: plain-language distance scale + legend (the actual
          geo-anchored overlay now lives on the Station Map above) ── */}
      <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-sub)" }}>
            Pollution Dispersion
          </span>
          {result && (
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              {result.grid?.length ?? 0} points on map
            </span>
          )}
        </div>

        {loading ? (
          <div style={{ fontSize: 12, color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
            ⟳ Computing dispersion…
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6, fontFamily: "inherit" }}>
              Using Pasquill-Gifford model with Briggs coefficients
            </div>
          </div>
        ) : error ? (
          <span style={{ color: "#ef4444", fontSize: 12 }}>{error}</span>
        ) : wind.status === "unavailable" ? (
          <span style={{ color: "var(--text-sub)", fontSize: 12, lineHeight: 1.7 }}>
            Live wind is unavailable, so no dispersion estimate is shown. This panel
            never substitutes a default wind: a plume drawn from a guessed wind
            would point in a made-up direction.
          </span>
        ) : calm ? (
          <span style={{ color: "var(--text-sub)", fontSize: 12, lineHeight: 1.7 }}>
            Calm air (0 m/s) right now. The Gaussian plume model is undefined without
            wind, so no dispersion estimate is shown.
          </span>
        ) : !result ? (
          <span style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.7 }}>
            {latest?.pollutants
              ? "Computing from live data…"
              : "Select a station with sensor data to see the dispersion overlay on the map above"}
          </span>
        ) : (
          <>
            <p style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.6, margin: 0 }}>
              The colored overlay on the <strong style={{ color: "var(--text)" }}>Station Map</strong> above
              shows this same estimate anchored to {selectedStationLabel(latest)}'s real position, extending{" "}
              <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                {(result.gridMeta.maxDist / 1000).toFixed(1)} km
              </strong> downwind.
            </p>

            <div>
              <div style={{
                height: 10, borderRadius: 6,
                background: `linear-gradient(90deg, ${legendGradientCss(result.maxC_ugm3)})`,
              }} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <span style={{ fontSize: 9, color: "var(--text-dim)" }}>0 µg/m³</span>
                <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                  {result.maxC_ugm3.toFixed(0)} µg/m³ (peak)
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function selectedStationLabel(latest) {
  // GET /api/telemetry/latest spreads the raw Telemetry doc, so the id lives
  // at meta.station_id (backend/models/Telemetry.js), never a top-level field.
  const id = latest?.meta?.station_id;
  return id ? id.replace("KSPCB-", "") : "the station";
}

function ParamItem({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 600, color: "var(--text-dim)", letterSpacing: "0.5px" }}>{label}</div>
      <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--text)" }}>{value}</div>
      <div style={{ fontSize: 9, color: "var(--text-dim)" }}>{sub}</div>
    </div>
  );
}
