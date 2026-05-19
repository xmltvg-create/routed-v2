"""QLD cadastral tile endpoints — parcels & addresses.

Split out of `server.py` so the monolith doesn't keep ballooning. These two
endpoints proxy the QLD ArcGIS MapServer with an in-memory tile cache, fail
fast with empty GeoJSON on upstream outages, and avoid caching failures so
auto-recovery is automatic when the QLD portal comes back.
"""
from __future__ import annotations

import logging
import math
from typing import Dict

import httpx
from fastapi import APIRouter, Response

from ._constants import QLD_PARCEL_ARCGIS_URL, QLD_ADDRESS_ARCGIS_URL
from . import _tile_cache as disk_cache

logger = logging.getLogger("server")
router = APIRouter()

# ── Module-level caches ────────────────────────────────────────────────────
# Two-tier: in-memory dict (warm, current process) → SQLite on disk (cold,
# fork-surviving). The disk cache is shared with `housenumbers.py` so raw
# ArcGIS fetches for the same tile are deduped across endpoints.
_parcel_cache: Dict[str, bytes] = {}
_address_cache: Dict[str, bytes] = {}
# Disk-cache TTLs: cadastre updates slowly, so a 30-day TTL is generous and
# still bounded for the (rare) case where a lot plan actually changes.
_DISK_TTL_S = 30 * 24 * 60 * 60

_EMPTY = b'{"type":"FeatureCollection","features":[]}'
_OK_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600",
}
_UPSTREAM_DOWN_HEADERS = {
    **_OK_HEADERS,
    "X-Upstream-Status": "unavailable",
    "Cache-Control": "public, max-age=60",
}


def _tile_to_bbox(z: int, x: int, y: int):
    """Convert tile coordinates to lng/lat bounding box."""
    n = 2.0 ** z
    lon_min = x / n * 360.0 - 180.0
    lon_max = (x + 1) / n * 360.0 - 180.0
    lat_max = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_min = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lon_min, lat_min, lon_max, lat_max


async def _fetch_arcgis_tile(url: str, z: int, x: int, y: int, fields: str) -> bytes | None:
    """Fetch one tile from ArcGIS MapServer. Returns raw GeoJSON bytes or
    None on any upstream failure (timeout, non-200, non-JSON maintenance
    page). Callers decide whether to cache failures (they shouldn't — we
    want auto-recovery when upstream returns)."""
    lon_min, lat_min, lon_max, lat_max = _tile_to_bbox(z, x, y)
    params = {
        "where": "1=1",
        "geometry": f"{lon_min},{lat_min},{lon_max},{lat_max}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "outSR": "4326",
        "outFields": fields,
        "f": "geojson",
        "resultRecordCount": "2000",
    }
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
            resp = await client.get(url, params=params)
            if resp.status_code != 200:
                logger.warning(
                    "ArcGIS upstream %s returned HTTP %s for %s/%s/%s — portal may be down",
                    url, resp.status_code, z, x, y,
                )
                return None
            ct = resp.headers.get("content-type", "")
            if "json" in ct.lower() or resp.content.lstrip().startswith(b"{"):
                return resp.content
            logger.warning(
                "ArcGIS upstream returned 200 but non-JSON (likely maintenance page). CT=%s",
                ct,
            )
    except Exception as e:
        logger.warning("ArcGIS tile fetch failed %s/%s/%s: %s", z, x, y, e)
    return None


@router.get("/tiles/parcels/{z}/{x}/{y}.json")
async def get_parcel_tile(z: int, x: int, y: int):
    """Proxy QLD cadastral parcels from ArcGIS MapServer with caching."""
    if z < 15:
        return Response(content=_EMPTY, media_type="application/json", headers=_OK_HEADERS)
    cache_key = f"{z}/{x}/{y}"
    if cache_key in _parcel_cache:
        return Response(content=_parcel_cache[cache_key], media_type="application/json", headers=_OK_HEADERS)
    # Disk cache — survives restarts, shields us from ArcGIS 500s.
    disk_key = f"parcels:{z}/{x}/{y}"
    disk_hit = await disk_cache.get(disk_key, max_age_s=_DISK_TTL_S)
    if disk_hit is not None:
        _parcel_cache[cache_key] = disk_hit[0]
        return Response(content=disk_hit[0], media_type="application/json", headers=_OK_HEADERS)
    data = await _fetch_arcgis_tile(
        QLD_PARCEL_ARCGIS_URL, z, x, y,
        fields="lotplan,lot,plan,locality,lot_area,parcel_typ",
    )
    if data is not None:
        _parcel_cache[cache_key] = data
        await disk_cache.put(disk_key, data, "application/json")
        return Response(content=data, media_type="application/json", headers=_OK_HEADERS)
    # Do NOT cache empty responses — lets the endpoint auto-recover.
    return Response(content=_EMPTY, media_type="application/json", headers=_UPSTREAM_DOWN_HEADERS)


@router.get("/tiles/addresses/{z}/{x}/{y}.json")
async def get_address_tile(z: int, x: int, y: int):
    """Proxy QLD property addresses from ArcGIS MapServer with caching."""
    if z < 16:
        return Response(content=_EMPTY, media_type="application/json", headers=_OK_HEADERS)
    cache_key = f"addr/{z}/{x}/{y}"
    if cache_key in _address_cache:
        return Response(content=_address_cache[cache_key], media_type="application/json", headers=_OK_HEADERS)
    disk_key = f"addresses:{z}/{x}/{y}"
    disk_hit = await disk_cache.get(disk_key, max_age_s=_DISK_TTL_S)
    if disk_hit is not None:
        _address_cache[cache_key] = disk_hit[0]
        return Response(content=disk_hit[0], media_type="application/json", headers=_OK_HEADERS)
    data = await _fetch_arcgis_tile(
        QLD_ADDRESS_ARCGIS_URL, z, x, y,
        fields="street_number,street_name,street_type,locality,lotplan",
    )
    if data is not None:
        _address_cache[cache_key] = data
        await disk_cache.put(disk_key, data, "application/json")
        return Response(content=data, media_type="application/json", headers=_OK_HEADERS)
    return Response(content=_EMPTY, media_type="application/json", headers=_UPSTREAM_DOWN_HEADERS)
