/**
 * Privacy & Terms screen
 * ─────────────────────────────────────────────────────────────────────────
 * Required by Google Play "Data safety" — drivers must see an in-app
 * link to the full privacy policy + a plain-English summary of what we
 * collect and why.
 *
 * The full policy lives at the hosted URL below; this screen exists so
 * a Play Store reviewer can hit Profile → Privacy & Terms and see it
 * without leaving the app.
 *
 * If you move the hosted policy, update PRIVACY_POLICY_URL.
 */
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
  Alert,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

// Privacy policy is now self-hosted by the backend (single source of truth:
// /app/frontend/public/privacy-policy.html → served by FastAPI at
// /privacy on the backend's public URL). Override via .env if you ever move
// it (e.g. to a custom marketing domain).
const _BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';
export const PRIVACY_POLICY_URL =
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL ||
  (_BACKEND_URL ? `${_BACKEND_URL.replace(/\/$/, '')}/privacy` : 'https://floating-map-ui.emergent.host/privacy');
export const SUPPORT_EMAIL = 'xmltvg@gmail.com';

export default function PrivacyTermsScreen() {
  const router = useRouter();

  const openExternal = async (url: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) await Linking.openURL(url);
      else Alert.alert('Cannot open link', url);
    } catch {
      Alert.alert('Cannot open link', url);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Privacy & Terms',
          headerBackTitle: 'Profile',
        }}
      />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Privacy & Terms</Text>
        <Text style={styles.meta}>Effective 13 May 2026 · v1.0.1</Text>

        <View style={styles.calloutPanel} testID="privacy-summary">
          <Ionicons name="shield-checkmark-outline" size={20} color="#065f46" />
          <Text style={styles.calloutText}>
            <Text style={styles.calloutBold}>The short version:</Text>{' '}
            we collect the minimum data needed to optimize your delivery routes.
            We don't sell your data. We don't show ads. We don't track you
            across other apps.
          </Text>
        </View>

        <Text style={styles.h2}>What we collect</Text>
        <Row icon="person-circle-outline" title="Account" body="Name, email, profile picture, and Google ID from Sign-In." />
        <Row icon="location-outline" title="Location (while delivering)" body="Live GPS for navigation, geofence arrival detection, and learning your kerb-side delivery point." />
        <Row icon="list-outline" title="Stop & route data" body="Addresses, names, phone numbers, weights, notes, and your optimized sequence." />
        <Row icon="camera-outline" title="Photos (only if you enable)" body="Proof-of-delivery photos stamped with GPS and timestamp. Visible only to you." />
        <Row icon="card-outline" title="Payment status" body="Stripe handles your card; we only see customer ID, subscription state, and renewal date." />

        <Text style={styles.h2}>How we use it</Text>
        <Bullet text="Run the service: sign you in, store your stops, optimize routes." />
        <Bullet text="Improve YOUR routes: ML models are trained per-driver — your patterns never train another driver's model." />
        <Bullet text="Process payments via Stripe for RouTeD Pro subscriptions." />
        <Bullet text="Fix bugs and prevent abuse via 30-day diagnostic logs." />

        <Text style={styles.h2}>Your rights</Text>
        <Bullet text="Access — request a full export of your data." />
        <Bullet text="Correct — edit your stops or contact us for account-level fixes." />
        <Bullet text="Delete — email us to wipe your account within 30 days." />
        <Bullet text="Withdraw consent for optional features (Photo Proof, ML training) without losing core route optimization." />

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => openExternal(PRIVACY_POLICY_URL)}
          testID="open-full-privacy-policy"
        >
          <Ionicons name="open-outline" size={18} color="#fff" />
          <Text style={styles.primaryButtonText}>Read the full privacy policy</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => openExternal(`mailto:${SUPPORT_EMAIL}?subject=RouTeD%20Privacy%20Request`)}
          testID="contact-privacy"
        >
          <Ionicons name="mail-outline" size={18} color="#0f172a" />
          <Text style={styles.secondaryButtonText}>Contact: {SUPPORT_EMAIL}</Text>
        </TouchableOpacity>

        <Text style={styles.h2}>Terms of Service (summary)</Text>
        <Bullet text="RouTeD is provided 'as is' — we work hard for accuracy but routes are best-effort. Drivers remain responsible for safe, legal driving." />
        <Bullet text="Don't use RouTeD to break local laws, harass recipients, or stalk people." />
        <Bullet text="Subscriptions auto-renew via Google Play / Stripe until cancelled in your account settings. You can cancel anytime; access continues until the end of the paid period." />
        <Bullet text="We may suspend accounts that violate these terms or abuse the optimization engine (e.g., scraping at scale)." />

        <Text style={styles.smallPrint}>
          This in-app summary is for convenience. The hosted privacy policy
          at the URL above is the authoritative version. By using RouTeD
          you agree to both.
        </Text>

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const Row = ({ icon, title, body }: { icon: any; title: string; body: string }) => (
  <View style={styles.dataRow}>
    <View style={styles.dataIcon}>
      <Ionicons name={icon} size={18} color="#475569" />
    </View>
    <View style={{ flex: 1 }}>
      <Text style={styles.dataTitle}>{title}</Text>
      <Text style={styles.dataBody}>{body}</Text>
    </View>
  </View>
);

const Bullet = ({ text }: { text: string }) => (
  <View style={styles.bulletRow}>
    <View style={styles.bulletDot} />
    <Text style={styles.bulletText}>{text}</Text>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 20, paddingBottom: 60 },
  h1: { fontSize: 24, fontWeight: '800', color: '#0f172a' },
  meta: { fontSize: 12, color: '#64748b', marginTop: 2, marginBottom: 16 },
  h2: { fontSize: 15, fontWeight: '700', color: '#0f172a', marginTop: 24, marginBottom: 8 },

  calloutPanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    backgroundColor: '#ecfdf5',
    borderRadius: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#10b981',
    marginVertical: 8,
  },
  calloutText: { flex: 1, color: '#065f46', fontSize: 13, lineHeight: 18 },
  calloutBold: { fontWeight: '700' },

  dataRow: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    marginVertical: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 12,
    alignItems: 'flex-start',
  },
  dataIcon: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: '#f1f5f9',
    alignItems: 'center', justifyContent: 'center',
  },
  dataTitle: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  dataBody: { fontSize: 12, color: '#64748b', marginTop: 2, lineHeight: 16 },

  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginVertical: 3,
  },
  bulletDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: '#0ea5e9',
    marginTop: 7,
  },
  bulletText: { flex: 1, fontSize: 13, color: '#334155', lineHeight: 19 },

  primaryButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 20, paddingVertical: 13,
    backgroundColor: '#0ea5e9', borderRadius: 10,
  },
  primaryButtonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  secondaryButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 10, paddingVertical: 13,
    backgroundColor: '#fff', borderRadius: 10,
    borderWidth: 1, borderColor: '#cbd5e1',
  },
  secondaryButtonText: { color: '#0f172a', fontSize: 13, fontWeight: '600' },

  smallPrint: {
    marginTop: 24,
    fontSize: 11,
    color: '#94a3b8',
    fontStyle: 'italic',
    lineHeight: 16,
  },
});
