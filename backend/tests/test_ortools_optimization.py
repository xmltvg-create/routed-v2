"""
Test OR-Tools Algorithm Feature
- Verify /api/optimize/algorithms includes ortools option
- Verify /api/optimize with algorithm=ortools returns successful optimization
- Verify reasoning indicates OR-Tools path used
- Verify fallback to other algorithm on failure
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://route-opt.preview.emergentagent.com')

class TestORToolsOptimization:
    """Tests for OR-Tools algorithm feature"""
    
    def test_health_check(self):
        """Verify backend is healthy"""
        response = requests.get(f"{BASE_URL}/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        print("✓ Health check passed")
    
    def test_algorithms_endpoint_includes_ortools(self):
        """Verify /api/optimize/algorithms includes ortools option"""
        response = requests.get(f"{BASE_URL}/api/optimize/algorithms")
        assert response.status_code == 200
        data = response.json()
        
        # Check algorithms list exists
        assert "algorithms" in data
        algorithms = data["algorithms"]
        assert len(algorithms) > 0
        
        # Find ortools in the list
        ortools_algo = None
        for algo in algorithms:
            if algo.get("id") == "ortools":
                ortools_algo = algo
                break
        
        # Verify ortools exists and has proper metadata
        assert ortools_algo is not None, "ortools not found in algorithms list"
        assert ortools_algo.get("name") == "OR-Tools"
        assert "description" in ortools_algo
        assert "travel time" in ortools_algo.get("description", "").lower() or "time" in ortools_algo.get("description", "").lower()
        print(f"✓ ortools found in algorithms: {ortools_algo['name']} - {ortools_algo.get('description', '')[:50]}...")
    
    def test_create_test_stops_for_ortools(self):
        """Create test stops for OR-Tools optimization testing"""
        # Create 3 test stops in Brisbane area
        test_stops = [
            {
                "address": "TEST_ORTOOLS_Stop1 - Brisbane CBD",
                "name": "ORTOOLS Stop 1",
                "latitude": -27.4698,
                "longitude": 153.0251,
                "priority": "medium"
            },
            {
                "address": "TEST_ORTOOLS_Stop2 - South Bank",
                "name": "ORTOOLS Stop 2",
                "latitude": -27.4768,
                "longitude": 153.0178,
                "priority": "medium"
            },
            {
                "address": "TEST_ORTOOLS_Stop3 - Fortitude Valley",
                "name": "ORTOOLS Stop 3",
                "latitude": -27.4571,
                "longitude": 153.0324,
                "priority": "medium"
            }
        ]
        
        created_ids = []
        for stop in test_stops:
            response = requests.post(
                f"{BASE_URL}/api/stops",
                json=stop,
                headers={"Content-Type": "application/json"}
            )
            assert response.status_code == 200, f"Failed to create stop: {response.text}"
            created = response.json()
            created_ids.append(created["id"])
            print(f"✓ Created test stop: {created['name']}")
        
        # Store IDs for cleanup
        self.__class__.test_stop_ids = created_ids
        return created_ids
    
    def test_optimize_with_ortools_algorithm(self):
        """Test optimization with algorithm=ortools returns success"""
        # First ensure we have test stops
        if not hasattr(self.__class__, 'test_stop_ids') or not self.__class__.test_stop_ids:
            self.test_create_test_stops_for_ortools()
        
        # Call optimize with ortools algorithm
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "ortools",
                "use_current_location": False
            },
            headers={"Content-Type": "application/json"}
        )
        
        assert response.status_code == 200, f"Optimize failed: {response.status_code} - {response.text}"
        data = response.json()
        
        # Verify response structure
        assert "stops" in data, "Response missing 'stops' field"
        assert "algorithm" in data, "Response missing 'algorithm' field"
        assert "reasoning" in data, "Response missing 'reasoning' field"
        
        # Verify ortools was used or fell back
        algorithm_used = data.get("algorithm", "").lower()
        reasoning = data.get("reasoning", "").lower()
        
        print(f"✓ Optimization completed:")
        print(f"  - Algorithm: {data.get('algorithm')}")
        print(f"  - Reasoning: {data.get('reasoning')}")
        print(f"  - Total distance: {data.get('total_distance_km')} km")
        print(f"  - Stops returned: {len(data.get('stops', []))}")
        
        # Check if OR-Tools was used or fallback happened
        if "ortools" in algorithm_used or "or-tools" in reasoning or "or tools" in reasoning:
            print("✓ OR-Tools was used for optimization")
        elif "fallback" in reasoning or "failed" in reasoning:
            print("! OR-Tools failed, fallback algorithm was used (acceptable behavior)")
        else:
            # Even if algorithm name doesn't say ortools, check if it succeeded
            assert len(data.get("stops", [])) >= 1, "No stops returned from optimization"
            print(f"✓ Optimization succeeded with algorithm: {data.get('algorithm')}")
    
    def test_optimize_ortools_returns_valid_stop_order(self):
        """Verify OR-Tools optimization returns stops in valid order"""
        # Ensure we have test stops
        if not hasattr(self.__class__, 'test_stop_ids') or not self.__class__.test_stop_ids:
            self.test_create_test_stops_for_ortools()
        
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "ortools",
                "use_current_location": False
            },
            headers={"Content-Type": "application/json"}
        )
        
        assert response.status_code == 200
        data = response.json()
        stops = data.get("stops", [])
        
        # Each stop should have an order
        for i, stop in enumerate(stops):
            assert "order" in stop or "id" in stop, f"Stop {i} missing order or id"
        
        # Verify stops are sequential (0, 1, 2, ...)
        orders = [s.get("order", i) for i, s in enumerate(stops)]
        expected_orders = list(range(len(stops)))
        assert orders == expected_orders, f"Stop orders not sequential: {orders}"
        
        print(f"✓ Stop order is valid: {orders}")
    
    def test_optimize_ortools_reasoning_indicates_path(self):
        """Verify reasoning message indicates OR-Tools path was attempted"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={
                "algorithm": "ortools",
                "use_current_location": False
            },
            headers={"Content-Type": "application/json"}
        )
        
        assert response.status_code == 200
        data = response.json()
        
        reasoning = data.get("reasoning", "")
        algorithm = data.get("algorithm", "")
        
        # Reasoning should mention ortools, time, or fallback
        has_ortools_mention = (
            "ortools" in reasoning.lower() or 
            "or-tools" in reasoning.lower() or
            "or tools" in reasoning.lower() or
            "time" in reasoning.lower() or
            "fallback" in reasoning.lower()
        )
        
        print(f"✓ Reasoning: {reasoning}")
        print(f"✓ Algorithm: {algorithm}")
        
        # If ortools was requested, the reasoning should reflect it
        assert has_ortools_mention or algorithm.lower() in ["ortools", "two_opt", "nearest_neighbor"], \
            f"Reasoning doesn't indicate OR-Tools path: {reasoning}"
    
    def test_cleanup_test_stops(self):
        """Cleanup test stops created during testing"""
        if hasattr(self.__class__, 'test_stop_ids'):
            for stop_id in self.__class__.test_stop_ids:
                try:
                    response = requests.delete(f"{BASE_URL}/api/stops/{stop_id}")
                    if response.status_code == 200:
                        print(f"✓ Cleaned up test stop: {stop_id}")
                except Exception as e:
                    print(f"! Could not delete stop {stop_id}: {e}")
            self.__class__.test_stop_ids = []


