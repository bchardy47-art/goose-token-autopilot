# Token Grab — Operator Runbook

Practical guide to installing, running, and interpreting the Token Grab paper-first
learning system. Read [`token-grab-safety.md`](./token-grab-safety.md) first — it defines
the hard limits this runbook operates within.

> This system is **paper-only**. Nothing here enables real trading, wallets, swaps, or
> signing. The runbook contains **no secrets, no private keys, no wallet setup, and no
> real swap instructions** — by design.

## 1. Install

```bash
cd ~/goose-token-autopilot
npm install
```

Requirements: Node 18+, `npx`/`tsx` (installed via dev dependencies).

## 2. Run a report (general form)

Every study command is read-only and supports `--json`:

```bash
npm run <command>                 # human-readable report
npm run <command> --silent -- --json   # machine-readable JSON
```

## 3. The completion-stack commands (all REPORT-ONLY)

| Command | What it does |
|---------|--------------|
| `token:ripper-learning-loop-propagation-audit` | Confirms M5 persists through every stage |
| `token:ripper-m5-evidence-dashboard` | M5 band evidence + maturity |
| `token:ripper-m5-usable-sample-deep-dive` | Deep dive on the usable M5 sample |
| `token:ripper-cluster-coverage-audit` | Why `clusterRisk` is UNKNOWN; M5 contamination |
| `token:ripper-bubblemaps-approved-priority-study` | Would approved-first holder calls help? |
| `token:ripper-bubblemaps-paper-coverage-proposal` | Proposal (only) to re-enable paper holder coverage |
| `token:ripper-rejected-outcome-tracker` | Learn from rejected tokens (false vs correct rejects) |
| `token:ripper-execution-realism-simulator` | Cost-adjust paper P/L (slippage/fees/latency/haircuts) |
| `token:ripper-shadow-policy-backtester` | Score candidate rules on execution-adjusted P/L |
| `token:ripper-app-readiness-dashboard` | Aggregate verdict: what's safe/unsafe/missing/blocked |
| `token:ripper-autopilot-status` | Current mode, decision, safety locks |
| `token:ripper-ops-status` | Single operational status view: running state, latest cycle, open simulated positions, bankrolls, Brain, stale feeds, safety triggers |

### Useful flags

- Execution realism: `--slippage-bps 100 --fee-bps 30 --latency-seconds 5
  --max-pnl-cap 300 --thin-liq-penalty 5 --failed-exit-haircut 0.2 --json`
- Rejected tracker: `--win-pct 10 --big-win-pct 50 --loss-pct -20 --top 20 --json`
- Paper coverage proposal: `--cache-path <path> --recent 10 --json`

## 4. Recommended daily reading order

```bash
npm run token:ripper-ops-status                   # single operational answer: is it running, fresh, safe, and what is open?
npm run token:ripper-app-readiness-dashboard      # verdict + blockers
npm run token:ripper-autopilot-status             # confirm locks intact
npm run token:ripper-execution-realism-simulator  # is paper P/L real?
npm run token:ripper-cluster-coverage-audit       # holder coverage health
npm run token:ripper-shadow-policy-backtester     # any policy ready for review?
```

## 5. How to read the dashboards

- **App Readiness Dashboard** grades nine dimensions. `OK`/`LOCKED` = healthy; `STUDY` =
  usable for study; `BLOCKED` = a real blocker. The **Final Verdict** never says "enable
  real trading"; the strongest it goes is "ready for a separate manual gate proposal
  review." Read **Blockers** and **Next Best Action** first.
- **Execution Realism**: if `PAPER_PNL_OVERSTATED` fires, raw paper profit is an illusion —
  use the *adjusted* numbers.
- **Shadow Policy Backtester**: a policy can reach `READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW`
  but that is *only* an invitation to a manual review, gated by the dashboard's blockers.
- **Rejected Outcome Tracker**: `REJECTED_WINNERS_EXIST` + `GATES_MAY_BE_TOO_STRICT` means
  some rejects ran — feed them into the backtester, do **not** loosen gates directly.

## 6. Collecting more data

The study commands measure; they do not generate. To grow evidence, run the normal paper
loop (the deliberate writers described in the learning-loop doc) so new rows accumulate,
then re-run the dashboards.

## 7. How to propose a gate review (the only escalation path)

1. Confirm the App Readiness Dashboard shows the relevant evidence as `STUDY_READY` and the
   blockers for that idea are clear.
