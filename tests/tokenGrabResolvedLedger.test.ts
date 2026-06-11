import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import * as RCL from '../src/token-grab/resolvedCandidateLedger';
import {
  runResolvedLedger,
  renderResolvedLedgerReport,
  type ResolvedLedgerOptions,
  type LedgerRow,
} from '../src/token-grab/resolvedCandidateLedger';
import { type LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';
import { type DexPairSnapshot } from '../src/token-grab/dexWatch';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeLiveFixture(opts: {
  contract:    string;
  symbol:      string;
  entryPrice:  number;
  finalPrice?: number;
  entryAt?:    string;
  finalAt?:    string;
  capturedAt?: string;
  entryLiq?:   number;
  entryVol?:   number;
  bubbleMaps?: number;
}): LiveRipperFixture {
  const contract   = opts.contract;
  const entryPrice = opts.entryPrice;
  const finalPrice = opts.finalPrice ?? entryPrice;
  const entryAt    = opts.entryAt    ?? '2026-06-10T08:43:13.000Z';
  const finalAt    = opts.finalAt    ?? '2026-06-10T08:44:15.000Z';

  return {
    id:         `fix-${contract}`,
    capturedAt: opts.capturedAt ?? '2026-06-10T08:46:49.889Z',
    source:     'test',
    sourceKind: 'FRESH_POOL',
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
      clusterRawMetrics:         { decentralisationScore: opts.bubbleMaps ?? 75.0 },
      entry: {
        contract, chainId: 'solana', symbol: opts.symbol,
        priceUsd:    entryPrice,
        liquidityUsd: opts.entryLiq ?? 80000,
        volumeUsd:    opts.entryVol ?? 8000,
        observedAt:  entryAt,
      },
      final: {
        contract, chainId: 'solana', symbol: opts.symbol,
        priceUsd:    finalPrice,
        liquidityUsd: (opts.entryLiq ?? 80000) * 0.9,
        observedAt:  finalAt,
      },
    },
    normalizedSignal: {
      id: `sig-${contract}`, contract, symbol: opts.symbol, chainId: 'solana',
    } as LiveRipperFixture['normalizedSignal'],
    ripperInput: { contract, volumeLiquidityRatio: 0.1 } as unknown as LiveRipperFixture['ripperInput'],
    entryDecision:   'BUY_APPROVED_PAPER',
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers: [], topReasons: [], warnings: [],
    realTradingLocked: true, paperOnly: true, readOnly: true,
  };
}

const nullFetch = async (): Promise<DexPairSnapshot | null> => null;

function makeFetch(prices: Record<string, number | null>) {
  return async (contract: string, _chain: string, observedAt: string): Promise<DexPairSnapshot | null> => {
    if (!(contract in prices) || prices[contract] === null) return null;
    return { contract, chainId: 'solana', priceUsd: prices[contract]!, observedAt };
  };
}

interface WatchSpec { contract: string; price: number; observedAt: string; }
let watchCounter = 0;
function makeWatchFile(specs: WatchSpec[]): string {
  const f = `/tmp/test-rl-watch-${++watchCounter}.jsonl`;
  writeFileSync(f, specs.map(s => JSON.stringify({
    observedAt: s.observedAt, symbol: 'TST', contract: s.contract,
    pairAddress: null, pairUrl: null, chainId: 'solana',
    entryObservedAt: null, entryPriceUsd: null,
    latestPriceUsd: s.price, latestLiquidityUsd: 50000, latestVolumeUsd: 3000,
    returnPctFromEntry: null, holderConcentrationStatus: 'CLEAN', topHolderPercent: 9.5,
    clusterRisk: 'CLEAN', bubbleMapsScore: null, slippageRisk: 'CLEAN',
    estimatedSlippagePct: null, source: 'outcome-watch-session',
  })).join('\n'));
  return f;
}

