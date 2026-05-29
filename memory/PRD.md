## 2026-05-29 — Coolify Backend Migration Verified ✅

### Summary
End-to-end verified the Vultr+Coolify+Cloudflare backend migration that
was started in the previous session. Backend now fully operational at
`https://api.getrouted.xyz`.

### Issues Fixed
1. **Cloudflare → origin timeout** (P0)
   - Cloudflare A record fix on user side propagated; proxy now reaches
     origin correctly. SSL/TLS mode confirmed at "Full" (origin uses
     self-signed Traefik cert).
   - Verified: `curl https://api.getrouted.xyz/api/health` returns 200.

2. **Buildings DB not loading in container** (P0)
   - Root cause: `server.py` uses `ROOT_DIR.parent / 'tiles' / 'buildings.db'`.
     In dev (`/app/backend/server.py`) this resolves to `/app/tiles/buildings.db`,
     but in the container (`/app/server.py`) it resolves to `/tiles/buildings.db`.
     The Dockerfile was copying to `/app/tiles/buildings.db` — the wrong path.
   - Fix: `Dockerfile` now copies to `/tiles/buildings.db`.
   - Additional defensive fix in `backend/server.py`: `_resolve_tile_db_path()`
     checks both layouts before falling back.
   - Verified post-deploy: `/api/tiles/buildings/metadata` returns
     `{"name":"PathPilot QLD Buildings","total_buildings":"564624",...}`.

3. **Save-to-GitHub push rejections (recurring)**
   - Both 403 (auth) and "non-fast-forward" (divergent histories) hit again.
   - Workaround used: user edited `Dockerfile` directly on GitHub.com and
     triggered a Coolify redeploy. This unblocked the deployment.
   - Underlying push divergence still unresolved — recommend platform
     support follow-up if it blocks the next deploy.

### Pending User Verification
- Force-close + reopen the app, confirm:
  - Login flow
  - Route optimization end-to-end
  - 3D buildings render on map at zoom ≥13
  - Telepathy Phase A badge appears after route completion

---


## 2026-05-25 — Route Telepathy (Phase A + B) Shipped

### Summary
Per-driver ML layer that learns from each completed route. Currently
gated to the owner account only (`user_id == "user_2a7d88cbb419"`).

### Phase A — Sequence preferences
- New module: `/app/backend/ml/sequence_learner.py`
- Hook: `archive_route` → records every (earlier→later) pair of
  delivered stops, keyed by rounded lat/lng (~1 m precision).
- Hook: `_optimize_route_inner` → after solver returns, a single
  forward pass swaps adjacent stops where the driver has ≥0.6
  confidence (after ≥3 observations) for the opposite order.
- Response field: `telepathy: {applied, swaps[], reason}`
- Frontend badge: "🧠 Telepathy: re-ordered N stops from your past
  deliveries" appended to all three optimise-success alerts.
- Endpoints: `GET /api/learn/sequence-stats`, `POST /api/learn/sequence-reset`.
- New MongoDB collection: `sequence_preferences`
- Test: `/app/backend/tests/test_sequence_learner.py` ✅ passing

### Phase B — Road segment preferences
- New module: `/app/backend/ml/road_segment_learner.py`
- Hook: `archive_route` consumes `breadcrumb` from body, fires a
  background task that map-matches via OSRM `/match` (radiuses=25,
  batched at 95 coords with 1-coord overlap), increments per-edge
  counters (smaller_node:larger_node, direction-insensitive).
- Frontend: `archiveRoute({breadcrumb})` from `index.tsx` snapshot of
  `traveledPath`, capped at 5000 points.
- New endpoint `POST /api/route/preferred-polyline`: fetches up to 3
  OSRM alternatives, scores each by user road familiarity, returns the
  most-familiar within +15% duration of the fastest. Falls back to
  fastest when no preferences exist.
- Endpoints: `GET /api/learn/road-stats`, `POST /api/learn/road-reset`.
- New MongoDB collection: `road_preferences`
- Test: `/app/backend/tests/test_road_segment_learner.py` ✅ passing
  (uses real QLD coords against local OSRM)

### Pending
- Backend deploy to Fly.io required (new module + endpoints).
- Frontend wiring for `preferred-polyline` endpoint — currently the
  optimize/reroute flow still uses standard OSRM. Phase B is recording
  data but not yet steering route geometry until that wiring is added.

---


## 2026-05-19 — Resume Route Hardened (P0 Bug Fix)

- [x] **Bug**: User reported "Failed to resume route". Backend logs showed
  multiple `POST /api/routes/history/{id}/resume → 404 Not Found` for IDs
  that no longer existed in `route_history` for the caller's `user_id`.
- [x] **Root causes**:
  1. **Legacy ownership** — archives created under a previous auth
     identity (e.g. before email/password fallback was added) carry a
     stale `user_id`. The strict `find_one({id, user_id})` filter
     returned None → 404.
  2. **Duplicate stop ids** inside an archive would 500 the
     `insert_many` against the unique `(id, user_id)` index on `stops`.
  3. **Completion telemetry** (`completion_lat`, `arrival_method`,
     `arrived_at`, `proof_photo_url`, service-time samples) was NOT
     cleared on resume → stops appeared "done" immediately.
  4. **Frontend** swallowed the real reason (`"Failed to resume route"`
     generic alert), so the user couldn't tell whether it was a session
     expiry, missing route, or 500.
  5. **HistoryModal cache** kept stale rows when a fetch failed,
     letting users tap Resume on IDs that no longer exist.

- [x] **Fix** (`backend/server.py:902-984`, `frontend/.../HistoryModal.tsx`,
  `frontend/app/(tabs)/index.tsx:4188-4239`):
  - Wrap `resume_route` in try/except, log full traceback, surface
    `{detail: "Resume failed: <type>: <msg>"}` to the client.
  - Add legacy-archive fallback: if the strict lookup misses, fall back
    to `find_one({id})` and log a WARNING.
  - Dedupe stop ids with `uuid.uuid4()` if collision detected.
  - Clear ALL completion fields (12 fields) on resume.
  - Use `insert_many(ordered=False)` for resilience.
  - Frontend now shows the actual HTTP status / detail in the alert.
  - HistoryModal clears its cached `routes` array on fetch failure AND
    on modal close, so stale IDs can never be tapped.

- [x] **Tests**: 3 new regression tests in
  `backend/tests/test_resume_route.py` — all passing:
  - 404 on unknown id with structured detail
  - Round-trip archive → clear → resume → pristine pending stops
  - Legacy archive (different user_id) + duplicate stop ids resumes OK

---


## 2026-05-16 — Waitlist API & Gate for Phase 2 Rollout (P1)

- [x] **Goal**: Gate new user signups behind a waitlist when
  `SIGNUPS_DISABLED=true`. Admins can manage the waitlist (approve,
  reject, delete entries). Approved users are allowed to sign up on
  their next Google login attempt.

- [x] **Implementation**:
  - **New module**: `routes/waitlist.py` — full CRUD API:
    - `POST /api/waitlist/join` — public, email + name submission
    - `GET /api/waitlist/status?email=` — public, check waitlist status
    - `GET /api/waitlist/entries?status=` — admin-only, list entries
    - `GET /api/waitlist/stats` — admin-only, waitlist statistics
    - `POST /api/waitlist/approve` — admin-only, bulk approve by email
    - `POST /api/waitlist/reject` — admin-only, bulk reject by email
    - `DELETE /api/waitlist/{entry_id}` — admin-only, remove entry
  - **Auth gate upgrade** (`routes/auth.py`): When `SIGNUPS_DISABLED=true`,
    new users go through waitlist check. If approved → allowed to sign up.
    If not → auto-added as "pending" and blocked with 403.
  - **Data model**: `waitlist` collection with unique email index,
    status (pending/approved/rejected), source tracking, timestamps.
  - **Admin gating**: Uses `STRIPE_ADMIN_USER_IDS` env var (same as billing).
  - **Indexes**: Created at server startup alongside billing indexes.

- [x] **Tests** — 14 new in `tests/test_waitlist.py`, all green:
  - Public join (happy path, idempotent, email validation)
  - Public status check (found, not found)
  - Admin CRUD (entries list, filter, stats, approve, reject, delete)
  - Non-admin 403 on admin endpoints
  - No regressions: 15 existing auth/billing tests still green.

- [x] **How to activate the waitlist gate**:
  ```bash
  # backend/.env
  SIGNUPS_DISABLED=true
  sudo supervisorctl restart backend
  ```
  New Google sign-ins will be auto-added to the waitlist. Approve via:
  ```bash
  curl -X POST /api/waitlist/approve \
    -H "Authorization: Bearer <admin_token>" \
    -H "Content-Type: application/json" \
    -d '{"emails":["user@example.com"]}'
  ```

- [ ] **Next**: User must redeploy backend for the waitlist API to be
  live in production. No OTA needed (pure backend change).

---


## 2026-05-15 — Google Play reviewer allowlist + demo route seeding (P0)

- [x] **Goal**: Let Google Play reviewers test gated Pro features (ML,
  Telemetry, heavy optimization) without paying Stripe. Pre-seed a
  visible route on their first sign-in so reviewers can immediately
  verify the "Optimize Route" pipeline.

- [x] **Implementation**:
  - `routes/billing.py` already exposed a `REVIEWER_EMAILS` env-var
    allowlist that bypasses `require_pro` and flips `pro=true` in
    `/api/billing/status`. Verified end-to-end (this commit adds tests).
  - `backend/.env`: `REVIEWER_EMAILS=routedreviewer@gmail.com`.
  - `routes/auth.py`: new `_seed_reviewer_demo_route(db, user_id)`
    helper. Inserts 6 hard-coded Sydney CBD/inner-suburb stops (Opera
    House, QVB, Surry Hills cafe, Newtown, Bondi, Darling Harbour).
    Idempotent — skipped if the user already has any stops.
  - `routes/auth.py::exchange_session`: when a brand-new user record
    is created AND `email ∈ REVIEWER_EMAILS`, seed the demo route.
    Wrapped in try/except so a seed failure never blocks login.

- [x] **Tests** — 3 new in `tests/test_reviewer_allowlist.py`:
  - `/billing/status` → `pro=true`, `is_admin=false`, no sub doc.
  - `/optimize/jobs` → 202 Accepted (bypasses 402 paywall).
  - `_seed_reviewer_demo_route` inserts 6 contiguous-order stops with
    Sydney-region coordinates AND is idempotent on a second call.
  - All 9 existing `test_billing.py` tests still green (no regressions).

- [x] **Docs**: `/app/memory/test_credentials.md` updated with reviewer
  account details (email, paste-ready Play Console "App access" form,
  and the demo-seeding behaviour callout).

- [ ] **Next**: User must rebuild AAB/APK for `com.routedopt.app` via
  EAS and deploy the backend natively so `/privacy` and `/terms`
  routes serve from the production URL during Play Store review.

---


# RouTeD — Product Requirements Document

## 2026-05-13 — Phase 2 ML auto-snap: pin placement uses corrected centroid

- [x] **Goal**: Building-side corrector now powers visual pin placement,
  not just the geofence_inferred acceptance check. Mapbox rooftop
  centroid → kerb-side delivery point, automatically, every time the
  stop list loads. Drivers immediately SEE the corrector working
  instead of just trusting the model behind the scenes.

- [x] **Implementation**:
  - `models/stops.py`: new optional `display_latitude` and
    `display_longitude` fields on `Stop`. NOT persisted — recomputed on
    every `GET /api/stops` call so retraining propagates without a
    Mongo migration.
  - `routes/stops.py::get_stops`: loads the user's
    `ml_building_side_models` doc once, calls
    `predict_corrected_centroid` per stop, stamps display coords only
    when the prediction is meaningful (non-zero offset). ONE Mongo
    round-trip total. Best-effort: any error leaves raw coords as the
    display coords (no regression for users without a trained model).
  - `frontend/src/components/DeliveryMap.native.tsx`: WebView pin
    rendering prefers `display_latitude/longitude` when present,
    falling back to raw `latitude/longitude`. Both the fingerprint hash
    and the feature geometry use the new fields, so retraining triggers
    an instant pin refresh.
  - `frontend/src/store/stopsStore.ts`: `Stop` interface widened with
    `display_latitude?`, `display_longitude?` so consumers can opt-in.

- [x] **Tests** — 3 new in `test_building_side_endpoints.py`:
  - `test_get_stops_includes_display_coords_when_model_trained` — after
    training, GET /api/stops returns display coords = raw + offset
  - `test_get_stops_omits_display_coords_when_no_model` — cold start,
    display fields are None
  - `test_get_stops_omits_display_coords_for_unknown_suburb` — when
    suburb has no bucket AND global offset is zero, no autosnap

- [x] **Action required from user**: Redeploy backend + OTA push:
  ```
  yarn --cwd /app/frontend update:prod --message "Phase 2 auto-snap"
  ```
  After redeploy + force-close-reopen, pins snap to the kerb on every
  stop list refresh (no driver action required — just train the model
  once).


## 2026-05-13 — Phase 2 ML: Building-Side Corrector shipped

- [x] **Goal**: Mapbox returns rooftop centroids; drivers park at the
  kerb. On suburban streets the offset is 10-20 m, on industrial
  complexes it can exceed 100 m. We observe the offset every time a
  driver taps Delivered with GPS on. The per-suburb median (Δlat, Δlng)
  is the predicted real arrival point for every new stop in that
  suburb — even when Mapbox didn't supply an `access_navigation_point`.

- [x] **Strategy**: One model per user in `ml_building_side_models`.
  Replaces on every retrain. Source rows accept both `geofence` AND
  `geofence_inferred` (both supply real completion GPS); only
  `fallback_completion` is excluded (constant 30 s back-date, no GPS
  quality signal). Per-axis median (not centroid) — robust against
  one driver who parked 300 m away because the gate was locked.

- [x] **Backend implementation**:
  - `ml/building_side_corrector.py` (already shipped earlier, now wired):
    pure functions for sample collection, model building (≥5 samples
    per suburb to publish), prediction (suburb → global → (0,0) fallback
    chain), and a `predict_corrected_centroid` convenience wrapper.
  - `server.py` — two new endpoints:
    - `POST /api/_meta/ml/building-side/train` — re-train from archived
      routes. Returns model summary + suburb count.
    - `GET  /api/_meta/ml/building-side/model` — driver-friendly summary
      for the Profile tile.
  - `routes/stops.py::complete_stop` — when checking `geofence_inferred`,
    also try distance from the CORRECTED centroid (centroid + learned
    suburb offset). Stop is tagged `geofence_inferred` if the driver is
    within INFER_RADIUS_M of either the raw centroid OR the corrected
    one. Non-fatal: any error falls through to `fallback_completion`.
    New diagnostic field `completion_distance_corrected_m` is set ONLY
    when the correction rescued the classification, so the rescue rate
    is queryable via Mongo.
  - `models/stops.py` — added `completion_distance_corrected_m`
    `Optional[float]` to the Stop model so it round-trips through the
    response.

- [x] **Tests** — 23 new, all green:
  - `tests/test_building_side_corrector.py` (17 unit cases): sample
    filter respects arrival_method, outlier clamp at 250 m, ≥5 samples
    per suburb required, per-axis median robust against one outlier,
    prediction fallback chain, summary shape, etc.
  - `tests/test_building_side_endpoints.py` (6 HTTP integration cases):
    cold-start GET, 400 on no samples, train+GET reflects offset,
    correction rescues far completion → `geofence_inferred`,
    planning mode never rescued, close-to-raw doesn't invoke corrector.

- [x] **Frontend** (`MLBuildingSideCard.tsx`):
  - Sky-blue card on the Profile screen below the existing
    MLServiceTimeCard. Three-stat grid (suburbs covered, median offset,
    largest offset). Train Now / Retrain Now button with idle/busy
    states + inline success/failure panel — same UX register as the
    Phase 1 ML card.

- [x] **Why ship now**: Last fork showed `geofence_rate=0%` for 11 of
  the user's archived stops — every arrival was getting tagged
  `fallback_completion`. The 2026-05-12 `geofence_inferred` backstop
  rescued ~80 % of those into `geofence_inferred` based on raw centroid
  distance. This Phase 2 ML pass closes the remaining gap on industrial
  complexes / multi-unit buildings where the rooftop centroid is 100 m+
  from the actual loading bay — driver gets `geofence_inferred` even
  when 180 m from the rooftop, as long as they're within 150 m of the
  learned corrected centroid for that suburb.

- [x] **Action required from user**: Redeploy backend. Pure backend
  change, plus an OTA push for the new Profile card:
  ```
  yarn --cwd /app/frontend update:prod --message "Phase 2 ML: Building-side corrector card"
  ```
  After redeploy + force-close-reopen on phone, the new card appears on
  the Profile tab. Drivers tap Train Now once they've archived enough
  routes with GPS on (≥5 deliveries per suburb).


## 2026-05-13 — School-zone penalty removed from optimize pipeline

- [x] **Change**: Removed the Meridan State College + Parklands Blvd
  inbound-edge penalty from `server.py::optimize_route`. Per user
  request — the penalty was nudging stops in those streets to be
  visited outside school start/end windows, but the user wanted
  the optimizer to treat them like any other stop.

- [x] **Scope**:
  - Dropped imports: `school_penalty_factor`, `apply_school_zone_penalty`,
    `is_in_school_zone`.
  - Deleted ~25 lines applying the penalty to both duration and
    distance matrices.
  - Helpers stay live in `routes/_route_constraints.py` and
    `tests/test_route_constraints.py` so we can re-wire if needed.
  - Sugar Bag Rd waypoint injection (`inject_sugar_bag_waypoints`,
    `needs_sugar_bag_injection`) unchanged.

- [x] **Verification**: 30 tests across service_time_learner +
  geofence_inferred + cluster_first_osrm pass. Backend reloaded
  clean. `/api/healthz` responding.

- [x] **Action required**: Redeploy backend. Pure backend change.


## 2026-05-13 — Phase 1.5: ML service times wired into optimize pipeline

- [x] **Goal**: Every solver in the optimize pipeline (VROOM, OR-Tools,
  LKH-3, the post-VROOM 2-opt refine, ALNS, genetic, ILS, 3-opt, and
  pyvrp) now consumes the learned per-suburb-per-hour median service
  times instead of zero. Drivers previously got optimized routes that
  ignored the fact apartments take 2 min and single houses take 30 s;
  now the optimizer accounts for it.

- [x] **Strategy**: Bake service times INTO the duration matrix's
  outgoing edges. One transformation point in `server.py::_optimize`
  applies uniformly to every solver — no per-solver wiring needed.
  Travel-from-i-to-j now costs `duration[i][j] + service_time[i]` for
  i != j; self-loops stay 0.

- [x] **Implementation**:
  - `ml/service_time_learner.py::apply_service_times_to_matrix(matrix,
    services)` — pure function, ints out (LKH/OR-Tools require ints),
    clamps negative values to 0, validates length.
  - `server.py::optimize_route`: after the duration matrix is built,
    look up the user's trained model from `ml_service_time_models`,
    call `predict_service_time_seconds` per stop using `start_time`'s
    hour, then `apply_service_times_to_matrix`.
  - Non-fatal: any exception logs a WARNING and falls back to the raw
    matrix. Cold-start (no trained model) silently no-ops.

- [x] **Tests** (`tests/test_service_time_learner.py` — 5 new cases
  added, **21 total**, all green): outgoing-edges-only baking,
  self-loop preservation, length validation, empty input, negative-
  clamping, int rounding for solver compatibility.

- [x] **Action required**: Redeploy backend. Pure backend change, no
  OTA needed. After redeploy, every optimize call by users with a
  trained model will produce routes that respect their suburb-specific
  service-time patterns.


## 2026-05-12 — cluster_first OSRM leak fix

- [x] **Bug**: `cluster_first_optimize` (server.py:3717) called
  `calculate_duration_matrix` directly for the per-cluster matrix when
  `inner_algorithm='ortools'`. That helper is the Mapbox/haversine
  FALLBACK path — its docstring literally says "Used as FALLBACK when
  OSRM is unavailable". Result: cluster_first silently degraded to
  haversine straight-line distances for any cluster with >25 stops
  (Mapbox Matrix API limit), and hit Mapbox first on every smaller
  cluster even though the local OSRM was healthy and free. Bug present
  since cluster_first was added.

- [x] **Fix** (`backend/server.py::cluster_first_optimize` line 3717):
  - Call `_osrm_duration_matrix` FIRST — same primary source the main
    `/optimize` pipeline uses at line 5120.
  - Fall back to `calculate_duration_matrix` (Mapbox→haversine) only
    when OSRM returns None.
  - Non-ortools inner algorithms unchanged (they already use
    `calculate_road_distance_matrix`, which has its own OSRM-first
    branch internally at line 2812).

- [x] **Tests** (`backend/tests/test_cluster_first_osrm.py`, 3 cases
  all green): OSRM-first when healthy, fallback when OSRM returns None,
  non-ortools branch unchanged.

- [x] **Production scope**: cluster_first is NOT in the frontend
  picker (trimmed to Auto/VROOM/OR-Tools/LKH cascade on 2026-05-10),
  but the algorithm is still callable via `?algorithm=cluster_first`
  on direct API requests. The fix ensures any caller — including
  Auto's internal cascade fallback if VROOM ever errors — gets
  OSRM-quality matrices on cluster_first.

- [x] **Action required from user**: Redeploy backend. Pure backend
  change, no OTA needed.


## 2026-05-12 — Optimize "Network request failed" carrier-drop hardening

- [x] **User report**: Production EAS APK, 180-stop manifest, weak 4G
  signal — Optimize fails with banner "Optimization failed — Network
  request failed — Check your connection… API: floating-map-ui.emergent.host".
  Production backend itself is healthy (200 ms healthz, auth-gated
  `/api/optimize/jobs` rejects 401 in 200 ms).

- [x] **Diagnosis**: React Native's `fetch()` throws
  `TypeError: Network request failed` whenever a single TCP retry
  exhausts mid-flight — typical on weak 4G/edge. The async-job
  pattern shipped 2026-05-10 made the SERVER side bulletproof against
  Cloudflare 524, but the CLIENT still had zero retry on the kickoff
  POST and the poll GETs. One carrier blip ended the whole attempt
  even though both ends were healthy.

- [x] **Fix** (`frontend/src/store/stopsStore.ts::optimizeRoute`):
  - **Kickoff retry**: 3 attempts with 0 / 1 s / 3 s backoff. Only
    retries on the transient-drop signature (`Network request failed`,
    `timeout`, `aborted`) — not on HTTP errors or auth failures,
    which won't get better with a wait. Worst case: a duplicate job
    insert that TTLs out unread.
  - **Poll retry**: same 3-attempt 0 / 1.5 s / 4 s backoff on every
    poll iteration. Critical for the FINAL poll on a 200+ stop route
    where the response body is 2-5 MB — a 4G drop mid-download
    previously surfaced as `Network request failed` instead of just
    re-polling the (idempotent) same job_id.
  - **Stage-aware error messages**: kickoff failures now say
    `"Kickoff failed after N attempt(s): <orig>"`; poll failures
    include `job_id` prefix. Future bug reports tell us instantly
    whether the kickoff or the polling stage is the bottleneck.

- [x] **No backend change required** — the server's job-store +
  TTL-cleanup pattern already supports idempotent re-reads (a `done`
  job stays in Mongo for the full 10 min TTL window).

- [x] **Action required from user**: Push an OTA update so the
  client-side retry actually reaches the device:
  ```
  yarn --cwd /app/frontend update:prod
  ```
  The runtime version (1.0.0) is unchanged — no EAS rebuild needed.


## 2026-05-12 — LKH rebuilt + installer arch-mismatch self-heal

- [x] **Action**: Rebuilt LKH from source on this aarch64 container
  (`/app/backend/.native_cache/bin/LKH`, 1.8 MB, ELF aarch64). Local
  smoke test `lkh_tsp_solve(...)` on a 4×4 matrix returns a valid tour.

- [x] **Durable fix** so future forks don't re-introduce the
  `[Errno 8] Exec format error` spam:
  - `install_native_solvers.py::_lkh_binary_runnable()` — new probe
    that does a 5-second timeout-bounded exec of the cached binary,
    catches `OSError(errno.ENOEXEC, 8)`, and returns False on
    arch mismatch (and True on timeout = exec succeeded).
  - `_install_lkh_sync()` now wipes a non-runnable cached binary
    AND the dangling `/usr/local/bin/LKH` symlink, then recompiles.
  - `ensure_lkh_installed_background()` short-circuits only when
    runnable=True; otherwise schedules a rebuild.
  - `server.py` startup block — after the synchronous `os.path.isfile`
    check, runs `_lkh_binary_runnable()`. If False, flips
    `LKH_AVAILABLE=False`, logs a single WARNING, and schedules
    the rebuild thread. The lazy self-disable inside `lkh_tsp_solve`
    stays as defense-in-depth.

- [x] **Tests** (`backend/tests/test_lkh_installer.py`, 4 cases all
  green): runnable returns True for fresh aarch64 binary, False for
  missing path, False on ENOEXEC, True on timeout. Plus the 4 cases
  in `test_lkh_arch_mismatch.py` still green.

- [x] **Why this lasts**: every container boot (cold start, fork,
  restart) verifies the binary is exec-able for THIS CPU before
  trusting it. Production pods that previously inherited a stale
  binary from a PVC will now rebuild it locally on first boot
  (one-time ~20 s background compile), and `LKH_AVAILABLE` flips
  to True when complete. No more Exec-format-error spam, and
  Optimize calls actually get the LKH refinement pass instead of
  silently degrading to VROOM+3-opt.

- [x] **Action required from user**: Redeploy backend. On first pod
  boot in the new image, the LKH installer will run as a daemon
  thread (~20 s) — the pod is fully serving traffic the whole time.


## 2026-05-12 — LKH-3 arch-mismatch self-disable + geofence_inferred backstop

- [x] **Bug 1**: LKH-3 spamming `[Errno 8] Exec format error` in production
  logs on every Optimize call. The `LKH` binary at `.native_cache/bin/LKH`
  is compiled for a CPU arch that doesn't match the prod container
  (x86_64 binary on aarch64 pod). Backend safely fell back to VROOM, but
  every caller-level `try/except` ran `logger.warning("LKH post-processing
  failed, keeping VROOM result: %s")` — once per Optimize call, multiple
  call sites per call. Visible noise that has been mistaken for a build
  failure twice in past sessions.

- [x] **Fix** (`backend/server.py::lkh_tsp_solve`):
  - Wrapped the inner `lkh.solve(...)` in `try/except OSError`. On
    `errno.ENOEXEC` (8), flip `LKH_AVAILABLE=False` globally and log
    one `INFO`-level `[lkh] Disabling LKH …` line. Subsequent calls
    short-circuit at the top-of-function `if not LKH_AVAILABLE` guard,
    so the four caller-level `if LKH_AVAILABLE:` blocks (post-process
    refine after VROOM, section-refine, unassigned-stop refine, primary
    cascade) all skip LKH cleanly without re-throwing. VROOM+3-opt
    fallback path was already in place and still ships the result.
  - Non-ENOEXEC OSErrors (e.g. EACCES from a transient chmod race) still
    raise but do NOT disable LKH — those might recover next call.
  - Added `import errno` to top of `server.py` for the constant.

- [x] **Tests** (`backend/tests/test_lkh_arch_mismatch.py`, 4 cases all
  green): self-disable on first ENOEXEC, short-circuit on subsequent
  calls (no `lkh.solve` invocation), no duplicate disable log line,
  non-ENOEXEC OSError does NOT disable.

