import type { AppConfig, ProposalResult, TokenCandidate, TokenScoreResult, Verdict } from '../types';
import type { AppDb } from '../db';

function canPropose(verdict: Verdict): boolean {
  return verdict === 'AUTOPILOT_ELIGIBLE' || verdict === 'PAPER_BUY';
}

export function chooseProposalAmount(config: AppConfig, currentExposureUsd: number): number {
  const remainingBankroll = Math.max(0, config.maxBankrollUsd - currentExposureUsd);
  return Number(Math.min(config.maxBuyUsd, remainingBankroll).toFixed(2));
}

export function createTopProposal(db: AppDb, config: AppConfig): ProposalResult | null {
  const ranked = db.getRankedTokens(25);
  const exposure = db.getOpenExposureUsd('PAPER');

  for (const row of ranked) {
    if (!canPropose(row.verdict)) continue;
    const tokenId = Number(row.id);
    const snapshot = db.getLatestSnapshot(tokenId) as TokenCandidate | null;
    const score = db.getLatestScore(tokenId) as TokenScoreResult | null;
    if (!snapshot || !score) continue;

    const amountUsd = chooseProposalAmount(config, exposure);
    if (amountUsd <= 0) continue;

    const reasonParts = [
      `Selected ${row.symbol} from top-ranked tokens`,
      `verdict=${score.verdict}`,
      `total=${score.totalScore}`,
      `safety=${score.safetyScore}`,
      `momentum=${score.momentumScore}`
    ];

    const safetySnapshot = {
      verdict: score.verdict,
      totalScore: score.totalScore,
      safetyScore: score.safetyScore,
      momentumScore: score.momentumScore,
      socialScore: score.socialScore,
      redFlags: score.redFlags,
      autopilotBlocked: score.autopilotBlocked,
      autopilotBlockers: score.autopilotBlockers,
      liquidityUsd: snapshot.liquidityUsd,
      estimatedSlippageBps: snapshot.estimatedSlippageBps,
      sellQuoteAvailable: snapshot.sellQuoteAvailable,
      freezeAuthority: snapshot.freezeAuthority,
      mintAuthority: snapshot.mintAuthority
    };

    const id = db.createProposal(tokenId, 'BUY', amountUsd, score.verdict, reasonParts.join('; '), 'PENDING', safetySnapshot);
    return {
      id,
      tokenId,
      side: 'BUY',
      amountUsd,
      verdict: score.verdict,
      reason: reasonParts.join('; '),
      status: 'PENDING',
      safetySnapshot
    };
  }

  return null;
}