let counter = 0;
function makeOptions(
  fixtures:        LiveRipperFixture[],
  fetchImpl        = nullFetch,
  watchInputPath   = '/tmp/nonexistent-rl-watch.jsonl',
  ledgerPathSuffix = '',
): ResolvedLedgerOptions {
  const n       = ++counter;
  const tmpIn   = `/tmp/test-rl-in-${n}.jsonl`;
  const ledger  = `/tmp/test-rl-ledger-${n}${ledgerPathSuffix}.jsonl`;
  writeFileSync(tmpIn, fixtures.map(f => JSON.stringify(f)).join('\n'));
  return {
    inputPath:      tmpIn,
    watchInputPath,
    ledgerPath:     ledger,
    generatedAt:    '2026-06-10T10:00:00.000Z',
    fetch:          fetchImpl,
  };
}

// ── Core: creates ledger from V2 records ──────────────────────────────────────

describe('runResolvedLedger — creates ledger', () => {
  it('returns inputMissing=true for nonexistent input', async () => {
    const r = await runResolvedLedger({ inputPath: '/tmp/nope-rl.jsonl' });
    expect(r.inputMissing).toBe(true);
    expect(r.totalRows).toBe(0);
  });

  it('creates one row per FUTURE_AUTONOMY_CANDIDATE', async () => {
    const f = makeLiveFixture({ contract: 'MINT_A', symbol: 'A', entryPrice: 0.01 });
    const r = await runResolvedLedger(makeOptions([f]));
    expect(r.totalRows).toBe(1);
    expect(r.rows[0]!.contract).toBe('MINT_A');
    expect(r.rows[0]!.symbol).toBe('A');
    expect(r.rows[0]!.source).toBe('resolved-ledger-v1');
  });

  it('writes ledger JSONL file with correct row', async () => {
    const f    = makeLiveFixture({ contract: 'MINT_B', symbol: 'B', entryPrice: 0.01 });
    const opts = makeOptions([f]);
    await runResolvedLedger(opts);
    expect(existsSync(opts.ledgerPath!)).toBe(true);
    const line = readFileSync(opts.ledgerPath!, 'utf-8').trim().split('\n')[0]!;
    const row  = JSON.parse(line) as LedgerRow;
    expect(row.contract).toBe('MINT_B');
    expect(row.source).toBe('resolved-ledger-v1');
  });

  it('creates two rows for two candidates', async () => {
    const f1 = makeLiveFixture({ contract: 'MINT_C1', symbol: 'C1', entryPrice: 0.01 });
    const f2 = makeLiveFixture({ contract: 'MINT_C2', symbol: 'C2', entryPrice: 0.02 });
    const r  = await runResolvedLedger(makeOptions([f1, f2]));
    expect(r.totalRows).toBe(2);
  });
});

// ── De-duplication ────────────────────────────────────────────────────────────

describe('runResolvedLedger — de-duplication', () => {
  it('de-dupes by contract on second run', async () => {
    const f    = makeLiveFixture({ contract: 'MINT_DD', symbol: 'DD', entryPrice: 0.01 });
    const opts = makeOptions([f]);
    await runResolvedLedger(opts);
    await runResolvedLedger(opts);  // second run
    const lines = readFileSync(opts.ledgerPath!, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1); // still 1 row
  });

  it('preserves firstSeenAt from original row on update', async () => {
    const f    = makeLiveFixture({ contract: 'MINT_FS', symbol: 'FS', entryPrice: 0.01 });
    const opts = makeOptions([f]);
    const r1   = await runResolvedLedger(opts);
    const r2   = await runResolvedLedger({ ...opts, generatedAt: '2026-06-10T12:00:00.000Z' });
    expect(r1.rows[0]!.firstSeenAt).toBe(r2.rows[0]!.firstSeenAt);
  });

  it('updates lastUpdatedAt on second run', async () => {
    const f    = makeLiveFixture({ contract: 'MINT_LU', symbol: 'LU', entryPrice: 0.01 });
    const opts = makeOptions([f]);
    const r1   = await runResolvedLedger(opts);
    const r2   = await runResolvedLedger({ ...opts, generatedAt: '2026-06-10T12:00:00.000Z' });
    expect(r2.rows[0]!.lastUpdatedAt).toBe('2026-06-10T12:00:00.000Z');
    expect(r2.rows[0]!.lastUpdatedAt).not.toBe(r1.rows[0]!.lastUpdatedAt);
  });

  it('updates latestPriceUsd when fetch returns new price', async () => {
    const f    = makeLiveFixture({ contract: 'MINT_UP', symbol: 'UP', entryPrice: 0.01 });
    const opts = makeOptions([f]);
    await runResolvedLedger(opts);  // no latest price
    const fetch2 = makeFetch({ MINT_UP: 0.015 });
    const r2 = await runResolvedLedger({ ...opts, fetch: fetch2 });
    expect(r2.rows[0]!.latestPriceUsd).toBeCloseTo(0.015, 6);
  });
});

