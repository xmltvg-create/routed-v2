"""Tests for the smart Sharpie-preserve contract on /api/routes/confirm.

The 2026-05-10 contract change splits `/api/routes/confirm` behaviour:
* **First confirm** (no completed stops yet) → full 1..N stamp on
  `original_sequence`, same as the 2026-05-09 contract.
* **Resume** (≥1 completed stop already) → preserve every existing
  `original_sequence` value, only stamp stops where it's null
  (= late freight added since the last confirm). New numbers extend
  past the current max — so a route that already has stamps 1..30 with
  a new late-freight parcel ends up with the late freight at 31.

Why this matters: drivers Sharpie-mark physical boxes BEFORE leaving
the depot. The previous "always re-stamp" contract repainted those
numbers on every resume, which made physically-labelled boxes appear
under wrong numbers on-screen after a mid-shift re-optimise.

We test via `requests` against the live supervisor backend (matches
`test_optimize_jobs.py`) so we sidestep the motor event-loop binding
artifact in the in-process TestClient pattern.
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
def seeded_user(backend_alive):
    """Seed a fresh user + 3 stops, return auth headers and the stop ids."""
    client = pymongo.MongoClient("mongodb://localhost:27017")
    db = client["test_database"]
    user_id = f"confirm_test_{uuid.uuid4().hex[:8]}"
    token = f"sess_{uuid.uuid4().hex}"
    db.users.insert_one({"user_id": user_id, "email": f"{user_id}@x.com", "name": "T"})
    db.user_sessions.insert_one({
        "session_token": token, "user_id": user_id,
        "expires_at": datetime.datetime.utcnow() + datetime.timedelta(hours=1),
    })
    stop_ids = [str(uuid.uuid4()) for _ in range(3)]
    db.stops.insert_many([
        {"id": stop_ids[0], "user_id": user_id, "address": "1 St", "name": "A",
         "latitude": -26.65, "longitude": 153.10, "order": 0, "completed": False},
        {"id": stop_ids[1], "user_id": user_id, "address": "2 St", "name": "B",
         "latitude": -26.66, "longitude": 153.11, "order": 1, "completed": False},
        {"id": stop_ids[2], "user_id": user_id, "address": "3 St", "name": "C",
         "latitude": -26.67, "longitude": 153.12, "order": 2, "completed": False},
    ])
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    yield {"headers": headers, "user_id": user_id, "stop_ids": stop_ids, "db": db}
    db.users.delete_one({"user_id": user_id})
    db.user_sessions.delete_one({"session_token": token})
    db.stops.delete_many({"user_id": user_id})


def _fetch_original_sequence(db, user_id):
    """Return {stop_id: original_sequence} for the user, sorted by stop_id."""
    rows = list(db.stops.find(
        {"user_id": user_id}, {"_id": 0, "id": 1, "original_sequence": 1},
    ))
    return {r["id"]: r.get("original_sequence") for r in rows}


def test_first_confirm_full_stamps_1_to_N(seeded_user):
    """First /routes/confirm — no completed stops yet — must stamp 1..N
    on every stop in payload order. Matches pre-2026-05-10 behaviour."""
    ids = seeded_user["stop_ids"]
    r = requests.post(
        f"{API}/routes/confirm",
        headers=seeded_user["headers"],
        json={"confirmed_sequence": ids},
        timeout=10,
    )
    assert r.status_code == 200, r.text
    stamps = _fetch_original_sequence(seeded_user["db"], seeded_user["user_id"])
    assert stamps[ids[0]] == 1
    assert stamps[ids[1]] == 2
    assert stamps[ids[2]] == 3


def test_resume_preserves_locked_stops(seeded_user):
    """Once any stop is `completed: True`, a re-confirm with the SAME ids
    must NOT mutate the existing `original_sequence` values."""
    ids = seeded_user["stop_ids"]
    db = seeded_user["db"]
    # First confirm to stamp 1..3
    r = requests.post(f"{API}/routes/confirm",
                      headers=seeded_user["headers"],
                      json={"confirmed_sequence": ids}, timeout=10)
    assert r.status_code == 200
    before = _fetch_original_sequence(db, seeded_user["user_id"])
    assert before == {ids[0]: 1, ids[1]: 2, ids[2]: 3}

    # Mark stop[0] completed → driver has started delivering
    db.stops.update_one({"id": ids[0]}, {"$set": {"completed": True}})

    # Re-confirm with reversed order (= driver re-optimised mid-shift)
    reversed_ids = list(reversed(ids))
    r = requests.post(f"{API}/routes/confirm",
                      headers=seeded_user["headers"],
                      json={"confirmed_sequence": reversed_ids}, timeout=10)
    assert r.status_code == 200

    after = _fetch_original_sequence(db, seeded_user["user_id"])
    # The contract: every stop that had a stamp keeps it.
    assert after[ids[0]] == 1, "Sharpie 1 was overwritten on resume"
    assert after[ids[1]] == 2, "Sharpie 2 was overwritten on resume"
    assert after[ids[2]] == 3, "Sharpie 3 was overwritten on resume"


def test_resume_stamps_only_late_freight(seeded_user):
    """On a resume, stops where `original_sequence` is null must be
    stamped with max(existing)+1, +2, ... (= late freight extends the
    range past the existing Sharpie marks)."""
    ids = seeded_user["stop_ids"]
    db = seeded_user["db"]
    user_id = seeded_user["user_id"]

    # First confirm stamps 1..3
    r = requests.post(f"{API}/routes/confirm",
                      headers=seeded_user["headers"],
                      json={"confirmed_sequence": ids}, timeout=10)
    assert r.status_code == 200
    # Driver starts delivering
    db.stops.update_one({"id": ids[0]}, {"$set": {"completed": True}})

    # Add 2 late-freight stops (no original_sequence yet)
    late_id_a = str(uuid.uuid4())
    late_id_b = str(uuid.uuid4())
    db.stops.insert_many([
        {"id": late_id_a, "user_id": user_id, "address": "4 St", "name": "LATE-A",
         "latitude": -26.68, "longitude": 153.13, "order": 3, "completed": False},
        {"id": late_id_b, "user_id": user_id, "address": "5 St", "name": "LATE-B",
         "latitude": -26.69, "longitude": 153.14, "order": 4, "completed": False},
    ])

    # Re-confirm with all 5 stops (driver re-optimised including late freight)
    all_ids = ids + [late_id_a, late_id_b]
    r = requests.post(f"{API}/routes/confirm",
                      headers=seeded_user["headers"],
                      json={"confirmed_sequence": all_ids}, timeout=10)
    assert r.status_code == 200

    after = _fetch_original_sequence(db, user_id)
    # Existing stops: untouched.
    assert after[ids[0]] == 1
    assert after[ids[1]] == 2
    assert after[ids[2]] == 3
    # Late freight: stamped with 4 and 5 (max+1, max+2). Order of stamping
    # follows payload order, not insertion order in the DB.
    assert after[late_id_a] == 4
    assert after[late_id_b] == 5


def test_resume_stamps_late_freight_with_correct_offset_when_gaps(seeded_user):
    """If a stop was deleted from the route after first confirm
    (leaving a gap in original_sequence like 1, 3), late freight must
    still extend past the MAX existing value, not fill the gap."""
    ids = seeded_user["stop_ids"]
    db = seeded_user["db"]
    user_id = seeded_user["user_id"]

    # First confirm
    requests.post(f"{API}/routes/confirm",
                  headers=seeded_user["headers"],
                  json={"confirmed_sequence": ids}, timeout=10)
    db.stops.update_one({"id": ids[0]}, {"$set": {"completed": True}})

    # Simulate stop[1] being deleted; original_sequence on stop[2] stays at 3.
    db.stops.delete_one({"id": ids[1]})

    # Late freight added
    late_id = str(uuid.uuid4())
    db.stops.insert_one({
        "id": late_id, "user_id": user_id, "address": "X St", "name": "LATE",
        "latitude": -26.70, "longitude": 153.15, "order": 9, "completed": False,
    })

    # Re-confirm with remaining + late freight
    r = requests.post(f"{API}/routes/confirm",
                      headers=seeded_user["headers"],
                      json={"confirmed_sequence": [ids[0], ids[2], late_id]}, timeout=10)
    assert r.status_code == 200

    after = _fetch_original_sequence(db, user_id)
    # Existing stops keep their numbers — gap at 2 stays a gap.
    assert after[ids[0]] == 1
    assert after[ids[2]] == 3
    # Late freight extends past max (3) → 4, NOT 2 (the gap value).
    assert after[late_id] == 4, (
        "Late freight filled the gap instead of extending past max — "
        "drivers wouldn't expect a new parcel to take a recycled Sharpie number."
    )
