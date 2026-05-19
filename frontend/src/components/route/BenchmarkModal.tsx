import React, { useCallback, useMemo } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStopsStore, BenchmarkResult } from '../../store/stopsStore';

const ALGO_LABELS: Record<string, string> = {
  vroom_lkh_3opt: 'VROOM+LKH+3opt',
  vroom_ortools: 'VROOM→OR-Tools',
  timefold: 'Timefold',
  vroom: 'VROOM',
  lkh: 'LKH-3',
  alns: 'ALNS Hybrid',
  ortools: 'OR-Tools',
  pyvrp: 'PyVRP (HGS)',
  ils: 'ILS',
  nearest_neighbor: 'Nearest Neighbor',
  two_opt: '2-Opt',
  three_opt: '3-Opt',
  simulated_annealing: 'Sim. Annealing',
  genetic: 'Genetic',
  clarke_wright: 'Clarke-Wright',
};

const ALGO_COLORS: Record<string, string> = {
  vroom_lkh_3opt: '#f59e0b',
  vroom_ortools: '#ec4899',
  timefold: '#14b8a6',
  vroom: '#22c55e',
  lkh: '#a855f7',
  alns: '#6366f1',
  ortools: '#2563eb',
  pyvrp: '#10b981',
  ils: '#eab308',
  nearest_neighbor: '#059669',
  two_opt: '#d97706',
  three_opt: '#f97316',
  simulated_annealing: '#dc2626',
  genetic: '#7c3aed',
  clarke_wright: '#0891b2',
};

function formatTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function BarChart({
  results,
  bestDist,
  onApply,
  applyingAlgo,
}: {
  results: BenchmarkResult[];
  bestDist: number;
  onApply?: (algo: string) => void;
  applyingAlgo?: string | null;
}) {
  const maxDist = Math.max(...results.map((r) => r.total_distance_km || 0));
  if (maxDist === 0) return null;

  return (
    <View style={styles.barChartContainer}>
      {results.map((r) => {
        const dist = r.total_distance_km || 0;
        const widthPct = (dist / maxDist) * 100;
        const isWinner = dist === bestDist;
        const color = ALGO_COLORS[r.algorithm] || '#6b7280';
        const applying = applyingAlgo === r.algorithm;

        return (
          <View key={r.algorithm} style={styles.barRow}>
            <Text style={styles.barLabel} numberOfLines={1}>
              {ALGO_LABELS[r.algorithm] || r.algorithm}
            </Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${widthPct}%`, backgroundColor: color }]}>
                {isWinner && (
                  <View style={styles.winnerBadge}>
                    <Text style={styles.winnerText}>BEST</Text>
                  </View>
                )}
              </View>
            </View>
            <Text style={styles.barValue}>{dist.toFixed(1)}km</Text>
            {onApply && (
              <TouchableOpacity
                style={[styles.applyBtn, applying && styles.applyBtnBusy]}
                onPress={() => onApply(r.algorithm)}
                disabled={!!applyingAlgo}
                data-testid={`benchmark-apply-${r.algorithm}`}
              >
                {applying ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="checkmark" size={14} color="#fff" />
                )}
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </View>
  );
}

function MetricsTable({ results }: { results: BenchmarkResult[] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View>
        <View style={styles.tableHeader}>
          <Text style={[styles.tableCell, styles.headerCell, { width: 130 }]}>Algorithm</Text>
          <Text style={[styles.tableCell, styles.headerCell, { width: 80 }]}>Distance</Text>
          <Text style={[styles.tableCell, styles.headerCell, { width: 70 }]}>Time</Text>
          <Text style={[styles.tableCell, styles.headerCell, { width: 75 }]}>Backtracks</Text>
          <Text style={[styles.tableCell, styles.headerCell, { width: 75 }]}>Cluster</Text>
          <Text style={[styles.tableCell, styles.headerCell, { width: 80 }]}>Long Leg</Text>
        </View>
        {results.map((r, i) => (
          <View key={r.algorithm} style={[styles.tableRow, i % 2 === 0 ? styles.tableRowEven : undefined]}>
            <Text style={[styles.tableCell, { width: 130, fontWeight: '600', color: ALGO_COLORS[r.algorithm] || '#e5e7eb' }]}>
              {ALGO_LABELS[r.algorithm] || r.algorithm}
            </Text>
            <Text style={[styles.tableCell, { width: 80 }]}>{r.total_distance_km?.toFixed(1)}km</Text>
            <Text style={[styles.tableCell, { width: 70 }]}>{formatTime(r.time_ms)}</Text>
            <Text style={[styles.tableCell, { width: 75 }]}>{r.quality?.backtrack_count ?? '-'}</Text>
            <Text style={[styles.tableCell, { width: 75 }]}>
              {r.quality?.cluster_score != null ? `${(r.quality.cluster_score * 100).toFixed(1)}%` : '-'}
            </Text>
            <Text style={[styles.tableCell, { width: 80 }]}>{r.quality?.longest_leg_km?.toFixed(2) ?? '-'}km</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Current driver location used so the benchmark uses the same starting point as /optimize. */
  currentLocation?: { latitude: number; longitude: number } | null;
  /** Called when the user taps "Apply" on a row. Parent runs optimize with that algorithm, then closes. */
  onApplyAlgorithm?: (algorithm: string) => Promise<void>;
}

export default function BenchmarkModal({ visible, onClose, currentLocation, onApplyAlgorithm }: Props) {
  const { benchmarking, lastBenchmark, benchmarkRoute } = useStopsStore();
  const [applyingAlgo, setApplyingAlgo] = React.useState<string | null>(null);

  const handleRun = useCallback(() => {
    benchmarkRoute(currentLocation?.latitude, currentLocation?.longitude);
  }, [benchmarkRoute, currentLocation]);

  const handleApply = useCallback(
    async (algo: string) => {
      if (!onApplyAlgorithm || applyingAlgo) return;
      setApplyingAlgo(algo);
      try {
        await onApplyAlgorithm(algo);
        onClose();
      } finally {
        setApplyingAlgo(null);
      }
    },
    [onApplyAlgorithm, applyingAlgo, onClose],
  );

  const successResults = useMemo(() => {
    if (!lastBenchmark) return [];
    return lastBenchmark.results.filter((r: BenchmarkResult) => !r.error);
  }, [lastBenchmark]);

  const bestDist = useMemo(() => {
    if (successResults.length === 0) return 0;
    return Math.min(...successResults.map((r: BenchmarkResult) => r.total_distance_km));
  }, [successResults]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Ionicons name="speedometer" size={22} color="#818cf8" />
              <Text style={styles.title}>Algorithm Benchmark</Text>
            </View>
            <TouchableOpacity onPress={onClose} data-testid="benchmark-close-btn">
              <Ionicons name="close" size={24} color="#9ca3af" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {/* Run button */}
            <TouchableOpacity
              style={[styles.runButton, benchmarking && styles.runButtonDisabled]}
              onPress={handleRun}
              disabled={benchmarking}
              data-testid="benchmark-run-btn"
            >
              {benchmarking ? (
                <>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={styles.runButtonText}>Running all algorithms...</Text>
                </>
              ) : (
                <>
                  <Ionicons name="play" size={18} color="#fff" />
                  <Text style={styles.runButtonText}>
                    {lastBenchmark ? 'Re-run Benchmark' : 'Run Benchmark'}
                  </Text>
                </>
              )}
            </TouchableOpacity>

            {lastBenchmark && successResults.length > 0 && (
              <>
                {/* Summary */}
                <View style={styles.summaryRow}>
                  <View style={styles.summaryCard}>
                    <Text style={styles.summaryLabel}>Stops</Text>
                    <Text style={styles.summaryValue}>{lastBenchmark.stop_count}</Text>
                  </View>
                  <View style={styles.summaryCard}>
                    <Text style={styles.summaryLabel}>Winner</Text>
                    <Text
                      style={[
                        styles.summaryValue,
                        { color: ALGO_COLORS[lastBenchmark.winner || ''] || '#10b981' },
                      ]}
                    >
                      {ALGO_LABELS[lastBenchmark.winner || ''] || lastBenchmark.winner}
                    </Text>
                  </View>
                  <View style={styles.summaryCard}>
                    <Text style={styles.summaryLabel}>Best Dist</Text>
                    <Text style={styles.summaryValue}>{bestDist.toFixed(1)}km</Text>
                  </View>
                </View>

                {/* Apply winner CTA — one-tap shortcut */}
                {onApplyAlgorithm && lastBenchmark.winner && (
                  <TouchableOpacity
                    style={[styles.applyWinnerBtn, !!applyingAlgo && styles.runButtonDisabled]}
                    onPress={() => handleApply(lastBenchmark.winner as string)}
                    disabled={!!applyingAlgo}
                    data-testid="benchmark-apply-winner-btn"
                  >
                    {applyingAlgo === lastBenchmark.winner ? (
                      <>
                        <ActivityIndicator color="#fff" size="small" />
                        <Text style={styles.runButtonText}>Applying winner…</Text>
                      </>
                    ) : (
                      <>
                        <Ionicons name="trophy" size={18} color="#fff" />
                        <Text style={styles.runButtonText}>
                          Apply winner: {ALGO_LABELS[lastBenchmark.winner] || lastBenchmark.winner}
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}

                {/* Bar chart with per-row apply */}
                <Text style={styles.sectionTitle}>
                  Distance Comparison {onApplyAlgorithm ? '(tap ✓ to apply)' : ''}
                </Text>
                <BarChart
                  results={successResults}
                  bestDist={bestDist}
                  onApply={onApplyAlgorithm ? handleApply : undefined}
                  applyingAlgo={applyingAlgo}
                />

                {/* Metrics table */}
                <Text style={styles.sectionTitle}>Detailed Metrics</Text>
                <MetricsTable results={successResults} />

                {/* Errors */}
                {lastBenchmark.results.filter((r: BenchmarkResult) => r.error).length > 0 && (
                  <View style={styles.errorSection}>
                    <Text style={styles.errorTitle}>Failed Algorithms</Text>
                    {lastBenchmark.results
                      .filter((r: BenchmarkResult) => r.error)
                      .map((r: BenchmarkResult) => (
                        <Text key={r.algorithm} style={styles.errorText}>
                          {ALGO_LABELS[r.algorithm] || r.algorithm}: {r.error}
                        </Text>
                      ))}
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  container: { backgroundColor: '#1a1a2e', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%', paddingBottom: 24 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#2a2a4a' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 18, fontWeight: '700', color: '#e5e7eb' },
  content: { padding: 16 },
  runButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#6366f1', borderRadius: 12, padding: 14, marginBottom: 16 },
  runButtonDisabled: { opacity: 0.6 },
  runButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  applyWinnerBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#10b981', borderRadius: 12, padding: 12, marginBottom: 16 },
  summaryRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  summaryCard: { flex: 1, backgroundColor: '#2a2a4a', borderRadius: 10, padding: 12, alignItems: 'center' },
  summaryLabel: { color: '#9ca3af', fontSize: 11, marginBottom: 4 },
  summaryValue: { color: '#e5e7eb', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  sectionTitle: { color: '#9ca3af', fontSize: 13, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  barChartContainer: { marginBottom: 20 },
  barRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  barLabel: { width: 95, color: '#9ca3af', fontSize: 11, textAlign: 'right', paddingRight: 8 },
  barTrack: { flex: 1, height: 22, backgroundColor: '#2a2a4a', borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 4, justifyContent: 'center', alignItems: 'flex-end', paddingRight: 4 },
  winnerBadge: { backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1 },
  winnerText: { color: '#fff', fontSize: 8, fontWeight: '800' },
  barValue: { width: 55, color: '#e5e7eb', fontSize: 11, textAlign: 'right', paddingLeft: 4 },
  applyBtn: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#10b981', alignItems: 'center', justifyContent: 'center', marginLeft: 6 },
  applyBtnBusy: { backgroundColor: '#059669' },
  tableHeader: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#3a3a5a', paddingBottom: 6, marginBottom: 4 },
  tableRow: { flexDirection: 'row', paddingVertical: 6 },
  tableRowEven: { backgroundColor: 'rgba(42,42,74,0.5)' },
  tableCell: { color: '#d1d5db', fontSize: 12, paddingHorizontal: 4 },
  headerCell: { fontWeight: '700', color: '#9ca3af', fontSize: 11 },
  errorSection: { marginTop: 16, backgroundColor: 'rgba(220,38,38,0.1)', borderRadius: 8, padding: 12 },
  errorTitle: { color: '#f87171', fontWeight: '600', marginBottom: 4 },
  errorText: { color: '#fca5a5', fontSize: 12 },
});
