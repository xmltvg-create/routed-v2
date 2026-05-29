import React, { useMemo } from 'react';
import { router } from 'expo-router';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Pressable,
  RefreshControl,
  Animated,
} from 'react-native';
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from 'react-native-draggable-flatlist';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Stop } from '../../store/stopsStore';
import { formatDistance, formatDuration, OptimizationHub, ViewMode } from './types';
import { groupStopsByLocation, getStopLabel } from '../../utils/groupStops';
import { stopPinNumber, isRouteConfirmed as computeRouteConfirmed, buildLateFreightLabels } from '../../utils/stopPinNumber';

const SIDEBAR_WIDTH = 320;
const COLLAPSED_WIDTH = 56;

interface SidebarProps {
  // State
  sidebarExpanded: boolean;
  stops: Stop[];
  completedCount: number;
  totalWeight: number;
  routeStats: { distance: number; duration: number } | null;
  /**
   * Whether the last optimize call started from the driver's current GPS location.
   * null = no optimization has run yet, true = ✓ , false = ⚠ (computed without GPS).
   */
  routeFromCurrent?: boolean | null;
  optimizing: boolean;
  optimizationHubs: OptimizationHub[];
  stopsCollapsed: boolean;
  isDragMode: boolean;
  refreshing: boolean;
  currentLocation: any;
  viewMode: ViewMode;
  isRefineMode: boolean;
  /** ML data-pipeline health (from GET /api/admin/ml/readiness). Null while
   *  loading or on auth/network failure — render is skipped, not crashed. */
  mlReadiness?: {
    pairs: number;
    threshold: number;
    status: 'insufficient' | 'trainable' | 'ready';
  } | null;
  
  // Animation values
  sidebarWidth: Animated.AnimatedInterpolation<number>;
  contentOpacity: Animated.AnimatedInterpolation<number>;
  
  // Insets
  insets: { top: number; bottom: number };
  
  // Callbacks
  toggleSidebar: () => void;
  onAddStop: () => void;
  onImport: () => void;
  onExport: () => void;
  onOptimize: () => void;
  onShowAlgorithmPicker: () => void;
  onBenchmark: () => void;
  onStartNavigation: () => void;
  onStopNavigation: () => void;
  onNewRoute: () => void;
  onClearHubs: () => void;
  onStopPress: (stop: Stop) => void;
  onProfilePress: () => void;
  onHistoryPress: () => void;
  onRefresh: () => void;
  onEnterRefineMode: () => void;
  setStopsCollapsed: (collapsed: boolean) => void;
  setIsDragMode: (mode: boolean) => void;
  /** Called when the driver finishes a drag-to-reorder gesture. Receives
   *  the new ordering as an array of stop IDs in the desired drive order.
   *  Parent should POST to /api/stops/reorder via stopsStore.reorderStops.
   *  Reordering pre-confirm shifts the optimised drive order; reordering
   *  post-confirm shifts drive order WITHOUT touching original_sequence
   *  (Sharpie pin labels stay locked, just visited in a new sequence). */
  onReorder?: (stopIds: string[]) => void;
  getSuburbColor: (suburb?: string) => string;
}

