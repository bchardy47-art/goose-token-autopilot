// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_PROMOTE_TO_REAL_TRADING  DO_NOT_TRADE
//
// NO_BM_RESEARCH Quality Report v1 — analyses the existing NO_BM_RESEARCH shadow cohort:
//   - reads data/token-grab/ripper/watch-cohort-no-bm-research.jsonl,
//   - joins each enrolled row to observed paper outcomes (outcome used ONLY to SCORE, never to
//     select membership or as a predictor),
//   - breaks the lane down by ENTRY-TIME dimensions (m5Band, liquidity bucket, vlr bucket,
//     entryTiming, ripperScore band, clusterRisk),
//   - compares NO_BM_RESEARCH vs baseline and the strict-BM lanes (via runFamilyReport).
//
// Strictly READ-ONLY paper research. Never changes gates, never enables real trading, never
// signs/swaps/handles keys, never calls auto-paper or paper-buy, and never treats UNKNOWN
// cluster risk as CLEAN (clusterRisk is grouped verbatim). Cohort membership is fixed at
// enrollment; nothing here uses future P&L to select rows or predict.

import * as fs from 'fs';

import {
  runPaperTradeSimulationReport,
  type SimulatedTrade,
  type PaperTradeSimulationOptions,
} from './ripperPaperTradeSimulationReport';
import {
  runFamilyReport,
  researchLaneFilePath,
  DEFAULT_DATA_DIR,
  PNL_CAP_PCT,
  OUTLIER_MAX,
  FAMILY_MIN_FORWARD_N,
  NO_BM_RESEARCH_MIN_SCORE,
  type ResearchCohortRow,
  type LaneOutcomeStats,
  type LaneReport,
} from './ripperWatchCohortFamily';

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ───────────────────────────────────────────────────────────────────────────

export interface QualityGroupStats {
  key:               string;   // dimension value label (e.g. '-20 to -5', 'LIQ_10K_30K', 'UNKNOWN')
  enrolled:          number;   // rows in this group (any status)
  observed:          number;
  pending:           number;
  unmatched:         number;
  winRate:           number;
  redLossRate:       number;
  flatRate:          number;
  medianPnl:         number;
  avgPnlCapped:      number;
  worstPnl:          number;
  bestPnl:           number;
  outlierDependence: number;
}

export interface QualityDimensionBreakdown {
  dimension: string;                 // 'm5Band' | 'liquidityBucket' | 'vlrBucket' | 'entryTiming' | 'ripperScoreBand' | 'clusterRisk'
  groups:    QualityGroupStats[];    // sorted by observed desc, then enrolled desc
}

/** The single strongest internal subgroup within one dimension (paper-only research, NOT a buy signal). */
export interface BestSubgroup {
  dimension:         string;
  key:               string;
  observed:          number;
  winRate:           number;
  medianPnl:         number;
  avgPnlCapped:      number;
  redLossRate:       number;
  outlierDependence: number;
  beatsBaseline:     boolean;
}

export const DEFAULT_SUBGROUP_MIN_N = 30;   // per-subgroup minimum before a group can "beat baseline"

export interface NoBmQualityReportResult {
  generatedAt:   string;
  cohortPath:    string;
  overall:       QualityGroupStats;       // NO_BM_RESEARCH overall (self-computed)
  breakdowns:    QualityDimensionBreakdown[];
  bestSubgroups: BestSubgroup[];          // strongest internal subgroup per dimension (best m5/liq/vlr/timing/score)
  comparison: {
    baseline:    LaneOutcomeStats;                                  // OVERALL_APPROVED paper population
    strictLanes: Array<{ lane: string; observed: number; stats: LaneOutcomeStats }>;
    research:    LaneOutcomeStats;                                  // NO_BM_RESEARCH (from runFamilyReport)
  };
  beatsBaseline:  boolean;
  recommendation: 'FORWARD_SAMPLE_TOO_SMALL' | 'KEEP_COLLECTING' | 'PAPER_ONLY_RESEARCH_SIGNAL';
  config: { minForwardN: number; pnlCapPct: number; minScore: number };

  // Safety — always true / 0.
  reportOnly:            true;
  readOnly:              true;
  paperOnly:             true;
  realTradingLocked:     true;
  tradingExecuted:       0;
  noGateChanges:         true;
  noBuySignal:           true;
  noPaperIntentMutation: true;
  unknownNeverClean:     true;
}