2. Confirm the Shadow Policy Backtester marks the policy
   `READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW` on a `USABLE_SIGNAL`/`STRONGER` sample, scored
   on **execution-adjusted** P/L.
3. Write a **separate** human gate-proposal document for manual review. Nothing in this
   repo applies it. Real trading remains out of scope.

## 7b. Live (real) trading commands

Real trading capability exists and **defaults OFF** (Solana / Jupiter). Full details in
[`token-grab-live-trading.md`](./token-grab-live-trading.md). Quick reference:

```bash
npm run token:ripper-live-config-doctor                 # capability/config (no trade)
npm run token:ripper-live-runner -- --dry-run --once    # real quotes, never submits
npm run token:ripper-live-runner -- --mock --once       # synthetic fills
npm run token:ripper-live-daemon -- --dry-run --once     # daemon, one cycle
npm run token:ripper-live-control -- --status            # operator control center
npm run token:ripper-live-control -- --create-stop       # pause daemon (stop file)
npm run token:ripper-final-acceptance-live               # prove finished (no real trade)
```

Live mode requires the full unlock env, kill switch off, and a runtime-injected signer
(no keys in repo). Always `--dry-run` first.

## 8. Why real trading is locked

Paper P/L is systematically optimistic (see Execution Realism). Holder coverage is
incomplete (see Cluster Coverage). Until those are resolved and an idea survives
execution-adjusted scrutiny *and* a separate manual review, trading real money would be
acting on an unverified, cost-blind edge. The locks are intentional. See
[`token-grab-safety.md`](./token-grab-safety.md).

## 9. Live-market paper launch / unattended operation

### Startup procedure

```bash
cd ~/goose-token-autopilot
npm install
npm run token:ripper-ops-status
npm run token:ripper-app-readiness-dashboard
```

Recommended startup checks:
- `token:ripper-ops-status` → confirms the system is fresh, paper-only, and whether any paper kill switch is active.
- `token:ripper-autopilot-status` → confirms current paper decision mode and latest cycle time.
- `token:ripper-app-readiness-dashboard` → confirms known blockers and safety locks.

### Scheduled execution

Current scheduling must remain separate from code changes. The existing wrappers are:

```bash
npm run token:ripper-learning-cron         # full paper-learning collection + memory refresh
bash scripts/run-live-shadow.sh            # live-market paper valuation / bankroll simulation
```

Do **not** modify the user's active cron/launchd entries without explicit approval.
Review only:
- `scripts/com.bchardy.token-grab-learning.plist.example`
- `scripts/run-token-grab-learning-cron.sh`
- `scripts/run-live-shadow.sh`

### Health checks

```bash
npm run token:ripper-ops-status
npm run token:ripper-autopilot-status
npm run token:ripper-app-readiness-dashboard
npm run token:live-shadow-report
npm run token:research-shadow-report
```

What to confirm from `token:ripper-ops-status`:
- Is Token Grab running now?
- When was the latest successful cycle?
- How many latest-cycle tokens were discovered / approved / rejected?
- Are there any open simulated positions?
- What are today's simulated returns and cumulative realized paper P/L?
- What did the Brain decide?
- Which strategy lane is leading?
- Are data feeds stale?
- Are any safety triggers active?

### Automatic recovery

Already implemented in the current paper-only system:
- Atomic lock directories prevent overlapping scheduled runs.
- Learning cron timeout guard stops hung collection loops.
- Live-shadow wrapper performs stale-source recovery by refreshing feed → capturing a fresh cycle → rerunning valuation.
- Persistent JSON/JSONL state allows crash/restart recovery without inventing trades or fills.
- Brain memory, paper intents, observations, and live-shadow state resume from disk.

### Logging and monitoring

Primary logs / state:
- `logs/token-grab-learning/run-*.log`
- `logs/token-grab-learning/launchd.out.log`
- `logs/token-grab-learning/launchd.err.log`
- `data/token-grab/ripper/cycles/`
- `data/token-grab/ripper/paper-intents.jsonl`
- `data/token-grab/ripper/paper-intent-observations.jsonl`
- `data/token-grab/ripper/learning-memory.jsonl`
- `data/token-grab/live-shadow/live-shadow-events.jsonl`
- `data/token-grab/live-shadow/live-shadow-state.json`
- `data/token-grab/brain/policy-memory.json`

Quick monitoring commands:

```bash
npm run token:ripper-ops-status
npm run token:live-shadow-report
npm run token:research-shadow-report
```

### Simulated bankroll reset procedure

