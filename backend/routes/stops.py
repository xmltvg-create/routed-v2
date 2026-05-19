"""Stop CRUD + reorder + complete/uncomplete endpoints.

Owns the lightweight, dependency-minimal half of the `/api/stops/*` surface:

    GET    /stops                     → list in order
    POST   /stops                     → idempotent create (suburb auto-resolved)
    PUT    /stops/{id}                → partial update with delivery-status sync
    DELETE /stops                     → wipe all (New Route)
    POST   /stops/clear               → POST equivalent for proxies that block DELETE
    DELETE /stops/{id}                → single delete + contiguous reindex
    POST   /stops/{id}/complete       → mark delivered
    POST   /stops/{id}/uncomplete     → un-mark delivered
    POST   /stops/reorder             → bulk reorder
    GET    /debug/stops-coords        → diagnostic (kept here because it's tiny)

Heavy siblings that touch Mapbox, ArcGIS or iterative geocoding — `regeocode`,
`refresh-suburbs`, `stops/export/xlsx`, `/car/*` — stay in `server.py` until
they earn their own domain module (geocoding.py / car.py / exports.py).

Shared helpers (`Stop`, `StopCreate`, `StopUpdate`, `ReorderRequest`, suburb
helpers, metadata builder, `db`, `get_current_user`) are lazy-imported from
`server` inside a thin dependency wrapper — same pattern as `routes/auth.py`
— so this module loads cleanly before `server.py` has finished initialising.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

logger = logging.getLogger("server")
router = APIRouter()


async def _current_user(request: Request):
    """Dep wrapper — defers the `server` import until the first request so the
    module can load before `server.py` finishes defining its symbols."""
    from server import get_current_user  # noqa: WPS433
    return await get_current_user(request)


@router.get("/debug/stops-coords")
async def debug_stops_coords(current_user=Depends(_current_user)):
    from server import db  # noqa: WPS433
    stops = await db.stops.find(
        {"user_id": current_user.user_id}, {"_id": 0}
    ).sort("order", 1).to_list(1000)
    return [{
        "order": s.get("order"),
        "address": s.get("address", "")[:50],
        "lat": s.get("latitude"),
        "lng": s.get("longitude"),
    } for s in stops]


@router.get("/stops")
async def get_stops(current_user=Depends(_current_user)):
    """Return all stops for the current user.

    Ordering contract (the "immutable fetch" safety net):

    * Stops with a non-null `sequence_number` (i.e. part of a confirmed,
      locked-in route) come FIRST, sorted by `sequence_number` ASC — this
      is what the driver will actually execute.
    * Stops with `sequence_number == null` (unoptimised or post-confirmation
      additions) fall to the BOTTOM, tie-broken by the legacy `order` field
      so existing drag-and-drop planning behaviour is preserved.

    The `$ifNull` aggregation coerces null to a sentinel larger than any
    legitimate sequence so a single `$sort` stage does both halves of the
    contract in one pass.
    """
    from server import db, Stop  # noqa: WPS433
    cursor = db.stops.aggregate([
        {"$match": {"user_id": current_user.user_id}},
        {"$project": {"_id": 0}},
        {"$addFields": {
            "_seq_rank": {"$ifNull": ["$sequence_number", 10**9]},
        }},
        {"$sort": {"_seq_rank": 1, "order": 1}},
        {"$project": {"_seq_rank": 0}},
    ])
    stops = await cursor.to_list(1000)

    # ML Phase 2 auto-snap: enrich each stop with display_latitude/longitude
    # = raw centroid + learned per-suburb offset. ONE Mongo round-trip per
    # /stops call (model is tiny ~2 KB). Non-fatal: any error leaves the
    # raw coords as the display coords (current behaviour preserved).
    try:
        bs_doc = await db.ml_building_side_models.find_one(
            {"user_id": current_user.user_id},
            {"_id": 0},
        )
        if bs_doc:
            from ml.building_side_corrector import predict_corrected_centroid
            for s in stops:
                corrected = predict_corrected_centroid(s, bs_doc)
                if corrected:
                    s["display_latitude"] = corrected[0]
                    s["display_longitude"] = corrected[1]
    except Exception:
        # Best-effort enrichment — never block the stop list on a
        # malformed model.
        pass

    return [Stop(**s) for s in stops]


# ─── Route confirmation / sequence lock ─────────────────────────────────────
#
# Once the driver reviews the optimised plan and hits "Confirm Route", we
# freeze the visit order into each stop's `sequence_number` column. From then
# on `/api/stops` serves stops in that locked order regardless of what
# happens to the live `order` field (drag-and-drop, re-optimisations, etc).
# This gives us an audit trail of what the driver *committed to drive*
# separate from the mutable planning state.


class _ConfirmRouteRequest(BaseModel):
    confirmed_sequence: List[str] = Field(..., min_length=1, max_length=5000)


@router.post("/routes/confirm")
async def confirm_route(
    request: Request,
    payload: "_ConfirmRouteRequest",
    current_user=Depends(_current_user),
):
    """Lock an optimised stop sequence into the database.

    Body: `{"confirmed_sequence": ["uuid-1", "uuid-2", ...]}`

    Semantics:
    * `uuid-1` gets `sequence_number = 1`, `uuid-2` gets 2, etc. (1-based).
    * Any stop the driver owns that is NOT in the payload has its
      `sequence_number` cleared back to `null` so it sinks to the bottom
      of `/api/stops` — this way re-confirming a shorter route is idempotent
      and a stop that was removed from the plan doesn't keep a stale rank.
    * Duplicate UUIDs in the payload are rejected (400) because a single
      stop cannot occupy two positions in the tour.
    * UUIDs that don't belong to the current user (or don't exist) are
      rejected too — prevents cross-tenant writes via a forged payload.

    All writes go through a single MongoDB `bulk_write` — one round-trip,
    no partial state: either every rank lands or none do.
    """
    from server import db  # noqa: WPS433
    from pymongo import UpdateOne, UpdateMany  # noqa: WPS433

    ids = payload.confirmed_sequence
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "confirmed_sequence contains duplicate stop_ids")

    # Validate ownership + existence in one query.
    owned = await db.stops.find(
        {"user_id": current_user.user_id, "id": {"$in": ids}},
        {"_id": 0, "id": 1},
    ).to_list(len(ids))
    owned_ids = {s["id"] for s in owned}
    missing = [sid for sid in ids if sid not in owned_ids]
    if missing:
        raise HTTPException(
            400,
            f"Unknown or non-owned stop_ids: {missing[:5]}"
            + (f" (+{len(missing) - 5} more)" if len(missing) > 5 else ""),
        )

    # One bulk_write round-trip: clear the old confirmation first (for every
    # stop that won't be in the new sequence), then assign 1..N to the new
    # sequence. Both ops are scoped to `user_id` so a malicious payload can
    # never touch another user's stops.
    ops: List = [
        UpdateMany(
            {
                "user_id": current_user.user_id,
                "id": {"$nin": ids},
                "sequence_number": {"$ne": None},
            },
            {"$set": {"sequence_number": None}},
        ),
    ]
    ops.extend(
        UpdateOne(
            {"id": stop_id, "user_id": current_user.user_id},
            {"$set": {"sequence_number": index + 1}},
        )
        for index, stop_id in enumerate(ids)
    )
    # Smart Sharpie-preserve contract (changed 2026-05-10 per user request):
    # The 2026-05-09 "always re-stamp" contract is now scoped to FIRST
    # confirm only. Once the driver has started delivering (≥1 completed
    # stop), a re-confirm preserves every existing `original_sequence`
    # so the physically-marked box numbers stay valid, and ONLY late
    # freight (stops with no Sharpie yet) gets newly-assigned numbers.
    #
    # Why this matters: drivers Sharpie-mark each parcel BEFORE leaving
    # the depot. The 05-09 contract overwrote those numbers on every
    # /routes/confirm hit, so when a driver re-optimised mid-shift and
    # tapped Start to resume, the boxes physically marked "12, 13, 14"
    # would now appear as "47, 48, 49" on-screen — they'd hunt for ages.
    # First-time confirm still works exactly as before (no completed
    # stops → full stamp), so the Sharpie-Lock UX is unchanged for the
    # happy path of "pre-label → confirm → drive".
    completed_count = await db.stops.count_documents(
        {"user_id": current_user.user_id, "completed": True},
    )
    is_resume = completed_count > 0

    if is_resume:
        # Pull existing original_sequence values so we know who's locked.
        existing_rows = await db.stops.find(
            {"user_id": current_user.user_id, "id": {"$in": ids}},
            {"_id": 0, "id": 1, "original_sequence": 1},
        ).to_list(len(ids))
        existing_by_id = {
            r["id"]: r.get("original_sequence")
            for r in existing_rows
        }
        # Next stamp number for new late freight: max-existing + 1.
        # `[None]` guard handles the "no stamps yet" edge case cleanly.
        max_locked = max(
            (v for v in existing_by_id.values() if isinstance(v, int)),
            default=0,
        )
        next_stamp = max_locked + 1
        late_freight_count = 0
        for stop_id in ids:
            current = existing_by_id.get(stop_id)
            if isinstance(current, int):
                continue  # already Sharpie-locked — preserve
            ops.append(
                UpdateOne(
                    {"id": stop_id, "user_id": current_user.user_id},
                    {"$set": {"original_sequence": next_stamp}},
                )
            )
            next_stamp += 1
            late_freight_count += 1
        logger.info(
            "[confirm_route] user=%s resume=True locked_preserved=%d "
            "late_freight_stamped=%d (next_stamp_after=%d)",
            current_user.user_id,
            sum(1 for v in existing_by_id.values() if isinstance(v, int)),
            late_freight_count,
            next_stamp - 1,
        )
    else:
        # First confirm of this route — full 1..N stamp, just like before.
        ops.extend(
            UpdateOne(
                {"id": stop_id, "user_id": current_user.user_id},
                {"$set": {"original_sequence": index + 1}},
            )
            for index, stop_id in enumerate(ids)
        )
    result = await db.stops.bulk_write(ops, ordered=False)

    # Re-read the just-stamped rows so we return the SERVER's truth — the
    # driver's local state cannot guess at `original_sequence` because it
    # may already have been locked from a previous confirm (Sharpie-marker
    # rule: stamp once, never overwrite). Returning here lets the
    # frontend hard-replace its local state without a second GET roundtrip.
    from server import Stop  # noqa: WPS433

    stamped_docs = await db.stops.find(
        {"user_id": current_user.user_id, "id": {"$in": ids}},
        {"_id": 0},
    ).to_list(len(ids))
    by_id = {d["id"]: d for d in stamped_docs}
    # Preserve payload order so the client can index straight into the array.
    stamped = [Stop(**by_id[sid]) for sid in ids if sid in by_id]

    logger.info(
        "[confirm_route] user=%s locked=%d cleared=%d returned=%d",
        current_user.user_id, len(ids),
        max(result.modified_count - len(ids), 0), len(stamped),
    )
    return {
        "status": "confirmed",
        "locked_count": len(ids),
        "confirmed_at": datetime.now(timezone.utc).isoformat(),
        "stops": stamped,
    }


@router.post("/stops")
async def create_stop(request: Request, current_user=Depends(_current_user)):
    from server import (  # noqa: WPS433
        db, Stop, StopCreate,
        extract_suburb_from_address, reverse_geocode_suburb,
        _build_stop_geocode_metadata,
    )

    body = await request.json()
    stop_data = StopCreate(**body)

    # Idempotency: dedupe by (coords, address) to survive client retries.
    existing = await db.stops.find_one({
        "user_id": current_user.user_id,
        "latitude": stop_data.latitude,
        "longitude": stop_data.longitude,
        "address": stop_data.address,
    }, {"_id": 0})
    if existing:
        return Stop(**existing)

    max_order_doc = await db.stops.find(
        {"user_id": current_user.user_id}, {"order": 1, "_id": 0}
    ).sort("order", -1).limit(1).to_list(1)
    max_order = max_order_doc[0]["order"] if max_order_doc else -1

    suburb = stop_data.suburb
    if not suburb:
        suburb = extract_suburb_from_address(stop_data.address)
    if not suburb:
        suburb = await reverse_geocode_suburb(stop_data.latitude, stop_data.longitude)

    stop = Stop(
        id=str(uuid.uuid4()),
        user_id=current_user.user_id,
        address=stop_data.address,
        name=stop_data.name,
        suburb=suburb,
        latitude=stop_data.latitude,
        longitude=stop_data.longitude,
        priority=stop_data.priority,
        time_window=stop_data.time_window,
        notes=stop_data.notes,
        weight=stop_data.weight,
        quantity=stop_data.quantity,
        geocode_metadata=_build_stop_geocode_metadata(stop_data.geocode_metadata),
        delivery_status=stop_data.delivery_status or "pending",
        failure_reason=stop_data.failure_reason,
        order=max_order + 1,
    )
    await db.stops.insert_one(stop.dict())
    return stop


@router.put("/stops/{stop_id}")
async def update_stop(stop_id: str, request: Request, current_user=Depends(_current_user)):
    from server import (  # noqa: WPS433
        db, Stop, StopUpdate, _build_stop_geocode_metadata,
    )

    body = await request.json()
    stop_data = StopUpdate(**body)

    existing = await db.stops.find_one(
        {"id": stop_id, "user_id": current_user.user_id}, {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Stop not found")

    # Use `exclude_unset=True` so partial PATCHes only touch the fields the
    # client explicitly named. The previous `if v is not None` filter was
    # too aggressive — it silently dropped legitimate clears (e.g. a driver
    # wiping out a wrong tracking_number by sending `null`). With
    # exclude_unset semantics:
    #   • {"tracking_number": "TRK-1"}  → set
    #   • {"tracking_number": null}     → clear
    #   • {} or omitted entirely        → no-op (preserves existing value)
    update_dict = stop_data.model_dump(exclude_unset=True)
    if "time_window" in update_dict and update_dict["time_window"]:
        update_dict["time_window"] = (
            update_dict["time_window"].dict()
            if hasattr(update_dict["time_window"], "dict")
            else update_dict["time_window"]
        )
    if "geocode_metadata" in update_dict:
        update_dict["geocode_metadata"] = _build_stop_geocode_metadata(
            update_dict.get("geocode_metadata")
        )
    if update_dict.get("completed") is True and "delivery_status" not in update_dict:
        update_dict["delivery_status"] = "delivered"
    if update_dict.get("completed") is False and update_dict.get("delivery_status") == "delivered":
        update_dict["delivery_status"] = "pending"

    if update_dict:
        await db.stops.update_one({"id": stop_id}, {"$set": update_dict})

    updated = await db.stops.find_one({"id": stop_id}, {"_id": 0})
    return Stop(**updated)


@router.delete("/stops")
async def delete_all_stops(current_user=Depends(_current_user)):
    from server import db  # noqa: WPS433
    result = await db.stops.delete_many({"user_id": current_user.user_id})
    return {"message": f"Deleted {result.deleted_count} stops", "deleted_count": result.deleted_count}


@router.post("/stops/clear")
async def clear_all_stops(current_user=Depends(_current_user)):
    """POST alternative for proxies that block DELETE."""
    from server import db  # noqa: WPS433
    result = await db.stops.delete_many({"user_id": current_user.user_id})
    return {"message": f"Deleted {result.deleted_count} stops", "deleted_count": result.deleted_count}


@router.delete("/stops/{stop_id}")
async def delete_stop(stop_id: str, current_user=Depends(_current_user)):
    from server import db  # noqa: WPS433
    from pymongo import UpdateOne  # noqa: WPS433

    result = await db.stops.delete_one({"id": stop_id, "user_id": current_user.user_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Stop not found")

    # Re-index so `order` stays contiguous — drivers rely on it for next-stop
    # lookup even after deletions mid-route.
    remaining_stops = await db.stops.find(
        {"user_id": current_user.user_id}, {"id": 1, "order": 1, "_id": 0}
    ).sort("order", 1).to_list(2000)

    if remaining_stops:
        reorder_ops = [
            UpdateOne(
                {"id": stop["id"], "user_id": current_user.user_id},
                {"$set": {"order": index}},
            )
            for index, stop in enumerate(remaining_stops)
        ]
        await db.stops.bulk_write(reorder_ops, ordered=False)

    return {
        "message": "Stop deleted",
        "deleted_stop_id": stop_id,
        "remaining_count": len(remaining_stops),
    }


@router.post("/stops/{stop_id}/arrived")
async def mark_arrived(stop_id: str, request: Request, current_user=Depends(_current_user)):
    """Records the moment the driver crossed the geofence around a stop.

    Combined with `/complete`, gives us `service_time = completed_at -
    arrived_at` per stop — the dataset Phase-1 service-time learning
    needs. The optional GPS payload is stamped here too because the fix
    captured at *arrival* (still moving, still on the road) is the cleanest
    signal for "what's the actual access edge?" — completion fixes are
    often taken at the front door, several metres off the road network.

    Body (all optional): {lat, lng, accuracy_m}.
    Idempotent: a re-fire on the same stop is a no-op (we keep the first
    arrival timestamp; geofence jitter shouldn't reset the clock).
    """
    from server import db, Stop  # noqa: WPS433
    existing = await db.stops.find_one(
        {"id": stop_id, "user_id": current_user.user_id}, {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Stop not found")

    # Idempotent: keep the earliest arrival time so geofence jitter or
    # offline-replay re-fires can't reset the clock.
    if existing.get("arrived_at"):
        return Stop(**existing)

    body: dict = {}
    try:
        body = await request.json()
    except Exception:
        body = {}  # accept empty body — GPS is best-effort

    update: dict = {"arrived_at": datetime.now(timezone.utc),
                    "arrival_method": "geofence"}
    lat = body.get("lat")
    lng = body.get("lng")
    if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
        update["arrival_lat"] = float(lat)
        update["arrival_lng"] = float(lng)
    acc = body.get("accuracy_m")
    if isinstance(acc, (int, float)):
        update["arrival_accuracy_m"] = float(acc)

    await db.stops.update_one({"id": stop_id}, {"$set": update})
    updated = await db.stops.find_one({"id": stop_id}, {"_id": 0})
    return Stop(**updated)


@router.post("/stops/{stop_id}/complete")
async def complete_stop(stop_id: str, request: Request, current_user=Depends(_current_user)):
    """Mark a stop delivered.

    Now accepts an optional GPS payload `{lat, lng, accuracy_m}` from the
    "Mark Delivered" tap so we can later learn (a) the actual driveway/door
    side from the offset between geocoded centroid and observed delivery
    fix, (b) realistic service times from `completed_at - arrived_at`. GPS
    is best-effort: if the body is empty or fields are missing the stop is
    still marked delivered the same way it always was — no behavioural
    regression for drivers with revoked location permissions or weak GPS.
    """
    from server import db, Stop  # noqa: WPS433
    existing = await db.stops.find_one(
        {"id": stop_id, "user_id": current_user.user_id}, {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Stop not found")

    update: dict = {
        "completed": True,
        "completed_at": datetime.now(timezone.utc),
        "delivery_status": "delivered",
        "failure_reason": None,
    }

    body: dict = {}
    try:
        body = await request.json()
    except Exception:
        body = {}

    lat = body.get("lat")
    lng = body.get("lng")
    completion_distance_m: Optional[float] = None
    if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
        update["completion_lat"] = float(lat)
        update["completion_lng"] = float(lng)
        # Compute haversine distance from completion GPS to stop centroid.
        # This is the smoking-gun field: if drivers routinely tap Delivered
        # from 150m+ away, the geofence radius (currently 100m) is the
        # bottleneck. The archive endpoint rolls these up into p50/p95
        # percentiles so we can tune the radius to actual driver behaviour.
        stop_lat = existing.get("latitude")
        stop_lng = existing.get("longitude")
        if isinstance(stop_lat, (int, float)) and isinstance(stop_lng, (int, float)):
            try:
                from haversine import haversine as _hav, Unit as _U
                dist_m = _hav(
                    (float(lat), float(lng)),
                    (float(stop_lat), float(stop_lng)),
                    unit=_U.METERS,
                )
                completion_distance_m = round(float(dist_m), 1)
                update["completion_distance_m"] = completion_distance_m
            except Exception:
                pass
    acc = body.get("accuracy_m")
    if isinstance(acc, (int, float)):
        update["completion_accuracy_m"] = float(acc)
    # `view_mode` from the frontend tells us whether the driver was in the
    # immersive nav cockpit (where the geofence is enabled) or tapped
    # Delivered from a list/marker modal (where it never gets a chance to
    # fire). One of the two main hypotheses for "geofence_rate=0%".
    vm = body.get("view_mode")
    view_mode_at_completion: Optional[str] = None
    if isinstance(vm, str) and vm in ("planning", "navigating"):
        view_mode_at_completion = vm
        update["view_mode_at_completion"] = vm

    # ── Arrival-method backstop with smart inference ─────────────────────
    # If the geofence never stamped `arrived_at`, fall back to one of two
    # tags depending on signal quality:
    #
    #   `geofence_inferred` — driver was clearly at the stop when they
    #     tapped Delivered (view_mode='navigating' AND within
    #     INFER_RADIUS_M of the geocoded centroid OR within the same
    #     radius of the learned building-side-corrected centroid). The
    #     hook didn't fire (likely because the GPS tick that crossed the
    #     100 m radius coincided with the tap), but the telemetry signal
    #     is still trustworthy enough for ML service-time learning.
    #
    #   `fallback_completion` — pure backstop. Driver tapped from the
    #     planning list, OR was too far away, OR GPS was missing. Marked
    #     with a 30 s back-dated arrival so the learner can still derive
    #     a degraded sample but down-weight it.
    #
    # Phase 2 ML (building-side corrector) lets us also infer arrival
    # when the driver is within INFER_RADIUS_M of the CORRECTED centroid
    # (centroid + learned per-suburb offset). On large industrial
    # complexes the offset can exceed 50 m, so a driver parked at the
    # actual loading dock 130 m from the rooftop centroid still gets
    # tagged geofence_inferred instead of fallback_completion. We do NOT
    # widen the raw INFER_RADIUS — the correction is the surgical fix.
    #
    # INFER_RADIUS_M = 150: 100 m geofence radius + 50 m slack for GPS
    # accuracy + driveway offset. Tight enough to exclude "tapped from
    # the next street" cases.
    if not existing.get("arrived_at"):
        INFER_RADIUS_M = 150.0
        within_raw = (
            completion_distance_m is not None
            and completion_distance_m <= INFER_RADIUS_M
        )
        within_corrected = False
        if (
            not within_raw
            and view_mode_at_completion == "navigating"
            and isinstance(lat, (int, float))
            and isinstance(lng, (int, float))
        ):
            # Try the building-side corrected centroid. Non-fatal: any
            # error (missing model, no suburb, bad coords) just leaves
            # within_corrected=False and we fall through to fallback.
            try:
                bs_doc = await db.ml_building_side_models.find_one(
                    {"user_id": current_user.user_id},
                    {"_id": 0},
                )
                if bs_doc:
                    from ml.building_side_corrector import predict_corrected_centroid
                    corrected = predict_corrected_centroid(existing, bs_doc)
                    if corrected:
                        from haversine import haversine as _hav2, Unit as _U2
                        d_corr = _hav2(
                            (float(lat), float(lng)),
                            (float(corrected[0]), float(corrected[1])),
                            unit=_U2.METERS,
                        )
                        if d_corr <= INFER_RADIUS_M:
                            within_corrected = True
                            update["completion_distance_corrected_m"] = round(float(d_corr), 1)
            except Exception:
                pass

        inferred_geofence = (
            view_mode_at_completion == "navigating"
            and (within_raw or within_corrected)
        )
        if inferred_geofence:
            update["arrived_at"] = update["completed_at"] - timedelta(seconds=30)
            update["arrival_method"] = "geofence_inferred"
        else:
            update["arrived_at"] = update["completed_at"] - timedelta(seconds=30)
            update["arrival_method"] = "fallback_completion"

    await db.stops.update_one({"id": stop_id}, {"$set": update})
    updated = await db.stops.find_one({"id": stop_id}, {"_id": 0})
    return Stop(**updated)


@router.post("/stops/{stop_id}/uncomplete")
async def uncomplete_stop(stop_id: str, current_user=Depends(_current_user)):
    from server import db, Stop  # noqa: WPS433
    existing = await db.stops.find_one(
        {"id": stop_id, "user_id": current_user.user_id}, {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Stop not found")

    await db.stops.update_one(
        {"id": stop_id},
        {"$set": {
            "completed": False,
            "completed_at": None,
            "delivery_status": "pending",
        }},
    )
    updated = await db.stops.find_one({"id": stop_id}, {"_id": 0})
    return Stop(**updated)


@router.post("/stops/reorder")
async def reorder_stops(request: Request, current_user=Depends(_current_user)):
    """Bulk reorder — single `bulk_write` beats N individual updates on 100+ stops."""
    from server import db, ReorderRequest  # noqa: WPS433
    from pymongo import UpdateOne  # noqa: WPS433

    body = await request.json()
    reorder = ReorderRequest(**body)

    ops = [
        UpdateOne(
            {"id": stop_id, "user_id": current_user.user_id},
            {"$set": {"order": index}},
        )
        for index, stop_id in enumerate(reorder.stop_ids)
    ]
    if ops:
        await db.stops.bulk_write(ops, ordered=False)
    return {"message": "Stops reordered"}


# ── Outlier guardrail ───────────────────────────────────────────────────
#
# A single mis-geocoded stop in the wrong country (e.g. an Australian
# courier importing a CSV where one row resolved to "Central Park, NY")
# silently nukes the next optimise: PyVRP dutifully draws a 3,000 km
# polyline through the outlier and the driver's screen looks "patchy".
# This endpoint flags outliers BEFORE they reach the solver, so the UI
# can surface a red banner with one-tap removal.
#
# Centroid is the **median** lat/lng (not the mean) — a robust estimator
# that doesn't itself get pulled toward the outliers it's meant to find.
# Threshold defaults to 50 km, matching the same value baked into the
# frontend banner copy. Any stop farther than `threshold_km` from the
# median centroid is flagged.

def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in km. Inlined (no haversine import) so the
    outlier sweep stays O(n) on a 1000-stop manifest without any extra
    Python-level call overhead."""
    from math import radians, sin, cos, asin, sqrt
    rlat1, rlng1, rlat2, rlng2 = map(radians, (lat1, lng1, lat2, lng2))
    dlat = rlat2 - rlat1
    dlng = rlng2 - rlng1
    a = sin(dlat / 2) ** 2 + cos(rlat1) * cos(rlat2) * sin(dlng / 2) ** 2
    return 2 * 6371.0088 * asin(sqrt(a))


def _median(values: List[float]) -> float:
    s = sorted(values)
    n = len(s)
    if n == 0:
        return 0.0
    if n % 2:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


@router.get("/stops/outliers")
async def detect_outliers(
    threshold_km: float = Query(50.0, ge=1.0, le=20000.0),
    current_user=Depends(_current_user),
):
    """Flag stops sitting >`threshold_km` from the median cluster centroid.

    Returns:
        {
          "centroid": {"lat": ..., "lng": ...} | null,
          "threshold_km": 50.0,
          "total_stops": 163,
          "outliers": [
            {"id": "...", "address": "...", "name": "...",
             "latitude": 40.75, "longitude": -73.99,
             "distance_km": 2740.5, "completed": false}
          ]
        }

    `outliers` sorted by distance descending so the worst offenders are
    rendered at the top of the review modal. If fewer than 3 stops have
    coordinates we return an empty `outliers` list — the median estimator
    is meaningless on such a small sample and a single legitimate stop in
    a 2-stop manifest would otherwise look like an "outlier".
    """
    from server import db  # noqa: WPS433

    docs = await db.stops.find(
        {"user_id": current_user.user_id},
        {"_id": 0, "id": 1, "address": 1, "name": 1, "latitude": 1,
         "longitude": 1, "completed": 1, "order": 1},
    ).to_list(5000)

    coords = [
        (d.get("latitude"), d.get("longitude"))
        for d in docs
        if isinstance(d.get("latitude"), (int, float))
        and isinstance(d.get("longitude"), (int, float))
    ]
    total_stops = len(docs)

    if len(coords) < 3:
        return {
            "centroid": None,
            "threshold_km": threshold_km,
            "total_stops": total_stops,
            "outliers": [],
        }

    clat = _median([c[0] for c in coords])
    clng = _median([c[1] for c in coords])

    outliers = []
    for d in docs:
        la, lng = d.get("latitude"), d.get("longitude")
        if not isinstance(la, (int, float)) or not isinstance(lng, (int, float)):
            continue
        dist = _haversine_km(clat, clng, la, lng)
        if dist > threshold_km:
            outliers.append({
                "id": d["id"],
                "address": d.get("address", ""),
                "name": d.get("name", ""),
                "latitude": la,
                "longitude": lng,
                "distance_km": round(dist, 1),
                "completed": bool(d.get("completed")),
            })
    outliers.sort(key=lambda x: x["distance_km"], reverse=True)

    return {
        "centroid": {"lat": clat, "lng": clng},
        "threshold_km": threshold_km,
        "total_stops": total_stops,
        "outliers": outliers,
    }


class _RemoveOutliersRequest(BaseModel):
    stop_ids: List[str] = Field(..., min_length=1, max_length=5000)


@router.post("/stops/outliers/remove")
async def remove_outliers(
    payload: "_RemoveOutliersRequest",
    current_user=Depends(_current_user),
):
    """Bulk-delete the supplied outlier stop_ids and reindex `order`.

    Scoped to the current user so a forged payload can never delete
    another tenant's data. Re-indexes `order` contiguously after the
    delete the same way `DELETE /stops/{id}` does, so the list view
    stays gap-free.

    Returns: `{"deleted_count": int, "remaining_count": int}`
    """
    from server import db  # noqa: WPS433
    from pymongo import UpdateOne  # noqa: WPS433

    ids = list({sid for sid in payload.stop_ids if isinstance(sid, str)})
    if not ids:
        raise HTTPException(400, "stop_ids must be a non-empty list of strings")

    result = await db.stops.delete_many(
        {"user_id": current_user.user_id, "id": {"$in": ids}}
    )

    remaining = await db.stops.find(
        {"user_id": current_user.user_id}, {"_id": 0, "id": 1, "order": 1}
    ).sort("order", 1).to_list(5000)
    if remaining:
        await db.stops.bulk_write(
            [
                UpdateOne(
                    {"id": s["id"], "user_id": current_user.user_id},
                    {"$set": {"order": idx}},
                )
                for idx, s in enumerate(remaining)
            ],
            ordered=False,
        )

    logger.info(
        "[remove_outliers] user=%s deleted=%d remaining=%d",
        current_user.user_id, result.deleted_count, len(remaining),
    )
    return {
        "deleted_count": result.deleted_count,
        "remaining_count": len(remaining),
    }


# ── ML data-pipeline health ──────────────────────────────────────────────


@router.get("/admin/ml/readiness")
async def ml_data_readiness(current_user=Depends(_current_user)):
    """How healthy is the service-time learning dataset for THIS driver?

    Returns the same numbers we'd otherwise pull via an ad-hoc Mongo script,
    so the operator can monitor pipeline health from the device. Scoped to
    the authenticated user — no cross-tenant leakage.

    Service-time pair = a stop with both `arrived_at` and `completed_at`
    set, regardless of `arrival_method`. The `geofence` / `fallback_completion`
    breakdown lets us judge how trustworthy the dataset is: high
    `geofence` count = real telemetry, high `fallback` count = degraded
    backstop only.
    """
    from server import db  # noqa: WPS433

    uid = current_user.user_id
    cutoff_7d = datetime.now(timezone.utc) - timedelta(days=7)

    # Aggregate service-time pairs from the route_history archives too.
    # /import/process auto-archives completed stops before wiping the
    # active route, so completed deliveries don't live in `db.stops` for
    # long. Without this aggregation, the readiness badge would reset to
    # 0 every time the driver reimports their manifest — exactly the
    # bug we just fixed at the data layer.
    pipe_archive_pairs = [
        {"$match": {"user_id": uid}},
        {"$unwind": "$stops"},
        {"$match": {
            "stops.arrived_at": {"$ne": None},
            "stops.completed_at": {"$ne": None},
        }},
        {"$group": {
            "_id": "$stops.arrival_method",
            "n": {"$sum": 1},
            "n_recent": {"$sum": {
                "$cond": [{"$gte": ["$stops.completed_at", cutoff_7d]}, 1, 0]
            }},
        }},
    ]

    async def archive_pair_counts():
        out = {"geofence": 0, "fallback_completion": 0, "null": 0, "_recent": 0}
        async for d in db.route_history.aggregate(pipe_archive_pairs):
            method = d["_id"] or "null"
            out[method] = d.get("n", 0)
            out["_recent"] += d.get("n_recent", 0)
        return out

    # Fan out the count queries in parallel — each is a cheap index-backed
    # query, so doing them concurrently is purely a latency win.
    import asyncio
    (
        total,
        completed,
        has_arrived,
        live_pairs,
        live_geo,
        live_fb,
        live_recent,
        archives,
        arc,
    ) = await asyncio.gather(
        db.stops.count_documents({"user_id": uid}),
        db.stops.count_documents({"user_id": uid, "completed": True}),
        db.stops.count_documents({"user_id": uid, "arrived_at": {"$ne": None}}),
        db.stops.count_documents({
            "user_id": uid,
            "arrived_at": {"$ne": None},
            "completed_at": {"$ne": None},
        }),
        db.stops.count_documents({
            "user_id": uid,
            "arrival_method": "geofence",
            "completed_at": {"$ne": None},
        }),
        db.stops.count_documents({
            "user_id": uid,
            "arrival_method": "fallback_completion",
            "completed_at": {"$ne": None},
        }),
        db.stops.count_documents({
            "user_id": uid,
            "arrived_at": {"$ne": None},
            "completed_at": {"$gte": cutoff_7d},
        }),
        db.route_history.count_documents({"user_id": uid}),
        archive_pair_counts(),
    )

    pairs = live_pairs + arc["geofence"] + arc["fallback_completion"] + arc["null"]
    pairs_geofence = live_geo + arc["geofence"]
    pairs_fallback = live_fb + arc["fallback_completion"]
    recent_pairs = live_recent + arc["_recent"]

    # Empirical ML training thresholds:
    #   <50  → not enough data, learner can't beat a global median
    #   50-200 → trainable but high variance per (building-type) bucket
    #   200+ → robust per-bucket median is reliable
    if pairs >= 200:
        readiness = "ready"
    elif pairs >= 50:
        readiness = "trainable"
    else:
        readiness = "insufficient"

    return {
        "user_id": uid,
        "readiness": readiness,
        "service_time_pairs": pairs,
        "service_time_pairs_geofence": pairs_geofence,
        "service_time_pairs_fallback": pairs_fallback,
        "service_time_pairs_last_7d": recent_pairs,
        "thresholds": {"min_trainable": 50, "min_robust": 200},
        "stops": {
            "total": total,
            "completed": completed,
            "with_arrived_at": has_arrived,
        },
        "route_history_archives": archives,
        "as_of": datetime.now(timezone.utc).isoformat(),
    }


@router.post("/stops/recover-sharpie-marks")
async def recover_sharpie_marks(request: Request, current_user=Depends(_current_user)):
    """One-tap sharpie recovery.

    Re-runs the deterministic `vroom_lkh_3opt` solver against the user's
    current pending stops (via internal HTTP self-call so we inherit the
    full matrix-building / OSRM / nogo-zone pipeline), then writes
    `original_sequence` and `sequence_number` from the resulting order.

    Use case: a CSV re-import or accidental wipe cleared the sharpie
    marks. Because VROOM+LKH is deterministic for identical inputs, the
    re-run reproduces the exact sequence the driver had at the last
    optimise — recovering the physical-parcel-to-digital-stop binding
    without any user effort.
    """
    import httpx  # noqa: WPS433
    from server import db  # noqa: WPS433
    from pymongo import UpdateOne  # noqa: WPS433

    auth_header = request.headers.get("Authorization", "")
    cookie_header = request.headers.get("Cookie", "")
    if not auth_header and not cookie_header:
        raise HTTPException(status_code=401, detail="No auth context to forward")

    base = "http://localhost:8001"
    fwd_headers = {"Content-Type": "application/json"}
    if auth_header:
        fwd_headers["Authorization"] = auth_header
    if cookie_header:
        fwd_headers["Cookie"] = cookie_header

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{base}/api/optimize",
                headers=fwd_headers,
                json={"algorithm": "vroom_lkh_3opt"},
            )
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as e:
        logger.warning("[recover-sharpie-marks] optimize self-call failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Optimize failed: {e}")

    sequence = data.get("optimized_stops") or data.get("stops") or []
    ids = [s.get("id") for s in sequence if s.get("id")]
    if not ids:
        raise HTTPException(status_code=404, detail="No stops to restore")

    ops = [
        UpdateOne(
            {"id": sid, "user_id": current_user.user_id},
            {"$set": {"original_sequence": i + 1, "sequence_number": i + 1, "order": i}},
        )
        for i, sid in enumerate(ids)
    ]
    result = await db.stops.bulk_write(ops, ordered=False)
    logger.info(
        "[recover-sharpie-marks] user=%s restored=%d/%d (algorithm=%s)",
        current_user.user_id, result.modified_count, len(ids), data.get("algorithm"),
    )
    return {
        "restored": result.modified_count,
        "matched": result.matched_count,
        "total": len(ids),
        "algorithm": data.get("algorithm"),
        "first5_ids": ids[:5],
    }



