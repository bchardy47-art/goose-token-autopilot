#!/usr/bin/env bash
set -euo pipefail

export PATH="/Users/brianhardy/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd /Users/brianhardy/goose-token-autopilot

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "RUN START $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

npm run token:ripper-operator

echo "RUN END $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
