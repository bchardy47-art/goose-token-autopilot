// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE
//
// Historical Winner Replay — verifies whether Winner Brain patterns are real
// executable signals or data artifacts. Reads learning-memory.jsonl only.
// Does NOT change any gate, policy, or decision.

import * as fs from 'fs';

// ── Focus pattern definitions ─────────────────────────────────────────────────

export interface FocusPatternDef {
  name:    string;
  label:   string;
  matches: (row: MemoryRow) => boolean;
}

interface MemoryRow {
  contract?:              string;
  outcomeLabel?:          string | null;
  priceChangePct?:        number | null;
  launchAgeBucket?:       string | null;
  liquidityBucket?:       string | null;
  liquidityUsd?:          number | null;
  clusterRisk?:           string | null;
  ripperScore?:           number | null;
  vlrBucket?:             string | null;
  timingPath?:            string | null;
  entryDecision?:         string | null;
  gateDecision?:          string | null;
  wouldRejectByLiqOrAge?: boolean | null;
  ageMinutes?:            number | null;
  capturedAt?:            string | null;
  observedAt?:            string | null;
  memoryUniverse?:        string | null;
  sourceFiles?:           string[] | null;
}

export const FOCUS_PATTERN_DEFS: FocusPatternDef[] = [
  {
    name:    'LIQ_UNKNOWN+WATCH+ENTER_NOW',
    label:   'liquidityBucket=LIQ_UNKNOWN + clusterRisk=WATCH + timingPath=ENTER_NOW',
    matches: r =>
      r.liquidityBucket === 'LIQ_UNKNOWN' &&
      r.clusterRisk     === 'WATCH' &&
      r.timingPath      === 'ENTER_NOW',
  },
  {
    name:    'LIQ_UNKNOWN+WATCH',
    label:   'liquidityBucket=LIQ_UNKNOWN + clusterRisk=WATCH',
    matches: r =>
      r.liquidityBucket === 'LIQ_UNKNOWN' &&
      r.clusterRisk     === 'WATCH',
  },
  {
    name:    'VLR_UNKNOWN+WATCH+ENTER_NOW',
    label:   'vlrBucket=VLR_UNKNOWN + clusterRisk=WATCH + timingPath=ENTER_NOW',
    matches: r =>
      r.vlrBucket   === 'VLR_UNKNOWN' &&
      r.clusterRisk === 'WATCH' &&
      r.timingPath  === 'ENTER_NOW',
  },
  {
    name:    'VLR_UNKNOWN+WATCH',
    label:   'vlrBucket=VLR_UNKNOWN + clusterRisk=WATCH',
    matches: r =>
      r.vlrBucket   === 'VLR_UNKNOWN' &&
      r.clusterRisk === 'WATCH',
  },
  {
    name:    'LIQ_LT_10K+PRIME_WINDOW',
    label:   'liquidityBucket=LIQ_LT_10K + launchAgeBucket=PRIME_WINDOW',
    matches: r =>
      r.liquidityBucket === 'LIQ_LT_10K' &&
      r.launchAgeBucket === 'PRIME_WINDOW',
  },
];

// ── Result types ──────────────────────────────────────────────────────────────

export type ArtifactRisk = 'HIGH' | 'MEDIUM' | 'LOW';
export type ReplayVerdict =
  | 'LIKELY_ARTIFACT'
  | 'UNCERTAIN'
  | 'LIKELY_REAL_SIGNAL'
  | 'REAL_BUT_GATED_OUT';

export interface ExecutabilityStats {
  entryDecisionCounts: Record<string, number>;
  gateDecisionCounts:  Record<string, number>;
  ageMinutesMin:       number | null;
  ageMinutesMax:       number | null;
  ageMinutesAvg:       number | null;
  liquidityUsdMin:     number | null;
  liquidityUsdMax:     number | null;
  liquidityUsdNullPct: number;   // 0–1
  ripperScoreMin:      number | null;
  ripperScoreMax:      number | null;
  ripperScoreAvg:      number | null;
  wouldRejectByGatePct: number;  // 0–1
}

