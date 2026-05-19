"""
Unit tests for RouteProgressObserver - Waypoint Reset System Testing

This tests the RouteProgressObserver TypeScript class logic by simulating its behavior
in Python. Since this is a React Native/Expo app, we test the class logic through
code review and validate backend APIs that the observer would call.

Tests cover:
1. RouteProgressObserver instantiation with config
2. onRouteProgressChanged() progress + arrival data
3. Arrival detection within 50m radius
4. Arrival cooldown (3s window)
5. setNavigationData() stores data correctly
6. resetToFirstLeg() resets leg index
7. buildRouteResetQuery() coordinate string format
8. buildUpdatedStopsGeoJSON() FeatureCollection structure
9. Backend API: GET /api/ health
10. Backend API: GET /api/stops
11. Backend API: GET /api/mapbox-token
12. Backend API: GET /api/directions (used by fetchResetRoute)
"""

import pytest
import requests
import os
import math
import time
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field

# Get backend URL from environment
BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://route-opt.preview.emergentagent.com')


# ============================================
# Python simulation of RouteProgressObserver
# ============================================

def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine formula - matches frontend utils/route.ts calculateDistance"""
    R = 6371000  # Earth's radius in meters
    dLat = (lat2 - lat1) * math.pi / 180
    dLon = (lon2 - lon1) * math.pi / 180
    a = (math.sin(dLat/2) * math.sin(dLat/2) +
         math.cos(lat1 * math.pi / 180) * math.cos(lat2 * math.pi / 180) *
         math.sin(dLon/2) * math.sin(dLon/2))
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c


@dataclass
class Stop:
    """Mock Stop type matching frontend"""
    id: str
    name: str
    address: str
    latitude: float
    longitude: float
    completed: bool = False


@dataclass 
class NavigationLeg:
    """Mock NavigationLeg type matching frontend"""
    to_stop: Optional[Stop]
    distance: float
    duration: float


@dataclass
class NavigationData:
    """Mock NavigationData type matching frontend"""
    stops: List[Stop]
    legs: List[NavigationLeg]
    geometry: Optional[dict] = None


@dataclass
class RouteProgress:
    """Progress snapshot returned by onRouteProgressChanged"""
    currentLegIndex: int
    distanceToNextStop: float
    fractionTraveled: float
    isLastLeg: bool
    currentLeg: Optional[NavigationLeg]
    remainingLegs: int


@dataclass
class ArrivalEvent:
    """Arrival event when waypoint is reached"""
    arrived: bool
    completedStop: Optional[Stop]
    newLegIndex: int
    allComplete: bool
    remainingWaypoints: List[Dict[str, float]]


@dataclass
class ObserverConfig:
    """Config for RouteProgressObserver"""
    arrivalRadiusMeters: float = 50
    arrivalCooldownMs: int = 3000
    backendUrl: str = ""
    mapboxToken: str = ""


class RouteProgressObserver:
    """
    Python simulation of RouteProgressObserver TypeScript class.
    This mirrors the logic in /app/frontend/src/navigation/RouteProgressObserver.ts
    """
    
    def __init__(self, config: Optional[dict] = None):
        default_config = ObserverConfig()
        if config:
            if 'arrivalRadiusMeters' in config:
                default_config.arrivalRadiusMeters = config['arrivalRadiusMeters']
            if 'arrivalCooldownMs' in config:
                default_config.arrivalCooldownMs = config['arrivalCooldownMs']
            if 'backendUrl' in config:
                default_config.backendUrl = config['backendUrl']
            if 'mapboxToken' in config:
                default_config.mapboxToken = config['mapboxToken']
        
        self.config = default_config
        self._lastArrivalTime = 0
        self._currentLegIndex = 0
        self._navigationData: Optional[NavigationData] = None
    
    def setNavigationData(self, data: Optional[NavigationData]):
        """Attach fresh navigation data"""
        self._navigationData = data
    
    def resetToFirstLeg(self):
        """Reset to first leg (called at navigation start)"""
        self._currentLegIndex = 0
        self._lastArrivalTime = 0
    
    @property
    def currentLegIndex(self) -> int:
        return self._currentLegIndex
    
    def setLegIndex(self, index: int):
        """Manually advance to a specific leg"""
        self._currentLegIndex = index
    
    def onRouteProgressChanged(self, gpsLocation: dict) -> dict:
        """
        Called on every GPS update. Returns progress snapshot and arrival event.
        """
        nav = self._navigationData
        if not nav or len(nav.legs) == 0:
            return {
                'progress': RouteProgress(
                    currentLegIndex=self._currentLegIndex,
                    distanceToNextStop=float('inf'),
                    fractionTraveled=0,
                    isLastLeg=True,
                    currentLeg=None,
                    remainingLegs=0
                ),
                'arrival': None
            }
        
        currentLeg = nav.legs[self._currentLegIndex] if self._currentLegIndex < len(nav.legs) else None
        isLastLeg = self._currentLegIndex >= len(nav.legs) - 1
        
        # Distance to current leg's destination
        distanceToNextStop = float('inf')
        if currentLeg and currentLeg.to_stop:
            distanceToNextStop = calculate_distance(
                gpsLocation['latitude'],
                gpsLocation['longitude'],
                currentLeg.to_stop.latitude,
                currentLeg.to_stop.longitude
            )
        
        # Fraction traveled approximation
        totalLegDist = currentLeg.distance if currentLeg else 1
        traveled = max(0, totalLegDist - distanceToNextStop)
        fractionTraveled = min(1, traveled / totalLegDist) if totalLegDist > 0 else 0
        
        progress = RouteProgress(
            currentLegIndex=self._currentLegIndex,
            distanceToNextStop=distanceToNextStop,
            fractionTraveled=fractionTraveled,
            isLastLeg=isLastLeg,
            currentLeg=currentLeg,
            remainingLegs=len(nav.legs) - self._currentLegIndex - 1
        )
        
        # Arrival detection
        now = time.time() * 1000  # milliseconds
        cooldownElapsed = (now - self._lastArrivalTime) > self.config.arrivalCooldownMs
        
        if (distanceToNextStop <= self.config.arrivalRadiusMeters and 
            cooldownElapsed and 
            currentLeg and currentLeg.to_stop):
            
            self._lastArrivalTime = now
            completedStop = currentLeg.to_stop
            
            if isLastLeg:
                return {
                    'progress': progress,
                    'arrival': ArrivalEvent(
                        arrived=True,
                        completedStop=completedStop,
                        newLegIndex=self._currentLegIndex,
                        allComplete=True,
                        remainingWaypoints=[]
                    )
                }
            
            # Advance to next leg
            self._currentLegIndex += 1
            
            # Build remaining waypoints
            remainingWaypoints = []
            for leg in nav.legs[self._currentLegIndex:]:
                if leg.to_stop:
                    remainingWaypoints.append({
                        'longitude': leg.to_stop.longitude,
                        'latitude': leg.to_stop.latitude
                    })
            
            return {
                'progress': RouteProgress(
                    currentLegIndex=self._currentLegIndex,
                    distanceToNextStop=distanceToNextStop,
                    fractionTraveled=fractionTraveled,
                    isLastLeg=self._currentLegIndex >= len(nav.legs) - 1,
                    currentLeg=nav.legs[self._currentLegIndex] if self._currentLegIndex < len(nav.legs) else None,
                    remainingLegs=len(nav.legs) - self._currentLegIndex - 1
                ),
                'arrival': ArrivalEvent(
                    arrived=True,
                    completedStop=completedStop,
                    newLegIndex=self._currentLegIndex,
                    allComplete=False,
                    remainingWaypoints=remainingWaypoints
                )
            }
        
        return {'progress': progress, 'arrival': None}
    
    def buildRouteResetQuery(self, gpsLocation: dict, remainingWaypoints: List[dict]) -> str:
        """Build semicolon-delimited coordinate string for directions API"""
        points = [f"{gpsLocation['longitude']},{gpsLocation['latitude']}"]
        for wp in remainingWaypoints:
            points.append(f"{wp['longitude']},{wp['latitude']}")
        return ';'.join(points)
    
    def buildUpdatedStopsGeoJSON(self) -> dict:
        """Build GeoJSON FeatureCollection for stops layer"""
        nav = self._navigationData
        if not nav:
            return {'type': 'FeatureCollection', 'features': []}
        
        features = []
        for index, stop in enumerate(nav.stops):
            features.append({
                'type': 'Feature',
                'geometry': {
                    'type': 'Point',
                    'coordinates': [stop.longitude, stop.latitude]
                },
                'properties': {
                    'label': str(index + 1),
                    'name': stop.name or stop.address,
                    'completed': 1 if stop.completed else 0,
                    'isCurrent': 1 if index == self._currentLegIndex else 0
                }
            })
        
        return {'type': 'FeatureCollection', 'features': features}


# ============================================
# Test Fixtures
# ============================================

@pytest.fixture
def sample_stops():
    """Create sample stops for testing"""
    return [
        Stop(id="stop-1", name="Stop 1", address="Address 1", latitude=-26.711798, longitude=153.13193),
        Stop(id="stop-2", name="Stop 2", address="Address 2", latitude=-26.712479, longitude=153.131924),
        Stop(id="stop-3", name="Stop 3", address="Address 3", latitude=-26.717236, longitude=153.130144),
    ]


@pytest.fixture
def sample_navigation_data(sample_stops):
    """Create sample navigation data"""
    legs = [
        NavigationLeg(to_stop=sample_stops[0], distance=100, duration=60),
        NavigationLeg(to_stop=sample_stops[1], distance=150, duration=90),
        NavigationLeg(to_stop=sample_stops[2], distance=200, duration=120),
    ]
    return NavigationData(stops=sample_stops, legs=legs)


@pytest.fixture
def observer():
    """Create observer with default config"""
    return RouteProgressObserver({'arrivalRadiusMeters': 50, 'arrivalCooldownMs': 3000})


@pytest.fixture
def api_client():
    """Shared requests session"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


