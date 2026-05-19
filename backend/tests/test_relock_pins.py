"""Unit tests for `POST /api/stops/relock-pins` — re-stamps
`original_sequence` from the current `order` field without
running a solver.

Pattern mirrors `test_routes_stops.py` (module-scoped TestClient +
_current_user override) — no real auth round-trip needed.
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
    import server  # noqa: WPS433
    from routes.stops import _current_user

    test_user = server.User(
        user_id=f"pytest-relock-{uuid.uuid4().hex[:8]}",
        email="pytest-relock@example.com",
        name="Pytest Relock",
        picture=None,
        created_at=datetime.now(timezone.utc),
    )
    server.app.dependency_overrides[_current_user] = lambda: test_user

    with TestClient(server.app) as tc:
        yield tc

    import asyncio
    async def _cleanup():
        await server.db.stops.delete_many({"user_id": test_user.user_id})
    try:
        asyncio.run(_cleanup())
    except RuntimeError:
        pass
    server.app.dependency_overrides.pop(_current_user, None)


@pytest.fixture(autouse=True)
def _reset(client):
    client.delete("/api/stops")
    yield


def _seed(client: TestClient, n: int) -> list[str]:
    ids = []
    for i in range(n):
        r = client.post(
            "/api/stops",
            json={
                "address": f"{i + 1} Test Street, Caloundra QLD",
                "name": f"Stop {i + 1}",
                "latitude": -26.78 + i * 0.001,
                "longitude": 153.10 + i * 0.001,
            },
        )
        assert r.status_code in (200, 201), r.text
        ids.append(r.json()["id"])
    return ids


def test_relock_pins_writes_original_sequence_from_order(client):
    """Happy path: 4 stops, all `original_sequence` initially null,
    `order` 0..3. Calling relock-pins must set original_sequence to 1..4."""
    ids = _seed(client, 4)
    pre = client.get("/api/stops").json()
    assert all(s.get("original_sequence") is None for s in pre)

    r = client.post("/api/stops/relock-pins")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["restored"] == 4
    assert body["total"] == 4

    post = client.get("/api/stops").json()
    by_id = {s["id"]: s for s in post}
    for i, sid in enumerate(ids):
        assert by_id[sid]["original_sequence"] == i + 1


def test_relock_pins_overwrites_existing_lock(client):
    """If `original_sequence` is already stamped (prior lock), relock-pins
    must overwrite from the current order — that's the whole point of
    'refresh pin numbers after re-optimise'."""
    ids = _seed(client, 3)
    r1 = client.post("/api/stops/relock-pins")
    assert r1.status_code == 200

    reversed_ids = list(reversed(ids))
    r2 = client.post("/api/stops/reorder", json={"stop_ids": reversed_ids})
    assert r2.status_code == 200

    r3 = client.post("/api/stops/relock-pins")
    assert r3.status_code == 200

    post = client.get("/api/stops").json()
    by_id = {s["id"]: s for s in post}
    for new_pos, sid in enumerate(reversed_ids):
        assert by_id[sid]["original_sequence"] == new_pos + 1


def test_relock_pins_idempotent(client):
    """Twice in a row → identical state, no drift."""
    _seed(client, 5)
    client.post("/api/stops/relock-pins")
    a = client.get("/api/stops").json()
    client.post("/api/stops/relock-pins")
    b = client.get("/api/stops").json()
    assert sorted([(s["id"], s["original_sequence"]) for s in a]) == \
           sorted([(s["id"], s["original_sequence"]) for s in b])


def test_relock_pins_empty_returns_zero(client):
    """No stops → must return {restored:0, total:0}, not 500."""
    r = client.post("/api/stops/relock-pins")
    assert r.status_code == 200
    body = r.json()
    assert body["restored"] == 0
    assert body["total"] == 0
