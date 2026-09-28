# Hero redesign — spec

**Status: implemented per recommended answers; owner sign-off pending.**
Section 5's five decisions were each built as the recommended option
(CPCB-led, 10-minute staleness, P0-a hourly resampling, neutral
source-direction pointer, single `aqiColor.js` palette for the hero).
P0-b's pointing of `StationTable`/`AQIGauge` at that palette is not done yet.
Any decision the owner changes at sign-off is a code change, not just a doc edit.

One full-width hero that answers, in plain language, *what is the air like
here and what should I do* — with every CTM/statistical value carrying the
root CLAUDE.md confidence treatment (value + structural estimated/measured
state + staleness), and nothing stated more confidently than the data allows.

Every string and threshold below is taken from a primary source or from the
code; each one says where it came from. Implementation: `frontend/src/lib/heroModel.js`
(pure, tested), `frontend/src/components/HeroSection.jsx`, `backend/lib/forecast.js`.

---

## 0. Prerequisites found while writing this (must land before or with P1)

**P0-a. The Holt-Winters forecast treats every reading as one hour — the device
reports every 60 s.** `firmware/config.h`: `TELEMETRY_INTERVAL_MS 60000UL`.
`backend/lib/forecast.js`:
- fits the latest `lookback=168` *readings* (meant as 168 h / one week) —
  at 1/min that is ~2.8 hours;
- stamps prediction *i* at `lastTs + (i+1)·3600 s`;
- `trendLabel(b)`'s thresholds (0.5 / 1.5) are AQI *per step* = per minute.

So on a device reporting as designed, the "24h forecast" is ~24 minutes of
extrapolation labelled as 24 hours. It is invisible today only because
NEL-001 has sent one reading. **Fix:** resample to hourly means before fitting
(then steps, timestamps and the per-hour thresholds are all genuinely hourly).
`checkSpike()` has the same per-reading-vs-per-hour assumption and needs the
same treatment. No trend clause (section 2) ships until this is fixed.

**P0-b. Three different AQI palettes are in use.** `lib/aqiColor.js` (the U5
ramp) and `AQIGauge.jsx` use Satisfactory `#84cc16`, Moderate `#eab308`;
`HeroSection.jsx` and `StationTable.jsx` use `#a3e635`, `#facc15`. The hero
uses `aqiColor.js`'s `STOPS` only; the other maps should be pointed at it in
the same change.

**P0-c. `HealthAdvisory.jsx`'s action pills are invented** ("Wear N95 mask
outdoors", "Close windows"). Neither CPCB nor Health Canada publishes these.
The hero does not reuse them.

---

## 1. Plain-language guidance — which index, and the exact strings

### Decision needed: which index leads the hero

| | CPCB National AQI | AQHI (Health Canada formula) |
|---|---|---|
| Status here | India's official index; the number, colour and category the whole dashboard already uses | Secondary "Health Intelligence" ring |
| Inputs we actually have | PM2.5, PM10, NO2, CO, NH3 (O3 pin not connected) | PM2.5, NO2 only — **O3 is always 0** here |
| Averaging it is defined on | 24 h (8 h for CO/O3) — CPCB AQI table footnote | 3 h rolling — we compute it on single readings |
| Calibrated for | Indian conditions (CPCB expert group, 2014) | Canadian mortality data |

**Recommendation: CPCB leads.** It's the official Indian index, the one the
colour and number already represent, and it's missing fewer of its inputs.
AQHI stays as secondary detail. Leading with AQHI would put Canadian
guidance next to an Indian category colour, and the two can disagree.

Both are computed here on the **latest single reading**, not the averages they
are defined on, so the hero always says "latest reading", never implies an
official averaged category.

### 1a. CPCB-led strings (recommended)

Source: CPCB, *National Air Quality Index* report (2014), p.38, "AQI —
Associated Health Impacts", quoted verbatim. CPCB publishes *impacts*, not
actions, so the hero states the impact and invents no actions.

| AQI | Category (CPCB name) | Hero headline | Secondary line (CPCB verbatim) |
|---|---|---|---|
| 0–50 | Good | **Air quality is Good.** | Minimal Impact |
| 51–100 | Satisfactory | **Air quality is Satisfactory.** | May cause minor breathing discomfort to sensitive people |
| 101–200 | Moderately polluted | **Air is moderately polluted.** | May cause breathing discomfort to the people with lung disease such as asthma and discomfort to people with heart disease, children and older adults |
| 201–300 | Poor | **Air quality is Poor.** | May cause breathing discomfort to people on prolonged exposure and discomfort to people with heart disease with short exposure |
| 301–400 | Very Poor | **Air quality is Very Poor.** | May cause respiratory illness to the people on prolonged exposure. Effect may be more pronounced in people with lung and heart diseases |
| 401–500 | Severe | **Air quality is Severe.** | May cause respiratory effects even on healthy people and serious health impacts on people with lung/heart diseases. The health impacts may be experienced even during light physical activity |

