/**
 * Van Loading Assistant — continuous barcode scanner.
 *
 * Workflow drivers run at the depot every morning:
 *   1. Open this screen → camera previews live
 *   2. Sweep barcodes across the viewfinder one parcel at a time
 *   3. On each match → MASSIVE overlay with original_sequence + van zone
 *      (loaded into the right quadrant of the van for fastest pull-out
 *      during delivery)
 *   4. Progress bar at the top counts loaded / total
 *
 * Out-of-route scans (e.g. wrong day's parcel) flash a red rejection
 * banner instead so they don't get loaded by mistake.
 *
 * Design choices flagged inline:
 *   - 2 s dedupe via firedAt ref (NOT setTimeout) so a held barcode
 *     doesn't spam haptics/state churn
 *   - Permission flow is synchronous: ask once, block on denial
 *   - `loadedIds` lives in component state (not Zustand) — loading is a
 *     pre-route audit, the value is ephemeral until the driver leaves
 *     the depot. Persisting would just reset every morning anyway.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  Animated,
} from 'react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useStopsStore, Stop } from '../src/store/stopsStore';
import { stopPinNumber } from '../src/utils/stopPinNumber';
import { getVanZone, VanZone } from '../src/utils/vanZone';

type Match = {
  stop: Stop;
  pinNumber: number;
  zone: VanZone;
  /** Sorted, de-duped list of the locked Sharpie numbers
   *  (`original_sequence`) of EVERY parcel at this address — INCLUDING the
   *  scanned one. Drives the headline range and the detail line. */
  addressNums: number[];
  /** Headline shown as the giant number: a single stop ("47") or, when
   *  multiple parcels share the address, the lowest–highest span
   *  ("47–52") so the loader pulls the whole group at once. */
  displayNumber: string;
  /** Total parcels at this address (incl. scanned). >= 2 ⇒ multi-parcel. */
  parcelCount: number;
};

const DEDUPE_MS = 2000;
const OVERLAY_HOLD_MS = 1800;

