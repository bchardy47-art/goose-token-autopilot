// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_PROMOTE_TO_REAL_TRADING
//
// Forward-only Watch Cohort tracking v1 — enrolls SUBGROUP_WATCH_PAPER_ONLY hits from the
// latest cycle into an APPEND-ONLY cohort file, then reports whether those forward-enrolled
// hits outperform normal approved paper candidates once outcomes arrive.
//
// Enrollment is forward-only: it scans the latest cycle file and appends matching rows. It
// never modifies existing cohort rows, never backfills, never implies buy approval, never
// enables real trading, and never converts UNKNOWN cluster risk into CLEAN. Watch membership
// is decided from entry-time fields ONLY (entryTiming / m5 band / liquidity bucket) — never
// from outcome / P&L fields.

import * as fs   from 'fs';
import * as path from 'path';

import { bucketLiquidity, bucketVlr } from './ripperLearningMemory';
import { applyPaperDecisionPolicy } from './ripperPaperDecisionPolicy';
import {
  classifySubgroupWatch,
  m5BandLabel,
  TARGET_ENTRY_TIMING,
  TARGET_M5_BAND,
  TARGET_LIQUIDITY_BUCKET,
  WATCH_LABEL,
  WATCH_REASON,
  WATCH_SAFETY_LABEL,
  type SubgroupWatchRow,
} from './ripperSubgroupWatch';
import {
  runPaperTradeSimulationReport,
  type SimulatedTrade,
  type PaperTradeSimulationOptions,
} from './ripperPaperTradeSimulationReport';

// ── Constants ─────────────────────────────────────────────────────────────────────

export const COHORT_SCHEMA_VERSION = 1;
export const COHORT_NAME           = 'ENTER_NOW_M5_NEG_20_TO_5_LIQ_10K_30K';
export const DEFAULT_COHORT_PATH   = 'data/token-grab/ripper/watch-cohort.jsonl';
export const DEFAULT_CYCLES_DIR    = 'data/token-grab/ripper/cycles';
export const DEFAULT_INTENTS_PATH  = 'data/token-grab/ripper/paper-intents.jsonl';
export const DEFAULT_MIN_FORWARD_N = 50;
export const PNL_CAP_PCT           = 500;
export const OUTPERFORM_WINRATE_LIFT_PP = 10;
export const OUTPERFORM_OUTLIER_MAX     = 0.25;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Cohort row ──────────────────────────────────────────────────────────────────────

export interface WatchCohortRow {
  schemaVersion:    number;
  cohortName:       string;
  label:            string;             // SUBGROUP_WATCH_PAPER_ONLY
  enrolledAt:       string;
  cycleId:          string;
  cycleFile:        string;
  capturedAt:       string | null;
  dedupeKey:        string;
  contract:         string;
  symbol:           string | null;
  buyGateDecision:  string | null;
  paperEntryTiming: string | null;      // entryTiming
  entryMomentumPct: number | null;
  m5Band:           string;
  liquidityBucket:  string;
  vlrBucket:        string;
  clusterRisk:      string | null;      // UNKNOWN stays UNKNOWN
  ripperScore:      number | null;
  reason:           string;             // WATCH_REASON
  safety:           string;             // PAPER_ONLY_WATCH_NOT_BUY
  DO_NOT_ENABLE_REAL_TRADING:                 true;
  DO_NOT_PROMOTE_TO_REAL_TRADING:             true;
  DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE: true;
}

// ── Raw cycle row (minimal shape we read) ───────────────────────────────────────────

interface CycleRow {
  capturedAt?:      string;
  buyGateDecision?: string;
  entryDecision?:   string | null;
  entryMomentumPct?: number | null;
  ripperScore?:     number | null;
  launchAgeBucket?: string | null;
  normalizedSignal?: {
    contract?:             string;
    symbol?:               string;
    liquidityUsd?:         number | null;
    volumeLiquidityRatio?: number | null;
    observedAt?:           string;
  } & Record<string, unknown>;
  ripperInput?: { contract?: string; clusterRisk?: string | null } & Record<string, unknown>;
  raw?:         { contract?: string; clusterRisk?: string | null } & Record<string, unknown>;
}

// ── File helpers ─────────────────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

export function findLatestCycleFile(cyclesDir: string): string | null {
  if (!fs.existsSync(cyclesDir)) return null;
  const files = fs.readdirSync(cyclesDir)
    .filter(f => /^cycle-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(f))
    .sort();
  return files.at(-1) ?? null;
}

function cycleIdFromFile(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, '');
}

