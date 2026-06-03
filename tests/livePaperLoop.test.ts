import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig, seedScoredDb } from './helpers';
import { applyLatestQuoteResultToSnapshot, buildPaperEligibilityDiagnostics, isPaperQuoteReady, isPaperResearchBlocked, runAutoPaper } from '../src/paper/autoPaper';
import { buildFreshCandidateWatchlist, renderFreshCandidateWatchlist } from '../src/paper/freshWatchlist';
import { paperBuy } from '../src/trading/paper';
import { runPaperReview, runPaperReviewLoop } from '../src/paper/review';
import { buildPaperPerformanceReport } from '../src/paper/performance';
import { buildDailyReport, renderPaperAutopsy, renderPaperDashboard } from '../src/paper/dailyReport';
import { verifySafety } from '../src/verifySafety';
import * as scanner from '../src/scanner';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('live paper loop', () => {
  it('token:auto-paper opens paper positions only and never creates real trade attempts', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    const result = await runAutoPaper(db, config);
    expect(result.decisions.some((decision) => decision.action === 'BOUGHT')).toBe(true);
    expect(db.listPositions('PAPER').filter((position) => position.status === 'OPEN').length).toBeGreaterThan(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('auto-paper sees latest fresh quote routeAvailable true as sellQuoteAvailable YES', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    const quote = db.createQuoteSellabilityCheck(safe.id, snapshot.mint, new Date().toISOString(), 'jupiter', snapshot.mint, 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    const applied = applyLatestQuoteResultToSnapshot(snapshot, db.getLatestQuoteSellabilityCheck(safe.id), config)!;
    expect(quote).toBeGreaterThan(0);
    expect(applied.sellQuoteAvailable).toBe('YES');
    db.close();
  });

  it('auto-paper uses estimatedSlippageBps from latest quote result', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    db.createQuoteSellabilityCheck(safe.id, snapshot.mint, new Date().toISOString(), 'jupiter', snapshot.mint, 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 123, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    const applied = applyLatestQuoteResultToSnapshot(snapshot, db.getLatestQuoteSellabilityCheck(safe.id), config)!;
    expect(applied.estimatedSlippageBps).toBe(123);
    db.close();
  });

  it('stale quote result does not make paper eligible', async () => {
    const { dir, config, db } = await seedScoredDb({ QUOTE_CHECK_CACHE_MINUTES: '1' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    db.createQuoteSellabilityCheck(safe.id, snapshot.mint, new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'jupiter', snapshot.mint, 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    const applied = applyLatestQuoteResultToSnapshot(snapshot, db.getLatestQuoteSellabilityCheck(safe.id), config)!;
    expect(applied.sellQuoteAvailable).toBe(snapshot.sellQuoteAvailable);
    db.close();
  });

  it('routeAvailable false blocks paper', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    db.createQuoteSellabilityCheck(safe.id, snapshot.mint, new Date().toISOString(), 'jupiter', snapshot.mint, 'So11111111111111111111111111111111111111112', 2, '100', false, null, null, null, 'NO', 'NO_ROUTE', 'no route', { sample: true });
    const applied = applyLatestQuoteResultToSnapshot(snapshot, db.getLatestQuoteSellabilityCheck(safe.id), config)!;
    expect(isPaperQuoteReady(applied, db.getLatestScore(safe.id)!, config)).toMatch(/sell quote unavailable/);
    db.close();
  });

  it('unknown/error quote result blocks paper', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    db.createQuoteSellabilityCheck(safe.id, snapshot.mint, new Date().toISOString(), 'jupiter', snapshot.mint, 'So11111111111111111111111111111111111111112', 2, '100', null, null, null, null, 'UNKNOWN', 'UNKNOWN', 'quote failed', { sample: true });
    const applied = applyLatestQuoteResultToSnapshot(snapshot, db.getLatestQuoteSellabilityCheck(safe.id), config)!;
    expect(isPaperQuoteReady(applied, db.getLatestScore(safe.id)!, config)).toMatch(/sell quote unknown/);
    db.close();
  });

  it('paper buy blocked when quote UNKNOWN', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'UNKNOWN';
    snapshot.estimatedSlippageBps = null;
    expect(isPaperQuoteReady(snapshot, db.getLatestScore(safe.id)!, config)).toMatch(/sell quote unknown/);
    db.close();
  });

  it('paper buy blocked when quote NO', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'NO';
    snapshot.estimatedSlippageBps = 100;
    expect(isPaperQuoteReady(snapshot, db.getLatestScore(safe.id)!, config)).toMatch(/sell quote unavailable/);
    db.close();
  });

  it('paper buy blocked when slippage missing', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = null;
    expect(isPaperQuoteReady(snapshot, db.getLatestScore(safe.id)!, config)).toMatch(/slippage missing/);
    db.close();
  });

  it('paper buy blocked when slippage above max', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = config.maxSlippageBps + 1;
    expect(isPaperQuoteReady(snapshot, db.getLatestScore(safe.id)!, config)).toMatch(/slippage above MAX_SLIPPAGE_BPS/);
    db.close();
  });

  it('high watch priority + runner profile + existing paper gates pass => paper buy can open', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'true' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = Math.max(1, config.maxSlippageBps - 1);
    snapshot.liquidityUsd = 15000;
    snapshot.volume1hUsd = 150000;
    snapshot.priceChange1hPct = 20;
    const score = { ...db.getLatestScore(safe.id)!, momentumScore: 25, safetyScore: 25, totalScore: 65 };
    expect(isPaperQuoteReady(snapshot, score, config)).toBeNull();
    expect(isPaperResearchBlocked(snapshot, score, config)).toBeNull();
    db.close();
  });

  it('non-high priority or non-runner profile blocks paper even if existing paper gates pass', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'true' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = Math.max(1, config.maxSlippageBps - 1);
    snapshot.liquidityUsd = 9000;
    snapshot.volume1hUsd = 70000;
    snapshot.priceChange1hPct = 10;
    const score = { ...db.getLatestScore(safe.id)!, momentumScore: 19, safetyScore: 25, totalScore: 65 };
    expect(isPaperResearchBlocked(snapshot, score, config)).toMatch(/watch priority below paper requirement/);
    db.close();
  });

  it('PAPER_REQUIRE_HIGH_WATCH_PRIORITY=false preserves previous behavior', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = Math.max(1, config.maxSlippageBps - 1);
    snapshot.creatorStatus = 'UNKNOWN';
    snapshot.holderConcentration = 'RISKY';
    const score = db.getLatestScore(safe.id)!;
    expect(isPaperResearchBlocked(snapshot, score, config)).toBeNull();
    db.close();
  });

  it('creator UNKNOWN alone does not block simulated paper if all paper gates pass', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = 100;
    snapshot.creatorStatus = 'UNKNOWN';
    expect(isPaperResearchBlocked(snapshot, db.getLatestScore(safe.id)!, config)).toBeNull();
    db.close();
  });

  it('holder RISKY alone does not block simulated paper if score/quote gates pass', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = 100;
    snapshot.holderConcentration = 'RISKY';
    expect(isPaperResearchBlocked(snapshot, db.getLatestScore(safe.id)!, config)).toBeNull();
    db.close();
  });

  it('MAX_CHASE now blocks paper entries that are already too late', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = 100;
    snapshot.movedBeforeDiscoveryPct = config.maxChasePct + 50;
    expect(isPaperResearchBlocked(snapshot, db.getLatestScore(safe.id)!, config)).toMatch(/MAX_CHASE_PCT/);
    db.close();
  });

  it('mint/freeze UNSAFE still block paper', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const mintUnsafe = db.getLatestSnapshot(safe.id)!;
    mintUnsafe.sellQuoteAvailable = 'YES';
    mintUnsafe.estimatedSlippageBps = 100;
    mintUnsafe.mintAuthority = 'UNSAFE';
    expect(isPaperResearchBlocked(mintUnsafe, db.getLatestScore(safe.id)!, config)).toMatch(/mint authority active/);
    const freezeUnsafe = db.getLatestSnapshot(safe.id)!;
    freezeUnsafe.sellQuoteAvailable = 'YES';
    freezeUnsafe.estimatedSlippageBps = 100;
    freezeUnsafe.freezeAuthority = 'UNSAFE';
    expect(isPaperResearchBlocked(freezeUnsafe, db.getLatestScore(safe.id)!, config)).toMatch(/freeze authority active/);
    db.close();
  });

  it('score minimum failures still block paper', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const watch = db.findTokenByMint('WATCH111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(watch.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = 100;
    const lowScore = {
      ...db.getLatestScore(watch.id)!,
      totalScore: 10,
      safetyScore: 10,
      momentumScore: 10,
    };
    expect(JSON.stringify(isPaperResearchBlocked(snapshot, lowScore, config))).toMatch(/score below paper minimum|momentum score below paper minimum|safety score below paper minimum|total score below paper minimum/);
    db.close();
  });

  it('a candidate with score verdict AVOID caused only by strict score logic can open simulated paper if all paper gates pass', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.creatorStatus = 'UNKNOWN';
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = 100;
    db.insertSnapshot(safe.id, snapshot);
    const result = await runAutoPaper(db, config);
    expect(result.decisions.some((decision) => decision.action === 'BOUGHT' && decision.tokenId === safe.id)).toBe(true);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('paperApproved still cannot bypass duplicate open position, max open positions, or missing latest price', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const proposalId = db.createProposal(safe.id, 'BUY', 1, 'AVOID', 'test', 'PENDING', {});
    const first = paperBuy(db, config, { proposalId, paperApproved: true });
    expect(first.positionId).toBeGreaterThan(0);
    expect(() => paperBuy(db, config, { proposalId, paperApproved: true })).toThrow(/Duplicate open paper position blocked/);
    db.close();

    const seeded = await seedScoredDb({ MAX_OPEN_POSITIONS: '0' });
    cleanup.push(seeded.dir);
    const safe2 = seeded.db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const proposalId2 = seeded.db.createProposal(safe2.id, 'BUY', 1, 'AVOID', 'test', 'PENDING', {});
    expect(() => paperBuy(seeded.db, seeded.config, { proposalId: proposalId2, paperApproved: true })).toThrow(/Max open positions cap reached/);
    seeded.db.close();

    const seeded2 = await seedScoredDb();
    cleanup.push(seeded2.dir);
    const safe3 = seeded2.db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    seeded2.db.sqlite.prepare('DELETE FROM token_snapshots WHERE token_id = ?').run(safe3.id);
    const proposalId3 = seeded2.db.createProposal(safe3.id, 'BUY', 1, 'AVOID', 'test', 'PENDING', {});
    expect(() => paperBuy(seeded2.db, seeded2.config, { proposalId: proposalId3, paperApproved: true })).toThrow(/Latest token snapshot price is unavailable/);
    seeded2.db.close();
  });

  it('duplicate/open cap/daily cap still block after watch-priority gating', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
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
    expect(skipped).toMatch(/hard red flags|sell quote unknown blocks paper eligibility|total score below paper minimum|safety score below paper minimum|momentum score below paper minimum/);
    db.close();
  });

  it('paper-review refreshes an open position price before calculating P/L and closes take profit', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    const refreshSpy = vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockImplementation(async () => {
      const refreshed = db.getLatestSnapshot(open.tokenId)!;
      refreshed.priceUsd = open.entryPriceUsd * 1.6;
      db.insertSnapshot(open.tokenId, refreshed);
      return { refreshed: 1, tokenIds: [open.tokenId] };
    });
    const review = await runPaperReview(db, config);
    expect(refreshSpy).toHaveBeenCalled();
    expect(review.refreshedCount).toBeGreaterThanOrEqual(1);
    expect(review.decisions.some((decision) => decision.reason === 'take_profit')).toBe(true);
    db.close();
  });

  it('if refreshed price hits stop loss, paper-review closes the position', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockImplementation(async () => {
      const refreshed = db.getLatestSnapshot(open.tokenId)!;
      refreshed.priceUsd = open.entryPriceUsd * 0.5;
      db.insertSnapshot(open.tokenId, refreshed);
      return { refreshed: 1, tokenIds: [open.tokenId] };
    });
    const review = await runPaperReview(db, config);
    expect(review.decisions.some((decision) => decision.reason === 'stop_loss')).toBe(true);
    db.close();
  });

  it('trailing stop does not trigger before activation threshold', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_TRAILING_STOP_ENABLED: 'true', PAPER_TRAILING_ACTIVATION_PCT: '30', PAPER_TRAILING_STOP_PCT: '15' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockImplementation(async () => {
      const refreshed = db.getLatestSnapshot(open.tokenId)!;
      refreshed.priceUsd = open.entryPriceUsd * 1.2;
      db.insertSnapshot(open.tokenId, refreshed);
      return { refreshed: 1, tokenIds: [open.tokenId] };
    });
    const review = await runPaperReview(db, config);
    expect(review.decisions.some((decision) => decision.reason === 'trailing_stop')).toBe(false);
    db.close();
  });

  it('trailing stop closes after activation when pullback >= trailing stop pct', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_TRAILING_STOP_ENABLED: 'true', PAPER_TRAILING_ACTIVATION_PCT: '30', PAPER_TRAILING_STOP_PCT: '15' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    const rise = db.getLatestSnapshot(open.tokenId)!;
    rise.priceUsd = open.entryPriceUsd * 1.5;
    db.insertSnapshot(open.tokenId, rise);
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockImplementation(async () => {
      const refreshed = db.getLatestSnapshot(open.tokenId)!;
      refreshed.priceUsd = open.entryPriceUsd * 1.3;
      db.insertSnapshot(open.tokenId, refreshed);
      return { refreshed: 1, tokenIds: [open.tokenId] };
    });
    const review = await runPaperReview(db, config);
    expect(review.decisions.some((decision) => decision.reason === 'trailing_stop')).toBe(true);
    db.close();
  });

  it('early fade does not trigger before min hold time', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_EARLY_FADE_EXIT_ENABLED: 'true', PAPER_EARLY_FADE_MIN_HOLD_MINUTES: '30', PAPER_EARLY_FADE_MAX_BEST_GAIN_PCT: '15', PAPER_EARLY_FADE_EXIT_BELOW_PNL_PCT: '-8' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockImplementation(async () => {
      const refreshed = db.getLatestSnapshot(open.tokenId)!;
      refreshed.priceUsd = open.entryPriceUsd * 0.9;
      db.insertSnapshot(open.tokenId, refreshed);
      return { refreshed: 1, tokenIds: [open.tokenId] };
    });
    const review = await runPaperReview(db, config);
    expect(review.decisions.some((decision) => decision.reason === 'early_fade')).toBe(false);
    db.close();
  });

  it('early fade does not trigger if bestGainPct reached activation threshold', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_EARLY_FADE_EXIT_ENABLED: 'true', PAPER_EARLY_FADE_MIN_HOLD_MINUTES: '30', PAPER_EARLY_FADE_MAX_BEST_GAIN_PCT: '15', PAPER_EARLY_FADE_EXIT_BELOW_PNL_PCT: '-8' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    const rise = db.getLatestSnapshot(open.tokenId)!;
    rise.priceUsd = open.entryPriceUsd * 1.2;
    db.insertSnapshot(open.tokenId, rise);
    db.sqlite.prepare("UPDATE positions SET opened_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), open.id);
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockImplementation(async () => {
      const refreshed = db.getLatestSnapshot(open.tokenId)!;
      refreshed.priceUsd = open.entryPriceUsd * 0.9;
      db.insertSnapshot(open.tokenId, refreshed);
      return { refreshed: 1, tokenIds: [open.tokenId] };
    });
    const review = await runPaperReview(db, config);
    expect(review.decisions.some((decision) => decision.reason === 'early_fade')).toBe(false);
    db.close();
  });

  it('early fade closes weak/choppy position after min hold and pnl below threshold', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_EARLY_FADE_EXIT_ENABLED: 'true', PAPER_EARLY_FADE_MIN_HOLD_MINUTES: '30', PAPER_EARLY_FADE_MAX_BEST_GAIN_PCT: '15', PAPER_EARLY_FADE_EXIT_BELOW_PNL_PCT: '-8' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    const rise = db.getLatestSnapshot(open.tokenId)!;
    rise.priceUsd = open.entryPriceUsd * 1.08;
    db.insertSnapshot(open.tokenId, rise);
    db.sqlite.prepare("UPDATE positions SET opened_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), open.id);
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockImplementation(async () => {
      const refreshed = db.getLatestSnapshot(open.tokenId)!;
      refreshed.priceUsd = open.entryPriceUsd * 0.89;
      db.insertSnapshot(open.tokenId, refreshed);
      return { refreshed: 1, tokenIds: [open.tokenId] };
    });
    const review = await runPaperReview(db, config);
    expect(review.decisions.some((decision) => decision.reason === 'early_fade')).toBe(true);
    db.close();
  });

  it('if refresh fails, paper-review holds/reviews using existing snapshot and does not crash', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_MAX_HOLD_MINUTES: '60' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockRejectedValue(new Error('refresh failed'));
    const review = await runPaperReview(db, config);
    expect(review.decisions.every((decision) => ['HELD', 'CLOSED'].includes(decision.action))).toBe(true);
    db.close();
  });

  it('token:paper-review closes max-hold-time', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_MAX_HOLD_MINUTES: '1' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    db.sqlite.prepare("UPDATE positions SET opened_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 60 * 1000).toISOString(), open.id);
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockResolvedValue({ refreshed: 0, tokenIds: [] });
    const review = await runPaperReview(db, config);
    expect(review.decisions.some((decision) => decision.reason === 'max_hold_time')).toBe(true);
    db.close();
  });

  it('paper-review never opens paper positions and never records real trade attempts', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const beforeOpen = db.getOpenPositionCount('PAPER');
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockResolvedValue({ refreshed: 0, tokenIds: [] });
    await runPaperReview(db, config);
    expect(db.getOpenPositionCount('PAPER')).toBeLessThanOrEqual(beforeOpen);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('paper-review-loop stops immediately when no open paper positions remain', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const sleep = vi.fn(async () => undefined);
    const onCycle = vi.fn();
    const result = await runPaperReviewLoop(db, config, { sleep, onCycle });
    expect(result.cyclesRun).toBe(0);
    expect(result.stoppedReason).toBe('no_open_positions');
    expect(result.intervalMs).toBe(60_000);
    expect(result.maxCycles).toBe(30);
    expect(result.cycleSummaries).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(onCycle).not.toHaveBeenCalled();
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('paper-review-loop repeats reviews until all paper positions are closed', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_TAKE_PROFIT_PCT: '1000', PAPER_STOP_LOSS_PCT: '-1000', PAPER_MAX_HOLD_MINUTES: '1' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const proposalId = db.createProposal(safe.id, 'BUY', 1, 'PAPER_BUY', 'loop test', 'PENDING', {});
    const { positionId } = paperBuy(db, config, { proposalId, paperApproved: true });
    const open = db.listPositions('PAPER').find((position) => position.id === positionId)!;
    let sleepCalls = 0;
    const sleep = vi.fn(async () => {
      sleepCalls += 1;
      if (sleepCalls === 1) {
        db.sqlite.prepare("UPDATE positions SET opened_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 60 * 1000).toISOString(), open.id);
      }
    });
    const onCycle = vi.fn();
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockImplementation(async () => {
      const refreshed = db.getLatestSnapshot(open.tokenId)!;
      refreshed.priceUsd = open.entryPriceUsd * 1.01;
      db.insertSnapshot(open.tokenId, refreshed);
      return { refreshed: 1, tokenIds: [open.tokenId] };
    });
    const result = await runPaperReviewLoop(db, config, { intervalMs: 5, maxCycles: 5, sleep, onCycle });
    expect(result.cyclesRun).toBe(2);
    expect(result.stoppedReason).toBe('no_open_positions');
    expect(result.cycleSummaries).toHaveLength(2);
    expect(result.cycleSummaries[0]).toMatchObject({ cycleNumber: 1, reviewedCount: 1, refreshedCount: 1, remainingOpenCount: 1 });
    expect(result.cycleSummaries[1]).toMatchObject({ cycleNumber: 2, reviewedCount: 1, refreshedCount: 1, remainingOpenCount: 0 });
    expect(result.cycleSummaries[1].decisions.some((decision) => decision.reason === 'max_hold_time')).toBe(true);
    expect(onCycle).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5);
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('paper-review-loop stops at max cycles when positions remain open', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_TAKE_PROFIT_PCT: '1000', PAPER_STOP_LOSS_PCT: '-1000', PAPER_MAX_HOLD_MINUTES: '1000' });
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const proposalId = db.createProposal(safe.id, 'BUY', 1, 'PAPER_BUY', 'loop test', 'PENDING', {});
    paperBuy(db, config, { proposalId, paperApproved: true });
    vi.spyOn(scanner, 'refreshSnapshotsForTokenAddresses').mockResolvedValue({ refreshed: 1, tokenIds: [safe.id] });
    const sleep = vi.fn(async () => undefined);
    const result = await runPaperReviewLoop(db, config, { intervalMs: 7, maxCycles: 3, sleep });
    expect(result.cyclesRun).toBe(3);
    expect(result.stoppedReason).toBe('max_cycles_reached');
    expect(result.cycleSummaries).toHaveLength(3);
    expect(result.cycleSummaries.every((summary) => summary.reviewedCount >= 1)).toBe(true);
    expect(result.cycleSummaries.at(-1)?.remainingOpenCount).toBeGreaterThan(0);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(db.getOpenPositionCount('PAPER')).toBeGreaterThan(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('verify-safety includes trailing stop config', () => {
    const { dir, config } = makeTestConfig();
    cleanup.push(dir);
    const status = verifySafety(config) as any;
    expect(status).toHaveProperty('paperTrailingStopEnabled');
    expect(status).toHaveProperty('paperTrailingActivationPct');
    expect(status).toHaveProperty('paperTrailingStopPct');
    expect(status).toHaveProperty('paperEarlyFadeExitEnabled');
    expect(status).toHaveProperty('paperEarlyFadeMinHoldMinutes');
    expect(status).toHaveProperty('paperEarlyFadeMaxBestGainPct');
    expect(status).toHaveProperty('paperEarlyFadeExitBelowPnlPct');
  });

  it('paper-dashboard renders entry snapshot summary alongside positions and safety footer', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    const snap = db.getLatestSnapshot(open.tokenId)!;
    snap.priceUsd = open.entryPriceUsd * 1.6;
    db.insertSnapshot(open.tokenId, snap);
    await runPaperReview(db, config);
    const dashboard = renderPaperDashboard(db, config);
    expect(dashboard).toContain('Paper Trading Dashboard');
    expect(dashboard).toContain('Open Positions');
    expect(dashboard).toContain('Closed Positions');
    expect(dashboard).toContain('Summary');
    expect(dashboard).toContain('entryProfile=');
    expect(dashboard).toContain('entryPriority=');
    expect(dashboard).toContain('Real trading remains locked.');
    expect(dashboard).toContain('Paper only.');
    expect(db.getOpenPositionCount('PAPER')).toBeGreaterThanOrEqual(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('paper-autopsy renders immutable entry-time score/snapshot/profile/priority fields with summary counts and safety footer', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const open = db.listPositions('PAPER').find((position) => position.status === 'OPEN')!;
    const originalEntry = db.getPaperEntrySummary(open.id)!;
    const snap = db.getLatestSnapshot(open.tokenId)!;
    snap.priceUsd = open.entryPriceUsd * 1.6;
    snap.sellQuoteAvailable = 'UNKNOWN';
    snap.holderConcentration = 'RISKY';
    db.insertSnapshot(open.tokenId, snap);
    await runPaperReview(db, config);
    const autopsy = renderPaperAutopsy(db, config);
    expect(autopsy).toContain('Paper Trade Autopsy');
    expect(autopsy).toContain('Summary');
    expect(autopsy).toContain('winners count');
    expect(autopsy).toContain('losers count');
    expect(autopsy).toContain('score total=');
    expect(autopsy).toContain('snapshot liq=');
    expect(autopsy).toContain(`sellQuote=${originalEntry.snapshotSellQuoteAvailable}`);
    expect(autopsy).toContain(`profile=${originalEntry.profile}`);
    expect(autopsy).toContain(`priority=${originalEntry.priority}`);
    expect(autopsy).toContain('Real trading remains locked. Paper only.');
    expect(db.getOpenPositionCount('PAPER')).toBeGreaterThanOrEqual(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('paper-performance report calculates P/L', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const report = buildPaperPerformanceReport(db) as any;
    expect(report).toHaveProperty('currentPnlUsd');
    expect(report).toHaveProperty('realizedPnlUsd');
    expect(report).toHaveProperty('unrealizedPnlUsd');
    expect(report).toHaveProperty('openPositions');
    expect(report).toHaveProperty('closedPositions');
    db.close();
  });

  it('paper-eligibility report does not open paper positions or record real trade attempts', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const report = buildPaperEligibilityDiagnostics(db, config);
    expect(report).toHaveProperty('totalCandidatesEvaluated');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('paper-eligibility blockers now include stale entry data and already-moved MAX_CHASE entries', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const safeSnapshot = db.getLatestSnapshot(safe.id)!;
    db.createQuoteSellabilityCheck(safe.id, safeSnapshot.mint, new Date().toISOString(), 'jupiter', safeSnapshot.mint, 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    safeSnapshot.creatorStatus = 'UNKNOWN';
    safeSnapshot.dataUpdatedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    safeSnapshot.movedBeforeDiscoveryPct = config.maxChasePct + 25;
    db.insertSnapshot(safe.id, safeSnapshot);
    const report = buildPaperEligibilityDiagnostics(db, config) as any;
    const candidate = report.topClosestCandidates.find((row: any) => row.tokenId === safe.id);
    expect(candidate).toBeTruthy();
    expect(JSON.stringify(candidate.blockers)).toMatch(/entry data stale blocks paper eligibility|moved before discovery blocks paper eligibility/);
    expect(JSON.stringify(report.topWarnings)).toMatch(/creator status unknown|token moved above MAX_CHASE_PCT before discovery/);
    db.close();
  });

  it('eligibleForPaperCount still uses blockers, not warnings, and creator UNKNOWN remains warning-only', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const safeSnapshot = db.getLatestSnapshot(safe.id)!;
    db.createQuoteSellabilityCheck(safe.id, safeSnapshot.mint, new Date().toISOString(), 'jupiter', safeSnapshot.mint, 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    safeSnapshot.creatorStatus = 'UNKNOWN';
    db.insertSnapshot(safe.id, safeSnapshot);
    const report = buildPaperEligibilityDiagnostics(db, config) as any;
    expect(report.eligibleForPaperCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(report.topSkipReasons)).not.toMatch(/creator status unknown/);
    expect(JSON.stringify(report.topWarnings)).toMatch(/creator status unknown|holder concentration/);
    db.close();
  });

  it('paper-eligibility report counts quote-ready vs quote-unknown candidates and returns closest candidates', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const watch = db.findTokenByMint('WATCH111111111111111111111111111111111111111')!;
    const safeSnapshot = db.getLatestSnapshot(safe.id)!;
    db.createQuoteSellabilityCheck(safe.id, safeSnapshot.mint, new Date().toISOString(), 'jupiter', safeSnapshot.mint, 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    const report = buildPaperEligibilityDiagnostics(db, config) as any;
    expect(report.quoteReadyCount).toBeGreaterThanOrEqual(1);
    expect(report.quoteUnknownCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(report.topClosestCandidates)).toBe(true);
    expect(report.topClosestCandidates.length).toBeGreaterThan(0);
    expect(watch.id).toBeGreaterThan(0);
    db.close();
  });

  it('paper-eligibility report counts score gate failures and quote blockers', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const report = buildPaperEligibilityDiagnostics(db, config) as any;
    expect(report).toHaveProperty('failedTotalScoreCount');
    expect(report).toHaveProperty('failedSafetyScoreCount');
    expect(report).toHaveProperty('failedMomentumScoreCount');
    expect(report).toHaveProperty('topWarnings');
    expect(JSON.stringify(report.topSkipReasons)).toMatch(/sell quote unknown|sell quote unavailable|slippage/);
    db.close();
  });

  it('paper-eligibility ranks fresh lower-score candidates above stale high-score candidates when blocker counts tie', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const base = db.getLatestSnapshot(safe.id)!;

    const staleHigh = {
      ...base,
      mint: 'STALEHIGH111111111111111111111111111111111111',
      symbol: 'STALEHI',
      name: 'Stale High',
      sourceUrl: 'fixture://stale-high',
      discoveredAt: new Date().toISOString(),
      dataUpdatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      movedBeforeDiscoveryPct: 40
    };
    const freshLow = {
      ...base,
      mint: 'FRESHLOW111111111111111111111111111111111111',
      symbol: 'FRESHLO',
      name: 'Fresh Low',
      sourceUrl: 'fixture://fresh-low',
      discoveredAt: new Date().toISOString(),
      dataUpdatedAt: new Date().toISOString(),
      movedBeforeDiscoveryPct: 20,
      metadataPresent: false,
      websitePresent: false,
      socialsPresent: false,
      creatorStatus: 'SAFE',
      liquidityUsd: 30000,
      volume5mUsd: 200,
      volume1hUsd: 3000,
      volume24hUsd: 12000,
      priceChange5mPct: 2,
      priceChange1hPct: 12,
      buys5m: 6,
      sells5m: 4,
      liquidityGrowthPct: 0
    };

    const staleId = db.upsertToken(staleHigh);
    db.insertSnapshot(staleId, staleHigh);
    const freshId = db.upsertToken(freshLow);
    db.insertSnapshot(freshId, freshLow);

    const report = buildPaperEligibilityDiagnostics(db, config) as any;
    const ids = report.topClosestCandidates.map((row: any) => row.tokenId);
    const staleRow = report.topClosestCandidates.find((row: any) => row.tokenId === staleId);
    const freshRow = report.topClosestCandidates.find((row: any) => row.tokenId === freshId);

    expect(staleRow.blockers).toContain('entry data stale blocks paper eligibility');
    expect(freshRow.blockers).toContain('total score below paper minimum');
    expect(ids.indexOf(freshId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(staleId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(freshId)).toBeLessThan(ids.indexOf(staleId));
    expect(String(staleRow.usefulRankReason)).toContain('entry data stale');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('paper-eligibility ranks not-moved candidates above moved-before-discovery candidates when blocker counts tie', async () => {
    const { dir, config, db } = await seedScoredDb({ PAPER_REQUIRE_HIGH_WATCH_PRIORITY: 'false' } as any);
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const base = db.getLatestSnapshot(safe.id)!;

    const movedCandidate = {
      ...base,
      mint: 'MOVEDRANK111111111111111111111111111111111111',
      symbol: 'MOVED',
      name: 'Moved Rank',
      sourceUrl: 'fixture://moved-rank',
      discoveredAt: new Date().toISOString(),
      dataUpdatedAt: new Date().toISOString(),
      movedBeforeDiscoveryPct: config.maxChasePct + 10
    };
    const notMovedCandidate = {
      ...base,
      mint: 'NOTMOVED111111111111111111111111111111111111',
      symbol: 'NOTMOVE',
      name: 'Not Moved',
      sourceUrl: 'fixture://not-moved',
      discoveredAt: new Date().toISOString(),
      dataUpdatedAt: new Date().toISOString(),
      movedBeforeDiscoveryPct: 20,
      metadataPresent: false,
      websitePresent: false,
      socialsPresent: false,
      creatorStatus: 'SAFE',
      liquidityUsd: 30000,
      volume5mUsd: 200,
      volume1hUsd: 3000,
      volume24hUsd: 12000,
      priceChange5mPct: 2,
      priceChange1hPct: 12,
      buys5m: 6,
      sells5m: 4,
      liquidityGrowthPct: 0
    };

    const movedId = db.upsertToken(movedCandidate);
    db.insertSnapshot(movedId, movedCandidate);
    const notMovedId = db.upsertToken(notMovedCandidate);
    db.insertSnapshot(notMovedId, notMovedCandidate);

    const report = buildPaperEligibilityDiagnostics(db, config) as any;
    const ids = report.topClosestCandidates.map((row: any) => row.tokenId);
    const movedRow = report.topClosestCandidates.find((row: any) => row.tokenId === movedId);
    const notMovedRow = report.topClosestCandidates.find((row: any) => row.tokenId === notMovedId);

    expect(movedRow.blockers).toContain('moved before discovery blocks paper eligibility');
    expect(notMovedRow.blockers).toContain('total score below paper minimum');
    expect(ids.indexOf(notMovedId)).toBeLessThan(ids.indexOf(movedId));
    expect(String(movedRow.usefulRankReason)).toContain('moved before discovery');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('paper-eligibility keeps eligible counts unchanged while ranking no-blocker candidates above blocked ones', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const safeSnapshot = db.getLatestSnapshot(safe.id)!;
    db.createQuoteSellabilityCheck(safe.id, safeSnapshot.mint, new Date().toISOString(), 'jupiter', safeSnapshot.mint, 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    const before = buildPaperEligibilityDiagnostics(db, config) as any;

    const blockedCandidate = {
      ...safeSnapshot,
      mint: 'BLOCKEDRANK11111111111111111111111111111111111',
      symbol: 'BLOCKED',
      name: 'Blocked Rank',
      sourceUrl: 'fixture://blocked-rank',
      discoveredAt: new Date().toISOString(),
      dataUpdatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      movedBeforeDiscoveryPct: 20
    };
    const blockedId = db.upsertToken(blockedCandidate);
    db.insertSnapshot(blockedId, blockedCandidate);

    const after = buildPaperEligibilityDiagnostics(db, config) as any;
    const ids = after.topClosestCandidates.map((row: any) => row.tokenId);

    expect(after.eligibleForPaperCount).toBe(before.eligibleForPaperCount);
    expect(after.paperBuysWouldOpenCount).toBe(before.paperBuysWouldOpenCount);
    expect(ids.indexOf(safe.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(blockedId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(safe.id)).toBeLessThan(ids.indexOf(blockedId));
    expect(after.topClosestCandidates.find((row: any) => row.tokenId === safe.id)?.usefulRankReason).toBe('eligible now');
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('fresh-watchlist filters out stale candidates above max age and stays read-only', async () => {
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

  it('fresh-watchlist shows fresh blocked candidates and ranks no-blocker fresh candidates first', async () => {
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
    const blockedRow = report.candidates.find((row) => row.tokenId === blockedId);
    const ids = report.candidates.map((row) => row.tokenId);

    expect(blockedRow).toBeTruthy();
    expect(blockedRow?.blockers.join(' ')).toMatch(/sell quote unknown|watch priority|score/);
    expect(ids.indexOf(safe.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(blockedId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(safe.id)).toBeLessThan(ids.indexOf(blockedId));
    expect(db.getOpenPositionCount('PAPER')).toBe(0);
    expect(db.getBlockedRealTradeAttempts()).toBe(0);
    db.close();
  });

  it('fresh-watchlist render includes no paper buys opened and real trading locked', async () => {
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

  it('daily-report works and includes new paper entry integrity counters', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    await runAutoPaper(db, config);
    const report = buildDailyReport(db, config) as any;
    expect(report).toHaveProperty('tokensScannedToday');
    expect(report).toHaveProperty('topRedFlags');
    expect(report).toHaveProperty('paperEligibilitySummary');
    expect(report).toHaveProperty('finalSafetyStatus');
    expect(report.paperEligibilitySummary).toHaveProperty('topSkipReasons');
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
