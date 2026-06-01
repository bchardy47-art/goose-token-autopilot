# Goose Token Autopilot V1

Goose Token Autopilot V1 is a **local, terminal-first Solana token radar** that can:

- scan token candidates
- score and rank them
- create trade proposals
- paper-buy and paper-sell them
- track positions and P/L
- generate local reports
- attempt real trading only through a **guarded execution layer** that is **blocked by default**

## What this is

A disciplined local trading research and paper-trading framework for Solana meme-token style discovery workflows.

## What this is not

- not a reckless live trading bot
- not wired for real-money trading by default
- not a browser scraper
- not a wallet-seed manager
- not production-ready live execution infrastructure

## Safety model

V1 is built around a sealed safety cage:

- dry-run default
- global trading disabled default
- real buys disabled default
- real sells disabled default
- burner wallet requirement
- no main wallet flag allowed
- bankroll cap
- buy-size cap
- daily loss cap
- open-position cap
- daily buy cap
- kill switch
- score gates
- hard red flags
- safety event logging
- blocked real-trade attempt logging
- secret redaction in logs

Even if future env flags are turned on, V1 still blocks live execution at the `buildSwap()` stage because wallet signing and transaction execution are intentionally not enabled yet.

## Tech stack

- Node.js
- TypeScript
- SQLite via `better-sqlite3`
- Vitest

## Commands

```bash
npm run token:scan
npm run token:score
npm run token:report
npm run token:propose
npm run token:paper-buy -- --proposal-id 1
npm run token:paper-buy -- --mint SAFE11111111111111111111111111111111111111111
npm run token:paper-sell -- --position-id 1
npm run token:paper-sell -- --mint SAFE11111111111111111111111111111111111111111
npm run token:positions
npm run token:verify-safety
npm run token:kill
npm run token:autopilot
npm test
```

## Configuration

Environment variables are loaded from your shell or `.env`.

Key variables:

- `TOKEN_RADAR_DRY_RUN=true`
- `TRADING_DISABLED=true`
- `ENABLE_REAL_BUYS=false`
- `ENABLE_REAL_SELLS=false`
- `MAX_BANKROLL_USD=20`
- `MAX_BUY_USD=2`
- `MAX_DAILY_LOSS_USD=6`
- `MAX_OPEN_POSITIONS=3`
- `MAX_DAILY_BUYS=5`
- `MAX_SLIPPAGE_BPS=500`
- `MIN_LIQUIDITY_USD=20000`
- `MAX_CHASE_PCT=150`
- `MIN_TOKEN_AGE_MIN=10`
- `MAX_TOKEN_AGE_HOURS=24`
- `MIN_SAFETY_SCORE_FOR_AUTOPILOT=32`
- `MIN_MOMENTUM_SCORE_FOR_AUTOPILOT=25`
- `MIN_TOTAL_SCORE_FOR_AUTOPILOT=75`
- `DATABASE_FILE=./data/token-autopilot.sqlite`
- `TOKEN_SOURCE=fixture|dexscreener`
- `KILL_SWITCH_FILE=./data/.kill-switch`
- `ENABLE_SOLANA_SAFETY_ENRICHMENT=false`
- `SOLANA_RPC_URL=`
- `ENABLE_QUOTE_CHECK=false`
- `BURNER_WALLET_PUBLIC_KEY=`
- `BURNER_WALLET_PRIVATE_KEY=`
- `MAIN_WALLET_PRESENT=false`

Default remains:

- `TOKEN_SOURCE=fixture`
- `ENABLE_SOLANA_SAFETY_ENRICHMENT=false`
- `ENABLE_QUOTE_CHECK=false`

This keeps tests stable and keeps live/RPC enrichment opt-in.

See `.env.example` for a starting template.

## How to run

### 1. Install

```bash
npm install
```

### 2. Scan with fixtures

```bash
TOKEN_SOURCE=fixture npm run token:scan
```

Fixture mode is the safe, deterministic default used by tests.

