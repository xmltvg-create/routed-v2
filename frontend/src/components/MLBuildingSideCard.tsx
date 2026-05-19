/**
 * MLBuildingSideCard
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 2 ML — Building-Side Corrector status + train-now button.
 *
 * Backend endpoints used:
 *   - GET  /api/_meta/ml/building-side/model   → driver-friendly summary
 *   - POST /api/_meta/ml/building-side/train   → re-train from archived routes
 *
 * Mapbox returns rooftop centroids; drivers park at the kerb. This model
 * learns the per-suburb median offset and bumps the geofence_inferred
 * acceptance check by checking the CORRECTED centroid as well as the raw
 * one. On industrial complexes where the loading dock is 150 m+ from the
 * roof, this rescues a chunk of fallback_completion stops back into
 * geofence_inferred (and therefore into the ML training pool).
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
  global_offset_metres: number;
  largest_suburb_offset_metres: number | null;
  trained_at: string | null;
}

function metresLabel(v: number | null | undefined): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—';
  return `${Math.round(v)}m`;
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

export const MLBuildingSideCard: React.FC = () => {
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
      const r = await fetch(`${BACKEND_URL}/api/_meta/ml/building-side/model`, {
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
      const r = await fetch(`${BACKEND_URL}/api/_meta/ml/building-side/train`, {
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
        message: `Trained ${body.sample_count} samples → ${body.suburb_count} suburbs`,
      });
      await load();
    } catch (e: any) {
      setTrainResult({ ok: false, message: e?.message || 'Network error' });
    } finally {
      setTraining(false);
    }
  }, [load]);

  if (loading) {
    return (
      <View style={styles.card} testID="ml-bs-card-loading">
        <View style={styles.headerRow}>
          <Ionicons name="business-outline" size={18} color="#475569" />
          <Text style={styles.title}>Building-side corrector</Text>
        </View>
        <View style={styles.loadingBlock}>
          <ActivityIndicator size="small" color="#94a3b8" />
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.card} testID="ml-bs-card-error">
        <View style={styles.headerRow}>
          <Ionicons name="business-outline" size={18} color="#475569" />
          <Text style={styles.title}>Building-side corrector</Text>
          <TouchableOpacity onPress={load} hitSlop={8} testID="ml-bs-card-retry">
            <Ionicons name="refresh-outline" size={18} color="#64748b" />
          </TouchableOpacity>
        </View>
        <Text style={styles.errorLine}>{error}</Text>
      </View>
    );
  }

  const trained = summary?.trained === true;

  return (
    <View style={styles.card} testID="ml-bs-card">
      <View style={styles.headerRow}>
        <Ionicons name="business-outline" size={18} color="#475569" />
        <Text style={styles.title}>Building-side corrector</Text>
        <TouchableOpacity onPress={load} hitSlop={8} testID="ml-bs-card-refresh">
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
              <Text style={styles.gridValue} testID="ml-bs-suburbs-covered">{summary.suburbs_covered}</Text>
              <Text style={styles.gridLabel}>suburbs</Text>
            </View>
            <View style={styles.gridCell}>
              <Text style={styles.gridValue} testID="ml-bs-global-offset">{metresLabel(summary.global_offset_metres)}</Text>
              <Text style={styles.gridLabel}>median offset</Text>
            </View>
            <View style={styles.gridCell}>
              <Text style={styles.gridValue} testID="ml-bs-largest-offset">{metresLabel(summary.largest_suburb_offset_metres)}</Text>
              <Text style={styles.gridLabel}>largest</Text>
            </View>
          </View>
        </>
      ) : (
        <Text style={styles.helperLine}>
          No model trained yet. Mapbox pins on rooftops; drivers park at kerbs. Once you've archived ~5 deliveries per suburb with GPS on, tap <Text style={styles.helperBold}>Train Now</Text> to learn the offset.
        </Text>
      )}

      <TouchableOpacity
        style={[styles.trainButton, training && styles.trainButtonBusy]}
        onPress={handleTrain}
        disabled={training}
        testID="ml-bs-train-button"
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
    backgroundColor: '#0ea5e9',  // sky-500 — distinct from violet service-time ML
  },
  trainButtonBusy: { backgroundColor: '#38bdf8' },
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

export default MLBuildingSideCard;