export interface ArtifactWarning {
  liquidityUsdAllNull:    boolean;
  vlrUnknownPct:          number;   // 0–1
  liqUnknownPct:          number;   // 0–1
  labeledCoveragePct:     number;   // 0–1 — labeled/total
  unlabeledPct:           number;   // 0–1 — UNKNOWN outcome / total
  // Win5 rate vs pessimistic lower bound (assuming all unlabeled = loss)
  observedWin5Rate:       number | null;  // win5 / labeled
  pessimisticWin5Rate:    number | null;  // win5 / total
  // Source file concentration
  topSourceFile:          string | null;
  topSourceFilePct:       number;   // fraction of rows citing that file
  // Date range of UNKNOWN-outcome rows in this pattern
  unlabeledDateRange:     { earliest: string; latest: string } | null;
  artifactRisk:           ArtifactRisk;
  artifactNotes:          string[];
}

export interface FocusPatternResult {
  name:          string;
  label:         string;
  total:         number;
  uniqueContracts: number;
  labeled:       number;
  unlabeled:     number;    // UNKNOWN outcome rows
  bigWinner:     number;
  winner:        number;
  smallWinner:   number;
  dump:          number;
  flatJunk:      number;
  win5Rate:      number | null;  // of labeled rows
  win3Rate:      number | null;
  winAnyRate:    number | null;
  flatDumpRate:  number | null;
  avgMove:       number | null;
  medianMove:    number | null;
  bestMove:      number | null;
  worstMove:     number | null;
  executability: ExecutabilityStats;
  artifact:      ArtifactWarning;
  verdict:       ReplayVerdict;
  verdictNote:   string;
}

export interface ReplayDoNotBlockEntry {
  patternName: string;
  win5Rate:    number;
  total:       number;
  labeled:     number;
  blockedPct:  number;   // wouldRejectByLiqOrAge=true fraction
  note:        string;
}

export interface HistoricalWinnerReplayResult {
  totalMemoryRows:    number;
  baselineWin5Rate:   number | null;
  patterns:           FocusPatternResult[];
  doNotBlockPatterns: ReplayDoNotBlockEntry[];
  reportOnly:         true;
  readOnly:           true;
  paperOnly:          true;
  realTradingLocked:  true;
  tradingExecuted:    0;
}

