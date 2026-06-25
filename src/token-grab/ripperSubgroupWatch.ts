// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_PROMOTE_TO_REAL_TRADING
//
// Subgroup Watch (paper-only) v1 — flags candidates that match the strongest subgroup from
// the conviction report (f1ae977):
//
//     entryTiming=ENTER_NOW | m5Band=-20 to -5 | liquidity=LIQ_10K_30K
//     n=78  win=84.6%  avgCap=+5.32%  median=+3.53%  outlierDep=0.07  HIGH_CONVICTION_PAPER_ONLY
//
// WATCH ONLY. A subgroup hit is NOT a buy signal. This module:
//   - never buys, never writes intents/trades, never mutates gates or approval policy,
//   - never enables real trading, wallet signing, or swap execution,
//   - never converts UNKNOWN cluster risk into CLEAN (clusterRisk is passed through verbatim).
//
// It is a pure classifier over candidate rows plus a tiny summary/renderer. Gate decisions
// (BUY_APPROVED_PAPER / BUY_REJECTED) are computed elsewhere and are untouched here.

import { bucketLiquidity } from './ripperLearningMemory';
import {
  runPaperTradeSimulationReport,
  type SimulatedTrade,
  type PaperTradeSimulationOptions,
} from './ripperPaperTradeSimulationReport';

// ── Target subgroup (from the conviction report's top HIGH_CONVICTION_PAPER_ONLY group) ──

export const TARGET_ENTRY_TIMING     = 'ENTER_NOW';
export const TARGET_M5_BAND          = '-20 to -5';
export const TARGET_LIQUIDITY_BUCKET = 'LIQ_10K_30K';
export const TARGET_TIER             = 'HIGH_CONVICTION_PAPER_ONLY';

export const WATCH_LABEL  = 'SUBGROUP_WATCH_PAPER_ONLY';
export const WATCH_REASON = 'Matches high-conviction paper-only subgroup from conviction report';
export const WATCH_SAFETY_LABEL = 'PAPER_ONLY_WATCH_NOT_BUY';

// M5 momentum bands — identical thresholds to the paper-trade simulation / conviction reports.
const M5_BANDS: Array<{ label: string; test: (m: number) => boolean }> = [
  { label: 'M5 <= -20',  test: m => m <= -20 },
  { label: '-20 to -5',  test: m => m > -20 && m <= -5 },
  { label: '-5 to +5',   test: m => m > -5  && m <= 5  },
  { label: '+5 to +20',  test: m => m > 5   && m <= 20 },
  { label: '+20 to +50', test: m => m > 20  && m <= 50 },
  { label: '> +50',      test: m => m > 50  },
];

/** Map a raw M5 momentum percent to its band label. null/non-finite → UNAVAILABLE. */
export function m5BandLabel(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return 'UNAVAILABLE';
  for (const b of M5_BANDS) if (b.test(pct)) return b.label;
  return 'UNAVAILABLE';
}

// ── Input / output shapes ─────────────────────────────────────────────────────────

/**
 * A candidate row to classify. Source-agnostic: feed precomputed band/bucket when you have
 * them (e.g. from SimulatedTrade), or feed raw entryMomentumPct / liquidityUsd and let this
 * module derive them with the same logic the rest of the pipeline uses.
 */
export interface SubgroupWatchRow {
  symbol?:           string | null;
  contract?:         string | null;
  entryTiming?:      string | null;  // e.g. ENTER_NOW / WAIT_10M (paperEntryTiming)
  entryDecision?:    string | null;  // fallback only when entryTiming is absent
  m5Band?:           string | null;  // precomputed band; preferred when present
  entryMomentumPct?: number | null;  // raw M5; used to derive band when m5Band absent
  liquidityBucket?:  string | null;  // precomputed bucket; preferred when present
  liquidityUsd?:     number | null;  // raw liquidity; used to derive bucket when absent
  ripperScore?:      number | null;
  clusterRisk?:      string | null;  // passed through verbatim — UNKNOWN stays UNKNOWN
}

export interface SubgroupWatchClassification {
  matched:           boolean;
  label:             string | null;   // WATCH_LABEL when matched, else null
  reason:            string | null;   // WATCH_REASON when matched, else null
  entryTimingMatch:  boolean;
  m5Match:           boolean;
  liquidityMatch:    boolean;
  m5Band:            string;
  liquidityBucket:   string;
  clusterRisk:       string | null;   // never CLEAN unless the source row already was CLEAN
}

export interface SubgroupWatchHit {
  symbol:          string | null;
  contract:        string | null;
  m5Value:         number | null;     // raw entryMomentumPct, if known
  m5Band:          string;
  liquidityBucket: string;
  ripperScore:     number | null;
  clusterRisk:     string | null;
  label:           string;            // SUBGROUP_WATCH_PAPER_ONLY
  reason:          string;            // WATCH_REASON
}