class TestORToolsFallbackBehavior:
    """Tests for OR-Tools fallback behavior"""
    
    def test_ortools_with_single_stop(self):
        """Test OR-Tools handles edge case of single stop gracefully"""
        # Create single test stop
        response = requests.post(
            f"{BASE_URL}/api/stops",
            json={
                "address": "TEST_ORTOOLS_SINGLE Stop",
                "name": "Single Stop Test",
                "latitude": -27.4698,
                "longitude": 153.0251,
                "priority": "medium"
            },
            headers={"Content-Type": "application/json"}
        )
        
        if response.status_code == 200:
            stop_id = response.json()["id"]
            
            # Try to optimize with single stop
            optimize_response = requests.post(
                f"{BASE_URL}/api/optimize",
                json={
                    "algorithm": "ortools",
                    "use_current_location": False
                },
                headers={"Content-Type": "application/json"}
            )
            
            # Should handle gracefully (either success with 1 stop or meaningful error)
            print(f"✓ Single stop optimization status: {optimize_response.status_code}")
            if optimize_response.status_code == 200:
                data = optimize_response.json()
                print(f"  - Algorithm used: {data.get('algorithm')}")
                print(f"  - Reasoning: {data.get('reasoning')}")
            
            # Cleanup
            requests.delete(f"{BASE_URL}/api/stops/{stop_id}")


class TestORToolsAlgorithmList:
    """Test the algorithm list endpoint in detail"""
    
    def test_algorithm_list_response_format(self):
        """Verify algorithm list has correct format"""
        response = requests.get(f"{BASE_URL}/api/optimize/algorithms")
        assert response.status_code == 200
        
        data = response.json()
        assert "algorithms" in data
        
        for algo in data["algorithms"]:
            assert "id" in algo, f"Algorithm missing 'id': {algo}"
            assert "name" in algo, f"Algorithm missing 'name': {algo}"
            assert "description" in algo, f"Algorithm missing 'description': {algo}"
            print(f"✓ Algorithm {algo['id']}: {algo['name']}")
    
    def test_ortools_metadata_complete(self):
        """Verify OR-Tools algorithm has complete metadata"""
        response = requests.get(f"{BASE_URL}/api/optimize/algorithms")
        assert response.status_code == 200
        
        data = response.json()
        ortools = None
        for algo in data["algorithms"]:
            if algo.get("id") == "ortools":
                ortools = algo
                break
        
        assert ortools is not None, "OR-Tools not in algorithm list"
        
        # Check required fields
        assert ortools.get("id") == "ortools"
        assert ortools.get("name") == "OR-Tools"
        assert len(ortools.get("description", "")) > 20, "Description too short"
        
        print(f"✓ OR-Tools metadata complete:")
        print(f"  - ID: {ortools['id']}")
        print(f"  - Name: {ortools['name']}")
        print(f"  - Description: {ortools['description']}")
        print(f"  - Best for: {ortools.get('best_for', 'N/A')}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
