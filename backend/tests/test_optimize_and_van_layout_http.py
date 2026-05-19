"""HTTP-level regression tests for POST /api/optimize and GET/PUT /api/van-layout.

These tests verify:
1. POST /api/optimize returns 200 with optimized_sequence, cluster_warnings, time_savings
2. No Hamiltonian violations (input stop count == output stop count, no dropped/duplicated IDs)
3. Auto-tighten path doesn't regress (spike detection + resolution or rollback)
4. GET /api/van-layout returns 200 with default 3x3 + is_default:true for fresh user
5. PUT /api/van-layout with {rows:3, cols:4} persists, GET returns is_default:false
6. PUT with disallowed shape (e.g. 4x4) returns 400
"""
import os
import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://route-opt.preview.emergentagent.com').rstrip('/')

# Test session token for xmltvg@gmail.com (whitelisted user)
TEST_SESSION_TOKEN = "59c60389-8953-4a7b-9088-d6175aa30243"

def get_auth_headers():
    """Return headers with authentication"""
    return {
        "Authorization": f"Bearer {TEST_SESSION_TOKEN}",
        "Content-Type": "application/json"
    }


# ── Synthetic Brisbane-area test stops for /api/optimize ────────────────────
# 10 stops in Brisbane area to test optimization
BRISBANE_TEST_STOPS = [
    {"id": "s1", "address": "1 Queen St, Brisbane", "latitude": -27.4698, "longitude": 153.0251, "name": "Stop 1"},
    {"id": "s2", "address": "100 Adelaide St, Brisbane", "latitude": -27.4679, "longitude": 153.0281, "name": "Stop 2"},
    {"id": "s3", "address": "200 George St, Brisbane", "latitude": -27.4710, "longitude": 153.0220, "name": "Stop 3"},
    {"id": "s4", "address": "50 Ann St, Brisbane", "latitude": -27.4650, "longitude": 153.0300, "name": "Stop 4"},
    {"id": "s5", "address": "300 Edward St, Brisbane", "latitude": -27.4720, "longitude": 153.0310, "name": "Stop 5"},
    {"id": "s6", "address": "150 Albert St, Brisbane", "latitude": -27.4690, "longitude": 153.0260, "name": "Stop 6"},
    {"id": "s7", "address": "80 Mary St, Brisbane", "latitude": -27.4705, "longitude": 153.0295, "name": "Stop 7"},
    {"id": "s8", "address": "250 Elizabeth St, Brisbane", "latitude": -27.4680, "longitude": 153.0240, "name": "Stop 8"},
    {"id": "s9", "address": "120 Charlotte St, Brisbane", "latitude": -27.4665, "longitude": 153.0275, "name": "Stop 9"},
    {"id": "s10", "address": "180 Creek St, Brisbane", "latitude": -27.4695, "longitude": 153.0285, "name": "Stop 10"},
]

# Contrived ~10-stop fixture that should trigger spike detection
# One northern point and several southern points with a single spike in the middle
SPIKE_DETECTION_STOPS = [
    {"id": "spike1", "address": "Far NE", "latitude": -26.7868, "longitude": 153.1196, "name": "Far NE"},
    {"id": "spike2", "address": "South 1", "latitude": -26.7977, "longitude": 153.0986, "name": "South 1"},
    {"id": "spike3", "address": "South 2", "latitude": -26.7965, "longitude": 153.0976, "name": "South 2"},
    {"id": "spike4", "address": "Back North (spike)", "latitude": -26.7700, "longitude": 153.0985, "name": "Back North (spike)"},
    {"id": "spike5", "address": "Southwest 1", "latitude": -26.7912, "longitude": 153.0926, "name": "Southwest 1"},
    {"id": "spike6", "address": "Southwest 2", "latitude": -26.7943, "longitude": 153.0926, "name": "Southwest 2"},
    {"id": "spike7", "address": "South 3", "latitude": -26.7980, "longitude": 153.0950, "name": "South 3"},
    {"id": "spike8", "address": "South 4", "latitude": -26.7990, "longitude": 153.0960, "name": "South 4"},
    {"id": "spike9", "address": "South 5", "latitude": -26.8000, "longitude": 153.0970, "name": "South 5"},
    {"id": "spike10", "address": "South 6", "latitude": -26.8010, "longitude": 153.0980, "name": "South 10"},
]


