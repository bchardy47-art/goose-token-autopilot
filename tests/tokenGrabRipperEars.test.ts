import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  earSignalToRipperInput,
  getContractAddress,
  hasMarketData,
  type RipperEarSignal,
} from '../src/token-grab/ripperEars';

import {
  normalizeDexPair,
  normalizeDexPairs,
  normalizeDexScreenerResponse,
  type DexPairRaw,
} from '../src/token-grab/dexScreenerRipperAdapter';

import {
  offlineHolderClusterProvider,
  toHolderClusterProfile,
  fetchHolderClusterProfile,
  type HolderClusterProvider,
} from '../src/token-grab/holderClusterAdapter';

import {
  runRipperEarsReport,
  runRipperNearMiss,
  loadEarSignals,
  renderRipperEarsReport,
} from '../src/token-grab/ripperEarsReport';

import {
  scoreRipper,
  DEFAULT_RIPPER_CONFIG,
} from '../src/token-grab/dexRipperEngine';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW_MS  = new Date('2026-06-10T12:00:00Z').getTime();
const NOW_ISO = new Date(NOW_MS).toISOString();

// 10 minutes ago = PRIME_WINDOW
const PAIR_CREATED_AT_MS = NOW_MS - 10 * 60 * 1000;

const dexPairFixture: DexPairRaw = {
  chainId: 'solana',
  dexId: 'raydium',
  url: 'https://dexscreener.com/solana/TestPair111',
  pairAddress: 'TestPair111',
  baseToken: { address: 'TestToken111', name: 'Test Token', symbol: 'TEST' },
  quoteToken: { address: 'SolAddr111', symbol: 'SOL' },
  txns: { m5: { buys: 50, sells: 20 } },
  volume: { m5: 5000, h1: 20000 },
  priceChange: { m5: 25.0, h1: 60.0 },
  liquidity: { usd: 10000 },
  pairCreatedAt: PAIR_CREATED_AT_MS,
};

function makeEarSignal(overrides: Partial<RipperEarSignal> = {}): RipperEarSignal {
  return {
    id: 'test:TestPair111',
    source: 'dexscreener',
    sourceKind: 'DEX_NEW_POOL',
    contract: 'TestToken111',
    poolAddress: 'TestPair111',
    symbol: 'TEST',
    name: 'Test Token',
    discoveredAt: new Date(PAIR_CREATED_AT_MS).toISOString(),
    observedAt: NOW_ISO,
    confidence: 'HIGH',
    signalReasons: ['price +25.0% (m5)', 'new pool detected'],
    warnings: [],
    liquidityUsd: 10000,
    volumeUsd: 5000,
    priceChangePct: 25,
    volumeLiquidityRatio: 0.5,
    buys: 50,
    sells: 20,
    ...overrides,
  };
}

// ── normalizeDexPair ──────────────────────────────────────────────────────────

