// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  enrollCohortFamily,
  renderFamilyEnroll,
  runFamilyReport,
  renderFamilyReport,
  deriveCandidate,
  LANES,
  laneFilePath,
  type FamilyCohortRow,
  type LaneKey,
} from '../src/token-grab/ripperWatchCohortFamily';
import type { SimulatedTrade } from '../src/token-grab/ripperPaperTradeSimulationReport';

// ── Fixtures ──────────────────────────────────────────────────────────────────────

let dir: string, cyclesDir: string, dataDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-'));
  cyclesDir = path.join(dir, 'cycles');
  dataDir   = path.join(dir, 'data');
  fs.mkdirSync(cyclesDir);
  fs.mkdirSync(dataDir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

let cc = 0;
/** Raw cycle row. Defaults => approved ENTER_NOW (UNKNOWN cluster) with given m5/liq. */
function cycleRow(o: Record<string, any> = {}): Record<string, unknown> {
  cc++;
  return {
    capturedAt:       o.capturedAt ?? '2026-06-26T02:00:00.000Z',
    buyGateDecision:  o.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    entryDecision:    o.entryDecision ?? 'READY_TO_SNIPE_PAPER',
    entryMomentumPct: 'entryMomentumPct' in o ? o.entryMomentumPct : -10, // → m5Band -20 to -5
    ripperScore:      o.ripperScore ?? 90,
    launchAgeBucket:  o.launchAgeBucket ?? 'PRIME_WINDOW',
    normalizedSignal: {
      contract:             o.contract ?? `K${cc}`,
      symbol:               o.symbol ?? `S${cc}`,
      liquidityUsd:         o.liquidityUsd ?? 20_000,       // → LIQ_10K_30K
      volumeLiquidityRatio: o.vlr ?? 1.0,
    },
    ripperInput: { contract: o.contract ?? `K${cc}`, clusterRisk: o.clusterRisk ?? 'UNKNOWN' },
  };
}

function writeCycle(name: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(path.join(cyclesDir, name), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}
function readLane(lane: LaneKey): FamilyCohortRow[] {
  const p = laneFilePath(dataDir, lane);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as FamilyCohortRow);
}

// ── Lane classifiers ────────────────────────────────────────────────────────────────

describe('lane classifiers (entry-time only)', () => {
  function cand(o: Record<string, any> = {}) {
    return deriveCandidate(cycleRow(o))!;
  }
  function laneMatch(key: LaneKey, c: ReturnType<typeof cand>): boolean {
    return LANES.find(l => l.key === key)!.matches(c);
  }

  it('EXACT_WATCH: ENTER_NOW + -20 to -5 + LIQ_10K_30K', () => {
    expect(laneMatch('EXACT_WATCH', cand({ entryMomentumPct: -10, liquidityUsd: 20_000 }))).toBe(true);
    expect(laneMatch('EXACT_WATCH', cand({ liquidityUsd: 50_000 }))).toBe(false); // LIQ_30K_100K
    expect(laneMatch('EXACT_WATCH', cand({ entryMomentumPct: 0 }))).toBe(false);  // -5 to +5
  });

  it('LIQUIDITY_NEAR: ENTER_NOW + -20 to -5 + LIQ_10K_30K or LIQ_30K_100K', () => {
    expect(laneMatch('LIQUIDITY_NEAR', cand({ liquidityUsd: 20_000 }))).toBe(true);
    expect(laneMatch('LIQUIDITY_NEAR', cand({ liquidityUsd: 50_000 }))).toBe(true);  // near
    expect(laneMatch('LIQUIDITY_NEAR', cand({ liquidityUsd: 5_000 }))).toBe(false);  // LIQ_LT_10K
    expect(laneMatch('LIQUIDITY_NEAR', cand({ entryMomentumPct: 0 }))).toBe(false);  // wrong m5
  });

  it('MOMENTUM_FAMILY: ENTER_NOW + (-20 to -5 or -5 to +5) + near liquidity', () => {
    expect(laneMatch('MOMENTUM_FAMILY', cand({ entryMomentumPct: -10, liquidityUsd: 50_000 }))).toBe(true);
    expect(laneMatch('MOMENTUM_FAMILY', cand({ entryMomentumPct: 0, liquidityUsd: 20_000 }))).toBe(true);
    expect(laneMatch('MOMENTUM_FAMILY', cand({ entryMomentumPct: 30, liquidityUsd: 20_000 }))).toBe(false); // +20 to +50
    expect(laneMatch('MOMENTUM_FAMILY', cand({ entryMomentumPct: -10, liquidityUsd: 5_000 }))).toBe(false); // not near
  });

  it('WAIT10_QUALITY: WAIT_10M + near liquidity + m5 available (CLEAN HQ subgroup only)', () => {
    // WAIT_10M arises only for the HQ subgroup: CLEAN + score>=100 + PRIME_WINDOW + READY_TO_SNIPE_PAPER.
    const wait10 = cand({ clusterRisk: 'CLEAN', ripperScore: 100, liquidityUsd: 20_000, entryMomentumPct: -10 });
    expect(wait10.paperEntryTiming).toBe('WAIT_10M');
    expect(laneMatch('WAIT10_QUALITY', wait10)).toBe(true);
    // m5 UNAVAILABLE → excluded (conservative)
    const noM5 = cand({ clusterRisk: 'CLEAN', ripperScore: 100, liquidityUsd: 20_000, entryMomentumPct: null });
    expect(laneMatch('WAIT10_QUALITY', noM5)).toBe(false);
    // ENTER_NOW row never lands in WAIT10
    expect(laneMatch('WAIT10_QUALITY', cand({ liquidityUsd: 20_000 }))).toBe(false);
  });
});

// ── Enrollment: independence, dedupe, dry-run ─────────────────────────────────────────

describe('family enrollment', () => {
  it('writes each lane to its own independent file', () => {
    // An EXACT row also satisfies LIQUIDITY_NEAR and MOMENTUM_FAMILY (nested lanes).
    writeCycle('cycle-2026-06-26-020000.jsonl', [cycleRow({ contract: 'EX', entryMomentumPct: -10, liquidityUsd: 20_000 })]);
    const r = enrollCohortFamily({ cyclesDir, dataDir });

    const byLane = Object.fromEntries(r.lanes.map(l => [l.lane, l]));
    expect(byLane['EXACT_WATCH']!.rowsAppended).toBe(1);
    expect(byLane['LIQUIDITY_NEAR']!.rowsAppended).toBe(1);
    expect(byLane['MOMENTUM_FAMILY']!.rowsAppended).toBe(1);
    expect(byLane['WAIT10_QUALITY']!.rowsAppended).toBe(0);

    // Independent files exist with the right lane tag.
    expect(readLane('EXACT_WATCH')[0]!.lane).toBe('EXACT_WATCH');
    expect(readLane('LIQUIDITY_NEAR')[0]!.lane).toBe('LIQUIDITY_NEAR');
    expect(readLane('MOMENTUM_FAMILY')[0]!.lane).toBe('MOMENTUM_FAMILY');
    expect(fs.existsSync(laneFilePath(dataDir, 'WAIT10_QUALITY'))).toBe(false);
  });

  it('dedupes each lane independently; re-run appends 0', () => {
    writeCycle('cycle-2026-06-26-020000.jsonl', [
      cycleRow({ contract: 'A', entryMomentumPct: -10, liquidityUsd: 20_000 }),
      cycleRow({ contract: 'B', entryMomentumPct: -10, liquidityUsd: 20_000 }),
    ]);
    const r1 = enrollCohortFamily({ cyclesDir, dataDir });
    expect(r1.lanes.find(l => l.lane === 'EXACT_WATCH')!.rowsAppended).toBe(2);

    const r2 = enrollCohortFamily({ cyclesDir, dataDir });
    const exact2 = r2.lanes.find(l => l.lane === 'EXACT_WATCH')!;
    expect(exact2.rowsAppended).toBe(0);
    expect(exact2.duplicatesSkipped).toBe(2);
    expect(readLane('EXACT_WATCH')).toHaveLength(2);
  });

  it('dry-run writes nothing but reports would-append counts', () => {
    writeCycle('cycle-2026-06-26-020000.jsonl', [cycleRow({ contract: 'DRY', entryMomentumPct: -10, liquidityUsd: 20_000 })]);
    const r = enrollCohortFamily({ cyclesDir, dataDir, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.lanes.find(l => l.lane === 'EXACT_WATCH')!.rowsAppended).toBe(1);
    // No files written.
    for (const lane of LANES) expect(fs.existsSync(laneFilePath(dataDir, lane.key))).toBe(false);
  });

  it('uses entry-time fields only — outcome/P&L on the row never affects enrollment', () => {
    // Add bogus outcome-ish fields; enrollment must ignore them and still classify on entry fields.
    writeCycle('cycle-2026-06-26-020000.jsonl', [
      cycleRow({ contract: 'WIN', entryMomentumPct: -10, liquidityUsd: 20_000, priceChangePct: 999, simulatedPnlPct: 999, winner: true }),
    ]);
    const r = enrollCohortFamily({ cyclesDir, dataDir });
    expect(r.lanes.find(l => l.lane === 'EXACT_WATCH')!.rowsAppended).toBe(1);
    const row = readLane('EXACT_WATCH')[0]!;
    // Cohort row carries NO outcome/P&L fields.
    for (const k of ['priceChangePct', 'simulatedPnlPct', 'winner', 'pnl', 'outcome']) {
      expect(Object.keys(row)).not.toContain(k);
    }
  });

  it('preserves UNKNOWN cluster as UNKNOWN, never CLEAN', () => {
    writeCycle('cycle-2026-06-26-020000.jsonl', [cycleRow({ contract: 'U', clusterRisk: 'UNKNOWN', entryMomentumPct: -10, liquidityUsd: 20_000 })]);
    enrollCohortFamily({ cyclesDir, dataDir });
    const row = readLane('EXACT_WATCH')[0]!;
    expect(row.clusterRisk).toBe('UNKNOWN');
    expect(row.clusterRisk).not.toBe('CLEAN');
  });

  it('enroll render includes safety strings and only DO_NOT_ real-trading forms', () => {
    writeCycle('cycle-2026-06-26-020000.jsonl', [cycleRow({ contract: 'S', entryMomentumPct: -10, liquidityUsd: 20_000 })]);
    const txt = renderFamilyEnroll(enrollCohortFamily({ cyclesDir, dataDir, dryRun: true }));
    expect(txt).toContain('PAPER_ONLY_WATCH_NOT_BUY');
    expect(txt).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(txt).toContain('DO_NOT_PROMOTE_TO_REAL_TRADING');
    expect(txt).toContain('DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    expect(txt).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
  });
});

// ── Report ────────────────────────────────────────────────────────────────────────────

let tc = 0;
function mkTrade(o: Partial<SimulatedTrade> = {}): SimulatedTrade {
  tc++;
  return {
    intentId: `it${tc}`, symbol: `S${tc}`, contract: `T${tc}`,
    paperEntryTiming: 'ENTER_NOW', reason: '', sourceCycle: 'cycle-x',
    clusterRisk: 'UNKNOWN', ripperScore: 100, launchAgeBucket: 'PRIME_WINDOW',
    entryDecision: 'READY_TO_SNIPE_PAPER', targetEntryAt: '2026-06-26T02:00:00.000Z',
    observedAt: '2026-06-26T02:10:00.000Z', priceChangePct: 0, simulatedPnlPct: 0,
    entryMomentumPct: -10, entryMomentumSource: 'DEX_SCREENER_M5', entryMomentumWindowLabel: 'M5',
    liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2', timingPath: 'ENTER_NOW',
    m5Band: '-20 to -5', ...o,
  };
}
function mkCohort(o: Partial<FamilyCohortRow> = {}): FamilyCohortRow {
  return {
    schemaVersion: 1, lane: 'EXACT_WATCH', cohortName: 'X', label: 'SUBGROUP_WATCH_PAPER_ONLY',
    enrolledAt: '2026-06-26T02:00:00.000Z', cycleId: 'cycle-x', cycleFile: 'cycle-x.jsonl',
    capturedAt: '2026-06-26T02:00:00.000Z', dedupeKey: 'k', contract: 'C', symbol: 'C',
    buyGateDecision: 'BUY_APPROVED_PAPER', paperEntryTiming: 'ENTER_NOW', entryMomentumPct: -10,
    m5Band: '-20 to -5', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2',
    clusterRisk: 'UNKNOWN', ripperScore: 100, reason: 'r', safety: 'PAPER_ONLY_WATCH_NOT_BUY',
    DO_NOT_ENABLE_REAL_TRADING: true, DO_NOT_PROMOTE_TO_REAL_TRADING: true,
    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE: true, ...o,
  };
}

describe('family report', () => {
  it('handles n=0 cleanly (empty cohorts, no trades)', () => {
    const r = runFamilyReport({ dataDir, _trades: [], _cohortRowsByLane: {} });
    for (const lane of r.lanes) {
      expect(lane.enrolledCount).toBe(0);
      expect(lane.observedCount).toBe(0);
      expect(lane.stats.n).toBe(0);
      expect(lane.stats.winRate).toBe(0);
      expect(lane.recommendation).toBe('FORWARD_SAMPLE_TOO_SMALL');
    }
    expect(r.familyRecommendation).toBe('FORWARD_SAMPLE_TOO_SMALL');
  });

  it('marks rows PENDING when no outcome and FORWARD_SAMPLE_TOO_SMALL under 50', () => {
    const cohort = [mkCohort({ contract: 'NOPE', dedupeKey: 'k1' })];
    const r = runFamilyReport({ dataDir, _trades: [], _cohortRowsByLane: { EXACT_WATCH: cohort } });
    const exact = r.lanes.find(l => l.lane === 'EXACT_WATCH')!;
    expect(exact.pendingCount).toBe(1);
    expect(exact.observedCount).toBe(0);
    expect(exact.recommendation).toBe('FORWARD_SAMPLE_TOO_SMALL');
  });

  it('returns PAPER_ONLY_CANDIDATE for a strong lane vs weak baseline (n>=50)', () => {
    // Lane: 60 cohort rows each with a matching observed trade (50 win +8, 10 loss -3).
    const watchPnls = [...new Array(50).fill(8), ...new Array(10).fill(-3)];
    const cohort: FamilyCohortRow[] = [];
    const trades: SimulatedTrade[] = [];
    watchPnls.forEach((p, i) => {
      cohort.push(mkCohort({ contract: `W${i}`, dedupeKey: `wk${i}` }));
      trades.push(mkTrade({ contract: `W${i}`, simulatedPnlPct: p }));
    });
    // Baseline includes the lane trades plus a large weak population → lane beats baseline.
    for (let i = 0; i < 100; i++) trades.push(mkTrade({ contract: `B${i}`, simulatedPnlPct: i < 40 ? 1 : -2 }));

    const r = runFamilyReport({ dataDir, _trades: trades, _cohortRowsByLane: { EXACT_WATCH: cohort } });
    const exact = r.lanes.find(l => l.lane === 'EXACT_WATCH')!;
    expect(exact.observedCount).toBe(60);
    expect(exact.recommendation).toBe('PAPER_ONLY_CANDIDATE');
    expect(r.familyRecommendation).toBe('PAPER_ONLY_CANDIDATE');
  });

  it('returns KEEP_COLLECTING when n>=50 but not better than baseline', () => {
    // Lane mirrors the baseline (same weak distribution) → not better.
    const pnls = [...new Array(25).fill(1), ...new Array(35).fill(-2)];
    const cohort: FamilyCohortRow[] = [];
    const trades: SimulatedTrade[] = [];
    pnls.forEach((p, i) => {
      cohort.push(mkCohort({ contract: `W${i}`, dedupeKey: `wk${i}` }));
      trades.push(mkTrade({ contract: `W${i}`, simulatedPnlPct: p }));
    });
    const r = runFamilyReport({ dataDir, _trades: trades, _cohortRowsByLane: { EXACT_WATCH: cohort } });
    const exact = r.lanes.find(l => l.lane === 'EXACT_WATCH')!;
    expect(exact.observedCount).toBe(60);
    expect(exact.recommendation).toBe('KEEP_COLLECTING');
    expect(r.familyRecommendation).toBe('KEEP_COLLECTING');
  });

  it('UNKNOWN cluster stays UNKNOWN in lane breakdown, never CLEAN', () => {
    const cohort = [0, 1, 2].map(i => mkCohort({ contract: `W${i}`, dedupeKey: `k${i}`, clusterRisk: 'UNKNOWN' }));
    const trades = [0, 1, 2].map(i => mkTrade({ contract: `W${i}`, simulatedPnlPct: 5 }));
    const r = runFamilyReport({ dataDir, _trades: trades, _cohortRowsByLane: { EXACT_WATCH: cohort } });
    const exact = r.lanes.find(l => l.lane === 'EXACT_WATCH')!;
    expect(exact.stats.clusterBreakdown['UNKNOWN']).toBe(3);
    expect(exact.stats.clusterBreakdown['CLEAN']).toBeUndefined();
    expect(r.unknownNeverClean).toBe(true);
  });

  it('report render includes safety strings and only DO_NOT_ real-trading forms', () => {
    const txt = renderFamilyReport(runFamilyReport({ dataDir, _trades: [], _cohortRowsByLane: {} }));
    expect(txt).toContain('PAPER_ONLY_WATCH_NOT_BUY');
    expect(txt).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(txt).toContain('DO_NOT_PROMOTE_TO_REAL_TRADING');
    expect(txt).toContain('DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
    expect(txt).toContain('UNKNOWN ≠ CLEAN');
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    expect(txt).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
  });

  it('sets all report safety flags', () => {
    const r = runFamilyReport({ dataDir, _trades: [], _cohortRowsByLane: {} });
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
