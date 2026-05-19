"""
Test suite for Algorithm Recommendation endpoint and regression tests for benchmark/shadow features.
Tests the GET /api/optimize/recommend endpoint which analyzes route characteristics and suggests the best algorithm.
Also includes regression tests for POST /api/benchmark and POST /api/optimize shadow testing.
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://route-opt.preview.emergentagent.com').rstrip('/')


class TestRecommendationEndpoint:
    """Tests for GET /api/optimize/recommend endpoint"""

    def test_recommend_returns_200(self):
        """GET /api/optimize/recommend should return 200 OK"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        print(f"Response status: {response.status_code}")
        print(f"Response body: {response.text[:500]}")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"

    def test_recommend_has_recommendation_field(self):
        """Response should contain 'recommendation' object"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        print(f"Response data keys: {data.keys()}")
        assert "recommendation" in data, "Missing 'recommendation' field"
        
    def test_recommend_has_characteristics_field(self):
        """Response should contain 'characteristics' object"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        assert "characteristics" in data, "Missing 'characteristics' field"

    def test_recommendation_has_algorithm(self):
        """Recommendation should include 'algorithm' field"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        rec = data.get("recommendation", {})
        print(f"Recommendation: {rec}")
        assert "algorithm" in rec, "Missing 'algorithm' in recommendation"
        assert isinstance(rec["algorithm"], str), "algorithm should be a string"

    def test_recommendation_has_confidence(self):
        """Recommendation should include 'confidence' field (0-1)"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        rec = data.get("recommendation", {})
        assert "confidence" in rec, "Missing 'confidence' in recommendation"
        confidence = rec["confidence"]
        assert isinstance(confidence, (int, float)), "confidence should be numeric"
        assert 0 <= confidence <= 1, f"confidence should be 0-1, got {confidence}"

    def test_recommendation_has_reasoning(self):
        """Recommendation should include 'reasoning' field"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        rec = data.get("recommendation", {})
        assert "reasoning" in rec, "Missing 'reasoning' in recommendation"
        assert isinstance(rec["reasoning"], str), "reasoning should be a string"
        assert len(rec["reasoning"]) > 0, "reasoning should not be empty"

    def test_recommendation_has_alternatives(self):
        """Recommendation should include 'alternatives' list (if algorithm is not 'none')"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        rec = data.get("recommendation", {})
        # alternatives is optional when algorithm is 'none'
        if rec.get("algorithm") != "none":
            assert "alternatives" in rec, "Missing 'alternatives' in recommendation"
            assert isinstance(rec["alternatives"], list), "alternatives should be a list"
            print(f"Alternatives: {rec['alternatives']}")


