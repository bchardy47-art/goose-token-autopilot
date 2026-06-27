// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  selectBestLane,
  buildFastTestSummary,
  renderFastTestSummary,
  runFastTest,
  resolveFastTestConfig,
  FAST_TEST_SUBCOMMANDS,
  FAST_TEST_DEFAULT_LOOPS,
  FAST_TEST_DEFAULT_INTERVAL_MINUTES,
  type FastTestDeps,
} from '../src/token-grab/ripperFastTest';
import {
  enrollCohortFamily, runFamilyReport, laneFilePath, LANES,
  type LaneReport, type LaneOutcomeStats, type FamilyReportResult, type FamilyEnrollResult, type LaneKey,
} from '../src/token-grab/ripperWatchCohortFamily';

// ── Factories ──────────────────────────────────────────────────────────────────────

function stats(o: Partial<LaneOutcomeStats> = {}): LaneOutcomeStats {
  return {
    n: 0, winRate: 0, redLossRate: 0, flatRate: 0, avgPnlRaw: 0, avgPnlCapped: 0,
    medianPnl: 0, worstPnl: 0, bestPnl: 0, outlierDependence: 0,
    clusterBreakdown: {}, m5BandBreakdown: {}, ...o,
  };
}
function lane(key: LaneKey, o: { enrolled?: number; observed?: number; pending?: number; recommendation?: string; stats?: Partial<LaneOutcomeStats> } = {}): LaneReport {
  return {
    lane: key, cohortName: key, cohortPath: '', describe: '',
    enrolledCount: o.enrolled ?? 0, observedCount: o.observed ?? 0,
    pendingCount: o.pending ?? 0, unmatchedCount: 0,
    stats: stats({ n: o.observed ?? 0, ...o.stats }),
    recommendation: (o.recommendation as any) ?? 'FORWARD_SAMPLE_TOO_SMALL', recommendationReason: '',
  };
}
function report(lanes: LaneReport[], baseline: Partial<LaneOutcomeStats> = {}): FamilyReportResult {
  const keys = lanes.map(l => l.lane);
  return {
    generatedAt: 't', dataDir: 'd', baseline: stats(baseline), lanes,
    ranking: { byObservedN: keys, byWinRate: keys, byMedian: keys, byCappedAvg: keys, byRedLossAsc: keys, byOutlierDepAsc: keys },
    familyRecommendation: 'FORWARD_SAMPLE_TOO_SMALL',
    config: { minForwardN: 50, pnlCapPct: 500 }, safetyLabel: 'PAPER_ONLY_WATCH_NOT_BUY',
    reportOnly: true, readOnly: true, paperOnly: true, realTradingLocked: true, tradingExecuted: 0,
    noGateChanges: true, noBuySignal: true, noPaperIntentMutation: true, unknownNeverClean: true,
  };
}
function enroll(o: { dryRun?: boolean; lanes?: FamilyEnrollResult['lanes'] } = {}): FamilyEnrollResult {
  return {
    generatedAt: 't', dataDir: 'd', cyclesDir: 'c', cycleFile: 'f.jsonl', cycleId: 'f',
    rowsScanned: 0, dryRun: o.dryRun ?? false, lanes: o.lanes ?? [], safetyLabel: 'PAPER_ONLY_WATCH_NOT_BUY',
    reportOnly: true, paperOnly: true, realTradingLocked: true, tradingExecuted: 0,
    noGateChanges: true, noBuySignal: true, unknownNeverClean: true,
  };
}
const ALL_LANES: LaneKey[] = ['EXACT_WATCH', 'LIQUIDITY_NEAR', 'MOMENTUM_FAMILY', 'WAIT10_QUALITY'];
function allZeroLanes(): LaneReport[] { return ALL_LANES.map(k => lane(k)); }

// ── selectBestLane ──────────────────────────────────────────────────────────────────

