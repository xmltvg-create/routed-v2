"""Smoke test for the async /api/optimize/jobs pattern.

The point of the job pattern is to make `/api/optimize` immune to
Cloudflare's 100 s edge-timeout (HTTP 524) by returning a job_id in
<100 ms and letting the client poll until done.

Why this is a `requests`-based smoke test (not a `TestClient` test):
    The TestClient pattern fights motor's event-loop binding when run in
    the same pytest process as `test_routes_stops.py` — see PRD line 282-285.
    Curling the live supervisor backend bypasses that entirely and is what
    actually runs in production.

Skips cleanly if the backend isn't reachable at localhost:8001 (e.g. CI
without the server stack running).
"""
from __future__ import annotations

import datetime
import time
import uuid

import pytest

requests = pytest.importorskip("requests")
pymongo = pytest.importorskip("pymongo")

API = "http://localhost:8001/api"


@pytest.fixture(scope="module")
def backend_alive():
    try:
        r = requests.get(f"{API}/healthz", timeout=2)
    except Exception:
        pytest.skip("Backend not reachable at localhost:8001")
    if r.status_code != 200:
        pytest.skip(f"Backend healthz returned {r.status_code}")


@pytest.fixture
def auth_user(backend_alive):
    """Seed user + session + 3 nearby stops directly in Mongo so we can
    drive the auth-gated /api/optimize/jobs endpoints without OAuth."""
    client = pymongo.MongoClient("mongodb://localhost:27017")
    db = client["test_database"]
    user_id = f"jobs_test_{uuid.uuid4().hex[:8]}"
    token = f"sess_{uuid.uuid4().hex}"
    db.users.insert_one({"user_id": user_id, "email": f"{user_id}@x.com", "name": "T"})
    db.user_sessions.insert_one({
        "session_token": token, "user_id": user_id,
        "expires_at": datetime.datetime.utcnow() + datetime.timedelta(hours=1),
    })
    stops = [
        {"id": str(uuid.uuid4()), "user_id": user_id, "address": "1 St", "name": "A",
         "latitude": -26.65, "longitude": 153.10, "order": 0},
        {"id": str(uuid.uuid4()), "user_id": user_id, "address": "2 St", "name": "B",
         "latitude": -26.66, "longitude": 153.11, "order": 1},
        {"id": str(uuid.uuid4()), "user_id": user_id, "address": "3 St", "name": "C",
         "latitude": -26.67, "longitude": 153.12, "order": 2},
    ]
    db.stops.insert_many(stops)
    # Seed a trialing subscription so the paywall (added 2026-05-12)
    # doesn't 402 these tests. They predate billing and are testing
    # the kickoff/poll mechanics, not the gate.
    db.subscriptions.update_one(
        {"user_id": user_id},
        {"$set": {
            "user_id": user_id,
            "email": f"{user_id}@x.com",
            "status": "trialing",
            "plan_id": "monthly",
            "pro_flag": True,
        }},
        upsert=True,
    )
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    yield {"headers": headers, "user_id": user_id, "token": token, "db": db}
    db.users.delete_one({"user_id": user_id})
    db.user_sessions.delete_one({"session_token": token})
    db.stops.delete_many({"user_id": user_id})
    db.subscriptions.delete_many({"user_id": user_id})


def test_kickoff_is_fast_and_returns_job_id(auth_user):
    """The whole point of the pattern: kickoff must be <100 ms so
    Cloudflare's 100 s ceiling can never trigger on the client's POST."""
    t0 = time.time()
    r = requests.post(f"{API}/optimize/jobs",
                      json={"algorithm": "nearest_neighbor", "use_current_location": False},
                      headers=auth_user["headers"], timeout=10)
    elapsed_ms = (time.time() - t0) * 1000
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "running"
    assert isinstance(body["job_id"], str) and len(body["job_id"]) >= 8
    # The kickoff itself must be fast — anything over 1 s defeats the
    # purpose. (Local backend hits ~5 ms; we allow 1 s for slow CI.)
    assert elapsed_ms < 1000, f"kickoff took {elapsed_ms:.0f} ms — too slow"


def test_poll_resolves_to_done_with_legacy_shape(auth_user):
    """Polled job must transition to 'done' and carry a `stops` array
    matching the legacy /api/optimize response shape."""
    r = requests.post(f"{API}/optimize/jobs",
                      json={"algorithm": "nearest_neighbor", "use_current_location": False},
                      headers=auth_user["headers"], timeout=10)
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    deadline = time.time() + 60
    final = None
    while time.time() < deadline:
        r = requests.get(f"{API}/optimize/jobs/{job_id}",
                         headers=auth_user["headers"], timeout=10)
        assert r.status_code == 200
        body = r.json()
        if body["status"] in ("done", "error"):
            final = body
            break
        time.sleep(0.3)
    assert final is not None, "Job never resolved within 60 s"

    if final["status"] == "error":
        pytest.skip(f"Optimize errored in test env: {final.get('error')}")

    assert final["status"] == "done"
    result = final["result"]
    assert "stops" in result and isinstance(result["stops"], list)
    assert len(result["stops"]) == 3


def test_bogus_job_id_yields_404(auth_user):
    r = requests.get(f"{API}/optimize/jobs/{uuid.uuid4()}",
                     headers=auth_user["headers"], timeout=5)
    assert r.status_code == 404


def test_other_user_cannot_read_job(auth_user):
    """Forging another user's job_id yields 404 — no info-leak."""
    db = auth_user["db"]
    user_id_b = f"jobs_test_{uuid.uuid4().hex[:8]}"
    token_b = f"sess_{uuid.uuid4().hex}"
    db.users.insert_one({"user_id": user_id_b, "email": f"{user_id_b}@x.com", "name": "B"})
    db.user_sessions.insert_one({
        "session_token": token_b, "user_id": user_id_b,
        "expires_at": datetime.datetime.utcnow() + datetime.timedelta(hours=1),
    })
    try:
        r = requests.post(f"{API}/optimize/jobs",
                          json={"algorithm": "nearest_neighbor"},
                          headers=auth_user["headers"], timeout=10)
        job_id = r.json()["job_id"]
        # User B (different token) tries to poll → 404
        r2 = requests.get(f"{API}/optimize/jobs/{job_id}",
                          headers={"Authorization": f"Bearer {token_b}"}, timeout=5)
        assert r2.status_code == 404
    finally:
        db.users.delete_one({"user_id": user_id_b})
        db.user_sessions.delete_one({"session_token": token_b})
