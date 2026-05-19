export const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

export const formatDistance = (meters: number): string => {
  if (meters >= 10000) {
    return `${Math.round(meters / 1000)} km`;
  }
  if (meters >= 1000) {
    // Round to nearest 0.5 km — "1 km", "1.5 km", "2 km"
    const km = Math.round(meters / 500) * 0.5;
    return Number.isInteger(km) ? `${km} km` : `${km} km`;
  }
  if (meters >= 500) {
    // Round to nearest 100 m
    return `${Math.round(meters / 100) * 100} m`;
  }
  // Round to nearest 50 m
  return `${Math.max(50, Math.round(meters / 50) * 50)} m`;
};

export const formatDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes} min`;
};

export const getSuburbColor = (suburb: string | null | undefined): string => {
  if (!suburb) return '#6b7280';
  
  const colors = [
    '#e11d48', '#f97316', '#eab308', '#22c55e', '#10b981',
    '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6',
    '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#fb923c',
    '#4ade80', '#2dd4bf', '#60a5fa', '#c084fc', '#fb7185',
  ];
  
  let hash = 0;
  for (let i = 0; i < suburb.length; i++) {
    hash = suburb.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

export const getManeuverIcon = (type: string, modifier: string): string => {
  if (modifier?.includes('left')) return 'arrow-back';
  if (modifier?.includes('right')) return 'arrow-forward';
  if (modifier?.includes('slight left')) return 'arrow-back';
  if (modifier?.includes('slight right')) return 'arrow-forward';
  if (modifier?.includes('sharp left')) return 'return-down-back';
  if (modifier?.includes('sharp right')) return 'return-down-forward';
  if (type === 'arrive') return 'flag';
  if (type === 'depart') return 'navigate';
  if (type === 'roundabout' || type === 'rotary') return 'sync';
  if (type === 'merge') return 'git-merge';
  if (type === 'fork') return 'git-branch';
  return 'arrow-up';
};

export const isPointInPolygon = (point: { lat: number; lng: number }, polygon: { lat: number; lng: number }[]): boolean => {
  if (polygon.length < 3) return false;
  
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    
    if (((yi > point.lat) !== (yj > point.lat)) &&
        (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
};

export const extractPhoneNumber = (stop: any): string | null => {
  if (!stop) return null;
  
  if (stop.mobile_number) {
    const cleaned = stop.mobile_number.toString().replace(/[-.\s()]/g, '');
    if (cleaned.length >= 8) return cleaned;
  }
  
  const notes = stop.notes || '';
  const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/;
  const match = notes.match(phoneRegex);
  if (match) return match[0].replace(/[-.\s()]/g, '');
  
  return null;
};

export const SECTION_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f97316', '#a855f7', '#06b6d4', '#ec4899', '#eab308'];

export const ALERT_TYPES = [
  { type: 'police', label: 'Police', icon: 'shield', color: '#3b82f6' },
  { type: 'speed_camera_fixed', label: 'Speed Camera', icon: 'camera', color: '#ef4444' },
  { type: 'speed_camera_mobile', label: 'Mobile Camera', icon: 'videocam', color: '#f97316' },
  { type: 'hazard', label: 'Hazard', icon: 'warning', color: '#eab308' },
  { type: 'accident', label: 'Accident', icon: 'car', color: '#dc2626' },
  { type: 'road_work', label: 'Road Work', icon: 'construct', color: '#f59e0b' },
];

export interface GeocodeMetadataEntry {
  key: string;
  label: string;
  value: string;
}

const META_LABEL_OVERRIDES: Record<string, string> = {
  place_id: 'Place ID',
  place_type: 'Place Type',
  formatted_address: 'Formatted Address',
  location_type: 'Location Type',
  osm_tags: 'OSM Tags',
  admin_areas: 'Admin Areas',
  context_raw: 'Context',
};

const formatMetaLabel = (key: string) => {
  if (META_LABEL_OVERRIDES[key]) return META_LABEL_OVERRIDES[key];
  return key
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

const formatMetaValue = (value: any): string => {
  if (value === null || value === undefined || value === '') return '--';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '--';
    if (value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
      return value.map(String).join(', ');
    }
    return JSON.stringify(value);
  }

  const pairs = Object.entries(value as Record<string, any>)
    .map(([k, v]) => `${formatMetaLabel(k)}: ${formatMetaValue(v)}`)
    .join(' | ');
  return pairs || '--';
};

export const getGeocodeMetadataEntries = (
  geocodeMetadata?: Record<string, any> | null
): GeocodeMetadataEntry[] => {
  if (!geocodeMetadata || typeof geocodeMetadata !== 'object') return [];

  return Object.entries(geocodeMetadata).map(([key, value]) => ({
    key,
    label: formatMetaLabel(key),
    value: formatMetaValue(value),
  }));
};
