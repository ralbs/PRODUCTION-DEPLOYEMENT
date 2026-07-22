// ─────────────────────────────────────────────────────────────────────────────
// healthIndices.js
// Peer-reviewed formulas, published coefficients, and engineering indices
// for the AQMS Health Intelligence layer.
//
// All pollutant concentrations must be in µg/m³ (PM2.5, PM10, NO2, O3, SO2)
// or mg/m³ (CO) as indicated per formula.
//
// References:
//   - US EPA AQI Technical Assistance Document, 2018
//   - CPCB National Air Quality Index Methodology
//   - Stieb DM et al., Environ Health Perspect, 2008 (AQHI)
//   - Liu C et al., IJERPH, 2019 (CRP meta-analysis, PMID: 31103472)
//   - Zhang Z et al., Environ Pollution, 2021 (CRP meta-analysis)
//   - Brook RD et al., Circulation, 2010
//   - Hoek G et al., Environ Health, 2013
//   - Burnett R et al., PNAS, 2018
//   - Guarnieri M & Balmes JR, The Lancet, 2014
//   - Atkinson RW et al., Thorax, 2014
//   - Kelly FJ & Fussell JC, Antioxidants & Redox Signaling, 2011
//   - WHO Global Air Quality Guidelines, 2021
//   - US EPA Exposure Factors Handbook, 2011
//   - Pearson TA et al., Circulation, 2003 (CRP reference)
//   - CDC/AHA Scientific Statement on hs-CRP
// ─────────────────────────────────────────────────────────────────────────────

// ── WHO 2021 Annual Guideline Values (µg/m³) ──
export const WHO_GUIDELINES = {
  pm2_5: 5,
  pm10:  15,
  no2:   10,
  o3:    60,
  so2:   40,
};

