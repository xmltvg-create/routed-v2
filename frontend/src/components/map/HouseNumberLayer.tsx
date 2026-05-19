/**
 * HouseNumberLayer — MapLibre symbol layer that renders street-address house numbers
 * at very high zooms to help drivers confirm the final delivery step.
 *
 * Performance notes:
 *   • Zoom ≥ 17.5 only (hidden below) → renders a tiny slice of features only when
 *     a driver is genuinely at the curbside. Keeps bundle cost effectively zero at
 *     overview zooms.
 *   • text-padding:2 + collision enabled → no visual clutter when houses are dense.
 *   • text-rotation-alignment:"map" + text-pitch-alignment:"viewport" → labels lie
 *     flat on the street surface in 3D driving mode but stay upright from the
 *     driver's perspective.
 *
 * Data source options:
 *   • `features`  — pass a GeoJSON FeatureCollection of Point features whose
 *                    `properties.housenumber` holds the number string.
 *     Use this when you hydrate addresses from your backend (recommended for
 *     small-to-medium fleets).
 *   • `sourceUrl` — if you already have a MapLibre vector tile source hosting
 *                    OSM addr:housenumber data (e.g. pmtiles), pass the URL and
 *                    set `sourceLayer` to the tile layer name. `features` is
 *                    ignored when `sourceUrl` is set.
 *
 * This file is safe to import from BOTH native (`DeliveryMap.native.tsx`) and web
 * (`DeliveryMap.tsx`) entries because it only uses react-map-gl primitives, which
 * the native WebView adapter transpiles to equivalent injected-HTML layers.
 */

import React from 'react';
import { Source, Layer } from 'react-map-gl/maplibre';
import type { LayerProps } from 'react-map-gl/maplibre';
import type { FeatureCollection, Point } from 'geojson';

interface HouseNumberFeatureProps {
  housenumber: string;
}

interface HouseNumberLayerProps {
  /** GeoJSON features with {housenumber: string} properties. Ignored if sourceUrl is given. */
  features?: FeatureCollection<Point, HouseNumberFeatureProps>;
  /** Optional vector tile source URL (e.g. pmtiles://... or https://tiles/addr.json). */
  sourceUrl?: string;
  /** Source-layer name inside the vector tiles. Required if sourceUrl is set. */
  sourceLayer?: string;
  /** Defaults to 17.5 — below this zoom labels are not rendered at all. */
  minZoom?: number;
  /** Id used by other layers that want to reference this for `beforeId`. */
  id?: string;
}

const EMPTY: FeatureCollection<Point, HouseNumberFeatureProps> = {
  type: 'FeatureCollection',
  features: [],
};

export const HouseNumberLayer: React.FC<HouseNumberLayerProps> = ({
  features,
  sourceUrl,
  sourceLayer,
  minZoom = 17.5,
  id = 'house-numbers',
}) => {
  const useVectorTiles = !!sourceUrl;

  // The symbol layer is configured identically for both data-source styles —
  // only the parent <Source> and the layer's `source-layer` prop differ.
  const paint: any = {
    // Maximum legibility: dark text with a thick white halo you can read on any
    // map style (light, satellite, night). Halo is 2 px at all zooms.
    'text-color': '#111827',             // gray-900
    'text-halo-color': '#ffffff',
    'text-halo-width': 2,
    'text-halo-blur': 0.3,

    // Fade labels in smoothly as the driver zooms from block-level (17) to
    // doorstep (18). Below 17 they stay fully transparent (and the layer's
    // minzoom prunes them from render entirely below 17.5).
    'text-opacity': [
      'interpolate', ['linear'], ['zoom'],
      17, 0,
      17.5, 0.4,
      18, 1,
    ],
  };

  const layout: any = {
    // Uses the feature's `housenumber` property for both GeoJSON and vector
    // tile sources — rely on backend-side consistency.
    'text-field': ['get', 'housenumber'],

    // Bold but compact. OSM addr:housenumber values are usually 1–4 chars so
    // keep size tight to reduce collision-reject rate.
    'text-font': ['Noto Sans Bold', 'Open Sans Bold'],

    // Slight scale-up as the driver zooms in further — 12 → 16 px across 17→20.
    'text-size': [
      'interpolate', ['linear'], ['zoom'],
      17, 12,
      20, 16,
    ],

    // 2-pixel padding on each side for decluttering; collision is on by default.
    'text-padding': 2,
    'text-allow-overlap': false,
    'text-ignore-placement': false,

    // 3D perspective settings — these two are the crucial pair for driving mode:
    //   rotation-alignment:map     → label rotates with the street (readable
    //                                when the camera is yawed during a turn)
    //   pitch-alignment:viewport   → label stays upright on the driver's screen
    //                                rather than lying flat on the pavement
    'text-rotation-alignment': 'map',
    'text-pitch-alignment': 'viewport',

    // Anchor at the bottom so the number sits just above the property's point
    // coordinate (handy when your coordinates are at the building centroid).
    'text-anchor': 'bottom',
    'text-offset': [0, -0.2],
  };

  if (useVectorTiles) {
    return (
      <Source id={`${id}-src`} type="vector" url={sourceUrl}>
        <Layer
          id={id}
          type="symbol"
          source-layer={sourceLayer ?? 'housenumbers'}
          minzoom={minZoom}
          layout={layout}
          paint={paint}
        />
      </Source>
    );
  }

  return (
    <Source id={`${id}-src`} type="geojson" data={features ?? EMPTY}>
      <Layer
        id={id}
        type="symbol"
        minzoom={minZoom}
        layout={layout}
        paint={paint}
      />
    </Source>
  );
};

export default HouseNumberLayer;
