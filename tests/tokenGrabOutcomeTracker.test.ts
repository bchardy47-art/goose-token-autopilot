import { describe, it, expect } from 'vitest';
import {
  classifyOutcomeStatus,
  runOutcomeTracker,
  renderOutcomeTrackerReport,
  type OutcomeTrackerOptions,
} from '../src/token-grab/outcomeTracker';
import { extractReadinessFields, classifyReadinessLevel } from '../src/token-grab/autonomyReadinessAudit';
import { type LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';
import { type DexPairSnapshot } from '../src/token-grab/dexWatch';

// ── Fixture factory ───────────────────────────────────────────────────────────

function makeFixture(overrides: Partial<LiveRipperFixture> = {}): LiveRipperFixture {
  return {
    id:               'fixture-1',
    capturedAt:       '2026-06-10T08:00:00.000Z',
    source:           'test',
    sourceKind:       'FRESH_POOL',
    raw:              {},
    normalizedSignal: { id: 'sig-1', contract: 'MINT_AAA', symbol: 'TOKENA', chainId: 'solana' } as LiveRipperFixture['normalizedSignal'],
    ripperInput:      null,
    ripperScore:      0,
    launchAgeBucket:  'YOUNG',
    ageMinutes:       5,
    entryDecision:    'BUY_APPROVED_PAPER',
    buyGateDecision:  'BUY_APPROVED_PAPER',
    blockers:         [],
    topReasons:       [],
    warnings:         [],
    realTradingLocked: true,
    paperOnly:        true,
    readOnly:         true,
    ...overrides,
  };
}

/** Build a FUTURE_AUTONOMY_CANDIDATE fixture (all gates CLEAN). */
function makeCandidateFixture(overrides: {
  contract?: string;
  symbol?: string;
  capturedAt?: string;
  priceUsd?: number | null;
  liquidityUsd?: number | null;
  topHolderPercent?: number | null;
} = {}): LiveRipperFixture {
  const contract = overrides.contract ?? 'MINT_AAA';
  return makeFixture({
    capturedAt: overrides.capturedAt ?? '2026-06-10T08:00:00.000Z',
    raw: {
      contract,
      clusterRisk:             'CLEAN',
      slippageRisk:            'CLEAN',
      routeFound:              true,
      quoteCheckedAt:          '2026-06-10T08:00:00.000Z',
      holderConcentrationStatus: 'CLEAN',
      topHolderPercent:        overrides.topHolderPercent ?? 10,
    },
    normalizedSignal: {
      id:           `sig-${contract}`,
      contract,
      symbol:       overrides.symbol ?? 'TOKENA',
      chainId:      'solana',
      priceUsd:     overrides.priceUsd ?? null,
      liquidityUsd: overrides.liquidityUsd ?? 50000,
      observedAt:   '2026-06-10T08:00:00.000Z',
    } as LiveRipperFixture['normalizedSignal'],
    ripperInput: { contract, volumeLiquidityRatio: 0.5 } as unknown as LiveRipperFixture['ripperInput'],
  });
}

const nullFetch = async (): Promise<DexPairSnapshot | null> => null;

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

function makeOptions(fixtures: LiveRipperFixture[], fetchImpl = nullFetch): OutcomeTrackerOptions {
  const tmpFile = `/tmp/test-fixtures-${Date.now()}.jsonl`;
  const { writeFileSync } = require('fs');
  writeFileSync(tmpFile, fixtures.map(f => JSON.stringify(f)).join('\n'));
  return {
    inputPath:   tmpFile,
    generatedAt: '2026-06-10T10:00:00.000Z',
    fetch:       fetchImpl,
  };
}

// ── classifyOutcomeStatus ─────────────────────────────────────────────────────

describe('classifyOutcomeStatus', () => {
  it('null → UNKNOWN', () => {
    expect(classifyOutcomeStatus(null)).toBe('UNKNOWN');
  });

  it('+50 exactly → RIPPED', () => {
    expect(classifyOutcomeStatus(50)).toBe('RIPPED');
  });

  it('+100% → RIPPED', () => {
    expect(classifyOutcomeStatus(100)).toBe('RIPPED');
  });

  it('+49.9% → MOVED', () => {
    expect(classifyOutcomeStatus(49.9)).toBe('MOVED');
  });

  it('+15% exactly → MOVED', () => {
    expect(classifyOutcomeStatus(15)).toBe('MOVED');
  });

  it('+14.9% → FLAT', () => {
    expect(classifyOutcomeStatus(14.9)).toBe('FLAT');
  });

  it('0% → FLAT', () => {
    expect(classifyOutcomeStatus(0)).toBe('FLAT');
  });

  it('-14.9% → FLAT', () => {
    expect(classifyOutcomeStatus(-14.9)).toBe('FLAT');
  });

  it('-15% exactly → DUMPED', () => {
    expect(classifyOutcomeStatus(-15)).toBe('DUMPED');
  });

  it('-50% → DUMPED', () => {
    expect(classifyOutcomeStatus(-50)).toBe('DUMPED');
  });
});

// ── runOutcomeTracker: input missing ──────────────────────────────────────────

describe('runOutcomeTracker — input missing', () => {
  it('returns inputMissing=true for nonexistent file', async () => {
    const result = await runOutcomeTracker({ inputPath: '/tmp/nonexistent-outcome-file.jsonl' });
    expect(result.inputMissing).toBe(true);
    expect(result.candidateCount).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it('safety fields always set', async () => {
    const result = await runOutcomeTracker({ inputPath: '/tmp/nonexistent-outcome-file.jsonl' });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── runOutcomeTracker: candidate identification ───────────────────────────────

describe('runOutcomeTracker — candidate identification', () => {
  it('identifies FUTURE_AUTONOMY_CANDIDATE using same logic as autonomyReadinessAudit', async () => {
    const fixture = makeCandidateFixture();
    // Verify the fixture passes autonomy readiness independently
    const fields = extractReadinessFields(fixture);
    const { level } = classifyReadinessLevel(fields);
    expect(level).toBe('FUTURE_AUTONOMY_CANDIDATE');

    const opts = makeOptions([fixture]);
    const result = await runOutcomeTracker(opts);
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]!.symbol).toBe('TOKENA');
  });

  it('excludes HARD_REJECT fixtures', async () => {
    const rejected = makeFixture({
      raw: { holderConcentrationStatus: 'HIGH_CONCENTRATION' },
      ripperInput: null,
    });
    const opts = makeOptions([rejected]);
    const result = await runOutcomeTracker(opts);
    expect(result.candidateCount).toBe(0);
  });

  it('excludes REVIEW_READY_PAPER fixtures (clusterRisk WATCH)', async () => {
    const reviewReady = makeCandidateFixture();
    (reviewReady.raw as Record<string, unknown>)['clusterRisk'] = 'WATCH';
    const opts = makeOptions([reviewReady]);
    const result = await runOutcomeTracker(opts);
    expect(result.candidateCount).toBe(0);
  });

  it('excludes AUTONOMY_BLOCKED_CLUSTER_UNKNOWN fixtures', async () => {
    const blocked = makeCandidateFixture();
    (blocked.raw as Record<string, unknown>)['clusterRisk'] = 'UNKNOWN';
    const opts = makeOptions([blocked]);
    const result = await runOutcomeTracker(opts);
    expect(result.candidateCount).toBe(0);
  });

  it('liquidityTradable="GOOD" alone (no scoreRipper) does not qualify', async () => {
    // A fixture with raw.liquidityTradable="GOOD" but null ripperInput cannot get liqOk from scoreRipper
    const f = makeFixture({
      raw: {
        contract:                  'MINT_LIQ',
        clusterRisk:               'CLEAN',
        slippageRisk:              'CLEAN',
        routeFound:                true,
        quoteCheckedAt:            '2026-06-10T08:00:00.000Z',
        holderConcentrationStatus: 'CLEAN',
        liquidityTradable:         'GOOD',
      },
      ripperInput: null,
    });
    const fields = extractReadinessFields(f);
    const { level } = classifyReadinessLevel(fields);
    // Without scoreRipper, liquidityQuality stays UNKNOWN → not FUTURE_AUTONOMY_CANDIDATE
    expect(level).not.toBe('FUTURE_AUTONOMY_CANDIDATE');

    const opts = makeOptions([f]);
    const result = await runOutcomeTracker(opts);
    expect(result.candidateCount).toBe(0);
  });

  it('de-duplicates by contract, keeps earliest capturedAt', async () => {
    const earlier = makeCandidateFixture({ contract: 'MINT_DUP', symbol: 'EARLY', capturedAt: '2026-06-10T07:00:00.000Z' });
    const later   = makeCandidateFixture({ contract: 'MINT_DUP', symbol: 'LATE',  capturedAt: '2026-06-10T09:00:00.000Z' });
    const opts = makeOptions([later, earlier]);
    const result = await runOutcomeTracker(opts);
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]!.symbol).toBe('EARLY');
  });

  it('tracks multiple distinct contracts independently', async () => {
    const a = makeCandidateFixture({ contract: 'MINT_AAA', symbol: 'AAA' });
    const b = makeCandidateFixture({ contract: 'MINT_BBB', symbol: 'BBB' });
    const opts = makeOptions([a, b]);
    const result = await runOutcomeTracker(opts);
    expect(result.candidateCount).toBe(2);
  });
});

// ── runOutcomeTracker: return % calculation ───────────────────────────────────

describe('runOutcomeTracker — return % computation', () => {
  it('computes positive return correctly', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_UP', priceUsd: 0.01 });
    const fetch = makeFetch({ MINT_UP: 0.02 });
    const opts = makeOptions([f], fetch);
    const result = await runOutcomeTracker(opts);
    const c = result.candidates[0]!;
    expect(c.detectedPriceUsd).toBe(0.01);
    expect(c.latestPriceUsd).toBe(0.02);
    expect(c.currentReturnPct).toBeCloseTo(100, 5);
  });

  it('computes negative return correctly', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_DOWN', priceUsd: 0.1 });
    const fetch = makeFetch({ MINT_DOWN: 0.05 });
    const opts = makeOptions([f], fetch);
    const result = await runOutcomeTracker(opts);
    const c = result.candidates[0]!;
    expect(c.currentReturnPct).toBeCloseTo(-50, 5);
  });

  it('returns null currentReturnPct when detectedPriceUsd is null', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_NULL_ENTRY', priceUsd: null });
    const fetch = makeFetch({ MINT_NULL_ENTRY: 0.01 });
    const opts = makeOptions([f], fetch);
    const result = await runOutcomeTracker(opts);
    const c = result.candidates[0]!;
    expect(c.detectedPriceUsd).toBeNull();
    expect(c.currentReturnPct).toBeNull();
    expect(c.status).toBe('UNKNOWN');
  });

  it('returns null currentReturnPct when latest price unavailable', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_NO_LATEST', priceUsd: 0.01 });
    const opts = makeOptions([f], nullFetch);
    const result = await runOutcomeTracker(opts);
    const c = result.candidates[0]!;
    expect(c.latestPriceUsd).toBeNull();
    expect(c.currentReturnPct).toBeNull();
    expect(c.status).toBe('UNKNOWN');
  });

  it('handles fetch returning null gracefully', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_NOFETCH', priceUsd: 0.05 });
    const opts = makeOptions([f], nullFetch);
    const result = await runOutcomeTracker(opts);
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]!.currentReturnPct).toBeNull();
  });
});

