"""
OSRM → OR-Tools Matrix Service
==============================

Production-ready service class that fetches a travel-time matrix from OSRM's
`/table/v1/driving/` endpoint and converts it into the integer 2D matrix that
Google OR-Tools' routing model expects.

WHEN TO USE THIS MODULE
-----------------------
    OK — Standalone scripts, tests, CLI tools, and any NEW endpoint that
    needs a clean N x N matrix with no existing async/cache/batch
    infrastructure.

WHEN NOT TO USE IT
------------------
    NOT FOR — The main FastAPI pipeline inside `server.py`. That file's
    existing `_osrm_duration_matrix()` has three features this module
    intentionally omits:
        1. `httpx.AsyncClient` (matches the server's event loop)
        2. Batching for N > ~100 coordinates (cross-batch stitching)
        3. TTL cache + Haversine fallback for unfilled cells
    Re-implementing those here would duplicate 120+ lines and produce two
    drifting codebases.  Leave `server.py` alone — use this module only
    for fresh integrations.

Why a dedicated service?
    • OR-Tools will silently misbehave or throw `TypeError` if you hand it
      floats, `None`s, or a jagged matrix. Every real-world OSRM response
      contains at least one of those land-mines (coords in the ocean, on
      ferries, or on one-way streets with no return path).
    • Constructing the `/table` URL correctly for a complete N×N asymmetric
      matrix is easy to get wrong — there's a combinatorial mis-match between
      `sources`, `destinations` and `annotations` that silently returns
      upper-triangle-only values.

This module solves both in ~150 lines with no side effects: instantiate it,
call `build_matrix(coords)`, then feed the result into OR-Tools.

Usage
-----
>>> svc = OSRMMatrixService(base_url="http://localhost:5000")
>>> coords = [(153.03, -27.46), (153.09, -27.45), (153.02, -27.50)]
>>> matrix = svc.build_matrix(coords)              # np.ndarray, shape (3, 3), int
>>> # Then in your OR-Tools model:
>>> callback = svc.to_ortools_callback(matrix, manager)
>>> transit_idx = routing.RegisterTransitCallback(callback)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import requests

logger = logging.getLogger(__name__)

# Penalty assigned to `None` entries — in seconds this is ~11.5 days, which
# OR-Tools will always prefer to avoid without overflowing any int32 capacity
# constraint the caller might also add.
UNREACHABLE_PENALTY: int = 999_999


@dataclass(frozen=True)
class MatrixResult:
    """Returned from `build_matrix()` when the caller needs metadata."""
    durations: np.ndarray           # (N, N) int32, seconds
    n_unreachable: int              # count of None cells replaced by the penalty
    source_snapped: List[Tuple[float, float]]  # coords OSRM actually snapped to


class OSRMMatrixServiceError(RuntimeError):
    """Raised on any non-recoverable failure (bad response, network, etc.)."""


class OSRMMatrixService:
    """
    Thin HTTP client + matrix formatter around OSRM's `/table` endpoint.

    Parameters
    ----------
    base_url : str
        Scheme + host of the OSRM server, e.g. ``http://localhost:5000`` or
        ``https://router.project-osrm.org``.  No trailing slash required.
    timeout_s : float, default 30
        Per-request HTTP timeout.  OSRM matrices for >200 points can legitimately
        take 20+ seconds on a cold instance, so don't cut this too short.
    profile : str, default "driving"
        OSRM routing profile.  ``driving``, ``walking`` or ``cycling``.
    session : requests.Session | None
        Optional pre-configured session for connection pooling.  One is created
        lazily if omitted.
    """

    def __init__(
        self,
        base_url: str,
        timeout_s: float = 30.0,
        profile: str = "driving",
        session: Optional[requests.Session] = None,
    ) -> None:
        if not base_url:
            raise ValueError("OSRMMatrixService requires a non-empty base_url")
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.profile = profile
        self._session = session or requests.Session()

    # ------------------------------------------------------------------ URL
    def build_table_url(self, coords: Sequence[Tuple[float, float]]) -> str:
        """
        Build the OSRM `/table` URL for a **complete N×N asymmetric matrix**.

        Even though OSRM returns a full square matrix by default when you omit
        `sources`/`destinations`, we set them EXPLICITLY to keep the contract
        bullet-proof — some self-hosted OSRM builds (especially routed-car with
        custom profiles) default to the first source only.  Explicit is safer.

        Coordinate order: OSRM expects ``longitude,latitude`` — the opposite of
        most mapping libraries.  Callers pass tuples in ``(lng, lat)`` order and
        this method does not flip them.
        """
        if len(coords) < 2:
            raise ValueError("Need at least two coordinates for a matrix")

        coord_str = ";".join(f"{lng:.6f},{lat:.6f}" for lng, lat in coords)
        indices = ";".join(str(i) for i in range(len(coords)))
        return (
            f"{self.base_url}/table/v1/{self.profile}/{coord_str}"
            f"?annotations=duration"
            f"&sources={indices}"
            f"&destinations={indices}"
        )

    # --------------------------------------------------------------- fetch
    def _fetch_raw(self, url: str) -> dict:
        """GET the OSRM URL and return the parsed JSON, or raise."""
        try:
            resp = self._session.get(url, timeout=self.timeout_s)
        except requests.RequestException as e:
            raise OSRMMatrixServiceError(f"OSRM network error: {e}") from e
        if resp.status_code != 200:
            raise OSRMMatrixServiceError(
                f"OSRM returned HTTP {resp.status_code}: {resp.text[:200]}"
            )
        try:
            payload = resp.json()
        except ValueError as e:
            raise OSRMMatrixServiceError("OSRM response was not valid JSON") from e
        if payload.get("code") != "Ok":
            raise OSRMMatrixServiceError(
                f"OSRM response code={payload.get('code')}: {payload.get('message')}"
            )
        return payload

    # --------------------------------------------------------------- parse
    @staticmethod
    def parse_to_integer_matrix(payload: dict, n: int) -> Tuple[np.ndarray, int]:
        """
        Convert the ``durations`` 2D array from an OSRM response into a clean
        int32 NumPy matrix suitable for OR-Tools.

        Steps:
            1. Materialise the list-of-lists into an ``object`` dtype NumPy array
               so we can detect `None`s uniformly without per-cell Python loops.
            2. Count and mask the unreachable cells, replace them with the
               `UNREACHABLE_PENALTY` sentinel.
            3. Round and cast to int32 — OR-Tools' C++ core uses int64 internally
               but accepts Python ints; int32 is plenty for seconds-per-leg.

        Returns
        -------
        matrix : np.ndarray, shape (n, n), dtype=int32
        n_unreachable : int
        """
        raw = payload.get("durations")
        if not isinstance(raw, list) or len(raw) != n or any(len(r) != n for r in raw):
            raise OSRMMatrixServiceError(
                f"Malformed durations matrix — expected {n}x{n}, got "
                f"{type(raw).__name__} of shape {len(raw) if isinstance(raw, list) else '?'}"
            )

        # object dtype lets numpy keep `None`s during the mask step.
        obj = np.array(raw, dtype=object)
        unreachable_mask = (obj == None)  # noqa: E711 — element-wise against None
        n_unreachable = int(unreachable_mask.sum())

        # Replace Nones with penalty, then vectorised float -> int round.
        obj[unreachable_mask] = UNREACHABLE_PENALTY
        floats = obj.astype(np.float64)
        # `np.rint` is the fastest correct rounding op in NumPy (banker's rounding).
        ints = np.rint(floats).astype(np.int32, copy=False)

        # Diagonal MUST be zero — some OSRM builds return tiny non-zero snapping
        # distances (e.g. 0.4 s) that round up and mess with OR-Tools capacity.
        np.fill_diagonal(ints, 0)

        return ints, n_unreachable

    # ------------------------------------------------------------ pipeline
    def build_matrix(
        self, coords: Sequence[Tuple[float, float]]
    ) -> MatrixResult:
        """
        Fetch + parse in one call.  Raises `OSRMMatrixServiceError` on failure.

        Example
        -------
        >>> svc = OSRMMatrixService("http://localhost:5000")
        >>> result = svc.build_matrix([(153.03, -27.46), (153.09, -27.45)])
        >>> result.durations[0, 1]      # seconds from stop 0 to stop 1
        432
        """
        url = self.build_table_url(coords)
        payload = self._fetch_raw(url)
        matrix, n_unreachable = self.parse_to_integer_matrix(payload, len(coords))

        snapped: List[Tuple[float, float]] = []
        for source in payload.get("sources", []):
            loc = source.get("location") if isinstance(source, dict) else None
            if isinstance(loc, list) and len(loc) == 2:
                snapped.append((float(loc[0]), float(loc[1])))

        if n_unreachable:
            logger.warning(
                "OSRM matrix contained %d unreachable cells — penalty %d applied",
                n_unreachable,
                UNREACHABLE_PENALTY,
            )
        return MatrixResult(
            durations=matrix,
            n_unreachable=n_unreachable,
            source_snapped=snapped,
        )

    # -------------------------------------------------- OR-Tools integration
    @staticmethod
    def to_ortools_callback(
        matrix: np.ndarray,
        manager,  # pywrapcp.RoutingIndexManager — duck-typed to avoid hard dep
    ) -> Callable[[int, int], int]:
        """
        Wrap a prepared int matrix into the exact callback signature OR-Tools
        wants for `routing.RegisterTransitCallback`.

        OR-Tools feeds "internal" indices to the callback, NOT the node indices
        the caller used to build the matrix — the manager translates between
        them.  Forgetting this is the single most common bug in first OR-Tools
        integrations.

        Parameters
        ----------
        matrix : np.ndarray, shape (N, N), int
            The output of `build_matrix(...).durations`.
        manager : RoutingIndexManager
            The manager associated with the RoutingModel.
        """
        # Cache the `.item()` → plain Python int coercion outside the closure so
        # OR-Tools' tight inner loop never pays the numpy-scalar overhead.
        arr = matrix

        def time_callback(from_index: int, to_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            return int(arr[from_node, to_node])

        return time_callback


# --------------------------------------------------------- boilerplate demo
def build_ortools_model_example(
    coords: Sequence[Tuple[float, float]],
    osrm_base_url: str,
    depot: int = 0,
    num_vehicles: int = 1,
) -> None:
    """
    End-to-end example showing how `OSRMMatrixService` plugs into OR-Tools.

    Doesn't actually solve — this is reference boilerplate for readers who
    want to copy it verbatim.  Imports OR-Tools lazily so this file can be
    imported in environments without it installed.
    """
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2  # type: ignore

    svc = OSRMMatrixService(osrm_base_url)
    result = svc.build_matrix(coords)

    manager = pywrapcp.RoutingIndexManager(len(coords), num_vehicles, depot)
    routing = pywrapcp.RoutingModel(manager)

    transit_idx = routing.RegisterTransitCallback(
        svc.to_ortools_callback(result.durations, manager)
    )
    routing.SetArcCostEvaluatorOfAllVehicles(transit_idx)

    search_params = pywrapcp.DefaultRoutingSearchParameters()
    search_params.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )

    solution = routing.SolveWithParameters(search_params)
    if solution is None:
        raise RuntimeError("OR-Tools failed to find a solution")

    # Caller would extract + return the route here.
    _ = solution  # pragma: no cover — example only
