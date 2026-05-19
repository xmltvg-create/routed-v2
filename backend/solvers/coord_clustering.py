"""Coordinate-clustering pre/post-processor shared by all TSP solvers.

The PyVRP solver (`pyvrp_tsp_solver.py`) already collapses identical-coordinate
stops into super-nodes internally. The OR-Tools, LKH and VROOM solvers do NOT.
That left the "Zero-Cost Interleaving" bug reachable through any of those
fallback paths: when PyVRP failed and OR-Tools took over, the driver could
again see same-doorstep parcels (`A1, A2`) split by intermediate stops
(`A1, B, A2`) because the inter-parcel travel time was tiny but non-zero.

This module provides a single entry point — `cluster_aware_solve` — that wraps
ANY TSP solver function `(matrix, depot, **kwargs) -> List[int]` with a
snap-cluster-expand pipeline, giving every solver in the pipeline the same
protection PyVRP got internally.

Public API:
    - `snap_coord(lat_or_lng)` — round to 5 decimal places (~1.1m at equator)
    - `cluster_supernodes(stops_list, matrix, depot)` → reduced view + mapping
    - `cluster_aware_solve(solver_fn, matrix, depot, stops_list, **kwargs)`
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

# 5 decimal places of degrees ≈ 1.1 metres at the equator. Tight enough that
# legitimately distinct addresses (≥11 m apart) never collide; loose enough
# that real-world geocoder jitter (typically <1 cm) is absorbed cleanly.
_COORD_SNAP_DP = 5


def snap_coord(value: float) -> float:
    """Snap a single lat/lng float onto the clustering grid."""
    return round(float(value), _COORD_SNAP_DP)


def _coord_key(stop: Dict[str, Any], fallback_idx: int) -> Tuple:
    """Group key for one stop. Stops missing coords each get a unique key."""
    lat = stop.get("latitude")
    lng = stop.get("longitude")
    if lat is None or lng is None:
        return ("uniq", fallback_idx)
    return ("coord", snap_coord(lat), snap_coord(lng))


def cluster_supernodes(
    stops_list: Sequence[Dict[str, Any]],
    matrix: Sequence[Sequence[float]],
    depot: int,
) -> Tuple[List[List[float]], List[List[int]], int]:
    """Collapse same-doorstep stops into super-nodes.

    Args:
        stops_list: Iterable of stop dicts, each carrying `latitude`/`longitude`.
        matrix:     Square N×N duration/distance matrix indexed parallel to
                    `stops_list` (so `matrix[i][j]` is the cost from stop i to
                    stop j).
        depot:      Index of the starting stop inside `stops_list`. The depot
                    is always treated as its OWN super-node (never merged
                    even if its coords happen to collide with another stop) so
                    the solver's start point is preserved.

    Returns:
        Tuple of:
            * reduced_matrix: M×M matrix where M = number of super-nodes.
              Cell `[i][j]` is the cost between the *representatives* of
              super-nodes i and j (read from the original matrix).
            * super_to_originals: For each super-node index, the list of
              ORIGINAL `stops_list` indices it contains. Members appear in
              their original input order so the post-solve expansion is
              deterministic and matches what the user uploaded.
            * super_depot_index: Index of the depot's super-node inside
              `reduced_matrix` — pass this through to the wrapped solver.

    Notes:
        When no stops cluster (all coords distinct after snapping), the
        returned reduced matrix is identical to the input and every
        super-node has exactly one member. Callers can short-circuit on
        `len(super_to_originals) == len(stops_list)` to skip the wrap.
    """
    n = len(stops_list)
    if n == 0:
        return [], [], 0

    # Build groups in input order so the first occurrence becomes the
    # representative — that matches user expectation and the matrix view.
    groups: List[List[int]] = []
    key_to_group: Dict[Tuple, int] = {}

    # Force the depot into its own group first so it stays at super_depot=0
    # only if it would naturally; otherwise keep its position in input order.
    for stop_idx, stop in enumerate(stops_list):
        # Depot is special — never merged with another stop, even at same
        # coords (very rare, but happens when courier's start point IS the
        # first delivery address).
        if stop_idx == depot:
            key = ("depot",)
        else:
            key = _coord_key(stop, stop_idx)

        existing = key_to_group.get(key)
        if existing is None:
            key_to_group[key] = len(groups)
            groups.append([stop_idx])
        else:
            groups[existing].append(stop_idx)

    # Representatives → first member of each group → row/col into source matrix.
    reps = [g[0] for g in groups]
    reduced: List[List[float]] = [
        [matrix[reps[i]][reps[j]] for j in range(len(groups))]
        for i in range(len(groups))
    ]
    super_depot = next(i for i, g in enumerate(groups) if depot in g)
    return reduced, groups, super_depot


def expand_supernodes(
    super_sequence: Sequence[int],
    super_to_originals: Sequence[Sequence[int]],
) -> List[int]:
    """Expand a super-node visit order into a flat list of original indices.

    Members of each super-node appear *consecutively* (matching the order
    they had in `stops_list`), guaranteeing the contiguous visit pattern
    `[A1, A2, B, ...]` rather than the buggy `[A1, B, A2, ...]`.
    """
    flat: List[int] = []
    seen: set = set()
    for super_idx in super_sequence:
        for original_idx in super_to_originals[super_idx]:
            flat.append(original_idx)
            seen.add(original_idx)
    # Defensive: append any super-node members the solver dropped, so the
    # wrapper never silently loses a stop.
    for group in super_to_originals:
        for original_idx in group:
            if original_idx not in seen:
                flat.append(original_idx)
                seen.add(original_idx)
    return flat


def cluster_aware_solve(
    solver_fn: Callable[..., List[int]],
    matrix: Sequence[Sequence[float]],
    depot: int,
    stops_list: Optional[Sequence[Dict[str, Any]]],
    **solver_kwargs: Any,
) -> List[int]:
    """Run any `(matrix, depot, **kw) -> List[int]` solver with clustering.

    The wrapped solver sees a smaller, "physical addresses only" matrix and
    cannot interleave parcels at the same doorstep no matter how clever its
    local-search moves are. Behaviour when there's nothing to cluster (or
    `stops_list is None`) is byte-identical to calling the solver directly.

    `solver_kwargs` are forwarded verbatim — caller can still pass
    `time_limit_ms`, `runs`, `exploration_level`, `initial_indices`, etc.
    Note: any kwarg that references node indices (e.g. `initial_indices`)
    must be in the ORIGINAL index space; this wrapper does not rewrite
    those. Callers needing to pass a warm-start solution through clustering
    should drop the warm-start when stops are clustered.
    """
    if stops_list is None or not stops_list:
        return solver_fn(matrix, depot=depot, **solver_kwargs)

    reduced_matrix, super_to_originals, super_depot = cluster_supernodes(
        stops_list, matrix, depot
    )
    # Fast path: nothing collapsed — go straight to the solver.
    if len(super_to_originals) == len(stops_list):
        return solver_fn(matrix, depot=depot, **solver_kwargs)

    # Warm-start indices reference the ORIGINAL space — silently drop them
    # when the matrix is reduced rather than corrupting the seed.
    solver_kwargs = {k: v for k, v in solver_kwargs.items() if k != "initial_indices"}
    super_sequence = solver_fn(reduced_matrix, depot=super_depot, **solver_kwargs)
    return expand_supernodes(super_sequence, super_to_originals)
