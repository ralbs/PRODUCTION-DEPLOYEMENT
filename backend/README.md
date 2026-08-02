# AQMS Backend

Ingest API + database for the AQMS air quality network. Receives telemetry
from ESP32 stations over HTTPS, stores it in MongoDB, and exposes REST +
GraphQL for a dashboard.

## Data flow
```
ESP32 station → HTTPS POST /api/telemetry → auth check → MongoDB (time-series)
                                                        → MQTT republish (optional, live dashboard)
Dashboard      → GET /api/telemetry/latest | /history  → MongoDB
               → POST /graphql                          → MongoDB
```

The device never touches the database directly — it only ever calls the
ingest endpoint. That's what lets you rotate DB credentials, change storage
engines, or add validation without touching firmware.

## Setup
```bash
cp .env.example .env      # edit MONGO_URI, DEVICE_KEYS, etc.
npm install
node scripts/setup-db.js  # ensure time-series collection + (device_id, timestamp) index
docker compose up -d      # local MongoDB (as a single-node replica set) + Mosquitto
docker exec -it aqms-mongo mongosh --eval "rs.initiate()"   # first run only
npm run dev
```

`setup-db.js` is idempotent — safe to run again after a deploy.

Server starts on `http://localhost:4000` by default. `GET /health` for a
liveness check.

## Device authentication
Each station sends two headers with every request:
```
X-Device-Id: ESP32-001
X-Device-Key: <the device's key>
```
Valid pairs live in `DEVICE_KEYS` in `.env` as `device_id:key,device_id:key`.
The paired ESP32 firmware (`config.h` → `DEVICE_API_KEY`) must match exactly.

This is fine for a handful of stations. Past that, switch to the `Device`
model (`models/Device.js`) — store a bcrypt hash per device instead of
plaintext keys in an env var, and you can revoke one station without
redeploying the whole backend.

## Units contract
All gas pollutants in the telemetry payload are in **µg/m³** (NO2, O3, NH3,
H2S, H2, MQ-135, MQ-7 CO). The backend **never converts units** — the
firmware must convert before sending. `-1` or `null` means that sensor is
faulted or not connected.

On ingest and on read the backend applies `sanitizePollutants()` (see
`lib/aqi.js`): values that are `<= 0`, `NaN`, `null`, or above a physical
`SANITY_MAX` ceiling are nulled out, so a misconfigured sensor (e.g. stale
O3 baseline) can no longer blow up the AQI. Sub-indices are **capped at 500**
(no unbounded extrapolation) — AQI is always in the 0–500 range.

### TRUST_GAS_SENSORS
The MQ/MiCS gas channels currently ship raw placeholder-model output (uncalibrated,
ppm-scale garbage). Set `TRUST_GAS_SENSORS=false` (the default) to null all gas
channels so AQI is computed from PM only — truthful until the firmware is
recalibrated (real datasheet curves, clean `/baseline.dat`, and µg/m³ output).
Set it to `true` only after that firmware work, to include gases in the AQI.

## Health fault alerts
If any `health.*` string field in the payload is `"FAULT"`, `POST
/api/telemetry` returns `201` with `alert: { hasFault: true, faulty: [...] }`
and logs a warning. The dashboard can use `alert.hasFault` to surface
"maintenance required" instead of interpreting `FAULT` as a reading.

## REST endpoints
- `POST /api/telemetry` — device ingest (auth required). Body is exactly the
  JSON schema the firmware sends. Returns `201` + the stored reading (with
  `sanitized` pollutants and computed `aqi`), plus `alert` when a health
  fault is detected. Invalid/missing device headers → `401`.
- `GET /api/telemetry/latest?device_id=ESP32-001` — most recent reading for a
  device (`station_id` also accepted for backwards compatibility).
- `GET /api/telemetry/history?device_id=ESP32-001&from=...&to=...&limit=500` — range query.

