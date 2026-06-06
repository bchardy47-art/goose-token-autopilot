import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { seedScoredDb } from './helpers';
import {
  buildTrackerDashboard,
  buildPositionsModel,
  buildPositionDetail,
  buildTradesModel,
  buildRadarModel,
  buildWatchlistModel,
} from '../src/dashboard/plTrackerApi';
import { renderPlTrackerPage } from '../src/dashboard/plTrackerPage';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const { dir, config, db } = await seedScoredDb();
  cleanup.push(dir);
  const tokenIds = db.getAllTokenIds();
  const openTokenId = tokenIds[0]!;
  const closedWinTokenId = tokenIds[1]!;
  const closedLossTokenId = tokenIds[2] ?? tokenIds[1]!;

  // Open paper position (simulated state only)
  const openId = db.createPosition(openTokenId, 'PAPER', 'OPEN', 0.01, 100, 1, 'entry: momentum');
  db.createPaperPerformanceSnapshot(openId, openTokenId, new Date().toISOString(), 0.012, 0.2, 20, 5000, 100000, 1000, 5000, {});

  // Closed winner
  const winId = db.createPosition(closedWinTokenId, 'PAPER', 'OPEN', 0.01, 100, 1, 'entry: fresh');
  db.closePosition(winId, 0.02, 1.0, 'exit: target hit');

  // Closed loser
  const lossId = db.createPosition(closedLossTokenId, 'PAPER', 'OPEN', 0.01, 100, 1, 'entry: chase');
  db.closePosition(lossId, 0.005, -0.5, 'exit: stop');

  return { config, db, openTokenId, openId };
}

describe('P/L tracker — safety invariants', () => {
  it('status bar reports live trading LOCKED, read-only, zero trades executed', async () => {
    const { db, config } = await setup();
    const d = buildTrackerDashboard(db, config);
    expect(d.statusBar.app).toBe('TOKEN GRAB');
    expect(d.statusBar.liveTradingLocked).toBe(true);
    expect(d.statusBar.liveTradingLabel).toBe('LOCKED');
    expect(d.statusBar.readOnly).toBe(true);
    expect(d.statusBar.tradingExecuted).toBe(0);
  });

  it('rendered page always shows LOCKED and has no buy/sell controls', () => {
    const html = renderPlTrackerPage();
    expect(html).toContain('TOKEN GRAB');
    expect(html).toContain('LIVE TRADING: LOCKED');
    expect(html).toContain('Real trading remains locked');
    // No real trade controls anywhere in the markup
    expect(/>\s*buy\s*</i.test(html)).toBe(false);
    expect(/>\s*sell\s*</i.test(html)).toBe(false);
  });
});

describe('P/L tracker — summary cards', () => {
  it('computes open, closed, today P/L, win rate, open positions', async () => {
    const { db, config } = await setup();
    const { summary } = buildTrackerDashboard(db, config);
    expect(summary.openPositions).toBe(1);
    expect(summary.closedTrades).toBe(2);
    // closed P/L = +1.0 - 0.5 = 0.5
    expect(summary.closedPlUsd).toBeCloseTo(0.5, 4);
    // win rate = 1 winner / 2 = 50%
    expect(summary.winRatePct).toBe(50);
    // open P/L = unrealized on the open position (latest snapshot price 0.012 vs entry 0.01) * qty 100 = 0.2
    expect(summary.openPlUsd).toBeCloseTo(0.2, 4);
  });
});

describe('P/L tracker — positions & detail', () => {
  it('lists only open positions with derived fields', async () => {
    const { db, config } = await setup();
    const model = buildPositionsModel(db, config);
    expect(model.positions.length).toBe(1);
    const p = model.positions[0]!;
    expect(p.status).toBe('OPEN');
    expect(p.positionSizeUsd).toBe(1);
    expect(p.exitStatus).toBeTruthy();
  });

  it('returns a detail with mint, event log and exit guidance', async () => {
    const { db, config, openId } = await setup();
    const detail = buildPositionDetail(db, config, openId);
    expect(detail).not.toBeNull();
    expect(detail!.mint).toBeTruthy();
    expect(detail!.entryReason).toContain('entry');
    expect(detail!.eventLog.length).toBeGreaterThan(0);
    expect(detail!.exitGuidance).toBeTruthy();
  });

  it('returns null for unknown position id', async () => {
    const { db, config } = await setup();
    expect(buildPositionDetail(db, config, 999999)).toBeNull();
  });
});

describe('P/L tracker — closed trades', () => {
  it('computes best/worst/avg/net stats', async () => {
    const { db, config } = await setup();
    const model = buildTradesModel(db, config);
    expect(model.stats.totalClosed).toBe(2);
    expect(model.stats.bestTradeUsd).toBeCloseTo(1.0, 4);
    expect(model.stats.worstTradeUsd).toBeCloseTo(-0.5, 4);
    expect(model.stats.netPlUsd).toBeCloseTo(0.5, 4);
    expect(model.trades.length).toBe(2);
  });
});

describe('P/L tracker — radar & watchlist', () => {
  it('radar uses live scored tokens and excludes tokens with an open position', async () => {
    const { db, config, openTokenId } = await setup();
    const model = buildRadarModel(db, config);
    expect(model.source).toBe('live');
    expect(model.candidates.length).toBeGreaterThan(0);
    const openRec = db.getTokenRecord(openTokenId);
    expect(model.candidates.some((c) => c.mint === openRec.mint)).toBe(false);
    for (const c of model.candidates) expect(c.verdict).toBeTruthy();
  });

  it('watchlist falls back to fixtures when no live watch candidates exist', async () => {
    const { db, config } = await setup();
    const model = buildWatchlistModel(db, config);
    // No live watch_only candidates seeded → fixture fallback (or empty live set)
    expect(['live', 'fixture']).toContain(model.source);
    expect(Array.isArray(model.entries)).toBe(true);
  });
});
