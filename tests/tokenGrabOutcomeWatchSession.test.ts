import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import {
  buildWatchSnapshot,
  runOutcomeWatchSession,
  renderOutcomeWatchSessionReport,
  type OutcomeWatchSessionOptions,
  type OutcomeWatchSnapshot,
} from '../src/token-grab/outcomeWatchSession';
import { type LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';
import { type DexPairSnapshot } from '../src/token-grab/dexWatch';
import { type OutcomeCandidate } from '../src/token-grab/outcomeTracker';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLiveFixture(opts: {
  contract:    string;
  symbol:      string;
  entryPrice:  number;
  finalPrice?: number;
  entryAt?:    string;
  finalAt?:    string;
  bubbleMaps?: number;
}): LiveRipperFixture {
  const contract   = opts.contract;
  const entryPrice = opts.entryPrice;
  const finalPrice = opts.finalPrice ?? entryPrice;
  const entryAt    = opts.entryAt    ?? '2026-06-10T08:43:13.000Z';
  const finalAt    = opts.finalAt    ?? '2026-06-10T08:44:15.000Z';

  return {
    id:           `fix-${contract}`,
    capturedAt:   '2026-06-10T08:46:49.889Z',
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
      holderConcentrationStatus: 'CLEAN',
      topHolderPercent:          9.5,
      liquidityTradable:         'GOOD',
      estimatedSlippagePct:      2.5,
      clusterRawMetrics: {
        decentralisationScore: opts.bubbleMaps ?? 78.5,
      },
      entry: {
        contract, chainId: 'solana', symbol: opts.symbol,
        priceUsd: entryPrice, liquidityUsd: 80000, volumeUsd: 8000,
        observedAt: entryAt,
      },
      final: {
        contract, chainId: 'solana', symbol: opts.symbol,
        priceUsd: finalPrice, liquidityUsd: 80000,
        observedAt: finalAt,
      },
    },
    normalizedSignal: {
      id: `sig-${contract}`, contract, symbol: opts.symbol, chainId: 'solana',
    } as LiveRipperFixture['normalizedSignal'],
    ripperInput: { contract, volumeLiquidityRatio: 0.5 } as unknown as LiveRipperFixture['ripperInput'],
    entryDecision:   'BUY_APPROVED_PAPER',
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers: [], topReasons: [], warnings: [],
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

const nullFetch = async (): Promise<DexPairSnapshot | null> => null;

function makeFetch(prices: Record<string, number | null>) {
  return async (contract: string, _chain: string, observedAt: string): Promise<DexPairSnapshot | null> => {
    if (!(contract in prices)) return null;
    const price = prices[contract];
    if (price === null) return null;
    return {
      contract, chainId: 'solana',
      priceUsd: price, liquidityUsd: 50000, volumeUsd: 3000,
      pairAddress: `PAIR_ADDR_${contract}`,
      observedAt,
    };
  };
}

let counter = 0;
function makeOptions(
  fixtures:    LiveRipperFixture[],
  fetchImpl:   OutcomeWatchSessionOptions['fetch'] = nullFetch,
  extraOpts:   Partial<OutcomeWatchSessionOptions> = {},
): OutcomeWatchSessionOptions {
  const tmpIn  = `/tmp/test-ows-in-${++counter}.jsonl`;
  const tmpOut = `/tmp/test-ows-out-${counter}.jsonl`;
  writeFileSync(tmpIn, fixtures.map(f => JSON.stringify(f)).join('\n'));
  const written: string[] = [];
  return {
    inputPath:   tmpIn,
    outputPath:  tmpOut,
    generatedAt: '2026-06-10T10:00:00.000Z',
    cycles:      1,
    fetch:       fetchImpl,
    sleep:       async () => { /* no-op */ },
    appendLine:  (_path, line) => written.push(line),
    ...extraOpts,
    _writtenLines: written,
  } as OutcomeWatchSessionOptions & { _writtenLines: string[] };
}

// ── buildWatchSnapshot: unit tests ────────────────────────────────────────────

describe('buildWatchSnapshot', () => {
  const baseCandidate: OutcomeCandidate = {
    contract:         'MINT_A',
    symbol:           'A',
    chainId:          'solana',
    pairUrl:          'https://dexscreener.com/solana/PAIR_MINT_A',
    pairAddress:      null,
    detectedAt:       '2026-06-10T08:43:13.000Z',
    detectedPriceUsd: 0.01,
    latestPriceUsd:   null,
    liquidityUsd:     80000,
    topHolderPercent: 9.5,
    clusterRisk:      'CLEAN',
    currentReturnPct: null,
    status:           'UNKNOWN',
  };

  it('computes returnPctFromEntry with latest snap', () => {
    const snap: DexPairSnapshot = { contract: 'MINT_A', chainId: 'solana', priceUsd: 0.014, observedAt: '2026-06-10T10:00:00.000Z' };
    const r = buildWatchSnapshot(baseCandidate, undefined, snap, '2026-06-10T10:00:00.000Z');
    expect(r.returnPctFromEntry).toBeCloseTo(40, 3);
  });

  it('returns null returnPctFromEntry when latest snap is null', () => {
    const r = buildWatchSnapshot(baseCandidate, undefined, null, '2026-06-10T10:00:00.000Z');
    expect(r.returnPctFromEntry).toBeNull();
    expect(r.latestPriceUsd).toBeNull();
  });

  it('reads entryObservedAt from raw.entry.observedAt', () => {
    const fixture = makeLiveFixture({ contract: 'MINT_B', symbol: 'B', entryPrice: 0.01, entryAt: '2026-06-10T08:43:13.000Z' });
    const r = buildWatchSnapshot(baseCandidate, fixture, null, '2026-06-10T10:00:00.000Z');
    expect(r.entryObservedAt).toBe('2026-06-10T08:43:13.000Z');
  });

  it('reads bubbleMapsScore from raw.clusterRawMetrics.decentralisationScore', () => {
    const fixture = makeLiveFixture({ contract: 'MINT_BM', symbol: 'BM', entryPrice: 0.01, bubbleMaps: 82.3 });
    const r = buildWatchSnapshot(baseCandidate, fixture, null, '2026-06-10T10:00:00.000Z');
    expect(r.bubbleMapsScore).toBeCloseTo(82.3, 3);
  });

  it('reads slippageRisk and estimatedSlippagePct from raw', () => {
    const fixture = makeLiveFixture({ contract: 'MINT_SR', symbol: 'SR', entryPrice: 0.01 });
    const r = buildWatchSnapshot(baseCandidate, fixture, null, '2026-06-10T10:00:00.000Z');
    expect(r.slippageRisk).toBe('CLEAN');
    expect(r.estimatedSlippagePct).toBeCloseTo(2.5, 5);
  });

  it('reads holderConcentrationStatus and topHolderPercent from raw', () => {
    const fixture = makeLiveFixture({ contract: 'MINT_HC', symbol: 'HC', entryPrice: 0.01 });
    const r = buildWatchSnapshot(baseCandidate, fixture, null, '2026-06-10T10:00:00.000Z');
    expect(r.holderConcentrationStatus).toBe('CLEAN');
    expect(r.topHolderPercent).toBeCloseTo(9.5, 3);
  });

  it('prefers pairAddress and pairUrl from latest snap over candidate', () => {
    const snap: DexPairSnapshot = {
      contract: 'MINT_A', chainId: 'solana',
      priceUsd: 0.01, pairAddress: 'SNAP_PAIR_ADDR', pairUrl: 'https://snap-url',
      observedAt: '2026-06-10T10:00:00.000Z',
    };
    const r = buildWatchSnapshot(baseCandidate, undefined, snap, '2026-06-10T10:00:00.000Z');
    expect(r.pairAddress).toBe('SNAP_PAIR_ADDR');
    expect(r.pairUrl).toBe('https://snap-url');
  });

  it('source is always outcome-watch-session', () => {
    const r = buildWatchSnapshot(baseCandidate, undefined, null, '2026-06-10T10:00:00.000Z');
    expect(r.source).toBe('outcome-watch-session');
  });

  it('latestLiquidityUsd and latestVolumeUsd come from latest snap', () => {
    const snap: DexPairSnapshot = {
      contract: 'MINT_A', chainId: 'solana',
      priceUsd: 0.01, liquidityUsd: 55000, volumeUsd: 4200,
      observedAt: '2026-06-10T10:00:00.000Z',
    };
    const r = buildWatchSnapshot(baseCandidate, undefined, snap, '2026-06-10T10:00:00.000Z');
    expect(r.latestLiquidityUsd).toBeCloseTo(55000, 0);
    expect(r.latestVolumeUsd).toBeCloseTo(4200, 0);
  });
});

// ── runOutcomeWatchSession: candidate identification ──────────────────────────

describe('runOutcomeWatchSession — candidate identification', () => {
  it('returns inputMissing=true for nonexistent file', async () => {
    const r = await runOutcomeWatchSession({ inputPath: '/tmp/nonexistent-ows.jsonl' });
    expect(r.inputMissing).toBe(true);
    expect(r.candidatesFound).toBe(0);
  });

  it('identifies FUTURE_AUTONOMY_CANDIDATE via existing logic', async () => {
    const f = makeLiveFixture({ contract: 'MINT_ID', symbol: 'ID', entryPrice: 0.01 });
    const opts = makeOptions([f], nullFetch);
    const r = await runOutcomeWatchSession(opts);
    expect(r.candidatesFound).toBe(1);
  });

  it('finds 0 candidates when fixture file is empty', async () => {
    const tmpIn  = `/tmp/test-ows-empty-${++counter}.jsonl`;
    const tmpOut = `/tmp/test-ows-empty-out-${counter}.jsonl`;
    writeFileSync(tmpIn, '');
    const r = await runOutcomeWatchSession({
      inputPath: tmpIn, outputPath: tmpOut,
      cycles: 1, fetch: nullFetch,
    });
    expect(r.candidatesFound).toBe(0);
    expect(r.snapshotsWritten).toBe(0);
  });
});

// ── runOutcomeWatchSession: JSONL output ──────────────────────────────────────

describe('runOutcomeWatchSession — writes JSONL snapshots', () => {
  it('calls appendLine once per candidate per cycle', async () => {
    const f = makeLiveFixture({ contract: 'MINT_WR', symbol: 'WR', entryPrice: 0.01 });
    const written: string[] = [];
    const opts = makeOptions([f], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = (_p: string, line: string) => written.push(line);
    await runOutcomeWatchSession(opts);
    expect(written).toHaveLength(1);
  });

  it('snapshot line is valid JSON with required fields', async () => {
    const f = makeLiveFixture({ contract: 'MINT_JSON', symbol: 'JSN', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_JSON: 0.012 });
    const written: string[] = [];
    const opts = makeOptions([f], fetch);
    (opts as Record<string, unknown>)['appendLine'] = (_p: string, line: string) => written.push(line);
    await runOutcomeWatchSession(opts);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]!) as OutcomeWatchSnapshot;
    expect(parsed.contract).toBe('MINT_JSON');
    expect(parsed.symbol).toBe('JSN');
    expect(parsed.source).toBe('outcome-watch-session');
    expect(typeof parsed.observedAt).toBe('string');
    expect(parsed.entryPriceUsd).toBeCloseTo(0.01, 6);
    expect(parsed.latestPriceUsd).toBeCloseTo(0.012, 6);
  });

  it('writes 2 snapshots for 2 cycles', async () => {
    const f = makeLiveFixture({ contract: 'MINT_CY', symbol: 'CY', entryPrice: 0.01 });
    const written: string[] = [];
    const opts = makeOptions([f], nullFetch, { cycles: 2 });
    (opts as Record<string, unknown>)['appendLine'] = (_p: string, line: string) => written.push(line);
    await runOutcomeWatchSession(opts);
    expect(written).toHaveLength(2);
    expect((await runOutcomeWatchSession({ ...opts, appendLine: (_p, l) => written.push(l) })).cyclesCompleted).toBe(2);
  });

  it('writes snapshot with null latestPriceUsd when fetch returns null', async () => {
    const f = makeLiveFixture({ contract: 'MINT_NULL', symbol: 'NL', entryPrice: 0.01 });
    const written: string[] = [];
    const opts = makeOptions([f], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = (_p: string, line: string) => written.push(line);
    await runOutcomeWatchSession(opts);
    const parsed = JSON.parse(written[0]!) as OutcomeWatchSnapshot;
    expect(parsed.latestPriceUsd).toBeNull();
    expect(parsed.returnPctFromEntry).toBeNull();
    expect(parsed.source).toBe('outcome-watch-session');
  });
});

// ── runOutcomeWatchSession: return computation ────────────────────────────────

describe('runOutcomeWatchSession — returnPctFromEntry', () => {
  it('computes positive return correctly', async () => {
    const f = makeLiveFixture({ contract: 'MINT_POS', symbol: 'POS', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_POS: 0.015 });
    const snaps: OutcomeWatchSnapshot[] = [];
    const opts = makeOptions([f], fetch);
    (opts as Record<string, unknown>)['appendLine'] = (_p: string, line: string) =>
      snaps.push(JSON.parse(line) as OutcomeWatchSnapshot);
    const r = await runOutcomeWatchSession(opts);
    expect(snaps[0]!.returnPctFromEntry).toBeCloseTo(50, 3);
    expect(r.bestReturnPct).toBeCloseTo(50, 3);
  });

  it('computes negative return correctly', async () => {
    const f = makeLiveFixture({ contract: 'MINT_NEG', symbol: 'NEG', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_NEG: 0.007 });
    const snaps: OutcomeWatchSnapshot[] = [];
    const opts = makeOptions([f], fetch);
    (opts as Record<string, unknown>)['appendLine'] = (_p: string, line: string) =>
      snaps.push(JSON.parse(line) as OutcomeWatchSnapshot);
    const r = await runOutcomeWatchSession(opts);
    expect(snaps[0]!.returnPctFromEntry).toBeCloseTo(-30, 3);
    expect(r.worstReturnPct).toBeCloseTo(-30, 3);
  });
});

// ── runOutcomeWatchSession: --limit behavior ──────────────────────────────────

describe('runOutcomeWatchSession — limit', () => {
  it('limits candidates to N when limit is set', async () => {
    const f1 = makeLiveFixture({ contract: 'MINT_L1', symbol: 'L1', entryPrice: 0.01 });
    const f2 = makeLiveFixture({ contract: 'MINT_L2', symbol: 'L2', entryPrice: 0.02 });
    const written: string[] = [];
    const opts = makeOptions([f1, f2], nullFetch, { limit: 1 });
    (opts as Record<string, unknown>)['appendLine'] = (_p: string, line: string) => written.push(line);
    const r = await runOutcomeWatchSession(opts);
    expect(r.snapshotsWritten).toBe(1);
    expect(written).toHaveLength(1);
  });

  it('writes all candidates when no limit set', async () => {
    const f1 = makeLiveFixture({ contract: 'MINT_NL1', symbol: 'NL1', entryPrice: 0.01 });
    const f2 = makeLiveFixture({ contract: 'MINT_NL2', symbol: 'NL2', entryPrice: 0.02 });
    const written: string[] = [];
    const opts = makeOptions([f1, f2], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = (_p: string, line: string) => written.push(line);
    const r = await runOutcomeWatchSession(opts);
    expect(r.snapshotsWritten).toBe(2);
    expect(written).toHaveLength(2);
  });
});

// ── runOutcomeWatchSession: hit counts ───────────────────────────────────────

describe('runOutcomeWatchSession — hit counts', () => {
  it('increments hitTp25Count for return >= 25%', async () => {
    const f = makeLiveFixture({ contract: 'MINT_TP', symbol: 'TP', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_TP: 0.014 }); // +40%
    const opts = makeOptions([f], fetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    expect(r.hitTp25Count).toBe(1);
    expect(r.hitSl15Count).toBe(0);
  });

  it('increments hitSl15Count for return <= -15%', async () => {
    const f = makeLiveFixture({ contract: 'MINT_SL', symbol: 'SL', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_SL: 0.008 }); // -20%
    const opts = makeOptions([f], fetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    expect(r.hitSl15Count).toBe(1);
    expect(r.hitTp25Count).toBe(0);
  });

  it('counts 0 hits when no price available', async () => {
    const f = makeLiveFixture({ contract: 'MINT_NHT', symbol: 'NHT', entryPrice: 0.01 });
    const opts = makeOptions([f], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    expect(r.hitTp25Count).toBe(0);
    expect(r.hitSl15Count).toBe(0);
  });
});

// ── runOutcomeWatchSession: aggregates ───────────────────────────────────────

describe('runOutcomeWatchSession — aggregates', () => {
  it('tracks best and worst return across candidates', async () => {
    const f1 = makeLiveFixture({ contract: 'MINT_AG1', symbol: 'AG1', entryPrice: 0.01 });
    const f2 = makeLiveFixture({ contract: 'MINT_AG2', symbol: 'AG2', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_AG1: 0.02, MINT_AG2: 0.005 }); // +100%, -50%
    const opts = makeOptions([f1, f2], fetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    expect(r.bestReturnPct).toBeCloseTo(100, 3);
    expect(r.worstReturnPct).toBeCloseTo(-50, 3);
  });

  it('snapshotsWritten equals candidatesFound * cyclesCompleted', async () => {
    const f1 = makeLiveFixture({ contract: 'MINT_SW1', symbol: 'SW1', entryPrice: 0.01 });
    const f2 = makeLiveFixture({ contract: 'MINT_SW2', symbol: 'SW2', entryPrice: 0.01 });
    const opts = makeOptions([f1, f2], nullFetch, { cycles: 3 });
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    expect(r.snapshotsWritten).toBe(6); // 2 candidates × 3 cycles
    expect(r.cyclesCompleted).toBe(3);
  });

  it('returns candidatesFound in result', async () => {
    const f = makeLiveFixture({ contract: 'MINT_CF', symbol: 'CF', entryPrice: 0.01 });
    const opts = makeOptions([f], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    expect(r.candidatesFound).toBe(1);
  });
});

// ── Safety invariants ─────────────────────────────────────────────────────────

describe('runOutcomeWatchSession — safety invariants', () => {
  it('tradingExecuted is always 0', async () => {
    const opts = makeOptions([], nullFetch);
    const r = await runOutcomeWatchSession(opts);
    expect(r.tradingExecuted).toBe(0);
  });

  it('noRealTradeSent is always true', async () => {
    const opts = makeOptions([], nullFetch);
    const r = await runOutcomeWatchSession(opts);
    expect(r.noRealTradeSent).toBe(true);
  });

  it('paperOnly is always true', async () => {
    const opts = makeOptions([], nullFetch);
    const r = await runOutcomeWatchSession(opts);
    expect(r.paperOnly).toBe(true);
  });

  it('readOnly is always true', async () => {
    const opts = makeOptions([], nullFetch);
    const r = await runOutcomeWatchSession(opts);
    expect(r.readOnly).toBe(true);
  });

  it('source field on snapshots is outcome-watch-session not a swap', async () => {
    const f = makeLiveFixture({ contract: 'MINT_SRC', symbol: 'SRC', entryPrice: 0.01 });
    const written: string[] = [];
    const opts = makeOptions([f], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = (_p: string, line: string) => written.push(line);
    await runOutcomeWatchSession(opts);
    const snap = JSON.parse(written[0]!) as OutcomeWatchSnapshot;
    expect(snap.source).toBe('outcome-watch-session');
    expect(String(snap.source)).not.toContain('swap');
    expect(String(snap.source)).not.toContain('trade');
  });
});

// ── renderOutcomeWatchSessionReport ──────────────────────────────────────────

describe('renderOutcomeWatchSessionReport', () => {
  it('includes REAL TRADING LOCKED', async () => {
    const f = makeLiveFixture({ contract: 'MINT_RT', symbol: 'RT', entryPrice: 0.01 });
    const opts = makeOptions([f], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    expect(renderOutcomeWatchSessionReport(r)).toContain('REAL TRADING LOCKED');
  });

  it('includes REAL TRADING LOCKED on missing-file result', () => {
    const r: Parameters<typeof renderOutcomeWatchSessionReport>[0] = {
      inputPath: '/tmp/none.jsonl', outputPath: '/tmp/out.jsonl',
      inputMissing: true, generatedAt: '2026-06-10T10:00:00.000Z',
      cyclesCompleted: 0, candidatesFound: 0, snapshotsWritten: 0,
      bestReturnPct: null, worstReturnPct: null,
      hitTp25Count: 0, hitSl15Count: 0, snapshots: [],
      tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
    };
    expect(renderOutcomeWatchSessionReport(r)).toContain('REAL TRADING LOCKED');
  });

  it('shows candidates found, snapshots written, cycles completed', async () => {
    const f = makeLiveFixture({ contract: 'MINT_SUM', symbol: 'SUM', entryPrice: 0.01 });
    const opts = makeOptions([f], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    const report = renderOutcomeWatchSessionReport(r);
    expect(report).toContain('1'); // candidatesFound
    expect(report).toContain('Snapshots written');
    expect(report).toContain('Cycles completed');
  });

  it('shows output path', async () => {
    const f = makeLiveFixture({ contract: 'MINT_OP', symbol: 'OP', entryPrice: 0.01 });
    const opts = makeOptions([f], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    const report = renderOutcomeWatchSessionReport(r);
    expect(report).toContain(r.outputPath);
  });

  it('shows hit TP25 and hit SL15 counts', async () => {
    const f = makeLiveFixture({ contract: 'MINT_HC2', symbol: 'HC2', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_HC2: 0.014 }); // +40% → hits TP25
    const opts = makeOptions([f], fetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    const report = renderOutcomeWatchSessionReport(r);
    expect(report).toContain('Hit TP25');
    expect(report).toContain('Hit SL15');
  });

  it('shows tradingExecuted=0 in footer', async () => {
    const f = makeLiveFixture({ contract: 'MINT_FT', symbol: 'FT', entryPrice: 0.01 });
    const opts = makeOptions([f], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    expect(renderOutcomeWatchSessionReport(r)).toContain('tradingExecuted=0');
  });

  it('does not contain sendTransaction or signTransaction', async () => {
    const f = makeLiveFixture({ contract: 'MINT_NS', symbol: 'NS', entryPrice: 0.01 });
    const opts = makeOptions([f], nullFetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    const report = renderOutcomeWatchSessionReport(r);
    expect(report).not.toContain('sendTransaction');
    expect(report).not.toContain('signTransaction');
    expect(report).not.toContain('swap(');
  });

  it('shows best and worst return when prices are available', async () => {
    const f = makeLiveFixture({ contract: 'MINT_BW', symbol: 'BW', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_BW: 0.013 }); // +30%
    const opts = makeOptions([f], fetch);
    (opts as Record<string, unknown>)['appendLine'] = () => {};
    const r = await runOutcomeWatchSession(opts);
    const report = renderOutcomeWatchSessionReport(r);
    expect(report).toContain('Best return');
    expect(report).toContain('Worst return');
  });
});
