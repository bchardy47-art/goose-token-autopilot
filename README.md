# Goose Token Autopilot V1.3

Goose Token Autopilot is a **local, terminal-first Solana token radar** for research, scoring, and simulated paper trading.

## What V1.3 adds

V1.3 introduces a **live paper trading loop**:

- real read-only token discovery
- scoring and proposal generation
- automatic paper-buy decisions
- automatic paper exit review
- time-based paper performance snapshots
- daily reporting for strategy evaluation

This phase is about evidence, not hype.

## What this is

- local Solana token discovery
- token scoring and ranking
- paper trading only
- read-only enrichment and reporting
- guarded real-trade layer that remains locked

## What this is not

- not a live trading bot
- not a wallet signer
- not a browser scraper
- not production live execution infra

## Core safety stance

Real trading remains locked by default:

- `TOKEN_RADAR_DRY_RUN=true`
- `TRADING_DISABLED=true`
- `ENABLE_REAL_BUYS=false`
- `ENABLE_REAL_SELLS=false`

Auto-paper trading is **simulated only**.
It never submits a real buy or sell.

## Commands

```bash
npm run token:scan
npm run token:score
npm run token:report
npm run token:propose
npm run token:paper-buy -- --proposal-id 1
npm run token:paper-sell -- --position-id 1
npm run token:positions
npm run token:auto-paper
npm run token:paper-review
npm run token:paper-performance
npm run token:daily-report
npm run token:watch-only
npm run token:watch-outcomes
npm run token:watch-analysis
npm run token:watch-cycle
npm run token:watch-loop
npm run token:watch-report
npm run token:verify-safety
npm run token:kill
npm run token:autopilot
npm test
```

## Source modes

### Fixture source

Use for deterministic testing:

```bash
TOKEN_SOURCE=fixture npm run token:auto-paper
```

### DexScreener read-only source

Use for live discovery without live trading:

```bash
TOKEN_SOURCE=dexscreener npm run token:scan
TOKEN_SOURCE=dexscreener npm run token:score
TOKEN_SOURCE=dexscreener npm run token:auto-paper
```

This is safe because it is read-only and still paper-only.

## V1.3 auto-paper loop

`token:auto-paper` does this:

1. scan tokens
2. score them
3. evaluate paper-buy eligibility
4. create paper proposals
5. open paper positions only
6. log bought and skipped decisions

Paper-buy candidates must satisfy minimum score, safety, momentum, age, and position-limit rules.
Tokens with hard red flags are skipped.
Duplicate open paper positions are blocked.

## Paper exit review

`token:paper-review` checks open positions and closes paper positions when configured exit rules trigger:

- take profit
- stop loss
- max hold time
- trailing stop support exists in config but is disabled by default

## Paper performance

`token:paper-performance` reports:

- open positions
- closed positions
- realized P/L
- unrealized P/L
- current combined P/L
- best gain
- worst drawdown
- exit reason counts

## Daily report

`token:daily-report` summarizes:

- tokens scanned/scored today
- verdict counts
- safety rejections
- paper buys/sells
- win rate
- average winner / loser
- realized and unrealized P/L
- best and worst paper trades
- top red flags
- top skip reasons
- top positive reasons
- blocked real trade attempts
- final safety status

## Optional read-only enrichment

V1.3 keeps optional Solana read-only safety enrichment:

- mint authority status
- freeze authority status
- holder concentration heuristic
- quote availability heuristic

Unknown safety-critical fields remain unsafe for autopilot.

## Important limitations

- paper results are not proof of future real profitability
- live data can be incomplete, stale, or wrong
- quote availability is not guaranteed real sellability
- enrichment is not a guarantee that a token is safe

## Important

**Real trading is still locked and impossible by default in V1.3.**


## Watch-only research lane

V1.3+ includes a watch-only research lane for live DexScreener tokens.

- `npm run token:watch-only` scans and tracks promising live tokens for observation only
- `npm run token:watch-report` summarizes watch-only candidate behavior
- watch-only candidates are **never** real-bought
- watch-only candidates are **never** paper-bought automatically from this lane
- UNKNOWN safety data may allow research tracking, but it still blocks paper-buy and autopilot decisions
- watch-only is for learning, not for trading

Example:

```bash
DATABASE_FILE=./data/watch-only-test.sqlite TOKEN_SOURCE=dexscreener npm run token:watch-only
DATABASE_FILE=./data/watch-only-test.sqlite TOKEN_SOURCE=dexscreener npm run token:watch-report
```

### Watch-only research loop

For live research collection over time without manual babysitting:

```bash
DATABASE_FILE=./data/live-research.sqlite TOKEN_SOURCE=dexscreener npm run token:watch-loop
```

Defaults:
- `WATCH_LOOP_MAX_CYCLES=12`
- `WATCH_LOOP_INTERVAL_SECONDS=300`

Overrides supported:
- `WATCH_LOOP_INTERVAL_SECONDS`
- `WATCH_LOOP_MAX_CYCLES`
- `DATABASE_FILE`
- `TOKEN_SOURCE`

`token:watch-cycle` runs one research-only cycle and exits.
`token:watch-loop` repeats the same safe research-only cycle until max cycles is reached or you stop it with `Ctrl+C`.

Real trading remains locked.

## Paper runner / planner validation log

### 2026-06-09 — Planner current-cycle classification validated (PR #69)

**Run:** `run-20260609-034403.json`
- Contracts watched: 43 | Winners: 1 | Losers: 0 | Flat: 42 | Missing: 0
- Runner candidate trades: 0

**Planner counts** (170 total plans, latest real run: `run-20260609-034403.json`):
- `CURRENT_CYCLE_PAPER_ENTRY`: 0
- `HISTORICAL_JOURNAL_WINNER`: 11
- `WATCH_ONLY`: 64
- `BLOCKED_HISTORY_RISK`: 61
- `NO_ENTRY`: 34

**Takeaway:** Planner is now honest. The 1 winner did not qualify as a current-cycle paper entry (runner candidate trades: 0). Historical winners (e.g. $REPLY +132%, $DUST +105%) remain visible as `HISTORICAL_JOURNAL_WINNER` and are not surfaced as actionable entries. Safety: `tradingExecuted: 0`, `noRealTradeSent: true`, `readOnly: true`, `paperOnly: true`.

### 2026-06-09 — Validation loop smoke (PR #71)

**Run:** `run-20260609-050737.json` via `token:dex-validation-loop --cycles 1`
- Contracts watched: 43 | Winners: 1 | Losers: 0 | Flat: 42 | Missing: 0
- Runner candidate trades: 1 | Fake P/L: +$0.47

**Planner counts:**
- `CURRENT_CYCLE_PAPER_ENTRY`: 0
- `HISTORICAL_JOURNAL_WINNER`: 11
- `BLOCKED_HISTORY_RISK`: 64
- `WATCH_ONLY`: 67

**Final recommendation: `FILTERS_WORKING`** — top blocked movers: $PUMPLIFE (+190%), $$MAD (+128%), $Ronaldo (+118%), $MILLION (+90%), $PHOTO (+69%). All blocked by prior loss / drain / missing history.

**Takeaway:** Validation loop works end-to-end. A winner appeared and produced a candidate trade, but no clean current-cycle entry passed filters. History-risk blocks are functioning as designed. Safety: `tradingExecuted: 0`, `noRealTradeSent: true`, `readOnly: true`, `paperOnly: true`.
