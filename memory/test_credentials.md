# Test Credentials

## Auth Mode
- Backend: `DEV_MODE=false` (real Google Auth required)
- Frontend sandbox: `EXPO_PUBLIC_DEV_MODE=true` (auto-login with dev user for testing)
- Frontend production: No `EXPO_PUBLIC_DEV_MODE` → shows Google login screen

## 🌐 Signups Are Open (Public Launch)
- `SIGNUPS_DISABLED = false` (was `true` pre-launch)
- `ALLOWED_USERS = []` (empty = allow all Google accounts)
- To re-close the gate at runtime without a deploy:
  - Set `SIGNUPS_DISABLED=true` in `backend/.env` → blocks new signups
    (existing users still allowed)
  - OR set `ALLOWED_USERS_CSV=email1@x.com,email2@x.com` → only those
    emails can sign in


## Email/Password Auth (Fallback when Google OAuth is down)
- **Register**: `POST /api/auth/register-email` `{ "email": "...", "password": "...", "name": "..." }`
- **Login**: `POST /api/auth/login-email` `{ "email": "...", "password": "..." }`
- **Set password for Google user**: `POST /api/auth/set-password` `{ "password": "..." }` (requires auth session)
- Min password length: 6 characters
- Both flows return the same `session_token` shape as Google OAuth
- Frontend: "Can't sign in with Google? Use email" toggle on login screen

## 🎬 Reviewer / Test Account (Google Play submission)

**Account:** `routedreviewer@gmail.com`
**Password:** *(only needed if reviewer uses Google Sign-In — set it
when you create the Gmail account and store in your password manager)*

### 🚀 No-Google reviewer login (recommended for Play Store)

The login screen has a discreet **"Play Store reviewer? Tap to sign in"**
link below the benchmarks link. Tapping it opens a passcode prompt —
**no Google account required** (bypasses the captcha/lockout risk
Google reviewers commonly hit on unfamiliar Gmail accounts).

**Reviewer passcode (live in `backend/.env` as `REVIEWER_PASSCODE`):**
```
pwdBOwfl01Mydp_MXG2Qmwh96VzhyS8c
```

Backend endpoint: `POST /api/auth/reviewer-login` with body
`{"email": "routedreviewer@gmail.com", "passcode": "<above>"}`.
Returns a 7-day session token (prefixed `rvw_`) that downstream APIs
accept identically to a Google-issued token. Disabled entirely if
`REVIEWER_PASSCODE` is unset (returns 503).

To rotate the passcode:
```bash
# backend/.env
REVIEWER_PASSCODE=<new-strong-secret>
sudo supervisorctl restart backend
```
Then update the Play Console "App access" form with the new value.

The reviewer email is added to `REVIEWER_EMAILS` env var in `backend/.env`,
which:
- Auto-grants Pro subscription status (no Stripe charge)
- Bypasses the `require_pro` paywall on heavy optimization endpoints
- Shows `pro=true` in `/api/billing/status` so the UI doesn't show
  paywall banners
- **First sign-in seeds 6 demo Sydney stops** (Opera House, QVB,
  Surry Hills, Newtown, Bondi, Darling Harbour) so the reviewer can
  immediately tap **Optimize Route** without manual entry. Seeding is
  idempotent — re-logging-in won't duplicate the stops.

To add another reviewer (e.g. for an updated submission):
```bash
# backend/.env
REVIEWER_EMAILS=routedreviewer@gmail.com,reviewer2@gmail.com
sudo supervisorctl restart backend
```

## Dev User (sandbox only)
- user_id: `dev-user-123`
- email: `dev@example.com`

## Owner / Admin
- `xmltvg@gmail.com` (primary driver account, in `STRIPE_ADMIN_USER_IDS` for Pro bypass)
- `user_id`: `user_2a7d88cbb419`
- DB row also has `name="Adhamh McDonald"`

## Backend Infrastructure (post 2026-05-22 migration)
- **Production backend**: `https://routed.fly.dev` (Fly.io Sydney, always-on)
- **Atlas cluster**: M0 free, `ap-southeast-2 (Sydney)`, host `cluster0.ma8c8y1.mongodb.net`
- **Atlas DB user**: `routed-api`  (password rotated 2026-05-23 — current value lives only in Fly secret `MONGO_URL`; rotate again before sharing externally)
- **Live DB name**: `routed` (NOT `test_database` — that's the abandoned old name still showing in /app/backend/.env for local dev only)
- **Local dev** still uses `mongodb://localhost:27017` / DB `test_database` per `/app/backend/.env` (don't change — protected var)

## Paste-Ready Play Console "App access" Form

```
Group name:         Standard Reviewer Login
Username/email:     routedreviewer@gmail.com
Password:           [paste from password manager]
Login URL:          (leave blank — login is in-app via Google Sign-In)

Any other information:
1. Tap "Sign in with Google" on the launch screen.
2. Pick or enter routedreviewer@gmail.com.
3. The app loads with Pro features unlocked (no payment required —
   this account is allowlisted on the backend).
4. Map screen shows Australia by default — tap "Import" to load a
   CSV of test stops, or use the "Add stop" button to add a few
   manually.
5. To verify the optimization pipeline:
   - Add 5+ stops
   - Tap "Optimize Route"
   - Watch the polyline draw with numbered Sharpie pins
6. To verify ML features:
   - Pull up the bottom panel → "Profile" tab
   - Telemetry Card shows the geofence rate
   - ML Service-Time and ML Building-Side cards have "Train Now"
     buttons (data accumulates after ≥5 archived deliveries)
7. To verify privacy compliance:
   - Profile → Privacy & Terms → "Read full privacy policy" opens
     https://floating-map-ui.emergent.host/privacy in browser
```
