import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDexPaperPositionReport,
  buildPlansFromDayLog,
  buildTrackedPosition,
  computeSnapshotVlr,
  getAllOutcomes,
  renderDexPaperPositionTrackerReport,
  renderDexPaperPositionTrackerUsage,
  runDexPaperPositionTracker,
  type DexPaperPositionReport,
  type DexPaperPositionTrackerOptions,
  type ExitReason,
  type TrackedPosition,
} from '../src/token-grab/dexPaperPositionTracker';
import type { DexPaperEntryPlanReport, PaperEntryPlan } from '../src/token-grab/dexPaperEntryPlanner';
import type { DexWatchOutcome, DexPairSnapshot, DexWatchReport } from '../src/token-grab/dexWatch';
import type { LoadedRun } from '../src/token-grab/dexPaperJournal';
import type { DayWatchCycleEntry } from '../src/token-grab/dexDayWatch';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

const SOL_A = 'GdXm5R29zuUfJn6p2pqpTZra9GmCc6PKB4VKF2Zbpump';
const SOL_B = 'ELON2222222222222222222222222222222222222222222';
const T0 = '2026-06-09T10:00:00.000Z';
const T1 = '2026-06-09T10:10:00.000Z'; // +10 min
const T2 = '2026-06-09T10:30:00.000Z'; // +30 min
const T3 = '2026-06-09T10:40:00.000Z'; // +40 min
const T_286m = '2026-06-09T14:46:00.000Z'; // +286 min (realistic day-watch inter-cycle gap)

function makeSnap(
  contract: string,
  price: number,
  liq: number,
  vol: number,
  observedAt: string,
): DexPairSnapshot {
  return { contract, chainId: 'solana', symbol: 'TEST', priceUsd: price, liquidityUsd: liq, volumeUsd: vol, observedAt };
}

function makeOutcome(
  contract: string,
  entrySnap: DexPairSnapshot,
  finalSnap: DexPairSnapshot | null,
): DexWatchOutcome {
  const price = finalSnap?.priceUsd && entrySnap.priceUsd
    ? ((finalSnap.priceUsd - entrySnap.priceUsd) / entrySnap.priceUsd) * 100
    : undefined;
  const liq = finalSnap?.liquidityUsd && entrySnap.liquidityUsd
    ? ((finalSnap.liquidityUsd - entrySnap.liquidityUsd) / entrySnap.liquidityUsd) * 100
    : undefined;
  const vlr = finalSnap?.volumeUsd && finalSnap?.liquidityUsd && finalSnap.liquidityUsd > 0
    ? finalSnap.volumeUsd / finalSnap.liquidityUsd
    : undefined;
  const classification =
    finalSnap == null ? 'missing' :
    price == null ? 'flat' :
    price >= 20 ? 'winner' :
    price <= -20 ? 'loser' : 'flat';
  return {
    signalId: contract,
    contract,
    symbol: 'TEST',
    chainId: 'solana',
    entry: entrySnap,
    final: finalSnap ?? undefined,
    priceChangePct: price,
    liquidityChangePct: liq,
    volumeToLiquidityRatio: vlr,
    classification,
  };
}

function makeOutcomeMissingEntry(contract: string): DexWatchOutcome {
  return {
    signalId: contract,
    contract,
    chainId: 'solana',
    classification: 'missing',
  };
}

