import * as fs from 'fs';

// ── Paths ──────────────────────────────────────────────────────────────────────
const DEFAULT_MEMORY_PATH    = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_LEDGER_PATH    = 'data/token-grab/ripper/watch-observations/watch-observation-ledger.jsonl';
const DEFAULT_SNAPSHOTS_PATH = 'data/token-grab/ripper/watch-observations/watch-observation-snapshots.jsonl';

// ── Types ──────────────────────────────────────────────────────────────────────
export type TargetProfileRecommendation =
  | 'TARGET_PROFILE_KEEP_COLLECTING'
  | 'TARGET_PROFILE_PROMISING_PAPER_REVIEW'
  | 'TARGET_PROFILE_TOO_SMALL'
  | 'TARGET_PROFILE_REJECT_JUNK_HEAVY';

export interface TargetProfileStats {
  name:            string;
  totalRows:       number;
  observedRows:    number;
  unknownRows:     number;
  bigWinner:       number;
  winner:          number;
  smallWinner:     number;
  flatJunk:        number;
  dump:            number;
  win5Count:       number;
  win5Rate:        number;
  winAnyCount:     number;
  winAnyRate:      number;
  flatDumpCount:   number;
  flatDumpRate:    number;
  pessimisticWin5: number;
  liftVsBaseline:  number;
  avgMove:         number | null;
  medianMove:      number | null;
  recommendation:  TargetProfileRecommendation;
}

export interface FreshObservationProfile {
  totalEnrolled:      number;
  matchingTarget:     number;
  match2m:            number;
  match5m:            number;
  improvedIntoTarget: number;
  fellOutOfTarget:    number;
  sourceBreakdown:    Record<string, number>;
  confirmedRippers:   number;
  improving:          number;
  dataGap:            number;
  rejectObserveOnly:  number;
  fakeSpikeCount:     number;
  cycleIds:           string[];
}

export interface WatchTargetProfileReportResult {
  memoryRowsRead:           number;
  observedRows:             number;
  ledgerRowsRead:           number;
  snapshotsRead:            number;
  baselineWin5Rate:         number;
  targetProfileName:        string;
  profiles:                 TargetProfileStats[];
  freshObservationProfile:  FreshObservationProfile;
  recommendation:           TargetProfileRecommendation;
  recommendationNote:       string;
  reportOnly:               true;
  readOnly:                 true;
  paperOnly:                true;
  realTradingLocked:        true;
  tradingExecuted:          0;
}

export interface WatchTargetProfileReportOptions {
  memoryPath?:    string;
  ledgerPath?:    string;
  snapshotsPath?: string;
}

// ── Internal row types ─────────────────────────────────────────────────────────
interface MemRow {
  liquidityBucket?: string | null;
  clusterRisk?:     string | null;
  timingPath?:      string | null;
  vlrBucket?:       string | null;
  outcomeLabel?:    string | null;
  priceChangePct?:  number | null;
}

interface LedgerRow {
  contract:        string;
  cycleId:         string;
  capturedAt:      string;
  liquidityBucket: string | null;
  vlrBucket:       string | null;
  clusterRisk:     string | null;
  priceChangePct:  number | null;
}

interface SnapRow {
  contract:           string;
  originalCapturedAt: string;
  window:             string;
  liquidityBucket:    string | null;
  vlrBucket:          string | null;
  clusterRisk:        string | null;
  priceChangePct:     number | null;
  snapshotAvailable:  boolean;
  snapshotSource:     string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const SAFETY = {
  reportOnly:        true  as const,
  readOnly:          true  as const,
  paperOnly:         true  as const,
  realTradingLocked: true  as const,
  tradingExecuted:   0     as const,
};

const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const SEP2 = '────────────────────────────────────────────────────────────────';

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: T[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as T); } catch { /* skip malformed */ }
  }
  return rows;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function pct(n: number, d: number): string {
  return d > 0 ? (n / d * 100).toFixed(1) + '%' : 'n/a';
}

