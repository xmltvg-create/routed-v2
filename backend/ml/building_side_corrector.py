"""
RouTeD Phase 2 ML — Building-Side Corrector
============================================

Purpose
-------
Mapbox / OSRM return rooftop centroids for delivery addresses. Drivers
actually park at the kerb, which on a typical suburban street is 10–20 m
offset from the rooftop. On large industrial complexes the offset can
exceed 80 m. We can SEE this offset every time a driver taps Delivered:
the vector from the address centroid to the driver's GPS at completion
time IS the building-side correction.

Aggregating those vectors by suburb (and falling back globally for
unfamiliar suburbs) gives us a predicted "real" arrival point for every
new stop — even when Mapbox didn't supply an `access_navigation_point`.

Two consumers
-------------
  1. Geofence arrival check — instead of "am I within 100 m of the
     centroid?", we check "am I within 100 m of the centroid OR within
     100 m of (centroid + learned_offset)?". Should lift the real
     geofence hit rate (currently 82 %) closer to 95 % without
     widening the radius (which would invite false positives).
  2. Future geocoding — when a fresh address has no
     `access_navigation_point`, infer one from the learned offset.

Vector aggregation
------------------
We use the per-axis median (not the centroid mean) because the median
is robust to outliers — one driver who parked 300 m away because the
gate was locked won't drag the whole suburb's offset. Per-axis median
is a defensible approximation of geometric median for small-to-medium
vector counts (<10⁴), which is all we'll ever see per suburb.

Minimum sample threshold
------------------------
A 1-sample offset is noise. We require BUCKET_MIN_SAMPLES=5 per
suburb before publishing a correction — below that, we use the global
median (computed across all suburbs combined).

Quality bar
-----------
- Source rows: arrival_method='geofence' OR 'geofence_inferred'
  (both supply real `completion_lat/lng` data; pure fallback_completion
  is just a 30-second back-date and would poison the offset)
- Outlier clamp: |offset_m| ≤ 250 m. Anything beyond is more likely a
  GPS error or a driver who parked illegally far away than a real
  building-side correction.
- Output is always (Δlat, Δlng) in degrees — the unit the geofence
  hook uses internally — so consumers don't need to convert.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import median
from typing import Any, Dict, List, Optional, Tuple

import logging
import math

logger = logging.getLogger("server")


# ── Constants ────────────────────────────────────────────────────────────
BUCKET_MIN_SAMPLES: int = 5
OUTLIER_MAX_METRES: float = 250.0
MODEL_VERSION: int = 1
# Approx metres-per-degree at the equator. Used only for outlier
# clamping — the model itself stores Δlat/Δlng as native degrees, so
# downstream code doesn't need this constant.
METRES_PER_DEG_LAT: float = 111_000.0


@dataclass
class CorrectionSample:
    """One archived stop's centroid-to-completion offset observation."""
    delta_lat: float       # degrees, completion_lat - centroid_lat
    delta_lng: float       # degrees, completion_lng - centroid_lng
    suburb: Optional[str]  # lowercase, trimmed; None for blank


def _clean_suburb(s: Any) -> Optional[str]:
    if not isinstance(s, str):
        return None
    s = s.strip().lower()
    return s or None


def _offset_metres(d_lat: float, d_lng: float, ref_lat: float) -> float:
    """Convert a (Δlat, Δlng) pair to approximate magnitude in metres,
    using the WGS-84 metres-per-degree at ref_lat for the longitude
    component. Cheap, accurate to ~1% within Australia."""
    m_lat = d_lat * METRES_PER_DEG_LAT
    m_lng = d_lng * METRES_PER_DEG_LAT * math.cos(math.radians(ref_lat))
    return math.hypot(m_lat, m_lng)


# ── Sample collection ────────────────────────────────────────────────────


def collect_samples_from_archive(routes: List[dict]) -> List[CorrectionSample]:
    """Walk archived routes and emit one CorrectionSample per stop with
    both `latitude/longitude` (centroid) and `completion_lat/lng`. We
    accept both `geofence` and `geofence_inferred` rows because both
    supply genuine completion GPS — only `fallback_completion` is
    excluded (constant back-date, no GPS-quality signal)."""
    samples: List[CorrectionSample] = []
    for route in routes:
        for stop in route.get("stops") or []:
            method = stop.get("arrival_method")
            if method not in ("geofence", "geofence_inferred"):
                continue
            try:
                c_lat = float(stop["latitude"])
                c_lng = float(stop["longitude"])
                comp_lat = float(stop["completion_lat"])
                comp_lng = float(stop["completion_lng"])
            except (KeyError, TypeError, ValueError):
                continue
            d_lat = comp_lat - c_lat
            d_lng = comp_lng - c_lng
            if _offset_metres(d_lat, d_lng, c_lat) > OUTLIER_MAX_METRES:
                continue
            samples.append(CorrectionSample(
                delta_lat=d_lat,
                delta_lng=d_lng,
                suburb=_clean_suburb(stop.get("suburb")),
            ))
    return samples


# ── Model building ───────────────────────────────────────────────────────


