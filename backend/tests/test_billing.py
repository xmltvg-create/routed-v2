"""Live-backend smoke tests for the Stripe billing module.

Same pattern as test_optimize_jobs.py and test_telemetry_rollup.py:
seed Mongo directly, curl localhost:8001, assert behaviour. The
billing module is gated on `STRIPE_API_KEY` being set in env (we
ship a placeholder `sk_test_emergent` from the pod env so the
module loads, but anything that talks to Stripe's API will fail
gracefully).

What we cover here:
  * /api/billing/status: admin user reports pro=true, is_admin=true
  * /api/billing/status: free user reports pro=false, is_admin=false, plans listed
  * /api/billing/status: trialing/active subscription in Mongo flips pro=true
  * /api/optimize/jobs: free user → 402 with upgrade_required=true
  * /api/optimize/jobs: admin user → 202 (bypass)
  * /api/billing/checkout: bad plan_id → 422 validation error
  * /api/billing/checkout: missing price id env → 503 with clear msg
  * /api/billing/portal: no subscription → 404
  * /api/billing/webhook: bad signature → 400

We DO NOT hit real Stripe APIs (would require a real key + price id).
The handful of code paths that call stripe.* are exercised in
integration / staging where a real test key + price ids are
configured.
"""
from __future__ import annotations

import datetime
import os
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
def free_user(backend_alive):
    client = pymongo.MongoClient("mongodb://localhost:27017")
    db = client["test_database"]
    uid = f"free_{uuid.uuid4().hex[:8]}"
    tok = f"sess_{uuid.uuid4().hex}"
    db.users.insert_one({"user_id": uid, "email": f"{uid}@x.com", "name": "F"})
    db.user_sessions.insert_one({
        "session_token": tok, "user_id": uid,
        "expires_at": datetime.datetime.utcnow() + datetime.timedelta(hours=1),
    })
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    yield headers, uid, db
    db.users.delete_many({"user_id": uid})
    db.user_sessions.delete_many({"user_id": uid})
    db.stops.delete_many({"user_id": uid})
    db.subscriptions.delete_many({"user_id": uid})


@pytest.fixture
def admin_user(backend_alive):
    """Use the env-configured admin user_id. Reads STRIPE_ADMIN_USER_IDS
    from backend/.env; falls back to skip if no admin is configured."""
    admin_ids = os.environ.get("STRIPE_ADMIN_USER_IDS", "").split(",")
    admin_ids = [a.strip() for a in admin_ids if a.strip()]
    if not admin_ids:
        # Try to read from backend .env directly since this test process
        # may not have inherited the supervisor env.
        try:
            with open("/app/backend/.env") as f:
                for line in f:
                    if line.startswith("STRIPE_ADMIN_USER_IDS="):
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        admin_ids = [a.strip() for a in val.split(",") if a.strip()]
                        break
        except OSError:
            pass
    if not admin_ids:
        pytest.skip("STRIPE_ADMIN_USER_IDS not configured")

    uid = admin_ids[0]
    client = pymongo.MongoClient("mongodb://localhost:27017")
    db = client["test_database"]
    tok = f"sess_admin_{uuid.uuid4().hex}"
    db.users.update_one(
        {"user_id": uid},
        {"$setOnInsert": {"user_id": uid, "email": f"{uid}@admin.test", "name": "Admin"}},
        upsert=True,
    )
    db.user_sessions.insert_one({
        "session_token": tok, "user_id": uid,
        "expires_at": datetime.datetime.utcnow() + datetime.timedelta(hours=1),
    })
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    yield headers, uid, db
    db.user_sessions.delete_many({"session_token": tok})
    db.stops.delete_many({"user_id": uid})


# ── Status endpoint ─────────────────────────────────────────────


def test_status_free_user_reports_no_pro(free_user):
    headers, uid, db = free_user
    r = requests.get(f"{API}/billing/status", headers=headers, timeout=5)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pro"] is False
    assert body["is_admin"] is False
    assert body["status"] is None
    assert body["plan_id"] is None
    assert "monthly" in body["available_plans"]
    assert "annual" in body["available_plans"]
    assert body["available_plans"]["monthly"]["trial_days"] == "7"


def test_status_admin_user_reports_pro_true(admin_user):
    headers, uid, db = admin_user
    r = requests.get(f"{API}/billing/status", headers=headers, timeout=5)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pro"] is True
    assert body["is_admin"] is True


