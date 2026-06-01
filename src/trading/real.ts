import type { AppConfig, BuildSwapResult, ExecutionResult, QuoteResult, TradeSide } from '../types';
import type { AppDb } from '../db';
import { AppLogger } from '../logger';
import { getGuardFailures } from './guards';

export function quoteSwap(db: AppDb, tokenId: number, side: TradeSide, amountUsd: number): QuoteResult {
  const snapshot = db.getLatestSnapshot(tokenId);
  if (!snapshot || !snapshot.priceUsd) {
    return { ok: false, side, mint: 'unknown', amountUsd, estimatedSlippageBps: Number.POSITIVE_INFINITY, reason: 'missing latest price snapshot' };
  }
  if (snapshot.sellQuoteAvailable !== 'YES') {
    return { ok: false, side, mint: snapshot.mint, amountUsd, estimatedSlippageBps: snapshot.estimatedSlippageBps ?? Number.POSITIVE_INFINITY, reason: 'sell quote unavailable' };
  }
  return {
    ok: true,
    side,
    mint: snapshot.mint,
    amountUsd,
    estimatedSlippageBps: snapshot.estimatedSlippageBps ?? 0,
    quoteId: `quote-${tokenId}-${side.toLowerCase()}-${Date.now()}`
  };
}

export function buildSwap(_quote: QuoteResult): BuildSwapResult {
  return {
    ok: false,
    reason: 'buildSwap is a guarded V1 stub until wallet integration and transaction signing are independently safety-audited'
  };
}

function guardedExecute(params: {
  db: AppDb;
  config: AppConfig;
  logger?: AppLogger;
  tokenId: number;
  proposalId: number | null;
  side: TradeSide;
  amountUsd: number;
}): ExecutionResult {
  const { db, config, tokenId, proposalId, side, amountUsd } = params;
  const logger = params.logger ?? new AppLogger();
  const snapshot = db.getLatestSnapshot(tokenId);
  const score = db.getLatestScore(tokenId);
  const quote = quoteSwap(db, tokenId, side, amountUsd);
  const failures = getGuardFailures({ db, config, side, amountUsd, tokenId, score, snapshot, quote });

  if (failures.length > 0) {
    const reason = failures.join('; ');
    const attemptId = db.recordRealTradeAttempt(tokenId, proposalId, side, amountUsd, true, reason, { quote, score, snapshot });
    db.logSafetyEvent(tokenId, 'ERROR', 'real_trade_blocked', reason, { side, amountUsd, proposalId, attemptId });
    logger.warn(`Real ${side.toLowerCase()} blocked`, { tokenId, proposalId, reason });
    return { ok: false, blocked: true, reason, attemptId };
  }

  const build = buildSwap(quote);
  const reason = `Real ${side.toLowerCase()} still blocked in V1: ${build.reason}`;
  const attemptId = db.recordRealTradeAttempt(tokenId, proposalId, side, amountUsd, true, reason, { quote, build, score, snapshot });
  db.logSafetyEvent(tokenId, 'ERROR', 'real_trade_blocked', reason, { side, amountUsd, proposalId, attemptId });
  logger.warn(`Real ${side.toLowerCase()} blocked`, { tokenId, proposalId, reason });
  return { ok: false, blocked: true, reason, attemptId };
}

export function executeBuy(db: AppDb, config: AppConfig, tokenId: number, proposalId: number | null, amountUsd: number, logger?: AppLogger): ExecutionResult {
  return guardedExecute({ db, config, logger, tokenId, proposalId, side: 'BUY', amountUsd });
}

export function executeSell(db: AppDb, config: AppConfig, tokenId: number, proposalId: number | null, amountUsd: number, logger?: AppLogger): ExecutionResult {
  return guardedExecute({ db, config, logger, tokenId, proposalId, side: 'SELL', amountUsd });
}
