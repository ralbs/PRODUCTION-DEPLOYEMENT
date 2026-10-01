import { useEffect, useState } from "react";
import ConfidenceBadge from "./ConfidenceBadge";
import { DEPLOYMENT } from "../lib/deployment";
import { STALE_AFTER_MIN } from "../lib/heroModel";
import { PRESETS } from "../lib/sensitivity";

// The hero, per docs/HERO_SPEC.md. `model` comes from lib/heroModel.js
// (pure, tested) -- this component only lays it out. Colour is the AQI
// category from lib/aqiColor.js, used as an accent + light tint, never as a
// fill behind text; in stale mode everything goes neutral so the colour
// can't claim current conditions.
//
// The viewer's alert level (lib/sensitivity.js) sets the emphasis: at or
// above it, the category colour is stronger (current mode only); below it,
// the hero stays quiet. In stale mode colour stays neutral either way and
// the emphasis is typographic -- a past reading must not tint as current.
export default function HeroSection({ stations, selected, onSelect, model, sensitivity, onSensitivityChange, onShowDetails, voiceEnabled, onVoiceToggle }) {
  const live = model.mode === "current";
  const above = model.personal?.above;
  const rgb = live && model.rgb ? model.rgb.join(",") : "148,163,184";
  const style = {
    "--hero-accent": `rgb(${rgb})`,
    "--hero-tint": `rgba(${rgb}, ${live ? (above ? 0.18 : 0.05) : 0.05})`,
    "--hero-accent-w": live && above ? "10px" : "4px",
  };

  return (
    <section className={`hero2 hero2-${model.mode}${above ? " hero2-above" : ""}`} style={style} aria-live="polite">
      <div className="hero2-inner">
        <div className="hero2-top">
          <div className="hero-location">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
            </svg>
            {DEPLOYMENT.city}, {DEPLOYMENT.region}
          </div>
          <div className="hero2-controls">
          <SensitivityPicker value={sensitivity} onChange={onSensitivityChange} />
          <label className="hero2-station">
            <span className="hero2-station-label">Station</span>
            <select className="hero-select" value={selected || ""} onChange={(e) => onSelect(e.target.value)}>
              {/* Without this, a null selection still DISPLAYS the first option. */}
              {!selected && <option value="" disabled>{stations.length ? "No real station" : "—"}</option>}
              {stations.map((s) => (
                <option key={s.station_id} value={s.station_id}>{s.station_id}</option>
              ))}
            </select>
          </label>
          {/* Voice alerts -- moved here when the top bar was removed; the only
              other way to toggle it is the V key, which phones don't have. */}
          <button type="button" className={`hero2-voice${voiceEnabled ? " is-on" : ""}`} onClick={onVoiceToggle}
            aria-label="Voice alerts" aria-pressed={!!voiceEnabled}
            title={voiceEnabled ? "Voice alerts on -- click to turn off" : "Turn on voice alerts"}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              {voiceEnabled
                ? <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                : <><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></>}
            </svg>
            <span>{voiceEnabled ? "Voice on" : "Voice"}</span>
          </button>
          </div>
        </div>

        <div className="hero2-body">
          <div className="hero2-text">
            <h1 className="hero2-headline" data-testid="hero-headline">{model.headline}</h1>
            {model.personal && (
              <p className={`hero2-personal ${model.personal.above ? "is-above" : "is-below"}`} data-testid="hero-personal">
                {model.personal.text}
              </p>
            )}
            {model.secondary && <p className="hero2-secondary" data-testid="hero-secondary">{model.secondary}</p>}

            {live && model.trend?.text && (
              <p className="hero2-trend" data-testid="hero-trend">
                {model.trend.text}{" "}
                <ConfidenceBadge state="estimated" label="STATISTICAL FORECAST" timestamp={model.trend.generatedAt} />
              </p>
            )}
            {live && model.trend && !model.trend.text && (
              <p className="hero2-note" data-testid="hero-trend-none">
                {model.trend.why === "no_forecast" || model.trend.why === "too_few_points"
                  ? "No trend shown — not enough readings for a forecast yet."
                  : "No trend shown — the forecast isn't reliable at this reading frequency yet."}
              </p>
            )}

            {model.direction && <p className="hero2-direction" data-testid="hero-direction">{model.direction}</p>}
          </div>

          {model.aqi != null && (
            <div className="hero2-figure">
              <div className="hero2-aqi-label">{live ? "AQI" : "Last AQI"}</div>
              <div className="hero2-aqi" data-testid="hero-aqi">{model.aqi}</div>
              <div className="hero2-cat">{model.category}</div>
              <ConfidenceBadge state="measured" label="LATEST READING"
                timestamp={model.readingAtMs ? new Date(model.readingAtMs).toISOString() : null}
                staleAfterMinutes={STALE_AFTER_MIN} />
            </div>
          )}
        </div>

        <button type="button" className="hero2-details" onClick={onShowDetails}>
          Details: map, forecast, source direction, readings ↓
        </button>
      </div>
    </section>
  );
}

// General / Sensitive presets or a raw CPCB AQI number. The number input
// keeps its own draft so typing "1" on the way to "150" doesn't commit 1.
function SensitivityPicker({ value, onChange }) {
  const [draft, setDraft] = useState(String(value?.threshold ?? ""));
  useEffect(() => { setDraft(String(value?.threshold ?? "")); }, [value?.threshold]);
  if (!value) return null;
  const commit = () => {
    const t = Number(draft);
    if (Number.isInteger(t) && t >= 1 && t <= 500) onChange({ kind: "custom", threshold: t });
    else setDraft(String(value.threshold));
  };
  return (
    <div className="hero2-sens">
      <label className="hero2-station">
        <span className="hero2-station-label">Alert me at</span>
        <select className="hero-select" data-testid="sens-kind" value={value.kind}
          onChange={(e) => onChange(e.target.value === "custom"
            ? { kind: "custom", threshold: value.threshold } : { kind: e.target.value })}>
          {Object.entries(PRESETS).map(([k, p]) => (
            <option key={k} value={k}>{p.label} (AQI {p.threshold}+)</option>
          ))}
          <option value="custom">My own AQI level…</option>
        </select>
      </label>
      {value.kind === "custom" && (
        <input className="hero2-sens-num" data-testid="sens-threshold" type="number" min="1" max="500" step="1"
          aria-label="Your alert level, CPCB AQI" value={draft}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
      )}
    </div>
  );
}
