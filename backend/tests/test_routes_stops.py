"""Regression tests for `routes/stops.py` after extraction from `server.py`.

Verifies GET/POST/PUT/DELETE /api/stops, /api/stops/{id} complete/uncomplete,
/api/stops/reorder, /api/stops/clear, /api/debug/stops-coords all work from
the new module. Runs in-process via FastAPI TestClient and overrides the
`_current_user` dep so we don't need a real session.

Isolation: every test runs for a dedicated `pytest-user-<uuid>` so real
user data is never touched, and the fixture wipes that user's stops at teardown.

Usage:
    cd /app/backend && pytest tests/test_routes_stops.py -q
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

# Make sure /app/backend is importable regardless of pytest cwd.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture(scope="module")
def client():
    import server  # noqa: WPS433 — imported after sys.path rewrite.
    from routes.stops import _current_user

    test_user = server.User(
        user_id=f"pytest-user-{uuid.uuid4().hex[:8]}",
        email="pytest@example.com",
        name="Pytest User",
        picture=None,
        created_at=datetime.now(timezone.utc),
    )

    # Override the dep used by routes/stops.py. We set it on the FastAPI app
    # (not the APIRouter) so TestClient sees the override.
    server.app.dependency_overrides[_current_user] = lambda: test_user

    with TestClient(server.app) as tc:
        tc._test_user_id = test_user.user_id  # stash for cleanup
        yield tc

    # Teardown: wipe anything this user inserted so the test DB stays tidy.
    # `asyncio.run` spins up a fresh event loop — TestClient's context
    # manager already closed the one it was using.
    import asyncio

    async def _cleanup():
        await server.db.stops.delete_many({"user_id": test_user.user_id})

    try:
        asyncio.run(_cleanup())
    except RuntimeError:
        # If motor clung to the old loop we can't cleanly await — accept the
        # tiny residue (scoped to the pytest-user-<uuid> anyway).
        pass
    server.app.dependency_overrides.pop(_current_user, None)


@pytest.fixture(autouse=True)
def _reset(client):
    """Wipe stops between tests — each test expects an empty list to start."""
    client.delete("/api/stops")
    yield


# ── Tests ─────────────────────────────────────────────────────────────────


def test_list_empty(client):
    resp = client.get("/api/stops")
    assert resp.status_code == 200
    assert resp.json() == []


def test_create_and_list(client):
    payload = {
        "address": "1 Test St, Brisbane QLD",
        "name": "stop-a",
        "latitude": -27.4698,
        "longitude": 153.0251,
    }
    resp = client.post("/api/stops", json=payload)
    assert resp.status_code == 200, resp.text
    stop = resp.json()
    assert stop["address"] == payload["address"]
    assert stop["order"] == 0
    assert stop["completed"] is False

    resp = client.get("/api/stops")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


def test_create_is_idempotent_by_coords(client):
    payload = {
        "address": "1 Idem St",
        "name": "dup",
        "latitude": -27.0,
        "longitude": 153.0,
    }
    a = client.post("/api/stops", json=payload).json()
    b = client.post("/api/stops", json=payload).json()
    assert a["id"] == b["id"], "same coords+address should return the same stop"


def test_update_partial_and_delivery_sync(client):
    created = client.post("/api/stops", json={
        "address": "2 Update St", "name": "upd",
        "latitude": -27.1, "longitude": 153.1,
    }).json()

    # Mark completed via PUT — delivery_status should flip to 'delivered'.
    resp = client.put(f"/api/stops/{created['id']}", json={"completed": True})
    assert resp.status_code == 200
    assert resp.json()["delivery_status"] == "delivered"

    # Un-complete → delivery_status flips back to 'pending'.
    resp = client.put(f"/api/stops/{created['id']}",
                      json={"completed": False, "delivery_status": "delivered"})
    assert resp.json()["delivery_status"] == "pending"


def test_update_tracking_number_round_trip(client):
    """Driver-typed tracking number must round-trip through PATCH and become
    immediately scannable by van-scan (which queries the same field). Schema
    silently dropped this until 2026-05; now it's a first-class StopUpdate
    field with set/clear/no-op semantics."""
    created = client.post("/api/stops", json={
        "address": "9 Tracking Rd", "name": "trk",
        "latitude": -27.9, "longitude": 153.9,
    }).json()
    assert created.get("tracking_number") in (None, "")

    # SET — driver typed in a new tracking number.
    resp = client.put(f"/api/stops/{created['id']}", json={"tracking_number": "TRK-12345"})
    assert resp.status_code == 200
    assert resp.json()["tracking_number"] == "TRK-12345"

    # NO-OP — payload omits the field; previous value must persist.
    resp = client.put(f"/api/stops/{created['id']}", json={"notes": "ring twice"})
    assert resp.status_code == 200
    assert resp.json()["tracking_number"] == "TRK-12345"
    assert resp.json()["notes"] == "ring twice"

    # CLEAR — driver wiped the field (sent null).
    resp = client.put(f"/api/stops/{created['id']}", json={"tracking_number": None})
    assert resp.status_code == 200
    assert resp.json()["tracking_number"] in (None, "")


def test_complete_uncomplete_endpoints(client):
    s = client.post("/api/stops", json={
        "address": "3 Complete St", "name": "c",
        "latitude": -27.2, "longitude": 153.2,
    }).json()

    resp = client.post(f"/api/stops/{s['id']}/complete")
    assert resp.status_code == 200
    assert resp.json()["completed"] is True
    assert resp.json()["delivery_status"] == "delivered"

    resp = client.post(f"/api/stops/{s['id']}/uncomplete")
    assert resp.status_code == 200
    assert resp.json()["completed"] is False
    assert resp.json()["delivery_status"] == "pending"


def test_delete_reindexes_remaining_stops(client):
    created = [
        client.post("/api/stops", json={
            "address": f"{i} Order St", "name": f"o{i}",
            "latitude": -27.0 - i * 0.01, "longitude": 153.0 + i * 0.01,
        }).json()
        for i in range(3)
    ]
    assert [s["order"] for s in created] == [0, 1, 2]

    # Delete the middle one — remaining two must re-index to 0, 1.
    resp = client.delete(f"/api/stops/{created[1]['id']}")
    assert resp.status_code == 200
    assert resp.json()["remaining_count"] == 2

    listing = sorted(client.get("/api/stops").json(), key=lambda s: s["order"])
    assert [s["order"] for s in listing] == [0, 1]
    assert {s["id"] for s in listing} == {created[0]["id"], created[2]["id"]}


def test_reorder(client):
    stops = [
        client.post("/api/stops", json={
            "address": f"{i} Reorder St", "name": f"r{i}",
            "latitude": -27.3 - i * 0.01, "longitude": 153.3 + i * 0.01,
        }).json()
        for i in range(3)
    ]
    # Reverse the order.
    reversed_ids = [s["id"] for s in reversed(stops)]
    resp = client.post("/api/stops/reorder", json={"stop_ids": reversed_ids})
    assert resp.status_code == 200

    listing = sorted(client.get("/api/stops").json(), key=lambda s: s["order"])
    assert [s["id"] for s in listing] == reversed_ids


def test_clear_all(client):
    for i in range(2):
        client.post("/api/stops", json={
            "address": f"{i} Clr St", "name": f"x{i}",
            "latitude": -27.4 - i * 0.01, "longitude": 153.4 + i * 0.01,
        })

    resp = client.post("/api/stops/clear")
    assert resp.status_code == 200
    assert resp.json()["deleted_count"] == 2
    assert client.get("/api/stops").json() == []


def test_debug_stops_coords(client):
    client.post("/api/stops", json={
        "address": "Debug Address 12345", "name": "d",
        "latitude": -27.5, "longitude": 153.5,
    })
    resp = client.get("/api/debug/stops-coords")
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["lat"] == -27.5 and rows[0]["lng"] == 153.5



# ── Route confirmation / sequence_number locking ─────────────────────────


def _make_stops(client, n):
    """Helper: create n stops with distinct coords, return their IDs in creation order."""
    return [
        client.post("/api/stops", json={
            "address": f"{i} Confirm St",
            "name": f"c{i}",
            "latitude": -27.9 - i * 0.01,
            "longitude": 153.9 + i * 0.01,
        }).json()["id"]
        for i in range(n)
    ]


def test_confirm_route_locks_sequence(client):
    ids = _make_stops(client, 4)
    # Confirm in REVERSE order — GET should now return them reversed too,
    # regardless of the mutable `order` field.
    reversed_ids = list(reversed(ids))
    resp = client.post("/api/routes/confirm", json={"confirmed_sequence": reversed_ids})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "confirmed"
    assert body["locked_count"] == 4

    # NEW: server now returns the stamped stops in payload order so the
    # frontend Zustand store can hard-replace its local state without a
    # separate GET. Verify shape + Sharpie-marker fields are populated.
    assert "stops" in body and isinstance(body["stops"], list)
    assert len(body["stops"]) == 4
    assert [s["id"] for s in body["stops"]] == reversed_ids
    assert [s["sequence_number"] for s in body["stops"]] == [1, 2, 3, 4]
    assert [s["original_sequence"] for s in body["stops"]] == [1, 2, 3, 4]

    listing = client.get("/api/stops").json()
    assert [s["id"] for s in listing] == reversed_ids
    assert [s["sequence_number"] for s in listing] == [1, 2, 3, 4]


def test_confirm_route_clears_previous_ranks_for_omitted_stops(client):
    ids = _make_stops(client, 3)
    # First confirm all 3 → ranks 1,2,3.
    client.post("/api/routes/confirm", json={"confirmed_sequence": ids})
    # Now re-confirm with only the first 2 → stop #3 must drop back to null.
    client.post("/api/routes/confirm", json={"confirmed_sequence": ids[:2]})

    by_id = {s["id"]: s for s in client.get("/api/stops").json()}
    assert by_id[ids[0]]["sequence_number"] == 1
    assert by_id[ids[1]]["sequence_number"] == 2
    assert by_id[ids[2]]["sequence_number"] in (None, 0) or by_id[ids[2]].get("sequence_number") is None


def test_confirm_route_rejects_duplicate_ids(client):
    ids = _make_stops(client, 2)
    resp = client.post("/api/routes/confirm",
                       json={"confirmed_sequence": [ids[0], ids[1], ids[0]]})
    assert resp.status_code == 400
    assert "duplicate" in resp.text.lower()


def test_confirm_route_rejects_unknown_ids(client):
    ids = _make_stops(client, 1)
    resp = client.post("/api/routes/confirm",
                       json={"confirmed_sequence": [ids[0], "deadbeef-not-a-real-id"]})
    assert resp.status_code == 400
    assert "non-owned" in resp.text.lower() or "unknown" in resp.text.lower()


def test_confirm_route_rejects_empty_payload(client):
    resp = client.post("/api/routes/confirm", json={"confirmed_sequence": []})
    # Pydantic's min_length=1 turns this into a 422.
    assert resp.status_code in (400, 422)


def test_get_stops_sorts_confirmed_before_unconfirmed(client):
    # Create 3 stops, confirm only the LAST one → it should come FIRST in
    # GET despite having the highest `order`.
    ids = _make_stops(client, 3)
    client.post("/api/routes/confirm", json={"confirmed_sequence": [ids[2]]})
    listing = client.get("/api/stops").json()
    assert listing[0]["id"] == ids[2]
    assert listing[0]["sequence_number"] == 1
    # Remaining two keep their mutable `order` tiebreak.
    assert {s["id"] for s in listing[1:]} == {ids[0], ids[1]}


# ── arrival_method fallback + ML readiness ───────────────────────────────


def test_complete_stamps_arrival_fallback_when_geofence_skipped(client):
    """Tap Delivered without ever crossing the geofence → backstop fires."""
    sid = client.post("/api/stops", json={
        "address": "1 Fallback Rd", "name": "fb",
        "latitude": -27.7, "longitude": 153.7,
    }).json()["id"]

    resp = client.post(f"/api/stops/{sid}/complete", json={})
    assert resp.status_code == 200
    body = resp.json()
    assert body["completed"] is True
    assert body["arrived_at"] is not None
    assert body["arrival_method"] == "fallback_completion"

    # arrived_at must be ~30 s before completed_at, never after it.
    from datetime import datetime
    arr = datetime.fromisoformat(body["arrived_at"].replace("Z", "+00:00"))
    comp = datetime.fromisoformat(body["completed_at"].replace("Z", "+00:00"))
    assert 25 <= (comp - arr).total_seconds() <= 35


def test_complete_preserves_real_geofence_arrival(client):
    """If the geofence already fired, /complete must NOT overwrite arrived_at."""
    sid = client.post("/api/stops", json={
        "address": "2 Real Rd", "name": "real",
        "latitude": -27.71, "longitude": 153.71,
    }).json()["id"]
    # Real geofence event arrives first.
    a = client.post(f"/api/stops/{sid}/arrived", json={}).json()
    real_arrived_at = a["arrived_at"]
    assert a["arrival_method"] == "geofence"

    c = client.post(f"/api/stops/{sid}/complete", json={}).json()
    assert c["arrived_at"] == real_arrived_at  # unchanged
    assert c["arrival_method"] == "geofence"   # unchanged


def test_ml_readiness_reports_pipeline_health(client):
    """Counts pairs by arrival_method and returns a readiness verdict."""
    # 1 geofence pair
    s1 = client.post("/api/stops", json={
        "address": "1 G", "name": "g",
        "latitude": -27.8, "longitude": 153.8,
    }).json()["id"]
    client.post(f"/api/stops/{s1}/arrived", json={})
    client.post(f"/api/stops/{s1}/complete", json={})

    # 1 fallback pair
    s2 = client.post("/api/stops", json={
        "address": "2 F", "name": "f",
        "latitude": -27.81, "longitude": 153.81,
    }).json()["id"]
    client.post(f"/api/stops/{s2}/complete", json={})

    r = client.get("/api/admin/ml/readiness").json()
    assert r["readiness"] == "insufficient"  # only 2 pairs, well below 50
    assert r["service_time_pairs"] == 2
    assert r["service_time_pairs_geofence"] == 1
    assert r["service_time_pairs_fallback"] == 1
    assert r["service_time_pairs_last_7d"] == 2
    assert r["thresholds"]["min_trainable"] == 50


# ── Live-re-stamp contract (2026-05-09) ──────────────────────────────────
# Earlier the contract was "Sharpie-marker immutable original_sequence":
# the field was set on first confirm and never overwritten so a driver
# could write the badge number on the parcel and have it stay valid
# forever. Drivers re-optimising mid-shift found that confusing — the
# polyline danced around the map but the badges stayed frozen at numbers
# nobody recognised. We flipped the contract: every re-confirm now
# overwrites `original_sequence` so the on-screen badges always match
# the freshly-optimised drive order. Box-level pre-labelling is now an
# explicit "label AFTER you confirm" workflow, not a per-row guarantee.


def test_confirm_writes_original_sequence_on_first_confirm(client):
    ids = _make_stops(client, 3)
    client.post("/api/routes/confirm", json={"confirmed_sequence": ids})
    listing = client.get("/api/stops").json()
    # original_sequence matches the index in the FIRST confirm.
    assert {s["id"]: s["original_sequence"] for s in listing} == {
        ids[0]: 1, ids[1]: 2, ids[2]: 3
    }


def test_reoptimise_overwrites_original_sequence(client):
    """Live re-stamp contract: re-confirming with a different order
    overwrites BOTH `sequence_number` and `original_sequence` so the
    badges always track the latest optimised drive order."""
    ids = _make_stops(client, 3)
    client.post("/api/routes/confirm", json={"confirmed_sequence": ids})
    # Re-optimise: reverse order. Both fields must follow the new order.
    reversed_ids = list(reversed(ids))
    client.post("/api/routes/confirm", json={"confirmed_sequence": reversed_ids})

    by_id = {s["id"]: s for s in client.get("/api/stops").json()}
    # original_sequence is now overwritten to match the live drive order.
    assert by_id[ids[0]]["original_sequence"] == 3
    assert by_id[ids[1]]["original_sequence"] == 2
    assert by_id[ids[2]]["original_sequence"] == 1
    # sequence_number reflects the same new drive order.
    assert by_id[ids[0]]["sequence_number"] == 3
    assert by_id[ids[1]]["sequence_number"] == 2
    assert by_id[ids[2]]["sequence_number"] == 1


def test_new_stop_added_post_confirm_takes_position_in_next_confirm(client):
    """Driver picks up an extra parcel mid-route. After re-confirming
    with the new id appended, every stop's `original_sequence` reflects
    its new position — the old "Sharpie freeze" guarantee is gone."""
    ids = _make_stops(client, 2)
    client.post("/api/routes/confirm", json={"confirmed_sequence": ids})

    new_id = client.post("/api/stops", json={
        "address": "99 New Pickup Rd", "name": "new",
        "latitude": -27.95, "longitude": 153.95,
    }).json()["id"]

    client.post("/api/routes/confirm",
                json={"confirmed_sequence": ids + [new_id]})

    by_id = {s["id"]: s for s in client.get("/api/stops").json()}
    assert by_id[ids[0]]["original_sequence"] == 1
    assert by_id[ids[1]]["original_sequence"] == 2
    assert by_id[new_id]["original_sequence"] == 3
