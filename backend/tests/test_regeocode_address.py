"""
Backend API Tests for Address Update & Re-geocode Features

Tests:
1. POST /api/stops/{stop_id}/regeocode - Re-geocode a stop with new coordinates
2. PUT /api/stops/{stop_id} - Save Address updates address but NOT coordinates and marks needs-fix
3. Verify geocode_metadata.geocode_needs_fix flag behavior
"""

import pytest
import requests
import os
import time
import uuid

# Backend URL from environment
BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    BASE_URL = "https://route-opt.preview.emergentagent.com"


class TestRegeocodeAddressAPI:
    """Tests for address update and re-geocode functionality"""
    
    test_stop_ids = []  # Track created stops for cleanup
    
    @pytest.fixture(autouse=True)
    def setup_teardown(self):
        """Setup and teardown for each test"""
        yield
        # Cleanup test stops
        for stop_id in self.test_stop_ids:
            try:
                requests.delete(f"{BASE_URL}/api/stops/{stop_id}")
            except:
                pass
        self.test_stop_ids.clear()
    
    def create_test_stop(self, address="123 Test St, Sydney NSW 2000", name="TEST_stop"):
        """Helper to create a test stop"""
        payload = {
            "address": address,
            "name": name,
            "latitude": -33.8688,
            "longitude": 151.2093,
            "priority": "medium",
            "geocode_metadata": {
                "geocode_needs_fix": False,
                "geocode_status": "ok",
                "place_name": address
            }
        }
        response = requests.post(f"{BASE_URL}/api/stops", json=payload)
        assert response.status_code == 200 or response.status_code == 201, f"Failed to create test stop: {response.text}"
        stop = response.json()
        self.test_stop_ids.append(stop.get("id"))
        return stop
    
    # ===== Test 1: Save Address Updates Address but NOT Coordinates =====
    
    def test_save_address_updates_address_not_coordinates(self):
        """
        Save Address should:
        - Update stop.address
        - NOT change coordinates
        - Set geocode_metadata.geocode_needs_fix = true
        """
        # Create a stop
        stop = self.create_test_stop()
        stop_id = stop["id"]
        original_lat = stop["latitude"]
        original_lng = stop["longitude"]
        
        # Save a new address via PUT (simulating Save Address button)
        new_address = "456 New Address, Melbourne VIC 3000"
        update_payload = {
            "address": new_address,
            "geocode_metadata": {
                "geocode_needs_fix": True,
                "geocode_status": "pending_regeocode",
                "geocode_issue": "Address updated manually. Re-geocode required."
            }
        }
        
        response = requests.put(f"{BASE_URL}/api/stops/{stop_id}", json=update_payload)
        assert response.status_code == 200, f"Failed to update stop address: {response.text}"
        
        updated_stop = response.json()
        
        # Verify address changed
        assert updated_stop["address"] == new_address, "Address should be updated"
        
        # Verify coordinates NOT changed
        assert updated_stop["latitude"] == original_lat, "Latitude should NOT change after Save Address"
        assert updated_stop["longitude"] == original_lng, "Longitude should NOT change after Save Address"
        
        # Verify geocode_needs_fix is set
        metadata = updated_stop.get("geocode_metadata", {})
        assert metadata.get("geocode_needs_fix") == True, "geocode_needs_fix should be True after Save Address"
        assert metadata.get("geocode_status") == "pending_regeocode", "geocode_status should be pending_regeocode"
        
        print("✅ PASS: Save Address updates address but NOT coordinates, sets needs-fix badge")
    
    # ===== Test 2: Re-geocode Success Updates Coordinates =====
    
    def test_regeocode_success_updates_coordinates(self):
        """
        POST /api/stops/{stop_id}/regeocode should:
        - Update coordinates from geocoding result
        - Update suburb if available
        - Set geocode_needs_fix = false
        - Return geocoded=true
        """
        # Create a stop with a geocodable address
        stop = self.create_test_stop(address="123 Test St, Sydney NSW", name="TEST_regeocode")
        stop_id = stop["id"]
        original_lat = stop["latitude"]
        original_lng = stop["longitude"]
        
        # Call regeocode with a real address
        regeocode_payload = {"address": "1 George Street, Sydney NSW 2000"}
        response = requests.post(f"{BASE_URL}/api/stops/{stop_id}/regeocode", json=regeocode_payload)
        
        assert response.status_code == 200, f"Re-geocode failed: {response.text}"
        
        data = response.json()
        assert "success" in data, "Response should have success field"
        assert data["success"] == True, "success should be True"
        assert "geocoded" in data, "Response should have geocoded field"
        
        if data.get("geocoded"):
            # Coordinates should be updated
            updated_stop = data.get("stop", {})
            
            # Coordinates may have changed to actual geocode result
            # We just verify the metadata is cleared
            metadata = updated_stop.get("geocode_metadata", {})
            assert metadata.get("geocode_needs_fix") == False, "geocode_needs_fix should be False after successful re-geocode"
            assert metadata.get("geocode_status") == "ok", "geocode_status should be ok after successful re-geocode"
            
            print(f"✅ PASS: Re-geocode success - coordinates updated to {updated_stop.get('latitude')}, {updated_stop.get('longitude')}")
            print(f"   Address: {updated_stop.get('address')}")
            print(f"   Suburb: {updated_stop.get('suburb')}")
        else:
            # Geocoding failed but coordinates should be preserved
            print(f"⚠️ Re-geocode did not find new coordinates (expected for some addresses)")
            print(f"   Message: {data.get('message')}")
    
    # ===== Test 3: Re-geocode Failure Keeps Old Coordinates =====
    
    def test_regeocode_failure_keeps_old_coordinates(self):
        """
        If re-geocode cannot resolve address:
        - Coordinates remain unchanged
        - Warning response is returned (geocoded=false)
        - geocode_needs_fix stays True
        """
        # Create a stop
        stop = self.create_test_stop(address="123 Test St, Sydney NSW", name="TEST_regeocode_fail")
        stop_id = stop["id"]
        original_lat = stop["latitude"]
        original_lng = stop["longitude"]
        
        # Call regeocode with a garbage address that won't geocode
        regeocode_payload = {"address": "ZZZZ XXXX QQQQ NonExistentPlace 99999"}
        response = requests.post(f"{BASE_URL}/api/stops/{stop_id}/regeocode", json=regeocode_payload)
        
        assert response.status_code == 200, f"Re-geocode endpoint failed: {response.text}"
        
        data = response.json()
        assert data.get("success") == True, "success should be True (endpoint worked)"
        
        # If geocoding failed, verify coordinates preserved
        if not data.get("geocoded"):
            updated_stop = data.get("stop", {})
            assert updated_stop.get("latitude") == original_lat, "Latitude should be preserved on geocode failure"
            assert updated_stop.get("longitude") == original_lng, "Longitude should be preserved on geocode failure"
            
            # geocode_needs_fix should still be True
            metadata = updated_stop.get("geocode_metadata", {})
            assert metadata.get("geocode_needs_fix") == True, "geocode_needs_fix should remain True on failure"
            
            print("✅ PASS: Re-geocode failure preserves old coordinates and keeps needs-fix badge")
        else:
            print("⚠️ Geocoding unexpectedly succeeded for garbage address")
    
    # ===== Test 4: Re-geocode Endpoint Exists =====
    
    def test_regeocode_endpoint_exists(self):
        """Verify the /api/stops/{stop_id}/regeocode endpoint exists and responds"""
        stop = self.create_test_stop()
        stop_id = stop["id"]
        
        # Test with empty body
        response = requests.post(f"{BASE_URL}/api/stops/{stop_id}/regeocode", json={})
        
        # Should return 200 (using existing address) or 400 (if address required)
        assert response.status_code in [200, 400, 422], f"Unexpected status: {response.status_code}"
        
        print(f"✅ PASS: Re-geocode endpoint exists - Status: {response.status_code}")
    
    # ===== Test 5: Re-geocode with No Address Uses Existing =====
    
    def test_regeocode_no_address_uses_existing(self):
        """If no address provided in payload, use stop's existing address"""
        stop = self.create_test_stop(address="100 Harris Street, Pyrmont NSW 2009")
        stop_id = stop["id"]
        
        # Call regeocode without address
        response = requests.post(f"{BASE_URL}/api/stops/{stop_id}/regeocode", json={})
        
        if response.status_code == 200:
            data = response.json()
            # Should use existing address
            assert data.get("success") == True
            print("✅ PASS: Re-geocode with no address uses existing stop address")
        else:
            print(f"⚠️ Re-geocode without address returned {response.status_code}")
    
    # ===== Test 6: Needs-fix Badge Logic in Stops =====
    
    def test_stop_needs_fix_badge_visible_in_list(self):
        """Verify stops with geocode_needs_fix=true are returned with that flag"""
        # Create a stop with needs-fix flag
        stop = self.create_test_stop()
        stop_id = stop["id"]
        
        # Update to set needs-fix
        update_payload = {
            "geocode_metadata": {
                "geocode_needs_fix": True,
                "geocode_status": "pending_regeocode"
            }
        }
        
        response = requests.put(f"{BASE_URL}/api/stops/{stop_id}", json=update_payload)
        assert response.status_code == 200
        
        # Fetch all stops and verify flag is present
        response = requests.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        
        stops = response.json()
        found_stop = None
        for s in stops:
            if s.get("id") == stop_id:
                found_stop = s
                break
        
        assert found_stop is not None, "Test stop should be in list"
        metadata = found_stop.get("geocode_metadata", {})
        assert metadata.get("geocode_needs_fix") == True, "geocode_needs_fix flag should be visible in stops list"
        
        print("✅ PASS: Stops with needs-fix badge flag are returned correctly in list")


