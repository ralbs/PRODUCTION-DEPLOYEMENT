# Real-Data Validation Prompt Flow — Phase 12 onward

Continues PROMPT_FLOW.md's numbering. Prerequisite: Phase 11 (the OpenAQ ETL,
2 real Bangalore stations, cities/bangalore.json's real sensor entries,
mean_fractional_bias/mean_fractional_error, scripts/validate_bangalore_real.py)
is done and committed (6e6658c). That work found the test design itself
can't yet distinguish real skill from coincidence — no real wind was used,
and the 2 real stations are too far apart to make a spatial holdout
meaningful. These prompts fix the design, not just re-run it.

Same rules as every prior phase: show real numbers, never fabricate data to
fill a gap, stop and ask before switching data-sourcing strategy, report bad
results as plainly as good ones. Two additional rules specific to this
phase, stated up front because they're easy to violate without noticing:

- **Never tune a model parameter against the same data used to report its
  skill.** If background_conc or any other config value gets recalibrated
  from real data, that calibration happens on a TRAINING window; skill is
  then reported on a DIFFERENT, held-out window/stations never used in
  calibration. Recalibrating and then validating on the same data is
  circular and will silently inflate every metric.
- **A CTM must beat a trivial baseline before its "skill" means anything.**
  Persistence (repeat the last observed value) and a simple diurnal
  climatology fit are both cheap to compute and both capture "coincidental
  diurnal shape resemblance" — exactly the failure mode that showed up
  last round. Every real-data skill number from here on gets reported next
  to both baselines, not in isolation.

---

## Phase 12 — Real meteorology (the most fundamental gap)

```
Everything computed against real air-quality data so far used the
project's climatology FALLBACK for wind, not real wind for that real
week — meaning transport (advection/diffusion) has never actually been
tested against reality, regardless of how good any concentration metric
looked. Fix this before anything else in this phase list.

Investigate, in this order, and STOP to tell me what's actually
accessible before building anything — don't assume a source works before
confirming it the same way you confirmed OpenAQ's S3 archive last phase
(a real fetch, a real file, real inspected content):

1. ERA5 reanalysis (Copernicus Climate Data Store, cdsapi Python package,
   free registration required for an API key -- check if that
   registration is something you can complete headlessly, or whether it
   needs a manual step you should ask me to do). Hourly, ~31km grid --
   coarser than our 500m domain, so a single ERA5 cell will cover the
   whole 27km Bangalore domain; that's a real limitation to state
   plainly, not hide (it tests the SIMULATOR's use of real synoptic wind,
   not fine-scale real wind variability within the domain).
2. Meteostat (aggregates real global station-level historical
   observations, has a public Python package) -- check whether it has
   actual Bangalore-area station coverage for the SAME week as our real
   AQ data (2019-07-10 to 2019-07-16), the same way you checked OpenAQ
   station coverage before committing to it.
3. IMD (India Meteorological Department) -- check what's actually
   publicly and programmatically accessible without a paid data request;
   don't assume, verify by trying.

Whichever source has REAL, VERIFIED, ACCESSIBLE data for that same real
week: build met/ingest_real_met.py that produces the StationObservation
sequence run_hindcast()/Simulator already expect from it, same
discipline as etl_cpcb.py -- confirm the actual raw schema by inspecting
real downloaded content before writing conversion code, don't assume
units/timezone/format.

If NONE of these have real, accessible data for that specific week: tell
me plainly, and propose the real alternative (e.g. a different week where
real met IS available, even if it doesn't overlap the AQ data you already
have -- in which case say so, and we'll decide whether to re-pull AQ data
for the met-covered week instead).
```

**Acceptance**: a real, verified met data source confirmed accessible for a
specific real time window, with actual inspected raw content shown before
any ingestion code is written — or an honest report that none exist and a
concrete alternative proposed.

---

## Phase 13 — Denser, closer real station coverage

