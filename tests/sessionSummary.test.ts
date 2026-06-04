import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedScoredDb } from './helpers';
import { buildTokenSessionSummary, renderTokenSessionSummary } from '../src/paper/sessionSummary';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('token session summary', () => {
  it('no recent candidates -> SAFE_TO_STOP', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    for (const tokenId of db.getAllTokenIds()) {
      const snapshot = db.getLatestSnapshot(tokenId);
      if (!snapshot) continue;
      snapshot.dataUpdatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      db.insertSnapshot(tokenId, snapshot);
    }
    const report = buildTokenSessionSummary(db, config, { windowMinutes: 60 });
    expect(report.recommendation).toBe('SAFE_TO_STOP');
    db.close();
  });

  it('eligible fresh > 0 -> INVESTIGATE_NOW', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.dataUpdatedAt = new Date().toISOString();
    snapshot.tokenCreatedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = 100;
    snapshot.holderConcentration = 'SAFE';
    db.insertSnapshot(safe.id, snapshot);
    const report = buildTokenSessionSummary(db, config, { windowMinutes: 60 });
    expect(report.recommendation).toBe('INVESTIGATE_NOW');
    db.close();
  });

  it('clean-too-early > 0 -> INVESTIGATE_NOW', async () => {
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
    const report = buildTokenSessionSummary(db, config, { windowMinutes: 60 });
    expect(report.recommendation).toBe('INVESTIGATE_NOW');
    db.close();
  });

  it('risky/low-watch dominant sessions return a non-safe recommendation', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const rug = db.findTokenByMint('RUG11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(rug.id)!;
    snapshot.dataUpdatedAt = new Date().toISOString();
    db.insertSnapshot(rug.id, snapshot);
    const report = buildTokenSessionSummary(db, config, { windowMinutes: 60 });
    expect(['DO_NOT_BUY', 'KEEP_WATCHING', 'INVESTIGATE_NOW']).toContain(report.recommendation);
    expect(report.recommendation).not.toBe('SAFE_TO_STOP');
    db.close();
  });

  it('rendered output does not include rawJson and stays read-only', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const output = renderTokenSessionSummary(db, config, { windowMinutes: 60 });
    expect(output).toContain('Token Session Summary');
    expect(output).toContain('No paper buys opened.');
    expect(output).toContain('Real trading remains locked.');
    expect(output).not.toMatch(/rawJson/i);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });
});
