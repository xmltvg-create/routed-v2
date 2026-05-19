"""Tests for the outlier-guardrail endpoints in routes/stops.py.

Hermetic — runs entirely through TestClient with auth deps overridden.
Setup and verification both go through the HTTP surface to avoid the
known motor/asyncio event-loop conflict that direct DB calls trigger.

Usage:
    cd /app/backend && pytest tests/test_outlier_guardrail.py -v
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
        user_id=f"pytest-outlier-{uuid.uuid4().hex[:8]}",
        email="pytest-outlier@example.com",
        name="Pytest Outlier",
        picture=None,
        created_at=datetime.now(timezone.utc),
    )
    server.app.dependency_overrides[server.get_current_user] = lambda: test_user
    server.app.dependency_overrides[routes_current_user] = lambda: test_user

    with TestClient(server.app) as tc:
        yield tc
        # In-test cleanup via the HTTP surface — same session, same loop,
        # avoids the motor cross-loop conflict that direct `asyncio.run`
        # cleanup hit. The autouse `_reset` fixture also wipes between
        # tests, so this is the final "leave the DB clean" pass.
        tc.delete("/api/stops")

    server.app.dependency_overrides.pop(server.get_current_user, None)
    server.app.dependency_overrides.pop(routes_current_user, None)


@pytest.fixture(autouse=True)
def _reset(client):
    client.delete("/api/stops")
    yield
    client.delete("/api/stops")


def _create_stop(client, lat, lng, name=""):
    r = client.post(
        "/api/stops",
        json={
            "address": f"{name or 'Stop'} @ ({lat:.3f},{lng:.3f})",
            "name": name,
            "latitude": lat,
            "longitude": lng,
            "priority": "medium",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_helpers_self_consistent():
    from routes.stops import _haversine_km, _median
    # Sunshine Coast → Mount Isa is ~1500-1700 km.
    d = _haversine_km(-26.78, 153.10, -20.71, 139.51)
    assert 1450 < d < 1700, d
    assert _median([1, 2, 3]) == 2
    assert _median([1, 2, 3, 4]) == 2.5
    assert _median([]) == 0.0


def test_outliers_flags_far_stop(client):
    coords = [
        (-26.78, 153.10),
        (-26.79, 153.09),
        (-26.77, 153.11),
        (-26.80, 153.08),
        (-26.76, 153.12),
    ]
    for lat, lng in coords:
        _create_stop(client, lat, lng, "sunshine")
    rogue = _create_stop(client, -20.71, 139.51, "mt-isa-rogue")

    r = client.get("/api/stops/outliers?threshold_km=50")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_stops"] == 6
    assert body["threshold_km"] == 50.0
    assert body["centroid"] is not None
    ids = [o["id"] for o in body["outliers"]]
    assert ids == [rogue["id"]]
    far = body["outliers"][0]
    assert far["distance_km"] > 1000
    assert far["latitude"] == pytest.approx(-20.71)


def test_outliers_below_threshold_none(client):
    for lat, lng in [
        (-26.78, 153.10),
        (-26.79, 153.09),
        (-26.77, 153.11),
        (-26.80, 153.08),
    ]:
        _create_stop(client, lat, lng)
    r = client.get("/api/stops/outliers?threshold_km=50")
    assert r.status_code == 200
    assert r.json()["outliers"] == []


def test_outliers_empty_when_too_few_stops(client):
    _create_stop(client, -26.78, 153.10)
    _create_stop(client, -26.79, 153.09)
    r = client.get("/api/stops/outliers")
    assert r.status_code == 200
    body = r.json()
    assert body["centroid"] is None
    assert body["outliers"] == []
    assert body["total_stops"] == 2


def test_remove_outliers_bulk_and_reindex(client):
    base = [
        (-26.78, 153.10),
        (-26.79, 153.09),
        (-26.77, 153.11),
        (-26.80, 153.08),
        (-26.76, 153.12),
    ]
    for lat, lng in base:
        _create_stop(client, lat, lng, "ok")
    rogue1 = _create_stop(client, -20.71, 139.51, "mt-isa")
    rogue2 = _create_stop(client, 40.75, -73.99, "nyc")

    r = client.post(
        "/api/stops/outliers/remove",
        json={"stop_ids": [rogue1["id"], rogue2["id"]]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["deleted_count"] == 2
    assert body["remaining_count"] == 5

    # Verify contiguous `order` field by reading back the stops.
    listed = client.get("/api/stops").json()
    orders = sorted([s["order"] for s in listed])
    assert orders == [0, 1, 2, 3, 4]


def test_remove_outliers_rejects_empty(client):
    r = client.post("/api/stops/outliers/remove", json={"stop_ids": []})
    # Pydantic's `min_length=1` constraint fires before the route body runs.
    assert r.status_code in (400, 422)


def test_remove_outliers_ignores_other_users_ids(client):
    """A forged payload with a non-owned stop_id must not crash and must
    delete zero rows (scoped by user_id in the query)."""
    _create_stop(client, -26.78, 153.10)
    r = client.post(
        "/api/stops/outliers/remove",
        json={"stop_ids": ["00000000-0000-0000-0000-000000000000"]},
    )
    assert r.status_code == 200
    assert r.json()["deleted_count"] == 0
