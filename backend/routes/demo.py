"""Public, no-auth /api/demo endpoints powering the hackathon flythrough.

Why a separate router:
- Judges don't have credentials. The whole demo experience must be
  reachable from the login screen without a Google sign-in.
- The scenario is *baked* (see /app/backend/scripts/bake_demo_scenario.py)
  so this endpoint is a static-ish JSON read — no solver call, no OSRM
  hop, no MongoDB write. Latency is tens of milliseconds even on cold start.
- Keeping it in its own router stops the demo path from accidentally
  inheriting the global auth dependency that the rest of /api/* is gated
  by, and gives a single grep point if we ever need to add more demo
  endpoints (benchmarks page, judges' walkthrough, etc.).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

logger = logging.getLogger("server")
router = APIRouter()

_SCENARIO_PATH = Path(__file__).resolve().parents[1] / "data" / "demo_scenario.json"
_BENCHMARKS_PATH = Path(__file__).resolve().parents[1] / "data" / "demo_benchmarks.json"
_cache: dict | None = None
_bench_cache: dict | None = None


def _load_scenario() -> dict:
    """Memo-cache the baked scenario in process. The file is ~165 KB and
    never mutates at runtime, so we hold one parsed copy per worker rather
    than re-reading the disk on every judge tap."""
    global _cache
    if _cache is None:
        if not _SCENARIO_PATH.exists():
            raise HTTPException(
                status_code=503,
                detail=(
                    "Demo scenario not yet baked. Run "
                    "`python3 scripts/bake_demo_scenario.py` and try again."
                ),
            )
        _cache = json.loads(_SCENARIO_PATH.read_text())
    return _cache


def _load_benchmarks() -> dict:
    """Same memo pattern for the 14-solver benchmark table."""
    global _bench_cache
    if _bench_cache is None:
        if not _BENCHMARKS_PATH.exists():
            raise HTTPException(
                status_code=503,
                detail=(
                    "Benchmarks not yet baked. Run "
                    "`python3 scripts/bake_demo_benchmarks.py` and try again."
                ),
            )
        _bench_cache = json.loads(_BENCHMARKS_PATH.read_text())
    return _bench_cache


@router.get("/demo/scenario")
async def demo_scenario() -> dict:
    """Return the baked 50-stop Sunshine Coast scenario plus its full
    OSRM-routed polyline. The frontend animates a synthetic driver dot
    along the polyline at 4× speed and uses the headline stats for the
    "47 minutes saved" overlay at the end of the flythrough."""
    return _load_scenario()


@router.get("/demo/benchmarks")
async def demo_benchmarks() -> dict:
    """Return the 14-solver head-to-head benchmark on a real ~50-stop
    delivery route. Powers the /benchmarks screen — the "technical-
    credibility" exhibit for jury Q&A. Pre-baked because each solver
    takes 10-40 s; running them on demand would burn the demo window."""
    return _load_benchmarks()
