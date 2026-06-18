// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE
//
// Historical Winner Brain — studies past winners to identify pre-rip fingerprints.
// Reads learning-memory.jsonl ONLY. Does NOT change any gate, policy, or decision.
// Output is observational report only.

import * as fs from 'fs';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutcomeLabel =
  | 'BIG_WINNER' | 'WINNER' | 'SMALL_WINNER'
  | 'FLAT_JUNK' | 'DUMP' | 'UNKNOWN';

export type MatcherLabel =
  | 'MATCH_STRONG_ENTER_NOW'
  | 'MATCH_MEDIUM_WAIT_2M'
  | 'MATCH_WEAK_OBSERVE_ONLY'
  | 'NO_WINNER_PATTERN_REJECT';

interface MemoryRow {
  contract?:           string;
  outcomeLabel?:       string | null;
  priceChangePct?:     number | null;
  launchAgeBucket?:    string | null;
  liquidityBucket?:    string | null;
  clusterRisk?:        string | null;
  ripperScore?:        number | null;
  vlrBucket?:          string | null;
  timingPath?:         string | null;
  entryDecision?:      string | null;
  gateDecision?:       string | null;
  wouldRejectByLiqOrAge?: boolean | null;
  blockedByLowLiquidity?: boolean | null;
  blockedByAgeGte10m?:    boolean | null;
  memoryUniverse?:     string | null;
}

export interface PatternStats {
  key:             string;
  featureValues:   Record<string, string | null>;
  total:           number;   // labeled rows matching
  win5:            number;   // BIG_WINNER | WINNER
  winners:         number;   // any winner (incl. SMALL_WINNER)
  flatDump:        number;   // FLAT_JUNK | DUMP
  win5Rate:        number;   // 0–1
  winRate:         number;
  flatDumpRate:    number;
  avgMove:         number | null;
  medianMove:      number | null;
  win5Lift:        number | null;   // vs global baseline
  blockedByGate:   number;          // wouldRejectByLiqOrAge=true count
  blockedButWon:   number;          // blocked AND any winner
  matcherLabel:    MatcherLabel;
}

export interface HistoricalWinnerBrainResult {
  // ── Baseline ──
  totalLabeled:       number;   // rows with non-UNKNOWN outcome
  totalWinners:       number;   // any winner
  totalWin5:          number;   // BIG+WINNER
  totalFlatDump:      number;
  baselineWinRate:    number;
  baselineWin5Rate:   number;
  baselineFlatDumpRate: number;

  // ── Pattern sections ──
  featurePatterns:       PatternStats[];   // per single-feature-value, all combos
  topWinnerPatterns:     PatternStats[];   // top 2+3 feature combos by lift × count
  falseNegativePatterns: PatternStats[];   // high-win combos where gate blocks them
  doNotBlockPatterns:    PatternStats[];   // win5Rate > threshold but wouldReject
  junkHeavyPatterns:     PatternStats[];   // flatDumpRate > 70%

  // ── Matcher assignments ──
  matcherSummary: Record<MatcherLabel, number>;  // counts per label in topWinnerPatterns

