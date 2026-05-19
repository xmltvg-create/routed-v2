/**
 * Van loading-zone math.
 *
 * Drivers load packages into a van in 4 sequential quadrants based on the
 * stop's `original_sequence` (the locked Sharpie-marker badge), so the
 * earliest deliveries sit by the sliding door and the last ones sit at the
 * far back. This means the driver only ever reaches into ~25% of the van
 * volume at any given moment — a >2× speedup vs random loading.
 *
 * Quadrant 1 (Q1)  → Front (Sliding Door)  — first deliveries, easiest reach
 * Quadrant 2 (Q2)  → Mid Front
 * Quadrant 3 (Q3)  → Mid Back
 * Quadrant 4 (Q4)  → Back (Rear Doors)     — last deliveries, deepest reach
 *
 * The zones are computed with INCLUSIVE-RIGHT bucketing using ceil so that
 * for a 100-stop route, sequence 1–25 is Q1, 26–50 is Q2, 51–75 is Q3,
 * 76–100 is Q4. Edge cases (totalRouteStops <= 0 or originalSequence out
 * of range) collapse to "Unknown" instead of throwing — the scanner needs
 * to keep running even on dirty data.
 */

export type VanZone = {
  /** 1-indexed quadrant. 0 means "unknown" (e.g. stop not in route yet). */
  quadrant: 0 | 1 | 2 | 3 | 4;
  /** Driver-facing label (matches load-van.tsx physical descriptions). */
  zone: string;
  /** Tailwind-flavoured class name (kept for parity with the design spec). */
  color: string;
  /** Hex value for direct RN style.backgroundColor use. */
  hex: string;
  /** Optional contrast helper for foreground text on the badge. */
  textHex: string;
};

const ZONES: Record<1 | 2 | 3 | 4, Omit<VanZone, 'quadrant'>> = {
  1: { zone: 'Front (Sliding Door)', color: 'bg-blue-500',   hex: '#3b82f6', textHex: '#ffffff' },
  2: { zone: 'Mid Front',            color: 'bg-emerald-500', hex: '#10b981', textHex: '#0f172a' },
  3: { zone: 'Mid Back',             color: 'bg-amber-500',   hex: '#f59e0b', textHex: '#0f172a' },
  4: { zone: 'Back (Rear Doors)',    color: 'bg-rose-500',    hex: '#f43f5e', textHex: '#ffffff' },
};

const UNKNOWN: VanZone = {
  quadrant: 0,
  zone: 'Unknown',
  color: 'bg-slate-500',
  hex: '#64748b',
  textHex: '#ffffff',
};

/**
 * Return the van loading zone for a given stop sequence and route size.
 *
 * @param originalSequence  1-indexed Sharpie-marker badge (immutable post-confirm).
 * @param totalRouteStops   Total stops in the active route (>= 1 expected).
 */
export function getVanZone(
  originalSequence: number | null | undefined,
  totalRouteStops: number,
): VanZone {
  if (
    !Number.isFinite(originalSequence as number) ||
    !Number.isFinite(totalRouteStops) ||
    totalRouteStops <= 0 ||
    (originalSequence as number) < 1 ||
    (originalSequence as number) > totalRouteStops
  ) {
    return UNKNOWN;
  }
  const seq = originalSequence as number;
  // Quadrant size with ceil so 100 stops → 25 per quadrant cleanly, and
  // routes not divisible by 4 (e.g. 102) put the remainder into the last
  // quadrant rather than overflowing.
  const qSize = Math.ceil(totalRouteStops / 4);
  let q = Math.ceil(seq / qSize) as 1 | 2 | 3 | 4;
  if (q < 1) q = 1;
  if (q > 4) q = 4;
  return { quadrant: q, ...ZONES[q] };
}
