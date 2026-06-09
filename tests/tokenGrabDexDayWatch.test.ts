import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendDayWatchEntry,
  buildDayReport,
  buildDayWatchCycleEntry,
  determineDayVerdict,
  loadDayLog,
  renderDayReport,
  renderDayReportUsage,
  renderDayWatchUsage,
  runDexDayWatch,
  type DayReport,
  type DayVerdict,
  type DayWatchCycleEntry,
  type DayWatchOptions,
} from '../src/token-grab/dexDayWatch';
import type { DexPaperCycleResult } from '../src/token-grab/dexPaperRunner';
import type { DexPaperEntryPlanReport } from '../src/token-grab/dexPaperEntryPlanner';
import type { DexEndpointResult } from '../src/token-grab/dexEars';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

const SOL_A = 'GdXm5R29zuUfJn6p2pqpTZra9GmCc6PKB4VKF2Zbpump';
const SOL_B = 'ELON2222222222222222222222222222222222222222222';
const AT = '2026-06-09T10:00:00.000Z';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dex-day-'));
}

function writeConfig(dir: string): string {
  const p = path.join(dir, 'dex-ears.json');
  fs.writeFileSync(
    p,
    JSON.stringify({
      chain: 'solana',
      minConfidence: 'medium',
      maxItemsPerEndpoint: 50,
      timeoutMs: 10000,
      endpoints: { latestProfiles: true, latestBoosts: false, topBoosts: false },
    }),
    'utf-8',
  );
  return p;
}

function makeCycleResult(overrides: Partial<DexPaperCycleResult> = {}): DexPaperCycleResult {
  return {
    cycle: 1,
    generatedAt: AT,
    signalsFound: 10,
    watchSkipped: false,
    contractsWatched: 10,
    winners: 1,
    losers: 0,
    flat: 9,
    savedRunPath: '/tmp/runs/run-20260609-100000.json',
    tradesSimulated: 0,
    fakePnlDollars: 0,
    fakePnlPct: 0,
    winRate: 0,
    blockedCount: 0,
    ...overrides,
  };
}

