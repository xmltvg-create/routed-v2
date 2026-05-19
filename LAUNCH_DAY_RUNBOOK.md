# RouTeD — Launch Day Runbook

A single linear checklist from "zero" to "live on Google Play". Designed
to be followed in order on launch day. Every command is copy-pasteable.
Realistic time estimates per step.

**Total time on launch day: ~3 hours of active work, + 2-3 days of
Google review while you sleep.**

---

## PRE-LAUNCH (the day before — 30 min)

### ☐ 0.1 — Confirm your local dev machine is ready

```bash
# Check Node version (need 20+)
node --version

# Install EAS CLI globally if you haven't already
npm install -g eas-cli@latest
eas --version           # → 12.x.x or higher

# Login to Expo
eas login
# → enter your Expo account credentials

# Verify the project recognises your account
cd /path/to/your/local/frontend
eas whoami              # → your-expo-username
```

### ☐ 0.2 — Pull the latest code

```bash
cd /path/to/your/local/frontend
git pull
# Confirm app.json shows:
#   "package": "com.routed.app"
#   "versionCode": 2
#   "version": "1.0.1"
grep -E '"package"|"versionCode"|"version"' app.json
```

### ☐ 0.3 — Host the privacy policy

Pick ONE of these — GitHub Pages is fastest:

**Option A (recommended): GitHub Pages — 3 min, free, forever**
1. Create a new public repo named `routed-privacy` on github.com
2. Drag-drop `frontend/public/privacy-policy.html` into the repo,
   **rename it to `index.html`** when uploading
3. Settings → Pages → Source: `main` branch, `/` (root) → Save
4. Wait 1-2 min, then verify: `https://<your-username>.github.io/routed-privacy/`
5. **Save the URL** — you'll paste it 4× during Play Console setup

**Option B: Netlify drop**
1. https://app.netlify.com/drop → drag `privacy-policy.html`
2. Save the auto-generated URL

**Option C: Your own domain**
- Just upload the HTML file. Make sure it's accessible without login.

### ☐ 0.4 — Pay for Play Console (one-time, $25 USD)

1. https://play.google.com/console/signup
2. Choose **"An organization"** (not "myself") if you'll ever invoice clients,
   else "Myself" is fine for a solo launch
3. Verify identity (passport / driver's licence)
4. Pay $25 USD
5. Account verification takes **24-48 h** — do this the day before,
   not on launch day

---

## LAUNCH DAY MORNING (Hour 1)

### ☐ 1.1 — Create the Play Console service account (10 min)

Open Play Console → **Setup → API access** →
https://play.google.com/console/u/0/api-access

1. **Create a new Google Cloud project** when prompted → name it
   `routed-publishing` → Save
2. **Create service account** (a Google Cloud popup opens):
   - Name: `routed-eas-submit`
   - Role: **Service Account User**
   - Click **Done**
3. Click the new service account → **Keys** tab → **Add key → Create
   new key → JSON → Create**
4. A `routed-publishing-XXXXX.json` file downloads. Move it to your
   project root:
   ```bash
   mv ~/Downloads/routed-publishing-*.json \
      /path/to/your/local/frontend/play-service-account.json
   ```
5. Verify .gitignore protects it:
   ```bash
   git check-ignore frontend/play-service-account.json
   # → frontend/play-service-account.json   ← must print this exact line
   ```
6. Back in **Play Console → API access** → click **Refresh service
   accounts** → grant access:
   - ✅ View app information and download bulk reports
   - ✅ Manage testing tracks and edit tester lists
   - ✅ Release apps to testing tracks
   - ✅ Release apps to production *(only if you trust full automation)*
   - ❌ Admin (leave off)

### ☐ 1.2 — Create the app listing in Play Console (5 min)

1. Play Console → **All apps → Create app**
2. Fill in:
   - App name: `RouTeD`
   - Default language: `English (Australia) – en-AU`
   - App or game: **App**
   - Free or paid: **Free** (Pro subscription is an IAP, not a paid app)
   - Declarations: tick both Developer Program Policies checkboxes
3. Click **Create app**
4. **IMMEDIATELY** go to **App content → Set up your app** and start
   ticking off the required sections. Refer to `/app/PLAY_STORE_LISTING.md`
   for paste-ready answers to every form:
   - [ ] App access
   - [ ] Ads
   - [ ] Content rating (questionnaire)
   - [ ] Target audience
   - [ ] Data safety
   - [ ] Government apps (no)
   - [ ] Financial features (declare RouTeD Pro subscription)
   - [ ] Health (no)
   - [ ] News (no)
   - [ ] COVID-19 tracing (no)

⚠️ You can populate these BEFORE you upload the `.aab`. Do it now.

---

## LAUNCH DAY MORNING (Hour 2 — the build)

### ☐ 2.1 — First production build (~12-15 min)

```bash
cd /path/to/your/local/frontend
eas build --platform android --profile production
```

Watch the build at the URL printed in your terminal. When complete:

```
✔ Build finished
📱 Android app:
   https://expo.dev/artifacts/eas/<long-id>.aab
```

### ☐ 2.2 — Back up the EAS-generated keystore (CRITICAL, 5 min)

⚠️ **Skip this step and you risk losing your app forever.**

```bash
eas credentials
# → Android → production → Download credentials
```

Save the printed:
- **Keystore (.jks file)** → encrypted backup + password manager
- **Keystore password**
- **Key alias** (usually `eas-build-key`)
- **Key password**

**Store in 3 independent places:**
1. Password manager (1Password / Bitwarden / KeePass) as a secure note
   titled `RouTeD Android keystore — com.routed.app`
2. Encrypted ZIP on Google Drive / Dropbox / iCloud
3. Encrypted USB drive in a fire-safe location

### ☐ 2.3 — Smoke test the .aab on your phone (10 min)

The `.aab` itself can't be sideloaded directly (Android only installs
APKs from `adb install`). Either:

