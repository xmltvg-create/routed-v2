import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { enqueue, flush, getQueuedIds, removeById as removeQueuedById, getQueuedActions, type QueueAction } from '../utils/syncQueue';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

export interface TimeWindow {
  start?: string;
  end?: string;
}

export interface Stop {
  id: string;
  _id?: string;  // MongoDB ID - may be present in some responses
  user_id: string;
  address: string;
  name?: string;
  suburb?: string;
  latitude: number;
  longitude: number;
  /** ML Phase 2 auto-snap: corrected centroid for pin rendering (raw
   *  centroid + learned suburb offset). Set by GET /api/stops when the
   *  user has a trained building-side model. Frontend prefers these
   *  for map pin placement, falling back to latitude/longitude. */
  display_latitude?: number | null;
  display_longitude?: number | null;
  priority: string;
  time_window?: TimeWindow;
  notes?: string;
  mobile_number?: string;  // Customer phone number from XLS import
  weight?: number;
  quantity?: number;
  /** Optional carrier tracking number / barcode — used by the Van Loading
   *  Assistant to match scanned barcodes against stops. NOT unique. */
  tracking_number?: string | null;
  geocode_metadata?: Record<string, any>;
  delivery_status?: 'pending' | 'delivered' | 'skipped' | 'failed';
  failure_reason?: string;
  completed?: boolean;
  completed_at?: string;
  /** Phase 0 instrumentation — set on geofence arrival / delivery tap. */
  arrived_at?: string;
  arrival_lat?: number;
  arrival_lng?: number;
  arrival_accuracy_m?: number;
  completion_lat?: number;
  completion_lng?: number;
  completion_accuracy_m?: number;
  /** Set when the driver taps "Start" (confirmRoute). 1-based rank in the
   *  driver's committed tour. `null`/undefined means the stop is not part
   *  of the currently-locked route (unoptimised, added post-confirmation,
   *  or explicitly excluded). GET /api/stops sorts non-null first. */
  sequence_number?: number | null;
  /** Sharpie-marker badge — written ONCE on the first POST /routes/confirm
   *  and never overwritten. Drives the visible badge on every stop UI so
   *  re-optimisation can reshuffle the drive order without changing the
   *  number written on the physical box. Reset only when the row itself
   *  is deleted (delete_all_stops / archive_route end-of-shift). */
  original_sequence?: number | null;
  order: number;
  created_at: string;
}

/** Best-effort GPS fix passed alongside arrival / delivery events. All fields
 *  optional because location permissions can be revoked or the fix can be
 *  too stale to trust — the backend treats absence as "no signal". */
export interface GpsFix {
  lat?: number;
  lng?: number;
  accuracy_m?: number;
}

export interface StopCreate {
  address: string;
  name?: string;
  suburb?: string;
  latitude: number;
  longitude: number;
  priority?: string;
  time_window?: TimeWindow;
  notes?: string;
  weight?: number;
  quantity?: number;
  geocode_metadata?: Record<string, any>;
  delivery_status?: 'pending' | 'delivered' | 'skipped' | 'failed';
  failure_reason?: string;
}

export interface StopUpdate {
  address?: string;
  name?: string;
  suburb?: string;
  latitude?: number;
  longitude?: number;
  priority?: string;
  time_window?: TimeWindow;
  notes?: string;
  weight?: number;
  quantity?: number;
  geocode_metadata?: Record<string, any>;
  delivery_status?: 'pending' | 'delivered' | 'skipped' | 'failed';
  failure_reason?: string;
  order?: number;
  /** Carrier tracking number / barcode reference. PATCH-able so a driver
   *  can manually attach a tracking ID to a stop whose import didn't
   *  carry one (or whose label scanner didn't fire) — the van-scan
   *  barcode lookup will pick it up on the next pass. */
  tracking_number?: string | null;
}

interface ShadowResult {
  algorithm: string;
  total_distance_km: number;
  time_ms: number;
  savings_km: number;
  quality?: {
    backtrack_count: number;
    backtrack_ratio: number;
    longest_leg_km: number;
    shortest_leg_km: number;
    leg_variance: number;
    cluster_score: number;
  };
  error?: string | null;
}

interface OptimizeResult {
  message: string;
  algorithm: string;
  reasoning: string;
  total_distance_km: number;
  stop_count: number;
  started_from_current_location: boolean;
  stops: Stop[];
  shadow?: ShadowResult | null;
  clusters?: ClusterInfo[];
  quality_badge?: QualityBadge | null;
  time_savings?: TimeSavings | null;
  cluster_warnings?: ClusterWarning[];
  optimized_sequence?: string[];
}

export interface QualityBadge {
  baseline_algorithm: string;
  baseline_km: number;
  optimized_km: number;
  saved_km: number;
  saved_pct: number;
  improved: boolean;
}

export interface TimeSavings {
  baseline_seconds: number;
  optimized_seconds: number;
  saved_seconds: number;
  saved_minutes: number;
  saved_pct: number;
  improved: boolean;
}

/** A "this looks zig-zaggy on the map" warning surfaced post-optimisation by
 *  the backend's `detect_cluster_spikes` sweep. The driver can tap it to fire
 *  `/api/optimize/tighten-cluster` for that specific suspect, or use the
 *  banner CTA to fire `/api/optimize/tighten-clusters` for all of them. */
export interface ClusterWarning {
  position: number;     // index of the spike in the optimised stop list
  prev_id: string;
  suspect_id: string;
  next_id: string;
  straight_km: number;
  detour_km: number;
  ratio: number;
  extra_km: number;
}

/** Shape returned by both `/api/optimize/tighten-cluster` (singular) and
 *  `/api/optimize/tighten-clusters` (batch). They share these fields so the
 *  UI can render one consistent toast either way. */
export interface TightenResult {
  message: string;
  rolled_back: boolean;
  haversine_km_before: number;
  haversine_km_after: number;
  saved_km: number;
  driving_seconds_before: number | null;
  driving_seconds_after: number | null;
  driving_seconds_saved: number | null;
  stops: Stop[];
  optimized_sequence: string[];
  cluster_warnings: ClusterWarning[];
  // Batch-only:
  moves?: Array<{ moved_stop_id: string; from_position: number; to_position: number; saved_km: number }>;
  passes?: number;
  // Singular-only:
  moved_stop_id?: string;
  from_position?: number;
  to_position?: number;
}

export interface ClusterInfo {
  id: number;
  visit_order: number;
  stop_count: number;
  centroid: { latitude: number; longitude: number };
  polygon: number[][];
  fill_color: string;
  border_color: string;
  label: string;
}

