"""
Test Stop ID Stability - Regression tests for the Stop ID mutation bug fix.

The critical bug was that Stop IDs were mutating/regenerating on reads due to Pydantic default_factory.
The fix was:
1) Made `id` required in Stop model (no default_factory)
2) Added explicit uuid.uuid4() generation only in creation endpoints (POST /api/stops and POST /api/import/process)

This test suite verifies:
- All CRUD endpoints return stable IDs
- IDs remain unchanged across multiple reads
- IDs remain unchanged after complete/uncomplete operations
- IDs remain unchanged after update operations
- Optimize endpoint returns stops with stable IDs
- No ValidationErrors occur on any endpoint
"""

import pytest
import requests
import os
import uuid
import time

# Use the external URL for testing
BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://route-opt.preview.emergentagent.com')


class TestStopIDStability:
    """Test that Stop IDs remain stable across all operations"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup for each test"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        # DEV_MODE is enabled, no auth needed
    
    # ==================== GET /api/stops ====================
    def test_get_stops_returns_stable_ids(self):
        """GET /api/stops - should return all stops with stable IDs, no _id field, no ValidationErrors"""
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        stops = response.json()
        assert isinstance(stops, list), "Response should be a list"
        
        # Verify each stop has a valid id and no _id field
        for stop in stops:
            assert "id" in stop, f"Stop missing 'id' field: {stop}"
            assert "_id" not in stop, f"Stop should not have '_id' field: {stop}"
            assert isinstance(stop["id"], str), f"Stop id should be string: {stop['id']}"
            assert len(stop["id"]) > 0, f"Stop id should not be empty"
        
        print(f"✓ GET /api/stops returned {len(stops)} stops with valid IDs")
    
    def test_get_stops_twice_returns_identical_ids(self):
        """ID stability: Fetch stops twice and compare ids are identical"""
        # First fetch
        response1 = self.session.get(f"{BASE_URL}/api/stops")
        assert response1.status_code == 200
        stops1 = response1.json()
        
        # Small delay
        time.sleep(0.5)
        
        # Second fetch
        response2 = self.session.get(f"{BASE_URL}/api/stops")
        assert response2.status_code == 200
        stops2 = response2.json()
        
        # Compare IDs
        ids1 = {s["id"] for s in stops1}
        ids2 = {s["id"] for s in stops2}
        
        assert ids1 == ids2, f"IDs changed between fetches! First: {ids1}, Second: {ids2}"
        
        # Also verify order is preserved
        id_list1 = [s["id"] for s in stops1]
        id_list2 = [s["id"] for s in stops2]
        assert id_list1 == id_list2, "Stop order changed between fetches"
        
        print(f"✓ IDs stable across 2 fetches ({len(stops1)} stops)")
    
    # ==================== POST /api/stops ====================
    def test_create_stop_generates_uuid(self):
        """POST /api/stops - should create a new stop with a generated UUID id"""
        unique_suffix = str(uuid.uuid4())[:8]
        stop_data = {
            "address": f"TEST_123 Test Street, Sydney NSW 2000_{unique_suffix}",
            "name": f"Test Stop {unique_suffix}",
            "latitude": -33.8688,
            "longitude": 151.2093,
            "priority": "medium",
            "notes": "Test stop for ID stability testing"
        }
        
        response = self.session.post(f"{BASE_URL}/api/stops", json=stop_data)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        created_stop = response.json()
        assert "id" in created_stop, "Created stop should have 'id' field"
        assert "_id" not in created_stop, "Created stop should not have '_id' field"
        
        # Verify UUID format (basic check)
        stop_id = created_stop["id"]
        assert isinstance(stop_id, str), "ID should be string"
        assert len(stop_id) == 36, f"ID should be UUID format (36 chars), got {len(stop_id)}"
        assert stop_id.count("-") == 4, "ID should have 4 dashes (UUID format)"
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/stops/{stop_id}")
        
        print(f"✓ POST /api/stops created stop with UUID: {stop_id}")
    
    # ==================== PUT /api/stops/{stop_id} ====================
    def test_update_stop_preserves_id(self):
        """PUT /api/stops/{stop_id} - should update a stop and return the same id"""
        # First create a stop
        unique_suffix = str(uuid.uuid4())[:8]
        stop_data = {
            "address": f"TEST_456 Update Street, Melbourne VIC 3000_{unique_suffix}",
            "name": f"Update Test {unique_suffix}",
            "latitude": -37.8136,
            "longitude": 144.9631,
            "priority": "low"
        }
        
        create_response = self.session.post(f"{BASE_URL}/api/stops", json=stop_data)
        assert create_response.status_code == 200
        created_stop = create_response.json()
        original_id = created_stop["id"]
        
        # Update the stop
        update_data = {
            "notes": "Updated notes for ID stability test",
            "priority": "high"
        }
        
        update_response = self.session.put(f"{BASE_URL}/api/stops/{original_id}", json=update_data)
        assert update_response.status_code == 200, f"Expected 200, got {update_response.status_code}: {update_response.text}"
        
        updated_stop = update_response.json()
        assert updated_stop["id"] == original_id, f"ID changed after update! Original: {original_id}, After: {updated_stop['id']}"
        assert updated_stop["notes"] == "Updated notes for ID stability test"
        assert updated_stop["priority"] == "high"
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/stops/{original_id}")
        
        print(f"✓ PUT /api/stops preserved ID: {original_id}")
    
    def test_update_stop_notes_preserves_id(self):
        """ID stability: Update stop notes and verify id unchanged"""
        # Get existing stops
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        if len(stops) == 0:
            pytest.skip("No stops available for update test")
        
        # Pick a stop to update
        test_stop = stops[0]
        original_id = test_stop["id"]
        original_notes = test_stop.get("notes", "")
        
        # Update notes
        new_notes = f"Updated at {time.time()}"
        update_response = self.session.put(
            f"{BASE_URL}/api/stops/{original_id}",
            json={"notes": new_notes}
        )
        assert update_response.status_code == 200
        
        updated_stop = update_response.json()
        assert updated_stop["id"] == original_id, f"ID changed after notes update!"
        
        # Restore original notes
        self.session.put(f"{BASE_URL}/api/stops/{original_id}", json={"notes": original_notes})
        
        print(f"✓ Update notes preserved ID: {original_id}")
    
    # ==================== DELETE /api/stops/{stop_id} ====================
    def test_delete_stop_returns_success(self):
        """DELETE /api/stops/{stop_id} - should delete stop and return success"""
        # Create a stop to delete
        unique_suffix = str(uuid.uuid4())[:8]
        stop_data = {
            "address": f"TEST_789 Delete Street, Brisbane QLD 4000_{unique_suffix}",
            "name": f"Delete Test {unique_suffix}",
            "latitude": -27.4698,
            "longitude": 153.0251,
            "priority": "low"
        }
        
        create_response = self.session.post(f"{BASE_URL}/api/stops", json=stop_data)
        assert create_response.status_code == 200
        created_stop = create_response.json()
        stop_id = created_stop["id"]
        
        # Delete the stop
        delete_response = self.session.delete(f"{BASE_URL}/api/stops/{stop_id}")
        assert delete_response.status_code == 200, f"Expected 200, got {delete_response.status_code}: {delete_response.text}"
        
        result = delete_response.json()
        assert "message" in result
        assert result.get("deleted_stop_id") == stop_id
        
        # Verify stop is gone
        get_response = self.session.get(f"{BASE_URL}/api/stops")
        stops = get_response.json()
        stop_ids = [s["id"] for s in stops]
        assert stop_id not in stop_ids, "Deleted stop should not appear in list"
        
        print(f"✓ DELETE /api/stops/{stop_id} succeeded")
    
    # ==================== POST /api/stops/{stop_id}/complete ====================
    def test_complete_stop_preserves_id(self):
        """POST /api/stops/{stop_id}/complete - should mark complete and return same id"""
        # Create a stop
        unique_suffix = str(uuid.uuid4())[:8]
        stop_data = {
            "address": f"TEST_Complete Street, Perth WA 6000_{unique_suffix}",
            "name": f"Complete Test {unique_suffix}",
            "latitude": -31.9505,
            "longitude": 115.8605,
            "priority": "medium"
        }
        
        create_response = self.session.post(f"{BASE_URL}/api/stops", json=stop_data)
        assert create_response.status_code == 200
        created_stop = create_response.json()
        original_id = created_stop["id"]
        
        # Complete the stop
        complete_response = self.session.post(f"{BASE_URL}/api/stops/{original_id}/complete")
        assert complete_response.status_code == 200, f"Expected 200, got {complete_response.status_code}: {complete_response.text}"
        
        completed_stop = complete_response.json()
        assert completed_stop["id"] == original_id, f"ID changed after complete! Original: {original_id}, After: {completed_stop['id']}"
        assert completed_stop["completed"] == True
        assert completed_stop["delivery_status"] == "delivered"
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/stops/{original_id}")
        
        print(f"✓ POST /api/stops/{original_id}/complete preserved ID")
    
    # ==================== POST /api/stops/{stop_id}/uncomplete ====================
    def test_uncomplete_stop_preserves_id(self):
        """POST /api/stops/{stop_id}/uncomplete - should revert and return same id"""
        # Create and complete a stop
        unique_suffix = str(uuid.uuid4())[:8]
        stop_data = {
            "address": f"TEST_Uncomplete Street, Adelaide SA 5000_{unique_suffix}",
            "name": f"Uncomplete Test {unique_suffix}",
            "latitude": -34.9285,
            "longitude": 138.6007,
            "priority": "medium"
        }
        
        create_response = self.session.post(f"{BASE_URL}/api/stops", json=stop_data)
        assert create_response.status_code == 200
        created_stop = create_response.json()
        original_id = created_stop["id"]
        
        # Complete first
        self.session.post(f"{BASE_URL}/api/stops/{original_id}/complete")
        
        # Then uncomplete
        uncomplete_response = self.session.post(f"{BASE_URL}/api/stops/{original_id}/uncomplete")
        assert uncomplete_response.status_code == 200, f"Expected 200, got {uncomplete_response.status_code}: {uncomplete_response.text}"
        
        uncompleted_stop = uncomplete_response.json()
        assert uncompleted_stop["id"] == original_id, f"ID changed after uncomplete! Original: {original_id}, After: {uncompleted_stop['id']}"
        assert uncompleted_stop["completed"] == False
        assert uncompleted_stop["delivery_status"] == "pending"
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/stops/{original_id}")
        
        print(f"✓ POST /api/stops/{original_id}/uncomplete preserved ID")
    
    def test_complete_then_uncomplete_preserves_id(self):
        """ID stability: Complete then uncomplete a stop and verify id unchanged"""
        # Get existing stops
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        # Find an incomplete stop
        incomplete_stops = [s for s in stops if not s.get("completed")]
        if len(incomplete_stops) == 0:
            pytest.skip("No incomplete stops available for test")
        
        test_stop = incomplete_stops[0]
        original_id = test_stop["id"]
        
        # Complete
        complete_response = self.session.post(f"{BASE_URL}/api/stops/{original_id}/complete")
        assert complete_response.status_code == 200
        completed_stop = complete_response.json()
        assert completed_stop["id"] == original_id
        
        # Uncomplete
        uncomplete_response = self.session.post(f"{BASE_URL}/api/stops/{original_id}/uncomplete")
        assert uncomplete_response.status_code == 200
        uncompleted_stop = uncomplete_response.json()
        assert uncompleted_stop["id"] == original_id
        
        print(f"✓ Complete/uncomplete cycle preserved ID: {original_id}")
    
    # ==================== POST /api/optimize ====================
    def test_optimize_returns_stable_ids(self):
        """POST /api/optimize - should optimize route and return stops with stable ids (use algorithm=two_opt)"""
        # Get current stops
        get_response = self.session.get(f"{BASE_URL}/api/stops")
        assert get_response.status_code == 200
        original_stops = get_response.json()
        
        if len(original_stops) < 2:
            pytest.skip("Need at least 2 stops for optimization test")
        
        original_ids = {s["id"] for s in original_stops}
        
        # Optimize with two_opt
        optimize_response = self.session.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "two_opt"}
        )
        assert optimize_response.status_code == 200, f"Expected 200, got {optimize_response.status_code}: {optimize_response.text}"
        
        result = optimize_response.json()
        assert "stops" in result, "Optimize response should contain 'stops'"
        
        optimized_stops = result["stops"]
        optimized_ids = {s["id"] for s in optimized_stops}
        
        # Verify all original IDs are present (no new IDs generated)
        assert original_ids == optimized_ids, f"IDs changed after optimization! Original: {original_ids}, After: {optimized_ids}"
        
        # Verify no _id field
        for stop in optimized_stops:
            assert "_id" not in stop, f"Stop should not have '_id' field after optimization"
        
        print(f"✓ POST /api/optimize (two_opt) preserved all {len(optimized_ids)} IDs")
    
    # ==================== GET /api/car/next-stops ====================
    def test_car_next_stops_returns_valid_ids(self):
        """GET /api/car/next-stops - should return incomplete stops with valid ids"""
        response = self.session.get(f"{BASE_URL}/api/car/next-stops")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        stops = response.json()
        assert isinstance(stops, list), "Response should be a list"
        
        for stop in stops:
            assert "id" in stop, f"Stop missing 'id' field"
            assert "_id" not in stop, f"Stop should not have '_id' field"
            assert isinstance(stop["id"], str), "ID should be string"
            assert len(stop["id"]) > 0, "ID should not be empty"
            # All returned stops should be incomplete
            assert stop.get("completed") != True, "car/next-stops should only return incomplete stops"
        
        print(f"✓ GET /api/car/next-stops returned {len(stops)} stops with valid IDs")
    
    # ==================== POST /api/stops/reorder ====================
    def test_reorder_stops_preserves_ids(self):
        """POST /api/stops/reorder - should reorder stops without changing ids"""
        # Get current stops
        get_response = self.session.get(f"{BASE_URL}/api/stops")
        assert get_response.status_code == 200
        original_stops = get_response.json()
        
        if len(original_stops) < 2:
            pytest.skip("Need at least 2 stops for reorder test")
        
        original_ids = [s["id"] for s in original_stops]
        
        # Reverse the order
        reversed_ids = list(reversed(original_ids))
        
        reorder_response = self.session.post(
            f"{BASE_URL}/api/stops/reorder",
            json={"stop_ids": reversed_ids}
        )
        assert reorder_response.status_code == 200, f"Expected 200, got {reorder_response.status_code}: {reorder_response.text}"
        
        # Verify IDs are preserved
        get_response2 = self.session.get(f"{BASE_URL}/api/stops")
        reordered_stops = get_response2.json()
        reordered_ids = [s["id"] for s in reordered_stops]
        
        # Same IDs, different order
        assert set(original_ids) == set(reordered_ids), "IDs changed after reorder!"
        
        # Restore original order
        self.session.post(f"{BASE_URL}/api/stops/reorder", json={"stop_ids": original_ids})
        
        print(f"✓ POST /api/stops/reorder preserved all {len(original_ids)} IDs")
    
    # ==================== POST /api/stops/{stop_id}/regeocode ====================
    def test_regeocode_stop_preserves_id(self):
        """POST /api/stops/{stop_id}/regeocode - should return stop with same id"""
        # Create a stop
        unique_suffix = str(uuid.uuid4())[:8]
        stop_data = {
            "address": f"TEST_100 George Street, Sydney NSW 2000_{unique_suffix}",
            "name": f"Regeocode Test {unique_suffix}",
            "latitude": -33.8688,
            "longitude": 151.2093,
            "priority": "medium"
        }
        
        create_response = self.session.post(f"{BASE_URL}/api/stops", json=stop_data)
        assert create_response.status_code == 200
        created_stop = create_response.json()
        original_id = created_stop["id"]
        
        # Regeocode the stop
        regeocode_response = self.session.post(
            f"{BASE_URL}/api/stops/{original_id}/regeocode",
            json={"address": "100 George Street, Sydney NSW 2000"}
        )
        assert regeocode_response.status_code == 200, f"Expected 200, got {regeocode_response.status_code}: {regeocode_response.text}"
        
        result = regeocode_response.json()
        assert "stop" in result, "Regeocode response should contain 'stop'"
        
        regeocoded_stop = result["stop"]
        assert regeocoded_stop["id"] == original_id, f"ID changed after regeocode! Original: {original_id}, After: {regeocoded_stop['id']}"
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/stops/{original_id}")
        
        print(f"✓ POST /api/stops/{original_id}/regeocode preserved ID")


class TestStopIDStabilityEdgeCases:
    """Edge case tests for Stop ID stability"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup for each test"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
    
    def test_multiple_reads_same_stop(self):
        """Verify reading the same stop multiple times returns identical ID"""
        # Get stops
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        if len(stops) == 0:
            pytest.skip("No stops available")
        
        test_stop_id = stops[0]["id"]
        
        # Read stops 5 times and verify ID consistency
        for i in range(5):
            response = self.session.get(f"{BASE_URL}/api/stops")
            assert response.status_code == 200
            current_stops = response.json()
            
            # Find our test stop
            matching = [s for s in current_stops if s["id"] == test_stop_id]
            assert len(matching) == 1, f"Stop {test_stop_id} not found on read {i+1}"
            assert matching[0]["id"] == test_stop_id
        
        print(f"✓ Stop ID {test_stop_id} stable across 5 reads")
    
    def test_no_validation_error_on_get_stops(self):
        """Verify GET /api/stops doesn't raise ValidationError"""
        # This test specifically checks that the Stop model can be constructed
        # from MongoDB documents without ValidationError (which would happen
        # if 'id' was missing and had no default)
        
        response = self.session.get(f"{BASE_URL}/api/stops")
        
        # If there's a ValidationError, FastAPI returns 500 or 422
        assert response.status_code == 200, f"Possible ValidationError: {response.status_code} - {response.text}"
        
        # Verify response is valid JSON list
        stops = response.json()
        assert isinstance(stops, list)
        
        print(f"✓ No ValidationError on GET /api/stops ({len(stops)} stops)")
    
    def test_car_stop_action_preserves_id(self):
        """POST /api/car/stop-action - should preserve stop ID"""
        # Create a stop
        unique_suffix = str(uuid.uuid4())[:8]
        stop_data = {
            "address": f"TEST_Car Action Street, Hobart TAS 7000_{unique_suffix}",
            "name": f"Car Action Test {unique_suffix}",
            "latitude": -42.8821,
            "longitude": 147.3272,
            "priority": "medium"
        }
        
        create_response = self.session.post(f"{BASE_URL}/api/stops", json=stop_data)
        assert create_response.status_code == 200
        created_stop = create_response.json()
        original_id = created_stop["id"]
        
        # Test delivered action
        action_response = self.session.post(
            f"{BASE_URL}/api/car/stop-action",
            json={"stop_id": original_id, "action": "delivered"}
        )
        assert action_response.status_code == 200, f"Expected 200, got {action_response.status_code}: {action_response.text}"
        
        result = action_response.json()
        assert result["id"] == original_id, f"ID changed after car action! Original: {original_id}, After: {result['id']}"
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/stops/{original_id}")
        
        print(f"✓ POST /api/car/stop-action preserved ID: {original_id}")


class TestCleanup:
    """Cleanup test data created during testing"""
    
    def test_cleanup_test_stops(self):
        """Remove any TEST_ prefixed stops created during testing"""
        session = requests.Session()
        session.headers.update({"Content-Type": "application/json"})
        
        response = session.get(f"{BASE_URL}/api/stops")
        if response.status_code != 200:
            pytest.skip("Could not fetch stops for cleanup")
        
        stops = response.json()
        test_stops = [s for s in stops if (s.get("address") or "").startswith("TEST_") or (s.get("name") or "").startswith("TEST_")]
        
        deleted_count = 0
        for stop in test_stops:
            delete_response = session.delete(f"{BASE_URL}/api/stops/{stop['id']}")
            if delete_response.status_code == 200:
                deleted_count += 1
        
        print(f"✓ Cleaned up {deleted_count} test stops")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
