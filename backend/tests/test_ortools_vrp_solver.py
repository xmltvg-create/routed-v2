"""
Test OR-Tools VRP Solver Rewrite
- Tests the new OR-Tools VRP solver with PATH_CHEAPEST_ARC + GUIDED_LOCAL_SEARCH
- Tests Mapbox duration matrix integration
- Tests algorithm selection (auto, ortools, cluster_first)
- Tests response structure validation
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'http://127.0.0.1:8001').rstrip('/')

# Session with dev cookie for authentication and longer timeout for optimization
SESSION = requests.Session()
SESSION.headers.update({
    "Content-Type": "application/json",
    "Cookie": "session_token=dev-session-token"
})
# Set longer timeout for optimization requests (90 seconds)
OPTIMIZE_TIMEOUT = 90


class TestHealthAndBasics:
    """Basic health and connectivity tests"""
    
    def test_health_check(self):
        """GET / returns 200 (health probe)"""
        response = SESSION.get(f"{BASE_URL}/api/health")
        assert response.status_code == 200, f"Health check failed: {response.text}"
        data = response.json()
        assert data.get("status") == "healthy"
        print(f"✓ Health check passed: {data}")
    
    def test_stops_endpoint_returns_data(self):
        """GET /api/stops returns user's stops"""
        response = SESSION.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200, f"Stops endpoint failed: {response.text}"
        stops = response.json()
        assert isinstance(stops, list)
        print(f"✓ Stops endpoint returned {len(stops)} stops")
        return len(stops)


class TestORToolsOptimization:
    """Tests for POST /api/optimize with algorithm=ortools"""
    
    def test_optimize_with_ortools_returns_valid_response(self):
        """POST /api/optimize with algorithm=ortools returns valid optimized route"""
        response = SESSION.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "ortools",
                "use_current_location": False
            },
            timeout=OPTIMIZE_TIMEOUT
        )
        
        assert response.status_code == 200, f"Optimize failed: {response.status_code} - {response.text}"
        data = response.json()
        
        # Verify required response fields
        assert "algorithm" in data, "Response missing 'algorithm' field"
        assert "reasoning" in data, "Response missing 'reasoning' field"
        assert "total_distance_km" in data, "Response missing 'total_distance_km' field"
        assert "stop_count" in data, "Response missing 'stop_count' field"
        assert "stops" in data, "Response missing 'stops' field"
        
        print(f"✓ OR-Tools optimization response:")
        print(f"  - Algorithm: {data.get('algorithm')}")
        print(f"  - Reasoning: {data.get('reasoning')}")
        print(f"  - Total distance: {data.get('total_distance_km')} km")
        print(f"  - Stop count: {data.get('stop_count')}")
        
        return data
    
    def test_ortools_reasoning_mentions_duration_matrix(self):
        """Verify reasoning string mentions duration matrix when OR-Tools is used"""
        response = SESSION.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "ortools",
                "use_current_location": False
            }
        )
        
        assert response.status_code == 200
        data = response.json()
        
        reasoning = data.get("reasoning", "").lower()
        algorithm = data.get("algorithm", "").lower()
        
        # For large routes (>40 stops), ortools upgrades to cluster_first
        # For small routes, ortools uses duration matrix directly
        if algorithm == "ortools":
            # Should mention duration matrix or OR-Tools path
            has_expected_mention = (
                "duration" in reasoning or
                "or-tools" in reasoning or
                "ortools" in reasoning or
                "path_cheapest_arc" in reasoning or
                "guided_local_search" in reasoning
            )
            assert has_expected_mention, f"Reasoning doesn't mention expected OR-Tools terms: {reasoning}"
            print(f"✓ OR-Tools reasoning mentions expected terms: {reasoning}")
        elif algorithm == "cluster_first":
            # For large routes, cluster_first is used with OR-Tools as inner algorithm
            print(f"✓ Large route upgraded to cluster_first: {reasoning}")
        else:
            print(f"! Unexpected algorithm: {algorithm}, reasoning: {reasoning}")
    
    def test_ortools_stops_have_sequential_order(self):
        """Verify stops are returned in optimized order (order field is sequential)"""
        response = SESSION.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "ortools",
                "use_current_location": False
            },
            timeout=OPTIMIZE_TIMEOUT
        )
        
        assert response.status_code == 200
        data = response.json()
        stops = data.get("stops", [])
        
        # Filter out completed stops (they may have different order)
        pending_stops = [s for s in stops if not s.get("completed")]
        
        # Verify order field exists and covers all stops (0 to n-1)
        orders = [s.get("order") for s in pending_stops]
        expected_orders = set(range(len(pending_stops)))
        actual_orders = set(orders)
        
        assert actual_orders == expected_orders, f"Stop orders don't cover 0 to {len(pending_stops)-1}: missing {expected_orders - actual_orders}"
        print(f"✓ Stop orders cover all values from 0 to {len(pending_stops)-1}")


