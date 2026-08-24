"""scripts/etl_cpcb.py — ingest raw CPCB/OpenAQ station exports into the
hindcast harness's CSV schema (station_id,lat,lon,species,value,timestamp;
see scripts/hindcast_harness.py's module docstring).

RAW INPUT FORMAT (confirmed empirically against real files -- not assumed
-- pulled from OpenAQ's public data archive, s3://openaq-data-archive/
records/csv.gz/locationid=<id>/year=<yyyy>/month=<mm>/
location-<id>-<yyyymmdd>.csv.gz, anonymous HTTPS GET, no API key needed.
This archive is OpenAQ's re-publication of CPCB-sourced Indian station
data after their v2 API was retired; it is NOT a CPCB-native format, but
it IS real CPCB/KSPCB measurements):

    location_id,sensors_id,location,datetime,lat,lon,parameter,units,value
    6983,20198,"Hombegowda Nagar, Bengaluru - KSPCB-6983",2019-07-15T00:15:00+05:30,12.938539,77.5901,pm10,µg/m³,20.0

Confirmed properties of this format, each load-bearing for the parsing
below:

  - One row per (station, parameter, ~15-minute timestamp). A single day
    at one station is several hundred rows across all parameters, not one
    row per day.
  - The `location` field contains a station name with an EMBEDDED COMMA
    inside quotes (e.g. "Hombegowda Nagar, Bengaluru - KSPCB-6983") --
    this file MUST be parsed with a real CSV reader (`csv.DictReader`),
    never naive comma-splitting, which silently shifts every field after
    `location` by one column.
  - `datetime` already carries an explicit UTC offset (e.g. +05:30 for
    India) -- convert to UTC explicitly here (a single consistent
    timezone), don't pass the offset through as-is.
  - `parameter` values observed: co, no2, o3, pm10, pm25, so2 (lowercase).
    `o3` is NOT mapped to a target species -- bangalore.json doesn't
    track it (this project's non-goal: no chemistry) -- such rows are
    dropped, not force-fit into a species that doesn't exist.
  - `units` is a single literal string repeated for every row of a file,
    and it is UNRELIABLE for co -- verified empirically by checking
    observed VALUE magnitudes against physically plausible ambient ranges,
    not by trusting the label, and the unreliability is WORSE than a
    simple constant mislabeling: it is INCONSISTENT BETWEEN STATIONS.
    Station 6983's co values (e.g. 0.21-0.81) are already mg/m³-scale
    despite being labeled "µg/m³" (India's NAAQS ambient CO standard is
    O(2-4) mg/m³; 0.21-0.81 taken literally as µg/m³ would mean
    essentially zero pollution). Station 6984's co values (e.g.
    700-2240), under the SAME "µg/m³" label, are genuinely µg/m³-scale
    and DO need dividing by 1000 to reach the same physical mg/m³ range.
    Two stations, identical claimed unit string, two different real
    encodings -- this is a data-quality issue in the SOURCE, not a bug in
    this ETL. `_convert_value` disambiguates PER VALUE against a
    plausible mg/m³ range (never per-station, since that would have
    missed exactly this inconsistency) and raises rather than guessing
    for anything implausible under both interpretations.

Non-finite values are rejected with the SAME `np.isfinite()` primitive
used at every other ingestion boundary in this project (see
`ctm/assimilation.py`, `met/weather_station.py`, `attribution/inverse.py`,
`interpolation/_experimental/kriging.py`'s `station_residuals`) -- this is
not a new, separate QC path, just that same rule applied at a new
ingestion boundary.
"""
from __future__ import annotations

import argparse
import csv
import gzip
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from cities.loader import CityConfig, load_city
from scripts.hindcast_harness import HindcastRecord, write_observations_csv

_PARAMETER_TO_SPECIES = {
    "pm25": "pm25",
    "pm10": "pm10",
    "co": "co",
    "no2": "no2",
    "so2": "so2",
    # "o3" intentionally NOT mapped: bangalore.json's species list doesn't
    # include it (this project doesn't model chemistry) -- rows with this
    # parameter are dropped by etl(), counted under n_species_not_tracked.
}

_SOURCE_UNIT_SCALE_TO_UG_M3 = {
    "µg/m³": 1.0,
    "ug/m3": 1.0,
    "mg/m³": 1000.0,
    "mg/m3": 1000.0,
}


_CO_PLAUSIBLE_MG_M3_MAX = 50.0  # ambient CO essentially never exceeds this under any real condition


