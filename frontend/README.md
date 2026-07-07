# AQMS Frontend

React + Vite dashboard: station selector, live AQI (CPCB subindex
breakdown), pollutant/AQI trend charts, and a Gaussian plume dispersion
estimator.

## Setup
```bash
cp .env.example .env     # set VITE_API_BASE_URL to your backend URL
npm install
npm run dev
```
Opens on `http://localhost:5173`, polling the backend every 60s (matches
the firmware's default telemetry interval).

## What's here
- `src/App.jsx` — fetches the station list, polls latest/history/AQI-history for the selected station
- `src/components/AQIPanel.jsx` — current AQI, category color, per-pollutant CPCB subindex breakdown
- `src/components/PollutantCharts.jsx` — PM, gas, and AQI trend line charts (recharts)
- `src/components/PlumeChart.jsx` — form for Q/wind speed/source height/stability class → downwind concentration curve

## Build & deploy
```bash
npm run build     # outputs to dist/
```
`dist/` is static — deploy it to Vercel, Netlify, GitHub Pages, or as a
Render **Static Site** (separate from the backend's Web Service). Whichever
host you pick, set `VITE_API_BASE_URL` to your deployed backend's URL
(e.g. `https://aqms-backend.onrender.com`) as a build-time env var — Vite
bakes `VITE_*` vars in at build time, so this has to be set before `build`,
not after.

## Notes on the plume estimator
The AQMS board has no wind sensor, so wind speed/stability are entered
manually or would come from an external weather API in a future version —
they're not derived from the station's own pollutant readings. The model
estimates a *source's* downwind footprint; the AQMS reading at a station is
what you'd compare a prediction against, not an input to it.
