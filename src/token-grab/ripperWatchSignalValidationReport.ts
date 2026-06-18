// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE
//
// WATCH signal validation report — reads learning-memory.jsonl only.
// Does NOT call any API. Does NOT trade. Does NOT change gates or thresholds.

import * as fs from 'fs';

export type WatchEdgeRecommendation =
  | 'WATCH_EDGE_CONFIRMED'
  | 'WATCH_EDGE_POSSIBLE'
  | 'WATCH_EDGE_ARTIFACT_RISK'
  | 'WATCH_EDGE_REJECTED';

interface MemoryRow {
  contract?: string;
  outcomeLabel?: string | null;
  priceChangePct?: number | null;
  clusterRisk?: string | null;
  liquidityBucket?: string | null;
  vlrBucket?: string | null;
  launchAgeBucket?: string | null;
  timingPath?: string | null;
  [k: string]: unknown;
}

export interface ValidationGroupStats {
  groupName: string;
  totalRows: number;
  labeledRows: number;
  labeledCoveragePct: number | null;
  uniqueContracts: number;
  bigWinnerCount: number;
  bigWinnerRate: number | null;
  winnerCount: number;
  winnerRate: number | null;
  smallWinnerCount: number;
  smallWinnerRate: number | null;
  flatJunkCount: number;
  flatJunkRate: number | null;
  dumpCount: number;
  dumpRate: number | null;
  observedWin5: number | null;
  pessimisticWin5: number | null;
  avgPriceChange: number | null;
  medianPriceChange: number | null;
  artifactRisk: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface MatchedComparisonRow {
  dimension: 'liquidityBucket' | 'launchAgeBucket' | 'vlrBucket' | 'timingPath';
  bucket: string;
  watchRows: number;
  cleanRows: number;
  watchObservedWin5: number | null;
  cleanObservedWin5: number | null;
  watchPessimisticWin5: number | null;
  cleanPessimisticWin5: number | null;
  watchAvgPriceChange: number | null;
  cleanAvgPriceChange: number | null;
}

export interface WatchSignalValidationResult {
  generatedAt: string;
  learningMemoryPath: string;
  totalRows: number;
  groups: ValidationGroupStats[];
  matchedComparisons: MatchedComparisonRow[];
  recommendation: WatchEdgeRecommendation;
  recommendationNote: string;
  reportOnly: true;
  readOnly: true;
  paperOnly: true;
  realTradingLocked: true;
  tradingExecuted: 0;
}

export interface WatchSignalValidationOptions {
  learningMemoryPath?: string;
  nowMs?: number;
}

const DEFAULT_LEARNING_MEMORY_PATH = 'data/token-grab/ripper/learning-memory.jsonl';
const LABELS = new Set(['BIG_WINNER', 'WINNER', 'SMALL_WINNER', 'FLAT_JUNK', 'DUMP']);

function readRows(filePath: string): MemoryRow[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const rows: MemoryRow[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as MemoryRow);
    } catch {
      // skip malformed
    }
  }
  return rows;
}

function isLabeled(row: MemoryRow): boolean {
  return row.outcomeLabel != null && LABELS.has(row.outcomeLabel);
}

function win5(label: string | null | undefined): boolean {
  return label === 'BIG_WINNER' || label === 'WINNER';
}

