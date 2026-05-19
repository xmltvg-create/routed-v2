/**
 * Breadcrumb decimation. Called by the live-tracking reducer once the
 * traveled-path crosses a threshold (~5000 points = ~50 km of driving)
 * to keep memory bounded over multi-day routes without sacrificing
 * recent-detail fidelity (which is what the driver actually looks at).
 *
 * Strategy: keep the most recent 60 % of points untouched (the part the
 * driver is panning around right now needs full ~10 m fidelity) and
 * decimate the older 40 % by dropping every other point. This halves
 * the older tail's resolution but preserves shape — the ghost trail
 * still reads as "where I drove" at low zoom.
 *
 * Why not Ramer-Douglas-Peucker? RDP would give a tighter line for the
 * same point budget but costs O(N log N) and would need a tolerance
 * tuned per-zoom. The "drop every other point in the old half" pass
 * is O(N), zero-config, and the visual delta is negligible for a
 * breadcrumb that's only there to confirm "yes, you came from over
 * there". RDP can be retro-fitted in the same call site if we ever
 * need it — the function signature stays stable.
 *
 * The reducer that calls this MUST trigger a full re-ship to the
 * WebView (not an append) — DeliveryMap.native.tsx's
 * `lastSentTraveledLenRef` already detects shrinkage and falls back
 * from `appendTraveled` to `updateTraveled`, so callers don't need
 * to do anything special.
 */
export type Breadcrumb = { lng: number; lat: number };

export const BREADCRUMB_DECIMATE_THRESHOLD = 5000;

export function decimateBreadcrumb(points: Breadcrumb[]): Breadcrumb[] {
  const n = points.length;
  if (n <= BREADCRUMB_DECIMATE_THRESHOLD) return points;

  // Split into "ancient" (front 40 %) and "recent" (back 60 %).
  const cutoff = Math.floor(n * 0.4);
  const ancient = points.slice(0, cutoff);
  const recent = points.slice(cutoff);

  // Drop every other point in the ancient half. Always keep the first
  // and last to preserve endpoint stitching.
  const decimated: Breadcrumb[] = [];
  for (let i = 0; i < ancient.length; i++) {
    if (i === 0 || i === ancient.length - 1 || i % 2 === 0) {
      decimated.push(ancient[i]);
    }
  }
  return decimated.concat(recent);
}
