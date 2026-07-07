import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { api } from "../api";

const DEFAULTS = { Q: 5, u: 3, H: 20, stabilityClass: "", isDaytime: true, maxDistance: 5000 };

export default function PlumeChart() {
  const [form, setForm] = useState(DEFAULTS);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const payload = {
        Q: Number(form.Q),
        u: Number(form.u),
        H: Number(form.H),
        isDaytime: form.isDaytime,
        maxDistance: Number(form.maxDistance),
      };
      if (form.stabilityClass) payload.stabilityClass = form.stabilityClass;

      const res = await api.estimatePlume(payload);
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const chartData = result?.centerline.map((p) => ({
    distance: p.x,
    // Q entered in g/s -> concentration in g/m3; convert to µg/m3 for readability
    concentration: p.concentration * 1e6,
  }));

  return (
    <div className="card">
      <h2>Gaussian Plume Estimate</h2>
      <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
        Screening-level estimate of downwind concentration from a point source
        (stack, leak, fire) — not a substitute for a full model like AERMOD
        when compliance decisions are on the line. This board has no wind
        sensor, so wind speed/stability come from a weather source or manual
        entry below.
      </p>

      <form className="plume-form" onSubmit={handleSubmit}>
        <div>
          <label>Emission rate Q (g/s)</label>
          <input type="number" step="any" value={form.Q} onChange={(e) => update("Q", e.target.value)} />
        </div>
        <div>
          <label>Wind speed u (m/s)</label>
          <input type="number" step="any" value={form.u} onChange={(e) => update("u", e.target.value)} />
        </div>
        <div>
          <label>Source height H (m)</label>
          <input type="number" step="any" value={form.H} onChange={(e) => update("H", e.target.value)} />
        </div>
        <div>
          <label>Stability class</label>
          <select value={form.stabilityClass} onChange={(e) => update("stabilityClass", e.target.value)}>
            <option value="">Auto (from wind + daytime)</option>
            <option value="A">A — very unstable</option>
            <option value="B">B — unstable</option>
            <option value="C">C — slightly unstable</option>
            <option value="D">D — neutral</option>
            <option value="E">E — slightly stable</option>
            <option value="F">F — stable</option>
          </select>
        </div>
        <div>
          <label>Max distance (m)</label>
          <input type="number" step="any" value={form.maxDistance} onChange={(e) => update("maxDistance", e.target.value)} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 20 }}>
          <input
            type="checkbox"
            id="isDaytime"
            checked={form.isDaytime}
            onChange={(e) => update("isDaytime", e.target.checked)}
          />
          <label htmlFor="isDaytime" style={{ margin: 0 }}>Daytime</label>
        </div>
        <div style={{ alignSelf: "end" }}>
          <button type="submit" disabled={loading}>{loading ? "Calculating…" : "Estimate"}</button>
        </div>
      </form>

      {error && <p className="error">{error}</p>}

      {chartData && (
        <>
          <p className="muted">Stability class used: {result.inputs.stabilityClass}</p>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e3d8" />
              <XAxis dataKey="distance" fontSize={11} label={{ value: "Downwind distance (m)", position: "insideBottom", offset: -5, fontSize: 11 }} />
              <YAxis fontSize={11} label={{ value: "µg/m³", angle: -90, position: "insideLeft", fontSize: 11 }} />
              <Tooltip formatter={(v) => v.toFixed(2)} />
              <Line type="monotone" dataKey="concentration" stroke="#d62828" dot={false} name="Ground-level concentration" />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  );
}