function makeRun(file: string, outcomes: DexWatchOutcome[], generatedAt?: string): LoadedRun {
  const winners = outcomes.filter(o => o.classification === 'winner');
  const losers = outcomes.filter(o => o.classification === 'loser');
  const flat = outcomes.filter(o => o.classification === 'flat');
  const missing = outcomes.filter(o => o.classification === 'missing');
  const report: DexWatchReport = {
    generatedAt,
    signalsRead: outcomes.length,
    signalsWatched: outcomes.length,
    contractsFiltered: outcomes.length,
    snapshotsFound: outcomes.filter(o => o.entry && o.final).length,
    snapshotsMissing: 0,
    chain: 'solana',
    minutes: 10,
    intervalSeconds: 60,
    winners, losers, flat, missing,
    topMovers: [],
    dryRun: false,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
  return { file, generatedAt, report };
}

function makePlan(
  contract: string,
  rec: PaperEntryPlan['recommendation'] = 'CURRENT_CYCLE_PAPER_ENTRY',
  overrides: Partial<PaperEntryPlan> = {},
): PaperEntryPlan {
  return {
    symbol: 'TEST',
    contract,
    recommendation: rec,
    isCurrentCycle: rec === 'CURRENT_CYCLE_PAPER_ENTRY',
    sourceRunFile: 'run-20260609-100000.json',
    latestRunFile: 'run-20260609-100000.json',
    fakeEntrySize: 1,
    fakeStopLossPct: -20,
    fakeTakeProfitPct: 25,
    fakeRunnerTargetPct: 50,
    cancelConditions: [],
    reasons: [],
    historyRiskStatus: 'CLEAN',
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
    ...overrides,
  };
}

function makePlanReport(plans: PaperEntryPlan[]): DexPaperEntryPlanReport {
  return {
    plannedAt: T0,
    signalsFile: 'data/presignals.dex.json',
    runsDir: 'data/runs',
    journalFile: 'data/journal.json',
    fakeBankroll: 20,
    fakePositionSize: 1,
    latestRealRunFile: 'run-20260609-100000.json',
    totalPlans: plans.length,
    currentCyclePaperEntry: plans.filter(p => p.recommendation === 'CURRENT_CYCLE_PAPER_ENTRY').length,
    historicalJournalWinners: plans.filter(p => p.recommendation === 'HISTORICAL_JOURNAL_WINNER').length,
    watchOnly: plans.filter(p => p.recommendation === 'WATCH_ONLY').length,
    blockedHistoryRisk: plans.filter(p => p.recommendation === 'BLOCKED_HISTORY_RISK').length,
    noEntry: plans.filter(p => p.recommendation === 'NO_ENTRY').length,
    plans,
    readOnly: true,
    paperOnly: true,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

const DEFAULT_OPTS = { positionSize: 1, stopLossPct: -20, takeProfitPct: 25, runnerTargetPct: 50, maxHoldMinutes: 20 };

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dex-pos-'));
}

// ── getAllOutcomes ──────────────────────────────────────────────────────────────────────

describe('getAllOutcomes', () => {
  it('flattens winners/losers/flat/missing', () => {
    const w = makeOutcome(SOL_A, makeSnap(SOL_A, 1, 10000, 200, T0), makeSnap(SOL_A, 1.3, 10300, 200, T1));
    const l = makeOutcome(SOL_B, makeSnap(SOL_B, 1, 10000, 200, T0), makeSnap(SOL_B, 0.78, 9800, 200, T1));
    const run = makeRun('run-1.json', [w, l]);
    const all = getAllOutcomes(run.report);
    expect(all).toHaveLength(2);
  });
});

// ── computeSnapshotVlr ─────────────────────────────────────────────────────────────────

describe('computeSnapshotVlr', () => {
  it('computes volume / liquidity', () => {
    const snap = makeSnap(SOL_A, 1, 10000, 5000, T0);
    expect(computeSnapshotVlr(snap)).toBeCloseTo(0.5);
  });
  it('returns undefined when liq is zero', () => {
    expect(computeSnapshotVlr({ ...makeSnap(SOL_A, 1, 0, 1000, T0), liquidityUsd: 0 })).toBeUndefined();
  });
  it('returns undefined for missing snapshot', () => {
    expect(computeSnapshotVlr(undefined)).toBeUndefined();
  });
});

// ── buildTrackedPosition ────────────────────────────────────────────────────────────────

describe('buildTrackedPosition — exit reasons', () => {
  it('TAKE_PROFIT when final price >= +25%', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.27, 10100, 200, T1); // +27%
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)], T0);
    const plan = makePlan(SOL_A);
    const pos = buildTrackedPosition(plan, run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('TAKE_PROFIT');
    expect(pos.status).toBe('CLOSED');
  });

  it('RUNNER_TARGET when final price >= +50%', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.52, 10100, 200, T1); // +52%
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('RUNNER_TARGET');
    expect(pos.status).toBe('CLOSED');
  });

  it('RUNNER_TARGET takes priority over TAKE_PROFIT at same observation', () => {
    // +52% hits both RUNNER_TARGET (50%) and TAKE_PROFIT (25%)
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.52, 10100, 200, T1);
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('RUNNER_TARGET');
  });

  it('STOP_LOSS when price falls to -20%', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 0.79, 9800, 200, T1); // -21%
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('STOP_LOSS');
    expect(pos.status).toBe('CLOSED');
  });

  it('LIQUIDITY_DUMP when liquidity drops >= 25%', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 0.99, 7400, 200, T1); // liq -26%, price -1% (no stop-loss)
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('LIQUIDITY_DUMP');
  });

  it('VLR_SPIKE when VLR >= 3.0 after entry', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 500, T0);       // VLR 0.05 at entry
    const final = makeSnap(SOL_A, 1.05, 10000, 35000, T1);    // VLR 3.5 at final
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('VLR_SPIKE');
  });

  it('STILL_OPEN when no exit condition met and no later data', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.05, 10100, 210, T1); // +5%, no exit
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('STILL_OPEN');
    expect(pos.status).toBe('OPEN');
  });

  it('MISSING_OR_STALE when entry snapshot is missing', () => {
    const run = makeRun('run-20260609-100000.json', [makeOutcomeMissingEntry(SOL_A)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('MISSING_OR_STALE');
    expect(pos.status).toBe('CLOSED');
  });

  it('MISSING_OR_STALE when contract not found in source run', () => {
    // Source run has no entry for SOL_A at all
    const run = makeRun('run-20260609-100000.json', []);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('MISSING_OR_STALE');
  });

  it('MAX_HOLD_TIMEOUT when held >= maxHoldMinutes with no price exit', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.05, 10100, 200, T2); // T2 = +30 min, maxHold=20
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('MAX_HOLD_TIMEOUT');
    expect(pos.status).toBe('CLOSED');
  });

  it('exit from later run when sourceRun final does not trigger', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final1 = makeSnap(SOL_A, 1.05, 10050, 200, T1);  // +5%, no exit
    const sourceRun = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final1)]);

    // Later run: final snapshot has +30% → TAKE_PROFIT
    const entry2 = makeSnap(SOL_A, 1.1, 10100, 200, T2);
    const final2 = makeSnap(SOL_A, 1.3, 10200, 200, T3); // +30% from entry T0
    const laterRun = makeRun('run-20260609-103000.json', [makeOutcome(SOL_A, entry2, final2)]);

    // Use maxHoldMinutes=60 so the 40-min hold doesn't time out before the +30% TAKE_PROFIT.
    const pos = buildTrackedPosition(makePlan(SOL_A), sourceRun, [laterRun], { ...DEFAULT_OPTS, maxHoldMinutes: 60 });
    expect(pos.exitReason).toBe('TAKE_PROFIT');
  });
});

