# AQMS — Air Quality Monitoring System

> **ISRO / CRPF collaborative deployment** · ESP32 edge node → Express ingest API → MongoDB Atlas time-series → React dashboard

---

## System Architecture

```mermaid
flowchart LR
    subgraph PCB ["AQMS_CRPF_PCB (ESP32)"]
        direction TB
        S1["PMS5003\nPM1 · PM2.5 · PM10"]
        S2["BME680\nTemp · Humidity · Pressure"]
        S3["MICS-6814\nCO · NO₂ · NH₃"]
        S4["MQ-131\nO₃"]
        S5["MQ-136\nH₂S"]
        S6["ADS1115×2\n16-bit ADC"]
        S3 --> S6
        S4 --> S6
        S5 --> S6
    end

    subgraph BACKEND ["Express Backend  :4000"]
        direction TB
        MW["Auth Middleware\nX-Device-Id + X-Device-Key"]
        RT["/api/telemetry\nIngest & Query"]
        AQI["lib/aqi.js\nCPCB Sub-index"]
        PLM["lib/plume.js\nGaussian Plume"]
        FCT["lib/forecast.js\nHolt-Winters 24h"]
        GQL["GraphQL /graphql"]
        MW --> RT
        RT --> AQI
    end

    subgraph STORE ["Persistence  (core)"]
        MDB[("MongoDB Atlas\ntime-series collection")]
    end

    subgraph OPT ["Optional sinks"]
        TS["ThingSpeak\n8-field channel\nonly if THINGSPEAK_WRITE_KEY set"]
        MQTT["MQTT Broker\nonly if MQTT_BROKER_URL set"]
    end

    subgraph FRONT ["React Dashboard  :5173"]
        direction TB
        APP["App.jsx"]
        MAP["MapPanel\n(Leaflet.js)"]
        GAUGE["AQIGauge\nSubIndexPanel"]
        CHART["PollutantCharts\n(Recharts)"]
        PLUME["PlumeVisualizer\n(Canvas)"]
        FORE["ForecastPanel"]
    end

    PCB -->|"HTTP POST via SIM800C\n/api/telemetry"| BACKEND
    BACKEND --> MDB
    BACKEND -.->|"fire & forget\n(optional)"| TS
    BACKEND -.->|"publish\n(optional)"| MQTT
    FRONT -->|"REST + GraphQL\n(Vite proxy)"| BACKEND
    BACKEND --> FRONT
```

---

## Data Ingestion Flow

```mermaid
sequenceDiagram
    participant ESP as ESP32 Firmware<br/>(SIM800C)
    participant LIM as Rate Limiter<br/>(30 req/min)
    participant AUTH as Auth Middleware
    participant RT as POST /api/telemetry
    participant VAL as validatePayload()
    participant DB as MongoDB Atlas
    participant TS as ThingSpeak (optional)
    participant MQ as MQTT Broker (optional)

    ESP->>LIM: POST /api/telemetry<br/>X-Device-Id: ESP32-001<br/>X-Device-Key: secret
    LIM->>AUTH: pass (≤30/min)
    AUTH->>AUTH: lookup DEVICE_KEYS env var
    alt key mismatch
        AUTH-->>ESP: 401 Unauthorized
    end
    AUTH->>RT: req.deviceId = "ESP32-001"
    RT->>VAL: check required fields + ISO timestamp
    alt missing field
        VAL-->>ESP: 400 Bad Request
    end
    RT->>DB: Telemetry.create({ timestamp, meta, pollutants… })
    DB-->>RT: { _id }
    RT-->>ESP: 201 { status: "stored", id }
    RT-)TS: forwardToThingSpeak() — skipped if no write key
    RT-)MQ: mqttPublish() — skipped if no broker URL
```

---

## ESP32 Firmware Loop

