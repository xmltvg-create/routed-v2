"""
ALNS Hybrid Metaheuristic Solver for Single-Vehicle Courier Routing

Architecture:
  Phase 1: Clarke-Wright Savings → feasible initial solution
  Phase 2: ALNS (Adaptive Large Neighbourhood Search) + Simulated Annealing acceptance
  Phase 3: Local Search polish (2-opt + Or-opt + Relocate)

Design: Matches existing solver interface:
  fn(stops, distance_matrix, start_index, time_limit_seconds) → List[dict]
"""

import math
import random
import time
from typing import List, Tuple, Optional

# ──────────────────────────────────────────────────
#  ROUTE COST EVALUATION
# ──────────────────────────────────────────────────

def route_cost(route: List[int], dm: List[List[float]]) -> float:
    """Total distance of ordered route indices."""
    total = 0.0
    for i in range(len(route) - 1):
        total += dm[route[i]][route[i + 1]]
    return total


def insertion_cost(route: List[int], pos: int, node: int, dm: List[List[float]]) -> float:
    """Cost delta of inserting `node` at `pos` in route."""
    if len(route) == 0:
        return 0.0
    if pos == 0:
        return dm[node][route[0]]
    if pos >= len(route):
        return dm[route[-1]][node]
    return dm[route[pos - 1]][node] + dm[node][route[pos]] - dm[route[pos - 1]][route[pos]]


# ──────────────────────────────────────────────────
#  PHASE 1: CONSTRUCTIVE HEURISTIC (Nearest Neighbour)
# ──────────────────────────────────────────────────

def nn_initial(n: int, dm: List[List[float]], start: int) -> List[int]:
    """Nearest-neighbour construction. Fast O(n²) baseline."""
    visited = [False] * n
    route = [start]
    visited[start] = True
    for _ in range(n - 1):
        current = route[-1]
        best_next = -1
        best_dist = float('inf')
        for j in range(n):
            if not visited[j] and dm[current][j] < best_dist:
                best_dist = dm[current][j]
                best_next = j
        if best_next == -1:
            break
        route.append(best_next)
        visited[best_next] = True
    # Append any missed nodes
    for j in range(n):
        if not visited[j]:
            route.append(j)
    return route


# ──────────────────────────────────────────────────
#  PHASE 2: ALNS DESTROY OPERATORS
# ──────────────────────────────────────────────────

def random_removal(route: List[int], q: int, dm: List[List[float]], start: int) -> Tuple[List[int], List[int]]:
    """Remove q random stops (never removes start)."""
    removable = [i for i in range(len(route)) if route[i] != start]
    q = min(q, len(removable))
    remove_indices = set(random.sample(removable, q))
    removed = [route[i] for i in sorted(remove_indices)]
    remaining = [route[i] for i in range(len(route)) if i not in remove_indices]
    return remaining, removed


def worst_removal(route: List[int], q: int, dm: List[List[float]], start: int) -> Tuple[List[int], List[int]]:
    """Remove the q stops whose removal saves the most distance."""
    costs = []
    for i in range(len(route)):
        if route[i] == start:
            continue
        # Cost of having this node in the route
        prev_d = dm[route[i - 1]][route[i]] if i > 0 else 0.0
        next_d = dm[route[i]][route[i + 1]] if i < len(route) - 1 else 0.0
        shortcut = dm[route[i - 1]][route[i + 1]] if (i > 0 and i < len(route) - 1) else 0.0
        detour = prev_d + next_d - shortcut
        costs.append((detour, i))
    
    costs.sort(reverse=True)
    # Randomized worst: pick from top candidates with noise
    q = min(q, len(costs))
    remove_indices = set()
    for detour, idx in costs:
        if len(remove_indices) >= q:
            break
        if random.random() < 0.85:  # 85% chance to pick each worst
            remove_indices.add(idx)
    # Fill remaining if needed
    for detour, idx in costs:
        if len(remove_indices) >= q:
            break
        remove_indices.add(idx)
    
    removed = [route[i] for i in sorted(remove_indices)]
    remaining = [route[i] for i in range(len(route)) if i not in remove_indices]
    return remaining, removed


