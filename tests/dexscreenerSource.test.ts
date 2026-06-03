import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db';
import { runScan, createTokenSource } from '../src/scanner';
import { DexScreenerTokenSource, normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { FixtureTokenSource } from '../src/scanner/fixtureSource';
import { scoreToken } from '../src/scoring/scoreToken';
import { makeTestConfig } from './helpers';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' }
  });
}

function makeDexProfile(tokenAddress: string, updatedAt: string, suffix: string) {
  return {
    url: `https://dexscreener.com/solana/${suffix}`,
    chainId: 'solana',
    tokenAddress,
    updatedAt,
    links: [{ label: 'Website', url: `https://${suffix}.example.com` }]
  };
}

function makeDexPair(tokenAddress: string, overrides: Record<string, unknown> = {}) {
  const suffix = String(overrides.pairAddress ?? `${tokenAddress.slice(0, 8)}Pair`);
  return {
    chainId: 'solana',
    dexId: 'pumpfun',
    url: `https://dexscreener.com/solana/${suffix.toLowerCase()}`,
    pairAddress: suffix,
    pairCreatedAt: Date.now() - 30 * 60 * 1000,
    priceUsd: '0.1234',
    marketCap: 500000,
    txns: { m5: { buys: 10, sells: 3 } },
    volume: { m5: 1000, h1: 15000, h24: 80000 },
    priceChange: { m5: 12, h1: 30, h24: 35 },
    liquidity: { usd: 45000 },
    info: {
      websites: [{ url: 'https://example.com', label: 'Website' }],
      socials: [{ type: 'twitter', url: 'https://x.com/example' }]
    },
    baseToken: {
      address: tokenAddress,
      name: `Token ${tokenAddress.slice(0, 4)}`,
      symbol: tokenAddress.slice(0, 4).toUpperCase()
    },
    quoteToken: {
      address: 'So11111111111111111111111111111111111111112',
      name: 'Wrapped SOL',
      symbol: 'SOL'
    },
    ...overrides
  };
}

describe('scanner sources', () => {
  it('fixture source still works', async () => {
    const source = new FixtureTokenSource();
    const candidates = await source.fetchCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((item) => item.source === 'fixture')).toBe(true);
  });

  it('source selection works', () => {
    const fixtureConfig = loadConfig({ TOKEN_SOURCE: 'fixture' });
    const dexConfig = loadConfig({ TOKEN_SOURCE: 'dexscreener' });
    expect(createTokenSource(fixtureConfig)).toBeInstanceOf(FixtureTokenSource);
    expect(createTokenSource(dexConfig)).toBeInstanceOf(DexScreenerTokenSource);
  });
});

