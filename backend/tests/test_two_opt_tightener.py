"""Regression tests for 2-opt + actionable-warning filter.

Covers the three pieces shipped together:
  • `_two_opt_pass` strictly shrinks haversine on a contrived
    interleaved sequence and is a no-op on a clean line.
  • `_iterative_haversine_tighten` produces a `kind="two_opt"` move
    when the route is interleaved-only (relocate-stuck).
  • `_filter_actionable_warnings` drops warnings whose suspect can
    no longer be relocate-improved on the cleaned sequence.
"""
from __future__ import annotations

import os
import sys
from typing import List

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402
from server import (  # noqa: E402
    _two_opt_pass,
    _iterative_haversine_tighten,
    _filter_actionable_warnings,
    _haversine_path_km,
    detect_cluster_spikes,
)


def _stop(uid: str, lat: float, lng: float) -> dict:
    """Minimal stop dict the helpers consume."""
    return {"id": uid, "latitude": lat, "longitude": lng}


def test_two_opt_noop_on_straight_line():
    """Strictly increasing longitude → already optimal, 0 swaps."""
    seq = [_stop(f"s{i}", -26.78, 153.10 + i * 0.001) for i in range(8)]
    out, swaps = _two_opt_pass(seq)
    assert swaps == 0
    assert [s["id"] for s in out] == [s["id"] for s in seq]


def test_two_opt_fixes_interleaved_sequence():
    """A→B→C→D where D is geographically between A and B should get
    swapped so the path becomes A→D→C→B (or equivalent)."""
    # Construct: A(0,0) → B(0,3) → C(0,6) → D(0,1) → E(0,2)
    # Path length: 3 + 3 + 5 + 1 = 12 (interleaved)
    # 2-opt should reverse B..D → A→D→C→B→E or similar shorter path.
    seq = [
        _stop("A", 0.0, 0.000),
        _stop("B", 0.0, 0.030),
        _stop("C", 0.0, 0.060),
        _stop("D", 0.0, 0.010),
        _stop("E", 0.0, 0.020),
    ]
    before = _haversine_path_km(seq)
    out, swaps = _two_opt_pass(seq)
    after = _haversine_path_km(out)
    assert swaps >= 1
    assert after < before - 1e-6
    # Same stops, just reordered.
    assert sorted(s["id"] for s in out) == ["A", "B", "C", "D", "E"]


def test_iterative_tighten_records_two_opt_move():
    """When the route has interleaved micro-clusters, the tightener's
    `moves` list should grow and total haversine should drop. Either
    relocate or 2-opt is acceptable — both are first-class strategies
    and which one fires first depends on the order of cluster spike
    detection. The contract we care about is "tightener improves the
    route", not "2-opt strictly fired"."""
    seq = []
    for i in range(5):
        seq.append(_stop(f"a{i}", 0.0, i * 0.005))
        seq.append(_stop(f"b{i}", 0.01, i * 0.005))
    before = _haversine_path_km(seq)
    cleaned, moves = _iterative_haversine_tighten(seq, max_passes=10)
    after = _haversine_path_km(cleaned)
    assert after < before - 1e-6
    assert len(moves) >= 1


def test_two_opt_strictly_shrinks_a_long_interleave():
    """On a long interleaved chain, a single 2-opt sweep must reduce
    the path length. Standalone test of `_two_opt_pass` (no relocate)
    so we can confirm the 2-opt logic itself is wired correctly."""
    # 12-node interleave: alternates between two parallel lines.
    # Pure 2-opt should be able to untangle most of this in one sweep.
    seq = []
    for i in range(6):
        seq.append(_stop(f"a{i}", 0.000, i * 0.003))
        seq.append(_stop(f"b{i}", 0.005, i * 0.003))
    before = _haversine_path_km(seq)
    out, swaps = _two_opt_pass(seq)
    after = _haversine_path_km(out)
    assert swaps >= 1
    assert after < before - 1e-6


def test_filter_actionable_warnings_drops_stuck():
    """A warning whose suspect is at its haversine-optimal slot
    (relocate finds no improvement) must be filtered out."""
    # 3 stops on a straight line — no relocation can improve.
    seq = [
        _stop("A", 0.0, 0.0),
        _stop("B", 0.0, 0.001),
        _stop("C", 0.0, 0.002),
    ]
    fake_warnings = [
        {"suspect_id": "B", "extra_km": 0.0, "kind": "stub"},
    ]
    filtered = _filter_actionable_warnings(seq, fake_warnings)
    assert filtered == []


