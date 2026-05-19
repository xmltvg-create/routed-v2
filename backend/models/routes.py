"""Route domain models — currently just the persisted route record."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from pydantic import BaseModel, Field


class Route(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    name: str
    stops: List[str]  # List of stop IDs in order
    total_distance: Optional[float] = None
    total_duration: Optional[float] = None
    optimized: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