function rate(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

function bucketVal(v: string | null | undefined, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function computeArtifactRisk(total: number, labeled: number, unknownLiq: number, unknownVlr: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (total === 0) return 'HIGH';
  const coverage = labeled / total;
  const unknownShare = (unknownLiq + unknownVlr) / (total * 2);
  if (coverage < 0.35 || unknownShare > 0.6) return 'HIGH';
  if (coverage < 0.65 || unknownShare > 0.35) return 'MEDIUM';
  return 'LOW';
}

function computeGroup(groupName: string, rows: MemoryRow[]): ValidationGroupStats {
  const labeled = rows.filter(isLabeled);
  const labels = labeled.map(r => r.outcomeLabel);
  const contracts = new Set(rows.map(r => r.contract).filter((v): v is string => typeof v === 'string' && v.length > 0));
  const bigWinnerCount = labels.filter(l => l === 'BIG_WINNER').length;
  const winnerCount = labels.filter(l => l === 'WINNER').length;
  const smallWinnerCount = labels.filter(l => l === 'SMALL_WINNER').length;
  const flatJunkCount = labels.filter(l => l === 'FLAT_JUNK').length;
  const dumpCount = labels.filter(l => l === 'DUMP').length;
  const moves = labeled.map(r => typeof r.priceChangePct === 'number' ? r.priceChangePct : null).filter((v): v is number => v != null);
  const unknownLiq = rows.filter(r => bucketVal(r.liquidityBucket, 'LIQ_UNKNOWN') === 'LIQ_UNKNOWN').length;
  const unknownVlr = rows.filter(r => bucketVal(r.vlrBucket, 'VLR_UNKNOWN') === 'VLR_UNKNOWN').length;
  const win5Count = labels.filter(l => win5(l)).length;

  return {
    groupName,
    totalRows: rows.length,
    labeledRows: labeled.length,
    labeledCoveragePct: rows.length > 0 ? (labeled.length / rows.length) * 100 : null,
    uniqueContracts: contracts.size,
    bigWinnerCount,
    bigWinnerRate: rate(bigWinnerCount, labeled.length),
    winnerCount,
    winnerRate: rate(winnerCount, labeled.length),
    smallWinnerCount,
    smallWinnerRate: rate(smallWinnerCount, labeled.length),
    flatJunkCount,
    flatJunkRate: rate(flatJunkCount, labeled.length),
    dumpCount,
    dumpRate: rate(dumpCount, labeled.length),
    observedWin5: rate(win5Count, labeled.length),
    pessimisticWin5: rate(win5Count, rows.length),
    avgPriceChange: moves.length > 0 ? moves.reduce((a, b) => a + b, 0) / moves.length : null,
    medianPriceChange: median(moves),
    artifactRisk: computeArtifactRisk(rows.length, labeled.length, unknownLiq, unknownVlr),
  };
}

function buildMatchedComparisons(rows: MemoryRow[]): MatchedComparisonRow[] {
  const dims: Array<MatchedComparisonRow['dimension']> = ['liquidityBucket', 'launchAgeBucket', 'vlrBucket', 'timingPath'];
  const out: MatchedComparisonRow[] = [];

  for (const dim of dims) {
    const buckets = new Set(rows.map(r => bucketVal((r as Record<string, unknown>)[dim] as string | null | undefined, 'UNKNOWN')));
    for (const bucket of buckets) {
      const watchRows = rows.filter(r => bucketVal(r.clusterRisk, 'UNKNOWN') === 'WATCH' && bucketVal((r as Record<string, unknown>)[dim] as string | null | undefined, 'UNKNOWN') === bucket);
      const cleanRows = rows.filter(r => bucketVal(r.clusterRisk, 'UNKNOWN') === 'CLEAN' && bucketVal((r as Record<string, unknown>)[dim] as string | null | undefined, 'UNKNOWN') === bucket);
      if (watchRows.length === 0 && cleanRows.length === 0) continue;
      const watchStats = computeGroup('watch', watchRows);
      const cleanStats = computeGroup('clean', cleanRows);
      out.push({
        dimension: dim,
        bucket,
        watchRows: watchRows.length,
        cleanRows: cleanRows.length,
        watchObservedWin5: watchStats.observedWin5,
        cleanObservedWin5: cleanStats.observedWin5,
        watchPessimisticWin5: watchStats.pessimisticWin5,
        cleanPessimisticWin5: cleanStats.pessimisticWin5,
        watchAvgPriceChange: watchStats.avgPriceChange,
        cleanAvgPriceChange: cleanStats.avgPriceChange,
      });
    }
  }

  return out.sort((a, b) => a.dimension.localeCompare(b.dimension) || a.bucket.localeCompare(b.bucket));
}

function recommend(groups: ValidationGroupStats[], matched: MatchedComparisonRow[]): { recommendation: WatchEdgeRecommendation; note: string } {
  const watchKnownLiq = groups.find(g => g.groupName === 'WATCH + known liquidity');
  const watchUnknownLiq = groups.find(g => g.groupName === 'WATCH + LIQ_UNKNOWN');
  const watchPrime = groups.find(g => g.groupName === 'WATCH + PRIME_WINDOW');
  const cleanPrime = groups.find(g => g.groupName === 'CLEAN + PRIME_WINDOW');

  const artifactHigh = [watchKnownLiq, watchUnknownLiq, watchPrime].some(g => g?.artifactRisk === 'HIGH');
  const watchEdgePrime = watchPrime?.observedWin5 != null && cleanPrime?.observedWin5 != null && watchPrime.observedWin5 > cleanPrime.observedWin5;
  const watchEdgeKnown = watchKnownLiq?.observedWin5 != null && watchUnknownLiq?.observedWin5 != null && watchKnownLiq.observedWin5 > watchUnknownLiq.observedWin5;
  const matchedPositive = matched.filter(r => r.watchObservedWin5 != null && r.cleanObservedWin5 != null && r.watchObservedWin5 > r.cleanObservedWin5).length;

  if (artifactHigh && !watchEdgeKnown) {
    return {
      recommendation: 'WATCH_EDGE_ARTIFACT_RISK',
      note: 'WATCH groups are heavily influenced by LIQ_UNKNOWN/VLR_UNKNOWN or low labeled coverage. Treat edge as artifact risk.',
    };
  }
  if (watchEdgePrime && watchEdgeKnown && matchedPositive >= 2) {
    return {
      recommendation: 'WATCH_EDGE_CONFIRMED',
      note: 'WATCH outperforms CLEAN within matched buckets and retains stronger known-liquidity behavior.',
    };
  }
  if (watchEdgeKnown || watchEdgePrime || matchedPositive >= 1) {
    return {
      recommendation: 'WATCH_EDGE_POSSIBLE',
      note: 'WATCH shows some matched-bucket or known-liquidity edge, but coverage and artifact risk still limit confidence.',
    };
  }
  return {
    recommendation: 'WATCH_EDGE_REJECTED',
    note: 'WATCH does not outperform CLEAN in matched comparisons and appears driven by artifact-heavy buckets.',
  };
}

export function runRipperWatchSignalValidation(
  options: WatchSignalValidationOptions = {},
): WatchSignalValidationResult {
  const learningMemoryPath = options.learningMemoryPath ?? DEFAULT_LEARNING_MEMORY_PATH;
  const nowMs = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const rows = readRows(learningMemoryPath);

  const watchRows = rows.filter(r => bucketVal(r.clusterRisk, 'UNKNOWN') === 'WATCH');
  const cleanRows = rows.filter(r => bucketVal(r.clusterRisk, 'UNKNOWN') === 'CLEAN');
  const groups: ValidationGroupStats[] = [
    computeGroup('WATCH + known liquidity', watchRows.filter(r => bucketVal(r.liquidityBucket, 'LIQ_UNKNOWN') !== 'LIQ_UNKNOWN')),
    computeGroup('WATCH + LIQ_UNKNOWN', watchRows.filter(r => bucketVal(r.liquidityBucket, 'LIQ_UNKNOWN') === 'LIQ_UNKNOWN')),
    computeGroup('WATCH + known VLR', watchRows.filter(r => bucketVal(r.vlrBucket, 'VLR_UNKNOWN') !== 'VLR_UNKNOWN')),
    computeGroup('WATCH + VLR_UNKNOWN', watchRows.filter(r => bucketVal(r.vlrBucket, 'VLR_UNKNOWN') === 'VLR_UNKNOWN')),
    computeGroup('CLEAN + known liquidity', cleanRows.filter(r => bucketVal(r.liquidityBucket, 'LIQ_UNKNOWN') !== 'LIQ_UNKNOWN')),
    computeGroup('CLEAN + LIQ_UNKNOWN', cleanRows.filter(r => bucketVal(r.liquidityBucket, 'LIQ_UNKNOWN') === 'LIQ_UNKNOWN')),
    computeGroup('WATCH + PRIME_WINDOW', watchRows.filter(r => bucketVal(r.launchAgeBucket, 'UNKNOWN') === 'PRIME_WINDOW')),
    computeGroup('CLEAN + PRIME_WINDOW', cleanRows.filter(r => bucketVal(r.launchAgeBucket, 'UNKNOWN') === 'PRIME_WINDOW')),
    computeGroup('WATCH + known timing', watchRows.filter(r => bucketVal(r.timingPath, 'UNKNOWN') !== 'UNKNOWN')),
    computeGroup('CLEAN + known timing', cleanRows.filter(r => bucketVal(r.timingPath, 'UNKNOWN') !== 'UNKNOWN')),
  ];

  const matchedComparisons = buildMatchedComparisons(rows);
  const rec = recommend(groups, matchedComparisons);

  return {
    generatedAt,
    learningMemoryPath,
    totalRows: rows.length,
    groups,
    matchedComparisons,
    recommendation: rec.recommendation,
    recommendationNote: rec.note,
    reportOnly: true,
    readOnly: true,
    paperOnly: true,
    realTradingLocked: true,
    tradingExecuted: 0,
  };
}

function pct(v: number | null): string {
  return v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

function num(v: number | null): string {
  return v == null ? 'n/a' : v.toFixed(1);
}

export function renderRipperWatchSignalValidation(result: WatchSignalValidationResult): string {
  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER WATCH SIGNAL VALIDATION');
  lines.push('  [REPORT ONLY — NO TRADES — NO POLICY CHANGE — READ ONLY]');
  lines.push(SEP, '');
  lines.push(`  Generated          : ${result.generatedAt}`);
  lines.push(`  Learning memory    : ${result.learningMemoryPath}`);
  lines.push(`  Total rows         : ${result.totalRows}`);
  lines.push('');

  lines.push('  GROUP COMPARISONS');
  for (const g of result.groups) {
    lines.push(`  - ${g.groupName}`);
    lines.push(`      total=${g.totalRows}  labeled=${g.labeledRows}  coverage=${g.labeledCoveragePct == null ? 'n/a' : g.labeledCoveragePct.toFixed(1) + '%'}  unique=${g.uniqueContracts}`);
    lines.push(`      BIG=${g.bigWinnerCount}/${pct(g.bigWinnerRate)}  WIN=${g.winnerCount}/${pct(g.winnerRate)}  SMALL=${g.smallWinnerCount}/${pct(g.smallWinnerRate)}  FLAT=${g.flatJunkCount}/${pct(g.flatJunkRate)}  DUMP=${g.dumpCount}/${pct(g.dumpRate)}`);
    lines.push(`      win5(observed)=${pct(g.observedWin5)}  win5(pessimistic)=${pct(g.pessimisticWin5)}  avg=${num(g.avgPriceChange)}%  median=${num(g.medianPriceChange)}%  artifactRisk=${g.artifactRisk}`);
  }
  lines.push('');

  lines.push('  MATCHED WATCH vs CLEAN');
  for (const r of result.matchedComparisons.filter(r => r.watchRows > 0 && r.cleanRows > 0)) {
    lines.push(`  - ${r.dimension}=${r.bucket}`);
    lines.push(`      WATCH rows=${r.watchRows} win5=${pct(r.watchObservedWin5)} pess=${pct(r.watchPessimisticWin5)} avg=${num(r.watchAvgPriceChange)}%`);
    lines.push(`      CLEAN rows=${r.cleanRows} win5=${pct(r.cleanObservedWin5)} pess=${pct(r.cleanPessimisticWin5)} avg=${num(r.cleanAvgPriceChange)}%`);
  }
  lines.push('');

  lines.push(`  RECOMMENDATION: ${result.recommendation}`);
  lines.push(`  ${result.recommendationNote}`);
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  paperOnly=true  realTradingLocked=true  tradingExecuted=0');
  lines.push('  HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(SEP, '');
  return lines.join('\n');
}
