/**
 * DeliveryMap — react-map-gl (MapLibre fork) component
 *
 * Architecture:
 *  1. WebGL-only layers (no HTML <Marker>). Stops -> GeoJSON FeatureCollection -> <Layer type="circle">/<Layer type="symbol">.
 *  2. Uncontrolled camera — MapLibre owns its viewport. Programmatic moves via mapRef.flyTo/jumpTo.
 *     React state synced lazily on onMoveEnd only.
 *  3. Fixed stop IDs — feature.id === stop.id (string), never mutated.
 *  4. No multiplier badges on the map — x5 grouping lives only in UI stop cards.
 *  5. Route line — single stable <Source>/<Layer type="line">. Updates swap data, never remount.
 *  6. 3D buildings enabled in follow/nav mode via fill-extrusion layer.
 *  7. Smooth camera with flyTo easing during driver follow.
 *  8. HUD overlays for speed/ETA and next-turn instruction.
 *  9. Animated route pulse via line-dasharray cycling.
 */

import React, { useRef, useCallback, useMemo, useEffect, useImperativeHandle, forwardRef, useState } from 'react';
import { Platform, View, Text, StyleSheet } from 'react-native';

// react-map-gl + MapLibre
import Map, { Source, Layer, MapRef, ViewStateChangeEvent, MapLayerMouseEvent } from 'react-map-gl/maplibre';
import type { LayerProps } from 'react-map-gl/maplibre';
import type { MapLibreEvent } from 'maplibre-gl';
import { HouseNumberLayer } from './map/HouseNumberLayer';
import { useHouseNumbersInView } from '../hooks/useHouseNumbersInView';
import { toRouteFeatureCollection } from '../utils/routeGeometry';

