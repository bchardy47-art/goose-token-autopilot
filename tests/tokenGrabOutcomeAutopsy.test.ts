import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import {
  runOutcomeAutopsy,
  renderOutcomeAutopsyReport,
  type OutcomeAutopsyOptions,
} from '../src/token-grab/outcomeAutopsy';
import { type LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';
import { type DexPairSnapshot } from '../src/token-grab/dexWatch';

// ── Fixture factory ───────────────────────────────────────────────────────────

function makeLiveFixture(opts: {
  contract:                  string;
  symbol:                    string;
  entryPriceUsd:             number;
  finalPriceUsd?:            number;
  entryLiquidityUsd?:        number;
  entryVolumeUsd?:           number;
  topHolderPercent?:         number;
  holderConcentrationStatus?: string;
  bubbleMapsScore?:          number;
  estimatedSlippagePct?:     number;
  clusterNotes?:             string[];
  capturedAt?:               string;
}): LiveRipperFixture {
  const contract = opts.contract;
  const entryLiq = opts.entryLiquidityUsd ?? 80000;
  const entryVol = opts.entryVolumeUsd    ?? 8000;
  const entryPrice = opts.entryPriceUsd;
  const finalPrice = opts.finalPriceUsd ?? entryPrice;
  const bubbleScore = opts.bubbleMapsScore ?? 70;

  return {
    id:           `fix-${contract}`,
    capturedAt:   opts.capturedAt ?? '2026-06-10T08:46:49.889Z',
    source:       'test',
    sourceKind:   'FRESH_POOL',
    raw: {
      contract,
      chainId:                   'solana',
      pairUrl:                   `https://dexscreener.com/solana/PAIR_${contract}`,
      clusterRisk:               'CLEAN',
      slippageRisk:              'CLEAN',
      routeFound:                true,
      quoteCheckedAt:            '2026-06-10T08:43:00.000Z',
      holderConcentrationStatus: opts.holderConcentrationStatus ?? 'CLEAN',
      topHolderPercent:          opts.topHolderPercent ?? 9.5,
      liquidityTradable:         'GOOD',
      estimatedSlippagePct:      opts.estimatedSlippagePct ?? 0,
      clusterRawMetrics:         { decentralisationScore: bubbleScore },
      clusterNotes:              opts.clusterNotes ?? [`bubbleMapsScore ${bubbleScore.toFixed(1)}`],
      entry: {
        contract,
        chainId:     'solana',
        pairUrl:     `https://dexscreener.com/solana/PAIR_${contract}`,
        symbol:      opts.symbol,
        priceUsd:    entryPrice,
        liquidityUsd: entryLiq,
        volumeUsd:   entryVol,
        observedAt:  '2026-06-10T08:43:13.000Z',
      },
      final: {
        contract,
        chainId:     'solana',
        symbol:      opts.symbol,
        priceUsd:    finalPrice,
        liquidityUsd: entryLiq,
        observedAt:  '2026-06-10T08:44:15.000Z',
      },
    },
    normalizedSignal: {
      id:      `sig-${contract}`,
      contract,
      symbol:  opts.symbol,
      chainId: 'solana',
    } as LiveRipperFixture['normalizedSignal'],
    ripperInput: { contract, volumeLiquidityRatio: 0.5 } as unknown as LiveRipperFixture['ripperInput'],
    entryDecision:   'BUY_APPROVED_PAPER',
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers:         [],
    topReasons:       [],
    warnings:         [],
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeFetch(prices: Record<string, number | null>) {
  return async (contract: string, _chain: string, observedAt: string): Promise<DexPairSnapshot | null> => {
    if (!(contract in prices)) return null;
    const price = prices[contract];
    return {
      contract,
      chainId: 'solana',
      priceUsd: price ?? undefined,
      observedAt,
    };
  };
}

const nullFetch = async (): Promise<DexPairSnapshot | null> => null;

let tmpFileCounter = 0;
function makeOptions(fixtures: LiveRipperFixture[], fetchImpl = nullFetch): OutcomeAutopsyOptions {
  const tmpFile = `/tmp/test-autopsy-fixtures-${++tmpFileCounter}.jsonl`;
  writeFileSync(tmpFile, fixtures.map(f => JSON.stringify(f)).join('\n'));
  return {
    inputPath:   tmpFile,
    generatedAt: '2026-06-10T10:00:00.000Z',
    fetch:       fetchImpl,
  };
}

// ── Standard test set: 1 winner, 1 loser, 1 unknown ─────────────────────────

function makeStandardSet() {
  const winner = makeLiveFixture({
    contract: 'MINT_WIN', symbol: 'WIN',
    entryPriceUsd: 0.01,
    topHolderPercent: 9.5,
    entryLiquidityUsd: 80000, entryVolumeUsd: 8000,
    bubbleMapsScore: 65,
  });
  const loser = makeLiveFixture({
    contract: 'MINT_LOSE', symbol: 'LOSE',
    entryPriceUsd: 0.01,
    topHolderPercent: 12.0,
    entryLiquidityUsd: 40000, entryVolumeUsd: 20000,
    bubbleMapsScore: 80,
  });
  const unknown = makeLiveFixture({
    contract: 'MINT_UNK', symbol: 'UNK',
    entryPriceUsd: 0.01,
  });
  const fetch = makeFetch({
    MINT_WIN:  0.02,   // +100% → RIPPED
    MINT_LOSE: 0.005,  // -50%  → DUMPED
    // MINT_UNK returns null
  });
  return { winner, loser, unknown, fetch };
}

// ── runOutcomeAutopsy: input missing ─────────────────────────────────────────

describe('runOutcomeAutopsy — input missing', () => {
  it('returns inputMissing=true for nonexistent file', async () => {
    const result = await runOutcomeAutopsy({ inputPath: '/tmp/nonexistent-autopsy.jsonl' });
    expect(result.inputMissing).toBe(true);
    expect(result.totalCandidates).toBe(0);
  });

  it('safety fields always set on missing file', async () => {
    const result = await runOutcomeAutopsy({ inputPath: '/tmp/nonexistent-autopsy.jsonl' });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── runOutcomeAutopsy: counts ─────────────────────────────────────────────────

describe('runOutcomeAutopsy — winner/loser/unknown counts', () => {
  it('calculates 1 winner, 1 loser, 1 unknown from standard set', async () => {
    const { winner, loser, unknown, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser, unknown], fetch));
    expect(result.winnerCount).toBe(1);
    expect(result.loserCount).toBe(1);
    expect(result.unknownCount).toBe(1);
    expect(result.totalCandidates).toBe(3);
  });

  it('RIPPED counts as winner', async () => {
    const f = makeLiveFixture({ contract: 'MINT_R', symbol: 'R', entryPriceUsd: 0.01 });
    const fetch = makeFetch({ MINT_R: 0.02 }); // +100% → RIPPED
    const result = await runOutcomeAutopsy(makeOptions([f], fetch));
    expect(result.winnerCount).toBe(1);
    expect(result.records[0]!.status).toBe('RIPPED');
  });

  it('MOVED counts as winner', async () => {
    const f = makeLiveFixture({ contract: 'MINT_M', symbol: 'M', entryPriceUsd: 0.01 });
    const fetch = makeFetch({ MINT_M: 0.012 }); // +20% → MOVED
    const result = await runOutcomeAutopsy(makeOptions([f], fetch));
    expect(result.winnerCount).toBe(1);
    expect(result.records[0]!.status).toBe('MOVED');
  });

  it('DUMPED counts as loser', async () => {
    const f = makeLiveFixture({ contract: 'MINT_D', symbol: 'D', entryPriceUsd: 0.01 });
    const fetch = makeFetch({ MINT_D: 0.005 }); // -50% → DUMPED
    const result = await runOutcomeAutopsy(makeOptions([f], fetch));
    expect(result.loserCount).toBe(1);
    expect(result.records[0]!.status).toBe('DUMPED');
  });

  it('no price → UNKNOWN', async () => {
    const f = makeLiveFixture({ contract: 'MINT_U', symbol: 'U', entryPriceUsd: 0.01 });
    const result = await runOutcomeAutopsy(makeOptions([f], nullFetch));
    expect(result.unknownCount).toBe(1);
  });
});

// ── runOutcomeAutopsy: win rate ───────────────────────────────────────────────

describe('runOutcomeAutopsy — win rate', () => {
  it('computes 50% win rate for 1 winner + 1 loser', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    expect(result.winRate).toBeCloseTo(0.5, 5);
  });

  it('computes 100% win rate when all winners', async () => {
    const f = makeLiveFixture({ contract: 'MINT_W', symbol: 'W', entryPriceUsd: 0.01 });
    const fetch = makeFetch({ MINT_W: 0.02 });
    const result = await runOutcomeAutopsy(makeOptions([f], fetch));
    expect(result.winRate).toBeCloseTo(1.0, 5);
  });

  it('win rate is null when no resolved candidates (all UNKNOWN)', async () => {
    const f = makeLiveFixture({ contract: 'MINT_U', symbol: 'U', entryPriceUsd: 0.01 });
    const result = await runOutcomeAutopsy(makeOptions([f], nullFetch));
    expect(result.winRate).toBeNull();
  });

  it('computes average return % correctly', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    // winner: +100%, loser: -50% → avg = 25%
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    expect(result.averageReturnPct).toBeCloseTo(25, 3);
  });
});

// ── runOutcomeAutopsy: comparison metrics ─────────────────────────────────────

describe('runOutcomeAutopsy — comparison metrics', () => {
  it('computes winner avgTopHolderPercent', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    expect(result.winnerMetrics.avgTopHolderPercent).toBeCloseTo(9.5, 3);
  });

  it('computes loser avgTopHolderPercent', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    expect(result.loserMetrics.avgTopHolderPercent).toBeCloseTo(12.0, 3);
  });

  it('computes winner avgEntryLiquidityUsd', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    expect(result.winnerMetrics.avgEntryLiquidityUsd).toBeCloseTo(80000, 0);
  });

  it('computes loser avgEntryVolumeUsd', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    expect(result.loserMetrics.avgEntryVolumeUsd).toBeCloseTo(20000, 0);
  });

  it('computes avgVolumeToLiquidityRatio', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    // winner: 8000/80000 = 0.1
    expect(result.winnerMetrics.avgVolumeToLiquidityRatio).toBeCloseTo(0.1, 3);
    // loser: 20000/40000 = 0.5
    expect(result.loserMetrics.avgVolumeToLiquidityRatio).toBeCloseTo(0.5, 3);
  });

  it('includes BubbleMaps score from clusterRawMetrics', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    expect(result.winnerMetrics.avgBubbleMapsScore).toBeCloseTo(65, 1);
    expect(result.loserMetrics.avgBubbleMapsScore).toBeCloseTo(80, 1);
  });

  it('bubbleMapsScore is null when clusterRawMetrics absent', async () => {
    const f = makeLiveFixture({ contract: 'MINT_NB', symbol: 'NB', entryPriceUsd: 0.01 });
    (f.raw as Record<string, unknown>)['clusterRawMetrics'] = undefined;
    const fetch = makeFetch({ MINT_NB: 0.02 });
    const result = await runOutcomeAutopsy(makeOptions([f], fetch));
    expect(result.records[0]!.bubbleMapsScore).toBeNull();
    expect(result.winnerMetrics.avgBubbleMapsScore).toBeNull();
  });

  it('computes liquidityChangePct from entry→final capture window', async () => {
    const f = makeLiveFixture({
      contract: 'MINT_LC', symbol: 'LC', entryPriceUsd: 0.01, entryLiquidityUsd: 100000,
    });
    // Override final to have different liquidity
    (f.raw as Record<string, unknown>)['final'] = {
      contract: 'MINT_LC', chainId: 'solana', priceUsd: 0.01,
      liquidityUsd: 110000, observedAt: '2026-06-10T08:44:15.000Z',
    };
    const fetch = makeFetch({ MINT_LC: 0.02 });
    const result = await runOutcomeAutopsy(makeOptions([f], fetch));
    expect(result.records[0]!.liquidityChangePct).toBeCloseTo(10, 3);
  });

  it('computes priceChangePctCapture from entry→final within fixture', async () => {
    const f = makeLiveFixture({
      contract: 'MINT_PC', symbol: 'PC', entryPriceUsd: 0.01, finalPriceUsd: 0.012,
    });
    const fetch = makeFetch({ MINT_PC: 0.015 });
    const result = await runOutcomeAutopsy(makeOptions([f], fetch));
    expect(result.records[0]!.priceChangePctCapture).toBeCloseTo(20, 3);
  });

  it('reads estimatedSlippagePct from raw', async () => {
    const f = makeLiveFixture({ contract: 'MINT_SL', symbol: 'SL', entryPriceUsd: 0.01, estimatedSlippagePct: 0.5 });
    const result = await runOutcomeAutopsy(makeOptions([f], nullFetch));
    expect(result.records[0]!.estimatedSlippagePct).toBeCloseTo(0.5, 5);
  });

  it('reads holderConcentrationStatus from raw', async () => {
    // FUTURE_AUTONOMY_CANDIDATE requires holderRisk CLEAN, so use CLEAN status
    const f = makeLiveFixture({ contract: 'MINT_HC', symbol: 'HC', entryPriceUsd: 0.01, holderConcentrationStatus: 'CLEAN' });
    const result = await runOutcomeAutopsy(makeOptions([f], nullFetch));
    expect(result.totalCandidates).toBe(1);
    expect(result.records[0]!.holderConcentrationStatus).toBe('CLEAN');
  });

  it('bestCandidate is the highest-return record', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    expect(result.bestCandidate?.symbol).toBe('WIN');
  });

  it('worstCandidate is the lowest-return record', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    expect(result.worstCandidate?.symbol).toBe('LOSE');
  });
});