This should be done only deliberately, with backups first.
The paper bankroll state lives in:

```bash
data/token-grab/live-shadow/live-shadow-state.json
data/token-grab/live-shadow/live-shadow-events.jsonl
```

Safe reset procedure:
1. Stop scheduled runners externally.
2. Back up both files.
3. If you need a clean paper bankroll experiment, archive the current files and let the next live-shadow run recreate fresh state.
4. Re-run `npm run token:ripper-ops-status` and `npm run token:live-shadow-report` to verify the reset state.

### Emergency paper shutdown

Paper-only emergency controls already exist:
- Learning cron overlap lock: `/tmp/token-grab-learning-cron.lock`
- Live-shadow overlap lock: `data/token-grab/live-shadow/.live-shadow.lock`
- Live daemon stop-file controls exist for the separate live execution capability, but real trading remains disabled by default.

For the current paper-learning system, emergency shutdown means:
1. Stop the external scheduler.
2. If a learning cron run is stuck:

```bash
kill $(cat /tmp/token-grab-learning-cron.lock/pid 2>/dev/null) 2>/dev/null || true
rm -rf /tmp/token-grab-learning-cron.lock
```

3. If live-shadow is stuck, stop the wrapper process and remove its lock directory only after the process is confirmed dead.

### Data backup procedure

Back up these directories before resets or major experiments:

```bash
data/token-grab/ripper/
data/token-grab/live-shadow/
data/token-grab/brain/
logs/token-grab-learning/
```

A simple timestamped archive approach:

```bash
mkdir -p backups
TS=$(date +%Y%m%d-%H%M%S)
tar -czf backups/token-grab-${TS}.tgz \
  data/token-grab/ripper \
  data/token-grab/live-shadow \
  data/token-grab/brain \
  logs/token-grab-learning
```

### Performance evaluation commands

```bash
npm run token:ripper-ops-status
npm run token:live-shadow-report
npm run token:research-shadow-report
npm run token:post-brain-report
npm run token:ripper-paper-trade-simulation-report
npm run token:ripper-shadow-policy-backtester
npm run token:ripper-app-readiness-dashboard
```

Use these to answer:
- paper bankroll trajectory
- realized paper P/L
- Brain effect pre/post activation
- execution-adjusted realism
- current leading strategy lane
- whether blockers remain before the next learning phase

## 10. Troubleshooting

### Stale feed
- **Symptom:** `token:ripper-autopilot-status` shows an old `latestFeedTime`/`latestCycleTime`;
  propagation audit reports a `*_STALE` diagnosis.
- **Cause:** the normal cycle/feed hasn't run recently; observations aren't advancing.
- **Fix:** run the normal paper loop again so new cycle rows and observations are written.
  Study commands only read — they cannot un-stale the feed.

### BubbleMaps disabled
- **Symptom:** Cluster Coverage / Priority Study show `BUBBLEMAPS_DISABLED_DOMINATES`,
  10/10 recent cycles disabled, approved UNKNOWN high.
- **Cause:** `TOKEN_GRAB_BUBBLEMAPS_DISABLED=1` (or cache-only via cap `0`).
- **Fix (manual, separate decision):** review
  `token:ripper-bubblemaps-paper-coverage-proposal`. It prints the *exact* env change
  (`TOKEN_GRAB_BUBBLEMAPS_DISABLED=0`, a small `TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN`) —
  apply it yourself only if you choose to. Holder coverage is paper evidence; it never
  trades. Rollback is a single flag back to `=1`.

### No M5 data
- **Symptom:** M5 Evidence Dashboard shows `NO_M5_DATA`/`TINY_SAMPLE`; coverage % low.
- **Cause:** entry momentum not captured for recent rows, or too few observed outcomes.
- **Fix:** confirm the propagation audit shows `M5_FULLY_PERSISTED`; if so, just keep
  running the loop — the sample grows over time. If M5 is *not* persisting, fix the
  plumbing before trusting any M5 conclusion.

### UNKNOWN cluster dominance
- **Symptom:** `UNKNOWN_CLUSTER_DOMINATES_M5`; apparent M5_NEUTRAL edge is UNKNOWN-driven.
- **Cause:** holder risk unresolved (BubbleMaps disabled) for most rows.
- **Fix:** treat the apparent edge as contaminated (UNKNOWN ≠ CLEAN). Resolve holder
  coverage (see "BubbleMaps disabled") before drawing M5_NEUTRAL conclusions. Do **not**
  promote M5_NEUTRAL while UNKNOWN dominates.
