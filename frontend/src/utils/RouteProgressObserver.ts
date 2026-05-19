/**
 * RouteProgressObserver — Waypoint-by-waypoint navigation reset manager.
 *
 * Mirrors the Mapbox Android Navigation SDK v3 pattern:
 *   1. RouteProgressObserver  → monitors GPS distance to the current leg's destination
 *   2. mapboxNavigation.setRoutes()  → rebuilds the route from current GPS through remaining waypoints
 *   3. NavigationCamera.requestFollowing()  → recenters the WebView camera on the new start
 *   4. ArrivalController  → removes the reached waypoint so the next leg becomes primary
 *
 * Usage in the GPS callback:
 *   const result = observer.onRouteProgressChanged(gpsLocation);
 *   if (result.arrived) { /* handle UI feedback * / }
 */

import { NavigationData, NavigationLeg, LiveRoute } from '../types/route';
import { Stop } from '../store/stopsStore';
import { calculateDistance } from './route';

// --- Types ---

export interface RouteProgress {
  currentLegIndex: number;
  distanceToNextStop: number;      // meters
  fractionTraveled: number;        // 0..1 within current leg
  isLastLeg: boolean;
  currentLeg: NavigationLeg | null;
  remainingLegs: number;
}

export interface ArrivalEvent {
  arrived: boolean;
  completedStop: Stop | null;
  newLegIndex: number;
  allComplete: boolean;
  remainingWaypoints: Array<{ longitude: number; latitude: number }>;
}

export interface RouteResetPayload {
  /** Fresh route geometry from current GPS → remaining stops */
  geometry: any;
  /** Updated live route to the next immediate stop */
  liveRoute: LiveRoute | null;
  /** Coordinates string for the directions API call */
  coordinatesQuery: string;
  /** The new current leg after reset */
  newCurrentLeg: NavigationLeg | null;
}

interface ObserverConfig {
  /** Distance (meters) at which a waypoint is considered "reached" */
  arrivalRadiusMeters: number;
  /** Cooldown (ms) after an arrival before detecting the next one */
  arrivalCooldownMs: number;
  /** Backend URL for fetching fresh route directions */
  backendUrl: string;
  /** Mapbox token (for API calls if needed) */
  mapboxToken: string;
}

const DEFAULT_CONFIG: ObserverConfig = {
  arrivalRadiusMeters: 50,
  arrivalCooldownMs: 3000,
  backendUrl: '',
  mapboxToken: '',
};

// --- Observer Class ---

export class RouteProgressObserver {
  private config: ObserverConfig;
  private lastArrivalTime: number = 0;
  private _currentLegIndex: number = 0;
  private navigationData: NavigationData | null = null;

