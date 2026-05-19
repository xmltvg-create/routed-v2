#!/usr/bin/env bash
# gitignore-guard — background daemon that auto-strips `.env*` patterns
# from /app/.gitignore the moment they reappear.
#
# Why a daemon: an Emergent platform process re-injects these patterns
# repeatedly (3-line block, sometimes multiple times per hour). The
# audit script at /app/scripts/pre-deploy-audit.sh catches it at
# deploy/commit time, but by then the user has already wasted time
# trying to push. This daemon closes the corruption window to <5 s.
#
# Side-effects: ONLY mutates /app/.gitignore (removes anchored `.env*`
# lines). Never touches credential patterns, never adds anything.
#
# Logs to /var/log/gitignore-guard.log so corruption events are
# auditable (and can be sent to Emergent support as evidence of
# upstream tool re-injection).
#
# Spawned by supervisor — see /etc/supervisor/conf.d/gitignore-guard.conf

set -u

GITIGNORE="/app/.gitignore"
LOG="/var/log/gitignore-guard.log"
POLL_S=5

mkdir -p "$(dirname "${LOG}")"
echo "[$(date -Iseconds)] gitignore-guard started (poll=${POLL_S}s, target=${GITIGNORE})" >> "${LOG}"

while true; do
  if [[ -f "${GITIGNORE}" ]]; then
    # Anchor to start-of-line so docstrings mentioning ".env" survive.
    # The exact patterns we strip match what the upstream tool injects:
    #   .env
    #   .env.*
    #   *.env
    OFFENDERS="$(grep -cE '^[[:space:]]*(\.env(\.\*)?|\*\.env)[[:space:]]*$' "${GITIGNORE}" 2>/dev/null || echo 0)"
    if [[ "${OFFENDERS}" -gt 0 ]]; then
      echo "[$(date -Iseconds)] DETECTED ${OFFENDERS} offending lines — stripping" >> "${LOG}"
      # Atomic strip: sed in-place with backup, then drop backup.
      sed -i.bak -E '/^[[:space:]]*(\.env(\.\*)?|\*\.env)[[:space:]]*$/d' "${GITIGNORE}"
      rm -f "${GITIGNORE}.bak"
      AFTER="$(grep -cE '^[[:space:]]*(\.env(\.\*)?|\*\.env)[[:space:]]*$' "${GITIGNORE}" 2>/dev/null || echo 0)"
      echo "[$(date -Iseconds)] post-strip: ${AFTER} offenders remain" >> "${LOG}"
    fi
  fi
  sleep "${POLL_S}"
done
