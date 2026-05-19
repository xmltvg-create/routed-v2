"""
RouTeD Phase 1 ML — Service-Time Learner
=========================================

Purpose
-------
Replace the flat 30-second-per-stop service-time default in the optimize
pipeline with a learned median bucketed by (suburb, hour-of-day). Drivers
take longer at apartment complexes than at single houses; longer mid-
morning when residents answer the door than at 3 PM when nobody's home.
A bucketed-median lookup captures both effects with zero hyperparameters
and runs in microseconds at predict time.

Why not sklearn / xgboost?
-------------------------
With 145 samples per user and 50+ distinct suburbs, anything fancier
would just memorize noise. The bucketed median is statistically robust
(non-parametric, outlier-resistant) and stays explainable for the driver
("This stop is from suburb X, hour Y → I'm budgeting 45 s based on your
past 6 deliveries there").

Bucket hierarchy (most-specific to fallback)
--------------------------------------------
    1. (suburb, hour_bucket)   — full discrimination
    2. (suburb,)               — collapse hours if <3 samples in cell
    3. (hour_bucket,)          — collapse suburbs if <3 samples in cell
    4. global median           — last-resort if user has any samples
    5. DEFAULT_SECONDS = 30    — cold-start (zero samples)

Hour buckets are 3-hour windows (00-02, 03-05, ...) chosen to keep ~8
buckets max per suburb, which gives every bucket a fighting chance to
collect ≥3 samples without slicing too coarsely.

Lifecycle
---------
- `train_service_time_model(user_id, db)` — pulls archived stops with
  arrival_method='geofence', computes the bucket medians, writes to
  `ml_service_time_models` (one doc per user). Idempotent; replaces.
- `predict_service_time_seconds(stop, model)` — pure lookup. Returns
  the most specific bucket median available, with fallback chain.
- `summarize_model(model)` — driver-facing summary for the Profile tile.

Quality bar
-----------
- Minimum bucket sample count: BUCKET_MIN_SAMPLES = 3
- Service-time samples drawn ONLY from arrival_method='geofence' rows
  (geofence_inferred has a constant 30 s back-date which would poison
  the distribution).
- Outlier clamp: 5 s ≤ x ≤ 1800 s (30 min). Anything outside is more
  likely a clock-skew bug than real service time.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import median
from typing import Any, Dict, List, Optional, Tuple

import logging

logger = logging.getLogger("server")

# ── Constants ────────────────────────────────────────────────────────────
DEFAULT_SECONDS: int = 30
BUCKET_MIN_SAMPLES: int = 3
OUTLIER_MIN_SECONDS: float = 5.0
OUTLIER_MAX_SECONDS: float = 1800.0
HOUR_BUCKET_HOURS: int = 3       # 00-02, 03-05, ..., 21-23
MODEL_VERSION: int = 1            # bump on schema change


@dataclass
class ServiceTimeSample:
    """One archived stop's service-time observation."""
    seconds: float
    suburb: Optional[str]
    hour: int   # 0-23 local time of completion