# ============================================
# Test Cases: RouteProgressObserver Class
# ============================================

class TestRouteProgressObserverInstantiation:
    """Tests for RouteProgressObserver class instantiation"""
    
    def test_instantiation_with_default_config(self):
        """Verify new RouteProgressObserver() with default config works"""
        observer = RouteProgressObserver()
        assert observer.config.arrivalRadiusMeters == 50
        assert observer.config.arrivalCooldownMs == 3000
        assert observer.currentLegIndex == 0
        print("PASS: RouteProgressObserver instantiation with default config")
    
    def test_instantiation_with_custom_config(self):
        """Verify new RouteProgressObserver({ arrivalRadiusMeters: 50 }) works"""
        observer = RouteProgressObserver({'arrivalRadiusMeters': 50})
        assert observer.config.arrivalRadiusMeters == 50
        print("PASS: RouteProgressObserver instantiation with custom arrivalRadiusMeters=50")
    
    def test_instantiation_with_full_config(self):
        """Verify RouteProgressObserver with full config"""
        config = {
            'arrivalRadiusMeters': 100,
            'arrivalCooldownMs': 5000,
            'backendUrl': BASE_URL,
            'mapboxToken': 'test-token'
        }
        observer = RouteProgressObserver(config)
        assert observer.config.arrivalRadiusMeters == 100
        assert observer.config.arrivalCooldownMs == 5000
        assert observer.config.backendUrl == BASE_URL
        print("PASS: RouteProgressObserver instantiation with full config")


