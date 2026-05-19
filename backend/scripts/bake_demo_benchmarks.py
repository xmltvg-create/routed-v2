"""Bake the 14-solver benchmark used by the /benchmarks demo screen.

Runs every algorithm exposed by /api/optimize/algorithms against the same
50-stop scenario the cinematic flythrough uses, captures runtime and
output quality, and writes a sortable table to
/app/backend/data/demo_benchmarks.json.

Why a separate bake (rather than running the benchmark on demand from the
frontend):
- Each solver call is 500 ms-3 s. Running 12-14 of them serially would be
  ~30 s of dead air on the demo screen — judges scroll past.
- Some solvers (LKH-3, PyVRP HGS) are non-deterministic; baking once with
  a fixed seed makes the table stable across demos so judges who scroll
  it twice see the same numbers.
- The bake hits the live FastAPI process (not the in-process function),
  so the numbers reflect the actual production code path including OSRM
  matrix fetch and Pydantic serialisation.

Run after solver code or scenario changes:
    cd /app/backend && python3 scripts/bake_demo_benchmarks.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/backend/.env")
sys.path.insert(0, "/app/backend")

OUT_PATH = Path("/app/backend/data/demo_benchmarks.json")
SCENARIO_PATH = Path("/app/backend/data/demo_scenario.json")
API_URL = "http://localhost:8001"

# Solvers the demo screen advertises. Curated subset of /api/optimize/algorithms
# — we drop "auto" (it's a meta-router, not a solver) and any that crash on
# 50-stop open-path TSPs. Each row is (id, display_name, family) for the UI.
SOLVERS: list[tuple[str, str, str]] = [
    ("pyvrp", "PyVRP HGS", "Genetic / hybrid"),
    ("ortools", "OR-Tools (Google)", "Constraint programming"),
    ("alns", "ALNS Hybrid", "Adaptive large neighbourhood"),
    ("vroom", "VROOM", "Local search (binary)"),
    ("ils", "Iterated Local Search", "Local search"),
    ("two_opt", "2-Opt", "Local search (classical)"),
    ("three_opt", "3-Opt", "Local search (classical)"),
    ("simulated_annealing", "Simulated Annealing", "Metaheuristic"),
    ("genetic", "Genetic Algorithm", "Metaheuristic"),
    ("clarke_wright", "Clarke-Wright Savings", "Construction"),
    ("nearest_neighbor", "Nearest Neighbour", "Greedy construction"),
    ("generoute", "Generoute", "Construction (CW variant)"),
    ("mapbox", "Mapbox Optimization API", "Cloud (Mapbox)"),
    ("cluster_first", "Cluster-First / Route-Second", "Two-stage"),
]


async def _get_session_token() -> tuple[str, str]:
    """Borrow a real session from MongoDB so /api/optimize accepts the
    request. Bake is dev-only — production never invokes this script.
    Skips fixture rows like `test_session_*` and picks the most recently
    active *real* session — those carry hashed tokens that the auth
    middleware actually validates."""
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    sessions = await db.user_sessions.find(
        {"session_token": {"$not": {"$regex": "^test_"}}}
    ).sort("last_active", -1).to_list(5)
    client.close()
    if not sessions:
        raise RuntimeError(
            "No real user_sessions in MongoDB — sign in to the app once, then re-run."
        )
    return sessions[0]["session_token"], sessions[0]["user_id"]


def _load_scenario() -> dict:
    if not SCENARIO_PATH.exists():
        raise RuntimeError(
            f"{SCENARIO_PATH} not found. Run bake_demo_scenario.py first."
        )
    return json.loads(SCENARIO_PATH.read_text())


async def _run_solver(
    client: httpx.AsyncClient,
    token: str,
    user_id: str,
    stops_payload: list[dict],
    solver_id: str,
) -> dict:
    """Hit /api/optimize once for `solver_id`, return {ok, total_km,
    total_minutes, runtime_ms, error}."""
    body = {"stops": stops_payload, "algorithm": solver_id}
    started = time.monotonic()
    try:
        r = await client.post(
            f"{API_URL}/api/optimize",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=60,
        )
    except Exception as e:
        return {
            "ok": False,
            "error": f"{type(e).__name__}: {e}"[:200],
            "runtime_ms": int((time.monotonic() - started) * 1000),
        }
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if r.status_code != 200:
        return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:120]}",
                "runtime_ms": elapsed_ms}
    try:
        d = r.json()
    except Exception as e:
        return {"ok": False, "error": f"JSON parse: {e}", "runtime_ms": elapsed_ms}
    return {
        "ok": True,
        "total_km": d.get("total_distance_km") or d.get("total_distance") or 0.0,
        "total_minutes": (
            d.get("total_duration_minutes")
            or (d.get("total_duration_seconds", 0) / 60.0 if d.get("total_duration_seconds") else 0.0)
        ),
        "runtime_ms": elapsed_ms,
        "algorithm_used": d.get("algorithm_used") or solver_id,
    }


async def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    scenario = _load_scenario()
    # Re-shape demo stops into the schema /api/optimize expects (it wants
    # `address`, `latitude`, `longitude`, `id`, `order` — exactly what the
    # demo scenario already stores).
    stops_payload = [
        {
            "id": s["id"],
            "address": s["address"],
            "latitude": s["latitude"],
            "longitude": s["longitude"],
            "order": s["order"],
        }
        for s in scenario["stops"]
    ]
    token, user_id = await _get_session_token()
    print(f"Using session {token[:12]}... for {user_id}")
    print(f"Benchmarking {len(SOLVERS)} solvers on {len(stops_payload)} stops...\n")

    results: list[dict] = []
    async with httpx.AsyncClient() as client:
        for solver_id, name, family in SOLVERS:
            print(f"  {solver_id:<24}", end=" ", flush=True)
            res = await _run_solver(client, token, user_id, stops_payload, solver_id)
            row = {
                "id": solver_id,
                "name": name,
                "family": family,
                **res,
            }
            results.append(row)
            if res["ok"]:
                print(f"✓  {res['total_km']:.1f} km  "
                      f"{res['total_minutes']:.0f} min  "
                      f"{res['runtime_ms']} ms")
            else:
                print(f"✗  {res.get('error', 'unknown')}")

    # Compute gap_pct vs the best (lowest km) successful solver — this is
    # the headline-friendly "how much better is the winner" metric.
    successful = [r for r in results if r["ok"] and r["total_km"] > 0]
    best_km = min((r["total_km"] for r in successful), default=0)
    for r in results:
        if r["ok"] and best_km:
            r["gap_pct"] = round(100 * (r["total_km"] - best_km) / best_km, 2)
        else:
            r["gap_pct"] = None

    out = {
        "schema_version": 1,
        "generated_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "scenario": {
            "stop_count": scenario["headline"]["stop_count"],
            "naive_km": scenario["headline"]["naive_km"],
            "naive_minutes": scenario["headline"]["naive_minutes"],
        },
        "best_km": round(best_km, 1) if best_km else None,
        "results": sorted(
            results,
            key=lambda r: (
                0 if r["ok"] else 1,           # successes first
                r.get("total_km") or float("inf"),  # then by quality
            ),
        ),
    }

    OUT_PATH.write_text(json.dumps(out, indent=2))
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"\n✓ Wrote {OUT_PATH} ({size_kb:.1f} KB)")
    print(f"  Best: {best_km:.1f} km  "
          f"({len(successful)}/{len(results)} solvers succeeded)")


if __name__ == "__main__":
    asyncio.run(main())
