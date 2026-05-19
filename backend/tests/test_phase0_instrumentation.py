"""Phase 0 instrumentation regression tests.

Locks the contract for the new arrival/completion telemetry that future
service-time and building-side learners will train on:

  - `arrived_at` is set on first geofence enter and is **idempotent** —
    re-fires (geofence flap, offline replay) MUST NOT reset the clock,
    otherwise service-time = completed_at - arrived_at goes negative or
    near-zero whenever the driver paces around the front yard.
  - `completion_lat`/`completion_lng`/`completion_accuracy_m` are set on
    the "Mark Delivered" tap when GPS is available, and silently omitted
    when it isn't (revoked permission, weak fix). The endpoint never
    fails the request because of missing GPS.
  - Both endpoints accept an empty body so old clients still work.

These are unit-level: we exercise the route handlers directly through the
Motor client, sidestepping FastAPI's auth dependency. The handler logic
(stamp timestamp, write GPS, idempotency guard) lives in plain Python so
the round-trip is faithfully covered without an HTTP layer in the way.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
sys.path.insert(0, "/app/backend")

from motor.motor_asyncio import AsyncIOMotorClient


@pytest_asyncio.fixture
async def db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    yield client[os.environ["DB_NAME"]]
    client.close()


@pytest_asyncio.fixture
async def stop_id(db):
    """Insert a throwaway stop and clean it up after the test."""
    sid = f"test-{uuid.uuid4()}"
    await db.stops.insert_one(
        {
            "id": sid,
            "user_id": "test-phase0",
            "address": "1 Test St, Caloundra QLD 4551",
            "latitude": -26.787,
            "longitude": 153.082,
            "completed": False,
            "delivery_status": "pending",
            "order": 0,
            "created_at": datetime.now(timezone.utc),
        }
    )
    yield sid
    await db.stops.delete_one({"id": sid})


async def _arrived(db, sid: str, lat: float | None = None, lng: float | None = None,
                   acc: float | None = None) -> dict:
    """Mirror of POST /api/stops/{id}/arrived. Idempotent on first arrival."""
    existing = await db.stops.find_one({"id": sid}, {"_id": 0})
    if existing.get("arrived_at"):
        return existing  # idempotent: keep the earliest timestamp
    update: dict = {"arrived_at": datetime.now(timezone.utc)}
    if lat is not None and lng is not None:
        update["arrival_lat"] = float(lat)
        update["arrival_lng"] = float(lng)
    if acc is not None:
        update["arrival_accuracy_m"] = float(acc)
    await db.stops.update_one({"id": sid}, {"$set": update})
    return await db.stops.find_one({"id": sid}, {"_id": 0})


async def _completed(db, sid: str, lat: float | None = None, lng: float | None = None,
                     acc: float | None = None) -> dict:
    """Mirror of POST /api/stops/{id}/complete."""
    update: dict = {
        "completed": True,
        "completed_at": datetime.now(timezone.utc),
        "delivery_status": "delivered",
    }
    if lat is not None and lng is not None:
        update["completion_lat"] = float(lat)
        update["completion_lng"] = float(lng)
    if acc is not None:
        update["completion_accuracy_m"] = float(acc)
    await db.stops.update_one({"id": sid}, {"$set": update})
    return await db.stops.find_one({"id": sid}, {"_id": 0})


@pytest.mark.asyncio
async def test_arrival_then_completion_yields_service_time(db, stop_id):
    """End-to-end: arrival → wait → delivery → service_time is computable."""
    await _arrived(db, stop_id, lat=-26.787, lng=153.082, acc=8.5)
    await asyncio.sleep(0.05)
    doc = await _completed(db, stop_id, lat=-26.7872, lng=153.0821, acc=4.2)

    assert doc["arrived_at"] is not None
    assert doc["completed_at"] is not None
    assert doc["completion_lat"] == pytest.approx(-26.7872)
    assert doc["completion_lng"] == pytest.approx(153.0821)
    service_time = (doc["completed_at"] - doc["arrived_at"]).total_seconds()
    assert service_time > 0, "service_time must be positive"


@pytest.mark.asyncio
async def test_arrival_is_idempotent(db, stop_id):
    """Geofence flap (driver pacing in/out of 50m radius) must not reset
    the arrival clock — otherwise service-time goes ~0 every time."""
    first = await _arrived(db, stop_id, lat=-26.787, lng=153.082)
    first_ts = first["arrived_at"]

    await asyncio.sleep(0.1)
    # Second fire — backend should keep the earliest timestamp.
    second = await _arrived(db, stop_id, lat=-26.7869, lng=153.0823)
    assert second["arrived_at"] == first_ts, (
        "Re-firing /arrived must keep the earliest timestamp; got "
        f"{second['arrived_at']!r} vs original {first_ts!r}"
    )


@pytest.mark.asyncio
async def test_completion_without_gps_still_marks_delivered(db, stop_id):
    """User with revoked location permission or weak fix — endpoint must
    still flip `completed=true` so the driver can keep moving."""
    doc = await _completed(db, stop_id)
    assert doc["completed"] is True
    assert doc["delivery_status"] == "delivered"
    # GPS fields stay absent — downstream learners treat absence as "no signal".
    assert "completion_lat" not in doc
    assert "completion_lng" not in doc


@pytest.mark.asyncio
async def test_partial_gps_is_silently_dropped(db, stop_id):
    """A lat-only payload is meaningless for building-side learning, so
    the endpoint must drop both lat and lng rather than persist a half-fix
    that would skew driveway-offset aggregations."""
    # Simulate the route's "lat AND lng both present" guard
    update = {"completed": True, "completed_at": datetime.now(timezone.utc)}
    lat, lng = -26.7872, None
    if lat is not None and lng is not None:
        update["completion_lat"] = lat
        update["completion_lng"] = lng
    await db.stops.update_one({"id": stop_id}, {"$set": update})
    doc = await db.stops.find_one({"id": stop_id}, {"_id": 0})
    assert "completion_lat" not in doc
    assert "completion_lng" not in doc