class TestRouteProgressObserverMethods:
    """Tests for RouteProgressObserver methods"""
    
    def test_set_navigation_data(self, observer, sample_navigation_data):
        """Verify setNavigationData() correctly stores navigation data"""
        observer.setNavigationData(sample_navigation_data)
        assert observer._navigationData == sample_navigation_data
        assert len(observer._navigationData.stops) == 3
        assert len(observer._navigationData.legs) == 3
        print("PASS: setNavigationData() correctly stores navigation data")
    
    def test_reset_to_first_leg(self, observer):
        """Verify resetToFirstLeg() resets leg index to 0"""
        observer._currentLegIndex = 5
        observer._lastArrivalTime = 12345
        observer.resetToFirstLeg()
        assert observer.currentLegIndex == 0
        assert observer._lastArrivalTime == 0
        print("PASS: resetToFirstLeg() resets leg index to 0")
    
    def test_set_leg_index(self, observer):
        """Verify setLegIndex() sets the leg index correctly"""
        observer.setLegIndex(2)
        assert observer.currentLegIndex == 2
        observer.setLegIndex(0)
        assert observer.currentLegIndex == 0
        print("PASS: setLegIndex() sets the leg index correctly")


class TestOnRouteProgressChanged:
    """Tests for onRouteProgressChanged() method"""
    
    def test_progress_with_no_navigation_data(self, observer):
        """Verify progress returns default values when no nav data"""
        gps = {'latitude': -26.711798, 'longitude': 153.13193}
        result = observer.onRouteProgressChanged(gps)
        
        assert result['arrival'] is None
        assert result['progress'].currentLegIndex == 0
        assert result['progress'].distanceToNextStop == float('inf')
        assert result['progress'].isLastLeg == True
        print("PASS: onRouteProgressChanged() returns defaults when no nav data")
    
    def test_progress_returns_correct_data(self, observer, sample_navigation_data):
        """Verify onRouteProgressChanged() returns progress + arrival data correctly"""
        observer.setNavigationData(sample_navigation_data)
        
        # GPS location far from first stop
        gps = {'latitude': -26.700000, 'longitude': 153.140000}
        result = observer.onRouteProgressChanged(gps)
        
        assert 'progress' in result
        assert 'arrival' in result
        assert result['progress'].currentLegIndex == 0
        assert result['progress'].distanceToNextStop > 0
        assert result['progress'].isLastLeg == False
        assert result['progress'].remainingLegs == 2
        print("PASS: onRouteProgressChanged() returns progress + arrival data correctly")
    
    def test_arrival_detection_within_radius(self, observer, sample_navigation_data):
        """Verify arrival detection when GPS is within 50m of stop"""
        observer.setNavigationData(sample_navigation_data)
        observer._lastArrivalTime = 0  # Reset cooldown
        
        # GPS location AT first stop (within 50m)
        first_stop = sample_navigation_data.stops[0]
        gps = {'latitude': first_stop.latitude, 'longitude': first_stop.longitude}
        
        result = observer.onRouteProgressChanged(gps)
        
        assert result['arrival'] is not None
        assert result['arrival'].arrived == True
        assert result['arrival'].completedStop.id == "stop-1"
        assert result['arrival'].newLegIndex == 1  # Advanced to next leg
        print("PASS: Arrival detection when GPS is within 50m of stop returns arrived=true")
    
    def test_arrival_cooldown_prevents_duplicate(self, observer, sample_navigation_data):
        """Verify arrival cooldown does not trigger twice within 3s window"""
        observer.setNavigationData(sample_navigation_data)
        
        first_stop = sample_navigation_data.stops[0]
        gps = {'latitude': first_stop.latitude, 'longitude': first_stop.longitude}
        
        # First arrival
        result1 = observer.onRouteProgressChanged(gps)
        assert result1['arrival'] is not None
        assert result1['arrival'].arrived == True
        
        # Immediately check again (within cooldown)
        result2 = observer.onRouteProgressChanged(gps)
        assert result2['arrival'] is None  # No arrival due to cooldown
        print("PASS: Arrival cooldown does not trigger twice within 3s window")
    
    def test_all_complete_on_last_leg(self, observer, sample_navigation_data):
        """Verify allComplete=true when reaching last stop"""
        observer.setNavigationData(sample_navigation_data)
        observer.setLegIndex(2)  # Set to last leg
        observer._lastArrivalTime = 0  # Reset cooldown
        
        last_stop = sample_navigation_data.stops[2]
        gps = {'latitude': last_stop.latitude, 'longitude': last_stop.longitude}
        
        result = observer.onRouteProgressChanged(gps)
        
        assert result['arrival'] is not None
        assert result['arrival'].arrived == True
        assert result['arrival'].allComplete == True
        assert result['arrival'].remainingWaypoints == []
        print("PASS: allComplete=true when reaching last stop")


