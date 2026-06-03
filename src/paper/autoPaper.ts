import { runScan } from '../scanner';
import { scoreToken } from '../scoring/scoreToken';
import type { AppDb } from '../db';
import type { AppConfig, AutoPaperDecision, PaperEligibilityDiagnosticRow, QuoteSellabilityCheckRow, TokenCandidate, TokenScoreResult } from '../types';
import { paperBuy } from '../trading/paper';
import { AppLogger } from '../logger';
import { classifyWatchPriority, classifyWatchRunnerProfile } from '../watchOnly';

function tokenAgeMinutes(candidate: TokenCandidate): number {
  return (Date.now() - new Date(candidate.tokenCreatedAt).getTime()) / 60_000;
}

function minutesSince(timestamp: string): number {
  return (Date.now() - new Date(timestamp).getTime()) / 60_000;
}

export function applyLatestQuoteResultToSnapshot(
  snapshot: TokenCandidate | null,
  quote: QuoteSellabilityCheckRow | null,
  config: AppConfig
): TokenCandidate | null {
  if (!snapshot || !quote) return snapshot;
  if (quote.mint !== snapshot.mint) return snapshot;
  if (minutesSince(quote.checkedAt) > config.quoteCheckCacheMinutes) return snapshot;

  let sellQuoteAvailable = snapshot.sellQuoteAvailable;
  if (quote.routeAvailable === true && quote.sellQuoteStatus === 'YES') {
    sellQuoteAvailable = 'YES';
  } else if (quote.routeAvailable === false || quote.sellQuoteStatus === 'NO') {
    sellQuoteAvailable = 'NO';
  } else {
    sellQuoteAvailable = 'UNKNOWN';
  }

  return {
    ...snapshot,
    sellQuoteAvailable,
    estimatedSlippageBps: quote.estimatedSlippageBps ?? null,
    raw: {
      ...snapshot.raw,
      latestQuoteSellabilityCheck: {
        checkedAt: quote.checkedAt,
        routeAvailable: quote.routeAvailable,
        sellQuoteStatus: quote.sellQuoteStatus,
        estimatedSlippageBps: quote.estimatedSlippageBps,
        safetyStatus: quote.safetyStatus,
        errorSummary: quote.errorSummary
      }
    }
  };
}

export function isPaperQuoteReady(snapshot: TokenCandidate | null, score: TokenScoreResult | null, config: AppConfig): string | null {
  if (!snapshot || !score) return 'missing score or snapshot';
  if (snapshot.sellQuoteAvailable === 'UNKNOWN') return 'sell quote unknown blocks paper eligibility';
  if (snapshot.sellQuoteAvailable === 'NO') return 'sell quote unavailable blocks paper eligibility';
  if (snapshot.sellQuoteAvailable !== 'YES') return 'sell quote not proven for paper eligibility';
  if (snapshot.estimatedSlippageBps === null || snapshot.estimatedSlippageBps === undefined) return 'slippage missing blocks paper eligibility';
  if (!Number.isFinite(snapshot.estimatedSlippageBps)) return 'slippage missing blocks paper eligibility';
  if (snapshot.estimatedSlippageBps > config.maxSlippageBps) return 'slippage above MAX_SLIPPAGE_BPS blocks paper eligibility';
  if (snapshot.mintAuthority === 'UNSAFE') return 'mint authority active blocks paper eligibility';
  if (snapshot.freezeAuthority === 'UNSAFE') return 'freeze authority active blocks paper eligibility';
  return null;
}

export function isPaperResearchBlocked(snapshot: TokenCandidate | null, score: TokenScoreResult | null, config: AppConfig): string | null {
  if (!config.enableAutoPaperTrading) return 'auto paper trading disabled';
  if (!snapshot || !score) return 'missing score or snapshot';
  const quoteReadiness = isPaperQuoteReady(snapshot, score, config);
  if (quoteReadiness) return quoteReadiness;
  if ((snapshot.priceUsd ?? 0) <= 0) return 'latest price missing';
  if ((snapshot.liquidityUsd ?? 0) <= 0) return 'latest liquidity missing';
  const age = tokenAgeMinutes(snapshot);
  if (age < config.minTokenAgeMin || age > config.maxTokenAgeHours * 60) return 'token age outside configured range';
  if (score.totalScore < config.paperMinTotalScore) return 'total score below paper minimum';
  if (score.safetyScore < config.paperMinSafetyScore) return 'safety score below paper minimum';
  if (score.momentumScore < config.paperMinMomentumScore) return 'momentum score below paper minimum';
  if (config.paperRequireHighWatchPriority) {
    const profile = classifyWatchRunnerProfile({
      momentumScore: score.momentumScore,
      safetyScore: score.safetyScore,
      volume1hUsd: snapshot.volume1hUsd,
      liquidityUsd: snapshot.liquidityUsd,
      priceChange5mPct: snapshot.priceChange5mPct,
      priceChange1hPct: snapshot.priceChange1hPct,
      holderConcentration: snapshot.holderConcentration,
      priceUsd: snapshot.priceUsd
    });
    const priority = classifyWatchPriority({
      profile,
      liquidityUsd: snapshot.liquidityUsd,
      volume1hUsd: snapshot.volume1hUsd,
      momentumScore: score.momentumScore,
      worstDrawdownPct: null,
      priceChange5mPct: snapshot.priceChange5mPct,
      priceChange1hPct: snapshot.priceChange1hPct
    });
    if (profile !== 'RUNNER_PROFILE' || priority !== 'HIGH_WATCH_PRIORITY') return 'watch priority below paper requirement';
  }
  return null;
}