// Only import CSS on web (expo-router auto-strips this on native builds)
if (Platform.OS === 'web') {
  require('maplibre-gl/dist/maplibre-gl.css');
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeliveryStop {
  id: string;
  latitude: number;
  longitude: number;
  address?: string;
  name?: string;
  order: number;
  completed?: boolean;
}

export interface DriverLocation {
  latitude: number;
  longitude: number;
  heading: number;
}

export interface NextTurnInfo {
  instruction: string;
  distance: string;
}

export interface DeliveryMapRef {
  flyTo: (center: [number, number], opts?: { zoom?: number; bearing?: number; pitch?: number; duration?: number }) => void;
  jumpTo: (center: [number, number], opts?: { bearing?: number; pitch?: number }) => void;
  fitBounds: (bounds: [[number, number], [number, number]], padding?: number) => void;
  setDrawingMode?: (enabled: boolean) => void;
  clearLasso?: () => void;
  addSectionPolygon?: (id: number, coords: number[][], color: string, label: string) => void;
  removeSectionPolygon?: (id: number) => void;
  clearAllSectionPolygons?: () => void;
  toggleParcels?: (enabled: boolean) => void;
  sendMessage?: (msg: object) => void;
  /** Web-variant stubs of native-only imperative methods, kept for type
   *  parity so the same `DeliveryMapRef` works across platforms. The
   *  native WebView implements these; the web canvas no-ops. */
  setBlockRoadMode?: (enabled: boolean) => void;
  setNogoZones?: (zones: Array<{ id: string; name?: string; polygon: number[][] }>) => void;
  setRouteConfirmed?: (confirmed: boolean) => void;
  /** Force-clear the cached fingerprint so the next stops-effect tick
   *  re-ships every feature to the WebView. Use after POST /api/routes/confirm
   *  to guarantee the blue→red flip lands even on partial JSON. */
  forceStopsRefresh?: () => void;
  getMap: () => maplibregl.Map | null;
}

interface DeliveryMapProps {
  stops: DeliveryStop[];
  routeCoordinates: number[][] | null;
  /** Render the route polyline as a dashed line — matches the planning-
   *  preview style on the native variant. The web variant currently
   *  ignores this flag (kept for API parity); apply the dash if/when
   *  the web map needs it. */
  routeIsPreview?: boolean;
  driverLocation: DriverLocation | null;
  traveledPath: number[][] | null;
  mapStyle?: string;
  initialCenter?: [number, number];
  initialZoom?: number;
  followDriver?: boolean;
  onStopClick?: (stopId: string) => void;
  onCameraIdle?: (center: { lng: number; lat: number }, zoom: number) => void;
  onMapReady?: () => void;
  /** HUD: current speed in km/h */
  speed?: number | null;
  /** HUD: ETA in minutes to next stop */
  etaMinutes?: number | null;
  /** HUD: remaining distance string (e.g. "1.2 km") */
  distanceRemaining?: string | null;
  /** HUD: next turn instruction */
  nextTurn?: NextTurnInfo | null;
  nextStopCoord?: [number, number] | null;
  /** Web no-op — native-only. Parent passes same prop to both. */
  nextStopColor?: string | null;
}

// ─── Map Styles ───────────────────────────────────────────────────────────────

const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

// ─── Layer Styles (static objects — never recreated) ──────────────────────────

const routeLineLayer: LayerProps = {
  id: 'route-line',
  type: 'line',
  paint: {
    'line-color': '#6366f1',
    'line-width': 5,
    'line-opacity': 0.85,
  },
  layout: {
    'line-join': 'round',
    'line-cap': 'round',
  },
};

// Animated pulse line on top of route
const routePulseLayer: LayerProps = {
  id: 'route-pulse',
  type: 'line',
  paint: {
    'line-color': '#a5b4fc',
    'line-width': 3,
    'line-opacity': 0.6,
    'line-dasharray': [0, 4, 3],
  },
  layout: {
    'line-join': 'round',
    'line-cap': 'round',
  },
};

const traveledLineLayer: LayerProps = {
  id: 'traveled-line',
  type: 'line',
  paint: {
    'line-color': '#22c55e',
    'line-width': 4,
    'line-opacity': 0.7,
  },
  layout: {
    'line-join': 'round',
    'line-cap': 'round',
  },
};

// ─── Stop pin layers (Method A: stacked circles for classic red pin) ──────────
// Bottom: red outer pin (#e53e31), Top: white inner dot — pure WebGL, zero DOM markers

const stopPinShadowLayer: LayerProps = {
  id: 'stops-shadow',
  type: 'circle',
  paint: {
    'circle-radius': [
      'interpolate', ['linear'], ['zoom'],
      10, 8,
      14, 12,
      18, 16,
    ],
    'circle-color': 'rgba(0, 0, 0, 0.25)',
    'circle-blur': 0.6,
    'circle-translate': [0, 2],
  },
};

const stopPinOuterLayer: LayerProps = {
  id: 'stops-pin-outer',
  type: 'circle',
  paint: {
    'circle-radius': [
      'interpolate', ['linear'], ['zoom'],
      10, 7,
      14, 11,
      18, 15,
    ],
    'circle-color': [
      'case',
      ['==', ['get', 'completed'], true], '#22c55e',
      '#e53e31',
    ],
    'circle-stroke-width': 2,
    'circle-stroke-color': '#ffffff',
  },
};

const stopPinInnerLayer: LayerProps = {
  id: 'stops-pin-inner',
  type: 'circle',
  paint: {
    'circle-radius': [
      'interpolate', ['linear'], ['zoom'],
      10, 2.5,
      14, 4,
      18, 5.5,
    ],
    'circle-color': '#ffffff',
  },
};

const stopLabelLayer: LayerProps = {
  id: 'stops-label',
  type: 'symbol',
  layout: {
    'text-field': ['to-string', ['get', 'order']],
    'text-size': [
      'interpolate', ['linear'], ['zoom'],
      10, 8,
      14, 11,
      18, 14,
    ],
    'text-font': ['Open Sans Bold'],
    'text-allow-overlap': true,
    'text-ignore-placement': true,
    'text-anchor': 'center',
    'text-offset': [0, -0.05],
  },
  paint: {
    'text-color': '#ffffff',
    'text-halo-color': 'rgba(0,0,0,0.4)',
    'text-halo-width': 0.8,
  },
};

const driverArrowLayer: LayerProps = {
  id: 'driver-arrow',
  type: 'symbol',
  layout: {
    'text-field': '\u25B2',
    'text-size': 24,
    'text-rotate': ['coalesce', ['to-number', ['get', 'bearing']], 0],
    'text-rotation-alignment': 'map',
    'text-allow-overlap': true,
    'text-ignore-placement': true,
    'text-anchor': 'center',
  },
  paint: {
    'text-color': '#3b82f6',
    'text-halo-color': '#ffffff',
    'text-halo-width': 2.5,
  },
};

const driverPulseLayer: LayerProps = {
  id: 'driver-pulse',
  type: 'circle',
  paint: {
    'circle-radius': 20,
    'circle-color': 'rgba(59, 130, 246, 0.15)',
    'circle-stroke-width': 0,
  },
};

// 3D Building extrusion layer (targets OpenMapTiles building source-layer)
// Uses render_height / render_min_height from vector tiles with:
//  - Height-based color gradient (low=warm gray, tall=cool steel blue)
//  - Progressive extrusion: buildings grow from flat to full height as you zoom 13→16
//  - Filters out hide_3d features (building outlines not meant for 3D)
const building3dLayer: LayerProps = {
  id: 'building-3d',
  type: 'fill-extrusion',
  source: 'openmaptiles',
  'source-layer': 'building',
  minzoom: 13,
  filter: ['!=', ['get', 'hide_3d'], true],
  paint: {
    'fill-extrusion-color': [
      'interpolate', ['linear'], ['coalesce', ['to-number', ['get', 'render_height']], 8],
      0, '#d4d4d8',   // zinc-300 — low buildings
      15, '#a1a1aa',  // zinc-400 — mid-rise
      40, '#78716c',  // stone-500 — tall
      100, '#64748b', // slate-500 — high-rise
    ],
    'fill-extrusion-height': [
      'interpolate', ['linear'], ['zoom'],
      13, 0,
      15, ['*', 0.5, ['coalesce', ['to-number', ['get', 'render_height']], 8]],
      16, ['coalesce', ['to-number', ['get', 'render_height']], 8],
    ],
    'fill-extrusion-base': [
      'case',
      ['>=', ['zoom'], 15],
      ['coalesce', ['to-number', ['get', 'render_min_height']], 0],
      0,
    ],
    'fill-extrusion-opacity': [
      'interpolate', ['linear'], ['zoom'],
      13, 0.3,
      15, 0.6,
      17, 0.75,
    ],
  },
};

// ─── Self-hosted building tile loader ──────────────────────────────────────────
// Fetches GeoJSON tiles from /api/tiles/buildings/{z}/{x}/{y}.json based on viewport

const BUILDING_TILE_ZOOM = 14;
const _tileCache: Record<string, GeoJSON.Feature[]> = {};

function lngToTileX(lng: number, z: number): number {
  return Math.floor((lng + 180) / 360 * (1 << z));
}
function latToTileY(lat: number, z: number): number {
  const r = Math.PI / 180 * lat;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z));
}