describe('normalizeDexPair', () => {
  it('normalizes a complete DexScreener pair into RipperEarSignal', () => {
    const signal = normalizeDexPair(dexPairFixture, NOW_ISO);
    expect(signal).not.toBeNull();
    expect(signal!.contract).toBe('TestToken111');
    expect(signal!.poolAddress).toBe('TestPair111');
    expect(signal!.symbol).toBe('TEST');
    expect(signal!.source).toBe('dexscreener');
    expect(signal!.sourceKind).toBe('DEX_NEW_POOL');
    expect(signal!.liquidityUsd).toBe(10000);
    expect(signal!.volumeUsd).toBe(5000);
    expect(signal!.priceChangePct).toBe(25.0);
    expect(signal!.buys).toBe(50);
    expect(signal!.sells).toBe(20);
  });

  it('maps pairCreatedAt to discoveredAt as ISO string', () => {
    const signal = normalizeDexPair(dexPairFixture, NOW_ISO);
    expect(signal).not.toBeNull();
    expect(signal!.discoveredAt).toBe(new Date(PAIR_CREATED_AT_MS).toISOString());
    expect(signal!.launchHint).toBe(String(PAIR_CREATED_AT_MS));
  });

  it('uses nowIso as discoveredAt when pairCreatedAt is missing', () => {
    const pair: DexPairRaw = { ...dexPairFixture, pairCreatedAt: undefined };
    const signal = normalizeDexPair(pair, NOW_ISO);
    expect(signal).not.toBeNull();
    expect(signal!.discoveredAt).toBe(NOW_ISO);
    expect(signal!.warnings.some(w => w.includes('pairCreatedAt missing'))).toBe(true);
  });

  it('returns null when baseToken.address is missing', () => {
    const pair: DexPairRaw = { ...dexPairFixture, baseToken: { symbol: 'TEST' } };
    expect(normalizeDexPair(pair, NOW_ISO)).toBeNull();
  });

  it('returns null when pairAddress is missing', () => {
    const pair: DexPairRaw = { ...dexPairFixture, pairAddress: undefined };
    expect(normalizeDexPair(pair, NOW_ISO)).toBeNull();
  });

  it('missing liquidity does not crash — adds warning instead', () => {
    const pair: DexPairRaw = { ...dexPairFixture, liquidity: undefined };
    const signal = normalizeDexPair(pair, NOW_ISO);
    expect(signal).not.toBeNull();
    expect(signal!.liquidityUsd).toBeUndefined();
    expect(signal!.warnings.some(w => w.includes('liquidity.usd missing'))).toBe(true);
  });

  it('missing volume does not crash — adds warning', () => {
    const pair: DexPairRaw = { ...dexPairFixture, volume: undefined };
    const signal = normalizeDexPair(pair, NOW_ISO);
    expect(signal).not.toBeNull();
    expect(signal!.volumeUsd).toBeUndefined();
    expect(signal!.warnings.some(w => w.includes('volume missing'))).toBe(true);
  });

  it('computes volumeLiquidityRatio from volume and liquidity', () => {
    const signal = normalizeDexPair(dexPairFixture, NOW_ISO);
    expect(signal!.volumeLiquidityRatio).toBeCloseTo(5000 / 10000);
  });

  it('does not compute VLR when liquidity is zero/missing', () => {
    const pair: DexPairRaw = { ...dexPairFixture, liquidity: { usd: 0 } };
    const signal = normalizeDexPair(pair, NOW_ISO);
    expect(signal).not.toBeNull();
    expect(signal!.volumeLiquidityRatio).toBeUndefined();
  });

  it('sets confidence HIGH when liquidity, priceChange, and txns all present', () => {
    const signal = normalizeDexPair(dexPairFixture, NOW_ISO);
    expect(signal!.confidence).toBe('HIGH');
  });

  it('sets confidence LOW when all market data is missing', () => {
    const pair: DexPairRaw = {
      pairAddress: 'TestPair111',
      baseToken: { address: 'TestToken111', symbol: 'TEST' },
    };
    const signal = normalizeDexPair(pair, NOW_ISO);
    expect(signal!.confidence).toBe('LOW');
  });
});

// ── normalizeDexPairs ─────────────────────────────────────────────────────────

describe('normalizeDexPairs', () => {
  it('processes multiple pairs and counts skipped', () => {
    const pairs: DexPairRaw[] = [
      dexPairFixture,
      { baseToken: undefined }, // missing address → skip
      { ...dexPairFixture, pairAddress: 'Pair2', baseToken: { address: 'Token2', symbol: 'T2' } },
    ];
    const result = normalizeDexPairs(pairs, NOW_ISO);
    expect(result.signals).toHaveLength(2);
    expect(result.skippedCount).toBe(1);
  });

  it('counts warnings across all signals', () => {
    const noLiquidity: DexPairRaw = { ...dexPairFixture, liquidity: undefined };
    const result = normalizeDexPairs([noLiquidity], NOW_ISO);
    expect(result.warningCount).toBeGreaterThan(0);
  });
});

// ── normalizeDexScreenerResponse ──────────────────────────────────────────────

describe('normalizeDexScreenerResponse', () => {
  it('handles pairs array', () => {
    const result = normalizeDexScreenerResponse({ pairs: [dexPairFixture] }, NOW_ISO);
    expect(result.signals).toHaveLength(1);
  });

  it('handles single pair field', () => {
    const result = normalizeDexScreenerResponse({ pair: dexPairFixture }, NOW_ISO);
    expect(result.signals).toHaveLength(1);
  });

  it('handles empty response gracefully', () => {
    const result = normalizeDexScreenerResponse({}, NOW_ISO);
    expect(result.signals).toHaveLength(0);
    expect(result.skippedCount).toBe(0);
  });
});

// ── offlineHolderClusterProvider ──────────────────────────────────────────────

