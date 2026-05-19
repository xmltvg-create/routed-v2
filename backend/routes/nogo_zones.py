"""No-Go Zone CRUD + polygon-segment intersection helpers.

A "no-go zone" is a user-defined polygon (in `[lng, lat]` order, GeoJSON
convention) that the optimiser must treat as impassable. Use cases:

  • A road OSM still tags as drivable but is closed in real life
    (gates, weight limits, construction).
  • A footbridge OSM has tagged as a road by mistake.
  • A driver-specific avoid (private road, school-zone hours).

Why polygons (not single road IDs)?
  Storing OSM way-ids is brittle: the OSRM extract rebuilds rename
  them, the basemap version differs, and a road segment can be split
  into many ways. A polygon describes the geographic region the user
  cares about, independent of any underlying graph.

How the optimiser honours zones:
  When the OSRM duration matrix is built, every (A, B) pair whose
  direct great-circle leg intersects any zone gets its cost multiplied
  by `_NOGO_PENALTY` (defaults to 1e9). The optimiser will never pick
  a zone-crossing leg unless it has *no* alternative.

Endpoints (all auth-gated):
  GET    /api/nogo-zones                — list the caller's zones
  POST   /api/nogo-zones                — create one
  DELETE /api/nogo-zones/{zone_id}      — delete one (scoped to caller)

Polygon contract:
  • At least 3 vertices, max 1000 (sanity bound).
  • `[[lng, lat], ...]` order — GeoJSON convention. We don't require
    the ring to be closed; we close it implicitly during intersection.
  • Each (lng, lat) must be a finite float in OSM-valid range.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger("server")
router = APIRouter()


_NOGO_PENALTY = 100_000  # cost addend so optimiser avoids
# Why 100_000 (≈ 27 hours)?
#   • Real legs are <2,500 s. 100k is 40× the worst real leg — strong deterrent.
#   • VROOM uses uint32 internally and rejects cost matrices with cells above
#     ~UINT32_MAX/16 (~268 M). At 1e9 the matrix overflowed VROOM with
#     "Too high cost values, stopping to avoid overflowing" and forced a
#     fallback to slower solvers. 100k leaves massive headroom — even 100
#     stacked penalised legs in a tour cost only sums to 10 M, ~430× under
#     the VROOM ceiling.


async def _current_user(request: Request):
    """Same lazy pattern as routes/stops.py — defers the `server` import
    until the first request so this module can load cleanly while
    `server.py` is still being parsed at startup."""
    from server import get_current_user  # noqa: WPS433
    return await get_current_user(request)


_LNG_BOUNDS = (-180.0, 180.0)
_LAT_BOUNDS = (-90.0, 90.0)


class NoGoZoneCreate(BaseModel):
    name: str = Field("", max_length=80)
    polygon: List[List[float]] = Field(..., min_length=3, max_length=1000)

    @field_validator("polygon")
    @classmethod
    def _coords_sane(cls, v: List[List[float]]) -> List[List[float]]:
        for pt in v:
            if len(pt) != 2:
                raise ValueError("each polygon vertex must be [lng, lat]")
            lng, lat = pt
            if not (_LNG_BOUNDS[0] <= lng <= _LNG_BOUNDS[1]):
                raise ValueError(f"lng {lng} outside {_LNG_BOUNDS}")
            if not (_LAT_BOUNDS[0] <= lat <= _LAT_BOUNDS[1]):
                raise ValueError(f"lat {lat} outside {_LAT_BOUNDS}")
        return v


class NoGoZoneOut(BaseModel):
    id: str
    name: str
    polygon: List[List[float]]
    created_at: str


@router.get("/nogo-zones", response_model=List[NoGoZoneOut])
async def list_nogo_zones(current_user=Depends(_current_user)):
    """Return the caller's zones, newest-first."""
    from server import db  # noqa: WPS433
    docs = await db.nogo_zones.find(
        {"user_id": current_user.user_id}, {"_id": 0, "user_id": 0}
    ).sort("created_at", -1).to_list(500)
    return docs


