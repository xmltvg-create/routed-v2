"""Hamiltonicity test for the PyVRP TSP engine.

Piggy-backs on the same fixture as `test_solver_hamiltonicity.py`: 15 stops
with duplicate coordinates so we also guard against the original
`stops.index(s)` collapse bug.
"""
from __future__ import annotations

import pytest

from tests.test_solver_hamiltonicity import make_fixture, _assert_hamilton

try:
    from server import pyvrp_tsp_solve, PYVRP_AVAILABLE, calculate_distance_matrix
except Exception:  # pragma: no cover
    pyvrp_tsp_solve, PYVRP_AVAILABLE, calculate_distance_matrix = None, False, None


@pytest.mark.skipif(not PYVRP_AVAILABLE, reason="pyvrp not installed")
def test_pyvrp_preserves_all_stops():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    indices = pyvrp_tsp_solve(dm, depot=0, time_limit_seconds=1.5, seed=42)
    out = [stops[i] for i in indices]
    _assert_hamilton(stops, out, "pyvrp")
    assert indices[0] == 0, "pyvrp route must start at the requested depot"


@pytest.mark.skipif(not PYVRP_AVAILABLE, reason="pyvrp not installed")
def test_pyvrp_respects_non_zero_depot():
    stops = make_fixture()
    dm = calculate_distance_matrix(stops)
    indices = pyvrp_tsp_solve(dm, depot=7, time_limit_seconds=1.5, seed=42)
    assert indices[0] == 7, "depot must be first regardless of matrix index"
    assert set(indices) == set(range(len(stops))), "no stops dropped on depot remap"
    assert len(indices) == len(set(indices)), "no duplicates on depot remap"


@pytest.mark.skipif(not PYVRP_AVAILABLE, reason="pyvrp not installed")
def test_pyvrp_handles_trivial_input():
    # 0 and 1 stop corner cases: solver must not crash or invent nodes.
    assert pyvrp_tsp_solve([], depot=0, time_limit_seconds=0.5) == []
    assert pyvrp_tsp_solve([[0]], depot=0, time_limit_seconds=0.5) == [0]
