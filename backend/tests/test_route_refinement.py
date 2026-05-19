"""
Backend API Tests for Route Refinement Feature
================================================
Tests for:
- GET /api/stops - returns list of stops for authenticated user
- POST /api/optimize with sections - section-based route refinement
- POST /api/optimize with empty sections - falls through to normal optimization
- POST /api/optimize with invalid stop IDs - handles gracefully
- GET /api/mapbox-token - returns mapbox token
- GET /api/directions - returns route geometry

DEV_MODE=true is enabled for authentication bypass
"""
import pytest
import requests
import os
import time
import uuid

# Base URL from environment - must include /api prefix for endpoints
BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://route-opt.preview.emergentagent.com')

# Test data prefix for cleanup
TEST_PREFIX = "TEST_"

class TestHelpers:
    """Helper methods for tests"""
    
    @staticmethod
    def create_test_stop(session, address_suffix, lat, lng):
        """Create a test stop and return it"""
        stop_data = {
            "address": f"{TEST_PREFIX}Stop {address_suffix}",
            "name": f"Test Stop {address_suffix}",
            "latitude": lat,
            "longitude": lng,
            "priority": "medium"
        }
        response = session.post(f"{BASE_URL}/api/stops", json=stop_data)
        return response

    @staticmethod
    def delete_test_stop(session, stop_id):
        """Delete a test stop"""
        return session.delete(f"{BASE_URL}/api/stops/{stop_id}")


class TestHealthCheck:
    """Basic health check tests"""
    
    def test_api_root(self):
        """Test API root endpoint returns healthy status"""
        response = requests.get(f"{BASE_URL}/api/")
        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert data["status"] == "healthy"
        print("✓ API root endpoint healthy")


class TestMapboxToken:
    """Tests for GET /api/mapbox-token"""
    
    def test_mapbox_token_returns_token(self):
        """Test that mapbox-token endpoint returns a token"""
        response = requests.get(f"{BASE_URL}/api/mapbox-token")
        assert response.status_code == 200
        data = response.json()
        assert "token" in data
        assert isinstance(data["token"], str)
        assert len(data["token"]) > 0
        # Token should start with pk. (public key)
        assert data["token"].startswith("pk.")
        print(f"✓ Mapbox token returned: {data['token'][:20]}...")


class TestStops:
    """Tests for GET /api/stops endpoint"""
    
    @pytest.fixture
    def session(self):
        """Create a session for authenticated requests"""
        s = requests.Session()
        s.headers.update({"Content-Type": "application/json"})
        return s
    
    def test_get_stops_returns_list(self, session):
        """Test GET /api/stops returns a list of stops"""
        response = session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"✓ GET /api/stops returned {len(data)} stops")
    
    def test_create_and_get_stop(self, session):
        """Test creating a stop and retrieving it"""
        # Create a test stop
        stop_data = {
            "address": f"{TEST_PREFIX}123 Test Street, Brisbane",
            "name": "Test Location",
            "latitude": -27.4698,
            "longitude": 153.0251,
            "priority": "medium"
        }
        create_response = session.post(f"{BASE_URL}/api/stops", json=stop_data)
        assert create_response.status_code == 200
        created_stop = create_response.json()
        assert "id" in created_stop
        assert created_stop["address"] == stop_data["address"]
        print(f"✓ Created test stop: {created_stop['id']}")
        
        # Verify it appears in the list
        get_response = session.get(f"{BASE_URL}/api/stops")
        assert get_response.status_code == 200
        stops = get_response.json()
        stop_ids = [s["id"] for s in stops]
        assert created_stop["id"] in stop_ids
        print(f"✓ Stop verified in GET /api/stops")
        
        # Cleanup
        delete_response = session.delete(f"{BASE_URL}/api/stops/{created_stop['id']}")
        assert delete_response.status_code == 200
        print(f"✓ Test stop deleted")


class TestDirections:
    """Tests for GET /api/directions endpoint"""
    
    def test_directions_returns_geometry(self):
        """Test that directions endpoint returns route geometry"""
        # Use Brisbane coordinates for testing
        coordinates = "153.0251,-27.4698;153.0311,-27.4610"  # lng,lat format
        response = requests.get(f"{BASE_URL}/api/directions", params={"coordinates": coordinates})
        assert response.status_code == 200
        data = response.json()
        
        # Verify response structure
        assert "geometry" in data
        assert "distance" in data
        assert "duration" in data
        
        # Verify geometry structure
        assert data["geometry"]["type"] == "LineString"
        assert "coordinates" in data["geometry"]
        assert len(data["geometry"]["coordinates"]) > 0
        
        print(f"✓ Directions returned: distance={data['distance']}m, duration={data['duration']}s")
    
    def test_directions_with_multiple_waypoints(self):
        """Test directions with 3+ waypoints"""
        coordinates = "153.0251,-27.4698;153.0311,-27.4610;153.0400,-27.4550"
        response = requests.get(f"{BASE_URL}/api/directions", params={"coordinates": coordinates})
        assert response.status_code == 200
        data = response.json()
        assert "geometry" in data
        assert "steps" in data or "legs" in data
        print(f"✓ Directions with multiple waypoints returned successfully")


