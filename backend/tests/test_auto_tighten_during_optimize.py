"""Regression tests for the auto-tightening pass that runs INSIDE
`/api/optimize` post-solve. The user reported that PyVRP was producing
visually fragmented routes (stop 14 sandwiched between southern stops
12-13 and 15-16), so we now run `_iterative_haversine_tighten` after the
solver and silently swap to the cleaned sequence whenever OSRM agrees
the driving time isn't worse.

These tests exercise the helper directly (no /api/optimize HTTP call) so
they're fast and don't depend on OSRM. The HTTP-level behaviour is
covered by the existing optimize integration tests.
"""
import sys
from pathlib import Path

# Make /app/backend importable when run from /app/backend/tests
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import _iterative_haversine_tighten, detect_cluster_spikes  # noqa: E402


def _stop(idx: int, lat: float, lng: float) -> dict:
    return {"id": f"s{idx}", "latitude": lat, "longitude": lng}


def test_screenshot_zigzag_is_resolved_by_iterative_tighten():
    """Reproduce the user's reported bug from the Beerburrum St screenshot:
    the optimised order visits 11 (north), 12-13 (south), 14 (back north),
    15-16 (south-west). After auto-tighten the spike at index of 14 should
    relocate so consecutive triplets no longer flag.

    Coordinates are approximated from the screenshot for the test — the
    exact lat/lng don't matter, only the relative geography (one northern
    point and several southern points with a single spike in the middle).
    """
    seq = [
        _stop(11, -26.7868, 153.1196),  # far NE
        _stop(12, -26.7977, 153.0986),  # S
        _stop(13, -26.7965, 153.0976),  # S (close to 12)
        _stop(14, -26.7700, 153.0985),  # way back N (the spike)
        _stop(15, -26.7912, 153.0926),  # SW
        _stop(16, -26.7943, 153.0926),  # S of 15
    ]
    initial_warnings = detect_cluster_spikes(seq)
    assert initial_warnings, "fixture must contain a real spike to fix"

    cleaned, moves = _iterative_haversine_tighten(seq)
    assert moves, "tighten should have relocated at least one spike"
    final_warnings = detect_cluster_spikes(cleaned)
    assert len(final_warnings) < len(initial_warnings)


def test_already_clean_route_is_a_no_op():
    """Monotonic west-to-east stops on the same latitude have no spikes;
    auto-tighten must not invent moves on a clean route."""
    seq = [
        _stop(i, -26.79, 153.10 + i * 0.005) for i in range(8)
    ]
    assert detect_cluster_spikes(seq) == []
    cleaned, moves = _iterative_haversine_tighten(seq)
    assert moves == []
    assert [s["id"] for s in cleaned] == [s["id"] for s in seq]


def test_tighten_terminates_under_max_passes():
    """Pathological route designed to reveal one spike at a time. Passes
    bound prevents infinite oscillation."""
    seq = [
        _stop(0, -26.78, 153.10),
        _stop(1, -26.80, 153.10),  # south spike
        _stop(2, -26.78, 153.11),
        _stop(3, -26.80, 153.11),  # south spike
        _stop(4, -26.78, 153.12),
        _stop(5, -26.80, 153.12),  # south spike
        _stop(6, -26.78, 153.13),
    ]
    cleaned, moves = _iterative_haversine_tighten(seq, max_passes=10)
    # Must converge — no exception thrown, finite moves.
    assert len(moves) <= 10
    # And the final haversine path must be no worse than the input.
    from server import _haversine_path_km
    assert _haversine_path_km(cleaned) <= _haversine_path_km(seq) + 1e-6


def test_tighten_returns_same_stops_no_loss():
    """The relocator must never drop or duplicate a stop."""
    seq = [
        _stop(11, -26.7868, 153.1196),
        _stop(12, -26.7977, 153.0986),
        _stop(13, -26.7965, 153.0976),
        _stop(14, -26.7868, 153.0985),
        _stop(15, -26.7912, 153.0926),
        _stop(16, -26.7943, 153.0926),
    ]
    cleaned, _ = _iterative_haversine_tighten(seq)
    assert sorted(s["id"] for s in cleaned) == sorted(s["id"] for s in seq)
    assert len(cleaned) == len(seq)


# ── _osrm_verify_relocation tolerance behaviour ─────────────────────────────
# These tests stub out `calculate_duration_matrix` so we can directly verify
# how `slack_seconds` / `slack_ratio` decide whether a visually cleaner route
# is accepted even when OSRM thinks it's marginally slower.
import asyncio  # noqa: E402

import server as srv  # noqa: E402


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _matrix_stub(matrix):
    async def _fake(_seq):
        return matrix
    return _fake


# All five tests below patch the OSRM duration-matrix fetcher used by
# `_osrm_verify_relocation`. Each test sets `srv.calculate_duration_matrix`
# too, kept for backwards-compat in case the implementation falls back.
def _patch_matrix(monkeypatch, matrix):
    monkeypatch.setattr(srv, "_osrm_duration_matrix", _matrix_stub(matrix))
    monkeypatch.setattr(srv, "calculate_duration_matrix", _matrix_stub(matrix))


