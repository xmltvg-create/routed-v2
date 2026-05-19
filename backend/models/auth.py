"""Auth domain models — kept tiny on purpose.

Only the fields the FastAPI dependency-injection chain reads off these
shapes (`User.user_id`, `User.email`, `UserSession.session_token`, …)
matter for downstream code. Any auth implementation detail (cookie
serialisation, JWT, refresh tokens) lives in routes/auth.py.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field


class User(BaseModel):
    user_id: str
    email: str
    name: str
    picture: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserSession(BaseModel):
    user_id: str
    session_token: str
    expires_at: datetime
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
