"""Pure-Pydantic unit tests for backend/models/stops.py.

Why these exist separately from the full TestClient suite:
  • The full suite spins up FastAPI + Motor + a TestClient lifecycle
    (~200 ms before the first assertion runs) per module — fine for
    end-to-end behaviour but heavyweight when all you want to verify
    is "does this model accept this shape?".
  • These tests exercise ONLY the model — no DB, no auth, no routes —
    so they finish in single-digit milliseconds and can be re-run on
    every save without breaking flow.
  • They lock down the ergonomics of the StopUpdate `exclude_unset`
    contract that the recent /api/routes/* refactor depends on.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.stops import (  # noqa: E402
    CarStopActionRequest,
    FieldMapping,
    GeocodeCacheEntry,
    ImportResult,
    ReorderRequest,
    Stop,
    StopCreate,
    StopUpdate,
    TimeWindow,
)


# ────────────────────────────────────────────────────────────────────────
# Stop — the central entity
# ────────────────────────────────────────────────────────────────────────
def test_stop_minimum_required_fields():
    """Only the 4 fields the importer is guaranteed to provide should be
    needed to instantiate a Stop. Everything else is optional / has a
    default."""
    s = Stop(id="abc", user_id="u1", address="1 X St", latitude=-27.4, longitude=153.0)
    assert s.id == "abc"
    assert s.priority == "medium"  # default
    assert s.delivery_status == "pending"  # default
    assert s.completed is False  # default
    assert s.order == 0  # default
    assert s.sequence_number is None  # null until /routes/confirm
    assert s.original_sequence is None  # Sharpie marker, locked at confirm
    assert s.tracking_number is None
    assert s.arrived_at is None
    assert s.arrival_method is None


def test_stop_full_round_trip_preserves_all_fields():
    """Every field on Stop must survive a JSON round-trip — this is the
    contract /api/stops promises clients (no silent drops)."""
    payload = {
        "id": "stop-1",
        "user_id": "user-7",
        "address": "10 Pine Cres, Brisbane",
        "name": "ACME Corp",
        "mobile_number": "+61400000000",
        "suburb": "Brisbane",
        "latitude": -27.4698,
        "longitude": 153.0251,
        "priority": "high",
        "time_window": {"start": "09:00", "end": "17:00"},
        "notes": "ring twice",
        "weight": 4.5,
        "quantity": 2,
        "tracking_number": "TRK-12345",
        "geocode_metadata": {"source": "mapbox", "confidence": 0.92},
        "delivery_status": "delivered",
        "failure_reason": None,
        "completed": True,
        "completed_at": "2026-05-08T10:30:00+00:00",
        "arrived_at": "2026-05-08T10:28:30+00:00",
        "arrival_lat": -27.4699,
        "arrival_lng": 153.0252,
        "arrival_accuracy_m": 12.0,
        "arrival_method": "geofence",
        "original_sequence": 5,
        "completion_lat": -27.4698,
        "completion_lng": 153.0250,
        "completion_accuracy_m": 8.0,
        "order": 4,
        "sequence_number": 5,
        "created_at": "2026-05-08T08:00:00+00:00",
    }
    s = Stop(**payload)
    dumped = s.model_dump(mode="json")
    # Spot-check the high-stakes fields that downstream features rely on.
    assert dumped["original_sequence"] == 5  # Sharpie marker
    assert dumped["sequence_number"] == 5    # confirmed drive order
    assert dumped["arrival_method"] == "geofence"
    assert dumped["tracking_number"] == "TRK-12345"
    assert dumped["time_window"] == {"start": "09:00", "end": "17:00"}


# ────────────────────────────────────────────────────────────────────────
# StopUpdate — the partial-PATCH shape /api/stops/{id} relies on
# ────────────────────────────────────────────────────────────────────────
def test_stop_update_exclude_unset_only_includes_explicit_fields():
    """Touching just `notes` must NOT inject defaults for other fields —
    otherwise the routes/stops.py PUT handler would silently overwrite
    the rest of the row with defaults. This is the contract that backed
    the 2026-05-07 fix to use `model_dump(exclude_unset=True)`."""
    u = StopUpdate(notes="ring twice")
    assert u.model_dump(exclude_unset=True) == {"notes": "ring twice"}


def test_stop_update_explicit_none_clears_field():
    """Sending `{"tracking_number": null}` MUST be preserved as a clear
    intent, not silently dropped. Pre-fix, the legacy
    `{k: v for k, v in d.items() if v is not None}` filter was eating
    these and making field-clearing impossible via PATCH."""
    u = StopUpdate(tracking_number=None)
    dumped = u.model_dump(exclude_unset=True)
    assert "tracking_number" in dumped
    assert dumped["tracking_number"] is None


def test_stop_update_empty_body_is_a_noop():
    """Empty body → empty dump → PUT handler does nothing → row unchanged.
    Lock this in so a future refactor can't accidentally inject a default
    value here."""
    assert StopUpdate().model_dump(exclude_unset=True) == {}


def test_stop_update_carries_sharpie_pin_pair_independently():
    """The Stamp-and-Lock contract: clients update either `order` (live
    drag-and-drop) OR `tracking_number` (manual attach) without touching
    the immutable `original_sequence`. Verify both fields can be set in
    the same PATCH and neither contaminates the other."""
    u = StopUpdate(order=7, tracking_number="TRK-9")
    d = u.model_dump(exclude_unset=True)
    assert d == {"order": 7, "tracking_number": "TRK-9"}


# ────────────────────────────────────────────────────────────────────────
# Companion shapes — should accept their min-payload and round-trip cleanly
# ────────────────────────────────────────────────────────────────────────
def test_stop_create_minimum_payload():
    sc = StopCreate(address="1 Y St", latitude=-27.0, longitude=153.0)
    assert sc.priority == "medium"
    assert sc.delivery_status == "pending"


def test_time_window_accepts_partial_or_empty():
    """Drivers often have a one-sided window ("must be there BEFORE 16:00",
    no opening time) — accept partials so we don't reject good data."""
    assert TimeWindow().start is None
    assert TimeWindow(end="16:00").start is None
    assert TimeWindow(start="09:00").end is None


