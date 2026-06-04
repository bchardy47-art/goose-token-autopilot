import type { AppDb } from '../db';
import type { AppConfig } from '../types';
import { buildEarlySignalFilterReport, type FilterLabel, type FilteredCandidate } from './earlySignalFilter';

const DEFAULT_WINDOW_HOURS = 72;
const DEFAULT_TOP = 10;
const MIN_SAMPLE = 5;

function avg(vs: number[]): number | null {
  return vs.length === 0 ? null : vs.reduce((a, b) => a + b, 0) / vs.length;
}

function median(vs: number[]): number | null {
  if (vs.length === 0) return null;
  const s = [...vs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function fmtPct(v: number | null | undefined, d = 1): string {
  if (v == null) return '-';
  return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
}

function fmtRate(v: number | null | undefined): string {
  if (v == null) return '-';
  return `${(v * 100).toFixed(0)}%`;
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '-';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function fmtAge(minutes: number): string {
  return minutes < 60 ? `${minutes.toFixed(0)}m` : `${(minutes / 60).toFixed(1)}h`;
}

interface LabelStats {
  label: FilterLabel;
  count: number;
  withData: number;
  withPeak: number;
  avgCurrentReturn: number | null;
  medCurrentReturn: number | null;
  avgPeakReturn: number | null;
  medPeakReturn: number | null;
  hitRate25: number | null;
  hitRate50: number | null;
  hitRate100: number | null;
  dumpRate: number | null;
  collapseRate: number | null;
  avgAgeHours: number | null;
}

function computeStats(label: FilterLabel, candidates: FilteredCandidate[]): LabelStats {
  const withCurrent = candidates.filter((c) => c.row.currentReturnPct != null);
  const withPeak = candidates.filter((c) => c.row.bestGainPct != null);

  const currentReturns = withCurrent.map((c) => c.row.currentReturnPct!);
  const peakReturns = withPeak.map((c) => c.row.bestGainPct!);

  const hitRate25 = withPeak.length > 0
    ? withPeak.filter((c) => c.row.bestGainPct! >= 25).length / withPeak.length
    : null;
  const hitRate50 = withPeak.length > 0
    ? withPeak.filter((c) => c.row.bestGainPct! >= 50).length / withPeak.length
    : null;
  const hitRate100 = withPeak.length > 0
    ? withPeak.filter((c) => c.row.bestGainPct! >= 100).length / withPeak.length
    : null;

  const dumpRate = withCurrent.length > 0
    ? withCurrent.filter((c) => c.row.currentReturnPct! <= -50).length / withCurrent.length
    : null;

  // Candidates that peaked >= +25% but current return fell >= 50pp below that peak
  const withBoth = candidates.filter((c) => c.row.bestGainPct != null && c.row.currentReturnPct != null);
  const collapseRate = withBoth.length > 0
    ? withBoth.filter((c) => c.row.bestGainPct! >= 25 && (c.row.bestGainPct! - c.row.currentReturnPct!) >= 50).length / withBoth.length
    : null;

  const avgAgeMins = avg(candidates.map((c) => c.row.ageMinutes));

  return {
    label,
    count: candidates.length,
    withData: withCurrent.length,
    withPeak: withPeak.length,
    avgCurrentReturn: avg(currentReturns),
    medCurrentReturn: median(currentReturns),
    avgPeakReturn: avg(peakReturns),
    medPeakReturn: median(peakReturns),
    hitRate25,
    hitRate50,
    hitRate100,
    dumpRate,
    collapseRate,
    avgAgeHours: avgAgeMins != null ? avgAgeMins / 60 : null,
  };
}

export interface DumpRiskForwardValidationReport {
  windowHours: number;
  criteria: { minBsr: number; maxMovedPct: number; minPc5mPct: number };
  totalChecked: number;
  profileMatchStats: LabelStats;
  noMatchStats: LabelStats;
  dumpRiskStats: LabelStats;
  sampleTooSmall: boolean;
  bestProfileMatchExamples: FilteredCandidate[];
  worstProfileMatchExamples: FilteredCandidate[];
  confirmedDumpExamples: FilteredCandidate[];
  falsePosExamples: FilteredCandidate[];
}

export function buildDumpRiskForwardValidationReport(
  db: AppDb,
  config: AppConfig,
  options: {
    limit?: number;
    windowHours?: number;
    minBsr?: number;
    maxMoved?: number;
    minPc5m?: number;
    top?: number;
  } = {}
): DumpRiskForwardValidationReport {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const top = options.top ?? DEFAULT_TOP;

  const filterReport = buildEarlySignalFilterReport(db, config, {
    ...options,
    windowHours,
    limit: 9999,
  });

  const profileMatches = filterReport.candidates.filter((c) => c.label === 'PROFILE_MATCH');
  const noMatches = filterReport.candidates.filter((c) => c.label === 'NO_MATCH');
  const dumpRisks = filterReport.candidates.filter((c) => c.label === 'DUMP_RISK');

  const pmStats = computeStats('PROFILE_MATCH', profileMatches);
  const nmStats = computeStats('NO_MATCH', noMatches);
  const drStats = computeStats('DUMP_RISK', dumpRisks);

  const bestPM = [...profileMatches]
    .filter((c) => c.row.bestGainPct != null)
    .sort((a, b) => (b.row.bestGainPct ?? -Infinity) - (a.row.bestGainPct ?? -Infinity))
    .slice(0, top);
  const bestPMIds = new Set(bestPM.map((c) => c.row.candidateId));
  const worstPM = [...profileMatches]
    .filter((c) => !bestPMIds.has(c.row.candidateId))
    .filter((c) => c.row.currentReturnPct != null || c.row.worstDrawdownPct != null)
    .sort((a, b) => {
      const aV = a.row.currentReturnPct ?? a.row.worstDrawdownPct ?? 0;
      const bV = b.row.currentReturnPct ?? b.row.worstDrawdownPct ?? 0;
      return aV - bV;
    })
    .slice(0, top);

  // Confirmed dumps: DUMP_RISK with worst current return
  const confirmedDumps = [...dumpRisks]
    .filter((c) => c.row.currentReturnPct != null)
    .sort((a, b) => (a.row.currentReturnPct ?? 0) - (b.row.currentReturnPct ?? 0))
    .slice(0, top);
  const confirmedIds = new Set(confirmedDumps.map((c) => c.row.candidateId));

  // False positives: DUMP_RISK that survived or gained
  const falsePosExamples = [...dumpRisks]
    .filter((c) => !confirmedIds.has(c.row.candidateId) && c.row.bestGainPct != null)
    .sort((a, b) => (b.row.bestGainPct ?? -Infinity) - (a.row.bestGainPct ?? -Infinity))
    .slice(0, top);

  return {
    windowHours,
    criteria: {
      minBsr: filterReport.criteria.minBsr,
      maxMovedPct: filterReport.criteria.maxMovedPct,
      minPc5mPct: filterReport.criteria.minPc5mPct,
    },
    totalChecked: filterReport.totalChecked,
    profileMatchStats: pmStats,
    noMatchStats: nmStats,
    dumpRiskStats: drStats,
    sampleTooSmall: pmStats.count < MIN_SAMPLE,
    bestProfileMatchExamples: bestPM,
    worstProfileMatchExamples: worstPM,
    confirmedDumpExamples: confirmedDumps,
    falsePosExamples,
  };
}

export function renderDumpRiskForwardValidationReport(
  db: AppDb,
  config: AppConfig,
  options: {
    limit?: number;
    windowHours?: number;
    minBsr?: number;
    maxMoved?: number;
    minPc5m?: number;
    top?: number;
  } = {}
): string {
  const r = buildDumpRiskForwardValidationReport(db, config, options);
  const lines: string[] = [];
  const sep = '─'.repeat(60);
  const thin = '·'.repeat(60);

  const pm = r.profileMatchStats;
  const nm = r.noMatchStats;
  const dr = r.dumpRiskStats;

  // ── 1. Report Purpose ──────────────────────────────────────────────
  lines.push('Dump Risk Forward Validation');
  lines.push(sep);
  lines.push('1. Report Purpose');
  lines.push('   Tests whether dump-risk labels predicted later outcomes for');
  lines.push('   tokens discovered in the watch window.');
  lines.push('');
  lines.push('   Labels: PROFILE_MATCH | NO_MATCH | DUMP_RISK');
  lines.push(`   Window: last ${r.windowHours}h`);
  lines.push(`   Criteria: BSR >= ${r.criteria.minBsr} | moved_before < ${r.criteria.maxMovedPct}% | pc5m >= ${r.criteria.minPc5mPct}% | freeze SAFE`);
  lines.push(`   Total candidates: ${r.totalChecked}`);
  lines.push(`   PROFILE_MATCH: ${pm.count}  |  NO_MATCH: ${nm.count}  |  DUMP_RISK: ${dr.count}`);
  lines.push('');
  lines.push('   DATA PROVENANCE:');
  lines.push('   This is a retrospective forward-validation proxy, NOT true forward');
  lines.push('   validation. Labels are computed post-hoc from stored historical data.');
  lines.push('   The label logic was NOT applied at discovery time. Outcomes (prices,');
  lines.push('   peak gains) are from the same stored dataset. Treat all numbers as');
  lines.push('   directional only — do not use to justify trading decisions.');
  if (r.sampleTooSmall) {
    lines.push('');
    lines.push(`   ⚠  PROFILE_MATCH sample: ${pm.count} — below minimum of ${MIN_SAMPLE} for conclusions.`);
    lines.push('   ⚠  Numbers below are indicative only.');
  }
  lines.push('');

  // ── 2. Label Outcome Summary ────────────────────────────────────────
  lines.push('2. Label Outcome Summary');
  lines.push('');
  const colL = 'Label'.padEnd(16);
  const colN = 'n'.padStart(4);
  const colD = 'data'.padStart(5);
  const colAC = 'avgCur'.padStart(8);
  const colMC = 'medCur'.padStart(8);
  const colAP = 'avgPk'.padStart(7);
  const colMP = 'medPk'.padStart(7);
  const col25 = '+25%'.padStart(5);
  const col50 = '+50%'.padStart(5);
  const col100 = '+100%'.padStart(6);
  const colDump = 'dump%'.padStart(6);
  const colColl = 'coll%'.padStart(6);
  lines.push(`   ${colL}${colN}${colD}${colAC}${colMC}${colAP}${colMP}${col25}${col50}${col100}${colDump}${colColl}`);
  lines.push(`   ${'─'.repeat(85)}`);
  for (const s of [pm, nm, dr]) {
    lines.push(
      `   ${s.label.padEnd(16)}${String(s.count).padStart(4)}${String(s.withData).padStart(5)}` +
      `${fmtPct(s.avgCurrentReturn, 0).padStart(8)}${fmtPct(s.medCurrentReturn, 0).padStart(8)}` +
      `${fmtPct(s.avgPeakReturn, 0).padStart(7)}${fmtPct(s.medPeakReturn, 0).padStart(7)}` +
      `${fmtRate(s.hitRate25).padStart(5)}${fmtRate(s.hitRate50).padStart(5)}${fmtRate(s.hitRate100).padStart(6)}` +
      `${fmtRate(s.dumpRate).padStart(6)}${fmtRate(s.collapseRate).padStart(6)}`
    );
  }
  lines.push('');
  lines.push('   data   = candidates with a current return recorded');
  lines.push('   avgCur = average current return vs entry price');
  lines.push('   medCur = median current return');
  lines.push('   avgPk  = average best recorded peak gain');
  lines.push('   medPk  = median best peak gain');
  lines.push('   +25/50/100% = fraction that ever recorded that peak gain');
  lines.push('   dump%  = fraction with current return <= -50%');
  lines.push('   coll%  = peaked >= +25% then fell >= 50pp (pump-dump signature)');
  lines.push('');

  // ── 3. Did DUMP_RISK Predict Collapse? ─────────────────────────────
  lines.push('3. Did DUMP_RISK Predict Collapse?');
  lines.push('');
  if (dr.count === 0) {
    lines.push('   No DUMP_RISK candidates in this window.');
  } else {
    lines.push(`   DUMP_RISK: ${dr.count} candidates (${dr.withData} with price data)`);
    if (dr.avgAgeHours != null) {
      lines.push(`   Average time since discovery: ${dr.avgAgeHours.toFixed(1)}h`);
    }
    lines.push('');
    if (dr.dumpRate != null || nm.dumpRate != null || pm.dumpRate != null) {
      lines.push('   Collapse rate (current <= -50%):');
      lines.push(`     DUMP_RISK:     ${fmtRate(dr.dumpRate)}`);
      lines.push(`     NO_MATCH:      ${fmtRate(nm.dumpRate)}`);
      lines.push(`     PROFILE_MATCH: ${fmtRate(pm.dumpRate)}`);
    } else {
      lines.push('   Not enough price data to compare collapse rates across labels.');
    }
    lines.push('');
    if (dr.avgCurrentReturn != null) {
      lines.push(`   Average current return: DUMP_RISK ${fmtPct(dr.avgCurrentReturn, 0)}`);
      if (nm.avgCurrentReturn != null) {
        lines.push(`   vs NO_MATCH baseline: ${fmtPct(nm.avgCurrentReturn, 0)}`);
      }
    }
    if (dr.collapseRate != null) {
      lines.push(`   Pump-dump collapse rate: ${fmtRate(dr.collapseRate)} (peaked >= +25% then gave it back)`);
    }
    lines.push('');
    lines.push('   ⚠  False-positive warning:');
    lines.push('   DUMP_RISK is a research flag, not a trading block. Some flagged');
    lines.push('   candidates may have survived or gained. The flag uses entry-time');
    lines.push('   signals that are imperfect separators of dump vs early-runner patterns.');
    if (dr.withData < dr.count) {
      lines.push(`   ${dr.count - dr.withData} of ${dr.count} DUMP_RISK have no stored price. Run token:watch-refresh.`);
    }
  }
  lines.push('');

  // ── 4. Did PROFILE_MATCH Predict Winners? ──────────────────────────
  lines.push('4. Did PROFILE_MATCH Predict Winners?');
  lines.push('');
  if (pm.count === 0) {
    lines.push('   No PROFILE_MATCH candidates in this window.');
    lines.push('   Widen --window-hours or accumulate more watch cycles.');
  } else if (r.sampleTooSmall) {
    lines.push(`   ⚠  Only ${pm.count} PROFILE_MATCH candidate${pm.count === 1 ? '' : 's'} — sample too small to draw conclusions.`);
    lines.push('   Minimum recommended: 5 candidates. Accumulate more before interpreting.');
    if (pm.withData > 0 || pm.withPeak > 0) {
      lines.push('');
      lines.push('   Current numbers (indicative only):');
      if (pm.avgCurrentReturn != null) lines.push(`     avg current return: ${fmtPct(pm.avgCurrentReturn, 0)}`);
      if (pm.avgPeakReturn != null) lines.push(`     avg peak gain:      ${fmtPct(pm.avgPeakReturn, 0)}`);
      if (pm.hitRate50 != null) lines.push(`     +50% hit rate:      ${fmtRate(pm.hitRate50)}`);
    }
  } else {
    lines.push(`   PROFILE_MATCH: ${pm.count} candidates (${pm.withData} with current return, ${pm.withPeak} with peak)`);
    if (pm.avgAgeHours != null) {
      lines.push(`   Average time since discovery: ${pm.avgAgeHours.toFixed(1)}h`);
    }
    lines.push('');
    if (pm.hitRate25 != null) lines.push(`   +25% peak hit rate:  ${fmtRate(pm.hitRate25)}`);
    if (pm.hitRate50 != null) lines.push(`   +50% peak hit rate:  ${fmtRate(pm.hitRate50)}`);
    if (pm.hitRate100 != null) lines.push(`   +100% peak hit rate: ${fmtRate(pm.hitRate100)}`);
    lines.push('');
    if (pm.hitRate50 != null && nm.hitRate50 != null) {
      const ratio = nm.hitRate50 > 0 ? (pm.hitRate50 / nm.hitRate50).toFixed(1) : 'N/A';
      lines.push(`   vs NO_MATCH +50% rate: ${fmtRate(nm.hitRate50)} (${ratio}x ratio)`);
    }
    if (pm.avgPeakReturn != null && nm.avgPeakReturn != null) {
      const ratio = nm.avgPeakReturn !== 0 ? (pm.avgPeakReturn / nm.avgPeakReturn).toFixed(1) : '-';
      lines.push(`   Avg peak: PROFILE_MATCH ${fmtPct(pm.avgPeakReturn, 0)} vs NO_MATCH ${fmtPct(nm.avgPeakReturn, 0)} (${ratio}x)`);
    }
    if (pm.dumpRate != null && nm.dumpRate != null) {
      lines.push(`   Dump rate: PROFILE_MATCH ${fmtRate(pm.dumpRate)} vs NO_MATCH ${fmtRate(nm.dumpRate)}`);
    }
    lines.push('');
    lines.push('   ⚠  Caveats:');
    lines.push('   - Labels applied post-hoc — not observable at entry time.');
    lines.push('   - Short window. Results may not generalize to different market conditions.');
    if (pm.withData < pm.count) {
      lines.push(`   - ${pm.count - pm.withData} of ${pm.count} PROFILE_MATCH have no current price. Run token:watch-refresh.`);
    }
  }
  lines.push('');

  // ── 5. Best / Worst Examples ───────────────────────────────────────
  lines.push('5. Best / Worst Examples');
  lines.push('');

  const exHdr = `   ${'Symbol'.padEnd(16)} ${'Label'.padEnd(14)} ${'curRet'.padStart(8)} ${'peak'.padStart(7)} ${'worst'.padStart(7)} ${'age'.padStart(6)} ${'liq'.padStart(7)}`;

  function exRow(c: FilteredCandidate): string {
    return (
      `   ${c.row.symbol.padEnd(16)} ${c.label.padEnd(14)} ` +
      `${fmtPct(c.row.currentReturnPct, 0).padStart(8)} ` +
      `${fmtPct(c.row.bestGainPct, 0).padStart(7)} ` +
      `${fmtPct(c.row.worstDrawdownPct, 0).padStart(7)} ` +
      `${fmtAge(c.row.ageMinutes).padStart(6)} ` +
      `${fmtMoney(c.row.liquidityUsd).padStart(7)}`
    );
  }

  let hasExamples = false;

  if (r.bestProfileMatchExamples.length > 0) {
    hasExamples = true;
    lines.push('   PROFILE_MATCH — best (by peak gain):');
    lines.push(exHdr);
    for (const c of r.bestProfileMatchExamples) {
      lines.push(exRow(c));
      if (c.matchReasons.length > 0) lines.push(`     why: ${c.matchReasons.join(' | ')}`);
    }
    lines.push('');
  }

  if (r.worstProfileMatchExamples.length > 0) {
    hasExamples = true;
    lines.push('   PROFILE_MATCH — worst (by current return):');
    lines.push(exHdr);
    for (const c of r.worstProfileMatchExamples) {
      lines.push(exRow(c));
    }
    lines.push('');
  }

  if (r.confirmedDumpExamples.length > 0) {
    hasExamples = true;
    lines.push('   DUMP_RISK — confirmed collapses (worst current return first):');
    lines.push(exHdr);
    for (const c of r.confirmedDumpExamples) {
      lines.push(exRow(c));
      if (c.dumpReasons.length > 0) lines.push(`     flagged: ${c.dumpReasons.join('; ')}`);
    }
    lines.push('');
  }

  if (r.falsePosExamples.length > 0) {
    hasExamples = true;
    lines.push('   DUMP_RISK — survived or gained (potential false positives):');
    lines.push(exHdr);
    for (const c of r.falsePosExamples) {
      lines.push(exRow(c));
      if (c.dumpReasons.length > 0) lines.push(`     flagged: ${c.dumpReasons.join('; ')}`);
    }
    lines.push('');
  }

  if (!hasExamples) {
    lines.push('   No candidates with stored price data yet.');
    lines.push('   Run token:watch-refresh to populate current prices, then re-run.');
    lines.push('');
  }

  // ── 6. Decision Note ───────────────────────────────────────────────
  lines.push('6. Decision Note');
  lines.push('');
  lines.push('   What the data supports:');

  if (r.totalChecked === 0) {
    lines.push('   - No candidates in this window. Cannot support any conclusion.');
  } else if (pm.withData < MIN_SAMPLE && dr.withData < MIN_SAMPLE) {
    lines.push('   - Insufficient price data across all labels.');
    lines.push('   - Cannot support or refute any hypothesis yet.');
    lines.push('   - Run token:watch-refresh, then re-run this report.');
  } else {
    const drBetter = dr.dumpRate != null && nm.dumpRate != null && dr.dumpRate > nm.dumpRate;
    if (drBetter) {
      lines.push('   - DUMP_RISK candidates showed higher collapse rate than NO_MATCH.');
      lines.push('     Consistent with the label catching dump patterns. Not proof.');
    } else if (dr.dumpRate != null && nm.dumpRate != null) {
      lines.push('   - DUMP_RISK did not show a clearly higher collapse rate than NO_MATCH.');
      lines.push('     Signal may be weak or the sample is too small to see separation.');
    } else {
      lines.push('   - Not enough price data to compare DUMP_RISK vs NO_MATCH collapse rates.');
    }
    const pmBetter = pm.avgPeakReturn != null && nm.avgPeakReturn != null && pm.avgPeakReturn > nm.avgPeakReturn;
    if (pmBetter) {
      lines.push('   - PROFILE_MATCH showed higher average peak gain than NO_MATCH. Directional evidence.');
    } else if (pm.avgPeakReturn != null && nm.avgPeakReturn != null) {
      lines.push('   - PROFILE_MATCH did not clearly outperform NO_MATCH on peak gain.');
    }
  }

  lines.push('');
  lines.push('   What the data does NOT support:');
  lines.push('   - True forward validation: labels applied after the fact to stored data.');
  lines.push('   - Any trading decision: no gates, thresholds, or execution changed.');
  lines.push('   - Generalizability: short window, specific market conditions.');
  if (r.sampleTooSmall) {
    lines.push(`   - PROFILE_MATCH confidence: only ${pm.count} sample${pm.count === 1 ? '' : 's'} (minimum is ${MIN_SAMPLE}).`);
  }
  lines.push('');

  // ── 7. Safety Footer ───────────────────────────────────────────────
  lines.push(thin);
  lines.push('7. Safety');
  lines.push('   Report only.');
  lines.push('   No trading behavior changed.');
  lines.push('   Hypothesis not active.');
  lines.push('   Requires more forward validation before paper or real trading.');
  lines.push('   Real trading remains locked.');

  return lines.join('\n');
}