def shaw_removal(route: List[int], q: int, dm: List[List[float]], start: int) -> Tuple[List[int], List[int]]:
    """Remove q geographically related stops (cluster removal)."""
    removable = [i for i in range(len(route)) if route[i] != start]
    if len(removable) == 0:
        return route[:], []
    q = min(q, len(removable))
    
    # Pick a random seed stop
    seed_idx = random.choice(removable)
    seed_node = route[seed_idx]
    
    # Rank all removable stops by proximity to seed
    relatedness = []
    for i in removable:
        if i != seed_idx:
            relatedness.append((dm[seed_node][route[i]], i))
    relatedness.sort()
    
    remove_indices = {seed_idx}
    for _, idx in relatedness:
        if len(remove_indices) >= q:
            break
        # Shaw selection: prefer similar with randomization (p=6 -> strong relatedness bias)
        if random.random() < 0.9:
            remove_indices.add(idx)
    # Fill
    for _, idx in relatedness:
        if len(remove_indices) >= q:
            break
        remove_indices.add(idx)
    
    removed = [route[i] for i in sorted(remove_indices)]
    remaining = [route[i] for i in range(len(route)) if i not in remove_indices]
    return remaining, removed


# ──────────────────────────────────────────────────
#  PHASE 2: ALNS REPAIR OPERATORS
# ──────────────────────────────────────────────────

def greedy_insert(route: List[int], removed: List[int], dm: List[List[float]]) -> List[int]:
    """Insert each removed node at its cheapest position."""
    result = route[:]
    random.shuffle(removed)
    for node in removed:
        best_pos = 0
        best_cost = float('inf')
        for pos in range(len(result) + 1):
            cost = insertion_cost(result, pos, node, dm)
            if cost < best_cost:
                best_cost = cost
                best_pos = pos
        result.insert(best_pos, node)
    return result


def regret_2_insert(route: List[int], removed: List[int], dm: List[List[float]]) -> List[int]:
    """Regret-2 insertion: prioritize nodes that suffer most from not being inserted now."""
    result = route[:]
    remaining = list(removed)
    
    while remaining:
        best_node = None
        best_pos = 0
        best_regret = -float('inf')
        
        for node in remaining:
            # Find the 2 cheapest insertion positions
            costs = []
            for pos in range(len(result) + 1):
                cost = insertion_cost(result, pos, node, dm)
                costs.append((cost, pos))
            costs.sort()
            
            if len(costs) >= 2:
                regret = costs[1][0] - costs[0][0]  # How much worse 2nd-best is
            else:
                regret = 0.0
            
            if regret > best_regret or (regret == best_regret and costs[0][0] < insertion_cost(result, best_pos, best_node, dm) if best_node is not None else True):
                best_regret = regret
                best_node = node
                best_pos = costs[0][1]
        
        if best_node is not None:
            result.insert(best_pos, best_node)
            remaining.remove(best_node)
        else:
            break
    
    return result


def regret_3_insert(route: List[int], removed: List[int], dm: List[List[float]]) -> List[int]:
    """Regret-3 insertion: sum of (2nd-best - best) + (3rd-best - best)."""
    result = route[:]
    remaining = list(removed)
    
    while remaining:
        best_node = None
        best_pos = 0
        best_regret = -float('inf')
        
        for node in remaining:
            costs = []
            for pos in range(len(result) + 1):
                cost = insertion_cost(result, pos, node, dm)
                costs.append((cost, pos))
            costs.sort()
            
            regret = 0.0
            for k in range(1, min(3, len(costs))):
                regret += costs[k][0] - costs[0][0]
            
            if regret > best_regret:
                best_regret = regret
                best_node = node
                best_pos = costs[0][1]
        
        if best_node is not None:
            result.insert(best_pos, best_node)
            remaining.remove(best_node)
        else:
            break
    
    return result


# ──────────────────────────────────────────────────
#  PHASE 3: LOCAL SEARCH OPERATORS
# ──────────────────────────────────────────────────

