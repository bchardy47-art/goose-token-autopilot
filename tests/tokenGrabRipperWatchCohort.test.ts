// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  enrollWatchCohort,
  renderWatchCohortEnroll,
  runWatchCohortReport,
  renderWatchCohortReport,
  buildDedupeKey,
  COHORT_NAME,
  type WatchCohortRow,
} from '../src/token-grab/ripperWatchCohort';
import {
  runRipperLearningLoop,
  renderRipperLearningLoopSummary,
} from '../src/token-grab/ripperLearningLoop';
import type { SimulatedTrade } from '../src/token-grab/ripperPaperTradeSimulationReport';

// ── Fixtures ──────────────────────────────────────────────────────────────────────

let tmpDir: string, cyclesDir: string, cohortPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohort-'));
  cyclesDir = path.join(tmpDir, 'cycles');
  cohortPath = path.join(tmpDir, 'watch-cohort.jsonl');
  fs.mkdirSync(cyclesDir);
});
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

let cc = 0;
/** A raw cycle row. Defaults => an APPROVED watch hit (ENTER_NOW | -20 to -5 | LIQ_10K_30K). */
function cycleRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  cc++;
  const o = over as Record<string, any>;
  return {
    capturedAt:       o.capturedAt ?? '2026-06-25T22:00:00.000Z',
    buyGateDecision:  o.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    entryDecision:    o.entryDecision ?? 'READY_TO_SNIPE_PAPER',
    entryMomentumPct: o.entryMomentumPct ?? -10,          // → m5Band -20 to -5
    ripperScore:      o.ripperScore ?? 90,
    launchAgeBucket:  o.launchAgeBucket ?? 'PRIME_WINDOW',
    normalizedSignal: {
      contract:             o.contract ?? `K${cc}`,
      symbol:               o.symbol ?? `S${cc}`,
      liquidityUsd:         o.liquidityUsd ?? 20_000,     // → LIQ_10K_30K
      volumeLiquidityRatio: o.vlr ?? 1.0,                 // → VLR_0_5_TO_2
    },
    ripperInput: { contract: o.contract ?? `K${cc}`, clusterRisk: o.clusterRisk ?? 'UNKNOWN' },
  };
}

function writeCycle(name: string, rows: Record<string, unknown>[]): string {
  const file = path.join(cyclesDir, name);
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return file;
}

function readCohort(): WatchCohortRow[] {
  if (!fs.existsSync(cohortPath)) return [];
  return fs.readFileSync(cohortPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as WatchCohortRow);
}

// ── Enrollment matching ─────────────────────────────────────────────────────────

describe('enrollment matching', () => {
  it('enrolls a matching latest-cycle row', () => {
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ contract: 'HIT1', symbol: 'AAA' })]);
    const r = enrollWatchCohort({ cyclesDir, cohortPath });
    expect(r.hitsFound).toBe(1);
    expect(r.rowsAppended).toBe(1);
    const rows = readCohort();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contract).toBe('HIT1');
    expect(rows[0]!.cohortName).toBe(COHORT_NAME);
    expect(rows[0]!.label).toBe('SUBGROUP_WATCH_PAPER_ONLY');
    expect(rows[0]!.paperEntryTiming).toBe('ENTER_NOW');
    expect(rows[0]!.m5Band).toBe('-20 to -5');
    expect(rows[0]!.liquidityBucket).toBe('LIQ_10K_30K');
  });

  it('does NOT enroll a non-matching M5 band', () => {
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ entryMomentumPct: 0 })]); // → -5 to +5
    const r = enrollWatchCohort({ cyclesDir, cohortPath });
    expect(r.hitsFound).toBe(0);
    expect(r.rowsAppended).toBe(0);
  });

  it('does NOT enroll a non-matching liquidity bucket', () => {
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ liquidityUsd: 50_000 })]); // → LIQ_30K_100K
    const r = enrollWatchCohort({ cyclesDir, cohortPath });
    expect(r.hitsFound).toBe(0);
  });

  it('does NOT enroll a non-ENTER_NOW (high-quality WAIT_10M) row', () => {
    // CLEAN + score>=100 + PRIME_WINDOW + READY_TO_SNIPE_PAPER → WAIT_10M timing.
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ clusterRisk: 'CLEAN', ripperScore: 100 })]);
    const r = enrollWatchCohort({ cyclesDir, cohortPath });
    expect(r.hitsFound).toBe(0); // WAIT_10M is not ENTER_NOW → not a hit
  });

  it('does NOT enroll a non-approved (rejected) row', () => {
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ buyGateDecision: 'BUY_REJECTED', entryDecision: 'PAPER_BUY_BLOCKED' })]);
    const r = enrollWatchCohort({ cyclesDir, cohortPath });
    expect(r.hitsFound).toBe(0); // no paper timing for rejected → not ENTER_NOW
  });

  it('preserves UNKNOWN cluster as UNKNOWN, never CLEAN', () => {
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ contract: 'U1', clusterRisk: 'UNKNOWN' })]);
    enrollWatchCohort({ cyclesDir, cohortPath });
    const rows = readCohort();
    expect(rows[0]!.clusterRisk).toBe('UNKNOWN');
    expect(rows[0]!.clusterRisk).not.toBe('CLEAN');
  });
});

