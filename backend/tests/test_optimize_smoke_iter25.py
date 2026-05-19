"""HTTP smoke tests for /api/optimize with different stop counts.

Tests:
1. ~12 synthetic stops with algorithm=cluster_first (n<150, 3-opt skipped)
2. ~155 synthetic stops with algorithm=auto (n>=150, 3-opt runs)

These tests verify no regression when the 3-opt path is skipped (small routes)
and that the 3-opt path runs without errors (large routes).
"""
import os
import pytest
import requests
import math

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://route-opt.preview.emergentagent.com').rstrip('/')

# Test session token for xmltvg@gmail.com (whitelisted user)
TEST_SESSION_TOKEN = "59c60389-8953-4a7b-9088-d6175aa30243"


def get_auth_headers():
    """Return headers with authentication"""
    return {
        "Authorization": f"Bearer {TEST_SESSION_TOKEN}",
        "Content-Type": "application/json"
    }


def generate_synthetic_stops(n: int, center_lat: float = -26.65, center_lng: float = 153.10, radius: float = 0.05):
    """Generate n synthetic stops in a circular pattern around a center point."""
    stops = []
    for i in range(n):
        angle = 2 * math.pi * i / n
        lat = center_lat + radius * math.cos(angle) + 0.001 * (i % 7)  # Add some noise
        lng = center_lng + radius * math.sin(angle) + 0.001 * (i % 5)
        stops.append({
            "id": f"synth_{i}",
            "address": f"Synthetic Stop {i}",
            "latitude": lat,
            "longitude": lng,
            "name": f"Stop {i}"
        })
    return stops


class TestOptimizeSmallRoute:
    """Smoke test: ~12 stops with algorithm=cluster_first (n<150, 3-opt skipped)"""

    def test_optimize_12_stops_cluster_first(self):
        """POST /api/optimize with ~12 synthetic stops and algorithm=cluster_first.
        Verifies no regression when n<150 (3-opt path skipped)."""
        stops = generate_synthetic_stops(12)
        
        payload = {
            "stops": stops,
            "start_location": {"latitude": -26.65, "longitude": 153.10},
            "algorithm": "cluster_first",
        }
        
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json=payload,
            headers=get_auth_headers(),
            timeout=60
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        
        # Must have optimized_sequence
        assert "optimized_sequence" in data, f"Missing optimized_sequence in response: {data.keys()}"
        
        # Must have cluster_warnings (can be empty list)
        assert "cluster_warnings" in data, f"Missing cluster_warnings in response: {data.keys()}"
        
        # Verify Hamiltonian integrity
        optimized_sequence = data.get("optimized_sequence", [])
        stop_count = data.get("stop_count", 0)
        
        # No duplicates
        assert len(optimized_sequence) == len(set(optimized_sequence)), (
            f"Hamiltonian violation: duplicated IDs in output"
        )
        
        # Count matches
        assert len(optimized_sequence) == stop_count, (
            f"Hamiltonian violation: sequence has {len(optimized_sequence)}, stop_count reports {stop_count}"
        )
        
        print(f"Small route (12 stops) with cluster_first: OK - {stop_count} stops optimized")


