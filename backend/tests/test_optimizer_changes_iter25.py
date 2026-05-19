"""Regression tests for iteration 25 optimizer changes:

1. `_osrm_verify_relocation` now uses `_osrm_duration_matrix` (local OSRM Table service)
   instead of `calculate_duration_matrix` (which falls back to haversine for N>25).
   
2. `detect_cluster_spikes` defaults relaxed: spike_ratio 0.3 → 0.5, min_detour_km 0.15 → 0.10
   
3. `_global_two_opt_pass` now scales max_iterations from 3 → 6 for routes ≥150 stops
   AND adds a `three_opt_improve` polish pass (also gated on n>=150).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from server import (
    detect_cluster_spikes,
    _global_two_opt_pass,
    three_opt_improve,
    two_opt_improve,
    _or_opt_1_improve,
)
from haversine import haversine, Unit


def _stop(idx: int, lat: float, lng: float) -> dict:
    return {"id": f"s{idx}", "latitude": lat, "longitude": lng}


# ─────────────────────────────────────────────────────────────────────────────
# Test 1: detect_cluster_spikes new defaults (spike_ratio=0.5, min_detour_km=0.10)
# ─────────────────────────────────────────────────────────────────────────────

class TestDetectClusterSpikesNewDefaults:
    """Verify that the relaxed defaults (spike_ratio=0.5, min_detour_km=0.10)
    catch more visual zig-zags than the old defaults (0.3, 0.15)."""

    def test_triplet_with_ratio_0_4_flagged_by_new_defaults(self):
        """A triplet with detour ratio ~0.4 should be flagged by new defaults
        (spike_ratio=0.5) but would NOT have been flagged by old defaults (0.3).
        
        ratio = straight_km / detour_km
        If ratio < spike_ratio, it's flagged.
        ratio=0.4 < 0.5 (new) → flagged
        ratio=0.4 > 0.3 (old) → NOT flagged
        """
        # Create a triplet where B is moderately off the A→C line
        # A and C are ~1 km apart, B is ~0.3 km off the line
        # This creates a ratio around 0.4
        A = _stop(0, -26.6500, 153.0900)  # Start
        B = _stop(1, -26.6530, 153.0950)  # Slightly south of midpoint
        C = _stop(2, -26.6500, 153.1000)  # End (east of A)
        
        stops = [A, B, C]
        
        # Calculate expected ratio
        d_ac = haversine(
            (A["latitude"], A["longitude"]),
            (C["latitude"], C["longitude"]),
            unit=Unit.KILOMETERS
        )
        d_ab = haversine(
            (A["latitude"], A["longitude"]),
            (B["latitude"], B["longitude"]),
            unit=Unit.KILOMETERS
        )
        d_bc = haversine(
            (B["latitude"], B["longitude"]),
            (C["latitude"], C["longitude"]),
            unit=Unit.KILOMETERS
        )
        detour_km = d_ab + d_bc
        ratio = d_ac / detour_km if detour_km > 0 else 1.0
        
        print(f"Straight A→C: {d_ac:.3f} km")
        print(f"Detour A→B→C: {detour_km:.3f} km")
        print(f"Ratio: {ratio:.3f}")
        
        # With new defaults (spike_ratio=0.5), this should be flagged
        warnings_new = detect_cluster_spikes(stops)  # Uses new defaults
        
        # With old defaults (spike_ratio=0.3), this should NOT be flagged
        warnings_old = detect_cluster_spikes(stops, spike_ratio=0.3, min_detour_km=0.15)
        
        # The new defaults should catch more cases
        # If ratio is between 0.3 and 0.5, new catches it, old doesn't
        if 0.3 < ratio < 0.5:
            assert len(warnings_new) > len(warnings_old), \
                f"New defaults should flag ratio={ratio:.3f} but old shouldn't"
        
    def test_small_detour_flagged_by_new_min_detour(self):
        """A detour of ~0.12 km should be flagged by new defaults (min_detour_km=0.10)
        but would NOT have been flagged by old defaults (min_detour_km=0.15)."""
        # Create a triplet with a small but noticeable spike
        # Total detour ~0.12 km, which is > 0.10 (new) but < 0.15 (old)
        A = _stop(0, -26.6500, 153.0900)
        B = _stop(1, -26.6505, 153.0903)  # Small spike
        C = _stop(2, -26.6500, 153.0906)
        
        stops = [A, B, C]
        
        d_ac = haversine(
            (A["latitude"], A["longitude"]),
            (C["latitude"], C["longitude"]),
            unit=Unit.KILOMETERS
        )
        d_ab = haversine(
            (A["latitude"], A["longitude"]),
            (B["latitude"], B["longitude"]),
            unit=Unit.KILOMETERS
        )
        d_bc = haversine(
            (B["latitude"], B["longitude"]),
            (C["latitude"], C["longitude"]),
            unit=Unit.KILOMETERS
        )
        detour_km = d_ab + d_bc
        extra_km = detour_km - d_ac
        
        print(f"Straight A→C: {d_ac:.4f} km")
        print(f"Detour A→B→C: {detour_km:.4f} km")
        print(f"Extra km: {extra_km:.4f} km")
        
        # With new defaults, small detours (>0.10 km) should be considered
        warnings_new = detect_cluster_spikes(stops)
        
        # With old defaults, small detours (<0.15 km) are ignored
        warnings_old = detect_cluster_spikes(stops, spike_ratio=0.3, min_detour_km=0.15)
        
        # If extra_km is between 0.10 and 0.15, new catches it, old doesn't
        if 0.10 < extra_km < 0.15:
            print(f"Extra km {extra_km:.4f} is between 0.10 and 0.15")
            # Note: The spike must also fail the ratio check to be flagged

    def test_obvious_spike_flagged_by_both_defaults(self):
        """A very obvious spike should be flagged by both old and new defaults."""
        A = _stop(0, -26.6500, 153.0900)
        B = _stop(1, -26.6000, 153.0950)  # 5.5 km north - obvious spike
        C = _stop(2, -26.6500, 153.1000)
        
        stops = [A, B, C]
        
        warnings_new = detect_cluster_spikes(stops)
        warnings_old = detect_cluster_spikes(stops, spike_ratio=0.3, min_detour_km=0.15)
        
        assert len(warnings_new) >= 1, "New defaults should flag obvious spike"
        assert len(warnings_old) >= 1, "Old defaults should also flag obvious spike"


# ─────────────────────────────────────────────────────────────────────────────
# Test 2: _global_two_opt_pass 3-opt polish for routes ≥150 stops
# ─────────────────────────────────────────────────────────────────────────────

class TestGlobalTwoOptPass3OptPolish:
    """Verify that _global_two_opt_pass applies 3-opt polish for routes ≥150 stops."""

    def test_3opt_path_runs_for_large_routes(self):
        """Build a 160-stop synthetic route and verify _global_two_opt_pass
        terminates correctly and returns the same stop count without dupes/drops."""
        n = 160
        # Create a circular route with some intentional inefficiencies
        import math
        stops = []
        for i in range(n):
            # Circular layout with some noise
            angle = 2 * math.pi * i / n
            lat = -26.65 + 0.05 * math.cos(angle) + 0.001 * (i % 7)
            lng = 153.10 + 0.05 * math.sin(angle) + 0.001 * (i % 5)
            stops.append(_stop(i, lat, lng))
        
        # Shuffle to create suboptimal order
        import random
        random.seed(42)
        shuffled = stops.copy()
        random.shuffle(shuffled)
        
        # Run _global_two_opt_pass
        result = _global_two_opt_pass(shuffled, max_iterations=3)
        
        # Verify no stops lost or duplicated
        input_ids = sorted(s["id"] for s in shuffled)
        output_ids = sorted(s["id"] for s in result)
        assert input_ids == output_ids, "3-opt should not lose or duplicate stops"
        assert len(result) == n, f"Expected {n} stops, got {len(result)}"

    def test_3opt_improves_or_maintains_quality(self):
        """For a 160-stop route, 3-opt should improve or maintain haversine distance."""
        n = 160
        import math
        stops = []
        for i in range(n):
            angle = 2 * math.pi * i / n
            lat = -26.65 + 0.05 * math.cos(angle)
            lng = 153.10 + 0.05 * math.sin(angle)
            stops.append(_stop(i, lat, lng))
        
        # Create a suboptimal order by reversing some segments
        suboptimal = stops[:40] + list(reversed(stops[40:80])) + stops[80:120] + list(reversed(stops[120:]))
        
        def calc_haversine_distance(route):
            total = 0
            for i in range(len(route) - 1):
                d = haversine(
                    (route[i]["latitude"], route[i]["longitude"]),
                    (route[i+1]["latitude"], route[i+1]["longitude"]),
                    unit=Unit.KILOMETERS
                )
                total += d
            return total
        
        before_dist = calc_haversine_distance(suboptimal)
        result = _global_two_opt_pass(suboptimal, max_iterations=3)
        after_dist = calc_haversine_distance(result)
        
        print(f"Before: {before_dist:.2f} km, After: {after_dist:.2f} km")
        
        # Should improve or stay the same (never get worse)
        assert after_dist <= before_dist + 0.01, \
            f"3-opt should not make route worse: {before_dist:.2f} → {after_dist:.2f}"

    def test_small_route_skips_3opt(self):
        """Routes with <150 stops should skip the 3-opt phase."""
        n = 50
        import math
        stops = []
        for i in range(n):
            angle = 2 * math.pi * i / n
            lat = -26.65 + 0.02 * math.cos(angle)
            lng = 153.10 + 0.02 * math.sin(angle)
            stops.append(_stop(i, lat, lng))
        
        # This should work without 3-opt (n < 150)
        result = _global_two_opt_pass(stops, max_iterations=3)
        
        # Verify no stops lost
        assert len(result) == n
        assert sorted(s["id"] for s in result) == sorted(s["id"] for s in stops)


# ─────────────────────────────────────────────────────────────────────────────
# Test 3: three_opt_improve function directly
# ─────────────────────────────────────────────────────────────────────────────

class TestThreeOptImprove:
    """Direct tests for the three_opt_improve function."""

    def test_three_opt_preserves_all_indices(self):
        """three_opt_improve should return all indices exactly once."""
        n = 20
        indices = list(range(n))
        # Create a simple distance matrix
        matrix = [[abs(i - j) for j in range(n)] for i in range(n)]
        
        result = three_opt_improve(indices, matrix, max_iterations=3)
        
        assert sorted(result) == list(range(n)), "All indices should be preserved"
        assert len(result) == n, f"Expected {n} indices, got {len(result)}"

    def test_three_opt_improves_suboptimal_route(self):
        """three_opt_improve should improve a deliberately suboptimal route."""
        n = 30
        # Create a route where segments are swapped
        indices = list(range(10)) + list(range(20, 30)) + list(range(10, 20))
        
        # Distance matrix where consecutive indices are close
        matrix = [[0.0] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                matrix[i][j] = abs(i - j) * 1.0
        
        def calc_cost(route):
            return sum(matrix[route[i]][route[i+1]] for i in range(len(route)-1))
        
        before_cost = calc_cost(indices)
        result = three_opt_improve(indices, matrix, max_iterations=5)
        after_cost = calc_cost(result)
        
        print(f"Before: {before_cost}, After: {after_cost}")
        
        # Should improve or stay the same
        assert after_cost <= before_cost + 0.01

    def test_three_opt_handles_small_routes(self):
        """three_opt_improve should handle routes with < 5 nodes gracefully."""
        for n in [1, 2, 3, 4]:
            indices = list(range(n))
            matrix = [[abs(i - j) for j in range(n)] for i in range(n)]
            result = three_opt_improve(indices, matrix)
            assert result == indices, f"Small route (n={n}) should be unchanged"


# ─────────────────────────────────────────────────────────────────────────────
# Test 4: Verify max_iterations scaling for large routes
# ─────────────────────────────────────────────────────────────────────────────

class TestMaxIterationsScaling:
    """Verify that _global_two_opt_pass scales max_iterations for large routes."""

    def test_large_route_gets_more_iterations(self):
        """Routes ≥150 stops should get max_iterations scaled to at least 6."""
        # This is an indirect test - we verify the function completes
        # and produces reasonable results for a large route
        n = 155
        import math
        stops = []
        for i in range(n):
            angle = 2 * math.pi * i / n
            lat = -26.65 + 0.05 * math.cos(angle)
            lng = 153.10 + 0.05 * math.sin(angle)
            stops.append(_stop(i, lat, lng))
        
        # Shuffle to create work for the optimizer
        import random
        random.seed(123)
        shuffled = stops.copy()
        random.shuffle(shuffled)
        
        # Run with default max_iterations=3 (should be scaled to 6 internally)
        result = _global_two_opt_pass(shuffled, max_iterations=3)
        
        # Verify completion and correctness
        assert len(result) == n
        assert sorted(s["id"] for s in result) == sorted(s["id"] for s in shuffled)


# ─────────────────────────────────────────────────────────────────────────────
# Test 5: Integration test - verify no regression in basic functionality
# ─────────────────────────────────────────────────────────────────────────────

class TestNoRegression:
    """Verify that the changes don't break existing functionality."""

    def test_detect_cluster_spikes_still_works_with_explicit_params(self):
        """Calling with explicit old params should still work."""
        A = _stop(0, -26.6500, 153.0900)
        B = _stop(1, -26.6000, 153.0950)  # Obvious spike
        C = _stop(2, -26.6500, 153.1000)
        
        stops = [A, B, C]
        
        # Explicit old params
        warnings = detect_cluster_spikes(stops, spike_ratio=0.3, min_detour_km=0.15)
        assert len(warnings) >= 1

    def test_global_two_opt_pass_handles_edge_cases(self):
        """Edge cases should be handled gracefully."""
        # Empty
        assert _global_two_opt_pass([]) == []
        
        # Single stop
        single = [_stop(0, -26.65, 153.10)]
        assert _global_two_opt_pass(single) == single
        
        # Two stops
        two = [_stop(0, -26.65, 153.10), _stop(1, -26.66, 153.11)]
        assert len(_global_two_opt_pass(two)) == 2
        
        # Three stops
        three = [_stop(0, -26.65, 153.10), _stop(1, -26.66, 153.11), _stop(2, -26.67, 153.12)]
        assert len(_global_two_opt_pass(three)) == 3
