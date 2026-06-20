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

### Useful flags

- Execution realism: `--slippage-bps 100 --fee-bps 30 --latency-seconds 5
  --max-pnl-cap 300 --thin-liq-penalty 5 --failed-exit-haircut 0.2 --json`
- Rejected tracker: `--win-pct 10 --big-win-pct 50 --loss-pct -20 --top 20 --json`
- Paper coverage proposal: `--cache-path <path> --recent 10 --json`

## 4. Recommended daily reading order

```bash
npm run token:ripper-app-readiness-dashboard      # start here — the verdict + blockers
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

## 8. Why real trading is locked

Paper P/L is systematically optimistic (see Execution Realism). Holder coverage is
incomplete (see Cluster Coverage). Until those are resolved and an idea survives
execution-adjusted scrutiny *and* a separate manual review, trading real money would be
acting on an unverified, cost-blind edge. The locks are intentional. See
[`token-grab-safety.md`](./token-grab-safety.md).

## 9. Troubleshooting

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
