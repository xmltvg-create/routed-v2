# `backend/routes/` — Domain Router Pattern

This directory holds APIRouter modules split out of the monolithic
`backend/server.py`. Use this guide to add a new domain or move an
existing block of endpoints without breaking the live app.

---

## Why this exists

`server.py` grew past 7.5k lines. Every change began risking context
exhaustion on fork handoffs, and unrelated bugs were cross-referenced 
the same file. Splitting by domain keeps each module under ~1.5k lines
and independently testable.

**First split done**: `tiles.py` (parcels + addresses tile proxies).

---

## The Pattern

Each domain module is a self-contained APIRouter that `server.py`
includes via `api_router.include_router(...)`.

### Template

```python
# backend/routes/<domain>.py
"""<one-line description — what this domain owns>

Split out of server.py for maintainability. Add a short note on any
non-obvious coupling with the parent module (e.g. "uses MongoDB via
an injected dependency", "reads env vars X/Y").
"""
from __future__ import annotations

import logging
from fastapi import APIRouter

logger = logging.getLogger("server")
router = APIRouter()

# Module-level state (caches, constants) — KEEP HERE, not in server.py.
_MY_CACHE: dict = {}

@router.get("/<domain>/<path>")
async def my_endpoint(...):
    ...
```

### Wiring in `server.py`

Add the import + include **once**, in a single spot near where the old
code lived (keeps git diffs small and reviewable):

```python
from routes.<domain> import router as <domain>_router
api_router.include_router(<domain>_router)
```

The `api_router` already has `prefix="/api"`, so the subrouter sees
paths like `/tiles/parcels/*` and clients still hit
`/api/tiles/parcels/*`. No client change required.

---

## Rules of thumb

1. **Move state with the code.** If an endpoint uses
   `_SOME_CACHE` or `_CONSTANT_URL` and nothing else in `server.py`
   references it, move it to the new module. If *anything* else still
   references it, leave it in `server.py` (for now) and `import` it
   into the new module.

2. **Never split mid-handler.** A handler and its helper must live in
   the same file unless the helper is obviously reusable across
   domains (e.g. `_tile_to_bbox` is in `tiles.py` because only tile
   endpoints use it).

3. **Dependencies on auth / db stay as function arguments or imports**
   — don't recreate `get_current_user` or the Mongo client in each
   module. Import them from `server` when needed:
   ```python
   from server import get_current_user, db
   ```

4. **Globals that are mutated** (circuit breakers, last-mirror caches)
   must stay in ONE place. If two routers need the same mutable
   global, that's a signal the global should be a dependency-injected
   singleton — discuss with the user before moving.

5. **Hot-reload smoke test every move.**
   ```
   curl -s -o /dev/null -w "%{http_code}\n" \
     https://<preview-url>/api/<endpoint-you-just-moved>
   ```
   The backend auto-reloads on file change; if you see a non-200
   from a previously-working endpoint, revert immediately.

6. **Never remove an endpoint during a split.** A split is an
   addition + a removal; both must land in the same edit so the route
   table is never missing the path.

---

## Current modules

| Module            | Status   | Endpoints                                        |
|-------------------|----------|--------------------------------------------------|
| `tiles.py`        | **Done** | `/tiles/parcels/*`, `/tiles/addresses/*`         |
| `housenumbers.py` | **Done** | `/housenumbers`, `/housenumbers/prewarm`         |
| `auth.py`         | **Done** | `/auth/session`, `/auth/me`, `/auth/logout`      |
| `stops.py`        | **Done** | `/stops` CRUD, `/stops/{id}/complete/uncomplete`, `/stops/clear`, `/stops/reorder`, `/debug/stops-coords` |
| `routing.py`      | TODO     | `/optimize`, `/directions`, `/navigation`, solvers |
| `exports.py`      | TODO     | `/export/*`, `/stops/export/xlsx`                |
| (geocoding)       | TODO     | `/stops/{id}/regeocode`, `/stops/refresh-suburbs`, `/geocode` |
| (car)             | TODO     | `/car/stop-action`, `/car/next-stops`            |

### Regression tests
Each domain router should ship with an in-process pytest file:

```
backend/tests/test_routes_<domain>.py
```

Use `TestClient(server.app)` + `app.dependency_overrides[_current_user]` to
skip auth per test. See `tests/test_routes_stops.py` for the reference
pattern — covers CRUD, delivery-status sync, delete reindex, reorder, clear
and the `/debug/stops-coords` diagnostic in 9 tests / ~4 seconds.

When picking the next module: **start with the one that has the
fewest cross-references to the rest of `server.py`**. Grep is your
friend:

```
grep -c "from server import" routes/*.py
grep -c "^def\|^async def" <candidate-block>
```

Smaller blocks with only 1-2 `server.py` imports are safest.
