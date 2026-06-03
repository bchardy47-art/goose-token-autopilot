import type { AppDb } from '../db';
import type { AppConfig, PaperEligibilityDiagnosticRow } from '../types';
import { buildPaperEligibilityDiagnostics, rankPaperEligibilityRows } from './autoPaper';
import { buildFreshCandidateWatchlist } from './freshWatchlist';
import { buildFreshRejectionAnalytics } from './freshRejections';
import { buildTooEarlyWatchReport } from './tooEarlyWatch';

const DEFAULT_SESSION_WINDOW_MINUTES = 60;

type SessionRecommendation = 'KEEP_WATCHING' | 'INVESTIGATE_NOW' | 'SAFE_TO_STOP' | 'DO_NOT_BUY';

function shortenMint(mint: string): string {
  return mint.length <= 12 ? mint : `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function fmtNum(value: number | null | undefined, digits = 1): string {
  return value == null ? '-' : value.toFixed(digits);
}

function fmtMoney(value: number | null | undefined): string {
  return value == null ? '-' : `$${value.toFixed(0)}`;
}

function topCount(rows: PaperEligibilityDiagnosticRow[], predicate: (row: PaperEligibilityDiagnosticRow) => boolean): number {
  return rows.filter(predicate).length;
}

function blockerIncludes(row: PaperEligibilityDiagnosticRow, text: string): boolean {
  return row.blockers.some((blocker) => blocker.includes(text));
}

function recommendationForSummary(input: {
  acceptedRecentCount: number;
  eligibleFreshCount: number;
  cleanTooEarlyCount: number;
  riskyOrLowWatchOnly: boolean;
}): SessionRecommendation {
  if (input.eligibleFreshCount > 0 || input.cleanTooEarlyCount > 0) return 'INVESTIGATE_NOW';
  if (input.acceptedRecentCount === 0) return 'SAFE_TO_STOP';
  if (input.riskyOrLowWatchOnly) return 'DO_NOT_BUY';
  return 'KEEP_WATCHING';
}

export function buildTokenSessionSummary(db: AppDb, config: AppConfig, options: { windowMinutes?: number } = {}): {
  windowMinutes: number;
  sourceBreakdown: Record<string, number>;
  totalCandidatesEvaluated: number;
  acceptedRecentCount: number;
  freshCandidatesCount: number;
  tooEarlyCandidatesCount: number;
  cleanTooEarlyCount: number;
  eligibleFreshCount: number;
  paperBuysWouldOpenCount: number;
  topBlockerBuckets: Record<string, number>;
  closestRejectedCandidate: (PaperEligibilityDiagnosticRow & { ageMinutes: number | null }) | null;
  recommendation: SessionRecommendation;
  finalSafetyStatus: string;
  noPaperBuysOpened: true;
} {
  const windowMinutes = options.windowMinutes ?? DEFAULT_SESSION_WINDOW_MINUTES;
  const diagnostics = buildPaperEligibilityDiagnostics(db, config) as any;
  const allRows = ((diagnostics.allCandidates as PaperEligibilityDiagnosticRow[] | undefined) ?? []).filter(
    (row) => (row.dataAgeMinutes ?? Number.POSITIVE_INFINITY) <= windowMinutes
  );
  const fresh = buildFreshCandidateWatchlist(db, config, { maxAgeMinutes: windowMinutes, limit: 10 });
  const tooEarly = buildTooEarlyWatchReport(db, config, { maxAgeMinutes: Math.min(windowMinutes, 15), limit: 10 });
  const rejections = buildFreshRejectionAnalytics(db, config, { maxAgeMinutes: windowMinutes, limit: 5 });
  const sourceBreakdown = allRows.reduce<Record<string, number>>((acc, row) => {
    const source = row.sourceUrl?.includes('geckoterminal') ? 'geckoterminal' : 'other';
    acc[source] = (acc[source] ?? 0) + 1;
    return acc;
  }, {});

  const closestRejectedCandidate = [...allRows]
    .filter((row) => row.blockerCount > 0)
    .sort((a, b) => rankPaperEligibilityRows(a, b, config))[0];

  const topBlockerBuckets = {
    lowLiquidity: topCount(allRows, (row) => blockerIncludes(row, 'latest liquidity missing') || (row.liquidityUsd ?? 0) < config.minLiquidityUsd),
    holderRisky: topCount(allRows, (row) => row.holderConcentration === 'RISKY'),
    watchPriorityBelowRequirement: topCount(allRows, (row) => blockerIncludes(row, 'watch priority below paper requirement')),
    noiseProfile: topCount(allRows, (row) => row.watchProfile === 'NOISE_PROFILE'),
    entryDataStale: topCount(allRows, (row) => row.isEntryStale),
    slippageMissing: topCount(allRows, (row) => blockerIncludes(row, 'slippage missing')),
    slippageAboveMax: topCount(allRows, (row) => blockerIncludes(row, 'slippage above MAX_SLIPPAGE_BPS')),
    movedBeforeDiscovery: topCount(allRows, (row) => row.isMovedBeforeDiscoveryBlocked),
    tokenAgeOutsideRange: topCount(allRows, (row) => blockerIncludes(row, 'token age outside configured range'))
  };

  const recommendation = recommendationForSummary({
    acceptedRecentCount: fresh.freshCandidatesShown,
    eligibleFreshCount: fresh.eligibleFreshCandidatesCount,
    cleanTooEarlyCount: tooEarly.cleanTooEarlyCount,
    riskyOrLowWatchOnly: fresh.freshCandidatesShown > 0 && fresh.freshCandidatesShown === rejections.buckets.holderRisky && rejections.buckets.lowWatchPriorityCount >= fresh.freshCandidatesShown
  });

  return {
    windowMinutes,
    sourceBreakdown,
    totalCandidatesEvaluated: allRows.length,
    acceptedRecentCount: fresh.freshCandidatesShown,
    freshCandidatesCount: fresh.freshCandidatesShown,
    tooEarlyCandidatesCount: tooEarly.totalTooEarlyCandidates,
    cleanTooEarlyCount: tooEarly.cleanTooEarlyCount,
    eligibleFreshCount: fresh.eligibleFreshCandidatesCount,
    paperBuysWouldOpenCount: fresh.paperBuysWouldOpenCount,
    topBlockerBuckets,
    closestRejectedCandidate: closestRejectedCandidate ? { ...closestRejectedCandidate, ageMinutes: closestRejectedCandidate.dataAgeMinutes } : null,
    recommendation,
    finalSafetyStatus: 'Real trading remains locked.',
    noPaperBuysOpened: true
  };
}

export function renderTokenSessionSummary(db: AppDb, config: AppConfig, options: { windowMinutes?: number } = {}): string {
  const report = buildTokenSessionSummary(db, config, options);
  const lines: string[] = [];
  lines.push('Token Session Summary');
  lines.push(`Session window: last ${report.windowMinutes} minutes`);
  lines.push(`Source breakdown: ${Object.entries(report.sourceBreakdown).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
  lines.push(`Evaluated=${report.totalCandidatesEvaluated} | Fresh=${report.freshCandidatesCount} | Too-early=${report.tooEarlyCandidatesCount} | Clean-too-early=${report.cleanTooEarlyCount} | Eligible fresh=${report.eligibleFreshCount} | paperBuysWouldOpenCount=${report.paperBuysWouldOpenCount}`);
  lines.push('Top blocker buckets:');
  lines.push(`- low liquidity: ${report.topBlockerBuckets.lowLiquidity}`);
  lines.push(`- holder RISKY: ${report.topBlockerBuckets.holderRisky}`);
  lines.push(`- watch priority below requirement: ${report.topBlockerBuckets.watchPriorityBelowRequirement}`);
  lines.push(`- NOISE_PROFILE: ${report.topBlockerBuckets.noiseProfile}`);
  lines.push(`- entry data stale: ${report.topBlockerBuckets.entryDataStale}`);
  lines.push(`- slippage missing: ${report.topBlockerBuckets.slippageMissing}`);
  lines.push(`- slippage above max: ${report.topBlockerBuckets.slippageAboveMax}`);
  lines.push(`- moved before discovery: ${report.topBlockerBuckets.movedBeforeDiscovery}`);
  lines.push(`- token age outside range: ${report.topBlockerBuckets.tokenAgeOutsideRange}`);
  lines.push('');
  if (report.closestRejectedCandidate) {
    const row = report.closestRejectedCandidate;
    lines.push(`Closest rejected: ${row.symbol} (#${row.tokenId}) age=${fmtNum(row.ageMinutes)}m liq=${fmtMoney(row.liquidityUsd)} quote=${row.sellQuoteAvailable ?? '-'} slip=${row.estimatedSlippageBps ?? '-'}bps`);
    lines.push(`  holder=${row.holderConcentration ?? '-'} watch=${row.watchProfile ?? '-'}/${row.watchPriority ?? '-'} mint=${shortenMint(row.mint)}`);
    lines.push(`  blockers=${row.blockers.join('; ') || 'none'}`);
    lines.push(`  source=${row.sourceUrl ?? '-'}`);
  } else {
    lines.push('Closest rejected: none');
  }
  lines.push(`Recommendation: ${report.recommendation}`);
  lines.push('No paper buys opened.');
  lines.push(report.finalSafetyStatus);
  return lines.join('\n');
}
