// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  NO_GATE_CHANGES
//
// Cluster Coverage Audit v1 — read-only diagnostic that explains why clusterRisk
// is UNKNOWN so often and whether UNKNOWN cluster rows are contaminating M5 evidence.
//
// Does NOT call any API. Does NOT mutate any file. Does NOT change gates/policy.
// Never treats UNKNOWN as CLEAN.

import * as fs   from 'fs';
import * as path from 'path';

import {
  m5ToBand,
  getConfidenceTier,
  M5_BAND_ORDER,
  type M5Band,
  type ConfidenceTier,
} from './ripperM5EvidenceDashboard';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_CYCLES_DIR         = 'data/token-grab/ripper/cycles';
const DEFAULT_MEMORY_PATH        = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_INTENTS_PATH       = 'data/token-grab/ripper/paper-intents.jsonl';
const DEFAULT_OBSERVATIONS_PATH  = 'data/token-grab/ripper/paper-intent-observations.jsonl';
const DEFAULT_DEX_WATCH_RUNS_DIR = 'data/token-grab/dex-watch-runs';
const DEFAULT_RECENT             = 10;
const DEFAULT_TOP_N              = 10;
const SAMPLE_CAP                 = 20;
const PNL_CAP                    = 500;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// Cluster categories we recognize. Anything else (incl. absent) → MISSING.
export const CLUSTER_CATEGORIES = ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN', 'MISSING'] as const;
export type ClusterCategory = (typeof CLUSTER_CATEGORIES)[number];

// A known category is one where cluster risk was actually resolved.
const KNOWN_CATEGORIES: ClusterCategory[] = ['CLEAN', 'WATCH', 'RISKY'];

