import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  Dimensions,
  RefreshControl,
  Animated,
  Platform,
  Pressable,
  Share,
  Linking,
  Modal,
  KeyboardAvoidingView,
  FlatList,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import NetInfo from '@react-native-community/netinfo';
import { getQueuedIds as getOfflineQueuedIds, getQueuedActions, flush as flushOfflineQueue, type QueueAction } from '../../src/utils/syncQueue';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import { useOfflineCache } from '../../src/hooks/useOfflineCache';
import { useAuth } from '../../src/context/AuthContext';
import { isRouteConfirmed as computeRouteConfirmed } from '../../src/utils/stopPinNumber';
import { useStopsStore, Stop } from '../../src/store/stopsStore';
import { stopPinNumber } from '../../src/utils/stopPinNumber';
import { decimateBreadcrumb, BREADCRUMB_DECIMATE_THRESHOLD } from '../../src/utils/decimateBreadcrumb';
import { saveBreadcrumb, loadBreadcrumb, clearBreadcrumb } from '../../src/utils/breadcrumbStorage';
import { ClusterWarningsBanner } from '../../src/components/ClusterWarningsBanner';
import { OutlierWarningBanner } from '../../src/components/OutlierWarningBanner';
import { UnconfirmedNumbersBanner } from '../../src/components/UnconfirmedNumbersBanner';
import BenchmarkModal from '../../src/components/route/BenchmarkModal';
import { DeliveryMap, DeliveryMapRef, DeliveryStop, DriverLocation } from '../../src/components/DeliveryMap';
import { DrawingOverlay } from '../../src/components/DrawingOverlay';
import { NavigationPanel } from '../../src/components/route/NavigationPanel';
import { Sidebar } from '../../src/components/route/Sidebar';
import { RefinePanel, RefineEntryButton } from '../../src/components/route/RefinePanel';
import { HistoryModal } from '../../src/components/route/HistoryModal';
import { ViewMode, NavigationLeg, NavigationData, LiveRoute, OptimizationHub, DrawnSection } from '../../src/types/route';
import {
  calculateDistance, formatDistance, formatDuration, getSuburbColor,
  getManeuverIcon, isPointInPolygon, extractPhoneNumber,
  SECTION_COLORS, ALERT_TYPES,
} from '../../src/utils/route';
import { RouteProgressObserver } from '../../src/utils/RouteProgressObserver';
import { findResumeLegIndex } from '../../src/utils/resumeNavigation';
import { useNavigationTTS } from '../../src/hooks/useNavigationTTS';
import { useNavigationCamera } from '../../src/hooks/useNavigationCamera';
import { useGeofenceArrival, GeofenceStop } from '../../src/hooks/useGeofenceArrival';
import { LastMilePrecisionHUD } from '../../src/components/LastMilePrecisionHUD';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SIDEBAR_WIDTH = Math.min(320, SCREEN_WIDTH * 0.85);
const COLLAPSED_WIDTH = 56;
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';
const AUTO_REROUTE_DEVIATION_METERS = 40;
const AUTO_REROUTE_COOLDOWN_MS = 12000;

