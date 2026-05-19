"""House-number lookup endpoints — `/api/housenumbers` + `/api/housenumbers/prewarm`.

Serves address points for the driving-mode property-number map layer. Primary
upstream is QLD ArcGIS (same MapServer used by `routes/tiles.py`); falls back
to the Overpass API when QLD returns nothing or is rate-limiting.

Split out of `server.py` per the ROUTES.md pattern. This module owns its own
circuit breakers and caches — no shared mutable state with the parent.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Response
from pydantic import BaseModel

from ._constants import QLD_ADDRESS_ARCGIS_URL
from . import _tile_cache as disk_cache

logger = logging.getLogger("server")
router = APIRouter()

# ── Response cache (FIFO) ─────────────────────────────────────────────────
_HOUSENUMBER_CACHE: Dict[str, bytes] = {}
_HOUSENUMBER_CACHE_LIMIT = 256
# Disk TTL: address data changes slowly but not as glacially as parcels.
# 7 days keeps the cache fresh while absorbing ArcGIS outages that last
# hours-to-days (we've seen the portal drop for a whole afternoon).
_DISK_TTL_S = 7 * 24 * 60 * 60

# ── Negative cache / circuit-breakers ─────────────────────────────────────
# When upstream is persistently timing out we must NOT keep trying on every
# map move — that would wedge the driver's UI. Fast-fail subsequent requests
# for a short TTL, then allow one retry.
_OVERPASS_FAIL_UNTIL: float = 0.0
_ARCGIS_FAIL_UNTIL: float = 0.0
_UPSTREAM_COOLDOWN_S = 120.0
_HOUSENUMBER_EMPTY_TTL: Dict[str, float] = {}
_EMPTY_NEG_TTL = 60.0

_OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# Remembers the most-recently-successful mirror so subsequent requests skip
# dead primaries. `overpass-api.de` returns 406 for us persistently while
# `kumi.systems` stays healthy — without this we burn ~300 ms per lookup.
_OVERPASS_LAST_OK: Optional[str] = None

_EMPTY = b'{"type":"FeatureCollection","features":[]}'
_RESP_HEADERS = {"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300"}


def _snap_bbox(lon_min: float, lat_min: float, lon_max: float, lat_max: float,
               grid: float = 0.002) -> tuple[float, float, float, float]:
    """Snap bbox corners to a fixed grid for cache-friendly keys.

    Returns an EXPANDED bbox (floor on mins, ceil on maxes) so any small bbox
    inside the grid cell maps to the same snapped result. At `grid=0.002`
    (~222 m) a driver panning inside one cell shares one cache entry and one
    upstream request, instead of issuing a new ArcGIS call every ~11 m of
    movement. The expanded bbox is also fed to the upstream query so the
    ArcGIS response covers the whole cell — not just the visible viewport.
    """
    return (
        math.floor(lon_min / grid) * grid,
        math.floor(lat_min / grid) * grid,
        math.ceil(lon_max / grid) * grid,
        math.ceil(lat_max / grid) * grid,
    )


def _bbox_key(lon_min: float, lat_min: float, lon_max: float, lat_max: float) -> str:
    return f"{lon_min:.4f},{lat_min:.4f},{lon_max:.4f},{lat_max:.4f}"


async def _fetch_housenumbers_overpass(
    lon_min: float, lat_min: float, lon_max: float, lat_max: float, limit: int,
) -> Optional[Dict[str, Any]]:
    """Worldwide OSM fallback — queries `addr:housenumber` nodes via Overpass.
    Hard time budget: 6 s total across mirrors. Respects the circuit breaker."""
    global _OVERPASS_FAIL_UNTIL, _OVERPASS_LAST_OK
    now = time.monotonic()
    if now < _OVERPASS_FAIL_UNTIL:
        return None

    deadline = now + 6.0
    q = (
        '[out:json][timeout:5];'
        f'node["addr:housenumber"]({lat_min},{lon_min},{lat_max},{lon_max});'
        f'out {max(50, min(limit, 1000))};'
    )
    # Reorder so the last-successful mirror is tried first.
    endpoints = list(_OVERPASS_ENDPOINTS)
    if _OVERPASS_LAST_OK and _OVERPASS_LAST_OK in endpoints:
        endpoints.remove(_OVERPASS_LAST_OK)
        endpoints.insert(0, _OVERPASS_LAST_OK)
    any_attempted = False
    any_succeeded = False
    for url in endpoints:
        remaining = deadline - time.monotonic()
        if remaining < 1.5:
            break
        any_attempted = True
        try:
            async with httpx.AsyncClient(timeout=remaining) as client:
                resp = await client.post(url, data={"data": q})
                if resp.status_code != 200:
                    logger.info("Overpass %s returned HTTP %d — trying next mirror", url, resp.status_code)
                    continue
                data = resp.json()
                any_succeeded = True
                _OVERPASS_LAST_OK = url
        except Exception as e:
            # Per-mirror failure is normal — we try the next mirror and only
            # warn once if ALL mirrors fail (handled below via the breaker).
            logger.info("Overpass endpoint %s failed: %s — trying next mirror", url, e)
            continue

        features = []
        for el in data.get("elements", []) or []:
            try:
                hn = (el.get("tags") or {}).get("addr:housenumber")
                if not hn:
                    continue
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [el["lon"], el["lat"]]},
                    "properties": {
                        "housenumber": str(hn).strip(),
                        "street_name": (el.get("tags") or {}).get("addr:street"),
                    },
                })
            except Exception:
                continue
        return {"type": "FeatureCollection", "features": features}

    if any_attempted and not any_succeeded:
        _OVERPASS_FAIL_UNTIL = time.monotonic() + _UPSTREAM_COOLDOWN_S
        # INFO not WARNING — we have ArcGIS primary, disk cache, and a
        # negative-TTL fallback. Tripping the breaker is a planned, recoverable
        # state, not an alarm. See routes/housenumbers.py for the fallback chain.
        logger.info("Overpass circuit-breaker tripped for %.0fs (using ArcGIS + disk cache fallback)", _UPSTREAM_COOLDOWN_S)
    return None


@router.get("/housenumbers")
async def get_housenumbers_bbox(bbox: str, limit: int = 400):
    """Return address points inside `bbox` (lon_min,lat_min,lon_max,lat_max)."""
    try:
        parts = [float(p) for p in bbox.split(",")]
        if len(parts) != 4:
            raise ValueError("bbox must be 4 comma-separated numbers")
        lon_min, lat_min, lon_max, lat_max = parts
    except Exception:
        return Response(
            content=b'{"error":"bbox must be lon_min,lat_min,lon_max,lat_max"}',
            status_code=400, media_type="application/json", headers=_RESP_HEADERS,
        )

    span_lon = lon_max - lon_min
    span_lat = lat_max - lat_min
    if span_lon <= 0 or span_lat <= 0 or span_lon > 0.05 or span_lat > 0.05:
        return Response(content=_EMPTY, media_type="application/json", headers=_RESP_HEADERS)

    # Snap to a ~222 m grid so panning inside one cell reuses one cache entry
    # + one upstream call. Without this the cache missed on every ~11 m of
    # driver movement (2026-04-29 incident — 1 ArcGIS call/sec in prod).
    snap_lon_min, snap_lat_min, snap_lon_max, snap_lat_max = _snap_bbox(
        lon_min, lat_min, lon_max, lat_max,
    )
    cache_key = _bbox_key(snap_lon_min, snap_lat_min, snap_lon_max, snap_lat_max) + f":{limit}"
    cached = _HOUSENUMBER_CACHE.get(cache_key)
    if cached is not None:
        return Response(content=cached, media_type="application/json", headers=_RESP_HEADERS)

    # Disk cache — survives restarts, shields us from ArcGIS 500s and the
    # Overpass breaker. Same bbox+limit always hashes to the same key, so
    # two drivers planning the same area both hit the disk cache.
    disk_key = f"housenumbers:{cache_key}"
    disk_hit = await disk_cache.get(disk_key, max_age_s=_DISK_TTL_S)
    if disk_hit is not None:
        _HOUSENUMBER_CACHE[cache_key] = disk_hit[0]
        return Response(content=disk_hit[0], media_type="application/json", headers=_RESP_HEADERS)

    now_mono = time.monotonic()
    neg_exp = _HOUSENUMBER_EMPTY_TTL.get(cache_key)
    if neg_exp and neg_exp > now_mono:
        return Response(content=_EMPTY, media_type="application/json", headers=_RESP_HEADERS)

    params = {
        "where": "1=1",
        "geometry": f"{snap_lon_min},{snap_lat_min},{snap_lon_max},{snap_lat_max}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "outSR": "4326",
        "outFields": "street_number,street_name,street_type",
        "f": "geojson",
        "resultRecordCount": str(max(50, min(limit, 1000))),
    }
    payload: Optional[Dict[str, Any]] = None
    global _ARCGIS_FAIL_UNTIL
    if now_mono >= _ARCGIS_FAIL_UNTIL:
        try:
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
                resp = await client.get(QLD_ADDRESS_ARCGIS_URL, params=params)
                if resp.status_code == 200:
                    try:
                        payload = resp.json()
                    except Exception:
                        payload = None
                elif resp.status_code in (301, 302, 307, 308, 503, 504):
                    _ARCGIS_FAIL_UNTIL = time.monotonic() + _UPSTREAM_COOLDOWN_S
                    logger.info("ArcGIS returned HTTP %d — breaker tripped %.0fs",
                                resp.status_code, _UPSTREAM_COOLDOWN_S)
        except Exception as e:
            _ARCGIS_FAIL_UNTIL = time.monotonic() + _UPSTREAM_COOLDOWN_S
            # INFO not WARNING — Overpass + disk cache cover the gap. ArcGIS
            # outages are routine (QLD MapServer reboots, transient TLS), and
            # tripping the breaker is the planned recovery path.
            logger.info("housenumbers ArcGIS fetch failed %s: %s — breaker tripped (Overpass fallback active)", cache_key, e)

    if not payload or not payload.get("features"):
        payload = await _fetch_housenumbers_overpass(
            snap_lon_min, snap_lat_min, snap_lon_max, snap_lat_max, int(limit)
        )
        if payload is None:
            _HOUSENUMBER_EMPTY_TTL[cache_key] = time.monotonic() + _EMPTY_NEG_TTL
            return Response(content=_EMPTY, media_type="application/json", headers=_RESP_HEADERS)

    # Normalise `street_number` → `housenumber` for the MapLibre layer.
    for feat in payload.get("features", []) or []:
        props = feat.get("properties") or {}
        sn = props.get("street_number")
        if sn is not None and str(sn).strip():
            props["housenumber"] = str(sn).strip()
        feat["properties"] = props

    body = json.dumps(payload).encode("utf-8")

    # FIFO cache trim
    if len(_HOUSENUMBER_CACHE) >= _HOUSENUMBER_CACHE_LIMIT:
        to_drop = list(_HOUSENUMBER_CACHE.keys())[: _HOUSENUMBER_CACHE_LIMIT // 4]
        for k in to_drop:
            _HOUSENUMBER_CACHE.pop(k, None)
    _HOUSENUMBER_CACHE[cache_key] = body

    # Persist the normalised payload (not the raw ArcGIS response) so the
    # disk hit skips the `street_number → housenumber` massage next time.
    # Only cache non-empty bodies — empty results stay in the short-lived
    # negative TTL dict above so we retry promptly when data is added.
    if payload.get("features"):
        await disk_cache.put(disk_key, body, "application/json")

    return Response(content=body, media_type="application/json", headers=_RESP_HEADERS)


# ── Prewarm the housenumbers cache along a route ─────────────────────────
class HouseNumberPrewarmReq(BaseModel):
    coordinates: List[List[float]]
    polyline: Optional[List[List[float]]] = None
    radius: float = 0.002
    sample_spacing_m: float = 200.0


def _sample_polyline(coords: List[List[float]], spacing_m: float) -> List[List[float]]:
    """Walk the polyline and emit a point every `spacing_m` metres."""
    if not coords or len(coords) < 2:
        return list(coords or [])
    out: List[List[float]] = [coords[0]]
    accumulated = 0.0
    prev = coords[0]
    for pt in coords[1:]:
        lon1, lat1 = prev[0], prev[1]
        lon2, lat2 = pt[0], pt[1]
        lat_mid = math.radians((lat1 + lat2) * 0.5)
        dx = (lon2 - lon1) * math.cos(lat_mid) * 111_320.0
        dy = (lat2 - lat1) * 110_540.0
        seg_len = math.hypot(dx, dy)
        if seg_len <= 0:
            prev = pt
            continue
        while accumulated + seg_len >= spacing_m:
            remaining = spacing_m - accumulated
            t = remaining / seg_len
            lon = lon1 + (lon2 - lon1) * t
            lat = lat1 + (lat2 - lat1) * t
            out.append([lon, lat])
            lon1, lat1 = lon, lat
            dx2 = (lon2 - lon1) * math.cos(lat_mid) * 111_320.0
            dy2 = (lat2 - lat1) * 110_540.0
            seg_len = math.hypot(dx2, dy2)
            accumulated = 0.0
        accumulated += seg_len
        prev = pt
    if out[-1] != coords[-1]:
        out.append(coords[-1])
    return out


@router.post("/housenumbers/prewarm")
async def prewarm_housenumbers(req: HouseNumberPrewarmReq):
    """Concurrently warm the cache for each stop + sampled route points."""
    stops = [c for c in (req.coordinates or []) if isinstance(c, list) and len(c) >= 2]
    stops = stops[:80]
    radius = max(0.0005, min(req.radius, 0.01))

    all_points: List[List[float]] = list(stops)
    if req.polyline:
        sampled = _sample_polyline(
            [c for c in req.polyline if isinstance(c, list) and len(c) >= 2],
            max(50.0, min(req.sample_spacing_m, 1000.0)),
        )
        all_points.extend(sampled)

    if not all_points:
        return {"warmed": 0, "skipped": 0, "total": 0}

    seen: set = set()
    unique_points: List[List[float]] = []
    for p in all_points:
        key = _bbox_key(*_snap_bbox(p[0] - radius, p[1] - radius, p[0] + radius, p[1] + radius))
        if key in seen:
            continue
        seen.add(key)
        unique_points.append(p)
        if len(unique_points) >= 200:
            break

    async def _warm_one(lng: float, lat: float) -> bool:
        try:
            resp = await get_housenumbers_bbox(
                bbox=f"{lng - radius},{lat - radius},{lng + radius},{lat + radius}",
                limit=200,
            )
            return bool(resp and getattr(resp, "status_code", 200) < 400)
        except Exception:
            return False

    tasks = [asyncio.create_task(_warm_one(float(c[0]), float(c[1]))) for c in unique_points]
    try:
        results = await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True), timeout=10.0,
        )
    except asyncio.TimeoutError:
        results = []
    warmed = sum(1 for r in results if r is True)
    return {
        "warmed": warmed,
        "skipped": len(unique_points) - warmed,
        "total": len(unique_points),
        "sampled_from_route": max(0, len(unique_points) - len(stops)),
    }