### Ingest example
```bash
curl -X POST https://aqms-backend.onrender.com/api/telemetry \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: ESP32-001" \
  -H "X-Device-Key: <key>" \
  -d '{
    "timestamp": "2026-08-02T10:30:00Z",
    "location": { "lat": 13.0359, "lon": 77.5970 },
    "pollutants": {
      "pm1": 6, "pm2_5": 12, "pm10": 13,
      "no2": -1.0, "nh3": 741.6, "o3": 0.0, "h2s": 0.0,
      "h2": 0.0, "mq135": 0.0, "mq7_co": 110.5, "co": -1.0
    },
    "weather": { "temperature": 28.4, "humidity": 61.0, "pressure": 1012.0 },
    "battery": { "percent": 87, "voltage": 3.9 },
    "flags": { "delayed": false, "offline_buffered": false },
    "health": { "pms5003": "OK", "mq_ads1": "OK", "mq_ads2": "OK", "bme680": "OK" }
  }'
```

## GraphQL
`POST /graphql` (playground at the same path in dev). Example query:
```graphql
query {
  latestReading(stationId: "NEL-001") {
    timestamp
    pollutants { pm2_5 co2 no2 o3 }
    battery { percent }
    flags { delayed offline_buffered }
  }
}
```

## Why MongoDB time-series
Telemetry is append-only, queried by time range per station, and rarely
updated after the fact — exactly what MongoDB's time-series collections
(`models/Telemetry.js`) are built for. Mongo automatically buckets documents
by the `meta.device_id`/`station_id` fields, so per-station range queries
stay fast without hand-built compound indexes.

## MQTT (optional)
If `MQTT_BROKER_URL` is set, every successfully stored reading is also
republished to `aqms/<station_id>/telemetry`, so a live dashboard can
subscribe instead of polling `/history`. Leave it unset and everything
else still works — MQTT is purely additive.

## Deploying to Render

Render doesn't offer managed MongoDB (only Postgres and a Redis-compatible
store), so for a Render deploy the database moves to **MongoDB Atlas**
(free M0 tier is enough to start) — everything else about the backend is
unchanged, since it only ever talks to Mongo through `MONGO_URI`.

1. **Create a MongoDB Atlas cluster** (free M0 tier works). Under
   Network Access, allow `0.0.0.0/0` (Render's IPs aren't static) or use
   Atlas's Render-specific peering if you're on a paid Atlas tier.
   Time-series collections need MongoDB **5.0+** — Atlas defaults to a
   current version, so this isn't usually something you need to set.
2. Grab the connection string and put it in `MONGO_URI` (include the
   database name, e.g. `.../aqms?retryWrites=true&w=majority`).
3. In the Render dashboard: **New → Blueprint**, point it at this repo.
   Render will read `render.yaml` at the repo root and create the
   `aqms-backend` web service with `rootDir: backend`.
4. Fill in the env vars Render prompts for (`MONGO_URI`, `DEVICE_KEYS`,
   `ALLOWED_ORIGINS`) in the dashboard — `render.yaml` deliberately leaves
   these as `sync: false` so secrets never live in the repo.
5. Deploy. Your ingest URL becomes `https://aqms-backend.onrender.com/api/telemetry`
   — update `SERVER_URL` in `firmware/config.h` to match, and reflash.

No Blueprint? You can also just click **New → Web Service**, connect the
repo, set **Root Directory** to `backend`, build command `npm install`,
start command `npm start`, and add the same env vars manually.

MQTT (`config/mqtt.js`) is optional and Render's free tier doesn't run
Mosquitto well (that needs a private service, which requires a paid
instance) — skip `MQTT_BROKER_URL` for now, or point it at a free hosted
broker like HiveMQ Cloud if you build a live dashboard later.


- Put this behind HTTPS (a reverse proxy like nginx/Caddy, or a managed
  load balancer) — the firmware assumes `SERVER_URL` is `https://`.
- Move `DEVICE_KEYS` to the `Device` collection with hashed keys.
- Add a TTL or archival job if you don't want to keep raw minute-level
  data forever — time-series collections support this natively.
- Consider a per-device request signature (HMAC over the payload) instead
  of a static key header if the network path is untrusted end-to-end.
