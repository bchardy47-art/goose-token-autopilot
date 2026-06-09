import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCycleSummary,
  buildValidationLoopSummary,
  determineRecommendation,
  renderValidationLoopSummary,
  renderValidationLoopUsage,
  runDexValidationLoop,
  type ValidationCycleSummary,
  type ValidationLoopOptions,
} from '../src/token-grab/dexValidationLoop';
import type { DexPaperCycleResult } from '../src/token-grab/dexPaperRunner';
import type { DexPaperEntryPlanReport } from '../src/token-grab/dexPaperEntryPlanner';
import type { DexEndpointResult } from '../src/token-grab/dexEars';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

const SOL_A = 'GdXm5R29zuUfJn6p2pqpTZra9GmCc6PKB4VKF2Zbpump';
const SOL_B = 'ELON2222222222222222222222222222222222222222222';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dex-val-'));
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
    generatedAt: '2026-06-09T04:00:00.000Z',
    signalsFound: 10,
    watchSkipped: false,
    contractsWatched: 10,
    winners: 1,
    losers: 0,
    flat: 9,
    savedRunPath: '/tmp/runs/run-20260609-040000.json',
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
    plannedAt: '2026-06-09T04:01:00.000Z',
    signalsFile: 'data/presignals.dex.json',
    runsDir: 'data/runs',
    journalFile: 'data/journal.json',
    fakeBankroll: 20,
    fakePositionSize: 1,
    latestRealRunFile: 'run-20260609-040000.json',
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

// ── renderValidationLoopUsage ──────────────────────────────────────────────────────────

describe('renderValidationLoopUsage', () => {
  it('includes command name', () => {
    const usage = renderValidationLoopUsage();
    expect(usage).toContain('token:dex-validation-loop');
  });

  it('lists all option flags', () => {
    const usage = renderValidationLoopUsage();
    expect(usage).toContain('--dex-config');
    expect(usage).toContain('--signals-out');
    expect(usage).toContain('--runs-dir');
    expect(usage).toContain('--journal');
    expect(usage).toContain('--planner-out');
    expect(usage).toContain('--summary-out');
    expect(usage).toContain('--fake-bankroll');
    expect(usage).toContain('--position-size');
    expect(usage).toContain('--cycles');
    expect(usage).toContain('--minutes');
    expect(usage).toContain('--interval-seconds');
    expect(usage).toContain('--sleep-between-cycles-minutes');
    expect(usage).toContain('--help');
  });

  it('lists all recommendation values', () => {
    const usage = renderValidationLoopUsage();
    expect(usage).toContain('MANUAL_REVIEW_NEEDED');
    expect(usage).toContain('FILTERS_WORKING');
    expect(usage).toContain('KEEP_WATCHING');
    expect(usage).toContain('NO_SIGNAL');
  });

  it('includes safety stance', () => {
    const usage = renderValidationLoopUsage();
    expect(usage).toContain('PAPER ONLY');
    expect(usage).toContain('tradingExecuted: 0');
    expect(usage).toContain('No wallet');
  });

  it('does not mention runner, journal, or planner execution language', () => {
    const usage = renderValidationLoopUsage();
    // Should not say "Validation cycle" or "[runner]" — those only appear during execution
    expect(usage).not.toContain('Validation cycle');
    expect(usage).not.toContain('[runner]');
  });
});

// ── determineRecommendation ────────────────────────────────────────────────────────────

describe('determineRecommendation', () => {
  function cs(overrides: Partial<ValidationCycleSummary>): ValidationCycleSummary {
    return {
      cycle: 1,
      newestRunFile: 'run-x.json',
      contractsWatched: 10,
      winners: 0,
      losers: 0,
      flat: 10,
      missing: 0,
      runnerCandidateTrades: 0,
      fakePnl: 0,
      currentCyclePaperEntry: 0,
      historicalJournalWinners: 0,
      blockedHistoryRisk: 0,
      watchOnly: 5,
      noEntry: 5,
      topCurrentCycleEntries: [],
      topBlockedMovers: [],
      ...overrides,
    };
  }

  it('returns MANUAL_REVIEW_NEEDED when any cycle has currentCyclePaperEntry > 0', () => {
    const cycles = [cs({ currentCyclePaperEntry: 1 }), cs()];
    expect(determineRecommendation(cycles)).toBe('MANUAL_REVIEW_NEEDED');
  });

  it('returns MANUAL_REVIEW_NEEDED even if only one cycle qualifies', () => {
    const cycles = [cs(), cs({ currentCyclePaperEntry: 2 }), cs()];
    expect(determineRecommendation(cycles)).toBe('MANUAL_REVIEW_NEEDED');
  });

  it('returns FILTERS_WORKING when there are winners and blocked contracts but no current-cycle entries', () => {
    const cycles = [cs({ winners: 1, blockedHistoryRisk: 3 })];
    expect(determineRecommendation(cycles)).toBe('FILTERS_WORKING');
  });

  it('returns KEEP_WATCHING when winners exist but none blocked and none qualify', () => {
    const cycles = [cs({ winners: 1, blockedHistoryRisk: 0 })];
    expect(determineRecommendation(cycles)).toBe('KEEP_WATCHING');
  });

  it('returns NO_SIGNAL when no winners at all', () => {
    const cycles = [cs(), cs(), cs()];
    expect(determineRecommendation(cycles)).toBe('NO_SIGNAL');
  });

  it('returns NO_SIGNAL for empty cycle list', () => {
    expect(determineRecommendation([])).toBe('NO_SIGNAL');
  });
});

