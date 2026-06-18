// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE
//
// WATCH Enrichment Plan — splits WATCH-cluster rows into subgroups by
// liquidity/VLR data quality, scores each for artifact risk, and proposes
// a paper-only re-observation strategy.
// Reads learning-memory.jsonl only. No gate or policy changes.

import * as fs from 'fs';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MemoryRow {
  contract?:              string;
  outcomeLabel?:          string | null;
  priceChangePct?:        number | null;
  liquidityBucket?:       string | null;
  liquidityUsd?:          number | null;
  vlrBucket?:             string | null;
  clusterRisk?:           string | null;
  ripperScore?:           number | null;
  ageMinutes?:            number | null;
  timingPath?:            string | null;
  gateDecision?:          string | null;
  wouldRejectByLiqOrAge?: boolean | null;
}

export type WatchGroupKey =
  | 'KNOWN_LIQ_KNOWN_VLR'
  | 'KNOWN_LIQ_VLR_UNKNOWN'
  | 'LIQ_UNKNOWN_KNOWN_VLR'
  | 'LIQ_UNKNOWN_VLR_UNKNOWN';

export type WatchRecommendation =
  | 'WATCH_READY_FOR_PAPER_OBSERVATION'
  | 'WATCH_NEEDS_RECHECK'
  | 'WATCH_TOO_ARTIFACT_RISKY'
  | 'WATCH_JUNK_HEAVY';

export type ArtifactRisk = 'HIGH' | 'MEDIUM' | 'LOW';

export interface WatchSubgroupResult {
  key:              WatchGroupKey;
  label:            string;
  total:            number;
  labeled:          number;
  unlabeled:        number;
  labeledCoveragePct: number;   // 0–1
  uniqueContracts:  number;
  bigWinner:        number;
  winner:           number;
  smallWinner:      number;
  flatJunk:         number;
  dump:             number;
  win5Rate:         number | null;   // of labeled
  winAnyRate:       number | null;
  flatDumpRate:     number | null;
  observedWin5Rate: number | null;   // = win5Rate (alias for clarity)
  pessimisticWin5Rate: number | null; // win5 / total
  avgMove:          number | null;
  medianMove:       number | null;
  liqUsdAllNull:    boolean;
  artifactRisk:     ArtifactRisk;
  recommendation:   WatchRecommendation;
  recommendationNote: string;
}

export interface ObservationField {
  field:     string;
  why:       string;
  priority:  'HIGH' | 'MEDIUM';
}

export interface WatchObservationStrategy {
  recheck2MinFields:  ObservationField[];
  recheck5MinFields:  ObservationField[];
  upgradeConditions:  string[];  // → WATCH_READY candidate
  downgradeConditions: string[]; // → reject or observe-only
}

export interface WatchEnrichmentPlanResult {
  totalWatchRows:     number;
  baselineWin5Rate:   number | null;
  subgroups:          WatchSubgroupResult[];
  observationStrategy: WatchObservationStrategy;
  reportOnly:         true;
  readOnly:           true;
  paperOnly:          true;
  realTradingLocked:  true;
  tradingExecuted:    0;
}

export interface WatchEnrichmentPlanOptions {
  learningMemoryPath?: string;
}

// ── Group classifier ──────────────────────────────────────────────────────────

export function classifyWatchGroup(row: {
  liquidityBucket?: string | null;
  vlrBucket?: string | null;
}): WatchGroupKey {
  const liqUnk = row.liquidityBucket === 'LIQ_UNKNOWN' || row.liquidityBucket == null;
  const vlrUnk = row.vlrBucket === 'VLR_UNKNOWN'       || row.vlrBucket == null;
  if (!liqUnk && !vlrUnk) return 'KNOWN_LIQ_KNOWN_VLR';
  if (!liqUnk &&  vlrUnk) return 'KNOWN_LIQ_VLR_UNKNOWN';
  if ( liqUnk && !vlrUnk) return 'LIQ_UNKNOWN_KNOWN_VLR';
  return 'LIQ_UNKNOWN_VLR_UNKNOWN';
}

