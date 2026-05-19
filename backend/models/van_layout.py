"""Van layout grid (driver's saved A1/B2/C3-style cubby map)."""
from __future__ import annotations

from pydantic import BaseModel


class VanLayout(BaseModel):
    rows: int  # 2 or 3 — A, B (, C)
    cols: int  # 3 or 4 — 1, 2, 3 (, 4)
