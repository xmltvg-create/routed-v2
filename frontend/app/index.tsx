import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Platform,
  Alert,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../src/context/AuthContext';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { hasConsumedSessionId, markSessionIdConsumed } from '../src/utils/consumedSessionIds';
import { RouteTraceBackground } from '../src/components/RouteTraceBackground';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

// Brand palette — kept here (not in styles) so the rest of the
// file reads as a stylesheet rather than a colour theory essay.
// `--accent` is the same orange used by the OTA banner so the
// splash, the in-app updater, and the brand mark all rhyme.
const COLOR = {
  bg0: '#04060a',
  bg1: '#0a0d14',
  bg2: '#11151d',
  text: '#F4F4F5',
  textDim: '#9CA3AF',
  textFaint: '#52525B',
  accent: '#FF5A00',
  accentSoft: 'rgba(255,90,0,0.16)',
  lime: '#7CFFB2',
  hairline: 'rgba(255,255,255,0.08)',
};

export default function LoginScreen() {
  const { user, loading, login, loginAsReviewer, loginWithEmail, registerWithEmail } = useAuth();
  const router = useRouter();
  const [authLoading, setAuthLoading] = useState(false);

  // Email/password fallback login
  const [showEmailLogin, setShowEmailLogin] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [emailError, setEmailError] = useState('');

  const submitEmailAuth = async () => {
    setEmailError('');
    if (!emailInput.trim() || !passwordInput) {
      setEmailError('Please enter email and password');
      return;
    }
    try {
      setAuthLoading(true);
      if (isRegistering) {
        await registerWithEmail(emailInput.trim(), passwordInput, nameInput.trim());
      } else {
        await loginWithEmail(emailInput.trim(), passwordInput);
      }
    } catch (e: any) {
      setEmailError(e?.message || 'Authentication failed');
    } finally {
      setAuthLoading(false);
    }
  };

  // Reviewer login: opens an Alert.prompt on iOS / a plain prompt on
  // web. On Android RN's Alert has no prompt, so we use a tiny inline
  // controlled passcode flow via React state.
  const [reviewerPrompt, setReviewerPrompt] = useState(false);
  const [reviewerPasscode, setReviewerPasscode] = useState('');

  const submitReviewerLogin = async (passcode: string) => {
    const code = (passcode || '').trim();
    if (!code) return;
    try {
      setAuthLoading(true);
      await loginAsReviewer('routedreviewer@gmail.com', code);
      // success → useEffect router.replace('/(tabs)') kicks in
    } catch (e: any) {
      Alert.alert(
        'Reviewer login failed',
        e?.detail || e?.message || 'Invalid passcode.',
      );
    } finally {
      setAuthLoading(false);
      setReviewerPasscode('');
      setReviewerPrompt(false);
    }
  };

  const openReviewerPrompt = () => {
    if (Platform.OS === 'ios') {
      // iOS Alert.prompt — secure text entry, single tap to submit.
      // @ts-ignore — Alert.prompt is iOS-only in RN typings.
      Alert.prompt(
        'Play Store reviewer login',
        'Enter the review passcode (no Google account needed).',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Sign in',
            onPress: (val?: string) => submitReviewerLogin(val || ''),
          },
        ],
        'secure-text',
      );
      return;
    }
    // Android / web → show an inline controlled prompt via state.
    setReviewerPasscode('');
    setReviewerPrompt(true);
  };

  // Dedupe guard: a session_id from Emergent auth is one-shot. If two handlers
  // (WebBrowser result + Linking listener) both deliver the same URL, the
  // second call gets a 401 and wipes the first success. Track what we've
  // already exchanged.
  const exchangedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<string | null>(null);

  // Redirect to main app if already logged in
  useEffect(() => {
    if (!loading && user) {
      router.replace('/(tabs)');
    }
  }, [user, loading]);

  const exchangeSessionOnce = async (rawSessionId: string) => {
    if (!rawSessionId) return;
    // Normalise so percent-encoded vs decoded variants dedupe against each
    // other — WebBrowser and Linking deliver subtly different URL forms on
    // Android and the raw-string guard slipped through during the
    // 2026-04-23 race (401 immediately followed by 200 in backend logs).
    let sessionId = rawSessionId;
    try { sessionId = decodeURIComponent(rawSessionId); } catch { /* leave as-is */ }

    if (exchangedRef.current.has(sessionId)) return; // already consumed (this JS context)
    if (inFlightRef.current === sessionId) return;   // in progress
    // If another parallel handler already signed us in, bail silently — the
    // second exchange call would hit a demobackend 404 (one-shot session_id)
    // and spuriously surface "Sign-in failed" even though we ARE logged in.
    if (user) { exchangedRef.current.add(sessionId); return; }

    // OTA-reload ghost guard: `Updates.reloadAsync()` after a successful
    // sign-in resets every in-memory ref, and Android may redeliver the
    // same auth redirect URL to the fresh JS context via
    // `Linking.getInitialURL()`. Two layers of persistent defence:
    //   (1) Session token on disk → user is already logged in, bail.
    //   (2) Consumed-session-id list on disk (10-min TTL) → catches the
    //       narrow window between exchange success and AsyncStorage flush.
    // Both match the Emergent Auth playbook rule: skip session_id processing
    // when we already have a session.
    const existingToken = await AsyncStorage.getItem('session_token').catch(() => null);
    if (existingToken) {
      exchangedRef.current.add(sessionId);
      return;
    }
    if (await hasConsumedSessionId(sessionId)) {
      exchangedRef.current.add(sessionId);
      return;
    }

    inFlightRef.current = sessionId;
    try {
      setAuthLoading(true);
      await login(sessionId);
      exchangedRef.current.add(sessionId);
      // Persist the consumed id so a subsequent OTA reload / process kill
      // still sees it as used.
      await markSessionIdConsumed(sessionId);
    } catch (error: any) {
      console.error('Login attempt failed for session:', error?.message);
      // If the parallel call won the race while we were mid-fetch, user is
      // now non-null — don't bother the driver with a failure alert.
      if (user) return;
      // Tiny grace window: setUser() from the sibling call may not have
      // flushed into this closure yet. Re-check AsyncStorage after a tick.
      const token = await AsyncStorage.getItem('session_token').catch(() => null);
      if (token) return;
      // ── Diagnostic message ───────────────────────────────────────────
      // AuthContext.login now attaches `.status` and `.detail` to the
      // thrown error (see AuthContext.tsx::login). Surface them verbatim
      // so the user can read the exact backend response back to support:
      //   - "Invalid session (upstream 404)"  → session_id was consumed
      //     before reaching the exchange (duplicate handler / stale
      //     deep link from OTA-reload)
      //   - "Invalid session (upstream 5xx)"  → Emergent auth service hiccup
      //   - "Authentication failed (TimeoutException)" → our backend
      //     couldn't reach demobackend.emergentagent.com in time
      //   - "Signups disabled..."  → email not whitelisted
      const status = typeof error?.status === 'number' ? error.status : null;
      const detail: string = (typeof error?.detail === 'string' && error.detail)
        ? error.detail
        : (error?.message || 'unknown error');
        
      if (status === 403 && detail.includes('waitlist')) {
        Alert.alert(
          'Join the Waitlist',
          'Signups are currently disabled for closed beta. We have automatically added your Google email to the waitlist, and we will notify you when Phase 2 opens!'
        );
      } else {
        const debugLine = status ? `\n\nDebug (HTTP ${status}): ${detail}` : `\n\nDebug: ${detail}`;
        Alert.alert(
          'Sign-in failed',
          `We could not complete the sign-in. Please tap "Continue with Google" again.${debugLine}`,
        );
      }
    } finally {
      inFlightRef.current = null;
      setAuthLoading(false);
    }
  };

  useEffect(() => {
    // Handle deep link / redirect with session_id (Android cold-start + warm)
    const handleUrl = async (url: string | null) => {
      if (!url) return;
      const sessionIdMatch = url.match(/[#?]session_id=([^&]+)/);
      if (sessionIdMatch) {
        await exchangeSessionOnce(sessionIdMatch[1]);
      }
    };

    Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener('url', (event) => {
      handleUrl(event.url);
    });

    return () => subscription.remove();
  }, []);

  const handleGoogleLogin = async () => {
    try {
      setAuthLoading(true);
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      }

      const redirectUrl = Platform.OS === 'web'
        ? `${window.location.origin}/`
        : Linking.createURL('/');

      const authUrl = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;

      if (Platform.OS === 'web') {
        window.location.href = authUrl;
        return;
      }

      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);

      if (result.type === 'success' && result.url) {
        const sessionIdMatch = result.url.match(/[#?]session_id=([^&]+)/);
        if (sessionIdMatch) {
          await exchangeSessionOnce(sessionIdMatch[1]);
        }
      }
      // If result.type is 'cancel' or 'dismiss', the deep-link listener above
      // will still catch the session_id if the browser delivered it via the OS.
    } catch (error) {
      console.error('Login error:', error);
    } finally {
      setAuthLoading(false);
    }
  };

  // Web redirect with session_id in hash/query
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const hash = window.location.hash;
      const search = window.location.search;

      let sessionId: string | null = null;
      if (hash.includes('session_id=')) {
        sessionId = hash.split('session_id=')[1]?.split('&')[0];
      } else if (search.includes('session_id=')) {
        sessionId = search.split('session_id=')[1]?.split('&')[0];
      }

      if (sessionId) {
        exchangeSessionOnce(sessionId).finally(() => {
          window.history.replaceState({}, document.title, window.location.pathname);
        });
      }
    }
  }, []);

  // Authenticating state — the prior version flashed a centered
  // spinner that looked identical to a network stall. Reuse the
  // splash chrome so the user sees the brand instead of a void.
  if (loading || authLoading) {
    return (
      <View style={styles.container} data-testid="login-loading-state">
        <View style={styles.bgFill} />
        <RouteTraceBackground />
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="small" color={COLOR.accent} />
          <Text style={styles.loadingText}>
            {authLoading ? 'Signing you in…' : 'Booting the cockpit…'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} data-testid="login-screen">
      {/* Layer 1: solid floor colour. */}
      <View style={styles.bgFill} />

      {/* Layer 2: animated SVG routes drawing themselves. Reanimated
          drives strokeDashoffset on the worklet thread so this stays
          smooth even while we're waiting on the OAuth round-trip. */}
      <RouteTraceBackground />

      {/* Layer 3: a soft warm radial glow anchored to the accent
          colour. Implemented as a stack of overlapping linear
          gradients because RN core has no `radial-gradient` until
          you reach for an extra dep — this fakes it well enough at
          a fraction of the bundle cost. */}
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(255,90,0,0.18)', 'rgba(255,90,0,0)']}
        style={styles.glowTopLeft}
      />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(124,255,178,0.10)', 'rgba(124,255,178,0)']}
        style={styles.glowBottomRight}
      />

      {/* Layer 4: the actual UI content. Everything below is just
          stagger-faded text and two buttons — keep it ruthlessly
          minimal. Less to read = stronger first impression. */}
      <View style={styles.content}>
        <Animated.View
          entering={FadeInDown.duration(500).delay(80)}
          style={styles.brandRow}
        >
          <View style={styles.brandDot} />
          <Text style={styles.brandKicker}>PATHPILOT · ROUTING OS</Text>
        </Animated.View>

        <Animated.Text
          entering={FadeInDown.duration(700).delay(160)}
          style={styles.headline}
        >
          14 solvers.{'\n'}
          <Text style={styles.headlineAccent}>One perfect route.</Text>
        </Animated.Text>

        <Animated.Text
          entering={FadeInDown.duration(700).delay(280)}
          style={styles.subhead}
        >
          A 60 fps WebGL navigation cockpit and a multi-engine{'\n'}
          optimizer that thinks for you while you drive.
        </Animated.Text>

        {/* Stat chips — three quick brag lines. They double as
            evidence the app is technically real, which matters more
            for hackathon judges than a long marketing paragraph. */}
        <Animated.View
          entering={FadeInDown.duration(700).delay(380)}
          style={styles.chipRow}
        >
          <StatChip icon="layers-outline" label="14 SOLVERS" />
          <StatChip icon="speedometer-outline" label="60 FPS" />
          <StatChip icon="git-network-outline" label="OSRM + VROOM" tone="lime" />
        </Animated.View>

        <Animated.View
          entering={FadeIn.duration(600).delay(540)}
          style={styles.ctaStack}
        >
          <PrimaryButton
            testID="google-login-button"
            onPress={handleGoogleLogin}
            disabled={authLoading}
          />

          {/* Email/password fallback — shown when Google OAuth is down */}
          <Pressable
            data-testid="email-login-toggle"
            onPress={() => { setShowEmailLogin(!showEmailLogin); setEmailError(''); }}
            style={styles.tertiary}
            hitSlop={8}
          >
            <Text style={styles.tertiaryText}>
              {showEmailLogin ? 'Hide email sign-in' : "Can't sign in with Google? Use email"}
            </Text>
          </Pressable>

          {showEmailLogin && (
            <View style={{ width: '100%', gap: 10, marginTop: 4 }}>
              {isRegistering && (
                <TextInput
                  data-testid="email-name-input"
                  value={nameInput}
                  onChangeText={setNameInput}
                  placeholder="Name"
                  placeholderTextColor={COLOR.textFaint}
                  autoCapitalize="words"
                  style={styles.reviewerInput}
                />
              )}
              <TextInput
                data-testid="email-input"
                value={emailInput}
                onChangeText={setEmailInput}
                placeholder="Email"
                placeholderTextColor={COLOR.textFaint}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.reviewerInput}
              />
              <TextInput
                data-testid="email-password-input"
                value={passwordInput}
                onChangeText={setPasswordInput}
                placeholder="Password (min 6 characters)"
                placeholderTextColor={COLOR.textFaint}
                secureTextEntry
                autoCapitalize="none"
                style={styles.reviewerInput}
              />
              {!!emailError && (
                <Text style={{ color: '#ef4444', fontSize: 13, textAlign: 'center' }}>{emailError}</Text>
              )}
              <Pressable
                data-testid="email-submit-btn"
                onPress={submitEmailAuth}
                disabled={authLoading}
                style={[styles.reviewerBtn, styles.reviewerBtnPrimary, { alignSelf: 'stretch', paddingVertical: 14 }]}
              >
                <Text style={[styles.reviewerBtnText, { fontSize: 15 }]}>
                  {authLoading ? 'Please wait...' : isRegistering ? 'Create Account' : 'Sign In'}
                </Text>
              </Pressable>
              <Pressable
                data-testid="email-toggle-register"
                onPress={() => { setIsRegistering(!isRegistering); setEmailError(''); }}
                hitSlop={8}
              >
                <Text style={[styles.tertiaryText, { textAlign: 'center' }]}>
                  {isRegistering ? 'Already have an account? Sign in' : "Don't have an account? Register"}
                </Text>
              </Pressable>
            </View>
          )}

          <SecondaryButton
            testID="watch-demo-button"
            onPress={() => {
              if (Platform.OS !== 'web') {
                Haptics.selectionAsync().catch(() => {});
              }
              router.push('/demo');
            }}
            label="Watch the 25-second demo"
            icon="play-circle-outline"
          />
          <Pressable
            data-testid="benchmarks-link"
            onPress={() => router.push('/benchmarks')}
            style={styles.tertiary}
            hitSlop={8}
          >
            <Text style={styles.tertiaryText}>See live solver benchmarks →</Text>
          </Pressable>
          <Pressable
            data-testid="reviewer-login-link"
            onPress={openReviewerPrompt}
            style={styles.tertiary}
            hitSlop={8}
          >
            <Text style={styles.tertiaryTextFaint}>Play Store reviewer? Tap to sign in</Text>
          </Pressable>
        </Animated.View>
      </View>

      {/* Layer 5: footer rail — a quiet "live" indicator + version
          tag. Borrowed from cockpit / DAW UIs to reinforce the
          "mission control" framing without shouting. */}
      <Animated.View
        entering={FadeIn.duration(800).delay(900)}
        style={styles.footer}
      >
        <LivePulse />
        <Text style={styles.footerText}>ROUTING ENGINE ONLINE</Text>
        <View style={styles.footerSep} />
        <Text style={styles.footerText}>v2026.04 · BUILD STABLE</Text>
      </Animated.View>

      {/* Reviewer passcode prompt — Android/web only. iOS uses
          Alert.prompt() because it has native secure-text-entry. */}
      {reviewerPrompt && (
        <View style={styles.reviewerOverlay} data-testid="reviewer-login-modal">
          <View style={styles.reviewerCard}>
            <Text style={styles.reviewerTitle}>Play Store reviewer sign-in</Text>
            <Text style={styles.reviewerBody}>
              Enter the review passcode shared in the Play Console
              "App access" form. No Google account is required.
            </Text>
            <TextInput
              data-testid="reviewer-passcode-input"
              value={reviewerPasscode}
              onChangeText={setReviewerPasscode}
              placeholder="Passcode"
              placeholderTextColor={COLOR.textFaint}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.reviewerInput}
            />
            <View style={styles.reviewerRow}>
              <Pressable
                data-testid="reviewer-cancel-btn"
                onPress={() => { setReviewerPrompt(false); setReviewerPasscode(''); }}
                style={styles.reviewerBtn}
              >
                <Text style={styles.reviewerBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                data-testid="reviewer-submit-btn"
                onPress={() => submitReviewerLogin(reviewerPasscode)}
                style={[styles.reviewerBtn, styles.reviewerBtnPrimary]}
              >
                <Text style={styles.reviewerBtnText}>Sign in</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------

const StatChip = ({
  icon,
  label,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  tone?: 'lime';
}) => {
  const color = tone === 'lime' ? COLOR.lime : COLOR.accent;
  return (
    <View style={styles.chip}>
      <Ionicons name={icon} size={13} color={color} />
      <Text style={[styles.chipLabel, { color }]}>{label}</Text>
    </View>
  );
};

/**
 * PrimaryButton
 *  - Pill shaped, accent border, dark fill (so it sits on top of the
 *    glow without being washed out).
 *  - Press scales it down 2% and warms a glow ring around it. Both
 *    are Reanimated worklet animations so they're crisp at 60 fps
 *    even mid-OAuth.
 */
const PrimaryButton = ({
  onPress,
  disabled,
  testID,
}: {
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}) => {
  const press = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - press.value * 0.025 }],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: 0.35 + press.value * 0.55,
  }));

  return (
    <Pressable
      data-testid={testID}
      onPress={onPress}
      disabled={disabled}
      onPressIn={() => (press.value = withSpring(1, { damping: 14 }))}
      onPressOut={() => (press.value = withSpring(0, { damping: 14 }))}
    >
      <Animated.View style={[styles.primaryRing, ringStyle]} />
      <Animated.View style={[styles.primaryBtn, animatedStyle]}>
        <Ionicons name="logo-google" size={18} color={COLOR.text} />
        <Text style={styles.primaryBtnText}>Continue with Google</Text>
        <Ionicons name="arrow-forward" size={16} color={COLOR.accent} />
      </Animated.View>
    </Pressable>
  );
};