// ── buildTrackedPosition — max-hold enforcement ─────────────────────────────────────────
// These tests verify the bug fix: MAX_HOLD_TIMEOUT must be checked before price exits so
// an out-of-window snapshot (e.g. +286m) cannot produce a TAKE_PROFIT instead of timeout.

describe('buildTrackedPosition — max-hold enforcement', () => {
  it('snapshot at +286m with +40% price returns MAX_HOLD_TIMEOUT, not TAKE_PROFIT (regression)', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const late  = makeSnap(SOL_A, 1.4, 10500, 200, T_286m); // +40%, but 286 min > 20 min window
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, late)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('MAX_HOLD_TIMEOUT');
    expect(pos.status).toBe('CLOSED');
  });

  it('snapshot at +286m with +60% price returns MAX_HOLD_TIMEOUT, not RUNNER_TARGET (regression)', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const late  = makeSnap(SOL_A, 1.6, 10500, 200, T_286m); // +60%, but 286 min > 20 min window
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, late)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('MAX_HOLD_TIMEOUT');
  });

  it('+30% snapshot at +10m still returns TAKE_PROFIT (within window)', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.3, 10100, 200, T1); // +10 min, +30%
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('TAKE_PROFIT');
  });

  it('-25% snapshot at +10m still returns STOP_LOSS (within window)', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 0.74, 9700, 200, T1); // +10 min, -26%
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('STOP_LOSS');
  });

  it('liquidity dump at +10m still returns LIQUIDITY_DUMP (within window)', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 0.99, 7400, 200, T1); // +10 min, liq -26%
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('LIQUIDITY_DUMP');
  });

  it('VLR spike at +10m still returns VLR_SPIKE (within window)', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 500, T0);
    const final = makeSnap(SOL_A, 1.05, 10000, 35000, T1); // +10 min, VLR 3.5
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('VLR_SPIKE');
  });

  it('no out-of-window snapshot → in-window TAKE_PROFIT still wins over later timeout', () => {
    const entry  = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const inWin  = makeSnap(SOL_A, 1.3, 10100, 200, T1);     // +10 min, +30% → TAKE_PROFIT
    const outWin = makeSnap(SOL_A, 1.5, 10200, 200, T_286m); // +286 min, +50% (beyond window, never reached)
    const sourceRun = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, inWin)]);
    const laterRun  = makeRun('run-20260609-150000.json', [makeOutcome(SOL_A, inWin, outWin)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), sourceRun, [laterRun], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('TAKE_PROFIT');
  });

  it('holdMinutes does not exceed maxHoldMinutes on MAX_HOLD_TIMEOUT', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const late  = makeSnap(SOL_A, 1.4, 10500, 200, T_286m);
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, late)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('MAX_HOLD_TIMEOUT');
    expect(pos.holdMinutes).toBeLessThanOrEqual(DEFAULT_OPTS.maxHoldMinutes);
    expect(pos.holdMinutes).toBeCloseTo(DEFAULT_OPTS.maxHoldMinutes, 0);
  });

  it('no later snapshot → STILL_OPEN (entry age unknown, cannot confirm max hold expired)', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.05, 10100, 200, T1); // +10 min, +5%, no exit
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('STILL_OPEN');
    expect(pos.status).toBe('OPEN');
  });

  it('no observations at all → MISSING_OR_STALE (no data to track against)', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    // makeOutcome with null final → no final snapshot in the outcome
    const outcomeNoFinal: DexWatchOutcome = {
      signalId: SOL_A, contract: SOL_A, symbol: 'TEST', chainId: 'solana',
      entry, final: undefined, priceChangePct: undefined,
      liquidityChangePct: undefined, volumeToLiquidityRatio: undefined, classification: 'missing',
    };
    const run = makeRun('run-20260609-100000.json', [outcomeNoFinal]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    // No final + no laterRuns → observations.length === 0 → MISSING_OR_STALE
    expect(pos.exitReason).toBe('MISSING_OR_STALE');
  });
});

// ── buildTrackedPosition — stats ────────────────────────────────────────────────────────