describe('selectBestLane', () => {
  const weakBaseline = stats({ n: 1000, winRate: 0.4, redLossRate: 0.10, avgPnlCapped: 0, medianPnl: 0, outlierDependence: 0.05 });

  it('returns null when no lane has observed outcomes (n=0)', () => {
    expect(selectBestLane(allZeroLanes(), weakBaseline)).toBeNull();
  });

  it('prefers MOMENTUM_FAMILY when it has higher observed n and acceptable metrics', () => {
    const good = { redLossRate: 0.05, avgPnlCapped: 3, medianPnl: 2, outlierDependence: 0.10 };
    const lanes = [
      lane('EXACT_WATCH',     { observed: 30, stats: good }),
      lane('LIQUIDITY_NEAR',  { observed: 20, stats: good }),
      lane('MOMENTUM_FAMILY', { observed: 60, stats: good }),  // highest n + qualifies
      lane('WAIT10_QUALITY',  { observed: 0 }),
    ];
    const best = selectBestLane(lanes, weakBaseline);
    expect(best).not.toBeNull();
    expect(best!.lane).toBe('MOMENTUM_FAMILY');
    expect(best!.qualifies).toBe(true);
    expect(best!.observed).toBe(60);
  });

  it('flags qualifies=false when the highest-observed lane does not beat baseline', () => {
    // cappedAvg not above baseline → not qualifying.
    const lanes = [lane('MOMENTUM_FAMILY', { observed: 80, stats: { avgPnlCapped: 0, medianPnl: 0, redLossRate: 0.2 } })];
    const best = selectBestLane(lanes, weakBaseline);
    expect(best!.lane).toBe('MOMENTUM_FAMILY');
    expect(best!.qualifies).toBe(false);
  });
});

// ── buildFastTestSummary ────────────────────────────────────────────────────────────

describe('buildFastTestSummary', () => {
  const baseInput = (over: any = {}) => ({
    generatedAt: '2026-06-26T00:00:00.000Z',
    cycle: { id: 'cycle-2026-06-26-000000', time: '2026-06-26T00:00:00Z', fresh: true },
    gate: { approved: 5, rejected: 7 },
    report: report(allZeroLanes()),
    enroll: enroll(),
    autopilot: { realTradingLocked: true, tradingExecuted: 0 },
    loops: 1, intervalMinutes: 10, minForwardN: 50, skipDayWatch: false,
    ...over,
  });

  it('overall FORWARD_SAMPLE_TOO_SMALL when best observed n < 50', () => {
    const s = buildFastTestSummary(baseInput({ report: report([lane('EXACT_WATCH', { observed: 30 })]) }));
    expect(s.overallRecommendation).toBe('FORWARD_SAMPLE_TOO_SMALL');
  });

  it('overall PAPER_ONLY_CANDIDATE when a qualifying lane has n>=50', () => {
    const weakBaseline = { n: 1000, winRate: 0.4, redLossRate: 0.10, avgPnlCapped: 0, medianPnl: 0, outlierDependence: 0.05 };
    const lanes = [lane('MOMENTUM_FAMILY', { observed: 60, stats: { redLossRate: 0.05, avgPnlCapped: 3, medianPnl: 2, outlierDependence: 0.1 } })];
    const s = buildFastTestSummary(baseInput({ report: report(lanes, weakBaseline) }));
    expect(s.overallRecommendation).toBe('PAPER_ONLY_CANDIDATE');
    expect(s.bestLane!.lane).toBe('MOMENTUM_FAMILY');
  });

  it('overall KEEP_COLLECTING when n>=50 but no lane beats baseline', () => {
    const weakBaseline = { n: 1000, winRate: 0.4, redLossRate: 0.10, avgPnlCapped: 1, medianPnl: 0, outlierDependence: 0.05 };
    const lanes = [lane('MOMENTUM_FAMILY', { observed: 60, stats: { redLossRate: 0.2, avgPnlCapped: 0, medianPnl: 0, outlierDependence: 0.1 } })];
    const s = buildFastTestSummary(baseInput({ report: report(lanes, weakBaseline) }));
    expect(s.overallRecommendation).toBe('KEEP_COLLECTING');
  });

  it('reports stale/capture-skipped clearly when cycle not fresh', () => {
    const s = buildFastTestSummary(baseInput({ cycle: { id: 'cycle-x', time: null, fresh: false } }));
    expect(s.cycle.fresh).toBe(false);
    expect(s.cycle.status).toBe('STALE_OR_CAPTURE_SKIPPED');
    expect(renderFastTestSummary(s)).toContain('STALE_OR_CAPTURE_SKIPPED');
  });

  it('includes realTradingLocked and tradingExecuted in the safety block', () => {
    const s = buildFastTestSummary(baseInput());
    expect(s.safety.realTradingLocked).toBe(true);
    expect(s.safety.tradingExecuted).toBe(0);
    expect(s.safety.PAPER_ONLY).toBe(true);
    expect(s.safety.noIntentMutation).toBe(true);
    expect(s.safety.unknownNeverClean).toBe(true);
  });

  it('is JSON-serialisable and structured', () => {
    const parsed = JSON.parse(JSON.stringify(buildFastTestSummary(baseInput())));
    expect(parsed.overallRecommendation).toBeDefined();
    expect(parsed.baseline).toBeDefined();
    expect(Array.isArray(parsed.lanes)).toBe(true);
    expect(parsed.safety.realTradingLocked).toBe(true);
  });
});

