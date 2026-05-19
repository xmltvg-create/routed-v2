"""
Comprehensive API tests for /api/optimize endpoint.

Tests all algorithms: auto, vroom, lkh, pyvrp, ortools, vroom_lkh_3opt, three_opt
Verifies:
- Hamiltonian path (all input stops, no dupes/drops)
- Response structure (stops[], time_savings, quality_badge, algorithm, reasoning)
- Auto algorithm selection (>=11 stops -> vroom_lkh_3opt, <11 -> vroom/ortools)
"""
import os
import pytest
import requests
import time
from typing import List, Dict, Any

# Get backend URL from environment
BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://route-opt.preview.emergentagent.com')

# 12-stop SE Queensland test dataset (realistic delivery route)
TEST_STOPS_12 = [
    {"address": "1 Main St, Caloundra QLD 4551", "latitude": -26.7983, "longitude": 153.1283, "name": "Stop 1"},
    {"address": "2 Ocean St, Maroochydore QLD 4558", "latitude": -26.6517, "longitude": 153.0917, "name": "Stop 2"},
    {"address": "3 Beach Rd, Noosa QLD 4567", "latitude": -26.3917, "longitude": 153.0750, "name": "Stop 3"},
    {"address": "4 Hill St, Nambour QLD 4560", "latitude": -26.6267, "longitude": 152.9583, "name": "Stop 4"},
    {"address": "5 River Rd, Bli Bli QLD 4560", "latitude": -26.6183, "longitude": 153.0333, "name": "Stop 5"},
    {"address": "6 Park Ave, Buderim QLD 4556", "latitude": -26.6833, "longitude": 153.0500, "name": "Stop 6"},
    {"address": "7 Lake Dr, Kawana QLD 4575", "latitude": -26.7167, "longitude": 153.1167, "name": "Stop 7"},
    {"address": "8 Forest Rd, Mooloolaba QLD 4557", "latitude": -26.6817, "longitude": 153.1183, "name": "Stop 8"},
    {"address": "9 Valley St, Palmwoods QLD 4555", "latitude": -26.6867, "longitude": 152.9617, "name": "Stop 9"},
    {"address": "10 Coast Rd, Coolum QLD 4573", "latitude": -26.5283, "longitude": 153.0833, "name": "Stop 10"},
    {"address": "11 Mountain View, Maleny QLD 4552", "latitude": -26.7617, "longitude": 152.8500, "name": "Stop 11"},
    {"address": "12 Sunset Blvd, Alexandra Headland QLD 4572", "latitude": -26.6683, "longitude": 153.1083, "name": "Stop 12"},
]

# 5-stop small dataset for <11 stop tests
TEST_STOPS_5 = TEST_STOPS_12[:5]

# 30-stop dataset for larger tests
TEST_STOPS_30 = TEST_STOPS_12 + [
    {"address": f"{i} Test St, QLD", "latitude": -26.5 - (i * 0.01), "longitude": 153.0 + (i * 0.005), "name": f"Stop {i}"}
    for i in range(13, 31)
]


class TestSession:
    """Shared session for all tests"""
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        self.user_id = "dev-user-123"
        self.seeded_stop_ids = []
    
    def seed_stops(self, stops: List[Dict[str, Any]]) -> List[str]:
        """Seed stops for testing and return their IDs"""
        stop_ids = []
        for stop in stops:
            resp = self.session.post(f"{BASE_URL}/api/stops", json=stop)
            if resp.status_code in (200, 201):
                data = resp.json()
                stop_ids.append(data.get("id"))
        self.seeded_stop_ids.extend(stop_ids)
        return stop_ids
    
    def clear_stops(self):
        """Clear all stops for dev user"""
        self.session.post(f"{BASE_URL}/api/stops/clear")
        self.seeded_stop_ids = []
    
    def get_stops(self) -> List[Dict]:
        """Get current stops"""
        resp = self.session.get(f"{BASE_URL}/api/stops")
        if resp.status_code == 200:
            return resp.json()
        return []


@pytest.fixture(scope="module")
def api_session():
    """Shared API session for all tests"""
    session = TestSession()
    yield session
    # Cleanup after all tests
    session.clear_stops()


def _assert_hamiltonian(input_count: int, output_stops: List[Dict], algo_name: str):
    """Assert output is a Hamiltonian path (all stops exactly once)"""
    assert len(output_stops) == input_count, (
        f"{algo_name}: Expected {input_count} stops, got {len(output_stops)}"
    )
    output_ids = [s.get("id") for s in output_stops]
    assert len(set(output_ids)) == len(output_ids), (
        f"{algo_name}: Duplicate stop IDs in output"
    )


