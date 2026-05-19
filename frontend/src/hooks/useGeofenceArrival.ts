/**
 * useGeofenceArrival
 *
 * Spatial trigger that fires onArrival(stopId) exactly once when the
 * driver's position enters a configurable radius of the active stop.
 *
 * Design decisions:
 *   - Pure haversine calculation on the JS thread (no external lib needed
 *     for a single distance check, avoids Turf import overhead here).
 *   - Debounce is structural: a Set<string> prevents any stopId from firing
 *     more than once per navigation session regardless of GPS jitter.
 *   - The callback ref pattern keeps onArrival stable without needing it
 *     as an effect dependency.
 *   - resetStop / resetAll are returned so the parent can allow a stop to
 *     re-trigger after an uncomplete action.
 */

import { useEffect, useRef, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GeofenceStop {
  id: string;
  latitude: number;
  longitude: number;
}

export interface DriverPosition {
  latitude: number;
  longitude: number;
}

interface UseGeofenceArrivalOptions {
  /** The stop the driver is currently navigating toward. */
  activeStop: GeofenceStop | null;
  /** Latest driver GPS position (updated by the main navigation subscription). */
  driverPosition: DriverPosition | null;
  /** Only check while navigation is active. */
  enabled: boolean;
  /** Trigger radius in metres. Default: 50 m (Google Maps standard). */
  radiusMeters?: number;
  /** Called once per stopId when entering the radius. */
  onArrival: (stopId: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Haversine great-circle distance in metres. */
function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R  = 6_371_000; // Earth radius in metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a  =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useGeofenceArrival({
  activeStop,
  driverPosition,
  enabled,
  radiusMeters = 50,
  onArrival,
}: UseGeofenceArrivalOptions): {
  resetStop: (stopId: string) => void;
  resetAll:  () => void;
} {
  // Stops that have already triggered — guards against GPS jitter re-fires
  const firedRef = useRef<Set<string>>(new Set());

  // Stable callback reference — avoids listing onArrival as effect dep
  const onArrivalRef = useRef(onArrival);
  useEffect(() => { onArrivalRef.current = onArrival; }, [onArrival]);

  useEffect(() => {
    if (!enabled || !activeStop || !driverPosition) return;

    // Already triggered for this stop — bail out immediately
    if (firedRef.current.has(activeStop.id)) return;

    const dist = haversineMeters(
      driverPosition.latitude,
      driverPosition.longitude,
      activeStop.latitude,
      activeStop.longitude,
    );

    if (dist <= radiusMeters) {
      firedRef.current.add(activeStop.id);
      // Defer to next microtask so calling code runs after the effect flush
      Promise.resolve().then(() => onArrivalRef.current(activeStop.id));
    }
  }, [driverPosition, activeStop, enabled, radiusMeters]);

  // ── Control API returned to caller ──────────────────────────────────────
  const resetStop = useCallback((stopId: string) => {
    firedRef.current.delete(stopId);
  }, []);

  const resetAll = useCallback(() => {
    firedRef.current.clear();
  }, []);

  return { resetStop, resetAll };
}