```mermaid
flowchart TD
    BOOT([Power On / Reset]) --> INIT[Init Serial · LittleFS · Sensors\nPMS5003 · BME680 · ADS1115×2]
    INIT --> WIFI{WiFi connect\n10 s timeout}
    WIFI -- ok --> NTP[configTime via WiFi NTP]
    WIFI -- fail --> GSM[Connect SIM800C GPRS\nAT+CGDCONT + GPRS_APN]
    GSM -- connected --> MODEM_TIME[Read modem RTC\nNITZ or AT+CCLK\nsyncTimeFromModem]
    GSM -- fail --> OFFLINE[No connectivity\nbuffer to LittleFS]
    NTP --> LOOP
    MODEM_TIME --> LOOP
    OFFLINE --> LOOP

    LOOP([Main Loop — every 60 s]) --> R1["Read PMS5003\npm1 · pm2_5 · pm10  µg/m³"]
    LOOP --> R2["Read BME680\ntemp · humidity · pressure"]
    LOOP --> R3["Read ADS1115\nMICS-6814 → CO · NO₂ · NH₃  ppm\nMQ-131 → O₃ ppm · MQ-136 → H₂S ppm"]

    R1 & R2 & R3 --> BUILD["Build JSON payload\n+ device_id · station_id · ISO timestamp"]
    BUILD --> POST["POST /api/telemetry\nX-Device-Id + X-Device-Key headers"]

    POST -- "201 OK" --> FLUSH["Flush LittleFS\nbuffered queue if any"]
    POST -- "4xx / timeout" --> BUFF["Append to LittleFS\n(offline buffer)"]

    FLUSH --> SLEEP["delay 60 s"]
    BUFF --> SLEEP
    SLEEP --> LOOP
```

---

## AQI Sub-index Pipeline  *(CPCB National AQI, India)*

```mermaid
flowchart TD
    RAW["Raw sensor readings\nfrom MongoDB document"]

    subgraph CONV ["Unit conversion  ·  lib/aqi.js"]
        direction LR
        C1["PM2.5\nµg/m³ → used as-is"]
        C2["PM10\nµg/m³ → used as-is"]
        C3["NO₂ ppm\n× 46005.5 / 24.45 → µg/m³"]
        C4["O₃ ppm\n× 48000 / 24.45 → µg/m³"]
        C5["CO ppm\n× 28.01 / 24.45 → mg/m³"]
    end

    subgraph BP ["CPCB breakpoint interpolation"]
        direction TB
        BP1["PM2.5 sub-index  I_pm25"]
        BP2["PM10 sub-index  I_pm10"]
        BP3["NO₂ sub-index  I_no2"]
        BP4["O₃ sub-index  I_o3"]
        BP5["CO sub-index  I_co"]
    end

    MAX["AQI = max(I_pm25, I_pm10, I_no2, I_o3, I_co)"]

    CAT{"AQI value"}
    C_GOOD["0–50\nGood"]
    C_SAT["51–100\nSatisfactory"]
    C_MOD["101–200\nModerate"]
    C_POOR["201–300\nPoor"]
    C_VP["301–400\nVery Poor"]
    C_SEV["401–500\nSevere"]

    RAW --> CONV
    C1 --> BP1
    C2 --> BP2
    C3 --> BP3
    C4 --> BP4
    C5 --> BP5
    BP1 & BP2 & BP3 & BP4 & BP5 --> MAX
    MAX --> CAT
    CAT --> C_GOOD & C_SAT & C_MOD & C_POOR & C_VP & C_SEV
```

---

## MongoDB Document Schema

```mermaid
erDiagram
    TELEMETRY {
        Date    timestamp            "timeField — auto-bucketed by Mongo"
        String  meta_device_id       "metaField · indexed"
        String  meta_station_id      "indexed"
        Float   location_lat
        Float   location_lon
        Float   weather_temperature  "°C  BME680"
        Float   weather_humidity     "%   BME680"
        Float   weather_pressure     "hPa BME680"
        Float   pollutants_pm1       "µg/m³ PMS5003"
        Float   pollutants_pm2_5     "µg/m³ PMS5003"
        Float   pollutants_pm10      "µg/m³ PMS5003"
        Float   pollutants_co        "ppm MICS-6814"
        Float   pollutants_no2       "ppm MICS-6814"
        Float   pollutants_nh3       "ppm MICS-6814"
        Float   pollutants_o3        "ppm MQ-131"
        Float   pollutants_h2s       "ppm MQ-136"
        Float   pollutants_co2       "ppm MQ-135 proxy"
        Float   battery_voltage
        Float   battery_percent
        Int     signal_wifi_rssi     "-999 when on GPRS"
        String  health_mq135
        String  health_pms5003
        Boolean flags_offline_buffered
        Boolean flags_delayed
    }
```

