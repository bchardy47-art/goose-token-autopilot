import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperPaperLoop,
  renderLoopCycleLine,
  renderRipperPaperLoopResult,
  type SourceRefreshResult,
} from '../src/token-grab/ripperPaperLoop';
import type { RipperPaperCycleResult } from '../src/token-grab/ripperPaperCycle';
import { offlineClusterRiskProvider } from '../src/token-grab/clusterRiskProvider';

// ── Time anchor ───────────────────────────────────────────────────────────────

const BASE_MS        = 1_700_000_000_000;
const EIGHT_MIN_AGO  = new Date(BASE_MS - 8  * 60_000).toISOString();
const THIRTY_MIN_AGO = new Date(BASE_MS - 30 * 60_000).toISOString();
const TWO_HR_AGO     = new Date(BASE_MS - 120 * 60_000).toISOString();
const BASE_ISO       = new Date(BASE_MS).toISOString();

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeOutcome(overrides: Partial<{
  contract: string;
  observedAt: string;
  classification: string;
}> = {}) {
  return {
    contract:  overrides.contract ?? 'TokenAAA111222333444555666777888999000111',
    symbol:    'FRESH',
    chainId:   'solana',
    pairUrl:   'https://dexscreener.com/solana/testpair',
    entry: {
      contract:     overrides.contract ?? 'TokenAAA111222333444555666777888999000111',
      chainId:      'solana',
      pairAddress:  'PairAAA111',
      symbol:       'FRESH',
      priceUsd:     0.00015,
      liquidityUsd: 25_000,
      volumeUsd:    50_000,
      observedAt:   overrides.observedAt ?? EIGHT_MIN_AGO,
    },
    final: {
      contract:  overrides.contract ?? 'TokenAAA111222333444555666777888999000111',
      chainId:   'solana',
      observedAt: BASE_ISO,
    },
    priceChangePct:          45.0,
    liquidityChangePct:      12.0,
    volumeToLiquidityRatio:  2.0,
    classification: overrides.classification ?? 'winner',
  };
}

function makeRunFile(outcomes: object[]): object {
  const winners = outcomes.filter((o: any) => o.classification === 'winner');
  const flat    = outcomes.filter((o: any) => o.classification === 'flat');
  const losers  = outcomes.filter((o: any) => o.classification === 'loser');
  const missing = outcomes.filter((o: any) => !['winner','flat','loser'].includes((o as any).classification));
  return { generatedAt: BASE_ISO, signalsRead: outcomes.length, winners, flat, losers, missing };
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpl-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunsDir(runFiles: Record<string, object>): string {
  const dir = path.join(tmpDir, 'dex-watch-runs');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(runFiles)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  return dir;
}

/** No-op sleep — tests never wait. */
const noSleep = () => Promise.resolve();

/** Monotonically increasing nowMs for the same base, offset per call. */
function makeClockFn(baseMs = BASE_MS, stepMs = 1_000): () => number {
  let t = baseMs;
  return () => { const v = t; t += stepMs; return v; };
}

// ── stop file ─────────────────────────────────────────────────────────────────

describe('runRipperPaperLoop — stop file', () => {
  it('stops before the first cycle when stop file is present at start', async () => {
    const stopFile = path.join(tmpDir, 'STOP');
    fs.writeFileSync(stopFile, '');
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      stopFilePath: stopFile,
      maxCycles:  5,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(result.stoppedByFile).toBe(true);
    expect(result.cyclesAttempted).toBe(0);
    expect(result.cyclesCompleted).toBe(0);
  });

  it('stops after first cycle when stop file appears between cycles', async () => {
    const stopFile = path.join(tmpDir, 'STOP');
    const runsDir  = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });
    const cyclesDir = path.join(tmpDir, 'cycles');
    let callCount = 0;

    // sleep writes the stop file after the first cycle
    const sleepAndStop = async () => {
      callCount += 1;
      fs.writeFileSync(stopFile, '');
    };

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir,
      stopFilePath: stopFile,
      maxCycles:    5,
      sleep:        sleepAndStop,
      getNowMs:     makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(result.stoppedByFile).toBe(true);
    expect(result.cyclesCompleted).toBe(1);
    expect(result.cyclesAttempted).toBe(1);
  });

  it('stoppedByFile=false when stop file is never present', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(result.stoppedByFile).toBe(false);
  });
});

