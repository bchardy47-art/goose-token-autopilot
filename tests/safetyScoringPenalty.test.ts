import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { scoreToken } from '../src/scoring/scoreToken';
import { makeTestConfig } from './helpers';
import { qualifiesForWatchOnly } from '../src/watchOnly';
import { createDb } from '../src/db';
import { buildDailyReport } from '../src/paper/dailyReport';
import { isPaperResearchBlocked } from '../src/paper/autoPaper';
import { verifySafety } from '../src/verifySafety';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    chain: 'solana',
    mint: 'PenaltyMint111111111111111111111111111111111',
    symbol: 'PEN',
    name: 'Penalty Token',
    source: 'dexscreener',
    sourceUrl: 'https://dexscreener.com/solana/penalty',
    discoveredAt: new Date().toISOString(),
    tokenCreatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    priceUsd: 1,
    liquidityUsd: 25000,
    marketCapUsd: 100000,
    volume5mUsd: 7000,
    volume1hUsd: 25000,
    volume24hUsd: 100000,
    priceChange5mPct: 12,
    priceChange1hPct: 20,
    buys5m: 24,
    sells5m: 10,
    liquidityGrowthPct: 10,
    freezeAuthority: 'SAFE' as const,
    mintAuthority: 'SAFE' as const,
    sellQuoteAvailable: 'YES' as const,
    estimatedSlippageBps: 120,
    metadataPresent: true,
    metadataStatus: 'YES' as const,
    websitePresent: true,
    socialsPresent: true,
    holderConcentration: 'SAFE' as const,
    creatorStatus: 'SAFE' as const,
    movedBeforeDiscoveryPct: 20,
    dataUpdatedAt: new Date().toISOString(),
    raw: {},
    ...overrides
  };
}

describe('safety scoring penalties', () => {
  it('holder concentration RISKY lowers safety score but does not remove watch-only research eligibility', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const safeCandidate = makeCandidate({ holderConcentration: 'SAFE' as const });
    const riskyCandidate = makeCandidate({ holderConcentration: 'RISKY' as const });
    const safeScore = scoreToken(1, safeCandidate, config);
    const riskyScore = scoreToken(2, riskyCandidate, config);
    expect(riskyScore.safetyScore).toBeLessThan(safeScore.safetyScore);
    expect(riskyScore.reasons).toContain('holder concentration risky');
    expect(qualifiesForWatchOnly(riskyCandidate, riskyScore).ok).toBe(true);
    expect(isPaperResearchBlocked({ ...riskyCandidate, sellQuoteAvailable: 'YES', estimatedSlippageBps: 120 }, riskyScore, config)).toBe('watch priority below paper requirement');
  });

  it('verify-safety still says real trading locked', () => {
    const { dir, config } = makeTestConfig();
    cleanup.push(dir);
    const status = verifySafety(config);
    expect(status.realTradingLockedByDefault).toBe(true);
  });

  it('report/scoring commands do not open paper positions or real trade attempts', () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeCandidate());
    db.insertSnapshot(tokenId, makeCandidate());
    scoreToken(tokenId, makeCandidate({ holderConcentration: 'RISKY' as const }), config);
    const report = buildDailyReport(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    expect(report).toHaveProperty('safetyPenaltySummary');
    db.close();
  });
});
