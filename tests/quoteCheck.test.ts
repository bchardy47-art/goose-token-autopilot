import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig } from './helpers';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { runQuoteCheck } from '../src/quoteCheck';
import { verifySafety } from '../src/verifySafety';
import { scoreToken } from '../src/scoring/scoreToken';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeLiveCandidate(overrides: Record<string, unknown> = {}) {
  const candidate = normalizeDexScreenerCandidate(
    {
      chainId: 'solana',
      tokenAddress: 'QuoteMint11111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/quote',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/quote',
        pairAddress: 'QuotePair111',
        pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
        priceUsd: '1.00',
        marketCap: 250000,
        txns: { m5: { buys: 25, sells: 10 } },
        volume: { m5: 7000, h1: 25000, h24: 100000 },
        priceChange: { m5: 25, h1: 60, h24: 70 },
        liquidity: { usd: 12000 },
        info: { websites: [{ url: 'https://example.com', label: 'Website' }] },
        baseToken: { address: 'QuoteMint11111111111111111111111111111111111', name: 'Quote Token', symbol: 'QTE' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }
      }
    ],
    new Date().toISOString()
  );
  if (!candidate) throw new Error('candidate build failed');
  return { ...candidate, ...overrides };
}

describe('read-only quote checks', () => {
  it('quote check disabled by default', () => {
    const { dir, config } = makeTestConfig();
    cleanup.push(dir);
    expect(config.enableQuoteCheck).toBe(false);
  });

  it('verify-safety still locked', () => {
    const { dir, config } = makeTestConfig({ ENABLE_QUOTE_CHECK: 'true' });
    cleanup.push(dir);
    const status = verifySafety(config);
    expect(status.realTradingLockedByDefault).toBe(true);
    expect(status.quoteCheckEnabled).toBe(true);
  });

  it('quote-check never opens paper positions', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_QUOTE_CHECK: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outAmount: '1000', priceImpactPct: '0.01', routePlan: [{}] }), { status: 200 })) as any);
    await runQuoteCheck(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    db.close();
  });

  it('quote-check never records real trade attempts', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_QUOTE_CHECK: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outAmount: '1000', priceImpactPct: '0.01', routePlan: [{}] }), { status: 200 })) as any);
    await runQuoteCheck(db, config);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('quote-check never requires wallet/private key', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_QUOTE_CHECK: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outAmount: '1000', priceImpactPct: '0.01', routePlan: [{}] }), { status: 200 })) as any);
    await runQuoteCheck(db, config);
    expect(config.burnerWalletPrivateKey).toBeUndefined();
    db.close();
  });

  it('valid route response becomes route available', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_QUOTE_CHECK: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN', raw: { safetyEnrichment: { decimals: 6 } } }));
    db.insertSnapshot(tokenId, makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN', raw: { safetyEnrichment: { decimals: 6 } } }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outAmount: '1000', priceImpactPct: '0.01', routePlan: [{}] }), { status: 200 })) as any);
    const result = await runQuoteCheck(db, config);
    expect((result as any).routeAvailableCount).toBe(1);
    expect(db.getLatestSnapshot(tokenId)?.sellQuoteAvailable).toBe('YES');
    db.close();
  });

  it('route unavailable sets NO/UNKNOWN safely', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_QUOTE_CHECK: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN', raw: { safetyEnrichment: { decimals: 6 } } }));
    db.insertSnapshot(tokenId, makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN', raw: { safetyEnrichment: { decimals: 6 } } }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ routePlan: [] }), { status: 200 })) as any);
    await runQuoteCheck(db, config);
    expect(['NO', 'UNKNOWN']).toContain(String(db.getLatestSnapshot(tokenId)?.sellQuoteAvailable));
    db.close();
  });

  it('high slippage remains unsafe', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_QUOTE_CHECK: 'true', QUOTE_CHECK_SLIPPAGE_BPS: '900' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN', raw: { safetyEnrichment: { decimals: 6 } } }));
    db.insertSnapshot(tokenId, makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN', raw: { safetyEnrichment: { decimals: 6 } } }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outAmount: '1000', priceImpactPct: '0.50', routePlan: [{}] }), { status: 200 })) as any);
    await runQuoteCheck(db, config);
    expect(db.getLatestQuoteSellabilityCheck(tokenId)?.safetyStatus).toBe('SELLABLE_HIGH_SLIPPAGE');
    expect(db.getLatestSnapshot(tokenId)?.sellQuoteAvailable).toBe('UNKNOWN');
    db.close();
  });

  it('quote failure is handled as UNKNOWN/error, not high slippage unless slippage is known and high', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_QUOTE_CHECK: 'true', QUOTE_CHECK_DEBUG: 'true' } as any);
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN', raw: { safetyEnrichment: { decimals: 6 } } }));
    db.insertSnapshot(tokenId, makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN', raw: { safetyEnrichment: { decimals: 6 } } }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('quote down'); }) as any);
    const result = await runQuoteCheck(db, config);
    expect(db.getLatestQuoteSellabilityCheck(tokenId)?.sellQuoteStatus).toBe('UNKNOWN');
    expect((result as any).highSlippageCount).toBe(0);
    db.close();
  });

  it('missing decimals stays UNKNOWN safely', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_QUOTE_CHECK: 'true' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN', raw: {} }));
    db.insertSnapshot(tokenId, makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN', raw: {} }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ outAmount: '1000', routePlan: [{}] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);
    await runQuoteCheck(db, config);
    expect(db.getLatestQuoteSellabilityCheck(tokenId)?.sellQuoteStatus).toBe('UNKNOWN');
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('cache skip works', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_QUOTE_CHECK: 'true', QUOTE_CHECK_CACHE_MINUTES: '30' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.insertSnapshot(tokenId, makeLiveCandidate());
    db.createQuoteSellabilityCheck(tokenId, makeLiveCandidate().mint, new Date().toISOString(), 'jupiter', makeLiveCandidate().mint, 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { cached: true });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ outAmount: '1000', routePlan: [{}] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);
    const result = await runQuoteCheck(db, config);
    expect((result as any).skippedCachedCount).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('max tokens per run works', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener', ENABLE_QUOTE_CHECK: 'true', QUOTE_CHECK_MAX_TOKENS_PER_RUN: '1' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId1 = db.upsertToken(makeLiveCandidate({ mint: 'QuoteMint1', symbol: 'Q1' }));
    const tokenId2 = db.upsertToken(makeLiveCandidate({ mint: 'QuoteMint2', symbol: 'Q2' }));
    db.insertSnapshot(tokenId1, makeLiveCandidate({ mint: 'QuoteMint1', symbol: 'Q1' }));
    db.insertSnapshot(tokenId2, makeLiveCandidate({ mint: 'QuoteMint2', symbol: 'Q2' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outAmount: '1000', priceImpactPct: '0.01', routePlan: [{}] }), { status: 200 })) as any);
    const result = await runQuoteCheck(db, config);
    expect((result as any).checkedCount).toBeLessThanOrEqual(1);
    db.close();
  });

  it('sell quote UNKNOWN still blocks paper/autopilot readiness', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const score = scoreToken(1, makeLiveCandidate({ sellQuoteAvailable: 'UNKNOWN' }), config);
    expect(score.autopilotBlocked).toBe(true);
    expect(score.redFlags).toContain('sell quote unknown');
  });
});
