"""
Test suite for completed stops persistence bug fix.

Bug Description:
Waypoints marked as 'complete' did not remain on the map or reverted to 'incomplete' state 
after a refresh or state change.

Root Causes Fixed:
1. /api/optimize filtered out completed stops and replaced the entire store
2. /api/navigation filtered out completed stops from the response
3. stopsStore.optimizeRoute() overwrote all stops with only incomplete ones
4. map GeoJSON builders used array index instead of stop.order for labels and excluded completed stops

Test Coverage:
- GET /api/stops returns ALL stops including completed=true
- POST /api/stops/{id}/complete correctly sets completed=true in DB
- POST /api/stops/{id}/uncomplete correctly sets completed=false
- GET /api/stops after completing a stop still includes the completed stop
- POST /api/optimize returns completed stops appended at end of stops array
- GET /api/navigation returns completed stops in the stops array
- GET /api/navigation completed_count reflects actual number of completed stops
"""

import pytest
import requests
import os
import uuid

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://route-opt.preview.emergentagent.com')

# Test data prefix for cleanup
TEST_PREFIX = "TEST_COMPLETED_"


class TestCompletedStopsPersistence:
    """Test suite for completed stops persistence across API endpoints"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test session"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        self.created_stop_ids = []
        yield
        # Cleanup: uncomplete and delete test stops
        for stop_id in self.created_stop_ids:
            try:
                self.session.post(f"{BASE_URL}/api/stops/{stop_id}/uncomplete")
            except:
                pass
    
    def test_health_check(self):
        """Verify API is accessible"""
        response = self.session.get(f"{BASE_URL}/api/")
        assert response.status_code == 200
        data = response.json()
        assert data.get("status") == "healthy"
        print("✓ API health check passed")
    
    def test_get_stops_returns_all_stops(self):
        """GET /api/stops should return ALL stops including completed ones"""
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        assert isinstance(stops, list)
        print(f"✓ GET /api/stops returned {len(stops)} stops")
        
        # Check if any completed stops exist (may or may not depending on state)
        completed_count = sum(1 for s in stops if s.get("completed") is True)
        incomplete_count = sum(1 for s in stops if s.get("completed") is not True)
        print(f"  - Completed: {completed_count}, Incomplete: {incomplete_count}")
        
        return stops
    
    def test_complete_stop_sets_completed_true(self):
        """POST /api/stops/{id}/complete should set completed=true in DB"""
        # First get a stop to complete
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        # Find an incomplete stop to test with
        incomplete_stops = [s for s in stops if s.get("completed") is not True]
        if not incomplete_stops:
            pytest.skip("No incomplete stops available for testing")
        
        test_stop = incomplete_stops[0]
        stop_id = test_stop["id"]
        self.created_stop_ids.append(stop_id)  # Track for cleanup
        
        print(f"Testing with stop ID: {stop_id}")
        print(f"  - Address: {test_stop.get('address', 'N/A')[:50]}...")
        print(f"  - Initial completed status: {test_stop.get('completed')}")
        
        # Complete the stop
        complete_response = self.session.post(f"{BASE_URL}/api/stops/{stop_id}/complete")
        assert complete_response.status_code == 200, f"Complete failed: {complete_response.text}"
        
        completed_stop = complete_response.json()
        assert completed_stop.get("completed") is True, "Stop should have completed=true after /complete"
        assert completed_stop.get("delivery_status") == "delivered", "delivery_status should be 'delivered'"
        assert completed_stop.get("completed_at") is not None, "completed_at should be set"
        
        print(f"✓ POST /api/stops/{stop_id}/complete correctly set completed=true")
        print(f"  - completed: {completed_stop.get('completed')}")
        print(f"  - delivery_status: {completed_stop.get('delivery_status')}")
        print(f"  - completed_at: {completed_stop.get('completed_at')}")
        
        return stop_id
    
    def test_get_stops_includes_completed_stop_after_complete(self):
        """GET /api/stops after completing a stop should still include the completed stop"""
        # First get a stop and complete it
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        incomplete_stops = [s for s in stops if s.get("completed") is not True]
        if not incomplete_stops:
            pytest.skip("No incomplete stops available for testing")
        
        test_stop = incomplete_stops[0]
        stop_id = test_stop["id"]
        self.created_stop_ids.append(stop_id)
        
        # Complete the stop
        complete_response = self.session.post(f"{BASE_URL}/api/stops/{stop_id}/complete")
        assert complete_response.status_code == 200
        
        # Now GET /api/stops again and verify the completed stop is still there
        response2 = self.session.get(f"{BASE_URL}/api/stops")
        assert response2.status_code == 200
        stops_after = response2.json()
        
        # Find the completed stop in the response
        completed_stop_in_list = next((s for s in stops_after if s["id"] == stop_id), None)
        assert completed_stop_in_list is not None, f"Completed stop {stop_id} should still be in GET /api/stops response"
        assert completed_stop_in_list.get("completed") is True, "Stop should still have completed=true"
        
        print(f"✓ GET /api/stops includes completed stop {stop_id}")
        print(f"  - Total stops: {len(stops_after)}")
        print(f"  - Completed stop found with completed={completed_stop_in_list.get('completed')}")
    
    def test_uncomplete_stop_sets_completed_false(self):
        """POST /api/stops/{id}/uncomplete should set completed=false"""
        # First get a stop and complete it
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        incomplete_stops = [s for s in stops if s.get("completed") is not True]
        if not incomplete_stops:
            pytest.skip("No incomplete stops available for testing")
        
        test_stop = incomplete_stops[0]
        stop_id = test_stop["id"]
        self.created_stop_ids.append(stop_id)
        
        # Complete the stop first
        self.session.post(f"{BASE_URL}/api/stops/{stop_id}/complete")
        
        # Now uncomplete it
        uncomplete_response = self.session.post(f"{BASE_URL}/api/stops/{stop_id}/uncomplete")
        assert uncomplete_response.status_code == 200, f"Uncomplete failed: {uncomplete_response.text}"
        
        uncompleted_stop = uncomplete_response.json()
        assert uncompleted_stop.get("completed") is False, "Stop should have completed=false after /uncomplete"
        assert uncompleted_stop.get("delivery_status") == "pending", "delivery_status should be 'pending'"
        assert uncompleted_stop.get("completed_at") is None, "completed_at should be None"
        
        print(f"✓ POST /api/stops/{stop_id}/uncomplete correctly set completed=false")
        print(f"  - completed: {uncompleted_stop.get('completed')}")
        print(f"  - delivery_status: {uncompleted_stop.get('delivery_status')}")
    
    def test_optimize_returns_completed_stops(self):
        """POST /api/optimize should return completed stops appended at end of stops array"""
        # First get a stop and complete it
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        incomplete_stops = [s for s in stops if s.get("completed") is not True]
        if len(incomplete_stops) < 2:
            pytest.skip("Need at least 2 incomplete stops for optimization test")
        
        test_stop = incomplete_stops[0]
        stop_id = test_stop["id"]
        self.created_stop_ids.append(stop_id)
        
        # Complete the stop
        self.session.post(f"{BASE_URL}/api/stops/{stop_id}/complete")
        
        # Now call optimize
        optimize_response = self.session.post(
            f"{BASE_URL}/api/optimize",
            json={"algorithm": "nearest_neighbor"}
        )
        assert optimize_response.status_code == 200, f"Optimize failed: {optimize_response.text}"
        
        optimize_data = optimize_response.json()
        optimized_stops = optimize_data.get("stops", [])
        
        # Verify the completed stop is in the response
        completed_stop_in_optimize = next((s for s in optimized_stops if s["id"] == stop_id), None)
        assert completed_stop_in_optimize is not None, f"Completed stop {stop_id} should be in /api/optimize response"
        assert completed_stop_in_optimize.get("completed") is True, "Completed stop should still have completed=true"
        
        # Verify completed stops are at the end
        completed_in_response = [s for s in optimized_stops if s.get("completed") is True]
        incomplete_in_response = [s for s in optimized_stops if s.get("completed") is not True]
        
        print(f"✓ POST /api/optimize includes completed stops")
        print(f"  - Total stops in response: {len(optimized_stops)}")
        print(f"  - Incomplete stops: {len(incomplete_in_response)}")
        print(f"  - Completed stops: {len(completed_in_response)}")
        print(f"  - Algorithm used: {optimize_data.get('algorithm')}")
        
        # Verify completed stops are appended at the end (after incomplete stops)
        if completed_in_response and incomplete_in_response:
            # Find indices
            first_completed_idx = next(i for i, s in enumerate(optimized_stops) if s.get("completed") is True)
            last_incomplete_idx = len(optimized_stops) - 1 - next(i for i, s in enumerate(reversed(optimized_stops)) if s.get("completed") is not True)
            
            # All completed should come after all incomplete
            assert first_completed_idx > last_incomplete_idx, "Completed stops should be appended after incomplete stops"
            print(f"  - Completed stops correctly appended at end (first completed at index {first_completed_idx})")
    
    def test_navigation_returns_completed_stops(self):
        """GET /api/navigation should return completed stops in the stops array"""
        # First get a stop and complete it
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        incomplete_stops = [s for s in stops if s.get("completed") is not True]
        if not incomplete_stops:
            pytest.skip("No incomplete stops available for testing")
        
        test_stop = incomplete_stops[0]
        stop_id = test_stop["id"]
        self.created_stop_ids.append(stop_id)
        
        # Complete the stop
        self.session.post(f"{BASE_URL}/api/stops/{stop_id}/complete")
        
        # Now call navigation
        nav_response = self.session.get(f"{BASE_URL}/api/navigation")
        assert nav_response.status_code == 200, f"Navigation failed: {nav_response.text}"
        
        nav_data = nav_response.json()
        nav_stops = nav_data.get("stops", [])
        
        # Verify the completed stop is in the response
        completed_stop_in_nav = next((s for s in nav_stops if s["id"] == stop_id), None)
        assert completed_stop_in_nav is not None, f"Completed stop {stop_id} should be in /api/navigation response"
        assert completed_stop_in_nav.get("completed") is True, "Completed stop should still have completed=true"
        
        print(f"✓ GET /api/navigation includes completed stops")
        print(f"  - Total stops in response: {len(nav_stops)}")
        
        # Count completed in response
        completed_in_nav = [s for s in nav_stops if s.get("completed") is True]
        print(f"  - Completed stops in response: {len(completed_in_nav)}")
    
    def test_navigation_completed_count_accurate(self):
        """GET /api/navigation completed_count should reflect actual number of completed stops"""
        # First get a stop and complete it
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        incomplete_stops = [s for s in stops if s.get("completed") is not True]
        if not incomplete_stops:
            pytest.skip("No incomplete stops available for testing")
        
        # Count current completed stops
        initial_completed = sum(1 for s in stops if s.get("completed") is True)
        
        test_stop = incomplete_stops[0]
        stop_id = test_stop["id"]
        self.created_stop_ids.append(stop_id)
        
        # Complete the stop
        self.session.post(f"{BASE_URL}/api/stops/{stop_id}/complete")
        
        # Now call navigation
        nav_response = self.session.get(f"{BASE_URL}/api/navigation")
        assert nav_response.status_code == 200, f"Navigation failed: {nav_response.text}"
        
        nav_data = nav_response.json()
        completed_count = nav_data.get("completed_count", 0)
        total_stops = nav_data.get("total_stops", 0)
        nav_stops = nav_data.get("stops", [])
        
        # Count actual completed in response
        actual_completed_in_response = sum(1 for s in nav_stops if s.get("completed") is True)
        
        # completed_count should match actual completed stops
        assert completed_count == actual_completed_in_response, \
            f"completed_count ({completed_count}) should match actual completed stops ({actual_completed_in_response})"
        
        # completed_count should be at least initial_completed + 1 (the one we just completed)
        assert completed_count >= initial_completed + 1, \
            f"completed_count ({completed_count}) should be >= initial ({initial_completed}) + 1"
        
        print(f"✓ GET /api/navigation completed_count is accurate")
        print(f"  - completed_count: {completed_count}")
        print(f"  - total_stops: {total_stops}")
        print(f"  - Actual completed in response: {actual_completed_in_response}")
    
    def test_complete_nonexistent_stop_returns_404(self):
        """POST /api/stops/{id}/complete with invalid ID should return 404"""
        fake_id = f"nonexistent-{uuid.uuid4()}"
        response = self.session.post(f"{BASE_URL}/api/stops/{fake_id}/complete")
        assert response.status_code == 404, f"Expected 404 for nonexistent stop, got {response.status_code}"
        print(f"✓ POST /api/stops/{fake_id}/complete correctly returns 404")
    
    def test_uncomplete_nonexistent_stop_returns_404(self):
        """POST /api/stops/{id}/uncomplete with invalid ID should return 404"""
        fake_id = f"nonexistent-{uuid.uuid4()}"
        response = self.session.post(f"{BASE_URL}/api/stops/{fake_id}/uncomplete")
        assert response.status_code == 404, f"Expected 404 for nonexistent stop, got {response.status_code}"
        print(f"✓ POST /api/stops/{fake_id}/uncomplete correctly returns 404")


class TestCompletedStopsDataIntegrity:
    """Additional tests for data integrity of completed stops"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test session"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        self.created_stop_ids = []
        yield
        # Cleanup
        for stop_id in self.created_stop_ids:
            try:
                self.session.post(f"{BASE_URL}/api/stops/{stop_id}/uncomplete")
            except:
                pass
    
    def test_complete_preserves_stop_order(self):
        """Completing a stop should preserve its order field"""
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        incomplete_stops = [s for s in stops if s.get("completed") is not True]
        if not incomplete_stops:
            pytest.skip("No incomplete stops available")
        
        test_stop = incomplete_stops[0]
        stop_id = test_stop["id"]
        original_order = test_stop.get("order")
        self.created_stop_ids.append(stop_id)
        
        # Complete the stop
        complete_response = self.session.post(f"{BASE_URL}/api/stops/{stop_id}/complete")
        assert complete_response.status_code == 200
        
        completed_stop = complete_response.json()
        assert completed_stop.get("order") == original_order, \
            f"Order should be preserved: expected {original_order}, got {completed_stop.get('order')}"
        
        print(f"✓ Completing stop preserves order field (order={original_order})")
    
    def test_complete_preserves_all_stop_fields(self):
        """Completing a stop should preserve all other fields (address, lat, lng, etc.)"""
        response = self.session.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        stops = response.json()
        
        incomplete_stops = [s for s in stops if s.get("completed") is not True]
        if not incomplete_stops:
            pytest.skip("No incomplete stops available")
        
        test_stop = incomplete_stops[0]
        stop_id = test_stop["id"]
        self.created_stop_ids.append(stop_id)
        
        # Store original values
        original_address = test_stop.get("address")
        original_lat = test_stop.get("latitude")
        original_lng = test_stop.get("longitude")
        original_name = test_stop.get("name")
        original_priority = test_stop.get("priority")
        
        # Complete the stop
        complete_response = self.session.post(f"{BASE_URL}/api/stops/{stop_id}/complete")
        assert complete_response.status_code == 200
        
        completed_stop = complete_response.json()
        
        # Verify all fields preserved
        assert completed_stop.get("address") == original_address, "Address should be preserved"
        assert completed_stop.get("latitude") == original_lat, "Latitude should be preserved"
        assert completed_stop.get("longitude") == original_lng, "Longitude should be preserved"
        assert completed_stop.get("name") == original_name, "Name should be preserved"
        assert completed_stop.get("priority") == original_priority, "Priority should be preserved"
        
        print(f"✓ Completing stop preserves all fields")
        print(f"  - address: {original_address[:30]}...")
        print(f"  - coordinates: ({original_lat}, {original_lng})")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