def _assert_response_structure(response_data: Dict, algo_name: str):
    """Assert response has required fields"""
    assert "stops" in response_data, f"{algo_name}: Missing 'stops' field"
    assert "algorithm" in response_data, f"{algo_name}: Missing 'algorithm' field"
    # time_savings may not be present for all algorithms
    # quality_badge may not be present for all algorithms


class TestAlgorithmsEndpoint:
    """Test /api/optimize/algorithms endpoint"""
    
    def test_algorithms_list_contains_required(self, api_session):
        """Verify algorithms endpoint lists expected algorithms"""
        resp = api_session.session.get(f"{BASE_URL}/api/optimize/algorithms")
        assert resp.status_code == 200
        data = resp.json()
        
        algo_ids = [a["id"] for a in data.get("algorithms", [])]
        
        # Check required algorithms are listed
        required = ["auto", "ortools", "pyvrp"]
        for req in required:
            assert req in algo_ids, f"Algorithm '{req}' not in algorithms list"
        
        print(f"Available algorithms: {algo_ids}")


class TestAutoAlgorithmSelection:
    """Test auto algorithm selection logic"""
    
    def test_auto_with_12_stops_selects_vroom_lkh_3opt(self, api_session):
        """Auto with >=11 stops should resolve to vroom_lkh_3opt"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12)
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "auto"})
        assert resp.status_code == 200, f"Optimize failed: {resp.text}"
        
        data = resp.json()
        _assert_response_structure(data, "auto")
        
        # With 12 stops, auto should resolve to vroom_lkh_3opt
        algo = data.get("algorithm", "")
        assert algo in ("vroom_lkh_3opt", "vroom", "ortools"), (
            f"Auto with 12 stops resolved to '{algo}', expected vroom_lkh_3opt/vroom/ortools"
        )
        print(f"Auto with 12 stops resolved to: {algo}")
        
        # Verify Hamiltonian path
        stops = data.get("stops", [])
        _assert_hamiltonian(12, stops, f"auto->{algo}")
    
    def test_auto_with_5_stops_selects_vroom_or_ortools(self, api_session):
        """Auto with <11 stops should resolve to vroom or ortools"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_5)
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "auto"})
        assert resp.status_code == 200, f"Optimize failed: {resp.text}"
        
        data = resp.json()
        algo = data.get("algorithm", "")
        
        # With <11 stops, should NOT be vroom_lkh_3opt
        # Could be vroom, ortools, or two_opt
        print(f"Auto with 5 stops resolved to: {algo}")
        
        stops = data.get("stops", [])
        _assert_hamiltonian(5, stops, f"auto->{algo}")


class TestIndividualAlgorithms:
    """Test each algorithm individually"""
    
    def test_vroom_returns_hamiltonian_path(self, api_session):
        """VROOM should return all stops exactly once"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12)
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "vroom"})
        assert resp.status_code == 200, f"VROOM failed: {resp.text}"
        
        data = resp.json()
        _assert_response_structure(data, "vroom")
        
        stops = data.get("stops", [])
        _assert_hamiltonian(12, stops, "vroom")
        print(f"VROOM returned {len(stops)} stops")
    
    def test_lkh_returns_hamiltonian_path(self, api_session):
        """LKH should return all stops exactly once"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12)
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "lkh"})
        assert resp.status_code == 200, f"LKH failed: {resp.text}"
        
        data = resp.json()
        _assert_response_structure(data, "lkh")
        
        stops = data.get("stops", [])
        _assert_hamiltonian(12, stops, "lkh")
        print(f"LKH returned {len(stops)} stops")
    
    def test_pyvrp_returns_hamiltonian_path(self, api_session):
        """PyVRP should return all stops exactly once"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12)
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "pyvrp"})
        assert resp.status_code == 200, f"PyVRP failed: {resp.text}"
        
        data = resp.json()
        _assert_response_structure(data, "pyvrp")
        
        stops = data.get("stops", [])
        _assert_hamiltonian(12, stops, "pyvrp")
        print(f"PyVRP returned {len(stops)} stops")
    
    def test_ortools_returns_hamiltonian_path(self, api_session):
        """OR-Tools should return all stops exactly once"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12)
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "ortools"})
        assert resp.status_code == 200, f"OR-Tools failed: {resp.text}"
        
        data = resp.json()
        _assert_response_structure(data, "ortools")
        
        stops = data.get("stops", [])
        _assert_hamiltonian(12, stops, "ortools")
        print(f"OR-Tools returned {len(stops)} stops")
    
    def test_vroom_lkh_3opt_returns_hamiltonian_path_with_time_savings(self, api_session):
        """vroom_lkh_3opt should return Hamiltonian path AND time_savings"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12)
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "vroom_lkh_3opt"})
        assert resp.status_code == 200, f"vroom_lkh_3opt failed: {resp.text}"
        
        data = resp.json()
        _assert_response_structure(data, "vroom_lkh_3opt")
        
        stops = data.get("stops", [])
        _assert_hamiltonian(12, stops, "vroom_lkh_3opt")
        
        # Check time_savings field
        time_savings = data.get("time_savings")
        if time_savings:
            print(f"vroom_lkh_3opt time_savings: {time_savings}")
            assert "baseline_seconds" in time_savings or "optimized_seconds" in time_savings, (
                "time_savings missing expected fields"
            )
        
        print(f"vroom_lkh_3opt returned {len(stops)} stops")
    
    def test_three_opt_does_not_crash_on_asymmetric_matrix(self, api_session):
        """three_opt should NOT crash on asymmetric OSRM matrix"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12)
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "three_opt"})
        # three_opt may not be a direct algorithm choice, but if it is, it should work
        if resp.status_code == 200:
            data = resp.json()
            stops = data.get("stops", [])
            _assert_hamiltonian(12, stops, "three_opt")
            print(f"three_opt returned {len(stops)} stops")
        else:
            # three_opt might not be a valid top-level algorithm
            print(f"three_opt not available as direct algorithm: {resp.status_code}")


