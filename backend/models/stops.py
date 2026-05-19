"""Stops domain models — the largest of the model packages because the
Stop record is the central entity in the app (everything else is either
input to building a stops list or a derived projection of it).

The `Stop` model itself carries a lot of optional instrumentation that's
written by separate flows (geofence arrival, completion, route confirm,
import) — each block has a comment explaining who writes it and when,
because a fresh reader of this file will otherwise wonder why every
field is `Optional`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class TimeWindow(BaseModel):
    start: Optional[str] = None  # "09:00"
    end: Optional[str] = None    # "17:00"


class GeocodeCacheEntry(BaseModel):
    """Cached geocode result to avoid repeated API calls"""
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    address_query: str  # Normalized query string
    original_address: str  # Original address as entered
    latitude: float
    longitude: float
    place_name: str
    metadata: Optional[Dict[str, Any]] = None
    suburb: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    hit_count: int = 1  # Track how often this cache entry is used


class Stop(BaseModel):
    id: str  # Immutable — set once at creation, never regenerated
    user_id: str
    address: str
    name: Optional[str] = None
    mobile_number: Optional[str] = None  # Contact mobile/phone number
    suburb: Optional[str] = None  # Suburb/area for grouping
    latitude: float
    longitude: float
    # ML Phase 2: building-side corrected centroid (raw lat/lng + per-suburb
    # learned offset). Set ONLY by GET /api/stops when the user has a trained
    # building-side model that produces a meaningful offset for this stop's
    # suburb. Frontend renders pins at display_* when present (kerb-side),
    # falling back to raw latitude/longitude (rooftop centroid) otherwise.
    # Not persisted — recomputed on every fetch so retraining propagates
    # without a Mongo migration.
    display_latitude: Optional[float] = None
    display_longitude: Optional[float] = None
    priority: str = "medium"  # high, medium, low
    time_window: Optional[TimeWindow] = None
    notes: Optional[str] = None
    weight: Optional[float] = None  # Weight in kg
    quantity: Optional[int] = None  # Quantity of items
    # Optional carrier tracking number / barcode — set during import for
    # compatible CSVs ("Tracking", "Barcode", "Reference" columns). Used by
    # the Van Loading Assistant to match scanned barcodes against stops.
    # NOT unique — same parcel may have multiple identical barcodes after
    # re-imports; the scanner shows ALL matches.
    tracking_number: Optional[str] = None
    geocode_metadata: Optional[Dict[str, Any]] = None
    delivery_status: str = "pending"  # pending, delivered, skipped, failed
    failure_reason: Optional[str] = None
    completed: bool = False  # Whether stop has been completed
    completed_at: Optional[datetime] = None
    # Phase 0 instrumentation — captured passively so future analytics can
    # learn (a) realistic per-stop service times = completed_at - arrived_at,
    # (b) the actual driveway/door side from completion_lat/lng vs the
    # geocoded centroid. Nullable because old rows + offline marks won't
    # have them; downstream code must treat absence as "no data yet", not
    # an error.
    arrived_at: Optional[datetime] = None
    arrival_lat: Optional[float] = None
    arrival_lng: Optional[float] = None
    arrival_accuracy_m: Optional[float] = None
    # How `arrived_at` was obtained, so the ML service-time learner can
    # weight or filter samples:
    #   "geofence"            — driver crossed the 100 m radius (high quality)
    #   "geofence_inferred"   — `arrived_at` was null at /complete time but
    #                           the driver was in nav mode AND within 150 m
    #                           of the centroid; we back-date arrival by 30 s
    #                           and trust the sample for ML (mid quality).
    #   "fallback_completion" — pure backstop: tapped from planning list, or
    #                           too far, or no GPS. Down-weight or filter.
    #   None                  — never set (legacy rows or stop not yet completed)
    arrival_method: Optional[str] = None
    # Sharpie-marker number — the 1-indexed badge the driver wrote on the
    # physical box at start-of-shift. Written ONCE on the first
    # POST /api/routes/confirm of the route's lifetime and never overwritten,
    # so subsequent re-optimisations may reshuffle the DRIVING ORDER
    # (`sequence_number` / `order`) without ever changing the visual badge.
    # Reset to None only when the row is deleted (delete_all_stops /
    # archive_route end-of-shift). Pre-confirmation rows have None and
    # the UI falls back to dynamic `order + 1`.
    original_sequence: Optional[int] = None
    completion_lat: Optional[float] = None
    completion_lng: Optional[float] = None
    completion_accuracy_m: Optional[float] = None
    # Haversine metres from completion GPS to stop centroid. Stamped at
    # completion time. Rolled up by /api/routes/archive into per-route
    # p50/p95 percentiles — the diagnostic for "is the geofence radius
    # the bottleneck?" If p50 > 100m on every route, raise the radius.
    completion_distance_m: Optional[float] = None
    # When set, the driver was within INFER_RADIUS_M of the ML
    # building-side corrected centroid (centroid + learned suburb
    # offset). Stamped at completion time when the raw distance is
    # too far but the corrected distance is close — proves the
    # Phase 2 ML model rescued the geofence_inferred classification.
    completion_distance_corrected_m: Optional[float] = None
    # Whether the driver tapped Delivered from the immersive nav cockpit
    # (where the geofence runs) or from the planning list (where it
    # never gets a chance to fire). One of "planning" or "navigating".
    view_mode_at_completion: Optional[str] = None
    order: int = 0
    # Immutable execution sequence assigned by POST /api/routes/confirm after
    # the driver reviews and accepts an optimized plan. `order` stays as the
    # live drag-and-drop planning position (so drivers can still re-shuffle
    # before confirming); `sequence_number` is the locked, append-only record
    # of what they actually committed to drive. Null until a route is
    # confirmed — such stops sort to the bottom of `/api/stops` so they
    # appear visually after the locked plan.
    sequence_number: Optional[int] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class StopCreate(BaseModel):
    address: str
    name: Optional[str] = None
    suburb: Optional[str] = None
    latitude: float
    longitude: float
    priority: str = "medium"
    time_window: Optional[TimeWindow] = None
    notes: Optional[str] = None
    weight: Optional[float] = None
    quantity: Optional[int] = None
    geocode_metadata: Optional[Dict[str, Any]] = None
    delivery_status: Optional[str] = "pending"
    failure_reason: Optional[str] = None


class StopUpdate(BaseModel):
    address: Optional[str] = None
    name: Optional[str] = None
    suburb: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    priority: Optional[str] = None
    time_window: Optional[TimeWindow] = None
    notes: Optional[str] = None
    weight: Optional[float] = None
    quantity: Optional[int] = None
    geocode_metadata: Optional[Dict[str, Any]] = None
    delivery_status: Optional[str] = None
    failure_reason: Optional[str] = None
    completed: Optional[bool] = None
    order: Optional[int] = None
    # Carrier tracking number / barcode reference. Allowing PATCH means a
    # driver can manually attach a tracking ID to a stop whose import
    # didn't carry one (or whose label scanner didn't fire) and have the
    # van-scan barcode lookup pick it up on the next pass. Pydantic skips
    # `Optional[None]` defaults from `model_dump(exclude_unset=True)` so
    # callers that don't touch the field still get the no-op behaviour
    # they had before this was wired.
    tracking_number: Optional[str] = None


class RegeocodeStopRequest(BaseModel):
    address: Optional[str] = None


class RegeocodeStopResponse(BaseModel):
    success: bool
    geocoded: bool
    message: str
    stop: Stop


class CarStopActionRequest(BaseModel):
    stop_id: str
    action: Literal["delivered", "skip", "failed"]
    reason: Optional[str] = None


class FieldMapping(BaseModel):
    address: str  # Required - column name for address
    name: Optional[str] = None
    mobile_number: Optional[str] = None  # Mobile/phone number field
    notes: Optional[str] = None
    weight: Optional[str] = None
    quantity: Optional[str] = None
    # Carrier tracking number / barcode column (e.g. "Source Reference",
    # "Tracking", "Barcode"). Populated for the Van Loading Assistant —
    # the camera scanner matches against this column.
    tracking_number: Optional[str] = None


class ImportPreviewResponse(BaseModel):
    columns: List[str]
    sample_rows: List[Dict[str, Any]]
    total_rows: int
    suggested_mapping: Optional[Dict[str, str]] = None


class ImportResult(BaseModel):
    success_count: int
    failed_count: int
    failed_addresses: List[str]
    stops: List[Stop]
    name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    priority: Optional[str] = None
    time_window: Optional[TimeWindow] = None
    notes: Optional[str] = None
    order: Optional[int] = None
    # Number of completed stops auto-archived to route_history before the
    # destructive delete_many. 0 when the previous route had no completes
    # (or this is the user's first import). The frontend shows a toast
    # whenever this is > 0 so drivers have visible confirmation that
    # their morning's data wasn't silently destroyed.
    auto_archived_count: int = 0


class ReorderRequest(BaseModel):
    stop_ids: List[str]  # Ordered list of stop IDs