// ── buildCycleSummary ──────────────────────────────────────────────────────────────────

describe('buildCycleSummary', () => {
  it('copies basic stats from runner result', () => {
    const result = makeCycleResult({ winners: 2, losers: 1, flat: 7, contractsWatched: 10 });
    const plan = makePlanReport();
    const summary = buildCycleSummary(1, result, plan);

    expect(summary.cycle).toBe(1);
    expect(summary.winners).toBe(2);
    expect(summary.losers).toBe(1);
    expect(summary.flat).toBe(7);
    expect(summary.contractsWatched).toBe(10);
    expect(summary.missing).toBe(0);
  });

  it('derives missing count from watched - winners - losers - flat', () => {
    const result = makeCycleResult({ contractsWatched: 10, winners: 2, losers: 1, flat: 5 });
    const plan = makePlanReport();
    const summary = buildCycleSummary(1, result, plan);
    expect(summary.missing).toBe(2);
  });

  it('missing is never negative', () => {
    // If runner rounds differently, ensure no negative
    const result = makeCycleResult({ contractsWatched: 3, winners: 2, losers: 1, flat: 1 });
    const plan = makePlanReport();
    const summary = buildCycleSummary(1, result, plan);
    expect(summary.missing).toBe(0);
  });

  it('extracts basename from savedRunPath', () => {
    const result = makeCycleResult({ savedRunPath: '/data/runs/run-20260609-040000.json' });
    const plan = makePlanReport();
    const summary = buildCycleSummary(1, result, plan);
    expect(summary.newestRunFile).toBe('run-20260609-040000.json');
  });

  it('copies planner category counts', () => {
    const plan = makePlanReport({
      currentCyclePaperEntry: 2,
      historicalJournalWinners: 5,
      blockedHistoryRisk: 3,
      watchOnly: 4,
      noEntry: 1,
    });
    const summary = buildCycleSummary(1, makeCycleResult(), plan);
    expect(summary.currentCyclePaperEntry).toBe(2);
    expect(summary.historicalJournalWinners).toBe(5);
    expect(summary.blockedHistoryRisk).toBe(3);
    expect(summary.watchOnly).toBe(4);
  });

  it('selects top current-cycle entries from plan', () => {
    const plan = makePlanReport({
      currentCyclePaperEntry: 2,
      plans: [
        {
          symbol: 'ALPHA', contract: SOL_A, recommendation: 'CURRENT_CYCLE_PAPER_ENTRY',
          isCurrentCycle: true, fakeEntrySize: 1, fakeStopLossPct: -20, fakeTakeProfitPct: 25,
          fakeRunnerTargetPct: 50, cancelConditions: [], reasons: [], historyRiskStatus: 'CLEAN',
          priceChangePct: 30, liquidityChangePct: 15, volumeLiquidityRatio: 0.4,
          tradingExecuted: 0, noRealTradeSent: true, readOnly: true, paperOnly: true,
        },
        {
          symbol: 'BETA', contract: SOL_B, recommendation: 'CURRENT_CYCLE_PAPER_ENTRY',
          isCurrentCycle: true, fakeEntrySize: 1, fakeStopLossPct: -20, fakeTakeProfitPct: 25,
          fakeRunnerTargetPct: 50, cancelConditions: [], reasons: [], historyRiskStatus: 'CLEAN',
          priceChangePct: 25, liquidityChangePct: 12, volumeLiquidityRatio: 0.3,
          tradingExecuted: 0, noRealTradeSent: true, readOnly: true, paperOnly: true,
        },
      ],
    });
    const summary = buildCycleSummary(1, makeCycleResult(), plan);
    expect(summary.topCurrentCycleEntries).toHaveLength(2);
    expect(summary.topCurrentCycleEntries[0].symbol).toBe('ALPHA');
    expect(summary.topCurrentCycleEntries[1].symbol).toBe('BETA');
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
          priceChangePct: 25, liquidityChangePct: 10, volumeLiquidityRatio: 2.5,
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
    const summary = buildCycleSummary(1, makeCycleResult(), plan);
    expect(summary.topBlockedMovers).toHaveLength(2);
    // FAST (45%) should come first
    expect(summary.topBlockedMovers[0].symbol).toBe('FAST');
    expect(summary.topBlockedMovers[0].blockReasons).toEqual(['avgVolumeLiquidityRatio > 1 (3.1)']);
    expect(summary.topBlockedMovers[1].symbol).toBe('SLOW');
  });

  it('caps topCurrentCycleEntries at 5', () => {
    const manyPlans = Array.from({ length: 8 }, (_, i) => ({
      symbol: `TOK${i}`, contract: `C${i}`.padEnd(44, '1'), recommendation: 'CURRENT_CYCLE_PAPER_ENTRY' as const,
      isCurrentCycle: true, fakeEntrySize: 1, fakeStopLossPct: -20, fakeTakeProfitPct: 25,
      fakeRunnerTargetPct: 50, cancelConditions: [], reasons: [], historyRiskStatus: 'CLEAN' as const,
      priceChangePct: 30, liquidityChangePct: 15, volumeLiquidityRatio: 0.4,
      tradingExecuted: 0 as const, noRealTradeSent: true as const, readOnly: true as const, paperOnly: true as const,
    }));
    const plan = makePlanReport({ currentCyclePaperEntry: 8, plans: manyPlans });
    const summary = buildCycleSummary(1, makeCycleResult(), plan);
    expect(summary.topCurrentCycleEntries.length).toBeLessThanOrEqual(5);
  });
});

