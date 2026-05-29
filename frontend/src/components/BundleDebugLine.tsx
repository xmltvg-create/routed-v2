/**
 * BundleDebugLine
 * ─────────────────────────────────────────────────────────────────────
 * Tiny diagnostic strip at the bottom of the Profile tab. Shows:
 *   • Backend URL the JS bundle was built against
 *   • EAS update group / channel / runtime version
 *
 * Why it exists: we just had a P0 outage where an OTA update baked the
 * dev backend URL into the production bundle, and drivers thought their
 * data was deleted. With this strip visible at the bottom of Profile,
 * the same bug would have been diagnosable in 5 seconds — just read the
 * URL on screen.
 *
 * Tap to copy summary to clipboard for support tickets.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ToastAndroid, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import * as Clipboard from 'expo-clipboard';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '(unset)';

// Detect whether the configured URL points at the canonical prod host so
// we can flag misconfigurations visually instead of forcing the user to
// read it. Anything that isn't `api.getrouted.xyz` (or `localhost` in dev)
// is suspicious.
const PROD_HOST = 'api.getrouted.xyz';

export const BundleDebugLine: React.FC = () => {
  const [copied, setCopied] = useState(false);

  const info = useMemo(() => {
    // expo-updates fields can be null on dev client / first launch before
    // the bundle is fetched. Coerce everything to short, safe strings.
    const channel = Updates.channel || '—';
    const updateId = Updates.updateId
      ? Updates.updateId.slice(0, 8) + '…'
      : 'embedded';
    const runtime = Updates.runtimeVersion || '—';
    const isProd = BACKEND_URL.includes(PROD_HOST);
    return { channel, updateId, runtime, isProd };
  }, []);

  const onPress = useCallback(async () => {
    // Copy the full backend URL + bundle identifiers so the user can
    // paste straight into a support message. Toast on Android, silent
    // success state on iOS (we don't ship to iOS yet, but no harm).
    const summary = [
      `Backend: ${BACKEND_URL}`,
      `Channel: ${Updates.channel || '—'}`,
      `Update:  ${Updates.updateId || 'embedded'}`,
      `Runtime: ${Updates.runtimeVersion || '—'}`,
    ].join('\n');
    try {
      await Clipboard.setStringAsync(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      if (Platform.OS === 'android') {
        ToastAndroid.show('Bundle info copied', ToastAndroid.SHORT);
      }
    } catch {
      // Clipboard failures don't matter — the values are still visible
      // on screen for manual reading.
    }
  }, []);

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      activeOpacity={0.6}
      testID="bundle-debug-line"
    >
      <Text
        style={[styles.text, !info.isProd && styles.textWarn]}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {info.isProd ? '🟢 ' : '🟠 '}
        {BACKEND_URL.replace(/^https?:\/\//, '')}
      </Text>
      <Text style={styles.meta}>
        {info.channel} · {info.updateId} · rt {info.runtime}
      </Text>
      {copied ? <Text style={styles.copied}>copied ✓</Text> : null}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 0,
    backgroundColor: '#f8fafc',
    borderRadius: 6,
    alignItems: 'center',
  },
  text: { fontSize: 10, color: '#475569', fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) },
  textWarn: { color: '#b45309' },
  meta: { fontSize: 9, color: '#94a3b8', marginTop: 2, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) },
  copied: { fontSize: 9, color: '#16a34a', marginTop: 2 },
});

export default BundleDebugLine;
