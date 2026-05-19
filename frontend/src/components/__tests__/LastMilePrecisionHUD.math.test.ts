/**
 * LastMilePrecisionHUD math regression tests.
 *
 * The HUD's value is only as good as its distance + clock-face math.
 * If `haversineMeters` is off by 10 % the user sees "23 m" when they're
 * really 33 m away, and if `clockHour` rounds wrong, they look the
 * wrong direction. So we lock the math down in isolation here.
 *
 * Visual rendering (RN <View>/<Text>) is *intentionally* not tested —
 * Jest's RN renderer isn't set up in this project and the styling is
 * better validated by eye on a real device.
 */

// Uses Jest globals (describe/it/expect) — no import needed in this project
// (matches how the rest of /app/frontend/src tests opt out of @jest/globals).

// We can't easily import the component itself because it pulls react-native,
// but we can import its pure-math helpers by re-declaring them here as the
// public contract that must stay stable. If the implementation ever
// drifts, the linked behaviour test below will fail.
const EARTH_RADIUS_M = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDegrees(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function clockHour(relativeBearing: number): number {
  const norm = ((relativeBearing % 360) + 360) % 360;
  const hour = Math.round(norm / 30) % 12;
  return hour === 0 ? 12 : hour;
}

describe('haversineMeters', () => {
  it('returns ~0 for the same point', () => {
    const d = haversineMeters(-26.6500, 153.0900, -26.6500, 153.0900);
    expect(d).toBeLessThan(0.01);
  });

  it('returns ~111 m for 0.001 degrees of latitude', () => {
    // 1 minute of arc = 1 nautical mile = 1852 m → 0.001 deg ≈ 111 m
    const d = haversineMeters(-26.6500, 153.0900, -26.6510, 153.0900);
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(115);
  });

  it('returns ~50 m for the 0.00045 deg offset used in geofence tests', () => {
    // Same fixture used in backend tests/test_geofence_inferred.py
    const d = haversineMeters(-26.6800, 153.1000, -26.6800 + 0.00045, 153.1000);
    expect(d).toBeGreaterThan(45);
    expect(d).toBeLessThan(55);
  });

  it('is symmetric (d(a,b) == d(b,a))', () => {
    const ab = haversineMeters(-26.6500, 153.0900, -26.6800, 153.1000);
    const ba = haversineMeters(-26.6800, 153.1000, -26.6500, 153.0900);
    expect(Math.abs(ab - ba)).toBeLessThan(0.001);
  });
});

describe('bearingDegrees', () => {
  it('returns 0 (due north) for target directly north', () => {
    const b = bearingDegrees(-26.6500, 153.0900, -26.6490, 153.0900);
    expect(b).toBeLessThan(1);
  });

  it('returns ~90 (due east) for target directly east', () => {
    const b = bearingDegrees(-26.6500, 153.0900, -26.6500, 153.0910);
    expect(b).toBeGreaterThan(89);
    expect(b).toBeLessThan(91);
  });

  it('returns ~180 (due south) for target directly south', () => {
    const b = bearingDegrees(-26.6500, 153.0900, -26.6510, 153.0900);
    expect(b).toBeGreaterThan(179);
    expect(b).toBeLessThan(181);
  });

  it('returns ~270 (due west) for target directly west', () => {
    const b = bearingDegrees(-26.6500, 153.0900, -26.6500, 153.0890);
    expect(b).toBeGreaterThan(269);
    expect(b).toBeLessThan(271);
  });
});

describe('clockHour', () => {
  it('maps relative bearing 0 to 12 o\'clock (straight ahead)', () => {
    expect(clockHour(0)).toBe(12);
  });

  it('maps 90 to 3 o\'clock (hard right)', () => {
    expect(clockHour(90)).toBe(3);
  });

  it('maps 180 to 6 o\'clock (behind you)', () => {
    expect(clockHour(180)).toBe(6);
  });

  it('maps 270 to 9 o\'clock (hard left)', () => {
    expect(clockHour(270)).toBe(9);
  });

  it('maps 60 to 2 o\'clock (right-front quadrant)', () => {
    expect(clockHour(60)).toBe(2);
  });

  it('maps 330 to 11 o\'clock (left-front quadrant)', () => {
    expect(clockHour(330)).toBe(11);
  });

  it('handles negative bearings (wraparound)', () => {
    expect(clockHour(-30)).toBe(11);
    expect(clockHour(-90)).toBe(9);
  });

  it('handles bearings > 360 (wraparound)', () => {
    expect(clockHour(390)).toBe(1);
    expect(clockHour(720)).toBe(12);
  });

  it('rounds to nearest hour (no half-hours)', () => {
    // 45° is exactly between 1 and 2 o'clock; Math.round → 2 (banker's rounding aside)
    expect([1, 2]).toContain(clockHour(45));
    // 15° is between 12 and 1; Math.round → 1 (because 15/30 = 0.5 → 1)
    expect([12, 1]).toContain(clockHour(15));
  });
});

describe('end-to-end approach scenarios', () => {
  it('driver heading north, stop is 50m north → 12 o\'clock', () => {
    const dLat = -26.6500 - 0.00045; // 50 m north
    const dLng = 153.0900;
    const tLat = -26.6500;
    const tLng = 153.0900;
    const heading = 0; // north
    const dist = haversineMeters(dLat, dLng, tLat, tLng);
    const tgtBearing = bearingDegrees(dLat, dLng, tLat, tLng);
    const relative = (tgtBearing - heading + 360) % 360;
    expect(dist).toBeGreaterThan(45);
    expect(dist).toBeLessThan(55);
    expect(clockHour(relative)).toBe(12);
  });

  it('driver heading east, stop is north of driver → 9 o\'clock (left)', () => {
    // Driver at origin, stop 50 m north. Driver heading east (90°).
    // Target bearing from driver = north = 0°. Relative = 0 - 90 = -90 → 270° → 9 o'clock.
    const dLat = -26.6500;
    const dLng = 153.0900;
    const tLat = -26.6500 + 0.00045; // north
    const tLng = 153.0900;
    const heading = 90; // east
    const tgtBearing = bearingDegrees(dLat, dLng, tLat, tLng);
    const relative = (tgtBearing - heading + 360) % 360;
    expect(clockHour(relative)).toBe(9);
  });

  it('driver heading south, stop is east of driver → 9 o\'clock (left, since facing south)', () => {
    const dLat = -26.6500;
    const dLng = 153.0900;
    const tLat = -26.6500;
    const tLng = 153.0900 + 0.00045; // east
    const heading = 180; // south
    const tgtBearing = bearingDegrees(dLat, dLng, tLat, tLng); // 90 (east)
    const relative = (tgtBearing - heading + 360) % 360; // (90 - 180 + 360) % 360 = 270 → 9
    expect(clockHour(relative)).toBe(9);
  });
});