describe('offlineHolderClusterProvider', () => {
  it('returns UNKNOWN safely when no provider data exists', async () => {
    const result = await offlineHolderClusterProvider.fetchClusterProfile('AnyContract111');
    expect(result.holderRisk).toBe('UNKNOWN');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.provider).toBe('offline');
    expect(result.confidence).toBe('UNKNOWN');
    expect(result.concentrationNotes.length).toBeGreaterThan(0);
  });

  it('does not throw for any contract address', async () => {
    await expect(
      offlineHolderClusterProvider.fetchClusterProfile(''),
    ).resolves.toBeDefined();
  });
});

describe('toHolderClusterProfile', () => {
  it('converts HolderClusterResult to HolderClusterProfile correctly', async () => {
    const result = await offlineHolderClusterProvider.fetchClusterProfile('AnyContract111');
    const profile = toHolderClusterProfile(result);
    expect(profile.holderRisk).toBe('UNKNOWN');
    expect(profile.clusterRisk).toBe('UNKNOWN');
    expect(Array.isArray(profile.concentrationNotes)).toBe(true);
  });
});

describe('fetchHolderClusterProfile', () => {
  it('returns UNKNOWN profile when provider fetch fails', async () => {
    const failingProvider: HolderClusterProvider = {
      name: 'failing',
      fetchClusterProfile: async () => { throw new Error('network error'); },
    };
    const profile = await fetchHolderClusterProfile('TestContract111', failingProvider);
    expect(profile.holderRisk).toBe('UNKNOWN');
    expect(profile.clusterRisk).toBe('UNKNOWN');
    expect(profile.concentrationNotes[0]).toContain('fetch failed');
  });

  it('passes CLEAN result through correctly', async () => {
    const cleanProvider: HolderClusterProvider = {
      name: 'clean',
      fetchClusterProfile: async () => ({
        holderRisk: 'CLEAN',
        clusterRisk: 'CLEAN',
        concentrationNotes: ['top holder 3.2% — safe'],
        provider: 'clean',
        checkedAt: NOW_ISO,
        confidence: 'HIGH',
      }),
    };
    const profile = await fetchHolderClusterProfile('TestContract111', cleanProvider);
    expect(profile.holderRisk).toBe('CLEAN');
    expect(profile.clusterRisk).toBe('CLEAN');
  });
});

// ── earSignalToRipperInput ────────────────────────────────────────────────────

describe('earSignalToRipperInput', () => {
  it('converts a complete RipperEarSignal into RipperInput', () => {
    const signal = makeEarSignal();
    const input = earSignalToRipperInput(signal);
    expect(input).not.toBeNull();
    expect(input!.contract).toBe('TestToken111');
    expect(input!.symbol).toBe('TEST');
    expect(input!.priceChangePct).toBe(25);
    expect(input!.volumeLiquidityRatio).toBe(0.5);
  });

  it('uses discoveredAt (launch time) as observedAt for age calculation', () => {
    const signal = makeEarSignal({
      discoveredAt: new Date(PAIR_CREATED_AT_MS).toISOString(),
      observedAt: NOW_ISO,
    });
    const input = earSignalToRipperInput(signal);
    expect(input!.observedAt).toBe(new Date(PAIR_CREATED_AT_MS).toISOString());
  });

  it('returns null when no contract address is present', () => {
    const signal = makeEarSignal({ contract: undefined, tokenAddress: undefined });
    expect(earSignalToRipperInput(signal)).toBeNull();
  });

  it('falls back to tokenAddress when contract is not set', () => {
    const signal = makeEarSignal({ contract: undefined, tokenAddress: 'FallbackToken111' });
    const input = earSignalToRipperInput(signal);
    expect(input!.contract).toBe('FallbackToken111');
  });

  it('computes VLR from volumeUsd / liquidityUsd when not pre-set', () => {
    const signal = makeEarSignal({ volumeLiquidityRatio: undefined, volumeUsd: 3000, liquidityUsd: 10000 });
    const input = earSignalToRipperInput(signal);
    expect(input!.volumeLiquidityRatio).toBeCloseTo(0.3);
  });

  it('does not compute VLR when liquidityUsd is zero', () => {
    const signal = makeEarSignal({ volumeLiquidityRatio: undefined, volumeUsd: 3000, liquidityUsd: 0 });
    const input = earSignalToRipperInput(signal);
    expect(input!.volumeLiquidityRatio).toBeUndefined();
  });
});

