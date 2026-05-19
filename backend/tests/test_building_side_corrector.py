"""
Phase 2 ML — Building-Side Corrector unit tests
================================================

Mapbox returns rooftop centroids; drivers park at the kerb. The corrector
learns the per-suburb median offset (centroid → completion GPS) and
predicts a corrected arrival point for new stops.

Coverage:
  - sample collection filters by arrival_method (geofence + geofence_inferred
    only — never fallback_completion which has no GPS signal)
  - outlier clamp (>250 m offsets rejected)
  - bucket min-samples filter (5+ per suburb to publish, else fall back to
    global median)
  - per-axis median (robust to one rogue parker)
  - prediction fallback chain: suburb → global → (0,0)
  - predict_corrected_centroid convenience wrapper
  - summarize_model shape
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ml.building_side_corrector import (  # noqa: E402
    BUCKET_MIN_SAMPLES,
    OUTLIER_MAX_METRES,
    CorrectionSample,
    build_model_from_samples,
    collect_samples_from_archive,
    predict_correction,
    predict_corrected_centroid,
    summarize_model,
)


# ── Sample collection ───────────────────────────────────────────────────


def _mk_stop(method: str, c_lat=-26.7, c_lng=153.1, comp_lat=-26.7001, comp_lng=153.1001, suburb="maroochydore"):
    return {
        "arrival_method": method,
        "latitude": c_lat,
        "longitude": c_lng,
        "completion_lat": comp_lat,
        "completion_lng": comp_lng,
        "suburb": suburb,
    }


def test_collect_samples_accepts_geofence_and_inferred():
    routes = [{"stops": [
        _mk_stop("geofence"),
        _mk_stop("geofence_inferred"),
    ]}]
    samples = collect_samples_from_archive(routes)
    assert len(samples) == 2


def test_collect_samples_rejects_fallback_completion():
    routes = [{"stops": [_mk_stop("fallback_completion")]}]
    assert collect_samples_from_archive(routes) == []


def test_collect_samples_rejects_missing_completion_coords():
    routes = [{"stops": [{
        "arrival_method": "geofence",
        "latitude": -26.7,
        "longitude": 153.1,
        # completion_lat/lng missing
        "suburb": "x",
    }]}]
    assert collect_samples_from_archive(routes) == []


def test_collect_samples_clamps_outliers():
    # A 500m offset (well beyond OUTLIER_MAX_METRES=250) should be dropped.
    # ~0.0045 deg lat = ~500m
    routes = [{"stops": [
        _mk_stop("geofence", comp_lat=-26.7 - 0.0045),
    ]}]
    assert collect_samples_from_archive(routes) == []


# ── Model building ──────────────────────────────────────────────────────


def test_build_model_requires_min_samples_per_suburb():
    # 4 samples in "small_suburb" (below BUCKET_MIN_SAMPLES=5) — should NOT
    # produce a suburb bucket; should still produce a global median.
    samples = [
        CorrectionSample(delta_lat=0.0001, delta_lng=0.0001, suburb="small_suburb")
        for _ in range(4)
    ]
    model = build_model_from_samples(samples)
    assert model["suburbs"] == {}
    assert model["sample_count"] == 4
    # Global median present
    assert model["global_delta_lat"] != 0.0 or model["global_delta_lng"] != 0.0


def test_build_model_emits_suburb_bucket_when_threshold_met():
    samples = [
        CorrectionSample(delta_lat=0.0001, delta_lng=0.00015, suburb="maroochydore")
        for _ in range(BUCKET_MIN_SAMPLES)
    ]
    model = build_model_from_samples(samples)
    assert "maroochydore" in model["suburbs"]
    assert model["suburbs"]["maroochydore"]["n"] == BUCKET_MIN_SAMPLES
    assert model["suburbs"]["maroochydore"]["delta_lat"] == 0.0001
    assert model["suburbs"]["maroochydore"]["delta_lng"] == 0.00015


def test_build_model_per_axis_median_robust_to_outlier():
    # 5 samples: 4 small consistent offsets + 1 large outlier (still within
    # OUTLIER_MAX_METRES so it makes it into the sample set). Per-axis median
    # MUST be one of the 4 inliers, not the outlier.
    samples = [
        CorrectionSample(delta_lat=0.0001, delta_lng=0.0001, suburb="x"),
        CorrectionSample(delta_lat=0.0001, delta_lng=0.0001, suburb="x"),
        CorrectionSample(delta_lat=0.0001, delta_lng=0.0001, suburb="x"),
        CorrectionSample(delta_lat=0.0001, delta_lng=0.0001, suburb="x"),
        CorrectionSample(delta_lat=0.0020, delta_lng=0.0020, suburb="x"),  # outlier
    ]
    model = build_model_from_samples(samples)
    # Median of [0.0001 x 4, 0.0020] is 0.0001 — the outlier is ignored.
    assert model["suburbs"]["x"]["delta_lat"] == 0.0001
    assert model["suburbs"]["x"]["delta_lng"] == 0.0001


def test_build_model_handles_zero_samples():
    model = build_model_from_samples([])
    assert model["sample_count"] == 0
    assert model["global_delta_lat"] == 0.0
    assert model["global_delta_lng"] == 0.0
    assert model["suburbs"] == {}


# ── Prediction ──────────────────────────────────────────────────────────


def test_predict_uses_suburb_bucket_when_match():
    samples = [
        CorrectionSample(delta_lat=0.0002, delta_lng=0.0003, suburb="caloundra")
        for _ in range(BUCKET_MIN_SAMPLES)
    ] + [
        CorrectionSample(delta_lat=0.0001, delta_lng=0.0001, suburb="other")
        for _ in range(BUCKET_MIN_SAMPLES)
    ]
    model = build_model_from_samples(samples)
    stop = {"latitude": -26.8, "longitude": 153.1, "suburb": "Caloundra"}  # case-insens
    d_lat, d_lng = predict_correction(stop, model)
    assert d_lat == 0.0002
    assert d_lng == 0.0003


def test_predict_falls_back_to_global_when_suburb_unknown():
    samples = [
        CorrectionSample(delta_lat=0.0002, delta_lng=0.0003, suburb="known")
        for _ in range(BUCKET_MIN_SAMPLES)
    ]
    model = build_model_from_samples(samples)
    stop = {"latitude": -26.8, "longitude": 153.1, "suburb": "unknown_suburb"}
    d_lat, d_lng = predict_correction(stop, model)
    # No "unknown_suburb" bucket → global median (which == known's value
    # because all samples came from it).
    assert d_lat == 0.0002
    assert d_lng == 0.0003


def test_predict_returns_zero_when_model_is_none():
    d_lat, d_lng = predict_correction({"suburb": "x"}, None)
    assert d_lat == 0.0
    assert d_lng == 0.0


def test_predict_corrected_centroid_adds_offset():
    samples = [
        CorrectionSample(delta_lat=0.0001, delta_lng=0.0002, suburb="x")
        for _ in range(BUCKET_MIN_SAMPLES)
    ]
    model = build_model_from_samples(samples)
    stop = {"latitude": -26.7, "longitude": 153.1, "suburb": "x"}
    result = predict_corrected_centroid(stop, model)
    assert result is not None
    lat, lng = result
    assert abs(lat - (-26.7 + 0.0001)) < 1e-9
    assert abs(lng - (153.1 + 0.0002)) < 1e-9


def test_predict_corrected_centroid_none_when_no_model():
    stop = {"latitude": -26.7, "longitude": 153.1, "suburb": "x"}
    assert predict_corrected_centroid(stop, None) is None


def test_predict_corrected_centroid_none_when_offset_is_zero():
    # Empty model → zero global offset → no correction → None
    model = build_model_from_samples([])
    stop = {"latitude": -26.7, "longitude": 153.1, "suburb": "x"}
    assert predict_corrected_centroid(stop, model) is None


# ── Summary ─────────────────────────────────────────────────────────────


def test_summarize_empty_model():
    summary = summarize_model(None)
    assert summary["trained"] is False
    assert summary["sample_count"] == 0
    assert summary["suburbs_covered"] == 0


def test_summarize_counts_suburbs_and_largest():
    samples = (
        [CorrectionSample(delta_lat=0.0001, delta_lng=0.0001, suburb="a") for _ in range(5)]
        + [CorrectionSample(delta_lat=0.0005, delta_lng=0.0005, suburb="b") for _ in range(5)]
    )
    model = build_model_from_samples(samples)
    summary = summarize_model(model)
    assert summary["trained"] is True
    assert summary["suburbs_covered"] == 2
    # "b" should produce a bigger offset metres than "a"
    assert summary["largest_suburb_offset_metres"] is not None
    assert summary["largest_suburb_offset_metres"] >= 30  # ballpark


# ── Outlier helper sanity ───────────────────────────────────────────────


def test_outlier_threshold_constant_is_reasonable():
    # 250m sounds generous but is correct: an industrial complex loading
    # dock CAN be 200m+ from the front-door rooftop centroid.
    assert OUTLIER_MAX_METRES == 250.0