---

## REST + GraphQL API

```mermaid
flowchart LR
    subgraph REST ["REST API  /api"]
        direction TB
        T1["POST /telemetry\n← ESP32 ingest"]
        T2["GET  /telemetry/latest?station_id="]
        T3["GET  /telemetry/history?station_id=&limit="]
        A1["GET  /aqi/latest?station_id="]
        A2["GET  /aqi/history?station_id="]
        S1["GET  /stations"]
        P1["POST /plume/estimate"]
        F1["GET  /forecast/:station_id"]
        HE["GET  /health"]
    end

    subgraph GQL ["GraphQL  /graphql"]
        direction TB
        Q1["query latestTelemetry(station_id)"]
        Q2["query telemetryHistory(station_id, from, to)"]
        Q3["subscription onTelemetry(station_id)\n← real-time via MQTT"]
    end

    ESP32 -->|auth headers| T1
    DASH["Dashboard\n(React)"] --> T2 & T3 & A1 & A2 & S1 & P1 & F1
    DASH -.->|optional| Q1 & Q2 & Q3
```

---

## Frontend Component Tree

```mermaid
flowchart TD
    APP["App.jsx\nstate: stations · selected · latest · history · forecast · stationsAQI"]

    APP --> HDR["Header\nLogo · Clock · Fullscreen · Voice"]
    APP --> HERO["HeroSection\nStation select · Run Analysis"]
    APP --> CATBAR["AQICategoryBar\ncurrent category highlight"]
    APP --> INS["InsightsBanner\nclearest · worst · city avg"]
    APP --> TABLE["StationTable\nAQI · category pill · dominant pollutant"]
    APP --> TOAST["AlertToast\nAQI threshold crossing"]
    APP --> KB["KeyboardShortcuts\n? · F · V · R · 1-5 · Esc"]

    APP --> GRID["content-grid"]
    GRID --> LC["left-col"]
    GRID --> RC["right-col"]

    LC --> FSM["FullscreenCard ▸ MapPanel\nLeaflet.js · AQI circle markers"]
    LC --> FSW["FullscreenCard ▸ WeatherPanel\ntemp · humidity · pressure · freshness"]

    RC --> FSA["FullscreenCard ▸ AQIGauge\n+ SubIndexPanel  progress bars\n+ HealthAdvisory  CPCB guidelines"]
    RC --> FSF["FullscreenCard ▸ ForecastPanel\nHolt-Winters 24h · voice readout"]

    APP --> CHARTS["charts-band"]
    CHARTS --> FSP["FullscreenCard ▸ PollutantCharts  PM\nPM2.5 · PM10 · time-range filter"]
    CHARTS --> FSG["FullscreenCard ▸ PollutantCharts  Gas\nNO₂ · O₃ · CO"]

    APP --> PLUME_W["FullscreenCard ▸ PlumeVisualizer\nGaussian plume canvas\nPOST /api/plume/estimate"]
```

---

## Gaussian Plume Model

```mermaid
flowchart TD
    IN["Inputs\nQ  emission rate kg/s\nu  wind speed m/s\nH  stack height m\nwindDir  degrees\nstabilityClass A–F  optional\nisDaytime  optional"]

    CLS["Pasquill-Gifford\nstability class A–F\n← derived from u + daylight\n  if not provided"]

    BRIGGS["Briggs rural σ coefficients\nσy  σz  m  at downwind x"]

    CONC["Concentration at x y z\nC = Q / 2π·σy·σz·u\n× exp−y²/2σy²\n× exp−z−H²/2σz² + exp−z+H²/2σz²\n→ µg/m³"]

    GRID["80×60 grid cells\n±maxDist × halfY domain\nnormalise t ∈ 0–1\ndrop cells where t < 0.005"]

    RESP["Response JSON\ngrid  i j t cells\nmaxC_ugm3 · peakX_m\ncenterline · gridMeta"]

    CANVAS["Frontend canvas\nImageData pixel fill\njet colormap blue→red\nlegend overlay"]

    IN --> CLS --> BRIGGS --> CONC --> GRID --> RESP --> CANVAS
```

