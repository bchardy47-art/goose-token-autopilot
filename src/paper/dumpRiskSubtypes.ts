import type { AppDb } from '../db';
import type { AppConfig } from '../types';
import { buildEarlySignalFilterReport, type FilteredCandidate } from './earlySignalFilter';

const DEFAULT_WINDOW_HOURS = 72;
const DEFAULT_TOP = 10;

export type DumpRiskSubtype =
  | 'COLLAPSE_PATTERN'
  | 'UNSAFE_AUTHORITY'
  | 'EXTREME_SPIKE'
  | 'MIXED'
  | 'UNKNOWN';

// -- math helpers --

function avg(vs: number[]): number | null {
  return vs.length === 0 ? null : vs.reduce((a, b) => a + b, 0) / vs.length;
}

function median(vs: number[]): number | null {
  if (vs.length === 0) return null;
  const s = [...vs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

// -- format helpers --

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

// -- subtype assignment --
// Reads the dumpReasons strings set by classifyCandidate in earlySignalFilter.ts.
// Three orthogonal flags; MIXED when more than one applies.

function assignSubtype(c: FilteredCandidate): DumpRiskSubtype {
  const reasons = c.dumpReasons;
  const hasUnsafeAuth = reasons.some(
    (r) => r.includes('freeze_authority UNSAFE') || r.includes('mint_authority UNSAFE')
  );
  const hasCollapse = reasons.some((r) => r.startsWith('price collapsed to'));
  const hasExtremeSpike = reasons.some(
    (r) => r.includes('extreme 5m spike') || r.includes('5m price spike with BSR < 1.0')
  );
  const flagCount = [hasUnsafeAuth, hasCollapse, hasExtremeSpike].filter(Boolean).length;
  if (flagCount >= 2) return 'MIXED';
  if (hasCollapse) return 'COLLAPSE_PATTERN';
  if (hasUnsafeAuth) return 'UNSAFE_AUTHORITY';
  if (hasExtremeSpike) return 'EXTREME_SPIKE';
  return 'UNKNOWN';
}

// -- per-subtype stats --

interface SubtypeStats {
  subtype: DumpRiskSubtype;
  count: number;
  withData: number;
  withPeak: number;
  avgCurrentReturn: number | null;
  medCurrentReturn: number | null;
  avgPeakReturn: number | null;
  hitRate50: number | null;
  hitRate100: number | null;
  dumpRate: number | null;
  falsePosCount: number;
}

function computeSubtypeStats(subtype: DumpRiskSubtype, candidates: FilteredCandidate[]): SubtypeStats {
  const withCurrent = candidates.filter((c) => c.row.currentReturnPct != null);
  const withPeak = candidates.filter((c) => c.row.bestGainPct != null);
  const currentReturns = withCurrent.map((c) => c.row.currentReturnPct!);
  const peakReturns = withPeak.map((c) => c.row.bestGainPct!);

  const hitRate50 =
    withPeak.length > 0
      ? withPeak.filter((c) => c.row.bestGainPct! >= 50).length / withPeak.length
      : null;
  const hitRate100 =
    withPeak.length > 0
      ? withPeak.filter((c) => c.row.bestGainPct! >= 100).length / withPeak.length
      : null;
  const dumpRate =
    withCurrent.length > 0
      ? withCurrent.filter((c) => c.row.currentReturnPct! <= -50).length / withCurrent.length
      : null;
  const falsePosCount = candidates.filter(
    (c) => (c.row.currentReturnPct ?? 0) > 100 || (c.row.bestGainPct ?? 0) > 100
  ).length;

  return {
    subtype,
    count: candidates.length,
    withData: withCurrent.length,
    withPeak: withPeak.length,
    avgCurrentReturn: avg(currentReturns),
    medCurrentReturn: median(currentReturns),
    avgPeakReturn: avg(peakReturns),
    hitRate50,
    hitRate100,
    dumpRate,
    falsePosCount,
  };
}

export interface SubtypedCandidate {
  candidate: FilteredCandidate;
  subtype: DumpRiskSubtype;
}

export interface DumpRiskSubtypesReport {
  windowHours: number;
  totalDumpRisk: number;
  subtypeCounts: Record<DumpRiskSubtype, number>;
  subtypeStats: SubtypeStats[];
  topCollapsed: SubtypedCandidate[];
  topUnsafeWinners: SubtypedCandidate[];
  mixedExamples: SubtypedCandidate[];
}

const SUBTYPE_ORDER: DumpRiskSubtype[] = [
  'COLLAPSE_PATTERN',
  'UNSAFE_AUTHORITY',
  'EXTREME_SPIKE',
  'MIXED',
  'UNKNOWN',
];

export function buildDumpRiskSubtypesReport(
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
): DumpRiskSubtypesReport {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const top = options.top ?? DEFAULT_TOP;

  const filterReport = buildEarlySignalFilterReport(db, config, {
    ...options,
    windowHours,
    limit: 9999,
  });

  const dumpRisks = filterReport.candidates.filter((c) => c.label === 'DUMP_RISK');

  const subtypedAll: SubtypedCandidate[] = dumpRisks.map((c) => ({
    candidate: c,
    subtype: assignSubtype(c),
  }));

  // Group by subtype
  const groups = new Map<DumpRiskSubtype, FilteredCandidate[]>();
  for (const st of SUBTYPE_ORDER) groups.set(st, []);
  for (const sc of subtypedAll) groups.get(sc.subtype)!.push(sc.candidate);

  const subtypeCounts = Object.fromEntries(
    SUBTYPE_ORDER.map((st) => [st, groups.get(st)!.length])
  ) as Record<DumpRiskSubtype, number>;

  const subtypeStats: SubtypeStats[] = SUBTYPE_ORDER.map((st) =>
    computeSubtypeStats(st, groups.get(st)!)
  );

  // Top collapsed: worst current return across all subtypes
  const topCollapsed = [...subtypedAll]
    .filter((sc) => sc.candidate.row.currentReturnPct != null)
    .sort((a, b) => (a.candidate.row.currentReturnPct ?? 0) - (b.candidate.row.currentReturnPct ?? 0))
    .slice(0, top);

  // Unsafe-authority sorted by best peak (descending) — surface the winners
  const topUnsafeWinners = (groups.get('UNSAFE_AUTHORITY') ?? [])
    .map((c) => ({ candidate: c, subtype: 'UNSAFE_AUTHORITY' as DumpRiskSubtype }))
    .sort((a, b) => (b.candidate.row.bestGainPct ?? -Infinity) - (a.candidate.row.bestGainPct ?? -Infinity))
    .slice(0, top);

  const mixedExamples = (groups.get('MIXED') ?? [])
    .map((c) => ({ candidate: c, subtype: 'MIXED' as DumpRiskSubtype }))
    .slice(0, top);

  return {
    windowHours,
    totalDumpRisk: dumpRisks.length,
    subtypeCounts,
    subtypeStats,
    topCollapsed,
    topUnsafeWinners,
    mixedExamples,
  };
}

export function renderDumpRiskSubtypesReport(
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
  const r = buildDumpRiskSubtypesReport(db, config, options);
  const lines: string[] = [];
  const sep = '─'.repeat(60);
  const thin = '·'.repeat(60);

  const stMap = new Map(r.subtypeStats.map((s) => [s.subtype, s]));
  const cpSt = stMap.get('COLLAPSE_PATTERN')!;
  const uaSt = stMap.get('UNSAFE_AUTHORITY')!;
  const esSt = stMap.get('EXTREME_SPIKE')!;

  // ── 1. Header ──────────────────────────────────────────────────────
  lines.push('Dump Risk Subtypes');
  lines.push(sep);
  lines.push('1. Dump Risk Subtypes');
  lines.push(`   Total DUMP_RISK candidates: ${r.totalDumpRisk}`);
  lines.push(`   Window: last ${r.windowHours}h`);
  lines.push('');
  lines.push('   Count by subtype:');
  for (const st of SUBTYPE_ORDER) {
    if (r.subtypeCounts[st] === 0) continue;
    lines.push(`     ${st.padEnd(24)} ${r.subtypeCounts[st]}`);
  }
  lines.push('');
  lines.push('   Subtype definitions:');
  lines.push('   COLLAPSE_PATTERN  — price already < 30% of entry at classification time');
  lines.push('   UNSAFE_AUTHORITY  — freeze or mint authority UNSAFE (only flag, not collapsed yet)');
  lines.push('   EXTREME_SPIKE     — extreme 5m spike with weak BSR or spike + worst_drawdown > -50%');
  lines.push('   MIXED             — two or more subtype flags triggered simultaneously');
  lines.push('   UNKNOWN           — DUMP_RISK flagged but no pattern matched above');
  lines.push('');
  lines.push('   DATA NOTE: Labels applied retrospectively to stored data, not at discovery time.');
  lines.push('   Treat all numbers as directional only.');
  lines.push('');

  // ── 2. Subtype Outcome Summary ──────────────────────────────────────
  lines.push('2. Subtype Outcome Summary');
  lines.push('');
  const colST  = 'Subtype'.padEnd(20);
  const colN   = 'n'.padStart(4);
  const colD   = 'data'.padStart(5);
  const colAC  = 'avgCur'.padStart(8);
  const colMC  = 'medCur'.padStart(8);
  const colAP  = 'avgPk'.padStart(7);
  const col50  = '+50%'.padStart(5);
  const col100 = '+100%'.padStart(6);
  const colDmp = 'dump%'.padStart(6);
  const colFP  = 'falsePos'.padStart(9);
  lines.push(`   ${colST}${colN}${colD}${colAC}${colMC}${colAP}${col50}${col100}${colDmp}${colFP}`);
  lines.push(`   ${'─'.repeat(78)}`);
  for (const s of r.subtypeStats) {
    if (s.count === 0) continue;
    lines.push(
      `   ${s.subtype.padEnd(20)}${String(s.count).padStart(4)}${String(s.withData).padStart(5)}` +
      `${fmtPct(s.avgCurrentReturn, 0).padStart(8)}${fmtPct(s.medCurrentReturn, 0).padStart(8)}` +
      `${fmtPct(s.avgPeakReturn, 0).padStart(7)}${fmtRate(s.hitRate50).padStart(5)}` +
      `${fmtRate(s.hitRate100).padStart(6)}${fmtRate(s.dumpRate).padStart(6)}` +
      `${String(s.falsePosCount).padStart(9)}`
    );
  }
  lines.push('');
  lines.push('   data     = candidates with a current return recorded');
  lines.push('   avgCur   = average current return vs entry price');
  lines.push('   medCur   = median current return');
  lines.push('   avgPk    = average best recorded peak gain');
  lines.push('   dump%    = fraction with current return <= -50%');
  lines.push('   falsePos = candidates with current return > +100% OR peak > +100%');
  lines.push('');

  // ── 3. Unsafe Authority Review ──────────────────────────────────────
  lines.push('3. Unsafe Authority Review');
  lines.push('');
  if (uaSt.count === 0) {
    lines.push('   No UNSAFE_AUTHORITY candidates in this window.');
  } else {
    lines.push(`   UNSAFE_AUTHORITY: ${uaSt.count} candidate${uaSt.count === 1 ? '' : 's'}`);
    if (uaSt.avgCurrentReturn != null) lines.push(`   Average current return: ${fmtPct(uaSt.avgCurrentReturn, 0)}`);
    if (uaSt.avgPeakReturn != null)    lines.push(`   Average peak gain:      ${fmtPct(uaSt.avgPeakReturn, 0)}`);
    if (uaSt.dumpRate != null)         lines.push(`   Dump rate (current <= -50%): ${fmtRate(uaSt.dumpRate)}`);
    if (uaSt.falsePosCount > 0) {
      lines.push(`   False positives (gain > +100%): ${uaSt.falsePosCount} of ${uaSt.count}`);
      lines.push('');
      lines.push('   ⚠  Unsafe-authority candidates include tokens that gained massively.');
      lines.push('   ⚠  This subtype CANNOT be treated as a hard blocker yet.');
      lines.push('   ⚠  freeze_authority UNSAFE may indicate rug risk OR a token that has not');
      lines.push('   ⚠  completed safety enrichment. These cases look identical at scan time.');
      lines.push('   ⚠  A hard block on this flag would have excluded the largest winners in');
      lines.push('   ⚠  the current dataset.');
    } else {
      lines.push('   No false positives observed. Sample too small to draw conclusions.');
    }
    if (cpSt.count > 0) {
      lines.push('');
      lines.push(`   vs COLLAPSE_PATTERN (${cpSt.count} candidates):`);
      if (cpSt.avgCurrentReturn != null) lines.push(`     COLLAPSE avg current return: ${fmtPct(cpSt.avgCurrentReturn, 0)}`);
      if (cpSt.dumpRate != null)         lines.push(`     COLLAPSE dump rate:          ${fmtRate(cpSt.dumpRate)}`);
      lines.push(`     COLLAPSE false positives:    ${cpSt.falsePosCount}`);
      lines.push('   COLLAPSE_PATTERN is a much cleaner collapse signal than UNSAFE_AUTHORITY.');
    }
  }
  lines.push('');

  // ── 4. Collapse Pattern Review ──────────────────────────────────────
  lines.push('4. Collapse Pattern Review');
  lines.push('');
  if (cpSt.count === 0) {
    lines.push('   No COLLAPSE_PATTERN candidates in this window.');
  } else {
    lines.push(`   COLLAPSE_PATTERN: ${cpSt.count} candidates (${cpSt.withData} with price data)`);
    if (cpSt.avgCurrentReturn != null) lines.push(`   Average current return: ${fmtPct(cpSt.avgCurrentReturn, 0)}`);
    if (cpSt.medCurrentReturn != null) lines.push(`   Median current return:  ${fmtPct(cpSt.medCurrentReturn, 0)}`);
    if (cpSt.dumpRate != null)         lines.push(`   Dump rate (current <= -50%): ${fmtRate(cpSt.dumpRate)}`);
    lines.push('');
    if (cpSt.falsePosCount === 0) {
      lines.push('   False positives: 0');
      lines.push('   No COLLAPSE_PATTERN candidate gained > +100% in this dataset.');
      lines.push('   This is the cleanest subtype for identifying confirmed collapses.');
      lines.push('   However: this is a post-hoc signal. Price was already down at classification');
      lines.push('   time (< 30% of entry). It confirms a dump happened — it does not predict one.');
      lines.push('   It cannot block an entry because the collapse has already occurred.');
    } else {
      lines.push(`   False positives: ${cpSt.falsePosCount}`);
      lines.push('   Some candidates flagged as COLLAPSE_PATTERN still achieved > +100% gains.');
      lines.push('   Subtype is cleaner than broad DUMP_RISK but not clean enough to hard-block.');
    }
    lines.push('');
    if (esSt.count > 0) {
      lines.push(`   vs EXTREME_SPIKE (${esSt.count} candidates):`);
      if (esSt.avgCurrentReturn != null) lines.push(`     EXTREME_SPIKE avg current: ${fmtPct(esSt.avgCurrentReturn, 0)}`);
      if (esSt.dumpRate != null)         lines.push(`     EXTREME_SPIKE dump rate:   ${fmtRate(esSt.dumpRate)}`);
      lines.push(`     EXTREME_SPIKE false positives: ${esSt.falsePosCount}`);
    }
  }
  lines.push('');

  // ── 5. Candidate Examples ──────────────────────────────────────────
  lines.push('5. Candidate Examples');
  lines.push('');
  const exHdr =
    `   ${'Symbol'.padEnd(16)} ${'Subtype'.padEnd(20)} ${'curRet'.padStart(8)} ` +
    `${'peak'.padStart(7)} ${'worst'.padStart(7)} ${'age'.padStart(6)} ${'liq'.padStart(7)}`;

  function exRow(sc: SubtypedCandidate): string {
    const c = sc.candidate;
    return (
      `   ${c.row.symbol.padEnd(16)} ${sc.subtype.padEnd(20)} ` +
      `${fmtPct(c.row.currentReturnPct, 0).padStart(8)} ` +
      `${fmtPct(c.row.bestGainPct, 0).padStart(7)} ` +
      `${fmtPct(c.row.worstDrawdownPct, 0).padStart(7)} ` +
      `${fmtAge(c.row.ageMinutes).padStart(6)} ` +
      `${fmtMoney(c.row.liquidityUsd).padStart(7)}`
    );
  }

  if (r.topCollapsed.length > 0) {
    lines.push('   Confirmed collapses (worst current return first):');
    lines.push(exHdr);
    for (const sc of r.topCollapsed) {
      lines.push(exRow(sc));
      if (sc.candidate.dumpReasons.length > 0) {
        lines.push(`     flagged: ${sc.candidate.dumpReasons.join('; ')}`);
      }
    }
    lines.push('');
  }

  if (r.topUnsafeWinners.length > 0) {
    lines.push('   Unsafe-authority — sorted by peak gain (surfaces false positives):');
    lines.push(exHdr);
    for (const sc of r.topUnsafeWinners) {
      lines.push(exRow(sc));
      if (sc.candidate.dumpReasons.length > 0) {
        lines.push(`     flagged: ${sc.candidate.dumpReasons.join('; ')}`);
      }
    }
    lines.push('');
  }

  if (r.mixedExamples.length > 0) {
    lines.push('   Mixed subtype examples (multiple flags):');
    lines.push(exHdr);
    for (const sc of r.mixedExamples) {
      lines.push(exRow(sc));
      if (sc.candidate.dumpReasons.length > 0) {
        lines.push(`     flagged: ${sc.candidate.dumpReasons.join('; ')}`);
      }
    }
    lines.push('');
  }

  if (r.topCollapsed.length === 0 && r.topUnsafeWinners.length === 0 && r.mixedExamples.length === 0) {
    lines.push('   No candidates with stored price data. Run token:watch-refresh first.');
    lines.push('');
  }

  // ── 6. Decision Note ──────────────────────────────────────────────
  lines.push('6. Decision Note');
  lines.push('');
  lines.push('   What the subtype split supports:');
  if (r.totalDumpRisk === 0) {
    lines.push('   - No DUMP_RISK candidates in this window. No conclusions possible.');
  } else {
    if (cpSt.count > 0 && cpSt.falsePosCount === 0) {
      lines.push('   - COLLAPSE_PATTERN has zero false positives in this dataset.');
      lines.push('     It is the cleanest subtype, but only confirms a dump already happened.');
      lines.push('     It cannot be used as an entry-time block — it is always post-hoc.');
    }
    if (uaSt.count > 0 && uaSt.falsePosCount > 0) {
      lines.push('   - UNSAFE_AUTHORITY has confirmed false positives (massive winners included).');
      lines.push('     The freeze-unsafe flag correlates with rug risk but also with unenriched');
      lines.push('     tokens that happen to be legitimate. Do not make it a hard block yet.');
    }
    if (esSt.count > 0) {
      lines.push(`   - EXTREME_SPIKE has ${esSt.count} candidate${esSt.count === 1 ? '' : 's'}. ` +
        (esSt.falsePosCount > 0
          ? `${esSt.falsePosCount} false positive${esSt.falsePosCount === 1 ? '' : 's'} — not clean enough to act on.`
          : 'No false positives, but sample too small to conclude.'));
    }
    lines.push('   - Splitting subtypes is useful for future per-subtype forward validation.');
    lines.push('     Accumulate more candidates with each subtype before drawing conclusions.');
  }
  lines.push('');
  lines.push('   What the subtype split does NOT support:');
  lines.push('   - Any subtype becoming an entry gate or hard blocker today.');
  lines.push('   - Trading decisions. No thresholds, gates, or scoring changed.');
  lines.push('   - True forward validation: labels applied after the fact to stored data.');
  lines.push('   - Generalizability: short window, small sample, one market condition.');
  lines.push('');

  // ── 7. Safety Footer ──────────────────────────────────────────────
  lines.push(thin);
  lines.push('7. Safety');
  lines.push('   Report only.');
  lines.push('   No trading behavior changed.');
  lines.push('   Hypothesis not active.');
  lines.push('   Requires true forward validation before paper or real trading.');
  lines.push('   Real trading remains locked.');

  return lines.join('\n');
}
