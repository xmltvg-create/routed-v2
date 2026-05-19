/**
 * RouteTraceBackground
 * ----------------------------------------------------------------
 * A decorative, GPU-cheap layer of three SVG "delivery routes"
 * that perpetually trace themselves across the splash screen,
 * giving the impression of live optimization happening in the
 * background. Reanimated drives strokeDashoffset on the worklet
 * thread so this stays at 60 fps even when the JS thread is busy
 * doing the OAuth round-trip.
 *
 * The paths are *intentionally* hand-tuned (not generated) so the
 * curves bend in directions that read as "city blocks" rather
 * than meandering noise. Stop pins are placed at the endpoints
 * with a soft pulse so the eye understands what the lines mean.
 */
import React, { useEffect } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Three "delivery routes" drawn relative to a 400x800 viewBox so
// they scale predictably across phone sizes. Each path carries
// its own duration + dash signature to feel organic rather than
// mechanically synced.
type RouteSpec = {
  d: string;
  length: number;            // approx pixel length of the path
  dasharray: string;         // dash pattern (comet head, gap, …)
  duration: number;          // ms for one full sweep
  delay: number;             // stagger entry
  color: string;
  width: number;
  endpoints: Array<{ cx: number; cy: number }>;
};

// Lengths are eyeballed; off by 5% is fine — it just affects the
// speed at which the comet appears to travel along the path.
const ROUTES: RouteSpec[] = [
  {
    d: 'M -20 120 C 80 90, 140 220, 230 200 S 360 280, 420 250',
    length: 620,
    dasharray: '50 600',
    duration: 4200,
    delay: 0,
    color: '#FF5A00',
    width: 2.2,
    endpoints: [
      { cx: -20, cy: 120 },
      { cx: 420, cy: 250 },
    ],
  },
  {
    d: 'M 50 720 C 110 600, 200 640, 240 540 S 320 380, 380 360',
    length: 720,
    dasharray: '40 700',
    duration: 5400,
    delay: 700,
    color: '#7CFFB2',
    width: 1.6,
    endpoints: [
      { cx: 50, cy: 720 },
      { cx: 380, cy: 360 },
    ],
  },
  {
    d: 'M 420 60 C 340 130, 260 80, 200 180 S 80 320, 30 460',
    length: 680,
    dasharray: '30 660',
    duration: 6800,
    delay: 1400,
    color: '#60A5FA',
    width: 1.4,
    endpoints: [
      { cx: 420, cy: 60 },
      { cx: 30, cy: 460 },
    ],
  },
];

const TraceLine = ({ spec }: { spec: RouteSpec }) => {
  const offset = useSharedValue(spec.length);

  useEffect(() => {
    offset.value = withDelay(
      spec.delay,
      withRepeat(
        withTiming(-spec.length, {
          duration: spec.duration,
          easing: Easing.linear,
        }),
        -1,
        false,
      ),
    );
    // Animation kicks off once and runs forever; we never tear it
    // down because the splash unmounts on successful auth anyway.
  }, []);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: offset.value,
  }));

  return (
    <>
      {/* Faint static rail under the comet so the path is still
          legible during the dark gap between sweeps. */}
      <Path
        d={spec.d}
        stroke={spec.color}
        strokeOpacity={0.08}
        strokeWidth={spec.width}
        fill="none"
        strokeLinecap="round"
      />
      <AnimatedPath
        d={spec.d}
        stroke={spec.color}
        strokeWidth={spec.width}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={spec.dasharray}
        animatedProps={animatedProps}
      />
    </>
  );
};

const StopPin = ({ cx, cy, color, delay }: { cx: number; cy: number; color: string; delay: number }) => {
  const scale = useSharedValue(0.6);

  useEffect(() => {
    scale.value = withDelay(
      delay,
      withRepeat(
        withTiming(1.4, { duration: 1800, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      ),
    );
  }, []);

  const animatedProps = useAnimatedProps(() => ({
    r: 3 * scale.value,
    opacity: 0.55 - (scale.value - 0.6) * 0.35,
  }));

  return (
    <>
      <AnimatedCircle cx={cx} cy={cy} fill={color} animatedProps={animatedProps} />
      <Circle cx={cx} cy={cy} r={2.2} fill={color} />
    </>
  );
};

export const RouteTraceBackground = () => {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg
        width={SCREEN_W}
        height={SCREEN_H}
        viewBox="0 0 400 800"
        preserveAspectRatio="xMidYMid slice"
      >
        <Defs>
          {/* Soft vignette so the trace lines fade into the page
              edges instead of clipping with a hard boundary. */}
          <LinearGradient id="fade-top" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#05070b" stopOpacity="1" />
            <Stop offset="0.25" stopColor="#05070b" stopOpacity="0" />
            <Stop offset="0.75" stopColor="#05070b" stopOpacity="0" />
            <Stop offset="1" stopColor="#05070b" stopOpacity="1" />
          </LinearGradient>
        </Defs>

        {ROUTES.map((spec, i) => (
          <TraceLine key={`route-${i}`} spec={spec} />
        ))}

        {ROUTES.flatMap((spec, i) =>
          spec.endpoints.map((p, j) => (
            <StopPin
              key={`pin-${i}-${j}`}
              cx={p.cx}
              cy={p.cy}
              color={spec.color}
              delay={spec.delay + j * 400}
            />
          )),
        )}

        {/* Top + bottom fade overlay for clean edges */}
        <Path d={`M0 0 H400 V800 H0 Z`} fill="url(#fade-top)" />
      </Svg>
    </View>
  );
};

export default RouteTraceBackground;
