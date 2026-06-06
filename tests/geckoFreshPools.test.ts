import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  mapGeckoPoolToFreshPool,
  dedupeFreshPools,
  fetchGeckoFreshPools,
} from '../src/token-grab/geckoFreshPools';
import { buildTokenGrabReport } from '../src/token-grab/report';
import type { FreshPool } from '../src/token-grab/types';

// ── Representative raw GeckoTerminal pool fixture ─────────────────────────────

const RAW_GOOSE_POOL = {
  attributes: {
    address: 'GoosePoolFakeAddressForTestingPurposes111',
    name: 'GOOSE/SOL',
    pool_created_at: '2026-06-05T10:00:00Z',
    reserve_in_usd: '45000.50',
    volume_usd: { m5: '8200.00' },
  },
  relationships: {
    base_token:  { data: { id: 'solana_GooseFakeCAForTestingPurposesNa11111111111' } },
    quote_token: { data: { id: 'solana_So11111111111111111111111111111111111111112' } },
  },
};

const RAW_STABLE_AS_BASE = {
  attributes: {
    address: 'StablePoolFake11111111111111111111111111111',
    name: 'USDC/SOL',
    pool_created_at: '2026-06-05T10:00:00Z',
    reserve_in_usd: '100000',
    volume_usd: { m5: '5000' },
  },
  relationships: {
    base_token:  { data: { id: 'solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } },
    quote_token: { data: { id: 'solana_So11111111111111111111111111111111111111112' } },
  },
};

const RAW_NO_POOL_ADDRESS = {
  attributes: { name: 'FOO/SOL', pool_created_at: '2026-06-05T10:00:00Z' },
  relationships: {
    base_token: { data: { id: 'solana_FooFakeCAForTestingPurposesNa11111111111111' } },
  },
};

const RAW_NO_BASE_MINT = {
  attributes: {
    address: 'SomePoolFake1111111111111111111111111111111',
    name: 'BAR/SOL',
    pool_created_at: '2026-06-05T10:00:00Z',
  },
  relationships: {
    base_token: { data: { id: 'ethereum_0xabc' } }, // wrong network prefix
  },
};

const RAW_MISSING_FIELDS = {};

// ── mapGeckoPoolToFreshPool ───────────────────────────────────────────────────

describe('mapGeckoPoolToFreshPool', () => {
  it('maps a representative GeckoTerminal pool into FreshPool', () => {
    const pool = mapGeckoPoolToFreshPool(RAW_GOOSE_POOL, '2026-06-06T00:00:00Z');

    expect(pool).toBeDefined();
    expect(pool!.id).toBe('GoosePoolFakeAddressForTestingPurposes111');
    expect(pool!.chain).toBe('solana');
    expect(pool!.ticker).toBe('GOOSE');
    expect(pool!.tokenName).toBe('GOOSE');
    expect(pool!.contractAddress).toBe('GooseFakeCAForTestingPurposesNa11111111111');
    expect(pool!.poolAddress).toBe('GoosePoolFakeAddressForTestingPurposes111');
    expect(pool!.createdAt).toBe('2026-06-05T10:00:00Z');
    expect(pool!.liquidityUsd).toBe(45000.5);
    expect(pool!.volume5mUsd).toBe(8200);
    expect(pool!.source).toBe('geckoterminal');
  });

  it('returns undefined when pool address is missing', () => {
    expect(mapGeckoPoolToFreshPool(RAW_NO_POOL_ADDRESS)).toBeUndefined();
  });

  it('returns undefined when base token mint cannot be parsed', () => {
    expect(mapGeckoPoolToFreshPool(RAW_NO_BASE_MINT)).toBeUndefined();
  });

  it('returns undefined for completely empty/malformed record', () => {
    expect(mapGeckoPoolToFreshPool(RAW_MISSING_FIELDS)).toBeUndefined();
  });

  it('returns undefined when base ticker is a known stable (USDC, SOL, etc.)', () => {
    expect(mapGeckoPoolToFreshPool(RAW_STABLE_AS_BASE)).toBeUndefined();
  });

  it('parses liquidity and volume safely — leaves them undefined when absent', () => {
    const raw = {
      ...RAW_GOOSE_POOL,
      attributes: { ...RAW_GOOSE_POOL.attributes, reserve_in_usd: undefined, volume_usd: undefined },
    };
    const pool = mapGeckoPoolToFreshPool(raw, '2026-06-06T00:00:00Z');
    expect(pool).toBeDefined();
    expect(pool!.liquidityUsd).toBeUndefined();
    expect(pool!.volume5mUsd).toBeUndefined();
  });

  it('falls back to nowIso for createdAt when pool_created_at is absent', () => {
    const raw = {
      ...RAW_GOOSE_POOL,
      attributes: { ...RAW_GOOSE_POOL.attributes, pool_created_at: undefined },
    };
    const pool = mapGeckoPoolToFreshPool(raw, '2026-06-06T00:00:00Z');
    expect(pool!.createdAt).toBe('2026-06-06T00:00:00Z');
  });

  it('uppercases ticker and trims whitespace', () => {
    const raw = {
      ...RAW_GOOSE_POOL,
      attributes: { ...RAW_GOOSE_POOL.attributes, name: '  goose  /SOL' },
    };
    const pool = mapGeckoPoolToFreshPool(raw, '2026-06-06T00:00:00Z');
    expect(pool!.ticker).toBe('GOOSE');
  });

  it('does not include metadata (not available from new_pools endpoint)', () => {
    const pool = mapGeckoPoolToFreshPool(RAW_GOOSE_POOL, '2026-06-06T00:00:00Z');
    expect(pool!.metadata).toBeUndefined();
  });
});

// ── dedupeFreshPools ──────────────────────────────────────────────────────────

describe('dedupeFreshPools', () => {
  function makePool(id: string, contractAddress: string, poolAddress?: string): FreshPool {
    return {
      id,
      chain: 'solana',
      tokenName: id,
      ticker: id,
      contractAddress,
      poolAddress,
      createdAt: '2026-06-05T10:00:00Z',
      source: 'geckoterminal',
    };
  }

  it('passes through a list with no duplicates unchanged', () => {
    const pools = [
      makePool('A', 'CA-A', 'PA-A'),
      makePool('B', 'CA-B', 'PA-B'),
    ];
    expect(dedupeFreshPools(pools)).toHaveLength(2);
  });

  it('removes duplicate by contractAddress — first occurrence wins', () => {
    const pools = [
      makePool('A1', 'CA-A', 'PA-A1'),
      makePool('A2', 'CA-A', 'PA-A2'),
    ];
    const result = dedupeFreshPools(pools);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('A1');
  });

  it('removes duplicate by poolAddress even when contractAddress differs', () => {
    const pools = [
      makePool('A', 'CA-A', 'PA-SHARED'),
      makePool('B', 'CA-B', 'PA-SHARED'),
    ];
    const result = dedupeFreshPools(pools);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('A');
  });

  it('merges local + gecko pools and dedupes by contract', () => {
    const local = [makePool('LOCAL', 'CA-SHARED', 'PA-LOCAL')];
    const gecko = [makePool('GECKO', 'CA-SHARED', 'PA-GECKO')];
    const result = dedupeFreshPools([...local, ...gecko]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('LOCAL');
  });

  it('returns empty array when input is empty', () => {
    expect(dedupeFreshPools([])).toEqual([]);
  });
});

// ── fetchGeckoFreshPools ──────────────────────────────────────────────────────

describe('fetchGeckoFreshPools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(response: unknown, ok = true, status = 200) {
    return vi.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(response),
    }) as unknown as typeof fetch;
  }

  it('returns mapped FreshPool[] from a successful response', async () => {
    const fetchImpl = mockFetch({ data: [RAW_GOOSE_POOL] });
    const pools = await fetchGeckoFreshPools({ fetchImpl, limit: 10 });

    expect(pools).toHaveLength(1);
    expect(pools[0]!.ticker).toBe('GOOSE');
    expect(pools[0]!.source).toBe('geckoterminal');
  });

  it('respects the limit option — returns at most limit pools', async () => {
    const manyPools = Array.from({ length: 10 }, (_, i) => ({
      ...RAW_GOOSE_POOL,
      attributes: { ...RAW_GOOSE_POOL.attributes, address: `Pool${i}` },
      relationships: {
        ...RAW_GOOSE_POOL.relationships,
        base_token: { data: { id: `solana_FakeCA${i}${'1'.repeat(32)}` } },
      },
    }));
    const fetchImpl = mockFetch({ data: manyPools });
    const pools = await fetchGeckoFreshPools({ fetchImpl, limit: 3 });

    expect(pools.length).toBeLessThanOrEqual(3);
  });

  it('returns [] and logs warning on HTTP 429 (rate limit)', async () => {
    const fetchImpl = mockFetch({}, false, 429);
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pools = await fetchGeckoFreshPools({ fetchImpl });

    expect(pools).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('429'));
  });

  it('returns [] and logs warning on non-OK HTTP response', async () => {
    const fetchImpl = mockFetch({}, false, 503);
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pools = await fetchGeckoFreshPools({ fetchImpl });

    expect(pools).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('503'));
  });

  it('returns [] without throwing when fetch rejects (network error)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Network failure')) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pools = await fetchGeckoFreshPools({ fetchImpl });

    expect(pools).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Network failure'));
  });

  it('returns [] when response data is missing or not an array', async () => {
    const fetchImpl = mockFetch({ data: null });
    const pools = await fetchGeckoFreshPools({ fetchImpl });
    expect(pools).toEqual([]);
  });

  it('skips malformed pool records without crashing', async () => {
    const fetchImpl = mockFetch({
      data: [RAW_MISSING_FIELDS, RAW_NO_POOL_ADDRESS, RAW_GOOSE_POOL],
    });
    const pools = await fetchGeckoFreshPools({ fetchImpl });
    // Only GOOSE is valid
    expect(pools).toHaveLength(1);
    expect(pools[0]!.ticker).toBe('GOOSE');
  });
});