export interface SubgroupWatchSummary {
  totalRows: number;
  hitCount:  number;
  hits:      SubgroupWatchHit[];
  topHits:   SubgroupWatchHit[];      // first N (default 5)
  target: {
    entryTiming:     string;
    m5Band:          string;
    liquidityBucket: string;
    tier:            string;
  };
  safetyLabel: string;                // PAPER_ONLY_WATCH_NOT_BUY

  // Safety flags — always true / 0. A subgroup hit is explicitly NOT a buy signal.
  reportOnly:          true;
  readOnly:            true;
  paperOnly:           true;
  realTradingLocked:   true;
  tradingExecuted:     0;
  noGateChanges:       true;
  noBuySignal:         true;
  noFakeTradeMutation: true;
  unknownNeverClean:   true;
}

// ── Classification ─────────────────────────────────────────────────────────────────

function isEnterNow(entryTiming?: string | null, entryDecision?: string | null): boolean {
  // Prefer an explicit entryTiming; fall back to a decision field only when timing is absent.
  if (entryTiming != null && entryTiming.trim() !== '') return entryTiming === TARGET_ENTRY_TIMING;
  if (entryDecision != null && entryDecision.trim() !== '') return entryDecision === TARGET_ENTRY_TIMING;
  return false;
}

export function classifySubgroupWatch(row: SubgroupWatchRow): SubgroupWatchClassification {
  const m5Band = (row.m5Band != null && row.m5Band.trim() !== '')
    ? row.m5Band
    : m5BandLabel(row.entryMomentumPct ?? null);

  const liquidityBucket = (row.liquidityBucket != null && row.liquidityBucket.trim() !== '')
    ? row.liquidityBucket
    : bucketLiquidity(row.liquidityUsd ?? null);

  const entryTimingMatch = isEnterNow(row.entryTiming, row.entryDecision);
  const m5Match          = m5Band === TARGET_M5_BAND;
  const liquidityMatch   = liquidityBucket === TARGET_LIQUIDITY_BUCKET;
  const matched          = entryTimingMatch && m5Match && liquidityMatch;

  return {
    matched,
    label:  matched ? WATCH_LABEL  : null,
    reason: matched ? WATCH_REASON : null,
    entryTimingMatch,
    m5Match,
    liquidityMatch,
    m5Band,
    liquidityBucket,
    clusterRisk: row.clusterRisk ?? null, // verbatim — UNKNOWN is never reclassified as CLEAN
  };
}

// ── Summary ─────────────────────────────────────────────────────────────────────────

export function runSubgroupWatch(
  rows: SubgroupWatchRow[],
  opts: { topN?: number } = {},
): SubgroupWatchSummary {
  const topN = opts.topN ?? 5;
  const hits: SubgroupWatchHit[] = [];

  for (const row of rows) {
    const c = classifySubgroupWatch(row);
    if (!c.matched) continue;
    hits.push({
      symbol:          row.symbol ?? null,
      contract:        row.contract ?? null,
      m5Value:         row.entryMomentumPct ?? null,
      m5Band:          c.m5Band,
      liquidityBucket: c.liquidityBucket,
      ripperScore:     row.ripperScore ?? null,
      clusterRisk:     c.clusterRisk,
      label:           WATCH_LABEL,
      reason:          WATCH_REASON,
    });
  }

  return {
    totalRows: rows.length,
    hitCount:  hits.length,
    hits,
    topHits:   hits.slice(0, topN),
    target: {
      entryTiming:     TARGET_ENTRY_TIMING,
      m5Band:          TARGET_M5_BAND,
      liquidityBucket: TARGET_LIQUIDITY_BUCKET,
      tier:            TARGET_TIER,
    },
    safetyLabel: WATCH_SAFETY_LABEL,

    reportOnly:          true,
    readOnly:            true,
    paperOnly:           true,
    realTradingLocked:   true,
    tradingExecuted:     0,
    noGateChanges:       true,
    noBuySignal:         true,
    noFakeTradeMutation: true,
    unknownNeverClean:   true,
  };
}

// ── Adapter + standalone report (same data pipeline as the conviction report) ───────

/** Convert a SimulatedTrade (OBSERVED paper-intent join) into a watch row. */
export function simulatedTradeToWatchRow(t: SimulatedTrade): SubgroupWatchRow {
  return {
    symbol:           t.symbol,
    contract:         t.contract,
    entryTiming:      t.paperEntryTiming,   // ENTER_NOW / WAIT_10M
    entryDecision:    t.entryDecision,
    m5Band:           t.m5Band,             // already banded identically to the conviction report
    entryMomentumPct: t.entryMomentumPct,
    liquidityBucket:  t.liquidityBucket,
    ripperScore:      t.ripperScore,
    clusterRisk:      t.clusterRisk,        // UNKNOWN stays UNKNOWN
  };
}

