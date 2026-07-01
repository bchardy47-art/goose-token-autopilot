#!/usr/bin/env bash
set -euo pipefail

cd /Users/brianhardy/goose-token-autopilot

export PATH="/Users/brianhardy/.nvm/versions/node/v22.22.2/bin:$PATH"

LOCKDIR="data/token-grab/live-shadow/.live-shadow.lock"

if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "SKIP $(date -u +%Y-%m-%dT%H:%M:%SZ) live-shadow already running"
  exit 0
fi

trap 'rmdir "$LOCKDIR"' EXIT

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "LIVE-SHADOW RUN START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

npm run token:live-shadow

echo "LIVE-SHADOW RUN END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
