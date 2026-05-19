# PathPilot OSRM on Fly.io — deploy guide

A standalone OSRM service (Queensland car routing) running on Fly.io
in Sydney (`syd`) so PathPilot's production backend can hit it for
real road-network distance matrices instead of falling back to the
slow public OSRM demo.

## What you'll get

- **URL**: `https://pathpilot-osrm.fly.dev` (you can rename in `fly.toml`)
- **Endpoints**: standard OSRM v1 — `/route/v1/driving/...`, `/table/v1/driving/...`, `/nearest/v1/driving/...`
- **Routing data**: Queensland (covers Brisbane / Sunshine Coast / Gold Coast)
- **Cost**: ~$1.94/mo for 1 GB Hobby VM. Sleeps when idle (auto-stop).
- **First-request cold start**: ~5-10 s. Subsequent calls < 50 ms.

---

## One-time setup (15 minutes)

### 1. Install flyctl

```bash
# macOS
brew install flyctl

# Linux / WSL
curl -L https://fly.io/install.sh | sh

# Windows PowerShell
iwr https://fly.io/install.ps1 -useb | iex
```

### 2. Sign up / log in

```bash
flyctl auth signup        # opens browser, no credit card needed for trial
# OR
flyctl auth login         # if you already have an account
```

You will need a credit card to attach a billing source for the Hobby VM
(unless your free trial credits are still active). Charge is tiny (~$2/mo).

### 3. Initialise the app (from this folder)

```bash
cd /app/osrm-deploy        # the folder this README lives in
flyctl launch --name pathpilot-osrm --copy-config --no-deploy
```

The `--copy-config` flag tells flyctl to use the existing `fly.toml` and
`Dockerfile` instead of generating new ones from scratch. Confirm:
- App name: `pathpilot-osrm`
- Region: `syd` (or pick something else — `sjc` for US west, `fra` for EU)
- Postgres: **No**
- Upstash Redis: **No**

### 4. Deploy

```bash
flyctl deploy --remote-only
```

The first build takes **15-25 minutes** because it:
- pulls `osrm/osrm-backend:v5.27.1` (~250 MB)
- downloads `queensland-latest.osm.pbf` from Geofabrik (~80 MB)
- runs `osrm-extract` → `osrm-partition` → `osrm-customize`
- ships the resulting `.osrm.*` files into the runtime image (~600 MB)

Subsequent deploys (when nothing in OSRM changes) are layer-cached and
take ~30 s.

### 5. Verify

```bash
# Should return JSON in a few seconds (allow ~10 s on the very first hit while OSRM warms its mmap)
curl https://pathpilot-osrm.fly.dev/nearest/v1/driving/153.0758,-26.5345

# Expected response shape:
# {"code":"Ok","waypoints":[{"hint":"...","distance":12.3,"name":"...","location":[153.0758,-26.5345]}]}
```

If you see `"code":"Ok"` you're done.

---

## Wire it into PathPilot production

Once OSRM is live on Fly:

1. **Sandbox-side** (this repo, in chat with me):

   I'll update `/app/backend/.env` with:
   ```
   OSRM_URL=https://pathpilot-osrm.fly.dev
   OSRM_PUBLIC_URL=https://router.project-osrm.org
   ```
   So sandbox keeps using its local OSRM at `localhost:5000` (override
   in supervisor) BUT prod inherits the Fly URL from the deploy `.env`.

2. **Click Deploy** on Emergent — production picks up the new
   `OSRM_URL`, hits Fly for every matrix call, and your 200-stop
   optimize lands in 15-30 s instead of timing out.

---

## Useful commands

```bash
flyctl logs                    # tail OSRM stdout/stderr
flyctl status                  # current VM state + last deploy
flyctl ssh console             # shell into the running container
flyctl scale memory 2048       # bump to 2 GB if QLD outgrows 1 GB
flyctl scale count 0           # turn off entirely (saves $$)
flyctl scale count 1           # turn back on
flyctl deploy --remote-only    # redeploy after editing Dockerfile
```

---

## Refreshing the map data

Geofabrik refreshes its extracts every Sunday. To pull the latest QLD
data into your OSRM service:

```bash
flyctl deploy --remote-only --no-cache
```

The `--no-cache` flag forces re-download + re-preprocess. ~25 min, do
it once a quarter or after major road changes.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy fails with `out of memory` during osrm-customize | Bump `memory_mb` in `fly.toml` to `2048`, redeploy |
| Cold-start is taking > 30 s on first request | OSRM is mmap'ing — wait until the http_check passes, or scale to 2 cpus temporarily |
| `"code":"NoMatch"` on a known good coordinate | The QLD extract doesn't cover that lat/lng. Switch to a bigger region (e.g. `australia`) or a custom bbox |
| Frequent timeouts | Check `flyctl status` — your VM may have run out of RAM and OOM-killed osrm-routed |
| 502 Bad Gateway from Fly | Machine is asleep + cold-starting; just retry. To eliminate: set `min_machines_running = 1` in `fly.toml` (≈ doubles cost) |

---

## Bigger geographic coverage

If you need all of Australia (NT/SA/VIC/NSW/WA): build with

```bash
flyctl deploy --remote-only --build-arg OSM_REGION=australia --build-arg OSM_FILE=australia-latest.osm.pbf
```

Australia full extract = ~1.5 GB OSM data → ~6 GB OSRM files → needs a
4 GB Fly VM (~$8/mo). Scale memory + storage:

```bash
flyctl scale memory 4096
flyctl volumes create osrm_data --size 10 --region syd   # if you'd rather mount a volume than bake into the image
```
