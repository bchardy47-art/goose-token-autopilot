// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE
//
// Winner profile report — reads learning memory only.
// Does NOT call any API. Does NOT change gates or scoring.
// REPORT ONLY / READ ONLY / PAPER ONLY.

import * as fs from 'fs';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WinnerProfileConclusion =
  | 'NEEDS_MORE_DATA'
  | 'WATCH_PROFILE_CANDIDATE'
  | 'NO_CLEAR_EDGE';

export interface OutcomeStats {
  observedCount: number;
  bigWinCount:   number;   // BIG_WINNER
  winnerCount:   number;   // WINNER
  smallWinCount: number;   // SMALL_WINNER
  flatJunkCount: number;   // FLAT_JUNK
  dumpCount:     number;   // DUMP
  win5Rate:      number | null;   // bigWinCount / observedCount
  win3Rate:      number | null;   // (bigWinCount + winnerCount) / observedCount
  win1Rate:      number | null;   // all winners / observedCount
  flatDumpRate:  number | null;   // (flatJunkCount + dumpCount) / observedCount
}

export interface FeatureBucket {
  value:        string;
  stats:        OutcomeStats;
  win5Lift:     number | null;
  win1Lift:     number | null;
  flatDumpLift: number | null;
  tinyFlag:     boolean;
}

export interface FeatureProfile {
  feature:       string;
  buckets:       FeatureBucket[];
  topWinBucket:  string | null;
  topDumpBucket: string | null;
}

export interface UniverseSection {
  universeName:    string;
  isReferenceOnly: boolean;
  totalRows:       number;
  observedRows:    number;
  baseline:        OutcomeStats;
  featureProfiles: FeatureProfile[];
}

export interface ComboResult {
  features:     string[];
  stats:        OutcomeStats;
  win5Lift:     number | null;
  win1Lift:     number | null;
  flatDumpLift: number | null;
  tinyFlag:     boolean;
}

export interface WinnerProfileResult {
  generatedAt:       string;
  totalRows:         number;
  minSample:         number;
  allObserved:       UniverseSection;
  enrolledOnly:      UniverseSection;
  generalReference:  UniverseSection;
  topWin5Combos:     ComboResult[];
  topWin1Combos:     ComboResult[];
  topFlatDumpCombos: ComboResult[];
  watchCandidates:   ComboResult[];
  conclusion:        WinnerProfileConclusion;
  conclusionNote:    string;
  reportOnly:        true;
  readOnly:          true;
  tradingExecuted:   0;
  realTradingLocked: true;
  paperOnly:         true;
}

export interface WinnerProfileOptions {
  learningMemoryPath?: string;
  nowMs?:              number;
  minSample?:          number;
}

// ── Internal raw row shape ────────────────────────────────────────────────────

