import type { AppDb } from '../db';
import type { AppConfig, PaperEligibilityDiagnosticRow } from '../types';
import { buildPaperEligibilityDiagnostics, rankPaperEligibilityRows } from './autoPaper';

const DEFAULT_TOO_EARLY_WINDOW_MINUTES = 15;
const DEFAULT_TOO_EARLY_LIMIT = 10;

export type TooEarlyRecommendation = 'RECHECK_SOON' | 'WATCH_BUT_BLOCKED' | 'IGNORE';

function shortenMint(mint: string): string {
  return mint.length <= 12 ? mint : `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function fmtNum(value: number | null | undefined, digits = 1): string {
  return value == null ? '-' : value.toFixed(digits);
}

function fmtMoney(value: number | null | undefined): string {
  return value == null ? '-' : `$${value.toFixed(0)}`;
}

function ageBlockersWithoutAge(row: PaperEligibilityDiagnosticRow): string[] {
  return row.blockers.filter((blocker) => blocker !== 'token age outside configured range');
}

function classifyRecommendation(row: PaperEligibilityDiagnosticRow): TooEarlyRecommendation {
  const nonAgeBlockers = ageBlockersWithoutAge(row);
  if (
    row.watchPriority === 'AVOID_WATCH_PRIORITY' ||
    row.watchProfile === 'NOISE_PROFILE' ||
    nonAgeBlockers.some((blocker) => /latest liquidity missing|slippage missing|sell quote unknown|sell quote unavailable/i.test(blocker))
  ) {
    return 'IGNORE';
  }
  if (nonAgeBlockers.length === 0 && row.holderConcentration === 'SAFE' && row.sellQuoteAvailable === 'YES') {
    return 'RECHECK_SOON';
  }
  return 'WATCH_BUT_BLOCKED';
}

export function buildTooEarlyWatchReport(db: AppDb, config: AppConfig, options: { maxAgeMinutes?: number; limit?: number } = {}): {
  maxAgeMinutes: number;
  limit: number;
  totalTooEarlyCandidates: number;
  cleanTooEarlyCount: number;
  riskyHolderCount: number;
  lowWatchPriorityCount: number;
  missingLiquidityOrSlippageCount: number;
  nextRecheckMinutes: number | null;
  candidates: Array<PaperEligibilityDiagnosticRow & { recommendation: TooEarlyRecommendation; minutesUntilEligibleAge: number; blockersBesidesAge: string[] }>;
  finalSafetyStatus: string;
  noPaperBuysOpened: true;
} {
  const maxAgeMinutes = options.maxAgeMinutes ?? DEFAULT_TOO_EARLY_WINDOW_MINUTES;
  const limit = options.limit ?? DEFAULT_TOO_EARLY_LIMIT;
  const diagnostics = buildPaperEligibilityDiagnostics(db, config) as any;
  const allCandidates = ((diagnostics.allCandidates as PaperEligibilityDiagnosticRow[] | undefined) ?? []).filter((row) => {
    const ageMinutes = row.dataAgeMinutes ?? Number.POSITIVE_INFINITY;
    const tokenAgeBlock = row.blockers.includes('token age outside configured range');
    return tokenAgeBlock && ageMinutes <= maxAgeMinutes;
  });

  const candidates = [...allCandidates]
    .sort((a, b) => rankPaperEligibilityRows(a, b, config))
    .slice(0, limit)
    .map((row) => ({
      ...row,
      recommendation: classifyRecommendation(row),
      minutesUntilEligibleAge: Math.max(0, Number((config.minTokenAgeMin - (row.dataAgeMinutes ?? config.minTokenAgeMin)).toFixed(1))),
      blockersBesidesAge: ageBlockersWithoutAge(row)
    }));

  const recheckMinutes = candidates
    .filter((row) => row.recommendation === 'RECHECK_SOON')
    .map((row) => row.minutesUntilEligibleAge);

  return {
    maxAgeMinutes,
    limit,
    totalTooEarlyCandidates: allCandidates.length,
    cleanTooEarlyCount: candidates.filter((row) => row.recommendation === 'RECHECK_SOON').length,
    riskyHolderCount: candidates.filter((row) => row.holderConcentration === 'RISKY').length,
    lowWatchPriorityCount: candidates.filter((row) => row.watchPriority === 'LOW_WATCH_PRIORITY' || row.watchPriority === 'AVOID_WATCH_PRIORITY').length,
    missingLiquidityOrSlippageCount: candidates.filter((row) => row.blockers.some((blocker) => /latest liquidity missing|slippage missing/i.test(blocker))).length,
    nextRecheckMinutes: recheckMinutes.length > 0 ? Math.min(...recheckMinutes) : null,
    candidates,
    finalSafetyStatus: 'Real trading remains locked.',
    noPaperBuysOpened: true
  };
}

export function renderTooEarlyWatchReport(db: AppDb, config: AppConfig, options: { maxAgeMinutes?: number; limit?: number } = {}): string {
  const report = buildTooEarlyWatchReport(db, config, options);
  const lines: string[] = [];
  lines.push('Too-Early Watch Lane');
  lines.push(`Window: <= ${report.maxAgeMinutes} minutes | Limit: ${report.limit}`);
  lines.push(`Too-early candidates: ${report.totalTooEarlyCandidates} | Clean-too-early: ${report.cleanTooEarlyCount} | Risky holder: ${report.riskyHolderCount} | Low watch priority: ${report.lowWatchPriorityCount} | Missing liquidity/slippage: ${report.missingLiquidityOrSlippageCount}`);
  lines.push(`Next recheck suggestion: ${report.nextRecheckMinutes != null ? `rerun in ${report.nextRecheckMinutes.toFixed(1)} minutes` : 'no immediate recheck candidates'}`);
  lines.push('');

  if (report.candidates.length === 0) {
    lines.push('- no too-early candidates in current window');
  } else {
    for (const row of report.candidates) {
      lines.push(`${row.symbol} (#${row.tokenId}) ${shortenMint(row.mint)} age=${fmtNum(row.dataAgeMinutes)}m untilEligible=${fmtNum(row.minutesUntilEligibleAge)}m liq=${fmtMoney(row.liquidityUsd)} quote=${row.sellQuoteAvailable ?? '-'} slip=${row.estimatedSlippageBps ?? '-'}bps`);
      lines.push(`  holder=${row.holderConcentration ?? '-'} watch=${row.watchProfile ?? '-'}/${row.watchPriority ?? '-'} recommendation=${row.recommendation}`);
      lines.push(`  blockersBesidesAge=${row.blockersBesidesAge.length > 0 ? row.blockersBesidesAge.join('; ') : 'none'}`);
      lines.push(`  warnings=${row.warnings.length > 0 ? row.warnings.join('; ') : 'none'}`);
      lines.push(`  source=${row.sourceUrl ?? '-'}`);
    }
  }

  lines.push('');
  lines.push('No paper buys opened.');
  lines.push(report.finalSafetyStatus);
  return lines.join('\n');
}
