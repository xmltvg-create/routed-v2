"""Regression tests for completion-time telemetry capture.

Verifies:
  • POST /api/stops/{id}/complete with `lat/lng` computes haversine
    `completion_distance_m` from the GPS to the stop's geocoded centroid.
  • The `view_mode` field rides through and lands in Mongo as
    `view_mode_at_completion`.
  • POST /api/routes/archive rolls these per-stop fields up into a
    `summary.telemetry` block with `geofence_rate`, distance percentiles,
    and service-time percentiles — the Phase-1 ML readiness signal.

Hermetic — runs entirely through TestClient with auth deps overridden.

Usage:
    cd /app/backend && pytest tests/test_completion_telemetry.py -v
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture(scope="module")
def client():
    import server
    from routes.stops import _current_user as routes_current_user

    test_user = server.User(
        user_id=f"pytest-tele-{uuid.uuid4().hex[:8]}",
        email="pytest-tele@example.com",
        name="Pytest Tele User",
        picture=None,
        created_at=datetime.now(timezone.utc),
    )
    server.app.dependency_overrides[server.get_current_user] = lambda: test_user
    server.app.dependency_overrides[routes_current_user] = lambda: test_user

    with TestClient(server.app) as tc:
        tc._test_user_id = test_user.user_id
        yield tc

    import asyncio

    async def _cleanup():
        await server.db.stops.delete_many({"user_id": test_user.user_id})
        await server.db.route_history.delete_many({"user_id": test_user.user_id})

    try:
        asyncio.run(_cleanup())
    except RuntimeError:
        pass
    server.app.dependency_overrides.pop(server.get_current_user, None)
    server.app.dependency_overrides.pop(routes_current_user, None)


@pytest.fixture(autouse=True)
def _reset(client):
    client.delete("/api/stops")
    yield
    client.delete("/api/stops")


def _create_stop(client, lat, lng, address="Test St"):
    resp = client.post("/api/stops", json={
        "address": address,
        "name": address,
        "latitude": lat,
        "longitude": lng,
    })
    assert resp.status_code == 200, resp.text
    return resp.json()


# ─────────────────────────────────────────────────────────────────────────────


def test_completion_distance_matches_haversine(client):
    """Post completion with GPS 100m away → completion_distance_m ≈ 100."""
    stop = _create_stop(client, -27.5000, 153.0000)

    # 0.001 deg lat ≈ 111 m. Use 0.0009 → ~100 m.
    resp = client.post(f"/api/stops/{stop['id']}/complete", json={
        "lat": -27.5009, "lng": 153.0000,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    dist = body.get("completion_distance_m")
    assert dist is not None
    assert 90 < dist < 115, f"Expected ~100m, got {dist}"


def test_completion_view_mode_persisted(client):
    """`view_mode` from frontend lands in `view_mode_at_completion`."""
    stop = _create_stop(client, -27.5, 153.0)
    resp = client.post(f"/api/stops/{stop['id']}/complete", json={
        "lat": -27.5, "lng": 153.0, "view_mode": "navigating",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("view_mode_at_completion") == "navigating"


def test_completion_view_mode_rejects_garbage(client):
    """Bad `view_mode` is silently dropped, not stamped."""
    stop = _create_stop(client, -27.5, 153.0)
    resp = client.post(f"/api/stops/{stop['id']}/complete", json={
        "lat": -27.5, "lng": 153.0, "view_mode": "bogus",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "view_mode_at_completion" not in body or \
        body.get("view_mode_at_completion") is None


def test_archive_telemetry_rollup(client):
    """Archive doc contains `summary.telemetry` with geofence_rate + percentiles.

    Every test completion fires `fallback_completion` (no prior arrived_at),
    so this test asserts the all-fallback shape. The geofence_count > 0
    branch is exercised by the in-prod data path, not unit tests, but
    the rollup math is the same code path either way.
    """
    s1 = _create_stop(client, -27.500, 153.000, "Apple St")
    s2 = _create_stop(client, -27.501, 153.001, "Banana St")
    s3 = _create_stop(client, -27.502, 153.002, "Cherry St")
    s4 = _create_stop(client, -27.503, 153.003, "Date St")

    # Vary completion distances: 0m, ~50m, ~200m, ~300m
    for stop, dlat in [(s1, 0.0), (s2, 0.0004),
                       (s3, 0.0018), (s4, 0.0027)]:
        resp = client.post(f"/api/stops/{stop['id']}/complete", json={
            "lat": stop["latitude"] + dlat,
            "lng": stop["longitude"],
        })
        assert resp.status_code == 200

    resp = client.post("/api/routes/archive")
    assert resp.status_code == 200, resp.text
    archive = resp.json()
    summary = archive["route"]["summary"]
    tel = summary.get("telemetry")
    assert tel is not None, f"No telemetry in summary: {summary}"

    # All 4 are fallback_completion (no prior geofence-fired arrived_at)
    assert tel["geofence_count"] == 0
    assert tel["fallback_count"] == 4
    assert tel["geofence_rate"] == 0.0

    # Distance percentiles populated (4 samples)
    assert tel["distance_samples"] == 4
    assert tel["completion_distance_p50_m"] is not None
    assert tel["completion_distance_p95_m"] is not None
    # p50 should be lower than (or equal to) p95
    assert tel["completion_distance_p50_m"] <= tel["completion_distance_p95_m"]
    # Largest sample (~300m at ~0.0027 deg lat) should be in the p95 band.
    # Nearest-rank p95 of 4 samples picks the 3rd-largest, so ~200m.
    assert tel["completion_distance_p95_m"] >= 180

    # Service-time samples = 0 because none fired the geofence.
    # That's the expected production reading until the geofence-fix OTA
    # ships and drivers start producing real arrived_at→completed_at gaps.
    assert tel["service_samples"] == 0
    assert tel["service_seconds_p50"] is None
