"""Local routing constraints for Sunshine Coast deliveries.

Two rules, both configured by the fleet owner after years of running this
territory:

1. **Meridan State College school zone** — Parklands Boulevard and the
   western edge of Little Mountain become a parking lot around drop-off
   (08:00-09:00) and pickup (14:30-15:30). If a stop inside this box has
   an ETA that lands in either window, we penalise the edges INTO that
   stop so the solver prefers to visit it outside the window.

2. **Sugar Bag Road shortcut** — the best way to connect Little Mountain
   to Aroona; bypasses the traffic-lighted Caloundra Road corridor. OSRM
   doesn't know about the fleet's preference, so we inject a mid-point
   waypoint on any Little-Mountain ↔ Aroona leg when rendering the
   directions geometry, which forces OSRM to route through Sugar Bag Rd.

All geometry constants are in decimal degrees (lat, lng). Keep them
loose rather than tight — false-positive suburb membership just triggers
the same preference the driver already wants.
"""
from __future__ import annotations
from datetime import datetime, time, timedelta, timezone
from typing import List, Tuple, Optional

# -----------------------------------------------------------------------------
# Geometry — simple axis-aligned bounding boxes. A polygon would be marginally
# more accurate on the west edge but the math cost isn't worth it; the boxes
# are conservatively drawn to include the problem corridors.
# -----------------------------------------------------------------------------

# Meridan Plains + western Little Mountain (Parklands Blvd + Caloundra Rd
# school-zone corridor around Meridan State College at ~-26.782, 153.088).
MERIDAN_SCHOOL_ZONE_BBOX = {
    "lat_min": -26.795,
    "lat_max": -26.755,
    "lng_min": 153.068,
    "lng_max": 153.098,
}

# Little Mountain suburb (used to detect LM ↔ Aroona legs for Sugar Bag injection).
LITTLE_MOUNTAIN_BBOX = {
    "lat_min": -26.790,
    "lat_max": -26.745,
    "lng_min": 153.080,
    "lng_max": 153.110,
}

# Aroona suburb (used together with LITTLE_MOUNTAIN_BBOX).
AROONA_BBOX = {
    "lat_min": -26.790,
    "lat_max": -26.755,
    "lng_min": 153.105,
    "lng_max": 153.130,
}

# Sugar Bag Rd midpoint — Sugarbag Rd Reservoir (water treatment plant) sits
# roughly in the middle of the road and forces OSRM onto Sugar Bag Rd instead
# of Caloundra Rd when inserted as a waypoint. Lat/lng from Wikipedia reservoir
# record cross-referenced against OSM.
SUGAR_BAG_RD_WAYPOINT: Tuple[float, float] = (-26.7848, 153.1150)  # (lat, lng)

# -----------------------------------------------------------------------------
# School-zone windows (local Brisbane time, no DST).
# -----------------------------------------------------------------------------

SCHOOL_WINDOWS: List[Tuple[time, time]] = [
    (time(8, 0), time(9, 0)),     # Drop-off
    (time(14, 30), time(15, 30)), # Pickup
]

# How far ahead of a window we start penalising (a driver who starts 1 h before
# drop-off is going to hit it regardless of order — we still want to cluster
# school-zone stops so they're visited AFTER the window clears).
PRE_WINDOW_LOOKBACK_HOURS = 1.5

# Base penalty in seconds we add to any edge whose destination stop is inside
# the school zone when the penalty factor is 1.0. 300 s = 5 min — heavy enough
# to shuffle the solver, light enough that a genuinely closer school-zone stop
# still gets visited before a farther one.
SCHOOL_ZONE_BASE_PENALTY_SECONDS = 300

# Distance-matrix equivalent of the duration penalty. Picked so that a solver
# reading a distance_matrix (meters) gets a comparable "5 extra minutes" nudge.
# 5 min × 40 km/h typical urban pace ≈ 3333 m. Used by algorithms that don't
# have a duration matrix (nearest_neighbor, two_opt, genetic, clarke_wright,
# ils, alns) — they would otherwise silently ignore the school-zone rule.
SCHOOL_ZONE_BASE_PENALTY_METERS = 3333


def _in_bbox(lat: float, lng: float, bbox: dict) -> bool:
    return (
        bbox["lat_min"] <= lat <= bbox["lat_max"]
        and bbox["lng_min"] <= lng <= bbox["lng_max"]
    )


def is_in_school_zone(stop: dict) -> bool:
    """True if the stop falls inside the Meridan/W-Little-Mountain penalty box."""
    lat = stop.get("latitude")
    lng = stop.get("longitude")
    if lat is None or lng is None:
        return False
    return _in_bbox(lat, lng, MERIDAN_SCHOOL_ZONE_BBOX)


def is_in_little_mountain(stop: dict) -> bool:
    lat, lng = stop.get("latitude"), stop.get("longitude")
    return lat is not None and lng is not None and _in_bbox(lat, lng, LITTLE_MOUNTAIN_BBOX)