export interface HistoricalWinnerReplayOptions {
  learningMemoryPath?: string;
  patterns?:           FocusPatternDef[];  // override for tests
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function avg(arr: number[]): number | null {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function countBy<T>(arr: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of arr) {
    const k = key(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function topKey(counts: Record<string, number>): [string | null, number] {
  let best: [string | null, number] = [null, 0];
  for (const [k, v] of Object.entries(counts)) {
    if (v > best[1]) best = [k, v];
  }
  return best;
}

function buildArtifactWarning(rows: MemoryRow[], baselineWin5Rate: number | null): ArtifactWarning {
  const total    = rows.length;
  const labeled  = rows.filter(r => r.outcomeLabel && r.outcomeLabel !== 'UNKNOWN');
  const unlabeled = rows.filter(r => !r.outcomeLabel || r.outcomeLabel === 'UNKNOWN');
  const liqNull  = rows.filter(r => r.liquidityUsd == null).length;
  const liqUnk   = rows.filter(r => r.liquidityBucket === 'LIQ_UNKNOWN').length;
  const vlrUnk   = rows.filter(r => r.vlrBucket === 'VLR_UNKNOWN').length;

  const win5 = labeled.filter(r =>
    r.outcomeLabel === 'BIG_WINNER' || r.outcomeLabel === 'WINNER').length;
  const observedWin5Rate  = labeled.length > 0 ? win5 / labeled.length : null;
  const pessimisticWin5Rate = total > 0 ? win5 / total : null;

  // Source file concentration
  const allSources: string[] = [];
  for (const r of rows) {
    for (const s of r.sourceFiles ?? []) allSources.push(s);
  }
  const sourceCounts = countBy(allSources, s => s);
  const [topSrc, topSrcCount] = topKey(sourceCounts);
  const topSourceFilePct = allSources.length > 0 ? topSrcCount / total : 0;

  // Date range of unlabeled (UNKNOWN outcome) rows
  const unlabeledDates = unlabeled
    .map(r => r.capturedAt ?? r.observedAt ?? null)
    .filter((d): d is string => typeof d === 'string')
    .sort();
  const unlabeledDateRange = unlabeledDates.length >= 2
    ? { earliest: unlabeledDates[0]!.slice(0, 10), latest: unlabeledDates[unlabeledDates.length - 1]!.slice(0, 10) }
    : null;

  const labeledCoveragePct = total > 0 ? labeled.length / total : 0;
  const unlabeledPct       = total > 0 ? unlabeled.length / total : 0;
  const liquidityUsdAllNull = total > 0 && liqNull === total;

  // Artifact risk assessment
  const notes: string[] = [];
  let artifactRisk: ArtifactRisk = 'LOW';

  if (liquidityUsdAllNull) {
    notes.push('liquidityUsd=null for ALL rows — tokens captured before liquidity was measured.');
    artifactRisk = 'HIGH';
  }
  if (unlabeledPct > 0.50) {
    notes.push(`${(unlabeledPct * 100).toFixed(0)}% of rows have UNKNOWN outcome — labeled subset may not be representative.`);
    artifactRisk = 'HIGH';
  } else if (unlabeledPct > 0.30) {
    notes.push(`${(unlabeledPct * 100).toFixed(0)}% of rows have UNKNOWN outcome — some survivorship risk.`);
    if (artifactRisk === 'LOW') artifactRisk = 'MEDIUM';
  }
  if (
    observedWin5Rate != null &&
    pessimisticWin5Rate != null &&
    observedWin5Rate - pessimisticWin5Rate > 0.20
  ) {
    notes.push(
      `Observed win5=${(observedWin5Rate * 100).toFixed(0)}% vs pessimistic lower bound ${(pessimisticWin5Rate * 100).toFixed(0)}% — ` +
      `large gap suggests unlabeled rows are NOT random; winners over-represented in labeled set.`
    );
    if (artifactRisk !== 'HIGH') artifactRisk = 'MEDIUM';
  }
  if (baselineWin5Rate != null && observedWin5Rate != null && observedWin5Rate > 0.50) {
    notes.push(
      `win5 rate of ${(observedWin5Rate * 100).toFixed(0)}% is >2x the global baseline of ${(baselineWin5Rate * 100).toFixed(0)}%; ` +
      `verify with pessimistic bound before trusting.`
    );
  }
  if (liqUnk === total && total > 0) {
    notes.push('ALL rows are LIQ_UNKNOWN — this bucket captures tokens whose liquidity was never measured at capture time.');
  }
  if (notes.length === 0) {
    notes.push('No major artifact flags detected.');
  }

  return {
    liquidityUsdAllNull,
    vlrUnknownPct: total > 0 ? vlrUnk / total : 0,
    liqUnknownPct: total > 0 ? liqUnk / total : 0,
    labeledCoveragePct,
    unlabeledPct,
    observedWin5Rate,
    pessimisticWin5Rate,
    topSourceFile: topSrc,
    topSourceFilePct,
    unlabeledDateRange,
    artifactRisk,
    artifactNotes: notes,
  };
}

function buildVerdict(result: Omit<FocusPatternResult, 'verdict' | 'verdictNote'>): {
  verdict: ReplayVerdict;
  verdictNote: string;
} {
  const a = result.artifact;

  if (a.artifactRisk === 'HIGH') {
    // Check if pessimistic rate still has edge
    const pessimBeatBaseline = a.pessimisticWin5Rate != null && a.pessimisticWin5Rate >= 0.18;
    if (pessimBeatBaseline) {
      return {
        verdict: 'UNCERTAIN',
        verdictNote:
          `Artifact risk HIGH but even the pessimistic lower bound (${(a.pessimisticWin5Rate! * 100).toFixed(0)}%) ` +
          `approaches or beats the global baseline. Pattern may have partial real signal. ` +
          `Cannot confirm without fresh observation data on matched tokens.`,
      };
    }
    return {
      verdict: 'LIKELY_ARTIFACT',
      verdictNote:
        `Artifact risk HIGH. All rows have null liquidityUsd and ${(a.unlabeledPct * 100).toFixed(0)}% are unlabeled. ` +
        `The observed win5 rate of ${(a.observedWin5Rate != null ? (a.observedWin5Rate * 100).toFixed(0) : '?')}% ` +
        `collapses to ${(a.pessimisticWin5Rate != null ? (a.pessimisticWin5Rate * 100).toFixed(0) : '?')}% when unlabeled rows ` +
        `are treated as losses. Labeled subset is heavily winner-biased (survivorship/observation selection bias). ` +
        `Do NOT use this pattern as a trading signal without independent verification.`,
    };
  }

  if (a.artifactRisk === 'MEDIUM') {
    return {
      verdict: 'UNCERTAIN',
      verdictNote:
        `Artifact risk MEDIUM. Labeled coverage is ${(a.labeledCoveragePct * 100).toFixed(0)}%. ` +
        `Observed win5 ${(a.observedWin5Rate != null ? (a.observedWin5Rate * 100).toFixed(0) : '?')}% ` +
        `vs pessimistic ${(a.pessimisticWin5Rate != null ? (a.pessimisticWin5Rate * 100).toFixed(0) : '?')}%. ` +
        `Needs more out-of-sample coverage before trusting.`,
    };
  }

  // LOW artifact risk
  const win5 = result.win5Rate ?? 0;
  if (result.executability.wouldRejectByGatePct >= 0.95 && win5 >= 0.18) {
    return {
      verdict: 'REAL_BUT_GATED_OUT',
      verdictNote:
        `Sufficient data quality (${(a.labeledCoveragePct * 100).toFixed(0)}% labeled, real liq data). ` +
        `win5=${(win5 * 100).toFixed(0)}% on n=${result.labeled}. ` +
        `However ${(result.executability.wouldRejectByGatePct * 100).toFixed(0)}% of matches are blocked by current gate. ` +
        `Pattern is real but needs gate relaxation to capture.`,
    };
  }

  return {
    verdict: 'LIKELY_REAL_SIGNAL',
    verdictNote:
      `Sufficient data quality (${(a.labeledCoveragePct * 100).toFixed(0)}% labeled, real liq data). ` +
      `win5=${(win5 * 100).toFixed(0)}% on n=${result.labeled}. Pattern appears executable.`,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runHistoricalWinnerReplay(
  options: HistoricalWinnerReplayOptions = {},
): HistoricalWinnerReplayResult {
  const memPath  = options.learningMemoryPath
    ?? 'data/token-grab/ripper/learning-memory.jsonl';
  const patterns = options.patterns ?? FOCUS_PATTERN_DEFS;

  const allRows: MemoryRow[] = [];
  for (const line of readLines(memPath)) {
    try {
      const r = JSON.parse(line) as MemoryRow;
      if (typeof r.contract === 'string') allRows.push(r);
    } catch { /* skip */ }
  }

  // Global baseline
  const globalLabeled = allRows.filter(r => r.outcomeLabel && r.outcomeLabel !== 'UNKNOWN');
  const globalWin5 = globalLabeled.filter(r =>
    r.outcomeLabel === 'BIG_WINNER' || r.outcomeLabel === 'WINNER').length;
  const baselineWin5Rate = globalLabeled.length > 0 ? globalWin5 / globalLabeled.length : null;

  // Per-pattern analysis
  const patternResults: FocusPatternResult[] = [];

  for (const def of patterns) {
    const matched = allRows.filter(def.matches);
    const labeled = matched.filter(r => r.outcomeLabel && r.outcomeLabel !== 'UNKNOWN');
    const unlabeled = matched.filter(r => !r.outcomeLabel || r.outcomeLabel === 'UNKNOWN');
    const contracts = new Set(matched.map(r => r.contract ?? '').filter(Boolean));

    const bigWinner  = labeled.filter(r => r.outcomeLabel === 'BIG_WINNER').length;
    const winner     = labeled.filter(r => r.outcomeLabel === 'WINNER').length;
    const smallWinner = labeled.filter(r => r.outcomeLabel === 'SMALL_WINNER').length;
    const dump       = labeled.filter(r => r.outcomeLabel === 'DUMP').length;
    const flatJunk   = labeled.filter(r => r.outcomeLabel === 'FLAT_JUNK').length;
    const win5       = bigWinner + winner;
    const winAny     = bigWinner + winner + smallWinner;
    const flatDump   = dump + flatJunk;

    const prices = labeled
      .map(r => r.priceChangePct)
      .filter((v): v is number => v != null);
    const ages   = matched.map(r => r.ageMinutes).filter((v): v is number => v != null);
    const liqs   = matched.map(r => r.liquidityUsd).filter((v): v is number => v != null);
    const scores = matched.map(r => r.ripperScore).filter((v): v is number => v != null);
    const liqNulls = matched.filter(r => r.liquidityUsd == null).length;
    const blocked  = matched.filter(r => r.wouldRejectByLiqOrAge === true).length;

    const lN = labeled.length;
    const win5Rate    = lN > 0 ? win5    / lN : null;
    const win3Rate    = lN > 0 ? (bigWinner + winner + smallWinner) / lN : null;
    const winAnyRate  = lN > 0 ? winAny  / lN : null;
    const flatDumpRate = lN > 0 ? flatDump / lN : null;

    const executability: ExecutabilityStats = {
      entryDecisionCounts: countBy(matched, r => r.entryDecision ?? 'null'),
      gateDecisionCounts:  countBy(matched, r => r.gateDecision  ?? 'null'),
      ageMinutesMin: ages.length > 0 ? Math.min(...ages) : null,
      ageMinutesMax: ages.length > 0 ? Math.max(...ages) : null,
      ageMinutesAvg: avg(ages),
      liquidityUsdMin: liqs.length > 0 ? Math.min(...liqs) : null,
      liquidityUsdMax: liqs.length > 0 ? Math.max(...liqs) : null,
      liquidityUsdNullPct: matched.length > 0 ? liqNulls / matched.length : 0,
      ripperScoreMin: scores.length > 0 ? Math.min(...scores) : null,
      ripperScoreMax: scores.length > 0 ? Math.max(...scores) : null,
      ripperScoreAvg: avg(scores),
      wouldRejectByGatePct: matched.length > 0 ? blocked / matched.length : 0,
    };

    const artifactWarning = buildArtifactWarning(matched, baselineWin5Rate);

    const partial = {
      name: def.name,
      label: def.label,
      total: matched.length,
      uniqueContracts: contracts.size,
      labeled: lN,
      unlabeled: unlabeled.length,
      bigWinner, winner, smallWinner, dump, flatJunk,
      win5Rate, win3Rate, winAnyRate, flatDumpRate,
      avgMove:    avg(prices),
      medianMove: median(prices),
      bestMove:   prices.length > 0 ? Math.max(...prices) : null,
      worstMove:  prices.length > 0 ? Math.min(...prices) : null,
      executability,
      artifact: artifactWarning,
    };

    const { verdict, verdictNote } = buildVerdict(partial);
    patternResults.push({ ...partial, verdict, verdictNote });
  }

  // Do-not-block section: high win5 rate but mostly gate-blocked
  const doNotBlock: ReplayDoNotBlockEntry[] = patternResults
    .filter(p =>
      p.win5Rate != null && p.win5Rate >= 0.20 &&
      p.executability.wouldRejectByGatePct > 0 &&
      p.labeled >= 10 &&
      p.artifact.artifactRisk !== 'HIGH'
    )
    .map(p => ({
      patternName: p.name,
      win5Rate:    p.win5Rate!,
      total:       p.total,
      labeled:     p.labeled,
      blockedPct:  p.executability.wouldRejectByGatePct,
      note: `win5=${(p.win5Rate! * 100).toFixed(0)}% on ${p.labeled} labeled rows; ` +
            `${(p.executability.wouldRejectByGatePct * 100).toFixed(0)}% of all matches blocked by gate.`,
    }))
    .sort((a, b) => b.win5Rate - a.win5Rate);

  return {
    totalMemoryRows: allRows.length,
    baselineWin5Rate,
    patterns: patternResults,
    doNotBlockPatterns: doNotBlock,
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function pct(v: number | null | undefined, digits = 1): string {
  return v == null ? 'n/a' : `${(v * 100).toFixed(digits)}%`;
}

function numStr(v: number | null | undefined, digits = 1): string {
  return v == null ? 'n/a' : v.toFixed(digits);
}

function riskTag(risk: ArtifactRisk): string {
  return risk === 'HIGH' ? '[HIGH ARTIFACT RISK]' :
         risk === 'MEDIUM' ? '[MEDIUM ARTIFACT RISK]' : '[LOW ARTIFACT RISK]';
}

function verdictTag(v: ReplayVerdict): string {
  return `[${v}]`;
}

export function renderHistoricalWinnerReplay(
  result: HistoricalWinnerReplayResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — HISTORICAL WINNER REPLAY v1');
  lines.push('  [REPORT ONLY — NO TRADES — NO POLICY CHANGES — READ ONLY]');
  lines.push('  Verifying whether Winner Brain patterns are real signals or artifacts.');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  OVERVIEW');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Memory rows read    : ${result.totalMemoryRows}`);
  lines.push(`  Baseline win5 rate  : ${pct(result.baselineWin5Rate)}  (global labeled, BIG_WINNER|WINNER)`);
  lines.push('');

  // ── Per-pattern ───────────────────────────────────────────────────────────
  for (const p of result.patterns) {
    lines.push(`  ${SEP2}`);
    lines.push(`  PATTERN: ${p.name}`);
    lines.push(`  Label  : ${p.label}`);
    lines.push(`  ${SEP2}`, '');

    lines.push(`  Coverage`);
    lines.push(`    total rows       : ${p.total}`);
    lines.push(`    unique contracts : ${p.uniqueContracts}`);
    lines.push(`    labeled          : ${p.labeled}  (${pct(p.labeled / Math.max(p.total,1), 0)} coverage)`);
    lines.push(`    unlabeled        : ${p.unlabeled}  (UNKNOWN outcome)`);
    lines.push('');

    lines.push(`  Outcome distribution  (of labeled rows)`);
    lines.push(`    BIG_WINNER  : ${p.bigWinner}  (${pct(p.bigWinner / Math.max(p.labeled,1))})`);
    lines.push(`    WINNER      : ${p.winner}  (${pct(p.winner / Math.max(p.labeled,1))})`);
    lines.push(`    SMALL_WINNER: ${p.smallWinner}  (${pct(p.smallWinner / Math.max(p.labeled,1))})`);
    lines.push(`    FLAT_JUNK   : ${p.flatJunk}  (${pct(p.flatJunk / Math.max(p.labeled,1))})`);
    lines.push(`    DUMP        : ${p.dump}  (${pct(p.dump / Math.max(p.labeled,1))})`);
    lines.push('');
    lines.push(`    win5 rate   : ${pct(p.win5Rate)}  (BIG+WINNER of labeled)`);
    lines.push(`    winAny rate : ${pct(p.winAnyRate)}`);
    lines.push(`    flatDump    : ${pct(p.flatDumpRate)}`);
    lines.push('');

    lines.push(`  Price movement  (of labeled rows with priceChangePct)`);
    lines.push(`    avg          : ${numStr(p.avgMove)}%`);
    lines.push(`    median       : ${numStr(p.medianMove)}%`);
    lines.push(`    best         : ${numStr(p.bestMove)}%`);
    lines.push(`    worst        : ${numStr(p.worstMove)}%`);
    lines.push('');

    const e = p.executability;
    lines.push(`  Executability`);
    lines.push(`    liqUsd null  : ${pct(e.liquidityUsdNullPct)}  of matched rows`);
    if (e.liquidityUsdMin != null) {
      lines.push(`    liqUsd range : $${e.liquidityUsdMin.toFixed(0)} – $${e.liquidityUsdMax!.toFixed(0)}`);
    }
    lines.push(`    ageMinutes   : ${numStr(e.ageMinutesMin)} – ${numStr(e.ageMinutesMax)}  (avg ${numStr(e.ageMinutesAvg)} min)`);
    lines.push(`    ripperScore  : ${numStr(e.ripperScoreMin, 0)} – ${numStr(e.ripperScoreMax, 0)}  (avg ${numStr(e.ripperScoreAvg, 0)})`);
    lines.push(`    gateBlocked  : ${pct(e.wouldRejectByGatePct)}  (wouldRejectByLiqOrAge=true)`);
    lines.push(`    entryDecision: ${JSON.stringify(e.entryDecisionCounts)}`);
    lines.push(`    gateDecision : ${JSON.stringify(e.gateDecisionCounts)}`);
    lines.push('');

    const art = p.artifact;
    lines.push(`  Artifact Warning  ${riskTag(art.artifactRisk)}`);
    lines.push(`    labeled coverage  : ${pct(art.labeledCoveragePct)}`);
    lines.push(`    unlabeled (UNKN)  : ${pct(art.unlabeledPct)}`);
    lines.push(`    observed win5     : ${pct(art.observedWin5Rate)}  (win5 / labeled)`);
    lines.push(`    pessimistic win5  : ${pct(art.pessimisticWin5Rate)}  (win5 / total — treats unlabeled as losses)`);
    lines.push(`    liqUsd all null   : ${art.liquidityUsdAllNull}`);
    if (art.topSourceFile) {
      lines.push(`    top source file   : ${art.topSourceFile} (${pct(art.topSourceFilePct)} of rows)`);
    }
    if (art.unlabeledDateRange) {
      lines.push(`    unlabeled dates   : ${art.unlabeledDateRange.earliest} → ${art.unlabeledDateRange.latest}`);
    }
    for (const note of art.artifactNotes) {
      lines.push(`    ⚠  ${note}`);
    }
    lines.push('');

    lines.push(`  Verdict  ${verdictTag(p.verdict)}`);
    lines.push(`    ${p.verdictNote}`);
    lines.push('');
  }

  // ── Do-not-block ──────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  DO-NOT-BLOCK PATTERNS  (win5Rate≥20%, non-artifact, but gate rejects)');
  lines.push(`  ${SEP2}`, '');
  if (result.doNotBlockPatterns.length === 0) {
    lines.push('  None above threshold (may be artifact-filtered or gate not blocking).');
    lines.push('');
  } else {
    for (const p of result.doNotBlockPatterns) {
      lines.push(`  ${p.patternName}`);
      lines.push(`    ${p.note}`);
      lines.push('');
    }
  }

  // ── Safety ────────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  REPORT_ONLY=true  READ_ONLY=true  NO_POLICY_CHANGE=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING  tradingExecuted=0  realTradingLocked=true');
  lines.push('  paperOnly=true  reportOnly=true');
  lines.push('  This replay analysis is observational only.');
  lines.push('  NOT wired into any gate, autopilot, or decision path.');
  lines.push(SEP, '');
  return lines.join('\n');
}