class TestOptimizeLargeRoute:
    """Smoke test: ~155 stops with algorithm=auto (n>=150, 3-opt runs)"""

    def test_optimize_155_stops_auto(self):
        """POST /api/optimize with ~155 synthetic stops and algorithm=auto.
        Verifies 3-opt path runs without errors and returns Hamiltonian path."""
        stops = generate_synthetic_stops(155)
        
        payload = {
            "stops": stops,
            "start_location": {"latitude": -26.65, "longitude": 153.10},
            "algorithm": "auto",
        }
        
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json=payload,
            headers=get_auth_headers(),
            timeout=120  # Longer timeout for large route
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        
        # Must have optimized_sequence
        assert "optimized_sequence" in data, f"Missing optimized_sequence in response: {data.keys()}"
        
        # Must have cluster_warnings (can be empty list)
        assert "cluster_warnings" in data, f"Missing cluster_warnings in response: {data.keys()}"
        
        # Verify Hamiltonian integrity
        optimized_sequence = data.get("optimized_sequence", [])
        stop_count = data.get("stop_count", 0)
        
        # No duplicates
        assert len(optimized_sequence) == len(set(optimized_sequence)), (
            f"Hamiltonian violation: duplicated IDs in output"
        )
        
        # Count matches
        assert len(optimized_sequence) == stop_count, (
            f"Hamiltonian violation: sequence has {len(optimized_sequence)}, stop_count reports {stop_count}"
        )
        
        print(f"Large route (155 stops) with auto: OK - {stop_count} stops optimized")

    def test_optimize_160_stops_cluster_first(self):
        """POST /api/optimize with ~160 synthetic stops and algorithm=cluster_first.
        Verifies 3-opt path runs without errors for cluster_first algorithm too."""
        stops = generate_synthetic_stops(160)
        
        payload = {
            "stops": stops,
            "start_location": {"latitude": -26.65, "longitude": 153.10},
            "algorithm": "cluster_first",
        }
        
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json=payload,
            headers=get_auth_headers(),
            timeout=120
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        
        # Must have optimized_sequence
        assert "optimized_sequence" in data, f"Missing optimized_sequence in response: {data.keys()}"
        
        # Verify Hamiltonian integrity
        optimized_sequence = data.get("optimized_sequence", [])
        stop_count = data.get("stop_count", 0)
        
        # No duplicates
        assert len(optimized_sequence) == len(set(optimized_sequence)), (
            f"Hamiltonian violation: duplicated IDs in output"
        )
        
        # Count matches
        assert len(optimized_sequence) == stop_count, (
            f"Hamiltonian violation: sequence has {len(optimized_sequence)}, stop_count reports {stop_count}"
        )
        
        print(f"Large route (160 stops) with cluster_first: OK - {stop_count} stops optimized")


class TestOptimizeEdgeCases:
    """Edge case tests for /api/optimize"""

    def test_optimize_exactly_150_stops(self):
        """POST /api/optimize with exactly 150 stops (boundary condition for 3-opt)."""
        stops = generate_synthetic_stops(150)
        
        payload = {
            "stops": stops,
            "start_location": {"latitude": -26.65, "longitude": 153.10},
            "algorithm": "auto",
        }
        
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json=payload,
            headers=get_auth_headers(),
            timeout=120
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        
        # Verify Hamiltonian integrity
        optimized_sequence = data.get("optimized_sequence", [])
        stop_count = data.get("stop_count", 0)
        
        # No duplicates
        assert len(optimized_sequence) == len(set(optimized_sequence)), (
            f"Hamiltonian violation at boundary (150 stops): duplicated IDs"
        )
        
        # Count matches
        assert len(optimized_sequence) == stop_count, (
            f"Hamiltonian violation at boundary (150 stops): sequence has {len(optimized_sequence)}, "
            f"stop_count reports {stop_count}"
        )
        
        print(f"Boundary route (150 stops) with auto: OK - {stop_count} stops optimized")

    def test_optimize_149_stops(self):
        """POST /api/optimize with 149 stops (just below 3-opt threshold)."""
        stops = generate_synthetic_stops(149)
        
        payload = {
            "stops": stops,
            "start_location": {"latitude": -26.65, "longitude": 153.10},
            "algorithm": "auto",
        }
        
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json=payload,
            headers=get_auth_headers(),
            timeout=120
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        
        # Verify Hamiltonian integrity
        optimized_sequence = data.get("optimized_sequence", [])
        stop_count = data.get("stop_count", 0)
        
        # No duplicates
        assert len(optimized_sequence) == len(set(optimized_sequence)), (
            f"Hamiltonian violation at 149 stops: duplicated IDs"
        )
        
        # Count matches
        assert len(optimized_sequence) == stop_count, (
            f"Hamiltonian violation at 149 stops: sequence has {len(optimized_sequence)}, "
            f"stop_count reports {stop_count}"
        )
        
        print(f"Below-boundary route (149 stops) with auto: OK - {stop_count} stops optimized")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
