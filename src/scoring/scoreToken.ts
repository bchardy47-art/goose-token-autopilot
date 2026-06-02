import type { AppConfig, TokenCandidate, TokenScoreResult, Verdict } from '../types';
import { evaluateSafety } from '../safety/checks';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function tokenAgeMinutes(candidate: TokenCandidate): number {
  return (Date.now() - new Date(candidate.tokenCreatedAt).getTime()) / 60_000;
}

export function scoreToken(tokenId: number, candidate: TokenCandidate, config: AppConfig): TokenScoreResult {
  const safety = evaluateSafety(candidate, config);
  const reasons = [...safety.reasons];
  const pushUnique = (list: string[], value: string): void => {
    if (!list.includes(value)) list.push(value);
  };

  const buySellRatio = (candidate.buys5m ?? 0) / Math.max(1, candidate.sells5m ?? 0);
  const volumeAcceleration = (candidate.volume5mUsd ?? 0) > 0 && (candidate.volume1hUsd ?? 0) > 0
    ? ((candidate.volume5mUsd ?? 0) * 12) / Math.max(1, candidate.volume1hUsd ?? 0)
    : 0;
  const age = tokenAgeMinutes(candidate);

  let momentum = 0;
  momentum += clamp((candidate.priceChange5mPct ?? 0) / 2, 0, 10);
  momentum += clamp((candidate.priceChange1hPct ?? 0) / 4, 0, 12);
  momentum += clamp(volumeAcceleration * 8, 0, 8);
  momentum += clamp((buySellRatio - 1) * 4, 0, 6);
  momentum += clamp((candidate.liquidityGrowthPct ?? 0) / 5, 0, 4);

  if (age >= config.minTokenAgeMin && age <= config.maxTokenAgeHours * 60) {
    momentum += 4;
    pushUnique(reasons, 'token age is inside preferred momentum window');
  } else {
    pushUnique(reasons, 'token age is outside preferred momentum window');
  }

  let safetyScore = 0;
  if ((candidate.liquidityUsd ?? 0) >= config.minLiquidityUsd) safetyScore += 12;
  if (candidate.freezeAuthority === 'SAFE') {
    safetyScore += 8;
    pushUnique(reasons, 'freeze authority renounced');
  }
  if (candidate.mintAuthority === 'SAFE') {
    safetyScore += 8;
    pushUnique(reasons, 'mint authority renounced');
  }
  if (candidate.sellQuoteAvailable === 'YES') safetyScore += 5;
  if ((candidate.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) <= config.maxSlippageBps) safetyScore += 3;
  if (candidate.holderConcentration === 'SAFE') {
    safetyScore += 2;
    pushUnique(reasons, 'holder concentration safe');
  }
  if (candidate.holderConcentration === 'RISKY') {
    safetyScore -= 6;
    pushUnique(reasons, 'holder concentration risky');
  }
  if (candidate.holderConcentration === 'UNKNOWN') {
    safetyScore -= 8;
    pushUnique(reasons, 'holder concentration unknown');
  }
  if (candidate.sellQuoteAvailable === 'NO') {
    safetyScore -= 8;
    pushUnique(reasons, 'sell quote unavailable');
  }
  if (candidate.sellQuoteAvailable === 'UNKNOWN') {
    safetyScore -= 10;
    pushUnique(reasons, 'sell quote unknown');
  }
  if (candidate.freezeAuthority === 'UNSAFE') safetyScore -= 15;
  if (candidate.mintAuthority === 'UNSAFE') safetyScore -= 15;
  if (candidate.freezeAuthority === 'UNKNOWN' || candidate.mintAuthority === 'UNKNOWN') {
    safetyScore -= 6;
    pushUnique(reasons, 'safety enrichment missing');
  }
  if (candidate.creatorStatus === 'SAFE') safetyScore += 1;
  if (candidate.metadataPresent && candidate.priceUsd !== null && candidate.liquidityUsd !== null) safetyScore += 1;

  let socialScore = 0;
  if (candidate.websitePresent) socialScore += 6;
  if (candidate.metadataPresent) socialScore += 8;
  if (candidate.socialsPresent) socialScore += 6;

  momentum = clamp(momentum, 0, 40);
  safetyScore = clamp(safetyScore, 0, 40);
  socialScore = clamp(socialScore, 0, 20);

  const total = clamp(momentum + safetyScore + socialScore, 0, 100);
  let verdict: Verdict;

  if (safety.hardRedFlags.length > 0) {
    verdict = 'AVOID';
    pushUnique(reasons, 'hard red flags force AVOID');
  } else if (
    total >= config.minTotalScoreForAutopilot &&
    safetyScore >= config.minSafetyScoreForAutopilot &&
    momentum >= config.minMomentumScoreForAutopilot &&
    safety.autopilotBlockers.length === 0
  ) {
    verdict = 'AUTOPILOT_ELIGIBLE';
    pushUnique(reasons, 'passes total, safety, momentum, and blocker thresholds');
  } else if (total >= 60) {
    verdict = 'PAPER_BUY';
    pushUnique(reasons, 'strong enough for paper buy but not safe enough for real autopilot');
  } else if (total >= 40) {
    verdict = 'WATCH';
    pushUnique(reasons, 'worth watching but not ready to buy');
  } else {
    verdict = 'AVOID';
    pushUnique(reasons, 'score too low');
  }

  if (buySellRatio > 1) pushUnique(reasons, `buy/sell ratio supportive at ${buySellRatio.toFixed(2)}`);
  if ((candidate.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) <= config.maxSlippageBps) pushUnique(reasons, 'slippage is within configured limit');
  if ((candidate.liquidityUsd ?? 0) >= config.minLiquidityUsd) pushUnique(reasons, 'liquidity is above configured minimum');

  return {
    tokenId,
    scoredAt: new Date().toISOString(),
    momentumScore: Number(momentum.toFixed(2)),
    safetyScore: Number(safetyScore.toFixed(2)),
    socialScore: Number(socialScore.toFixed(2)),
    totalScore: Number(total.toFixed(2)),
    verdict,
    reasons,
    redFlags: safety.hardRedFlags,
    autopilotBlocked: safety.autopilotBlockers.length > 0 || verdict !== 'AUTOPILOT_ELIGIBLE',
    autopilotBlockers: safety.autopilotBlockers
  };
}

export function scoreAllTokens(db: { getAllTokenIds(): number[]; getLatestSnapshot(tokenId: number): TokenCandidate | null; saveScore(score: TokenScoreResult): number; createRunLog(runType: string): number; finishRunLog(id: number, status: string, summary: Record<string, unknown>): void; }, config: AppConfig): TokenScoreResult[] {
  const runLogId = db.createRunLog('token:score');
  try {
    const results: TokenScoreResult[] = [];
    for (const tokenId of db.getAllTokenIds()) {
      const candidate = db.getLatestSnapshot(tokenId);
      if (!candidate) continue;
      const score = scoreToken(tokenId, candidate, config);
      db.saveScore(score);
      results.push(score);
    }
    db.finishRunLog(runLogId, 'SUCCESS', { scored: results.length });
    return results;
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'Unknown scoring error' });
    throw error;
  }
}
