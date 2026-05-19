import React, { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider } from '../src/context/AuthContext';
import { Platform, StyleSheet, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

// Boot-time invariant: every API call in the app reads
// `process.env.EXPO_PUBLIC_BACKEND_URL`, replaced inline at bundle time
// by Metro. If somebody ships a build with the env var unset, every
// fetch silently hits a relative path (like `/api/auth/me`) and the app
// quietly degrades — exactly the failure mode the deploy readiness
// check flagged. Crash early and loud instead.
if (!process.env.EXPO_PUBLIC_BACKEND_URL) {
  throw new Error(
    'EXPO_PUBLIC_BACKEND_URL is not set. Configure it in eas.json (preview/production env block) and frontend/.env, then rebuild the bundle.',
  );
}

/**
 * Wrap a Promise in a hard timeout. The Expo updater's
 * `fetchUpdateAsync()` has no per-call timeout — on flaky carriers a
 * stalled asset HTTP fetch can hang the promise indefinitely. This
 * helper guarantees the fetch step gives up cleanly so we can retry
 * instead of leaving the device stuck downloading forever.
 */
const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default function RootLayout() {
  // Tiny floating banner shown while we're fetching/applying an OTA. Most
  // builds skip this entirely (fast network, update lands in 1-2 s). When
  // the network is bad, drivers at least see "Updating app… (try 2/3)"
  // instead of wondering why nothing changed after their last sign-in.
  const [otaStatus, setOtaStatus] = useState<string | null>(null);

  useEffect(() => {
    const isWebRuntime = typeof document !== 'undefined';
    if (Platform.OS !== 'web' && !isWebRuntime) {
      import('expo-keep-awake')
        .then(({ activateKeepAwakeAsync }) => activateKeepAwakeAsync('planner-global-navigation'))
        .catch((error) => {
          console.warn('[WakeLock] Activation failed:', error);
        });
    }

    // Check for OTA updates on app launch (native builds only).
    // Resilient against carrier-grade timeouts:
    //  - `checkForUpdateAsync` capped at 15s
    //  - `fetchUpdateAsync` capped at 60s, retried up to 3 times with
    //    exponential backoff (the per-asset HTTP fetches inside this
    //    call are what stall on flaky networks; a hard cap + retry
    //    converts an infinite hang into a soft "try again next launch")
    //  - any failure leaves the user on the cached bundle (the app keeps
    //    working) — only a successful fetch triggers `reloadAsync()`
    const MAX_ATTEMPTS = 3;
    const checkForOtaUpdate = async () => {
      if (Platform.OS === 'web' || __DEV__) return;          // skip in Expo Go / dev
      if (!Updates.isEnabled) return;                         // respect app.json toggle
      try {
        const result = await withTimeout(
          Updates.checkForUpdateAsync(),
          15_000,
          'checkForUpdateAsync',
        );
        if (!result.isAvailable) return;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          try {
            setOtaStatus(
              attempt === 1
                ? 'Updating app…'
                : `Updating app… (try ${attempt}/${MAX_ATTEMPTS})`,
            );
            await withTimeout(
              Updates.fetchUpdateAsync(),
              60_000,
              `fetchUpdateAsync attempt ${attempt}`,
            );
            // Fetch succeeded — apply on next event-loop tick so the banner
            // briefly flashes "Restarting…" before the JS reload.
            setOtaStatus('Restarting…');
            await sleep(150);
            await Updates.reloadAsync();
            return;
          } catch (err) {
            console.warn(`[OTA] attempt ${attempt} failed:`, err);
            if (attempt === MAX_ATTEMPTS) {
              setOtaStatus(null);
              return;
            }
            // Exponential backoff: 2s, 4s, 8s. Keeps the banner visible
            // long enough that the driver sees we're still trying.
            await sleep(2_000 * 2 ** (attempt - 1));
          }
        }
      } catch (error) {
        // checkForUpdateAsync timed out or failed — silent fallback.
        console.warn('[OTA] Update check failed (non-fatal):', error);
        setOtaStatus(null);
      }
    };
    checkForOtaUpdate();

    return () => {
      if (Platform.OS !== 'web' && !isWebRuntime) {
        import('expo-keep-awake')
          .then(({ deactivateKeepAwake }) => {
            try {
              deactivateKeepAwake('planner-global-navigation');
            } catch (error) {
              console.warn('[WakeLock] Deactivation failed:', error);
            }
          })
          .catch(() => {
            // No-op
          });
      }
    };

  }, []);

  return (
    <GestureHandlerRootView style={styles.container}>
      <ErrorBoundary>
        <AuthProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: '#0f172a' },
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="add-stop" options={{ presentation: 'modal' }} />
            <Stack.Screen name="edit-stop" options={{ presentation: 'modal' }} />
            <Stack.Screen name="import" options={{ presentation: 'modal' }} />
            <Stack.Screen name="stop-detail" options={{ presentation: 'card' }} />
            <Stack.Screen name="android-auto" options={{ presentation: 'card' }} />
            <Stack.Screen name="privacy" options={{ presentation: 'card', headerShown: true }} />
          </Stack>
          {otaStatus && (
            <View
              style={styles.otaBanner}
              pointerEvents="none"
              data-testid="ota-status-banner"
            >
              <Text style={styles.otaBannerText}>{otaStatus}</Text>
            </View>
          )}
        </AuthProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  otaBanner: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#09090B',
    borderColor: '#FF5A00',
    borderWidth: 2,
    borderRadius: 6,
    elevation: 6,
  },
  otaBannerText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