export interface NoBmQualityReportOptions extends PaperTradeSimulationOptions {
  dataDir?:      string;
  cohortPath?:   string;    // override; defaults to researchLaneFilePath(dataDir)
  minForwardN?:  number;
  subgroupMinN?: number;    // per-subgroup min before a group can be flagged as beating baseline
  generatedAt?:  string;
  /** Test-only injection. */
  _trades?:        SimulatedTrade[];
  _researchRows?:  ResearchCohortRow[];
}

// ── Stat helpers (mirror ripperWatchCohortFamily exactly) ────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}
function avg(arr: number[]): number { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function cap(p: number): number { return p > PNL_CAP_PCT ? PNL_CAP_PCT : p; }
function outlierDependence(capped: number[]): number {
  const pos = capped.filter(p => p > 0);
  const sum = pos.reduce((s, v) => s + v, 0);
  if (sum <= 0) return 0;
  return Math.max(...pos) / sum;
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

// ── Outcome join (mirror joinOutcomes; outcome used ONLY for scoring) ─────────────────

type OutcomeStatus = 'OBSERVED' | 'PENDING' | 'OUTCOME_UNMATCHED';

interface JoinedRow {
  row:    ResearchCohortRow;
  status: OutcomeStatus;
  pnl:    number | null;      // simulatedPnlPct when OBSERVED, else null
}

function joinResearchRows(
  rows: ResearchCohortRow[], tradesByContract: Map<string, SimulatedTrade[]>,
): JoinedRow[] {
  return rows.map(row => {
    const candidates = tradesByContract.get(row.contract) ?? [];
    let status: OutcomeStatus;
    let matchTrade: SimulatedTrade | null = null;

    if (candidates.length === 0) {
      status = 'PENDING';
    } else if (candidates.length === 1) {
      status = 'OBSERVED';
      matchTrade = candidates[0]!;
    } else {
      const capMs = row.capturedAt ? Date.parse(row.capturedAt) : NaN;
      if (Number.isNaN(capMs)) {
        status = 'OUTCOME_UNMATCHED';
      } else {
        const scored = candidates.map(t => {
          const ts = Date.parse(t.targetEntryAt || t.observedAt || '');
          return { t, dist: Number.isNaN(ts) ? Infinity : Math.abs(ts - capMs) };
        }).sort((a, b) => a.dist - b.dist);
        const best = scored[0]!, second = scored[1]!;
        if (Number.isFinite(best.dist) && best.dist < second.dist) { status = 'OBSERVED'; matchTrade = best.t; }
        else status = 'OUTCOME_UNMATCHED';
      }
    }
    return { row, status, pnl: matchTrade ? matchTrade.simulatedPnlPct : null };
  });
}

function statsForGroup(key: string, joined: JoinedRow[]): QualityGroupStats {
  const observedRows = joined.filter(j => j.status === 'OBSERVED');
  const pnls   = observedRows.map(j => j.pnl!) as number[];
  const capped = pnls.map(cap);
  const n = pnls.length;
  const winners = pnls.filter(p => p > 0).length;
  const flats   = pnls.filter(p => p === 0).length;
  const losers  = pnls.filter(p => p < 0).length;
  return {
    key,
    enrolled:  joined.length,
    observed:  observedRows.length,
    pending:   joined.filter(j => j.status === 'PENDING').length,
    unmatched: joined.filter(j => j.status === 'OUTCOME_UNMATCHED').length,
    winRate:     n ? winners / n : 0,
    redLossRate: n ? losers  / n : 0,
    flatRate:    n ? flats   / n : 0,
    medianPnl:    median(pnls),
    avgPnlCapped: avg(capped),
    worstPnl:     pnls.length ? Math.min(...pnls) : 0,
    bestPnl:      pnls.length ? Math.max(...pnls) : 0,
    outlierDependence: outlierDependence(capped),
  };
}

// ── Entry-time dimensions (NEVER outcome/P&L) ─────────────────────────────────────────

/** ripperScore → band. null → UNKNOWN. The research lane enrolls score >= NO_BM_RESEARCH_MIN_SCORE. */
export function ripperScoreBand(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return 'SCORE_UNKNOWN';
  if (score >= 100) return 'SCORE_100';
  if (score >= 90)  return 'SCORE_90_99';
  if (score >= 80)  return 'SCORE_80_89';
  if (score >= NO_BM_RESEARCH_MIN_SCORE) return `SCORE_${NO_BM_RESEARCH_MIN_SCORE}_79`;
  return 'SCORE_BELOW_FLOOR';
}

interface Dim { dimension: string; get: (r: ResearchCohortRow) => string; }
const DIMENSIONS: Dim[] = [
  { dimension: 'm5Band',          get: r => r.m5Band || 'UNAVAILABLE' },
  { dimension: 'liquidityBucket', get: r => r.liquidityBucket || 'UNKNOWN' },
  { dimension: 'vlrBucket',       get: r => r.vlrBucket || 'UNKNOWN' },
  { dimension: 'entryTiming',     get: r => r.entryTiming || 'UNKNOWN' },
  { dimension: 'ripperScoreBand', get: r => ripperScoreBand(r.ripperScore) },
  // clusterRisk grouped verbatim; null → UNKNOWN, NEVER CLEAN.
  { dimension: 'clusterRisk',     get: r => (r.clusterRisk != null && String(r.clusterRisk).trim() !== '') ? String(r.clusterRisk) : 'UNKNOWN' },
];

function breakdownBy(dim: Dim, joined: JoinedRow[]): QualityDimensionBreakdown {
  const groups = new Map<string, JoinedRow[]>();
  for (const j of joined) {
    const k = dim.get(j.row);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(j);
  }
  const out = [...groups.entries()].map(([k, rows]) => statsForGroup(k, rows));
  out.sort((a, b) => b.observed - a.observed || b.enrolled - a.enrolled || a.key.localeCompare(b.key));
  return { dimension: dim.dimension, groups: out };
}

// ── Main ──────────────────────────────────────────────────────────────────────────────

export function runNoBmQualityReport(opts: NoBmQualityReportOptions = {}): NoBmQualityReportResult {
  const dataDir     = opts.dataDir     ?? DEFAULT_DATA_DIR;
  const cohortPath  = opts.cohortPath  ?? researchLaneFilePath(dataDir);
  const minForwardN = opts.minForwardN ?? FAMILY_MIN_FORWARD_N;
  const generatedAt = opts.generatedAt ?? new Date(opts.nowMs ?? Date.now()).toISOString();

  const trades: SimulatedTrade[] = opts._trades ?? runPaperTradeSimulationReport({
    intentsPath: opts.intentsPath,
    memoryPath:  opts.memoryPath,
    cyclesDir:   opts.cyclesDir,
    nowMs:       opts.nowMs,
  }).simulatedTrades;

  const researchRows: ResearchCohortRow[] = opts._researchRows ?? readJsonl<ResearchCohortRow>(cohortPath);

  const tradesByContract = new Map<string, SimulatedTrade[]>();
  for (const t of trades) {
    const list = tradesByContract.get(t.contract) ?? [];
    list.push(t);
    tradesByContract.set(t.contract, list);
  }

  const subgroupMinN = opts.subgroupMinN ?? DEFAULT_SUBGROUP_MIN_N;
  const joined = joinResearchRows(researchRows, tradesByContract);
  const overall = statsForGroup('ALL', joined);
  const breakdowns = DIMENSIONS.map(d => breakdownBy(d, joined));

  // Authoritative comparison (baseline + strict lanes + research overall) via the family report.
  const family = runFamilyReport({
    dataDir, intentsPath: opts.intentsPath, memoryPath: opts.memoryPath, cyclesDir: opts.cyclesDir,
    minForwardN, _trades: trades, _researchCohortRows: researchRows,
  });

  // Best internal subgroup per dimension (paper-only research — NOT a buy signal).
  // Excludes the trivial single-value 'entryTiming' / 'clusterRisk' dims from the "best" set;
  // the actionable internal features are m5Band, liquidityBucket, vlrBucket, ripperScoreBand.
  const BEST_DIMS = new Set(['m5Band', 'liquidityBucket', 'vlrBucket', 'ripperScoreBand', 'entryTiming']);
  const bestSubgroups = breakdowns
    .filter(b => BEST_DIMS.has(b.dimension))
    .map(b => pickBestSubgroup(b, family.baseline, subgroupMinN))
    .filter((x): x is BestSubgroup => x != null);
  const strictLanes = family.lanes.map((l: LaneReport) => ({ lane: l.lane, observed: l.observedCount, stats: l.stats }));
  const researchStats = family.researchLane ? family.researchLane.stats : overallToLaneStats(overall);

  // Conservative research verdict (NEVER a trade action).
  const beatsBaseline =
    overall.observed >= minForwardN &&
    researchStats.winRate      > family.baseline.winRate &&
    researchStats.avgPnlCapped > family.baseline.avgPnlCapped &&
    researchStats.medianPnl    >= family.baseline.medianPnl &&
    researchStats.redLossRate  <= family.baseline.redLossRate &&
    researchStats.outlierDependence <= OUTLIER_MAX;

  const recommendation: NoBmQualityReportResult['recommendation'] =
    overall.observed < minForwardN ? 'FORWARD_SAMPLE_TOO_SMALL' :
    beatsBaseline                  ? 'PAPER_ONLY_RESEARCH_SIGNAL' :
    'KEEP_COLLECTING';

  return {
    generatedAt, cohortPath, overall, breakdowns, bestSubgroups,
    comparison: { baseline: family.baseline, strictLanes, research: researchStats },
    beatsBaseline, recommendation,
    config: { minForwardN, pnlCapPct: PNL_CAP_PCT, minScore: NO_BM_RESEARCH_MIN_SCORE },
    reportOnly: true, readOnly: true, paperOnly: true, realTradingLocked: true, tradingExecuted: 0,
    noGateChanges: true, noBuySignal: true, noPaperIntentMutation: true, unknownNeverClean: true,
  };
}

/** Pick the strongest subgroup in a dimension: highest observed among baseline-beating groups
 *  (win + cappedAvg above baseline, median not worse, red-loss not worse, not outlier-driven,
 *  n >= subgroupMinN). Falls back to the highest-observed group flagged beatsBaseline=false. */
function pickBestSubgroup(
  b: QualityDimensionBreakdown, baseline: LaneOutcomeStats, subgroupMinN: number,
): BestSubgroup | null {
  if (b.groups.length === 0) return null;
  const beats = (g: QualityGroupStats): boolean =>
    g.observed >= subgroupMinN &&
    g.winRate      > baseline.winRate &&
    g.avgPnlCapped > baseline.avgPnlCapped &&
    g.medianPnl    >= baseline.medianPnl &&
    g.redLossRate  <= baseline.redLossRate &&
    g.outlierDependence <= OUTLIER_MAX;
  const qualifying = b.groups.filter(beats);
  const pool = qualifying.length > 0 ? qualifying : b.groups;
  const top = [...pool].sort((a, c) => c.observed - a.observed || c.avgPnlCapped - a.avgPnlCapped)[0]!;
  return {
    dimension: b.dimension, key: top.key, observed: top.observed,
    winRate: top.winRate, medianPnl: top.medianPnl, avgPnlCapped: top.avgPnlCapped,
    redLossRate: top.redLossRate, outlierDependence: top.outlierDependence,
    beatsBaseline: qualifying.length > 0,
  };
}

/** Fallback mapping (used only if the family report lacks a research lane, e.g. empty inputs). */
function overallToLaneStats(o: QualityGroupStats): LaneOutcomeStats {
  return {
    n: o.observed, winRate: o.winRate, redLossRate: o.redLossRate, flatRate: o.flatRate,
    avgPnlRaw: o.avgPnlCapped, avgPnlCapped: o.avgPnlCapped, medianPnl: o.medianPnl,
    worstPnl: o.worstPnl, bestPnl: o.bestPnl, outlierDependence: o.outlierDependence,
    clusterBreakdown: {}, m5BandBreakdown: {},
  };
}

// ── Renderer ────────────────────────────────────────────────────────────────────────

function pctS(v: number): string { return (v * 100).toFixed(1) + '%'; }
function pnlS(v: number): string { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }

function renderGroupLine(g: QualityGroupStats, pad = 16): string {
  return `    ${g.key.padEnd(pad)} obs=${String(g.observed).padStart(4)} pend=${String(g.pending).padStart(4)}  ` +
    `win=${pctS(g.winRate).padStart(6)} redLoss=${pctS(g.redLossRate).padStart(6)} flat=${pctS(g.flatRate).padStart(6)}  ` +
    `med=${pnlS(g.medianPnl).padStart(8)} cappedAvg=${pnlS(g.avgPnlCapped).padStart(8)}  ` +
    `worst=${pnlS(g.worstPnl).padStart(8)} best=${pnlS(g.bestPnl).padStart(9)}  outlierDep=${g.outlierDependence.toFixed(2)}`;
}

export function renderNoBmQualityReport(r: NoBmQualityReportResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — NO_BM_RESEARCH QUALITY REPORT (PAPER ONLY — NOT A BUY SIGNAL)');
  L.push('  [REPORT ONLY — READ ONLY — UNKNOWN ≠ CLEAN — DO_NOT_TRADE]');
  L.push('  Outcome/P&L used ONLY to score; NEVER to select cohort membership or predict.');
  L.push(SEP, '');
  L.push(`  Generated at : ${r.generatedAt}`);
  L.push(`  Cohort file  : ${r.cohortPath}`);
  L.push(`  Enrolled     : ${r.overall.enrolled}  (observed=${r.overall.observed}  pending=${r.overall.pending}  unmatched=${r.overall.unmatched})`);
  L.push('');

  // Overall
  L.push(`  ${SEP2}`);
  L.push('  NO_BM_RESEARCH — OVERALL');
  L.push(`  ${SEP2}`);
  L.push(renderGroupLine({ ...r.overall, key: 'ALL' }));
  L.push('');

  // Comparison
  L.push(`  ${SEP2}`);
  L.push('  COMPARISON — NO_BM_RESEARCH vs BASELINE vs STRICT_BM LANES');
  L.push(`  ${SEP2}`);
  const fmtCmp = (label: string, n: number, s: LaneOutcomeStats): string =>
    `    ${label.padEnd(22)} obs=${String(n).padStart(5)}  win=${pctS(s.winRate).padStart(6)}  ` +
    `redLoss=${pctS(s.redLossRate).padStart(6)}  flat=${pctS(s.flatRate).padStart(6)}  ` +
    `med=${pnlS(s.medianPnl).padStart(8)}  cappedAvg=${pnlS(s.avgPnlCapped).padStart(8)}  outlierDep=${s.outlierDependence.toFixed(2)}`;
  L.push(fmtCmp('BASELINE', r.comparison.baseline.n, r.comparison.baseline));
  for (const l of r.comparison.strictLanes) L.push(fmtCmp(`STRICT_BM:${l.lane}`, l.observed, l.stats));
  L.push(fmtCmp('NO_BM_RESEARCH', r.comparison.research.n, r.comparison.research));
  L.push(`    → beatsBaseline=${r.beatsBaseline ? 'YES' : 'no'}  (paper-only research; NOT a trade signal)`);
  L.push('');

  // Breakdowns
  for (const b of r.breakdowns) {
    L.push(`  ${SEP2}`);
    L.push(`  BREAKDOWN — by ${b.dimension}${b.dimension === 'clusterRisk' ? '  (UNKNOWN stays UNKNOWN, NEVER CLEAN)' : ''}`);
    L.push(`  ${SEP2}`);
    if (b.groups.length === 0) L.push('    (no rows)');
    else for (const g of b.groups) L.push(renderGroupLine(g));
    L.push('');
  }

  // Best internal subgroups (paper-only research; NEVER a buy signal)
  L.push(`  ${SEP2}`);
  L.push('  BEST INTERNAL SUBGROUPS (paper-only research — NOT a buy signal)');
  L.push(`  ${SEP2}`);
  if (r.bestSubgroups.length === 0) L.push('    (no subgroups)');
  else for (const s of r.bestSubgroups) {
    L.push(`    ${s.dimension.padEnd(16)} best=${s.key.padEnd(14)} obs=${String(s.observed).padStart(4)}  ` +
      `win=${pctS(s.winRate).padStart(6)} med=${pnlS(s.medianPnl).padStart(8)} cappedAvg=${pnlS(s.avgPnlCapped).padStart(8)} ` +
      `redLoss=${pctS(s.redLossRate).padStart(6)} outlierDep=${s.outlierDependence.toFixed(2)}  ` +
      `beatsBaseline=${s.beatsBaseline ? 'YES' : 'no'}`);
  }
  L.push('');

  // Recommendation + safety
  L.push(`  ${SEP2}`);
  L.push('  RESEARCH VERDICT');
  L.push(`  ${SEP2}`);
  L.push(`    [${r.recommendation}]  (n=${r.overall.observed}, min=${r.config.minForwardN})`);
  L.push('    A PAPER_ONLY_RESEARCH_SIGNAL is research evidence — it is NEVER a buy signal.');
  L.push('');
  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`);
  L.push('    PAPER_ONLY=true  realTradingLocked=true  tradingExecuted=0  UNKNOWN_NEVER_CLEAN=true');
  L.push('    noGateChanges=true  noBuySignal=true  noPaperIntentMutation=true');
  L.push('    DO_NOT_ENABLE_REAL_TRADING  DO_NOT_PROMOTE_TO_REAL_TRADING  DO_NOT_TRADE');
  L.push('    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push(SEP, '');
  return L.join('\n');
}
