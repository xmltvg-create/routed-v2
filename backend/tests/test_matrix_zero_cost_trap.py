"""Regression test for the no-zero-cost-trap rule in `sanitize_osrm_matrix`.

Bug context (2026-04-25, user screenshot showing fragmented Caloundra route):
PyVRP's HGS treats a zero-cost edge between two distinct nodes as "these are
the same point" and freely interchanges them inside a tour, producing visible
zig-zags on the map (e.g. 28 → 29 → 30 where 28 and 30 are on the same
street).  OSRM occasionally emits 0s for sub-second hops between near-coincident
geocodes (multi-unit buildings, offset duplicates after rounding to 6dp).

Fix: `sanitize_osrm_matrix` now clamps any non-diagonal 0 to 1 second BEFORE
restoring the diagonal. Diagonals are still 0; the floor is too small to
distort the objective on real routes (1s ≪ a typical 30–600s leg).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from solvers.pyvrp_tsp_solver import sanitize_osrm_matrix, PENALTY_SECONDS  # noqa: E402


def test_diagonal_is_zero():
    raw = [[5, 10, 15], [20, 5, 25], [30, 35, 5]]
    out = sanitize_osrm_matrix(raw)
    assert out[0, 0] == 0
    assert out[1, 1] == 0
    assert out[2, 2] == 0


def test_off_diagonal_zero_clamped_to_one():
    """The headline guarantee: no non-diagonal 0 survives sanitisation."""
    raw = [
        [0, 0, 0],   # 0,1 and 0,2 are illegal "free" edges
        [0, 0, 100],
        [50, 0, 0],  # 2,1 is illegal "free" edge
    ]
    out = sanitize_osrm_matrix(raw)

    n = out.shape[0]
    for i in range(n):
        for j in range(n):
            if i == j:
                assert out[i, j] == 0, f"diagonal must be 0 (i={i})"
            else:
                assert out[i, j] >= 1, (
                    f"off-diagonal must be >=1, got {out[i, j]} at ({i},{j})"
                )

    # Non-zero originals should be preserved exactly.
    assert out[1, 2] == 100
    assert out[2, 0] == 50


def test_off_diagonal_zero_does_not_clobber_existing_values():
    """Only zeros are clamped; non-zeros stay put."""
    raw = np.array([
        [0, 30, 60, 90],
        [30, 0, 0, 120],   # 1,2 is the only illegal zero
        [60, 0, 0, 150],   # 2,1 is also illegal zero
        [90, 120, 150, 0],
    ], dtype=int)
    out = sanitize_osrm_matrix(raw)
    assert out[1, 2] == 1
    assert out[2, 1] == 1
    # Untouched cells.
    assert out[0, 1] == 30 and out[1, 0] == 30
    assert out[0, 2] == 60 and out[2, 0] == 60
    assert out[3, 2] == 150


def test_none_negative_and_zero_handled_in_one_pass():
    """All three sanitisation rules must compose correctly."""
    raw = [
        [0, None, 0],
        [-50, 0, 100],
        [0, 200, 0],
    ]
    out = sanitize_osrm_matrix(raw)

    # Diagonal: 0
    assert out[0, 0] == 0 and out[1, 1] == 0 and out[2, 2] == 0
    # None → PENALTY
    assert out[0, 1] == PENALTY_SECONDS
    # Negative → PENALTY (NOT clamped to 1!)
    assert out[1, 0] == PENALTY_SECONDS
    # Off-diagonal 0s → 1
    assert out[0, 2] == 1
    assert out[2, 0] == 1
    # Real values preserved.
    assert out[1, 2] == 100
    assert out[2, 1] == 200


def test_returns_int64_contiguous():
    out = sanitize_osrm_matrix([[0, 1, 2], [1, 0, 3], [2, 3, 0]])
    assert out.dtype == np.int64
    assert out.flags["C_CONTIGUOUS"]


def test_input_not_mutated():
    raw = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    snapshot = [row[:] for row in raw]
    sanitize_osrm_matrix(raw)
    assert raw == snapshot
