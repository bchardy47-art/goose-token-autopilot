// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_PROMOTE_TO_REAL_TRADING
//
// Subgroup Conviction Report v1 — searches for a narrow paper-trade subgroup that has a
// real edge hiding inside the noisy overall dataset. Analysis ONLY.
//
// Reuses the EXACT data pipeline of token:ripper-paper-trade-simulation-report (same
// OBSERVED paper intents, same SimulatedTrade shape) so the two reports always agree on
// the underlying numbers. This module never mutates anything, never calls live trading,
// never treats UNKNOWN cluster risk as CLEAN, and never recommends real trading — even a
// HIGH_CONVICTION_PAPER_ONLY subgroup stays strictly paper-only.

import {
  runPaperTradeSimulationReport,
  type SimulatedTrade,
  type PaperTradeSimulationOptions,
} from './ripperPaperTradeSimulationReport';

// ── Tunables ────────────────────────────────────────────────────────────────────

export const DEFAULT_MIN_N         = 30;   // ignore subgroups smaller than this
export const DEFAULT_STRONGER_N    = 50;   // PROMISING / HIGH require at least this many
export const DEFAULT_MAX_COMBO     = 3;    // up to N dimensions combined per subgroup
export const DEFAULT_TOP_CANDIDATES = 15;
export const DEFAULT_TOP_LIST       = 15;  // for disqualified / outlier / stable lists
export const PNL_CAP_PCT            = 500; // cap each trade's P/L at +500% for the capped avg

// Candidate (edge) thresholds
export const CANDIDATE_WIN_RATE      = 0.55; // win rate must be strictly greater
export const CANDIDATE_AVG_CAPPED    = 1;    // capped avg P/L must be > 1%
export const CANDIDATE_MEDIAN        = 0;    // median P/L must be > 0%
export const CANDIDATE_WORST_FLOOR   = -35;  // worst loss must not be worse than -35%
export const OUTLIER_EXTREME         = 0.60; // one winner carrying >=60% of gains = extreme

// Stronger (HIGH_CONVICTION) thresholds
export const STRONG_WIN_RATE      = 0.60;
export const STRONG_AVG_CAPPED    = 5;
export const STRONG_MEDIAN        = 1;
export const STRONG_WORST_FLOOR   = -25;
export const STRONG_OUTLIER_MAX   = 0.40;

// "Stable-looking" definition (consistent, not outlier-driven)
export const STABLE_OUTLIER_MAX   = 0.25;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ────────────────────────────────────────────────────────────────────────

export type ConvictionTier =
  | 'NO_EDGE'
  | 'WATCHLIST'
  | 'PROMISING_PAPER_ONLY'
  | 'HIGH_CONVICTION_PAPER_ONLY';

export type SubgroupRecommendation =
  | 'KEEP_COLLECTING'
  | 'BUILD_MORE_EVIDENCE_FOR_SUBGROUP'
  | 'PAPER_ONLY_SUBGROUP_CANDIDATE_FOUND'
  | 'NO_ACTIONABLE_EDGE_FOUND';

export interface SubgroupStat {
  key:               string;                 // "entryTiming=WAIT_10M | clusterRisk=CLEAN"
  dimensions:        string[];               // dimension names used in this combination
  values:            Record<string, string>; // dimension → bucket value
  n:                 number;
  winners:           number;
  losers:            number;
  winRate:           number;
  lossRate:          number;
  avgPnlRaw:         number;
  avgPnlCapped:      number;
  medianPnl:         number;
  worstPnl:          number;
  bestPnl:           number;
  flatCount:         number;
  flatRate:          number;
  outlierDependence: number;   // 0..1 — largest winner's share of total gains
  outlierExtreme:    boolean;
  convictionTier:    ConvictionTier;
  convictionScore:   number;   // for ranking within / across tiers
  disqualifiers:     string[]; // why it is NOT an edge candidate (empty when it is)
}

export interface SubgroupBaseline {
  n:            number;
  winners:      number;
  losers:       number;
  flat:         number;
  winRate:      number;
  lossRate:     number;
  avgPnlRaw:    number;
  avgPnlCapped: number;
  medianPnl:    number;
  worstPnl:     number;
  bestPnl:      number;
}