class TestSectionBasedOptimization:
    """Tests for POST /api/optimize with sections parameter"""
    
    @pytest.fixture
    def session(self):
        """Create a session for authenticated requests"""
        s = requests.Session()
        s.headers.update({"Content-Type": "application/json"})
        return s
    
    @pytest.fixture
    def test_stops(self, session):
        """Create test stops for optimization tests"""
        stops = []
        # Create 5 test stops in Brisbane area
        test_locations = [
            (-27.45, 153.03, "A"),
            (-27.46, 153.04, "B"),
            (-27.47, 153.05, "C"),
            (-27.48, 153.02, "D"),
            (-27.44, 153.01, "E"),
        ]
        
        for lat, lng, suffix in test_locations:
            response = TestHelpers.create_test_stop(session, suffix, lat, lng)
            if response.status_code == 200:
                stops.append(response.json())
        
        yield stops
        
        # Cleanup after test
        for stop in stops:
            TestHelpers.delete_test_stop(session, stop["id"])
        print(f"✓ Cleaned up {len(stops)} test stops")
    
    def test_optimize_with_sections(self, session, test_stops):
        """Test POST /api/optimize with sections parameter - main feature test"""
        assert len(test_stops) >= 4, "Need at least 4 test stops"
        
        # Create sections with stop IDs
        sections = [
            {"id": 1, "stop_ids": [test_stops[0]["id"], test_stops[1]["id"]]},
            {"id": 2, "stop_ids": [test_stops[2]["id"], test_stops[3]["id"]]}
        ]
        
        request_data = {
            "algorithm": "auto",
            "sections": sections
        }
        
        response = session.post(f"{BASE_URL}/api/optimize", json=request_data)
        assert response.status_code == 200
        data = response.json()
        
        # Verify response structure for section-based refinement
        assert "message" in data
        assert data["message"] == "Route refined with sections"
        assert "algorithm" in data
        assert data["algorithm"] == "section_refinement"
        assert "total_distance_km" in data
        assert "stop_count" in data
        assert "section_count" in data
        assert data["section_count"] == 2
        assert "stops" in data
        
        # Verify stops are returned
        assert isinstance(data["stops"], list)
        assert len(data["stops"]) > 0
        
        print(f"✓ Section-based optimization successful:")
        print(f"  - Message: {data['message']}")
        print(f"  - Algorithm: {data['algorithm']}")
        print(f"  - Total distance: {data['total_distance_km']} km")
        print(f"  - Stop count: {data['stop_count']}")
        print(f"  - Section count: {data['section_count']}")
    
    def test_optimize_with_empty_sections(self, session, test_stops):
        """Test POST /api/optimize with empty sections falls through to normal optimization"""
        assert len(test_stops) >= 2, "Need at least 2 test stops"
        
        request_data = {
            "algorithm": "auto",
            "sections": []  # Empty sections
        }
        
        response = session.post(f"{BASE_URL}/api/optimize", json=request_data)
        assert response.status_code == 200
        data = response.json()
        
        # Empty sections should fall through to normal optimization
        # Should NOT have "Route refined with sections" message
        assert "message" in data
        # Normal optimization returns different message
        assert "algorithm" in data
        assert data["algorithm"] != "section_refinement"
        
        print(f"✓ Empty sections handled correctly:")
        print(f"  - Message: {data['message']}")
        print(f"  - Algorithm: {data['algorithm']}")
    
    def test_optimize_with_invalid_stop_ids(self, session, test_stops):
        """Test POST /api/optimize with sections containing invalid stop IDs handles gracefully"""
        assert len(test_stops) >= 2, "Need at least 2 test stops"
        
        # Mix valid and invalid stop IDs
        sections = [
            {"id": 1, "stop_ids": [test_stops[0]["id"], "invalid-uuid-12345"]},
            {"id": 2, "stop_ids": ["another-invalid-id"]}
        ]
        
        request_data = {
            "algorithm": "auto",
            "sections": sections
        }
        
        response = session.post(f"{BASE_URL}/api/optimize", json=request_data)
        assert response.status_code == 200
        data = response.json()
        
        # Should handle gracefully - either optimize with valid stops or return empty
        assert "message" in data
        assert "stops" in data
        
        print(f"✓ Invalid stop IDs handled gracefully:")
        print(f"  - Message: {data['message']}")
        print(f"  - Stop count: {data.get('stop_count', len(data.get('stops', [])))}")
    
    def test_optimize_with_single_section(self, session, test_stops):
        """Test optimization with single section"""
        assert len(test_stops) >= 3, "Need at least 3 test stops"
        
        sections = [
            {"id": 1, "stop_ids": [test_stops[0]["id"], test_stops[1]["id"], test_stops[2]["id"]]}
        ]
        
        request_data = {
            "algorithm": "auto",
            "sections": sections
        }
        
        response = session.post(f"{BASE_URL}/api/optimize", json=request_data)
        assert response.status_code == 200
        data = response.json()
        
        assert data["message"] == "Route refined with sections"
        assert data["section_count"] == 1
        
        print(f"✓ Single section optimization successful")
    
    def test_optimize_with_current_location(self, session, test_stops):
        """Test section-based optimization with current location"""
        assert len(test_stops) >= 2, "Need at least 2 test stops"
        
        sections = [
            {"id": 1, "stop_ids": [test_stops[0]["id"], test_stops[1]["id"]]}
        ]
        
        request_data = {
            "algorithm": "auto",
            "sections": sections,
            "current_latitude": -27.43,
            "current_longitude": 153.02,
            "use_current_location": True
        }
        
        response = session.post(f"{BASE_URL}/api/optimize", json=request_data)
        assert response.status_code == 200
        data = response.json()
        
        assert data["message"] == "Route refined with sections"
        assert "started_from_current_location" in data
        assert data["started_from_current_location"] == True
        
        print(f"✓ Section optimization with current location successful")