  constructor(config: Partial<ObserverConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Attach fresh navigation data (called at navigation start or after a reroute) */
  setNavigationData(data: NavigationData | null) {
    this.navigationData = data;
  }

  /** Reset to first leg (called at navigation start) */
  resetToFirstLeg() {
    this._currentLegIndex = 0;
    this.lastArrivalTime = 0;
  }

  /** Get the current leg index */
  get currentLegIndex() {
    return this._currentLegIndex;
  }

  /** Manually advance to a specific leg (for undo, skip, etc.) */
  setLegIndex(index: number) {
    this._currentLegIndex = index;
  }

  // ── Core: equivalent of RouteProgressObserver.onRouteProgressChanged() ──

  /**
   * Called on every GPS update. Returns a snapshot of progress and, if a
   * waypoint was just reached, the ArrivalEvent with remaining-waypoint data
   * so the caller can call setRoutes() and reset the camera.
   */
  onRouteProgressChanged(
    gpsLocation: { latitude: number; longitude: number; heading?: number }
  ): { progress: RouteProgress; arrival: ArrivalEvent | null } {
    const nav = this.navigationData;
    if (!nav || nav.legs.length === 0) {
      return {
        progress: {
          currentLegIndex: this._currentLegIndex,
          distanceToNextStop: Infinity,
          fractionTraveled: 0,
          isLastLeg: true,
          currentLeg: null,
          remainingLegs: 0,
        },
        arrival: null,
      };
    }

    const currentLeg = nav.legs[this._currentLegIndex] ?? null;
    const isLastLeg = this._currentLegIndex >= nav.legs.length - 1;

    // Distance to current leg's destination
    let distanceToNextStop = Infinity;
    if (currentLeg?.to_stop) {
      distanceToNextStop = calculateDistance(
        gpsLocation.latitude,
        gpsLocation.longitude,
        currentLeg.to_stop.latitude,
        currentLeg.to_stop.longitude
      );
    }

    // Fraction traveled (rough approximation based on distance)
    const totalLegDist = currentLeg?.distance || 1;
    const traveled = Math.max(0, totalLegDist - distanceToNextStop);
    const fractionTraveled = Math.min(1, traveled / totalLegDist);

    const progress: RouteProgress = {
      currentLegIndex: this._currentLegIndex,
      distanceToNextStop,
      fractionTraveled,
      isLastLeg,
      currentLeg,
      remainingLegs: nav.legs.length - this._currentLegIndex - 1,
    };

    // ── Arrival detection (equivalent of ArrivalController.navigateNextRouteLeg) ──
    const now = Date.now();
    const cooldownElapsed = now - this.lastArrivalTime > this.config.arrivalCooldownMs;

    if (
      distanceToNextStop <= this.config.arrivalRadiusMeters &&
      cooldownElapsed &&
      currentLeg?.to_stop
    ) {
      this.lastArrivalTime = now;
      const completedStop = currentLeg.to_stop;

      if (isLastLeg) {
        // All stops done
        return {
          progress,
          arrival: {
            arrived: true,
            completedStop,
            newLegIndex: this._currentLegIndex,
            allComplete: true,
            remainingWaypoints: [],
          },
        };
      }

      // Advance to the next leg
      this._currentLegIndex += 1;

      // Build remaining waypoints (from the NEW current leg onward)
      const remainingWaypoints = nav.legs
        .slice(this._currentLegIndex)
        .filter((leg) => leg.to_stop)
        .map((leg) => ({
          longitude: leg.to_stop!.longitude,
          latitude: leg.to_stop!.latitude,
        }));

      return {
        progress: {
          ...progress,
          currentLegIndex: this._currentLegIndex,
          remainingLegs: nav.legs.length - this._currentLegIndex - 1,
        },
        arrival: {
          arrived: true,
          completedStop,
          newLegIndex: this._currentLegIndex,
          allComplete: false,
          remainingWaypoints,
        },
      };
    }

    return { progress, arrival: null };
  }

  // ── Route rebuild: equivalent of mapboxNavigation.setRoutes() ──

  /**
   * Builds the coordinates query string for fetching fresh directions
   * from the current GPS position through ALL remaining stops.
   *
   * The caller should fetch `${backendUrl}/api/directions?coordinates=${query}`
   * and then pass the result to the navigation map's resetNavigationForNextLeg().
   */
  buildRouteResetQuery(
    gpsLocation: { latitude: number; longitude: number },
    remainingWaypoints: Array<{ longitude: number; latitude: number }>
  ): string {
    const points = [
      `${gpsLocation.longitude},${gpsLocation.latitude}`,
      ...remainingWaypoints.map((wp) => `${wp.longitude},${wp.latitude}`),
    ];
    return points.join(';');
  }

  /**
   * Convenience: fetch a fresh route and return the payload to hand to the map.
   */
  async fetchResetRoute(
    gpsLocation: { latitude: number; longitude: number },
    remainingWaypoints: Array<{ longitude: number; latitude: number }>
  ): Promise<RouteResetPayload | null> {
    if (remainingWaypoints.length === 0) return null;

    const coordinatesQuery = this.buildRouteResetQuery(gpsLocation, remainingWaypoints);

    try {
      const response = await fetch(
        `${this.config.backendUrl}/api/directions?coordinates=${coordinatesQuery}`
      );
      if (!response.ok) return null;

      const data = await response.json();
      const nav = this.navigationData;
      const newCurrentLeg = nav?.legs[this._currentLegIndex] ?? null;

      return {
        geometry: data.geometry,
        liveRoute: data as LiveRoute,
        coordinatesQuery,
        newCurrentLeg,
      };
    } catch {
      return null;
    }
  }

  // ── Helpers for building map update payloads ──

  /**
   * Build the GeoJSON FeatureCollection for the stops layer, with the
   * reached waypoint removed (or marked completed) and the next one as current.
   */
  buildUpdatedStopsGeoJSON(): object {
    const nav = this.navigationData;
    if (!nav) {
      return { type: 'FeatureCollection', features: [] };
    }

    return {
      type: 'FeatureCollection',
      features: nav.stops.map((stop, index) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [stop.longitude, stop.latitude],
        },
        properties: {
          // Sharpie-marker badge — prefer the locked `original_sequence`
          // (1-based, immutable post first /routes/confirm) so map markers
          // keep matching the number drivers wrote on the boxes, even if
          // a mid-route re-optimise reshuffles `nav.stops`. Falls back to
          // (index + 1) only for pre-confirm rows.
          label: (
            (typeof (stop as { original_sequence?: number | null }).original_sequence === 'number'
              ? (stop as { original_sequence: number }).original_sequence
              : index + 1)
          ).toString(),
          name: stop.name || stop.address,
          completed: stop.completed ? 1 : 0,
          isCurrent: index === this._currentLegIndex ? 1 : 0,
        },
      })),
    };
  }
}

export default RouteProgressObserver;