// ── runOutcomeTracker: status classification ──────────────────────────────────

describe('runOutcomeTracker — status classification', () => {
  it('+100% → RIPPED', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_R', priceUsd: 0.01 });
    const fetch = makeFetch({ MINT_R: 0.02 });
    const result = await runOutcomeTracker(makeOptions([f], fetch));
    expect(result.candidates[0]!.status).toBe('RIPPED');
    expect(result.statusCounts.RIPPED).toBe(1);
  });

  it('+20% → MOVED', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_M', priceUsd: 0.01 });
    const fetch = makeFetch({ MINT_M: 0.012 });
    const result = await runOutcomeTracker(makeOptions([f], fetch));
    expect(result.candidates[0]!.status).toBe('MOVED');
    expect(result.statusCounts.MOVED).toBe(1);
  });

  it('no price → UNKNOWN', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_U', priceUsd: null });
    const result = await runOutcomeTracker(makeOptions([f], nullFetch));
    expect(result.candidates[0]!.status).toBe('UNKNOWN');
    expect(result.statusCounts.UNKNOWN).toBe(1);
  });

  it('+5% → FLAT', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_F', priceUsd: 0.01 });
    const fetch = makeFetch({ MINT_F: 0.0105 });
    const result = await runOutcomeTracker(makeOptions([f], fetch));
    expect(result.candidates[0]!.status).toBe('FLAT');
    expect(result.statusCounts.FLAT).toBe(1);
  });

  it('-20% → DUMPED', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_D', priceUsd: 0.01 });
    const fetch = makeFetch({ MINT_D: 0.008 });
    const result = await runOutcomeTracker(makeOptions([f], fetch));
    expect(result.candidates[0]!.status).toBe('DUMPED');
    expect(result.statusCounts.DUMPED).toBe(1);
  });
});