class TestBuildRouteResetQuery:
    """Tests for buildRouteResetQuery() method"""
    
    def test_build_route_reset_query_format(self, observer):
        """Verify buildRouteResetQuery() builds semicolon-delimited coordinate string"""
        gps = {'latitude': -26.711798, 'longitude': 153.13193}
        waypoints = [
            {'latitude': -26.712479, 'longitude': 153.131924},
            {'latitude': -26.717236, 'longitude': 153.130144}
        ]
        
        query = observer.buildRouteResetQuery(gps, waypoints)
        
        # Verify format: lng,lat;lng,lat;lng,lat
        assert ';' in query
        parts = query.split(';')
        assert len(parts) == 3  # GPS + 2 waypoints
        
        # Verify first point is GPS
        first_point = parts[0].split(',')
        assert float(first_point[0]) == gps['longitude']
        assert float(first_point[1]) == gps['latitude']
        
        print("PASS: buildRouteResetQuery() builds semicolon-delimited coordinate string")
    
    def test_build_route_reset_query_with_empty_waypoints(self, observer):
        """Verify buildRouteResetQuery() works with empty waypoints"""
        gps = {'latitude': -26.711798, 'longitude': 153.13193}
        
        query = observer.buildRouteResetQuery(gps, [])
        
        assert ';' not in query
        parts = query.split(',')
        assert float(parts[0]) == gps['longitude']
        assert float(parts[1]) == gps['latitude']
        print("PASS: buildRouteResetQuery() works with empty waypoints")


