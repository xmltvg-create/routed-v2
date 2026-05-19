// Sibling helper to `stopPinNumber.ts`. Where `stopPinNumber` returns the
// IMMUTABLE Sharpie-marker badge (`original_sequence`, locked at first
// confirm and never overwritten — what the driver wrote on the box),
// `stopDriveOrder` returns the CURRENT drive position
// (`sequence_number`, the 1-based rank the driver is following today).
//
// Why two helpers? After a mid-route re-optimise the driver's *drive
// order* shifts but the *box label* stays welded to the parcel. The
// dual-badge UI shows both:
//   • LEFT (large, optimised): `stopDriveOrder(stop)` → "drive to the 5th
//     stop next" — changes when the route is re-shuffled.
//   • RIGHT (small, Sharpie):  `stopPinNumber(stop)`   → "look for box
//     #127 in the van" — never changes once locked.
//
// Pre-confirmation both fields are null and the function returns null —
// callers MUST render a dash / blank, never an array index. This matches
// `stopPinNumber`'s no-fallback contract.

/** Minimal stop shape we need. Only `sequence_number` is consulted —
 *  the 1-indexed current drive position, written on confirm and
 *  rewritten on every re-optimise. Everything else on the row
 *  (`order`, `original_sequence`, list position, etc.) is intentionally
 *  ignored. */
export type StopLike = {
  id?: string | null;
  sequence_number?: number | null;
} | null | undefined;

/**
 * Returns the 1-indexed *current drive order* for a stop, or `null` if
 * the route has not been confirmed yet (i.e. `sequence_number` is
 * null/undefined/non-numeric).
 *
 * Resolution:
 *   1. `stop.sequence_number` (numeric) — the current drive-order rank.
 *   2. `null` — caller MUST render a dash / blank badge / hide the number.
 *
 * Callers MUST NOT substitute their array index, the row's `order`
 * field, or `original_sequence` here — `original_sequence` is the
 * Sharpie/box label (use `stopPinNumber` for that) and `order` is a
 * pre-confirmation planning preview.
 */
export function stopDriveOrder(stop: StopLike): number | null {
  if (stop && typeof stop.sequence_number === 'number' && !Number.isNaN(stop.sequence_number)) {
    return stop.sequence_number;
  }
  return null;
}
