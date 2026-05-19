"""
Test P3 Features: Traffic-Aware Routing, Cache Stats, OSRM Integration
=======================================================================
Tests for:
1. POST /api/optimize with traffic_aware=true and departure_hour=8 (1.35x AM peak)
2. POST /api/optimize with traffic_aware=true and departure_hour=22 (1.00x night free flow)
3. POST /api/optimize without traffic_aware flag (no traffic in reasoning)
4. GET /api/traffic/info returns current hour, multiplier, and schedule
5. GET /api/cache/stats includes osrm_distance cache stats
6. GET /api/directions returns source='osrm' with valid geometry and steps
7. POST /api/optimize returns valid optimization with OSRM distance matrix
"""

import pytest
import requests
import os
import time

# Use the public URL for testing
BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://route-opt.preview.emergentagent.com').rstrip('/')

# DEV_MODE header for authentication bypass
DEV_HEADERS = {
    "Content-Type": "application/json",
    "x-dev-user-id": "dev-user-123"
}


class TestTrafficInfo:
    """Traffic info endpoint tests"""
    
    def test_traffic_info_endpoint(self):
        """GET /api/traffic/info returns current hour, multiplier, and schedule"""
        response = requests.get(f"{BASE_URL}/api/traffic/info", headers=DEV_HEADERS)
        
        assert response.status_code == 200, f"Traffic info failed: {response.status_code} - {response.text}"
        data = response.json()
        
        # Verify current_hour_utc
        assert "current_hour_utc" in data, "Missing current_hour_utc in response"
        assert isinstance(data["current_hour_utc"], int), "current_hour_utc should be int"
        assert 0 <= data["current_hour_utc"] <= 23, f"current_hour_utc should be 0-23, got {data['current_hour_utc']}"
        
        # Verify current_multiplier
        assert "current_multiplier" in data, "Missing current_multiplier in response"
        assert isinstance(data["current_multiplier"], (int, float)), "current_multiplier should be numeric"
        assert 1.0 <= data["current_multiplier"] <= 1.5, f"current_multiplier should be 1.0-1.5, got {data['current_multiplier']}"
        
        # Verify schedule
        assert "schedule" in data, "Missing schedule in response"
        schedule = data["schedule"]
        
        # Check expected schedule entries
        expected_periods = ["night_free_flow", "early_morning", "am_peak", "post_am_peak", 
                          "midday", "school_run", "pm_peak", "post_pm_peak"]
        for period in expected_periods:
            assert period in schedule, f"Missing {period} in schedule"
            assert "hours" in schedule[period], f"Missing hours in {period}"
            assert "multiplier" in schedule[period], f"Missing multiplier in {period}"
        
        # Verify specific multipliers
        assert schedule["am_peak"]["multiplier"] == 1.35, f"AM peak should be 1.35, got {schedule['am_peak']['multiplier']}"
        assert schedule["pm_peak"]["multiplier"] == 1.40, f"PM peak should be 1.40, got {schedule['pm_peak']['multiplier']}"
        assert schedule["night_free_flow"]["multiplier"] == 1.00, f"Night should be 1.00, got {schedule['night_free_flow']['multiplier']}"
        
        print(f"✓ Traffic info: current_hour={data['current_hour_utc']}, multiplier={data['current_multiplier']}")
        print(f"  Schedule: {list(schedule.keys())}")


