// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_PROMOTE_TO_REAL_TRADING
//
// Ripper Fast Test v1 — a single compact, SAFE orchestrator to collect and read paper-only
// forward cohort evidence faster. It chains existing safe commands:
//   1. dex-day-watch (refresh feed)      — optional (--skip-day-watch)
//   2. ripper learning loop (small N)    — paper-only data collection
//   3. cohort family enroll              — APPEND-ONLY (the only write this command introduces)
//   4. cohort family report              — read-only
//   5. autopilot status                  — read-only
// then prints a compact summary + a conservative best-lane / overall recommendation.
//
// This command NEVER enables real trading, NEVER signs/swaps, NEVER calls the auto-paper or
// paper-buy commands, NEVER loosens gates or changes policy, and NEVER mutates buy/sell intents
// or trades. UNKNOWN cluster risk is never treated as CLEAN. The orchestration is dependency-
// injected so the heavy steps stay in the CLI and the decision logic here is pure + testable.

import { OUTLIER_MAX, type LaneKey, type LaneReport, type LaneOutcomeStats,
  type FamilyReportResult, type FamilyEnrollResult } from './ripperWatchCohortFamily';

// ── Config ────────────────────────────────────────────────────────────────────────────

export const FAST_TEST_DEFAULT_LOOPS            = 3;
export const FAST_TEST_DEFAULT_INTERVAL_MINUTES = 10;
export const FAST_TEST_MIN_FORWARD_N            = 50;

export const ENV_LOOPS_KEY    = 'TOKEN_GRAB_FAST_TEST_LOOPS';
export const ENV_INTERVAL_KEY = 'TOKEN_GRAB_FAST_TEST_INTERVAL_MINUTES';

// The ONLY sub-commands this orchestrator may run. Deliberately excludes any buy/auto command.
export const FAST_TEST_SUBCOMMANDS = {
  dayWatch:     'token:dex-day-watch',
  learningLoop: 'token:ripper-learning-loop',
} as const;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ──────────────────────────────────────────────────────────────────────────────

export type FastTestRecommendation =
  | 'FORWARD_SAMPLE_TOO_SMALL'
  | 'KEEP_COLLECTING'
  | 'PAPER_ONLY_CANDIDATE';

export interface FastTestLaneSummary {
  lane:              LaneKey;
  enrolled:          number;
  observed:          number;
  pending:           number;
  winRate:           number;
  redLossRate:       number;
  flatRate:          number;
  medianPnl:         number;
  avgPnlCapped:      number;
  outlierDependence: number;
  recommendation:    string;
}

export interface BestLaneSelection {
  lane:      LaneKey;
  qualifies: boolean;
  observed:  number;
  reason:    string;
}

export interface FastTestSummary {
  generatedAt: string;
  cycle: {
    id:            string | null;
    time:          string | null;
    fresh:         boolean;
    status:        'FRESH' | 'STALE_OR_CAPTURE_SKIPPED';
  };
  gate: { approved: number; rejected: number };
  baseline: {
    n:                 number;
    winRate:           number;
    redLossRate:       number;
    flatRate:          number;
    medianPnl:         number;
    avgPnlCapped:      number;
    outlierDependence: number;
  };
  enroll: {
    dryRun:  boolean;
    perLane: Array<{ lane: LaneKey; hitsFound: number; rowsAppended: number; duplicatesSkipped: number }>;
  };
  lanes:                FastTestLaneSummary[];
  bestLane:             BestLaneSelection | null;
  overallRecommendation: FastTestRecommendation;
  config:               { loops: number; intervalMinutes: number; minForwardN: number; skipDayWatch: boolean };
  safety: {
    PAPER_ONLY:                true;
    realTradingLocked:         boolean;
    tradingExecuted:           number;
    reportOnly:                true;
    readOnly:                  true;   // read-only except append-only cohort enrollment
    noBuySignal:               true;
    noIntentMutation:          true;
    unknownNeverClean:         true;
    DO_NOT_ENABLE_REAL_TRADING:     true;
    DO_NOT_PROMOTE_TO_REAL_TRADING: true;
  };
}

// ── Best-lane selection (conservative) ──────────────────────────────────────────────────

/**
 * A lane "qualifies" when, relative to baseline, it is not worse on red-loss, strictly better on
 * capped average, has a positive median, and is not outlier-driven. Conservative by design.
 */