// --- Grouped Stops List Component ---
const GroupedStopsList: React.FC<{
  stops: Stop[];
  refreshing: boolean;
  onRefresh: () => void;
  onStopPress: (stop: Stop) => void;
  getSuburbColor: (suburb?: string) => string;
}> = ({ stops, refreshing, onRefresh, onStopPress, getSuburbColor }) => {
  const groups = useMemo(() => groupStopsByLocation(stops), [stops]);
  // Compute once — true iff any stop carries a Sharpie-locked
  // `original_sequence`. Used to distinguish "this stop has no pin yet
  // because the route is unconfirmed" (planning mode → dash badge) from
  // "this stop has no pin because it was added AFTER lock" (late
  // freight → amber warning badge with ❗). The map already paints this
  // distinction via `stopPinLabel`; the sidebar must match so drivers
  // glancing at the list spot late-freight instantly.
  const routeConfirmed = useMemo(() => computeRouteConfirmed(stops), [stops]);

  // Late-freight slot labels ("45A", "45B") keyed by stop id, computed in
  // visiting order and anchored to the nearest preceding locked stop. Keeps
  // the sidebar in lock-step with the map pins (DeliveryMap late_label).
  const lateLabels = useMemo(() => buildLateFreightLabels(stops as any), [stops]);

  // Track the running order index for display
  let runningIndex = 0;

  return (
    <ScrollView
      style={styles.stopsList}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#3b82f6"
          colors={['#3b82f6']}
        />
      }
    >
      {groups.map((group) => {
        const firstIndex = runningIndex;
        runningIndex += group.stops.length;

        if (group.stops.length === 1) {
          // Single stop — render normally
          const stop = group.stops[0];
          const pinNum = stopPinNumber(stop);
          // Late freight = a stop with no Sharpie value on a route that
          // has already been confirmed. The amber-with-exclamation badge
          // matches the map's amber-ringed `!` pin (see DeliveryMap
          // 3-state painter), so a driver scanning the sidebar spots the
          // late-freight rows instantly without having to cross-check
          // the map.
          const isLateFreight = pinNum === null && routeConfirmed;
          return (
            <Pressable
              key={stop.id}
              style={({ pressed }) => [
                styles.stopItem,
                stop.completed && styles.stopItemCompleted,
                pressed && styles.stopItemPressed,
              ]}
              onPress={() => onStopPress(stop)}
              data-testid={`stop-card-${stop.id}`}
            >
              <View style={[
                styles.stopIndex,
                stop.completed && styles.stopIndexCompleted,
                !stop.completed && !isLateFreight && { backgroundColor: getSuburbColor(stop.suburb) },
                !stop.completed && isLateFreight && styles.stopIndexLateFreight,
              ]}>
                {stop.completed ? (
                  <Ionicons name="checkmark" size={14} color="#fff" />
                ) : isLateFreight ? (
                  <Text style={styles.stopIndexText} testID={`late-freight-badge-${stop.id}`}>
                    {lateLabels[stop.id] ?? '\u2605'}
                  </Text>
                ) : (
                  <Text style={styles.stopIndexText}>{pinNum ?? '—'}</Text>
                )}
              </View>
              <View style={styles.stopInfo}>
                <Text style={[styles.stopName, stop.completed && styles.stopNameCompleted]} numberOfLines={2}>
                  {stop.address}
                </Text>
                {stop.geocode_metadata?.geocode_needs_fix && (
                  <View style={styles.stopNeedsFixBadge}>
                    <Ionicons name="warning-outline" size={12} color="#f59e0b" />
                    <Text style={styles.stopNeedsFixBadgeText}>Needs fix</Text>
                  </View>
                )}
                {stop.notes && stop.notes.trim() ? (
                  <View style={styles.stopNoteBadge} testID={`stop-note-badge-${stop.id}`}>
                    <Ionicons name="document-text" size={11} color="#b45309" />
                    <Text style={styles.stopNoteBadgeText} numberOfLines={1}>
                      {stop.notes.trim()}
                    </Text>
                  </View>
                ) : null}
                {stop.weight ? <Text style={styles.stopWeight}>{stop.weight} kg</Text> : null}
              </View>
            </Pressable>
          );
        }

        // Multi-stop group — consolidated card. Mark the whole group
        // as late freight if its representative stop is — drivers grab
        // the entire colocated cluster together when it shows up off-pile.
        const groupHeadPin = stopPinNumber(group.stops[0]);
        const groupIsLateFreight = groupHeadPin === null && routeConfirmed;
        return (
          <View
            key={group.key}
            style={[styles.groupedCard, group.allCompleted && styles.stopItemCompleted]}
            data-testid={`grouped-stop-card-${group.key}`}
          >
            {/* Group header */}
            <View style={styles.groupedHeader}>
              <View style={[
                styles.stopIndex,
                group.allCompleted && styles.stopIndexCompleted,
                !group.allCompleted && !groupIsLateFreight && { backgroundColor: getSuburbColor(group.stops[0].suburb) },
                !group.allCompleted && groupIsLateFreight && styles.stopIndexLateFreight,
              ]}>
                {groupIsLateFreight && !group.allCompleted ? (
                  <Text style={styles.stopIndexText} testID={`late-freight-badge-${group.key}`}>
                    {(group.stops[0].id && lateLabels[group.stops[0].id]) ? lateLabels[group.stops[0].id] : '\u2605'}
                  </Text>
                ) : (
                  <Text style={styles.stopIndexText}>{groupHeadPin ?? '—'}</Text>
                )}
              </View>
              <View style={styles.stopInfo}>
                <Text style={[styles.stopName, group.allCompleted && styles.stopNameCompleted]} numberOfLines={2}>
                  {group.address}
                </Text>
              </View>
              <View style={styles.multiplierBadge} data-testid={`multiplier-badge-${group.key}`}>
                <Text style={styles.multiplierText}>x{group.stops.length}</Text>
              </View>
            </View>

            {/* Completion progress */}
            {group.completedCount > 0 && group.completedCount < group.stops.length && (
              <View style={styles.groupProgress}>
                <View style={[styles.groupProgressBar, { width: `${(group.completedCount / group.stops.length) * 100}%` }]} />
              </View>
            )}

            {/* Individual sub-stops */}
            <View style={styles.groupedSubStops}>
              {group.stops.map((stop, i) => (
                <Pressable
                  key={stop.id}
                  style={({ pressed }) => [
                    styles.subStopRow,
                    stop.completed && styles.subStopCompleted,
                    pressed && { backgroundColor: 'rgba(59, 130, 246, 0.06)' },
                  ]}
                  onPress={() => onStopPress(stop)}
                  data-testid={`sub-stop-${stop.id}`}
                >
                  {stop.completed ? (
                    <Ionicons name="checkmark-circle" size={16} color="#10b981" style={{ marginRight: 8 }} />
                  ) : (
                    <View style={styles.subStopDot} />
                  )}
                  <Text style={[styles.subStopLabel, stop.completed && styles.subStopLabelCompleted]} numberOfLines={1}>
                    {getStopLabel(stop, group.address)}
                  </Text>
                  {stop.weight ? <Text style={styles.subStopWeight}>{stop.weight}kg</Text> : null}
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
};


export const Sidebar: React.FC<SidebarProps> = ({
  sidebarExpanded,
  stops,
  completedCount,
  totalWeight,
  routeStats,
  routeFromCurrent,
  optimizing = false,
  optimizationHubs = [],
  stopsCollapsed = false,
  isDragMode,
  refreshing,
  currentLocation,
  viewMode,
  isRefineMode,
  mlReadiness = null,
  sidebarWidth,
  contentOpacity,
  insets,
  toggleSidebar,
  onAddStop,
  onImport,
  onExport,
  onOptimize,
  onShowAlgorithmPicker,
  onBenchmark,
  onStartNavigation,
  onStopNavigation,
  onNewRoute,
  onClearHubs,
  onStopPress,
  onProfilePress,
  onHistoryPress,
  onRefresh,
  onEnterRefineMode,
  setStopsCollapsed,
  setIsDragMode,
  onReorder,
  getSuburbColor,
}) => {
  // Late-freight slot labels ("45A", "45B") for the drag-reorder list —
  // mirrors GroupedStopsList so the badge stays consistent across views.
  const dragLateLabels = useMemo(() => buildLateFreightLabels(stops as any), [stops]);
  const dragRouteConfirmed = useMemo(() => computeRouteConfirmed(stops), [stops]);
  return (
    <Animated.View 
      style={[
        styles.sidebar,
        { 
          width: sidebarWidth,
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + 8,
        }
      ]}
    >
      {/* Sidebar Header */}
      <View style={styles.sidebarHeader}>
        <Animated.View style={{ opacity: contentOpacity, flex: 1 }}>
          {sidebarExpanded && (
            <Text style={styles.sidebarTitle}>RouTeD</Text>
          )}
        </Animated.View>
        <View style={styles.headerButtons}>
          {sidebarExpanded && (
            <TouchableOpacity 
              style={styles.profileButton} 
              onPress={onHistoryPress}
              data-testid="sidebar-history-btn"
            >
              <Ionicons name="time-outline" size={24} color="#64748b" />
            </TouchableOpacity>
          )}
          {sidebarExpanded && (
            <TouchableOpacity 
              style={styles.profileButton} 
              onPress={onProfilePress}
            >
              <Ionicons name="person-circle" size={24} color="#64748b" />
            </TouchableOpacity>
          )}
          <TouchableOpacity 
            style={styles.toggleButton} 
            onPress={toggleSidebar}
          >
            <Ionicons 
              name={sidebarExpanded ? "chevron-back" : "chevron-forward"} 
              size={20} 
              color="#94a3b8" 
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Stats Summary — merged compact row (counts + route stats inline) */}
      <View style={styles.statsCompact}>
        <View style={styles.statCompactItem}>
          <View style={[styles.statCompactIcon, { backgroundColor: 'rgba(59, 130, 246, 0.2)' }]}>
            <Ionicons name="location" size={13} color="#3b82f6" />
          </View>
          <Animated.Text style={[styles.statCompactValue, { opacity: contentOpacity }]}>
            {sidebarExpanded ? stops.length : ''}
          </Animated.Text>
        </View>
        <View style={styles.statCompactItem}>
          <View style={[styles.statCompactIcon, { backgroundColor: 'rgba(16, 185, 129, 0.2)' }]}>
            <Ionicons name="checkmark-circle" size={13} color="#10b981" />
          </View>
          <Animated.Text style={[styles.statCompactValue, { opacity: contentOpacity }]}>
            {sidebarExpanded ? completedCount : ''}
          </Animated.Text>
        </View>
        <View style={styles.statCompactItem}>
          <View style={[styles.statCompactIcon, { backgroundColor: 'rgba(245, 158, 11, 0.2)' }]}>
            <Ionicons name="cube" size={13} color="#f59e0b" />
          </View>
          <Animated.Text style={[styles.statCompactValue, { opacity: contentOpacity }]}>
            {sidebarExpanded ? (totalWeight > 0 ? `${totalWeight.toFixed(1)}kg` : '0kg') : ''}
          </Animated.Text>
        </View>
        {sidebarExpanded && routeStats && (
          <>
            <View style={styles.statsDivider} />
            <Animated.View style={[styles.statCompactItem, { opacity: contentOpacity }]}>
              <Ionicons name="navigate" size={12} color="#f59e0b" style={{ marginRight: 3 }} />
              <Text style={styles.statCompactValue} data-testid="sidebar-route-distance">
                {formatDistance(routeStats.distance)}
              </Text>
              {routeFromCurrent === true && (
                <Ionicons name="checkmark-circle" size={10} color="#10b981" style={{ marginLeft: 3 }} data-testid="route-gps-ok-icon" />
              )}
              {routeFromCurrent === false && (
                <Ionicons name="warning" size={10} color="#f59e0b" style={{ marginLeft: 3 }} data-testid="route-gps-missing-icon" />
              )}
            </Animated.View>
            <Animated.View style={[styles.statCompactItem, { opacity: contentOpacity }]}>
              <Ionicons name="time" size={12} color="#8b5cf6" style={{ marginRight: 3 }} />
              <Text style={styles.statCompactValue} data-testid="sidebar-route-duration">
                {formatDuration(routeStats.duration)}
              </Text>
            </Animated.View>
          </>
        )}
        {sidebarExpanded && mlReadiness && (
          <Animated.View
            style={[styles.statCompactItem, { opacity: contentOpacity }]}
            data-testid="ml-data-health-badge"
          >
            <Ionicons
              name="analytics"
              size={12}
              color={
                mlReadiness.status === 'ready' ? '#10b981'
                : mlReadiness.status === 'trainable' ? '#f59e0b'
                : '#64748b'
              }
              style={{ marginRight: 3 }}
            />
            <Text style={styles.statCompactValue}>
              {mlReadiness.pairs}/{mlReadiness.threshold}
            </Text>
          </Animated.View>
        )}
      </View>
      <Animated.View style={[styles.expandedContent, { opacity: contentOpacity }]}>
        {sidebarExpanded && (
          <>
            {/* Action Buttons — slim 2-col grid for secondary, full-width for primary */}
            <View style={styles.sidebarActions}>
              <View style={styles.actionRow2col}>
                <TouchableOpacity
                  style={[styles.actionBtnMini, styles.actionBtnHalf]}
                  onPress={onAddStop}
                  data-testid="add-stop-btn"
                >
                  <Ionicons name="add-circle" size={16} color="#3b82f6" />
                  <Text style={styles.actionBtnMiniText}>Add Stop</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtnMini, styles.actionBtnHalf]}
                  onPress={onImport}
                  data-testid="import-btn"
                >
                  <Ionicons name="cloud-upload" size={16} color="#8b5cf6" />
                  <Text style={styles.actionBtnMiniText}>Import</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.actionRow2col}>
                <TouchableOpacity
                  style={[styles.actionBtnMini, styles.actionBtnHalf, stops.length === 0 && styles.actionBtnDisabled]}
                  onPress={onExport}
                  disabled={stops.length === 0}
                  data-testid="export-xlsx-btn"
                >
                  <Ionicons name="download-outline" size={16} color={stops.length > 0 ? "#059669" : "#94a3b8"} />
                  <Text style={[styles.actionBtnMiniText, stops.length === 0 && { color: '#94a3b8' }]}>Export</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtnMini, styles.actionBtnHalf, stops.length < 2 && styles.actionBtnDisabled]}
                  onPress={onBenchmark}
                  disabled={stops.length < 2}
                  data-testid="benchmark-btn"
                >
                  <Ionicons name="speedometer" size={16} color="#818cf8" />
                  <Text style={styles.actionBtnMiniText}>Benchmark</Text>
                </TouchableOpacity>
              </View>

              {/* Van bin grid configuration — one-tap entry point to the
                  parcel-finding setup. Persists per-driver, so this only
                  needs to be set once. */}
              <View style={styles.actionRow2col}>
                <TouchableOpacity
                  style={[styles.actionBtnMini, styles.actionBtnHalf]}
                  onPress={() => router.push('/configure-van')}
                  data-testid="configure-van-btn"
                >
                  <Ionicons name="grid" size={16} color="#FF5A00" />
                  <Text style={styles.actionBtnMiniText}>Configure Van</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.actionBtnMini,
                    styles.actionBtnHalf,
                    stops.length < 1 && styles.actionBtnDisabled,
                  ]}
                  onPress={() => router.push('/load-van')}
                  disabled={stops.length < 1}
                  data-testid="load-van-btn"
                >
                  <Ionicons name="cube" size={16} color="#FF5A00" />
                  <Text style={styles.actionBtnMiniText}>Load Van</Text>
                </TouchableOpacity>
              </View>

              {/* Optimize Button with Algorithm Selector */}
              <View style={styles.optimizeButtonContainer}>
                <TouchableOpacity
                  style={[styles.actionBtnPrimary, styles.optimizeMainBtn, (stops.length < 2 || optimizing) && styles.actionBtnDisabled]}
                  onPress={onOptimize}
                  disabled={stops.length < 2 || optimizing}
                >
                  {optimizing ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="sparkles" size={18} color="#fff" />
                      {currentLocation && (
                        <Ionicons name="location" size={12} color="#86efac" style={{ marginLeft: -4, marginRight: 2 }} />
                      )}
                    </>
                  )}
                  <Text style={styles.actionBtnPrimaryText}>
                    {optimizing ? 'Optimizing...' : 'Optimize'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.algorithmPickerBtn, (stops.length < 2 || optimizing) && styles.actionBtnDisabled]}
                  onPress={onShowAlgorithmPicker}
                  disabled={stops.length < 2 || optimizing}
                  testID="algorithm-picker-dropdown"
                >
                  <Ionicons name="chevron-down" size={14} color="#fff" />
                </TouchableOpacity>
              </View>

              <View style={styles.actionRow2col}>
                <TouchableOpacity
                  style={[styles.actionBtnStart, styles.actionBtnHalf, stops.length < 2 && styles.actionBtnDisabled]}
                  onPress={onStartNavigation}
                  disabled={stops.length < 2}
                  data-testid="start-navigation-btn"
                >
                  <Ionicons name="navigate" size={16} color="#fff" />
                  <Text style={styles.actionBtnPrimaryText}>Start</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtnNewRoute, styles.actionBtnHalf, stops.length === 0 && styles.actionBtnDisabled]}
                  onPress={onNewRoute}
                  disabled={stops.length === 0}
                  data-testid="new-route-btn"
                >
                  <Ionicons name="refresh" size={14} color="#ef4444" />
                  <Text style={styles.actionBtnNewRouteText}>New</Text>
                </TouchableOpacity>
              </View>

              {/* Clear Hubs Button - Only show when hubs exist */}
              {(optimizationHubs?.length ?? 0) > 0 && (
                <TouchableOpacity
                  style={styles.actionBtnClearHubs}
                  onPress={onClearHubs}
                >
                  <Ionicons name="pin" size={14} color="#ef4444" />
                  <Text style={styles.actionBtnClearHubsText}>Clear {optimizationHubs.length} Hub{optimizationHubs.length > 1 ? 's' : ''}</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Hub Hint - Show when no hubs */}
            {optimizationHubs.length === 0 && stops.length >= 2 && !isRefineMode && (
              <View style={styles.hubHintContainer}>
                <Ionicons name="information-circle-outline" size={14} color="#6b7280" />
                <Text style={styles.hubHintText}>Long-press map to add optimization waypoints</Text>
              </View>
            )}

            {/* Stops List */}
            <View style={styles.stopsSection}>
              <TouchableOpacity 
                style={styles.stopsSectionHeader}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setStopsCollapsed(!stopsCollapsed);
                }}
                activeOpacity={0.7}
              >
                <Ionicons 
                  name={stopsCollapsed ? "chevron-forward" : "chevron-down"} 
                  size={16} 
                  color="#64748b" 
                />
                <Text style={styles.stopsSectionTitle}>Stops</Text>
                <Text style={styles.stopsCount}>{stops.length}</Text>
                <View style={{ flex: 1 }} />
                <TouchableOpacity 
                  style={[styles.reorderToggle, isDragMode && styles.reorderToggleActive]}
                  onPress={(e) => {
                    e.stopPropagation();
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setIsDragMode(!isDragMode);
                  }}
                >
                  <Ionicons 
                    name={isDragMode ? "checkmark" : "reorder-three"} 
                    size={18} 
                    color={isDragMode ? "#10b981" : "#64748b"} 
                  />
                </TouchableOpacity>
              </TouchableOpacity>
              
              {stops.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons name="location-outline" size={32} color="#475569" />
                  <Text style={styles.emptyStateText}>No stops yet</Text>
                </View>
              ) : isDragMode ? (
                <View style={styles.dragListContainer}>
                  <Text style={styles.dragHint}>Long-press a row · drag to reorder</Text>
                  <DraggableFlatList
                    data={stops}
                    keyExtractor={(item) => item.id}
                    onDragEnd={({ data }) => {
                      // Fire the parent callback with the new order. The
                      // store's reorderStops action optimistically updates
                      // local state then POSTs /api/stops/reorder; on
                      // network failure it auto-reverts. UI feedback is
                      // immediate; persistence is best-effort.
                      if (onReorder) onReorder(data.map((s) => s.id));
                    }}
                    activationDistance={8}
                    contentContainerStyle={styles.stopsList}
                    renderItem={({ item, drag, isActive }: RenderItemParams<Stop>) => (
                      <ScaleDecorator>
                        <Pressable
                          onLongPress={drag}
                          disabled={isActive}
                          delayLongPress={150}
                          style={[
                            styles.stopItem,
                            item.completed && styles.stopItemCompleted,
                            isActive && styles.stopItemDragging,
                          ]}
                          onPress={() => onStopPress(item)}
                          testID={`drag-stop-row-${item.id}`}
                        >
                          <View style={[styles.stopIndex, item.completed && styles.stopIndexCompleted]}>
                            {item.completed ? (
                              <Ionicons name="checkmark" size={14} color="#fff" />
                            ) : (stopPinNumber(item) === null && dragRouteConfirmed && dragLateLabels[item.id]) ? (
                              <Text style={styles.stopIndexText} testID={`late-freight-badge-${item.id}`}>{dragLateLabels[item.id]}</Text>
                            ) : (
                              <Text style={styles.stopIndexText}>{stopPinNumber(item) ?? '—'}</Text>
                            )}
                          </View>
                          <View style={styles.stopInfo}>
                            <Text style={[styles.stopName, item.completed && styles.stopNameCompleted]} numberOfLines={2}>
                              {item.address}
                            </Text>
                            {item.geocode_metadata?.geocode_needs_fix ? (
                              <View style={styles.stopNeedsFixBadge} testID={`stop-needs-geocode-fix-badge-${item.id}`}>
                                <Ionicons name="warning-outline" size={12} color="#f59e0b" />
                                <Text style={styles.stopNeedsFixBadgeText}>Needs fix</Text>
                              </View>
                            ) : null}
                            {item.notes && item.notes.trim() ? (
                              <View style={styles.stopNoteBadge} testID={`stop-note-badge-${item.id}`}>
                                <Ionicons name="document-text" size={11} color="#b45309" />
                                <Text style={styles.stopNoteBadgeText} numberOfLines={1}>
                                  {item.notes.trim()}
                                </Text>
                              </View>
                            ) : null}
                          </View>
                          <View style={styles.dragHandle}>
                            <Ionicons name="reorder-three" size={22} color="#94a3b8" />
                          </View>
                        </Pressable>
                      </ScaleDecorator>
                    )}
                  />
                </View>
              ) : (
                <GroupedStopsList
                  stops={stops}
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  onStopPress={onStopPress}
                  getSuburbColor={getSuburbColor}
                />
              )}
            </View>
          </>
        )}
      </Animated.View>

      {/* Collapsed Quick Actions */}
      {!sidebarExpanded && (
        <View style={styles.collapsedActions}>
          <TouchableOpacity style={styles.collapsedBtn} onPress={onAddStop}>
            <Ionicons name="add" size={22} color="#3b82f6" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.collapsedBtn} onPress={onImport}>
            <Ionicons name="cloud-upload-outline" size={22} color="#8b5cf6" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.collapsedBtn, stops.length < 2 && styles.collapsedBtnDisabled]}
            onPress={onOptimize}
            disabled={stops.length < 2 || optimizing}
          >
            <Ionicons name="sparkles" size={22} color="#f59e0b" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.collapsedBtn, stops.length < 2 && styles.collapsedBtnDisabled]}
            onPress={onBenchmark}
            disabled={stops.length < 2}
          >
            <Ionicons name="speedometer" size={22} color="#818cf8" />
          </TouchableOpacity>
          {viewMode === 'planning' ? (
            <TouchableOpacity
              style={[styles.collapsedBtnStart, stops.length < 2 && styles.collapsedBtnDisabled]}
              onPress={onStartNavigation}
              disabled={stops.length < 2}
            >
              <Ionicons name="navigate" size={22} color="#fff" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.collapsedBtnStop} onPress={onStopNavigation}>
              <Ionicons name="stop" size={22} color="#fff" />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.collapsedBtnNewRoute}
            onPress={onNewRoute}
          >
            <Ionicons name="refresh" size={22} color="#ef4444" />
          </TouchableOpacity>
        </View>
      )}
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  sidebar: {
    backgroundColor: 'rgba(255, 255, 255, 0.97)',
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    zIndex: 10,
  },
  sidebarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  sidebarTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  toggleButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerButtons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  profileButton: {
    padding: 3,
  },
  statsCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    columnGap: 8,
    rowGap: 4,
  },
  statCompactItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statsDivider: {
    width: 1,
    height: 16,
    backgroundColor: '#e2e8f0',
  },
  statCompactIcon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 4,
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.06)',
  },
  statCompactValue: {
    color: '#0f172a',
    fontSize: 12,
    fontWeight: '700',
  },
  expandedContent: {
    flex: 1,
  },
  routeStats: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  routeStatRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  routeStatText: {
    color: '#475569',
    fontSize: 13,
    fontWeight: '600',
  },
  sidebarActions: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  actionRow2col: {
    flexDirection: 'row',
    columnGap: 6,
    marginBottom: 6,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 8,
  },
  actionBtnMini: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  actionBtnHalf: {
    flex: 1,
  },
  actionBtnMiniText: {
    color: '#0f172a',
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 5,
  },
  actionBtnText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 8,
  },
  actionBtnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#3b82f6',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  actionBtnStart: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#10b981',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  actionBtnNewRoute: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  actionBtnNewRouteText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 4,
  },
  actionBtnClearHubs: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    marginTop: 8,
  },
  actionBtnClearHubsText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '500',
    marginLeft: 6,
  },
  hubHintContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    marginHorizontal: 12,
  },
  hubHintText: {
    color: '#6b7280',
    fontSize: 11,
    flex: 1,
    marginLeft: 6,
  },
  actionBtnPrimaryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 6,
  },
  actionBtnDisabled: {
    opacity: 0.5,
  },
  optimizeButtonContainer: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    marginBottom: 8,
  },
  optimizeMainBtn: {
    flex: 1,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
  },
  algorithmPickerBtn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stopsSection: {
    flex: 1,
    paddingTop: 12,
  },
  stopsSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  stopsSectionTitle: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginLeft: 6,
  },
  stopsCount: {
    color: '#3b82f6',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 6,
  },
  stopsList: {
    flex: 1,
    paddingHorizontal: 8,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyStateText: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 12,
  },
  stopItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  stopItemCompleted: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.2)',
  },
  stopItemPressed: {
    backgroundColor: '#e2e8f0',
  },
  stopIndex: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#3b82f6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
    paddingHorizontal: 6,
  },
  stopIndexCompleted: {
    backgroundColor: '#10b981',
  },
  // Late-freight badge: solid purple-500 with a darker purple-700 border so
  // it visually pops out of the suburb-tinted standard badges. Matches
  // the purple-500 ring + ★ Unicode BLACK STAR used by the map's 3-state
  // pin painter (`DeliveryMap.native.tsx::1369`) so map + sidebar tell
  // the same story. Purple chosen because red/amber/blue/green are all
  // already in use (locked Sharpie / planning / completed states).
  stopIndexLateFreight: {
    backgroundColor: '#a855f7',
    borderWidth: 1.5,
    borderColor: '#7e22ce',
  },
  stopIndexText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  stopInfo: {
    flex: 1,
  },
  stopName: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
  stopNameCompleted: {
    color: '#64748b',
    textDecorationLine: 'line-through',
  },
  stopWeight: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 4,
    fontWeight: '500',
  },

  // Grouped stop card styles
  groupedCard: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  groupedHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
  },
  multiplierBadge: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 8,
  },
  multiplierText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800' as const,
  },
  groupProgress: {
    height: 3,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderRadius: 2,
    marginTop: 8,
    marginBottom: 4,
    overflow: 'hidden' as const,
  },
  groupProgressBar: {
    height: 3,
    backgroundColor: '#10b981',
    borderRadius: 2,
  },
  groupedSubStops: {
    marginTop: 6,
    marginLeft: 36,
    borderLeftWidth: 2,
    borderLeftColor: '#e2e8f0',
    paddingLeft: 10,
  },
  subStopRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderRadius: 6,
  },
  subStopCompleted: {
    opacity: 0.6,
  },
  subStopDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#cbd5e1',
    marginRight: 8,
  },
  subStopLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600' as const,
    color: '#334155',
  },
  subStopLabelCompleted: {
    textDecorationLine: 'line-through' as const,
    color: '#94a3b8',
  },
  subStopWeight: {
    fontSize: 11,
    color: '#64748b',
    marginLeft: 6,
  },
  stopNeedsFixBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 999,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: 6,
  },
  stopNeedsFixBadgeText: {
    marginLeft: 4,
    color: '#b45309',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  stopNoteBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: 8,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 6,
    gap: 5,
  },
  stopNoteBadgeText: {
    color: '#92400e',
    fontSize: 11,
    fontWeight: '600',
    flexShrink: 1,
  },
  dragListContainer: {
    flex: 1,
  },
  dragHint: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 8,
  },
  reorderToggle: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  reorderToggleActive: {
    backgroundColor: '#d1fae5',
    borderColor: '#10b981',
  },
  // Active drag-row styling — slight tint + subtle elevation so the row
  // feels lifted off the list while the user moves it.
  stopItemDragging: {
    backgroundColor: '#eff6ff',  // blue-50
    borderColor: '#1d4ed8',
    borderWidth: 1.5,
    transform: [{ scale: 1.02 }],
  },
  // Visible grip handle on the right edge — affordance that this row
  // can be dragged. Only shown in drag mode.
  dragHandle: {
    paddingHorizontal: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  collapsedActions: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  collapsedBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  collapsedBtnStart: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#10b981',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  collapsedBtnStop: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  collapsedBtnDisabled: {
    opacity: 0.4,
  },
  collapsedBtnNewRoute: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
});

export default Sidebar;
