"""Shared SQLite-backed disk cache used by the map-tile routes.

Turns the per-instance in-memory dicts in `tiles.py` / `housenumbers.py` into
a durable, fork-surviving store. Keyed by a free-form string (e.g.
`"parcels:18/239312/154821"`, `"housenumbers:bbox=153.12,-26.82,153.13,-26.81"`,
`"map/sprites/ofm.json"`) mapping to gzipped-or-raw bytes + a fetched-at
timestamp. A single writer + single connection, async-friendly (all DB work
is wrapped in `run_in_executor` to avoid blocking the event loop).

Design notes
------------
* SQLite with `journal_mode=WAL` + `synchronous=NORMAL` is fine for our
  workload (~thousands of writes/hour, single process, no cross-host sync).
* Size-capped via a cheap `ORDER BY fetched_at LIMIT` purge when row count
  > `MAX_ROWS`. Cadence: every 500 writes.
* TTL is enforced at READ time (not via a background job) to keep the
  scheduler simple. Callers pass `max_age_s`; `None` means "never stale".
* The cache is safe to delete at any time — `ensure_schema()` re-creates it
  on next boot and the existing in-memory dicts keep serving warm requests
  while SQLite rebuilds.
"""
from __future__ import annotations

import asyncio
import gzip
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger("server")

_DB_PATH = os.environ.get("TILE_CACHE_DB", "/app/tiles/qld_cache.db")
# Row cap sized for the full SE-QLD parcel+address+housenumber corpus at
# z=16/17 plus the map-asset set. With gzip-on-write we see ~4–5 % of raw
# size on JSON, so 2 M rows * 1 KB avg = ~2 GB, comfortably inside our
# container disk budget and roughly the coverage of every street a QLD
# driver would ever visit.
_MAX_ROWS = 2_000_000
_WRITES_BETWEEN_PURGES = 500
# Hourly light maintenance (wal_checkpoint + PRAGMA optimize); daily VACUUM
# for on-disk defrag. VACUUM locks the DB briefly so we do it infrequently.
_MAINTAIN_EVERY_S = 60 * 60
_VACUUM_EVERY_S = 24 * 60 * 60
_last_vacuum_at = 0.0
# gzip magic: rows written by the gzip-aware `put()` start with b"\x1f\x8b".
# Older rows (if any) start with `{` or a PNG/PBF magic — so the discriminator
# is zero-ambiguity and we can layer gzip in without a DB migration.
_GZIP_MAGIC = b"\x1f\x8b"
_GZIP_MIN_BYTES = 512  # Below this size, gzip overhead is a net loss.

_conn: Optional[sqlite3.Connection] = None
_writes_since_purge = 0
_lock = asyncio.Lock()

# Simple counters for the /api/admin/tile-cache/stats endpoint. Incremented
# atomically from the request-path code; reset only on process restart.
_hits = 0
_misses = 0
_writes = 0


