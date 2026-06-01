import { runScan } from '../scanner';
import { scoreAllTokens } from '../scoring/scoreToken';
import type { AppDb } from '../db';
import type { AppConfig, AutoPaperDecision, TokenCandidate, TokenScoreResult } from '../types';
import { paperBuy } from '../trading/paper';
import { AppLogger } from '../logger';

function tokenAgeMinutes(candidate: TokenCandidate): number {
  return (Date.now() - new Date(candidate.tokenCreatedAt).getTime()) / 60_000;
}

function getSkipReason(db: AppDb, config: AppConfig, tokenId: number, snapshot: TokenCandidate | null, score: TokenScoreResult | null): string | null {
  if (!config.enableAutoPaperTrading) return 'auto paper trading disabled';
  if (!snapshot || !score) return 'missing score or snapshot';
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
    const scores = scoreAllTokens(db, config);
    const decisions: AutoPaperDecision[] = [];

    for (const state of db.listLatestTokenStates(50)) {
      const skipReason = getSkipReason(db, config, state.tokenId, state.snapshot, state.score);
      if (skipReason) {
        decisions.push({ tokenId: state.tokenId, symbol: state.symbol, mint: state.mint, action: 'SKIPPED', reason: skipReason });
        db.logSafetyEvent(state.tokenId, 'INFO', 'auto_paper_skipped', skipReason, { tokenId: state.tokenId, symbol: state.symbol, mint: state.mint });
        continue;
      }

      const proposalId = db.createProposal(
        state.tokenId,
        'BUY',
        Math.min(config.maxAutoPaperBuyUsd, config.maxBankrollUsd - db.getOpenExposureUsd('PAPER')),
        state.score!.verdict,
        `auto paper buy for ${state.symbol}; reasons=${state.score!.reasons.slice(0, 3).join(' | ')}`,
        'PENDING',
        {
          totalScore: state.score!.totalScore,
          safetyScore: state.score!.safetyScore,
          momentumScore: state.score!.momentumScore,
          redFlags: state.score!.redFlags,
          reasons: state.score!.reasons
        }
      );

      const result = paperBuy(db, config, { proposalId });
      db.logSafetyEvent(state.tokenId, 'INFO', 'auto_paper_bought', 'Auto paper buy executed', { proposalId, positionId: result.positionId, tokenId: state.tokenId });
      decisions.push({ tokenId: state.tokenId, symbol: state.symbol, mint: state.mint, action: 'BOUGHT', reason: 'eligible for auto paper buy', proposalId, positionId: result.positionId });
    }

    db.finishRunLog(runLogId, 'SUCCESS', { scanned: scan.scanned, scored: scores.length, decisions });
    return { decisions, scanned: scan.scanned, scored: scores.length };
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'unknown auto-paper error' });
    throw error;
  }
}
