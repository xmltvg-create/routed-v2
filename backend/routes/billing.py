"""Stripe subscription billing — Pro paywall for RouTeD.

Owns `/api/billing/{checkout,portal,status,webhook}` plus the
`require_pro` FastAPI dependency that other modules import to gate
expensive endpoints (currently `/api/optimize/jobs`).

Why this lives in its own module
--------------------------------
* server.py is already ~9 200 lines; adding 400 more lines for billing
  is the kind of thing that makes the file impossible to context-load
  on a fresh agent run.
* All billing logic is naturally cohesive (one Stripe client, one
  MongoDB collection, one webhook handler), so the module boundary is
  clean.
* Imports the live `db` handle from server so we share the same Mongo
  client/event loop binding. Importing here avoids the circular dep
  trap because `server` finishes binding `db` at import time (line ~340)
  long before this router is included (line ~9 200).

Data model
----------
Collection: `subscriptions` (one doc per user)
  {
    "user_id": str,                       # canonical user id from auth.py
    "email": str,
    "stripe_customer_id": str,            # "cus_..."
    "stripe_subscription_id": str | None, # "sub_..."  (None pre-checkout)
    "status": str,                        # trialing|active|past_due|canceled|incomplete
    "plan_id": str,                       # "monthly" | "annual"
    "current_period_end": int | None,     # unix seconds
    "trial_end": int | None,
    "pro_flag": bool,                     # convenience; True iff status in {trialing, active}
    "created_at": ISO str,
    "updated_at": ISO str,
  }

Collection: `processed_webhook_events` (idempotency guard)
  { "stripe_event_id": str, "created_at": ISO str }  # TTL: 30 d

Env vars (read at module import — fail fast if Stripe key absent)
-----------------------------------------------------------------
* STRIPE_API_KEY              — sk_test_... / sk_live_...
* STRIPE_PRICE_MONTHLY        — price_... (monthly recurring)
* STRIPE_PRICE_ANNUAL         — price_... (annual recurring)
* STRIPE_WEBHOOK_SECRET       — whsec_... (signature verification)
* STRIPE_ADMIN_USER_IDS       — comma-separated user_ids that bypass
                                the paywall (owner/dev accounts).
                                Empty/unset = no admins.
* STRIPE_CHECKOUT_SUCCESS_URL — where Checkout returns on success
* STRIPE_CHECKOUT_CANCEL_URL  — where Checkout returns on cancel
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

logger = logging.getLogger("server")
router = APIRouter(prefix="/billing", tags=["billing"])

# ── Stripe client config ─────────────────────────────────────────────
# Initialised at import. If STRIPE_API_KEY is missing we still load the
# module (so `require_pro` can still gate based on existing MongoDB
# subscription records), but checkout/portal endpoints will return 503.
STRIPE_API_KEY = os.environ.get("STRIPE_API_KEY", "")
if STRIPE_API_KEY:
    stripe.api_key = STRIPE_API_KEY
else:
    logger.warning("STRIPE_API_KEY not set — billing checkout/portal endpoints will 503.")

STRIPE_PRICE_MONTHLY = os.environ.get("STRIPE_PRICE_MONTHLY", "")
STRIPE_PRICE_ANNUAL = os.environ.get("STRIPE_PRICE_ANNUAL", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_CHECKOUT_SUCCESS_URL = os.environ.get(
    "STRIPE_CHECKOUT_SUCCESS_URL",
    "https://floating-map-ui.emergent.host/billing/success",
)
STRIPE_CHECKOUT_CANCEL_URL = os.environ.get(
    "STRIPE_CHECKOUT_CANCEL_URL",
    "https://floating-map-ui.emergent.host/billing/cancel",
)

# Admin allowlist — comma-separated user_ids that bypass the paywall.
# Used for the owner/developer accounts so they never get locked out
# during their own subscription's trial gap or a card decline.
_admin_csv = os.environ.get("STRIPE_ADMIN_USER_IDS", "")
ADMIN_USER_IDS = {u.strip() for u in _admin_csv.split(",") if u.strip()}

# Reviewer allowlist — comma-separated EMAILS that bypass the paywall.
# Use this for Google Play reviewers and any app-review tester accounts.
# Email-based (not user_id) because the reviewer's user_id isn't known
# until they sign in once via Google OAuth.
#
# Example value in backend/.env:
#   REVIEWER_EMAILS=routedreviewer@gmail.com,playreviewer@example.com
_reviewer_csv = os.environ.get("REVIEWER_EMAILS", "")
REVIEWER_EMAILS = {e.strip().lower() for e in _reviewer_csv.split(",") if e.strip()}

# Statuses that count as "Pro" (full access). past_due users get a few
# days of grace from Stripe before status flips to canceled, and we
# defer to Stripe's lifecycle — we don't yank access mid-shift.
_PRO_STATUSES = {"trialing", "active", "past_due"}

# Plan id → Stripe price id mapping. Empty mapping if not configured.
_PLAN_TO_PRICE: dict[str, str] = {}
if STRIPE_PRICE_MONTHLY:
    _PLAN_TO_PRICE["monthly"] = STRIPE_PRICE_MONTHLY
if STRIPE_PRICE_ANNUAL:
    _PLAN_TO_PRICE["annual"] = STRIPE_PRICE_ANNUAL


# ── Pydantic schemas ────────────────────────────────────────────────
class CheckoutRequest(BaseModel):
    plan_id: str = Field(..., pattern="^(monthly|annual)$")


class CheckoutResponse(BaseModel):
    checkout_url: str
    session_id: str


class PortalResponse(BaseModel):
    portal_url: str


class SubscriptionStatusResponse(BaseModel):
    pro: bool
    status: Optional[str]          # null for never-subscribed users
    plan_id: Optional[str]
    trial_end: Optional[int]
    current_period_end: Optional[int]
    is_admin: bool
    available_plans: dict[str, dict[str, str]]  # {plan_id: {price_id, label, ...}}


# ── DB helpers ─────────────────────────────────────────────────────
async def _ensure_indexes(db) -> None:
    """Idempotent index creation. Called from server startup."""
    await db.subscriptions.create_index("user_id", unique=True)
    await db.subscriptions.create_index("stripe_customer_id", unique=True, sparse=True)
    await db.subscriptions.create_index("stripe_subscription_id", sparse=True)
    # TTL: prune processed webhook event records after 30 days.
    await db.processed_webhook_events.create_index("stripe_event_id", unique=True)
    await db.processed_webhook_events.create_index(
        "created_at", expireAfterSeconds=30 * 24 * 3600
    )


async def _get_subscription(db, user_id: str) -> Optional[dict]:
    """Lookup a subscription doc by user_id. Returns None if absent."""
    return await db.subscriptions.find_one({"user_id": user_id}, {"_id": 0})


async def _upsert_subscription(db, doc: dict) -> None:
    """Replace the user's subscription doc atomically. Used by the
    webhook handler after every Stripe lifecycle event."""
    doc["updated_at"] = datetime.now(timezone.utc).isoformat()
    doc.setdefault("created_at", doc["updated_at"])
    await db.subscriptions.update_one(
        {"user_id": doc["user_id"]},
        {"$set": doc},
        upsert=True,
    )


# ── require_pro dependency ────────────────────────────────────────
# Imported by other modules to gate expensive endpoints. The dependency
# allows the request through iff:
#   1. current_user.user_id is in ADMIN_USER_IDS, OR
#   2. there's a subscription record with status in {trialing, active, past_due}.
# Otherwise raises 402 Payment Required with an upgrade URL the
# frontend can deep-link to.
#
# Implementation note: we import server.db / get_current_user / User
# inside the function (not at module top) to avoid a circular import.
# server.py imports this module before its own `db` and auth helpers
# are defined; deferring those lookups to request time sidesteps that.
async def require_pro(request: Request):
    """FastAPI dependency: 402 unless the caller is an admin or has an
    active/trialing/past_due subscription."""
    # Lazy imports — see comment above. By the time a request hits this
    # dependency, server.py is fully loaded and these names exist.
    from server import db, get_current_user
    current_user = await get_current_user(request)
    if current_user.user_id in ADMIN_USER_IDS:
        return current_user
    if (current_user.email or "").lower() in REVIEWER_EMAILS:
        return current_user
    sub = await _get_subscription(db, current_user.user_id)
    if sub and sub.get("status") in _PRO_STATUSES:
        return current_user
    # Payment Required. Frontend reads `detail.upgrade_required`.
    raise HTTPException(
        status_code=status.HTTP_402_PAYMENT_REQUIRED,
        detail={
            "code": "subscription_required",
            "message": (
                "This feature is available on the Pro plan. "
                "Start your 7-day free trial — no card charged "
                "until the trial ends."
            ),
            "upgrade_required": True,
            "checkout_endpoint": "/api/billing/checkout",
        },
    )


# Backwards-compat alias for any caller that imports the factory shape.
def make_require_pro():
    return require_pro


# ── Endpoints ──────────────────────────────────────────────────────
@router.get("/status", response_model=SubscriptionStatusResponse)
async def get_billing_status(request: Request):
    """Return the caller's current subscription state. Used by the
    Billing screen to show the right CTA (Upgrade vs Manage)."""
    from server import db, get_current_user
    current_user = await get_current_user(request)

    sub = await _get_subscription(db, current_user.user_id)
    is_admin = current_user.user_id in ADMIN_USER_IDS
    is_reviewer = (current_user.email or "").lower() in REVIEWER_EMAILS

    # Even if no subscription exists yet, admins/reviewers get pro=True.
    pro = is_admin or is_reviewer or (sub is not None and sub.get("status") in _PRO_STATUSES)

    return SubscriptionStatusResponse(
        pro=pro,
        status=sub.get("status") if sub else None,
        plan_id=sub.get("plan_id") if sub else None,
        trial_end=sub.get("trial_end") if sub else None,
        current_period_end=sub.get("current_period_end") if sub else None,
        is_admin=is_admin,
        available_plans={
            "monthly": {
                "price_id": STRIPE_PRICE_MONTHLY or "not_configured",
                "label": "Pro Monthly",
                "amount_display": "$9.99 / month",
                "trial_days": "7",
            },
            "annual": {
                "price_id": STRIPE_PRICE_ANNUAL or "not_configured",
                "label": "Pro Annual",
                "amount_display": "$79 / year",
                "trial_days": "7",
            },
        },
    )


@router.post("/checkout", response_model=CheckoutResponse)
async def create_checkout_session(request: Request, body: CheckoutRequest):
    """Create a Stripe Checkout session for the caller and return the
    hosted-Checkout URL. Frontend opens it in a WebView; on success
    Stripe POSTs `checkout.session.completed` to /billing/webhook which
    writes the subscription doc."""
    from server import db, get_current_user
    current_user = await get_current_user(request)

    if not STRIPE_API_KEY:
        raise HTTPException(503, detail="Billing not configured: STRIPE_API_KEY missing")
    price_id = _PLAN_TO_PRICE.get(body.plan_id)
    if not price_id:
        raise HTTPException(
            503,
            detail=f"Billing not configured: STRIPE_PRICE_{body.plan_id.upper()} missing",
        )

    # Reuse existing Stripe customer id if we already have one (avoids
    # creating duplicate cus_... rows on re-attempts after a cancel).
    existing = await _get_subscription(db, current_user.user_id)
    customer_id = existing.get("stripe_customer_id") if existing else None

    try:
        session_kwargs = {
            "mode": "subscription",
            "payment_method_types": ["card"],
            "line_items": [{"price": price_id, "quantity": 1}],
            "subscription_data": {
                "trial_period_days": 7,
                "metadata": {
                    "user_id": current_user.user_id,
                    "plan_id": body.plan_id,
                },
            },
            "success_url": f"{STRIPE_CHECKOUT_SUCCESS_URL}?session_id={{CHECKOUT_SESSION_ID}}",
            "cancel_url": STRIPE_CHECKOUT_CANCEL_URL,
            "metadata": {
                "user_id": current_user.user_id,
                "plan_id": body.plan_id,
            },
            # Lets Stripe collect the billing address (needed for tax
            # in many jurisdictions even at $9.99/mo). Customer-portal
            # later edits it.
            "billing_address_collection": "auto",
        }
        if customer_id:
            session_kwargs["customer"] = customer_id
        else:
            # New customer — Stripe creates a cus_... on completion.
            # We seed the email so the receipt looks right.
            session_kwargs["customer_email"] = current_user.email

        session = stripe.checkout.Session.create(**session_kwargs)
    except stripe.error.StripeError as e:
        logger.exception("Stripe checkout session creation failed")
        raise HTTPException(502, detail=f"Stripe error: {str(e)}")

    return CheckoutResponse(checkout_url=session.url, session_id=session.id)


@router.post("/portal", response_model=PortalResponse)
async def create_portal_session(request: Request):
    """Open the Stripe customer-portal so the user can switch plans,
    update card, or cancel. Frontend opens the returned URL in a WebView."""
    from server import db, get_current_user
    current_user = await get_current_user(request)

    if not STRIPE_API_KEY:
        raise HTTPException(503, detail="Billing not configured: STRIPE_API_KEY missing")

    sub = await _get_subscription(db, current_user.user_id)
    if not sub or not sub.get("stripe_customer_id"):
        raise HTTPException(404, detail="No subscription on file — start one via /billing/checkout")

    try:
        portal = stripe.billing_portal.Session.create(
            customer=sub["stripe_customer_id"],
            return_url=STRIPE_CHECKOUT_SUCCESS_URL,
        )
    except stripe.error.StripeError as e:
        logger.exception("Stripe portal session creation failed")
        raise HTTPException(502, detail=f"Stripe error: {str(e)}")

    return PortalResponse(portal_url=portal.url)


# ── Webhook ────────────────────────────────────────────────────────
#
# Stripe → POST /api/billing/webhook (raw bytes, signed via stripe-signature
# header). MUST verify signature before parsing, MUST be idempotent
# (Stripe retries up to 3 days on 5xx).
#
# Events we handle:
#   * checkout.session.completed     — initial subscription created
#   * customer.subscription.updated  — status / plan / period changes
#   * customer.subscription.deleted  — cancellation finalised
#
# Anything else returns 200 (Stripe is happy) without touching Mongo.

async def _handle_subscription_lifecycle_event(db, stripe_sub: dict) -> None:
    """Shared logic for checkout.session.completed + subscription.{updated,deleted}.

    `stripe_sub` is a Stripe Subscription object dict (NOT the raw event)
    with the metadata block populated (it carries user_id + plan_id from
    the original Checkout session).
    """
    metadata = stripe_sub.get("metadata") or {}
    user_id = metadata.get("user_id")
    plan_id = metadata.get("plan_id")
    if not user_id:
        logger.warning(
            "Subscription event missing user_id metadata; sub_id=%s",
            stripe_sub.get("id"),
        )
        return

    status_str = stripe_sub.get("status")  # "active" | "trialing" | "canceled" | ...
    doc = {
        "user_id": user_id,
        "stripe_customer_id": stripe_sub.get("customer"),
        "stripe_subscription_id": stripe_sub.get("id"),
        "status": status_str,
        "plan_id": plan_id,
        "current_period_end": stripe_sub.get("current_period_end"),
        "trial_end": stripe_sub.get("trial_end"),
        "pro_flag": status_str in _PRO_STATUSES,
    }
    # Pull email if available — preferred from subscription, fall back to
    # the existing record. (Stripe doesn't expose email on the subscription
    # object directly; the Checkout-completed event has customer_details.)
    if stripe_sub.get("_email_hint"):
        doc["email"] = stripe_sub["_email_hint"]
    await _upsert_subscription(db, doc)
    logger.info(
        "Subscription upserted: user_id=%s plan=%s status=%s",
        user_id, plan_id, status_str,
    )


@router.post("/webhook")
async def stripe_webhook(request: Request):
    """Stripe webhook receiver — verifies signature, deduplicates events,
    applies subscription state changes to MongoDB.

    Always returns 200 to Stripe unless signature verification fails
    (400). Internal errors are logged but acknowledged so Stripe doesn't
    spam retries; manual replay via Stripe Dashboard is the recovery path.
    """
    from server import db

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    if not STRIPE_WEBHOOK_SECRET:
        # No secret configured → reject everything. Better than silently
        # trusting unsigned events.
        logger.error("Webhook rejected: STRIPE_WEBHOOK_SECRET not configured")
        raise HTTPException(503, detail="Webhook secret not configured")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, STRIPE_WEBHOOK_SECRET
        )
    except ValueError:
        raise HTTPException(400, detail="Invalid payload")
    except stripe.error.SignatureVerificationError:
        raise HTTPException(400, detail="Invalid signature")

    event_id = event["id"]
    # Idempotency guard. The unique index on stripe_event_id makes the
    # insert atomic — if a concurrent retry races us, the second
    # insert raises DuplicateKeyError and we return 200 immediately.
    try:
        await db.processed_webhook_events.insert_one(
            {
                "stripe_event_id": event_id,
                "event_type": event["type"],
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        )
    except Exception:
        # Already processed — Stripe retried after we acked. No-op.
        logger.info("Webhook event %s already processed, skipping", event_id)
        return {"received": True, "duplicate": True}

    event_type = event["type"]
    data = event["data"]["object"]

    try:
        if event_type == "checkout.session.completed":
            # The Checkout session carries customer_email; fetch the full
            # subscription so we have status + period info.
            sub_id = data.get("subscription")
            email = (data.get("customer_details") or {}).get("email")
            if sub_id:
                sub_obj = stripe.Subscription.retrieve(sub_id)
                sub_dict = dict(sub_obj)
                if email:
                    sub_dict["_email_hint"] = email
                await _handle_subscription_lifecycle_event(db, sub_dict)

        elif event_type in ("customer.subscription.updated", "customer.subscription.created"):
            await _handle_subscription_lifecycle_event(db, dict(data))

        elif event_type == "customer.subscription.deleted":
            # Final cancellation — set status=canceled, pro_flag=False.
            sub_dict = dict(data)
            sub_dict["status"] = "canceled"
            await _handle_subscription_lifecycle_event(db, sub_dict)

        # Other events (invoice.*, payment_intent.*, etc.) are
        # acknowledged-but-ignored. Add handlers here as needed.
        else:
            logger.debug("Webhook event %s acknowledged but unhandled", event_type)

    except Exception as e:
        logger.exception("Webhook handler error for event %s: %s", event_id, e)
        # Still ack — Stripe Dashboard manual replay is the recovery path.

    return {"received": True, "type": event_type}
