"""Emergent Google-Auth session endpoints.

Owns `/api/auth/session`, `/api/auth/me`, `/api/auth/logout`. Exchanges an
`X-Session-ID` with `demobackend.emergentagent.com`, persists the user record
+ session in MongoDB, and hangs an HttpOnly cookie on the response.

Split out of `server.py` per the ROUTES.md pattern. The whitelist/signup flags
live here (only auth logic references them) while `db` + user helpers stay
importable from `server` so the dependency graph keeps a single source of
truth for Mongo + dependency-injected auth.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

logger = logging.getLogger("server")
router = APIRouter()

# ── Access policy ────────────────────────────────────────────────────────
# Public Google Play launch: signups are now OPEN. Anyone with a Google
# account can sign in, no allowlist gating. Backend env vars still let
# us re-close the gate quickly if abuse appears post-launch:
#   ALLOWED_USERS_CSV   — comma-separated emails. If set, only these
#                         emails can sign in (overrides open mode).
#   SIGNUPS_DISABLED    — if "true", existing users can sign in but
#                         no new accounts are created.
#
# Default = open. Reviewer emails are auto-Pro via routes/billing.py
# (REVIEWER_EMAILS env var) — they don't need a separate gate here.
import os as _auth_os

_allowed_csv = _auth_os.environ.get("ALLOWED_USERS_CSV", "").strip()
ALLOWED_USERS: List[str] = (
    [e.strip().lower() for e in _allowed_csv.split(",") if e.strip()]
    if _allowed_csv
    else []  # empty = allow all
)
SIGNUPS_DISABLED = _auth_os.environ.get("SIGNUPS_DISABLED", "false").lower() == "true"

# Reviewer allowlist (mirrors REVIEWER_EMAILS in routes/billing.py). Used here
# only to decide whether to seed a demo route the first time the account
# signs in — the actual paywall bypass lives in billing.py.
_reviewer_csv = _auth_os.environ.get("REVIEWER_EMAILS", "")
_REVIEWER_EMAILS = {e.strip().lower() for e in _reviewer_csv.split(",") if e.strip()}


# Sydney CBD / inner-suburb landmarks used as demo stops for Google Play
# reviewers. Coordinates verified manually (no live geocoding required so
# the seed is offline-safe even when Mapbox is rate-limited). Six stops
# is the smallest sample that still produces a meaningful optimized route
# (>3 stops triggers the full OR-Tools pipeline rather than the trivial
# 2-point shortcut).
_REVIEWER_DEMO_STOPS = [
    {
        "address": "Sydney Opera House, Bennelong Point, Sydney NSW 2000",
        "name": "Demo · Opera House",
        "latitude": -33.8568,
        "longitude": 151.2153,
        "suburb": "Sydney",
        "notes": "Reviewer demo stop — feel free to delete.",
    },
    {
        "address": "Queen Victoria Building, 455 George St, Sydney NSW 2000",
        "name": "Demo · QVB",
        "latitude": -33.8716,
        "longitude": 151.2068,
        "suburb": "Sydney",
        "notes": "Reviewer demo stop — feel free to delete.",
    },
    {
        "address": "100 Crown St, Surry Hills NSW 2010",
        "name": "Demo · Surry Hills Cafe",
        "latitude": -33.8839,
        "longitude": 151.2127,
        "suburb": "Surry Hills",
        "notes": "Reviewer demo stop — feel free to delete.",
    },
    {
        "address": "240 King St, Newtown NSW 2042",
        "name": "Demo · Newtown Hub",
        "latitude": -33.8961,
        "longitude": 151.1797,
        "suburb": "Newtown",
        "notes": "Reviewer demo stop — feel free to delete.",
    },
    {
        "address": "Campbell Parade, Bondi Beach NSW 2026",
        "name": "Demo · Bondi Beach",
        "latitude": -33.8915,
        "longitude": 151.2767,
        "suburb": "Bondi Beach",
        "notes": "Reviewer demo stop — feel free to delete.",
    },
    {
        "address": "1-25 Harbour St, Sydney NSW 2000",
        "name": "Demo · Darling Harbour",
        "latitude": -33.8737,
        "longitude": 151.1996,
        "suburb": "Sydney",
        "notes": "Reviewer demo stop — feel free to delete.",
    },
]


async def _seed_reviewer_demo_route(db, user_id: str) -> None:
    """Insert the demo stops for a brand-new reviewer account so the
    Google Play reviewer sees a working route immediately on first
    sign-in. Idempotent: skips if any stop already exists for the user.
    """
    existing = await db.stops.find_one({"user_id": user_id}, {"_id": 0, "id": 1})
    if existing:
        return  # account already has stops; don't double-seed.

    now = datetime.now(timezone.utc)
    docs = []
    for order, demo in enumerate(_REVIEWER_DEMO_STOPS):
        docs.append({
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "address": demo["address"],
            "name": demo["name"],
            "suburb": demo["suburb"],
            "latitude": demo["latitude"],
            "longitude": demo["longitude"],
            "priority": "medium",
            "notes": demo["notes"],
            "delivery_status": "pending",
            "completed": False,
            "order": order,
            "created_at": now,
        })
    await db.stops.insert_many(docs)
    logger.info("Seeded %d demo stops for reviewer user_id=%s", len(docs), user_id)


class SessionDataResponse(BaseModel):
    id: str
    email: str
    name: str
    picture: Optional[str] = None
    session_token: str


@router.post("/auth/session")
async def exchange_session(request: Request, response: Response):
    """Exchange `X-Session-ID` for user data + persistent session cookie."""
    # Imported lazily to avoid a circular import at module load time.
    from server import db, User  # noqa: F401  (User kept for type clarity)

    session_id = request.headers.get("X-Session-ID")
    if not session_id:
        raise HTTPException(status_code=400, detail="Missing X-Session-ID header")

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Retry once on 5xx — production pods briefly 502 during LKH
        # compile restarts. A single retry 1.5s later catches >90% of
        # transient gateway errors the user sees as "502" on login.
        for attempt in range(2):
            try:
                auth_response = await client.get(
                    "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data",
                    headers={"X-Session-ID": session_id},
                )
                if auth_response.status_code < 500:
                    break  # Success or client error (4xx) — don't retry
                if attempt == 0:
                    import asyncio as _auth_asyncio
                    logger.warning(
                        "[auth] demobackend returned %s on attempt 1, retrying in 1.5s",
                        auth_response.status_code,
                    )
                    await _auth_asyncio.sleep(1.5)
            except HTTPException:
                raise
            except Exception as e:
                if attempt == 0:
                    import asyncio as _auth_asyncio
                    logger.warning("[auth] exchange attempt 1 failed (%s), retrying", e)
                    await _auth_asyncio.sleep(1.5)
                    continue
                err_class = type(e).__name__
                logger.error("[auth] exchange exception (%s): %s", err_class, e)
                raise HTTPException(
                    status_code=401,
                    detail=f"Authentication failed ({err_class})",
                )

        if auth_response.status_code != 200:
            upstream_status = auth_response.status_code
            logger.warning(
                "[auth] demobackend returned %s for session-id exchange "
                "(session_id_len=%d)",
                upstream_status, len(session_id or ""),
            )
            raise HTTPException(
                status_code=401,
                detail=f"Invalid session (upstream {upstream_status})",
            )
        user_data = auth_response.json()

    session_data = SessionDataResponse(**user_data)

    existing_user = await db.users.find_one({"email": session_data.email}, {"_id": 0})

    if SIGNUPS_DISABLED and not existing_user:
        # Check if the user has been approved on the waitlist.
        from routes.waitlist import is_waitlist_approved, add_to_waitlist

        approved = False
        try:
            approved = await is_waitlist_approved(db, session_data.email)
        except Exception:
            logger.exception("Waitlist approval check failed for %s", session_data.email)

        if not approved:
            logger.warning("Blocked signup (waitlist gate): %s", session_data.email)
            # Auto-add to waitlist as pending
            try:
                await add_to_waitlist(
                    db,
                    email=session_data.email,
                    name=getattr(session_data, "name", ""),
                    source="google_login_gate",
                )
            except Exception:
                logger.exception("Failed to add %s to waitlist", session_data.email)

            raise HTTPException(
                status_code=403,
                detail="Signups are currently closed. You've been added to the waitlist and will be notified when a spot opens.",
            )
        # Approved on waitlist — allow signup to proceed.
        logger.info("Waitlist-approved user signing up: %s", session_data.email)

    if ALLOWED_USERS and session_data.email not in ALLOWED_USERS:
        if not existing_user:
            logger.warning(f"Blocked non-whitelisted user: {session_data.email}")
            raise HTTPException(
                status_code=403,
                detail="Access denied. Your email is not authorized to use this application.",
            )

    if existing_user:
        user_id = existing_user["user_id"]
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        await db.users.insert_one({
            "user_id": user_id,
            "email": session_data.email,
            "name": session_data.name,
            "picture": session_data.picture,
            "created_at": datetime.now(timezone.utc),
        })
        # Google Play reviewer accounts get a pre-seeded Sydney CBD demo
        # route so the reviewer can immediately verify optimization/ML
        # without manually adding stops. Idempotent + no-op for everyone
        # else.
        if session_data.email.lower() in _REVIEWER_EMAILS:
            try:
                await _seed_reviewer_demo_route(db, user_id)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Failed to seed reviewer demo route for user_id=%s", user_id,
                )

    expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": session_data.session_token,
        "expires_at": expires_at,
        "created_at": datetime.now(timezone.utc),
    })

    response.set_cookie(
        key="session_token",
        value=session_data.session_token,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
        max_age=7 * 24 * 60 * 60,
    )

    return {
        "user_id": user_id,
        "email": session_data.email,
        "name": session_data.name,
        "picture": session_data.picture,
        "session_token": session_data.session_token,
    }


@router.get("/auth/me")
async def get_me(request: Request):
    from server import get_current_user
    current_user = await get_current_user(request)
    return current_user


# Passcode for the no-Google reviewer-login endpoint. Strong random value
# set in backend/.env. Empty/unset disables the endpoint entirely (503).
_REVIEWER_PASSCODE = _auth_os.environ.get("REVIEWER_PASSCODE", "")


class ReviewerLoginRequest(BaseModel):
    email: str
    passcode: str


@router.post("/auth/reviewer-login")
async def reviewer_login(body: ReviewerLoginRequest, response: Response):
    """No-Google sign-in for Google Play Store reviewers.

    Bypasses the Emergent → Google OAuth round-trip so reviewers don't
    need a captcha-walled Gmail account during app review. Gated by:

    1. `REVIEWER_PASSCODE` env var must be set (no env, no endpoint).
    2. `email` must be in `REVIEWER_EMAILS` (the same allowlist used by
       `routes/billing.py` to grant the Pro paywall bypass).
    3. `passcode` must match `REVIEWER_PASSCODE` exactly.

    Creates the user record + session_token + (on first login) the
    Sydney demo route. Returns the same shape as `/auth/session` so the
    frontend `AuthContext.login` flow can consume it without branching.
    """
    from server import db  # noqa: WPS433

    if not _REVIEWER_PASSCODE:
        raise HTTPException(
            status_code=503,
            detail="Reviewer login not configured (REVIEWER_PASSCODE unset).",
        )

    email = (body.email or "").strip().lower()
    if email not in _REVIEWER_EMAILS:
        # Same 401 message for "wrong email" + "wrong passcode" so a
        # random caller can't enumerate the allowlist.
        raise HTTPException(status_code=401, detail="Invalid reviewer credentials")
    if body.passcode != _REVIEWER_PASSCODE:
        raise HTTPException(status_code=401, detail="Invalid reviewer credentials")

    existing_user = await db.users.find_one({"email": email}, {"_id": 0})
    if existing_user:
        user_id = existing_user["user_id"]
        name = existing_user.get("name") or "Play Reviewer"
        picture = existing_user.get("picture")
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        name = "Play Reviewer"
        picture = None
        await db.users.insert_one({
            "user_id": user_id,
            "email": email,
            "name": name,
            "picture": picture,
            "created_at": datetime.now(timezone.utc),
        })
        # First-login demo seed — same idempotent helper as /auth/session.
        try:
            await _seed_reviewer_demo_route(db, user_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Failed to seed reviewer demo route for user_id=%s", user_id,
            )

    # Mint a fresh 7-day session token. Format mirrors the Emergent
    # session_token (opaque hex), so downstream code that just round-trips
    # the string doesn't care that it didn't come from Google.
    session_token = f"rvw_{uuid.uuid4().hex}{uuid.uuid4().hex}"
    expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": session_token,
        "expires_at": expires_at,
        "created_at": datetime.now(timezone.utc),
    })

    response.set_cookie(
        key="session_token",
        value=session_token,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
        max_age=7 * 24 * 60 * 60,
    )

    return {
        "user_id": user_id,
        "email": email,
        "name": name,
        "picture": picture,
        "session_token": session_token,
    }


@router.post("/auth/logout")
async def logout(request: Request, response: Response):
    from server import db, get_session_from_request
    session = await get_session_from_request(request)
    if session:
        await db.user_sessions.delete_one({"session_token": session.session_token})
    response.delete_cookie(key="session_token", path="/")
    return {"message": "Logged out successfully"}


# ── Email/Password Authentication (fallback for when Google OAuth fails) ──
# Uses bcrypt for password hashing, same session_token pattern as Google flow.
# Users created via email/password have provider="local" and hashed_password set.
# Users created via Google have provider="google" and hashed_password=None.
# A Google user can later set a password (via /auth/set-password) to enable
# the email/password fallback for their account.

import bcrypt as _bcrypt


class EmailRegisterRequest(BaseModel):
    email: str
    password: str
    name: str = ""


class EmailLoginRequest(BaseModel):
    email: str
    password: str


class SetPasswordRequest(BaseModel):
    password: str


def _hash_password(plain: str) -> str:
    """Hash a plaintext password with bcrypt."""
    return _bcrypt.hashpw(plain.encode("utf-8"), _bcrypt.gensalt(12)).decode("utf-8")


def _verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against a bcrypt hash."""
    try:
        return _bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


