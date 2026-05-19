import React, { useState } from 'react';
import {
  Pressable, Text, View, StyleSheet, Modal, ScrollView,
  ActivityIndicator, Alert,
} from 'react-native';
import { useStopsStore, type OutlierStop } from '../store/stopsStore';

/**
 * Red guardrail banner that surfaces mis-geocoded stops BEFORE they reach
 * the optimiser. The backend's `/api/stops/outliers` sweep flags any stop
 * sitting more than 50 km from the median cluster centroid — overwhelmingly
 * the signature of a geocoder picking the wrong city (e.g. "Little Mountain"
 * resolving to Mt Isa instead of Sunshine Coast).
 *
 * The banner self-hides when there are no outliers. Tap "Review" to open
 * a modal listing each outlier with its distance + per-stop trash button,
 * plus a single "Remove all far stops" CTA. The remove call hits
 * `/api/stops/outliers/remove` which deletes + reindexes `order` in one
 * roundtrip, so the next optimise won't be poisoned by the bad data.
 */
interface Props {
  /** Optional toast callback. When the user removes outliers, the parent
   *  gets a string like "Removed 1 far stop" to surface as a 2-second toast,
   *  matching the `ClusterWarningsBanner` post-action UX. */
  onSuccess?: (msg: string) => void;
}

export const OutlierWarningBanner: React.FC<Props> = ({ onSuccess }) => {
  const report = useStopsStore((s) => s.outlierReport);
  const removeOutliers = useStopsStore((s) => s.removeOutliers);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!report || !report.outliers || report.outliers.length === 0) return null;

  const outliers = report.outliers;
  const worstKm = outliers[0]?.distance_km ?? 0;

  const removeIds = async (ids: string[], successWord: string) => {
    setBusy(true);
    const deleted = await removeOutliers(ids);
    setBusy(false);
    if (deleted == null) {
      Alert.alert(
        'Could not remove',
        'The route service did not respond. Try again in a moment.',
      );
      return;
    }
    if (deleted === 0) {
      // Server saw zero matches — possibly already removed by another device.
      // Just close the modal silently; the next fetchStops will reconcile.
    } else if (onSuccess) {
      onSuccess(`Removed ${deleted} ${successWord}`);
    }
    if (outliers.length - ids.length <= 0) setModalOpen(false);
  };

  const onRemoveAll = () => removeIds(outliers.map((o) => o.id), outliers.length === 1 ? 'far stop' : 'far stops');
  const onRemoveOne = (o: OutlierStop) => removeIds([o.id], 'far stop');

  return (
    <>
      <View style={styles.banner} data-testid="outlier-warnings-banner">
        <View style={styles.text}>
          <Text style={styles.title} data-testid="outlier-warnings-title">
            {outliers.length} stop{outliers.length === 1 ? '' : 's'} far from your route
          </Text>
          <Text style={styles.subtitle} data-testid="outlier-warnings-subtitle">
            Worst is {worstKm.toFixed(0)} km away — likely a wrong geocode
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setModalOpen(true)}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          data-testid="outlier-review-button"
        >
          <Text style={styles.buttonText}>Review</Text>
        </Pressable>
      </View>

      <Modal
        visible={modalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setModalOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} data-testid="outlier-modal">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {outliers.length} far-away stop{outliers.length === 1 ? '' : 's'}
              </Text>
              <Pressable
                onPress={() => setModalOpen(false)}
                hitSlop={10}
                data-testid="outlier-modal-close"
                accessibilityLabel="Close outlier review"
              >
                <Text style={styles.modalClose}>×</Text>
              </Pressable>
            </View>
            <Text style={styles.modalHint}>
              These are likely mis-geocoded. Removing them stops the optimiser
              from drawing a {worstKm.toFixed(0)} km detour into your route.
            </Text>
            <ScrollView style={styles.list}>
              {outliers.map((o) => (
                <View
                  key={o.id}
                  style={styles.row}
                  data-testid={`outlier-row-${o.id}`}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.rowDistance}>
                      {o.distance_km.toFixed(0)} km
                    </Text>
                    {o.name ? (
                      <Text style={styles.rowName} numberOfLines={1}>
                        {o.name}
                      </Text>
                    ) : null}
                    <Text style={styles.rowAddress} numberOfLines={2}>
                      {o.address}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onRemoveOne(o)}
                    disabled={busy}
                    style={({ pressed }) => [
                      styles.rowButton,
                      pressed && styles.rowButtonPressed,
                      busy && styles.rowButtonDisabled,
                    ]}
                    data-testid={`outlier-remove-${o.id}`}
                  >
                    <Text style={styles.rowButtonText}>Remove</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              onPress={onRemoveAll}
              disabled={busy}
              style={({ pressed }) => [
                styles.removeAll,
                pressed && styles.removeAllPressed,
                busy && styles.removeAllDisabled,
              ]}
              data-testid="outlier-remove-all-button"
            >
              {busy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.removeAllText}>
                  Remove all {outliers.length} far stop{outliers.length === 1 ? '' : 's'}
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fee2e2', // red-100
    borderColor: '#dc2626',     // red-600
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginHorizontal: 12,
    marginVertical: 8,
  },
  text: { flex: 1, marginRight: 12 },
  title: { fontSize: 14, fontWeight: '700', color: '#7f1d1d' /* red-900 */ },
  subtitle: { fontSize: 12, color: '#991b1b', marginTop: 2 /* red-800 */ },
  button: {
    backgroundColor: '#dc2626',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    minWidth: 80,
    alignItems: 'center',
  },
  buttonPressed: { backgroundColor: '#b91c1c' },
  buttonText: { fontSize: 13, fontWeight: '700', color: '#fff' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 18,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },
  modalClose: { fontSize: 28, color: '#6b7280', paddingHorizontal: 6, lineHeight: 28 },
  modalHint: { fontSize: 13, color: '#4b5563', marginBottom: 12, lineHeight: 18 },
  list: { maxHeight: 360 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomColor: '#f3f4f6',
    borderBottomWidth: 1,
  },
  rowText: { flex: 1, marginRight: 10 },
  rowDistance: { fontSize: 13, fontWeight: '700', color: '#dc2626', marginBottom: 2 },
  rowName: { fontSize: 13, fontWeight: '600', color: '#111827' },
  rowAddress: { fontSize: 12, color: '#6b7280', marginTop: 1 },
  rowButton: {
    backgroundColor: '#fef2f2',
    borderColor: '#dc2626',
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  rowButtonPressed: { backgroundColor: '#fee2e2' },
  rowButtonDisabled: { opacity: 0.5 },
  rowButtonText: { fontSize: 12, fontWeight: '700', color: '#dc2626' },

  removeAll: {
    marginTop: 16,
    backgroundColor: '#dc2626',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  removeAllPressed: { backgroundColor: '#b91c1c' },
  removeAllDisabled: { opacity: 0.6 },
  removeAllText: { fontSize: 15, fontWeight: '700', color: '#fff' },
});

export default OutlierWarningBanner;