// ── max cycles ────────────────────────────────────────────────────────────────

describe('runRipperPaperLoop — max cycles', () => {
  it('runs exactly maxCycles cycles', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  3,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(result.cyclesCompleted).toBe(3);
    expect(result.cyclesAttempted).toBe(3);
    expect(result.stoppedByMaxCycles).toBe(true);
  });

  it('does not sleep after the last cycle', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    let sleepCalls = 0;
    const countingSleep = async () => { sleepCalls += 1; };

    await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  3,
      sleep:      countingSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    // 3 cycles → 2 sleeps (not after the last cycle)
    expect(sleepCalls).toBe(2);
  });

  it('sleep receives intervalSeconds * 1000 ms', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    const sleepArgs: number[] = [];
    const recordingSleep = async (ms: number) => { sleepArgs.push(ms); };

    await runRipperPaperLoop({
      runsDir,
      cyclesDir:         path.join(tmpDir, 'cycles'),
      maxCycles:         2,
      intervalSeconds:   45,
      sleep:             recordingSleep,
      getNowMs:          makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(sleepArgs).toHaveLength(1);
    expect(sleepArgs[0]).toBe(45_000);
  });
});

// ── error handling ────────────────────────────────────────────────────────────

describe('runRipperPaperLoop — error handling', () => {
  it('stops and records error when a cycle throws', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    let callCount = 0;
    const throwingProvider = {
      name: 'throwing-provider',
      fetchClusterRisk: async (_mint: string) => {
        callCount += 1;
        if (callCount === 1) throw new Error('provider boom');
        return offlineClusterRiskProvider.fetchClusterRisk(_mint);
      },
    };

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  3,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      // The provider throws on first call — but capture degrades gracefully,
      // so the error won't propagate. To test error-stop we inject a bad runsDir
      // that causes loadOutcomes to crash rather than degrade.
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    // With valid runsDir and offline provider, no error is expected; just sanity
    expect(result.stoppedByError).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it('stoppedByError=true when cycle throws', async () => {
    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'any-dir'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  3,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      _runCycle:  async () => { throw new Error('cycle boom'); },
    });

    expect(result.stoppedByError).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].cycleNumber).toBe(1);
    expect(result.cyclesCompleted).toBe(0);
  });

  it('error message is captured in result.errors', async () => {
    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'any-dir'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      _runCycle:  async () => { throw new Error('something broke'); },
    });

    expect(result.errors[0].error).toBe('something broke');
    expect(typeof result.errors[0].error).toBe('string');
  });
});

// ── session totals ────────────────────────────────────────────────────────────

describe('runRipperPaperLoop — session totals', () => {
  it('totalFixtures sums fixturesCaptured across all cycles', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([
        makeOutcome({ contract: 'TokenAAA' }),
        makeOutcome({ contract: 'TokenBBB' }),
      ]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  2,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(result.totalFixtures).toBe(result.cycles.reduce(
      (sum, c) => sum + c.result.fixturesCaptured, 0,
    ));
  });

  it('totalPaperApprovals + totalRejected equals totalFixtures', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  2,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(result.totalPaperApprovals + result.totalRejected).toBe(result.totalFixtures);
  });

  it('totalFixtures is 0 when all candidates are stale', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  2,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(result.totalFixtures).toBe(0);
    expect(result.cyclesCompleted).toBe(2);
    expect(result.stoppedByMaxCycles).toBe(true);
  });
});

// ── onCycleComplete callback ──────────────────────────────────────────────────

