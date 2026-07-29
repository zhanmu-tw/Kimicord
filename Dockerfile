# ---- Build stage ----
FROM node:24-slim AS builder

# Toolchain for compiling better-sqlite3 from source. v12 ships prebuilds for
# Node 24, so these are only a fallback for platforms without a prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

# ---- Runtime stage ----
FROM node:24-slim

# git: required by the Kimi Code CLI. curl: used by the compose healthcheck.
# poppler-utils: pdftotext/pdfinfo so agents can read PDF attachments (no
# other PDF tooling exists in the CLI or this image).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install the Kimi Code CLI (self-contained binary, glibc only) into /usr/local
# so `kimi` is on PATH for the non-root user. Pinned for reproducible builds;
# bump KIMI_VERSION to upgrade.
ARG KIMI_VERSION=0.29.2
RUN curl -fsSL https://code.kimi.com/kimi-code/install.sh \
    | KIMI_VERSION=${KIMI_VERSION} KIMI_INSTALL_DIR=/usr/local KIMI_NO_MODIFY_PATH=1 bash

WORKDIR /app

# Copy only built artifacts and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY entrypoint.sh AGENTS.md.example ./

# Run as the built-in non-root `node` user (uid 1000). Make the data dir, the
# Kimi Code CLI config dir, and the default workspace writable by that user.
RUN chmod +x /app/entrypoint.sh \
    && mkdir -p /app/data /home/node/.kimi-code /workspace \
    && chown -R node:node /app/data /home/node/.kimi-code /workspace

USER node
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/index.js"]
