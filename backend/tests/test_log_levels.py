"""Lock in deploy-log hygiene: recoverable upstream failures stay at INFO.

The Overpass circuit-breaker, ArcGIS housenumbers fetch failures, and the
Timefold "JVM not available" path are ALL fully-handled fallback paths —
they have caches, alternate upstreams, and degrade gracefully. Logging
them at WARNING makes Emergent's deploy log look broken when it's not, so
they're pinned at INFO. This test stops a future refactor from silently
re-promoting them to WARNING.
"""

import logging
import time
from unittest.mock import patch

import pytest


def _capture(caplog, logger_name, fn, *args, **kwargs):
    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger=logger_name):
        fn(*args, **kwargs)
    return list(caplog.records)


def test_timefold_jvm_dll_missing_logs_at_info(caplog):
    """When the JDK tarball lands but JVM DLL isn't process-resolvable,
    install_native_solvers must log INFO (not WARNING) — this is the
    expected prod-container path on Emergent's image."""
    from install_native_solvers import _load_timefold_sync

    with patch("install_native_solvers._install_java_sync", return_value="/tmp/fake-jdk"):
        # Force the import to raise the exact JPype error string we see in prod
        import builtins
        real_import = builtins.__import__

        def boom(name, *args, **kwargs):
            if name == "timefold_solver":
                raise OSError(0, "JVM DLL not found: /tmp/fake-jdk/lib/server/libjvm.so")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=boom):
            records = _capture(caplog, "install_native_solvers", _load_timefold_sync)

    timefold_lines = [r for r in records if "Timefold" in r.message or "timefold" in r.message]
    assert timefold_lines, "expected a timefold-installer log line"
    assert all(r.levelno <= logging.INFO for r in timefold_lines), (
        f"Timefold JVM-missing path must log at INFO. Got: "
        f"{[(r.levelname, r.message) for r in timefold_lines]}"
    )


def test_arcgis_housenumbers_failure_logs_at_info(caplog):
    """ArcGIS fetch failures fall back to Overpass + disk cache; they
    must NOT fire WARNING in the deploy log."""
    import asyncio
    from routes import housenumbers as hn

    # Reset breaker so the failure path fires
    hn._ARCGIS_FAIL_UNTIL = 0
    # Disable disk cache hit so we go through to the upstream call
    async def _miss(*a, **kw):
        return None
    with patch.object(hn.disk_cache, "get", _miss), \
         patch.object(hn.disk_cache, "set", _miss), \
         patch("httpx.AsyncClient") as mock_client:
        mock_client.return_value.__aenter__.return_value.get.side_effect = Exception(
            "simulated TLS handshake failure"
        )
        # Also force overpass to return None so we exercise just the ArcGIS branch
        async def _no_op(*a, **kw):
            return {"type": "FeatureCollection", "features": []}
        with patch.object(hn, "_fetch_housenumbers_overpass", _no_op):
            records = _capture(
                caplog, "server",
                lambda: asyncio.run(hn.get_housenumbers_bbox("153.05,-26.78,153.06,-26.77", 50)),
            )

    arcgis_lines = [r for r in records if "ArcGIS" in r.message]
    assert arcgis_lines, "expected an ArcGIS log line"
    assert all(r.levelno <= logging.INFO for r in arcgis_lines), (
        f"ArcGIS failure path must log at INFO. Got: "
        f"{[(r.levelname, r.message) for r in arcgis_lines]}"
    )


def test_overpass_circuit_breaker_logs_at_info(caplog):
    """All-mirrors-down trips the Overpass breaker; ArcGIS + disk cache
    cover the gap, so this must NOT fire WARNING in deploy logs."""
    import asyncio
    from routes import housenumbers as hn

    hn._OVERPASS_FAIL_UNTIL = 0

    class _BoomClient:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, *a, **kw):
            raise Exception("simulated network drop")

    with patch("httpx.AsyncClient", _BoomClient):
        records = _capture(
            caplog, "server",
            lambda: asyncio.run(hn._fetch_housenumbers_overpass(
                153.05, -26.78, 153.06, -26.77, 50,
            )),
        )

    breaker_lines = [r for r in records if "circuit-breaker" in r.message]
    assert breaker_lines, "expected an Overpass circuit-breaker log line"
    assert all(r.levelno <= logging.INFO for r in breaker_lines), (
        f"Overpass circuit-breaker must log at INFO. Got: "
        f"{[(r.levelname, r.message) for r in breaker_lines]}"
    )