// ── Append-only / dedupe ──────────────────────────────────────────────────────────

describe('append-only and dedupe', () => {
  it('is append-only: existing rows are not modified across enrollments', () => {
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ contract: 'A1' })]);
    enrollWatchCohort({ cyclesDir, cohortPath });
    const firstRowJson = fs.readFileSync(cohortPath, 'utf-8').split('\n').filter(Boolean)[0];

    writeCycle('cycle-2026-06-25-230000.jsonl', [cycleRow({ contract: 'B1', capturedAt: '2026-06-25T23:00:00.000Z' })]);
    const r2 = enrollWatchCohort({ cyclesDir, cohortPath });

    expect(r2.rowsAppended).toBe(1);
    const rows = readCohort();
    expect(rows).toHaveLength(2);
    // First row byte-identical (not rewritten/backfilled).
    expect(fs.readFileSync(cohortPath, 'utf-8').split('\n').filter(Boolean)[0]).toBe(firstRowJson);
    expect(rows.map(r => r.contract)).toEqual(['A1', 'B1']);
  });

  it('re-running enrollment on the same cycle appends 0 and reports duplicates skipped', () => {
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ contract: 'DUP1' }), cycleRow({ contract: 'DUP2' })]);
    const r1 = enrollWatchCohort({ cyclesDir, cohortPath });
    expect(r1.rowsAppended).toBe(2);

    const r2 = enrollWatchCohort({ cyclesDir, cohortPath });
    expect(r2.rowsAppended).toBe(0);
    expect(r2.duplicatesSkipped).toBe(2);
    expect(readCohort()).toHaveLength(2);
  });

  it('dedupeKey uses cycleId+contract+capturedAt, falling back to file+contract', () => {
    expect(buildDedupeKey('cycle-x', 'C1', '2026-06-25T22:00:00.000Z', 'cycle-x.jsonl'))
      .toBe('cycle-x::C1::2026-06-25T22:00:00.000Z');
    expect(buildDedupeKey('cycle-x', 'C1', null, '/a/b/cycle-x.jsonl'))
      .toBe('cycle-x.jsonl::C1');
  });

  it('dry-run writes nothing but reports what would be appended', () => {
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ contract: 'DRY1' })]);
    const r = enrollWatchCohort({ cyclesDir, cohortPath, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.rowsAppended).toBe(1);          // would append
    expect(fs.existsSync(cohortPath)).toBe(false); // but wrote nothing
  });
});

// ── Cohort row shape (entry-time only) ────────────────────────────────────────────

describe('cohort row contains entry-time fields only', () => {
  it('has no P/L or outcome fields', () => {
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ contract: 'X1' })]);
    enrollWatchCohort({ cyclesDir, cohortPath });
    const row = readCohort()[0]!;
    const keys = Object.keys(row);
    for (const forbidden of ['simulatedPnlPct', 'priceChangePct', 'pnl', 'winner', 'outcome', 'observedAt', 'win']) {
      expect(keys).not.toContain(forbidden);
    }
    // sanity: it does carry entry-time fields
    expect(keys).toContain('entryMomentumPct');
    expect(keys).toContain('m5Band');
    expect(keys).toContain('liquidityBucket');
  });
});

// ── Report: outcome matching ──────────────────────────────────────────────────────

let tc = 0;
function mkTrade(over: Partial<SimulatedTrade> = {}): SimulatedTrade {
  tc++;
  return {
    intentId: `it${tc}`, symbol: `S${tc}`, contract: `T${tc}`,
    paperEntryTiming: 'ENTER_NOW', reason: '', sourceCycle: 'cycle-x',
    clusterRisk: 'UNKNOWN', ripperScore: 100, launchAgeBucket: 'PRIME_WINDOW',
    entryDecision: 'READY_TO_SNIPE_PAPER', targetEntryAt: '2026-06-15T00:00:00.000Z',
    observedAt: '2026-06-15T00:10:00.000Z', priceChangePct: 0, simulatedPnlPct: 0,
    entryMomentumPct: -10, entryMomentumSource: 'DEX_SCREENER_M5', entryMomentumWindowLabel: 'M5',
    liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2', timingPath: 'ENTER_NOW',
    m5Band: '-20 to -5', ...over,
  };
}