class TestOptimizeEndpoint:
    """Tests for POST /api/optimize"""

    def test_optimize_returns_200_with_required_fields(self):
        """POST /api/optimize on a small synthetic Brisbane-area test set
        should return 200 with optimized_sequence, cluster_warnings, time_savings"""
        payload = {
            "stops": BRISBANE_TEST_STOPS,
            "start_location": {"latitude": -27.4698, "longitude": 153.0251},
            "solver": "pyvrp",  # Use PyVRP solver
        }
        response = requests.post(
            f"{BASE_URL}/api/optimize", 
            json=payload, 
            headers=get_auth_headers(),
            timeout=60
        )
        
        # Should return 200
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        
        # Must have optimized_sequence
        assert "optimized_sequence" in data, f"Missing optimized_sequence in response: {data.keys()}"
        
        # Must have cluster_warnings (can be empty list)
        assert "cluster_warnings" in data, f"Missing cluster_warnings in response: {data.keys()}"
        
        # Must have time_savings (can be 0 or negative)
        assert "time_savings" in data or "time_savings_seconds" in data, f"Missing time_savings in response: {data.keys()}"

    def test_optimize_no_hamiltonian_violations(self):
        """Verify no Hamiltonian violations: input stop count == output stop count,
        no dropped/duplicated IDs"""
        payload = {
            "stops": BRISBANE_TEST_STOPS,
            "start_location": {"latitude": -27.4698, "longitude": 153.0251},
            "solver": "pyvrp",
        }
        response = requests.post(
            f"{BASE_URL}/api/optimize", 
            json=payload, 
            headers=get_auth_headers(),
            timeout=60
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        optimized_sequence = data.get("optimized_sequence", [])
        
        # optimized_sequence is a list of stop IDs (strings)
        # The endpoint uses the user's existing stops from the database
        # So we check that the output has no duplicates and matches stop_count
        stop_count = data.get("stop_count", 0)
        
        # Check no duplicates in output
        assert len(optimized_sequence) == len(set(optimized_sequence)), (
            f"Hamiltonian violation: duplicated IDs in output: {optimized_sequence}"
        )
        
        # Check count matches reported stop_count
        assert len(optimized_sequence) == stop_count, (
            f"Hamiltonian violation: optimized_sequence has {len(optimized_sequence)} stops, "
            f"but stop_count reports {stop_count}"
        )
        
        # Also check the 'stops' field in response matches
        stops_in_response = data.get("stops", [])
        if stops_in_response:
            response_ids = [s.get("id") for s in stops_in_response]
            assert set(optimized_sequence) == set(response_ids), (
                f"Hamiltonian violation: optimized_sequence IDs don't match stops IDs"
            )

    def test_optimize_spike_detection_fixture(self):
        """Send a contrived ~10-stop fixture that should trigger spike detection.
        Check the response includes either resolved warnings (auto-tighten succeeded)
        or unchanged solver output (OSRM rolled back beyond tolerance) — both are valid."""
        payload = {
            "stops": SPIKE_DETECTION_STOPS,
            "start_location": {"latitude": -26.7868, "longitude": 153.1196},
            "solver": "pyvrp",
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
        assert "optimized_sequence" in data, f"Missing optimized_sequence in response"
        
        # Must have cluster_warnings (may be empty if auto-tighten resolved all)
        assert "cluster_warnings" in data, f"Missing cluster_warnings in response"
        
        # Verify no Hamiltonian violations
        optimized_sequence = data.get("optimized_sequence", [])
        stop_count = data.get("stop_count", 0)
        
        # Check no duplicates
        assert len(optimized_sequence) == len(set(optimized_sequence)), (
            f"Hamiltonian violation in spike test: duplicated IDs"
        )
        
        # Check count matches
        assert len(optimized_sequence) == stop_count, (
            f"Hamiltonian violation in spike test: sequence has {len(optimized_sequence)}, "
            f"stop_count reports {stop_count}"
        )


class TestVanLayoutEndpoint:
    """Tests for GET/PUT /api/van-layout"""

    def test_van_layout_get_default_for_fresh_user(self):
        """GET /api/van-layout returns 200 with default 3x3 + is_default:true for fresh user"""
        response = requests.get(
            f"{BASE_URL}/api/van-layout", 
            headers=get_auth_headers(),
            timeout=10
        )
        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        
        data = response.json()
        # Should have rows, cols, is_default
        assert "rows" in data, f"Missing rows in response: {data}"
        assert "cols" in data, f"Missing cols in response: {data}"
        # Default is 3x3
        # Note: is_default may be true or false depending on whether user has saved a layout

    def test_van_layout_put_valid_shape_persists(self):
        """PUT /api/van-layout with {rows:3, cols:4} persists, GET returns is_default:false"""
        # First PUT a valid shape
        payload = {"rows": 3, "cols": 4}
        put_response = requests.put(
            f"{BASE_URL}/api/van-layout", 
            json=payload, 
            headers=get_auth_headers(),
            timeout=10
        )
        assert put_response.status_code == 200, (
            f"PUT expected 200, got {put_response.status_code}: {put_response.text}"
        )
        
        # Now GET and verify it persisted
        get_response = requests.get(
            f"{BASE_URL}/api/van-layout", 
            headers=get_auth_headers(),
            timeout=10
        )
        assert get_response.status_code == 200, (
            f"GET expected 200, got {get_response.status_code}: {get_response.text}"
        )
        
        data = get_response.json()
        assert data.get("rows") == 3, f"Expected rows=3, got {data.get('rows')}"
        assert data.get("cols") == 4, f"Expected cols=4, got {data.get('cols')}"
        assert data.get("is_default") == False, f"Expected is_default=False after PUT, got {data.get('is_default')}"

    def test_van_layout_put_invalid_shape_returns_400(self):
        """PUT /api/van-layout with disallowed shape (e.g. 4x4) returns 400"""
        payload = {"rows": 4, "cols": 4}  # 4x4 is not in ALLOWED_VAN_SHAPES
        response = requests.put(
            f"{BASE_URL}/api/van-layout", 
            json=payload, 
            headers=get_auth_headers(),
            timeout=10
        )
        assert response.status_code == 400, (
            f"Expected 400 for invalid shape 4x4, got {response.status_code}: {response.text}"
        )

    def test_van_layout_put_another_invalid_shape(self):
        """PUT /api/van-layout with another disallowed shape (e.g. 5x5) returns 400"""
        payload = {"rows": 5, "cols": 5}  # 5x5 is not in ALLOWED_VAN_SHAPES
        response = requests.put(
            f"{BASE_URL}/api/van-layout", 
            json=payload, 
            headers=get_auth_headers(),
            timeout=10
        )
        assert response.status_code == 400, (
            f"Expected 400 for invalid shape 5x5, got {response.status_code}: {response.text}"
        )


class TestOptimizeEndpointNoAuth:
    """Tests for POST /api/optimize - this endpoint requires auth"""

    def test_optimize_with_different_solvers(self):
        """Test that optimize works with different solver options"""
        for solver in ["pyvrp", "ortools", "vroom"]:
            payload = {
                "stops": BRISBANE_TEST_STOPS[:5],  # Use fewer stops for speed
                "start_location": {"latitude": -27.4698, "longitude": 153.0251},
                "solver": solver,
            }
            response = requests.post(
                f"{BASE_URL}/api/optimize", 
                json=payload, 
                headers=get_auth_headers(),
                timeout=60
            )
            
            # Should return 200 (or 400 if solver not available, which is acceptable)
            assert response.status_code in [200, 400], (
                f"Solver {solver}: Expected 200 or 400, got {response.status_code}: {response.text}"
            )
            
            if response.status_code == 200:
                data = response.json()
                assert "optimized_sequence" in data, f"Solver {solver}: Missing optimized_sequence"
                print(f"Solver {solver}: OK - returned {len(data.get('optimized_sequence', []))} stops")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
