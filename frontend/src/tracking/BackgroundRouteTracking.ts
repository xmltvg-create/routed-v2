/**
 * src/tracking/BackgroundRouteTracking.ts
 *
 * High-accuracy foreground-service location tracking for active delivery
 * shifts on Android. Uses expo-task-manager + expo-location to maintain a
 * persistent, non-dismissible notification while the courier is driving.
 *
 * Google Play FOREGROUND_SERVICE_LOCATION compliance:
 *   - Foreground service starts ONLY when the driver explicitly begins
 *     navigation (not on app launch).
 *   - The notification clearly states "RouTeD is actively optimizing your
 *     navigation" — no generic/placeholder text.
 *   - Service is torn down when the driver ends their shift or exits
 *     navigation mode.
 *   - Background location permission is requested with a clear rationale.
 *
 * Usage from index.tsx:
 *   import { startRouteTracking, stopRouteTracking, isRouteTracking } from '../src/tracking/BackgroundRouteTracking';
 *
 *   // When entering driving mode:
 *   await startRouteTracking(onLocationUpdate);
 *
 *   // When exiting driving mode:
 *   await stopRouteTracking();
 */

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

// ── Constants ────────────────────────────────────────────────────────
const TASK_NAME = 'BACKGROUND_ROUTE_TRACKING';
const BRAND_COLOR = '#FF5A00'; // RouTeD accent orange

// Module-level callback — updated by startRouteTracking, read by the
// task definition. Must live at module scope because TaskManager runs
// the task handler outside of React's component tree.
let _onLocationUpdate: ((coords: Location.LocationObject) => void) | null = null;

// ── Task definition (MUST be at global scope) ────────────────────────
// This is called by the OS even when the app is backgrounded. It must
// be defined at import time, not inside a component or hook.
TaskManager.defineTask(TASK_NAME, ({ data, error }: TaskManager.TaskManagerTaskBody<{ locations: Location.LocationObject[] }>) => {
  if (error) {
    console.error(`[${TASK_NAME}] Task error:`, error.message);
    return;
  }
  if (data?.locations && _onLocationUpdate) {
    // TaskManager delivers locations in batches; we forward the most
    // recent one to the callback (the driving UI only needs the latest).
    const latest = data.locations[data.locations.length - 1];
    if (latest) {
      _onLocationUpdate(latest);
    }
  }
});

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start high-accuracy foreground-service location tracking.
 *
 * Call this when the driver enters navigation/driving mode. Requests
 * foreground + background location permissions, then starts the
 * persistent Android foreground service with a non-dismissible
 * notification.
 *
 * @param onUpdate — callback receiving each LocationObject. Called from
 *   the TaskManager handler (outside React), so the callback should
 *   update a ref or Zustand store, not call setState directly.
 * @returns true if tracking started successfully, false otherwise.
 */
export async function startRouteTracking(
  onUpdate: (location: Location.LocationObject) => void,
): Promise<boolean> {
  // Web / unsupported platforms: no-op
  if (Platform.OS === 'web') return false;

  try {
    // 1. Request foreground permission
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      console.warn('[tracking] Foreground location permission denied');
      return false;
    }

    // 2. Request background permission (required for foreground service on Android 10+)
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus !== 'granted') {
      console.warn('[tracking] Background location permission denied — foreground service will not persist');
      // Continue anyway: foreground-only tracking still works, just stops when backgrounded.
    }

    // 3. Stop any existing tracking (idempotent)
    const alreadyRunning = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (alreadyRunning) {
      await Location.stopLocationUpdatesAsync(TASK_NAME);
    }

    // 4. Set the callback
    _onLocationUpdate = onUpdate;

    // 5. Start location updates with foreground service
    await Location.startLocationUpdatesAsync(TASK_NAME, {
      accuracy: Location.Accuracy.BestForNavigation,
      distanceInterval: 5,        // meters between updates (5m for turn-by-turn)
      timeInterval: 2000,         // minimum ms between updates
      showsBackgroundLocationIndicator: true, // iOS blue bar
      deferredUpdatesInterval: 0, // no batching — real-time
      deferredUpdatesDistance: 0,
      foregroundService: {
        notificationTitle: 'Active Delivery Route',
        notificationBody: 'RouTeD is actively optimizing your navigation in the background.',
        notificationColor: BRAND_COLOR,
        killServiceOnDestroy: false, // Keep alive even if app process is killed
      },
      // Android: use PRIORITY_HIGH_ACCURACY for GPS (not network/cell)
      activityType: Location.ActivityType.AutomotiveNavigation,
      pausesUpdatesAutomatically: false,
    });

    console.log('[tracking] Foreground service started');
    return true;
  } catch (err) {
    console.error('[tracking] Failed to start:', err);
    return false;
  }
}

/**
 * Stop location tracking and tear down the foreground service.
 *
 * Call this when the driver exits navigation mode or ends their shift.
 * Removes the persistent notification from the Android shade.
 */
export async function stopRouteTracking(): Promise<void> {
  if (Platform.OS === 'web') return;

  try {
    const isRunning = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (isRunning) {
      await Location.stopLocationUpdatesAsync(TASK_NAME);
      console.log('[tracking] Foreground service stopped');
    }
  } catch (err) {
    console.error('[tracking] Failed to stop:', err);
  } finally {
    _onLocationUpdate = null;
  }
}

/**
 * Check if route tracking is currently active.
 */
export async function isRouteTracking(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    return await TaskManager.isTaskRegisteredAsync(TASK_NAME);
  } catch {
    return false;
  }
}

/**
 * Get the task name (for external checks/debugging).
 */
export const ROUTE_TRACKING_TASK = TASK_NAME;
