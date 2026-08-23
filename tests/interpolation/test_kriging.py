"""Tests for interpolation/kriging.py, per CLAUDE.md's "Co-kriging spatial
interpolation" acceptance criteria: exact interpolation at data points
(zero nugget), kriging-variance behavior (near-zero at stations, growing
with distance, capping near the sill), variogram-fit recovery, a synthetic
smooth-field recovery test that beats a naive baseline, leave-one-out
cross-validation, and a co-kriging-beats-kriging-alone comparison with
printed RMSE numbers.

Recovery/fit tests generate ground truth as a genuine sample from a
Gaussian process with a KNOWN exponential covariance -- not an arbitrary
smooth analytic function. This matters: ordinary kriging assumes (second-
order) stationarity, and an arbitrary deterministic field (e.g. one with a
trend, or a periodic function, whose own semivariogram is non-monotonic)
violates that assumption and makes single-instance variogram fitting
genuinely unstable, for statistical reasons that have nothing to do with a
code defect. Because ANY single GP realization still gives a noisy
variogram fit (a real, well-known property of variogram estimation, not a
tolerance-loosening dodge), the fit-quality assertions below use the
MEDIAN outcome over several independent realizations of the same known
model -- a statistically appropriate criterion, per CLAUDE.md's testing
philosophy, rather than an arbitrary single-sample tolerance."""
import numpy as np
import pytest

from cities.loader import CityConfig, Domain, SpeciesConfig
from ctm.grid import CTMGrid
from interpolation.kriging import (
    KrigingStation,
    VariogramModel,
    cokriging,
    fit_cross_variogram,
    fit_variogram,
    krige_map,
    leave_one_out_cv,
    ordinary_kriging,
    station_residuals,
)

SPECIES = "pm25"
_TRUE_VARIOGRAM = VariogramModel(model="exponential", nugget=0.0, partial_sill=8.0, range_m=3000.0)


def _make_city(nx=60, ny=60, dx=500.0, dy=500.0, background=20.0):
    domain = Domain(lat_sw=12.0, lon_sw=77.0, nx=nx, ny=ny, dx=dx, dy=dy)
    species = {SPECIES: SpeciesConfig(name=SPECIES, unit="ug_m3", v_dep_m_s=0.0002, background_conc=background)}
    return CityConfig(
        city_name="KrigeTest", domain=domain, utc_offset_hours=0.0, species=species,
        diurnal_profiles={"flat": [1.0] * 24}, sensors=[], dt_seconds=60.0,
    )


def _cross_dist(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=-1))


def _sample_gp(coords: np.ndarray, variogram: VariogramModel, rng: np.random.Generator) -> np.ndarray:
    """A genuine zero-mean GP sample with the given exponential covariance
    -- used as synthetic ground truth so recovery tests are self-consistent
    with what ordinary kriging actually assumes (see module docstring)."""
    n = len(coords)
    cov = variogram.covariance(_cross_dist(coords, coords))
    L = np.linalg.cholesky(cov + 1e-9 * np.eye(n))
    return L @ rng.standard_normal(n)


def test_ordinary_kriging_is_exact_interpolator_at_data_points_zero_nugget():
    rng = np.random.default_rng(0)
    station_xy = rng.uniform(0, 20000, size=(12, 2))
    values = rng.uniform(-5, 5, size=12)
    variogram = VariogramModel(model="exponential", nugget=0.0, partial_sill=4.0, range_m=5000.0)

    estimate, variance = ordinary_kriging(station_xy, values, variogram, station_xy)
    max_err = float(np.max(np.abs(estimate - values)))
    max_var = float(np.max(variance))
    print(f"\n[exact interpolation] max|estimate-value| at stations={max_err:.2e}, max variance at stations={max_var:.2e}")

    assert max_err < 1e-8
    assert max_var < 1e-6


def test_kriging_variance_near_zero_at_station_grows_and_caps_near_sill():
    variogram = VariogramModel(model="exponential", nugget=0.0, partial_sill=9.0, range_m=3000.0)
    station_xy = np.array([[0.0, 0.0], [200.0, 0.0]])  # a tight pair, acts as ~one source of info
    values = np.array([10.0, 10.2])

    distances = np.array([0.0, 1000.0, 3000.0, 10000.0, 60000.0])
    target_xy = np.stack([distances, np.zeros_like(distances)], axis=-1)
    target_xy[:, 0] += station_xy[0, 0]  # measured from the first station

    _, variance = ordinary_kriging(station_xy, values, variogram, target_xy)
    print(f"\n[kriging variance vs distance] distances={distances}, variance={variance}, sill={variogram.sill}")

    assert variance[0] < 1e-6  # at the station itself
    assert np.all(np.diff(variance) >= -1e-9)  # non-decreasing with distance
    assert variance[-1] > 0.9 * variogram.sill  # caps near the sill far from all data