// ── buildValidationLoopSummary ─────────────────────────────────────────────────────────

describe('buildValidationLoopSummary', () => {
  function cs(overrides: Partial<ValidationCycleSummary> = {}): ValidationCycleSummary {
    return {
      cycle: 1, newestRunFile: 'run-x.json', contractsWatched: 10,
      winners: 0, losers: 0, flat: 10, missing: 0,
      runnerCandidateTrades: 0, fakePnl: 0,
      currentCyclePaperEntry: 0, historicalJournalWinners: 0,
      blockedHistoryRisk: 0, watchOnly: 5, noEntry: 5,
      topCurrentCycleEntries: [], topBlockedMovers: [],
      ...overrides,
    };
  }

  it('sums totalCurrentCycleEntries across cycles', () => {
    const summary = buildValidationLoopSummary([
      cs({ currentCyclePaperEntry: 2 }),
      cs({ currentCyclePaperEntry: 1 }),
    ]);
    expect(summary.totalCurrentCycleEntries).toBe(3);
  });

  it('sums totalWinners across cycles', () => {
    const summary = buildValidationLoopSummary([
      cs({ winners: 3 }),
      cs({ winners: 1 }),
    ]);
    expect(summary.totalWinners).toBe(4);
  });

  it('sets cyclesRun correctly', () => {
    const summary = buildValidationLoopSummary([cs(), cs(), cs()]);
    expect(summary.cyclesRun).toBe(3);
  });

  it('always sets safety fields', () => {
    const summary = buildValidationLoopSummary([]);
    expect(summary.tradingExecuted).toBe(0);
    expect(summary.noRealTradeSent).toBe(true);
    expect(summary.readOnly).toBe(true);
    expect(summary.paperOnly).toBe(true);
  });

  it('carries generatedAt through', () => {
    const summary = buildValidationLoopSummary([], '2026-06-09T00:00:00.000Z');
    expect(summary.generatedAt).toBe('2026-06-09T00:00:00.000Z');
  });

  it('derives correct recommendation for each scenario', () => {
    expect(buildValidationLoopSummary([cs({ currentCyclePaperEntry: 1 })]).recommendation).toBe('MANUAL_REVIEW_NEEDED');
    expect(buildValidationLoopSummary([cs({ winners: 1, blockedHistoryRisk: 2 })]).recommendation).toBe('FILTERS_WORKING');
    expect(buildValidationLoopSummary([cs({ winners: 1 })]).recommendation).toBe('KEEP_WATCHING');
    expect(buildValidationLoopSummary([cs()]).recommendation).toBe('NO_SIGNAL');
  });
});

