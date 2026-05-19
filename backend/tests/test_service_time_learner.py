"""
Service-time learner unit tests.

Locks down the bucketing math + prediction fallback chain in isolation
of MongoDB. The end-to-end "train then predict" flow is covered by the
backend integration tests; this file is pure-function regression.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, '/app/backend')

from ml.service_time_learner import (  # noqa: E402
    BUCKET_MIN_SAMPLES,
    DEFAULT_SECONDS,
    HOUR_BUCKET_HOURS,
    ServiceTimeSample,
    build_model_from_samples,
    collect_samples_from_archive,
    hour_bucket,
    predict_service_time_seconds,
    summarize_model,
)


# ── hour_bucket ──────────────────────────────────────────────────────────


def test_hour_bucket_floors_to_3hr_window():
    assert hour_bucket(0) == 0
    assert hour_bucket(2) == 0
    assert hour_bucket(3) == 3
    assert hour_bucket(11) == 9
    assert hour_bucket(14) == 12
    assert hour_bucket(23) == 21


# ── collect_samples_from_archive ─────────────────────────────────────────


def _make_stop(arrival_method, secs, suburb=None, hour=10):
    """Produce a route_history.stops entry with proper arrived_at/completed_at."""
    arrived = datetime(2026, 5, 12, hour, 0, 0, tzinfo=timezone.utc)
    completed = arrived + timedelta(seconds=secs)
    return {
        "arrival_method": arrival_method,
        "arrived_at": arrived,
        "completed_at": completed,
        "suburb": suburb,
    }


def test_collect_samples_only_keeps_real_geofence():
    routes = [{"stops": [
        _make_stop("geofence", 45, "Maroochydore", 10),
        _make_stop("geofence_inferred", 30, "Maroochydore", 10),  # excluded
        _make_stop("fallback_completion", 30, "Maroochydore", 10),  # excluded
        _make_stop("geofence", 60, "Buderim", 14),
    ]}]
    samples = collect_samples_from_archive(routes)
    assert len(samples) == 2
    assert {s.suburb for s in samples} == {"maroochydore", "buderim"}


def test_collect_samples_clamps_outliers():
    routes = [{"stops": [
        _make_stop("geofence", 2.5, "X"),    # below 5s clamp → dropped
        _make_stop("geofence", 60, "X"),     # kept
        _make_stop("geofence", 3600, "X"),   # above 1800s clamp → dropped
    ]}]
    samples = collect_samples_from_archive(routes)
    assert len(samples) == 1
    assert samples[0].seconds == 60


def test_collect_samples_handles_iso_string_timestamps():
    routes = [{"stops": [{
        "arrival_method": "geofence",
        "arrived_at": "2026-05-12T10:00:00+00:00",
        "completed_at": "2026-05-12T10:00:45+00:00",
        "suburb": "Mooloolaba",
    }]}]
    samples = collect_samples_from_archive(routes)
    assert len(samples) == 1
    assert samples[0].seconds == 45
    assert samples[0].suburb == "mooloolaba"


# ── build_model_from_samples ─────────────────────────────────────────────


def test_build_model_requires_min_samples_per_bucket():
    """A bucket with < BUCKET_MIN_SAMPLES is excluded — would be noisy."""
    samples = [ServiceTimeSample(seconds=60, suburb="rare", hour=10)]
    model = build_model_from_samples(samples)
    # Single-sample suburb buckets are excluded.
    assert "rare|9" not in model["buckets"]
    assert "rare|_any" not in model["buckets"]
    # But global median is set from the single sample.
    assert model["global_median_seconds"] == 60.0
    assert model["sample_count"] == 1


def test_build_model_computes_bucket_medians():
    """5 samples in (maroochy, hour=10) → bucket median of those 5."""
    samples = [
        ServiceTimeSample(seconds=30, suburb="maroochy", hour=10),
        ServiceTimeSample(seconds=45, suburb="maroochy", hour=10),
        ServiceTimeSample(seconds=60, suburb="maroochy", hour=11),
        ServiceTimeSample(seconds=90, suburb="maroochy", hour=10),
        ServiceTimeSample(seconds=50, suburb="maroochy", hour=10),
    ]
    model = build_model_from_samples(samples)
    # Hour bucket 9 covers 9, 10, 11. All 5 fall in it.
    cell = model["buckets"]["maroochy|9"]
    assert cell["n"] == 5
    assert cell["median"] == 50  # median of [30,45,50,60,90] = 50
    # Suburb-only collapse also exists
    assert model["buckets"]["maroochy|_any"]["n"] == 5
    # Hour-only bucket (collapsed across suburbs) — same 5 samples
    assert model["buckets"]["_global|9"]["n"] == 5


def test_build_model_separates_distinct_hour_buckets():
    samples = [
        ServiceTimeSample(seconds=30, suburb="x", hour=8),   # bucket 6
        ServiceTimeSample(seconds=30, suburb="x", hour=8),
        ServiceTimeSample(seconds=30, suburb="x", hour=8),
        ServiceTimeSample(seconds=120, suburb="x", hour=14),  # bucket 12
        ServiceTimeSample(seconds=120, suburb="x", hour=14),
        ServiceTimeSample(seconds=120, suburb="x", hour=14),
    ]
    model = build_model_from_samples(samples)
    assert model["buckets"]["x|6"]["median"] == 30
    assert model["buckets"]["x|12"]["median"] == 120
    # Collapsed suburb-only bucket: median of all 6 = 75
    assert model["buckets"]["x|_any"]["median"] == 75


# ── predict_service_time_seconds ─────────────────────────────────────────


def _toy_model() -> dict:
    return {
        "version": 1,
        "trained_at": "2026-05-12T10:00:00+00:00",
        "sample_count": 9,
        "global_median_seconds": 50,
        "buckets": {
            "maroochy|9":  {"median": 30, "n": 3},   # most-specific
            "maroochy|_any": {"median": 40, "n": 6},  # suburb collapse
            "_global|9":   {"median": 35, "n": 5},   # hour collapse
        },
    }


def test_predict_uses_most_specific_bucket():
    """suburb+hour bucket exists → wins over everything else."""
    out = predict_service_time_seconds({"suburb": "Maroochy"}, _toy_model(), completion_hour=10)
    assert out == 30


def test_predict_falls_back_to_suburb_only_when_hour_missing():
    """suburb known but no bucket for that hour → suburb-only collapse."""
    out = predict_service_time_seconds({"suburb": "maroochy"}, _toy_model(), completion_hour=15)
    assert out == 40


def test_predict_falls_back_to_hour_only_when_suburb_unknown():
    """suburb has no buckets at all → hour-only bucket wins."""
    out = predict_service_time_seconds({"suburb": "unknown_suburb"}, _toy_model(), completion_hour=10)
    assert out == 35


def test_predict_falls_back_to_global_median_when_no_buckets_match():
    out = predict_service_time_seconds({"suburb": "unknown"}, _toy_model(), completion_hour=15)
    assert out == 50


def test_predict_falls_back_to_default_when_model_is_None():
    out = predict_service_time_seconds({"suburb": "anything"}, None)
    assert out == DEFAULT_SECONDS


def test_predict_handles_missing_suburb_gracefully():
    """Stop with no suburb → uses hour-only bucket, then global."""
    out = predict_service_time_seconds({}, _toy_model(), completion_hour=10)
    assert out == 35


# ── summarize_model ──────────────────────────────────────────────────────


def test_summarize_empty_model():
    s = summarize_model(None)
    assert s["trained"] is False
    assert s["sample_count"] == 0
    assert s["global_median_seconds"] == DEFAULT_SECONDS


def test_summarize_counts_suburbs_and_hour_buckets():
    s = summarize_model(_toy_model())
    assert s["trained"] is True
    assert s["sample_count"] == 9
    assert s["suburbs_covered"] == 1   # "maroochy"
    assert s["hour_buckets_covered"] == 1  # only one _global|9
    assert s["fastest_bucket_seconds"] == 30
    assert s["slowest_bucket_seconds"] == 40


# ── End-to-end integration through the public API ───────────────────────


def test_end_to_end_train_then_predict():
    """Build a model from 9 plausibly-realistic samples and confirm the
    predictions look sane for representative driver scenarios."""
    samples = [
        # Maroochy mornings — fast (no traffic, residential)
        ServiceTimeSample(seconds=25, suburb="maroochy", hour=9),
        ServiceTimeSample(seconds=30, suburb="maroochy", hour=10),
        ServiceTimeSample(seconds=35, suburb="maroochy", hour=10),
        # Maroochy afternoons — slower (kids home from school)
        ServiceTimeSample(seconds=70, suburb="maroochy", hour=15),
        ServiceTimeSample(seconds=80, suburb="maroochy", hour=15),
        ServiceTimeSample(seconds=90, suburb="maroochy", hour=16),
        # CBD lunchtime — apartments, slowest
        ServiceTimeSample(seconds=120, suburb="cbd", hour=12),
        ServiceTimeSample(seconds=130, suburb="cbd", hour=13),
        ServiceTimeSample(seconds=140, suburb="cbd", hour=13),
    ]
    model = build_model_from_samples(samples)

    # Morning Maroochy stop → fast bucket
    p_morning = predict_service_time_seconds({"suburb": "Maroochy"}, model, completion_hour=10)
    assert 25 <= p_morning <= 35

    # Afternoon Maroochy stop → slow bucket
    p_afternoon = predict_service_time_seconds({"suburb": "maroochy"}, model, completion_hour=15)
    assert 70 <= p_afternoon <= 90

    # CBD lunchtime → slowest
    p_cbd = predict_service_time_seconds({"suburb": "cbd"}, model, completion_hour=13)
    assert 120 <= p_cbd <= 140

    # Unknown suburb at a known hour → hour-only fallback. Should land
    # near the morning samples (~30 s) since hour_bucket=9 only contains
    # the 3 morning Maroochy entries. NOT the global median of all 9
    # samples (~80 s) and NOT the DEFAULT_SECONDS path.
    p_unknown = predict_service_time_seconds({"suburb": "newtown"}, model, completion_hour=10)
    assert 25 <= p_unknown <= 35  # learned from the morning bucket


# ── apply_service_times_to_matrix ────────────────────────────────────────


def test_apply_service_times_adds_to_outgoing_edges_only():
    """Each row i's off-diagonal entries get +service[i]. Self-loop stays 0.

    Travel matrix:
        [[0, 100, 200],
         [100, 0, 150],
         [200, 150, 0]]
    Service times: [10, 0, 30]
    Result (each off-diagonal cell in row i gets +service[i]):
        [[0, 110, 210],     # row 0: 100+10, 200+10
         [100, 0, 150],     # row 1: unchanged (service[1]=0)
         [230, 180, 0]]     # row 2: 200+30, 150+30
    """
    from ml.service_time_learner import apply_service_times_to_matrix
    travel = [
        [0, 100, 200],
        [100, 0, 150],
        [200, 150, 0],
    ]
    services = [10, 0, 30]
    out = apply_service_times_to_matrix(travel, services)

    assert out[0][0] == 0    # self-loop
    assert out[0][1] == 110  # 100 + 10
    assert out[0][2] == 210  # 200 + 10
    assert out[1][0] == 100  # unchanged
    assert out[1][2] == 150  # unchanged
    assert out[2][0] == 230  # 200 + 30
    assert out[2][1] == 180  # 150 + 30


def test_apply_service_times_validates_length():
    from ml.service_time_learner import apply_service_times_to_matrix
    with pytest.raises(ValueError, match="does not match"):
        apply_service_times_to_matrix([[0, 1], [1, 0]], [10])  # 1 service vs 2x2 matrix


def test_apply_service_times_handles_empty():
    from ml.service_time_learner import apply_service_times_to_matrix
    assert apply_service_times_to_matrix([], []) == []


def test_apply_service_times_clamps_negative_to_zero():
    """Defensive: a buggy bucket median shouldn't subtract from edges."""
    from ml.service_time_learner import apply_service_times_to_matrix
    out = apply_service_times_to_matrix([[0, 100], [100, 0]], [-50, 0])
    assert out[0][1] == 100   # negative service clamped to 0, edge unchanged
    assert out[1][0] == 100


def test_apply_service_times_rounds_to_int_for_solver_compat():
    """LKH and OR-Tools both want integer matrices. Output must be int."""
    from ml.service_time_learner import apply_service_times_to_matrix
    out = apply_service_times_to_matrix([[0.0, 100.4], [100.4, 0.0]], [10.6, 0])
    assert all(isinstance(c, int) for row in out for c in row)
    assert out[0][1] == 111   # 100.4 + 10.6 = 111.0 → 111
