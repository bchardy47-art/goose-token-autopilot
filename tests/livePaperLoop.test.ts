import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db';
import { makeTestConfig, seedScoredDb } from './helpers';
import { applyLatestQuoteResultToSnapshot, buildPaperEligibilityDiagnostics, isPaperQuoteReady, isPaperResearchBlocked, runAutoPaper } from '../src/paper/autoPaper';
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

  it('paper buy allowed only when quote YES, slippage within max, and existing gates pass', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = Math.max(1, config.maxSlippageBps - 1);
    snapshot.creatorStatus = 'UNKNOWN';
    snapshot.holderConcentration = 'RISKY';
    snapshot.movedBeforeDiscoveryPct = config.maxChasePct + 10;
    const score = db.getLatestScore(safe.id)!;
    expect(isPaperQuoteReady(snapshot, score, config)).toBeNull();
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

  it('MAX_CHASE alone does not block simulated paper if score/quote gates pass', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    const snapshot = db.getLatestSnapshot(safe.id)!;
    snapshot.sellQuoteAvailable = 'YES';
    snapshot.estimatedSlippageBps = 100;
    snapshot.movedBeforeDiscoveryPct = config.maxChasePct + 50;
    expect(isPaperResearchBlocked(snapshot, db.getLatestScore(safe.id)!, config)).toBeNull();
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

  it('duplicate open paper positions are not created', async () => {
    const { dir, config, db } = await seedScoredDb();
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

  it('token:paper-review closes take-profit', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
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
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
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
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
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
    const safe = db.findTokenByMint('SAFE11111111111111111111111111111111111111111')!;
    db.createQuoteSellabilityCheck(safe.id, 'SAFE11111111111111111111111111111111111111111', new Date().toISOString(), 'jupiter', 'SAFE11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112', 2, '100', true, '1000', 100, 0.01, 'YES', 'SELLABLE_LOW_SLIPPAGE', null, { sample: true });
    await runAutoPaper(db, config);
    const report = buildPaperPerformanceReport(db);
    expect(report).toHaveProperty('currentPnlUsd');
    expect(report).toHaveProperty('realizedPnlUsd');
    expect(report).toHaveProperty('unrealizedPnlUsd');
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
    expect(JSON.stringify(report.topSkipReasons)).toMatch(/sell quote unknown|sell quote unavailable|slippage/);
    db.close();
  });

  it('daily-report works', async () => {
    const { dir, config, db } = await seedScoredDb();
    cleanup.push(dir);
    await runAutoPaper(db, config);
    const report = buildDailyReport(db, config);
    expect(report).toHaveProperty('tokensScannedToday');
    expect(report).toHaveProperty('topRedFlags');
    expect(report).toHaveProperty('paperEligibilitySummary');
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
