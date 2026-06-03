import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedScoredDb } from './helpers';
import { buildTooEarlyWatchReport, renderTooEarlyWatchReport } from '../src/paper/tooEarlyWatch';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('too-early watch lane', () => {
  it('too-early clean candidate shows RECHECK_SOON', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.dataUpdatedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    snapshot.tokenCreatedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = 100;
    snapshot.holderConcentration = 'SAFE';
    db.insertSnapshot(safe.id, snapshot);

    const report = buildTooEarlyWatchReport(db, config, { maxAgeMinutes: 15, limit: 10 });
    const row = report.candidates.find((candidate) => candidate.tokenId === safe.id);
    expect(row?.recommendation).toBe('RECHECK_SOON');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('too-early candidate with risky holder shows WATCH_BUT_BLOCKED', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.dataUpdatedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    snapshot.tokenCreatedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = 100;
    snapshot.holderConcentration = 'RISKY';
    db.insertSnapshot(safe.id, snapshot);

    const report = buildTooEarlyWatchReport(db, config, { maxAgeMinutes: 15, limit: 10 });
    const row = report.candidates.find((candidate) => candidate.tokenId === safe.id);
    expect(row?.recommendation).toBe('WATCH_BUT_BLOCKED');
    db.close();
  });

  it('NOISE or AVOID candidate shows IGNORE', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const rug = db.findTokenByMint('RUG11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(rug.id)!;
    snapshot.dataUpdatedAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    snapshot.tokenCreatedAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    db.insertSnapshot(rug.id, snapshot);

    const report = buildTooEarlyWatchReport(db, config, { maxAgeMinutes: 15, limit: 10 });
    const row = report.candidates.find((candidate) => candidate.tokenId === rug.id);
    expect(row?.recommendation).toBe('IGNORE');
    db.close();
  });

  it('candidates older than MIN_TOKEN_AGE_MIN are excluded', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.dataUpdatedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    snapshot.tokenCreatedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.insertSnapshot(safe.id, snapshot);

    const report = buildTooEarlyWatchReport(db, config, { maxAgeMinutes: 15, limit: 10 });
    expect(report.candidates.some((candidate) => candidate.tokenId === safe.id)).toBe(false);
    db.close();
  });

  it('rendered report includes no paper buys opened and real trading remains locked', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const output = renderTooEarlyWatchReport(db, config, { maxAgeMinutes: 15, limit: 10 });
    expect(output).toContain('Too-Early Watch Lane');
    expect(output).toContain('No paper buys opened.');
    expect(output).toContain('Real trading remains locked.');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });
});