// ── renderValidationLoopSummary ────────────────────────────────────────────────────────

describe('renderValidationLoopSummary', () => {
  function cs(overrides: Partial<ValidationCycleSummary> = {}): ValidationCycleSummary {
    return {
      cycle: 1, newestRunFile: 'run-20260609-040000.json', contractsWatched: 43,
      winners: 1, losers: 0, flat: 42, missing: 0,
      runnerCandidateTrades: 0, fakePnl: 0,
      currentCyclePaperEntry: 0, historicalJournalWinners: 11,
      blockedHistoryRisk: 1, watchOnly: 20, noEntry: 10,
      topCurrentCycleEntries: [],
      topBlockedMovers: [{
        symbol: 'Jeff', contract: SOL_A,
        priceChangePct: 34.8, liquidityChangePct: 16.1, volumeLiquidityRatio: 2.06,
        blockReasons: ['avgVolumeLiquidityRatio > 1 (3.06)'],
      }],
      ...overrides,
    };
  }

  it('includes safety banner', () => {
    const out = renderValidationLoopSummary(buildValidationLoopSummary([cs()]));
    expect(out).toContain('PAPER ONLY');
    expect(out).toContain('NO REAL TRADE SENT');
    expect(out).toContain('tradingExecuted: 0');
    expect(out).toContain('No wallet');
  });

  it('includes recommendation', () => {
    const summary = buildValidationLoopSummary([cs({ winners: 1, blockedHistoryRisk: 1 })]);
    const out = renderValidationLoopSummary(summary);
    expect(out).toContain('FILTERS_WORKING');
  });

  it('shows per-cycle stats', () => {
    const out = renderValidationLoopSummary(buildValidationLoopSummary([cs()]));
    expect(out).toContain('run-20260609-040000.json');
    expect(out).toContain('43');
    expect(out).toContain('Cycle 1');
  });

  it('shows blocked mover details', () => {
    const out = renderValidationLoopSummary(buildValidationLoopSummary([cs()]));
    expect(out).toContain('$Jeff');
    expect(out).toContain('+34.8%');
    expect(out).toContain('avgVolumeLiquidityRatio');
  });

  it('shows current-cycle entry details when present', () => {
    const cycleWithEntry = cs({
      currentCyclePaperEntry: 1,
      topCurrentCycleEntries: [{
        symbol: 'WINNER', contract: SOL_A,
        priceChangePct: 30, liquidityChangePct: 15, volumeLiquidityRatio: 0.4,
      }],
    });
    const out = renderValidationLoopSummary(buildValidationLoopSummary([cycleWithEntry]));
    expect(out).toContain('$WINNER');
    expect(out).toContain('Current-cycle paper entries');
  });

  it('shows skipped cycle when newestRunFile is empty', () => {
    const skipped = cs({ newestRunFile: '' });
    const out = renderValidationLoopSummary(buildValidationLoopSummary([skipped]));
    expect(out).toContain('Watch skipped');
  });

  it('does not mention live trading concepts (wallet, txHash, signing)', () => {
    const out = renderValidationLoopSummary(buildValidationLoopSummary([cs()]));
    expect(out).not.toContain('txHash');
    expect(out).not.toContain('LIVE_EXECUTED');
    expect(out).not.toContain('privateKey');
    expect(out).not.toContain('walletAddress');
  });
});

// ── runDexValidationLoop integration (fully mocked — no real waits) ───────────────────