def test_status_trialing_subscription_flips_pro(free_user):
    """A subscriptions row with status=trialing must make pro=true even
    for non-admin users. This is the post-checkout success path."""
    headers, uid, db = free_user
    db.subscriptions.update_one(
        {"user_id": uid},
        {"$set": {
            "user_id": uid,
            "email": f"{uid}@x.com",
            "stripe_customer_id": f"cus_{uuid.uuid4().hex[:14]}",
            "stripe_subscription_id": f"sub_{uuid.uuid4().hex[:14]}",
            "status": "trialing",
            "plan_id": "monthly",
            "current_period_end": int(datetime.datetime.utcnow().timestamp()) + 7 * 86400,
            "trial_end": int(datetime.datetime.utcnow().timestamp()) + 7 * 86400,
            "pro_flag": True,
        }},
        upsert=True,
    )
    r = requests.get(f"{API}/billing/status", headers=headers, timeout=5)
    body = r.json()
    assert body["pro"] is True
    assert body["status"] == "trialing"
    assert body["plan_id"] == "monthly"


# ── Paywall enforcement on /optimize/jobs ────────────────────


def test_optimize_jobs_402_for_free_user(free_user):
    """Free user must hit a 402 with an upgrade_required signal that
    the frontend store can branch on to push the paywall screen."""
    headers, uid, db = free_user
    db.stops.insert_many([
        {"id": "s1", "user_id": uid, "address": "1 St", "latitude": -26.65, "longitude": 153.10, "order": 0},
        {"id": "s2", "user_id": uid, "address": "2 St", "latitude": -26.66, "longitude": 153.11, "order": 1},
    ])
    r = requests.post(f"{API}/optimize/jobs", json={}, headers=headers, timeout=5)
    assert r.status_code == 402, r.text
    detail = r.json().get("detail") or {}
    assert detail.get("code") == "subscription_required"
    assert detail.get("upgrade_required") is True
    assert "/api/billing/checkout" in detail.get("checkout_endpoint", "")


def test_optimize_jobs_202_for_admin_user(admin_user):
    """Admin user bypasses the paywall — same endpoint returns 202
    Accepted (job kicked off)."""
    headers, uid, db = admin_user
    db.stops.delete_many({"user_id": uid})
    db.stops.insert_many([
        {"id": "a1", "user_id": uid, "address": "1 St", "latitude": -26.65, "longitude": 153.10, "order": 0},
        {"id": "a2", "user_id": uid, "address": "2 St", "latitude": -26.66, "longitude": 153.11, "order": 1},
    ])
    r = requests.post(f"{API}/optimize/jobs", json={}, headers=headers, timeout=10)
    assert r.status_code == 202, r.text
    assert "job_id" in r.json()


# ── Checkout / portal validation ─────────────────────────────


def test_checkout_rejects_bad_plan_id(free_user):
    """Pydantic validation catches anything outside 'monthly|annual'."""
    headers, uid, _ = free_user
    r = requests.post(f"{API}/billing/checkout", json={"plan_id": "lifetime"}, headers=headers, timeout=5)
    assert r.status_code == 422, r.text


def test_checkout_503_when_price_id_missing(free_user):
    """Without STRIPE_PRICE_MONTHLY/_ANNUAL configured, checkout must
    503 with a clear message rather than crashing."""
    headers, uid, _ = free_user
    r = requests.post(f"{API}/billing/checkout", json={"plan_id": "monthly"}, headers=headers, timeout=5)
    # If the env IS configured in this environment, this test is moot;
    # accept either 503 (typical) or 502 (Stripe API rejected the fake
    # key). The contract is "doesn't crash, doesn't succeed silently".
    assert r.status_code in (502, 503), r.text


def test_portal_404_when_no_subscription(free_user):
    """Customer portal requires an existing stripe_customer_id."""
    headers, uid, _ = free_user
    r = requests.post(f"{API}/billing/portal", json={}, headers=headers, timeout=5)
    assert r.status_code == 404, r.text


# ── Webhook signature verification ─────────────────────────────


def test_webhook_rejects_unsigned_request(backend_alive):
    """No stripe-signature header → 400 Invalid signature (never 200)."""
    r = requests.post(
        f"{API}/billing/webhook",
        data=b'{"id":"evt_test","type":"checkout.session.completed"}',
        headers={"Content-Type": "application/json"},
        timeout=5,
    )
    # Either 400 (bad/missing signature) or 503 (no webhook secret) —
    # both are correct refusals. The contract is "doesn't crash, doesn't
    # accept unsigned events".
    assert r.status_code in (400, 503), r.text
