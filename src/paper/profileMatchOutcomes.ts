import type { AppDb } from '../db';
import type { AppConfig } from '../types';
import { buildEarlySignalFilterReport, type FilterLabel, type FilteredCandidate } from './earlySignalFilter';

const DEFAULT_WINDOW_HOURS = 72;
const MIN_SAMPLE_FOR_CONCLUSIONS = 5;

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null) return '-';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

function fmtRate(v: number | null | undefined): string {
  if (v == null) return '-';
  return `${(v * 100).toFixed(0)}%`;
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  return v == null ? '-' : v.toFixed(digits);
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '-';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

export interface LabelStats {
  label: FilterLabel;
  count: number;
  withCurrentReturn: number;
  withPeakReturn: number;
  avgCurrentReturnPct: number | null;
  medianCurrentReturnPct: number | null;
  avgPeakReturnPct: number | null;
  hitRate25pct: number | null;
  hitRate50pct: number | null;
  hitRate100pct: number | null;
  dumpRate: number | null;
  bestExamples: FilteredCandidate[];
  worstExamples: FilteredCandidate[];
}

export interface ProfileMatchOutcomesReport {
  windowHours: number;
  criteria: {
    minBsr: number;
    maxMovedPct: number;
    minPc5mPct: number;
  };
  totalChecked: number;
  profileMatchCount: number;
  noMatchCount: number;
  dumpRiskCount: number;
  labelStats: LabelStats[];
  sampleTooSmall: boolean;
  smallSampleNote: string | null;
}

function computeLabelStats(label: FilterLabel, candidates: FilteredCandidate[]): LabelStats {
  const currentReturns = candidates
    .map((c) => c.row.currentReturnPct)
    .filter((v): v is number => v != null);
  const peakReturns = candidates
    .map((c) => c.row.bestGainPct)
    .filter((v): v is number => v != null);

  const withPeak = candidates.filter((c) => c.row.bestGainPct != null);
  const hitRate25 =
    withPeak.length > 0
      ? withPeak.filter((c) => (c.row.bestGainPct ?? -Infinity) >= 25).length / withPeak.length
      : null;
  const hitRate50 =
    withPeak.length > 0
      ? withPeak.filter((c) => (c.row.bestGainPct ?? -Infinity) >= 50).length / withPeak.length
      : null;
  const hitRate100 =
    withPeak.length > 0
      ? withPeak.filter((c) => (c.row.bestGainPct ?? -Infinity) >= 100).length / withPeak.length
      : null;

  const withCurrent = candidates.filter((c) => c.row.currentReturnPct != null);
  const dumpRt =
    withCurrent.length > 0
      ? withCurrent.filter((c) => (c.row.currentReturnPct ?? 0) <= -50).length / withCurrent.length
      : null;

  const bestExamples = [...candidates]
    .filter((c) => c.row.bestGainPct != null)
    .sort((a, b) => (b.row.bestGainPct ?? -Infinity) - (a.row.bestGainPct ?? -Infinity))
    .slice(0, 5);

  const bestIds = new Set(bestExamples.map((c) => c.row.candidateId));
  const worstExamples = [...candidates]
    .filter((c) => !bestIds.has(c.row.candidateId))
    .filter((c) => c.row.currentReturnPct != null || c.row.worstDrawdownPct != null)
    .sort((a, b) => {
      const aVal = a.row.currentReturnPct ?? a.row.worstDrawdownPct ?? 0;
      const bVal = b.row.currentReturnPct ?? b.row.worstDrawdownPct ?? 0;
      return aVal - bVal;
    })
    .slice(0, 5);

  return {
    label,
    count: candidates.length,
    withCurrentReturn: currentReturns.length,
    withPeakReturn: peakReturns.length,
    avgCurrentReturnPct: avg(currentReturns),
    medianCurrentReturnPct: median(currentReturns),
    avgPeakReturnPct: avg(peakReturns),
    hitRate25pct: hitRate25,
    hitRate50pct: hitRate50,
    hitRate100pct: hitRate100,
    dumpRate: dumpRt,
    bestExamples,
    worstExamples
  };
}

export function buildProfileMatchOutcomesReport(
  db: AppDb,
  config: AppConfig,
  options: {
    limit?: number;
    windowHours?: number;
    minBsr?: number;
    maxMoved?: number;
    minPc5m?: number;
  } = {}
): ProfileMatchOutcomesReport {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;

  // Use a large internal limit to classify ALL candidates in the window for accurate stats.
  // The user-supplied limit controls display behavior, not classification coverage.
  const filterReport = buildEarlySignalFilterReport(db, config, {
    ...options,
    windowHours,
    limit: 9999
  });

  const profileMatches = filterReport.candidates.filter((c) => c.label === 'PROFILE_MATCH');
  const noMatches = filterReport.candidates.filter((c) => c.label === 'NO_MATCH');
  const dumpRisks = filterReport.candidates.filter((c) => c.label === 'DUMP_RISK');

  const labelStats: LabelStats[] = [
    computeLabelStats('PROFILE_MATCH', profileMatches),
    computeLabelStats('NO_MATCH', noMatches),
    computeLabelStats('DUMP_RISK', dumpRisks)
  ];

  const pmCount = profileMatches.length;
  const sampleTooSmall = pmCount < MIN_SAMPLE_FOR_CONCLUSIONS;
  const smallSampleNote = sampleTooSmall
    ? `Only ${pmCount} PROFILE_MATCH candidate${pmCount === 1 ? '' : 's'} in the ${windowHours}h window — sample too small to draw conclusions. Accumulate more watch cycles before interpreting these numbers.`
    : null;

  return {
    windowHours,
    criteria: {
      minBsr: filterReport.criteria.minBsr,
      maxMovedPct: filterReport.criteria.maxMovedPct,
      minPc5mPct: filterReport.criteria.minPc5mPct
    },
    totalChecked: filterReport.totalChecked,
    profileMatchCount: filterReport.profileMatchCount,
    noMatchCount: filterReport.noMatchCount,
    dumpRiskCount: filterReport.dumpRiskCount,
    labelStats,
    sampleTooSmall,
    smallSampleNote
  };
}

function renderCandidateRow(c: FilteredCandidate, tag: string): string[] {
  const age =
    c.row.ageMinutes < 60
      ? `${c.row.ageMinutes.toFixed(0)}m ago`
      : `${(c.row.ageMinutes / 60).toFixed(1)}h ago`;
  const lines: string[] = [];
  lines.push(`   [${tag}] ${c.row.symbol} (#${c.row.tokenId}) — ${age}`);
  lines.push(
    `     current=${fmtPct(c.row.currentReturnPct, 0)} | peak=${fmtPct(c.row.bestGainPct, 0)} | worst=${fmtPct(c.row.worstDrawdownPct, 0)}`
  );
  lines.push(
    `     BSR=${fmtNum(c.row.bsr)} | pc5m=${fmtPct(c.row.priceChange5mPct, 0)} | moved_b4=${fmtPct(c.row.movedBeforePct, 0)} | liq=${fmtMoney(c.row.liquidityUsd)}`
  );
  return lines;
}

export function renderProfileMatchOutcomesReport(
  db: AppDb,
  config: AppConfig,
  options: {
    limit?: number;
    windowHours?: number;
    minBsr?: number;
    maxMoved?: number;
    minPc5m?: number;
  } = {}
): string {
  const r = buildProfileMatchOutcomesReport(db, config, options);
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  // 1. Profile Match Outcome Tracker
  lines.push('Profile Match Outcome Tracker');
  lines.push(sep);
  lines.push('1. Summary');
  lines.push(`   Window: last ${r.windowHours}h`);
  lines.push(
    `   Criteria: moved_before < ${r.criteria.maxMovedPct}% | BSR >= ${r.criteria.minBsr} | pc5m >= ${r.criteria.minPc5mPct}% | freeze SAFE`
  );
  lines.push(`   Total candidates examined: ${r.totalChecked}`);
  lines.push(
    `   PROFILE_MATCH: ${r.profileMatchCount} | NO_MATCH: ${r.noMatchCount} | DUMP_RISK: ${r.dumpRiskCount}`
  );
  if (r.smallSampleNote) {
    lines.push('');
    lines.push(`   ⚠  ${r.smallSampleNote}`);
  }
  lines.push('');

  // 2. Label Performance Summary
  lines.push('2. Label Performance Summary');
  const colLabel = 'Label'.padEnd(16);
  const colN = 'n'.padStart(4);
  const colData = 'data'.padStart(5);
  const colAvgCur = 'avgCur'.padStart(8);
  const colMedCur = 'medCur'.padStart(8);
  const colAvgPeak = 'avgPeak'.padStart(8);
  const col25 = '+25%'.padStart(5);
  const col50 = '+50%'.padStart(5);
  const col100 = '+100%'.padStart(6);
  const colDump = 'dump%'.padStart(6);
  lines.push(`   ${colLabel}${colN}${colData}${colAvgCur}${colMedCur}${colAvgPeak}${col25}${col50}${col100}${colDump}`);
  for (const ls of r.labelStats) {
    lines.push(
      `   ${ls.label.padEnd(16)}${String(ls.count).padStart(4)}${String(ls.withCurrentReturn).padStart(5)}${fmtPct(ls.avgCurrentReturnPct, 0).padStart(8)}${fmtPct(ls.medianCurrentReturnPct, 0).padStart(8)}${fmtPct(ls.avgPeakReturnPct, 0).padStart(8)}${fmtRate(ls.hitRate25pct).padStart(5)}${fmtRate(ls.hitRate50pct).padStart(5)}${fmtRate(ls.hitRate100pct).padStart(6)}${fmtRate(ls.dumpRate).padStart(6)}`
    );
  }
  lines.push('   data    = candidates with a current return recorded (latest_price_usd available)');
  lines.push('   avgCur  = average current return vs entry (stored prices only)');
  lines.push('   medCur  = median current return vs entry');
  lines.push('   avgPeak = average best recorded peak gain (best_gain_pct in DB)');
  lines.push('   +25/50/100% = fraction that ever hit those peak gains');
  lines.push('   dump%   = fraction with current return <= -50%');
  lines.push('');

  // 3. PROFILE_MATCH Examples
  const pmStats = r.labelStats.find((ls) => ls.label === 'PROFILE_MATCH')!;
  lines.push('3. PROFILE_MATCH Examples');
  if (pmStats.count === 0) {
    lines.push('   No PROFILE_MATCH candidates in this window.');
  } else if (pmStats.bestExamples.length === 0 && pmStats.worstExamples.length === 0) {
    lines.push(`   ${pmStats.count} PROFILE_MATCH candidate${pmStats.count === 1 ? '' : 's'} — no stored return data yet.`);
    lines.push('   Run token:watch-refresh to populate latest prices.');
  } else {
    if (pmStats.bestExamples.length > 0) {
      lines.push('   Best (by peak gain):');
      for (const c of pmStats.bestExamples) {
        for (const l of renderCandidateRow(c, 'BEST')) lines.push(l);
        if (c.matchReasons.length > 0) {
          lines.push(`     why matched: ${c.matchReasons.join(' | ')}`);
        }
      }
    }
    if (pmStats.worstExamples.length > 0) {
      lines.push('   Worst (by current return):');
      for (const c of pmStats.worstExamples) {
        for (const l of renderCandidateRow(c, 'WORST')) lines.push(l);
        if (c.matchReasons.length > 0) {
          lines.push(`     why matched: ${c.matchReasons.join(' | ')}`);
        }
      }
    }
  }
  lines.push('');

  // 4. DUMP_RISK Examples
  const drStats = r.labelStats.find((ls) => ls.label === 'DUMP_RISK')!;
  lines.push('4. DUMP_RISK Examples');
  if (drStats.count === 0) {
    lines.push('   No DUMP_RISK candidates in this window.');
  } else {
    const allDr = [...drStats.bestExamples, ...drStats.worstExamples].filter(
      (c, i, arr) => arr.findIndex((x) => x.row.candidateId === c.row.candidateId) === i
    );
    const drExamples = allDr
      .sort((a, b) => (a.row.worstDrawdownPct ?? 0) - (b.row.worstDrawdownPct ?? 0))
      .slice(0, 5);
    if (drExamples.length > 0) {
      for (const c of drExamples) {
        const age =
          c.row.ageMinutes < 60
            ? `${c.row.ageMinutes.toFixed(0)}m ago`
            : `${(c.row.ageMinutes / 60).toFixed(1)}h ago`;
        lines.push(`   [DUMP_RISK] ${c.row.symbol} (#${c.row.tokenId}) — ${age}`);
        lines.push(
          `     current=${fmtPct(c.row.currentReturnPct, 0)} | worst=${fmtPct(c.row.worstDrawdownPct, 0)} | freeze=${c.row.freezeAuthority ?? '-'} | mint=${c.row.mintAuthority ?? '-'}`
        );
        lines.push(`     flagged: ${c.dumpReasons.join('; ')}`);
      }
    } else {
      lines.push(`   ${drStats.count} DUMP_RISK candidates — no stored return data yet.`);
    }
  }
  lines.push('');

  // 5. What This Means
  lines.push('5. What This Means');
  if (r.sampleTooSmall) {
    lines.push('   Sample size is too small to interpret results.');
    lines.push(`   ${r.profileMatchCount} PROFILE_MATCH token${r.profileMatchCount === 1 ? '' : 's'} in the last ${r.windowHours}h.`);
    lines.push(`   Minimum recommended for conclusions: ${MIN_SAMPLE_FOR_CONCLUSIONS} PROFILE_MATCH candidates.`);
    lines.push('   Next steps:');
    lines.push('   - Continue running watch cycles to accumulate more candidates.');
    lines.push('   - Run token:watch-refresh to populate current prices for existing candidates.');
    lines.push('   - Re-run this report after more data is available.');
  } else {
    const pmS = r.labelStats.find((ls) => ls.label === 'PROFILE_MATCH')!;
    const nmS = r.labelStats.find((ls) => ls.label === 'NO_MATCH')!;
    lines.push('   Hypothesis being tested:');
    lines.push('   "Tokens passing the early signal filter outperform the NO_MATCH baseline"');
    lines.push('');
    if (pmS.avgPeakReturnPct != null && nmS.avgPeakReturnPct != null) {
      const ratio =
        nmS.avgPeakReturnPct !== 0
          ? (pmS.avgPeakReturnPct / nmS.avgPeakReturnPct).toFixed(1)
          : '-';
      lines.push(
        `   Peak gain: PROFILE_MATCH avg ${fmtPct(pmS.avgPeakReturnPct, 0)} vs NO_MATCH ${fmtPct(nmS.avgPeakReturnPct, 0)} (${ratio}x)`
      );
    }
    if (pmS.hitRate50pct != null && nmS.hitRate50pct != null) {
      lines.push(
        `   +50% hit rate: PROFILE_MATCH ${fmtRate(pmS.hitRate50pct)} vs NO_MATCH ${fmtRate(nmS.hitRate50pct)}`
      );
    }
    if (pmS.dumpRate != null && nmS.dumpRate != null) {
      lines.push(
        `   Dump rate (current <= -50%): PROFILE_MATCH ${fmtRate(pmS.dumpRate)} vs NO_MATCH ${fmtRate(nmS.dumpRate)}`
      );
    }
    lines.push('');
    lines.push('   Caveats:');
    lines.push('   - Results based on stored DB data only. No live prices fetched.');
    lines.push('   - INSTANT_DUMP can look like PROFILE_MATCH at discovery then collapse. Watch dump rate.');
    lines.push('   - Short data window. Results may not generalize to other market conditions.');
    if (pmS.withCurrentReturn < pmS.count) {
      lines.push(
        `   - ${pmS.count - pmS.withCurrentReturn} of ${pmS.count} PROFILE_MATCH candidates have no current price. Run token:watch-refresh.`
      );
    }
  }
  lines.push('');

  // 6. Safety Footer
  lines.push(sep);
  lines.push('6. Safety');
  lines.push('   Report only.');
  lines.push('   No trading behavior changed.');
  lines.push('   Hypothesis not active.');
  lines.push('   Requires more forward validation before paper or real trading.');

  return lines.join('\n');
}
