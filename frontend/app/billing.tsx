/**
 * /app/billing — Pro subscription screen
 *
 * Three visual states:
 *  1. Pro/Admin: green "you're on the Pro plan" card + Manage button (opens Stripe customer portal in WebView).
 *  2. Free: hero copy + monthly/annual plan cards with "Start 7-day free trial" CTAs.
 *  3. Loading: spinner while /api/billing/status resolves.
 *
 * Surfaced from the Profile tab "Upgrade to Pro" row AND auto-pushed
 * when an Optimize call returns 402 (subscription_required) — the
 * store catches that response and triggers `router.push('/billing')`.
 *
 * Checkout flow:
 *  Tap a plan → POST /api/billing/checkout returns a Stripe-hosted
 *  Checkout URL → opens in a WebView modal. On success Stripe redirects
 *  to STRIPE_CHECKOUT_SUCCESS_URL which lives on our backend; we
 *  detect the URL match and refresh the local billing status.
 *
 * Why a WebView (not the native Stripe SDK):
 *  * Avoids Apple/Google in-app-purchase tax (Apple takes 30 %, Stripe
 *    is ~3 %). The Stripe-hosted Checkout flow is allowed because the
 *    purchased product is digital-service-not-consumable-on-device.
 *  * One implementation works for both iOS and Android.
 *  * Customer portal (managing/cancelling) uses the same WebView.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

async function authHeaders(): Promise<Record<string, string>> {
  const token = await AsyncStorage.getItem('session_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface PlanOption {
  price_id: string;
  label: string;
  amount_display: string;
  trial_days: string;
}

interface BillingStatus {
  pro: boolean;
  status: string | null;
  plan_id: string | null;
  trial_end: number | null;
  current_period_end: number | null;
  is_admin: boolean;
  available_plans: Record<string, PlanOption>;
}

export default function BillingScreen() {
  const router = useRouter();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND_URL}/api/billing/status`, {
        headers: await authHeaders(),
      });
      if (r.ok) setStatus(await r.json());
      else console.warn('[billing] status fetch failed', r.status);
    } catch (e) {
      console.warn('[billing] status fetch error', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const startCheckout = async (planId: 'monthly' | 'annual') => {
    setBusyPlan(planId);
    try {
      const r = await fetch(`${BACKEND_URL}/api/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await authHeaders()),
        },
        body: JSON.stringify({ plan_id: planId }),
      });
      if (r.status === 503) {
        const body = await r.json();
        Alert.alert(
          'Billing not configured',
          body?.detail || 'Set STRIPE_API_KEY and the price IDs in backend .env, then retry.',
        );
        return;
      }
      if (!r.ok) {
        const body = await r.text();
        Alert.alert('Checkout failed', `HTTP ${r.status}: ${body}`);
        return;
      }
      const { checkout_url } = await r.json();
      setCheckoutUrl(checkout_url);
    } catch (e: any) {
      Alert.alert('Checkout error', e?.message ?? 'Network error');
    } finally {
      setBusyPlan(null);
    }
  };

  const openPortal = async () => {
    try {
      const r = await fetch(`${BACKEND_URL}/api/billing/portal`, {
        method: 'POST',
        headers: await authHeaders(),
      });
      if (!r.ok) {
        Alert.alert('Portal error', `HTTP ${r.status}`);
        return;
      }
      const { portal_url } = await r.json();
      setCheckoutUrl(portal_url);
    } catch (e: any) {
      Alert.alert('Portal error', e?.message ?? 'Network error');
    }
  };

  const onWebViewNavStateChange = (s: { url: string }) => {
    // Backend redirects checkout success to /billing/success — close
    // the modal and refresh status. Same for /billing/cancel.
    if (s.url.includes('/billing/success') || s.url.includes('/billing/cancel')) {
      setCheckoutUrl(null);
      fetchStatus();
    }
  };

  if (loading) {
    return (
      <View style={styles.centered} testID="billing-loading">
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  const isPro = status?.pro ?? false;
  const isAdmin = status?.is_admin ?? false;

  return (
    <ScrollView style={styles.container} testID="billing-screen">
      <TouchableOpacity style={styles.backRow} onPress={() => router.back()} testID="billing-back">
        <Ionicons name="chevron-back" size={22} color="#3b82f6" />
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <View style={styles.header}>
        <Text style={styles.title}>RouTeD Pro</Text>
        <Text style={styles.subtitle}>
          Unlock the multi-engine optimiser, cluster tightening, no-go zones,
          and full route history.
        </Text>
      </View>

      {isPro ? (
        <View style={[styles.statusCard, styles.statusCardActive]} testID="billing-status-pro">
          <View style={styles.statusRow}>
            <Ionicons name="checkmark-circle" size={28} color="#10b981" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.statusTitle}>
                {isAdmin ? 'Admin access' : `You're on Pro (${status?.plan_id ?? '—'})`}
              </Text>
              <Text style={styles.statusSubtitle}>
                Status: {status?.status ?? 'admin-bypass'}
              </Text>
            </View>
          </View>
          {!isAdmin && (
            <TouchableOpacity style={styles.manageButton} onPress={openPortal} testID="billing-manage-btn">
              <Text style={styles.manageButtonText}>Manage subscription</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <>
          <View style={styles.benefitsCard}>
            <Benefit text="Multi-engine optimiser (VROOM, LKH-3, OR-Tools)" />
            <Benefit text="Cluster tightening + cross-cluster guard" />
            <Benefit text="No-go zones & late-freight ghost pins" />
            <Benefit text="Full route history + telemetry rollup" />
            <Benefit text="7-day free trial — no card charged upfront" />
          </View>

          {Object.entries(status?.available_plans ?? {}).map(([planId, plan]) => (
            <TouchableOpacity
              key={planId}
              style={[styles.planCard, planId === 'annual' && styles.planCardHighlight]}
              activeOpacity={0.85}
              onPress={() => startCheckout(planId as 'monthly' | 'annual')}
              disabled={busyPlan !== null || plan.price_id === 'not_configured'}
              testID={`billing-plan-${planId}`}
            >
              {planId === 'annual' && (
                <View style={styles.savingBadge}>
                  <Text style={styles.savingBadgeText}>Save ~34%</Text>
                </View>
              )}
              <Text style={styles.planLabel}>{plan.label}</Text>
              <Text style={styles.planAmount}>{plan.amount_display}</Text>
              <Text style={styles.planTrial}>{plan.trial_days}-day free trial</Text>
              {plan.price_id === 'not_configured' ? (
                <Text style={styles.planCtaDisabled}>Not configured</Text>
              ) : busyPlan === planId ? (
                <ActivityIndicator color="#3b82f6" />
              ) : (
                <Text style={styles.planCta}>Start free trial →</Text>
              )}
            </TouchableOpacity>
          ))}
        </>
      )}

      {/* Stripe Checkout / Customer Portal WebView */}
      <Modal
        visible={checkoutUrl !== null}
        animationType="slide"
        onRequestClose={() => setCheckoutUrl(null)}
      >
        <View style={{ flex: 1, paddingTop: 40, backgroundColor: '#fff' }}>
          <TouchableOpacity
            style={styles.modalCloseBar}
            onPress={() => {
              setCheckoutUrl(null);
              fetchStatus();
            }}
            testID="billing-checkout-close"
          >
            <Ionicons name="close" size={22} color="#64748b" />
            <Text style={styles.modalCloseText}>Close</Text>
          </TouchableOpacity>
          {checkoutUrl && (
            <WebView
              source={{ uri: checkoutUrl }}
              onNavigationStateChange={onWebViewNavStateChange}
              javaScriptEnabled
              startInLoadingState
            />
          )}
        </View>
      </Modal>
    </ScrollView>
  );
}

