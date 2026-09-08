# Phase 16 calibration report

Per CLAUDE.md's testing philosophy and PROMPT_FLOW_VALIDATION.md's Phase 16
gate: calibration and validation must happen on genuinely disjoint real
data, and a recalibration that improves training fit but not
validation-window skill must be reported as overfitting, not smoothed
over. This is that report, for both the change that was **rejected** and
the one that was **applied**.

Both trials were fit on the same disjoint week (2019-07-17 to 2019-07-23,
confirmed real and never used in any Phase 15 reported skill number), split
into a training sub-window (07-17 to 07-20, first 4 days) and a validation
sub-window (07-20 to 07-23, remaining ~3 days). Method throughout: the
forward (no-assimilation) CTM field, scored pooled across all 5 real
stations for pm10/pm25, Silk Board (6975) only for co.

## Rejected: pm10 / pm25 `background_conc`

**Trial**: set `background_conc` to the training-window mean of real
observations, pooled across all 5 stations (35.0 -> 48.304 for pm10, 15.0
-> 19.124 for pm25).

**Result: did not generalize. Reverted; `cities/bangalore.json` still has
the original 35.0 / 15.0.**

| | pm10 | pm25 |
|---|---|---|
| training RMSE, old -> new | 51.344 -> 48.204 (-6%) | 25.920 -> 25.558 (-1.4%) |
| validation RMSE, old -> new | 22.609 -> **23.705 (worse)** | 9.453 -> **11.102 (worse)** |
| validation bias, old -> new | -3.202 -> **+7.704** | +2.220 -> **+6.254** |

### Root cause, confirmed directly against real station data

Real pm10/pm25 dropped sharply partway through the calibration week — this
is not model noise, it's in the raw observations:

| | training days (07-17 to 07-20), real mean | validation days (07-21 to 07-23), real mean | drop |
|---|---|---|---|
| pm10 | 49.114 (n=1337) | 32.170 (n=1061) | **-34.5%** |
| pm25 | 19.518 (n=1686) | 12.611 (n=1296) | **-35.4%** |

(July is peak monsoon in Bangalore; the most likely explanation is a rain
event scavenging particulate matter mid-week, though this report doesn't
independently confirm rainfall — the finding that stands regardless of
cause is that the drop is real, in the raw data, not a model artifact.)

A single scalar `background_conc`, fit on the wetter/higher training days,
necessarily overshoots the drier/lower validation days. The validation
bias shift (+10.9 for pm10, +4.0 for pm25) is smaller than the full real
drift (16.9 / 6.9) because the parameter doesn't pass through 1:1 —
deposition and boundary dilution attenuate it — but the **direction is
exactly what the drift predicts**: the recalibrated config over-predicts
on validation, precisely because it was tuned to a systematically
higher period. This confirms the failure is non-stationarity a single
flat parameter cannot track, not a bug in the calibration method itself.

**Also worth recording**: even on its OWN training data, setting
`background_conc` to the training mean did not zero out training bias
(pm10 training bias only fell from -20.4 to -9.95) — the parameter isn't
a 1:1 lever on the resulting field mean, because deposition/dilution sit
between the boundary condition and the interior concentration. The
calibration method's ceiling is lower than "matches the window it was fit
on," even before the non-stationarity problem.

**Baseline comparison (for context, unaffected by this decision)**: neither
the old nor the (rejected) new config beat the persistence baseline for
pm10 on the validation window (old 22.609 vs persistence 21.825, new
23.705 vs 21.825 — loses both times). pm25 beat both baselines with the
old config and continued to with the rejected new config, by a smaller
margin (9.453 vs persistence 11.663/climatology 14.160, before; 11.102 vs
11.663/14.160, after).

## Applied: co, Hosur Road Corridor source rate

**Trial**: hold `background_conc` for co unchanged; rescale ONLY the
`Hosur Road Corridor` area source's co rate (2.0 -> 0.051, ×0.025), fit by
running the forward model with and without that one source (isolating its
contribution from the co-located "Outer Ring Road NE" source, which shares
the same `morning_evening` profile/tag but is a different source) and
solving for the rate that matches Silk Board's real training-window co
mean. Scope: Silk Board (6975) only — not extrapolated to any other
station or source, per the diagnosis that found this station uniquely had
clean composition (95.3% of its co field is this one tag), shape
correlation (+0.742), and peak-hour offset (1h) agreement.

**Result: generalizes. Applied to `cities/bangalore.json`.**

| | training (07-17..20) | validation (07-20..23) | Phase 15 week (07-09..16), cross-check |
|---|---|---|---|
| RMSE, old -> new | 34.044 -> 0.945 | 43.630 -> 1.192 | 33.249 -> 0.690 |
| bias, old -> new | +18.934 -> +0.187 | +21.138 -> +0.627 | +19.129 -> +0.280 |
| MFB, old -> new | +145.8% -> +15.3% | +146.9% -> +48.4% | +151.8% -> +24.3% |

The cross-check column applies the rate **as-is, with no re-fitting** to
the ORIGINAL Phase 15 week (2019-07-09 to 2019-07-16), which played no
part in fitting it — the improvement holds there too (RMSE -98%), not
just on the week it was calibrated against. Correlation is unchanged by
construction (+0.551 on the Phase 15 week, both before and after) since a
pure rate rescale doesn't touch timing/shape, only magnitude — consistent
with the diagnosis that Silk Board's co timing was already correct and
only the magnitude (16.7x too high) needed fixing.

**Baseline comparison**: still loses to both trivial baselines on the
validation window (calibrated RMSE 1.192 vs persistence 0.600 and
climatology 0.702) — Silk Board's real co series is apparently low-noise
enough that "repeat the last value" still edges out a physically-driven
transport prediction, even a well-calibrated one. The fix makes the model
physically sane (no longer 16x too high) and is worth keeping on that
basis, but it is not, by itself, evidence the model beats a trivial
baseline for co at this station.

## Net effect on `cities/bangalore.json`

- `species.pm10.background_conc`: unchanged (35.0)
- `species.pm25.background_conc`: unchanged (15.0)
- `emission_sources[Hosur Road Corridor].rates.co`: 2.0 -> 0.051
- so2: excluded from this round (documented separately in
  `_phase16_calibration` — negative-or-near-zero shape correlation in
  every checked Phase 15 row)
- no2: deferred (documented photochemistry-timing limitation)

## What this means for the project

A single scalar per-species `background_conc`, calibrated from one week of
real data, is not a robust fix here — real ambient pollution is
non-stationary at sub-weekly timescales (at least for pm10/pm25 in a
monsoon week), and a flat parameter fit to one period will overshoot or
undershoot a different period whenever the true level has moved. A
source-specific emission RATE fix, by contrast, generalized cleanly across
two different weeks — because it corrects a fixed physical
misspecification (this source's rate was wrong by 16.7x) rather than
trying to track a moving target. Future background_conc recalibration
attempts should account for this — e.g. fitting from a longer/multi-week
window, or making background_conc itself time-varying from a real
climatology rather than a single scalar — rather than repeating this
exact method.
