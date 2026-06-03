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

export type WatchRunnerProfile = 'RUNNER_PROFILE' | 'DUMP_PROFILE' | 'NOISE_PROFILE' | 'UNKNOWN_PROFILE';

function fmtPct(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `${value.toFixed(2)}%`;
}

function fmtNum(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : value.toFixed(2);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function countItems(items: string[], limit = 10): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
}

export function classifyWatchRunnerProfile(input: {
  momentumScore: number | null;
  safetyScore: number | null;
  volume1hUsd: number | null;
  liquidityUsd: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  holderConcentration: string | null;
  priceUsd: number | null;
}): WatchRunnerProfile {
  const hasPriceLiquidity = input.priceUsd !== null && input.liquidityUsd !== null;
  if (!hasPriceLiquidity || input.volume1hUsd === null || input.liquidityUsd === null) {
    return 'NOISE_PROFILE';
  }
  if (
    (input.momentumScore ?? -Infinity) >= 18 &&
    input.volume1hUsd >= 100000 &&
    input.liquidityUsd >= 12000
  ) {
    return 'RUNNER_PROFILE';
  }
  if (
    (input.priceChange5mPct ?? 0) <= -25 ||
    (input.priceChange1hPct ?? 0) <= -50 ||
    (input.liquidityUsd < 10000 && input.volume1hUsd >= 100000) ||
    (input.holderConcentration === 'RISKY' && (input.safetyScore ?? 999) < 10)
  ) {
    return 'DUMP_PROFILE';
  }
  if (input.volume1hUsd < 50000 || input.liquidityUsd < 8000) {
    return 'NOISE_PROFILE';
  }
  return 'UNKNOWN_PROFILE';
}