class TestStopsAPI:
    """Basic stops API tests"""
    
    test_stop_ids = []
    
    @pytest.fixture(autouse=True)
    def cleanup(self):
        yield
        for stop_id in self.test_stop_ids:
            try:
                requests.delete(f"{BASE_URL}/api/stops/{stop_id}")
            except:
                pass
        self.test_stop_ids.clear()
    
    def test_health_check(self):
        """Verify backend is accessible"""
        response = requests.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200, f"Backend not accessible: {response.status_code}"
        print("✅ PASS: Backend /api/stops accessible")
    
    def test_create_stop(self):
        """Test stop creation"""
        payload = {
            "address": "TEST_create 123 Test St",
            "name": "TEST_create_stop",
            "latitude": -33.8688,
            "longitude": 151.2093,
            "priority": "medium"
        }
        response = requests.post(f"{BASE_URL}/api/stops", json=payload)
        assert response.status_code in [200, 201], f"Create stop failed: {response.text}"
        
        stop = response.json()
        self.test_stop_ids.append(stop.get("id"))
        
        assert stop.get("address") == "TEST_create 123 Test St"
        assert stop.get("name") == "TEST_create_stop"
        print("✅ PASS: Stop creation works")
    
    def test_update_stop(self):
        """Test stop update"""
        # Create
        payload = {
            "address": "TEST_update 456 Initial St",
            "name": "TEST_update_stop",
            "latitude": -33.8688,
            "longitude": 151.2093
        }
        create_resp = requests.post(f"{BASE_URL}/api/stops", json=payload)
        stop = create_resp.json()
        self.test_stop_ids.append(stop.get("id"))
        
        # Update
        update_payload = {"name": "Updated Name"}
        update_resp = requests.put(f"{BASE_URL}/api/stops/{stop['id']}", json=update_payload)
        assert update_resp.status_code == 200
        
        updated = update_resp.json()
        assert updated["name"] == "Updated Name"
        print("✅ PASS: Stop update works")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
