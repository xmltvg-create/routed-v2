import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStopsStore } from '../store/stopsStore';

/**
 * Subtle slate banner that auto-shows during planning whenever ≥1 visible
 * (uncompleted) stop has no `original_sequence` — i.e. the route has not
 * yet been Sharpie-locked via POST /api/routes/confirm.
 *
 * Pairs with the `stop-unconfirmed` map sprite (a dash inside the pin):
 * the dash *shows* the missing state, this banner *names* it and tells
 * the driver what action will fix it. Disappears the instant the user
 * taps the green Start button — `startNavigation` calls `confirmRoute`
 * which writes `original_sequence` for every stop, this selector
 * re-evaluates, and the banner unmounts.
 *
 * Read-only; no buttons. The fix is the existing Start CTA — adding a
 * second confirm button would be a redundant tap and a teach-moment
 * regression. The dash sprite + this single-line caption tells the
 * driver "tap Start to lock these numbers" without asking them to learn
 * a new control.
 */
export const UnconfirmedNumbersBanner: React.FC = () => {
  // Count uncompleted stops missing a Sharpie-locked sequence. We deliberately
  // ignore completed stops — once delivered, their `original_sequence` no
  // longer matters for the driver's planning view.
  const unconfirmedCount = useStopsStore((s) =>
    s.stops.reduce(
      (n, stop) =>
        !stop.completed && (stop.original_sequence == null) ? n + 1 : n,
      0,
    ),
  );
  const totalUncompleted = useStopsStore((s) =>
    s.stops.reduce((n, stop) => (stop.completed ? n : n + 1), 0),
  );

  // Hide when there's nothing to confirm or nothing to plan against.
  if (unconfirmedCount === 0 || totalUncompleted < 2) return null;

  return (
    <View style={styles.banner} data-testid="unconfirmed-numbers-banner">
      <Ionicons name="lock-open-outline" size={16} color="#475569" style={styles.icon} />
      <Text style={styles.text} data-testid="unconfirmed-numbers-text">
        Tap Start to lock these as your Sharpie numbers
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f1f5f9', // slate-100
    borderColor: '#cbd5e1',     // slate-300
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginHorizontal: 12,
    marginVertical: 4,
  },
  icon: { marginRight: 8 },
  text: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: '600',
    color: '#475569', // slate-600
    letterSpacing: 0.1,
  },
});

export default UnconfirmedNumbersBanner;