async function fetchBuildingTiles(bounds: { west: number; south: number; east: number; north: number }): Promise<GeoJSON.FeatureCollection> {
  const z = BUILDING_TILE_ZOOM;
  const xMin = lngToTileX(bounds.west, z);
  const xMax = lngToTileX(bounds.east, z);
  const yMin = latToTileY(bounds.north, z);
  const yMax = latToTileY(bounds.south, z);

  const features: GeoJSON.Feature[] = [];
  const fetches: Promise<void>[] = [];

  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      const key = `${z}/${x}/${y}`;
      if (_tileCache[key]) {
        features.push(..._tileCache[key]);
        continue;
      }
      fetches.push(
        fetch(`${BACKEND_URL}/api/tiles/buildings/${key}.json`)
          .then(r => r.json())
          .then((fc: GeoJSON.FeatureCollection) => {
            _tileCache[key] = fc.features;
            features.push(...fc.features);
          })
          .catch(() => { _tileCache[key] = []; })
      );
    }
  }
  await Promise.all(fetches);
  return { type: 'FeatureCollection', features };
}

// Self-hosted building extrusion layer (reads from the 'buildings-self' GeoJSON source)
const selfHostedBuildingLayer: LayerProps = {
  id: 'buildings-self-3d',
  type: 'fill-extrusion',
  paint: {
    'fill-extrusion-color': [
      'interpolate', ['linear'], ['coalesce', ['to-number', ['get', 'render_height']], 8],
      0, '#d4d4d8',
      6, '#c4b5a0',   // warm — houses
      15, '#a1a1aa',   // mid-rise
      40, '#78716c',   // tall
      100, '#64748b',  // high-rise
    ],
    'fill-extrusion-height': [
      'interpolate', ['linear'], ['zoom'],
      13, 0,
      15, ['*', 0.5, ['coalesce', ['to-number', ['get', 'render_height']], 8]],
      16, ['coalesce', ['to-number', ['get', 'render_height']], 8],
    ],
    'fill-extrusion-base': [
      'coalesce', ['to-number', ['get', 'render_min_height']], 0,
    ],
    'fill-extrusion-opacity': [
      'interpolate', ['linear'], ['zoom'],
      13, 0.35,
      15, 0.65,
      17, 0.8,
    ],
  },
};