@router.post("/stops/relock-pins")
async def relock_pin_numbers(current_user=Depends(_current_user)):
    """Re-stamp `original_sequence` from the current `order` field.

    Use case: driver re-optimised mid-shift and wants the map pin numbers
    (Sharpie marks) to track the NEW optimised order, not the old locked
    one. Unlike `/recover-sharpie-marks` this does NOT re-run a solver —
    it just takes whatever `order` the most recent optimise (or manual
    drag-reorder) produced and writes it as the new locked
    `original_sequence`. Drivers with deferred-labelling workflows
    (write Sharpies AFTER confirming) get a free re-stamp here without
    paying for a full VROOM+LKH replay.

    Idempotent: running it twice in a row produces the same DB state.
    """
    from server import db  # noqa: WPS433
    from pymongo import UpdateOne  # noqa: WPS433

    cursor = db.stops.find(
        {"user_id": current_user.user_id},
        {"_id": 0, "id": 1, "order": 1},
    ).sort("order", 1)
    rows = await cursor.to_list(length=None)
    if not rows:
        return {"restored": 0, "total": 0}

    ops = [
        UpdateOne(
            {"id": r["id"], "user_id": current_user.user_id},
            {"$set": {"original_sequence": i + 1, "sequence_number": i + 1}},
        )
        for i, r in enumerate(rows)
        if r.get("id")
    ]
    if not ops:
        return {"restored": 0, "total": 0}
    result = await db.stops.bulk_write(ops, ordered=False)
    logger.info(
        "[relock-pins] user=%s restored=%d/%d",
        current_user.user_id, result.modified_count, len(ops),
    )
    return {
        "restored": result.modified_count,
        "matched": result.matched_count,
        "total": len(ops),
    }
