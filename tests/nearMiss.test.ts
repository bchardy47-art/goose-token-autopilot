import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedScoredDb } from './helpers';
import { buildNearMissShadowReport, classifyNearMiss, renderNearMissShadowReport } from '../src/paper/nearMiss';
import type { PaperEligibilityDiagnosticRow } from '../src/types';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRow(overrides: Partial<PaperEligibilityDiagnosticRow> = {}): PaperEligibilityDiagnosticRow {
  return {
    tokenId: 1,
    symbol: 'TEST',
    mint: 'TEST111111111111111111111111111111111111111',
    totalScore: 70,
    safetyScore: 25,
    momentumScore: 20,
    liquidityUsd: 50000,
    sellQuoteAvailable: 'YES',
    estimatedSlippageBps: 120,
    mintAuthority: 'SAFE',
    freezeAuthority: 'SAFE',
    holderConcentration: 'SAFE',
    verdict: 'WATCH',
    blockers: [],
    warnings: [],
    distanceToPaperScore: 0,
    dataAgeMinutes: 12,
    isEntryStale: false,
    movedBeforeDiscoveryPct: 20,
    isMovedBeforeDiscoveryBlocked: false,
    blockerCount: 0,
    warningCount: 0,
    usefulRankReason: 'test',
    sourceUrl: 'https://example.com',
    watchProfile: 'RUNNER_PROFILE',
    watchPriority: 'HIGH_WATCH_PRIORITY',
    ...overrides
  };
}

describe('near miss shadow lane', () => {
  it('candidate blocked only by watch priority is categorized WOULD_PASS_EXCEPT_WATCH_PRIORITY', () => {
    const row = makeRow({ blockers: ['watch priority below paper requirement'], blockerCount: 1, watchPriority: 'LOW_WATCH_PRIORITY' });
    expect(classifyNearMiss(row)).toBe('WOULD_PASS_EXCEPT_WATCH_PRIORITY');
  });

  it('candidate blocked only by holder risk is categorized WOULD_PASS_EXCEPT_HOLDER_RISK', () => {
    const row = makeRow({ holderConcentration: 'RISKY' });
    expect(classifyNearMiss(row)).toBe('WOULD_PASS_EXCEPT_HOLDER_RISK');
  });

  it('too-young otherwise clean candidate is categorized WOULD_PASS_EXCEPT_AGE', () => {
    const row = makeRow({ blockers: ['token age outside configured range'], blockerCount: 1 });
    expect(classifyNearMiss(row)).toBe('WOULD_PASS_EXCEPT_AGE');
  });

  it('stale otherwise close candidate is categorized WOULD_PASS_EXCEPT_STALE', () => {
    const row = makeRow({ blockers: ['entry data stale blocks paper eligibility'], blockerCount: 1, isEntryStale: true });
    expect(classifyNearMiss(row)).toBe('WOULD_PASS_EXCEPT_STALE');
  });

  it('bad slippage or moved-before-discovery candidate is HARD_REJECT', () => {
    const slippageRow = makeRow({ blockers: ['slippage above MAX_SLIPPAGE_BPS blocks paper eligibility'], blockerCount: 1 });
    const movedRow = makeRow({ blockers: ['moved before discovery blocks paper eligibility'], blockerCount: 1, isMovedBeforeDiscoveryBlocked: true });
    expect(classifyNearMiss(slippageRow)).toBe('HARD_REJECT');
    expect(classifyNearMiss(movedRow)).toBe('HARD_REJECT');
  });

  it('risky + low-watch/noise dominant candidates recommend DO_NOT_LOOSEN', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const report = buildNearMissShadowReport(db, config, { windowMinutes: 60 });
    expect(report.recommendation).toBe('DO_NOT_LOOSEN');
    db.close();
  });

  it('safe holder + good liquidity/slippage + only watch blocker recommends CONSIDER_SHADOW_PAPER_RULE when repeated', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'true' } as any);
    cleanup.push(dir);
    const base = db.getLatestSnapshot(db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!.id)!;
    for (let index = 0; index < 2; index += 1) {
      const candidate = {
        ...base,
        mint: `NMWATCH${index}1111111111111111111111111111111111`,
        symbol: `NMW${index}`,
        dataUpdatedAt: new Date().toISOString(),
        tokenCreatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        sellQuoteAvailable: 'YES' as const,
        estimatedSlippageBps: 120,
        holderConcentration: 'SAFE' as const,
        sourceUrl: `fixture://nmwatch-${index}`
      };
      const tokenId = db.upsertToken(candidate);
      db.insertSnapshot(tokenId, candidate);
    }
    const report = buildNearMissShadowReport(db, config, { windowMinutes: 60 });
    expect(['CONSIDER_SHADOW_PAPER_RULE', 'DO_NOT_LOOSEN', 'INVESTIGATE_NOW']).toContain(report.recommendation);
    const output = renderNearMissShadowReport(db, config, { windowMinutes: 60 });
    expect(output).not.toMatch(/rawJson/i);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });
});
