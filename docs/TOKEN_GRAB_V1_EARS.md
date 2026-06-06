# Token Grab V1 Ears — Social & Event Early-Warning Radar

## Why We Are Restarting Token Grab

The original Token Grab approach watched fresh Solana pools and tried to decide from chart signals, liquidity metrics, and safety checks after a token went live. The fundamental problem: **by the time a fresh pool has obvious movement, we are usually late.** Early movers have already set the price. The remaining window shrinks fast.

We do not want to loosen buy gates to compensate for lateness. That leads to chasing, which leads to worse outcomes.

The new approach adds **ears** — pre-launch and event-awareness signals that detect interesting candidates *before* or *as* a pool appears. Fresh pools are still watched, but now matched against signals we already detected. A fresh pool that confirms an earlier signal is far more interesting than random new-pool noise.

## The Three Ear Types

### 1. Social / Pre-launch Ears
Listen for legitimate token launch chatter before a token is live:
- X posts mentioning a ticker with "CA soon," "fair launch," or "Raydium live"
- Contract address posted before pool creation
- Known callers, founder accounts, or official project accounts
- Community countdown and announcement patterns

### 2. Meme / Current-Event Ears
Listen for viral phrases and events before related meme coins appear:
- Trending internet phrases ("PRESIDENT TOAD")
- Sports, celebrity, political, AI moments gaining velocity
- Cross-platform narrative spread
- We watch phrase velocity, not just existence

### 3. Fresh-Pool Matcher
Keep watching GeckoTerminal / DexScreener fresh Solana pools, but don't judge in isolation:
- Match each fresh pool against pre-existing social and event signals
- A pool that matches a signal we already detected scores much higher
- A pool with no context is probably noise

## The Four Lanes

| Lane | Meaning | Decision |
|------|---------|----------|
| `PRE_LAUNCH_WATCH` | Social/launch signal detected, no matching pool yet | `WATCH` |
| `MEME_EVENT_CANDIDATE` | Viral event phrase gaining momentum, no pool yet | `WATCH` |
| `FRESH_LAUNCH_CANDIDATE` | Fresh pool matches a pre-existing social or event signal | `ALERT_ONLY` |
| `NOISE_RUG_LIKELY` | Fresh pool with no context, or spam/bot dominated | `REJECT` |

`ALERT_ONLY` is the strongest action this system takes. It does not execute trades.

## Scoring Model

All scores are 0–100. Positive signals add, negative signals subtract, clamped to [0, 100].

**Positive bonuses:**
| Signal | Points |
|--------|--------|
| Credible pre-launch social signal before pool creation | +25 |
| 2+ independent credible authors | +20 |
| Known caller or official project account | +15 |
| Pool matches viral event phrase (velocity ≥ 50) | +15 |
| Pre-launch derived launch signal matches pool | +10 |
| Social/website metadata present on pool | +10 |
| Liquidity ≥ $20k | +10 |
| Organic engagement visible on social signals | +5 |

**Penalties:**
| Signal | Points |
|--------|--------|
| All matched social signals are post-launch or bot/spam | −25 |
| Identical spam cluster signals | −20 |
| All matched social signals are suspected bots | −20 |
| No social/website metadata on pool | −15 |
| No social/event/pre-launch context at all | −15 |
| Liquidity below $20k or missing | −10 |

## Launch Signal Derivation

Launch signals are derived from social signals automatically. A ticker qualifies for a derived launch signal if:
- 2+ independent **credible** (non-bot, non-spam) authors mention it, **or**
- 1 official project account or known caller mentions it

Bot/spam signals are excluded from this count regardless of post volume.

## Fixture Demo Command

```bash
npm run token:ears-demo
```

Loads fixture data from `fixtures/token-grab/` and produces a human-readable report. No network calls. No DB writes. No trading.

```bash
npm run token:ears-demo -- --json          # structured JSON output
npm run token:ears-demo -- --fixtures-dir=path/to/custom/fixtures
```

## Safety

- **Report only.** No positions opened.
- **No trading executed.** The field `noTradingExecuted: true` is present on every candidate.
- **No buy/sell functions called.** The module is entirely self-contained from fixture data.
- **Buy gates unchanged.** This system does not modify any existing token eligibility thresholds.
- The strongest action this system can produce is `ALERT_ONLY`, which means "look at this."

## Module Layout

```
src/token-grab/
  types.ts       — all domain interfaces and type aliases
  matching.ts    — pool-to-signal matching and launch signal derivation
  scoring.ts     — score computation for each candidate type
  report.ts      — build + render the report
  fixtures.ts    — fixture file loader

fixtures/token-grab/
  social-signals.json   — sample social posts with extracted fields
  event-signals.json    — sample viral event phrases
  fresh-pools.json      — sample fresh Solana pool data

tests/
  tokenGrabEars.test.ts — unit tests for all scoring/matching/lane logic
```

## Recommended Next Steps

1. **Add real X ingestion adapter** — wire `src/social/` to a live X API bearer token; emit `SocialSignal[]` in the same shape the fixture uses
2. **Add watchlist accounts/queries** — define a list of known callers and project accounts to monitor proactively
3. **Add spam/bot detection** — supplement the fixture `flags` with automated detection (duplicate text ratio, account age, zero-engagement patterns)
4. **Match against live GeckoTerminal pools** — replace `fixtures/token-grab/fresh-pools.json` with real pool data from the existing scanner, maintaining the same `FreshPool` interface
5. **Add delayed autopsy snapshots** — for each `FRESH_LAUNCH_CANDIDATE`, capture price/liquidity at 15m / 1h / 4h / 24h to build a feedback loop on signal quality
6. **Calibrate scoring weights** — once autopsy data exists, review which signals actually predicted good outcomes and adjust the +/− point values accordingly
