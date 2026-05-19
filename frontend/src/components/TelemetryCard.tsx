/**
 * TelemetryCard
 * ─────────────────────────────────────────────────────────────────────────
 * Profile-screen tile showing rolling telemetry from the last 7 days of
 * archived routes. Pulls from `GET /api/_meta/telemetry-rollup` and
 * surfaces three numbers the driver actually cares about:
 *
 *   • Arrival proximity   — what % of completed stops registered as
 *                            "you were there" (geofence OR within 150 m
 *                            in nav mode). Green ≥ 70 %, amber ≥ 30 %,
 *                            red below.
 *   • Tap-distance p50    — half the time you tap Delivered within this
 *                            many metres. Useful to know if you're
 *                            tapping early (>100 m), spot-on (50-100 m),
 *                            or after-the-fact (<30 m).
 *   • ML readiness        — service-time-learner sample count vs the
 *                            50-sample threshold. Drives Phase 1.
 *
 * Read-only, polite on errors — if the rollup endpoint 401s (token
 * expired) or fails the network, the card collapses to a single
 * "Telemetry temporarily unavailable" line rather than red-screening
 * the whole Profile.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

interface TelemetryWindow {
  archived_routes: number;
  geofence_count: number;
  geofence_inferred_count: number;
  fallback_count: number;
  geofence_rate: number | null;
  arrival_proximity_rate: number | null;
  completion_distance_p50_m: number | null;
  completion_distance_p95_m: number | null;
  service_seconds_p50: number | null;
  service_samples: number;
}

interface TelemetryRollup {
  user_id?: string;
  today?: TelemetryWindow;
  last_7_days: TelemetryWindow;
  ml_readiness?: {
    real_geofence_samples_last_7d: number;
    needed_for_phase_1: number;
    ready_to_train: boolean;
    blocked_on: string | null;
  };
}

interface MLModelSummary {
  trained: boolean;
  sample_count: number;
  suburbs_covered: number;
  hour_buckets_covered: number;
  global_median_seconds: number;
  fastest_bucket_seconds: number | null;
  slowest_bucket_seconds: number | null;
  trained_at: string | null;
}

const PHASE_1_THRESHOLD = 50;

function pct(v: number | null | undefined, decimals = 0): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(decimals)}%`;
}

function metres(v: number | null | undefined): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—';
  if (v < 10) return `${v.toFixed(1)} m`;
  return `${Math.round(v)} m`;
}

// Traffic-light tier helper — keeps the colour decision in one place so
// the three rows visually agree about what "good" means.
function tier(rate: number | null | undefined, greenMin: number, amberMin: number): string {
  if (typeof rate !== 'number') return '#64748b';
  if (rate >= greenMin) return '#10b981';   // emerald-500
  if (rate >= amberMin) return '#f59e0b';   // amber-500
  return '#ef4444';                          // red-500
}

export const TelemetryCard: React.FC = () => {
  const [data, setData] = useState<TelemetryRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await AsyncStorage.getItem('session_token');
      if (!token) {
        setError('Sign in to view telemetry');
        return;
      }
      const r = await fetch(`${BACKEND_URL}/api/_meta/telemetry-rollup?days=7`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        // 401 from an expired token is the most common case — show a
        // gentle line rather than a stack trace.
        setError(`Unavailable (HTTP ${r.status})`);
        return;
      }
      const j = await r.json();
      setData(j as TelemetryRollup);
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <View style={styles.card} testID="telemetry-card-loading">
        <View style={styles.headerRow}>
          <Ionicons name="pulse-outline" size={18} color="#475569" />
          <Text style={styles.title}>Telemetry · last 7 days</Text>
        </View>
        <View style={styles.loadingBlock}>
          <ActivityIndicator size="small" color="#94a3b8" />
        </View>
      </View>
    );
  }

  if (error || !data || !data.last_7_days) {
    return (
      <View style={styles.card} testID="telemetry-card-error">
        <View style={styles.headerRow}>
          <Ionicons name="pulse-outline" size={18} color="#475569" />
          <Text style={styles.title}>Telemetry · last 7 days</Text>
          <TouchableOpacity onPress={load} hitSlop={8} testID="telemetry-card-retry">
            <Ionicons name="refresh-outline" size={18} color="#64748b" />
          </TouchableOpacity>
        </View>
        <Text style={styles.errorLine}>{error || 'No data'}</Text>
      </View>
    );
  }

  // Backend nests the rollup under `last_7_days` (with a parallel `today`
  // window and an `ml_readiness` block at the top level). All component
  // rows read off this single `w` reference so we never accidentally pull
  // from the wrong window.
  const w = data.last_7_days;

  const proximity = w.arrival_proximity_rate;
  const proximityColor = tier(proximity, 0.7, 0.3);
  const realRate = w.geofence_rate;
  const realColor = tier(realRate, 0.5, 0.15);

  const totalArrivals = (w.geofence_count || 0) + (w.geofence_inferred_count || 0) + (w.fallback_count || 0);

  const mlBlock = data.ml_readiness;
  const mlSamples = mlBlock?.real_geofence_samples_last_7d ?? w.service_samples ?? 0;
  const mlThreshold = mlBlock?.needed_for_phase_1 ?? PHASE_1_THRESHOLD;
  const mlReadyPct = mlThreshold > 0 ? mlSamples / mlThreshold : 0;
  const mlColor = mlReadyPct >= 1 ? '#10b981' : mlReadyPct >= 0.4 ? '#f59e0b' : '#ef4444';

  return (
    <View style={styles.card} testID="telemetry-card">
      <View style={styles.headerRow}>
        <Ionicons name="pulse-outline" size={18} color="#475569" />
        <Text style={styles.title}>Telemetry · last 7 days</Text>
        <TouchableOpacity onPress={load} hitSlop={8} testID="telemetry-card-refresh">
          <Ionicons name="refresh-outline" size={18} color="#64748b" />
        </TouchableOpacity>
      </View>

      <Text style={styles.subline}>
        {w.archived_routes} {w.archived_routes === 1 ? 'route' : 'routes'} archived · {totalArrivals} stops completed
      </Text>

      {/* Row 1 — Arrival proximity (driver-friendly headline). */}
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: proximityColor }]} />
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Arrival proximity</Text>
          <Text style={styles.rowSub}>
            {w.geofence_count} geofence · {w.geofence_inferred_count} inferred · {w.fallback_count} fallback
          </Text>
        </View>
        <Text style={[styles.rowValue, { color: proximityColor }]} testID="telemetry-arrival-rate">
          {pct(proximity)}
        </Text>
      </View>

      {/* Row 2 — Real geofence hit rate (the diagnostic). */}
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: realColor }]} />
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Geofence hook firing</Text>
          <Text style={styles.rowSub}>
            Tap-distance median {metres(w.completion_distance_p50_m)} · p95 {metres(w.completion_distance_p95_m)}
          </Text>
        </View>
        <Text style={[styles.rowValue, { color: realColor }]} testID="telemetry-geofence-rate">
          {pct(realRate)}
        </Text>
      </View>

      {/* Row 3 — ML readiness (the "are we there yet" gauge). */}
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: mlColor }]} />
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Phase 1 ML readiness</Text>
          <Text style={styles.rowSub}>
            {mlBlock?.blocked_on
              ? mlBlock.blocked_on.slice(0, 80) + (mlBlock.blocked_on.length > 80 ? '…' : '')
              : `Service-time learner ready in ${Math.max(0, mlThreshold - mlSamples)} more samples`}
          </Text>
        </View>
        <Text style={[styles.rowValue, { color: mlColor }]} testID="telemetry-ml-readiness">
          {mlSamples}/{mlThreshold}
        </Text>
      </View>

      {/* Helper hint — explains the "0 routes" / "0 stops" empty state
          when the driver has been delivering all day but hasn't archived
          the route yet. Without this they (rightly) ask "why is this
          showing 0 when I just did 178?". */}
      {w.archived_routes === 0 ? (
        <Text style={styles.helperLine} testID="telemetry-empty-helper">
          No routes archived in the last 7 days. Tap <Text style={styles.helperBold}>Save Route</Text> on the route screen after a shift to roll your completed stops into telemetry.
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
    flex: 1,
  },
  subline: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
    marginBottom: 10,
  },
  loadingBlock: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  errorLine: {
    fontSize: 13,
    color: '#94a3b8',
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    gap: 12,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  rowText: { flex: 1 },
  rowLabel: {
    fontSize: 14,
    color: '#0f172a',
    fontWeight: '600',
  },
  rowSub: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  rowValue: {
    fontSize: 16,
    fontWeight: '800',
    minWidth: 56,
    textAlign: 'right',
  },
  helperLine: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 10,
    lineHeight: 17,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  helperBold: {
    fontWeight: '700',
    color: '#0f172a',
  },
});

export default TelemetryCard;
