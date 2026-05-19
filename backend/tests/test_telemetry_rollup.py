"""Live-backend smoke tests for the /api/_meta/telemetry-rollup
diagnostic endpoint and the algorithm-persistence change to
/api/routes/archive.

Uses the same pattern as test_optimize_jobs.py — seeds Mongo directly,
curls the live supervisor backend, asserts behaviour. Skips cleanly if
the backend isn't reachable at localhost:8001.

Why these matter:
  The rollup endpoint is the agent's ONLY window into production
  telemetry (the preview pod cannot read production's Atlas). If it
  regresses, the agent can no longer answer "which algorithm did I
  use today?" without users manually shipping CSVs.
"""
from __future__ import annotations

import datetime
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
    """Seed a deterministic user + session in Mongo; yield (headers,
    user_id, db). Cleans up after the test."""
    client = pymongo.MongoClient("mongodb://localhost:27017")
    db = client["test_database"]
    user_id = f"rollup_test_{uuid.uuid4().hex[:8]}"
    token = f"sess_{uuid.uuid4().hex}"
    db.users.insert_one({"user_id": user_id, "email": f"{user_id}@x.com", "name": "T"})
    db.user_sessions.insert_one({
        "session_token": token, "user_id": user_id,
        "expires_at": datetime.datetime.utcnow() + datetime.timedelta(hours=1),
    })
    headers = {"Authorization": f"Bearer {token}"}
    yield headers, user_id, db
    # Cleanup
    db.users.delete_many({"user_id": user_id})
    db.user_sessions.delete_many({"user_id": user_id})
    db.stops.delete_many({"user_id": user_id})
    db.route_history.delete_many({"user_id": user_id})


def _make_route_doc(user_id: str, *, when: datetime.datetime, algorithm: str | None,
                    delivered: int = 10, geofence: int = 5,
                    completion_dists_m: list[int] | None = None,
                    service_seconds: list[int] | None = None) -> dict:
    stops = []
    cd = completion_dists_m or [100] * delivered
    ss = service_seconds or [60] * geofence
    for i in range(delivered):
        is_geo = i < geofence
        arrived = when + datetime.timedelta(minutes=i * 2)
        srv = ss[i] if (is_geo and i < len(ss)) else 60
        completed = arrived + datetime.timedelta(seconds=srv if is_geo else 0)
        stops.append({
            "id": f"s{i}",
            "completed": True,
            "delivery_status": "delivered",
            "arrival_method": "geofence" if is_geo else "fallback_completion",
            "completion_distance_m": cd[i] if i < len(cd) else 100,
            "arrived_at": arrived.isoformat() if is_geo else None,
            "completed_at": completed.isoformat(),
        })
    return {
        "id": f"route-{when.timestamp()}-{uuid.uuid4().hex[:6]}",
        "user_id": user_id,
        "archived_at": when.isoformat(),
        "started_at": when.isoformat(),
        "finished_at": when.isoformat(),
        "stops": stops,
        "summary": {
            "total_stops": delivered,
            "delivered": delivered,
            "skipped": 0,
            "failed": 0,
            "pending": 0,
            "algorithm": algorithm,
        },
    }


def test_rollup_empty_user_returns_zeroed_shape(auth_user):
    """Brand-new user with zero archives → 200 + nullable fields = None."""
    headers, user_id, db = auth_user
    r = requests.get(f"{API}/_meta/telemetry-rollup", headers=headers, timeout=10)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user_id"] == user_id
    assert body["today"]["archived_routes"] == 0
    assert body["today"]["best_route"] is None
    assert body["today"]["completion_distance_p50_m"] is None
    assert body["last_7_days"]["archived_routes"] == 0
    assert body["ml_readiness"]["ready_to_train"] is False


def test_rollup_isolates_user_data(auth_user):
    """Privacy invariant: must not see another user_id's archives."""
    headers, user_id, db = auth_user
    now = datetime.datetime.now(datetime.timezone.utc)
    db.route_history.insert_one(_make_route_doc(user_id, when=now, algorithm="vroom_lkh_3opt"))
    other_id = f"OTHER_{uuid.uuid4().hex[:6]}"
    db.route_history.insert_one(_make_route_doc(other_id, when=now, algorithm="should_never_appear"))
    try:
        r = requests.get(f"{API}/_meta/telemetry-rollup", headers=headers, timeout=10)
        body = r.json()
        assert body["today"]["archived_routes"] == 1
        assert body["today"]["best_route"]["algorithm"] == "vroom_lkh_3opt"
    finally:
        db.route_history.delete_many({"user_id": other_id})