# Helper that builds a duration matrix indexed by `proposed_seq` order so the
# id_to_row map inside `_osrm_verify_relocation` maps cleanly.
def _build_matrix(stop_ids, edges):
    """edges: dict {(from_id, to_id): seconds}. Missing entries default to 0."""
    n = len(stop_ids)
    mat = [[0] * n for _ in range(n)]
    idx = {sid: i for i, sid in enumerate(stop_ids)}
    for (a, b), sec in edges.items():
        mat[idx[a]][idx[b]] = sec
    return mat


def test_verify_keeps_proposed_when_strictly_faster(monkeypatch):
    # original=[A,B,C] uses A→B(100) + B→C(100) = 200s,
    # proposed=[A,C,B] uses A→C(20) + C→B(20) = 40s — strictly faster.
    A, B, C = ({"id": "A"}, {"id": "B"}, {"id": "C"})
    proposed = [A, C, B]
    matrix = _build_matrix(
        [s["id"] for s in proposed],
        {("A", "B"): 100, ("B", "C"): 100, ("A", "C"): 20, ("C", "B"): 20},
    )
    _patch_matrix(monkeypatch, matrix)
    chosen, before, after, rolled = _run(
        srv._osrm_verify_relocation([A, B, C], proposed)
    )
    assert rolled is False
    assert [s["id"] for s in chosen] == ["A", "C", "B"]
    assert before == 200 and after == 40


def test_verify_rolls_back_when_slower_with_no_slack(monkeypatch):
    # original=[A,B,C] = 100s; proposed=[A,C,B] = 200s; default slack=0.
    A, B, C = ({"id": "A"}, {"id": "B"}, {"id": "C"})
    proposed = [A, C, B]
    matrix = _build_matrix(
        [s["id"] for s in proposed],
        {("A", "B"): 50, ("B", "C"): 50, ("A", "C"): 100, ("C", "B"): 100},
    )
    _patch_matrix(monkeypatch, matrix)
    chosen, before, after, rolled = _run(
        srv._osrm_verify_relocation([A, B, C], proposed)
    )
    assert rolled is True
    assert [s["id"] for s in chosen] == ["A", "B", "C"]
    assert before == 100 and after == 200


def test_verify_accepts_slower_route_within_slack_seconds(monkeypatch):
    # original=100s, proposed=200s (Δ=100s). slack_seconds=120 → accept.
    A, B, C = ({"id": "A"}, {"id": "B"}, {"id": "C"})
    proposed = [A, C, B]
    matrix = _build_matrix(
        [s["id"] for s in proposed],
        {("A", "B"): 50, ("B", "C"): 50, ("A", "C"): 100, ("C", "B"): 100},
    )
    _patch_matrix(monkeypatch, matrix)
    chosen, before, after, rolled = _run(
        srv._osrm_verify_relocation(
            [A, B, C], proposed, slack_seconds=120,
        )
    )
    assert rolled is False
    assert [s["id"] for s in chosen] == ["A", "C", "B"]


def test_verify_accepts_slower_route_within_slack_ratio(monkeypatch):
    # original=1000s, proposed=1029s (+2.9%); slack_ratio=0.03 → accept.
    A, B, C = ({"id": "A"}, {"id": "B"}, {"id": "C"})
    proposed = [A, C, B]
    matrix = _build_matrix(
        [s["id"] for s in proposed],
        {
            ("A", "B"): 500, ("B", "C"): 500,
            ("A", "C"): 514, ("C", "B"): 515,
        },
    )
    _patch_matrix(monkeypatch, matrix)
    chosen, before, after, rolled = _run(
        srv._osrm_verify_relocation(
            [A, B, C], proposed, slack_ratio=0.03,
        )
    )
    assert rolled is False
    assert before == 1000 and after == 1029


def test_verify_rolls_back_beyond_slack_threshold(monkeypatch):
    # original=1000s, proposed=1100s (Δ=100s). Cap = max(90, 1000*0.03) = 90s.
    # 100s > 90s → roll back.
    A, B, C = ({"id": "A"}, {"id": "B"}, {"id": "C"})
    proposed = [A, C, B]
    matrix = _build_matrix(
        [s["id"] for s in proposed],
        {
            ("A", "B"): 500, ("B", "C"): 500,
            ("A", "C"): 550, ("C", "B"): 550,
        },
    )
    _patch_matrix(monkeypatch, matrix)
    chosen, before, after, rolled = _run(
        srv._osrm_verify_relocation(
            [A, B, C], proposed, slack_seconds=90, slack_ratio=0.03,
        )
    )
    assert rolled is True
    assert [s["id"] for s in chosen] == ["A", "B", "C"]
    assert before == 1000 and after == 1100
