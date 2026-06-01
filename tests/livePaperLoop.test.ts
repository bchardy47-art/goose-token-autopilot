import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig, seedScoredDb } from './helpers';
import { runAutoPaper } from '../src/paper/autoPaper';
import { runPaperReview } from '../src/paper/review';
import { buildPaperPerformanceReport } from '../src/paper/performance';
import { buildDailyReport } from '../src/paper/dailyReport';
import { verifySafety } from '../src/verifySafety';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('live paper loop', () => {
  it('token:auto-paper opens paper positions only and never creates real trade attempts', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const result = await runAutoPaper(db, config);
    expect(result.decisions.some((decision) => decision.action === 'BOUGHT')).toBe(true);
    expect(db.listPositions('PAPER').filter((position) => position.status === 'OPEN').length).toBeGreaterThan(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('auto-paper respects max open positions', async () => {
    const { dir, config, db } = await seedScoredDb({ MAX_OPEN_POSITIONS: '1' });
    cleanup.push(dir);
    const result = await runAutoPaper(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBeLessThanOrEqual(1);
    expect(result.decisions.some((decision) => decision.reason.includes('max open paper positions reached'))).toBe(true);
    db.close();
  });

  it('auto-paper respects daily paper buy cap', async () => {
    const { dir, config, db } = await seedScoredDb({ MAX_DAILY_PAPER_BUYS: '0' });
    cleanup.push(dir);
    const result = await runAutoPaper(db, config);
    expect(result.decisions.every((decision) => decision.action === 'SKIPPED')).toBe(true);
    db.close();
  });

  it('duplicate open paper positions are not created', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    await runAutoPaper(db, config);
    const firstCount = db.getOpenPositionCount('PAPER');
    await runAutoPaper(db, config);
    const secondCount = db.getOpenPositionCount('PAPER');
    expect(secondCount).toBe(firstCount);
    db.close();
  });

  it('low-score and red-flag tokens are not paper-bought', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const result = await runAutoPaper(db, config);
    const skipped = result.decisions.filter((decision) => decision.action === 'SKIPPED').map((decision) => decision.reason).join(' | ');
    expect(skipped).toMatch(/verdict AVOID not eligible|hard red flags/);
    db.close();
  });

  it('token:paper-review closes take-profit', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    const snapshot = db.getLatestSnapshot(open.tokenId)!;
    snapshot.priceUsd = open.entryPriceUsd * 1.6;
    db.insertSnapshot(open.tokenId, snapshot);
    const review = runPaperReview(db, config);
    expect(review.decisions.some((decision) => decision.reason === 'take_profit')).toBe(true);
    db.close();
  });

  it('token:paper-review closes stop-loss', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    const snapshot = db.getLatestSnapshot(open.tokenId)!;
    snapshot.priceUsd = open.entryPriceUsd * 0.5;
    db.insertSnapshot(open.tokenId, snapshot);
    const review = runPaperReview(db, config);
    expect(review.decisions.some((decision) => decision.reason === 'stop_loss')).toBe(true);
    db.close();
  });

  it('token:paper-review closes max-hold-time', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_MAX_HOLD_MINUTES: '1' });
    cleanup.push(dir);
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    db.sqlite.prepare("UPDATE positions SET opened_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 60 * 1000).toISOString(), open.id);
    const review = runPaperReview(db, config);
    expect(review.decisions.some((decision) => decision.reason === 'max_hold_time')).toBe(true);
    db.close();
  });

  it('paper-performance report calculates P/L', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    await runAutoPaper(db, config);
    const report = buildPaperPerformanceReport(db);
    expect(report).toHaveProperty('currentPnlUsd');
    expect(report).toHaveProperty('realizedPnlUsd');
    expect(report).toHaveProperty('unrealizedPnlUsd');
    db.close();
  });

  it('daily-report works', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    await runAutoPaper(db, config);
    const report = buildDailyReport(db, config);
    expect(report).toHaveProperty('tokensScannedToday');
    expect(report).toHaveProperty('topRedFlags');
    expect(report).toHaveProperty('finalSafetyStatus');
    db.close();
  });

  it('real trading remains blocked by default and verify-safety reports simulated paper mode', () => {
    const { dir, config } = makeTestConfig();
    cleanup.push(dir);
    const status = verifySafety(config);
    expect(status.realTradingLockedByDefault).toBe(true);
    expect(status.paperTradingSimulatedOnly).toBe(true);
    expect(status.walletSigningConfigured).toBe(false);
  });

  it('token:auto-paper can run on a fresh fixture db', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'fixture' });
    cleanup.push(dir);
    const db = createDb(config);
    const result = await runAutoPaper(db, config);
    expect(result.scanned).toBeGreaterThan(0);
    db.close();
  });
});
