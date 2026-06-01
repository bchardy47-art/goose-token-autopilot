import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig } from './helpers';
import { normalizeDexScreenerCandidate } from '../src/scanner/dexscreenerSource';
import { runWatchOutcomes, calculateReturnPct, isDue, summarizeWatchOutcomes } from '../src/watchOutcomes';
import { buildWatchOnlyReport } from '../src/watchOnly';
import { verifySafety } from '../src/verifySafety';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeLiveCandidate(priceUsd = '1.00') {
  const candidate = normalizeDexScreenerCandidate(
    {
      chainId: 'solana',
      tokenAddress: 'OutcomeMint1111111111111111111111111111111111',
      url: 'https://dexscreener.com/solana/outcome',
      updatedAt: new Date().toISOString(),
      links: [{ label: 'Website', url: 'https://example.com' }]
    },
    [
      {
        chainId: 'solana',
        dexId: 'pumpfun',
        url: 'https://dexscreener.com/solana/outcome',
        pairAddress: 'OutcomePair111',
        pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
        priceUsd,
        marketCap: 250000,
        txns: { m5: { buys: 25, sells: 10 } },
        volume: { m5: 7000, h1: 25000, h24: 100000 },
        priceChange: { m5: 25, h1: 60, h24: 70 },
        liquidity: { usd: 12000 },
        info: { websites: [{ url: 'https://example.com', label: 'Website' }] },
        baseToken: { address: 'OutcomeMint1111111111111111111111111111111111', name: 'Outcome Token', symbol: 'OUT' },
        quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' }
      }
    ],
    new Date().toISOString()
  );
  if (!candidate) throw new Error('candidate build failed');
  return candidate;
}

describe('watch-only outcomes', () => {
  it('due 15m outcome is created', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate('1.00'));
    const watchId = db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1, 12000, 7000, 25000, { sample: true });
    db.sqlite.prepare('UPDATE watch_only_candidates SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 16 * 60 * 1000).toISOString(), watchId);
    db.insertSnapshot(tokenId, makeLiveCandidate('1.10'));
    const result = await runWatchOutcomes(db, config);
    expect(result.recorded).toBeGreaterThan(0);
    expect(db.getWatchOnlyOutcome(watchId, '15m')).not.toBeNull();
    db.close();
  });

  it('due 1h outcome is created and not-due 6h is skipped', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate('1.00'));
    const watchId = db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1, 12000, 7000, 25000, { sample: true });
    db.sqlite.prepare('UPDATE watch_only_candidates SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 61 * 60 * 1000).toISOString(), watchId);
    db.insertSnapshot(tokenId, makeLiveCandidate('1.20'));
    await runWatchOutcomes(db, config);
    expect(db.getWatchOnlyOutcome(watchId, '1h')).not.toBeNull();
    expect(db.getWatchOnlyOutcome(watchId, '6h')).toBeNull();
    db.close();
  });

  it('duplicate window outcome is not created', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate('1.00'));
    const watchId = db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1, 12000, 7000, 25000, { sample: true });
    db.sqlite.prepare('UPDATE watch_only_candidates SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), watchId);
    db.insertSnapshot(tokenId, makeLiveCandidate('1.05'));
    await runWatchOutcomes(db, config);
    await runWatchOutcomes(db, config);
    expect(db.listWatchOnlyOutcomes().filter((outcome) => outcome.windowLabel === '15m').length).toBe(1);
    db.close();
  });

  it('return_pct is calculated correctly', () => {
    expect(calculateReturnPct(1, 1.25)).toBe(25);
    expect(calculateReturnPct(1, 0.8)).toBe(-20);
  });

  it('take-profit and stop-loss flags work', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate('1.00'));
    const watchId = db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1, 12000, 7000, 25000, { sample: true });
    db.sqlite.prepare('UPDATE watch_only_candidates SET created_at = ?, best_gain_pct = ?, worst_drawdown_pct = ? WHERE id = ?').run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), 55, -40, watchId);
    db.insertSnapshot(tokenId, makeLiveCandidate('1.55'));
    await runWatchOutcomes(db, config);
    const outcome = db.getWatchOnlyOutcome(watchId, '15m')!;
    expect(outcome.wouldHitTakeProfit).toBe(true);
    expect(outcome.wouldHitStopLoss).toBe(true);
    db.close();
  });

  it('watch-outcomes never opens paper positions and never calls real execution', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate('1.00'));
    const watchId = db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1, 12000, 7000, 25000, { sample: true });
    db.sqlite.prepare('UPDATE watch_only_candidates SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), watchId);
    db.insertSnapshot(tokenId, makeLiveCandidate('1.10'));
    await runWatchOutcomes(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('watch-report includes outcome summary and real trading remains locked', async () => {
    const { dir, config } = makeTestConfig({ TOKEN_SOURCE: 'dexscreener' });
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate('1.00'));
    const watchId = db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1, 12000, 7000, 25000, { sample: true });
    db.sqlite.prepare('UPDATE watch_only_candidates SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), watchId);
    db.insertSnapshot(tokenId, makeLiveCandidate('1.10'));
    await runWatchOutcomes(db, config);
    const report = buildWatchOnlyReport(db, config);
    expect(report).toHaveProperty('outcomesRecordedByWindow');
    const status = verifySafety(config);
    expect(status.realTradingLockedByDefault).toBe(true);
    db.close();
  });

  it('isDue works for due and not-due cases', () => {
    expect(isDue(new Date(Date.now() - 16 * 60 * 1000).toISOString(), 15)).toBe(true);
    expect(isDue(new Date(Date.now() - 5 * 60 * 1000).toISOString(), 15)).toBe(false);
  });

  it('watch outcome summary helper returns per-window stats', () => {
    const { dir, config } = makeTestConfig();
    cleanup.push(dir);
    const db = createDb(config);
    const tokenId = db.upsertToken(makeLiveCandidate('1.00'));
    const watchId = db.upsertWatchOnlyCandidate(tokenId, 'WATCH_ONLY', 'interesting enough to track, unsafe to trade', 1, 1, 12000, 7000, 25000, { sample: true });
    db.createWatchOnlyOutcome(watchId, tokenId, '15m', 15, new Date().toISOString(), 1, 1.2, 20, 20, -5, false, false, 12000, 7000, 25000, 'test', { sample: true });
    const summary = summarizeWatchOutcomes(db, config);
    expect(summary).toHaveProperty('outcomesRecordedByWindow');
    db.close();
  });
});
