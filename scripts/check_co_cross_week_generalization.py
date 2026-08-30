"""scripts/check_co_cross_week_generalization.py -- checks whether the
Phase 16 Hosur Road Corridor co rate (fit on the disjoint 2019-07-17..23
week, see PHASE16_CALIBRATION_REPORT.md) also improves the fit on the
ORIGINAL Phase 15 week (2019-07-09..16) at Silk Board, applied AS-IS with
no re-fitting -- a generalization check, not a re-fit. The 2.0 old-rate
comparison point is bangalore.json's pre-Phase-16 default (see git history
/ PHASE16_CALIBRATION_REPORT.md for the exact prior value), reproduced
here explicitly rather than re-derived, since the live config now holds
the post-calibration rate."""
import copy

import numpy as np

from cities.loader import load_city
from ctm.simulator import Simulator
from met.ingest_real_met import RealMetSeries, load_real_met_series
from scripts.hindcast_harness import load_observations_csv, skill_metrics

SILK_BOARD = "6975"
SB_LAT, SB_LON = 12.917348, 77.622813
PRE_PHASE16_RATE = 2.0  # bangalore.json's Hosur Road Corridor co rate before Phase 16

city = load_city("bangalore")

records = load_observations_csv("data/processed/bangalore_openaq_20190710_20190716.csv")
timestamps = sorted(r.timestamp for r in records)
start_time = timestamps[0]
n_steps = int((timestamps[-1] - start_time).total_seconds() // city.dt_seconds) + 1
hour_utc0 = start_time.hour + start_time.minute / 60.0

met_series, _ = load_real_met_series(["data/raw/meteostat_bangalore/43295_201907.csv"])
met_stations = RealMetSeries(met_series, start_time, city.dt_seconds)

real_co = [r.value for r in records if r.station_id == SILK_BOARD and r.species == "co"]
print(f"real co @ Silk Board, Phase 15 week: n={len(real_co)} mean={np.mean(real_co):.4f}")


def run_with_rate(city, rate):
    city = copy.deepcopy(city)
    for src in city.emission_sources:
        if src.name == "Hosur Road Corridor":
            src.rates["co"] = rate
    sim = Simulator(city, hour_utc0=hour_utc0)
    i, j = sim.grid.latlon_to_cell(SB_LAT, SB_LON)
    series = []
    for t in range(n_steps):
        sim.step(met_stations(t), observations=None)
        series.append(float(sim.grid.get_field("co")[i, j]))
    return series


current_rate = next(s.rates["co"] for s in city.emission_sources if s.name == "Hosur Road Corridor")
for label, rate in ((f"OLD rate ({PRE_PHASE16_RATE})", PRE_PHASE16_RATE), (f"Phase 16 rate ({current_rate}, fit on the OTHER week)", current_rate)):
    series = run_with_rate(city, rate)
    preds, obs = [], []
    for r in records:
        if r.station_id != SILK_BOARD or r.species != "co":
            continue
        step = round((r.timestamp - start_time).total_seconds() / city.dt_seconds)
        if 0 <= step < len(series):
            preds.append(series[step])
            obs.append(r.value)
    m = skill_metrics(np.array(preds), np.array(obs))
    print(f"{label}: n={m['n']} rmse={m['rmse']:.4f} bias={m['bias']:+.4f} corr={m['correlation']:+.3f} mfb={m['mfb']*100:+.1f}% mfe={m['mfe']*100:.1f}%")