// ── Ripper engine integration: age is not faked by price ─────────────────────

describe('age classification from ear signals', () => {
  it('stale/old signal gets DEAD_WINDOW even with high price momentum', () => {
    // 120 minutes old — well past lateWindowMaxMinutes (60)
    const oldSignal = makeEarSignal({
      discoveredAt: new Date(NOW_MS - 120 * 60 * 1000).toISOString(),
      priceChangePct: 200, // massive price move should NOT make it prime
    });
    const input = earSignalToRipperInput(oldSignal)!;
    const signal = scoreRipper(input, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(signal.launchAgeBucket).toBe('DEAD_WINDOW');
    expect(signal.entryDecision).toBe('IGNORE');
  });

  it('fresh signal in PRIME_WINDOW gets correct age bucket', () => {
    const freshSignal = makeEarSignal({
      discoveredAt: new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
      priceChangePct: 30,
    });
    const input = earSignalToRipperInput(freshSignal)!;
    const signal = scoreRipper(input, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(signal.launchAgeBucket).toBe('PRIME_WINDOW');
  });

  it('TOO_EARLY signal (< 2m) is blocked, not prime', () => {
    const tooEarlySignal = makeEarSignal({
      discoveredAt: new Date(NOW_MS - 1 * 60 * 1000).toISOString(),
      priceChangePct: 50,
    });
    const input = earSignalToRipperInput(tooEarlySignal)!;
    const signal = scoreRipper(input, DEFAULT_RIPPER_CONFIG, NOW_MS);
    expect(signal.launchAgeBucket).toBe('TOO_EARLY');
  });
});

// ── runRipperEarsReport ───────────────────────────────────────────────────────

describe('runRipperEarsReport', () => {
  it('handles missing input file without crashing', () => {
    const result = runRipperEarsReport({
      inputPath: '/nonexistent/path/ripper-ears-input.json',
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(result.inputMissing).toBe(true);
    expect(result.totalSignals).toBe(0);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
  });

  it('renders a helpful message when input file is missing', () => {
    const result = runRipperEarsReport({
      inputPath: '/nonexistent/path/ripper-ears-input.json',
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    const rendered = renderRipperEarsReport(result);
    expect(rendered).toContain('Input file not found');
    expect(rendered).toContain('Expected schema');
    expect(rendered).toContain('tradingExecuted=0');
    expect(rendered).toContain('noRealTradeSent=true');
  });

  it('scores a prime-window signal correctly from an ear-signals file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ears-'));
    const inputPath = path.join(dir, 'input.json');
    const signal = makeEarSignal();
    fs.writeFileSync(inputPath, JSON.stringify({ signals: [signal] }));

    const result = runRipperEarsReport({ inputPath, format: 'ear-signals', nowMs: NOW_MS });
    expect(result.totalSignals).toBe(1);
    expect(result.primeWindowCount).toBe(1);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);

    fs.rmSync(dir, { recursive: true });
  });

  it('loads dexscreener format and normalizes pairs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ears-'));
    const inputPath = path.join(dir, 'input.json');
    fs.writeFileSync(inputPath, JSON.stringify({ pairs: [dexPairFixture] }));

    const result = runRipperEarsReport({ inputPath, format: 'dexscreener', nowMs: NOW_MS });
    expect(result.totalSignals).toBe(1);
    expect(result.tradingExecuted).toBe(0);

    fs.rmSync(dir, { recursive: true });
  });

  it('counts signal without contract address as conversion failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ears-'));
    const inputPath = path.join(dir, 'input.json');
    const badSignal = makeEarSignal({ contract: undefined, tokenAddress: undefined });
    fs.writeFileSync(inputPath, JSON.stringify({ signals: [badSignal] }));

    const result = runRipperEarsReport({ inputPath, format: 'ear-signals', nowMs: NOW_MS });
    expect(result.conversionFailures).toBe(1);

    fs.rmSync(dir, { recursive: true });
  });

  it('safety constants always present in result', () => {
    const result = runRipperEarsReport({
      inputPath: '/nonexistent/path.json',
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── runRipperNearMiss ─────────────────────────────────────────────────────────

describe('runRipperNearMiss', () => {
  it('handles missing input file without crashing', () => {
    const result = runRipperNearMiss({
      inputPath: '/nonexistent/path.json',
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(result.inputMissing).toBe(true);
    expect(result.nearMissCount).toBe(0);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
  });

  it('identifies blocked signals as near-misses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ears-'));
    const inputPath = path.join(dir, 'input.json');
    // High VLR → SUSPICIOUS → PAPER_BUY_BLOCKED → near miss
    const blockedSignal = makeEarSignal({ volumeLiquidityRatio: 6, priceChangePct: 40 });
    fs.writeFileSync(inputPath, JSON.stringify({ signals: [blockedSignal] }));

    const result = runRipperNearMiss({ inputPath, format: 'ear-signals', nowMs: NOW_MS });
    expect(result.nearMissCount).toBeGreaterThan(0);
    expect(result.entries[0].entryDecision).toBe('PAPER_BUY_BLOCKED');

    fs.rmSync(dir, { recursive: true });
  });

  it('near-miss entries sorted by ripperScore descending', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ears-'));
    const inputPath = path.join(dir, 'input.json');
    const s1 = makeEarSignal({ contract: 'Token1111', volumeLiquidityRatio: 6, priceChangePct: 10 });
    const s2 = makeEarSignal({ contract: 'Token2222', volumeLiquidityRatio: 6, priceChangePct: 60 });
    fs.writeFileSync(inputPath, JSON.stringify({ signals: [s1, s2] }));

    const result = runRipperNearMiss({ inputPath, format: 'ear-signals', nowMs: NOW_MS });
    if (result.entries.length >= 2) {
      expect((result.entries[0].ripperScore ?? 0)).toBeGreaterThanOrEqual(
        (result.entries[1].ripperScore ?? 0),
      );
    }

    fs.rmSync(dir, { recursive: true });
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

describe('getContractAddress', () => {
  it('returns contract when set', () => {
    expect(getContractAddress(makeEarSignal({ contract: 'C1', tokenAddress: 'T1' }))).toBe('C1');
  });
  it('falls back to tokenAddress', () => {
    expect(getContractAddress(makeEarSignal({ contract: undefined, tokenAddress: 'T1' }))).toBe('T1');
  });
  it('returns undefined when neither is set', () => {
    expect(getContractAddress(makeEarSignal({ contract: undefined, tokenAddress: undefined }))).toBeUndefined();
  });
});

describe('hasMarketData', () => {
  it('returns true when priceChangePct present', () => {
    expect(hasMarketData(makeEarSignal({ priceChangePct: 10 }))).toBe(true);
  });
  it('returns true when liquidityUsd present', () => {
    expect(hasMarketData(makeEarSignal({ priceChangePct: undefined, liquidityUsd: 5000, volumeUsd: undefined }))).toBe(true);
  });
  it('returns false when no market data', () => {
    expect(hasMarketData(makeEarSignal({ priceChangePct: undefined, liquidityUsd: undefined, volumeUsd: undefined }))).toBe(false);
  });
});

// ── no real trading code ──────────────────────────────────────────────────────

describe('safety: no real trading code', () => {
  it('ripperEars module exports no buy/sell execution functions', async () => {
    const mod = await import('../src/token-grab/ripperEars');
    const keys = Object.keys(mod);
    // No signing, swapping, wallet, or live-trade execution functions
    expect(keys.some(k => /sign(transaction|tx|wallet)/i.test(k))).toBe(false);
    expect(keys.some(k => k.toLowerCase().includes('swap'))).toBe(false);
    expect(keys.some(k => k.toLowerCase().includes('wallet'))).toBe(false);
    expect(keys.some(k => /executebuy|executesell|livetrade/i.test(k))).toBe(false);
    expect(keys.some(k => /privatekey|secretkey/i.test(k))).toBe(false);
  });

  it('dexScreenerRipperAdapter exports no buy/sell execution functions', async () => {
    const mod = await import('../src/token-grab/dexScreenerRipperAdapter');
    const keys = Object.keys(mod);
    expect(keys.some(k => k.toLowerCase().includes('sign'))).toBe(false);
    expect(keys.some(k => k.toLowerCase().includes('privateKey') || k.toLowerCase().includes('private_key'))).toBe(false);
  });

  it('runRipperEarsReport result always has tradingExecuted=0', () => {
    const result = runRipperEarsReport({
      inputPath: '/nonexistent.json',
      format: 'ear-signals',
      nowMs: NOW_MS,
    });
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});