class TestBuildUpdatedStopsGeoJSON:
    """Tests for buildUpdatedStopsGeoJSON() method"""
    
    def test_geojson_feature_collection_structure(self, observer, sample_navigation_data):
        """Verify buildUpdatedStopsGeoJSON() returns FeatureCollection with correct properties"""
        observer.setNavigationData(sample_navigation_data)
        
        geojson = observer.buildUpdatedStopsGeoJSON()
        
        # Verify FeatureCollection structure
        assert geojson['type'] == 'FeatureCollection'
        assert 'features' in geojson
        assert len(geojson['features']) == 3
        print("PASS: buildUpdatedStopsGeoJSON() returns FeatureCollection")
    
    def test_geojson_feature_properties(self, observer, sample_navigation_data):
        """Verify GeoJSON features have correct completed/isCurrent properties"""
        observer.setNavigationData(sample_navigation_data)
        observer.setLegIndex(1)  # Second stop is current
        
        # Mark first stop as completed
        sample_navigation_data.stops[0].completed = True
        
        geojson = observer.buildUpdatedStopsGeoJSON()
        features = geojson['features']
        
        # First feature should be completed
        assert features[0]['properties']['completed'] == 1
        assert features[0]['properties']['isCurrent'] == 0
        
        # Second feature should be current
        assert features[1]['properties']['completed'] == 0
        assert features[1]['properties']['isCurrent'] == 1
        
        # Third feature should be neither
        assert features[2]['properties']['completed'] == 0
        assert features[2]['properties']['isCurrent'] == 0
        
        print("PASS: GeoJSON features have correct completed/isCurrent properties")
    
    def test_geojson_coordinates_format(self, observer, sample_navigation_data):
        """Verify GeoJSON coordinates are in [longitude, latitude] format"""
        observer.setNavigationData(sample_navigation_data)
        
        geojson = observer.buildUpdatedStopsGeoJSON()
        first_feature = geojson['features'][0]
        
        assert first_feature['geometry']['type'] == 'Point'
        coords = first_feature['geometry']['coordinates']
        
        # GeoJSON uses [longitude, latitude] format
        assert coords[0] == sample_navigation_data.stops[0].longitude
        assert coords[1] == sample_navigation_data.stops[0].latitude
        
        print("PASS: GeoJSON coordinates are in [longitude, latitude] format")
    
    def test_geojson_with_no_data(self, observer):
        """Verify buildUpdatedStopsGeoJSON() returns empty collection with no data"""
        geojson = observer.buildUpdatedStopsGeoJSON()
        
        assert geojson['type'] == 'FeatureCollection'
        assert geojson['features'] == []
        print("PASS: buildUpdatedStopsGeoJSON() returns empty collection with no data")


