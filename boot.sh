#!/bin/bash
# Production boot script — ensures all runtime dependencies are present
# Run this on container start: bash /app/boot.sh

echo "[boot] Installing OSRM runtime dependencies..."
apt-get update -qq 2>/dev/null
apt-get install -y --no-install-recommends \
  libboost-program-options1.74.0 \
  libboost-filesystem1.74.0 \
  libboost-iostreams1.74.0 \
  libboost-thread1.74.0 \
  libboost-regex1.74.0 \
  libtbb12 \
  > /dev/null 2>&1 || echo "[boot] WARNING: Could not install boost deps (non-fatal)"

echo "[boot] Verifying OSRM binary..."
if [ ! -f /app/osrm-backend/build/osrm-routed ]; then
  echo "[boot] WARNING: OSRM binary not found — local routing will fall back to public OSRM"
fi

echo "[boot] Verifying LKH-3 binary..."
if [ ! -f /usr/local/bin/LKH ]; then
  echo "[boot] WARNING: LKH-3 binary not found — LKH post-processing will be disabled"
fi

echo "[boot] Verifying OSRM data..."
if [ ! -f /app/queensland.osrm.ebg ]; then
  echo "[boot] WARNING: OSRM processed data not found — local routing unavailable"
fi

# Only start OSRM if binary AND data exist
if [ -f /app/osrm-backend/build/osrm-routed ] && [ -f /app/queensland.osrm.ebg ]; then
  echo "[boot] Starting OSRM via supervisor..."
  supervisorctl reread > /dev/null 2>&1
  supervisorctl update > /dev/null 2>&1
  supervisorctl start osrm 2>/dev/null || supervisorctl restart osrm

  for i in $(seq 1 10); do
    if curl -s http://localhost:5000/table/v1/driving/153.1,-26.75 > /dev/null 2>&1; then
      echo "[boot] OSRM is ready on port 5000"
      break
    fi
    sleep 1
  done
else
  echo "[boot] Skipping OSRM start (missing binary or data)"
fi

echo "[boot] Done. Production services initialized."