function mkCohort(over: Partial<WatchCohortRow> = {}): WatchCohortRow {
  return {
    schemaVersion: 1, cohortName: COHORT_NAME, label: 'SUBGROUP_WATCH_PAPER_ONLY',
    enrolledAt: '2026-06-10T00:00:00.000Z', cycleId: 'cycle-x', cycleFile: 'cycle-x.jsonl',
    capturedAt: '2026-06-10T00:00:00.000Z', dedupeKey: 'k', contract: 'C', symbol: 'S',
    buyGateDecision: 'BUY_APPROVED_PAPER', paperEntryTiming: 'ENTER_NOW', entryMomentumPct: -10,
    m5Band: '-20 to -5', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2',
    clusterRisk: 'UNKNOWN', ripperScore: 100, reason: 'r', safety: 'PAPER_ONLY_WATCH_NOT_BUY',
    DO_NOT_ENABLE_REAL_TRADING: true, DO_NOT_PROMOTE_TO_REAL_TRADING: true,
    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE: true, ...over,
  };
}

describe('report outcome matching', () => {
  it('marks a cohort row PENDING when no outcome exists', () => {
    const r = runWatchCohortReport({
      _cohortRows: [mkCohort({ contract: 'NOPE', dedupeKey: 'k1' })],
      _trades: [],
    });
    expect(r.pendingCount).toBe(1);
    expect(r.observedCount).toBe(0);
    expect(r.pendingRows[0]!.contract).toBe('NOPE');
  });

  it('matches an unambiguous observed outcome', () => {
    const r = runWatchCohortReport({
      _cohortRows: [mkCohort({ contract: 'OBS', dedupeKey: 'k1' })],
      _trades: [mkTrade({ contract: 'OBS', simulatedPnlPct: 7 })],
    });
    expect(r.observedCount).toBe(1);
    expect(r.watchCohortObserved.n).toBe(1);
    expect(r.watchCohortObserved.bestPnl).toBe(7);
  });

  it('marks ambiguous outcome as OUTCOME_UNMATCHED (not guessed)', () => {
    // Two observed trades for the same contract with identical timestamps → tie → unmatched.
    const r = runWatchCohortReport({
      _cohortRows: [mkCohort({ contract: 'AMB', dedupeKey: 'k1' })],
      _trades: [
        mkTrade({ contract: 'AMB', simulatedPnlPct: 5, targetEntryAt: '2026-06-15T00:00:00.000Z' }),
        mkTrade({ contract: 'AMB', simulatedPnlPct: -5, targetEntryAt: '2026-06-15T00:00:00.000Z' }),
      ],
    });
    expect(r.unmatchedCount).toBe(1);
    expect(r.observedCount).toBe(0);
    expect(r.unmatchedRows[0]!.contract).toBe('AMB');
  });

  it('UNKNOWN cluster stays UNKNOWN, never CLEAN, in cohort outcome breakdown', () => {
    const trades = Array.from({ length: 3 }, (_, i) => mkTrade({ contract: `W${i}`, simulatedPnlPct: 5 }));
    const cohort = trades.map((t, i) => mkCohort({ contract: `W${i}`, dedupeKey: `k${i}`, clusterRisk: 'UNKNOWN' }));
    const r = runWatchCohortReport({ _cohortRows: cohort, _trades: trades });
    expect(r.watchCohortObserved.clusterBreakdown['UNKNOWN']).toBe(3);
    expect(r.watchCohortObserved.clusterBreakdown['CLEAN']).toBeUndefined();
    expect(r.unknownNeverClean).toBe(true);
  });
});

// ── Report: recommendation ────────────────────────────────────────────────────────

