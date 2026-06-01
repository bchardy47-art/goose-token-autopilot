import { runScan } from './scanner';
import { scoreAllTokens } from './scoring/scoreToken';
import type { AppDb } from './db';
import type { AppConfig, ResearchStatus, TokenCandidate, TokenScoreResult } from './types';
import { AppLogger } from './logger';
import { summarizeWatchOutcomes } from './watchOutcomes';
import { summarizeWatchOnlySignalAnalysis } from './watchAnalysis';

function tokenAgeHours(candidate: TokenCandidate): number | null {
  const created = new Date(candidate.tokenCreatedAt).getTime();
  if (Number.isNaN(created)) return null;
  return (Date.now() - created) / 3_600_000;
}

function buySellRatio(candidate: TokenCandidate): number {
  return (candidate.buys5m ?? 0) / Math.max(1, candidate.sells5m ?? 0);
}

export function qualifiesForWatchOnly(snapshot: TokenCandidate | null, score: TokenScoreResult | null): { ok: boolean; reason: string } {
  if (!snapshot || !score) return { ok: false, reason: 'missing snapshot or score' };
  if (snapshot.source !== 'dexscreener') return { ok: false, reason: 'watch-only lane is for live DexScreener tokens only' };
  if ((snapshot.priceUsd ?? 0) <= 0) return { ok: false, reason: 'missing price' };
  if ((snapshot.liquidityUsd ?? 0) < 5000) return { ok: false, reason: 'liquidity below watch-only threshold' };
  if ((snapshot.marketCapUsd ?? 0) <= 0) return { ok: false, reason: 'missing market cap/fdv' };
  const ageHours = tokenAgeHours(snapshot);
  if (ageHours !== null && ageHours > 24) return { ok: false, reason: 'token older than 24 hours' };
  if (snapshot.mintAuthority === 'UNSAFE' || snapshot.freezeAuthority === 'UNSAFE') return { ok: false, reason: 'explicit unsafe authority' };
  if (snapshot.sellQuoteAvailable === 'NO') return { ok: false, reason: 'explicit sell quote unavailable' };

  const momentumSignals = [
    (snapshot.priceChange5mPct ?? 0) > 20,
    (snapshot.priceChange1hPct ?? 0) > 50,
    (snapshot.volume5mUsd ?? 0) > 5000,
    (snapshot.buys5m ?? 0) >= 20,
    buySellRatio(snapshot) >= 1.5 && (snapshot.buys5m ?? 0) >= 20
  ];

  if (!momentumSignals.some(Boolean)) {
    return { ok: false, reason: 'no watch-only momentum signal' };
  }

  return { ok: true, reason: 'interesting enough to track, unsafe to trade' };
}

export async function runWatchOnly(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<{ createdOrUpdated: number; decisions: Array<Record<string, unknown>> }> {
  const runLogId = db.createRunLog('token:watch-only');
  try {
    await runScan(db, config, logger);
    scoreAllTokens(db, config);
    const decisions: Array<Record<string, unknown>> = [];
    let createdOrUpdated = 0;

    for (const state of db.listLatestTokenStates(100)) {
      const watch = qualifiesForWatchOnly(state.snapshot, state.score);
      if (!watch.ok) {
        decisions.push({ tokenId: state.tokenId, symbol: state.symbol, action: 'IGNORE', reason: watch.reason });
        continue;
      }

      const status: ResearchStatus = db.getLatestOpenPositionByToken(state.tokenId, 'PAPER') ? 'PAPER_TRACKED' : 'WATCH_ONLY';
      db.upsertWatchOnlyCandidate(
        state.tokenId,
        status,
        watch.reason,
        state.snapshot?.priceUsd ?? null,
        state.snapshot?.priceUsd ?? null,
        state.snapshot?.liquidityUsd ?? null,
        state.snapshot?.volume5mUsd ?? null,
        state.snapshot?.volume1hUsd ?? null,
        {
          score: state.score,
          snapshot: state.snapshot,
          redFlags: state.score?.redFlags ?? []
        }
      );
      createdOrUpdated += 1;
      db.logSafetyEvent(state.tokenId, 'INFO', 'watch_only_candidate', 'Watch-only candidate tracked for research', { reason: watch.reason, status });
      decisions.push({ tokenId: state.tokenId, symbol: state.symbol, action: status, reason: watch.reason });
    }

    db.finishRunLog(runLogId, 'SUCCESS', { createdOrUpdated, decisions });
    return { createdOrUpdated, decisions };
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'unknown watch-only error' });
    throw error;
  }
}

export function buildWatchOnlyReport(db: AppDb, config?: AppConfig): Record<string, unknown> {
  const candidates = db.listWatchOnlyCandidates();
  const today = new Date().toISOString().slice(0, 10);
  const newToday = candidates.filter((candidate) => candidate.createdAt.startsWith(today));
  const active = candidates.filter((candidate) => candidate.status === 'WATCH_ONLY' || candidate.status === 'PAPER_TRACKED');
  const bestMover = [...candidates].sort((a, b) => (b.bestGainPct ?? Number.NEGATIVE_INFINITY) - (a.bestGainPct ?? Number.NEGATIVE_INFINITY))[0] ?? null;
  const worstMover = [...candidates].sort((a, b) => (a.worstDrawdownPct ?? Number.POSITIVE_INFINITY) - (b.worstDrawdownPct ?? Number.POSITIVE_INFINITY))[0] ?? null;
  const averageBestGain = candidates.length > 0 ? candidates.reduce((sum, candidate) => sum + (candidate.bestGainPct ?? 0), 0) / candidates.length : 0;
  const averageWorstDrawdown = candidates.length > 0 ? candidates.reduce((sum, candidate) => sum + (candidate.worstDrawdownPct ?? 0), 0) / candidates.length : 0;
  const paperTracked = candidates.filter((candidate) => candidate.status === 'PAPER_TRACKED').length;
  const topReasons = (() => {
    const counts = new Map<string, number>();
    for (const candidate of candidates) counts.set(candidate.reason, (counts.get(candidate.reason) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
  })();
  const topRedFlags = (() => {
    const flags = db.listLatestTokenStates(100).flatMap((state) => state.score?.redFlags ?? []);
    const counts = new Map<string, number>();
    for (const flag of flags) counts.set(flag, (counts.get(flag) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
  })();
  const outcomeSummary = config ? summarizeWatchOutcomes(db, config) : {};
  const signalAnalysisSummary = summarizeWatchOnlySignalAnalysis(db);

  return {
    totalWatchOnlyCandidates: candidates.length,
    newToday: newToday.length,
    activeCandidates: active.length,
    bestMover,
    worstMover,
    averageBestGainPct: Number(averageBestGain.toFixed(4)),
    averageWorstDrawdownPct: Number(averageWorstDrawdown.toFixed(4)),
    laterBecamePaperBuyCount: paperTracked,
    topReasonsTheyWereWatchOnly: topReasons,
    topRedFlagsBlockingPaperBuy: topRedFlags,
    ...outcomeSummary,
    ...signalAnalysisSummary,
    finalSafetyStatus: 'Real trading remains locked.'
  };
}
