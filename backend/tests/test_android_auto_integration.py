"""
Test Android Auto Integration APIs and Geocode regression tests
- GET /api/car/next-stops - returns list of incomplete stops for current user
- POST /api/car/stop-action - updates stop delivery_status (delivered, skip, failed)
- GET /api/geocode - regression check for rooftop_centroid/map_pinpoint/access_navigation_point/plus_code/interpolation_status
"""
import pytest
import requests
import os
import uuid

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://route-opt.preview.emergentagent.com').rstrip('/')

@pytest.fixture
def api_client():
    """Shared requests session"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


class TestHealthCheck:
    """Health check to ensure API is running"""
    
    def test_api_health(self, api_client):
        response = api_client.get(f"{BASE_URL}/api/")
        assert response.status_code == 200
        data = response.json()
        assert data.get("status") == "healthy"
        print(f"✓ API health check passed: {data}")


class TestCarNextStops:
    """Test GET /api/car/next-stops endpoint"""
    
    def test_car_next_stops_returns_list(self, api_client):
        """GET /api/car/next-stops returns list for current user"""
        response = api_client.get(f"{BASE_URL}/api/car/next-stops")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list), "Expected a list of stops"
        print(f"✓ GET /api/car/next-stops returned list with {len(data)} stops")
        
        # Check that returned stops are not completed (if there are any)
        for stop in data:
            assert stop.get("completed") != True, f"Stop {stop.get('id')} should not be completed"
        print(f"✓ All returned stops are not completed")
    
    def test_car_next_stops_limit_param(self, api_client):
        """GET /api/car/next-stops?limit=5 respects limit parameter"""
        response = api_client.get(f"{BASE_URL}/api/car/next-stops?limit=5")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) <= 5, f"Expected at most 5 stops, got {len(data)}"
        print(f"✓ GET /api/car/next-stops with limit=5 returned {len(data)} stops")


class TestCarStopAction:
    """Test POST /api/car/stop-action endpoint"""
    
    @pytest.fixture
    def test_stop(self, api_client):
        """Create a test stop for action tests"""
        stop_data = {
            "address": f"TEST_ANDROID_AUTO_{uuid.uuid4().hex[:8]} Test Street, Sydney NSW 2000",
            "latitude": -33.8688,
            "longitude": 151.2093,
            "name": "TEST Android Auto Stop",
            "priority": "medium"
        }
        response = api_client.post(f"{BASE_URL}/api/stops", json=stop_data)
        assert response.status_code == 200
        stop = response.json()
        print(f"✓ Created test stop: {stop.get('id')}")
        yield stop
        # Cleanup
        api_client.delete(f"{BASE_URL}/api/stops/{stop.get('id')}")
        print(f"✓ Cleaned up test stop: {stop.get('id')}")
    
    def test_stop_action_skip_updates_delivery_status(self, api_client, test_stop):
        """POST /api/car/stop-action with action=skip updates delivery_status=skipped"""
        action_payload = {
            "stop_id": test_stop["id"],
            "action": "skip",
            "reason": "Customer not available"
        }
        response = api_client.post(f"{BASE_URL}/api/car/stop-action", json=action_payload)
        assert response.status_code == 200
        data = response.json()
        
        # Verify delivery_status is updated
        assert data.get("delivery_status") == "skipped", f"Expected delivery_status=skipped, got {data.get('delivery_status')}"
        assert data.get("completed") == False, "Stop should not be marked completed for skip"
        assert data.get("failure_reason") == "Customer not available"
        print(f"✓ POST /api/car/stop-action with action=skip: delivery_status={data.get('delivery_status')}")
        
        # Verify persistence with GET
        get_response = api_client.get(f"{BASE_URL}/api/stops")
        stops = get_response.json()
        updated_stop = next((s for s in stops if s["id"] == test_stop["id"]), None)
        assert updated_stop is not None
        assert updated_stop.get("delivery_status") == "skipped"
        print(f"✓ Verified skip status persisted in database")
    
    def test_stop_action_delivered_updates_completed(self, api_client, test_stop):
        """POST /api/car/stop-action with action=delivered updates completed=true and delivery_status=delivered"""
        action_payload = {
            "stop_id": test_stop["id"],
            "action": "delivered"
        }
        response = api_client.post(f"{BASE_URL}/api/car/stop-action", json=action_payload)
        assert response.status_code == 200
        data = response.json()
        
        # Verify delivery_status and completed are updated
        assert data.get("delivery_status") == "delivered", f"Expected delivery_status=delivered, got {data.get('delivery_status')}"
        assert data.get("completed") == True, "Stop should be marked completed for delivered"
        assert data.get("failure_reason") is None, "failure_reason should be None for delivered"
        print(f"✓ POST /api/car/stop-action with action=delivered: delivery_status={data.get('delivery_status')}, completed={data.get('completed')}")
        
        # Verify persistence with GET
        get_response = api_client.get(f"{BASE_URL}/api/stops")
        stops = get_response.json()
        updated_stop = next((s for s in stops if s["id"] == test_stop["id"]), None)
        assert updated_stop is not None
        assert updated_stop.get("delivery_status") == "delivered"
        assert updated_stop.get("completed") == True
        print(f"✓ Verified delivered status persisted in database")
    
    def test_stop_action_failed_updates_status(self, api_client, test_stop):
        """POST /api/car/stop-action with action=failed updates delivery_status=failed"""
        action_payload = {
            "stop_id": test_stop["id"],
            "action": "failed",
            "reason": "Address not found"
        }
        response = api_client.post(f"{BASE_URL}/api/car/stop-action", json=action_payload)
        assert response.status_code == 200
        data = response.json()
        
        # Verify delivery_status is updated
        assert data.get("delivery_status") == "failed", f"Expected delivery_status=failed, got {data.get('delivery_status')}"
        assert data.get("completed") == False, "Stop should not be marked completed for failed"
        assert data.get("failure_reason") == "Address not found"
        print(f"✓ POST /api/car/stop-action with action=failed: delivery_status={data.get('delivery_status')}")
    
    def test_stop_action_invalid_stop_returns_404(self, api_client):
        """POST /api/car/stop-action with invalid stop_id returns 404"""
        action_payload = {
            "stop_id": "non-existent-stop-id-12345",
            "action": "delivered"
        }
        response = api_client.post(f"{BASE_URL}/api/car/stop-action", json=action_payload)
        assert response.status_code == 404
        print(f"✓ POST /api/car/stop-action with invalid stop_id returned 404")


class TestGeocodeRegressionCheck:
    """Regression check for geocode endpoint returning required fields"""
    
    def test_geocode_returns_all_required_fields(self, api_client):
        """GET /api/geocode returns rooftop_centroid/map_pinpoint/access_navigation_point/plus_code/interpolation_status"""
        # Test with a known address - uses 'query' parameter, returns array
        params = {"query": "123 George Street Sydney NSW"}
        response = api_client.get(f"{BASE_URL}/api/geocode", params=params)
        
        # Should return 200 or geocode result
        assert response.status_code == 200, f"Geocode returned {response.status_code}"
        results = response.json()
        
        # API returns an array of results
        assert isinstance(results, list), "Expected geocode to return an array"
        assert len(results) > 0, "Expected at least one geocode result"
        
        # Check first result for required fields
        data = results[0]
        
        # Check required fields are present
        required_fields = [
            "rooftop_centroid",
            "map_pinpoint", 
            "access_navigation_point",
            "plus_code",
            "interpolation_status"
        ]
        
        missing_fields = []
        for field in required_fields:
            if field not in data:
                missing_fields.append(field)
        
        if missing_fields:
            print(f"⚠ Missing fields in geocode response: {missing_fields}")
            print(f"  Available fields: {list(data.keys())}")
        else:
            print(f"✓ All required geocode fields present: {required_fields}")
        
        # Verify structure of nested objects if present
        if "rooftop_centroid" in data:
            assert "latitude" in data["rooftop_centroid"] or data["rooftop_centroid"] is None
            assert "longitude" in data["rooftop_centroid"] or data["rooftop_centroid"] is None
            print(f"✓ rooftop_centroid has valid structure")
        
        if "map_pinpoint" in data:
            assert "latitude" in data["map_pinpoint"] or data["map_pinpoint"] is None
            print(f"✓ map_pinpoint has valid structure")
        
        if "access_navigation_point" in data:
            assert "latitude" in data["access_navigation_point"] or data["access_navigation_point"] is None
            print(f"✓ access_navigation_point has valid structure")
        
        if "plus_code" in data:
            print(f"✓ plus_code present: {data.get('plus_code', 'N/A')}")
        
        if "interpolation_status" in data:
            print(f"✓ interpolation_status present: {data.get('interpolation_status', 'N/A')}")
        
        # Assert no missing fields for full test pass
        assert len(missing_fields) == 0, f"Missing required geocode fields: {missing_fields}"


class TestStopsCRUDBasics:
    """Basic stops CRUD operations for regression"""
    
    def test_get_stops_returns_list(self, api_client):
        """GET /api/stops returns a list"""
        response = api_client.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"✓ GET /api/stops returned list with {len(data)} stops")
    
    def test_create_and_delete_stop(self, api_client):
        """Create and delete a stop"""
        stop_data = {
            "address": f"TEST_CRUD_{uuid.uuid4().hex[:8]} Test Address",
            "latitude": -33.8688,
            "longitude": 151.2093,
            "name": "TEST CRUD Stop",
            "priority": "low"
        }
        
        # Create
        create_response = api_client.post(f"{BASE_URL}/api/stops", json=stop_data)
        assert create_response.status_code == 200
        created = create_response.json()
        assert "id" in created
        stop_id = created["id"]
        print(f"✓ Created stop: {stop_id}")
        
        # Verify with GET
        get_response = api_client.get(f"{BASE_URL}/api/stops")
        stops = get_response.json()
        found = any(s["id"] == stop_id for s in stops)
        assert found, "Created stop not found in GET /api/stops"
        print(f"✓ Verified stop exists in list")
        
        # Delete
        delete_response = api_client.delete(f"{BASE_URL}/api/stops/{stop_id}")
        assert delete_response.status_code == 200
        print(f"✓ Deleted stop: {stop_id}")
        
        # Verify deletion
        get_response = api_client.get(f"{BASE_URL}/api/stops")
        stops = get_response.json()
        found = any(s["id"] == stop_id for s in stops)
        assert not found, "Deleted stop still found in GET /api/stops"
        print(f"✓ Verified stop deleted")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