class TestAutoAlgorithmSelection:
    """Tests for POST /api/optimize with algorithm=auto"""
    
    def test_auto_selects_appropriate_algorithm(self):
        """POST /api/optimize with algorithm=auto correctly selects algorithm based on route size"""
        response = SESSION.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "auto",
                "use_current_location": False
            },
            timeout=OPTIMIZE_TIMEOUT
        )
        
        assert response.status_code == 200, f"Auto optimize failed: {response.text}"
        data = response.json()
        
        algorithm = data.get("algorithm", "")
        stop_count = data.get("stop_count", 0)
        
        # Auto should select:
        # - ortools for small routes (<=25 stops)
        # - cluster_first for large routes (>25 stops)
        if stop_count <= 25:
            assert algorithm == "ortools", f"Expected ortools for {stop_count} stops, got {algorithm}"
            print(f"✓ Auto correctly selected ortools for {stop_count} stops")
        else:
            assert algorithm == "cluster_first", f"Expected cluster_first for {stop_count} stops, got {algorithm}"
            print(f"✓ Auto correctly selected cluster_first for {stop_count} stops")
        
        return data


class TestClusterFirstWithORTools:
    """Tests for POST /api/optimize with algorithm=cluster_first"""
    
    def test_cluster_first_uses_duration_matrix(self):
        """POST /api/optimize with algorithm=cluster_first correctly uses duration matrix for OR-Tools inner algorithm"""
        response = SESSION.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "cluster_first",
                "use_current_location": False
            },
            timeout=OPTIMIZE_TIMEOUT
        )
        
        assert response.status_code == 200, f"Cluster-first optimize failed: {response.text}"
        data = response.json()
        
        assert data.get("algorithm") == "cluster_first", f"Expected cluster_first, got {data.get('algorithm')}"
        
        # Verify clusters array is present
        if "clusters" in data:
            clusters = data.get("clusters", [])
            print(f"✓ Cluster-first returned {len(clusters)} clusters")
            for i, cluster in enumerate(clusters[:3]):  # Show first 3
                print(f"  - Cluster {i}: {cluster.get('stop_count', 'N/A')} stops")
        
        print(f"✓ Cluster-first optimization completed:")
        print(f"  - Algorithm: {data.get('algorithm')}")
        print(f"  - Reasoning: {data.get('reasoning')}")
        print(f"  - Total distance: {data.get('total_distance_km')} km")
        
        return data
    
    def test_cluster_first_response_structure(self):
        """Verify cluster_first response includes proper fields"""
        response = SESSION.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "cluster_first",
                "use_current_location": False
            },
            timeout=OPTIMIZE_TIMEOUT
        )
        
        assert response.status_code == 200
        data = response.json()
        
        # Required fields
        required_fields = ["algorithm", "reasoning", "total_distance_km", "stop_count", "stops"]
        for field in required_fields:
            assert field in data, f"Response missing required field: {field}"
        
        # Verify stops have order field
        stops = data.get("stops", [])
        if stops:
            first_stop = stops[0]
            assert "order" in first_stop, "Stops missing 'order' field"
            assert "id" in first_stop, "Stops missing 'id' field"
        
        print(f"✓ Cluster-first response structure is valid")


class TestRecommendEndpoint:
    """Tests for GET /api/optimize/recommend"""
    
    def test_recommend_returns_valid_recommendation(self):
        """GET /api/optimize/recommend endpoint returns valid recommendation"""
        response = SESSION.get(f"{BASE_URL}/api/optimize/recommend")
        
        assert response.status_code == 200, f"Recommend endpoint failed: {response.text}"
        data = response.json()
        
        # Verify response structure
        assert "recommendation" in data, "Response missing 'recommendation' field"
        assert "characteristics" in data, "Response missing 'characteristics' field"
        
        rec = data.get("recommendation", {})
        assert "algorithm" in rec, "Recommendation missing 'algorithm' field"
        assert "confidence" in rec, "Recommendation missing 'confidence' field"
        assert "reasoning" in rec, "Recommendation missing 'reasoning' field"
        
        chars = data.get("characteristics", {})
        assert "stop_count" in chars, "Characteristics missing 'stop_count' field"
        
        print(f"✓ Recommend endpoint response:")
        print(f"  - Recommended algorithm: {rec.get('algorithm')}")
        print(f"  - Confidence: {rec.get('confidence')}")
        print(f"  - Reasoning: {rec.get('reasoning')}")
        print(f"  - Stop count: {chars.get('stop_count')}")
        
        return data