// ─── GeoJSON Builders (pure functions, stable references via useMemo) ─────────

function buildStopsGeoJSON(stops: DeliveryStop[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: stops
      .filter(s => s.latitude != null && s.longitude != null)
      .map(s => ({
        type: 'Feature' as const,
        id: s.id,
        geometry: {
          type: 'Point' as const,
          coordinates: [s.longitude, s.latitude],
        },
        properties: {
          stop_id: s.id,
          order: s.order,
          completed: s.completed ?? false,
          name: s.name ?? '',
          address: s.address ?? '',
        },
      })),
  };
}

/**
 * Build a rendering-safe GeoJSON FeatureCollection for a route polyline.
 *
 * Hardened against the four classic MapLibre line-rendering failure modes:
 *   • Wrong shape — caller accidentally passes a raw `number[][]` as `data`
 *     (fixed here — we always wrap into a FeatureCollection<LineString>).
 *   • Swapped axes — backends that hand us [lat, lng] instead of the spec's
 *     [lng, lat]. We run a cheap heuristic sampler and flip them if so.
 *   • Non-finite or out-of-range values — silently dropped (no `NaN`
 *     coordinates slip through into the WebGL buffer).
 *   • Stale reference — the returned object / array / coordinate tuple are
 *     ALL freshly allocated, so MapLibre's source diff will always trigger
 *     a repaint even when the logical content is unchanged by 1–2 points.
 *
 * For deep docs see `utils/routeGeometry.ts`.
 */
function buildLineGeoJSON(coordinates: number[][] | null): GeoJSON.FeatureCollection {
  return toRouteFeatureCollection(coordinates, { autoFlipLatLng: true });
}

function buildDriverGeoJSON(loc: DriverLocation | null): GeoJSON.FeatureCollection {
  if (!loc) {
    return { type: 'FeatureCollection', features: [] };
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { bearing: loc.heading ?? 0 },
        geometry: {
          type: 'Point',
          coordinates: [loc.longitude, loc.latitude],
        },
      },
    ],
  };
}

// ─── HUD Components ───────────────────────────────────────────────────────────

function NextTurnHUD({ nextTurn }: { nextTurn: NextTurnInfo }) {
  return (
    <View style={hudStyles.turnContainer} data-testid="next-turn-hud">
      <Text style={hudStyles.turnInstruction}>{nextTurn.instruction}</Text>
      <Text style={hudStyles.turnDistance}>{nextTurn.distance}</Text>
    </View>
  );
}

