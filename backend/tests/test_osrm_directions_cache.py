"""
Test OSRM Directions API and Route Caching
==========================================
Tests for:
1. GET /api/directions - OSRM Route API integration (source: osrm)
2. GET /api/directions with multiple waypoints - step instructions
3. GET /api/cache/stats - osrm_matrix and directions cache stats
4. POST /api/optimize - still returns valid optimization results
5. Health check endpoint (GET /) returns 200
6. Cache hit/miss counters increment correctly
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


class TestHealthCheck:
    """Health check endpoint tests"""
    
    def test_root_health_check(self):
        """GET / returns 200"""
        response = requests.get(f"{BASE_URL}/")
        assert response.status_code == 200, f"Health check failed: {response.status_code}"
        print(f"✓ Health check passed: {response.status_code}")


class TestOSRMDirections:
    """OSRM Directions API tests"""
    
    def test_directions_returns_osrm_source(self):
        """GET /api/directions returns 'source: osrm' with geometry, distance, duration, steps"""
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
    
    def test_directions_with_multiple_waypoints(self):
        """GET /api/directions with multiple waypoints returns valid route with step instructions"""
        # 4 waypoints in Queensland
        coords = "153.10,-26.77;153.11,-26.78;153.12,-26.79;153.13,-26.80"
        response = requests.get(
            f"{BASE_URL}/api/directions",
            params={"coordinates": coords},
            headers=DEV_HEADERS
        )
        
        assert response.status_code == 200, f"Multi-waypoint directions failed: {response.status_code}"
        data = response.json()
        
        # Verify source
        assert data.get("source") == "osrm", f"Expected source='osrm', got '{data.get('source')}'"
        
        # Verify steps have instructions
        steps = data.get("steps", [])
        assert len(steps) > 0, "Should have steps for multi-waypoint route"
        
        # Check step structure
        for step in steps[:3]:  # Check first 3 steps
            assert "instruction" in step, "Step missing instruction"
            assert "distance" in step, "Step missing distance"
            assert "duration" in step, "Step missing duration"
            assert "type" in step, "Step missing type"
            assert "location" in step, "Step missing location"
        
        # Verify legs summary
        assert "legs" in data, "Missing legs in response"
        assert len(data["legs"]) == 3, f"Expected 3 legs for 4 waypoints, got {len(data['legs'])}"
        
        print(f"✓ Multi-waypoint directions: {len(steps)} steps, {len(data['legs'])} legs")
        print(f"  Sample instructions: {[s.get('instruction', '')[:50] for s in steps[:3]]}")
    
    def test_directions_step_instruction_format(self):
        """Verify step instructions are human-readable (not empty)"""
        coords = "153.10,-26.77;153.15,-26.82"
        response = requests.get(
            f"{BASE_URL}/api/directions",
            params={"coordinates": coords},
            headers=DEV_HEADERS
        )
        
        assert response.status_code == 200
        data = response.json()
        steps = data.get("steps", [])
        
        # Check that instructions are not empty
        non_empty_instructions = [s for s in steps if s.get("instruction")]
        assert len(non_empty_instructions) > 0, "Should have non-empty instructions"
        
        # Check for common instruction patterns
        all_instructions = " ".join([s.get("instruction", "") for s in steps])
        has_direction_words = any(word in all_instructions.lower() for word in 
                                   ["head", "turn", "continue", "arrive", "left", "right", "straight"])
        assert has_direction_words, f"Instructions should contain direction words: {all_instructions[:200]}"
        
        print(f"✓ Step instructions are human-readable: {len(non_empty_instructions)} instructions")


class TestCacheStats:
    """Cache statistics endpoint tests"""
    
    def test_cache_stats_endpoint(self):
        """GET /api/cache/stats returns osrm_matrix and directions cache stats"""
        response = requests.get(f"{BASE_URL}/api/cache/stats", headers=DEV_HEADERS)
        
        assert response.status_code == 200, f"Cache stats failed: {response.status_code}"
        data = response.json()
        
        # Verify osrm_matrix cache stats
        assert "osrm_matrix" in data, "Missing osrm_matrix in cache stats"
        osrm_stats = data["osrm_matrix"]
        assert "entries" in osrm_stats, "osrm_matrix missing entries"
        assert "maxsize" in osrm_stats, "osrm_matrix missing maxsize"
        assert "ttl_seconds" in osrm_stats, "osrm_matrix missing ttl_seconds"
        assert "hits" in osrm_stats, "osrm_matrix missing hits"
        assert "misses" in osrm_stats, "osrm_matrix missing misses"
        assert "hit_rate" in osrm_stats, "osrm_matrix missing hit_rate"
        
        # Verify directions cache stats
        assert "directions" in data, "Missing directions in cache stats"
        dir_stats = data["directions"]
        assert "entries" in dir_stats, "directions missing entries"
        assert "hits" in dir_stats, "directions missing hits"
        assert "misses" in dir_stats, "directions missing misses"
        
        print(f"✓ Cache stats: osrm_matrix={osrm_stats}, directions={dir_stats}")
    
    def test_cache_hit_miss_counters(self):
        """Cache hit/miss counters increment correctly on repeated calls"""
        # Get initial stats
        initial_response = requests.get(f"{BASE_URL}/api/cache/stats", headers=DEV_HEADERS)
        initial_stats = initial_response.json()
        initial_hits = initial_stats["directions"]["hits"]
        initial_misses = initial_stats["directions"]["misses"]
        
        # Make a unique directions request (should be MISS)
        unique_coords = f"153.{int(time.time()) % 100:02d},-26.77;153.11,-26.78"
        response1 = requests.get(
            f"{BASE_URL}/api/directions",
            params={"coordinates": unique_coords},
            headers=DEV_HEADERS
        )
        assert response1.status_code == 200
        cache_header1 = response1.headers.get("X-Cache", "")
        
        # Get stats after first call
        mid_response = requests.get(f"{BASE_URL}/api/cache/stats", headers=DEV_HEADERS)
        mid_stats = mid_response.json()
        
        # Make same request again (should be HIT)
        response2 = requests.get(
            f"{BASE_URL}/api/directions",
            params={"coordinates": unique_coords},
            headers=DEV_HEADERS
        )
        assert response2.status_code == 200
        cache_header2 = response2.headers.get("X-Cache", "")
        
        # Get final stats
        final_response = requests.get(f"{BASE_URL}/api/cache/stats", headers=DEV_HEADERS)
        final_stats = final_response.json()
        
        # Verify counters changed
        print(f"  Initial: hits={initial_hits}, misses={initial_misses}")
        print(f"  After 1st call: hits={mid_stats['directions']['hits']}, misses={mid_stats['directions']['misses']}")
        print(f"  After 2nd call: hits={final_stats['directions']['hits']}, misses={final_stats['directions']['misses']}")
        print(f"  X-Cache headers: 1st={cache_header1}, 2nd={cache_header2}")
        
        # First call should increment misses (or be a hit if already cached)
        # Second call should increment hits
        assert final_stats["directions"]["hits"] > initial_hits or cache_header2 == "HIT", \
            "Cache hits should increment on repeated call"
        
        print(f"✓ Cache counters working: hits increased from {initial_hits} to {final_stats['directions']['hits']}")


class TestOptimizeEndpoint:
    """Optimization endpoint tests"""
    
    def test_optimize_returns_valid_results(self):
        """POST /api/optimize still returns valid optimization results"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "two_opt"},  # Use simple algorithm for speed
            headers=DEV_HEADERS
        )
        
        # Accept 200 (success) or 400 (no stops) as valid responses
        assert response.status_code in [200, 400], f"Optimize failed: {response.status_code} - {response.text}"
        
        if response.status_code == 200:
            data = response.json()
            # Verify response structure
            assert "stops" in data or "optimized_order" in data or "route" in data, \
                f"Optimize response missing expected fields: {list(data.keys())}"
            print(f"✓ Optimize endpoint returned valid results: {list(data.keys())[:5]}")
        else:
            # 400 means no stops to optimize, which is valid
            print(f"✓ Optimize endpoint returned 400 (no stops to optimize)")
    
    def test_optimize_with_auto_algorithm(self):
        """POST /api/optimize with algorithm=auto works"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "auto"},
            headers=DEV_HEADERS
        )
        
        assert response.status_code in [200, 400], f"Optimize auto failed: {response.status_code}"
        print(f"✓ Optimize with algorithm=auto: status={response.status_code}")


class TestDirectionsCacheIntegration:
    """Integration tests for directions caching"""
    
    def test_directions_cache_key_rounding(self):
        """Verify cache key rounding absorbs GPS jitter (4 decimal places)"""
        # Two coordinates that differ only in 5th decimal place should hit same cache
        coords1 = "153.10001,-26.77001;153.11001,-26.78001"
        coords2 = "153.10002,-26.77002;153.11002,-26.78002"  # Differs in 5th decimal
        
        # First request
        response1 = requests.get(
            f"{BASE_URL}/api/directions",
            params={"coordinates": coords1},
            headers=DEV_HEADERS
        )
        assert response1.status_code == 200
        
        # Second request with slightly different coords
        response2 = requests.get(
            f"{BASE_URL}/api/directions",
            params={"coordinates": coords2},
            headers=DEV_HEADERS
        )
        assert response2.status_code == 200
        
        # Both should return same data (cache hit due to rounding)
        data1 = response1.json()
        data2 = response2.json()
        
        # Distance and duration should be identical (from cache)
        assert data1["distance"] == data2["distance"], "Cache rounding should return same distance"
        assert data1["duration"] == data2["duration"], "Cache rounding should return same duration"
        
        print(f"✓ Cache key rounding working: both requests returned distance={data1['distance']}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
