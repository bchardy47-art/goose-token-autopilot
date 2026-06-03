import type { AppConfig, PaperEntryContext, QuoteSellabilityCheckRow, TokenCandidate, TokenScoreResult } from '../types';
import { classifyWatchPriority, classifyWatchRunnerProfile } from '../watchOnly';

export const PAPER_ENTRY_MAX_DATA_AGE_MINUTES = 15;

export function tokenAgeMinutes(candidate: TokenCandidate): number {
  return (Date.now() - new Date(candidate.tokenCreatedAt).getTime()) / 60_000;
}

export function minutesSince(timestamp: string): number {
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

export function derivePaperEntryWatchSignals(snapshot: TokenCandidate | null, score: TokenScoreResult | null): { profile: string | null; priority: string | null } {
  if (!snapshot || !score) return { profile: null, priority: null };

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

  return { profile, priority };
}

export function getPaperEntryIntegrityBlockers(snapshot: TokenCandidate | null, config: AppConfig): string[] {
  if (!snapshot) return ['missing score or snapshot'];

  const blockers: string[] = [];
  const dataAgeMinutes = minutesSince(snapshot.dataUpdatedAt);
  if (!Number.isFinite(dataAgeMinutes)) {
    blockers.push('entry data timestamp invalid blocks paper eligibility');
  } else if (dataAgeMinutes > PAPER_ENTRY_MAX_DATA_AGE_MINUTES) {
    blockers.push('entry data stale blocks paper eligibility');
  }

  if ((snapshot.movedBeforeDiscoveryPct ?? Number.NEGATIVE_INFINITY) > config.maxChasePct) {
    blockers.push('moved before discovery blocks paper eligibility');
  }

  return blockers;
}

export function getPaperEntryIntegrityBlocker(snapshot: TokenCandidate | null, config: AppConfig): string | null {
  if (!snapshot) return 'missing score or snapshot';

  const dataAgeMinutes = minutesSince(snapshot.dataUpdatedAt);
  if (!Number.isFinite(dataAgeMinutes)) return 'entry snapshot timestamp invalid';
  if (dataAgeMinutes > PAPER_ENTRY_MAX_DATA_AGE_MINUTES) return 'entry snapshot stale';
  if ((snapshot.movedBeforeDiscoveryPct ?? Number.NEGATIVE_INFINITY) > config.maxChasePct) {
    return 'token already moved above MAX_CHASE_PCT before discovery';
  }

  return null;
}

export function getPaperEntryBlockers(snapshot: TokenCandidate | null, score: TokenScoreResult | null, config: AppConfig): string[] {
  if (!snapshot || !score) return ['missing score or snapshot'];

  const blockers: string[] = [];
  const quoteReadiness = isPaperQuoteReady(snapshot, score, config);
  if (quoteReadiness) blockers.push(quoteReadiness);
  if ((snapshot.priceUsd ?? 0) <= 0) blockers.push('latest price missing');
  if ((snapshot.liquidityUsd ?? 0) <= 0) blockers.push('latest liquidity missing');
  blockers.push(...getPaperEntryIntegrityBlockers(snapshot, config));

  const age = tokenAgeMinutes(snapshot);
  if (age < config.minTokenAgeMin || age > config.maxTokenAgeHours * 60) blockers.push('token age outside configured range');
  if (score.totalScore < config.paperMinTotalScore) blockers.push('total score below paper minimum');
  if (score.safetyScore < config.paperMinSafetyScore) blockers.push('safety score below paper minimum');
  if (score.momentumScore < config.paperMinMomentumScore) blockers.push('momentum score below paper minimum');

  if (config.paperRequireHighWatchPriority) {
    const watchSignals = derivePaperEntryWatchSignals(snapshot, score);
    if (watchSignals.profile !== 'RUNNER_PROFILE' || watchSignals.priority !== 'HIGH_WATCH_PRIORITY') {
      blockers.push('watch priority below paper requirement');
    }
  }

  return [...new Set(blockers)];
}

export function getPaperEntryBlocker(snapshot: TokenCandidate | null, score: TokenScoreResult | null, config: AppConfig): string | null {
  if (!snapshot || !score) return 'missing score or snapshot';

  const quoteReadiness = isPaperQuoteReady(snapshot, score, config);
  if (quoteReadiness) return quoteReadiness;
  if ((snapshot.priceUsd ?? 0) <= 0) return 'latest price missing';
  if ((snapshot.liquidityUsd ?? 0) <= 0) return 'latest liquidity missing';

  const integrityBlocker = getPaperEntryIntegrityBlocker(snapshot, config);
  if (integrityBlocker) return integrityBlocker;

  const age = tokenAgeMinutes(snapshot);
  if (age < config.minTokenAgeMin || age > config.maxTokenAgeHours * 60) return 'token age outside configured range';
  if (score.totalScore < config.paperMinTotalScore) return 'total score below paper minimum';
  if (score.safetyScore < config.paperMinSafetyScore) return 'safety score below paper minimum';
  if (score.momentumScore < config.paperMinMomentumScore) return 'momentum score below paper minimum';

  if (config.paperRequireHighWatchPriority) {
    const watchSignals = derivePaperEntryWatchSignals(snapshot, score);
    if (watchSignals.profile !== 'RUNNER_PROFILE' || watchSignals.priority !== 'HIGH_WATCH_PRIORITY') {
      return 'watch priority below paper requirement';
    }
  }

  return null;
}

export function isAutoPaperResearchBlocked(snapshot: TokenCandidate | null, score: TokenScoreResult | null, config: AppConfig): string | null {
  if (!config.enableAutoPaperTrading) return 'auto paper trading disabled';
  return getPaperEntryBlocker(snapshot, score, config);
}

export function buildPaperEntryContext(
  snapshot: TokenCandidate,
  score: TokenScoreResult,
  proposalId: number | null = null,
  proposalSafetySnapshot: Record<string, unknown> | null = null
): PaperEntryContext {
  const watchSignals = derivePaperEntryWatchSignals(snapshot, score);
  return {
    capturedAt: new Date().toISOString(),
    proposalId,
    profile: watchSignals.profile,
    priority: watchSignals.priority,
    snapshot,
    score,
    proposalSafetySnapshot,
    tokenAgeMinutes: Number(tokenAgeMinutes(snapshot).toFixed(4)),
    dataAgeMinutes: Number(minutesSince(snapshot.dataUpdatedAt).toFixed(4)),
    movedBeforeDiscoveryPct: snapshot.movedBeforeDiscoveryPct ?? null
  };
}