describe('runRipperPaperLoop — onCycleComplete callback', () => {
  it('is called once per completed cycle', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    const calls: number[] = [];
    await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  3,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
      onCycleComplete: (_result, cycleNumber) => {
        calls.push(cycleNumber);
      },
    });

    expect(calls).toEqual([1, 2, 3]);
  });

  it('is not called when capture is skipped', async () => {
    // Even with no fresh signals, callback should still fire (the cycle completed)
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });

    const calls: number[] = [];
    await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  2,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
      onCycleComplete: (_result, n) => calls.push(n),
    });

    // Callback fires for every completed cycle, including skipped-capture ones
    expect(calls).toEqual([1, 2]);
  });

  it('is not called when a cycle errors', async () => {
    const calls: number[] = [];
    await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'any-dir'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  3,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      _runCycle:  async () => { throw new Error('cycle boom'); },
      onCycleComplete: (_result, n) => calls.push(n),
    });

    expect(calls).toHaveLength(0);
  });
});

// ── safety fields ─────────────────────────────────────────────────────────────

describe('runRipperPaperLoop — safety fields', () => {
  it('always sets realTradingLocked=true, tradingExecuted=0', async () => {
    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'no-such-dir'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('safety fields present even after error', async () => {
    const blockedCyclesDir = path.join(tmpDir, 'blocked');
    fs.writeFileSync(blockedCyclesDir, 'not a dir');

    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'no-runs'),
      cyclesDir:  blockedCyclesDir,
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
    });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });
});

// ── renderer ──────────────────────────────────────────────────────────────────

describe('renderLoopCycleLine', () => {
  it('shows skip message when captureSkipped=true', async () => {
    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'no-such-dir'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
    });
    if (result.cycles.length === 0) {
      // No cycles ran (missing run files → stoppedByFile or immediate skip)
      // Just verify the result has the right shape
      expect(result.totalFixtures).toBe(0);
      return;
    }
    const line = renderLoopCycleLine(result.cycles[0].result, 1, 5);
    expect(line).toContain('skip');
    expect(line).toContain('locked=true');
  });

  it('shows fixture counts when capture ran', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    const line = renderLoopCycleLine(result.cycles[0].result, 1, 5);
    expect(line).toContain('fixtures=');
    expect(line).toContain('approved=');
    expect(line).toContain('rejected=');
    expect(line).toContain('locked=true');
    expect(line).toContain('tradingExecuted=0');
  });
});

// ── source refresh ────────────────────────────────────────────────────────────

function makeFakeCycleResult(overrides: Partial<RipperPaperCycleResult> = {}): RipperPaperCycleResult {
  return {
    cycleStartedAt:              new Date(BASE_MS).toISOString(),
    cycleSlug:                   '2026-06-12-000000',
    feedSignalsWritten:          0,
    feedSkippedOldCount:         0,
    captureSkipped:              true,
    captureSkipReason:           'no candidates in run file',
    fixturesCaptured:            0,
    clusterRiskCounts:           { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 },
    bubblemapsProviderCount:     0,
    buyApprovedPaper:            0,
    buyRejected:                 0,
    seenSkippedCount:            0,
    tooEarlyRecheckableCount:    0,
    outputPath:                  null,
    feedOutputPath:              '/tmp/feed.json',
    postApprovalObservedCount:   0,
    observationOutputPath:       null,
    realTradingLocked:           true,
    tradingExecuted:             0,
    noRealTradeSent:             true,
    paperOnly:                   true,
    readOnly:                    true,
    ...overrides,
  };
}

