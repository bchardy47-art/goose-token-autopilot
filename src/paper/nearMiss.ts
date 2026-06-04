import type { AppDb } from '../db';
import type { AppConfig, PaperEligibilityDiagnosticRow } from '../types';
import { buildPaperEligibilityDiagnostics, rankPaperEligibilityRows } from './autoPaper';

const DEFAULT_NEAR_MISS_WINDOW_MINUTES = 60;

export type NearMissCategory =
  | 'WOULD_PASS_EXCEPT_WATCH_PRIORITY'
  | 'WOULD_PASS_EXCEPT_HOLDER_RISK'
  | 'WOULD_PASS_EXCEPT_AGE'
  | 'WOULD_PASS_EXCEPT_STALE'
  | 'MULTI_BLOCKER_NEAR_MISS'
  | 'HARD_REJECT';

export type NearMissRecommendation = 'DO_NOT_LOOSEN' | 'CONSIDER_SHADOW_PAPER_RULE' | 'RECHECK_SOON' | 'INVESTIGATE_NOW';

function fmtNum(value: number | null | undefined, digits = 1): string {
  return value == null ? '-' : value.toFixed(digits);
}

function fmtMoney(value: number | null | undefined): string {
  return value == null ? '-' : `$${value.toFixed(0)}`;
}