export interface SubgroupConvictionResult {
  generatedAt:          string;
  baseline:             SubgroupBaseline;

  evaluatedGroupCount:  number;  // all subgroups built across all combinations
  eligibleGroupCount:   number;  // subgroups with n >= minN

  topCandidates:          SubgroupStat[];
  disqualifiedGroups:     SubgroupStat[];
  outlierDependentGroups: SubgroupStat[];
  stableGroups:           SubgroupStat[];

  recommendation:       SubgroupRecommendation;
  recommendationReason: string;

  config: {
    minN:         number;
    strongerN:    number;
    maxComboSize: number;
    pnlCapPct:    number;
  };

  // Safety flags — always true / 0, regardless of data.
  reportOnly:          true;
  readOnly:            true;
  paperOnly:           true;
  realTradingLocked:   true;
  tradingExecuted:     0;
  noGateChanges:       true;
  noFakeTradeMutation: true;
  noPaperIntentMutation: true;
  noRealTrading:       true;
  noWallet:            true;
  noSwap:              true;
  noSigning:           true;
  unknownNeverClean:   true;
}

export interface SubgroupConvictionOptions extends PaperTradeSimulationOptions {
  minN?:           number;
  strongerN?:      number;
  maxComboSize?:   number;
  topCandidates?:  number;
  topList?:        number;
  generatedAt?:    string;
}

// ── Stat helpers ─────────────────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function cap(pnl: number): number {
  return pnl > PNL_CAP_PCT ? PNL_CAP_PCT : pnl;
}

/**
 * Outlier dependence: the single largest winner's share of total positive (capped) P/L.
 * 0 → gains spread across many trades; ~1 → one trade carries essentially all the gains.
 * Returns 0 when the group has no net positive P/L (nothing to be dependent on).
 */
function outlierDependence(cappedPnls: number[]): number {
  const positives = cappedPnls.filter(p => p > 0);
  const sumPos = positives.reduce((s, v) => s + v, 0);
  if (sumPos <= 0) return 0;
  const top = Math.max(...positives);
  return top / sumPos;
}

// ── Dimensions ───────────────────────────────────────────────────────────────────

/** ripperScore → coarse bucket. null stays a distinct UNKNOWN bucket (never inferred). */
export function ripperScoreBucket(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return 'SCORE_UNKNOWN';
  if (score >= 100) return 'SCORE_100';
  if (score >= 95)  return 'SCORE_95_99';
  if (score >= 90)  return 'SCORE_90_94';
  if (score >= 80)  return 'SCORE_80_89';
  return 'SCORE_LT_80';
}

interface Dimension {
  name: string;
  get:  (t: SimulatedTrade) => string;
}

// clusterRisk maps null → 'UNKNOWN' (NOT 'CLEAN'); UNKNOWN is preserved verbatim.
const DIMENSIONS: Dimension[] = [
  { name: 'entryTiming', get: t => t.paperEntryTiming || 'UNKNOWN' },
  { name: 'm5Band',      get: t => t.m5Band || 'UNAVAILABLE' },
  { name: 'liquidity',   get: t => t.liquidityBucket ?? 'UNKNOWN' },
  { name: 'vlr',         get: t => t.vlrBucket ?? 'UNKNOWN' },
  { name: 'clusterRisk', get: t => t.clusterRisk ?? 'UNKNOWN' },
  { name: 'ripperScore', get: t => ripperScoreBucket(t.ripperScore) },
];

function combinations<T>(arr: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (size > arr.length) return [];
  const result: T[][] = [];
  function recurse(start: number, combo: T[]): void {
    if (combo.length === size) { result.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]!);
      recurse(i + 1, combo);
      combo.pop();
    }
  }
  recurse(0, []);
  return result;
}

// ── Conviction classification ───────────────────────────────────────────────────

const TIER_RANK: Record<ConvictionTier, number> = {
  HIGH_CONVICTION_PAPER_ONLY: 4,
  PROMISING_PAPER_ONLY:       3,
  WATCHLIST:                  2,
  NO_EDGE:                    1,
};

function pctStr(v: number): string { return (v * 100).toFixed(1) + '%'; }
function pnlStr(v: number): string { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }

function classify(s: {
  n: number; winRate: number; avgPnlCapped: number; medianPnl: number;
  worstPnl: number; outlierDependence: number;
}, minN: number, strongerN: number): { tier: ConvictionTier; disqualifiers: string[] } {
  const dq: string[] = [];
  if (!(s.winRate > CANDIDATE_WIN_RATE))     dq.push(`win rate ${pctStr(s.winRate)} not > 55%`);
  if (!(s.avgPnlCapped > CANDIDATE_AVG_CAPPED)) dq.push(`capped avg ${pnlStr(s.avgPnlCapped)} not > 1%`);
  if (!(s.medianPnl > CANDIDATE_MEDIAN))     dq.push(`median ${pnlStr(s.medianPnl)} not > 0%`);
  if (!(s.worstPnl >= CANDIDATE_WORST_FLOOR)) dq.push(`worst loss ${pnlStr(s.worstPnl)} worse than -35%`);
  if (s.outlierDependence >= OUTLIER_EXTREME) dq.push(`outlier dependence ${s.outlierDependence.toFixed(2)} extreme`);

  if (dq.length > 0) return { tier: 'NO_EDGE', disqualifiers: dq };

  // Meets all base candidate criteria.
  if (s.n < strongerN) return { tier: 'WATCHLIST', disqualifiers: [] }; // underpowered

  const meetsStrong =
    s.winRate > STRONG_WIN_RATE &&
    s.avgPnlCapped > STRONG_AVG_CAPPED &&
    s.medianPnl > STRONG_MEDIAN &&
    s.worstPnl >= STRONG_WORST_FLOOR &&
    s.outlierDependence < STRONG_OUTLIER_MAX;

  return { tier: meetsStrong ? 'HIGH_CONVICTION_PAPER_ONLY' : 'PROMISING_PAPER_ONLY', disqualifiers: [] };
}

function buildStat(
  dims: Dimension[],
  values: Record<string, string>,
  trades: SimulatedTrade[],
  minN: number,
  strongerN: number,
): SubgroupStat {
  const n = trades.length;
  const pnls       = trades.map(t => t.simulatedPnlPct);
  const cappedPnls = pnls.map(cap);
  const winners = trades.filter(t => t.simulatedPnlPct > 0).length;
  const losers  = n - winners;
  const flatCount = trades.filter(t => t.simulatedPnlPct === 0).length;
  const winRate = n > 0 ? winners / n : 0;
  const avgPnlCapped = avg(cappedPnls);
  const medianPnl = median(pnls);
  const worstPnl = pnls.length ? Math.min(...pnls) : 0;
  const bestPnl  = pnls.length ? Math.max(...pnls) : 0;
  const od = outlierDependence(cappedPnls);

  const { tier, disqualifiers } = classify(
    { n, winRate, avgPnlCapped, medianPnl, worstPnl, outlierDependence: od },
    minN, strongerN,
  );

  // Within-tier ranking score: reward consistency + size, penalise outlier reliance.
  const convictionScore =
    winRate * 100 +
    Math.min(avgPnlCapped, 50) +
    medianPnl +
    Math.min(n, 300) * 0.05 -
    od * 40;

  return {
    key: dims.map(d => `${d.name}=${values[d.name]}`).join(' | '),
    dimensions: dims.map(d => d.name),
    values,
    n,
    winners,
    losers,
    winRate,
    lossRate: n > 0 ? losers / n : 0,
    avgPnlRaw:    avg(pnls),
    avgPnlCapped,
    medianPnl,
    worstPnl,
    bestPnl,
    flatCount,
    flatRate: n > 0 ? flatCount / n : 0,
    outlierDependence: od,
    outlierExtreme: od >= OUTLIER_EXTREME,
    convictionTier: tier,
    convictionScore,
    disqualifiers,
  };
}

function rankCmp(a: SubgroupStat, b: SubgroupStat): number {
  const t = TIER_RANK[b.convictionTier] - TIER_RANK[a.convictionTier];
  if (t !== 0) return t;
  return b.convictionScore - a.convictionScore;
}

// ── Main runner ──────────────────────────────────────────────────────────────────