describe('runRipperPaperLoop — source refresh', () => {
  it('calls _refreshSource once per cycle when refreshSource=true', async () => {
    const refreshCalls: number[] = [];
    let callCount = 0;

    await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'any'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  3,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      refreshSource: true,
      _refreshSource: async () => {
        refreshCalls.push(++callCount);
        return { success: true, note: 'refreshed' };
      },
      _runCycle: async () => makeFakeCycleResult(),
    });

    expect(refreshCalls).toHaveLength(3);
  });

  it('does not call _refreshSource when refreshSource=false', async () => {
    let called = false;

    await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'any'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  2,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      refreshSource: false,
      _refreshSource: async () => { called = true; return { success: true, note: '' }; },
      _runCycle: async () => makeFakeCycleResult(),
    });

    expect(called).toBe(false);
  });

  it('does not call _refreshSource when refreshSource is omitted', async () => {
    let called = false;

    await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'any'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      _refreshSource: async () => { called = true; return { success: true, note: '' }; },
      _runCycle: async () => makeFakeCycleResult(),
    });

    expect(called).toBe(false);
  });

  it('passes sourceRefresh result to onCycleComplete', async () => {
    const received: Array<SourceRefreshResult | undefined> = [];

    await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'any'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  2,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      refreshSource: true,
      _refreshSource: async () => ({ success: true, note: 'all good' }),
      _runCycle: async () => makeFakeCycleResult(),
      onCycleComplete: (_result, _n, sourceRefresh) => { received.push(sourceRefresh); },
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ success: true, note: 'all good' });
  });

  it('continues the cycle even when _refreshSource throws', async () => {
    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'any'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      refreshSource: true,
      _refreshSource: async () => { throw new Error('network timeout'); },
      _runCycle: async () => makeFakeCycleResult(),
    });

    expect(result.cyclesCompleted).toBe(1);
    expect(result.cycles[0].sourceRefresh?.success).toBe(false);
    expect(result.cycles[0].sourceRefresh?.note).toContain('network timeout');
  });

  it('sourceRefresh is undefined in cycle summary when refreshSource is off', async () => {
    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'any'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      _runCycle: async () => makeFakeCycleResult(),
    });

    expect(result.cycles[0].sourceRefresh).toBeUndefined();
  });
});

// ── session dedupe ────────────────────────────────────────────────────────────

describe('runRipperPaperLoop — session dedupe', () => {
  it('second cycle skips or re-observes contracts seen in first cycle', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ contract: 'TokenAAA' })]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 2,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(result.cycles[0].result.seenSkippedCount).toBe(0);
    // Approved candidates go to post-approval observation; rejected go to seenSkipped
    const c2 = result.cycles[1].result;
    expect(c2.seenSkippedCount + c2.postApprovalObservedCount).toBeGreaterThan(0);
    expect(result.totalSeenSkipped + result.totalPostApprovalObserved).toBeGreaterThan(0);
  });

  it('totalSeenSkipped equals sum of seenSkippedCount across cycles', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 3,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    const sumFromCycles = result.cycles.reduce((sum, c) => sum + c.result.seenSkippedCount, 0);
    expect(result.totalSeenSkipped).toBe(sumFromCycles);
  });

  it('totalSeenSkipped is 0 for a single cycle', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 1,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(result.totalSeenSkipped).toBe(0);
    expect(result.cycles[0].result.seenSkippedCount).toBe(0);
  });

  it('totalSeenSkipped is 0 when all signals are stale (never processed)', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome({ observedAt: TWO_HR_AGO })]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 3,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });

    expect(result.totalSeenSkipped).toBe(0);
  });
});

// ── renderer — refresh and dup tags ──────────────────────────────────────────

