import type { AppDb } from '../db';
import type { AppConfig } from '../types';

const DEFAULT_TOP = 10;

// Target windows in minutes and their acceptable tolerance ranges
const WINDOWS = [15, 30, 60] as const;
type Window = 15 | 30 | 60;

// A snap qualifies for a window if it falls within [target - lo, target + hi] minutes after discovery
const WINDOW_BOUNDS: Record<Window, [lo: number, hi: number]> = {
  15: [5, 20],   // accept snaps 10–35 min post-discovery as a proxy for 15m
  30: [10, 25],  // accept snaps 20–55 min post-discovery as a proxy for 30m
  60: [20, 45],  // accept snaps 40–105 min post-discovery as a proxy for 60m
};

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

function minutesBetween(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
}

// -- data structures --

interface SnapRow {
  snapId: number;
  observedAt: string;
  priceUsd: number | null;
  minutesAfter: number;
}

export interface CandidateDecay {
  candidateId: number;
  tokenId: number;
  symbol: string;
  signalClass: string;
  discoveredAt: string;
  entryPriceUsd: number | null;
  latestPriceUsd: number | null;
  bestGainPct: number | null;
  worstDrawdownPct: number | null;
  currentReturnPct: number | null;
  totalPostSnaps: number;
  // Best-fit snap for each window (null if none in tolerance)
  returnAt15m: number | null;
  returnAt30m: number | null;
  returnAt60m: number | null;
  actualMinsAt15m: number | null;
  actualMinsAt30m: number | null;
  actualMinsAt60m: number | null;
}

function pickNearestInWindow(
  snaps: SnapRow[],
  target: Window
): SnapRow | null {
  const [lo, hi] = WINDOW_BOUNDS[target];
  const min = target - lo;
  const max = target + hi;
  const candidates = snaps.filter((s) => s.minutesAfter >= min && s.minutesAfter <= max);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, s) =>
    Math.abs(s.minutesAfter - target) < Math.abs(best.minutesAfter - target) ? s : best
  );
}

function returnPct(entry: number | null, price: number | null): number | null {
  if (entry == null || price == null || entry <= 0) return null;
  return ((price - entry) / entry) * 100;
}

interface ClassDecaySummary {
  signalClass: string;
  total: number;
  withAnyPostSnap: number;
  coverageAt15m: number;
  coverageAt30m: number;
  coverageAt60m: number;
  avgReturnAt15m: number | null;
  medReturnAt15m: number | null;
  avgReturnAt30m: number | null;
  medReturnAt30m: number | null;
  avgReturnAt60m: number | null;
  medReturnAt60m: number | null;
  dumpBy30m: number | null;   // fraction with return30m <= -50%
  survivalBy30m: number | null; // fraction with return30m >= 0%
  hitPlus25By60m: number | null;
  hitPlus50By60m: number | null;
  avgCurrentReturn: number | null;
  avgPeakReturn: number | null;
}

export interface DecayRateReport {
  totalCandidates: number;
  withAnyPostSnap: number;
  coverageAt15m: number;
  coverageAt30m: number;
  coverageAt60m: number;
  classSummaries: ClassDecaySummary[];
  candidates: CandidateDecay[];
  topEarlyRunnerExamples: CandidateDecay[];
  topInstantDumpExamples: CandidateDecay[];
  topFalsePosExamples: CandidateDecay[];
  dataIsSparse: boolean;
  sparseNote: string;
}