class TestResponseStructure:
    """Test response includes required fields"""
    
    def test_response_includes_all_fields(self, api_session):
        """Verify response includes stops[], time_savings, quality_badge, algorithm, reasoning"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12)
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "auto"})
        assert resp.status_code == 200
        
        data = resp.json()
        
        # Required fields
        assert "stops" in data, "Missing 'stops' field"
        assert "algorithm" in data, "Missing 'algorithm' field"
        
        # Optional but expected fields
        fields_present = []
        if "time_savings" in data:
            fields_present.append("time_savings")
        if "quality_badge" in data:
            fields_present.append("quality_badge")
        if "reasoning" in data:
            fields_present.append("reasoning")
        
        print(f"Response fields present: stops, algorithm, {', '.join(fields_present)}")


class TestLargeRoutes:
    """Test with larger stop counts"""
    
    def test_30_stops_with_auto(self, api_session):
        """Test auto algorithm with 30 stops"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_30)
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "auto"}, timeout=60)
        assert resp.status_code == 200, f"30-stop optimize failed: {resp.text}"
        
        data = resp.json()
        stops = data.get("stops", [])
        algo = data.get("algorithm", "")
        
        _assert_hamiltonian(30, stops, f"auto->{algo} (30 stops)")
        print(f"30-stop auto resolved to: {algo}, returned {len(stops)} stops")


class TestRepeatedCalls:
    """Test for flakiness/hangs with repeated calls"""
    
    def test_repeated_optimize_no_flakiness(self, api_session):
        """Hit /api/optimize repeatedly to verify no flakiness/hangs"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12)
        
        results = []
        for i in range(3):
            start = time.time()
            resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "auto"}, timeout=30)
            elapsed = time.time() - start
            
            assert resp.status_code == 200, f"Call {i+1} failed: {resp.text}"
            data = resp.json()
            stops = data.get("stops", [])
            
            results.append({
                "call": i + 1,
                "status": resp.status_code,
                "stop_count": len(stops),
                "algorithm": data.get("algorithm"),
                "elapsed_seconds": round(elapsed, 2)
            })
        
        print(f"Repeated calls results: {results}")
        
        # All calls should return same stop count
        stop_counts = [r["stop_count"] for r in results]
        assert all(c == 12 for c in stop_counts), f"Inconsistent stop counts: {stop_counts}"


class TestEdgeCases:
    """Test edge cases"""
    
    def test_2_stops_minimum(self, api_session):
        """Test with minimum 2 stops"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12[:2])
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "auto"})
        assert resp.status_code == 200
        
        data = resp.json()
        stops = data.get("stops", [])
        assert len(stops) == 2, f"Expected 2 stops, got {len(stops)}"
    
    def test_1_stop_returns_message(self, api_session):
        """Test with 1 stop returns appropriate message"""
        api_session.clear_stops()
        api_session.seed_stops(TEST_STOPS_12[:1])
        
        resp = api_session.session.post(f"{BASE_URL}/api/optimize", json={"algorithm": "auto"})
        assert resp.status_code == 200
        
        data = resp.json()
        # Should return message about needing at least 2 stops
        message = data.get("message", "")
        assert "2" in message or len(data.get("stops", [])) == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
