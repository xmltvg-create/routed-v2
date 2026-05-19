"""Pydantic data models extracted from server.py.

This package is the single source of truth for request/response and
domain shapes. server.py re-exports everything from here so legacy
imports (`from server import Stop, StopUpdate, ...`) keep working
during the gradual decomposition — see
backend/models/__init__.py for the full re-export surface.

Why split this out: server.py was >8,000 lines, half of which was
data shape boilerplate. Models are leaf-level dependencies (no DB,
no FastAPI, no auth) so they're the safest first slice to peel off.
"""
from __future__ import annotations

# Re-export everything from the per-domain submodules so callers can
# either:
#   from models import Stop, StopUpdate
#   from models.stops import Stop, StopUpdate
# whichever they prefer. No behaviour difference.
from .auth import User, UserSession  # noqa: F401
from .stops import (  # noqa: F401
    TimeWindow,
    GeocodeCacheEntry,
    Stop,
    StopCreate,
    StopUpdate,
    RegeocodeStopRequest,
    RegeocodeStopResponse,
    CarStopActionRequest,
    FieldMapping,
    ImportPreviewResponse,
    ImportResult,
    ReorderRequest,
)
from .routes import Route  # noqa: F401
from .alerts import (  # noqa: F401
    AlertType,
    MapAlert,
    AlertCreate,
    AlertResponse,
)
from .generoute import GenerouteLocation, GenerouteRequest  # noqa: F401
from .optimize import (  # noqa: F401
    OptimizationHub,
    RefinementSection,
    OptimizationRequest,
    TightenClusterRequest,
    BenchmarkRequest,
)
from .van_layout import VanLayout  # noqa: F401
