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
ARG KIMI_VERSION=0.42.0
RUN curl -fsSL https://code.kimi.com/kimi-code/install.sh \
    | KIMI_VERSION=${KIMI_VERSION} KIMI_INSTALL_DIR=/usr/local KIMI_NO_MODIFY_PATH=1 bash

# uv/uvx so MCP servers declared with `command: "uvx"` can run inside the
# container. The binaries are statically linked; pinned for reproducible
# builds. uvx downloads a managed Python on first use into the node user's
# home, so no system Python is needed here.
COPY --from=ghcr.io/astral-sh/uv:0.12.12 /uv /uvx /usr/local/bin/

# agent-browser: browser automation CLI (native binary installed via npm) so
# agents can drive a real browser. Pinned for reproducible builds; bump
# AGENT_BROWSER_VERSION to upgrade.
ARG AGENT_BROWSER_VERSION=0.37.1
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
    && npm cache clean --force

# Provide a Chrome/Chromium binary plus its Linux system libraries.
# Chrome for Testing has no Linux ARM64 build, so:
#   - amd64: `agent-browser install --with-deps` downloads Chrome for Testing
#     into root's home and apt-installs its libraries. The binary is then
#     relocated to a root-owned, world-readable path — the `node` user cannot
#     execute files under /root, and the runtime tmpfs on
#     /home/node/.agent-browser would shadow anything in a home directory.
#   - arm64: Debian's `chromium` package (pulls in its own libraries).
# Either way the browser ends up at the stable path /opt/agent-browser/chrome
# so the ENV below doesn't depend on agent-browser's internal layout.
# `install --with-deps` exits nonzero on failure, doubling as a build gate.
# It shells out to `sudo apt-get ...`, which doesn't exist in this image — a
# temporary passthrough shim stands in for it and is removed in the same layer.
RUN set -e; \
    mkdir -p /opt/agent-browser; \
    if [ "$(dpkg --print-architecture)" = "arm64" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends chromium \
        && rm -rf /var/lib/apt/lists/* \
        && ln -s "$(readlink -f "$(command -v chromium)")" /opt/agent-browser/chrome; \
    else \
        printf '#!/bin/sh\nexec "$@"\n' > /usr/local/bin/sudo \
        && chmod +x /usr/local/bin/sudo \
        && apt-get update \
        && agent-browser install --with-deps \
        && rm -f /usr/local/bin/sudo \
        && rm -rf /var/lib/apt/lists/* \
        && CHROME_BIN="$(find /root -name chrome -type f -print -quit)" \
        && test -n "$CHROME_BIN" \
        && mv "$(dirname "$CHROME_BIN")" /opt/agent-browser/chrome-linux \
        && chmod -R a+rX /opt/agent-browser \
        && ln -s /opt/agent-browser/chrome-linux/chrome /opt/agent-browser/chrome; \
    fi
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/agent-browser/chrome

WORKDIR /app

# Copy only built artifacts and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY entrypoint.sh AGENTS.md.example ./

# User-scope skills for the Kimi Code CLI (read from ~/.agents/skills/). The
# agent-browser stub tells agents the CLI exists; find-skills lets them
# discover more skills. Vendored under docker/skills/ for deterministic builds.
COPY docker/skills/ /home/node/.agents/skills/

# Run as the built-in non-root `node` user (uid 1000). Make the data dir, the
# Kimi Code CLI config dir, the skills dir, the agent-browser state dir (so a
# named volume mounted there inherits node ownership), and the default
# workspace writable by that user.
RUN chmod +x /app/entrypoint.sh \
    && mkdir -p /app/data /home/node/.kimi-code /home/node/.agent-browser /workspace \
    && chown -R node:node /app/data /home/node/.kimi-code /home/node/.agent-browser /home/node/.agents /workspace

# Build-time gate, run as the runtime user with HOME forced to the node home
# (writable in the image layer; the tmpfs on /home/node/.agent-browser only
# exists at runtime via compose). The gate is an explicit open/close launch
# test — it verifies CLI, system libraries, and the relocated executable end
# to end. `agent-browser doctor` is NOT used: its Chrome check ignores
# AGENT_BROWSER_EXECUTABLE_PATH (v0.37.1) and reports a false "No Chrome
# binary found", and its own launch test ignores config/--args overrides so
# it can never pass under BuildKit, which blocks Chrome's user-namespace
# sandbox. AGENT_BROWSER_ARGS must be comma-separated and passed to every
# command (even close launches a browser process). At container runtime,
# Docker's default seccomp profile lets the sandbox run, so no --no-sandbox
# config is baked into the image.
RUN export AB="env HOME=/home/node AGENT_BROWSER_ARGS=--no-sandbox,--disable-gpu"; \
    runuser -u node -- $AB agent-browser open about:blank \
    && runuser -u node -- $AB agent-browser close

USER node
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/index.js"]
