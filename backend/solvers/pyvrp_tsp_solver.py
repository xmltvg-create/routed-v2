"""
Pure-TSP courier sequencing service powered by PyVRP's Hybrid Genetic Search.

Single vehicle, no time windows, no capacity constraint. The sole objective is
to minimise the total driving time (OSRM travel-time matrix) plus per-stop
service time, producing the fastest possible drop-off sequence.

The class is deliberately self-contained and stateless between solves so it can
be safely reused from request handlers or background workers.

Duplicate-coordinate handling
─────────────────────────────
Real delivery rounds frequently contain *clusters of stops at the exact same
[longitude, latitude]* — e.g. multiple apartments inside one building, several
parcels for one office, or a row of subdivided units sharing one front door.
For PyVRP these collapse to zero-cost edges between distinct nodes and the
HGS metaheuristic ends up shuffling them in a random order, producing visible
zig-zags on the map ("stop 5 → stop 50 → stop 6 → stop 51 …").

We avoid that by collapsing every group of stops sharing identical
coordinates into a single PyVRP super-node *before* solving. The super-node's
service duration is the sum of its members' service durations, and we keep a
strict `super_node_index → [stop_id, …]` mapping so we can expand the solver's
output back into a flat list of `stop_id`s in the caller's original input
order — no information is lost, no stop is dropped, and no random tie-breaks
between identical coordinates are required.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Hashable, Optional, Sequence

import numpy as np
from pyvrp import Model
from pyvrp.stop import MaxRuntime

logger = logging.getLogger(__name__)


# When no client declares a `delivery` demand, PyVRP operates with a
# zero-dimension load vector — so the vehicle's capacity must also be the
# empty list. This effectively disables the capacity constraint, which is
# exactly what a pure-TSP objective wants.
_UNCAPPED_CAPACITY: list[int] = []


# ── Matrix sanitisation ─────────────────────────────────────────────────────
# OSRM's `/table` service is generally clean, but in the wild we have observed:
#   • `null` cells when a client coord cannot be snapped to the road graph
#     (out-of-region lookups, lakes, private property, etc.) — pyvrp would
#     read these as `0`, treating the unreachable trip as FREE and gladly
#     routing through it.
#   • Stray negative values from arithmetic on cached matrix subsets.
#   • Diagonals that are non-zero by 1 ms due to floating-point coercion.
# Clamp them HARD to a value the solver will refuse to use unless absolutely
# forced to. 999_999s is ~11 days — well above any sane real-world tour, but
# small enough to fit comfortably in int64.
PENALTY_SECONDS: int = 999_999


def sanitize_osrm_matrix(matrix) -> np.ndarray:
    """Return a clean, PyVRP-safe copy of an OSRM duration/distance matrix.

    Rules:
        1. The diagonal is forcefully set to **0** (a node has zero cost to
           reach itself). Non-zero diagonals confuse HGS's local-search
           operators.
        2. `None`/`np.nan`/negative values become `PENALTY_SECONDS`. A solver
           presented with a free or "negative-cost" edge will exploit it as
           a shortcut, producing visibly absurd tours; making them MORE
           expensive than any realistic alternative forces the solver to
           detour around them instead.
        3. **No zero-cost traps**: any *non-diagonal* cell that is exactly
           `0` (this can happen when two stops geocode to the same lat/lon,
           when OSRM rounds a sub-second hop down, or when haversine returns
           a sub-metre distance) is clamped to `1` second. PyVRP's HGS
           treats zero-cost edges as "these two nodes are the same point"
           and freely shuffles them inside any tour, producing visible
           map-side fragmentation (`28 → 29 → 30` where 28 and 30 are
           neighbours). Forcing a 1-second floor breaks the tie without
           meaningfully distorting the objective.
        4. The output is a contiguous `int64` ndarray — PyVRP's hot path
           never has to coerce dtype again.

    The input is never mutated; callers can keep using the original matrix
    (e.g. for distance reporting) without side effects.
    """
    arr = np.asarray(matrix, dtype=object)
    if arr.ndim != 2 or arr.shape[0] != arr.shape[1]:
        raise ValueError(f"matrix must be square 2D, got {arr.shape}")

    # Promote to float64 so NaN-detection works uniformly across input types
    # (lists with `None`, numpy float arrays, mixed int/float, etc.).
    float_arr = np.empty(arr.shape, dtype=np.float64)
    for i in range(arr.shape[0]):
        for j in range(arr.shape[1]):
            v = arr[i, j]
            if v is None:
                float_arr[i, j] = np.nan
            else:
                try:
                    float_arr[i, j] = float(v)
                except (TypeError, ValueError):
                    float_arr[i, j] = np.nan

    bad = ~np.isfinite(float_arr) | (float_arr < 0)
    float_arr[bad] = float(PENALTY_SECONDS)

    int_arr = float_arr.astype(np.int64, copy=False)

    # Rule 3: clamp non-diagonal zeros to 1s before we restore the diagonal.
    # `int_arr == 0` catches both honest zeros from OSRM and any cells that
    # rounded down through `astype(int64)`. We mask off the diagonal so its
    # legitimate zero is preserved by step 4.
    n = int_arr.shape[0]
    diag_mask = np.eye(n, dtype=bool)
    zero_off_diag = (int_arr == 0) & ~diag_mask
    if zero_off_diag.any():
        int_arr[zero_off_diag] = 1

    np.fill_diagonal(int_arr, 0)
    return np.ascontiguousarray(int_arr)


@dataclass(frozen=True)
class DeliveryStop:
    """One delivery in the route.

    `x` / `y` are interpreted as `(longitude, latitude)` for duplicate-
    coordinate detection. They are optional — when both are `None` the stop
    is always treated as unique and PyVRP sees one node per input stop. When
    coordinates ARE provided, stops sharing identical `(x, y)` are collapsed
    into a single PyVRP super-node (see module docstring).
    """

    stop_id: Hashable
    service_duration: int  # seconds spent at the stop (non-negative)
    x: Optional[float] = None
    y: Optional[float] = None


class PyVRPTspSolver:
    """Sequences a list of delivery stops for a single driver (pure TSP).

    Typical usage:
        solver = PyVRPTspSolver(max_runtime_seconds=2)
        ordered_ids = solver.solve(
            depot=DeliveryStop("DEPOT", service_duration=0),
            stops=[DeliveryStop("A", 60, x=lon, y=lat), ...],
            time_matrix=osrm_seconds_matrix,  # (N+1, N+1) int ndarray
        )
    """

    def __init__(
        self,
        max_runtime_seconds: float = 2.0,
        seed: int = 0,
        display: bool = False,
    ) -> None:
        if max_runtime_seconds <= 0:
            raise ValueError("max_runtime_seconds must be positive")
        self._max_runtime = float(max_runtime_seconds)
        self._seed = int(seed)
        self._display = bool(display)

    # ------------------------------------------------------------------ public

    def solve(
        self,
        depot: DeliveryStop,
        stops: Sequence[DeliveryStop],
        time_matrix: np.ndarray,
    ) -> list[Hashable]:
        """Return stop_ids in the optimal visit order (depot NOT included).

        `time_matrix[i][j]` is the travel time in seconds from node i to node
        j, where index 0 is the depot and indices 1..N match `stops` order.

        Stops with identical `(x, y)` are collapsed into a single super-node
        before solving and re-expanded afterwards in input order.
        """
        if not stops:
            return []

        matrix = self._validate_matrix(time_matrix, expected_dim=len(stops) + 1)

        # ── Group identical coordinates ────────────────────────────────────
        # `groups` holds, for each unique coord key, the list of input
        # stop indices (0-based into `stops`) sharing that coord. We rely on
        # Python's dict preserving insertion order so the *first* occurrence
        # of each coord defines the super-node's representative — that index
        # is what we use to read travel times out of the original matrix.
        groups: list[list[int]] = []
        key_to_group: dict[object, int] = {}
        for stop_idx, stop in enumerate(stops):
            key = self._coord_key(stop, stop_idx)
            existing = key_to_group.get(key)
            if existing is None:
                key_to_group[key] = len(groups)
                groups.append([stop_idx])
            else:
                groups[existing].append(stop_idx)

        if logger.isEnabledFor(logging.DEBUG) and len(groups) < len(stops):
            logger.debug(
                "PyVRP: collapsed %d input stops → %d super-nodes (%d duplicate-coord groups)",
                len(stops),
                len(groups),
                len(stops) - len(groups),
            )

        # Build the reduced (depot + G) time matrix using each group's
        # representative (its first input index). matrix index for input
        # stop i is (i + 1); index 0 is the depot.
        reps = [g[0] for g in groups]
        rep_matrix_indices = [0] + [r + 1 for r in reps]
        reduced_matrix = matrix[np.ix_(rep_matrix_indices, rep_matrix_indices)]

        # Per super-node service duration = sum of all members' service times.
        super_stops = [
            DeliveryStop(
                stop_id=stops[reps[g_idx]].stop_id,  # placeholder, only id matters
                service_duration=sum(
                    max(int(stops[i].service_duration), 0) for i in members
                ),
                x=stops[reps[g_idx]].x,
                y=stops[reps[g_idx]].y,
            )
            for g_idx, members in enumerate(groups)
        ]

        model = self._build_model(depot, super_stops, reduced_matrix)
        result = model.solve(
            stop=MaxRuntime(self._max_runtime),
            seed=self._seed,
            display=self._display,
        )

        if not result.is_feasible():
            logger.warning(
                "PyVRP returned an infeasible solution for %d stops (cost=%s)",
                len(stops),
                result.cost(),
            )

        # `_extract_sequence` returns ordered SUPER-NODE indices; expand each
        # super-node into its members in their original input order so the
        # caller sees a flat sequence of stop_ids matching `stops`.
        super_sequence = self._extract_super_sequence(result, len(super_stops))

        flat: list[Hashable] = []
        emitted = set()
        for g_idx in super_sequence:
            for stop_idx in groups[g_idx]:
                flat.append(stops[stop_idx].stop_id)
                emitted.add(stop_idx)

        # Defensive: if PyVRP ever drops a super-node, append its members at
        # the end so callers never silently lose a stop.
        if len(emitted) < len(stops):
            for stop_idx in range(len(stops)):
                if stop_idx not in emitted:
                    flat.append(stops[stop_idx].stop_id)

        return flat

    # ---------------------------------------------------------------- internal

    @staticmethod
    def _coord_key(stop: DeliveryStop, fallback_idx: int) -> object:
        """Group-key for duplicate detection.

        When BOTH `x` and `y` are explicitly supplied we group by their
        SNAPPED `(lon, lat)` rounded to 5 decimal places (~1.1m). Real-world
        geocoders virtually never return bit-identical floats for "same
        address" — a 1 cm jitter (e.g. `-26.78604` vs `-26.786041`) is
        enough to break exact-float equality, which left PyVRP treating
        same-doorstep parcels as distinct super-nodes. The HGS solver then
        cheerfully interleaved them with neighbouring stops because the
        inter-parcel travel time was tiny but non-zero — the
        "Zero-Cost Interleaving" bug that produced ping-pong visit orders
        like `[A1, B, A2]` for two parcels at address A.
        Snapping to 5 dp tolerates that jitter while still being orders of
        magnitude smaller than any legitimate distinct address (≈11m apart).
        When either x or y is None we fall back to the input index, which
        guarantees the stop never collides with another → no accidental
        grouping in callers that don't provide coordinates.
        """
        if stop.x is None or stop.y is None:
            return ("uniq", fallback_idx)
        return ("coord", round(float(stop.x), 5), round(float(stop.y), 5))

    @staticmethod
    def _validate_matrix(matrix: np.ndarray, expected_dim: int) -> np.ndarray:
        if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1]:
            raise ValueError(f"time_matrix must be square 2D, got {matrix.shape}")
        if matrix.shape[0] != expected_dim:
            raise ValueError(
                f"time_matrix dimension {matrix.shape[0]} does not match "
                f"depot + stops count {expected_dim}"
            )
        return sanitize_osrm_matrix(matrix)

    def _build_model(
        self,
        depot: DeliveryStop,
        stops: Sequence[DeliveryStop],
        matrix: np.ndarray,
    ) -> Model:
        model = Model()

        depot_node = model.add_depot(
            x=depot.x if depot.x is not None else 0.0,
            y=depot.y if depot.y is not None else 0.0,
        )

        # One vehicle, effectively unbounded capacity, objective = duration.
        # unit_distance_cost=0 + unit_duration_cost=1 makes the solver minimise
        # total time (travel + service) irrespective of raw distance.
        model.add_vehicle_type(
            num_available=1,
            capacity=_UNCAPPED_CAPACITY,
            start_depot=depot_node,
            end_depot=depot_node,
            unit_distance_cost=0,
            unit_duration_cost=1,
        )

        client_nodes = [
            model.add_client(
                x=s.x if s.x is not None else 0.0,
                y=s.y if s.y is not None else 0.0,
                service_duration=max(int(s.service_duration), 0),
            )
            for s in stops
        ]

        # Node order: [depot, client_1, ..., client_N]. Pass duration as the
        # edge's distance too so the solver always has a consistent metric.
        nodes = [depot_node, *client_nodes]
        n = len(nodes)
        for i in range(n):
            row = matrix[i]
            for j in range(n):
                if i == j:
                    continue
                t = int(row[j])
                model.add_edge(nodes[i], nodes[j], distance=t, duration=t)

        return model

    @staticmethod
    def _extract_super_sequence(result, n_super: int) -> list[int]:
        """Return ordered super-node indices (0-based into the grouped list).

        PyVRP's `route.visits()` yields indices into the solver's *global*
        location list. Depots are laid out first (indices 0 .. D-1) and the
        N clients follow (indices D .. D+N-1), preserving the insertion
        order we used in `_build_model`. We therefore subtract the depot
        offset (always 1 here) to recover the 0-based index into the
        super-node list.
        """
        routes = result.best.routes()
        if not routes:
            return []

        depot_offset = 1
        seq: list[int] = []
        for route in routes:
            for global_idx in route.visits():
                super_idx = global_idx - depot_offset
                if 0 <= super_idx < n_super:
                    seq.append(super_idx)
        return seq
