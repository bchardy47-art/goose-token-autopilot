import { runScan } from './scanner';
import { scoreAllTokens } from './scoring/scoreToken';
import type { AppDb } from './db';
import type { AppConfig, TokenCandidate, WatchOnlyCandidate, WatchOnlySignalAnalysis, WatchOnlySignalClass } from './types';
import { AppLogger } from './logger';

interface SignalClassification {
  signalClass: WatchOnlySignalClass;
  reason: string;
}

function parseCandidateSnapshot(candidate: WatchOnlyCandidate): TokenCandidate | null {
  try {
    const parsed = JSON.parse(candidate.rawJson) as { snapshot?: TokenCandidate };
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

export function classifyWatchOnlyCandidate(candidate: WatchOnlyCandidate, snapshot: TokenCandidate | null, config: AppConfig): SignalClassification {
  const bestGainPct = candidate.bestGainPct;
  const worstDrawdownPct = candidate.worstDrawdownPct;
  const movedBeforeDiscoveryPct = snapshot?.movedBeforeDiscoveryPct ?? null;
  const liquidityUsd = candidate.liquidityUsd ?? snapshot?.liquidityUsd ?? null;
  const sellQuoteAvailable = snapshot?.sellQuoteAvailable ?? null;
  const mintAuthority = snapshot?.mintAuthority ?? null;
  const freezeAuthority = snapshot?.freezeAuthority ?? null;

  if (
    liquidityUsd === null || liquidityUsd < 5000 ||
    sellQuoteAvailable === 'NO' ||
    mintAuthority === 'UNSAFE' ||
    freezeAuthority === 'UNSAFE'
  ) {
    return { signalClass: 'TOO_DANGEROUS', reason: 'liquidity or sellability/authority risk makes this too dangerous to learn from as an entry' };
  }

  if (bestGainPct !== null && bestGainPct >= 30) {
    if (movedBeforeDiscoveryPct !== null && movedBeforeDiscoveryPct <= config.maxChasePct) {
      return { signalClass: 'EARLY_RUNNER', reason: 'candidate gained >= 30% after discovery without being overextended at entry' };
    }
    if (movedBeforeDiscoveryPct === null || movedBeforeDiscoveryPct > config.maxChasePct) {
      return { signalClass: 'LATE_RUNNER', reason: 'candidate gained >= 30% after discovery but was already extended before discovery' };
    }
  }

  if (worstDrawdownPct !== null && worstDrawdownPct <= config.paperStopLossPct) {
    return { signalClass: 'INSTANT_DUMP', reason: 'candidate hit stop-loss style drawdown shortly after discovery' };
  }

  return { signalClass: 'DEAD_NOISE', reason: 'candidate did not produce enough safe, useful post-discovery movement' };
}

export async function runWatchAnalysis(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<{ analyzed: number; classCounts: Record<WatchOnlySignalClass, number> }> {
  const runLogId = db.createRunLog('token:watch-analysis');
  try {
    await runScan(db, config, logger);
    scoreAllTokens(db, config);

    const classCounts: Record<WatchOnlySignalClass, number> = {
      EARLY_RUNNER: 0,
      LATE_RUNNER: 0,
      INSTANT_DUMP: 0,
      DEAD_NOISE: 0,
      TOO_DANGEROUS: 0
    };

    let analyzed = 0;
    for (const candidate of db.listWatchOnlyCandidates()) {
      const liveSnapshot = db.getLatestSnapshot(candidate.tokenId);
      const savedSnapshot = parseCandidateSnapshot(candidate);
      const snapshot = liveSnapshot ?? savedSnapshot;
      const classification = classifyWatchOnlyCandidate(candidate, snapshot, config);
      const analyzedAt = new Date().toISOString();

      db.upsertWatchOnlySignalAnalysis(
        candidate.id,
        candidate.tokenId,
        classification.signalClass,
        analyzedAt,
        candidate.bestGainPct,
        candidate.worstDrawdownPct,
        snapshot?.movedBeforeDiscoveryPct ?? null,
        candidate.liquidityUsd ?? snapshot?.liquidityUsd ?? null,
        snapshot?.sellQuoteAvailable ?? null,
        snapshot?.mintAuthority ?? null,
        snapshot?.freezeAuthority ?? null,
        classification.reason,
        'Watch-only analysis is research only.',
        {
          candidateId: candidate.id,
          tokenId: candidate.tokenId,
          signalClass: classification.signalClass,
          movedBeforeDiscoveryPct: snapshot?.movedBeforeDiscoveryPct ?? null,
          watchOnlyResearchOnly: true
        }
      );

      classCounts[classification.signalClass] += 1;
      analyzed += 1;
    }

    const summary = { analyzed, classCounts, analysisSummary: 'Watch-only analysis is research only.' };
    db.finishRunLog(runLogId, 'SUCCESS', summary);
    return summary;
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'unknown watch analysis error' });
    throw error;
  }
}

export function summarizeWatchOnlySignalAnalysis(db: AppDb): Record<string, unknown> {
  const analyses = db.listWatchOnlySignalAnalyses();
  const classCounts: Record<WatchOnlySignalClass, number> = {
    EARLY_RUNNER: 0,
    LATE_RUNNER: 0,
    INSTANT_DUMP: 0,
    DEAD_NOISE: 0,
    TOO_DANGEROUS: 0
  };

  for (const analysis of analyses) {
    classCounts[analysis.signalClass] += 1;
  }

  return {
    watchOnlySignalClassCounts: classCounts,
    earlyRunnerCount: classCounts.EARLY_RUNNER,
    lateRunnerCount: classCounts.LATE_RUNNER,
    instantDumpCount: classCounts.INSTANT_DUMP,
    deadNoiseCount: classCounts.DEAD_NOISE,
    tooDangerousCount: classCounts.TOO_DANGEROUS,
    analysisSummaryLine: 'Watch-only analysis is research only.'
  };
}
