#!/bin/bash
# Installs dependencies so `npm run typecheck` works in Claude Code on the web.
set -euo pipefail

# Local machines already have their own setup; only run in remote sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

npm install --no-audit --no-fund
