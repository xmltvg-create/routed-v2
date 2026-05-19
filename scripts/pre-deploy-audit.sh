#!/usr/bin/env bash
# Pre-deploy audit — runs on every deploy to prevent the `.gitignore`
# self-healing-to-broken bug from silently rolling back production.
#
# Background: The `deployment_agent` tool repeatedly re-injects `.env`,
# `.env.*`, and `*.env` patterns into /app/.gitignore. When those
# patterns are present, Emergent's deploy bundle strips the .env files
# the production pod needs, and the deploy silently rolls back to the
# previous image (no error surfaced; users see "endpoint not found"
# 404/405 because their latest code never shipped). This script catches
# that state BEFORE a deploy goes out.
#
# Exit codes:
#   0  ✓  Clean — safe to deploy.
#   1  ✗  Found one or more `.env*` patterns — deploy will silently
#         drop env files. Remove them from .gitignore first.
#   2  ✗  /app/.gitignore is missing — should never happen on a
#         healthy repo; bail loudly.
#
# Usage:
#   bash /app/scripts/pre-deploy-audit.sh
#   # or wire into a deploy hook / pre-commit:
#   #   yarn pre-deploy-audit
#
# Side-effects: NONE. Read-only audit. Safe to run anywhere.

set -euo pipefail

GITIGNORE="/app/.gitignore"

if [[ ! -f "${GITIGNORE}" ]]; then
  echo "✗ pre-deploy-audit: ${GITIGNORE} is missing." >&2
  exit 2
fi

# Match the three patterns the deployment_agent has been observed to
# inject. We anchor to start-of-line to avoid false positives on
# comments that legitimately contain ".env" as documentation.
OFFENDERS="$(grep -nE '^[[:space:]]*(\.env(\.\*)?|\*\.env)[[:space:]]*$' "${GITIGNORE}" || true)"

if [[ -n "${OFFENDERS}" ]]; then
  echo "" >&2
  echo "╔══════════════════════════════════════════════════════════════════╗" >&2
  echo "║  ✗ DEPLOY BLOCKED — .gitignore is excluding .env files         ║" >&2
  echo "╚══════════════════════════════════════════════════════════════════╝" >&2
  echo "" >&2
  echo "Production needs the .env files to be present in the deploy bundle." >&2
  echo "Found these offending patterns in ${GITIGNORE}:" >&2
  echo "" >&2
  echo "${OFFENDERS}" | sed 's/^/    /' >&2
  echo "" >&2
  echo "→ Remove these lines and re-run the deploy." >&2
  echo "→ If deployment_agent re-added them, see the warning block in" >&2
  echo "  .gitignore — do NOT run that agent again until the upstream" >&2
  echo "  bug is fixed." >&2
  echo "" >&2
  exit 1
fi

echo "✓ pre-deploy-audit: .gitignore is clean — safe to deploy."
exit 0
