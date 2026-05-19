"""Regression tests for `detect_cluster_spikes` (post-solve visual sanity).

The detector flags any consecutive triplet (A, B, C) in the optimised route
where the straight-line A→C distance is small relative to the detour
A→B→C — i.e. B is a geographic spike. The function is read-only and never
mutates the route; the frontend uses its output to surface a "tighten
cluster?" hint to the driver.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import detect_cluster_spikes  # noqa: E402


def _stop(sid: str, lat: float, lon: float) -> dict:
    return {"id": sid, "latitude": lat, "longitude": lon, "name": sid}


def test_clean_linear_route_yields_no_warnings():
    """A straight east-west walk has no spikes."""
    stops = [_stop(f"s{i}", -26.65, 153.09 + 0.005 * i) for i in range(8)]
    assert detect_cluster_spikes(stops) == []


def test_obvious_spike_is_flagged():
    """B sticks 5 km north of the A→C line — must be flagged."""
    stops = [
        _stop("A", -26.65, 153.09),
        _stop("SPIKE", -26.60, 153.095),  # ~5.5 km north of the A↔C line
        _stop("C", -26.65, 153.10),
    ]
    out = detect_cluster_spikes(stops)
    assert len(out) == 1
    w = out[0]
    assert w["position"] == 1
    assert w["prev_id"] == "A"
    assert w["suspect_id"] == "SPIKE"
    assert w["next_id"] == "C"
    assert w["ratio"] < 0.3
    assert w["extra_km"] > 5.0  # detour costs ≥5 km of useless driving
    assert w["straight_km"] < w["detour_km"]


def test_short_detours_are_ignored():
    """Sub-150 m detours don't trip the floor — micro-noise."""
    # 30 m, 30 m, 30 m triangle; ratio is bad but distance is tiny.
    stops = [
        _stop("A", -26.6500, 153.0900),
        _stop("B", -26.6502, 153.0901),
        _stop("C", -26.6500, 153.0902),
    ]
    assert detect_cluster_spikes(stops) == []


def test_returns_list_of_dicts_with_required_keys():
    stops = [
        _stop("A", -26.65, 153.09),
        _stop("B", -26.60, 153.095),
        _stop("C", -26.65, 153.10),
        _stop("D", -26.65, 153.11),
    ]
    out = detect_cluster_spikes(stops)
    assert isinstance(out, list)
    if out:
        for w in out:
            assert {"position", "prev_id", "suspect_id", "next_id",
                    "straight_km", "detour_km", "ratio", "extra_km"} <= w.keys()


def test_handles_short_inputs_gracefully():
    assert detect_cluster_spikes([]) == []
    assert detect_cluster_spikes([_stop("A", 0, 0)]) == []
    assert detect_cluster_spikes([_stop("A", 0, 0), _stop("B", 1, 1)]) == []


def test_skips_triplets_with_missing_coords():
    """A stop missing lat/lon shouldn't crash the sweep."""
    stops = [
        _stop("A", -26.65, 153.09),
        {"id": "no_coords", "name": "broken"},  # no latitude/longitude keys
        _stop("C", -26.65, 153.10),
        _stop("D", -26.65, 153.11),
    ]
    # Should silently skip the bad triplet and still process (B, C, D).
    out = detect_cluster_spikes(stops)
    # No spikes between proper coords; the bad triplet is skipped.
    assert all(w["suspect_id"] != "no_coords" for w in out)


def test_does_not_mutate_input():
    stops = [
        _stop("A", -26.65, 153.09),
        _stop("B", -26.60, 153.095),
        _stop("C", -26.65, 153.10),
    ]
    snapshot = [dict(s) for s in stops]
    detect_cluster_spikes(stops)
    assert stops == snapshot
