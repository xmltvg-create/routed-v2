// Pure helper for resuming an active stop across driving-mode exit/re-enter.
//
// The backend `/api/navigation` endpoint rebuilds legs from the driver's
// CURRENT GPS and filters out completed stops. That means a numeric
// `legIndex` captured before the exit often points at a different stop on
// re-entry (collapsed waypoints, different origin, stops completed while
// the driver was away). Saving + matching by `to_stop.id` is stable.
//
// Kept as plain JS (no TS) so it runs in a plain Node script for
// unit tests without jest/vitest/babel config overhead.

/**
 * @typedef {Object} ResumeLeg
 * @property {{ id?: (string|null) } | null} [to_stop]
 */

/**
 * @typedef {Object} ResumeNavigationInput
 * @property {(string|null|undefined)} savedStopId
 * @property {ReadonlyArray<ResumeLeg|null|undefined>} freshLegs
 * @property {number} fallbackIdx
 * @property {boolean} sameRoute
 */

/**
 * Pick the correct leg index to resume at.
 *
 * Rules:
 *   - If `sameRoute` is false, always return the fallback (usually 0).
 *   - If `savedStopId` is empty, return the fallback.
 *   - If a leg with that stop ID exists in `freshLegs`, return its index.
 *   - Otherwise, return the fallback (the saved stop was completed /
 *     deleted while the driver was away).
 *
 * @param {ResumeNavigationInput} input
 * @returns {number}
 */
export function findResumeLegIndex(input) {
  const { savedStopId, freshLegs, fallbackIdx, sameRoute } = input;
  if (!sameRoute) return fallbackIdx;
  if (!savedStopId) return fallbackIdx;
  const matchIdx = freshLegs.findIndex(
    (leg) => !!leg && leg.to_stop && leg.to_stop.id === savedStopId,
  );
  return matchIdx >= 0 ? matchIdx : fallbackIdx;
}