// ── runOutcomeTracker: raw.entry / raw.final price extraction ────────────────

/** Build a fixture whose raw field mirrors the real live-fixture structure (raw.entry/raw.final). */
function makeLiveCandidateFixture(opts: {
  contract: string;
  symbol: string;
  entryPriceUsd: number;
  finalPriceUsd?: number;
} ): LiveRipperFixture {
  const contract = opts.contract;
  const entrySnap = {
    contract,
    chainId:      'solana',
    pairAddress:  `PAIR_${contract}`,
    pairUrl:      `https://dexscreener.com/solana/PAIR_${contract}`,
    symbol:       opts.symbol,
    priceUsd:     opts.entryPriceUsd,
    liquidityUsd: 80000,
    observedAt:   '2026-06-10T08:43:13.000Z',
  };
  const finalSnap = {
    ...entrySnap,
    priceUsd:    opts.finalPriceUsd ?? opts.entryPriceUsd,
    observedAt: '2026-06-10T08:44:15.000Z',
  };
  return makeFixture({
    capturedAt: '2026-06-10T08:46:49.889Z',
    raw: {
      contract,
      chainId:      'solana',
      pairUrl:      entrySnap.pairUrl,
      clusterRisk:  'CLEAN',
      slippageRisk: 'CLEAN',
      routeFound:   true,
      quoteCheckedAt:          '2026-06-10T08:43:00.000Z',
      holderConcentrationStatus: 'CLEAN',
      topHolderPercent:        9.5,
      entry: entrySnap,
      final: finalSnap,
    },
    normalizedSignal: {
      id:      `sig-${contract}`,
      contract,
      symbol:  opts.symbol,
      chainId: 'solana',
    } as LiveRipperFixture['normalizedSignal'],
    ripperInput: { contract, volumeLiquidityRatio: 0.5 } as unknown as LiveRipperFixture['ripperInput'],
  });
}