// ── Renderer safety footer ──────────────────────────────────────────────────────────

describe('renderFastTestSummary safety footer', () => {
  function txt() {
    return renderFastTestSummary(buildFastTestSummary({
      generatedAt: 't', cycle: { id: 'c', time: 't', fresh: true }, gate: { approved: 0, rejected: 0 },
      report: report(allZeroLanes()), enroll: enroll(), autopilot: { realTradingLocked: true, tradingExecuted: 0 },
      loops: 1, intervalMinutes: 10, minForwardN: 50, skipDayWatch: false,
    }));
  }
  it('prints the PAPER_ONLY safety footer with locks', () => {
    const t = txt();
    expect(t).toContain('PAPER_ONLY=true');
    expect(t).toContain('realTradingLocked=true');
    expect(t).toContain('tradingExecuted=0');
    expect(t).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(t).toContain('DO_NOT_PROMOTE_TO_REAL_TRADING');
  });
  it('uses only DO_NOT_ forms of real-trading language', () => {
    const t = txt();
    expect(t).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    expect(t).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
  });
});

// ── Never calls auto-paper / paper-buy (static source guard) ──────────────────────────

describe('fast-test never calls forbidden commands', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/ripperFastTest.ts'), 'utf-8');

  it('module source never references token:auto-paper', () => {
    expect(src).not.toContain('token:auto-paper');
  });
  it('module source never references token:paper-buy', () => {
    expect(src).not.toContain('token:paper-buy');
  });
  it('FAST_TEST_SUBCOMMANDS only lists safe day-watch + learning-loop', () => {
    const values = Object.values(FAST_TEST_SUBCOMMANDS);
    expect(values).toEqual(['token:dex-day-watch', 'token:ripper-learning-loop']);
    expect(values).not.toContain('token:auto-paper');
    expect(values).not.toContain('token:paper-buy');
  });
});

// ── resolveFastTestConfig ───────────────────────────────────────────────────────────

describe('resolveFastTestConfig', () => {
  afterEach(() => {
    delete process.env['TOKEN_GRAB_FAST_TEST_LOOPS'];
    delete process.env['TOKEN_GRAB_FAST_TEST_INTERVAL_MINUTES'];
  });

  it('defaults to 3 loops / 10 minutes', () => {
    const c = resolveFastTestConfig({});
    expect(c.loops).toBe(FAST_TEST_DEFAULT_LOOPS);
    expect(c.intervalMinutes).toBe(FAST_TEST_DEFAULT_INTERVAL_MINUTES);
  });
  it('env overrides defaults', () => {
    process.env['TOKEN_GRAB_FAST_TEST_LOOPS'] = '5';
    process.env['TOKEN_GRAB_FAST_TEST_INTERVAL_MINUTES'] = '2';
    expect(resolveFastTestConfig({})).toEqual({ loops: 5, intervalMinutes: 2 });
  });
  it('CLI flags override env', () => {
    process.env['TOKEN_GRAB_FAST_TEST_LOOPS'] = '5';
    expect(resolveFastTestConfig({ loops: 1, intervalMinutes: 4 })).toEqual({ loops: 1, intervalMinutes: 4 });
  });
});

// ── runFastTest orchestration (injected deps) ─────────────────────────────────────────

