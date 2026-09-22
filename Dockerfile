# Multi-stage Dockerfile for AI Smart Face & Lock Gateway
#
# Base image: Debian bookworm-slim (glibc). The previous Alpine (musl) base
# cannot load onnxruntime-node, which only ships glibc prebuilt binaries, so
# the whole pipeline (builder -> tester -> runner) runs on the same glibc base.
# Node 22 provides the built-in native SQLite engine (node:sqlite).
#
# Build args:
#   APP_UID / APP_GID  uid/gid the app runs as inside the container (default
#                      1000 = the stock `node` user). Set them to the HOST user
#                      that owns ./data (`id -u` / `id -g`) so the bind-mounted
#                      SQLite database and JSON fallback are writable. Compose
#                      forwards APP_UID / APP_GID from .env automatically.
# Static ffmpeg 8 (pinned by digest). Debian bookworm only packages ffmpeg 5.1,
# whose HEVC decoder emits a flat grey frame before the first keyframe and
# whose dependency tree adds ~475 MB. ffmpeg 8 is what the RTSP paths were
# validated against (16 Sep 2026); the static build has no runtime deps.
FROM mwader/static-ffmpeg:8.0.1@sha256:252705ff88532fa338e7065c21792756552f8fe7c212f84bc503d3c340689594 AS ffmpeg

# ----------------- Face Model Stage -----------------
# InsightFace `buffalo_l` bundle: downloaded ONCE here and cached as its own
# layer, so editing application source never re-pulls 288 MB. Only the two
# models src/server/faceEmbedding.ts actually loads are extracted:
#   det_10g.onnx    17 MB  SCRFD face detector, 640x640 input
#   w600k_r50.onnx 174 MB  ArcFace r50 recogniser, 112x112 -> 512-D
# The archive's other three files (1k3d68, 2d106det, genderage) are dense
# landmark and attribute models this pipeline never loads, so they are left in
# the build cache rather than shipped.
FROM node:22-bookworm-slim AS models
ARG BUFFALO_L_URL=https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /models \
    && curl -fsSL -o /tmp/buffalo_l.zip "$BUFFALO_L_URL" \
    && unzip -o -j /tmp/buffalo_l.zip '*det_10g.onnx' '*w600k_r50.onnx' -d /models \
    && rm -f /tmp/buffalo_l.zip \
    && ls -l /models

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Deterministic dependency install; package-lock.json is authoritative.
RUN npm ci --no-audit --no-fund

# Copy source files
COPY . .

# Build Vite frontend & Bundle backend into dist/server.cjs
RUN npm run build

# ----------------- Test Stage -----------------
# Unit tests reuse the builder stage, which already has devDependencies (tsx)
# installed, so no separate install is needed. This stage deliberately sits
# BEFORE the runner stage so that a plain `docker build` still targets runner.
#   docker compose --profile test run --rm tests
#   docker build --target tester -t smartface-tests . && docker run --rm smartface-tests
FROM builder AS tester
ENV NODE_ENV=test
# tests/faceEmbedding.test.ts exercises the real ffmpeg decode path (JPEG in ->
# raw RGB out). Without the binary those cases self-skip, which would silently
# stop covering decodeToRgb, so the tester gets the same static ffmpeg the
# runner uses. The ONNX models are deliberately NOT copied here: the unit suite
# must prove it stays green on a model-less image.
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
CMD ["npm", "test"]

# ----------------- Production Stage -----------------
FROM node:22-bookworm-slim AS runner

ARG APP_UID=1000
ARG APP_GID=1000

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install runtime dependencies:
# - ffmpeg: required for RTSP video stream transcoding, snapshot capture, and frame extraction
# - ca-certificates: required for secure HTTPS webhooks and external APIs
# - tzdata: ensures correct timezone timestamps (e.g. Asia/Ho_Chi_Minh)
# ffmpeg is copied from the pinned static image above, not installed from apt.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg

# Remap the stock `node` user (uid/gid 1000) to APP_UID/APP_GID so files the app
# writes into the bind-mounted /app/data belong to the host user, and files the
# host user owns are writable from inside the container. No-op when both are 1000.
RUN if [ "$APP_GID" != "1000" ]; then groupmod -g "$APP_GID" node; fi \
    && if [ "$APP_UID" != "1000" ]; then usermod -u "$APP_UID" -g "$APP_GID" node; fi \
    && chown -R node:node /home/node

# Create the app tree (incl. the persistent SQLite data directory) owned by the
# app user BEFORE anything is copied in. Installing as `node` and copying with
# --chown means no trailing `chown -R /app`, which would otherwise duplicate the
# whole node_modules layer (~240 MB) in the image.
RUN mkdir -p /app/data && chown -R node:node /app

# Run as non-root user for security
USER node

# Copy package files
COPY --chown=node:node package*.json ./

# Install only production dependencies
# onnxruntime-node ships one package for every platform AND every execution
# provider, which is ~548 MB installed. Two slices of that are dead weight here
# and are deleted in the SAME layer as the install (a later RUN would only
# whiteout them and keep the bytes in the image):
#
#   1. GPU providers — libonnxruntime_providers_cuda.so (260 MiB) and
#      _tensorrt.so (1 MiB). This gateway is CPU-only; faceEmbedding.ts asks for
#      the "cpu" execution provider explicitly.
#   2. Foreign platform binaries (~242 MB) — darwin/arm64, win32/x64,
#      win32/arm64 and the non-native linux arch. A container image is built for
#      exactly one platform, so only the one matching this stage's own Node can
#      ever load. `node -p process.platform/process.arch` names it in exactly the
#      layout onnxruntime-node uses (linux/x64, linux/arm64, ...), so this stays
#      correct on an arm64 build instead of hard-coding x64.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && if [ -d node_modules/onnxruntime-node ]; then \
         find node_modules/onnxruntime-node \( -name 'libonnxruntime_providers_cuda*' \
              -o -name 'libonnxruntime_providers_tensorrt*' \) -type f -print -delete; \
         KEEP="$(node -p 'process.platform + "/" + process.arch')"; \
         find node_modules/onnxruntime-node/bin/napi-v6 -mindepth 2 -maxdepth 2 -type d \
              ! -path "*/$KEEP" -print -exec rm -rf {} +; \
         test -d "node_modules/onnxruntime-node/bin/napi-v6/$KEEP" || (echo "native ORT binaries for $KEEP missing" && exit 1); \
       fi

# Copy compiled frontend and bundled backend from builder
COPY --chown=node:node --from=builder /app/dist ./dist

# ONNX face models (SCRFD detector + ArcFace recogniser). FACE_MODEL_DIR is what
# src/server/faceEmbedding.ts reads; override it to point at a mounted volume if
# you would rather not bake ~190 MB of weights into the image.
COPY --chown=node:node --from=models /models /app/models
ENV FACE_MODEL_DIR=/app/models

# Expose server port
EXPOSE 3000

# Volume mount point for SQLite database (data/smartface.db)
VOLUME ["/app/data"]

# Liveness probe without wget/curl (neither ships in Debian slim): a Node
# one-liner hits /api/health on the loopback IPv4 address. The compose file
# declares the same probe; this one covers plain `docker run`.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Start the bundled production server
CMD ["node", "dist/server.cjs"]