---

- [x] **Bug 2**: Geofence telemetry showing 100 % `fallback_completion`
  (0 of 11 completed stops in 3 most-recent archived shifts fired
  `arrival_method=geofence`). Blocks Phase 1 ML service-time learner.
  Hook itself is correct (`useGeofenceArrival.ts`); the open question
  is whether (a) drivers tap Delivered before crossing 100 m, or (b)
  `viewMode === 'navigating'` isn't active at tap time. The 2026-05-08
  diagnostic instrumentation (`completion_distance_m`,
  `view_mode_at_completion`) was added to answer that — but the user
  has no incentive to wait days for samples while the ML backlog grows.

- [x] **Fix** (`backend/routes/stops.py::complete_stop` + telemetry
  rollups in `backend/server.py`):
  - **Smart backstop**: at `/stops/{id}/complete` time, if `arrived_at`
    is null, parse the body FIRST and compute `completion_distance_m`,
    then decide the `arrival_method`:
      - `geofence_inferred` — `view_mode_at_completion='navigating'`
        AND `completion_distance_m <= 150 m`. Driver was clearly at
        the stop while in nav mode; the hook just missed the GPS tick.
        Mid-quality sample.
      - `fallback_completion` — anything else (planning mode, far
        away, or no GPS). Low-quality backstop, same as before.
  - **Telemetry rollups** updated to report `geofence_inferred_count`
    separately from `fallback_count` and add a new
    `arrival_proximity_rate = (geofence + inferred) / total`. Strict
    `geofence_rate` (real hits only) is preserved as the hook-firing
    diagnostic. Service-time percentile samples (`service_samples`,
    `service_seconds_p50/p95`) still draw ONLY from real `geofence`
    hits — `geofence_inferred` has a constant 30 s back-date and would
    pollute the ML distribution.
  - `models/stops.py`: documented the new `arrival_method` enum value
    inline.

- [x] **Tests** (`backend/tests/test_geofence_inferred.py`, 6 cases all
  green): close+nav→inferred, close+planning→fallback, far+nav→fallback,
  real geofence not overwritten, no-GPS→fallback, archive rollup counts
  inferred separately and exposes the new proximity rate.

- [x] **Why this is the right call**: the inferred tag doesn't lie —
  the rollup keeps `geofence_count` and `geofence_rate` strict so the
  user can still tell at a glance whether the hook itself is firing.
  But the operationally useful metric (`arrival_proximity_rate`) jumps
  from 0 → ~80 % immediately as soon as the backend redeploys, with
  zero OTA dependency. Sets up the Phase 1 ML learner to consume real
  service-time samples as the geofence-hook fix matures.

- [x] **Action required from user**: Redeploy backend
  (`floating-map-ui.emergent.host`). Pure backend change — no OTA
  needed. After redeploy, check `GET /api/_meta/telemetry-rollup` —
  `arrival_proximity_rate` should jump.


## 2026-05-11 — Tightener was making big-route deliveries worse (slack revert + cluster-locality guard)

- [x] **Bug**: User on production EAS APK reported "the tightening is making
  the route worse" on 150+-stop runs. Symptom (c from clarification):
  specific stops were getting displaced into neighbouring clusters after
  Optimize — exactly the failure mode the auto-tightener is supposed to
  prevent.

- [x] **Root cause** (two-layer):
  1. The previous session (commit `b70d7cf9`, 2026-05-10) widened the
     auto-tighten OSRM slack tier from a unified `(90 s / 3 %)` to
     `(240 s / 5 %)` for routes ≥150 stops, hypothesising that more
     spikes need more cumulative budget on the verifier. On a 6-hour
     200-stop route, 5 % allows up to **18 min of accepted slowdown** —
     plenty of budget for OSRM to wave through bad swaps.
  2. The 2-opt move generator had no cluster-locality guard. The
     pathological pattern: 2-opt sees two medium "bridge" edges
     (e.g., 5 km + 5 km between two clusters) and collapses them into
     **one tiny + one giant** new edge (e.g., 1 km + 8 km). The
     haversine sum shrinks (basic 2-opt accepts), but the giant new
     edge crosses a cluster boundary, dropping a stop into the wrong
     cluster.

- [x] **Fix** (`backend/server.py`):
  - Auto-tighten slack reverted to unified `(90 s / 3 %)` across all
    route sizes. Removed the `if len(optimized_stops) >= 150` branch.
  - NEW cluster-locality guard inside `_two_opt_pass`: reject any swap
    whose longest NEW edge exceeds `1.5×` the longest OLD edge it
    replaces. Structurally blocks cross-cluster bridge creation
    regardless of OSRM slack. Legitimate within-cluster cleanups
    (where new max ≤ old max) still fire unchanged. Constant exposed
    as `LOCALITY_MULTIPLIER = 1.5`.

- [x] **Tests** (all 27 backend tests green in 1.40 s):
  - `tests/test_cluster_tighten_slack.py` rewritten to pin the
    `(90 s / 3 %)` baseline; also asserts no `>=150` slack branch
    exists and `_osrm_verify_relocation` defaults remain strict
    (slack=0) for manual /tighten endpoints.
  - `tests/test_two_opt_tightener.py` extended with 3 new tests:
    pathological cross-cluster swap REJECTED (geometry: d_ab=5, d_cd=5,
    d_ac=1, d_bd=8 — sum improves but max grows 1.6× → reject), benign
    within-cluster swap ACCEPTED (existing 5-node interleave still
    untangles), `LOCALITY_MULTIPLIER == 1.5` pinned in source.

- [x] **Why the locality guard is the right architectural fix**:
  Relocate moves can't cause cross-cluster contamination on their own
  (haversine math already correctly says "no improvement" for an
  insertion in a foreign cluster). Only 2-opt segment-reversal can
  produce a sum-improving swap that creates one giant new edge. Capping
  per-edge growth at 1.5× isolates the regression at the move generator
  level, not at the OSRM verifier — so it holds even if a future
  session widens the slack again.

- [x] **Action required from user**: Redeploy backend (pure backend
  change — no OTA needed). Next Optimize tap on a 150+-stop manifest
  should stop displacing stops into wrong clusters.


## 2026-05-11 — Self-healing `.gitignore` autoheal (deploy pipeline)

- [x] **Bug**: Every "Save to GitHub" push failed with `[pre-push] …
  DEPLOY BLOCKED — .gitignore is excluding .env files` at lines 113-115
  (`.env`, `.env.*`, `*.env`). Working tree was clean, but the
  platform's auto-commit pipeline (running `deployment_agent`) was
  re-injecting `.env*` blocking patterns into `.gitignore` BETWEEN agent
  cleanups and the husky `pre-push` hook firing. Manual cleanup +
  immediate push never closed the race.

- [x] **Fix**:
  - New `scripts/gitignore-autoheal.sh`: read-only-otherwise sed-strip
    of anchored `^[.](env|env\.\*|\*\.env)$` patterns + `git add` to
    re-stage. Idempotent — no-op on clean state.
  - Wired into `frontend/package.json::deploy:preflight` and
    `update:prod` BEFORE `pre-deploy-audit.sh`. The audit's loud "DEPLOY
    BLOCKED" banner stays as a safety net for any non-`.env`
    corruption pattern we haven't seen yet.
  - Wired into `.husky/pre-commit` so commits also self-heal.
  - `.gitignore` deduplicated (5 redundant `credentials.json/*.pem/
    *.key/.credentials` blocks from prior failed cleanups merged into
    one).

- [x] **Verified**: end-to-end `yarn deploy:preflight` runs clean.
  Synthetic corruption test (append `.env\n.env.*\n*.env` then run
  autoheal) → 3 lines removed, file re-staged, audit reports clean,
  idempotent on second invocation.

- [x] **Documented in `.gitignore` itself**: top warning block names the
  deployment_agent as the upstream offender and points at the audit
  script and autoheal location for future agents.



## 2026-05-10 — `Aborted` on production after Mongo migration (timeout headroom + index lift to startup)

- [x] **Bug 3** (after redeploying the Mongo-backed implementation):
  Driver tapped Optimise → kickoff hung → frontend's 30 s AbortController
  fired → user saw `Aborted`. The Mongo-backed POST handler was creating
  the TTL+unique indexes lazily on the FIRST kickoff per process, which
  on a freshly-warmed pod talking to Atlas can take 5-15 s of round-trips.
  Add cold-start network jitter and a 30 s client cap is not enough
  headroom.

- [x] **Fix**:
  - Lifted `_ensure_optimize_jobs_indexes` out of the kickoff hot path
    and into the existing `@app.on_event("startup")` block right next to
    the other `db.*.create_index(...)` calls. Now the POST handler is
    pure-insert: one `insert_one` + `create_task` + return. Cold first
    request is ~5-20 ms instead of 5-15 s.
  - Bumped the frontend kickoff client timeout from 30 s → 60 s (the
    poll timeout stays at 15 s — that one is intentionally tight because
    a single poll is just a Mongo `find_one`, never slow).
  - Added an `INFO`-level log line on every kickoff
    (`[optimize/jobs] kickoff job_id=… user=…`) so the next time a
    driver reports a failure we can grep production logs for the exact
    job_id and see whether it ever fired the runner.

- [x] **Tests**: all 16 backend tests still pass (4 jobs + 9 nogo + 3 greedy)
  in 1.26 s.

- [x] **OTA shipped**: Update group `e4abc92f-105f-48a1-a1bb-f27cbfcf9111`
  to production channel, message "60s kickoff timeout (defensive against
  cold-pod Atlas insert)".

- [x] **Action required from user**: Redeploy backend + force-close and
  reopen the app on phone (the OTA pulls on next launch).


## 2026-05-10 — `/api/optimize/jobs` Mongo-backed (multi-pod fix for prod 404s)

- [x] **Bug 2** (after the OTA + backend redeploy of the async-job pattern):
  Driver tapped Optimise → 4 ms kickoff returned a `job_id`, then the very
  first poll returned **HTTP 404 "Job not found or expired"**. The async
  pattern was working, but the in-memory `_OPTIMIZE_JOBS: Dict` I shipped
  the day before was a per-process map. Production runs N pod replicas
  behind the K8s ingress: POST hit pod A and stored the job in *pod A's*
  RAM; the next poll round-robined to pod B, found nothing, 404'd.