// Human-friendly "queued X ago" labels for the offline banner panel.
function formatRelativeTime(ts: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function RouteScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { stops, loading, fetchStops, optimizeRoute, optimizing, completeStop, uncompleteStop, arriveAtStop, deleteAllStops, archiveRoute, updateStop, deleteStop, reorderStops, fetchRecommendation, recommendation, flushSyncQueue, dismissQueuedAction, restoreQueuedAction, confirmRoute } = useStopsStore();
  // Cross-screen "drop me into the navigating cockpit, target = this stop"
  // intent, set by stop-detail's Navigate button. Subscribed-to (not pulled
  // via getState) so the effect below re-runs the moment another screen
  // sets it. Cleared from inside the effect after the nav flow is kicked
  // off — never read more than once.
  const pendingNavTargetId = useStopsStore((s) => s.pendingNavTargetId);
  const setPendingNavTarget = useStopsStore((s) => s.setPendingNavTarget);
  const offline = useOfflineCache();
  const [routeGeometry, setRouteGeometry] = useState<any>(null);
  const [clusterOverlays, setClusterOverlays] = useState<import('../../src/store/stopsStore').ClusterInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [routeStats, setRouteStats] = useState<{ distance: number; duration: number } | null>(null);
  // Persisted GPS-status from last optimize — drives the ✓/⚠ icon in the sidebar route card.
  const [routeFromCurrent, setRouteFromCurrent] = useState<boolean | null>(null);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [stopsCollapsed, setStopsCollapsed] = useState(false);
  const [collapsedSuburbs, setCollapsedSuburbs] = useState<Set<string>>(new Set());
  const [selectedStopModal, setSelectedStopModal] = useState<any>(null);
  const [editingStopAddress, setEditingStopAddress] = useState('');
  const [savingStopAddress, setSavingStopAddress] = useState(false);
  const [regeocodingStop, setRegeocodingStop] = useState(false);
  const [deletingStop, setDeletingStop] = useState(false);
  const [editingStopNotes, setEditingStopNotes] = useState('');
  const [savingStopNotes, setSavingStopNotes] = useState(false);

  useEffect(() => {
    if (selectedStopModal?.address) {
      setEditingStopAddress(selectedStopModal.address);
    } else {
      setEditingStopAddress('');
    }
    setEditingStopNotes(selectedStopModal?.notes || '');
  }, [selectedStopModal?.id, selectedStopModal?.address, selectedStopModal?.notes]);
  
  // Toggle suburb collapse/expand
  const toggleSuburbCollapse = (suburb: string) => {
    setCollapsedSuburbs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(suburb)) {
        newSet.delete(suburb);
      } else {
        newSet.add(suburb);
      }
      return newSet;
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  
  // View mode
  const [viewMode, setViewMode] = useState<ViewMode>('planning');
  
  // Algorithm selection
  const [showAlgorithmPicker, setShowAlgorithmPicker] = useState(false);
  const [showBenchmarkModal, setShowBenchmarkModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  // Trimmed to the 4 surfaced options (2026-05-12). Setter callers use
  // `as any` already (see line ~4042, ~4093) so this narrow type is
  // purely advisory — it documents what the picker is allowed to
  // produce. The backend still accepts any legacy algorithm id so
  // deep-links with stale values keep working.
  const [selectedAlgorithm, setSelectedAlgorithm] = useState<
    'auto' | 'vroom' | 'ortools' | 'vroom_lkh_3opt'
  >('auto');
  
  // Navigation state
  const [navigationData, setNavigationData] = useState<NavigationData | null>(null);
  const [currentLegIndex, setCurrentLegIndex] = useState(0);
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number; longitude: number; heading?: number } | null>(null);
  const [liveRoute, setLiveRoute] = useState<LiveRoute | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [isNavigating, setIsNavigating] = useState(false);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [isRerouting, setIsRerouting] = useState(false);
  const [traveledPath, setTraveledPath] = useState<Array<{lng: number; lat: number}>>([]);

  // Persist breadcrumb across cold-starts. The driver may force-quit (battery,
  // OS reaper, system update) mid-shift — coming back to a blank trail wipes
  // out their sense of "where I've been". We:
  //   1. Hydrate from AsyncStorage on mount (one-shot, before any GPS fix).
  //   2. Save a debounced snapshot ~every 30 s while driving (counted in GPS
  //      fixes, so a stationary van doesn't burn writes).
  //   3. Clear on `stopLiveTracking()` so a fresh route starts blank.
  // Per-user keying isolates trails on shared depot devices.
  const breadcrumbHydratedRef = useRef(false);
  const breadcrumbSaveCounterRef = useRef(0);
  useEffect(() => {
    if (breadcrumbHydratedRef.current) return;
    breadcrumbHydratedRef.current = true;
    let cancelled = false;
    (async () => {
      const restored = await loadBreadcrumb(user?.user_id);
      if (cancelled) return;
      if (restored.length > 0) {
        setTraveledPath(restored);
        if (__DEV__) console.log(`[breadcrumb] restored ${restored.length} points from storage`);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.user_id]);
  const [undoHistory, setUndoHistory] = useState<Array<{type: string; legIndex: number; stopId?: string}>>([]);
  const [isDragMode, setIsDragMode] = useState(false);
  const [nightMode, setNightMode] = useState(false);
  const [showNotesPreview, setShowNotesPreview] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);
  // Explicit handshake between "optimisation finished" and "driver committed".
  // True from the moment the solver returns a new sequence until the user
  // either taps "Confirm Route" (→ POST /routes/confirm → navigating mode)
  // OR mutates the route (add/delete/edit/re-optimise), which invalidates
  // the still-unconfirmed result. This is the ONLY signal the floating
  // "Confirm Route" CTA uses — see the render block near the bottom of
  // Planning-mode JSX. Store-level `optimizing` already gates spinners; this
  // flag is specifically about the post-success review window.
  const [hasUnconfirmedOptimization, setHasUnconfirmedOptimization] = useState(false);
  // ML data-pipeline health badge (sidebar). Refreshes on mount and after every
  // /complete (re-fetched via the same hook below). null = not yet loaded /
  // auth failure → badge silently hides, never crashes the sidebar.
  const [mlReadiness, setMlReadiness] = useState<{
    pairs: number;
    threshold: number;
    status: 'insufficient' | 'trainable' | 'ready';
  } | null>(null);
  const [immersiveMode, setImmersiveMode] = useState(true); // Start collapsed; auto-expands at 50m proximity
  const [mapStyle, setMapStyle] = useState<'streets' | 'satellite' | 'hybrid'>('streets');
  const [routeLineMode, setRouteLineMode] = useState<'full' | 'leg' | 'remaining'>('full');
  
  // Optimization Hubs State - Sequential waypoints for segmented optimization
  const [optimizationHubs, setOptimizationHubs] = useState<OptimizationHub[]>([]);
  const [showHubsPanel, setShowHubsPanel] = useState(false);
  
  // Route Refinement State - Lasso draw sections
  const [isRefineMode, setIsRefineMode] = useState(false);
  const [isActivelyDrawing, setIsActivelyDrawing] = useState(false); // True when user taps "Start Drawing"
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawnSections, setDrawnSections] = useState<{
    id: number;
    stopIds: string[];
    color: string;
    polygon: { lat: number; lng: number }[];
  }[]>([]);
  const [currentDrawPath, setCurrentDrawPath] = useState<{ lat: number; lng: number }[]>([]);
  
  // Map Alerts State
  const [mapAlerts, setMapAlerts] = useState<any[]>([]);
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [nearbyAlert, setNearbyAlert] = useState<any | null>(null);
  const [alertWarningDismissed, setAlertWarningDismissed] = useState<Set<string>>(new Set());

  // Map Layer Toggles
  const [showParcels, setShowParcels] = useState(false);

  // ── No-Go Zones (driver-marked impassable spots) ─────────────────────
  // One-tap creation: toggle `blockRoadMode`, tap the road on the map, the
  // backend snaps to the nearest road via OSRM /nearest and saves a 30 m
  // polygon. The optimiser penalises any matrix leg that crosses it.
  const [blockRoadMode, setBlockRoadMode] = useState(false);
  const [nogoZones, setNogoZones] = useState<Array<{ id: string; name?: string; polygon: number[][] }>>([]);

  const loadNogoZones = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const r = await fetch(`${BACKEND_URL}/api/nogo-zones`, { headers });
      if (!r.ok) return;
      const data = await r.json();
      // GET /api/nogo-zones returns a plain List[NoGoZoneOut].
      // Defensive: also accept {zones: [...]} for forward-compat.
      const zones = Array.isArray(data) ? data : (Array.isArray(data?.zones) ? data.zones : []);
      setNogoZones(zones);
      mapRef.current?.setNogoZones(zones);
    } catch (e) { console.warn('[nogo] loadNogoZones failed', e); }
  }, []);

  const handleBlockRoadTap = useCallback(async (lat: number, lng: number) => {
    // Single-shot: WebView already cleared its own flag. Mirror that here.
    setBlockRoadMode(false);
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    try {
      const headers = await getAuthHeaders();
      const r = await fetch(`${BACKEND_URL}/api/nogo-zones/from-point`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, radius_m: 30 }),
      });
      if (!r.ok) {
        Alert.alert('Block Road', `Could not save zone (HTTP ${r.status})`);
        return;
      }
      await loadNogoZones();
    } catch (e: any) {
      Alert.alert('Block Road', e?.message || 'Network error');
    }
  }, [loadNogoZones]);

  const toggleBlockRoadMode = useCallback(() => {
    setBlockRoadMode(prev => {
      const next = !prev;
      mapRef.current?.setBlockRoadMode(next);
      try { Haptics.selectionAsync(); } catch {}
      return next;
    });
  }, []);

  // Hidden manual OTA check — triggered by long-press on the "Block road"
  // pill. The auto-check on cold-start (app/_layout.tsx) only fires on a
  // full process kill; foreground/background cycles don't trigger it. This
  // gives drivers a way to force-pull the latest bundle without needing
  // to swipe-away the APK from recent apps.
  const forceOtaCheck = useCallback(async () => {
    try {
      const Updates = await import('expo-updates');
      if (!Updates.isEnabled) {
        Alert.alert('Updates', 'Updates are disabled in this build');
        return;
      }
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        Alert.alert('Up to date', 'You are running the latest version.');
        return;
      }
      Alert.alert('Update found', 'Downloading and restarting…');
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    } catch (e: any) {
      Alert.alert('Update check failed', e?.message || 'Unknown error');
    }
  }, []);

  const wipeAllNogoZones = useCallback(() => {
    Alert.alert(
      'Remove ALL No-Go Zones?',
      'This will wipe every no-go zone you have saved. The optimizer will go back to its full road network. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Wipe All',
          style: 'destructive',
          onPress: async () => {
            try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
            try {
              const headers = await getAuthHeaders();
              const r = await fetch(`${BACKEND_URL}/api/nogo-zones`, { method: 'DELETE', headers });
              if (!r.ok) {
                Alert.alert('Block Road', `Wipe failed (HTTP ${r.status})`);
                return;
              }
              const data = await r.json().catch(() => ({}));
              await loadNogoZones();
              Alert.alert('No-Go Zones Cleared', `${data?.deleted ?? 'All'} zones removed. Re-run Optimise to see the new path.`);
            } catch (e: any) {
              Alert.alert('Block Road', e?.message || 'Network error');
            }
          },
        },
      ]
    );
  }, [loadNogoZones]);

  const handleNogoZoneClick = useCallback((id: string, name: string) => {
    // Confirm-then-delete. Driver may tap a red zone by accident while
    // panning; the confirm step prevents accidental removal.
    //
    // The 3rd button "Remove ALL" is the escape hatch when a driver has
    // accumulated stale zones from old roadworks/closures that are now
    // forcing the optimiser into unnecessary detours every day. Clearing
    // them in one tap is much better than tapping each one in turn.
    Alert.alert(
      'Remove No-Go Zone?',
      name ? `Delete "${name}"?\nThe optimizer will no longer avoid this area.` : 'The optimizer will no longer avoid this area.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
            try {
              const headers = await getAuthHeaders();
              const r = await fetch(`${BACKEND_URL}/api/nogo-zones/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                headers,
              });
              if (!r.ok) {
                Alert.alert('Block Road', `Could not remove zone (HTTP ${r.status})`);
                return;
              }
              await loadNogoZones();
            } catch (e: any) {
              Alert.alert('Block Road', e?.message || 'Network error');
            }
          },
        },
        {
          text: 'Remove ALL',
          style: 'destructive',
          onPress: () => { wipeAllNogoZones(); },
        },
      ]
    );
  }, [loadNogoZones, wipeAllNogoZones]);

  useEffect(() => { void loadNogoZones(); }, [loadNogoZones]);

  // ── Pin painter mode: Planning vs Locked ──────────────────────────────
  // Computed once per stops update via `computeRouteConfirmed` (which scans
  // for any stop carrying `original_sequence`). Pushed to the WebView so
  // the pin painter can switch labels:
  //   • Planning Mode (false): pins missing sharpies show the proposed
  //     drive index (BLUE) — review the optimisation BEFORE confirming.
  //   • Locked Mode (true):   pins missing sharpies show "❗" (AMBER) —
  //     these are late-freight parcels that arrived after lock-in.
  useEffect(() => {
    const confirmed = computeRouteConfirmed(stops);
    mapRef.current?.setRouteConfirmed(confirmed);
  }, [stops]);

  // ── Sharpie marks auto-recovery ──────────────────────────────────────
  // If a CSV re-import or accidental wipe cleared `original_sequence` on
  // every stop, offer one-tap recovery via the deterministic VROOM+LKH
  // re-run on the backend (POST /api/stops/recover-sharpie-marks). The
  // alert fires once per app session — `sharpieRecoveryShownRef` guards
  // re-firing if the user dismisses or recovers and we re-load stops.
  const sharpieRecoveryShownRef = useRef(false);
  useEffect(() => {
    if (sharpieRecoveryShownRef.current) return;
    if (stops.length < 5) return;  // skip tiny test routes
    const withSharpie = stops.reduce(
      (n, s: any) => n + (s.original_sequence != null ? 1 : 0),
      0,
    );
    if (withSharpie === 0) {
      sharpieRecoveryShownRef.current = true;
      Alert.alert(
        'Sharpie marks missing',
        `Your ${stops.length} stops don't have stamped numbers. ` +
        `This usually happens after a CSV re-import. ` +
        `\n\nTap "Restore" to reproduce the last optimised sequence ` +
        `(uses VROOM+LKH, deterministic — gives you the same numbers ` +
        `you had before).`,
        [
          { text: 'Skip', style: 'cancel' },
          {
            text: 'Restore',
            onPress: async () => {
              try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
              try {
                const headers = await getAuthHeaders();
                const r = await fetch(`${BACKEND_URL}/api/stops/recover-sharpie-marks`, {
                  method: 'POST',
                  headers,
                });
                if (!r.ok) {
                  Alert.alert('Restore failed', `HTTP ${r.status}`);
                  return;
                }
                const data = await r.json();
                await fetchStops();
                Alert.alert('Restored', `${data.restored} of ${data.total} stops re-stamped via ${data.algorithm}.`);
              } catch (e: any) {
                Alert.alert('Restore failed', e?.message || 'Network error');
              }
            },
          },
        ],
      );
    }
  }, [stops, fetchStops]);
  const lastAlertFetch = useRef<number>(0);
  const alertCheckInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // Alert types with icons
  // Section colors
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);
  // Compass subscription — provides device heading when GPS course-over-ground
  // is invalid (stationary or below 1.4 m/s). Without this, the camera defaults
  // to north (bearing=0) until the driver moves >5 km/h. Hands off to GPS once
  // a real course arrives.
  const headingSubscription = useRef<Location.LocationSubscription | null>(null);
  const compassHeadingRef = useRef<number>(0);
  const hasGpsCourseRef = useRef<boolean>(false);
  const lastSpokenInstruction = useRef<string>('');
  // Tracks which of the 3 announcement stages have fired for the current step
  const voiceAnnouncementRef = useRef<{
    stepKey: string;       // instruction + distance-bucket to detect step change
    spokenEarly: boolean;
    spokenPrepare: boolean;
    spokenNow: boolean;
  }>({ stepKey: '', spokenEarly: false, spokenPrepare: false, spokenNow: false });
  const mapRef = useRef<DeliveryMapRef>(null);
  const cameraSpeedRef = useRef(0);
  // Stable callback for hooks that need direct WebView access (bypasses prop latency)
  const sendToMap = useCallback((msg: object) => { mapRef.current?.sendMessage(msg); }, []);
  const mapContainerLayoutRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  // RouteProgressObserver — manages arrival detection and route reset at each waypoint
  const progressObserverRef = useRef(
    new RouteProgressObserver({
      arrivalRadiusMeters: 50,
      arrivalCooldownMs: 3000,
      backendUrl: BACKEND_URL,
    })
  );
  const initialLocationRef = useRef<{ latitude: number; longitude: number; heading?: number } | null>(null);
  const proximityNotifiedRef = useRef<number>(-1);
  const navigationDataRef = useRef<NavigationData | null>(null);
  const currentLegIndexRef = useRef<number>(0);
  // Snapshot of the route's stop IDs (in order) at the moment nav was last
  // stopped. Used to decide whether a restart should resume at the previous
  // index or start fresh at stop 1.  Same sequence → resume.  Changed →
  // reset (the driver has re-optimised, added/removed stops, etc.).
  const lastNavRouteSignatureRef = useRef<string | null>(null);
  const lastNavLegIndexRef = useRef<number>(0);
  const lastNavActiveStopIdRef = useRef<string | null>(null);

  // Hydrate the resume-position refs from AsyncStorage once per mount so the
  // driver can close the app overnight and still pick up where they left off.
  // Stored payload: { signature: string, legIndex: number, savedAt: number }.
  // The 48-hour freshness window prevents surprise resumes from routes the
  // driver has long since forgotten — after that we start at stop 1 cleanly.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('pathpilot:navResume');
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const ageMs = Date.now() - (parsed?.savedAt || 0);
        if (ageMs > 48 * 60 * 60 * 1000) return; // stale — ignore
        if (typeof parsed?.signature === 'string' && typeof parsed?.legIndex === 'number') {
          lastNavRouteSignatureRef.current = parsed.signature;
          lastNavLegIndexRef.current = parsed.legIndex;
          lastNavActiveStopIdRef.current =
            typeof parsed?.activeStopId === 'string' ? parsed.activeStopId : null;
        }
      } catch {
        /* corrupt JSON — silently ignore; driver just starts at 0 */
      }
    })();
  }, []);
  const currentLocationRef = useRef<{ latitude: number; longitude: number; heading?: number } | null>(null);
  const updateLiveRouteRef = useRef<(location: { latitude: number; longitude: number }) => void | Promise<void>>(() => {});
  const autoRerouteLockRef = useRef<boolean>(false);
  const lastAutoRerouteAtRef = useRef<number>(0);
  
  // Algorithm info
  // Algorithm selector — trimmed from 18 → 4 on 2026-05-12 per user
  // request ("vroom + ortools + one more"). Backend still understands
  // every legacy algorithm id, so accidental deep-links to e.g.
  // `?algorithm=timefold` keep working. We just don't surface them in
  // the driver-facing picker. If we ever want to delete the unused
  // solver code from server.py for maintenance reasons that's a
  // follow-up — UI trim is the safe first step.
  const algorithms = [
    { id: 'auto', name: '🤖 Auto Select', desc: 'Best for your route size — VROOM+LKH+3opt at 11+ stops, VROOM under' },
    { id: 'vroom_lkh_3opt', name: '🏆 VROOM + LKH-3', desc: 'Full pipeline — highest quality (slowest)' },
    { id: 'vroom', name: '🚀 VROOM', desc: 'Industry-standard VRP — fast, great default' },
    { id: 'pyvrp', name: '🧬 PyVRP', desc: 'Hybrid genetic solver — state of the art results' },
    { id: 'ortools', name: '🧠 OR-Tools', desc: 'Google constraint solver — handles time windows + capacity' },
  ];
  
  // Animation values
  const sidebarAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // (Map data updates are now prop-driven via DeliveryMap — no throttled injection needed)

  // Reset map ready state when viewMode changes (map HTML is regenerated)
  useEffect(() => {
    setIsMapReady(false);
  }, [viewMode]);

  // Keep latest mutable values for long-lived GPS callbacks
  useEffect(() => {
    navigationDataRef.current = navigationData;
  }, [navigationData]);

  useEffect(() => {
    currentLegIndexRef.current = currentLegIndex;
  }, [currentLegIndex]);

  useEffect(() => {
    currentLocationRef.current = currentLocation;
  }, [currentLocation]);

  // Fetch initial route when map becomes ready during navigation (runs ONCE)
  const initRouteRef = useRef(false);
  useEffect(() => {
    if (isMapReady && viewMode === 'navigating' && currentLocation && navigationData && !initRouteRef.current) {
      initRouteRef.current = true;
      console.log('[Init] Map ready, fetching initial route...');
      updateLiveRouteRef.current?.(currentLocation);
    }
    // Reset when leaving navigation so it re-fires on next entry
    if (viewMode !== 'navigating') {
      initRouteRef.current = false;
    }
  }, [isMapReady, viewMode, navigationData, currentLocation]);

  // (Drawing mode sync no longer uses JS injection — lasso overlay is managed via React state)

  useEffect(() => {
    if (user) {
      fetchStops();
      requestLocationPermission();
    }
    
    return () => {
      if (locationSubscription.current) {
        try {
          locationSubscription.current.remove();
        } catch (e) {
          console.log('Location cleanup:', e);
        }
      }
      Speech.stop();
    };
  }, [user]);

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, []);

  // Cache stops for offline use whenever they change
  useEffect(() => {
    if (stops.length > 0) {
      offline.cacheStops(stops);
    }
  }, [stops]);

  const requestLocationPermission = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        const initialLoc = {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          heading: location.coords.heading || 0,
        };
        setCurrentLocation(initialLoc);
        currentLocationRef.current = initialLoc;
      }
    } catch (error) {
      console.error('Location error:', error);
    }
  };

  const toggleSidebar = () => {
    const toValue = sidebarExpanded ? 0 : 1;
    Animated.spring(sidebarAnim, {
      toValue,
      friction: 8,
      tension: 65,
      useNativeDriver: false,
    }).start();
    setSidebarExpanded(!sidebarExpanded);
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchStops();
    if (stops.length >= 2) {
      await fetchRouteDirections();
    }
    setRefreshing(false);
  }, [fetchStops, stops.length]);

  const fetchRouteDirections = async () => {
    if (stops.length < 2) return;
    
    try {
      // Build the OSRM request in CURRENT optimized-drive order (`order` ASC).
      //
      // Why explicit sort? `GET /api/stops` (routes/stops.py:84) returns
      // stops sorted by `_seq_rank = sequence_number ?? 1e9` — the locked
      // Sharpie execution order — so any background `fetchStops()` after
      // confirm reshuffles the in-memory `stops` array back into LOCKED
      // order even though `order` on each row reflects the latest
      // re-optimised drive sequence.
      //
      // Iterating the array as-is would draw the polyline through the
      // OLD locked path while the optimiser thinks the drive order is
      // the NEW one — exactly the "patchy / zig-zag" symptom the user
      // reported after the original_sequence lock landed.
      //
      // The display contract:
      //   • Pin badges → original_sequence  (Sharpie, locked)
      //   • Polyline   → order              (live optimal drive path)
      //   • XLSX `#`   → original_sequence  (Sharpie, locked)
      // so the line on the map ALWAYS shows the route the driver is
      // actually meant to follow right now, while the badges keep their
      // physical-box identity for hand-off and audit.
      const coordinates = [...stops]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((stop) => `${stop.longitude},${stop.latitude}`)
        .join(';');

      // ── AUDIT 5: line-draw order ─────────────────────────────────────
      // Pair this with [AUDIT API RX] to confirm the polyline draws in
      // the order the API delivered. If RX = [A,B,C,D,E] but DRAW =
      // [C,A,E,B,D] the frontend is sorting the array by the locked
      // original_sequence (or sequence_number) before drawing. After
      // the explicit `.sort((a,b) => a.order - b.order)` above the two
      // arrays MUST agree by construction — this log is a tripwire so
      // any future hand-edit that drops the sort surfaces immediately.
      const _drawOrder = [...stops]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .slice(0, 5)
        .map((s) => s.id);
      console.log('[AUDIT LINE DRAW]', _drawOrder);
      
      const response = await fetch(`${BACKEND_URL}/api/directions?coordinates=${coordinates}`);
      if (!response.ok) {
        // Backend returned 4xx/5xx (e.g. OSRM down, Mapbox refused) — clear
        // the stats so the HUD never shows a stale distance from an older
        // stop list. Otherwise drivers stare at a "705 km" number that no
        // longer matches the current route.
        console.warn(`fetchRouteDirections: backend returned ${response.status}`);
        setRouteStats(null);
        return;
      }
      const data = await response.json();

      if (data.geometry) {
        setRouteGeometry(data.geometry);
        setRouteStats({
          distance: data.distance,
          duration: data.duration,
        });
        // Cache for offline use
        offline.cacheRouteGeometry(data.geometry);
      } else {
        // Backend returned 200 but no usable route (e.g. `{error:"No route found"}`).
        // Clear stats for the same reason as above.
        setRouteStats(null);
      }
    } catch (error) {
      console.error('Failed to fetch directions:', error);
      // Network error — clear stats so we don't mislead the driver, then try
      // the offline geometry cache so the map still paints the last-known route.
      setRouteStats(null);
      const cached = await offline.loadCachedRouteGeometry();
      if (cached) {
        setRouteGeometry(cached);
        offline.setIsOffline(true);
      }
    }
  };

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const token = await AsyncStorage.getItem('session_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  };

  const fetchNavigationData = async (originOverride?: { latitude: number; longitude: number } | null) => {
    try {
      const headers = await getAuthHeaders();
      // Include current location in navigation request
      let url = `${BACKEND_URL}/api/navigation`;
      const liveOrigin = originOverride || currentLocationRef.current || currentLocation;
      if (liveOrigin) {
        url += `?current_lat=${liveOrigin.latitude}&current_lng=${liveOrigin.longitude}`;
      }
      const response = await fetch(url, { headers });
      
      if (response.ok) {
        const data = await response.json();
        if (!data.error) {
          setNavigationData(data);
          // Sync observer with fresh navigation data
          progressObserverRef.current.setNavigationData(data);
          return data;
        }
      }
    } catch (error) {
      console.error('Navigation fetch error:', error);
    }
    return null;
  };

  // Route geometry only depends on stop positions (id, order, lat/lng), not completion flags.
  // Without this signature, flipping `completed` on a stop would re-trigger a full Mapbox
  // directions fetch for ~78 stops — which is the big lag the driver feels when they tap
  // "Delivered" or the green tick.
  const routeSignature = useMemo(() => {
    return stops
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((s) => `${s.id}:${s.latitude?.toFixed(5)}:${s.longitude?.toFixed(5)}`)
      .join('|');
  }, [stops]);

  useEffect(() => {
    if (stops.length >= 2) {
      fetchRouteDirections();
    } else {
      setRouteGeometry(null);
      setRouteStats(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSignature]);

  // Helper to calculate distance between two points in meters
  // Formats the backend quality_badge into a single friendly sentence.
  // Returns an empty string when the optimizer didn't beat the naïve baseline.
  const formatQualityBadge = (badge: any): string => {
    if (!badge || !badge.improved) return '';
    const savedKm = Math.max(0, badge.saved_km ?? 0);
    const savedPct = Math.max(0, badge.saved_pct ?? 0);
    if (savedKm < 0.1 || savedPct < 0.5) return '';
    return `\n📈 Saved ${savedKm.toFixed(1)} km (${savedPct.toFixed(0)}%) vs greedy baseline`;
  };

  // Time-savings badge (vs the unoptimised input order — what the driver
  // would actually have driven if they hadn't tapped Optimise). Returns the
  // most user-visible signal in a delivery context: minutes saved.
  const formatTimeSavingsBadge = (ts: any): string => {
    if (!ts || !ts.improved) return '';
    const savedMin = Math.max(0, ts.saved_minutes ?? 0);
    const savedPct = Math.max(0, ts.saved_pct ?? 0);
    if (savedMin < 0.5) return '';
    // Round display: <1min show seconds, 1-60min show minutes, >60 show h+m.
    let pretty: string;
    if (savedMin < 1) {
      pretty = `${Math.round((ts.saved_seconds ?? 0))}s`;
    } else if (savedMin < 60) {
      pretty = `${Math.round(savedMin)} min`;
    } else {
      const h = Math.floor(savedMin / 60);
      const m = Math.round(savedMin - h * 60);
      pretty = m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    return `\n⏱️ Saved ${pretty} (${savedPct.toFixed(0)}%) vs unoptimised`;
  };

  const runOptimization = async (userLocation: { latitude: number; longitude: number } | null) => {
    const result = await optimizeRoute({
      algorithm: selectedAlgorithm,
      currentLatitude: userLocation?.latitude,
      currentLongitude: userLocation?.longitude,
      useCurrentLocation: !!userLocation,
      hubs: optimizationHubs.length > 0 ? optimizationHubs.map(h => ({
        id: h.id,
        latitude: h.latitude,
        longitude: h.longitude,
        order: h.order,
      })) : undefined,
    });
    if (!result) {
      // optimizeRoute() returns null on any failure (network, timeout, 401,
      // 5xx, server-side solver error). Without this Alert the spinner just
      // disappears silently and drivers think the app is broken — they were
      // seeing exactly that on expired sessions and carrier drops. The
      // store already logs the underlying error to console; here we only
      // need to give the driver an actionable next step.
      const lastErr = useStopsStore.getState().lastOptimizeError;
      const isAuth = lastErr?.status === 401 || lastErr?.status === 403;
      // Tiny diagnostic suffix — the host the request was *attempting* to
      // hit. Lets the driver tell us instantly whether the OTA landed
      // (prod URL) or they're still on the old bundle (preview URL).
      let host = '';
      try {
        host = new URL(process.env.EXPO_PUBLIC_BACKEND_URL!).hostname;
      } catch { /* ignore */ }
      const hostLine = host ? `\n\nAPI: ${host}` : '';
      Alert.alert(
        isAuth ? 'Session expired' : (lastErr?.status === 402 ? 'Pro required' : 'Optimization failed'),
        isAuth
          ? `Your sign-in expired. Please log out and sign back in to continue.${hostLine}`
          : (lastErr?.message
              ? `${lastErr.message}\n\nCheck your connection and try again.${hostLine}`
              : `Could not reach the optimizer. Check your connection and try again.${hostLine}`),
        [{ text: 'OK', style: 'default' }],
      );
    }
    return result;
  };

  const handleExportXlsx = async () => {
    try {
      const API = process.env.EXPO_PUBLIC_BACKEND_URL;
      const sessionToken = await AsyncStorage.getItem('session_token');
      if (!API || !sessionToken) {
        Alert.alert('Export Failed', 'Not signed in. Please re-authenticate via the Profile tab.');
        return;
      }
      // Use cacheDirectory (not documentDirectory) — Expo's expo-sharing
      // FileProvider config exposes cacheDirectory as a shareable URI on
      // Android 7+, while documentDirectory needs an explicit
      // <provider>/<paths> entry. cacheDirectory works out of the box.
      const fileUri = `${FileSystem.cacheDirectory}route_stops_${Date.now()}.xlsx`;
      const result = await FileSystem.downloadAsync(
        `${API}/api/stops/export/xlsx`,
        fileUri,
        { headers: { Authorization: `Bearer ${sessionToken}` } },
      );
      if (result.status !== 200) {
        Alert.alert('Export Failed', `Server returned HTTP ${result.status}. Try again or sign out/in.`);
        return;
      }
      // Validate the file actually has bytes — a 0-byte download is the
      // single most common cause of "shareAsync opens then nothing
      // happens" on Android (Excel viewer crashes silently on empty
      // spreadsheets).
      const info = await FileSystem.getInfoAsync(result.uri);
      const sz = (info as { size?: number }).size ?? 0;
      if (!info.exists || sz < 200) {
        Alert.alert('Export Failed', 'Downloaded file is empty. Check your connection and try again.');
        return;
      }
      // Required gate on Android: shareAsync silently no-ops if the OS
      // share-sheet provider isn't installed/available.
      const shareAvailable = await Sharing.isAvailableAsync();
      if (!shareAvailable) {
        Alert.alert(
          'Sharing Unavailable',
          'No app available to share the Excel file. The file was saved to:\n\n' + result.uri,
        );
        return;
      }
      await Sharing.shareAsync(result.uri, {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        UTI: 'org.openxmlformats.spreadsheetml.sheet',  // iOS UTI
        dialogTitle: 'Export Route Stops',
      });
    } catch (error) {
      const msg = (error as Error)?.message || String(error);
      console.error('Export error:', msg, error);
      Alert.alert('Export Error', msg.slice(0, 240));
    }
  };

  const handleOptimize = async () => {
    if (stops.length < 2) {
      Alert.alert('Not enough stops', 'Add at least 2 stops to optimize your route.');
      return;
    }

    // Clear any stale post-optimisation flag from a previous run BEFORE the
    // new request fires so the "Confirm Route" CTA doesn't linger over a
    // result that's about to be replaced. It will be re-set true in the
    // `finally` block ONLY if the new result actually succeeded.
    setHasUnconfirmedOptimization(false);
    let succeeded = false;
    try {
    // Always get a fresh GPS fix before optimizing so the route starts from the user's real current position
    let userLocation: { latitude: number; longitude: number } | null = null;
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        return new Promise<void>((resolve) => {
          Alert.alert(
            'Location Permission Required',
            'GPS access is needed to optimize from your current location. Optimize without GPS?',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
              {
                text: 'Optimize Without GPS',
                onPress: async () => {
                  await runOptimization(null);
                  resolve();
                },
              },
            ]
          );
        });
      }
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      userLocation = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      };
      setCurrentLocation(userLocation);
      currentLocationRef.current = userLocation;
    } catch (error) {
      console.log('Could not get current location, using cached:', error);
      // Fall back to cached location if fresh fix fails
      userLocation = currentLocation;
      if (!userLocation) {
        return new Promise<void>((resolve) => {
          Alert.alert(
            'GPS Unavailable',
            'Could not get your current location. The route will be optimized without a starting point.',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
              {
                text: 'Optimize Anyway',
                onPress: async () => {
                  await runOptimization(null);
                  resolve();
                },
              },
            ]
          );
        });
        return;
      }
    }
    
    // Pass current location and hubs to optimization
    const result = await runOptimization(userLocation);
    
    if (result && result.stops) {
      // Solver returned a valid sequence → mark success so the `finally`
      // block flips `hasUnconfirmedOptimization` on and the floating
      // "Confirm Route" CTA becomes visible. Do this BEFORE any of the
      // downstream Alert / haptic work so even if a later step throws
      // we still surface the confirm UI with the data we have.
      succeeded = true;

      // The store already has the optimized stops from optimizeRoute()
      // No need to fetchStops() - it was causing a race condition where
      // the DB wasn't fully updated yet
      
      // Store cluster overlay data if present (from cluster_first algorithm)
      if (result.clusters && result.clusters.length > 0) {
        setClusterOverlays(result.clusters);
      } else {
        setClusterOverlays([]);
      }
      
      // Build shadow comparison text
      const shadow = (result as any).shadow;
      let shadowText = '';
      if (shadow && !shadow.error) {
        const algoNames: Record<string, string> = { alns: 'ALNS', ortools: 'OR-Tools', two_opt: '2-Opt' };
        const name = algoNames[shadow.algorithm] || shadow.algorithm;
        if (shadow.savings_km < 0) {
          shadowText = `\nShadow: ${name} saved ${Math.abs(shadow.savings_km).toFixed(1)}km (${shadow.total_distance_km.toFixed(1)}km)`;
        } else if (shadow.savings_km > 0) {
          shadowText = `\nShadow: ${name} was ${shadow.savings_km.toFixed(1)}km longer`;
        } else {
          shadowText = `\nShadow: ${name} matched distance`;
        }
      }

      // Show optimization result — include the "started from current location" flag so
      // the user can see immediately whether the solver used their GPS fix. This was a
      // silent failure mode: payload missing lat/lng would send use_current_location=true
      // but backend would ignore it since coords were null → optimization started from
      // whatever DB stop was first. Now the user sees it at a glance.
      const fromCurrent = result.started_from_current_location
        ? '✓ Started from your current location\n'
        : '⚠ Did NOT start from current location (GPS missing or denied)\n';
      // Persist the flag so the sidebar route card shows the same ✓/⚠ even after the alert closes.
      setRouteFromCurrent(!!result.started_from_current_location);
      const alertButtons: any[] = [
        { text: 'Done', style: 'cancel' },
        {
          text: 'Refine',
          style: 'default',
          onPress: () => { enterRefineMode(); },
        },
      ];
      // Offer a one-tap retry when GPS was missing: re-fetch location then re-run optimize
      if (!result.started_from_current_location) {
        alertButtons.splice(1, 0, {
          text: 'Retry with GPS',
          style: 'default',
          onPress: async () => {
            try {
              const { status } = await Location.requestForegroundPermissionsAsync();
              if (status !== 'granted') {
                Alert.alert('Permission denied', 'Enable Location in Settings and try again.');
                return;
              }
              const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
              const fresh = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
              setCurrentLocation(fresh);
              currentLocationRef.current = fresh;
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              await runOptimization(fresh);
            } catch (e) {
              Alert.alert('GPS Unavailable', 'Could not get a fresh location fix. Move to an open area and try again.');
            }
          },
        });
      }
      Alert.alert(
        'Route Optimized',
        fromCurrent +
        `Algorithm: ${result.algorithm}\n` +
        `Total distance: ${result.total_distance_km} km\n` +
        `${result.reasoning}${shadowText}${formatTimeSavingsBadge((result as any).time_savings)}${formatQualityBadge((result as any).quality_badge)}`,
        alertButtons,
      );
      
      // Check if there's a nearby stop that's not first in the optimized route
      if (userLocation && stops.length > 0) {
        const NEARBY_THRESHOLD = 500; // 500 meters
        
        // Find all stops within threshold
        const nearbyStops = stops
          .map((stop, index) => ({
            stop,
            index,
            distance: calculateDistance(
              userLocation!.latitude,
              userLocation!.longitude,
              stop.latitude,
              stop.longitude
            )
          }))
          .filter(s => s.distance <= NEARBY_THRESHOLD)
          .sort((a, b) => a.distance - b.distance);
        
        // If there's a nearby stop and it's not the first in the optimized order
        if (nearbyStops.length > 0) {
          const closestStop = nearbyStops[0];
          const firstOptimizedStop = stops[0]; // After optimization, stops are reordered
          
          // Check if the closest stop is not the first one
          if (closestStop.stop.id !== firstOptimizedStop.id) {
            const distanceText = closestStop.distance < 100 
              ? `${Math.round(closestStop.distance)}m` 
              : `${(closestStop.distance / 1000).toFixed(1)}km`;
            
            Alert.alert(
              '📍 Nearby Stop Detected',
              `"${closestStop.stop.name || closestStop.stop.address.split(',')[0]}" is only ${distanceText} away from you.\n\nWould you like to start with this stop instead?`,
              [
                {
                  text: 'Keep Current Order',
                  style: 'cancel',
                },
                {
                  text: 'Start Here',
                  style: 'default',
                  onPress: async () => {
                    // Move the nearby stop to the first position
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    const headers = await getAuthHeaders();
                    const newOrder = [
                      closestStop.stop.id,
                      ...stops.filter(s => s.id !== closestStop.stop.id).map(s => s.id)
                    ];
                    
                    try {
                      await fetch(`${BACKEND_URL}/api/stops/reorder`, {
                        method: 'POST',
                        headers: { ...headers, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ stop_ids: newOrder }),
                      });
                      await fetchStops();
                      fetchRouteDirections();
                      Alert.alert('✅ Route Updated', `"${closestStop.stop.name || 'Nearby stop'}" is now your first stop.`);
                    } catch (error) {
                      console.error('Reorder error:', error);
                    }
                  },
                },
              ]
            );
            return; // Don't show the regular optimization alert
          }
        }
      }
      
      Alert.alert(
        '✨ Route Optimized!',
        `${result.reasoning}\n\nTotal distance: ${result.total_distance_km} km${formatTimeSavingsBadge((result as any).time_savings)}${formatQualityBadge((result as any).quality_badge)}`,
        [
          { text: 'Done', style: 'cancel' },
          { 
            text: '✏️ Refine Route', 
            style: 'default',
            onPress: () => {
              enterRefineMode();
            }
          }
        ]
      );
      fetchRouteDirections();
    }
    } finally {
      // API-resolution handoff (per spec): flip the review-flag iff the
      // solver actually returned a valid sequence. Setting this in
      // `finally` guarantees that any thrown error or an early return
      // path beneath still resolves the CTA state correctly — the store
      // already owns the spinner (`optimizing`) so we only gate the
      // review-window flag here.
      if (succeeded) setHasUnconfirmedOptimization(true);
    }
  };

  // Clear all stops and start new route
  const handleNewRoute = () => {
    Alert.alert(
      'Start New Route?',
      'Current route will be saved to history before clearing.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save & Start New',
          style: 'destructive',
          onPress: async () => {
            // Archive current route to history
            if (stops.length > 0) {
              await archiveRoute();
            }
            // Call API to clear all stops from the database
            const success = await deleteAllStops();
            if (!success) {
              Alert.alert('Error', 'Failed to clear stops. Please try again.');
              return;
            }
            // Clear all local UI state
            setRouteGeometry(null);
            setRouteStats(null);
            setOptimizationHubs([]);
            setNavigationData(null);
            setCurrentLegIndex(0);
            setViewMode('planning');
            setIsRefineMode(false);
            setIsActivelyDrawing(false);
            setDrawnSections([]);
            try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
          },
        },
      ]
    );
  };

  // ========== ROUTE REFINEMENT FUNCTIONS ==========
  
  // Check if a point is inside a polygon (ray casting algorithm)
  // Enter refine mode
  const enterRefineMode = () => {
    if (stops.length < 2) {
      Alert.alert('Not Enough Stops', 'Add at least 2 stops before refining your route.');
      return;
    }
    setIsRefineMode(true);
    console.log('[Lasso] enterRefineMode: setting isActivelyDrawing=false');
    setIsActivelyDrawing(false);
    setDrawnSections([]);
    setCurrentDrawPath([]);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };
  
  // Exit refine mode
  const exitRefineMode = () => {
    setIsRefineMode(false);
    setIsActivelyDrawing(false);
    setIsDrawing(false);
    setDrawnSections([]);
    setCurrentDrawPath([]);
    // Clear all section polygons + lasso from map when exiting refine mode
    mapRef.current?.setDrawingMode(false);
    mapRef.current?.clearLasso();
    mapRef.current?.clearAllSectionPolygons();
    // Ensure sidebar is expanded when it reappears
    setSidebarExpanded(true);
    sidebarAnim.setValue(1);
  };
  
  // Start freehand drawing
  const startFreehandDrawing = () => {
    console.log('[Lasso] startFreehandDrawing called — imperative setDrawingMode(true)');
    setIsActivelyDrawing(true);
    mapRef.current?.setDrawingMode(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  
  // Stop freehand drawing (when section is complete or cancelled)
  const stopFreehandDrawing = () => {
    console.log('[Lasso] stopFreehandDrawing: setting isActivelyDrawing=false');
    setIsActivelyDrawing(false);
    mapRef.current?.setDrawingMode(false);
  };
  
  // Handle completing a lasso drawing
  const completeLassoDrawing = (polygon: { lat: number; lng: number }[]) => {
    if (polygon.length < 3) return;
    
    console.log('[Lasso] completeLassoDrawing: setting isActivelyDrawing=false');
    setIsActivelyDrawing(false);
    mapRef.current?.setDrawingMode(false);
    
    // Find stops inside the polygon
    const stopsInside = stops.filter(stop => 
      isPointInPolygon({ lat: stop.latitude, lng: stop.longitude }, polygon)
    );
    
    if (stopsInside.length === 0) {
      Alert.alert('No Stops Selected', 'Draw around stops to include them in a section.');
      return;
    }
    
    // Check if any stops are already in a section
    const alreadySelectedIds = new Set(drawnSections.flatMap(s => s.stopIds));
    const newStopIds = stopsInside
      .filter(s => !alreadySelectedIds.has(s.id))
      .map(s => s.id);
    
    if (newStopIds.length === 0) {
      Alert.alert('Stops Already Selected', 'These stops are already in another section.');
      return;
    }
    
    const sectionNumber = drawnSections.length + 1;
    const newSection = {
      id: sectionNumber,
      stopIds: newStopIds,
      color: SECTION_COLORS[(sectionNumber - 1) % SECTION_COLORS.length],
      polygon: polygon,
    };
    
    setDrawnSections(prev => [...prev, newSection]);
    setCurrentDrawPath([]);
    setIsDrawing(false);
    
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };
  
  // ===================== Map Alerts Functions =====================
  
  // Fetch alerts near current location
  const fetchNearbyAlerts = useCallback(async (lat: number, lng: number) => {
    const now = Date.now();
    // Only fetch every 30 seconds
    if (now - lastAlertFetch.current < 30000) return;
    lastAlertFetch.current = now;
    
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/alerts?lat=${lat}&lng=${lng}&radius_km=10`
      );
      if (response.ok) {
        const alerts = await response.json();
        setMapAlerts(alerts);
        console.log('[Alerts] Fetched', alerts.length, 'alerts nearby');
      }
    } catch (error) {
      console.error('[Alerts] Error fetching:', error);
    }
  }, []);
  
  // Report a new alert
  const reportAlert = async (type: string) => {
    if (!currentLocation) {
      Alert.alert('Location Required', 'Your location is needed to report an alert.');
      return;
    }
    
    try {
      const response = await fetch(`${BACKEND_URL}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          latitude: currentLocation.latitude,
          longitude: currentLocation.longitude,
        }),
      });
      
      if (response.ok) {
        const alert = await response.json();
        setMapAlerts(prev => [...prev, alert]);
        setShowAlertModal(false);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        
        // Show confirmation
        const alertType = ALERT_TYPES.find(a => a.type === type);
        Alert.alert('Alert Reported', `${alertType?.label || 'Alert'} reported successfully. Thank you!`);
      } else {
        Alert.alert('Error', 'Failed to report alert. Please try again.');
      }
    } catch (error) {
      console.error('[Alerts] Error reporting:', error);
      Alert.alert('Error', 'Failed to report alert. Please try again.');
    }
  };
  
  // Confirm an alert still exists
  const confirmAlert = async (alertId: string) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/alerts/${alertId}/confirm`, {
        method: 'POST',
      });
      if (response.ok) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setNearbyAlert(null);
        setAlertWarningDismissed(prev => new Set(prev).add(alertId));
      }
    } catch (error) {
      console.error('[Alerts] Error confirming:', error);
    }
  };
  
  // Dismiss an alert (not there)
  const dismissAlert = async (alertId: string) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/alerts/${alertId}/dismiss`, {
        method: 'POST',
      });
      if (response.ok) {
        setMapAlerts(prev => prev.filter(a => a.id !== alertId));
        setNearbyAlert(null);
        setAlertWarningDismissed(prev => new Set(prev).add(alertId));
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch (error) {
      console.error('[Alerts] Error dismissing:', error);
    }
  };
  
  // Check proximity to alerts and show warning
  const checkAlertProximity = useCallback((lat: number, lng: number) => {
    if (mapAlerts.length === 0) return;
    
    const WARNING_DISTANCE_METERS = 500; // Warn within 500m
    
    for (const alert of mapAlerts) {
      // Skip already dismissed warnings
      if (alertWarningDismissed.has(alert.id)) continue;
      
      const distance = alert.distance_meters || 
        calculateDistance(lat, lng, alert.latitude, alert.longitude);
      
      if (distance <= WARNING_DISTANCE_METERS) {
        setNearbyAlert({ ...alert, distance_meters: distance });
        
        // Speak warning
        const alertType = ALERT_TYPES.find(a => a.type === alert.type);
        const distanceText = distance < 100 ? 'nearby' : `${Math.round(distance)} meters ahead`;
        Speech.speak(`Warning: ${alertType?.label || 'Alert'} ${distanceText}`, {
          language: 'en',
          rate: 1.1,
        });
        
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        break; // Only show one warning at a time
      }
    }
  }, [mapAlerts, alertWarningDismissed]);
  
  // ===================== End Map Alerts Functions =====================
  
  // Undo last section
  const undoLastSection = () => {
    if (drawnSections.length === 0) return;
    const lastSection = drawnSections[drawnSections.length - 1];
    mapRef.current?.removeSectionPolygon(lastSection.id);
    setDrawnSections(prev => prev.slice(0, -1));
    mapRef.current?.clearLasso();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };
  
  // Clear all sections
  const clearAllSections = () => {
    setDrawnSections([]);
    setCurrentDrawPath([]);
    mapRef.current?.clearAllSectionPolygons();
    mapRef.current?.clearLasso();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };
  
  // Apply sections and re-optimize
  const applySections = async () => {
    if (drawnSections.length === 0) {
      Alert.alert('No Sections', 'Draw sections on the map first.');
      return;
    }
    
    // Convert sections to backend format
    const sectionsForBackend = drawnSections.map(section => ({
      id: section.id,
      stop_ids: section.stopIds,
    }));
    
    // Get current location
    let userLocation = currentLocation;
    if (!userLocation) {
      try {
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        userLocation = {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
        };
        setCurrentLocation(userLocation);
      } catch (error) {
        console.log('Could not get current location');
      }
    }
    
    // Call optimize with sections
    const result = await optimizeRoute({
      algorithm: selectedAlgorithm,
      currentLatitude: userLocation?.latitude,
      currentLongitude: userLocation?.longitude,
      useCurrentLocation: !!userLocation,
      sections: sectionsForBackend,
    });
    
    if (result && result.stops) {
      exitRefineMode();
      // Compose the polish-savings line only when the backend actually
      // moved stops. `polish_distance_saved_km` is post-rounded server-side
      // so we just trust it here.
      const polishSaved = (result as any).polish_distance_saved_km ?? 0;
      const polishMoves = (result as any).polish_relocations ?? 0;
      const polishLine =
        polishSaved >= 0.05 || polishMoves > 0
          ? `\n\n⚡ Polish saved ${polishSaved.toFixed(1)} km${
              polishMoves > 0
                ? ` · ${polishMoves} spike${polishMoves === 1 ? '' : 's'} tightened`
                : ''
            }`
          : '';
      Alert.alert(
        '✨ Route Refined!',
        `Optimized with ${drawnSections.length} section${drawnSections.length > 1 ? 's' : ''}.\n\nTotal distance: ${result.total_distance_km} km${formatTimeSavingsBadge((result as any).time_savings)}${formatQualityBadge((result as any).quality_badge)}${polishLine}`,
        [{ text: 'Great!', style: 'default' }]
      );
      fetchRouteDirections();
    }
  };
  
  // Get section for a stop (if any)
  const getStopSection = (stopId: string): { id: number; color: string } | null => {
    for (const section of drawnSections) {
      if (section.stopIds.includes(stopId)) {
        return { id: section.id, color: section.color };
      }
    }
    return null;
  };


  const startNavigation = async () => {
    if (stops.length < 2) {
      Alert.alert('Not enough stops', 'Add at least 2 stops to start navigation.');
      return;
    }
    
    // Get current location FIRST before starting navigation
    let userLocation = currentLocation;
    if (!userLocation) {
      try {
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        userLocation = {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          heading: location.coords.heading || 0,
        };
        setCurrentLocation(userLocation);
        currentLocationRef.current = userLocation;
        console.log('✅ Got current location for navigation:', userLocation);
      } catch (error) {
        console.error('❌ Could not get current location:', error);
        Alert.alert(
          'Location Required', 
          'Please enable location services to start navigation.',
          [{ text: 'OK', style: 'cancel' }]
        );
        return;
      }
    }
    
    // Resume where the driver left off if they're restarting the SAME route.
    // Signature is the ordered list of stop IDs — if the stops or their
    // sequence changed (re-optimised, added, deleted), we fall back to 0.
    const currentSignature = stops.map((s: any) => s.id).join('|');
    const sameRoute = lastNavRouteSignatureRef.current === currentSignature
                      && stops.length > 0;
    const resumeIdx = sameRoute
      ? Math.max(0, Math.min(lastNavLegIndexRef.current, stops.length - 1))
      : 0;
    setCurrentLegIndex(resumeIdx);
    currentLegIndexRef.current = resumeIdx;
    if (userLocation) {
      initialLocationRef.current = userLocation;
    }
    
    // Initialize RouteProgressObserver for this navigation session
    progressObserverRef.current.resetToFirstLeg();
    
    // Fetch navigation data with current live location (prevents stale/static origin)
    const freshData = await fetchNavigationData(userLocation || null);

    // Re-align currentLegIndex by the SAVED stop ID. The backend rebuilds legs
    // from the new GPS and filters out completed stops, so the numeric index
    // captured before the exit may now point at a different stop. The pure
    // helper `findResumeLegIndex` is unit-tested in scripts/test-resume-navigation.js.
    if (sameRoute && lastNavActiveStopIdRef.current) {
      const freshLegs = freshData?.legs || [];
      const matchIdx = findResumeLegIndex({
        savedStopId: lastNavActiveStopIdRef.current,
        freshLegs,
        fallbackIdx: resumeIdx,
        sameRoute: true,
      });
      if (matchIdx !== resumeIdx) {
        setCurrentLegIndex(matchIdx);
        currentLegIndexRef.current = matchIdx;
        progressObserverRef.current.setLegIndex(matchIdx);
      }
      // Friendly confirmation — "Resumed at stop #N". Only show the toast
      // when we actually matched the saved stop (not when we fell back).
      //
      // Label reflects the ON-MAP PIN number (1-indexed position in the
      // current active-legs array — which is what the driver actually sees
      // next to each stop marker), NOT the DB `order` field. The two differ
      // once a driver completes earlier stops: backend filters completed
      // stops out of /api/navigation, so what the driver sees as map-pin #1
      // could have DB order=3. Using matchIdx+1 keeps the toast and the map
      // aligned.
      const matchedStop = freshLegs[matchIdx]?.to_stop;
      if (matchedStop && matchedStop.id === lastNavActiveStopIdRef.current) {
        // Pin number on the map sprite is locked to `original_sequence`
        // (Sharpie-marker contract). `stopPinNumber` returns null when
        // the stop hasn't been confirmed yet, which we surface as a
        // generic "Resumed" toast — never a fabricated index.
        const pinNumber = stopPinNumber(matchedStop);
        if (pinNumber != null) {
          setResumeToast(`Resumed at stop #${pinNumber}`);
          setResumingOverlayPin(pinNumber);
        } else {
          setResumeToast('Resumed');
        }
      }
    }
    setShowAlgorithmPicker(false);

    // Lock the current optimised sequence into the DB so GET /api/stops
    // keeps returning it in this exact order for the rest of the route —
    // even if a re-optimise in the background reshuffles the mutable
    // `order` field. Fire-and-forget: a flaky network must never block
    // the driver from starting navigation, so we kick this off, wait
    // briefly, then continue regardless of the outcome.
    try {
      const confirmIds = stops.map((s) => s.id);
      if (confirmIds.length > 0) {
        const ok = await confirmRoute(confirmIds);
        if (ok) {
          setResumeToast(`🔒 Route locked · ${confirmIds.length} stop${confirmIds.length === 1 ? '' : 's'}`);
          // Belt-and-suspenders: bust the cached fingerprint so the next
          // stops-effect tick UNCONDITIONALLY re-ships the just-stamped
          // original_sequence values to the WebView. Without this, the
          // bridge has been observed to skip the post-confirm update on
          // slow/partial JSON responses, leaving pins painted blue
          // (tentative drive-order) when they should be red (Sharpie-locked).
          mapRef.current?.forceStopsRefresh();
          // Also defensively re-fetch from server so Zustand state is the
          // canonical source-of-truth even if the merge in `confirmRoute`
          // missed a row (e.g., the response body was truncated by a proxy).
          fetchStops().catch(() => { /* best-effort */ });
        } else {
          const err = useStopsStore.getState().lastFetchError;
          console.warn('[startNavigation] confirmRoute failed, starting anyway:', err?.message);
        }
      }
    } catch (e) {
      console.warn('[startNavigation] confirmRoute threw, starting anyway:', e);
    }

    setViewMode('navigating');
    setSidebarExpanded(false);

    // Fire-and-forget: pre-warm the housenumbers cache for every stop so the
    // property-number overlay appears instantly at each curb without waiting
    // for an on-device moveend → backend fetch roundtrip. Runs in parallel
    // with the live-tracking startup so it never blocks navigation.
    try {
      const coords = stops
        .filter((s) => typeof s.longitude === 'number' && typeof s.latitude === 'number')
        .slice(0, 80)
        .map((s) => [s.longitude, s.latitude]);
      // Route polyline (OSRM geometry) — lets the backend sample every ~200 m
      // so the whole driving corridor is cached, not only the stops.
      const polyline: number[][] | undefined =
        (navigationData as any)?.coordinates ||
        (navigationData as any)?.geometry?.coordinates ||
        undefined;
      if (coords.length > 0 && BACKEND_URL) {
        fetch(`${BACKEND_URL}/api/housenumbers/prewarm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ coordinates: coords, polyline }),
        }).catch(() => {
          /* silent — prewarm is best-effort */
        });
      }
    } catch { /* noop */ }
    
    Animated.spring(sidebarAnim, {
      toValue: 0,
      friction: 8,
      tension: 65,
      useNativeDriver: false,
    }).start();
    
    startLiveTracking();

    // Start foreground service for persistent background tracking
    // (Android: non-dismissible notification while driving)
    import('../../src/tracking/BackgroundRouteTracking').then(({ startRouteTracking }) => {
      startRouteTracking((loc) => {
        // Forward background location updates to the existing live tracking pipeline
        if (loc?.coords) {
          setCurrentLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
        }
      }).catch(() => { /* best-effort — live tracking still works via foreground watchPosition */ });
    }).catch(() => { /* dynamic import failed — continue without foreground service */ });
  };

  const stopNavigation = () => {
    // Tear down foreground service (removes persistent notification)
    import('../../src/tracking/BackgroundRouteTracking').then(({ stopRouteTracking }) => {
      stopRouteTracking();
    }).catch(() => {});
    // Snapshot the current active stop so the driver can resume here if they
    // restart this same route later. We key by stop ID (not numeric legIndex)
    // because the backend's /api/navigation rebuilds legs from the NEW GPS on
    // resume — so a legIndex captured "before" can point at a completely
    // different stop "after" (collapsed waypoints, different origin). Stop ID
    // is stable across rebuilds.
    const activeLeg = navigationDataRef.current?.legs?.[currentLegIndexRef.current];
    const activeStopId = activeLeg?.to_stop?.id ?? null;
    lastNavLegIndexRef.current = currentLegIndexRef.current;
    lastNavActiveStopIdRef.current = activeStopId;
    lastNavRouteSignatureRef.current = stops.map((s: any) => s.id).join('|');
    // Persist across app-kill restarts too — 48 h freshness window enforced
    // on hydrate so we never surprise the driver with a stale resume.
    AsyncStorage.setItem(
      'pathpilot:navResume',
      JSON.stringify({
        signature: lastNavRouteSignatureRef.current,
        legIndex: lastNavLegIndexRef.current,
        activeStopId: lastNavActiveStopIdRef.current,
        savedAt: Date.now(),
      }),
    ).catch(() => { /* best-effort — resume still works in-memory this session */ });
    stopLiveTracking();
    setViewMode('planning');
    setIsNavigating(false);
    setSidebarExpanded(true);
    
    Animated.spring(sidebarAnim, {
      toValue: 1,
      friction: 8,
      tension: 65,
      useNativeDriver: false,
    }).start();
  };

  const startLiveTracking = async () => {
    try {
      setIsNavigating(true);
      setTraveledPath([]); // Reset traveled path when starting
      setUndoHistory([]); // Reset undo history
      setClusterOverlays([]); // Clear cluster overlays during driving

      // Compass subscription — gives us a heading immediately, even while
      // stationary. We store the value in a REF ONLY (no setState) so
      // magnetometer noise (~10 Hz) doesn't trigger re-renders / camera
      // easeTo storms. The GPS watcher below (~1.25 Hz) reads this ref
      // each tick and uses it as fallback heading when GPS course is
      // invalid. Yields to GPS course-over-ground once the driver is
      // confidently moving (hasGpsCourseRef set in the position watcher
      // below). This is what makes the puck/map rotate at standstill the
      // way Google Maps does, without the flicker.
      hasGpsCourseRef.current = false;
      try {
        headingSubscription.current = await Location.watchHeadingAsync((h) => {
          if (hasGpsCourseRef.current) return; // GPS is authoritative once moving
          const compass = (h.trueHeading >= 0 ? h.trueHeading : h.magHeading) ?? 0;
          compassHeadingRef.current = compass;
          // NO setState here — GPS watcher tick will pick this up.
        });
      } catch (e) {
        console.log('[compass] watchHeadingAsync failed:', e);
      }

      locationSubscription.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 400,
          distanceInterval: 0, // fire on time interval even when stationary
        },
        (location) => {
          // ── Freeze-on-stop bearing (Google-Maps-style) ──
          // GPS course-over-ground is meaningless when the vehicle is stationary
          // (it's often null/-1/random on various devices). Without this, the
          // puck flips to north (`|| 0`) every time the driver stops at a light,
          // and the next compass tick rotates the camera off the road.
          // Only accept a new heading when we're confidently moving.
          const MOVING_SPEED_MPS = 1.4;
          const rawSpeed = Math.max(0, location.coords.speed ?? 0);
          const rawGpsHeading = location.coords.heading;
          const hasValidCourse =
            rawSpeed >= MOVING_SPEED_MPS &&
            typeof rawGpsHeading === 'number' &&
            rawGpsHeading >= 0;
          // Once GPS gives us a real course, stop accepting compass updates —
          // GPS course-over-ground is more accurate for in-vehicle nav.
          if (hasValidCourse) hasGpsCourseRef.current = true;
          const lastHeading = currentLocationRef.current?.heading ?? compassHeadingRef.current;
          // Pick target heading: GPS when moving, compass when not.
          // No JS-side smoothing here — the WebView-side `animateBearing`
          // lerp (~60 fps in DeliveryMap.native.tsx) is the single source
          // of visual smoothness. Adding a second filter caused the puck to
          // visibly lag the GPS truth.
          const newHeading = hasValidCourse
            ? (rawGpsHeading as number)
            : compassHeadingRef.current;

          const newLocation = {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            heading: newHeading,
          };

          // GPS data flows to map via driverLocation prop — no injection needed

          setCurrentLocation(newLocation);
          currentLocationRef.current = newLocation;
          setCurrentSpeed(Math.round((location.coords.speed || 0) * 3.6));
          
          // Add to traveled path
          setTraveledPath(prev => {
            const newPoint = { lng: newLocation.longitude, lat: newLocation.latitude };
            // Only add if moved at least 10 meters from last point
            if (prev.length === 0) return [newPoint];
            const lastPoint = prev[prev.length - 1];
            const dist = calculateDistance(lastPoint.lat, lastPoint.lng, newPoint.lat, newPoint.lng);
            if (dist > 10) {
              const updated = [...prev, newPoint];
              // Decimate when the breadcrumb crosses ~5000 points (≈50 km
              // of driving). Keeps memory bounded over multi-day routes
              // and stops the WebView's `traveled` source from accumulating
              // unbounded history. Decimation halves the older 40 % of the
              // tail; recent driving stays at full ~10 m fidelity.
              // Returning a SHORTER array trips the shrink-detection branch
              // in DeliveryMap.native.tsx's `lastSentTraveledLenRef`, which
              // falls back to a full `updateTraveled` re-ship — exactly
              // what we want so the WebView's source mirrors JS state.
              const final = updated.length > BREADCRUMB_DECIMATE_THRESHOLD
                ? decimateBreadcrumb(updated)
                : updated;
              // Debounced disk persistence: write every ~30 GPS fixes
              // (≈30 × 10 m = 300 m driven). Fire-and-forget so the
              // hot location-update path never awaits AsyncStorage.
              // 30 was picked because at typical urban speeds (40 km/h)
              // it lands a save roughly every ~30 s — frequent enough
              // that a battery-killed app loses < 30 s of trail, rare
              // enough that disk I/O is invisible. Counter is a ref so
              // it survives renders without becoming a state-dep cycle.
              breadcrumbSaveCounterRef.current += 1;
              if (breadcrumbSaveCounterRef.current >= 30) {
                breadcrumbSaveCounterRef.current = 0;
                saveBreadcrumb(user?.user_id, final);
              }
              return final;
            }
            return prev;
          });
          
          updateLiveRouteRef.current?.(newLocation);
        }
      );
      
      speakInstruction('Navigation started. Follow the route to your first stop.');
    } catch (error) {
      console.error('Live tracking error:', error);
      Alert.alert('Error', 'Failed to start live navigation');
    }
  };

  const stopLiveTracking = () => {
    setIsNavigating(false);
    initialLocationRef.current = null;
    if (locationSubscription.current) {
      try {
        locationSubscription.current.remove();
      } catch (e) {
        console.log('Cleanup:', e);
      }
      locationSubscription.current = null;
    }
    if (headingSubscription.current) {
      try {
        headingSubscription.current.remove();
      } catch (e) {
        console.log('Cleanup heading:', e);
      }
      headingSubscription.current = null;
    }
    hasGpsCourseRef.current = false;
    Speech.stop();
    // Clear persisted breadcrumb so a fresh route starts blank instead
    // of resuming from yesterday's tail. Reset the debounce counter so
    // the first save in the next session lands at the expected ~30 fixes.
    breadcrumbSaveCounterRef.current = 0;
    clearBreadcrumb(user?.user_id);
  };

  // Snap a GPS point to the nearest position on the active route polyline.
  // Returns the snapped [lng, lat] or the original if too far from the route (>100m).
  const snapToRouteGeometry = (lng: number, lat: number): { lng: number; lat: number } => {
    const coords = navigationData?.geometry?.coordinates;
    if (!coords || coords.length < 2) return { lng, lat };

    let minDistSq = Infinity;
    let snappedLng = lng;
    let snappedLat = lat;

    for (let i = 0; i < coords.length - 1; i++) {
      const ax = coords[i][0], ay = coords[i][1];
      const bx = coords[i + 1][0], by = coords[i + 1][1];
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;

      // Project point onto segment, clamped to [0,1]
      const t = Math.max(0, Math.min(1, ((lng - ax) * dx + (lat - ay) * dy) / lenSq));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const dSq = (lng - px) * (lng - px) + (lat - py) * (lat - py);

      if (dSq < minDistSq) {
        minDistSq = dSq;
        snappedLng = px;
        snappedLat = py;
      }
    }

    // If snapped point is > ~100m from raw GPS, don't snap (driver may have left the route)
    // Rough conversion: 0.001° ≈ 111m at equator
    if (Math.sqrt(minDistSq) > 0.001) return { lng, lat };

    return { lng: snappedLng, lat: snappedLat };
  };

  const updateLiveRoute = async (location: { latitude: number; longitude: number }) => {
    if (!navigationData) {
      console.log('[LiveRoute] Skipped: navData=', !!navigationData);
      return;
    }
    
    const currentLeg = navigationData.legs[currentLegIndex];
    if (!currentLeg?.to_stop) {
      console.log('[LiveRoute] No current leg or to_stop');
      return;
    }
    
    try {
      // Snap GPS to the active route geometry before calling Directions API
      // This prevents Mapbox from snapping to parallel streets or service roads
      const snapped = snapToRouteGeometry(location.longitude, location.latitude);
      const coordinates = `${snapped.lng},${snapped.lat};${currentLeg.to_stop.longitude},${currentLeg.to_stop.latitude}`;
      console.log('[LiveRoute] Fetching from API (snapped):', coordinates);
      
      const response = await fetch(`${BACKEND_URL}/api/directions?coordinates=${coordinates}`);
      console.log('[LiveRoute] Response status:', response.status);
      
      if (response.ok) {
        const data = await response.json();
        console.log('[LiveRoute] Got data, geometry coords:', data.geometry?.coordinates?.length || 0);
        
        // Keep exactly one visible segment: current position -> active waypoint
        
        setLiveRoute(data);
        
        // Route data flows to map via routeCoordinates prop — no injection needed
        
        if (data.steps && data.steps.length > 0 && voiceEnabled) {
          const nextStep = data.steps[0];
          const instruction = nextStep.voice_instruction || nextStep.instruction;
          const distance: number = nextStep.distance ?? 0;

          if (instruction) {
            // ── Helper: format distance for speech (full words, rounded) ──────
            const fmtVoice = (m: number): string => {
              if (m >= 1000) {
                const km = Math.round(m / 500) * 0.5;
                return km === 1 ? '1 kilometre' : `${km} kilometres`;
              }
              if (m >= 500) return `${Math.round(m / 100) * 100} metres`;
              return `${Math.max(50, Math.round(m / 50) * 50)} metres`;
            };

            // ── Speed-scaled thresholds (Waze/Google Maps standard) ──────────
            const spd = currentSpeed; // km/h, already in state
            let earlyAt: number, prepareAt: number, nowAt: number;
            if (spd > 90)       { earlyAt = 1500; prepareAt = 600; nowAt = 80; }
            else if (spd > 60)  { earlyAt = 900;  prepareAt = 350; nowAt = 60; }
            else if (spd > 30)  { earlyAt = 600;  prepareAt = 250; nowAt = 50; }
            else                { earlyAt = 300;  prepareAt = 120; nowAt = 35; }

            // ── Reset per-step state when instruction changes ────────────────
            if (voiceAnnouncementRef.current.stepKey !== instruction) {
              voiceAnnouncementRef.current = {
                stepKey: instruction,
                spokenEarly: false,
                spokenPrepare: false,
                spokenNow: false,
              };
            }

            const ann = voiceAnnouncementRef.current;

            // Stage 3 — NOW  (highest priority, fire once)
            if (!ann.spokenNow && distance <= nowAt) {
              speakInstruction(instruction);
              ann.spokenNow = true;
              ann.spokenPrepare = true; // suppress lower-priority stages
              ann.spokenEarly = true;

            // Stage 2 — PREPARE  (~300m, fire once)
            } else if (!ann.spokenPrepare && distance <= prepareAt) {
              speakInstruction(`In ${fmtVoice(distance)}, ${instruction}`);
              ann.spokenPrepare = true;
              ann.spokenEarly = true;

            // Stage 1 — EARLY  (~1km, fire once)
            } else if (!ann.spokenEarly && distance <= earlyAt) {
              speakInstruction(`In ${fmtVoice(distance)}, ${instruction}`);
              ann.spokenEarly = true;
            }
          }
        }
      }
    } catch (error) {
      console.error('Live route error:', error);
    }
  };

  useEffect(() => {
    updateLiveRouteRef.current = updateLiveRoute;
  }, [updateLiveRoute]);

  // Mirror a stop's completion flag into navigationData.stops so the map (which in
  // driving mode reads from navigationData.stops, not the store) immediately flips
  // the pin icon to grey "delivered" (or back to red) without waiting for a refetch.
  const syncNavCompletion = useCallback((stopId: string, completed: boolean) => {
    setNavigationData((prev) =>
      prev
        ? {
            ...prev,
            stops: prev.stops.map((s: any) =>
              s.id === stopId ? { ...s, completed } : s,
            ),
          }
        : prev,
    );
  }, []);

  const handleArrivalAtStop = async () => {
    const currentLeg = navigationData?.legs[currentLegIndex];
    if (!currentLeg?.to_stop) return;
    
    // Notification when user arrives within 50m (no auto-complete)
    speakInstruction(`You have arrived at ${currentLeg.to_stop.name || 'your destination'}.`);
    
    // Haptic feedback for arrival
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleMarkDelivered = async () => {
    // RESOLVE TARGET STOP — robust to navigationData being null/empty/out-of-bounds.
    // Previous code did `if (!currentLeg?.to_stop) return;` which SILENTLY swallowed the
    // tap when the user advanced past the last leg, when the leg shape didn't include a
    // to_stop, or when navigationData hadn't refreshed yet. Failed/Skip have no such
    // guard — that's why those advanced the route while Delivered just ate the press.
    //
    // Fallback chain (most-specific to most-permissive):
    //   1. Current leg's `to_stop` (the original happy path).
    //   2. First uncompleted stop in the stops array (driver intent: "mark THIS stop").
    //   3. Bail loudly with a console warning so future regressions are debuggable
    //      instead of looking like a dead button.
    const currentLeg = navigationData?.legs[currentLegIndex];
    const fallbackStop = stops.find((s) => !s.completed);
    const targetStop = currentLeg?.to_stop ?? fallbackStop;
    if (!targetStop) {
      console.warn('[handleMarkDelivered] no target stop available', {
        currentLegIndex,
        legsLen: navigationData?.legs?.length,
        uncompletedCount: stops.filter((s) => !s.completed).length,
      });
      return;
    }
    const stopId = targetStop.id;

    // Save to undo history
    setUndoHistory(prev => [...prev, {
      type: 'delivered',
      legIndex: currentLegIndex,
      stopId,
    }]);

    // Fire-and-forget — the store does an optimistic update then PATCHes the server in
    // the background (auto-reverts on failure). Awaiting added ~200-500ms of pure UI lag
    // to every tap of the Delivered / green-tick button.
    markPending(stopId, true);
    // `view_mode` rides along so the backend can tell whether the driver
    // tapped Delivered from the immersive nav cockpit (where geofence is
    // enabled) vs. the planning list (where it never had a chance to fire).
    // Critical signal for diagnosing the geofence_rate=0% finding from the
    // archive-telemetry rollup.
    const gps = currentLocation
      ? {
          lat: currentLocation.latitude,
          lng: currentLocation.longitude,
          view_mode: viewMode,
        }
      : { view_mode: viewMode };
    Promise.resolve(completeStop(stopId, gps))
      .catch((e: any) => console.warn('[handleMarkDelivered] completeStop rejected', e))
      .finally(() => markPending(stopId, false));
    syncNavCompletion(stopId, true);

    // Was this stop one of several at the same doorstep? If so, count how
    // many other parcels are still pending at this exact lat/lng and warn
    // the driver loudly BEFORE the camera starts swinging toward the next
    // address. Without this it's very easy for a driver to deliver one of
    // two parcels, hear "Moving to next stop", and walk back to the van
    // leaving the second parcel behind.
    const justDeliveredKey = `${Number(targetStop.latitude).toFixed(5)},${Number(targetStop.longitude).toFixed(5)}`;
    const remainingHere = stops.filter((s: any) => {
      if (s.id === stopId) return false;
      if (s.completed) return false;
      if (s.is_current_location) return false;
      return `${Number(s.latitude).toFixed(5)},${Number(s.longitude).toFixed(5)}` === justDeliveredKey;
    }).length;

    if (remainingHere > 0) {
      const word = remainingHere === 1 ? 'parcel' : 'parcels';
      speakInstruction(`Stay here. ${remainingHere} more ${word} at this address.`);
      setResumeToast(`⚠ STAY HERE — ${remainingHere} more ${word} at this address`);
    } else {
      speakInstruction('Delivered! Moving to next stop.');
    }

    moveToNextStop();
  };

  const handleMarkFailed = () => {
    const currentLeg = navigationData?.legs[currentLegIndex];
    
    // Save to undo history
    setUndoHistory(prev => [...prev, { 
      type: 'failed', 
      legIndex: currentLegIndex,
      stopId: currentLeg?.to_stop?.id
    }]);
    
    speakInstruction('Marked as failed. Moving to next stop.');
    moveToNextStop();
  };

  // NEW: Skip Stop function
  const handleSkipStop = () => {
    // Save to undo history
    setUndoHistory(prev => [...prev, { 
      type: 'skipped', 
      legIndex: currentLegIndex 
    }]);
    
    speakInstruction('Skipping this stop.');
    moveToNextStop();
  };

  // NEW: Undo function
  const handleUndo = async () => {
    if (undoHistory.length === 0) {
      Alert.alert('Nothing to undo', 'No recent actions to undo.');
      return;
    }
    
    const lastAction = undoHistory[undoHistory.length - 1];
    
    // Remove from undo history
    setUndoHistory(prev => prev.slice(0, -1));
    
    // If it was a delivered action, uncomplete the stop using the store
    if (lastAction.type === 'delivered' && lastAction.stopId) {
      await uncompleteStop(lastAction.stopId);
      syncNavCompletion(lastAction.stopId, false);
    }

    // Navigate back to the correct leg by finding the leg that matches the stop ID
    if (navigationData?.legs && lastAction.stopId) {
      const targetLegIdx = navigationData.legs.findIndex(
        (leg: any) => leg.to_stop?.id === lastAction.stopId
      );
      if (targetLegIdx >= 0) {
        setCurrentLegIndex(targetLegIdx);
        progressObserverRef.current.setLegIndex(targetLegIdx);
      } else {
        // Fallback to saved index if leg not found (shouldn't happen)
        setCurrentLegIndex(lastAction.legIndex);
        progressObserverRef.current.setLegIndex(lastAction.legIndex);
      }
    } else {
      setCurrentLegIndex(lastAction.legIndex);
      progressObserverRef.current.setLegIndex(lastAction.legIndex);
    }
    
    speakInstruction('Undone. Returning to previous stop.');
  };

  // Reroute current segment only
  const handleReroute = async () => {
    if (!currentLocation) {
      Alert.alert('Location Error', 'Cannot determine your current location.');
      return;
    }
    
    setIsRerouting(true);
    speakInstruction('Recalculating route...');
    
    try {
      const activeLeg = navigationData?.legs[currentLegIndex];
      const activeStop = activeLeg?.to_stop;

      if (!activeStop) {
        Alert.alert('No Active Stop', 'No active waypoint to route to.');
        setIsRerouting(false);
        return;
      }
      
      // Single segment only: current location -> active waypoint
      const coordinates = [
        `${currentLocation.longitude},${currentLocation.latitude}`,
        `${activeStop.longitude},${activeStop.latitude}`
      ].join(';');
      
      const response = await fetch(`${BACKEND_URL}/api/directions?coordinates=${coordinates}`);
      if (response.ok) {
        const data = await response.json();
        setLiveRoute(data);
        speakInstruction('Route updated. Continue to your next stop.');
      }
    } catch (error) {
      console.error('Reroute error:', error);
      Alert.alert('Reroute Failed', 'Could not recalculate route.');
    } finally {
      setIsRerouting(false);
    }
  };

  const handleShowRouteOverview = useCallback(() => {
    if (viewMode !== 'navigating') return;
    if (!mapRef.current || !isMapReady) {
      Alert.alert('Map not ready', 'Please wait for the map to finish loading.');
      return;
    }

    // Compute bounds from all available coordinates
    const allStops = navigationData?.stops || stops;
    const lngs = allStops.filter((s: any) => s.longitude).map((s: any) => s.longitude);
    const lats = allStops.filter((s: any) => s.latitude).map((s: any) => s.latitude);
    
    if (lngs.length < 2) {
      Alert.alert('No route available', 'Start navigation to view a route overview.');
      return;
    }

    mapRef.current.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      80,
    );

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [viewMode, isMapReady, navigationData, stops]);

  const moveToNextStop = async () => {
    if (currentLegIndex < (navigationData?.legs.length || 0) - 1) {
      const nextIndex = currentLegIndex + 1;
      const nav = navigationData;

      // ── Same-doorstep short-circuit ────────────────────────────────────
      // When the optimizer (PyVRP coord-clustering) places multiple parcels
      // for the SAME address consecutively, the geographic move from the
      // completed stop to the next leg is zero. Re-fetching the OSRM route,
      // recentring the camera, and re-announcing "Next: <same address>"
      // would feel jittery — the map would briefly tilt + re-fit + re-zoom
      // for a 0-metre move. Detect that case and only advance the leg index
      // (the on-screen banner / progress dots / Delivered button all
      // re-render off `currentLegIndex` regardless).
      const completedStop = nav?.legs[currentLegIndex]?.to_stop;
      const nextStop = nav?.legs[nextIndex]?.to_stop;
      const sameDoorstep =
        !!completedStop &&
        !!nextStop &&
        Number(completedStop.latitude).toFixed(5) === Number(nextStop.latitude).toFixed(5) &&
        Number(completedStop.longitude).toFixed(5) === Number(nextStop.longitude).toFixed(5);

      setCurrentLegIndex(nextIndex);
      progressObserverRef.current.setLegIndex(nextIndex);

      if (sameDoorstep) {
        // No GPS move, no camera animation, no duplicate voice prompt. The
        // stay-here amber toast / banner already informed the driver. Done.
        return;
      }

      // ── setRoutes() equivalent: rebuild route from current GPS → remaining stops ──
      if (nav && currentLocation) {
        const remainingWaypoints = nav.legs
          .slice(nextIndex, nextIndex + 1)
          .filter((leg) => leg.to_stop)
          .map((leg) => ({
            longitude: leg.to_stop!.longitude,
            latitude: leg.to_stop!.latitude,
          }));
        
        // Fetch fresh route from current position → remaining waypoints
        const resetPayload = await progressObserverRef.current.fetchResetRoute(
          currentLocation,
          remainingWaypoints
        );
        
        // Update React state — DeliveryMap picks up changes via props
        if (resetPayload?.liveRoute) {
          setLiveRoute(resetPayload.liveRoute);
        }
        
        // Camera target: the next stop
        const nextLeg = nav.legs[nextIndex];
        setTimeout(() => {
          if (nextLeg?.to_stop) {
            speakInstruction(`Next: ${nextLeg.to_stop.name || nextLeg.to_stop.address}`);
          }
        }, 500);
      } else {
        // Fallback: no GPS or map ref available — just announce
        setTimeout(() => {
          const nextLeg = navigationData?.legs[nextIndex];
          if (nextLeg?.to_stop) {
            speakInstruction(`Next: ${nextLeg.to_stop.name || nextLeg.to_stop.address}`);
          }
        }, 500);
      }
    } else {
      speakInstruction('All stops completed! Great job!');
      stopNavigation();
    }
  };

  const speakInstruction = (text: string) => {
    if (!voiceEnabled) return;
    Speech.stop();
    Speech.speak(text, {
      language: 'en',
      pitch: 1.0,
      rate: 0.95,
    });
  };

  // Extract phone number from mobile_number field or notes
  // Handle calling customer
  const handleCallCustomer = async () => {
    const currentStop = currentLeg?.to_stop;
    const phoneNumber = extractPhoneNumber(currentStop);
    
    if (!phoneNumber) {
      Alert.alert(
        'No Phone Number',
        'No phone number found for this stop. Make sure to map the "Customer Number" column when importing from XLS.',
        [{ text: 'OK' }]
      );
      return;
    }
    
    try {
      const phoneUrl = Platform.OS === 'ios' 
        ? `tel:${phoneNumber}` 
        : `tel:${phoneNumber}`;
      
      const canOpen = await Linking.canOpenURL(phoneUrl);
      if (canOpen) {
        await Linking.openURL(phoneUrl);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } else {
        Alert.alert('Error', 'Unable to make phone calls on this device');
      }
    } catch (error) {
      console.error('Call error:', error);
      Alert.alert('Error', 'Failed to initiate call');
    }
  };

  // Handle sharing ETA with customer
  const handleShareETA = async () => {
    const currentStop = currentLeg?.to_stop;
    const eta = getETA();
    const stopName = currentStop?.name || currentStop?.address || 'your location';
    const distance = liveRoute ? formatDistance(liveRoute.distance) : '';
    
    const message = `Hi! I'm on my way to ${stopName}. My estimated arrival time is ${eta}${distance ? ` (${distance} away)` : ''}. See you soon!`;
    
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const result = await Share.share({
        message,
        title: 'Share ETA',
      });
      
      if (result.action === Share.sharedAction) {
        // Successfully shared
      }
    } catch (error) {
      console.error('Share error:', error);
      Alert.alert('Error', 'Failed to share ETA');
    }
  };

  const handleSaveStopAddressOnly = async () => {
    const selectedStopId = selectedStopModal?.id;
    const nextAddress = editingStopAddress.trim();

    if (!selectedStopId) {
      Alert.alert('No stop selected', 'Please reopen stop details and try again.');
      return;
    }
    if (!nextAddress) {
      Alert.alert('Address required', 'Please enter an address before saving.');
      return;
    }

    const metadata = {
      ...(selectedStopModal?.geocode_metadata || {}),
      geocode_needs_fix: true,
      geocode_status: 'pending_regeocode',
      geocode_issue: 'Address updated manually. Re-geocode required.',
      import_original_address: nextAddress,
    };

    setSavingStopAddress(true);
    try {
      await updateStop(selectedStopId, {
        address: nextAddress,
        geocode_metadata: metadata,
      });

      setSelectedStopModal((prev: any) => {
        if (!prev) return prev;
        return {
          ...prev,
          address: nextAddress,
          geocode_metadata: metadata,
        };
      });

      await fetchStops();
      Alert.alert('Address saved', 'Address updated. Tap Re-geocode to refresh location coordinates.');
    } catch (error) {
      console.error('Save stop address error:', error);
      Alert.alert('Update failed', 'Could not save the updated address.');
    } finally {
      setSavingStopAddress(false);
    }
  };

  const handleSaveStopNotes = async () => {
    const selectedStopId = selectedStopModal?.id;
    if (!selectedStopId) {
      Alert.alert('No stop selected', 'Please reopen stop details and try again.');
      return;
    }

    const nextNotes = editingStopNotes.trim();
    setSavingStopNotes(true);
    try {
      await updateStop(selectedStopId, { notes: nextNotes });
      setSelectedStopModal((prev: any) => (prev ? { ...prev, notes: nextNotes } : prev));
      await fetchStops();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('Save stop notes error:', error);
      Alert.alert('Update failed', 'Could not save the note.');
    } finally {
      setSavingStopNotes(false);
    }
  };

  const handleRegeocodeSelectedStop = async () => {
    const selectedStopId = selectedStopModal?.id;
    if (!selectedStopId) {
      Alert.alert('No stop selected', 'Please reopen stop details and try again.');
      return;
    }

    setRegeocodingStop(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${BACKEND_URL}/api/stops/${selectedStopId}/regeocode`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address: editingStopAddress.trim() || selectedStopModal?.address || '' }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.detail || 'Failed to re-geocode address');
      }

      if (data?.stop) {
        setSelectedStopModal(data.stop);
      }
      await fetchStops();

      if (data?.geocoded) {
        Alert.alert('Geocoded', data?.message || 'Stop location updated successfully.');
      } else {
        Alert.alert('Geocode warning', data?.message || 'Could not geocode address. Previous coordinates were kept.');
      }
    } catch (error: any) {
      console.error('Re-geocode stop error:', error);
      Alert.alert('Re-geocode failed', error?.message || 'Could not re-geocode this stop.');
    } finally {
      setRegeocodingStop(false);
    }
  };

  const handleDeleteSelectedStop = async () => {
    const selectedStopId = selectedStopModal?.id;
    if (!selectedStopId) {
      Alert.alert('No stop selected', 'Please reopen stop details and try again.');
      return;
    }

    setDeletingStop(true);
    try {
      const remainingStopsAfterDelete = stops
        .filter((s) => s.id !== selectedStopId)
        .sort((a, b) => (a.order || 0) - (b.order || 0));

      await deleteStop(selectedStopId);

      // Keep remaining order contiguous
      if (remainingStopsAfterDelete.length > 0) {
        await reorderStops(remainingStopsAfterDelete.map((s) => s.id));
      }

      // If navigating, rebuild route immediately from current location.
      if (viewMode === 'navigating') {
        if (remainingStopsAfterDelete.length === 0) {
          setSelectedStopModal(null);
          setNavigationData(null);
          setLiveRoute(null);
          stopNavigation();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          return;
        }

        await fetchNavigationData(currentLocation || null);
        setCurrentLegIndex(0);
        progressObserverRef.current.resetToFirstLeg();
        speakInstruction('Stop deleted. Updated route loaded.');
      }

      await fetchStops();
      setSelectedStopModal(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('Delete stop error:', error);
      Alert.alert('Delete failed', 'Could not delete this stop. Please try again.');
    } finally {
      setDeletingStop(false);
    }
  };

  // Handle drag and drop reorder
  const handleDragEnd = async ({ data }: { data: Stop[] }) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    // Update local state immediately for smooth UX
    const newOrder = data.map(stop => stop.id);
    
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${BACKEND_URL}/api/stops/reorder`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stop_ids: newOrder }),
      });
      
      if (response.ok) {
        await fetchStops();
        fetchRouteDirections();
      } else {
        Alert.alert('Error', 'Failed to reorder stops');
      }
    } catch (error) {
      console.error('Reorder error:', error);
      Alert.alert('Error', 'Failed to save new order');
    }
  };

  const getETA = () => {
    if (!liveRoute) return '--:--';
    const now = new Date();
    const eta = new Date(now.getTime() + (liveRoute.duration * 1000));
    return eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Generate consistent color for each suburb
  const completedCount = stops.filter(s => s.completed).length;

  // ── Route completion celebration ──
  // When the driver finishes the final stop, animate the gray "completed" polyline
  // settling into success-green instead of letting it vanish. Gentle morale boost
  // for long routes; no disruptive popups.
  const celebrationFiredRef = useRef(false);
  const routeSessionStartRef = useRef<number | null>(null);
  const [celebrationStats, setCelebrationStats] = useState<{
    stops: number; distanceKm: number; durationMs: number;
  } | null>(null);
  const celebrationCardAnim = useRef(new Animated.Value(0)).current;

  // ── Paused indicator ──
  // Shows a subtle "Paused · M:SS" pill after the vehicle has been stationary
  // for ≥10 s while navigating. Purely informational; does NOT rotate the
  // camera or puck (that bug was already fixed — see useNavigationCamera).
  const PAUSED_SPEED_THRESHOLD_KMH = 3; // below this is considered "stopped"
  const PAUSED_SHOW_AFTER_MS = 10_000;  // wait 10 s before surfacing the pill
  const pausedSinceRef = useRef<number | null>(null);
  const [pausedSeconds, setPausedSeconds] = useState<number | null>(null);
  const pausedPillOpacity = useRef(new Animated.Value(0)).current;

  // ── Background-sync indicator ──
  // Stops whose PATCH /complete (or /uncomplete) hasn't finished yet. Drives a tiny
  // orange dot on the pin so the driver knows an action is still syncing — useful
  // when offline/weak signal, where the optimistic flip could be silently reverted.
  const [pendingSyncIds, setPendingSyncIds] = useState<Set<string>>(new Set());
  const markPending = useCallback((id: string, pending: boolean) => {
    setPendingSyncIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  // Hydrate queued IDs on mount + every 3s so pins that were queued offline show the
  // orange dot even across app restarts. When `flush()` drains the queue (inside the
  // store), this tick picks up the new empty state and the dots vanish.
  useEffect(() => {
    let cancelled = false;
    const syncQueued = async () => {
      const [queued, actions] = await Promise.all([getOfflineQueuedIds(), getQueuedActions()]);
      if (cancelled) return;
      setPendingSyncIds((prev) => {
        // Union of (currently-in-flight on this tab) + (persisted queue from storage)
        const merged = new Set(prev);
        queued.forEach((id) => merged.add(id));
        // Drop any ids that are in `prev` but not currently in flight AND not queued
        [...prev].forEach((id) => { if (!queued.has(id)) merged.delete(id); });
        return merged;
      });
      setQueuedActions(actions);
    };
    syncQueued();
    const t = setInterval(syncQueued, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Offline state + queue counter for the persistent banner. Updated via the same
  // NetInfo subscription used for reconnect drain; `queuedCount` is sourced from the
  // 3-second hydration tick above so it self-corrects after flushes.
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [bannerExpanded, setBannerExpanded] = useState<boolean>(false);
  const [queuedActions, setQueuedActions] = useState<QueueAction[]>([]);
  const [isRetrying, setIsRetrying] = useState<boolean>(false);
  // Snapshot of the most recently dismissed action so we can offer "Undo" for 5s.
  const [undoToast, setUndoToast] = useState<{ action: QueueAction; label: string } | null>(null);
  const undoToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [resumeToast, setResumeToast] = useState<string | null>(null);
  const resumeToastOpacity = useRef(new Animated.Value(0)).current;
  const resumeToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Large centred overlay — a beat of "we restored stop #N" that stays up
  // just long enough for the driver's eye to find the matching pin before
  // the autocam pitches the 3D view. Clears after 400ms.
  const [resumingOverlayPin, setResumingOverlayPin] = useState<number | null>(null);
  const resumingOverlayOpacity = useRef(new Animated.Value(0)).current;
  const resumingOverlayScale = useRef(new Animated.Value(0.92)).current;
  const resumingOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoToastOpacity = useRef(new Animated.Value(0)).current;
  // Clear any pending timer on unmount
  useEffect(() => () => {
    if (undoToastTimerRef.current) clearTimeout(undoToastTimerRef.current);
    if (resumeToastTimerRef.current) clearTimeout(resumeToastTimerRef.current);
    if (resumingOverlayTimerRef.current) clearTimeout(resumingOverlayTimerRef.current);
  }, []);
  // Fade the toast in/out when it appears/disappears
  useEffect(() => {
    Animated.timing(undoToastOpacity, {
      toValue: undoToast ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [undoToast, undoToastOpacity]);
  // Resume toast: 1.5s green pill confirming the driver's active stop was
  // restored. Fades in fast, lingers, fades out. Auto-clears.
  useEffect(() => {
    Animated.timing(resumeToastOpacity, {
      toValue: resumeToast ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
    if (resumeToast) {
      if (resumeToastTimerRef.current) clearTimeout(resumeToastTimerRef.current);
      // Stay-here / multi-parcel warnings need ~3x longer than the green
      // "Resumed" pill so the driver actually reads it before walking off.
      const isWarning = resumeToast.startsWith('⚠');
      resumeToastTimerRef.current = setTimeout(() => setResumeToast(null), isWarning ? 4500 : 1500);
    }
  }, [resumeToast, resumeToastOpacity]);

  // Centred "Resuming at stop #N" overlay — a 400 ms visual anchor that
  // gives the driver a moment to spot the matching pin BEFORE autocam
  // pitches the 3D view. Runs in parallel with the small top pill.
  useEffect(() => {
    if (resumingOverlayPin == null) return;
    resumingOverlayOpacity.setValue(0);
    resumingOverlayScale.setValue(0.92);
    Animated.parallel([
      Animated.timing(resumingOverlayOpacity, {
        toValue: 1, duration: 120, useNativeDriver: true,
      }),
      Animated.spring(resumingOverlayScale, {
        toValue: 1, friction: 6, tension: 90, useNativeDriver: true,
      }),
    ]).start();
    if (resumingOverlayTimerRef.current) clearTimeout(resumingOverlayTimerRef.current);
    resumingOverlayTimerRef.current = setTimeout(() => {
      Animated.timing(resumingOverlayOpacity, {
        toValue: 0, duration: 240, useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setResumingOverlayPin(null);
      });
    }, 400);
  }, [resumingOverlayPin, resumingOverlayOpacity, resumingOverlayScale]);
  const queuedCount = pendingSyncIds.size;

  // Instant-reconnect queue drain. NetInfo fires whenever connectivity changes; the
  // moment the device goes from offline → online we flush any queued stop actions,
  // then refetch stops so the UI syncs with the server's authoritative state. Makes
  // the offline→online catch-up feel instant (2-5s faster than waiting for the next
  // successful API call to trigger `flush()` piggyback).
  useEffect(() => {
    let wasReachable: boolean | null = null;
    const unsub = NetInfo.addEventListener((state) => {
      const reachable = state.isConnected === true && state.isInternetReachable !== false;
      setIsOnline(reachable);
      if (reachable && wasReachable === false) {
        (async () => {
          const drained = await flushSyncQueue();
          if (drained > 0) {
            fetchStops();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
        })();
      }
      wasReachable = reachable;
    });
    return () => unsub();
  }, [flushSyncQueue, fetchStops]);

  // Start session clock at first completion of a route
  useEffect(() => {
    if (completedCount > 0 && routeSessionStartRef.current === null) {
      routeSessionStartRef.current = Date.now();
    } else if (completedCount === 0) {
      routeSessionStartRef.current = null;
    }
  }, [completedCount]);

  useEffect(() => {
    const allDone = stops.length > 0 && completedCount === stops.length;
    if (allDone && !celebrationFiredRef.current) {
      celebrationFiredRef.current = true;
      sendToMap({ type: 'celebrateCompletion' });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Compute end-of-route stats and slide in the card
      const durationMs = routeSessionStartRef.current
        ? Date.now() - routeSessionStartRef.current
        : 0;
      const distanceKm = routeStats?.distance ? routeStats.distance / 1000 : 0;
      setCelebrationStats({ stops: stops.length, distanceKm, durationMs });
      celebrationCardAnim.setValue(0);
      Animated.sequence([
        Animated.spring(celebrationCardAnim, { toValue: 1, useNativeDriver: true, friction: 7, tension: 60 }),
        Animated.delay(4500),
        Animated.timing(celebrationCardAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start(() => setCelebrationStats(null));
    } else if (!allDone && celebrationFiredRef.current) {
      // Reset on undo / new stops added so the next completion also celebrates.
      celebrationFiredRef.current = false;
      sendToMap({ type: 'resetCompletionCelebration' });
    }
  }, [completedCount, stops.length, sendToMap, routeStats, celebrationCardAnim]);

  // Refresh the ML data-pipeline health badge: once on mount and after every
  // change in completedCount (a /complete write is the only event that grows
  // service-time pairs). Auth or network failure → keep the badge hidden.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await AsyncStorage.getItem('session_token');
        if (!token) return;
        const resp = await fetch(`${BACKEND_URL}/api/admin/ml/readiness`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!resp.ok) return;
        const j = await resp.json();
        if (cancelled) return;
        setMlReadiness({
          pairs: j.service_time_pairs ?? 0,
          threshold: j.thresholds?.min_trainable ?? 50,
          status: (j.readiness ?? 'insufficient') as 'insufficient' | 'trainable' | 'ready',
        });
      } catch {
        /* silent — badge just stays hidden */
      }
    })();
    return () => { cancelled = true; };
  }, [completedCount]);



  // ── Track "paused" state while navigating ──
  // Driven by `currentSpeed` (km/h, already smoothed upstream). When the vehicle
  // drops below the threshold, record the timestamp and start a 1 Hz tick that
  // surfaces "Paused · M:SS" after 10 s. When moving again, clear everything
  // immediately. We intentionally don't touch the camera — this is a pure
  // status indicator, not a view change.
  useEffect(() => {
    if (!isNavigating) {
      pausedSinceRef.current = null;
      if (pausedSeconds !== null) setPausedSeconds(null);
      return;
    }
    if (currentSpeed >= PAUSED_SPEED_THRESHOLD_KMH) {
      if (pausedSinceRef.current !== null) {
        pausedSinceRef.current = null;
        setPausedSeconds(null);
      }
      return;
    }
    // Speed is below threshold — start (or continue) the pause timer
    if (pausedSinceRef.current === null) pausedSinceRef.current = Date.now();
    const tick = () => {
      if (pausedSinceRef.current === null) return;
      const elapsed = Date.now() - pausedSinceRef.current;
      if (elapsed >= PAUSED_SHOW_AFTER_MS) {
        setPausedSeconds(Math.floor(elapsed / 1000));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isNavigating, currentSpeed, pausedSeconds]);

  // Fade the pill in / out whenever its visibility flips
  useEffect(() => {
    Animated.timing(pausedPillOpacity, {
      toValue: pausedSeconds !== null ? 1 : 0,
      duration: 260,
      useNativeDriver: true,
    }).start();
  }, [pausedSeconds, pausedPillOpacity]);
  const totalWeight = stops.reduce((sum, stop) => sum + (stop.weight || 0), 0);
  const currentLeg = navigationData?.legs[currentLegIndex];
  const currentStep = liveRoute?.steps?.[0];
  const nextStep = liveRoute?.steps?.[1];
  // Filter out "Current Location" virtual stop from total count
  const realStops = navigationData?.stops.filter((s: any) => !s.is_current_location) || stops;
  const totalStops = realStops.length;
  const currentStopNumber = currentLegIndex + 1;

  // OpenAI TTS voice announcements for turn instructions
  useNavigationTTS({
    enabled: voiceEnabled && viewMode === 'navigating',
    instruction: currentStep?.voice_instruction || currentStep?.instruction || null,
  });

  // ── 250ms camera hook (bypasses React prop latency for buttery-smooth 3D POV) ──
  useNavigationCamera(sendToMap, {
    enabled: isNavigating && viewMode === 'navigating',
    mapReady: isMapReady,
    onSpeedUpdate: (s) => { cameraSpeedRef.current = s; },
  });

  // ── Geofence: 50m arrival detection (deduped per-stop, session-safe) ──────────
  const geofenceActiveStop = useMemo<GeofenceStop | null>(() => {
    const leg = navigationData?.legs[currentLegIndex];
    if (!leg?.to_stop) return null;
    return { id: leg.to_stop.id, latitude: leg.to_stop.latitude, longitude: leg.to_stop.longitude };
  }, [navigationData, currentLegIndex]);

  const { resetAll: geofenceResetAll } = useGeofenceArrival({
    activeStop: geofenceActiveStop,
    driverPosition: currentLocation,
    enabled: isNavigating && viewMode === 'navigating',
    // 100 m chosen empirically: 50 m never fired in production because
    //   (a) geocoded centroid ≠ driveway (typical 20–40 m offset for residential),
    //   (b) urban GPS accuracy floors at ~15–25 m, and
    //   (c) drivers tap "Mark Delivered" while still parked 30+ m from the door.
    // Apple Maps / Google Maps both use ~100 m for "you have arrived" detection,
    // and the firedRef Set already prevents re-fires from drive-bys on parallel streets.
    radiusMeters: 100,
    onArrival: (stopId) => {
      // Phase 0 — fire-and-forget: stamp arrival timestamp + arrival GPS
      // (current vehicle position) so we can later learn (a) per-stop
      // service times = completed_at - arrived_at, (b) the actual access
      // edge from the GPS fix taken while the driver is still on the road.
      // Backend is idempotent so geofence flap doesn't reset the clock.
      arriveAtStop(stopId, currentLocation
        ? {
            lat: currentLocation.latitude,
            lng: currentLocation.longitude,
          }
        : undefined,
      );
      // Deduplicate with the same ref used by voice/haptic so they fire exactly once
      if (proximityNotifiedRef.current !== currentLegIndexRef.current) {
        proximityNotifiedRef.current = currentLegIndexRef.current;
        handleArrivalAtStop();
      }
      if (immersiveMode) setImmersiveMode(false);
    },
  });

  // Reset geofence fired-set at the start of each navigation session
  useEffect(() => {
    if (viewMode === 'navigating') geofenceResetAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  const sidebarWidth = sidebarAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [COLLAPSED_WIDTH, SIDEBAR_WIDTH],
  });

  const contentOpacity = sidebarAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, 0, 1],
  });

  // ── DeliveryMap prop preparation ──────────────────────────────────────────────
  // Convert app stops to DeliveryStop format for the map component
  const mapStops: DeliveryStop[] = useMemo(() => {
    // In navigation mode, use navigation stops (they have updated completion status)
    const source = viewMode === 'navigating' && navigationData?.stops
      ? navigationData.stops.filter((s: any) => !s.is_current_location)
      : stops;
    return source
      .filter((s: any) => typeof s.longitude === 'number' && typeof s.latitude === 'number')
      .map((s: any, idx: number) => ({
        id: s.id,
        latitude: s.latitude,
        longitude: s.longitude,
        address: s.address,
        name: s.name,
        order: s.order ?? idx,
        completed: s.completed ?? false,
        // CRITICAL: this field tells the map renderer whether the pin
        // should paint RED (locked Sharpie) or BLUE (tentative drive
        // order). Forgetting to include it here strips the locked state
        // before it reaches the WebView, leaving every pin blue forever
        // no matter how reliably /api/routes/confirm stamps the DB.
        // Bug history: this caused user-reported "pins stay blue after
        // Confirm Route" — every backend/Zustand layer was correct, but
        // this projection deleted the field on the way to MapLibre.
        original_sequence: typeof s.original_sequence === 'number' ? s.original_sequence : null,
        // Tiny orange "syncing" dot on the pin while the optimistic action is awaiting server ack.
        pending: pendingSyncIds.has(s.id),
      }));
  }, [viewMode, stops, navigationData?.stops, pendingSyncIds]);

  // Route line coordinates for the map.
  //
  // Behaviour by mode:
  //   • navigating — live driver→next-stop directions geometry from /api/directions.
  //     Driving overlay handles "completed/upcoming" splits via traveled-path masking.
  //   • planning   — full optimised polyline from /api/optimize → /api/directions.
  //     Earlier this mode returned `null` (pins-only) which made the route line
  //     "disappear" the moment the user came back from the navigation overlay
  //     to plan or tweak the run. Re-enabling it: judges and drivers expect
  //     to see the planned tour as a connected line, not a dot field.
  const mapRouteCoordinates: number[][] | null = useMemo(() => {    if (viewMode === 'navigating') {
      return liveRoute?.geometry?.coordinates ?? null;
    }
    // Planning view: feed the optimised polyline geometry that
    // `fetchDirections()` already populated into `routeGeometry`.
    // Defensive: a few legacy code paths (offline-cache hits, manual
    // imports of older route_history records) can stuff a non-LineString
    // shape into routeGeometry; only forward arrays of [lng,lat] pairs
    // so the map never receives malformed data.
    const coords = (routeGeometry as any)?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2 && Array.isArray(coords[0])) {
      return coords;
    }
    // Fallback preview: straight-line from the driver's current location
    // to the next uncompleted stop. Drivers expect "where do I go now?"
    // visible BEFORE they hit Confirm Route — no map answer at all when
    // a route hasn't been optimised yet feels broken.
    //
    // Sort by `order` (live drive position) — NOT `sequence_number`. After
    // confirm + re-optimise, sequence_number stays welded to the original
    // Sharpie execution order, but the actually-optimal next stop now
    // lives at order=0 of the new plan. Picking by sequence_number would
    // route the preview line through the locked-old-order first stop
    // even when the driver is supposed to go somewhere else next.
    if (currentLocation) {
      const next = stops
        .filter((s) => !s.completed && typeof s.longitude === 'number' && typeof s.latitude === 'number')
        .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999))[0];
      if (next) {
        return [
          [currentLocation.longitude, currentLocation.latitude],
          [next.longitude, next.latitude],
        ];
      }
    }
    return null;
  }, [viewMode, liveRoute?.geometry?.coordinates, routeGeometry, currentLocation, stops]);

  // Driver location for the map. Used to be gated on `viewMode ===
  // 'navigating'` so the driver dot only appeared during active drive,
  // but planners want to see "I am here, the next stop is THERE" the
  // moment they open the map. Camera-follow stays gated below
  // (`mapFollowDriver`) so the map doesn't yank around while planning.
  const mapDriverLocation: DriverLocation | null = useMemo(() => {
    if (!currentLocation) return null;
    return {
      latitude: currentLocation.latitude,
      longitude: currentLocation.longitude,
      heading: currentLocation.heading ?? 0,
    };
  }, [currentLocation]);

  // Convert traveled path from {lng, lat}[] to number[][]
  const mapTraveledPath: number[][] | null = useMemo(() => {
    if (viewMode !== 'navigating' || traveledPath.length === 0) return null;
    return traveledPath.map(p => [p.lng, p.lat]);
  }, [viewMode, traveledPath]);

  // Follow driver in navigation mode
  // TEMP: Force follow when in navigating viewMode (debug camera issue)
  const mapFollowDriver = viewMode === 'navigating';

  // Handle stop click from DeliveryMap
  const handleMapStopClick = useCallback((stopId: string) => {
    const navStops = (navigationData?.stops || []).filter((s: any) => !s.is_current_location);
    const clickedStop = [...navStops, ...stops].find((s: any) => s?.id === stopId);
    if (clickedStop) {
      setSelectedStopModal(clickedStop);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  }, [navigationData?.stops, stops]);

  // Reusable single-stop in-app nav launcher. Used by both:
  //   1. The on-map marker modal's "Navigate" button (driver tapped a pin).
  //   2. The cross-screen `pendingNavTargetId` watcher (e.g. stop-detail
  //      page's Navigate hand-off).
  // Fetches an OSRM route from `currentLocation → targetStop`, builds the
  // exact NavigationData shape the cockpit expects (legs, geometry,
  // steps), drops the driver into navigating-mode, and starts live
  // tracking + voice. Falls back to a straight-line geometry if the
  // directions endpoint is unreachable (most common cause: stale baked
  // BACKEND_URL on EAS APK after a fork) so the cockpit still opens
  // instead of silently failing — driver gets a visual route line and
  // the GPS-following camera even without turn-by-turn.
  const startSingleStopNavigation = useCallback(async (targetStop: Stop) => {
    if (!currentLocation) {
      Alert.alert('Location Required', 'Please enable location services to navigate.');
      return;
    }
    try {
      const headers = await getAuthHeaders();
      const coordsStr = `${currentLocation.longitude},${currentLocation.latitude};${targetStop.longitude},${targetStop.latitude}`;
      const response = await fetch(`${BACKEND_URL}/api/directions?coordinates=${coordsStr}`, { headers });

      // Synthesise a degenerate "route" if the directions call fails. The
      // distance is great-circle (Haversine) so the ETA is at least
      // directionally honest; steps=[] disables turn cards but the cockpit
      // map + speedometer + completion gestures all still work.
      const fallbackGeometry = {
        type: 'LineString' as const,
        coordinates: [
          [currentLocation.longitude, currentLocation.latitude],
          [targetStop.longitude, targetStop.latitude],
        ],
      };
      const haversineMeters = (() => {
        const R = 6371000;
        const toRad = (d: number) => (d * Math.PI) / 180;
        const dLat = toRad(targetStop.latitude - currentLocation.latitude);
        const dLng = toRad(targetStop.longitude - currentLocation.longitude);
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(currentLocation.latitude)) * Math.cos(toRad(targetStop.latitude)) *
          Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      })();

      let directionsData: any;
      if (response.ok) {
        directionsData = await response.json();
      } else {
        console.warn('[startSingleStopNavigation] directions fetch failed', response.status, '— falling back to straight-line geometry');
        directionsData = {
          distance: haversineMeters,
          duration: haversineMeters / (50 * 1000 / 3600), // assume 50 km/h
          geometry: fallbackGeometry,
          steps: [],
        };
      }

      const singleStopNavData = {
        stops: [
          {
            id: 'current_location',
            name: 'Current Location',
            address: 'Your current location',
            latitude: currentLocation.latitude,
            longitude: currentLocation.longitude,
            is_current_location: true,
          },
          targetStop,
        ],
        legs: [{
          from_stop: {
            id: 'current_location',
            name: 'Current Location',
            address: 'Your current location',
            latitude: currentLocation.latitude,
            longitude: currentLocation.longitude,
            is_current_location: true,
          },
          to_stop: targetStop,
          distance: directionsData.distance,
          duration: directionsData.duration,
          geometry: directionsData.geometry,
          steps: directionsData.steps || [],
        }],
        total_distance: directionsData.distance,
        total_duration: directionsData.duration,
        geometry: directionsData.geometry,
      };

      setNavigationData(singleStopNavData as any);
      setCurrentLegIndex(0);
      setViewMode('navigating');
      setSidebarExpanded(false);

      Animated.spring(sidebarAnim, {
        toValue: 0,
        friction: 8,
        tension: 65,
        useNativeDriver: false,
      }).start();

      startLiveTracking();
      speakInstruction(`Starting navigation to ${targetStop.name || targetStop.address}`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('[startSingleStopNavigation] error:', error);
      Alert.alert('Navigation Error', 'Failed to start navigation.');
    }
  }, [currentLocation, sidebarAnim]);

  // Cross-screen Navigate hand-off. Other screens (stop-detail today, more
  // tomorrow) set `pendingNavTargetId` on the global stops store — this
  // effect picks it up the moment the map tab mounts/focuses, fires the
  // same in-app nav flow used by the on-map marker modal, then clears
  // the intent so it can't re-fire on a re-render. Guarded on
  // `currentLocation` so we don't drop a "Location Required" alert on
  // a driver who hasn't yet granted GPS permission — they'll just see
  // the modal-route once the fix lands.
  useEffect(() => {
    if (!pendingNavTargetId) return;
    const target = stops.find((s) => s.id === pendingNavTargetId);
    if (!target) {
      // Stale ID (deleted between hand-off and arrival) — clear silently.
      setPendingNavTarget(null);
      return;
    }
    if (!currentLocation) return; // wait for first GPS fix; effect re-runs.
    setPendingNavTarget(null);
    startSingleStopNavigation(target);
  }, [pendingNavTargetId, stops, currentLocation, startSingleStopNavigation, setPendingNavTarget]);

  // "Wedge a courtesy stop into the active route" — driver taps a marker
  // mid-drive, picks "Insert", and the new stop becomes the *new next*
  // (i.e. visited AFTER finishing the current target but BEFORE what was
  // previously next). All later stops shift back by one. Implementation:
  //   1. Splice the new stop into `navigationData.stops` at position
  //      `currentLegIndex + 2` (current_location + currentTarget already
  //      occupy 0 and currentLegIndex+1 — new stop slots in right after).
  //   2. Re-fetch OSRM directions for the entire modified sequence so
  //      every leg's distance/duration/geometry/steps is correct (we
  //      can't reuse the old per-leg payloads — the inserted leg means
  //      every subsequent leg's `from_stop` changed, so OSRM is the
  //      cheapest way to refresh them all atomically).
  //   3. Rebuild the legs array from the new stops list pairing.
  // Already-in-route guard: refuses to double-insert a stop that's
  // already pending (compares against remaining legs' `to_stop.id`).
  const insertIntoRoute = useCallback(async (stopToInsert: Stop) => {
    if (!navigationData || !currentLocation) {
      Alert.alert('Cannot Insert', 'Start navigation first to add a courtesy stop.');
      return;
    }
    const currentStops: any[] = navigationData.stops || [];
    const insertPosition = currentLegIndex + 2; // after current target, before the next
    if (insertPosition > currentStops.length) {
      Alert.alert('Cannot Insert', 'No remaining stops to insert before.');
      return;
    }
    const remainingIds = currentStops
      .slice(currentLegIndex + 1)
      .map((s) => s?.id)
      .filter(Boolean);
    if (remainingIds.includes(stopToInsert.id)) {
      Alert.alert('Already in route', 'This stop is already pending in your active route.');
      return;
    }

    const newStopsList = [
      ...currentStops.slice(0, insertPosition),
      stopToInsert,
      ...currentStops.slice(insertPosition),
    ];
    const coordsStr = newStopsList
      .filter((s) => typeof s?.longitude === 'number' && typeof s?.latitude === 'number')
      .map((s) => `${s.longitude},${s.latitude}`)
      .join(';');

    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${BACKEND_URL}/api/directions?coordinates=${coordsStr}`, { headers });
      if (!response.ok) {
        Alert.alert('Insert Failed', 'Could not fetch directions for the modified route.');
        return;
      }
      const directionsData = await response.json();

      // Rebuild legs from the new stops list pairing. Use OSRM's per-leg
      // payload when available; fall back to flat distance/duration on
      // the (rare) backend that returns only the merged geometry.
      const newLegs = [];
      for (let i = 0; i < newStopsList.length - 1; i++) {
        const apiLeg = directionsData.legs?.[i];
        newLegs.push({
          from_stop: newStopsList[i],
          to_stop: newStopsList[i + 1],
          distance: apiLeg?.distance ?? 0,
          duration: apiLeg?.duration ?? 0,
          geometry: apiLeg?.geometry || directionsData.geometry,
          steps: apiLeg?.steps || [],
        });
      }

      setNavigationData({
        ...navigationData,
        stops: newStopsList,
        legs: newLegs as any,
        total_distance: directionsData.distance,
        total_duration: directionsData.duration,
        geometry: directionsData.geometry,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      speakInstruction(`Inserted ${stopToInsert.name || stopToInsert.address || 'stop'} after current`);
    } catch (e) {
      console.error('[insertIntoRoute] error:', e);
      Alert.alert('Insert Failed', 'Could not insert stop into route.');
    }
  }, [navigationData, currentLegIndex, currentLocation]);

  // Handle native drawing overlay completion - convert screen coords to lng/lat
  const handleNativeDrawComplete = useCallback((screenPoints: { x: number; y: number }[]) => {
    const map = mapRef.current?.getMap();
    if (!map || screenPoints.length < 10) return;

    const layout = mapContainerLayoutRef.current;
    if (layout.width === 0 || layout.height === 0) return;

    // Convert screen points to map coordinates using MapLibre's unproject
    const polygon = screenPoints.map(p => {
      const lngLat = map.unproject([p.x, p.y]);
      return { lng: lngLat.lng, lat: lngLat.lat };
    });

    completeLassoDrawing(polygon);
  }, [completeLassoDrawing]);

  return (
    <View style={styles.container}>
      {/* Offline banner — persistent thin bar at the top while device is offline OR while
          queued actions haven't drained yet. Reassures the driver that taps are being
          saved; hides the moment everything is synced. Tap to expand and see exactly
          which stops and actions are pending sync. */}
      {(!isOnline || queuedCount > 0) && (
        <View style={[styles.offlineBannerWrap, { top: insets.top }]} data-testid="offline-banner-wrap">
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => {
              setBannerExpanded((v) => !v);
              Haptics.selectionAsync();
            }}
            style={styles.offlineBanner}
            data-testid="offline-banner"
          >
            <Ionicons name={isOnline ? 'cloud-upload' : 'cloud-offline'} size={14} color="#111827" />
            <Text style={styles.offlineBannerText}>
              {isOnline
                ? `Syncing · ${queuedCount} queued`
                : `Offline${queuedCount > 0 ? ` · ${queuedCount} queued` : ''}`}
            </Text>
            {queuedActions.length > 0 && (
              <Ionicons
                name={bannerExpanded ? 'chevron-up' : 'chevron-down'}
                size={14}
                color="#111827"
                style={{ marginLeft: 2 }}
              />
            )}
          </TouchableOpacity>
          {bannerExpanded && queuedActions.length > 0 && (
            <View style={styles.offlineBannerPanel} data-testid="offline-banner-panel">
              <ScrollView style={{ maxHeight: 260 }} showsVerticalScrollIndicator={false}>
                {queuedActions
                  .slice()
                  .sort((a, b) => b.ts - a.ts)
                  .map((action) => {
                    const stop = stops.find((s) => s.id === action.id);
                    const label = stop
                      ? (stop.name || stop.address || `Stop ${stop.id.slice(0, 6)}`)
                      : `Stop ${action.id.slice(0, 6)}`;
                    const isComplete = action.op === 'complete';
                    return (
                      <Swipeable
                        key={action.id}
                        friction={1.8}
                        rightThreshold={48}
                        overshootRight={false}
                        renderRightActions={(_progress, dragX) => {
                          const scale = dragX.interpolate({
                            inputRange: [-120, -48, 0],
                            outputRange: [1, 0.9, 0.6],
                            extrapolate: 'clamp',
                          });
                          const opacity = dragX.interpolate({
                            inputRange: [-80, -24, 0],
                            outputRange: [1, 0.6, 0],
                            extrapolate: 'clamp',
                          });
                          return (
                            <Animated.View style={[styles.offlineBannerSwipeAction, { opacity }]}>
                              <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}>
                                <Ionicons name="trash-outline" size={18} color="#fff" />
                                <Text style={styles.offlineBannerSwipeActionText}>Dismiss</Text>
                              </Animated.View>
                            </Animated.View>
                          );
                        }}
                        onSwipeableOpen={async (direction) => {
                          if (direction !== 'right') return;
                          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                          const ok = await dismissQueuedAction(action.id);
                          if (ok) {
                            // Refresh local panel state immediately so the row disappears
                            const [queued, actions] = await Promise.all([getOfflineQueuedIds(), getQueuedActions()]);
                            setPendingSyncIds(queued);
                            setQueuedActions(actions);
                            // Show an "Undo" toast for 5s; clear any previous toast's timer first.
                            if (undoToastTimerRef.current) clearTimeout(undoToastTimerRef.current);
                            setUndoToast({ action, label });
                            undoToastTimerRef.current = setTimeout(() => setUndoToast(null), 5000);
                          }
                        }}
                      >
                        <View
                          style={[styles.offlineBannerRow, { backgroundColor: '#fffbeb' }]}
                          data-testid={`offline-queue-row-${action.id}`}
                        >
                          <View style={[
                            styles.offlineBannerDot,
                            { backgroundColor: isComplete ? '#10b981' : '#6b7280' },
                          ]} />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.offlineBannerRowLabel} numberOfLines={1}>
                              {label}
                            </Text>
                            <Text style={styles.offlineBannerRowMeta} numberOfLines={1}>
                              {isComplete ? 'Marking delivered' : 'Reverting to pending'}
                              {' · '}
                              {formatRelativeTime(action.ts)}
                            </Text>
                          </View>
                          <Ionicons name="swap-horizontal" size={14} color="#78350f" />
                        </View>
                      </Swipeable>
                    );
                  })}
                <View style={styles.offlineBannerActions}>
                  <TouchableOpacity
                    activeOpacity={0.8}
                    disabled={isRetrying || queuedActions.length === 0}
                    onPress={async () => {
                      if (isRetrying) return;
                      setIsRetrying(true);
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      try {
                        const drained = await flushSyncQueue();
                        if (drained > 0) {
                          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                          fetchStops();
                        } else {
                          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                        }
                        // Immediately re-hydrate so the panel reflects post-flush state
                        const [queued, actions] = await Promise.all([getOfflineQueuedIds(), getQueuedActions()]);
                        setPendingSyncIds(queued);
                        setQueuedActions(actions);
                      } finally {
                        setIsRetrying(false);
                      }
                    }}
                    style={[
                      styles.offlineBannerRetryBtn,
                      (isRetrying || queuedActions.length === 0) && { opacity: 0.55 },
                    ]}
                    data-testid="offline-banner-retry-btn"
                  >
                    {isRetrying ? (
                      <ActivityIndicator size="small" color="#111827" />
                    ) : (
                      <Ionicons name="refresh" size={14} color="#111827" />
                    )}
                    <Text style={styles.offlineBannerRetryText}>
                      {isRetrying ? 'Retrying…' : 'Retry now'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.offlineBannerFooter}>
                  {isOnline
                    ? 'Retrying automatically…'
                    : 'Will sync the moment you\'re back online.'}
                </Text>
              </ScrollView>
            </View>
          )}
        </View>
      )}
      {/* Undo toast — appears for 5s after swipe-dismiss of a queued action.
          Tapping "Undo" re-enqueues it and re-applies the optimistic flip. */}
      {undoToast && (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.undoToastWrap, { bottom: insets.bottom + 80, opacity: undoToastOpacity }]}
        >
          <View style={styles.undoToast} data-testid="undo-toast">
            <Ionicons name="checkmark-circle" size={18} color="#22c55e" />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.undoToastTitle} numberOfLines={1}>Removed from queue</Text>
              <Text style={styles.undoToastSubtitle} numberOfLines={1}>{undoToast.label}</Text>
            </View>
            <TouchableOpacity
              activeOpacity={0.8}
              data-testid="undo-toast-undo-btn"
              onPress={async () => {
                if (undoToastTimerRef.current) {
                  clearTimeout(undoToastTimerRef.current);
                  undoToastTimerRef.current = null;
                }
                const toRestore = undoToast;
                setUndoToast(null);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                await restoreQueuedAction(toRestore.action);
                // Refresh panel state so the row reappears
                const [queued, actions] = await Promise.all([getOfflineQueuedIds(), getQueuedActions()]);
                setPendingSyncIds(queued);
                setQueuedActions(actions);
              }}
              style={styles.undoToastBtn}
            >
              <Text style={styles.undoToastBtnText}>Undo</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}
      {/* Resume toast — 1.5s green pill confirming we restored the driver's
          active stop when they re-entered navigation. */}
      {resumeToast && (
        <Animated.View
          pointerEvents="none"
          style={[styles.resumeToastWrap, { top: insets.top + 12, opacity: resumeToastOpacity }]}
        >
          <View
            style={[
              styles.resumeToast,
              resumeToast.startsWith('⚠') && styles.resumeToastWarning,
            ]}
            data-testid="resume-toast"
          >
            <Ionicons
              name={resumeToast.startsWith('⚠') ? 'warning' : 'checkmark-circle'}
              size={16}
              color={resumeToast.startsWith('⚠') ? '#7c2d12' : '#dcfce7'}
            />
            <Text
              style={[
                styles.resumeToastText,
                resumeToast.startsWith('⚠') && styles.resumeToastTextWarning,
              ]}
              numberOfLines={2}
            >
              {resumeToast}
            </Text>
          </View>
        </Animated.View>
      )}
      {/* Centred "resuming" anchor — reads the matching pin number for
          ~400ms so the driver's eye locks onto it before autocam pitches. */}
      {resumingOverlayPin != null && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.resumingOverlayWrap,
            {
              opacity: resumingOverlayOpacity,
              transform: [{ scale: resumingOverlayScale }],
            },
          ]}
        >
          <View style={styles.resumingOverlay} data-testid="resuming-overlay">
            <Text style={styles.resumingOverlayLabel}>RESUMING AT</Text>
            <Text style={styles.resumingOverlayPin}>#{resumingOverlayPin}</Text>
          </View>
        </Animated.View>
      )}
      {/* Cluster Warnings Banner — surfaces post-optimisation route fragmentation
          (haversine spike detection by `detect_cluster_spikes`). Self-hides when
          `clusterWarnings` is empty. Only shown during planning so it doesn't
          obstruct the immersive nav UI.

          Wrap is full screen width with `pointerEvents="box-none"` so taps
          fall through to the chevron-back / sidebar collapse handle. The
          banner itself uses `marginLeft: COLLAPSED_WIDTH + 12` to skip
          the chevron column, so an open sidebar (320 px) doesn't push
          the banner off-screen the way `left: sidebarWidth` did. */}
      {viewMode === 'planning' && (
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.clusterWarningsWrap,
            {
              bottom: insets.bottom + 30,
            },
          ]}
        >
          <OutlierWarningBanner onSuccess={setResumeToast} />
          <ClusterWarningsBanner onSuccess={setResumeToast} />
          <UnconfirmedNumbersBanner />
        </Animated.View>
      )}
      {/* DeliveryMap — react-map-gl WebGL component (replaces legacy WebView) */}
      <View style={styles.mapContainer} onLayout={(e) => {
        mapContainerLayoutRef.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
      }}>
        <DeliveryMap
          ref={mapRef}
          stops={mapStops}
          routeCoordinates={mapRouteCoordinates}
          /* Dashed style applied only when the polyline is the planning
             "current → first-stop" preview (a 2-coord LineString from
             driver location to next-uncompleted stop). Once an OSRM
             route is generated or navigation starts, the polyline goes
             solid. Cheap derivation off the existing memo result. */
          routeIsPreview={
            viewMode !== 'navigating' &&
            Array.isArray(mapRouteCoordinates) &&
            mapRouteCoordinates.length === 2 &&
            !((routeGeometry as any)?.coordinates)
          }
          driverLocation={mapDriverLocation}
          traveledPath={mapTraveledPath}
          followDriver={mapFollowDriver}
          // When the 250 ms `useNavigationCamera` hook is enabled (driving
          // mode) we must tell the WebView NOT to also fire its own React-
          // driven `drivingCamera` writes — both writers racing produces the
          // visible "camera snapping" tug-of-war every ~250 ms.
          highFreqCameraActive={isNavigating && viewMode === 'navigating'}
          onStopClick={handleMapStopClick}
          onMapReady={() => { setIsMapReady(true); mapRef.current?.setNogoZones(nogoZones); }}
          onBlockRoadTap={handleBlockRoadTap}
          onNogoZoneClick={handleNogoZoneClick}
          onLassoComplete={(stopIds: string[], polygon: number[][]) => {
            if (stopIds.length > 0) {
              const alreadySelectedIds = new Set(drawnSections.flatMap(s => s.stopIds));
              const newStopIds = stopIds.filter(id => !alreadySelectedIds.has(id));
              if (newStopIds.length > 0) {
                const sectionNumber = drawnSections.length + 1;
                const color = SECTION_COLORS[(sectionNumber - 1) % SECTION_COLORS.length];
                const label = 'Section ' + sectionNumber;
                setDrawnSections(prev => [...prev, {
                  id: sectionNumber,
                  stopIds: newStopIds,
                  color,
                  polygon: polygon || [],
                }]);
                // Persist section polygon on map with color + label
                mapRef.current?.clearLasso();
                mapRef.current?.addSectionPolygon(sectionNumber, polygon, color, label);
                setIsDrawing(false);
                setIsActivelyDrawing(false);
                mapRef.current?.setDrawingMode(false);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            }
          }}
          speed={viewMode === 'navigating' ? currentSpeed : null}
          etaMinutes={viewMode === 'navigating' && liveRoute ? Math.round(liveRoute.duration / 60) : null}
          distanceRemaining={viewMode === 'navigating' && liveRoute ? formatDistance(liveRoute.distance) : null}
          nextTurn={viewMode === 'navigating' && currentStep ? {
            instruction: currentStep.voice_instruction || currentStep.instruction || 'Continue',
            distance: currentStep.distance != null ? formatDistance(currentStep.distance) : '',
          } : null}
          nextStopCoord={
            viewMode === 'navigating' && navigationData?.legs?.[currentLegIndex]?.to_stop
              ? [
                  Number(navigationData.legs[currentLegIndex].to_stop.longitude),
                  Number(navigationData.legs[currentLegIndex].to_stop.latitude),
                ]
              : null
          }
          nextStopColor={(() => {
            // Colour the pulse ring by ETA vs the next stop's time window:
            //   green → arriving comfortably within window (≥ 5 min buffer)
            //   amber → no window set, or tight (< 5 min before window end)
            //   red   → arriving AFTER window end
            if (viewMode !== 'navigating') return null;
            const tw = navigationData?.legs?.[currentLegIndex]?.to_stop?.time_window;
            const etaSec = liveRoute?.duration;
            if (!tw || !tw.end || typeof etaSec !== 'number') return '#f59e0b';
            // Parse HH:MM for today; if already past, assume next day.
            const parseHHMM = (s: string) => {
              const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
              if (!m) return null;
              const d = new Date();
              d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
              return d.getTime();
            };
            const endMs = parseHHMM(tw.end);
            if (!endMs) return '#f59e0b';
            const arrivalMs = Date.now() + etaSec * 1000;
            const bufferMs = endMs - arrivalMs;
            if (bufferMs < 0) return '#ef4444';           // red: late
            if (bufferMs > 5 * 60 * 1000) return '#22c55e'; // green: ≥5 min buffer
            return '#f59e0b';                              // amber: tight
          })()}
        />
        {/* Refresh Pin Numbers — re-stamps `original_sequence` from the
            current `order` field after a re-optimise. Lighter cousin of
            "Restore Sharpie": no solver re-run, just takes the latest
            optimised positions and locks them as the new pin numbers.
            
            CONTRACT (post-2026-05-10): Start Navigation's implicit
            /routes/confirm preserves locked Sharpie numbers once delivery
            has started. THIS button is the explicit override — tap it to
            FORCE a full re-stamp from the current optimised order (use
            after physically re-labelling boxes, or when the smart-preserve
            isn't what you want). Long-press shows this contract inline
            so drivers don't have to remember which button does what. */}
        <TouchableOpacity
          testID="refresh-pin-numbers-btn"
          onLongPress={() => {
            Alert.alert(
              'Force re-stamp Sharpie numbers',
              'This button OVERRIDES the smart-preserve contract:\n\n' +
              '• Tap Start Navigation → existing Sharpie numbers stay locked, only new late freight gets stamped (drivers keep box-labels valid mid-shift).\n\n' +
              '• Tap THIS button → every stop gets a fresh Sharpie number from the current optimised order. Use after re-labelling boxes or if you want the screen numbers to match a fresh optimise exactly.',
              [{ text: 'Got it' }],
            );
          }}
          onPress={async () => {
            try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
            try {
              const headers = await getAuthHeaders();
              const r = await fetch(`${BACKEND_URL}/api/stops/relock-pins`, {
                method: 'POST',
                headers,
              });
              if (!r.ok) {
                const hint = (r.status === 404 || r.status === 405)
                  ? ' — backend needs redeploy'
                  : '';
                Alert.alert('Refresh failed', `HTTP ${r.status}${hint}`);
                return;
              }
              const data = await r.json();
              await fetchStops();
              setResumeToast(`Pins refreshed · ${data.restored} stamped`);
            } catch (e: any) {
              Alert.alert('Refresh failed', e?.message || 'Network error');
            }
          }}
          activeOpacity={0.85}
          style={{
            position: 'absolute',
            right: 12, bottom: 188,
            paddingVertical: 10, paddingHorizontal: 14,
            borderRadius: 999,
            backgroundColor: 'rgba(29,78,216,0.92)',  // blue-700
            borderWidth: 1, borderColor: '#1e40af',
            flexDirection: 'row', alignItems: 'center',
            shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
            elevation: 4,
          }}
        >
          <Ionicons name="refresh" size={14} color="#fff" style={{ marginRight: 6 }} />
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>
            Refresh Pins
          </Text>
        </TouchableOpacity>

        {/* Sharpie restore pill — always visible above the Block Road
            button. Tap → calls /api/stops/recover-sharpie-marks (deterministic
            VROOM+LKH replay) → re-stamps `original_sequence` on every stop
            from the last optimised order. Use if your sharpie marks got
            wiped by a CSV re-import or accidental clear. */}
        <TouchableOpacity
          testID="restore-sharpie-btn"
          onPress={async () => {
            Alert.alert(
              'Restore Sharpie Marks?',
              `Re-stamp all ${stops.length} stops from the last optimised order. ` +
              `Uses the deterministic VROOM+LKH solver — gives you the same ` +
              `numbers you had before the reset.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Restore',
                  onPress: async () => {
                    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
                    try {
                      const headers = await getAuthHeaders();
                      const r = await fetch(`${BACKEND_URL}/api/stops/recover-sharpie-marks`, {
                        method: 'POST',
                        headers,
                      });
                      if (!r.ok) {
                        const hint = (r.status === 404 || r.status === 405)
                          ? ' — backend needs redeploy'
                          : '';
                        Alert.alert('Restore failed', `HTTP ${r.status}${hint}`);
                        return;
                      }
                      const data = await r.json();
                      await fetchStops();
                      Alert.alert('Restored', `${data.restored} of ${data.total} stops re-stamped via ${data.algorithm}.`);
                    } catch (e: any) {
                      Alert.alert('Restore failed', e?.message || 'Network error');
                    }
                  },
                },
              ]
            );
          }}
          activeOpacity={0.85}
          style={{
            position: 'absolute',
            right: 12, bottom: 144,
            paddingVertical: 10, paddingHorizontal: 14,
            borderRadius: 999,
            backgroundColor: 'rgba(217,119,6,0.92)',  // amber-600
            borderWidth: 1, borderColor: '#92400e',
            flexDirection: 'row', alignItems: 'center',
            shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
            elevation: 4,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>
            Restore Sharpie
          </Text>
        </TouchableOpacity>

        {/* No-Go Zone toggle: tap → "block road" mode → next map tap creates a
            30 m red zone snapped to the nearest road. Active state = solid red.
            
            Long-press behaviour:
              • If there are zones (count > 0) → opens the "Wipe All" confirmation
                so the escape hatch is always one-action-away (no need to find a
                zone to tap, which is impossible on a screen that hasn't panned to one).
              • If there are zero zones → falls back to the hidden OTA-debug check
                (forceOtaCheck) so we don't lose that diagnostic. */}
        <TouchableOpacity
          data-testid="block-road-toggle-btn"
          testID="block-road-toggle-btn"
          onPress={toggleBlockRoadMode}
          onLongPress={nogoZones.length > 0 ? wipeAllNogoZones : forceOtaCheck}
          delayLongPress={800}
          activeOpacity={0.85}
          style={{
            position: 'absolute',
            right: 12, bottom: 92,
            paddingVertical: 10, paddingHorizontal: 14,
            borderRadius: 999,
            backgroundColor: blockRoadMode ? '#dc2626' : 'rgba(17,24,39,0.85)',
            borderWidth: 1, borderColor: blockRoadMode ? '#7f1d1d' : 'rgba(255,255,255,0.18)',
            flexDirection: 'row', alignItems: 'center',
            shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
            elevation: 4,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>
            {blockRoadMode ? 'Tap road to block' : `Block road${nogoZones.length ? ' · ' + nogoZones.length : ''}`}
          </Text>
        </TouchableOpacity>

        {/* Last-mile precision HUD — appears at top-centre of the map when
            the driver enters the 150 m approach radius of the upcoming
            stop. Read-only chip showing "X m · Y o'clock" so the driver
            knows which side of the van the door is on without taking
            eyes off the road. Renders inside mapContainer so it sits
            above the map but below the NavigationPanel z-index. */}
        <LastMilePrecisionHUD
          enabled={viewMode === 'navigating' && isNavigating}
          driverLat={currentLocation?.latitude}
          driverLng={currentLocation?.longitude}
          driverHeading={currentLocation?.heading}
          targetLat={geofenceActiveStop?.latitude}
          targetLng={geofenceActiveStop?.longitude}
        />

      </View>

      {/* IMMERSIVE Full-Screen Navigation UI */}
      {viewMode === 'navigating' && (
        <NavigationPanel
          viewMode={viewMode}
          immersiveMode={immersiveMode}
          setImmersiveMode={setImmersiveMode}
          currentStep={currentStep}
          currentLeg={currentLeg}
          stops={stops}
          currentLegIndex={currentLegIndex}
          showNotesPreview={showNotesPreview}
          setShowNotesPreview={setShowNotesPreview}
          isVoiceEnabled={voiceEnabled}
          setIsVoiceEnabled={setVoiceEnabled}
          currentMapStyle={mapStyle}
          cycleMapStyle={() => {
            const styleList: ('streets' | 'satellite' | 'hybrid')[] = ['streets', 'satellite', 'hybrid'];
            const idx = styleList.indexOf(mapStyle);
            setMapStyle(styleList[(idx + 1) % styleList.length]);
          }}
          speedKmh={currentSpeed}
          distanceToNextStop={liveRoute ? formatDistance(liveRoute.distance) : '--'}
          etaToNextStop={getETA()}
          routeStats={routeStats}
          completedCount={completedCount}
          insets={insets}
          isRerouting={isRerouting}
          canUndo={undoHistory.length > 0}
          liveRoute={liveRoute}
          onStopNavigation={stopNavigation}
          onMarkDelivered={handleMarkDelivered}
          onMarkFailed={handleMarkFailed}
          onSkipStop={handleSkipStop}
          onUndoStop={handleUndo}
          onReroute={handleReroute}
          onShowRouteOverview={handleShowRouteOverview}
          onOpenSidebar={() => {
            setSidebarExpanded(true);
            Animated.spring(sidebarAnim, { toValue: 1, useNativeDriver: false }).start();
          }}
          onShareETA={handleShareETA}
          onCallCustomer={handleCallCustomer}
          getSuburbColor={getSuburbColor}
          // Swipe-to-preview between stops — purely navigational; no complete/fail side effects.
          onPreviewNextStop={() => {
            const max = (navigationData?.legs?.length || 0) - 1;
            if (currentLegIndex < max) setCurrentLegIndex(currentLegIndex + 1);
          }}
          onPreviewPrevStop={() => {
            if (currentLegIndex > 0) setCurrentLegIndex(currentLegIndex - 1);
          }}
          canPreviewNext={currentLegIndex < (navigationData?.legs?.length || 0) - 1}
          canPreviewPrev={currentLegIndex > 0}
          legs={navigationData?.legs || []}
          onJumpToStop={(idx: number) => {
            const max = (navigationData?.legs?.length || 0) - 1;
            const clamped = Math.max(0, Math.min(idx, max));
            setCurrentLegIndex(clamped);
          }}
        />
      )}

      {/* Collapsible Left Sidebar (planning only, hidden during refine mode) */}
      {viewMode === 'planning' && !isRefineMode && (
        <Sidebar
          sidebarExpanded={sidebarExpanded}
          stops={stops}
          completedCount={completedCount}
          totalWeight={totalWeight}
          routeStats={routeStats}
          routeFromCurrent={routeFromCurrent}
          optimizing={optimizing}
          optimizationHubs={optimizationHubs}
          stopsCollapsed={stopsCollapsed}
          isDragMode={isDragMode}          refreshing={refreshing}
          currentLocation={currentLocation}
          viewMode={viewMode}
          isRefineMode={isRefineMode}
          mlReadiness={mlReadiness}
          sidebarWidth={sidebarWidth}
          contentOpacity={contentOpacity}
          insets={insets}
          toggleSidebar={toggleSidebar}
          onAddStop={() => router.push('/add-stop')}
          onImport={() => router.push('/import')}
          onExport={handleExportXlsx}
          onOptimize={handleOptimize}
          onShowAlgorithmPicker={() => setShowAlgorithmPicker(true)}
          onBenchmark={() => setShowBenchmarkModal(true)}
          onStartNavigation={startNavigation}
          onStopNavigation={stopNavigation}
          onNewRoute={handleNewRoute}
          onClearHubs={() => {
            setOptimizationHubs([]);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
          onStopPress={(stop) => {
            setSelectedStopModal(stop);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          }}
          onProfilePress={() => router.push('/profile')}
          onHistoryPress={() => setShowHistoryModal(true)}
          onRefresh={onRefresh}
          onEnterRefineMode={enterRefineMode}
          setStopsCollapsed={setStopsCollapsed}
          setIsDragMode={setIsDragMode}
          onReorder={(stopIds) => { reorderStops(stopIds); }}
          getSuburbColor={getSuburbColor}
        />
      )}

      {/* Floating Refine Route Entry Button - on the map, visible in planning mode */}
      {!isRefineMode && viewMode === 'planning' && stops.length >= 2 && (
        <TouchableOpacity
          style={[styles.floatingRefineEntryBtn, { bottom: insets.bottom + 16 }]}
          onPress={enterRefineMode}
          activeOpacity={0.85}
          data-testid="refine-route-btn"
        >
          <Ionicons name="pencil" size={18} color="#fff" />
          <Text style={styles.floatingRefineEntryBtnText}>Refine Route</Text>
        </TouchableOpacity>
      )}

      {/* Confirm Route — explicit commit CTA that appears ONLY after a fresh
          optimisation completes. Bulletproof conditional: renders iff the
          post-success flag is up AND the solver is no longer running. Tap
          triggers startNavigation() which POSTs /api/routes/confirm (locking
          sequence_number in DB) then transitions to navigating mode. We
          clear the flag synchronously in onPress so double-taps can't
          trigger two confirm POSTs. */}
      {hasUnconfirmedOptimization && !optimizing && viewMode === 'planning' && !isRefineMode && (
        <TouchableOpacity
          style={[styles.confirmRouteBtn, { bottom: insets.bottom + 76 }]}
          onPress={() => {
            setHasUnconfirmedOptimization(false);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            // startNavigation() owns the confirm-then-navigate transition
            // — see the try/confirmRoute block we added earlier.
            startNavigation();
          }}
          activeOpacity={0.85}
          data-testid="confirm-route-btn"
        >
          <Ionicons name="checkmark-circle" size={20} color="#0f172a" />
          <Text style={styles.confirmRouteBtnText}>Confirm Route</Text>
        </TouchableOpacity>
      )}

      {/* Floating Map Layer Toggle - Parcels */}
      {viewMode === 'planning' && !isRefineMode && (
        <TouchableOpacity
          style={[styles.parcelToggleBtn, { top: insets.top + 12 }]}
          onPress={() => {
            const next = !showParcels;
            setShowParcels(next);
            mapRef.current?.toggleParcels(next);
          }}
          activeOpacity={0.8}
          data-testid="parcel-toggle-btn"
        >
          <Ionicons name="grid-outline" size={14} color={showParcels ? '#f59e0b' : '#94a3b8'} />
          <Text style={[styles.parcelToggleBtnText, showParcels && { color: '#f59e0b' }]}>Parcels</Text>
        </TouchableOpacity>
      )}

      {/* Floating Refine Mode Controls - Positioned over the map */}
      {isRefineMode && viewMode === 'planning' && (
        <View style={[styles.floatingRefinePanel, { bottom: insets.bottom + 16 }]} data-testid="refine-mode-controls">
          {isActivelyDrawing ? (
            <View style={styles.drawingStatusBar} data-testid="drawing-status-bar">
              <View style={styles.drawingPulse} />
              <Text style={styles.drawingStatusText}>Draw around stops to group them</Text>
              <TouchableOpacity 
                style={styles.cancelDrawingBtn}
                onPress={stopFreehandDrawing}
                data-testid="cancel-drawing-btn"
              >
                <Ionicons name="close-circle" size={24} color="#ef4444" />
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* Section Summary */}
              {drawnSections.length > 0 && (
                <View style={styles.sectionSummary} data-testid="section-summary">
                  {drawnSections.map((section, idx) => (
                    <View key={`section-${idx}`} style={[styles.sectionPill, { backgroundColor: section.color + '40' }]}>
                      <View style={[styles.sectionPillDot, { backgroundColor: section.color }]} />
                      <Text style={[styles.sectionPillText, { color: section.color }]}>
                        Group {section.id}: {section.stopIds.length} stops
                      </Text>
                    </View>
                  ))}
                </View>
              )}
              
              {/* Action Buttons Row */}
              <View style={styles.refineActionRow}>
                <TouchableOpacity 
                  style={[styles.refineActionBtn, drawnSections.length === 0 && styles.refineActionBtnDisabled]}
                  onPress={undoLastSection}
                  disabled={drawnSections.length === 0}
                  data-testid="undo-section-btn"
                >
                  <Ionicons name="arrow-undo" size={20} color={drawnSections.length > 0 ? "#fff" : "#94a3b8"} />
                  <Text style={[styles.refineActionBtnText, drawnSections.length === 0 && styles.refineActionBtnTextDisabled]}>Undo</Text>
                </TouchableOpacity>
                
                <TouchableOpacity 
                  style={styles.drawNextGroupBtn}
                  onPress={startFreehandDrawing}
                  data-testid="draw-next-group-btn"
                >
                  <Ionicons name="brush" size={20} color="#fff" />
                  <Text style={styles.drawNextGroupBtnText}>Draw group</Text>
                </TouchableOpacity>
                
                <TouchableOpacity 
                  style={[styles.reoptimizeBtn, drawnSections.length === 0 && styles.reoptimizeBtnDisabled]}
                  onPress={applySections}
                  disabled={drawnSections.length === 0 || optimizing}
                  data-testid="reoptimize-route-btn"
                >
                  {optimizing ? (
                    <ActivityIndicator size="small" color="white" />
                  ) : (
                    <>
                      <Ionicons name="refresh" size={18} color="white" />
                      <Text style={styles.reoptimizeBtnText}>Reoptimize</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
              
              {/* Exit Button */}
              <TouchableOpacity 
                style={styles.exitRefineBtn}
                onPress={exitRefineMode}
                data-testid="exit-refine-mode-btn"
              >
                <Ionicons name="close" size={16} color="rgba(255,255,255,0.7)" />
                <Text style={styles.exitRefineBtnText}>Exit drawing mode</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}


      {/* Algorithm Picker Modal */}
      <Modal
        visible={showAlgorithmPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAlgorithmPicker(false)}
        onShow={() => fetchRecommendation()}
      >
        <TouchableOpacity 
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowAlgorithmPicker(false)}
        >
          <View style={styles.algorithmModal}>
            <View style={styles.algorithmModalHeader}>
              <Text style={styles.algorithmModalTitle}>Select Algorithm</Text>
              <TouchableOpacity onPress={() => setShowAlgorithmPicker(false)}>
                <Ionicons name="close" size={24} color="#94a3b8" />
              </TouchableOpacity>
            </View>
            
            {recommendation && (
              <View style={styles.recommendationBanner} data-testid="algorithm-recommendation-banner">
                <Ionicons name="bulb" size={16} color="#f59e0b" />
                <Text style={styles.recommendationText}>
                  Recommended: <Text style={styles.recommendationHighlight}>{algorithms.find(a => a.id === recommendation.algorithm)?.name || recommendation.algorithm}</Text>
                  {' '}({Math.round(recommendation.confidence * 100)}% confidence)
                </Text>
              </View>
            )}
            
            <Text style={styles.algorithmModalSubtitle}>
              Choose optimization strategy for your route
            </Text>
            
            <ScrollView style={styles.algorithmList}>
              {algorithms.map((algo) => (
                <TouchableOpacity
                  key={algo.id}
                  style={[
                    styles.algorithmOption,
                    selectedAlgorithm === algo.id && styles.algorithmOptionSelected,
                    recommendation?.algorithm === algo.id && selectedAlgorithm !== algo.id && styles.algorithmOptionRecommended
                  ]}
                  onPress={() => {
                    setSelectedAlgorithm(algo.id as any);
                    setShowAlgorithmPicker(false);
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                >
                  <View style={styles.algorithmOptionContent}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={[
                        styles.algorithmOptionName,
                        selectedAlgorithm === algo.id && styles.algorithmOptionNameSelected
                      ]}>
                        {algo.name}
                      </Text>
                      {recommendation?.algorithm === algo.id && (
                        <View style={styles.recommendedBadge}>
                          <Text style={styles.recommendedBadgeText}>BEST FIT</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.algorithmOptionDesc}>{algo.desc}</Text>
                    {recommendation?.algorithm === algo.id && recommendation.reasoning && (
                      <Text style={styles.recommendationReason}>{recommendation.reasoning}</Text>
                    )}
                  </View>
                  {selectedAlgorithm === algo.id && (
                    <Ionicons name="checkmark-circle" size={24} color="#3b82f6" />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
            
            <TouchableOpacity
              style={styles.algorithmApplyBtn}
              onPress={() => {
                setShowAlgorithmPicker(false);
                handleOptimize();
              }}
            >
              <Ionicons name="sparkles" size={20} color="#fff" />
              <Text style={styles.algorithmApplyText}>Optimize with {algorithms.find(a => a.id === selectedAlgorithm)?.name.split(' ').slice(1).join(' ')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Benchmark Modal */}
      <BenchmarkModal
        visible={showBenchmarkModal}
        onClose={() => setShowBenchmarkModal(false)}
        currentLocation={currentLocation}
        onApplyAlgorithm={async (algo) => {
          setSelectedAlgorithm(algo as any);
          const result = await optimizeRoute({
            algorithm: algo,
            currentLatitude: currentLocation?.latitude,
            currentLongitude: currentLocation?.longitude,
            useCurrentLocation: !!currentLocation,
          });
          if (result) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
        }}
      />

      {/* Route completion celebration card — slides in from the top for ~4.5s after
          the last stop is marked delivered, then fades out. Purely informational,
          non-blocking (pointerEvents=none) so it doesn't hijack map interactions. */}
      {celebrationStats && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.celebrationCard,
            {
              opacity: celebrationCardAnim,
              transform: [{
                translateY: celebrationCardAnim.interpolate({ inputRange: [0, 1], outputRange: [-80, 0] }),
              }],
            },
          ]}
          data-testid="completion-stats-card"
        >
          <View style={styles.celebrationIconWrap}>
            <Ionicons name="trophy" size={22} color="#fbbf24" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.celebrationTitle}>Route complete!</Text>
            <Text style={styles.celebrationStatsLine}>
              {celebrationStats.stops} stops · {celebrationStats.distanceKm.toFixed(1)} km · {formatDuration(Math.floor(celebrationStats.durationMs / 1000))}
            </Text>
          </View>
        </Animated.View>
      )}

      {/* Paused indicator pill — surfaces after 10 s of stationary while navigating.
          Purely informational, pointerEvents=none so map interaction isn't blocked. */}
      {pausedSeconds !== null && (
        <Animated.View
          pointerEvents="none"
          style={[styles.pausedPill, { opacity: pausedPillOpacity }]}
          data-testid="paused-indicator-pill"
        >
          <Ionicons name="pause-circle" size={14} color="#fbbf24" />
          <Text style={styles.pausedPillText}>
            Paused · {Math.floor(pausedSeconds / 60)}:{String(pausedSeconds % 60).padStart(2, '0')}
          </Text>
        </Animated.View>
      )}

      {/* Route History Modal */}
      <HistoryModal
        visible={showHistoryModal}
        onClose={() => setShowHistoryModal(false)}
        onResume={async (routeId: string) => {
          try {
            const token = await AsyncStorage.getItem('session_token');
            const res = await fetch(`${BACKEND_URL}/api/routes/history/${routeId}/resume`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              credentials: 'include',
            });
            if (res.ok) {
              setShowHistoryModal(false);
              setRouteGeometry(null);
              setRouteStats(null);
              setNavigationData(null);
              setCurrentLegIndex(0);
              setViewMode('planning');
              await fetchStops();
              try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
            } else {
              // Surface the real failure reason so we stop chasing "Failed to resume route".
              // Backend now returns structured `detail` for 404 (not found), 400 (no stops),
              // 401 (session expired) and 500 (internal). We map them to actionable copy.
              let detail = '';
              try {
                const body = await res.json();
                detail = body?.detail || body?.message || '';
              } catch {
                try { detail = await res.text(); } catch {}
              }
              const human =
                res.status === 401 ? 'Your session expired. Please sign in again.' :
                res.status === 404 ? 'This route is no longer in history. Pull-to-refresh to update the list.' :
                res.status === 400 ? (detail || 'Archived route has no stops to resume.') :
                (detail || `Server error (${res.status}). Try again in a moment.`);
              Alert.alert('Could not resume route', human);
            }
          } catch (e: any) {
            Alert.alert(
              'Network error',
              `Could not reach the server. Check your connection and try again.\n\n${e?.message || ''}`,
            );
          }
        }}
        insets={insets}
      />

      {/* Stop Details Modal */}
      <Modal
        visible={!!selectedStopModal}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedStopModal(null)}
      >
        <KeyboardAvoidingView 
          style={styles.stopModalOverlay} 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <TouchableOpacity 
            style={styles.stopModalBackdrop} 
            activeOpacity={1} 
            onPress={() => setSelectedStopModal(null)}
          />
          <View style={styles.stopModalContent}>
            {selectedStopModal && (
              <ScrollView 
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                style={styles.stopModalScrollBody}
              >
                <View style={styles.stopModalHeader}>
                  <View style={[
                    styles.stopModalBadge,
                    { backgroundColor: getSuburbColor(selectedStopModal.suburb) }
                  ]}>
                    <Text style={styles.stopModalBadgeText}>
                      #{stops.findIndex(s => s.id === selectedStopModal.id) + 1}
                    </Text>
                  </View>
                  <TouchableOpacity 
                    onPress={() => setSelectedStopModal(null)}
                    style={styles.stopModalClose}
                  >
                    <Ionicons name="close" size={24} color="#64748b" />
                  </TouchableOpacity>
                </View>

                <View style={styles.stopModalBody}>
                  <Text style={styles.stopModalFieldLabel}>Address</Text>
                  <TextInput
                    style={styles.stopModalAddressInput}
                    value={editingStopAddress}
                    onChangeText={setEditingStopAddress}
                    placeholder="Enter stop address"
                    multiline
                    testID="stop-address-edit-input"
                  />

                  {selectedStopModal?.geocode_metadata?.geocode_needs_fix ? (
                    <View style={styles.stopModalNeedsFixBadge} testID="stop-needs-geocode-fix-badge">
                      <Ionicons name="warning-outline" size={14} color="#f59e0b" />
                      <Text style={styles.stopModalNeedsFixText}>Needs geocode fix</Text>
                    </View>
                  ) : null}

                  <View style={styles.stopModalAddressActions}>
                    <TouchableOpacity
                      style={[styles.stopModalAddressBtn, styles.stopModalAddressSaveBtn, savingStopAddress && styles.stopModalAddressBtnDisabled]}
                      onPress={handleSaveStopAddressOnly}
                      disabled={savingStopAddress}
                      testID="stop-address-save-button"
                    >
                      {savingStopAddress ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <>
                          <Ionicons name="save-outline" size={18} color="#fff" />
                          <Text style={styles.stopModalAddressBtnText}>Save Address</Text>
                        </>
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.stopModalAddressBtn, styles.stopModalAddressGeocodeBtn, regeocodingStop && styles.stopModalAddressBtnDisabled]}
                      onPress={handleRegeocodeSelectedStop}
                      disabled={regeocodingStop}
                      testID="stop-address-regeocode-button"
                    >
                      {regeocodingStop ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <>
                          <Ionicons name="locate-outline" size={18} color="#fff" />
                          <Text style={styles.stopModalAddressBtnText}>Re-geocode</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>

                  {selectedStopModal.suburb && (
                    <View style={styles.stopModalSuburbContainer}>
                      <Ionicons name="business" size={14} color="#8b5cf6" />
                      <Text style={styles.stopModalSuburb}>{selectedStopModal.suburb}</Text>
                    </View>
                  )}
                  
                  <View style={styles.stopModalStatus}>
                    {selectedStopModal.completed ? (
                      <>
                        <Ionicons name="checkmark-circle" size={18} color="#10b981" />
                        <Text style={[styles.stopModalStatusText, { color: '#10b981' }]}>
                          Completed
                        </Text>
                      </>
                    ) : (
                      <>
                        <Ionicons name="time-outline" size={18} color="#f59e0b" />
                        <Text style={[styles.stopModalStatusText, { color: '#f59e0b' }]}>
                          Pending
                        </Text>
                      </>
                    )}
                  </View>

                  {/* Notes — always visible. Was previously gated by
                      `viewMode !== 'navigating'` so the editor disappeared
                      mid-drive, but gate codes / parcel-count / "round-the-
                      back" instructions are exactly the info a driver
                      needs WHILE navigating to a stop. The editor stays
                      compact (4 lines), so it doesn't crowd the modal. */}
                  <View style={styles.stopModalNotesCard} testID="stop-notes-editor">
                      <View style={styles.stopModalNotesHeader}>
                        <Ionicons name="document-text-outline" size={16} color="#2563eb" />
                        <Text style={styles.stopModalNotesTitle}>Notes</Text>
                      </View>
                      <TextInput
                        style={styles.stopModalNotesInput}
                        placeholder="Gate code, parcel count, delivery instructions..."
                        placeholderTextColor="#94a3b8"
                        value={editingStopNotes}
                        onChangeText={setEditingStopNotes}
                        multiline
                        numberOfLines={4}
                        textAlignVertical="top"
                        testID="stop-notes-input"
                      />
                      <TouchableOpacity
                        style={[
                          styles.stopModalNotesSaveBtn,
                          (savingStopNotes || editingStopNotes.trim() === (selectedStopModal?.notes || '').trim()) && styles.stopModalAddressBtnDisabled,
                        ]}
                        onPress={handleSaveStopNotes}
                        disabled={savingStopNotes || editingStopNotes.trim() === (selectedStopModal?.notes || '').trim()}
                        testID="stop-notes-save-button"
                      >
                        {savingStopNotes ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <>
                            <Ionicons name="save-outline" size={16} color="#fff" />
                            <Text style={styles.stopModalAddressBtnText}>Save note</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                </View>

                <View style={styles.stopModalActions}>
                  <TouchableOpacity
                    style={[styles.stopModalBtn, styles.stopModalBtnDelete, deletingStop && styles.stopModalAddressBtnDisabled]}
                    onPress={handleDeleteSelectedStop}
                    disabled={deletingStop}
                    testID="stop-delete-button"
                  >
                    {deletingStop ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <Ionicons name="trash-outline" size={20} color="#fff" />
                        <Text style={styles.stopModalBtnText}>Delete</Text>
                      </>
                    )}
                  </TouchableOpacity>

                  {/* Insert into route — only meaningful when a route is
                      already running. Wedges this stop in BEFORE the
                      previously-next stop (becomes the new "next") so
                      the driver can take a courtesy stop without
                      replacing their optimised plan. Hidden when not
                      navigating; hidden if the tapped stop IS the
                      current target (would be a no-op). */}
                  {viewMode === 'navigating' && navigationData && selectedStopModal.id !== currentLeg?.to_stop?.id && (
                    <TouchableOpacity
                      style={[styles.stopModalBtn, styles.stopModalBtnInsert]}
                      onPress={() => {
                        const t = selectedStopModal;
                        setSelectedStopModal(null);
                        insertIntoRoute(t);
                      }}
                      testID="stop-modal-insert-button"
                    >
                      <Ionicons name="git-branch-outline" size={20} color="#fff" />
                      <Text style={styles.stopModalBtnText}>Insert</Text>
                    </TouchableOpacity>
                  )}

                  {!selectedStopModal.completed && (
                    <TouchableOpacity
                      style={[styles.stopModalBtn, styles.stopModalBtnComplete]}
                      onPress={async () => {
                        // Phase 0 — same GPS payload as the navigation-mode tap
                        // so manual marks from the stop sheet contribute to the
                        // building-side / service-time learning corpus too.
                        const gps = currentLocation
                          ? {
                              lat: currentLocation.latitude,
                              lng: currentLocation.longitude,
                            }
                          : undefined;
                        await completeStop(selectedStopModal.id, gps);
                        syncNavCompletion(selectedStopModal.id, true);
                        setSelectedStopModal(null);
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      }}
                    >
                      <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
                      <Text style={styles.stopModalBtnText}>Mark Complete</Text>
                    </TouchableOpacity>
                  )}
                  
                  {selectedStopModal.completed && (
                    <TouchableOpacity
                      style={[styles.stopModalBtn, { backgroundColor: '#f59e0b' }]}
                      onPress={async () => {
                        await uncompleteStop(selectedStopModal.id);
                        syncNavCompletion(selectedStopModal.id, false);
                        setSelectedStopModal(null);
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                      }}
                      data-testid="stop-uncomplete-button"
                    >
                      <Ionicons name="arrow-undo" size={20} color="#fff" />
                      <Text style={styles.stopModalBtnText}>Undo Complete</Text>
                    </TouchableOpacity>
                  )}
                  
                  <TouchableOpacity
                    style={[styles.stopModalBtn, styles.stopModalBtnNavigate]}
                    onPress={() => {
                      // In-app navigation. The shared launcher handles
                      // the OSRM fetch + cockpit hand-off (with straight-
                      // line fallback if the directions endpoint is
                      // unreachable).
                      const targetStop = selectedStopModal;
                      setSelectedStopModal(null);
                      startSingleStopNavigation(targetStop);
                    }}
                    testID="stop-modal-navigate-button"
                  >
                    <Ionicons name="navigate-outline" size={20} color="#fff" />
                    <Text style={styles.stopModalBtnText}>Navigate</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  offlineBannerWrap: {
    position: 'absolute',
    left: 12, right: 12,
    alignItems: 'center',
    zIndex: 10000,
    elevation: 10,
  },
  clusterWarningsWrap: {
    position: 'absolute',
    // Wrap is full-width. The banner children skip the chevron column via
    // the wrap's `paddingLeft: 56` (sidebar collapsed width).
    // Positioned at the bottom of the screen to avoid overlaying top header buttons.
    left: 0, right: 0,
    paddingLeft: 56,
    zIndex: 9000,
    elevation: 9,
  },
  offlineBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8,
    paddingVertical: 6, paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: '#fbbf24',   // amber-400 — visible but not alarming
  },
  offlineBannerText: {
    color: '#111827',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  offlineBannerPanel: {
    marginTop: 6,
    alignSelf: 'stretch',
    backgroundColor: '#fffbeb',   // amber-50
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#fcd34d',       // amber-300
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  offlineBannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#fde68a',  // amber-200
  },
  offlineBannerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  offlineBannerRowLabel: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '600',
  },
  offlineBannerRowMeta: {
    color: '#78350f',             // amber-900
    fontSize: 11,
    marginTop: 2,
  },
  offlineBannerFooter: {
    color: '#78350f',
    fontSize: 11,
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 6,
  },
  offlineBannerActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingTop: 10,
    paddingBottom: 2,
  },
  offlineBannerRetryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: '#fcd34d',   // amber-300
    borderWidth: 1,
    borderColor: '#f59e0b',       // amber-500
  },
  offlineBannerRetryText: {
    color: '#111827',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  offlineBannerSwipeAction: {
    backgroundColor: '#dc2626',    // red-600
    justifyContent: 'center',
    alignItems: 'center',
    width: 96,
    paddingHorizontal: 8,
    marginVertical: 0,
  },
  offlineBannerSwipeActionText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginTop: 2,
  },
  undoToastWrap: {
    position: 'absolute',
    left: 12, right: 12,
    alignItems: 'center',
    zIndex: 10001,
    elevation: 11,
  },
  undoToast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(17, 24, 39, 0.96)',  // gray-900 @ 96%
    borderWidth: 1,
    borderColor: 'rgba(75, 85, 99, 0.6)',
    minWidth: 280,
    maxWidth: 420,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  undoToastTitle: {
    color: '#f9fafb',
    fontSize: 13,
    fontWeight: '700',
  },
  undoToastSubtitle: {
    color: '#9ca3af',
    fontSize: 11,
    marginTop: 1,
  },
  undoToastBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(251, 191, 36, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.6)',
  },
  undoToastBtnText: {
    color: '#fbbf24',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  resumeToastWrap: {
    position: 'absolute',
    left: 0, right: 0,
    alignItems: 'center',
    zIndex: 10002,
    elevation: 12,
  },
  resumeToast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(22, 163, 74, 0.95)', // green-600
    borderWidth: 1,
    borderColor: 'rgba(134, 239, 172, 0.4)',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  resumeToastText: {
    color: '#f0fdf4',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  // Amber variant for "stay here" / multi-parcel warnings. Same pill geometry,
  // angrier colour palette so it's visually distinct from the green resume pill.
  resumeToastWarning: {
    backgroundColor: 'rgba(251, 191, 36, 0.96)',  // amber-400
    borderColor: 'rgba(120, 53, 15, 0.6)',         // amber-900
    paddingVertical: 10,
    paddingHorizontal: 16,
    maxWidth: '92%',
  },
  resumeToastTextWarning: {
    color: '#451a03',  // amber-950 — high contrast on amber-400
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.4,
    flexShrink: 1,
  },
  // Centred "RESUMING AT #N" card — high-contrast, scale-in, 400 ms dwell.
  resumingOverlayWrap: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10003,
    elevation: 14,
  },
  resumingOverlay: {
    alignItems: 'center',
    paddingVertical: 18,
    paddingHorizontal: 32,
    borderRadius: 20,
    backgroundColor: 'rgba(15, 23, 42, 0.92)', // slate-900 / 92%
    borderWidth: 1,
    borderColor: 'rgba(134, 239, 172, 0.35)',
    elevation: 16,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  resumingOverlayLabel: {
    color: '#86efac', // green-300
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2.2,
    marginBottom: 2,
  },
  resumingOverlayPin: {
    color: '#f8fafc',
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  celebrationCard: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    minWidth: 280,
    maxWidth: 420,
    borderRadius: 14,
    backgroundColor: 'rgba(17, 24, 39, 0.92)',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.4)',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    zIndex: 9999,
  },
  celebrationIconWrap: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(251, 191, 36, 0.15)',
    borderWidth: 1, borderColor: 'rgba(251, 191, 36, 0.45)',
  },
  celebrationTitle: {
    color: '#fbbf24', fontSize: 15, fontWeight: '700', marginBottom: 2,
  },
  celebrationStatsLine: {
    color: '#e5e7eb', fontSize: 13, fontWeight: '500',
  },
  pausedPill: {
    position: 'absolute',
    top: 58,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(17, 24, 39, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.35)',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    zIndex: 9998,
  },
  pausedPillText: {
    color: '#fde68a',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
    flexDirection: 'row',
  },
  mapContainer: {
    flex: 1,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  map: {
    flex: 1,
  },
  mapPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f1f5f9',
  },
  mapPlaceholderText: {
    color: '#475569',
    marginTop: 12,
  },
  
  // Circuit-style Navigation UI
  // ============================================
  // IMMERSIVE NAVIGATION STYLES - Maximum Map View
  // ============================================
  
  // Floating Turn Banner - Minimal top bar
  immersiveTurnBanner: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.08)',
    zIndex: 20,
  },
  immersiveManeuver: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  immersiveTurnInfo: {
    flex: 1,
  },
  immersiveTurnDistance: {
    color: '#1d4ed8',
    fontSize: 13,
    fontWeight: '700',
  },
  immersiveTurnText: {
    color: '#0f172a',
    fontSize: 15,
    fontWeight: '600',
  },
  immersiveExitBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  
  // Floating Speed Display - Left side
  immersiveSpeedDisplay: {
    position: 'absolute',
    left: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.08)',
    zIndex: 15,
  },
  immersiveSpeedValue: {
    color: '#0f172a',
    fontSize: 28,
    fontWeight: '800',
  },
  immersiveSpeedUnit: {
    color: '#475569',
    fontSize: 11,
    fontWeight: '600',
  },
  
  // Stats Row - Right side (ETA + Distance)
  immersiveStatsRow: {
    position: 'absolute',
    right: 12,
    flexDirection: 'row',

    zIndex: 15,
  },
  immersiveStatChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,

    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.08)',
  },
  immersiveStatText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
  
  // Full Bottom Panel
  immersiveBottomFull: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 16,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.08)',
    zIndex: 20,
  },
  immersiveStopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  immersiveStopBadge: {
    flexDirection: 'row',
    alignItems: 'baseline',
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 12,
  },
  immersiveStopNum: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
  },
  immersiveStopOf: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: '500',
  },
  immersiveStopInfo: {
    flex: 1,
  },
  immersiveStopName: {
    color: '#0f172a',
    fontSize: 16,
    fontWeight: '700',
  },
  immersiveStopAddress: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 2,
  },
  immersiveDetailsRow: {
    flexDirection: 'row',
    alignItems: 'center',

    marginBottom: 12,
    paddingHorizontal: 4,
  },
  immersiveDetailChip: {
    flexDirection: 'row',
    alignItems: 'center',

    backgroundColor: '#f1f5f9',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  immersiveDetailText: {
    color: '#475569',
    fontSize: 13,
    fontWeight: '600',
  },
  immersiveVoiceBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  
  // Quick Actions Row
  immersiveQuickRow: {
    flexDirection: 'row',
    justifyContent: 'center',

    marginBottom: 12,
  },
  immersiveQuickBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  
  // Main Action Buttons
  immersiveMainActions: {
    flexDirection: 'row',
    alignItems: 'center',

    marginBottom: 8,
  },
  immersiveSkipBtn: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1.5,
    borderColor: 'rgba(245, 158, 11, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  immersiveDeliveredBtn: {
    flex: 1,
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#10b981',
    borderRadius: 16,

  },
  immersiveDeliveredText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  immersiveFailedBtn: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1.5,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  
  // Minimal Bottom Bar (Immersive Mode)
  immersiveBottomMinimal: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.08)',
    zIndex: 20,
  },
  immersiveMinimalInfo: {
    flexDirection: 'row',
    alignItems: 'center',

  },
  immersiveMinimalStop: {
    color: '#334155',
    fontSize: 14,
    fontWeight: '600',
  },
  immersiveMinimalDelivered: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#10b981',
    justifyContent: 'center',
    alignItems: 'center',
  },
  
  // Sidebar styles
  sidebar: {
    backgroundColor: 'rgba(255, 255, 255, 0.97)',
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    zIndex: 10,
  },
  sidebarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  sidebarTitle: {
    color: '#0f172a',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  toggleButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerButtons: {
    flexDirection: 'row',
    alignItems: 'center',

  },
  profileButton: {
    padding: 4,
  },
  statsCompact: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 12,

    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  statCompactItem: {
    flexDirection: 'row',
    alignItems: 'center',

  },
  statCompactIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.06)',
  },
  statCompactValue: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
  expandedContent: {
    flex: 1,
  },
  routeStats: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,

    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  routeStatRow: {
    flexDirection: 'row',
    alignItems: 'center',

  },
  routeStatText: {
    color: '#475569',
    fontSize: 13,
    fontWeight: '600',
  },
  sidebarActions: {
    padding: 12,

    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,

    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  actionBtnText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
  actionBtnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#3b82f6',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,

  },
  actionBtnStart: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#10b981',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,

  },
  actionBtnNewRoute: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,

    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  actionBtnNewRouteText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '500',
  },
  actionBtnClearHubs: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',

    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    marginTop: 8,
  },
  actionBtnClearHubsText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '500',
  },
  hubHintContainer: {
    flexDirection: 'row',
    alignItems: 'center',

    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
  },
  hubHintText: {
    color: '#6b7280',
    fontSize: 11,
    flex: 1,
  },
  actionBtnPrimaryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  actionBtnDisabled: {
    opacity: 0.5,
  },
  optimizeButtonContainer: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  optimizeMainBtn: {
    flex: 1,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
  },
  algorithmPickerBtn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stopsSection: {
    flex: 1,
    paddingTop: 12,
  },
  stopsSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  stopsSectionTitle: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  stopsCount: {
    color: '#3b82f6',
    fontSize: 12,
    fontWeight: '600',
  },
  stopsList: {
    flex: 1,
    paddingHorizontal: 8,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyStateText: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 12,
  },
  stopItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  stopItemCompleted: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.2)',
  },
  stopItemPressed: {
    backgroundColor: '#e2e8f0',
  },
  stopIndex: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#3b82f6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
    paddingHorizontal: 6,
  },
  stopIndexCompleted: {
    backgroundColor: '#10b981',
  },
  stopIndexHigh: {
    backgroundColor: '#ef4444',
  },
  stopIndexLow: {
    backgroundColor: '#6b7280',
  },
  stopIndexText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  stopInfo: {
    flex: 1,
  },
  stopName: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
  stopNameCompleted: {
    color: '#64748b',
    textDecorationLine: 'line-through',
  },
  stopWeight: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 4,
    fontWeight: '500',
  },
  collapsedActions: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',

  },
  collapsedBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  collapsedBtnStart: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#10b981',
    justifyContent: 'center',
    alignItems: 'center',
  },
  collapsedBtnStop: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  collapsedBtnDisabled: {
    opacity: 0.4,
  },
  collapsedBtnNewRoute: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  // Suburb grouping styles
  suburbGroup: {
    marginBottom: 12,
  },
  suburbHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,

  },
  suburbTitle: {
    color: '#8b5cf6',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  suburbCount: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '700',
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  // Drag and drop styles
  reorderToggle: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  reorderToggleActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
  },
  dragListContainer: {
    flex: 1,
  },
  dragHint: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 8,
    fontStyle: 'italic',
  },
  dragHandle: {
    width: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 4,
  },
  stopItemDragging: {
    backgroundColor: '#f1f5f9',
    borderColor: '#2563eb',
    borderWidth: 2,
    transform: [{ scale: 1.02 }],
  },
  stopSuburb: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2,
  },
  
  // Algorithm Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  algorithmModal: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 20,
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  algorithmModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  algorithmModalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0f172a',
  },
  algorithmModalSubtitle: {
    fontSize: 14,
    color: '#475569',
    marginBottom: 16,
    fontWeight: '600',
  },
  algorithmList: {
    maxHeight: 350,
  },
  algorithmOption: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  algorithmOptionSelected: {
    borderColor: '#2563eb',
    backgroundColor: 'rgba(37, 99, 235, 0.08)',
  },
  algorithmOptionContent: {
    flex: 1,
  },
  algorithmOptionName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 4,
  },
  algorithmOptionNameSelected: {
    color: '#2563eb',
  },
  algorithmOptionDesc: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '600',
  },
  algorithmOptionRecommended: {
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(245, 158, 11, 0.06)',
  },
  recommendationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  recommendationText: {
    fontSize: 13,
    color: '#92400e',
    flex: 1,
  },
  recommendationHighlight: {
    fontWeight: '700',
    color: '#b45309',
  },
  recommendedBadge: {
    backgroundColor: '#f59e0b',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  recommendedBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#fff',
  },
  recommendationReason: {
    fontSize: 11,
    color: '#92400e',
    fontStyle: 'italic',
    marginTop: 4,
  },
  algorithmApplyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 16,

  },
  algorithmApplyText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  // Stop Modal Styles
  stopModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  stopModalBackdrop: {
    flex: 1,
  },
  stopModalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 32,
    maxHeight: '85%',
  },
  stopModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  stopModalBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stopModalBadgeText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  stopModalClose: {
    padding: 8,
  },
  stopModalBody: {
    marginBottom: 24,
  },
  stopModalScrollBody: {
    flexGrow: 0,
  },
  stopModalFieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  stopModalAddressInput: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#0f172a',
    lineHeight: 22,
    backgroundColor: '#f8fafc',
    minHeight: 58,
    marginBottom: 10,
  },
  stopModalAddress: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: 12,
    lineHeight: 24,
  },
  stopModalNeedsFixBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 10,
  },
  stopModalNeedsFixText: {
    color: '#b45309',
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 6,
  },
  stopModalAddressActions: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  stopModalAddressBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  stopModalAddressSaveBtn: {
    backgroundColor: '#334155',
  },
  stopModalAddressGeocodeBtn: {
    backgroundColor: '#2563eb',
  },
  stopModalAddressBtnDisabled: {
    opacity: 0.65,
  },
  stopModalAddressBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    marginLeft: 6,
  },
  stopModalSuburbContainer: {
    flexDirection: 'row',
    alignItems: 'center',

    marginBottom: 16,
  },
  stopModalSuburb: {
    fontSize: 14,
    color: '#64748b',
    fontWeight: '500',
  },
  stopModalStatus: {
    flexDirection: 'row',
    alignItems: 'center',

  },
  stopModalStatusText: {
    fontSize: 14,
    fontWeight: '600',
  },
  stopModalNotesCard: {
    marginTop: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    backgroundColor: '#eff6ff',
    padding: 12,
  },
  stopModalNotesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stopModalNotesTitle: {
    color: '#1d4ed8',
    fontSize: 13,
    fontWeight: '700',
  },
  stopModalNotesInput: {
    marginTop: 10,
    minHeight: 88,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#dbeafe',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#0f172a',
    fontSize: 14,
    lineHeight: 20,
  },
  stopModalNotesSaveBtn: {
    marginTop: 10,
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#2563eb',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  stopModalActions: {

  },
  stopModalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,

  },
  stopModalBtnComplete: {
    backgroundColor: '#10b981',
  },
  stopModalBtnNavigate: {
    backgroundColor: '#3b82f6',
  },
  stopModalBtnInsert: {
    // Distinct teal — not green (Mark Complete) and not blue (Navigate),
    // so the driver doesn't conflate "wedge a courtesy stop" with either
    // a finishing action or a re-route action. Sits between Delete
    // (destructive, red) and Mark Complete (success, green) in the row.
    backgroundColor: '#0ea5e9',
  },
  stopModalBtnDelete: {
    backgroundColor: '#dc2626',
  },
  stopModalBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  // Refine Mode Styles
  refineModeContainer: {
    backgroundColor: '#fafafa',
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  // New Bottom Bar Styles for Refine Mode
  floatingRefinePanel: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderRadius: 20,
    padding: 16,
    zIndex: 20,
    elevation: 10,
  },
  refineModeBottomBar: {
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderRadius: 16,
    padding: 16,
    marginTop: 8,
    marginBottom: 8,
  },
  drawingStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(254, 243, 199, 0.15)',
    padding: 12,
    borderRadius: 12,
  },
  drawingStatusText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#fbbf24',
    marginLeft: 10,
  },
  cancelDrawingBtn: {
    padding: 4,
  },
  sectionSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  sectionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 20,
    marginRight: 8,
    marginBottom: 6,
  },
  sectionPillDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  sectionPillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  refineActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  refineActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  refineActionBtnDisabled: {
    opacity: 0.5,
  },
  refineActionBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#e2e8f0',
    marginLeft: 6,
  },
  refineActionBtnTextDisabled: {
    color: '#94a3b8',
  },
  drawNextGroupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: 'rgba(139, 92, 246, 0.3)',
    borderWidth: 1,
    borderColor: '#8b5cf6',
  },
  drawNextGroupBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#c4b5fd',
    marginLeft: 8,
  },
  reoptimizeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#3b82f6',
  },
  reoptimizeBtnDisabled: {
    backgroundColor: '#93c5fd',
  },
  reoptimizeBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
    marginLeft: 6,
  },
  exitRefineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    marginTop: 4,
  },
  exitRefineBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: 'rgba(255, 255, 255, 0.6)',
    marginLeft: 6,
  },
  refineModeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  refineModeTitle: {
    flexDirection: 'row',
    alignItems: 'center',

  },
  refineModeHeaderText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
  },
  refineModeHint: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 12,
    lineHeight: 18,
  },
  startDrawingBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#8b5cf6',

    marginBottom: 12,
  },
  startDrawingBtnActive: {
    backgroundColor: '#fef2f2',
    borderColor: '#ef4444',
  },
  startDrawingBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#8b5cf6',
  },
  startDrawingBtnTextActive: {
    color: '#ef4444',
  },
  drawingActiveIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef3c7',
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,

  },
  drawingPulse: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#f59e0b',
  },
  drawingActiveText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#92400e',
    flex: 1,
  },
  sectionList: {
    marginBottom: 12,

  },
  sectionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 10,
    borderRadius: 8,

    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  sectionBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sectionBadgeText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
  sectionItemText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
  },
  refineModeEmpty: {
    alignItems: 'center',
    paddingVertical: 20,

  },
  refineModeEmptyText: {
    fontSize: 14,
    color: '#9ca3af',
    fontWeight: '500',
  },
  refineModeActions: {
    flexDirection: 'row',
    justifyContent: 'center',

    marginBottom: 12,
  },
  refineModeActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',

    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  refineModeActionBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748b',
  },
  refineModeApplyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#8b5cf6',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,

  },
  refineModeApplyBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
  floatingRefineEntryBtn: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#7c3aed',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 24,
    zIndex: 15,
    elevation: 8,
    shadowColor: '#7c3aed',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  floatingRefineEntryBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 8,
  },
  // Confirm Route — positioned above the Refine pill, amber/green palette
  // so it reads as the primary commit CTA against the neutral map.
  confirmRouteBtn: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#10b981',
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 28,
    zIndex: 16,
    elevation: 10,
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
  },
  confirmRouteBtnText: {
    color: '#0f172a',
    fontSize: 15,
    fontWeight: '800',
    marginLeft: 8,
    letterSpacing: 0.3,
  },
  parcelToggleBtn: {
    position: 'absolute',
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    zIndex: 15,
  },
  parcelToggleBtnText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 5,
  },
});