class TestRouteCharacteristics:
    """Tests for route characteristics in recommendation response"""

    def test_characteristics_has_stop_count(self):
        """Characteristics should include 'stop_count'"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        chars = data.get("characteristics", {})
        print(f"Characteristics: {chars}")
        assert "stop_count" in chars, "Missing 'stop_count' in characteristics"
        assert isinstance(chars["stop_count"], int), "stop_count should be an integer"

    def test_characteristics_has_spread_km(self):
        """Characteristics should include 'spread_km' (geographic spread)"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        chars = data.get("characteristics", {})
        # spread_km is only present when stop_count >= 2
        if chars.get("stop_count", 0) >= 2:
            assert "spread_km" in chars, "Missing 'spread_km' in characteristics"
            assert isinstance(chars["spread_km"], (int, float)), "spread_km should be numeric"
            print(f"Geographic spread: {chars['spread_km']} km")

    def test_characteristics_has_cluster_count(self):
        """Characteristics should include 'cluster_count'"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        chars = data.get("characteristics", {})
        if chars.get("stop_count", 0) >= 2:
            assert "cluster_count" in chars, "Missing 'cluster_count' in characteristics"
            assert isinstance(chars["cluster_count"], int), "cluster_count should be an integer"
            assert chars["cluster_count"] >= 1, "cluster_count should be at least 1"
            print(f"Cluster count: {chars['cluster_count']}")

    def test_characteristics_has_complexity(self):
        """Characteristics should include 'complexity' (low/medium/high)"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        chars = data.get("characteristics", {})
        if chars.get("stop_count", 0) >= 2:
            assert "complexity" in chars, "Missing 'complexity' in characteristics"
            assert chars["complexity"] in ["low", "medium", "high"], f"Invalid complexity: {chars['complexity']}"
            print(f"Route complexity: {chars['complexity']}")

    def test_characteristics_has_cluster_ratio(self):
        """Characteristics should include 'cluster_ratio' (density metric)"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        chars = data.get("characteristics", {})
        if chars.get("stop_count", 0) >= 2:
            assert "cluster_ratio" in chars, "Missing 'cluster_ratio' in characteristics"
            assert isinstance(chars["cluster_ratio"], (int, float)), "cluster_ratio should be numeric"
            print(f"Cluster ratio: {chars['cluster_ratio']}")


class TestRecommendationLogic:
    """Tests for recommendation algorithm logic based on route characteristics"""

    def test_recommend_alns_for_large_clustered_route(self):
        """With ~155 tightly clustered stops, should recommend 'alns'"""
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        assert response.status_code == 200
        data = response.json()
        chars = data.get("characteristics", {})
        rec = data.get("recommendation", {})
        
        print(f"Stop count: {chars.get('stop_count')}")
        print(f"Cluster ratio: {chars.get('cluster_ratio')}")
        print(f"Cluster count: {chars.get('cluster_count')}")
        print(f"Recommended algorithm: {rec.get('algorithm')}")
        print(f"Reasoning: {rec.get('reasoning')}")
        
        # With 155 stops, should recommend alns (large scale optimization)
        if chars.get("stop_count", 0) >= 60:
            assert rec.get("algorithm") == "alns", f"Expected 'alns' for large route, got '{rec.get('algorithm')}'"
            assert rec.get("confidence", 0) >= 0.8, "Confidence should be high for large routes"


class TestBenchmarkRegression:
    """Regression tests for POST /api/benchmark endpoint"""

    def test_benchmark_endpoint_works(self):
        """POST /api/benchmark should return 200 with results"""
        response = requests.post(
            f"{BASE_URL}/api/benchmark",
            json={"algorithms": ["nearest_neighbor", "two_opt"]},
            headers={"Content-Type": "application/json"}
        )
        print(f"Benchmark response status: {response.status_code}")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert "results" in data, "Missing 'results' in benchmark response"
        assert "winner" in data, "Missing 'winner' in benchmark response"
        assert "stop_count" in data, "Missing 'stop_count' in benchmark response"
        print(f"Benchmark winner: {data.get('winner')}")
        print(f"Results count: {len(data.get('results', []))}")

    def test_benchmark_all_algorithms(self):
        """POST /api/benchmark with all algorithms should work"""
        # Test with all 7 local algorithms
        all_algos = ["alns", "ortools", "nearest_neighbor", "two_opt", "simulated_annealing", "genetic", "clarke_wright"]
        response = requests.post(
            f"{BASE_URL}/api/benchmark",
            json={"algorithms": all_algos},
            headers={"Content-Type": "application/json"},
            timeout=120  # Allow time for all algorithms
        )
        print(f"Full benchmark response status: {response.status_code}")
        assert response.status_code == 200
        
        data = response.json()
        results = data.get("results", [])
        print(f"Algorithms tested: {[r.get('algorithm') for r in results]}")
        
        # Should have results for all algorithms (some may have errors)
        assert len(results) >= 5, f"Expected at least 5 results, got {len(results)}"


class TestShadowRegression:
    """Regression tests for shadow testing in POST /api/optimize"""

    def test_optimize_with_two_opt_includes_shadow(self):
        """POST /api/optimize with two_opt should include shadow result"""
        response = requests.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "two_opt"},
            headers={"Content-Type": "application/json"},
            timeout=60
        )
        print(f"Optimize response status: {response.status_code}")
        assert response.status_code == 200
        
        data = response.json()
        print(f"Response keys: {data.keys()}")
        
        # Shadow field should be present
        assert "shadow" in data, "Missing 'shadow' in optimize response"
        shadow = data.get("shadow")
        
        if shadow and not shadow.get("error"):
            print(f"Shadow algorithm: {shadow.get('algorithm')}")
            print(f"Shadow distance: {shadow.get('total_distance_km')}")
            print(f"Shadow savings: {shadow.get('savings_km')}")
            
            assert "algorithm" in shadow, "Missing 'algorithm' in shadow"
            assert "total_distance_km" in shadow, "Missing 'total_distance_km' in shadow"
            assert "savings_km" in shadow, "Missing 'savings_km' in shadow"
            
            # Shadow algorithm should be different from primary
            assert shadow.get("algorithm") != "two_opt", "Shadow should use different algorithm"


class TestStopsRegression:
    """Regression tests for GET /api/stops endpoint"""

    def test_get_stops_returns_stable_ids(self):
        """GET /api/stops should return stops with stable IDs"""
        response = requests.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        
        stops = response.json()
        print(f"Total stops: {len(stops)}")
        
        # Verify each stop has an ID
        for stop in stops[:5]:  # Check first 5
            assert "id" in stop, "Stop missing 'id' field"
            assert isinstance(stop["id"], str), "Stop ID should be a string"
            assert len(stop["id"]) > 0, "Stop ID should not be empty"
            print(f"Stop ID: {stop['id'][:20]}... Address: {stop.get('address', '')[:30]}")

    def test_stops_have_required_fields(self):
        """GET /api/stops should return stops with required fields"""
        response = requests.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        
        stops = response.json()
        if len(stops) > 0:
            stop = stops[0]
            required_fields = ["id", "user_id", "address", "latitude", "longitude", "order"]
            for field in required_fields:
                assert field in stop, f"Stop missing required field: {field}"


class TestRecommendationPerformance:
    """Performance tests for recommendation endpoint"""

    def test_recommend_response_time(self):
        """GET /api/optimize/recommend should respond within reasonable time"""
        import time
        start = time.time()
        response = requests.get(f"{BASE_URL}/api/optimize/recommend")
        elapsed = time.time() - start
        
        print(f"Recommendation response time: {elapsed:.2f}s")
        assert response.status_code == 200
        # Should complete within 5 seconds even for 155 stops (O(n^2) distance matrix)
        assert elapsed < 5.0, f"Response took too long: {elapsed:.2f}s"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