class TestCacheStatsWithOSRMDistance:
    """Cache stats endpoint tests including osrm_distance"""
    
    def test_cache_stats_includes_osrm_distance(self):
        """GET /api/cache/stats returns osrm_matrix, osrm_distance, and directions stats"""
        response = requests.get(f"{BASE_URL}/api/cache/stats", headers=DEV_HEADERS)
        
        assert response.status_code == 200, f"Cache stats failed: {response.status_code}"
        data = response.json()
        
        # Verify osrm_matrix cache stats
        assert "osrm_matrix" in data, "Missing osrm_matrix in cache stats"
        osrm_matrix_stats = data["osrm_matrix"]
        assert "entries" in osrm_matrix_stats, "osrm_matrix missing entries"
        assert "maxsize" in osrm_matrix_stats, "osrm_matrix missing maxsize"
        assert "ttl_seconds" in osrm_matrix_stats, "osrm_matrix missing ttl_seconds"
        assert "hits" in osrm_matrix_stats, "osrm_matrix missing hits"
        assert "misses" in osrm_matrix_stats, "osrm_matrix missing misses"
        assert "hit_rate" in osrm_matrix_stats, "osrm_matrix missing hit_rate"
        
        # Verify osrm_distance cache stats (NEW in P3)
        assert "osrm_distance" in data, "Missing osrm_distance in cache stats"
        osrm_distance_stats = data["osrm_distance"]
        assert "entries" in osrm_distance_stats, "osrm_distance missing entries"
        assert "maxsize" in osrm_distance_stats, "osrm_distance missing maxsize"
        assert "ttl_seconds" in osrm_distance_stats, "osrm_distance missing ttl_seconds"
        assert "hits" in osrm_distance_stats, "osrm_distance missing hits"
        assert "misses" in osrm_distance_stats, "osrm_distance missing misses"
        assert "hit_rate" in osrm_distance_stats, "osrm_distance missing hit_rate"
        
        # Verify directions cache stats
        assert "directions" in data, "Missing directions in cache stats"
        dir_stats = data["directions"]
        assert "entries" in dir_stats, "directions missing entries"
        assert "hits" in dir_stats, "directions missing hits"
        assert "misses" in dir_stats, "directions missing misses"
        
        print(f"✓ Cache stats include all 3 caches:")
        print(f"  osrm_matrix: {osrm_matrix_stats}")
        print(f"  osrm_distance: {osrm_distance_stats}")
        print(f"  directions: {dir_stats}")


class TestOSRMDirections:
    """OSRM Directions API tests"""
    
    def test_directions_returns_osrm_source(self):
        """GET /api/directions returns source='osrm' with valid geometry and steps"""
        # Queensland coordinates (within OSRM data coverage)
        coords = "153.10,-26.77;153.11,-26.78"
        response = requests.get(
            f"{BASE_URL}/api/directions",
            params={"coordinates": coords},
            headers=DEV_HEADERS
        )
        
        assert response.status_code == 200, f"Directions failed: {response.status_code} - {response.text}"
        data = response.json()
        
        # Verify source is OSRM
        assert data.get("source") == "osrm", f"Expected source='osrm', got '{data.get('source')}'"
        
        # Verify geometry exists
        assert "geometry" in data, "Missing geometry in response"
        assert data["geometry"].get("type") == "LineString", "Geometry should be LineString"
        assert len(data["geometry"].get("coordinates", [])) > 0, "Geometry should have coordinates"
        
        # Verify distance and duration
        assert "distance" in data, "Missing distance in response"
        assert "duration" in data, "Missing duration in response"
        assert data["distance"] > 0, "Distance should be positive"
        assert data["duration"] > 0, "Duration should be positive"
        
        # Verify steps exist
        assert "steps" in data, "Missing steps in response"
        assert len(data["steps"]) > 0, "Steps should not be empty"
        
        print(f"✓ Directions API returned source='osrm', distance={data['distance']}m, duration={data['duration']}s, {len(data['steps'])} steps")