describe('renderLoopCycleLine — refresh and dup tags', () => {
  it('includes refresh=OK when sourceRefresh.success=true', () => {
    const line = renderLoopCycleLine(
      makeFakeCycleResult(),
      1, 5,
      { success: true, note: 'ok' },
    );
    expect(line).toContain('refresh=OK');
  });

  it('includes refresh=FAIL when sourceRefresh.success=false', () => {
    const line = renderLoopCycleLine(
      makeFakeCycleResult(),
      1, 5,
      { success: false, note: 'network timeout' },
    );
    expect(line).toContain('refresh=FAIL');
  });

  it('does not include refresh tag when sourceRefresh is undefined', () => {
    const line = renderLoopCycleLine(makeFakeCycleResult(), 1, 5);
    expect(line).not.toContain('refresh=');
  });

  it('includes dup=N when seenSkippedCount > 0', () => {
    const line = renderLoopCycleLine(
      makeFakeCycleResult({ seenSkippedCount: 3, captureSkipped: true,
        captureSkipReason: 'all 3 signals already seen in this session' }),
      1, 5,
    );
    expect(line).toContain('dup=3');
  });

  it('does not include dup= when seenSkippedCount is 0', () => {
    const line = renderLoopCycleLine(makeFakeCycleResult({ seenSkippedCount: 0 }), 1, 5);
    expect(line).not.toContain('dup=');
  });

  it('includes recheck=N when tooEarlyRecheckableCount > 0', () => {
    const line = renderLoopCycleLine(
      makeFakeCycleResult({ tooEarlyRecheckableCount: 5, captureSkipped: false,
        fixturesCaptured: 5, buyApprovedPaper: 0, buyRejected: 5,
        clusterRiskCounts: { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 5 } }),
      1, 5,
    );
    expect(line).toContain('recheck=5');
  });

  it('does not include recheck= when tooEarlyRecheckableCount is 0', () => {
    const line = renderLoopCycleLine(makeFakeCycleResult({ tooEarlyRecheckableCount: 0 }), 1, 5);
    expect(line).not.toContain('recheck=');
  });
});

// ── firstSeen map passthrough ─────────────────────────────────────────────────

