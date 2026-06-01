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