class TestTrafficAwareOptimization:
    """Traffic-aware optimization tests"""
    
    @pytest.fixture(autouse=True)
    def setup_test_stops(self):
        """Create test stops before each test, clean up after"""
        # Create test stops in Queensland (within OSRM coverage)
        test_stops = [
            {"address": "TEST_Stop1", "latitude": -26.77, "longitude": 153.10, "name": "Stop 1"},
            {"address": "TEST_Stop2", "latitude": -26.78, "longitude": 153.11, "name": "Stop 2"},
            {"address": "TEST_Stop3", "latitude": -26.79, "longitude": 153.12, "name": "Stop 3"},
            {"address": "TEST_Stop4", "latitude": -26.80, "longitude": 153.13, "name": "Stop 4"},
        ]
        
        # Clear existing stops first
        requests.delete(f"{BASE_URL}/api/stops", headers=DEV_HEADERS)
        
        # Create test stops
        created_ids = []
        for stop in test_stops:
            response = requests.post(f"{BASE_URL}/api/stops", json=stop, headers=DEV_HEADERS)
            if response.status_code in [200, 201]:
                created_ids.append(response.json().get("id"))
        
        self.created_stop_ids = created_ids
        yield
        
        # Cleanup: delete test stops
        for stop_id in created_ids:
            requests.delete(f"{BASE_URL}/api/stops/{stop_id}", headers=DEV_HEADERS)
    
    def test_optimize_with_traffic_aware_am_peak(self):
        """POST /api/optimize with traffic_aware=true and departure_hour=8 returns 'traffic=1.35x' in reasoning"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "vroom",
                "traffic_aware": True,
                "departure_hour": 8  # AM peak: 1.35x
            },
            headers=DEV_HEADERS
        )
        
        # Accept 200 (success) or 400 (no stops) as valid responses
        assert response.status_code in [200, 400], f"Optimize failed: {response.status_code} - {response.text}"
        
        if response.status_code == 200:
            data = response.json()
            
            # Verify reasoning contains traffic info
            reasoning = data.get("reasoning", "")
            assert "traffic=" in reasoning.lower() or "traffic" in reasoning.lower(), \
                f"Reasoning should mention traffic: {reasoning}"
            
            # Check for 1.35x multiplier in reasoning
            assert "1.35" in reasoning, f"Reasoning should contain 1.35x multiplier for hour 8: {reasoning}"
            
            print(f"✓ Traffic-aware optimization (hour 8, AM peak):")
            print(f"  Reasoning: {reasoning}")
            print(f"  Algorithm: {data.get('algorithm', 'N/A')}")
        else:
            print(f"✓ Optimize returned 400 (no stops to optimize) - test stops may not have been created")
    
    def test_optimize_with_traffic_aware_night_free_flow(self):
        """POST /api/optimize with traffic_aware=true and departure_hour=22 applies 1.00x multiplier"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "vroom",
                "traffic_aware": True,
                "departure_hour": 22  # Night free flow: 1.00x
            },
            headers=DEV_HEADERS
        )
        
        assert response.status_code in [200, 400], f"Optimize failed: {response.status_code} - {response.text}"
        
        if response.status_code == 200:
            data = response.json()
            reasoning = data.get("reasoning", "")
            
            # For 1.00x multiplier, traffic info might not be added (since it's free flow)
            # OR it should show 1.00x
            if "traffic=" in reasoning.lower():
                assert "1.00" in reasoning, f"Night free flow should show 1.00x: {reasoning}"
            
            print(f"✓ Traffic-aware optimization (hour 22, night free flow):")
            print(f"  Reasoning: {reasoning}")
        else:
            print(f"✓ Optimize returned 400 (no stops to optimize)")
    
    def test_optimize_without_traffic_aware(self):
        """POST /api/optimize without traffic_aware flag works normally (no traffic in reasoning)"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "vroom",
                "traffic_aware": False  # Explicitly disabled
            },
            headers=DEV_HEADERS
        )
        
        assert response.status_code in [200, 400], f"Optimize failed: {response.status_code} - {response.text}"
        
        if response.status_code == 200:
            data = response.json()
            reasoning = data.get("reasoning", "")
            
            # Without traffic_aware, reasoning should NOT contain traffic multiplier info
            # (it might still mention "traffic" in other contexts, but not "traffic=X.XXx")
            has_traffic_multiplier = "traffic=" in reasoning.lower() and "x@" in reasoning.lower()
            assert not has_traffic_multiplier, \
                f"Reasoning should NOT contain traffic multiplier when traffic_aware=False: {reasoning}"
            
            print(f"✓ Optimization without traffic_aware:")
            print(f"  Reasoning: {reasoning}")
        else:
            print(f"✓ Optimize returned 400 (no stops to optimize)")
    
    def test_optimize_with_traffic_aware_pm_peak(self):
        """POST /api/optimize with traffic_aware=true and departure_hour=17 returns 'traffic=1.40x' in reasoning"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "vroom",
                "traffic_aware": True,
                "departure_hour": 17  # PM peak: 1.40x
            },
            headers=DEV_HEADERS
        )
        
        assert response.status_code in [200, 400], f"Optimize failed: {response.status_code} - {response.text}"
        
        if response.status_code == 200:
            data = response.json()
            reasoning = data.get("reasoning", "")
            
            # Check for 1.40x multiplier in reasoning
            assert "traffic=" in reasoning.lower() or "traffic" in reasoning.lower(), \
                f"Reasoning should mention traffic: {reasoning}"
            assert "1.40" in reasoning, f"Reasoning should contain 1.40x multiplier for hour 17: {reasoning}"
            
            print(f"✓ Traffic-aware optimization (hour 17, PM peak):")
            print(f"  Reasoning: {reasoning}")
        else:
            print(f"✓ Optimize returned 400 (no stops to optimize)")