interface RawMemoryRow {
  contract?:        string;
  capturedAt?:      string;
  outcomeLabel?:    string | null;
  memoryUniverse?:  string | null;
  liquidityBucket?: string | null;
  vlrBucket?:       string | null;
  launchAgeBucket?: string | null;
  clusterRisk?:     string | null;
  timingPath?:      string | null;
  gateDecision?:    string | null;
  ripperScore?:     number | null;
  bubbleMapsScore?: number | null;
  priceChangePct?:  number | null;
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_LEARNING_MEMORY_PATH =
  'data/token-grab/ripper/learning-memory.jsonl';

function readRawRows(filePath: string): RawMemoryRow[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const rows: RawMemoryRow[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as RawMemoryRow);
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

function isObserved(outcomeLabel: string | null | undefined): boolean {
  if (outcomeLabel == null) return false;
  return (
    outcomeLabel === 'BIG_WINNER' ||
    outcomeLabel === 'WINNER' ||
    outcomeLabel === 'SMALL_WINNER' ||
    outcomeLabel === 'FLAT_JUNK' ||
    outcomeLabel === 'DUMP'
  );
}

function roundRate(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 1000) / 10;
}

function computeOutcomeStats(rows: RawMemoryRow[]): OutcomeStats {
  let bigWinCount   = 0;
  let winnerCount   = 0;
  let smallWinCount = 0;
  let flatJunkCount = 0;
  let dumpCount     = 0;

  for (const r of rows) {
    const label = r.outcomeLabel;
    if (label === 'BIG_WINNER')   bigWinCount++;
    else if (label === 'WINNER')  winnerCount++;
    else if (label === 'SMALL_WINNER') smallWinCount++;
    else if (label === 'FLAT_JUNK')    flatJunkCount++;
    else if (label === 'DUMP')         dumpCount++;
  }

  const observedCount = bigWinCount + winnerCount + smallWinCount + flatJunkCount + dumpCount;

  if (observedCount === 0) {
    return {
      observedCount: 0,
      bigWinCount,
      winnerCount,
      smallWinCount,
      flatJunkCount,
      dumpCount,
      win5Rate:     null,
      win3Rate:     null,
      win1Rate:     null,
      flatDumpRate: null,
    };
  }

  return {
    observedCount,
    bigWinCount,
    winnerCount,
    smallWinCount,
    flatJunkCount,
    dumpCount,
    win5Rate:     roundRate(bigWinCount, observedCount),
    win3Rate:     roundRate(bigWinCount + winnerCount, observedCount),
    win1Rate:     roundRate(bigWinCount + winnerCount + smallWinCount, observedCount),
    flatDumpRate: roundRate(flatJunkCount + dumpCount, observedCount),
  };
}

function computeLift(rate: number | null, baselineRate: number | null): number | null {
  if (rate == null || baselineRate == null || baselineRate === 0) return null;
  return Math.round((rate / baselineRate) * 10) / 10;
}

// ── Bucketing functions ───────────────────────────────────────────────────────

function getRipperScoreBucket(score: number | null | undefined): string {
  if (score == null) return 'SCORE_NONE';
  if (score === 100)  return 'SCORE_100';
  if (score >= 90)    return 'SCORE_90_99';
  if (score >= 80)    return 'SCORE_80_89';
  return 'SCORE_LT_80';
}

function getBmScoreTier(score: number | null | undefined): string {
  if (score == null) return 'BM_NONE';
  if (score >= 80)   return 'BM_GTE_80';
  if (score >= 60)   return 'BM_60_79';
  return 'BM_LT_60';
}

type FeatureExtractor = (row: RawMemoryRow) => string;

const FEATURE_EXTRACTORS: Record<string, FeatureExtractor> = {
  liquidityBucket:   (r) => r.liquidityBucket  ?? 'LIQ_UNKNOWN',
  vlrBucket:         (r) => r.vlrBucket         ?? 'VLR_UNKNOWN',
  clusterRisk:       (r) => r.clusterRisk        ?? 'UNKNOWN',
  launchAgeBucket:   (r) => r.launchAgeBucket    ?? 'UNKNOWN',
  timingPath:        (r) => r.timingPath          ?? 'UNKNOWN',
  ripperScoreBucket: (r) => getRipperScoreBucket(r.ripperScore),
  bmScoreTier:       (r) => getBmScoreTier(r.bubbleMapsScore),
  gateDecision:      (r) => r.gateDecision        ?? 'UNKNOWN',
};

const FEATURE_NAMES = [
  'liquidityBucket',
  'vlrBucket',
  'clusterRisk',
  'launchAgeBucket',
  'timingPath',
  'ripperScoreBucket',
  'bmScoreTier',
  'gateDecision',
] as const;

const COMBO_FEATURES = [
  'liquidityBucket',
  'vlrBucket',
  'clusterRisk',
  'timingPath',
  'launchAgeBucket',
] as const;

// ── Feature profile builder ───────────────────────────────────────────────────

function buildFeatureProfile(
  featureName: string,
  rows: RawMemoryRow[],
  baseline: OutcomeStats,
  minSample: number,
): FeatureProfile {
  const extractor = FEATURE_EXTRACTORS[featureName];
  const bucketMap = new Map<string, RawMemoryRow[]>();

  for (const row of rows) {
    if (!isObserved(row.outcomeLabel)) continue;
    const val = extractor(row);
    let bucket = bucketMap.get(val);
    if (!bucket) {
      bucket = [];
      bucketMap.set(val, bucket);
    }
    bucket.push(row);
  }

  const buckets: FeatureBucket[] = [];
  for (const [value, bucketRows] of bucketMap.entries()) {
    const stats = computeOutcomeStats(bucketRows);
    buckets.push({
      value,
      stats,
      win5Lift:     computeLift(stats.win5Rate,     baseline.win5Rate),
      win1Lift:     computeLift(stats.win1Rate,     baseline.win1Rate),
      flatDumpLift: computeLift(stats.flatDumpRate, baseline.flatDumpRate),
      tinyFlag:     stats.observedCount < minSample,
    });
  }

  // Sort by win5Rate descending (null treated as -1)
  buckets.sort((a, b) => {
    const aRate = a.stats.win5Rate ?? -1;
    const bRate = b.stats.win5Rate ?? -1;
    return bRate - aRate;
  });

  let topWinBucket:  string | null = null;
  let topDumpBucket: string | null = null;
  let bestWin5  = -1;
  let bestDump  = -1;

  for (const b of buckets) {
    if (!b.tinyFlag) {
      if ((b.stats.win5Rate ?? -1) > bestWin5) {
        bestWin5      = b.stats.win5Rate ?? -1;
        topWinBucket  = b.value;
      }
      if ((b.stats.flatDumpRate ?? -1) > bestDump) {
        bestDump      = b.stats.flatDumpRate ?? -1;
        topDumpBucket = b.value;
      }
    }
  }

  return { feature: featureName, buckets, topWinBucket, topDumpBucket };
}

// ── Universe section builder ──────────────────────────────────────────────────

function buildUniverseSection(
  universeName: string,
  isReferenceOnly: boolean,
  rows: RawMemoryRow[],
  minSample: number,
): UniverseSection {
  const observedRows = rows.filter(r => isObserved(r.outcomeLabel));
  const baseline = computeOutcomeStats(observedRows);
  const featureProfiles = FEATURE_NAMES.map(feat =>
    buildFeatureProfile(feat, rows, baseline, minSample),
  );

  return {
    universeName,
    isReferenceOnly,
    totalRows:    rows.length,
    observedRows: observedRows.length,
    baseline,
    featureProfiles,
  };
}

// ── Combo mining ──────────────────────────────────────────────────────────────

function combinations<T>(arr: readonly T[], k: number): T[][] {
  const result: T[][] = [];
  function helper(start: number, current: T[]): void {
    if (current.length === k) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      current.push(arr[i]);
      helper(i + 1, current);
      current.pop();
    }
  }
  helper(0, []);
  return result;
}

