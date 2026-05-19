#!/usr/bin/env bash
# Pre-commit sanity checks.
#
# 1. Warn when backend/server.py exceeds the refactor threshold — nudges
#    toward pulling the next domain into backend/routes/ (see ROUTES.md).
# 2. Run the resume-navigation unit test — catches regressions in the
#    stop-ID-resume logic in ~50 ms before they ship to drivers.
#
# Install:
#   ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
# Or copy:
#   cp scripts/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

set -eu

THRESHOLD=7500
SERVER_PY="backend/server.py"
RESUME_TEST="frontend/scripts/test-resume-navigation.js"
BACKEND_PYTEST="backend/tests/test_routes_stops.py"

# ── 1. Size warning for server.py ──────────────────────────────────────────
if [ -f "$SERVER_PY" ]; then
  LINES=$(wc -l < "$SERVER_PY" | tr -d ' ')
  if [ "$LINES" -gt "$THRESHOLD" ]; then
    printf >&2 '\n\033[33m⚠  %s is %d lines (>%d).\033[0m\n' "$SERVER_PY" "$LINES" "$THRESHOLD"
    printf >&2 '   Consider pulling the next domain into backend/routes/\n'
    printf >&2 '   See: backend/routes/ROUTES.md (pending: stops, routing, exports)\n\n'
  fi
fi

# ── 2. Unit test the resume-navigation helper (must stay green) ────────────
# Blocks the commit on failure — the logic ships to drivers via OTA and a
# regression bounces them back to stop 0 on every re-entry.
if [ -f "$RESUME_TEST" ] && command -v node >/dev/null 2>&1; then
  if ! node "$RESUME_TEST" > /dev/null 2>&1; then
    printf >&2 '\n\033[31m✗ resume-navigation unit test failed.\033[0m\n'
    printf >&2 '  Run: node %s\n' "$RESUME_TEST"
    printf >&2 '  Commit blocked. Fix the test or the helper before committing.\n\n'
    exit 1
  fi
fi

# ── 3. Backend stops-router regression suite (in-process, ~5 s) ───────────
# If python + pytest are on PATH and the test file exists, run it. Quiet
# success, loud failure — mirrors the frontend unit-test behaviour above.
if [ -f "$BACKEND_PYTEST" ] && command -v python >/dev/null 2>&1; then
  if ! ( cd backend && python -m pytest "tests/$(basename "$BACKEND_PYTEST")" -q --no-header --tb=line > /tmp/precommit-pytest.log 2>&1 ); then
    printf >&2 '\n\033[31m✗ backend stops-router tests failed.\033[0m\n'
    printf >&2 '  See: /tmp/precommit-pytest.log\n'
    printf >&2 '  Run: cd backend && python -m pytest %s -q\n' "tests/$(basename "$BACKEND_PYTEST")"
    exit 1
  fi
fi

exit 0
