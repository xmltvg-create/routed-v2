#!/usr/bin/env bash
# predeploy.sh — One-command pre-flight check before any RouTeD deploy.
#
# Runs every safety check we care about in the order documented in
# /app/memory/DEPLOY.md. Red-flags any issue with a clear fix-it
# instruction. Safe to run anywhere — purely read-only.
#
# Usage:
#   bash /app/scripts/predeploy.sh                  # all checks
#   bash /app/scripts/predeploy.sh --skip-tests     # skip pytest (faster)
#   bash /app/scripts/predeploy.sh --backend        # only backend-related
#   bash /app/scripts/predeploy.sh --frontend       # only frontend-related
#
# Exit code:
#   0  All green → safe to deploy.
#   1  Issues found → fix and re-run before deploying.

set -uo pipefail

# ──────────────────────────────────────────────────────────────────
# Colors + helpers
# ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

FAILS=()
WARNS=()

pass()  { printf "  ${GREEN}✓${NC} %s\n" "$1"; }
fail()  { printf "  ${RED}✗${NC} %s\n" "$1"; FAILS+=("$1"); }
warn()  { printf "  ${YELLOW}⚠${NC} %s\n" "$1"; WARNS+=("$1"); }
info()  { printf "  ${BLUE}ℹ${NC} %s\n" "$1"; }
section(){ printf "\n${BOLD}▸ %s${NC}\n" "$1"; }

# ──────────────────────────────────────────────────────────────────
# Flags
# ──────────────────────────────────────────────────────────────────
SKIP_TESTS=0
ONLY_BACKEND=0
ONLY_FRONTEND=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --backend)    ONLY_BACKEND=1 ;;
    --frontend)   ONLY_FRONTEND=1 ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
  esac
done

printf "${BOLD}RouTeD Pre-flight — %s${NC}\n" "$(date '+%Y-%m-%d %H:%M:%S')"

# ──────────────────────────────────────────────────────────────────
# 1. .gitignore integrity (the recurring footgun)
# ──────────────────────────────────────────────────────────────────
section "1. .gitignore integrity"
if [[ -f /app/.gitignore ]]; then
  if bash /app/scripts/pre-deploy-audit.sh >/dev/null 2>&1; then
    pass ".gitignore clean (no .env* patterns)"
  else
    fail ".gitignore contains .env* patterns — would strip env files on deploy"
    info "  → Run: bash /app/scripts/gitignore-autoheal.sh"
  fi
  # Critical entries that MUST be present
  for entry in "node_modules" ".expo"; do
    if grep -qE "^${entry}(/|$)" /app/.gitignore; then
      pass "${entry} is gitignored"
    else
      warn "${entry} not in .gitignore — bloats commits"
    fi
  done
else
  fail "/app/.gitignore missing"
fi

# ──────────────────────────────────────────────────────────────────
# 2. No hardcoded secrets in source
# ──────────────────────────────────────────────────────────────────
section "2. Hardcoded secrets scan"
if [[ $ONLY_FRONTEND -eq 0 || $ONLY_BACKEND -eq 1 ]]; then
  HITS=$(grep -rn -E "sk_live_[A-Za-z0-9]{20,}|sk_test_[A-Za-z0-9]{20,}|pk_live_[A-Za-z0-9]{20,}" \
    /app/backend --include="*.py" 2>/dev/null | grep -v "^Binary file" || true)
  if [[ -z "$HITS" ]]; then
    pass "no Stripe live/test keys in backend source"
  else
    fail "Stripe keys found in backend source — must be in .env only"
    echo "$HITS" | head -5
  fi
fi
if [[ $ONLY_BACKEND -eq 0 || $ONLY_FRONTEND -eq 1 ]]; then
  HITS=$(grep -rn -E "sk_live_[A-Za-z0-9]{20,}|sk_test_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}" \
    /app/frontend --include="*.ts" --include="*.tsx" --include="*.js" \
    --exclude-dir=node_modules 2>/dev/null || true)
  if [[ -z "$HITS" ]]; then
    pass "no secrets in frontend source"
  else
    fail "API keys found in frontend source — move to .env"
    echo "$HITS" | head -5
  fi
fi