export interface BenchmarkResult {
  algorithm: string;
  total_distance_km: number;
  time_ms: number;
  quality?: {
    backtrack_count: number;
    backtrack_ratio: number;
    longest_leg_km: number;
    shortest_leg_km: number;
    leg_variance: number;
    cluster_score: number;
  };
  error?: string | null;
}

interface BenchmarkResponse {
  stop_count: number;
  results: BenchmarkResult[];
  winner: string | null;
  started_from_current_location: boolean;
}

interface OptimizationHub {
  id: string;
  latitude: number;
  longitude: number;
  order: number;
}

interface RefinementSection {
  id: number;
  stop_ids: string[];
}

interface OptimizeOptions {
  // Backend accepts any of ~14 legacy ids — keep `string` so future
  // additions don't require a type sweep. The picker is narrowed
  // separately in index.tsx so the UI surface stays tight.
  algorithm?: string;
  currentLatitude?: number;
  currentLongitude?: number;
  useCurrentLocation?: boolean;
  hubs?: OptimizationHub[];
  sections?: RefinementSection[];  // For route refinement - lasso-drawn sections
  startTime?: string;  // ISO-8601 wall-clock start; used for school-zone avoidance
}

export interface AlgorithmRecommendation {
  algorithm: string;
  confidence: number;
  reasoning: string;
  alternatives?: string[];
}

export interface RouteCharacteristics {
  stop_count: number;
  spread_km: number;
  avg_distance_km: number;
  avg_nn_distance_km: number;
  cluster_ratio: number;
  cluster_count: number;
  complexity: string;
}

/** Geo-outlier flagged by `/api/stops/outliers`. A stop sitting more than
 *  `threshold_km` from the median cluster centroid — overwhelmingly the
 *  signature of a mis-geocoded address. The frontend banner reads this
 *  shape and offers per-stop trash + "Remove all far stops" actions. */
export interface OutlierStop {
  id: string;
  address: string;
  name?: string;
  latitude: number;
  longitude: number;
  /** Great-circle km from the median cluster centroid. */
  distance_km: number;
  completed: boolean;
}

export interface OutlierReport {
  /** `null` when fewer than 3 stops have coordinates — median is undefined. */
  centroid: { lat: number; lng: number } | null;
  threshold_km: number;
  total_stops: number;
  outliers: OutlierStop[];
}

interface StopsStore {
  stops: Stop[];
  loading: boolean;
  optimizing: boolean;
  benchmarking: boolean;
  tighteningClusters: boolean;
  lastBenchmark: BenchmarkResponse | null;
  recommendation: AlgorithmRecommendation | null;
  routeCharacteristics: RouteCharacteristics | null;
  /** Cluster-spike warnings from the most recent optimise. Cleared after
   *  any successful tighten action so banners don't outlive their data. */
  clusterWarnings: ClusterWarning[];
  /** Snapshot of `/api/stops/outliers` — stops too far from the median
   *  cluster centroid to plausibly belong on this run. Refreshed on every
   *  `fetchStops()` (best-effort: a failed call leaves prior outliers
   *  intact, so a transient 5xx doesn't make a banner flicker). The UI
   *  shows a red banner whenever `outliers.length > 0`. */
  outlierReport: OutlierReport | null;
  /** Most recent optimize failure — cleared on every Optimise press.
   *  `status` is the HTTP code (401 for expired session, 5xx for solver
   *  errors, null for network/timeout). The screen reads this to render
   *  an Alert with an actionable message instead of the spinner just
   *  silently disappearing. */
  lastOptimizeError: { status: number | null; message: string; upgradeRequired?: boolean } | null;
  /** Surfaced when GET /api/stops fails (401 expired session, 5xx, network).
   *  UI reads this so a silent failure doesn't masquerade as "you have no
   *  stops" — the most-common cause of "import worked but list is empty"
   *  reports has been a 401 here that the catch block swallowed. */
  lastFetchError: { status: number | null; message: string } | null;
  /** Snapshot of the most recent successful optimise — forwarded to
   *  `/api/routes/archive` so the archive carries the algorithm and
   *  totals into `route_history.summary`. Lets `/api/_meta/telemetry-rollup`
   *  answer "which profile did I use today?" without us having to
   *  thread algorithm through every intermediate state. Cleared on
   *  archive success. Null before the first Optimise of a session. */
  lastAlgorithm: string | null;
  lastDistanceKm: number | null;
  lastDurationSec: number | null;
  /** Set of stop IDs marked as loaded into the van by the barcode scanner.
   *  Lives only in memory — single-pass audit per loading session, resets
   *  when the app is force-closed. Surfaced as a green "✓ Loaded" chip on
   *  stop list cards so drivers can cross-check the manifest visually
   *  after scanning. Set is read-only from outside; mutate via
   *  `markStopLoaded` / `clearLoadedStops`. */
  loadedStopIds: Set<string>;
  markStopLoaded: (stopId: string) => void;
  clearLoadedStops: () => void;
  /** Cross-screen "start in-app navigation to this stop" intent. Set by any
   *  surface that wants to hand off the driver into the navigating cockpit
   *  (currently the stop-detail page's Navigate button — landing point for
   *  this is `(tabs)/index.tsx` which watches the field, fires the same
   *  single-stop nav flow used by the on-map marker modal, then clears
   *  the intent). Cleared on consume, on auth logout, and on app cold-start.
   *  Plain string-or-null because URL-encoding stop ids through tab router
   *  params is unreliable on Android (the tab is persisted across mounts). */
  pendingNavTargetId: string | null;
  setPendingNavTarget: (stopId: string | null) => void;
  fetchStops: () => Promise<void>;
  addStop: (stop: StopCreate) => Promise<Stop>;
  updateStop: (id: string, updates: StopUpdate) => Promise<void>;
  deleteStop: (id: string) => Promise<void>;
  reorderStops: (stopIds: string[]) => Promise<void>;
  optimizeRoute: (options?: OptimizeOptions) => Promise<OptimizeResult | null>;
  benchmarkRoute: (currentLatitude?: number, currentLongitude?: number) => Promise<BenchmarkResponse | null>;
  fetchRecommendation: () => Promise<void>;
  completeStop: (id: string, gps?: GpsFix) => Promise<void>;
  uncompleteStop: (id: string) => Promise<void>;
  /** Stamp arrival on the backend (geofence enter). Best-effort GPS — backend
   *  is idempotent and will keep the first arrival timestamp on re-fires. */
  arriveAtStop: (id: string, gps?: GpsFix) => Promise<void>;
  /** Relocate a single suspect spike to its haversine-best slot, OSRM-verified.
   *  Updates `stops` and refreshes `clusterWarnings` from the response. */
  tightenCluster: (suspectId: string) => Promise<TightenResult | null>;
  /** Iteratively flatten every spike. Same OSRM verification as the singular
   *  endpoint. Updates `stops` and clears `clusterWarnings` on success. */
  tightenAllClusters: () => Promise<TightenResult | null>;
  /** Refresh `outlierReport` from the backend. Best-effort: a failed call
   *  leaves the previous report intact (no banner flicker on transient
   *  network blips). Auto-fired by `fetchStops()` when the manifest has
   *  >= 3 stops. */
  fetchOutliers: (thresholdKm?: number) => Promise<OutlierReport | null>;
  /** Bulk-delete the supplied outlier ids. Returns deleted count on success.
   *  On success, clears `outlierReport.outliers` and refreshes `stops`. */
  removeOutliers: (stopIds: string[]) => Promise<number | null>;
  clearStops: () => void;
  deleteAllStops: () => Promise<boolean>;
  archiveRoute: () => Promise<boolean>;
  /** Lock an ordered list of stop IDs into the DB's `sequence_number` so
   *  GET /api/stops returns them in that order permanently (until the next
   *  confirm call). Returns true on 2xx. Never throws — a flaky network
   *  must not block the driver from starting navigation, so failures are
   *  surfaced via `lastFetchError` and the caller is expected to proceed. */
  confirmRoute: (stopIds: string[]) => Promise<boolean>;
  /** Drain any queued offline actions right now. Safe to call anytime. */
  flushSyncQueue: () => Promise<number>;
  /** Dismiss a pending queued action (remove from AsyncStorage) and revert the
   *  optimistic local flip so the UI matches what the server will say on next fetch.
   *  Returns true if something was actually dismissed. */
  dismissQueuedAction: (id: string) => Promise<boolean>;
  /** Re-enqueue a previously dismissed action and re-apply the optimistic flip.
   *  Used by the "Undo" toast after a swipe-dismiss. */
  restoreQueuedAction: (action: QueueAction) => Promise<void>;
}

