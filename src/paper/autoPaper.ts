import { runScan } from '../scanner';
import { scoreToken } from '../scoring/scoreToken';
import type { AppDb } from '../db';
import type { AppConfig, AutoPaperDecision, QuoteSellabilityCheckRow, TokenCandidate, TokenScoreResult } from '../types';
import { paperBuy } from '../trading/paper';
import { AppLogger } from '../logger';

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

function getSkipReason(db: AppDb, config: AppConfig, tokenId: number, snapshot: TokenCandidate | null, score: TokenScoreResult | null): string | null {
  if (!config.enableAutoPaperTrading) return 'auto paper trading disabled';
  if (!snapshot || !score) return 'missing score or snapshot';
  const quoteReadiness = isPaperQuoteReady(snapshot, score, config);
  if (quoteReadiness) return quoteReadiness;
  if (!['PAPER_BUY', 'AUTOPILOT_ELIGIBLE'].includes(score.verdict)) return `verdict ${score.verdict} not eligible`;
  if (score.redFlags.length > 0) return `hard red flags: ${score.redFlags.join(', ')}`;
  if ((snapshot.priceUsd ?? 0) <= 0) return 'latest price missing';
  if ((snapshot.liquidityUsd ?? 0) <= 0) return 'latest liquidity missing';
  const age = tokenAgeMinutes(snapshot);
  if (age < config.minTokenAgeMin || age > config.maxTokenAgeHours * 60) return 'token age outside configured range';
  if (db.getLatestOpenPositionByToken(tokenId, 'PAPER')) return 'duplicate open paper position exists';
  if (db.getOpenPositionCount('PAPER') >= config.maxOpenPositions) return 'max open paper positions reached';
  if (db.getDailyPaperBuyCount() >= config.maxDailyPaperBuys) return 'daily paper buy cap reached';
  if (score.totalScore < config.paperMinTotalScore) return 'total score below paper minimum';
  if (score.safetyScore < config.paperMinSafetyScore) return 'safety score below paper minimum';
  if (score.momentumScore < config.paperMinMomentumScore) return 'momentum score below paper minimum';
  return null;
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

      const result = paperBuy(db, config, { proposalId });
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
