#!/usr/bin/env bash
# Paper-learning collection loop — report/read only.
# NO TRADES. NO WALLET. NO REAL TRADING. NO AUTO-PAPER. NO PAPER-BUY.
# DO_NOT_ENABLE_REAL_TRADING  realTradingLocked=true  paperOnly=true
set -euo pipefail

# ── Safety banner ─────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TOKEN GRAB — PAPER LEARNING COLLECTION LOOP"
echo "  REPORT ONLY — NO TRADES — NO WALLET — NO REAL TRADING"
echo "  reportOnly=true  readOnly=true  tradingExecuted=0"
echo "  realTradingLocked=true  paperOnly=true"
echo "  DO_NOT_ENABLE_REAL_TRADING"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. cd to repo root ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
echo "  Repo root: $REPO_ROOT"
echo ""

# ── 2. Fresh watcher run ─────────────────────────────────────────────────────
echo "  [STEP 1/9] Running fresh watcher (--cycles 1 --minutes 3)..."
npm run token:dex-day-watch -- \
  --cycles 1 \
  --minutes 3 \
  --interval-seconds 30 \
  --sleep-between-cycles-minutes 0

# ── 3. Paper cycle ───────────────────────────────────────────────────────────
echo ""
echo "  [STEP 2/9] Running ripper paper cycle..."
PAPER_CYCLE_OUT="$(npm run token:ripper-paper-cycle 2>&1)"
echo "$PAPER_CYCLE_OUT"

# ── 4. Check whether capture succeeded ───────────────────────────────────────
if echo "$PAPER_CYCLE_OUT" | grep -q "Capture skipped: YES"; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  No fresh prime-window fixtures captured. Stop."
  echo "  Do not run downstream commands."
  echo ""
  echo "  reportOnly=true  readOnly=true  tradingExecuted=0"
  echo "  realTradingLocked=true  paperOnly=true"
  echo "  DO_NOT_ENABLE_REAL_TRADING"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  exit 0
fi

# ── 5. Post-capture downstream commands ──────────────────────────────────────
echo ""
echo "  [STEP 3/9] Running paper autopilot cycle..."
npm run token:ripper-paper-autopilot-cycle

echo ""
echo "  [STEP 4/9] Running shadow reject filter enrollment..."
npm run token:ripper-shadow-reject-filter-enroll

echo ""
echo "  [STEP 4b] Running watch profile enrollment (fail-soft)..."
npm run token:ripper-watch-profile-enroll || true

echo ""
echo "  [STEP 5/9] Running paper policy test..."
npm run token:ripper-paper-policy-test

echo ""
echo "  [STEP 6/9] Running autopilot status..."
npm run token:ripper-autopilot-status

# ── 6. Closeout wait ─────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Waiting 11 minutes before observation closeout..."
echo "  (reportOnly=true — no trades during wait)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
sleep 660

# ── 7-9. Closeout phase with timeout guard ────────────────────────────────────
# Wrap watcher + autopilot cycle + report in a timed subshell so a hung
# watcher cannot block future cron runs. 10 min is ample for 3-min watcher.
CLOSEOUT_TIMEOUT_SECS=600
CLOSEOUT_FLAG="/tmp/token-grab-closeout-$$"

(
  echo ""
  echo "  [STEP 7/9] Running observation watcher (--cycles 1 --minutes 3)..."
  npm run token:dex-day-watch -- \
    --cycles 1 \
    --minutes 3 \
    --interval-seconds 30 \
    --sleep-between-cycles-minutes 0

  echo ""
  echo "  [STEP 8/9] Running paper autopilot cycle (observation closeout)..."
  npm run token:ripper-paper-autopilot-cycle

  echo ""
  echo "  [STEP 9/9] Running shadow enrolled outcome report..."
  npm run token:ripper-shadow-enrolled-outcome-report -- \
    --enrollments data/token-grab/ripper/shadow-reject-filter-enrollments.jsonl \
    --observations data/token-grab/ripper/observations/*.jsonl \
      data/token-grab/ripper/paper-intent-observations.jsonl \
      data/token-grab/dex-watch-runs/run-*.json \
    --out data/token-grab/ripper/shadow-enrolled-outcome-report.jsonl

  echo ""
  echo "  [STEP 9b] Running watch profile outcome report (fail-soft)..."
  npm run token:ripper-watch-profile-outcome-report || true

  echo ""
  echo "  Running final autopilot status..."
  npm run token:ripper-autopilot-status
) &
CLOSEOUT_PID=$!
( sleep "$CLOSEOUT_TIMEOUT_SECS" && touch "$CLOSEOUT_FLAG" && kill "$CLOSEOUT_PID" 2>/dev/null ) &
CLOSEOUT_KILLER=$!
wait  "$CLOSEOUT_PID"    || true
kill  "$CLOSEOUT_KILLER" 2>/dev/null || true
wait  "$CLOSEOUT_KILLER" 2>/dev/null || true

if [ -f "$CLOSEOUT_FLAG" ]; then
  rm -f "$CLOSEOUT_FLAG"
  echo ""
  echo "  [TIMEOUT] Closeout phase exceeded ${CLOSEOUT_TIMEOUT_SECS}s — stopped."
fi

# ── Final summary ─────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PAPER LEARNING LOOP COMPLETE"
echo ""
echo "  Initial capture  : SUCCEEDED (downstream ran)"
echo "  Closeout ran     : YES (11-minute wait + observation watcher)"
echo ""
echo "  SAFETY CONFIRMATION:"
echo "  reportOnly=true  readOnly=true  tradingExecuted=0"
echo "  realTradingLocked=true  paperOnly=true"
echo "  DO_NOT_ENABLE_REAL_TRADING"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
