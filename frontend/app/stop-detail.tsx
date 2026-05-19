import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Dimensions,
  Share,
  TextInput,
  ActivityIndicator,
  Keyboard,
  Animated,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useStopsStore, Stop } from '../src/store/stopsStore';
import { stopPinNumber } from '../src/utils/stopPinNumber';
import { stopDriveOrder } from '../src/utils/stopDriveOrder';
import { useDriveOrderFlash } from '../src/utils/useDriveOrderFlash';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function StopDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { stops, completeStop, uncompleteStop, deleteStop, setPendingNavTarget, updateStop } = useStopsStore();
  
  const stop = stops.find((s) => s.id === id);
  const stopIndex = stops.findIndex((s) => s.id === id);
  // Map-pin sprite uses `stop-${order}`, so the pin label = order + 1.
  // Shared helper keeps this detail view in lock-step with the bottom-sheet
  // badge, resume toast, and jump-menu — all driven off immutable DB `order`
  // rather than volatile array positions.
  // `stopNumber` (Sharpie / `original_sequence`) feeds the small RIGHT chip
  // and the navigation header — it's the box label, doesn't change after
  // re-optimise. `driveOrderNumber` (`sequence_number`) feeds the BIG
  // LEFT badge — the current drive position, *does* change on re-optimise.
  const stopNumber = stopPinNumber(stop);
  const driveOrderNumber = stopDriveOrder(stop);

  // Drive-order shift flash. When the route is re-optimised mid-detail-view
  // and THIS stop's `sequence_number` changes, the LEFT badge briefly
  // flashes amber — silent confirmation that "the route just shifted you
  // around" without a modal/toast. Sharpie chip is unaffected because
  // `original_sequence` doesn't change.
  const driveOrderFlashAnim = useDriveOrderFlash(driveOrderNumber);
  const flashedBadgeBg = driveOrderFlashAnim.interpolate({
    inputRange: [0, 1],
    // Idle: blue (or green when completed). Peak: amber. Completed badge
    // skips the flash entirely because the row's drive-order is meaningless
    // post-completion, but we still feed the interpolation a valid pair.
    outputRange: [stop?.completed ? '#10b981' : '#3b82f6', '#f59e0b'],
  });

  // Tracking number — locally controlled so the driver can edit and only
  // commit the change on Save (no PATCH-per-keystroke). Reset whenever the
  // underlying stop's tracking_number changes (e.g. import overwrite, or
  // van-scan barcode lookup populating it from a sibling-screen scan).
  const [trackingDraft, setTrackingDraft] = useState(stop?.tracking_number ?? '');
  const [savingTracking, setSavingTracking] = useState(false);
  React.useEffect(() => {
    setTrackingDraft(stop?.tracking_number ?? '');
  }, [stop?.tracking_number]);
  const trackingDirty = trackingDraft.trim() !== (stop?.tracking_number ?? '').trim();
  const handleSaveTracking = async () => {
    if (!stop || !trackingDirty) return;
    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSavingTracking(true);
    try {
      const trimmed = trackingDraft.trim();
      // Empty string clears the field. Backend StopUpdate accepts
      // `tracking_number: null` semantics by sending an empty string.
      await updateStop(stop.id, { tracking_number: trimmed || null });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      console.warn('[stop-detail] tracking save failed', e);
      Alert.alert('Save Failed', 'Could not save the tracking number. Please try again.');
    } finally {
      setSavingTracking(false);
    }
  };

  if (!stop) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.errorContainer}>
          <View style={styles.errorIcon}>
            <Ionicons name="alert-circle" size={48} color="#ef4444" />
          </View>
          <Text style={styles.errorText}>Stop not found</Text>
          <TouchableOpacity style={styles.errorButton} onPress={() => router.back()}>
            <Text style={styles.errorButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return '#ef4444';
      case 'low': return '#6b7280';
      default: return '#3b82f6';
    }
  };

  const getPriorityBgColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'rgba(239, 68, 68, 0.15)';
      case 'low': return 'rgba(107, 114, 128, 0.15)';
      default: return 'rgba(59, 130, 246, 0.15)';
    }
  };

  const handleComplete = async () => {
    Haptics.notificationAsync(
      stop.completed 
        ? Haptics.NotificationFeedbackType.Warning 
        : Haptics.NotificationFeedbackType.Success
    );
    if (stop.completed) {
      await uncompleteStop(stop.id);
    } else {
      await completeStop(stop.id);
    }
  };

  const handleOpenInMaps = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Hand-off to the map tab's in-app navigation cockpit. We DON'T launch
    // an external maps app — the whole point of this screen-class is that
    // navigation happens in-house (turn-by-turn, swipe-to-deliver,
    // service-time telemetry, geofence arrival). Setting the global
    // intent + popping back to the map tab is the cleanest cross-screen
    // hand-off: the map tab is already mounted (it's a tab) and watches
    // the intent via the stops-store subscription, so it fires the same
    // single-stop nav flow the on-map marker modal uses.
    setPendingNavTarget(stop.id);
    router.replace('/(tabs)');
  };

  const handleShare = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await Share.share({
        message: `📍 ${stop.name || 'Delivery Stop'}\n${stop.address}${stop.notes ? `\nNotes: ${stop.notes}` : ''}`,
        title: 'Share Stop Details',
      });
    } catch (error) {
      console.error('Share error:', error);
    }
  };

  const handleDelete = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Alert.alert(
      'Delete Stop',
      `Are you sure you want to delete "${stop.name || 'this stop'}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Delete', 
          style: 'destructive',
          onPress: async () => {
            await deleteStop(stop.id);
            router.back();
          }
        },
      ]
    );
  };

  const handleEdit = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({ pathname: '/edit-stop', params: { id: stop.id } });
  };

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity 
          style={styles.headerButton} 
          onPress={handleBack}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={24} color="#f8fafc" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Stop #{stopNumber}</Text>
        <TouchableOpacity 
          style={styles.headerButton} 
          onPress={handleEdit}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="create-outline" size={22} color="#3b82f6" />
        </TouchableOpacity>
      </View>

      <ScrollView 
        style={styles.content}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
      >
        {/* Main Card */}
        <View style={[styles.mainCard, stop.completed && styles.mainCardCompleted]}>
          {/* Status / Number Header — dual-badge layout:
              LEFT (large blue circle): the OPTIMISED drive order
                (`sequence_number`). Changes when the route is re-optimised.
                Briefly flashes amber when the value shifts mid-screen
                (driveOrderFlashAnim → backgroundColor interpolation).
              RIGHT (small slate chip): the Sharpie box label
                (`original_sequence`). Locked at first /routes/confirm.
              Both come from `Stop` on the wire — no derivation here. */}
          <View style={styles.cardHeader}>
            <Animated.View style={[styles.stopBadge, { backgroundColor: flashedBadgeBg }]}>
              {stop.completed ? (
                <Ionicons name="checkmark" size={24} color="#fff" />
              ) : (
                <Text style={styles.stopBadgeText}>{driveOrderNumber ?? '—'}</Text>
              )}
            </Animated.View>

            <View style={styles.statusBadges}>
              {/* Sharpie chip — hidden pre-confirm so the driver sees a
                  clean LEFT '—' nudging them to confirm. */}
              {!stop.completed && stopNumber != null && (
                <View style={styles.heroSharpieChip} data-testid="stop-detail-sharpie-chip">
                  <Text style={styles.heroSharpieHash}>#</Text>
                  <Text style={styles.heroSharpieNum}>{stopNumber}</Text>
                </View>
              )}
              {stop.completed && (
                <View style={styles.completedBadge}>
                  <Ionicons name="checkmark-circle" size={16} color="#10b981" />
                  <Text style={styles.completedBadgeText}>Completed</Text>
                </View>
              )}
            </View>
          </View>

          {/* Stop Name & Address */}
          <Text style={styles.stopName}>{stop.name || 'Unnamed Stop'}</Text>
          <Text style={styles.stopAddress}>{stop.address}</Text>

          {/* Quick Actions */}
          <View style={styles.quickActions}>
            <TouchableOpacity 
              style={styles.quickAction} 
              onPress={handleOpenInMaps}
              activeOpacity={0.7}
            >
              <View style={[styles.quickActionIcon, { backgroundColor: 'rgba(59, 130, 246, 0.15)' }]}>
                <Ionicons name="navigate" size={22} color="#3b82f6" />
              </View>
              <Text style={styles.quickActionText}>Navigate</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={styles.quickAction} 
              onPress={handleShare}
              activeOpacity={0.7}
            >
              <View style={[styles.quickActionIcon, { backgroundColor: 'rgba(139, 92, 246, 0.15)' }]}>
                <Ionicons name="share-outline" size={22} color="#8b5cf6" />
              </View>
              <Text style={styles.quickActionText}>Share</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={styles.quickAction} 
              onPress={handleComplete}
              activeOpacity={0.7}
            >
              <View style={[
                styles.quickActionIcon, 
                { backgroundColor: stop.completed ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)' }
              ]}>
                <Ionicons 
                  name={stop.completed ? "refresh" : "checkmark-circle"} 
                  size={22} 
                  color={stop.completed ? "#f59e0b" : "#10b981"} 
                />
              </View>
              <Text style={styles.quickActionText}>{stop.completed ? 'Undo' : 'Complete'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Details Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            <Ionicons name="information-circle" size={14} color="#64748b" /> DETAILS
          </Text>
          
          {/* Time Window */}
          {stop.time_window && (stop.time_window.start || stop.time_window.end) && (
            <View style={styles.detailCard}>
              <View style={[styles.detailIcon, { backgroundColor: 'rgba(245, 158, 11, 0.15)' }]}>
                <Ionicons name="time" size={20} color="#f59e0b" />
              </View>
              <View style={styles.detailContent}>
                <Text style={styles.detailLabel}>Time Window</Text>
                <Text style={styles.detailValue}>
                  {stop.time_window.start || 'Any time'} – {stop.time_window.end || 'Any time'}
                </Text>
              </View>
            </View>
          )}

          {/* Weight */}
          {stop.weight && (
            <View style={styles.detailCard}>
              <View style={[styles.detailIcon, { backgroundColor: 'rgba(139, 92, 246, 0.15)' }]}>
                <Ionicons name="scale" size={20} color="#8b5cf6" />
              </View>
              <View style={styles.detailContent}>
                <Text style={styles.detailLabel}>Package Weight</Text>
                <Text style={styles.detailValue}>{stop.weight} kg</Text>
              </View>
            </View>
          )}

          {/* Quantity */}
          {stop.quantity && (
            <View style={styles.detailCard}>
              <View style={[styles.detailIcon, { backgroundColor: 'rgba(236, 72, 153, 0.15)' }]}>
                <Ionicons name="cube" size={20} color="#ec4899" />
              </View>
              <View style={styles.detailContent}>
                <Text style={styles.detailLabel}>Items Count</Text>
                <Text style={styles.detailValue}>{stop.quantity} items</Text>
              </View>
            </View>
          )}

          {/* Coordinates */}
          <View style={styles.detailCard}>
            <View style={[styles.detailIcon, { backgroundColor: 'rgba(16, 185, 129, 0.15)' }]}>
              <Ionicons name="location" size={20} color="#10b981" />
            </View>
            <View style={styles.detailContent}>
              <Text style={styles.detailLabel}>GPS Coordinates</Text>
              <Text style={styles.detailValue}>
                {stop.latitude.toFixed(6)}, {stop.longitude.toFixed(6)}
              </Text>
            </View>
          </View>
        </View>

        {/* Tracking Number — manually editable. Drivers can attach a
            tracking ID to a stop whose import didn't carry one (or whose
            label scanner didn't fire). The van-scan barcode lookup will
            pick this value up on the next pass — same field that the
            CSV/XLS importer writes into. Empty = clear. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            <Ionicons name="barcode-outline" size={14} color="#64748b" /> TRACKING NUMBER
          </Text>
          <View style={styles.trackingCard}>
            <TextInput
              style={styles.trackingInput}
              value={trackingDraft}
              onChangeText={setTrackingDraft}
              placeholder="Enter tracking / barcode number"
              placeholderTextColor="#94a3b8"
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              returnKeyType="done"
              onSubmitEditing={handleSaveTracking}
              editable={!savingTracking}
              testID="stop-detail-tracking-input"
            />
            {/* "Scan to attach" shortcut — opens the existing van-scan
                screen in single-shot mode (`?attachToStopId=<id>`). The
                first valid barcode read writes directly into THIS stop's
                tracking_number and pops back; no continuous scanning, no
                van-load workflow. Useful when a parcel arrives mid-route
                and the driver wants to attach it to the right stop
                without going back to the van-loading screen. */}
            <TouchableOpacity
              style={styles.trackingScanBtn}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push(`/van-scan?attachToStopId=${encodeURIComponent(stop.id)}`);
              }}
              disabled={savingTracking}
              testID="stop-detail-tracking-scan"
              accessibilityRole="button"
              accessibilityLabel="Scan barcode to attach to this stop"
            >
              <Ionicons name="scan-outline" size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.trackingSaveBtn,
                (!trackingDirty || savingTracking) && styles.trackingSaveBtnDisabled,
              ]}
              onPress={handleSaveTracking}
              disabled={!trackingDirty || savingTracking}
              testID="stop-detail-tracking-save"
            >
              {savingTracking ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark" size={18} color="#fff" />
                  <Text style={styles.trackingSaveText}>Save</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Notes Section */}
        {stop.notes && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              <Ionicons name="document-text" size={14} color="#64748b" /> DELIVERY NOTES
            </Text>
            <View style={styles.notesCard}>
              <Text style={styles.notesText}>{stop.notes}</Text>
            </View>
          </View>
        )}

        {/* Delete Button */}
        <TouchableOpacity 
          style={styles.deleteButton} 
          onPress={handleDelete}
          activeOpacity={0.7}
        >
          <Ionicons name="trash-outline" size={20} color="#ef4444" />
          <Text style={styles.deleteText}>Delete Stop</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Bottom Action Bar */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity 
          style={[styles.bottomButton, stop.completed && styles.bottomButtonSecondary]}
          onPress={handleComplete}
          activeOpacity={0.8}
        >
          <Ionicons 
            name={stop.completed ? "refresh" : "checkmark-circle"} 
            size={22} 
            color="#fff" 
          />
          <Text style={styles.bottomButtonText}>
            {stop.completed ? 'Mark as Incomplete' : 'Mark as Complete'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 22,
    backgroundColor: '#1e293b',
  },
  headerTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  mainCard: {
    backgroundColor: '#1e293b',
    borderRadius: 20,
    padding: 20,
    marginBottom: 24,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  mainCardCompleted: {
    borderColor: '#10b981',
    backgroundColor: 'rgba(16, 185, 129, 0.05)',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  stopBadge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Sharpie chip (hero) — sits in the right cluster of the cardHeader
  // alongside the Completed badge, lets the driver see "drive #5 / box
  // #127" at a glance. Distinct slate fill keeps it clearly subordinate
  // to the bright LEFT optimised badge.
  heroSharpieChip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  heroSharpieHash: {
    color: '#64748b',
    fontSize: 13,
    fontWeight: '700',
    marginRight: 2,
  },
  heroSharpieNum: {
    color: '#cbd5e1',
    fontSize: 17,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.4,
  },
  stopBadgeText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
  },
  statusBadges: {
    flexDirection: 'row',
  },
  completedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  completedBadgeText: {
    color: '#10b981',
    fontSize: 13,
    fontWeight: '600',
  },
  priorityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  priorityBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  stopName: {
    color: '#f8fafc',
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 8,
  },
  stopAddress: {
    color: '#94a3b8',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 20,
  },
  quickActions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 16,
  },
  quickAction: {
    alignItems: 'center',
    minWidth: 80,
  },
  quickActionIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickActionText: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '500',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  detailCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
  },
  detailIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  detailContent: {
    flex: 1,
  },
  detailLabel: {
    color: '#64748b',
    fontSize: 12,
    marginBottom: 4,
  },
  detailValue: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '600',
  },
  // Tracking number editor — sits above Notes. Match the notesCard
  // visual language (dark slate panel, soft border) so it reads as part
  // of the same content stack, not a separate alert/card.
  trackingCard: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  trackingInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '600',
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  trackingSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
  },
  // Square camera-icon button — matches Save's height so the row stays
  // visually balanced. Distinct slate colour so it doesn't compete with
  // the primary Save action; the icon alone communicates "scan".
  trackingScanBtn: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#475569',
    borderRadius: 10,
  },
  trackingSaveBtnDisabled: {
    backgroundColor: '#334155',
    opacity: 0.7,
  },
  trackingSaveText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },

  notesCard: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 18,
    borderLeftWidth: 4,
    borderLeftColor: '#3b82f6',
  },
  notesText: {
    color: '#e2e8f0',
    fontSize: 15,
    lineHeight: 24,
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    paddingVertical: 16,
    borderRadius: 16,
    marginTop: 8,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  deleteText: {
    color: '#ef4444',
    fontSize: 16,
    fontWeight: '600',
  },
  bottomBar: {
    paddingHorizontal: 16,
    paddingTop: 16,
    backgroundColor: '#0f172a',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  bottomButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#10b981',
    paddingVertical: 18,
    borderRadius: 16,
  },
  bottomButtonSecondary: {
    backgroundColor: '#f59e0b',
  },
  bottomButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  errorIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  errorText: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 20,
  },
  errorButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
  },
  errorButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
