# RouTeD backend → Fly.io migration

This folder ships a self-contained Fly.io setup for the FastAPI backend.

| File | Purpose |
|------|---------|
| `Dockerfile.flyio` | Production container image (python:3.11-slim + uvicorn). |
| `fly.toml` | Fly app config: region, ports, healthcheck, `min_machines_running=1` (no cold-starts). |
| `.dockerignore` | Keeps the image small (drops tests, `.env`, xlsx exports, `__pycache__`). |
| `deploy-fly.sh` | One-shot helper that wraps `flyctl secrets set` + `flyctl deploy`. |
| `FLY_DEPLOY.md` | The doc you're reading. |

---

## ⚠️ MongoDB — the one decision you can't skip

You're currently running `MONGO_URL=mongodb://localhost:27017`, i.e. Mongo on the
same box as the API. Fly.io has **no managed MongoDB** offering, so when we
move the API there we *must* point it at an external cluster.

### Recommended: MongoDB Atlas free tier (M0)
- 512 MB storage, shared CPU, free forever.
- Lives in `ap-southeast-2` (Sydney) — same region as `fly.toml`'s `primary_region = "syd"`.
- 5-minute setup.

**Setup:**
1. Sign up at <https://cloud.mongodb.com>, create a free **M0** cluster in
   `AWS / ap-southeast-2 (Sydney)`.
2. Database Access → Add user `routed-api` with a strong password.
3. Network Access → Add IP `0.0.0.0/0` *(Fly egress IPs aren't static; this is
   the standard pattern. Atlas still enforces user+password auth.)*
