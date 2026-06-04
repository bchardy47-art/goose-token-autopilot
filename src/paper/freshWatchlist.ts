import type { AppDb } from '../db';
import type { AppConfig, PaperEligibilityDiagnosticRow } from '../types';
import { buildPaperEligibilityDiagnostics, rankPaperEligibilityRows } from './autoPaper';

const DEFAULT_FRESH_WATCHLIST_MAX_AGE_MINUTES = 30;
const DEFAULT_FRESH_WATCHLIST_LIMIT = 10;

function shortenMint(mint: string): string {
  if (mint.length <= 12) return mint;
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function fmtNum(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? '-' : value.toFixed(digits);
}

function fmtInt(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : String(Math.round(value));
}

function fmtMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `$${value.toFixed(0)}`;
}

function lineForCandidate(row: PaperEligibilityDiagnosticRow): string[] {
  return [
    `${row.symbol} (#${row.tokenId}) ${shortenMint(row.mint)} age=${fmtNum(row.dataAgeMinutes, 1)}m liq=${fmtMoney(row.liquidityUsd)} quote=${row.sellQuoteAvailable ?? '-'} slip=${fmtInt(row.estimatedSlippageBps)}bps`,
    `  score=${fmtNum(row.totalScore)}/${fmtNum(row.safetyScore)}/${fmtNum(row.momentumScore)} holder=${row.holderConcentration ?? '-'} moved=${fmtNum(row.movedBeforeDiscoveryPct, 1)}% watch=${row.watchProfile ?? '-'}/${row.watchPriority ?? '-'}`,
    `  blockers=${row.blockers.length > 0 ? row.blockers.join('; ') : 'none'}`,
    `  warnings=${row.warnings.length > 0 ? row.warnings.join('; ') : 'none'}`,
    `  rank=${row.usefulRankReason}`,
    `  url=${row.sourceUrl ?? '-'}`
  ];
}

export function buildFreshCandidateWatchlist(db: AppDb, config: AppConfig, options: { maxAgeMinutes?: number; limit?: number } = {}): {
  totalEvaluated: number;
  freshCandidatesShown: number;
  eligibleFreshCandidatesCount: number;
  paperBuysWouldOpenCount: number;
  maxAgeMinutes: number;
  limit: number;
  candidates: PaperEligibilityDiagnosticRow[];
  finalSafetyStatus: string;
  noPaperBuysOpened: true;
} {
  const maxAgeMinutes = options.maxAgeMinutes ?? DEFAULT_FRESH_WATCHLIST_MAX_AGE_MINUTES;
  const limit = options.limit ?? DEFAULT_FRESH_WATCHLIST_LIMIT;
  const diagnostics = buildPaperEligibilityDiagnostics(db, config) as any;
  const rows = (diagnostics.topClosestCandidates as PaperEligibilityDiagnosticRow[] | undefined) ?? [];

  const allRows = [
    ...rows,
    ...((((diagnostics as Record<string, unknown>).allCandidates as PaperEligibilityDiagnosticRow[] | undefined) ?? []).filter(
      (candidate) => !rows.some((existing) => existing.tokenId === candidate.tokenId)
    ))
  ];

  const sourceRows = allRows.length > 0 ? allRows : [];
  const freshRows = sourceRows
    .filter((row) => (row.dataAgeMinutes ?? Number.POSITIVE_INFINITY) <= maxAgeMinutes)
    .sort((a, b) => {
      const noBlockerDelta = Number(a.blockerCount !== 0) - Number(b.blockerCount !== 0);
      if (noBlockerDelta !== 0) return noBlockerDelta;
      const blockerDelta = a.blockerCount - b.blockerCount;
      if (blockerDelta !== 0) return blockerDelta;
      const staleDelta = Number(a.isEntryStale) - Number(b.isEntryStale);
      if (staleDelta !== 0) return staleDelta;
      const slippageDelta = (a.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) - (b.estimatedSlippageBps ?? Number.POSITIVE_INFINITY);
      if (slippageDelta !== 0) return slippageDelta;
      const liquidityDelta = (b.liquidityUsd ?? Number.NEGATIVE_INFINITY) - (a.liquidityUsd ?? Number.NEGATIVE_INFINITY);
      if (liquidityDelta !== 0) return liquidityDelta;
      const scoreDelta = (b.totalScore ?? Number.NEGATIVE_INFINITY) - (a.totalScore ?? Number.NEGATIVE_INFINITY);
      if (scoreDelta !== 0) return scoreDelta;
      return rankPaperEligibilityRows(a, b, config);
    })
    .slice(0, limit);

  return {
    totalEvaluated: Number(diagnostics.totalCandidatesEvaluated ?? sourceRows.length),
    freshCandidatesShown: freshRows.length,
    eligibleFreshCandidatesCount: freshRows.filter((row) => row.blockerCount === 0).length,
    paperBuysWouldOpenCount: Math.max(0, Math.min(
      freshRows.filter((row) => row.blockerCount === 0).length,
      config.maxDailyPaperBuys - db.getDailyPaperBuyCount(),
      config.maxOpenPositions - db.getOpenPositionCount('PAPER')
    )),
    maxAgeMinutes,
    limit,
    candidates: freshRows,
    finalSafetyStatus: 'Real trading remains locked.',
    noPaperBuysOpened: true
  };
}

export function renderFreshCandidateWatchlist(db: AppDb, config: AppConfig, options: { maxAgeMinutes?: number; limit?: number } = {}): string {
  const report = buildFreshCandidateWatchlist(db, config, options);
  const lines: string[] = [];
  lines.push('Fresh Candidate Watchlist');
  lines.push(`Window: <= ${report.maxAgeMinutes} minutes | Limit: ${report.limit}`);
  lines.push(`Evaluated: ${report.totalEvaluated} | Fresh shown: ${report.freshCandidatesShown} | Eligible fresh: ${report.eligibleFreshCandidatesCount} | paperBuysWouldOpenCount=${report.paperBuysWouldOpenCount}`);
  lines.push('');

  if (report.candidates.length === 0) {
    lines.push('- no fresh candidates in current window');
  } else {
    for (const row of report.candidates) {
      lines.push(...lineForCandidate(row));
    }
  }

  lines.push('');
  lines.push('No paper buys opened.');
  lines.push(report.finalSafetyStatus);
  return lines.join('\n');
}