  // ── Safety ──
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface HistoricalWinnerBrainOptions {
  learningMemoryPath?: string;
  minPatternSample?:   number;  // minimum rows per pattern (default 10)
  topN?:               number;  // patterns to show per section (default 20)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

function isWin5(label: string | null | undefined): boolean {
  return label === 'BIG_WINNER' || label === 'WINNER';
}

function isAnyWinner(label: string | null | undefined): boolean {
  return label === 'BIG_WINNER' || label === 'WINNER' || label === 'SMALL_WINNER';
}

function isFlatDump(label: string | null | undefined): boolean {
  return label === 'FLAT_JUNK' || label === 'DUMP';
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function assignMatcherLabel(
  win5Rate: number,
  win5Lift: number | null,
  timingPath: string | null,
  flatDumpRate: number,
): MatcherLabel {
  if (flatDumpRate > 0.70) return 'NO_WINNER_PATTERN_REJECT';
  if (win5Rate >= 0.32 && (win5Lift == null || win5Lift >= 1.4) && timingPath === 'ENTER_NOW') {
    return 'MATCH_STRONG_ENTER_NOW';
  }
  if (win5Rate >= 0.24 && (win5Lift == null || win5Lift >= 1.1)) {
    return 'MATCH_MEDIUM_WAIT_2M';
  }
  if (win5Rate >= 0.14 && (win5Lift == null || win5Lift >= 0.9)) {
    return 'MATCH_WEAK_OBSERVE_ONLY';
  }
  return 'NO_WINNER_PATTERN_REJECT';
}

function buildStats(
  rows: MemoryRow[],
  key: string,
  featureValues: Record<string, string | null>,
  baselineWin5Rate: number,
): PatternStats {
  let win5 = 0, winners = 0, flatDump = 0, blockedByGate = 0, blockedButWon = 0;
  const moves: number[] = [];

  for (const r of rows) {
    const lbl = r.outcomeLabel ?? null;
    if (isWin5(lbl))      win5++;
    if (isAnyWinner(lbl)) winners++;
    if (isFlatDump(lbl))  flatDump++;
    if (r.priceChangePct != null) moves.push(r.priceChangePct);
    if (r.wouldRejectByLiqOrAge === true) {
      blockedByGate++;
      if (isAnyWinner(lbl)) blockedButWon++;
    }
  }

  const total = rows.length;
  const win5Rate     = total > 0 ? win5     / total : 0;
  const winRate      = total > 0 ? winners  / total : 0;
  const flatDumpRate = total > 0 ? flatDump / total : 0;
  const avgMove      = moves.length > 0 ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
  const win5Lift     = baselineWin5Rate > 0 ? win5Rate / baselineWin5Rate : null;

  // single timing value if all rows have same path
  const timingValues = new Set(rows.map(r => r.timingPath ?? null));
  const singleTiming = timingValues.size === 1 ? [...timingValues][0] : null;

  return {
    key,
    featureValues,
    total,
    win5,
    winners,
    flatDump,
    win5Rate,
    winRate,
    flatDumpRate,
    avgMove,
    medianMove: median(moves),
    win5Lift,
    blockedByGate,
    blockedButWon,
    matcherLabel: assignMatcherLabel(win5Rate, win5Lift, singleTiming, flatDumpRate),
  };
}

// ── Combo miner ───────────────────────────────────────────────────────────────

type FeatureGetter = (r: MemoryRow) => string | null;

const FEATURE_GETTERS: Record<string, FeatureGetter> = {
  liquidityBucket: r => r.liquidityBucket ?? null,
  vlrBucket:       r => r.vlrBucket       ?? null,
  clusterRisk:     r => r.clusterRisk     ?? null,
  timingPath:      r => r.timingPath      ?? null,
  launchAgeBucket: r => r.launchAgeBucket ?? null,
  gateDecision:    r => r.gateDecision    ?? null,
  wouldRejectByLiqOrAge: r => r.wouldRejectByLiqOrAge == null
    ? null
    : String(r.wouldRejectByLiqOrAge),
};

function minePatterns(
  rows: MemoryRow[],
  featureNames: string[],
  baselineWin5Rate: number,
  minSample: number,
): PatternStats[] {
  const buckets = new Map<string, MemoryRow[]>();

  for (const row of rows) {
    const vals: (string | null)[] = featureNames.map(f => FEATURE_GETTERS[f]!(row));
    // skip rows where any feature is null
    if (vals.some(v => v === null)) continue;
    const key = vals.join(' | ');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(row);
  }

  const patterns: PatternStats[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.length < minSample) continue;
    const vals = key.split(' | ');
    const featureValues: Record<string, string | null> = {};
    featureNames.forEach((f, i) => { featureValues[f] = vals[i] ?? null; });
    patterns.push(buildStats(bucket, key, featureValues, baselineWin5Rate));
  }
  return patterns;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runHistoricalWinnerBrain(
  options: HistoricalWinnerBrainOptions = {},
): HistoricalWinnerBrainResult {
  const memoryPath  = options.learningMemoryPath
    ?? 'data/token-grab/ripper/learning-memory.jsonl';
  const minSample   = options.minPatternSample ?? 10;
  const topN        = options.topN ?? 20;

  // ── 1. Load rows ──────────────────────────────────────────────────────────

  const allRows: MemoryRow[] = [];
  for (const line of readLines(memoryPath)) {
    try {
      const r = JSON.parse(line) as MemoryRow;
      if (typeof r.contract === 'string') allRows.push(r);
    } catch { /* skip */ }
  }

  // Only labeled (non-UNKNOWN) rows for pattern analysis
  const labeled = allRows.filter(r => r.outcomeLabel && r.outcomeLabel !== 'UNKNOWN');

  let totalWin5 = 0, totalWinners = 0, totalFlatDump = 0;
  for (const r of labeled) {
    if (isWin5(r.outcomeLabel))      totalWin5++;
    if (isAnyWinner(r.outcomeLabel)) totalWinners++;
    if (isFlatDump(r.outcomeLabel))  totalFlatDump++;
  }

  const totalLabeled = labeled.length;
  const baselineWin5Rate     = totalLabeled > 0 ? totalWin5     / totalLabeled : 0;
  const baselineWinRate      = totalLabeled > 0 ? totalWinners  / totalLabeled : 0;
  const baselineFlatDumpRate = totalLabeled > 0 ? totalFlatDump / totalLabeled : 0;

  // ── 2. Single-feature patterns ────────────────────────────────────────────

  const singleFeatureNames = [
    'liquidityBucket',
    'vlrBucket',
    'clusterRisk',
    'timingPath',
    'launchAgeBucket',
    'gateDecision',
    'wouldRejectByLiqOrAge',
  ];
  const featurePatterns: PatternStats[] = [];
  for (const feat of singleFeatureNames) {
    const patterns = minePatterns(labeled, [feat], baselineWin5Rate, minSample);
    featurePatterns.push(...patterns);
  }
  featurePatterns.sort((a, b) => (b.win5Lift ?? 0) - (a.win5Lift ?? 0));

  // ── 3. 2-feature combos ───────────────────────────────────────────────────

  const comboDefs2: [string, string][] = [
    ['liquidityBucket', 'vlrBucket'],
    ['liquidityBucket', 'clusterRisk'],
    ['liquidityBucket', 'timingPath'],
    ['vlrBucket',       'clusterRisk'],
    ['vlrBucket',       'timingPath'],
    ['clusterRisk',     'timingPath'],
    ['liquidityBucket', 'launchAgeBucket'],
    ['vlrBucket',       'launchAgeBucket'],
  ];

  const allCombo2: PatternStats[] = [];
  for (const [a, b] of comboDefs2) {
    allCombo2.push(...minePatterns(labeled, [a, b], baselineWin5Rate, minSample));
  }

  // ── 4. 3-feature combos ───────────────────────────────────────────────────

  const comboDefs3: [string, string, string][] = [
    ['liquidityBucket', 'vlrBucket',    'clusterRisk'],
    ['liquidityBucket', 'vlrBucket',    'timingPath'],
    ['liquidityBucket', 'clusterRisk',  'timingPath'],
    ['vlrBucket',       'clusterRisk',  'timingPath'],
    ['liquidityBucket', 'vlrBucket',    'launchAgeBucket'],
  ];

  const allCombo3: PatternStats[] = [];
  for (const [a, b, c] of comboDefs3) {
    allCombo3.push(...minePatterns(labeled, [a, b, c], baselineWin5Rate, minSample));
  }

  // ── 5. Merge and rank ─────────────────────────────────────────────────────

  const allCombos = [...allCombo2, ...allCombo3];
  // Score: lift * log(count+1) to balance lift with significance
  const scored = allCombos.map(p => ({
    p,
    score: (p.win5Lift ?? 0) * Math.log(p.total + 1),
  }));
  scored.sort((a, b) => b.score - a.score);
  const topWinnerPatterns = scored.slice(0, topN).map(x => x.p);

  // ── 6. False negatives — winners blocked by gate ──────────────────────────

  const falseNegPatterns: PatternStats[] = allCombos
    .filter(p => p.blockedButWon > 0 && p.winners >= 5)
    .map(p => ({ ...p, _fnScore: (p.blockedButWon / p.winners) * p.blockedButWon } as PatternStats & { _fnScore: number }))
    .sort((a: any, b: any) => b._fnScore - a._fnScore)
    .slice(0, topN) as PatternStats[];

  // ── 7. Do-not-block patterns — high win rate but gate would block ─────────

  const doNotBlockPatterns = allCombos
    .filter(p => p.blockedByGate > 0 && p.win5Rate >= 0.20 && p.total >= minSample)
    .sort((a, b) => b.win5Rate - a.win5Rate)
    .slice(0, topN);

  // ── 8. Junk-heavy patterns ────────────────────────────────────────────────

  const junkHeavyPatterns = allCombos
    .filter(p => p.flatDumpRate > 0.70 && p.total >= minSample)
    .sort((a, b) => b.flatDumpRate - a.flatDumpRate)
    .slice(0, topN);

  // ── 9. Matcher summary ────────────────────────────────────────────────────

  const matcherSummary: Record<MatcherLabel, number> = {
    MATCH_STRONG_ENTER_NOW:   0,
    MATCH_MEDIUM_WAIT_2M:     0,
    MATCH_WEAK_OBSERVE_ONLY:  0,
    NO_WINNER_PATTERN_REJECT: 0,
  };
  for (const p of topWinnerPatterns) {
    matcherSummary[p.matcherLabel]++;
  }

  return {
    totalLabeled,
    totalWinners,
    totalWin5,
    totalFlatDump,
    baselineWinRate,
    baselineWin5Rate,
    baselineFlatDumpRate,
    featurePatterns,
    topWinnerPatterns,
    falseNegativePatterns: falseNegPatterns,
    doNotBlockPatterns,
    junkHeavyPatterns,
    matcherSummary,
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function pct(v: number | null | undefined, digits = 1): string {
  if (v == null) return 'n/a';
  return `${(v * 100).toFixed(digits)}%`;
}

function numStr(v: number | null | undefined, digits = 1): string {
  return v == null ? 'n/a' : v.toFixed(digits);
}

function renderPattern(p: PatternStats, rank: number, showBlocked = false): string[] {
  const lines: string[] = [];
  lines.push(`  #${rank}  ${p.key}`);
  lines.push(`       n=${p.total}  win5=${p.win5}(${pct(p.win5Rate)})  winAny=${p.winners}(${pct(p.winRate)})  flatDump=${pct(p.flatDumpRate)}  lift=${numStr(p.win5Lift, 2)}x  avgMove=${numStr(p.avgMove)}%`);
  lines.push(`       matcher=[${p.matcherLabel}]`);
  if (showBlocked) {
    lines.push(`       blocked=${p.blockedByGate}  blockedButWon=${p.blockedButWon}`);
  }
  return lines;
}

export function renderHistoricalWinnerBrain(
  result: HistoricalWinnerBrainResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — HISTORICAL WINNER BRAIN v1');
  lines.push('  [REPORT ONLY — NO TRADES — NO POLICY CHANGES — READ ONLY]');
  lines.push('  Studying past winners to identify pre-rip fingerprints.');
  lines.push(SEP, '');

  // ── Overview ──────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  OVERVIEW');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Labeled rows      : ${result.totalLabeled}`);
  lines.push(`  Total winners     : ${result.totalWinners}  (any: SMALL/WINNER/BIG)`);
  lines.push(`  Win5 (BIG+WIN)    : ${result.totalWin5}`);
  lines.push(`  Flat/Dump         : ${result.totalFlatDump}`);
  lines.push('');
  lines.push(`  Baseline win rate : ${pct(result.baselineWinRate)}  (any winner)`);
  lines.push(`  Baseline win5 rate: ${pct(result.baselineWin5Rate)}  (BIG+WINNER)`);
  lines.push(`  Baseline flat/dump: ${pct(result.baselineFlatDumpRate)}`);
  lines.push('');

  // ── Single-feature patterns ───────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  SINGLE-FEATURE FINGERPRINTS  (ranked by win5 lift)');
  lines.push(`  ${SEP2}`, '');
  result.featurePatterns.slice(0, 15).forEach((p, i) => {
    lines.push(...renderPattern(p, i + 1));
    lines.push('');
  });

  // ── Top winner patterns ───────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  TOP WINNER COMBO PATTERNS  (2 + 3 feature, ranked by lift × significance)');
  lines.push(`  ${SEP2}`, '');
  result.topWinnerPatterns.slice(0, 20).forEach((p, i) => {
    lines.push(...renderPattern(p, i + 1, true));
    lines.push('');
  });

  // ── Matcher assignment summary ────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  MATCHER LABEL SUMMARY  (of top combo patterns)');
  lines.push(`  ${SEP2}`, '');
  for (const [label, count] of Object.entries(result.matcherSummary)) {
    lines.push(`  ${label.padEnd(36)}: ${count}`);
  }
  lines.push('');
  lines.push('  Matcher labels (observation only, NOT wired into any gate):');
  lines.push('    MATCH_STRONG_ENTER_NOW   win5Rate≥32%, lift≥1.4x, timingPath=ENTER_NOW');
  lines.push('    MATCH_MEDIUM_WAIT_2M     win5Rate≥24%, lift≥1.1x');
  lines.push('    MATCH_WEAK_OBSERVE_ONLY  win5Rate≥14%, lift≥0.9x');
  lines.push('    NO_WINNER_PATTERN_REJECT flatDump>70% or win5Rate<14%');
  lines.push('');

  // ── False negatives ───────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  FALSE-NEGATIVE PATTERNS  (winners that were blocked by liq/age gate)');
  lines.push(`  ${SEP2}`, '');
  if (result.falseNegativePatterns.length === 0) {
    lines.push('  None above threshold.');
    lines.push('');
  } else {
    result.falseNegativePatterns.slice(0, 10).forEach((p, i) => {
      lines.push(...renderPattern(p, i + 1, true));
      lines.push('');
    });
  }

  // ── Do-not-block patterns ─────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  DO-NOT-BLOCK PATTERNS  (win5Rate≥20% but gate would reject some)');
  lines.push(`  ${SEP2}`, '');
  if (result.doNotBlockPatterns.length === 0) {
    lines.push('  None above threshold.');
    lines.push('');
  } else {
    result.doNotBlockPatterns.slice(0, 10).forEach((p, i) => {
      lines.push(...renderPattern(p, i + 1, true));
      lines.push('');
    });
  }

  // ── Junk-heavy patterns ───────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  JUNK-HEAVY PATTERNS  (flatDump>70% — avoid these)');
  lines.push(`  ${SEP2}`, '');
  if (result.junkHeavyPatterns.length === 0) {
    lines.push('  None above threshold.');
    lines.push('');
  } else {
    result.junkHeavyPatterns.slice(0, 10).forEach((p, i) => {
      lines.push(...renderPattern(p, i + 1));
      lines.push('');
    });
  }

  // ── Safety ────────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  REPORT_ONLY=true  READ_ONLY=true  NO_POLICY_CHANGE=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING  tradingExecuted=0  realTradingLocked=true');
  lines.push('  paperOnly=true  reportOnly=true');
  lines.push('  Matcher labels are observational suggestions only.');
  lines.push('  NOT wired into autopilot, gates, or any decision path.');
  lines.push(SEP, '');
  return lines.join('\n');
}