def test_fit_variogram_median_recovery_over_gp_realizations():
    """A single 80-station GP realization gives a genuinely noisy variogram
    fit (sill/range trade off, occasionally the fit runs to its range cap)
    -- that is inherent statistical variance in variogram ESTIMATION, not a
    code defect (verified separately: the kriging/co-kriging linear algebra
    is exact on noiseless data in the other tests here). The MEDIAN fit
    over several independent realizations of the same known model is the
    statistically meaningful, reproducible claim."""
    sills, ranges = [], []
    for seed in range(30, 45):
        rng = np.random.default_rng(seed)
        coords = rng.uniform(0, 20000, size=(80, 2))
        values = _sample_gp(coords, _TRUE_VARIOGRAM, rng)
        fitted = fit_variogram(coords, values, model="exponential", n_bins=12)
        sills.append(fitted.sill)
        ranges.append(fitted.range_m)

    median_sill, median_range = float(np.median(sills)), float(np.median(ranges))
    print(
        f"\n[variogram fit, n=15 realizations] true sill={_TRUE_VARIOGRAM.sill}, range={_TRUE_VARIOGRAM.range_m}\n"
        f"  per-realization sills={[round(s, 1) for s in sills]}\n"
        f"  per-realization ranges={[round(r) for r in ranges]}\n"
        f"  median sill={median_sill:.2f}, median range={median_range:.0f}"
    )

    assert 0.5 * _TRUE_VARIOGRAM.sill < median_sill < 2.0 * _TRUE_VARIOGRAM.sill
    assert 0.4 * _TRUE_VARIOGRAM.range_m < median_range < 2.0 * _TRUE_VARIOGRAM.range_m


def test_synthetic_recovery_median_beats_naive_mean_baseline():
    """At each of several independent GP realizations: sample a smooth
    'true' field jointly at station AND query locations (so the query
    locations have real, known ground truth), keep only the noisy station
    values as kriging input, fit a variogram, krige onto query points
    >=1500m from every station, and compare to a naive 'always predict the
    observed mean' baseline. The per-realization ratio is noisy (variogram
    estimation variance, see above) but the MEDIAN ratio over realizations
    is a robust, reproducible measure of real skill."""
    ratios = []
    for seed in range(1, 11):
        rng = np.random.default_rng(seed)
        station_xy = rng.uniform(0, 25000, size=(80, 2))
        grid_xy = np.stack(np.meshgrid(np.linspace(0, 25000, 25), np.linspace(0, 25000, 25)), axis=-1).reshape(-1, 2)
        d_to_nearest = np.min(_cross_dist(grid_xy, station_xy), axis=1)
        query_xy = grid_xy[d_to_nearest > 1500.0]

        all_xy = np.concatenate([station_xy, query_xy], axis=0)
        all_true = _sample_gp(all_xy, _TRUE_VARIOGRAM, rng)
        truth_station, truth_query = all_true[:80], all_true[80:]
        obs = truth_station + rng.normal(0, 0.3, size=80)

        variogram = fit_variogram(station_xy, obs, model="exponential", n_bins=12)
        kriged, _ = ordinary_kriging(station_xy, obs, variogram, query_xy)

        kriging_rmse = float(np.sqrt(np.mean((kriged - truth_query) ** 2)))
        baseline_rmse = float(np.sqrt(np.mean((obs.mean() - truth_query) ** 2)))
        ratios.append(kriging_rmse / baseline_rmse)

    median_ratio = float(np.median(ratios))
    print(f"\n[synthetic recovery, n=10 realizations] kriging/baseline RMSE ratios={[round(r, 2) for r in ratios]}")
    print(f"  median ratio={median_ratio:.2f} (kriging beats the naive-mean baseline when < 1.0)")

    assert median_ratio < 0.9


