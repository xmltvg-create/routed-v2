"""Regression tests for the shared coord-clustering wrapper.

`solvers/coord_clustering.py` lifts the snap-cluster-expand pipeline out of
PyVRP so OR-Tools, LKH, VROOM, ILS, GA — every TSP solver in the optimize
pipeline — gets the same "Zero-Cost Interleaving" protection PyVRP got
internally.

Key invariants the wrapper must hold:
    1. Same-doorstep stops always come out adjacent in the result.
    2. No stop is ever lost (every original index appears exactly once).
    3. Float jitter (~1cm) collapses; legitimate distinct addresses (≥11m)
       do NOT collapse.
    4. The depot is never merged with another stop, even at identical coords.
    5. Output ordering relative to non-duplicate stops matches whatever
       order the wrapped solver chose — the wrapper must not re-shuffle.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from solvers.coord_clustering import (  # noqa: E402
    cluster_aware_solve,
    cluster_supernodes,
    expand_supernodes,
    snap_coord,
)


# ── snap_coord ──────────────────────────────────────────────────────────────


class TestSnapCoord:
    def test_jitter_within_tolerance_collapses(self):
        # Two values that differ by ~1 cm of latitude.
        assert snap_coord(-26.78604) == snap_coord(-26.786041)
        assert snap_coord(153.07358) == snap_coord(153.073580001)

    def test_distinct_addresses_above_tolerance_stay_distinct(self):
        # 0.0001° ≈ 11 m at the equator — well past our 5 dp bucket.
        assert snap_coord(1.00000) != snap_coord(1.00010)


# ── cluster_supernodes ──────────────────────────────────────────────────────


def _stops(coords):
    return [{"latitude": lat, "longitude": lng} for lat, lng in coords]


class TestClusterSupernodes:
    def test_no_duplicates_means_no_clustering(self):
        coords = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)]
        m = [[0, 60, 120], [60, 0, 60], [120, 60, 0]]
        reduced, groups, depot = cluster_supernodes(_stops(coords), m, 0)
        assert len(groups) == 3
        assert all(len(g) == 1 for g in groups)
        assert reduced == m
        assert depot == 0

    def test_duplicates_collapse_into_one_supernode(self):
        # Stops 1 and 2 share coords (with 1cm jitter on stop 2).
        coords = [(0.0, 0.0), (1.0, 0.0), (1.00000007, 0.00000003), (2.0, 0.0)]
        m = [
            [0,  60, 60, 120],
            [60, 0,  1,  60 ],
            [60, 1,  0,  60 ],
            [120, 60, 60, 0 ],
        ]
        _, groups, depot = cluster_supernodes(_stops(coords), m, 0)
        assert len(groups) == 3
        # Depot is its own group, original stops 1+2 collapse, stop 3 alone.
        merged = [g for g in groups if len(g) > 1]
        assert len(merged) == 1
        assert sorted(merged[0]) == [1, 2]
        assert depot == 0

    def test_depot_never_merged(self):
        # Two stops have IDENTICAL coords to the depot. Depot must stay alone.
        coords = [(5.0, 5.0), (5.0, 5.0), (5.0, 5.0), (1.0, 0.0)]
        m = [
            [0, 1, 1, 60],
            [1, 0, 1, 60],
            [1, 1, 0, 60],
            [60, 60, 60, 0],
        ]
        _, groups, depot = cluster_supernodes(_stops(coords), m, 0)
        # Depot (index 0) must be isolated.
        depot_group = next(g for g in groups if 0 in g)
        assert depot_group == [0]
        # The other two same-coord stops cluster together.
        merged = [g for g in groups if len(g) > 1]
        assert merged and sorted(merged[0]) == [1, 2]
        assert depot == 0

    def test_missing_coords_do_not_cluster(self):
        coords = [{"latitude": 0.0, "longitude": 0.0},
                  {"latitude": None, "longitude": 1.0},
                  {"latitude": None, "longitude": 1.0},
                  {"latitude": 2.0, "longitude": 0.0}]
        m = [[0]*4 for _ in range(4)]
        _, groups, _ = cluster_supernodes(coords, m, 0)
        # Missing-coord stops must each become their own super-node.
        assert len(groups) == 4


# ── expand_supernodes ───────────────────────────────────────────────────────


class TestExpandSupernodes:
    def test_members_appear_consecutively_and_in_input_order(self):
        groups = [[0], [1, 2], [3]]
        # Solver returned super-node order [0, 1, 2] — expand to flat list.
        flat = expand_supernodes([0, 1, 2], groups)
        assert flat == [0, 1, 2, 3]
        # Even if super-nodes visited in different order, members stay
        # together AND in input order within their group.
        flat = expand_supernodes([0, 2, 1], groups)
        assert flat == [0, 3, 1, 2]

    def test_dropped_supernode_members_are_appended(self):
        # Solver pathologically forgot super-node 1 — wrapper must recover it.
        groups = [[0], [1, 2], [3]]
        flat = expand_supernodes([0, 2], groups)
        assert sorted(flat) == [0, 1, 2, 3]


# ── cluster_aware_solve (full integration) ───────────────────────────────────


def _identity_solver(matrix, depot, **_):
    """A trivial 'solver' that returns 0..N-1 starting from depot."""
    n = len(matrix)
    rest = [i for i in range(n) if i != depot]
    return [depot] + rest


def _greedy_nn_solver(matrix, depot, **_):
    """Nearest-neighbour — the simplest TSP solver. Useful for tests because
    its decisions are predictable."""
    n = len(matrix)
    visited = [depot]
    while len(visited) < n:
        last = visited[-1]
        candidates = [(matrix[last][j], j) for j in range(n) if j not in visited]
        candidates.sort()
        visited.append(candidates[0][1])
    return visited


class TestClusterAwareSolve:
    def test_no_stops_calls_solver_directly(self):
        # Identity solver should run unmolested.
        m = [[0]]
        out = cluster_aware_solve(_identity_solver, m, 0, [])
        assert out == [0]

    def test_no_duplicates_passes_through(self):
        coords = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)]
        m = [[0, 1, 2], [1, 0, 1], [2, 1, 0]]
        out = cluster_aware_solve(_greedy_nn_solver, m, 0, _stops(coords))
        assert out == [0, 1, 2]
        assert sorted(out) == [0, 1, 2]

    def test_jittered_duplicates_remain_adjacent(self):
        # Stops 2 and 3 share a doorstep (with 1cm jitter on stop 3).
        # A naive greedy NN solver could go [0, 1, 2, 4, 3] when distance
        # matrix puts stop-4 between B-clones — but the cluster-aware wrapper
        # collapses them to one super-node, so the solver only sees 4 nodes
        # and the expansion forces B's members to be contiguous.
        coords = [
            (0.0, 0.0),       # 0 depot
            (1.0, 0.0),       # 1
            (5.0, 0.0),       # 2  — B-clone 1
            (5.00000007, 0.00000003),  # 3  — B-clone 2
            (10.0, 0.0),      # 4
        ]
        m = [
            [0,   1, 5, 5, 10],
            [1,   0, 4, 4, 9 ],
            [5,   4, 0, 1, 5 ],
            [5,   4, 1, 0, 5 ],
            [10,  9, 5, 5, 0 ],
        ]
        out = cluster_aware_solve(_greedy_nn_solver, m, 0, _stops(coords))
        # Every original index appears exactly once.
        assert sorted(out) == [0, 1, 2, 3, 4]
        # B-clones are adjacent.
        assert abs(out.index(2) - out.index(3)) == 1, (
            f"Expected stops 2 & 3 (same doorstep) to be adjacent — got {out}"
        )

    def test_initial_indices_dropped_when_clustering(self):
        # If caller passes a warm-start that references original indices,
        # it must be silently dropped (rather than corrupting the seed).
        coords = [(0.0, 0.0), (1.0, 0.0), (1.00000007, 0.0), (2.0, 0.0)]
        m = [[0]*4 for _ in range(4)]
        # If `initial_indices` reached the inner solver as-is it would
        # crash because it indexes into a 4-row matrix while the inner
        # call only sees 3 super-nodes. Test passes if no exception.
        out = cluster_aware_solve(
            _greedy_nn_solver, m, 0, _stops(coords),
            initial_indices=[0, 1, 2, 3],
        )
        assert sorted(out) == [0, 1, 2, 3]
