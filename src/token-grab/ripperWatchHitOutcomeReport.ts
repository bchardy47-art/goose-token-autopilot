// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_PROMOTE_TO_REAL_TRADING
//
// Watch-Hit Outcome Report v1 — answers: "Are fresh subgroup watch hits actually outperforming
// normal approved paper candidates?"
//
// Compares OBSERVED paper-intent outcomes across three groups:
//   WATCH_HITS         — rows matching the subgroup watch classifier (entry-time fields only)
//   NON_WATCH_APPROVED — approved observed rows that do NOT match the watch classifier
//   OVERALL_APPROVED   — all approved observed rows
//
// Reuses the EXACT data pipeline of the paper-trade simulation / conviction reports and the
// EXACT watch classifier from ripperSubgroupWatch, so classification is identical to watch mode.
//
// A watch hit is NOT a buy signal. This report never buys, never writes intents/trades, never
// mutates gates or approval policy, never enables real trading, and never converts UNKNOWN
// cluster risk into CLEAN. Watch classification uses entry-time fields only (entryTiming /
// decision, entryMomentumPct / m5 band, liquidity bucket) — never outcome/P&L fields.

import {
  runPaperTradeSimulationReport,
  type SimulatedTrade,
  type PaperTradeSimulationOptions,
} from './ripperPaperTradeSimulationReport';
import {
  classifySubgroupWatch,
  simulatedTradeToWatchRow,
  TARGET_ENTRY_TIMING,
  TARGET_M5_BAND,
  TARGET_LIQUIDITY_BUCKET,
  WATCH_SAFETY_LABEL,
} from './ripperSubgroupWatch';

// ── Tunables ────────────────────────────────────────────────────────────────────

export const DEFAULT_MIN_WATCH_N    = 50;   // below this → WATCH_SAMPLE_TOO_SMALL
export const PNL_CAP_PCT            = 500;   // cap each trade's P/L at +500% for the capped avg
export const OUTPERFORM_WINRATE_LIFT_PP = 10;   // percentage points
export const OUTPERFORM_OUTLIER_MAX     = 0.25;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ────────────────────────────────────────────────────────────────────────

export interface GroupOutcomeStats {
  label:              string;
  n:                  number;
  winRate:            number;
  lossRate:           number;
  flatRate:           number;
  avgPnlRaw:          number;
  avgPnlCapped:       number;
  medianPnl:          number;
  worstPnl:           number;
  bestPnl:            number;
  outlierDependence:  number;          // largest winner's share of total positive (capped) gains
  avgRipperScore:     number | null;
  clusterBreakdown:   Record<string, number>;
  m5BandBreakdown:    Record<string, number>;
  liquidityBreakdown: Record<string, number>;
  vlrBreakdown:       Record<string, number>;
}

export interface WatchHitComparison {
  winRateLiftPp:             number;   // (watch - nonwatch) win rate, in PERCENTAGE POINTS
  medianLift:                number;   // watch - nonwatch median P/L
  cappedAvgLift:             number;   // watch - nonwatch capped avg P/L
  watchWorstPnl:             number;
  nonWatchWorstPnl:          number;
  watchOutlierDependence:    number;
  nonWatchOutlierDependence: number;
}

export type WatchHitRecommendation =
  | 'KEEP_COLLECTING_WATCH_DATA'
  | 'WATCH_HITS_OUTPERFORMING_PAPER_ONLY'
  | 'WATCH_HITS_NOT_OUTPERFORMING'
  | 'WATCH_SAMPLE_TOO_SMALL';

export interface WatchHitOutcomeResult {
  generatedAt:          string;

  watchHits:            GroupOutcomeStats;
  nonWatchApproved:     GroupOutcomeStats;
  overallApproved:      GroupOutcomeStats;

  comparison:           WatchHitComparison;
  recommendation:       WatchHitRecommendation;
  recommendationReason: string;

  target: {
    entryTiming:     string;
    m5Band:          string;
    liquidityBucket: string;
  };
  safetyLabel:          string;        // PAPER_ONLY_WATCH_NOT_BUY
  config: { minWatchN: number; pnlCapPct: number };

  // Safety flags — always true / 0.
  reportOnly:            true;
  readOnly:              true;
  paperOnly:             true;
  realTradingLocked:     true;
  tradingExecuted:       0;
  noGateChanges:         true;
  noBuySignal:           true;
  noFakeTradeMutation:   true;
  noPaperIntentMutation: true;
  unknownNeverClean:     true;
}