class TestNormalOptimization:
    """Tests for normal (non-section) optimization"""
    
    @pytest.fixture
    def session(self):
        """Create a session for authenticated requests"""
        s = requests.Session()
        s.headers.update({"Content-Type": "application/json"})
        return s
    
    @pytest.fixture
    def test_stops(self, session):
        """Create test stops for optimization tests"""
        stops = []
        test_locations = [
            (-27.45, 153.03, "Opt1"),
            (-27.46, 153.04, "Opt2"),
            (-27.47, 153.05, "Opt3"),
        ]
        
        for lat, lng, suffix in test_locations:
            response = TestHelpers.create_test_stop(session, suffix, lat, lng)
            if response.status_code == 200:
                stops.append(response.json())
        
        yield stops
        
        # Cleanup
        for stop in stops:
            TestHelpers.delete_test_stop(session, stop["id"])
    
    def test_optimize_without_sections(self, session, test_stops):
        """Test normal optimization without sections parameter"""
        assert len(test_stops) >= 2, "Need at least 2 test stops"
        
        request_data = {
            "algorithm": "auto"
        }
        
        response = session.post(f"{BASE_URL}/api/optimize", json=request_data)
        assert response.status_code == 200
        data = response.json()
        
        assert "message" in data
        assert "algorithm" in data
        assert "stops" in data
        
        print(f"✓ Normal optimization successful:")
        print(f"  - Message: {data['message']}")
        print(f"  - Algorithm: {data['algorithm']}")


class TestEdgeCases:
    """Edge case tests"""
    
    @pytest.fixture
    def session(self):
        """Create a session for authenticated requests"""
        s = requests.Session()
        s.headers.update({"Content-Type": "application/json"})
        return s
    
    def test_optimize_with_no_stops(self, session):
        """Test optimization when user has no stops"""
        # First, get current stops to check
        get_response = session.get(f"{BASE_URL}/api/stops")
        current_stops = get_response.json()
        
        if len(current_stops) < 2:
            request_data = {"algorithm": "auto"}
            response = session.post(f"{BASE_URL}/api/optimize", json=request_data)
            assert response.status_code == 200
            data = response.json()
            assert "message" in data
            # Should indicate need for at least 2 stops
            print(f"✓ No stops edge case handled: {data['message']}")
        else:
            print(f"⚠ Skipping no-stops test - user has {len(current_stops)} existing stops")
    
    def test_directions_with_invalid_coordinates(self):
        """Test directions with invalid coordinate format"""
        # Missing semicolon separator
        response = requests.get(f"{BASE_URL}/api/directions", params={"coordinates": "invalid"})
        # Should handle gracefully - either 400 or 422
        assert response.status_code in [400, 422, 500]
        print(f"✓ Invalid coordinates handled with status {response.status_code}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
