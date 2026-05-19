import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

interface RouteSummary {
  id: string;
  archived_at: string;
  started_at?: string;
  finished_at?: string;
  summary: {
    total_stops: number;
    delivered: number;
    skipped: number;
    failed: number;
    pending: number;
    total_weight_kg: number;
    total_quantity: number;
    algorithm?: string | null;
    total_distance_km?: number | null;
    total_duration_seconds?: number | null;
  };
}

/**
 * Normalise raw `route_history` rows from the backend into the canonical
 * `RouteSummary` shape this modal expects.
 *
 * Two schemas exist in production:
 *   A) Legacy auto-archive from `/api/import/process` — fields:
 *      `{ id, user_id, created_at, completed_at, stats: { stops_count, auto_archived_reason } }`
 *      (the modal previously crashed on these because `summary` was `undefined`).
 *   B) Canonical archive from `/api/routes/archive` — fields:
 *      `{ id, user_id, archived_at, started_at, finished_at,
 *         summary: { total_stops, delivered, skipped, failed, pending, ... } }`
 *
 * This adapter folds A into B so the renderer never sees `undefined`.
 * Schema-B docs pass through unchanged.
 */
const normaliseRoute = (raw: any): RouteSummary => {
  // Schema B already has `summary` populated — minimal coercion only.
  if (raw && raw.summary && typeof raw.summary === 'object') {
    return {
      id: String(raw.id ?? ''),
      archived_at: raw.archived_at ?? raw.completed_at ?? raw.created_at ?? '',
      started_at: raw.started_at,
      finished_at: raw.finished_at,
      summary: {
        total_stops: Number(raw.summary.total_stops ?? 0),
        delivered: Number(raw.summary.delivered ?? 0),
        skipped: Number(raw.summary.skipped ?? 0),
        failed: Number(raw.summary.failed ?? 0),
        pending: Number(raw.summary.pending ?? 0),
        total_weight_kg: Number(raw.summary.total_weight_kg ?? 0),
        total_quantity: Number(raw.summary.total_quantity ?? 0),
        algorithm: raw.summary.algorithm ?? null,
        total_distance_km: raw.summary.total_distance_km ?? null,
        total_duration_seconds: raw.summary.total_duration_seconds ?? null,
      },
    };
  }
  // Schema A — `stats` block instead of `summary`. We don't know how many
  // were skipped/failed (the importer only counted total stops), so show
  // the imported count under `total_stops` and leave the rest at zero.
  const stats = (raw && raw.stats) || {};
  return {
    id: String(raw?.id ?? ''),
    archived_at: raw?.completed_at ?? raw?.created_at ?? '',
    summary: {
      total_stops: Number(stats.stops_count ?? 0),
      delivered: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      total_weight_kg: 0,
      total_quantity: 0,
      algorithm: null,
      total_distance_km: null,
      total_duration_seconds: null,
    },
  };
};

interface AggregateStats {
  total_routes: number;
  total_delivered: number;
  total_skipped: number;
  total_failed: number;
  total_stops: number;
  total_weight_kg: number;
  total_quantity: number;
  avg_stops_per_route: number;
  avg_delivered_per_route: number;
}

interface HistoryModalProps {
  visible: boolean;
  onClose: () => void;
  onResume: (routeId: string) => void;
  insets: { top: number; bottom: number };
}

const authFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
  const token = await AsyncStorage.getItem('session_token');
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    credentials: 'include',
  });
};

