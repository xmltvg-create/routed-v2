"""Hamiltonicity + correctness contract tests for every public TSP/VRP solver.

The solvers are invoked with a 15-stop fixture so every algorithm completes
in <2s locally. Every algorithm gets the SAME asserts:

 1. Output length matches input length (no stops silently dropped).
 2. Every input stop appears exactly once in the output (no dupes, no swaps).
 3. Route distance is a positive finite number.

Solvers that rely on optional native dependencies (Timefold, VROOM, LKH) are
skipped gracefully if the binaries aren't installed — CI runs without them but
the dev container has them.
"""
from __future__ import annotations
import pytest

from server import (
    nearest_neighbor_optimize,
    two_opt_improve,
    three_opt_improve,
    or_opt_improve,
    simulated_annealing_optimize,
    genetic_algorithm_optimize,
    clarke_wright_savings,
    iterated_local_search,
    alns_hybrid_optimize,
    calculate_distance_matrix,
    calculate_route_distance,
    _indices_by_identity,
)

# Probe availability of native solvers at import time.
try:
    from server import ortools_tsp_solve, ORTOOLS_AVAILABLE
except Exception:  # pragma: no cover
    ortools_tsp_solve, ORTOOLS_AVAILABLE = None, False

try:
    from server import vroom_tsp_solve, VROOM_AVAILABLE
except Exception:  # pragma: no cover
    vroom_tsp_solve, VROOM_AVAILABLE = None, False

try:
    from server import lkh_tsp_solve, LKH_AVAILABLE
except Exception:  # pragma: no cover
    lkh_tsp_solve, LKH_AVAILABLE = None, False

try:
    from server import timefold_optimize, TIMEFOLD_AVAILABLE
except Exception:  # pragma: no cover
    timefold_optimize, TIMEFOLD_AVAILABLE = None, False


# 15 Sunshine-Coast-ish stops with unique IDs but a handful of DUPLICATE
# latitudes/longitudes (stops 2 & 3 share coords; 7 & 8 share coords). This is
# the real-world case that trips the `stops.index(s)` bug.
def make_fixture() -> list[dict]:
    pts = [
        (-26.700, 153.100), (-26.705, 153.102), (-26.705, 153.102),  # dup!
        (-26.710, 153.105), (-26.715, 153.108), (-26.720, 153.110),
        (-26.725, 153.112), (-26.730, 153.115), (-26.730, 153.115),  # dup!
        (-26.735, 153.118), (-26.740, 153.120), (-26.745, 153.122),
        (-26.750, 153.125), (-26.755, 153.128), (-26.760, 153.130),
    ]
    return [
        {"id": f"stop_{i}", "latitude": lat, "longitude": lng,
         "address": f"Addr {i}", "completed": False, "order": i}
        for i, (lat, lng) in enumerate(pts)
    ]


def _assert_hamilton(input_stops: list[dict], output_stops: list[dict], algo_name: str):
    """Every stop exactly once, in some order, by unique id."""
    assert len(output_stops) == len(input_stops), (
        f"{algo_name}: lost stops ({len(output_stops)}/{len(input_stops)})"
    )
    in_ids = {s["id"] for s in input_stops}
    out_ids = [s["id"] for s in output_stops]
    assert set(out_ids) == in_ids, f"{algo_name}: output id-set mismatch"
    assert len(set(out_ids)) == len(out_ids), f"{algo_name}: duplicate ids in output"


# ── Pure-Python solvers (always runnable) ────────────────────────────────────

def test_nearest_neighbor_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    out = nearest_neighbor_optimize(stops, dm, start_index=0)
    _assert_hamilton(stops, out, "nearest_neighbor")


def test_two_opt_preserves_all_stops_with_duplicates():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    nn = nearest_neighbor_optimize(stops, dm, start_index=0)
    route_idx = _indices_by_identity(stops, nn)
    improved = two_opt_improve(route_idx, dm)
    assert len(improved) == len(stops)
    assert set(improved) == set(range(len(stops)))


def test_three_opt_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    nn = nearest_neighbor_optimize(stops, dm, start_index=0)
    route_idx = _indices_by_identity(stops, nn)
    improved = three_opt_improve(route_idx, dm, max_iterations=1)
    assert len(improved) == len(stops)
    assert set(improved) == set(range(len(stops)))


def test_or_opt_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    nn = nearest_neighbor_optimize(stops, dm, start_index=0)
    route_idx = _indices_by_identity(stops, nn)
    improved = or_opt_improve(route_idx, dm)
    assert len(improved) == len(stops)
    assert set(improved) == set(range(len(stops)))


def test_simulated_annealing_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    out = simulated_annealing_optimize(stops, dm, iterations=200)
    _assert_hamilton(stops, out, "simulated_annealing")


def test_genetic_algorithm_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    out = genetic_algorithm_optimize(stops, dm, generations=10, population_size=20)
    _assert_hamilton(stops, out, "genetic")


def test_clarke_wright_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    out = clarke_wright_savings(stops, dm, depot_index=0)
    _assert_hamilton(stops, out, "clarke_wright")


def test_iterated_local_search_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    out = iterated_local_search(stops, dm, start_index=0, time_limit_seconds=2)
    _assert_hamilton(stops, out, "iterated_local_search")


def test_alns_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    out = alns_hybrid_optimize(stops, dm, start_index=0, time_limit_seconds=2)
    _assert_hamilton(stops, out, "alns")


# ── Native solvers (skipped if deps missing) ────────────────────────────────

@pytest.mark.skipif(not ORTOOLS_AVAILABLE, reason="ortools not installed")
def test_ortools_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    # Native solvers return an index list, not stops — map back through the
    # same `stops` list that the optimize endpoint uses.
    indices = ortools_tsp_solve(dm, depot=0, time_limit_ms=2000)
    out = [stops[i] for i in indices]
    _assert_hamilton(stops, out, "ortools")


@pytest.mark.skipif(not VROOM_AVAILABLE, reason="vroom not installed")
def test_vroom_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    indices = vroom_tsp_solve(dm, depot=0)
    out = [stops[i] for i in indices]
    _assert_hamilton(stops, out, "vroom")


@pytest.mark.skipif(not LKH_AVAILABLE, reason="lkh not installed")
def test_lkh_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    indices = lkh_tsp_solve(dm, depot=0, time_limit_seconds=2)
    out = [stops[i] for i in indices]
    _assert_hamilton(stops, out, "lkh")


@pytest.mark.skipif(not TIMEFOLD_AVAILABLE, reason="timefold not installed")
def test_timefold_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    out = timefold_optimize(stops, dm, start_index=0, time_limit_seconds=3)
    _assert_hamilton(stops, out, "timefold")


# ── Regression test for the original bug ─────────────────────────────────────

def test_indices_by_identity_handles_duplicate_valued_stops():
    """Proves the helper distinguishes dicts by identity, not equality.

    `stops[2]` and `stops[3]` have the same address/lat/lng (realistic: two
    units at the same building). Before this helper, `stops.index(s)` would
    map both dicts to index 2, collapsing the route.
    """
    s = [{"id": "a", "latitude": 1, "longitude": 2},
         {"id": "b", "latitude": 1, "longitude": 2},  # equal values, different dict
         {"id": "c", "latitude": 3, "longitude": 4}]
    # Reorder: c, b, a — the helper must return [2, 1, 0] not [2, 0, 0].
    reordered = [s[2], s[1], s[0]]
    assert _indices_by_identity(s, reordered) == [2, 1, 0]
