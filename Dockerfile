# ============================================================
# RouTeD backend — Railway deployment
# Build context: repo root (Railway uploads the whole project)
# Railway auto-detects this file at the repo root.
# ============================================================

# ---------- Stage 1: builder ----------
FROM python:3.11-slim AS builder

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=180 \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential gcc g++ curl git libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY backend/requirements.txt ./

# lkh==2.0.0 pins Click<7 (conflicts with black/litellm/uvicorn);
# install with --no-deps first then the rest without lkh in the file.
# emergentintegrations lives on Emergent's CloudFront index, not PyPI.
RUN pip install --upgrade pip \
 && pip install --no-deps lkh==2.0.0 \
 && grep -v '^lkh==' requirements.txt > /tmp/req-no-lkh.txt \
 && pip install \
        --extra-index-url https://d33sy5i8bnduwe.cloudfront.net/simple/ \
        -r /tmp/req-no-lkh.txt

# ---------- Stage 2: runtime ----------
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH" \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 default-jre-headless curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY backend/ ./
COPY tiles/buildings.db /app/tiles/buildings.db

# Railway injects $PORT at runtime. We strip any non-digit chars
# defensively (saved us on Fly when "8080." crept in via a typo).
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port $(echo ${PORT:-8080} | tr -cd '0-9') --proxy-headers --forwarded-allow-ips=*"]