describe('runOutcomeTracker — raw.entry/raw.final price extraction', () => {
  it('reads detectedPriceUsd from raw.entry.priceUsd', async () => {
    const f = makeLiveCandidateFixture({ contract: 'MINT_LIVE', symbol: 'LIVE', entryPriceUsd: 0.001211 });
    const opts = makeOptions([f], nullFetch);
    const result = await runOutcomeTracker(opts);
    expect(result.candidateCount).toBe(1);
    expect(result.candidates[0]!.detectedPriceUsd).toBeCloseTo(0.001211, 6);
  });

  it('reads pairUrl from raw.entry.pairUrl (not normalizedSignal)', async () => {
    const f = makeLiveCandidateFixture({ contract: 'MINT_PU', symbol: 'PU', entryPriceUsd: 0.001 });
    const opts = makeOptions([f], nullFetch);
    const result = await runOutcomeTracker(opts);
    expect(result.candidates[0]!.pairUrl).toContain('dexscreener.com');
  });

  it('falls back to raw.final.priceUsd when raw.entry has no priceUsd', async () => {
    const f = makeFixture({
      raw: {
        contract:                  'MINT_FALLBACK',
        clusterRisk:               'CLEAN',
        slippageRisk:              'CLEAN',
        routeFound:                true,
        quoteCheckedAt:            '2026-06-10T08:00:00.000Z',
        holderConcentrationStatus: 'CLEAN',
        // entry exists but no priceUsd
        entry: { contract: 'MINT_FALLBACK', chainId: 'solana', observedAt: '2026-06-10T08:43:00.000Z' },
        final: { contract: 'MINT_FALLBACK', chainId: 'solana', priceUsd: 0.0005, observedAt: '2026-06-10T08:44:00.000Z' },
      },
      ripperInput: { contract: 'MINT_FALLBACK', volumeLiquidityRatio: 0.5 } as unknown as LiveRipperFixture['ripperInput'],
      normalizedSignal: {
        id: 'sig-fb', contract: 'MINT_FALLBACK', symbol: 'FALLBACK', chainId: 'solana',
      } as LiveRipperFixture['normalizedSignal'],
    });
    const opts = makeOptions([f], nullFetch);
    const result = await runOutcomeTracker(opts);
    expect(result.candidates[0]!.detectedPriceUsd).toBeCloseTo(0.0005, 6);
  });

  it('XRPS-style fixture: raw.entry.priceUsd yields real return % when latest price fetched', async () => {
    const f = makeLiveCandidateFixture({
      contract:      '7XLu71Wvq7zuNU7TP5qjYY8kqg9zxtrsb7sJEEF6pump',
      symbol:        'XRPS',
      entryPriceUsd: 0.001211,
    });
    // Simulate DexScreener returning a 2× price
    const fetch = makeFetch({ '7XLu71Wvq7zuNU7TP5qjYY8kqg9zxtrsb7sJEEF6pump': 0.002422 });
    const result = await runOutcomeTracker(makeOptions([f], fetch));
    const c = result.candidates[0]!;
    expect(c.detectedPriceUsd).toBeCloseTo(0.001211, 6);
    expect(c.currentReturnPct).toBeCloseTo(100, 3);
    expect(c.status).toBe('RIPPED');
    expect(c.status).not.toBe('UNKNOWN');
  });

  it('XRPS-style fixture: status is UNKNOWN only when fetch returns null (no latest price)', async () => {
    const f = makeLiveCandidateFixture({
      contract:      '7XLu71Wvq7zuNU7TP5qjYY8kqg9zxtrsb7sJEEF6pump',
      symbol:        'XRPS',
      entryPriceUsd: 0.001211,
    });
    const result = await runOutcomeTracker(makeOptions([f], nullFetch));
    const c = result.candidates[0]!;
    // Entry price is known — only UNKNOWN because latest price unavailable
    expect(c.detectedPriceUsd).toBeCloseTo(0.001211, 6);
    expect(c.latestPriceUsd).toBeNull();
    expect(c.status).toBe('UNKNOWN');
  });

  it('uses raw.entry.observedAt as detectedAt', async () => {
    const f = makeLiveCandidateFixture({ contract: 'MINT_TS', symbol: 'TS', entryPriceUsd: 0.001 });
    const opts = makeOptions([f], nullFetch);
    const result = await runOutcomeTracker(opts);
    expect(result.candidates[0]!.detectedAt).toBe('2026-06-10T08:43:13.000Z');
  });

  it('normalizedSignal.priceUsd still works as fallback when no raw.entry', async () => {
    // makeCandidateFixture sets priceUsd in normalizedSignal, raw has no entry/final
    const f = makeCandidateFixture({ contract: 'MINT_SIG', priceUsd: 0.042 });
    const opts = makeOptions([f], nullFetch);
    const result = await runOutcomeTracker(opts);
    expect(result.candidates[0]!.detectedPriceUsd).toBeCloseTo(0.042, 5);
  });
});

