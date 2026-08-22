import numpy as np
import pytest

from ctm.grid import CTMGrid

from ._testutils import make_city


def test_cell_latlon_roundtrip_corners_and_center():
    city = make_city(nx=40, ny=30, dx=500.0, dy=750.0)
    grid = CTMGrid(city)
    corners_and_center = [
        (0, 0),
        (grid.nx - 1, 0),
        (0, grid.ny - 1),
        (grid.nx - 1, grid.ny - 1),
        (grid.nx // 2, grid.ny // 2),
    ]
    for i, j in corners_and_center:
        lat, lon = grid.cell_to_latlon(i, j)
        i2, j2 = grid.latlon_to_cell(lat, lon)
        assert (i2, j2) == (i, j), f"round-trip failed at ({i},{j}) -> ({i2},{j2})"


def test_fields_are_c_contiguous_float32_shaped_from_config():
    city = make_city(nx=25, ny=17)
    grid = CTMGrid(city)
    for name in city.species:
        field = grid.get_field(name)
        assert field.shape == (city.domain.nx, city.domain.ny)
        assert field.dtype == np.float32
        assert field.flags["C_CONTIGUOUS"]


def test_initial_field_uses_background_from_config_not_hardcoded():
    # An arbitrary, non-"realistic" background value -- if the grid ever
    # silently substituted a hardcoded default, this would catch it.
    city = make_city(background=137.5)
    grid = CTMGrid(city)
    assert np.all(grid.get_field("test") == np.float32(137.5))


def test_set_field_clamps_negative_to_zero():
    city = make_city()
    grid = CTMGrid(city)
    bad = np.full((grid.nx, grid.ny), -5.0, dtype=np.float32)
    grid.set_field("test", bad)
    assert np.all(grid.get_field("test") >= 0)


def test_set_field_does_not_mutate_callers_array():
    city = make_city()
    grid = CTMGrid(city)
    original = np.full((grid.nx, grid.ny), -1.0, dtype=np.float32)
    caller_copy = original.copy()
    grid.set_field("test", original)
    assert np.array_equal(original, caller_copy)


def test_set_field_rejects_wrong_shape():
    city = make_city(nx=10, ny=10)
    grid = CTMGrid(city)
    wrong = np.zeros((5, 5), dtype=np.float32)
    with pytest.raises(ValueError):
        grid.set_field("test", wrong)
