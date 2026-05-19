"""
Test Route History & Stats Feature
- POST /api/routes/archive — archives current stops into route_history collection
- GET /api/routes/history — lists all archived routes (summary only, no stops array)
- GET /api/routes/history/{id} — returns full detail of a specific archived route with all stops
- DELETE /api/routes/history/{id} — deletes a specific route from history
- GET /api/routes/stats — returns aggregate lifetime stats across all archived routes

DEV_MODE is enabled, so no authentication token is needed.
"""

import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', 'https://route-opt.preview.emergentagent.com').rstrip('/')


class TestRouteHistoryStats:
    """Route History & Stats endpoint tests"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test data - create some stops before archiving"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        self.created_stop_ids = []
        self.archived_route_id = None
        yield
        # Cleanup: delete test stops and archived routes
        self._cleanup()
    
    def _cleanup(self):
        """Clean up test data"""
        # Delete any test stops we created
        for stop_id in self.created_stop_ids:
            try:
                self.session.delete(f"{BASE_URL}/api/stops/{stop_id}")
            except:
                pass
        
        # Delete archived route if we created one
        if self.archived_route_id:
            try:
                self.session.delete(f"{BASE_URL}/api/routes/history/{self.archived_route_id}")
            except:
                pass
    
    def _create_test_stops(self, count=3):
        """Create test stops for archiving"""
        stops = []
        for i in range(count):
            stop_data = {
                "address": f"TEST_HISTORY_{i} Test Street, Brisbane QLD",
                "name": f"Test Stop {i}",
                "latitude": -27.4698 + (i * 0.01),
                "longitude": 153.0251 + (i * 0.01),
                "priority": "medium",
                "weight": 1.5 + i,
                "quantity": 2 + i,
                "delivery_status": "pending" if i > 0 else "delivered"
            }
            response = self.session.post(f"{BASE_URL}/api/stops", json=stop_data)
            if response.status_code in [200, 201]:
                stop = response.json()
                stops.append(stop)
                self.created_stop_ids.append(stop["id"])
        return stops
    
    def _mark_stop_delivered(self, stop_id):
        """Mark a stop as delivered"""
        response = self.session.post(f"{BASE_URL}/api/stops/{stop_id}/complete")
        return response.status_code == 200
    
    # ==================== Archive Route Tests ====================
    
    def test_archive_route_with_stops(self):
        """POST /api/routes/archive - archives current stops"""
        # Clear existing stops first to ensure clean state
        self.session.delete(f"{BASE_URL}/api/stops")
        
        # Create test stops first
        stops = self._create_test_stops(3)
        assert len(stops) == 3, "Failed to create test stops"
        
        # Mark one as delivered
        self._mark_stop_delivered(stops[0]["id"])
        
        # Archive the route
        response = self.session.post(f"{BASE_URL}/api/routes/archive")
        assert response.status_code == 200, f"Archive failed: {response.text}"
        
        data = response.json()
        assert data.get("archived") == True, "Route should be archived"
        assert "route" in data, "Response should contain route data"
        
        route = data["route"]
        assert "id" in route, "Route should have an ID"
        assert "user_id" in route, "Route should have user_id"
        assert "archived_at" in route, "Route should have archived_at timestamp"
        assert "stops" in route, "Route should contain stops array"
        assert "summary" in route, "Route should contain summary"
        
        # Verify summary structure
        summary = route["summary"]
        assert summary["total_stops"] == 3, f"Expected 3 stops, got {summary['total_stops']}"
        assert summary["delivered"] >= 1, "Should have at least 1 delivered stop"
        assert "skipped" in summary
        assert "failed" in summary
        assert "pending" in summary
        assert "total_weight_kg" in summary
        assert "total_quantity" in summary
        
        # Store for cleanup
        self.archived_route_id = route["id"]
        
        # Clear created stop IDs since they're now archived
        self.created_stop_ids = []
        
        print(f"✓ Archive route successful - ID: {route['id']}, Summary: {summary}")
    
    def test_archive_route_no_stops(self):
        """POST /api/routes/archive - returns archived=false when no stops"""
        # First delete all stops to ensure clean state
        self.session.delete(f"{BASE_URL}/api/stops")
        
        # Try to archive with no stops
        response = self.session.post(f"{BASE_URL}/api/routes/archive")
        assert response.status_code == 200, f"Archive request failed: {response.text}"
        
        data = response.json()
        assert data.get("archived") == False, "Should return archived=false when no stops"
        assert "message" in data, "Should have a message explaining why"
        
        print(f"✓ Archive with no stops returns: {data}")
    
    # ==================== Get History List Tests ====================
    
    def test_get_route_history_list(self):
        """GET /api/routes/history - lists archived routes without stops array"""
        # Create and archive a route first
        stops = self._create_test_stops(2)
        archive_response = self.session.post(f"{BASE_URL}/api/routes/archive")
        assert archive_response.status_code == 200
        archived_data = archive_response.json()
        self.archived_route_id = archived_data.get("route", {}).get("id")
        self.created_stop_ids = []  # Stops are archived now
        
        # Get history list
        response = self.session.get(f"{BASE_URL}/api/routes/history")
        assert response.status_code == 200, f"Get history failed: {response.text}"
        
        data = response.json()
        assert "routes" in data, "Response should contain routes array"
        
        routes = data["routes"]
        assert len(routes) >= 1, "Should have at least 1 archived route"
        
        # Check that stops array is NOT included (summary only)
        for route in routes:
            assert "id" in route, "Route should have ID"
            assert "archived_at" in route, "Route should have archived_at"
            assert "summary" in route, "Route should have summary"
            assert "stops" not in route, "Stops array should NOT be in list response"
        
        print(f"✓ Get history list successful - {len(routes)} routes found")
    
    # ==================== Get Route Detail Tests ====================
    
    def test_get_route_detail_with_stops(self):
        """GET /api/routes/history/{id} - returns full route with stops"""
        # Create and archive a route
        stops = self._create_test_stops(3)
        archive_response = self.session.post(f"{BASE_URL}/api/routes/archive")
        assert archive_response.status_code == 200
        archived_data = archive_response.json()
        route_id = archived_data.get("route", {}).get("id")
        self.archived_route_id = route_id
        self.created_stop_ids = []
        
        # Get route detail
        response = self.session.get(f"{BASE_URL}/api/routes/history/{route_id}")
        assert response.status_code == 200, f"Get route detail failed: {response.text}"
        
        route = response.json()
        assert route["id"] == route_id, "Route ID should match"
        assert "stops" in route, "Detail response should include stops array"
        assert len(route["stops"]) == 3, f"Expected 3 stops, got {len(route['stops'])}"
        assert "summary" in route, "Should include summary"
        assert "archived_at" in route, "Should include archived_at"
        
        # Verify stop structure
        for stop in route["stops"]:
            assert "id" in stop
            assert "address" in stop
            assert "latitude" in stop
            assert "longitude" in stop
        
        print(f"✓ Get route detail successful - {len(route['stops'])} stops returned")
    
    def test_get_route_detail_not_found(self):
        """GET /api/routes/history/{id} - returns 404 for non-existent route"""
        fake_id = "non-existent-route-id-12345"
        response = self.session.get(f"{BASE_URL}/api/routes/history/{fake_id}")
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        
        print("✓ Get non-existent route returns 404")
    
    # ==================== Delete Route Tests ====================
    
    def test_delete_route_from_history(self):
        """DELETE /api/routes/history/{id} - deletes archived route"""
        # Create and archive a route
        stops = self._create_test_stops(2)
        archive_response = self.session.post(f"{BASE_URL}/api/routes/archive")
        assert archive_response.status_code == 200
        archived_data = archive_response.json()
        route_id = archived_data.get("route", {}).get("id")
        self.created_stop_ids = []
        
        # Delete the route
        response = self.session.delete(f"{BASE_URL}/api/routes/history/{route_id}")
        assert response.status_code == 200, f"Delete failed: {response.text}"
        
        data = response.json()
        assert data.get("deleted") == True, "Should return deleted=true"
        assert data.get("route_id") == route_id, "Should return deleted route_id"
        
        # Verify it's actually deleted
        verify_response = self.session.get(f"{BASE_URL}/api/routes/history/{route_id}")
        assert verify_response.status_code == 404, "Deleted route should return 404"
        
        # Clear archived_route_id since we deleted it
        self.archived_route_id = None
        
        print(f"✓ Delete route successful - ID: {route_id}")
    
    def test_delete_route_not_found(self):
        """DELETE /api/routes/history/{id} - returns 404 for non-existent route"""
        fake_id = "non-existent-route-id-67890"
        response = self.session.delete(f"{BASE_URL}/api/routes/history/{fake_id}")
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        
        print("✓ Delete non-existent route returns 404")
    
    # ==================== Stats Tests ====================
    
    def test_get_route_stats(self):
        """GET /api/routes/stats - returns aggregate lifetime stats"""
        # Create and archive a route with some delivered stops
        stops = self._create_test_stops(3)
        # Mark 2 as delivered
        self._mark_stop_delivered(stops[0]["id"])
        self._mark_stop_delivered(stops[1]["id"])
        
        archive_response = self.session.post(f"{BASE_URL}/api/routes/archive")
        assert archive_response.status_code == 200
        archived_data = archive_response.json()
        self.archived_route_id = archived_data.get("route", {}).get("id")
        self.created_stop_ids = []
        
        # Get stats
        response = self.session.get(f"{BASE_URL}/api/routes/stats")
        assert response.status_code == 200, f"Get stats failed: {response.text}"
        
        stats = response.json()
        
        # Verify all expected fields are present
        expected_fields = [
            "total_routes",
            "total_delivered",
            "total_skipped",
            "total_failed",
            "total_stops",
            "total_weight_kg",
            "total_quantity",
            "avg_stops_per_route",
            "avg_delivered_per_route"
        ]
        
        for field in expected_fields:
            assert field in stats, f"Stats should include {field}"
        
        # Verify values are reasonable
        assert stats["total_routes"] >= 1, "Should have at least 1 route"
        assert stats["total_stops"] >= 3, "Should have at least 3 stops"
        assert stats["total_delivered"] >= 2, "Should have at least 2 delivered"
        
        print(f"✓ Get stats successful: {stats}")
    
    def test_get_route_stats_empty(self):
        """GET /api/routes/stats - returns zeros when no archived routes"""
        # This test checks the default response structure
        # Note: We can't guarantee empty state, but we can verify structure
        response = self.session.get(f"{BASE_URL}/api/routes/stats")
        assert response.status_code == 200, f"Get stats failed: {response.text}"
        
        stats = response.json()
        
        # Verify structure exists even if values are non-zero
        assert "total_routes" in stats
        assert "total_delivered" in stats
        assert "total_skipped" in stats
        assert "total_failed" in stats
        assert "total_stops" in stats
        assert "total_weight_kg" in stats
        assert "total_quantity" in stats
        
        print(f"✓ Stats structure verified: {list(stats.keys())}")


class TestRouteHistorySummaryFields:
    """Test that summary fields are correctly calculated"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        self.archived_route_id = None
        yield
        if self.archived_route_id:
            try:
                self.session.delete(f"{BASE_URL}/api/routes/history/{self.archived_route_id}")
            except:
                pass
    
    def test_summary_weight_and_quantity_calculation(self):
        """Verify weight and quantity are summed correctly in summary"""
        # Delete existing stops first
        self.session.delete(f"{BASE_URL}/api/stops")
        
        # Create stops with known weights and quantities
        stops_data = [
            {"address": "TEST_WEIGHT_1 Street", "latitude": -27.47, "longitude": 153.02, "weight": 2.5, "quantity": 3},
            {"address": "TEST_WEIGHT_2 Street", "latitude": -27.48, "longitude": 153.03, "weight": 3.5, "quantity": 5},
            {"address": "TEST_WEIGHT_3 Street", "latitude": -27.49, "longitude": 153.04, "weight": 4.0, "quantity": 2},
        ]
        
        created_ids = []
        for stop_data in stops_data:
            response = self.session.post(f"{BASE_URL}/api/stops", json=stop_data)
            if response.status_code in [200, 201]:
                created_ids.append(response.json()["id"])
        
        assert len(created_ids) == 3, "Failed to create all test stops"
        
        # Archive
        archive_response = self.session.post(f"{BASE_URL}/api/routes/archive")
        assert archive_response.status_code == 200
        
        data = archive_response.json()
        self.archived_route_id = data.get("route", {}).get("id")
        
        summary = data["route"]["summary"]
        
        # Expected: 2.5 + 3.5 + 4.0 = 10.0 kg
        assert summary["total_weight_kg"] == 10.0, f"Expected 10.0 kg, got {summary['total_weight_kg']}"
        
        # Expected: 3 + 5 + 2 = 10 items
        assert summary["total_quantity"] == 10, f"Expected 10 items, got {summary['total_quantity']}"
        
        print(f"✓ Weight and quantity calculation correct: {summary['total_weight_kg']}kg, {summary['total_quantity']} items")


