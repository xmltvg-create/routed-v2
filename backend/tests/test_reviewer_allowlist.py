"""Live-backend tests for the Google Play reviewer allowlist.

Validates that an email in `REVIEWER_EMAILS`:

1. `/api/billing/status` returns `pro=true` even without a Stripe subscription.
2. `/api/optimize/jobs` (paywalled) accepts the request (202) instead of 402.

Also validates that the reviewer demo-route seeding from
`routes.auth._seed_reviewer_demo_route` inserts 6 Sydney stops the
first time it runs for a new account and is idempotent on the second call.

Same pattern as test_billing.py: seed Mongo directly, curl localhost:8001,
assert behaviour.
"""
from __future__ import annotations

import asyncio
import datetime
import os
import uuid

import pytest

requests = pytest.importorskip("requests")
pymongo = pytest.importorskip("pymongo")
motor_asyncio = pytest.importorskip("motor.motor_asyncio")

API = "http://localhost:8001/api"


def _read_env_value(key: str) -> str:
    """Read a value from backend/.env so tests don't depend on env inheritance."""
    try:
        with open("/app/backend/.env") as f:
            for line in f:
                if line.startswith(f"{key}="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return os.environ.get(key, "")


@pytest.fixture(scope="module")
def backend_alive():
    try:
        r = requests.get(f"{API}/healthz", timeout=2)
    except Exception:
        pytest.skip("Backend not reachable at localhost:8001")
    if r.status_code != 200:
        pytest.skip(f"Backend healthz returned {r.status_code}")


@pytest.fixture
def reviewer_email():
    csv = _read_env_value("REVIEWER_EMAILS")
    emails = [e.strip().lower() for e in csv.split(",") if e.strip()]
    if not emails:
        pytest.skip("REVIEWER_EMAILS not configured in backend/.env")
    return emails[0]


@pytest.fixture
def reviewer_user(backend_alive, reviewer_email):
    """Create a synthetic user record using the reviewer email, attach a
    session token, yield auth headers. Cleans up everything on teardown."""
    client = pymongo.MongoClient("mongodb://localhost:27017")
    db = client["test_database"]
    uid = f"reviewer_{uuid.uuid4().hex[:8]}"
    tok = f"sess_{uuid.uuid4().hex}"
    db.users.insert_one({
        "user_id": uid,
        "email": reviewer_email,
        "name": "Play Reviewer",
    })
    db.user_sessions.insert_one({
        "session_token": tok,
        "user_id": uid,
        "expires_at": datetime.datetime.utcnow() + datetime.timedelta(hours=1),
    })
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    yield headers, uid, db
    db.users.delete_many({"user_id": uid})
    db.user_sessions.delete_many({"user_id": uid})
    db.stops.delete_many({"user_id": uid})
    db.subscriptions.delete_many({"user_id": uid})


# ── Allowlist bypass: status + optimize/jobs ─────────────────────────


def test_status_reviewer_email_reports_pro_true(reviewer_user):
    """`pro=true` for the reviewer even though there's no Stripe sub."""
    headers, uid, db = reviewer_user
    # Ensure no subscription exists for this user.
    db.subscriptions.delete_many({"user_id": uid})

    r = requests.get(f"{API}/billing/status", headers=headers, timeout=5)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pro"] is True, f"Reviewer should be pro by allowlist, got: {body}"
    # is_admin should still be False — they're a reviewer, not an owner.
    assert body["is_admin"] is False
    # No subscription doc → status & plan_id remain null.
    assert body["status"] is None
    assert body["plan_id"] is None


def test_optimize_jobs_reviewer_email_bypasses_paywall(reviewer_user):
    """The /optimize/jobs endpoint requires Pro; reviewer email should
    skip the 402 and get a 202 Accepted with a job_id."""
    headers, uid, db = reviewer_user
    db.stops.delete_many({"user_id": uid})
    db.stops.insert_many([
        {"id": "rv1", "user_id": uid, "address": "1 St", "latitude": -33.86, "longitude": 151.21, "order": 0},
        {"id": "rv2", "user_id": uid, "address": "2 St", "latitude": -33.87, "longitude": 151.22, "order": 1},
    ])
    r = requests.post(f"{API}/optimize/jobs", json={}, headers=headers, timeout=10)
    assert r.status_code == 202, r.text
    assert "job_id" in r.json()


# ── Demo-route seeding ──────────────────────────────────────────────


def test_seed_reviewer_demo_route_creates_six_stops(reviewer_email):
    """The helper used by /api/auth/session inserts the bundled Sydney
    demo stops and is idempotent on a second call."""
    from routes.auth import _seed_reviewer_demo_route, _REVIEWER_DEMO_STOPS

    assert len(_REVIEWER_DEMO_STOPS) == 6, "Demo bundle should ship 6 stops"

    client = pymongo.MongoClient("mongodb://localhost:27017")
    sync_db = client["test_database"]
    uid = f"seedtest_{uuid.uuid4().hex[:8]}"
    sync_db.stops.delete_many({"user_id": uid})

    async def _run():
        mongo = motor_asyncio.AsyncIOMotorClient("mongodb://localhost:27017")
        db = mongo["test_database"]
        await _seed_reviewer_demo_route(db, uid)
        # Second call MUST be a no-op (idempotent).
        await _seed_reviewer_demo_route(db, uid)
        mongo.close()

    try:
        asyncio.run(_run())
        docs = list(sync_db.stops.find({"user_id": uid}, {"_id": 0}))
        assert len(docs) == 6, f"Expected 6 demo stops, got {len(docs)}"
        # Stops are ordered 0..5 contiguously.
        orders = sorted(d["order"] for d in docs)
        assert orders == [0, 1, 2, 3, 4, 5]
        # All stops have valid coordinates in the Sydney region.
        for d in docs:
            assert -34.5 < d["latitude"] < -33.5
            assert 150.5 < d["longitude"] < 151.5
            assert d["completed"] is False
            assert d["delivery_status"] == "pending"
            assert d["name"].startswith("Demo · ")
    finally:
        sync_db.stops.delete_many({"user_id": uid})


# ── /api/auth/reviewer-login — Google-less login for Play Store reviewers ──


def test_reviewer_login_happy_path(backend_alive, reviewer_email):
    """Valid email + passcode → 200 with a usable session_token.
    Token must be accepted by /auth/me and /billing/status."""
    passcode = _read_env_value("REVIEWER_PASSCODE")
    if not passcode:
        pytest.skip("REVIEWER_PASSCODE not configured")

    client = pymongo.MongoClient("mongodb://localhost:27017")
    db = client["test_database"]
    # Pre-clean — keep the test independent of leftovers from prior runs.
    db.users.delete_many({"email": reviewer_email})
    db.user_sessions.delete_many({"user_id": {"$regex": "^user_"}, "session_token": {"$regex": "^rvw_"}})

    try:
        r = requests.post(
            f"{API}/auth/reviewer-login",
            json={"email": reviewer_email, "passcode": passcode},
            timeout=5,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["email"] == reviewer_email
        assert body["session_token"].startswith("rvw_")
        assert body["user_id"].startswith("user_")

        # Token immediately works for downstream endpoints.
        token = body["session_token"]
        h = {"Authorization": f"Bearer {token}"}
        me = requests.get(f"{API}/auth/me", headers=h, timeout=5)
        assert me.status_code == 200, me.text
        status_r = requests.get(f"{API}/billing/status", headers=h, timeout=5)
        assert status_r.status_code == 200
        assert status_r.json()["pro"] is True

        # First login seeded 6 demo stops.
        seeded = list(db.stops.find({"user_id": body["user_id"]}, {"_id": 0}))
        assert len(seeded) == 6
    finally:
        db.users.delete_many({"email": reviewer_email})
        db.user_sessions.delete_many({"session_token": {"$regex": "^rvw_"}})
        db.stops.delete_many({"user_id": {"$regex": "^user_"}, "name": {"$regex": "^Demo · "}})


def test_reviewer_login_rejects_wrong_passcode(backend_alive, reviewer_email):
    r = requests.post(
        f"{API}/auth/reviewer-login",
        json={"email": reviewer_email, "passcode": "definitely-wrong"},
        timeout=5,
    )
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid reviewer credentials"


def test_reviewer_login_rejects_non_allowlisted_email(backend_alive):
    passcode = _read_env_value("REVIEWER_PASSCODE")
    if not passcode:
        pytest.skip("REVIEWER_PASSCODE not configured")
    r = requests.post(
        f"{API}/auth/reviewer-login",
        json={"email": "imposter@example.com", "passcode": passcode},
        timeout=5,
    )
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid reviewer credentials"