function mineAllCombos(
  rows: RawMemoryRow[],
  baseline: OutcomeStats,
  minSample: number,
): ComboResult[] {
  const pairs   = combinations(COMBO_FEATURES, 2);
  const triples = combinations(COMBO_FEATURES, 3);
  const allComboDefs = [...pairs, ...triples];

  const allResults: ComboResult[] = [];

  for (const comboDef of allComboDefs) {
    const accumulator = new Map<string, RawMemoryRow[]>();

    for (const row of rows) {
      if (!isObserved(row.outcomeLabel)) continue;
      const keyParts: string[] = comboDef.map(
        feat => `${feat}=${FEATURE_EXTRACTORS[feat](row)}`,
      );
      const key = keyParts.join('|');
      let bucket = accumulator.get(key);
      if (!bucket) {
        bucket = [];
        accumulator.set(key, bucket);
      }
      bucket.push(row);
    }

    for (const [key, bucketRows] of accumulator.entries()) {
      const stats = computeOutcomeStats(bucketRows);
      const features = key.split('|');
      allResults.push({
        features,
        stats,
        win5Lift:     computeLift(stats.win5Rate,     baseline.win5Rate),
        win1Lift:     computeLift(stats.win1Rate,     baseline.win1Rate),
        flatDumpLift: computeLift(stats.flatDumpRate, baseline.flatDumpRate),
        tinyFlag:     stats.observedCount < minSample,
      });
    }
  }

  return allResults;
}

// ── Main runner ───────────────────────────────────────────────────────────────

