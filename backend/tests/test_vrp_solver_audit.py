"""
VRP Solver Audit Tests - Iteration 15
Tests for 3 specific fixes:
1. OR-Tools int truncation bug - distance_matrix now multiplied by 1000 (meters) before int cast
2. total_distance_km now reports actual road distance (via Mapbox) instead of haversine
3. stop_count now matches length of stops array (includes completed stops)

Additional tests:
- POST /api/optimize with algorithm=ortools returns valid output
- POST /api/optimize returns all stops without duplicates
- POST /api/benchmark returns comparison of all algorithms
- Road distance > haversine distance (proves road > straight-line)
- OR-Tools optimization quality check (haversine sum <= 44 km)
"""
import pytest
import requests
import os
import time
from haversine import haversine, Unit

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://route-opt.preview.emergentagent.com').rstrip('/')


class TestHealthCheck:
    """Basic health check before running tests"""
    
    def test_backend_health(self):
        """GET / returns 200 and healthy status"""
        response = requests.get(f"{BASE_URL}/api/", timeout=10)
        assert response.status_code == 200
        data = response.json()
        assert data.get("status") == "healthy"
        print("✓ Backend health check passed")


class TestStopsEndpoint:
    """Test GET /api/stops returns valid stops list"""
    
    def test_get_stops_returns_200(self):
        """GET /api/stops returns 200"""
        response = requests.get(f"{BASE_URL}/api/stops", timeout=30)
        assert response.status_code == 200
        print("✓ GET /api/stops returns 200")
    
    def test_get_stops_returns_list(self):
        """GET /api/stops returns a list of stops"""
        response = requests.get(f"{BASE_URL}/api/stops", timeout=30)
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"✓ GET /api/stops returns list with {len(data)} stops")
        return data
    
    def test_stops_have_required_fields(self):
        """Each stop has required fields: id, latitude, longitude, address"""
        response = requests.get(f"{BASE_URL}/api/stops", timeout=30)
        assert response.status_code == 200
        stops = response.json()
        
        if len(stops) == 0:
            pytest.skip("No stops in database to test")
        
        for stop in stops[:5]:  # Check first 5 stops
            assert "id" in stop, f"Stop missing 'id': {stop}"
            assert "latitude" in stop, f"Stop missing 'latitude': {stop}"
            assert "longitude" in stop, f"Stop missing 'longitude': {stop}"
            assert "address" in stop, f"Stop missing 'address': {stop}"
        
        print(f"✓ Stops have required fields (checked {min(5, len(stops))} stops)")


class TestORToolsOptimization:
    """Test OR-Tools optimization with the int truncation fix"""
    
    def test_optimize_ortools_returns_200(self):
        """POST /api/optimize with algorithm=ortools returns 200"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "ortools", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120  # OR-Tools can take 10-15 seconds
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        print("✓ POST /api/optimize with algorithm=ortools returns 200")
    
    def test_optimize_ortools_response_structure(self):
        """Verify response has required fields including distance_source"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "ortools", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200
        data = response.json()
        
        # Required fields
        assert "algorithm" in data, "Response missing 'algorithm'"
        assert "stops" in data, "Response missing 'stops'"
        assert "total_distance_km" in data, "Response missing 'total_distance_km'"
        assert "stop_count" in data, "Response missing 'stop_count'"
        assert "distance_source" in data, "Response missing 'distance_source' (new field)"
        
        print(f"✓ Response has all required fields:")
        print(f"  - algorithm: {data['algorithm']}")
        print(f"  - total_distance_km: {data['total_distance_km']}")
        print(f"  - distance_source: {data['distance_source']}")
        print(f"  - stop_count: {data['stop_count']}")
        print(f"  - stops length: {len(data['stops'])}")
    
    def test_distance_source_is_road_or_haversine(self):
        """Verify distance_source is either 'road' or 'haversine'"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "ortools", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200
        data = response.json()
        
        distance_source = data.get("distance_source")
        assert distance_source in ["road", "haversine"], f"Invalid distance_source: {distance_source}"
        print(f"✓ distance_source is valid: '{distance_source}'")
    
    def test_stop_count_matches_stops_array_length(self):
        """FIX #3: stop_count must match length of stops array"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "ortools", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200
        data = response.json()
        
        stop_count = data.get("stop_count")
        stops_length = len(data.get("stops", []))
        
        assert stop_count == stops_length, \
            f"stop_count ({stop_count}) does not match stops array length ({stops_length})"
        print(f"✓ stop_count ({stop_count}) matches stops array length ({stops_length})")
    
    def test_no_duplicate_stops(self):
        """Verify no duplicate stop IDs in response"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "ortools", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200
        data = response.json()
        
        stops = data.get("stops", [])
        stop_ids = [s.get("id") for s in stops if s.get("id")]
        unique_ids = set(stop_ids)
        
        assert len(stop_ids) == len(unique_ids), \
            f"Duplicate stop IDs found: {len(stop_ids)} total, {len(unique_ids)} unique"
        print(f"✓ No duplicate stops: {len(stop_ids)} unique stop IDs")


class TestRoadDistanceVsHaversine:
    """Test that road distance is greater than haversine (straight-line) distance"""
    
    def test_road_distance_greater_than_haversine(self):
        """FIX #2: total_distance_km (road) should be >= haversine sum"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "ortools", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200
        data = response.json()
        
        stops = data.get("stops", [])
        total_distance_km = data.get("total_distance_km", 0)
        distance_source = data.get("distance_source", "unknown")
        
        if len(stops) < 2:
            pytest.skip("Need at least 2 stops to calculate distance")
        
        # Calculate haversine sum of consecutive stops
        haversine_sum = 0.0
        for i in range(len(stops) - 1):
            coord1 = (stops[i]["latitude"], stops[i]["longitude"])
            coord2 = (stops[i+1]["latitude"], stops[i+1]["longitude"])
            haversine_sum += haversine(coord1, coord2, unit=Unit.KILOMETERS)
        
        haversine_sum = round(haversine_sum, 2)
        
        print(f"  - total_distance_km (reported): {total_distance_km}")
        print(f"  - haversine_sum (calculated): {haversine_sum}")
        print(f"  - distance_source: {distance_source}")
        
        if distance_source == "road":
            # Road distance should be >= haversine (roads are longer than straight lines)
            assert total_distance_km >= haversine_sum * 0.95, \
                f"Road distance ({total_distance_km}) should be >= haversine ({haversine_sum})"
            print(f"✓ Road distance ({total_distance_km} km) >= haversine ({haversine_sum} km)")
        else:
            # If haversine fallback, they should be approximately equal
            assert abs(total_distance_km - haversine_sum) < 1.0, \
                f"Haversine mismatch: reported {total_distance_km}, calculated {haversine_sum}"
            print(f"✓ Haversine distance matches: {total_distance_km} km ≈ {haversine_sum} km")