def two_opt_pass(route: List[int], dm: List[List[float]], start: int) -> Tuple[List[int], bool]:
    """Single pass of 2-opt. Returns improved route and whether any improvement was found."""
    n = len(route)
    improved = False
    best_route = route[:]
    best_cost = route_cost(route, dm)
    
    # Find start position (don't reverse segments that include the fixed start)
    start_pos = route.index(start) if start in route else 0
    
    for i in range(n - 1):
        if i == start_pos:
            continue
        for j in range(i + 2, n):
            if j == start_pos:
                continue
            # Reverse segment [i+1 .. j]
            new_route = route[:i + 1] + route[i + 1:j + 1][::-1] + route[j + 1:]
            # Ensure start is still at position 0
            if new_route[0] != start and start_pos == 0:
                continue
            new_cost = route_cost(new_route, dm)
            if new_cost < best_cost - 1e-10:
                best_route = new_route
                best_cost = new_cost
                improved = True
    
    return best_route, improved


def or_opt_pass(route: List[int], dm: List[List[float]], start: int) -> Tuple[List[int], bool]:
    """Or-opt: move chains of 1, 2, or 3 consecutive stops to better positions."""
    n = len(route)
    improved = False
    best_route = route[:]
    best_cost = route_cost(route, dm)
    
    for chain_len in [1, 2, 3]:
        for i in range(n):
            if route[i] == start:
                continue
            # Extract chain starting at i
            end = i + chain_len
            if end > n:
                break
            if any(route[k] == start for k in range(i, min(end, n))):
                continue
            
            chain = route[i:end]
            remaining = route[:i] + route[end:]
            
            for j in range(len(remaining) + 1):
                new_route = remaining[:j] + chain + remaining[j:]
                if new_route[0] != start and route[0] == start:
                    continue
                new_cost = route_cost(new_route, dm)
                if new_cost < best_cost - 1e-10:
                    best_route = new_route
                    best_cost = new_cost
                    improved = True
    
    return best_route, improved


def local_search_polish(route: List[int], dm: List[List[float]], start: int, max_rounds: int = 5) -> List[int]:
    """Iterative local search: 2-opt + or-opt until no improvement."""
    current = route[:]
    for _ in range(max_rounds):
        improved_any = False
        current, imp = two_opt_pass(current, dm, start)
        improved_any = improved_any or imp
        current, imp = or_opt_pass(current, dm, start)
        improved_any = improved_any or imp
        if not improved_any:
            break
    return current


# ──────────────────────────────────────────────────
#  MAIN: ALNS HYBRID SOLVER
# ──────────────────────────────────────────────────