describe('buildTrackedPosition — stats', () => {
  it('tracks maxRunupPct', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.2, 10200, 200, T1); // +20%
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.maxRunupPct).toBeCloseTo(20, 1);
  });

  it('tracks maxDrawdownPct (most negative price change seen)', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final1 = makeSnap(SOL_A, 0.85, 9500, 200, T1); // -15% at first obs
    const sourceRun = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final1)]);
    // Second obs recovers slightly but still below entry
    const final2 = makeSnap(SOL_A, 0.95, 9700, 200, T2);
    const laterRun = makeRun('run-20260609-103000.json', [makeOutcome(SOL_A, makeSnap(SOL_A, 0.9, 9600, 200, T2), final2)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), sourceRun, [laterRun], DEFAULT_OPTS);
    expect(pos.maxDrawdownPct).toBeLessThan(0);
    expect(pos.maxDrawdownPct).toBeCloseTo(-15, 0);
  });

  it('computes holdMinutes from entry to exit observedAt', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);       // T0 = 10:00
    const final = makeSnap(SOL_A, 1.27, 10100, 200, T1);      // T1 = 10:10, +10 min
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.holdMinutes).toBeCloseTo(10, 0);
  });

  it('records entryPrice and exitPrice', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.27, 10100, 200, T1);
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.entryPriceUsd).toBeCloseTo(1.0);
    expect(pos.exitPriceUsd).toBeCloseTo(1.27);
  });

  it('records entryLiq and exitLiq', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.27, 11000, 200, T1);
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.entryLiquidityUsd).toBeCloseTo(10000);
    expect(pos.exitLiquidityUsd).toBeCloseTo(11000);
  });
});

// ── buildTrackedPosition — fake P/L math ────────────────────────────────────────────────

describe('buildTrackedPosition — fake P/L', () => {
  it('TAKE_PROFIT +25% on $1 position → +$0.25', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.27, 10100, 200, T1); // +27%
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.fakePnlDollars).toBeCloseTo(0.27, 2);
  });

  it('STOP_LOSS -21% on $1 position → -$0.21', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 0.79, 9800, 200, T1);
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.fakePnlDollars).toBeCloseTo(-0.21, 2);
  });

  it('RUNNER_TARGET +52% on $2 position → +$1.04', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.52, 10100, 200, T1);
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], { ...DEFAULT_OPTS, positionSize: 2 });
    expect(pos.fakePnlDollars).toBeCloseTo(1.04, 2);
  });

  it('MISSING_OR_STALE → P/L is $0', () => {
    const run = makeRun('run-20260609-100000.json', [makeOutcomeMissingEntry(SOL_A)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.fakePnlDollars).toBe(0);
  });

  it('STILL_OPEN P/L reflects last known price change', () => {
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.1, 10100, 200, T1); // +10%, no exit
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const pos = buildTrackedPosition(makePlan(SOL_A), run, [], DEFAULT_OPTS);
    expect(pos.exitReason).toBe('STILL_OPEN');
    expect(pos.fakePnlDollars).toBeCloseTo(0.1, 2);
  });
});

// ── buildDexPaperPositionReport ─────────────────────────────────────────────────────────

