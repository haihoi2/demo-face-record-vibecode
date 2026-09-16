# Multi-stage Dockerfile for AI Smart Face & Lock Gateway
# Node 22 provides built-in native SQLite engine (node:sqlite)
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY . .

# Build Vite frontend & Bundle backend into dist/server.cjs
RUN npm run build

# ----------------- Production Stage -----------------
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install runtime dependencies:
# - ffmpeg: required for RTSP video stream transcoding, snapshot capture, and frame extraction
# - ca-certificates: required for secure HTTPS webhooks and external APIs
# - tzdata: ensures correct timezone timestamps (e.g. Asia/Ho_Chi_Minh)
RUN apk add --no-cache ffmpeg ca-certificates tzdata

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled frontend and bundled backend from builder
COPY --from=builder /app/dist ./dist

# Create persistent data directory for SQLite database
RUN mkdir -p /app/data && chown -R node:node /app

# Run as non-root user for security
USER node

# Expose server port
EXPOSE 3000

# Volume mount point for SQLite database (data/smartface.db)
VOLUME ["/app/data"]

# Start the bundled production server
CMD ["node", "dist/server.cjs"]
