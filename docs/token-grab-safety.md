# Token Grab — Safety Guarantees

This document is the authoritative statement of what Token Grab is **allowed** and **not
allowed** to do. Every report command in the learning stack restates these guarantees in
its own safety footer. If a command's output ever contradicts this document, stop and
investigate.

## Real trading capability (added) — defaults OFF

Token Grab now has a **real** live-trading capability (Solana / Jupiter). It is **OFF by
default** and cannot place a real order without ALL of:

1. Full unlock env set (`TOKEN_GRAB_LIVE_TRADING_ENABLED=1`,
   `TOKEN_GRAB_LIVE_TRADING_CONFIRM=I_UNDERSTAND_THIS_CAN_LOSE_REAL_MONEY`, all positive
   limits, RPC, public key, provider).
2. `TOKEN_GRAB_REAL_KILL_SWITCH` not `1`.
3. A **runtime-injected signer** (no private keys in the repo).

Dry-run (default) and mock modes never touch real money. Every real order passes the Live
Risk Gate and is written to the durable ledger before and after submission. The build/test
process **never executes a real trade**. See
[`token-grab-live-trading.md`](./token-grab-live-trading.md).

## Current posture (hard-locked)

| Flag | Value |
|------|-------|
| `mode` | `PAPER_ONLY` |
| `realTradingLocked` | `true` |
| `tradingExecuted` | `0` |
| `reportOnly` | `true` (for all study commands) |
| Production gates | `HOLD_CURRENT_GATES` — unchanged |

## What the system will NOT do

- **No real trading.** No order is ever placed on a real venue.
- **No wallet.** The learning stack never loads, creates, or references a private key.
- **No swap.** No on-chain swap is constructed or broadcast.
- **No signing.** Nothing is signed.
- **No gate/policy/filter changes.** Study commands never edit gates, rejection rules,
  thresholds, or filters. They only read data and print findings.
- **No auto-enablement.** No command flips an env flag, enables coverage, or promotes a
  policy on its own.
- **No historical mutation.** Study commands never rewrite cycle files, learning memory,
  or any data file. (Only the *normal paper loop* writers append new rows — see the
  learning-loop doc.)
- **No deploy / no push** as part of any study command.

## Two classes of command

1. **Report-only study commands** (everything in this completion stack):
   `token:ripper-*-audit`, `*-dashboard`, `*-study`, `*-tracker`, `*-simulator`,
   `*-backtester`, `*-proposal`, `*-status`. These are pure reads. They print and exit.

2. **Normal paper data writers** (pre-existing): the paper loop / learning-memory writers
   that append new paper rows during a normal cycle. These are append-only and operate in
   paper mode. They are **not** part of the study stack and are run deliberately, not by a
   report.

## The UNKNOWN rule

`clusterRisk = UNKNOWN` is **never** treated as `CLEAN`. UNKNOWN means holder risk is
unresolved. In the Execution Realism model, UNKNOWN is treated as an *execution risk*
(extra sellability haircut), never as a safe signal.

## The outcome-leakage rule

Outcome fields (`priceChangePct`, `outcomeLabel`) are **hindsight**. They are used only to
*score* what already happened — never as entry predictors inside a policy or gate.

## What it would take to ever trade for real

Real trading is **out of scope** for this stack and requires a **separate, explicit,
manual approval process** that does not exist here. The strongest thing any report may
ever say is:

> "Ready for a separate manual gate proposal review."

…and only if the evidence supports it. No report in this repo can authorize real trading,
and the App Readiness Dashboard always emits `NOT_READY_FOR_REAL_TRADING`.

## Commands you should NOT run unless you intend live paper trading

These are not study commands. Do not run them to "look at data":

- `token:auto-paper`
- `token:paper-buy`
- `token:ripper-paper-cycle` / `token:ripper-paper-loop` (these run the live paper loop)

## BubbleMaps env flags (read-only relevance)

- `TOKEN_GRAB_BUBBLEMAPS_DISABLED` — `1`/`true` disables live holder lookups.
- `TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN` — per-run live-call cap (`0` = cache-only).

Changing these is a **manual operator decision** (see the Operator Runbook). No study
command changes them.
