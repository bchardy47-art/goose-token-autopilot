import type { AppDb } from '../db';
import type { AppConfig, PaperEligibilityDiagnosticRow } from '../types';
import { buildPaperEligibilityDiagnostics, rankPaperEligibilityRows } from './autoPaper';

const DEFAULT_FRESH_REJECTIONS_MAX_AGE_MINUTES = 60;
const DEFAULT_FRESH_REJECTIONS_LIMIT = 5;

function topBlocker(row: PaperEligibilityDiagnosticRow): string {
  return row.blockers[0] ?? 'eligible now';
}

function shortenMint(mint: string): string {
  if (mint.length <= 12) return mint;
  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function fmtNum(value: number | null | undefined, digits = 1): string {
  return value == null ? '-' : value.toFixed(digits);
}

function fmtMoney(value: number | null | undefined): string {
  return value == null ? '-' : `$${value.toFixed(0)}`;
}

function bucketCount(rows: PaperEligibilityDiagnosticRow[], predicate: (row: PaperEligibilityDiagnosticRow) => boolean): number {
  return rows.filter(predicate).length;
}

function blockerIncludes(row: PaperEligibilityDiagnosticRow, text: string): boolean {
  return row.blockers.some((blocker) => blocker.includes(text));
}

function deriveSuggestedNextBottleneck(rows: PaperEligibilityDiagnosticRow[]): string {
  if (rows.length < 3) return 'waiting problem';

  const sourceQualityCount = rows.filter((row) =>
    blockerIncludes(row, 'latest liquidity missing') ||
    blockerIncludes(row, 'slippage missing') ||
    blockerIncludes(row, 'slippage above MAX_SLIPPAGE_BPS') ||
    blockerIncludes(row, 'sell quote unknown') ||
    blockerIncludes(row, 'sell quote unavailable')
  ).length;

  const safetyCount = rows.filter((row) =>
    row.holderConcentration === 'RISKY' ||
    row.holderConcentration === 'UNKNOWN' ||
    blockerIncludes(row, 'safety score below paper minimum')
  ).length;

  const watchPriorityCount = rows.filter((row) => blockerIncludes(row, 'watch priority below paper requirement')).length;

  const maxCount = Math.max(sourceQualityCount, safetyCount, watchPriorityCount);
  if (maxCount === 0) return 'waiting problem';
  if (maxCount === sourceQualityCount) return 'source quality problem';
  if (maxCount === safetyCount) return 'safety/enrichment problem';
  return 'watch-priority problem';
}

export function buildFreshRejectionAnalytics(db: AppDb, config: AppConfig, options: { maxAgeMinutes?: number; limit?: number } = {}): {
  maxAgeMinutes: number;
  totalFreshCandidatesEvaluated: number;
  eligibleFreshCount: number;
  paperBuysWouldOpenCount: number;
  buckets: Record<string, number>;
  topClosestFreshCandidates: Array<PaperEligibilityDiagnosticRow & { topBlocker: string }>;
  suggestedNextBottleneck: string;
  finalSafetyStatus: string;
  noPaperBuysOpened: true;
} {
  const maxAgeMinutes = options.maxAgeMinutes ?? DEFAULT_FRESH_REJECTIONS_MAX_AGE_MINUTES;
  const limit = options.limit ?? DEFAULT_FRESH_REJECTIONS_LIMIT;
  const diagnostics = buildPaperEligibilityDiagnostics(db, config) as any;
  const allRows = ((diagnostics.allCandidates as PaperEligibilityDiagnosticRow[] | undefined) ?? []).filter(
    (row) => (row.dataAgeMinutes ?? Number.POSITIVE_INFINITY) <= maxAgeMinutes
  );

  const eligibleFreshRows = allRows.filter((row) => row.blockerCount === 0);
  const sortedFresh = [...allRows].sort((a, b) => rankPaperEligibilityRows(a, b, config));
  const topClosestFreshCandidates = sortedFresh.slice(0, limit).map((row) => ({ ...row, topBlocker: topBlocker(row) }));

  const buckets = {
    missingLiquidity: bucketCount(allRows, (row) => blockerIncludes(row, 'latest liquidity missing')),
    liquidityBelowMinimum: bucketCount(allRows, (row) => (row.liquidityUsd ?? 0) > 0 && (row.liquidityUsd ?? 0) < config.minLiquidityUsd),
    missingSlippage: bucketCount(allRows, (row) => blockerIncludes(row, 'slippage missing')),
    slippageAboveMax: bucketCount(allRows, (row) => blockerIncludes(row, 'slippage above MAX_SLIPPAGE_BPS')),
    holderRisky: bucketCount(allRows, (row) => row.holderConcentration === 'RISKY'),
    holderUnknown: bucketCount(allRows, (row) => row.holderConcentration === 'UNKNOWN' || row.holderConcentration === null),
    safetyScoreBelowPaperMinimum: bucketCount(allRows, (row) => blockerIncludes(row, 'safety score below paper minimum')),
    totalScoreBelowPaperMinimum: bucketCount(allRows, (row) => blockerIncludes(row, 'total score below paper minimum')),
    momentumScoreBelowPaperMinimum: bucketCount(allRows, (row) => blockerIncludes(row, 'momentum score below paper minimum')),
    watchPriorityBelowPaperRequirement: bucketCount(allRows, (row) => blockerIncludes(row, 'watch priority below paper requirement')),
    noiseProfileCount: bucketCount(allRows, (row) => row.watchProfile === 'NOISE_PROFILE'),
    lowWatchPriorityCount: bucketCount(allRows, (row) => row.watchPriority === 'LOW_WATCH_PRIORITY'),
    avoidWatchPriorityCount: bucketCount(allRows, (row) => row.watchPriority === 'AVOID_WATCH_PRIORITY'),
    entryDataStale: bucketCount(allRows, (row) => row.isEntryStale),
    movedBeforeDiscovery: bucketCount(allRows, (row) => row.isMovedBeforeDiscoveryBlocked),
    tokenAgeOutsideConfiguredRange: bucketCount(allRows, (row) => blockerIncludes(row, 'token age outside configured range')),
    sellQuoteUnknownOrNoRoute: bucketCount(allRows, (row) => blockerIncludes(row, 'sell quote unknown') || blockerIncludes(row, 'sell quote unavailable'))
  };

  return {
    maxAgeMinutes,
    totalFreshCandidatesEvaluated: allRows.length,
    eligibleFreshCount: eligibleFreshRows.length,
    paperBuysWouldOpenCount: Math.max(0, Math.min(
      eligibleFreshRows.length,
      config.maxDailyPaperBuys - db.getDailyPaperBuyCount(),
      config.maxOpenPositions - db.getOpenPositionCount('PAPER')
    )),
    buckets,
    topClosestFreshCandidates,
    suggestedNextBottleneck: deriveSuggestedNextBottleneck(allRows),
    finalSafetyStatus: 'Real trading remains locked.',
    noPaperBuysOpened: true
  };
}

export function renderFreshRejectionAnalytics(db: AppDb, config: AppConfig, options: { maxAgeMinutes?: number; limit?: number } = {}): string {
  const report = buildFreshRejectionAnalytics(db, config, options);
  const lines: string[] = [];
  lines.push('Fresh Rejection Analytics');
  lines.push(`Window: <= ${report.maxAgeMinutes} minutes`);
  lines.push(`Fresh evaluated: ${report.totalFreshCandidatesEvaluated} | Eligible fresh: ${report.eligibleFreshCount} | paperBuysWouldOpenCount=${report.paperBuysWouldOpenCount}`);
  lines.push('');
  lines.push('Buckets');
  lines.push(`- missing liquidity: ${report.buckets.missingLiquidity}`);
  lines.push(`- liquidity below MIN_LIQUIDITY_USD: ${report.buckets.liquidityBelowMinimum}`);
  lines.push(`- missing slippage: ${report.buckets.missingSlippage}`);
  lines.push(`- slippage above MAX_SLIPPAGE_BPS: ${report.buckets.slippageAboveMax}`);
  lines.push(`- holder RISKY: ${report.buckets.holderRisky}`);
  lines.push(`- holder UNKNOWN: ${report.buckets.holderUnknown}`);
  lines.push(`- safety score below paper minimum: ${report.buckets.safetyScoreBelowPaperMinimum}`);
  lines.push(`- total score below paper minimum: ${report.buckets.totalScoreBelowPaperMinimum}`);
  lines.push(`- momentum score below paper minimum: ${report.buckets.momentumScoreBelowPaperMinimum}`);
  lines.push(`- watch priority below paper requirement: ${report.buckets.watchPriorityBelowPaperRequirement}`);
  lines.push(`- NOISE_PROFILE count: ${report.buckets.noiseProfileCount}`);
  lines.push(`- LOW_WATCH_PRIORITY count: ${report.buckets.lowWatchPriorityCount}`);
  lines.push(`- AVOID_WATCH_PRIORITY count: ${report.buckets.avoidWatchPriorityCount}`);
  lines.push(`- entry data stale: ${report.buckets.entryDataStale}`);
  lines.push(`- moved before discovery: ${report.buckets.movedBeforeDiscovery}`);
  lines.push(`- token age outside configured range: ${report.buckets.tokenAgeOutsideConfiguredRange}`);
  lines.push(`- sell quote unknown/no route: ${report.buckets.sellQuoteUnknownOrNoRoute}`);
  lines.push('');
  lines.push('Top 5 closest fresh candidates');
  if (report.topClosestFreshCandidates.length === 0) {
    lines.push('- none');
  } else {
    for (const row of report.topClosestFreshCandidates) {
      lines.push(`- ${row.symbol} (#${row.tokenId}) ${shortenMint(row.mint)} age=${fmtNum(row.dataAgeMinutes)}m liq=${fmtMoney(row.liquidityUsd)} score=${fmtNum(row.totalScore)} topBlocker=${row.topBlocker}`);
      lines.push(`  watch=${row.watchProfile ?? '-'}/${row.watchPriority ?? '-'} quote=${row.sellQuoteAvailable ?? '-'} slip=${row.estimatedSlippageBps ?? '-'} holder=${row.holderConcentration ?? '-'} source=${row.sourceUrl ?? '-'}`);
    }
  }
  lines.push('');
  lines.push(`Suggested next bottleneck: ${report.suggestedNextBottleneck}`);
  lines.push('No paper buys opened.');
  lines.push(report.finalSafetyStatus);
  return lines.join('\n');
}
