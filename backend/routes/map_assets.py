"""Map asset proxy — style JSON, sprites, and glyph fonts.

Removes the cold-start dependency on `tiles.openfreemap.org` for everything
*except* the raw vector tiles (which are too large to self-host sensibly).
We rewrite the style document so MapLibre asks our backend for sprites +
fonts — already on the same origin as every other API call the app makes,
so TLS + HTTP/2 connections are warm and labels render without a flash.

All three endpoints use the shared SQLite disk cache. Fonts and sprites
almost never change upstream, so the TTL is intentionally aggressive
(30 days). The style JSON re-fetches every 6 hours to catch upstream schema
tweaks without anyone having to redeploy the backend.

Design notes
------------
* We do NOT proxy the vector tiles themselves. OpenFreeMap's CDN is closer
  to the driver's device than our cloud POP; self-hosting would be a
  regression. The pain point is sprite + font *cold-start latency*, which
  lives on our origin now.
* First request for each asset takes the upstream round-trip cost; every
  subsequent request in any fork / container is served from SQLite. A
  single container warm-up of the app hydrates the full glyph set for the
  fontstack(s) actually in use.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from . import _tile_cache as disk_cache

logger = logging.getLogger("server")
router = APIRouter()

_UPSTREAM = "https://tiles.openfreemap.org"
_STYLE_PATH = "/styles/liberty"
_SPRITE_TTL_S = 30 * 24 * 60 * 60   # 30 days — sprites are near-immutable.
_FONT_TTL_S = 30 * 24 * 60 * 60     # Same reasoning.
_STYLE_TTL_S = 6 * 60 * 60          # 6 hours — catch upstream schema edits.


async def _proxy_and_cache(upstream_url: str, cache_key: str,
                           ttl_s: int, default_ct: str) -> Optional[tuple[bytes, str]]:
    """Fetch `upstream_url` if we don't have a fresh disk copy, then return
    `(bytes, content-type)`. Returns None on a hard upstream failure so the
    caller can return a 502 — we never serve stale-but-usable data for
    non-style assets because MapLibre is strict about font/sprite shape."""
    hit = await disk_cache.get(cache_key, max_age_s=ttl_s)
    if hit is not None:
        return hit
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(upstream_url)
            if resp.status_code != 200:
                logger.warning("map-asset %s → HTTP %s", upstream_url, resp.status_code)
                return None
            ct = resp.headers.get("content-type", default_ct)
            await disk_cache.put(cache_key, resp.content, ct)
            return resp.content, ct
    except Exception as e:
        logger.warning("map-asset %s failed: %s", upstream_url, e)
        return None


def _rewrite_style(style_bytes: bytes, backend_base: str) -> bytes:
    """Point sprite/glyphs at our proxy. We rewrite inside the style-JSON body
    so the device fetches them from the same origin + HTTP/2 connection as
    every other API call — kills the cold-start label flash."""
    import json
    style = json.loads(style_bytes)
    style["sprite"] = f"{backend_base}/api/map/sprites/ofm"
    style["glyphs"] = f"{backend_base}/api/map/fonts/{{fontstack}}/{{range}}.pbf"
    return json.dumps(style).encode("utf-8")


@router.get("/map/style")
async def get_style(request: Request):
    """Return the Liberty style with sprite+glyphs pointing at our backend.
    Resolves backend base from the incoming request so dev / preview / prod
    all self-reference correctly without needing a hard-coded env var."""
    cache_key = "map/style:liberty:raw"
    hit = await disk_cache.get(cache_key, max_age_s=_STYLE_TTL_S)
    raw: Optional[bytes] = None
    if hit is not None:
        raw = hit[0]
    else:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(_UPSTREAM + _STYLE_PATH)
                if resp.status_code == 200:
                    raw = resp.content
                    await disk_cache.put(cache_key, raw, "application/json")
        except Exception as e:
            logger.warning("style upstream failed: %s", e)
    if raw is None:
        return Response(content=b'{"error":"upstream style unavailable"}',
                        status_code=502, media_type="application/json")
    # Prefer the X-Forwarded-* headers so URLs point at the public ingress
    # host, not the internal K8s service hostname that `base_url` reports
    # behind our Cloudflare proxy.
    fwd_host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    fwd_proto = request.headers.get("x-forwarded-proto") or "https"
    origin = f"{fwd_proto}://{fwd_host}" if fwd_host else str(request.base_url).rstrip("/")
    rewritten = _rewrite_style(raw, origin)
    return Response(content=rewritten, media_type="application/json",
                    headers={"Cache-Control": "public, max-age=3600"})


@router.get("/map/sprites/{path:path}")
async def get_sprite(path: str):
    """Proxy sprite JSON + PNG (all DPIs)."""
    # Upstream layout: https://tiles.openfreemap.org/sprites/ofm_f384/ofm{,@2x}.{json,png}
    upstream = f"{_UPSTREAM}/sprites/ofm_f384/{path}"
    result = await _proxy_and_cache(upstream, f"map/sprites:{path}",
                                    _SPRITE_TTL_S, "application/octet-stream")
    if result is None:
        return Response(status_code=502, content=b"sprite upstream failed")
    body, ct = result
    return Response(content=body, media_type=ct,
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/map/fonts/{fontstack}/{range}.pbf")
async def get_glyph_range(fontstack: str, range: str):
    """Proxy glyph PBFs. MapLibre fetches one PBF per fontstack+unicode range
    the first time a label in that range is rendered; after that everything
    is served from device + disk cache.

    MapLibre fontstacks are comma-separated fallback chains (e.g.
    "Noto Sans Bold,Open Sans Bold") — but openfreemap only hosts the
    *individual* font directories. Trying the combined stack returns 404
    upstream which would surface as a noisy 502 to the client. We split
    the chain and try each font in order so the first available wins.
    """
    candidates = [f.strip() for f in fontstack.split(",") if f.strip()] or [fontstack]
    last_err: Optional[str] = None
    for font in candidates:
        upstream = f"{_UPSTREAM}/fonts/{font}/{range}.pbf"
        result = await _proxy_and_cache(upstream, f"map/fonts:{font}/{range}",
                                        _FONT_TTL_S, "application/x-protobuf")
        if result is not None:
            body, ct = result
            return Response(content=body, media_type=ct,
                            headers={"Cache-Control": "public, max-age=604800"})
        last_err = font
    # All candidates failed — return 404 (not 502) so the client treats this
    # as "missing glyph range" and falls back to its built-in renderer
    # instead of treating it as a transient origin failure to retry.
    return Response(status_code=404,
                    content=f"font upstream not found: {last_err}".encode("utf-8"))


# ── Admin surface ─────────────────────────────────────────────────────────
# Tiny token-gated stats endpoint so the operator can watch the cache live
# without SSH. Shares the `routes/map_assets.py` module because the disk
# cache's dominant tenant IS the map-asset traffic — keeps the admin view
# adjacent to what it introspects.
_ADMIN_TOKEN_ENV = "TILE_CACHE_ADMIN_TOKEN"


@router.get("/admin/tile-cache/stats")
async def tile_cache_stats(request: Request):
    """Return live cache stats. Requires `X-Admin-Token` (or
    `?token=`) matching the `TILE_CACHE_ADMIN_TOKEN` env var. If the env
    var is unset the endpoint returns 503 (fail-closed — we'd rather
    hide the endpoint than expose counters without a gate)."""
    expected = os.environ.get(_ADMIN_TOKEN_ENV)
    if not expected:
        raise HTTPException(status_code=503,
                            detail=f"{_ADMIN_TOKEN_ENV} not configured")
    provided = (request.headers.get("x-admin-token")
                or request.query_params.get("token"))
    if provided != expected:
        raise HTTPException(status_code=401, detail="Invalid admin token")

    from . import _tile_cache as tc  # noqa: WPS433 (local to avoid stale import)
    return tc.stats_sync()
