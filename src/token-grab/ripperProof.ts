// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_PROMOTE_TO_REAL_TRADING  DO_NOT_TRADE
//
// Terminal proof layer v1 — a TERMINAL-FIRST proof engine for Token Grab. No UI. The app proves
// or disproves itself through clean terminal scoreboards + append-only paper evidence:
//   - buildProofStatus / renderProofStatus  → one clean proof scoreboard
//   - buildProofLogRow / appendProofLog      → append one compact snapshot (append-only)
//   - runProofSummary / renderProofSummary   → whether the app is improving over time
//
// Strictly paper-only research. Never enables real trading, never signs/swaps, never calls the
// auto-paper or paper-buy commands, never loosens gates or changes policy, never mutates buy/sell
// intents or trades. UNKNOWN cluster risk is never treated as CLEAN. Cohort membership upstream
// uses entry-time fields only; nothing here decides membership from outcome/P&L.

import * as fs   from 'fs';
import * as path from 'path';

import { selectBestLane, type BestLaneSelection } from './ripperFastTest';
import {
  OUTLIER_MAX,
  type FamilyReportResult, type LaneOutcomeStats, type LaneKey, type FamilyLaneRecommendation,
} from './ripperWatchCohortFamily';

// ── Constants ───────────────────────────────────────────────────────────────────────

export const PROOF_SCHEMA_VERSION   = 1;
export const DEFAULT_PROOF_LOG_PATH = 'data/token-grab/ripper/proof-log.jsonl';
export const EDGE_N                 = 50;   // observed n for an edge candidate
export const STRONG_N               = 100;  // observed n for a strong edge
export const STRONG_MIN_CHECKS      = 4;    // baseline checks the best lane must pass for STRONG
export const FRESH_WINDOW_MINUTES   = 30;   // standalone recency window for FRESH vs STALE

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

const ALL_LANES: LaneKey[] = ['EXACT_WATCH', 'LIQUIDITY_NEAR', 'MOMENTUM_FAMILY', 'WAIT10_QUALITY'];

// ── Types ───────────────────────────────────────────────────────────────────────────

export type ConfidenceTier =
  | 'NO_SIGNAL'
  | 'TOO_SMALL'
  | 'WATCHLIST'
  | 'PAPER_EDGE_CANDIDATE'
  | 'STRONG_PAPER_EDGE';

export type ProofDecision =
  | 'KEEP_COLLECTING'
  | 'INVESTIGATE_LANE'
  | 'PAPER_ONLY_CANDIDATE';

export interface ProofCycleInfo {
  id:     string | null;
  time:   string | null;
  fresh:  boolean;
  status: 'FRESH' | 'STALE' | 'STALE_OR_CAPTURE_SKIPPED' | 'NO_CYCLE';
}

export interface ProofLaneMetrics {
  lane:              LaneKey;
  enrolled:          number;
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
  clusterBreakdown:  Record<string, number>;
  m5BandBreakdown:   Record<string, number>;
  recommendation:    FamilyLaneRecommendation;
}

export interface ProofBaseline {
  n:                 number;
  winRate:           number;
  redLossRate:       number;
  flatRate:          number;
  medianPnl:         number;
  avgPnlCapped:      number;
  outlierDependence: number;
}

/** NO_BM_RESEARCH shadow-lane metrics surfaced in proof (BubbleMaps ignored for enrollment). */
export interface ProofResearchLane {
  observed:          number;
  pending:           number;
  winRate:           number;
  redLossRate:       number;
  flatRate:          number;
  medianPnl:         number;
  avgPnlCapped:      number;
  worstPnl:          number;
  bestPnl:           number;
  outlierDependence: number;
  clusterBreakdown:  Record<string, number>;
  recommendation:    FamilyLaneRecommendation;
  bmIgnoredForResearch: true;
}

export interface ProofSafety {
  PAPER_ONLY:                true;
  realTradingLocked:         boolean;
  tradingExecuted:           number;
  UNKNOWN_NEVER_CLEAN:       true;
  DO_NOT_ENABLE_REAL_TRADING: true;
  DO_NOT_TRADE:              true;
}