// ── Profile computation ────────────────────────────────────────────────────────
function computeProfileStats(
  name: string,
  rows: MemRow[],
  baselineWin5Rate: number,
): TargetProfileStats {
  const observed = rows.filter(r => r.outcomeLabel !== 'UNKNOWN' && r.outcomeLabel != null);
  const unknown  = rows.filter(r => r.outcomeLabel === 'UNKNOWN' || r.outcomeLabel == null);

  const bigWinner = observed.filter(r => r.outcomeLabel === 'BIG_WINNER').length;
  const winner    = observed.filter(r => r.outcomeLabel === 'WINNER').length;
  const smallWin  = observed.filter(r => r.outcomeLabel === 'SMALL_WINNER').length;
  const flatJunk  = observed.filter(r => r.outcomeLabel === 'FLAT_JUNK').length;
  const dump      = observed.filter(r => r.outcomeLabel === 'DUMP').length;

  const obs      = observed.length;
  const winAny   = bigWinner + winner + smallWin;
  const flatDump = flatJunk + dump;

  const win5Rate       = obs > 0 ? bigWinner / obs : 0;
  const winAnyRate     = obs > 0 ? winAny    / obs : 0;
  const flatDumpRate   = obs > 0 ? flatDump  / obs : 0;
  const pessimisticWin5 = rows.length > 0 ? bigWinner / rows.length : 0;
  const liftVsBaseline  = baselineWin5Rate > 0 ? win5Rate / baselineWin5Rate : 0;

  const prices     = observed.map(r => r.priceChangePct).filter((p): p is number => typeof p === 'number');
  const avgMove    = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  const medianMove = medianOf(prices);

  let recommendation: TargetProfileRecommendation;
  if (flatDumpRate > 0.70) {
    recommendation = 'TARGET_PROFILE_REJECT_JUNK_HEAVY';
  } else if (win5Rate > baselineWin5Rate * 1.5 && flatDumpRate < 0.55 && obs >= 75) {
    recommendation = 'TARGET_PROFILE_PROMISING_PAPER_REVIEW';
  } else if (obs < 75) {
    recommendation = 'TARGET_PROFILE_TOO_SMALL';
  } else {
    recommendation = 'TARGET_PROFILE_KEEP_COLLECTING';
  }

  return {
    name, totalRows: rows.length, observedRows: obs, unknownRows: unknown.length,
    bigWinner, winner, smallWinner: smallWin, flatJunk, dump,
    win5Count: bigWinner, win5Rate, winAnyCount: winAny, winAnyRate,
    flatDumpCount: flatDump, flatDumpRate,
    pessimisticWin5, liftVsBaseline,
    avgMove, medianMove, recommendation,
  };
}