describe('buildDexPaperPositionReport', () => {
  const baseTrackerOpts: DexPaperPositionTrackerOptions = {
    plannerFile: 'data/plan.json',
    runsDir: 'data/runs',
    out: 'data/positions.json',
    positionSize: 1,
    stopLossPct: -20,
    takeProfitPct: 25,
    runnerTargetPct: 50,
    maxHoldMinutes: 20,
    generatedAt: T0,
  };

  it('creates zero positions when no CURRENT_CYCLE_PAPER_ENTRY plans', () => {
    const planReport = makePlanReport([
      makePlan(SOL_A, 'HISTORICAL_JOURNAL_WINNER'),
      makePlan(SOL_B, 'BLOCKED_HISTORY_RISK'),
    ]);
    const runs: LoadedRun[] = [];
    const report = buildDexPaperPositionReport(planReport, runs, baseTrackerOpts);
    expect(report.totalPositions).toBe(0);
    expect(report.positions).toHaveLength(0);
  });

  it('ignores HISTORICAL_JOURNAL_WINNER plans', () => {
    const planReport = makePlanReport([
      makePlan(SOL_A, 'CURRENT_CYCLE_PAPER_ENTRY'),
      makePlan(SOL_B, 'HISTORICAL_JOURNAL_WINNER'),
    ]);
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.1, 10100, 200, T1);
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const report = buildDexPaperPositionReport(planReport, [run], baseTrackerOpts);
    expect(report.totalPositions).toBe(1);
    expect(report.positions.every(p => p.contract !== SOL_B)).toBe(true);
  });

  it('ignores BLOCKED_HISTORY_RISK plans', () => {
    const planReport = makePlanReport([makePlan(SOL_A, 'BLOCKED_HISTORY_RISK')]);
    const run = makeRun('run-20260609-100000.json', []);
    const report = buildDexPaperPositionReport(planReport, [run], baseTrackerOpts);
    expect(report.totalPositions).toBe(0);
  });

  it('ignores WATCH_ONLY plans', () => {
    const planReport = makePlanReport([makePlan(SOL_A, 'WATCH_ONLY')]);
    const run = makeRun('run-20260609-100000.json', []);
    const report = buildDexPaperPositionReport(planReport, [run], baseTrackerOpts);
    expect(report.totalPositions).toBe(0);
  });

  it('always sets safety fields', () => {
    const planReport = makePlanReport([]);
    const report = buildDexPaperPositionReport(planReport, [], baseTrackerOpts);
    expect(report.tradingExecuted).toBe(0);
    expect(report.noRealTradeSent).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.paperOnly).toBe(true);
  });

  it('computes totalFakePnlDollars as sum of position P/L', () => {
    const plan1 = makePlan(SOL_A, 'CURRENT_CYCLE_PAPER_ENTRY', { sourceRunFile: 'run-20260609-100000.json' });
    const plan2 = makePlan(SOL_B, 'CURRENT_CYCLE_PAPER_ENTRY', { sourceRunFile: 'run-20260609-100000.json' });
    const planReport = makePlanReport([plan1, plan2]);

    // SOL_A: TAKE_PROFIT +27%
    const entryA = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const finalA = makeSnap(SOL_A, 1.27, 10100, 200, T1);
    // SOL_B: STOP_LOSS -21%
    const entryB = makeSnap(SOL_B, 1.0, 10000, 200, T0);
    const finalB = makeSnap(SOL_B, 0.79, 9800, 200, T1);

    const run = makeRun('run-20260609-100000.json', [
      makeOutcome(SOL_A, entryA, finalA),
      makeOutcome(SOL_B, entryB, finalB),
    ]);
    const report = buildDexPaperPositionReport(planReport, [run], baseTrackerOpts);
    expect(report.totalPositions).toBe(2);
    expect(report.totalFakePnlDollars).toBeCloseTo(0.27 - 0.21, 2);
  });

  it('computes winRatePct from closed positions', () => {
    const plan1 = makePlan(SOL_A, 'CURRENT_CYCLE_PAPER_ENTRY', { sourceRunFile: 'run-20260609-100000.json' });
    const plan2 = makePlan(SOL_B, 'CURRENT_CYCLE_PAPER_ENTRY', { sourceRunFile: 'run-20260609-100000.json' });
    const planReport = makePlanReport([plan1, plan2]);

    const entry = (c: string) => makeSnap(c, 1.0, 10000, 200, T0);
    // SOL_A wins, SOL_B loses
    const runOutcomes = [
      makeOutcome(SOL_A, entry(SOL_A), makeSnap(SOL_A, 1.27, 10100, 200, T1)),
      makeOutcome(SOL_B, entry(SOL_B), makeSnap(SOL_B, 0.79, 9800, 200, T1)),
    ];
    const run = makeRun('run-20260609-100000.json', runOutcomes);
    const report = buildDexPaperPositionReport(planReport, [run], baseTrackerOpts);
    expect(report.winRatePct).toBeCloseTo(50, 0);
  });

  it('winRatePct is 0 when no closed positions', () => {
    const planReport = makePlanReport([]);
    const report = buildDexPaperPositionReport(planReport, [], baseTrackerOpts);
    expect(report.winRatePct).toBe(0);
  });

  it('MISSING_OR_STALE for plan with no matching run file', () => {
    const plan = makePlan(SOL_A, 'CURRENT_CYCLE_PAPER_ENTRY', { sourceRunFile: 'run-does-not-exist.json' });
    const planReport = makePlanReport([plan]);
    const run = makeRun('run-20260609-100000.json', []);
    const report = buildDexPaperPositionReport(planReport, [run], baseTrackerOpts);
    expect(report.positions[0].exitReason).toBe('MISSING_OR_STALE');
  });

  it('counts open and closed positions correctly', () => {
    const plan = makePlan(SOL_A, 'CURRENT_CYCLE_PAPER_ENTRY', { sourceRunFile: 'run-20260609-100000.json' });
    const planReport = makePlanReport([plan]);
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.05, 10100, 200, T1); // STILL_OPEN
    const run = makeRun('run-20260609-100000.json', [makeOutcome(SOL_A, entry, final)]);
    const report = buildDexPaperPositionReport(planReport, [run], baseTrackerOpts);
    expect(report.openPositions).toBe(1);
    expect(report.closedPositions).toBe(0);
  });
});

// ── runDexPaperPositionTracker integration ──────────────────────────────────────────────

describe('runDexPaperPositionTracker', () => {
  function makeTrackerOpts(dir: string, overrides: Partial<DexPaperPositionTrackerOptions> = {}): DexPaperPositionTrackerOptions {
    return {
      plannerFile: path.join(dir, 'plan.json'),
      runsDir: path.join(dir, 'runs'),
      out: path.join(dir, 'positions', 'dex-paper-positions.json'),
      positionSize: 1,
      stopLossPct: -20,
      takeProfitPct: 25,
      runnerTargetPct: 50,
      maxHoldMinutes: 20,
      generatedAt: T0,
      ...overrides,
    };
  }

  it('returns empty report when planner file is missing', () => {
    const dir = makeTempDir();
    const opts = makeTrackerOpts(dir);
    const report = runDexPaperPositionTracker(opts);
    expect(report.totalPositions).toBe(0);
    expect(report.tradingExecuted).toBe(0);
  });

  it('writes output JSON file', () => {
    const dir = makeTempDir();
    const opts = makeTrackerOpts(dir);
    // Write empty plan
    fs.writeFileSync(opts.plannerFile, JSON.stringify(makePlanReport([])), 'utf-8');
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
    runDexPaperPositionTracker(opts);
    expect(fs.existsSync(opts.out)).toBe(true);
  });

  it('output JSON always contains safety fields', () => {
    const dir = makeTempDir();
    const opts = makeTrackerOpts(dir);
    fs.writeFileSync(opts.plannerFile, JSON.stringify(makePlanReport([])), 'utf-8');
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
    runDexPaperPositionTracker(opts);
    const raw = JSON.parse(fs.readFileSync(opts.out, 'utf-8'));
    expect(raw.tradingExecuted).toBe(0);
    expect(raw.noRealTradeSent).toBe(true);
    expect(raw.readOnly).toBe(true);
    expect(raw.paperOnly).toBe(true);
  });
});