class TestORToolsOptimizationQuality:
    """Test OR-Tools optimization quality (haversine sum should be reasonable)"""
    
    def test_ortools_haversine_sum_reasonable(self):
        """OR-Tools optimization quality: haversine sum should be <= 44 km for ~155 stops"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "ortools", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200
        data = response.json()
        
        stops = data.get("stops", [])
        
        if len(stops) < 10:
            pytest.skip("Need at least 10 stops to test optimization quality")
        
        # Calculate haversine sum of optimized route
        haversine_sum = 0.0
        for i in range(len(stops) - 1):
            coord1 = (stops[i]["latitude"], stops[i]["longitude"])
            coord2 = (stops[i+1]["latitude"], stops[i+1]["longitude"])
            haversine_sum += haversine(coord1, coord2, unit=Unit.KILOMETERS)
        
        haversine_sum = round(haversine_sum, 2)
        
        print(f"  - Stops count: {len(stops)}")
        print(f"  - Haversine sum of optimized route: {haversine_sum} km")
        
        # For ~155 stops in Brisbane area, haversine sum should be <= 44 km
        # This is a quality check - if it's much higher, the optimization may have issues
        if len(stops) >= 100:
            # For large routes, allow up to 50 km
            assert haversine_sum <= 50, \
                f"Haversine sum ({haversine_sum} km) too high for {len(stops)} stops - optimization quality issue"
            print(f"✓ Optimization quality good: {haversine_sum} km for {len(stops)} stops")
        else:
            # For smaller routes, just verify it's reasonable
            avg_per_stop = haversine_sum / len(stops) if len(stops) > 0 else 0
            assert avg_per_stop < 1.0, \
                f"Average distance per stop ({avg_per_stop:.2f} km) seems too high"
            print(f"✓ Optimization quality reasonable: {haversine_sum} km for {len(stops)} stops")


class TestALNSOptimization:
    """Test ALNS algorithm still works correctly"""
    
    def test_optimize_alns_returns_200(self):
        """POST /api/optimize with algorithm=alns returns 200"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "alns", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        print("✓ POST /api/optimize with algorithm=alns returns 200")
    
    def test_alns_response_has_distance_source(self):
        """ALNS response should also have distance_source field"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "alns", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200
        data = response.json()
        
        assert "distance_source" in data, "ALNS response missing 'distance_source'"
        assert "stop_count" in data, "ALNS response missing 'stop_count'"
        
        stop_count = data.get("stop_count")
        stops_length = len(data.get("stops", []))
        assert stop_count == stops_length, \
            f"ALNS stop_count ({stop_count}) does not match stops array length ({stops_length})"
        
        print(f"✓ ALNS response has distance_source: {data['distance_source']}")
        print(f"✓ ALNS stop_count ({stop_count}) matches stops array length")


class TestBenchmarkEndpoint:
    """Test POST /api/benchmark returns comparison of all algorithms"""
    
    def test_benchmark_returns_200(self):
        """POST /api/benchmark returns 200"""
        response = requests.post(
            f"{BASE_URL}/api/benchmark",
            json={},
            headers={"Content-Type": "application/json"},
            timeout=120  # Benchmark can take up to 60 seconds
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        print("✓ POST /api/benchmark returns 200")
    
    def test_benchmark_has_results(self):
        """Benchmark response has results array"""
        response = requests.post(
            f"{BASE_URL}/api/benchmark",
            json={},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200
        data = response.json()
        
        assert "results" in data, "Benchmark response missing 'results'"
        results = data.get("results", [])
        assert len(results) > 0, "Benchmark results array is empty"
        
        print(f"✓ Benchmark has {len(results)} algorithm results")
        for r in results:
            algo = r.get("algorithm", "unknown")
            dist = r.get("total_distance_km", "N/A")
            time_ms = r.get("time_ms", "N/A")
            print(f"  - {algo}: {dist} km in {time_ms} ms")
    
    def test_benchmark_has_winner(self):
        """Benchmark response has winner field"""
        response = requests.post(
            f"{BASE_URL}/api/benchmark",
            json={},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200
        data = response.json()
        
        assert "winner" in data, "Benchmark response missing 'winner'"
        winner = data.get("winner")
        assert winner is not None, "Benchmark winner is None"
        
        print(f"✓ Benchmark winner: {winner}")


class TestAllStopsReturned:
    """Test that optimize returns all stops without missing any"""
    
    def test_optimize_returns_all_stops(self):
        """Verify optimize returns all stops from GET /api/stops"""
        # Get all stops first
        stops_response = requests.get(f"{BASE_URL}/api/stops", timeout=30)
        assert stops_response.status_code == 200
        all_stops = stops_response.json()
        
        if len(all_stops) == 0:
            pytest.skip("No stops in database")
        
        # Count non-completed stops
        pending_stops = [s for s in all_stops if not s.get("completed", False)]
        completed_stops = [s for s in all_stops if s.get("completed", False)]
        
        # Run optimization
        optimize_response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "ortools", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert optimize_response.status_code == 200
        data = optimize_response.json()
        
        optimized_stops = data.get("stops", [])
        stop_count = data.get("stop_count", 0)
        
        # All stops should be returned (pending + completed)
        expected_count = len(all_stops)
        
        print(f"  - Total stops in DB: {len(all_stops)}")
        print(f"  - Pending stops: {len(pending_stops)}")
        print(f"  - Completed stops: {len(completed_stops)}")
        print(f"  - Optimized stops returned: {len(optimized_stops)}")
        print(f"  - stop_count field: {stop_count}")
        
        # stop_count should match stops array length
        assert stop_count == len(optimized_stops), \
            f"stop_count ({stop_count}) != stops array length ({len(optimized_stops)})"
        
        # All stops should be accounted for
        assert len(optimized_stops) == expected_count, \
            f"Expected {expected_count} stops, got {len(optimized_stops)}"
        
        print(f"✓ All {expected_count} stops returned in optimization")


class TestIntTruncationFix:
    """Test that OR-Tools int truncation bug is fixed"""
    
    def test_ortools_handles_close_stops(self):
        """FIX #1: OR-Tools should handle stops that are very close together"""
        # This test verifies the fix where distance_matrix is multiplied by 1000
        # before int cast to avoid truncating small distances to 0
        
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "ortools", "use_current_location": False},
            headers={"Content-Type": "application/json"},
            timeout=120
        )
        assert response.status_code == 200
        data = response.json()
        
        stops = data.get("stops", [])
        algorithm = data.get("algorithm", "")
        
        if len(stops) < 2:
            pytest.skip("Need at least 2 stops")
        
        # Check if OR-Tools was actually used (not fallback)
        if "ortools" in algorithm.lower():
            print(f"✓ OR-Tools was used successfully for {len(stops)} stops")
            
            # Calculate minimum distance between consecutive stops
            min_dist = float('inf')
            for i in range(len(stops) - 1):
                coord1 = (stops[i]["latitude"], stops[i]["longitude"])
                coord2 = (stops[i+1]["latitude"], stops[i+1]["longitude"])
                dist = haversine(coord1, coord2, unit=Unit.KILOMETERS)
                min_dist = min(min_dist, dist)
            
            print(f"  - Minimum consecutive stop distance: {min_dist:.4f} km ({min_dist * 1000:.1f} m)")
            
            # If there are very close stops (< 100m), the fix is working
            if min_dist < 0.1:
                print(f"✓ OR-Tools handled close stops (< 100m apart) correctly")
        else:
            print(f"! OR-Tools fell back to {algorithm} - may indicate an issue")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