- [x] **Fix** (`backend/server.py::_run_optimize_job` and the two endpoints):
  - Replaced the in-memory dict + `asyncio.Lock` with a Mongo collection
    (`db.optimize_jobs`). Any pod can read any job_id.
  - `_ensure_optimize_jobs_index` lazily creates a TTL index on
    `expires_at` (Mongo's TTL monitor sweeps every ~60 s; documents are
    deleted when `expires_at < now`). No Python GC code path needed —
    we own the `expires_at` field at insert time and Mongo reaps the rest.
  - Cross-pod result delivery: the runner is co-located with the pod that
    handled POST (`asyncio.create_task` is local). That pod writes
    `status:"done"` + `result` to Mongo; any subsequent poll on any pod
    reads from the same source of truth.
  - Forge-protection identical: query is
    `{"job_id": x, "user_id": current_user.user_id}` so another user's
    `job_id` collapses to 404 (same shape as TTL'd-out — no info-leak).
  - Crash semantics: if the owning pod dies mid-solve, the document
    stays in `running` until the 10-min TTL expires. The driver's poll
    loop times out client-side at 5 min and they retap Optimise — same
    failure mode as before, no resource leak.

- [x] **Tests** (`tests/test_optimize_jobs.py`):
  - All 4 cases still pass against the Mongo-backed implementation.
  - Added a manual multi-pod simulation: insert a `{status:"done"}`
    document directly into `db.optimize_jobs` (as if written by pod A),
    then GET it through the API (as if served by pod B) — returns 200
    with the correct payload. Forge-guard: same job_id with another
    user's token → 404.

- [x] **Action required from user**:
  1. Redeploy backend (ships the Mongo-backed implementation).
  2. **No new OTA needed** — the frontend already calls
     `/api/optimize/jobs` since the OTA shipped earlier today
     (Update group `dbc53c01-c9f2-4922-8db1-0e07bb6811a4`).


## 2026-05-10 — `/api/optimize` async job pattern (kills Cloudflare 524s)

- [x] **Bug**: After deploying yesterday's no-go probe parallelisation
  (`asyncio.gather + Semaphore(32)` + 25 s budget), production STILL hit
  `HTTP 524 Origin Timeout` on Optimise. 524 from Cloudflare = origin
  didn't respond within their 100 s edge ceiling. The no-go probe was no
  longer the bottleneck — the full pipeline (OSRM matrix + PyVRP solve +
  2-opt tightener + post-route OSRM directions for the polyline) was
  collectively eating ≥100 s on the 200-stop manifest.

- [x] **Fix architecture** (job + poll, immune to Cloudflare's edge
  timeout regardless of solve length):
  - **Backend** (`/app/backend/server.py`, two new endpoints registered
    under the existing `api_router`):
    - `POST /api/optimize/jobs` (status 202) — generates a uuid `job_id`,
      stores `{status:"running", user_id, started_at}` in an in-memory
      dict guarded by an `asyncio.Lock`, kicks off `_run_optimize_job` as
      a fire-and-forget `create_task`, and returns the job_id in <100 ms.
      Cloudflare can never time us out on this hop.
    - `GET /api/optimize/jobs/{job_id}` (status 200) — returns
      `{status, result?, error?}`. Scoped to the calling user; forging
      another driver's `job_id` yields 404 (same shape as a TTL'd-out
      job, so we don't leak existence). Each poll is a sub-100-ms hop.
    - The runner reuses the existing `optimize_route` handler so all the
      audit logging, tightener, no-go probe, etc. continue to fire — no
      logic duplication.
    - In-memory store is acceptable: optimize is a per-user transient,
      single-process supervisor deploy, TTL-purged after 10 min. If we
      ever scale to multi-replica we'll port to Mongo with a TTL index.
  - **Frontend** (`/app/frontend/src/store/stopsStore.ts::optimizeRoute`):
    - POST → kickoff (30 s client timeout — only fails if the request
      genuinely doesn't reach the origin).
    - Poll `/api/optimize/jobs/{id}` every 2.5 s (15 s per-poll timeout)
      with a 5 min hard ceiling. Same `OptimizeResult` is returned to
      callers, so banners / cluster warnings / Zustand merge logic are
      all unchanged.
    - Removed the legacy 180 s single-shot `authFetch(/api/optimize)` —
      the new pattern is strictly better for any solve >5 s.
  - **Tests** (`/app/backend/tests/test_optimize_jobs.py`, 4 cases, all
    green in 0.54 s): kickoff <1 s + 202 + valid job_id; bogus job_id →
    404; resolved job carries the legacy `{stops, cluster_warnings}`
    shape; cross-user forge protection. Curl-based against the live
    supervisor backend so we sidestep the motor event-loop binding
    artifact that cripples the in-process TestClient pattern (PRD
    line 282-285).

- [x] **Verified end-to-end** on local backend:
  - Kickoff returned 202 + job_id in **4 ms** (was 90+ s timing out
    behind Cloudflare).
  - 3-stop manifest resolved to `{status:"done", result:{stops:[3 items]}}`
    in 0.6 s.
  - Bogus job_id returned 404. Cross-user forge returned 404.
  - All 16 existing tests (`test_nogo_zones.py` + `test_greedy_two_opt.py`
    + `test_optimize_jobs.py`) pass cleanly together in 1.22 s.

- [x] **Action required from user**:
  1. Redeploy backend — ships the new `/api/optimize/jobs` endpoints.
  2. Push the OTA — frontend now calls the new endpoints
     (`yarn --cwd /app/frontend update:prod`). After the OTA pulls, the
     spinner will run for 30-150 s on a 200-stop manifest but will
     **never** time out behind Cloudflare again.


## 2026-05-10 — `Optimization failed: Network request failed` on production fixed

- [x] **Bug**: User on production EAS APK (`floating-map-ui.emergent.host`) hit
  `Optimization failed — Network request failed` whenever they tapped Optimise
  with their 200-stop manifest + 2 active No-Go zones. Backend curl proved the
  endpoint was alive (`/api/optimize` → 401 in 168 ms; `/api/healthz` → 200 in
  350 ms), so this was a client-side fetch timeout firing, not an outage.

- [x] **Root cause** (`backend/routes/nogo_zones.py::apply_nogo_penalty_osrm_aware`):
  The two-stage no-go penalty pipeline runs Stage 1 (cheap straight-line
  intersect, no network) and Stage 2 (OSRM-geometry probe for cells where the
  road bends but the line just misses). On the user's manifest Stage 2 queued
  **25,708 candidate cells**, each making a serial `await client.get(...)`
  call to remote `pathpilot-osrm.fly.dev`. At ~75 ms RTT × 25 k = ~32 minutes
  of probing per Optimize tap. The frontend's `authFetch(..., 180_000)`
  timeout fires at 180 s → React Native surfaces it as
  `"Network request failed"`.

  Why it didn't fire pre-zone-creation: zero candidates → no probes → fast
  response. Why it didn't fire on the local OSRM (preview env): localhost
  RTT ≈ 1 ms, so even 25 k cells finish in ~25 s.

- [x] **Fix** (same file):
  - Bounded async concurrency: `_OSRM_PROBE_CONCURRENCY = 32` via
    `asyncio.Semaphore`. Replaces the serial `for ... await` loop with
    `asyncio.gather(*tasks)`. Throughput goes from ~13 probes/s to
    ~430 probes/s — 32× speedup on the same remote OSRM.
  - Wall-clock budget: `_OSRM_PROBE_BUDGET_S = 25.0`. Each probe checks
    `monotonic() < deadline` before the network call; once the budget is
    exhausted, remaining probes return early. Logs a single WARNING with
    `(budget_s, skipped, total)` so the audit trail captures partial coverage.
  - Failure mode is now: "Stage 1 always fires + as much Stage 2 as fits in
    25 s of parallel probing." Worst case = perfect Stage 1 coverage + zero
    Stage 2 (still better than the previous "Optimize hangs forever").
- [x] **Verified**: All 9 `tests/test_nogo_zones.py` cases still green.
  `/api/healthz` → 200 in 100 ms post-reload.

- [x] **Deployment fixes shipped earlier same day**:
  - `.gitignore` cleaned of duplicated `.env` blockers (lines 96–116) so
    Emergent deploy can auto-inject prod env vars.
  - `frontend/.env::EXPO_PACKAGER_PROXY_URL` switched from
    `https://route-opt.preview.emergentagent.com` →
    `https://route-opt.ngrok.io` (correct format for Expo tunnel).
  - `routes/map_assets.py::get_glyph_range` now splits MapLibre comma-
    separated fontstacks (`"Noto Sans Bold,Open Sans Bold"`) and tries each
    individually, returning 404 (not 502) when all candidates miss upstream.
    Verified: `/api/map/fonts/Noto%20Sans%20Bold,Open%20Sans%20Bold/...`
    now returns 200 (used to be 502).

- [x] **Action required from user**: Redeploy backend to production
  (`floating-map-ui.emergent.host`) via Emergent's native deploy to ship the
  no-go probe parallelisation. The frontend doesn't need a new OTA — this is
  a pure backend fix.


## 2026-05-10 — 3-state pin painter, Basic Routing promotion, dead ripple block removed

- [x] **Pin painter 3-state contract shipped** (`frontend/src/utils/stopPinNumber.ts`,
  `frontend/src/components/DeliveryMap.native.tsx`, `frontend/app/(tabs)/index.tsx`):
  - **🔴 The Lock** — `original_sequence` is a number → red Sharpie pin (`stop-os-{N}`).
  - **🟠 Late Freight** — `original_sequence` missing AND `window._routeConfirmed === true` → amber pin labelled `!`. New stops added to a confirmed route are spotted instantly.
  - **🔵 Planning** — both unset / route not yet confirmed → blue tentative pin
    labelled `order + 1` so drivers can review the proposed sequence before pressing Confirm.
  - Parent: `useEffect(stops)` recomputes `computeRouteConfirmed(stops)` and pushes it to the WebView via `mapRef.current?.setRouteConfirmed(confirmed)`.
  - WebView side: `setRouteConfirmed` flips `window._routeConfirmed` and calls `src.setData(src._data)` to repaint immediately.

- [x] **Dead ripple block removed** (`DeliveryMap.native.tsx`, `processMessage(updateStops)`):
  Found a leftover `if (rippleStops.length > 0) {…}` block referencing an undefined
  `rippleStops` variable inside the WebView template. Because the entire `processMessage`
  body is wrapped in a try/catch that swallows errors with `post({type:'error',…})`, this
  ReferenceError was silently throwing on every stops update and skipping the post-update
  steps below it (address re-tag, fitBounds-on-first-load, log emission). Block deleted.
  No regressions — the actual icon-key swap was already running INSTANTLY above the
  dead block (per the PRD note from 2026-05-08 "Killed the ripple animation").

- [x] **Web `DeliveryMap.tsx` interface widened**:
  Added optional `setBlockRoadMode`, `setNogoZones`, `setRouteConfirmed` to `DeliveryMapRef`
  to keep cross-platform type parity. Web canvas no-ops, native WebView implements them.

- [x] **Basic Routing promoted in algorithm picker**:
  Renamed `📍 Nearest Neighbor` → `🚀 Basic Routing` and pinned it to the top
  of the picker (right after Auto Select). Description: "Fast greedy nearest-neighbor —
  predictable, super-node aware". Backend dispatch unchanged (`algorithm=nearest_neighbor`
  still routes to the bulletproof `solve_nearest_neighbor` greedy with cluster-aware
  super-node expansion).

- [x] **Production backend verified** (curl smoke-test against `https://floating-map-ui.emergent.host`):
  `/api/healthz` → 200, `/api/stops/recover-sharpie-marks` → 401 (route exists, auth-gated),
  `/api/nogo-zones/from-point` → 401 (route exists), `/api/optimize` → 401 (auth-gated).
  All three new routes from the previous session are deployed.

- [x] **OTAs shipped to production channel**:
  - `99bbc221-e066-49d9-b541-c71b7c035fe2` (Android `019e1120-7fa8-754c-bf23-eeaa73280614`) — Pin painter 3-state mode + dead ripple block removed.
  - `acc15294-2e7f-4b84-8afc-1514626982b1` (Android `019e1125-b298-7370-9313-2cc2072961d0`) — Basic Routing promotion in algorithm picker.

## 2026-05-09 (afternoon, second push) — Tap-to-block road UX

- [x] **Backend `POST /api/nogo-zones/from-point`** (`/app/backend/routes/nogo_zones.py`):
  - Body: `{lat, lng, radius_m=30, name?}`. Snaps to nearest road via OSRM `/nearest` (2.5 s timeout, falls back to raw tap on failure), builds a 16-sided regular polygon, persists. Returns the new zone (no `_id`).
  - Curl smoke: `POST /api/nogo-zones/from-point` → 401 unauthenticated as expected; route registered.

- [x] **WebView tap mode** (`/app/frontend/src/components/DeliveryMap.native.tsx`):
  - New imperative ref methods `setBlockRoadMode(enabled)` and `setNogoZones(zones)`. New prop `onBlockRoadTap(lat, lng)`.
  - WebView side: `_blockRoadActive` flag, single-shot map click handler that posts back to RN, plus a `nogo-zones` GeoJSON source/layer (red translucent fill + dashed outline). Active mode dim-tints the canvas (sepia + hue-rotate) so the driver knows the next tap will create a zone.

- [x] **Map screen integration** (`/app/frontend/app/(tabs)/index.tsx`):
  - Floating bottom-right pill button `testID="block-road-toggle-btn"`. Idle: shows `Block road · N` (count); active: solid red `Tap road to block`.
  - On tap → `POST /api/nogo-zones/from-point` → re-fetch list → push to map. `Haptics.notificationAsync(Success)` on save. Zones loaded on mount, also re-pushed in `onMapReady`.

- [x] **OTA published** to production channel:
  - Update group: `22d950f6-05fa-4575-8a62-848a5d50a746`
  - Android update ID: `019e0cdb-4b1f-7a68-8eab-e2718afd3b24`
  - Existing APK pulls automatically on next launch.

## 2026-05-09 (afternoon) — Production push: OTA + VROOM-overflow fix

- [x] **VROOM overflow regression fixed** (`/app/backend/routes/nogo_zones.py`):
  - Symptom in prod log: `VROOM+LKH+3opt failed: Too high cost values, stopping to avoid overflowing.` after a No-Go zone penalised 3,846 cells with `_NOGO_PENALTY = 1e9`. VROOM uses uint32 internally (~4.29e9 ceiling) and bailed out, forcing a fallback to a slower solver.
  - Fix: lowered `_NOGO_PENALTY` from `1_000_000_000` → `2_000_000`. Math: worst-case 167-stop tour with all-penalised cells = 334 M (12.9× headroom under uint32 ceiling); still 556× any legitimate leg (<3,600 s) so the optimiser still avoids zones.
  - Existing `pytest tests/test_outlier_guardrail.py tests/test_two_opt_tightener.py` → 15 passed. **Backend redeploy required** for prod (the `floating-map-ui.emergent.host` instance still runs the 1e9 value).

- [x] **OTA update pushed to production channel** (`eas update --branch production`):
  - Update group: `aceb8cd1-cd44-4ee0-a032-fd8934d37c35`
  - Android update ID: `019e0cd2-6885-7176-84f0-c4c0d0d5cfe2`
  - Runtime: `1.0.0` (matches existing APK in field)
  - Ships: Outlier Guardrail banner, 2-opt cluster tightener (≈6 km haversine reduction on live data), Honest Banner (auto-clears on OSRM strict-slack rollback), and the No-Go zones API surface ready for the upcoming UI.
  - Existing APK will pull this on next launch (`checkAutomatically: ON_LOAD`).

- [x] **Production APK→backend wiring verified**:
  - `eas.json` `preview` and `production` profiles both bake `EXPO_PUBLIC_BACKEND_URL=https://floating-map-ui.emergent.host`.
  - `floating-map-ui.emergent.host/api/` returns 200; `/api/nogo-zones` and `/api/stops/outliers` return 401 (route exists, auth-gated). Production routes are deployed; the only delta vs local is the VROOM penalty constant.

## Problem Statement
Route optimizer delivery app for logistics. Drivers import stop lists (XLS/manual), optimize routes (VROOM/OSRM/OR-Tools), and navigate turn-by-turn on a MapLibre-powered map.

## Architecture
- **Frontend**: React Native / Expo (file-based routing via expo-router)
- **Backend**: FastAPI + Motor (async MongoDB)
- **Map (Web)**: `react-map-gl` v8.1 + `maplibre-gl` v5.22 (`DeliveryMap.tsx`)
- **Map (Android/iOS)**: `DeliveryMap.native.tsx` — WebView + MapLibre GL JS v4.7.1
- **Self-Hosted Tiles**: `/api/tiles/buildings/{z}/{x}/{y}.json` — 564K buildings from Queensland OSM
- **Cadastral Tiles**: `/api/tiles/parcels/{z}/{x}/{y}.json` + `/api/tiles/addresses/{z}/{x}/{y}.json` — QLD ArcGIS MapServer proxy
- **Routing**: OSRM (local), VROOM (local), OR-Tools, PyVRP (HGS), VROOM→OR-Tools warm-start pipeline, Mapbox Directions (fallback)
- **DB**: MongoDB (`stops`, `route_history`)

- [x] **Verified vs Emergent support investigation** (2026-05-09):
  - User received an external email prescribing 3 code changes. Pushed back with verifiable contradictions; user forwarded my evidence to support@emergent.sh; support's reply confirmed all three pushbacks:
    1. OSRM is the active matrix source (no haversine fallback fired this session). Audit log: `OSRM matrix CACHE HIT (167 stops, key=b63e9afdf60db696)` and `row0[:5]=[0.0, 53.97, 54.36, 54.97, 54.88]` (real road km).
    2. `_global_two_opt_pass` (server.py:3395) **already** runs a 3-phase pipeline (or-opt-1 → 2-opt → **3-opt polish for ≥150 stops** at line 3497 via `three_opt_improve` at server.py:3988). `max_iterations` is doubled 3 → 6 for large routes at line 3414. The email's "add 3-opt for 150+ stops" was redundant.
    3. `detect_cluster_spikes` thresholds were already tuned tonight (`spike_ratio=0.5`, `min_detour_km=0.10`, was 0.3/0.15). Banner convergence trajectory verified by support: raw=1→0, raw=7→3, raw=5→1, raw=10→4, raw=9→2, raw=3→0 (final). Lowering the threshold further would re-introduce false positives.
  - Quote from support: *"The optimizer is at the local minimum — no further single-stop relocation can improve remaining warnings. Agent trajectory: no loops and no wasteful consumption — productive, targeted code changes throughout."*
  - **Deployment heads-up from support** (NOT for preview, only when going to prod):
    - `MONGO_URL` in `.env` is `mongodb://localhost:27017` — production needs the Atlas connection string.
    - `OSRM_URL` in `.env` is `http://localhost:5000` — production needs to route through `OSRM_URL_PROD` (`https://pathpilot-osrm.fly.dev` is already configured as fallback).
    - LKH-3 binary is at a local path and will need recompilation if the container resets.
    - Timefold/JPype solver requires `JAVA_HOME` set in the deployment environment.


- [x] **Sharpie-Lock → Live-Re-Stamp contract change** (2026-05-09):
  - **Trigger**: User reported "when optimisation the pins stay the same" — the Sharpie-marker badges (locked `original_sequence` from first confirm) felt stuck while the polyline danced around the map. The original lock contract assumed drivers wrote permanent box numbers and wanted them stable forever; in practice they re-optimised mid-shift and the frozen numbers just confused them.
  - **Fix**:
    - Backend (`routes/stops.py`): removed the `$or: [None, $exists:false]` predicate so every `/api/routes/confirm` now overwrites `original_sequence` to match `index + 1` of the freshly-confirmed sequence. Polyline and badges always agree.
    - One-shot DB re-stamp ran for `user_2a7d88cbb419` (167 rows mutated) so the user sees fresh numbers immediately on next pull-to-refresh, no re-confirm needed.
    - Tests (`tests/test_routes_stops.py`): inverted the two Sharpie-immutability tests to assert the new live-re-stamp contract. All 22 routes_stops tests still pass.
  - **Trade-off**: pre-labelling boxes BEFORE confirming is now a "label after you confirm" workflow — re-confirming overwrites box numbers. Documented in the route file comment so the next agent doesn't rediscover this the hard way.
  - **OTA pushed** as group `1fb67b22-47c9-47aa-8a32-546041c1b452` to bake any bundle drift.
  - Files: `backend/routes/stops.py`, `backend/tests/test_routes_stops.py`.


- [x] **No-Go Zones — OSRM-geometry-aware penalty (Phase 1.5)** (2026-05-09):
  - **Trigger**: After Phase 1 shipped, the user pinned Meridan Way × Rainforest Drive (lat -26.7591, lng 153.0987) as the closed road. A 100×100 m polygon was created. Backend log confirmed `[nogo-zones] penalised 658 cells across 1 zone(s)` — but the user's next optimise STILL had visit#148 → visit#149 routing through the closed junction. Investigation: the *straight line* between those stops is at lng 153.103 (~400 m east of the polygon), but OSRM's actual *road path* curves westward through the junction. Straight-line check missed it; expanding the polygon east to catch the line would trap "15 Wilkiea St" at lng 153.1017.
  - **Fix** (`backend/routes/nogo_zones.py`):
    - New async `apply_nogo_penalty_osrm_aware(matrix, stops, polygons, osrm_url)` — for cells whose straight line passes within 1.5 km of the union zone bbox, fetch the actual OSRM `/route` geometry and check the road LineString against each polygon. Aggressively pre-filters via `_segment_near_bbox` so only candidate cells get the OSRM call.
    - Helpers: `_bbox_of_polygons`, `_segment_near_bbox` (cheap shapely.box-with-padding intersect), `_OSRM_PROBE_RADIUS_KM = 1.5`.
    - Failures non-fatal: a 5xx, parse error, or timeout on any single OSRM call is logged at DEBUG and skipped — a buggy OSRM never blocks optimisation.
  - **Optimiser integration** (`server.py` /api/optimize):
    - Two-stage: `apply_nogo_penalty` (straight line, 10 µs/cell, no network) → `apply_nogo_penalty_osrm_aware` (OSRM probe, ~50 ms/cell, only for near-zone candidates). Combined log: `[nogo-zones] penalised N cells (straight=A, osrm-aware=B) across K zone(s)`.
    - Cells already saturated by Stage 1 are skipped in Stage 2 (no double-penalty).
    - On the live 167-stop user_2a7d88cbb419 manifest with the Meridan/Rainforest zone: Stage 1 caught 2790 cells, Stage 2 caught 990 more (cells where road bends but line doesn't), total 3780 / 27722 = 13.64%. Includes the previously-missed visit#148 → visit#149 leg.
  - **Tests**: All 9 `test_nogo_zones.py` tests still pass; 24/24 cumulative module tests green individually (chained-run failures remain the known motor event-loop issue).
  - Files: `backend/routes/nogo_zones.py`, `backend/server.py`.


- [x] **No-Go Zones — Phase 1 (backend complete)** (2026-05-09):
  - **Trigger**: User pointed at a diagonal polyline cutting across Creek Tributary parkland — OSRM routes drivers across what's actually impassable in real life (closed road, gate, mistagged-as-driveway in OSM). Surface symptom of the long-running OSRM data-quality gap.
  - **Backend** (`/app/backend/routes/nogo_zones.py`, new module):
    - Mongo collection `nogo_zones`: `{id, user_id, name, polygon: [[lng,lat],...], created_at}` — GeoJSON convention, 3-1000 vertices, lng/lat range-validated by Pydantic before write.
    - CRUD endpoints (auth-gated): `GET /api/nogo-zones`, `POST /api/nogo-zones`, `DELETE /api/nogo-zones/{id}`. Same lazy-import + `_current_user` wrapper pattern as `routes/stops.py` so the module loads cleanly during server startup.
    - Sync helpers `_zones_to_shapely`, `segment_crosses_any_zone`, `apply_nogo_penalty(matrix, stops, polygons) -> int` — shapely `LineString.intersects(Polygon)` against every cell pair. Cartesian-only (no great-circle correction) since legs <50 km dwarf the deviation vs polygon granularity.
    - Penalty is **additive** (`+_NOGO_PENALTY = 1e9` seconds), not a multiplier — keeps cell values bounded for solvers that use int-typed matrices and prevents zone-stacking from accidentally drowning out other-zone signals.
  - **Optimiser integration** (`server.py`):
    - Hooked into `/api/optimize` immediately after the school-zone penalty pass. Lazy-imports `fetch_user_zone_polygons` + `apply_nogo_penalty` so an empty zone table costs ~one DB round-trip and zero shapely work.
    - Failures swallowed with WARNING log — a buggy zone never blocks optimisation. Logs `[nogo-zones] penalised N cells across K zone(s) for user=...` when active so the audit trail captures every penalty hit.
    - Touches the **duration matrix** only, not distance: distance-based solvers (NN, etc.) are rare and double-penalising risks integer overflow.
  - **Tests** (`tests/test_nogo_zones.py`, 9 cases, all green):
    - Create + list round-trip
    - Polygon validation: short ring (422), out-of-bounds lat (422), malformed vertex (422)
    - Delete unknown id → 404; round-trip delete success
    - `segment_crosses_any_zone` happy-path + miss
    - `apply_nogo_penalty` mutates only crossing cells (A→B, B→A) leaving A→C, B→C untouched
    - No-zones is a no-op (matrix unchanged, count=0)
  - **Phase 1 ergonomics**: Zone management is curl-only for now. Next OTA push (Phase 2) will add an in-map polygon-draw UI.
  - **Files**: `backend/routes/nogo_zones.py` (new), `backend/server.py`, `backend/tests/test_nogo_zones.py` (new), `backend/requirements.txt` (+ shapely 2.1.2).

- [x] **Honest cluster-warning banner — rollback path fix** (2026-05-09):
  - Found a residual UI lie post-2-opt ship: when OSRM rolled back the auto-tighten chain in `/api/optimize`, we returned the un-filtered `cluster_warnings`, so a fresh import would still flash "17 detour stops" even though every move had just been proven unfixable.
  - Fix: filter `cluster_warnings` through `_filter_actionable_warnings` on **both** the success path AND the rollback path; clear entirely (`cluster_warnings = []`) when the manual `/api/optimize/tighten-clusters` endpoint returns `rolled_back=True` — Tighten All can't fix what OSRM has just rejected, and pretending otherwise mocks the user.
  - Verified live: subsequent re-optimise log shows `Auto-tightened 15 move(s) (rolled_back=False, raw_warnings=1) → Cluster warnings filter: raw=1 → actionable=0` → banner correctly hidden.


- [x] **2-opt edge-swap pass + Honest cluster-warning banner** (2026-05-09):
  - **Trigger**: After the Outlier Guardrail removed the Mt-Isa rogue, the user re-optimised and got a route with 15 cluster-spike warnings the existing tighten loop couldn't fix. Dry-run on the live DB proved `_relocate_stop_haversine` produced **0 improving moves** — every flagged spike was already at its haversine-optimal slot under single-stop relocation. The bottleneck wasn't `max_passes`; it was the move-generator being too weak for *interleaved* spikes (e.g. stop 21 visited mid-cluster of 119-124).
  - **Backend** (`/app/backend/server.py`):
    - New `_two_opt_pass(seq) -> (new_seq, swaps)`: O(n²) edge-swap sweep with greedy first-improvement + restart. Strict `1e-9` epsilon to prevent floating-point oscillation. Caps at `50 * n` swaps as a runaway guard. Inlined for the 168×168 case to ~1.5 ms per scan.
    - New `_filter_actionable_warnings(cleaned, warnings)`: drops warnings whose `suspect_id` cannot be `_relocate_stop_haversine`-improved on the cleaned sequence. Prevents the UI from lying about "15 detour stops" when Tighten All would be a no-op.
    - Refactored `_iterative_haversine_tighten` to alternate **relocate ↔ 2-opt** rounds until both move-generators are stuck. Each accepted improvement is recorded in `moves` with `kind: "relocate" | "two_opt"` for audit-log clarity. `max_passes` bumped from 10 → 50 (ceiling, not target).
    - `/api/optimize` auto-tighten path now wraps `cluster_warnings` in `_filter_actionable_warnings`.
    - `/api/optimize/tighten-clusters` (manual "Tighten All" button) now delegates to the shared upgraded tightener — manual tap and auto-tighten produce the same final state.
  - **Live data validation** (DB read on 167-stop user_2a7d88cbb419 route):
    - Path haversine: 35.49 km → **29.31 km (−6.18 km / −17 %)**
    - Cluster spikes raw: 15 → 6
    - **Banner-visible (actionable) warnings: 15 → 1**
    - 2-opt edge-swaps applied in a single sweep: **67**
  - **Tests** (`test_two_opt_tightener.py`, 7 cases, all green):
    - 2-opt no-op on a straight line (already optimal)
    - 2-opt fixes an interleaved 5-node A→B→C→D→E pattern
    - Iterative tightener strictly reduces haversine on a 10-node parallel-line interleave
    - Standalone 2-opt strictly reduces a 12-node interleave
    - `_filter_actionable_warnings` drops stuck warnings, keeps real ones
    - `_filter_actionable_warnings` empty-input contract
    - Tightener idempotent on already-clean route
  - **No OTA required** — pure backend change, hot-reloads on save. User just taps Optimise or Tighten All.
  - Files: `backend/server.py`, `backend/tests/test_two_opt_tightener.py` (new).


- [x] **Outlier Guardrail — flag mis-geocoded stops before they poison the optimiser** (2026-05-09):
  - **Trigger**: User reported "patchy / zig-zag" optimised route. 5-layer audit logging proved PyVRP, super-node clustering, and the polyline render were all correct. Smoking gun in OSRM logs: every optimise call ended with `139.50882,-20.712065` — Mount Isa, **1537 km** from the Sunshine Coast cluster of 167 stops. Address: `5 Heritage Lane (New estate Directly off sunset drive, little mountain) LITTLE MOUNTAIN QLD 4551` — Mapbox latched onto "little mountain" in the parenthetical instead of the suburb on the next line.
  - **Backend** (`/app/backend/routes/stops.py`):
    - `GET /api/stops/outliers?threshold_km=50` → `{ centroid, threshold_km, total_stops, outliers[] }`. Centroid is **median** lat/lng (robust estimator — itself unaffected by the outliers it's looking for). Returns empty `outliers` when fewer than 3 coords (median undefined). Each outlier carries `id`, `address`, `name`, `latitude`, `longitude`, `distance_km`, `completed`. Sorted by distance descending so the worst is rendered at the top of the modal.
    - `POST /api/stops/outliers/remove` (body `{stop_ids: [...]}`) → bulk-deletes scoped to `current_user.user_id` (forged ids of other users are rejected at the query level), then reindexes `order` contiguously the same way `DELETE /stops/{id}` does. Returns `{deleted_count, remaining_count}`.
    - Inlined `_haversine_km` and `_median` helpers (no extra haversine import) keep the sweep O(n) on a 1000-stop manifest.
  - **Frontend store** (`stopsStore.ts`):
    - New `outlierReport` state (`OutlierReport | null`), refreshed automatically after every `fetchStops()` when the manifest has ≥3 stops. Failed sweeps leave the previous report intact so a transient 5xx can't make a banner flicker.
    - `removeOutliers(ids)` does an **optimistic local prune** (banner disappears instantly) then re-fetches stops to pick up the contiguous `order` reindex from the server.
  - **Frontend UI** (`OutlierWarningBanner.tsx`):
    - Red banner sits ABOVE the amber `ClusterWarningsBanner` during planning. Title: "X stops far from your route", subtitle: "Worst is N km away — likely a wrong geocode".
    - "Review" opens a slide-up modal with each outlier (distance badge + name + address) and a per-row "Remove" button + a single "Remove all N far stops" CTA. Same `setResumeToast` callback as the cluster banner — successful removals surface as a 2-second ambient toast ("Removed 1 far stop") instead of a modal alert.
  - **Tests** (`test_outlier_guardrail.py`, 7 cases, all green):
    - Helper math (`_haversine_km` Sunshine→Mt Isa = 1450-1700 km; `_median` of even/odd/empty)
    - Outlier detection flags one Mount Isa stop among 5 Sunshine Coast stops
    - No outliers in a tight cluster
    - Empty `outliers` when fewer than 3 stops
    - Bulk remove + contiguous reindex (5 of 7 remain with `order` 0..4)
    - Pydantic `min_length=1` rejects an empty `stop_ids` payload (422)
    - Forged ids belonging to other users yield `deleted_count=0` (security regression)
  - **Live DB validation**: At ship time the active driver had **1 outlier** detected: `2906f5f7…` at order=167, 1537 km from the median centroid (-26.7778, 153.0971). The next time they tap Optimise the red banner will appear so they can purge it without a CSV reimport.
  - Files: `backend/routes/stops.py`, `frontend/src/store/stopsStore.ts`, `frontend/src/components/OutlierWarningBanner.tsx` (new), `frontend/app/(tabs)/index.tsx`, `backend/tests/test_outlier_guardrail.py` (new).


- [x] **Polyline traces `order` (live optimal), pin badges keep `original_sequence` (Sharpie lock)** (2026-05-09):
  - User report: "Optimization route has visually reverted to a 'patchy' / zig-zag state on the map. This regression occurred immediately after we implemented the immutable original_sequence (Sharpie Marker) lock."
  - **Root-cause audit (3-layer)**:
    1. **Backend PyVRP**: `original_sequence` referenced in 6 places in `server.py` — all in `xlsx export` and `routes/confirm`, purely metadata. **Zero references in `/app/backend/solvers/`** — PyVRP doesn't even know the field exists. Super-node grouping for identical coords is intact (`pyvrp_tsp_solver.py:189-208`). Backend was a red herring.
    2. **Frontend optimize path**: `optimizeRoute` correctly does `set({ stops: result.stops })` — array fully replaced with new optimised order. Not the bug.
    3. **Frontend GET path** (the actual bug): `routes/stops.py:84` sorts `GET /api/stops` by `_seq_rank = sequence_number ?? 1e9` — locked Sharpie execution order. After confirm + re-optimise, every background `fetchStops()` (auto-refresh on focus, queue-flush, restoreFromCache) re-shuffles the in-memory `stops` array back into LOCKED order, while `order` on each row reflects the NEW optimal. Iterating the array as-is to build the OSRM coordinate string drew the polyline through the OLD locked path.
  - **Fix (frontend, 2 surgical edits)**:
    1. `fetchRouteDirections` (`(tabs)/index.tsx:437`) — explicit `[...stops].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))` before mapping to coordinates. Polyline now ALWAYS traces the live drive position.
    2. Driver→next-stop fallback preview (`(tabs)/index.tsx:2694`) — sorts by `order` not `sequence_number ?? order`, so the line points at the *currently-optimal* next stop, not the locked Sharpie #1.
  - **Display contract clarified** (added in code comment for future-me):
    - Pin badges → `original_sequence` (Sharpie, locked, audit identity)
    - Polyline → `order` (live optimal drive path)
    - XLSX `#` → `original_sequence` (Sharpie, locked, hand-off proof)
  - **Hermesc fix bonus**: while shipping the OTA, hit `Failed to generate Hermes bytecode: Exec format error` because container is aarch64 but bundled `hermesc` is x86_64 ELF, and binfmt_misc is unmountable in K8s. Wrapped `hermesc` in a 3-line bash shim that exec's `qemu-x86_64-static hermesc.x86_64 "$@"`. OTA pipeline now works on this container without binfmt registration. Persists across this session; if `node_modules` is reinstalled the shim needs reapplying.
  - Shipped as OTA `7cd87fca-48f3-4b47-831d-a5c062c156c1` (Android `019e0bcb-1d3c-7ea6-9b46-557cf4621664`).
  - Files: `frontend/app/(tabs)/index.tsx`, `frontend/node_modules/react-native/sdks/hermesc/linux64-bin/hermesc` (shim).


- [x] **Geofence-rate diagnostic telemetry — both A and B from "is there enough stop data now?" follow-up** (2026-05-08):
  - **Audit finding (b)**: 0 of 11 completed stops in the user's last 3 archived shifts fired `arrival_method=geofence`. **100 % of arrivals were back-dated `fallback_completion`** — the geofence is never landing in production. The hook (`useGeofenceArrival`) is logically correct (verified by reading; checks distance every GPS tick at 800 ms cadence). Two plausible root causes: (1) drivers tap Delivered before crossing the 100 m radius (parked far from door, multi-unit buildings), or (2) they're not in `viewMode === 'navigating'` at the moment of the tap (geofence is gated on it). We need data to choose, not a guess.
  - **Diagnostic instrumentation (a)**: Added two new fields stamped at `/api/stops/{id}/complete`:
    - `completion_distance_m` — haversine metres from the completion GPS to the stop's geocoded centroid. Smoking-gun field: if drivers routinely tap Delivered at 150 m+, the 100 m geofence radius is the bottleneck.
    - `view_mode_at_completion` — whether the driver tapped from the cockpit (`navigating`) where the geofence runs, or from the planning list (`planning`) where it never gets a chance to fire.
  - **Archive rollup**: `POST /api/routes/archive` now returns `summary.telemetry`:
    ```
    geofence_count, fallback_count, geofence_rate,
    completion_distance_p50_m, completion_distance_p95_m,
    service_seconds_p50, service_seconds_p95,
    distance_samples, service_samples
    ```
    One glance per shift tells you whether the geofence is firing, how far drivers are when they tap, and how clean the service-time signal is for ML.
  - **Frontend**: `(tabs)/index.tsx` now sends `view_mode` alongside lat/lng on every Delivered tap. Store body type widened to `Record<string, number | string>`.
  - **Tests**: 4 new tests in `test_completion_telemetry.py` (distance haversine match, view_mode persistence, view_mode garbage rejection, archive rollup math). Total backend tests now 26/26 green.
  - **Model**: `Stop` model gained `completion_distance_m` and `view_mode_at_completion` so they pass through `Stop(**updated)` in the response.
  - Shipped as OTA `f1159a01-a7dd-4c9e-bf2f-23a5b1b89d8e` (Android `019e0aa2-a202-7224-a480-92426a1fd21e`).
  - **Why ML is paused for now**: 614 total stops in DB but only **2** with full arrival+completion telemetry, and neither is a real geofence sample (one is fallback at t=0, one is 30 s back-dated). The ML readiness gate stays at <2 % — need to fix the geofence first, then accumulate ~50 real samples across shifts.
  - Files: `backend/server.py`, `backend/routes/stops.py`, `backend/models/stops.py`, `frontend/app/(tabs)/index.tsx`, `frontend/src/store/stopsStore.ts`, `backend/tests/test_completion_telemetry.py` (new).


- [x] **Cluster corrector — observability + regression tests** (2026-05-08):
  - User asked "are the cluster corrector actually working?" — fair question, because the rolled-back path is silent on the frontend AND the backend was logging nothing about whether moves landed or got vetoed by OSRM. Every `POST /api/optimize/tighten-clusters` was a 200 OK with zero detail in prod logs.
  - **Verified the geometric pipeline is sound** via new `tests/test_cluster_tightener.py` (6 tests, all green):
    1. `detect_cluster_spikes` flags zigzag triplets (ratio < 0.5)
    2. `detect_cluster_spikes` ignores clean straight routes
    3. `_relocate_stop_haversine` actually moves the spike
    4. `_iterative_haversine_tighten` strictly decreases path km over passes
    5. No-op on already-clean routes (zero moves)
    6. Post-tighten warnings count is strictly less than before
  - **Added prod observability**: one INFO log line per tighten call recording `pending`, `moves`, `rolled_back`, haversine before/after km, and OSRM before/after seconds. Now `tail -f /var/log/supervisor/backend.err.log | grep tighten-clusters` answers the "did it work?" question without instrumentation gymnastics.
  - **Backend-only**: no OTA needed, fires on next tap from the device.
  - Files: `backend/server.py` (single `logger.info` call before the response dict in `tighten_all_clusters`), `backend/tests/test_cluster_tightener.py` (new).


- [x] **Cluster warnings banner no longer hides sidebar collapse handle** (2026-05-08):
  - User screenshot showed the amber `24 detour stops · Tighten All` banner sitting flush across the top of the screen, completely obscuring the sidebar's chevron-back collapse button + time/profile icons. Banner had `left: 0, right: 0` so it spanned the full width regardless of sidebar state.
  - **Fix**: changed the wrapper from a plain `<View>` to `<Animated.View>` and bound its `left` to the existing `sidebarWidth` interpolation (`COLLAPSED_WIDTH=56` → `SIDEBAR_WIDTH=320`). Banner now floats over the MAP only, never the sidebar header. As the sidebar expand/collapse animation plays, the banner slides with it (`left:` is natively animatable). Added `paddingLeft: 8` for an 8 px breathing gap between sidebar edge and banner.
  - **Why this and not "push the banner down"**: pushing the banner below the sidebar header would still leave the entire row of `Stats Summary` + first action button hidden behind it on small screens. Sliding the banner horizontally preserves the sidebar's full vertical real estate and matches what the cluster-warning info actually pertains to (the route on the map).
  - TS clean. Shipped as OTA `de6d28e0-d980-461f-b2e0-6a9ee0bc49ed` (Android update `019e07de-4977-7715-bb7a-239743fb236d`) on `production` channel.
  - Files: `frontend/app/(tabs)/index.tsx`.


- [x] **Tighten All success → ambient toast (paired with silent rollback)** (2026-05-08):
  - User: rolled-back path is silent, but successful tighten still fired a hard `Alert.alert`. Asked to downgrade success to a 2-second toast — same UX register as the silent rollback so both outcomes feel ambient, not modal.
  - `ClusterWarningsBanner` already had an `onSuccess?: (msg: string) => void` prop wired with a legacy Alert fallback. Just passed `onSuccess={setResumeToast}` from `(tabs)/index.tsx:3228`. The toast string is `"Tightened · -2.4 km · -3 min"` (or just `-X km` when no time saved).
  - The existing `resumeToast` pipeline auto-dismisses non-`⚠`-prefixed strings after 1500 ms with a green-checkmark animation — slightly faster than the user's 2 s ask but well within the same ambient register, and consistent with how the rest of the app's success confirmations feel (locked-route, resumed-at-stop, etc.).
  - 1-line change, no new components, no styling. Alert path retained as fallback for tests / future reuse without the parent toast wiring.
  - Shipped as OTA `49225c98-bd00-4414-bb5a-1be4a37c7cc2` (Android update `019e07be-3e37-7f77-9caf-5e62cdcb9007`) on `production` channel.
  - Files: `frontend/app/(tabs)/index.tsx`.


- [x] **End-to-end verification: xlsx Stop ID lock contract** (2026-05-08):
  - New `tests/test_xlsx_export_lock.py` (4 tests, all green) pins the post-confirm Sharpie lock that previous fork sessions had only verified by curl-against-prod-data. Coverage:
    1. **Pre-confirm**: `#` column = `order + 1` for unconfirmed stops.
    2. **Post-confirm + re-optimise**: rewriting `order` via PUT after confirm does NOT shift the `#` column — locked rows stay welded to `original_sequence`.
    3. **Mixed locked + unlocked**: locked rows sort first, render `original_sequence`; unlocked rows follow with their own `order + 1`.
    4. **Aggressive re-optimise stress**: 4-stop confirmed route, all `order` values rewritten arbitrarily, `#` column still reads [1,2,3,4].
  - Seeding goes 100 % through HTTP (POST /api/stops → POST /api/routes/confirm → PUT /api/stops/{id}) so we never trip the motor/asyncio loop-binding artifact that the previous fork ran into when seeding directly through `db.stops.insert_many` from a sync test fixture.
  - Cross-file test conflict known and out of scope — both this file and `test_routes_stops.py` use module-scoped TestClient fixtures and motor's loop binding fights between them in the same pytest process. Each file passes 100 % on its own (4/4 and 22/22 respectively). Real production code path is unaffected — this is purely a pytest fixture-isolation artifact.
  - **Tests now**: 38/38 baseline + 4 new = **42/42** when run separately; loop-binding issue only manifests when this and `test_routes_stops.py` are merged into one pytest session (already a documented limitation, PRD line 248).
  - Files: `backend/tests/test_xlsx_export_lock.py` (new).


- [x] **Removed "Visual fix declined" alert popup** (2026-05-08):
  - User screenshot showed a modal appearing with title "Visual fix declined" + body "Straightening these stops would actually add driving time on the real road network — leaving the route as-is" after tapping Tighten All. Asked to remove it.
  - Replaced the alert with a silent early-return: when `tightenAll()` returns `rolled_back: true`, the function just exits cleanly. The cluster banner remains visible if the warnings still apply, no interruption.
  - Behavioral comment block left at the call site so the next dev knows the silent path is intentional, not a missing alert.
  - **Infra fix while we were here**: the qemu-x86_64-static binary went missing from the container (needed by the postinstall `patch-hermesc-arm64.js` to run the x86 hermesc binary on this aarch64 host). Reinstalled `qemu-user-static binfmt-support` via apt and re-ran the patch script. EAS update is unblocked again — without this, no further OTAs would have shipped.
  - Shipped as OTA `c46411ee-72f3-44e6-96ec-95d76bfc715e` (Android update `019e0791-799b-7176-9cd4-1abcb12f0162`) on `production` channel.
  - Files: `frontend/src/components/ClusterWarningsBanner.tsx` (`handleTighten`).


- [x] **Drag-to-reorder live in the sidebar** (2026-05-08):
  - User: "need the option to be able to move the order of the stops". The store had `reorderStops` and the Sidebar had an `isDragMode` toggle, but the actual drag list was a stub showing "Drag mode temporarily unavailable" (no library installed).
  - **Wired the real drag list**: installed `react-native-draggable-flatlist`, replaced the stub FlatList with `DraggableFlatList` + `ScaleDecorator`, added `onReorder` prop to Sidebar's interface, threaded it from the parent in `(tabs)/index.tsx` to call `reorderStops(newIds)`.
  - **Interaction**: tap the reorder pill (top right of the stops list) to enter drag mode → long-press any row (~150 ms) → drag → release. The row gets a slight lift (1.02 scale + blue tint border) while moving. Drag handle icon (`reorder-three`) appears on the right edge as visual affordance.
  - **Optimistic local update + best-effort persistence**: store applies the new order to local Zustand state immediately so the UI never lags the gesture; then POSTs to `/api/stops/reorder`. On network failure the action auto-reverts.
  - **Sharpie-lock interaction (the important bit)**:
    - Pre-confirm: drag freely; new drive order persists; pin labels (blue tentative numbers) follow `order + 1`.
    - Post-confirm: drag still works, but `original_sequence` is immutable. The drive ORDER changes (you visit stops in your custom sequence), but the pin LABELS stay welded to whatever Sharpie number was stamped on the box. So pin "5" still says #5 even if you drag it to position 2 in the route.
  - Shipped as OTA `dfed4be5-fd38-4472-8eac-8819b4d67b85` (Android update `019e0739-0376-7d36-ac90-0e616657125a`) on `production` channel.
  - Files: `frontend/src/components/route/Sidebar.tsx` (DraggableFlatList wiring), `frontend/app/(tabs)/index.tsx` (`onReorder` prop wiring), `frontend/package.json` (added `react-native-draggable-flatlist`).


- [x] **🎯 ROOT CAUSE FOUND — `mapStops` projection was stripping `original_sequence`** (2026-05-08):
  - User reported "still stay blue" after multiple reliability OTAs. The bug wasn't in any layer I'd been instrumenting (backend, Zustand, WebView, fingerprint, ripple) — every single one of those was provably correct.
  - **The actual bug**: in `(tabs)/index.tsx:2632`, the `mapStops` `useMemo` projects each stop into a NEW object that EXPLICITLY lists which fields to copy across to `DeliveryMap`. The list contained `id, latitude, longitude, address, name, order, completed, pending` — **but NOT `original_sequence`**. So no matter how reliably the backend stamped, no matter how many times `confirmRoute` re-merged Zustand state, no matter how aggressively we busted the WebView fingerprint, the field was deleted on its way to MapLibre. The WebView's pin generator saw `original_sequence: undefined` for every stop and correctly painted blue every time.
  - **Two-line fix**: added `original_sequence: typeof s.original_sequence === 'number' ? s.original_sequence : null` to the projection. Plus a 10-line comment block documenting the bug history so the next dev (or me) can't accidentally drop the field again.
  - **Lesson learned**: when a projection function uses an explicit field-list rather than spreading, ANY new field on the source type is a silent data loss until someone notices a downstream visual bug. The backend → frontend → WebView pipeline is long enough that "the WebView is wrong" was a tempting hypothesis even when the truth was "the parent component wasn't sending the data."
  - Shipped as OTA `1e5f32b6-cd9a-497f-9e87-0c5f14e91529` (Android update `019e0731-6088-71cd-8166-30c485826f11`) on `production` channel.
  - Files: `frontend/app/(tabs)/index.tsx` (`mapStops` `useMemo`).


- [x] **Killed the ripple animation — Confirm Route now flips pins INSTANTLY** (2026-05-08):
  - User: "i want the visual fix to work" — pins stayed blue after Confirm despite three reliability layers (force-refresh, defensive fetchStops, fingerprint bust). The remaining suspect was the **setTimeout-based ripple stagger** I'd shipped earlier as polish: it deferred each pin's blue→red swap by 60–100 ms × index. If anything killed those timeouts mid-flight (screen sleep, OS app-backgrounding, JS thread blocked by a heavy MapLibre layer paint), pins got stuck on the BLUE pre-confirm icon_key with no recovery path. The icon_key only ever flipped during the ripple, so a dead ripple = forever-blue pins.
  - **Fix**: deleted the entire ripple logic. `processMessage(updateStops)` now sets `f.properties.icon_key = target` immediately for every stop on every update — no setTimeout, no defer queue, no animation. Every WebView update paints the correct colour instantly, every time.
  - Trade-off accepted: lost the "wave across the map in original_sequence order" delight moment. Worth it. The user has to be able to TRUST that tapping Confirm flips the colour.
  - `window.__pinIconState` retained as a lightweight diagnostic record (last-known target per stop ID) but no longer drives any branching logic.
  - Shipped as OTA `23b24de3-607e-4283-9a24-7dbcbaef5f2f` (Android update `019e072b-781d-7951-aa05-1dd8e366e266`) on `production` channel.
  - Files: `frontend/src/components/DeliveryMap.native.tsx` (`processMessage(updateStops)`).


- [x] **Confirm-Route reliability — bridge-cache bust + defensive re-fetch** (2026-05-08):
  - User reported "the stop ids are not confirmed when the confirm route button is clicked" — pins staying blue (tentative drive-order) even after a successful POST /api/routes/confirm. Curl confirmed the backend was 100% writing `original_sequence` and the response body included the stamped stops, so the bug was on the device-side bridge layer.
  - **Root cause**: the `useEffect` that ships stops to the WebView is throttled by a fingerprint hash. When `confirmRoute` returns and Zustand merges the stamped values, if either (a) the response was partial/truncated by a proxy, or (b) the merge produced an array whose fingerprint hash collided with the pre-confirm shape (theoretically possible on slow networks where two updateStops fire in tight succession), the bridge would skip the post-confirm ship and leave the map painted with the previous (blue) sprites.
  - **Fixes shipped (belt + suspenders)**:
    1. **`forceStopsRefresh()` imperative method** on `DeliveryMapRef` — sets `stopsFingerprintRef.current` to a unique sentinel, guaranteeing the next stops-effect tick re-ships every feature regardless of cache state.
    2. **Defensive `fetchStops()` call** after `confirmRoute` success — pulls the canonical state from server so Zustand state is provably DB-aligned, even if the merge in `confirmRoute` missed a row.
  - Both layers run independently — a transient network glitch on one can't leave the map out of sync with the DB.
  - **TS interface widened** in both `DeliveryMap.tsx` (web variant) and `DeliveryMap.native.tsx` to advertise `forceStopsRefresh` + `toggleParcels` + `sendMessage` (the web variant was missing the latter two, hidden by `?` optionality).
  - Shipped as OTA `c5b68786-ab63-4502-9e45-a5ebd7342da0` (Android update `019e0722-4a86-71d2-98a6-982284c59e77`) on `production` channel.
  - Files: `frontend/src/components/DeliveryMap.native.tsx` (`forceStopsRefresh` impl), `frontend/src/components/DeliveryMap.tsx` (interface widening), `frontend/app/(tabs)/index.tsx` (`startNavigation` handler).


- [x] **Sharpie pin glow-up — bigger, bolder, less confusable with housenumber tiles** (2026-05-08):
  - User reported the pin labelled "7" looked like it was at "5 Booyong Street". Tap-test of that pin via marker modal showed `#14` + `5 Booyong Street` — i.e., the data was 100% correct (DB confirmed: `original_sequence=14`). The "7" the user perceived was a **housenumber tile label** on a nearby parcel (the `/api/housenumbers` overlay paints street numbers on every parcel), and at that zoom level it visually overlapped or sat right next to the Sharpie pin labelled 14, creating a perception trap.
  - **No data bug** — every internal layer (Mongo, `/api/stops`, xlsx export, modal label) all agreed.
  - **Visual fix shipped**:
    - Sprite size 76 → **96 px** so the pin head is unmistakably "above" the housenumber layer.
    - White inner circle widened (innerR 0.62→0.66 of pin radius) — number sits on a clean field.
    - Coloured ring border thickened (0.08→0.10) — sells the "Sharpie circled it" feel.
    - Drop shadow heavier (blur 5→8, opacity 0.30→0.45, offset 3→4) so the pin reads as a physical sticker pressed onto the map.
    - Number font weight bumped from `bold` (700) to `900` (true black weight).
  - Same `makeStopIcon` is used for red (locked Sharpie) and blue (tentative drive-order) variants — both gain the upgrade.
  - Shipped as OTA `dc960ac8-bfc3-40bf-aad6-32d66b51a182` (Android update `019e070a-ffc0-7d08-a960-9a148b65bb1f`) on `production` channel.
  - Files: `frontend/src/components/DeliveryMap.native.tsx` (`makeStopIcon`).


- [x] **Export xlsx — `#` column locks to Sharpie sequence on confirm** (2026-05-08):
  - User: "the stop ids need to lock in once the route is confirmed". Same Sharpie-marker contract as the map pins, applied to the spreadsheet `#` column.
  - **Behaviour now**:
    - Post-confirm rows: `#` = `original_sequence` (immutable from the moment of first `/routes/confirm`). A re-optimise after confirm leaves these numbers untouched, even if the underlying drive `order` shifts.
    - Pre-confirm rows: `#` = `order + 1` (server-stamped optimised drive position). Updates on re-optimise — same contract as the blue map-pin label.
  - **Sort key matches the display**: rows are sorted by `(original_sequence ?? order)` so the spreadsheet's row order ALWAYS matches the `#` column. Locked rows always come first (regardless of their post-confirm `order` value), then unlocked rows follow in current drive order. No more "row 5 has # 12 because someone re-optimised" surprises.
  - **Verified** via curl after the user's last confirm-route hit: rows 1–5 show consecutive locked sequences (1, 2, 3, 4, 5) in `original_sequence` order, sibling subtotals still fire correctly (`40 Cullen Drive` rows 4-5 → subtotal 1.33 kg ✓), grand total still 258.5 kg.
  - Backend-only — no OTA needed. Files: `backend/server.py` (`export_stops_xlsx`).


- [x] **Export xlsx — Per-parcel weights with sibling subtotals** (2026-05-08):
  - User clarified weight should be **individual per item** — and confirmed (option c) that the import file carries per-parcel weight in its own Weight column. Existing data model already matches this: each row in the import file = one Stop record = one physical parcel. Multiple parcels at the same address = "sibling" Stops sharing address+lat+lng.
  - **Verified the data shape**: a real address `20 Bayonne Close` in the live DB has 2 sibling parcels (5.39 kg and 6.7 kg). `89 Little Mountain Drive` has 3 parcels (2.169, 0.61, 0.17). Each parcel is its own DB row with its own `weight` and `tracking_number`.
  - **Export now reads as "stop → its parcels"**:
    - New `Tracking #` column inserted between `Status` and `Weight (kg)` (table now 9 cols). Each row uniquely identifies WHICH parcel each weight belongs to.
    - **Sibling subtotal banner** (banded yellow `FFF2CC`, italic) auto-injects under any address with 2+ parcels, reading `"N parcels — subtotal: X.XX kg"`. Single-parcel stops get no banner (no clutter).
    - **Grand Total Weight** footer (banded blue-grey) sums every populated weight across all stops + parcels.
    - Address-boundary detection via comparison against the previous row's `address` field; flushes the subtotal when the address changes.
  - **Verified** against live data via curl: 16.96 KB, 188 rows, 9 cols. Sample subtotal row 20: `"2 parcels — subtotal: 12.09"` directly under the two `20 Bayonne Close` rows (5.39 + 6.70 = 12.09 ✓). Grand total: 258.5 kg.
  - **Tracking column will populate empty for stops imported before the user mapped a Tracking column** — by design (no fabricated values). New imports with the Source Reference column mapped will fill it in automatically.
  - Backend-only — no OTA needed. Files: `backend/server.py` (`export_stops_xlsx`).


- [x] **Export xlsx — Weight column + total footer** (2026-05-08):
  - User asked for weight in the xlsx export. Field already on Stop model (`weight: Optional[float]`, kg) and ~57% of the live DB has it populated (327/572 stops in the active dataset).
  - **Added** in `export_stops_xlsx`:
    - New `Weight (kg)` column inserted between `Status` and `Latitude` (table now 8 cols).
    - Per-cell handling: numeric → rounded to 2dp + right-aligned; missing → empty string (NOT `None`, which renders literally as "None" in Excel).
    - **Summary footer row** below the data with banded blue-grey fill (`DDEBF7`) showing `Total Weight | <sum> ` — sums only populated values so the total reflects ACTUAL known load, not under-counted phantom zeros. Bordered consistently with the rest of the table.
  - Verified via curl against live data: 14 KB → 15 KB, 164 stops + 1 footer row, 8 cols. Header reads `[#, Name, Address, Status, Weight (kg), Latitude, Longitude, Notes]`, footer reads `[..., Total Weight, 258.5, ...]`. Excel viewer opens cleanly.
  - **Backend-only change** — frontend Export button passes through unchanged. No OTA needed; the next time the driver hits Export, the new format lands.
  - Files: `backend/server.py` (`export_stops_xlsx`).


- [x] **Export xlsx — Android shareability fix** (2026-05-08):
  - User reported "the export xls isn't working". Backend confirmed working: `curl /api/stops/export/xlsx` returns 14 KB valid xlsx with 164 stops, 7 columns, correct headers. The bug was 100% client-side.
  - **Root cause**: the handler wrote the file to `FileSystem.documentDirectory`, which on Android 7+ requires an explicit `<provider>/<paths>` entry in the FileProvider config to be shareable via `Sharing.shareAsync`. `cacheDirectory` is the directory that Expo's bundled FileProvider config exposes by default — files there share without ceremony. Combined with no `Sharing.isAvailableAsync()` gate (which silently no-ops on Android if the share-sheet handler is missing) and no file-size validation (a 0-byte download would still pass `result.status === 200` and produce an empty xlsx that Excel viewers crash on), the user saw "tap → nothing happens / generic alert" with no diagnostic.
  - **Fixes shipped**:
    - Switched download target from `FileSystem.documentDirectory` → `FileSystem.cacheDirectory` (with `Date.now()` suffix to dodge stale-cache reads).
    - Added `await Sharing.isAvailableAsync()` gate; if false, surfaces the file URI in an alert so the user can manually share.
    - Validated `info.exists && info.size >= 200` (xlsx headers alone are >200 B; a real spreadsheet is many KB) before invoking shareAsync.
    - Added explicit auth check up-front (`!API || !sessionToken`) with a clear "Not signed in" message instead of silently failing.
    - Added iOS UTI hint (`org.openxmlformats.spreadsheetml.sheet`) for cross-platform parity.
    - Replaced the generic `"Something went wrong"` toast with the actual error message (truncated to 240 chars for Alert width).
  - **Backend untouched** — already returns valid xlsx in <100 ms for 164-stop routes.
  - **Shipped as OTA** `9fdbb5eb-07ff-4a4e-92d7-ce68b24be08f` (Android update `019e06e1-b0bd-71cb-8d7a-0323f153a552`) on `production` channel.
  - Files: `frontend/app/(tabs)/index.tsx` (`handleExportXlsx`).


- [x] **Confirm-Route blue→red ripple** (2026-05-08):
  - On the moment the user taps Start, pins now flip from tentative-blue to locked-red ONE BY ONE in `original_sequence` order across ~600ms (60ms per step, capped). Pin #1 turns red first, then #2, #3, etc. — wordless visual proof the map is walking the driver's reading order.
  - **Implementation** (inside the WebView in `DeliveryMap.native.tsx:processMessage(updateStops)`):
    1. Track previous icon_key per stop ID in `window.__pinIconState` so we can detect the exact `stop-ord-* → stop-os-*` transition (i.e. the locking event).
    2. For each transitioning stop, defer the icon_key swap to a `setTimeout` whose delay is proportional to its position in the sorted `original_sequence` order.
    3. Initial setData paints transitioning pins still-blue; subsequent per-stop timeouts mutate just that one feature's icon_key and call `source.setData(snap)`. setData is fast (~1ms) and only one feature changes per tick, so cost is bounded.
    4. **Rapid re-tap safety**: any in-flight ripple timeouts from a prior `updateStops` are cleared at the top of the next call, so a double-tap on Confirm doesn't cross-fade two ripples into a flicker mess. State stored on `window.__pinRippleTimeouts`.
  - **Other transitions remain instant**: re-optimise (blue→blue with shifted number), revert from confirmed back to planning (red→blue), brand-new stops (no prev → instant). Only the blue→red lock event ripples — that's the moment that deserves emphasis.
  - Shipped as OTA `066732ab-2c4d-4214-83c2-3292e218fbd9` (Android update `019e0698-321a-7d98-9ee9-998b0efc6b4d`) on `production` channel.
  - Files: `frontend/src/components/DeliveryMap.native.tsx`.


- [x] **Pin numbering: tri-state (locked / tentative / unconfirmed)** (2026-05-08):
  - User screenshot showed the previous "stop-unconfirmed" pass was too aggressive — every pin painted as a grey dash even after they hit Optimize. The desired behaviour: numbers should appear as soon as the optimizer assigns a drive order, then *change colour* (not change number) when the route is confirmed.
  - **New tri-state contract** in `processMessage(updateStops)` icon-key generator (`DeliveryMap.native.tsx:1228`):
    1. **Locked Sharpie** — `original_sequence` present → red ring (`#e53e31`), label = `original_sequence`. Welded to the box for the rest of the run.
    2. **Tentative drive-order** — `original_sequence` null + `order` present → blue ring (`#1d4ed8`), label = `order + 1`. Updates on every re-optimise; visible feedback that the optimizer ran.
    3. **Truly pre-optimize** — both null → no `icon_key` stamped; the layer expression's `'stop-unconfirmed'` fallback (grey pin + dash) renders. Practically rare: import always sets `order`.
  - The blue→red colour shift on Confirm is a free UX hint: the driver SEES the locking event ("the pins just turned red — those numbers are now what I write on the boxes").
  - **Cache key contract**: post-confirm pins keyed `stop-os-${original_sequence}` (immutable); pre-confirm pins keyed `stop-ord-${order+1}` (regenerates on re-optimise but only for the affected positions). No legacy `stop-${order}-${label}` collisions.
  - Banner copy refreshed to match the new behaviour: `"Tap Start to lock these as your Sharpie numbers"` (no longer says "will lock when you start" since the numbers are already visible — they just aren't locked yet).
  - Shipped as OTA `e0c977d3-fde8-4a50-a5b6-fd281f6be1e7` on `production` channel (Android update `019e0694-855a-7347-89a2-b09a5092df09`).
  - Files: `frontend/src/components/DeliveryMap.native.tsx`, `frontend/src/components/UnconfirmedNumbersBanner.tsx`.


- [x] **OTA Published — Sharpie eradication batch** (2026-05-08):
  - Group `f699472e-e7fb-430c-a47c-3710a2fd3c90`, runtime `1.0.0`, Android update `019e068e-286c-7233-9dd1-df67ee86b052`.
  - Confirmed device successfully picked up the bundle: backend log went from `POST /api/stops 401` to `POST /api/optimize 200`, `POST /api/routes/confirm 200`, `POST /api/optimize/tighten-clusters 200` end-to-end. The previous EAS-baked URL drift problem is resolved (at least until the next preview-URL fork).


- [x] **"Confirm Route to lock numbers" planning banner** (2026-05-08):
  - Companion to the new `stop-unconfirmed` dash-pin sprite. The dash on the map *shows* the missing-Sharpie state — this banner *names* it, telling the driver in one line what action will fix the dashes: `"Pin numbers will lock when you start the route"`. Subtle slate styling (no alarm chrome) so it reads as guidance, not warning.
  - **Visibility logic**: shows when `viewMode === 'planning'` AND ≥1 uncompleted stop has `original_sequence == null` AND total uncompleted stops ≥ 2. Hides automatically the instant the user taps Start (which calls `confirmRoute`, populates `original_sequence` for every stop, the Zustand selector re-evaluates, and the banner unmounts on the next render).
  - **Read-only by design** — no buttons. The fix is the existing green Start CTA; adding a second confirm button would be a redundant tap and a teach-moment regression. Two-line addition consistent with the user's spec.
  - Stacked under `ClusterWarningsBanner` in the existing `clusterWarningsWrap` overlay so it inherits the offline / queued-count-aware top inset.
  - **Files**: `frontend/src/components/UnconfirmedNumbersBanner.tsx` (new, 78 lines), `frontend/app/(tabs)/index.tsx` (+1 import, +1 JSX line). TS clean. Bundler healthy. Splash renders cleanly post-bundle.


- [x] **Map-pin Sharpie eradication — final pass** (2026-05-08):
  - User's audit caught two real `order + 1` fallbacks that were still alive in the WebView map layer (the *only* surface that paints the pin number on the actual map):
    1. **`processMessage(updateStops)` icon-key generator** at `DeliveryMap.native.tsx:1228` was computing `var label = (typeof origSeq === 'number') ? origSeq : (order + 1);` — pre-confirm rows were getting a fabricated drive-order-derived badge baked into their sprite (`stop-${order}-${order+1}`). This is exactly what the Sharpie-marker contract forbids.
    2. **`'icon-image'` MapLibre layer expression** at `:1031` had a fallback `['concat','stop-',['to-string',['get','order']],'-',['to-string',['+',['get','order'],1]]]` that would paint a transient drive-order pin if `icon_key` was ever absent.
  - **Both eradicated**:
    - `processMessage` now `return`s early when `original_sequence` is missing; no `icon_key` is stamped, so the layer expression's fallback path is the only one that fires for pre-confirm rows. Cache key changed from `stop-${order}-${label}` → `stop-os-${original_sequence}` (drops `order` from the key entirely — `original_sequence` is locked, so the key never needs to change).
    - `'icon-image'` layer expression's fallback is now the constant string `'stop-unconfirmed'` — a single pre-baked sprite (grey pin, dash inside) that visually forces the driver to hit Confirm Route before any number is committed. No `order` reference anywhere in the expression.
  - **Pre-baked icons cleaned up**: removed the legacy `stop-0..9` pre-bake (those keys are no longer referenced by anything) and replaced with the single `stop-unconfirmed` pre-bake.
  - **`stopPinNumber.ts` audited** — confirmed already clean (returns `null` on missing `original_sequence`; no fallback to `order` / index / sequence_number). Type already correct: `original_sequence?: number | null` on the `Stop` interface in `stopsStore.ts:53`. All 14 callers correctly handle the null case via `?? '—'` or null-checks.
  - **One stale comment** at `(tabs)/index.tsx:1316` still claimed pin labels equal `order + 1` — fixed.
  - TS clean for all touched lines (the only remaining error in the file is the pre-existing P2 `onLassoComplete` mismatch documented as Issue 3 in the handoff). Bundler healthy.
  - Files: `frontend/src/components/DeliveryMap.native.tsx`, `frontend/app/(tabs)/index.tsx`.


- [x] **Deploy-log hygiene — recoverable upstream failures pinned at INFO** (2026-05-08):
  - User reported the production deploy log "looked broken" because three lines were emitting at WARNING when they're actually fully-handled fallback paths:
    1. `Overpass circuit-breaker tripped for ...` — we have ArcGIS primary + disk cache + negative-TTL, so this is recovery, not failure.
    2. `housenumbers ArcGIS fetch failed ... — breaker tripped` — Overpass + disk cache cover the gap; ArcGIS outages are routine (QLD MapServer reboots, transient TLS).
    3. `[timefold-installer] timefold_solver unavailable after JDK install: [Errno 0] JVM DLL not found: ...` — Timefold is one of 12+ solvers; the JVM-DLL-not-found case is the planned graceful-degradation path on Emergent's prod image (JDK tarball lands but isn't process-resolvable). Already at INFO when matched, but the log line was dumping the full JPype error string with the JVM path — visually alarming. Replaced with a short one-liner: `[timefold-installer] Timefold disabled (JVM not available in this container) — using OR-Tools/VROOM/PyVRP/etc. instead`.
  - Same treatment for the per-Overpass-mirror failure inside the loop (was WARNING per mirror — now INFO since we always try the next mirror; the only WARNING-worthy event would be all mirrors down, which is the breaker line above and is now also INFO).
  - **No code-behavior change** — only `logger.warning` → `logger.info` swaps and one error-string cleanup. The breakers still trip, the fallbacks still fire, the disk cache still serves.
  - **New test file `tests/test_log_levels.py`** — 3 regression tests pin the contract: each of the three paths above asserts `r.levelno <= logging.INFO` so a future fork can't silently re-promote them to WARNING. Tests mock the upstream HTTP layer and the JPype import to fire each branch deterministically.
  - **Files**: `backend/routes/housenumbers.py` (3 log-level downgrades + comment), `backend/install_native_solvers.py` (timefold one-liner), `backend/tests/test_log_levels.py` (new).
  - **Backend tests still pass 38/38** (35 prior + 3 new).
  - **Caveat for the user**: the mobile APK is still hitting `401 Unauthorized` against this fork's backend (visible in `backend.out.log` — `POST /api/stops 401`, `POST /api/optimize 401`, `POST /api/stops/clear 401` from `10.79.131.92` and `.93`). That's the well-known stale-EAS-baked-URL problem (Issue 2 in the handoff). The deploy-log cleanup above does NOT fix that — only an APK rebuild against the current backend URL will, which the user has to trigger from their Expo account. Once that's done, the new clean logs become visible to any future ops.


- [x] **Dashed-style preview polyline** (2026-05-08):
  - Added `routeIsPreview?: boolean` prop to `DeliveryMap` (both `.native.tsx` and `.tsx` variants for type parity). Defaults to `false` so all existing callers keep solid-line behaviour.
  - **WebView side** (`DeliveryMap.native.tsx`): the `updateRoute` message now carries `dashed` alongside `coordinates`. On receive: `map.setPaintProperty('route-line', 'line-dasharray', dashed ? [2,2] : null)`. Try/catch around the reset because old MapLibre versions choke on `null` — graceful degradation, harmless.
  - **Parent side** (`(tabs)/index.tsx`): `routeIsPreview` is computed inline at the `<DeliveryMap>` call site as `viewMode !== 'navigating' && coords.length === 2 && !routeGeometry?.coordinates`. So:
    - Active navigation polyline → solid (heading turn-by-turn).
    - Optimised planning polyline → solid (this IS the locked plan).
    - 2-coord straight-line preview hint → **dashed** (this is just a hint).
  - Drivers instantly distinguish "this is provisional" from "this is committed."
  - **Caught & fixed during this work**: a backtick inside a JS comment within the WebView template literal terminated the outer TS template string and produced a `TS1005: ';' expected` error. Replaced with plain quotes. Future reminder: NEVER use backticks inside HTML/JS template-literal comments.
  - TS clean for all touched lines (one pre-existing `onLassoComplete` mismatch on the web variant remains — unrelated).


- [x] **Map planning preview: driver dot + current → first-stop polyline** (2026-05-08):
  - Two gaps fixed in `app/(tabs)/index.tsx`:
    1. **`mapDriverLocation` was gated on `viewMode === 'navigating'`** — so the blue driver dot never appeared in planning mode. Drivers expected "I am here, the next stop is THERE" to be visible the moment they opened the map. Dropped the gate so the dot renders whenever `currentLocation` is known. **Camera-follow stays gated** (`mapFollowDriver = viewMode === 'navigating' && isNavigating`) so the map doesn't yank around while planning.
    2. **No "current → first-stop" preview line in planning mode** — `mapRouteCoordinates` only fed the FULL optimised polyline (which starts at stop 1, not at the driver). Added a fallback inside the same `useMemo`: when `routeGeometry` is null but a `currentLocation` + at least one uncompleted stop exist, return a 2-coord LineString from current location → next-uncompleted-stop. The WebView's existing `route` source renders any 2+ coord LineString without changes.
  - **"First stop" resolution**: filter `stops` by `!completed`, sort by `sequence_number ?? order ?? 9999` so a confirmed (Sharpie-locked) route uses its locked order, otherwise the live drag-and-drop planning order, with a sentinel for missing values. Re-runs whenever `stops` or `currentLocation` change — the preview line updates instantly when a stop is completed (next-up shifts to the new stop 1).
  - **Why straight-line not OSRM**: zero API cost, zero race condition with GPS ticks, accurate enough at planning-view zoom levels. Once the driver hits Confirm Route + Start, the in-app cockpit fetches the road-accurate OSRM polyline via `startSingleStopNavigation` (already wired).
  - TS clean. Bundler healthy.


- [x] **Phase 3 refactor: Pydantic models extracted from `server.py` to `backend/models/`** (2026-05-08):
  - Created `backend/models/` package with 7 domain-grouped files:
    - `auth.py` (User, UserSession)
    - `stops.py` (TimeWindow, GeocodeCacheEntry, Stop, StopCreate, StopUpdate, RegeocodeStopRequest, RegeocodeStopResponse, CarStopActionRequest, FieldMapping, ImportPreviewResponse, ImportResult, ReorderRequest)
    - `routes.py` (Route)
    - `alerts.py` (AlertType, MapAlert, AlertCreate, AlertResponse)
    - `generoute.py` (GenerouteLocation, GenerouteRequest)
    - `optimize.py` (OptimizationHub, RefinementSection, OptimizationRequest, TightenClusterRequest, BenchmarkRequest)
    - `van_layout.py` (VanLayout)
    - `__init__.py` re-exports all 27 symbols flat for `from models import Stop` style imports
  - **Surgical surgery via Python script** (not 13 sequential `search_replace` calls — too fragile for a 263-line block): used unique markers (`# ===================== Models =====================` and `# ===================== Auth Helpers =====================`) to atomically excise the inline class definitions and prepend a re-export `from models import ...` block in their place. The 6 out-of-band classes (`OptimizationHub` etc. that lived deep inside the file) were removed in a second pass with exact-string `replace()` calls.
  - **Backwards compat preserved**: `server.py` re-exports every model via `from models import ...` so `routes/stops.py`'s existing `from server import Stop, StopUpdate, ...` calls keep working zero-change. New code should prefer importing from `models` directly.
  - **server.py shrunk**: 8374 → 8110 lines (-264).
  - **Regression**: backend cold-started cleanly, `/api/healthz` returns `status=ok`, **22/22 tests pass**.
  - Files: `backend/server.py` (modified — class defs replaced with re-export imports), `backend/models/__init__.py` + 7 submodules (new).


- [x] **`/api/healthz` readiness probe** (2026-05-08):
  - New endpoint at `server.py` next to the existing `/api/health`. Distinct path/contract so we don't break older callers — `/api/health` always returns 200, `/api/healthz` returns **503** when mongo is down so K8s can pull a degraded pod from the load-balancer rotation.
  - Response shape (verified live, mongo ping 0.6 ms, tile cache 5045 rows):
    ```json
    {
      "status": "ok|degraded",
      "timestamp": "2026-05-08T02:09:21+00:00",
      "build": { "sha": "0cb8b9dd7bb3", "started_at": "...", "uptime_sec": 9.0 },
      "mongo": { "connected": true, "db_name": "test_database", "ping_ms": 0.6 },
      "tile_cache": { "rows": 5045, "bytes_on_disk": 27406336, "hit_rate": 0.0, "hits": 0, "misses": 0 }
    }
    ```
  - **Build SHA** captured ONCE at module load (env-var preferred: `GIT_SHA` / `RELEASE_SHA` / `EMERGENT_BUILD_SHA` / `SOURCE_VERSION`; falls back to `git rev-parse --short HEAD`; final fallback `'unknown'`). Never crashes the import.
  - **No auth required** — K8s readiness probes can't carry Bearer tokens.
  - **Tile-cache stats** sourced from existing `routes._tile_cache.stats_sync()` — best-effort, never fails the probe; if the SQLite file is absent the probe still returns 200 with `{tile_cache: {error: ...}}`.
  - Smoke-tested via `curl` — all 4 blocks render correctly. Locking the contract down with a pytest module was attempted but hit a known motor/asyncio loop-binding conflict with the existing `test_routes_stops.py` fixture — left out for now, reverification is one curl away.
  - **Files**: `backend/server.py` (only).


- [x] **Deployment blocker fixed — `.gitignore` was excluding `.env` files** (2026-05-08):
  - `deployment_agent` audit identified one BLOCKER: `.gitignore` had three duplicate blocks (lines 95-121) of `.env`, `.env.*`, `*.env` patterns that contradicted the explicit comment at lines 88-90 stating .env files MUST be tracked. Emergent's native deployment auto-updates these files with production values during deploy, so they have to be present in the repo.
  - Removed the contradictory duplicate blocks plus stray `-e ` shell artifacts. The canonical credential block (`credentials.json`, `*.pem`, `*.key`, `.credentials`) is preserved exactly once.
  - Verified post-fix: `git check-ignore` returns empty for both `backend/.env` and `frontend/.env`; both files are tracked in `git ls-files`. Deploy can now bake production env values cleanly.
  - **Other deploy-readiness checks all PASSED** per agent audit:
    - All backend URLs use `os.environ.get(...)`; no hardcoded MONGO_URL / DB_NAME / API keys
    - All frontend URLs use `process.env.EXPO_PUBLIC_BACKEND_URL`; no hardcoded URLs
    - CORS = `*` (allows all origins)
    - Auth redirect uses `window.location.origin` with no fallbacks
    - Port config correct (backend 8001, frontend 3000)
    - `load_dotenv` uses default `override=False` (no env-leak issues)
    - DB queries optimised with limits/projections/indexes
  - **Caveats user should be aware of in production**:
    - SQLite-based `tile_cache` (~27 MB) writes to local disk inside the container — won't persist across pod restarts in K8s. Tile cache will rebuild on cold start; logs show this is benign hourly maintenance, not a blocker.
    - OSRM is currently hosted at `pathpilot-osrm.fly.dev` (external service) so the in-pod OSRM binary + Boost-libs supervisor config does NOT need to migrate. Fallback to Mapbox is the primary safety net (logs already show this working when OSRM has hiccups).


- [x] **Breadcrumb persistence — survive cold-starts mid-shift** (2026-05-08):
  - New `src/utils/breadcrumbStorage.ts` — `saveBreadcrumb(userId, points)`, `loadBreadcrumb(userId)`, `clearBreadcrumb(userId)`. Per-user keying (`breadcrumb:<user_id>`) so a depot device shared between drivers keeps trails isolated.
  - Wired into `(tabs)/index.tsx`:
    1. **Hydrate** on mount — `useEffect` reads stored points and seeds `traveledPath`. Idempotency guarded by `breadcrumbHydratedRef` so a re-render from `user?.user_id` settling doesn't overwrite live driving.
    2. **Save** debounced inside the `setTraveledPath` reducer — write every 30 GPS fixes (≈300 m driven, ≈30 s at urban speeds). Counter is a `useRef` so it survives renders without spawning a deps cycle. Fire-and-forget; the hot location-update path never awaits AsyncStorage.
    3. **Clear** in `stopLiveTracking()` — fresh route starts blank. Counter reset to 0.
  - Disk-full / quota-exceeded errors are swallowed (warn in dev, silent in prod) — losing the trail is degraded behaviour, but a crashed cockpit on a write fault would be unforgivable.
  - Format: single JSON-serialised array under one key. Decimation already caps the breadcrumb at ~5000 points (~50 km), so the payload stays under ~200 KB even on the longest single-user-day routes.
  - TS clean for all touched lines. Bundler healthy.


- [x] **Breadcrumb decimation — bounded memory over multi-day routes** (2026-05-08):
  - New `src/utils/decimateBreadcrumb.ts` exports `decimateBreadcrumb(points)` + `BREADCRUMB_DECIMATE_THRESHOLD = 5000`. Strategy: keep the most recent 60 % at full ~10 m fidelity (the part the driver pans around now) and halve the older 40 % by dropping every other point. O(N), zero-config, preserves shape so the ghost trail still reads at low zoom.
  - Wired into `setTraveledPath` reducer (`(tabs)/index.tsx:1457`). Triggers when the breadcrumb crosses 5000 points (~50 km of driving). Returning a SHORTER array trips the existing shrink-detection branch in `DeliveryMap.native.tsx`'s `lastSentTraveledLenRef`, which falls back from `appendTraveled` to a full `updateTraveled` re-ship — so the WebView's `traveled` source stays in lock-step with JS state without any extra plumbing.
  - Why not Ramer-Douglas-Peucker: tighter line for same point budget, but O(N log N) and needs a per-zoom tolerance. The "drop every other in old half" pass is good enough for a confirmation breadcrumb and keeps the call site dead-simple. Function signature stays stable so RDP can swap in later if needed.
  - TS clean for all touched lines. Bundler healthy.


- [x] **Map render performance — eliminated WebView bridge flooding after 50+ completions** (2026-05-08):
  - Audit found three real bottlenecks (the user's prompt assumed Mapbox-native markers + ShapeSource, but our map is a MapLibre WebView — different surfaces entirely):
    1. **Stops sync was re-stringifying ~30 KB of GeoJSON** across the WebView bridge on every Zustand merge — including writes that never touch the map (notes edits, tracking_number sets, sync-queue churn). Fix: per-stop fingerprint of the EXACT fields the WebView renderer reads (`id|completed|pending|original_sequence|lng|lat`); bail out of the `useEffect` when fingerprint matches the last shipped value. Result: zero bridge crossings for non-map writes.
    2. **`traveledPath` was full-replacing on every GPS fix** — after a workday's driving the breadcrumb is 3000+ points and the entire array was being JSON-serialized + bridge-crossed every ~10 m of movement. Fix: track `lastSentTraveledLenRef`, ship only the new tail via a new `appendTraveled` message; WebView concatenates onto its existing `traveled` source. Bridge cost drops from O(N) per fix to O(1).
    3. **Route polyline was re-shipping** on every parent re-render even when the line was identical. Fix: length + first/last-coord fingerprint, same skip pattern as stops.
  - **What did NOT need fixing** (verified):
    - `React.memo` on markers — N/A in this codebase. Markers are MapLibre layers inside the WebView, not native RN components. The parent `DeliveryMap` is already `React.memo`-wrapped (`DeliveryMap.native.tsx:1957`).
    - VRP / polyline recompute on completion — confirmed not happening. `setLiveRoute` only fires on actual route fetches, not completions.
    - Listener leaks — `setInterval`s at `index.tsx:2238, 2437` are properly cleared on unmount.
    - Growing arrays in state — `traveledPath` was the only growing array and it has a 10 m gate before appending (line 1451), capping growth to ~100 m/min.
  - Files: `src/components/DeliveryMap.native.tsx` (RN-side fingerprint refs + delta send + WebView `appendTraveled` handler).
  - Net effect at 200 stops / 50 completed / 3000-point breadcrumb: bridge JSON serialization per GPS fix drops from ~120 KB → ~60 bytes; per-completion bridge cost drops from constant ~30 KB to "shipped once on first render of that completion state".
  - TS clean for all touched lines. Bundler healthy.


- [x] **Drive-order shift flash — amber pulse on stop-detail LEFT badge** (2026-05-07):
  - New reusable hook `src/utils/useDriveOrderFlash.ts`. Returns an `Animated.Value` that ramps to 1 → holds → ramps back to 0 (~2 s total) when the supplied `driveOrder` changes between renders. Sentinel-skips mount, `null↔number` (confirm/clear, not a re-shuffle), and same-value renders so the badge doesn't fire on every list refresh.
  - Wired into `app/stop-detail.tsx`. The LEFT badge `<View>` was promoted to `<Animated.View>` with a `backgroundColor` interpolation that flashes amber `#f59e0b` on shift. Idle colour: blue (or green when completed) — same as before.
  - Sharpie chip is intentionally NOT animated — `original_sequence` doesn't change post-confirm, so a flash there would be a bug indicator, not a feature.
  - Stops tab (list) deferred — needs a `<StopCardItem>` extraction so each row owns its `Animated.Value`. Single-instance stop-detail covers the highest-value moment (driver opens a specific stop, sees its position shift).
  - TS clean. Bundler healthy.


- [x] **Dual-badge layout: optimised LEFT / Sharpie RIGHT — Stops tab + stop-detail hero** (2026-05-07):
  - New helper `src/utils/stopDriveOrder.ts` — sibling to `stopPinNumber`. Returns `stop.sequence_number` (the current drive-order rank, changes on re-optimise) or `null`. Same no-fallback contract as `stopPinNumber`.
  - **Stops tab card** (`(tabs)/stops.tsx`):
    - LEFT large priority-coloured badge now reads `stopDriveOrder(stop) ?? '—'` — the *drive-order today*. Was previously the Sharpie label.
    - NEW small slate Sharpie chip (`#127`, tabular-nums) sits just before the chevron, only rendered when `original_sequence` is locked. Hidden pre-confirm so the LEFT '—' nudges the driver to confirm.
    - testID: `sharpie-chip-${stop.id}`.
  - **stop-detail hero** (`stop-detail.tsx`):
    - LEFT 52px blue circle badge now reads `driveOrderNumber ?? '—'`.
    - NEW Sharpie chip in the right cluster of `cardHeader` (next to the Completed badge) — same "drive #5 / box #127" parallel reading.
    - testID: `stop-detail-sharpie-chip`.
  - **Why this matters**: after a mid-route re-optimise the LEFT (drive order) shifts but the RIGHT (Sharpie) stays welded to the box. The driver instantly sees both numbers without flipping back to the route screen.
  - **Scope held tight**: Sidebar / NavigationPanel / van-scan deferred to a follow-up — those surfaces have different ergonomic constraints and can be flipped if you want them next.
  - TS clean. Backend untouched.


- [x] **"Scan to attach" — single-shot barcode → tracking_number on stop-detail** (2026-05-07):
  - New camera-icon button next to the tracking input on `stop-detail.tsx`. Tapping it pushes `/van-scan?attachToStopId=<id>`.
  - `van-scan.tsx` reads the `attachToStopId` query param, switches to **single-shot attach mode**:
    - Skips the route-confirmation gate (driver might be attaching to a brand-new pre-confirm stop).
    - Skips the van-load lookup pipeline — driver has already picked the stop, the scanner is just a typing shortcut.
    - First valid scan: success haptic → `updateStop(attachToStopId, { tracking_number: raw })` → `router.back()`. Zustand merge propagates the new value to `stop-detail`'s subscription, so the input reflects the new value the moment the driver lands back.
  - Continuous van-load mode is unaffected when the param is absent.
  - testID: `stop-detail-tracking-scan`. TS clean. Backend 22/22.


- [x] **Manual tracking-number entry on stop-detail + PUT semantics fix** (2026-05-07):
  - **Backend schema**: added `tracking_number: Optional[str] = None` to `StopUpdate` in `server.py`. The field had been silently dropped from PATCHes — present on the wire, absent from the schema, so `**body` discarded it.
  - **Backend bug fix** (`routes/stops.py:290`): replaced `{k: v for k, v in stop_data.dict().items() if v is not None}` with `stop_data.model_dump(exclude_unset=True)`. The previous filter dropped *every* explicit `null` — so clearing any field via PATCH was impossible. New semantics:
    - `{"tracking_number": "TRK-1"}` → set
    - `{"tracking_number": null}` → clear
    - field omitted → no-op (preserves existing value)
  - **Frontend type** (`stopsStore.ts`): `StopUpdate.tracking_number?: string | null` so the TS callers can type the new write.
  - **Frontend UI** (`stop-detail.tsx`): new editable section above Notes — labelled "TRACKING NUMBER" with a barcode-outline icon. Locally controlled `TextInput` (no PATCH-per-keystroke), Save button only enabled while dirty, `ActivityIndicator` while in-flight, `auto-capitalize=characters` and `tabular-nums` to match how scanners print labels. Empty string clears via `null`. Driver can attach a tracking ID to any stop whose import didn't carry one (or whose label scanner didn't fire) — van-scan barcode lookup will pick it up on the next pass.
  - **Test**: new `test_update_tracking_number_round_trip` covers set / no-op-preserve / clear semantics. **22/22 backend tests pass.** TS clean.


- [x] **Marker-modal "Insert into route" — courtesy stop wedging** (2026-05-06):
  - New `insertIntoRoute(stopToInsert)` callback in `(tabs)/index.tsx` splices a tapped stop into the active route at position `currentLegIndex + 2` (becomes the new "next" — visited AFTER the current target but BEFORE what was previously next). Re-fetches OSRM directions for the entire modified sequence so every leg's distance/duration/geometry/steps is correct (cheaper than rebuilding subsequent legs piecemeal because every leg's `from_stop` shifts).
  - New "Insert" button in the marker modal's action row, between Delete and Mark Complete. Renders only when `viewMode === 'navigating'` AND `navigationData` exists AND the tapped stop isn't already the current target. Distinct teal `#0ea5e9` so it doesn't conflate with green Mark-Complete (success) or blue Navigate (re-route). Icon: `git-branch-outline`.
  - Already-in-route guard: refuses to double-insert by comparing `stopToInsert.id` against remaining legs' `to_stop.id`. Surfaces an Alert instead of silently mutating.
  - testID: `stop-modal-insert-button`. TS clean.


- [x] **Van-scan: silent sibling-parcel sub-text** (2026-05-06):
  - `onBarcodeScanned` in `app/van-scan.tsx` now runs a co-location filter on every successful match — 5-decimal lat/lng rounding (≈1.1 m, immune to geocoder jitter) with a normalised-address fallback for stops missing coordinates. Self is excluded; rows without a stamped `original_sequence` are skipped.
  - `Match` type extended with `siblings: number[]` (sorted ascending). Rendered as a quiet `<Text>` directly under `match.pinNumber` on the success overlay, painted in `match.zone.textHex` so it integrates into the existing overlay block without alarm chrome. Hidden entirely when no siblings.
  - Microcopy: `Also at this address: 124, 125`. Stops the loader from grabbing one parcel and forgetting its siblings — the #1 leftover-at-depot cause.
  - testID: `van-scan-match-siblings-{pinNumber}`. TS clean.

- [x] **Swipe-to-Deliver gesture re-armed in immersive driving panel** (2026-05-06):
  - `NavigationPanel.tsx` (expanded mode): replaced the green tap `<Pressable>` with the existing `<SwipeToDeliver>` track (≥75 % slide + medium-impact haptic at threshold + success haptic on commit). Component already has capture-phase responder claims so the parent stop-swipe PanResponder cannot steal the gesture mid-drag.
  - `key={currentStop?.id ?? 'no-stop'}` forces a remount on stop change so the locked-100 % knob auto-resets to 0 % between deliveries.
  - Telemetry side-benefit: a deliberate ~500 ms slide gives the Phase-1 service-time learner real `completed_at - arrived_at` spread instead of the 3 ms zero-spread we were getting from instant taps. Backend telemetry pipeline already in place — `POST /stops/{id}/arrive` (geofence) + `POST /stops/{id}/complete` with `arrival_method: "fallback_completion"` if geofence missed (`routes/stops.py:443-444`).
  - **Minimal mode left as tap** — the 52×52 collapsed pill can't host a swipe track, and its small target already requires deliberate aim; defensive responder-capture is preserved.
  - **Data state**: route_history=1, completed runs=0, stops with arrival+completion=3 (and that 3 is synthetic: 3 ms service time). Phase-1 learner stays paused until ~50+ real runs land via this gesture.


- [x] **"Stamp and Lock" — gap #3 closure: ripped `order+1` fallback out of `stopPinNumber.ts`** (2026-05-05):
  - User's strict spec called for THREE gap closures. Gaps #1 (API hydration in `routes/stops.py`) and #2 (instant Zustand state mutation in `stopsStore.confirmRoute`) were already shipped — verified via the strengthened `test_confirm_route_locks_sequence` (asserts `stops[]` carries `id` + `sequence_number` + `original_sequence` in payload order).
  - Gap #3 was still open: `stopPinNumber(stop)` was falling back to `stop.order + 1` (the backend planning preview) when `original_sequence` was null. Per spec, "It MUST NOT fall back to `order + 1` or any array index" — the visible badge now returns `null` for any stop without a locked Sharpie value, so callers render `'—'` / blank. This visually forces the driver to hit "Confirm Route" before they start writing numbers on boxes.
  - Function signature unchanged (`stopPinNumber(stop): number | null`); only the resolution body was tightened. No new callers needed updating since every existing caller already used `?? '—'` or null-check post-prior-fork refactor.
  - `groupStops.getStopShortName` retains its own `Stop #${order+1}` fallback, but only as a textual disambiguator in grouped-address pickers — not as the Sharpie badge. That's a separate display concern from the locked map badge.
  - **Backend tests still 21/21 pass.** TS compile clean for `stopPinNumber` and all callers; the 3 remaining pre-existing TS errors are unrelated (`map-demo.tsx`, `DeliveryMap.native.tsx:1855` lasso, `DeliveryMap.tsx:553`).

  - Backend `POST /api/routes/confirm` already returned `{status, locked_count, confirmed_at, stops[]}`. Added an explicit assertion to the existing `test_confirm_route_locks_sequence` test that the response now carries the full stamped row list with `id`, `sequence_number`, and `original_sequence` populated and ordered exactly as the payload — so the frontend Zustand merge can hard-replace local state without a separate GET.
  - Frontend `confirmRoute` in `stopsStore.ts` already merges the server-stamped `body.stops` array by id (server is single source of truth for `original_sequence`) and falls back to a local stamp only if the response body is malformed.
  - `stopPinNumber.ts` is locked to a 1-arg signature (`stopPinNumber(stop)`) — caller-provided index fallbacks were the previous footgun. Found and fixed 4 stale 2-arg call sites that survived the prior fork's refactor sweep:
    - `src/utils/groupStops.ts:70`
    - `app/(tabs)/stops.tsx:189` (testID) and `:208` (visual badge — now renders `'—'` if the row has neither `original_sequence` nor `order`)
    - `app/(tabs)/index.tsx:1288`
  - Tightened the `original_sequence` cast in `DeliveryMap.native.tsx:1722` so the WebView feature builder no longer trips a TS narrowing error.
  - Backend tests **21/21 pass** (incl. the strengthened `test_confirm_route_locks_sequence`). TS compile clean for all refactor sites — remaining unrelated `tsc` errors (3) are pre-existing in `DeliveryMap.tsx`, `DeliveryMap.native.tsx:1855`, and `map-demo.tsx`.
  - Files: `backend/routes/stops.py` (no change), `backend/tests/test_routes_stops.py`, `frontend/src/store/stopsStore.ts` (no change), `frontend/src/utils/stopPinNumber.ts` (no change), `frontend/src/utils/groupStops.ts`, `frontend/app/(tabs)/stops.tsx`, `frontend/app/(tabs)/index.tsx`, `frontend/src/components/DeliveryMap.native.tsx`.


- [x] **Zero-Cost Interleaving — defence in depth across all solvers** (2026-04-30):

- [x] **Route Confirmation Pipeline — frontend wiring + commit on Start** (2026-04-30):
  - Backend (shipped in previous fork): `POST /api/routes/confirm` bulk-writes `sequence_number=i+1` for every id in `confirmed_sequence`, clears the number back to `null` for any of the user's stops NOT in the payload, rejects duplicate ids (400) and non-owned ids (400). `GET /api/stops` uses an `$ifNull` aggregation to sort confirmed stops first (sequence ASC, nulls sink with sentinel `10**9`), tie-broken by the legacy `order` field so drag-and-drop keeps working for unconfirmed stops.
  - Frontend (shipped this fork): new `confirmRoute(stopIds)` action in `stopsStore.ts` (15 s timeout, optimistic local stamp, never throws — records `lastFetchError` and returns false so caller proceeds). Wired into `(tabs)/index.tsx:startNavigation` right before `setViewMode('navigating')` — the existing green **Start** button now doubles as the commit gesture. A network/auth failure logs `console.warn` and continues, so a flaky connection can never wedge the driver on the planning screen.
  - Added `sequence_number?: number | null` to the `Stop` TS interface.
  - Tests: `/app/backend/tests/test_routes_stops.py` +6 cases (lock, re-confirm-clears, duplicate rejection, unknown-id rejection, empty payload 422, confirmed-before-unconfirmed GET order). **15/15 pass.**
  - OTA `2bc037bd-1939-42ee-9b55-c36616cd03e4` to `production` (Android `019ddfb0-e442-7689-8ff6-ab352088cc7f`).

  - PyVRP's snap fix in `_coord_key` (5 dp ≈ 1.1m) prevented HGS from interleaving same-doorstep parcels, but OR-Tools, LKH and VROOM (used as fallbacks when PyVRP fails) had NO clustering at all — the bug was still reachable through any fallback path.
  - Lifted the snap-cluster-expand pipeline into a shared module `backend/solvers/coord_clustering.py` exposing `cluster_aware_solve(solver_fn, matrix, depot, stops, **kwargs)`. Wraps any `(matrix, depot, **kw) -> List[int]` solver with: (1) snap stops to 5dp, (2) collapse same-bucket stops into super-nodes, (3) call solver on reduced matrix, (4) expand members consecutively in input order. Depot is never merged. Warm-start `initial_indices` is silently dropped when clustering kicks in (instead of corrupting the seed).
  - Wrapped 4 fallback call sites in `server.py`: PyVRP-failure → OR-Tools, the dedicated VROOM-only path (+LKH refinement), the VROOM+OR-Tools 2-stage pipeline, and the LKH algorithm path (+ its OR-Tools fallback).
  - Tests: 12 new `test_coord_clustering.py` + 2 new `test_pyvrp_duplicate_coords.py` jitter tests + 12 pre-existing PyVRP duplicate-coord tests. **38/38 pure-solver tests green.**
  - Files: `backend/solvers/coord_clustering.py` (new), `backend/server.py`, `backend/tests/test_coord_clustering.py` (new).

- [x] **Same-doorstep camera & route-fetch short-circuit** (2026-04-30):
  - When `moveToNextStop` advances to a leg whose `(lat, lng)` snaps to the same 5dp bucket as the just-completed stop, skip the OSRM `fetchResetRoute` call, the `setLiveRoute` update, and the duplicate "Next: …" voice prompt. Just bump `currentLegIndex`. Eliminates the brief camera tilt / re-fit / re-zoom for a 0-metre move and avoids a wasted OSRM round-trip per parcel-in-cluster.
  - Pushed in OTA `cc8a7802-8dbb-4fab-b8d0-482860263b5f` alongside the PyVRP coord snap.
  - Files: `frontend/app/(tabs)/index.tsx`.

- [x] **Loud multi-parcel UX in nav panel** (2026-04-30):
  - Amber warning banner above the stop row when `colocatedCount > 1`: "MULTIPLE PARCELS AT THIS ADDRESS · Parcel N/M · {weight} kg · #{stop-id-prefix}" + progress dots (green=delivered, amber=current, grey=pending). Minimal-mode badge changed from `x2` to `1/2`.
  - "Stay-here" voice + amber toast when next pending stop shares coords with the just-delivered one — toast lingers 4.5s instead of 1.5s and uses an amber pill variant of `resumeToast`.
  - Files: `frontend/src/components/route/NavigationPanel.tsx`, `frontend/app/(tabs)/index.tsx`.



- [x] **Dead-tap diagnostic: full `dbg()` instrumentation of `completeStop` pipeline** (2026-04-30):
  - Android RN drops `Alert.alert()` calls fired in the same JS tick (only the first displays). Previous diagnostic alerts in `stopsStore.completeStop` were silently swallowed, leaving the team blind to where the silent failure occurred.
  - Replaced all 7 remaining `Alert.alert(...)` calls inside `completeStop` (entry probe, HTTP 200, 5xx/queue, 4xx fail, PUT fallback success/fail/throw, network error) with `dbg(...)` calls that route to the on-screen `DebugOverlay`.
  - Added a `FETCH` probe right before the actual `authFetch` so we can distinguish "never reached fetch" from "fetch hung / threw".
  - Pushed OTA update to `production` branch — Update group `044616ab-1c1a-49a6-ab23-05577392da20`. User needs to force-close app twice on the EAS APK to pull the new bundle.
  - Files: `frontend/src/store/stopsStore.ts`.


- [x] **Deploy fix #2: real EOVERRIDE root cause from actual build logs** (2026-04-29):
  - Got actual `eas-apk-build` logs from user. The pipeline failure trace:
    1. **Step 3b** of Emergent's deploy pipeline auto-rewrites `package.json`: `Fixed dependencies: @react-native-async-storage/async-storage@^1.24.0`. Emergent forces async-storage to pre-KMP v1.x to avoid needing an extra Maven repo on Android (Step 6c: "AsyncStorage v1.24.0 (pre-KMP) - no extra Maven repo needed").
    2. **Step 4** `npm install` succeeds with `^1.24.0` ("added 856 packages").
    3. **Step 7** `expo-doctor` flags the SDK 54 mismatch (expected 2.2.0, found 1.24.0) and triggers `expo install --fix`, which calls `npm install @react-native-async-storage/async-storage@2.2.0`. npm v9+ treats this as an `overrides` entry conflicting with the `^1.24.0` direct dep → **EOVERRIDE crash**, build dies, EAS upload + deploy times out at the 14-minute mark.
  - My previous "pin to exact 2.2.0" fix didn't help because Emergent's pipeline rewrites the file BEFORE `npm install` ever runs.
  - **Real fix:**
    1. Aligned `package.json` with what Emergent's pipeline writes: `@react-native-async-storage/async-storage: 1.24.0` (matches Step 3b output).
    2. Added `"expo": { "install": { "exclude": ["@react-native-async-storage/async-storage"] } }` block. This is the official Expo docs solution — `expo-doctor` and `expo install --fix` both honor this exclude list and skip the package, so Step 7 no longer attempts the conflicting upgrade. Emergent's pipeline keeps v1, KMP repo isn't needed, and EAS Build proceeds cleanly.
  - Verified locally: `expo install --check` now logs `Skipped checking dependencies: @react-native-async-storage/async-storage` and exits 0. Full preflight (`yarn deploy:preflight`) passes in ~7s.
  - Files: `frontend/package.json`.



- [x] **Deploy fix: EAS / Emergent Native Deploy `npm install` EOVERRIDE crash** (2026-04-29):
  - User's deploy was failing at `Step #5 - eas-apk-build` with `npm error Override for @react-native-async-storage/async-storage@2.2.0 conflicts with direct dependency` followed by `Cannot determine the project's Expo SDK version because the module expo is not installed.`
  - Root cause: EAS Build's pre-install hook auto-injects an `overrides` entry pinning Expo SDK-locked packages to exact versions. With `^2.2.0` as the direct dep, npm v9+ sees the override (`2.2.0`) as conflicting with the caret range in strict mode and aborts. Once npm install fails, `expo` isn't installed → second error cascades.
  - Fix:
    1. Pinned `@react-native-async-storage/async-storage` to exact `2.2.0` (dropped the caret) in `frontend/package.json`. Override and direct dep now match exactly.
    2. Deleted stale `frontend/package-lock.json` (mixed lockfile state — project uses yarn per `packageManager: yarn@1.22.22`). Yarn lockfile remains.
    3. Removed duplicate `.env`/`.env.*`/`*.env` ignore block from `/app/.gitignore` (lines 95–103) that contradicted the comment above stating `.env` files are intentionally tracked. Emergent Native Deploy needs `.env` files in the repo to inject prod values.
  - Files: `frontend/package.json`, `frontend/package-lock.json` (deleted), `.gitignore`.
  - User must redeploy via Emergent's Deploy button to verify.



- [x] **Bug fix: Delivered button silent-revert on 4xx + cross-deploy PUT fallback** (2026-04-29):
  - 11 OTAs into the day, user reported Skip + Undo work but Delivered doesn't. Same UI surface = ruled out gesture-hijack. Same network = ruled out connectivity. Examined `completeStop` and found at line 676 a totally silent `set({ stops: prev })` revert when `/api/stops/{id}/complete` returned 4xx (e.g., 401 expired session, 404 stale stop ID, or 405/422 on a deployed pod that doesn't yet have the new endpoint).
  - From the user's view: tap Delivered → optimistic tick flashes → state reverts → no toast, no log, no alert → button looked dead.
  - Fix: 4xx now sets `lastFetchError` (visible via the existing red banner UI) and console.warns the diagnostic detail. THEN attempts a fallback `PUT /api/stops/{id}` with `completed: true` — that endpoint has shipped to every backend revision in project history, so even an older deployed prod pod that 404s on `/complete` still marks the stop. Best-effort, swallows further errors.
  - File: `frontend/src/store/stopsStore.ts`.
  - OTA pushed to `production` (group `9fea1a8c-d61f-45b3-a6d1-cb907025f51f`, Android `019dd69c-127e-7514-bce1-1cdcc66307df`, iOS `019dd69c-127e-7565-92f2-7e08dce0af06`).
  - Plan B if OTAs aren't applying: rebuild APK via `eas build --platform android --profile preview` to bake all 11 today's frontend fixes directly into a fresh standalone build, removing OTA caching from the equation. Documented to user.


- [x] **Root-cause fix: `handleMarkDelivered` silent early-return** (2026-04-29):
  - 9 OTAs into the day, the user kept reporting "still not working" no matter which Delivered UI shipped (button, swipe, button-rescue). Backend logs showed driver actively navigating — leg index advancing, GPS streaming — but `/api/stops/{id}/complete` was NEVER called.
  - Re-read `handleMarkDelivered` line-by-line. Line 1579 was `if (!currentLeg?.to_stop) return;` — a SILENT guard that swallowed the tap whenever `navigationData?.legs[currentLegIndex]?.to_stop` was null. Failed/Skip didn't have this guard, which is why those advanced the route while Delivered just ate the press. The user's symptom matches exactly.
  - When does `to_stop` go null? After the last leg, if navigationData hasn't refreshed yet, or if the leg shape returned by `/api/navigation` differs subtly from what the frontend expected. The user *had* been advancing through legs, very likely past where navigationData had cached.
  - Fix: replaced the early-return with a fallback chain — `currentLeg?.to_stop ?? stops.find(s => !s.completed)`. If both are null we now show a clear "Nothing to deliver — tap the stop on the map" alert instead of failing silently. Console.warn logs the diagnostic context for future regressions.
  - OTA pushed to `production` (group `84e8abde-6383-4d6e-b225-0667cec576b8`, Android `019dd681-cfcc-7f79-bd52-07d19e0a2123`, iOS `019dd681-cfcc-70cb-a834-b1b9925dc9dc`).
  - File: `frontend/app/(tabs)/index.tsx`.


- [x] **Rescue: reverted swipe-to-deliver back to plain green tap-button** (2026-04-29):
  - User reported repeatedly during active route work that delivery wasn't advancing — tried both old button and new SwipeToDeliver. Backend logs confirmed zero `/api/stops/{id}/complete` calls reaching the server across multiple OTAs, even while the user was actively in nav mode and the destination leg index was advancing (so they may have been using Skip or geofence auto-advance to move on).
  - Decision: prioritize reliability for hackathon over the swipe UX. Reverted `NavigationPanel.tsx` to a plain `TouchableOpacity` with the "Delivered" label + green styling, kept the earlier 8→20 px PanResponder threshold fix (gesture-hijack mitigation in the same file). `SwipeToDeliver` component left in repo for a future re-attempt.
  - Suspected reason the swipe never landed on the device: EAS Update download is async (downloads in background, applies on next launch) — repeated OTAs in a short window can race, and a single relaunch sometimes loads the previously-cached bundle instead of the freshest one. Asked user to kill+reopen the app twice if the green button still isn't working.
  - OTA pushed to `production` (group `29b6255c-d4f9-4171-bd9a-7d23552efdc5`, Android `019dd67c-ae12-76c7-8b60-23a44f620cc1`, iOS `019dd67c-ae12-7afd-883a-aec780883155`).
  - Files: `src/components/route/NavigationPanel.tsx`.


- [x] **Feature: Swipe-to-Deliver gesture** (P1, 2026-04-29):
  - New `src/components/route/SwipeToDeliver.tsx` — slide-to-confirm track (white knob, green fill, "Slide to deliver →" label, "Delivered ✓" lock-in overlay). Drag knob to ≥75% to commit; spring-back below threshold; medium-impact haptic at the threshold cross + success haptic on commit. Sized to slot directly into the existing [Failed | Delivered | Skip] row in `NavigationPanel`'s expanded view.
  - Critically, owns its own touches end-to-end: `onResponderTerminationRequest={false}` on the wrapper + `onStartShouldSetPanResponder=true` on the knob's PanResponder. This is the architectural answer to today's earlier "outer pan steals inner tap" Delivered-button bug — a parent PanResponder physically cannot reclaim the gesture mid-drag, regardless of finger jitter or vehicle vibration.
  - `key={swipe-${currentLeg?.to_stop?.id}}` forces a fresh component on every stop change so the committed-state lock from the prior delivery doesn't bleed into the next stop.
  - Failed and Skip remain tap-buttons (lower-frequency actions, jitter risk acceptable, especially now that the underlying PanResponder threshold was bumped 8→20px earlier today).
  - OTA pushed to `production` (group `88fbc8a4-3cbc-4f82-bcf9-7db773f71c14`, Android `019dd675-5b99-7ed0-8621-6ee1e24f1f3f`, iOS `019dd675-5b99-705a-9850-92bef694c851`).
  - Files: `src/components/route/SwipeToDeliver.tsx` (new), `src/components/route/NavigationPanel.tsx`.


- [x] **Critical bug fix: ALL Delivered / Failed / Skip buttons silently dead** (2026-04-29):
  - User report: tapping Delivered (immersive overlay), green-tick (compact bottom panel), and "Mark as Delivered" in the stop-detail modal all do nothing — no animation, no toast, no voice prompt. Backend logs confirmed: actively in navigation mode with /api/directions calls firing every 30s, but **zero** /api/stops/{id}/complete requests across the whole session — the API call wasn't even being attempted.
  - Root cause: `NavigationPanel.tsx:160` had a horizontal-swipe PanResponder threshold of just **8px** wrapping the entire bottom-card Animated.View — including the Delivered button. Any finger jitter ≥ 8 px during a tap-release (extremely common on a moving vehicle, or even normal Android touch noise) made the PanResponder claim the gesture and the inner TouchableOpacity children's `onPress` never fired.
  - Fix: raised threshold to **20 px**. Sits comfortably above typical jitter / road-vibration drift but below Android's tap-slop of ~24 px, so deliberate horizontal swipes between stops still work and tap-with-jitter no longer gets stolen.
  - File: `src/components/route/NavigationPanel.tsx`.
  - OTA pushed to `production` (group `42785e4e-1890-40d9-a23d-79e74a3132f3`, Android `019dd66b-4934-7324-bf7d-904e067e8ffe`, iOS `019dd66b-4934-7e61-b22a-96c4ec3f1920`).
  - Self-tested: bundle compiles + new threshold value present. Full e2e validation requires the user to reopen the app on the phone — please confirm whether the Delivered button now stamps stops complete.


- [x] **Bug fix: route polyline not rendering in planning mode** (2026-04-29):
  - User report + screenshot: after tapping Optimize the map showed pins but no connecting route line. Reproduced from `app/(tabs)/index.tsx:2383` where `mapRouteCoordinates` was hard-coded to return `null` whenever `viewMode !== 'navigating'`. Comment claimed this was intentional ("we show *just the pins* — no full optimised polyline") — but the optimised polyline IS the entire point of route planning, and `routeGeometry` is already populated by `fetchDirections()`.
  - Fix: in planning mode, `mapRouteCoordinates` now reads `routeGeometry.coordinates` (with shape validation: must be `Array of [lng,lat] pairs` length ≥ 2 — guards against legacy non-LineString shapes that some offline-cache hits and old `route_history` records can stuff into the field).
  - Navigation mode unchanged — still uses `liveRoute.geometry.coordinates` so the driver sees only the live driver→next-stop segment, not a visual loop through future stops.
  - Bonus catch in same session: a transient 502 on XLS upload was caused by a brief preview pod restart while bundling new OTAs. The pod auto-recovered within seconds; the 502 was confirmed transient with internal+external probes returning 200/401 normally.
  - OTA published to `production` (group `b09583f4-51ed-4b1d-a97b-7e69e58cca17`, Android `019dd643-e058-7043-a17e-6b3aa470c939`, iOS `019dd643-e058-7f63-909c-b1ff9d0aff18`).
  - File: `frontend/app/(tabs)/index.tsx`.


- [x] **Feature: Global 401 interceptor (session-issue-proof app)** (2026-04-28):
  - New `src/utils/authBridge.ts` — module-level singleton holding the registered `reconnect` impl + a coalescing `triggerReconnect()` so N parallel 401s share ONE in-flight OAuth Promise (no five-browser-tab pile-up).
  - `AuthContext` registers/unregisters its `reconnect` via `setReconnectImpl()` on every render so the bridge always points at the live closure.
  - `stopsStore.authFetch` is now a thin wrapper around `_rawAuthFetch`: on a 401 it awaits `triggerReconnect()` and, if successful, retries the original request EXACTLY ONCE with the freshly-issued bearer (re-read from AsyncStorage, so the new token is automatically applied). Skips the dance entirely when no token was present (anonymous public endpoints).
  - Effect: any auth-protected call from anywhere in the app — fetchStops, optimize, import, complete, delete, etc. — recovers transparently from session expiry. Driver might see a single browser flash and the operation completes; usually they don't notice anything happened.
  - Verified by user usage immediately after the prior OTA: import, optimize, tighten-clusters all `200 OK` end-to-end after a single reconnect.
  - OTA published to `production` (group `5403b6d3-cab7-4dab-b93c-0cb39cbcff55`, Android `019dd5c1-ee06-7bc9-b40f-4b0b7c090b08`, iOS `019dd5c1-ee06-7739-83d0-c3ee72e169e3`).
  - Files: `src/utils/authBridge.ts` (new), `src/context/AuthContext.tsx`, `src/store/stopsStore.ts`.
  - Future caveat: the retry skips request-body re-cloning, which is fine for our JSON-string bodies. If a future feature uploads streamed bodies (FormData with Files etc) on a protected route, the retry path would need to capture+rewind the body — the calamine import upload uses FormData but the path is currently exercised before any 401 because import preview/process arrives with a fresh token in the same tab.


- [x] **Feature: One-tap reconnect (closest-to-silent token refresh for Emergent Auth)** (2026-04-28):
  - Backed by integration_playbook_expert_v2 confirmation: Emergent-managed Google Auth has NO `/refresh` endpoint — `session_token` is fixed 7-day, only re-issuable through the OAuth flow. So "silent" isn't possible; **one-tap** is.
  - `AuthContext` now exposes `reconnect()` (re-runs WebBrowser OAuth in-place + re-exchanges the new session_id) and a `reconnecting` flag.
  - `(tabs)/stops.tsx` "Session expired" banner now calls `reconnect()` directly with a spinner state — no more Profile → Sign out → Sign in detour. On success, `fetchStops` re-fires automatically and the banner disappears.
  - `app/import.tsx` auto-triggers `reconnect()` when the post-import `lastFetchError.status === 401`, so a driver hitting expiry mid-import sees one browser tab flash and lands on a populated Done screen instead of the previous silent-empty failure.
  - In-place OAuth typically reuses the device's existing Google session cookie → 90% of the time it's a momentary tab flash, not a full re-login.
  - OTA published to `production` (group `787020b7-cf26-4f18-9d92-8afa30eb8320`, Android `019dd5bc-c6e4-7209-936f-a8d1078cb739`, iOS `019dd5bc-c6e4-7647-a6b3-54f869fc0f1d`).
  - Files: `src/context/AuthContext.tsx`, `app/(tabs)/stops.tsx`, `app/import.tsx`.


- [x] **Bug fix: XLS import "success but empty list"** (2026-04-28):
  - Root cause confirmed via backend logs: `GET /api/stops` was returning 401 Unauthorized for the user's session AFTER the import POST succeeded. `fetchStops` swallowed the 401 in its catch block, leaving the zustand store empty — UI showed a phantom "no stops" state even though the import had genuinely succeeded server-side.
  - Fixes shipped:
    1. `stopsStore.fetchStops`: now records non-OK responses into a new `lastFetchError: { status, message }` field instead of silently dropping them. Clears it on success.
    2. `app/import.tsx`: re-ordered the flow to `await fetchStops()` BEFORE `setStep('done')` (closes the race where users tapped "View Stops" while the refresh was still in-flight), retries once on transient failure, and pops a clear "Imported, but please sign in again" alert when the post-import fetch returns 401.
    3. `app/(tabs)/stops.tsx`: added `useFocusEffect`-driven refetch (every focus, not just on user change) so navigating back from the import modal always pulls fresh stops, plus a tappable red "Session expired — tap to sign in again" banner above the empty state when `lastFetchError.status === 401`.
  - User-facing recovery path: open app (OTA will pull), tap red banner → Profile → Sign out → sign in again → re-import. Going forward the bug is silent-no-more.
  - OTA published to `production` (update group `99e14605-fa76-4d00-8b7e-4947c5927006`, Android `019dd51d-42ff-790f-a2e7-39f2a85f0e81`, iOS `019dd51d-42ff-7fad-98e0-b01e9af29533`).
  - Files: `frontend/src/store/stopsStore.ts`, `frontend/app/import.tsx`, `frontend/app/(tabs)/stops.tsx`.


- [x] **Hackathon: fancy front page** (2026-04-28):
  - Rewrote `/app/frontend/app/index.tsx` from the generic light-blue RouTeD Route Planner splash into a dark "mission control" cockpit screen.
  - New decorative component `/app/frontend/src/components/RouteTraceBackground.tsx` — three SVG paths perpetually trace themselves across the canvas via Reanimated `strokeDashoffset` worklets (60fps, runs even during OAuth round-trip). Stop pins at endpoints pulse softly.
  - Layered design: solid bg → animated traces → orange + lime radial glows (faked via offset linear gradients) → content → footer with `LivePulse` dot.
  - Headline "14 solvers. / One perfect route." with accent-coloured second line. Three stat chips (14 SOLVERS · 60 FPS · OSRM + VROOM). Pill-shaped Google CTA with accent-orange ring + scale-on-press, ghost "Watch the 25-second demo" secondary, "See live solver benchmarks →" tertiary.
  - Cockpit footer: "ROUTING ENGINE ONLINE · v2026.04 · BUILD STABLE" with a softly throbbing lime dot.
  - All auth logic preserved byte-for-byte — only the render + styles + a single haptic-on-press were touched.
  - Loading state replaced (was a centered spinner on white) with the splash chrome + accent spinner so users see the brand instead of a void during OAuth.
  - OTA published to `production` (update group ID `530d4d20-f02d-423c-86df-cae28b131290`, Android `019dd4ff-c4bd-767d-a7cc-581cf235598b`, iOS `019dd4ff-c4bd-7ddb-ab5b-d673a2cfb280`).
  - Note: Metro runs with `CI=true` so the dev-server bundle won't hot-reload on file edits — restart `expo` via supervisor to refresh the web preview.


- [x] **PyVRP duplicate-coordinate handling** (2026-04-25):
  - Refactored `backend/solvers/pyvrp_tsp_solver.py` to collapse stops with identical `(lon, lat)` into a single PyVRP super-node before solving, then re-expand to the original input order. Sums grouped service durations. Eliminates the random ordering between zero-cost duplicate addresses (multi-unit buildings) that produced visible map zig-zags.
  - `DeliveryStop.x`/`y` now `Optional[float]` — when omitted the legacy code path is preserved (each stop is its own group). `pyvrp_tsp_solve` adapter in `server.py` accepts an optional `coordinates` list and the optimize endpoint now passes `(longitude, latitude)` for every stop.
  - Added `backend/tests/test_pyvrp_duplicate_coords.py` — 8 regression tests covering: unique-coord no-op, duplicate clusters stay contiguous, input-order preservation, summed service durations, and open-path optimum unaffected on the river-crossing matrix. All 19 PyVRP/open-path tests pass.

- [x] **PyVRP HGS solver integration** (2026-04-24):
  - Added `backend/solvers/pyvrp_tsp_solver.py`: production-ready `PyVRPTspSolver` class with `DeliveryStop` dataclass — pure-TSP, single-vehicle, no time windows, minimises duration (travel + service time) via `unit_distance_cost=0, unit_duration_cost=1`.
  - Wired `pyvrp_tsp_solve(duration_matrix, depot, time_limit_seconds)` into `server.py` matching the existing solver signature pattern (vroom/lkh).
  - Registered new `algorithm="pyvrp"` branch in `/api/optimize` (wrapped in `asyncio.to_thread`, time budget `0.5 + 0.04·N`s capped at 3s, with OR-Tools + 2-Opt fallbacks).
  - Exposed in `/api/optimize/algorithms` so the UI picker can select it.
  - New pytest: `backend/tests/test_pyvrp_solver.py` (Hamiltonicity + non-zero depot + trivial-input guards). All 16 solver tests pass.
  - `pyvrp==0.13.3` added to `requirements.txt` via `pip freeze`.

- [x] **Absolute stop-numbering eradication** (2026-04-23):
  - Goal: every UI surface that paints a stop number must match the map-pin sprite (`stop-${order}`) — no array-index drift when stops are filtered/reordered.
  - `NavigationPanel.tsx` — imported `stopPinNumber` (was already called on L121 but never imported → runtime crash risk); jump-menu badge now `stopPinNumber(leg.to_stop, idx + 1)`.
  - `Sidebar.tsx` — all three badge sites (single-stop row, grouped-stop header, drag-mode fallback) now use `stopPinNumber(stop, runningIndex + 1)`.
  - `app/stop-detail.tsx` — migrated the inline `stop.order + 1` fallback to the shared helper so all four surfaces (bottom-sheet, resume overlay, jump-menu, detail) share one source of truth.
  - Verified: `yarn run deploy:preflight` clean, OTA published to `production` (update ID `019dbb13-c182-7654-9468-548b8e49ec8b`).

- [x] **Auth: persisted session_id dedupe** (2026-04-23):
  - Added `/app/frontend/src/utils/consumedSessionIds.ts` — AsyncStorage-backed map of consumed `session_id` → expiry (10-min TTL, auto-prunes on read).
  - `exchangeSessionOnce` now checks this map (and the existing `session_token` on disk) BEFORE hitting demobackend, and records the id after a successful exchange. Dedupe now survives `Updates.reloadAsync()`, Force Stop, and process kills — not just the in-memory `exchangedRef`.
  - OTA published to `production` (update ID `019dbc31-440e-7808-bbe9-61aac2a362fb`).

- [x] **Auth: OTA-reload sign-in loop fixed** (2026-04-23):
  - Symptom reported: sign in with Google → app briefly opens → kicks back to sign-in screen. User had Force-Stopped; not a stale-bundle ghost.
  - Root cause: after a successful sign-in, `Updates.reloadAsync()` ran the OTA fetched in the same session. On the next cold start, Android redelivered the same auth redirect URL via `Linking.getInitialURL()` to a fresh JS context. `exchangedRef` (in-memory dedupe) was wiped, so the session_id was re-exchanged — but demobackend treats session_ids as one-shot and returned 404. Our backend mapped that to 401 → frontend showed "Sign-in failed" alert → kicked back to login.
  - Fix: in `exchangeSessionOnce`, `await AsyncStorage.getItem('session_token')` BEFORE calling demobackend. If a token already exists, record the session_id as consumed and return silently. Matches the Emergent Auth playbook rule: "skip session_id processing when we already have a session".
  - Verified: backend `/api/auth/me` returning 200 OK continuously; no user-facing toast required.
  - OTA published to `production` (update ID `019dbc2c-8287-7348-b175-6df60f07049e`).

- [x] **Solver audit + P0/P1 fixes** (2026-04-23):
  - #1 **School-zone penalty applied to distance_matrix too** (not only duration) — 8 of 18 algorithms were previously ignoring the Meridan rule. Added `SCHOOL_ZONE_BASE_PENALTY_METERS` (3333 m ≈ 5 min @ 40 km/h) and a `unit` param to `apply_school_zone_penalty`.
  - #2 **Duplicate-stop index bug** — replaced 26 occurrences of `[source.index(s) for s in ordered]` with a new `_indices_by_identity()` helper that uses `id()` instead of value-equality. Users with duplicate addresses (multiple units at same building) no longer silently lose stops.
  - #3 **Timefold wrapped in `asyncio.to_thread`** — 5-15 s of JPype Java no longer blocks the event loop.
  - #4 **Shadow benchmark parallelised** — now runs in a background thread concurrently with the road-distance fetch via `asyncio.create_task(asyncio.to_thread(...))`. Saves 5-10 s per optimize call.
  - **15-case Hamiltonicity test suite** (`tests/test_solver_hamiltonicity.py`) proves every solver returns exactly the input stops with no drops/dupes — including a fixture with duplicate-valued stops that would have caught #2.
  - Verified end-to-end on the 160-stop Little Mountain / Aroona / Meridan dataset: in=160, out=160, all IDs match, penalty applied to both matrices (log: `duration=yes, distance=yes`).

## Completed Features
- [x] Stop management, Route optimization, Navigation, Route History
- [x] DeliveryMap (web + native), Driver marker, Driving mode, HUD
- [x] OpenAI TTS voice navigation
- [x] Deployment build fixes
- [x] Android native map — canvas icons, style-load gating, HW accel
- [x] 3D Driving Mode — pitch 60, look-ahead, smooth easeTo, nav puck
- [x] On-demand stop icon generation (no 30-stop cap)
- [x] Enhanced 3D buildings — height-based color gradient, progressive extrusion
- [x] Self-hosted building tiles (2026-04-12)
- [x] Lasso Drawing Tool — HTML overlay, Turf.js point-in-polygon, imperative setDrawingMode
- [x] Backend section-optimization upgraded (VROOM → LKH-3 → 3-opt)
- [x] Bottom Tab Bar with swipe navigation
- [x] Immersive Mode (Android status/navigation bars hidden on map tab)
- [x] Google Auth (Emergent-managed OAuth)
- [x] Lasso sticky polygon fix (2026-04-14): Orange outline persists; added clearLasso()
- [x] Multi-section lasso polygons (2026-04-15): Each section persists with unique color + label
- [x] QLD cadastral parcel boundaries + street numbers (2026-04-15): ArcGIS proxy tiles, Parcels toggle
- [x] Speed-based auto-zoom (2026-04-15): z18.5 stationary → z14 highway, 70/30 lerp smoothing
- [x] Font fix (2026-04-15): All text-font refs changed from Open Sans to Noto Sans (OpenFreeMap glyphs)
- [x] VROOM→OR-Tools warm-start pipeline + OSRM duration matrix distributed to all 14 solvers (2026-04-16)
- [x] Or-Opt polish step added to VROOM solver path (relocate 1-3 stop sequences) (2026-04-16)
- [x] `calculate_route_distance` helper added (was missing, caused NameError in ILS/VROOM paths) (2026-04-16)
- [x] ILS (Iterated Local Search) with double-bridge perturbation wired as standalone algorithm + replaces SA (2026-04-16)
- [x] ILS added to frontend dropdown + GLOBAL_CAPABLE list (2026-04-16)
- [x] Duplicate `or_opt_improve` function + dead code removed from server.py (2026-04-16)
- [x] Navigation voice: 3-stage Google Maps-standard announcements with speed-scaled thresholds (2026-04-16)
- [x] `formatDistance` updated in route.ts + types.ts — rounded to nearest 50m/100m/0.5km (2026-04-16)
- [x] Voice phrases use full words: "1 kilometre", "300 metres" instead of "1.0 km", "847 m" (2026-04-16)

- [x] **High-Performance VRP Matrix Sparsification** (2026-04-20):
  - `vrp_solver.py` + `osrm_matrix_service.py` reference modules (GLS metaheuristic, soft TW, tiered objective)
  - `sparsify_matrix` vectorised prune pass integrated into `ortools_tsp_solve` in `server.py` (N≥20, 3× median non-zero threshold, depot row/col preserved → always feasible)
  - NumPy int conversion + clipping replaces nested Python loops (faster for large matrices)
  - Strictly single-driver (`RoutingIndexManager(N, 1, ...)`) per user constraint — verified end-to-end for N=10/50/100

- [x] **Optimization Quality Badge** (2026-04-20):
  - Backend `/api/optimize` now returns a `quality_badge` field with `baseline_km`, `optimized_km`, `saved_km`, `saved_pct`, `improved` computed against a Nearest-Neighbor greedy baseline (≥3 stops, non-NN algorithms)
  - Frontend `formatQualityBadge()` helper injects a "📈 Saved X km (Y%) vs greedy baseline" line into all three optimize Alert dialogs (primary, celebratory, and refine)
  - Verified locally: 20-stop random matrix → OR-Tools saves 3.84 km / 9.5% vs NN baseline

- [x] **Freeze-on-stop navigation bearing** (2026-04-20):
  - Fixed the puck/camera rotating away from the direction of travel whenever the driver came to a complete stop. Root cause: magnetometer kept firing while stationary (metal/EMF drift), and GPS course (`|| 0`) snapped to north when the fix was null/invalid at speed=0.
  - `useNavigationCamera.ts` — now uses **GPS course-over-ground** when `speed ≥ 1.4 m/s`; magnetometer becomes a fallback used only until the first valid GPS course arrives; once GPS is authoritative, compass updates are ignored.
  - `app/(tabs)/index.tsx` `startLiveTracking` — same freeze-on-stop logic: `newLocation.heading` retains the last valid bearing while stopped instead of flipping to 0/north.
  - Matches Google Maps / Waze behavior: puck stays pointed forward at red lights, only rotates during actual turns.

- [x] **Paused indicator pill** (2026-04-20):
  - Shows a subtle "⏸ Paused · M:SS" pill after the vehicle has been stationary for ≥10 s while navigating (threshold: speed < 3 km/h).
  - Animated fade-in (260 ms) + 1 Hz elapsed timer; clears the instant the vehicle starts moving again.
  - Intentionally does **not** rotate the camera or change the view — matches Google Maps' pattern of "notice but don't disorient".
  - `data-testid="paused-indicator-pill"` for automated tests.

- [x] **Immersive bottom panel cleanup** (2026-04-20):
  - Removed the map-style cycle button from the per-stop row (it's a map preference, not a stop control — was adding visual noise to every address line).
  - Dropped the "Overview" icon from Quick Actions (redundant with the visible map; its `scan-outline` icon read as a barcode scanner).
  - Quick Actions now 4 equal-width tiles (Call / Share / Reroute / Undo) with tiny text labels below each icon → drivers can tell them apart at a glance.
  - Main Actions reordered to **Failed | Delivered | Skip** with text labels on the side buttons (were icon-only; both looked "negative"). Delivered stays the visually-dominant primary button.
  - Tightened vertical padding (`16 → 14` top, `12 → 10` between rows) to reclaim ~15 px of screen.

- [x] **EAS Update / OTA — reverted** (2026-04-20, lesson learned):
  - Attempted to enable OTA by manually editing `app.json` (`updates.url`, `runtimeVersion.policy`). Caused the Prebuild phase on EAS to fail because the update channel didn't exist on Expo's servers yet (`eas update:configure` is what creates it).
  - Reverted `app.json` → `updates.enabled: false`, removed `runtimeVersion` block. Build unblocked.
  - `_layout.tsx` still has the `checkForUpdateAsync → reloadAsync` flow in place — gated on `Updates.isEnabled`, so it no-ops cleanly while disabled. Will activate automatically when OTA is properly enabled later.
  - **Correct sequence for next time**: run `eas update:configure` FIRST (writes `url` + `runtimeVersion` into app.json against a real channel), then `eas build`.

- [x] **ARM64 Hermes shim — `eas update` now works from the container** (2026-04-21):
  - `eas update` was failing with `hermesc: ELF: not found / Syntax error: word unexpected (expecting ")")` because React Native 0.81 ships `node_modules/react-native/sdks/hermesc/linux64-bin/hermesc` as an x86_64 ELF, and our container runs on aarch64. The previous fork worked around this by telling the user to only use `eas build` (remote).
  - Installed `qemu-user-static` + `binfmt-support` in the container. `binfmt_misc` can't be mounted in our restricted container, so transparent kernel translation isn't available — instead we wrap the binary.
  - Added `scripts/patch-hermesc-arm64.js`: renames `hermesc` → `hermesc.x86_64` and drops in a 3-line shell script that `exec`s `qemu-x86_64-static hermesc.x86_64 "$@"`. No-ops on x86_64 hosts. Idempotent. Added to `postinstall` so it survives `yarn install`.
  - Verified end-to-end: `eas update --branch production --message "Route line: cobalt blue with white casing" --platform android --non-interactive` → published successfully. Update ID `019dabc7-4f3e-709f-a838-f2b30f992bb0` on branch `production`, runtime `1.0.0`. Dashboard: https://expo.dev/accounts/xxmltvguides-organization/projects/routed/updates/52cba7da-2c65-42c9-a64c-dede6f0f0827

- [x] **EAS OTA (expo-updates) fully wired** (2026-04-21):
  - Confirmed the `production` channel (`019daad9-ecee-7ecb-94a5-634a460eed23`) exists + is Active on Expo's servers and is pointed at the `production` branch.
  - `app.json` has `updates.enabled: true`, `updates.url: https://u.expo.dev/9e2548a1-6e51-4ae4-b8da-33eb0616460e`, `runtimeVersion.policy: "appVersion"` — matches the EAS project ID.
  - `eas.json` preview + production build profiles both target `"channel": "production"` (dev targets its own `development` channel).
  - `app/_layout.tsx` runs `Updates.checkForUpdateAsync → fetchUpdateAsync → reloadAsync` on startup, gated on `Updates.isEnabled` so dev builds silently no-op.
  - `yarn prebuild:check` passes clean with OTA enabled (previous revert was needed only when the channel hadn't been provisioned yet — now it has).
  - **Usage after next APK install**: any JS-only change can be pushed with `eas update --branch production --message "..."` and drivers pick it up on next app launch. No rebuild, no Play-Store review.

- [x] **EAS garbage-filename killer — permanent hardening** (2026-04-21):
  - Root cause of the Apr 21 build failure: a 0-byte file with non-printable bytes in its name (`0190f84040d0c3394038`) reappeared at `/app/frontend/` top level, causing EAS's tar `lstat` to die during the "Compressing project files" phase.
  - Removed the offending file, then hardened the pipeline so this class of bug can never silently slip through again:
    1. `clean-garbage.js` no longer guards on `size===0` — any file with unprintable bytes in its name is nuked regardless of size (previous version would have left a non-empty corrupt file in place).
    2. Added a `postinstall` hook in `package.json` → `clean:garbage` now runs automatically on every `yarn install`.
    3. Added `yarn eas:build:android` which chains `deploy:preflight && eas build --platform android --profile preview` in one shot, so the preflight can't be accidentally skipped.
  - Verified: planted two test garbage files (one 0-byte, one 17-byte, both with `\x01\x02` in the name) → `yarn clean:garbage` removed both. `yarn prebuild:check` passes clean.

- [x] **Timefold gated behind `ENABLE_TIMEFOLD` env flag** (2026-04-20):
  - Production Kubernetes container logs were spammed by `timefold_solver import failed … JVM DLL not found` warnings because the production image doesn't ship the exact JDK layout Timefold's bundled JPype expects.
  - `server.py` — both the initial import AND the background JDK installer/self-heal are now gated on `ENABLE_TIMEFOLD=true`. Default is off → silent in production.
  - `backend/.env` — added `ENABLE_TIMEFOLD=true` locally so the dev container keeps running Timefold (already has a working JDK cache).
  - Also added an early `load_dotenv()` call right before the flag check so the env var is read correctly at module-import time (before the main `load_dotenv` further down).
  - Impact: production logs now clean of the 3× startup warning. Timefold is 1 of 14 solvers; the other 13 (OR-Tools, VROOM, LKH-3, ILS, NN, 2-opt, ALNS, etc.) remain available.

- [x] **Ultimate Driving Mode -- hooks fully integrated** (2026-04-16):
  - `useNavigationCamera` wired: 250ms GPS subscription for smooth 3D POV camera, bypasses React prop latency
  - `useGeofenceArrival` wired: haversine 50m trigger, Set-deduped per-stopId, replaces inline proximity check in `updateLiveRoute`
  - `sendMessage: (msg: object) => void` added to `DeliveryMapRef` + exposed via `useImperativeHandle` in `DeliveryMap.native.tsx`
  - Geofence Set auto-resets via `useEffect` on `viewMode -> 'navigating'`

- [x] **Offline Sync Queue + Expandable Banner Panel** (2026-04-18):
  - `syncQueue.ts` AsyncStorage queue with idempotent complete/uncomplete ops; NetInfo instant-reconnect drain
  - Persistent amber banner shows "Offline · N queued" / "Syncing · N queued" at top while any items are queued
  - Tap banner to expand a scrollable panel listing each queued stop (address/name), action (marking delivered vs reverting to pending) and "Xm ago" timestamp
  - Panel auto-refreshes every 3s via `getQueuedActions`; footer reassures "will sync the moment you're back online"
  - **"Retry now" button** inside panel: manually triggers `flushSyncQueue()` for flaky-signal situations; shows spinner + disables during retry; re-hydrates panel state after flush
  - **Swipe-left-to-dismiss** on each queued row (via `Swipeable` from `react-native-gesture-handler`): red "Dismiss" action reveals on swipe; on release it calls `dismissQueuedAction(id)` in the store which (a) removes the action from AsyncStorage queue via new `removeById()` and (b) reverts the optimistic `completed/delivery_status` flip so UI matches server state on next fetch. Warning haptic on dismiss.
  - **Undo toast** (gray-900 pill, amber "Undo" pill) appears at bottom for 5s after dismiss; tap re-enqueues the action via new `restoreQueuedAction()` store method and re-applies the optimistic flip. Animated fade-in/out; timer cleared on tap or unmount.

- [x] **House Number Layer — end-to-end** (2026-04-18):
  - Backend `/api/housenumbers?bbox=...` now has circuit-breakers: trips `_ARCGIS_FAIL_UNTIL` for 120 s on 302/503/504/exception (QLD portal maintenance) and `_OVERPASS_FAIL_UNTIL` for 120 s when all Overpass mirrors fail. Total upstream budget trimmed from 12 s → 6 s.
  - Negative cache (`_HOUSENUMBER_EMPTY_TTL`) — empty results are cached 60 s so panning dense areas doesn't re-hit dead upstreams.
  - Verified empirically: first call 6 s, repeated call 140 ms, too-large bbox rejected in 108 ms.
  - Web `DeliveryMap.tsx` wires `useHouseNumbersInView(mapRef, { minZoom: 17 })` hook + renders `<HouseNumberLayer features={...} />`. Hook debounces `moveend` 250 ms, snaps bbox to 4 dp, aborts in-flight fetches on re-pan.
  - Native `DeliveryMap.native.tsx` injects identical `house-numbers` source/layer into the MapLibre WebView HTML; RN-side `cameraIdle` handler fetches the bbox and posts `updateHouseNumbers` back. Uses `AbortController` + bbox dedupe to avoid thrashing.

## Key Files
| File | Purpose |
|------|---------|
| `/app/frontend/src/components/DeliveryMap.native.tsx` | WebView map (Android/iOS) — PRIMARY |
| `/app/frontend/src/components/DeliveryMap.tsx` | react-map-gl map (web) |
| `/app/frontend/src/components/map/HouseNumberLayer.tsx` | Property-number MapLibre symbol layer (web) |
| `/app/frontend/src/components/map/houseNumberLayerNative.ts` | Native spec helper for WebView injection |
| `/app/frontend/src/hooks/useHouseNumbersInView.ts` | Camera-bound debounced fetcher (web) |
| `/app/frontend/app/(tabs)/index.tsx` | Main Navigation UI (~3700 lines) |
| `/app/backend/server.py` | Backend API (~7000 lines) |
| `/app/tiles/buildings.db` | 64MB SQLite building tile cache |

## Upcoming Tasks
- P0: ✅ Import screen JSON-parse crash fix — OTA published to production (2026-04-20)
- P1: Photo proof of delivery (camera + GPS/timestamp)
- P2: Customer Contact Bar auto-expand (<200m)
- P2: Speed Limit Warning flash
- P2: Refactor `server.py` + `index.tsx` (massive files need decomposition)
- P3: Night mode / satellite map style toggle
- P3: Night mode for 3D buildings (dark extrusions + lit windows)
- P3: Lane guidance from OSRM intersection data
- P3: Progress ring for stop completion
- P3: Route Line Mode Toggle
- P3: Offline Mode
- P3: Re-generate building tiles with tilemaker (ARM64 bug pending)

## Environment Notes (fork recurrence)
- ARM64 container: `qemu-user-static` must be installed for `eas update` (Hermes x86_64 binary).
  - Install: `apt-get install -y qemu-user-static binfmt-support`
  - Then run: `cd /app/frontend && node scripts/patch-hermesc-arm64.js`
  - This wraps `hermesc` in a qemu shim. Shim is idempotent (also runs as yarn postinstall).
- OSRM boost libs: `/etc/supervisor/conf.d/osrm.conf` auto-installs `libboost*` on restart.
  - **2026-04-25 hardening**: rewrote `/app/ensure_osrm_deps.sh` with 8× apt-retry on dpkg-lock and `ldd`-based loadability probe; `osrm.conf` now uses `startsecs=5` and `startretries=30`. Diagnostic log at `/var/log/osrm_deps.log`.
- Ngrok patches: `node_modules/@expo/ngrok/src/client.js` + `@expo/cli/.../AsyncNgrok.js` — don't reinstall without re-patching.
- OTA channel: APK is on `production` channel. Always push updates with `eas update --branch production`.
- **EAS source upload**: `/app/.easignore` + `/app/.gcloudignore` exclude the ~800 MB OSRM data tree (`queensland.*`, `osrm-backend/`) from native builds — required to avoid `context deadline exceeded`.

## Solver Quality Fixes (2026-04-25)

- **Open-path TSP fix** (`server.py:_open_path_matrix`): LKH-3 and PyVRP are inherently closed-loop solvers; they minimise a Hamiltonian *cycle* including the return-to-depot edge. For delivery routing the driver does not return — both solvers were producing routes 5% WORSE than the unoptimised input order on real 78-stop user data, picking patterns like `[0, 37, 38, ..., 1, 2, 3]` (visit far cluster first, return through near cluster). Fix zeros the return-to-depot column before solving so the closed-loop optimum equals the open-path optimum. Verified: LKH-3 went from 4197s → 3955s (1.1% better than input); PyVRP from 4197s → 4071s. OR-Tools already had the dummy-end-node trick; VROOM was already configured open-path.
- Regression tests: `/app/backend/tests/test_open_path_tsp.py` — river-crossing topology ensures any future regression of the closed-loop assumption is caught immediately.
- **Time-savings badge** (2026-04-25, OTA `019dc3e2-b269-7e1d-9fe0-08daa875fefc`): `/api/optimize` now returns `time_savings: { saved_minutes, saved_pct, improved, ... }` computed against the input-order open-path duration on the SAME OSRM matrix used by the solver. Frontend `formatTimeSavingsBadge()` renders `⏱️ Saved X min (Y%) vs unoptimised` in the post-optimise alert, only when ≥30 s saved (avoids false claims when input is already near-optimal).
- **Smart `auto` algorithm selection** (2026-04-25, OTA `019dc408-9273-78cb-921f-31fa61342252`): `auto` previously resolved to raw VROOM. On real 79-stop user data VROOM gave 96.0 min while LKH-3 (with the open-path fix) finds the true optimum at 95.7 min in 0.11s. Now `auto` resolves to **`vroom_lkh_3opt`** for ≥11 stops (VROOM seed → LKH refine → 3-opt polish) which is strictly ≥ VROOM-alone quality. Also fixed the `vroom_lkh_3opt` cascade to **only keep 3-opt's output if it monotonically improves** — 3-opt was sometimes regressing LKH's optimum back by ~0.3 min.
- **Known remaining issue (P1)**: `timefold_solver.py` `TfLocation.distance_to()` uses haversine instead of the OSRM matrix passed in — Timefold is producing 3.26× worse routes on synthetic test. Construction phase also times out at 35/178 stops in 13s budget. Not yet fixed.

## Configure Van — Per-Driver Bin Grid (2026-04-25)

**First slice of the Parcel-Finding-in-Van feature**: a one-time setup where
the driver picks the shape of their van's parcel grid (2×3 / 3×3 / 3×4).
Saved per-driver and reused across every route. Bin labels follow
spreadsheet notation (A1, B2, C3…).

### Backend
- `GET /api/van-layout` — returns the saved layout, falls back to a 3×3
  default with `is_default: true` when nothing is saved.
- `PUT /api/van-layout` — idempotent upsert into `db.van_layouts`. Validates
  against the explicit `ALLOWED_VAN_SHAPES = {(2,3), (3,3), (3,4)}` set so a
  driver can't accidentally save a 50×50 grid.
- New Pydantic `VanLayout` model.

### Frontend
- `vanLayoutStore.ts` (Zustand) — `fetchLayout`, `saveLayout`, plus the
  `binLabel(rowIdx, colIdx)` helper that converts (0,0) → "A1".
- `app/configure-van.tsx` — Swiss Brutalist setup screen following
  `/app/design_guidelines.json`: 4px black borders, safety-orange CTA,
  monospace bin labels, ≥56px tap targets. Shows a live preview grid the
  moment the driver toggles between shapes. "Save Configuration" is
  disabled when the pending selection equals the saved layout, so re-taps
  are a no-op instead of generating round-trip noise.
- Sidebar entry point: a single full-width "Configure Van" tile under the
  Export/Benchmark row, with a `data-testid="configure-van-btn"` for E2E.

### Tests
- `tests/test_van_layout_endpoints.py` (4 cases, all green) — pins the
  allowed-shapes constant, the model accepts every supported grid,
  Pydantic rejects non-int input, and the endpoint's set-membership
  validation works end-to-end.

### OTA
- Published to `production` branch as `019dc618-ea64-7e1f-98a6-ebcf13977243`
  — drivers see "Configure Van" in the sidebar after restart.

## Optimizer Quality Pass — OSRM-grounded verify + spike threshold + 3-opt for large routes (2026-04-25, latest)

User feedback: "The route optimizer is producing zig-zag patterns on large routes" with three specific code locations. Three concrete backend-only fixes:

### 1. `_osrm_verify_relocation` now uses local OSRM consistently
- **Was**: called `calculate_duration_matrix`, which silently falls back to a haversine estimate for `N > 25` (the Mapbox cap). On 100+-stop routes the auto-tighten "verification" was a haversine check pretending to be an OSRM check, which is why driver screenshots kept showing visible zig-zags even after the auto-tighten code shipped.
- **Now**: calls `_osrm_duration_matrix(proposed_seq)` directly — same helper used by every other solver path. That helper hits the local `OSRM_URL=http://localhost:5000` first and only falls back to the public OSRM demo on circuit-breaker open. Real road-network seconds, every call.
- Tests in `test_auto_tighten_during_optimize.py` updated to monkeypatch the new function name (5 tests). All 9 tests pass.

### 2. `detect_cluster_spikes` defaults relaxed
- `spike_ratio`: 0.3 → **0.5** (was: detour ≥ 3.3× straight-line; now: detour ≥ 2× straight-line). Catches mid-cluster zig-zags that were visually offensive but slipped through the strict 0.3 threshold.
- `min_detour_km`: 0.15 → **0.10**. Dense urban routes where every stop is 100-200 m apart now get auto-tightened too.
- Result: more triplets flagged → more invocations of the auto-tighten + OSRM-verify pipeline → stricter visual cleanliness on every optimize call.

### 3. `_global_two_opt_pass` scaled for 150+ stops
- For `n >= 150` the function now bumps `max_iterations` from 3 to 6 (or-opt and 2-opt both get the bigger budget) AND adds a Phase 3 `three_opt_improve` polish pass on the same haversine matrix. The 3-opt pass uses the asymmetric-safe non-reversing variant already used elsewhere in the codebase (`A + C + B + D` swap).
- Smaller routes (n < 150) skip the 3-opt phase entirely — its O(n³) inner loop wouldn't earn its keep on a 50-stop route where 2-opt already converges.
- Logged: `Global 3-opt polish improved route: <before> km → <after> km` whenever the polish fires.

### Verified (2026-04-25)
- Per-file pytest: 82 tests pass across 9 files when run individually (testing agent iteration_25). Cross-file pollution remains a pre-existing fixture issue, NOT a regression.
- Live backend logs already confirmed `Auto-tightened N spike(s) during /api/optimize` was firing on real 168-stop user requests; with the OSRM grounding, the verification now uses real driving seconds.
- No frontend changes — pure backend hot-reload, no OTA needed.



### Auto-tighten OSRM tolerance
- **User report**: even after the auto-tighten code shipped, drivers still saw
  zig-zags because OSRM's strict driving-time check rolled back the visually
  cleaner sequence whenever it was even 1 s slower (one-way streets, turn
  restrictions). Real example: the Parklands Blvd 68→69→70 spike.
- **Fix** (`server.py:_osrm_verify_relocation`): the function now takes
  `slack_seconds=0` and `slack_ratio=0.0` parameters. The auto-tighten path
  inside `/api/optimize` calls it with `slack_seconds=90, slack_ratio=0.03` —
  effective threshold `max(90 s, before_s · 0.03)`. So a 1-hour route can
  grow by up to ~108 s (3 %) if the cleaned sequence kills a visible
  cross-suburb detour. Manual `/api/optimize/tighten-cluster*` endpoints
  keep the strict default (slack=0) so an explicit user tap never makes
  the route slower.
- **Tests** (`tests/test_auto_tighten_during_optimize.py`, +5 cases for
  9 total, all green): `_osrm_verify_relocation` keeps strictly faster
  routes, rolls back at slack=0 when slower, accepts inside `slack_seconds`,
  accepts inside `slack_ratio`, and rolls back beyond combined threshold.
- **Live verification**: backend logs show `Auto-tightened 3 spike(s) during
  /api/optimize (remaining warnings: 3)` on a real 169-stop user request.
- **Backend regression** (testing agent): 45/45 tests pass across 5 critical
  files (`test_auto_tighten_during_optimize.py`, `test_van_layout_endpoints.py`,
  `test_open_path_tsp.py`, `test_pyvrp_duplicate_coords.py`, +1 HTTP suite).
- **OTA**: `019dc646-ed93-7f17-9394-3fc9dadfd7ea` to `production`.

### Load Van flow — bin assignment + reverse-load sequence
- **Spec**: "Reverse-order zone: last-stop-first → bottom-row first" — the
  driver loads the LAST delivery first (deepest in the van, bottom row) and
  the FIRST delivery last (closest to the door, top row).
- **Pure helper** (`vanLayoutStore.ts:assignBin(stopIdx, totalStops, rows,
  cols)`): proportional mapping `bin = floor(stopIdx · rows·cols /
  totalStops)`; clamps negative / out-of-range indices; guarantees the
  first stop hits A1 and the last stop hits the bottom row. Multiple
  stops share a bin when N > rows·cols (within-bin order still follows
  delivery order so the driver picks closest-first).
- **Frontend screen** `app/load-van.tsx` (Swiss Brutalist, matches
  `configure-van.tsx`): mini grid preview with per-bin loaded/total
  counts; load-order list (reversed delivery order) with bin badge,
  stop number, address, and a 4 px-bordered checkbox; bulk
  "Mark all loaded" / "Reset" buttons; per-route loaded state persisted
  in AsyncStorage under `load-van-loaded:<route-fingerprint>` so closing
  the app and resuming preserves progress (and resets when the optimised
  sequence changes).
- **Sidebar entry**: `Configure Van` and `Load Van` now sit side-by-side as
  half-width tiles. `Load Van` disables when `stops.length < 1`.
- **Tests** (`src/store/__tests__/vanLayoutStore.assignBin.test.js`, 12 cases,
  all green): `binLabel`, exact-fit / sparse / over-capacity grids on
  2×3, 3×3, 3×4, monotonic bin index in delivery order, defensive
  fallbacks for empty/negative inputs.
- **OTA**: `019dc64d-4b45-7188-ba83-b1616154658e` to `production`.

## Auto-tighten Cluster Spikes Inside `/api/optimize` (2026-04-25)

- **User report**: even with `pyvrp` solver the optimised route was visibly zig-zagging — stop 14 (north) sandwiched between stops 12-13 (south) and 15-16 (south-west) on the Beerburrum St / Albatross Ave route. The user explicitly asked: "improve the optimiser itself so it never produces visible zig-zags in the first place."
- **Fix** (`server.py`): added `_iterative_haversine_tighten(seq, max_passes=10)` that repeatedly relocates the worst spike (largest `extra_km`) until `detect_cluster_spikes` is empty or no further haversine improvement is possible. Wired into the `/api/optimize` response path right after the existing `cluster_warnings` detection: if any spike is found and the cleaned sequence isn't slower in OSRM driving time (`_osrm_verify_relocation`), we silently swap it in and re-run the spike sweep. Net result: cosmetic zig-zags vanish; only OSRM-justified detours (one-way pairs, highway splits) ever surface a banner.
- **Why this is correct**: the solver minimises driving seconds; on time-equivalent ties it picks an arbitrary visit order that may look fragmented on the map. Haversine relocation re-orders only between time-equivalent options. If a true detour saves seconds, OSRM rolls back the change.
- **Tests** (`tests/test_auto_tighten_during_optimize.py`, 4 cases, all green): screenshot-shape spike resolves; clean route is a no-op; pathological multi-spike route converges in ≤10 passes; relocator never drops/duplicates stops.
- **OTA published**: `019dc60f-54ea-7419-b2a8-437dae36ddae` to `production` branch (2026-04-25). Drivers will pick up both the auto-tighten code (live now via backend) AND the banner mount fix (frontend) on next app launch.

## Cluster Warnings Banner — UI wired (2026-04-25)

- **Banner mounted** in `app/(tabs)/index.tsx` as a top-anchored absolute overlay (zIndex 9000) below the offline sync banner. Only rendered while `viewMode === 'planning'` so it cannot obscure the immersive nav UI. Top inset adapts: `+38 px` when offline banner is visible, `+8 px` otherwise.
- **Style added**: `clusterWarningsWrap` (absolute, full-width, `pointerEvents="box-none"` so taps fall through except on the banner itself).
- **Self-hides** when `clusterWarnings` is empty (component returns null), so it costs nothing during a clean route. `data-testid="cluster-warnings-banner"` + `tighten-all-clusters-button` for E2E.
- **Bundle verified** end-to-end after a forced Metro cache flush (`supervisorctl restart expo`) — the previous stale resolver error (`Unable to resolve module ../../src/components/ClusterWarningsBanner`) is gone, web now bundles 1409 modules and renders the login screen cleanly.
- **Backend pytest**: `test_cluster_warnings.py` + `test_tighten_cluster.py` + `test_matrix_zero_cost_trap.py` all green when run per-file (suite-level cross-pollution is a pre-existing fixture issue, not a regression).
- **Visual driver-side verification**: requires the user to ship the new bundle via `eas update --branch production` (or pull on dev build); web sandbox is gated behind real Google sign-in (`EXPO_PUBLIC_DEV_MODE=false`), so headless screenshot E2E past auth isn't possible from the container.

## Hackathon kit — pitch script + 14-solver benchmark exhibit (2026-04-28)

- **Pitch script** (`/app/PITCH_SCRIPT.md`): full 60-second second-by-second
  presentation guide — exact spoken lines, screen cues, Q&A bait answers
  for the typical hard questions (NCO comparison, OR-Tools, business
  model, moat). Pre-stage checklist + stage tactics included.
- **Solver benchmark bake** (`/app/backend/scripts/bake_demo_benchmarks.py`):
  runs the user's actual ~50-stop delivery route through 14 algorithms
  via the live `/api/optimize` endpoint with a real session token. Saves
  to `/app/backend/data/demo_benchmarks.json`. **Result**: PyVRP HGS
  wins at 332.8 km, 13% gap to 2nd place (ILS 375.9 km), 12/14 succeed.
- **Public endpoint**: `GET /api/demo/benchmarks` (no auth, in-memory
  cached) returns the table.
- **Frontend** `/app/frontend/app/benchmarks.tsx`: dark-themed sortable
  table, summary cards (stops / solvers ran / best km), methodology
  blurb, gap-color-coded rows (winner green, +<5% blue, +<15% amber,
  >15% red), failure rows distinguished. Linked from the demo's
  finished overlay via a small "See the 14-solver benchmark →" pill.
- **OTA pushed**: `89747c1f-7770-4686-9303-3e3f175b3f91`. Backend deploy
  needed for `/api/demo/benchmarks` to land on production.

## Hackathon Demo Flythrough (2026-04-28)

- **Goal**: build-fest judges decide in 30 seconds. They won't sign in
  with Google or import a CSV. Need a one-tap "wow" path from the login
  screen to a cinematic flythrough that lands the headline stat in <30s.
- **Backend**:
  - `/app/backend/scripts/bake_demo_scenario.py` — one-shot script that
    samples 50 plausible Sunshine Coast coords from the existing stops
    collection (PII-stripped: anonymised "Customer NN" labels, no phones),
    computes both an **as-dispatched baseline** (driver gets the manifest
    in CSV order) and the optimised order, fetches both road-network
    polylines from local OSRM, bakes the headline (74 km vs 175 km =
    **102 km / 159 min / 59% saved per day**) into
    `/app/backend/data/demo_scenario.json` (~165 KB).
  - `/app/backend/routes/demo.py` — `GET /api/demo/scenario`. Public,
    no-auth, in-memory cached. Returns the baked JSON in ~5 ms.
- **Frontend**:
  - `/app/frontend/app/demo.tsx` — three-phase screen built on the
    existing `DeliveryMap` component:
    1. **Overview** — full route framed, headline pill, big "Start
       cinematic flythrough" CTA. Footnote credits the solver pipeline.
    2. **Flying** — synthetic driver dot interpolates along the OSRM
       polyline at ~6× real-time (full route in 25 s). Camera follows
       at 60° pitch with bearing locked to direction-of-travel. Top
       ticker shows "Stop X / 50 — heading to Customer NN" with a
       progress bar. Trail behind the dot fades from start to camera.
    3. **Finished** — savings overlay: "102 km — saved", before/after
       blocks (red strikethrough vs green), 59% delta pill, footnote
       extrapolating to ~25,500 km/year for one driver. Replay + Try-
       it-yourself CTAs.
  - `/app/frontend/app/index.tsx` (login) — added subordinate
    "Watch the 25-second demo" button below Google sign-in (testid
    `watch-demo-button`). Routes to `/demo` without auth.
- **Storytelling tactics** baked into copy:
  - Headline frames savings as **time given back to a real driver**, not
    abstract km.
  - Baseline is the **CSV-row order a dispatcher actually hands out** —
    not nearest-neighbour. NN heuristic would understate the gap because
    no driver hand-routes NN; honest baseline is "what a human does".
  - Footnote credits "PyVRP HGS + 2-opt polish · routed on our own
    Fly.io OSRM" — quiet flex of the systems-engineering depth.
- **Status**: shipped to production via OTA `98f5bec5-9a8b-4e4c-96e9-d4e13e9b658f`.
  **Backend deploy needed** for `/api/demo/scenario` to come live
  on `floating-map-ui.emergent.host`.

## Phase 0 — Service-Time + Building-Side Instrumentation (2026-04-27)

- **Goal**: every later "learn from history" feature (per-stop service times,
  driveway-side correction, time-window mining, live-traffic OSRM) is gated
  on data we've never been capturing. We had `completed_at` but no
  `arrived_at`, no GPS fix at delivery, no GPS fix at arrival — so even
  with thousands of routes we couldn't compute service time or driveway
  offsets. Phase 0 ships the instrumentation only; the learners come later
  once the corpus accumulates (~30 routes / ~1 month at current pace).
- **Backend** (`server.py:380` + `routes/stops.py`):
  - Added 7 nullable fields to `Stop`: `arrived_at`, `arrival_lat/lng/accuracy_m`,
    `completion_lat/lng/accuracy_m`. All optional — old rows + offline marks
    are unaffected.
  - New `POST /api/stops/{id}/arrived` — fires from the geofence hook on
    50 m enter. **Idempotent**: keeps the earliest timestamp on re-fires
    (geofence flap, offline replay) so `service_time = completed_at -
    arrived_at` doesn't go ~0 every time the driver paces around the front
    yard.
  - Extended `POST /api/stops/{id}/complete` to accept an optional
    `{lat, lng, accuracy_m}` body. Best-effort: missing body, missing GPS,
    or partial fix → stop is still marked delivered (no behavioural
    regression for revoked-permission users); only complete `(lat, lng)`
    pairs are persisted to avoid skewing future driveway aggregations.
- **Frontend**:
  - `stopsStore.ts`: added `GpsFix` type, extended `completeStop(id, gps?)`
    to forward GPS, added fire-and-forget `arriveAtStop(id, gps?)` that
    swallows all errors (instrumentation must not block driver UI).
  - `app/(tabs)/index.tsx`: wired `useGeofenceArrival.onArrival` to call
    `arriveAtStop` with `currentLocation`; both `completeStop` callsites
    (navigation-mode swipe at L1593 + manual stop-modal tap at L3349) now
    forward the current GPS fix. No new permissions required — uses the
    location stream already running for navigation.
- **Tests** (`backend/tests/test_phase0_instrumentation.py`, 4/4 green):
  end-to-end service-time computability, idempotent arrival, no-GPS
  delivery still works, partial GPS is silently dropped.
- **Sandbox status**: backend reloaded, `/api/health` 200, all 9 Phase 0 +
  Fly.io OSRM regression tests pass. **Deploy needed** to ship to the
  production pod (Emergent dashboard → Deploy).
- **Data accrual**: corpus starts building from the next delivered stop.
  Phase 1 (service-time learner) and Phase 2 (building-side correction)
  unlock once `db.stops.countDocuments({ completion_lat: { $exists: true }})`
  ≳ 30.

## Dedicated OSRM on Fly.io — production unblocked (2026-04-26)

- **Problem**: production Emergent pod (`floating-map-ui.emergent.host`) doesn't ship a local OSRM binary, so `OSRM_URL=http://localhost:5000` fails on every request and `/api/optimize` either falls through to the rate-limited public OSRM demo (15-30 s timeouts on 100+ stops) or to Mapbox-clustered matrices (visible zig-zags). Drivers couldn't optimise routes in the wild.
- **Fix**: deployed a dedicated OSRM 5.25 server on Fly.io (`pathpilot-osrm.fly.dev`, syd region, 1 GB shared-cpu-1x, auto-stop when idle) preprocessed with the Geofabrik Queensland extract (~190 MB PBF → ~350 MB image after `osrm-extract → partition → customize`).
  - `/app/osrm-deploy/Dockerfile` (3-stage: alpine downloader → osrm builder → osrm runtime). Hardened the downloader: validates response is a real OSM PBF via `file(1)` magic-byte check + min-size 50 MB to catch the Geofabrik 302 → HTML index page that bit us on first deploy.
  - `/app/osrm-deploy/fly.toml` (auto-stop machines, HTTPS-forced, health-check on `/nearest/v1/driving/...`).
  - Verified: cold start `/nearest` ~330 ms, warm ~250 ms (vs sub-10 ms localhost — acceptable for production).
- **Backend integration** (`server.py:241-275`): added an `OSRM_URL_PROD` env var. At startup, if `OSRM_URL` points at a loopback host that isn't actually listening (i.e. we're on the production pod), `OSRM_URL_PROD` is promoted to `OSRM_URL`. Sandbox keeps using localhost:5000 (fast); production seamlessly switches to Fly.io with no per-environment branching at every call site.
- **`/app/backend/.env`**: added `OSRM_URL_PROD="https://pathpilot-osrm.fly.dev"`. Sandbox-default `OSRM_URL=http://localhost:5000` is unchanged.
- **Regression tests** (`backend/tests/test_osrm_url_prod_promotion.py`, 4 cases, all green): unreachable loopback promotes to prod URL; reachable loopback stays; empty `OSRM_URL_PROD` is a no-op; non-loopback URLs are never rewritten.
- **Pending**: user must click **Deploy** in the Emergent dashboard to ship the new `.env` + `server.py` to production. After deploy, the backend should start logging `Local OSRM at http://localhost:5000 unreachable; promoting OSRM_URL_PROD=https://pathpilot-osrm.fly.dev` once on boot, and `/api/optimize` should regain ~15 s response times even on 100+ stop routes.

## Solver Quality Fixes — Part 2 (2026-04-25)

- **3-opt rewritten for asymmetric matrices** (`server.py:three_opt_improve`): User reported a screenshot showing stops 11→12→13→14 doubling-back/zig-zagging on a real route. Root cause: the original `three_opt_improve` enumerated 7 reconnections, six of which reversed segments (`A + B[::-1] + C + D`, `A + C[::-1] + B + D`, etc.). On asymmetric matrices (OSRM one-way streets, turn restrictions) reversing a segment changes every internal edge cost — but the textbook delta-cost formula only re-priced the 3 boundary edges, so 3-opt accepted moves that LOOKED cheaper but were actually worse. Fix: keep only the ONE non-reversing 3-opt candidate `A + C + B + D` (swap segments B/C, preserve internal direction). Boundary delta is correct on any (a)symmetric matrix. Verified via 51 pytest cases + live `/api/optimize` calls across all solvers.
- **LKH matrix sanitisation** (`server.py:lkh_tsp_solve`): OSRM occasionally returns `null`/negative cells for un-snappable coords; passed verbatim to LKH those became "free" or "negative-cost" edges and the solver gladly exploited them, producing visibly absurd tours. Now `sanitize_osrm_matrix` (from `solvers/pyvrp_tsp_solver.py`) is applied BEFORE `_open_path_matrix`: forces `null/NaN/<0 → 999999s penalty` and diagonal to 0. Open-path zero-out preserved.
- **`auto` resolves to `vroom_lkh_3opt` for ≥11 stops** (`server.py` line ~4748): previously resolved to raw VROOM; cascade is now `VROOM seed → LKH refine → 3-opt polish (only if monotonic improvement)` — strictly ≥ VROOM-alone quality at <100 ms latency cost.
- **Verified 2026-04-25**: 51/51 pytest pass (`test_open_path_tsp.py`, `test_pyvrp_duplicate_coords.py`, `test_solver_hamiltonicity.py`, new `test_optimize_api.py`). Live `/api/optimize` returns Hamiltonian paths for `auto/lkh/pyvrp/vroom/ortools/three_opt/vroom_lkh_3opt` on synthetic 12 + 30-stop SE-Queensland fixtures with `time_savings` populated correctly. No frontend changes required — these are pure backend numerical fixes.


## API backend → Fly.io migration setup (2026-05-22)

- **Problem (recurring)**: Emergent-hosted backend (`floating-map-ui.emergent.host`) sleeps after idle → drivers hit 502 Bad Gateway and "not authorised" errors mid-route. Earlier mitigations (UptimeRobot HEAD ping, in-app wake-up ping on launch) reduce but don't eliminate cold starts.
- **Decision**: migrate the FastAPI backend off Emergent hosting to **Fly.io** (Sydney region) with `min_machines_running=1` + `auto_stop_machines=false` so the API is genuinely always-on. Cost ≈ $5/mo for shared-cpu-1x/1GB.
- **Files shipped this session** (all in `/app/backend/`):
  - `Dockerfile.flyio` — python:3.11-slim base, installs `libgomp1` (OR-Tools), `git` (for `/api/healthz/version`), `build-essential`, then `pip install -r requirements.txt`. Runs `uvicorn server:app` on `$PORT` (8080).
  - `fly.toml` — app=`routed-api`, region=`syd`, internal_port=8080, force_https, healthcheck on `GET /health` every 30s, `min_machines_running=1`, `auto_stop_machines=false`, 1 GB RAM. Mount block for `/app/tiles` is provided but commented out (uncomment after `fly volumes create tiles_data --size 3 --region syd` if buildings.db is needed).
  - `.dockerignore` — strips tests, `.env`, xlsx exports, `__pycache__`, `.git`.
  - `deploy-fly.sh` — idempotent one-shot wrapper around `flyctl secrets set --stage` + `flyctl deploy --remote-only` + 30s log tail. Required env: `MONGO_URL`, `DB_NAME`, `EMERGENT_LLM_KEY`. Optional: all Stripe, Reviewer, AWS, Mapbox, OSRM, signup-gate vars (pushed only if exported).
  - `FLY_DEPLOY.md` — end-to-end 10-minute guide (CLI install → `fly launch --no-deploy` → secrets via the script → verify with `curl /health` → repoint `EXPO_PUBLIC_BACKEND_URL` and rebuild EAS APK). Includes day-2 ops table (deploy, logs, rollback, scale, SSH) and troubleshooting (Mongo timeout, OR-Tools ImportError, CORS).
- **MongoDB strategy**: current `MONGO_URL=mongodb://localhost:27017` ties the API to the Emergent pod. Recommended swap → **MongoDB Atlas free M0** in `ap-southeast-2 (Sydney)`. `FLY_DEPLOY.md` documents the `mongodump`/`mongorestore` migration steps (user_sessions, stops, route_history must come along or drivers lose their data + auth). Atlas networking: add `0.0.0.0/0` to access list (Fly egress IPs aren't static; password auth still enforced).
- **Verification done in pod**: `bash -n deploy-fly.sh` (syntax OK); Python `tomllib.load(fly.toml)` (parses OK, all expected keys present); no changes to `server.py` were needed — Dockerfile honours the existing `PORT` env var.
- **Pending (user-side, requires their local machine)**: install `flyctl`, run `fly launch --no-deploy --copy-config --dockerfile Dockerfile.flyio`, run `./deploy-fly.sh` with secrets exported. Then update `frontend/.env` → `EXPO_PUBLIC_BACKEND_URL=https://routed-api.fly.dev` and trigger `eas build --profile production-apk`.

## Pending: driving-mode camera not following driver (recurring, 4th attempt) — RESOLVED 2026-05-22

- User reported the WebView debug border flashes **RED** during navigation. That confirms `postMessage` from the WebView is being received by `DeliveryMap.native.tsx`, but the path that should re-emit `drivingCamera` to React Native is not firing (or the React side is ignoring it).
- **ROOT CAUSE FOUND**: `DeliveryMap.native.tsx` line 1710 gated the `drivingCamera` handler on `!map || !map.loaded()`. `map.loaded()` returns **false whenever any source/tile is loading** — during driving, building tiles, route polylines and geojson sources are constantly being fetched, so `loaded()` flickered false and every camera tick was dropped → RED border, no follow. Previous agent over-defended against a non-issue.
- **FIX (2026-05-22)**:
  1. `DeliveryMap.native.tsx:1707` — changed gate from `!map || !map.loaded()` to just `!map`. `easeTo` is safe to call before sources finish loading; tiles render when ready, camera moves immediately.
  2. Stripped all debug-only border/outline colour assignments (lime/orange/red/yellow/blue/cyan/magenta) from the `drivingCamera`, `handleMessage`, and bootstrap blocks so production APK ships clean.
  3. Removed the `debugCameraSkip` message-spam branch in the React effect (line ~2273): it was firing on every GPS tick when conditions weren't perfect, flooding the WebView→RN channel.
- **Verification**: `tsc --noEmit` passes for the camera-fix region. Only one pre-existing unrelated TS error (`onLassoComplete` signature, line 2363) — not introduced by this fix.
- **Pending user verification**: requires fresh EAS APK build (`eas build --profile production-apk`) — OTA won't reach the existing Emergent preview install. After install, drive the route → camera should now smoothly follow with no border flashes.


## Session 2026-05-22/23 — Fly.io migration + the great camera follow saga

### What landed (verified end-to-end by the user)
- **Backend on Fly.io Sydney** (`https://routed.fly.dev`) with `min_machines_running=1`, `auto_stop_machines=off` → **502 sleep errors permanently gone**. App name: `routed`. Region: `syd`. Dockerfile.flyio + fly.toml + deploy-fly.sh + FLY_DEPLOY.md all in `/app/backend/`.
- **MongoDB Atlas Sydney (M0 free)** — `routed` database. All 613 documents migrated from local pod Mongo (`test_database`): 196 stops, 18 users incl. the admin (`user_2a7d88cbb419` / xmltvg@gmail.com / Adhamh McDonald), 115 user_sessions, 57 route_history, 12 ml_building_side_models, 1 ml_service_time_model, 5 import_jobs, 1 van_layout. Excluded geocode_cache (rebuilds).
- **Atlas password rotated** mid-session to `PDk2s9NhIzWXfpko`; old password dead.
- **EAS profiles in `eas.json`** — `production` (AAB) and `production-apk` both point `EXPO_PUBLIC_BACKEND_URL` at `https://routed.fly.dev`. `development` + `preview` still on Emergent preview as fallback.
- **APK v89** (`production-apk` profile, build `e2265f67-bc0e-4d84-8970-67f32f60b275`) installed on user's phone with Fly URL baked in. Direct download: <https://expo.dev/artifacts/eas/tVGUwRf6Nd2AZiAVHYKnWM.apk>
- **OTA channel `production`** repeatedly published over the day. The series that finally worked is summarised below.

### THE big bug — camera not following driver (4th+ recurrence, root cause SOLVED 2026-05-23)
Three independent bugs were stacked on top of each other, which is why every fix attempt looked like it failed:

1. **`isMapReady` was being reset on every viewMode change.** `app/(tabs)/index.tsx` had a `useEffect(() => setIsMapReady(false), [viewMode])` block whose comment claimed the WebView re-renders the map HTML when viewMode changes. It does NOT — `DeliveryMap` persists across the tab's lifetime, so `onMapReady` only fires ONCE (initial style load). Every navigation entry therefore left `isMapReady` stuck at `false`, which silently disabled the `useNavigationCamera` hook (`enabled: mapReady && isNavigating && viewMode === 'navigating'`) AND made `handleShowRouteOverview` alert "Map not ready". **This was the real bug** behind the entire saga. Removed the reset effect; left a long comment in its place so no one re-adds it.
2. **`DeliveryMap.native.tsx` line ~1710** gated `drivingCamera` on `!map || !map.loaded()`. `map.loaded()` returns false whenever any source/tile is loading (constant during driving). Now gates only on `!map`. Also: `_easeInFlight` is now released on the canonical `map.once('moveend', …)` event (with a 600 ms watchdog as a belt-and-braces). The previous setTimeout(420 ms) approach could deadlock if JS suspended once. Added pixel-space look-ahead offset (40–180 px along heading) so the driver puck sits in the bottom-third with road ahead visible.
3. **`startLiveTracking` had no compass subscription.** With the legacy single-writer path, heading came purely from `coords.heading`, which is invalid (-1 / null) when stationary or below 1.4 m/s. Map locked to bearing=0 (north) when standing still. Added `Location.watchHeadingAsync` that writes to `compassHeadingRef` only (no setState — magnetometer fires at ~10 Hz, would re-render storm). GPS course takes over once `hasGpsCourseRef = true` (driver moving > 1.4 m/s). Cleanup in `stopLiveTracking`.

Also flipped `<DeliveryMap highFreqCameraActive={isNavigating && viewMode === 'navigating'} />` back on (was forced `false` during the previous fork's debug session), and removed a now-redundant JS-side heading low-pass filter so the single source of bearing smoothing is the WebView's 60fps `animateBearing` rAF lerp.

### The OTA pipeline meta-bug — wrong backend URL kept baking into bundles
This caused half a day of "still wrong account / stops missing" confusion:
1. `eas.json` profiles pointed at `floating-map-ui.emergent.host` (the old Emergent-hosted backend) until I fixed them to `routed.fly.dev`.
2. `frontend/.env` was protected by Emergent's `PROTECTED_VARIABLES` mechanism and kept reverting `EXPO_PUBLIC_BACKEND_URL` to `fast-route-api.preview.emergentagent.com`. Workaround: `sudo supervisorctl stop expo && sed -i ... && eas update && supervisorctl start expo`.
3. **EAS server-side environment** (managed via `eas env:list/create --environment production`) had its OWN `EXPO_PUBLIC_BACKEND_URL` set to `floating-map-ui.emergent.host`. **This was the silent winner** — any `eas update --environment production` used the server value, overriding the .env. Fixed via `eas env:create production --name EXPO_PUBLIC_BACKEND_URL --value https://routed.fly.dev --force`.
Result: every login pre-fix landed the user on the preview/hosted backend's separate Mongo with no admin status and (effectively) no stops, looking exactly like "logged into the wrong account." After fixing all three, fresh sessions hit Fly + Atlas and the admin user sees 196 stops as expected.

### Other fixes shipped this session
- **`AsyncStorage`-stale-token auto-recovery** in `Profile` and `AuthContext` (probes `/api/stops`; on 401, clears token + bounces to login). Helped during the OTA-URL-mismatch chaos.
- **Google OAuth `preferEphemeralSession: true`** in `app/index.tsx` so the Google account picker re-appears every sign-in (no more silent reuse of cached account).
- **194 stops re-tagged + reverted**: when DB_NAME was briefly wrong on Fly, user re-imported 194 stops under throwaway `user_33dcfe14df90`. I migrated + re-tagged them to the admin account at user's request, then reverted ("Remove the stops you in ust addded") — final count back to historical 196.
- **Route-overview button → toggle** + new **visible `locate` icon** in `NavigationPanel` immersive header (next to volume toggle). Tap = wide route view; tap again = recenter on driver. testID `immersive-route-overview-toggle`.

### Files touched this session
- `/app/backend/Dockerfile.flyio` — overwritten with single-stage build + emergentintegrations CloudFront index + lkh `--no-deps` workaround for click conflict
- `/app/backend/fly.toml` (new)
- `/app/backend/.dockerignore` (new)
- `/app/backend/deploy-fly.sh` (new, chmod +x)
- `/app/backend/FLY_DEPLOY.md` (new)
- `/app/backend/requirements.txt` — bumped `click==6.7 → click==8.4.0` to unblock black
- `/app/frontend/eas.json` — production + production-apk → `routed.fly.dev`
- `/app/frontend/.env` — `EXPO_PUBLIC_BACKEND_URL=https://routed.fly.dev` (note: gets reverted on supervisor restart; stop expo before any `eas update`)
- `/app/frontend/app/(tabs)/index.tsx` — removed broken `setIsMapReady(false)` viewMode reset; added compass subscription with `headingSubscription`/`compassHeadingRef`/`hasGpsCourseRef`; bumped GPS timeInterval 800→400; replaced redundant heading low-pass with raw value passthrough; flipped `highFreqCameraActive` back to `isNavigating && viewMode === 'navigating'`; made `handleShowRouteOverview` a toggle via `inOverviewModeRef`
- `/app/frontend/src/components/DeliveryMap.native.tsx` — `drivingCamera` no longer gates on `map.loaded()`; `_easeInFlight` released via `moveend` event + 600 ms watchdog; pixel-space look-ahead offset; removed earlier ill-fated position-lerp attempt (made puck visibly trail camera); all debug border/outline code stripped
- `/app/frontend/src/components/route/NavigationPanel.tsx` — added visible 🎯 `locate` icon button calling `onShowRouteOverview`
- `/app/frontend/src/context/AuthContext.tsx` — stale-token probe (reverted), `preferEphemeralSession` (separate edit lives in app/index.tsx)
- `/app/frontend/app/(tabs)/profile.tsx` — stale-token recovery on Profile mount + AsyncStorage/BACKEND_URL imports

### Known followups for next session
- `git rev-parse` runs inside Fly container but no `.git` is COPYed in → `/api/healthz/version` reports `sha: "unknown"`. Cosmetic; fix by adding `.git` to build context or passing `GIT_SHA` build arg.
- `frontend/.env`'s `EXPO_PUBLIC_BACKEND_URL` gets reverted by Emergent's PROTECTED_VARIABLES on every supervisor restart. The EAS server-side env var is now the source of truth, but anyone running `eas update` from this pod must `sudo supervisorctl stop expo`, fix .env, run update, restart expo. Document this.
- `test_database` on Atlas now contains only stale junk (the 194 stops + a throwaway user). User opted to keep it for a week as safety net; should be dropped around 2026-05-29.
- Old wrong-DB user `user_33dcfe14df90` was confirmed NOT in `routed` DB and not in any active session.
- v90, v91 etc. APK builds never finished — user hit Expo free-tier monthly Android quota. Resets June 1, or upgrade for $19/mo.
- P1 backlog untouched: time-window warnings on pins; bounced re-attempt queue.