---

## Deployment Topology

```mermaid
flowchart TD
    subgraph FIELD ["Field deployment"]
        DEV1["ESP32 node #1\nSIM800C · station_id: SITE-A"]
        DEV2["ESP32 node #2\nSIM800C · station_id: SITE-B"]
        DEV3["ESP32 node N\n…"]
    end

    subgraph CLOUD ["Cloud / Server  (required)"]
        direction TB
        NGINX["Nginx / Reverse proxy\n:443 TLS termination"]
        BACK["Express  :4000"]
        MONGO[("MongoDB Atlas\ntime-series")]
    end

    subgraph OPTIONAL ["Optional integrations"]
        TS2["ThingSpeak\nEnabled by setting\nTHINGSPEAK_WRITE_KEY in .env"]
        MQB["MQTT Broker\nEnabled by setting\nMQTT_BROKER_URL in .env"]
    end

    subgraph CLIENT ["End users"]
        BROWSER["Browser\nReact dashboard"]
    end

    DEV1 & DEV2 & DEV3 -->|"HTTPS POST via GPRS\n/api/telemetry"| NGINX
    NGINX --> BACK
    BACK <--> MONGO
    BACK -.->|"fire & forget\nif key set"| TS2
    BACK -.->|"publish\nif broker set"| MQB
    BROWSER -->|"HTTPS REST + GraphQL"| NGINX
```

---

## Quick Start

**1 — Backend**
```bash
cd backend
cp .env.example .env
# Required: MONGO_URI, DEVICE_KEYS
# Optional: THINGSPEAK_WRITE_KEY, MQTT_BROKER_URL
npm install
npm run dev                 # http://localhost:4000
```

**2 — Frontend**
```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173
```
The Vite proxy rewrites `/api/*` → `http://localhost:4000` — no CORS config needed in dev.

**3 — Firmware (SIM-only deployment)**

Open `firmware/AQMS_Firmware.ino` in Arduino IDE 2. Edit `firmware/config.h`:
```c
// Identity
#define DEVICE_ID        "ESP32-001"
#define STATION_ID       "SITE-A"
#define STATION_LAT       12.9716
#define STATION_LON       77.5946

// SIM800C — primary uplink
#define GPRS_APN         "airtelgprs.com"   // Airtel | "jionet" | "bsnlnet" | "www"
#define SERVER_HOST      "your-backend.onrender.com"
#define SERVER_PORT      80
#define SERVER_PATH      "/api/telemetry"

// Auth — must match DEVICE_KEYS in backend .env
#define DEVICE_API_KEY   "your-secret-key"
```

Flash to ESP32-WROOM-32 at 115200 baud.

> WiFi is attempted first (10 s timeout) then falls back to SIM automatically.
> Time is synced from the modem's RTC (NITZ) — no separate NTP config needed for SIM.

**4 — Adding a station**

Add `ESP32-002:new-key` to `DEVICE_KEYS` in backend `.env`, flash a second board with matching credentials. The new station appears in the dashboard automatically — no backend code changes needed.

---

## Key Contracts

| Layer | Field | Unit | Notes |
|-------|-------|------|-------|
| Firmware → Backend | `pm2_5`, `pm10`, `pm1` | µg/m³ | PMS5003 native output |
| Firmware → Backend | `co`, `no2`, `nh3` | ppm | MICS-6814 after Rs/R0 conversion |
| Firmware → Backend | `o3` | ppm | MQ-131 after conversion |
| Firmware → Backend | `h2s` | ppm | MQ-136 after conversion |
| Backend → Frontend | AQI | 0–500 | Computed by `lib/aqi.js` on every read — not stored in DB |
| Backend → ThingSpeak | field6 | numeric AQI | Only forwarded if `THINGSPEAK_WRITE_KEY` is set |

