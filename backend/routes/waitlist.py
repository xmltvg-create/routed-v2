"""Waitlist API for RouTeD Phase 2 rollout gating.

Owns `/api/waitlist/*` endpoints. When `SIGNUPS_DISABLED=true` in
`routes/auth.py`, new Google-sign-in users are auto-added to the
waitlist as "pending". Admins (STRIPE_ADMIN_USER_IDS) can approve/reject
entries. Approved users are allowed through the signup gate on their
next login attempt.

Public endpoints (no auth required):
  POST /api/waitlist/join       — submit email for waitlist
  GET  /api/waitlist/status     — check waitlist status by email

Admin endpoints (require admin user_id):
  GET    /api/waitlist/entries   — list all waitlist entries
  GET    /api/waitlist/stats     — waitlist statistics
  POST   /api/waitlist/approve   — approve one or more emails
  POST   /api/waitlist/reject    — reject one or more emails
  DELETE /api/waitlist/{entry_id} — remove an entry

Data model (collection: `waitlist`):
  {
    "id": str,
    "email": str (unique),
    "name": str,
    "status": "pending" | "approved" | "rejected",
    "source": "google_login_gate" | "manual_join" | "admin_add",
    "created_at": ISO str,
    "updated_at": ISO str,
    "approved_at": ISO str | null,
    "notes": str | null,
  }
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field

logger = logging.getLogger("server")
router = APIRouter(prefix="/waitlist", tags=["waitlist"])

# Admin user_ids — same source as billing.py so we have one allowlist.
_admin_csv = os.environ.get("STRIPE_ADMIN_USER_IDS", "")
ADMIN_USER_IDS = {u.strip() for u in _admin_csv.split(",") if u.strip()}


# ── IP-based rate limiter ─────────────────────────────────────────────
# Simple in-memory sliding-window rate limiter for public endpoints.
# Prevents abuse of waitlist join/status (e.g. email enumeration,
# automated sign-ups). Resets on server restart which is acceptable
# for our scale.
_rate_buckets: dict[str, list[float]] = defaultdict(list)
_RATE_WINDOW_S = 60  # 1 minute window
_RATE_LIMIT_JOIN = 15  # max 15 joins per minute per IP
_RATE_LIMIT_STATUS = 30  # max 30 status checks per minute per IP


def _check_rate_limit(request: Request, limit: int) -> None:
    """Raise 429 if the caller exceeds the per-IP rate limit."""
    ip = request.client.host if request.client else "unknown"
    key = f"{ip}:{request.url.path}"
    now = time.monotonic()
    # Prune expired entries
    _rate_buckets[key] = [t for t in _rate_buckets[key] if now - t < _RATE_WINDOW_S]
    if len(_rate_buckets[key]) >= limit:
        raise HTTPException(
            status_code=429,
            detail=f"Too many requests. Please wait {_RATE_WINDOW_S}s and try again.",
        )
    _rate_buckets[key].append(now)


def reset_rate_limits() -> None:
    """Clear all rate-limit buckets. Used by test fixtures."""
    _rate_buckets.clear()


# ── Pydantic schemas ─────────────────────────────────────────────────
class WaitlistJoinRequest(BaseModel):
    email: EmailStr
    name: str = ""


class WaitlistJoinResponse(BaseModel):
    id: str
    email: str
    status: str
    message: str


class WaitlistStatusResponse(BaseModel):
    email: str
    on_waitlist: bool
    status: Optional[str] = None
    position: Optional[int] = None


class WaitlistEntry(BaseModel):
    id: str
    email: str
    name: str
    status: str
    source: str
    created_at: str
    updated_at: str
    approved_at: Optional[str] = None
    notes: Optional[str] = None


class WaitlistApproveRequest(BaseModel):
    emails: List[str] = Field(..., min_length=1)


class WaitlistRejectRequest(BaseModel):
    emails: List[str] = Field(..., min_length=1)


class WaitlistStatsResponse(BaseModel):
    total: int
    pending: int
    approved: int
    rejected: int


# ── Helpers ───────────────────────────────────────────────────────────
async def _require_admin(request: Request):
    """Raise 403 if the caller is not an admin."""
    from server import get_current_user
    current_user = await get_current_user(request)
    if current_user.user_id not in ADMIN_USER_IDS:
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user


async def _ensure_waitlist_indexes(db) -> None:
    """Idempotent index creation. Called from server startup."""
    await db.waitlist.create_index("email", unique=True)
    await db.waitlist.create_index("status")
    await db.waitlist.create_index("created_at")


async def add_to_waitlist(
    db,
    email: str,
    name: str = "",
    source: str = "manual_join",
) -> dict:
    """Add an email to the waitlist. Returns the entry dict.
    Idempotent: if the email already exists, returns the existing entry."""
    email = email.strip().lower()
    existing = await db.waitlist.find_one({"email": email}, {"_id": 0})
    if existing:
        return existing

    now = datetime.now(timezone.utc).isoformat()
    entry = {
        "id": str(uuid.uuid4()),
        "email": email,
        "name": name,
        "status": "pending",
        "source": source,
        "created_at": now,
        "updated_at": now,
        "approved_at": None,
        "notes": None,
    }
    await db.waitlist.insert_one(entry)
    logger.info("[waitlist] Added %s (source=%s)", email, source)
    # Return without _id
    entry.pop("_id", None)
    return entry


async def is_waitlist_approved(db, email: str) -> bool:
    """Check if an email is approved on the waitlist."""
    email = email.strip().lower()
    entry = await db.waitlist.find_one(
        {"email": email, "status": "approved"}, {"_id": 0, "status": 1}
    )
    return entry is not None


# ── Public endpoints ──────────────────────────────────────────────────
@router.post("/join", response_model=WaitlistJoinResponse)
async def join_waitlist(body: WaitlistJoinRequest, request: Request):
    """Public: submit an email to join the waitlist."""
    _check_rate_limit(request, _RATE_LIMIT_JOIN)
    from server import db

    entry = await add_to_waitlist(db, body.email, body.name, source="manual_join")
    status = entry["status"]

    if status == "approved":
        msg = "You're approved! Sign in to get started."
    elif status == "rejected":
        msg = "Your request was not approved at this time."
    else:
        msg = "You're on the waitlist! We'll notify you when a spot opens up."

    return WaitlistJoinResponse(
        id=entry["id"],
        email=entry["email"],
        status=status,
        message=msg,
    )


@router.get("/status", response_model=WaitlistStatusResponse)
async def check_waitlist_status(email: str, request: Request):
    """Public: check waitlist status for an email address."""
    _check_rate_limit(request, _RATE_LIMIT_STATUS)
    from server import db

    email_lower = email.strip().lower()
    entry = await db.waitlist.find_one({"email": email_lower}, {"_id": 0})

    if not entry:
        return WaitlistStatusResponse(
            email=email_lower,
            on_waitlist=False,
        )

    # Position = count of pending entries created before this one
    position = None
    if entry["status"] == "pending":
        position = await db.waitlist.count_documents({
            "status": "pending",
            "created_at": {"$lte": entry["created_at"]},
        })

    return WaitlistStatusResponse(
        email=email_lower,
        on_waitlist=True,
        status=entry["status"],
        position=position,
    )


# ── Admin endpoints ───────────────────────────────────────────────────
@router.get("/entries", response_model=List[WaitlistEntry])
async def list_waitlist_entries(
    request: Request,
    status: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    """Admin: list waitlist entries with optional status filter."""
    from server import db
    await _require_admin(request)

    query = {}
    if status and status in ("pending", "approved", "rejected"):
        query["status"] = status

    cursor = db.waitlist.find(query, {"_id": 0}).sort("created_at", 1).skip(offset).limit(limit)
    entries = await cursor.to_list(length=limit)
    return entries


@router.get("/stats", response_model=WaitlistStatsResponse)
async def get_waitlist_stats(request: Request):
    """Admin: get waitlist statistics."""
    from server import db
    await _require_admin(request)

    total = await db.waitlist.count_documents({})
    pending = await db.waitlist.count_documents({"status": "pending"})
    approved = await db.waitlist.count_documents({"status": "approved"})
    rejected = await db.waitlist.count_documents({"status": "rejected"})

    return WaitlistStatsResponse(
        total=total,
        pending=pending,
        approved=approved,
        rejected=rejected,
    )


@router.post("/approve")
async def approve_waitlist_entries(request: Request, body: WaitlistApproveRequest):
    """Admin: approve one or more waitlist entries by email."""
    from server import db
    admin = await _require_admin(request)

    now = datetime.now(timezone.utc).isoformat()
    emails = [e.strip().lower() for e in body.emails]

    result = await db.waitlist.update_many(
        {"email": {"$in": emails}, "status": {"$ne": "approved"}},
        {
            "$set": {
                "status": "approved",
                "approved_at": now,
                "updated_at": now,
                "notes": f"Approved by {admin.user_id}",
            }
        },
    )

    logger.info(
        "[waitlist] Admin %s approved %d/%d emails",
        admin.user_id, result.modified_count, len(emails),
    )

    return {
        "approved_count": result.modified_count,
        "requested_count": len(emails),
    }


@router.post("/reject")
async def reject_waitlist_entries(request: Request, body: WaitlistRejectRequest):
    """Admin: reject one or more waitlist entries by email."""
    from server import db
    admin = await _require_admin(request)

    now = datetime.now(timezone.utc).isoformat()
    emails = [e.strip().lower() for e in body.emails]

    result = await db.waitlist.update_many(
        {"email": {"$in": emails}, "status": {"$ne": "rejected"}},
        {
            "$set": {
                "status": "rejected",
                "updated_at": now,
                "notes": f"Rejected by {admin.user_id}",
            }
        },
    )

    logger.info(
        "[waitlist] Admin %s rejected %d/%d emails",
        admin.user_id, result.modified_count, len(emails),
    )

    return {
        "rejected_count": result.modified_count,
        "requested_count": len(emails),
    }


@router.delete("/{entry_id}")
async def delete_waitlist_entry(entry_id: str, request: Request):
    """Admin: permanently remove a waitlist entry."""
    from server import db
    await _require_admin(request)

    result = await db.waitlist.delete_one({"id": entry_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Waitlist entry not found")

    return {"deleted": True, "id": entry_id}