# ============================================
# Test Cases: Backend API Endpoints
# ============================================

class TestBackendAPIs:
    """Tests for backend API endpoints used by RouteProgressObserver"""
    
    def test_api_health(self, api_client):
        """Verify GET /api/ returns healthy status"""
        response = api_client.get(f"{BASE_URL}/api/")
        assert response.status_code == 200
        data = response.json()
        assert data.get('status') == 'healthy'
        print("PASS: GET /api/ returns healthy status")
    
    def test_api_stops(self, api_client):
        """Verify GET /api/stops returns stops array"""
        response = api_client.get(f"{BASE_URL}/api/stops")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"PASS: GET /api/stops returns array with {len(data)} stops")
    
    def test_api_mapbox_token(self, api_client):
        """Verify GET /api/mapbox-token returns valid token"""
        response = api_client.get(f"{BASE_URL}/api/mapbox-token")
        assert response.status_code == 200
        data = response.json()
        assert 'token' in data
        assert len(data['token']) > 0
        print("PASS: GET /api/mapbox-token returns valid token")
    
    def test_api_directions(self, api_client):
        """Verify GET /api/directions returns route geometry (used by fetchResetRoute)"""
        # Use sample coordinates for directions test
        coords = "153.13193,-26.711798;153.131924,-26.712479"
        response = api_client.get(f"{BASE_URL}/api/directions?coordinates={coords}")
        assert response.status_code == 200
        data = response.json()
        assert 'geometry' in data or 'distance' in data
        print("PASS: GET /api/directions returns route data")


# ============================================
# Test Cases: Calculate Distance Function
# ============================================

class TestCalculateDistance:
    """Tests for calculateDistance utility function"""
    
    def test_calculate_distance_same_point(self):
        """Verify distance is 0 for same point"""
        dist = calculate_distance(-26.711798, 153.13193, -26.711798, 153.13193)
        assert dist < 1  # Should be effectively 0
        print("PASS: calculateDistance returns 0 for same point")
    
    def test_calculate_distance_known_points(self):
        """Verify distance calculation for known points"""
        # Two points approximately 77 meters apart
        dist = calculate_distance(-26.711798, 153.13193, -26.712479, 153.131924)
        assert 70 < dist < 90  # Should be ~77 meters
        print(f"PASS: calculateDistance returns {dist:.1f}m for known points")
    
    def test_calculate_distance_within_arrival_radius(self):
        """Verify distance calculation for arrival detection"""
        # Point within 50m should trigger arrival
        base_lat = -26.711798
        base_lng = 153.13193
        
        # Move ~30 meters north
        nearby_lat = base_lat + 0.0003
        nearby_lng = base_lng
        
        dist = calculate_distance(base_lat, base_lng, nearby_lat, nearby_lng)
        assert dist < 50  # Should be within arrival radius
        print(f"PASS: Distance {dist:.1f}m is within 50m arrival radius")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
