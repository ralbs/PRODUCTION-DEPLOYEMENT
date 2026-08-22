import json
import math
import tempfile
from pathlib import Path

import pytest

from cities.loader import CityConfig, CityConfigError, load_city

CITIES_DIR = Path(__file__).resolve().parents[2] / "cities"


@pytest.mark.parametrize("name", ["bangalore", "template"])
def test_example_configs_load_without_error(name):
    config = load_city(name)
    assert isinstance(config, CityConfig)
    assert config.city_name
    assert config.domain.nx > 0 and config.domain.ny > 0
    assert len(config.species) > 0
    assert len(config.diurnal_profiles) > 0


def test_load_by_explicit_path():
    config = load_city(CITIES_DIR / "bangalore.json")
    assert config.city_name == "Bangalore"


def test_bangalore_and_template_are_meaningfully_different():
    """The whole point of shipping two example cities is that the second
    one differs from Bangalore in every dimension the schema covers -- if
    it didn't, the abstraction could still secretly be Bangalore-only."""
    bangalore = load_city("bangalore")
    template = load_city("template")

    assert bangalore.domain.nx != template.domain.nx
    assert bangalore.domain.dx != template.domain.dx
    assert bangalore.utc_offset_hours != template.utc_offset_hours
    assert set(bangalore.species) != set(template.species)


def test_diurnal_profiles_normalised_to_mean_one():
    for name in ("bangalore", "template"):
        config = load_city(name)
        for profile_name, values in config.diurnal_profiles.items():
            mean = sum(values) / len(values)
            assert math.isclose(mean, 1.0, rel_tol=1e-9), (name, profile_name, mean)


def test_missing_required_field_raises_clear_error(tmp_path):
    broken = {
        "city_name": "Broken City",
        "domain": {"lat_sw": 0.0, "lon_sw": 0.0, "nx": 10, "ny": 10, "dx": 100.0, "dy": 100.0},
        # utc_offset_hours intentionally omitted
        "species": {
            "pm25": {"unit": "ug_m3", "v_dep_m_s": 0.001, "background_conc": 10.0}
        },
        "diurnal_profiles": {"flat": [1.0] * 24},
    }
    broken_path = tmp_path / "broken.json"
    broken_path.write_text(json.dumps(broken))

    with pytest.raises(CityConfigError, match="utc_offset_hours"):
        load_city(broken_path)


def test_invalid_json_raises_clear_error(tmp_path):
    bad_path = tmp_path / "not_json.json"
    bad_path.write_text("{ this is not valid json")

    with pytest.raises(CityConfigError, match="invalid JSON"):
        load_city(bad_path)


def test_unknown_city_raises_clear_error():
    with pytest.raises(CityConfigError, match="not found"):
        load_city("this_city_does_not_exist")


def test_emission_source_referencing_undeclared_species_rejected(tmp_path):
    config = {
        "city_name": "Bad Species Ref",
        "domain": {"lat_sw": 0.0, "lon_sw": 0.0, "nx": 10, "ny": 10, "dx": 100.0, "dy": 100.0},
        "utc_offset_hours": 0.0,
        "species": {"pm25": {"unit": "ug_m3", "v_dep_m_s": 0.001, "background_conc": 10.0}},
        "diurnal_profiles": {"flat": [1.0] * 24},
        "emission_sources": [
            {
                "name": "bad",
                "kind": "point",
                "lat": 0.0,
                "lon": 0.0,
                "profile": "flat",
                "rates": {"no2": 1.0},
            }
        ],
    }
    path = tmp_path / "bad_species_ref.json"
    path.write_text(json.dumps(config))
    with pytest.raises(CityConfigError, match="no2"):
        load_city(path)


def test_emission_source_referencing_unknown_profile_rejected(tmp_path):
    config = {
        "city_name": "Bad Profile Ref",
        "domain": {"lat_sw": 0.0, "lon_sw": 0.0, "nx": 10, "ny": 10, "dx": 100.0, "dy": 100.0},
        "utc_offset_hours": 0.0,
        "species": {"pm25": {"unit": "ug_m3", "v_dep_m_s": 0.001, "background_conc": 10.0}},
        "diurnal_profiles": {"flat": [1.0] * 24},
        "emission_sources": [
            {
                "name": "bad",
                "kind": "point",
                "lat": 0.0,
                "lon": 0.0,
                "profile": "nonexistent_profile",
                "rates": {"pm25": 1.0},
            }
        ],
    }
    path = tmp_path / "bad_profile_ref.json"
    path.write_text(json.dumps(config))
    with pytest.raises(CityConfigError, match="nonexistent_profile"):
        load_city(path)


def test_loader_has_no_bangalore_specific_assumptions():
    """Enforces CLAUDE.md's 'Multi-city from day one' rule directly against
    the loader source. CLAUDE.md names the exact anti-pattern that shipped
    before: `DOMAIN_LAT_SW = 12.834` / `IST = UTC+5.5` as Python constants,
    and city-name branching (e.g. `if city_name == "Bangalore"`). Mentioning
    "bangalore" in a docstring example is fine; hardcoding its coordinates
    or special-casing its name in logic is not.
    """
    import re

    import cities.loader as loader_module

    source = Path(loader_module.__file__).read_text()

    forbidden_constants = ["12.834", "77.470"]
    for token in forbidden_constants:
        assert token not in source, f"loader.py appears to hardcode coordinate {token!r}"

    assert not re.search(r'[=!]=\s*["\']bangalore', source, re.IGNORECASE), (
        "loader.py appears to special-case the city name 'bangalore' in a comparison"
    )


def test_loader_makes_no_geographic_bounds_assumption():
    """A config far outside Bangalore's domain (southern hemisphere,
    negative longitude, coarse resolution) must load exactly like any
    other -- proves the loader itself has no lat/lon range assumption
    beyond the schema's generic -90/90, -180/180 bounds."""
    config_dict = {
        "city_name": "Nowhere In Particular",
        "domain": {"lat_sw": -33.9, "lon_sw": 18.4, "nx": 8, "ny": 8, "dx": 2000.0, "dy": 2000.0},
        "utc_offset_hours": 2.0,
        "species": {"o3": {"unit": "ug_m3", "v_dep_m_s": 0.005, "background_conc": 40.0}},
        "diurnal_profiles": {"flat": [1.0] * 24},
    }
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "elsewhere.json"
        path.write_text(json.dumps(config_dict))
        config = load_city(path)
        assert config.domain.lat_sw == -33.9
        assert config.domain.lon_sw == 18.4