function getSkipReason(db: AppDb, config: AppConfig, tokenId: number, snapshot: TokenCandidate | null, score: TokenScoreResult | null): string | null {
  const paperBlocker = isPaperResearchBlocked(snapshot, score, config);
  if (paperBlocker) return paperBlocker;
  if (db.getLatestOpenPositionByToken(tokenId, 'PAPER')) return 'duplicate open paper position exists';
  if (db.getOpenPositionCount('PAPER') >= config.maxOpenPositions) return 'max open paper positions reached';
  if (db.getDailyPaperBuyCount() >= config.maxDailyPaperBuys) return 'daily paper buy cap reached';
  return null;
}

export function buildPaperEligibilityDiagnostics(db: AppDb, config: AppConfig): Record<string, unknown> {
  const rows: Array<PaperEligibilityDiagnosticRow & { warnings: string[] }> = db.listLatestTokenStates(50).map((state) => {
    const latestQuote = db.getLatestQuoteSellabilityCheck(state.tokenId);
    const preparedSnapshot = applyLatestQuoteResultToSnapshot(state.snapshot, latestQuote, config);
    const preparedScore = preparedSnapshot ? scoreToken(state.tokenId, preparedSnapshot, config) : state.score;
    const blockers = [
      isPaperResearchBlocked(preparedSnapshot, preparedScore, config),
      db.getLatestOpenPositionByToken(state.tokenId, 'PAPER') ? 'duplicate open paper position exists' : null,
      db.getOpenPositionCount('PAPER') >= config.maxOpenPositions ? 'max open paper positions reached' : null,
      db.getDailyPaperBuyCount() >= config.maxDailyPaperBuys ? 'daily paper buy cap reached' : null
    ].filter((value): value is string => Boolean(value));
    const warnings = [...new Set(preparedScore?.redFlags ?? [])];

    return {
      tokenId: state.tokenId,
      symbol: state.symbol,
      mint: state.mint,
      totalScore: preparedScore?.totalScore ?? null,
      safetyScore: preparedScore?.safetyScore ?? null,
      momentumScore: preparedScore?.momentumScore ?? null,
      liquidityUsd: preparedSnapshot?.liquidityUsd ?? null,
      sellQuoteAvailable: preparedSnapshot?.sellQuoteAvailable ?? null,
      estimatedSlippageBps: preparedSnapshot?.estimatedSlippageBps ?? null,
      mintAuthority: preparedSnapshot?.mintAuthority ?? null,
      freezeAuthority: preparedSnapshot?.freezeAuthority ?? null,
      holderConcentration: preparedSnapshot?.holderConcentration ?? null,
      verdict: preparedScore?.verdict ?? null,
      blockers,
      warnings,
      distanceToPaperScore: preparedScore ? Number(Math.max(0, config.paperMinTotalScore - preparedScore.totalScore).toFixed(2)) : null
    };
  });

  const topItems = (items: string[], limit = 10) => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
  };

  const eligibleForPaper = rows.filter((row) => row.blockers.length === 0);
  const closest = [...rows]
    .sort((a, b) => {
      const blockerDelta = a.blockers.length - b.blockers.length;
      if (blockerDelta !== 0) return blockerDelta;
      return (a.distanceToPaperScore ?? Number.POSITIVE_INFINITY) - (b.distanceToPaperScore ?? Number.POSITIVE_INFINITY);
    })
    .slice(0, 10);

  return {
    totalCandidatesEvaluated: rows.length,
    quoteReadyCount: rows.filter((row) => row.sellQuoteAvailable === 'YES').length,
    quoteUnknownCount: rows.filter((row) => row.sellQuoteAvailable === 'UNKNOWN' || row.sellQuoteAvailable === null).length,
    quoteNoRouteCount: rows.filter((row) => row.sellQuoteAvailable === 'NO').length,
    slippageMissingCount: rows.filter((row) => row.estimatedSlippageBps === null).length,
    highSlippageCount: rows.filter((row) => (row.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) > config.maxSlippageBps).length,
    mintUnsafeCount: rows.filter((row) => row.mintAuthority === 'UNSAFE').length,
    freezeUnsafeCount: rows.filter((row) => row.freezeAuthority === 'UNSAFE').length,
    holderRiskyCount: rows.filter((row) => row.holderConcentration === 'RISKY').length,
    holderUnknownCount: rows.filter((row) => row.holderConcentration === 'UNKNOWN' || row.holderConcentration === null).length,
    failedTotalScoreCount: rows.filter((row) => row.blockers.includes('total score below paper minimum')).length,
    failedSafetyScoreCount: rows.filter((row) => row.blockers.includes('safety score below paper minimum')).length,
    failedMomentumScoreCount: rows.filter((row) => row.blockers.includes('momentum score below paper minimum')).length,
    failedLiquidityCount: rows.filter((row) => row.blockers.includes('latest liquidity missing')).length,
    failedAgeWindowCount: rows.filter((row) => row.blockers.includes('token age outside configured range')).length,
    verdictAvoidCount: rows.filter((row) => row.verdict === 'AVOID').length,
    verdictWatchCount: rows.filter((row) => row.verdict === 'WATCH').length,
    verdictPaperBuyCount: rows.filter((row) => row.verdict === 'PAPER_BUY').length,
    eligibleForPaperCount: eligibleForPaper.length,
    paperBuysWouldOpenCount: Math.max(0, Math.min(eligibleForPaper.length, config.maxDailyPaperBuys - db.getDailyPaperBuyCount(), config.maxOpenPositions - db.getOpenPositionCount('PAPER'))),
    topSkipReasons: topItems(rows.flatMap((row) => row.blockers)),
    topWarnings: topItems(rows.flatMap((row) => row.warnings)),
    topClosestCandidates: closest,
    finalSafetyStatus: 'Real trading remains locked.'
  };
}