def hour_bucket(hour: int) -> int:
    """Collapse 0-23 hours into 8 three-hour windows by their start hour
    (0, 3, 6, ..., 21). Stable, no floating-point — easy to grep."""
    return (hour // HOUR_BUCKET_HOURS) * HOUR_BUCKET_HOURS


def _bucket_key(suburb: Optional[str], hb: Optional[int]) -> str:
    """Stringify a (suburb, hour-bucket) tuple as a Mongo-friendly key."""
    s = (suburb or "").strip().lower() or "_global"
    h = hb if hb is not None else "_any"
    return f"{s}|{h}"


def _clean_suburb(s: Any) -> Optional[str]:
    """Lowercase, trim, return None if blank. Matching is case-insensitive
    because the geocoder returns "Maroochydore" but historical imports
    have "maroochydore"; we don't want them in different buckets."""
    if not isinstance(s, str):
        return None
    s = s.strip().lower()
    return s or None


# ── Training ─────────────────────────────────────────────────────────────


def collect_samples_from_archive(routes: List[dict]) -> List[ServiceTimeSample]:
    """Walk every archived route's `stops` array and emit a sample for each
    stop with arrival_method='geofence' AND a complete (arrived_at,
    completed_at) timestamp pair. Excludes geofence_inferred (constant
    30 s back-date) and fallback_completion (also back-dated). Outlier-
    clamped so a clock-skew bug doesn't dominate the median."""
    samples: List[ServiceTimeSample] = []
    for route in routes:
        for stop in route.get("stops") or []:
            if stop.get("arrival_method") != "geofence":
                continue
            a, c = stop.get("arrived_at"), stop.get("completed_at")
            if not (a and c):
                continue
            try:
                if isinstance(a, str):
                    a = datetime.fromisoformat(a.replace("Z", "+00:00"))
                if isinstance(c, str):
                    c = datetime.fromisoformat(c.replace("Z", "+00:00"))
                secs = (c - a).total_seconds()
            except Exception:
                continue
            if not (OUTLIER_MIN_SECONDS <= secs <= OUTLIER_MAX_SECONDS):
                continue
            samples.append(ServiceTimeSample(
                seconds=secs,
                suburb=_clean_suburb(stop.get("suburb")),
                hour=c.hour if hasattr(c, "hour") else 12,
            ))
    return samples


def build_model_from_samples(samples: List[ServiceTimeSample]) -> Dict[str, Any]:
    """Compute bucket medians at every level of the fallback hierarchy.

    Returns a dict shaped for direct Mongo persistence:
        {
            "version": 1,
            "trained_at": iso,
            "sample_count": int,
            "global_median_seconds": float,
            "buckets": {
                "<suburb>|<hour_bucket>": {"median": float, "n": int},
                "<suburb>|_any": {...},
                "_global|<hour_bucket>": {...},
            },
        }
    """
    # Phase 1: index samples by their three key shapes simultaneously.
    by_suburb_hour: Dict[Tuple[str, int], List[float]] = {}
    by_suburb: Dict[str, List[float]] = {}
    by_hour: Dict[int, List[float]] = {}
    all_secs: List[float] = []

    for s in samples:
        hb = hour_bucket(s.hour)
        if s.suburb:
            by_suburb_hour.setdefault((s.suburb, hb), []).append(s.seconds)
            by_suburb.setdefault(s.suburb, []).append(s.seconds)
        by_hour.setdefault(hb, []).append(s.seconds)
        all_secs.append(s.seconds)

    # Phase 2: keep ONLY buckets with ≥ BUCKET_MIN_SAMPLES. Spurious
    # 1-sample buckets would otherwise produce wildly noisy medians.
    buckets: Dict[str, Dict[str, Any]] = {}

    for (sub, hb), vals in by_suburb_hour.items():
        if len(vals) >= BUCKET_MIN_SAMPLES:
            buckets[_bucket_key(sub, hb)] = {
                "median": round(median(vals), 2),
                "n": len(vals),
            }

    for sub, vals in by_suburb.items():
        if len(vals) >= BUCKET_MIN_SAMPLES:
            buckets[_bucket_key(sub, None)] = {
                "median": round(median(vals), 2),
                "n": len(vals),
            }

    for hb, vals in by_hour.items():
        if len(vals) >= BUCKET_MIN_SAMPLES:
            buckets[_bucket_key(None, hb)] = {
                "median": round(median(vals), 2),
                "n": len(vals),
            }

    global_med = round(median(all_secs), 2) if all_secs else float(DEFAULT_SECONDS)

    return {
        "version": MODEL_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "sample_count": len(samples),
        "global_median_seconds": global_med,
        "buckets": buckets,
    }


# ── Prediction ───────────────────────────────────────────────────────────


def predict_service_time_seconds(
    stop: Dict[str, Any],
    model: Optional[Dict[str, Any]],
    completion_hour: Optional[int] = None,
) -> float:
    """Most-specific bucket wins. Hour defaults to "now" if not provided
    (used during optimize at request-time, when we know the start hour).

    Falls back through:
        (suburb,hour) → (suburb,) → (hour,) → global_median → DEFAULT_SECONDS
    """
    if not model or not isinstance(model.get("buckets"), dict):
        return float(DEFAULT_SECONDS)

    suburb = _clean_suburb(stop.get("suburb"))
    hr = completion_hour if completion_hour is not None else datetime.now(timezone.utc).hour
    hb = hour_bucket(hr)
    buckets = model["buckets"]

    if suburb:
        cell = buckets.get(_bucket_key(suburb, hb))
        if cell:
            return float(cell["median"])
        cell = buckets.get(_bucket_key(suburb, None))
        if cell:
            return float(cell["median"])

    cell = buckets.get(_bucket_key(None, hb))
    if cell:
        return float(cell["median"])

    gm = model.get("global_median_seconds")
    if isinstance(gm, (int, float)):
        return float(gm)
    return float(DEFAULT_SECONDS)


# ── Apply to duration matrix ─────────────────────────────────────────────


def apply_service_times_to_matrix(
    duration_matrix: List[List[float]],
    service_times_per_node: List[float],
) -> List[List[int]]:
    """Bake per-node service times INTO an NxN duration matrix.

    Each outgoing edge from node `i` becomes `duration[i][j] + service[i]`
    for j != i. Self-loops stay 0. The diagonal-preserving trick is key:
    if we added service[i] to ALL cells of row i (including [i][i]) the
    self-loop would gain a non-zero cost, which some solvers (notably
    OR-Tools' RoutingModel) interpret as a forbidden transition.

    Why "outgoing from i" not "incoming to j"?
    -----------------------------------------
    Because service time is incurred AFTER arriving at i, before leaving
    for j. From the optimizer's perspective, that's a delay on the edge
    leaving i — not on the edge arriving at j. This matters for the
    final node: an optimizer that adds service-time-on-arrival would
    count the LAST stop's service time twice (once on entry, once on
    exit-to-virtual-depot). Outgoing-only sidesteps the bug.

    All solvers in RouTeD's pipeline (VROOM, OR-Tools, LKH, 3-opt,
    pyvrp) consume this matrix uniformly, so a single transformation
    here cascades to all algorithms — no per-solver wiring needed.

    Returns a NEW matrix (ints, since downstream solvers expect ints)
    so the caller can keep the raw OSRM matrix unchanged for telemetry.
    """
    if not duration_matrix:
        return []
    n = len(duration_matrix)
    if len(service_times_per_node) != n:
        raise ValueError(
            f"service_times_per_node length {len(service_times_per_node)} "
            f"does not match matrix size {n}"
        )
    out: List[List[int]] = []
    for i in range(n):
        row_i: List[int] = []
        s_i = max(0.0, float(service_times_per_node[i]))
        for j in range(n):
            d = float(duration_matrix[i][j]) if duration_matrix[i][j] is not None else 0.0
            if i == j:
                row_i.append(int(round(d)))   # self-loop stays at 0 (or whatever caller had)
            else:
                row_i.append(int(round(d + s_i)))
        out.append(row_i)
    return out


# ── Summary ──────────────────────────────────────────────────────────────


def summarize_model(model: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Driver-facing summary block for the Profile telemetry tile.

    Counts how many distinct suburbs and hour-buckets have their own
    median, plus the spread between fastest-bucket and slowest-bucket
    medians so the driver can SEE the model is doing real work."""
    if not model:
        return {
            "trained": False,
            "sample_count": 0,
            "suburbs_covered": 0,
            "hour_buckets_covered": 0,
            "global_median_seconds": DEFAULT_SECONDS,
            "fastest_bucket_seconds": None,
            "slowest_bucket_seconds": None,
            "trained_at": None,
        }
    buckets = model.get("buckets") or {}
    suburbs: set = set()
    hour_only_buckets: set = set()
    fastest = None
    slowest = None
    for key, cell in buckets.items():
        sub, hb = key.split("|", 1)
        if sub != "_global":
            suburbs.add(sub)
        else:
            hour_only_buckets.add(hb)
        m = cell.get("median")
        if isinstance(m, (int, float)):
            fastest = m if fastest is None else min(fastest, m)
            slowest = m if slowest is None else max(slowest, m)
    return {
        "trained": True,
        "sample_count": model.get("sample_count", 0),
        "suburbs_covered": len(suburbs),
        "hour_buckets_covered": len(hour_only_buckets),
        "global_median_seconds": model.get("global_median_seconds", DEFAULT_SECONDS),
        "fastest_bucket_seconds": fastest,
        "slowest_bucket_seconds": slowest,
        "trained_at": model.get("trained_at"),
    }