// ── Enrollment ────────────────────────────────────────────────────────────────────

export interface CohortCandidate {
  cohortRow: WatchCohortRow;
  matched:   boolean;
}

/**
 * Build a watch row + prospective cohort row from a raw cycle row.
 * Derives paperEntryTiming via the SAME paper decision policy used by the live flow, and
 * derives m5 band / liquidity / vlr buckets with the SAME bucketers. Approval-only: timing
 * is only meaningful for approved rows, so a non-approved row yields entryTiming=null and
 * will not match the ENTER_NOW classifier.
 */
function cycleRowToCandidate(
  row: CycleRow,
  cycleId: string,
  cycleFile: string,
  enrolledAt: string,
): CohortCandidate | null {
  const contract = row.normalizedSignal?.contract ?? row.ripperInput?.contract ?? row.raw?.contract;
  if (!contract) return null;

  const capturedAt = typeof row.capturedAt === 'string' ? row.capturedAt : null;
  const symbol = row.normalizedSignal?.symbol ?? null;
  const entryMomentumPct =
    typeof row.entryMomentumPct === 'number' && Number.isFinite(row.entryMomentumPct)
      ? row.entryMomentumPct : null;
  const clusterRisk = row.ripperInput?.clusterRisk ?? row.raw?.clusterRisk ?? null; // UNKNOWN stays UNKNOWN
  const ripperScore = typeof row.ripperScore === 'number' ? row.ripperScore : null;
  const buyGateDecision = row.buyGateDecision ?? null;

  const m5Band          = m5BandLabel(entryMomentumPct);
  const liquidityBucket = bucketLiquidity(row.normalizedSignal?.liquidityUsd ?? null);
  const vlrBucket       = bucketVlr(row.normalizedSignal?.volumeLiquidityRatio ?? null);

  // Derive paper entry timing only for approved rows (watch cohort tracks approved paper
  // candidates; enrollment never itself approves anything).
  let paperEntryTiming: string | null = null;
  if (buyGateDecision === 'BUY_APPROVED_PAPER') {
    paperEntryTiming = applyPaperDecisionPolicy({
      contract,
      symbol,
      approvedAt:      capturedAt ?? '',
      clusterRisk:     clusterRisk ?? 'UNKNOWN',
      ripperScore,
      launchAgeBucket: row.launchAgeBucket ?? null,
      entryDecision:   row.entryDecision ?? null,
      entryMomentumPct,
    }).paperEntryTiming;
  }

  const watchRow: SubgroupWatchRow = {
    symbol,
    contract,
    entryTiming:      paperEntryTiming,
    entryDecision:    row.entryDecision ?? null,
    m5Band,
    entryMomentumPct,
    liquidityBucket,
    ripperScore,
    clusterRisk,
  };
  const matched = classifySubgroupWatch(watchRow).matched;

  const dedupeKey = buildDedupeKey(cycleId, contract, capturedAt, cycleFile);

  const cohortRow: WatchCohortRow = {
    schemaVersion:    COHORT_SCHEMA_VERSION,
    cohortName:       COHORT_NAME,
    label:            WATCH_LABEL,
    enrolledAt,
    cycleId,
    cycleFile,
    capturedAt,
    dedupeKey,
    contract,
    symbol,
    buyGateDecision,
    paperEntryTiming,
    entryMomentumPct,
    m5Band,
    liquidityBucket,
    vlrBucket,
    clusterRisk,
    ripperScore,
    reason:           WATCH_REASON,
    safety:           WATCH_SAFETY_LABEL,
    DO_NOT_ENABLE_REAL_TRADING:                 true,
    DO_NOT_PROMOTE_TO_REAL_TRADING:             true,
    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE: true,
  };

  return { cohortRow, matched };
}

/** dedupeKey = cycleId + contract + capturedAt; if capturedAt missing, cycleFile + contract. */
export function buildDedupeKey(
  cycleId: string, contract: string, capturedAt: string | null, cycleFile: string,
): string {
  return capturedAt
    ? `${cycleId}::${contract}::${capturedAt}`
    : `${path.basename(cycleFile)}::${contract}`;
}

export interface WatchCohortEnrollOptions {
  cyclesDir?:  string;
  cycleFile?:  string;   // explicit cycle file (basename or path); overrides latest
  cohortPath?: string;
  dryRun?:     boolean;
  topN?:       number;
  nowMs?:      number;
  enrolledAt?: string;
}

