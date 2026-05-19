import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useStopsStore } from '../src/store/stopsStore';
import { stopPinNumber } from '../src/utils/stopPinNumber';
import {
  assignBin,
  binLabel,
  useVanLayoutStore,
} from '../src/store/vanLayoutStore';

/**
 * Load-Van flow — once the route is optimised, this screen walks the
 * driver through loading parcels into their pre-configured van grid in
 * the order they should physically pack them.
 *
 * Loading rule (from the user spec):
 *   "Reverse-order zone: last-stop-first → bottom-row first"
 *
 * Concretely, the LAST delivery is loaded FIRST (deepest in the van,
 * bottom-row bin) and the FIRST delivery is loaded LAST (closest to
 * the door, top-row bin). Drivers can tick each parcel as they place
 * it; "loaded" state is persisted in AsyncStorage per route so the
 * driver can close the app and resume where they left off.
 *
 * Visual spec — Swiss Brutalist (matches `configure-van.tsx`):
 *   4px black borders, safety-orange highlights, monospace bin labels,
 *   ≥56px tap targets for glove use.
 */

const LOADED_STORAGE_PREFIX = 'load-van-loaded:';

export default function LoadVan() {
  const insets = useSafeAreaInsets();
  const stops = useStopsStore((s) => s.stops);
  const fetchStops = useStopsStore((s) => s.fetchStops);
  const layout = useVanLayoutStore((s) => s.layout);
  const fetchLayout = useVanLayoutStore((s) => s.fetchLayout);
  const layoutLoading = useVanLayoutStore((s) => s.loading);

  const [loadedIds, setLoadedIds] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    fetchStops();
    fetchLayout();
  }, [fetchStops, fetchLayout]);

  // Pending stops sorted by delivery order (0 = first delivered).
  const deliveryOrdered = useMemo(
    () =>
      stops
        .filter((s) => !s.completed)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [stops],
  );

  // Storage key fingerprints the current pending route so the loaded
  // ticks reset when the driver re-optimises with a different sequence.
  const routeKey = useMemo(
    () =>
      deliveryOrdered.length === 0
        ? ''
        : `${LOADED_STORAGE_PREFIX}${deliveryOrdered
            .map((s) => s.id)
            .join('|')}`,
    [deliveryOrdered],
  );

  useEffect(() => {
    if (!routeKey) {
      setHydrated(true);
      return;
    }
    setHydrated(false);
    AsyncStorage.getItem(routeKey)
      .then((raw) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Record<string, boolean>;
            setLoadedIds(parsed);
          } catch {
            setLoadedIds({});
          }
        } else {
          setLoadedIds({});
        }
      })
      .finally(() => setHydrated(true));
  }, [routeKey]);

  const persist = (next: Record<string, boolean>) => {
    setLoadedIds(next);
    if (routeKey) {
      AsyncStorage.setItem(routeKey, JSON.stringify(next)).catch(() => {});
    }
  };

  const toggleLoaded = (id: string) => {
    const next = { ...loadedIds, [id]: !loadedIds[id] };
    persist(next);
  };

  const markAll = (loaded: boolean) => {
    const next: Record<string, boolean> = {};
    deliveryOrdered.forEach((s) => {
      next[s.id] = loaded;
    });
    persist(next);
  };

  const rows = layout?.rows ?? 3;
  const cols = layout?.cols ?? 3;

  // Loading order = REVERSE delivery order. Last stop in the route is
  // loaded first (bottom row), first stop is loaded last (top row, closest
  // to the door).
  const loadSequence = useMemo(() => {
    const total = deliveryOrdered.length;
    return [...deliveryOrdered]
      .map((stop, deliveryIdx) => {
        const bin = assignBin(deliveryIdx, total, rows, cols);
        return {
          stop,
          deliveryIdx,
          bin,
          loadIdx: total - 1 - deliveryIdx,
        };
      })
      .sort((a, b) => a.loadIdx - b.loadIdx);
  }, [deliveryOrdered, rows, cols]);

  // Per-bin parcel count for the mini preview at the top.
  const binCounts = useMemo(() => {
    const counts: Record<string, { total: number; loaded: number }> = {};
    loadSequence.forEach(({ stop, bin }) => {
      const k = bin.label;
      if (!counts[k]) counts[k] = { total: 0, loaded: 0 };
      counts[k].total += 1;
      if (loadedIds[stop.id]) counts[k].loaded += 1;
    });
    return counts;
  }, [loadSequence, loadedIds]);

  const loadedCount = loadSequence.filter((it) => loadedIds[it.stop.id]).length;
  const totalCount = loadSequence.length;
  const allLoaded = totalCount > 0 && loadedCount === totalCount;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backButton}
          hitSlop={12}
          data-testid="load-van-back-button"
        >
          <Ionicons name="arrow-back" size={28} color="#09090B" />
        </Pressable>
        <Text style={styles.headerTitle} data-testid="load-van-title">
          LOAD VAN
        </Text>
        <View style={styles.progressPill} data-testid="load-van-progress">
          <Text style={styles.progressText}>
            {loadedCount}/{totalCount}
          </Text>
        </View>
      </View>

      {/* Quick-launcher into the camera scanner. Sits below the header so
          drivers can either work through the manifest list manually OR
          open the scanner for fast bulk loading. The scanner itself
          gates on route confirmation (see van-scan.tsx), but we surface
          the precondition here too so the driver isn't surprised by a
          wall after tapping. */}
      {totalCount > 0 && (() => {
        const routeConfirmed = stops.some(
          (s: any) => typeof s.original_sequence === 'number',
        );
        return (
          <Pressable
            style={[styles.scanCta, !routeConfirmed && { opacity: 0.6 }]}
            onPress={() => router.push('/van-scan')}
            data-testid="open-van-scan"
          >
            <Ionicons name={routeConfirmed ? 'scan' : 'lock-closed'} size={20} color="#fff" />
            <Text style={styles.scanCtaText}>
              {routeConfirmed
                ? 'Scan Barcodes to Load Van'
                : 'Confirm route first to enable scan'}
            </Text>
            <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.7)" />
          </Pressable>
        );
      })()}

      {(layoutLoading || !hydrated) && (
        <View style={styles.fullCenter}>
          <ActivityIndicator size="large" color="#09090B" />
        </View>
      )}

      {!layoutLoading && hydrated && totalCount === 0 && (
        <View style={styles.fullCenter} data-testid="load-van-empty-state">
          <Text style={styles.emptyTitle}>NO STOPS TO LOAD</Text>
          <Text style={styles.emptyBody}>
            Optimise a route on the planner first, then come back here to load
            your van.
          </Text>
        </View>
      )}

      {!layoutLoading && hydrated && totalCount > 0 && (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Mini grid preview with fill counts */}
          <Text style={styles.smallLabel}>VAN GRID · {rows}×{cols}</Text>
          <View style={styles.previewContainer} data-testid="load-van-preview-grid">
            {Array.from({ length: rows }).map((_, rowIdx) => (
              <View key={rowIdx} style={styles.previewRow}>
                {Array.from({ length: cols }).map((__, colIdx) => {
                  const lbl = binLabel(rowIdx, colIdx);
                  const c = binCounts[lbl];
                  const filled = c && c.loaded === c.total && c.total > 0;
                  const empty = !c || c.total === 0;
                  return (
                    <View
                      key={lbl}
                      style={[
                        styles.previewCell,
                        filled && styles.previewCellFilled,
                        empty && styles.previewCellEmpty,
                      ]}
                      data-testid={`load-van-bin-${lbl}`}
                    >
                      <Text
                        style={[
                          styles.previewCellLabel,
                          filled && styles.previewCellLabelFilled,
                        ]}
                      >
                        {lbl}
                      </Text>
                      {!empty && (
                        <Text
                          style={[
                            styles.previewCellCount,
                            filled && styles.previewCellLabelFilled,
                          ]}
                        >
                          {c!.loaded}/{c!.total}
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
            ))}
          </View>

          <Text style={styles.helperNote}>
            Load in this order. The <Text style={styles.helperNoteMono}>last</Text>{' '}
            stop goes in <Text style={styles.helperNoteMono}>first</Text>{' '}
            (deepest in van), the first stop goes in last (by the door).
          </Text>

          {/* Bulk actions */}
          <View style={styles.bulkRow}>
            <Pressable
              style={styles.bulkBtn}
              onPress={() => markAll(true)}
              data-testid="load-van-mark-all"
            >
              <Ionicons name="checkmark-done" size={16} color="#09090B" />
              <Text style={styles.bulkBtnText}>MARK ALL LOADED</Text>
            </Pressable>
            <Pressable
              style={styles.bulkBtn}
              onPress={() => markAll(false)}
              data-testid="load-van-reset"
            >
              <Ionicons name="refresh" size={16} color="#09090B" />
              <Text style={styles.bulkBtnText}>RESET</Text>
            </Pressable>
          </View>

          {/* Stop rows in load order */}
          <Text style={styles.smallLabel}>LOAD SEQUENCE</Text>
          <View style={styles.list} data-testid="load-van-list">
            {loadSequence.map(({ stop, deliveryIdx, bin, loadIdx }) => {
              const isLoaded = !!loadedIds[stop.id];
              return (
                <Pressable
                  key={stop.id}
                  onPress={() => toggleLoaded(stop.id)}
                  style={[styles.row, isLoaded && styles.rowLoaded]}
                  data-testid={`load-van-row-${stop.id}`}
                >
                  <View style={styles.rowLeft}>
                    <Text style={styles.loadIdx}>#{loadIdx + 1}</Text>
                    <View
                      style={[
                        styles.binBadge,
                        isLoaded && styles.binBadgeLoaded,
                      ]}
                    >
                      <Text
                        style={[
                          styles.binBadgeText,
                          isLoaded && styles.binBadgeTextLoaded,
                        ]}
                      >
                        {bin.label}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.rowMid}>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.rowName,
                        isLoaded && styles.rowNameLoaded,
                      ]}
                    >
                      {stop.name || stop.address || 'Stop'}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.rowSub,
                        isLoaded && styles.rowSubLoaded,
                      ]}
                    >
                      Stop #{stopPinNumber(stop) ?? '—'} · {stop.address}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.checkbox,
                      isLoaded && styles.checkboxLoaded,
                    ]}
                    data-testid={`load-van-check-${stop.id}`}
                  >
                    {isLoaded && (
                      <Ionicons name="checkmark" size={22} color="#FFFFFF" />
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      )}

      {/* Sticky bottom action bar */}
      {totalCount > 0 && (
        <View
          style={[
            styles.bottomBar,
            { paddingBottom: Math.max(insets.bottom, 16) },
          ]}
        >
          <Pressable
            onPress={() => router.back()}
            style={[
              styles.primaryButton,
              !allLoaded && styles.primaryButtonMuted,
            ]}
            data-testid="load-van-done-button"
          >
            <Text style={styles.primaryButtonText}>
              {allLoaded ? 'ALL LOADED · BACK TO ROUTE' : 'DONE FOR NOW'}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 4,
    borderBottomColor: '#09090B',
    gap: 12,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#09090B',
    letterSpacing: 1,
    flex: 1,
  },
  progressPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#09090B',
    borderRadius: 6,
    minWidth: 64,
    alignItems: 'center',
  },
  progressText: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
    fontSize: 14,
    letterSpacing: 0.5,
  },
  scanCta: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    marginHorizontal: 16,
    marginTop: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    elevation: 4,
  },
  scanCtaText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    flex: 1,
    marginLeft: 12,
    letterSpacing: 0.3,
  },
  fullCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#09090B',
    letterSpacing: 1,
    marginBottom: 12,
  },
  emptyBody: {
    fontSize: 15,
    color: '#52525B',
    textAlign: 'center',
    lineHeight: 22,
  },
  scrollContent: { padding: 24, paddingBottom: 32 },
  smallLabel: {
    fontSize: 12,
    color: '#52525B',
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  previewContainer: {
    backgroundColor: '#F4F4F5',
    borderWidth: 4,
    borderColor: '#09090B',
    borderRadius: 8,
    padding: 12,
    gap: 12,
    marginBottom: 12,
  },
  previewRow: { flexDirection: 'row', gap: 12 },
  previewCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 4,
    borderColor: '#09090B',
    borderRadius: 6,
    minHeight: 64,
    paddingVertical: 6,
  },
  previewCellFilled: {
    backgroundColor: '#FF5A00',
    borderColor: '#FF5A00',
  },
  previewCellEmpty: {
    backgroundColor: '#FFFFFF',
    borderColor: '#A1A1AA',
    borderStyle: 'dashed',
  },
  previewCellLabel: {
    fontSize: 22,
    fontWeight: '900',
    color: '#09090B',
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  previewCellLabelFilled: { color: '#FFFFFF' },
  previewCellCount: {
    fontSize: 11,
    fontWeight: '700',
    color: '#52525B',
    letterSpacing: 0.5,
    marginTop: 2,
  },
  helperNote: {
    fontSize: 14,
    color: '#52525B',
    lineHeight: 22,
    marginBottom: 16,
  },
  helperNoteMono: {
    fontWeight: '900',
    color: '#09090B',
    fontVariant: ['tabular-nums'],
  },
  bulkRow: { flexDirection: 'row', gap: 12, marginBottom: 24 },
  bulkBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 4,
    borderColor: '#09090B',
    borderRadius: 6,
  },
  bulkBtnText: {
    fontSize: 12,
    fontWeight: '900',
    color: '#09090B',
    letterSpacing: 1,
  },
  list: { gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 4,
    borderColor: '#09090B',
    borderRadius: 8,
    minHeight: 64,
  },
  rowLoaded: {
    backgroundColor: '#F4F4F5',
    opacity: 0.7,
  },
  rowLeft: { gap: 4, alignItems: 'center', minWidth: 56 },
  loadIdx: {
    fontSize: 11,
    fontWeight: '900',
    color: '#52525B',
    letterSpacing: 1,
  },
  binBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#FF5A00',
    borderRadius: 4,
    minWidth: 44,
    alignItems: 'center',
  },
  binBadgeLoaded: { backgroundColor: '#A1A1AA' },
  binBadgeText: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  binBadgeTextLoaded: { color: '#FFFFFF' },
  rowMid: { flex: 1, gap: 2 },
  rowName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#09090B',
  },
  rowNameLoaded: {
    textDecorationLine: 'line-through',
    color: '#52525B',
  },
  rowSub: { fontSize: 12, color: '#52525B' },
  rowSubLoaded: { color: '#71717A' },
  checkbox: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: '#09090B',
    borderRadius: 4,
    backgroundColor: '#FFFFFF',
  },
  checkboxLoaded: {
    backgroundColor: '#FF5A00',
    borderColor: '#FF5A00',
  },
  bottomBar: {
    paddingHorizontal: 16,
    paddingTop: 16,
    borderTopWidth: 4,
    borderTopColor: '#09090B',
    backgroundColor: '#FFFFFF',
  },
  primaryButton: {
    height: 56,
    backgroundColor: '#FF5A00',
    borderWidth: 4,
    borderColor: '#09090B',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonMuted: { backgroundColor: '#09090B', borderColor: '#09090B' },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
});