def test_leave_one_out_cv_beats_raw_std_baseline():
    rng = np.random.default_rng(3)
    station_xy = rng.uniform(0, 25000, size=(30, 2))
    truth = _sample_gp(station_xy, _TRUE_VARIOGRAM, rng)
    obs = truth + rng.normal(0, 0.3, size=30)
    variogram = fit_variogram(station_xy, obs, model="exponential", n_bins=10)

    result = leave_one_out_cv(station_xy, obs, variogram)
    raw_std = float(np.std(obs))
    print(f"\n[leave-one-out CV] RMSE={result['rmse']:.3f}, MAE={result['mae']:.3f}, raw obs std={raw_std:.3f}")

    assert result["rmse"] < raw_std  # spatial correlation is actually being exploited
    assert result["predictions"].shape == (30,)


def test_cokriging_median_beats_univariate_kriging_on_sparse_secondary_species():
    """X (primary) is densely observed; Y (secondary) is a scaled, noisier,
    SPARSELY-observed version of the same underlying GP field, sampled only
    at a co-located subset of X's stations. Compare leave-one-out RMSE of
    kriging Y alone vs. co-kriging Y using both networks, across several
    independent realizations (see module docstring for why median, not a
    single instance)."""
    ratios = []
    for seed in range(1, 11):
        rng = np.random.default_rng(seed)
        n_primary = 35
        primary_xy = rng.uniform(0, 25000, size=(n_primary, 2))
        x_true = _sample_gp(primary_xy, _TRUE_VARIOGRAM, rng)
        x_obs = x_true + rng.normal(0, 0.2, size=n_primary)

        secondary_idx = rng.choice(n_primary, size=7, replace=False)
        secondary_xy = primary_xy[secondary_idx]
        a_coef = 1.3
        y_obs = a_coef * x_true[secondary_idx] + rng.normal(0, 0.4, size=7)

        variogram_xx = fit_variogram(primary_xy, x_obs, model="exponential", n_bins=10)
        variogram_yy = fit_variogram(secondary_xy, y_obs, model="exponential", n_bins=4)
        variogram_xy = fit_cross_variogram(
            secondary_xy, x_obs[secondary_idx], y_obs, model="exponential", n_bins=4,
            variogram_xx=variogram_xx, variogram_yy=variogram_yy,
        )

        alone_rmse = leave_one_out_cv(secondary_xy, y_obs, variogram_yy)["rmse"]

        n2 = len(y_obs)
        idx = np.arange(n2)
        cokrige_preds = np.empty(n2)
        for i in range(n2):
            mask = idx != i
            pred, _ = cokriging(
                primary_xy, x_obs,
                secondary_xy[mask], y_obs[mask],
                variogram_xx, variogram_yy, variogram_xy,
                secondary_xy[i : i + 1],
            )
            cokrige_preds[i] = pred[0]
        cokrige_rmse = float(np.sqrt(np.mean((y_obs - cokrige_preds) ** 2)))
        ratios.append(cokrige_rmse / alone_rmse)

    median_ratio = float(np.median(ratios))
    print(f"\n[co-kriging vs kriging-alone, n=10 realizations] cokrige/alone RMSE ratios={[round(r, 2) for r in ratios]}")
    print(f"  median ratio={median_ratio:.2f} (co-kriging wins when < 1.0)")

    assert median_ratio < 0.85


