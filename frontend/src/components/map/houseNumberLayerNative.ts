/**
 * houseNumberLayerNative.ts — Native/WebView addendum.
 *
 * The native `DeliveryMap.native.tsx` injects MapLibre GL JS directly into a
 * WebView using a template literal (not JSX). The helpers here return the
 * MapLibre style spec as plain JS the injected HTML can `map.addSource(...)`
 * / `map.addLayer(...)` with. Keep the shape in lockstep with the JSX version
 * in `HouseNumberLayer.tsx` so driver UX is identical across platforms.
 *
 * Usage inside the injected HTML string in DeliveryMap.native.tsx:
 *   map.on('load', () => {
 *     map.addSource('house-numbers-src', { type: 'geojson', data: { type:'FeatureCollection', features: [] } });
 *     map.addLayer(houseNumberLayerSpec('house-numbers', 'house-numbers-src'));
 *   });
 *
 *   // Later, when the backend returns features:
 *   map.getSource('house-numbers-src').setData(featureCollection);
 */

export const HOUSE_NUMBER_MIN_ZOOM = 17.5;

/**
 * MapLibre symbol-layer spec. Matches the paint/layout of the JSX component
 * in `HouseNumberLayer.tsx` 1:1 — see comments there for rationale.
 */
export function houseNumberLayerSpec(
  id: string,
  source: string,
  opts: { sourceLayer?: string; minZoom?: number } = {},
) {
  const spec: Record<string, unknown> = {
    id,
    type: 'symbol',
    source,
    minzoom: opts.minZoom ?? HOUSE_NUMBER_MIN_ZOOM,
    layout: {
      'text-field': ['get', 'housenumber'],
      'text-font': ['Noto Sans Bold', 'Open Sans Bold'],
      'text-size': [
        'interpolate', ['linear'], ['zoom'],
        17, 12,
        20, 16,
      ],
      'text-padding': 2,
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-rotation-alignment': 'map',
      'text-pitch-alignment': 'viewport',
      'text-anchor': 'bottom',
      'text-offset': [0, -0.2],
    },
    paint: {
      'text-color': '#111827',
      'text-halo-color': '#ffffff',
      'text-halo-width': 2,
      'text-halo-blur': 0.3,
      'text-opacity': [
        'interpolate', ['linear'], ['zoom'],
        17, 0,
        17.5, 0.4,
        18, 1,
      ],
    },
  };
  if (opts.sourceLayer) {
    spec['source-layer'] = opts.sourceLayer;
  }
  return spec;
}