describe('DexScreener adapter', () => {
  it('normalizes a mocked API response', async () => {
    const now = Date.now();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/token-profiles/latest/v1')) {
        return makeJsonResponse([
          {
            url: 'https://dexscreener.com/solana/mockpair',
            chainId: 'solana',
            tokenAddress: 'MockMint1111111111111111111111111111111111111',
            updatedAt: new Date(now - 5 * 60 * 1000).toISOString(),
            links: [{ label: 'Website', url: 'https://example.com' }, { type: 'twitter', url: 'https://x.com/example' }]
          }
        ]);
      }
      if (url.includes('/latest/dex/tokens/')) {
        return makeJsonResponse({
          pairs: [
            {
              chainId: 'solana',
              dexId: 'pumpfun',
              url: 'https://dexscreener.com/solana/mockpair',
              pairAddress: 'MockPair111',
              pairCreatedAt: now - 30 * 60 * 1000,
              priceUsd: '0.1234',
              marketCap: 500000,
              txns: { m5: { buys: 10, sells: 3 } },
              volume: { m5: 1000, h1: 15000, h24: 80000 },
              priceChange: { m5: 12, h1: 30, h24: 35 },
              liquidity: { usd: 45000 },
              info: {
                websites: [{ url: 'https://example.com', label: 'Website' }],
                socials: [{ type: 'twitter', url: 'https://x.com/example' }]
              },
              baseToken: {
                address: 'MockMint1111111111111111111111111111111111111',
                name: 'Mock Token',
                symbol: 'MOCK'
              },
              quoteToken: {
                address: 'So11111111111111111111111111111111111111112',
                name: 'Wrapped SOL',
                symbol: 'SOL'
              }
            }
          ]
        });
      }
      return makeJsonResponse({}, { status: 404 });
    };

    const source = new DexScreenerTokenSource({ fetchImpl, maxTokens: 5, batchSize: 5 });
    const [candidate] = await source.fetchCandidates();
    expect(candidate).toBeDefined();
    expect(candidate.chain).toBe('solana');
    expect(candidate.source).toBe('dexscreener');
    expect(candidate.symbol).toBe('MOCK');
    expect(candidate.priceUsd).toBe(0.1234);
    expect(candidate.liquidityUsd).toBe(45000);
    expect(candidate.marketCapUsd).toBe(500000);
    expect(candidate.websitePresent).toBe(true);
    expect(candidate.socialsPresent).toBe(true);
    expect(candidate.freezeAuthority).toBe('UNKNOWN');
    expect(candidate.holderConcentration).toBe('UNKNOWN');
    expect(candidate.sellQuoteAvailable).toBe('UNKNOWN');
  });

  it('handles empty and bad responses safely', async () => {
    const emptySource = new DexScreenerTokenSource({
      fetchImpl: async () => makeJsonResponse([])
    });
    expect(await emptySource.fetchCandidates()).toEqual([]);

    const badSource = new DexScreenerTokenSource({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/token-profiles/latest/v1')) {
          return new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return makeJsonResponse({}, { status: 500 });
      }
    });
    expect(await badSource.fetchCandidates()).toEqual([]);

    const rateLimitedSource = new DexScreenerTokenSource({
      fetchImpl: async () => makeJsonResponse({ message: 'rate limit' }, { status: 429 })
    });
    expect(await rateLimitedSource.fetchCandidates()).toEqual([]);
  });

  it('prefers newer pairs over older stale ones and reports freshness summary', async () => {
    const freshToken = 'FreshMint1111111111111111111111111111111111111';
    const oldToken = 'OlderMint1111111111111111111111111111111111111';
    const now = Date.now();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/token-profiles/latest/v1')) {
        return makeJsonResponse([
          makeDexProfile(oldToken, new Date(now - 10 * 60 * 1000).toISOString(), 'old-token'),
          makeDexProfile(freshToken, new Date(now - 2 * 60 * 1000).toISOString(), 'fresh-token')
        ]);
      }
      if (url.includes('/latest/dex/tokens/')) {
        return makeJsonResponse({
          pairs: [
            makeDexPair(oldToken, {
              pairAddress: 'OldPair111',
              pairCreatedAt: now - 7 * 60 * 60 * 1000,
              priceChange: { m5: 10, h1: 20, h24: 25 }
            }),
            makeDexPair(freshToken, {
              pairAddress: 'FreshPair111',
              pairCreatedAt: now - 20 * 60 * 1000,
              priceChange: { m5: 8, h1: 12, h24: 14 }
            })
          ]
        });
      }
      return makeJsonResponse({}, { status: 404 });
    };

    const source = new DexScreenerTokenSource({
      fetchImpl,
      maxTokens: 10,
      batchSize: 10,
      maxPairAgeMinutes: 180,
      maxDataAgeMinutes: 60,
      maxMovedBeforeDiscoveryPct: 150,
      freshDiscoveryLimit: 10
    });

    const candidates = await source.fetchCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.mint).toBe(freshToken);
    expect(source.getLastFetchSummary()).toMatchObject({
      candidatesAccepted: 1,
      freshAcceptedCount: 1,
      staleRejectedCount: 1,
      alreadyMovedRejectedCount: 0
    });
  });

  it('skips already-moved pairs over threshold while keeping fresh valid pairs', async () => {
    const movedToken = 'MovedMint1111111111111111111111111111111111111';
    const freshToken = 'OkayMint11111111111111111111111111111111111111';
    const now = Date.now();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/token-profiles/latest/v1')) {
        return makeJsonResponse([
          makeDexProfile(movedToken, new Date(now - 3 * 60 * 1000).toISOString(), 'moved-token'),
          makeDexProfile(freshToken, new Date(now - 2 * 60 * 1000).toISOString(), 'okay-token')
        ]);
      }
      if (url.includes('/latest/dex/tokens/')) {
        return makeJsonResponse({
          pairs: [
            makeDexPair(movedToken, {
              pairAddress: 'MovedPair111',
              pairCreatedAt: now - 25 * 60 * 1000,
              priceChange: { m5: 60, h1: 125, h24: 220 }
            }),
            makeDexPair(freshToken, {
              pairAddress: 'OkayPair111',
              pairCreatedAt: now - 15 * 60 * 1000,
              priceChange: { m5: 9, h1: 15, h24: 18 }
            })
          ]
        });
      }
      return makeJsonResponse({}, { status: 404 });
    };

    const source = new DexScreenerTokenSource({
      fetchImpl,
      maxTokens: 10,
      batchSize: 10,
      maxPairAgeMinutes: 180,
      maxDataAgeMinutes: 60,
      maxMovedBeforeDiscoveryPct: 150,
      freshDiscoveryLimit: 10
    });

    const candidates = await source.fetchCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.mint).toBe(freshToken);
    expect(candidates[0]?.movedBeforeDiscoveryPct).toBe(18);
    expect(source.getLastFetchSummary()).toMatchObject({
      candidatesAccepted: 1,
      staleRejectedCount: 0,
      alreadyMovedRejectedCount: 1
    });
  });

  it('runScan inserts fresh valid DexScreener candidates and includes source summary', async () => {
    const { dir, config } = makeTestConfig({
      TOKEN_SOURCE: 'dexscreener',
      DEXSCREENER_MAX_PAIR_AGE_MINUTES: '180',
      DEXSCREENER_MAX_DATA_AGE_MINUTES: '60',
      DEXSCREENER_MAX_MOVED_BEFORE_DISCOVERY_PCT: '150',
      DEXSCREENER_FRESH_DISCOVERY_LIMIT: '5'
    });
    cleanup.push(dir);
    const db = createDb(config);
    const now = Date.now();
    const tokenA = 'ScanMintFresh111111111111111111111111111111111';
    const tokenB = 'ScanMintStale111111111111111111111111111111111';

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/token-profiles/latest/v1')) {
        return makeJsonResponse([
          makeDexProfile(tokenA, new Date(now - 2 * 60 * 1000).toISOString(), 'scan-fresh'),
          makeDexProfile(tokenB, new Date(now - 90 * 60 * 1000).toISOString(), 'scan-stale')
        ]);
      }
      if (url.includes('/latest/dex/tokens/')) {
        return makeJsonResponse({
          pairs: [
            makeDexPair(tokenA, { pairAddress: 'ScanFreshPair111', pairCreatedAt: now - 12 * 60 * 1000, priceChange: { m5: 7, h1: 10, h24: 16 } }),
            makeDexPair(tokenB, { pairAddress: 'ScanStalePair111', pairCreatedAt: now - 6 * 60 * 60 * 1000, priceChange: { m5: 11, h1: 20, h24: 22 } })
          ]
        });
      }
      return makeJsonResponse({}, { status: 404 });
    });

    const result = await runScan(db, config);
    const fresh = db.findTokenByMint(tokenA);
    const stale = db.findTokenByMint(tokenB);

    expect(result.scanned).toBe(1);
    expect(result.source).toBe('dexscreener');
    expect(result.sourceSummary).toMatchObject({
      freshAcceptedCount: 1,
      staleRejectedCount: 1,
      alreadyMovedRejectedCount: 0
    });
    expect(fresh).not.toBeNull();
    expect(stale).toBeNull();
    expect(db.getLatestSnapshot(fresh!.id)?.source).toBe('dexscreener');
    db.close();
  });

  it('live-source missing authority holder and sellability fields cannot become AUTOPILOT_ELIGIBLE', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = normalizeDexScreenerCandidate(
      {
        chainId: 'solana',
        tokenAddress: 'LiveMint1111111111111111111111111111111111111',
        url: 'https://dexscreener.com/solana/livepair',
        updatedAt: '2026-06-01T05:55:57.520Z',
        links: [{ label: 'Website', url: 'https://example.com' }]
      },
      [
        {
          chainId: 'solana',
          dexId: 'pumpfun',
          url: 'https://dexscreener.com/solana/livepair',
          pairAddress: 'LivePair111',
          pairCreatedAt: Date.now() - 60 * 60 * 1000,
          priceUsd: '0.25',
          marketCap: 900000,
          txns: { m5: { buys: 40, sells: 10 } },
          volume: { m5: 5000, h1: 40000, h24: 300000 },
          priceChange: { m5: 10, h1: 28, h24: 40 },
          liquidity: { usd: 80000 },
          info: {
            websites: [{ url: 'https://example.com', label: 'Website' }],
            socials: [{ type: 'twitter', url: 'https://x.com/example' }]
          },
          baseToken: {
            address: 'LiveMint1111111111111111111111111111111111111',
            name: 'Live Token',
            symbol: 'LIVE'
          },
          quoteToken: {
            address: 'So11111111111111111111111111111111111111112',
            name: 'Wrapped SOL',
            symbol: 'SOL'
          }
        }
      ],
      new Date().toISOString()
    );

    expect(candidate).not.toBeNull();
    const score = scoreToken(1, candidate!, config);
    expect(score.verdict).toBe('AVOID');
    expect(score.redFlags).toContain('freeze authority unknown');
    expect(score.redFlags).toContain('mint authority unknown');
    expect(score.redFlags).toContain('sell quote unavailable');
    expect(score.redFlags).toContain('holder concentration unknown');
    expect(score.autopilotBlocked).toBe(true);
  });
});