@router.post("/nogo-zones", response_model=NoGoZoneOut)
async def create_nogo_zone(
    payload: NoGoZoneCreate,
    current_user=Depends(_current_user),
):
    from server import db  # noqa: WPS433
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": current_user.user_id,
        "name": payload.name or f"Zone {datetime.now(timezone.utc).strftime('%H:%M')}",
        "polygon": [[float(lng), float(lat)] for lng, lat in payload.polygon],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.nogo_zones.insert_one(doc)
    logger.info(
        "[nogo-zones] user=%s created zone=%s vertices=%d",
        current_user.user_id, doc["id"][:8], len(doc["polygon"]),
    )
    out = {k: v for k, v in doc.items() if k != "user_id"}
    return out


class NoGoZoneFromPoint(BaseModel):
    """One-tap zone creation: pick a point, OSRM snaps it to the nearest
    drivable road, then we buffer the snapped point by `radius_m` (default
    30 m — roughly a single carriageway width)."""
    lat: float
    lng: float
    radius_m: float = Field(30.0, ge=5.0, le=500.0)
    name: str = Field("", max_length=80)

    @field_validator("lat")
    @classmethod
    def _lat_ok(cls, v: float) -> float:
        if not (-90.0 <= v <= 90.0):
            raise ValueError("lat out of range")
        return v

    @field_validator("lng")
    @classmethod
    def _lng_ok(cls, v: float) -> float:
        if not (-180.0 <= v <= 180.0):
            raise ValueError("lng out of range")
        return v


@router.post("/nogo-zones/from-point", response_model=NoGoZoneOut)
async def create_nogo_zone_from_point(
    payload: NoGoZoneFromPoint,
    current_user=Depends(_current_user),
):
    """Create a no-go zone from a single tap.

    Pipeline:
      1. OSRM `/nearest` snap-to-road (so users don't have to land the tap
         exactly on the carriageway). Falls back to the raw tap point if
         OSRM is unreachable — the buffer is wide enough to forgive a
         couple metres of tap inaccuracy.
      2. Build a 16-sided regular polygon of `radius_m` around the snap.
         Cheaper and more predictable than `shapely.buffer` and avoids the
         ImportError fallback path during tests.
    """
    import math
    import os

    snap_lat, snap_lng = float(payload.lat), float(payload.lng)
    # Use the promoted OSRM_URL from server.py (which swaps to
    # OSRM_URL_PROD on production). Deferred import avoids circular
    # dependency (server.py imports this module at startup).
    try:
        from server import OSRM_URL as _osrm
        osrm_url = _osrm
    except ImportError:
        osrm_url = os.environ.get("OSRM_URL", "http://localhost:5000")
    try:
        import httpx  # noqa: WPS433
        async with httpx.AsyncClient(timeout=2.5) as client:
            r = await client.get(
                f"{osrm_url.rstrip('/')}/nearest/v1/driving/"
                f"{snap_lng},{snap_lat}?number=1"
            )
            if r.status_code == 200:
                data = r.json()
                wpts = data.get("waypoints") or []
                if wpts and isinstance(wpts[0].get("location"), list):
                    snap_lng, snap_lat = (
                        float(wpts[0]["location"][0]),
                        float(wpts[0]["location"][1]),
                    )
    except Exception as e:  # noqa: BLE001
        # Snap failure is non-fatal: a tap on a real road is good enough.
        logger.info("[nogo-zones] OSRM snap failed (%s) — using raw tap", e)

    # 16-sided regular polygon centred on the (possibly snapped) point.
    radius_deg_lat = payload.radius_m / 111_000.0
    radius_deg_lng = payload.radius_m / (
        111_000.0 * max(0.01, math.cos(math.radians(snap_lat)))
    )
    n_sides = 16
    polygon = [
        [
            snap_lng + radius_deg_lng * math.cos(2 * math.pi * i / n_sides),
            snap_lat + radius_deg_lat * math.sin(2 * math.pi * i / n_sides),
        ]
        for i in range(n_sides)
    ]

    from server import db  # noqa: WPS433
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": current_user.user_id,
        "name": payload.name or f"Road @ {snap_lat:.4f},{snap_lng:.4f}",
        "polygon": polygon,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.nogo_zones.insert_one(doc)
    logger.info(
        "[nogo-zones] user=%s tap-created zone=%s @ %.5f,%.5f r=%.0fm",
        current_user.user_id, doc["id"][:8], snap_lat, snap_lng, payload.radius_m,
    )
    return {k: v for k, v in doc.items() if k != "user_id"}