### 3. Scan with live read-only DexScreener data

```bash
TOKEN_SOURCE=dexscreener npm run token:scan
```

This uses terminal-safe HTTP requests to public DexScreener endpoints and remains **read-only**.

### 4. Enable optional Solana safety enrichment

```bash
ENABLE_SOLANA_SAFETY_ENRICHMENT=true SOLANA_RPC_URL=https://your-rpc.example TOKEN_SOURCE=dexscreener npm run token:scan
```

This adds read-only RPC-based safety enrichment for Solana mint status and holder concentration heuristics.

### 5. Score tokens

```bash
TOKEN_SOURCE=dexscreener npm run token:score
```

### 6. Generate a report

```bash
TOKEN_SOURCE=dexscreener npm run token:report
```

### 7. Verify current safety status

```bash
npm run token:verify-safety
```

## Scanner modes

### Fixture source

- deterministic
- fast
- used by tests
- keeps development stable

### DexScreener live read-only source

- terminal-safe HTTP only
- no browser scraping
- Solana token discovery from public endpoints
- normalizes live responses into the existing `TokenCandidate` model
- gracefully degrades to empty results on API failure, bad responses, or rate limiting

## Solana safety enrichment

The optional enrichment layer adds **read-only** Solana checks for live-scanned tokens:

- mint authority status
- freeze authority status
- metadata status placeholder
- holder concentration heuristic from largest token accounts when available
- creator status placeholder
- sell quote availability check when quote checks are enabled
- estimated slippage basis points heuristic when quote data is available

This enrichment uses terminal-safe HTTP/RPC only.

It does **not**:

- sign transactions
- build swaps
- submit swaps
- enable real buys
- enable real sells

## Important: enrichment is not a safety guarantee

Enrichment helps evaluate tokens more honestly, but it is **not** proof that a token is safe.

Reasons include:

- RPC data may fail or be incomplete
- holder concentration heuristics are imperfect
- creator-risk logic is still conservative/placeholder-level
- quote availability is not the same as guaranteed sellability in real conditions
- market conditions can change immediately after scanning

## Unknown remains unsafe

If enrichment cannot confidently prove a safety-critical field, Goose keeps it `UNKNOWN`.

That includes cases like:

- missing RPC URL
- RPC failure
- malformed RPC data
- missing holder data
- missing quote data
- disabled quote checks

`UNKNOWN` remains unsafe for autopilot. Tokens with unknown authority, sellability, or holder-concentration data must not become autopilot-safe by default.

## Important: live scanning is not live trading

Enabling `TOKEN_SOURCE=dexscreener` means only that token discovery uses live market data.

It does **not**:

- enable real buys
- enable real sells
- add wallet signing
- bypass dry-run
- bypass trading-disabled mode
- bypass the kill switch

## Why real trading is locked

Real trading is blocked unless **all** safety gates pass, including:

- dry run disabled
- trading disabled flag cleared
- buy/sell enable flags set
- burner wallet configured
- no main wallet flag
- bankroll and buy caps respected
- loss and frequency caps respected
- score thresholds passed
- no hard red flags
- sellability confirmed
- slippage under limit
- kill switch inactive

And after that, V1 still refuses to complete live execution because `buildSwap()` is intentionally a safety stub.

## Reports include

- latest scan time
- token count
- top ranked tokens
- verdict counts
- paper positions
- closed paper P/L
- blocked real trade attempts
- safety event summary
- config safety status

## Future steps before any live trading

Before enabling any live path in a future version, you must add and verify:

1. audited quote adapter
2. audited swap builder
3. burner-wallet-only signer flow
4. transaction simulation checks
5. slippage and sellability verification against live routes
6. holder concentration checks from real on-chain data
7. creator-risk checks from real on-chain data
8. live wallet isolation and key management review
9. rate limiting and retry discipline
10. external monitoring and alerting
11. manual operator signoff
12. separate safety review proving no main wallet can be used

## Important

**Real trading is still locked in V1.**
