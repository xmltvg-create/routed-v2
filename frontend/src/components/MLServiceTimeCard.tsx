/**
 * MLServiceTimeCard
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 ML — service-time learner status + train-now button.
 *
 * Backend endpoints used:
 *   - GET  /api/_meta/ml/model   → driver-friendly summary
 *   - POST /api/_meta/ml/train   → re-train from current archived routes
 *
 * The training step is cheap (~150 ms for 200 samples), single-user,
 * idempotent — replaces the previous model in the same Mongo doc. We
 * call it on-demand from this card; auto-retrain on archive is a Phase
 * 1.5 task that doesn't block shipping the model.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

interface MLSummary {
  trained: boolean;
  sample_count: number;
  suburbs_covered: number;
  hour_buckets_covered: number;
  global_median_seconds: number;
  fastest_bucket_seconds: number | null;
  slowest_bucket_seconds: number | null;
  trained_at: string | null;
}

function secsLabel(v: number | null | undefined): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—';
  if (v < 60) return `${Math.round(v)}s`;
  return `${(v / 60).toFixed(1)}m`;
}

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  try {
    const then = new Date(iso).getTime();
    const ago = Math.max(0, Date.now() - then);
    if (ago < 60_000) return `${Math.floor(ago / 1000)}s ago`;
    if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
    if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
    return `${Math.floor(ago / 86_400_000)}d ago`;
  } catch {
    return 'recently';
  }
}

export const MLServiceTimeCard: React.FC = () => {
  const [summary, setSummary] = useState<MLSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [training, setTraining] = useState(false);
  const [trainResult, setTrainResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await AsyncStorage.getItem('session_token');
      if (!token) { setError('Sign in to view model'); return; }
      const r = await fetch(`${BACKEND_URL}/api/_meta/ml/model`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) { setError(`Unavailable (HTTP ${r.status})`); return; }
      const j = await r.json();
      setSummary(j.model as MLSummary);
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleTrain = useCallback(async () => {
    setTraining(true);
    setTrainResult(null);
    try {
      const token = await AsyncStorage.getItem('session_token');
      if (!token) throw new Error('Not signed in');
      const r = await fetch(`${BACKEND_URL}/api/_meta/ml/train`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = body?.detail || `HTTP ${r.status}`;
        setTrainResult({ ok: false, message: `Train failed: ${detail}` });
        return;
      }
      setTrainResult({
        ok: true,
        message: `Trained ${body.sample_count} samples → ${body.bucket_count} buckets`,
      });
      // Pull the fresh summary so the panel reflects new state immediately.
      await load();
    } catch (e: any) {
      setTrainResult({ ok: false, message: e?.message || 'Network error' });
    } finally {
      setTraining(false);
    }
  }, [load]);

  if (loading) {
    return (
      <View style={styles.card} testID="ml-card-loading">
        <View style={styles.headerRow}>
          <Ionicons name="hardware-chip-outline" size={18} color="#475569" />
          <Text style={styles.title}>Service-time learner</Text>
        </View>
        <View style={styles.loadingBlock}>
          <ActivityIndicator size="small" color="#94a3b8" />
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.card} testID="ml-card-error">
        <View style={styles.headerRow}>
          <Ionicons name="hardware-chip-outline" size={18} color="#475569" />
          <Text style={styles.title}>Service-time learner</Text>
          <TouchableOpacity onPress={load} hitSlop={8} testID="ml-card-retry">
            <Ionicons name="refresh-outline" size={18} color="#64748b" />
          </TouchableOpacity>
        </View>
        <Text style={styles.errorLine}>{error}</Text>
      </View>
    );
  }

  const trained = summary?.trained === true;

  return (
    <View style={styles.card} testID="ml-card">
      <View style={styles.headerRow}>
        <Ionicons name="hardware-chip-outline" size={18} color="#475569" />
        <Text style={styles.title}>Service-time learner</Text>
        <TouchableOpacity onPress={load} hitSlop={8} testID="ml-card-refresh">
          <Ionicons name="refresh-outline" size={18} color="#64748b" />
        </TouchableOpacity>
      </View>

      {trained && summary ? (
        <>
          <Text style={styles.subline}>
            Trained {relTime(summary.trained_at)} · {summary.sample_count} samples
          </Text>
          <View style={styles.gridRow}>
            <View style={styles.gridCell}>
              <Text style={styles.gridValue} testID="ml-suburbs-covered">{summary.suburbs_covered}</Text>
              <Text style={styles.gridLabel}>suburbs</Text>
            </View>
            <View style={styles.gridCell}>
              <Text style={styles.gridValue} testID="ml-global-median">{secsLabel(summary.global_median_seconds)}</Text>
              <Text style={styles.gridLabel}>median</Text>
            </View>
            <View style={styles.gridCell}>
              <Text style={styles.gridValue} testID="ml-fastest">{secsLabel(summary.fastest_bucket_seconds)}</Text>
              <Text style={styles.gridLabel}>fastest</Text>
            </View>
            <View style={styles.gridCell}>
              <Text style={styles.gridValue} testID="ml-slowest">{secsLabel(summary.slowest_bucket_seconds)}</Text>
              <Text style={styles.gridLabel}>slowest</Text>
            </View>
          </View>
        </>
      ) : (
        <Text style={styles.helperLine}>
          No model trained yet. Archive at least 3 routes with the geofence firing, then tap <Text style={styles.helperBold}>Train Now</Text>.
        </Text>
      )}

      <TouchableOpacity
        style={[styles.trainButton, training && styles.trainButtonBusy]}
        onPress={handleTrain}
        disabled={training}
        testID="ml-train-button"
      >
        <Ionicons
          name={training ? 'hourglass-outline' : (trained ? 'refresh-outline' : 'flash-outline')}
          size={16}
          color="#fff"
        />
        <Text style={styles.trainButtonText}>
          {training ? 'Training…' : trained ? 'Retrain Now' : 'Train Now'}
        </Text>
      </TouchableOpacity>

      {trainResult ? (
        <View
          style={[
            styles.resultPanel,
            trainResult.ok ? styles.resultOk : styles.resultFail,
          ]}
        >
          <Ionicons
            name={trainResult.ok ? 'checkmark-circle' : 'alert-circle'}
            size={14}
            color={trainResult.ok ? '#065f46' : '#991b1b'}
          />
          <Text style={[styles.resultText, { color: trainResult.ok ? '#065f46' : '#991b1b' }]}>
            {trainResult.message}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 14, fontWeight: '700', color: '#0f172a', flex: 1 },
  subline: { fontSize: 12, color: '#64748b', marginTop: 2, marginBottom: 10 },
  loadingBlock: { paddingVertical: 12, alignItems: 'center' },
  errorLine: { fontSize: 13, color: '#94a3b8', paddingVertical: 8 },
  gridRow: {
    flexDirection: 'row',
    gap: 8,
    marginVertical: 10,
  },
  gridCell: {
    flex: 1,
    paddingVertical: 10,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    alignItems: 'center',
  },
  gridValue: { fontSize: 18, fontWeight: '800', color: '#0f172a' },
  gridLabel: { fontSize: 10, color: '#64748b', marginTop: 2, letterSpacing: 0.3 },
  helperLine: {
    fontSize: 12,
    color: '#64748b',
    lineHeight: 17,
    marginVertical: 8,
  },
  helperBold: { fontWeight: '700', color: '#0f172a' },
  trainButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 8,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#8b5cf6',  // violet-500 — distinct from emerald Save Route
  },
  trainButtonBusy: { backgroundColor: '#a78bfa' },
  trainButtonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  resultPanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  resultOk: { backgroundColor: '#ecfdf5', borderColor: '#a7f3d0' },
  resultFail: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  resultText: { flex: 1, fontSize: 12, lineHeight: 16, fontWeight: '500' },
});

export default MLServiceTimeCard;