def test_rollup_today_window_excludes_yesterday(auth_user):
    """Routes before today's 00:00 UTC count only toward 7-day window."""
    headers, user_id, db = auth_user
    now = datetime.datetime.now(datetime.timezone.utc)
    yesterday = now - datetime.timedelta(days=1, hours=2)
    db.route_history.insert_one(_make_route_doc(user_id, when=yesterday, algorithm="cluster_first"))
    db.route_history.insert_one(_make_route_doc(user_id, when=now, algorithm="vroom_lkh_3opt"))
    r = requests.get(f"{API}/_meta/telemetry-rollup", headers=headers, timeout=10)
    body = r.json()
    assert body["today"]["archived_routes"] == 1
    assert body["today"]["best_route"]["algorithm"] == "vroom_lkh_3opt"
    assert body["last_7_days"]["archived_routes"] == 2


def test_rollup_geofence_vs_fallback_split(auth_user):
    """Per-stop arrival_method counts summed correctly across the window."""
    headers, user_id, db = auth_user
    now = datetime.datetime.now(datetime.timezone.utc)
    db.route_history.insert_one(_make_route_doc(
        user_id, when=now, algorithm="x",
        delivered=10, geofence=3,
        completion_dists_m=list(range(10, 110, 10)),
        service_seconds=[60, 120, 180],
    ))
    r = requests.get(f"{API}/_meta/telemetry-rollup", headers=headers, timeout=10)
    body = r.json()
    assert body["today"]["geofence_count"] == 3
    assert body["today"]["fallback_count"] == 7
    assert body["today"]["geofence_rate"] == 0.3
    assert body["today"]["service_samples"] == 3
    assert body["today"]["distance_samples"] == 10


def test_rollup_diagnoses_geofence_telemetry_bug(auth_user):
    """When every recent completion is fallback_completion, blocked_on
    must explicitly point at the geofence bug — this is the agent's
    primary triage signal."""
    headers, user_id, db = auth_user
    now = datetime.datetime.now(datetime.timezone.utc)
    db.route_history.insert_one(_make_route_doc(
        user_id, when=now, algorithm="x", delivered=10, geofence=0,
    ))
    r = requests.get(f"{API}/_meta/telemetry-rollup", headers=headers, timeout=10)
    body = r.json()
    assert body["ml_readiness"]["real_geofence_samples_last_7d"] == 0
    blocked = body["ml_readiness"]["blocked_on"]
    assert blocked is not None
    assert "geofence not firing" in blocked
    assert "fallback_completion" in blocked


def test_rollup_requires_auth(backend_alive):
    """No Authorization header → 401/403; never 200 with someone else's data."""
    r = requests.get(f"{API}/_meta/telemetry-rollup", timeout=10)
    assert r.status_code in (401, 403), r.text


def test_archive_persists_algorithm_into_summary(auth_user):
    """POST /api/routes/archive with algorithm + totals → those fields
    land in route_history.summary."""
    headers, user_id, db = auth_user
    db.stops.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "address": "1 Test St",
        "name": "Test",
        "latitude": -26.78,
        "longitude": 153.10,
        "order": 0,
        "completed": True,
    })
    r = requests.post(
        f"{API}/routes/archive",
        json={
            "algorithm": "vroom_lkh_3opt",
            "total_distance_km": 187.3,
            "total_duration_seconds": 24720,
        },
        headers=headers,
        timeout=10,
    )
    assert r.status_code == 200, r.text
    assert r.json().get("archived") is True
    archived = db.route_history.find_one({"user_id": user_id}, {"_id": 0})
    assert archived is not None
    assert archived["summary"]["algorithm"] == "vroom_lkh_3opt"
    assert archived["summary"]["total_distance_km"] == 187.3
    assert archived["summary"]["total_duration_seconds"] == 24720


def test_archive_without_body_still_works_backwards_compat(auth_user):
    """Legacy clients POSTing with no body must still archive cleanly;
    summary.algorithm comes through as None."""
    headers, user_id, db = auth_user
    db.stops.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "address": "1 Test St",
        "name": "Test",
        "latitude": -26.78,
        "longitude": 153.10,
        "order": 0,
        "completed": True,
    })
    # Empty body, but Content-Type still set (matches the frontend now).
    r = requests.post(f"{API}/routes/archive", json={}, headers=headers, timeout=10)
    assert r.status_code == 200, r.text
    archived = db.route_history.find_one({"user_id": user_id}, {"_id": 0})
    assert archived["summary"]["algorithm"] is None
    assert archived["summary"]["total_distance_km"] is None
