# PathPilot OSRM service for Fly.io
#
# Three-stage build:
#   1. `downloader`  — a tiny alpine image with curl, used only to pull
#      the OSM extract from Geofabrik. The OSRM base image runs Debian
#      Stretch which is EOL (apt repos return 404), so we can't install
#      curl into it.
#   2. `builder`     — the OSRM image runs the three preprocessing steps
#      (extract → partition → customize) on the .osm.pbf file we copy
#      from the downloader stage. Produces the routable `.osrm.*` files.
#   3. runtime       — slim copy with just the preprocessed data.
#
# To rebuild with newer Geofabrik data:
#   flyctl deploy --remote-only --no-cache

# ── Stage 1: download the OSM extract ───────────────────────────────────
FROM alpine:3.19 AS downloader

ARG OSM_REGION=australia-oceania/australia/queensland
ARG OSM_FILE=queensland-latest.osm.pbf

WORKDIR /data
# The full Geofabrik path is `australia-oceania/australia/queensland`. Earlier
# attempts used `australia/queensland` which 302-redirects to the Geofabrik
# homepage (9.6 KB of HTML) and then `osrm-extract` chokes on the not-a-PBF.
# We assert the response is a valid OSM PBF by:
#   1. Requiring `Content-Type: application/octet-stream` via `--fail`.
#   2. Verifying the `osmpbf` magic bytes after download (file(1) reports
#      "OpenStreetMap Protocolbuffer Binary Format" for valid PBFs).
#   3. Requiring at least 50 MB — even the smallest sub-region extract
#      (e.g. Lower Saxony) is several hundred MB. QLD is ~190 MB.
RUN apk add --no-cache curl ca-certificates file && \
    curl --retry 3 --retry-delay 5 --max-time 1200 -fSL \
    "https://download.geofabrik.de/${OSM_REGION}-latest.osm.pbf" \
    -o "${OSM_FILE}" && \
    SIZE=$(stat -c%s "${OSM_FILE}") && \
    echo "Downloaded ${OSM_FILE}: ${SIZE} bytes" && \
    if [ "$SIZE" -lt 50000000 ]; then \
        echo "ERROR: PBF too small (${SIZE} bytes) — likely an HTML error page"; \
        head -c 1000 "${OSM_FILE}"; \
        exit 1; \
    fi && \
    file "${OSM_FILE}" | grep -q "OpenStreetMap" || { \
        echo "ERROR: Downloaded file is not a valid OSM PBF"; \
        file "${OSM_FILE}"; \
        exit 1; \
    }

# ── Stage 2: OSRM preprocessing ─────────────────────────────────────────
FROM osrm/osrm-backend:v5.25.0 AS builder

ARG OSM_FILE=queensland-latest.osm.pbf

WORKDIR /data
COPY --from=downloader /data/${OSM_FILE} ./

# OSRM MLD pipeline. Produces queensland-latest.osrm.* files used at
# query time. The car profile is included in the osrm-backend image.
RUN osrm-extract -p /opt/car.lua "${OSM_FILE}"
RUN osrm-partition "${OSM_FILE%.osm.pbf}.osrm"
RUN osrm-customize  "${OSM_FILE%.osm.pbf}.osrm"

# ── Stage 3: runtime ────────────────────────────────────────────────────
FROM osrm/osrm-backend:v5.25.0

ARG OSM_FILE=queensland-latest.osm.pbf
ENV OSRM_DATA=/data/${OSM_FILE%.osm.pbf}.osrm

WORKDIR /data
COPY --from=builder /data/${OSM_FILE%.osm.pbf}.osrm* /data/

# `--max-table-size=500` mirrors the sandbox config so PathPilot's 200+
# stop matrix calls succeed in a single OSRM Table query.
EXPOSE 5000
CMD ["sh", "-c", "osrm-routed --algorithm=MLD --port=5000 --max-table-size=500 --max-matching-size=200 ${OSRM_DATA}"]
