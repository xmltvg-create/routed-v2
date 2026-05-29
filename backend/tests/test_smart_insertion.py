"""Unit tests for Late Freight smart-insertion OR-Tools precedence logic.

Run from /app/backend:  python -m pytest tests/test_smart_insertion.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from server import ortools_tsp_solve, _smart_insertion_fallback, ORTOOLS_AVAILABLE


def _euclidean_matrix(coords):
    n = len(coords)
    m = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            dx = coords[i][0] - coords[j][0]
            dy = coords[i][1] - coords[j][1]
            m[i][j] = (dx * dx + dy * dy) ** 0.5
    return m


def _positions(order, nodes):
    """Return the visit positions (0-based) of the given nodes in `order`."""
    return {n: order.index(n) for n in nodes}


@pytest.mark.skipif(not ORTOOLS_AVAILABLE, reason="OR-Tools not installed")
def test_locked_order_is_respected():
    # depot=0. Locked stops 1,2,3 must be visited in order 1->2->3.
    # Late stops 4,5 may slot anywhere. Coords arranged so the greedy
    # optimum would normally re-sequence the locked stops.
    coords = [
        (0, 0),    # 0 depot
        (10, 0),   # 1 locked (seq 1)
        (5, 0),    # 2 locked (seq 2) — geographically before 1
        (15, 0),   # 3 locked (seq 3)
        (2, 1),    # 4 late
        (12, 1),   # 5 late
    ]
    matrix = _euclidean_matrix(coords)
    locked_order = [1, 2, 3]
    order = ortools_tsp_solve(matrix, depot=0, time_limit_ms=2000, locked_order=locked_order)

    assert order[0] == 0, "depot must be first"
    assert len(set(order)) == len(coords), "every node visited exactly once"
    pos = _positions(order, locked_order)
    assert pos[1] < pos[2] < pos[3], f"locked order violated: {order}"


@pytest.mark.skipif(not ORTOOLS_AVAILABLE, reason="OR-Tools not installed")
def test_late_stops_inserted_in_gaps():
    coords = [
        (0, 0),    # 0 depot
        (10, 0),   # 1 locked seq1
        (20, 0),   # 2 locked seq2
        (30, 0),   # 3 locked seq3
        (11, 0.1), # 4 late — closest to gap between 1 and 2
    ]
    matrix = _euclidean_matrix(coords)
    locked_order = [1, 2, 3]
    order = ortools_tsp_solve(matrix, depot=0, time_limit_ms=2000, locked_order=locked_order)
    pos = _positions(order, [1, 2, 3, 4])
    assert pos[1] < pos[2] < pos[3]
    # The late stop should be inserted between locked 1 and 2 (cheapest gap)
    assert pos[1] < pos[4] < pos[2], f"late stop not in optimal gap: {order}"


def test_fallback_preserves_locked_order():
    stops = [
        {"id": "depot"},
        {"id": "a", "original_sequence": 1},
        {"id": "b", "original_sequence": 2},
        {"id": "c", "original_sequence": 3},
        {"id": "late"},
    ]
    coords = [(0, 0), (10, 0), (20, 0), (30, 0), (11, 0.1)]
    matrix = _euclidean_matrix(coords)
    result = _smart_insertion_fallback(stops, matrix, start_index=0, locked_order=[1, 2, 3])
    ids = [s["id"] for s in result]
    assert ids[0] == "depot"
    assert ids.index("a") < ids.index("b") < ids.index("c")
    assert "late" in ids
    # late should be inserted between a and b
    assert ids.index("a") < ids.index("late") < ids.index("b")
