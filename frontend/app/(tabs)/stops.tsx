import React, { useEffect, useCallback, useMemo, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  RefreshControl,
  FlatList,
  TextInput,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
// Swipeable disabled due to potential React 19 compatibility issues
import { useAuth } from '../../src/context/AuthContext';
import { useStopsStore, Stop } from '../../src/store/stopsStore';
import { stopPinNumber } from '../../src/utils/stopPinNumber';
import { stopDriveOrder } from '../../src/utils/stopDriveOrder';

// Android requires an explicit opt-in for LayoutAnimation — without this
// the shrink-on-complete transition is instantaneous on Android.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function StopsScreen() {
  const { user, reconnect, reconnecting } = useAuth();
  const router = useRouter();
  const { stops, loading, fetchStops, deleteStop, reorderStops, completeStop, uncompleteStop, lastFetchError } = useStopsStore();
  // Loaded-set fed by the Van Loading Assistant scanner. We select it as
  // a separate slice so a non-loaded driver navigating to the Stops tab
  // doesn't pay the re-render cost of every Set update during a load.
  const loadedStopIds = useStopsStore((s) => s.loadedStopIds);
  const [refreshing, setRefreshing] = React.useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // "Find Missing" filter — toggle that hides every stop already scanned
  // into the van + every stop already delivered, leaving ONLY parcels
  // still on the warehouse floor. Closes the loading-audit loop. Lives
  // in local state (NOT Zustand) — the toggle resets when the driver
  // navigates away from the Stops tab. The chip itself is part of the
  // search row so drivers can combine it with text search if needed.
  const [findMissingOnly, setFindMissingOnly] = useState(false);

  // Filter stops by name/address/notes while preserving each stop's
  // ORIGINAL index — that's the parcel number the driver writes on the box,
  // so it must NOT shift when the list is filtered.
  const filteredStops = useMemo(() => {
    const annotated = stops.map((stop, originalIndex) => ({ stop, originalIndex }));
    const q = searchQuery.trim().toLowerCase();
    let result = annotated;
    if (q) {
      result = result.filter(({ stop }) => {
        const haystack = [stop.name, stop.address, stop.notes]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }
    if (findMissingOnly) {
      // "Missing" = not yet loaded into the van AND not yet delivered.
      result = result.filter(({ stop }) =>
        !stop.completed && !loadedStopIds.has(stop.id),
      );
    }
    return result;
  }, [stops, searchQuery, findMissingOnly, loadedStopIds]);

  // Counter shown in the Find Missing chip — drives the badge text and
  // the auto-disable when the warehouse is clear.
  const missingCount = useMemo(
    () => stops.filter((s) => !s.completed && !loadedStopIds.has(s.id)).length,
    [stops, loadedStopIds],
  );

  useEffect(() => {
    if (user) {
      fetchStops();
    }
  }, [user]);

  // Refetch every time this tab gains focus. The original behaviour only
  // fetched on `[user]` change, which meant a successful import → modal
  // dismiss → land on this tab would NOT refetch; the user relied on the
  // import modal's own background `await fetchStops()` to update the
  // zustand store. When that call hit a 401 / network blip the screen sat
  // empty even though the import had succeeded server-side. Refetching
  // on focus is cheap (200ms /api/stops) and closes that gap.
  useFocusEffect(
    useCallback(() => {
      if (user) {
        fetchStops();
      }
    }, [user, fetchStops]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchStops();
    setRefreshing(false);
  }, [fetchStops]);

  // Shrink/grow animation whenever the count of completed stops changes
  // (driver taps "Mark Delivered" in the navigation panel, or un-completes
  // from the detail screen). Fires exactly once per toggle — NOT on every
  // background refetch — so drag-reorder and filter-typing don't trigger
  // layout thrash. 250 ms ease-in-out matches the confirmation haptic.
  const prevCompletedCount = useRef<number | null>(null);
  useEffect(() => {
    const n = stops.filter((s) => s.completed).length;
    if (prevCompletedCount.current !== null && n !== prevCompletedCount.current) {
      LayoutAnimation.configureNext(
        LayoutAnimation.create(
          250,
          LayoutAnimation.Types.easeInEaseOut,
          LayoutAnimation.Properties.scaleXY,
        ),
      );
    }
    prevCompletedCount.current = n;
  }, [stops]);

  const handleDelete = (stop: Stop) => {
    Alert.alert(
      'Delete Stop',
      `Are you sure you want to delete "${stop.name || stop.address}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteStop(stop.id),
        },
      ]
    );
  };

  const handleComplete = async (stop: Stop) => {
    if (stop.completed) {
      await uncompleteStop(stop.id);
    } else {
      await completeStop(stop.id);
    }
  };

  const handleDragEnd = useCallback(
    ({ data }: { data: Stop[] }) => {
      const stopIds = data.map((s) => s.id);
      reorderStops(stopIds);
    },
    [reorderStops]
  );

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high':
        return '#ef4444';
      case 'low':
        return '#6b7280';
      default:
        return '#3b82f6';
    }
  };

  const getPriorityBgColor = (priority: string) => {
    switch (priority) {
      case 'high':
        return 'rgba(239, 68, 68, 0.15)';
      case 'low':
        return 'rgba(107, 114, 128, 0.15)';
      default:
        return 'rgba(59, 130, 246, 0.15)';
    }
  };

  const renderItem = useCallback(
    ({ item }: { item: { stop: Stop; originalIndex: number } }) => {
      const { stop, originalIndex } = item;
      return (
        <TouchableOpacity
          style={[
            styles.stopCard,
            stop.completed && styles.stopCardCompleted,
            stop.completed && styles.stopCardCompactCompleted,
          ]}
          onPress={() => router.push({ pathname: '/stop-detail', params: { id: stop.id } })}
          activeOpacity={0.8}
          testID={`stop-card-${stopPinNumber(stop) ?? originalIndex + 1}`}
        >
          {/* LEFT badge — the OPTIMISED drive order (`sequence_number`)
             via `stopDriveOrder`. This is what the driver follows TODAY
             and changes every time a re-optimise happens (e.g. a courtesy
             stop is wedged in or the back-end re-shuffles after a
             completion). The Sharpie/box label moved to the smaller
             chip on the right of the card so both numbers are visible:
                LEFT (large) = "drive to me 5th next"
                RIGHT (small) = "look for box #127 in the van"
             Pre-confirm both fields are null and we render '—' rather
             than fall back to an array index — that visually nudges the
             driver to hit Confirm Route before they trust either label. */}
          <View
            style={[
              styles.stopNumber,
              stop.completed && styles.stopNumberCompact,
              { backgroundColor: stop.completed ? '#10b981' : getPriorityColor(stop.priority) },
            ]}
          >
            {stop.completed ? (
              <Ionicons name="checkmark" size={14} color="#fff" />
            ) : (
              <Text style={styles.stopNumberText}>{stopDriveOrder(stop) ?? '—'}</Text>
            )}
          </View>

          {/* Stop Info */}
          <View style={styles.stopInfo}>
            <View style={styles.stopNameRow}>
              <Text
                style={[
                  styles.stopName,
                  stop.completed && styles.textCompleted,
                  stop.completed && styles.stopNameCompact,
                ]}
                numberOfLines={1}
              >
                {stop.address || 'No address'}
              </Text>
              {stop.priority === 'high' && !stop.completed && (
                <View style={[styles.priorityTag, { backgroundColor: getPriorityBgColor(stop.priority) }]}>
                  <Ionicons name="flag" size={10} color={getPriorityColor(stop.priority)} />
                  <Text style={[styles.priorityTagText, { color: getPriorityColor(stop.priority) }]}>
                    HIGH
                  </Text>
                </View>
              )}
              {/* "Loaded" chip — fed by the Van Loading Assistant scanner.
                 Sits next to the priority tag (or alone if no priority) so
                 drivers can scan the manifest visually after a loading
                 session and see which boxes are already in the van. */}
              {!stop.completed && loadedStopIds.has(stop.id) && (
                <View style={styles.loadedChip} data-testid={`loaded-chip-${stop.id}`}>
                  <Ionicons name="cube" size={10} color="#10b981" />
                  <Text style={styles.loadedChipText}>LOADED</Text>
                </View>
              )}
            </View>

            {/* Secondary info hidden on completed cards so they visibly shrink
                from ~96 px → ~44 px once the driver taps "Mark Delivered".
                The address (above) still shows — that's the only piece the
                driver needs for the scrollback "what did I already drop?" case. */}
            {!stop.completed && stop.name && (
              <Text style={styles.stopAddress} numberOfLines={1}>
                {stop.name}
              </Text>
            )}

            {/* Meta Info Row — weight · quantity · notes preview · time window.
                Omitted entirely once the stop is completed (shrink UX). */}
            {!stop.completed && (
              <View style={styles.metaRow}>
              {/* Time Window */}
              {stop.time_window?.start && (
                <View style={styles.metaItem}>
                  <Ionicons name="time-outline" size={12} color="#64748b" />
                  <Text style={styles.metaText}>
                    {stop.time_window.start}{stop.time_window.end ? `-${stop.time_window.end}` : ''}
                  </Text>
                </View>
              )}

              {/* Weight */}
              {stop.weight && (
                <View style={styles.metaItem}>
                  <Ionicons name="scale-outline" size={12} color="#64748b" />
                  <Text style={styles.metaText}>{stop.weight}kg</Text>
                </View>
              )}

              {/* Quantity */}
              {stop.quantity && (
                <View style={styles.metaItem}>
                  <Ionicons name="cube-outline" size={12} color="#64748b" />
                  <Text style={styles.metaText}>×{stop.quantity}</Text>
                </View>
              )}

              {/* Notes preview — show first line inline so driver sees context without opening modal */}
              {!!stop.notes && (
                <View style={[styles.metaItem, styles.metaItemNotes]}>
                  <Ionicons name="document-text-outline" size={12} color="#f59e0b" />
                  <Text style={[styles.metaText, { color: '#f59e0b' }]} numberOfLines={1}>
                    {stop.notes}
                  </Text>
                </View>
              )}
              </View>
            )}
          </View>

          {/* Sharpie-marker chip — the IMMUTABLE box label
             (`original_sequence`, locked at first /routes/confirm). Sits
             just before the chevron and uses tabular-nums so 3-digit
             values (124, 257) stay aligned. Hidden entirely when the
             route hasn't been confirmed yet (no Sharpie value to show).
             A re-optimised stop's LEFT badge will read different to its
             RIGHT chip — that's the point: drive-order moved, but the
             Sharpie on the box did not. */}
          {!stop.completed && stopPinNumber(stop) != null && (
            <View style={styles.sharpieChip} data-testid={`sharpie-chip-${stop.id}`}>
              <Text style={styles.sharpieChipHash}>#</Text>
              <Text style={styles.sharpieChipNum}>{stopPinNumber(stop)}</Text>
            </View>
          )}

          {/* Chevron */}
          <View style={styles.chevron}>
            <Ionicons name="chevron-forward" size={stop.completed ? 16 : 20} color="#475569" />
          </View>
        </TouchableOpacity>
      );
    },
    [router, loadedStopIds]
  );

  if (loading && stops.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  const completedCount = stops.filter(s => s.completed).length;

  return (
    <View style={styles.container}>
      {/* Auth-error banner — when GET /api/stops just came back 401 we
          render a clearly-actionable banner above whatever empty state
          the user lands on. Tapping it re-runs the OAuth flow IN-PLACE
          via AuthContext.reconnect(): the WebBrowser auth tab opens,
          the device's existing Google session usually flashes a
          re-redirect, login() exchanges the new session_id, and on
          success fetchStops() refires — the driver never has to leave
          this screen. While in flight we render a spinner inside the
          banner so the tap feels responsive. */}
      {lastFetchError?.status === 401 && (
        <TouchableOpacity
          data-testid="stops-auth-error-banner"
          style={styles.authBanner}
          onPress={async () => {
            const ok = await reconnect();
            if (ok) await fetchStops();
          }}
          disabled={reconnecting}
          activeOpacity={0.8}
        >
          {reconnecting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="warning-outline" size={18} color="#fff" />
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.authBannerTitle}>
              {reconnecting ? 'Reconnecting…' : 'Session expired'}
            </Text>
            <Text style={styles.authBannerText}>
              {reconnecting
                ? 'Re-issuing your session token, this only takes a moment.'
                : 'Your stops are saved. Tap to reconnect (no full sign-out).'}
            </Text>
          </View>
          {!reconnecting && <Ionicons name="chevron-forward" size={18} color="#fff" />}
        </TouchableOpacity>
      )}

      {stops.length === 0 ? (
        <View style={styles.emptyContainer}>
          <View style={styles.emptyIcon}>
            <Ionicons name="location-outline" size={48} color="#64748b" />
          </View>
          <Text style={styles.emptyTitle}>No Stops Added</Text>
          <Text style={styles.emptyText}>
            Add stops to create your delivery route
          </Text>
          <TouchableOpacity
            style={styles.addButton}
            onPress={() => router.push('/add-stop')}
          >
            <Ionicons name="add" size={24} color="#fff" />
            <Text style={styles.addButtonText}>Add First Stop</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.importButton}
            onPress={() => router.push('/import')}
          >
            <Ionicons name="document" size={24} color="#3b82f6" />
            <Text style={styles.importButtonText}>Import from Excel</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Header with stats */}
          <View style={styles.header}>
            <View style={styles.headerStats}>
              <View style={styles.statBadge}>
                <Text style={styles.statNumber}>{stops.length}</Text>
                <Text style={styles.statLabel}>Total</Text>
              </View>
              <View style={[styles.statBadge, styles.statBadgeSuccess]}>
                <Text style={[styles.statNumber, styles.statNumberSuccess]}>{completedCount}</Text>
                <Text style={styles.statLabel}>Done</Text>
              </View>
              <View style={styles.statBadge}>
                <Text style={styles.statNumber}>{stops.length - completedCount}</Text>
                <Text style={styles.statLabel}>Left</Text>
              </View>
            </View>
            <TouchableOpacity
              style={styles.importHeaderButton}
              onPress={() => router.push('/import')}
            >
              <Ionicons name="cloud-upload-outline" size={18} color="#3b82f6" />
            </TouchableOpacity>
          </View>

          {/* Swipe hint */}
          <View style={styles.swipeHint}>
            <Ionicons name="swap-horizontal" size={14} color="#64748b" />
            <Text style={styles.swipeHintText}>Swipe to complete or delete</Text>
          </View>

          {/* Search bar — filters stops by name / address / notes */}
          <View style={styles.searchRow}>
            <View style={styles.searchWrap}>
              <Ionicons name="search" size={16} color="#64748b" style={styles.searchIcon} />
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search name, address, notes…"
                placeholderTextColor="#475569"
                autoCorrect={false}
                autoCapitalize="none"
                testID="stops-search-input"
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity
                  onPress={() => setSearchQuery('')}
                  style={styles.searchClearBtn}
                  testID="stops-search-clear"
                >
                  <Ionicons name="close-circle" size={18} color="#64748b" />
                </TouchableOpacity>
              )}
            </View>
            {/* Find Missing toggle — single tap shows ONLY parcels still on
                the warehouse floor (not loaded into the van AND not yet
                delivered). Closes the loading-audit loop. Self-disables
                when the warehouse is clear so it can't get stuck on an
                empty list. */}
            <TouchableOpacity
              onPress={() => setFindMissingOnly((v) => !v)}
              disabled={missingCount === 0 && !findMissingOnly}
              style={[
                styles.findMissingChip,
                findMissingOnly && styles.findMissingChipActive,
                missingCount === 0 && !findMissingOnly && styles.findMissingChipMuted,
              ]}
              data-testid="find-missing-toggle"
            >
              <Ionicons
                name={findMissingOnly ? 'eye-off' : 'cube-outline'}
                size={14}
                color={findMissingOnly ? '#0f172a' : '#f59e0b'}
              />
              <Text
                style={[
                  styles.findMissingChipText,
                  findMissingOnly && styles.findMissingChipTextActive,
                ]}
              >
                {findMissingOnly ? 'Show All' : `Missing ${missingCount}`}
              </Text>
            </TouchableOpacity>
          </View>

          {/* List */}
          <FlatList
            data={filteredStops}
            keyExtractor={(item) => item.stop.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor="#3b82f6"
                colors={['#3b82f6']}
              />
            }
            ListEmptyComponent={
              searchQuery.trim().length > 0 ? (
                <View style={styles.noSearchResults} testID="stops-search-no-results">
                  <Ionicons name="search-outline" size={32} color="#475569" />
                  <Text style={styles.noSearchTitle}>No matches</Text>
                  <Text style={styles.noSearchText}>
                    No stops match &ldquo;{searchQuery.trim()}&rdquo;
                  </Text>
                </View>
              ) : null
            }
          />

          {/* FAB */}
          <TouchableOpacity
            style={styles.fab}
            onPress={() => router.push('/add-stop')}
            activeOpacity={0.8}
          >
            <Ionicons name="add" size={28} color="#fff" />
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  // Auth-error banner — bright amber-red so it reads as "act on this".
  // Sits flush above the empty-state OR the list, never blocking the
  // user from continuing to use whatever cached stops they may have.
  authBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#b91c1c',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#7f1d1d',
  },
  authBannerTitle: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    marginBottom: 2,
  },
  authBannerText: {
    color: '#fee2e2',
    fontSize: 12,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f172a',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerStats: {
    flexDirection: 'row',
  },
  statBadge: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
    alignItems: 'center',
    minWidth: 60,
  },
  statBadgeSuccess: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  statNumber: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  statNumberSuccess: {
    color: '#10b981',
  },
  statLabel: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2,
  },
  importHeaderButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1e293b',
    justifyContent: 'center',
    alignItems: 'center',
  },
  swipeHint: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  swipeHintText: {
    color: '#64748b',
    fontSize: 12,
  },
  searchRow: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 6,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 42,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 14,
    paddingVertical: 0,
  },
  searchClearBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    marginLeft: 4,
  },
  noSearchResults: {
    alignItems: 'center',
    paddingTop: 48,
    paddingHorizontal: 24,
  },
  noSearchTitle: {
    color: '#cbd5e1',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 12,
  },
  noSearchText: {
    color: '#64748b',
    fontSize: 13,
    marginTop: 4,
    textAlign: 'center',
  },
  listContent: {
    padding: 16,
    paddingTop: 4,
    paddingBottom: 100,
  },
  stopCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  stopCardActive: {
    backgroundColor: '#334155',
    transform: [{ scale: 1.02 }],
    borderColor: '#3b82f6',
  },
  stopCardCompleted: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  // Compact layout applied on top of stopCardCompleted — gives the shrink
  // effect when the driver taps "Mark Delivered". Smaller padding, smaller
  // avatar, smaller font, no meta row = card height drops ~96→44 px.
  stopCardCompactCompleted: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 6,
  },
  stopNumberCompact: {
    width: 26,
    height: 26,
    borderRadius: 13,
    marginRight: 10,
  },
  stopNameCompact: {
    fontSize: 13,
    fontWeight: '500',
  },
  dragHandle: {
    padding: 4,
    marginRight: 8,
  },
  stopNumber: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  stopNumberText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
  stopInfo: {
    flex: 1,
  },
  stopNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  stopName: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  textCompleted: {
    color: '#64748b',
    textDecorationLine: 'line-through',
  },
  priorityTag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  priorityTagText: {
    fontSize: 10,
    fontWeight: '700',
  },
  loadedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderColor: 'rgba(16, 185, 129, 0.4)',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 6,
  },
  loadedChipText: {
    color: '#10b981',
    fontSize: 9,
    fontWeight: '800',
    marginLeft: 3,
    letterSpacing: 0.6,
  },
  findMissingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderColor: 'rgba(245, 158, 11, 0.4)',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginLeft: 8,
  },
  findMissingChipActive: {
    backgroundColor: '#f59e0b',
    borderColor: '#f59e0b',
  },
  findMissingChipMuted: { opacity: 0.4 },
  findMissingChipText: {
    color: '#f59e0b',
    fontSize: 12,
    fontWeight: '800',
    marginLeft: 5,
    letterSpacing: 0.4,
  },
  findMissingChipTextActive: { color: '#0f172a' },
  stopAddress: {
    color: '#94a3b8',
    fontSize: 13,
    marginBottom: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 10,
    rowGap: 4,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  metaItemNotes: {
    flex: 1,
    minWidth: 0,
  },
  metaText: {
    color: '#64748b',
    fontSize: 12,
  },
  chevron: {
    marginLeft: 8,
  },
  // Sharpie-marker chip — quiet slate pill that sits before the chevron.
  // Tabular nums + monospace-like spacing so 1 / 12 / 127 line up. Soft
  // border and subtly desaturated tone so it reads as "context info"
  // and never competes with the priority-coloured LEFT badge.
  sharpieChip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    marginLeft: 6,
  },
  sharpieChipHash: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '700',
    marginRight: 1,
  },
  sharpieChipNum: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.3,
  },
  swipeAction: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 90,
    marginBottom: 10,
    borderRadius: 16,
  },
  swipeComplete: {
    backgroundColor: '#10b981',
    marginRight: 8,
  },
  swipeDelete: {
    backgroundColor: '#ef4444',
    marginLeft: 8,
  },
  swipeButton: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  swipeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyIcon: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#1e293b',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  emptyTitle: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '700',
  },
  emptyText: {
    color: '#94a3b8',
    fontSize: 15,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 28,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#3b82f6',
    paddingHorizontal: 28,
    paddingVertical: 16,
    borderRadius: 14,
  },
  addButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  importButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'transparent',
    paddingHorizontal: 28,
    paddingVertical: 16,
    borderRadius: 14,
    marginTop: 12,
    borderWidth: 2,
    borderColor: '#3b82f6',
  },
  importButtonText: {
    color: '#3b82f6',
    fontSize: 17,
    fontWeight: '600',
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#3b82f6',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#3b82f6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
});
