/**
 * Hackathon judge demo — public, no-auth cinematic flythrough.
 *
 * Why this screen exists:
 *   - Build-fest judges decide in 30 seconds. They won't sign in with Google,
 *     they won't import a CSV. They want to see the wow.
 *   - The login screen exposes a "Watch the demo" button that pushes /demo
 *     bypassing the entire auth flow. From mount to camera-fly takes ~2s.
 *   - Everything is baked: 50 Sunshine Coast stops, the optimised order,
 *     the OSRM road-network polyline, headline savings stat. Backend
 *     just reads `/api/demo/scenario` from disk, so no solver spinner.
 *
 * What it shows:
 *   1. A topdown view of all 50 stops + the optimised route in green.
 *   2. On Start: camera tilts to 60°, drops to 16x zoom, follows a synthetic
 *      driver dot along the polyline at ~6× real-time speed (so a 148-min
 *      route plays in ~25 seconds).
 *   3. HUD shows stop counter and the next customer's name.
 *   4. End-of-route overlay: "50 stops · 72 km · 148 min — 102 km / 158 min
 *      saved vs as-dispatched (59%)". Replay + Try-it-yourself buttons.
 *
 * What it intentionally does NOT do:
 *   - No auth (judges can't sign in).
 *   - No real solver call (latency would kill the demo).
 *   - No live GPS (we're driving a synthetic dot, not the device).
 *   - No persistence (nothing written to MongoDB).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, Stack } from 'expo-router';
import * as Speech from 'expo-speech';
import { DeliveryMap, DeliveryMapRef } from '../src/components/DeliveryMap.native';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

interface Headline {
  stop_count: number;
  total_km: number;
  total_minutes: number;
  naive_km: number;
  naive_minutes: number;
  saved_km: number;
  saved_minutes: number;
  saved_pct: number;
  solver: string;
}
interface DemoStop {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  order: number;
}
interface Scenario {
  schema_version: number;
  headline: Headline;
  stops: DemoStop[];
  route: {
    geometry: number[][]; // [[lon, lat], ...]
    legs: { distance_m: number; duration_s: number }[];
    depot: { lat: number; lng: number };
  };
}

// Flythrough plays the full route in this many seconds regardless of real
// duration — judges want a 25-second wow, not a 2.5-hour sit. Camera lerps
// along the polyline accordingly.
const FLYTHROUGH_DURATION_S = 25;

export default function DemoScreen() {
  const router = useRouter();
  const mapRef = useRef<DeliveryMapRef>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'overview' | 'flying' | 'finished'>('overview');
  const [progress, setProgress] = useState(0); // 0..1 along the polyline
  const [stopIdx, setStopIdx] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startTsRef = useRef<number>(0);

  // ── Data fetch (cold-start ~50 ms in sandbox; pre-baked, no solver) ────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/api/demo/scenario`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as Scenario;
        if (!cancelled) setScenario(data);
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message ?? 'Failed to load demo');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Frame the route on first map-ready (covers both phases pre-flight) ─
  const stopsForMap = useMemo(() => {
    if (!scenario) return [];
    return scenario.stops.map((s, i) => ({
      id: s.id,
      address: s.address,
      latitude: s.latitude,
      longitude: s.longitude,
      order: s.order,
      completed: phase === 'flying' ? i <= stopIdx : phase === 'finished',
      delivery_status: 'pending' as const,
      name: s.name,
    }));
  }, [scenario, phase, stopIdx]);

  const routeCoords = scenario?.route.geometry ?? null;

  // ── Camera flythrough: lerps the synthetic driver dot along the
  //    polyline. Each frame: compute index = floor(progress*N), bearing
  //    from current→next vertex, jumpTo that point. The map's flyTo
  //    duration is ~80 ms so it interpolates between frames smoothly. ──
  const polyline = useMemo(() => routeCoords ?? [], [routeCoords]);
  const cumDist = useMemo(() => {
    if (polyline.length < 2) return [];
    const d: number[] = [0];
    for (let i = 1; i < polyline.length; i++) {
      const [a, b] = [polyline[i - 1], polyline[i]];
      const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
      const dy = b[1] - a[1];
      d.push(d[i - 1] + Math.hypot(dx, dy));
    }
    return d;
  }, [polyline]);
  const totalLen = cumDist[cumDist.length - 1] || 1;

  // Progressive trail behind the synthetic driver — feeds DeliveryMap's
  // `traveledPath` so the map renders the green "completed" portion of
  // the route fading from the start to the camera.
  const traveledPath = useMemo(() => {
    if (phase !== 'flying' || polyline.length < 2) return null;
    const target = progress * totalLen;
    const upto: number[][] = [];
    for (let i = 0; i < polyline.length; i++) {
      if (cumDist[i] <= target) upto.push(polyline[i]);
      else break;
    }
    return upto.length > 1 ? upto : null;
  }, [phase, progress, polyline, cumDist, totalLen]);

  const driverLocation = useMemo(() => {
    if (phase !== 'flying' || polyline.length < 2) return null;
    const target = progress * totalLen;
    let i = 1;
    while (i < cumDist.length && cumDist[i] < target) i++;
    const a = polyline[Math.max(0, i - 1)];
    const b = polyline[Math.min(polyline.length - 1, i)];
    const seg = cumDist[i] - cumDist[i - 1] || 1;
    const t = (target - cumDist[i - 1]) / seg;
    const lng = a[0] + (b[0] - a[0]) * t;
    const lat = a[1] + (b[1] - a[1]) * t;
    const bearing = Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI;
    return { latitude: lat, longitude: lng, accuracy: 5, heading: bearing, speed: 0 };
  }, [phase, progress, polyline, cumDist, totalLen]);

  // Drive map camera off the synthetic dot
  useEffect(() => {
    if (phase !== 'flying' || !driverLocation || !mapRef.current) return;
    mapRef.current.jumpTo(
      [driverLocation.longitude, driverLocation.latitude],
      { bearing: driverLocation.heading ?? 0, pitch: 60 },
    );
  }, [driverLocation, phase]);

  // Update the "Stop X of N" HUD as we cross each stop's coordinate
  useEffect(() => {
    if (phase !== 'flying' || !scenario || !driverLocation) return;
    const next = stopIdx + 1;
    if (next >= scenario.stops.length) return;
    const target = scenario.stops[next];
    const dx = target.longitude - driverLocation.longitude;
    const dy = target.latitude - driverLocation.latitude;
    // ~50 m radius (degrees * 111km ≈ km). Bumped to 0.001 to be lenient.
    if (Math.hypot(dx, dy) < 0.001) setStopIdx(next);
  }, [driverLocation, phase, scenario, stopIdx]);

  // ── Animation loop ─────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'flying') return;
    const tick = (t: number) => {
      if (!startTsRef.current) startTsRef.current = t;
      const elapsedS = (t - startTsRef.current) / 1000;
      const p = Math.min(1, elapsedS / FLYTHROUGH_DURATION_S);
      setProgress(p);
      if (p >= 1) {
        setPhase('finished');
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [phase]);

  const startFlythrough = () => {
    if (!scenario || polyline.length < 2) return;
    startTsRef.current = 0;
    setProgress(0);
    setStopIdx(0);
    setPhase('flying');
    // Snap the camera in at depot before the loop starts
    mapRef.current?.jumpTo([polyline[0][0], polyline[0][1]], { bearing: 0, pitch: 60 });

    // Voice narration — auditory hook for judges who scroll past silent
    // demos. expo-speech queues utterances on the system TTS engine, so
    // we line up four short lines spaced to land with the camera moving
    // (start → mid-flythrough → near-end → finish reveal). A polite
    // 0.95 rate keeps it intelligible at conference room ambient noise.
    Speech.stop();
    const lines = [
      `${scenario.headline.stop_count} stops across the Sunshine Coast.`,
      `As dispatched: ${Math.round(scenario.headline.naive_km)} kilometres,`,
      `${Math.round(scenario.headline.naive_minutes)} minutes of driving.`,
      `RouTeD delivers the same route in ${Math.round(scenario.headline.total_km)} kilometres.`,
      `That's ${Math.round(scenario.headline.saved_minutes)} minutes back to the driver — every day.`,
    ];
    lines.forEach((line) => {
      Speech.speak(line, { rate: 0.95, pitch: 1.0, language: 'en-AU' });
    });
  };

  // Whenever the user navigates away from /demo (close button, back gesture,
  // OS swipe-up) we MUST cancel any in-flight narration — otherwise the
  // voice keeps reading after the screen unmounts and bleeds into whatever
  // the user does next, which is jarring during a live demo.
  useEffect(() => {
    return () => {
      Speech.stop();
    };
  }, []);

  const replay = () => {
    Speech.stop(); // any leftover narration from the previous run
    setPhase('overview');
    setProgress(0);
    setStopIdx(0);
    if (scenario) {
      // Re-frame the whole route
      const lats = scenario.stops.map((s) => s.latitude);
      const lngs = scenario.stops.map((s) => s.longitude);
      const sw: [number, number] = [Math.min(...lngs), Math.min(...lats)];
      const ne: [number, number] = [Math.max(...lngs), Math.max(...lats)];
      mapRef.current?.fitBounds([sw, ne], 60);
    }
  };

  const onMapReady = () => {
    if (!scenario) return;
    const lats = scenario.stops.map((s) => s.latitude);
    const lngs = scenario.stops.map((s) => s.longitude);
    const sw: [number, number] = [Math.min(...lngs), Math.min(...lats)];
    const ne: [number, number] = [Math.max(...lngs), Math.max(...lats)];
    mapRef.current?.fitBounds([sw, ne], 60);
  };

  if (loadError) {
    return (
      <View style={styles.errorContainer}>
        <Ionicons name="cloud-offline-outline" size={48} color="#94a3b8" />
        <Text style={styles.errorText}>Couldn't load the demo: {loadError}</Text>
        <TouchableOpacity onPress={() => router.replace('/')} style={styles.errorBack}>
          <Text style={styles.errorBackText}>Back to login</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!scenario) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>Loading demo route…</Text>
      </View>
    );
  }

  const currentStop =
    phase === 'flying' && stopIdx < scenario.stops.length
      ? scenario.stops[stopIdx]
      : null;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      <DeliveryMap
        ref={mapRef}
        stops={stopsForMap as any}
        routeCoordinates={routeCoords}
        driverLocation={driverLocation}
        traveledPath={traveledPath}
        initialCenter={[scenario.route.depot.lng, scenario.route.depot.lat]}
        initialZoom={12}
        followDriver={false}
        onMapReady={onMapReady}
      />

      {/* Top bar — close button + headline pill */}
      <View style={styles.topBar} pointerEvents="box-none">
        <TouchableOpacity
          data-testid="demo-close-btn"
          style={styles.closeBtn}
          onPress={() => router.replace('/')}
        >
          <Ionicons name="close" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headlinePill}>
          <Text style={styles.headlinePillText}>
            {scenario.headline.stop_count} stops · {scenario.headline.total_km} km · {Math.round(scenario.headline.total_minutes)} min
          </Text>
        </View>
      </View>

      {/* Phase: overview — pre-flight CTA */}
      {phase === 'overview' && (
        <LinearGradient
          colors={['transparent', 'rgba(15,23,42,0.95)']}
          style={styles.overviewCard}
        >
          <Text style={styles.overviewKicker}>RouTeD · live demo</Text>
          <Text style={styles.overviewHeadline}>
            {scenario.headline.saved_km} km · {Math.round(scenario.headline.saved_minutes)} min back to the driver
          </Text>
          <Text style={styles.overviewSub}>
            50 stops across the Sunshine Coast. Same route a dispatcher would
            hand my driver: {scenario.headline.naive_km} km. Same 50 stops
            after RouTeD's optimiser: {scenario.headline.total_km} km.
            That's {scenario.headline.saved_pct}% less driving — every day.
          </Text>
          <TouchableOpacity
            data-testid="demo-start-btn"
            style={styles.startBtn}
            onPress={startFlythrough}
          >
            <Ionicons name="play" size={20} color="#fff" />
            <Text style={styles.startBtnText}>Start cinematic flythrough</Text>
          </TouchableOpacity>
          <Text style={styles.overviewFootnote}>
            Solved by {scenario.headline.solver} · routed on our own Fly.io OSRM
          </Text>
        </LinearGradient>
      )}

      {/* Phase: flying — top-mounted stop ticker */}
      {phase === 'flying' && currentStop && (
        <View style={styles.tickerCard}>
          <View style={styles.tickerCounter}>
            <Text style={styles.tickerCounterMain}>{stopIdx}</Text>
            <Text style={styles.tickerCounterSub}>/ {scenario.stops.length - 1}</Text>
          </View>
          <View style={styles.tickerBody}>
            <Text style={styles.tickerLabel}>Heading to</Text>
            <Text style={styles.tickerName} numberOfLines={1}>
              {scenario.stops[Math.min(stopIdx + 1, scenario.stops.length - 1)].name}
            </Text>
            <View style={styles.tickerProgressBar}>
              <View style={[styles.tickerProgressFill, { width: `${progress * 100}%` }]} />
            </View>
          </View>
        </View>
      )}

      {/* Phase: finished — savings card overlay */}
      {phase === 'finished' && (
        <LinearGradient
          colors={['transparent', 'rgba(15,23,42,0.97)']}
          style={styles.finishedCard}
        >
          <View style={styles.finishedBadge}>
            <Ionicons name="checkmark-circle" size={20} color="#10b981" />
            <Text style={styles.finishedBadgeText}>Route complete</Text>
          </View>
          <Text style={styles.finishedHeadline}>
            That's {scenario.headline.saved_km} km — saved
          </Text>
          <View style={styles.finishedStatsRow}>
            <View style={styles.finishedStatBlock}>
              <Text style={styles.finishedStatLabel}>As-dispatched</Text>
              <Text style={[styles.finishedStatValue, styles.statBefore]}>
                {scenario.headline.naive_km} km
              </Text>
            </View>
            <Ionicons name="arrow-forward" size={20} color="#94a3b8" />
            <View style={styles.finishedStatBlock}>
              <Text style={styles.finishedStatLabel}>RouTeD</Text>
              <Text style={[styles.finishedStatValue, styles.statAfter]}>
                {scenario.headline.total_km} km
              </Text>
            </View>
            <View style={styles.finishedDeltaPill}>
              <Text style={styles.finishedDeltaText}>−{scenario.headline.saved_pct}%</Text>
            </View>
          </View>
          <Text style={styles.finishedFootnote}>
            Per delivery day. Across 250 working days a year, that's{' '}
            {Math.round(scenario.headline.saved_km * 250).toLocaleString()} km off
            the odometer — for one driver.
          </Text>
          <TouchableOpacity
            data-testid="demo-view-benchmarks-btn"
            style={styles.benchmarksLink}
            onPress={() => router.push('/benchmarks')}
          >
            <Text style={styles.benchmarksLinkText}>
              See the 14-solver benchmark →
            </Text>
          </TouchableOpacity>
          <View style={styles.finishedActions}>
            <TouchableOpacity
              data-testid="demo-replay-btn"
              style={[styles.actionBtn, styles.actionBtnGhost]}
              onPress={replay}
            >
              <Ionicons name="refresh" size={18} color="#cbd5e1" />
              <Text style={styles.actionBtnGhostText}>Replay</Text>
            </TouchableOpacity>
            <TouchableOpacity
              data-testid="demo-try-yourself-btn"
              style={[styles.actionBtn, styles.actionBtnPrimary]}
              onPress={() => router.replace('/')}
            >
              <Text style={styles.actionBtnPrimaryText}>Try it with my stops</Text>
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        </LinearGradient>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  loadingText: { color: '#94a3b8', marginTop: 12, fontSize: 14 },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, backgroundColor: '#0f172a' },
  errorText: { color: '#cbd5e1', textAlign: 'center', marginTop: 16, fontSize: 15 },
  errorBack: { marginTop: 24, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999, borderWidth: 1, borderColor: '#334155' },
  errorBackText: { color: '#94a3b8', fontSize: 14 },

  topBar: {
    position: 'absolute', top: 50, left: 16, right: 16,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  closeBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(15,23,42,0.78)',
    alignItems: 'center', justifyContent: 'center',
  },
  headlinePill: {
    flex: 1, height: 40, borderRadius: 20, backgroundColor: 'rgba(15,23,42,0.78)',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14,
  },
  headlinePillText: { color: '#e2e8f0', fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },

  overviewCard: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 60,
    paddingHorizontal: 24, paddingBottom: 36,
  },
  overviewKicker: { color: '#3b82f6', fontSize: 12, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase' },
  overviewHeadline: { color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 6, lineHeight: 34 },
  overviewSub: { color: '#cbd5e1', fontSize: 14, lineHeight: 20, marginTop: 12 },
  startBtn: {
    marginTop: 20, height: 52, borderRadius: 26, backgroundColor: '#3b82f6',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  startBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  overviewFootnote: { color: '#64748b', fontSize: 11, marginTop: 12, textAlign: 'center' },

  tickerCard: {
    position: 'absolute', top: 110, left: 16, right: 16, height: 76,
    backgroundColor: 'rgba(15,23,42,0.92)', borderRadius: 18, paddingHorizontal: 18,
    flexDirection: 'row', alignItems: 'center', gap: 14,
    borderWidth: 1, borderColor: 'rgba(59,130,246,0.4)',
  },
  tickerCounter: { flexDirection: 'row', alignItems: 'baseline' },
  tickerCounterMain: { color: '#3b82f6', fontSize: 32, fontWeight: '800' },
  tickerCounterSub: { color: '#64748b', fontSize: 14, fontWeight: '600' },
  tickerBody: { flex: 1 },
  tickerLabel: { color: '#94a3b8', fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' },
  tickerName: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 2 },
  tickerProgressBar: {
    height: 3, backgroundColor: 'rgba(148,163,184,0.2)', borderRadius: 2, marginTop: 8, overflow: 'hidden',
  },
  tickerProgressFill: { height: '100%', backgroundColor: '#3b82f6' },

  finishedCard: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 80,
    paddingHorizontal: 24, paddingBottom: 36,
  },
  finishedBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  finishedBadgeText: { color: '#10b981', fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  finishedHeadline: { color: '#fff', fontSize: 32, fontWeight: '700', lineHeight: 38 },
  finishedStatsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18,
    paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1,
    borderColor: 'rgba(148,163,184,0.18)',
  },
  finishedStatBlock: { flex: 1 },
  finishedStatLabel: { color: '#64748b', fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' },
  finishedStatValue: { fontSize: 22, fontWeight: '700', marginTop: 2 },
  statBefore: { color: '#f87171', textDecorationLine: 'line-through' },
  statAfter: { color: '#10b981' },
  finishedDeltaPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(16,185,129,0.18)' },
  finishedDeltaText: { color: '#10b981', fontSize: 14, fontWeight: '700' },
  finishedFootnote: { color: '#94a3b8', fontSize: 13, lineHeight: 19, marginTop: 14 },
  benchmarksLink: {
    marginTop: 14, alignSelf: 'flex-start',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'rgba(59,130,246,0.12)', borderWidth: 1, borderColor: 'rgba(59,130,246,0.35)',
  },
  benchmarksLinkText: { color: '#60a5fa', fontSize: 13, fontWeight: '600' },
  finishedActions: { flexDirection: 'row', gap: 10, marginTop: 22 },
  actionBtn: {
    flex: 1, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 8,
  },
  actionBtnGhost: { borderWidth: 1, borderColor: '#334155' },
  actionBtnGhostText: { color: '#cbd5e1', fontSize: 15, fontWeight: '600' },
  actionBtnPrimary: { backgroundColor: '#3b82f6' },
  actionBtnPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