Category thresholds are `backend/lib/aqi.js aqiCategory()` (matches the CPCB
table); the headline uses CPCB's full name "Moderately polluted" rather than
the code's "Moderate".

### 1b. AQHI-led strings (if you choose AQHI instead)

Source: Health Canada / ECCC, *About the Air Quality Health Index* (current
page), quoted verbatim. The thresholds and messages are Health Canada's; Stieb
et al. (2008) is the paper behind the formula, not the category scheme.
At-risk population, verbatim: "children, people over 65 years, those with
health conditions".

| AQHI | Risk | General population (verbatim) | At-risk population (verbatim) |
|---|---|---|---|
| 1–3 | Low | enjoy your usual outdoor activities | *(no separate message published)* |
| 4–6 | Moderate | continue usual outdoor activities unless you have symptoms like coughing and throat irritation | consider reducing or rescheduling strenuous outdoor activities if you have symptoms |
| 7–10 | High | consider reducing or rescheduling strenuous outdoor activities if you have symptoms | reduce or reschedule strenuous outdoor activities |
| 10+ | Very high | reduce or reschedule strenuous outdoor activities, especially if you have symptoms | avoid strenuous activities outdoors |

Note the scale here is Health Canada's, not the "1–3 → Good for everyone"
wording in the request: the published low-risk message is "enjoy your usual
outdoor activities".

### 1c. Staleness overrides everything (confidence rule)

The device reports every 60 s. The hero is only in **current** mode when the
latest reading is at most **10 minutes old** (10× cadence; tolerates short
network gaps). Otherwise it's in **stale** mode:

- Headline: **"No current reading from {station}."**
- Secondary: "Latest reading: {category}, {local date/time} ({age} ago)."
- No guidance line, no trend clause, category colour demoted to a small chip
  (never the dominant background), staleness badge in its STALE state.

**This is what NEL-001 shows today** (latest reading 2026-09-08 20:45 UTC):
"No current reading from NEL-001. Latest reading: Good, 9 Sept 2:15 am
(19 days ago)." A present-tense "Air quality is Good" would be false.

---

## 2. Forecast trend → one short clause

Inputs (after P0-a): `forecast.trend` (backend `trendLabel(b)`, `b` = fitted
Holt-Winters slope in AQI per hour), `forecast.predictions[h]` with
`aqi`, `aqi_low`, `aqi_high` (interval grows as σ·√h), current AQI, and the
last few real hourly means.

Clause is shown **only if all hold**; otherwise it's omitted (never guessed):
- hero is in current mode (1c);
- forecast endpoint returned a forecast (not "not enough readings");
- at least 6 hourly means exist (below that the slope is noise);
- the direction isn't contradicted by the data: if the last 3 hourly means all
  move opposite to `trend`, show "Direction unclear right now" instead
  (Holt-Winters' smoothed slope can lag a real turn — seen tonight, where the
  model said "rapidly rising" while the last readings fell).

Wording rules (lower AQI = better air):

| `trend` (existing thresholds, per hour) | Clause |
|---|---|
| `falling` (−1.5 ≤ b < −0.5) | "Improving over the next 2 hours." |
| `rapidly falling` (b < −1.5) | "Improving quickly over the next 2 hours." |
| `stable` (−0.5 ≤ b ≤ 0.5) | "Steady over the next 2 hours." |
| `rising` (0.5 < b ≤ 1.5) | "Worsening over the next 2 hours." |
| `rapidly rising` (b > 1.5) | "Worsening quickly over the next 2 hours." |

Category-change add-on, within the same 2 h horizon only:
- If the whole interval at hour *h* (`aqi_low` and `aqi_high`) lies in a
  different category: append **"— likely {Category} by {time}."**
- If only the point prediction crosses: append **"— may reach {Category} by
  {time}."**
- Otherwise, nothing.

The clause carries an **ESTIMATED** badge labelled "STATISTICAL FORECAST"
(it's Holt-Winters extrapolation, not the CTM), aged from `generated_at`.

---

## 3. Source direction in the hero

**The request's premise doesn't hold yet, so this section can't do what was
asked.** Tonight's synthetic accuracy run (`ctm-core/scripts/tracer_accuracy_harness.py`,
recorded in PROMPT_FLOW_UI.md) found that *no* confidence value identifies
accurate estimates. In the **interior** tier, confidence is **inversely**
related to accuracy (ρ +0.15…+0.25, CI excludes 0): interior "High" was the
*least* accurate interior band. So "interior + high confidence" isn't a
reliable "genuinely high confidence" signal; it's the opposite, as far as
the evidence goes.

Proposed rule until a calibrated confidence exists:

