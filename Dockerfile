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

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (npm ci when a lockfile is committed, npm install otherwise)
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

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
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi \
    && npm cache clean --force

# Copy compiled frontend and bundled backend from builder
COPY --chown=node:node --from=builder /app/dist ./dist

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
