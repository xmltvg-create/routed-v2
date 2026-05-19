"""Generoute API request models — for the external Generoute optimisation
service we hand off to as one of the algorithm choices."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class GenerouteLocation(BaseModel):
    """Location model for Generoute API"""
    coordinates: List[float]  # [longitude, latitude]
    title: Optional[str] = ""
    data: Optional[Dict[str, Any]] = None


class GenerouteRequest(BaseModel):
    """Request model for Generoute API"""
    region: str = "AU"  # Country code
    locations: List[GenerouteLocation]