@router.delete("/nogo-zones/{zone_id}")
async def delete_nogo_zone(
    zone_id: str,
    current_user=Depends(_current_user),
):
    from server import db  # noqa: WPS433
    result = await db.nogo_zones.delete_one(
        {"id": zone_id, "user_id": current_user.user_id}
    )
    if result.deleted_count == 0:
        raise HTTPException(404, "zone not found")
    logger.info(
        "[nogo-zones] user=%s deleted zone=%s",
        current_user.user_id, zone_id[:8],
    )
    return {"deleted": True}


@router.delete("/nogo-zones")
async def delete_all_nogo_zones(current_user=Depends(_current_user)):
    """Nuke every no-go zone owned by the current user.

    Useful when:
      * The driver decides the whole feature is more trouble than it's
        worth (zones placed around long-since-resolved roadworks now
        forcing the optimiser to take detours forever).
      * Pre-shift cleanup so the next day's manifest starts unconstrained.

    Returns `{deleted: N}` with the exact count purged. No 404 when the
    user had zero zones — the operation is idempotent."""
    from server import db  # noqa: WPS433
    result = await db.nogo_zones.delete_many({"user_id": current_user.user_id})
    logger.info(
        "[nogo-zones] user=%s purged ALL zones (count=%d)",
        current_user.user_id, result.deleted_count,
    )
    return {"deleted": result.deleted_count}



# ── intersection helpers (sync, callable from the matrix builder) ────────

def _zones_to_shapely(zones: List[dict]):
    """Convert stored polygon docs into shapely Polygons (auto-closed).

    Returns an empty list when shapely is unavailable — callers must
    treat that as "no zones, no penalty"."""
    try:
        from shapely.geometry import Polygon  # noqa: WPS433
    except ImportError:
        logger.warning("shapely missing — no-go zones disabled")
        return []
    out = []
    for z in zones or []:
        coords = z.get("polygon") or []
        if len(coords) < 3:
            continue
        out.append(Polygon([(float(lng), float(lat)) for lng, lat in coords]))
    return out


def segment_crosses_any_zone(
    a_lat: float, a_lng: float, b_lat: float, b_lng: float, polygons,
) -> bool:
    """`True` if the great-circle approximation A→B intersects any zone.
    Cartesian distance is good enough for legs <50 km — the granularity
    of a user-drawn polygon dwarfs the great-circle/cartesian deviation."""
    if not polygons:
        return False
    try:
        from shapely.geometry import LineString  # noqa: WPS433
    except ImportError:
        return False
    seg = LineString([(a_lng, a_lat), (b_lng, b_lat)])
    return any(seg.intersects(poly) for poly in polygons)


async def fetch_user_zone_polygons(db_, user_id: str):
    """One round-trip read of a user's zones, returned as shapely
    Polygons ready for matrix-builder consumption."""
    docs = await db_.nogo_zones.find(
        {"user_id": user_id}, {"_id": 0, "polygon": 1}
    ).to_list(500)
    return _zones_to_shapely(docs)


def apply_nogo_penalty(
    matrix: List[List[float]], stops: List[dict], polygons,
) -> int:
    """Mutate `matrix` in place: add `_NOGO_PENALTY` to every cell whose
    great-circle A→B segment intersects any zone polygon. Returns the
    number of cells penalised — useful for log/audit lines.

    The penalty is *additive*, not a multiplier, so stops in the same
    zone (legitimately neighbours) don't multiply their penalty into
    even bigger numbers and accidentally drown out other-zone signals."""
    if not polygons or not matrix or not stops:
        return 0
    n = min(len(stops), len(matrix))
    penalised = 0
    for i in range(n):
        a_lat = stops[i].get("latitude")
        a_lng = stops[i].get("longitude")
        if not isinstance(a_lat, (int, float)) or not isinstance(a_lng, (int, float)):
            continue
        for j in range(n):
            if i == j or len(matrix[i]) <= j:
                continue
            b_lat = stops[j].get("latitude")
            b_lng = stops[j].get("longitude")
            if not isinstance(b_lat, (int, float)) or not isinstance(b_lng, (int, float)):
                continue
            if segment_crosses_any_zone(a_lat, a_lng, b_lat, b_lng, polygons):
                matrix[i][j] = float(matrix[i][j]) + _NOGO_PENALTY
                penalised += 1
    return penalised


