# RouTeD Deployment Playbook

> **Bulletproof deploy guide.** Bookmark this. Run `bash /app/scripts/predeploy.sh` before every release.

---

## 🎯 Three deploys, not one

| Layer | Where | How | Cadence |
|---|---|---|---|
| **Backend (FastAPI)** | Emergent K8s pod | Emergent UI → "Native Deploy" | When `server.py` / `.env` / deps change |
| **Android binary** (AAB) | Google Play Store | `eas build --platform android --profile production` | Once per release cycle (~monthly) |
| **JS bundle** (OTA) | Expo CDN | `eas update --branch production` OR push tag `v*.*.*` | Daily, instant |

**95% of frontend changes ship via OTA.** Only rebuild the binary when `app.json`, native deps, icons, or splash change.

---

## ✅ Pre-flight (always run first)

```bash
bash /app/scripts/predeploy.sh
```

Checks: `.gitignore` integrity • hardcoded secrets • `eas.json` sanity • env vars • backend reachability • pytest • git working tree. Exit code 0 = green light.

Flags:
- `--skip-tests` — skip pytest (faster)
- `--backend` — only backend-relevant checks
- `--frontend` — only frontend-relevant checks

---

## 🚀 Step 1 — Backend (Native Deploy)

1. In Emergent chat: click **Save to GitHub** *(NOT `git push` from terminal — Emergent's button handles `.git/.emergent` metadata)*
2. Click **Deploy → Native Deploy** in Emergent UI
3. Watch the **fresh** logs in the deploy modal (refresh before tailing — old logs lie)
4. Smoke-test:
   ```bash
   curl -s https://<your-prod-url>/api/health
   # → {"status":"ok"} expected
   ```

🚫 **Never use the deployment subagent** — it corrupts `.gitignore` silently and is permanently banned in this codebase.

---

## 📦 Step 2 — Android Binary (AAB → Play Store)

Run from **your laptop**, not the Emergent container:

```bash
cd frontend

# One-time:
npm install -g eas-cli
eas login
eas build:configure

# Every binary release (~10–15 min):
eas build --platform android --profile production
# → produces .aab; download link printed

# Test as APK before submitting:
eas build --platform android --profile preview
```

Then **Play Console → Production → Create new release** → upload the `.aab`.

### Binary release footguns
- `eas.json` must NOT contain `enableProguardInReleaseBuilds` *(EAS rejects this key — already fixed)*
- Bump `expo.version` AND `expo.android.versionCode` in `app.json` every release. Play Store rejects duplicate versionCodes.
- `EXPO_PUBLIC_BACKEND_URL` in `frontend/.env` must point at **production**, not preview, before the build.

### 🎯 runtimeVersion policy (set — auto-protects OTAs)

`app.json` uses `"runtimeVersion": { "policy": "appVersion" }` at root + iOS + Android. This means:

- The runtimeVersion auto-resolves to whatever `expo.version` is (currently `1.0.0`)
- When you bump `expo.version` to e.g. `1.0.1` and ship a new AAB, that binary lives in its own OTA bucket
- OTAs published AFTER the bump only reach devices running the new AAB — old devices are auto-skipped, no manual rollback needed
- Prevents the "OTA pushed for a runtime that doesn't exist" footgun entirely

If `predeploy.sh` ever warns `runtimeVersion is hardcoded`, someone reverted this — restore the policy object before the next binary build.

---

## ⚡ Step 3 — OTA Updates (95% of releases)

### Manual (from laptop)
```bash
cd frontend
eas update --branch production --message "Fix resume route bug"
```

### Automated (via tag push) — GitHub Action wired
```bash
git tag v2026.05.20
git push --tags
# → GitHub Action `eas-ota-update.yml` triggers automatically
```

Or use `ota-*` prefix for non-version tags:
```bash
git tag ota-fix-resume
git push --tags
```

**One-time GitHub setup for the action:**
1. Expo dashboard → Access Tokens → create token
2. GitHub repo → Settings → Secrets → Actions → add `EXPO_TOKEN`
3. Done. Push tags from now on.

### OTA can ship
✅ TypeScript/JSX code changes
✅ Style + asset (image) changes
✅ API endpoint changes

### OTA CANNOT ship — needs new AAB
❌ New native modules (e.g. `expo-camera`)
❌ `app.json` permissions / plugins changes
❌ Icons / splash
❌ Expo SDK upgrades

---

## 🛡️ Safety nets

```bash
# Backup production DB before backend deploys
mongodump --uri "$MONGO_URL" --out /tmp/backup-$(date +%F)

# Tag every release for rollback
git tag -a v2026.05.20 -m "Resume route fix"
git push --tags

# Roll back a bad OTA (instant)
cd frontend && eas update:rollback --branch production
```

---

## 🆘 Troubleshooting matrix

| Symptom | Action |
|---|---|
| Backend returns 502 / 503 | Emergent Native Deploy logs → look for `MongoDB connection` |
| EAS build "enableProguard" error | Old cached log — refresh page, trigger new build |
| Play Store rejects with versionCode error | Bump `android.versionCode` in `app.json` |
| App crashes after OTA | `eas update:rollback --branch production` |
| "Save to GitHub" "No space left on device" | `cd /app && git repack -ad && rm -rf .git/objects/pack/tmp_pack*` |
| ".gitignore corrupted" / env files stripped | `bash /app/scripts/gitignore-autoheal.sh` |
| Pytest failing on `test_alns_solver.py::test_health_check` | Pre-existing — endpoint doesn't exist; ignore |

---

## 🏁 Drumbeat

```text
First release (Play Store launch):
  1. bash /app/scripts/predeploy.sh
  2. Save to GitHub                            ← Emergent button
  3. Deploy → Native Deploy                    ← backend
  4. cd frontend && eas build … production     ← AAB on your laptop
  5. Upload .aab → Play Console
  6. Real-device smoke test

Subsequent releases (95% of the time):
  1. bash /app/scripts/predeploy.sh
  2. Save to GitHub
  3. Deploy → Native Deploy                    ← only if backend changed
  4. git tag vYYYY.MM.DD && git push --tags    ← GH Action ships OTA (30s)
```

---

## 📁 Related files

- `/app/scripts/predeploy.sh` — pre-flight checker (this is your bestie)
- `/app/scripts/pre-deploy-audit.sh` — focused `.gitignore` audit
- `/app/scripts/gitignore-autoheal.sh` — repair tool
- `/app/.github/workflows/eas-ota-update.yml` — auto-OTA on tag push
- `/app/frontend/eas.json` — EAS build profiles
- `/app/frontend/app.json` — Expo config (version + versionCode here)