function makePlanReport(overrides: Partial<DexPaperEntryPlanReport> = {}): DexPaperEntryPlanReport {
  return {
    plannedAt: AT,
    signalsFile: 'data/presignals.dex.json',
    runsDir: 'data/runs',
    journalFile: 'data/journal.json',
    fakeBankroll: 20,
    fakePositionSize: 1,
    latestRealRunFile: 'run-20260609-100000.json',
    totalPlans: 10,
    currentCyclePaperEntry: 0,
    historicalJournalWinners: 0,
    watchOnly: 5,
    blockedHistoryRisk: 0,
    noEntry: 5,
    plans: [],
    readOnly: true,
    paperOnly: true,
    tradingExecuted: 0,
    noRealTradeSent: true,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<DayWatchCycleEntry> = {}): DayWatchCycleEntry {
  return {
    generatedAt: AT,
    cycleNumber: 1,
    newestRunFile: 'run-20260609-100000.json',
    contractsWatched: 10,
    winners: 0,
    losers: 0,
    flat: 10,
    missing: 0,
    runnerCandidateTrades: 0,
    runnerFakePnl: 0,
    journalTotalSimulated: 0,
    journalFakePnl: 0,
    plannerLatestRealRun: 'run-20260609-100000.json',
    currentCyclePaperEntry: 0,
    historicalJournalWinners: 0,
    blockedHistoryRisk: 0,
    watchOnly: 5,
    noEntry: 5,
    finalRecommendation: 'NO_SIGNAL',
    topCurrentCycleEntries: [],
    topBlockedMovers: [],
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
    ...overrides,
  };
}

// ── renderDayWatchUsage ─────────────────────────────────────────────────────────────────

describe('renderDayWatchUsage', () => {
  it('includes command name', () => {
    expect(renderDayWatchUsage()).toContain('token:dex-day-watch');
  });

  it('lists all option flags', () => {
    const u = renderDayWatchUsage();
    expect(u).toContain('--dex-config');
    expect(u).toContain('--signals-out');
    expect(u).toContain('--runs-dir');
    expect(u).toContain('--journal');
    expect(u).toContain('--planner-out');
    expect(u).toContain('--day-log');
    expect(u).toContain('--fake-bankroll');
    expect(u).toContain('--position-size');
    expect(u).toContain('--cycles');
    expect(u).toContain('--minutes');
    expect(u).toContain('--interval-seconds');
    expect(u).toContain('--sleep-between-cycles-minutes');
    expect(u).toContain('--help');
  });

  it('includes safety stance', () => {
    const u = renderDayWatchUsage();
    expect(u).toContain('PAPER ONLY');
    expect(u).toContain('tradingExecuted: 0');
    expect(u).toContain('No wallet');
  });

  it('mentions default day-watch path under data/token-grab/day-watch', () => {
    expect(renderDayWatchUsage()).toContain('data/token-grab/day-watch');
  });

  it('--help does not start loops (pure string, no side effects)', () => {
    // Calling renderDayWatchUsage is pure — no loops started.
    const u = renderDayWatchUsage();
    expect(typeof u).toBe('string');
    expect(u.length).toBeGreaterThan(0);
  });
});

// ── renderDayReportUsage ────────────────────────────────────────────────────────────────

describe('renderDayReportUsage', () => {
  it('includes command name', () => {
    expect(renderDayReportUsage()).toContain('token:dex-day-report');
  });

  it('lists all verdict values', () => {
    const u = renderDayReportUsage();
    expect(u).toContain('MANUAL_REVIEW_READY');
    expect(u).toContain('FILTERS_WORKING');
    expect(u).toContain('NO_CLEAN_ENTRIES_YET');
    expect(u).toContain('NEED_MORE_DATA');
  });

  it('includes safety stance', () => {
    const u = renderDayReportUsage();
    expect(u).toContain('PAPER ONLY');
    expect(u).toContain('tradingExecuted: 0');
  });

  it('lists --day-log and --json flags', () => {
    const u = renderDayReportUsage();
    expect(u).toContain('--day-log');
    expect(u).toContain('--json');
  });

  it('--help does not start loops (pure string, no side effects)', () => {
    const u = renderDayReportUsage();
    expect(typeof u).toBe('string');
    expect(u.length).toBeGreaterThan(0);
  });
});

// ── determineDayVerdict ─────────────────────────────────────────────────────────────────

describe('determineDayVerdict', () => {
  it('returns MANUAL_REVIEW_READY when totalCurrentCyclePaperEntryEvents > 0', () => {
    expect(determineDayVerdict(1, 5, 2)).toBe('MANUAL_REVIEW_READY');
  });

  it('returns FILTERS_WORKING when winners and blocked but no current-cycle entries', () => {
    expect(determineDayVerdict(0, 3, 2)).toBe('FILTERS_WORKING');
  });

  it('returns NO_CLEAN_ENTRIES_YET when winners but no blocked and no current-cycle entries', () => {
    expect(determineDayVerdict(0, 3, 0)).toBe('NO_CLEAN_ENTRIES_YET');
  });

  it('returns NEED_MORE_DATA when no winners at all', () => {
    expect(determineDayVerdict(0, 0, 0)).toBe('NEED_MORE_DATA');
  });

  it('MANUAL_REVIEW_READY takes priority even if winners and blocked also present', () => {
    expect(determineDayVerdict(2, 5, 3)).toBe('MANUAL_REVIEW_READY');
  });
});

// ── appendDayWatchEntry + loadDayLog ────────────────────────────────────────────────────

describe('appendDayWatchEntry / loadDayLog', () => {
  it('appends one JSONL line per entry', () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, 'day-watch', 'dex-day-watch.jsonl');

    appendDayWatchEntry(makeEntry({ cycleNumber: 1 }), logPath);
    appendDayWatchEntry(makeEntry({ cycleNumber: 2 }), logPath);

    const raw = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[0]).cycleNumber).toBe(1);
    expect(JSON.parse(raw[1]).cycleNumber).toBe(2);
  });

  it('creates parent directories', () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, 'a', 'b', 'c', 'log.jsonl');
    appendDayWatchEntry(makeEntry(), logPath);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('round-trips through loadDayLog', () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, 'log.jsonl');
    const entry = makeEntry({ winners: 3, losers: 1, currentCyclePaperEntry: 2 });
    appendDayWatchEntry(entry, logPath);
    const loaded = loadDayLog(logPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].winners).toBe(3);
    expect(loaded[0].currentCyclePaperEntry).toBe(2);
  });

  it('loadDayLog returns [] for missing file', () => {
    expect(loadDayLog('/tmp/does-not-exist-ever.jsonl')).toEqual([]);
  });

  it('JSONL entries always contain safety fields', () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, 'log.jsonl');
    appendDayWatchEntry(makeEntry(), logPath);
    const [e] = loadDayLog(logPath);
    expect(e.tradingExecuted).toBe(0);
    expect(e.noRealTradeSent).toBe(true);
    expect(e.readOnly).toBe(true);
    expect(e.paperOnly).toBe(true);
  });

  it('day-watch path stays under data/token-grab/day-watch by default (default constant check)', () => {
    // Verify the documented default in renderDayWatchUsage
    expect(renderDayWatchUsage()).toContain('data/token-grab/day-watch/dex-day-watch.jsonl');
  });
});