# ── OSRM-geometry-aware penalty ─────────────────────────────────────────
#
# The straight-line `apply_nogo_penalty` above is fast (10 µs/cell) but
# miss-prone: if A→B's great-circle line skims past a zone but the
# OSRM-chosen road bends through it (one-way pairs, parkland diagonals,
# the Meridan Way × Rainforest Drive intersection in PR #2026-05-09),
# the penalty doesn't fire and the optimiser happily picks the leg.
#
# To catch those, we additionally fetch the actual OSRM road geometry
# for *near-zone* cells and check the road LineString against each
# polygon. Cost: one OSRM `/route` call per checked cell. To keep this
# affordable on a 167-stop manifest we pre-filter aggressively:
#
#   1. Either A or B must be within `_OSRM_PROBE_RADIUS_KM` of the
#      union bounding box of all zones. Most of the matrix is far away
#      and trivially safe.
#   2. The straight-line A→B must come within `_OSRM_PROBE_RADIUS_KM`
#      of the zone bbox — a real road can't bend more than ~1 km off
#      its straight-line direction in normal urban geometry.
#
# Typical hit rate: 50-200 candidate cells out of 27 k. ~2-5 s extra
# at /api/optimize time, well under solver cost.

_OSRM_PROBE_RADIUS_KM = 1.5
# Concurrency + wall-clock budget for the OSRM-aware probe. Without these,
# a 200-stop manifest with two zones near the cluster centroid can queue
# ~25k probes against remote OSRM (fly.dev), running sequentially → 30+
# minutes wall-clock → client-side 180 s fetch timeout fires → user sees
# "Network request failed" with no route. We accept partial coverage over
# a hung Optimize button: the straight-line stage 1 still catches the
# majority and the budget caps the worst case.
_OSRM_PROBE_CONCURRENCY = 32
_OSRM_PROBE_BUDGET_S = 60.0


def _km_per_degree(lat: float) -> Tuple[float, float]:
    """Crude lat/lng→km conversion at the given latitude. Good enough
    for the bounding-box pre-filter."""
    import math
    return (111.0, 111.0 * math.cos(math.radians(lat)))


def _bbox_of_polygons(polygons) -> Optional[Tuple[float, float, float, float]]:
    """Min/max lng,lat union bbox across all zone polygons. Returns
    `None` if no zones."""
    if not polygons:
        return None
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    for poly in polygons:
        x0, y0, x1, y1 = poly.bounds
        minx = min(minx, x0)
        miny = min(miny, y0)
        maxx = max(maxx, x1)
        maxy = max(maxy, y1)
    return (minx, miny, maxx, maxy)


def _segment_near_bbox(
    a_lat: float, a_lng: float, b_lat: float, b_lng: float,
    bbox: Tuple[float, float, float, float], radius_km: float,
) -> bool:
    """`True` if the segment A→B passes within `radius_km` of `bbox`.

    Cheap: expands the bbox by `radius_km` in both axes and tests
    LineString.intersects(expanded_box). Lets us skip the OSRM probe
    for cells whose direct line is nowhere near the zone."""
    try:
        from shapely.geometry import LineString, box  # noqa: WPS433
    except ImportError:
        return False
    avg_lat = (a_lat + b_lat) / 2
    deg_lat_per_km = 1.0 / 111.0
    deg_lng_per_km = 1.0 / (111.0 * max(0.01, abs(__import__("math").cos(__import__("math").radians(avg_lat)))))
    pad_lat = radius_km * deg_lat_per_km
    pad_lng = radius_km * deg_lng_per_km
    minx, miny, maxx, maxy = bbox
    expanded = box(minx - pad_lng, miny - pad_lat, maxx + pad_lng, maxy + pad_lat)
    return LineString([(a_lng, a_lat), (b_lng, b_lat)]).intersects(expanded)