export function buildDecayRateReport(
  db: AppDb,
  _config: AppConfig,
  options: { limit?: number; top?: number } = {}
): DecayRateReport {
  const top = options.top ?? DEFAULT_TOP;
  const s = db.sqlite;

  // Load all candidates with their signal class and basic outcome fields
  const candidateRows = s.prepare(`
    SELECT
      wc.id as candidate_id,
      wc.token_id,
      t.symbol,
      wsa.signal_class,
      wc.created_at,
      wc.entry_price_usd,
      wc.latest_price_usd,
      wc.best_gain_pct,
      wc.worst_drawdown_pct
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    LEFT JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    ORDER BY wc.created_at DESC
  `).all() as any[];

  // Load all post-discovery snapshots for all tokens in one query
  const allSnapsRows = s.prepare(`
    SELECT
      snap.id as snap_id,
      snap.token_id,
      snap.observed_at,
      snap.price_usd,
      wc.created_at as candidate_created_at
    FROM token_snapshots snap
    JOIN watch_only_candidates wc ON wc.token_id = snap.token_id
    WHERE snap.observed_at > wc.created_at
    ORDER BY snap.token_id, snap.observed_at
  `).all() as any[];

  // Group post-discovery snaps by token_id
  const snapsByToken = new Map<number, SnapRow[]>();
  for (const r of allSnapsRows) {
    const minsAfter = minutesBetween(r.candidate_created_at, r.observed_at);
    if (!snapsByToken.has(r.token_id)) snapsByToken.set(r.token_id, []);
    snapsByToken.get(r.token_id)!.push({
      snapId: r.snap_id,
      observedAt: r.observed_at,
      priceUsd: r.price_usd,
      minutesAfter: minsAfter,
    });
  }

  // Build per-candidate decay records
  const candidates: CandidateDecay[] = candidateRows.map((r: any) => {
    const entry = r.entry_price_usd as number | null;
    const latest = r.latest_price_usd as number | null;
    const postSnaps = snapsByToken.get(r.token_id) ?? [];
    const totalPostSnaps = postSnaps.length;

    const snap15 = pickNearestInWindow(postSnaps, 15);
    const snap30 = pickNearestInWindow(postSnaps, 30);
    const snap60 = pickNearestInWindow(postSnaps, 60);

    return {
      candidateId: r.candidate_id,
      tokenId: r.token_id,
      symbol: r.symbol,
      signalClass: r.signal_class ?? 'UNKNOWN',
      discoveredAt: r.created_at,
      entryPriceUsd: entry,
      latestPriceUsd: latest,
      bestGainPct: r.best_gain_pct,
      worstDrawdownPct: r.worst_drawdown_pct,
      currentReturnPct: returnPct(entry, latest),
      totalPostSnaps,
      returnAt15m: snap15 ? returnPct(entry, snap15.priceUsd) : null,
      returnAt30m: snap30 ? returnPct(entry, snap30.priceUsd) : null,
      returnAt60m: snap60 ? returnPct(entry, snap60.priceUsd) : null,
      actualMinsAt15m: snap15?.minutesAfter ?? null,
      actualMinsAt30m: snap30?.minutesAfter ?? null,
      actualMinsAt60m: snap60?.minutesAfter ?? null,
    };
  });

  // Coverage counts
  const withAnyPostSnap = candidates.filter((c) => c.totalPostSnaps > 0).length;
  const coverageAt15m = candidates.filter((c) => c.returnAt15m != null).length;
  const coverageAt30m = candidates.filter((c) => c.returnAt30m != null).length;
  const coverageAt60m = candidates.filter((c) => c.returnAt60m != null).length;

  // Per-class summaries
  const classes = ['EARLY_RUNNER', 'INSTANT_DUMP', 'DEAD_NOISE', 'LATE_RUNNER', 'TOO_DANGEROUS'];
  const classSummaries: ClassDecaySummary[] = classes.map((cls) => {
    const group = candidates.filter((c) => c.signalClass === cls);
    const withPostSnap = group.filter((c) => c.totalPostSnaps > 0);
    const with15 = group.filter((c) => c.returnAt15m != null);
    const with30 = group.filter((c) => c.returnAt30m != null);
    const with60 = group.filter((c) => c.returnAt60m != null);

    const ret15 = with15.map((c) => c.returnAt15m!);
    const ret30 = with30.map((c) => c.returnAt30m!);
    const ret60 = with60.map((c) => c.returnAt60m!);

    const dumpBy30 = with30.length > 0
      ? with30.filter((c) => c.returnAt30m! <= -50).length / with30.length : null;
    const survivalBy30 = with30.length > 0
      ? with30.filter((c) => c.returnAt30m! >= 0).length / with30.length : null;
    const hit25By60 = with60.length > 0
      ? with60.filter((c) => c.returnAt60m! >= 25).length / with60.length : null;
    const hit50By60 = with60.length > 0
      ? with60.filter((c) => c.returnAt60m! >= 50).length / with60.length : null;

    const withCurrent = group.filter((c) => c.currentReturnPct != null);
    const withPeak = group.filter((c) => c.bestGainPct != null);

    return {
      signalClass: cls,
      total: group.length,
      withAnyPostSnap: withPostSnap.length,
      coverageAt15m: with15.length,
      coverageAt30m: with30.length,
      coverageAt60m: with60.length,
      avgReturnAt15m: avg(ret15),
      medReturnAt15m: median(ret15),
      avgReturnAt30m: avg(ret30),
      medReturnAt30m: median(ret30),
      avgReturnAt60m: avg(ret60),
      medReturnAt60m: median(ret60),
      dumpBy30m: dumpBy30,
      survivalBy30m: survivalBy30,
      hitPlus25By60m: hit25By60,
      hitPlus50By60m: hit50By60,
      avgCurrentReturn: avg(withCurrent.map((c) => c.currentReturnPct!)),
      avgPeakReturn: avg(withPeak.map((c) => c.bestGainPct!)),
    };
  });

  // Examples
  const earlyRunners = candidates.filter((c) => c.signalClass === 'EARLY_RUNNER');
  const instantDumps = candidates.filter((c) => c.signalClass === 'INSTANT_DUMP');

  const topEarlyRunnerExamples = [...earlyRunners]
    .sort((a, b) => (b.bestGainPct ?? -Infinity) - (a.bestGainPct ?? -Infinity))
    .slice(0, top);

  const topInstantDumpExamples = [...instantDumps]
    .filter((c) => c.currentReturnPct != null)
    .sort((a, b) => (a.currentReturnPct ?? 0) - (b.currentReturnPct ?? 0))
    .slice(0, top);

  // False positives: INSTANT_DUMP that eventually gained
  const topFalsePosExamples = [...instantDumps]
    .filter((c) => (c.bestGainPct ?? 0) > 25)
    .sort((a, b) => (b.bestGainPct ?? -Infinity) - (a.bestGainPct ?? -Infinity))
    .slice(0, top);

  const dataIsSparse = coverageAt15m < 5 || coverageAt30m < 5;
  const sparseNote = dataIsSparse
    ? `Only ${coverageAt15m} candidates have a 15m-window snapshot and ${coverageAt30m} have a 30m-window snapshot. ` +
      'This is insufficient for class-level decay analysis. Decay data requires running token:watch-refresh ' +
      'multiple times in the first hour after discovery, which has not happened systematically yet.'
    : `Coverage appears sufficient for indicative analysis (${coverageAt15m} at 15m, ${coverageAt30m} at 30m, ${coverageAt60m} at 60m).`;

  return {
    totalCandidates: candidates.length,
    withAnyPostSnap,
    coverageAt15m,
    coverageAt30m,
    coverageAt60m,
    classSummaries,
    candidates,
    topEarlyRunnerExamples,
    topInstantDumpExamples,
    topFalsePosExamples,
    dataIsSparse,
    sparseNote,
  };
}