def is_in_aroona(stop: dict) -> bool:
    lat, lng = stop.get("latitude"), stop.get("longitude")
    return lat is not None and lng is not None and _in_bbox(lat, lng, AROONA_BBOX)


def needs_sugar_bag_injection(a: dict, b: dict) -> bool:
    """True if the leg between stops a and b crosses from Little Mountain to
    Aroona (or vice-versa). Stops inside both bboxes (overlap area) don't
    qualify — they're already on Sugar Bag Rd's corridor.
    """
    a_lm, a_ar = is_in_little_mountain(a), is_in_aroona(a)
    b_lm, b_ar = is_in_little_mountain(b), is_in_aroona(b)
    # "A is unambiguously LM and B is unambiguously Aroona" (or the reverse).
    if (a_lm and not a_ar) and (b_ar and not b_lm):
        return True
    if (a_ar and not a_lm) and (b_lm and not b_ar):
        return True
    return False


def _time_to_hours(t: time) -> float:
    return t.hour + t.minute / 60 + t.second / 3600


def school_penalty_factor(start_dt: Optional[datetime]) -> float:
    """Return a float in [0, 1] describing how aggressively to avoid school
    zones given the driver's START time.

    Logic:
      * If start_time is NONE or sits fully outside any school window and
        its lookback band → 0 (no penalty, solver runs plain).
      * If start is INSIDE a school window → 1.0 (max penalty).
      * If start is within PRE_WINDOW_LOOKBACK_HOURS of a window start →
        linear ramp from 0 at lookback to 1.0 at the window opening. This
        captures "I'm leaving at 7:00 AM and will be in the zone during
        8-9 AM no matter how you shuffle things".
    """
    if start_dt is None:
        return 0.0
    h = _time_to_hours(start_dt.time())
    factor = 0.0
    for ws, we in SCHOOL_WINDOWS:
        ws_h, we_h = _time_to_hours(ws), _time_to_hours(we)
        if ws_h <= h <= we_h:
            return 1.0
        if (ws_h - PRE_WINDOW_LOOKBACK_HOURS) <= h < ws_h:
            ramp = (h - (ws_h - PRE_WINDOW_LOOKBACK_HOURS)) / PRE_WINDOW_LOOKBACK_HOURS
            factor = max(factor, ramp)
    return factor


def apply_school_zone_penalty(
    matrix: List[List[int]],
    stops: List[dict],
    factor: float,
    unit: str = "seconds",
) -> List[List[int]]:
    """Mutate `matrix` in-place to discourage edges entering school-zone stops.

    Returns the same matrix for chaining. Noop when factor <= 0 — cheap to
    call unconditionally from the optimize handler.

    unit: "seconds" for a duration matrix, "meters" for a distance matrix.
    Picks the right base penalty so both matrix types get an equivalent
    "5-minute nudge" at factor 1.0.
    """
    if factor <= 0:
        return matrix
    if unit == "meters":
        base = SCHOOL_ZONE_BASE_PENALTY_METERS
    else:
        base = SCHOOL_ZONE_BASE_PENALTY_SECONDS
    extra = int(base * factor)
    if extra <= 0:
        return matrix
    school_indices = {i for i, s in enumerate(stops) if is_in_school_zone(s)}
    if not school_indices:
        return matrix
    n = len(matrix)
    for i in range(n):
        for j in school_indices:
            if i == j:
                continue
            # Penalise the INBOUND edge — we want to make it expensive to
            # arrive at a school-zone stop, not to leave one.
            matrix[i][j] = matrix[i][j] + extra
    return matrix


def inject_sugar_bag_waypoints(coord_list: List[str], stops: List[dict]) -> List[str]:
    """Insert the Sugar Bag Rd waypoint into a `lng,lat` coord list between any
    consecutive stops that cross the Little Mountain ↔ Aroona boundary.

    Coord list format matches what /api/directions expects:
        ["lng1,lat1", "lng2,lat2", ...]
    """
    if len(coord_list) != len(stops) or len(stops) < 2:
        return coord_list
    sb_lng, sb_lat = SUGAR_BAG_RD_WAYPOINT[1], SUGAR_BAG_RD_WAYPOINT[0]
    sb_coord = f"{sb_lng},{sb_lat}"
    out: List[str] = [coord_list[0]]
    for i in range(1, len(stops)):
        if needs_sugar_bag_injection(stops[i - 1], stops[i]):
            out.append(sb_coord)
        out.append(coord_list[i])
    return out


def parse_start_time(raw: Optional[str]) -> Optional[datetime]:
    """Parse an ISO-8601 string into a naive local-time-equivalent datetime.

    The frontend sends `new Date().toISOString()` which is UTC. The school
    windows are expressed in Brisbane local time (UTC+10, no DST). We treat
    the incoming UTC time and add +10 hours so window comparisons line up.
    """
    if not raw:
        return None
    try:
        # Tolerate "Z" suffix — Python 3.10 needs "+00:00".
        cleaned = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone(timedelta(hours=10))).replace(tzinfo=None)
    return dt