// ── Resolved flag ─────────────────────────────────────────────────────────────

describe('runResolvedLedger — resolved flag', () => {
  it('marks resolved=true when snapshotCount >= 4 (via watch snapshots)', async () => {
    const contract = 'MINT_RES4';
    const f        = makeLiveFixture({ contract, symbol: 'RES4', entryPrice: 0.01 });
    const watchPath = makeWatchFile([
      { contract, price: 0.011, observedAt: '2026-06-10T09:00:00.000Z' },
      { contract, price: 0.012, observedAt: '2026-06-10T09:30:00.000Z' },
    ]);
    const r = await runResolvedLedger(makeOptions([f], nullFetch, watchPath));
    // entry + final + 2 watch = 4 snaps → resolved
    expect(r.rows[0]!.resolved).toBe(true);
    expect(r.resolvedRows).toBe(1);
  });

  it('marks resolved=false when snapshotCount < 4 and age < 30m', async () => {
    const f = makeLiveFixture({
      contract:  'MINT_UNRES',
      symbol:    'UNRES',
      entryPrice: 0.01,
      entryAt:   '2026-06-10T09:45:00.000Z', // 15 minutes before generatedAt
    });
    const r = await runResolvedLedger(makeOptions([f]));
    // entry + final = 2 snaps, age = 15 min → not resolved
    expect(r.rows[0]!.resolved).toBe(false);
    expect(r.unresolvedRows).toBe(1);
  });

  it('marks resolved=true when age >= 30 minutes even with 2 snaps', async () => {
    const f = makeLiveFixture({
      contract:  'MINT_AGEM',
      symbol:    'AGEM',
      entryPrice: 0.01,
      entryAt:   '2026-06-10T09:00:00.000Z',  // 60 min before generatedAt (10:00)
    });
    const r = await runResolvedLedger(makeOptions([f]));
    // entry + final = 2 snaps, but age = 60 min >= 30 → resolved
    expect(r.rows[0]!.resolved).toBe(true);
  });
});

// ── Checkpoint flags ──────────────────────────────────────────────────────────

describe('runResolvedLedger — hit flags', () => {
  it('hit25=true when maxKnownReturnPct >= 25', async () => {
    const f = makeLiveFixture({ contract: 'MINT_H25', symbol: 'H25', entryPrice: 0.01, finalPrice: 0.013 });
    const fetch = makeFetch({ MINT_H25: 0.005 });
    const r = await runResolvedLedger(makeOptions([f], fetch));
    expect(r.rows[0]!.hit25).toBe(true);
    expect(r.hit25Count).toBe(1);
  });

  it('hit50=true when maxKnownReturnPct >= 50', async () => {
    const f = makeLiveFixture({ contract: 'MINT_H50', symbol: 'H50', entryPrice: 0.01, finalPrice: 0.016 });
    const fetch = makeFetch({ MINT_H50: 0.005 });
    const r = await runResolvedLedger(makeOptions([f], fetch));
    expect(r.rows[0]!.hit50).toBe(true);
    expect(r.hit50Count).toBe(1);
  });

  it('hit100=true when maxKnownReturnPct >= 100', async () => {
    const f = makeLiveFixture({ contract: 'MINT_H100', symbol: 'H100', entryPrice: 0.01, finalPrice: 0.021 });
    const fetch = makeFetch({ MINT_H100: 0.005 });
    const r = await runResolvedLedger(makeOptions([f], fetch));
    expect(r.rows[0]!.hit100).toBe(true);
    expect(r.hit100Count).toBe(1);
  });

  it('hitSL15=true when minKnownReturnPct <= -15', async () => {
    const f = makeLiveFixture({ contract: 'MINT_SL', symbol: 'SL', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_SL: 0.008 }); // -20%
    const r = await runResolvedLedger(makeOptions([f], fetch));
    expect(r.rows[0]!.hitSL15).toBe(true);
    expect(r.hitSL15Count).toBe(1);
  });

  it('hit flags are all false when no price available', async () => {
    const f = makeLiveFixture({ contract: 'MINT_NH', symbol: 'NH', entryPrice: 0.01 });
    const r = await runResolvedLedger(makeOptions([f], nullFetch));
    expect(r.rows[0]!.hit25).toBe(false);
    expect(r.rows[0]!.hit50).toBe(false);
    expect(r.rows[0]!.hit100).toBe(false);
    expect(r.rows[0]!.hitSL15).toBe(false);
  });
});

