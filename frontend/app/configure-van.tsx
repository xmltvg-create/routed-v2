import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import {
  binLabel,
  useVanLayoutStore,
  VAN_LAYOUT_OPTIONS,
} from '../src/store/vanLayoutStore';

/**
 * One-time setup: pick the van's bin grid shape (2×3 / 3×3 / 3×4) and save
 * it to the driver's account. Subsequent screens use this grid to suggest
 * bin labels (A1, B2…) when loading parcels and to display the giant
 * orange bin pin on the stop-detail card.
 *
 * Visual spec from `/app/design_guidelines.json` ("Swiss Brutalist"):
 *  - Stark white background, jet-black text, safety-orange primary action
 *  - Thick 4px borders + hard 4px offset shadows (no soft shadows / blur)
 *  - All tap targets ≥ 56px tall for glove-wearing drivers
 *  - Monospace bin labels (A1, B2) for unambiguous reading
 */
export default function ConfigureVan() {
  const insets = useSafeAreaInsets();
  const layout = useVanLayoutStore((s) => s.layout);
  const fetchLayout = useVanLayoutStore((s) => s.fetchLayout);
  const saveLayout = useVanLayoutStore((s) => s.saveLayout);
  const loading = useVanLayoutStore((s) => s.loading);
  const saving = useVanLayoutStore((s) => s.saving);

  // Local pending selection: the user may explore shapes without committing
  // until they tap "Save Configuration".
  const [pendingRows, setPendingRows] = useState(3);
  const [pendingCols, setPendingCols] = useState(3);

  useEffect(() => {
    fetchLayout();
  }, [fetchLayout]);

  // When the saved layout loads, seed the pending selection so the user
  // sees their existing choice highlighted.
  useEffect(() => {
    if (layout) {
      setPendingRows(layout.rows);
      setPendingCols(layout.cols);
    }
  }, [layout]);

  const handleSave = async () => {
    const ok = await saveLayout(pendingRows, pendingCols);
    if (!ok) {
      Alert.alert('Save failed', 'Could not save your van layout. Please try again.');
      return;
    }
    Alert.alert('Saved', `Van layout set to ${pendingRows}×${pendingCols}.`, [
      { text: 'OK', onPress: () => router.back() },
    ]);
  };

  const isExisting = layout && !layout.is_default;
  const isUnchanged =
    isExisting && layout!.rows === pendingRows && layout!.cols === pendingCols;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backButton}
          hitSlop={12}
          data-testid="configure-van-back-button"
        >
          <Ionicons name="arrow-back" size={28} color="#09090B" />
        </Pressable>
        <Text style={styles.headerTitle} data-testid="configure-van-title">
          CONFIGURE VAN
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Intro */}
        <Text style={styles.intro}>
          Pick the shape of your van's parcel grid. We'll use this to suggest a bin
          (A1, B2…) for every stop you load.
        </Text>
        <Text style={styles.smallLabel}>STEP 1 OF 1 · SAVED PER DRIVER</Text>

        {/* Shape toggles */}
        <View style={styles.toggleRow} data-testid="van-layout-toggle-row">
          {VAN_LAYOUT_OPTIONS.map((opt) => {
            const selected =
              opt.rows === pendingRows && opt.cols === pendingCols;
            return (
              <Pressable
                key={opt.label}
                onPress={() => {
                  setPendingRows(opt.rows);
                  setPendingCols(opt.cols);
                }}
                style={[styles.toggle, selected && styles.toggleSelected]}
                data-testid={`van-layout-toggle-${opt.label}`}
              >
                <Text
                  style={[
                    styles.toggleLabel,
                    selected && styles.toggleLabelSelected,
                  ]}
                >
                  {opt.label}
                </Text>
                <Text
                  style={[
                    styles.toggleSubLabel,
                    selected && styles.toggleSubLabelSelected,
                  ]}
                >
                  {opt.rows * opt.cols} BINS
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Visual preview grid */}
        <Text style={styles.smallLabel}>PREVIEW</Text>
        <View
          style={styles.previewContainer}
          data-testid="van-layout-preview"
        >
          {Array.from({ length: pendingRows }).map((_, rowIdx) => (
            <View key={rowIdx} style={styles.previewRow}>
              {Array.from({ length: pendingCols }).map((__, colIdx) => (
                <View
                  key={`${rowIdx}-${colIdx}`}
                  style={[
                    styles.previewCell,
                    { aspectRatio: pendingCols / pendingRows > 1 ? 1 : 1 },
                  ]}
                  data-testid={`bin-${binLabel(rowIdx, colIdx)}`}
                >
                  <Text style={styles.previewCellLabel}>
                    {binLabel(rowIdx, colIdx)}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>

        <Text style={styles.helperNote}>
          Rows are A → {String.fromCharCode(64 + pendingRows)} (top to bottom).
          Columns are 1 → {pendingCols} (left to right). The bottom-right bin is{' '}
          <Text style={styles.helperNoteMono}>
            {binLabel(pendingRows - 1, pendingCols - 1)}
          </Text>
          .
        </Text>

        {loading && (
          <View style={styles.loadingPill} data-testid="van-layout-loading">
            <ActivityIndicator size="small" color="#09090B" />
            <Text style={styles.loadingText}>Loading saved layout…</Text>
          </View>
        )}
      </ScrollView>

      {/* Sticky bottom action bar */}
      <View
        style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 16) }]}
      >
        <Pressable
          onPress={handleSave}
          disabled={saving || isUnchanged}
          style={[
            styles.primaryButton,
            (saving || isUnchanged) && styles.primaryButtonDisabled,
          ]}
          data-testid="van-layout-save-button"
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryButtonText}>
              {isUnchanged ? 'ALREADY SAVED' : 'SAVE CONFIGURATION'}
            </Text>
          )}
        </Pressable>
      </View>
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
  },
  scrollContent: { padding: 24, paddingBottom: 32 },
  intro: {
    fontSize: 18,
    color: '#09090B',
    fontWeight: '500',
    lineHeight: 26,
    marginBottom: 24,
  },
  smallLabel: {
    fontSize: 12,
    color: '#52525B',
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  toggleRow: { flexDirection: 'row', gap: 12, marginBottom: 32 },
  toggle: {
    flex: 1,
    minHeight: 80,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 4,
    borderColor: '#09090B',
    borderRadius: 8,
    paddingVertical: 12,
  },
  toggleSelected: {
    backgroundColor: '#FF5A00',
    borderColor: '#FF5A00',
  },
  toggleLabel: {
    fontSize: 28,
    fontWeight: '900',
    color: '#09090B',
    letterSpacing: 0.5,
  },
  toggleLabelSelected: { color: '#FFFFFF' },
  toggleSubLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#52525B',
    letterSpacing: 1,
    marginTop: 2,
  },
  toggleSubLabelSelected: { color: '#FFFFFF' },
  previewContainer: {
    backgroundColor: '#F4F4F5',
    borderWidth: 4,
    borderColor: '#09090B',
    borderRadius: 8,
    padding: 12,
    gap: 12,
    marginBottom: 16,
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
    minHeight: 72,
  },
  previewCellLabel: {
    fontSize: 28,
    fontWeight: '900',
    color: '#09090B',
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  helperNote: {
    fontSize: 14,
    color: '#52525B',
    lineHeight: 22,
    marginTop: 8,
  },
  helperNoteMono: {
    fontWeight: '900',
    color: '#09090B',
    fontVariant: ['tabular-nums'],
  },
  loadingPill: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    marginTop: 16,
  },
  loadingText: { fontSize: 13, color: '#52525B', fontWeight: '600' },
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
  primaryButtonDisabled: { backgroundColor: '#A1A1AA', borderColor: '#52525B' },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
});