// ── Fresh observation profile ──────────────────────────────────────────────────
function computeFreshObsProfile(
  ledger: LedgerRow[],
  snapshots: SnapRow[],
): FreshObservationProfile {
  const TARGET_LIQ = 'LIQ_10K_30K';

  const snap2mIdx = new Map<string, SnapRow>();
  const snap5mIdx = new Map<string, SnapRow>();
  for (const s of snapshots) {
    const key = `${s.contract}::${s.originalCapturedAt}`;
    if (s.window === 'RECHECK_2M') snap2mIdx.set(key, s);
    if (s.window === 'RECHECK_5M') snap5mIdx.set(key, s);
  }

  let matchingTarget     = 0;
  let match2m            = 0;
  let match5m            = 0;
  let improvedIntoTarget = 0;
  let fellOutOfTarget    = 0;
  let confirmed          = 0;
  let improving          = 0;
  let dataGap            = 0;
  let rejectObserve      = 0;
  let fakeSpike          = 0;
  const sourceBreakdown: Record<string, number> = {};
  const cycleIds = new Set<string>();

  for (const row of ledger) {
    const key    = `${row.contract}::${row.capturedAt}`;
    const snap2m = snap2mIdx.get(key) ?? null;
    const snap5m = snap5mIdx.get(key) ?? null;

    cycleIds.add(row.cycleId);

    if (snap2m) sourceBreakdown[snap2m.snapshotSource] = (sourceBreakdown[snap2m.snapshotSource] ?? 0) + 1;
    if (snap5m) sourceBreakdown[snap5m.snapshotSource] = (sourceBreakdown[snap5m.snapshotSource] ?? 0) + 1;

    const origIsTarget  = row.liquidityBucket === TARGET_LIQ;
    const origIsUnknown = row.liquidityBucket == null || row.liquidityBucket === 'LIQ_UNKNOWN';
    const s2available   = snap2m?.snapshotAvailable === true;
    const s5available   = snap5m?.snapshotAvailable === true;
    const snap2mIsTarget = s2available && snap2m?.liquidityBucket === TARGET_LIQ;
    const snap5mIsTarget = s5available && snap5m?.liquidityBucket === TARGET_LIQ;

    if (origIsTarget)   matchingTarget++;
    if (snap2mIsTarget) match2m++;
    if (snap5mIsTarget) match5m++;
    if (origIsUnknown && (snap2mIsTarget || snap5mIsTarget)) improvedIntoTarget++;
    if (origIsTarget && (s2available || s5available) && !snap2mIsTarget && !snap5mIsTarget) fellOutOfTarget++;

    // Classification
    if (!s2available && !s5available) { dataGap++; continue; }
    const latest      = s5available ? snap5m! : snap2m!;
    const origPrice   = row.priceChangePct ?? 0;
    const latestPrice = latest.priceChangePct ?? 0;
    if (origPrice > 15 && latestPrice < -10) { fakeSpike++; continue; }
    if (latestPrice >= 10)                    { confirmed++; continue; }

    const origLiqUnk     = row.liquidityBucket == null || row.liquidityBucket === 'LIQ_UNKNOWN';
    const origVlrUnk     = row.vlrBucket == null || row.vlrBucket === 'VLR_UNKNOWN';
    const liqResolved    = origLiqUnk && latest.liquidityBucket != null && latest.liquidityBucket !== 'LIQ_UNKNOWN';
    const vlrResolved    = origVlrUnk && latest.vlrBucket != null && latest.vlrBucket !== 'VLR_UNKNOWN';
    const clusterUpgrade = row.clusterRisk === 'WATCH' && latest.clusterRisk === 'CLEAN';
    if (liqResolved || vlrResolved || clusterUpgrade) { improving++; continue; }

    rejectObserve++;
  }

  return {
    totalEnrolled:     ledger.length,
    matchingTarget,
    match2m,
    match5m,
    improvedIntoTarget,
    fellOutOfTarget,
    sourceBreakdown,
    confirmedRippers:  confirmed,
    improving,
    dataGap,
    rejectObserveOnly: rejectObserve,
    fakeSpikeCount:    fakeSpike,
    cycleIds:          [...cycleIds].sort(),
  };
}

