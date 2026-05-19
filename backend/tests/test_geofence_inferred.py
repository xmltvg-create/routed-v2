"""
Geofence-inferred arrival method regression test
================================================

Reproduces the production observation that 100 % of arrivals were getting
tagged as `fallback_completion` even when the driver was clearly at the
stop (small `completion_distance_m`, `view_mode_at_completion='navigating'`).

The fix adds a third `arrival_method` tier:
  - `geofence`            — driver crossed the 100 m radius (high quality)
  - `geofence_inferred`   — driver was in nav mode AND within 150 m of the
                            geocoded centroid at completion time, even though
                            the hook itself never fired (mid quality)
  - `fallback_completion` — none of the above (low quality)

This lets the `arrival_proximity_rate` metric jump from ~0 % to a useful
80–95 % range immediately, without waiting for the driver to install a
new build with a wider geofence radius.
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
        user_id=f"pytest-geo-{uuid.uuid4().hex[:8]}",
        email="pytest-geo@example.com",
        name="Pytest Geo User",
        picture=None,
        created_at=datetime.now(timezone.utc),
    )
    server.app.dependency_overrides[server.get_current_user] = lambda: test_user
    server.app.dependency_overrides[routes_current_user] = lambda: test_user

    with TestClient(server.app) as tc:
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


def test_close_completion_in_nav_mode_yields_geofence_inferred(client):
    """50 m + navigating + no prior arrived_at → arrival_method='geofence_inferred'."""
    stop = _create_stop(client, -26.6800, 153.1000, "Inferred Lane")

    # 0.001 deg lat ≈ 111 m → 0.00045 deg ≈ 50 m north.
    resp = client.post(f"/api/stops/{stop['id']}/complete", json={
        "lat": -26.6800 + 0.00045,
        "lng": 153.1000,
        "view_mode": "navigating",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["completed"] is True
    assert body["arrival_method"] == "geofence_inferred"
    assert body["arrived_at"] is not None
    assert 40 <= body["completion_distance_m"] <= 60, body["completion_distance_m"]
    assert body["view_mode_at_completion"] == "navigating"


def test_close_completion_in_planning_mode_falls_back(client):
    """Same 50 m but view_mode='planning' → fallback_completion."""
    stop = _create_stop(client, -26.6800, 153.1000, "Planning Lane")

    resp = client.post(f"/api/stops/{stop['id']}/complete", json={
        "lat": -26.6800 + 0.00045,
        "lng": 153.1000,
        "view_mode": "planning",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["arrival_method"] == "fallback_completion"
    assert body["view_mode_at_completion"] == "planning"


def test_far_completion_falls_back_even_in_nav_mode(client):
    """500 m away in nav mode → not credible, fallback_completion."""
    stop = _create_stop(client, -26.6800, 153.1000, "Far Lane")

    resp = client.post(f"/api/stops/{stop['id']}/complete", json={
        "lat": -26.6800 + 0.0045,  # ~500 m
        "lng": 153.1000,
        "view_mode": "navigating",
    })
    body = resp.json()
    assert body["arrival_method"] == "fallback_completion"
    assert body["completion_distance_m"] >= 450


def test_real_geofence_arrival_unchanged_by_inference(client):
    """If /arrived already fired (geofence hit), /complete must NOT
    overwrite arrival_method='geofence' with the inferred tag."""
    stop = _create_stop(client, -26.6800, 153.1000, "Real Lane")

    r = client.post(f"/api/stops/{stop['id']}/arrived", json={
        "lat": -26.6800 + 0.0002,
        "lng": 153.1000,
    })
    assert r.status_code == 200
    assert r.json()["arrival_method"] == "geofence"

    r = client.post(f"/api/stops/{stop['id']}/complete", json={
        "lat": -26.6800 + 0.00045,
        "lng": 153.1000,
        "view_mode": "navigating",
    })
    body = r.json()
    assert body["arrival_method"] == "geofence"


def test_no_gps_falls_back_regardless_of_view_mode(client):
    """No GPS payload → cannot compute distance → fallback even in nav mode."""
    stop = _create_stop(client, -26.6800, 153.1000, "No-GPS Lane")

    r = client.post(f"/api/stops/{stop['id']}/complete", json={
        "view_mode": "navigating",
    })
    body = r.json()
    assert body["arrival_method"] == "fallback_completion"
    # No distance computed
    assert body.get("completion_distance_m") is None


def test_archive_rollup_counts_inferred_separately(client):
    """Archive telemetry should report `geofence_inferred_count` distinct
    from `fallback_count`, and `arrival_proximity_rate` should jump."""
    s1 = _create_stop(client, -26.6800, 153.1000, "S1")
    s2 = _create_stop(client, -26.6801, 153.1001, "S2")
    s3 = _create_stop(client, -26.6802, 153.1002, "S3")

    # s1 close + nav → inferred
    client.post(f"/api/stops/{s1['id']}/complete", json={
        "lat": -26.6800 + 0.00045, "lng": 153.1000, "view_mode": "navigating",
    })
    # s2 far + nav → fallback
    client.post(f"/api/stops/{s2['id']}/complete", json={
        "lat": -26.6801 + 0.0045, "lng": 153.1001, "view_mode": "navigating",
    })
    # s3 close + planning → fallback
    client.post(f"/api/stops/{s3['id']}/complete", json={
        "lat": -26.6802 + 0.00045, "lng": 153.1002, "view_mode": "planning",
    })

    r = client.post("/api/routes/archive")
    assert r.status_code == 200, r.text
    tel = r.json()["route"]["summary"]["telemetry"]

    assert tel["geofence_count"] == 0
    assert tel["geofence_inferred_count"] == 1
    assert tel["fallback_count"] == 2
    # strict rate is still 0 (no real geofence hits)
    assert tel["geofence_rate"] == 0.0
    # but proximity rate is 1/3 = 0.333
    assert tel["arrival_proximity_rate"] == round(1 / 3, 3)