@router.post("/auth/register-email")
async def register_email(body: EmailRegisterRequest, response: Response):
    """Register a new account with email + password.

    Creates the user in MongoDB with provider="local" and a bcrypt-hashed
    password. Returns a session_token just like the Google flow so the
    frontend can use the same auth logic for both paths.
    """
    from server import db

    email = body.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email address")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    # Check if user already exists
    existing = await db.users.find_one({"email": email}, {"_id": 0, "user_id": 1, "provider": 1})
    if existing:
        if existing.get("provider") == "google":
            raise HTTPException(
                status_code=409,
                detail="This email is registered via Google. Use Google sign-in, or tap 'Set Password' in your profile to enable email login.",
            )
        raise HTTPException(status_code=409, detail="An account with this email already exists. Try logging in.")

    # Waitlist gate (same logic as Google flow)
    if SIGNUPS_DISABLED:
        from routes.waitlist import is_waitlist_approved, add_to_waitlist
        approved = await is_waitlist_approved(db, email)
        if not approved:
            await add_to_waitlist(db, email=email, name=body.name, source="email_register")
            raise HTTPException(
                status_code=403,
                detail="Signups are currently closed. You've been added to the waitlist.",
            )

    # Create user
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc)
    user_doc = {
        "user_id": user_id,
        "email": email,
        "name": body.name.strip() or email.split("@")[0],
        "picture": None,
        "provider": "local",
        "hashed_password": _hash_password(body.password),
        "created_at": now,
    }
    await db.users.insert_one(user_doc)
    logger.info("[auth] Email registration: %s (user_id=%s)", email, user_id)

    # Create session (same as Google flow)
    session_token = f"ses_{uuid.uuid4().hex}"
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": session_token,
        "expires_at": now + timedelta(days=7),
        "created_at": now,
    })

    response.set_cookie(
        key="session_token",
        value=session_token,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
        max_age=7 * 24 * 60 * 60,
    )

    return {
        "user_id": user_id,
        "email": email,
        "name": user_doc["name"],
        "session_token": session_token,
    }


