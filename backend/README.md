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
docker compose up -d      # local MongoDB (as a single-node replica set) + Mosquitto
docker exec -it aqms-mongo mongosh --eval "rs.initiate()"   # first run only
npm run dev
```

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

## REST endpoints
- `POST /api/telemetry` — device ingest (auth required). Body is exactly the
  JSON schema the firmware sends.
- `GET /api/telemetry/latest?station_id=NEL-001` — most recent reading for a station.
- `GET /api/telemetry/history?station_id=NEL-001&from=...&to=...&limit=500` — range query.

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