import { triggerReconnect } from '../utils/authBridge';

const getAuthHeaders = async (): Promise<HeadersInit> => {
  const token = await AsyncStorage.getItem('session_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
};

const _rawAuthFetch = async (url: string, options: RequestInit = {}, timeoutMs?: number): Promise<Response> => {
  const headers = await getAuthHeaders();
  // Mobile carriers sometimes drop long-lived responses mid-flight without
  // surfacing an error — the RN `fetch` Promise then never resolves and the
  // UI spinner hangs forever. AbortController fixes most of these, but on
  // some Android+carrier combinations the native fetch ignores the abort
  // signal entirely (the request is stuck in a TCP-handshake retry loop).
  // To bullet-proof against that, we ALSO race the fetch against a hard
  // Promise that rejects on timeout — guarantees the caller sees a
  // rejection within `timeoutMs` regardless of native fetch state.
  const controller = timeoutMs ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fetchPromise = fetch(url, {
      ...options,
      headers: { ...headers, ...options.headers },
      credentials: 'include',
      signal: controller?.signal,
    });
    if (!timeoutMs) return await fetchPromise;
    timer = setTimeout(() => controller?.abort(), timeoutMs);
    const hardTimeoutPromise = new Promise<Response>((_, reject) => {
      // Add 5 s grace beyond the abort window so the abort path takes
      // precedence when it works; the hard timer is the last-resort eject.
      hardTimer = setTimeout(
        () => reject(new Error(`Request timeout after ${timeoutMs + 5000} ms`)),
        timeoutMs + 5000,
      );
    });
    return await Promise.race([fetchPromise, hardTimeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (hardTimer) clearTimeout(hardTimer);
  }
};

/**
 * authFetch — the canonical app-wide fetcher.
 *
 * On top of the raw timeout-armoured fetch above, this wrapper adds a
 * single 401-retry loop:
 *   1. First call goes out as normal.
 *   2. If we had a token AND the server says 401, kick off (or join
 *      the in-flight) `triggerReconnect()` to re-issue the
 *      session_token via Emergent OAuth.
 *   3. On reconnect success, retry the original request EXACTLY ONCE.
 *      `getAuthHeaders` reads the freshly-stored token from
 *      AsyncStorage so the retry carries the new bearer.
 *   4. On reconnect failure, return the original 401 untouched —
 *      callers (fetchStops, etc.) still see the auth error and can
 *      surface their own UI fallback.
 *
 * Why a single retry: a second 401 after a fresh token means the
 * problem is server-side, not the token, so re-popping a browser
 * tab won't help and would pester the user.
 *
 * Why only retry when a token was present: anonymous public endpoints
 * (e.g., /api/demo/scenario) shouldn't trigger an OAuth flow if they
 * happen to 401 — the user never asked to sign in for those.
 */
const authFetch = async (url: string, options: RequestInit = {}, timeoutMs?: number): Promise<Response> => {
  const initialToken = await AsyncStorage.getItem('session_token');
  const response = await _rawAuthFetch(url, options, timeoutMs);
  if (response.status !== 401 || !initialToken) return response;

  // Coalesce: even if 5 parallel requests all 401 simultaneously,
  // `triggerReconnect()` returns the SAME Promise to all of them —
  // only one browser tab opens.
  const ok = await triggerReconnect();
  if (!ok) return response; // user cancelled / no impl registered

  // Retry once with a freshly-fetched token. We deliberately don't
  // re-clone `options` other than headers — the body Stream may have
  // been consumed by the first fetch; for our app's calls this is
  // fine because all bodies are JSON strings (re-serialisable from
  // the original `options.body`). FormData / streamed uploads would
  // need bespoke handling, none currently exist on auth-protected
  // routes.
  return await _rawAuthFetch(url, options, timeoutMs);
};

export const useStopsStore = create<StopsStore>((set, get) => ({
  stops: [],
  loading: false,
  optimizing: false,
  benchmarking: false,
  tighteningClusters: false,
  lastBenchmark: null,
  recommendation: null,
  routeCharacteristics: null,
  clusterWarnings: [],
  outlierReport: null,
  lastOptimizeError: null,
  lastFetchError: null,
  lastAlgorithm: null,
  lastDistanceKm: null,
  lastDurationSec: null,
  loadedStopIds: new Set<string>(),
  markStopLoaded: (stopId: string) => {
    // Re-create the Set every time so React reference equality detects
    // the change — direct in-place .add() would NOT trigger a re-render
    // of consumers selecting `loadedStopIds` from the store.
    set((state) => {
      if (state.loadedStopIds.has(stopId)) return {} as Partial<StopsStore>;
      const next = new Set(state.loadedStopIds);
      next.add(stopId);
      return { loadedStopIds: next };
    });
  },
  clearLoadedStops: () => set({ loadedStopIds: new Set<string>() }),

  // Cross-screen "drop me into the navigating cockpit, target = this stop"
  // intent. Set by stop-detail's Navigate button (and any future surface
  // that wants the same hand-off). Map tab `(tabs)/index.tsx` watches this
  // and runs the same single-stop nav flow used by the on-map marker
  // modal, then clears it. Plain string-or-null because URL-encoding
  // through tab router params is unreliable on Android — the tab is
  // persisted across mounts so params can stick from a prior visit.
  pendingNavTargetId: null,
  setPendingNavTarget: (stopId: string | null) => set({ pendingNavTargetId: stopId }),

  fetchStops: async () => {
    set({ loading: true });
    try {
      const response = await authFetch(`${BACKEND_URL}/api/stops`);
      if (response.ok) {
        const data = await response.json();
        set({ stops: data, lastFetchError: null });
        // Drain any queued offline actions now that we've proven connectivity + auth.
        // If the flush marks server-side changes, the next fetchStops will pick them up.
        flush(authFetch, BACKEND_URL).catch(() => {});
        // Outlier sweep: only meaningful with at least 3 stops (median
        // estimator needs the sample size, and a 1-2 stop manifest can't
        // have a meaningful "centroid"). Fired non-blocking so a slow
        // outlier endpoint never delays the list render.
        if (Array.isArray(data) && data.length >= 3) {
          get().fetchOutliers().catch(() => {});
        } else {
          set({ outlierReport: null });
        }
      } else {
        // 401 here is the canonical "import succeeded but list is empty"
        // failure mode — the silent catch in the previous version dropped
        // it on the floor and the UI just showed an empty list. Now we
        // record it so screens can render a "Re-sign in" banner instead.
        const message =
          response.status === 401
            ? 'Your session has expired. Please sign in again.'
            : `Could not load stops (HTTP ${response.status}).`;
        set({ lastFetchError: { status: response.status, message } });
        console.warn('[fetchStops] non-OK response:', response.status, message);
      }
    } catch (error: any) {
      const message = error?.message || 'Network error while loading stops.';
      set({ lastFetchError: { status: null, message } });
      console.error('Fetch stops error:', error);
    } finally {
      set({ loading: false });
    }
  },

  addStop: async (stopData: StopCreate) => {
    const response = await authFetch(`${BACKEND_URL}/api/stops`, {
      method: 'POST',
      body: JSON.stringify(stopData),
    });

    if (!response.ok) {
      throw new Error('Failed to add stop');
    }

    const newStop = await response.json();
    set((state) => ({ stops: [...state.stops, newStop] }));
    return newStop;
  },

  updateStop: async (id: string, updates: StopUpdate) => {
    const response = await authFetch(`${BACKEND_URL}/api/stops/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      throw new Error('Failed to update stop');
    }

    const updatedStop = await response.json();
    set((state) => ({
      stops: state.stops.map((s) => (s.id === id ? updatedStop : s)),
    }));
  },

  deleteStop: async (id: string) => {
    const response = await authFetch(`${BACKEND_URL}/api/stops/${id}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error('Failed to delete stop');
    }

    set((state) => ({
      stops: state.stops.filter((s) => s.id !== id),
    }));
  },

  reorderStops: async (stopIds: string[]) => {
    // Optimistically update local state
    const currentStops = get().stops;
    const reorderedStops = stopIds.map((id, index) => {
      const stop = currentStops.find((s) => s.id === id);
      return stop ? { ...stop, order: index } : null;
    }).filter(Boolean) as Stop[];
    
    set({ stops: reorderedStops });

    try {
      await authFetch(`${BACKEND_URL}/api/stops/reorder`, {
        method: 'POST',
        body: JSON.stringify({ stop_ids: stopIds }),
      });
    } catch (error) {
      console.error('Reorder error:', error);
      // Revert on error
      set({ stops: currentStops });
    }
  },

  optimizeRoute: async (options?: OptimizeOptions) => {
    set({ optimizing: true, lastOptimizeError: null });
    try {
      const body: Record<string, unknown> = {
        algorithm: options?.algorithm || 'auto',
        current_latitude: options?.currentLatitude,
        current_longitude: options?.currentLongitude,
        use_current_location: options?.useCurrentLocation ?? true,
        // Device-clock wall-time drives the school-zone avoidance factor on
        // the backend (1a rule: "always read device clock at Optimize-press").
        // Callers can override for "what-if" scheduling; default is now.
        start_time: options?.startTime ?? new Date().toISOString(),
      };
      
      // Add hubs if provided
      if (options?.hubs && options.hubs.length > 0) {
        body.hubs = options.hubs;
      }
      
      // Add sections if provided (route refinement)
      if (options?.sections && options.sections.length > 0) {
        body.sections = options.sections;
      }
      
      // Async job pattern: POST kicks off the optimize in the background
      // and returns a job_id in <100 ms (well under Cloudflare's 100 s
      // ceiling). We then poll until done. This permanently bulletproofs
      // long optimise runs (200+ stops on remote OSRM, dense No-Go zones)
      // against the 524 Origin Timeout that the synchronous endpoint hit
      // on prod. Each poll is ~30 ms — Cloudflare can't time us out.
      // 60 s kickoff timeout (not 30 s): on a freshly-warmed pod after a
      // rolling deploy, the first authenticated insert into Atlas can
      // briefly take 5-15 s. 60 s leaves comfortable headroom while still
      // bailing out fast if the origin is genuinely unreachable.
      //
      // Kickoff retry: drivers on weak 4G/edge see RN's
      // `TypeError: Network request failed` whenever a single TCP retry
      // exhausts mid-send. The kickoff body is tiny (~200 B) but a single
      // drop ends the whole optimise attempt. Two retries (1 s, 3 s
      // backoff) catch the typical "carrier hiccup" pattern without
      // adding meaningful latency on a healthy network. Idempotent at
      // the server side: a duplicate kickoff just creates a 2nd job_id
      // that gets TTL'd out. Worst case is a wasted Mongo insert.
      let kickoff: Response | null = null;
      let lastKickoffError: any = null;
      const KICKOFF_BACKOFF_MS = [0, 1_000, 3_000];
      for (let attempt = 0; attempt < KICKOFF_BACKOFF_MS.length; attempt++) {
        if (KICKOFF_BACKOFF_MS[attempt] > 0) {
          await new Promise((r) => setTimeout(r, KICKOFF_BACKOFF_MS[attempt]));
        }
        try {
          kickoff = await authFetch(`${BACKEND_URL}/api/optimize/jobs`, {
            method: 'POST',
            body: JSON.stringify(body),
          }, 60_000);
          break; // got a Response object — let the !ok branch below decide
        } catch (fetchErr: any) {
          lastKickoffError = fetchErr;
          // Only retry on the carrier-drop signature. Don't retry on
          // anything that looks like a deliberate abort or programmer
          // error — those won't get better with a wait.
          const msg = String(fetchErr?.message || fetchErr || '');
          const isTransient =
            msg.includes('Network request failed') ||
            msg.includes('timeout') ||
            msg.includes('aborted');
          if (!isTransient || attempt === KICKOFF_BACKOFF_MS.length - 1) {
            // Either non-retryable, or we've exhausted our attempts.
            const stagedMsg = msg
              ? `Kickoff failed after ${attempt + 1} attempt(s): ${msg}`
              : `Kickoff failed after ${attempt + 1} attempt(s)`;
            set({
              lastOptimizeError: { status: null, message: stagedMsg },
            });
            throw new Error(stagedMsg);
          }
          // Otherwise loop continues to next attempt.
        }
      }
      if (!kickoff) {
        // Shouldn't reach here — the loop either returns a Response or throws.
        const fallback = String(lastKickoffError?.message || 'Kickoff failed');
        set({ lastOptimizeError: { status: null, message: fallback } });
        throw new Error(fallback);
      }

      if (!kickoff.ok) {
        let detail = '';
        let parsed: any = null;
        try {
          parsed = await kickoff.json();
          // Handle both FastAPI's {"detail": "..."} and our safety-net
          // {"success": false, "error": "..."} shapes.
          detail = typeof parsed?.detail === 'string'
            ? parsed.detail
            : (typeof parsed?.detail?.message === 'string'
                ? parsed.detail.message
                : (typeof parsed?.error === 'string' ? parsed.error : ''));
        } catch { /* response body wasn't JSON — ignore */ }
        // 402 Payment Required → paywall. Surface a structured error
        // the UI can branch on (push /billing instead of toasting "failed").
        if (kickoff.status === 402 && parsed?.detail?.upgrade_required === true) {
          set({
            lastOptimizeError: {
              status: 402,
              message: parsed.detail.message || 'Pro subscription required.',
              upgradeRequired: true,
            },
          });
          throw new Error('PAYWALL:subscription_required');
        }
        set({
          lastOptimizeError: {
            status: kickoff.status,
            message: detail || `Optimization failed (HTTP ${kickoff.status})`,
          },
        });
        throw new Error(detail || `Optimization failed (HTTP ${kickoff.status})`);
      }

      const { job_id: jobId } = await kickoff.json();
      if (!jobId) {
        throw new Error('Backend did not return a job_id');
      }

      // Poll every 2.5 s. Hard cap at 5 min wall-clock — well past the
      // worst observed end-to-end (~150 s for 200 stops on remote OSRM
      // with active No-Go zones) but short enough to free the spinner if
      // the job runner crashes silently on the backend.
      // Per-poll timeout is 60 s (not 15 s): while polling, each response
      // is ~100 bytes (`{status: "running"}`), but the FINAL poll once the
      // runner writes done carries the full result — on a 200-stop manifest
      // that's 2-5 MB. On a shaky 4G link the download can take 20-40 s,
      // and a 15 s AbortController fires "Aborted" mid-download. 60 s is
      // safely past the 4G worst-case (Cloudflare's edge buffers the body
      // so this doesn't bump into the 100 s origin-response ceiling).
      const POLL_INTERVAL_MS = 2_500;
      const POLL_MAX_MS = 300_000;
      const POLL_TIMEOUT_MS = 60_000;
      const startedAt = Date.now();
      let result: OptimizeResult | null = null;
      // First poll fires immediately so a fast solve (small route) still
      // feels instant; subsequent polls back off to the interval cadence.
      // Each individual poll is wrapped in a transient-error retry: if the
      // 4G connection drops mid-response (especially the FINAL poll that
      // carries the full 2-5 MB result body on a 200-stop manifest), we
      // re-fetch the same job_id rather than giving up the whole route.
      // Server is idempotent — re-reading a `done` job returns the same
      // result; re-reading a `running` job returns `running`.
      while (Date.now() - startedAt < POLL_MAX_MS) {
        let poll: Response | null = null;
        let pollErr: any = null;
        const POLL_RETRY_BACKOFF_MS = [0, 1_500, 4_000];
        for (let attempt = 0; attempt < POLL_RETRY_BACKOFF_MS.length; attempt++) {
          if (POLL_RETRY_BACKOFF_MS[attempt] > 0) {
            await new Promise((r) => setTimeout(r, POLL_RETRY_BACKOFF_MS[attempt]));
          }
          try {
            poll = await authFetch(
              `${BACKEND_URL}/api/optimize/jobs/${jobId}`,
              { method: 'GET' },
              POLL_TIMEOUT_MS,
            );
            break;
          } catch (e: any) {
            pollErr = e;
            const msg = String(e?.message || e || '');
            const isTransient =
              msg.includes('Network request failed') ||
              msg.includes('timeout') ||
              msg.includes('aborted');
            if (!isTransient || attempt === POLL_RETRY_BACKOFF_MS.length - 1) {
              const stagedMsg = `Poll failed (job_id=${jobId.slice(0, 8)}…) ` +
                `after ${attempt + 1} attempt(s): ${msg}`;
              set({ lastOptimizeError: { status: null, message: stagedMsg } });
              throw new Error(stagedMsg);
            }
          }
        }
        if (!poll) {
          const fallback = String(pollErr?.message || 'Poll failed');
          set({ lastOptimizeError: { status: null, message: fallback } });
          throw new Error(fallback);
        }
        if (!poll.ok) {
          // 404 = job TTL'd out (10 min server-side) or a transient
          // gateway hiccup. Surface as a regular failure.
          let detail = '';
          try {
            const j = await poll.json();
            detail = typeof j?.detail === 'string' ? j.detail : '';
          } catch { /* ignore */ }
          set({
            lastOptimizeError: {
              status: poll.status,
              message: detail || `Optimization poll failed (HTTP ${poll.status})`,
            },
          });
          throw new Error(detail || `Optimization poll failed (HTTP ${poll.status})`);
        }
        const status = await poll.json();
        if (status?.status === 'done') {
          result = status.result as OptimizeResult;
          break;
        }
        if (status?.status === 'error') {
          const errDetail = status?.error?.detail || 'Optimization failed on the server';
          set({
            lastOptimizeError: {
              status: status?.error?.status ?? null,
              message: errDetail,
            },
          });
          throw new Error(errDetail);
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!result) {
        const msg = 'Optimization timed out after 5 minutes';
        set({ lastOptimizeError: { status: null, message: msg } });
        throw new Error(msg);
      }
      // ── AUDIT 4: API RX ──────────────────────────────────────────────
      // Pair this with backend "AUDIT[/optimize] TX" log to prove the
      // wire-level array order is preserved end-to-end. If the two first-5
      // arrays differ, transit is re-shuffling (FastAPI's JSON encoder,
      // ngrok, Metro's hot-reload bundler proxy — any of them could in
      // theory). Empirically these are stable, but keeping the parity
      // check makes future regressions instantly diagnosable.
      console.log(
        '[AUDIT API RX]',
        Array.isArray(result?.stops)
          ? result.stops.slice(0, 5).map((s: any) => s?.id)
          : result,
      );
      // Merge: result.stops includes both optimized incomplete + completed stops from backend.
      // Cluster warnings are surfaced post-solve by the backend's spike detector;
      // banner UIs read them from the store.
      set({
        stops: result.stops,
        clusterWarnings: result.cluster_warnings ?? [],
        // Snapshot of the most recent optimise — forwarded to
        // /api/routes/archive so route_history.summary.algorithm
        // answers "which profile did I use?" after the fact.
        // Cleared on logout / archive.
        lastAlgorithm: result.algorithm ?? null,
        lastDistanceKm: typeof result.total_distance_km === 'number' ? result.total_distance_km : null,
        lastDurationSec: typeof (result as any).total_duration_seconds === 'number'
          ? (result as any).total_duration_seconds
          : null,
      });
      return result;
    } catch (error: any) {
      console.error('Optimize error:', error);
      // Network/timeout/abort path — only set if the !response.ok branch
      // didn't already populate the structured error above.
      if (!useStopsStore.getState().lastOptimizeError) {
        set({
          lastOptimizeError: {
            status: null,
            message: error?.message || 'Network error',
          },
        });
      }
      return null;
    } finally {
      set({ optimizing: false });
    }
  },

  tightenCluster: async (suspectId: string) => {
    set({ tighteningClusters: true });
    try {
      const response = await authFetch(
        `${BACKEND_URL}/api/optimize/tighten-cluster`,
        { method: 'POST', body: JSON.stringify({ suspect_id: suspectId }) },
        30_000,
      );
      if (!response.ok) {
        throw new Error(`tighten-cluster failed (${response.status})`);
      }
      const result: TightenResult = await response.json();
      // The endpoint returns ONLY the pending uncompleted stops (the route to
      // come). Merge them ahead of any locally-completed stops so we keep
      // history visible while still showing the new visit order.
      const completed = get().stops.filter((s) => s.completed);
      set({
        stops: [...result.stops, ...completed],
        clusterWarnings: result.cluster_warnings,
      });
      return result;
    } catch (error) {
      console.error('Tighten cluster error:', error);
      return null;
    } finally {
      set({ tighteningClusters: false });
    }
  },

  tightenAllClusters: async () => {
    set({ tighteningClusters: true });
    try {
      const response = await authFetch(
        `${BACKEND_URL}/api/optimize/tighten-clusters`,
        { method: 'POST' },
        45_000,
      );
      if (!response.ok) {
        throw new Error(`tighten-clusters failed (${response.status})`);
      }
      const result: TightenResult = await response.json();
      const completed = get().stops.filter((s) => s.completed);
      set({
        stops: [...result.stops, ...completed],
        clusterWarnings: result.cluster_warnings,
      });
      return result;
    } catch (error) {
      console.error('Tighten all clusters error:', error);
      return null;
    } finally {
      set({ tighteningClusters: false });
    }
  },

  fetchOutliers: async (thresholdKm = 50) => {
    try {
      const response = await authFetch(
        `${BACKEND_URL}/api/stops/outliers?threshold_km=${encodeURIComponent(thresholdKm)}`,
      );
      if (!response.ok) {
        // Don't clobber an existing report on a transient 5xx — the banner
        // would flicker every poll. Log and bail.
        console.warn('[fetchOutliers] non-OK', response.status);
        return null;
      }
      const report: OutlierReport = await response.json();
      set({ outlierReport: report });
      return report;
    } catch (error) {
      console.error('Fetch outliers error:', error);
      return null;
    }
  },

  removeOutliers: async (stopIds: string[]) => {
    if (!stopIds || stopIds.length === 0) return 0;
    try {
      const response = await authFetch(
        `${BACKEND_URL}/api/stops/outliers/remove`,
        { method: 'POST', body: JSON.stringify({ stop_ids: stopIds }) },
        20_000,
      );
      if (!response.ok) {
        console.warn('[removeOutliers] non-OK', response.status);
        return null;
      }
      const result = await response.json();
      // Optimistic local prune so the banner disappears instantly even if
      // the backend roundtrip for the follow-up fetchStops is slow.
      set((state) => ({
        stops: state.stops.filter((s) => !stopIds.includes(s.id)),
        outlierReport: state.outlierReport
          ? {
              ...state.outlierReport,
              outliers: state.outlierReport.outliers.filter(
                (o) => !stopIds.includes(o.id),
              ),
              total_stops: Math.max(
                0,
                state.outlierReport.total_stops - (result.deleted_count ?? 0),
              ),
            }
          : null,
      }));
      // Refresh from the server to pick up the new contiguous `order`
      // values (the backend reindexes on delete). Best-effort — the
      // optimistic prune above already gives the user the right view.
      get().fetchStops().catch(() => {});
      return result.deleted_count ?? 0;
    } catch (error) {
      console.error('Remove outliers error:', error);
      return null;
    }
  },

  completeStop: async (id: string, gps?: GpsFix) => {
    // First-line proof-of-entry alert. If this fires, the store action IS being
    // invoked from the handler. If it does NOT fire even though the handler's
    // [DELIVER_TAP_FIRED] log + Alert did fire, then `completeStop` is being
    // shadowed by a stale closure or destructure-time undefined — which means
    // we need to fix the binding in the component.

    // Optimistic update — instant UI response
    const prev = get().stops;
    set((state) => ({
      stops: state.stops.map((s) =>
        s.id === id ? { ...s, completed: true, delivery_status: 'delivered' } : s
      ),
    }));

    try {
      // Best-effort GPS payload — backend treats absence as "no signal" and
      // never fails the request because of missing/partial fields.
      // `view_mode` rides along to disambiguate "tapped from cockpit" vs
      // "tapped from list" — needed to triage why geofence_rate is 0%.
      const body: Record<string, number | string> = {};
      if (gps?.lat !== undefined && gps.lng !== undefined) {
        body.lat = gps.lat;
        body.lng = gps.lng;
      }
      if (gps?.accuracy_m !== undefined) body.accuracy_m = gps.accuracy_m;
      if ((gps as { view_mode?: string } | undefined)?.view_mode) {
        body.view_mode = (gps as { view_mode: string }).view_mode;
      }

      // Race the fetch against a 10s timeout — a hung fetch (DNS/TLS/proxy
      // black-hole) would otherwise produce exactly the symptoms the driver
      // reports: optimistic tick → silent revert (because something else
      // refetches /api/stops in the meantime) → no error alert.
      const TIMEOUT_MS = 10_000;
      const response = await Promise.race([
        authFetch(`${BACKEND_URL}/api/stops/${id}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        new Promise<Response>((_, rej) =>
          setTimeout(() => rej(new Error(`HUNG_FETCH after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
        ),
      ]);
      if (response.ok) {
        const updatedStop = await response.json();
        set((state) => ({
          stops: state.stops.map((s) => (s.id === id ? updatedStop : s)),
        }));
        // Piggy-back a flush attempt — if the driver was offline and just reconnected,
        // this drains any queued actions without needing a separate reconnect listener.
        flush(authFetch, BACKEND_URL).catch(() => {});
      } else if (response.status >= 500 || response.status === 408 || response.status === 429) {
        // Server-side transient error — queue for retry instead of reverting.
        await enqueue({ id, op: 'complete' });
      } else {
        // Client error (4xx except transients) — server disagrees.
        // Previously this revert was completely silent: tap Delivered → optimistic
        // tick flashed for ~200 ms → state reverted to pending → UI looked
        // identical to "the button never fired". Drivers reasonably concluded the
        // button was broken. Now we record a structured error so the UI layer can
        // surface it and the handler can retry against /api/stops/{id} (PUT) as
        // a last-ditch fallback when the dedicated endpoint refuses (e.g. an
        // older deployed pod that doesn't yet have /complete).
        let detail = '';
        try { detail = (await response.text()).slice(0, 200); } catch { /* ignore */ }
        set({
          stops: prev,
          lastFetchError: {
            status: response.status,
            message: `Mark-delivered rejected: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
          },
        });
        console.warn('[completeStop] server rejected', response.status, detail);
        // Cross-deploy fallback: try the generic PUT /stops/{id} with completed:true.
        // This endpoint has shipped to every backend revision since the start of
        // the project, so even if a stale production pod 404s on /complete the
        // driver still gets the stop marked. Best-effort, swallows further errors.
        try {
          const fb = await authFetch(`${BACKEND_URL}/api/stops/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed: true }),
          });
          if (fb.ok) {
            const fbStop = await fb.json();
            set((state) => ({
              stops: state.stops.map((s) => (s.id === id ? fbStop : s)),
              lastFetchError: null,
            }));
          }
        } catch {
          /* swallow fallback errors — primary error is already in lastFetchError */
        }
      }
    } catch {
      // Network error (offline, DNS fail, timeout) — queue + keep optimistic state.
      await enqueue({ id, op: 'complete' });
    }
  },

  /** Stamp arrival on the backend (geofence enter). Best-effort GPS — backend
   *  is idempotent and silently keeps the first arrival timestamp on re-fires.
   *  Fire-and-forget: never updates local state, never throws — instrumentation
   *  must not block the driver UI. */
  arriveAtStop: async (id: string, gps?: GpsFix) => {
    try {
      const body: Record<string, number> = {};
      if (gps?.lat !== undefined && gps.lng !== undefined) {
        body.lat = gps.lat;
        body.lng = gps.lng;
      }
      if (gps?.accuracy_m !== undefined) body.accuracy_m = gps.accuracy_m;
      await authFetch(`${BACKEND_URL}/api/stops/${id}/arrived`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Geofence arrival is *purely* analytics — eat all errors silently.
      // Re-fires are idempotent server-side; nothing to retry locally.
    }
  },

  uncompleteStop: async (id: string) => {
    // Optimistic update — instant UI response
    const prev = get().stops;
    set((state) => ({
      stops: state.stops.map((s) =>
        s.id === id ? { ...s, completed: false, delivery_status: 'pending' } : s
      ),
    }));

    try {
      const response = await authFetch(`${BACKEND_URL}/api/stops/${id}/uncomplete`, {
        method: 'POST',
      });
      if (response.ok) {
        const updatedStop = await response.json();
        set((state) => ({
          stops: state.stops.map((s) => (s.id === id ? updatedStop : s)),
        }));
        flush(authFetch, BACKEND_URL).catch(() => {});
      } else if (response.status >= 500 || response.status === 408 || response.status === 429) {
        await enqueue({ id, op: 'uncomplete' });
      } else {
        set({ stops: prev });
      }
    } catch {
      await enqueue({ id, op: 'uncomplete' });
    }
  },

  clearStops: () => {
    set({ stops: [] });
  },

  fetchRecommendation: async () => {
    try {
      const response = await authFetch(`${BACKEND_URL}/api/optimize/recommend`);
      if (!response.ok) return;
      const data = await response.json();
      set({
        recommendation: data.recommendation,
        routeCharacteristics: data.characteristics,
      });
    } catch (error) {
      console.error('Recommendation fetch error:', error);
    }
  },

  benchmarkRoute: async (currentLatitude?: number, currentLongitude?: number) => {
    set({ benchmarking: true, lastBenchmark: null });
    // 60s hard timeout — the backend caps its solver budget at 45s, so any
    // legitimate run finishes well before this. If the server genuinely hangs
    // (e.g. lost Mongo connection), we still want the spinner to stop.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    try {
      const body: Record<string, unknown> = {};
      if (currentLatitude && currentLongitude) {
        body.current_latitude = currentLatitude;
        body.current_longitude = currentLongitude;
        body.use_current_location = true;
      }
      const response = await authFetch(`${BACKEND_URL}/api/benchmark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Benchmark failed');
      const data: BenchmarkResponse = await response.json();
      set({ lastBenchmark: data, benchmarking: false });
      return data;
    } catch (error) {
      console.error('Benchmark error:', error);
      set({ benchmarking: false });
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  deleteAllStops: async () => {
    try {
      const response = await authFetch(`${BACKEND_URL}/api/stops`, {
        method: 'DELETE',
      });

      console.log('deleteAllStops - response status:', response.status);
      
      if (response.ok) {
        set({ stops: [] });
        return true;
      }
      
      const errorText = await response.text();
      console.error('deleteAllStops - error response:', errorText);
      return false;
    } catch (error) {
      console.error('Delete all stops error:', error);
      return false;
    }
  },

  archiveRoute: async () => {
    try {
      const { lastAlgorithm, lastDistanceKm, lastDurationSec } = useStopsStore.getState();
      // Body is optional — backend defaults all three to null in
      // route_history.summary when fields are missing. Empty {} would
      // also work; we send the snapshot when we have it so the
      // telemetry-rollup endpoint can answer "which algorithm did I
      // use today?" without further code changes.
      const body: Record<string, unknown> = {};
      if (lastAlgorithm) body.algorithm = lastAlgorithm;
      if (typeof lastDistanceKm === 'number') body.total_distance_km = lastDistanceKm;
      if (typeof lastDurationSec === 'number') body.total_duration_seconds = lastDurationSec;
      const response = await authFetch(`${BACKEND_URL}/api/routes/archive`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
      if (response.ok) {
        const data = await response.json();
        // Clear the snapshot so a stale value can't leak into the
        // NEXT archive after the driver moves on to a fresh manifest.
        set({ lastAlgorithm: null, lastDistanceKm: null, lastDurationSec: null });
        return data.archived === true;
      }
      // Surface the upstream failure to the caller so the UI can show
      // the actual reason (HTTP status + detail) instead of just a
      // silent `false`. Previously this branch swallowed everything,
      // making the Profile "Save Route" button feel unresponsive.
      let detail = '';
      try {
        const j = await response.json();
        detail = typeof j?.detail === 'string' ? j.detail : '';
      } catch {
        try { detail = await response.text(); } catch { /* ignore */ }
      }
      const e: any = new Error(`Archive failed (HTTP ${response.status}): ${detail}`);
      e.status = response.status;
      e.detail = detail || `HTTP ${response.status}`;
      throw e;
    } catch (error: any) {
      console.error('Archive route error:', error);
      // Re-throw so the caller (Profile screen) can show the exact
      // failure mode. The legacy `return false` swallowed everything
      // and produced a silent button click.
      throw error;
    }
  },

  confirmRoute: async (stopIds: string[]) => {
    // Guard: the backend requires min 1 ID; surface an error early so the
    // caller can skip the fetch entirely on an empty route.
    if (!stopIds.length) {
      set({
        lastFetchError: {
          status: null,
          message: 'Cannot confirm an empty route',
        },
      });
      return false;
    }
    try {
      const response = await authFetch(
        `${BACKEND_URL}/api/routes/confirm`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed_sequence: stopIds }),
        },
        15_000,
      );
      if (response.ok) {
        // Pull the server-stamped rows out of the response (preferred over
        // a local guess because `original_sequence` may already have been
        // locked by a prior confirm — the server is the single source of
        // truth). Fall back to a purely local stamp if the response body
        // is malformed or empty (e.g. a proxy strips it on a flaky link),
        // so the driver still sees a confirmed UI state and never gets
        // wedged on the planning screen.
        let stamped: Stop[] | null = null;
        try {
          const body = await response.json();
          if (body && Array.isArray(body.stops) && body.stops.length > 0) {
            stamped = body.stops as Stop[];
          }
        } catch {
          /* ignore — fall through to local stamp */
        }

        set((state) => {
          if (stamped) {
            // Server returned the stamped rows — merge by id, preferring
            // server fields for everything except local-only state we
            // intentionally keep client-side. Stops not in the payload get
            // their sequence_number cleared so they sink to the bottom.
            const byId = new Map(stamped.map((s) => [s.id, s]));
            const inPayload = new Set(stopIds);
            return {
              stops: state.stops.map((s) => {
                const fresh = byId.get(s.id);
                if (fresh) return { ...s, ...fresh };
                if (inPayload.has(s.id)) return s;  // shouldn't happen
                return s.sequence_number == null
                  ? s
                  : ({ ...s, sequence_number: null } as Stop);
              }),
              lastFetchError: null,
            };
          }
          // Fallback: stamp locally from payload order (matches old behaviour).
          const rank = new Map(stopIds.map((id, idx) => [id, idx + 1]));
          return {
            stops: state.stops.map((s) =>
              rank.has(s.id)
                ? ({
                    ...s,
                    sequence_number: rank.get(s.id),
                    // Best-effort local Sharpie stamp: only fill in if the
                    // row doesn't already have one. Server-side guard
                    // (`$exists: false`) is the real lock — this just
                    // stops the badge flickering between confirm and the
                    // next /api/stops refresh.
                    original_sequence:
                      s.original_sequence == null
                        ? rank.get(s.id)
                        : s.original_sequence,
                  } as Stop)
                : ({ ...s, sequence_number: null } as Stop)
            ),
            lastFetchError: null,
          };
        });
        return true;
      }
      let detail = '';
      try { detail = (await response.text()).slice(0, 200); } catch { /* ignore */ }
      set({
        lastFetchError: {
          status: response.status,
          message: `Confirm route rejected: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
        },
      });
      console.warn('[confirmRoute] server rejected', response.status, detail);
      return false;
    } catch (error: any) {
      // Network/timeout — don't block navigation start; the caller proceeds.
      set({
        lastFetchError: {
          status: null,
          message: error?.message || 'Confirm route failed (offline?)',
        },
      });
      console.warn('[confirmRoute] network error', error);
      return false;
    }
  },

  flushSyncQueue: async () => {
    try {
      return await flush(authFetch, BACKEND_URL);
    } catch (error) {
      console.error('Sync queue flush error:', error);
      return 0;
    }
  },

  dismissQueuedAction: async (id: string) => {
    // Find what op was queued so we know how to revert the optimistic flip.
    const actions = await getQueuedActions();
    const action = actions.find((a) => a.id === id);
    if (!action) return false;
    // Remove from the persisted queue first.
    await removeQueuedById(id);
    // Revert the optimistic local state: a queued 'complete' means we flipped to
    // completed=true optimistically → revert to false. And vice-versa for 'uncomplete'.
    set((state) => ({
      stops: state.stops.map((s) =>
        s.id === id
          ? {
              ...s,
              completed: action.op !== 'complete',
              delivery_status: action.op === 'complete' ? 'pending' : 'delivered',
            }
          : s
      ),
    }));
    return true;
  },

  restoreQueuedAction: async (action: QueueAction) => {
    // Re-enqueue the action (timestamp refreshes, which is fine — it's still pending).
    await enqueue({ id: action.id, op: action.op });
    // Re-apply the optimistic flip so the pin reflects the queued op again.
    set((state) => ({
      stops: state.stops.map((s) =>
        s.id === action.id
          ? {
              ...s,
              completed: action.op === 'complete',
              delivery_status: action.op === 'complete' ? 'delivered' : 'pending',
            }
          : s
      ),
    }));
  },
}));