export default function VanScanScreen() {
  const router = useRouter();
  // Single-shot "attach" mode (entry point: stop-detail's small camera
  // icon next to the tracking input). When `attachToStopId` is set:
  //   1. The route-confirmed gate is bypassed (driver might be attaching
  //      a tracking number to a brand-new stop pre-confirm)
  //   2. The first valid scan PATCHes that stop's `tracking_number` and
  //      router.back()s — no overlay, no continuous loop
  // Without it, the screen behaves exactly as before: continuous van-load
  // scanner.
  const { attachToStopId } = useLocalSearchParams<{ attachToStopId?: string }>();
  const isAttachMode = typeof attachToStopId === 'string' && attachToStopId.length > 0;
  const stops = useStopsStore((s) => s.stops);
  const loadedIds = useStopsStore((s) => s.loadedStopIds);
  const markStopLoaded = useStopsStore((s) => s.markStopLoaded);
  const clearLoadedStops = useStopsStore((s) => s.clearLoadedStops);
  const updateStop = useStopsStore((s) => s.updateStop);
  const [permission, requestPermission] = useCameraPermissions();

  const [match, setMatch] = useState<Match | null>(null);
  const [reject, setReject] = useState<{ code: string } | null>(null);

  // Refs (NOT state) for dedupe — flipping these doesn't need a re-render,
  // and keeping them out of state prevents a 50 ms scanner→render→scanner
  // race that would let duplicate scans slip through.
  const lastScanRef = useRef<{ code: string; ts: number }>({ code: '', ts: 0 });
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rejectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pulse animation for the "scan ready" tint of the viewfinder reticle.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  // Build a quick map for O(1) tracking → stop lookup. Trim & uppercase
  // so 1D barcodes (often case-insensitive) match cleanly. Rebuilds on
  // every stops update — that's fine, the typical route is <500 entries.
  const lookupByTracking = useMemo(() => {
    const m = new Map<string, Stop>();
    for (const s of stops) {
      const tn = (s.tracking_number ?? '').trim().toUpperCase();
      if (tn) m.set(tn, s);
    }
    return m;
  }, [stops]);

  const totalStops = stops.length;
  const loadedCount = loadedIds.size;
  const progressPct = totalStops > 0 ? Math.min(100, (loadedCount / totalStops) * 100) : 0;
  // The Sharpie-marker badge (`original_sequence`) is locked the moment
  // the driver hits Confirm Route — and ONLY then. Without it, any
  // number we paint on the overlay would be based on transient import
  // order or the dynamic `order` field, which would change the next
  // time the driver re-optimises. If even ONE stop is locked we treat
  // the route as confirmed; otherwise we hard-gate the scanner with a
  // CTA pushing the driver back to Plan → Optimize → Confirm.
  const isRouteConfirmed = useMemo(
    () => stops.some((s) => typeof s.original_sequence === 'number'),
    [stops],
  );

  const onBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      const raw = (result.data ?? '').trim();
      if (!raw) return;
      const code = raw.toUpperCase();

      // 2 s dedupe: same code seen recently → silently ignore. Different
      // code resets the window so two parcels in quick succession both fire.
      const now = Date.now();
      if (lastScanRef.current.code === code && now - lastScanRef.current.ts < DEDUPE_MS) {
        return;
      }
      lastScanRef.current = { code, ts: now };

      // ── Single-shot attach mode ─────────────────────────────────────
      // Driver opened this from stop-detail's small camera icon to attach
      // a tracking number to ONE specific stop. We don't run the full
      // van-load lookup — the user has already picked the stop, the
      // scanner is just a typing shortcut. PATCH the field, success
      // haptic, pop back to stop-detail. The store's `updateStop`
      // already merges the response into Zustand, so the input field
      // on stop-detail will reflect the new value the moment we
      // navigate back.
      if (isAttachMode && attachToStopId) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Don't await — fire-and-forget on the popped stack means the
        // driver gets instant feedback. The store-level merge happens
        // inside updateStop and is reflected via Zustand subscription
        // on the destination screen.
        updateStop(attachToStopId, { tracking_number: raw });
        router.back();
        return;
      }

      const stop = lookupByTracking.get(code);

      if (!stop) {
        // Unknown barcode — gentle warning haptic + red rejection banner.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setReject({ code: raw });
        if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
        rejectTimerRef.current = setTimeout(() => setReject(null), OVERLAY_HOLD_MS);
        return;
      }

      // Successful match: success haptic + massive overlay + record load.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const pinNumber = stopPinNumber(stop) ?? 0;
      const zone = getVanZone(stop.original_sequence ?? pinNumber, totalStops);

      // ── Silent sibling detection ─────────────────────────────────────
      // Co-located parcels are a routine occurrence on B2C runs (apartment
      // blocks, shared driveways, multi-parcel orders) and the #1 reason
      // a loader returns to the depot with leftovers. Match by 5-decimal
      // lat/lng rounding (≈1.1 m) so trivial geocoder jitter doesn't
      // split true siblings, and fall back to a normalised address string
      // for stops missing coordinates entirely. Self is excluded; rows
      // without a stamped `original_sequence` are ignored because
      // showing a blank/dash in the sub-text would just confuse the
      // loader. Result is sorted ascending so "Also at this address:"
      // reads naturally regardless of scan order.
      const norm = (s: string | null | undefined) =>
        (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      const sameAddress = (other: Stop) => {
        if (other.id === stop.id) return false;
        const oLat = Number(other.latitude);
        const oLng = Number(other.longitude);
        const sLat = Number(stop.latitude);
        const sLng = Number(stop.longitude);
        if (
          Number.isFinite(oLat) && Number.isFinite(oLng) &&
          Number.isFinite(sLat) && Number.isFinite(sLng)
        ) {
          return oLat.toFixed(5) === sLat.toFixed(5) && oLng.toFixed(5) === sLng.toFixed(5);
        }
        return !!stop.address && norm(other.address) === norm(stop.address);
      };
      const siblings = stops
        .filter(sameAddress)
        .map((s) => s.original_sequence)
        .filter((n): n is number => typeof n === 'number')
        .sort((a, b) => a - b);

      // ── Address range (lowest–highest) ──
      // Fold the scanned parcel's own number into the sibling set so the
      // headline spans EVERY parcel at this address. When 2+ parcels share
      // the address we show the giant range "lowest–highest" so the loader
      // pulls the whole group in one grab; a single parcel keeps its plain
      // number. The scanned stop always has a locked sequence here (the
      // route-confirmation gate guarantees it), but we guard anyway.
      const selfSeq =
        typeof stop.original_sequence === 'number' ? stop.original_sequence : null;
      const addressNums = Array.from(
        new Set(selfSeq !== null ? [selfSeq, ...siblings] : siblings),
      ).sort((a, b) => a - b);
      const parcelCount = addressNums.length;
      const displayNumber =
        parcelCount >= 2
          ? `${addressNums[0]}\u2013${addressNums[parcelCount - 1]}`
          : String(pinNumber);

      setMatch({ stop, pinNumber, zone, addressNums, displayNumber, parcelCount });
      setReject(null);
      markStopLoaded(stop.id);
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
      overlayTimerRef.current = setTimeout(() => setMatch(null), OVERLAY_HOLD_MS);
    },
    [lookupByTracking, totalStops, stops, markStopLoaded, isAttachMode, attachToStopId, updateStop, router]
  );

  useEffect(() => () => {
    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
  }, []);

  // ── Permission gate ──────────────────────────────────────────────────
  if (!permission) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color="#10b981" size="large" />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.center, { padding: 32 }]}>
        <Ionicons name="camera-outline" size={64} color="#64748b" />
        <Text style={styles.permTitle}>Camera permission required</Text>
        <Text style={styles.permBody}>
          RouTeD needs camera access to scan parcel barcodes when loading
          your van. Tap below to grant permission.
        </Text>
        <TouchableOpacity
          style={styles.permButton}
          onPress={requestPermission}
          data-testid="van-scan-grant-permission"
        >
          <Text style={styles.permButtonText}>Grant Camera Access</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 14 }}>
          <Text style={{ color: '#94a3b8' }}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Route-confirmation guard. The whole point of the scanner is to map
  // a barcode → locked Sharpie-marker badge → van quadrant. None of
  // those exist until /routes/confirm has fired at least once on the
  // current route. Loading parcels with a transient `order`-based
  // number would mean re-loading the van every time the driver
  // re-optimises — defeating the entire feature. Block hard with a CTA
  // pushing the driver back to the planning flow.
  if (!isRouteConfirmed && !isAttachMode) {
    return (
      <View style={[styles.container, styles.center, { padding: 32 }]} data-testid="van-scan-not-confirmed">
        <Ionicons name="lock-closed-outline" size={64} color="#f59e0b" />
        <Text style={styles.permTitle}>Confirm your route first</Text>
        <Text style={styles.permBody}>
          {totalStops === 0
            ? 'Import a manifest, then optimise and confirm your route. The scanner needs a locked sequence to assign each parcel to the correct van zone.'
            : `You have ${totalStops} stops, but they aren't locked yet. Tap Optimise → Start to confirm the order. Once locked, scanned barcodes will show the right pin number and zone.`}
        </Text>
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 22 }}>
          <TouchableOpacity
            style={styles.permButton}
            onPress={() => router.replace('/(tabs)')}
            data-testid="van-scan-go-plan"
          >
            <Text style={styles.permButtonText}>
              {totalStops === 0 ? 'Import Manifest' : 'Plan Route'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.back()}
            style={[styles.permButton, { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#475569' }]}
          >
            <Text style={[styles.permButtonText, { color: '#94a3b8' }]}>Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        // Common 1D + 2D symbologies seen on Australia Post / Aramex /
        // StarTrack / Toll labels. Restricting the list speeds detection
        // and reduces false positives from text on the box.
        barcodeScannerSettings={{
          barcodeTypes: [
            'qr', 'pdf417', 'aztec', 'datamatrix',
            'code128', 'code93', 'code39',
            'ean13', 'ean8', 'upc_a', 'upc_e',
            'itf14',
          ],
        }}
        onBarcodeScanned={onBarcodeScanned}
      />

      {/* Top: progress bar + manifest audit counter */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} data-testid="van-scan-back">
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1, marginHorizontal: 10 }}>
          <View style={styles.headerRow}>
            <Text style={styles.headerTitle}>Van Loading</Text>
            <Text style={styles.headerCounter} data-testid="van-scan-counter">
              {loadedCount}/{totalStops}
            </Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
          </View>
        </View>
        <TouchableOpacity
          onPress={clearLoadedStops}
          style={styles.iconBtn}
          data-testid="van-scan-reset"
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
        >
          <Ionicons name="refresh" size={22} color="rgba(255,255,255,0.7)" />
        </TouchableOpacity>
      </View>

      {/* Reticle pulse — purely cosmetic, signals the camera is live */}
      <View pointerEvents="none" style={styles.reticleWrap}>
        <Animated.View
          style={[
            styles.reticle,
            {
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
              transform: [
                { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1.04] }) },
              ],
            },
          ]}
        />
        <Text style={styles.reticleHint}>
          {totalStops === 0
            ? 'No stops in this route — import a manifest first'
            : 'Point camera at a parcel barcode'}
        </Text>
      </View>

      {/* Massive success overlay — original_sequence + van zone */}
      {match && (
        <View
          pointerEvents="none"
          style={[styles.matchOverlay, { backgroundColor: match.zone.hex }]}
          data-testid={`van-scan-match-${match.pinNumber}`}
        >
          <Text style={[styles.matchSeqLabel, { color: match.zone.textHex }]}>
            {match.parcelCount >= 2 ? 'STOPS' : 'STOP'}
          </Text>
          <Text
            style={[styles.matchSeqNum, { color: match.zone.textHex }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.4}
            data-testid={`van-scan-match-number-${match.pinNumber}`}
          >
            {match.displayNumber}
          </Text>
          {/* Multi-parcel address: the headline above already shows the
             lowest–highest span; this line confirms the count and lists the
             exact numbers so a non-contiguous group (e.g. 47, 49, 52) is
             unambiguous and the loader grabs every parcel. */}
          {match.parcelCount >= 2 && (
            <>
              <Text style={[styles.matchSiblingsLabel, { color: match.zone.textHex }]}>
                {match.parcelCount} PARCELS · THIS ADDRESS
              </Text>
              <Text
                style={[styles.matchAddressNums, { color: match.zone.textHex }]}
                numberOfLines={2}
                adjustsFontSizeToFit
                minimumFontScale={0.4}
                data-testid={`van-scan-match-siblings-${match.pinNumber}`}
              >
                {match.addressNums.join(', ')}
              </Text>
            </>
          )}
          <View style={styles.zoneChip}>
            <Ionicons name="cube" size={20} color={match.zone.textHex} />
            <Text style={[styles.zoneChipText, { color: match.zone.textHex }]}>
              LOAD INTO {match.zone.zone.toUpperCase()}
            </Text>
          </View>
          <Text style={[styles.matchAddress, { color: match.zone.textHex }]} numberOfLines={2}>
            {match.stop.address}
          </Text>
          <View style={styles.zoneIndicator}>
            {[1, 2, 3, 4].map((q) => (
              <View
                key={q}
                style={[
                  styles.zoneIndicatorBar,
                  q === match.zone.quadrant
                    ? { backgroundColor: match.zone.textHex, opacity: 1 }
                    : { backgroundColor: match.zone.textHex, opacity: 0.25 },
                ]}
              />
            ))}
          </View>
        </View>
      )}

      {/* Reject overlay — barcode not in this route */}
      {reject && !match && (
        <View pointerEvents="none" style={styles.rejectOverlay} data-testid="van-scan-reject">
          <Ionicons name="close-circle" size={56} color="#fff" />
          <Text style={styles.rejectTitle}>NOT IN ROUTE</Text>
          <Text style={styles.rejectCode} numberOfLines={1}>
            {reject.code}
          </Text>
        </View>
      )}

      {/* Bottom hint with quadrant legend */}
      <View pointerEvents="none" style={styles.legendRow}>
        {([1, 2, 3, 4] as const).map((q) => {
          const z = getVanZone(q, 4); // sample sequence for label only
          return (
            <View key={q} style={[styles.legendChip, { backgroundColor: z.hex }]}>
              <Text style={[styles.legendChipQ, { color: z.textHex }]}>Q{q}</Text>
              <Text style={[styles.legendChipLabel, { color: z.textHex }]} numberOfLines={1}>
                {z.zone}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },

  // Permission gate
  permTitle: { color: '#f8fafc', fontSize: 20, fontWeight: '700', marginTop: 18 },
  permBody: { color: '#94a3b8', fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
  permButton: {
    marginTop: 26,
    backgroundColor: '#10b981',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
  },
  permButtonText: { color: '#0f172a', fontSize: 15, fontWeight: '800' },

  // Top bar
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 44,
    paddingBottom: 14,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  iconBtn: { padding: 6 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
  headerTitle: { color: '#f8fafc', fontSize: 17, fontWeight: '700', letterSpacing: 0.4 },
  headerCounter: { color: '#10b981', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  progressTrack: {
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: { height: 6, backgroundColor: '#10b981', borderRadius: 3 },

  // Reticle
  reticleWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticle: {
    width: 280,
    height: 180,
    borderColor: '#10b981',
    borderWidth: 3,
    borderRadius: 16,
  },
  reticleHint: {
    marginTop: 18,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.4,
    textAlign: 'center',
  },

  // Match overlay
  matchOverlay: {
    position: 'absolute',
    top: '14%',
    left: 18,
    right: 18,
    paddingVertical: 28,
    paddingHorizontal: 22,
    borderRadius: 22,
    alignItems: 'center',
    elevation: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
  },
  matchSeqLabel: { fontSize: 14, fontWeight: '700', letterSpacing: 4, opacity: 0.85 },
  matchSeqNum: {
    fontSize: 132,
    fontWeight: '900',
    letterSpacing: -4,
    lineHeight: 138,
    fontVariant: ['tabular-nums'],
  },
  matchAddressNums: {
    // The headline above is now the lowest–highest range, so the exact
    // parcel list is a clear-but-secondary readable line (auto-shrinks for
    // long groups). Tabular figures keep the digits aligned.
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 0.5,
    lineHeight: 36,
    fontVariant: ['tabular-nums'],
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  matchSiblingsLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 4,
    opacity: 0.75,
    marginTop: 2,
  },
  zoneChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    marginTop: 4,
    marginBottom: 12,
  },
  zoneChipText: { fontSize: 14, fontWeight: '800', marginLeft: 8, letterSpacing: 0.5 },
  matchAddress: { fontSize: 14, fontWeight: '600', textAlign: 'center', opacity: 0.92, paddingHorizontal: 6 },
  zoneIndicator: {
    flexDirection: 'row',
    marginTop: 18,
    gap: 6,
  },
  zoneIndicatorBar: {
    width: 38,
    height: 5,
    borderRadius: 3,
  },

  // Reject overlay
  rejectOverlay: {
    position: 'absolute',
    top: '32%',
    left: 32,
    right: 32,
    paddingVertical: 26,
    paddingHorizontal: 22,
    backgroundColor: '#dc2626',
    borderRadius: 20,
    alignItems: 'center',
    elevation: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 14,
  },
  rejectTitle: { color: '#fff', fontSize: 20, fontWeight: '900', letterSpacing: 1.6, marginTop: 8 },
  rejectCode: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontFamily: 'Courier', marginTop: 6 },

  // Bottom legend
  legendRow: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    gap: 6,
  },
  legendChip: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: 8,
    alignItems: 'center',
  },
  legendChipQ: { fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  legendChipLabel: { fontSize: 9, fontWeight: '600' },
});