export interface WatchHitOutcomeOptions extends PaperTradeSimulationOptions {
  minWatchN?:   number;
  generatedAt?: string;
  /** Test-only: inject simulated trades directly instead of reading the pipeline. */
  _trades?:     SimulatedTrade[];
}

// ── Stat helpers ─────────────────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function cap(pnl: number): number {
  return pnl > PNL_CAP_PCT ? PNL_CAP_PCT : pnl;
}

/**
 * Outlier dependence: the single largest winner's share of total positive (capped) P/L.
 * 0 → gains spread across many trades; ~1 → one trade carries essentially all the gains.
 * Returns 0 when the group has no net positive P/L. Identical definition to the conviction report.
 */
function outlierDependence(cappedPnls: number[]): number {
  const positives = cappedPnls.filter(p => p > 0);
  const sumPos = positives.reduce((s, v) => s + v, 0);
  if (sumPos <= 0) return 0;
  const top = Math.max(...positives);
  return top / sumPos;
}

function tally(values: Array<string | null | undefined>, fallback = 'UNKNOWN'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    // null/empty cluster maps to UNKNOWN — never CLEAN (UNKNOWN stays UNKNOWN).
    const key = (v != null && v.trim() !== '') ? v : fallback;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function buildGroupStats(label: string, trades: SimulatedTrade[]): GroupOutcomeStats {
  const n = trades.length;
  const pnls       = trades.map(t => t.simulatedPnlPct);
  const cappedPnls = pnls.map(cap);
  const winners = trades.filter(t => t.simulatedPnlPct > 0).length;
  const flats   = trades.filter(t => t.simulatedPnlPct === 0).length;
  const losers  = trades.filter(t => t.simulatedPnlPct < 0).length;
  const scores  = trades.map(t => t.ripperScore).filter((s): s is number => typeof s === 'number' && Number.isFinite(s));

  return {
    label,
    n,
    winRate:  n > 0 ? winners / n : 0,
    lossRate: n > 0 ? losers  / n : 0,
    flatRate: n > 0 ? flats   / n : 0,
    avgPnlRaw:    avg(pnls),
    avgPnlCapped: avg(cappedPnls),
    medianPnl:    median(pnls),
    worstPnl:     pnls.length ? Math.min(...pnls) : 0,
    bestPnl:      pnls.length ? Math.max(...pnls) : 0,
    outlierDependence: outlierDependence(cappedPnls),
    avgRipperScore: scores.length ? avg(scores) : null,
    clusterBreakdown:   tally(trades.map(t => t.clusterRisk)),          // null → UNKNOWN, never CLEAN
    m5BandBreakdown:    tally(trades.map(t => t.m5Band), 'UNAVAILABLE'),
    liquidityBreakdown: tally(trades.map(t => t.liquidityBucket)),
    vlrBreakdown:       tally(trades.map(t => t.vlrBucket)),
  };
}

// ── Main runner ──────────────────────────────────────────────────────────────────

export function runWatchHitOutcomeReport(opts: WatchHitOutcomeOptions = {}): WatchHitOutcomeResult {
  const minWatchN   = opts.minWatchN   ?? DEFAULT_MIN_WATCH_N;
  const generatedAt = opts.generatedAt ?? new Date(opts.nowMs ?? Date.now()).toISOString();

  // Same data source / pipeline as the simulation & conviction reports (read-only).
  // All OBSERVED paper intents are approved paper rows (paper intents are only created for
  // BUY_APPROVED_PAPER candidates), so the full set is OVERALL_APPROVED.
  const trades: SimulatedTrade[] = opts._trades ?? runPaperTradeSimulationReport({
    intentsPath: opts.intentsPath,
    memoryPath:  opts.memoryPath,
    cyclesDir:   opts.cyclesDir,
    nowMs:       opts.nowMs,
  }).simulatedTrades;

  // Watch classification — entry-time fields ONLY (via the shared classifier). The adapter
  // passes paperEntryTiming / entryMomentumPct (m5 band) / liquidityBucket; simulatedPnlPct
  // (the outcome) is never consulted to decide whether a row is a watch hit.
  const watchTrades:    SimulatedTrade[] = [];
  const nonWatchTrades: SimulatedTrade[] = [];
  for (const t of trades) {
    if (classifySubgroupWatch(simulatedTradeToWatchRow(t)).matched) watchTrades.push(t);
    else nonWatchTrades.push(t);
  }

  const watchHits        = buildGroupStats('WATCH_HITS', watchTrades);
  const nonWatchApproved = buildGroupStats('NON_WATCH_APPROVED', nonWatchTrades);
  const overallApproved  = buildGroupStats('OVERALL_APPROVED', trades);

  const comparison: WatchHitComparison = {
    winRateLiftPp:             (watchHits.winRate - nonWatchApproved.winRate) * 100,
    medianLift:                watchHits.medianPnl - nonWatchApproved.medianPnl,
    cappedAvgLift:             watchHits.avgPnlCapped - nonWatchApproved.avgPnlCapped,
    watchWorstPnl:             watchHits.worstPnl,
    nonWatchWorstPnl:          nonWatchApproved.worstPnl,
    watchOutlierDependence:    watchHits.outlierDependence,
    nonWatchOutlierDependence: nonWatchApproved.outlierDependence,
  };

  // ── Recommendation ──────────────────────────────────────────────────────────────
  let recommendation: WatchHitRecommendation;
  let recommendationReason: string;

  if (watchHits.n < minWatchN) {
    recommendation = 'WATCH_SAMPLE_TOO_SMALL';
    recommendationReason =
      `Watch hits n=${watchHits.n} < ${minWatchN}. Not enough watch-hit outcomes to judge. ` +
      `Keep collecting paper observations.`;
  } else if (
    comparison.winRateLiftPp >= OUTPERFORM_WINRATE_LIFT_PP &&
    watchHits.medianPnl    > nonWatchApproved.medianPnl &&
    watchHits.avgPnlCapped > nonWatchApproved.avgPnlCapped &&
    watchHits.outlierDependence <= OUTPERFORM_OUTLIER_MAX
  ) {
    recommendation = 'WATCH_HITS_OUTPERFORMING_PAPER_ONLY';
    recommendationReason =
      `Watch hits beat non-watch approvals by ${comparison.winRateLiftPp.toFixed(1)}pp win rate, ` +
      `higher median (+${comparison.medianLift.toFixed(2)}%) and capped avg (+${comparison.cappedAvgLift.toFixed(2)}%), ` +
      `with low outlier dependence (${watchHits.outlierDependence.toFixed(2)}). ` +
      `PAPER-ONLY evidence — DO_NOT_PROMOTE_TO_REAL_TRADING, DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE.`;
  } else if (
    watchHits.winRate  < nonWatchApproved.winRate ||
    watchHits.medianPnl < nonWatchApproved.medianPnl
  ) {
    recommendation = 'WATCH_HITS_NOT_OUTPERFORMING';
    recommendationReason =
      `Watch hits do not beat non-watch approvals (win rate ${(watchHits.winRate * 100).toFixed(1)}% ` +
      `vs ${(nonWatchApproved.winRate * 100).toFixed(1)}%, median ${watchHits.medianPnl.toFixed(2)}% ` +
      `vs ${nonWatchApproved.medianPnl.toFixed(2)}%). The watch subgroup is not currently outperforming.`;
  } else {
    recommendation = 'KEEP_COLLECTING_WATCH_DATA';
    recommendationReason =
      `Watch hits are ahead on some measures but not clearly outperforming (win-rate lift ` +
      `${comparison.winRateLiftPp.toFixed(1)}pp, outlier dependence ${watchHits.outlierDependence.toFixed(2)}). ` +
      `Keep collecting watch data.`;
  }

  return {
    generatedAt,
    watchHits,
    nonWatchApproved,
    overallApproved,
    comparison,
    recommendation,
    recommendationReason,
    target: {
      entryTiming:     TARGET_ENTRY_TIMING,
      m5Band:          TARGET_M5_BAND,
      liquidityBucket: TARGET_LIQUIDITY_BUCKET,
    },
    safetyLabel: WATCH_SAFETY_LABEL,
    config: { minWatchN, pnlCapPct: PNL_CAP_PCT },

    reportOnly:            true,
    readOnly:              true,
    paperOnly:             true,
    realTradingLocked:     true,
    tradingExecuted:       0,
    noGateChanges:         true,
    noBuySignal:           true,
    noFakeTradeMutation:   true,
    noPaperIntentMutation: true,
    unknownNeverClean:     true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────────

function pctStr(v: number): string { return (v * 100).toFixed(1) + '%'; }
function pnlStr(v: number): string { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function ppStr(v: number):  string { return (v >= 0 ? '+' : '') + v.toFixed(1) + 'pp'; }

function breakdownStr(b: Record<string, number>): string {
  const entries = Object.entries(b).sort((a, b2) => b2[1] - a[1]);
  if (entries.length === 0) return '(none)';
  return entries.map(([k, v]) => `${k}=${v}`).join('  ');
}

function renderGroup(L: string[], g: GroupOutcomeStats): void {
  L.push(`  ${g.label}  (n=${g.n})`);
  L.push(`    win=${pctStr(g.winRate)}  loss=${pctStr(g.lossRate)}  flat=${pctStr(g.flatRate)}`);
  L.push(`    avgRaw=${pnlStr(g.avgPnlRaw)}  avgCap=${pnlStr(g.avgPnlCapped)}  med=${pnlStr(g.medianPnl)}`);
  L.push(`    worst=${pnlStr(g.worstPnl)}  best=${pnlStr(g.bestPnl)}  outlierDep=${g.outlierDependence.toFixed(2)}`);
  L.push(`    avgRipperScore=${g.avgRipperScore != null ? g.avgRipperScore.toFixed(1) : 'n/a'}`);
  L.push(`    cluster  : ${breakdownStr(g.clusterBreakdown)}`);
  L.push(`    m5 band  : ${breakdownStr(g.m5BandBreakdown)}`);
  L.push(`    liquidity: ${breakdownStr(g.liquidityBreakdown)}`);
  L.push(`    vlr      : ${breakdownStr(g.vlrBreakdown)}`);
  L.push('');
}

export function renderWatchHitOutcomeReport(r: WatchHitOutcomeResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — WATCH-HIT OUTCOME REPORT (PAPER ONLY — NOT A BUY SIGNAL)');
  L.push('  [REPORT ONLY — READ ONLY — PAPER ONLY — UNKNOWN ≠ CLEAN]');
  L.push('  Are fresh subgroup watch hits outperforming normal approved paper candidates?');
  L.push(SEP, '');
  L.push(`  Generated at : ${r.generatedAt}`);
  L.push(`  Watch target : entryTiming=${r.target.entryTiming} | m5Band=${r.target.m5Band} | ` +
    `liquidity=${r.target.liquidityBucket}`);
  L.push('  Watch classification uses ENTRY-TIME fields only (never outcome/P&L).');
  L.push('');

  // §1 — Group outcomes
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — GROUP OUTCOMES (OBSERVED paper rows)');
  L.push(`  ${SEP2}`, '');
  renderGroup(L, r.watchHits);
  renderGroup(L, r.nonWatchApproved);
  renderGroup(L, r.overallApproved);

  // §2 — Comparison
  const c = r.comparison;
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — WATCH vs NON-WATCH COMPARISON');
  L.push(`  ${SEP2}`, '');
  L.push(`  Win-rate lift      : ${ppStr(c.winRateLiftPp)}  (watch ${pctStr(r.watchHits.winRate)} vs non-watch ${pctStr(r.nonWatchApproved.winRate)})`);
  L.push(`  Median lift        : ${pnlStr(c.medianLift)}  (watch ${pnlStr(r.watchHits.medianPnl)} vs non-watch ${pnlStr(r.nonWatchApproved.medianPnl)})`);
  L.push(`  Capped-avg lift    : ${pnlStr(c.cappedAvgLift)}  (watch ${pnlStr(r.watchHits.avgPnlCapped)} vs non-watch ${pnlStr(r.nonWatchApproved.avgPnlCapped)})`);
  L.push(`  Worst-loss compare : watch ${pnlStr(c.watchWorstPnl)}  vs non-watch ${pnlStr(c.nonWatchWorstPnl)}`);
  L.push(`  Outlier-dep compare: watch ${c.watchOutlierDependence.toFixed(2)}  vs non-watch ${c.nonWatchOutlierDependence.toFixed(2)}`);
  L.push('');

  // §3 — Recommendation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — RECOMMENDATION');
  L.push(`  ${SEP2}`, '');
  L.push(`  [${r.recommendation}]`);
  L.push(`  ${r.recommendationReason}`);
  L.push('');

  // §4 — Safety
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push(`  ${r.safetyLabel}`);
  L.push('  PAPER_ONLY_WATCH_NOT_BUY');
  L.push('  DO_NOT_PROMOTE_TO_REAL_TRADING');
  L.push('  DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push('  A watch hit is NOT a buy signal. No gates changed. No intents or trades written.');
  L.push('  UNKNOWN_CLUSTER_RISK_IS_NEVER_TREATED_AS_CLEAN=true');
  L.push(`  reportOnly=true  readOnly=true  paperOnly=true  realTradingLocked=true  tradingExecuted=0`);
  L.push(SEP, '');

  return L.join('\n');
}