// ── bestSimulatedExit ─────────────────────────────────────────────────────────

describe('runResolvedLedger — bestSimulatedExit', () => {
  it('bestSimulatedExit=tp25 when TP25 fires and beats hold', async () => {
    // entry=0.01, final=0.014 (+40%), latest=0.005 (-50%)
    // TP25 fires at +25%, hold = -50% → best = tp25
    const f = makeLiveFixture({ contract: 'MINT_BE1', symbol: 'BE1', entryPrice: 0.01, finalPrice: 0.014 });
    const fetch = makeFetch({ MINT_BE1: 0.005 });
    const r = await runResolvedLedger(makeOptions([f], fetch));
    expect(r.rows[0]!.bestSimulatedExit).toBe('tp25');
    expect(r.rows[0]!.bestSimulatedExitPct).toBeCloseTo(25, 3);
  });

  it('bestSimulatedExit=sl15 when SL15 fires and beats hold in a crash', async () => {
    // entry=0.01, final=0.01, latest=0.004 (-60%)
    // SL15 fires at -15%, hold = -60% → best = sl15
    const f = makeLiveFixture({ contract: 'MINT_BE2', symbol: 'BE2', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_BE2: 0.004 });
    const r = await runResolvedLedger(makeOptions([f], fetch));
    expect(r.rows[0]!.bestSimulatedExit).toBe('sl15');
    expect(r.rows[0]!.bestSimulatedExitPct).toBeCloseTo(-15, 3);
  });

  it('bestSimulatedExitPct is included in avgBestSimExit aggregate', async () => {
    const f1 = makeLiveFixture({ contract: 'MINT_AV1', symbol: 'AV1', entryPrice: 0.01 });
    const f2 = makeLiveFixture({ contract: 'MINT_AV2', symbol: 'AV2', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_AV1: 0.014, MINT_AV2: 0.004 });
    // AV1: latest=+40%, TP25 fires at +25% but TP50/hold all = +40% → best = +40% (hold)
    // AV2: latest=-60%, SL15 fires at -15% → best = -15%
    // avg = (40 + (-15)) / 2 = 12.5
    const r = await runResolvedLedger(makeOptions([f1, f2], fetch));
    expect(r.avgBestSimExit).toBeCloseTo(12.5, 1);
    expect(r.avgBestSimExit).not.toBeNull();
  });
});

// ── Enrichment fields ─────────────────────────────────────────────────────────

