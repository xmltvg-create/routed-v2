"""Optimize/benchmark request shapes for the /api/optimize and
/api/optimize/benchmark endpoints. The actual algorithm dispatch and
solver bodies live in server.py for now (Phase 1 of the refactor).
"""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel


class OptimizationHub(BaseModel):
    """A waypoint that the route must pass through"""
    id: str
    latitude: float
    longitude: float
    order: int  # The order in which hubs should be visited


class RefinementSection(BaseModel):
    """A section of stops drawn using the lasso tool for route refinement"""
    id: int
    stop_ids: List[str]  # IDs of stops in this section


class OptimizationRequest(BaseModel):
    algorithm: str = "auto"  # auto, alns, ortools, nearest_neighbor, two_opt, simulated_annealing, genetic, clarke_wright, mapbox, generoute
    current_latitude: Optional[float] = None
    current_longitude: Optional[float] = None
    use_current_location: bool = True
    hubs: Optional[List[OptimizationHub]] = None  # Sequential waypoints for segmented optimization
    sections: Optional[List[RefinementSection]] = None  # Lasso-drawn sections for route refinement
    traffic_aware: bool = False  # Apply time-of-day traffic multipliers to duration matrix
    departure_hour: Optional[int] = None  # 0-23, defaults to current hour if traffic_aware=True
    start_time: Optional[str] = None  # ISO-8601 string (e.g. `new Date().toISOString()`) used for local school-zone avoidance


class TightenClusterRequest(BaseModel):
    suspect_id: str  # the stop's own UUID — the spike to relocate


class BenchmarkRequest(BaseModel):
    current_latitude: Optional[float] = None
    current_longitude: Optional[float] = None
    use_current_location: bool = False
    algorithms: Optional[List[str]] = None  # None = all local algorithms
