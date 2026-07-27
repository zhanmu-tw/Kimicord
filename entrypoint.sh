#!/bin/bash
set -eu

# Create workspace if missing
mkdir -p "${KIMI_WORK_DIR:-/workspace}"

exec "$@"