const GROUP_LABELS: Record<WatchGroupKey, string> = {
  KNOWN_LIQ_KNOWN_VLR:    'Known liquidity + Known VLR  (most trustworthy)',
  KNOWN_LIQ_VLR_UNKNOWN:  'Known liquidity + VLR_UNKNOWN  (needs VLR recheck)',
  LIQ_UNKNOWN_KNOWN_VLR:  'LIQ_UNKNOWN + Known VLR  (needs liq recheck)',
  LIQ_UNKNOWN_VLR_UNKNOWN: 'LIQ_UNKNOWN + VLR_UNKNOWN  (needs full recheck)',
};

const GROUP_ORDER: WatchGroupKey[] = [
  'KNOWN_LIQ_KNOWN_VLR',
  'KNOWN_LIQ_VLR_UNKNOWN',
  'LIQ_UNKNOWN_KNOWN_VLR',
  'LIQ_UNKNOWN_VLR_UNKNOWN',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

function med(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

function artifactRiskFor(unlabeledPct: number, liqUsdAllNull: boolean): ArtifactRisk {
  if (liqUsdAllNull || unlabeledPct > 0.50) return 'HIGH';
  if (unlabeledPct > 0.30)                   return 'MEDIUM';
  return 'LOW';
}

function recommend(
  g: Pick<WatchSubgroupResult,
    'artifactRisk' | 'labeled' | 'win5Rate' | 'flatDumpRate' | 'pessimisticWin5Rate'>,
  baselineWin5Rate: number | null,
): { recommendation: WatchRecommendation; note: string } {
  if (g.artifactRisk === 'HIGH') {
    return {
      recommendation: 'WATCH_TOO_ARTIFACT_RISKY',
      note: 'All or most rows lack real liq/VLR data. Observed win rate is unreliable due to observation selection bias. Must re-observe with known liq+VLR before trusting.',
    };
  }
  if (g.labeled < 20) {
    return {
      recommendation: 'WATCH_NEEDS_RECHECK',
      note: `Only ${g.labeled} labeled rows — too few to assess confidently. Collect more observations before drawing conclusions.`,
    };
  }
  if ((g.flatDumpRate ?? 0) > 0.70) {
    return {
      recommendation: 'WATCH_JUNK_HEAVY',
      note: `flatDump rate ${((g.flatDumpRate ?? 0) * 100).toFixed(0)}% — this subgroup skews toward junk/dumps even with WATCH signal. Treat as observe-only, not paper candidate.`,
    };
  }
  const baseline = baselineWin5Rate ?? 0.227;
  const lift = (g.win5Rate ?? 0) / Math.max(baseline, 0.001);
  if ((g.win5Rate ?? 0) >= 0.30 && lift >= 1.3) {
    return {
      recommendation: 'WATCH_READY_FOR_PAPER_OBSERVATION',
      note: `win5=${((g.win5Rate ?? 0) * 100).toFixed(0)}% on ${g.labeled} labeled rows (${lift.toFixed(1)}x baseline lift). Real liq+VLR data. Suitable for paper-only forward observation.`,
    };
  }
  return {
    recommendation: 'WATCH_NEEDS_RECHECK',
    note: `win5=${((g.win5Rate ?? 0) * 100).toFixed(0)}% on ${g.labeled} rows — lift is marginal or uncertain. Collect more clean observations.`,
  };
}

// ── Observation strategy (static, expert-derived) ────────────────────────────

function buildObservationStrategy(): WatchObservationStrategy {
  return {
    recheck2MinFields: [
      { field: 'liquidityUsd',    why: 'Confirm liq is measurable and still in range. LIQ_UNKNOWN becomes untrustworthy without this.', priority: 'HIGH' },
      { field: 'liquidityBucket', why: 'Bucket confirms whether liq is viable for entry (LIQ_10K_30K or LIQ_30K_100K preferred for WATCH).', priority: 'HIGH' },
      { field: 'vlrBucket',       why: 'VLR_UNKNOWN at capture time is the primary contamination source. Re-measure.', priority: 'HIGH' },
      { field: 'priceChangePct',  why: 'Early price movement is a forward signal. +5% in 2 min is a strong confirmation.', priority: 'HIGH' },
      { field: 'ripperScore',     why: 'Score may change as age/liq update. Confirm still ≥60 for WATCH tokens.', priority: 'MEDIUM' },
    ],
    recheck5MinFields: [
      { field: 'liquidityUsd',    why: 'Final liq check before any observation decision. Liq drop = exit observation.', priority: 'HIGH' },
      { field: 'vlrBucket',       why: 'VLR_GTE_2 or VLR_0_5_TO_2 at 5 min is a strong upgrade signal.', priority: 'HIGH' },
      { field: 'clusterRisk',     why: 'If cluster changed from WATCH to CLEAN or HIGH_RISK, re-evaluate.', priority: 'HIGH' },
      { field: 'bubbleMapsScore', why: 'Score >70 on WATCH tokens at 5 min is a meaningful quality signal.', priority: 'MEDIUM' },
      { field: 'ageMinutes',      why: 'Token age drives timing path. If >10 min, ENTER_NOW window is closed.', priority: 'MEDIUM' },
      { field: 'priceChangePct',  why: 'Cumulative move by 5 min. Flat or negative = junk signal.', priority: 'HIGH' },
    ],
    upgradeConditions: [
      'liquidityUsd becomes measurable (was LIQ_UNKNOWN at capture) AND is ≥$10K',
      'vlrBucket resolves to VLR_0_5_TO_2 or VLR_GTE_2 (was VLR_UNKNOWN)',
      'priceChangePct > +5% within 2 minutes of capture (early momentum)',
      'ripperScore ≥ 70 AND timingPath = ENTER_NOW AND liquidityBucket IN (LIQ_10K_30K, LIQ_30K_100K)',
      'clusterRisk remains WATCH (not degraded to HIGH_RISK)',
      'bubbleMapsScore > 70 at 5-minute re-check',
    ],
    downgradeConditions: [
      'liquidityUsd still null at 2-minute re-check → reject (cannot verify)',
      'liquidityBucket = LIQ_LT_10K → observe-only (71% flatDump in this bucket for WATCH)',
      'priceChangePct < -5% at 2 minutes → likely dump, do not observe',
      'vlrBucket remains VLR_UNKNOWN at 5 minutes → cannot qualify as paper candidate',
      'ageMinutes > 10 AND timingPath = WAIT_10M → window closed, move on',
      'clusterRisk shifts to HIGH_RISK or SKIP → immediate reject',
      'ripperScore < 50 → insufficient quality signal for WATCH candidate',
    ],
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runWatchEnrichmentPlan(
  options: WatchEnrichmentPlanOptions = {},
): WatchEnrichmentPlanResult {
  const memPath = options.learningMemoryPath
    ?? 'data/token-grab/ripper/learning-memory.jsonl';

  const allRows: MemoryRow[] = [];
  for (const line of readLines(memPath)) {
    try {
      const r = JSON.parse(line) as MemoryRow;
      if (typeof r.contract === 'string') allRows.push(r);
    } catch { /* skip */ }
  }

  // Global baseline (labeled rows only)
  const globalLabeled = allRows.filter(r => r.outcomeLabel && r.outcomeLabel !== 'UNKNOWN');
  const globalWin5 = globalLabeled.filter(
    r => r.outcomeLabel === 'BIG_WINNER' || r.outcomeLabel === 'WINNER').length;
  const baselineWin5Rate = globalLabeled.length > 0 ? globalWin5 / globalLabeled.length : null;

  const watchRows = allRows.filter(r => r.clusterRisk === 'WATCH');

  // Bucket rows into groups
  const buckets: Record<WatchGroupKey, MemoryRow[]> = {
    KNOWN_LIQ_KNOWN_VLR:    [],
    KNOWN_LIQ_VLR_UNKNOWN:  [],
    LIQ_UNKNOWN_KNOWN_VLR:  [],
    LIQ_UNKNOWN_VLR_UNKNOWN: [],
  };
  for (const r of watchRows) {
    buckets[classifyWatchGroup(r)].push(r);
  }

  const subgroups: WatchSubgroupResult[] = GROUP_ORDER.map(key => {
    const rows   = buckets[key];
    const lbl    = rows.filter(r => r.outcomeLabel && r.outcomeLabel !== 'UNKNOWN');
    const unlbl  = rows.length - lbl.length;
    const contracts = new Set(rows.map(r => r.contract ?? '').filter(Boolean));

    const bw = lbl.filter(r => r.outcomeLabel === 'BIG_WINNER').length;
    const w  = lbl.filter(r => r.outcomeLabel === 'WINNER').length;
    const sw = lbl.filter(r => r.outcomeLabel === 'SMALL_WINNER').length;
    const fj = lbl.filter(r => r.outcomeLabel === 'FLAT_JUNK').length;
    const d  = lbl.filter(r => r.outcomeLabel === 'DUMP').length;
    const win5 = bw + w;
    const flatDump = fj + d;

    const n  = rows.length;
    const ln = lbl.length;
    const win5Rate     = ln > 0 ? win5     / ln : null;
    const winAnyRate   = ln > 0 ? (win5 + sw) / ln : null;
    const flatDumpRate = ln > 0 ? flatDump / ln : null;
    const pessimistic  = n  > 0 ? win5     / n  : null;
    const coverage     = n  > 0 ? ln       / n  : 0;
    const unlabeledPct = n  > 0 ? unlbl    / n  : 0;

    const prices = lbl.map(r => r.priceChangePct).filter((v): v is number => v != null);
    const avgMove = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

    const liqUsdAllNull = n > 0 && rows.every(r => r.liquidityUsd == null);
    const artRisk = artifactRiskFor(unlabeledPct, liqUsdAllNull);

    const partial = {
      artifactRisk: artRisk,
      labeled: ln,
      win5Rate,
      flatDumpRate,
      pessimisticWin5Rate: pessimistic,
    };
    const { recommendation, note } = recommend(partial, baselineWin5Rate);

    return {
      key,
      label:            GROUP_LABELS[key],
      total:            n,
      labeled:          ln,
      unlabeled:        unlbl,
      labeledCoveragePct: coverage,
      uniqueContracts:  contracts.size,
      bigWinner:        bw,
      winner:           w,
      smallWinner:      sw,
      flatJunk:         fj,
      dump:             d,
      win5Rate,
      winAnyRate,
      flatDumpRate,
      observedWin5Rate:     win5Rate,
      pessimisticWin5Rate:  pessimistic,
      avgMove,
      medianMove:       med(prices),
      liqUsdAllNull,
      artifactRisk:     artRisk,
      recommendation,
      recommendationNote: note,
    };
  });

  return {
    totalWatchRows:    watchRows.length,
    baselineWin5Rate,
    subgroups,
    observationStrategy: buildObservationStrategy(),
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function pct(v: number | null | undefined, d = 1): string {
  return v == null ? 'n/a' : `${(v * 100).toFixed(d)}%`;
}

function numStr(v: number | null | undefined, d = 1): string {
  return v == null ? 'n/a' : v.toFixed(d);
}

function artTag(r: ArtifactRisk): string {
  return r === 'HIGH' ? '[HIGH ARTIFACT RISK]' :
         r === 'MEDIUM' ? '[MEDIUM ARTIFACT RISK]' : '[LOW ARTIFACT RISK]';
}

function recTag(r: WatchRecommendation): string { return `[${r}]`; }

export function renderWatchEnrichmentPlan(result: WatchEnrichmentPlanResult): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — WATCH ENRICHMENT PLAN v1');
  L.push('  [REPORT ONLY — NO TRADES — NO POLICY CHANGES — READ ONLY]');
  L.push('  Splitting WATCH-cluster rows by data quality and proposing re-observation.');
  L.push(SEP, '');

  L.push(`  ${SEP2}`);
  L.push('  OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Total WATCH rows    : ${result.totalWatchRows}`);
  L.push(`  Baseline win5 rate  : ${pct(result.baselineWin5Rate)}  (global labeled)`);
  L.push('');

  // ── Subgroups ─────────────────────────────────────────────────────────────
  for (const g of result.subgroups) {
    L.push(`  ${SEP2}`);
    L.push(`  GROUP: ${g.key}`);
    L.push(`  ${g.label}`);
    L.push(`  ${SEP2}`, '');

    L.push(`  Coverage`);
    L.push(`    total rows       : ${g.total}`);
    L.push(`    unique contracts : ${g.uniqueContracts}`);
    L.push(`    labeled          : ${g.labeled}  (${pct(g.labeledCoveragePct, 0)} coverage)`);
    L.push(`    unlabeled        : ${g.unlabeled}`);
    L.push('');

    L.push(`  Outcomes  (of labeled rows)`);
    L.push(`    BIG_WINNER  : ${g.bigWinner}  (${pct(g.bigWinner / Math.max(g.labeled, 1))})`);
    L.push(`    WINNER      : ${g.winner}  (${pct(g.winner     / Math.max(g.labeled, 1))})`);
    L.push(`    SMALL_WINNER: ${g.smallWinner}  (${pct(g.smallWinner / Math.max(g.labeled, 1))})`);
    L.push(`    FLAT_JUNK   : ${g.flatJunk}  (${pct(g.flatJunk   / Math.max(g.labeled, 1))})`);
    L.push(`    DUMP        : ${g.dump}  (${pct(g.dump       / Math.max(g.labeled, 1))})`);
    L.push('');
    L.push(`    observed win5    : ${pct(g.observedWin5Rate)}  (win5 / labeled)`);
    L.push(`    pessimistic win5 : ${pct(g.pessimisticWin5Rate)}  (win5 / total, unlabeled = loss)`);
    L.push(`    flatDump rate    : ${pct(g.flatDumpRate)}`);
    L.push('');

    L.push(`  Price movement  (labeled rows)`);
    L.push(`    avg move         : ${numStr(g.avgMove)}%`);
    L.push(`    median move      : ${numStr(g.medianMove)}%`);
    L.push('');

    L.push(`  Artifact risk : ${artTag(g.artifactRisk)}`);
    L.push(`    liqUsd all null  : ${g.liqUsdAllNull}`);
    L.push(`    coverage         : ${pct(g.labeledCoveragePct)}`);
    L.push('');

    L.push(`  Recommendation : ${recTag(g.recommendation)}`);
    L.push(`    ${g.recommendationNote}`);
    L.push('');
  }

  // ── Observation strategy ──────────────────────────────────────────────────
  const s = result.observationStrategy;
  L.push(`  ${SEP2}`);
  L.push('  PROPOSED PAPER-ONLY OBSERVATION STRATEGY');
  L.push(`  ${SEP2}`, '');

  L.push('  RE-CHECK AT 2 MINUTES:');
  for (const f of s.recheck2MinFields) {
    L.push(`    [${f.priority}] ${f.field.padEnd(20)} ${f.why}`);
  }
  L.push('');

  L.push('  RE-CHECK AT 5 MINUTES:');
  for (const f of s.recheck5MinFields) {
    L.push(`    [${f.priority}] ${f.field.padEnd(20)} ${f.why}`);
  }
  L.push('');

  L.push('  UPGRADE CONDITIONS  (→ WATCH_READY_FOR_PAPER_OBSERVATION):');
  for (const c of s.upgradeConditions) {
    L.push(`    + ${c}`);
  }
  L.push('');

  L.push('  DOWNGRADE CONDITIONS  (→ reject or observe-only):');
  for (const c of s.downgradeConditions) {
    L.push(`    - ${c}`);
  }
  L.push('');

  // ── Safety ────────────────────────────────────────────────────────────────
  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true  READ_ONLY=true  NO_POLICY_CHANGE=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING  tradingExecuted=0  realTradingLocked=true');
  L.push('  paperOnly=true  reportOnly=true');
  L.push('  This plan is observational. No gate, autopilot, or policy logic modified.');
  L.push(SEP, '');
  return L.join('\n');
}
