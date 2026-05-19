"""Regression test: the auto-tighten OSRM slack tier inside /api/optimize
MUST stay at the unified (90 s / 3 %) baseline.

Background
----------
2026-05-10 — a previous session widened the auto-tighten slack to
(240 s / 5 %) for ≥150-stop routes, on the hypothesis that more spikes
need more cumulative budget on the OSRM verifier.

2026-05-11 — the user reported "the tightening is making the route
worse" on production runs >150 stops. Audit: the wider slack on a
6-hour route allowed up to 18 min of accepted slowdown, which was
enough for OSRM to wave through 2-opt swaps that displaced individual
stops INTO neighbouring clusters. The tightener has no
cluster-locality guard — the small OSRM slack budget IS the
locality guard. Widening it disables that guard.

This test pins the unified (90 s / 3 %) baseline so the constants
can't silently drift again. If a future session genuinely wants to
allow wider cleanups on big routes, the right fix is a
cluster-locality guard inside the move generator (cap relocate
displacement to within X km of original neighbours), NOT a larger
OSRM slack. Update this comment and the test when that lands.

Strategy
--------
Read the source of `optimize_route` and assert the literal slack
values. This is a code-shape test, not a runtime test — running the
full optimize pipeline against a mocked OSRM is fragile and slow.
The values themselves are what cause the regression; the behavioural
surface is exercised in production every day.
"""
from __future__ import annotations

import inspect
import re

import server


def _optimize_source() -> str:
    return inspect.getsource(server.optimize_route)


def test_auto_tighten_uses_unified_90s_3pct_slack():
    """The auto-tighten OSRM verify call inside /api/optimize must pass
    slack_seconds=90 and slack_ratio=0.03. Anything wider re-introduces
    the cross-cluster contamination regression from 2026-05-11."""
    src = _optimize_source()
    pattern = re.compile(
        r"_osrm_verify_relocation\(\s*"
        r"optimized_stops,\s*cleaned,\s*"
        r"slack_seconds\s*=\s*(\d+)\s*,\s*"
        r"slack_ratio\s*=\s*([\d.]+)\s*,?\s*\)",
        re.MULTILINE,
    )
    matches = pattern.findall(src)
    assert len(matches) == 1, (
        f"expected exactly one auto-tighten OSRM verify call inside "
        f"/api/optimize; found {len(matches)}. If you added another "
        f"call site, update this regression test."
    )
    slack_s, slack_r = matches[0]
    assert int(slack_s) == 90, (
        f"auto-tighten slack_seconds drifted to {slack_s}; expected 90. "
        f"Wider slack accepts cross-cluster relocations on big routes — "
        f"see the comment in server.py near this call site."
    )
    assert float(slack_r) == 0.03, (
        f"auto-tighten slack_ratio drifted to {slack_r}; expected 0.03. "
        f"On a 6-hour 200-stop route, 5 % allows 18 min of slowdown "
        f"and disables the cluster-locality guard."
    )


def test_no_per_route_size_slack_branch():
    """There must not be an `if len(optimized_stops) >= 150` branch
    selecting a wider slack tier — that branch is exactly the
    2026-05-11 regression."""
    src = _optimize_source()
    bad_pattern = re.compile(
        r"if\s+len\(optimized_stops\)\s*>=\s*\d+\s*:\s*\n\s*"
        r"slack_s\s*,\s*slack_r\s*="
    )
    assert not bad_pattern.search(src), (
        "found a per-route-size slack tier branch — this is exactly "
        "the 2026-05-11 regression. Use a unified (90 s / 3 %) slack "
        "across all route sizes."
    )


def test_manual_tighten_remains_strict():
    """Manual /tighten endpoints (when a driver explicitly taps
    Tighten) must NEVER accept slack >0 — an explicit user request
    must produce a route that's strictly not slower on driving time.
    Verified via the `_osrm_verify_relocation` default signature."""
    src = inspect.getsource(server)
    sig_match = re.search(
        r"async\s+def\s+_osrm_verify_relocation\(\s*"
        r"original_seq:\s*List\[dict\],\s*"
        r"proposed_seq:\s*List\[dict\],\s*"
        r"slack_seconds:\s*int\s*=\s*(\d+),\s*"
        r"slack_ratio:\s*float\s*=\s*([\d.]+),",
        src,
    )
    assert sig_match, "could not locate _osrm_verify_relocation signature"
    default_s, default_r = sig_match.groups()
    assert int(default_s) == 0, (
        f"_osrm_verify_relocation slack_seconds default drifted to "
        f"{default_s}; expected 0 (strict)."
    )
    assert float(default_r) == 0.0, (
        f"_osrm_verify_relocation slack_ratio default drifted to "
        f"{default_r}; expected 0.0 (strict)."
    )