function SpeedEtaHUD({ speed, etaMinutes, distanceRemaining }: {
  speed?: number | null;
  etaMinutes?: number | null;
  distanceRemaining?: string | null;
}) {
  const hasData = speed != null || etaMinutes != null || distanceRemaining != null;
  if (!hasData) return null;
  return (
    <View style={hudStyles.bottomBar} data-testid="speed-eta-hud">
      {speed != null && (
        <View style={hudStyles.hudCell}>
          <Text style={hudStyles.hudValue}>{Math.round(speed)}</Text>
          <Text style={hudStyles.hudLabel}>km/h</Text>
        </View>
      )}
      {etaMinutes != null && (
        <View style={hudStyles.hudCell}>
          <Text style={hudStyles.hudValue}>{Math.round(etaMinutes)}</Text>
          <Text style={hudStyles.hudLabel}>min</Text>
        </View>
      )}
      {distanceRemaining != null && (
        <View style={hudStyles.hudCell}>
          <Text style={hudStyles.hudValue}>{distanceRemaining}</Text>
          <Text style={hudStyles.hudLabel}>left</Text>
        </View>
      )}
    </View>
  );
}

const hudStyles = StyleSheet.create({
  turnContainer: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 12 : 50,
    left: 60,
    right: 60,
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(12px)' } as any : {}),
    zIndex: 10,
  },
  turnInstruction: {
    color: '#f1f5f9',
    fontSize: 16,
    fontWeight: '700',
  },
  turnDistance: {
    color: '#94a3b8',
    fontSize: 13,
    marginTop: 2,
  },
  bottomBar: {
    position: 'absolute',
    bottom: Platform.OS === 'web' ? 16 : 34,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderRadius: 16,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    paddingVertical: 14,
    paddingHorizontal: 10,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(12px)' } as any : {}),
    zIndex: 10,
  },
  hudCell: {
    alignItems: 'center',
    minWidth: 70,
  },
  hudValue: {
    color: '#f1f5f9',
    fontSize: 22,
    fontWeight: '800',
  },
  hudLabel: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 1,
  },
});

// ─── Component ────────────────────────────────────────────────────────────────