function Benefit({ text }: { text: string }) {
  return (
    <View style={styles.benefitRow}>
      <Ionicons name="checkmark" size={18} color="#10b981" />
      <Text style={styles.benefitText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f8fafc' },
  container: { flex: 1, backgroundColor: '#f8fafc' },
  backRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 16, paddingHorizontal: 16 },
  backText: { color: '#3b82f6', fontSize: 16, fontWeight: '600', marginLeft: 4 },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24 },
  title: { fontSize: 32, fontWeight: '800', color: '#0f172a', letterSpacing: -0.5 },
  subtitle: { fontSize: 15, color: '#64748b', marginTop: 8, lineHeight: 22 },
  statusCard: { marginHorizontal: 20, padding: 18, borderRadius: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0' },
  statusCardActive: { backgroundColor: '#f0fdf4', borderColor: '#86efac' },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  statusSubtitle: { fontSize: 13, color: '#475569', marginTop: 2 },
  manageButton: { marginTop: 14, backgroundColor: '#1e293b', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  manageButtonText: { color: '#fff', fontWeight: '700' },
  benefitsCard: { marginHorizontal: 20, padding: 16, borderRadius: 14, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', marginBottom: 16 },
  benefitRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  benefitText: { fontSize: 14, color: '#334155', marginLeft: 10, flex: 1 },
  planCard: { marginHorizontal: 20, marginBottom: 14, padding: 18, borderRadius: 14, backgroundColor: '#fff', borderWidth: 2, borderColor: '#e2e8f0' },
  planCardHighlight: { borderColor: '#3b82f6', backgroundColor: '#eff6ff' },
  savingBadge: { position: 'absolute', top: -10, right: 16, backgroundColor: '#3b82f6', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  savingBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  planLabel: { fontSize: 14, fontWeight: '700', color: '#475569' },
  planAmount: { fontSize: 26, fontWeight: '800', color: '#0f172a', marginTop: 4 },
  planTrial: { fontSize: 13, color: '#10b981', fontWeight: '700', marginTop: 4 },
  planCta: { fontSize: 14, color: '#3b82f6', fontWeight: '700', marginTop: 12 },
  planCtaDisabled: { fontSize: 14, color: '#94a3b8', fontWeight: '600', marginTop: 12 },
  modalCloseBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalCloseText: { color: '#64748b', fontWeight: '600', marginLeft: 6 },
});
