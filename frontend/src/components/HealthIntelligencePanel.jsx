import { useMemo } from "react";
import {
  computeAllIndices, riskLevel, cardiovascularRisk, respiratoryRisk,
  cpmContribution, CRP_REFERENCE,
} from "../lib/healthIndices";

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

export default function HealthIntelligencePanel({ latest, forecast }) {
  const indices = useMemo(() => {
    if (!latest?.pollutants) return null;
    return computeAllIndices(latest.pollutants, latest.weather || {},
      forecast ? { aqi: forecast?.current_aqi?.aqi } : null,
      latest?.aqi?.aqi ?? null);
  }, [latest?.pollutants, latest?.weather, forecast]);

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

  const riskAdvice = indices.iri <= 20 ? "Air is clean — safe for all outdoor activities."
    : indices.iri <= 40 ? "Mild concern for sensitive groups. Most people are fine outdoors."
    : indices.iri <= 60 ? "Limit prolonged outdoor exertion, especially for sensitive groups."
    : indices.iri <= 80 ? "Reduce outdoor activity. Sensitive groups should stay indoors."
    : "High risk — minimize outdoor exposure. Use air purifiers if available.";

  return (
    <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 18 }}>

      {/* Hero risk banner */}
      <div style={{
        background: `linear-gradient(135deg, ${risk.color}10 0%, transparent 60%)`,
        border: `1px solid ${risk.color}28`, borderRadius: 14, padding: "18px 22px",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20,
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
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexShrink: 0 }}>
          <Ring value={indices.iri} color={risk.color} size={68} stroke={6} label="IRI" />
          <Ring value={indices.aqhi} color="#4f8ef7" size={60} stroke={5} label="AQHI" />
        </div>
      </div>

      {/* 6 key metric cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <Card label="Predicted CRP" value={indices.crp.crp} unit="mg/L" sub={indices.crp.interpretation}
          color={indices.crp.color} tip="Estimated blood inflammation marker from air pollution" />
        <Card label="Cardiovascular" value={indices.csi} unit="/100" sub={cvRisk.label}
          color={cvRisk.color} tip="Heart and blood vessel strain from PM2.5, NO₂, CO" />
        <Card label="Respiratory" value={indices.rsi} unit="/100" sub={respRisk.label}
          color={respRisk.color} tip="Lung irritation risk from PM2.5, PM10, SO₂" />
        <Card label="Oxidative Stress" value={indices.osi} unit="/100"
          sub={indices.osi <= 25 ? "Low" : indices.osi <= 50 ? "Moderate" : "High"}
          color={indices.osi <= 25 ? "#22c55e" : indices.osi <= 50 ? "#facc15" : "#ef4444"}
          tip="Cell damage potential from pollutant exposure vs WHO limits" />
        <Card label="Inhaled Dose" value={indices.edi} unit="µg/day"
          sub="PM2.5 × breathing rate × 24h" color="#38bdf8"
          tip="Total PM2.5 inhaled over 24 hours at normal breathing rate" />
        <Card label="Clean Air Window" value={indices.cawi} unit="%"
          sub={indices.cawi >= 70 ? "Good time outdoors" : indices.cawi >= 40 ? "Limit outdoor time" : "Stay indoors"}
          color="#00e5a0" tip="How safe it is to be outside right now" />
      </div>

      {/* CRP breakdown + pollutant contributions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
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
          </div>

          <div style={{ height: 1, background: "var(--border)" }} />

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
              Cumulative Exposure
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8 }}>
              Total pollutant dose over the past 24 hours
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
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
              Should You Go Outside?
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
                {indices.cawi >= 70 ? "Great time for outdoor exercise, school, or commuting." :
                 indices.cawi >= 40 ? "OK for short outdoor activities. Limit strenuous exercise." :
                 "Avoid going outside if possible. Keep windows closed."}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Pollutant raw values */}
      <div style={{ background: "var(--bg-card2)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 12 }}>Current Readings</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
          {[
            { label: "PM2.5", value: p.pm2_5, unit: "µg/m³", who: 5, color: "#ef4444" },
            { label: "PM10",  value: p.pm10,  unit: "µg/m³", who: 15, color: "#f97316" },
            { label: "NO₂",   value: p.no2 != null ? +(+p.no2).toFixed(1) : null, unit: "µg/m³", who: 10, color: "#facc15" },
            // { label: "O₃",    value: p.o3 != null ? +(+p.o3).toFixed(1) : null,      unit: "µg/m³", who: 60, color: "#22c55e" },  // disabled (hardware not connected)
            { label: "CO",    value: (p.mq7_co ?? p.co) != null ? +((p.mq7_co ?? p.co) / 1000).toFixed(2) : null, unit: "mg/m³", who: null, color: "#38bdf8" },
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

      {/* References */}
      <div style={{ fontSize: 9, color: "var(--text-dim)", lineHeight: 1.8, padding: "0 4px" }}>
        <strong style={{ color: "var(--text-sub)" }}>Sources:</strong>{" "}
        AQHI (Stieb 2008) · CRP (Liu 2019, Zhang 2021) · CSI (Hoek 2013, Burnett 2018) ·
        RSI (Guarnieri 2014, Atkinson 2014) · OSI (Kelly 2011) · WHO AQG 2021
      </div>
    </div>
  );
}