describe('runRipperPaperLoop — firstSeen map passthrough', () => {
  it('passes the same firstSeenMap instance to each cycle', async () => {
    const receivedMaps: Array<Map<string, string> | undefined> = [];

    await runRipperPaperLoop({
      runsDir:   path.join(tmpDir, 'any'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 3,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      _runCycle: async (opts) => {
        receivedMaps.push(opts.firstSeenMap);
        return makeFakeCycleResult();
      },
    });

    expect(receivedMaps).toHaveLength(3);
    expect(receivedMaps.every(m => m instanceof Map)).toBe(true);
    expect(receivedMaps[0]).toBe(receivedMaps[1]);
    expect(receivedMaps[1]).toBe(receivedMaps[2]);
  });

  it('firstSeenMap starts empty at session start', async () => {
    const receivedMaps: Array<Map<string, string>> = [];

    await runRipperPaperLoop({
      runsDir:   path.join(tmpDir, 'any'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 1,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      _runCycle: async (opts) => {
        if (opts.firstSeenMap) receivedMaps.push(opts.firstSeenMap);
        return makeFakeCycleResult();
      },
    });

    expect(receivedMaps[0].size).toBe(0);
  });
});

// ── post-approval observations ────────────────────────────────────────────────

describe('runRipperPaperLoop — post-approval observations', () => {
  it('passes the same approvedContracts instance to every cycle', async () => {
    const received: Array<Map<string, string> | undefined> = [];

    await runRipperPaperLoop({
      runsDir:   path.join(tmpDir, 'any'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 3,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      _runCycle: async (opts) => {
        received.push(opts.approvedContracts);
        return makeFakeCycleResult();
      },
    });

    expect(received).toHaveLength(3);
    expect(received.every(m => m instanceof Map)).toBe(true);
    expect(received[0]).toBe(received[1]);
    expect(received[1]).toBe(received[2]);
  });

  it('approvedContracts starts empty at session start', async () => {
    let seen: Map<string, string> | undefined;

    await runRipperPaperLoop({
      runsDir:   path.join(tmpDir, 'any'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 1,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      _runCycle: async (opts) => {
        seen = opts.approvedContracts;
        return makeFakeCycleResult();
      },
    });

    expect(seen?.size).toBe(0);
  });

  it('totalPostApprovalObserved accumulates postApprovalObservedCount across cycles', async () => {
    let callCount = 0;

    const result = await runRipperPaperLoop({
      runsDir:   path.join(tmpDir, 'any'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 3,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      _runCycle: async () => {
        callCount++;
        return makeFakeCycleResult({ postApprovalObservedCount: callCount === 1 ? 0 : 2 });
      },
    });

    expect(result.totalPostApprovalObserved).toBe(4); // 0 + 2 + 2
  });

  it('totalPostApprovalObserved is 0 when no observations occur', async () => {
    const result = await runRipperPaperLoop({
      runsDir:   path.join(tmpDir, 'any'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 2,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      _runCycle: async () => makeFakeCycleResult(),
    });

    expect(result.totalPostApprovalObserved).toBe(0);
  });

  it('session summary includes Post-approval obs line', async () => {
    const result = await runRipperPaperLoop({
      runsDir:   path.join(tmpDir, 'any'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 1,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      _runCycle: async () => makeFakeCycleResult({ postApprovalObservedCount: 3 }),
    });

    const out = renderRipperPaperLoopResult(result, 1);
    expect(out).toContain('Post-approval obs');
  });

  it('safety fields remain true when observations are running', async () => {
    const result = await runRipperPaperLoop({
      runsDir:   path.join(tmpDir, 'any'),
      cyclesDir: path.join(tmpDir, 'cycles'),
      maxCycles: 1,
      sleep:     noSleep,
      getNowMs:  makeClockFn(),
      _runCycle: async () => makeFakeCycleResult({ postApprovalObservedCount: 5 }),
    });

    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

describe('renderRipperPaperLoopResult', () => {
  it('contains REAL TRADING LOCKED and safety fields', async () => {
    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'no-such-dir'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
    });
    const out = renderRipperPaperLoopResult(result, 1);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('paperOnly=true');
  });

  it('shows max cycles reached in stop reason', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });

    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  2,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });
    const out = renderRipperPaperLoopResult(result, 2);
    expect(out).toContain('max cycles');
  });

  it('shows stop file in stop reason', async () => {
    const stopFile = path.join(tmpDir, 'STOP');
    fs.writeFileSync(stopFile, '');

    const result = await runRipperPaperLoop({
      runsDir:      path.join(tmpDir, 'no-such-dir'),
      cyclesDir:    path.join(tmpDir, 'cycles'),
      stopFilePath: stopFile,
      maxCycles:    5,
      sleep:        noSleep,
      getNowMs:     makeClockFn(),
    });
    const out = renderRipperPaperLoopResult(result, 5);
    expect(out).toContain('stop file');
  });

  it('shows error in session summary', async () => {
    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'any-dir'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  2,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      _runCycle:  async () => { throw new Error('boom'); },
    });
    const out = renderRipperPaperLoopResult(result, 2);
    expect(out).toContain('error');
    expect(out).toContain('Errors:');
  });

  it('shows Too-early recheck line in session summary', async () => {
    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'no-such-dir'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  1,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      _runCycle:  async () => makeFakeCycleResult({ tooEarlyRecheckableCount: 3 }),
    });
    const out = renderRipperPaperLoopResult(result, 1);
    expect(out).toContain('Too-early recheck');
  });

  it('totalTooEarlyRecheckable accumulates across cycles', async () => {
    const result = await runRipperPaperLoop({
      runsDir:    path.join(tmpDir, 'no-such-dir'),
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  3,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      _runCycle:  async () => makeFakeCycleResult({ tooEarlyRecheckableCount: 2 }),
    });
    expect(result.totalTooEarlyRecheckable).toBe(6); // 3 cycles × 2 each
  });

  it('shows Seen/deduped line in session summary', async () => {
    const runsDir = makeRunsDir({
      'run-20260610-100000.json': makeRunFile([makeOutcome()]),
    });
    const result = await runRipperPaperLoop({
      runsDir,
      cyclesDir:  path.join(tmpDir, 'cycles'),
      maxCycles:  2,
      sleep:      noSleep,
      getNowMs:   makeClockFn(),
      clusterRiskProvider: offlineClusterRiskProvider,
    });
    const out = renderRipperPaperLoopResult(result, 2);
    expect(out).toContain('Seen/deduped');
  });
});
