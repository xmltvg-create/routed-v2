export interface GeocodeMetadataEntry {
  key: string;
  label: string;
  value: string;
}

const LABEL_OVERRIDES: Record<string, string> = {
  place_id: 'Place ID',
  place_type: 'Place Type',
  formatted_address: 'Formatted Address',
  location_type: 'Location Type',
  osm_tags: 'OSM Tags',
  admin_areas: 'Admin Areas',
  context_raw: 'Context',
};

const formatLabel = (key: string) => {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  return key
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

const formatValue = (value: any): string => {
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
    .map(([k, v]) => `${formatLabel(k)}: ${formatValue(v)}`)
    .join(' | ');
  return pairs || '--';
};

export const getGeocodeMetadataEntries = (
  geocodeMetadata?: Record<string, any> | null
): GeocodeMetadataEntry[] => {
  if (!geocodeMetadata || typeof geocodeMetadata !== 'object') return [];

  return Object.entries(geocodeMetadata).map(([key, value]) => ({
    key,
    label: formatLabel(key),
    value: formatValue(value),
  }));
};
