# SAFETY.md

## Non-negotiable V1 rules

- Use a **burner wallet only**.
- Never use a main wallet.
- Never store a seed phrase in the repo.
- Never commit wallet files.
- Keep dry-run on by default.
- Keep trading disabled by default.
- Keep real buys and real sells disabled by default.
- Keep full safety logs.
- Redact secrets from logs.

## Burner wallet requirement

Any future live mode must require a dedicated burner wallet with a capped bankroll.

V1 blocks live execution when burner wallet config is missing.

## No main wallet

`MAIN_WALLET_PRESENT=true` is treated as unsafe and blocks execution.

The intent is explicit: if there is any indication a main wallet is involved, Goose must refuse to trade.

## Dry-run default

Default config:

- `TOKEN_RADAR_DRY_RUN=true`
- `TRADING_DISABLED=true`
- `ENABLE_REAL_BUYS=false`
- `ENABLE_REAL_SELLS=false`
- `TOKEN_SOURCE=fixture`
- `ENABLE_SOLANA_SAFETY_ENRICHMENT=false`
- `ENABLE_QUOTE_CHECK=false`

These settings make live trading impossible by default.

## Live read-only scanning is not live trading

You may set:

- `TOKEN_SOURCE=dexscreener`
- `ENABLE_SOLANA_SAFETY_ENRICHMENT=true`
- `SOLANA_RPC_URL=...`
- `ENABLE_QUOTE_CHECK=true`

This only enables read-only discovery and read-only safety enrichment through public HTTP/RPC APIs.

It does **not** enable:

- wallet signing
- real buys
- real sells
- swap execution

## Safety enrichment

The enrichment layer is allowed to inspect live tokens more honestly using read-only methods.

Current V1 enrichment can attempt:

- mint authority status
- freeze authority status
- holder concentration heuristic
- metadata status placeholder
- sell quote availability heuristic
- estimated slippage heuristic

Enrichment is useful, but it is not a guarantee that a token is safe or sellable.

## Kill switch

`npm run token:kill` writes a local kill-switch file.

When active, all future real-trade attempts are blocked.

## Hard caps

V1 enforces or checks these caps:

- bankroll cap
- per-buy cap
- daily loss cap
- open-position cap
- daily buy cap
- slippage cap

## Hard red flags

Any hard red flag forces `AVOID`:

- freeze authority active
- freeze authority unknown
- mint authority active
- mint authority unknown
- low liquidity
- sell quote unavailable
- high slippage
- stale data
- missing metadata
- over-chased token
- suspicious holder concentration placeholder
- suspicious creator placeholder
- missing price/liquidity data

## Unknowns are unsafe

In V1, unknown values are not treated as safe enough for autopilot.

That includes:

- unknown authority status
- unknown sellability
- unknown holder concentration
- unknown metadata status when a stronger check is required later

This matters especially for live read-only sources. If live market data or enrichment cannot prove these fields, Goose must keep them as `UNKNOWN`, and autopilot must remain blocked.

## Enrichment failure handling

If RPC or quote checks fail:

- Goose must not guess
- Goose must not silently trust partial data
- Goose should log a safety event
- Goose should keep unresolved fields as `UNKNOWN`

That conservative behavior is intentional.

## Risks

This project deals with highly volatile tokens and incomplete information.

Major risks include:

- rapid price collapse
- illiquidity
- honeypots or unsellable tokens
- stale or incomplete market data
- authority abuse
- concentration risk
- unsafe wallet handling if future live execution is added carelessly

## Before enabling real buys in any future version

You must verify all of the following:

1. burner wallet is isolated
2. bankroll cap is set and enforced
3. max buy cap is set and enforced
4. daily loss cap is set and enforced
5. daily buy cap is set and enforced
6. open-position cap is set and enforced
7. sellability checks are real and reliable
8. slippage checks are real and reliable
9. holder concentration checks use real data
10. creator checks use real data
11. transaction building is audited
12. signing path cannot leak private key material
13. logs do not expose secrets
14. kill switch works under failure conditions
15. operator explicitly accepts live-risk review

## Current V1 status

- fixture scanning works
- live read-only scanning works
- optional read-only Solana safety enrichment works
- paper trading works
- reporting works
- proposals work
- guarded real execution interface exists
- real trading remains locked

That final point is intentional.