export function laneQualifies(stats: LaneOutcomeStats, observed: number, baseline: LaneOutcomeStats): boolean {
  return (
    observed > 0 &&
    stats.redLossRate  <= baseline.redLossRate &&     // red-loss not worse than baseline
    stats.avgPnlCapped >  baseline.avgPnlCapped &&     // capped avg higher than baseline
    stats.medianPnl    >  0 &&                          // median positive
    stats.outlierDependence <= OUTLIER_MAX             // not outlier-driven
  );
}

/**
 * Pick the best current lane by conservative ranking:
 *   1. observed n highest, among lanes that 2-5) beat/meet baseline (redLoss<=, cappedAvg>,
 *      median>0, outlierDep not extreme). If none qualify, the highest-observed lane is shown
 *      but flagged qualifies=false. Returns null when no lane has any observed outcome.
 */
export function selectBestLane(
  lanes: LaneReport[], baseline: LaneOutcomeStats,
): BestLaneSelection | null {
  const withObs = lanes.filter(l => l.observedCount > 0);
  if (withObs.length === 0) return null;

  const qualifying = withObs.filter(l => laneQualifies(l.stats, l.observedCount, baseline));
  const pool = qualifying.length > 0 ? qualifying : withObs;
  const sorted = [...pool].sort(
    (a, b) => b.observedCount - a.observedCount || b.stats.avgPnlCapped - a.stats.avgPnlCapped,
  );
  const top = sorted[0]!;
  return {
    lane:      top.lane,
    qualifies: qualifying.length > 0,
    observed:  top.observedCount,
    reason: qualifying.length > 0
      ? `highest observed n among baseline-beating lanes (n=${top.observedCount}, cappedAvg=${top.stats.avgPnlCapped.toFixed(2)}%)`
      : `highest observed n, but no lane beats baseline yet (n=${top.observedCount})`,
  };
}

// ── Summary builder (pure) ──────────────────────────────────────────────────────────────

export interface BuildFastTestSummaryInput {
  generatedAt:  string;
  cycle:        { id: string | null; time: string | null; fresh: boolean };
  gate:         { approved: number; rejected: number };
  report:       FamilyReportResult;
  enroll:       FamilyEnrollResult | null;
  autopilot:    { realTradingLocked: boolean; tradingExecuted: number };
  loops:        number;
  intervalMinutes: number;
  minForwardN:  number;
  skipDayWatch: boolean;
}

export function buildFastTestSummary(input: BuildFastTestSummaryInput): FastTestSummary {
  const { report } = input;
  const minN = input.minForwardN;

  const lanes: FastTestLaneSummary[] = report.lanes.map(l => ({
    lane:              l.lane,
    enrolled:          l.enrolledCount,
    observed:          l.observedCount,
    pending:           l.pendingCount,
    winRate:           l.stats.winRate,
    redLossRate:       l.stats.redLossRate,
    flatRate:          l.stats.flatRate,
    medianPnl:         l.stats.medianPnl,
    avgPnlCapped:      l.stats.avgPnlCapped,
    outlierDependence: l.stats.outlierDependence,
    recommendation:    l.recommendation,
  }));

  const bestLane = selectBestLane(report.lanes, report.baseline);

  const maxObserved = report.lanes.reduce((m, l) => Math.max(m, l.observedCount), 0);
  const overallRecommendation: FastTestRecommendation =
    maxObserved < minN                                   ? 'FORWARD_SAMPLE_TOO_SMALL' :
    bestLane != null && bestLane.qualifies && bestLane.observed >= minN ? 'PAPER_ONLY_CANDIDATE' :
    'KEEP_COLLECTING';

  return {
    generatedAt: input.generatedAt,
    cycle: {
      id:     input.cycle.id,
      time:   input.cycle.time,
      fresh:  input.cycle.fresh,
      status: input.cycle.fresh ? 'FRESH' : 'STALE_OR_CAPTURE_SKIPPED',
    },
    gate: { approved: input.gate.approved, rejected: input.gate.rejected },
    baseline: {
      n:                 report.baseline.n,
      winRate:           report.baseline.winRate,
      redLossRate:       report.baseline.redLossRate,
      flatRate:          report.baseline.flatRate,
      medianPnl:         report.baseline.medianPnl,
      avgPnlCapped:      report.baseline.avgPnlCapped,
      outlierDependence: report.baseline.outlierDependence,
    },
    enroll: {
      dryRun:  input.enroll?.dryRun ?? false,
      perLane: (input.enroll?.lanes ?? []).map(l => ({
        lane: l.lane, hitsFound: l.hitsFound, rowsAppended: l.rowsAppended, duplicatesSkipped: l.duplicatesSkipped,
      })),
    },
    lanes,
    bestLane,
    overallRecommendation,
    config: {
      loops:          input.loops,
      intervalMinutes: input.intervalMinutes,
      minForwardN:    minN,
      skipDayWatch:   input.skipDayWatch,
    },
    safety: {
      PAPER_ONLY:                true,
      realTradingLocked:         input.autopilot.realTradingLocked,
      tradingExecuted:           input.autopilot.tradingExecuted,
      reportOnly:                true,
      readOnly:                  true,
      noBuySignal:               true,
      noIntentMutation:          true,
      unknownNeverClean:         true,
      DO_NOT_ENABLE_REAL_TRADING:     true,
      DO_NOT_PROMOTE_TO_REAL_TRADING: true,
    },
  };
}

