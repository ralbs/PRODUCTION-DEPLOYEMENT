import { useRef, useState, useEffect } from "react";
import { api } from "../api";

// Jet colormap t∈[0,1] → [r,g,b]
function jet(t) {
  const clamp = (v) => Math.max(0, Math.min(1, v));
  return [
    Math.round(clamp(1.5 - Math.abs(4 * t - 3)) * 255),
    Math.round(clamp(1.5 - Math.abs(4 * t - 2)) * 255),
    Math.round(clamp(1.5 - Math.abs(4 * t - 1)) * 255),
  ];
}

const STABILITY_CLASSES = ["A", "B", "C", "D", "E", "F"];
const STABILITY_LABELS = {
  A: "A — Very Unstable",
  B: "B — Unstable",
  C: "C — Slightly Unstable",
  D: "D — Neutral",
  E: "E — Slightly Stable",
  F: "F — Stable",
};

function drawGrid(canvas, legendCanvas, data) {
  const { grid, gridMeta, maxC_ugm3, cls, windDir } = data;
  const { xSteps, ySteps, maxDist, halfY } = gridMeta;

  const W = (canvas.width  = canvas.offsetWidth  || 620);
  const H = (canvas.height = canvas.offsetHeight || 320);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  // Dark background
  ctx.fillStyle = "#060912";
  ctx.fillRect(0, 0, W, H);

  const cellW = W / (xSteps + 1);
  const cellH = H / (ySteps + 1);
  const imgData = ctx.createImageData(W, H);

  // Paint each backend-computed cell
  for (const { i, j, t } of grid) {
    const [r, g, b] = jet(Math.sqrt(t)); // gamma-correct for perceptual uniformity
    const alpha = Math.round(t * 210 + 45);
    const px = Math.round(i * cellW);
    const py = Math.round(j * cellH);
    const pw = Math.ceil(cellW) + 1;
    const ph = Math.ceil(cellH) + 1;

    for (let dy = 0; dy < ph; dy++) {
      for (let dx = 0; dx < pw; dx++) {
        const idx = ((py + dy) * W + (px + dx)) * 4;
        if (idx < 0 || idx + 3 >= imgData.data.length) continue;
        imgData.data[idx]     = r;
        imgData.data[idx + 1] = g;
        imgData.data[idx + 2] = b;
        imgData.data[idx + 3] = alpha;
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // Source marker
  ctx.beginPath();
  ctx.arc(3, H / 2, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#4f8ef7";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Labels
  ctx.font = "10px 'JetBrains Mono', monospace";
  ctx.fillStyle = "rgba(212,224,248,0.55)";
  ctx.fillText("0", 12, H - 5);
  ctx.fillText(`${(maxDist / 1000).toFixed(1)} km →`, W - 70, H - 5);
  ctx.fillText(`Downwind (${windDir}°)`, W / 2 - 52, H - 5);
  ctx.save();
  ctx.translate(12, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`Crosswind ±${(halfY / 1000).toFixed(1)} km`, -55, 0);
  ctx.restore();

  ctx.fillStyle = "rgba(212,224,248,0.9)";
  ctx.font = "11px 'JetBrains Mono', monospace";
  ctx.fillText(`Peak: ${maxC_ugm3.toFixed(1)} µg/m³`, 12, 18);
  ctx.fillText(`Class: ${cls}`, 12, 33);

  // Legend bar
  if (legendCanvas) {
    legendCanvas.width  = 18;
    legendCanvas.height = H;
    const lctx   = legendCanvas.getContext("2d");
    const lImg   = lctx.createImageData(18, H);
    for (let py = 0; py < H; py++) {
      const t = 1 - py / H;
      const [r, g, b] = jet(t);
      for (let px = 0; px < 18; px++) {
        const idx = (py * 18 + px) * 4;
        lImg.data[idx] = r; lImg.data[idx + 1] = g; lImg.data[idx + 2] = b; lImg.data[idx + 3] = 220;
      }
    }
    lctx.putImageData(lImg, 0, 0);
    lctx.font = "9px monospace";
    lctx.fillStyle = "rgba(212,224,248,0.65)";
    lctx.fillText(`${maxC_ugm3.toFixed(0)}`, 0, 10);
    lctx.fillText("0", 3, H - 3);
  }
}

export default function PlumeVisualizer() {
  const canvasRef = useRef(null);
  const legendRef = useRef(null);

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [result,  setResult]  = useState(null);

  const [form, setForm] = useState({
    Q: 5, u: 3, H: 20,
    stabilityClass: "",
    isDaytime: true,
    windDir: 270,
    maxDistance: 5000,
  });

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  // Draw whenever a new result lands (after React has committed the canvas to DOM)
  useEffect(() => {
    if (!result?.grid || !canvasRef.current) return;
    drawGrid(canvasRef.current, legendRef.current, result);
  }, [result]);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const data = await api.estimatePlume({
        Q:              Number(form.Q),
        u:              Number(form.u),
        H:              Number(form.H),
        stabilityClass: form.stabilityClass || undefined,
        isDaytime:      form.isDaytime,
        windDir:        Number(form.windDir),
        maxDistance:    Number(form.maxDistance),
        grid:           true,
        xSteps:         80,
        ySteps:         60,
      });

      setResult(data);  // triggers useEffect → drawGrid after DOM commit
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="plume-band">
      {/* ── Form ── */}
      <div className="plume-form-section">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Gaussian Plume Dispersion Model</span>
        </div>
        <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4, lineHeight: 1.6 }}>
          Screening-level Pasquill-Gifford dispersion (Briggs rural σ coefficients).
          Concentration in µg/m³ at ground level (z=0).
        </p>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="field-row">
            <div className="field-group">
              <label className="field-label">Emission Rate Q (g/s)</label>
              <input className="field-input" type="number" step="any" min="0.01" value={form.Q}
                onChange={(e) => set("Q", e.target.value)} required />
            </div>
            <div className="field-group">
              <label className="field-label">Wind Speed u (m/s)</label>
              <input className="field-input" type="number" step="any" min="0.1" value={form.u}
                onChange={(e) => set("u", e.target.value)} required />
            </div>
          </div>

          <div className="field-row">
            <div className="field-group">
              <label className="field-label">Source Height H (m)</label>
              <input className="field-input" type="number" step="any" min="0" value={form.H}
                onChange={(e) => set("H", e.target.value)} required />
            </div>
            <div className="field-group">
              <label className="field-label">Wind Direction (°)</label>
              <input className="field-input" type="number" min="0" max="359" value={form.windDir}
                onChange={(e) => set("windDir", e.target.value)} />
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Stability Class</label>
            <select className="field-select" value={form.stabilityClass}
              onChange={(e) => set("stabilityClass", e.target.value)}>
              <option value="">Auto (from wind + time of day)</option>
              {STABILITY_CLASSES.map((c) => (
                <option key={c} value={c}>{STABILITY_LABELS[c]}</option>
              ))}
            </select>
          </div>

          <div className="field-row">
            <div className="field-group">
              <label className="field-label">Max Distance (m)</label>
              <input className="field-input" type="number" min="500" max="50000" step="500"
                value={form.maxDistance} onChange={(e) => set("maxDistance", e.target.value)} />
            </div>
            <div className="field-group" style={{ justifyContent: "flex-end" }}>
              <label className="field-label">Time of Day</label>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                {["Daytime", "Night"].map((v) => (
                  <label key={v} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12, cursor: "pointer", color: "var(--text-sub)" }}>
                    <input type="radio" name="daytime"
                      checked={form.isDaytime === (v === "Daytime")}
                      onChange={() => set("isDaytime", v === "Daytime")} />
                    {v}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <button type="submit" className="submit-btn" disabled={loading}>
            {loading ? "Computing…" : "Compute Dispersion"}
          </button>
        </form>

        {error && (
          <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 6,
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
            fontSize: 11, color: "#ef4444" }}>
            {error}
          </div>
        )}

        {result && !error && (
          <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6,
            background: "rgba(79,142,247,0.06)", border: "1px solid rgba(79,142,247,0.12)",
            fontSize: 11, color: "var(--text-sub)" }}>
            Peak ground-level concentration:{" "}
            <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
              {result.maxC_ugm3.toFixed(2)} µg/m³
            </strong>
            {" "}using stability class{" "}
            <strong style={{ color: "var(--accent)" }}>{result.cls}</strong>
            {" "}· peak at{" "}
            <strong style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
              {result.peakX_m} m
            </strong>{" "}downwind
          </div>
        )}
      </div>

      {/* ── Canvas ── */}
      <div className="plume-canvas-section">
        <div className="chart-header" style={{ marginBottom: 8 }}>
          <span className="chart-title">Ground-Level Concentration Footprint</span>
          {result && (
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              Computed by backend · {result.grid?.length ?? 0} cells
            </span>
          )}
        </div>

        {/* Canvas is always mounted so canvasRef is always valid */}
        <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 280, position: "relative" }}>
          <canvas ref={canvasRef} className="plume-canvas"
            style={{ flex: 1, minHeight: 280, background: "#060912", borderRadius: 8 }} />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 9, color: "var(--text-dim)" }}>{result ? "µg/m³" : ""}</span>
            <canvas ref={legendRef} style={{ borderRadius: 4 }} />
          </div>

          {/* Overlay: shown only when no result yet or loading */}
          {(!result || loading) && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center",
              justifyContent: "center", textAlign: "center",
              background: "rgba(6,9,15,0.88)", borderRadius: 8,
            }}>
              {loading ? (
                <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  ⟳&nbsp; Requesting grid from backend…
                </span>
              ) : (
                <span style={{ color: "var(--text-dim)", fontSize: 13, lineHeight: 1.7 }}>
                  Configure parameters and click<br />
                  <strong style={{ color: "var(--accent)" }}>Compute Dispersion</strong><br />
                  to see the concentration map
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