export function runSubgroupConvictionReport(
  opts: SubgroupConvictionOptions = {},
): SubgroupConvictionResult {
  const minN        = opts.minN        ?? DEFAULT_MIN_N;
  const strongerN   = opts.strongerN   ?? DEFAULT_STRONGER_N;
  const maxCombo    = opts.maxComboSize ?? DEFAULT_MAX_COMBO;
  const topCandN    = opts.topCandidates ?? DEFAULT_TOP_CANDIDATES;
  const topListN    = opts.topList     ?? DEFAULT_TOP_LIST;
  const generatedAt = opts.generatedAt ?? new Date(opts.nowMs ?? Date.now()).toISOString();

  // Same data sources / pipeline as the paper-trade simulation report (read-only).
  const sim = runPaperTradeSimulationReport({
    intentsPath: opts.intentsPath,
    memoryPath:  opts.memoryPath,
    cyclesDir:   opts.cyclesDir,
    nowMs:       opts.nowMs,
  });
  const trades = sim.simulatedTrades;

  // ── Baseline ──────────────────────────────────────────────────────────────────
  const allPnls   = trades.map(t => t.simulatedPnlPct);
  const allCapped = allPnls.map(cap);
  const baseWinners = trades.filter(t => t.simulatedPnlPct > 0).length;
  const baseFlat    = trades.filter(t => t.simulatedPnlPct === 0).length;
  const baseline: SubgroupBaseline = {
    n:            trades.length,
    winners:      baseWinners,
    losers:       trades.length - baseWinners,
    flat:         baseFlat,
    winRate:      trades.length ? baseWinners / trades.length : 0,
    lossRate:     trades.length ? (trades.length - baseWinners) / trades.length : 0,
    avgPnlRaw:    avg(allPnls),
    avgPnlCapped: avg(allCapped),
    medianPnl:    median(allPnls),
    worstPnl:     allPnls.length ? Math.min(...allPnls) : 0,
    bestPnl:      allPnls.length ? Math.max(...allPnls) : 0,
  };

  // ── Enumerate subgroup combinations ─────────────────────────────────────────────
  const allStats: SubgroupStat[] = [];
  let evaluatedGroupCount = 0;

  const dimCombos: Dimension[][] = [];
  for (let size = 1; size <= Math.min(maxCombo, DIMENSIONS.length); size++) {
    dimCombos.push(...combinations(DIMENSIONS, size));
  }

  for (const dims of dimCombos) {
    // Group trades by the tuple of this combination's bucket values.
    const groups = new Map<string, { values: Record<string, string>; trades: SimulatedTrade[] }>();
    for (const t of trades) {
      const values: Record<string, string> = {};
      for (const d of dims) values[d.name] = d.get(t);
      const k = dims.map(d => values[d.name]).join('');
      let g = groups.get(k);
      if (!g) { g = { values, trades: [] }; groups.set(k, g); }
      g.trades.push(t);
    }
    for (const g of groups.values()) {
      evaluatedGroupCount++;
      if (g.trades.length < minN) continue; // ignore small-n subgroups
      allStats.push(buildStat(dims, g.values, g.trades, minN, strongerN));
    }
  }

  const eligible = allStats; // already n >= minN
  eligible.sort(rankCmp);

  // ── Section slices ──────────────────────────────────────────────────────────────
  const candidates = eligible.filter(s => s.convictionTier !== 'NO_EDGE');
  const topCandidates = candidates.slice(0, topCandN);

  const disqualifiedGroups = eligible
    .filter(s => s.convictionTier === 'NO_EDGE')
    .sort((a, b) => b.n - a.n)
    .slice(0, topListN);

  const outlierDependentGroups = eligible
    .filter(s => s.outlierExtreme)
    .sort((a, b) => b.outlierDependence - a.outlierDependence)
    .slice(0, topListN);

  const stableGroups = eligible
    .filter(s => s.n >= strongerN && s.outlierDependence < STABLE_OUTLIER_MAX && s.medianPnl >= 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, topListN);

  // ── Final recommendation (always paper-only) ─────────────────────────────────────
  let recommendation: SubgroupRecommendation;
  let recommendationReason: string;

  const hasStrongCandidate = candidates.some(
    s => s.convictionTier === 'PROMISING_PAPER_ONLY' || s.convictionTier === 'HIGH_CONVICTION_PAPER_ONLY',
  );
  const hasWatchlist = candidates.some(s => s.convictionTier === 'WATCHLIST');

  if (eligible.length === 0) {
    recommendation = 'KEEP_COLLECTING';
    recommendationReason =
      `No subgroup reached the minimum sample size (n >= ${minN}). Continue collecting paper observations.`;
  } else if (hasStrongCandidate) {
    recommendation = 'PAPER_ONLY_SUBGROUP_CANDIDATE_FOUND';
    recommendationReason =
      `A paper-only subgroup candidate cleared all conviction criteria with n >= ${strongerN}. ` +
      `This is a PAPER-ONLY research signal — DO_NOT_PROMOTE_TO_REAL_TRADING and ` +
      `DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE.`;
  } else if (hasWatchlist) {
    recommendation = 'BUILD_MORE_EVIDENCE_FOR_SUBGROUP';
    recommendationReason =
      `One or more subgroups meet the candidate criteria but are underpowered (n < ${strongerN}). ` +
      `Build more forward paper evidence before treating them as candidates.`;
  } else {
    recommendation = 'NO_ACTIONABLE_EDGE_FOUND';
    recommendationReason =
      `${eligible.length} subgroup(s) had enough sample size but none cleared the conviction criteria ` +
      `(win rate > 55%, capped avg > 1%, median > 0%, worst >= -35%, no extreme outlier dependence).`;
  }

  return {
    generatedAt,
    baseline,
    evaluatedGroupCount,
    eligibleGroupCount: eligible.length,
    topCandidates,
    disqualifiedGroups,
    outlierDependentGroups,
    stableGroups,
    recommendation,
    recommendationReason,
    config: { minN, strongerN, maxComboSize: maxCombo, pnlCapPct: PNL_CAP_PCT },

    reportOnly:            true,
    readOnly:              true,
    paperOnly:             true,
    realTradingLocked:     true,
    tradingExecuted:       0,
    noGateChanges:         true,
    noFakeTradeMutation:   true,
    noPaperIntentMutation: true,
    noRealTrading:         true,
    noWallet:              true,
    noSwap:                true,
    noSigning:             true,
    unknownNeverClean:     true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────────

function renderStatLine(s: SubgroupStat): string[] {
  return [
    `  [${s.convictionTier}]  n=${s.n}`,
    `    ${s.key}`,
    `    win=${pctStr(s.winRate)}  loss=${pctStr(s.lossRate)}  ` +
      `avgRaw=${pnlStr(s.avgPnlRaw)}  avgCap=${pnlStr(s.avgPnlCapped)}  med=${pnlStr(s.medianPnl)}`,
    `    worst=${pnlStr(s.worstPnl)}  best=${pnlStr(s.bestPnl)}  ` +
      `flat=${s.flatCount} (${pctStr(s.flatRate)})  outlierDep=${s.outlierDependence.toFixed(2)}` +
      `${s.outlierExtreme ? ' (EXTREME)' : ''}`,
  ];
}

export function renderSubgroupConvictionReport(r: SubgroupConvictionResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — SUBGROUP CONVICTION REPORT');
  L.push('  [REPORT ONLY — READ ONLY — PAPER ONLY — NO MUTATION — UNKNOWN ≠ CLEAN]');
  L.push('  Searches for a narrow paper-trade subgroup with a real edge inside noisy data.');
  L.push(SEP, '');
  L.push(`  Generated at        : ${r.generatedAt}`);
  L.push(`  Subgroups evaluated : ${r.evaluatedGroupCount}  (eligible n>=${r.config.minN}: ${r.eligibleGroupCount})`);
  L.push(`  Combo size (max)    : ${r.config.maxComboSize} dimensions`);
  L.push(`  P/L cap for avg     : +${r.config.pnlCapPct}%`);
  L.push('');

  // §1 — Overall baseline
  const b = r.baseline;
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERALL BASELINE');
  L.push(`  ${SEP2}`, '');
  L.push(`  Simulated trades (OBSERVED)    : ${b.n}`);
  L.push(`  Winners / Losers / Flat        : ${b.winners} / ${b.losers} / ${b.flat}`);
  L.push(`  Win rate                       : ${pctStr(b.winRate)}`);
  L.push(`  Loss rate                      : ${pctStr(b.lossRate)}`);
  L.push(`  Avg simulated P/L (raw)        : ${pnlStr(b.avgPnlRaw)}`);
  L.push(`  Avg simulated P/L (capped 500%): ${pnlStr(b.avgPnlCapped)}`);
  L.push(`  Median simulated P/L           : ${pnlStr(b.medianPnl)}`);
  L.push(`  Worst / Best                   : ${pnlStr(b.worstPnl)} / ${pnlStr(b.bestPnl)}`);
  L.push('');

  // §2 — Top subgroup candidates
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — TOP SUBGROUP CANDIDATES (ranked by conviction)');
  L.push(`  ${SEP2}`, '');
  if (r.topCandidates.length === 0) {
    L.push('  (no subgroup cleared the candidate conviction criteria)');
  } else {
    for (const s of r.topCandidates) { L.push(...renderStatLine(s)); L.push(''); }
  }
  L.push('');

  // §3 — Disqualified groups and why
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — DISQUALIFIED GROUPS (largest n first) AND WHY');
  L.push(`  ${SEP2}`, '');
  if (r.disqualifiedGroups.length === 0) {
    L.push('  (no eligible disqualified groups)');
  } else {
    for (const s of r.disqualifiedGroups) {
      L.push(`  n=${String(s.n).padStart(5)}  win=${pctStr(s.winRate)}  med=${pnlStr(s.medianPnl)}  ${s.key}`);
      L.push(`         why: ${s.disqualifiers.join('; ')}`);
    }
  }
  L.push('');

  // §4 — Outlier-dependent groups
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — OUTLIER-DEPENDENT GROUPS (one winner carries the gains)');
  L.push(`  ${SEP2}`, '');
  if (r.outlierDependentGroups.length === 0) {
    L.push('  (none flagged extreme)');
  } else {
    for (const s of r.outlierDependentGroups) {
      L.push(`  outlierDep=${s.outlierDependence.toFixed(2)}  n=${s.n}  win=${pctStr(s.winRate)}  ` +
        `best=${pnlStr(s.bestPnl)}  med=${pnlStr(s.medianPnl)}  ${s.key}`);
    }
  }
  L.push('');

  // §5 — Stable-looking groups
  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — STABLE-LOOKING GROUPS (low outlier dependence, n >= ' + r.config.strongerN + ')');
  L.push(`  ${SEP2}`, '');
  if (r.stableGroups.length === 0) {
    L.push('  (no stable-looking groups at this sample size)');
  } else {
    for (const s of r.stableGroups) {
      L.push(`  n=${String(s.n).padStart(5)}  win=${pctStr(s.winRate)}  med=${pnlStr(s.medianPnl)}  ` +
        `avgCap=${pnlStr(s.avgPnlCapped)}  outlierDep=${s.outlierDependence.toFixed(2)}  [${s.convictionTier}]  ${s.key}`);
    }
  }
  L.push('');

  // §6 — Final recommendation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — FINAL RECOMMENDATION');
  L.push(`  ${SEP2}`, '');
  L.push(`  [${r.recommendation}]`);
  L.push(`  ${r.recommendationReason}`);
  L.push('');
  L.push('  DO_NOT_PROMOTE_TO_REAL_TRADING');
  L.push('  DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push('  Even a HIGH_CONVICTION_PAPER_ONLY subgroup is paper-only research evidence.');
  L.push('');

  // §7 — Safety banner
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true   READ_ONLY=true   PAPER_ONLY=true');
  L.push('  NO_REAL_TRADING=true   NO_FAKE_TRADE_MUTATION=true   NO_PAPER_INTENT_MUTATION=true');
  L.push('  NO_GATE_CHANGES=true   NO_WALLET=true   NO_SWAP=true   NO_SIGNING=true');
  L.push('  UNKNOWN_CLUSTER_RISK_IS_NEVER_TREATED_AS_CLEAN=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING   tradingExecuted=0   realTradingLocked=true');
  L.push('  Do not call token:paper-buy or token:auto-paper from this report.');
  L.push(SEP, '');

  return L.join('\n');
}