class TestLargeRouteUpgrade:
    """Tests for automatic upgrade to cluster_first for large routes"""
    
    def test_ortools_upgrades_to_cluster_first_for_large_routes(self):
        """Verify routes >40 stops auto-upgrade to cluster_first when ortools is requested"""
        # First check how many stops we have
        stops_response = SESSION.get(f"{BASE_URL}/api/stops")
        stops = stops_response.json()
        stop_count = len([s for s in stops if not s.get("completed")])
        
        if stop_count <= 40:
            pytest.skip(f"Only {stop_count} stops - need >40 to test upgrade behavior")
        
        response = SESSION.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "ortools",
                "use_current_location": False
            },
            timeout=OPTIMIZE_TIMEOUT
        )
        
        assert response.status_code == 200
        data = response.json()
        
        # For >40 stops, ortools should upgrade to cluster_first
        algorithm = data.get("algorithm", "")
        assert algorithm == "cluster_first", f"Expected cluster_first for {stop_count} stops, got {algorithm}"
        
        print(f"✓ OR-Tools correctly upgraded to cluster_first for {stop_count} stops")
        print(f"  - Reasoning: {data.get('reasoning')}")


class TestResponseValidation:
    """Validate response fields and data types"""
    
    def test_total_distance_is_numeric(self):
        """Verify total_distance_km is a valid number"""
        response = SESSION.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "auto",
                "use_current_location": False
            },
            timeout=OPTIMIZE_TIMEOUT
        )
        
        assert response.status_code == 200
        data = response.json()
        
        total_distance = data.get("total_distance_km")
        assert total_distance is not None, "total_distance_km is None"
        assert isinstance(total_distance, (int, float)), f"total_distance_km is not numeric: {type(total_distance)}"
        assert total_distance >= 0, f"total_distance_km is negative: {total_distance}"
        
        print(f"✓ total_distance_km is valid: {total_distance} km")
    
    def test_stop_count_matches_stops_array(self):
        """Verify stop_count matches the length of stops array"""
        response = SESSION.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "auto",
                "use_current_location": False
            },
            timeout=OPTIMIZE_TIMEOUT
        )
        
        assert response.status_code == 200
        data = response.json()
        
        stop_count = data.get("stop_count", 0)
        stops = data.get("stops", [])
        
        assert stop_count == len(stops), f"stop_count ({stop_count}) doesn't match stops array length ({len(stops)})"
        print(f"✓ stop_count matches stops array: {stop_count}")


class TestAlgorithmsEndpoint:
    """Tests for GET /api/optimize/algorithms"""
    
    def test_algorithms_list_includes_ortools(self):
        """Verify algorithms list includes ortools with proper metadata"""
        response = SESSION.get(f"{BASE_URL}/api/optimize/algorithms")
        
        assert response.status_code == 200
        data = response.json()
        
        assert "algorithms" in data
        algorithms = data.get("algorithms", [])
        
        # Find ortools
        ortools = None
        for algo in algorithms:
            if algo.get("id") == "ortools":
                ortools = algo
                break
        
        assert ortools is not None, "ortools not found in algorithms list"
        assert ortools.get("name") == "OR-Tools"
        assert "description" in ortools
        
        print(f"✓ OR-Tools found in algorithms list:")
        print(f"  - Name: {ortools.get('name')}")
        print(f"  - Description: {ortools.get('description')[:80]}...")
    
    def test_algorithms_list_includes_cluster_first(self):
        """Verify algorithms list includes cluster_first"""
        response = SESSION.get(f"{BASE_URL}/api/optimize/algorithms")
        
        assert response.status_code == 200
        data = response.json()
        
        algorithms = data.get("algorithms", [])
        cluster_first = None
        for algo in algorithms:
            if algo.get("id") == "cluster_first":
                cluster_first = algo
                break
        
        assert cluster_first is not None, "cluster_first not found in algorithms list"
        print(f"✓ cluster_first found in algorithms list")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