const SecondaryButton = ({
  onPress,
  label,
  icon,
  testID,
}: {
  onPress: () => void;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  testID: string;
}) => {
  const press = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - press.value * 0.02 }],
    backgroundColor: press.value > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)',
  }));
  return (
    <Pressable
      data-testid={testID}
      onPress={onPress}
      onPressIn={() => (press.value = withSpring(1, { damping: 16 }))}
      onPressOut={() => (press.value = withSpring(0, { damping: 16 }))}
    >
      <Animated.View style={[styles.secondaryBtn, animatedStyle]}>
        <Ionicons name={icon} size={16} color={COLOR.text} />
        <Text style={styles.secondaryBtnText}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
};

/**
 * LivePulse — the 6px dot in the footer that softly throbs to
 * signal "the engine is alive". Single shared value, no per-frame
 * JS work, animation runs forever.
 */
const LivePulse = () => {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, []);
  const dot = useAnimatedStyle(() => ({
    opacity: 0.55 + v.value * 0.45,
    transform: [{ scale: 0.85 + v.value * 0.3 }],
  }));
  return (
    <View style={styles.pulseWrap}>
      <Animated.View style={[styles.pulseDot, dot]} />
    </View>
  );
};

// ---------------------------------------------------------------
// Styles
// ---------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLOR.bg0,
  },
  bgFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLOR.bg0,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
  },
  loadingText: {
    color: COLOR.textDim,
    fontSize: 13,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },

  // Soft glow pads — fake radial gradients via offset linears.
  glowTopLeft: {
    position: 'absolute',
    top: -200,
    left: -160,
    width: 520,
    height: 520,
    borderRadius: 260,
    transform: [{ rotate: '20deg' }],
  },
  glowBottomRight: {
    position: 'absolute',
    bottom: -240,
    right: -180,
    width: 560,
    height: 560,
    borderRadius: 280,
    transform: [{ rotate: '-30deg' }],
  },

  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingTop: 60,
    paddingBottom: 80,
  },

  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 28,
  },
  brandDot: {
    width: 8,
    height: 8,
    backgroundColor: COLOR.accent,
    borderRadius: 1,
    transform: [{ rotate: '45deg' }],
  },
  brandKicker: {
    color: COLOR.textDim,
    fontSize: 11,
    letterSpacing: 2.6,
    fontWeight: '700',
  },

  headline: {
    color: COLOR.text,
    fontSize: 44,
    lineHeight: 50,
    letterSpacing: -1.2,
    fontWeight: '800',
    marginBottom: 18,
  },
  headlineAccent: {
    color: COLOR.accent,
    fontWeight: '800',
  },

  subhead: {
    color: COLOR.textDim,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 28,
    maxWidth: 360,
  },

  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 40,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: COLOR.hairline,
  },
  chipLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.4,
  },

  ctaStack: {
    gap: 12,
  },

  // Primary button — pill, dark fill, accent ring outside it.
  // Two stacked Animated.Views so we can drive ring opacity and
  // button scale independently from the same press value.
  primaryRing: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLOR.accent,
    opacity: 0.35,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 22,
    backgroundColor: COLOR.bg2,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,90,0,0.5)',
  },
  primaryBtnText: {
    color: COLOR.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
    flex: 1,
  },

  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLOR.hairline,
  },
  secondaryBtnText: {
    color: COLOR.text,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.2,
  },

  tertiary: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  tertiaryText: {
    color: COLOR.textFaint,
    fontSize: 12.5,
    letterSpacing: 0.4,
  },
  tertiaryTextFaint: {
    color: COLOR.textFaint,
    fontSize: 11,
    letterSpacing: 0.4,
    opacity: 0.7,
  },

  reviewerOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 50,
  },
  reviewerCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: COLOR.bg2,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLOR.hairline,
    padding: 22,
    gap: 14,
  },
  reviewerTitle: {
    color: COLOR.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  reviewerBody: {
    color: COLOR.textDim,
    fontSize: 13,
    lineHeight: 18,
  },
  reviewerInput: {
    backgroundColor: COLOR.bg0,
    borderWidth: 1,
    borderColor: COLOR.hairline,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLOR.text,
    fontSize: 14,
    letterSpacing: 0.4,
  },
  reviewerRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 4,
  },
  reviewerBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  reviewerBtnPrimary: {
    backgroundColor: COLOR.accent,
  },
  reviewerBtnText: {
    color: COLOR.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  footer: {
    position: 'absolute',
    bottom: 24,
    left: 28,
    right: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  footerText: {
    color: COLOR.textFaint,
    fontSize: 10,
    letterSpacing: 1.6,
    fontWeight: '600',
  },
  footerSep: {
    width: 1,
    height: 10,
    backgroundColor: COLOR.hairline,
  },
  pulseWrap: {
    width: 8,
    height: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLOR.lime,
  },
});