export const HistoryModal: React.FC<HistoryModalProps> = ({ visible, onClose, onResume, insets }) => {
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [stats, setStats] = useState<AggregateStats | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [histRes, statsRes] = await Promise.all([
        authFetch(`${BACKEND_URL}/api/routes/history`),
        authFetch(`${BACKEND_URL}/api/routes/stats`),
      ]);
      if (histRes.ok) {
        const h = await histRes.json();
        // Normalise raw rows — production has TWO schemas (see
        // normaliseRoute comment block) and the renderer below assumes
        // the canonical `summary.*` shape. Without normalisation the
        // modal crashed on the older `stats`-shaped rows because
        // `r.summary` was undefined.
        const raw = Array.isArray(h.routes) ? h.routes : [];
        setRoutes(raw.map(normaliseRoute));
      }
      if (statsRes.ok) {
        setStats(await statsRes.json());
      }
    } catch (e) {
      console.error('History fetch error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible) fetchData();
  }, [visible]);

  const deleteRoute = (routeId: string) => {
    Alert.alert('Delete Route', 'Remove this route from history?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const res = await authFetch(`${BACKEND_URL}/api/routes/history/${routeId}`, {
              method: 'DELETE',
            });
            if (res.ok) {
              setRoutes((prev) => prev.filter((r) => r.id !== routeId));
              const statsRes = await authFetch(`${BACKEND_URL}/api/routes/stats`);
              if (statsRes.ok) setStats(await statsRes.json());
            }
          } catch (e) {
            console.error('Delete route error:', e);
          }
        },
      },
    ]);
  };

  const resumeRoute = (routeId: string) => {
    Alert.alert('Resume Route', 'This will replace your current stops with the archived route. Continue?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Resume',
        onPress: () => onResume(routeId),
      },
    ]);
  };

  const formatDate = (iso?: string) => {
    if (!iso) return '--';
    const d = new Date(iso);
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const formatTime = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  };

  const deliveryRate = (s: RouteSummary['summary']) =>
    s.total_stops > 0 ? Math.round((s.delivered / s.total_stops) * 100) : 0;

  const renderRoute = ({ item }: { item: RouteSummary }) => {
    const rate = deliveryRate(item.summary);
    const rateColor = rate >= 90 ? '#10b981' : rate >= 70 ? '#f59e0b' : '#ef4444';

    return (
      <View style={s.card} data-testid={`history-route-card-${item.id}`}>
        <View style={s.cardHeader}>
          <View style={s.cardDateBox}>
            <Text style={s.cardDate}>{formatDate(item.archived_at)}</Text>
            <Text style={s.cardTime}>{formatTime(item.archived_at)}</Text>
          </View>
          <View style={[s.rateBadge, { backgroundColor: rateColor + '22' }]}>
            <Text style={[s.rateText, { color: rateColor }]}>{rate}%</Text>
          </View>
          <TouchableOpacity
            style={s.resumeBtn}
            onPress={() => resumeRoute(item.id)}
            data-testid={`history-resume-${item.id}`}
          >
            <Ionicons name="play" size={16} color="#3b82f6" />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.deleteBtn}
            onPress={() => deleteRoute(item.id)}
            data-testid={`history-delete-${item.id}`}
          >
            <Ionicons name="trash-outline" size={18} color="#ef4444" />
          </TouchableOpacity>
        </View>

        <View style={s.cardStats}>
          <View style={s.cardStat}>
            <Ionicons name="location" size={14} color="#3b82f6" />
            <Text style={s.cardStatVal}>{item.summary.total_stops}</Text>
            <Text style={s.cardStatLabel}>stops</Text>
          </View>
          <View style={s.cardStat}>
            <Ionicons name="checkmark-circle" size={14} color="#10b981" />
            <Text style={s.cardStatVal}>{item.summary.delivered}</Text>
            <Text style={s.cardStatLabel}>done</Text>
          </View>
          <View style={s.cardStat}>
            <Ionicons name="play-skip-forward" size={14} color="#f59e0b" />
            <Text style={s.cardStatVal}>{item.summary.skipped}</Text>
            <Text style={s.cardStatLabel}>skip</Text>
          </View>
          <View style={s.cardStat}>
            <Ionicons name="close-circle" size={14} color="#ef4444" />
            <Text style={s.cardStatVal}>{item.summary.failed}</Text>
            <Text style={s.cardStatLabel}>fail</Text>
          </View>
          {item.summary.total_weight_kg > 0 && (
            <View style={s.cardStat}>
              <Ionicons name="cube" size={14} color="#8b5cf6" />
              <Text style={s.cardStatVal}>{item.summary.total_weight_kg}</Text>
              <Text style={s.cardStatLabel}>kg</Text>
            </View>
          )}
        </View>
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent data-testid="history-modal">
      <View style={[s.overlay, { paddingTop: insets.top }]}>
        <View style={[s.container, { paddingBottom: insets.bottom + 16 }]}>
          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>Route History</Text>
            <TouchableOpacity onPress={onClose} style={s.closeBtn} data-testid="history-close-btn">
              <Ionicons name="close" size={24} color="#64748b" />
            </TouchableOpacity>
          </View>

          {/* Aggregate Stats */}
          {stats && stats.total_routes > 0 && (
            <View style={s.statsBar} data-testid="history-stats-bar">
              <View style={s.statPill}>
                <Ionicons name="flag" size={13} color="#3b82f6" />
                <Text style={s.statPillVal}>{stats.total_routes}</Text>
                <Text style={s.statPillLabel}>routes</Text>
              </View>
              <View style={s.statPill}>
                <Ionicons name="checkmark-done" size={13} color="#10b981" />
                <Text style={s.statPillVal}>{stats.total_delivered}</Text>
                <Text style={s.statPillLabel}>delivered</Text>
              </View>
              <View style={s.statPill}>
                <Ionicons name="location" size={13} color="#f59e0b" />
                <Text style={s.statPillVal}>{Math.round(stats.avg_stops_per_route)}</Text>
                <Text style={s.statPillLabel}>avg/route</Text>
              </View>
              {stats.total_weight_kg > 0 && (
                <View style={s.statPill}>
                  <Ionicons name="cube" size={13} color="#8b5cf6" />
                  <Text style={s.statPillVal}>{Math.round(stats.total_weight_kg)}</Text>
                  <Text style={s.statPillLabel}>kg total</Text>
                </View>
              )}
            </View>
          )}

          {/* Route List */}
          {loading ? (
            <View style={s.center}>
              <ActivityIndicator size="large" color="#3b82f6" />
            </View>
          ) : routes.length === 0 ? (
            <View style={s.center}>
              <Ionicons name="folder-open-outline" size={48} color="#475569" />
              <Text style={s.emptyText}>No routes archived yet</Text>
              <Text style={s.emptySubtext}>
                Routes are saved automatically when you start a new route
              </Text>
            </View>
          ) : (
            <FlatList
              data={routes}
              keyExtractor={(item) => item.id}
              renderItem={renderRoute}
              contentContainerStyle={s.list}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </View>
    </Modal>
  );
};

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    marginTop: 40,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: '#f1f5f9',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Aggregate stats bar
  statsBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
  },
  statPillVal: {
    fontSize: 14,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  statPillLabel: {
    fontSize: 11,
    color: '#94a3b8',
  },

  // Route cards
  list: {
    paddingTop: 12,
    paddingBottom: 24,
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  cardDateBox: {
    flex: 1,
  },
  cardDate: {
    fontSize: 15,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  cardTime: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 1,
  },
  rateBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginRight: 8,
  },
  rateText: {
    fontSize: 13,
    fontWeight: '800',
  },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  resumeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },

  cardStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  cardStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  cardStatVal: {
    fontSize: 14,
    fontWeight: '700',
    color: '#cbd5e1',
  },
  cardStatLabel: {
    fontSize: 11,
    color: '#64748b',
  },

  // Empty & loading states
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#94a3b8',
  },
  emptySubtext: {
    fontSize: 13,
    color: '#475569',
    textAlign: 'center',
    paddingHorizontal: 32,
  },
});

export default HistoryModal;
