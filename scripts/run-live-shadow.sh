#!/usr/bin/env bash
set -euo pipefail

# LIVE-SHADOW cron wrapper (paper-only research).
#   LIVE_SHADOW_ONLY=true  REAL_TRADING=false  READY_FOR_REAL_TRADING=false
#   NO_WALLET  NO_SWAP  NO_SIGNING  DO_NOT_ENABLE_REAL_TRADING
#
# Source: the LATEST FRESH ripper cycle under data/token-grab/ripper/cycles (the new default).
# This wrapper NEVER calls token:auto-paper or token:paper-buy and has no --live path.

cd /Users/brianhardy/goose-token-autopilot

export PATH="/Users/brianhardy/.nvm/versions/node/v22.22.2/bin:$PATH"

CYCLES_DIR="data/token-grab/ripper/cycles"
MAX_SOURCE_AGE_MINUTES="${LIVE_SHADOW_MAX_SOURCE_AGE_MINUTES:-15}"
LOCKDIR="data/token-grab/live-shadow/.live-shadow.lock"

mkdir -p "$(dirname "$LOCKDIR")"

if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "SKIP $(date -u +%Y-%m-%dT%H:%M:%SZ) live-shadow already running"
  exit 0
fi

trap 'rmdir "$LOCKDIR"' EXIT

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "LIVE-SHADOW RUN START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# If the newest fresh ripper cycle is stale (no cycle-*.jsonl modified within the freshness
# window), attempt the LIGHTEST SAFE fresh-capture command available in this repo before running
# live-shadow. token:ripper-paper-cycle reads the most recent dex-watch run and captures a fresh
# cycle — REAL TRADING LOCKED, paper-only, no wallet/signing/swap. It is NOT auto-paper/paper-buy.
FRESH_CYCLE="$(find "$CYCLES_DIR" -name 'cycle-*.jsonl' -mmin "-${MAX_SOURCE_AGE_MINUTES}" 2>/dev/null | head -1 || true)"
if [ -z "$FRESH_CYCLE" ]; then
  echo "STALE source (no cycle newer than ${MAX_SOURCE_AGE_MINUTES}m) — attempting safe paper-only fresh capture"
  npm run token:ripper-paper-cycle || echo "fresh capture failed — live-shadow will skip with STALE_SOURCE if still stale"
else
  echo "Fresh cycle present: $FRESH_CYCLE"
fi

npm run token:live-shadow -- --max-source-age-minutes "$MAX_SOURCE_AGE_MINUTES"

echo "LIVE-SHADOW RUN END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
