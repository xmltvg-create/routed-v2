import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Platform, AppState, AppStateStatus } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setReconnectImpl } from '../utils/authBridge';

// EXPO_PUBLIC_BACKEND_URL is asserted non-empty in `app/_layout.tsx` at
// module-load time, so a missing value crashes the app cold rather than
// silently issuing relative-URL fetches. The non-null assertion below
// records that invariant for TypeScript.
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL!;

// DEV MODE: Read from env, defaults to false for production builds
const DEV_MODE = (process.env.EXPO_PUBLIC_DEV_MODE || 'false').toLowerCase() === 'true';
const DEV_USER = {
  user_id: 'dev-user-123',
  email: 'dev@example.com',
  name: 'Dev User',
  picture: undefined,
};

interface User {
  user_id: string;
  email: string;
  name: string;
  picture?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (sessionId: string) => Promise<void>;
  /** No-Google sign-in for Google Play Store reviewers. Posts the
   *  reviewer email + passcode to `/api/auth/reviewer-login`, which
   *  validates against the `REVIEWER_EMAILS` allowlist + `REVIEWER_PASSCODE`
   *  env var, then mints a 7-day session token (same shape as the
   *  Google OAuth path). Throws on 401/503 so the caller can surface
   *  the failure inside the passcode prompt. */
  loginAsReviewer: (email: string, passcode: string) => Promise<void>;
  /** Email/password fallback login. Works when Google OAuth is down. */
  loginWithEmail: (email: string, password: string) => Promise<void>;
  /** Email/password registration. Creates a new account. */
  registerWithEmail: (email: string, password: string, name: string) => Promise<void>;
  /** Set password for existing Google-only account (no login required). */
  forceSetPassword: (email: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-runs the Emergent Google OAuth flow in-place (single browser tap)
   *  to re-issue an expired session_token. Returns true if the user came
   *  back signed in, false if they cancelled or the exchange failed.
   *  Rationale: Emergent-managed auth has no /refresh endpoint
   *  (session_token is fixed 7-day per the playbook), so the closest we
   *  can get to "silent" is one-tap reconnect from wherever the 401 was
   *  hit, instead of forcing the driver through Profile → Sign out → Sign in. */
  reconnect: () => Promise<boolean>;
  /** True while `reconnect()` is mid-flight — UIs use this to render a
   *  spinner inside their "Session expired" banner without managing a
   *  parallel local state. */
  reconnecting: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    // DEV MODE: Auto-login with dev user
    if (DEV_MODE) {
      setUser(DEV_USER);
      setLoading(false);
      return;
    }
    checkAuth();
  }, []);

  // Register the reconnect handler with the module-level authBridge so
  // `authFetch` (defined at module scope in stopsStore.ts, no React)
  // can reach it. We register on every render so the bridge always
  // points at the freshest closure (capturing current `reconnecting`
  // state guard etc). Cleanup unregisters on unmount.
  useEffect(() => {
    setReconnectImpl(reconnect);
    return () => setReconnectImpl(null);
  });

  // Re-verify the session whenever the app returns to foreground. Android
  // can keep the process alive for days across background/lock cycles,
  // during which the server-side session may have expired (7-day TTL,
  // server restart, manual revocation, etc.). Without this, the first
  // API call after resume returns 401 mid-gesture and the user sees the
  // action (Confirm Route, Mark Delivered, …) silently fail. This runs
  // the same auth-check-and-clear flow as the cold-start path so the
  // "sign in" screen surfaces BEFORE the driver tries to do anything.
  useEffect(() => {
    if (DEV_MODE) return;
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') {
        // Fire-and-forget — checkAuth handles its own errors and
        // updates `user` state, which downstream screens react to.
        checkAuth();
      }
    });
    return () => sub.remove();
  }, []);

  const checkAuth = async () => {
    try {
      const token = await AsyncStorage.getItem('session_token');
      if (token) {
        const response = await fetch(`${BACKEND_URL}/api/auth/me`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const userData = await response.json();
          setUser(userData);
        } else {
          await AsyncStorage.removeItem('session_token');
        }
      }
    } catch (error) {
      console.error('Auth check error:', error);
    } finally {
      setLoading(false);
    }
  };

  const login = async (sessionId: string) => {
    try {
      setLoading(true);
      const response = await fetch(`${BACKEND_URL}/api/auth/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId,
        },
      });

      if (response.ok) {
        const userData = await response.json();
        
        // Use the session_token returned by backend (matches what's stored in DB)
        const sessionToken = userData.session_token || sessionId;
        await AsyncStorage.setItem('session_token', sessionToken);
        setUser(userData);
      } else {
        // ── Diagnostic surface ─────────────────────────────────────────
        // Parse the backend's specific failure mode so the login screen
        // can show it verbatim instead of the generic "Login failed".
        // Most common shapes seen here:
        //   {"detail": "Invalid session (upstream 404)"}   — session_id
        //     already consumed (duplicate exchange / OTA-reload ghost)
        //   {"detail": "Invalid session (upstream 5xx)"}   — Emergent
        //     auth service hiccup
        //   {"detail": "Authentication failed (TimeoutException)"} —
        //     network blip between our backend and demobackend
        //   {"detail": "Signups disabled. ..."}            — whitelist
        //     rejected an unknown email
        // Without this branch the user just sees "Login failed" with
        // no way to tell us which one fired.
        let serverDetail = '';
        try {
          const j = await response.json();
          serverDetail = typeof j?.detail === 'string' ? j.detail : '';
        } catch {
          try { serverDetail = await response.text(); } catch { /* ignore */ }
        }
        console.error('Login failed:', response.status, serverDetail);
        const e: any = new Error(`Login failed (HTTP ${response.status}): ${serverDetail}`);
        e.status = response.status;
        e.detail = serverDetail;
        throw e;
      }
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Re-runs the Emergent Google OAuth flow and exchanges the resulting
   * session_id for a fresh session_token, all without leaving whatever
   * screen the caller was on. Replaces the prior "Profile → Sign out →
   * Sign in" five-step recovery with a single tap.
   *
   * Why this isn't a true silent refresh: per the Emergent Auth playbook
   * the platform issues a 7-day session_token but exposes no /refresh
   * endpoint — once it expires the only re-issue path is bouncing the
   * user through `auth.emergentagent.com`. WebBrowser.openAuthSessionAsync
   * uses the device's existing Google session in most cases, so the
   * "browser tab" is typically a flash, not a full re-login.
   */
  const reconnect = async (): Promise<boolean> => {
    if (DEV_MODE) return true;          // dev users are always "signed in"
    if (reconnecting) return false;     // disallow concurrent attempts
    setReconnecting(true);
    try {
      // REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
      const redirectUrl =
        Platform.OS === 'web'
          ? `${window.location.origin}/`
          : Linking.createURL('/');
      const authUrl = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;

      if (Platform.OS === 'web') {
        // Web can't pop a modal browser cleanly — full redirect, the page
        // boot will pick up #session_id and call login() through the
        // existing handlers in app/index.tsx.
        window.location.href = authUrl;
        return false;
      }

      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);
      if (result.type === 'success' && result.url) {
        const m = result.url.match(/[#?]session_id=([^&]+)/);
        if (m) {
          const sid = decodeURIComponent(m[1]);
          await login(sid);
          return true;
        }
      }
      return false;
    } catch (e) {
      console.error('[reconnect] failed:', e);
      return false;
    } finally {
      setReconnecting(false);
    }
  };

  /**
   * No-Google reviewer login. Posts (email, passcode) to the backend,
   * which validates both against the `REVIEWER_EMAILS` allowlist + the
   * `REVIEWER_PASSCODE` env var, mints a fresh 7-day session_token, and
   * (on first login) seeds the demo Sydney route. Mirrors the cookie
   * + AsyncStorage handling of `login()` so downstream screens treat
   * the reviewer session identically to a Google session.
   */
  const loginAsReviewer = async (email: string, passcode: string) => {
    try {
      setLoading(true);
      const response = await fetch(`${BACKEND_URL}/api/auth/reviewer-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, passcode }),
      });

      if (!response.ok) {
        let detail = '';
        try {
          const j = await response.json();
          detail = typeof j?.detail === 'string' ? j.detail : '';
        } catch { /* ignore */ }
        const e: any = new Error(
          `Reviewer login failed (HTTP ${response.status}): ${detail}`,
        );
        e.status = response.status;
        e.detail = detail;
        throw e;
      }

      const userData = await response.json();
      await AsyncStorage.setItem('session_token', userData.session_token);
      setUser(userData);
    } catch (error) {
      console.error('Reviewer login error:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const loginWithEmail = async (email: string, password: string) => {
    try {
      setLoading(true);
      const response = await fetch(`${BACKEND_URL}/api/auth/login-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        let detail = '';
        try {
          const j = await response.json();
          detail = typeof j?.detail === 'string' ? j.detail : '';
        } catch { /* ignore */ }
        throw new Error(detail || `Login failed (HTTP ${response.status})`);
      }

      const userData = await response.json();
      await AsyncStorage.setItem('session_token', userData.session_token);
      setUser(userData);
    } catch (error) {
      console.error('Email login error:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const registerWithEmail = async (email: string, password: string, name: string) => {
    try {
      setLoading(true);
      const response = await fetch(`${BACKEND_URL}/api/auth/register-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      });

      if (!response.ok) {
        let detail = '';
        try {
          const j = await response.json();
          detail = typeof j?.detail === 'string' ? j.detail : '';
        } catch { /* ignore */ }
        throw new Error(detail || `Registration failed (HTTP ${response.status})`);
      }

      const userData = await response.json();
      await AsyncStorage.setItem('session_token', userData.session_token);
      setUser(userData);
    } catch (error) {
      console.error('Email register error:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const forceSetPassword = async (email: string, newPassword: string) => {
    try {
      setLoading(true);
      const response = await fetch(`${BACKEND_URL}/api/auth/force-set-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, new_password: newPassword }),
      });

      if (!response.ok) {
        let detail = '';
        try {
          const j = await response.json();
          detail = typeof j?.detail === 'string' ? j.detail : '';
        } catch { /* ignore */ }
        throw new Error(detail || `Failed to set password (HTTP ${response.status})`);
      }

      const userData = await response.json();
      await AsyncStorage.setItem('session_token', userData.session_token);
      setUser(userData);
    } catch (error) {
      console.error('Force set password error:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      const token = await AsyncStorage.getItem('session_token');
      if (token) {
        await fetch(`${BACKEND_URL}/api/auth/logout`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
      }
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      await AsyncStorage.removeItem('session_token');
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, login, loginAsReviewer, loginWithEmail, registerWithEmail, forceSetPassword, logout, reconnect, reconnecting }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