// ── renderDexPaperPositionTrackerUsage ──────────────────────────────────────────────────

describe('renderDexPaperPositionTrackerUsage', () => {
  it('includes command name', () => {
    expect(renderDexPaperPositionTrackerUsage()).toContain('token:dex-paper-position-tracker');
  });

  it('lists all option flags', () => {
    const u = renderDexPaperPositionTrackerUsage();
    expect(u).toContain('--runs-dir');
    expect(u).toContain('--planner');
    expect(u).toContain('--out');
    expect(u).toContain('--position-size');
    expect(u).toContain('--stop-loss-pct');
    expect(u).toContain('--take-profit-pct');
    expect(u).toContain('--runner-target-pct');
    expect(u).toContain('--max-hold-minutes');
    expect(u).toContain('--help');
  });

  it('lists all exit reasons', () => {
    const u = renderDexPaperPositionTrackerUsage();
    expect(u).toContain('RUNNER_TARGET');
    expect(u).toContain('TAKE_PROFIT');
    expect(u).toContain('STOP_LOSS');
    expect(u).toContain('LIQUIDITY_DUMP');
    expect(u).toContain('VLR_SPIKE');
    expect(u).toContain('MAX_HOLD_TIMEOUT');
    expect(u).toContain('STILL_OPEN');
    expect(u).toContain('MISSING_OR_STALE');
  });

  it('includes safety stance', () => {
    const u = renderDexPaperPositionTrackerUsage();
    expect(u).toContain('PAPER ONLY');
    expect(u).toContain('tradingExecuted: 0');
    expect(u).toContain('No wallet');
  });

  it('--help does not start tracker (pure string, no side effects)', () => {
    const u = renderDexPaperPositionTrackerUsage();
    expect(typeof u).toBe('string');
    expect(u.length).toBeGreaterThan(0);
  });
});

// ── renderDexPaperPositionTrackerReport ─────────────────────────────────────────────────

describe('renderDexPaperPositionTrackerReport', () => {
  function makeReport(overrides: Partial<DexPaperPositionReport> = {}): DexPaperPositionReport {
    return {
      generatedAt: T0,
      sourcePlanner: 'data/token-grab/paper-plans/dex-paper-entry-plan.json',
      runsDir: 'data/token-grab/dex-watch-runs',
      totalPositions: 0,
      openPositions: 0,
      closedPositions: 0,
      totalFakePnlDollars: 0,
      winRatePct: 0,
      positions: [],
      tradingExecuted: 0,
      noRealTradeSent: true,
      readOnly: true,
      paperOnly: true,
      ...overrides,
    };
  }

  it('includes safety banner', () => {
    const out = renderDexPaperPositionTrackerReport(makeReport());
    expect(out).toContain('PAPER ONLY');
    expect(out).toContain('NO REAL TRADE SENT');
    expect(out).toContain('tradingExecuted: 0');
    expect(out).toContain('No wallet');
  });

  it('shows position count and P/L', () => {
    const pos: TrackedPosition = {
      symbol: 'ALPHA', contract: SOL_A, sourceRunFile: 'run-1.json',
      entryObservedAt: T0, exitObservedAt: T1,
      entryPriceUsd: 1.0, exitPriceUsd: 1.27,
      entryLiquidityUsd: 10000, exitLiquidityUsd: 10100,
      maxRunupPct: 27, maxDrawdownPct: 0, holdMinutes: 10,
      exitReason: 'TAKE_PROFIT', fakePnlDollars: 0.27, status: 'CLOSED',
    };
    const out = renderDexPaperPositionTrackerReport(makeReport({
      totalPositions: 1, closedPositions: 1,
      totalFakePnlDollars: 0.27, winRatePct: 100, positions: [pos],
    }));
    expect(out).toContain('$ALPHA');
    expect(out).toContain('TAKE_PROFIT');
    expect(out).toContain('+$0.27');
  });

  it('shows exit reason breakdown', () => {
    const makePos = (reason: ExitReason): TrackedPosition => ({
      symbol: 'T', contract: SOL_A, sourceRunFile: 'run-1.json',
      entryObservedAt: T0, maxRunupPct: 0, maxDrawdownPct: 0, holdMinutes: 5,
      exitReason: reason, fakePnlDollars: 0, status: reason === 'STILL_OPEN' ? 'OPEN' : 'CLOSED',
    });
    const out = renderDexPaperPositionTrackerReport(makeReport({
      totalPositions: 3,
      positions: [makePos('TAKE_PROFIT'), makePos('STOP_LOSS'), makePos('STILL_OPEN')],
    }));
    expect(out).toContain('TAKE_PROFIT');
    expect(out).toContain('STOP_LOSS');
    expect(out).toContain('STILL_OPEN');
  });

  it('shows empty message when no positions', () => {
    const out = renderDexPaperPositionTrackerReport(makeReport());
    expect(out).toContain('No positions to track');
  });

  it('does not mention live trading concepts', () => {
    const out = renderDexPaperPositionTrackerReport(makeReport());
    expect(out).not.toContain('txHash');
    expect(out).not.toContain('privateKey');
    expect(out).not.toContain('walletAddress');
    expect(out).not.toContain('LIVE_EXECUTED');
  });

  it('shows source mode planner by default', () => {
    const out = renderDexPaperPositionTrackerReport(makeReport());
    expect(out).toContain('Source mode');
    expect(out).toContain('planner');
  });

  it('shows source mode day-log when sourceMode is day-log', () => {
    const out = renderDexPaperPositionTrackerReport(makeReport({ sourceMode: 'day-log', sourcePlanner: 'data/token-grab/day-watch/dex-day-watch.jsonl' }));
    expect(out).toContain('day-log');
    expect(out).toContain('Source day log');
    expect(out).toContain('dex-day-watch.jsonl');
  });
});

