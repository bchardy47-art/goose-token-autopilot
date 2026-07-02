#!/usr/bin/env bash
set -euo pipefail

# LIVE-SHADOW cron wrapper (paper-only research).
#   LIVE_SHADOW_ONLY=true  REAL_TRADING=false  READY_FOR_REAL_TRADING=false
#   NO_WALLET  NO_SWAP  NO_SIGNING  DO_NOT_ENABLE_REAL_TRADING
#
# Source: the LATEST FRESH ripper cycle under data/token-grab/ripper/cycles.
# This wrapper NEVER runs the auto-paper or paper-buy commands and has no --live path.
#
# STALE-SOURCE RECOVERY (when the newest ripper cycle is older than the freshness window):
#   1. token:dex-feed-refresh    — ONE-SHOT upstream Dex feed refresh (no 24-cycle loop, no 20m sleep)
#   2. token:ripper-paper-cycle  — capture a fresh ripper cycle from the refreshed feed
#   3. token:live-shadow         — run the shadow valuation on the fresh cycle
# All three are paper-only / read-only. No wallet, signing, swap, or private keys.

cd /Users/brianhardy/goose-token-autopilot

export PATH="/Users/brianhardy/.nvm/versions/node/v22.22.2/bin:$PATH"

CYCLES_DIR="data/token-grab/ripper/cycles"
MAX_SOURCE_AGE_MINUTES="${LIVE_SHADOW_MAX_SOURCE_AGE_MINUTES:-15}"
LOCKDIR="data/token-grab/live-shadow/.live-shadow.lock"

mkdir -p "$(dirname "$LOCKDIR")"

# ── Lockfile — prevent overlapping cron runs ──────────────────────────────────
# mkdir is atomic on POSIX; if the dir already exists another run is still active.
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "SKIP $(date -u +%Y-%m-%dT%H:%M:%SZ) live-shadow already running (lock held)"
  exit 0
fi

trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "LIVE-SHADOW RUN START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "READY_FOR_REAL_TRADING=false  REAL_TRADING=false  paperOnly=true  tradingExecuted=0"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Is there a ripper cycle newer than the freshness window?
FRESH_CYCLE="$(find "$CYCLES_DIR" -name 'cycle-*.jsonl' -mmin "-${MAX_SOURCE_AGE_MINUTES}" 2>/dev/null | head -1 || true)"

if [ -z "$FRESH_CYCLE" ]; then
  echo "STALE source (no cycle newer than ${MAX_SOURCE_AGE_MINUTES}m) — running stale-source recovery"
  RECOVERY_OK=true

  # 1. One-shot Dex feed refresh (paper-only, single cycle, no sleep, no loop).
  echo "DEX_REFRESH_START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if npm run token:dex-feed-refresh; then
    echo "DEX_REFRESH_END $(date -u +%Y-%m-%dT%H:%M:%SZ) ok"
  else
    echo "DEX_REFRESH_END $(date -u +%Y-%m-%dT%H:%M:%SZ) failed"
    RECOVERY_OK=false
  fi

  # 2. Capture a fresh ripper cycle from the refreshed feed.
  if [ "$RECOVERY_OK" = true ]; then
    echo "RIPPER_CYCLE_START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if npm run token:ripper-paper-cycle; then
      echo "RIPPER_CYCLE_END $(date -u +%Y-%m-%dT%H:%M:%SZ) ok"
    else
      echo "RIPPER_CYCLE_END $(date -u +%Y-%m-%dT%H:%M:%SZ) failed"
      RECOVERY_OK=false
    fi
  fi

  if [ "$RECOVERY_OK" = true ]; then
    echo "STALE_SOURCE_RECOVERY_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    echo "STALE_SOURCE_RECOVERY_FAILED $(date -u +%Y-%m-%dT%H:%M:%SZ) — live-shadow will skip with STALE_SOURCE if still stale"
  fi
else
  echo "Fresh cycle present: $FRESH_CYCLE"
fi

# 3. Run the shadow valuation. Skips itself with STALE_SOURCE if the source is still stale.
echo "LIVE_SHADOW_START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
npm run token:live-shadow -- --max-source-age-minutes "$MAX_SOURCE_AGE_MINUTES"
echo "LIVE_SHADOW_END $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "LIVE-SHADOW RUN END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "READY_FOR_REAL_TRADING=false"