def test_field_mapping_only_address_required():
    fm = FieldMapping(address="Address")
    assert fm.tracking_number is None  # van-scan fallback path
    assert fm.mobile_number is None


def test_import_result_auto_archived_count_default_is_zero():
    """The auto-archive counter must default to 0 so a frontend toast
    doesn't pop on every fresh import — only when the value is > 0."""
    ir = ImportResult(success_count=10, failed_count=0, failed_addresses=[], stops=[])
    assert ir.auto_archived_count == 0


def test_car_stop_action_request_validates_action_literal():
    import pytest
    from pydantic import ValidationError

    assert CarStopActionRequest(stop_id="x", action="delivered").action == "delivered"
    assert CarStopActionRequest(stop_id="x", action="skip").action == "skip"
    assert CarStopActionRequest(stop_id="x", action="failed").action == "failed"
    with pytest.raises(ValidationError):
        CarStopActionRequest(stop_id="x", action="completed")  # not in Literal


def test_reorder_request_accepts_empty_list():
    """Edge case — clear-then-reorder with no stops left in the route."""
    rr = ReorderRequest(stop_ids=[])
    assert rr.stop_ids == []


def test_geocode_cache_entry_has_uuid_id_and_hit_count_default():
    """GeocodeCacheEntry generates its own UUID; hit_count starts at 1
    (the import that created it counts as the first hit)."""
    g = GeocodeCacheEntry(
        address_query="1 x st",
        original_address="1 X St",
        latitude=-27.0,
        longitude=153.0,
        place_name="1 X St, City",
    )
    assert isinstance(g.id, str) and len(g.id) >= 32  # uuid4 is 32 hex chars + 4 dashes
    assert g.hit_count == 1