describe('runResolvedLedger — enrichment fields', () => {
  it('reads entryLiquidityUsd and entryVolumeUsd from raw.entry', async () => {
    const f = makeLiveFixture({ contract: 'MINT_ENR', symbol: 'ENR', entryPrice: 0.01, entryLiq: 90000, entryVol: 12000 });
    const r = await runResolvedLedger(makeOptions([f]));
    expect(r.rows[0]!.entryLiquidityUsd).toBeCloseTo(90000, 0);
    expect(r.rows[0]!.entryVolumeUsd).toBeCloseTo(12000, 0);
  });

  it('computes volumeToLiquidityRatio from entry fields', async () => {
    const f = makeLiveFixture({ contract: 'MINT_VLR', symbol: 'VLR', entryPrice: 0.01, entryLiq: 80000, entryVol: 8000 });
    const r = await runResolvedLedger(makeOptions([f]));
    expect(r.rows[0]!.volumeToLiquidityRatio).toBeCloseTo(0.1, 4);
  });

  it('reads bubbleMapsScore from clusterRawMetrics.decentralisationScore', async () => {
    const f = makeLiveFixture({ contract: 'MINT_BM', symbol: 'BM', entryPrice: 0.01, bubbleMaps: 82.5 });
    const r = await runResolvedLedger(makeOptions([f]));
    expect(r.rows[0]!.bubbleMapsScore).toBeCloseTo(82.5, 3);
  });

  it('computes priceChangePct from entry->final', async () => {
    // entry=0.01, final=0.012 (+20%)
    const f = makeLiveFixture({ contract: 'MINT_PCP', symbol: 'PCP', entryPrice: 0.01, finalPrice: 0.012 });
    const r = await runResolvedLedger(makeOptions([f]));
    expect(r.rows[0]!.priceChangePct).toBeCloseTo(20, 3);
  });

  it('computes liquidityChangePct from entry->final liquidity', async () => {
    // final liq = entryLiq * 0.9 (see makeLiveFixture), so -10%
    const f = makeLiveFixture({ contract: 'MINT_LCP', symbol: 'LCP', entryPrice: 0.01, entryLiq: 100000 });
    const r = await runResolvedLedger(makeOptions([f]));
    expect(r.rows[0]!.liquidityChangePct).toBeCloseTo(-10, 3);
  });
});

// ── Outcome status ────────────────────────────────────────────────────────────

describe('runResolvedLedger — outcomeStatus and counts', () => {
  it('outcomeStatus=MOVED when latestReturnPct >= 15 and < 50', async () => {
    const f = makeLiveFixture({ contract: 'MINT_MOV', symbol: 'MOV', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_MOV: 0.013 }); // +30%
    const r = await runResolvedLedger(makeOptions([f], fetch));
    expect(r.rows[0]!.outcomeStatus).toBe('MOVED');
    expect(r.winnerCount).toBe(1);
  });

  it('outcomeStatus=DUMPED when latestReturnPct <= -15', async () => {
    const f = makeLiveFixture({ contract: 'MINT_DMP', symbol: 'DMP', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_DMP: 0.008 }); // -20%
    const r = await runResolvedLedger(makeOptions([f], fetch));
    expect(r.rows[0]!.outcomeStatus).toBe('DUMPED');
    expect(r.loserCount).toBe(1);
  });

  it('outcomeStatus=FLAT when latestReturnPct is in -15 to +15', async () => {
    const f = makeLiveFixture({ contract: 'MINT_FLT', symbol: 'FLT', entryPrice: 0.01 });
    const fetch = makeFetch({ MINT_FLT: 0.01 }); // 0%
    const r = await runResolvedLedger(makeOptions([f], fetch));
    expect(r.rows[0]!.outcomeStatus).toBe('FLAT');
    expect(r.flatCount).toBe(1);
  });
});

// ── Safety invariants ─────────────────────────────────────────────────────────

describe('runResolvedLedger — safety invariants', () => {
  it('tradingExecuted is always 0', async () => {
    const r = await runResolvedLedger(makeOptions([]));
    expect(r.tradingExecuted).toBe(0);
  });

  it('noRealTradeSent is always true', async () => {
    expect((await runResolvedLedger(makeOptions([]))).noRealTradeSent).toBe(true);
  });

  it('paperOnly is always true', async () => {
    expect((await runResolvedLedger(makeOptions([]))).paperOnly).toBe(true);
  });

  it('readOnly is always true', async () => {
    expect((await runResolvedLedger(makeOptions([]))).readOnly).toBe(true);
  });

  it('does not export sendTransaction, signTransaction, or swap', () => {
    expect(Object.keys(RCL)).not.toContain('sendTransaction');
    expect(Object.keys(RCL)).not.toContain('signTransaction');
    expect(Object.keys(RCL)).not.toContain('swap');
    expect(Object.keys(RCL)).not.toContain('privateKey');
  });
});

