/**
 * useNavigationCamera
 *
 * High-frequency GPS + compass hook dedicated solely to camera control.
 * Runs at 250ms independent of the main 800ms navigation GPS subscription
 * so the map bearing / zoom transitions stay buttery-smooth without
 * triggering expensive React re-renders for every GPS tick.
 *
 * Architecture:
 *   GPS (250ms) ──► bearing ref ──► drivingCamera msg ──► WebView easeTo
 *   compass     ──┘                (raw lng/lat, no pre-offset)
 *
 * The look-ahead offset is computed inside the WebView using map.project /
 * map.unproject so it adapts correctly to the current zoom and pitch.
 */

import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';

interface NavigationCameraOptions {
  /** Activate / deactivate the hook without unmounting. */
  enabled: boolean;
  /** Wait until the WebView map is ready before subscribing. */
  mapReady: boolean;
  /**
   * Optional side-channel: notify parent of speed changes without
   * causing a re-render loop. Parent should store value in a ref.
   */
  onSpeedUpdate?: (speedKmh: number) => void;
}

/**
 * @param sendMessage  Stable callback (from useCallback / ref) that serialises
 *                     a message and calls webViewRef.injectJavaScript.
 */
export function useNavigationCamera(
  sendMessage: (msg: object) => void,
  options: NavigationCameraOptions,
): void {
  const headingRef  = useRef(0);
  const posSubRef   = useRef<Location.LocationSubscription | null>(null);
  const headSubRef  = useRef<Location.LocationSubscription | null>(null);
  const lastFireRef = useRef(0);
  // Have we ever seen a valid GPS course? Once we have, we stop trusting the
  // magnetometer entirely — in-vehicle metal & electrical interference make it
  // useless, and it was rotating the puck while the driver was stopped.
  const hasGpsCourseRef = useRef(false);

  // Speed threshold below which we FREEZE the bearing. Google Maps uses ~2 km/h
  // (~0.56 m/s); we use 1.4 m/s (~5 km/h) so brief coasting doesn't jitter.
  const MOVING_SPEED_MPS = 1.4;

  // Keep a stable reference so the async callbacks don't close over stale fns
  const sendRef  = useRef(sendMessage);
  const optsRef  = useRef(options);
  useEffect(() => { sendRef.current = sendMessage; }, [sendMessage]);
  useEffect(() => { optsRef.current = options; },    [options]);

  useEffect(() => {
    console.log('[NAV_CAM] Hook effect running. enabled:', options.enabled, 'mapReady:', options.mapReady);
    
    if (!options.enabled || !options.mapReady) {
      // Tear down any active subscriptions when disabled
      posSubRef.current?.remove();
      headSubRef.current?.remove();
      posSubRef.current  = null;
      headSubRef.current = null;
      hasGpsCourseRef.current = false;
      console.log('[NAV_CAM] Hook disabled or map not ready - subscriptions cleared');
      return;
    }

    let alive = true;
    console.log('[NAV_CAM] Starting GPS subscriptions...');

    (async () => {
      // ── 1. Compass heading (fallback ONLY — used until the first valid GPS
      //       course arrives, so the puck points roughly correctly before the
      //       vehicle starts moving). Once GPS gives us a real course, we stop
      //       accepting magnetometer updates.
      headSubRef.current = await Location.watchHeadingAsync((h) => {
        if (!alive) return;
        if (hasGpsCourseRef.current) return;  // GPS is authoritative once moving
        headingRef.current = h.trueHeading ?? h.magHeading ?? 0;
      });
      console.log('[NAV_CAM] Compass subscription started');

      // ── 2. High-frequency position for camera smoothness ───────────────
      posSubRef.current = await Location.watchPositionAsync(
        {
          accuracy:         Location.Accuracy.BestForNavigation,
          timeInterval:     250,
          distanceInterval: 1,    // fire even on very small moves
        },
        (location) => {
          if (!alive) return;

          // Throttle to ~4 fps — easeTo is 400ms so sending faster wastes effort
          const now = Date.now();
          if (now - lastFireRef.current < 220) return;
          lastFireRef.current = now;

          const { latitude, longitude, speed, heading: gpsHeading } = location.coords;
          const speedMps = Math.max(0, speed ?? 0);

          optsRef.current.onSpeedUpdate?.(Math.round(speedMps * 3.6));

          // ── Bearing selection (Google-Maps-style) ──
          // While moving: trust GPS course-over-ground (robust, never drifts).
          // While stopped: FREEZE bearing at its last moving value — do NOT let
          // the magnetometer keep rotating the puck / camera.
          if (speedMps >= MOVING_SPEED_MPS && typeof gpsHeading === 'number' && gpsHeading >= 0) {
            headingRef.current = gpsHeading;
            hasGpsCourseRef.current = true;
          }
          // else: headingRef stays at its last good value (frozen)

          // Send raw GPS — the WebView computes pixel-space look-ahead offset
          console.log('[NAV_CAM] Sending drivingCamera:', { lng: longitude.toFixed(5), lat: latitude.toFixed(5), bearing: headingRef.current.toFixed(1) });
          sendRef.current({
            type:     'drivingCamera',
            lng:      longitude,
            lat:      latitude,
            bearing:  headingRef.current,
            speedMps,
          });
        },
      );
    })();

    return () => {
      alive = false;
      posSubRef.current?.remove();
      headSubRef.current?.remove();
      posSubRef.current  = null;
      headSubRef.current = null;
      hasGpsCourseRef.current = false;
    };
  // Only re-run when enabled/mapReady flip — not on every render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, options.mapReady]);
}