def _ensure_schema() -> sqlite3.Connection:
    """Open (or reopen) the SQLite file. Idempotent — re-running after a
    `rm` of the DB rebuilds schema on the next call."""
    global _conn
    Path(_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=5.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS tile_cache (
            key TEXT PRIMARY KEY,
            data BLOB NOT NULL,
            content_type TEXT NOT NULL,
            fetched_at REAL NOT NULL
        )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_fetched_at ON tile_cache(fetched_at)")
    conn.commit()
    _conn = conn
    return conn


def _get_conn() -> sqlite3.Connection:
    return _conn if _conn is not None else _ensure_schema()


def _purge_if_oversized(conn: sqlite3.Connection) -> None:
    global _writes_since_purge
    _writes_since_purge += 1
    if _writes_since_purge < _WRITES_BETWEEN_PURGES:
        return
    _writes_since_purge = 0
    row = conn.execute("SELECT COUNT(*) FROM tile_cache").fetchone()
    count = row[0] if row else 0
    if count > _MAX_ROWS:
        # Evict the oldest 10 % in one pass so we don't thrash.
        to_delete = max(1, count // 10)
        conn.execute(
            "DELETE FROM tile_cache WHERE key IN ("
            "  SELECT key FROM tile_cache ORDER BY fetched_at ASC LIMIT ?"
            ")",
            (to_delete,),
        )
        conn.commit()
        logger.info("tile_cache: evicted %d LRU rows (was %d)", to_delete, count)


def _get_sync(key: str, max_age_s: Optional[float]) -> Optional[tuple[bytes, str]]:
    conn = _get_conn()
    row = conn.execute(
        "SELECT data, content_type, fetched_at FROM tile_cache WHERE key = ?",
        (key,),
    ).fetchone()
    if not row:
        return None
    data, ct, fetched_at = row
    if max_age_s is not None and (time.time() - fetched_at) > max_age_s:
        return None  # stale — caller refetches
    raw = bytes(data)
    # Transparent gunzip: rows written after the gzip-on-write change start
    # with 0x1f 0x8b, older rows don't. The discriminator is safe because
    # neither JSON (`{`) nor PNG (`\x89PNG`) nor PBF (`\x08` varints) share
    # this magic.
    if raw[:2] == _GZIP_MAGIC:
        try:
            raw = gzip.decompress(raw)
        except Exception as e:
            # Extremely unlikely — corrupted row. Treat as miss so the
            # caller re-fetches upstream and overwrites the bad entry.
            logger.warning("tile_cache.get(%s): gzip decompress failed: %s", key, e)
            return None
    return raw, ct


def _put_sync(key: str, data: bytes, content_type: str) -> None:
    conn = _get_conn()
    # Gzip only when the payload is big enough to outweigh the header +
    # write cost. PBF fonts and PNG sprites are already compressed, so
    # double-compression wastes CPU — skip them.
    body = data
    if (len(data) >= _GZIP_MIN_BYTES
            and not content_type.startswith("image/")
            and "protobuf" not in content_type):
        compressed = gzip.compress(data, compresslevel=6)
        if len(compressed) < len(data):
            body = compressed
    conn.execute(
        "INSERT OR REPLACE INTO tile_cache (key, data, content_type, fetched_at) "
        "VALUES (?, ?, ?, ?)",
        (key, body, content_type, time.time()),
    )
    conn.commit()
    _purge_if_oversized(conn)


async def get(key: str, max_age_s: Optional[float] = None) -> Optional[tuple[bytes, str]]:
    """Return `(data, content_type)` if fresh, else None."""
    global _hits, _misses  # noqa: PLW0603
    try:
        result = await asyncio.get_running_loop().run_in_executor(
            None, _get_sync, key, max_age_s,
        )
    except Exception as e:
        logger.warning("tile_cache.get(%s) failed: %s", key, e)
        _misses += 1
        return None
    if result is None:
        _misses += 1
    else:
        _hits += 1
    return result


async def put(key: str, data: bytes, content_type: str = "application/json") -> None:
    """Store or overwrite an entry. Best-effort — a write failure is logged
    but never propagates to the caller, because a degraded cache should not
    break the live request path."""
    global _writes  # noqa: PLW0603
    async with _lock:
        try:
            await asyncio.get_running_loop().run_in_executor(
                None, _put_sync, key, data, content_type,
            )
            _writes += 1
        except Exception as e:
            logger.warning("tile_cache.put(%s) failed: %s", key, e)


def stats_sync() -> dict:
    """Synchronous introspection — safe to call from the CLI / health probe."""
    try:
        conn = _get_conn()
        count = conn.execute("SELECT COUNT(*) FROM tile_cache").fetchone()[0]
        size = Path(_DB_PATH).stat().st_size if Path(_DB_PATH).exists() else 0
        total = _hits + _misses
        hit_rate = round(_hits / total, 4) if total else 0.0
        return {
            "rows": count,
            "bytes_on_disk": size,
            "path": _DB_PATH,
            "hits": _hits,
            "misses": _misses,
            "writes": _writes,
            "hit_rate": hit_rate,
            "max_rows": _MAX_ROWS,
            "last_vacuum_at": _last_vacuum_at,
        }
    except Exception as e:
        return {"error": str(e), "path": _DB_PATH}


# ── Background maintenance ────────────────────────────────────────────────
def _maintain_sync() -> dict:
    """One pass of housekeeping. Cheap unless it's also VACUUM time."""
    global _last_vacuum_at
    conn = _get_conn()
    stats = {"checkpoint": False, "optimize": False, "vacuum": False}
    # wal_checkpoint(TRUNCATE) flushes WAL back into the main DB so the WAL
    # file doesn't grow unbounded on a write-heavy container.
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        stats["checkpoint"] = True
    except Exception as e:
        logger.warning("tile_cache wal_checkpoint failed: %s", e)
    # PRAGMA optimize updates statistics + prunes unused index pages. Fast.
    try:
        conn.execute("PRAGMA optimize")
        stats["optimize"] = True
    except Exception as e:
        logger.warning("tile_cache optimize failed: %s", e)
    # Daily VACUUM — full defragmentation. Locks the DB briefly but the
    # cache is an opportunistic layer: a few seconds of "cache miss, fetch
    # upstream" on a VACUUM tick is fine.
    if (time.time() - _last_vacuum_at) > _VACUUM_EVERY_S:
        try:
            conn.execute("VACUUM")
            _last_vacuum_at = time.time()
            stats["vacuum"] = True
        except Exception as e:
            logger.warning("tile_cache VACUUM failed: %s", e)
    return stats


async def _maintain_loop() -> None:
    """Hourly maintenance task. Spawned once at app startup."""
    while True:
        try:
            await asyncio.sleep(_MAINTAIN_EVERY_S)
            result = await asyncio.get_running_loop().run_in_executor(
                None, _maintain_sync,
            )
            stats = stats_sync()
            logger.info("tile_cache maintenance: %s rows=%d bytes=%d",
                        result, stats.get("rows", -1), stats.get("bytes_on_disk", -1))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("tile_cache maintain loop error: %s", e)


def start_background_tasks() -> None:
    """Fire-and-forget: create the hourly maintenance task. Idempotent —
    safe to call on every uvicorn reload; the global `asyncio.create_task`
    reference is replaced rather than duplicated."""
    global _maintain_task  # noqa: PLW0603
    try:
        _maintain_task = asyncio.create_task(_maintain_loop())
    except Exception as e:
        logger.warning("tile_cache background start failed: %s", e)


_maintain_task: Optional[asyncio.Task] = None