```
Last phase's 2 real stations (6983, 6984) are 10,097m apart -- just past
localisation_radius_m=10000, making the spatial holdout structurally
unable to show assimilation having any direct effect at the held-out
station regardless of whether the assimilation logic is correct.

Find more real Bangalore (or another single Indian city, if Bangalore's
OpenAQ coverage is genuinely exhausted -- check before switching cities)
CPCB/KSPCB stations via the SAME verified method as last phase: OpenAQ's
public S3 archive (openaq-data-archive, no key needed) plus
explore.openaq.org for name/ID resolution. Target specifically:

- At least 2 station PAIRS with real overlapping data where the pair
  separation is COMFORTABLY inside localisation_radius_m (e.g. under
  5km), so a spatial holdout has a real chance of showing an effect if
  one exists.
- Ideally 4+ stations total with overlapping date ranges, for a genuine
  multi-station holdout rather than a single pair.
- Prefer a time window that also has real meteorology confirmed
  accessible from Phase 12 -- if the best station coverage and the best
  met coverage don't overlap in time, tell me the tradeoff rather than
  silently picking one.

Same station-discovery discipline as last time: confirm each candidate
ID actually has real archive files before counting it, note how much
effort you spent (last time: ~20 ID probes, 2 confirmed --don't burn
unlimited time before stopping and reporting what you actually have).

Update cities/bangalore.json's sensors with whatever real stations you
confirm. Document real separation distances between every station pair
in a comment, since that number turned out to be decisive last round.
```

**Acceptance**: at least one real, confirmed station pair well inside the
localisation radius; every station's real archive data verified by
inspection, not assumed from a name match.

---

## Phase 14 — Trivial baselines (done)

`persistence_baseline()` and `diurnal_climatology_baseline()` are
implemented in `scripts/hindcast_harness.py`, matching this phase's spec
exactly. Both are proven not to cheat by real, passing tests in
`tests/scripts/test_hindcast_harness.py`:
`test_persistence_baseline_error_grows_with_forecast_lead_time` and
`test_diurnal_climatology_baseline_raises_on_zero_local_hour_overlap`
(plus `test_diurnal_climatology_baseline_scores_correctly_on_overlapping_windows`).
Both baselines are then used for real, in every table in
`PHASE15_HOLDOUT_RESULTS.md` below.

```
Before re-running any holdout, implement two baseline predictors in
scripts/hindcast_harness.py so every future skill number has something
honest to be compared against:

1. persistence_baseline(): predicts the last real observed value at that
   station, carried forward, for every future timestep. No model, no
   physics -- the standard "can you beat doing nothing" floor.
2. diurnal_climatology_baseline(): fits a simple mean-by-local-hour
   profile from a TRAINING window of real data at each station, predicts
   that hour's climatological mean for any timestamp in a SEPARATE
   validation window. This is specifically designed to catch the failure
   mode found last round -- a model whose apparent skill is just
   "matches the typical diurnal shape" should score similarly to this
   baseline, not obviously better.

Both must respect the train/validate separation rule at the top of this
document -- diurnal_climatology_baseline() must never be fit and scored
on the same window.

Write a test proving both baselines are correctly not "cheating": verify
persistence_baseline's error grows with forecast lead time (it should
get worse the further ahead it predicts, unlike a model using real
physics), and verify diurnal_climatology_baseline() raises or behaves
sensibly if given a validation window with zero overlap in local-hour
coverage with its training window.
```

**Acceptance**: both baselines implemented, tested, and proven not to
silently reuse validation data in their own fitting.

---

## Phase 15 — Re-run spatial + temporal holdout, properly this time (done)

