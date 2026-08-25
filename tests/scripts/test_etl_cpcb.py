"""Tests for scripts/etl_cpcb.py against the REAL raw CPCB/OpenAQ export
committed under data/raw/openaq_bangalore/ (5 real Bangalore stations --
6983 Hombegowda Nagar, 6984 Hebbal, 6973 Jayanagar 5th Block, 5548 BTM
Layout, 6975 Silk Board -- 2019-07-10 to 2019-07-16, pulled from OpenAQ's
public data archive -- see the module docstring for the confirmed raw
schema and the real per-station CO unit inconsistency this ETL
disambiguates)."""
from pathlib import Path

import numpy as np
import pytest

from cities.loader import load_city
from scripts.etl_cpcb import _collect_input_files, _convert_value, determine_co_station_conventions, etl, read_raw_export

RAW_DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "raw" / "openaq_bangalore"
ALL_STATIONS = {"6983", "6984", "6973", "5548", "6975"}


def test_etl_on_real_data_drops_untracked_species_and_rejects_nothing_nonfinite():
    city = load_city("bangalore")
    input_files = _collect_input_files(RAW_DATA_DIR)
    assert len(input_files) == 34  # 7+7+7+6+7 days across 5 stations (5548 is missing 2019-07-10, a real gap)

    records, counts = etl(input_files, city)

    print(f"\n[etl real data] counts={counts}")
    assert counts["n_raw_rows"] == 16982
    assert counts["n_rejected_nonfinite"] == 0  # real data verified clean
    assert counts["n_rejected_unit_conversion_error"] == 0
    assert counts["n_converted"] == len(records) == 14041
    # o3 is the only parameter in the raw data bangalore.json doesn't track
    assert counts["n_species_not_tracked"] == counts["n_raw_rows"] - counts["n_converted"]
    assert set(r.species for r in records) == {"pm25", "pm10", "co", "no2", "so2"}
    assert set(r.station_id for r in records) == ALL_STATIONS


def test_etl_co_disambiguation_produces_physically_consistent_scale_across_all_stations():
    """All 5 real stations claim the IDENTICAL 'µg/m³' unit label for co,
    but encode it inconsistently (verified empirically): some stations'
    raw values are already mg/m³-scale despite the label, others are
    genuinely µg/m³-scale and need /1000. After conversion every station
    must land in the SAME physically plausible mg/m³ range -- this is the
    actual regression test for a real data-quality issue this ETL had to
    handle, not a hypothetical one."""
    city = load_city("bangalore")
    input_files = _collect_input_files(RAW_DATA_DIR)
    records, _ = etl(input_files, city)

    co_by_station = {}
    for sid in ALL_STATIONS:
        vals = [r.value for r in records if r.station_id == sid and r.species == "co"]
        assert len(vals) > 400, f"station {sid} has too few co readings to check"
        co_by_station[sid] = vals
        print(f"\n[co disambiguation] {sid}: n={len(vals)} range=[{min(vals):.3f}, {max(vals):.3f}] mg/m3")

    # every station's converted co values must be in the same physically
    # plausible ambient CO range (mg/m3), not off by a factor of 1000
    for sid, vals in co_by_station.items():
        assert all(0.0 <= v <= 10.0 for v in vals), f"station {sid} has implausible co values"

    # all 5 stations' typical (median) levels must be within a modest
    # factor of each other -- they're all within a few km of each other
    # in the same city on the same real days
    medians = {sid: float(np.median(vals)) for sid, vals in co_by_station.items()}
    print(f"[co disambiguation] medians: {medians}")
    assert max(medians.values()) / min(medians.values()) < 10.0


def test_per_station_co_convention_fixes_a_real_bug_found_in_station_5548():
    """Regression test for a REAL bug: an earlier version of this ETL
    disambiguated co PER VALUE (raw > 50 -> divide by 1000, else pass
    through). Station 5548 (BTM Layout) is genuinely µg/m3-scale overall
    (median in the hundreds), but its low-traffic-hour raw readings
    (0, 20, 40 -- genuinely clean-air µg/m3 CO) fell below the per-value
    threshold, so the OLD logic left them unscaled while correctly
    scaling the rest of the SAME station's SAME sensor's readings --
    producing an internally inconsistent conversion (a converted range of
    [0.00, 40.00] mg/m3 instead of the correct [0.000, 2.190] mg/m3).
    determine_co_station_conventions() decides ONCE per station from the
    median, fixing this."""
    input_files = _collect_input_files(RAW_DATA_DIR)
    raw_rows = read_raw_export(input_files)
    conventions = determine_co_station_conventions(raw_rows)
    print(f"\n[per-station co convention] {conventions}")

    # station 5548's raw co values span both sides of the old per-value
    # threshold (some readings are 0-40, most are in the hundreds) --
    # confirm the median-based decision correctly classifies it as
    # needing the /1000 scaling despite those low-end readings.
    assert conventions["5548"] is True

    city = load_city("bangalore")
    records, _ = etl(input_files, city)
    co_5548 = [r.value for r in records if r.station_id == "5548" and r.species == "co"]
    assert max(co_5548) < 10.0  # NOT 40.0 -- the bug this test guards against
    assert min(co_5548) < 0.1  # the low-traffic-hour readings ARE genuinely near zero, correctly scaled


def test_convert_value_co_requires_station_convention():
    """species='co' with no co_needs_scaling supplied must raise clearly,
    not silently guess."""
    with pytest.raises(ValueError, match="co_needs_scaling"):
        _convert_value("co", "µg/m³", 0.5, "mg_m3")


def test_convert_value_co_disambiguation_direct():
    assert _convert_value("co", "µg/m³", 0.5, "mg_m3", co_needs_scaling=False) == pytest.approx(0.5)
    assert _convert_value("co", "µg/m³", 1500.0, "mg_m3", co_needs_scaling=True) == pytest.approx(1.5)


def test_convert_value_standard_species_pass_through_ug_m3():
    assert _convert_value("pm25", "µg/m³", 42.0, "ug_m3") == pytest.approx(42.0)
    assert _convert_value("no2", "µg/m³", 10.0, "ug_m3") == pytest.approx(10.0)


def test_etl_rejects_nonfinite_with_the_same_np_isfinite_primitive(tmp_path):
    """Route non-finite values through the SAME rejection primitive used
    everywhere else in this project -- verified by poisoning a copy of one
    real raw file directly."""
    import csv
    import gzip

    city = load_city("bangalore")
    real_file = next(RAW_DATA_DIR.glob("6983/*.csv.gz"))
    with gzip.open(real_file, "rt", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    rows[0]["value"] = "nan"
    rows[1]["value"] = "inf"

    poisoned = tmp_path / "poisoned.csv"
    with open(poisoned, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    records, counts = etl([poisoned], city)
    print(f"\n[etl nonfinite QC] counts={counts}")
    assert counts["n_rejected_nonfinite"] == 2
    assert all(np.isfinite(r.value) for r in records)
