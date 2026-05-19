import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';

/**
 * Drive-order shift flash. Returns an `Animated.Value` that briefly ramps
 * to 1 (then back to 0) the moment `driveOrder` *changes between renders*
 * — i.e. the route was re-optimised and this stop's drive-order rank
 * shifted. Callers feed the value into a `backgroundColor` interpolation
 * to flash a badge amber so the driver gets silent confirmation that
 * "your route just changed" without an alert dialog.
 *
 * Sentinel skips:
 *   • Mount (`prev === undefined`) — never flash on first render, or the
 *     whole list lights up on every screen open.
 *   • `null → number` (initial confirm/lock) — that's not a *shift*, that
 *     IS the first stamp; flashing here would over-trigger.
 *   • `number → null` (clear/unstamp) — same reason; not a re-optimise.
 *   • `prev === current` — no actual change.
 *
 * Animation: 120 ms ramp-in, 800 ms hold, 1000 ms ramp-out. Total ~2 s.
 * `useNativeDriver: false` because we animate `backgroundColor`, which
 * the native driver doesn't support.
 */
export function useDriveOrderFlash(driveOrder: number | null): Animated.Value {
  const anim = useRef(new Animated.Value(0)).current;
  const prevRef = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = driveOrder;
    if (prev === undefined) return;            // mount
    if (prev == null || driveOrder == null) return; // confirm/clear, not a shift
    if (prev === driveOrder) return;           // no change

    Animated.sequence([
      Animated.timing(anim, {
        toValue: 1,
        duration: 120,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }),
      Animated.delay(800),
      Animated.timing(anim, {
        toValue: 0,
        duration: 1000,
        easing: Easing.in(Easing.quad),
        useNativeDriver: false,
      }),
    ]).start();
  }, [driveOrder, anim]);

  return anim;
}
