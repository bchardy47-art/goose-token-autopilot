# Token Grab — Learning Loop

How evidence flows from discovery to learned memory, and how each study command reads it.

## The pipeline

```
discover → score → gate (approve/reject) → paper-observe → outcome → learning-memory
                                                                         │
        ┌────────────────────────────────────────────────────────────────┘
        ▼
   study/report commands (read-only)
```

1. **Discover** — fresh pools / signals enter as cycle rows
   (`data/token-grab/ripper/cycles/cycle-*.jsonl`).
2. **Score & gate** — each row gets a `buyGateDecision` of `BUY_APPROVED_PAPER` or
   `BUY_REJECTED`, plus entry features: `entryMomentumPct` (M5), `liquidityBucket`,
   `vlrBucket`, `clusterRisk`.
3. **Paper-observe** — approved candidates are tracked in paper mode; observations mature.
4. **Outcome** — `priceChangePct` and `outcomeLabel` are recorded once observed.
5. **Learning memory** — everything lands in
   `data/token-grab/ripper/learning-memory.jsonl`, one row per candidate, carrying entry
   features **and** the eventual outcome.

## Key data files

| File | Contents |
|------|----------|
| `cycles/cycle-*.jsonl` | per-cycle candidate rows with gate decision + entry features |
| `learning-memory.jsonl` | candidate rows joined to outcomes (the main evidence store) |
| `paper-intents.jsonl` | open/closed paper intents |
| `paper-intent-observations.jsonl` | maturing observations |
| `bubblemaps-cache.jsonl` | persistent holder-risk cache (24h TTL) |

## Key fields in learning memory

- `entryMomentumPct` — 5-minute entry momentum (**M5**). Banded by `m5ToBand`:
  `M5_VERY_NEGATIVE < M5_NEGATIVE < M5_NEUTRAL < M5_POSITIVE < M5_STRONG < M5_VERY_STRONG`.
- `clusterRisk` — `CLEAN` / `WATCH` / `RISKY` / `UNKNOWN` (UNKNOWN ≠ CLEAN).
- `liquidityBucket` — `LIQ_LT_10K`, `LIQ_10K_30K`, `LIQ_30K_100K`, `LIQ_GTE_100K`, `LIQ_UNKNOWN`.
- `vlrBucket` — `VLR_LT_0_5`, `VLR_0_5_TO_2`, `VLR_GTE_2`, `VLR_UNKNOWN`.
- `gateDecision` — `BUY_APPROVED_PAPER` / `BUY_REJECTED`.
- `priceChangePct` / `outcomeLabel` — the realized outcome (hindsight; never a predictor).

## Evidence maturity ladder

Driven by the count of M5+PNL rows:

| Maturity | M5+PNL rows |
|----------|-------------|
| `NO_M5_DATA` | 0 |
| `TINY_SAMPLE` | < 50 |
| `EARLY_SAMPLE` | < 200 |
| `USABLE_SAMPLE` | < 500 |
| `STRONG_SAMPLE` | ≥ 500 |

Confidence tiers per cell: `IGNORE (<20)`, `INTERESTING_ONLY (<50)`,
`EARLY_EVIDENCE (<200)`, `USABLE_SIGNAL (<500)`, `STRONGER (≥500)`.

A band only reaches gate-proposal strength at `pnlN ≥ 500`.

## How a candidate idea becomes a (possible) proposal

1. The **M5 Evidence Dashboard** and **Usable Sample Deep Dive** show whether a band has
   enough evidence to study.
2. The **Cluster Coverage Audit** and **Approved Priority Study** show whether holder risk
   is resolved for the rows you care about.
3. The **Execution Realism Simulator** converts paper P/L into cost-adjusted P/L so you
   never chase a fake edge.
4. The **Shadow Policy Backtester** scores candidate rules on *execution-adjusted* P/L and
   may mark one `READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW`.
5. The **App Readiness Dashboard** aggregates all of the above and lists blockers.

Even when a policy is marked ready, the verdict is only ever "ready for a **separate
manual** gate proposal review" — never an automatic change, never real trading.

## Growing more evidence

Run the normal paper loop (the deliberate, non-study writers) so new rows accrue. The
study commands are all read-only and can be run anytime to re-measure progress.
