"""
cluster_first OSRM-first regression test.

Before this fix, the cluster_first algorithm with `inner_algorithm='ortools'`
called `calculate_duration_matrix` directly — which is the Mapbox/haversine
FALLBACK path. That meant:
  - Clusters with >25 stops silently fell back to haversine straight-line
    distances (Mapbox Matrix API limit).
  - Even smaller clusters hit Mapbox first, ignoring the local OSRM service
    that the main `/optimize` pipeline uses.

The fix at server.py:3717 now calls `_osrm_duration_matrix` first, with a
graceful fallback to `calculate_duration_matrix` only if OSRM returns None.
Matches the behaviour of the main pipeline (server.py:5120).

These tests use unittest.mock to verify the call order without actually
hitting the OSRM server.
"""
from __future__ import annotations

import sys
import os
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402


def _toy_stops(n=30):
    """Spread n stops in a wider grid so cluster_first actually exceeds its
    25-stop threshold and triggers the per-cluster matrix lookup."""
    return [
        {
            "id": f"stop-{i}",
            "address": f"{i} Test St",
            "name": f"S{i}",
            # 6×6 grid of ~1km spacing — DBSCAN will produce several clusters.
            "latitude": -26.6500 + (i % 6) * 0.010,
            "longitude": 153.0900 + (i // 6) * 0.010,
            "completed": False,
            "order": i,
        }
        for i in range(n)
    ]


def _toy_distance_matrix(n: int):
    """Haversine-like NxN distance matrix to satisfy the required positional arg."""
    return [[0.0 if i == j else 1.0 + abs(i - j) for j in range(n)] for i in range(n)]


@pytest.mark.asyncio
async def test_cluster_first_ortools_calls_osrm_first():
    """With OSRM available, cluster_first(ortools) MUST use the OSRM matrix
    for every per-cluster solve. Mapbox/haversine fallback must NOT be invoked."""
    stops = _toy_stops(30)
    distance_matrix = _toy_distance_matrix(len(stops))

    # Build a fake OSRM matrix sized for the LARGEST cluster — using
    # a callable side_effect so each call gets a matrix of the right size.
    def _fake_osrm(cluster_stops):
        m = len(cluster_stops)
        return [[0 if i == j else 100 + i + j for j in range(m)] for i in range(m)]

    osrm_mock = AsyncMock(side_effect=_fake_osrm)
    fallback_mock = AsyncMock()  # Will fail the test if called

    with patch.object(server, "_osrm_duration_matrix", osrm_mock), \
         patch.object(server, "calculate_duration_matrix", fallback_mock):
        try:
            await server.cluster_first_optimize(
                stops=stops,
                distance_matrix=distance_matrix,
                start_index=0,
                time_limit_seconds=2,
                inner_algorithm="ortools",
            )
        except Exception:
            # We don't care about whether the full route succeeds — only
            # whether the matrix lookup went through OSRM. A solver
            # failure later in the pipeline shouldn't fail this test.
            pass

    # OSRM was called for every cluster solve (≥1 call).
    assert osrm_mock.call_count >= 1, (
        f"cluster_first(ortools) did NOT call _osrm_duration_matrix "
        f"(call_count={osrm_mock.call_count}). The OSRM-first fix has regressed."
    )
    # The Mapbox/haversine FALLBACK path must NOT be hit when OSRM is healthy.
    assert fallback_mock.call_count == 0, (
        f"calculate_duration_matrix (Mapbox/haversine fallback) was called "
        f"{fallback_mock.call_count} times when OSRM was available. "
        "cluster_first is bypassing OSRM again."
    )


@pytest.mark.asyncio
async def test_cluster_first_ortools_falls_back_when_osrm_returns_none():
    """When OSRM returns None (service down, timeout, etc.), the fallback
    Mapbox/haversine path MUST kick in so we still produce a route."""
    stops = _toy_stops(30)
    distance_matrix = _toy_distance_matrix(len(stops))

    osrm_mock = AsyncMock(return_value=None)

    def _fake_fallback(cluster_stops):
        m = len(cluster_stops)
        return [[0 if i == j else 200 + i + j for j in range(m)] for i in range(m)]

    fallback_mock = AsyncMock(side_effect=_fake_fallback)

    with patch.object(server, "_osrm_duration_matrix", osrm_mock), \
         patch.object(server, "calculate_duration_matrix", fallback_mock):
        try:
            await server.cluster_first_optimize(
                stops=stops,
                distance_matrix=distance_matrix,
                start_index=0,
                time_limit_seconds=2,
                inner_algorithm="ortools",
            )
        except Exception:
            pass

    assert osrm_mock.call_count >= 1, "OSRM should have been attempted first"
    assert fallback_mock.call_count >= 1, (
        "Fallback `calculate_duration_matrix` was never called even though "
        "OSRM returned None. cluster_first will produce no route in this state."
    )


@pytest.mark.asyncio
async def test_cluster_first_non_ortools_path_unchanged():
    """The else-branch (inner_algorithm != 'ortools') uses
    `calculate_road_distance_matrix`, which already has its own OSRM-first
    logic. This test pins that we did NOT accidentally change that path."""
    stops = _toy_stops(30)
    distance_matrix = _toy_distance_matrix(len(stops))

    def _fake_road(cluster_stops):
        m = len(cluster_stops)
        return [[0.0 if i == j else 5.0 + i + j for j in range(m)] for i in range(m)]

    road_mock = AsyncMock(side_effect=_fake_road)
    # If the ortools branch leaks into here it'd call this.
    osrm_dur_mock = AsyncMock()

    with patch.object(server, "calculate_road_distance_matrix", road_mock), \
         patch.object(server, "_osrm_duration_matrix", osrm_dur_mock):
        try:
            await server.cluster_first_optimize(
                stops=stops,
                distance_matrix=distance_matrix,
                start_index=0,
                time_limit_seconds=2,
                inner_algorithm="genetic",
            )
        except Exception:
            pass

    assert road_mock.call_count >= 1, (
        "Non-ortools inner algorithms should still call calculate_road_distance_matrix"
    )
    # Critical: the ortools-only OSRM duration path must NOT be invoked here.
    assert osrm_dur_mock.call_count == 0, (
        "_osrm_duration_matrix should only be called when inner_algorithm='ortools'"
    )
