# SAFETY.md

## Non-negotiable rules

- No main wallet
- No private keys in repo
- No wallet signing
- No browser automation
- Dry-run stays on by default
- Trading stays disabled by default
- Real buys and sells stay disabled by default
- Auto-paper is simulated only

## Auto-paper does not trade

`token:auto-paper` opens **paper positions only**.
It does not call live execution.
It does not sign anything.
It does not move funds.

## Real trading remains locked

These remain the default:

- `TOKEN_RADAR_DRY_RUN=true`
- `TRADING_DISABLED=true`
- `ENABLE_REAL_BUYS=false`
- `ENABLE_REAL_SELLS=false`

The real execution layer is still guarded and blocked.

## Read-only live data is not live trading

Using:

- `TOKEN_SOURCE=dexscreener`
- optional Solana RPC enrichment
- optional quote checks

still does not enable real trading.
It only improves research inputs for paper evaluation.

## Unknown remains unsafe

If a safety-critical field cannot be proven, it must remain `UNKNOWN` and stay unsafe for autopilot.
That includes authority, holder concentration, and sellability checks.

## Paper results are not proof

Paper performance can help evaluate whether a strategy is worth deeper study.
It does **not** prove that future live trading would succeed.

Reasons include:

- live data may be incomplete or wrong
- slippage may differ in reality
- quotes may disappear
- token behavior may change instantly
- paper fills are not real fills

## Before any future live trading

Still required:

1. audited quote/build/execute path
2. burner-wallet-only live signing flow
3. reliable sellability checks
4. stronger holder and creator analysis
5. transaction simulation and failure controls
6. explicit live safety review

## Current V1.3 safety status

- auto-paper works in simulation only
- read-only live discovery works
- optional read-only enrichment works
- real trading remains locked

That last point is intentional.
