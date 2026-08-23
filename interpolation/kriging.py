"""interpolation/kriging.py — co-kriging spatial interpolation.

See CLAUDE.md, "Co-kriging spatial interpolation". This is a DIFFERENT
layer from ctm/assimilation.py's Optimal Interpolation (OI) and must not
converge into the same code path:

- OI (`ctm/assimilation.py`): fast, IN-THE-LOOP nudge of the forecast state
  every timestep, using a SIMPLIFIED/FIXED Gaussian correlation model
  (correlation length taken straight from CityConfig). Cheap, runs every
  cycle, exists to keep the CTM's own forecast on track.
- Co-kriging (here): heavier, statistically RIGOROUS batch analysis, run
  less frequently (e.g. hourly), producing an uncertainty-quantified
  "published" concentration map. It FITS ITS OWN spatial correlation model
  (empirical semivariogram -> least-squares variogram fit) from recent
  station data rather than using a fixed one.

Design is regression kriging / kriging-with-external-drift (Hooyberghs et
al., Denby et al. -- standard air-quality-mapping practice):

    r(s) = obs(s) - CTM(s)                       # residual at each station
    estimate(cell) = CTM(cell) + kriged_residual(cell)

The CTM field supplies the large-scale physical trend (real emissions and
transport), so the residual is expected to be a much smoother, closer-to-
stationary field than raw concentration -- that is WHY kriging the residual
(not raw concentration) is the right design here, not an incidental choice.

Co-kriging proper (a sparse secondary species Y helped by a densely
observed correlated primary species X) requires the cross-semivariogram
between r_X and r_Y, which needs co-located (or paired) observations of
both variables -- `cokriging()` therefore requires `secondary_xy` to be a
documented subset of `primary_xy` locations. This is implemented as the
actual multivariate block-kriging system (auto- and cross-covariances,
separate unbiasedness constraints for both variables), never "krige twice
and average."

Isotropic (distance-only, not wind-aligned) semivariograms are used
throughout -- CLAUDE.md flags wind-aligned anisotropy as a documented v1
simplification, not required for a legitimate first version.

Same rules as everywhere else in this project: one unit convention per
species (residuals inherit the species' declared unit), and non-finite
station readings are rejected with `np.isfinite()` before anything else
(see `station_residuals`).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import least_squares

from ctm.grid import CTMGrid

_MODELS = ("exponential", "spherical", "gaussian")


def _pairwise_distances(coords: np.ndarray) -> np.ndarray:
    diff = coords[:, None, :] - coords[None, :, :]
    return np.sqrt((diff**2).sum(axis=-1))


def _cross_distances(coords_a: np.ndarray, coords_b: np.ndarray) -> np.ndarray:
    diff = coords_a[:, None, :] - coords_b[None, :, :]
    return np.sqrt((diff**2).sum(axis=-1))


@dataclass(frozen=True)
class VariogramModel:
    """A fitted (or hand-specified) semivariogram. `covariance(h)` follows
    the standard `sill - gamma(h)` convention, with `gamma(0)` exactly 0
    (not the nugget) so `covariance(0) == sill` -- the nugget is a
    discontinuity in gamma just above h=0, not a value AT h=0."""

    model: str
    nugget: float
    partial_sill: float
    range_m: float

    def __post_init__(self):
        if self.model not in _MODELS:
            raise ValueError(f"unknown variogram model {self.model!r}; must be one of {_MODELS}")
        if self.range_m <= 0:
            raise ValueError("range_m must be positive")

    @property
    def sill(self) -> float:
        return self.nugget + self.partial_sill

    def gamma(self, h) -> np.ndarray:
        h = np.asarray(h, dtype=np.float64)
        if self.model == "exponential":
            shape = 1.0 - np.exp(-h / self.range_m)
        elif self.model == "spherical":
            hn = np.minimum(h / self.range_m, 1.0)
            shape = 1.5 * hn - 0.5 * hn**3
        else:  # gaussian
            shape = 1.0 - np.exp(-((h / self.range_m) ** 2))
        g = self.nugget + self.partial_sill * shape
        return np.where(h <= 0.0, 0.0, g)

    def covariance(self, h) -> np.ndarray:
        return self.sill - self.gamma(h)


def empirical_semivariogram(coords, values, n_bins: int = 15, max_lag: float | None = None):
    """gamma(h) = 0.5 * mean[(r(s_i)-r(s_j))^2] over station pairs binned
    by separation distance h. Returns (lag_centers, gamma, pair_counts) for
    non-empty bins only."""
    coords = np.asarray(coords, dtype=np.float64)
    values = np.asarray(values, dtype=np.float64)
    n = len(values)
    if n < 2:
        raise ValueError("need at least 2 stations to compute a semivariogram")

    dist = _pairwise_distances(coords)
    iu, ju = np.triu_indices(n, k=1)
    h = dist[iu, ju]
    sq_diff = 0.5 * (values[iu] - values[ju]) ** 2
    return _bin_by_lag(h, sq_diff, n_bins, max_lag)


def empirical_cross_semivariogram(coords, values_x, values_y, n_bins: int = 15, max_lag: float | None = None):
    """Traditional cross-semivariogram gamma_XY(h) = 0.5 * mean[(X(s_i)-
    X(s_j)) * (Y(s_i)-Y(s_j))], requiring BOTH variables observed at every
    location in `coords` (co-located pairs -- see module docstring)."""
    coords = np.asarray(coords, dtype=np.float64)
    values_x = np.asarray(values_x, dtype=np.float64)
    values_y = np.asarray(values_y, dtype=np.float64)
    n = len(values_x)
    if n < 2:
        raise ValueError("need at least 2 co-located stations to compute a cross-semivariogram")
    if len(values_y) != n:
        raise ValueError("values_x and values_y must be co-located (same length)")

    dist = _pairwise_distances(coords)
    iu, ju = np.triu_indices(n, k=1)
    h = dist[iu, ju]
    cross = 0.5 * (values_x[iu] - values_x[ju]) * (values_y[iu] - values_y[ju])
    return _bin_by_lag(h, cross, n_bins, max_lag)


def _bin_by_lag(h, per_pair, n_bins, max_lag):
    if max_lag is None:
        max_lag = float(h.max())
    bin_edges = np.linspace(0.0, max_lag, n_bins + 1)
    bin_idx = np.digitize(h, bin_edges[1:-1])

    lags, gammas, counts = [], [], []
    for b in range(n_bins):
        mask = bin_idx == b
        if not np.any(mask):
            continue
        lags.append(float(h[mask].mean()))
        gammas.append(float(per_pair[mask].mean()))
        counts.append(int(mask.sum()))
    return np.array(lags), np.array(gammas), np.array(counts)


def _fit_shape(lags, gammas, counts, model, x0, bounds):
    weights = np.sqrt(counts)

    def resid(params):
        nugget, partial_sill, range_m = params
        vm = VariogramModel(model=model, nugget=nugget, partial_sill=partial_sill, range_m=max(range_m, 1e-6))
        return weights * (vm.gamma(lags) - gammas)

    result = least_squares(resid, x0=x0, bounds=bounds)
    nugget, partial_sill, range_m = result.x
    return VariogramModel(model=model, nugget=float(nugget), partial_sill=float(partial_sill), range_m=float(range_m))


def fit_variogram(coords, values, model: str = "exponential", n_bins: int = 15, max_lag: float | None = None) -> VariogramModel:
    """Least-squares fit of nugget/sill/range against the empirical
    semivariogram. Auto-variograms are constrained non-negative (a real
    variance can't be negative)."""
    lags, gammas, counts = empirical_semivariogram(coords, values, n_bins=n_bins, max_lag=max_lag)
    if len(lags) < 3:
        raise ValueError("not enough populated distance bins to fit a variogram (need >=3)")

    var = max(float(np.var(np.asarray(values, dtype=np.float64))), 1e-12)
    nugget0 = 0.1 * var
    range_cap = float(lags.max()) if lags.max() > 0 else 1.0  # a range beyond the sampled extent isn't identifiable
    range0 = range_cap / 3.0
    bounds = ([0.0, 0.0, 1e-3], [np.inf, np.inf, range_cap])
    return _fit_shape(lags, gammas, counts, model, x0=[nugget0, var - nugget0, range0], bounds=bounds)


def fit_cross_variogram(
    coords,
    values_x,
    values_y,
    model: str = "exponential",
    n_bins: int = 15,
    max_lag: float | None = None,
    variogram_xx: VariogramModel | None = None,
    variogram_yy: VariogramModel | None = None,
) -> VariogramModel:
    """Fit nugget/sill/range against the empirical cross-semivariogram.
    Unlike an auto-variogram, cross-semivariance CAN be negative (anti-
    correlated fields), so nugget/partial_sill are signed -- but a valid
    linear model of coregionalization still requires the Cauchy-Schwarz
    bound |C_XY(h)| <= sqrt(C_XX(h)*C_YY(h)). With few co-located stations
    (the usual sparse-secondary-species case) the unconstrained least-
    squares fit can badly overshoot that bound and produce an unusable
    (near-singular, wildly extrapolating) co-kriging system -- so when the
    already-fitted auto-variograms are supplied, clamp |nugget| and
    |partial_sill| to the Cauchy-Schwarz bound built from them."""
    lags, gammas, counts = empirical_cross_semivariogram(coords, values_x, values_y, n_bins=n_bins, max_lag=max_lag)
    if len(lags) < 3:
        raise ValueError("not enough populated distance bins to fit a cross-variogram (need >=3)")

    scale = max(abs(float(np.std(values_x)) * float(np.std(values_y))), 1e-12)
    range_cap = float(lags.max()) if lags.max() > 0 else 1.0
    range0 = range_cap / 3.0

    if variogram_xx is not None and variogram_yy is not None:
        nugget_bound = np.sqrt(max(variogram_xx.nugget, 0.0) * max(variogram_yy.nugget, 0.0))
        sill_bound = np.sqrt(max(variogram_xx.partial_sill, 1e-12) * max(variogram_yy.partial_sill, 1e-12))
    else:
        nugget_bound = np.inf
        sill_bound = np.inf

    bounds = ([-nugget_bound, -sill_bound, 1e-3], [nugget_bound, sill_bound, range_cap])
    x0 = [np.clip(0.1 * scale, -nugget_bound, nugget_bound), np.clip(scale, -sill_bound, sill_bound), range0]
    return _fit_shape(lags, gammas, counts, model, x0=x0, bounds=bounds)


def ordinary_kriging(station_xy, values, variogram: VariogramModel, target_xy):
    """Ordinary kriging of `values` observed at `station_xy` onto
    `target_xy`. Returns (estimate, variance), both shape (n_targets,).
    Exact interpolator at data points when `variogram.nugget == 0` (no
    measurement-error floor)."""
    station_xy = np.asarray(station_xy, dtype=np.float64)
    values = np.asarray(values, dtype=np.float64)
    target_xy = np.asarray(target_xy, dtype=np.float64)
    n = len(values)
    m = target_xy.shape[0]
    if n == 0:
        return np.full(m, np.nan), np.full(m, variogram.sill)

    A = np.empty((n + 1, n + 1), dtype=np.float64)
    A[:n, :n] = variogram.covariance(_pairwise_distances(station_xy))
    A[:n, n] = 1.0
    A[n, :n] = 1.0
    A[n, n] = 0.0

    B = np.empty((n + 1, m), dtype=np.float64)
    B[:n, :] = variogram.covariance(_cross_distances(station_xy, target_xy))
    B[n, :] = 1.0

    W = np.linalg.solve(A, B)  # (n+1, m): weights + Lagrange multiplier per target
    estimate = W[:n, :].T @ values
    variance = np.maximum(variogram.sill - np.einsum("im,im->m", W, B), 0.0)
    return estimate, variance


def leave_one_out_cv(station_xy, values, variogram: VariogramModel) -> dict:
    """Leave-one-out cross-validation of ordinary kriging over the station
    network itself. Used to justify variogram model choice (nugget/sill/
    range, which of exponential/spherical/Gaussian) via measured RMSE/MAE
    rather than picking parameters by eye."""
    station_xy = np.asarray(station_xy, dtype=np.float64)
    values = np.asarray(values, dtype=np.float64)
    n = len(values)
    if n < 2:
        raise ValueError("need at least 2 stations for leave-one-out CV")

    predictions = np.empty(n)
    idx = np.arange(n)
    for i in range(n):
        mask = idx != i
        pred, _ = ordinary_kriging(station_xy[mask], values[mask], variogram, station_xy[i : i + 1])
        predictions[i] = pred[0]

    errors = values - predictions
    return {
        "predictions": predictions,
        "errors": errors,
        "rmse": float(np.sqrt(np.mean(errors**2))),
        "mae": float(np.mean(np.abs(errors))),
    }


def cokriging(
    primary_xy,
    primary_values,
    secondary_xy,
    secondary_values,
    variogram_xx: VariogramModel,
    variogram_yy: VariogramModel,
    variogram_xy: VariogramModel,
    target_xy,
):
    """Ordinary co-kriging: estimate the SPARSE secondary variable Y at
    `target_xy` using both its own observations and the densely observed,
    correlated primary variable X. `secondary_xy` must be a co-located
    subset of `primary_xy` (see module docstring -- the cross-semivariogram
    needs paired observations). Implements the actual block system: auto-
    covariances for X and Y, the cross-covariance between them, and
    SEPARATE unbiasedness constraints (primary weights sum to 0, secondary
    weights sum to 1) -- not "krige twice and average."

    Returns (estimate, variance) for Y at each target, shape (n_targets,).
    """
    primary_xy = np.asarray(primary_xy, dtype=np.float64)
    primary_values = np.asarray(primary_values, dtype=np.float64)
    secondary_xy = np.asarray(secondary_xy, dtype=np.float64)
    secondary_values = np.asarray(secondary_values, dtype=np.float64)
    target_xy = np.asarray(target_xy, dtype=np.float64)

    n1, n2, m = len(primary_values), len(secondary_values), target_xy.shape[0]
    size = n1 + n2 + 2
    mu1, mu2 = n1 + n2, n1 + n2 + 1  # Lagrange-multiplier row/col indices

    Cxx = variogram_xx.covariance(_pairwise_distances(primary_xy))
    Cyy = variogram_yy.covariance(_pairwise_distances(secondary_xy))
    Cxy = variogram_xy.covariance(_cross_distances(primary_xy, secondary_xy))  # (n1, n2)

    A = np.zeros((size, size), dtype=np.float64)
    A[:n1, :n1] = Cxx
    A[:n1, n1 : n1 + n2] = Cxy
    A[n1 : n1 + n2, :n1] = Cxy.T
    A[n1 : n1 + n2, n1 : n1 + n2] = Cyy
    A[:n1, mu1] = 1.0
    A[mu1, :n1] = 1.0
    A[n1 : n1 + n2, mu2] = 1.0
    A[mu2, n1 : n1 + n2] = 1.0

    B = np.zeros((size, m), dtype=np.float64)
    B[:n1, :] = variogram_xy.covariance(_cross_distances(primary_xy, target_xy))
    B[n1 : n1 + n2, :] = variogram_yy.covariance(_cross_distances(secondary_xy, target_xy))
    B[mu2, :] = 1.0  # mu1's row stays 0 (X-weight constraint sums to 0)

    W = np.linalg.solve(A, B)
    lam, nu = W[:n1, :], W[n1 : n1 + n2, :]
    estimate = lam.T @ primary_values + nu.T @ secondary_values
    variance = np.maximum(variogram_yy.sill - np.einsum("im,im->m", W, B), 0.0)
    return estimate, variance


@dataclass(frozen=True)
class KrigingStation:
    id: str
    lat: float
    lon: float
    value: float


def station_residuals(grid: CTMGrid, species: str, stations: list[KrigingStation]):
    """r(s) = obs(s) - CTM(s) at each station's nearest cell -- see module
    docstring for why the residual, not raw concentration, is what gets
    kriged. Rejects non-finite readings and out-of-domain stations
    BEFORE anything else (np.isfinite() first, never a bare range check).
    Returns (station_xy, residuals, kept_stations)."""
    field = grid.get_field(species)
    xy, residuals, kept = [], [], []
    for s in stations:
        if not np.isfinite(s.value):
            continue
        i, j = grid.latlon_to_cell(s.lat, s.lon)
        if not (0 <= i < grid.nx and 0 <= j < grid.ny):
            continue
        x_m, y_m = grid.latlon_to_xy_m(s.lat, s.lon)
        xy.append((x_m, y_m))
        residuals.append(float(s.value) - float(field[i, j]))
        kept.append(s)
    return np.array(xy, dtype=np.float64).reshape(-1, 2), np.array(residuals, dtype=np.float64), kept


def krige_map(grid: CTMGrid, species: str, variogram: VariogramModel, station_xy, residuals):
    """estimate(cell) = CTM(cell) + kriged_residual(cell), over every grid
    cell. Returns (estimate_field, variance_field), both shape (nx, ny) --
    never publish a concentration map without its uncertainty companion."""
    ii, jj = np.meshgrid(np.arange(grid.nx), np.arange(grid.ny), indexing="ij")
    target_xy = np.stack([(ii.ravel() + 0.5) * grid.dx, (jj.ravel() + 0.5) * grid.dy], axis=-1)

    kriged_residual, variance = ordinary_kriging(station_xy, residuals, variogram, target_xy)
    kriged_residual = kriged_residual.reshape(grid.nx, grid.ny)
    variance = variance.reshape(grid.nx, grid.ny)

    estimate_field = grid.get_field(species).astype(np.float64) + kriged_residual
    return estimate_field, variance