export async function runAutoPaper(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<{ decisions: AutoPaperDecision[]; scanned: number; scored: number }> {
  const runLogId = db.createRunLog('token:auto-paper');
  try {
    const scan = await runScan(db, config, logger);
    const decisions: AutoPaperDecision[] = [];
    let scored = 0;

    for (const state of db.listLatestTokenStates(50)) {
      const latestQuote = db.getLatestQuoteSellabilityCheck(state.tokenId);
      const preparedSnapshot = applyLatestQuoteResultToSnapshot(state.snapshot, latestQuote, config);
      const preparedScore = preparedSnapshot ? scoreToken(state.tokenId, preparedSnapshot, config) : state.score;
      if (preparedScore && preparedSnapshot) {
        db.saveScore(preparedScore);
        scored += 1;
      }

      const skipReason = getSkipReason(db, config, state.tokenId, preparedSnapshot, preparedScore);
      if (skipReason) {
        decisions.push({ tokenId: state.tokenId, symbol: state.symbol, mint: state.mint, action: 'SKIPPED', reason: skipReason });
        db.logSafetyEvent(state.tokenId, 'INFO', 'auto_paper_skipped', skipReason, { tokenId: state.tokenId, symbol: state.symbol, mint: state.mint });
        continue;
      }

      const proposalId = db.createProposal(
        state.tokenId,
        'BUY',
        Math.min(config.maxAutoPaperBuyUsd, config.maxBankrollUsd - db.getOpenExposureUsd('PAPER')),
        preparedScore!.verdict,
        `auto paper buy for ${state.symbol}; reasons=${preparedScore!.reasons.slice(0, 3).join(' | ')}`,
        'PENDING',
        {
          totalScore: preparedScore!.totalScore,
          safetyScore: preparedScore!.safetyScore,
          momentumScore: preparedScore!.momentumScore,
          redFlags: preparedScore!.redFlags,
          reasons: preparedScore!.reasons,
          sellQuoteAvailable: preparedSnapshot?.sellQuoteAvailable,
          estimatedSlippageBps: preparedSnapshot?.estimatedSlippageBps
        }
      );

      const result = paperBuy(db, config, { proposalId, paperApproved: true });
      db.logSafetyEvent(state.tokenId, 'INFO', 'auto_paper_bought', 'Auto paper buy executed', { proposalId, positionId: result.positionId, tokenId: state.tokenId });
      decisions.push({ tokenId: state.tokenId, symbol: state.symbol, mint: state.mint, action: 'BOUGHT', reason: 'eligible for auto paper buy', proposalId, positionId: result.positionId });
    }

    db.finishRunLog(runLogId, 'SUCCESS', { scanned: scan.scanned, scored, decisions });
    return { decisions, scanned: scan.scanned, scored };
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'unknown auto-paper error' });
    throw error;
  }
}