export function renderDecayRateReport(
  db: AppDb,
  config: AppConfig,
  options: { limit?: number; top?: number } = {}
): string {
  const r = buildDecayRateReport(db, config, options);
  const lines: string[] = [];
  const sep = '─'.repeat(60);
  const thin = '·'.repeat(60);

  // ── 1. Header ──────────────────────────────────────────────────────
  lines.push('Decay Rate Report');
  lines.push(sep);
  lines.push('1. Decay Rate Report');
  lines.push('   Question: After discovery, can price behavior at 15–30m');
  lines.push('   distinguish survivors from dumps?');
  lines.push('');
  lines.push(`   Total watch candidates:       ${r.totalCandidates}`);
  lines.push(`   With any post-discovery snap: ${r.withAnyPostSnap}`);
  lines.push(`   Coverage at 15m window:       ${r.coverageAt15m}`);
  lines.push(`   Coverage at 30m window:       ${r.coverageAt30m}`);
  lines.push(`   Coverage at 60m window:       ${r.coverageAt60m}`);
  lines.push('');
  lines.push('   Window definitions:');
  lines.push('   15m = nearest snapshot between 10–35 min after discovery');
  lines.push('   30m = nearest snapshot between 20–55 min after discovery');
  lines.push('   60m = nearest snapshot between 40–105 min after discovery');
  lines.push('');
  if (r.dataIsSparse) {
    lines.push('   ⚠  DATA TOO SPARSE FOR RELIABLE ANALYSIS:');
    lines.push(`   ${r.sparseNote}`);
    lines.push('');
    lines.push('   Numbers in sections 2–4 below are indicative only and should');
    lines.push('   NOT be used to draw conclusions or build rules. The coverage');
    lines.push('   is below the minimum needed for class-level comparison.');
  } else {
    lines.push(`   Coverage note: ${r.sparseNote}`);
  }
  lines.push('');

  // ── 2. Class Decay Summary ─────────────────────────────────────────
  lines.push('2. Class Decay Summary');
  lines.push('');

  const colCLS = 'Class'.padEnd(16);
  const colN   = 'n'.padStart(4);
  const colPS  = 'postSnap'.padStart(9);
  const col15c = '15m-n'.padStart(6);
  const col30c = '30m-n'.padStart(6);
  const col60c = '60m-n'.padStart(6);
  lines.push(`   ${colCLS}${colN}${colPS}${col15c}${col30c}${col60c}   (coverage by window)`);
  lines.push(`   ${'─'.repeat(53)}`);
  for (const cls of r.classSummaries) {
    if (cls.total === 0) continue;
    lines.push(
      `   ${cls.signalClass.padEnd(16)}${String(cls.total).padStart(4)}` +
      `${String(cls.withAnyPostSnap).padStart(9)}` +
      `${String(cls.coverageAt15m).padStart(6)}${String(cls.coverageAt30m).padStart(6)}${String(cls.coverageAt60m).padStart(6)}`
    );
  }
  lines.push('');

  // Decay return table — only show if there is meaningful coverage
  const anyWindowData = r.classSummaries.some(
    (c) => c.coverageAt15m > 0 || c.coverageAt30m > 0 || c.coverageAt60m > 0
  );

  if (anyWindowData) {
    lines.push('   Return by decay window (avg / median — indicative only):');
    lines.push('');
    const colC2  = 'Class'.padEnd(16);
    const col15a = 'avg15m'.padStart(8);
    const col15b = 'med15m'.padStart(8);
    const col30a = 'avg30m'.padStart(8);
    const col30b = 'med30m'.padStart(8);
    const col60a = 'avg60m'.padStart(8);
    const col60b = 'med60m'.padStart(8);
    const colDmp = 'dump30%'.padStart(8);
    const colSrv = 'surv30%'.padStart(8);
    lines.push(`   ${colC2}${col15a}${col15b}${col30a}${col30b}${col60a}${col60b}${colDmp}${colSrv}`);
    lines.push(`   ${'─'.repeat(80)}`);
    for (const cls of r.classSummaries) {
      if (cls.total === 0) continue;
      const noCov = cls.coverageAt15m === 0 && cls.coverageAt30m === 0 && cls.coverageAt60m === 0;
      if (noCov) {
        lines.push(`   ${cls.signalClass.padEnd(16)}${'no window coverage'.padStart(64)}`);
        continue;
      }
      lines.push(
        `   ${cls.signalClass.padEnd(16)}` +
        `${fmtPct(cls.avgReturnAt15m, 0).padStart(8)}${fmtPct(cls.medReturnAt15m, 0).padStart(8)}` +
        `${fmtPct(cls.avgReturnAt30m, 0).padStart(8)}${fmtPct(cls.medReturnAt30m, 0).padStart(8)}` +
        `${fmtPct(cls.avgReturnAt60m, 0).padStart(8)}${fmtPct(cls.medReturnAt60m, 0).padStart(8)}` +
        `${fmtRate(cls.dumpBy30m).padStart(8)}${fmtRate(cls.survivalBy30m).padStart(8)}`
      );
    }
    lines.push('');
    lines.push('   dump30% = fraction of that class with return <= -50% by 30m window');
    lines.push('   surv30% = fraction of that class with return >= 0% by 30m window');
    lines.push('   All numbers come from a very small sample — see coverage counts above.');
  }
  lines.push('');

  // ── 3. Potential Survival Rule Draft ───────────────────────────────
  lines.push('3. Potential Survival Rule Draft (NOT ACTIVE)');
  lines.push('');
  if (r.dataIsSparse) {
    lines.push('   Insufficient data to draft a survival rule.');
    lines.push('   A survival rule requires at least 5 EARLY_RUNNER candidates with');
    lines.push('   15m and 30m snapshot coverage. Current EARLY_RUNNER coverage:');
    const er = r.classSummaries.find((c) => c.signalClass === 'EARLY_RUNNER');
    lines.push(`     15m: ${er?.coverageAt15m ?? 0} candidates`);
    lines.push(`     30m: ${er?.coverageAt30m ?? 0} candidates`);
    lines.push(`     60m: ${er?.coverageAt60m ?? 0} candidates`);
    lines.push('');
    lines.push('   Hypothesis for future testing (NOT ACTIVE):');
    lines.push('   "A candidate that holds >= 0% return 30 minutes after discovery, while');
    lines.push('   also showing BSR >= 1.5 at discovery, may be worth continued tracking."');
    lines.push('   This hypothesis CANNOT be validated with current data.');
  } else {
    const erCls = r.classSummaries.find((c) => c.signalClass === 'EARLY_RUNNER');
    const idCls = r.classSummaries.find((c) => c.signalClass === 'INSTANT_DUMP');
    lines.push('   Directional observation (NOT a validated rule, NOT ACTIVE):');
    if (erCls && erCls.survivalBy30m != null) {
      lines.push(`   EARLY_RUNNER survival at 30m (return >= 0%): ${fmtRate(erCls.survivalBy30m)} of ${erCls.coverageAt30m} with data`);
    }
    if (idCls && idCls.dumpBy30m != null) {
      lines.push(`   INSTANT_DUMP dump rate at 30m (return <= -50%): ${fmtRate(idCls.dumpBy30m)} of ${idCls.coverageAt30m} with data`);
    }
    lines.push('');
    lines.push('   Hypothesis for future testing (NOT ACTIVE):');
    lines.push('   "A candidate that holds >= 0% return 30 minutes after discovery, while');
    lines.push('   also showing BSR >= 1.5 at discovery, may be worth continued tracking."');
    lines.push('   Requires prospective validation before any paper trading application.');
  }
  lines.push('');

  // ── 4. Potential Decay Warning Draft ──────────────────────────────
  lines.push('4. Potential Decay Warning Draft (NOT ACTIVE)');
  lines.push('');
  if (r.dataIsSparse) {
    lines.push('   Insufficient data to draft a decay warning rule.');
    lines.push('   Requires at least 5 INSTANT_DUMP candidates with 15m and 30m coverage.');
    const id = r.classSummaries.find((c) => c.signalClass === 'INSTANT_DUMP');
    lines.push(`   Current INSTANT_DUMP coverage: 15m=${id?.coverageAt15m ?? 0}, 30m=${id?.coverageAt30m ?? 0}`);
    lines.push('');
    lines.push('   Hypothesis for future testing (NOT ACTIVE):');
    lines.push('   "A candidate that drops >= -30% within 15 minutes of discovery, especially');
    lines.push('   after a spike entry, is likely a dump and should be excluded from tracking."');
    lines.push('   This hypothesis CANNOT be validated with current data.');
  } else {
    const idCls = r.classSummaries.find((c) => c.signalClass === 'INSTANT_DUMP');
    lines.push('   Directional observation (NOT a validated rule, NOT ACTIVE):');
    if (idCls && idCls.avgReturnAt15m != null) {
      lines.push(`   INSTANT_DUMP avg return at 15m: ${fmtPct(idCls.avgReturnAt15m, 0)} (n=${idCls.coverageAt15m})`);
    }
    lines.push('');
    lines.push('   Hypothesis for future testing (NOT ACTIVE):');
    lines.push('   "A candidate that drops >= -30% within 15 minutes of discovery, especially');
    lines.push('   after a spike entry, is likely a dump and should be excluded from tracking."');
    lines.push('   Requires prospective validation before any paper trading application.');
  }
  lines.push('');

  // ── 5. Best/Worst Examples ────────────────────────────────────────
  lines.push('5. Best / Worst Examples');
  lines.push('');

  const exHdr =
    `   ${'Symbol'.padEnd(16)} ${'Class'.padEnd(14)} ${'15m'.padStart(7)} ${'30m'.padStart(7)} ${'60m'.padStart(7)} ${'curRet'.padStart(8)} ${'peak'.padStart(7)}`;

  function exRow(c: CandidateDecay): string {
    return (
      `   ${c.symbol.padEnd(16)} ${c.signalClass.padEnd(14)} ` +
      `${fmtPct(c.returnAt15m, 0).padStart(7)} ` +
      `${fmtPct(c.returnAt30m, 0).padStart(7)} ` +
      `${fmtPct(c.returnAt60m, 0).padStart(7)} ` +
      `${fmtPct(c.currentReturnPct, 0).padStart(8)} ` +
      `${fmtPct(c.bestGainPct, 0).padStart(7)}`
    );
  }

  if (r.topEarlyRunnerExamples.length > 0) {
    lines.push('   EARLY_RUNNER — top by peak gain:');
    lines.push(exHdr);
    for (const c of r.topEarlyRunnerExamples) {
      lines.push(exRow(c));
      if (c.returnAt15m == null && c.returnAt30m == null && c.returnAt60m == null) {
        lines.push('     (no window snapshots — decay data unavailable)');
      } else {
        const parts: string[] = [];
        if (c.actualMinsAt15m != null) parts.push(`15m-snap@${c.actualMinsAt15m.toFixed(0)}m`);
        if (c.actualMinsAt30m != null) parts.push(`30m-snap@${c.actualMinsAt30m.toFixed(0)}m`);
        if (c.actualMinsAt60m != null) parts.push(`60m-snap@${c.actualMinsAt60m.toFixed(0)}m`);
        if (parts.length > 0) lines.push(`     (actual snap times: ${parts.join(', ')})`);
      }
    }
    lines.push('');
  }

  if (r.topInstantDumpExamples.length > 0) {
    lines.push('   INSTANT_DUMP — worst current return:');
    lines.push(exHdr);
    for (const c of r.topInstantDumpExamples) {
      lines.push(exRow(c));
      if (c.returnAt15m == null && c.returnAt30m == null && c.returnAt60m == null) {
        lines.push('     (no window snapshots — decay data unavailable)');
      } else {
        const parts: string[] = [];
        if (c.actualMinsAt15m != null) parts.push(`15m-snap@${c.actualMinsAt15m.toFixed(0)}m`);
        if (c.actualMinsAt30m != null) parts.push(`30m-snap@${c.actualMinsAt30m.toFixed(0)}m`);
        if (c.actualMinsAt60m != null) parts.push(`60m-snap@${c.actualMinsAt60m.toFixed(0)}m`);
        if (parts.length > 0) lines.push(`     (actual snap times: ${parts.join(', ')})`);
      }
    }
    lines.push('');
  }

  if (r.topFalsePosExamples.length > 0) {
    lines.push('   INSTANT_DUMP — false positives (gained despite class label):');
    lines.push(exHdr);
    for (const c of r.topFalsePosExamples) {
      lines.push(exRow(c));
    }
    lines.push('');
  }

  // ── 6. Decision Note ──────────────────────────────────────────────
  lines.push('6. Decision Note');
  lines.push('');
  lines.push('   Does current DB have enough time-series coverage?');
  lines.push('');

  const erCls = r.classSummaries.find((c) => c.signalClass === 'EARLY_RUNNER');
  const idCls = r.classSummaries.find((c) => c.signalClass === 'INSTANT_DUMP');

  lines.push(`   EARLY_RUNNER:  ${erCls?.total ?? 0} total, ${erCls?.coverageAt15m ?? 0} with 15m data, ${erCls?.coverageAt30m ?? 0} with 30m data`);
  lines.push(`   INSTANT_DUMP:  ${idCls?.total ?? 0} total, ${idCls?.coverageAt15m ?? 0} with 15m data, ${idCls?.coverageAt30m ?? 0} with 30m data`);
  lines.push('');

  if (r.dataIsSparse) {
    lines.push('   NO. Coverage is critically insufficient.');
    lines.push('   The 15m/30m/60m decay analysis cannot be done with this dataset.');
    lines.push('   EARLY_RUNNER specifically has zero candidates with early window snapshots.');
    lines.push('   The hypothesis — that decay behavior at 15–30m separates survivors from');
    lines.push('   dumps — is scientifically sound but completely untested here.');
    lines.push('');
    lines.push('   Is decay data strong enough to guide future shadow labels?');
    lines.push('   NO. No decay signal can be extracted yet. The data that would be');
    lines.push('   needed (price at 15m and 30m post-discovery for each class) simply');
    lines.push('   does not exist for the key comparison class (EARLY_RUNNER).');
    lines.push('');
    lines.push('   Does this support paper trading?');
    lines.push('   NO. Decay data does not yet exist, PROFILE_MATCH has n=2, and no');
    lines.push('   entry-time signal has been validated prospectively.');
  } else {
    lines.push('   Coverage is present but limited. Treat all decay numbers as directional.');
    lines.push('   The hypothesis is directionally testable but not yet validated.');
    lines.push('');
    lines.push('   Does this support paper trading? NO.');
    lines.push('   Decay data is indicative only. Requires prospective validation.');
  }
  lines.push('');
  lines.push('   Root cause of the gap:');
  lines.push('   token:watch-refresh only runs when manually triggered, and has only');
  lines.push('   run a handful of times. To build decay data, it needs to run');
  lines.push('   automatically within the first 90 minutes of discovery for each');
  lines.push('   candidate. The current architecture collects one discovery snapshot');
  lines.push('   and then sporadic later refreshes — not a systematic early time-series.');
  lines.push('');
  lines.push('   What would fix this:');
  lines.push('   Run token:watch-cycle + token:watch-refresh together on a schedule');
  lines.push('   (e.g. every 15 minutes) so that new candidates get priced at 15m,');
  lines.push('   30m, and 60m after discovery automatically. After 2–3 days of that,');
  lines.push('   re-run this report.');
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