Gas ppm→µg/m³ conversions happen **only inside `lib/aqi.js`** for breakpoint comparison. MongoDB stores raw ppm values.

---

## Optional Integrations

| Integration | How to enable | What it does |
|------------|--------------|--------------|
| **ThingSpeak** | Set `THINGSPEAK_WRITE_KEY` in `backend/.env` | Mirrors PM2.5/PM10/NO₂/O₃/CO/AQI/Temp/Humidity to an 8-field channel after every POST |
| **MQTT** | Set `MQTT_BROKER_URL` in `backend/.env` | Publishes each telemetry payload to `aqms/<station_id>` topic for real-time subscribers |
| **GraphQL** | Always available at `/graphql` | Queries + subscriptions (subscriptions require MQTT broker) |

Neither ThingSpeak nor MQTT is required for the core pipeline. Omitting their env vars disables them silently.

---

## Project Layout

```
AQMS_Project/
├── firmware/
│   ├── AQMS_Firmware.ino      ESP32 sketch — sensor read + SIM800C HTTP POST
│   ├── config.h               SIM APN · server host · device credentials · pin map
│   ├── .vscode/
│   │   └── c_cpp_properties.json   Arduino includePath for VS Code IntelliSense
│   └── README.md              Library list · calibration notes
├── backend/
│   ├── server.js              Express app + Apollo GraphQL bootstrap
│   ├── routes/
│   │   ├── telemetry.js       POST ingest · GET latest · GET history
│   │   ├── aqi.js             GET latest AQI · GET AQI history
│   │   ├── plume.js           POST /estimate  Gaussian plume grid
│   │   ├── forecast.js        GET Holt-Winters 24h forecast
│   │   └── stations.js        GET distinct station list
│   ├── middleware/
│   │   └── auth.js            X-Device-Id / X-Device-Key check
│   ├── models/
│   │   └── Telemetry.js       Mongoose time-series schema (nh3 + h2s included)
│   ├── lib/
│   │   ├── aqi.js             CPCB sub-index · ppm→µg/m³ conversions
│   │   ├── plume.js           Pasquill-Gifford stability + Briggs rural σ
│   │   ├── forecast.js        Holt-Winters exponential smoothing
│   │   └── thingspeak.js      Optional fire-and-forget ThingSpeak forward
│   ├── graphql/
│   │   └── schema.js          typeDefs + resolvers + subscriptions
│   ├── config/
│   │   ├── db.js              MongoDB Atlas connection + time-series setup
│   │   └── mqtt.js            Optional MQTT broker setup
│   ├── docker-compose.yml     Local Mongo + Mosquitto for dev
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── App.jsx             Root component · 60 s polling · state
    │   ├── api.js              Typed fetch wrappers · latest 2000 records
    │   ├── index.css           Design system tokens + component styles
    │   └── components/
    │       ├── Header.jsx           ECG logo · clock · fullscreen btn
    │       ├── HeroSection.jsx      Landing hero + analysis launcher
    │       ├── AQICategoryBar.jsx   6-category legend strip
    │       ├── InsightsBanner.jsx   City-wide insight pills
    │       ├── StationTable.jsx     Station comparison table
    │       ├── MapPanel.jsx         Raw Leaflet.js station map
    │       ├── AQIGauge.jsx         Radial AQI meter
    │       ├── SubIndexPanel.jsx    Progress bar sub-indices
    │       ├── HealthAdvisory.jsx   CPCB advisory per category
    │       ├── ForecastPanel.jsx    24h forecast chart + voice
    │       ├── WeatherPanel.jsx     BME680 weather card
    │       ├── PollutantCharts.jsx  Recharts · client-side time-range filter
    │       ├── PlumeVisualizer.jsx  Gaussian plume canvas (backend compute)
    │       ├── FullscreenCard.jsx   Maximize-to-overlay wrapper
    │       ├── AlertToast.jsx       AQI threshold crossing toast
    │       └── KeyboardShortcuts.jsx  ? · F · V · R · 1-5 · Esc
    ├── vite.config.js          Port 5173 · /api proxy to :4000
    └── .env.example
```
