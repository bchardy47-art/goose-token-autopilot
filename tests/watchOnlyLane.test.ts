import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig } from './helpers';
import { qualifiesForWatchOnly, buildWatchOnlyReport } from '../src/watchOnly';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { scoreToken } from '../src/scoring/scoreToken';
import { buildDailyReport } from '../src/paper/dailyReport';
import { verifySafety } from '../src/verifySafety';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeGeckoCandidate(overrides: Record<string, unknown> = {}) {
  return makeLiveCandidate({ source: 'geckoterminal', ...overrides });
}

function makeLiveCandidate(overrides: Record<string, unknown> = {}) {
  const candidate = normalizeDexScreenerCandidate(
    {
      chainId: 'solana',
      tokenAddress: 'WatchMint111111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/watchpair',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/watchpair',
        pairAddress: 'WatchPair111',
        pairCreatedAt: Date.now() - 30 * 60 * 1000,
        priceUsd: '0.01',
        marketCap: 250000,
        txns: { m5: { buys: 25, sells: 10 } },
        volume: { m5: 7000, h1: 25000, h24: 100000 },
        priceChange: { m5: 25, h1: 60, h24: 70 },
        liquidity: { usd: 10000 },
        info: { websites: [{ url: 'https://example.com', label: 'Website' }] },
        baseToken: { address: 'WatchMint111111111111111111111111111111111111', name: 'Watch Token', symbol: 'WATCHX' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }
      }
    ],
    new Date().toISOString()
  );
  if (!candidate) throw new Error('candidate build failed');
  return { ...candidate, ...overrides };
}

describe('watch-only lane', () => {
  it('WATCH_ONLY can be created despite UNKNOWN authority fields', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = makeLiveCandidate({ mintAuthority: 'UNKNOWN', freezeAuthority: 'UNKNOWN', sellQuoteAvailable: 'UNKNOWN', holderConcentration: 'UNKNOWN' });
    const score = scoreToken(1, candidate, config);
    const watch = qualifiesForWatchOnly(candidate, score);
    expect(watch.ok).toBe(true);
  });

  it('explicit UNSAFE authority blocks WATCH_ONLY', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = makeLiveCandidate({ mintAuthority: 'UNSAFE' });
    const score = scoreToken(1, candidate, config);
    expect(qualifiesForWatchOnly(candidate, score).ok).toBe(false);
  });

  it('holder concentration RISKY is treated as penalty, not clean filter', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = makeLiveCandidate({ holderConcentration: 'RISKY' });
    const score = scoreToken(1, candidate, config);
    const watch = qualifiesForWatchOnly(candidate, score);
    expect(score.reasons).toContain('holder concentration risky');
    expect(watch.ok).toBe(true);
  });

  it('low liquidity blocks WATCH_ONLY', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = makeLiveCandidate({ liquidityUsd: 4000 });
    const score = scoreToken(1, candidate, config);
    expect(qualifiesForWatchOnly(candidate, score).reason).toMatch(/liquidity/);
  });

  it('no momentum blocks WATCH_ONLY', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const candidate = makeLiveCandidate({ priceChange5mPct: 1, priceChange1hPct: 2, volume5mUsd: 100, buys5m: 3, sells5m: 5 });
    const score = scoreToken(1, candidate, config);
    expect(qualifiesForWatchOnly(candidate, score).reason).toMatch(/momentum/);
  });

  it('watch-report calculates best and worst movement', () => {
    const { dir, config } = makeTestConfig();
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1.2, 10000, 7000, 25000, { sample: true });
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 0.8, 10000, 7000, 25000, { sample: true });
    const report = buildWatchOnlyReport(db);
    expect(report).toHaveProperty('bestMover');
    expect(report).toHaveProperty('worstMover');
    db.close();
  });

  it('daily-report includes watch-only summary', () => {
    const { dir, config } = makeTestConfig();
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1.2, 10000, 7000, 25000, { sample: true });
    const report = buildDailyReport(db, config);
    expect(report).toHaveProperty('watchOnlyCandidateCount');
    expect(report).toHaveProperty('watchOnlyResearchOnly');
    db.close();
  });

  it('GeckoTerminal source qualifies for WATCH_ONLY when momentum criteria are met', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'geckoterminal' });
    cleanup.push(dir);
    const candidate = makeGeckoCandidate();
    const score = scoreToken(1, candidate, config);
    const watch = qualifiesForWatchOnly(candidate, score);
    expect(watch.ok).toBe(true);
  });

  it('GeckoTerminal candidate with no momentum is blocked by momentum gate, not source gate', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'geckoterminal' });
    cleanup.push(dir);
    const candidate = makeGeckoCandidate({ priceChange5mPct: 1, priceChange1hPct: 2, volume5mUsd: 100, buys5m: 3, sells5m: 5 });
    const score = scoreToken(1, candidate, config);
    const watch = qualifiesForWatchOnly(candidate, score);
    expect(watch.ok).toBe(false);
    expect(watch.reason).toMatch(/momentum/);
  });

  it('WATCH_ONLY never opens paper positions and verify-safety remains locked', () => {
    const { dir, config } = makeTestConfig();
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate());
    db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1.1, 10000, 7000, 25000, { sample: true });
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    const status = verifySafety(config);
    expect(status.realTradingLockedByDefault).toBe(true);
    expect(status.watchOnlyResearchOnly).toBe(true);
    db.close();
  });
});
