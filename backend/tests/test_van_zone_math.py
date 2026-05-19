"""Pytest-style tests for the van zone math util.
Mirror of frontend logic — exists so a refactor of the TS util doesn't
break the algorithm without us noticing.

Run via: cd /app/backend && pytest tests/test_van_zone_math.py
"""
from math import ceil


def get_zone_quadrant(original_sequence, total_route_stops):
    """Mirror of /app/frontend/src/utils/vanZone.ts:getVanZone."""
    if (
        original_sequence is None
        or total_route_stops is None
        or total_route_stops <= 0
        or original_sequence < 1
        or original_sequence > total_route_stops
    ):
        return 0
    q_size = ceil(total_route_stops / 4)
    q = ceil(original_sequence / q_size)
    return max(1, min(4, q))


def test_zone_100_stops_clean_quadrants():
    """100 stops divides evenly: 25 per quadrant."""
    for seq, expected_q in [(1, 1), (25, 1), (26, 2), (50, 2),
                             (51, 3), (75, 3), (76, 4), (100, 4)]:
        assert get_zone_quadrant(seq, 100) == expected_q, \
            f"seq={seq} → expected Q{expected_q}"


def test_zone_15_of_100_is_q1_per_spec():
    """The exact example from the user's spec: 100 stops, seq 15 → Front (Q1)."""
    assert get_zone_quadrant(15, 100) == 1


def test_zone_uneven_route_length():
    """102 stops: ceil(102/4)=26. Q1=1-26, Q2=27-52, Q3=53-78, Q4=79-102."""
    assert get_zone_quadrant(26, 102) == 1
    assert get_zone_quadrant(27, 102) == 2
    assert get_zone_quadrant(78, 102) == 3
    assert get_zone_quadrant(79, 102) == 4
    assert get_zone_quadrant(102, 102) == 4


def test_zone_tiny_route():
    """4 stops: 1-1, 2-2, 3-3, 4-4 (one per quadrant)."""
    assert get_zone_quadrant(1, 4) == 1
    assert get_zone_quadrant(2, 4) == 2
    assert get_zone_quadrant(3, 4) == 3
    assert get_zone_quadrant(4, 4) == 4


def test_zone_single_stop_is_q1():
    assert get_zone_quadrant(1, 1) == 1


def test_zone_invalid_inputs_collapse_to_zero():
    """Out-of-range / null inputs return 0 (Unknown) without throwing."""
    assert get_zone_quadrant(None, 100) == 0
    assert get_zone_quadrant(0, 100) == 0
    assert get_zone_quadrant(-5, 100) == 0
    assert get_zone_quadrant(101, 100) == 0
    assert get_zone_quadrant(1, 0) == 0
    assert get_zone_quadrant(1, -1) == 0