// ── Clinical CRP Reference (mg/L) ──
// Pearson TA et al., Circulation, 2003; CDC/AHA hs-CRP Statement
export const CRP_REFERENCE = [
  { max: 1,  label: "Low inflammation",        color: "#22c55e" },
  { max: 3,  label: "Mild / average",           color: "#a3e635" },
  { max: 10, label: "Elevated inflammation",    color: "#f97316" },
  { max: Infinity, label: "Acute inflammation", color: "#ef4444" },
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. AQHI — Air Quality Health Index
//    Published Equation (Health Canada, Stieb DM et al. 2008)
//    AQHI = (1000/10.4) × [exp(0.000537×O₃) + exp(0.000871×NO₂)
//           + exp(0.000487×PM2.5) − 3]
// ─────────────────────────────────────────────────────────────────────────────
export function calcAQHI({ pm2_5 = 0, no2 = 0, o3 = 0 }) {
  const a = Math.exp(0.000537 * (o3 || 0));
  const b = Math.exp(0.000871 * (no2 || 0));
  const c = Math.exp(0.000487 * (pm2_5 || 0));
  const raw = (1000 / 10.4) * (a + b + c - 3);
  return Math.max(0, +raw.toFixed(1));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Predicted CRP — Log-Linear Epidemiological Model
//    ln(CRP̂) = β₀ + β₁×PM2.5 + β₂×PM10 + β₃×NO₂ + β₄×O₃ + β₅×SO₂
//    Engineering Initialization: β₀ = ln(1) = 0 → CRP₀ = 1 mg/L
//    Coefficients from Liu C et al. 2019, Zhang Z et al. 2021 meta-analyses
// ─────────────────────────────────────────────────────────────────────────────
const CRP_BETAS = {
  pm2_5: 0.000827,
  pm10:  0.000389,
  no2:   0.001587,
  o3:    0.001044,
  so2:   0.009930,
};

export function calcCRP(pollutants) {
  const lnCRP =
    CRP_BETAS.pm2_5 * (pollutants.pm2_5 || 0) +
    CRP_BETAS.pm10  * (pollutants.pm10  || 0) +
    CRP_BETAS.no2   * (pollutants.no2   || 0) +
    CRP_BETAS.o3    * (pollutants.o3    || 0) +
    CRP_BETAS.so2   * (pollutants.so2   || 0);
  const crp = Math.exp(lnCRP);
  const interpretation = CRP_REFERENCE.find((r) => crp <= r.max);
  return {
    lnCRP: +lnCRP.toFixed(4),
    crp: +crp.toFixed(3),
    interpretation: interpretation?.label || "Unknown",
    color: interpretation?.color || "#7b93b8",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. IRI — Inflammatory Risk Index
//    IRI = 100 × (CRP̂ − CRP_min) / (CRP₉₅ − CRP_min)
//    Recommended: CRP_min = 1, CRP₉₅ = 5
// ─────────────────────────────────────────────────────────────────────────────
export function calcIRI(crp, crpMin = 1, crp95 = 5) {
  const iri = 100 * (crp - crpMin) / (crp95 - crpMin);
  return Math.max(0, Math.min(100, +iri.toFixed(1)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CSI — Cardiovascular Stress Index
//    Step 1: βᵢᶜᵛ = ln(RRᵢᶜᵛ) / ΔCᵢ  (derived from published Relative Risks)
//    Step 2: CSI_raw = Σ(βᵢᶜᵛ × Cᵢ)
//    Step 3: CSI = 100 × (CSI_raw − CSI_min) / (CSI₉₅ − CSI_min)
//
//    Reference: Hoek G et al. 2013, Burnett R et al. 2018, Brook RD et al. 2010
//    Using published pooled RR for 10 µg/m³ increment:
//      PM2.5: RR=1.06 → β=ln(1.06)/10=0.00583
//      NO₂:   RR=1.03 → β=ln(1.03)/10=0.00296
//      CO:    RR=1.03 per 1 mg/m³ → β=ln(1.03)=0.02956
// ─────────────────────────────────────────────────────────────────────────────
export function calcCSI(pollutants) {
  const raw =
    0.00583 * (pollutants.pm2_5 || 0) +
    0.00296 * (pollutants.no2   || 0) +
    0.02956 * (pollutants.co_mg || 0);
  const csi = 100 * (raw - 0) / (0.5 - 0);
  return Math.max(0, Math.min(100, +csi.toFixed(1)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. RSI — Respiratory Stress Index
//    RSI_raw = Σ(βᵢʳᵉˢᵖ × Cᵢ)
//    RSI = 100 × RSI_raw / RSI₉₅
//
//    Reference: Guarnieri & Balmes 2014, Atkinson RW et al. 2014
//    Using published pooled RR for 10 µg/m³ increment:
//      PM2.5: RR=1.02 → β=0.00198
//      PM10:  RR=1.01 → β=0.000995
//      SO₂:   RR=1.02 per 10 → β=0.00198
//      O₃:    RR=1.02 per 10 → β=0.00198
// ─────────────────────────────────────────────────────────────────────────────
export function calcRSI(pollutants) {
  const raw =
    0.001980 * (pollutants.pm2_5 || 0) +
    0.000995 * (pollutants.pm10  || 0) +
    0.001980 * (pollutants.so2   || 0) +
    0.001980 * (pollutants.o3    || 0);
  const rsi = 100 * raw / 0.25;
  return Math.max(0, Math.min(100, +rsi.toFixed(1)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. OSI — Oxidative Stress Index
//    OSI = Σ[wᵢ × (Cᵢ / WHOᵢ)]
//    Equal weight wᵢ = 1/n for available pollutants
//    Reference: Kelly FJ & Fussell JC 2011, WHO 2021
// ─────────────────────────────────────────────────────────────────────────────
export function calcOSI(pollutants) {
  const keys = ["pm2_5", "no2", "o3"];
  const available = keys.filter((k) => pollutants[k] != null && pollutants[k] > 0);
  if (!available.length) return 0;
  const w = 1 / available.length;
  let sum = 0;
  for (const k of available) {
    sum += w * ((pollutants[k] || 0) / (WHO_GUIDELINES[k] || 1));
  }
  return +Math.min(sum * 25, 100).toFixed(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. EDI — Exposure Dose Index
//    Dose = C × IR × t
//    Defaults: IR = 1.2 m³/h (EPA default adult), t = 24 h
//    Reference: US EPA Exposure Factors Handbook, 2011
// ─────────────────────────────────────────────────────────────────────────────
export function calcEDI(pm2_5, ir = 1.2, hours = 24) {
  return +((pm2_5 || 0) * ir * hours).toFixed(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. CED — Cumulative Exposure (daily proxy)
//    CED = Σ(C × Δt)  — simplified as C_avg × 24 for daily window
//    Reference: NRC, Human Exposure Assessment, 1991
// ─────────────────────────────────────────────────────────────────────────────
export function calcCED(pm2_5, hours = 24) {
  return +((pm2_5 || 0) * hours).toFixed(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. SCI — Source Contribution Index (placeholder — needs source apportionment)
//    SCI_i = (Source_i / Total) × 100
//    Reference: Seinfeld & Pandis, Atmospheric Chemistry and Physics, 3rd ed.
//    NOTE: Actual SCI requires CMAQ/CAMx source apportionment data.
//    This function returns a placeholder when no source data is available.
// ─────────────────────────────────────────────────────────────────────────────
export function calcSCI() {
  return null; // Requires source apportionment model output
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. FHI — Forecast Health Index (placeholder — needs forecast model)
//     FHI = IRI(t + 24 h)
//     Reference: Hochreiter & Schmidhuber 1997 (LSTM), AQMS PINN/LSTM
// ─────────────────────────────────────────────────────────────────────────────
export function calcFHI(forecastIRI) {
  return forecastIRI != null ? +forecastIRI.toFixed(1) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. PPI — Pollution Persistence Index
//     PPI = Forecast_AQI / Current_AQI
// ─────────────────────────────────────────────────────────────────────────────
export function calcPPI(forecastAQI, currentAQI) {
  if (!forecastAQI || !currentAQI || currentAQI === 0) return null;
  return +(forecastAQI / currentAQI).toFixed(2);
}

export function ppiInterpretation(ppi) {
  if (ppi == null) return { label: "Unknown", color: "#7b93b8" };
  if (ppi < 0.8) return { label: "Improving", color: "#22c55e" };
  if (ppi <= 1.2) return { label: "Persistent", color: "#facc15" };
  return { label: "Worsening", color: "#ef4444" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. VI — Ventilation Index
//     VI = BLH × WS
//     Reference: WMO Guide, Arya SP 1999
//     Clamped to 0–100 scale using typical urban BLH range (0–2000m) and
//     wind speed (0–10 m/s), so VI_max ≈ 20000.
// ─────────────────────────────────────────────────────────────────────────────
export function calcVI(blh, ws) {
  const raw = (blh || 0) * (ws || 0);
  return Math.max(0, Math.min(100, +(raw / 200).toFixed(1)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. CAWI — Clean Air Window Index
//     CAWI_h = 100 − IRI_h
// ─────────────────────────────────────────────────────────────────────────────
export function calcCAWI(iri) {
  return Math.max(0, Math.min(100, +(100 - (iri || 0)).toFixed(1)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. HBI — Health Benefit Index
//     HBI = IRI_before − IRI_after
// ─────────────────────────────────────────────────────────────────────────────
export function calcHBI(iriBefore, iriAfter) {
  if (iriBefore == null || iriAfter == null) return null;
  return +(iriBefore - iriAfter).toFixed(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Master calculator — computes all available indices from raw pollutants
// ─────────────────────────────────────────────────────────────────────────────
export function computeAllIndices(pollutants, weather = {}, forecast = null) {
  const p = {
    pm2_5: pollutants?.pm2_5,
    pm10:  pollutants?.pm10,
    no2:   pollutants?.no2,
    o3:    pollutants?.o3,
    so2:   pollutants?.so2,
    co:    pollutants?.co,
  };

  // Convert CO from ppm to mg/m³ for CSI: co_mg = co_ppm × 28.01 / 24.45
  const co_mg = p.co != null ? p.co * 28.01 / 24.45 : 0;

  const crpResult = calcCRP(p);
  const iri       = calcIRI(crpResult.crp);
  const aqhi      = calcAQHI(p);
  const csi       = calcCSI({ ...p, co_mg });
  const rsi       = calcRSI(p);
  const osi       = calcOSI(p);
  const edi       = calcEDI(p.pm2_5);
  const ced       = calcCED(p.pm2_5);
  const vi        = calcVI(weather.blh, weather.windSpeed);
  const cawi      = calcCAWI(iri);

  return {
    aqhi,
    crp:     crpResult,
    iri,
    csi,
    rsi,
    osi,
    edi,
    ced,
    vi,
    cawi,
    ppi:     calcPPI(forecast?.aqi, null),
    fhi:     calcFHI(forecast?.iri),
    hbi:     null,
    sci:     calcSCI(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function riskLevel(iri) {
  if (iri <= 20) return { label: "Minimal",  color: "#22c55e", emoji: "" };
  if (iri <= 40) return { label: "Low",      color: "#a3e635", emoji: "" };
  if (iri <= 60) return { label: "Moderate",  color: "#facc15", emoji: "" };
  if (iri <= 80) return { label: "High",     color: "#f97316", emoji: "" };
  return               { label: "Very High", color: "#ef4444", emoji: "" };
}

export function cardiovascularRisk(csi) {
  if (csi <= 20) return { label: "Low",      color: "#22c55e" };
  if (csi <= 40) return { label: "Moderate",  color: "#facc15" };
  if (csi <= 60) return { label: "Elevated",  color: "#f97316" };
  return               { label: "High",     color: "#ef4444" };
}

export function respiratoryRisk(rsi) {
  if (rsi <= 20) return { label: "Low",      color: "#22c55e" };
  if (rsi <= 40) return { label: "Moderate",  color: "#facc15" };
  if (rsi <= 60) return { label: "Elevated",  color: "#f97316" };
  return               { label: "High",     color: "#ef4444" };
}

export function cpmContribution(pollutants) {
  const p = {
    pm2_5: pollutants?.pm2_5 || 0,
    pm10:  pollutants?.pm10  || 0,
    no2:   (pollutants?.no2  || 0) * 0.001587,
    o3:    (pollutants?.o3   || 0) * 0.001044,
    so2:   (pollutants?.so2  || 0) * 0.00993,
  };
  // Normalize to CRP contribution using beta × concentration
  const pm25Contrib = CRP_BETAS.pm2_5 * (pollutants?.pm2_5 || 0);
  const pm10Contrib = CRP_BETAS.pm10  * (pollutants?.pm10  || 0);
  const no2Contrib  = CRP_BETAS.no2   * (pollutants?.no2   || 0);
  const o3Contrib   = CRP_BETAS.o3    * (pollutants?.o3    || 0);
  const so2Contrib  = CRP_BETAS.so2   * (pollutants?.so2   || 0);
  const total = pm25Contrib + pm10Contrib + no2Contrib + o3Contrib + so2Contrib || 1;

  return [
    { name: "PM2.5", value: +(pm25Contrib / total * 100).toFixed(1), color: "#ef4444" },
    { name: "PM10",  value: +(pm10Contrib / total * 100).toFixed(1), color: "#f97316" },
    { name: "NO₂",   value: +(no2Contrib  / total * 100).toFixed(1), color: "#facc15" },
    { name: "O₃",    value: +(o3Contrib   / total * 100).toFixed(1), color: "#22c55e" },
    { name: "SO₂",   value: +(so2Contrib  / total * 100).toFixed(1), color: "#38bdf8" },
  ];
}