export function renderWatchAutopsy(db: AppDb, config: AppConfig): string {
  const candidates = db.listWatchOnlyCandidates();
  const analyses = db.listWatchOnlySignalAnalyses();
  const states = db.listLatestTokenStates(200);
  const stateByTokenId = new Map(states.map((state) => [state.tokenId, state]));
  const analysisByTokenId = new Map(analyses.map((analysis) => [analysis.tokenId, analysis]));
  const outcomeSummary = summarizeWatchOutcomes(db, config) as any;
  const classCounts = summarizeWatchOnlySignalAnalysis(db).watchOnlySignalClassCounts as Record<string, number>;

  const rows = candidates.map((candidate) => {
    const state = stateByTokenId.get(candidate.tokenId);
    const score = state?.score;
    const snapshot = state?.snapshot;
    const signalClass = analysisByTokenId.get(candidate.tokenId)?.signalClass ?? 'UNCLASSIFIED';
    const profile = classifyWatchRunnerProfile({
      momentumScore: score?.momentumScore ?? null,
      safetyScore: score?.safetyScore ?? null,
      volume1hUsd: candidate.volume1hUsd ?? snapshot?.volume1hUsd ?? null,
      liquidityUsd: candidate.liquidityUsd ?? snapshot?.liquidityUsd ?? null,
      priceChange5mPct: snapshot?.priceChange5mPct ?? null,
      priceChange1hPct: snapshot?.priceChange1hPct ?? null,
      holderConcentration: snapshot?.holderConcentration ?? null,
      priceUsd: snapshot?.priceUsd ?? candidate.latestPriceUsd ?? null
    });
    return {
      symbol: state?.symbol ?? JSON.parse(candidate.rawJson || '{}')?.snapshot?.symbol ?? `T${candidate.tokenId}`,
      tokenId: candidate.tokenId,
      signalClass,
      profile,
      bestGainPct: candidate.bestGainPct,
      worstDrawdownPct: candidate.worstDrawdownPct,
      entryPriceUsd: candidate.entryPriceUsd,
      latestPriceUsd: candidate.latestPriceUsd,
      bestPriceUsd: candidate.bestPriceUsd,
      liquidityUsd: candidate.liquidityUsd ?? snapshot?.liquidityUsd ?? null,
      volume5mUsd: candidate.volume5mUsd ?? snapshot?.volume5mUsd ?? null,
      volume1hUsd: candidate.volume1hUsd ?? snapshot?.volume1hUsd ?? null,
      totalScore: score?.totalScore ?? null,
      safetyScore: score?.safetyScore ?? null,
      momentumScore: score?.momentumScore ?? null,
      verdict: score?.verdict ?? null,
      redFlags: score?.redFlags ?? [],
      mintAuthority: snapshot?.mintAuthority ?? null,
      freezeAuthority: snapshot?.freezeAuthority ?? null,
      holderConcentration: snapshot?.holderConcentration ?? null,
      creatorStatus: snapshot?.creatorStatus ?? null,
      sellQuoteAvailable: snapshot?.sellQuoteAvailable ?? null,
      estimatedSlippageBps: snapshot?.estimatedSlippageBps ?? null,
      movedBeforeDiscoveryPct: snapshot?.movedBeforeDiscoveryPct ?? null,
      dataUpdatedAt: snapshot?.dataUpdatedAt ?? null
    };
  });

  const runners = rows.filter((row) => row.signalClass === 'EARLY_RUNNER' || row.signalClass === 'LATE_RUNNER');
  const dumps = rows.filter((row) => row.signalClass === 'INSTANT_DUMP' || row.signalClass === 'DEAD_NOISE');
  const profileGroups = {
    RUNNER_PROFILE: rows.filter((row) => row.profile === 'RUNNER_PROFILE'),
    DUMP_PROFILE: rows.filter((row) => row.profile === 'DUMP_PROFILE'),
    NOISE_PROFILE: rows.filter((row) => row.profile === 'NOISE_PROFILE'),
    UNKNOWN_PROFILE: rows.filter((row) => row.profile === 'UNKNOWN_PROFILE')
  };
  const topRunners = [...rows].sort((a, b) => (b.bestGainPct ?? Number.NEGATIVE_INFINITY) - (a.bestGainPct ?? Number.NEGATIVE_INFINITY)).slice(0, 10);
  const topDumps = [...rows].sort((a, b) => (a.worstDrawdownPct ?? Number.POSITIVE_INFINITY) - (b.worstDrawdownPct ?? Number.POSITIVE_INFINITY)).slice(0, 10);
  const runnerFlags = runners.flatMap((row) => row.redFlags);
  const dumpFlags = dumps.flatMap((row) => row.redFlags);
  const runnerSignals = countItems(runnerFlags.filter((flag) => !dumpFlags.includes(flag)));
  const dumpSignals = countItems(dumpFlags.filter((flag) => !runnerFlags.includes(flag)));
  const runnerLiquidity = median(runners.map((row) => row.liquidityUsd).filter((v): v is number => v !== null));
  const dumpLiquidity = median(dumps.map((row) => row.liquidityUsd).filter((v): v is number => v !== null));
  const runnerVol1h = median(runners.map((row) => row.volume1hUsd).filter((v): v is number => v !== null));
  const dumpVol1h = median(dumps.map((row) => row.volume1hUsd).filter((v): v is number => v !== null));
  const runnerMomentum = median(runners.map((row) => row.momentumScore).filter((v): v is number => v !== null));
  const dumpMomentum = median(dumps.map((row) => row.momentumScore).filter((v): v is number => v !== null));
  const runnerSafety = median(runners.map((row) => row.safetyScore).filter((v): v is number => v !== null));
  const dumpSafety = median(dumps.map((row) => row.safetyScore).filter((v): v is number => v !== null));
  const sellBreakdown = (group: typeof rows) => countItems(group.map((row) => row.sellQuoteAvailable ?? 'UNKNOWN'));
  const holderBreakdown = (group: typeof rows) => countItems(group.map((row) => row.holderConcentration ?? 'UNKNOWN'));

  const lines: string[] = [];
  lines.push('Watch-Only Winner Autopsy');
  lines.push('');
  lines.push('Summary');
  lines.push(`- total watch-only candidates: ${candidates.length}`);
  lines.push(`- EARLY_RUNNER: ${classCounts.EARLY_RUNNER ?? 0}`);
  lines.push(`- LATE_RUNNER: ${classCounts.LATE_RUNNER ?? 0}`);
  lines.push(`- INSTANT_DUMP: ${classCounts.INSTANT_DUMP ?? 0}`);
  lines.push(`- DEAD_NOISE: ${classCounts.DEAD_NOISE ?? 0}`);
  lines.push(`- TOO_DANGEROUS: ${classCounts.TOO_DANGEROUS ?? 0}`);
  lines.push(`- RUNNER_PROFILE: ${profileGroups.RUNNER_PROFILE.length}`);
  lines.push(`- DUMP_PROFILE: ${profileGroups.DUMP_PROFILE.length}`);
  lines.push(`- NOISE_PROFILE: ${profileGroups.NOISE_PROFILE.length}`);
  lines.push(`- UNKNOWN_PROFILE: ${profileGroups.UNKNOWN_PROFILE.length}`);
  if (outcomeSummary.averageReturnByWindow) lines.push(`- average return by window: ${JSON.stringify(outcomeSummary.averageReturnByWindow)}`);
  if (outcomeSummary.medianReturnByWindow) lines.push(`- median return by window: ${JSON.stringify(outcomeSummary.medianReturnByWindow)}`);
  if (outcomeSummary.takeProfitHitPctByWindow) lines.push(`- take-profit hit % by window: ${JSON.stringify(outcomeSummary.takeProfitHitPctByWindow)}`);
  if (outcomeSummary.stopLossHitPctByWindow) lines.push(`- stop-loss hit % by window: ${JSON.stringify(outcomeSummary.stopLossHitPctByWindow)}`);
  const profileAverage = Object.fromEntries(Object.entries(profileGroups).map(([key, group]) => [key, {
    averageBestGainPct: group.length > 0 ? Number((group.reduce((sum, row) => sum + (row.bestGainPct ?? 0), 0) / group.length).toFixed(4)) : 0,
    averageWorstDrawdownPct: group.length > 0 ? Number((group.reduce((sum, row) => sum + (row.worstDrawdownPct ?? 0), 0) / group.length).toFixed(4)) : 0
  }]));
  lines.push(`- profile averages: ${JSON.stringify(profileAverage)}`);
  lines.push('');
  lines.push('Top Runners');
  for (const row of topRunners) lines.push(`- ${row.symbol} tokenId=${row.tokenId} best=${fmtPct(row.bestGainPct)} worst=${fmtPct(row.worstDrawdownPct)} liq=${fmtNum(row.liquidityUsd)} v1h=${fmtNum(row.volume1hUsd)} total=${fmtNum(row.totalScore)} safety=${fmtNum(row.safetyScore)} momentum=${fmtNum(row.momentumScore)} verdict=${row.verdict ?? '-'} redFlags=${row.redFlags.join(', ') || '-'} mint=${row.mintAuthority ?? '-'} freeze=${row.freezeAuthority ?? '-'} holder=${row.holderConcentration ?? '-'} creator=${row.creatorStatus ?? '-'} sellQuote=${row.sellQuoteAvailable ?? '-'} slip=${row.estimatedSlippageBps ?? '-'} movedBefore=${fmtNum(row.movedBeforeDiscoveryPct)} updated=${row.dataUpdatedAt ?? '-'}`);
  lines.push('');
  lines.push('Top Dumps');
  for (const row of topDumps) lines.push(`- ${row.symbol} tokenId=${row.tokenId} best=${fmtPct(row.bestGainPct)} worst=${fmtPct(row.worstDrawdownPct)} liq=${fmtNum(row.liquidityUsd)} v1h=${fmtNum(row.volume1hUsd)} total=${fmtNum(row.totalScore)} safety=${fmtNum(row.safetyScore)} momentum=${fmtNum(row.momentumScore)} verdict=${row.verdict ?? '-'} redFlags=${row.redFlags.join(', ') || '-'} mint=${row.mintAuthority ?? '-'} freeze=${row.freezeAuthority ?? '-'} holder=${row.holderConcentration ?? '-'} creator=${row.creatorStatus ?? '-'} sellQuote=${row.sellQuoteAvailable ?? '-'} slip=${row.estimatedSlippageBps ?? '-'} movedBefore=${fmtNum(row.movedBeforeDiscoveryPct)} updated=${row.dataUpdatedAt ?? '-'}`);
  lines.push('');
  lines.push('Runner vs Dump Comparison');
  lines.push(`- top RUNNER_PROFILE candidates: ${profileGroups.RUNNER_PROFILE.slice(0, 5).map((row) => `${row.symbol} ${fmtPct(row.bestGainPct)}`).join(', ') || 'none'}`);
  lines.push(`- top DUMP_PROFILE candidates: ${profileGroups.DUMP_PROFILE.slice(0, 5).map((row) => `${row.symbol} ${fmtPct(row.worstDrawdownPct)}`).join(', ') || 'none'}`);
  lines.push(`- common red flags among runners: ${countItems(runnerFlags).map((x) => `${x.value} (${x.count})`).join(', ') || 'none'}`);
  lines.push(`- common red flags among dumps: ${countItems(dumpFlags).map((x) => `${x.value} (${x.count})`).join(', ') || 'none'}`);
  lines.push(`- runner-heavy signals: ${runnerSignals.map((x) => `${x.value} (${x.count})`).join(', ') || 'none'}`);
  lines.push(`- dump-heavy signals: ${dumpSignals.map((x) => `${x.value} (${x.count})`).join(', ') || 'none'}`);
  lines.push(`- median liquidity runners vs dumps: ${fmtNum(runnerLiquidity)} vs ${fmtNum(dumpLiquidity)}`);
  lines.push(`- median volume1h runners vs dumps: ${fmtNum(runnerVol1h)} vs ${fmtNum(dumpVol1h)}`);
  lines.push(`- median momentum runners vs dumps: ${fmtNum(runnerMomentum)} vs ${fmtNum(dumpMomentum)}`);
  lines.push(`- median safety runners vs dumps: ${fmtNum(runnerSafety)} vs ${fmtNum(dumpSafety)}`);
  lines.push(`- sellQuoteAvailable runners: ${JSON.stringify(sellBreakdown(runners))}`);
  lines.push(`- sellQuoteAvailable dumps: ${JSON.stringify(sellBreakdown(dumps))}`);
  lines.push(`- holderConcentration runners: ${JSON.stringify(holderBreakdown(runners))}`);
  lines.push(`- holderConcentration dumps: ${JSON.stringify(holderBreakdown(dumps))}`);
  lines.push('');
  lines.push('Watch-only analysis is research only.');
  lines.push('Real trading remains locked.');
  lines.push('Paper only unless explicitly running paper commands.');
  return lines.join('\n');
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
  const profileRows = candidates.map((candidate) => {
    const state = db.listLatestTokenStates(200).find((item) => item.tokenId === candidate.tokenId);
    const score = state?.score;
    const snapshot = state?.snapshot;
    const profile = classifyWatchRunnerProfile({
      momentumScore: score?.momentumScore ?? null,
      safetyScore: score?.safetyScore ?? null,
      volume1hUsd: candidate.volume1hUsd ?? snapshot?.volume1hUsd ?? null,
      liquidityUsd: candidate.liquidityUsd ?? snapshot?.liquidityUsd ?? null,
      priceChange5mPct: snapshot?.priceChange5mPct ?? null,
      priceChange1hPct: snapshot?.priceChange1hPct ?? null,
      holderConcentration: snapshot?.holderConcentration ?? null,
      priceUsd: snapshot?.priceUsd ?? candidate.latestPriceUsd ?? null
    });
    return { candidate, profile };
  });
  const profileSummary = Object.fromEntries((['RUNNER_PROFILE', 'DUMP_PROFILE', 'NOISE_PROFILE', 'UNKNOWN_PROFILE'] as WatchRunnerProfile[]).map((profile) => {
    const group = profileRows.filter((row) => row.profile === profile).map((row) => row.candidate);
    return [profile, {
      count: group.length,
      averageBestGainPct: group.length > 0 ? Number((group.reduce((sum, row) => sum + (row.bestGainPct ?? 0), 0) / group.length).toFixed(4)) : 0,
      averageWorstDrawdownPct: group.length > 0 ? Number((group.reduce((sum, row) => sum + (row.worstDrawdownPct ?? 0), 0) / group.length).toFixed(4)) : 0
    }];
  }));

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
    watchRunnerProfileCounts: Object.fromEntries(Object.entries(profileSummary).map(([key, value]) => [key, value.count])),
    watchRunnerProfileSummary: profileSummary,
    finalSafetyStatus: 'Real trading remains locked.'
  };
}