export interface ProofStatus {
  generatedAt:            string;
  latestCycle:            ProofCycleInfo;
  fastTestRunsObserved:   number | null;
  baseline:               ProofBaseline;
  lanes:                  ProofLaneMetrics[];
  researchLane:           ProofResearchLane | null;  // NO_BM_RESEARCH shadow lane
  bestLane:               BestLaneSelection | null;
  baselineChecksPassedByBest: number;
  confidenceTier:         ConfidenceTier;
  decision:               ProofDecision;
  safety:                 ProofSafety;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────

/** Parse a cycle filename id (cycle-YYYY-MM-DD-HHMMSS) to a display ISO timestamp (UTC). */
export function cycleIdToIso(id: string | null): string | null {
  if (!id) return null;
  const m = id.match(/cycle-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

/** Recency-based freshness for a standalone scoreboard (FRESH within FRESH_WINDOW_MINUTES). */
export function cycleFreshnessFromTime(id: string | null, timeIso: string | null, nowMs: number): ProofCycleInfo {
  if (!id) return { id: null, time: null, fresh: false, status: 'NO_CYCLE' };
  const t = timeIso ? Date.parse(timeIso) : NaN;
  if (Number.isNaN(t)) return { id, time: timeIso, fresh: false, status: 'STALE' };
  const fresh = nowMs - t <= FRESH_WINDOW_MINUTES * 60_000;
  return { id, time: timeIso, fresh, status: fresh ? 'FRESH' : 'STALE' };
}

/** Count of how many baseline checks the lane strictly beats (or is safe on). */
export function countBaselineWins(stats: LaneOutcomeStats, baseline: LaneOutcomeStats): number {
  let c = 0;
  if (stats.winRate      > baseline.winRate)      c++;
  if (stats.medianPnl    > baseline.medianPnl)    c++;
  if (stats.avgPnlCapped > baseline.avgPnlCapped) c++;
  if (stats.redLossRate  < baseline.redLossRate)  c++;
  if (stats.outlierDependence <= OUTLIER_MAX)     c++;
  return c;
}

// ── Build proof status ────────────────────────────────────────────────────────────────

export interface BuildProofStatusInput {
  generatedAt:          string;
  report:               FamilyReportResult;
  cycle:                ProofCycleInfo;
  fastTestRunsObserved: number | null;
}

export function buildProofStatus(input: BuildProofStatusInput): ProofStatus {
  const { report } = input;
  const baseline = report.baseline;

  const lanes: ProofLaneMetrics[] = report.lanes.map(l => ({
    lane:              l.lane,
    enrolled:          l.enrolledCount,
    observed:          l.observedCount,
    pending:           l.pendingCount,
    unmatched:         l.unmatchedCount,
    winRate:           l.stats.winRate,
    redLossRate:       l.stats.redLossRate,
    flatRate:          l.stats.flatRate,
    medianPnl:         l.stats.medianPnl,
    avgPnlCapped:      l.stats.avgPnlCapped,
    worstPnl:          l.stats.worstPnl,
    bestPnl:           l.stats.bestPnl,
    outlierDependence: l.stats.outlierDependence,
    clusterBreakdown:  l.stats.clusterBreakdown,
    m5BandBreakdown:   l.stats.m5BandBreakdown,
    recommendation:    l.recommendation,
  }));

  const rl = report.researchLane;
  const researchLane: ProofResearchLane | null = rl ? {
    observed:          rl.observedCount,
    pending:           rl.pendingCount,
    winRate:           rl.stats.winRate,
    redLossRate:       rl.stats.redLossRate,
    flatRate:          rl.stats.flatRate,
    medianPnl:         rl.stats.medianPnl,
    avgPnlCapped:      rl.stats.avgPnlCapped,
    worstPnl:          rl.stats.worstPnl,
    bestPnl:           rl.stats.bestPnl,
    outlierDependence: rl.stats.outlierDependence,
    clusterBreakdown:  rl.stats.clusterBreakdown,
    recommendation:    rl.recommendation,
    bmIgnoredForResearch: true,
  } : null;

  const bestLane = selectBestLane(report.lanes, baseline);

  let checks = 0;
  let tier: ConfidenceTier;
  if (bestLane == null) {
    tier = 'NO_SIGNAL';
  } else {
    const lr = report.lanes.find(l => l.lane === bestLane.lane)!;
    checks = countBaselineWins(lr.stats, baseline);
    const n = bestLane.observed;
    if (n < EDGE_N)                                       tier = 'TOO_SMALL';
    else if (!bestLane.qualifies)                         tier = 'WATCHLIST';
    else if (n >= STRONG_N && checks >= STRONG_MIN_CHECKS) tier = 'STRONG_PAPER_EDGE';
    else                                                  tier = 'PAPER_EDGE_CANDIDATE';
  }

  const decision: ProofDecision =
    tier === 'WATCHLIST'                                              ? 'INVESTIGATE_LANE' :
    tier === 'PAPER_EDGE_CANDIDATE' || tier === 'STRONG_PAPER_EDGE'  ? 'PAPER_ONLY_CANDIDATE' :
    'KEEP_COLLECTING';

  return {
    generatedAt:          input.generatedAt,
    latestCycle:          input.cycle,
    fastTestRunsObserved: input.fastTestRunsObserved,
    baseline: {
      n:                 baseline.n,
      winRate:           baseline.winRate,
      redLossRate:       baseline.redLossRate,
      flatRate:          baseline.flatRate,
      medianPnl:         baseline.medianPnl,
      avgPnlCapped:      baseline.avgPnlCapped,
      outlierDependence: baseline.outlierDependence,
    },
    lanes,
    researchLane,
    bestLane,
    baselineChecksPassedByBest: checks,
    confidenceTier:       tier,
    decision,
    safety: {
      PAPER_ONLY:                 true,
      realTradingLocked:          report.realTradingLocked,
      tradingExecuted:            report.tradingExecuted,
      UNKNOWN_NEVER_CLEAN:        true,
      DO_NOT_ENABLE_REAL_TRADING: true,
      DO_NOT_TRADE:               true,
    },
  };
}

// ── Render proof status ───────────────────────────────────────────────────────────────

function pctS(v: number): string { return (v * 100).toFixed(1) + '%'; }
function pnlS(v: number): string { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function bd(b: Record<string, number>): string {
  const e = Object.entries(b).sort((a, b2) => b2[1] - a[1]);
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join('  ') : '(none)';
}

export function renderProofStatus(s: ProofStatus): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — RIPPER PROOF STATUS (PAPER ONLY — NOT A BUY SIGNAL)');
  L.push('  [TERMINAL-FIRST PROOF — READ ONLY — UNKNOWN ≠ CLEAN — DO_NOT_TRADE]');
  L.push(SEP, '');
  L.push(`  Generated at         : ${s.generatedAt}`);
  L.push(`  Latest cycle         : ${s.latestCycle.id ?? '(none)'}`);
  L.push(`  Cycle time           : ${s.latestCycle.time ?? '(none)'}`);
  L.push(`  Freshness            : ${s.latestCycle.status}`);
  L.push(`  Fast-test runs seen  : ${s.fastTestRunsObserved ?? 'n/a'}`);
  L.push('');

  const b = s.baseline;
  L.push(`  ${SEP2}`);
  L.push('  BASELINE — OVERALL_APPROVED (observed paper population)');
  L.push(`  ${SEP2}`);
  L.push(`    n=${b.n}  win=${pctS(b.winRate)}  redLoss=${pctS(b.redLossRate)}  flat=${pctS(b.flatRate)}  ` +
    `med=${pnlS(b.medianPnl)}  cappedAvg=${pnlS(b.avgPnlCapped)}  outlierDep=${b.outlierDependence.toFixed(2)}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  COHORT FAMILY LANES');
  L.push(`  ${SEP2}`);
  for (const lane of s.lanes) {
    L.push(`    ${lane.lane}  [${lane.recommendation}]`);
    L.push(`      enrolled=${lane.enrolled}  observed=${lane.observed}  pending=${lane.pending}  unmatched=${lane.unmatched}`);
    L.push(`      win=${pctS(lane.winRate)}  redLoss=${pctS(lane.redLossRate)}  flat=${pctS(lane.flatRate)}  ` +
      `med=${pnlS(lane.medianPnl)}  cappedAvg=${pnlS(lane.avgPnlCapped)}`);
    L.push(`      worst=${pnlS(lane.worstPnl)}  best=${pnlS(lane.bestPnl)}  outlierDep=${lane.outlierDependence.toFixed(2)}`);
    L.push(`      cluster: ${bd(lane.clusterBreakdown)}`);
    L.push(`      m5 band: ${bd(lane.m5BandBreakdown)}`);
  }
  L.push('');

  if (s.researchLane) {
    const rl = s.researchLane;
    L.push(`  ${SEP2}`);
    L.push('  NO_BM_RESEARCH SHADOW LANE (BubbleMaps IGNORED for enrollment)');
    L.push(`  ${SEP2}`);
    L.push(`    [${rl.recommendation}]  bmIgnoredForResearch=true  paperOnly=true  notBuySignal=true  unknownNotClean=true`);
    L.push(`      observed=${rl.observed}  pending=${rl.pending}  ` +
      `win=${pctS(rl.winRate)}  redLoss=${pctS(rl.redLossRate)}  flat=${pctS(rl.flatRate)}`);
    L.push(`      med=${pnlS(rl.medianPnl)}  cappedAvg=${pnlS(rl.avgPnlCapped)}  ` +
      `worst=${pnlS(rl.worstPnl)}  best=${pnlS(rl.bestPnl)}  outlierDep=${rl.outlierDependence.toFixed(2)}`);
    L.push(`      cluster: ${bd(rl.clusterBreakdown)}  (UNKNOWN recorded, NEVER treated as CLEAN)`);
    L.push('');
  }

  L.push(`  ${SEP2}`);
  L.push('  BEST LANE TODAY (conservative ranking)');
  L.push(`  ${SEP2}`);
  if (s.bestLane) {
    L.push(`    ${s.bestLane.lane}  qualifies=${s.bestLane.qualifies ? 'YES' : 'no'}  ` +
      `observed=${s.bestLane.observed}  baselineChecksPassed=${s.baselineChecksPassedByBest}/5`);
    L.push(`    ${s.bestLane.reason}`);
  } else {
    L.push('    (no lane has observed outcomes yet)');
  }
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  PROOF SCOREBOARD');
  L.push(`  ${SEP2}`);
  L.push(`    Confidence tier : ${s.confidenceTier}`);
  L.push(`    Final decision  : ${s.decision}`);
  L.push('    A PAPER_ONLY_CANDIDATE is paper-only research — it is NEVER a buy signal.');
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`);
  L.push(`    PAPER_ONLY=true  realTradingLocked=${s.safety.realTradingLocked}  tradingExecuted=${s.safety.tradingExecuted}`);
  L.push('    UNKNOWN_NEVER_CLEAN=true  noBuySignal=true  noIntentMutation=true');
  L.push('    DO_NOT_ENABLE_REAL_TRADING  DO_NOT_PROMOTE_TO_REAL_TRADING  DO_NOT_TRADE');
  L.push('    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push(SEP, '');
  return L.join('\n');
}

// ── Proof log (append-only) ─────────────────────────────────────────────────────────────

export interface ProofLogRow {
  schemaVersion:  number;
  generatedAt:    string;
  latestCycle:    string | null;
  freshness:      string;
  baseline:       ProofBaseline;
  lanes:          ProofLaneMetrics[];
  researchLane?:  ProofResearchLane | null;  // NO_BM_RESEARCH shadow lane (optional; older rows lack it)
  bestLane:       { lane: LaneKey; qualifies: boolean; observed: number } | null;
  confidenceTier: ConfidenceTier;
  recommendation: ProofDecision;
  safety: {
    paperOnly:          true;
    realTradingLocked:  boolean;
    tradingExecuted:    number;
    unknownNeverClean:  true;
    doNotEnableRealTrading: true;
    doNotTrade:         true;
  };
  gitCommit: string | null;
  gitDirty:  boolean | null;
}

export interface GitInfo { commit: string | null; dirty: boolean | null; }

export function buildProofLogRow(status: ProofStatus, git: GitInfo): ProofLogRow {
  return {
    schemaVersion:  PROOF_SCHEMA_VERSION,
    generatedAt:    status.generatedAt,
    latestCycle:    status.latestCycle.id,
    freshness:      status.latestCycle.status,
    baseline:       status.baseline,
    lanes:          status.lanes,
    researchLane:   status.researchLane,
    bestLane:       status.bestLane
      ? { lane: status.bestLane.lane, qualifies: status.bestLane.qualifies, observed: status.bestLane.observed }
      : null,
    confidenceTier: status.confidenceTier,
    recommendation: status.decision,
    safety: {
      paperOnly:              true,
      realTradingLocked:      status.safety.realTradingLocked,
      tradingExecuted:        status.safety.tradingExecuted,
      unknownNeverClean:      true,
      doNotEnableRealTrading: true,
      doNotTrade:             true,
    },
    gitCommit: git.commit,
    gitDirty:  git.dirty,
  };
}

/** Append exactly one proof snapshot row. APPEND-ONLY — never rewrites or mutates existing rows. */
export function appendProofLog(proofLogPath: string, row: ProofLogRow): void {
  fs.mkdirSync(path.dirname(proofLogPath), { recursive: true });
  fs.appendFileSync(proofLogPath, JSON.stringify(row) + '\n', 'utf-8');
}

export interface AppendProofSnapshotInput {
  report:               FamilyReportResult;
  cycle:                ProofCycleInfo;
  generatedAt:          string;
  proofLogPath:         string;
  git:                  GitInfo;
  fastTestRunsObserved: number | null;
}

/** Build a proof status from a family report and APPEND exactly one snapshot row. Returns it. */
export function appendProofSnapshot(input: AppendProofSnapshotInput): ProofLogRow {
  const status = buildProofStatus({
    generatedAt: input.generatedAt,
    report: input.report,
    cycle: input.cycle,
    fastTestRunsObserved: input.fastTestRunsObserved,
  });
  const row = buildProofLogRow(status, input.git);
  appendProofLog(input.proofLogPath, row);
  return row;
}

export function readProofLog(proofLogPath: string): ProofLogRow[] {
  if (!fs.existsSync(proofLogPath)) return [];
  return fs.readFileSync(proofLogPath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as ProofLogRow; } catch { return null; } })
    .filter((r): r is ProofLogRow => r != null);
}

/** Best-effort git info; never throws. CLI provides this; tests inject explicit values. */
export function readGitInfo(): GitInfo {
  try {
    // Lazy require to keep the module import-light and side-effect free.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim() || null;
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

// ── Proof summary (trends over time) ──────────────────────────────────────────────────

export type TrendDir = 'UP' | 'DOWN' | 'FLAT';
export type LaneTrendStatus = 'IMPROVING' | 'FLAT' | 'DEGRADING';

export interface MetricTrend { first: number; last: number; direction: TrendDir; }
export interface LaneTrend {
  lane:               LaneKey;
  firstObserved:      number;
  lastObserved:       number;
  observedDirection:  TrendDir;
  cappedAvgDirection: TrendDir;
  status:             LaneTrendStatus;
}

export interface ResearchLaneTrend {
  firstObserved:      number;
  lastObserved:       number;
  observedDirection:  TrendDir;
  cappedAvgDirection: TrendDir;
  status:             LaneTrendStatus;
}

export interface ProofSummary {
  snapshots:              number;
  firstAt:                string | null;
  latestAt:               string | null;
  bestLaneTrend:          { first: string | null; last: string | null; sequence: Array<string | null> };
  laneTrends:             LaneTrend[];
  researchLaneTrend:      ResearchLaneTrend | null;  // NO_BM_RESEARCH (null when no snapshot carries it)
  baselineRedLossTrend:   MetricTrend;
  baselineMedianTrend:    MetricTrend;
  baselineCappedAvgTrend: MetricTrend;
  anyImproving:           boolean;
  anyDegrading:           boolean;
  currentConfidenceTier:  ConfidenceTier | null;
  currentRecommendation:  ProofDecision | null;
  safety: {
    paperOnly:          true;
    realTradingLocked:  true;
    tradingExecuted:    0;
    unknownNeverClean:  true;
    doNotEnableRealTrading: true;
    doNotTrade:         true;
  };
}

function dir(first: number, last: number, eps: number): TrendDir {
  if (last - first > eps) return 'UP';
  if (first - last > eps) return 'DOWN';
  return 'FLAT';
}

export interface ProofSummaryOptions {
  proofLogPath?: string;
  /** Test-only injection. */
  _rows?: ProofLogRow[];
}

export function runProofSummary(opts: ProofSummaryOptions = {}): ProofSummary {
  const proofLogPath = opts.proofLogPath ?? DEFAULT_PROOF_LOG_PATH;
  const rows = opts._rows ?? readProofLog(proofLogPath);

  const safety = {
    paperOnly:              true as const,
    realTradingLocked:      true as const,
    tradingExecuted:        0 as const,
    unknownNeverClean:      true as const,
    doNotEnableRealTrading: true as const,
    doNotTrade:             true as const,
  };

  if (rows.length === 0) {
    const flat: MetricTrend = { first: 0, last: 0, direction: 'FLAT' };
    return {
      snapshots: 0, firstAt: null, latestAt: null,
      bestLaneTrend: { first: null, last: null, sequence: [] },
      laneTrends: ALL_LANES.map(lane => ({
        lane, firstObserved: 0, lastObserved: 0, observedDirection: 'FLAT', cappedAvgDirection: 'FLAT', status: 'FLAT',
      })),
      researchLaneTrend: null,
      baselineRedLossTrend: flat, baselineMedianTrend: flat, baselineCappedAvgTrend: flat,
      anyImproving: false, anyDegrading: false,
      currentConfidenceTier: null, currentRecommendation: null, safety,
    };
  }

  const first = rows[0]!;
  const last  = rows[rows.length - 1]!;

  const laneMetric = (row: ProofLogRow, lane: LaneKey): ProofLaneMetrics | undefined =>
    row.lanes.find(l => l.lane === lane);

  const laneTrends: LaneTrend[] = ALL_LANES.map(lane => {
    const f = laneMetric(first, lane);
    const l = laneMetric(last, lane);
    const firstObserved = f?.observed ?? 0;
    const lastObserved  = l?.observed ?? 0;
    const firstCapped   = f?.avgPnlCapped ?? 0;
    const lastCapped    = l?.avgPnlCapped ?? 0;
    const observedDirection  = dir(firstObserved, lastObserved, 0);
    const cappedAvgDirection = dir(firstCapped, lastCapped, 0.005);
    // IMPROVING when capped avg rose, or evidence grew while capped avg held; DEGRADING when it fell.
    const status: LaneTrendStatus =
      cappedAvgDirection === 'UP'   ? 'IMPROVING' :
      cappedAvgDirection === 'DOWN' ? 'DEGRADING' :
      observedDirection  === 'UP'   ? 'IMPROVING' : 'FLAT';
    return { lane, firstObserved, lastObserved, observedDirection, cappedAvgDirection, status };
  });

  // NO_BM_RESEARCH trend — use the earliest + latest snapshots that actually carry it.
  const researchRows = rows.filter(r => r.researchLane != null);
  let researchLaneTrend: ResearchLaneTrend | null = null;
  if (researchRows.length > 0) {
    const rf = researchRows[0]!.researchLane!;
    const rlst = researchRows[researchRows.length - 1]!.researchLane!;
    const observedDirection  = dir(rf.observed, rlst.observed, 0);
    const cappedAvgDirection = dir(rf.avgPnlCapped, rlst.avgPnlCapped, 0.005);
    const status: LaneTrendStatus =
      cappedAvgDirection === 'UP'   ? 'IMPROVING' :
      cappedAvgDirection === 'DOWN' ? 'DEGRADING' :
      observedDirection  === 'UP'   ? 'IMPROVING' : 'FLAT';
    researchLaneTrend = {
      firstObserved: rf.observed, lastObserved: rlst.observed,
      observedDirection, cappedAvgDirection, status,
    };
  }

  return {
    snapshots: rows.length,
    firstAt:   first.generatedAt ?? null,
    latestAt:  last.generatedAt ?? null,
    bestLaneTrend: {
      first:    first.bestLane?.lane ?? null,
      last:     last.bestLane?.lane ?? null,
      sequence: rows.map(r => r.bestLane?.lane ?? null),
    },
    laneTrends,
    researchLaneTrend,
    baselineRedLossTrend:   { first: first.baseline.redLossRate,  last: last.baseline.redLossRate,  direction: dir(first.baseline.redLossRate,  last.baseline.redLossRate,  0.0001) },
    baselineMedianTrend:    { first: first.baseline.medianPnl,    last: last.baseline.medianPnl,    direction: dir(first.baseline.medianPnl,    last.baseline.medianPnl,    0.005) },
    baselineCappedAvgTrend: { first: first.baseline.avgPnlCapped, last: last.baseline.avgPnlCapped, direction: dir(first.baseline.avgPnlCapped, last.baseline.avgPnlCapped, 0.005) },
    anyImproving: laneTrends.some(t => t.status === 'IMPROVING'),
    anyDegrading: laneTrends.some(t => t.status === 'DEGRADING'),
    currentConfidenceTier: last.confidenceTier ?? null,
    currentRecommendation: last.recommendation ?? null,
    safety,
  };
}

export function renderProofSummary(s: ProofSummary): string {
  const arrow = (d: TrendDir): string => d === 'UP' ? '↑' : d === 'DOWN' ? '↓' : '→';
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — RIPPER PROOF SUMMARY (PAPER ONLY — IS THE APP IMPROVING?)');
  L.push('  [TERMINAL-FIRST PROOF — READ ONLY — UNKNOWN ≠ CLEAN — DO_NOT_TRADE]');
  L.push(SEP, '');
  L.push(`  Proof snapshots : ${s.snapshots}`);
  L.push(`  First snapshot  : ${s.firstAt ?? '(none)'}`);
  L.push(`  Latest snapshot : ${s.latestAt ?? '(none)'}`);
  L.push('');

  if (s.snapshots === 0) {
    L.push('  (no proof snapshots yet — run token:ripper-proof-log or fast-test --append-proof-log)');
    L.push('');
  } else {
    L.push(`  ${SEP2}`);
    L.push('  TRENDS (first → latest)');
    L.push(`  ${SEP2}`);
    L.push(`    Best lane        : ${s.bestLaneTrend.first ?? '(none)'} → ${s.bestLaneTrend.last ?? '(none)'}`);
    for (const t of s.laneTrends) {
      L.push(`    ${t.lane.padEnd(16)} observed ${t.firstObserved} → ${t.lastObserved} ${arrow(t.observedDirection)}  ` +
        `cappedAvg ${arrow(t.cappedAvgDirection)}  [${t.status}]`);
    }
    if (s.researchLaneTrend) {
      const rt = s.researchLaneTrend;
      L.push(`    ${'NO_BM_RESEARCH'.padEnd(16)} observed ${rt.firstObserved} → ${rt.lastObserved} ${arrow(rt.observedDirection)}  ` +
        `cappedAvg ${arrow(rt.cappedAvgDirection)}  [${rt.status}]  (BM ignored for enrollment)`);
    } else {
      L.push(`    ${'NO_BM_RESEARCH'.padEnd(16)} (no snapshot carries research-lane data yet)`);
    }
    L.push(`    Baseline red-loss : ${pctS(s.baselineRedLossTrend.first)} → ${pctS(s.baselineRedLossTrend.last)} ${arrow(s.baselineRedLossTrend.direction)}`);
    L.push(`    Baseline median   : ${pnlS(s.baselineMedianTrend.first)} → ${pnlS(s.baselineMedianTrend.last)} ${arrow(s.baselineMedianTrend.direction)}`);
    L.push(`    Baseline cappedAvg: ${pnlS(s.baselineCappedAvgTrend.first)} → ${pnlS(s.baselineCappedAvgTrend.last)} ${arrow(s.baselineCappedAvgTrend.direction)}`);
    L.push('');
    L.push(`    Any lane improving : ${s.anyImproving ? 'YES' : 'no'}`);
    L.push(`    Any lane degrading : ${s.anyDegrading ? 'YES' : 'no'}`);
    L.push('');
    L.push(`    Current tier       : ${s.currentConfidenceTier ?? 'n/a'}`);
    L.push(`    Current decision   : ${s.currentRecommendation ?? 'n/a'}`);
    L.push('');
  }

  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`);
  L.push('    PAPER_ONLY=true  realTradingLocked=true  tradingExecuted=0  UNKNOWN_NEVER_CLEAN=true');
  L.push('    DO_NOT_ENABLE_REAL_TRADING  DO_NOT_PROMOTE_TO_REAL_TRADING  DO_NOT_TRADE');
  L.push(SEP, '');
  return L.join('\n');
}
