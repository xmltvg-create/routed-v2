#!/usr/bin/env bash
# deploy-fly.sh — one-shot Fly.io secrets + deploy for RouTeD backend.
#
# Usage:
#   MONGO_URL=... DB_NAME=... EMERGENT_LLM_KEY=... [other vars] ./deploy-fly.sh
#
# Required vars (will refuse to deploy if missing):
#   MONGO_URL, DB_NAME, EMERGENT_LLM_KEY
#
# Optional vars (only set on Fly if exported — leaves existing secret untouched
# if you don't pass it this run):
#   MAPBOX_TOKEN, GENEROUTE_API_KEY, OSRM_URL_PROD,
#   STRIPE_API_KEY, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL,
#   STRIPE_WEBHOOK_SECRET, STRIPE_ADMIN_USER_IDS,
#   STRIPE_CHECKOUT_SUCCESS_URL, STRIPE_CHECKOUT_CANCEL_URL,
#   REVIEWER_EMAILS, REVIEWER_PASSCODE,
#   DEV_MODE, ENABLE_TIMEFOLD, TILE_CACHE_ADMIN_TOKEN,
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,
#   SIGNUPS_DISABLED, ALLOWED_USERS_CSV
#
# Run from /app/backend (or wherever Dockerfile.flyio + fly.toml live).

set -euo pipefail

# --- sanity ---------------------------------------------------------------
command -v flyctl >/dev/null 2>&1 || {
  echo "❌ flyctl not found. Install: https://fly.io/docs/hands-on/install-flyctl/"
  exit 1
}
[[ -f Dockerfile.flyio ]] || { echo "❌ Run me from the backend folder (Dockerfile.flyio missing)"; exit 1; }
[[ -f fly.toml ]]         || { echo "❌ fly.toml missing — run 'fly launch --no-deploy --copy-config' first"; exit 1; }

REQUIRED=(MONGO_URL DB_NAME EMERGENT_LLM_KEY)
for v in "${REQUIRED[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "❌ Missing required env var: $v"
    echo "   Re-run with:  $v='...' ./deploy-fly.sh"
    exit 1
  fi
done

# --- collect all the names we MIGHT push -----------------------------------
ALL_VARS=(
  MONGO_URL DB_NAME EMERGENT_LLM_KEY
  MAPBOX_TOKEN GENEROUTE_API_KEY OSRM_URL OSRM_URL_PROD OSRM_PUBLIC_URL
  STRIPE_API_KEY STRIPE_PRICE_MONTHLY STRIPE_PRICE_ANNUAL
  STRIPE_WEBHOOK_SECRET STRIPE_ADMIN_USER_IDS
  STRIPE_CHECKOUT_SUCCESS_URL STRIPE_CHECKOUT_CANCEL_URL
  REVIEWER_EMAILS REVIEWER_PASSCODE
  DEV_MODE ENABLE_TIMEFOLD TILE_CACHE_ADMIN_TOKEN
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION
  SIGNUPS_DISABLED ALLOWED_USERS_CSV
)

# --- build flyctl secrets set args ----------------------------------------
SECRET_ARGS=()
echo "🔑 Setting Fly secrets for:"
for v in "${ALL_VARS[@]}"; do
  if [[ -n "${!v:-}" ]]; then
    echo "   • $v"
    SECRET_ARGS+=("$v=${!v}")
  fi
done

if [[ ${#SECRET_ARGS[@]} -gt 0 ]]; then
  # --stage = don't trigger an immediate deploy; we'll deploy ourselves below
  flyctl secrets set --stage "${SECRET_ARGS[@]}"
fi

# --- deploy ----------------------------------------------------------------
echo ""
echo "🚀 Deploying with Dockerfile.flyio ..."
flyctl deploy --dockerfile Dockerfile.flyio --remote-only

# --- post-deploy smoke -----------------------------------------------------
APP_NAME=$(grep -E '^app = ' fly.toml | sed -E 's/app = "([^"]+)"/\1/')
URL="https://${APP_NAME}.fly.dev"

echo ""
echo "✅ Deploy complete."
echo "   App URL:    $URL"
echo "   Health:     curl $URL/health"
echo ""
echo "📜 Tailing logs for 30s (Ctrl-C to exit early)..."
timeout 30 flyctl logs || true

echo ""
echo "▶ Next: point frontend/.env  EXPO_PUBLIC_BACKEND_URL=$URL  and rebuild EAS APK."