class TestRouteHistoryIntegration:
    """Integration tests for route history workflow"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        self.archived_route_ids = []
        yield
        # Cleanup
        for route_id in self.archived_route_ids:
            try:
                self.session.delete(f"{BASE_URL}/api/routes/history/{route_id}")
            except:
                pass
    
    def test_full_workflow_archive_list_detail_delete(self):
        """Test complete workflow: create stops -> archive -> list -> detail -> delete"""
        # 1. Delete existing stops
        self.session.delete(f"{BASE_URL}/api/stops")
        
        # 2. Create stops
        for i in range(2):
            self.session.post(f"{BASE_URL}/api/stops", json={
                "address": f"TEST_WORKFLOW_{i} Street",
                "latitude": -27.47 + (i * 0.01),
                "longitude": 153.02 + (i * 0.01),
                "weight": 1.0,
                "quantity": 1
            })
        
        # 3. Archive
        archive_response = self.session.post(f"{BASE_URL}/api/routes/archive")
        assert archive_response.status_code == 200
        route_id = archive_response.json()["route"]["id"]
        self.archived_route_ids.append(route_id)
        
        # 4. List - should include our route
        list_response = self.session.get(f"{BASE_URL}/api/routes/history")
        assert list_response.status_code == 200
        routes = list_response.json()["routes"]
        route_ids = [r["id"] for r in routes]
        assert route_id in route_ids, "Archived route should appear in list"
        
        # 5. Detail - should include stops
        detail_response = self.session.get(f"{BASE_URL}/api/routes/history/{route_id}")
        assert detail_response.status_code == 200
        detail = detail_response.json()
        assert len(detail["stops"]) == 2, "Detail should have 2 stops"
        
        # 6. Delete
        delete_response = self.session.delete(f"{BASE_URL}/api/routes/history/{route_id}")
        assert delete_response.status_code == 200
        
        # 7. Verify deleted
        verify_response = self.session.get(f"{BASE_URL}/api/routes/history/{route_id}")
        assert verify_response.status_code == 404
        
        self.archived_route_ids.remove(route_id)
        
        print("✓ Full workflow test passed: archive -> list -> detail -> delete")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
