"""Tests for `POST /api/optimize/tighten-cluster`.

Uses TestClient + DEV_MODE=true. Seed via sync pymongo to avoid pytest-asyncio's
event-loop tangles with motor.
"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pymongo import MongoClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ["DEV_MODE"] = "true"  # must be set BEFORE server import
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from server import app  # noqa: E402


_sync_db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]


@pytest.fixture(scope="module")
def client():
    # Module-scoped so the FastAPI lifespan (which owns the motor event loop)
    # runs once. Function-scoped TestClients close the loop after the first
    # test, which then breaks every subsequent request → "Event loop is closed".
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def seeded_spike():
    """Seed A, SPIKE(5km north), C, D, E with SPIKE in position 1."""
    _sync_db.stops.delete_many({"user_id": "dev-user-123"})
    coords = [
        ("A", -26.65, 153.09),
        ("SPIKE", -26.60, 153.095),
        ("C", -26.65, 153.10),
        ("D", -26.65, 153.11),
        ("E", -26.65, 153.12),
    ]
    docs = []
    for i, (name, lat, lon) in enumerate(coords):
        sid = "spike-id" if name == "SPIKE" else str(uuid.uuid4())
        docs.append({
            "id": sid,
            "user_id": "dev-user-123",
            "address": name,
            "name": name,
            "latitude": lat,
            "longitude": lon,
            "completed": False,
            "order": i,
        })
    _sync_db.stops.insert_many(docs)
    yield "spike-id"
    _sync_db.stops.delete_many({"user_id": "dev-user-123"})


@pytest.fixture()
def two_pending_only():
    _sync_db.stops.delete_many({"user_id": "dev-user-123"})
    _sync_db.stops.insert_many([
        {"id": "x1", "user_id": "dev-user-123", "address": "X1", "name": "X1",
         "latitude": -26.65, "longitude": 153.09, "completed": False, "order": 0},
        {"id": "x2", "user_id": "dev-user-123", "address": "X2", "name": "X2",
         "latitude": -26.65, "longitude": 153.10, "completed": False, "order": 1},
    ])
    yield
    _sync_db.stops.delete_many({"user_id": "dev-user-123"})


def test_tighten_relocates_spike_and_reduces_distance(client, seeded_spike):
    r = client.post(
        "/api/optimize/tighten-cluster",
        json={"suspect_id": seeded_spike},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["from_position"] == 1
    assert body["moved_stop_id"] == "spike-id"

    # Driving-time fields are present on every response.
    assert "driving_seconds_before" in body
    assert "driving_seconds_after" in body
    assert "driving_seconds_saved" in body
    assert "rolled_back" in body

    if body["rolled_back"]:
        # OSRM disagreed → route untouched, distances unchanged.
        assert body["to_position"] == 1
        assert body["haversine_km_after"] == body["haversine_km_before"]
        assert body["saved_km"] == 0.0
    else:
        assert body["to_position"] != 1
        assert body["haversine_km_after"] < body["haversine_km_before"]
        assert body["saved_km"] > 0

    ids = [s["id"] for s in body["stops"]]
    assert len(ids) == 5 and len(set(ids)) == 5
    assert "spike-id" in ids
    assert body["optimized_sequence"] == ids
    assert isinstance(body["cluster_warnings"], list)


def test_tighten_persists_new_order_to_mongo(client, seeded_spike):
    r = client.post(
        "/api/optimize/tighten-cluster",
        json={"suspect_id": seeded_spike},
    )
    assert r.status_code == 200
    response_order = [s["id"] for s in r.json()["stops"]]
    db_order = [
        s["id"]
        for s in _sync_db.stops.find(
            {"user_id": "dev-user-123"}, {"_id": 0}
        ).sort("order", 1)
    ]
    assert db_order == response_order


def test_tighten_returns_404_for_unknown_suspect(client, seeded_spike):
    r = client.post(
        "/api/optimize/tighten-cluster",
        json={"suspect_id": "does-not-exist"},
    )
    assert r.status_code == 404
    assert "not found" in r.json()["detail"].lower()


def test_tighten_rejects_when_fewer_than_3_pending(client, two_pending_only):
    r = client.post(
        "/api/optimize/tighten-cluster",
        json={"suspect_id": "x1"},
    )
    assert r.status_code == 400
    assert "at least 3" in r.json()["detail"].lower()


# ─────────────────────────── tighten-clusters (batch) ───────────────────────


@pytest.fixture()
def seeded_two_spikes():
    """Layout with TWO spikes that the iterative tightener must remove.

    Stops on a horizontal line, with two off-line spikes interleaved with
    on-line neighbours so each spike forms its own triplet:
        A - S1(north) - C - S2(north) - E - F
    Both (A, S1, C) and (C, S2, E) are spike triplets.
    """
    _sync_db.stops.delete_many({"user_id": "dev-user-123"})
    coords = [
        ("A", -26.65, 153.090),
        ("S1", -26.60, 153.095),     # spike #1 (5 km north of A↔C line)
        ("C", -26.65, 153.100),
        ("S2", -26.60, 153.108),     # spike #2 (5 km north of C↔E line)
        ("E", -26.65, 153.115),
        ("F", -26.65, 153.125),
    ]
    docs = []
    for i, (name, lat, lon) in enumerate(coords):
        sid = name.lower() if name in ("S1", "S2") else str(uuid.uuid4())
        docs.append({
            "id": sid,
            "user_id": "dev-user-123",
            "address": name,
            "name": name,
            "latitude": lat,
            "longitude": lon,
            "completed": False,
            "order": i,
        })
    _sync_db.stops.insert_many(docs)
    yield
    _sync_db.stops.delete_many({"user_id": "dev-user-123"})


def test_tighten_all_clears_every_spike(client, seeded_two_spikes):
    r = client.post("/api/optimize/tighten-clusters")
    assert r.status_code == 200, r.text
    body = r.json()

    # If OSRM is unavailable we still expect the haversine fix; if OSRM is
    # available AND agrees, even better. Either way we want passes ≥ 1
    # UNLESS the OSRM check rolled back (rare on synthetic data).
    if body.get("rolled_back"):
        # Rollback path: route stays untouched, haversine_after == before.
        assert body["passes"] == 0
        assert body["moves"] == []
        assert body["haversine_km_after"] == body["haversine_km_before"]
    else:
        assert body["passes"] >= 1
        assert len(body["moves"]) == body["passes"]
        assert body["haversine_km_after"] < body["haversine_km_before"]
        assert body["saved_km"] > 0
        assert body["cluster_warnings"] == []

    # Driving-time fields are present whenever we attempted moves and OSRM
    # was reachable. They may legitimately be None if OSRM is down.
    assert "driving_seconds_before" in body
    assert "driving_seconds_after" in body
    assert "driving_seconds_saved" in body

    # All 6 stops still present, exactly once.
    ids = [s["id"] for s in body["stops"]]
    assert len(ids) == 6 and len(set(ids)) == 6

    # Each move shape is correct (only present when we kept the changes).
    for m in body["moves"]:
        assert {"moved_stop_id", "from_position", "to_position", "saved_km"} <= m.keys()
        assert m["saved_km"] >= 0


def test_tighten_all_is_no_op_on_clean_route(client):
    """A clean linear route returns 0 passes and no changes."""
    _sync_db.stops.delete_many({"user_id": "dev-user-123"})
    docs = [
        {"id": str(uuid.uuid4()), "user_id": "dev-user-123",
         "address": f"S{i}", "name": f"S{i}",
         "latitude": -26.65, "longitude": 153.09 + 0.005 * i,
         "completed": False, "order": i}
        for i in range(6)
    ]
    _sync_db.stops.insert_many(docs)
    try:
        r = client.post("/api/optimize/tighten-clusters")
        assert r.status_code == 200
        body = r.json()
        assert body["passes"] == 0
        assert body["moves"] == []
        assert body["saved_km"] == 0.0
        assert body["cluster_warnings"] == []
    finally:
        _sync_db.stops.delete_many({"user_id": "dev-user-123"})


def test_tighten_all_persists_final_order(client, seeded_two_spikes):
    r = client.post("/api/optimize/tighten-clusters")
    assert r.status_code == 200
    response_order = [s["id"] for s in r.json()["stops"]]
    db_order = [
        s["id"]
        for s in _sync_db.stops.find(
            {"user_id": "dev-user-123"}, {"_id": 0}
        ).sort("order", 1)
    ]
    assert db_order == response_order


def test_tighten_all_with_too_few_stops(client, two_pending_only):
    """<3 stops returns a graceful no-op rather than 400."""
    r = client.post("/api/optimize/tighten-clusters")
    assert r.status_code == 200
    body = r.json()
    assert body["passes"] == 0
    assert body["moves"] == []
    assert body["message"] == "Nothing to tighten"
