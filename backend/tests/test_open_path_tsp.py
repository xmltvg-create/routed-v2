"""Regression tests for the open-path TSP fix (2026-04-25).

Bug: PyVRP and LKH-3 are inherently closed-loop solvers (they minimise a full
Hamiltonian *cycle* including the return-to-depot edge). For delivery routing
the driver does NOT return to the depot — they finish wherever the last stop
is. Without the open-path fix, both solvers picked routes like
`[0, far_cluster, ..., near_cluster_at_end]` because the return leg was cheap
in the cycle, but the driver had to drive past the near cluster at the start
and never actually returned. On real 78-stop user data this caused the
solvers to return tours that were 5% WORSE than the unoptimised input order.

Fix: `_open_path_matrix(matrix, depot)` zeros the return-to-depot column,
making the closed-loop optimum equal to the open-path optimum.

These tests guard against regressions of that fix.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import (  # noqa: E402  (path manipulation must come first)
    LKH_AVAILABLE,
    PYVRP_AVAILABLE,
    _open_path_matrix,
    lkh_tsp_solve,
    pyvrp_tsp_solve,
)


# ── Hand-crafted "river crossing" matrix ────────────────────────────────────
# Two clusters of 5 stops each. Cluster A (indices 0..4) is cheap internally.
# Cluster B (indices 5..9) is cheap internally. Crossing A↔B is expensive
# EXCEPT for the single bridge edge 4↔5. This is a textbook trap for a
# closed-loop solver: the cycle [0, 5..9, 4..1, 0] uses the bridge twice
# (once at 0→5 going out via the long way, once at 1→0 returning) and is
# minimal as a cycle — but as an OPEN PATH it forces the driver to skip
# stops 1..4 at the start and come back at the end, exactly the user's
# "stop 5 → stop 50 → stop 6" zigzag complaint.
def _river_crossing_matrix():
    INF = 9999
    m = [[INF] * 10 for _ in range(10)]
    for i in range(10):
        m[i][i] = 0
    # A cluster pairwise (cheap)
    for i in range(5):
        for j in range(5):
            if i != j:
                m[i][j] = abs(i - j) * 60   # 1 min per index gap
    # B cluster pairwise (cheap)
    for i in range(5):
        for j in range(5):
            if i != j:
                m[5 + i][5 + j] = abs(i - j) * 60
    # A ↔ B is expensive (30 min each way), EXCEPT the bridge 4↔5 (1 min)
    for i in range(5):
        for j in range(5):
            m[i][5 + j] = 1800
            m[5 + j][i] = 1800
    m[4][5] = 60
    m[5][4] = 60
    return m


def _open_path_cost(matrix, route):
    """Cost of an OPEN path (no return-to-depot edge)."""
    return sum(matrix[route[k]][route[k + 1]] for k in range(len(route) - 1))


# ── _open_path_matrix unit tests ───────────────────────────────────────────

class TestOpenPathMatrix:
    def test_empty(self):
        assert _open_path_matrix([], 0) == []

    def test_single_node(self):
        assert _open_path_matrix([[0]], 0) == [[0]]

    def test_zeros_return_column_only(self):
        m = [[0, 5, 10], [3, 0, 7], [8, 6, 0]]
        out = _open_path_matrix(m, 0)
        # Return-to-depot (col 0) should be 0 except for the depot's own row.
        assert out == [[0, 5, 10], [0, 0, 7], [0, 6, 0]]

    def test_does_not_mutate_input(self):
        m = [[0, 5, 10], [3, 0, 7], [8, 6, 0]]
        _ = _open_path_matrix(m, 0)
        # Original must be untouched — callers report distance from it.
        assert m == [[0, 5, 10], [3, 0, 7], [8, 6, 0]]

    def test_non_zero_depot(self):
        m = [[0, 5, 10], [3, 0, 7], [8, 6, 0]]
        out = _open_path_matrix(m, 1)
        # Column 1 zeroed except diagonal.
        assert out == [[0, 0, 10], [3, 0, 7], [8, 0, 0]]

    def test_out_of_range_depot_is_noop(self):
        m = [[0, 5, 10], [3, 0, 7], [8, 6, 0]]
        out = _open_path_matrix(m, 99)
        assert out == m


# ── Solver behaviour tests ─────────────────────────────────────────────────

@pytest.mark.skipif(not PYVRP_AVAILABLE, reason="pyvrp not installed")
class TestPyVRPOpenPath:
    def test_river_crossing_uses_bridge_only_once(self):
        """PyVRP must NOT pick a tour that crosses the river twice.

        On the river-crossing matrix, the open-path optimal is
        [0,1,2,3,4,5,6,7,8,9] (cost = 4*60 + 60 + 4*60 = 540s) — visit A
        in order, cross the bridge once, visit B in order. A closed-loop
        solver without the open-path fix will instead pick something like
        [0,5,6,7,8,9,4,3,2,1] (cost 1800+240+1800+240 = 4080s) because the
        return edge from 1→0 is cheap and the cycle is minimal.
        """
        m = _river_crossing_matrix()
        order = pyvrp_tsp_solve(m, depot=0, time_limit_seconds=2.0)
        cost = _open_path_cost(m, order)
        assert cost < 1000, (
            f"PyVRP returned a tour costing {cost}s — likely crossing the "
            f"river twice. Got order {order}; expected something like "
            f"[0,1,2,3,4,5,6,7,8,9] (cost ~540s). Open-path fix may have "
            f"regressed."
        )

    def test_returns_all_stops_uniquely(self):
        m = _river_crossing_matrix()
        order = pyvrp_tsp_solve(m, depot=0, time_limit_seconds=1.0)
        assert sorted(order) == list(range(10))

    def test_starts_at_depot(self):
        m = _river_crossing_matrix()
        order = pyvrp_tsp_solve(m, depot=3, time_limit_seconds=1.0)
        assert order[0] == 3
        assert sorted(order) == list(range(10))


@pytest.mark.skipif(not LKH_AVAILABLE, reason="LKH-3 not installed")
class TestLKHOpenPath:
    def test_river_crossing_uses_bridge_only_once(self):
        m = _river_crossing_matrix()
        order = lkh_tsp_solve(m, depot=0, runs=2, time_limit_seconds=2)
        cost = _open_path_cost(m, order)
        assert cost < 1000, (
            f"LKH returned a tour costing {cost}s — likely crossing the "
            f"river twice. Got order {order}. Open-path fix may have "
            f"regressed."
        )

    def test_returns_all_stops_uniquely(self):
        m = _river_crossing_matrix()
        order = lkh_tsp_solve(m, depot=0, runs=2, time_limit_seconds=2)
        assert sorted(order) == list(range(10))


# ── Cross-solver consistency: open-path optima should agree on small input ─

@pytest.mark.skipif(
    not (PYVRP_AVAILABLE and LKH_AVAILABLE),
    reason="needs both pyvrp and LKH-3",
)
def test_pyvrp_and_lkh_agree_on_open_path():
    """Both solvers should find the same near-optimal tour cost on a small
    instance where open-path optimum is well-defined."""
    m = _river_crossing_matrix()
    py_order = pyvrp_tsp_solve(m, depot=0, time_limit_seconds=2.0)
    lkh_order = lkh_tsp_solve(m, depot=0, runs=3, time_limit_seconds=3)
    py_cost = _open_path_cost(m, py_order)
    lkh_cost = _open_path_cost(m, lkh_order)
    # Both must be near 540s (perfect open path). Allow 20% slack for HGS jitter.
    assert py_cost <= 700, f"PyVRP cost {py_cost}s too high"
    assert lkh_cost <= 700, f"LKH cost {lkh_cost}s too high"