function shortenMint(mint: string): string {
  return mint.length <= 12 ? mint : `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function blockerIncludes(row: PaperEligibilityDiagnosticRow, text: string): boolean {
  return row.blockers.some((blocker) => blocker.includes(text));
}

function nonAgeNonWatchNonHolderBlockers(row: PaperEligibilityDiagnosticRow): string[] {
  return row.blockers.filter(
    (blocker) =>
      blocker !== 'token age outside configured range' &&
      blocker !== 'watch priority below paper requirement' &&
      !/holder/i.test(blocker)
  );
}

export function classifyNearMiss(row: PaperEligibilityDiagnosticRow): NearMissCategory {
  const hardReject =
    blockerIncludes(row, 'slippage above MAX_SLIPPAGE_BPS') ||
    blockerIncludes(row, 'slippage missing') ||
    blockerIncludes(row, 'sell quote unknown') ||
    blockerIncludes(row, 'sell quote unavailable') ||
    blockerIncludes(row, 'latest liquidity missing') ||
    row.isMovedBeforeDiscoveryBlocked ||
    row.watchPriority === 'AVOID_WATCH_PRIORITY';
  if (hardReject) return 'HARD_REJECT';

  const blockers = row.blockers;
  const nonAgeNonWatchNonHolder = nonAgeNonWatchNonHolderBlockers(row);
  const ageOnlyish = blockers.includes('token age outside configured range') && nonAgeNonWatchNonHolder.length === 0 && row.holderConcentration === 'SAFE';
  if (ageOnlyish) return 'WOULD_PASS_EXCEPT_AGE';

  const staleOnlyish = row.isEntryStale && blockers.length === 1 && row.holderConcentration === 'SAFE';
  if (staleOnlyish) return 'WOULD_PASS_EXCEPT_STALE';

  const watchOnlyish = blockerIncludes(row, 'watch priority below paper requirement') && row.holderConcentration === 'SAFE' && nonAgeNonWatchNonHolder.length === 0;
  if (watchOnlyish) return 'WOULD_PASS_EXCEPT_WATCH_PRIORITY';

  const holderOnlyish = row.holderConcentration === 'RISKY' && !blockerIncludes(row, 'watch priority below paper requirement') && nonAgeNonWatchNonHolder.length === 0;
  if (holderOnlyish) return 'WOULD_PASS_EXCEPT_HOLDER_RISK';

  if (row.blockerCount <= 2 && (row.liquidityUsd ?? 0) >= 20000 && row.sellQuoteAvailable === 'YES') {
    return 'MULTI_BLOCKER_NEAR_MISS';
  }

  return 'HARD_REJECT';
}

function recommendationForNearMiss(rows: Array<PaperEligibilityDiagnosticRow & { category: NearMissCategory }>): NearMissRecommendation {
  const wouldPassWatch = rows.filter((row) => row.category === 'WOULD_PASS_EXCEPT_WATCH_PRIORITY' && row.holderConcentration === 'SAFE' && (row.liquidityUsd ?? 0) >= 20000 && (row.estimatedSlippageBps ?? Infinity) <= 300);
  const wouldPassAge = rows.filter((row) => row.category === 'WOULD_PASS_EXCEPT_AGE' && row.holderConcentration === 'SAFE' && (row.watchPriority === 'HIGH_WATCH_PRIORITY' || row.watchPriority === 'MEDIUM_WATCH_PRIORITY'));
  const investigate = rows.some((row) => ['WOULD_PASS_EXCEPT_HOLDER_RISK', 'WOULD_PASS_EXCEPT_STALE'].includes(row.category));
  const allRiskyLowWatch = rows.length > 0 && rows.every((row) => row.holderConcentration === 'RISKY' && (row.watchPriority === 'LOW_WATCH_PRIORITY' || row.watchProfile === 'NOISE_PROFILE'));

  if (wouldPassWatch.length >= 2) return 'CONSIDER_SHADOW_PAPER_RULE';
  if (wouldPassAge.length > 0) return 'RECHECK_SOON';
  if (investigate) return 'INVESTIGATE_NOW';
  if (allRiskyLowWatch) return 'DO_NOT_LOOSEN';
  return 'DO_NOT_LOOSEN';
}

export function buildNearMissShadowReport(db: AppDb, config: AppConfig, options: { windowMinutes?: number } = {}): {
  windowMinutes: number;
  totalFreshCandidatesConsidered: number;
  nearMissCount: number;
  hardRejectCount: number;
  categoryCounts: Record<NearMissCategory, number>;
  bestNearMissCandidate: (PaperEligibilityDiagnosticRow & { category: NearMissCategory }) | null;
  recommendation: NearMissRecommendation;
  candidates: Array<PaperEligibilityDiagnosticRow & { category: NearMissCategory }>;
  finalSafetyStatus: string;
  noPaperBuysOpened: true;
} {
  const windowMinutes = options.windowMinutes ?? DEFAULT_NEAR_MISS_WINDOW_MINUTES;
  const diagnostics = buildPaperEligibilityDiagnostics(db, config) as any;
  const rows = ((diagnostics.allCandidates as PaperEligibilityDiagnosticRow[] | undefined) ?? [])
    .filter((row) => (row.dataAgeMinutes ?? Number.POSITIVE_INFINITY) <= windowMinutes)
    .sort((a, b) => rankPaperEligibilityRows(a, b, config))
    .map((row) => ({ ...row, category: classifyNearMiss(row) }));

  const categoryCounts = rows.reduce<Record<NearMissCategory, number>>((acc, row) => {
    acc[row.category] = (acc[row.category] ?? 0) + 1;
    return acc;
  }, {
    WOULD_PASS_EXCEPT_WATCH_PRIORITY: 0,
    WOULD_PASS_EXCEPT_HOLDER_RISK: 0,
    WOULD_PASS_EXCEPT_AGE: 0,
    WOULD_PASS_EXCEPT_STALE: 0,
    MULTI_BLOCKER_NEAR_MISS: 0,
    HARD_REJECT: 0
  });

  const nearMisses = rows.filter((row) => row.category !== 'HARD_REJECT');
  return {
    windowMinutes,
    totalFreshCandidatesConsidered: rows.length,
    nearMissCount: nearMisses.length,
    hardRejectCount: categoryCounts.HARD_REJECT,
    categoryCounts,
    bestNearMissCandidate: nearMisses[0] ?? null,
    recommendation: recommendationForNearMiss(rows),
    candidates: rows.slice(0, 10),
    finalSafetyStatus: 'Real trading remains locked.',
    noPaperBuysOpened: true
  };
}

export function renderNearMissShadowReport(db: AppDb, config: AppConfig, options: { windowMinutes?: number } = {}): string {
  const report = buildNearMissShadowReport(db, config, options);
  const lines: string[] = [];
  lines.push('Near-Miss Shadow Lane');
  lines.push(`Session window: last ${report.windowMinutes} minutes`);
  lines.push(`Fresh considered=${report.totalFreshCandidatesConsidered} | Near-miss=${report.nearMissCount} | Hard reject=${report.hardRejectCount}`);
  lines.push(`Categories: WATCH=${report.categoryCounts.WOULD_PASS_EXCEPT_WATCH_PRIORITY} HOLDER=${report.categoryCounts.WOULD_PASS_EXCEPT_HOLDER_RISK} AGE=${report.categoryCounts.WOULD_PASS_EXCEPT_AGE} STALE=${report.categoryCounts.WOULD_PASS_EXCEPT_STALE} MULTI=${report.categoryCounts.MULTI_BLOCKER_NEAR_MISS} HARD=${report.categoryCounts.HARD_REJECT}`);
  lines.push('');
  for (const row of report.candidates) {
    lines.push(`${row.symbol} (#${row.tokenId}) age=${fmtNum(row.dataAgeMinutes)}m liq=${fmtMoney(row.liquidityUsd)} quote=${row.sellQuoteAvailable ?? '-'} slip=${row.estimatedSlippageBps ?? '-'}bps holder=${row.holderConcentration ?? '-'} watch=${row.watchProfile ?? '-'}/${row.watchPriority ?? '-'} score=${fmtNum(row.totalScore, 2)} category=${row.category}`);
    lines.push(`  blockers=${row.blockers.join('; ') || 'none'} source=${row.sourceUrl ?? '-'} mint=${shortenMint(row.mint)}`);
  }
  if (report.bestNearMissCandidate) {
    lines.push('');
    lines.push(`Best near-miss: ${report.bestNearMissCandidate.symbol} (#${report.bestNearMissCandidate.tokenId}) ${report.bestNearMissCandidate.category}`);
  }
  lines.push(`Recommendation: ${report.recommendation}`);
  lines.push('No paper buys opened.');
  lines.push(report.finalSafetyStatus);
  return lines.join('\n');
}
