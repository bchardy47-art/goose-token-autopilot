#!/usr/bin/env bash
set -euo pipefail

echo "TOKEN GRAB PAPER AUTOPILOT — PAPER ONLY"
echo "NO WALLET. NO REAL TRADING. NO AUTO-PAPER. NO PAPER-BUY."

npm run token:dex-day-watch -- \
  --cycles 1 \
  --minutes 3 \
  --interval-seconds 30 \
  --sleep-between-cycles-minutes 0

npm run token:ripper-paper-cycle

npm run token:ripper-paper-autopilot-cycle -- \
  --cycles-dir data/token-grab/ripper/cycles \
  --observations-dir data/token-grab/ripper/observations \
  --intents data/token-grab/ripper/paper-intents.jsonl

npm run token:ripper-approved-entry-timing-report -- \
  --approvals data/token-grab/ripper/cycles/cycle-*.jsonl \
  --observations data/token-grab/ripper/observations/*.jsonl \
  --out data/token-grab/ripper/approved-entry-timing-report.jsonl \
  --min-observed 5

npm run token:ripper-paper-exit-policy-report -- \
  --intents data/token-grab/ripper/paper-intents.jsonl \
  --observations data/token-grab/ripper/observations/*.jsonl \
  --out data/token-grab/ripper/paper-exit-policy-report.jsonl

npm run token:ripper-real-vs-fake-autopsy -- \
  --cycles data/token-grab/ripper/cycles/cycle-*.jsonl \
  --observations data/token-grab/ripper/observations/*.jsonl \
  --out data/token-grab/ripper/real-vs-fake-autopsy.jsonl

npm run token:ripper-autopilot-status