export function runWinnerProfileReport(options: WinnerProfileOptions = {}): WinnerProfileResult {
  const memoryPath = options.learningMemoryPath ?? DEFAULT_LEARNING_MEMORY_PATH;
  const minSample  = options.minSample ?? 20;
  const nowMs      = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const allRows = readRawRows(memoryPath);

  const enrolledRows = allRows.filter(
    r => r.memoryUniverse === 'SHADOW_ENROLLED_APPROVED',
  );
  const generalRows = allRows.filter(
    r => r.memoryUniverse === 'DEX_WATCH_GENERAL',
  );

  const allObserved      = buildUniverseSection('ALL',                  false, allRows,      minSample);
  const enrolledOnly     = buildUniverseSection('SHADOW_ENROLLED_APPROVED', false, enrolledRows, minSample);
  const generalReference = buildUniverseSection('DEX_WATCH_GENERAL',    true,  generalRows,  minSample);

  // Combo mining — enrolled observed rows only
  const allCombos = mineAllCombos(enrolledRows, enrolledOnly.baseline, minSample);

  // topWin5Combos — non-tiny, sorted by win5Rate desc, top 10
  const topWin5Combos = allCombos
    .filter(c => !c.tinyFlag)
    .sort((a, b) => (b.stats.win5Rate ?? -1) - (a.stats.win5Rate ?? -1))
    .slice(0, 10);

  // topWin1Combos — non-tiny, sorted by win1Rate desc, top 10
  const topWin1Combos = allCombos
    .filter(c => !c.tinyFlag)
    .sort((a, b) => (b.stats.win1Rate ?? -1) - (a.stats.win1Rate ?? -1))
    .slice(0, 10);

  // topFlatDumpCombos — non-tiny, sorted by flatDumpRate desc, top 10
  const topFlatDumpCombos = allCombos
    .filter(c => !c.tinyFlag)
    .sort((a, b) => (b.stats.flatDumpRate ?? -1) - (a.stats.flatDumpRate ?? -1))
    .slice(0, 10);

  // watchCandidates — win1Lift >= 1.25, non-tiny, sort by win5Rate desc, top 5
  const watchCandidates = allCombos
    .filter(c => !c.tinyFlag && c.win1Lift != null && c.win1Lift >= 1.25)
    .sort((a, b) => (b.stats.win5Rate ?? -1) - (a.stats.win5Rate ?? -1))
    .slice(0, 5);

  // Conclusion
  let conclusion: WinnerProfileConclusion;
  let conclusionNote: string;

  if (enrolledOnly.observedRows < 100) {
    conclusion     = 'NEEDS_MORE_DATA';
    conclusionNote = `Only ${enrolledOnly.observedRows} observed enrolled rows. Need at least 100 for reliable profiling.`;
  } else if (watchCandidates.some(c => c.win5Lift != null && c.win5Lift >= 1.5)) {
    conclusion     = 'WATCH_PROFILE_CANDIDATE';
    conclusionNote = 'At least one watch candidate has win5Lift >= 1.5x. Profile warrants further manual review. Advisory only — no gate changes.';
  } else {
    conclusion     = 'NO_CLEAR_EDGE';
    conclusionNote = 'Sufficient data collected but no combo shows win5Lift >= 1.5x among watch candidates. No clear edge identified.';
  }

  return {
    generatedAt,
    totalRows:   allRows.length,
    minSample,
    allObserved,
    enrolledOnly,
    generalReference,
    topWin5Combos,
    topWin1Combos,
    topFlatDumpCombos,
    watchCandidates,
    conclusion,
    conclusionNote,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  if (v == null) return ' n/a ';
  return `${v.toFixed(1)}%`;
}

function fmtLift(v: number | null): string {
  if (v == null) return ' n/a';
  return `${v.toFixed(1)}x`;
}

function padL(s: string, n: number): string {
  return s.padStart(n);
}

function padR(s: string, n: number): string {
  return s.padEnd(n);
}

function renderFeatureTable(profile: FeatureProfile, lines: string[]): void {
  lines.push(`  ${profile.feature}:`);
  const header =
    `  ${ padR('Value', 22)} | ${ padL('Obs', 5)} | ${padL('Win5%', 6)} | ${padL('Win3%', 6)} | ${padL('Win1%', 6)} | ${padL('FlatDump%', 9)} | ${padL('W5Lift', 6)}`;
  lines.push(header);
  lines.push('  ' + '-'.repeat(header.length - 2));

  for (const b of profile.buckets) {
    const tiny = b.tinyFlag ? ' [DO_NOT_TRUST_TINY_SAMPLE]' : '';
    const row =
      `  ${ padR(b.value, 22)} | ${ padL(String(b.stats.observedCount), 5)} | ${padL(fmtPct(b.stats.win5Rate), 6)} | ${padL(fmtPct(b.stats.win3Rate), 6)} | ${padL(fmtPct(b.stats.win1Rate), 6)} | ${padL(fmtPct(b.stats.flatDumpRate), 9)} | ${padL(fmtLift(b.win5Lift), 6)}${tiny}`;
    lines.push(row);
  }

  if (profile.topWinBucket != null) {
    const topBucket = profile.buckets.find(b => b.value === profile.topWinBucket);
    lines.push(`  Top winner bucket: ${profile.topWinBucket} (win5=${fmtPct(topBucket?.stats.win5Rate ?? null)})`);
  } else {
    lines.push('  Top winner bucket: (none non-tiny)');
  }
  if (profile.topDumpBucket != null) {
    const dumpBucket = profile.buckets.find(b => b.value === profile.topDumpBucket);
    lines.push(`  Top junk bucket: ${profile.topDumpBucket} (flatDump=${fmtPct(dumpBucket?.stats.flatDumpRate ?? null)})`);
  } else {
    lines.push('  Top junk bucket: (none non-tiny)');
  }
  lines.push('');
}

function renderComboList(combos: ComboResult[], lines: string[]): void {
  if (combos.length === 0) {
    lines.push('  (none)');
    lines.push('');
    return;
  }
  let idx = 1;
  for (const c of combos) {
    const featStr = c.features.join(' + ');
    const tiny = c.tinyFlag ? ' [DO_NOT_TRUST_TINY_SAMPLE]' : '';
    lines.push(`  ${idx}. ${featStr}${tiny}`);
    lines.push(
      `     Obs=${c.stats.observedCount}  win5=${fmtPct(c.stats.win5Rate)}  win3=${fmtPct(c.stats.win3Rate)}  win1=${fmtPct(c.stats.win1Rate)}  flatDump=${fmtPct(c.stats.flatDumpRate)}  W5Lift=${fmtLift(c.win5Lift)}`,
    );
    idx++;
  }
  lines.push('');
}

export function renderWinnerProfileReport(result: WinnerProfileResult): string {
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines: string[] = ['', SEP];

  lines.push('  TOKEN GRAB — WINNER PROFILE REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — READ ONLY]');
  lines.push(`  Generated: ${result.generatedAt}`);
  lines.push('  DO_NOT_ENABLE_REAL_TRADING  HOLD_CURRENT_GATES  NO_POLICY_CHANGE');
  lines.push(SEP, '');

  // ── Section 1: Baseline Rates ─────────────────────────────────────────────
  lines.push(`━━━ 1. BASELINE RATES ━━━`);
  const ab = result.allObserved.baseline;
  const eb = result.enrolledOnly.baseline;
  const gb = result.generalReference.baseline;
  lines.push(`  All observed     (N=${ab.observedCount}):  win5=${fmtPct(ab.win5Rate)}  win3=${fmtPct(ab.win3Rate)}  win1=${fmtPct(ab.win1Rate)}  flat+dump=${fmtPct(ab.flatDumpRate)}`);
  lines.push(`  Enrolled only    (N=${eb.observedCount}):  win5=${fmtPct(eb.win5Rate)}  win3=${fmtPct(eb.win3Rate)}  win1=${fmtPct(eb.win1Rate)}  flat+dump=${fmtPct(eb.flatDumpRate)}`);
  lines.push(`  General ref      (N=${gb.observedCount}):  win5=${fmtPct(gb.win5Rate)}  win3=${fmtPct(gb.win3Rate)}  win1=${fmtPct(gb.win1Rate)}  flat+dump=${fmtPct(gb.flatDumpRate)}  [NOT PROMOTION MATH]`);
  lines.push('');

  // ── Section 2: Feature Profiles — Enrolled Only ───────────────────────────
  lines.push(`━━━ 2. FEATURE PROFILES — ENROLLED UNIVERSE ━━━`);
  lines.push(`  (minSample=${result.minSample})`);
  lines.push('');
  for (const profile of result.enrolledOnly.featureProfiles) {
    renderFeatureTable(profile, lines);
  }

  // ── Section 3: Top +5% Win Combos ────────────────────────────────────────
  lines.push(`━━━ 3. TOP +5% WIN COMBOS (enrolled, min obs=${result.minSample}) ━━━`);
  renderComboList(result.topWin5Combos, lines);

  // ── Section 4: Top +1% Win Combos ────────────────────────────────────────
  lines.push(`━━━ 4. TOP +1% WIN COMBOS (enrolled, min obs=${result.minSample}) ━━━`);
  renderComboList(result.topWin1Combos, lines);

  // ── Section 5: Top Flat/Dump Combos ──────────────────────────────────────
  lines.push(`━━━ 5. TOP FLAT/DUMP COMBOS (enrolled, min obs=${result.minSample}) ━━━`);
  renderComboList(result.topFlatDumpCombos, lines);

  // ── Section 6: Watch Candidates ──────────────────────────────────────────
  lines.push(`━━━ 6. WATCH CANDIDATES (win1Lift >= 1.25x, min obs=${result.minSample}) ━━━`);
  renderComboList(result.watchCandidates, lines);

  // ── Conclusion ────────────────────────────────────────────────────────────
  lines.push(`━━━ CONCLUSION ━━━`);
  lines.push(`  ${result.conclusion}`);
  lines.push(`  ${result.conclusionNote}`);
  lines.push('');

  // ── Safety ────────────────────────────────────────────────────────────────
  lines.push(`━━━ SAFETY ━━━`);
  lines.push(`  reportOnly=true  readOnly=true  tradingExecuted=0`);
  lines.push(`  realTradingLocked=true  paperOnly=true`);
  lines.push('  HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(SEP, '');

  return lines.join('\n');
}