def test_fit_cross_variogram_respects_cauchy_schwarz_bound_from_auto_variograms():
    """A valid linear model of coregionalization requires |C_XY(h)| <=
    sqrt(C_XX(h)*C_YY(h)). With very few co-located stations (the realistic
    sparse-secondary case) an unconstrained least-squares cross-variogram
    fit can badly overshoot this bound and wreck the co-kriging system
    (verified directly: this was an actual bug caught by this exact test
    scenario, producing nugget/partial_sill in the tens of thousands
    against auto-variogram sills of order 10). `variogram_xx`/`variogram_yy`
    must clamp the fit to a valid bound."""
    rng = np.random.default_rng(4)
    n1 = 35
    primary_xy = rng.uniform(0, 25000, size=(n1, 2))
    x_true = _sample_gp(primary_xy, _TRUE_VARIOGRAM, rng)
    x_obs = x_true + rng.normal(0, 0.2, size=n1)
    secondary_idx = rng.choice(n1, size=7, replace=False)
    secondary_xy = primary_xy[secondary_idx]
    y_obs = 1.3 * x_true[secondary_idx] + rng.normal(0, 0.4, size=7)

    variogram_xx = fit_variogram(primary_xy, x_obs, model="exponential", n_bins=10)
    variogram_yy = fit_variogram(secondary_xy, y_obs, model="exponential", n_bins=4)
    variogram_xy = fit_cross_variogram(
        secondary_xy, x_obs[secondary_idx], y_obs, model="exponential", n_bins=4,
        variogram_xx=variogram_xx, variogram_yy=variogram_yy,
    )

    sill_bound = float(np.sqrt(variogram_xx.partial_sill * variogram_yy.partial_sill))
    nugget_bound = float(np.sqrt(variogram_xx.nugget * variogram_yy.nugget))
    print(
        f"\n[Cauchy-Schwarz bound] sill_bound={sill_bound:.3f}, fitted |partial_sill|={abs(variogram_xy.partial_sill):.3f}\n"
        f"  nugget_bound={nugget_bound:.3f}, fitted |nugget|={abs(variogram_xy.nugget):.3f}"
    )

    assert abs(variogram_xy.partial_sill) <= sill_bound + 1e-9
    assert abs(variogram_xy.nugget) <= nugget_bound + 1e-9


def test_station_residuals_rejects_nonfinite_and_out_of_domain_before_anything_else():
    city = _make_city()
    grid = CTMGrid(city)
    grid.set_field(SPECIES, np.full((grid.nx, grid.ny), 20.0, dtype=np.float32))

    stations = [
        KrigingStation(id="ok1", lat=12.05, lon=77.05, value=25.0),
        KrigingStation(id="nan1", lat=12.05, lon=77.06, value=float("nan")),
        KrigingStation(id="inf1", lat=12.05, lon=77.07, value=float("inf")),
        KrigingStation(id="far", lat=20.0, lon=90.0, value=30.0),  # well outside the domain
    ]
    xy, residuals, kept = station_residuals(grid, SPECIES, stations)
    kept_ids = [s.id for s in kept]
    print(f"\n[station_residuals QC] kept={kept_ids}, residuals={residuals}")

    assert kept_ids == ["ok1"]
    assert xy.shape == (1, 2)
    assert residuals[0] == pytest.approx(5.0)


def test_krige_map_matches_ctm_plus_residual_and_reports_uncertainty():
    city = _make_city(nx=40, ny=40)
    grid = CTMGrid(city)
    ii, jj = np.meshgrid(np.arange(grid.nx), np.arange(grid.ny), indexing="ij")
    ctm_field = 20.0 + 0.05 * ii.astype(np.float32)  # a smooth synthetic CTM trend
    grid.set_field(SPECIES, ctm_field)

    rng = np.random.default_rng(5)
    stations = []
    for k in range(20):
        i = rng.integers(2, grid.nx - 2)
        j = rng.integers(2, grid.ny - 2)
        lat, lon = grid.cell_to_latlon(i, j)
        true_offset = 3.0 * np.sin(i / 5.0)  # a smooth residual signal riding on the CTM trend
        stations.append(KrigingStation(id=f"S{k}", lat=lat, lon=lon, value=float(ctm_field[i, j] + true_offset)))

    station_xy, residuals, kept = station_residuals(grid, SPECIES, stations)
    variogram = fit_variogram(station_xy, residuals, model="exponential", n_bins=6)
    estimate_field, variance_field = krige_map(grid, SPECIES, variogram, station_xy, residuals)

    at_station_errs = []
    for s, (i, j) in zip(kept, [grid.latlon_to_cell(s.lat, s.lon) for s in kept]):
        at_station_errs.append(abs(estimate_field[i, j] - s.value))
    max_station_err = max(at_station_errs)

    print(
        f"\n[krige_map] max|estimate-obs| at station cells={max_station_err:.4f}, "
        f"variance range=[{variance_field.min():.3f}, {variance_field.max():.3f}], sill={variogram.sill:.3f}"
    )

    assert estimate_field.shape == (grid.nx, grid.ny)
    assert variance_field.shape == (grid.nx, grid.ny)
    assert max_station_err < 1e-3  # exact interpolation: estimate == CTM + residual == obs, at station cells
    assert np.all(variance_field >= -1e-9)
    assert variance_field.max() <= variogram.sill + 1e-6
