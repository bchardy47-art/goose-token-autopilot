import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig, seedScoredDb } from './helpers';
import { renderFreshCandidateWatchlist, buildFreshCandidateWatchlist } from '../src/paper/freshWatchlist';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('fresh candidate watchlist', () => {
  it('filters out stale candidates above max age', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const staleSnapshot = { ...db.getLatestSnapshot(safe.id)!, dataUpdatedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString() };
    db.insertSnapshot(safe.id, staleSnapshot);

    const report = buildFreshCandidateWatchlist(db, config, { maxAgeMinutes: 30, limit: 10 });
    expect(report.candidates.every((row) => (row.dataAgeMinutes ?? Number.POSITIVE_INFINITY) <= 30)).toBe(true);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('fresh non-eligible candidate appears with blockers', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const candidate = {
      ...db.getLatestSnapshot(safe.id)!,
      mint: 'FRESHBLOCK1111111111111111111111111111111111',
      symbol: 'FBLOCK',
      name: 'Fresh Blocked',
      dataUpdatedAt: new Date().toISOString(),
      sellQuoteAvailable: 'UNKNOWN' as const,
      estimatedSlippageBps: null,
      liquidityUsd: 15000,
      volume5mUsd: 1000,
      volume1hUsd: 10000,
      volume24hUsd: 40000,
      priceChange5mPct: 4,
      priceChange1hPct: 10,
      movedBeforeDiscoveryPct: 20,
      sourceUrl: 'fixture://fresh-blocked'
    };
    const tokenId = db.upsertToken(candidate);
    db.insertSnapshot(tokenId, candidate);

    const report = buildFreshCandidateWatchlist(db, config, { maxAgeMinutes: 30, limit: 10 });
    const row = report.candidates.find((item) => item.tokenId === tokenId);
    expect(row).toBeTruthy();
    expect(row?.blockers.join(' ')).toMatch(/sell quote unknown|watch priority|score/);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('no-blocker fresh candidate ranks above blocked fresh candidate', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const safeSnapshot = db.getLatestSnapshot(safe.id)!;
    db.createQuoteSellabilityCheck(safe.id, safeSnapshot.mint, new Date().toISOString(), 'jupiter', safeSnapshot.mint, 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });

    const blockedCandidate = {
      ...safeSnapshot,
      mint: 'FWBLOCK111111111111111111111111111111111111',
      symbol: 'FWBLK',
      name: 'Fresh Watch Blocked',
      dataUpdatedAt: new Date().toISOString(),
      sellQuoteAvailable: 'UNKNOWN' as const,
      estimatedSlippageBps: null,
      sourceUrl: 'fixture://fresh-watch-blocked'
    };
    const blockedId = db.upsertToken(blockedCandidate);
    db.insertSnapshot(blockedId, blockedCandidate);

    const report = buildFreshCandidateWatchlist(db, config, { maxAgeMinutes: 30, limit: 10 });
    const ids = report.candidates.map((row) => row.tokenId);
    expect(ids.indexOf(safe.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(blockedId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(safe.id)).toBeLessThan(ids.indexOf(blockedId));
    db.close();
  });

  it('rendered output includes no paper buys opened and real trading locked', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const output = renderFreshCandidateWatchlist(db, config, { maxAgeMinutes: 30, limit: 5 });
    expect(output).toContain('Fresh Candidate Watchlist');
    expect(output).toContain('No paper buys opened.');
    expect(output).toContain('Real trading remains locked.');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('command path can run on a fresh fixture db without opening positions or recording real attempts', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'fixture' });
    cleanup.push(dir);
    const db = createDb(config);
    const output = renderFreshCandidateWatchlist(db, config, { maxAgeMinutes: 30, limit: 10 });
    expect(output).toContain('Fresh Candidate Watchlist');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });
});