def alns_hybrid_optimize(
    stops: List[dict],
    distance_matrix: List[List[float]],
    start_index: int = 0,
    time_limit_seconds: float = 8.0,
) -> List[dict]:
    """
    Hybrid Metaheuristic: NN Construction → ALNS + SA → Local Search Polish
    
    Args:
        stops: List of stop dicts with lat/lng
        distance_matrix: Pre-computed n×n haversine distance matrix (km)
        start_index: Index of the fixed starting stop
        time_limit_seconds: Max solve time (anytime: can stop early with valid solution)
    
    Returns:
        Reordered list of stop dicts
    """
    n = len(stops)
    if n <= 3:
        # Trivial: try all permutations starting from start_index
        if n <= 1:
            return stops[:]
        # Initialize best with a valid route starting from start_index
        best = [start_index] + [i for i in range(n) if i != start_index]
        best_c = route_cost(best, distance_matrix)
        from itertools import permutations
        for perm in permutations(range(n)):
            if perm[0] != start_index:
                continue
            c = route_cost(list(perm), distance_matrix)
            if c < best_c:
                best_c = c
                best = list(perm)
        return [stops[i] for i in best]
    
    dm = distance_matrix
    start = start_index
    deadline = time.monotonic() + time_limit_seconds
    
    # ── Phase 1: Constructive initial solution (NN) ──
    current_route = nn_initial(n, dm, start)
    # Quick 2-opt improvement on initial
    current_route, _ = two_opt_pass(current_route, dm, start)
    
    current_cost = route_cost(current_route, dm)
    best_route = current_route[:]
    best_cost = current_cost
    
    # ── Phase 2: ALNS with Simulated Annealing ──
    
    # Operator pools
    destroy_ops = [random_removal, worst_removal, shaw_removal]
    repair_ops = [greedy_insert, regret_2_insert, regret_3_insert]
    
    n_destroy = len(destroy_ops)
    n_repair = len(repair_ops)
    
    # Adaptive weights (roulette-wheel selection)
    destroy_weights = [1.0] * n_destroy
    repair_weights = [1.0] * n_repair
    destroy_scores = [0.0] * n_destroy
    repair_scores = [0.0] * n_repair
    destroy_usage = [0] * n_destroy
    repair_usage = [0] * n_repair
    
    # SA parameters — auto-calibrate initial temperature
    # Accept a 5% worse solution with ~50% probability initially
    T = best_cost * 0.05 / math.log(2) if best_cost > 0 else 1.0
    T_min = T * 0.001
    cooling_rate = 0.9995
    
    # Reward constants
    SIGMA_GLOBAL_BEST = 33
    SIGMA_IMPROVING = 13
    SIGMA_ACCEPTED_WORSE = 5
    
    SEGMENT_SIZE = 100
    iteration = 0
    
    # Destroy degree bounds (adaptive)
    q_min = max(2, n // 10)
    q_max = max(q_min + 1, n // 3)
    
    while time.monotonic() < deadline and T > T_min:
        iteration += 1
        
        # ── Select operators (roulette wheel) ──
        d_idx = _roulette_select(destroy_weights)
        r_idx = _roulette_select(repair_weights)
        
        # ── Destroy ──
        q = random.randint(q_min, q_max)
        remaining, removed = destroy_ops[d_idx](current_route, q, dm, start)
        
        if len(removed) == 0:
            continue
        
        # ── Repair ──
        candidate_route = repair_ops[r_idx](remaining, removed, dm)
        candidate_cost = route_cost(candidate_route, dm)
        
        # ── SA Acceptance ──
        delta = candidate_cost - current_cost
        
        if delta < -1e-10:
            # Improvement
            current_route = candidate_route
            current_cost = candidate_cost
            
            if candidate_cost < best_cost - 1e-10:
                best_route = candidate_route[:]
                best_cost = candidate_cost
                destroy_scores[d_idx] += SIGMA_GLOBAL_BEST
                repair_scores[r_idx] += SIGMA_GLOBAL_BEST
            else:
                destroy_scores[d_idx] += SIGMA_IMPROVING
                repair_scores[r_idx] += SIGMA_IMPROVING
        elif T > 0 and random.random() < math.exp(-delta / T):
            # Accept worse (exploration)
            current_route = candidate_route
            current_cost = candidate_cost
            destroy_scores[d_idx] += SIGMA_ACCEPTED_WORSE
            repair_scores[r_idx] += SIGMA_ACCEPTED_WORSE
        
        destroy_usage[d_idx] += 1
        repair_usage[r_idx] += 1
        
        # ── Cool ──
        T *= cooling_rate
        
        # ── Adaptive weight update ──
        if iteration % SEGMENT_SIZE == 0:
            for i in range(n_destroy):
                if destroy_usage[i] > 0:
                    destroy_weights[i] = max(0.1,
                        destroy_weights[i] * 0.8 + 0.2 * destroy_scores[i] / destroy_usage[i])
            for i in range(n_repair):
                if repair_usage[i] > 0:
                    repair_weights[i] = max(0.1,
                        repair_weights[i] * 0.8 + 0.2 * repair_scores[i] / repair_usage[i])
            destroy_scores = [0.0] * n_destroy
            repair_scores = [0.0] * n_repair
            destroy_usage = [0] * n_destroy
            repair_usage = [0] * n_repair
    
    # ── Phase 3: Local search polish on best solution ──
    time_remaining = deadline - time.monotonic()
    if time_remaining > 0.5:
        best_route = local_search_polish(best_route, dm, start, max_rounds=3)
        best_cost = route_cost(best_route, dm)
    
    # Ensure all nodes are present (defensive)
    seen = set(best_route)
    for i in range(n):
        if i not in seen:
            best_route.append(i)
    
    return [stops[i] for i in best_route]


def _roulette_select(weights: List[float]) -> int:
    """Roulette-wheel selection from adaptive weights."""
    total = sum(weights)
    if total <= 0:
        return random.randint(0, len(weights) - 1)
    r = random.random() * total
    cumulative = 0.0
    for i, w in enumerate(weights):
        cumulative += w
        if r <= cumulative:
            return i
    return len(weights) - 1