**Quick path:** Just upload to Play Console Internal Testing and install
from the Play Store on your phone (Step 3.x below).

**Paranoid path:** Build a parallel preview APK in another terminal
while you do Play Console setup:
```bash
eas build --platform android --profile preview &
```
Wait until it finishes, then:
```bash
adb install routed-preview.apk
```
Run through: log in, import a small CSV, optimise, open Profile,
tap "Train Now" on the ML cards, tap Privacy & Terms. If all green,
move on.

---

## LAUNCH DAY MORNING (Hour 3 — Play Console setup)

### ☐ 3.1 — Upload .aab to Internal Testing track (10 min)

This is the **only** time you upload manually — every future release
will use `eas submit`.

1. Play Console → your app → **Testing → Internal testing**
2. **Create new release**
3. **Upload** the `.aab` you downloaded from EAS
4. Fill in:
   - Release name: `1.0.1 (vc 2) — Initial release`
   - **Release notes** (paste in English/AU):
     ```
     <en-AU>
     - First public release.
     - VROOM/OR-Tools/LKH-3 route optimization.
     - 3D heads-up driving navigation.
     - Per-driver ML service-time learner.
     - Per-suburb building-side pin correction.
     - Stripe-powered RouTeD Pro subscription.
     </en-AU>
     ```
5. Click **Next → Save** (NOT "Publish" yet — keep as draft until
   everything else is filled in)
6. **Internal testers tab → Create email list** → add your own email
   first, so YOU can install from the Play Store immediately

### ☐ 3.2 — Populate the Main store listing (20 min)

Open `/app/PLAY_STORE_LISTING.md` side by side. Play Console →
**Grow → Store listing**:

- [ ] **App name:** `RouTeD — Delivery Routing`
- [ ] **Short description:** paste from listing doc
- [ ] **Full description:** paste from listing doc
- [ ] **App icon:** upload `frontend/assets/playstore/icon-playstore-512.png`
- [ ] **Feature graphic:** upload `frontend/assets/playstore/feature-graphic-1024x500.png`
- [ ] **Phone screenshots:** upload all 8 in order:
  ```
  frontend/assets/playstore/screens/screen-1-hero.png
  frontend/assets/playstore/screens/screen-2-learning.png
  frontend/assets/playstore/screens/screen-3-cockpit.png
  frontend/assets/playstore/screens/screen-4-pins.png
  frontend/assets/playstore/screens/screen-5-outlier.png
  frontend/assets/playstore/screens/screen-6-tighten.png
  frontend/assets/playstore/screens/screen-7-blockroad.png
  frontend/assets/playstore/screens/screen-8-dashboard.png
  ```
