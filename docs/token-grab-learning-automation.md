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

## Lock guard — overlapping run protection

The cron runner uses an atomic `mkdir` lock at `/tmp/token-grab-learning-cron.lock`.

**If launchd fires while the previous run is still in the 11-minute observation wait,
the new invocation prints `[SKIP] Another run is already active` and exits cleanly.
This is expected behavior — not an error.**

The lock is automatically released on normal exit, error exit, SIGINT, and SIGTERM.

### Kill a stuck run and reset manually

```bash
# Find the PID stored in the lock
cat /tmp/token-grab-learning-cron.lock/pid

# Kill the stuck process
kill $(cat /tmp/token-grab-learning-cron.lock/pid 2>/dev/null) 2>/dev/null || true

# Remove the stale lock
rm -rf /tmp/token-grab-learning-cron.lock
```

## Timeout protection

- **Cron runner**: the entire learning loop (`step 1/5`) is given 25 minutes
  (`LEARN_LOOP_TIMEOUT_SECS=1500`). If it exceeds this, the loop process is killed
  and the final status prints `Status: TIMED_OUT`. Steps 2–5 still run.
- **Learning loop closeout**: steps 7–9 (observation watcher + autopilot cycle +
  shadow report) are wrapped in a 10-minute timeout (`CLOSEOUT_TIMEOUT_SECS=600`).
  If the watcher hangs, it is killed after 10 minutes and the loop continues to
  its final summary.

## Install launchd agent (runs every 30 min)

```bash
# 1. Copy plist template — update node version in PATH if needed (see below)
cp scripts/com.bchardy.token-grab-learning.plist.example \
   ~/Library/LaunchAgents/com.bchardy.token-grab-learning.plist

# 2. Create log directory
mkdir -p ~/goose-token-autopilot/logs/token-grab-learning

# 3. Load the agent
launchctl load ~/Library/LaunchAgents/com.bchardy.token-grab-learning.plist

# 4. Verify it is registered
launchctl list | grep token-grab
```

### NVM and launchd PATH

launchd does **not** source `~/.bashrc` or `~/.zshrc`, so NVM is not on `PATH` by default.
The plist includes an explicit `EnvironmentVariables` → `PATH` entry pointing to the
NVM-managed node binary.

**If you upgrade node via nvm**, update the version in the plist's `PATH` key:

```bash
# Find your current node binary path
which node
# e.g. /Users/brianhardy/.nvm/versions/node/v22.22.2/bin/node

# Then edit the plist PATH accordingly:
# /Users/brianhardy/.nvm/versions/node/<new-version>/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin
```

After editing, reload the agent:
```bash
launchctl unload ~/Library/LaunchAgents/com.bchardy.token-grab-learning.plist
launchctl load   ~/Library/LaunchAgents/com.bchardy.token-grab-learning.plist
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