// ── runOutcomeTracker: safety invariants ─────────────────────────────────────

describe('runOutcomeTracker — safety invariants', () => {
  it('never sets tradingExecuted > 0', async () => {
    const f = makeCandidateFixture({ priceUsd: 0.01 });
    const fetch = makeFetch({ MINT_AAA: 0.02 });
    const result = await runOutcomeTracker(makeOptions([f], fetch));
    expect(result.tradingExecuted).toBe(0);
  });

  it('always sets noRealTradeSent = true', async () => {
    const result = await runOutcomeTracker(makeOptions([makeCandidateFixture()]));
    expect(result.noRealTradeSent).toBe(true);
  });

  it('always sets paperOnly = true', async () => {
    const result = await runOutcomeTracker(makeOptions([makeCandidateFixture()]));
    expect(result.paperOnly).toBe(true);
  });

  it('always sets readOnly = true', async () => {
    const result = await runOutcomeTracker(makeOptions([makeCandidateFixture()]));
    expect(result.readOnly).toBe(true);
  });
});

// ── renderOutcomeTrackerReport ────────────────────────────────────────────────

describe('renderOutcomeTrackerReport', () => {
  it('includes REAL TRADING LOCKED header', async () => {
    const result = await runOutcomeTracker(makeOptions([makeCandidateFixture()]));
    const report = renderOutcomeTrackerReport(result);
    expect(report).toContain('REAL TRADING LOCKED');
  });

  it('includes REAL TRADING LOCKED in missing-file report', () => {
    const result = {
      inputPath: '/tmp/missing.jsonl',
      inputMissing: true,
      generatedAt: '2026-06-10T10:00:00.000Z',
      candidateCount: 0,
      statusCounts: { RIPPED: 0, MOVED: 0, FLAT: 0, DUMPED: 0, UNKNOWN: 0 },
      candidates: [],
      tradingExecuted: 0 as const,
      noRealTradeSent: true as const,
      paperOnly: true as const,
      readOnly: true as const,
    };
    expect(renderOutcomeTrackerReport(result)).toContain('REAL TRADING LOCKED');
  });

  it('shows symbol in candidate row', async () => {
    const f = makeCandidateFixture({ symbol: 'XRPS', priceUsd: null });
    const result = await runOutcomeTracker(makeOptions([f]));
    const report = renderOutcomeTrackerReport(result);
    expect(report).toContain('XRPS');
  });

  it('shows UNKNOWN status for null-price candidates', async () => {
    const f = makeCandidateFixture({ priceUsd: null });
    const result = await runOutcomeTracker(makeOptions([f]));
    const report = renderOutcomeTrackerReport(result);
    expect(report).toContain('UNKNOWN');
  });

  it('shows return % when both prices available', async () => {
    const f = makeCandidateFixture({ contract: 'MINT_SHOW', priceUsd: 0.01 });
    const fetch = makeFetch({ MINT_SHOW: 0.015 });
    const result = await runOutcomeTracker(makeOptions([f], fetch));
    const report = renderOutcomeTrackerReport(result);
    expect(report).toContain('RIPPED');
  });

  it('contains pairUrl when set', async () => {
    const f = makeCandidateFixture();
    (f.normalizedSignal as Record<string, unknown>)['pairUrl'] = 'https://dexscreener.com/solana/PAIRADDR';
    const result = await runOutcomeTracker(makeOptions([f]));
    const report = renderOutcomeTrackerReport(result);
    expect(report).toContain('dexscreener.com');
  });

  it('does not contain sendTransaction', async () => {
    const f = makeCandidateFixture({ priceUsd: 0.01 });
    const fetch = makeFetch({ MINT_AAA: 0.02 });
    const result = await runOutcomeTracker(makeOptions([f], fetch));
    const report = renderOutcomeTrackerReport(result);
    expect(report).not.toContain('sendTransaction');
    expect(report).not.toContain('signTransaction');
  });

  it('mentions candidate count', async () => {
    const a = makeCandidateFixture({ contract: 'MINT_AAA', symbol: 'AAA' });
    const b = makeCandidateFixture({ contract: 'MINT_BBB', symbol: 'BBB' });
    const result = await runOutcomeTracker(makeOptions([a, b]));
    const report = renderOutcomeTrackerReport(result);
    expect(report).toContain('2');
  });
});
