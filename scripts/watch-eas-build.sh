#!/usr/bin/env bash
# watch-eas-build.sh — poll an EAS build until done, print AAB download URL.
#
# Usage:
#   EXPO_TOKEN=expoaccesstoken_xxx bash /app/scripts/watch-eas-build.sh <build-id>
#   bash /app/scripts/watch-eas-build.sh                # uses last build for project
#
# Output: status every 30s + final AAB URL when done.

set -uo pipefail

BUILD_ID="${1:-}"
if [[ -z "$BUILD_ID" ]]; then
  cd /app/frontend
  BUILD_ID=$(eas build:list --platform android --limit 1 --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
  echo "Polling latest build: $BUILD_ID"
fi

cd /app/frontend
WATCH_URL="https://expo.dev/accounts/xxmltvguides-organization/projects/routed/builds/$BUILD_ID"
echo "Live dashboard: $WATCH_URL"
echo

while true; do
  OUT=$(eas build:view "$BUILD_ID" 2>&1 | grep -E "Status|Application Archive URL|Finished at")
  STATUS=$(echo "$OUT" | grep "Status" | awk '{print $2}')
  echo "[$(date '+%H:%M:%S')] status=$STATUS"

  case "$STATUS" in
    finished)
      echo
      echo "✓ Build finished"
      echo "$OUT" | grep "Application Archive URL"
      echo
      echo "Next: download the .aab from the URL above and upload to Play Console."
      exit 0
      ;;
    errored|canceled)
      echo
      echo "✗ Build $STATUS"
      eas build:view "$BUILD_ID" | tail -40
      exit 1
      ;;
  esac
  sleep 30
done