// ── Safety invariants ─────────────────────────────────────────────────────────

describe('runOutcomeAutopsy — safety invariants', () => {
  it('tradingExecuted is always 0', async () => {
    const { winner, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner], fetch));
    expect(result.tradingExecuted).toBe(0);
  });

  it('noRealTradeSent is always true', async () => {
    const { winner, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner], fetch));
    expect(result.noRealTradeSent).toBe(true);
  });

  it('paperOnly is always true', async () => {
    const result = await runOutcomeAutopsy(makeOptions([], nullFetch));
    expect(result.paperOnly).toBe(true);
  });

  it('readOnly is always true', async () => {
    const result = await runOutcomeAutopsy(makeOptions([], nullFetch));
    expect(result.readOnly).toBe(true);
  });
});

// ── renderOutcomeAutopsyReport ────────────────────────────────────────────────

describe('renderOutcomeAutopsyReport', () => {
  it('includes REAL TRADING LOCKED', async () => {
    const { winner, loser, unknown, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser, unknown], fetch));
    expect(renderOutcomeAutopsyReport(result)).toContain('REAL TRADING LOCKED');
  });

  it('includes REAL TRADING LOCKED on missing-file report', () => {
    const result = {
      inputPath: '/tmp/none.jsonl', inputMissing: true, generatedAt: '2026-06-10T10:00:00.000Z',
      totalCandidates: 0, winnerCount: 0, loserCount: 0, flatCount: 0, unknownCount: 0,
      winRate: null, averageReturnPct: null, bestCandidate: null, worstCandidate: null,
      winnerMetrics: { avgTopHolderPercent: null, avgEntryLiquidityUsd: null, avgEntryVolumeUsd: null, avgVolumeToLiquidityRatio: null, avgLiquidityChangePct: null, avgPriceChangePctCapture: null, avgEstimatedSlippagePct: null, avgBubbleMapsScore: null },
      loserMetrics:  { avgTopHolderPercent: null, avgEntryLiquidityUsd: null, avgEntryVolumeUsd: null, avgVolumeToLiquidityRatio: null, avgLiquidityChangePct: null, avgPriceChangePctCapture: null, avgEstimatedSlippagePct: null, avgBubbleMapsScore: null },
      records: [],
      tradingExecuted: 0 as const, noRealTradeSent: true as const, paperOnly: true as const, readOnly: true as const,
    };
    expect(renderOutcomeAutopsyReport(result)).toContain('REAL TRADING LOCKED');
  });

  it('prints "Do not go live from 3 samples" when totalCandidates < 20', async () => {
    const { winner, loser, unknown, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser, unknown], fetch));
    expect(result.totalCandidates).toBe(3);
    expect(renderOutcomeAutopsyReport(result)).toContain('Do not go live from 3 samples');
  });

  it('shows symbol of winner and loser in report', async () => {
    const { winner, loser, unknown, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser, unknown], fetch));
    const report = renderOutcomeAutopsyReport(result);
    expect(report).toContain('WIN');
    expect(report).toContain('LOSE');
  });

  it('shows candidate count in summary', async () => {
    const { winner, loser, unknown, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser, unknown], fetch));
    const report = renderOutcomeAutopsyReport(result);
    expect(report).toContain('3');
  });

  it('shows BubbleMaps score in candidate rows', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    const report = renderOutcomeAutopsyReport(result);
    expect(report).toContain('65');
  });

  it('shows winner vs loser comparison section', async () => {
    const { winner, loser, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser], fetch));
    const report = renderOutcomeAutopsyReport(result);
    expect(report).toContain('WINNER vs LOSER');
  });

  it('does not contain sendTransaction or signTransaction', async () => {
    const { winner, loser, unknown, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser, unknown], fetch));
    const report = renderOutcomeAutopsyReport(result);
    expect(report).not.toContain('sendTransaction');
    expect(report).not.toContain('signTransaction');
    expect(report).not.toContain('swap');
  });

  it('prints tradingExecuted=0 in footer', async () => {
    const { winner, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner], fetch));
    expect(renderOutcomeAutopsyReport(result)).toContain('tradingExecuted=0');
  });

  it('recommendation includes "need more samples" note', async () => {
    const { winner, loser, unknown, fetch } = makeStandardSet();
    const result = await runOutcomeAutopsy(makeOptions([winner, loser, unknown], fetch));
    const report = renderOutcomeAutopsyReport(result);
    expect(report).toContain('samples before changing gates');
  });
});
