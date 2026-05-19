"""Regression tests for the cluster spike detector + tightener pipeline.

We construct a deliberately zig-zag sequence and verify:
  1. `detect_cluster_spikes` flags the spike triplet.
  2. `_relocate_stop_haversine` finds a better insertion position.
  3. `_iterative_haversine_tighten` reduces total haversine km.
  4. After tightening, the cleaned sequence has fewer warnings.

These exercise the pure-geometric helpers — they don't hit OSRM, so the
test is hermetic and fast. The OSRM verification gate in the live
endpoint may roll back any of these moves, but if the geometric pass
itself is broken, the endpoint can never produce a useful result.

Usage:
    cd /app/backend && pytest tests/test_cluster_tightener.py -v
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _stop(stop_id, lat, lng):
    return {"id": stop_id, "latitude": lat, "longitude": lng}


def test_detector_flags_obvious_zigzag():
    """A→B→C where B is way off the A→C line should fire."""
    import server

    # A and C are 1 km apart on the same latitude line. B sits 1 km north
    # of the midpoint — an unmistakable zigzag.
    seq = [
        _stop("A", -27.50, 153.00),
        _stop("B", -27.49, 153.005),  # ~1.1 km north of midpoint
        _stop("C", -27.50, 153.01),
    ]
    warnings = server.detect_cluster_spikes(seq)
    assert len(warnings) == 1
    w = warnings[0]
    assert w["suspect_id"] == "B"
    assert w["extra_km"] > 0
    # Detour at least 1.5x straight-line A→C
    assert w["detour_km"] > 1.5 * w["straight_km"]


def test_detector_skips_clean_route():
    """A straight A→B→C line should NOT fire."""
    import server

    seq = [
        _stop("A", -27.50, 153.00),
        _stop("B", -27.50, 153.005),
        _stop("C", -27.50, 153.01),
    ]
    assert server.detect_cluster_spikes(seq) == []


def test_relocate_moves_spike_to_better_slot():
    """A spike-in-middle should relocate to one of the ends to shorten path."""
    import server

    # Construct: A, X, B, C where X is the spike (way off-path).
    # Best fix is to move X to the end (after C) or before A.
    seq = [
        _stop("A", -27.500, 153.000),
        _stop("X", -27.450, 153.005),  # 5+ km north — huge zigzag
        _stop("B", -27.501, 153.005),
        _stop("C", -27.502, 153.010),
    ]
    before_km = server._haversine_path_km(seq)
    new_seq, new_pos, _b, after_km = server._relocate_stop_haversine(seq, 1)

    assert after_km < before_km, f"No improvement: {before_km} -> {after_km}"
    # X should NOT be at index 1 anymore (we moved it)
    assert new_seq[new_pos]["id"] == "X"
    assert new_pos != 1


def test_iterative_tighten_strictly_decreases_path():
    """Multiple passes should keep reducing the path until convergence."""
    import server

    # Three spikes in a row — each pass picks the worst.
    seq = [
        _stop("A", -27.500, 153.000),
        _stop("X1", -27.450, 153.001),
        _stop("B", -27.501, 153.005),
        _stop("X2", -27.460, 153.006),
        _stop("C", -27.502, 153.010),
        _stop("X3", -27.470, 153.012),
        _stop("D", -27.503, 153.015),
    ]
    before_km = server._haversine_path_km(seq)
    cleaned, moves = server._iterative_haversine_tighten(seq, max_passes=10)
    after_km = server._haversine_path_km(cleaned)

    assert moves, "Tightener didn't move anything on a clearly-zigzag route"
    assert after_km < before_km, f"No improvement: {before_km} -> {after_km}"
    # Cleaned sequence should still contain every original stop id
    assert sorted(s["id"] for s in cleaned) == sorted(s["id"] for s in seq)


def test_iterative_tighten_noop_on_clean_route():
    """A clean route must not be mutated and must report zero moves."""
    import server

    seq = [
        _stop("A", -27.500, 153.000),
        _stop("B", -27.500, 153.005),
        _stop("C", -27.500, 153.010),
        _stop("D", -27.500, 153.015),
    ]
    cleaned, moves = server._iterative_haversine_tighten(seq, max_passes=5)
    assert moves == []
    assert [s["id"] for s in cleaned] == ["A", "B", "C", "D"]


def test_post_tighten_warnings_drop():
    """After running the tightener, detector should report fewer warnings."""
    import server

    # Build a route with 2 unambiguous spikes.
    seq = [
        _stop("A", -27.500, 153.000),
        _stop("X1", -27.450, 153.002),
        _stop("B", -27.501, 153.004),
        _stop("C", -27.501, 153.008),
        _stop("X2", -27.460, 153.010),
        _stop("D", -27.501, 153.012),
        _stop("E", -27.501, 153.016),
    ]
    before_warnings = server.detect_cluster_spikes(seq)
    cleaned, _moves = server._iterative_haversine_tighten(seq, max_passes=10)
    after_warnings = server.detect_cluster_spikes(cleaned)
    assert len(after_warnings) < len(before_warnings), (
        f"Warnings went from {len(before_warnings)} to {len(after_warnings)} "
        f"— tightener regressed"
    )
