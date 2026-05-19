/**
 * LastMilePrecisionHUD
 * ─────────────────────────────────────────────────────────────────────────
 * "You are 23 metres from the door, at your 2 o'clock."
 *
 * Renders a tiny floating chip at the top-centre of the screen the moment
 * the driver crosses within `triggerRadiusMeters` (default 150 m) of the
 * upcoming stop. Disappears the instant they leave that radius or the
 * stop is marked completed.
 *
 * Why this helps:
 *   - Industrial estates / large complexes routinely have a 50–100 m gap
 *     between the geocoded centroid and the actual loading dock. The
 *     "X m ahead" line in the main nav panel just shows the polyline
 *     distance, which can stay flat while the driver walks/rolls toward
 *     the wrong building.
 *   - The clock-face direction ("2 o'clock") is more legible at a glance
 *     than a compass bearing in degrees when you're already moving.
 *
 * The geofence at 100 m fires the arrival event itself; this HUD is the
 * 100–150 m "lead-in" cue plus a 0–100 m "you're inside the radius now"
 * confirmation. It's read-only — no taps, no state side effects.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

export interface LastMilePrecisionHUDProps {
  /** Driver's live GPS fix. Pass null to keep the HUD hidden. */
  driverLat: number | null | undefined;
  driverLng: number | null | undefined;
  /**
   * Driver's heading in degrees, 0 = north, clockwise. Falls back to 0
   * if undefined — the clock face will then read absolute bearing rather
   * than relative-to-heading, which is still useful when stationary.
   */
  driverHeading?: number | null;
  /** Centroid of the next stop (the geofence target). */
  targetLat: number | null | undefined;
  targetLng: number | null | undefined;
  /** Master gate — pass `isNavigating && viewMode === 'navigating'`. */
  enabled: boolean;
  /**
   * Show the HUD when distance ≤ this. Default 150 m — slightly wider
   * than the 100 m geofence so the HUD pops up *before* the radius
   * fires, giving the driver visual cues to find the door.
   */
  triggerRadiusMeters?: number;
}

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

function haversineMeters(
  lat1: number, lng1: number, lat2: number, lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing from p1 to p2 in degrees [0, 360). */
function bearingDegrees(
  lat1: number, lng1: number, lat2: number, lng2: number,
): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Convert a relative-to-heading bearing to a clock-face hour (1–12).
 *   bearing 0     → 12 (ahead)
 *   bearing 90    → 3  (right)
 *   bearing 180   → 6  (behind)
 *   bearing 270   → 9  (left)
 *
 * Round to the nearest hour; we don't show half-hours because at speed
 * the GPS bearing jitters by 5–10° and half-hour precision is noise.
 */
function clockHour(relativeBearing: number): number {
  const norm = ((relativeBearing % 360) + 360) % 360;
  // 360° → 12 hours → 30° per hour. Use 0 → 12 (not 0) so it reads naturally.
  const hour = Math.round(norm / 30) % 12;
  return hour === 0 ? 12 : hour;
}

function formatDistance(m: number): string {
  if (m < 10) return `${m.toFixed(0)} m`;
  if (m < 100) return `${Math.round(m)} m`;
  return `${Math.round(m)} m`;
}

export const LastMilePrecisionHUD: React.FC<LastMilePrecisionHUDProps> = ({
  driverLat,
  driverLng,
  driverHeading,
  targetLat,
  targetLng,
  enabled,
  triggerRadiusMeters = 150,
}) => {
  const computed = useMemo(() => {
    if (
      !enabled
      || typeof driverLat !== 'number'
      || typeof driverLng !== 'number'
      || typeof targetLat !== 'number'
      || typeof targetLng !== 'number'
    ) return null;
    const dist = haversineMeters(driverLat, driverLng, targetLat, targetLng);
    if (dist > triggerRadiusMeters) return null;
    const tgtBearing = bearingDegrees(driverLat, driverLng, targetLat, targetLng);
    // Relative bearing = target bearing minus driver heading. If we have no
    // heading (stationary van, or first GPS fix after lock screen), fall
    // back to the absolute compass bearing — still useful.
    const heading = typeof driverHeading === 'number' ? driverHeading : 0;
    const relative = (tgtBearing - heading + 360) % 360;
    return {
      distance: dist,
      clock: clockHour(relative),
      // Inside geofence radius (100 m) = "you have arrived" amber glow.
      inside: dist <= 100,
    };
  }, [
    enabled, driverLat, driverLng, driverHeading,
    targetLat, targetLng, triggerRadiusMeters,
  ]);

  if (!computed) return null;

  return (
    <View
      style={[styles.container, computed.inside && styles.containerInside]}
      testID="last-mile-precision-hud"
      accessibilityLabel={
        `${formatDistance(computed.distance)} at ${computed.clock} o'clock`
      }
    >
      <Text style={styles.distance} testID="last-mile-distance">
        {formatDistance(computed.distance)}
      </Text>
      <Text style={styles.divider}>·</Text>
      <Text style={styles.clock} testID="last-mile-clock">
        {computed.clock} o&apos;clock
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 22,
    // Default: solid charcoal pill, high-contrast white text. Drivers
    // get a glance-recognizable shape regardless of underlying map style.
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
    zIndex: 50,
  },
  // Inside the 100 m geofence — amber-tinted to signal "you have arrived
  // / radius will fire any moment". Keeps the visual language consistent
  // with the rest of the immersive nav UI (amber = action zone).
  containerInside: {
    backgroundColor: 'rgba(245, 158, 11, 0.95)',
    borderColor: 'rgba(180, 83, 9, 0.85)',
  },
  distance: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  divider: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontSize: 18,
    marginHorizontal: 8,
  },
  clock: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});

export default LastMilePrecisionHUD;
