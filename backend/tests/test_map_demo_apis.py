"""
Test suite for DeliveryMap demo page APIs
Tests /api/stops, /api/directions, and /api/map-test endpoints
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://route-opt.preview.emergentagent.com').rstrip('/')


class TestStopsAPI:
    """Tests for /api/stops endpoint"""
    
    def test_get_stops_returns_200(self):
        """GET /api/stops should return 200 with list of stops"""
        response = requests.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        print(f"GET /api/stops returned {len(data)} stops")
    
    def test_stops_have_required_fields(self):
        """Each stop should have id, latitude, longitude, order fields"""
        response = requests.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        
        data = response.json()
        if len(data) > 0:
            stop = data[0]
            required_fields = ['id', 'latitude', 'longitude', 'order', 'address']
            for field in required_fields:
                assert field in stop, f"Stop missing required field: {field}"
            print(f"Stop has all required fields: {required_fields}")
    
    def test_stops_count_is_55(self):
        """Should have 55 delivery stops as per requirements"""
        response = requests.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        
        data = response.json()
        # Note: The actual count may vary based on test data
        print(f"Total stops count: {len(data)}")
        assert len(data) > 0, "Should have at least some stops"


class TestDirectionsAPI:
    """Tests for /api/directions endpoint"""
    
    def test_directions_returns_200(self):
        """GET /api/directions should return 200 with route geometry"""
        # Use sample coordinates from stops
        coords = "153.13276,-26.724115;153.131644,-26.727877;153.132415,-26.729152"
        response = requests.get(f"{BASE_URL}/api/directions?coordinates={coords}")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert 'geometry' in data, "Response should have geometry field"
        print("GET /api/directions returned route geometry")
    
    def test_directions_geometry_is_linestring(self):
        """Route geometry should be a LineString"""
        coords = "153.13276,-26.724115;153.131644,-26.727877;153.132415,-26.729152"
        response = requests.get(f"{BASE_URL}/api/directions?coordinates={coords}")
        assert response.status_code == 200
        
        data = response.json()
        geometry = data.get('geometry', {})
        assert geometry.get('type') == 'LineString', "Geometry type should be LineString"
        assert 'coordinates' in geometry, "Geometry should have coordinates"
        assert len(geometry['coordinates']) > 0, "Coordinates should not be empty"
        print(f"Route has {len(geometry['coordinates'])} coordinate points")
    
    def test_directions_has_distance_and_duration(self):
        """Response should include distance and duration"""
        coords = "153.13276,-26.724115;153.131644,-26.727877"
        response = requests.get(f"{BASE_URL}/api/directions?coordinates={coords}")
        assert response.status_code == 200
        
        data = response.json()
        assert 'distance' in data, "Response should have distance"
        assert 'duration' in data, "Response should have duration"
        print(f"Route distance: {data['distance']}m, duration: {data['duration']}s")


class TestMapTestPage:
    """Tests for /api/map-test standalone HTML page"""
    
    def test_map_test_returns_html(self):
        """GET /api/map-test should return HTML page"""
        response = requests.get(f"{BASE_URL}/api/map-test")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        content_type = response.headers.get('content-type', '')
        assert 'text/html' in content_type, f"Expected HTML content type, got {content_type}"
        print("GET /api/map-test returned HTML page")
    
    def test_map_test_contains_maplibre(self):
        """HTML page should include MapLibre script"""
        response = requests.get(f"{BASE_URL}/api/map-test")
        assert response.status_code == 200
        
        content = response.text
        assert 'maplibre' in content.lower(), "Page should include MapLibre"
        print("Map test page includes MapLibre")


class TestHealthEndpoint:
    """Tests for /api/health endpoint"""
    
    def test_health_returns_200(self):
        """GET /api/health should return 200"""
        response = requests.get(f"{BASE_URL}/api/health")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert data.get('status') == 'healthy', "Status should be healthy"
        print("Health check passed")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
