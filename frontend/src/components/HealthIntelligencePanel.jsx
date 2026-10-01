import { useMemo } from "react";
import ConfidenceBadge from "./ConfidenceBadge";
import {
  computeAllIndices, riskLevel, cardiovascularRisk, respiratoryRisk,
  cpmContribution, CRP_REFERENCE,
} from "../lib/healthIndices";
import { advisory } from "../lib/healthGuidance";

function Ring({ value = 0, max = 100, size = 64, stroke = 5, color = "#00e5a0", label }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(Math.max(value / max, 0), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.8s ease" }} />
      </svg>
      <div style={{ position: "relative", marginTop: -size + 4, height: size - 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: size > 60 ? 15 : 12, fontWeight: 700, color }}>{value}</span>
      </div>
      {label && <span style={{ fontSize: 9, color: "var(--text-dim)", fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" }}>{label}</span>}
    </div>
  );
}

function HBar({ value, max = 100, color = "#00e5a0", height = 5 }) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100);
  return (
    <div style={{ width: "100%", height, background: "rgba(255,255,255,0.06)", borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: height / 2, transition: "width 0.6s ease" }} />
    </div>
  );
}

function Card({ label, value, unit, sub, color, tip }) {
  return (
    <div style={{
      background: "var(--bg-card2)", border: "1px solid var(--border)", borderRadius: 12,
      padding: "14px 16px",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.5px", textTransform: "uppercase", color: "var(--text-dim)" }}>{label}</span>
        {tip && <span title={tip} style={{ width: 14, height: 14, borderRadius: "50%", fontSize: 8, fontWeight: 800, background: "rgba(255,255,255,0.06)", color: "var(--text-dim)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "help" }}>i</span>}
      </div>
      <div style={{ fontSize: 26, fontFamily: "var(--font-mono)", fontWeight: 800, color, lineHeight: 1 }}>
        {value}<span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-dim)", marginLeft: 3 }}>{unit}</span>
      </div>
      <div style={{ fontSize: 11, fontWeight: 600, color, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

// `wind` is App.jsx's shared live-wind state (lib/useLiveWind.js). Telemetry
// has no wind field, so live wind speed is merged in here for the
// Ventilation Index. BLH still has no source, so VI stays null (see calcVI).
export default function HealthIntelligencePanel({ latest, forecast, wind }) {
  const windSpeed = wind?.status === "ok" ? wind.data.speed_m_s : undefined;
  const indices = useMemo(() => {
    if (!latest?.pollutants) return null;
    return computeAllIndices(latest.pollutants, { ...(latest.weather || {}), windSpeed },
      forecast ? { aqi: forecast?.current_aqi?.aqi } : null,
      latest?.aqi?.aqi ?? null);
  }, [latest?.pollutants, latest?.weather, forecast, windSpeed]);

  const contributions = useMemo(() => {
    if (!latest?.pollutants) return [];
    return cpmContribution(latest.pollutants);
  }, [latest?.pollutants]);

  if (!indices) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
        Select a station with sensor data to see health indices.
      </div>
    );
  }

  const risk = riskLevel(indices.iri);
  const cvRisk = cardiovascularRisk(indices.csi);
  const respRisk = respiratoryRisk(indices.rsi);
  const p = latest?.pollutants || {};

  // No advice of this panel's own: IRI/CAWI are this dashboard's composite
  // scores, not published indices, so the only health wording shown is
  // CPCB's impact for the current AQI (lib/healthGuidance.js).
  const cpcb = advisory(latest?.aqi?.aqi);
  const riskAdvice = cpcb ? `CPCB health impact at the current AQI (${cpcb.category}): ${cpcb.impact}.` : null;

  return (
    <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 18 }}>

      {/* Hero risk banner */}
      <div className="health-hero-banner" style={{
        background: `linear-gradient(135deg, ${risk.color}10 0%, transparent 60%)`,
        border: `1px solid ${risk.color}28`, borderRadius: 14, padding: "18px 22px",
      }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: risk.color }}>{risk.label} Risk</span>
            <span style={{ padding: "2px 10px", borderRadius: 20, fontSize: 10, fontWeight: 700, color: risk.color, background: `${risk.color}18`, border: `1px solid ${risk.color}40` }}>
              IRI {indices.iri}
            </span>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-sub)", margin: 0, maxWidth: 480, lineHeight: 1.5 }}>{riskAdvice}</p>
        </div>
        <div className="health-hero-rings">
          <Ring value={indices.iri} color={risk.color} size={68} stroke={6} label="IRI" />
          <Ring value={indices.aqhi} color="#4f8ef7" size={60} stroke={5} label="AQHI" />
        </div>
      </div>

      {/* 6 key metric cards */}
      <div className="health-metric-grid">
        <Card label="Predicted CRP" value={indices.crp.crp} unit="mg/L" sub={indices.crp.interpretation}
          color={indices.crp.color} tip="Estimated blood inflammation marker from air pollution" />
        <Card label="Cardiovascular" value={indices.csi} unit="/100" sub={cvRisk.label}
          color={cvRisk.color} tip="Heart and blood vessel strain from PM2.5, NO₂, CO" />
        <Card label="Respiratory" value={indices.rsi} unit="/100" sub={respRisk.label}
          color={respRisk.color} tip="Lung irritation risk from PM2.5, PM10, SO₂" />
        <Card label="Oxidative Stress" value={indices.osi} unit="/100"
          sub={indices.osi <= 25 ? "Low" : indices.osi <= 50 ? "Moderate" : "High"}
          color={indices.osi <= 25 ? "#22c55e" : indices.osi <= 50 ? "#facc15" : "#f87171" /* text-safe red: 5.2:1+ on cards; #ef4444 was 4.22 */}
          tip="Cell damage potential from pollutant exposure vs WHO limits" />
        <Card label="Inhaled Dose" value={indices.edi} unit="µg/day"
          sub="PM2.5 × breathing rate × 24h" color="#38bdf8"
          tip="Total PM2.5 inhaled over 24 hours at normal breathing rate" />
        <Card label="Clean Air Window" value={indices.cawi} unit="%"
          sub={indices.cawi >= 70 ? "High" : indices.cawi >= 40 ? "Medium" : "Low"}
          color="#00e5a0" tip="100 minus the Inflammatory Risk Index (this dashboard's composite score)" />
      </div>

      {/* CRP breakdown + pollutant contributions */}
      <div className="health-detail-grid">
        {/* CRP detail */}
        <div style={{ background: "var(--bg-card2)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 10 }}>
            Blood Inflammation (CRP)
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 30, fontFamily: "var(--font-mono)", fontWeight: 800, color: indices.crp.color }}>
              {indices.crp.crp}<span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 3 }}>mg/L</span>
            </div>
            <span style={{ padding: "3px 12px", borderRadius: 20, fontSize: 10, fontWeight: 700, color: indices.crp.color, background: `${indices.crp.color}18`, border: `1px solid ${indices.crp.color}40` }}>
              {indices.crp.interpretation}
            </span>
          </div>
          {/* CRP scale */}
          <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", marginBottom: 4 }}>
            {CRP_REFERENCE.map((r, i) => <div key={i} style={{ width: `${[25, 25, 40, 10][i]}%`, background: r.color, opacity: 0.7 }} />)}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: "var(--text-dim)" }}>
            <span>&lt;1 Low</span><span>1–3 Mild</span><span>3–10 Elevated</span><span>&gt;10 Acute</span>
          </div>
          {/* Contribution breakdown */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.8px", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 6 }}>
              Which Pollutants Cause This
            </div>
            {contributions.filter(c => c.value > 0).map((c) => (
              <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-sub)", width: 34 }}>{c.name}</span>
                <div style={{ flex: 1 }}><HBar value={c.value} color={c.color} /></div>
                <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: c.color, minWidth: 36, textAlign: "right" }}>{c.value}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* Ventilation + Exposure */}
        <div style={{ background: "var(--bg-card2)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
              Air Ventilation
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8 }}>
              How well the atmosphere disperses pollution
            </div>
            {indices.vi == null ? (
              /* VI = boundary-layer height × wind speed. Missing inputs are
                 shown as missing -- never computed as 0 with a "Poor" verdict. */
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div>
                  <ConfidenceBadge state="unavailable" label="UNAVAILABLE" />
                </div>
                <div style={{ fontSize: 10, color: "var(--text-sub)", lineHeight: 1.6 }}>
                  Needs boundary-layer height × wind speed.{" "}
                  Wind speed: <strong style={{ color: "var(--text)" }}>
                    {windSpeed != null ? `${windSpeed} m/s (live model nowcast)` : "unavailable"}
                  </strong>.{" "}
                  Boundary-layer height: <strong style={{ color: "var(--text)" }}>no data source in this system</strong>.
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ fontSize: 22, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text)" }}>
                    {indices.vi}<span style={{ fontSize: 10, color: "var(--text-dim)" }}>%</span>
                  </div>
                  <div style={{ flex: 1 }}>
                    <HBar value={indices.vi} color={indices.vi > 50 ? "#22c55e" : indices.vi > 25 ? "#facc15" : "#ef4444"} />
                  </div>
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
                  {indices.vi > 50 ? "Good — pollutants disperse quickly." : indices.vi > 25 ? "Moderate — some trapping possible." : "Poor — pollution accumulates near ground."}
                </div>
              </>
            )}
          </div>

          <div style={{ height: 1, background: "var(--border)" }} />

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
              Cumulative Exposure
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8 }}>
              Total pollutant dose over the past 24 hours
            </div>
            <div className="health-exposure-grid">
              <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.8px", textTransform: "uppercase", color: "var(--text-dim)" }}>Daily Dose</div>
                <div style={{ fontSize: 18, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text)" }}>
                  {indices.edi}<span style={{ fontSize: 9, color: "var(--text-dim)" }}> µg</span>
                </div>
              </div>
              <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.8px", textTransform: "uppercase", color: "var(--text-dim)" }}>Cumulative</div>
                <div style={{ fontSize: 18, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text)" }}>
                  {indices.ced}<span style={{ fontSize: 9, color: "var(--text-dim)" }}> µg·h</span>
                </div>
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: "var(--border)" }} />

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
              Clean Air Window
            </div>
            <div style={{
              padding: "10px 14px", borderRadius: 10,
              background: indices.cawi >= 70 ? "rgba(0,229,160,0.06)" : indices.cawi >= 40 ? "rgba(250,204,21,0.06)" : "rgba(239,68,68,0.06)",
              border: `1px solid ${indices.cawi >= 70 ? "rgba(0,229,160,0.15)" : indices.cawi >= 40 ? "rgba(250,204,21,0.15)" : "rgba(239,68,68,0.15)"}`,
            }}>
              <div style={{ fontSize: 20, fontFamily: "var(--font-mono)", fontWeight: 800, color: "#00e5a0", marginBottom: 4 }}>
                {indices.cawi}%
              </div>
              <div style={{ fontSize: 11, color: "var(--text-sub)" }}>
                100 − IRI. A composite score computed by this dashboard, not a CPCB or WHO index,
                and not advice -- see the CPCB health impact above.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Pollutant raw values */}
      <div style={{ background: "var(--bg-card2)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 12 }}>Current Readings</div>
        <div className="health-pollutant-grid">
          {[
            { label: "PM1",   value: p.pm1 != null ? +(+p.pm1).toFixed(1) : null, unit: "µg/m³", who: null, color: "#94a3b8" },
            { label: "PM2.5", value: p.pm2_5, unit: "µg/m³", who: 5, color: "#ef4444" },
            { label: "PM10",  value: p.pm10,  unit: "µg/m³", who: 15, color: "#f97316" },
            { label: "NO₂",   value: p.no2 != null ? +(+p.no2).toFixed(1) : null, unit: "µg/m³", who: 10, color: "#facc15" },
            { label: "O₃",    value: p.o3 != null ? +(+p.o3).toFixed(1) : null,      unit: "µg/m³", who: 60, color: "#22c55e" },
            { label: "NH₃",   value: p.nh3 != null ? +(+p.nh3).toFixed(1) : null,  unit: "µg/m³", who: null, color: "#a3e635" },
            { label: "H₂S",   value: p.h2s != null ? +(+p.h2s).toFixed(1) : null,  unit: "µg/m³", who: null, color: "#84cc16" },
            { label: "MQ-135", value: p.mq135 != null ? +(+p.mq135).toFixed(2) : null, unit: "proxy", who: null, color: "#2dd4bf" },
            { label: "H₂",    value: p.h2 != null ? +(+p.h2).toFixed(1) : null,     unit: "µg/m³", who: null, color: "#38bdf8" },
            { label: "CO",    value: (p.mq7_co ?? p.co) != null ? +((p.mq7_co ?? p.co)).toFixed(1) : null, unit: "µg/m³", who: null, color: "#60a5fa" },
            { label: "VOC",   value: p.voc_gas_ohm != null ? +(p.voc_gas_ohm).toFixed(0) : null, unit: "Ω", who: null, color: "#f472b6" },
          ].map((item) => {
            const over = item.who && item.value > item.who * 3;
            return (
              <div key={item.label} style={{
                padding: "10px 12px", borderRadius: 8,
                background: over ? `${item.color}08` : "rgba(255,255,255,0.02)",
                border: `1px solid ${over ? `${item.color}28` : "var(--border)"}`,
              }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: item.color }}>{item.label}</div>
                <div style={{ fontSize: 18, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text)" }}>
                  {item.value != null ? item.value : "–"}
                </div>
                <div style={{ fontSize: 8, color: "var(--text-dim)" }}>{item.unit}</div>
                {item.who && <div style={{ fontSize: 8, color: "var(--text-dim)", marginTop: 2 }}>WHO: {item.who}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Provenance -- which numbers are a published formula and which are
          this dashboard's own. The card meta says the same in short; keep
          the two in step, and never call the composites "peer-reviewed". */}
      <div data-testid="health-provenance" style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7, padding: "0 4px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div>
          <strong style={{ color: "var(--text-sub)" }}>Published formula:</strong>{" "}
          AQHI (Stieb et al. 2008, Health Canada), computed here from this station's readings.
          O₃ is not measured, so its term is zero.
        </div>
        <div>
          <strong style={{ color: "var(--text-sub)" }}>This dashboard's own scores</strong>{" "}
          (not CPCB, WHO or peer-reviewed indices): Predicted CRP, IRI, Cardiovascular,
          Respiratory, Oxidative Stress, Clean Air Window. They apply coefficients from published
          studies -- CRP: Liu 2019, Zhang 2021 · Cardiovascular: Hoek 2013, Burnett 2018 ·
          Respiratory: Guarnieri 2014, Atkinson 2014 · Oxidative: Kelly 2011 vs WHO AQG 2021 --
          but the combination and 0-100 scaling are this dashboard's.
        </div>
        <div>
          <strong style={{ color: "var(--text-sub)" }}>Arithmetic:</strong>{" "}
          Inhaled Dose = PM2.5 × breathing rate (1.2 m³/h) × 24 h.
        </div>
      </div>
    </div>
  );
}
