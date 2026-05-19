"""
Benchmark & Shadow Testing API Tests
=====================================
Tests for POST /api/benchmark and shadow testing in POST /api/optimize

Features tested:
- POST /api/benchmark - runs all 7 local algorithms and returns comparison results
- POST /api/benchmark with specific algorithms - runs only requested algorithms
- POST /api/benchmark with fewer than 2 stops - returns 400
- POST /api/optimize (two_opt) - includes shadow result in response
- Shadow result fields: algorithm, distance, time, savings_km
- Benchmark response fields: winner, sorted results by distance
- Quality metrics: backtrack_count, cluster_score, longest_leg_km
- Regression: GET /api/stops, POST /api/stops still work
"""

import pytest
import requests
import os
import time

# Use the public URL from environment
BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://route-opt.preview.emergentagent.com')

# All 7 local algorithms
ALL_LOCAL_ALGORITHMS = ["alns", "ortools", "nearest_neighbor", "two_opt", "simulated_annealing", "genetic", "clarke_wright"]

# Quick algorithms for fast tests
QUICK_ALGORITHMS = ["nearest_neighbor", "two_opt", "clarke_wright"]


@pytest.fixture(scope="module")
def api_client():
    """Shared requests session"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


class TestRegressionCRUD:
    """Regression tests - verify existing CRUD still works"""
    
    def test_get_stops_works(self, api_client):
        """GET /api/stops should return list of stops"""
        response = api_client.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200, f"GET /api/stops failed: {response.text}"
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        print(f"GET /api/stops: {len(data)} stops found")
    
    def test_create_stop_works(self, api_client):
        """POST /api/stops should create a new stop"""
        test_stop = {
            "address": "TEST_Benchmark_123 Test Street, Brisbane QLD 4000",
            "name": "TEST_Benchmark Stop",
            "latitude": -27.4698,
            "longitude": 153.0251,
            "priority": "medium"
        }
        response = api_client.post(f"{BASE_URL}/api/stops", json=test_stop)
        assert response.status_code == 200, f"POST /api/stops failed: {response.text}"
        data = response.json()
        assert "id" in data, "Response should have id"
        assert data["address"] == test_stop["address"], "Address should match"
        print(f"POST /api/stops: Created stop with id={data['id']}")
        
        # Cleanup
        api_client.delete(f"{BASE_URL}/api/stops/{data['id']}")


class TestBenchmarkEndpoint:
    """Tests for POST /api/benchmark endpoint"""
    
    def test_benchmark_with_quick_algorithms(self, api_client):
        """POST /api/benchmark with quick algorithms should return comparison results"""
        payload = {
            "algorithms": QUICK_ALGORITHMS
        }
        response = api_client.post(f"{BASE_URL}/api/benchmark", json=payload, timeout=60)
        assert response.status_code == 200, f"Benchmark failed: {response.text}"
        
        data = response.json()
        
        # Check required fields
        assert "stop_count" in data, "Response should have stop_count"
        assert "results" in data, "Response should have results"
        assert "winner" in data, "Response should have winner"
        
        print(f"Benchmark: {data['stop_count']} stops, winner={data['winner']}")
        
        # Check results structure
        results = data["results"]
        assert isinstance(results, list), "Results should be a list"
        assert len(results) >= 1, "Should have at least 1 result"
        
        # Check each result has required fields
        for r in results:
            assert "algorithm" in r, f"Result should have algorithm: {r}"
            assert "time_ms" in r, f"Result should have time_ms: {r}"
            if r.get("error") is None:
                assert "total_distance_km" in r, f"Successful result should have total_distance_km: {r}"
                assert "quality" in r, f"Successful result should have quality: {r}"
                
                # Check quality metrics
                quality = r["quality"]
                assert "backtrack_count" in quality, f"Quality should have backtrack_count: {quality}"
                assert "cluster_score" in quality, f"Quality should have cluster_score: {quality}"
                assert "longest_leg_km" in quality, f"Quality should have longest_leg_km: {quality}"
                
                print(f"  {r['algorithm']}: {r['total_distance_km']} km, {r['time_ms']} ms, cluster_score={quality['cluster_score']}")
    
    def test_benchmark_results_sorted_by_distance(self, api_client):
        """Benchmark results should be sorted by distance (best first)"""
        payload = {
            "algorithms": QUICK_ALGORITHMS
        }
        response = api_client.post(f"{BASE_URL}/api/benchmark", json=payload, timeout=60)
        assert response.status_code == 200, f"Benchmark failed: {response.text}"
        
        data = response.json()
        results = data["results"]
        
        # Filter successful results
        successful = [r for r in results if r.get("error") is None]
        
        if len(successful) >= 2:
            # Check sorting
            distances = [r["total_distance_km"] for r in successful]
            assert distances == sorted(distances), f"Results should be sorted by distance: {distances}"
            print(f"Results sorted correctly: {distances}")
    
    def test_benchmark_winner_is_best_algorithm(self, api_client):
        """Winner should be the algorithm with shortest distance"""
        payload = {
            "algorithms": QUICK_ALGORITHMS
        }
        response = api_client.post(f"{BASE_URL}/api/benchmark", json=payload, timeout=60)
        assert response.status_code == 200, f"Benchmark failed: {response.text}"
        
        data = response.json()
        winner = data["winner"]
        results = data["results"]
        
        # Filter successful results
        successful = [r for r in results if r.get("error") is None]
        
        if successful:
            best = min(successful, key=lambda r: r["total_distance_km"])
            assert winner == best["algorithm"], f"Winner should be {best['algorithm']}, got {winner}"
            print(f"Winner correctly identified: {winner} with {best['total_distance_km']} km")
    
    def test_benchmark_with_specific_algorithms(self, api_client):
        """POST /api/benchmark with specific algorithms should only run those"""
        specific_algos = ["nearest_neighbor", "two_opt"]
        payload = {
            "algorithms": specific_algos
        }
        response = api_client.post(f"{BASE_URL}/api/benchmark", json=payload, timeout=60)
        assert response.status_code == 200, f"Benchmark failed: {response.text}"
        
        data = response.json()
        results = data["results"]
        
        # Check only requested algorithms were run
        result_algos = [r["algorithm"] for r in results]
        for algo in result_algos:
            assert algo in specific_algos, f"Unexpected algorithm {algo} in results"
        
        print(f"Only requested algorithms run: {result_algos}")
    
    def test_benchmark_all_algorithms(self, api_client):
        """POST /api/benchmark without algorithms param should run all 7 local algorithms"""
        # This test may take 15-30 seconds
        payload = {}  # No algorithms specified = run all
        response = api_client.post(f"{BASE_URL}/api/benchmark", json=payload, timeout=90)
        assert response.status_code == 200, f"Benchmark failed: {response.text}"
        
        data = response.json()
        results = data["results"]
        
        # Check all 7 algorithms were run
        result_algos = set(r["algorithm"] for r in results)
        expected_algos = set(ALL_LOCAL_ALGORITHMS)
        
        assert result_algos == expected_algos, f"Expected all 7 algorithms, got {result_algos}"
        print(f"All 7 algorithms run: {result_algos}")
        
        # Print summary
        for r in results:
            if r.get("error"):
                print(f"  {r['algorithm']}: ERROR - {r['error']}")
            else:
                print(f"  {r['algorithm']}: {r['total_distance_km']} km, {r['time_ms']} ms")
    
    def test_benchmark_quality_metrics_present(self, api_client):
        """Each successful benchmark result should have quality metrics"""
        payload = {
            "algorithms": ["nearest_neighbor"]
        }
        response = api_client.post(f"{BASE_URL}/api/benchmark", json=payload, timeout=60)
        assert response.status_code == 200, f"Benchmark failed: {response.text}"
        
        data = response.json()
        results = data["results"]
        
        for r in results:
            if r.get("error") is None:
                quality = r.get("quality", {})
                
                # Check all expected quality metrics
                expected_metrics = ["backtrack_count", "cluster_score", "longest_leg_km", "shortest_leg_km", "leg_variance", "backtrack_ratio"]
                for metric in expected_metrics:
                    assert metric in quality, f"Quality should have {metric}: {quality}"
                
                print(f"Quality metrics for {r['algorithm']}: {quality}")


class TestBenchmarkEdgeCases:
    """Edge case tests for benchmark endpoint"""
    
    def test_benchmark_with_no_stops_returns_400(self, api_client):
        """POST /api/benchmark with no incomplete stops should return 400"""
        # First, get current stops and mark all as completed (or delete them)
        # For this test, we'll create a scenario with fewer than 2 stops
        
        # Get current stops count
        stops_response = api_client.get(f"{BASE_URL}/api/stops")
        stops = stops_response.json()
        incomplete_stops = [s for s in stops if not s.get("completed")]
        
        if len(incomplete_stops) >= 2:
            # We have enough stops, so this test will pass with 200
            # Skip this test if there are already stops
            print(f"Skipping: {len(incomplete_stops)} incomplete stops exist, need <2 for this test")
            pytest.skip("Need fewer than 2 incomplete stops to test 400 response")
        else:
            # Should get 400
            payload = {}
            response = api_client.post(f"{BASE_URL}/api/benchmark", json=payload, timeout=30)
            assert response.status_code == 400, f"Expected 400, got {response.status_code}"
            print("Correctly returned 400 for insufficient stops")
    
    def test_benchmark_with_unknown_algorithm_ignored(self, api_client):
        """Unknown algorithms should be ignored, not cause errors"""
        payload = {
            "algorithms": ["nearest_neighbor", "unknown_algo", "fake_algo"]
        }
        response = api_client.post(f"{BASE_URL}/api/benchmark", json=payload, timeout=60)
        assert response.status_code == 200, f"Benchmark failed: {response.text}"
        
        data = response.json()
        results = data["results"]
        
        # Only nearest_neighbor should be in results
        result_algos = [r["algorithm"] for r in results]
        assert "nearest_neighbor" in result_algos, "nearest_neighbor should be in results"
        assert "unknown_algo" not in result_algos, "unknown_algo should not be in results"
        assert "fake_algo" not in result_algos, "fake_algo should not be in results"
        
        print(f"Unknown algorithms correctly ignored: {result_algos}")


class TestShadowTesting:
    """Tests for shadow testing in POST /api/optimize"""
    
    def test_optimize_includes_shadow_result(self, api_client):
        """POST /api/optimize should include shadow result"""
        payload = {
            "algorithm": "two_opt"
        }
        response = api_client.post(f"{BASE_URL}/api/optimize", json=payload, timeout=60)
        assert response.status_code == 200, f"Optimize failed: {response.text}"
        
        data = response.json()
        
        # Check shadow field exists
        assert "shadow" in data, "Response should have shadow field"
        
        shadow = data["shadow"]
        if shadow is not None:
            # Check shadow has required fields
            assert "algorithm" in shadow, f"Shadow should have algorithm: {shadow}"
            assert "time_ms" in shadow, f"Shadow should have time_ms: {shadow}"
            
            if shadow.get("error") is None:
                assert "total_distance_km" in shadow, f"Shadow should have total_distance_km: {shadow}"
                assert "savings_km" in shadow, f"Shadow should have savings_km: {shadow}"
                
                print(f"Shadow result: {shadow['algorithm']} - {shadow['total_distance_km']} km, savings={shadow['savings_km']} km")
            else:
                print(f"Shadow had error: {shadow.get('error')}")
        else:
            print("Shadow is None (may be due to insufficient stops)")
    
    def test_shadow_algorithm_different_from_primary(self, api_client):
        """Shadow algorithm should be different from the primary algorithm"""
        payload = {
            "algorithm": "two_opt"
        }
        response = api_client.post(f"{BASE_URL}/api/optimize", json=payload, timeout=60)
        assert response.status_code == 200, f"Optimize failed: {response.text}"
        
        data = response.json()
        primary_algo = data.get("algorithm")
        shadow = data.get("shadow")
        
        if shadow and shadow.get("algorithm"):
            shadow_algo = shadow["algorithm"]
            assert shadow_algo != primary_algo, f"Shadow algo ({shadow_algo}) should differ from primary ({primary_algo})"
            print(f"Primary: {primary_algo}, Shadow: {shadow_algo}")
    
    def test_shadow_savings_calculation(self, api_client):
        """Shadow savings_km should be shadow_distance - primary_distance"""
        payload = {
            "algorithm": "nearest_neighbor"
        }
        response = api_client.post(f"{BASE_URL}/api/optimize", json=payload, timeout=60)
        assert response.status_code == 200, f"Optimize failed: {response.text}"
        
        data = response.json()
        primary_distance = data.get("total_distance_km")
        shadow = data.get("shadow")
        
        if shadow and shadow.get("error") is None:
            shadow_distance = shadow.get("total_distance_km")
            savings = shadow.get("savings_km")
            
            # savings_km = shadow_distance - primary_distance
            expected_savings = round(shadow_distance - primary_distance, 3)
            
            # Allow small floating point tolerance
            assert abs(savings - expected_savings) < 0.01, f"Savings mismatch: got {savings}, expected {expected_savings}"
            
            print(f"Primary: {primary_distance} km, Shadow: {shadow_distance} km, Savings: {savings} km")
            if savings < 0:
                print("  -> Shadow found a BETTER route!")
            else:
                print("  -> Primary route is better")


class TestBenchmarkWithCurrentLocation:
    """Tests for benchmark with current location"""
    
    def test_benchmark_with_current_location(self, api_client):
        """POST /api/benchmark with current location should include it as start"""
        payload = {
            "algorithms": ["nearest_neighbor"],
            "use_current_location": True,
            "current_latitude": -27.4698,
            "current_longitude": 153.0251
        }
        response = api_client.post(f"{BASE_URL}/api/benchmark", json=payload, timeout=60)
        assert response.status_code == 200, f"Benchmark failed: {response.text}"
        
        data = response.json()
        
        # Check started_from_current_location flag
        assert "started_from_current_location" in data, "Response should have started_from_current_location"
        assert data["started_from_current_location"] == True, "Should indicate started from current location"
        
        print(f"Benchmark with current location: {data['stop_count']} stops (including current location)")


class TestCleanup:
    """Cleanup test data"""
    
    def test_cleanup_test_stops(self, api_client):
        """Clean up any TEST_ prefixed stops created during testing"""
        response = api_client.get(f"{BASE_URL}/api/stops")
        if response.status_code == 200:
            stops = response.json()
            test_stops = [
                s for s in stops 
                if (s.get("name") or "").startswith("TEST_") or (s.get("address") or "").startswith("TEST_")
            ]
            
            for stop in test_stops:
                api_client.delete(f"{BASE_URL}/api/stops/{stop['id']}")
            
            print(f"Cleaned up {len(test_stops)} test stops")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
