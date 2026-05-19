import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Breadcrumb } from './decimateBreadcrumb';

/**
 * Persist the live-tracking breadcrumb across app cold-starts so a driver
 * who force-quits the app mid-shift (battery, OS reaper, system update)
 * lands back in the cockpit with their drive history intact instead of
 * staring at a blank trail.
 *
 * Why per-user keying? Same physical device may be shared (e.g. shift
 * handover at a depot, a tablet living in the van that different drivers
 * sign into). Stamping the storage key with `user_id` keeps each
 * driver's trail isolated — so when the next driver signs in they don't
 * see yesterday's path.
 *
 * Write strategy: callers fire-and-forget on a debounce (every Nth GPS
 * fix, ~30 s real-world) — we deliberately do NOT await on the hot
 * GPS-update path. AsyncStorage on Android is fast (sub-ms for small
 * payloads) but a network/disk hiccup must never block the live camera.
 *
 * Format: a single JSON-serialised array under one key. Decimation
 * already caps the breadcrumb at ~5000 points (~50 km), so the payload
 * stays under ~200 KB even on the longest single-user-day routes.
 */
const KEY_PREFIX = 'breadcrumb:';

const keyFor = (userId: string | null | undefined) => KEY_PREFIX + (userId || 'anonymous');

export async function saveBreadcrumb(userId: string | null | undefined, points: Breadcrumb[]): Promise<void> {
  try {
    if (points.length === 0) {
      // Empty trail = clear instead of storing `[]` so a stale snapshot
      // from a prior run doesn't survive a route reset.
      await AsyncStorage.removeItem(keyFor(userId));
      return;
    }
    await AsyncStorage.setItem(keyFor(userId), JSON.stringify(points));
  } catch (e) {
    // Disk-full / quota-exceeded should NEVER crash the live camera.
    // Worst-case: the trail isn't restored on next launch — degrades
    // gracefully to "blank trail", same as today's behaviour.
    if (__DEV__) console.warn('[breadcrumbStorage] save failed', e);
  }
}

export async function loadBreadcrumb(userId: string | null | undefined): Promise<Breadcrumb[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape filter — AsyncStorage round-trip is JSON, so a
    // legacy/corrupt payload could surface non-numeric coords. Drop
    // anything malformed silently rather than crashing the cockpit on
    // hydration.
    return parsed.filter(
      (p) => p && typeof p.lng === 'number' && typeof p.lat === 'number'
    ) as Breadcrumb[];
  } catch (e) {
    if (__DEV__) console.warn('[breadcrumbStorage] load failed', e);
    return [];
  }
}

export async function clearBreadcrumb(userId: string | null | undefined): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(userId));
  } catch (e) {
    if (__DEV__) console.warn('[breadcrumbStorage] clear failed', e);
  }
}
