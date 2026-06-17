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

# ── Log setup ─────────────────────────────────────────────────────────────────
LOG_DIR="$REPO_ROOT/logs/token-grab-learning"
mkdir -p "$LOG_DIR"
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="$LOG_DIR/run-${TIMESTAMP}.log"
echo "  Log file  : $LOG_FILE"
echo ""

# Exec: tee all subsequent stdout+stderr into the timestamped log.
exec > >(tee -a "$LOG_FILE") 2>&1

# ── Step tracker ──────────────────────────────────────────────────────────────
FAILED_STEP=""
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

# ── Five required report/learning commands ────────────────────────────────────
# None of these execute trades, sign wallets, or alter policy.
run_step "Paper learning loop (watcher → capture → shadow enroll → policy test → wait → closeout)" \
  "npm run token:ripper-paper-learning-loop" || true

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

if [[ -z "$FAILED_STEP" ]]; then
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
