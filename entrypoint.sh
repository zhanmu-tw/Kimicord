#!/bin/bash
set -eu

# Create workspace if missing
mkdir -p "${KIMI_WORK_DIR:-/workspace}"

# Seed a global AGENTS.md (environment briefing for every agent session) into
# the CLI home if the user hasn't provided one. It is a bind-mounted volume,
# so users can edit it on the host; an existing file is never overwritten.
KIMI_HOME="${KIMI_CODE_HOME:-/home/node/.kimi-code}"
if [ ! -f "$KIMI_HOME/AGENTS.md" ]; then
  cp /app/AGENTS.md.example "$KIMI_HOME/AGENTS.md" 2>/dev/null \
    || echo "warning: could not seed $KIMI_HOME/AGENTS.md" >&2
fi

exec "$@"
