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

// Unit conversion helpers (data is stored in ppm for gases)
export const conv = {
  no2_ugm3: (ppm) => ppm == null ? null : +(ppm * (46.0055 * 1000) / 24.45).toFixed(1),
  o3_ugm3:  (ppm) => ppm == null ? null : +(ppm * (48.0 * 1000) / 24.45).toFixed(1),
  co_mgm3:  (ppm) => ppm == null ? null : +(ppm * 28.01 / 24.45).toFixed(2),
};