// ── buildDayWatchCycleEntry ─────────────────────────────────────────────────────────────

describe('buildDayWatchCycleEntry', () => {
  it('copies basic runner stats', () => {
    const e = buildDayWatchCycleEntry(1, AT, makeCycleResult({ winners: 2, losers: 1, flat: 7 }), 5, 1.5, makePlanReport());
    expect(e.winners).toBe(2);
    expect(e.losers).toBe(1);
    expect(e.flat).toBe(7);
    expect(e.cycleNumber).toBe(1);
  });

  it('derives missing count', () => {
    const e = buildDayWatchCycleEntry(1, AT, makeCycleResult({ contractsWatched: 10, winners: 2, losers: 1, flat: 5 }), 0, 0, makePlanReport());
    expect(e.missing).toBe(2);
  });

  it('missing is never negative', () => {
    const e = buildDayWatchCycleEntry(1, AT, makeCycleResult({ contractsWatched: 3, winners: 2, losers: 1, flat: 1 }), 0, 0, makePlanReport());
    expect(e.missing).toBe(0);
  });

  it('copies journal stats', () => {
    const e = buildDayWatchCycleEntry(1, AT, makeCycleResult(), 12, 3.5, makePlanReport());
    expect(e.journalTotalSimulated).toBe(12);
    expect(e.journalFakePnl).toBe(3.5);
  });

  it('copies planner category counts', () => {
    const plan = makePlanReport({ currentCyclePaperEntry: 2, historicalJournalWinners: 3, blockedHistoryRisk: 1 });
    const e = buildDayWatchCycleEntry(1, AT, makeCycleResult(), 0, 0, plan);
    expect(e.currentCyclePaperEntry).toBe(2);
    expect(e.historicalJournalWinners).toBe(3);
    expect(e.blockedHistoryRisk).toBe(1);
  });

  it('always sets safety fields', () => {
    const e = buildDayWatchCycleEntry(1, AT, makeCycleResult(), 0, 0, makePlanReport());
    expect(e.tradingExecuted).toBe(0);
    expect(e.noRealTradeSent).toBe(true);
    expect(e.readOnly).toBe(true);
    expect(e.paperOnly).toBe(true);
  });

  it('sets finalRecommendation based on cycle data', () => {
    // No winners → NO_SIGNAL
    const e = buildDayWatchCycleEntry(1, AT, makeCycleResult({ winners: 0 }), 0, 0, makePlanReport({ currentCyclePaperEntry: 0 }));
    expect(e.finalRecommendation).toBe('NO_SIGNAL');
  });

  it('selects top current-cycle entries from plan', () => {
    const plan = makePlanReport({
      currentCyclePaperEntry: 1,
      plans: [{
        symbol: 'ALPHA', contract: SOL_A, recommendation: 'CURRENT_CYCLE_PAPER_ENTRY',
        isCurrentCycle: true, fakeEntrySize: 1, fakeStopLossPct: -20, fakeTakeProfitPct: 25,
        fakeRunnerTargetPct: 50, cancelConditions: [], reasons: [], historyRiskStatus: 'CLEAN',
        priceChangePct: 30, liquidityChangePct: 15, volumeLiquidityRatio: 0.4,
        tradingExecuted: 0, noRealTradeSent: true, readOnly: true, paperOnly: true,
      }],
    });
    const e = buildDayWatchCycleEntry(1, AT, makeCycleResult(), 0, 0, plan);
    expect(e.topCurrentCycleEntries).toHaveLength(1);
    expect(e.topCurrentCycleEntries[0].symbol).toBe('ALPHA');
  });

  it('selects top blocked movers sorted by price desc', () => {
    const plan = makePlanReport({
      blockedHistoryRisk: 2,
      plans: [
        {
          symbol: 'SLOW', contract: SOL_A, recommendation: 'BLOCKED_HISTORY_RISK',
          isCurrentCycle: false, fakeEntrySize: 1, fakeStopLossPct: -20, fakeTakeProfitPct: 25,
          fakeRunnerTargetPct: 50, cancelConditions: [], reasons: [],
          historyRiskStatus: 'BLOCKED', historyRiskReasons: ['loseCount >= 1'],
          priceChangePct: 20, liquidityChangePct: 10, volumeLiquidityRatio: 2.5,
          tradingExecuted: 0, noRealTradeSent: true, readOnly: true, paperOnly: true,
        },
        {
          symbol: 'FAST', contract: SOL_B, recommendation: 'BLOCKED_HISTORY_RISK',
          isCurrentCycle: false, fakeEntrySize: 1, fakeStopLossPct: -20, fakeTakeProfitPct: 25,
          fakeRunnerTargetPct: 50, cancelConditions: [], reasons: [],
          historyRiskStatus: 'BLOCKED', historyRiskReasons: ['avgVolumeLiquidityRatio > 1 (3.1)'],
          priceChangePct: 45, liquidityChangePct: 18, volumeLiquidityRatio: 3.1,
          tradingExecuted: 0, noRealTradeSent: true, readOnly: true, paperOnly: true,
        },
      ],
    });
    const e = buildDayWatchCycleEntry(1, AT, makeCycleResult(), 0, 0, plan);
    expect(e.topBlockedMovers[0].symbol).toBe('FAST');
    expect(e.topBlockedMovers[1].symbol).toBe('SLOW');
  });

  it('newestRunFile is basename only', () => {
    const e = buildDayWatchCycleEntry(1, AT, makeCycleResult({ savedRunPath: '/data/runs/run-abc.json' }), 0, 0, makePlanReport());
    expect(e.newestRunFile).toBe('run-abc.json');
  });
});

