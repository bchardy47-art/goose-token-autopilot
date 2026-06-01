import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { DexScreenerTokenSource, normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { FixtureTokenSource } from '../src/scanner/fixtureSource';
import { createTokenSource } from '../src/scanner';
import { scoreToken } from '../src/scoring/scoreToken';
import { makeTestConfig } from './helpers';

const cleanup: string[] = [];
afterEach(() => {
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
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/token-profiles/latest/v1')) {
        return makeJsonResponse([
          {
            url: 'https://dexscreener.com/solana/mockpair',
            chainId: 'solana',
            tokenAddress: 'MockMint1111111111111111111111111111111111111',
            updatedAt: '2026-06-01T05:55:57.520Z',
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
              pairCreatedAt: 1780292897000,
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
    expect(score.redFlags).toContain('suspicious holder concentration placeholder');
    expect(score.autopilotBlocked).toBe(true);
  });
});