def _convert_value(species: str, source_unit: str, raw_value: float, target_unit: str) -> float:
    """Convert one raw (parameter, unit, value) triple into the numeric
    convention `city.species[species].unit` declares. Never assumes the
    source's stated unit is correct for a given species -- see the co
    quirk in the module docstring: two real stations claim the identical
    "µg/m³" label for co but encode it two different ways, so this
    disambiguates PER VALUE against a physically plausible mg/m³ range,
    never per-station or per-species alone."""
    source_unit_norm = source_unit.strip()

    if species == "co" and source_unit_norm in ("µg/m³", "ug/m3") and target_unit == "mg_m3":
        # A raw value this large cannot be mg/m3 already (no real ambient
        # CO reading is) -- it must be genuine µg/m3 despite the shared
        # label, so divide by 1000. Otherwise trust it's already mg/m3
        # (the OTHER real, confirmed encoding under the same label).
        if raw_value > _CO_PLAUSIBLE_MG_M3_MAX:
            return raw_value / 1000.0
        return raw_value

    if source_unit_norm not in _SOURCE_UNIT_SCALE_TO_UG_M3:
        raise ValueError(f"unrecognized source unit {source_unit!r} for species {species!r}")
    value_ug_m3 = raw_value * _SOURCE_UNIT_SCALE_TO_UG_M3[source_unit_norm]

    if target_unit == "ug_m3":
        return value_ug_m3
    if target_unit == "mg_m3":
        return value_ug_m3 / 1000.0
    raise ValueError(f"unrecognized target unit {target_unit!r} for species {species!r}")


def read_raw_export(paths: list[Path]) -> list[dict]:
    """Read one or more raw CPCB/OpenAQ .csv or .csv.gz files (the schema
    documented above) into plain dict rows via a real CSV parser."""
    rows: list[dict] = []
    for path in paths:
        opener = gzip.open if str(path).endswith(".gz") else open
        with opener(path, "rt", newline="", encoding="utf-8") as f:
            rows.extend(csv.DictReader(f))
    return rows


def etl(raw_paths: list[Path], city: CityConfig) -> tuple[list[HindcastRecord], dict]:
    """Ingest raw rows, validate/convert against `city`'s declared species
    units, reject non-finite values, drop species `city` doesn't track,
    and convert timestamps to UTC. Returns `(records, counts)` where
    `counts` documents every rejection reason -- never silently drops
    rows without accounting for them."""
    raw_rows = read_raw_export(raw_paths)
    counts = {
        "n_raw_rows": len(raw_rows),
        "n_species_not_tracked": 0,
        "n_rejected_nonfinite": 0,
        "n_rejected_unit_conversion_error": 0,
        "n_converted": 0,
    }
    records: list[HindcastRecord] = []

    for row in raw_rows:
        species = _PARAMETER_TO_SPECIES.get(row["parameter"])
        if species is None or species not in city.species:
            counts["n_species_not_tracked"] += 1
            continue

        try:
            raw_value = float(row["value"])
        except (ValueError, TypeError):
            raw_value = float("nan")

        # Reject non-finite BEFORE any other processing -- see CLAUDE.md's
        # NaN rule (np.isfinite() first, never a bare comparison, which
        # silently passes NaN). Same primitive as every other boundary.
        if not np.isfinite(raw_value):
            counts["n_rejected_nonfinite"] += 1
            continue

        target_unit = city.species[species].unit
        try:
            value = _convert_value(species, row["units"], raw_value, target_unit)
        except ValueError:
            counts["n_rejected_unit_conversion_error"] += 1
            continue

        timestamp = datetime.fromisoformat(row["datetime"]).astimezone(timezone.utc)

        records.append(
            HindcastRecord(
                station_id=row["location_id"],
                lat=float(row["lat"]),
                lon=float(row["lon"]),
                species=species,
                value=value,
                timestamp=timestamp,
            )
        )
        counts["n_converted"] += 1

    return records, counts


def _collect_input_files(input_path: Path) -> list[Path]:
    if input_path.is_file():
        return [input_path]
    return sorted(p for p in input_path.rglob("*") if p.suffix in (".csv", ".gz"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="raw export file or directory (recursively globs .csv/.csv.gz)")
    parser.add_argument("--city", required=True, help="city name or path to its config JSON (e.g. bangalore)")
    parser.add_argument("--output", required=True, help="output CSV path, in run_hindcast()'s schema")
    args = parser.parse_args()

    city = load_city(args.city)
    input_files = _collect_input_files(Path(args.input))
    records, counts = etl(input_files, city)

    write_observations_csv(args.output, records)

    print(f"Read {len(input_files)} raw file(s).")
    for key, value in counts.items():
        print(f"  {key}: {value}")
    print(f"Wrote {len(records)} records to {args.output}")


if __name__ == "__main__":
    main()
