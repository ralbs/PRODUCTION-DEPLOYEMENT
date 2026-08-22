"""Loads and validates per-city configuration JSON (see cities/schema.json).

Every city-specific number (domain bounds, UTC offset, species list,
emission inventory, sensor network) lives in a `cities/<name>.json` file,
never as a Python constant here. See CLAUDE.md, "Multi-city from day one".
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import jsonschema

_SCHEMA_PATH = Path(__file__).resolve().parent / "schema.json"
_CITIES_DIR = Path(__file__).resolve().parent


class CityConfigError(ValueError):
    """Raised when a city config file is missing, malformed, or fails schema validation."""


@dataclass(frozen=True)
class Domain:
    lat_sw: float
    lon_sw: float
    nx: int
    ny: int
    dx: float
    dy: float


@dataclass(frozen=True)
class SpeciesConfig:
    name: str
    unit: str
    v_dep_m_s: float
    background_conc: float
    clim_max: float | None = None
    notes: str | None = None


@dataclass(frozen=True)
class EmissionSource:
    name: str
    kind: str
    profile: str
    rates: dict[str, float]
    lat: float | None = None
    lon: float | None = None
    lat_sw: float | None = None
    lon_sw: float | None = None
    lat_ne: float | None = None
    lon_ne: float | None = None


@dataclass(frozen=True)
class Sensor:
    id: str
    lat: float
    lon: float
    type: str
    species_error_sigma: dict[str, float]


@dataclass(frozen=True)
class AssimilationConfig:
    bg_error_fraction: float = 0.30
    correlation_length_m: float = 5000.0
    localisation_radius_m: float = 10000.0


@dataclass(frozen=True)
class ClimatologyConfig:
    """Per-city fallback met defaults, used when no valid weather station
    reading is available (see met/weather_station.py). Deliberately calm/
    neutral defaults unless a city overrides them."""

    default_wind_speed_m_s: float = 1.0
    default_wind_dir_deg: float = 0.0
    default_temp_c: float = 25.0
    default_rh_pct: float = 60.0


@dataclass(frozen=True)
class CityConfig:
    city_name: str
    domain: Domain
    utc_offset_hours: float
    species: dict[str, SpeciesConfig]
    diurnal_profiles: dict[str, list[float]]
    emission_sources: list[EmissionSource] = field(default_factory=list)
    sensors: list[Sensor] = field(default_factory=list)
    assimilation: AssimilationConfig = field(default_factory=AssimilationConfig)
    climatology: ClimatologyConfig = field(default_factory=ClimatologyConfig)
    dt_seconds: float = 60.0
    wind_history_hours: float = 24.0
    source_path: Path | None = None


def _load_schema() -> dict[str, Any]:
    with open(_SCHEMA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _resolve_path(name_or_path: str | Path) -> Path:
    """Resolve a bare city name (looked up in this directory) or an explicit path."""
    p = Path(name_or_path)
    if p.exists():
        return p
    filename = p.name if p.suffix == ".json" else f"{p.name}.json"
    candidate = _CITIES_DIR / filename
    if candidate.exists():
        return candidate
    raise CityConfigError(
        f"City config not found: {name_or_path!r} (checked {p} and {candidate})"
    )


def _format_validation_errors(path: Path, errors: list[jsonschema.ValidationError]) -> str:
    lines = []
    for err in errors:
        loc = "/".join(str(p) for p in err.absolute_path) or "<root>"
        lines.append(f"  - {loc}: {err.message}")
    return f"{path}: city config failed schema validation:\n" + "\n".join(lines)


def load_city(name_or_path: str | Path) -> CityConfig:
    """Load and validate a city config, returning a fully-typed CityConfig.

    `name_or_path` may be a bare city name (e.g. "bangalore", resolved to
    cities/bangalore.json) or an explicit path to any config JSON file.
    Raises CityConfigError on any missing file, invalid JSON, schema
    validation failure, or cross-reference error (e.g. an emission source
    naming an undeclared species or diurnal profile).
    """
    path = _resolve_path(name_or_path)

    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except json.JSONDecodeError as e:
        raise CityConfigError(f"{path}: invalid JSON — {e}") from e

    schema = _load_schema()
    validator_cls = jsonschema.validators.validator_for(schema)
    validator_cls.check_schema(schema)
    validator = validator_cls(schema)
    errors = sorted(
        validator.iter_errors(raw), key=lambda e: [str(p) for p in e.absolute_path]
    )
    if errors:
        raise CityConfigError(_format_validation_errors(path, errors))

    domain = Domain(**raw["domain"])

    species: dict[str, SpeciesConfig] = {}
    for sp_name, sp in raw["species"].items():
        species[sp_name] = SpeciesConfig(
            name=sp_name,
            unit=sp["unit"],
            v_dep_m_s=sp["v_dep_m_s"],
            background_conc=sp["background_conc"],
            clim_max=sp.get("clim_max"),
            notes=sp.get("notes"),
        )

    diurnal_profiles: dict[str, list[float]] = {}
    for prof_name, values in raw["diurnal_profiles"].items():
        mean = sum(values) / len(values)
        if mean <= 0:
            raise CityConfigError(
                f"{path}: diurnal profile {prof_name!r} has non-positive mean "
                f"({mean}); cannot normalise to mean 1"
            )
        diurnal_profiles[prof_name] = [v / mean for v in values]

    emission_sources: list[EmissionSource] = []
    for src in raw.get("emission_sources", []):
        profile_ref = src["profile"]
        if profile_ref not in diurnal_profiles:
            raise CityConfigError(
                f"{path}: emission source {src['name']!r} references unknown "
                f"diurnal profile {profile_ref!r}"
            )
        for sp_name in src["rates"]:
            if sp_name not in species:
                raise CityConfigError(
                    f"{path}: emission source {src['name']!r} has a rate for "
                    f"undeclared species {sp_name!r}"
                )
        emission_sources.append(
            EmissionSource(
                name=src["name"],
                kind=src["kind"],
                profile=profile_ref,
                rates=dict(src["rates"]),
                lat=src.get("lat"),
                lon=src.get("lon"),
                lat_sw=src.get("lat_sw"),
                lon_sw=src.get("lon_sw"),
                lat_ne=src.get("lat_ne"),
                lon_ne=src.get("lon_ne"),
            )
        )

    sensors: list[Sensor] = []
    for sen in raw.get("sensors", []):
        for sp_name in sen["species_error_sigma"]:
            if sp_name not in species:
                raise CityConfigError(
                    f"{path}: sensor {sen['id']!r} declares obs error for "
                    f"undeclared species {sp_name!r}"
                )
        sensors.append(
            Sensor(
                id=sen["id"],
                lat=sen["lat"],
                lon=sen["lon"],
                type=sen["type"],
                species_error_sigma=dict(sen["species_error_sigma"]),
            )
        )

    assim_raw = raw.get("assimilation", {})
    assimilation = AssimilationConfig(
        bg_error_fraction=assim_raw.get("bg_error_fraction", 0.30),
        correlation_length_m=assim_raw.get("correlation_length_m", 5000.0),
        localisation_radius_m=assim_raw.get("localisation_radius_m", 10000.0),
    )

    clim_raw = raw.get("climatology", {})
    climatology = ClimatologyConfig(
        default_wind_speed_m_s=clim_raw.get("default_wind_speed_m_s", 1.0),
        default_wind_dir_deg=clim_raw.get("default_wind_dir_deg", 0.0),
        default_temp_c=clim_raw.get("default_temp_c", 25.0),
        default_rh_pct=clim_raw.get("default_rh_pct", 60.0),
    )

    return CityConfig(
        city_name=raw["city_name"],
        domain=domain,
        utc_offset_hours=raw["utc_offset_hours"],
        species=species,
        diurnal_profiles=diurnal_profiles,
        emission_sources=emission_sources,
        sensors=sensors,
        assimilation=assimilation,
        climatology=climatology,
        dt_seconds=raw.get("dt_seconds", 60.0),
        wind_history_hours=raw.get("wind_history_hours", 24.0),
        source_path=path,
    )
