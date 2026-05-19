#!/bin/bash
# Ensure EAS build deps are installed. The ARM64 container ships without
# `qemu-user-static`, but `eas update` needs it to run the x86_64 `hermesc`
# binary when compiling the JS bundle to bytecode. Without this, every OTA
# push fails with an ELF architecture error until we reinstall manually.
#
# 2026-04-23: upgraded from "install if missing" to ALWAYS-RUN apt-get so a
# container rebuild that wipes /var/lib/dpkg (leaving a stale binary on the
# PATH) can't leave us in a half-installed state. apt-get is a no-op when
# the package is already current, so this is cheap.
#
# Idempotent — re-running when everything is already in place is a no-op.
set -e

# Always ensure the package is installed even if a binary happens to exist —
# covers the "binary cached, dpkg metadata wiped" edge case seen after forks.
echo "[ensure_eas_deps] ensuring qemu-user-static is installed…"
apt-get install -y qemu-user-static > /dev/null 2>&1 || {
    echo "[ensure_eas_deps] apt-get install failed (network?) — continuing"
}

HERMESC_DIR=/app/frontend/node_modules/react-native/sdks/hermesc/linux64-bin
if [ -x "$HERMESC_DIR/hermesc" ]; then
    # The patched shim starts with '#!/bin/sh'; the raw ELF binary starts
    # with '\x7fELF'. Re-wrap whenever the raw ELF is back (e.g. after a
    # `yarn install` or node_modules rehydration overwrote our shim).
    if ! head -c 4 "$HERMESC_DIR/hermesc" | grep -q '#!'; then
        echo "[ensure_eas_deps] wrapping hermesc with qemu shim…"
        node /app/frontend/scripts/patch-hermesc-arm64.js > /dev/null 2>&1 || true
    fi
fi

echo "[ensure_eas_deps] OK"
