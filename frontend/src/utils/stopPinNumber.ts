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

// ── Late Freight display-sequence resolver (45A, 45B …) ───────────────
// When a parcel is added AFTER the route is locked it has no
// `original_sequence`. Rather than painting an anonymous "★", we give it
// a human-friendly sequential label anchored to the nearest preceding
// LOCKED stop in the *visiting order* (the order the driver actually
// drives — typically the `order` field). So a late stop dropped between
// locked stops 45 and 46 reads "45A"; a second one in the same gap reads
// "45B"; and so on. This never mutates `original_sequence`.

/**
 * Returns the display label for the stop at `currentIndex` within a
 * visiting-ordered `stops` array.
 *
 *   • Locked stop  → its `original_sequence` as a string ("45").
 *   • Late freight → "<nearest preceding locked seq><letter>", e.g. "45A",
 *                    "45B". Letters increment per consecutive late stop
 *                    sharing the same locked anchor.
 *   • Late freight before ANY locked stop → "0A", "0B" … (still sequential
 *                    and unambiguous).
 *
 * IMPORTANT: the caller MUST pass `stops` in visiting/drive order (sorted
 * by `order`) so the "nearest preceding locked stop" trace-back is correct.
 */
export function getDisplaySequence(
  stops: ReadonlyArray<StopWithOrder>,
  currentIndex: number,
): string {
  const stop = stops[currentIndex];
  const seq = stop && stop.original_sequence;
  if (typeof seq === 'number' && !Number.isNaN(seq)) {
    return String(seq);
  }
  // Late freight — walk backwards to the nearest locked anchor, counting
  // how many late stops sit between it and `currentIndex` for the letter.
  let letterOffset = 0;
  for (let i = currentIndex - 1; i >= 0; i--) {
    const prev = stops[i];
    const prevSeq = prev && prev.original_sequence;
    if (typeof prevSeq === 'number' && !Number.isNaN(prevSeq)) {
      return `${prevSeq}${String.fromCharCode(65 + letterOffset)}`;
    }
    letterOffset += 1;
  }
  return `0${String.fromCharCode(65 + letterOffset)}`;
}

/**
 * Builds a `{ stopId: displayLabel }` map for every LATE-FREIGHT stop in
 * the given array. Locked stops are omitted (callers already render their
 * `original_sequence` directly). The input is sorted by `order` internally
 * so callers can pass the raw stops array in any order.
 */
export function buildLateFreightLabels(
  stops: ReadonlyArray<StopWithOrder & { id?: string | null }>,
): Record<string, string> {
  const ordered = [...stops].sort(
    (a, b) => ((a && a.order) ?? 0) - ((b && b.order) ?? 0),
  );
  const out: Record<string, string> = {};
  ordered.forEach((s, idx) => {
    const seq = s && s.original_sequence;
    const isLocked = typeof seq === 'number' && !Number.isNaN(seq);
    if (!isLocked && s && s.id) {
      out[s.id] = getDisplaySequence(ordered, idx);
    }
  });
  return out;
}
