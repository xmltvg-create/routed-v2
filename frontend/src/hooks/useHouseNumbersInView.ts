/**
 * useHouseNumbersInView — hook that watches a MapLibre `MapRef`'s camera and,
 * whenever the camera idles at a high zoom (≥ 17 by default), fetches house
 * numbers inside the current viewport from `/api/housenumbers?bbox=...`.
 *
 * Why:
 *   The `<HouseNumberLayer />` needs GeoJSON point features with
 *   `properties.housenumber`. Rather than hard-binding the layer to a specific
 *   data source, we decouple it behind this hook so the map component stays
 *   pure and the tile-source strategy can swap (ArcGIS / Overpass / PMTiles)
 *   without touching the render layer.
 *
 * Behaviour:
 *   • Fires on every `moveend`, but debounced and gated by zoom.
 *   • Cancels an in-flight request if the camera moves again before it resolves.
 *   • Snaps the bbox to 4 decimal places so micro-pans don't cause a thrash of
 *     new requests (still ~11 m granularity — below the 20 m halo of collision).
 *   • Returns a stable FeatureCollection ({ type:'FeatureCollection', features:[] })
 *     when the zoom is below the threshold, so downstream layer data-binding
 *     can stay allocated without churn.
 *
 * Safety:
 *   • Hook is tolerant of `mapRef.current` being null during mount — it no-ops
 *     until the map is ready.
 *   • On fetch error we log once but keep the prior feature set so the map
 *     doesn't "blank" on transient upstream failures.
 */
import { useEffect, useRef, useState } from 'react';
import type { MapRef } from 'react-map-gl/maplibre';
import type { FeatureCollection, Point } from 'geojson';

interface HouseNumberFeatureProps {
  housenumber: string;
}

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

const EMPTY_FC: FeatureCollection<Point, HouseNumberFeatureProps> = {
  type: 'FeatureCollection',
  features: [],
};

function snapBbox(b: [number, number, number, number]): string {
  return b.map((v) => v.toFixed(4)).join(',');
}

export interface UseHouseNumbersOptions {
  /** Below this zoom the hook returns an empty FC without hitting the network. */
  minZoom?: number;
  /** Max features requested per bbox (passed through to backend). Default 400. */
  limit?: number;
  /** Debounce window in ms after `moveend` before we fetch. Default 250. */
  debounceMs?: number;
  /** Enable/disable externally (e.g. toggle off in list view). Default true. */
  enabled?: boolean;
}

export function useHouseNumbersInView(
  mapRef: React.RefObject<MapRef>,
  opts: UseHouseNumbersOptions = {},
): FeatureCollection<Point, HouseNumberFeatureProps> {
  const { minZoom = 17, limit = 400, debounceMs = 250, enabled = true } = opts;
  const [features, setFeatures] = useState<FeatureCollection<Point, HouseNumberFeatureProps>>(EMPTY_FC);
  const lastBboxKey = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !BACKEND_URL) return;
    const map = mapRef.current?.getMap?.();
    if (!map) return;

    const fetchHouseNumbers = () => {
      const zoom = map.getZoom();
      if (zoom < minZoom) {
        // Below threshold — empty the layer but don't hit network.
        if (features.features.length > 0) setFeatures(EMPTY_FC);
        return;
      }
      const b = map.getBounds();
      const bbox: [number, number, number, number] = [
        b.getWest(),
        b.getSouth(),
        b.getEast(),
        b.getNorth(),
      ];
      const key = snapBbox(bbox);
      if (key === lastBboxKey.current) return;
      lastBboxKey.current = key;

      // Cancel prior in-flight fetch.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      fetch(
        `${BACKEND_URL}/api/housenumbers?bbox=${key}&limit=${limit}`,
        { signal: ctrl.signal },
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data || !data.features) return;
          setFeatures(data as FeatureCollection<Point, HouseNumberFeatureProps>);
        })
        .catch((err) => {
          if (err?.name !== 'AbortError') {
            // Swallow transient upstream failures — keep showing previous.
            // eslint-disable-next-line no-console
            console.warn('[useHouseNumbersInView] fetch failed:', err);
          }
        });
    };

    const onMoveEnd = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(fetchHouseNumbers, debounceMs);
    };

    map.on('moveend', onMoveEnd);
    // Run once at mount in case the map is already idle at a high zoom.
    onMoveEnd();

    return () => {
      map.off('moveend', onMoveEnd);
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
    // features intentionally omitted — we read via setFeatures and never
    // resubscribe when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, enabled, minZoom, limit, debounceMs]);

  return features;
}

export default useHouseNumbersInView;