// ── buildDayReport ──────────────────────────────────────────────────────────────────────

describe('buildDayReport', () => {
  it('returns empty report with NEED_MORE_DATA for zero entries', () => {
    const r = buildDayReport([], AT);
    expect(r.cyclesRun).toBe(0);
    expect(r.verdict).toBe('NEED_MORE_DATA');
    expect(r.timeRange).toBeNull();
  });

  it('sums totals across entries', () => {
    const entries = [
      makeEntry({ contractsWatched: 10, winners: 1, losers: 0, flat: 9, runnerFakePnl: 0.5 }),
      makeEntry({ contractsWatched: 8,  winners: 2, losers: 1, flat: 5, runnerFakePnl: -0.2 }),
    ];
    const r = buildDayReport(entries, AT);
    expect(r.totalContractsWatched).toBe(18);
    expect(r.totalWinners).toBe(3);
    expect(r.totalLosers).toBe(1);
    expect(r.totalFlat).toBe(14);
    expect(r.totalRunnerFakePnl).toBeCloseTo(0.3);
  });

  it('uses latest entry journalFakePnl for latestJournalFakePnl', () => {
    const entries = [
      makeEntry({ journalFakePnl: 1.0 }),
      makeEntry({ journalFakePnl: 2.5 }),
    ];
    const r = buildDayReport(entries, AT);
    expect(r.latestJournalFakePnl).toBe(2.5);
  });

  it('counts cyclesWithCurrentCycleEntry', () => {
    const entries = [
      makeEntry({ currentCyclePaperEntry: 0 }),
      makeEntry({ currentCyclePaperEntry: 2 }),
      makeEntry({ currentCyclePaperEntry: 1 }),
    ];
    const r = buildDayReport(entries, AT);
    expect(r.totalCurrentCyclePaperEntryEvents).toBe(3);
    expect(r.cyclesWithCurrentCycleEntry).toBe(2);
  });

  it('always sets safety fields', () => {
    const r = buildDayReport([], AT);
    expect(r.tradingExecuted).toBe(0);
    expect(r.noRealTradeSent).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
  });

  it('sets timeRange from first to last entry', () => {
    const e1 = makeEntry({ generatedAt: '2026-06-09T10:00:00.000Z' });
    const e2 = makeEntry({ generatedAt: '2026-06-09T20:00:00.000Z' });
    const r = buildDayReport([e1, e2], AT);
    expect(r.timeRange?.from).toBe('2026-06-09T10:00:00.000Z');
    expect(r.timeRange?.to).toBe('2026-06-09T20:00:00.000Z');
  });

  it('identifies repeated blocked movers across cycles', () => {
    const blocked1 = { contract: SOL_A, symbol: 'ALPHA', priceChangePct: 30, liquidityChangePct: 15, volumeLiquidityRatio: 2.5, blockReasons: ['loseCount >= 1'] };
    const blocked2 = { contract: SOL_B, symbol: 'BETA', priceChangePct: 25, liquidityChangePct: 10, volumeLiquidityRatio: 1.8, blockReasons: ['avgVLR > 1'] };

    const entries = [
      makeEntry({ topBlockedMovers: [blocked1, blocked2] }),
      makeEntry({ topBlockedMovers: [blocked1] }), // SOL_A appears again
    ];
    const r = buildDayReport(entries, AT);
    expect(r.repeatedBlockedMovers).toHaveLength(1);
    expect(r.repeatedBlockedMovers[0].contract).toBe(SOL_A);
    expect(r.repeatedBlockedMovers[0].appearedCount).toBe(2);
  });

  it('does not include single-appearance blocked movers in repeated list', () => {
    const entries = [makeEntry({ topBlockedMovers: [{ contract: SOL_A, symbol: 'ALPHA', priceChangePct: 30, liquidityChangePct: 15, volumeLiquidityRatio: 2.0, blockReasons: ['loseCount'] }] })];
    const r = buildDayReport(entries, AT);
    expect(r.repeatedBlockedMovers).toHaveLength(0);
  });

  it('dedupes topBlockedMovers by contract keeping highest priceChangePct', () => {
    const older = { contract: SOL_A, symbol: 'ALPHA', priceChangePct: 20, liquidityChangePct: 10, volumeLiquidityRatio: 2.0, blockReasons: ['a'] };
    const newer = { contract: SOL_A, symbol: 'ALPHA', priceChangePct: 40, liquidityChangePct: 20, volumeLiquidityRatio: 2.5, blockReasons: ['b'] };
    const entries = [makeEntry({ topBlockedMovers: [older] }), makeEntry({ topBlockedMovers: [newer] })];
    const r = buildDayReport(entries, AT);
    expect(r.topBlockedMovers).toHaveLength(1);
    expect(r.topBlockedMovers[0].priceChangePct).toBe(40);
  });

  it('topCurrentCycleEntries come from latest cycle that had any', () => {
    const entry: TopEntry = { symbol: 'WIN', contract: SOL_A, priceChangePct: 30, liquidityChangePct: 15, volumeLiquidityRatio: 0.4 };
    const entries = [
      makeEntry({ topCurrentCycleEntries: [entry] }),
      makeEntry({ topCurrentCycleEntries: [] }),
    ];
    const r = buildDayReport(entries, AT);
    expect(r.topCurrentCycleEntries).toHaveLength(1);
    expect(r.topCurrentCycleEntries[0].symbol).toBe('WIN');
  });

  it('verdict: NEED_MORE_DATA when no winners', () => {
    expect(buildDayReport([makeEntry({ winners: 0 })], AT).verdict).toBe('NEED_MORE_DATA');
  });

  it('verdict: NO_CLEAN_ENTRIES_YET when winners but no blocked', () => {
    expect(buildDayReport([makeEntry({ winners: 2, blockedHistoryRisk: 0 })], AT).verdict).toBe('NO_CLEAN_ENTRIES_YET');
  });

  it('verdict: FILTERS_WORKING when winners and blocked', () => {
    expect(buildDayReport([makeEntry({ winners: 2, blockedHistoryRisk: 1 })], AT).verdict).toBe('FILTERS_WORKING');
  });

  it('verdict: MANUAL_REVIEW_READY when currentCyclePaperEntry > 0', () => {
    expect(buildDayReport([makeEntry({ currentCyclePaperEntry: 1, winners: 1, blockedHistoryRisk: 0 })], AT).verdict).toBe('MANUAL_REVIEW_READY');
  });
});

