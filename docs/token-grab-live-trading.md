# Token Grab — Live (Real) Trading

Token Grab has a **real** autonomous trading capability:

```
scan → score → risk-check → buy real token → monitor real position → sell real token → ledger → recover → learn → repeat
```

Chain: **Solana**. Swap provider: **Jupiter** (real quote + swap-transaction build over HTTP).
Submission uses raw Solana JSON-RPC `sendTransaction` with a **runtime-injected signer** —
no private keys live in this repo.

> **Real trading defaults OFF.** It is impossible to place a real order without (1) the
> full unlock env set, (2) a kill switch that is off, and (3) a signer injected at
> runtime. Dry-run and mock modes never touch real money. See
> [`token-grab-safety.md`](./token-grab-safety.md).

## Capability summary

| Capability | Status |
|------------|--------|
| Real execution adapter (Jupiter) | implemented (`ripperRealExecutionAdapter.ts`) |
| Real quote fetching | implemented (`GET /quote`) |
| Real buy build path | implemented (`POST /swap` → unsigned tx) |
| Real sell build path | implemented (`POST /swap` → unsigned tx) |
| Real submit | implemented (RPC `sendTransaction`), **refuses without unlock + signer** |
| Dry-run mode | real quotes, never submits |
| Mock mode | synthetic fills, no network/money |
| Live mode | requires full unlock + injected signer |
| Open-position recovery | from the durable ledger |
| Stop-loss / take-profit / trailing / max-hold exits | implemented |
| Durable real-trading ledger | `data/token-grab/ripper/real-trading-ledger.jsonl` |
| Daemon mode | interval loop, stop-file, failure circuit breaker |
| Operator control center | status / positions / stop file / doctor |
| Final acceptance | `npm run token:ripper-final-acceptance-live` |

## Modes

- **`--dry-run`** (default): fetches **real** Jupiter quotes, writes a planned-buy ledger
  event, and **never** submits. Safe to run anytime.
- **`--mock`**: deterministic synthetic buy/sell. No network, no money. For pipeline tests.
- **`--live`**: submits real orders — **only** when fully unlocked AND a signer is injected.

## Unlock env (all required for live)

```
TOKEN_GRAB_LIVE_TRADING_ENABLED=1
TOKEN_GRAB_LIVE_TRADING_CONFIRM=I_UNDERSTAND_THIS_CAN_LOSE_REAL_MONEY
TOKEN_GRAB_REAL_KILL_SWITCH=0           # must NOT be 1
TOKEN_GRAB_REAL_MAX_POSITION_USD=<positive>
TOKEN_GRAB_REAL_MAX_DAILY_LOSS_USD=<positive>
TOKEN_GRAB_REAL_MAX_OPEN_POSITIONS=<positive>
TOKEN_GRAB_REAL_MAX_TRADES_PER_DAY=<positive>
TOKEN_GRAB_REAL_MAX_SLIPPAGE_BPS=<positive>
TOKEN_GRAB_REAL_MIN_LIQUIDITY_USD=<positive>
TOKEN_GRAB_RPC_URL=<solana rpc url>     # or SOLANA_RPC_URL
TOKEN_GRAB_WALLET_PUBLIC_KEY=<PUBLIC key only — never a secret>
TOKEN_GRAB_SWAP_PROVIDER=jupiter
TOKEN_GRAB_EXECUTION_MODE=dry-run       # dry-run|mock|live (flags override)
```

If any are missing the doctor reports **LIVE CAPABLE BUT NOT CONFIGURED** (or
**…NOT CONFIRMED**) — never "finished/ready".

### The signer (no keys in repo)

A real submit also requires a **runtime-injected signer** implementing
`signTransactionBase64()` (see `TransactionSigner` in `ripperRealExecutionAdapter.ts`).
This repo never stores, reads, or prints a private key. Without an injected signer, the
adapter throws `SUBMIT_BLOCKED_NO_SIGNER`.

## Kill switch & stop file

- **Kill switch**: `TOKEN_GRAB_REAL_KILL_SWITCH=1` hard-blocks every order and forces
  exits — even with a fully unlocked config.
- **Stop file**: `data/token-grab/ripper/LIVE_STOP` — if present, the daemon will not
  start new cycles. Create/clear it via the control center.

## Risk limits (every real order must pass)

The Live Risk Gate blocks an order unless: config unlocked (live), kill switch off,
size ≤ max position, daily loss < limit, open positions < max, trades today < max,
liquidity ≥ min, slippage ≤ max, no duplicate position, candidate currently approved,
feed not stale, **clusterRisk not UNKNOWN** (UNKNOWN is never CLEAN; override is explicit),
and **execution-adjusted edge not negative**.

## Ledger & recovery

Every lifecycle event is written to the durable ledger **before and after** submission.
Open/closed positions, daily P/L, daily loss, and trade counts are all **recovered** from
the ledger, so a crash mid-run never loses position state. The ledger never stores a
private key (secret-shaped values are redacted).

## Commands

```bash
# 1. Check capability/config (no trade)
npm run token:ripper-live-config-doctor

# 2. One dry-run cycle (real quotes, no submit)
npm run token:ripper-live-runner -- --dry-run --once

# 3. One mock cycle (synthetic fills)
npm run token:ripper-live-runner -- --mock --once

# 4. Daemon, dry-run, one cycle
npm run token:ripper-live-daemon -- --dry-run --once

# 5. Operator status
npm run token:ripper-live-control -- --status
npm run token:ripper-live-control -- --create-stop     # pause the daemon
npm run token:ripper-live-control -- --clear-stop       # resume

# 6. Prove the app is finished for real-trading CAPABILITY (no real trade)
npm run token:ripper-final-acceptance-live
```

Going live (operator, deliberate): set the unlock env, inject a signer in your harness,
run `--dry-run` first, then `--live --once`, watching the control center and ledger.

## Proving it is finished

```bash
npm run token:ripper-final-acceptance-live
```

Expects `FINISHED_FOR_AUTONOMOUS_REAL_TRADING_CAPABILITY: YES`,
`LIVE_TRADING_DEFAULT: OFF`, `LIVE_TRADING_UNLOCK_REQUIRED: YES`, and
`REAL_TRADING_NOT_EXECUTED_DURING_BUILD: YES`. It **fails** if the real provider adapter
is ever reduced to a placeholder.

## No secrets in the repo

No private keys, mnemonics, or wallet credentials are stored, printed, or committed. Only
the wallet **public** key is referenced, and even that is masked in output. The config
doctor redacts any secret-shaped env it detects.
