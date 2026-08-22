"""met/weather_station.py — IDW interpolation of sparse station wind/temp/
RH to the grid, Pasquill-Gifford stability classification, and K_h /
mixing-height diagnostics.

See CLAUDE.md, "Meteorology":
- Non-finite station readings must be dropped BEFORE IDW, not after.
- An empty/all-invalid station list falls back to a per-city climatology
  default (`CityConfig.climatology`), and this fallback must still RETURN
  the full diagnostics dict (`K_h`, `mixing_height_m`, etc.) -- never
  `None`.
- Wind FROM-direction conversion must be reversible:
  `dir_from = (180 + atan2(u, v)) % 360`, round-trip
  `u = -speed*sin(dir), v = -speed*cos(dir)`. A previous version used
  `180 - atan2(u, v)`, which mirrors the east-west (u) component -- verify
  round-trip exactness for several quadrants explicitly.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from cities.loader import ClimatologyConfig
from ctm.grid import CTMGrid

_STABILITY_K_H_M2_S = {"A": 150.0, "B": 100.0, "C": 50.0, "D": 20.0, "E": 8.0, "F": 3.0}


@dataclass
class StationObservation:
    station_id: str
    lat: float
    lon: float
    wind_speed_m_s: float
    wind_dir_deg: float  # meteorological FROM-direction
    temp_c: float
    rh_pct: float


def wind_dir_from_uv(u, v):
    """Meteorological FROM-direction (degrees, 0=N/90=E/180=S/270=W) from
    u (eastward), v (northward) wind components (m/s). Round-trips exactly
    with uv_from_wind_dir -- see module docstring for the historical bug
    this formula fixes."""
    return (180.0 + np.degrees(np.arctan2(u, v))) % 360.0


def uv_from_wind_dir(speed, dir_from_deg):
    """Inverse of wind_dir_from_uv."""
    rad = np.radians(dir_from_deg)
    u = -speed * np.sin(rad)
    v = -speed * np.cos(rad)
    return u, v


def pasquill_gifford_class(wind_speed_m_s: float, hour_local: float) -> str:
    """Simplified Pasquill-Gifford stability class (A-F) from surface wind
    speed and a local-hour insolation proxy (day/night, with a solar-noon
    peak during the day)."""
    is_day = 6.0 <= hour_local < 18.0
    if is_day:
        solar_proxy = max(0.0, np.cos(np.pi * (hour_local - 12.0) / 12.0))
        if solar_proxy > 0.7:
            insolation = "strong"
        elif solar_proxy > 0.3:
            insolation = "moderate"
        else:
            insolation = "slight"

        if wind_speed_m_s < 2.0:
            table = {"strong": "A", "moderate": "A", "slight": "B"}
        elif wind_speed_m_s < 3.0:
            table = {"strong": "A", "moderate": "B", "slight": "C"}
        elif wind_speed_m_s < 5.0:
            table = {"strong": "B", "moderate": "B", "slight": "C"}
        elif wind_speed_m_s < 6.0:
            table = {"strong": "C", "moderate": "C", "slight": "D"}
        else:
            table = {"strong": "C", "moderate": "D", "slight": "D"}
        return table[insolation]

    return "F" if wind_speed_m_s < 3.0 else "E"


def k_h_for_class(stability_class: str) -> float:
    return _STABILITY_K_H_M2_S[stability_class]


def mixing_height_m(
    hour_local: float,
    wind_speed_m_s: float,
    sunrise_hour: float = 6.0,
    cap_m: float = 2000.0,
    day_growth_coeff: float = 500.0,
) -> float:
    """Day: grows with sqrt(hours since sunrise), capped ~2km. Night:
    shallow, 50 + 30*u10."""
    is_day = 6.0 <= hour_local < 18.0
    if is_day:
        t_since_sunrise = max(0.0, hour_local - sunrise_hour)
        return float(min(cap_m, day_growth_coeff * np.sqrt(t_since_sunrise)))
    return 50.0 + 30.0 * wind_speed_m_s


def _idw(grid_x, grid_y, station_x, station_y, values, power: float = 2.0, eps: float = 1.0):
    station_x = np.asarray(station_x, dtype=np.float64)
    station_y = np.asarray(station_y, dtype=np.float64)
    values = np.asarray(values, dtype=np.float64)

    dist = np.sqrt(
        (grid_x[..., None] - station_x) ** 2 + (grid_y[..., None] - station_y) ** 2
    )
    dist = np.maximum(dist, eps)
    weights = 1.0 / dist**power
    return (weights * values).sum(axis=-1) / weights.sum(axis=-1)


def _climatology_diagnostics(grid_shape: tuple[int, int], climatology: ClimatologyConfig, hour_local: float) -> dict:
    u0, v0 = uv_from_wind_dir(climatology.default_wind_speed_m_s, climatology.default_wind_dir_deg)
    stability_class = pasquill_gifford_class(climatology.default_wind_speed_m_s, hour_local)

    return {
        "u": np.full(grid_shape, u0, dtype=np.float64),
        "v": np.full(grid_shape, v0, dtype=np.float64),
        "wind_speed_m_s": np.full(grid_shape, climatology.default_wind_speed_m_s, dtype=np.float64),
        "wind_dir_from_deg": np.full(grid_shape, climatology.default_wind_dir_deg, dtype=np.float64),
        "temp_c": np.full(grid_shape, climatology.default_temp_c, dtype=np.float64),
        "rh_pct": np.full(grid_shape, climatology.default_rh_pct, dtype=np.float64),
        "stability_class": stability_class,
        "K_h": k_h_for_class(stability_class),
        "mixing_height_m": mixing_height_m(hour_local, climatology.default_wind_speed_m_s),
        "n_stations_used": 0,
        "fallback_to_climatology": True,
    }


def interpolate_met(
    stations: list[StationObservation],
    grid: CTMGrid,
    hour_local: float,
    climatology: ClimatologyConfig | None = None,
) -> dict:
    """IDW-interpolate sparse station wind/temp/RH onto `grid`'s cell
    centers, and compute Pasquill-Gifford stability class, K_h, and mixing
    height diagnostics for this step (indexed by LOCAL hour).

    Drops any station with a non-finite reading BEFORE interpolation
    (never after). If no valid stations remain, falls back to
    `climatology` (a per-city default from CityConfig) and still returns
    the full diagnostics dict -- never None.
    """
    if climatology is None:
        climatology = ClimatologyConfig()

    valid = [
        s
        for s in stations
        if np.isfinite(s.wind_speed_m_s)
        and np.isfinite(s.wind_dir_deg)
        and np.isfinite(s.temp_c)
        and np.isfinite(s.rh_pct)
    ]

    grid_shape = (grid.nx, grid.ny)
    if not valid:
        return _climatology_diagnostics(grid_shape, climatology, hour_local)

    station_x, station_y = [], []
    station_u, station_v = [], []
    station_speed, station_temp, station_rh = [], [], []
    for s in valid:
        x_m, y_m = grid.latlon_to_xy_m(s.lat, s.lon)
        u, v = uv_from_wind_dir(s.wind_speed_m_s, s.wind_dir_deg)
        station_x.append(x_m)
        station_y.append(y_m)
        station_u.append(u)
        station_v.append(v)
        station_speed.append(s.wind_speed_m_s)
        station_temp.append(s.temp_c)
        station_rh.append(s.rh_pct)

    ii, jj = np.meshgrid(np.arange(grid.nx), np.arange(grid.ny), indexing="ij")
    grid_x = (ii + 0.5) * grid.dx
    grid_y = (jj + 0.5) * grid.dy

    u_field = _idw(grid_x, grid_y, station_x, station_y, station_u)
    v_field = _idw(grid_x, grid_y, station_x, station_y, station_v)
    temp_field = _idw(grid_x, grid_y, station_x, station_y, station_temp)
    rh_field = _idw(grid_x, grid_y, station_x, station_y, station_rh)

    speed_field = np.sqrt(u_field**2 + v_field**2)
    dir_field = wind_dir_from_uv(u_field, v_field)

    mean_speed = float(np.mean(station_speed))
    stability_class = pasquill_gifford_class(mean_speed, hour_local)

    return {
        "u": u_field,
        "v": v_field,
        "wind_speed_m_s": speed_field,
        "wind_dir_from_deg": dir_field,
        "temp_c": temp_field,
        "rh_pct": rh_field,
        "stability_class": stability_class,
        "K_h": k_h_for_class(stability_class),
        "mixing_height_m": mixing_height_m(hour_local, mean_speed),
        "n_stations_used": len(valid),
        "fallback_to_climatology": False,
    }
