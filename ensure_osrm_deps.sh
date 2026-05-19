#!/bin/bash
# Ensure OSRM dependencies are installed and ready BEFORE osrm-routed launches.
#
# Why this script exists:
#   On every fork/reboot of the Emergent container, the dpkg metadata can be
#   wiped while cached binaries on the PATH stay in place. The naive check
#   `ldconfig -p | grep libboost...` is fooled by stale linker cache, and
#   apt-get can fail at boot due to dpkg-lock contention (cloud-init and
#   other apt processes running concurrently). When apt fails, the previous
#   version of this script propagated the non-zero exit code through the
#   supervisor `&&` chain — osrm-routed never launched, supervisor gave up
#   after 4 sub-second retries, and the err log was 0 bytes (because the
#   binary itself was never executed).
#
# Hardening (2026-04-25):
#   1. Validate the actual *binary loadability* via `ldd ... | grep "not
#      found"` rather than relying on ldconfig cache.
#   2. Retry apt-get up to 8× with exponential backoff when dpkg is locked.
#   3. Re-verify after install; if libs still missing, log loudly to a
#      dedicated /var/log file so we can see *why* OSRM didn't start next
#      time. Exit 0 anyway — let osrm-routed crash with its own stderr so
#      we have a real signal in /var/log/supervisor/osrm.err.log.
#   4. Idempotent — re-running when everything is already in place is a no-op.

LOG=/var/log/osrm_deps.log
mkdir -p "$(dirname "$LOG")"
exec >> "$LOG" 2>&1
echo
echo "[$(date -Iseconds)] ensure_osrm_deps.sh starting (PID $$)"

OSRM_BIN=/app/osrm-backend/build/osrm-routed
REQUIRED_PKGS=(
    libboost-program-options1.74.0
    libboost-filesystem1.74.0
    libboost-iostreams1.74.0
    libboost-thread1.74.0
)

# ── Probe: are the libraries actually loadable by the OSRM binary? ────────
binary_links_ok() {
    [ -x "$OSRM_BIN" ] || return 1
    # `ldd` returns the resolved path of every dynamic dep. Any "not found"
    # line is fatal for runtime loading. This catches both missing libs and
    # broken symlinks that ldconfig might not.
    if ldd "$OSRM_BIN" 2>/dev/null | grep -q 'not found'; then
        echo "[$(date -Iseconds)] ldd reports unresolved libs:"
        ldd "$OSRM_BIN" 2>/dev/null | grep 'not found'
        return 1
    fi
    return 0
}

if binary_links_ok; then
    echo "[$(date -Iseconds)] OSRM binary links cleanly — no apt action needed"
    exit 0
fi

# ── Need to install. Retry until dpkg-lock clears. ────────────────────────
echo "[$(date -Iseconds)] OSRM binary has unresolved libs — installing boost packages"

for attempt in 1 2 3 4 5 6 7 8; do
    echo "[$(date -Iseconds)] apt-get install attempt #$attempt"
    if apt-get install -y --no-install-recommends "${REQUIRED_PKGS[@]}"; then
        echo "[$(date -Iseconds)] apt-get install succeeded"
        break
    fi
    rc=$?
    echo "[$(date -Iseconds)] apt-get failed (rc=$rc) — likely dpkg lock; sleeping $((attempt * 2))s"
    sleep $((attempt * 2))
done

# ── Final re-verify. Don't fail-out the wrapper either way: let osrm-routed
#    print its own actionable error if libs are still missing. ────────────
if binary_links_ok; then
    echo "[$(date -Iseconds)] OSRM binary now links cleanly — OK"
else
    echo "[$(date -Iseconds)] WARNING: OSRM still has unresolved libs after install."
    echo "[$(date -Iseconds)] osrm-routed will likely fail; check its stderr next."
fi

# Always exit 0 — the supervisor chain `&& exec osrm-routed` should proceed
# so the binary's own stderr lands in /var/log/supervisor/osrm.err.log and
# gives us a real signal next time, instead of a silent "exit status 100".
exit 0