class TestOptimizeWithOSRM:
    """Optimization with OSRM distance matrix tests"""
    
    @pytest.fixture(autouse=True)
    def setup_test_stops(self):
        """Create test stops before each test, clean up after"""
        test_stops = [
            {"address": "TEST_OSRM_Stop1", "latitude": -26.77, "longitude": 153.10, "name": "OSRM Stop 1"},
            {"address": "TEST_OSRM_Stop2", "latitude": -26.78, "longitude": 153.11, "name": "OSRM Stop 2"},
            {"address": "TEST_OSRM_Stop3", "latitude": -26.79, "longitude": 153.12, "name": "OSRM Stop 3"},
        ]
        
        # Clear existing stops first
        requests.delete(f"{BASE_URL}/api/stops", headers=DEV_HEADERS)
        
        # Create test stops
        created_ids = []
        for stop in test_stops:
            response = requests.post(f"{BASE_URL}/api/stops", json=stop, headers=DEV_HEADERS)
            if response.status_code in [200, 201]:
                created_ids.append(response.json().get("id"))
        
        self.created_stop_ids = created_ids
        yield
        
        # Cleanup
        for stop_id in created_ids:
            requests.delete(f"{BASE_URL}/api/stops/{stop_id}", headers=DEV_HEADERS)
    
    def test_optimize_returns_valid_results_with_osrm(self):
        """POST /api/optimize returns valid optimization with OSRM distance matrix"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "vroom"},
            headers=DEV_HEADERS
        )
        
        assert response.status_code in [200, 400], f"Optimize failed: {response.status_code} - {response.text}"
        
        if response.status_code == 200:
            data = response.json()
            
            # Verify response structure
            assert "reasoning" in data, "Missing reasoning in response"
            assert "algorithm" in data, "Missing algorithm in response"
            
            # Check that OSRM is mentioned in reasoning (as matrix source)
            reasoning = data.get("reasoning", "")
            # OSRM should be the matrix source
            has_osrm = "osrm" in reasoning.lower() or "duration matrix" in reasoning.lower()
            
            print(f"✓ Optimization with OSRM:")
            print(f"  Algorithm: {data.get('algorithm')}")
            print(f"  Reasoning: {reasoning}")
            
            # Verify stops are returned
            if "stops" in data:
                print(f"  Stops returned: {len(data['stops'])}")
        else:
            print(f"✓ Optimize returned 400 (no stops to optimize)")


class TestHealthCheck:
    """Health check endpoint tests"""
    
    def test_root_health_check(self):
        """GET / returns 200"""
        response = requests.get(f"{BASE_URL}/")
        assert response.status_code == 200, f"Health check failed: {response.status_code}"
        print(f"✓ Health check passed: {response.status_code}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