// ── buildPlansFromDayLog ────────────────────────────────────────────────────────────────

function makeDayCycleEntry(
  cycleNumber: number,
  newestRunFile: string,
  entries: Array<{ contract: string; symbol?: string }>,
): DayWatchCycleEntry {
  return {
    generatedAt: T0,
    cycleNumber,
    newestRunFile,
    contractsWatched: entries.length,
    winners: entries.length,
    losers: 0,
    flat: 0,
    missing: 0,
    runnerCandidateTrades: 0,
    runnerFakePnl: 0,
    journalTotalSimulated: 0,
    journalFakePnl: 0,
    plannerLatestRealRun: newestRunFile,
    currentCyclePaperEntry: entries.length,
    historicalJournalWinners: 0,
    blockedHistoryRisk: 0,
    watchOnly: 0,
    noEntry: 0,
    finalRecommendation: 'MANUAL_REVIEW_NEEDED',
    topCurrentCycleEntries: entries.map(e => ({
      contract: e.contract,
      symbol: e.symbol,
      priceChangePct: 25,
      liquidityChangePct: 12,
      volumeLiquidityRatio: 0.6,
    })),
    topBlockedMovers: [],
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  };
}

describe('buildPlansFromDayLog', () => {
  it('returns empty array for empty log', () => {
    expect(buildPlansFromDayLog([])).toHaveLength(0);
  });

  it('creates one plan per unique contract+runFile', () => {
    const entries = [makeDayCycleEntry(1, 'run-20260609-100000.json', [{ contract: SOL_A, symbol: 'OLBOS' }])];
    const plans = buildPlansFromDayLog(entries);
    expect(plans).toHaveLength(1);
    expect(plans[0].contract).toBe(SOL_A);
    expect(plans[0].recommendation).toBe('CURRENT_CYCLE_PAPER_ENTRY');
    expect(plans[0].sourceRunFile).toBe('run-20260609-100000.json');
  });

  it('deduplicates same contract+runFile appearing in multiple cycles', () => {
    const runFile = 'run-20260609-100000.json';
    const entries = [
      makeDayCycleEntry(1, runFile, [{ contract: SOL_A }]),
      makeDayCycleEntry(2, runFile, [{ contract: SOL_A }]),
    ];
    const plans = buildPlansFromDayLog(entries);
    expect(plans).toHaveLength(1);
  });

  it('same contract different runFile → two plans', () => {
    const entries = [
      makeDayCycleEntry(1, 'run-20260609-100000.json', [{ contract: SOL_A }]),
      makeDayCycleEntry(2, 'run-20260609-110000.json', [{ contract: SOL_A }]),
    ];
    const plans = buildPlansFromDayLog(entries);
    expect(plans).toHaveLength(2);
    expect(plans[0].sourceRunFile).toBe('run-20260609-100000.json');
    expect(plans[1].sourceRunFile).toBe('run-20260609-110000.json');
  });

  it('skips entries with empty newestRunFile', () => {
    const entry = makeDayCycleEntry(1, '', [{ contract: SOL_A }]);
    expect(buildPlansFromDayLog([entry])).toHaveLength(0);
  });

  it('includes all contracts from one cycle', () => {
    const entries = [makeDayCycleEntry(1, 'run-1.json', [{ contract: SOL_A }, { contract: SOL_B }])];
    const plans = buildPlansFromDayLog(entries);
    expect(plans).toHaveLength(2);
  });

  it('sets all required safety fields', () => {
    const entries = [makeDayCycleEntry(1, 'run-1.json', [{ contract: SOL_A }])];
    const plan = buildPlansFromDayLog(entries)[0];
    expect(plan.tradingExecuted).toBe(0);
    expect(plan.noRealTradeSent).toBe(true);
    expect(plan.readOnly).toBe(true);
    expect(plan.paperOnly).toBe(true);
    expect(plan.historyRiskStatus).toBe('CLEAN');
  });
});

// ── runDexPaperPositionTracker — day-log mode ───────────────────────────────────────────

