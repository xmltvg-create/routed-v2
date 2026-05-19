import React from 'react';
import { Pressable, Text, View, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useStopsStore } from '../store/stopsStore';

/**
 * Amber banner that surfaces post-optimisation route fragmentation. The
 * backend's `detect_cluster_spikes` sweep flags any (A, B, C) triplet where
 * stop B is a large geographic detour (haversine A→C is < 30 % of the
 * detour A→B→C). The driver taps "Tighten All" and we fire
 * `/api/optimize/tighten-clusters`, which iteratively relocates each spike
 * to its haversine-best slot and double-checks against OSRM driving time
 * before persisting.
 *
 * The banner self-hides when there are no warnings or `< 3` pending stops.
 */
interface Props {
  /** Optional success-toast callback. When tightening saves at least
   *  some km/time, the parent gets a short string like
   *  "Tightened · -2.4 km · -3 min" to surface as a 2-second toast.
   *  Without this prop we fall back to an Alert (legacy path). */
  onSuccess?: (msg: string) => void;
}

export const ClusterWarningsBanner: React.FC<Props> = ({ onSuccess }) => {
  const warnings = useStopsStore((s) => s.clusterWarnings);
  const tightening = useStopsStore((s) => s.tighteningClusters);
  const tightenAll = useStopsStore((s) => s.tightenAllClusters);

  if (!warnings || warnings.length === 0) return null;

  const totalExtraKm = warnings.reduce((acc, w) => acc + (w.extra_km || 0), 0);

  const handleTighten = async () => {
    const res = await tightenAll();
    if (!res) {
      Alert.alert('Tighten failed', 'Could not reach the route service. Try again in a moment.');
      return;
    }
    if (res.rolled_back) {
      // Silently leave the route as-is — the user already saw the
      // "Tighten All" CTA and pressing it implied "try to fix this".
      // If the road network would actually punish the straightening
      // (rolled_back === true), we just don't apply the change. No
      // alert, no interruption — the cluster banner stays visible if
      // the warnings still apply, and the user can keep planning.
      return;
    }
    const km = res.saved_km?.toFixed(1) ?? '0';
    const min =
      res.driving_seconds_saved != null
        ? Math.round(res.driving_seconds_saved / 60)
        : null;
    // Build a compact toast string. The Alert was a hard interruption —
    // we now lean on a 2-second toast in the same UX register as the
    // silent rolled_back path (both outcomes feel ambient, not modal).
    const minPart = min != null && min > 0 ? ` · -${min} min` : '';
    const msg = `Tightened · -${km} km${minPart}`;
    if (onSuccess) {
      onSuccess(msg);
    } else {
      // Legacy fallback if no parent toast wiring — still informative,
      // just modal. Used by tests and any future reuse without index.tsx.
      Alert.alert('Tightened', `Saved ${km} km on the map${min != null && min > 0 ? ` and ~${min} min of driving` : ''}.`);
    }
  };

  return (
    <View style={styles.banner} data-testid="cluster-warnings-banner">
      <View style={styles.text}>
        <Text style={styles.title} data-testid="cluster-warnings-title">
          {warnings.length} detour stop{warnings.length === 1 ? '' : 's'}
        </Text>
        <Text style={styles.subtitle} data-testid="cluster-warnings-subtitle">
          Adds ~{totalExtraKm.toFixed(1)} km of zig-zags
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={tightening}
        onPress={handleTighten}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          tightening && styles.buttonDisabled,
        ]}
        data-testid="tighten-all-clusters-button"
      >
        {tightening ? (
          <ActivityIndicator size="small" color="#7c2d12" />
        ) : (
          <Text style={styles.buttonText}>Tighten All</Text>
        )}
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fef3c7', // amber-100
    borderColor: '#f59e0b',     // amber-500
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginHorizontal: 12,
    marginVertical: 8,
  },
  text: { flex: 1, marginRight: 12 },
  title: { fontSize: 14, fontWeight: '700', color: '#7c2d12' /* amber-900 */ },
  subtitle: { fontSize: 12, color: '#92400e', marginTop: 2 /* amber-800 */ },
  button: {
    backgroundColor: '#f59e0b',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    minWidth: 96,
    alignItems: 'center',
  },
  buttonPressed: { backgroundColor: '#d97706' },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { fontSize: 13, fontWeight: '700', color: '#7c2d12' },
});

export default ClusterWarningsBanner;
