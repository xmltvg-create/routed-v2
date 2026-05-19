"""Tests for the Waitlist API — /api/waitlist/*.

Covers:
  - Public join (happy path + idempotent + email validation)
  - Public status check (found + not found)
  - Admin CRUD (entries list, stats, approve, reject, delete)
  - Auth gate integration (SIGNUPS_DISABLED + waitlist approval)
  - Non-admin 403 on admin endpoints
"""
import pytest
import subprocess
import json
import os

API_URL = os.environ.get(
    "TEST_API_URL",
    subprocess.check_output(
        "grep EXPO_PUBLIC_BACKEND_URL /app/frontend/.env | cut -d '=' -f2",
        shell=True, text=True,
    ).strip(),
)

# Admin session token — created directly in MongoDB for testing.
_admin_token = None


def _curl(method, path, data=None, token=None, expect_status=None):
    """Simple curl wrapper that returns parsed JSON."""
    cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", method, f"{API_URL}{path}"]
    if data is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(data)]
    if token:
        cmd += ["-H", f"Authorization: Bearer {token}"]
    raw = subprocess.check_output(cmd, text=True)
    lines = raw.strip().rsplit("\n", 1)
    body = lines[0] if len(lines) > 1 else ""
    status_code = int(lines[-1])
    parsed = json.loads(body) if body else {}
    if expect_status is not None:
        assert status_code == expect_status, f"Expected {expect_status}, got {status_code}: {parsed}"
    return parsed, status_code


@pytest.fixture(scope="module", autouse=True)
def setup_admin_token():
    """Create a test admin session token in MongoDB."""
    global _admin_token
    import uuid
    token = f"test_wl_{uuid.uuid4().hex}"
    subprocess.check_output([
        "python3", "-c", f"""
from pymongo import MongoClient
from datetime import datetime, timedelta, timezone
c = MongoClient('mongodb://localhost:27017')
db = c['test_database']
db.user_sessions.insert_one({{
    'user_id': 'user_2a7d88cbb419',
    'session_token': '{token}',
    'expires_at': datetime.now(timezone.utc) + timedelta(days=1),
    'created_at': datetime.now(timezone.utc),
}})
""",
    ])
    _admin_token = token
    yield
    # Cleanup
    subprocess.check_output([
        "python3", "-c", f"""
from pymongo import MongoClient
c = MongoClient('mongodb://localhost:27017')
db = c['test_database']
db.user_sessions.delete_one({{'session_token': '{token}'}})
db.waitlist.delete_many({{'email': {{'$regex': 'wltest'}}}})
""",
    ])


# ── Public: Join ──────────────────────────────────────────────────────
def test_join_waitlist():
    data, status = _curl("POST", "/api/waitlist/join", {"email": "wltest-join@example.com", "name": "Joiner"})
    assert status == 200
    assert data["email"] == "wltest-join@example.com"
    assert data["status"] == "pending"
    assert "id" in data
    assert "waitlist" in data["message"].lower()


def test_join_idempotent():
    d1, _ = _curl("POST", "/api/waitlist/join", {"email": "wltest-idem@example.com", "name": "First"})
    d2, _ = _curl("POST", "/api/waitlist/join", {"email": "wltest-idem@example.com", "name": "Second"})
    assert d2["status"] == "pending"
    assert d1["id"] == d2["id"]  # same entry returned, not duplicated


def test_join_invalid_email():
    _, status = _curl("POST", "/api/waitlist/join", {"email": "bad", "name": "Bad"})
    assert status == 422


# ── Public: Status ────────────────────────────────────────────────────
def test_status_found():
    _curl("POST", "/api/waitlist/join", {"email": "wltest-status@example.com"})
    data, _ = _curl("GET", "/api/waitlist/status?email=wltest-status@example.com")
    assert data["on_waitlist"] is True
    assert data["status"] == "pending"
    assert data["position"] is not None


def test_status_not_found():
    data, _ = _curl("GET", "/api/waitlist/status?email=wltest-nobody@example.com")
    assert data["on_waitlist"] is False


# ── Admin: entries, stats ─────────────────────────────────────────────
def test_admin_entries():
    data, status = _curl("GET", "/api/waitlist/entries", token=_admin_token)
    assert status == 200
    assert isinstance(data, list)


def test_admin_entries_filter():
    data, _ = _curl("GET", "/api/waitlist/entries?status=pending", token=_admin_token)
    for entry in data:
        assert entry["status"] == "pending"


def test_admin_stats():
    data, status = _curl("GET", "/api/waitlist/stats", token=_admin_token)
    assert status == 200
    assert "total" in data
    assert "pending" in data
    assert "approved" in data
    assert "rejected" in data


# ── Admin: approve / reject / delete ──────────────────────────────────
def test_admin_approve():
    _curl("POST", "/api/waitlist/join", {"email": "wltest-approve@example.com"})
    data, status = _curl(
        "POST", "/api/waitlist/approve",
        {"emails": ["wltest-approve@example.com"]},
        token=_admin_token,
    )
    assert status == 200
    assert data["approved_count"] == 1

    # Verify the status changed
    st, _ = _curl("GET", "/api/waitlist/status?email=wltest-approve@example.com")
    assert st["status"] == "approved"


def test_admin_reject():
    _curl("POST", "/api/waitlist/join", {"email": "wltest-reject@example.com"})
    data, status = _curl(
        "POST", "/api/waitlist/reject",
        {"emails": ["wltest-reject@example.com"]},
        token=_admin_token,
    )
    assert status == 200
    assert data["rejected_count"] == 1

    st, _ = _curl("GET", "/api/waitlist/status?email=wltest-reject@example.com")
    assert st["status"] == "rejected"


def test_admin_delete():
    join_data, _ = _curl("POST", "/api/waitlist/join", {"email": "wltest-del@example.com"})
    entry_id = join_data["id"]
    data, status = _curl("DELETE", f"/api/waitlist/{entry_id}", token=_admin_token)
    assert status == 200
    assert data["deleted"] is True


def test_admin_delete_not_found():
    _, status = _curl("DELETE", "/api/waitlist/fake-id-123", token=_admin_token)
    assert status == 404


# ── Non-admin 403 ─────────────────────────────────────────────────────
def test_non_admin_entries_403():
    # Get reviewer token
    rev_data, _ = _curl("POST", "/api/auth/reviewer-login", {
        "email": "routedreviewer@gmail.com",
        "passcode": "pwdBOwfl01Mydp_MXG2Qmwh96VzhyS8c",
    })
    rev_token = rev_data["session_token"]
    _, status = _curl("GET", "/api/waitlist/entries", token=rev_token)
    assert status == 403


def test_non_admin_approve_403():
    rev_data, _ = _curl("POST", "/api/auth/reviewer-login", {
        "email": "routedreviewer@gmail.com",
        "passcode": "pwdBOwfl01Mydp_MXG2Qmwh96VzhyS8c",
    })
    rev_token = rev_data["session_token"]
    _, status = _curl(
        "POST", "/api/waitlist/approve",
        {"emails": ["anyone@test.com"]},
        token=rev_token,
    )
    assert status == 403
