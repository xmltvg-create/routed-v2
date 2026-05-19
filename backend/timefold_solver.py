"""
Timefold VRP Solver — Java-powered constraint optimization for delivery routing.
Uses Timefold (formerly OptaPlanner) with the Python SDK wrapping the Java engine.
"""
import os
import math
from dataclasses import dataclass, field
from typing import List, Annotated

os.environ.setdefault("JAVA_HOME", "/usr/lib/jvm/java-17-openjdk-arm64")

from timefold.solver import SolverFactory
from timefold.solver.config import (
    SolverConfig,
    ScoreDirectorFactoryConfig,
    TerminationConfig,
    Duration,
    EnvironmentMode,
)
from timefold.solver.domain import (
    planning_solution,
    planning_entity,
    PlanningListVariable,
    PlanningId,
    ProblemFactCollectionProperty,
    ValueRangeProvider,
    PlanningEntityCollectionProperty,
    PlanningScore,
)
from timefold.solver.score import (
    HardSoftScore,
    ConstraintFactory,
    constraint_provider,
)


# ── Domain Model ──────────────────────────────────────────────────────────────

@dataclass
class TfLocation:
    id: Annotated[str, PlanningId]
    latitude: float
    longitude: float
    order: int = 0

    def distance_to(self, other: 'TfLocation') -> float:
        R = 6371.0
        lat1, lon1 = math.radians(self.latitude), math.radians(self.longitude)
        lat2, lon2 = math.radians(other.latitude), math.radians(other.longitude)
        dlat = lat2 - lat1
        dlon = lon2 - lon1
        a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@planning_entity
@dataclass
class TfVehicle:
    id: Annotated[str, PlanningId]
    depot: TfLocation
    visits: Annotated[
        list[TfLocation],
        PlanningListVariable
    ] = field(default_factory=list)

    def total_distance(self) -> float:
        if len(self.visits) == 0:
            return 0.0
        dist = self.depot.distance_to(self.visits[0])
        i = 0
        while i < len(self.visits) - 1:
            dist = dist + self.visits[i].distance_to(self.visits[i + 1])
            i = i + 1
        return dist


@planning_solution
@dataclass
class TfVrpSolution:
    locations: Annotated[
        list[TfLocation],
        ProblemFactCollectionProperty,
        ValueRangeProvider
    ]
    vehicles: Annotated[
        list[TfVehicle],
        PlanningEntityCollectionProperty
    ]
    score: Annotated[
        HardSoftScore, PlanningScore
    ] = field(default=None)


# ── Constraints ───────────────────────────────────────────────────────────────

@constraint_provider
def vrp_constraints(cf: ConstraintFactory):
    return [
        minimize_total_distance(cf),
    ]


def minimize_total_distance(cf: ConstraintFactory):
    return (
        cf.for_each(TfVehicle)
        .penalize(HardSoftScore.ONE_SOFT, lambda vehicle: int(vehicle.total_distance() * 1000))
        .as_constraint("minimize_distance")
    )


# ── Public API ────────────────────────────────────────────────────────────────

def timefold_optimize(
    stops: List[dict],
    distance_matrix: List[List[float]],
    start_index: int = 0,
    time_limit_seconds: int = 10,
) -> List[dict]:
    locations = []
    for i, stop in enumerate(stops):
        loc = TfLocation(
            id=str(i),
            latitude=stop["latitude"],
            longitude=stop["longitude"],
            order=i,
        )
        locations.append(loc)

    depot = locations[start_index]
    visits = [loc for i, loc in enumerate(locations) if i != start_index]

    vehicle = TfVehicle(id="driver-1", depot=depot)

    problem = TfVrpSolution(
        locations=visits,
        vehicles=[vehicle],
    )

    solver_config = SolverConfig(
        solution_class=TfVrpSolution,
        entity_class_list=[TfVehicle],
        score_director_factory_config=ScoreDirectorFactoryConfig(
            constraint_provider_function=vrp_constraints,
        ),
        termination_config=TerminationConfig(
            spent_limit=Duration(seconds=time_limit_seconds),
        ),
        environment_mode=EnvironmentMode.NON_REPRODUCIBLE,
    )

    solver = SolverFactory.create(solver_config).build_solver()
    solution = solver.solve(problem)

    optimized_visits = solution.vehicles[0].visits

    # Map back using the order index — guaranteed unique
    assigned_indices = set()
    result = [stops[start_index]]
    assigned_indices.add(start_index)
    for visit in optimized_visits:
        idx = visit.order
        if idx not in assigned_indices:
            result.append(stops[idx])
            assigned_indices.add(idx)

    # Append any stops that Timefold didn't assign (safety net)
    for i, stop in enumerate(stops):
        if i not in assigned_indices:
            result.append(stop)

    return result