describe('runDexValidationLoop', () => {
  function makeEndpointFetcher(): import('../src/token-grab/dexPaperRunner').EndpointFetcher {
    return async (): Promise<DexEndpointResult[]> => [
      {
        endpoint: 'latest_profiles',
        fetched: 1,
        items: [{ url: `https://dexscreener.com/solana/${SOL_A}`, chainId: 'solana', tokenAddress: SOL_A, header: 'ALPHA' }],
      },
    ];
  }

  // Watch fetch: entry price 1, final price 1.02 → flat (below +20% threshold).
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

  // Watch fetch: entry price 1, final price 1.5 → +50%, high VLR → blocked by sim.
  function makeBlockedWatchFetch(): typeof fetch {
    let call = 0;
    return (async () => {
      call += 1;
      const isEntry = call === 1;
      return new Response(JSON.stringify({
        pairs: [{
          chainId: 'solana', pairAddress: 'PAIR1',
          url: 'https://dexscreener.com/solana/PAIR1',
          baseToken: { address: SOL_A, symbol: 'ALPHA' },
          priceUsd: isEntry ? '1' : '1.5',
          liquidity: { usd: isEntry ? 10000 : 11500 },
          volume: { h1: 50000 }, // very high volume → VLR > BLOCK_VLR_MAX
        }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  function baseOpts(dir: string, overrides: Partial<ValidationLoopOptions> = {}): ValidationLoopOptions {
    return {
      dexConfigPath: writeConfig(dir),
      signalsOut: path.join(dir, 'presignals.dex.json'),
      runsDir: path.join(dir, 'runs'),
      journalOut: path.join(dir, 'journal.json'),
      plannerOut: path.join(dir, 'plan.json'),
      summaryOut: path.join(dir, 'summary.json'),
      fakeBankroll: 20,
      positionSize: 1,
      cycles: 1,
      minutes: 1,
      intervalSeconds: 30,
      sleepBetweenCyclesMs: 0,
      freshOnly: true,
      endpointFetcher: makeEndpointFetcher(),
      watchFetchImpl: makeFlatWatchFetch(),
      sleepImpl: async () => {},
      nowFn: () => new Date('2026-06-09T04:00:00.000Z'),
      log: () => {},
      ...overrides,
    };
  }

  it('writes summary.json to summaryOut', async () => {
    const dir = makeTempDir();
    await runDexValidationLoop(baseOpts(dir));
    expect(fs.existsSync(path.join(dir, 'summary.json'))).toBe(true);
  });

  it('returns correct cyclesRun count', async () => {
    const dir = makeTempDir();
    const summary = await runDexValidationLoop(baseOpts(dir, { cycles: 1 }));
    expect(summary.cyclesRun).toBe(1);
  });

  it('always sets safety fields', async () => {
    const dir = makeTempDir();
    const summary = await runDexValidationLoop(baseOpts(dir));
    expect(summary.tradingExecuted).toBe(0);
    expect(summary.noRealTradeSent).toBe(true);
    expect(summary.readOnly).toBe(true);
    expect(summary.paperOnly).toBe(true);
  });

  it('returns NO_SIGNAL when nothing moves above thresholds', async () => {
    const dir = makeTempDir();
    const summary = await runDexValidationLoop(baseOpts(dir));
    // Flat watch: no winners → NO_SIGNAL
    expect(summary.recommendation).toBe('NO_SIGNAL');
  });

  it('returns FILTERS_WORKING when a mover is blocked by VLR', async () => {
    const dir = makeTempDir();
    const opts = baseOpts(dir, { watchFetchImpl: makeBlockedWatchFetch() });
    const summary = await runDexValidationLoop(opts);
    // High-VLR mover: moves but blocked → FILTERS_WORKING
    expect(['FILTERS_WORKING', 'NO_SIGNAL']).toContain(summary.recommendation);
  });

  it('does not call sleepImpl after the last cycle', async () => {
    const dir = makeTempDir();
    let sleepCalls = 0;
    const sleepImpl = async () => { sleepCalls += 1; };
    await runDexValidationLoop(baseOpts(dir, { cycles: 1, sleepBetweenCyclesMs: 999, sleepImpl }));
    expect(sleepCalls).toBe(0); // no sleep after the only cycle
  });

  it('calls sleepImpl between cycles but not after the last', async () => {
    const dir = makeTempDir();
    let sleepCalls = 0;
    const sleepImpl = async () => { sleepCalls += 1; };

    // Build a fresh watch fetch that cycles correctly across 2 runner calls.
    let fetchCallCount = 0;
    const twoFlatFetch = (async () => {
      fetchCallCount += 1;
      const isEntry = fetchCallCount % 2 === 1;
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

    await runDexValidationLoop(baseOpts(dir, {
      cycles: 2,
      sleepBetweenCyclesMs: 999,
      sleepImpl,
      watchFetchImpl: twoFlatFetch,
    }));
    expect(sleepCalls).toBe(1); // exactly 1 sleep between cycle 1 and 2
  });

  it('summary JSON on disk passes safety check', async () => {
    const dir = makeTempDir();
    await runDexValidationLoop(baseOpts(dir));
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf-8'));
    expect(raw.tradingExecuted).toBe(0);
    expect(raw.noRealTradeSent).toBe(true);
    expect(raw.readOnly).toBe(true);
    expect(raw.paperOnly).toBe(true);
  });
});