// ── Renderer ────────────────────────────────────────────────────────────────────────────

function pctS(v: number): string { return (v * 100).toFixed(1) + '%'; }
function pnlS(v: number): string { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }

export function renderFastTestSummary(s: FastTestSummary): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — RIPPER FAST TEST (PAPER ONLY — NOT A BUY SIGNAL)');
  L.push('  [PAPER ONLY — READ ONLY EXCEPT APPEND-ONLY COHORT ENROLL — UNKNOWN ≠ CLEAN]');
  L.push(SEP, '');
  L.push(`  Generated at : ${s.generatedAt}`);
  L.push(`  Loops/interval: ${s.config.loops} loop(s) / ${s.config.intervalMinutes} min` +
    `${s.config.skipDayWatch ? '  (day-watch skipped)' : ''}`);
  L.push('');

  // Cycle
  L.push(`  ${SEP2}`);
  L.push('  LATEST CYCLE');
  L.push(`  ${SEP2}`);
  L.push(`    id     : ${s.cycle.id ?? '(none)'}`);
  L.push(`    time   : ${s.cycle.time ?? '(none)'}`);
  L.push(`    status : ${s.cycle.status}${s.cycle.fresh ? '' : '  ← no new capture this run'}`);
  L.push(`    gate   : approved=${s.gate.approved}  rejected=${s.gate.rejected}`);
  L.push('');

  // Enrollment
  if (s.enroll.perLane.length > 0) {
    L.push(`  ${SEP2}`);
    L.push(`  COHORT FAMILY ENROLL${s.enroll.dryRun ? ' (DRY RUN — NO WRITE)' : ' (APPEND-ONLY)'}`);
    L.push(`  ${SEP2}`);
    for (const e of s.enroll.perLane) {
      L.push(`    ${e.lane.padEnd(16)} hits=${e.hitsFound}  appended=${e.rowsAppended}${s.enroll.dryRun ? ' (would)' : ''}  dupSkipped=${e.duplicatesSkipped}`);
    }
    L.push('');
  }

  // Baseline
  const b = s.baseline;
  L.push(`  ${SEP2}`);
  L.push('  BASELINE — OVERALL_APPROVED (observed paper population)');
  L.push(`  ${SEP2}`);
  L.push(`    n=${b.n}  win=${pctS(b.winRate)}  redLoss=${pctS(b.redLossRate)}  flat=${pctS(b.flatRate)}  ` +
    `med=${pnlS(b.medianPnl)}  cappedAvg=${pnlS(b.avgPnlCapped)}  outlierDep=${b.outlierDependence.toFixed(2)}`);
  L.push('');

  // Lanes
  L.push(`  ${SEP2}`);
  L.push('  COHORT LANES');
  L.push(`  ${SEP2}`);
  for (const lane of s.lanes) {
    L.push(`    ${lane.lane}  [${lane.recommendation}]`);
    L.push(`      enrolled=${lane.enrolled}  observed=${lane.observed}  pending=${lane.pending}`);
    L.push(`      win=${pctS(lane.winRate)}  redLoss=${pctS(lane.redLossRate)}  flat=${pctS(lane.flatRate)}  ` +
      `med=${pnlS(lane.medianPnl)}  cappedAvg=${pnlS(lane.avgPnlCapped)}  outlierDep=${lane.outlierDependence.toFixed(2)}`);
  }
  L.push('');

  // Best lane + overall
  L.push(`  ${SEP2}`);
  L.push('  BEST CURRENT LANE (conservative ranking)');
  L.push(`  ${SEP2}`);
  if (s.bestLane) {
    L.push(`    ${s.bestLane.lane}  qualifies=${s.bestLane.qualifies ? 'YES' : 'no'}  observed=${s.bestLane.observed}`);
    L.push(`    ${s.bestLane.reason}`);
  } else {
    L.push('    (no lane has observed outcomes yet)');
  }
  L.push('');
  L.push(`  OVERALL RECOMMENDATION: [${s.overallRecommendation}]`);
  L.push('  A PAPER_ONLY_CANDIDATE is paper-only research evidence — NOT a buy signal.');
  L.push('');

  // Safety footer
  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`);
  L.push(`    PAPER_ONLY=true  realTradingLocked=${s.safety.realTradingLocked}  tradingExecuted=${s.safety.tradingExecuted}`);
  L.push('    reportOnly=true  readOnly=true (except append-only cohort enroll)  noBuySignal=true  noIntentMutation=true');
  L.push('    UNKNOWN_CLUSTER_RISK_IS_NEVER_TREATED_AS_CLEAN=true');
  L.push('    DO_NOT_ENABLE_REAL_TRADING  DO_NOT_PROMOTE_TO_REAL_TRADING');
  L.push('    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push(SEP, '');
  return L.join('\n');
}

// ── Config resolution ───────────────────────────────────────────────────────────────────

/** CLI flag > env override > default. */
export function resolveFastTestConfig(opts: { loops?: number; intervalMinutes?: number }): {
  loops: number; intervalMinutes: number;
} {
  let loops          = FAST_TEST_DEFAULT_LOOPS;
  let intervalMinutes = FAST_TEST_DEFAULT_INTERVAL_MINUTES;

  const envLoops = process.env[ENV_LOOPS_KEY];
  if (envLoops != null && envLoops.trim() !== '') {
    const p = Math.floor(Number(envLoops));
    if (Number.isFinite(p) && p > 0) loops = p;
  }
  const envInterval = process.env[ENV_INTERVAL_KEY];
  if (envInterval != null && envInterval.trim() !== '') {
    const p = Number(envInterval);
    if (Number.isFinite(p) && p > 0) intervalMinutes = p;
  }
  if (opts.loops != null && Number.isFinite(opts.loops) && opts.loops > 0) loops = Math.floor(opts.loops);
  if (opts.intervalMinutes != null && Number.isFinite(opts.intervalMinutes) && opts.intervalMinutes > 0) {
    intervalMinutes = opts.intervalMinutes;
  }
  return { loops, intervalMinutes };
}

// ── Orchestration (dependency-injected; CLI provides real deps) ──────────────────────────

export interface FastTestDeps {
  /** Refresh the feed (dex-day-watch). Skipped when skipDayWatch. May throw → treated as no refresh. */
  refreshFeed:     () => void;
  /** Run the paper-only learning loop with the given loops/interval. May throw → captured. */
  runLearningLoop: (loops: number, intervalMinutes: number) => void;
  /** Read the latest raw cycle id + time (read-only). */
  latestCycle:     () => { id: string | null; time: string | null };
  /** Append-only cohort family enroll (or dry-run). */
  enrollFamily:    (dryRun: boolean) => FamilyEnrollResult;
  /** Read-only cohort family report. */
  familyReport:    () => FamilyReportResult;
  /** Read-only autopilot status fields. */
  autopilotStatus: () => { realTradingLocked: boolean; tradingExecuted: number; approvedCount: number; rejectedCount: number };
}

export interface FastTestOptions {
  loops?:          number;
  intervalMinutes?: number;
  skipDayWatch?:   boolean;
  dryRunEnroll?:   boolean;
  minForwardN?:    number;
  generatedAt?:    string;
}

export function runFastTest(opts: FastTestOptions, deps: FastTestDeps): FastTestSummary {
  const { loops, intervalMinutes } = resolveFastTestConfig(opts);
  const skipDayWatch = opts.skipDayWatch ?? false;
  const dryRunEnroll = opts.dryRunEnroll ?? false;
  const minForwardN  = opts.minForwardN ?? FAST_TEST_MIN_FORWARD_N;

  const before = deps.latestCycle();

  if (!skipDayWatch) {
    try { deps.refreshFeed(); } catch { /* feed refresh failed — continue; freshness reflects reality */ }
  }
  try { deps.runLearningLoop(loops, intervalMinutes); } catch { /* loop step failed — continue safely */ }

  const after = deps.latestCycle();
  const fresh = after.id != null && after.id !== before.id;

  const enroll = deps.enrollFamily(dryRunEnroll);
  const report = deps.familyReport();
  const auto   = deps.autopilotStatus();

  return buildFastTestSummary({
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    cycle:       { id: after.id, time: after.time, fresh },
    gate:        { approved: auto.approvedCount, rejected: auto.rejectedCount },
    report,
    enroll,
    autopilot:   { realTradingLocked: auto.realTradingLocked, tradingExecuted: auto.tradingExecuted },
    loops, intervalMinutes, minForwardN, skipDayWatch,
  });
}
