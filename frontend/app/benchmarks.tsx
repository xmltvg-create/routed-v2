/**
 * 14-Solver benchmark exhibit — the technical-credibility companion to
 * /demo. Public, no-auth.
 *
 * Why it exists:
 *   - When a technical judge follows up the cinematic flythrough with
 *     "OK but how do you know your solver's actually good?" — this is
 *     the answer. Every solver name they'd recognise, head-to-head, on
 *     a real ~50-stop delivery route. PyVRP HGS sits at the top with
 *     a quantified gap to second place.
 *   - Bake-once, serve-from-disk model keeps it instant. Running 14
 *     solvers takes 3-5 minutes; we did it offline.
 *
 * What it doesn't do (intentionally):
 *   - Doesn't re-run the benchmark live (~5 min, would kill any demo).
 *   - Doesn't let users tweak solver params (this is a *narrative* screen,
 *     not a control panel).
 *   - Doesn't link to source code (judges who want depth open the GitHub
 *     repo themselves; we keep the screen focused).
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, Stack } from 'expo-router';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

interface Row {
  id: string;
  name: string;
  family: string;
  ok: boolean;
  total_km?: number;
  total_minutes?: number;
  runtime_ms?: number;
  gap_pct?: number | null;
  error?: string;
}
interface BenchmarkResponse {
  schema_version: number;
  generated_at: string;
  scenario: { stop_count: number; naive_km: number; naive_minutes: number };
  best_km: number | null;
  results: Row[];
}

export default function BenchmarksScreen() {
  const router = useRouter();
  const [data, setData] = useState<BenchmarkResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/api/demo/benchmarks`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = (await r.json()) as BenchmarkResponse;
        if (!cancelled) setData(json);
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message ?? 'Failed to load benchmark');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const successCount = useMemo(
    () => (data?.results ?? []).filter((r) => r.ok).length,
    [data],
  );

  if (loadError) {
    return (
      <View style={styles.errContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <Ionicons name="cloud-offline-outline" size={48} color="#94a3b8" />
        <Text style={styles.errText}>Couldn't load benchmark: {loadError}</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.errBack}>
          <Text style={styles.errBackText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!data) {
    return (
      <View style={styles.errContainer}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.errText}>Loading benchmark…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          data-testid="benchmarks-back-btn"
          onPress={() => router.back()}
          style={styles.headerBack}
        >
          <Ionicons name="arrow-back" size={22} color="#cbd5e1" />
        </TouchableOpacity>
        <View style={styles.headerTitleBlock}>
          <Text style={styles.headerKicker}>Solver benchmark</Text>
          <Text style={styles.headerTitle}>14 algorithms · 1 real route</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Summary cards */}
        <View style={styles.summaryRow}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryValue}>{data.scenario.stop_count}</Text>
            <Text style={styles.summaryLabel}>Stops</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryValue}>{successCount} / {data.results.length}</Text>
            <Text style={styles.summaryLabel}>Solvers ran</Text>
          </View>
          <View style={[styles.summaryCard, styles.summaryWinner]}>
            <Text style={[styles.summaryValue, styles.summaryWinnerText]}>
              {data.best_km ?? '—'} km
            </Text>
            <Text style={styles.summaryLabel}>Best (PyVRP)</Text>
          </View>
        </View>

        {/* Methodology blurb */}
        <View style={styles.methodCard}>
          <Text style={styles.methodTitle}>Method</Text>
          <Text style={styles.methodBody}>
            Same {data.scenario.stop_count}-stop manifest from a real
            Sunshine Coast delivery run. Each solver gets the same OSRM road-
            network duration matrix. Wall-clock time includes matrix fetch
            + solve + Pydantic serialisation — what production actually pays.
            Sorted best km first.
          </Text>
        </View>

        {/* Table */}
        <View style={styles.table}>
          <View style={styles.theadRow}>
            <Text style={[styles.thCell, styles.colSolver]}>Solver</Text>
            <Text style={[styles.thCell, styles.colKm]}>km</Text>
            <Text style={[styles.thCell, styles.colGap]}>Gap</Text>
            <Text style={[styles.thCell, styles.colMs]}>ms</Text>
          </View>
          {data.results.map((r, i) => (
            <View
              key={r.id}
              style={[
                styles.tbodyRow,
                i === 0 && r.ok ? styles.tbodyRowWinner : null,
              ]}
              data-testid={`benchmark-row-${r.id}`}
            >
              <View style={[styles.tdCell, styles.colSolver]}>
                <Text style={[styles.tdName, i === 0 && r.ok ? styles.tdNameWinner : null]}>
                  {i === 0 && r.ok ? '🏆 ' : ''}{r.name}
                </Text>
                <Text style={styles.tdFamily}>{r.family}</Text>
              </View>
              {r.ok ? (
                <>
                  <Text style={[styles.tdCell, styles.colKm, styles.tdValue]}>
                    {r.total_km?.toFixed(1)}
                  </Text>
                  <Text
                    style={[
                      styles.tdCell, styles.colGap, styles.tdValue,
                      (r.gap_pct ?? 0) === 0 ? styles.gapWinner :
                      (r.gap_pct ?? 0) < 5 ? styles.gapClose :
                      (r.gap_pct ?? 0) < 15 ? styles.gapMid : styles.gapWide,
                    ]}
                  >
                    {(r.gap_pct ?? 0) === 0 ? '—' : `+${r.gap_pct}%`}
                  </Text>
                  <Text style={[styles.tdCell, styles.colMs, styles.tdMs]}>
                    {(r.runtime_ms! / 1000).toFixed(1)}s
                  </Text>
                </>
              ) : (
                <Text style={[styles.tdCell, styles.colMerged, styles.tdFailed]}>
                  ⏱ {r.error?.includes('Timeout') ? 'Timed out' : 'Failed'}
                </Text>
              )}
            </View>
          ))}
        </View>

        {/* Caveat / small print */}
        <Text style={styles.caveat}>
          Wall-clock numbers are end-to-end /api/optimize calls including
          OSRM matrix and serialisation — not solver-only. Run on the
          Emergent FastAPI pod with Fly.io OSRM.
        </Text>

        <TouchableOpacity
          data-testid="benchmarks-back-cta"
          style={styles.backCta}
          onPress={() => router.back()}
        >
          <Ionicons name="arrow-back" size={18} color="#cbd5e1" />
          <Text style={styles.backCtaText}>Back to demo</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  errContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, backgroundColor: '#0f172a' },
  errText: { color: '#cbd5e1', textAlign: 'center', marginTop: 16, fontSize: 15 },
  errBack: { marginTop: 24, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999, borderWidth: 1, borderColor: '#334155' },
  errBackText: { color: '#94a3b8', fontSize: 14 },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingTop: 50, paddingBottom: 16, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: 'rgba(148,163,184,0.12)',
  },
  headerBack: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(15,23,42,0.7)',
  },
  headerTitleBlock: { flex: 1 },
  headerKicker: { color: '#3b82f6', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase' },
  headerTitle: { color: '#f1f5f9', fontSize: 18, fontWeight: '700' },

  scroll: { padding: 16, paddingBottom: 60 },

  summaryRow: { flexDirection: 'row', gap: 8 },
  summaryCard: {
    flex: 1, paddingVertical: 14, paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: 'rgba(30,41,59,0.7)', borderWidth: 1, borderColor: 'rgba(148,163,184,0.12)',
    alignItems: 'flex-start',
  },
  summaryWinner: { borderColor: 'rgba(16,185,129,0.4)', backgroundColor: 'rgba(16,185,129,0.07)' },
  summaryValue: { color: '#f1f5f9', fontSize: 22, fontWeight: '700' },
  summaryWinnerText: { color: '#10b981' },
  summaryLabel: { color: '#94a3b8', fontSize: 11, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 4 },

  methodCard: {
    marginTop: 14, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(15,23,42,0.6)', borderWidth: 1, borderColor: 'rgba(148,163,184,0.12)',
  },
  methodTitle: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 1.0, textTransform: 'uppercase', marginBottom: 6 },
  methodBody: { color: '#cbd5e1', fontSize: 13, lineHeight: 19 },

  table: { marginTop: 18, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(148,163,184,0.14)' },
  theadRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 12, backgroundColor: 'rgba(15,23,42,0.95)',
    borderBottomWidth: 1, borderBottomColor: 'rgba(148,163,184,0.18)',
  },
  thCell: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  tbodyRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(148,163,184,0.08)',
    backgroundColor: 'rgba(30,41,59,0.45)',
  },
  tbodyRowWinner: { backgroundColor: 'rgba(16,185,129,0.07)' },
  tdCell: { color: '#cbd5e1', fontSize: 14 },
  tdName: { color: '#f1f5f9', fontSize: 14, fontWeight: '600' },
  tdNameWinner: { color: '#10b981' },
  tdFamily: { color: '#64748b', fontSize: 11, marginTop: 2 },
  tdValue: { fontVariant: ['tabular-nums'], fontWeight: '600' },
  tdMs: { color: '#94a3b8', fontVariant: ['tabular-nums'], textAlign: 'right' },
  tdFailed: { color: '#f87171', fontSize: 13 },

  colSolver: { flex: 2.0 },
  colKm: { flex: 0.8, textAlign: 'right' },
  colGap: { flex: 0.8, textAlign: 'right' },
  colMs: { flex: 0.7, textAlign: 'right' },
  colMerged: { flex: 2.3, textAlign: 'right' },

  gapWinner: { color: '#10b981' },
  gapClose: { color: '#3b82f6' },
  gapMid: { color: '#f59e0b' },
  gapWide: { color: '#f87171' },

  caveat: { color: '#64748b', fontSize: 11, lineHeight: 16, marginTop: 14, fontStyle: 'italic' },
  backCta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 48, marginTop: 22, borderRadius: 24, borderWidth: 1, borderColor: '#334155',
  },
  backCtaText: { color: '#cbd5e1', fontSize: 15, fontWeight: '600' },
});
