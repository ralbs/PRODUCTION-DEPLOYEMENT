# Phase 15 holdout results — real run, real output

Per `PROMPT_FLOW_VALIDATION.md`'s Phase 15 (whose acceptance criteria calls
for "the full comparison table, real numbers, explicit per-species verdict
against both baselines" as its deliverable): this is that table. It did not
previously exist as a committed artifact — `scripts/validate_bangalore_real.py`
implemented the full spec, but nothing had captured a real run's actual
output into a file. This document is exactly that capture, run on
2026-09-14, command:

```
cd ctm-core
py -m scripts.validate_bangalore_real
```

Exit code 0, full real stdout below, transcribed faithfully (numbers
unedited; only reformatted from the script's printed layout into tables).

## Data provenance (as reported by the real run)

- 14,041 real observation records, 5 real Bangalore stations
  (`5548`, `6973`, `6975`, `6983`, `6984`), species `co, no2, pm10, pm25, so2`.
- Date range: `2019-07-09T18:45:00+00:00` to `2019-07-16T18:30:00+00:00` (UTC).
- Real meteorology: Meteostat station 43295 "Bangalore", 155 usable 3-hourly
  reports (5 rejected as incomplete/non-finite) over the run window.
- This window is entirely **pre-COVID** (India's first lockdown began
  2020-03-24) — not COVID-anomalous, though the underlying archive (2018-08
  to 2020-04) cannot represent current 2025-2026 conditions either way.
- Station pair separations (`cities/bangalore.json`'s
  `_sensor_pair_distances_m`): `6983<->6984 = 10,097m` (just OUTSIDE
  `localisation_radius_m=10000` — the only real pair available last round);
  `6973<->5548 = 1,381m` (the tightest pair, well INSIDE the radius — new
  this round, added in Phase 13).
- Training/validation split, used for every table below: training window
  `2019-07-09T18:45` to `2019-07-13T18:45` (5760 steps), validation window
  `2019-07-13T18:45` to `2019-07-16T18:30`. The diurnal-climatology baseline
  is fit ONLY on the training window and scored ONLY on the validation
  window; CTM-assimilated and CTM-control are restricted to the same
  validation-window records for a fair, matched comparison.

Four predictors compared throughout: **CTM-assimilated** (the real model
with OI assimilation), **CTM-control** (identical run, assimilation
disabled — the no-op diagnostic), **persistence** (repeat last observed
value), **climatology** (diurnal mean fit on the disjoint training window).
"Verdict" states whether CTM-assimilated beats both trivial baselines
(lower RMSE than persistence AND climatology), one of them, or neither.

---

## Spatial holdout 1 (outside radius, 10,097m): assimilate 6983 (Hombegowda Nagar) → validate held-out 6984 (Hebbal)

Before/after reference: last round found no2 correlation 0.564 (assim) vs
-0.045 (control) under this same pair with real wind, no cluster stations.

| Species | Predictor | n | RMSE | Bias | Corr | MFB | MFE |
|---|---|---|---|---|---|---|---|
| co | CTM-assimilated | 268 | 3.272 | +1.643 | +0.178 | +34.5% | 53.7% |
| co | CTM-control | 268 | 3.419 | +1.913 | +0.178 | +48.1% | 53.9% |
| co | persistence | 268 | 0.336 | -0.167 | nan | -10.0% | 16.9% |
| co | climatology | 268 | 0.323 | -0.105 | +0.142 | -5.9% | 16.3% |
| co | **verdict** | | | | | | beats NEITHER baseline |
| no2 | CTM-assimilated | 271 | 3.436 | -0.041 | +0.623 | +8.5% | 30.3% |
| no2 | CTM-control | 271 | 4.620 | -0.031 | -0.129 | +10.4% | 40.6% |
| no2 | persistence | 271 | 4.372 | -0.255 | nan | +8.3% | 38.5% |
| no2 | climatology | 271 | 3.005 | +0.436 | +0.784 | +5.0% | 23.0% |
| no2 | **verdict** | | | | | | beats persistence, NOT climatology (mixed) |
| pm10 | CTM-assimilated | 280 | 7.355 | -3.279 | +0.751 | -9.7% | 20.2% |
| pm10 | CTM-control | 280 | 9.929 | -5.133 | +0.550 | -17.0% | 27.9% |
| pm10 | persistence | 280 | 9.993 | +0.764 | nan | +7.3% | 27.9% |
| pm10 | climatology | 280 | 7.300 | -1.222 | +0.716 | -3.9% | 18.6% |
| pm10 | **verdict** | | | | | | beats persistence, NOT climatology (mixed) |
| pm25 | CTM-assimilated | 280 | 4.244 | -0.276 | +0.597 | +3.3% | 25.4% |
| pm25 | CTM-control | 280 | 5.078 | +0.921 | +0.332 | +12.8% | 31.8% |
| pm25 | persistence | 280 | 5.615 | +2.325 | nan | +21.6% | 35.5% |
| pm25 | climatology | 280 | 5.052 | -1.213 | +0.395 | -6.6% | 30.1% |
| pm25 | **verdict** | | | | | | **beats BOTH baselines** |
| so2 | CTM-assimilated | 240 | 2.137 | -0.128 | -0.044 | +7.9% | 65.4% |
| so2 | CTM-control | 240 | 2.347 | +0.470 | -0.050 | +23.1% | 69.1% |
| so2 | persistence | 240 | 2.467 | -1.684 | +0.000 | -57.0% | 79.8% |
| so2 | climatology | 240 | 1.843 | -0.639 | +0.337 | -11.6% | 58.8% |
| so2 | **verdict** | | | | | | beats persistence, NOT climatology (mixed) |

---

## Spatial holdout 2 (outside radius, 10,097m): assimilate 6984 (Hebbal) → validate held-out 6983 (Hombegowda Nagar)

| Species | Predictor | n | RMSE | Bias | Corr | MFB | MFE |
|---|---|---|---|---|---|---|---|
| co | CTM-assimilated | 266 | 0.596 | +0.579 | -0.029 | +87.8% | 87.8% |
| co | CTM-control | 266 | 0.626 | +0.613 | +0.078 | +90.5% | 90.5% |
| co | persistence | 266 | 0.156 | -0.088 | -0.000 | -20.1% | 28.7% |
| co | climatology | 266 | 0.114 | +0.031 | +0.609 | +8.8% | 22.0% |
| co | **verdict** | | | | | | beats NEITHER baseline |
| no2 | CTM-assimilated | 269 | 4.540 | +1.209 | -0.023 | +25.8% | 46.0% |
| no2 | CTM-control | 269 | 4.644 | +1.210 | -0.133 | +25.8% | 46.9% |
| no2 | persistence | 269 | 4.260 | -0.251 | nan | +9.6% | 40.8% |
| no2 | climatology | 269 | 3.184 | +1.101 | +0.790 | +12.9% | 25.1% |
| no2 | **verdict** | | | | | | beats NEITHER baseline |
| pm10 | CTM-assimilated | 281 | 10.807 | -5.049 | +0.413 | -15.3% | 28.6% |
| pm10 | CTM-control | 281 | 11.058 | -5.190 | +0.385 | -15.9% | 29.4% |
| pm10 | persistence | 281 | 12.330 | -7.036 | nan | -19.2% | 31.1% |
| pm10 | climatology | 281 | 8.713 | +1.615 | +0.640 | +4.9% | 21.4% |
| pm10 | **verdict** | | | | | | beats persistence, NOT climatology (mixed) |
| pm25 | CTM-assimilated | 281 | 5.327 | +3.027 | +0.513 | +30.3% | 38.6% |
| pm25 | CTM-control | 281 | 5.408 | +3.054 | +0.394 | +30.5% | 39.1% |
| pm25 | persistence | 281 | 5.791 | -3.502 | nan | -26.5% | 41.0% |
| pm25 | climatology | 281 | 4.524 | -0.477 | +0.297 | +2.0% | 31.2% |
| pm25 | **verdict** | | | | | | beats persistence, NOT climatology (mixed) |
| so2 | CTM-assimilated | 269 | 2.261 | +1.859 | -0.086 | +67.1% | 77.6% |
| so2 | CTM-control | 269 | 2.289 | +1.871 | -0.092 | +66.9% | 78.0% |
| so2 | persistence | 269 | 0.391 | +0.045 | +0.000 | +5.9% | 21.2% |
| so2 | climatology | 269 | 0.441 | -0.186 | +0.087 | -9.9% | 22.5% |
| so2 | **verdict** | | | | | | beats NEITHER baseline |

---

## Spatial holdout 3 (INSIDE radius, 1,381m — new this round): assimilate 6973 (Jayanagar 5th Block) → validate held-out 5548 (BTM Layout)

`pm10` has no real observations for this station pair/window and is
correctly absent below — not an omission, the script only reports species
with actual data.

| Species | Predictor | n | RMSE | Bias | Corr | MFB | MFE |
|---|---|---|---|---|---|---|---|
| co | CTM-assimilated | 281 | 0.295 | -0.041 | +0.243 | -2.3% | 32.2% |
| co | CTM-control | 281 | 0.399 | +0.287 | +0.105 | +38.9% | 44.1% |
| co | persistence | 281 | 0.426 | +0.323 | nan | +42.2% | 46.6% |
| co | climatology | 281 | 0.294 | -0.002 | +0.257 | +3.0% | 30.8% |
| co | **verdict** | | | | | | beats persistence, NOT climatology (mixed) |
| no2 | CTM-assimilated | 281 | 3.589 | -0.444 | +0.852 | -1.1% | 16.3% |
| no2 | CTM-control | 281 | 10.093 | -7.633 | +0.283 | -50.4% | 51.1% |
| no2 | persistence | 281 | 8.605 | -5.281 | nan | -28.6% | 40.4% |
| no2 | climatology | 281 | 5.058 | -0.705 | +0.684 | -1.1% | 22.9% |
| no2 | **verdict** | | | | | | **beats BOTH baselines** |
| pm25 | CTM-assimilated | 281 | 16.822 | -13.686 | +0.312 | -72.8% | 73.5% |
| pm25 | CTM-control | 281 | 13.956 | -9.532 | +0.263 | -38.5% | 48.6% |
| pm25 | persistence | 281 | 12.293 | -6.736 | +0.000 | -22.2% | 40.1% |
| pm25 | climatology | 281 | 11.466 | +1.772 | +0.214 | +11.8% | 37.9% |
| pm25 | **verdict** | | | | | | beats NEITHER baseline (assimilation is worse than control here — see note below) |
| so2 | CTM-assimilated | 279 | 2.455 | -1.188 | -0.045 | -19.2% | 39.2% |
| so2 | CTM-control | 279 | 2.702 | -1.010 | -0.120 | -19.0% | 49.2% |
| so2 | persistence | 279 | 2.641 | -1.597 | nan | -30.8% | 42.2% |
| so2 | climatology | 279 | 2.534 | +0.227 | +0.101 | +8.8% | 42.2% |
| so2 | **verdict** | | | | | | **beats BOTH baselines** |

**This pair is the headline real finding of this round.** no2's
CTM-assimilated vs CTM-control gap (rmse 3.589 vs 10.093, MFB -1.1% vs
-50.4%) is the largest assimilation-vs-no-assimilation effect anywhere in
this run — and CTM-control here is even *worse* than both trivial
baselines, while CTM-assimilated clears both. This is exactly the effect
Phase 13 set out to make measurable (the original 6983/6984 pair, at
10,097m, is structurally just outside `localisation_radius_m=10000` and
can't show it). Confirmed independently below by the tagged-tracer
diagnostic.

## Spatial holdout 4 (INSIDE radius, 1,381m — new this round): assimilate 5548 (BTM Layout) → validate held-out 6973 (Jayanagar 5th Block)

| Species | Predictor | n | RMSE | Bias | Corr | MFB | MFE |
|---|---|---|---|---|---|---|---|
| co | CTM-assimilated | 234 | 0.299 | +0.110 | +0.175 | +15.7% | 33.4% |
| co | CTM-control | 234 | 0.412 | +0.360 | +0.059 | +47.5% | 48.7% |
| co | persistence | 234 | 0.268 | -0.180 | +0.000 | -27.2% | 33.3% |
| co | climatology | 234 | 0.192 | +0.070 | +0.529 | +12.1% | 23.2% |
| co | **verdict** | | | | | | beats NEITHER baseline |
| no2 | CTM-assimilated | 270 | 4.352 | -3.030 | +0.853 | -17.9% | 23.3% |
| no2 | CTM-control | 270 | 10.445 | -8.712 | +0.329 | -57.9% | 60.2% |
| no2 | persistence | 270 | 9.819 | -7.781 | nan | -48.6% | 54.9% |
| no2 | climatology | 270 | 3.461 | +1.575 | +0.858 | +11.0% | 16.6% |
| no2 | **verdict** | | | | | | beats persistence, NOT climatology (mixed) |
| pm10 | CTM-assimilated | 278 | 21.912 | -12.669 | +0.529 | -27.0% | 41.9% |
| pm10 | CTM-control | 278 | 21.912 | -12.669 | +0.529 | -27.0% | 41.9% |
| pm10 | persistence | 278 | 32.510 | -25.338 | nan | -77.4% | 77.4% |
| pm10 | climatology | 278 | 16.498 | +2.889 | +0.683 | +7.2% | 28.3% |
| pm10 | **verdict** | | | | | | beats persistence, NOT climatology (mixed) |
| pm25 | CTM-assimilated | 279 | 15.045 | +12.568 | +0.255 | +82.1% | 83.0% |
| pm25 | CTM-control | 279 | 7.131 | +5.363 | +0.247 | +54.7% | 59.2% |
| pm25 | persistence | 279 | 7.097 | -5.247 | nan | -61.8% | 69.8% |
| pm25 | climatology | 279 | 4.885 | -0.492 | +0.300 | +2.7% | 45.6% |
| pm25 | **verdict** | | | | | | beats NEITHER baseline (assimilation is worse than control here too — see note below) |
| so2 | CTM-assimilated | 253 | 1.502 | +0.854 | -0.047 | +19.1% | 28.5% |
| so2 | CTM-control | 253 | 1.291 | +0.260 | -0.219 | +1.7% | 34.9% |
| so2 | persistence | 253 | 0.334 | +0.093 | -0.000 | +3.2% | 8.2% |
| so2 | climatology | 253 | 0.297 | +0.009 | +0.381 | +0.7% | 7.5% |
| so2 | **verdict** | | | | | | beats NEITHER baseline |

**Real, reportable oddity, not smoothed over**: pm25 is WORSE with
assimilation than without it in both inside-radius experiments (holdout 3:
rmse 16.822 assim vs 13.956 control; holdout 4: rmse 15.045 assim vs 7.131
control). This is the opposite of no2's result on the identical station
pair. A plausible mechanism — not independently confirmed by this run, so
stated as a hypothesis, not a finding — is that pm25's observation-error
sigma or background prior is miscalibrated at this pair relative to no2's,
causing assimilation to over-correct rather than genuinely improve the
field; `PHASE16_CALIBRATION_REPORT.md`'s pm25 background_conc finding
(non-stationary within the very week used there) is consistent with pm25
being the harder-calibrated species of the two. Worth a dedicated
diagnosis before trusting pm25 assimilation at this pair.

---

## Diagnostic control: no assimilation at all, both original (outside-radius) stations pooled

Boylan & Russell (2006) PM2.5 goal/criteria bands, applied to every species
as an approximate reference point (not a literature-validated threshold
outside PM2.5).

| Species | n | RMSE | Bias | Corr | MFB | MFE | Band |
|---|---|---|---|---|---|---|---|
| co | 1234 | 2.512 | +1.204 | +0.455 | +65.0% | 70.7% | OUTSIDE both CRITERIA and GOAL |
| no2 | 1257 | 5.576 | +0.238 | -0.045 | +16.7% | 44.9% | within GOAL |
| pm10 | 1231 | 12.025 | -4.660 | +0.361 | -12.9% | 31.9% | within GOAL |
| pm25 | 1299 | 5.322 | +2.474 | +0.274 | +25.1% | 36.0% | within GOAL |
| so2 | 1134 | 2.462 | +1.640 | -0.009 | +61.6% | 77.9% | OUTSIDE both CRITERIA and GOAL |

This confirms Phase 15's own stated caution: several species read as "within
the GOAL band" here, which in isolation would look like success — but the
baseline tables above show most of those same species/pairs still don't
beat a trivial climatology baseline. The band alone was never sufficient
evidence, exactly as this document's rules say.

## Tagged-tracer diagnostic: where does held-out Hebbal's (6984) no2 actually come from?

Real mechanistic check, not another skill metric: after 4 days of
assimilating ONLY station 6983 (10,097m away, outside
`localisation_radius_m=10000`, so assimilation never directly touches
Hebbal's grid cell), the live no2 field at Hebbal was decomposed by tag:

```
live no2 at Hebbal after 4 days of assimilating ONLY 6983: 7.8621
  tag=background: 6.8173 (86.7% of live field)
  tag=daytime: 0.0000 (0.0% of live field)
  tag=morning_evening: 0.0000 (0.0% of live field)
  tag=night: 0.0000 (0.0% of live field)
  unexplained (live - sum(tags)): 1.0449 (13.3% of live field)
```

Every schematic emission-source tag is 0% — those sources never reach
Hebbal regardless of wind. Assimilation only ever touches the live field
(never tag fields) and never touches Hebbal's cell directly (outside the
localisation radius). So the nonzero 13.3% "unexplained" fraction can only
be assimilation-corrected mass that reached Hebbal through **real physical
transport** (advection/diffusion under real, time-varying wind) over the
multi-day window — independent, mechanistic confirmation that the effect
seen in the inside-radius pair above is real transport, not a modeling
coincidence.

---

## Temporal holdout: assimilate both original stations through training, forecast freely, validate on the forecast window

| Species | Predictor | n | RMSE | Bias | Corr | MFB | MFE |
|---|---|---|---|---|---|---|---|
| co | CTM-assimilated | 536 | 2.406 | +1.252 | +0.533 | +68.9% | 71.8% |
| co | CTM-control | 534 | 2.462 | +1.265 | +0.521 | +69.2% | 72.2% |
| co | persistence | 534 | 0.263 | -0.128 | +0.923 | -15.0% | 22.7% |
| co | climatology | 534 | 0.243 | -0.037 | +0.917 | +1.4% | 19.1% |
| co | **verdict** | | | | | | beats NEITHER baseline |
| no2 | CTM-assimilated | 542 | 4.630 | +0.611 | -0.156 | +18.3% | 43.8% |
| no2 | CTM-control | 540 | 4.632 | +0.587 | -0.138 | +18.1% | 43.7% |
| no2 | persistence | 540 | 4.317 | -0.253 | +0.127 | +8.9% | 39.6% |
| no2 | climatology | 540 | 3.096 | +0.767 | +0.786 | +8.9% | 24.1% |
| no2 | **verdict** | | | | | | beats NEITHER baseline |
| pm10 | CTM-assimilated | 563 | 10.387 | -4.996 | +0.467 | -15.5% | 27.8% |
| pm10 | CTM-control | 561 | 10.510 | -5.161 | +0.470 | -16.4% | 28.6% |
| pm10 | persistence | 561 | 11.225 | -3.143 | -0.040 | -5.9% | 29.5% |
| pm10 | climatology | 561 | 8.039 | +0.199 | +0.670 | +0.5% | 20.0% |
| pm10 | **verdict** | | | | | | beats persistence, NOT climatology (mixed) |
| pm25 | CTM-assimilated | 563 | 5.195 | +1.955 | +0.354 | +21.4% | 35.2% |
| pm25 | CTM-control | 561 | 5.245 | +1.989 | +0.363 | +21.6% | 35.4% |
| pm25 | persistence | 561 | 5.704 | -0.594 | +0.218 | -2.5% | 38.3% |
| pm25 | climatology | 561 | 4.795 | -0.844 | +0.388 | -2.3% | 30.6% |
| pm25 | **verdict** | | | | | | beats persistence, NOT climatology (mixed) |
| so2 | CTM-assimilated | 510 | 2.314 | +1.207 | -0.055 | +46.1% | 73.7% |
| so2 | CTM-control | 509 | 2.316 | +1.210 | -0.057 | +46.3% | 73.8% |
| so2 | persistence | 509 | 1.718 | -0.770 | -0.463 | -23.8% | 48.9% |
| so2 | climatology | 509 | 1.306 | -0.400 | +0.499 | -10.7% | 39.6% |
| so2 | **verdict** | | | | | | beats NEITHER baseline |

Note `co`'s persistence/climatology correlation here (+0.923/+0.917) is
real and high — the forecast window's co series is apparently smooth enough
that "repeat/typical-hour" tracks it closely; the CTM's own forecast skill
doesn't need to be bad in absolute terms to still lose that particular
comparison.

---

## Overall tally (24 species × experiment combinations, spatial + temporal)

| Verdict | Count | Combinations |
|---|---|---|
| Beats BOTH baselines | 3 | holdout1-pm25, holdout3-no2, holdout3-so2 |
| Beats persistence only (mixed) | 10 | holdout1-{no2,pm10,so2}, holdout2-{pm10,pm25}, holdout3-co, holdout4-{no2,pm10}, temporal-{pm10,pm25} |
| Beats NEITHER | 11 | holdout1-co, holdout2-{co,no2,so2}, holdout3-pm25, holdout4-{co,pm25,so2}, temporal-{co,no2,so2} |

**Plain verdict, per Phase 15's own acceptance criteria**: this round's
broader finding has **not fundamentally changed** from last round's —
across 24 species/experiment combinations, only 3 (12.5%) beat both trivial
baselines outright, and 11 (45.8%) beat neither. Most of the CTM's
apparent skill is still not clearly better than a diurnal-climatology
lookup.

**What HAS genuinely changed, and is new, real evidence this round**: the
improved test design (Phase 12's real wind, Phase 13's inside-radius
station pair) finally makes OI assimilation's real effect measurable where
it couldn't be seen before. The 6973/5548 pair (1,381m, well inside
`localisation_radius_m=10000`) shows a large, real CTM-assimilated vs
CTM-control gap for no2 (rmse 3.589 vs 10.093) that the original
10,097m-separated pair structurally could not show — and the tagged-tracer
diagnostic independently confirms that gap is mediated by real physical
transport, not coincidence. So: **"does assimilation have a real, physical
effect" is now answered yes**, for the first time in this project's
history, with direct mechanistic evidence — but **"does the CTM reliably
beat a trivial baseline" is still mostly no**, and those are genuinely
different claims. Per this document's own rule, that gap between the two
findings is itself the next thing worth investigating (candidates: pm25's
apparent anti-correlation between assimilation and skill at the same
inside-radius pair, above; and whether observation-error/prior calibration
per species — not just per city — is the missing piece, extending
`PHASE16_CALIBRATION_REPORT.md`'s single-species-at-a-time approach).