// ── renderDayReport ─────────────────────────────────────────────────────────────────────

describe('renderDayReport', () => {
  function makeReport(overrides: Partial<DayReport> = {}): DayReport {
    return {
      generatedAt: AT,
      cyclesRun: 3,
      timeRange: { from: '2026-06-09T10:00:00.000Z', to: '2026-06-09T12:00:00.000Z' },
      totalContractsWatched: 30,
      totalWinners: 2,
      totalLosers: 1,
      totalFlat: 27,
      totalMissing: 0,
      totalRunnerCandidateTrades: 3,
      totalRunnerFakePnl: 0.5,
      latestJournalFakePnl: 1.2,
      totalCurrentCyclePaperEntryEvents: 0,
      cyclesWithCurrentCycleEntry: 0,
      repeatedBlockedMovers: [],
      topBlockedMovers: [],
      topCurrentCycleEntries: [],
      verdict: 'NEED_MORE_DATA',
      readOnly: true,
      paperOnly: true,
      tradingExecuted: 0,
      noRealTradeSent: true,
      ...overrides,
    };
  }

  it('includes safety banner', () => {
    const out = renderDayReport(makeReport());
    expect(out).toContain('PAPER ONLY');
    expect(out).toContain('NO REAL TRADE SENT');
    expect(out).toContain('tradingExecuted: 0');
    expect(out).toContain('No wallet');
  });

  it('includes verdict', () => {
    expect(renderDayReport(makeReport({ verdict: 'FILTERS_WORKING' }))).toContain('FILTERS_WORKING');
    expect(renderDayReport(makeReport({ verdict: 'MANUAL_REVIEW_READY' }))).toContain('MANUAL_REVIEW_READY');
  });

  it('includes cycle count and totals', () => {
    const out = renderDayReport(makeReport());
    expect(out).toContain('3');
    expect(out).toContain('30');
  });

  it('shows repeated blocked movers section', () => {
    const out = renderDayReport(makeReport({
      repeatedBlockedMovers: [{ contract: SOL_A, symbol: 'JEFF', appearedCount: 3, blockReasons: ['loseCount >= 1'] }],
    }));
    expect(out).toContain('$JEFF');
    expect(out).toContain('3x');
  });

  it('shows top blocked movers section', () => {
    const out = renderDayReport(makeReport({
      topBlockedMovers: [{
        contract: SOL_A, symbol: 'BLOCKER',
        priceChangePct: 35, liquidityChangePct: 12, volumeLiquidityRatio: 2.1,
        blockReasons: ['avgVolumeLiquidityRatio > 1 (2.1)'],
      }],
    }));
    expect(out).toContain('$BLOCKER');
    expect(out).toContain('+35.0%');
    expect(out).toContain('avgVolumeLiquidityRatio');
  });

  it('shows top current-cycle entries section', () => {
    const out = renderDayReport(makeReport({
      topCurrentCycleEntries: [{
        symbol: 'WINNER', contract: SOL_A,
        priceChangePct: 28, liquidityChangePct: 14, volumeLiquidityRatio: 0.3,
      }],
      totalCurrentCyclePaperEntryEvents: 1,
    }));
    expect(out).toContain('$WINNER');
    expect(out).toContain('+28.0%');
  });

  it('does not mention live trading concepts', () => {
    const out = renderDayReport(makeReport());
    expect(out).not.toContain('txHash');
    expect(out).not.toContain('LIVE_EXECUTED');
    expect(out).not.toContain('privateKey');
    expect(out).not.toContain('walletAddress');
  });

  it('includes verdict description for each verdict type', () => {
    const verdicts: DayVerdict[] = ['MANUAL_REVIEW_READY', 'FILTERS_WORKING', 'NO_CLEAN_ENTRIES_YET', 'NEED_MORE_DATA'];
    for (const v of verdicts) {
      const out = renderDayReport(makeReport({ verdict: v }));
      expect(out).toContain(v);
    }
  });
});

