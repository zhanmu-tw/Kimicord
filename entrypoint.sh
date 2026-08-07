#!/bin/bash
set -eu

# Create workspace if missing
mkdir -p "${KIMI_WORK_DIR:-/workspace}"

# Seed a global AGENTS.md (environment briefing for every agent session) into
# the CLI home. WARNING: this overwrites any existing AGENTS.md on every
# container launch so that updates to AGENTS.md.example are always picked up.
# If you want user-editable per-session instructions, put them elsewhere.
KIMI_HOME="${KIMI_CODE_HOME:-/home/node/.kimi-code}"
cp /app/AGENTS.md.example "$KIMI_HOME/AGENTS.md" 2>/dev/null \
  || echo "warning: could not seed $KIMI_HOME/AGENTS.md" >&2

exec "$@"
