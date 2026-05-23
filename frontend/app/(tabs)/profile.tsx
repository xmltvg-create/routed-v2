import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  Alert,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../../src/context/AuthContext';
import { useStopsStore } from '../../src/store/stopsStore';
import { TelemetryCard } from '../../src/components/TelemetryCard';
import { MLServiceTimeCard } from '../../src/components/MLServiceTimeCard';
import { MLBuildingSideCard } from '../../src/components/MLBuildingSideCard';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const { stops, clearStops, archiveRoute } = useStopsStore();
  const [archiving, setArchiving] = React.useState(false);
  const [saveResult, setSaveResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  // Stale-session auto-recovery — when the app's stored session_token was
  // minted against a DB the backend no longer uses (e.g., after the
  // Atlas/Fly migration moved data from `test_database` → `routed`), the
  // token will validate /api/auth/me via a fallback but 401 on every other
  // protected endpoint. Driver sees "Total Stops: 0" + 3 "HTTP 401" cards
  // and there's no obvious recovery — they have to scroll to find Logout.
  // Probe /api/stops on mount; if it's a hard 401 with a token in storage,
  // wipe it and bounce to the login screen so the next session is clean.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await AsyncStorage.getItem('session_token');
      if (!token || !user) return; // nothing to recover from
      try {
        const r = await fetch(`${BACKEND_URL}/api/stops`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (r.status === 401) {
          // Token is corrupt for this backend. Clear & bounce.
          await logout();
          clearStops();
          Alert.alert(
            'Session expired',
            'Your sign-in expired after a backend update. Please sign in again to refresh.',
            [{ text: 'OK', onPress: () => router.replace('/') }],
          );
        }
      } catch {
        // Network errors aren't a stale-session signal; ignore.
      }
    })();
    return () => { cancelled = true; };
    // user is the only thing that matters — we want one probe per real
    // login, not one per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.user_id]);

  const completedCount = React.useMemo(
    () => stops.filter((s) => s.completed).length,
    [stops],
  );

  // Save the current shift's completed stops into route_history so
  // telemetry-rollup can include them. Auto-archive ALSO fires on the
  // next manifest upload (server.py::import_process), but most drivers
  // want to see the day's numbers before they move on to tomorrow's
  // manifest. This is the only UI entry point for the existing
  // /api/routes/archive endpoint until that path is shipped.
  //
  // No confirm dialog — the big emerald button IS the confirm. We just
  // call the endpoint, flash the inline status, and surface the exact
  // error if it fails so the driver isn't stuck wondering "did it work?".
  const handleSaveRoute = async () => {
    if (completedCount === 0) {
      Alert.alert(
        'Nothing to save',
        'You have no completed stops in this shift. Mark some as Delivered first, then come back.',
      );
      return;
    }
    setArchiving(true);
    setSaveResult(null);
    try {
      const ok = await archiveRoute();
      if (ok) {
        setSaveResult({
          ok: true,
          message: `Archived ${completedCount} stops to History. Tap the refresh icon on the Telemetry tile below to see the updated numbers.`,
        });
      } else {
        setSaveResult({
          ok: false,
          message:
            'Save returned false. Possible causes: backend redeploy needed, or completed stops were already archived. Check Telemetry tile to confirm.',
        });
      }
    } catch (err: any) {
      console.error('[profile] Save Route error:', err);
      const status = err?.status ?? '?';
      const detail = err?.detail ?? err?.message ?? 'unknown error';
      setSaveResult({
        ok: false,
        message: `Save failed (HTTP ${status}): ${detail}`,
      });
    } finally {
      setArchiving(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          await logout();
          clearStops();
          router.replace('/');
        },
      },
    ]);
  };

  const handleClearRoute = () => {
    Alert.alert(
      'Clear All Stops',
      'This will delete all your saved stops. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            // Delete all stops
            for (const stop of stops) {
              await useStopsStore.getState().deleteStop(stop.id);
            }
          },
        },
      ]
    );
  };

  return (
    <ScrollView style={styles.container}>
      {/* Profile Card */}
      <View style={styles.profileCard}>
        <View style={styles.avatarContainer}>
          {user?.picture ? (
            <Image source={{ uri: user.picture }} style={styles.avatar} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Ionicons name="person" size={40} color="#64748b" />
            </View>
          )}
        </View>
        <Text style={styles.userName}>{user?.name || 'User'}</Text>
        <Text style={styles.userEmail}>{user?.email || ''}</Text>
      </View>

      {/* Stats */}
      <View style={styles.statsCard}>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{stops.length}</Text>
          <Text style={styles.statLabel}>Total Stops</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statValue}>
            {stops.filter((s) => s.priority === 'high').length}
          </Text>
          <Text style={styles.statLabel}>High Priority</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statValue}>
            {stops.filter((s) => s.time_window?.start).length}
          </Text>
          <Text style={styles.statLabel}>With Time Window</Text>
        </View>
      </View>

      {/* Telemetry tile — rolls up the last 7 days of archived routes and
          surfaces three traffic-light metrics (arrival proximity, geofence
          hook firing, Phase 1 ML readiness). Wired here so the driver
          sees data quality at a glance without curling URLs. */}
      {/* Save Route button — calls /api/routes/archive to roll the
          current shift's completed stops into route_history so they
          start counting in the telemetry rollup below. Without this
          drivers had no way to trigger archive other than uploading
          the next day's manifest (which auto-archives via
          server.py::import_process). */}
      <TouchableOpacity
        style={[styles.saveRouteButton, completedCount === 0 && styles.saveRouteButtonDisabled]}
        onPress={handleSaveRoute}
        disabled={archiving || completedCount === 0}
        testID="profile-save-route-button"
        accessibilityLabel={`Save Route. ${completedCount} stops to archive.`}
      >
        <Ionicons
          name={archiving ? 'hourglass-outline' : 'cloud-upload-outline'}
          size={18}
          color={completedCount === 0 ? '#94a3b8' : '#fff'}
        />
        <Text
          style={[styles.saveRouteText, completedCount === 0 && styles.saveRouteTextDisabled]}
        >
          {archiving
            ? 'Saving…'
            : completedCount === 0
              ? 'Nothing to save'
              : `Save Route to History (${completedCount} stops)`}
        </Text>
      </TouchableOpacity>

      {/* Inline result panel — shows the actual outcome of the last
          Save Route attempt. Green for success, red for failure, with
          the verbatim backend error so the driver can paste it to
          support instead of "nothing happened". */}
      {saveResult ? (
        <View
          style={[
            styles.saveResultPanel,
            saveResult.ok ? styles.saveResultOk : styles.saveResultFail,
          ]}
          testID="profile-save-result"
        >
          <Ionicons
            name={saveResult.ok ? 'checkmark-circle' : 'alert-circle'}
            size={16}
            color={saveResult.ok ? '#065f46' : '#991b1b'}
          />
          <Text
            style={[
              styles.saveResultText,
              { color: saveResult.ok ? '#065f46' : '#991b1b' },
            ]}
          >
            {saveResult.message}
          </Text>
        </View>
      ) : null}

      <TelemetryCard />
      <MLServiceTimeCard />
      <MLBuildingSideCard />

      {/* Menu Items */}
      <View style={styles.menuSection}>
        <Text style={styles.sectionTitle}>Route Management</Text>
        
        <TouchableOpacity style={styles.menuItem} onPress={handleClearRoute}>
          <View style={[styles.menuIcon, { backgroundColor: '#fef2f2' }]}>
            <Ionicons name="trash-outline" size={20} color="#ef4444" />
          </View>
          <View style={styles.menuContent}>
            <Text style={styles.menuText}>Clear All Stops</Text>
            <Text style={styles.menuSubtext}>Delete all saved stops</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#64748b" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => router.push('/billing' as any)}
          testID="profile-billing-menu-item"
        >
          <View style={[styles.menuIcon, { backgroundColor: '#fef3c7' }]}>
            <Ionicons name="sparkles-outline" size={20} color="#d97706" />
          </View>
          <View style={styles.menuContent}>
            <Text style={styles.menuText}>RouTeD Pro</Text>
            <Text style={styles.menuSubtext}>Manage subscription or start a 7-day free trial</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#64748b" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => router.push('/android-auto')}
          testID="profile-android-auto-menu-item"
        >
          <View style={[styles.menuIcon, { backgroundColor: '#eff6ff' }]}>
            <Ionicons name="car-sport-outline" size={20} color="#2563eb" />
          </View>
          <View style={styles.menuContent}>
            <Text style={styles.menuText}>Android Auto</Text>
            <Text style={styles.menuSubtext}>Open setup and in-car feature status</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#64748b" />
        </TouchableOpacity>
      </View>

      <View style={styles.menuSection}>
        <Text style={styles.sectionTitle}>About</Text>
        
        <View style={styles.menuItem}>
          <View style={[styles.menuIcon, { backgroundColor: '#eff6ff' }]}>
            <Ionicons name="information-circle-outline" size={20} color="#3b82f6" />
          </View>
          <View style={styles.menuContent}>
            <Text style={styles.menuText}>App Version</Text>
            <Text style={styles.menuSubtext}>1.0.0</Text>
          </View>
        </View>

        <View style={styles.menuItem}>
          <View style={[styles.menuIcon, { backgroundColor: '#f0fdf4' }]}>
            <Ionicons name="sparkles-outline" size={20} color="#10b981" />
          </View>
          <View style={styles.menuContent}>
            <Text style={styles.menuText}>Powered By</Text>
            <Text style={styles.menuSubtext}>AI Route Optimization</Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => router.push('/privacy')}
          testID="profile-open-privacy"
          accessibilityLabel="Open privacy and terms"
        >
          <View style={[styles.menuIcon, { backgroundColor: '#f0f9ff' }]}>
            <Ionicons name="shield-checkmark-outline" size={20} color="#0ea5e9" />
          </View>
          <View style={styles.menuContent}>
            <Text style={styles.menuText}>Privacy & Terms</Text>
            <Text style={styles.menuSubtext}>What we collect, how we use it</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
        </TouchableOpacity>
      </View>

      {/* Logout Button */}
      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <Ionicons name="log-out-outline" size={20} color="#ef4444" />
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>

      <View style={styles.footer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  profileCard: {
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#ffffff',
    margin: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  avatarContainer: {
    marginBottom: 16,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 3,
    borderColor: '#3b82f6',
  },
  avatarPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#f1f5f9',
    justifyContent: 'center',
    alignItems: 'center',
  },
  userName: {
    color: '#0f172a',
    fontSize: 20,
    fontWeight: '600',
  },
  userEmail: {
    color: '#64748b',
    fontSize: 14,
    marginTop: 4,
  },
  statsCard: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    color: '#0f172a',
    fontSize: 24,
    fontWeight: 'bold',
  },
  statLabel: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 4,
  },
  statDivider: {
    width: 1,
    backgroundColor: '#e2e8f0',
  },
  menuSection: {
    marginTop: 24,
    marginHorizontal: 16,
  },
  sectionTitle: {
    color: '#64748b',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 12,
    marginLeft: 4,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuContent: {
    flex: 1,
    marginLeft: 12,
  },
  menuText: {
    color: '#0f172a',
    fontSize: 16,
    fontWeight: '500',
  },
  menuSubtext: {
    color: '#64748b',
    fontSize: 13,
    marginTop: 2,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fef2f2',
    marginHorizontal: 16,
    marginTop: 32,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  logoutText: {
    color: '#ef4444',
    fontSize: 16,
    fontWeight: '600',
  },
  footer: {
    height: 40,
  },
  saveRouteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#10b981',  // emerald-500 — the only "save my work" button on this screen
  },
  saveRouteButtonDisabled: {
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  saveRouteText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
    letterSpacing: 0.2,
  },
  saveRouteTextDisabled: {
    color: '#94a3b8',
    fontWeight: '600',
  },
  saveResultPanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  saveResultOk: {
    backgroundColor: '#ecfdf5',
    borderColor: '#a7f3d0',
  },
  saveResultFail: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  saveResultText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '500',
  },
});