// ── runDexDayWatch integration (fully mocked — no real waits) ────────────────────────────

describe('runDexDayWatch', () => {
  function makeEndpointFetcher(): import('../src/token-grab/dexPaperRunner').EndpointFetcher {
    return async (): Promise<DexEndpointResult[]> => [
      {
        endpoint: 'latest_profiles',
        fetched: 1,
        items: [{ url: `https://dexscreener.com/solana/${SOL_A}`, chainId: 'solana', tokenAddress: SOL_A, header: 'ALPHA' }],
      },
    ];
  }

  function makeFlatWatchFetch(): typeof fetch {
    let call = 0;
    return (async () => {
      call += 1;
      const isEntry = call === 1;
      return new Response(JSON.stringify({
        pairs: [{
          chainId: 'solana', pairAddress: 'PAIR1',
          url: 'https://dexscreener.com/solana/PAIR1',
          baseToken: { address: SOL_A, symbol: 'ALPHA' },
          priceUsd: isEntry ? '1' : '1.02',
          liquidity: { usd: isEntry ? 10000 : 10100 },
          volume: { h1: 200 },
        }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  function baseOpts(dir: string, overrides: Partial<DayWatchOptions> = {}): DayWatchOptions {
    return {
      dexConfigPath: writeConfig(dir),
      signalsOut: path.join(dir, 'presignals.dex.json'),
      runsDir: path.join(dir, 'runs'),
      journalOut: path.join(dir, 'journal.json'),
      plannerOut: path.join(dir, 'plan.json'),
      dayLogPath: path.join(dir, 'day-watch', 'dex-day-watch.jsonl'),
      fakeBankroll: 20,
      positionSize: 1,
      cycles: 1,
      minutes: 1,
      intervalSeconds: 30,
      sleepBetweenCyclesMs: 0,
      endpointFetcher: makeEndpointFetcher(),
      watchFetchImpl: makeFlatWatchFetch(),
      sleepImpl: async () => {},
      nowFn: () => new Date('2026-06-09T10:00:00.000Z'),
      log: () => {},
      ...overrides,
    };
  }

  it('writes JSONL day log', async () => {
    const dir = makeTempDir();
    const opts = baseOpts(dir);
    await runDexDayWatch(opts);
    expect(fs.existsSync(opts.dayLogPath)).toBe(true);
  });

  it('appends one entry per cycle', async () => {
    const dir = makeTempDir();
    let fetchCall = 0;
    const twoFlatFetch = (async () => {
      fetchCall += 1;
      const isEntry = fetchCall % 2 === 1;
      return new Response(JSON.stringify({
        pairs: [{
          chainId: 'solana', pairAddress: 'PAIR1',
          url: 'https://dexscreener.com/solana/PAIR1',
          baseToken: { address: SOL_A, symbol: 'ALPHA' },
          priceUsd: isEntry ? '1' : '1.01',
          liquidity: { usd: isEntry ? 10000 : 10010 },
          volume: { h1: 100 },
        }],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const opts = baseOpts(dir, { cycles: 2, watchFetchImpl: twoFlatFetch });
    const result = await runDexDayWatch(opts);
    expect(result.cyclesRun).toBe(2);
    const entries = loadDayLog(opts.dayLogPath);
    expect(entries).toHaveLength(2);
  });

  it('returns cyclesRun and dayLogPath', async () => {
    const dir = makeTempDir();
    const opts = baseOpts(dir);
    const result = await runDexDayWatch(opts);
    expect(result.cyclesRun).toBe(1);
    expect(result.dayLogPath).toBe(opts.dayLogPath);
  });

  it('JSONL entries always contain safety fields', async () => {
    const dir = makeTempDir();
    const opts = baseOpts(dir);
    await runDexDayWatch(opts);
    const [entry] = loadDayLog(opts.dayLogPath);
    expect(entry.tradingExecuted).toBe(0);
    expect(entry.noRealTradeSent).toBe(true);
    expect(entry.readOnly).toBe(true);
    expect(entry.paperOnly).toBe(true);
  });

  it('does not call sleepImpl after the last cycle', async () => {
    const dir = makeTempDir();
    let sleepCalls = 0;
    const opts = baseOpts(dir, { cycles: 1, sleepBetweenCyclesMs: 999, sleepImpl: async () => { sleepCalls++; } });
    await runDexDayWatch(opts);
    expect(sleepCalls).toBe(0);
  });

  it('calls sleepImpl between cycles but not after the last', async () => {
    const dir = makeTempDir();
    let sleepCalls = 0;
    let fetchCall2 = 0;
    const twoFlatFetch2 = (async () => {
      fetchCall2 += 1;
      const isEntry = fetchCall2 % 2 === 1;
      return new Response(JSON.stringify({
        pairs: [{
          chainId: 'solana', pairAddress: 'PAIR1',
          url: 'https://dexscreener.com/solana/PAIR1',
          baseToken: { address: SOL_A, symbol: 'ALPHA' },
          priceUsd: isEntry ? '1' : '1.01',
          liquidity: { usd: isEntry ? 10000 : 10010 },
          volume: { h1: 100 },
        }],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const opts = baseOpts(dir, {
      cycles: 2,
      sleepBetweenCyclesMs: 999,
      sleepImpl: async () => { sleepCalls++; },
      watchFetchImpl: twoFlatFetch2,
    });
    await runDexDayWatch(opts);
    expect(sleepCalls).toBe(1);
  });

  it('respects stopSignal to exit early', async () => {
    const dir = makeTempDir();
    const stopSignal = { stopped: false };
    let fetchCall3 = 0;
    const twoFlatFetch3 = (async () => {
      fetchCall3 += 1;
      const isEntry = fetchCall3 % 2 === 1;
      return new Response(JSON.stringify({
        pairs: [{
          chainId: 'solana', pairAddress: 'PAIR1',
          url: 'https://dexscreener.com/solana/PAIR1',
          baseToken: { address: SOL_A, symbol: 'ALPHA' },
          priceUsd: isEntry ? '1' : '1.01',
          liquidity: { usd: isEntry ? 10000 : 10010 },
          volume: { h1: 100 },
        }],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const opts = baseOpts(dir, {
      cycles: 3,
      sleepBetweenCyclesMs: 1, // non-zero so sleepImpl is called and can trigger the stop
      stopSignal,
      watchFetchImpl: twoFlatFetch3,
      sleepImpl: async () => { stopSignal.stopped = true; },
    });
    const result = await runDexDayWatch(opts);
    expect(result.cyclesRun).toBeLessThan(3);
  });
});