@router.post("/auth/login-email")
async def login_email(body: EmailLoginRequest, response: Response):
    """Login with email + password.

    Returns a session_token just like the Google flow. If the user was
    originally created via Google and hasn't set a password, they'll get
    a helpful error directing them to use Google sign-in.
    """
    from server import db

    email = body.email.strip().lower()
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    hashed = user.get("hashed_password")
    if not hashed:
        # Google-only account without a password set
        raise HTTPException(
            status_code=401,
            detail="This account uses Google sign-in. Tap 'Continue with Google' or set a password first.",
        )

    if not _verify_password(body.password, hashed):
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    # Create session
    user_id = user["user_id"]
    now = datetime.now(timezone.utc)
    session_token = f"ses_{uuid.uuid4().hex}"
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": session_token,
        "expires_at": now + timedelta(days=7),
        "created_at": now,
    })

    logger.info("[auth] Email login: %s (user_id=%s)", email, user_id)

    response.set_cookie(
        key="session_token",
        value=session_token,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
        max_age=7 * 24 * 60 * 60,
    )

    return {
        "user_id": user_id,
        "email": email,
        "name": user.get("name", ""),
        "session_token": session_token,
    }


@router.post("/auth/set-password")
async def set_password(body: SetPasswordRequest, request: Request):
    """Allow a Google user to set a password for email/password fallback.

    Requires an active session (the user must be logged in via Google).
    """
    from server import db, get_current_user

    current_user = await get_current_user(request)
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    await db.users.update_one(
        {"user_id": current_user.user_id},
        {"$set": {"hashed_password": _hash_password(body.password)}},
    )
    logger.info("[auth] Password set for user=%s", current_user.user_id)
    return {"message": "Password set successfully. You can now use email + password to sign in."}