describe('runFastTest orchestration', () => {
  function makeDeps(over: Partial<FastTestDeps> = {}): { deps: FastTestDeps; calls: Record<string, number>; enrolledDryRun: boolean[] } {
    const calls: Record<string, number> = { refreshFeed: 0, runLearningLoop: 0, enrollFamily: 0, familyReport: 0, autopilotStatus: 0 };
    const enrolledDryRun: boolean[] = [];
    const deps: FastTestDeps = {
      refreshFeed: () => { calls.refreshFeed++; },
      runLearningLoop: () => { calls.runLearningLoop++; },
      latestCycle: () => ({ id: 'cycle-2026-06-26-010000', time: '2026-06-26T01:00:00Z' }),
      enrollFamily: (dryRun) => { calls.enrollFamily++; enrolledDryRun.push(dryRun); return enroll({ dryRun }); },
      familyReport: () => { calls.familyReport++; return report(allZeroLanes()); },
      autopilotStatus: () => { calls.autopilotStatus++; return { realTradingLocked: true, tradingExecuted: 0, approvedCount: 3, rejectedCount: 4 }; },
      ...over,
    };
    return { deps, calls, enrolledDryRun };
  }

  it('runs all steps and returns a structured summary', () => {
    const { deps, calls } = makeDeps();
    const s = runFastTest({ loops: 1 }, deps);
    expect(calls.refreshFeed).toBe(1);
    expect(calls.runLearningLoop).toBe(1);
    expect(calls.enrollFamily).toBe(1);
    expect(calls.familyReport).toBe(1);
    expect(calls.autopilotStatus).toBe(1);
    expect(s.gate).toEqual({ approved: 3, rejected: 4 });
    expect(s.safety.realTradingLocked).toBe(true);
  });

  it('--skip-day-watch does not refresh the feed', () => {
    const { deps, calls } = makeDeps();
    runFastTest({ loops: 1, skipDayWatch: true }, deps);
    expect(calls.refreshFeed).toBe(0);
    expect(calls.runLearningLoop).toBe(1);
  });

  it('--dry-run-enroll passes dryRun=true to enrollment', () => {
    const { deps, enrolledDryRun } = makeDeps();
    const s = runFastTest({ loops: 1, dryRunEnroll: true }, deps);
    expect(enrolledDryRun).toEqual([true]);
    expect(s.enroll.dryRun).toBe(true);
  });

  it('reports STALE_OR_CAPTURE_SKIPPED when the latest cycle does not advance', () => {
    const { deps } = makeDeps({ latestCycle: () => ({ id: 'cycle-same', time: null }) });
    const s = runFastTest({ loops: 1 }, deps);
    expect(s.cycle.fresh).toBe(false);
    expect(s.cycle.status).toBe('STALE_OR_CAPTURE_SKIPPED');
  });

  it('reports FRESH when a new cycle appears between before/after', () => {
    let n = 0;
    const { deps } = makeDeps({ latestCycle: () => (n++ === 0 ? { id: 'old', time: null } : { id: 'new', time: '2026-06-26T02:00:00Z' }) });
    const s = runFastTest({ loops: 1 }, deps);
    expect(s.cycle.fresh).toBe(true);
    expect(s.cycle.status).toBe('FRESH');
  });
});

// ── dry-run-enroll writes nothing (real append-only path through runFastTest) ──────────

describe('dry-run-enroll writes nothing (real enrollment)', () => {
  let dir: string, cyclesDir: string, dataDir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-'));
    cyclesDir = path.join(dir, 'cycles'); dataDir = path.join(dir, 'data');
    fs.mkdirSync(cyclesDir); fs.mkdirSync(dataDir);
    // One approved EXACT-matching cycle row so enrollment would have hits.
    fs.writeFileSync(path.join(cyclesDir, 'cycle-2026-06-26-020000.jsonl'),
      JSON.stringify({
        capturedAt: '2026-06-26T02:00:00.000Z', buyGateDecision: 'BUY_APPROVED_PAPER',
        entryDecision: 'READY_TO_SNIPE_PAPER', entryMomentumPct: -10, ripperScore: 90,
        launchAgeBucket: 'PRIME_WINDOW',
        normalizedSignal: { contract: 'K1', symbol: 'S1', liquidityUsd: 20000, volumeLiquidityRatio: 1 },
        ripperInput: { contract: 'K1', clusterRisk: 'UNKNOWN' },
      }) + '\n', 'utf-8');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes no lane files when dryRunEnroll=true, but would have hits', () => {
    const s = runFastTest({ loops: 1, skipDayWatch: true, dryRunEnroll: true }, {
      refreshFeed: () => {},
      runLearningLoop: () => {},
      latestCycle: () => ({ id: 'cycle-2026-06-26-020000', time: '2026-06-26T02:00:00Z' }),
      enrollFamily: (dryRun) => enrollCohortFamily({ cyclesDir, dataDir, dryRun }),
      familyReport: () => runFamilyReport({ dataDir, _trades: [] }),
      autopilotStatus: () => ({ realTradingLocked: true, tradingExecuted: 0, approvedCount: 1, rejectedCount: 0 }),
    });
    // Dry-run reported would-append hits but wrote NOTHING.
    expect(s.enroll.dryRun).toBe(true);
    const exact = s.enroll.perLane.find(l => l.lane === 'EXACT_WATCH')!;
    expect(exact.rowsAppended).toBe(1);
    for (const def of LANES) expect(fs.existsSync(laneFilePath(dataDir, def.key))).toBe(false);
  });
});