// ── renderResolvedLedgerReport ────────────────────────────────────────────────

describe('renderResolvedLedgerReport', () => {
  it('includes REAL TRADING LOCKED', async () => {
    const f = makeLiveFixture({ contract: 'MINT_RTL', symbol: 'RTL', entryPrice: 0.01 });
    const r = await runResolvedLedger(makeOptions([f]));
    expect(renderResolvedLedgerReport(r)).toContain('REAL TRADING LOCKED');
  });

  it('includes REAL TRADING LOCKED on missing-file result', () => {
    const empty: Parameters<typeof renderResolvedLedgerReport>[0] = {
      inputPath: '/tmp/x.jsonl', watchInputPath: '/tmp/w.jsonl', ledgerPath: '/tmp/l.jsonl',
      inputMissing: true, generatedAt: '2026-06-10T10:00:00.000Z',
      totalRows: 0, resolvedRows: 0, unresolvedRows: 0,
      winnerCount: 0, loserCount: 0, flatCount: 0,
      hit25Count: 0, hit50Count: 0, hit100Count: 0, hitSL15Count: 0,
      avgLatestReturn: null, avgBestSimExit: null, bestRow: null, worstRow: null, rows: [],
      tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
    };
    expect(renderResolvedLedgerReport(empty)).toContain('REAL TRADING LOCKED');
  });

  it('shows sample-size warning when resolved < 20', async () => {
    const f = makeLiveFixture({ contract: 'MINT_WRN', symbol: 'WRN', entryPrice: 0.01 });
    const r = await runResolvedLedger(makeOptions([f]));
    expect(renderResolvedLedgerReport(r)).toContain('Do not change gates until >=20 resolved rows');
  });

  it('shows ledger table with symbol and status columns', async () => {
    const f = makeLiveFixture({ contract: 'MINT_TBL', symbol: 'TBL', entryPrice: 0.01 });
    const r = await runResolvedLedger(makeOptions([f]));
    const report = renderResolvedLedgerReport(r);
    expect(report).toContain('LEDGER TABLE');
    expect(report).toContain('$TBL');
  });

  it('shows early signal board section', async () => {
    const r = await runResolvedLedger(makeOptions([]));
    // Empty result but report should still have the section header
    const f = makeLiveFixture({ contract: 'MINT_ESB', symbol: 'ESB', entryPrice: 0.01 });
    const r2 = await runResolvedLedger(makeOptions([f]));
    expect(renderResolvedLedgerReport(r2)).toContain('EARLY SIGNAL BOARD');
  });

  it('shows winner vs loser comparison when both exist', async () => {
    const fw = makeLiveFixture({ contract: 'MINT_WIN', symbol: 'WIN', entryPrice: 0.01, bubbleMaps: 80 });
    const fl = makeLiveFixture({ contract: 'MINT_LOS', symbol: 'LOS', entryPrice: 0.01, bubbleMaps: 50 });
    const fetch = makeFetch({ MINT_WIN: 0.013, MINT_LOS: 0.008 }); // +30%, -20%
    const r = await runResolvedLedger(makeOptions([fw, fl], fetch));
    const report = renderResolvedLedgerReport(r);
    // should show avg comparisons
    expect(report).toContain('BubbleMaps');
    expect(report).toContain('Vol/Liq');
  });

  it('shows tradingExecuted=0 in footer', async () => {
    const f = makeLiveFixture({ contract: 'MINT_FTR', symbol: 'FTR', entryPrice: 0.01 });
    const r = await runResolvedLedger(makeOptions([f]));
    expect(renderResolvedLedgerReport(r)).toContain('tradingExecuted=0');
  });

  it('does not contain sendTransaction or signTransaction', async () => {
    const f = makeLiveFixture({ contract: 'MINT_NS2', symbol: 'NS2', entryPrice: 0.01 });
    const r = await runResolvedLedger(makeOptions([f]));
    const report = renderResolvedLedgerReport(r);
    expect(report).not.toContain('sendTransaction');
    expect(report).not.toContain('signTransaction');
    expect(report).not.toContain('swap(');
  });
});
