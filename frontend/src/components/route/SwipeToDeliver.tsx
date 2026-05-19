/**
 * SwipeToDeliver
 * ----------------------------------------------------------------
 * Slide-to-confirm "Delivered" track that replaces the big green
 * tap-button in the immersive driving overlay. Two design wins:
 *
 *  1. A *deliberate* gesture (≥ 75% slide) prevents accidental
 *     completes from a steering-wheel knock — drivers told us the
 *     old tap was too easy to fire by mistake.
 *
 *  2. The track fully owns its touches end-to-end: the moment the
 *     finger lands on the knob we set ourselves as the responder
 *     AND tell the parent PanResponder it is not allowed to take
 *     the gesture back (`onResponderTerminationRequest={false}`).
 *     This protects against the same "outer pan steals inner tap"
 *     bug that just took down the previous Delivered button — even
 *     a 200 ms wobbly drag now reaches us, not the swipe-between-
 *     stops handler that wraps the whole card.
 *
 * Behaviour:
 *   - Drag knob right → progress bar fills green.
 *   - Cross 75 % of the track → haptic notification + onConfirm fires.
 *   - Release before 75 %  → spring snaps back, no side effects.
 *   - On confirm, the knob locks at 100 % until parent unmounts the
 *     component (i.e. moves to the next stop).
 *
 * Sized to match the prior `immersiveDeliveredBtn` exactly so the
 * surrounding [Failed | Delivered | Skip] row layout is unchanged.
 */
import React, { useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

const TRACK_HEIGHT = 56;
const KNOB_SIZE = 48;
const COMMIT_RATIO = 0.75;

export const SwipeToDeliver = ({
  onConfirm,
  disabled = false,
  style,
  testID = 'swipe-to-deliver',
}: {
  onConfirm: () => void;
  disabled?: boolean;
  style?: ViewStyle;
  testID?: string;
}) => {
  const [trackWidth, setTrackWidth] = useState(0);
  const [committed, setCommitted] = useState(false);
  const x = useRef(new Animated.Value(0)).current;
  // Track haptic-once at threshold so the feedback fires the moment the
  // driver crosses 75 %, not on every frame after.
  const crossedThresholdRef = useRef(false);
  // Where the knob was when the user grabbed it; subsequent moves are
  // computed as `grabOffset + g.dx` rather than `g.dx` so a finger that
  // landed mid-track doesn't snap the knob back to 0 the moment it
  // moves. Filled on grant, read in move/release.
  const grabOffsetRef = useRef(0);

  const maxX = Math.max(0, trackWidth - KNOB_SIZE);
  const commitX = maxX * COMMIT_RATIO;

  const responder = useRef<ReturnType<typeof PanResponder.create> | null>(null);
  if (!responder.current) {
    responder.current = PanResponder.create({
      // Capture-phase wins over the parent PanResponder unconditionally —
      // the parent (swipe-between-stops) only registers in bubble phase, so
      // by claiming during capture we get every touch that lands inside
      // the track regardless of which inner element it hit. This is the
      // architectural fix for the original "Delivered button doesn't fire"
      // bug class.
      onStartShouldSetPanResponderCapture: () => !committed && !disabled,
      onMoveShouldSetPanResponderCapture: () => !committed && !disabled,
      onStartShouldSetPanResponder: () => !committed && !disabled,
      onMoveShouldSetPanResponder: () => !committed && !disabled,
      onPanResponderGrant: (e) => {
        crossedThresholdRef.current = false;
        // Snap the knob under the finger if the user grabbed mid-track —
        // typical "slide-to-unlock" feel. Avoids a confusing dead zone
        // where the knob lags behind the finger by 100+ px.
        const touchX = e.nativeEvent.locationX ?? 0;
        const start = Math.max(0, Math.min(maxX, touchX - KNOB_SIZE / 2));
        x.setValue(start);
        // Save the offset so subsequent moves are relative to the grab
        // point rather than the knob's start position.
        grabOffsetRef.current = start;
      },
      onPanResponderMove: (_e, g) => {
        if (committed || disabled) return;
        const next = Math.max(
          0,
          Math.min(maxX, grabOffsetRef.current + g.dx),
        );
        x.setValue(next);
        if (!crossedThresholdRef.current && next >= commitX) {
          crossedThresholdRef.current = true;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        } else if (crossedThresholdRef.current && next < commitX) {
          crossedThresholdRef.current = false;
        }
      },
      onPanResponderRelease: (_e, g) => {
        if (committed || disabled) return;
        const settled = Math.max(
          0,
          Math.min(maxX, grabOffsetRef.current + g.dx),
        );
        if (settled >= commitX) {
          Animated.spring(x, {
            toValue: maxX,
            useNativeDriver: false,
            bounciness: 0,
            speed: 18,
          }).start();
          setCommitted(true);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          onConfirm();
          return;
        }
        Animated.spring(x, {
          toValue: 0,
          useNativeDriver: false,
          bounciness: 6,
        }).start();
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate: () => {
        Animated.spring(x, {
          toValue: 0,
          useNativeDriver: false,
          bounciness: 6,
        }).start();
      },
    });
  }

  // Fill width = current drag offset + knob width, so the green fill
  // visually "follows" the knob's right edge rather than its centre.
  const fillWidth = x.interpolate({
    inputRange: [0, maxX || 1],
    outputRange: [KNOB_SIZE, (maxX || 1) + KNOB_SIZE],
    extrapolate: 'clamp',
  });

  // Label fades out as the knob progresses — committed state hard-pins
  // it invisible so the post-confirm "Delivered ✓" check reads cleanly.
  const labelOpacity = committed
    ? new Animated.Value(0)
    : x.interpolate({
        inputRange: [0, (maxX || 1) * 0.5],
        outputRange: [1, 0],
        extrapolate: 'clamp',
      });

  return (
    <View
      style={[styles.track, style]}
      onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
      onResponderTerminationRequest={() => false}
      testID={testID}
    >
      <Animated.View style={[styles.fill, { width: fillWidth }]} />
      <Animated.Text style={[styles.label, { opacity: labelOpacity }]}>
        Slide to deliver  →
      </Animated.Text>
      {committed && (
        <View style={styles.committedOverlay} pointerEvents="none">
          <Ionicons name="checkmark" size={22} color="#fff" />
          <Text style={styles.committedText}>Delivered</Text>
        </View>
      )}
      <Animated.View
        style={[styles.knob, { transform: [{ translateX: x }] }]}
        {...responder.current.panHandlers}
        testID={`${testID}-knob`}
      >
        <Ionicons name="arrow-forward" size={22} color="#10b981" />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  // Sized to drop into the existing [Failed | Delivered | Skip] row in
  // place of the green button; kept the same border-radius and shadow
  // hooks via parent style.
  track: {
    flex: 1,
    height: TRACK_HEIGHT,
    borderRadius: 14,
    backgroundColor: '#064e3b',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#10b981',
    borderRadius: 14,
  },
  label: {
    color: '#d1fae5',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 0.4,
  },
  knob: {
    position: 'absolute',
    left: 4,
    top: (TRACK_HEIGHT - KNOB_SIZE) / 2,
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 3,
    elevation: 3,
  },
  committedOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  committedText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
});

export default SwipeToDeliver;