// ── Integration: gecko pools fed into buildTokenGrabReport ────────────────────

describe('buildTokenGrabReport with gecko-sourced fresh pools', () => {
  it('GOOSE pool from gecko + matching social signal produces FRESH_LAUNCH_CANDIDATE', () => {
    const geckoPool = mapGeckoPoolToFreshPool(RAW_GOOSE_POOL, '2026-06-06T00:00:00Z')!;
    expect(geckoPool).toBeDefined();

    const CA = 'GooseFakeCAForTestingPurposesNa11111111111';
    const social1 = {
      id: 'ss-1', source: 'x' as const, authorHandle: 'Alice',
      text: `$GOOSE fair launch CA soon ${CA}`,
      firstSeenAt: '2026-06-05T08:00:00Z',
      createdAt: '2026-06-05T08:00:00Z',
      engagement: { likes: 30, reposts: 10, replies: 2 },
      extracted: { tickers: ['GOOSE'], tokenNames: [], contractAddresses: [CA], urls: [], phrases: ['fair launch', 'ca soon'] },
      flags: {},
    };
    const social2 = { ...social1, id: 'ss-2', authorHandle: 'Bob' };

    const report = buildTokenGrabReport({
      socialSignals: [social1, social2],
      eventSignals: [],
      freshPools: [geckoPool],
    });

    const candidate = report.candidates.find(c => c.ticker === 'GOOSE');
    expect(candidate?.lane).toBe('FRESH_LAUNCH_CANDIDATE');
    expect(candidate?.noTradingExecuted).toBe(true);
    expect(report.summary.tradingExecuted).toBe(0);
  });

  it('gecko pool with no social context becomes NOISE_RUG_LIKELY', () => {
    const geckoPool = mapGeckoPoolToFreshPool(RAW_GOOSE_POOL, '2026-06-06T00:00:00Z')!;

    const report = buildTokenGrabReport({
      socialSignals: [],
      eventSignals: [],
      freshPools: [geckoPool],
    });

    expect(report.candidates[0]!.lane).toBe('NOISE_RUG_LIKELY');
    expect(report.summary.tradingExecuted).toBe(0);
    expect(report.tradingStatus).toBe('LOCKED / NO TRADING EXECUTED');
  });
});