- **The hero never states a bearing or a source**, in any tier.
- When a **fresh** estimate exists (spike reading ≤ 2 h old, not inconclusive),
  the hero appends one neutral pointer sentence:
  **"An unusual rise was detected at {time} — see Source Direction for a
  screening estimate."** No direction, no confidence word.
- When the worker's last run was **spike but no wind** (`spike_no_wind`):
  **"An unusual rise was detected at {time}, but its direction couldn't be
  estimated."**
- Otherwise (no spike, no estimate, stale estimate): **say nothing about
  sources.** "No estimate" isn't evidence of "no source", so the hero never
  says anything like "no pollution sources detected".

If you'd rather show a bearing anyway, the alternative is a hedged clause on
any fresh, non-inconclusive estimate: "screening estimate: from the {WNW}
(unvalidated)" with the dashed ESTIMATED treatment. I don't recommend it until
the confidence rework in PROMPT_FLOW_UI.md's open follow-up is done.

---

## 4. Visual concept

One full-width region replacing the current `HeroSection` block.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▌ NELLORE, ANDHRA PRADESH                       [ NEL-001 ▾ ]            │
│ ▌                                                                        │
│ ▌ Air quality is Satisfactory.                        AQI 72             │
│ ▌ May cause minor breathing discomfort to sensitive   ● MEASURED 1m ago  │
│ ▌ people.                                                                │
│ ▌                                                                        │
│ ▌ Worsening over the next 2 hours — may reach Moderately polluted        │
│ ▌ by 4 pm.   ◌ STATISTICAL FORECAST · 12m ago                            │
│ ▌ An unusual rise was detected at 2:10 pm — see Source Direction …       │
└──────────────────────────────────────────────────────────────────────────┘
  ▌ = category colour accent; the whole region carries a low-alpha tint of
      the same colour over the dark base, with the live-wind ambient field
      drifting behind it.
```

- **Colour:** `aqiToRgb(aqi)` from `lib/aqiColor.js` (the U5 ramp) is the only
  source. It's used as a 6px left accent bar plus a ~10–14% alpha background
  tint. Text is **never** set on a saturated category fill (yellow/lime fail
  WCAG AA with light text); body copy stays `--text` / `--text-sub` on the
  dark base. Check: headline ≥ 4.5:1 against the tinted background for every
  category (axe, as in U5/U6).
- **Type:** headline `clamp(28px, 4vw, 44px)`, weight 700; secondary line
  15–16px `--text-sub`; trend clause 13px beneath, with its badge inline.
- **Numbers are secondary:** AQI shown small at right with its MEASURED badge
  and age (the sentence leads, the number supports it).
- **Stale mode:** tint and accent go neutral grey; category appears only as a
  small chip; STALE badge. The colour must not claim current conditions.
- **Ambient:** the existing live-wind ambient field (`useLiveWind`) renders
  behind the hero, per the ambient-data principle. It's at opacity 0 when there's
  no wind, as now.
- **Station selector:** stays top-right, unchanged behaviour.
- **Mobile (≤ 640px):** single column; AQI + badge drop below the secondary
  line; no horizontal scroll.

---

## 5. Decisions needed for sign-off

1. **CPCB-led (recommended) or AQHI-led** guidance (§1a vs §1b).
2. **Staleness threshold:** 10 minutes (10× the 60 s cadence)?
3. **P0-a:** fix the forecast's minute-vs-hour step (hourly resampling) as
   part of P1, before the trend clause ships?
4. **Source direction:** neutral pointer sentence only (recommended), or the
   hedged-bearing alternative?
5. Point `HeroSection` / `StationTable` / `AQIGauge` at the single
   `aqiColor.js` palette in the same change (P0-b)?

## Sources

- CPCB, *National Air Quality Index* (report, 2014), p.38 "AQI — Associated
  Health Impacts": https://cpcb.gov.in/displaypdf.php?id=bmF0aW9uYWwtYWlyLXF1YWxpdHktaW5kZXgvRklOQUwtUkVQT1JUX0FRSV8ucGRm
- CPCB, *About National Air Quality Index* (category table and averaging
  periods): https://cpcb.gov.in/displaypdf.php?id=bmF0aW9uYWwtYWlyLXF1YWxpdHktaW5kZXgvQWJvdXRfQVFJLnBkZg%3D%3D
- Health Canada / ECCC, *About the Air Quality Health Index*:
  https://www.canada.ca/en/environment-climate-change/services/air-quality-health-index/about.html
- `firmware/config.h` (`TELEMETRY_INTERVAL_MS`), `backend/lib/forecast.js`
  (`trendLabel`, `buildForecast`), `frontend/src/lib/aqiColor.js`
- PROMPT_FLOW_UI.md: synthetic tracer-accuracy results (confidence vs bearing error)
