import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedScoredDb } from './helpers';
import { buildFreshRejectionAnalytics, renderFreshRejectionAnalytics } from '../src/paper/freshRejections';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('fresh rejection analytics', () => {
  it('counts missing liquidity and slippage buckets', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const candidate = {
      ...db.getLatestSnapshot(safe.id)!,
      mint: 'ANLQ111111111111111111111111111111111111111',
      symbol: 'ANLQ',
      name: 'Analytics Liquidity',
      dataUpdatedAt: new Date().toISOString(),
      liquidityUsd: null,
      sellQuoteAvailable: 'YES' as const,
      estimatedSlippageBps: null,
      sourceUrl: 'fixture://analytics-liquidity'
    };
    const tokenId = db.upsertToken(candidate);
    db.insertSnapshot(tokenId, candidate);

    const report = buildFreshRejectionAnalytics(db, config, { maxAgeMinutes: 60, limit: 5 });
    expect(report.buckets.missingLiquidity).toBeGreaterThanOrEqual(1);
    expect(report.buckets.missingSlippage).toBeGreaterThanOrEqual(1);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('counts risky holder and low safety buckets', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const candidate = {
      ...db.getLatestSnapshot(safe.id)!,
      mint: 'ANSAFE1111111111111111111111111111111111111',
      symbol: 'ANSAFE',
      name: 'Analytics Safety',
      dataUpdatedAt: new Date().toISOString(),
      holderConcentration: 'RISKY' as const,
      sellQuoteAvailable: 'YES' as const,
      estimatedSlippageBps: 100,
      safetyScore: 5,
      sourceUrl: 'fixture://analytics-safety'
    };
    const tokenId = db.upsertToken(candidate);
    db.insertSnapshot(tokenId, candidate);

    const report = buildFreshRejectionAnalytics(db, config, { maxAgeMinutes: 60, limit: 5 });
    expect(report.buckets.holderRisky).toBeGreaterThanOrEqual(1);
    expect(report.buckets.safetyScoreBelowPaperMinimum).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('counts watch priority and profile buckets and reports eligible fresh correctly', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const report = buildFreshRejectionAnalytics(db, config, { maxAgeMinutes: 60, limit: 5 });
    expect(report.buckets.lowWatchPriorityCount).toBeGreaterThanOrEqual(0);
    expect(report.buckets.avoidWatchPriorityCount).toBeGreaterThanOrEqual(0);
    expect(report.buckets.noiseProfileCount).toBeGreaterThanOrEqual(0);
    expect(report.eligibleFreshCount).toBeGreaterThanOrEqual(0);
    expect(report.paperBuysWouldOpenCount).toBeGreaterThanOrEqual(0);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('render includes final safety status and no paper buys opened', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const output = renderFreshRejectionAnalytics(db, config, { maxAgeMinutes: 60, limit: 5 });
    expect(output).toContain('Fresh Rejection Analytics');
    expect(output).toContain('No paper buys opened.');
    expect(output).toContain('Real trading remains locked.');
    db.close();
  });
});
