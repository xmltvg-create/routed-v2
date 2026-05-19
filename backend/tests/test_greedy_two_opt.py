"""Unit tests for the `algorithm=greedy_2opt` branch added in
`/api/optimize` — exercises the NN→2-opt pipeline directly on the
underlying solver primitives so the test never has to round-trip
through HTTP / Mongo / OSRM. Goal: prove 2-opt polish strictly does
not regress the greedy solution and routinely improves it on
realistic interleave patterns.
"""
from __future__ import annotations

import math

from server import (
    solve_nearest_neighbor,
    two_opt_improve,
    _indices_by_identity,
)


def _haversine_km(a: dict, b: dict) -> float:
    R = 6371.0
    lat1, lon1 = math.radians(a["latitude"]), math.radians(a["longitude"])
    lat2, lon2 = math.radians(b["latitude"]), math.radians(b["longitude"])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def _path_km(stops: list[dict]) -> float:
    return sum(_haversine_km(stops[i], stops[i + 1]) for i in range(len(stops) - 1))


def _matrix(stops: list[dict]) -> list[list[float]]:
    """Real haversine duration matrix in seconds (km × 60 ≈ city driving)."""
    n = len(stops)
    mat = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i != j:
                mat[i][j] = _haversine_km(stops[i], stops[j]) * 60.0
    return mat


def _zigzag_stops(n: int) -> list[dict]:
    """n stops alternating between two parallel lines 0.01° apart in
    longitude and stepping linearly in latitude — classic interleave
    that greedy NN handles poorly but 2-opt should clean up."""
    out = []
    for i in range(n):
        out.append({
            "id": f"s{i}",
            "latitude": -26.7 + i * 0.001,
            "longitude": 153.10 + (0.0 if i % 2 == 0 else 0.01),
        })
    return out


def test_greedy_2opt_does_not_regress_greedy_only_on_clean_line():
    """When the input is already optimal (a straight line), 2-opt must
    not introduce any change — its purpose is improvement, not noise."""
    stops = [
        {"id": f"s{i}", "latitude": -26.7 + i * 0.005, "longitude": 153.10}
        for i in range(8)
    ]
    matrix = _matrix(stops)
    nn = solve_nearest_neighbor(matrix, stops, 0)
    nn_indices = _indices_by_identity(stops, nn)
    polished = two_opt_improve(nn_indices, matrix)
    polished_stops = [stops[i] for i in polished]
    assert _path_km(polished_stops) <= _path_km(nn) + 1e-9


def test_greedy_2opt_strictly_improves_zigzag():
    """Interleaved (zigzag) pattern is exactly the shape NN gets stuck
    on. 2-opt should strictly reduce path length."""
    stops = _zigzag_stops(12)
    matrix = _matrix(stops)
    nn = solve_nearest_neighbor(matrix, stops, 0)
    nn_indices = _indices_by_identity(stops, nn)
    polished_indices = two_opt_improve(nn_indices, matrix)
    polished_stops = [stops[i] for i in polished_indices]

    nn_km = _path_km(nn)
    polished_km = _path_km(polished_stops)

    # 2-opt has a chance to find at least one strict improvement on
    # an explicitly bad interleave. If it doesn't, our implementation
    # is broken or the pattern is too easy.
    assert polished_km < nn_km, (
        f"2-opt failed to improve a zigzag: {nn_km:.3f} km → {polished_km:.3f} km"
    )


def test_greedy_2opt_preserves_stop_set():
    """The polished route must still visit every input stop exactly
    once — 2-opt should never drop or duplicate a stop."""
    stops = _zigzag_stops(10)
    matrix = _matrix(stops)
    nn = solve_nearest_neighbor(matrix, stops, 0)
    nn_indices = _indices_by_identity(stops, nn)
    polished = two_opt_improve(nn_indices, matrix)
    polished_ids = {stops[i]["id"] for i in polished}
    assert polished_ids == {s["id"] for s in stops}
    assert len(polished) == len(stops)