const DeliveryMapInner = forwardRef<DeliveryMapRef, DeliveryMapProps>(function DeliveryMap(
  {
    stops,
    routeCoordinates,
    driverLocation,
    traveledPath,
    mapStyle,
    initialCenter,
    initialZoom = 13,
    followDriver = false,
    onStopClick,
    onCameraIdle,
    onMapReady,
    speed,
    etaMinutes,
    distanceRemaining,
    nextTurn,
  },
  ref,
) {
  const mapRef = useRef<MapRef>(null);
  const isUserInteracting = useRef(false);
  const interactionTimer = useRef<ReturnType<typeof setTimeout>>();
  const isFlyingRef = useRef(false);
  const [buildings3d, setBuildings3d] = useState(false);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [selfHostedBuildings, setSelfHostedBuildings] = useState<GeoJSON.FeatureCollection>({ type: 'FeatureCollection', features: [] });
  const loadingTilesRef = useRef(false);

  // Enable 3D buildings automatically when following driver
  useEffect(() => {
    setBuildings3d(followDriver);
  }, [followDriver]);

  // ── Imperative handle ──────────────────────────────────────────────────────

  useImperativeHandle(ref, () => ({
    flyTo: (center, opts = {}) => {
      mapRef.current?.flyTo({
        center,
        zoom: opts.zoom,
        bearing: opts.bearing ?? 0,
        pitch: opts.pitch ?? 0,
        duration: opts.duration ?? 1000,
      });
    },
    jumpTo: (center, opts = {}) => {
      mapRef.current?.jumpTo({
        center,
        bearing: opts.bearing ?? 0,
        pitch: opts.pitch ?? 0,
      });
    },
    fitBounds: (bounds, padding = 60) => {
      mapRef.current?.fitBounds(bounds, { padding, duration: 500 });
    },
    getMap: () => mapRef.current?.getMap() ?? null,

    // ── Native-only methods — exposed as no-op stubs on web so callers from the
    //    shared `app/(tabs)/index.tsx` don't crash with "X is not a function".
    //    These features (parcel tiles, lasso drawing, section polygons,
    //    imperative WebView messaging) only have implementations inside the
    //    injected MapLibre HTML in DeliveryMap.native.tsx.
    sendMessage: (_msg: object) => {},
    toggleParcels: (_enabled: boolean) => {},
    setDrawingMode: (_on: boolean) => {},
    clearLasso: () => {},
    addSectionPolygon: (
      _sectionId: number,
      _polygon: number[][],
      _color: string,
      _label: string,
    ) => {},
    removeSectionPolygon: (_sectionId: number) => {},
    clearAllSectionPolygons: () => {},
  }));

  // ── (c) Smooth camera follow with flyTo easing ────────────────────────────

  useEffect(() => {
    if (!followDriver || !driverLocation || isUserInteracting.current) return;
    if (isFlyingRef.current) return; // skip if previous flyTo still in-flight

    const LOOK_AHEAD = 0.0004;
    const hdg = driverLocation.heading ?? 0;
    const lng = driverLocation.longitude + Math.sin(hdg * Math.PI / 180) * LOOK_AHEAD;
    const lat = driverLocation.latitude + Math.cos(hdg * Math.PI / 180) * LOOK_AHEAD;

    isFlyingRef.current = true;
    mapRef.current?.flyTo({
      center: [lng, lat],
      bearing: hdg,
      pitch: 65,
      duration: 400,
      essential: true,
    } as any);

    // Reset flying flag after animation completes
    setTimeout(() => { isFlyingRef.current = false; }, 420);
  }, [driverLocation, followDriver]);

  // ── (g) Animated route pulse via line-dasharray cycling ────────────────────

  useEffect(() => {
    if (!followDriver) return;
    const map = mapRef.current?.getMap();
    if (!map) return;

    let frame = 0;
    let rafId: number;
    const dashArraySeq = [
      [0, 4, 3],
      [0.5, 4, 2.5],
      [1, 4, 2],
      [1.5, 4, 1.5],
      [2, 4, 1],
      [2.5, 4, 0.5],
      [3, 4, 0],
      [0, 0.5, 3, 3.5],
      [0, 1, 3, 3],
      [0, 1.5, 3, 2.5],
      [0, 2, 3, 2],
      [0, 2.5, 3, 1.5],
      [0, 3, 3, 1],
      [0, 3.5, 3, 0.5],
    ];

    let lastTime = 0;
    const animate = (time: number) => {
      if (time - lastTime > 80) { // ~12fps for the dash animation
        lastTime = time;
        frame = (frame + 1) % dashArraySeq.length;
        if (map.getLayer('route-pulse')) {
          map.setPaintProperty('route-pulse', 'line-dasharray', dashArraySeq[frame]);
        }
      }
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(rafId);
  }, [followDriver]);

  // ── User interaction tracking (touch = pause follow) ───────────────────────

  const handleMoveStart = useCallback((evt: ViewStateChangeEvent) => {
    if ((evt as any).originalEvent) {
      isUserInteracting.current = true;
      clearTimeout(interactionTimer.current);
    }
  }, []);

  const handleMoveEnd = useCallback((evt: ViewStateChangeEvent) => {
    if (isUserInteracting.current) {
      interactionTimer.current = setTimeout(() => {
        isUserInteracting.current = false;
      }, 3000);
    }
    const center = evt.viewState;
    onCameraIdle?.({ lng: center.longitude, lat: center.latitude }, center.zoom);

    // Load self-hosted building tiles for the visible viewport
    if (buildings3d && center.zoom >= 13 && !loadingTilesRef.current) {
      const map = mapRef.current?.getMap();
      if (map) {
        const bounds = map.getBounds();
        loadingTilesRef.current = true;
        fetchBuildingTiles({
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        }).then(fc => {
          setSelfHostedBuildings(fc);
        }).finally(() => { loadingTilesRef.current = false; });
      }
    }
  }, [onCameraIdle, buildings3d]);

  // ── Stop click handler ─────────────────────────────────────────────────────

  const handleClick = useCallback((evt: MapLayerMouseEvent) => {
    const feature = evt.features?.[0];
    if (feature && feature.properties?.stop_id) {
      onStopClick?.(feature.properties.stop_id);
    }
  }, [onStopClick]);

  // ── Memoized GeoJSON ────────────────────────────────────────────────────────

  const stopsGeoJSON = useMemo(() => buildStopsGeoJSON(stops), [stops]);
  const routeGeoJSON = useMemo(() => buildLineGeoJSON(routeCoordinates), [routeCoordinates]);
  const traveledGeoJSON = useMemo(() => buildLineGeoJSON(traveledPath), [traveledPath]);
  const driverGeoJSON = useMemo(() => buildDriverGeoJSON(driverLocation), [driverLocation]);

  // ── House numbers in view ──────────────────────────────────────────────────
  // Watches the camera — when the driver zooms to ≥ 17 the hook fetches point
  // addresses in the viewport from `/api/housenumbers` and feeds them into the
  // <HouseNumberLayer /> below. Below zoom 17 the hook returns an empty FC so
  // the layer is cheap even when panning around at overview scales.
  const houseNumbersFC = useHouseNumbersInView(mapRef, { minZoom: 17 });

  // ── Initial camera ──────────────────────────────────────────────────────────

  const initialViewState = useMemo(() => ({
    longitude: initialCenter?.[0] ?? stops[0]?.longitude ?? 153.13,
    latitude: initialCenter?.[1] ?? stops[0]?.latitude ?? -26.73,
    zoom: initialZoom,
    pitch: 0,
    bearing: 0,
  }), []); // intentionally empty — only read on mount

  const handleLoad = useCallback((_evt: MapLibreEvent) => {
    setStyleLoaded(true);
    onMapReady?.();
  }, [onMapReady]);

  const interactiveLayerIds = useMemo(() => ['stops-pin-outer', 'stops-pin-inner', 'stops-label'], []);

  return (
    <View style={{ flex: 1 }}>
      <Map
        ref={mapRef}
        initialViewState={initialViewState}
        mapStyle={mapStyle || OPENFREEMAP_STYLE}
        style={{ width: '100%', height: '100%' }}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        onClick={handleClick}
        onLoad={handleLoad}
        interactiveLayerIds={interactiveLayerIds}
        cursor="auto"
        attributionControl={false}
        reuseMaps
      >
        {/* (a) 3D Buildings — base map (openmaptiles) as fallback */}
        {buildings3d && (
          <Layer {...building3dLayer} />
        )}

        {/* Self-hosted building tiles — richer height data from Queensland OSM */}
        {buildings3d && selfHostedBuildings.features.length > 0 && (
          <Source id="buildings-self" type="geojson" data={selfHostedBuildings}>
            <Layer {...selfHostedBuildingLayer} />
          </Source>
        )}

        {/* Route driving line */}
        <Source id="route" type="geojson" data={routeGeoJSON}>
          <Layer {...routeLineLayer} />
          {/* (g) Animated pulse overlay on route */}
          {followDriver && <Layer {...routePulseLayer} />}
        </Source>

        {/* Traveled path overlay */}
        <Source id="traveled" type="geojson" data={traveledGeoJSON}>
          <Layer {...traveledLineLayer} />
        </Source>

        {/* Delivery stops — stacked WebGL circles (Method A: red pin + white inner) */}
        {styleLoaded && (
          <Source id="stops" type="geojson" data={stopsGeoJSON}>
            <Layer {...stopPinShadowLayer} />
            <Layer {...stopPinOuterLayer} />
            <Layer {...stopPinInnerLayer} />
            <Layer {...stopLabelLayer} />
          </Source>
        )}

        {/* Driver location puck */}
        <Source id="driver" type="geojson" data={driverGeoJSON}>
          <Layer {...driverPulseLayer} />
          <Layer {...driverArrowLayer} />
        </Source>

        {/* House/property numbers — hidden below zoom 17.5; data fed by
            useHouseNumbersInView (fetches /api/housenumbers on moveend). */}
        <HouseNumberLayer features={houseNumbersFC} />
      </Map>

      {/* (e) Next turn instruction HUD */}
      {followDriver && nextTurn && <NextTurnHUD nextTurn={nextTurn} />}

      {/* (d) Speed / ETA / Distance HUD */}
      {followDriver && (
        <SpeedEtaHUD
          speed={speed}
          etaMinutes={etaMinutes}
          distanceRemaining={distanceRemaining}
        />
      )}
    </View>
  );
});

export const DeliveryMap = React.memo(DeliveryMapInner);
export default DeliveryMap;
