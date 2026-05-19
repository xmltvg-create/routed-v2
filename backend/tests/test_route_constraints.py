"""Tests for local Sunshine Coast routing constraints.

Pinned to geometry/time-window logic — no network, no DB, runs in <0.1s so we
can keep it in the pre-commit suite.
"""
from datetime import datetime

import pytest

from routes._route_constraints import (
    is_in_school_zone,
    is_in_little_mountain,
    is_in_aroona,
    needs_sugar_bag_injection,
    inject_sugar_bag_waypoints,
    school_penalty_factor,
    apply_school_zone_penalty,
    parse_start_time,
    SUGAR_BAG_RD_WAYPOINT,
    SCHOOL_ZONE_BASE_PENALTY_SECONDS,
)


# ── Geometry classifiers ─────────────────────────────────────────────────────

def test_meridan_state_college_is_inside_school_zone():
    # Parklands Blvd / Meridan State College ~ -26.782, 153.088
    assert is_in_school_zone({"latitude": -26.782, "longitude": 153.088})


def test_aroona_stop_is_not_in_school_zone():
    # Aroona centroid — well east of the school corridor
    assert not is_in_school_zone({"latitude": -26.778, "longitude": 153.117})


def test_missing_coords_never_crash():
    assert is_in_school_zone({"latitude": None, "longitude": None}) is False
    assert is_in_school_zone({}) is False


def test_little_mountain_and_aroona_classifications():
    lm = {"latitude": -26.7844, "longitude": 153.0923}  # Little Mountain locality
    ar = {"latitude": -26.7830, "longitude": 153.1169}  # Aroona centroid
    assert is_in_little_mountain(lm)
    assert is_in_aroona(ar)


# ── Sugar Bag Rd injection ──────────────────────────────────────────────────

def test_injection_required_for_lm_to_aroona_leg():
    lm = {"latitude": -26.7844, "longitude": 153.0923}
    ar = {"latitude": -26.7830, "longitude": 153.1169}
    assert needs_sugar_bag_injection(lm, ar)
    assert needs_sugar_bag_injection(ar, lm)


def test_injection_not_required_for_intra_suburb_leg():
    a = {"latitude": -26.7830, "longitude": 153.1169}
    b = {"latitude": -26.7810, "longitude": 153.1190}  # both Aroona
    assert not needs_sugar_bag_injection(a, b)


def test_inject_waypoints_adds_one_midpoint_per_crossing():
    stops = [
        {"latitude": -26.7844, "longitude": 153.0923},  # Little Mountain
        {"latitude": -26.7830, "longitude": 153.1169},  # Aroona
        {"latitude": -26.7810, "longitude": 153.1190},  # Aroona (no injection)
        {"latitude": -26.7844, "longitude": 153.0923},  # back to LM (inject)
    ]
    coords = [f"{s['longitude']},{s['latitude']}" for s in stops]
    out = inject_sugar_bag_waypoints(coords, stops)
    # Two crossings → two injections → total = 4 + 2 = 6 coords
    assert len(out) == 6
    sb_coord = f"{SUGAR_BAG_RD_WAYPOINT[1]},{SUGAR_BAG_RD_WAYPOINT[0]}"
    assert out[1] == sb_coord
    assert out[4] == sb_coord


# ── School-window penalty math ───────────────────────────────────────────────

def test_penalty_is_max_inside_drop_off_window():
    # 08:30 Brisbane local
    dt = datetime(2026, 4, 24, 8, 30)
    assert school_penalty_factor(dt) == 1.0


def test_penalty_is_max_inside_pickup_window():
    dt = datetime(2026, 4, 24, 14, 45)
    assert school_penalty_factor(dt) == 1.0


def test_penalty_ramps_before_window():
    # 07:15 → 45 min before 08:00 window → ramp = (0.75) / 1.5 = 0.5
    dt = datetime(2026, 4, 24, 7, 15)
    factor = school_penalty_factor(dt)
    assert 0.45 < factor < 0.55


def test_penalty_is_zero_at_night():
    dt = datetime(2026, 4, 24, 22, 0)
    assert school_penalty_factor(dt) == 0.0


def test_none_start_time_returns_zero_penalty():
    assert school_penalty_factor(None) == 0.0


def test_apply_penalty_only_mutates_inbound_school_edges():
    stops = [
        {"latitude": -26.778, "longitude": 153.117},  # outside zone (Aroona)
        {"latitude": -26.782, "longitude": 153.088},  # INSIDE zone (Meridan school)
        {"latitude": -26.770, "longitude": 153.100},  # outside zone
    ]
    matrix = [[0, 100, 100], [100, 0, 100], [100, 100, 0]]
    apply_school_zone_penalty(matrix, stops, factor=1.0)
    extra = SCHOOL_ZONE_BASE_PENALTY_SECONDS
    # Inbound to stop 1 (school zone): rows 0 and 2, col 1 gain extra
    assert matrix[0][1] == 100 + extra
    assert matrix[2][1] == 100 + extra
    # Diagonal untouched
    assert matrix[1][1] == 0
    # Outbound from school stop (col 0 / col 2) unchanged
    assert matrix[1][0] == 100
    assert matrix[1][2] == 100


def test_apply_penalty_is_noop_when_factor_zero():
    stops = [{"latitude": -26.782, "longitude": 153.088}]
    matrix = [[0]]
    apply_school_zone_penalty(matrix, stops, factor=0.0)
    assert matrix == [[0]]


# ── ISO timestamp parsing ────────────────────────────────────────────────────

def test_parse_utc_iso_converts_to_brisbane_local():
    # 21:30 UTC == 07:30 next-day Brisbane (UTC+10)
    out = parse_start_time("2026-04-23T21:30:00Z")
    assert out is not None
    assert out.hour == 7 and out.minute == 30


def test_parse_garbage_returns_none():
    assert parse_start_time("not-a-date") is None
    assert parse_start_time(None) is None
    assert parse_start_time("") is None
