# EAS Submit — Push to Google Play with one command

Once configured (one-time, ~10 min), you can push any build straight to Google
Play Console with:

```bash
cd /app/frontend
eas submit --platform android --profile internal --latest
```

That uploads the most recent **production** EAS build to the Play Store
**Internal Testing** track. From there you can promote to Alpha → Beta →
Production with a single click in Play Console.

---

## ONE-TIME SETUP

### Step 1 — Create the Google Play service account (5 min)

The service account is the robot identity EAS uses to upload your `.aab`.
You only do this once per Play Console account.

1. Open **Play Console** → **Setup** → **API access**
   (https://play.google.com/console/u/0/api-access)
2. Click **Choose a project to link** → **Create new Google Cloud project**
   → name it `routed-publishing` → **Save**
3. Under **Service accounts** → click **Create new service account**
   → opens a Google Cloud popup
4. In Google Cloud:
   - Name: `routed-eas-submit`
   - Role: **Service Account User**
   - Click **Done**
   - Click the new service account → **Keys** tab → **Add key** →
     **Create new key** → **JSON** → **Create**
   - A JSON file downloads. **Keep this safe — it's a credential.**
5. Back in Play Console → click **Refresh service accounts** →
   your new account appears → click **Grant access**
6. Set permissions:
   - **Admin** access: turn OFF
   - **App permissions** → **Add app** → select **RouTeD** → tick:
     - ✅ View app information and download bulk reports
     - ✅ Manage testing tracks and edit tester lists
     - ✅ Manage store presence (optional, lets EAS update screenshots too)
     - ✅ Release apps to testing tracks
     - ✅ Release apps to production *(only if you trust full automation)*
   - **Account permissions**: leave all OFF
7. Click **Invite user** → confirm

### Step 2 — Drop the JSON key into the project

```bash
# Move the downloaded JSON into your frontend folder:
mv ~/Downloads/routed-publishing-*.json /app/frontend/play-service-account.json

# Verify .gitignore protects it (it does — already configured):
git check-ignore frontend/play-service-account.json
# → frontend/play-service-account.json
```

⚠️ **If you ever accidentally commit this file**, revoke the key
immediately in Google Cloud Console → Service Accounts → Keys → Delete,
then create a new one.

### Step 3 — Tell Play Console which app this is for

The very first `.aab` you submit must be uploaded via the Play Console
web UI (Google requires a human to seed the package). All future
submissions can be `eas submit`.

```bash
cd /app/frontend
eas build --platform android --profile production
# wait ~12 min
# download the .aab from the EAS dashboard
# Play Console → Internal Testing → Create new release → upload .aab
```

After that first manual seed, you're set.

---

## DAILY WORKFLOW

### Push a new build to Internal Testing (your own phone + 100 testers)

```bash
cd /app/frontend
# 1. Bump version in app.json (versionCode MUST increment every time)
#    — already automated via "autoIncrement": true in eas.json
# 2. Build the .aab
eas build --platform android --profile production
# 3. Submit it to Play Store Internal Testing
eas submit --platform android --profile internal --latest
```

EAS will:
- Pull the latest production build from your EAS dashboard
- Auto-package it into a Play Store edit
- Push it to **Internal Testing**, **Completed** state (testers see it
  in their Play Store within 30-60 min)

### Promote to Alpha (small invite-only group)

```bash
eas submit --platform android --profile alpha --latest
```

### Promote to Beta (open or closed public beta)

```bash
eas submit --platform android --profile beta --latest
```

### Stage a production release as a DRAFT

```bash
eas submit --platform android --profile production --latest
```

This uploads to Production track but leaves the release in **draft** state —
you have to manually click **Send for review** in Play Console. Safety net
against accidentally pushing to all users.

### Promote with one click

In Play Console → **Internal Testing** → click your release → **Promote release**
→ **Production** → adjust rollout % → **Send for review**.

Google's review takes 1-3 days for the first release, 24h for updates.

---

## TROUBLESHOOTING

### "The signing key for this build no longer matches the key in Play Console"
Don't worry — let EAS handle signing. On first build EAS prompts to either
generate a new keystore (the easy path) or upload your own. Pick **generate**.
EAS stores the keystore securely; never lose access to your Expo account.

### "Package not registered in Play Console" error from EAS Submit
You skipped Step 3 (the first manual `.aab` upload). Do that once, then
`eas submit` works forever.

### "Insufficient permissions" from EAS Submit
Re-check Step 1.6 — the service account needs **Release apps to testing
tracks**. Permission changes can take ~10 min to propagate.

### Auto-version-code conflicts ("versionCode already exists")
`autoIncrement: true` in eas.json bumps the versionCode for every build,
so this only happens if you manually set the same versionCode in app.json.
Either delete the line in app.json or let EAS own it entirely.

### Want to test the submit flow WITHOUT actually pushing?
```bash
eas submit --platform android --profile production --latest --no-wait --non-interactive --verbose
```
Check the EAS dashboard — the submit will show but you can cancel before
Google receives it (within the first ~30 s).

---

## SUMMARY: Your one-command release workflow

```bash
# Cut a new release to Internal Testing in one shot:
cd /app/frontend && eas build --platform android --profile production --auto-submit
```

The `--auto-submit` flag triggers `eas submit` automatically the moment
the build finishes — useful for unattended Friday-night releases.

If you'd rather see the build before submitting:
```bash
eas build --platform android --profile production
# (review build, smoke-test on phone, then…)
eas submit --platform android --profile internal --latest
```
