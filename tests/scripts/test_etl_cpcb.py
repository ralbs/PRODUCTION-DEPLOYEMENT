"""Tests for scripts/etl_cpcb.py against the REAL raw CPCB/OpenAQ export
committed under data/raw/openaq_bangalore/ (two real Bangalore stations,
6983 Hombegowda Nagar and 6984 Hebbal, 2019-07-10 to 2019-07-16, pulled
from OpenAQ's public data archive -- see the module docstring for the
confirmed raw schema and the real per-station CO unit inconsistency this
ETL disambiguates)."""
from pathlib import Path

import numpy as np
import pytest

from cities.loader import load_city
from scripts.etl_cpcb import _collect_input_files, _convert_value, etl

RAW_DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "raw" / "openaq_bangalore"


def test_etl_on_real_data_drops_untracked_species_and_rejects_nothing_nonfinite():
    city = load_city("bangalore")
    input_files = _collect_input_files(RAW_DATA_DIR)
    assert len(input_files) == 14  # 2 stations x 7 days

    records, counts = etl(input_files, city)

    print(f"\n[etl real data] counts={counts}")
    assert counts["n_raw_rows"] == 7409
    assert counts["n_rejected_nonfinite"] == 0  # real data verified clean
    assert counts["n_rejected_unit_conversion_error"] == 0
    assert counts["n_converted"] == len(records) == 6155
    # o3 is the only parameter in the raw data bangalore.json doesn't track
    assert counts["n_species_not_tracked"] == counts["n_raw_rows"] - counts["n_converted"]
    assert set(r.species for r in records) == {"pm25", "pm10", "co", "no2", "so2"}
    assert set(r.station_id for r in records) == {"6983", "6984"}


def test_etl_co_disambiguation_produces_physically_consistent_scale_across_stations():
    """The two real stations claim the IDENTICAL 'µg/m³' unit label for co
    but encode it two different ways (verified empirically): station 6983's
    raw values are already mg/m³-scale (0.2-0.8ish) despite the label;
    station 6984's raw values are genuinely µg/m³-scale (700-2240ish) and
    need /1000. After conversion both must land in the SAME physically
    plausible mg/m³ range -- this is the actual regression test for a real
    data-quality issue this ETL had to handle, not a hypothetical one."""
    city = load_city("bangalore")
    input_files = _collect_input_files(RAW_DATA_DIR)
    records, _ = etl(input_files, city)

    co_6983 = [r.value for r in records if r.station_id == "6983" and r.species == "co"]
    co_6984 = [r.value for r in records if r.station_id == "6984" and r.species == "co"]
    print(f"\n[co disambiguation] 6983: n={len(co_6983)} range=[{min(co_6983):.2f}, {max(co_6983):.2f}] mg/m3")
    print(f"[co disambiguation] 6984: n={len(co_6984)} range=[{min(co_6984):.2f}, {max(co_6984):.2f}] mg/m3")

    assert len(co_6983) > 500 and len(co_6984) > 500
    # both stations' converted values must be in the same physically
    # plausible ambient CO range (mg/m3), not off by a factor of 1000
    for vals in (co_6983, co_6984):
        assert all(0.0 <= v <= 10.0 for v in vals)
    # and the two stations' typical levels must be within the same order
    # of magnitude of each other (they're 10km apart in the same city)
    assert 0.1 < (np.mean(co_6984) / np.mean(co_6983)) < 10.0


def test_convert_value_co_disambiguation_direct():
    """Direct unit test of the disambiguation threshold itself: a small
    raw value (already mg/m3-scale, mislabeled) passes through unchanged;
    a large raw value (genuinely µg/m3-scale, correctly following the
    label) gets divided by 1000."""
    assert _convert_value("co", "µg/m³", 0.5, "mg_m3") == pytest.approx(0.5)
    assert _convert_value("co", "µg/m³", 1500.0, "mg_m3") == pytest.approx(1.5)


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
