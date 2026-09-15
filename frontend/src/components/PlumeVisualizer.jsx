import { useRef, useState, useEffect, useMemo } from "react";
import { api } from "../api";
import ConfidenceBadge from "./ConfidenceBadge";

// Jet colormap t∈[0,1] → [r,g,b]
function jet(t) {
  const clamp = (v) => Math.max(0, Math.min(1, v));
  return [
    Math.round(clamp(1.5 - Math.abs(4 * t - 3)) * 255),
    Math.round(clamp(1.5 - Math.abs(4 * t - 2)) * 255),
    Math.round(clamp(1.5 - Math.abs(4 * t - 1)) * 255),
  ];
}

const STABILITY_LABELS = {
  A: "Very Unstable — strong daytime sun, light wind",
  B: "Unstable — moderate sun, light wind",
  C: "Slightly Unstable — overcast day or moderate wind",
  D: "Neutral — cloudy day or strong wind",
  E: "Slightly Stable — clear night, moderate wind",
  F: "Stable — clear night, light wind",
};

function drawGrid(canvas, legendCanvas, data) {
  const { grid, gridMeta, maxC_ugm3, cls, windDir } = data;
  const { xSteps, ySteps, maxDist, halfY } = gridMeta;

  const W = (canvas.width = canvas.offsetWidth || 620);
  const H = (canvas.height = canvas.offsetHeight || 320);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = "#060912";
  ctx.fillRect(0, 0, W, H);

  const cellW = W / (xSteps + 1);
  const cellH = H / (ySteps + 1);
  const imgData = ctx.createImageData(W, H);

  for (const { i, j, t } of grid) {
    const [r, g, b] = jet(Math.sqrt(t));
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
  ctx.fillText(`Stability: ${cls}`, 12, 33);

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

export default function PlumeVisualizer({ latest }) {
  const canvasRef = useRef(null);
  const legendRef = useRef(null);

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [result,  setResult]  = useState(null);

  // Auto-derive parameters from sensor data
  const params = useMemo(() => {
    const pollutants = latest?.pollutants || {};
    const weather = latest?.weather || {};

    const pm25 = pollutants.pm2_5 || 0;
    const windSpeed = weather.windSpeed || 3; // default Bangalore urban
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

    // Wind direction: use 270° (W) as default for Bangalore
    const windDir = 270;

    return { Q: +Q.toFixed(3), u: windSpeed, H, isDaytime, windDir, maxDistance };
  }, [latest?.pollutants, latest?.weather]);

  // Auto-calculate whenever params change
  useEffect(() => {
    if (!latest?.pollutants) return;

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
        if (!cancelled) setResult(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [latest?.pollutants, latest?.weather, params]);

  // Draw whenever result changes
  useEffect(() => {
    if (!result?.grid || !canvasRef.current) return;
    drawGrid(canvasRef.current, legendRef.current, result);
  }, [result]);

  const pm25 = latest?.pollutants?.pm2_5;
  const wind = latest?.weather?.windSpeed;

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
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--accent)", marginBottom: 8 }}>
            Auto-Calculated from Live Data
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <ParamItem label="Wind Speed" value={`${params.u} m/s`} sub={
              /* PROMPT_FLOW_UI.md Phase U2: structural measured/estimated
                 treatment, replacing the plain "From sensor"/"Default (no
                 sensor)" caption Phase U0 flagged as the exact anti-pattern
                 root CLAUDE.md warns against. No cadenceMinutes -- telemetry
                 arrival isn't on a fixed schedule the way a worker poll is,
                 so ConfidenceBadge's "omit next-expected gracefully" path
                 is exercised here for real. */
              <ConfidenceBadge state={wind ? "measured" : "estimated"} timestamp={latest?.timestamp} />
            } />
            <ParamItem label="Source Height" value={`${params.H} m`} sub="Urban average" />
            <ParamItem label="Emission Rate" value={`${params.Q} g/s`} sub={`From PM2.5: ${pm25 ?? "–"} µg/m³`} />
            <ParamItem label="Time of Day" value={params.isDaytime ? "Daytime" : "Night"} sub="Affects air stability" />
          </div>
        </div>

        {/* What this means */}
        {result && (
          <div style={{
            padding: "10px 14px", borderRadius: 10,
            background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)",
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 6 }}>
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

        {/* Stability class explanation */}
        {result && (
          <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.6 }}>
            <strong style={{ color: "var(--text-sub)" }}>Air Stability:</strong>{" "}
            {STABILITY_LABELS[result.cls] || result.cls} —{" "}
            {["A", "B"].includes(result.cls) && "pollutants disperse quickly in turbulent air."}
            {["C", "D"].includes(result.cls) && "moderate dispersion — pollutants spread at a medium rate."}
            {["E", "F"].includes(result.cls) && "pollutants stay concentrated near ground level — poor dispersion."}
          </div>
        )}
      </div>

      {/* ── Right: Canvas visualization ── */}
      <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-sub)" }}>
            Pollution Dispersion Map
          </span>
          {result && (
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              {result.grid?.length ?? 0} cells computed
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 280, position: "relative" }}>
          <canvas ref={canvasRef}
            style={{ flex: 1, minHeight: 280, background: "#060912", borderRadius: 8 }} />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 9, color: "var(--text-dim)" }}>{result ? "µg/m³" : ""}</span>
            <canvas ref={legendRef} style={{ borderRadius: 4 }} />
          </div>

          {/* Overlay: loading or empty state */}
          {(!result || loading) && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center",
              justifyContent: "center", textAlign: "center",
              background: "rgba(6,9,15,0.88)", borderRadius: 8,
            }}>
              {loading ? (
                <div>
                  <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
                    ⟳ Computing dispersion…
                  </span>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
                    Using Pasquill-Gifford model with Briggs coefficients
                  </div>
                </div>
              ) : error ? (
                <span style={{ color: "#ef4444", fontSize: 12 }}>{error}</span>
              ) : (
                <span style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.7 }}>
                  {latest?.pollutants
                    ? "Computing from live data…"
                    : "Select a station with sensor data to see the dispersion map"}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
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