4. Connect → "Drivers" → copy the SRV string. Should look like:
   ```
   mongodb+srv://routed-api:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
5. Migrate the existing data (run **locally**, not in this preview pod):
   ```bash
   # On a machine that can reach BOTH the local Mongo dump AND Atlas
   mongodump --uri="mongodb://localhost:27017" --db=<your_DB_NAME> --out=./dump
   mongorestore --uri="mongodb+srv://routed-api:<password>@cluster0.xxxxx.mongodb.net" \
                --nsInclude="<your_DB_NAME>.*" ./dump
   ```

> **Note**: the Emergent preview pod's local Mongo data won't follow the API to
> Fly. You'll be starting empty unless you do the dump/restore above. The
> `user_sessions`, `stops`, `route_history` etc. collections all need to come
> along, otherwise users will be logged out and lose their imported stops.

### Alternative: Fly's "MongoDB-compatible" options
- **DocumentDB on a Fly machine** — you self-host. Not recommended unless you
  enjoy ops.
- **Ferret DB** (Postgres under the hood) — partial Mongo wire-protocol; the
  RouTeD codebase uses some operators (`$inc`, `$push`, `$elemMatch`) that may
  not round-trip cleanly. Skip.

**Stick with Atlas M0.**

---

## 🚀 Deployment — 10-minute path

All commands run **on your local Mac/PC**, not inside this preview pod.

### 1. Install the Fly CLI
```bash
# macOS
brew install flyctl
# Linux / WSL
curl -L https://fly.io/install.sh | sh
# Windows PowerShell
iwr https://fly.io/install.ps1 -useb | iex
```

### 2. Log in
```bash
fly auth signup   # if new account, $5 free credit
# or
fly auth login
```

### 3. Pull the backend folder locally
If you don't already have the repo cloned:
```bash
git clone <your-routed-repo>
cd <repo>/backend
```
Otherwise just `cd` into your existing `backend` folder.

### 4. Launch the app *(only the first time)*
```bash
fly launch --no-deploy --copy-config --dockerfile Dockerfile.flyio
```
- Accept the existing `fly.toml`.
- Choose **NO** Postgres, **NO** Redis (we use external Atlas).
- Pick app name (e.g. `routed-api`) — update `app = "..."` in `fly.toml` if you
  picked something different.

### 5. Set secrets *(replace the values!)*
Use the helper script (it's idempotent — safe to re-run):
```bash
chmod +x deploy-fly.sh
MONGO_URL='mongodb+srv://routed-api:<pw>@cluster0.xxxxx.mongodb.net' \
DB_NAME='routed' \
EMERGENT_LLM_KEY='sk-emergent-...' \
MAPBOX_TOKEN='pk....' \
STRIPE_API_KEY='sk_live_...' \
STRIPE_PRICE_MONTHLY='price_...' \
STRIPE_PRICE_ANNUAL='price_...' \
STRIPE_WEBHOOK_SECRET='whsec_...' \
STRIPE_ADMIN_USER_IDS='user_2a7d88cbb419' \
REVIEWER_EMAILS='routedreviewer@gmail.com' \
REVIEWER_PASSCODE='pwdBOwfl01Mydp_MXG2Qmwh96VzhyS8c' \
DEV_MODE='false' \
ENABLE_TIMEFOLD='false' \
TILE_CACHE_ADMIN_TOKEN='<your-token>' \
GENEROUTE_API_KEY='<if-used>' \
OSRM_URL_PROD='<your-osrm-or-blank>' \
./deploy-fly.sh
```

The script will:
1. `flyctl secrets set ...` for every env var you exported
2. `flyctl deploy` using `Dockerfile.flyio`
3. Tail the first 60s of logs to confirm boot

### 6. Verify
```bash
fly status
fly logs                          # should show "Uvicorn running on..."
curl https://routed-api.fly.dev/health
# → {"status":"ok","time":"..."}
```

### 7. Point the React Native app at Fly
Update `frontend/.env`:
```bash
EXPO_PUBLIC_BACKEND_URL=https://routed-api.fly.dev
```
And in `app.json` / `eas.json`, swap the `production` profile's
`EXPO_PUBLIC_BACKEND_URL` to the same value, then trigger a fresh EAS APK
build:
```bash
cd ../frontend
eas build --profile production-apk --platform android
```

---

## 🔁 Day-2 operations

| What you want to do | Command |
|---|---|
| Deploy code changes | `cd backend && fly deploy` |
| Tail logs | `fly logs` |
| Roll back instantly | `fly releases list` → `fly releases rollback <n>` |
| Update a secret | `fly secrets set FOO=bar` *(triggers redeploy)* |
| Scale to 2 machines (HA) | `fly scale count 2` |
| Bump RAM (OR-Tools OOMs) | `fly scale memory 2048` |
| SSH in for debugging | `fly ssh console` |
| Snapshot the secrets list | `fly secrets list` |

### Healthcheck
Fly hits `GET /health` every 30s (configured in `fly.toml`).
`min_machines_running = 1` + `auto_stop_machines = false` means the machine
**never sleeps**. That's what kills your 502 Bad Gateway problem.

### Buildings tile DB (optional)
`server.py` reads `/app/tiles/buildings.db` (35 MB). If you want it on Fly:
```bash
fly volumes create tiles_data --size 3 --region syd
# Uncomment the [mounts] block in fly.toml, then
fly deploy
fly ssh console -C "ls -lah /app/tiles"      # confirm mount
# upload via: fly ssh sftp put buildings.db /app/tiles/buildings.db
```

### Cost
- **shared-cpu-1x / 1GB**: ~$5/mo per machine running 24/7.
- Atlas M0: $0.
- Total to kill the 502s: **~$5/month**, $0 cold-starts, 50–80ms latency
  Sydney→Sydney.

---

## 🐛 Troubleshooting

- **`Address already in use`** — Old machine still running. `fly machine list`
  → `fly machine destroy <id>`.
- **Boot loop with `ortools` ImportError** — confirm `libgomp1` is in the
  Dockerfile (it is). Try `fly scale memory 2048`.
- **`ServerSelectionTimeoutError` from Mongo** — Atlas Network Access list
  missing `0.0.0.0/0`, or wrong password URL-encoding (`@` → `%40`, `#` → `%23`).
- **Frontend gets CORS errors** — `server.py` already sets `allow_origins=["*"]`.
  If you tighten it later, add `https://*.expo.dev` and your APK's package
  origin.