describe('report recommendation', () => {
  // Build a watch cohort of `pnls` (each a unique contract w/ matching observed trade),
  // plus a set of non-watch in-window trades.
  function build(watchPnls: number[], nonWatchPnls: number[]): { cohort: WatchCohortRow[]; trades: SimulatedTrade[] } {
    const cohort: WatchCohortRow[] = [];
    const trades: SimulatedTrade[] = [];
    watchPnls.forEach((p, i) => {
      cohort.push(mkCohort({ contract: `W${i}`, dedupeKey: `wk${i}` }));
      trades.push(mkTrade({ contract: `W${i}`, simulatedPnlPct: p }));
    });
    nonWatchPnls.forEach((p, i) => {
      trades.push(mkTrade({ contract: `N${i}`, simulatedPnlPct: p, m5Band: '-5 to +5', entryMomentumPct: 0 }));
    });
    return { cohort, trades };
  }

  it('returns FORWARD_SAMPLE_TOO_SMALL when observed watch n < 50', () => {
    const { cohort, trades } = build(new Array(30).fill(8), new Array(40).fill(1));
    const r = runWatchCohortReport({ _cohortRows: cohort, _trades: trades });
    expect(r.observedCount).toBe(30);
    expect(r.recommendation).toBe('FORWARD_SAMPLE_TOO_SMALL');
  });

  it('returns FORWARD_WATCH_OUTPERFORMING_PAPER_ONLY for a strong, stable cohort', () => {
    const { cohort, trades } = build(
      [...new Array(50).fill(8), ...new Array(10).fill(-3)],     // watch: win 83%, med +8
      [...new Array(40).fill(3), ...new Array(60).fill(-2)],     // non-watch: win 40%, med -2, cap avg 0
    );
    const r = runWatchCohortReport({ _cohortRows: cohort, _trades: trades });
    expect(r.observedCount).toBe(60);
    expect(r.comparison.winRateLiftPp).toBeGreaterThanOrEqual(10);
    expect(r.watchCohortObserved.outlierDependence).toBeLessThanOrEqual(0.25);
    expect(r.recommendation).toBe('FORWARD_WATCH_OUTPERFORMING_PAPER_ONLY');
  });

  it('returns FORWARD_WATCH_NOT_OUTPERFORMING when cohort underperforms', () => {
    const { cohort, trades } = build(
      [...new Array(20).fill(2), ...new Array(40).fill(-3)],     // watch: win 33%, med -3
      [...new Array(40).fill(5), ...new Array(20).fill(-2)],     // non-watch: win 66%, med +5
    );
    const r = runWatchCohortReport({ _cohortRows: cohort, _trades: trades });
    expect(r.observedCount).toBe(60);
    expect(r.recommendation).toBe('FORWARD_WATCH_NOT_OUTPERFORMING');
  });
});

// ── Learning loop integration ─────────────────────────────────────────────────────

describe('learning loop integration', () => {
  it('summary includes cohort appended/skipped counts; trading stays locked', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      runPaperCycle: async () => ({ approved: 3, rejected: 5, bmLiveCalls: null, bmCacheHits: null, bmSkipped: null }),
      runSubgroupWatch: () => ({ hitCount: 4 }),
      runWatchCohortEnroll: () => ({ rowsAppended: 2, duplicatesSkipped: 1 }),
      _sleep: async () => {},
    });
    expect(result.summaries[0]!.watchCohortRowsAppended).toBe(2);
    expect(result.summaries[0]!.watchCohortDuplicatesSkipped).toBe(1);
    // Gate counts unaffected.
    expect(result.summaries[0]!.approved).toBe(3);
    expect(result.summaries[0]!.rejected).toBe(5);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);

    const txt = renderRipperLearningLoopSummary(result.summaries[0]!);
    expect(txt).toContain('Watch cohort   : +2 enrolled, 1 dup skipped');
    expect(txt).toContain('PAPER_ONLY_WATCH_NOT_BUY');
  });

  it('a failing cohort step is recorded as failed, not a trade', async () => {
    const result = await runRipperLearningLoop({
      maxLoops: 1,
      runPaperCycle: async () => ({ approved: 1, rejected: 1, bmLiveCalls: null, bmCacheHits: null, bmSkipped: null }),
      runWatchCohortEnroll: () => { throw new Error('cohort boom'); },
      _sleep: async () => {},
    });
    expect(result.summaries[0]!.failedStep).toBe('watch-cohort-enroll');
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
  });
});

// ── Safety strings ─────────────────────────────────────────────────────────────────

describe('safety output', () => {
  it('enrollment render includes all safety strings and only DO_NOT_ real-trading forms', () => {
    writeCycle('cycle-2026-06-25-220000.jsonl', [cycleRow({ contract: 'S1' })]);
    const txt = renderWatchCohortEnroll(enrollWatchCohort({ cyclesDir, cohortPath, dryRun: true }));
    expect(txt).toContain('PAPER_ONLY_WATCH_NOT_BUY');
    expect(txt).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(txt).toContain('DO_NOT_PROMOTE_TO_REAL_TRADING');
    expect(txt).toContain('DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    expect(txt).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
  });

  it('report render includes all safety strings and only DO_NOT_ real-trading forms', () => {
    const txt = renderWatchCohortReport(runWatchCohortReport({ _cohortRows: [mkCohort()], _trades: [] }));
    expect(txt).toContain('PAPER_ONLY_WATCH_NOT_BUY');
    expect(txt).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(txt).toContain('DO_NOT_PROMOTE_TO_REAL_TRADING');
    expect(txt).toContain('DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    expect(txt).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
  });

  it('report sets all safety flags', () => {
    const r = runWatchCohortReport({ _cohortRows: [mkCohort()], _trades: [] });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.noGateChanges).toBe(true);
    expect(r.noBuySignal).toBe(true);
    expect(r.noPaperIntentMutation).toBe(true);
    expect(r.unknownNeverClean).toBe(true);
  });
});
