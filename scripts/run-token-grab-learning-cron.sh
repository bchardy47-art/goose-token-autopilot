#!/usr/bin/env bash
# Token Grab — Local paper-learning automation runner.
# Evidence collection only. NEVER trades. NEVER changes gates. NEVER alters paper policy.
#
# DO_NOT_ENABLE_REAL_TRADING  realTradingLocked=true  paperOnly=true
# reportOnly=true  readOnly=true  tradingExecuted=0
#
# Forbidden: auto-paper, paper-buy, wallet signing, swap execution,
#            production gate changes, paper policy changes, autopilot decision wiring.
set -euo pipefail

# ── Safety header ──────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TOKEN GRAB — PAPER LEARNING AUTOMATION RUNNER"
echo "  REPORT ONLY — NO TRADES — NO WALLET — NO REAL TRADING"
echo "  reportOnly=true  readOnly=true  tradingExecuted=0"
echo "  realTradingLocked=true  paperOnly=true"
echo "  DO_NOT_ENABLE_REAL_TRADING"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Repo root ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
echo "  Repo root : $REPO_ROOT"

# ── Lock guard — prevent overlapping runs ─────────────────────────────────────
# mkdir is atomic on POSIX; if it already exists another run is still active.
LOCK_DIR="/tmp/token-grab-learning-cron.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  EXISTING_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "unknown")"
  echo ""
  echo "  [SKIP] Another run is already active (PID ${EXISTING_PID})."
  echo "  This is expected when launchd fires while the previous run is still"
  echo "  in the 11-minute observation wait. No action needed."
  echo "  To kill a stuck run and reset:"
  echo "    kill \$(cat ${LOCK_DIR}/pid 2>/dev/null) 2>/dev/null || true"
  echo "    rm -rf ${LOCK_DIR}"
  echo ""
  exit 0
fi
echo $$ > "$LOCK_DIR/pid"

# Release the lock on any exit — normal, error, SIGINT, or SIGTERM.
cleanup() {
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

# ── Log setup ─────────────────────────────────────────────────────────────────
LOG_DIR="$REPO_ROOT/logs/token-grab-learning"
mkdir -p "$LOG_DIR"
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="$LOG_DIR/run-${TIMESTAMP}.log"
echo "  Log file  : $LOG_FILE"
echo ""

# Tee all subsequent stdout+stderr into the timestamped log.
exec > >(tee -a "$LOG_FILE") 2>&1

# ── Timeout config ─────────────────────────────────────────────────────────────
# 25 min covers the 11-min wait + ~10 min of actual work, with margin.
# Uses a background killer + flag file (no subshell variable scope issues).
LEARN_LOOP_TIMEOUT_SECS=1500
TIMEOUT_FLAG="$LOCK_DIR/timed_out"

# ── Step tracker ──────────────────────────────────────────────────────────────
FAILED_STEP=""
TIMED_OUT=false
STEP=0

run_step() {
  local label="$1"
  local cmd="$2"
  STEP=$((STEP + 1))
  echo "  ──────────────────────────────────────────────────────────────"
  echo "  [STEP ${STEP}/5] ${label}"
  echo "  ──────────────────────────────────────────────────────────────"
  if ! eval "$cmd"; then
    FAILED_STEP="[STEP ${STEP}/5] ${label}"
    return 1
  fi
}

# ── Step 1: Paper learning loop with timeout guard ────────────────────────────
# Background the loop; a killer subshell fires after LEARN_LOOP_TIMEOUT_SECS
# and touches a flag file so the parent can detect timeout across the boundary.
STEP=$((STEP + 1))
echo "  ──────────────────────────────────────────────────────────────"
echo "  [STEP ${STEP}/5] Paper learning loop  (watcher → capture → shadow enroll → policy test → wait → closeout)"
echo "  Timeout   : ${LEARN_LOOP_TIMEOUT_SECS}s (~25 min)"
echo "  ──────────────────────────────────────────────────────────────"
npm run token:ripper-paper-learning-loop &
LEARN_PID=$!
( sleep "$LEARN_LOOP_TIMEOUT_SECS" && touch "$TIMEOUT_FLAG" && kill "$LEARN_PID" 2>/dev/null ) &
KILLER_PID=$!
wait  "$LEARN_PID"   || true
kill  "$KILLER_PID"  2>/dev/null || true
wait  "$KILLER_PID"  2>/dev/null || true

if [ -f "$TIMEOUT_FLAG" ]; then
  TIMED_OUT=true
  echo ""
  echo "  [TIMEOUT] Learning loop exceeded ${LEARN_LOOP_TIMEOUT_SECS}s and was stopped."
fi

# ── Steps 2-5: Report/evidence commands ───────────────────────────────────────
# None of these execute trades, sign wallets, or alter policy.
run_step "Learning memory (append evidence rows)" \
  "npm run token:ripper-learning-memory" || true

run_step "Learning summary report" \
  "npm run token:ripper-learning-summary" || true

run_step "Shadow filter candidate comparison" \
  "npm run token:ripper-shadow-filter-candidate-comparison" || true

run_step "Autopilot status" \
  "npm run token:ripper-autopilot-status" || true

# ── Final status ───────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TOKEN GRAB — LEARNING CRON RUN COMPLETE"
echo ""

if [[ "$TIMED_OUT" == "true" ]]; then
  echo "  Status    : TIMED_OUT (learning loop exceeded ${LEARN_LOOP_TIMEOUT_SECS}s)"
elif [[ -z "$FAILED_STEP" ]]; then
  echo "  Status    : COMPLETED SUCCESSFULLY"
else
  echo "  Status    : FAILED AT STEP — ${FAILED_STEP}"
fi

echo "  Log path  : $LOG_FILE"
echo ""
echo "  SAFETY CONFIRMATION:"
echo "  reportOnly=true  readOnly=true  tradingExecuted=0"
echo "  realTradingLocked=true  paperOnly=true"
echo "  DO_NOT_ENABLE_REAL_TRADING"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
