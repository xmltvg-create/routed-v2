"""Tests for No-Go Zones CRUD and matrix penalty.

Hermetic — runs through TestClient with auth deps overridden, same
pattern as test_outlier_guardrail. Covers:

  • POST /api/nogo-zones validation (polygon shape, lng/lat bounds)
  • POST then GET round-trip
  • DELETE scoping (other-user ids return 404)
  • _zones_to_shapely conversion
  • segment_crosses_any_zone happy path + miss
  • apply_nogo_penalty mutates only crossing cells

Usage:
    cd /app/backend && pytest tests/test_nogo_zones.py -v
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
    from routes.nogo_zones import _current_user as routes_current_user

    test_user = server.User(
        user_id=f"pytest-nogo-{uuid.uuid4().hex[:8]}",
        email="pytest-nogo@example.com",
        name="Pytest NoGo",
        picture=None,
        created_at=datetime.now(timezone.utc),
    )
    server.app.dependency_overrides[server.get_current_user] = lambda: test_user
    server.app.dependency_overrides[routes_current_user] = lambda: test_user

    with TestClient(server.app) as tc:
        yield tc
        # Clean up any leftover zones via the HTTP surface.
        existing = tc.get("/api/nogo-zones").json()
        for z in existing or []:
            tc.delete(f"/api/nogo-zones/{z['id']}")

    server.app.dependency_overrides.pop(server.get_current_user, None)
    server.app.dependency_overrides.pop(routes_current_user, None)


@pytest.fixture(autouse=True)
def _reset(client):
    """Wipe per test so order doesn't matter."""
    existing = client.get("/api/nogo-zones").json()
    for z in existing or []:
        client.delete(f"/api/nogo-zones/{z['id']}")
    yield


def _square(center_lng, center_lat, half=0.001):
    return [
        [center_lng - half, center_lat - half],
        [center_lng + half, center_lat - half],
        [center_lng + half, center_lat + half],
        [center_lng - half, center_lat + half],
    ]


def test_create_and_list_zone(client):
    poly = _square(153.10, -26.78)
    r = client.post("/api/nogo-zones", json={"name": "test-zone", "polygon": poly})
    assert r.status_code == 200, r.text
    z = r.json()
    assert z["name"] == "test-zone"
    assert z["polygon"] == poly
    listed = client.get("/api/nogo-zones").json()
    assert len(listed) == 1
    assert listed[0]["id"] == z["id"]


def test_create_rejects_short_polygon(client):
    r = client.post(
        "/api/nogo-zones",
        json={"polygon": [[153.1, -26.78], [153.11, -26.78]]},
    )
    assert r.status_code == 422


def test_create_rejects_out_of_bounds_lat(client):
    r = client.post(
        "/api/nogo-zones",
        json={"polygon": [[153.1, -91.0], [153.11, -26.78], [153.11, -26.79]]},
    )
    assert r.status_code == 422


def test_create_rejects_malformed_vertex(client):
    r = client.post(
        "/api/nogo-zones",
        json={"polygon": [[153.1], [153.11, -26.78], [153.11, -26.79]]},
    )
    assert r.status_code == 422


def test_delete_unknown_returns_404(client):
    r = client.delete(f"/api/nogo-zones/{uuid.uuid4()}")
    assert r.status_code == 404


def test_delete_round_trip(client):
    z = client.post(
        "/api/nogo-zones",
        json={"polygon": _square(153.10, -26.78)},
    ).json()
    r = client.delete(f"/api/nogo-zones/{z['id']}")
    assert r.status_code == 200
    assert r.json()["deleted"] is True
    listed = client.get("/api/nogo-zones").json()
    assert listed == []


def test_segment_crosses_any_zone():
    from routes.nogo_zones import _zones_to_shapely, segment_crosses_any_zone
    polys = _zones_to_shapely([{"polygon": _square(153.10, -26.78)}])
    # segment that passes through the zone (straight east-west)
    assert segment_crosses_any_zone(-26.78, 153.099, -26.78, 153.101, polys)
    # segment well to the south, doesn't touch
    assert not segment_crosses_any_zone(-26.79, 153.099, -26.79, 153.101, polys)


def test_apply_nogo_penalty_only_mutates_crossing_cells():
    from routes.nogo_zones import (
        _zones_to_shapely, apply_nogo_penalty, _NOGO_PENALTY,
    )
    # 3 stops: A (west of zone), B (east of zone), C (south of zone).
    # The zone sits at (153.10, -26.78). A→B crosses it; A→C does not;
    # B→C does not.
    stops = [
        {"id": "A", "latitude": -26.78, "longitude": 153.095},
        {"id": "B", "latitude": -26.78, "longitude": 153.105},
        {"id": "C", "latitude": -26.79, "longitude": 153.10},
    ]
    matrix = [
        [0.0, 100.0, 200.0],
        [100.0, 0.0, 150.0],
        [200.0, 150.0, 0.0],
    ]
    polys = _zones_to_shapely([{"polygon": _square(153.10, -26.78)}])
    n = apply_nogo_penalty(matrix, stops, polys)
    assert n == 2  # A→B and B→A
    assert matrix[0][1] == pytest.approx(100.0 + _NOGO_PENALTY)
    assert matrix[1][0] == pytest.approx(100.0 + _NOGO_PENALTY)
    # Untouched cells:
    assert matrix[0][0] == 0.0
    assert matrix[0][2] == 200.0
    assert matrix[1][2] == 150.0
    assert matrix[2][0] == 200.0
    assert matrix[2][1] == 150.0


def test_apply_nogo_penalty_no_zones_is_noop():
    from routes.nogo_zones import apply_nogo_penalty
    matrix = [[0.0, 1.0], [1.0, 0.0]]
    stops = [
        {"id": "A", "latitude": 0.0, "longitude": 0.0},
        {"id": "B", "latitude": 0.0, "longitude": 1.0},
    ]
    n = apply_nogo_penalty(matrix, stops, [])
    assert n == 0
    assert matrix == [[0.0, 1.0], [1.0, 0.0]]