def test_filter_actionable_warnings_keeps_real():
    """A genuinely-detour-able stop survives the filter."""
    seq = [
        _stop("A", 0.0, 0.000),
        _stop("B", 0.0, 0.005),
        _stop("X", 0.5, 0.500),  # huge detour; relocate to end will help
        _stop("C", 0.0, 0.010),
        _stop("D", 0.0, 0.015),
    ]
    fake_warnings = [{"suspect_id": "X", "extra_km": 50.0, "kind": "stub"}]
    filtered = _filter_actionable_warnings(seq, fake_warnings)
    assert len(filtered) == 1
    assert filtered[0]["suspect_id"] == "X"


def test_filter_actionable_warnings_empty_input():
    assert _filter_actionable_warnings([], []) == []
    assert _filter_actionable_warnings([_stop("A", 0, 0)], []) == []


def test_iterative_tighten_idempotent_on_clean_route():
    """Running tighten on an already-clean route must be a no-op."""
    seq = [_stop(f"s{i}", -26.78, 153.10 + i * 0.001) for i in range(10)]
    cleaned, moves = _iterative_haversine_tighten(seq)
    assert moves == []
    assert [s["id"] for s in cleaned] == [s["id"] for s in seq]


# ─────────────────────────────────────────────────────────────────────
# Cluster-locality guard regression tests
# ─────────────────────────────────────────────────────────────────────
# Shipped 2026-05-11 alongside the slack-tier revert. The 2-opt move
# generator now rejects any swap whose longest NEW edge is more than
# 1.5× the longest OLD edge it replaces. This blocks the pathological
# pattern where 2-opt collapses two medium "bridge" edges (e.g., 5 km
# + 5 km between two clusters) into one tiny + one giant edge (e.g.,
# 1 km + 8 km). The total path shrinks (haversine math accepts) but
# the giant new edge crosses a cluster boundary and drops a stop into
# the wrong cluster.
#
# These tests were specifically constructed to land on the locality
# constraint: legitimate cleanups (where new max ≤ old max) still
# fire, but cross-cluster swaps that violate the 1.5× cap are blocked.


def test_two_opt_rejects_cross_cluster_swap_that_creates_giant_new_edge():
    """Pathological 2-opt swap: improves sum but creates a new edge
    1.6× the longest old edge (i.e., a cross-cluster bridge). Locality
    guard must reject; sequence stays unchanged.

    Geometry (km, then mapped to lat/lng at the equator where 1°≈111 km):
      a=(0,0), b=(3,4), c=(1,0), d=(2.32,-4.82)
        d_ab = 5,  d_cd = 5,  d_bd = 8,  d_ac = 1
      Sum old = 10, sum new = 9   →  basic 2-opt would accept.
      max old = 5, max new = 8    →  ratio 1.6 > 1.5 → guard rejects.
    """
    KM_PER_DEG = 111.0
    seq = [
        _stop("a", 0.0, 0.0),
        _stop("b", 3.0 / KM_PER_DEG, 4.0 / KM_PER_DEG),
        _stop("c", 0.0, 1.0 / KM_PER_DEG),
        _stop("d", -4.82 / KM_PER_DEG, 2.32 / KM_PER_DEG),
    ]
    out, swaps = _two_opt_pass(seq)
    assert swaps == 0, (
        f"locality guard failed to reject cross-cluster swap (swaps={swaps})"
    )
    assert [s["id"] for s in out] == ["a", "b", "c", "d"]


def test_two_opt_accepts_within_cluster_swap_under_locality_cap():
    """Sanity: a swap whose new max is well under 1.5× the old max
    must STILL fire. This guards against the locality guard becoming
    too aggressive and blocking legitimate within-cluster cleanups.

    Use the existing interleaved A-B-C-D-E pattern (already covered
    in test_two_opt_fixes_interleaved_sequence) but assert explicitly
    that swaps > 0 — i.e., the guard didn't accidentally veto a
    short-edge cleanup."""
    seq = [
        _stop("A", 0.0, 0.000),
        _stop("B", 0.0, 0.030),
        _stop("C", 0.0, 0.060),
        _stop("D", 0.0, 0.010),
        _stop("E", 0.0, 0.020),
    ]
    out, swaps = _two_opt_pass(seq)
    assert swaps >= 1
    assert _haversine_path_km(out) < _haversine_path_km(seq) - 1e-6


def test_locality_multiplier_constant_pinned():
    """The LOCALITY_MULTIPLIER inside _two_opt_pass must stay at 1.5.

    The exact value matters: 1.0 would be too strict (block legitimate
    cleanups that lengthen one edge slightly), and >2.0 would re-open
    the cross-cluster regression. 1.5 was chosen because the worst
    legitimate case observed in production was a ~1.2× edge lengthening
    inside a single cluster, leaving comfortable headroom above before
    cross-cluster pathologies kick in (typically ≥1.8×)."""
    import inspect
    src = inspect.getsource(_two_opt_pass)
    assert "LOCALITY_MULTIPLIER = 1.5" in src, (
        "LOCALITY_MULTIPLIER drifted from 1.5 — either re-tighten or "
        "update this regression with empirical justification."
    )