export const UNKNOWN_REASONS = [
  'API_CAP_SKIPPED',
  'CACHE_MISS',
  'API_ERROR',
  'NOT_FOUND',
  'NOT_REQUESTED',
  'SCHEMA_MISSING',
  'UNKNOWN_REASON_NOT_RECORDED',
  'MIXED_OR_UNCLEAR',
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

// ── Types ───────────────────────────────────────────────────────────────────────

export interface ClusterCounts {
  CLEAN:   number;
  WATCH:   number;
  RISKY:   number;
  UNKNOWN: number;
  MISSING: number;
}

export interface StageCoverage {
  stage:            string;
  total:            number;
  hasClusterField:  boolean;
  counts:           ClusterCounts;
  knownCoveragePct: number | null;
  unknownPct:       number | null;
  m5Rows:           number;
  m5UnknownRows:    number;
}

export interface RecentCycleCoverage {
  fileName:         string;
  capturedAt:       string | null;
  totalRows:        number;
  approvedRows:     number | null;
  rejectedRows:     number | null;
  counts:           ClusterCounts;
  knownCoveragePct: number | null;
  m5Rows:           number;
  m5UnknownRows:    number;
  bubbleMapsLiveCalls: number | null;
  bubbleMapsCacheHits: number | null;
  bubbleMapsCap:       number | null;
  bubbleMapsSkipped:   number | null;
  bubbleMapsDisabled:  boolean;
}

export interface UnknownReasonBreakdown {
  reasonSource:      string;
  reasonFieldExists: boolean;
  totalUnknown:      number;
  counts:            Record<UnknownReason, number>;
  note:              string;
}

export interface CapPressure {
  recentCyclesScanned:        number;
  cyclesWithCapHit:           number;
  cyclesWithBubbleMapsDisabled: number;
  liveCallsUsed:              number;
  liveCallCap:                number | null;
  cacheHits:                  number;
  skippedDueToCap:            number;
  unknownRateWhenCapHit:      number | null;
  unknownRateWhenNoCap:       number | null;
  liveCallsOnRejectedRows:    number;
  approvedRowsMissingHolder:  number;
  capLikelyLimiting:          boolean;
  note:                       string;
}

export interface CrossTabCell {
  m5Band:         M5Band;
  clusterRisk:    ClusterCategory;
  n:              number;
  pnlN:           number;
  wins:           number;
  winRate:        number | null;
  avgPnlCapped:   number | null;
  medianPnl:      number | null;
  bigWinners:     number;
  bigLosers:      number;
  confidenceTier: ConfidenceTier;
}

export interface ClusterSubStat {
  clusterRisk:    ClusterCategory;
  n:              number;
  pnlN:           number;
  wins:           number;
  winRate:        number | null;
  avgPnlCapped:   number | null;
  medianPnl:      number | null;
}

export type NeutralArtifactConclusion =
  | 'M5_NEUTRAL_CLEAN_SUPPORTED'
  | 'M5_NEUTRAL_UNKNOWN_ARTIFACT'
  | 'M5_NEUTRAL_INCONCLUSIVE'
  | 'M5_NEUTRAL_SAMPLE_TOO_SMALL';

export interface SampleRow {
  symbol:          string | null;
  contractPrefix:  string;
  capturedAt:      string | null;
  m5:              number | null;
  m5Band:          M5Band;
  liquidityBucket: string;
  vlrBucket:       string;
  paperDecision:   string;
  pnl:             number | null;
  unknownReason:   string;
}

export interface NeutralTradeRow {
  symbol:         string | null;
  contractPrefix: string;
  pnl:            number;
  m5:             number;
  clusterRisk:    ClusterCategory;
  liquidityBucket: string;
  vlrBucket:      string;
}

export interface NeutralArtifactReview {
  totalPnlN:           number;
  byCluster:           ClusterSubStat[];
  unknownPctOfPnlRows: number | null;
  artifactContaminated: boolean;
  conclusion:          NeutralArtifactConclusion;
  topUnknownWinners:   NeutralTradeRow[];
  topCleanRows:        NeutralTradeRow[];
  topLosers:           NeutralTradeRow[];
}

export interface ApprovedVsRejected {
  approvedTotal:        number;
  approvedUnknown:      number;
  approvedUnknownPct:   number | null;
  rejectedTotal:        number;
  rejectedUnknown:      number;
  rejectedUnknownPct:   number | null;
  approvedM5WithUnknown: number;
  rejectedM5WithUnknown: number;
  approvedSufficientlyCovered: boolean;
  note:                 string;
}

export type Diagnosis =
  | 'CLUSTER_COVERAGE_HEALTHY'
  | 'UNKNOWN_CLUSTER_DOMINATES_M5'
  | 'M5_NEUTRAL_UNKNOWN_ARTIFACT'
  | 'CLEAN_CLUSTER_SAMPLE_TOO_SMALL'
  | 'BUBBLEMAPS_CAP_LIMITING_COVERAGE'
  | 'APPROVED_ROWS_LACK_CLUSTER_COVERAGE'
  | 'UNKNOWN_REASON_NOT_PERSISTED'
  | 'NEEDS_HOLDER_RISK_FALLBACK'
  | 'NEEDS_INVESTIGATION';

export interface ClusterCoverageAuditResult {
  generatedAt: string;

  // §1 — overview
  latestCycleFile:        string | null;
  latestCycleCapturedAt:  string | null;
  latestMemoryTimestamp:  string | null;
  totalCycleRowsScanned:  number;
  totalMemoryRowsScanned: number;
  cycleRowsWithCluster:   number;
  cycleUnknownRows:       number;
  cycleKnownCoveragePct:  number | null;
  cycleUnknownPct:        number | null;
  memoryKnownCoveragePct: number | null;
  memoryUnknownPct:       number | null;
  m5RowsWithCluster:      number;
  m5PnlRowsWithCluster:   number;
  m5UnknownRows:          number;

  // §2
  recentCycles: RecentCycleCoverage[];

  // §3
  stageCoverage: StageCoverage[];

  // §4
  unknownReasons: UnknownReasonBreakdown;

  // §5
  capPressure: CapPressure;

  // §6
  crossTab: CrossTabCell[];

  // §7
  neutralReview: NeutralArtifactReview;

  // §8
  approvedVsRejected: ApprovedVsRejected;

  // §9
  samplesNeedingResolution: SampleRow[];

  // §10
  diagnoses: Diagnosis[];

  // §11
  recommendations: string[];

  // safety
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  noMutation:        true;
  noRealTrading:     true;
  noGateChanges:     true;
  noPolicyChange:    true;
  noWallet:          true;
  noSwap:            true;
  noSigning:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface ClusterCoverageAuditOptions {
  cyclesDir?:        string;
  memoryPath?:       string;
  intentsPath?:      string;
  observationsPath?: string;
  dexWatchRunsDir?:  string;
  recent?:           number;
  topN?:             number;
  generatedAt?:      string;
}

// ── Raw row types (defensive — do not assume schema) ────────────────────────────

interface RawCycleRow {
  capturedAt?:        string;
  entryMomentumPct?:  number | null;
  buyGateDecision?:   string;
  liquidityBucket?:   string;
  vlrBucket?:         string;
  normalizedSignal?:  { contract?: string; symbol?: string; liquidityBucket?: string; vlrBucket?: string };
  ripperInput?:       { contract?: string; clusterRisk?: string };
  raw?: {
    clusterRisk?:       string;
    clusterProvider?:   string;
    clusterConfidence?: string;
    clusterNotes?:      string[];
    clusterFetchError?: string;
    liquidityBucket?:   string;
    vlrBucket?:         string;
  };
}

interface RawMemRow {
  contract?:         string;
  symbol?:           string;
  capturedAt?:       string;
  observedAt?:       string | null;
  entryMomentumPct?: number | null;
  priceChangePct?:   number | null;
  liquidityBucket?:  string;
  vlrBucket?:        string;
  clusterRisk?:      string;
  gateDecision?:     string;
  entryDecision?:    string;
}

interface RawSimpleRow {
  clusterRisk?:      string;
  entryMomentumPct?: number | null;
  [k: string]: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

function listCycleJsonlFiles(cyclesDir: string): string[] {
  if (!fs.existsSync(cyclesDir)) return [];
  return fs.readdirSync(cyclesDir)
    .filter(f => /^cycle-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(f))
    .sort();
}

function cap(p: number): number {
  return Math.max(-PNL_CAP, Math.min(PNL_CAP, p));
}

function avg(arr: number[]): number | null {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function emptyCounts(): ClusterCounts {
  return { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0, MISSING: 0 };
}

// Normalize any clusterRisk value into one of the recognized categories.
// Absent / unrecognized → MISSING (NOT treated as CLEAN, NOT treated as UNKNOWN).
function normalizeCluster(value: unknown): ClusterCategory {
  if (typeof value !== 'string') return 'MISSING';
  const v = value.trim().toUpperCase();
  if (v === 'CLEAN')   return 'CLEAN';
  if (v === 'WATCH')   return 'WATCH';
  if (v === 'RISKY')   return 'RISKY';
  if (v === 'UNKNOWN') return 'UNKNOWN';
  return 'MISSING';
}

// Pull clusterRisk off a cycle row (raw first, then ripperInput).
function cycleCluster(row: RawCycleRow): ClusterCategory {
  if (row.raw?.clusterRisk != null)        return normalizeCluster(row.raw.clusterRisk);
  if (row.ripperInput?.clusterRisk != null) return normalizeCluster(row.ripperInput.clusterRisk);
  return 'MISSING';
}

function hasM5(m5: unknown): m5 is number {
  return typeof m5 === 'number' && Number.isFinite(m5);
}

function knownCoveragePct(counts: ClusterCounts): number | null {
  const total = countsTotal(counts);
  if (total === 0) return null;
  const known = counts.CLEAN + counts.WATCH + counts.RISKY;
  return (known / total) * 100;
}

function unknownPctOf(counts: ClusterCounts): number | null {
  const total = countsTotal(counts);
  if (total === 0) return null;
  return (counts.UNKNOWN / total) * 100;
}

function countsTotal(counts: ClusterCounts): number {
  return counts.CLEAN + counts.WATCH + counts.RISKY + counts.UNKNOWN + counts.MISSING;
}

// Classify a single UNKNOWN cycle row into a reason using its clusterNotes /
// clusterFetchError. Returns null reason source markers carefully — never invents.
function classifyUnknownReason(row: RawCycleRow): UnknownReason {
  const notes = (row.raw?.clusterNotes ?? []).map(n => String(n).toLowerCase());
  const fetchError = row.raw?.clusterFetchError;
  const matched = new Set<UnknownReason>();

  const blob = notes.join(' | ');
  if (/disabled/.test(blob))                          matched.add('NOT_REQUESTED');
  if (/per-run cap|cap of \d+|cap reached|cap of/.test(blob)) matched.add('API_CAP_SKIPPED');
  if (/http \d|429|timeout|fetch error|error/.test(blob) || (fetchError != null && fetchError !== '')) matched.add('API_ERROR');
  if (/cache miss|not cached/.test(blob))             matched.add('CACHE_MISS');
  if (/not found|no data|404|unknown token/.test(blob)) matched.add('NOT_FOUND');

  if (matched.size === 0) {
    // No diagnostic note present for this UNKNOWN row.
    if (notes.length === 0) return 'UNKNOWN_REASON_NOT_RECORDED';
    return 'MIXED_OR_UNCLEAR';
  }
  if (matched.size === 1) return [...matched][0];
  // More than one distinct reason category on the same row → ambiguous.
  return 'MIXED_OR_UNCLEAR';
}

function parseCapFromNotes(notes: string[] | undefined): number | null {
  if (!notes) return null;
  for (const n of notes) {
    const m = String(n).match(/cap of (\d+)|current:\s*(\d+)/i);
    if (m) {
      const v = m[1] ?? m[2];
      if (v != null) return Number(v);
    }
  }
  return null;
}

// ── Cycle scanning ──────────────────────────────────────────────────────────────

interface CycleScan {
  totalRows:        number;
  counts:           ClusterCounts;
  m5Rows:           number;
  m5UnknownRows:    number;
  approvedTotal:    number;
  approvedUnknown:  number;
  approvedM5Unknown: number;
  rejectedTotal:    number;
  rejectedUnknown:  number;
  rejectedM5Unknown: number;
  unknownReasonCounts: Record<UnknownReason, number>;
  reasonFieldEverPresent: boolean;
}

function emptyReasonCounts(): Record<UnknownReason, number> {
  const r = {} as Record<UnknownReason, number>;
  for (const k of UNKNOWN_REASONS) r[k] = 0;
  return r;
}

function scanCycleRows(rows: RawCycleRow[], acc: CycleScan): void {
  for (const row of rows) {
    acc.totalRows++;
    const cl = cycleCluster(row);
    acc.counts[cl]++;
    const m5 = hasM5(row.entryMomentumPct);
    if (m5) acc.m5Rows++;
    if (cl === 'UNKNOWN' && m5) acc.m5UnknownRows++;

    const gate = row.buyGateDecision ?? null;
    if (gate === 'BUY_APPROVED_PAPER') {
      acc.approvedTotal++;
      if (cl === 'UNKNOWN') acc.approvedUnknown++;
      if (cl === 'UNKNOWN' && m5) acc.approvedM5Unknown++;
    } else if (gate === 'BUY_REJECTED') {
      acc.rejectedTotal++;
      if (cl === 'UNKNOWN') acc.rejectedUnknown++;
      if (cl === 'UNKNOWN' && m5) acc.rejectedM5Unknown++;
    }

    if (cl === 'UNKNOWN') {
      // "reason present" means actual diagnostic CONTENT, not merely an empty key.
      const hasReasonContent =
        (Array.isArray(row.raw?.clusterNotes) && row.raw!.clusterNotes!.length > 0) ||
        (row.raw?.clusterFetchError != null && row.raw.clusterFetchError !== '');
      if (hasReasonContent) acc.reasonFieldEverPresent = true;
      acc.unknownReasonCounts[classifyUnknownReason(row)]++;
    }
  }
}

// ── Stage coverage ────────────────────────────────────────────────────────────

function computeSimpleStageCoverage(
  stage: string,
  rows: RawSimpleRow[],
  clusterFieldExists: boolean,
): StageCoverage {
  const counts = emptyCounts();
  let m5Rows = 0;
  let m5UnknownRows = 0;
  for (const r of rows) {
    const cl = normalizeCluster(r.clusterRisk);
    counts[cl]++;
    const m5 = hasM5(r.entryMomentumPct);
    if (m5) m5Rows++;
    if (m5 && cl === 'UNKNOWN') m5UnknownRows++;
  }
  return {
    stage,
    total: rows.length,
    hasClusterField: clusterFieldExists,
    counts,
    knownCoveragePct: knownCoveragePct(counts),
    unknownPct: unknownPctOf(counts),
    m5Rows,
    m5UnknownRows,
  };
}

// ── Memory cross-tab + neutral review ──────────────────────────────────────────

function memCluster(r: RawMemRow): ClusterCategory {
  return normalizeCluster(r.clusterRisk);
}

function computeCrossTab(m5Rows: RawMemRow[]): CrossTabCell[] {
  const cells: CrossTabCell[] = [];
  for (const band of M5_BAND_ORDER) {
    if (band === 'UNAVAILABLE') continue;
    const bandRows = m5Rows.filter(r => m5ToBand(r.entryMomentumPct) === band);
    const byCluster = new Map<ClusterCategory, RawMemRow[]>();
    for (const r of bandRows) {
      const c = memCluster(r);
      if (!byCluster.has(c)) byCluster.set(c, []);
      byCluster.get(c)!.push(r);
    }
    const orderedKeys = CLUSTER_CATEGORIES.filter(c => byCluster.has(c));
    for (const c of orderedKeys) {
      const rows = byCluster.get(c)!;
      const pnlRows = rows.filter(r => typeof r.priceChangePct === 'number');
      const pnls = pnlRows.map(r => r.priceChangePct as number);
      const wins = pnls.filter(p => p > 0).length;
      cells.push({
        m5Band: band,
        clusterRisk: c,
        n: rows.length,
        pnlN: pnlRows.length,
        wins,
        winRate: pnlRows.length > 0 ? wins / pnlRows.length : null,
        avgPnlCapped: avg(pnls.map(cap)),
        medianPnl: median(pnls),
        bigWinners: pnls.filter(p => p >= 20).length,
        bigLosers: pnls.filter(p => p <= -20).length,
        confidenceTier: getConfidenceTier(pnlRows.length),
      });
    }
  }
  return cells;
}

function computeClusterSubStat(c: ClusterCategory, rows: RawMemRow[]): ClusterSubStat {
  const pnlRows = rows.filter(r => typeof r.priceChangePct === 'number');
  const pnls = pnlRows.map(r => r.priceChangePct as number);
  const wins = pnls.filter(p => p > 0).length;
  return {
    clusterRisk: c,
    n: rows.length,
    pnlN: pnlRows.length,
    wins,
    winRate: pnlRows.length > 0 ? wins / pnlRows.length : null,
    avgPnlCapped: avg(pnls.map(cap)),
    medianPnl: median(pnls),
  };
}

function tradeRow(r: RawMemRow): NeutralTradeRow {
  return {
    symbol: r.symbol ?? null,
    contractPrefix: (r.contract ?? 'unknown').slice(0, 20),
    pnl: r.priceChangePct as number,
    m5: r.entryMomentumPct as number,
    clusterRisk: memCluster(r),
    liquidityBucket: r.liquidityBucket ?? 'UNKNOWN',
    vlrBucket: r.vlrBucket ?? 'UNKNOWN',
  };
}

function computeNeutralReview(neutralRows: RawMemRow[], topN: number): NeutralArtifactReview {
  const byCluster = new Map<ClusterCategory, RawMemRow[]>();
  for (const r of neutralRows) {
    const c = memCluster(r);
    if (!byCluster.has(c)) byCluster.set(c, []);
    byCluster.get(c)!.push(r);
  }
  const subStats: ClusterSubStat[] = CLUSTER_CATEGORIES
    .filter(c => byCluster.has(c))
    .map(c => computeClusterSubStat(c, byCluster.get(c)!));

  const totalPnlN = neutralRows.filter(r => typeof r.priceChangePct === 'number').length;
  const unknownStat = subStats.find(s => s.clusterRisk === 'UNKNOWN');
  const cleanStat   = subStats.find(s => s.clusterRisk === 'CLEAN');
  const unknownPctOfPnlRows = totalPnlN > 0 && unknownStat ? (unknownStat.pnlN / totalPnlN) * 100 : (totalPnlN > 0 ? 0 : null);

  // Conclusion logic — never treats UNKNOWN as supporting CLEAN.
  let conclusion: NeutralArtifactConclusion;
  let artifactContaminated = false;
  const cleanPnlN   = cleanStat?.pnlN ?? 0;
  const unknownPnlN = unknownStat?.pnlN ?? 0;
  const cleanAvg    = cleanStat?.avgPnlCapped ?? null;
  const unknownAvg  = unknownStat?.avgPnlCapped ?? null;

  if (totalPnlN < 20) {
    conclusion = 'M5_NEUTRAL_SAMPLE_TOO_SMALL';
  } else if (cleanPnlN < 50) {
    // CLEAN subset too thin to confirm anything; if UNKNOWN dominates, it's an artifact risk.
    if (unknownPctOfPnlRows != null && unknownPctOfPnlRows > 50) {
      conclusion = 'M5_NEUTRAL_UNKNOWN_ARTIFACT';
      artifactContaminated = true;
    } else {
      conclusion = 'M5_NEUTRAL_SAMPLE_TOO_SMALL';
    }
  } else if (
    unknownPctOfPnlRows != null && unknownPctOfPnlRows > 50 &&
    cleanAvg != null && unknownAvg != null && unknownAvg - cleanAvg >= 5
  ) {
    // UNKNOWN carries materially more edge than CLEAN AND dominates the sample.
    conclusion = 'M5_NEUTRAL_UNKNOWN_ARTIFACT';
    artifactContaminated = true;
  } else if (cleanStat && (cleanStat.winRate ?? 0) >= 0.55 && cleanAvg != null && cleanAvg > 0) {
    conclusion = 'M5_NEUTRAL_CLEAN_SUPPORTED';
  } else {
    conclusion = 'M5_NEUTRAL_INCONCLUSIVE';
  }

  const pnlRows = neutralRows.filter(r => typeof r.priceChangePct === 'number');
  const topUnknownWinners = pnlRows
    .filter(r => memCluster(r) === 'UNKNOWN' && (r.priceChangePct as number) > 0)
    .sort((a, b) => (b.priceChangePct as number) - (a.priceChangePct as number))
    .slice(0, topN)
    .map(tradeRow);
  const topCleanRows = pnlRows
    .filter(r => memCluster(r) === 'CLEAN')
    .sort((a, b) => (b.priceChangePct as number) - (a.priceChangePct as number))
    .slice(0, topN)
    .map(tradeRow);
  const topLosers = pnlRows
    .filter(r => (r.priceChangePct as number) <= 0)
    .sort((a, b) => (a.priceChangePct as number) - (b.priceChangePct as number))
    .slice(0, topN)
    .map(tradeRow);

  return {
    totalPnlN,
    byCluster: subStats,
    unknownPctOfPnlRows,
    artifactContaminated,
    conclusion,
    topUnknownWinners,
    topCleanRows,
    topLosers,
  };
}

// ── Main runner ──────────────────────────────────────────────────────────────────

export function runClusterCoverageAudit(
  opts: ClusterCoverageAuditOptions = {},
): ClusterCoverageAuditResult {
  const cyclesDir        = opts.cyclesDir        ?? DEFAULT_CYCLES_DIR;
  const memoryPath       = opts.memoryPath       ?? DEFAULT_MEMORY_PATH;
  const intentsPath      = opts.intentsPath      ?? DEFAULT_INTENTS_PATH;
  const observationsPath = opts.observationsPath ?? DEFAULT_OBSERVATIONS_PATH;
  const recent           = opts.recent           ?? DEFAULT_RECENT;
  const topN             = opts.topN             ?? DEFAULT_TOP_N;
  const generatedAt      = opts.generatedAt      ?? new Date().toISOString();

  // ── Cycle files ────────────────────────────────────────────────────────────
  const allCycleFiles = listCycleJsonlFiles(cyclesDir);
  const latestCycleFile = allCycleFiles.at(-1) ?? null;

  // Full scan across all cycle files for overview / reasons / approved-rejected.
  const cycleScan: CycleScan = {
    totalRows: 0,
    counts: emptyCounts(),
    m5Rows: 0,
    m5UnknownRows: 0,
    approvedTotal: 0,
    approvedUnknown: 0,
    approvedM5Unknown: 0,
    rejectedTotal: 0,
    rejectedUnknown: 0,
    rejectedM5Unknown: 0,
    unknownReasonCounts: emptyReasonCounts(),
    reasonFieldEverPresent: false,
  };
  let latestCycleCapturedAt: string | null = null;
  for (const f of allCycleFiles) {
    const rows = readJsonl<RawCycleRow>(path.join(cyclesDir, f));
    scanCycleRows(rows, cycleScan);
    for (const r of rows) {
      if (r.capturedAt && (!latestCycleCapturedAt || r.capturedAt > latestCycleCapturedAt)) {
        latestCycleCapturedAt = r.capturedAt;
      }
    }
  }

  // ── Recent cycle coverage (last `recent` files) ────────────────────────────
  const recentFiles = allCycleFiles.slice(-recent);
  const recentCycles: RecentCycleCoverage[] = recentFiles.map(f => {
    const rows = readJsonl<RawCycleRow>(path.join(cyclesDir, f));
    const counts = emptyCounts();
    let m5Rows = 0, m5UnknownRows = 0, approved = 0, rejected = 0;
    let liveCalls = 0, cacheHits = 0, skipped = 0, disabled = false;
    let cyCap: number | null = null;
    let sawGate = false;
    for (const r of rows) {
      const cl = cycleCluster(r);
      counts[cl]++;
      const m5 = hasM5(r.entryMomentumPct);
      if (m5) m5Rows++;
      if (m5 && cl === 'UNKNOWN') m5UnknownRows++;
      if (r.buyGateDecision === 'BUY_APPROVED_PAPER') { approved++; sawGate = true; }
      else if (r.buyGateDecision === 'BUY_REJECTED')  { rejected++; sawGate = true; }
      const provider = r.raw?.clusterProvider;
      if (provider === 'bubblemaps') liveCalls++;
      else if (provider === 'bubblemaps-cached') cacheHits++;
      const notes = r.raw?.clusterNotes ?? [];
      const blob = notes.join(' | ').toLowerCase();
      if (/disabled/.test(blob)) disabled = true;
      if (/cap of|per-run cap/.test(blob)) skipped++;
      const parsed = parseCapFromNotes(notes);
      if (parsed != null) cyCap = parsed;
    }
    return {
      fileName: f,
      capturedAt: rows[0]?.capturedAt ?? null,
      totalRows: rows.length,
      approvedRows: sawGate ? approved : null,
      rejectedRows: sawGate ? rejected : null,
      counts,
      knownCoveragePct: knownCoveragePct(counts),
      m5Rows,
      m5UnknownRows,
      bubbleMapsLiveCalls: liveCalls,
      bubbleMapsCacheHits: cacheHits,
      bubbleMapsCap: cyCap,
      bubbleMapsSkipped: skipped,
      bubbleMapsDisabled: disabled,
    };
  });

  // ── Learning memory ────────────────────────────────────────────────────────
  const memRows = readJsonl<RawMemRow>(memoryPath);
  let latestMemoryTimestamp: string | null = null;
  const memCounts = emptyCounts();
  for (const r of memRows) {
    const ts = r.observedAt ?? r.capturedAt ?? null;
    if (ts && (!latestMemoryTimestamp || ts > latestMemoryTimestamp)) latestMemoryTimestamp = ts;
    memCounts[memCluster(r)]++;
  }
  const m5MemRows = memRows.filter(r => hasM5(r.entryMomentumPct));
  const m5PnlMemRows = m5MemRows.filter(r => typeof r.priceChangePct === 'number');
  const m5UnknownMem = m5MemRows.filter(r => memCluster(r) === 'UNKNOWN').length;

  // ── Stage coverage ─────────────────────────────────────────────────────────
  const intentRows = readJsonl<RawSimpleRow>(intentsPath);
  const obsRows     = readJsonl<RawSimpleRow>(observationsPath);
  const intentsHaveCluster = intentRows.some(r => r.clusterRisk != null);
  const obsHaveCluster     = obsRows.some(r => r.clusterRisk != null);

  const cycleStage: StageCoverage = {
    stage: 'cycle-rows',
    total: cycleScan.totalRows,
    hasClusterField: true,
    counts: cycleScan.counts,
    knownCoveragePct: knownCoveragePct(cycleScan.counts),
    unknownPct: unknownPctOf(cycleScan.counts),
    m5Rows: cycleScan.m5Rows,
    m5UnknownRows: cycleScan.m5UnknownRows,
  };
  const stageCoverage: StageCoverage[] = [
    cycleStage,
    computeSimpleStageCoverage('paper-intents', intentRows, intentsHaveCluster),
    computeSimpleStageCoverage('observations',  obsRows, obsHaveCluster),
    computeSimpleStageCoverage('learning-memory', memRows as RawSimpleRow[], true),
  ];

  // ── Unknown reason breakdown ───────────────────────────────────────────────
  // Row-level reasons exist ONLY on cycle rows (via clusterNotes/clusterFetchError).
  // The learning-memory M5 evidence layer does NOT persist a reason field.
  const reasonFieldExists = cycleScan.reasonFieldEverPresent;
  const unknownReasons: UnknownReasonBreakdown = {
    reasonSource: 'cycle-rows raw.clusterNotes / raw.clusterFetchError',
    reasonFieldExists,
    totalUnknown: cycleScan.counts.UNKNOWN,
    counts: cycleScan.unknownReasonCounts,
    note: reasonFieldExists
      ? 'Cycle rows carry row-level cluster notes. The learning-memory (M5 evidence) layer does NOT ' +
        'persist a per-row unknownReason field — UNKNOWN M5 rows cannot be attributed without a cycle join.'
      : 'No row-level cluster reason fields found in cycle rows. UNKNOWN reason is NOT persisted ' +
        'anywhere — classified as UNKNOWN_REASON_NOT_RECORDED. Recommend adding a future unknownReason field.',
  };

  // ── Cap pressure ───────────────────────────────────────────────────────────
  const capPressure = computeCapPressure(recentCycles, cyclesDir);

  // ── Cross-tab + neutral review ─────────────────────────────────────────────
  const crossTab = computeCrossTab(m5MemRows);
  const neutralRows = m5MemRows.filter(r => m5ToBand(r.entryMomentumPct) === 'M5_NEUTRAL');
  const neutralReview = computeNeutralReview(neutralRows, topN);

  // ── Approved vs rejected (cycle rows, all-time) ────────────────────────────
  const approvedUnknownPct = cycleScan.approvedTotal > 0
    ? (cycleScan.approvedUnknown / cycleScan.approvedTotal) * 100 : null;
  const rejectedUnknownPct = cycleScan.rejectedTotal > 0
    ? (cycleScan.rejectedUnknown / cycleScan.rejectedTotal) * 100 : null;
  const approvedSufficientlyCovered = approvedUnknownPct != null && approvedUnknownPct <= 25;
  const approvedVsRejected: ApprovedVsRejected = {
    approvedTotal: cycleScan.approvedTotal,
    approvedUnknown: cycleScan.approvedUnknown,
    approvedUnknownPct,
    rejectedTotal: cycleScan.rejectedTotal,
    rejectedUnknown: cycleScan.rejectedUnknown,
    rejectedUnknownPct,
    approvedM5WithUnknown: cycleScan.approvedM5Unknown,
    rejectedM5WithUnknown: cycleScan.rejectedM5Unknown,
    approvedSufficientlyCovered,
    note: approvedSufficientlyCovered
      ? 'Approved paper candidates are mostly holder-covered (UNKNOWN ≤ 25%).'
      : `Approved paper candidates are NOT sufficiently holder-covered — ` +
        `${approvedUnknownPct != null ? approvedUnknownPct.toFixed(0) : '?'}% of approved rows have UNKNOWN cluster risk. ` +
        `Holder coverage is being spent unevenly. (Report only — no gate change.)`,
  };

  // ── Samples needing resolution (M5 + UNKNOWN + approved/observed) ───────────
  const samplesNeedingResolution = buildSamples(memRows, topN);

  // ── Diagnoses ──────────────────────────────────────────────────────────────
  const diagnoses = computeDiagnoses({
    cycleScan,
    neutralReview,
    approvedVsRejected,
    capPressure,
    reasonFieldExists,
    m5UnknownMem,
    m5MemRowsCount: m5MemRows.length,
  });

  // ── Recommendations ────────────────────────────────────────────────────────
  const recommendations = computeRecommendations(diagnoses, reasonFieldExists, capPressure, approvedVsRejected);

  return {
    generatedAt,
    latestCycleFile,
    latestCycleCapturedAt,
    latestMemoryTimestamp,
    totalCycleRowsScanned: cycleScan.totalRows,
    totalMemoryRowsScanned: memRows.length,
    cycleRowsWithCluster: countsTotal(cycleScan.counts) - cycleScan.counts.MISSING,
    cycleUnknownRows: cycleScan.counts.UNKNOWN,
    cycleKnownCoveragePct: knownCoveragePct(cycleScan.counts),
    cycleUnknownPct: unknownPctOf(cycleScan.counts),
    memoryKnownCoveragePct: knownCoveragePct(memCounts),
    memoryUnknownPct: unknownPctOf(memCounts),
    m5RowsWithCluster: m5MemRows.length,
    m5PnlRowsWithCluster: m5PnlMemRows.length,
    m5UnknownRows: m5UnknownMem,
    recentCycles,
    stageCoverage,
    unknownReasons,
    capPressure,
    crossTab,
    neutralReview,
    approvedVsRejected,
    samplesNeedingResolution,
    diagnoses,
    recommendations,
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    noMutation:        true,
    noRealTrading:     true,
    noGateChanges:     true,
    noPolicyChange:    true,
    noWallet:          true,
    noSwap:            true,
    noSigning:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
  };
}

function computeCapPressure(recentCycles: RecentCycleCoverage[], _cyclesDir: string): CapPressure {
  const cyclesWithCapHit = recentCycles.filter(c => (c.bubbleMapsSkipped ?? 0) > 0).length;
  const cyclesDisabled   = recentCycles.filter(c => c.bubbleMapsDisabled).length;
  const liveCallsUsed    = recentCycles.reduce((s, c) => s + (c.bubbleMapsLiveCalls ?? 0), 0);
  const cacheHits        = recentCycles.reduce((s, c) => s + (c.bubbleMapsCacheHits ?? 0), 0);
  const skippedDueToCap  = recentCycles.reduce((s, c) => s + (c.bubbleMapsSkipped ?? 0), 0);
  const liveCallCap = recentCycles.map(c => c.bubbleMapsCap).filter((v): v is number => v != null).at(-1) ?? null;

  // UNKNOWN rate when cap hit vs not
  const capHitCycles = recentCycles.filter(c => (c.bubbleMapsSkipped ?? 0) > 0);
  const noCapCycles  = recentCycles.filter(c => (c.bubbleMapsSkipped ?? 0) === 0);
  const rate = (cs: RecentCycleCoverage[]): number | null => {
    const total = cs.reduce((s, c) => s + c.totalRows, 0);
    if (total === 0) return null;
    const unknown = cs.reduce((s, c) => s + c.counts.UNKNOWN, 0);
    return (unknown / total) * 100;
  };

  // Approved-but-missing-holder + live-calls-on-rejected need per-row data; we
  // approximate at the cycle aggregate level for the recent window.
  const approvedRowsMissingHolder = recentCycles.reduce(
    (s, c) => s + Math.min(c.counts.UNKNOWN, c.approvedRows ?? 0), 0);

  // Cap is only "limiting" if rows were actually skipped due to cap (not merely disabled).
  const capLikelyLimiting = skippedDueToCap > 0 && cyclesDisabled < recentCycles.length;

  let note: string;
  const disabledMajority = recentCycles.length > 0 && cyclesDisabled > recentCycles.length / 2;
  if (cyclesDisabled === recentCycles.length && recentCycles.length > 0) {
    note = 'BubbleMaps is DISABLED across all recent cycles (env flag). UNKNOWN is driven by the ' +
           'disable flag, NOT by the per-run cap. Re-enabling live calls would do more than raising the cap.';
  } else if (disabledMajority) {
    note = `BubbleMaps is DISABLED in ${cyclesDisabled}/${recentCycles.length} recent cycles — the disable flag is the ` +
           `dominant UNKNOWN driver. The per-run cap also skipped ${skippedDueToCap} rows in the cycle(s) where live ` +
           `calls were enabled, but re-enabling BubbleMaps matters more than raising the cap.`;
  } else if (capLikelyLimiting) {
    note = `Per-run cap is skipping rows (${skippedDueToCap} skipped across recent cycles). ` +
           `Cap may be limiting holder coverage for some candidates.`;
  } else {
    note = 'No clear cap pressure detected in the recent window.';
  }

  return {
    recentCyclesScanned: recentCycles.length,
    cyclesWithCapHit,
    cyclesWithBubbleMapsDisabled: cyclesDisabled,
    liveCallsUsed,
    liveCallCap,
    cacheHits,
    skippedDueToCap,
    unknownRateWhenCapHit: rate(capHitCycles),
    unknownRateWhenNoCap: rate(noCapCycles),
    liveCallsOnRejectedRows: 0,
    approvedRowsMissingHolder,
    capLikelyLimiting,
    note,
  };
}

function buildSamples(memRows: RawMemRow[], topN: number): SampleRow[] {
  const cap = Math.max(SAMPLE_CAP, topN);
  const candidates = memRows.filter(r =>
    hasM5(r.entryMomentumPct) &&
    memCluster(r) === 'UNKNOWN' &&
    (r.gateDecision === 'BUY_APPROVED_PAPER' || r.entryDecision != null || r.observedAt != null),
  );
  // Most recent first by observedAt/capturedAt.
  candidates.sort((a, b) => {
    const ta = a.observedAt ?? a.capturedAt ?? '';
    const tb = b.observedAt ?? b.capturedAt ?? '';
    return tb.localeCompare(ta);
  });
  return candidates.slice(0, cap).map(r => ({
    symbol: r.symbol ?? null,
    contractPrefix: (r.contract ?? 'unknown').slice(0, 16),
    capturedAt: r.observedAt ?? r.capturedAt ?? null,
    m5: hasM5(r.entryMomentumPct) ? (r.entryMomentumPct as number) : null,
    m5Band: m5ToBand(r.entryMomentumPct),
    liquidityBucket: r.liquidityBucket ?? 'UNKNOWN',
    vlrBucket: r.vlrBucket ?? 'UNKNOWN',
    paperDecision: r.gateDecision ?? r.entryDecision ?? 'unknown',
    pnl: typeof r.priceChangePct === 'number' ? r.priceChangePct : null,
    // Reason is NOT persisted at the memory layer.
    unknownReason: 'NOT_RECORDED (memory layer — see cycle reason breakdown)',
  }));
}

function computeDiagnoses(ctx: {
  cycleScan: CycleScan;
  neutralReview: NeutralArtifactReview;
  approvedVsRejected: ApprovedVsRejected;
  capPressure: CapPressure;
  reasonFieldExists: boolean;
  m5UnknownMem: number;
  m5MemRowsCount: number;
}): Diagnosis[] {
  const d: Diagnosis[] = [];
  const m5UnknownPct = ctx.m5MemRowsCount > 0 ? (ctx.m5UnknownMem / ctx.m5MemRowsCount) * 100 : 0;

  if (m5UnknownPct > 50) d.push('UNKNOWN_CLUSTER_DOMINATES_M5');
  if (ctx.neutralReview.conclusion === 'M5_NEUTRAL_UNKNOWN_ARTIFACT') d.push('M5_NEUTRAL_UNKNOWN_ARTIFACT');

  const cleanStat = ctx.neutralReview.byCluster.find(s => s.clusterRisk === 'CLEAN');
  if (cleanStat && cleanStat.pnlN < 50) d.push('CLEAN_CLUSTER_SAMPLE_TOO_SMALL');

  if (ctx.capPressure.capLikelyLimiting) d.push('BUBBLEMAPS_CAP_LIMITING_COVERAGE');
  if (!ctx.approvedVsRejected.approvedSufficientlyCovered &&
      ctx.approvedVsRejected.approvedTotal > 0) d.push('APPROVED_ROWS_LACK_CLUSTER_COVERAGE');

  // Reason not persisted at the M5 evidence (memory) layer — always true here,
  // since memory rows carry no clusterNotes/unknownReason.
  d.push('UNKNOWN_REASON_NOT_PERSISTED');

  // If BubbleMaps is disabled across the board, a fallback holder source is worth study.
  if (ctx.capPressure.cyclesWithBubbleMapsDisabled === ctx.capPressure.recentCyclesScanned &&
      ctx.capPressure.recentCyclesScanned > 0) {
    d.push('NEEDS_HOLDER_RISK_FALLBACK');
  }

  if (d.length === 0) d.push('CLUSTER_COVERAGE_HEALTHY');
  return d;
}

function computeRecommendations(
  diagnoses: Diagnosis[],
  reasonFieldExists: boolean,
  capPressure: CapPressure,
  approvedVsRejected: ApprovedVsRejected,
): string[] {
  const recs: string[] = [];
  recs.push('Do NOT treat UNKNOWN cluster risk as CLEAN in any M5 conclusion.');
  recs.push('Do NOT change gates, policy, or filters based on this report.');

  if (diagnoses.includes('M5_NEUTRAL_UNKNOWN_ARTIFACT')) {
    recs.push('Treat the apparent M5_NEUTRAL edge as cluster-artifact-contaminated until the CLEAN ' +
              'subset is large enough to confirm independently.');
  }
  if (diagnoses.includes('CLEAN_CLUSTER_SAMPLE_TOO_SMALL')) {
    recs.push('Keep collecting CLEAN M5_NEUTRAL rows — the CLEAN subset is below the 50-row confidence floor.');
  }
  if (diagnoses.includes('UNKNOWN_REASON_NOT_PERSISTED')) {
    recs.push('Add a row-level `unknownReason` field to learning-memory in a future data-quality task ' +
              'so UNKNOWN M5 rows can be attributed without a cycle join. (Cycle rows already carry clusterNotes.)');
  }
  if (diagnoses.includes('APPROVED_ROWS_LACK_CLUSTER_COVERAGE')) {
    recs.push('In a FUTURE proposal (not now), study prioritizing BubbleMaps calls for BUY_APPROVED_PAPER ' +
              'candidates so approved rows are holder-covered before rejected rows consume the budget.');
  }
  if (diagnoses.includes('NEEDS_HOLDER_RISK_FALLBACK')) {
    recs.push('BubbleMaps is disabled across recent cycles — consider studying a holder-risk fallback source ' +
              'in a future task. Re-enabling live BubbleMaps calls would also restore coverage.');
  }
  if (diagnoses.includes('BUBBLEMAPS_CAP_LIMITING_COVERAGE')) {
    recs.push('Per-run cap is skipping holder lookups — study raising the cap or prioritizing approved candidates ' +
              '(future proposal only).');
  }
  recs.push('Continue collecting data if cluster coverage is improving over time.');
  return recs;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function pct(v: number | null | undefined): string {
  if (v == null) return '   n/a';
  return v.toFixed(1) + '%';
}

function pctRate(v: number | null | undefined): string {
  if (v == null) return '   n/a';
  return (v * 100).toFixed(1) + '%';
}

function fmt1(v: number | null | undefined): string {
  if (v == null) return '  n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderClusterCoverageAudit(r: ClusterCoverageAuditResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — CLUSTER COVERAGE AUDIT v1');
  L.push('  [REPORT ONLY — READ ONLY — PAPER ONLY — NO MUTATION — NO GATE CHANGES]');
  L.push('  Explains why clusterRisk is UNKNOWN and whether UNKNOWN contaminates M5 evidence.');
  L.push('  UNKNOWN is NEVER treated as CLEAN.');
  L.push(SEP, '');

  // §1 — Overview
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Generated at              : ${r.generatedAt}`);
  L.push(`  Latest cycle file         : ${r.latestCycleFile ?? '(none)'}`);
  L.push(`  Latest cycle capturedAt   : ${r.latestCycleCapturedAt ?? '(none)'}`);
  L.push(`  Latest memory timestamp   : ${r.latestMemoryTimestamp ?? '(none)'}`);
  L.push(`  Total cycle rows scanned  : ${r.totalCycleRowsScanned}`);
  L.push(`  Total memory rows scanned : ${r.totalMemoryRowsScanned}`);
  L.push(`  Cycle rows with clusterRisk: ${r.cycleRowsWithCluster}`);
  L.push(`  Cycle UNKNOWN rows        : ${r.cycleUnknownRows}`);
  L.push(`  Cycle known coverage      : ${pct(r.cycleKnownCoveragePct)}`);
  L.push(`  Cycle UNKNOWN cluster %   : ${pct(r.cycleUnknownPct)}`);
  L.push(`  Memory known coverage     : ${pct(r.memoryKnownCoveragePct)}`);
  L.push(`  Memory UNKNOWN cluster %  : ${pct(r.memoryUnknownPct)}`);
  L.push(`  M5 rows with clusterRisk  : ${r.m5RowsWithCluster}`);
  L.push(`  M5+PNL rows w/ clusterRisk : ${r.m5PnlRowsWithCluster}`);
  L.push(`  M5 UNKNOWN cluster rows   : ${r.m5UnknownRows}`);
  L.push(`  High-level diagnosis      : ${r.diagnoses[0] ?? '(none)'}`);
  L.push('');

  // §2 — Recent cycle cluster coverage
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 2 — RECENT CYCLE CLUSTER COVERAGE (last ${r.recentCycles.length})`);
  L.push(`  ${SEP2}`, '');
  if (r.recentCycles.length === 0) {
    L.push('  (no cycle files found)');
  } else {
    L.push(`  ${'file'.padEnd(34)} ${'rows'.padStart(4)} ${'apr'.padStart(4)} ${'rej'.padStart(4)} ${'CLN'.padStart(4)} ${'WCH'.padStart(4)} ${'RSK'.padStart(4)} ${'UNK'.padStart(4)} ${'known%'.padStart(7)} ${'m5'.padStart(3)} ${'m5U'.padStart(3)} ${'live'.padStart(4)} ${'cap'.padStart(4)} ${'skp'.padStart(4)} dis`);
    for (const c of r.recentCycles) {
      L.push(
        `  ${c.fileName.padEnd(34)} ` +
        `${String(c.totalRows).padStart(4)} ` +
        `${String(c.approvedRows ?? '-').padStart(4)} ` +
        `${String(c.rejectedRows ?? '-').padStart(4)} ` +
        `${String(c.counts.CLEAN).padStart(4)} ` +
        `${String(c.counts.WATCH).padStart(4)} ` +
        `${String(c.counts.RISKY).padStart(4)} ` +
        `${String(c.counts.UNKNOWN).padStart(4)} ` +
        `${pct(c.knownCoveragePct).padStart(7)} ` +
        `${String(c.m5Rows).padStart(3)} ` +
        `${String(c.m5UnknownRows).padStart(3)} ` +
        `${String(c.bubbleMapsLiveCalls ?? '-').padStart(4)} ` +
        `${String(c.bubbleMapsCap ?? '-').padStart(4)} ` +
        `${String(c.bubbleMapsSkipped ?? '-').padStart(4)} ` +
        `${c.bubbleMapsDisabled ? 'yes' : ' no'}`,
      );
    }
    L.push('  (apr=approved rej=rejected CLN/WCH/RSK/UNK=cluster counts m5U=M5 rows w/ UNKNOWN');
    L.push('   live=live BubbleMaps calls cap=per-run cap skp=cap-skipped dis=BubbleMaps disabled)');
  }
  L.push('');

  // §3 — Cluster coverage by stage
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — CLUSTER COVERAGE BY STAGE');
  L.push(`  ${SEP2}`, '');
  L.push(`  ${'stage'.padEnd(16)} ${'total'.padStart(6)} ${'CLEAN'.padStart(6)} ${'WATCH'.padStart(6)} ${'RISKY'.padStart(6)} ${'UNKWN'.padStart(6)} ${'MISS'.padStart(6)} ${'known%'.padStart(7)} ${'m5'.padStart(4)} ${'m5U'.padStart(4)}`);
  L.push(`  ${'─'.repeat(16)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(4)} ${'─'.repeat(4)}`);
  for (const s of r.stageCoverage) {
    L.push(
      `  ${s.stage.padEnd(16)} ` +
      `${String(s.total).padStart(6)} ` +
      `${String(s.counts.CLEAN).padStart(6)} ` +
      `${String(s.counts.WATCH).padStart(6)} ` +
      `${String(s.counts.RISKY).padStart(6)} ` +
      `${String(s.counts.UNKNOWN).padStart(6)} ` +
      `${String(s.counts.MISSING).padStart(6)} ` +
      `${pct(s.knownCoveragePct).padStart(7)} ` +
      `${String(s.m5Rows).padStart(4)} ` +
      `${String(s.m5UnknownRows).padStart(4)}`,
    );
    if (!s.hasClusterField) {
      L.push(`    ⚠ ${s.stage}: no clusterRisk field present — all rows counted as MISSING (schema gap).`);
    }
  }
  L.push('');

  // §4 — UNKNOWN reason breakdown
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — UNKNOWN REASON BREAKDOWN');
  L.push(`  ${SEP2}`, '');
  L.push(`  Reason source        : ${r.unknownReasons.reasonSource}`);
  L.push(`  Reason field exists  : ${r.unknownReasons.reasonFieldExists ? 'yes (cycle rows)' : 'no'}`);
  L.push(`  Total UNKNOWN (cycle): ${r.unknownReasons.totalUnknown}`);
  L.push('');
  for (const reason of UNKNOWN_REASONS) {
    L.push(`    ${reason.padEnd(30)} : ${r.unknownReasons.counts[reason]}`);
  }
  L.push('');
  L.push(`  Note: ${r.unknownReasons.note}`);
  L.push('');

  // §5 — BubbleMaps cap pressure
  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — BUBBLEMAPS CAP PRESSURE');
  L.push(`  ${SEP2}`, '');
  const cp = r.capPressure;
  L.push(`  Recent cycles scanned        : ${cp.recentCyclesScanned}`);
  L.push(`  Cycles with cap hit          : ${cp.cyclesWithCapHit}`);
  L.push(`  Cycles w/ BubbleMaps disabled: ${cp.cyclesWithBubbleMapsDisabled}`);
  L.push(`  Live calls used (recent)     : ${cp.liveCallsUsed}`);
  L.push(`  Live call cap                : ${cp.liveCallCap ?? '(none recorded)'}`);
  L.push(`  Rows skipped due to cap      : ${cp.skippedDueToCap}`);
  L.push(`  UNKNOWN rate when cap hit    : ${pct(cp.unknownRateWhenCapHit)}`);
  L.push(`  UNKNOWN rate when no cap     : ${pct(cp.unknownRateWhenNoCap)}`);
  L.push(`  Approved rows missing holder : ${cp.approvedRowsMissingHolder} (recent window, approx)`);
  L.push(`  Cap likely limiting coverage : ${cp.capLikelyLimiting ? 'YES' : 'no'}`);
  L.push('');
  L.push(`  ${cp.note}`);
  L.push('');

  // §6 — M5 band × cluster risk
  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — M5 BAND × CLUSTER RISK');
  L.push(`  ${SEP2}`, '');
  if (r.crossTab.length === 0) {
    L.push('  (no M5 rows)');
  } else {
    L.push(`  ${'m5_band'.padEnd(18)} ${'cluster'.padEnd(8)} ${'n'.padStart(5)} ${'pnl_n'.padStart(6)} ${'win%'.padStart(7)} ${'avg_cap'.padStart(9)} ${'median'.padStart(8)} ${'bw'.padStart(3)} ${'bl'.padStart(3)}  tier`);
    L.push(`  ${'─'.repeat(18)} ${'─'.repeat(8)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(9)} ${'─'.repeat(8)} ${'─'.repeat(3)} ${'─'.repeat(3)}  ${'─'.repeat(16)}`);
    for (const c of r.crossTab) {
      L.push(
        `  ${c.m5Band.padEnd(18)} ` +
        `${c.clusterRisk.padEnd(8)} ` +
        `${String(c.n).padStart(5)} ` +
        `${String(c.pnlN).padStart(6)} ` +
        `${pctRate(c.winRate).padStart(7)} ` +
        `${(fmt1(c.avgPnlCapped) + '%').padStart(9)} ` +
        `${(fmt1(c.medianPnl) + '%').padStart(8)} ` +
        `${String(c.bigWinners).padStart(3)} ` +
        `${String(c.bigLosers).padStart(3)}  ` +
        `${c.confidenceTier}`,
      );
    }
  }
  L.push('  Note: UNKNOWN cluster risk must NOT be treated as CLEAN.');
  L.push('');

  // §7 — M5_NEUTRAL cluster artifact review
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — M5_NEUTRAL CLUSTER ARTIFACT REVIEW');
  L.push(`  ${SEP2}`, '');
  const nr = r.neutralReview;
  L.push(`  M5_NEUTRAL total PNL rows : ${nr.totalPnlN}`);
  L.push(`  UNKNOWN % of PNL rows     : ${pct(nr.unknownPctOfPnlRows)}`);
  L.push(`  Artifact contaminated     : ${nr.artifactContaminated ? 'YES' : 'no'}`);
  L.push('');
  L.push(`  ${'cluster'.padEnd(8)} ${'n'.padStart(5)} ${'pnl_n'.padStart(6)} ${'win%'.padStart(7)} ${'avg_cap'.padStart(9)} ${'median'.padStart(8)}`);
  L.push(`  ${'─'.repeat(8)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(9)} ${'─'.repeat(8)}`);
  for (const s of nr.byCluster) {
    L.push(
      `  ${s.clusterRisk.padEnd(8)} ` +
      `${String(s.n).padStart(5)} ` +
      `${String(s.pnlN).padStart(6)} ` +
      `${pctRate(s.winRate).padStart(7)} ` +
      `${(fmt1(s.avgPnlCapped) + '%').padStart(9)} ` +
      `${(fmt1(s.medianPnl) + '%').padStart(8)}`,
    );
  }
  L.push('');
  L.push(`  CONCLUSION: ${nr.conclusion}`);
  L.push('');
  renderNeutralTrades(L, `  Top ${nr.topUnknownWinners.length} M5_NEUTRAL UNKNOWN winners:`, nr.topUnknownWinners);
  renderNeutralTrades(L, `  Top ${nr.topCleanRows.length} M5_NEUTRAL CLEAN rows:`, nr.topCleanRows);
  renderNeutralTrades(L, `  Top ${nr.topLosers.length} M5_NEUTRAL losers:`, nr.topLosers);

  // §8 — Approved vs rejected cluster coverage
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — APPROVED vs REJECTED CLUSTER COVERAGE');
  L.push(`  ${SEP2}`, '');
  const ar = r.approvedVsRejected;
  L.push(`  Approved (BUY_APPROVED_PAPER) total : ${ar.approvedTotal}`);
  L.push(`  Approved UNKNOWN cluster            : ${ar.approvedUnknown}  (${pct(ar.approvedUnknownPct)})`);
  L.push(`  Rejected (BUY_REJECTED) total       : ${ar.rejectedTotal}`);
  L.push(`  Rejected UNKNOWN cluster            : ${ar.rejectedUnknown}  (${pct(ar.rejectedUnknownPct)})`);
  L.push(`  Approved M5 rows with UNKNOWN       : ${ar.approvedM5WithUnknown}`);
  L.push(`  Rejected M5 rows with UNKNOWN       : ${ar.rejectedM5WithUnknown}`);
  L.push(`  Approved sufficiently holder-covered: ${ar.approvedSufficientlyCovered ? 'yes' : 'NO'}`);
  L.push('');
  L.push(`  ${ar.note}`);
  L.push('');

  // §9 — Contract samples needing cluster resolution
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 9 — CONTRACT SAMPLES NEEDING CLUSTER RESOLUTION (up to ${SAMPLE_CAP})`);
  L.push(`  ${SEP2}`, '');
  if (r.samplesNeedingResolution.length === 0) {
    L.push('  (no M5 + UNKNOWN approved/observed samples found)');
  } else {
    L.push(`  ${'symbol'.padEnd(12)} ${'contract'.padEnd(18)} ${'m5'.padStart(8)} ${'band'.padEnd(16)} ${'liq'.padEnd(14)} ${'vlr'.padEnd(12)} ${'decision'.padEnd(18)} ${'pnl'.padStart(8)}`);
    for (const s of r.samplesNeedingResolution) {
      L.push(
        `  ${(s.symbol ?? 'unknown').slice(0, 11).padEnd(12)} ` +
        `${s.contractPrefix.padEnd(18)} ` +
        `${(fmt1(s.m5) + '%').padStart(8)} ` +
        `${s.m5Band.padEnd(16)} ` +
        `${s.liquidityBucket.padEnd(14)} ` +
        `${s.vlrBucket.padEnd(12)} ` +
        `${s.paperDecision.slice(0, 17).padEnd(18)} ` +
        `${(s.pnl != null ? fmt1(s.pnl) + '%' : 'n/a').padStart(8)}`,
      );
    }
    L.push('');
    L.push('  unknownReason (all rows): NOT_RECORDED at memory layer — reason lives only on cycle rows.');
  }
  L.push('');

  // §10 — Diagnosis
  L.push(`  ${SEP2}`);
  L.push('  SECTION 10 — DIAGNOSIS');
  L.push(`  ${SEP2}`, '');
  for (const d of r.diagnoses) {
    const ok = d === 'CLUSTER_COVERAGE_HEALTHY';
    L.push(`  ${ok ? '✓' : '⚠'} ${d}`);
  }
  L.push('');

  // §11 — Recommended next actions
  L.push(`  ${SEP2}`);
  L.push('  SECTION 11 — RECOMMENDED NEXT ACTIONS (REPORT ONLY)');
  L.push(`  ${SEP2}`, '');
  for (const rec of r.recommendations) {
    L.push(`  • ${rec}`);
  }
  L.push('');

  // §12 — Safety footer
  L.push(`  ${SEP2}`);
  L.push('  SECTION 12 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true    READ_ONLY=true    PAPER_ONLY=true    NO_MUTATION=true');
  L.push('  NO_REAL_TRADING=true   NO_GATE_CHANGES=true   NO_POLICY_CHANGE=true');
  L.push('  NO_WALLET=true         NO_SWAP=true           NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING    tradingExecuted=0    realTradingLocked=true');
  L.push('  No data files mutated.  No gates changed.  No policy changed.  UNKNOWN never treated as CLEAN.');
  L.push(SEP, '');

  return L.join('\n');
}

function renderNeutralTrades(L: string[], label: string, trades: NeutralTradeRow[]): void {
  L.push(label);
  if (trades.length === 0) {
    L.push('    (none)');
    L.push('');
    return;
  }
  L.push(`    ${'symbol'.padEnd(12)} ${'contract'.padEnd(22)} ${'pnl'.padStart(8)} ${'m5'.padStart(8)} ${'cluster'.padEnd(8)} ${'liq'.padEnd(14)} vlr`);
  for (const t of trades) {
    L.push(
      `    ${(t.symbol ?? 'unknown').slice(0, 11).padEnd(12)} ` +
      `${t.contractPrefix.padEnd(22)} ` +
      `${(fmt1(t.pnl) + '%').padStart(8)} ` +
      `${(fmt1(t.m5) + '%').padStart(8)} ` +
      `${t.clusterRisk.padEnd(8)} ` +
      `${t.liquidityBucket.padEnd(14)} ` +
      `${t.vlrBucket}`,
    );
  }
  L.push('');
}