- [ ] **Promo video URL** (optional but high-converting):
  1. Upload `frontend/assets/playstore/van-scan-promo.mp4` to YouTube
     as **Unlisted**
  2. Title: `RouTeD — Load 180 parcels in 4 minutes flat`
  3. Custom thumbnail: `frontend/assets/playstore/van-scan-promo-thumb.png`
  4. Copy the YouTube URL → paste here

### ☐ 3.3 — Fill the Data safety + Permissions sections (15 min)

Refer to `/app/PLAY_STORE_LISTING.md` section 6 (Data safety) and
section 8 (Permissions Declaration). Paste the table answers verbatim.

The **most-rejected** form is **Data safety** — be honest:
- Collect: Name, Email, User ID, Precise location, Photos (optional),
  App interactions, Crash logs
- Share: **None** (we don't send anything to third parties for marketing)
- Encrypted in transit: **Yes**
- Encrypted at rest: **Yes**
- Users can request deletion: **Yes** (link to your privacy policy
  email)

### ☐ 3.4 — Submit Internal Testing release for review (1 min)

1. Back to **Internal testing → your release**
2. Click **Review release**
3. Resolve any remaining warnings (Play Console highlights them)
4. Click **Start rollout to Internal testing**

🎉 **Your app is now in Google's queue.** Internal testing usually
goes live within **1-3 hours** (not 1-3 days like Production).

---

## LAUNCH DAY AFTERNOON (Hour 4 — install + test)

### ☐ 4.1 — Install from Play Store on your own phone (when Google sends the email)

1. Wait for the `"Your release for [Internal testing] has been approved"`
   email from Google (1-3 h)
2. On your phone, open the Play Store link from the email — opt in to
   the internal test
3. Install RouTeD from the Play Store
4. Smoke test the **production** build with the **production** Stripe
   keys (NOT test keys — internal testing IS production now)
5. Make a $0.50 test purchase of RouTeD Pro to confirm the Stripe
   webhook is wired and you receive the welcome email

### ☐ 4.2 — Decide: stay in Internal or promote (10 min)

**Stay in Internal for 7 days** if you want to:
- Find bugs with a tight feedback loop (you + 5-20 trusted testers)
- Validate the Stripe subscription flow at production scale
- Stress-test on a few different Android phones

**Promote to Production immediately** if you want to:
- Hit the launch date
- Get organic Play Store search traffic ASAP
- Start collecting reviews

To promote:
1. Internal testing → your release → **Promote release → Production**
2. Adjust **Rollout percentage** to `5%` initially (Google staged
   rollout, lets you halt if 1-star reviews flood in)
3. Click **Save** → **Send for review**
4. Production review takes **1-3 days** (vs Internal's 1-3 hours)

### ☐ 4.3 — Post launch posts (30 min)

While waiting for production review, queue social posts:

**LinkedIn / X (paste from `/app/PLAY_STORE_LISTING.md` section 10):**
> Spent 18 months as a courier on the Sunshine Coast and watched every
> route app sell me a 30-second-per-stop fairy tale. So I built one
> that actually learns. RouTeD ships today on Google Play — VROOM-
> powered route optimisation, 60 fps WebGL navigation, and per-driver
> ML that learns how *you* deliver. Free tier covers 25 stops/day.
> Link in bio.

Attach: `frontend/assets/playstore/van-scan-promo.gif`

**Reddit r/couriers, r/Sunshine, r/AmazonFlexDrivers** (search for
existing rules about self-promotion first — usually OK if you've
been a member 30+ days):
> Built a route app because I was tired of [bigger competitor's name]
> assuming every stop takes 30 seconds. RouTeD learns your service
> times per suburb, per hour. Open beta on Google Play, free for
> 25 stops/day. AMA if you want me to walk through the ML side.

---

## DAY 2-3 — Production goes live

You'll get an email: `"RouTeD is now live on Google Play"`.

✅ Confirm your listing renders correctly at
   `https://play.google.com/store/apps/details?id=com.routed.app`

🚀 **You're shipped.** Now the post-launch workflow takes over.

---

## POST-LAUNCH — Daily / Weekly Workflow

### Push a bug fix or feature (the entire ongoing loop)

```bash
cd /path/to/your/local/frontend

# 1. Make your code change, test locally with Expo
yarn start

# 2. Bump version (only the user-facing version, NOT versionCode —
#    eas.json auto-increments versionCode)
# Edit app.json: "version": "1.0.2"

# 3. Build + auto-submit in one shot
eas build --platform android --profile production --auto-submit

# 4. EAS builds (~12 min), uploads to Internal Testing automatically,
#    then waits for you to promote.

# 5. Promote in Play Console:
#    Internal testing → release → Promote → Production → 100% rollout
```

### Push a tiny frontend-only fix via OTA (no build, no review)

Most code changes don't need a full re-build — Expo Updates lets you
push JS-only changes instantly:

```bash
cd /path/to/your/local/frontend
yarn --cwd /app/frontend update:prod --message "Fix outlier banner copy"
```

OTA updates:
- **Skip Google review entirely** (still safe — only JS, no new perms)
- Hit users within 5-10 min of pushing
- Can't be used for `app.json` changes, new native modules, or new
  permissions — those still require a full `eas build`

### Roll back an OTA

```bash
# Find the previous good update ID
eas update:list --branch production --limit 5
# Republish the old code by tagging it as the latest update
eas update:republish --group <UUID-from-list>
```

### Monitor production

- **Crashes:** Play Console → **Quality → Crashes & ANRs** (check daily
  first week)
- **Reviews:** Play Console → **Ratings & reviews** (respond to every
  1-2-star review within 24 h — biggest single rating lever)
- **Backend health:** your Emergent dashboard → check for 500s after
  the launch traffic spike
- **Stripe subscriptions:** Stripe dashboard → Customers → confirm
  cancellations < 20 % of first-month signups

---

## EMERGENCY RUNBOOK

### Production release has a critical bug

**Option 1 — Halt the rollout (Play Console)**
1. Production → current release → **Halt rollout**
2. Existing users on the bad version keep it; new installs go to the
   previous version

**Option 2 — Ship a hotfix via OTA (minutes)**
If it's a JS bug:
```bash
yarn --cwd /app/frontend update:prod --message "HOTFIX: <description>"
```
Users force-close-reopen the app → fix is live.

**Option 3 — Ship a hotfix via new build (hours)**
If it's a native bug:
```bash
# Bump app.json version to "1.0.2"
eas build --platform android --profile production --auto-submit
# Promote through Play Console as soon as it lands in Internal
```

### Backend went down post-launch

1. Check Emergent dashboard for the backend container status
2. If down, restart from the dashboard
3. Worst case (preview URL changed): rebuild + ship a hotfix with the
   new URL baked in via `EXPO_PUBLIC_BACKEND_URL` env var in eas.json

### Account/keystore lost

If you backed up correctly (Step 2.2), restore from your backup.
If you didn't... contact Expo support with proof of project ownership —
they can sometimes recover access. As a last resort, publish under
a NEW package name (`com.routed.app2`) and migrate users — painful
but possible.

---

## RUNBOOK SUMMARY

| Phase | Time | What you're doing |
|---|---|---|
| Day -1 | 30 min | Pay Play Console, host privacy policy, install EAS CLI |
| Day 0, 1 h | 15 min | Service account + create app listing |
| Day 0, 2 h | 30 min | First production build |
| Day 0, 2 h | 5 min | **Back up keystore** (critical) |
| Day 0, 3 h | 30 min | Upload .aab + populate listing + screenshots |
| Day 0, 3 h | 15 min | Data safety form + content rating |
| Day 0, 3 h | 1 min | Submit for Internal Testing review |
| Day 0, 4 h | wait 1-3 h | Google approves Internal Testing |
| Day 0, 5 h | 30 min | Install from Play Store + smoke test + queue social posts |
| Day 0, 5 h | 1 min | Promote to Production (5% rollout) |
| Day 1-3 | — | Google reviews Production |
| Day 3 | — | **🎉 RouTeD goes live globally** |
| Day 3+ | ongoing | Monitor reviews, ship OTAs, build features |

**Active work on launch day: ~3 hours.** The rest is waiting on
Google, which is exactly the right ratio.

Good luck. 🚀
