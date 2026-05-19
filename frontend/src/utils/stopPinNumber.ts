// Single source of truth for "what number is painted on the map pin for
// this stop?". The MapLibre sprite is `stop-${order}` and every stop badge
// surface (driving bottom sheet, stop-detail page, resume toast, centred
// RESUMING overlay) must render THIS number — never an array index, never
// a planning preview — so what's on the screen exactly matches what the
// driver has written on the physical box.
//
// **Sharpie-marker contract** (immutable badge): once a route has been
// confirmed (POST /api/routes/confirm), every stop in the payload carries
// a server-side `original_sequence` that is locked for the row's lifetime.
// We render ONLY that value because the driver writes it on the box —
// re-optimising mid-route reshuffles the DRIVE order (`sequence_number`)
// but the BADGE must stay welded to the box.
//
// The function deliberately DOES NOT fall back to `order + 1`, an array
// index, or any other dynamic value. If `original_sequence` is missing,
// it returns `null` so the caller renders a dash/blank — this visually
// forces the driver to hit "Confirm Route" before they start writing
// numbers on boxes. No silent degradation, no "preview" numbers that
// could later disagree with the locked Sharpie value.

/** Minimal stop shape we need. Only `original_sequence` is consulted —
 *  the 1-indexed Sharpie-locked field, written ONCE on first confirm
 *  and never overwritten. Everything else on the row (`order`,
 *  `sequence_number`, list position, etc.) is intentionally ignored. */
export type StopLike = {
  id?: string | null;
  original_sequence?: number | null;
} | null | undefined;

/**
 * Returns the 1-indexed pin number to display for a stop, or `null` if
 * the route has not been confirmed yet (i.e. `original_sequence` is
 * null/undefined/non-numeric).
 *
 * Resolution:
 *   1. `stop.original_sequence` (numeric) — the locked Sharpie-marker badge.
 *   2. `null` — caller MUST render a dash / blank badge / hide the number.
 *
 * Callers MUST NOT substitute their array index, the row's `order` field,
 * or `sequence_number` here — the whole point of this helper is that the
 * displayed number is bound to the stop's locked Sharpie value, never to
 * a transient planning state.
 */
export function stopPinNumber(stop: StopLike): number | null {
  if (stop && typeof stop.original_sequence === 'number' && !Number.isNaN(stop.original_sequence)) {
    return stop.original_sequence;
  }
  return null;
}

// ── Map-marker label resolver ─────────────────────────────────────────
// Three-state pin label, used by the planning map where drivers need to
// see the proposed sequence BEFORE they confirm it. Distinct from
// `stopPinNumber` because the map can fall back to a proposed index in
// planning mode — the strict callers (van-scan, stop-detail, resume
// toast) deliberately do NOT want that fallback.
//
// Determine `isRouteConfirmed` once at the parent and pass it down for
// every marker — see the recommended pattern at the bottom of this file.

export type StopWithOrder = StopLike & { order?: number | null };

/**
 * Returns the string label to paint on a stop's map pin.
 *
 * Resolution (strict, in order):
 *
 *   A. **The Lock** — if `stop.original_sequence` is a finite number,
 *      return `String(stop.original_sequence)`. This is the immutable
 *      Sharpie-marker value the driver wrote on the box.
 *   B. **Late Freight** — if `original_sequence` is missing AND the
 *      route as a whole has been confirmed (`isRouteConfirmed` true),
 *      return the late-freight glyph `'★'` (Unicode BLACK STAR, U+2605).
 *      The stop arrived after lock-in and has no slot in the original
 *      sequence — painted PURPLE on the map and badge.
 *   C. **Planning-Mode Fallback** — if the route hasn't been confirmed
 *      yet, return `String(index + 1)` so drivers can review the
 *      proposed sequence numbers on the map before pressing Confirm.
 *
 * The function never falls through to a dash/empty string — every pin
 * gets a label so drivers can always count and verify visually.
 */
export function stopPinLabel(
  stop: StopWithOrder,
  index: number,
  isRouteConfirmed: boolean,
): string {
  // A. The Lock — Sharpie-marker value wins, always.
  if (stop && typeof stop.original_sequence === 'number' && !Number.isNaN(stop.original_sequence)) {
    return String(stop.original_sequence);
  }
  // B. Late Freight — confirmed route but this stop has no slot.
  if (isRouteConfirmed) {
    return '\u2605';  // ★ Unicode BLACK STAR — kept in sync with map painter
  }
  // C. Planning-Mode Fallback — proposed optimisation order.
  return String(index + 1);
}

/**
 * Convenience helper: scan a stops array once and decide if the route
 * is in "Locked Mode" (any stop has `original_sequence`) or "Planning
 * Mode" (none do). Pass the result to `stopPinLabel` for every marker.
 */
export function isRouteConfirmed(stops: ReadonlyArray<StopLike>): boolean {
  for (const s of stops) {
    if (s && typeof s.original_sequence === 'number' && !Number.isNaN(s.original_sequence)) {
      return true;
    }
  }
  return false;
}
