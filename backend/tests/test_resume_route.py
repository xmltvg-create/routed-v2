"""Regression tests for `POST /api/routes/history/{id}/resume`.

These cover the failure modes that caused production "Failed to resume route"
errors on 2026-05-19:
  - Legacy archives owned by a previous user_id (auth migration).
  - Duplicate stop ids inside the archived `stops` array (would 500 on
    insert_many due to the unique (id, user_id) index on `stops`).
  - Completion telemetry (completion_lat, arrival_method, arrived_at, …)
    must be cleared so resumed stops show as pending.
  - Unknown route ids return a structured 404 detail the client can show.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import requests
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

API_BASE = os.environ.get("RESUME_TEST_API", "http://localhost:8001")


def _register() -> tuple[str, str]:
    email = f"resume-{uuid.uuid4().hex[:8]}@test.com"
    r = requests.post(
        f"{API_BASE}/api/auth/register-email",
        json={"email": email, "password": "testpass123", "name": "Resume Test"},
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    return data["user_id"], data["session_token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_resume_unknown_id_returns_404_with_detail():
    _, token = _register()
    r = requests.post(
        f"{API_BASE}/api/routes/history/does-not-exist/resume",
        headers=_auth(token),
        timeout=10,
    )
    assert r.status_code == 404
    assert "not found" in r.json()["detail"].lower()


def test_resume_round_trip_clears_completion_fields():
    """Archive a route with delivered stops, resume, ensure pristine pending."""
    user_id, token = _register()

    # 1. Add stops
    for i in range(3):
        r = requests.post(
            f"{API_BASE}/api/stops",
            headers=_auth(token),
            json={
                "address": f"{i} Resume Lane SYDNEY NSW 2000",
                "latitude": -33.86 + i * 0.001,
                "longitude": 151.20 + i * 0.001,
                "order": i,
            },
            timeout=10,
        )
        assert r.status_code == 200, r.text

    # 2. Mark first stop completed with full telemetry
    stops = requests.get(f"{API_BASE}/api/stops", headers=_auth(token), timeout=10).json()
    first_id = stops[0]["id"]
    requests.post(
        f"{API_BASE}/api/stops/{first_id}/complete",
        headers=_auth(token),
        json={
            "completion_lat": -33.861,
            "completion_lng": 151.201,
            "arrival_method": "geofence",
        },
        timeout=10,
    )

    # 3. Archive
    archive = requests.post(
        f"{API_BASE}/api/routes/archive",
        headers=_auth(token),
        json={},
        timeout=10,
    ).json()
    assert archive.get("archived")
    route_id = archive["route"]["id"]

    # 4. Clear stops & resume
    requests.post(f"{API_BASE}/api/stops/clear", headers=_auth(token), timeout=10)
    r = requests.post(
        f"{API_BASE}/api/routes/history/{route_id}/resume",
        headers=_auth(token),
        timeout=10,
    )
    assert r.status_code == 200, r.text
    assert r.json()["resumed"] is True
    assert r.json()["stops_count"] == 3

    # 5. Verify resumed stops are pristine pending
    resumed = requests.get(f"{API_BASE}/api/stops", headers=_auth(token), timeout=10).json()
    assert len(resumed) == 3
    for s in resumed:
        assert s["completed"] is False
        assert s["delivery_status"] == "pending"
        assert s.get("completed_at") is None
        assert s.get("arrived_at") is None
        assert s.get("arrival_method") is None
        assert s.get("completion_lat") is None
        assert s.get("completion_lng") is None


@pytest.mark.asyncio
async def test_resume_legacy_archive_and_duplicate_stop_ids():
    """Direct-DB seed of a legacy archive owned by a different user_id +
    duplicate stop ids inside the archive. Resume should:
      - Fall back to the legacy lookup (log warning, succeed).
      - Dedupe stop ids so the unique (id, user_id) index doesn't 500.
    """
    from motor.motor_asyncio import AsyncIOMotorClient

    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    _, token = _register()
    legacy_route_id = f"legacy-{uuid.uuid4()}"
    archived = {
        "id": legacy_route_id,
        "user_id": "GHOST_OLD_USER_ID",
        "archived_at": datetime.now(timezone.utc).isoformat(),
        "stops": [
            {"id": str(uuid.uuid4()), "address": "1 Old St", "latitude": -33.8, "longitude": 151.2, "order": 0},
            {"id": "DUP", "address": "2 Old St", "latitude": -33.81, "longitude": 151.21, "order": 1},
            {"id": "DUP", "address": "3 Old St", "latitude": -33.82, "longitude": 151.22, "order": 2},
        ],
        "summary": {"total_stops": 3},
    }
    await db.route_history.insert_one(archived)
    try:
        r = requests.post(
            f"{API_BASE}/api/routes/history/{legacy_route_id}/resume",
            headers=_auth(token),
            timeout=10,
        )
        assert r.status_code == 200, r.text
        assert r.json()["stops_count"] == 3
    finally:
        await db.route_history.delete_one({"id": legacy_route_id})
        client.close()