describe('runDexPaperPositionTracker — day-log mode', () => {
  function writeRunFile(dir: string, filename: string, outcomes: DexWatchOutcome[]): void {
    const winners = outcomes.filter(o => o.classification === 'winner');
    const losers = outcomes.filter(o => o.classification === 'loser');
    const flat = outcomes.filter(o => o.classification === 'flat');
    const missing = outcomes.filter(o => o.classification === 'missing');
    const report = { generatedAt: T0, winners, losers, flat, missing, signalsRead: outcomes.length, signalsWatched: outcomes.length, contractsFiltered: outcomes.length, snapshotsFound: 0, snapshotsMissing: 0, chain: 'solana', minutes: 10, intervalSeconds: 60, topMovers: [], dryRun: false, tradingExecuted: 0, noRealTradeSent: true };
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(report), 'utf-8');
  }

  it('creates positions even when planner CURRENT=0 but day-log has entries', () => {
    const dir = makeTempDir();
    const runsDir = path.join(dir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    // Planner file has zero current-cycle entries.
    const plannerFile = path.join(dir, 'plan.json');
    fs.writeFileSync(plannerFile, JSON.stringify(makePlanReport([])), 'utf-8');

    // Run file has SOL_A with a +27% TAKE_PROFIT outcome.
    const runFile = 'run-20260609-100000.json';
    const entry = makeSnap(SOL_A, 1.0, 10000, 200, T0);
    const final = makeSnap(SOL_A, 1.27, 10100, 200, T1);
    writeRunFile(runsDir, runFile, [makeOutcome(SOL_A, entry, final)]);

    // Day-log JSONL has one cycle with SOL_A as a current-cycle entry.
    const dayLogFile = path.join(dir, 'dex-day-watch.jsonl');
    const dayEntry = makeDayCycleEntry(1, runFile, [{ contract: SOL_A, symbol: 'OLBOS' }]);
    fs.writeFileSync(dayLogFile, JSON.stringify(dayEntry) + '\n', 'utf-8');

    const report = runDexPaperPositionTracker({
      plannerFile,
      dayLogFile,
      runsDir,
      out: path.join(dir, 'positions.json'),
      positionSize: 1,
      stopLossPct: -20,
      takeProfitPct: 25,
      runnerTargetPct: 50,
      maxHoldMinutes: 20,
      generatedAt: T0,
    });

    expect(report.totalPositions).toBe(1);
    expect(report.sourceMode).toBe('day-log');
    expect(report.positions[0].contract).toBe(SOL_A);
    expect(report.positions[0].exitReason).toBe('TAKE_PROFIT');
  });

  it('empty day-log creates zero positions', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });

    const dayLogFile = path.join(dir, 'dex-day-watch.jsonl');
    fs.writeFileSync(dayLogFile, '', 'utf-8');

    const report = runDexPaperPositionTracker({
      plannerFile: path.join(dir, 'plan.json'),
      dayLogFile,
      runsDir: path.join(dir, 'runs'),
      out: path.join(dir, 'positions.json'),
      generatedAt: T0,
    });

    expect(report.totalPositions).toBe(0);
    expect(report.sourceMode).toBe('day-log');
  });

  it('safety fields remain true in day-log mode', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });

    const dayLogFile = path.join(dir, 'log.jsonl');
    fs.writeFileSync(dayLogFile, '', 'utf-8');

    const report = runDexPaperPositionTracker({
      plannerFile: path.join(dir, 'plan.json'),
      dayLogFile,
      runsDir: path.join(dir, 'runs'),
      out: path.join(dir, 'positions.json'),
      generatedAt: T0,
    });

    expect(report.tradingExecuted).toBe(0);
    expect(report.noRealTradeSent).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.paperOnly).toBe(true);
  });

  it('deduplicates entries from day-log across cycles with same contract+runFile', () => {
    const dir = makeTempDir();
    const runsDir = path.join(dir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    const runFile = 'run-20260609-100000.json';
    writeRunFile(runsDir, runFile, [
      makeOutcome(SOL_A, makeSnap(SOL_A, 1.0, 10000, 200, T0), makeSnap(SOL_A, 1.1, 10100, 200, T1)),
    ]);

    const dayLogFile = path.join(dir, 'log.jsonl');
    // Same contract+runFile in two cycles — must be deduped to one position.
    const lines = [
      makeDayCycleEntry(1, runFile, [{ contract: SOL_A }]),
      makeDayCycleEntry(2, runFile, [{ contract: SOL_A }]),
    ].map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(dayLogFile, lines + '\n', 'utf-8');

    const report = runDexPaperPositionTracker({
      plannerFile: path.join(dir, 'plan.json'),
      dayLogFile,
      runsDir,
      out: path.join(dir, 'positions.json'),
      generatedAt: T0,
    });

    expect(report.totalPositions).toBe(1);
  });

  it('planner source mode still works when no --day-log', () => {
    const dir = makeTempDir();
    const plannerFile = path.join(dir, 'plan.json');
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
    fs.writeFileSync(plannerFile, JSON.stringify(makePlanReport([])), 'utf-8');

    const report = runDexPaperPositionTracker({
      plannerFile,
      runsDir: path.join(dir, 'runs'),
      out: path.join(dir, 'positions.json'),
      generatedAt: T0,
    });

    expect(report.sourceMode).toBe('planner');
    expect(report.sourcePlanner).toBe(plannerFile);
  });
});

// ── renderDexPaperPositionTrackerUsage — day-log ────────────────────────────────────────

describe('renderDexPaperPositionTrackerUsage — day-log', () => {
  it('documents --day-log option', () => {
    expect(renderDexPaperPositionTrackerUsage()).toContain('--day-log');
  });

  it('--help does not run tracker (pure string result)', () => {
    const u = renderDexPaperPositionTrackerUsage();
    expect(typeof u).toBe('string');
    expect(u).toContain('--day-log');
    expect(u).toContain('--planner');
  });
});