export interface SubgroupWatchReportResult extends SubgroupWatchSummary {
  generatedAt:         string;
  latestCycle:         string | null;
  latestCycleHitCount: number;             // hits whose sourceCycle is the latest one
}

export interface SubgroupWatchReportOptions extends PaperTradeSimulationOptions {
  topN?:        number;
  generatedAt?: string;
}

/**
 * Standalone watch report. Reuses the paper-trade simulation pipeline (identical data source
 * to the conviction report), classifies every simulated OBSERVED trade, and surfaces watch
 * hits — highlighting the most recent cycle. Read-only; computes nothing that buys.
 */
export function runSubgroupWatchReport(opts: SubgroupWatchReportOptions = {}): SubgroupWatchReportResult {
  const sim = runPaperTradeSimulationReport({
    intentsPath: opts.intentsPath,
    memoryPath:  opts.memoryPath,
    cyclesDir:   opts.cyclesDir,
    nowMs:       opts.nowMs,
  });

  const trades = sim.simulatedTrades;
  const rows   = trades.map(simulatedTradeToWatchRow);
  const summary = runSubgroupWatch(rows, { topN: opts.topN });

  // Latest cycle = lexicographically greatest sourceCycle (cycle ids are timestamp-sortable).
  let latestCycle: string | null = null;
  for (const t of trades) {
    if (t.sourceCycle && (latestCycle == null || t.sourceCycle > latestCycle)) latestCycle = t.sourceCycle;
  }

  // Count hits belonging to that latest cycle (match by contract within the latest-cycle trades).
  const latestContracts = new Set(
    trades.filter(t => t.sourceCycle === latestCycle).map(t => t.contract),
  );
  const latestCycleHitCount = summary.hits.filter(h => h.contract != null && latestContracts.has(h.contract)).length;

  return {
    ...summary,
    generatedAt: opts.generatedAt ?? new Date(opts.nowMs ?? Date.now()).toISOString(),
    latestCycle,
    latestCycleHitCount,
  };
}

export function renderSubgroupWatchReport(r: SubgroupWatchReportResult): string {
  const SEP = '━'.repeat(64);
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — SUBGROUP WATCH REPORT (PAPER ONLY — NOT A BUY SIGNAL)');
  L.push('  [REPORT ONLY — READ ONLY — PAPER ONLY — UNKNOWN ≠ CLEAN]');
  L.push(SEP, '');
  L.push(`  Generated at  : ${r.generatedAt}`);
  L.push(`  Latest cycle  : ${r.latestCycle ?? '(none)'}`);
  L.push(`  Latest-cycle hits : ${r.latestCycleHitCount}`);
  L.push('');
  L.push(renderSubgroupWatchSummary(r));
  L.push('');
  L.push('  A subgroup watch hit is NOT a buy signal. No gates changed. No trades written.');
  L.push('  DO_NOT_ENABLE_REAL_TRADING  DO_NOT_PROMOTE_TO_REAL_TRADING');
  L.push('  DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push(SEP, '');
  return L.join('\n');
}

// ── Renderer (small, embeddable in cycle / loop summaries) ──────────────────────────

function shortContract(c: string | null): string {
  if (!c) return '(none)';
  return c.length > 14 ? c.slice(0, 6) + '..' + c.slice(-4) : c;
}

export function renderSubgroupWatchSummary(s: SubgroupWatchSummary): string {
  const L: string[] = [];
  L.push('  ── SUBGROUP WATCH (PAPER ONLY — NOT A BUY SIGNAL) ──');
  L.push(`  target: entryTiming=${s.target.entryTiming} | m5Band=${s.target.m5Band} | ` +
    `liquidity=${s.target.liquidityBucket}  [${s.target.tier}]`);
  L.push(`  reason: ${WATCH_REASON}`);
  L.push(`  hits  : ${s.hitCount} of ${s.totalRows} rows`);
  if (s.topHits.length > 0) {
    L.push('  top:');
    for (const h of s.topHits) {
      L.push(
        `    ${(h.symbol ?? '-').slice(0, 12).padEnd(12)} ${shortContract(h.contract).padEnd(14)} ` +
        `m5=${h.m5Value != null ? h.m5Value.toFixed(1) + '%' : 'n/a'}  band=${h.m5Band}  ` +
        `liq=${h.liquidityBucket}  score=${h.ripperScore ?? 'n/a'}  cluster=${h.clusterRisk ?? 'n/a'}  ` +
        `[${h.label}]`,
      );
    }
  }
  L.push(`  safety: ${s.safetyLabel}  DO_NOT_PROMOTE_TO_REAL_TRADING  ` +
    `DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE  UNKNOWN≠CLEAN  DO_NOT_ENABLE_REAL_TRADING`);
  return L.join('\n');
}