export interface WatchCohortEnrollResult {
  generatedAt:       string;
  cohortPath:        string;
  cycleFile:         string | null;
  cycleId:           string | null;
  rowsScanned:       number;
  hitsFound:         number;
  rowsAppended:      number;
  duplicatesSkipped: number;
  dryRun:            boolean;
  appendedRows:      WatchCohortRow[];
  topEnrolled:       WatchCohortRow[];
  safetyLabel:       string;

  reportOnly:        boolean; // true except when actually appending (still paper-only)
  paperOnly:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
  noGateChanges:     true;
  noBuySignal:       true;
  unknownNeverClean: true;
}

export function enrollWatchCohort(opts: WatchCohortEnrollOptions = {}): WatchCohortEnrollResult {
  const cyclesDir  = opts.cyclesDir  ?? DEFAULT_CYCLES_DIR;
  const cohortPath = opts.cohortPath ?? DEFAULT_COHORT_PATH;
  const dryRun     = opts.dryRun ?? false;
  const topN       = opts.topN ?? 5;
  const enrolledAt = opts.enrolledAt ?? new Date(opts.nowMs ?? Date.now()).toISOString();

  // Resolve cycle file
  let cycleFileAbs: string | null = null;
  let cycleFileName: string | null = null;
  if (opts.cycleFile) {
    cycleFileName = path.basename(opts.cycleFile);
    cycleFileAbs  = path.isAbsolute(opts.cycleFile) ? opts.cycleFile
      : (fs.existsSync(opts.cycleFile) ? opts.cycleFile : path.join(cyclesDir, cycleFileName));
  } else {
    cycleFileName = findLatestCycleFile(cyclesDir);
    cycleFileAbs  = cycleFileName ? path.join(cyclesDir, cycleFileName) : null;
  }

  const baseResult: WatchCohortEnrollResult = {
    generatedAt:       enrolledAt,
    cohortPath,
    cycleFile:         cycleFileName,
    cycleId:           cycleFileName ? cycleIdFromFile(cycleFileName) : null,
    rowsScanned:       0,
    hitsFound:         0,
    rowsAppended:      0,
    duplicatesSkipped: 0,
    dryRun,
    appendedRows:      [],
    topEnrolled:       [],
    safetyLabel:       WATCH_SAFETY_LABEL,
    reportOnly:        true,
    paperOnly:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
    noGateChanges:     true,
    noBuySignal:       true,
    unknownNeverClean: true,
  };

  if (!cycleFileAbs || !fs.existsSync(cycleFileAbs)) return baseResult;

  const cycleId   = cycleIdFromFile(cycleFileName!);
  const rows      = readJsonl<CycleRow>(cycleFileAbs);

  // Existing dedupe keys — existing rows are NEVER modified or re-read for mutation.
  const existing = new Set(readJsonl<WatchCohortRow>(cohortPath).map(r => r.dedupeKey).filter(Boolean));

  const toAppend: WatchCohortRow[] = [];
  let hitsFound = 0;
  let duplicatesSkipped = 0;
  const seenThisRun = new Set<string>();

  for (const row of rows) {
    const cand = cycleRowToCandidate(row, cycleId, cycleFileName!, enrolledAt);
    if (!cand || !cand.matched) continue;
    hitsFound++;
    const key = cand.cohortRow.dedupeKey;
    if (existing.has(key) || seenThisRun.has(key)) { duplicatesSkipped++; continue; }
    seenThisRun.add(key);
    toAppend.push(cand.cohortRow);
  }

  // Append-only write (skipped on dry run).
  if (!dryRun && toAppend.length > 0) {
    fs.mkdirSync(path.dirname(cohortPath), { recursive: true });
    fs.appendFileSync(cohortPath, toAppend.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  }

  return {
    ...baseResult,
    cycleId,
    rowsScanned:       rows.length,
    hitsFound,
    rowsAppended:      toAppend.length,
    duplicatesSkipped,
    appendedRows:      toAppend,
    topEnrolled:       toAppend.slice(0, topN),
    reportOnly:        dryRun, // a real append is a write; still paper-only & gate-neutral
  };
}

// ── Enrollment renderer ──────────────────────────────────────────────────────────────

function shortC(c: string | null): string {
  if (!c) return '(none)';
  return c.length > 14 ? c.slice(0, 6) + '..' + c.slice(-4) : c;
}

export function renderWatchCohortEnroll(r: WatchCohortEnrollResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — WATCH COHORT ENROLL (FORWARD-ONLY — PAPER ONLY — NOT A BUY SIGNAL)');
  L.push(`  [APPEND-ONLY${r.dryRun ? ' — DRY RUN (NO WRITE)' : ''} — UNKNOWN ≠ CLEAN]`);
  L.push(SEP, '');
  L.push(`  Generated at      : ${r.generatedAt}`);
  L.push(`  Cohort file       : ${r.cohortPath}`);
  L.push(`  Latest cycle      : ${r.cycleFile ?? '(none)'}`);
  L.push(`  Rows scanned      : ${r.rowsScanned}`);
  L.push(`  Watch hits found  : ${r.hitsFound}`);
  L.push(`  Rows appended     : ${r.rowsAppended}${r.dryRun ? ' (would append)' : ''}`);
  L.push(`  Duplicates skipped: ${r.duplicatesSkipped}`);
  L.push('');
  if (r.topEnrolled.length > 0) {
    L.push('  Top enrolled candidates:');
    for (const c of r.topEnrolled) {
      L.push(`    ${(c.symbol ?? '-').slice(0, 12).padEnd(12)} ${shortC(c.contract).padEnd(14)} ` +
        `m5=${c.entryMomentumPct != null ? c.entryMomentumPct.toFixed(1) + '%' : 'n/a'}  band=${c.m5Band}  ` +
        `liq=${c.liquidityBucket}  vlr=${c.vlrBucket}  score=${c.ripperScore ?? 'n/a'}  cluster=${c.clusterRisk ?? 'n/a'}`);
    }
  } else {
    L.push('  (no new enrollments)');
  }
  L.push('');
  L.push(`  ${WATCH_SAFETY_LABEL}`);
  L.push('  Enrollment is NOT buy approval. No gates changed. No trades written.');
  L.push('  DO_NOT_ENABLE_REAL_TRADING  DO_NOT_PROMOTE_TO_REAL_TRADING');
  L.push('  DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push(SEP, '');
  return L.join('\n');
}

// ── Report ────────────────────────────────────────────────────────────────────────

export type CohortOutcomeStatus = 'OBSERVED' | 'PENDING' | 'OUTCOME_UNMATCHED';

export interface CohortRowOutcome {
  contract:         string;
  symbol:           string | null;
  status:           CohortOutcomeStatus;
  simulatedPnlPct:  number | null;
  m5Band:           string;
  liquidityBucket:  string;
  vlrBucket:        string;
  clusterRisk:      string | null;
  ripperScore:      number | null;
}

export interface CohortGroupStats {
  label:              string;
  n:                  number;
  winRate:            number;
  lossRate:           number;
  flatRate:           number;
  avgPnlRaw:          number;
  avgPnlCapped:       number;
  medianPnl:          number;
  worstPnl:           number;
  bestPnl:            number;
  outlierDependence:  number;
  clusterBreakdown:   Record<string, number>;
  m5BandBreakdown:    Record<string, number>;
  liquidityBreakdown: Record<string, number>;
  vlrBreakdown:       Record<string, number>;
}

export type ForwardWatchRecommendation =
  | 'FORWARD_SAMPLE_TOO_SMALL'
  | 'FORWARD_WATCH_OUTPERFORMING_PAPER_ONLY'
  | 'FORWARD_WATCH_NOT_OUTPERFORMING'
  | 'KEEP_COLLECTING_FORWARD_WATCH';

export interface WatchCohortReportResult {
  generatedAt:       string;
  cohortPath:        string;

  enrolledCount:     number;
  observedCount:     number;
  pendingCount:      number;
  unmatchedCount:    number;

  watchCohortObserved:          CohortGroupStats;
  nonWatchApprovedSameWindow:   CohortGroupStats;
  overallApprovedSameWindow:    CohortGroupStats;

  comparison: {
    winRateLiftPp:             number;
    medianLift:                number;
    cappedAvgLift:             number;
    watchWorstPnl:             number;
    nonWatchWorstPnl:          number;
    watchOutlierDependence:    number;
    nonWatchOutlierDependence: number;
  };
  pendingRows:   CohortRowOutcome[];
  unmatchedRows: CohortRowOutcome[];

  recommendation:       ForwardWatchRecommendation;
  recommendationReason: string;
  windowStart:          string | null;
  config: { minForwardN: number; pnlCapPct: number };
  safetyLabel:          string;

  reportOnly:            true;
  readOnly:              true;
  paperOnly:             true;
  realTradingLocked:     true;
  tradingExecuted:       0;
  noGateChanges:         true;
  noBuySignal:           true;
  noPaperIntentMutation: true;
  unknownNeverClean:     true;
}

export interface WatchCohortReportOptions extends PaperTradeSimulationOptions {
  cohortPath?:  string;
  minForwardN?: number;
  generatedAt?: string;
  /** Test-only injection. */
  _cohortRows?: WatchCohortRow[];
  _trades?:     SimulatedTrade[];
}

// stat helpers
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}
function avg(arr: number[]): number { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function cap(p: number): number { return p > PNL_CAP_PCT ? PNL_CAP_PCT : p; }
function outlierDependence(capped: number[]): number {
  const pos = capped.filter(p => p > 0);
  const sum = pos.reduce((s, v) => s + v, 0);
  if (sum <= 0) return 0;
  return Math.max(...pos) / sum;
}
function tally(values: Array<string | null | undefined>, fallback = 'UNKNOWN'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const k = (v != null && String(v).trim() !== '') ? String(v) : fallback; // null → UNKNOWN, never CLEAN
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

interface OutcomeRow {
  simulatedPnlPct: number;
  m5Band:          string;
  liquidityBucket: string | null;
  vlrBucket:       string | null;
  clusterRisk:     string | null;
  ripperScore:     number | null;
}

function statsFromOutcomes(label: string, rows: OutcomeRow[]): CohortGroupStats {
  const n = rows.length;
  const pnls   = rows.map(r => r.simulatedPnlPct);
  const capped = pnls.map(cap);
  const winners = rows.filter(r => r.simulatedPnlPct > 0).length;
  const flats   = rows.filter(r => r.simulatedPnlPct === 0).length;
  const losers  = rows.filter(r => r.simulatedPnlPct < 0).length;
  return {
    label,
    n,
    winRate:  n ? winners / n : 0,
    lossRate: n ? losers  / n : 0,
    flatRate: n ? flats   / n : 0,
    avgPnlRaw:    avg(pnls),
    avgPnlCapped: avg(capped),
    medianPnl:    median(pnls),
    worstPnl:     pnls.length ? Math.min(...pnls) : 0,
    bestPnl:      pnls.length ? Math.max(...pnls) : 0,
    outlierDependence: outlierDependence(capped),
    clusterBreakdown:   tally(rows.map(r => r.clusterRisk)),
    m5BandBreakdown:    tally(rows.map(r => r.m5Band), 'UNAVAILABLE'),
    liquidityBreakdown: tally(rows.map(r => r.liquidityBucket)),
    vlrBreakdown:       tally(rows.map(r => r.vlrBucket)),
  };
}

export function runWatchCohortReport(opts: WatchCohortReportOptions = {}): WatchCohortReportResult {
  const cohortPath  = opts.cohortPath  ?? DEFAULT_COHORT_PATH;
  const minForwardN = opts.minForwardN ?? DEFAULT_MIN_FORWARD_N;
  const generatedAt = opts.generatedAt ?? new Date(opts.nowMs ?? Date.now()).toISOString();

  const cohortRows = opts._cohortRows ?? readJsonl<WatchCohortRow>(cohortPath);

  // Observed paper outcomes (read-only). Same pipeline as the other reports.
  const trades: SimulatedTrade[] = opts._trades ?? runPaperTradeSimulationReport({
    intentsPath: opts.intentsPath,
    memoryPath:  opts.memoryPath,
    cyclesDir:   opts.cyclesDir,
    nowMs:       opts.nowMs,
  }).simulatedTrades;

  // Index observed trades by contract (these are the only outcomes available).
  const tradesByContract = new Map<string, SimulatedTrade[]>();
  for (const t of trades) {
    const list = tradesByContract.get(t.contract) ?? [];
    list.push(t);
    tradesByContract.set(t.contract, list);
  }

  const watchContracts = new Set(cohortRows.map(r => r.contract));

  // ── Match each cohort row to an outcome (entry-time fields never used here) ──────────
  const observedOutcomes: OutcomeRow[] = [];
  const cohortOutcomeRows: CohortRowOutcome[] = [];
  let observedCount = 0, pendingCount = 0, unmatchedCount = 0;

  for (const row of cohortRows) {
    const candidates = tradesByContract.get(row.contract) ?? [];
    let status: CohortOutcomeStatus;
    let matchTrade: SimulatedTrade | null = null;

    if (candidates.length === 0) {
      status = 'PENDING';
    } else if (candidates.length === 1) {
      status = 'OBSERVED';
      matchTrade = candidates[0]!;
    } else {
      // Ambiguous — try a SAFE proximity match by capturedAt vs targetEntryAt/observedAt.
      const capMs = row.capturedAt ? Date.parse(row.capturedAt) : NaN;
      if (Number.isNaN(capMs)) {
        status = 'OUTCOME_UNMATCHED';
      } else {
        const scored = candidates.map(t => {
          const ts = Date.parse(t.targetEntryAt || t.observedAt || '');
          return { t, dist: Number.isNaN(ts) ? Infinity : Math.abs(ts - capMs) };
        }).sort((a, b) => a.dist - b.dist);
        const best = scored[0]!, second = scored[1]!;
        // Require a strict, finite, unique nearest — otherwise refuse to guess.
        if (Number.isFinite(best.dist) && best.dist < second.dist) {
          status = 'OBSERVED';
          matchTrade = best.t;
        } else {
          status = 'OUTCOME_UNMATCHED';
        }
      }
    }

    const outcomeRow: CohortRowOutcome = {
      contract:        row.contract,
      symbol:          row.symbol,
      status,
      simulatedPnlPct: matchTrade ? matchTrade.simulatedPnlPct : null,
      m5Band:          row.m5Band,
      liquidityBucket: row.liquidityBucket,
      vlrBucket:       row.vlrBucket,
      clusterRisk:     row.clusterRisk,           // UNKNOWN stays UNKNOWN
      ripperScore:     row.ripperScore,
    };
    cohortOutcomeRows.push(outcomeRow);

    if (status === 'OBSERVED' && matchTrade) {
      observedCount++;
      observedOutcomes.push({
        simulatedPnlPct: matchTrade.simulatedPnlPct,
        m5Band:          row.m5Band,
        liquidityBucket: row.liquidityBucket,
        vlrBucket:       row.vlrBucket,
        clusterRisk:     row.clusterRisk,
        ripperScore:     row.ripperScore,
      });
    } else if (status === 'PENDING') {
      pendingCount++;
    } else {
      unmatchedCount++;
    }
  }

  // ── Same-window comparison groups ────────────────────────────────────────────────
  // Forward window starts at the earliest cohort capturedAt (fallback enrolledAt).
  let windowStart: string | null = null;
  for (const r of cohortRows) {
    const ts = r.capturedAt ?? r.enrolledAt;
    if (ts && (windowStart == null || ts < windowStart)) windowStart = ts;
  }
  const windowStartMs = windowStart ? Date.parse(windowStart) : NaN;

  const inWindow = (t: SimulatedTrade): boolean => {
    if (Number.isNaN(windowStartMs)) return true; // no window → all observed trades
    const ts = Date.parse(t.targetEntryAt || t.observedAt || '');
    return Number.isNaN(ts) ? false : ts >= windowStartMs;
  };

  const windowTrades = trades.filter(inWindow);
  const nonWatchRows: OutcomeRow[] = windowTrades
    .filter(t => !watchContracts.has(t.contract))
    .map(t => ({
      simulatedPnlPct: t.simulatedPnlPct, m5Band: t.m5Band, liquidityBucket: t.liquidityBucket,
      vlrBucket: t.vlrBucket, clusterRisk: t.clusterRisk, ripperScore: t.ripperScore,
    }));
  const overallRows: OutcomeRow[] = windowTrades.map(t => ({
    simulatedPnlPct: t.simulatedPnlPct, m5Band: t.m5Band, liquidityBucket: t.liquidityBucket,
    vlrBucket: t.vlrBucket, clusterRisk: t.clusterRisk, ripperScore: t.ripperScore,
  }));

  const watchCohortObserved        = statsFromOutcomes('WATCH_COHORT_OBSERVED', observedOutcomes);
  const nonWatchApprovedSameWindow = statsFromOutcomes('NON_WATCH_APPROVED_SAME_WINDOW', nonWatchRows);
  const overallApprovedSameWindow  = statsFromOutcomes('OVERALL_APPROVED_SAME_WINDOW', overallRows);

  const comparison = {
    winRateLiftPp:             (watchCohortObserved.winRate - nonWatchApprovedSameWindow.winRate) * 100,
    medianLift:                watchCohortObserved.medianPnl - nonWatchApprovedSameWindow.medianPnl,
    cappedAvgLift:             watchCohortObserved.avgPnlCapped - nonWatchApprovedSameWindow.avgPnlCapped,
    watchWorstPnl:             watchCohortObserved.worstPnl,
    nonWatchWorstPnl:          nonWatchApprovedSameWindow.worstPnl,
    watchOutlierDependence:    watchCohortObserved.outlierDependence,
    nonWatchOutlierDependence: nonWatchApprovedSameWindow.outlierDependence,
  };

  // ── Recommendation (always paper-only) ───────────────────────────────────────────
  let recommendation: ForwardWatchRecommendation;
  let recommendationReason: string;
  if (watchCohortObserved.n < minForwardN) {
    recommendation = 'FORWARD_SAMPLE_TOO_SMALL';
    recommendationReason =
      `Observed forward watch cohort n=${watchCohortObserved.n} < ${minForwardN}. ` +
      `Not enough forward outcomes yet — keep collecting.`;
  } else if (
    comparison.winRateLiftPp >= OUTPERFORM_WINRATE_LIFT_PP &&
    watchCohortObserved.medianPnl    > nonWatchApprovedSameWindow.medianPnl &&
    watchCohortObserved.avgPnlCapped > nonWatchApprovedSameWindow.avgPnlCapped &&
    watchCohortObserved.outlierDependence <= OUTPERFORM_OUTLIER_MAX
  ) {
    recommendation = 'FORWARD_WATCH_OUTPERFORMING_PAPER_ONLY';
    recommendationReason =
      `Forward watch cohort beats same-window non-watch by ${comparison.winRateLiftPp.toFixed(1)}pp win rate, ` +
      `higher median (+${comparison.medianLift.toFixed(2)}%) and capped avg (+${comparison.cappedAvgLift.toFixed(2)}%), ` +
      `low outlier dependence (${watchCohortObserved.outlierDependence.toFixed(2)}). PAPER-ONLY — ` +
      `DO_NOT_PROMOTE_TO_REAL_TRADING, DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE.`;
  } else if (
    watchCohortObserved.winRate   < nonWatchApprovedSameWindow.winRate ||
    watchCohortObserved.medianPnl < nonWatchApprovedSameWindow.medianPnl
  ) {
    recommendation = 'FORWARD_WATCH_NOT_OUTPERFORMING';
    recommendationReason =
      `Forward watch cohort does not beat same-window non-watch ` +
      `(win ${(watchCohortObserved.winRate * 100).toFixed(1)}% vs ${(nonWatchApprovedSameWindow.winRate * 100).toFixed(1)}%, ` +
      `median ${watchCohortObserved.medianPnl.toFixed(2)}% vs ${nonWatchApprovedSameWindow.medianPnl.toFixed(2)}%).`;
  } else {
    recommendation = 'KEEP_COLLECTING_FORWARD_WATCH';
    recommendationReason =
      `Forward watch cohort is ahead on some measures but not clearly outperforming ` +
      `(win-rate lift ${comparison.winRateLiftPp.toFixed(1)}pp, outlier dependence ${watchCohortObserved.outlierDependence.toFixed(2)}). Keep collecting.`;
  }

  return {
    generatedAt,
    cohortPath,
    enrolledCount:  cohortRows.length,
    observedCount,
    pendingCount,
    unmatchedCount,
    watchCohortObserved,
    nonWatchApprovedSameWindow,
    overallApprovedSameWindow,
    comparison,
    pendingRows:   cohortOutcomeRows.filter(r => r.status === 'PENDING'),
    unmatchedRows: cohortOutcomeRows.filter(r => r.status === 'OUTCOME_UNMATCHED'),
    recommendation,
    recommendationReason,
    windowStart,
    config: { minForwardN, pnlCapPct: PNL_CAP_PCT },
    safetyLabel: WATCH_SAFETY_LABEL,

    reportOnly:            true,
    readOnly:              true,
    paperOnly:             true,
    realTradingLocked:     true,
    tradingExecuted:       0,
    noGateChanges:         true,
    noBuySignal:           true,
    noPaperIntentMutation: true,
    unknownNeverClean:     true,
  };
}

// ── Report renderer ──────────────────────────────────────────────────────────────────

function pctS(v: number): string { return (v * 100).toFixed(1) + '%'; }
function pnlS(v: number): string { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function ppS(v: number):  string { return (v >= 0 ? '+' : '') + v.toFixed(1) + 'pp'; }
function bdS(b: Record<string, number>): string {
  const e = Object.entries(b).sort((a, b2) => b2[1] - a[1]);
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join('  ') : '(none)';
}

function renderGroup(L: string[], g: CohortGroupStats): void {
  L.push(`  ${g.label}  (n=${g.n})`);
  L.push(`    win=${pctS(g.winRate)}  loss=${pctS(g.lossRate)}  flat=${pctS(g.flatRate)}`);
  L.push(`    avgRaw=${pnlS(g.avgPnlRaw)}  avgCap=${pnlS(g.avgPnlCapped)}  med=${pnlS(g.medianPnl)}  ` +
    `worst=${pnlS(g.worstPnl)}  best=${pnlS(g.bestPnl)}  outlierDep=${g.outlierDependence.toFixed(2)}`);
  L.push(`    cluster  : ${bdS(g.clusterBreakdown)}`);
  L.push(`    m5 band  : ${bdS(g.m5BandBreakdown)}`);
  L.push(`    liquidity: ${bdS(g.liquidityBreakdown)}`);
  L.push(`    vlr      : ${bdS(g.vlrBreakdown)}`);
  L.push('');
}

export function renderWatchCohortReport(r: WatchCohortReportResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — FORWARD WATCH COHORT REPORT (PAPER ONLY — NOT A BUY SIGNAL)');
  L.push('  [REPORT ONLY — READ ONLY — PAPER ONLY — UNKNOWN ≠ CLEAN]');
  L.push(SEP, '');

  // §1 Overview
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Generated at : ${r.generatedAt}`);
  L.push(`  Cohort file  : ${r.cohortPath}`);
  L.push(`  Window start : ${r.windowStart ?? '(none)'}`);
  L.push(`  Cohort       : ${COHORT_NAME}`);
  L.push('  Cohort membership uses ENTRY-TIME fields only (never outcome/P&L).');
  L.push('');

  // §2 Enrollment summary
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — FORWARD COHORT ENROLLMENT SUMMARY');
  L.push(`  ${SEP2}`, '');
  L.push(`  Enrolled rows : ${r.enrolledCount}`);
  L.push('');

  // §3 Outcome availability
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — OUTCOME AVAILABILITY');
  L.push(`  ${SEP2}`, '');
  L.push(`  Observed  : ${r.observedCount}`);
  L.push(`  Pending   : ${r.pendingCount}`);
  L.push(`  Unmatched : ${r.unmatchedCount}  (ambiguous — not guessed)`);
  L.push('');

  // §4 Watch cohort performance
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — WATCH COHORT PERFORMANCE (OBSERVED)');
  L.push(`  ${SEP2}`, '');
  renderGroup(L, r.watchCohortObserved);

  // §5 Non-watch comparison
  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — NON-WATCH APPROVED COMPARISON (SAME FORWARD WINDOW)');
  L.push(`  ${SEP2}`, '');
  renderGroup(L, r.nonWatchApprovedSameWindow);
  renderGroup(L, r.overallApprovedSameWindow);
  const c = r.comparison;
  L.push(`  Win-rate lift   : ${ppS(c.winRateLiftPp)}  (watch ${pctS(r.watchCohortObserved.winRate)} vs non-watch ${pctS(r.nonWatchApprovedSameWindow.winRate)})`);
  L.push(`  Median lift     : ${pnlS(c.medianLift)}`);
  L.push(`  Capped-avg lift : ${pnlS(c.cappedAvgLift)}`);
  L.push(`  Worst-loss      : watch ${pnlS(c.watchWorstPnl)} vs non-watch ${pnlS(c.nonWatchWorstPnl)}`);
  L.push(`  Outlier-dep     : watch ${c.watchOutlierDependence.toFixed(2)} vs non-watch ${c.nonWatchOutlierDependence.toFixed(2)}`);
  L.push('');

  // §6 Pending / unmatched
  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — PENDING / UNMATCHED ROWS');
  L.push(`  ${SEP2}`, '');
  L.push(`  Pending   : ${r.pendingRows.length}`);
  L.push(`  Unmatched : ${r.unmatchedRows.length}`);
  for (const u of r.unmatchedRows.slice(0, 5)) {
    L.push(`    UNMATCHED ${shortC(u.contract)}  cluster=${u.clusterRisk ?? 'n/a'}  (ambiguous — not guessed)`);
  }
  L.push('');

  // §7 Recommendation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — RECOMMENDATION');
  L.push(`  ${SEP2}`, '');
  L.push(`  [${r.recommendation}]`);
  L.push(`  ${r.recommendationReason}`);
  L.push('');

  // §8 Safety
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  PAPER_ONLY_WATCH_NOT_BUY');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push('  DO_NOT_PROMOTE_TO_REAL_TRADING');
  L.push('  DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push('  A cohort hit is NOT a buy signal. No gates changed. No intents/trades mutated.');
  L.push('  UNKNOWN_CLUSTER_RISK_IS_NEVER_TREATED_AS_CLEAN=true');
  L.push(`  reportOnly=true  readOnly=true  paperOnly=true  realTradingLocked=true  tradingExecuted=0`);
  L.push(SEP, '');
  return L.join('\n');
}
