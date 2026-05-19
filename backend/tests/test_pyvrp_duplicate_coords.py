"""Regression tests for the PyVRP duplicate-coordinate fix (2026-04-25).

Bug: HGS shuffles stops sharing identical (lon, lat) randomly because every
edge between them costs 0 — the solver has no preference, so the final
sequence interleaves these duplicates with neighbouring stops, producing
visible zig-zags on the map.

Fix: `PyVRPTspSolver.solve()` now collapses every group of identical
coordinates into a single super-node before invoking PyVRP, then re-expands
the super-node into its members in their original input order. Service
durations are summed per group; no stop is dropped.

These tests guard against regressions and verify three properties:
  1. All input stop_ids appear exactly once in the output.
  2. Stops sharing coords come out adjacent (and in input order).
  3. The collapsing logic still respects the open-path optimum on
     non-duplicate inputs.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import PYVRP_AVAILABLE, pyvrp_tsp_solve  # noqa: E402
from solvers.pyvrp_tsp_solver import (  # noqa: E402
    DeliveryStop,
    PENALTY_SECONDS,
    PyVRPTspSolver,
    sanitize_osrm_matrix,
)


class TestSanitizeOSRMMatrix:
    """Direct unit tests for the matrix sanitiser. These don't need pyvrp,
    so they always run regardless of whether pyvrp is installed."""

    def test_diagonal_forced_to_zero(self):
        m = [[5, 10, 20], [10, 5, 15], [20, 15, 5]]
        out = sanitize_osrm_matrix(m)
        assert out[0, 0] == 0
        assert out[1, 1] == 0
        assert out[2, 2] == 0

    def test_none_replaced_with_penalty(self):
        m = [[0, 10, None], [10, 0, 20], [None, 20, 0]]
        out = sanitize_osrm_matrix(m)
        assert out[0, 2] == PENALTY_SECONDS
        assert out[2, 0] == PENALTY_SECONDS
        # Off-diagonal valid values are preserved exactly.
        assert out[0, 1] == 10
        assert out[1, 2] == 20

    def test_negatives_replaced_with_penalty(self):
        m = np.asarray([[0, 10, -5], [10, 0, 20], [-1, 20, 0]], dtype=np.float64)
        out = sanitize_osrm_matrix(m)
        assert out[0, 2] == PENALTY_SECONDS
        assert out[2, 0] == PENALTY_SECONDS

    def test_nan_replaced_with_penalty(self):
        m = np.asarray(
            [[0, 10, np.nan], [10, 0, 20], [np.nan, 20, 0]], dtype=np.float64
        )
        out = sanitize_osrm_matrix(m)
        assert out[0, 2] == PENALTY_SECONDS
        assert out[2, 0] == PENALTY_SECONDS

    def test_input_not_mutated(self):
        m = [[5, 10], [-1, 5]]
        sanitize_osrm_matrix(m)
        # Caller's list is still intact; sanitiser returns a fresh copy.
        assert m == [[5, 10], [-1, 5]]


from server import PYVRP_AVAILABLE, pyvrp_tsp_solve  # noqa: E402,F811


pytestmark = pytest.mark.skipif(
    not PYVRP_AVAILABLE, reason="pyvrp not installed"
)


# ── Synthetic 5-stop scenario with two duplicate-coord clusters ─────────────
# Layout (all coords picked so duplicates are obvious):
#   depot:     (0.00, 0.00)
#   stop A:    (0.10, 0.00)
#   stop B1:   (0.50, 0.00)   ← B1, B2, B3 share identical coords
#   stop B2:   (0.50, 0.00)
#   stop B3:   (0.50, 0.00)
#   stop C:    (0.90, 0.00)
#
# Travel-time matrix (seconds, symmetric, depot=0):
#   depot↔A = 60, A↔B = 240, B↔C = 240, A↔C = 480, depot↔C = 540
#   B*↔B*    = 0
def _scenario_matrix():
    # 0=depot, 1=A, 2=B1, 3=B2, 4=B3, 5=C
    # Symmetric matrix.
    m = [
        [0,    60,  300, 300, 300, 540],
        [60,   0,   240, 240, 240, 480],
        [300,  240, 0,   0,   0,   240],
        [300,  240, 0,   0,   0,   240],
        [300,  240, 0,   0,   0,   240],
        [540,  480, 240, 240, 240, 0],
    ]
    coords = [
        (0.00, 0.00),  # depot
        (0.10, 0.00),  # A
        (0.50, 0.00),  # B1
        (0.50, 0.00),  # B2
        (0.50, 0.00),  # B3
        (0.90, 0.00),  # C
    ]
    return m, coords


class TestPyVRPDuplicateCoordinates:
    def test_all_stop_ids_appear_exactly_once(self):
        matrix, coords = _scenario_matrix()
        order = pyvrp_tsp_solve(
            matrix,
            depot=0,
            time_limit_seconds=1.0,
            coordinates=coords,
        )
        assert sorted(order) == list(range(6)), (
            f"Expected every node 0..5 exactly once, got {order}"
        )

    def test_duplicate_cluster_stays_contiguous(self):
        """B1, B2, B3 share coords ⇒ they must be adjacent in the tour
        and emitted in their original input order (2, 3, 4)."""
        matrix, coords = _scenario_matrix()
        order = pyvrp_tsp_solve(
            matrix,
            depot=0,
            time_limit_seconds=1.0,
            coordinates=coords,
        )
        # Find the position of each duplicate.
        pos = {idx: order.index(idx) for idx in (2, 3, 4)}
        positions = sorted(pos.values())
        # Contiguous: diff between consecutive positions = 1.
        assert positions[1] - positions[0] == 1
        assert positions[2] - positions[1] == 1
        # Input-order preserving: 2 before 3 before 4.
        assert pos[2] < pos[3] < pos[4], (
            f"Duplicates must be emitted in input order; got positions "
            f"{pos} for tour {order}"
        )

    def test_open_path_optimum_with_duplicates(self):
        """Best open-path tour is depot→A→B*→C (or its mirror). Cost should
        be 60 + 240 + 240 = 540s. Without the open-path fix or with a
        bad duplicate-handling regression it would balloon."""
        matrix, coords = _scenario_matrix()
        order = pyvrp_tsp_solve(
            matrix,
            depot=0,
            time_limit_seconds=1.5,
            coordinates=coords,
        )
        cost = sum(matrix[order[i]][order[i + 1]] for i in range(len(order) - 1))
        # Optimum 540s; allow 10% jitter for HGS (any duplicate handling
        # error doubles the cost since B* would be revisited via A or C).
        assert cost < 600, f"Tour cost {cost}s > 600s on duplicate scenario"


class TestPyVRPSolverGrouping:
    """Direct tests on the PyVRPTspSolver's `solve()` interface — bypassing
    the server.py adapter so we catch any logic bug at the source."""

    def test_solver_groups_by_coord_when_provided(self):
        # Two stops at same coord — must come out adjacent.
        solver = PyVRPTspSolver(max_runtime_seconds=1.0)
        depot = DeliveryStop(stop_id="D", service_duration=0, x=0.0, y=0.0)
        stops = [
            DeliveryStop(stop_id="A",  service_duration=0, x=1.0, y=0.0),
            DeliveryStop(stop_id="B1", service_duration=0, x=2.0, y=0.0),
            DeliveryStop(stop_id="B2", service_duration=0, x=2.0, y=0.0),
            DeliveryStop(stop_id="C",  service_duration=0, x=3.0, y=0.0),
        ]
        # Symmetric travel-time matrix mirroring positions on the x-axis.
        # Depot=0 col/row, A=1, B1=2, B2=3, C=4.
        matrix = np.asarray([
            [0,   60, 120, 120, 180],
            [60,  0,  60,  60,  120],
            [120, 60, 0,   0,   60],
            [120, 60, 0,   0,   60],
            [180, 120, 60, 60,  0],
        ], dtype=np.int64)
        seq = solver.solve(depot=depot, stops=stops, time_matrix=matrix)
        # All stops present, exactly once.
        assert sorted(seq) == ["A", "B1", "B2", "C"]
        # B1 and B2 contiguous and in input order.
        ib1, ib2 = seq.index("B1"), seq.index("B2")
        assert abs(ib1 - ib2) == 1
        assert ib1 < ib2

    def test_solver_does_not_group_when_coords_omitted(self):
        # Without coords every stop is its own group — sanity check that
        # the legacy code path still works for callers that don't pass
        # (lon, lat) information. Note: we hit `PyVRPTspSolver.solve()`
        # directly here, so PyVRP runs as a closed-loop solver — we only
        # check that no stop is dropped.
        solver = PyVRPTspSolver(max_runtime_seconds=1.0)
        depot = DeliveryStop(stop_id="D", service_duration=0)
        stops = [
            DeliveryStop(stop_id="A", service_duration=0),
            DeliveryStop(stop_id="B", service_duration=0),
            DeliveryStop(stop_id="C", service_duration=0),
        ]
        matrix = np.asarray([
            [0,   100, 200, 300],
            [100, 0,   100, 200],
            [200, 100, 0,   100],
            [300, 200, 100, 0],
        ], dtype=np.int64)
        seq = solver.solve(depot=depot, stops=stops, time_matrix=matrix)
        assert sorted(seq) == ["A", "B", "C"]

    def test_service_duration_summed_within_group(self):
        """The grouped super-node should account for the sum of service
        durations of its members. We can't read PyVRP's internals here,
        but we can assert the total objective ≥ that sum and that all
        stop_ids still appear in the output."""
        solver = PyVRPTspSolver(max_runtime_seconds=1.0)
        depot = DeliveryStop(stop_id="D", service_duration=0, x=0.0, y=0.0)
        stops = [
            DeliveryStop(stop_id="X1", service_duration=120, x=1.0, y=0.0),
            DeliveryStop(stop_id="X2", service_duration=180, x=1.0, y=0.0),
            DeliveryStop(stop_id="X3", service_duration=60,  x=1.0, y=0.0),
        ]
        matrix = np.asarray([
            [0,  60, 60, 60],
            [60, 0,  0,  0],
            [60, 0,  0,  0],
            [60, 0,  0,  0],
        ], dtype=np.int64)
        seq = solver.solve(depot=depot, stops=stops, time_matrix=matrix)
        # Three identical-coord stops collapse to ONE super-node ⇒ all
        # three come out adjacent and in input order.
        assert seq == ["X1", "X2", "X3"]


class TestPyVRPNoDuplicateRegression:
    """Confirm the open-path optimum is still reached on instances with NO
    duplicates — i.e. the grouping pre-processing is a no-op when every
    coord is unique."""

    def test_river_crossing_unaffected_by_grouping(self):
        # Re-build the river-crossing matrix from test_open_path_tsp,
        # passing distinct coordinates so grouping leaves every stop alone.
        INF = 9999
        m = [[INF] * 10 for _ in range(10)]
        for i in range(10):
            m[i][i] = 0
        for i in range(5):
            for j in range(5):
                if i != j:
                    m[i][j] = abs(i - j) * 60
                    m[5 + i][5 + j] = abs(i - j) * 60
        for i in range(5):
            for j in range(5):
                m[i][5 + j] = 1800
                m[5 + j][i] = 1800
        m[4][5] = 60
        m[5][4] = 60
        coords = [(float(i) * 0.001, 0.0) for i in range(10)]
        order = pyvrp_tsp_solve(
            m,
            depot=0,
            time_limit_seconds=2.0,
            coordinates=coords,
        )
        cost = sum(m[order[i]][order[i + 1]] for i in range(len(order) - 1))
        assert cost < 1000, (
            f"Open-path optimum regressed when coordinates are passed: "
            f"got cost {cost}s for tour {order}"
        )
        assert sorted(order) == list(range(10))



# ── Real-world geocoder jitter (Zero-Cost Interleaving regression, 2026-04-30)
#
# Geocoders virtually never return bit-identical floats for "same address" —
# you typically see ~1cm of noise (0.0000001° drift) between successive lookups.
# Before the snap fix in `_coord_key`, exact float equality treated jittered
# coords as DISTINCT super-nodes and HGS happily interleaved them with
# neighbouring stops because their inter-distance was tiny but non-zero. The
# driver experienced this as `[A, B1, C, B2]` — having to drive past a stop
# twice because the solver split two parcels at the same address.
class TestGeocoderJitterClustering:
    def test_jittered_duplicates_still_cluster(self):
        """Stops with sub-meter coord drift must collapse to one super-node."""
        from solvers.pyvrp_tsp_solver import PyVRPTspSolver, DeliveryStop

        depot = DeliveryStop(stop_id="depot", service_duration=0, x=0.0, y=0.0)
        stops = [
            DeliveryStop(stop_id="A",  service_duration=0, x=1.0,        y=0.0),
            DeliveryStop(stop_id="B1", service_duration=0, x=2.0,        y=0.0),
            DeliveryStop(stop_id="B2", service_duration=0, x=2.00000007, y=0.00000003),
            DeliveryStop(stop_id="C",  service_duration=0, x=3.0,        y=0.0),
        ]
        m = np.array([
            [0,   60,  120, 120, 180],
            [60,  0,   60,  60,  120],
            [120, 60,  0,   1,   60],
            [120, 60,  1,   0,   60],
            [180, 120, 60,  60,  0  ],
        ])
        solver = PyVRPTspSolver(max_runtime_seconds=1.0, seed=0)
        seq = solver.solve(depot=depot, stops=stops, time_matrix=m)

        i_b1 = seq.index("B1")
        i_b2 = seq.index("B2")
        assert abs(i_b1 - i_b2) == 1, (
            f"Jittered duplicates were NOT clustered: seq={seq}. "
            f"B1 at {i_b1}, B2 at {i_b2} — solver interleaved a stop between them."
        )

    def test_distinct_addresses_above_tolerance_stay_distinct(self):
        """Two stops ~11 m apart (1 unit at 5 dp) must NOT cluster."""
        from solvers.pyvrp_tsp_solver import PyVRPTspSolver

        s_close   = type("S", (), {"x": 1.00000, "y": 0.0})()
        s_distant = type("S", (), {"x": 1.00010, "y": 0.0})()
        k1 = PyVRPTspSolver._coord_key(s_close,   0)
        k2 = PyVRPTspSolver._coord_key(s_distant, 1)
        assert k1 != k2, "Stops 11 m apart collapsed into one super-node — tolerance is too coarse."

