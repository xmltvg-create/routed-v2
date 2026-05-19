/**
 * routeGeometry.ts — Defensive formatters for MapLibre line layers.
 *
 * MapLibre's `geojson` source is notorious for silently rendering nothing when
 * the input is subtly malformed. This module codifies the four failure modes
 * that cause the most wasted debugging time:
 *
 *   1. Wrong shape — raw coord array passed directly as `data`
 *   2. Swapped axes — [lat, lng] instead of the required [lng, lat]
 *   3. Non-finite values — NaN / Infinity sneaking in from backend errors
 *   4. Stale reference — `setData` receiving the same object identity, so
 *      MapLibre short-circuits the diff and never repaints.
 *
 * The module exports ONE function, `toRouteFeatureCollection`, that takes a
 * raw coordinate array and returns a fresh, valid GeoJSON FeatureCollection
 * every call. Consumers can useMemo it against the raw coords, because the
 * function itself is pure — same input always produces an *equal* but
 * *never identical* object (by design, to force a repaint).
 */

export type LngLat = [number, number];

export interface ToRouteFeatureOptions {
  /** When true, attempt to auto-detect [lat, lng] inputs and flip them.
   *  Disabled by default — the caller should know their backend contract. */
  autoFlipLatLng?: boolean;
  /** Optional properties merged into the Feature. Useful when the layer
   *  reads from `properties.color`, `properties.speed`, etc. */
  properties?: Record<string, unknown>;
}

/** Returns true iff `v` is a finite number. */
const isFiniteNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Checks a pair looks like a valid [lng, lat]. MapLibre silently discards
 *  features with out-of-range values, so we drop them before they even
 *  reach the renderer. */
const isValidLngLat = (pair: unknown): pair is LngLat => {
  if (!Array.isArray(pair) || pair.length < 2) return false;
  const [lng, lat] = pair as [unknown, unknown];
  if (!isFiniteNum(lng) || !isFiniteNum(lat)) return false;
  if (lng < -180 || lng > 180) return false;
  if (lat < -90 || lat > 90) return false;
  return true;
};

/** Fast heuristic: if the *first* value consistently lies inside latitude
 *  bounds (−90…90) while the *second* is outside them, the caller almost
 *  certainly handed us [lat, lng] pairs. Sampling a handful of points is
 *  enough — we do not need to scan the full polyline.
 */
const looksLikeLatLngSwap = (coords: number[][]): boolean => {
  const sample = coords.slice(0, Math.min(coords.length, 8));
  let firstInsideLat = 0;
  let secondOutsideLat = 0;
  for (const p of sample) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const a = p[0], b = p[1];
    if (!isFiniteNum(a) || !isFiniteNum(b)) continue;
    if (Math.abs(a) <= 90) firstInsideLat++;
    if (Math.abs(b) > 90 && Math.abs(b) <= 180) secondOutsideLat++;
  }
  // Require at least one "second is clearly a longitude" signal — prevents
  // false positives for routes that happen to be near the equator.
  return firstInsideLat === sample.length && secondOutsideLat >= 1;
};

/**
 * Validates, optionally axis-flips, and dedupes a raw coordinate list into
 * a canonical [lng, lat] array.  Always returns a brand-new array so the
 * parent FeatureCollection gets a fresh reference for MapLibre's diff.
 */
export function normaliseLineCoordinates(
  coords: number[][] | null | undefined,
  opts: ToRouteFeatureOptions = {},
): LngLat[] {
  if (!Array.isArray(coords) || coords.length === 0) return [];
  const shouldFlip = !!opts.autoFlipLatLng && looksLikeLatLngSwap(coords);

  const out: LngLat[] = [];
  let prev: LngLat | null = null;
  for (const raw of coords) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const pair: [number, number] = shouldFlip
      ? [raw[1] as number, raw[0] as number]
      : [raw[0] as number, raw[1] as number];
    if (!isValidLngLat(pair)) continue;
    // Strip exact duplicates — they waste GPU memory and cause MapLibre
    // to emit "Coincident coordinates in LineString" warnings in dev.
    if (prev && pair[0] === prev[0] && pair[1] === prev[1]) continue;
    out.push(pair);
    prev = pair;
  }
  return out;
}

/**
 * Build a ready-to-render GeoJSON FeatureCollection for a line layer.
 * A FeatureCollection (not a bare Feature) is used so the same component
 * can render multiple lines later without changing the source type.
 *
 * Empty or invalid inputs return an empty FeatureCollection — the line
 * layer will simply render nothing, without throwing or logging.
 */
export function toRouteFeatureCollection(
  coords: number[][] | null | undefined,
  opts: ToRouteFeatureOptions = {},
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const cleaned = normaliseLineCoordinates(coords, opts);
  if (cleaned.length < 2) {
    // MapLibre needs ≥2 points for a LineString — anything less is rendered
    // as empty rather than throwing.
    return { type: 'FeatureCollection', features: [] };
  }
  // IMPORTANT: fresh object + fresh array + fresh coord array. MapLibre's
  // geojson source uses shallow-equality to decide if it should re-tessellate
  // the tiles. Any identity reuse here silently drops repaints.
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { ...(opts.properties || {}) },
        geometry: {
          type: 'LineString',
          coordinates: cleaned,
        },
      },
    ],
  };
}
