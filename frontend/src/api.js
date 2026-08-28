const BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} — ${path}`);
  return res.json();
}

export const api = {
  getStations:   ()                  => get("/api/stations"),
  getLatest:     (id)                => get(`/api/telemetry/latest?station_id=${encodeURIComponent(id)}`),
  getHistory:    (id)                => get(`/api/telemetry/history?station_id=${encodeURIComponent(id)}&limit=2000`),
  getAqiHistory: (id)                => get(`/api/aqi/history?station_id=${encodeURIComponent(id)}&limit=2000`),
  getForecast:   (id)                => get(`/api/forecast?station_id=${encodeURIComponent(id)}`),
  estimatePlume: (body)              => post("/api/plume/estimate", { ...body, grid: true }),
};

// Unit helpers — the backend normalizes every read path to µg/m³ (the board
// ships ppm, converted on read in lib/prepare.js), so gases arrive in µg/m³
// (see backend/lib/aqi.js units contract). Only CO needs scaling: µg/m³ → mg/m³.
export const conv = {
  no2_ugm3: (v) => v == null ? null : +(+v).toFixed(1),
  o3_ugm3:  (v) => v == null ? null : +(+v).toFixed(1),
  co_mgm3:  (v) => v == null ? null : +(v / 1000).toFixed(2),
};