async def apply_nogo_penalty_osrm_aware(
    matrix: List[List[float]], stops: List[dict], polygons, osrm_url: str,
    httpx_client=None,
) -> int:
    """Augment `apply_nogo_penalty` with OSRM-geometry checks for cells
    whose straight line passes near a zone but doesn't intersect it.

    Returns the count of *additional* cells penalised by the OSRM
    geometry pass (cells already penalised by the straight-line check
    are not re-counted). The straight-line penalty must be applied
    *before* this function — we skip cells that already carry the
    penalty (they're saturated).

    Failures (OSRM down, single 5xx, parse error) are non-fatal — we
    log and skip the cell. A buggy OSRM never makes optimisation worse.
    """
    if not polygons or not matrix or not stops:
        return 0
    bbox = _bbox_of_polygons(polygons)
    if bbox is None:
        return 0
    try:
        from shapely.geometry import LineString  # noqa: WPS433
    except ImportError:
        return 0
    import httpx  # noqa: WPS433

    owned_client = httpx_client is None
    client = httpx_client or httpx.AsyncClient(timeout=5.0)

    n = min(len(stops), len(matrix))
    penalised = 0
    candidates = []  # (i, j, a, b)
    for i in range(n):
        a_lat = stops[i].get("latitude")
        a_lng = stops[i].get("longitude")
        if not isinstance(a_lat, (int, float)) or not isinstance(a_lng, (int, float)):
            continue
        for j in range(n):
            if i == j or len(matrix[i]) <= j:
                continue
            # Skip cells the straight-line pass already saturated.
            if matrix[i][j] >= _NOGO_PENALTY:
                continue
            b_lat = stops[j].get("latitude")
            b_lng = stops[j].get("longitude")
            if not isinstance(b_lat, (int, float)) or not isinstance(b_lng, (int, float)):
                continue
            if not _segment_near_bbox(a_lat, a_lng, b_lat, b_lng, bbox, _OSRM_PROBE_RADIUS_KM):
                continue
            candidates.append((i, j, (a_lat, a_lng), (b_lat, b_lng)))

    logger.info(
        "[nogo-zones] OSRM-aware probe: %d candidate cells (%d total cells)",
        len(candidates), n * (n - 1),
    )

    # Parallelise probes with a bounded semaphore + a wall-clock budget so
    # the optimize call can never be held hostage by the no-go probe. See
    # `_OSRM_PROBE_CONCURRENCY` / `_OSRM_PROBE_BUDGET_S` rationale above.
    import asyncio
    import time as _time
    sem = asyncio.Semaphore(_OSRM_PROBE_CONCURRENCY)
    deadline = _time.monotonic() + _OSRM_PROBE_BUDGET_S
    skipped_budget = 0

    async def _probe(i, j, a_lat, a_lng, b_lat, b_lng):
        nonlocal penalised
        if _time.monotonic() >= deadline:
            return False
        url = (
            f"{osrm_url.rstrip('/')}/route/v1/driving/"
            f"{a_lng},{a_lat};{b_lng},{b_lat}"
            "?overview=full&geometries=geojson"
        )
        try:
            async with sem:
                if _time.monotonic() >= deadline:
                    return False
                r = await client.get(url)
            if r.status_code != 200:
                return True
            data = r.json()
            routes = data.get("routes") or []
            if not routes:
                return True
            geom = routes[0].get("geometry", {}).get("coordinates") or []
            if len(geom) < 2:
                return True
            line = LineString(geom)
            if any(line.intersects(p) for p in polygons):
                matrix[i][j] = float(matrix[i][j]) + _NOGO_PENALTY
                penalised += 1
            return True
        except Exception as e:  # noqa: BLE001
            logger.debug("[nogo-zones] OSRM probe %d→%d skipped: %s", i, j, e)
            return True

    try:
        tasks = [
            _probe(i, j, a_lat, a_lng, b_lat, b_lng)
            for (i, j, (a_lat, a_lng), (b_lat, b_lng)) in candidates
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        skipped_budget = sum(1 for r in results if r is False)
        if skipped_budget:
            logger.warning(
                "[nogo-zones] OSRM probe budget (%.1fs) exhausted — %d/%d cells skipped",
                _OSRM_PROBE_BUDGET_S, skipped_budget, len(candidates),
            )
    finally:
        if owned_client:
            await client.aclose()

    return penalised
