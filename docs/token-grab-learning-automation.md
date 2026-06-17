# Token Grab — Learning Automation

Local launchd automation for the Token Grab paper-learning evidence collection loop.

**Safety:** REPORT ONLY. No trades. No wallet. No gate changes.

## What it runs (every 30 minutes)

1. `token:ripper-paper-learning-loop` — watcher → capture → shadow enroll → policy test → 11-min wait → closeout
2. `token:ripper-learning-memory` — append evidence rows to learning-memory.jsonl
3. `token:ripper-learning-summary` — print learning summary dashboard
4. `token:ripper-shadow-filter-candidate-comparison` — compare reject filter candidates
5. `token:ripper-autopilot-status` — print autopilot status

All output is teed to a timestamped log under `logs/token-grab-learning/`.

## Manual run

```bash
npm run token:ripper-learning-cron
```

## Install launchd agent (runs every 30 min)

```bash
# 1. Copy plist template
cp scripts/com.bchardy.token-grab-learning.plist.example \
   ~/Library/LaunchAgents/com.bchardy.token-grab-learning.plist

# 2. Create log directory
mkdir -p ~/goose-token-autopilot/logs/token-grab-learning

# 3. Load the agent
launchctl load ~/Library/LaunchAgents/com.bchardy.token-grab-learning.plist

# 4. Verify it is registered
launchctl list | grep token-grab
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.bchardy.token-grab-learning.plist
rm ~/Library/LaunchAgents/com.bchardy.token-grab-learning.plist
```

## Log files

- Per-run logs: `logs/token-grab-learning/run-YYYYMMDD-HHMMSS.log`
- launchd stdout: `logs/token-grab-learning/launchd.out.log`
- launchd stderr: `logs/token-grab-learning/launchd.err.log`