def build_model_from_samples(samples: List[CorrectionSample]) -> Dict[str, Any]:
    """Compute per-axis medians at two levels:
        (suburb,)  — only kept if ≥ BUCKET_MIN_SAMPLES samples
        ()         — global fallback, always emitted

    Returned shape (Mongo-friendly, replace-once-per-train):
        {
          "version": 1,
          "trained_at": iso,
          "sample_count": int,
          "global_delta_lat": float,
          "global_delta_lng": float,
          "global_offset_metres": float,    # diagnostic only
          "suburbs": {
              "maroochydore": {
                  "delta_lat": float,
                  "delta_lng": float,
                  "offset_metres": float,    # diagnostic
                  "n": int,
              },
              ...
          },
        }
    """
    by_suburb: Dict[str, List[Tuple[float, float, float]]] = {}
    all_pairs: List[Tuple[float, float, float]] = []

    # Buffer per-axis values + ref_lat for the metres diagnostic.
    for s in samples:
        # We don't have the centroid lat here directly, but we don't
        # need it for the per-axis median — only for the diagnostic
        # `offset_metres`. Use the midpoint of the dataset's medians
        # later, which is sufficiently close in any one suburb.
        if s.suburb:
            by_suburb.setdefault(s.suburb, []).append((s.delta_lat, s.delta_lng, 0.0))
        all_pairs.append((s.delta_lat, s.delta_lng, 0.0))

    def _median_pair(rows: List[Tuple[float, float, float]]) -> Tuple[float, float]:
        d_lat = median(r[0] for r in rows)
        d_lng = median(r[1] for r in rows)
        return d_lat, d_lng

    suburbs: Dict[str, Dict[str, Any]] = {}
    for sub, rows in by_suburb.items():
        if len(rows) < BUCKET_MIN_SAMPLES:
            continue
        d_lat, d_lng = _median_pair(rows)
        # Diagnostic metres assume Sunshine Coast latitude (~-26.6°)
        # for the longitude conversion. Drivers in other regions get
        # a slightly off display number but the model itself is exact.
        suburbs[sub] = {
            "delta_lat": round(d_lat, 7),
            "delta_lng": round(d_lng, 7),
            "offset_metres": round(_offset_metres(d_lat, d_lng, -26.6), 1),
            "n": len(rows),
        }

    if all_pairs:
        g_lat, g_lng = _median_pair(all_pairs)
        global_offset_m = round(_offset_metres(g_lat, g_lng, -26.6), 1)
    else:
        g_lat = g_lng = 0.0
        global_offset_m = 0.0

    return {
        "version": MODEL_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "sample_count": len(samples),
        "global_delta_lat": round(g_lat, 7),
        "global_delta_lng": round(g_lng, 7),
        "global_offset_metres": global_offset_m,
        "suburbs": suburbs,
    }


# ── Prediction ───────────────────────────────────────────────────────────


def predict_correction(
    stop: Dict[str, Any],
    model: Optional[Dict[str, Any]],
) -> Tuple[float, float]:
    """Return (Δlat, Δlng) in degrees. Fallback chain:
        suburb-bucket → global-median → (0, 0)

    Add the returned offset to the stop's centroid to get the predicted
    real arrival point:
        real_lat = stop['latitude']  + Δlat
        real_lng = stop['longitude'] + Δlng
    """
    if not model:
        return (0.0, 0.0)
    suburb = _clean_suburb(stop.get("suburb"))
    if suburb:
        cell = (model.get("suburbs") or {}).get(suburb)
        if cell:
            return (float(cell["delta_lat"]), float(cell["delta_lng"]))
    g_lat = float(model.get("global_delta_lat", 0.0))
    g_lng = float(model.get("global_delta_lng", 0.0))
    return (g_lat, g_lng)


def predict_corrected_centroid(
    stop: Dict[str, Any],
    model: Optional[Dict[str, Any]],
) -> Optional[Tuple[float, float]]:
    """Convenience: returns the corrected (lat, lng) directly, or None
    if the stop is missing coords or no correction is meaningful (i.e.
    model is None AND no suburb match)."""
    if not model:
        return None
    try:
        lat = float(stop["latitude"])
        lng = float(stop["longitude"])
    except (KeyError, TypeError, ValueError):
        return None
    d_lat, d_lng = predict_correction(stop, model)
    if d_lat == 0.0 and d_lng == 0.0:
        return None
    return (lat + d_lat, lng + d_lng)


# ── Summary ──────────────────────────────────────────────────────────────


def summarize_model(model: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Profile-tile-ready summary."""
    if not model:
        return {
            "trained": False,
            "sample_count": 0,
            "suburbs_covered": 0,
            "global_offset_metres": 0.0,
            "largest_suburb_offset_metres": None,
            "trained_at": None,
        }
    suburbs = model.get("suburbs") or {}
    largest = None
    for cell in suburbs.values():
        m = cell.get("offset_metres")
        if isinstance(m, (int, float)):
            largest = m if largest is None else max(largest, m)
    return {
        "trained": True,
        "sample_count": model.get("sample_count", 0),
        "suburbs_covered": len(suburbs),
        "global_offset_metres": model.get("global_offset_metres", 0.0),
        "largest_suburb_offset_metres": largest,
        "trained_at": model.get("trained_at"),
    }