// ── Main function ──────────────────────────────────────────────────────────────
export function runWatchTargetProfileReport(
  options: WatchTargetProfileReportOptions = {},
): WatchTargetProfileReportResult {
  const memoryPath    = options.memoryPath    ?? DEFAULT_MEMORY_PATH;
  const ledgerPath    = options.ledgerPath    ?? DEFAULT_LEDGER_PATH;
  const snapshotsPath = options.snapshotsPath ?? DEFAULT_SNAPSHOTS_PATH;

  const memoryRows = readJsonl<MemRow>(memoryPath);
  const ledgerRows = readJsonl<LedgerRow>(ledgerPath);
  const snapRows   = readJsonl<SnapRow>(snapshotsPath);

  const allObserved = memoryRows.filter(r => r.outcomeLabel !== 'UNKNOWN' && r.outcomeLabel != null);
  const baselineWin5 = allObserved.length > 0
    ? allObserved.filter(r => r.outcomeLabel === 'BIG_WINNER').length / allObserved.length
    : 0;

  // Target: clusterRisk=WATCH + liquidityBucket=LIQ_10K_30K
  const watchLiq = memoryRows.filter(
    r => r.clusterRisk === 'WATCH' && r.liquidityBucket === 'LIQ_10K_30K',
  );

  const profiles: TargetProfileStats[] = [
    computeProfileStats('LIQ_10K_30K + WATCH',
      watchLiq, baselineWin5),
    computeProfileStats('LIQ_10K_30K + WATCH + ENTER_NOW',
      watchLiq.filter(r => r.timingPath === 'ENTER_NOW'), baselineWin5),
    computeProfileStats('LIQ_10K_30K + VLR_LT_0_5 + WATCH',
      watchLiq.filter(r => r.vlrBucket === 'VLR_LT_0_5'), baselineWin5),
    computeProfileStats('LIQ_10K_30K + VLR_0_5_TO_2 + WATCH',
      watchLiq.filter(r => r.vlrBucket === 'VLR_0_5_TO_2'), baselineWin5),
    computeProfileStats('LIQ_10K_30K + VLR_GTE_2 + WATCH',
      watchLiq.filter(r => r.vlrBucket === 'VLR_GTE_2'), baselineWin5),
  ];

  const freshProfile = computeFreshObsProfile(ledgerRows, snapRows);

  // Overall recommendation from primary profile
  const primary = profiles[0]!;
  let recommendation: TargetProfileRecommendation;
  let recommendationNote: string;
  if (primary.observedRows < 75) {
    recommendation = 'TARGET_PROFILE_KEEP_COLLECTING';
    recommendationNote = `Primary profile has only ${primary.observedRows} observed outcomes (need ≥75). Keep collecting.`;
  } else if (primary.win5Rate > baselineWin5 * 1.5 && primary.flatDumpRate < 0.55) {
    recommendation = 'TARGET_PROFILE_PROMISING_PAPER_REVIEW';
    recommendationNote = `win5=${pct(primary.win5Count, primary.observedRows)} vs baseline=${(baselineWin5 * 100).toFixed(1)}% (${primary.liftVsBaseline.toFixed(2)}x lift), flatDump=${pct(primary.flatDumpCount, primary.observedRows)}, observed=${primary.observedRows}. Sufficient signal for paper review.`;
  } else if (primary.flatDumpRate > 0.70) {
    recommendation = 'TARGET_PROFILE_REJECT_JUNK_HEAVY';
    recommendationNote = `flatDump=${pct(primary.flatDumpCount, primary.observedRows)} — primary profile is junk-heavy.`;
  } else {
    recommendation = 'TARGET_PROFILE_KEEP_COLLECTING';
    recommendationNote = `win5=${pct(primary.win5Count, primary.observedRows)} does not clear 1.5x baseline (${(baselineWin5 * 1.5 * 100).toFixed(1)}%). Continue collecting.`;
  }

  return {
    memoryRowsRead:          memoryRows.length,
    observedRows:            allObserved.length,
    ledgerRowsRead:          ledgerRows.length,
    snapshotsRead:           snapRows.length,
    baselineWin5Rate:        baselineWin5,
    targetProfileName:       'LIQ_10K_30K + WATCH (clusterRisk=WATCH, liquidityBucket=LIQ_10K_30K)',
    profiles,
    freshObservationProfile: freshProfile,
    recommendation,
    recommendationNote,
    ...SAFETY,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────────
export function renderWatchTargetProfileReport(
  result: WatchTargetProfileReportResult,
): string {
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — WATCH TARGET PROFILE REPORT v1');
  L.push('  [REPORT ONLY — NO TRADES — NO POLICY CHANGES — READ ONLY]');
  L.push(SEP, '');

  // Section 1: Overview
  L.push(`  ${SEP2}`);
  L.push('  OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Memory rows read      : ${result.memoryRowsRead}`);
  L.push(`  Observed rows (global): ${result.observedRows}`);
  L.push(`  Baseline win5 rate    : ${(result.baselineWin5Rate * 100).toFixed(2)}%  (BIG_WINNER / observed, all rows)`);
  L.push(`  Ledger rows           : ${result.ledgerRowsRead}`);
  L.push(`  Snapshots read        : ${result.snapshotsRead}`);
  L.push(`  Target profile        : ${result.targetProfileName}`);
  L.push('');

  // Section 2: Historical profiles
  L.push(`  ${SEP2}`);
  L.push('  HISTORICAL TARGET PROFILES (learning memory)');
  L.push(`  ${SEP2}`, '');
  for (const p of result.profiles) {
    L.push(`  ┌─ ${p.name}`);
    L.push(`  │  total=${p.totalRows}  observed=${p.observedRows}  unknown=${p.unknownRows}`);
    L.push(`  │  BIG_WINNER=${p.bigWinner}  WINNER=${p.winner}  SMALL_WINNER=${p.smallWinner}`);
    L.push(`  │  FLAT_JUNK=${p.flatJunk}  DUMP=${p.dump}`);
    L.push(`  │  win5  = ${p.win5Count}/${p.observedRows} = ${(p.win5Rate * 100).toFixed(1)}%   lift=${p.liftVsBaseline.toFixed(2)}x vs baseline`);
    L.push(`  │  winAny= ${p.winAnyCount}/${p.observedRows} = ${(p.winAnyRate * 100).toFixed(1)}%`);
    L.push(`  │  flatDump=${p.flatDumpCount}/${p.observedRows} = ${(p.flatDumpRate * 100).toFixed(1)}%`);
    L.push(`  │  pessimistic_win5=${(p.pessimisticWin5 * 100).toFixed(1)}%  (win5/total incl unknowns)`);
    if (p.avgMove != null) {
      L.push(`  │  avg_move=${p.avgMove.toFixed(1)}%  median_move=${p.medianMove?.toFixed(1) ?? 'n/a'}%`);
    }
    L.push(`  └─ ${p.recommendation}`);
    L.push('');
  }

  // Section 3: Fresh observations
  const fp = result.freshObservationProfile;
  L.push(`  ${SEP2}`);
  L.push('  FRESH WATCH OBSERVATIONS');
  L.push(`  ${SEP2}`, '');
  L.push(`  Total enrolled          : ${fp.totalEnrolled}`);
  L.push(`  Matching target (orig)  : ${fp.matchingTarget}  (liquidityBucket=LIQ_10K_30K at enrollment)`);
  L.push(`  2m snapshot → target    : ${fp.match2m}  (resolved to LIQ_10K_30K)`);
  L.push(`  5m snapshot → target    : ${fp.match5m}  (resolved to LIQ_10K_30K)`);
  L.push(`  Improved into target    : ${fp.improvedIntoTarget}  (enrolled LIQ_UNKNOWN → snapshot LIQ_10K_30K)`);
  L.push(`  Fell out of target      : ${fp.fellOutOfTarget}  (enrolled LIQ_10K_30K → snapshot different)`);
  L.push('');
  L.push('  Classifications:');
  L.push(`    WATCH_CONFIRMED_RIPPER    : ${fp.confirmedRippers}`);
  L.push(`    WATCH_IMPROVING           : ${fp.improving}`);
  L.push(`    WATCH_DATA_GAP            : ${fp.dataGap}`);
  L.push(`    WATCH_FAKE_SPIKE          : ${fp.fakeSpikeCount}`);
  L.push(`    WATCH_REJECT_OBSERVE_ONLY : ${fp.rejectObserveOnly}`);
  L.push('');
  if (Object.keys(fp.sourceBreakdown).length > 0) {
    L.push('  Snapshot sources:');
    for (const [src, count] of Object.entries(fp.sourceBreakdown).sort()) {
      L.push(`    ${src.padEnd(22)}: ${count}`);
    }
    L.push('');
  }
  if (fp.cycleIds.length > 0) {
    L.push(`  Cycle IDs: ${fp.cycleIds.join(', ')}`);
    L.push('');
  }

  // Section 4: Recommendation
  L.push(`  ${SEP2}`);
  L.push('  RECOMMENDATION');
  L.push(`  ${SEP2}`, '');
  L.push(`  [${result.recommendation}]`);
  L.push(`  ${result.recommendationNote}`);
  L.push('');

  // Safety footer
  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true  READ_ONLY=true  NO_POLICY_CHANGE=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING  tradingExecuted=0  realTradingLocked=true');
  L.push('  paperOnly=true  reportOnly=true');
  L.push('  No gate, autopilot, policy, or trade logic modified.');
  L.push(SEP, '');

  return L.join('\n');
}