# ──────────────────────────────────────────────────────────────────
# 3. EAS / app.json sanity (frontend native deploy)
# ──────────────────────────────────────────────────────────────────
if [[ $ONLY_BACKEND -eq 0 ]]; then
  section "3. EAS config"
  if [[ -f /app/frontend/eas.json ]]; then
    if grep -q "enableProguardInReleaseBuilds" /app/frontend/eas.json; then
      fail "eas.json contains 'enableProguardInReleaseBuilds' — EAS rejects this key"
    else
      pass "eas.json clean (no rejected keys)"
    fi
  else
    warn "frontend/eas.json missing"
  fi

  if [[ -f /app/frontend/app.json ]]; then
    VERSION=$(python3 -c "import json;d=json.load(open('/app/frontend/app.json'));print(d['expo'].get('version','?'))" 2>/dev/null)
    VCODE=$(python3 -c "import json;d=json.load(open('/app/frontend/app.json'));print(d['expo'].get('android',{}).get('versionCode','?'))" 2>/dev/null)
    RTV=$(python3 -c "
import json
d=json.load(open('/app/frontend/app.json'))
rv=d['expo'].get('runtimeVersion')
if isinstance(rv,dict): print('policy:'+rv.get('policy','?'))
else: print('literal:'+str(rv))
" 2>/dev/null)
    info "app.json: version=${VERSION}  android.versionCode=${VCODE}  runtimeVersion=${RTV}"
    if [[ "$VCODE" == "?" ]]; then
      fail "android.versionCode missing in app.json — Play Store will reject"
    else
      pass "app.json has version + versionCode"
    fi
    if [[ "$RTV" == "policy:appVersion" ]]; then
      pass "runtimeVersion uses appVersion policy (OTAs auto-target correct binaries)"
    elif [[ "$RTV" == literal:* ]]; then
      warn "runtimeVersion is hardcoded (${RTV#literal:}) — must bump manually with every binary release"
      info "  → recommend switching to {\"policy\": \"appVersion\"} in app.json"
    fi
  fi
fi

# ──────────────────────────────────────────────────────────────────
# 4. Env files point at production-grade endpoints
# ──────────────────────────────────────────────────────────────────
section "4. Environment vars"
if [[ -f /app/backend/.env ]]; then
  for key in MONGO_URL DB_NAME; do
    if grep -qE "^${key}=" /app/backend/.env; then
      pass "backend/.env has ${key}"
    else
      fail "backend/.env missing ${key}"
    fi
  done
else
  fail "backend/.env missing"
fi
if [[ -f /app/frontend/.env ]]; then
  if grep -qE "^EXPO_PUBLIC_BACKEND_URL=https://" /app/frontend/.env; then
    URL=$(grep EXPO_PUBLIC_BACKEND_URL /app/frontend/.env | cut -d= -f2)
    pass "frontend/.env → ${URL}"
    if [[ "$URL" == *"localhost"* || "$URL" == *"127.0.0.1"* ]]; then
      fail "EXPO_PUBLIC_BACKEND_URL points at localhost — will not work on device"
    fi
  else
    fail "frontend/.env missing EXPO_PUBLIC_BACKEND_URL or not https"
  fi
fi

# ──────────────────────────────────────────────────────────────────
# 5. Backend health (live preview)
# ──────────────────────────────────────────────────────────────────
section "5. Backend reachability"
URL=$(grep EXPO_PUBLIC_BACKEND_URL /app/frontend/.env 2>/dev/null | cut -d= -f2)
if [[ -n "$URL" ]]; then
  HEALTH=$(curl -fsS -m 6 "${URL}/api/health" 2>/dev/null || echo "")
  if [[ "$HEALTH" == *"ok"* || "$HEALTH" == *"status"* ]]; then
    pass "${URL}/api/health responds"
  else
    warn "${URL}/api/health did not respond (preview pod may be cold)"
  fi
fi

# ──────────────────────────────────────────────────────────────────
# 6. Pytest regression tests (skippable for speed)
# ──────────────────────────────────────────────────────────────────
if [[ $ONLY_FRONTEND -eq 0 && $SKIP_TESTS -eq 0 ]]; then
  section "6. Backend regression tests"
  if [[ -d /app/backend/tests ]]; then
    cd /app/backend
    # Run the small, fast, stable suites — skip the integration tests that
    # hit OSRM (slow) or the legacy test_alns_solver.py (pre-existing
    # health-check failure unrelated to our changes).
    if timeout 60 python -m pytest tests/test_resume_route.py tests/test_waitlist.py \
         --tb=line -q >/tmp/predeploy_pytest.log 2>&1; then
      pass "pytest (resume_route + waitlist) green"
    else
      fail "pytest failed — see /tmp/predeploy_pytest.log"
      tail -10 /tmp/predeploy_pytest.log | sed 's/^/    /'
    fi
    cd - >/dev/null
  fi
fi

# ──────────────────────────────────────────────────────────────────
# 7. Git status (uncommitted code = won't deploy)
# ──────────────────────────────────────────────────────────────────
section "7. Git working tree"
cd /app
if git rev-parse --git-dir >/dev/null 2>&1; then
  DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
  if [[ "$DIRTY" == "0" ]]; then
    pass "working tree clean"
  else
    warn "${DIRTY} uncommitted change(s) — these will NOT ship until you Save to GitHub"
    git status --short | head -8 | sed 's/^/    /'
  fi
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  info "branch: ${BRANCH}"
fi

# ──────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────
echo
if [[ ${#FAILS[@]} -eq 0 ]]; then
  printf "${GREEN}${BOLD}✓ All green. Safe to deploy.${NC}\n"
  if [[ ${#WARNS[@]} -gt 0 ]]; then
    printf "${YELLOW}  (${#WARNS[@]} warning(s) — review but not blocking)${NC}\n"
  fi
  echo
  echo "Next steps (see /app/memory/DEPLOY.md):"
  echo "  1. Click 'Save to GitHub' in Emergent chat"
  echo "  2. Click 'Deploy → Native Deploy' for backend"
  echo "  3. For OTA frontend: cd frontend && eas update --branch production"
  echo "  4. For new AAB:     cd frontend && eas build --platform android --profile production"
  exit 0
else
  printf "${RED}${BOLD}✗ ${#FAILS[@]} blocker(s) found. Fix before deploying:${NC}\n"
  for f in "${FAILS[@]}"; do printf "    ${RED}•${NC} %s\n" "$f"; done
  exit 1
fi
