import React, { useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, Animated, PanResponder, Modal, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { Stop } from '../../store/stopsStore';
import { ViewMode } from '../../types/route';
import { formatDistance, getManeuverIcon, getGeocodeMetadataEntries } from '../../utils/route';
import { stopPinNumber } from '../../utils/stopPinNumber';
// SwipeToDeliver retired on 2026-05-11 per driver request — see comment
// in the Main Actions row below for the rationale and how to restore.
// Component file `./SwipeToDeliver.tsx` is intentionally kept on disk
// so a future revert is a single import line + JSX swap.

interface NavigationPanelProps {
  viewMode: ViewMode;
  immersiveMode: boolean;
  setImmersiveMode: (mode: boolean) => void;
  currentStep: any;
  currentLeg: any;
  stops: Stop[];
  currentLegIndex: number;
  showNotesPreview: boolean;
  setShowNotesPreview: (show: boolean) => void;
  isVoiceEnabled: boolean;
  setIsVoiceEnabled: (enabled: boolean) => void;
  currentMapStyle: string;
  cycleMapStyle: () => void;
  speedKmh: number;
  distanceToNextStop: string;
  etaToNextStop: string;
  routeStats: { distance: number; duration: number } | null;
  completedCount: number;
  insets: { top: number; bottom: number };
  isRerouting: boolean;
  canUndo: boolean;
  liveRoute: any;

  onStopNavigation: () => void;
  onMarkDelivered: () => void;
  onMarkFailed: () => void;
  onSkipStop: () => void;
  onUndoStop: () => void;
  onReroute: () => void;
  onShowRouteOverview: () => void;
  onOpenSidebar: () => void;
  onShareETA: () => void;
  onCallCustomer: () => void;
  getSuburbColor: (suburb?: string) => string;
  /** Called when the driver swipes the stop card LEFT — move to the next stop
      (card index + 1) without altering its completion state. */
  onPreviewNextStop?: () => void;
  /** Called when the driver swipes the stop card RIGHT — move to the previous
      stop (card index − 1) without altering its completion state. */
  onPreviewPrevStop?: () => void;
  /** Whether a next/prev stop exists — used to disable the swipe rubber-band
      at the ends of the route. */
  canPreviewNext?: boolean;
  canPreviewPrev?: boolean;
  /** Full list of legs from the navigation data. Used to render the
      long-press "jump to stop" menu. When omitted, the feature is disabled. */
  legs?: any[];
  /** Jump directly to stop index `i` without altering its completion state.
      Same contract as onPreviewNextStop but takes an explicit target. */
  onJumpToStop?: (index: number) => void;
}

export const NavigationPanel: React.FC<NavigationPanelProps> = ({
  immersiveMode,
  setImmersiveMode,
  currentStep,
  currentLeg,
  stops,
  currentLegIndex,
  isVoiceEnabled,
  setIsVoiceEnabled,
  currentMapStyle,
  cycleMapStyle,
  speedKmh,
  etaToNextStop,
  insets,
  isRerouting,
  canUndo,
  liveRoute,

  onStopNavigation,
  onMarkDelivered,
  onMarkFailed,
  onSkipStop,
  onUndoStop,
  onReroute,
  onShowRouteOverview,
  onOpenSidebar,
  onShareETA,
  onCallCustomer,
  onPreviewNextStop,
  onPreviewPrevStop,
  canPreviewNext = true,
  canPreviewPrev = true,
  legs,
  onJumpToStop,
}) => {
  // Long-press-to-jump menu — opened by holding the big stop-number badge.
  // Gives drivers a way to teleport to any stop without swiping through each one.
  const [isJumpOpen, setIsJumpOpen] = useState(false);
  const openJumpMenu = () => {
    if (!legs || legs.length <= 1 || !onJumpToStop) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsJumpOpen(true);
  };
  const handleJump = (idx: number) => {
    setIsJumpOpen(false);
    if (onJumpToStop && idx !== currentLegIndex) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onJumpToStop(idx);
    }
  };
  const realStops = (stops as any[]).filter((s: any) => !s.is_current_location);
  const totalStops = realStops.length || stops.length;
  // Bottom-sheet badge must match the map-pin sprite (`stop-${order}`).
  // Uses shared helper so this never drifts out of alignment with toast /
  // resume overlay / stop-detail views.
  const currentStop = currentLeg?.to_stop;
  // Locked Sharpie badge first, then backend planning order. NEVER falls back
  // to the array index — those reshuffle on re-optimise and the badge must
  // stay welded to the physical box. Returns null when the stop has no
  // numeric identity (rare; pre-hydration only).
  const currentStopNumber = stopPinNumber(currentStop);
  const geocodeMetaEntries = useMemo(
    () => getGeocodeMetadataEntries(currentLeg?.to_stop?.geocode_metadata),
    [currentLeg?.to_stop?.geocode_metadata]
  );

  // Identify all stops sharing the same coordinates as the current stop so
  // we can show drivers when they're about to deliver one of several parcels
  // at the same address. Previously we showed just a small `x2` badge which
  // drivers kept missing — they'd deliver one parcel and drive off leaving
  // the others behind. This memo returns the whole group in route order and
  // the current parcel's position + progress so the UI can render a loud
  // "MULTIPLE PARCELS AT THIS ADDRESS · Parcel 2 of 3" banner.
  const colocatedInfo = useMemo(() => {
    const cur = currentLeg?.to_stop;
    if (!cur) return { count: 1, index: 1, doneCount: 0, group: [] as any[] };
    const key = `${Number(cur.latitude).toFixed(5)},${Number(cur.longitude).toFixed(5)}`;
    const group = realStops.filter(
      (s: any) =>
        `${Number(s.latitude).toFixed(5)},${Number(s.longitude).toFixed(5)}` === key
    );
    const index = Math.max(1, group.findIndex((s: any) => s.id === cur.id) + 1);
    const doneCount = group.filter((s: any) => s.completed).length;
    return { count: group.length || 1, index, doneCount, group };
  }, [currentLeg?.to_stop, realStops]);
  const colocatedCount = colocatedInfo.count;

  // ── Horizontal swipe between stops (preview-only, no completion side-effects)
  //
  // UX:
  //   swipe LEFT  → onPreviewNextStop (advance card to next stop)
  //   swipe RIGHT → onPreviewPrevStop (go back to previous stop)
  //
  // We deliberately do NOT mark the current stop delivered/failed — the driver
  // keeps full control of its status via the dedicated buttons. This gesture
  // only changes WHICH card is on screen so the driver can peek at upcoming
  // or previous stops without losing their place.
  //
  // Implementation notes:
  //   • Uses PanResponder (no extra lib) so it works in Expo Go + EAS builds.
  //   • `moveX > moveY * 1.4` gate prevents hijacking vertical scrolls on the
  //     notes or scroll list inside the card.
  //   • Threshold = 70 px OR flick velocity > 0.4 — matches platform feel.
  //   • Rubber-bands resistance at ends of the route (no previous/next stop).
  //   • Light haptic fires on commit; medium haptic if swipe hits end.
  const swipeX = useRef(new Animated.Value(0)).current;
  const swipeResponder = useMemo(
    () => PanResponder.create({
      // Threshold = 20 px (was 8). 8 px hijacked taps in a moving vehicle —
      // any finger jitter ≥ 8 px during a tap-release made the PanResponder
      // claim the gesture, so the Delivered / Failed / Skip TouchableOpacity
      // children below never fired their onPress. 20 px sits above typical
      // finger jitter / road-vibration drift but well below Android's tap
      // slop (~24 px), so a deliberate horizontal drag still works while a
      // jittery tap reaches the inner buttons. We also require a minimum
      // ratio of horizontal-vs-vertical motion (1.4x) so vertical scroll
      // gestures never get confused for a stop-swipe.
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4,
      onPanResponderMove: (_e, g) => {
        // Rubber-band at the edges: damp the drag to 40% when no sibling stop.
        const atEdge =
          (g.dx > 0 && !canPreviewPrev) || (g.dx < 0 && !canPreviewNext);
        swipeX.setValue(atEdge ? g.dx * 0.4 : g.dx);
      },
      onPanResponderRelease: (_e, g) => {
        const fastFlick = Math.abs(g.vx) > 0.4 && Math.abs(g.dx) > 20;
        const farDrag = Math.abs(g.dx) > 70;
        const committed = fastFlick || farDrag;
        if (committed && g.dx < 0 && canPreviewNext && onPreviewNextStop) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          // Animate card out to the left, swap content while off-screen,
          // then slide in from the right. The previous version snapped
          // swipeX to 0 BEFORE swapping content, which caused the panel to
          // momentarily render the OLD stop's content at x=0 + opacity 1
          // for one frame (visible as a "flick" — much more obvious with
          // the now semi-transparent panel that lets the map show through).
          Animated.timing(swipeX, { toValue: -500, duration: 160, useNativeDriver: true })
            .start(() => {
              onPreviewNextStop();          // 1) swap content while hidden
              swipeX.setValue(500);          // 2) place off-screen RIGHT
              Animated.timing(swipeX, { toValue: 0, duration: 160, useNativeDriver: true }).start();
            });
          return;
        }
        if (committed && g.dx > 0 && canPreviewPrev && onPreviewPrevStop) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          Animated.timing(swipeX, { toValue: 500, duration: 160, useNativeDriver: true })
            .start(() => {
              onPreviewPrevStop();           // swap content while hidden
              swipeX.setValue(-500);          // place off-screen LEFT
              Animated.timing(swipeX, { toValue: 0, duration: 160, useNativeDriver: true }).start();
            });
          return;
        }
        if (committed) {
          // Tried to swipe past the first/last stop — warning haptic.
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
        // Spring back to resting position.
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
    [swipeX, canPreviewNext, canPreviewPrev, onPreviewNextStop, onPreviewPrevStop],
  );

  // Subtle opacity fade at the extremes of the drag — signals the swipe is active.
  const swipeOpacity = swipeX.interpolate({
    inputRange: [-200, 0, 200],
    outputRange: [0.6, 1, 0.6],
    extrapolate: 'clamp',
  });

  return (
    <>
      {/* Minimal Floating Turn Instruction - Tap map to toggle full UI */}
      <TouchableOpacity 
        style={[styles.immersiveTurnBanner, { top: insets.top + 8 }]}
        onPress={() => setImmersiveMode(!immersiveMode)}
        activeOpacity={0.9}
      >
        <View style={styles.immersiveTurnRow}>
          <View style={styles.immersiveTurnIconBox}>
            <Ionicons 
              name={currentStep ? getManeuverIcon(currentStep.type, currentStep.modifier) as any : 'arrow-up'} 
              size={28} 
              color="#fff" 
            />
          </View>
          <View style={styles.immersiveTurnDetails}>
            <Text style={styles.immersiveTurnDist}>
              {currentStep?.distance ? formatDistance(currentStep.distance) : '--'}
            </Text>
            <Text style={styles.immersiveTurnText} numberOfLines={1}>
              {currentStep?.instruction || 'Continue'}
            </Text>
          </View>
        </View>
        <TouchableOpacity style={styles.immersiveExitBtn} onPress={onStopNavigation}>
          <Ionicons name="close" size={22} color="#ef4444" />
        </TouchableOpacity>
      </TouchableOpacity>

      {/* Floating Speed Display - Always visible */}
      <View style={[styles.immersiveSpeedDisplay, { top: insets.top + 80 }]}>
        <Text style={styles.immersiveSpeedValue}>{speedKmh}</Text>
        <Text style={styles.immersiveSpeedUnit}>km/h</Text>
      </View>

      {/* Compact Stats Row - Always visible */}
      <View style={[styles.immersiveStatsRow, { top: insets.top + 80 }]}>
        <View style={styles.immersiveStatChip}>
          <Ionicons name="time-outline" size={14} color="#10b981" />
          <Text style={styles.immersiveStatText}>{etaToNextStop}</Text>
        </View>
        <View style={styles.immersiveStatChip}>
          <Ionicons name="navigate-outline" size={14} color="#3b82f6" />
          <Text style={styles.immersiveStatText}>
            {liveRoute ? formatDistance(liveRoute.distance) : '--'}
          </Text>
        </View>
      </View>

      {/* Expandable Bottom Panel - Tap to expand */}
      {!immersiveMode ? (
        <Animated.View
          style={[
            styles.immersiveBottomFull,
            { paddingBottom: insets.bottom + 8 },
            { transform: [{ translateX: swipeX }], opacity: swipeOpacity },
          ]}
          {...swipeResponder.panHandlers}
          testID="nav-stop-card"
        >
          {/* Swipe hint chevrons — fade in when the driver starts dragging,
              so the gesture is discoverable without taking screen real-estate
              at rest. */}
          {canPreviewPrev && (
            <Animated.View
              style={[
                styles.swipeHintLeft,
                { opacity: swipeX.interpolate({ inputRange: [0, 60], outputRange: [0, 1], extrapolate: 'clamp' }) },
              ]}
              pointerEvents="none"
            >
              <Ionicons name="chevron-back" size={22} color="#60a5fa" />
            </Animated.View>
          )}
          {canPreviewNext && (
            <Animated.View
              style={[
                styles.swipeHintRight,
                { opacity: swipeX.interpolate({ inputRange: [-60, 0], outputRange: [1, 0], extrapolate: 'clamp' }) },
              ]}
              pointerEvents="none"
            >
              <Ionicons name="chevron-forward" size={22} color="#60a5fa" />
            </Animated.View>
          )}
          {/* Multi-parcel warning — impossible to miss.
              Shown whenever the current stop shares its coordinates with one
              or more other stops on the route. Drivers were previously relying
              on the tiny `x2` badge and missing the fact that more than one
              delivery was parked at the same doorstep. This loud amber banner
              surfaces the parcel index, weight, a shortened stop ID for
              disambiguation, and a progress-dot row showing which parcels at
              this address are already delivered. */}
          {colocatedCount > 1 && currentLeg?.to_stop && (
            <View style={styles.colocatedWarn} data-testid="nav-colocated-warn">
              <View style={styles.colocatedWarnHeader}>
                <Ionicons name="warning" size={16} color="#7c2d12" />
                <Text style={styles.colocatedWarnTitle}>
                  MULTIPLE PARCELS AT THIS ADDRESS
                </Text>
              </View>
              <View style={styles.colocatedWarnBody}>
                <Text style={styles.colocatedWarnLine}>
                  Parcel <Text style={styles.colocatedWarnBold}>{colocatedInfo.index}</Text> of{' '}
                  <Text style={styles.colocatedWarnBold}>{colocatedCount}</Text>
                  {currentLeg.to_stop.weight ? `  ·  ${currentLeg.to_stop.weight} kg` : ''}
                  {currentLeg.to_stop.id ? `  ·  #${String(currentLeg.to_stop.id).slice(0, 6)}` : ''}
                </Text>
                <View style={styles.colocatedDotsRow}>
                  {colocatedInfo.group.map((s: any, i: number) => {
                    const isCurrent = s.id === currentLeg.to_stop.id;
                    const done = !!s.completed;
                    return (
                      <View
                        key={s.id || i}
                        style={[
                          styles.colocatedDot,
                          done && styles.colocatedDotDone,
                          isCurrent && styles.colocatedDotCurrent,
                        ]}
                      />
                    );
                  })}
                </View>
              </View>
            </View>
          )}
          {/* Stop Info */}
          <View style={styles.immersiveStopRow}>
            <Pressable
              onLongPress={openJumpMenu}
              delayLongPress={400}
              style={styles.immersiveStopBadge}
              testID="nav-stop-badge"
            >
              <Text style={styles.immersiveStopNum}>{currentStopNumber}</Text>
              <Text style={styles.immersiveStopOf}>/{totalStops}</Text>
            </Pressable>
            {colocatedCount > 1 && (
              <View style={styles.navMultiplierBadge} data-testid="nav-multiplier-badge">
                <Text style={styles.navMultiplierText}>x{colocatedCount}</Text>
              </View>
            )}
            <View style={styles.immersiveStopInfo}>
              <Text style={styles.immersiveStopName} numberOfLines={1}>
                {currentLeg?.to_stop?.name || currentLeg?.to_stop?.address?.split(',')[0] || 'Next Stop'}
              </Text>
              <Text style={styles.immersiveStopAddress} numberOfLines={1}>
                {currentLeg?.to_stop?.address || ''}
              </Text>
            </View>
            <TouchableOpacity 
              style={styles.immersiveVoiceBtn}
              onPress={onShowRouteOverview}
              testID="immersive-route-overview-toggle"
            >
              <Ionicons
                name="locate"
                size={20}
                color="#3b82f6"
              />
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.immersiveVoiceBtn}
              onPress={() => setIsVoiceEnabled(!isVoiceEnabled)}
              testID="immersive-voice-toggle"
            >
              <Ionicons 
                name={isVoiceEnabled ? "volume-high" : "volume-mute"} 
                size={20} 
                color={isVoiceEnabled ? "#3b82f6" : "#64748b"} 
              />
            </TouchableOpacity>
          </View>

          {/* Weight & Quantity Info */}
          <View style={styles.immersiveDetailsRow}>
            {currentLeg?.to_stop?.weight ? (
              <View style={styles.immersiveDetailChip}>
                <Ionicons name="cube-outline" size={14} color="#f59e0b" />
                <Text style={styles.immersiveDetailText}>{currentLeg.to_stop.weight} kg</Text>
              </View>
            ) : null}
            {currentLeg?.to_stop?.quantity ? (
              <View style={styles.immersiveDetailChip}>
                <Ionicons name="layers-outline" size={14} color="#8b5cf6" />
                <Text style={styles.immersiveDetailText}>x{currentLeg.to_stop.quantity}</Text>
              </View>
            ) : null}
          </View>

          {/* Notes - Full width, outside the chips row */}
          {currentLeg?.to_stop?.notes ? (
            <View style={styles.immersiveNotesBox}>
              <Ionicons name="document-text-outline" size={14} color="#94a3b8" style={{ marginTop: 2 }} />
              <Text style={styles.immersiveNotesText}>{currentLeg.to_stop.notes}</Text>
            </View>
          ) : null}

          {/* Quick Actions — 4 buttons with labels for clarity */}
          <View style={styles.immersiveQuickRow}>
            <TouchableOpacity style={styles.immersiveQuickBtn} onPress={onCallCustomer} testID="nav-quick-call">
              <Ionicons name="call" size={18} color="#10b981" />
              <Text style={styles.immersiveQuickLabel}>Call</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.immersiveQuickBtn} onPress={onShareETA} testID="nav-quick-share">
              <Ionicons name="share-outline" size={18} color="#3b82f6" />
              <Text style={styles.immersiveQuickLabel}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.immersiveQuickBtn}
              onPress={onReroute}
              disabled={isRerouting}
              testID="nav-quick-reroute"
            >
              {isRerouting ? (
                <ActivityIndicator size="small" color="#f59e0b" />
              ) : (
                <Ionicons name="refresh" size={18} color="#f59e0b" />
              )}
              <Text style={styles.immersiveQuickLabel}>Reroute</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.immersiveQuickBtn, !canUndo && { opacity: 0.4 }]}
              onPress={onUndoStop}
              disabled={!canUndo}
              testID="nav-quick-undo"
            >
              <Ionicons name="arrow-undo" size={18} color="#8b5cf6" />
              <Text style={styles.immersiveQuickLabel}>Undo</Text>
            </TouchableOpacity>
          </View>

          {/* Main Actions — Failed | Delivered | Skip
              2026-05-11 — Reverted from slide-to-deliver back to a plain
              tap button per driver feedback. The slide had two intended
              benefits (anti-accidental-fire + service-time telemetry
              signal from the ~500 ms gesture) but in practice drivers
              found the friction painful at the end of a long shift.
              Mitigations now:
                • The button is a TouchableOpacity with `activeOpacity`
                  and a `Haptics.impactAsync('Heavy')` on press so the
                  driver still gets tactile confirmation of the fire.
                • The `SwipeToDeliver` component is preserved at
                  `./SwipeToDeliver` — to swap back, restore the import
                  and replace the TouchableOpacity below with the
                  SwipeToDeliver block from git history (commit before
                  this revert).
              `key={currentStop?.id}` retained on the row so any state
              the panel holds resets cleanly on stop change. */}
          <View style={styles.immersiveMainActions}>
            <TouchableOpacity style={styles.immersiveFailedBtn} onPress={onMarkFailed} testID="nav-main-failed">
              <Ionicons name="close" size={22} color="#ef4444" />
              <Text style={styles.immersiveSideBtnLabel}>Failed</Text>
            </TouchableOpacity>

            <TouchableOpacity
              key={currentStop?.id ?? 'no-stop'}
              style={styles.immersiveDeliveredBtn}
              activeOpacity={0.85}
              onPress={() => {
                try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {}
                console.log('[deliver-btn:onPress] invoking onMarkDelivered');
                onMarkDelivered();
              }}
              testID="nav-main-delivered"
            >
              <Ionicons name="checkmark" size={26} color="#10b981" />
              <Text style={styles.immersiveDeliveredBtnLabel}>Delivered</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.immersiveSkipBtn} onPress={onSkipStop} testID="nav-main-skip">
              <Ionicons name="play-skip-forward" size={22} color="#f59e0b" />
              <Text style={styles.immersiveSideBtnLabel}>Skip</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      ) : (
        /* Persistent Waypoint Overlay - Compact destination info */
        <Animated.View
          style={[
            styles.immersiveBottomMinimal,
            { paddingBottom: insets.bottom + 8 },
            { transform: [{ translateX: swipeX }], opacity: swipeOpacity },
          ]}
          {...swipeResponder.panHandlers}
          testID="immersive-bottom-minimal"
        >
          <TouchableOpacity 
            style={styles.immersiveMinimalInfoExpanded}
            onPress={() => setImmersiveMode(false)}
            activeOpacity={0.8}
            testID="immersive-expand-button"
          >
            <View style={styles.immersiveMinimalBadge}>
              <Pressable
                onLongPress={openJumpMenu}
                delayLongPress={400}
                style={StyleSheet.absoluteFill}
                testID="nav-stop-badge-minimal"
              />
              <Text style={styles.immersiveMinimalBadgeText}>{currentStopNumber}</Text>
            </View>
            {colocatedCount > 1 && (
              <View style={styles.navMultiplierBadgeSmall} data-testid="nav-multiplier-badge-minimal">
                <Text style={styles.navMultiplierTextSmall}>{colocatedInfo.index}/{colocatedCount}</Text>
              </View>
            )}
            <View style={styles.immersiveMinimalDetails}>
              <Text style={styles.immersiveMinimalName} numberOfLines={1} testID="immersive-waypoint-name">
                {currentLeg?.to_stop?.name || currentLeg?.to_stop?.address?.split(',')[0] || 'Next Stop'}
              </Text>
              <Text style={styles.immersiveMinimalAddress} numberOfLines={1} testID="immersive-waypoint-address">
                {currentLeg?.to_stop?.address || `Stop ${currentStopNumber} of ${totalStops}`}
              </Text>
            </View>
            <Ionicons name="chevron-up" size={16} color="#64748b" />
          </TouchableOpacity>

          <View style={styles.immersiveMinimalActions}>
            <Pressable
              style={({ pressed }) => [
                styles.immersiveMinimalDelivered,
                styles.deliveredHardenedHitbox,
                pressed && styles.deliveredPressed,
              ]}
              onPressIn={() => console.log('[deliver-btn:onPressIn] minimal')}
              onPress={() => {
                console.log('[deliver-btn:onPress] minimal → invoking onMarkDelivered');
                onMarkDelivered();
              }}
              // CRITICAL: this button sits inside the parent Animated.View whose
              // PanResponder owns left/right stop-swipe gestures. Capturing the
              // responder on touch-start is the only reliable way to keep that
              // PanResponder from claiming a tap mid-press.
              onStartShouldSetResponderCapture={() => true}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              pointerEvents="auto"
              testID="immersive-delivered-button"
              accessibilityRole="button"
              accessibilityLabel="Mark stop as delivered"
            >
              <Ionicons name="checkmark" size={26} color="#fff" />
            </Pressable>
          </View>
        </Animated.View>
      )}

      {/* Jump-to-stop menu — opened by long-pressing the stop-number badge.
          Renders every leg as a tappable row showing stop #, name/address, and
          a small badge if it is already completed. Tapping a row calls
          onJumpToStop(idx) on the parent (pure navigation; no side effects). */}
      <Modal
        visible={isJumpOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsJumpOpen(false)}
      >
        <Pressable
          style={styles.jumpMenuBackdrop}
          onPress={() => setIsJumpOpen(false)}
          testID="jump-menu-backdrop"
        >
          <Pressable style={styles.jumpMenuCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.jumpMenuHeader}>
              <Text style={styles.jumpMenuTitle}>Jump to stop</Text>
              <TouchableOpacity onPress={() => setIsJumpOpen(false)} hitSlop={12}>
                <Ionicons name="close" size={22} color="#9ca3af" />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 360 }}>
              {(legs || []).map((lg: any, idx: number) => {
                const s = lg?.to_stop;
                if (!s) return null;
                const isCurrent = idx === currentLegIndex;
                const isDone = !!s.completed || s.delivery_status === 'delivered';
                const isFailed = s.delivery_status === 'failed';
                return (
                  <TouchableOpacity
                    key={`${s.id || idx}-${idx}`}
                    style={[styles.jumpMenuRow, isCurrent && styles.jumpMenuRowCurrent]}
                    onPress={() => handleJump(idx)}
                    testID={`jump-menu-row-${idx}`}
                  >
                    <View style={[
                      styles.jumpMenuNum,
                      isDone && styles.jumpMenuNumDone,
                      isFailed && styles.jumpMenuNumFailed,
                      isCurrent && styles.jumpMenuNumCurrent,
                    ]}>
                      <Text style={styles.jumpMenuNumText}>{stopPinNumber(s) ?? '—'}</Text>
                    </View>
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={styles.jumpMenuName} numberOfLines={1}>
                        {s.name || s.address || 'Unnamed stop'}
                      </Text>
                      {!!s.address && !!s.name && (
                        <Text style={styles.jumpMenuAddress} numberOfLines={1}>{s.address}</Text>
                      )}
                    </View>
                    {isDone && <Ionicons name="checkmark-circle" size={18} color="#22c55e" />}
                    {isFailed && <Ionicons name="close-circle" size={18} color="#ef4444" />}
                    {isCurrent && !isDone && !isFailed && (
                      <Ionicons name="radio-button-on" size={18} color="#3b82f6" />
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
};

// Styles are imported from the parent - these are placeholders that reference the same style names
// The actual styles are defined in index.tsx's StyleSheet and passed via the component hierarchy
const styles = StyleSheet.create({
  immersiveTurnBanner: { position: 'absolute', left: 16, right: 16, backgroundColor: '#1e293b', borderRadius: 16, padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 100, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 8 },
  immersiveTurnRow: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  immersiveTurnIconBox: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#3b82f6', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  immersiveTurnDetails: { flex: 1 },
  immersiveTurnDist: { fontSize: 18, fontWeight: '700', color: '#fff' },
  immersiveTurnText: { fontSize: 13, color: '#94a3b8', marginTop: 2 },
  immersiveExitBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(239, 68, 68, 0.15)', justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
  immersiveSpeedDisplay: { position: 'absolute', right: 16, backgroundColor: '#1e293b', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, alignItems: 'center', zIndex: 99, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  immersiveSpeedValue: { fontSize: 22, fontWeight: '800', color: '#fff' },
  immersiveSpeedUnit: { fontSize: 10, color: '#64748b', marginTop: -2 },
  immersiveStatsRow: { position: 'absolute', left: 16, flexDirection: 'row', gap: 8, zIndex: 99 },
  immersiveStatChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(30, 41, 59, 0.9)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  immersiveStatText: { fontSize: 12, color: '#e2e8f0', fontWeight: '600' },
  immersiveBottomFull: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(30, 41, 59, 0.78)', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 14, zIndex: 100 },
  immersiveStopRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  immersiveStopBadge: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#3b82f6', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  immersiveStopNum: { fontSize: 18, fontWeight: '800', color: '#fff' },
  immersiveStopOf: { fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: -4 },
  immersiveStopInfo: { flex: 1 },
  immersiveStopName: { fontSize: 16, fontWeight: '700', color: '#fff' },
  immersiveStopAddress: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
  immersiveVoiceBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', alignItems: 'center', marginLeft: 6 },
  immersiveDetailsRow: { flexDirection: 'row', gap: 8, marginBottom: 10, flexWrap: 'wrap' },
  immersiveDetailChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  immersiveDetailText: { fontSize: 12, color: '#cbd5e1' },
  immersiveNotesBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, marginBottom: 10 },
  immersiveNotesText: { fontSize: 13, color: '#e2e8f0', lineHeight: 18, flex: 1 },
  immersiveMetaBox: { backgroundColor: 'rgba(15, 23, 42, 0.45)', borderWidth: 1, borderColor: 'rgba(96, 165, 250, 0.25)', borderRadius: 10, padding: 10, marginBottom: 12 },
  immersiveMetaHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  immersiveMetaTitle: { color: '#bfdbfe', fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  immersiveMetaList: { maxHeight: 120 },
  immersiveMetaRow: { marginBottom: 8 },
  immersiveMetaLabel: { color: '#93c5fd', fontSize: 11, fontWeight: '700' },
  immersiveMetaValue: { color: '#dbeafe', fontSize: 11, marginTop: 2 },
  immersiveQuickRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 10, paddingHorizontal: 4 },
  immersiveQuickBtn: { flex: 1, height: 38, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.06)', justifyContent: 'center', alignItems: 'center', gap: 1, marginHorizontal: 3, flexDirection: 'row' },
  immersiveQuickLabel: { fontSize: 11, fontWeight: '600', color: '#94a3b8', letterSpacing: 0.2, marginLeft: 6 },
  immersiveMainActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  immersiveSkipBtn: { width: 64, height: 56, borderRadius: 14, backgroundColor: 'rgba(245, 158, 11, 0.12)', justifyContent: 'center', alignItems: 'center', gap: 2 },
  immersiveDeliveredBtn: { flex: 1, height: 56, borderRadius: 14, backgroundColor: '#10b981', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
  immersiveDeliveredBtnLabel: { fontSize: 14, fontWeight: '800', color: '#ffffff', letterSpacing: 0.3 },
  // Defensive layering for the Delivered buttons. Lifts them above any invisible
  // overlay sibling (e.g. the gesture-tracking Animated.View, debug/perf overlays,
  // splash residue) that might intercept touches. zIndex works on iOS, elevation
  // is the Android equivalent and also raises the touch target Z-order.
  // Bumped 50→9999 / 12→24 to overshoot any ad-hoc layer in the WebView/map stack.
  deliveredHardenedHitbox: { zIndex: 9999, elevation: 24, position: 'relative' },
  // Press-state visual feedback — proves to the driver that the DOM element
  // received the touch even when no API call follows. Dramatic green-darken
  // + 4 % scale-down so it's unmissable on a moving phone in sunlight.
  deliveredPressed: { backgroundColor: '#047857', transform: [{ scale: 0.96 }] },
  immersiveDeliveredText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  immersiveFailedBtn: { width: 64, height: 56, borderRadius: 14, backgroundColor: 'rgba(239, 68, 68, 0.12)', justifyContent: 'center', alignItems: 'center', gap: 2 },
  immersiveSideBtnLabel: { fontSize: 10, fontWeight: '700', color: '#cbd5e1', letterSpacing: 0.3 },
  immersiveBottomMinimal: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(30, 41, 59, 0.95)', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, zIndex: 100, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  immersiveMinimalInfoExpanded: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, marginRight: 12 },
  immersiveMinimalBadge: { width: 36, height: 36, borderRadius: 10, backgroundColor: '#3b82f6', justifyContent: 'center', alignItems: 'center' },
  immersiveMinimalBadgeText: { fontSize: 16, fontWeight: '800', color: '#fff' },
  immersiveMinimalDetails: { flex: 1 },
  immersiveMinimalName: { fontSize: 14, fontWeight: '700', color: '#fff' },
  immersiveMinimalAddress: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  immersiveMinimalActions: { flexDirection: 'row', alignItems: 'center' },
  immersiveMinimalDelivered: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#10b981', justifyContent: 'center', alignItems: 'center' },
  navMultiplierBadge: { backgroundColor: '#3b82f6', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, marginRight: 8 },
  navMultiplierText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  navMultiplierBadgeSmall: { backgroundColor: '#3b82f6', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, marginRight: 4 },
  navMultiplierTextSmall: { color: '#fff', fontSize: 10, fontWeight: '800' },
  // Colocated-stops warning — sits directly above the stop row inside the
  // expanded nav card. Uses amber (#f59e0b → #fbbf24) so it's distinct from
  // the blue info/multiplier chips and the green Delivered CTA.
  colocatedWarn: {
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
    borderLeftWidth: 4,
    borderLeftColor: '#f59e0b',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  colocatedWarnHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  colocatedWarnTitle: { color: '#fbbf24', fontSize: 12, fontWeight: '900', letterSpacing: 0.4 },
  colocatedWarnBody: { marginTop: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  colocatedWarnLine: { color: '#fde68a', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  colocatedWarnBold: { color: '#fff', fontWeight: '900' },
  colocatedDotsRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 8 },
  colocatedDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.25)' },
  colocatedDotDone: { backgroundColor: '#10b981' },
  colocatedDotCurrent: { backgroundColor: '#fbbf24', width: 10, height: 10, borderRadius: 5 },
  // Swipe-hint chevrons — absolute-positioned inside the panel, centred vertically.
  swipeHintLeft:  { position: 'absolute', left: 6,  top: 0, bottom: 0, justifyContent: 'center', zIndex: 2 },
  swipeHintRight: { position: 'absolute', right: 6, top: 0, bottom: 0, justifyContent: 'center', zIndex: 2 },
  // Jump-to-stop Modal
  jumpMenuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end', padding: 16 },
  jumpMenuCard: { backgroundColor: '#111827', borderRadius: 14, padding: 12, marginBottom: 20,
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  jumpMenuHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingBottom: 10 },
  jumpMenuTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  jumpMenuRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 4, borderRadius: 10 },
  jumpMenuRowCurrent: { backgroundColor: 'rgba(59,130,246,0.12)' },
  jumpMenuNum: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#374151', alignItems: 'center', justifyContent: 'center' },
  jumpMenuNumCurrent: { backgroundColor: '#3b82f6' },
  jumpMenuNumDone:    { backgroundColor: '#16a34a' },
  jumpMenuNumFailed:  { backgroundColor: '#ef4444' },
  jumpMenuNumText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  jumpMenuName: { color: '#f3f4f6', fontSize: 14, fontWeight: '600' },
  jumpMenuAddress: { color: '#9ca3af', fontSize: 12, marginTop: 1 },
});

export default NavigationPanel;