Real, executed, real numbers: **`PHASE15_HOLDOUT_RESULTS.md`** (run
2026-09-14, `py -m scripts.validate_bangalore_real`, exit 0) is the full
comparison table this phase's acceptance criteria calls for — all four
spatial-holdout experiments (both directions, both the original
outside-radius pair and Phase 13's new inside-radius pair), the temporal
holdout, the no-assimilation diagnostic control, and the tagged-tracer
mechanistic diagnostic, all four predictors (CTM-assimilated,
CTM-control, persistence, climatology) per species, with an explicit
per-species verdict and an honest overall tally.

**Plain verdict, stated as clearly as last round's**: across 24
species/experiment combinations, only 3 (12.5%) beat both trivial
baselines and 11 (45.8%) beat neither — the broad finding that CTM skill
often does not clearly exceed a diurnal-climatology lookup has **not**
fundamentally changed. What HAS genuinely changed: the inside-radius pair
(new in Phase 13) finally makes OI assimilation's real effect
measurable (a large CTM-assimilated vs CTM-control gap for no2,
independently confirmed as real physical transport — not coincidence —
by the tagged-tracer diagnostic), which the original outside-radius pair
was structurally unable to show. See `PHASE15_HOLDOUT_RESULTS.md`'s own
"Overall tally" section for the full reasoning, including a real,
unresolved oddity (pm25 assimilation performing worse than no-assimilation
control at the same inside-radius pair where no2 assimilation performs
best) flagged as a candidate for further diagnosis, not smoothed over.

```
Using Phase 12's real meteorology and Phase 13's better station coverage,
re-run BOTH holdouts from scripts/validate_bangalore_real.py:

1. Spatial holdout, at minimum on the close-together pair from Phase 13,
   plus the original 6983/6984 pair for direct before/after comparison
   against last round's result.
2. Temporal holdout -- this was BUILT last phase (run_hindcast_temporal_
   holdout) but its numbers were never reported. Run it and report them
   now, real meteorology included.
3. The no-assimilation control from last phase, kept as a permanent part
   of the script (it's the single most valuable check that emerged from
   the last round -- don't drop it just because this round has better
   inputs).
4. BOTH trivial baselines from Phase 14, computed on the exact same
   validation data as the CTM, so all four (CTM-assimilated, CTM-no-
   assimilation-control, persistence, diurnal-climatology) are in one
   table per species.

Report one table: species x {rmse, bias, correlation, mfb, mfe} x
{CTM-assimilated, CTM-control, persistence-baseline, climatology-
baseline}. State plainly, per species, whether the CTM beats BOTH
baselines, one, or neither -- that comparison is what actually
determines whether last round's finding (apparent skill was diurnal-
shape coincidence, not real transport/assimilation skill) has changed
with real wind and closer stations, or hasn't.

If it hasn't changed: say so as clearly as last round did, and use
tagged tracers / source inversion to investigate why, the same
diagnostic discipline as before -- don't just report a number.
```

**Acceptance**: the full comparison table, real numbers, explicit
per-species verdict against both baselines — not just against the
Boylan & Russell bands in isolation (a model can be inside the "goal" band
and still not beat a trivial baseline, which would mean the band alone was
never sufficient evidence).

---

## Phase 16 — Calibration (only after Phase 15, and only done correctly) (done)

Real, executed, self-critical: **`PHASE16_CALIBRATION_REPORT.md`**. One
trial (pm10/pm25 `background_conc`, fit on a disjoint 2019-07-17..23
training/validation split) is reported **rejected** — real before/after
numbers show it improved training fit but made validation RMSE and bias
worse, an explicit, reported overfitting finding, not glossed over. A
second trial (Hosur Road Corridor's co source rate, 2.0 -> 0.051) is
reported **applied** — it generalizes across both the calibration week
and, cross-checked with no re-fitting, the original Phase 15 week
(rmse 33.25 -> 0.69, MFB +151.8% -> +24.3%). `cities/bangalore.json`'s own
`_phase16_calibration` block mirrors this exactly, confirming the applied
change is live in the config the simulator actually uses, not just
described in a doc.

```
If Phase 15 shows systematic bias (e.g. SO2's ~2.5x background mismatch
found last round) rather than a transport/assimilation failure, this
phase recalibrates specific config values -- and ONLY this phase is
allowed to touch cities/bangalore.json's numeric defaults based on real
data.

Split whatever real data you now have into a TRAINING window and a
VALIDATION window that Phase 15 has not already reported skill numbers
on (if Phase 15 used your only real data, get more before doing this
phase -- do not recalibrate and validate on the same window, per the
rule at the top of this document).

Recalibrate specific declared values (background_conc, deposition v_dep,
emission source rates) against the TRAINING window only, using a
documented method (e.g. background_conc = training-window mean at
stations far from known sources). Then re-run Phase 15's full comparison
table on the VALIDATION window only, with the recalibrated config.

Report both the before/after config diff AND the before/after skill
table. If recalibration doesn't measurably improve validation-window
skill despite improving training-window fit, say so explicitly -- that
would indicate overfitting to the training window, which is itself an
important, reportable finding.
```

**Acceptance**: calibration and validation on genuinely disjoint data,
shown explicitly; before/after skill compared on the untouched validation
window, not the window used to calibrate.

---

## After Phase 16

At this point you'll have the first result that actually tests what this
whole project was built for: real transport physics against real wind,
checked against a baseline that would catch coincidental diurnal matching,
on real held-out stations and real held-out time. Whatever it shows —
including "still doesn't beat the baseline" — is now a real finding about
the model, not an artifact of the test's own limitations. That's the
actual bar for calling this "validated," not just "internally consistent."
