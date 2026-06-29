// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_PROMOTE_TO_REAL_TRADING
//
// Forward Cohort Family Tracker (paper-only) v1 — tracks SEVERAL forward-only paper cohorts
// ("lanes") in parallel so we can learn faster than the single exact cohort, WITHOUT blending
// them and WITHOUT turning any of them into a buy signal.
//
// Each lane:
//   - is decided from ENTRY-TIME fields ONLY (entryTiming / m5 band / liquidity bucket),
//   - writes to its OWN append-only jsonl file (independent dedupe per lane),
//   - enrolls forward-only from the latest raw cycle file,
//   - never enables real trading, never changes gates, never implies buy approval,
//   - never converts UNKNOWN cluster risk into CLEAN.
//
// Outcome / P&L fields are used ONLY in the report (to score lanes after the fact) — NEVER to
// decide cohort membership.

import * as fs   from 'fs';
import * as path from 'path';

import { bucketLiquidity, bucketVlr } from './ripperLearningMemory';
import { applyPaperDecisionPolicy } from './ripperPaperDecisionPolicy';
import { m5BandLabel, WATCH_LABEL, WATCH_SAFETY_LABEL } from './ripperSubgroupWatch';
import { findLatestRawCycleFile } from './ripperWatchRawCycle';
import {
  runPaperTradeSimulationReport,
  type SimulatedTrade,
  type PaperTradeSimulationOptions,
} from './ripperPaperTradeSimulationReport';

// ── Constants ─────────────────────────────────────────────────────────────────────

export const FAMILY_SCHEMA_VERSION = 1;
export const DEFAULT_DATA_DIR      = 'data/token-grab/ripper';
export const DEFAULT_CYCLES_DIR    = 'data/token-grab/ripper/cycles';
export const FAMILY_MIN_FORWARD_N  = 50;
export const PNL_CAP_PCT           = 500;
export const OUTLIER_MAX           = 0.25;

const LIQ_NEAR  = new Set(['LIQ_10K_30K', 'LIQ_30K_100K']);
const M5_FAMILY = new Set(['-20 to -5', '-5 to +5']);

// ── NO_BM_RESEARCH shadow lane ──────────────────────────────────────────────────────
// A SEPARATE paper-only research lane that keeps learning when BubbleMaps is rate-limited.
// It enrolls on INTERNAL observable signals only (timing/m5/liquidity/vlr/age/ripperScore)
// and ignores BubbleMaps cluster risk FOR ENROLLMENT ONLY. It NEVER touches the strict-BM
// approval lanes above, NEVER loosens gates, and NEVER treats UNKNOWN as CLEAN — clusterRisk
// is recorded verbatim and is never used as a membership signal.
export const NO_BM_RESEARCH_LANE_KEY  = 'NO_BM_RESEARCH';
export const NO_BM_RESEARCH_COHORT    = 'NO_BM_INTERNAL_RISK_RESEARCH';
export const NO_BM_RESEARCH_FILENAME  = 'watch-cohort-no-bm-research.jsonl';
export const NO_BM_RESEARCH_MIN_SCORE = 60;   // internal model-score floor for the research lane
export const NO_BM_RESEARCH_DESCRIBE  =
  'BM-IGNORED research: m5Band in {-20 to -5, -5 to +5}, liquidity in {LIQ_10K_30K, LIQ_30K_100K}, ' +
  `ripperScore >= ${NO_BM_RESEARCH_MIN_SCORE} (cluster ignored for enrollment only; UNKNOWN never CLEAN)`;
export const NO_BM_RESEARCH_REASON =
  'Matches NO_BM_RESEARCH shadow lane — internal-signal only, BubbleMaps ignored for enrollment (paper-only research)';

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Lane definitions ────────────────────────────────────────────────────────────────

export type LaneKey = 'EXACT_WATCH' | 'LIQUIDITY_NEAR' | 'MOMENTUM_FAMILY' | 'WAIT10_QUALITY';

/** Entry-time-only candidate derived once per raw cycle row. */
export interface FamilyCandidate {
  contract:         string;
  symbol:           string | null;
  capturedAt:       string | null;
  buyGateDecision:  string | null;
  paperEntryTiming: string | null;  // ENTER_NOW / WAIT_10M / null (non-approved rows)
  entryMomentumPct: number | null;
  m5Band:           string;
  liquidityBucket:  string;
  vlrBucket:        string;
  clusterRisk:      string | null;  // UNKNOWN stays UNKNOWN
  ripperScore:      number | null;
}

export interface LaneDef {
  key:        LaneKey;
  cohortName: string;
  fileName:   string;
  describe:   string;
  reason:     string;
  /** Entry-time-only membership test. Never reads outcome/P&L. */
  matches:    (c: FamilyCandidate) => boolean;
}

export const LANES: LaneDef[] = [
  {
    key:        'EXACT_WATCH',
    cohortName: 'ENTER_NOW_M5_NEG_20_TO_5_LIQ_10K_30K',
    fileName:   'watch-cohort-exact.jsonl',
    describe:   'entryTiming=ENTER_NOW, m5Band=-20 to -5, liquidity=LIQ_10K_30K',
    reason:     'Matches EXACT high-conviction paper-only subgroup (entry-time only)',
    matches: c =>
      c.paperEntryTiming === 'ENTER_NOW' &&
      c.m5Band === '-20 to -5' &&
      c.liquidityBucket === 'LIQ_10K_30K',
  },
  {
    key:        'LIQUIDITY_NEAR',
    cohortName: 'ENTER_NOW_M5_NEG_20_TO_5_LIQ_10K_30K_OR_30K_100K',
    fileName:   'watch-cohort-liquidity-near.jsonl',
    describe:   'entryTiming=ENTER_NOW, m5Band=-20 to -5, liquidity in {LIQ_10K_30K, LIQ_30K_100K}',
    reason:     'Matches LIQUIDITY_NEAR paper-only lane (entry-time only)',
    matches: c =>
      c.paperEntryTiming === 'ENTER_NOW' &&
      c.m5Band === '-20 to -5' &&
      LIQ_NEAR.has(c.liquidityBucket),
  },
  {
    key:        'MOMENTUM_FAMILY',
    cohortName: 'ENTER_NOW_M5_NEG_20_TO_5_OR_NEG_5_TO_5_LIQ_NEAR',
    fileName:   'watch-cohort-momentum-family.jsonl',
    describe:   'entryTiming=ENTER_NOW, m5Band in {-20 to -5, -5 to +5}, liquidity in {LIQ_10K_30K, LIQ_30K_100K}',
    reason:     'Matches MOMENTUM_FAMILY paper-only lane (entry-time only)',
    matches: c =>
      c.paperEntryTiming === 'ENTER_NOW' &&
      M5_FAMILY.has(c.m5Band) &&
      LIQ_NEAR.has(c.liquidityBucket),
  },
  {
    key:        'WAIT10_QUALITY',
    cohortName: 'WAIT_10M_LIQ_NEAR_M5_AVAILABLE',
    fileName:   'watch-cohort-wait10-quality.jsonl',
    // Conservative: require m5Band to be available (not UNAVAILABLE). entryTiming WAIT_10M only
    // arises for the high-quality subgroup, which requires CLEAN cluster — so UNKNOWN rows
    // (which are ENTER_NOW) never land here, and UNKNOWN is never treated as CLEAN.
    describe:   'entryTiming=WAIT_10M, liquidity in {LIQ_10K_30K, LIQ_30K_100K}, m5Band != UNAVAILABLE',
    reason:     'Matches WAIT10_QUALITY paper-only lane (entry-time only, conservative)',
    matches: c =>
      c.paperEntryTiming === 'WAIT_10M' &&
      LIQ_NEAR.has(c.liquidityBucket) &&
      c.m5Band !== 'UNAVAILABLE',
  },
];

// ── Cohort row ────────────────────────────────────────────────────────────────────────

export interface FamilyCohortRow {
  schemaVersion:    number;
  lane:             LaneKey;
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
  paperEntryTiming: string | null;
  entryMomentumPct: number | null;
  m5Band:           string;
  liquidityBucket:  string;
  vlrBucket:        string;
  clusterRisk:      string | null;      // UNKNOWN stays UNKNOWN
  ripperScore:      number | null;
  reason:           string;
  safety:           string;             // PAPER_ONLY_WATCH_NOT_BUY
  DO_NOT_ENABLE_REAL_TRADING:                 true;
  DO_NOT_PROMOTE_TO_REAL_TRADING:             true;
  DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE: true;
}

// ── Raw cycle row ─────────────────────────────────────────────────────────────────────

interface CycleRow {
  capturedAt?:       string;
  buyGateDecision?:  string;
  entryDecision?:    string | null;
  entryMomentumPct?: number | null;
  ripperScore?:      number | null;
  launchAgeBucket?:  string | null;
  normalizedSignal?: {
    contract?:             string;
    symbol?:               string;
    liquidityUsd?:         number | null;
    volumeLiquidityRatio?: number | null;
  } & Record<string, unknown>;
  ripperInput?: { contract?: string; clusterRisk?: string | null } & Record<string, unknown>;
  raw?:         { contract?: string; clusterRisk?: string | null } & Record<string, unknown>;
}

// ── File helpers ──────────────────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

function cycleIdFromFile(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, '');
}

export function buildDedupeKey(
  cycleId: string, contract: string, capturedAt: string | null, cycleFile: string,
): string {
  return capturedAt
    ? `${cycleId}::${contract}::${capturedAt}`
    : `${path.basename(cycleFile)}::${contract}`;
}

export function laneFilePath(dataDir: string, lane: LaneKey): string {
  const def = LANES.find(l => l.key === lane)!;
  return path.join(dataDir, def.fileName);
}

// ── Candidate derivation (entry-time fields only) ──────────────────────────────────────

/**
 * Derive entry-time fields from a raw cycle row. Mirrors cycleRowToCandidate in
 * ripperWatchCohort: timing via the live decision policy, m5 / liquidity / vlr via the shared
 * bucketers. paperEntryTiming is only derived for approved rows; non-approved rows yield null
 * timing and match no lane. Never reads outcome / P&L fields.
 */
export function deriveCandidate(row: CycleRow): FamilyCandidate | null {
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

  return {
    contract, symbol, capturedAt, buyGateDecision, paperEntryTiming,
    entryMomentumPct, m5Band, liquidityBucket, vlrBucket, clusterRisk, ripperScore,
  };
}

function candidateToCohortRow(
  c: FamilyCandidate, lane: LaneDef, cycleId: string, cycleFile: string, enrolledAt: string,
): FamilyCohortRow {
  return {
    schemaVersion:    FAMILY_SCHEMA_VERSION,
    lane:             lane.key,
    cohortName:       lane.cohortName,
    label:            WATCH_LABEL,
    enrolledAt,
    cycleId,
    cycleFile,
    capturedAt:       c.capturedAt,
    dedupeKey:        buildDedupeKey(cycleId, c.contract, c.capturedAt, cycleFile),
    contract:         c.contract,
    symbol:           c.symbol,
    buyGateDecision:  c.buyGateDecision,
    paperEntryTiming: c.paperEntryTiming,
    entryMomentumPct: c.entryMomentumPct,
    m5Band:           c.m5Band,
    liquidityBucket:  c.liquidityBucket,
    vlrBucket:        c.vlrBucket,
    clusterRisk:      c.clusterRisk,
    ripperScore:      c.ripperScore,
    reason:           lane.reason,
    safety:           WATCH_SAFETY_LABEL,
    DO_NOT_ENABLE_REAL_TRADING:                 true,
    DO_NOT_PROMOTE_TO_REAL_TRADING:             true,
    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE: true,
  };
}

// ── NO_BM_RESEARCH candidate + row (BubbleMaps ignored for enrollment) ──────────────────

/** Internal-signal-only candidate. clusterRisk is recorded but NEVER used for membership. */
export interface ResearchCandidate {
  contract:         string;
  symbol:           string | null;
  capturedAt:       string | null;
  buyGateDecision:  string | null;   // recorded (APPROVED or REJECTED) — not a membership signal
  entryTiming:      string;          // BM-free: always ENTER_NOW (cluster ignored → never WAIT_10M)
  entryMomentumPct: number | null;
  m5Band:           string;
  liquidityBucket:  string;
  vlrBucket:        string;
  launchAgeBucket:  string | null;
  ripperScore:      number | null;
  clusterRisk:      string | null;   // verbatim — UNKNOWN stays UNKNOWN, never CLEAN
}

export interface ResearchCohortRow {
  schemaVersion:    number;
  lane:             'NO_BM_RESEARCH';
  cohortName:       string;
  label:            string;
  enrolledAt:       string;
  cycleId:          string;
  cycleFile:        string;
  capturedAt:       string | null;
  dedupeKey:        string;
  contract:         string;
  symbol:           string | null;
  buyGateDecision:  string | null;
  entryTiming:      string;
  entryMomentumPct: number | null;
  m5Band:           string;
  liquidityBucket:  string;
  vlrBucket:        string;
  launchAgeBucket:  string | null;
  ripperScore:      number | null;
  clusterRisk:      string | null;   // UNKNOWN stays UNKNOWN
  reason:           string;
  safety:           string;
  // Required research labels.
  bmIgnoredForResearch: true;
  paperOnly:            true;
  notBuySignal:         true;
  unknownNotClean:      true;
  DO_NOT_ENABLE_REAL_TRADING:                 true;
  DO_NOT_PROMOTE_TO_REAL_TRADING:             true;
  DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE: true;
}

export function researchLaneFilePath(dataDir: string): string {
  return path.join(dataDir, NO_BM_RESEARCH_FILENAME);
}

/**
 * Derive a research candidate from a raw cycle row using ONLY internal observable fields.
 * Considers every row (approved OR rejected) — that is the whole point: when BubbleMaps is
 * rate-limited and rows get rejected as UNKNOWN, the research lane can still learn. entryTiming
 * is BM-free (ENTER_NOW) and clusterRisk is recorded verbatim but never used for membership.
 */
export function deriveResearchCandidate(row: CycleRow): ResearchCandidate | null {
  const contract = row.normalizedSignal?.contract ?? row.ripperInput?.contract ?? row.raw?.contract;
  if (!contract) return null;

  const entryMomentumPct =
    typeof row.entryMomentumPct === 'number' && Number.isFinite(row.entryMomentumPct)
      ? row.entryMomentumPct : null;

  return {
    contract,
    symbol:           row.normalizedSignal?.symbol ?? null,
    capturedAt:       typeof row.capturedAt === 'string' ? row.capturedAt : null,
    buyGateDecision:  row.buyGateDecision ?? null,
    entryTiming:      'ENTER_NOW',   // BM ignored → never the CLEAN-only WAIT_10M subgroup
    entryMomentumPct,
    m5Band:           m5BandLabel(entryMomentumPct),
    liquidityBucket:  bucketLiquidity(row.normalizedSignal?.liquidityUsd ?? null),
    vlrBucket:        bucketVlr(row.normalizedSignal?.volumeLiquidityRatio ?? null),
    launchAgeBucket:  row.launchAgeBucket ?? null,
    ripperScore:      typeof row.ripperScore === 'number' ? row.ripperScore : null,
    clusterRisk:      row.ripperInput?.clusterRisk ?? row.raw?.clusterRisk ?? null,
  };
}

/** Entry-time-only membership for the research lane. NEVER reads clusterRisk or outcomes. */
export function researchLaneMatches(c: ResearchCandidate): boolean {
  return (
    M5_FAMILY.has(c.m5Band) &&
    LIQ_NEAR.has(c.liquidityBucket) &&
    typeof c.ripperScore === 'number' && c.ripperScore >= NO_BM_RESEARCH_MIN_SCORE
  );
}

function researchCandidateToRow(
  c: ResearchCandidate, cycleId: string, cycleFile: string, enrolledAt: string,
): ResearchCohortRow {
  return {
    schemaVersion:    FAMILY_SCHEMA_VERSION,
    lane:             'NO_BM_RESEARCH',
    cohortName:       NO_BM_RESEARCH_COHORT,
    label:            WATCH_LABEL,
    enrolledAt,
    cycleId,
    cycleFile,
    capturedAt:       c.capturedAt,
    dedupeKey:        buildDedupeKey(cycleId, c.contract, c.capturedAt, cycleFile),
    contract:         c.contract,
    symbol:           c.symbol,
    buyGateDecision:  c.buyGateDecision,
    entryTiming:      c.entryTiming,
    entryMomentumPct: c.entryMomentumPct,
    m5Band:           c.m5Band,
    liquidityBucket:  c.liquidityBucket,
    vlrBucket:        c.vlrBucket,
    launchAgeBucket:  c.launchAgeBucket,
    ripperScore:      c.ripperScore,
    clusterRisk:      c.clusterRisk,   // verbatim — UNKNOWN stays UNKNOWN
    reason:           NO_BM_RESEARCH_REASON,
    safety:           WATCH_SAFETY_LABEL,
    bmIgnoredForResearch: true,
    paperOnly:            true,
    notBuySignal:         true,
    unknownNotClean:      true,
    DO_NOT_ENABLE_REAL_TRADING:                 true,
    DO_NOT_PROMOTE_TO_REAL_TRADING:             true,
    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE: true,
  };
}

// ── Enrollment ────────────────────────────────────────────────────────────────────────

export interface ResearchLaneEnrollResult {
  lane:              'NO_BM_RESEARCH';
  cohortName:        string;
  cohortPath:        string;
  rowsScanned:       number;
  hitsFound:         number;
  rowsAppended:      number;
  duplicatesSkipped: number;
  appendedRows:      ResearchCohortRow[];
  topEnrolled:       ResearchCohortRow[];
}

export interface LaneEnrollResult {
  lane:              LaneKey;
  cohortName:        string;
  cohortPath:        string;
  rowsScanned:       number;
  hitsFound:         number;
  rowsAppended:      number;
  duplicatesSkipped: number;
  appendedRows:      FamilyCohortRow[];
  topEnrolled:       FamilyCohortRow[];
}

export interface FamilyEnrollResult {
  generatedAt:       string;
  dataDir:           string;
  cyclesDir:         string;
  cycleFile:         string | null;
  cycleId:           string | null;
  rowsScanned:       number;
  dryRun:            boolean;
  lanes:             LaneEnrollResult[];
  researchLane?:     ResearchLaneEnrollResult;  // NO_BM_RESEARCH shadow lane (separate file)
  safetyLabel:       string;

  reportOnly:        boolean;
  paperOnly:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
  noGateChanges:     true;
  noBuySignal:       true;
  unknownNeverClean: true;
}

export interface FamilyEnrollOptions {
  cyclesDir?:  string;
  cycleFile?:  string;   // explicit cycle file (basename or path); overrides latest
  dataDir?:    string;   // dir holding the per-lane cohort files
  dryRun?:     boolean;
  topN?:       number;
  nowMs?:      number;
  enrolledAt?: string;
}

export function enrollCohortFamily(opts: FamilyEnrollOptions = {}): FamilyEnrollResult {
  const cyclesDir  = opts.cyclesDir ?? DEFAULT_CYCLES_DIR;
  const dataDir    = opts.dataDir   ?? DEFAULT_DATA_DIR;
  const dryRun     = opts.dryRun ?? false;
  const topN       = opts.topN ?? 5;
  const enrolledAt = opts.enrolledAt ?? new Date(opts.nowMs ?? Date.now()).toISOString();

  // Resolve cycle file (latest raw cycle unless explicitly given).
  let cycleFileAbs: string | null = null;
  let cycleFileName: string | null = null;
  if (opts.cycleFile) {
    cycleFileName = path.basename(opts.cycleFile);
    cycleFileAbs  = path.isAbsolute(opts.cycleFile) ? opts.cycleFile
      : (fs.existsSync(opts.cycleFile) ? opts.cycleFile : path.join(cyclesDir, cycleFileName));
  } else {
    cycleFileName = findLatestRawCycleFile(cyclesDir);
    cycleFileAbs  = cycleFileName ? path.join(cyclesDir, cycleFileName) : null;
  }

  const emptyLanes = (): LaneEnrollResult[] => LANES.map(l => ({
    lane: l.key, cohortName: l.cohortName, cohortPath: laneFilePath(dataDir, l.key),
    rowsScanned: 0, hitsFound: 0, rowsAppended: 0, duplicatesSkipped: 0,
    appendedRows: [], topEnrolled: [],
  }));

  const base: FamilyEnrollResult = {
    generatedAt:       enrolledAt,
    dataDir,
    cyclesDir,
    cycleFile:         cycleFileName,
    cycleId:           cycleFileName ? cycleIdFromFile(cycleFileName) : null,
    rowsScanned:       0,
    dryRun,
    lanes:             emptyLanes(),
    safetyLabel:       WATCH_SAFETY_LABEL,
    reportOnly:        true,
    paperOnly:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
    noGateChanges:     true,
    noBuySignal:       true,
    unknownNeverClean: true,
  };

  if (!cycleFileAbs || !fs.existsSync(cycleFileAbs)) return base;

  const cycleId = cycleIdFromFile(cycleFileName!);
  const rows    = readJsonl<CycleRow>(cycleFileAbs);
  const candidates = rows.map(deriveCandidate).filter((c): c is FamilyCandidate => c != null);

  const laneResults: LaneEnrollResult[] = LANES.map(lane => {
    const cohortPath = laneFilePath(dataDir, lane.key);
    // Existing dedupe keys for THIS lane only — independent per lane. Existing rows untouched.
    const existing = new Set(readJsonl<FamilyCohortRow>(cohortPath).map(r => r.dedupeKey).filter(Boolean));
    const seenThisRun = new Set<string>();
    const toAppend: FamilyCohortRow[] = [];
    let hitsFound = 0, duplicatesSkipped = 0;

    for (const c of candidates) {
      if (!lane.matches(c)) continue;
      hitsFound++;
      const cohortRow = candidateToCohortRow(c, lane, cycleId, cycleFileName!, enrolledAt);
      const key = cohortRow.dedupeKey;
      if (existing.has(key) || seenThisRun.has(key)) { duplicatesSkipped++; continue; }
      seenThisRun.add(key);
      toAppend.push(cohortRow);
    }

    if (!dryRun && toAppend.length > 0) {
      fs.mkdirSync(path.dirname(cohortPath), { recursive: true });
      fs.appendFileSync(cohortPath, toAppend.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    }

    return {
      lane: lane.key, cohortName: lane.cohortName, cohortPath,
      rowsScanned: rows.length, hitsFound, rowsAppended: toAppend.length,
      duplicatesSkipped, appendedRows: toAppend, topEnrolled: toAppend.slice(0, topN),
    };
  });

  // ── NO_BM_RESEARCH shadow lane — separate file, independent dedupe, additive ──────────
  // Scans ALL rows (approved or rejected) on internal signals only; BubbleMaps ignored for
  // enrollment. Strict lanes above are untouched.
  const researchPath = researchLaneFilePath(dataDir);
  const researchExisting = new Set(readJsonl<ResearchCohortRow>(researchPath).map(r => r.dedupeKey).filter(Boolean));
  const researchSeen = new Set<string>();
  const researchToAppend: ResearchCohortRow[] = [];
  let researchHits = 0, researchDupes = 0;
  for (const row of rows) {
    const rc = deriveResearchCandidate(row);
    if (!rc || !researchLaneMatches(rc)) continue;
    researchHits++;
    const rr = researchCandidateToRow(rc, cycleId, cycleFileName!, enrolledAt);
    if (researchExisting.has(rr.dedupeKey) || researchSeen.has(rr.dedupeKey)) { researchDupes++; continue; }
    researchSeen.add(rr.dedupeKey);
    researchToAppend.push(rr);
  }
  if (!dryRun && researchToAppend.length > 0) {
    fs.mkdirSync(path.dirname(researchPath), { recursive: true });
    fs.appendFileSync(researchPath, researchToAppend.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  }
  const researchLane: ResearchLaneEnrollResult = {
    lane: 'NO_BM_RESEARCH', cohortName: NO_BM_RESEARCH_COHORT, cohortPath: researchPath,
    rowsScanned: rows.length, hitsFound: researchHits, rowsAppended: researchToAppend.length,
    duplicatesSkipped: researchDupes, appendedRows: researchToAppend, topEnrolled: researchToAppend.slice(0, topN),
  };

  return {
    ...base,
    cycleId,
    rowsScanned: rows.length,
    lanes:       laneResults,
    researchLane,
    reportOnly:  dryRun, // a real append is a write; still paper-only & gate-neutral
  };
}

// ── Enrollment renderer ────────────────────────────────────────────────────────────────

function shortC(c: string | null): string {
  if (!c) return '(none)';
  return c.length > 14 ? c.slice(0, 6) + '..' + c.slice(-4) : c;
}

export function renderFamilyEnroll(r: FamilyEnrollResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — FORWARD COHORT FAMILY ENROLL (PAPER ONLY — NOT A BUY SIGNAL)');
  L.push(`  [APPEND-ONLY${r.dryRun ? ' — DRY RUN (NO WRITE)' : ''} — UNKNOWN ≠ CLEAN]`);
  L.push(SEP, '');
  L.push(`  Generated at : ${r.generatedAt}`);
  L.push(`  Latest cycle : ${r.cycleFile ?? '(none)'}`);
  L.push(`  Rows scanned : ${r.rowsScanned}`);
  L.push('');
  for (const lane of r.lanes) {
    L.push(`  ${SEP2}`);
    L.push(`  LANE ${lane.lane}`);
    L.push(`  ${SEP2}`);
    L.push(`    Cohort file       : ${lane.cohortPath}`);
    L.push(`    Rows scanned      : ${lane.rowsScanned}`);
    L.push(`    Hits found        : ${lane.hitsFound}`);
    L.push(`    Rows appended     : ${lane.rowsAppended}${r.dryRun ? ' (would append)' : ''}`);
    L.push(`    Duplicates skipped: ${lane.duplicatesSkipped}`);
    if (lane.topEnrolled.length > 0) {
      L.push('    Top enrolled:');
      for (const c of lane.topEnrolled) {
        L.push(`      ${(c.symbol ?? '-').slice(0, 12).padEnd(12)} ${shortC(c.contract).padEnd(14)} ` +
          `band=${c.m5Band}  liq=${c.liquidityBucket}  vlr=${c.vlrBucket}  ` +
          `timing=${c.paperEntryTiming}  score=${c.ripperScore ?? 'n/a'}  cluster=${c.clusterRisk ?? 'n/a'}`);
      }
    }
    L.push('');
  }
  if (r.researchLane) {
    const rl = r.researchLane;
    L.push(`  ${SEP2}`);
    L.push(`  LANE ${rl.lane}  (BubbleMaps IGNORED for enrollment — paper-only research)`);
    L.push(`  ${SEP2}`);
    L.push(`    Cohort file       : ${rl.cohortPath}`);
    L.push(`    Rows scanned      : ${rl.rowsScanned}`);
    L.push(`    Hits found        : ${rl.hitsFound}`);
    L.push(`    Rows appended     : ${rl.rowsAppended}${r.dryRun ? ' (would append)' : ''}`);
    L.push(`    Duplicates skipped: ${rl.duplicatesSkipped}`);
    L.push('    bmIgnoredForResearch=true  paperOnly=true  notBuySignal=true  unknownNotClean=true');
    if (rl.topEnrolled.length > 0) {
      L.push('    Top enrolled:');
      for (const c of rl.topEnrolled) {
        L.push(`      ${(c.symbol ?? '-').slice(0, 12).padEnd(12)} ${shortC(c.contract).padEnd(14)} ` +
          `band=${c.m5Band}  liq=${c.liquidityBucket}  vlr=${c.vlrBucket}  ` +
          `gate=${c.buyGateDecision ?? 'n/a'}  score=${c.ripperScore ?? 'n/a'}  cluster=${c.clusterRisk ?? 'n/a'}`);
      }
    }
    L.push('');
  }
  L.push(`  ${WATCH_SAFETY_LABEL}`);
  L.push('  Enrollment is NOT buy approval. No gates changed. No trades written.');
  L.push('  DO_NOT_ENABLE_REAL_TRADING  DO_NOT_PROMOTE_TO_REAL_TRADING');
  L.push('  DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push(SEP, '');
  return L.join('\n');
}

// ── Report ────────────────────────────────────────────────────────────────────────────

export type CohortOutcomeStatus = 'OBSERVED' | 'PENDING' | 'OUTCOME_UNMATCHED';

export type FamilyLaneRecommendation =
  | 'FORWARD_SAMPLE_TOO_SMALL'
  | 'KEEP_COLLECTING'
  | 'PAPER_ONLY_CANDIDATE';

export interface LaneOutcomeStats {
  n:                 number;
  winRate:           number;
  redLossRate:       number;  // strictly-negative P/L share
  flatRate:          number;
  avgPnlRaw:         number;
  avgPnlCapped:      number;
  medianPnl:         number;
  worstPnl:          number;
  bestPnl:           number;
  outlierDependence: number;
  clusterBreakdown:  Record<string, number>;
  m5BandBreakdown:   Record<string, number>;
}

export interface LaneReport {
  lane:             LaneKey;
  cohortName:       string;
  cohortPath:       string;
  describe:         string;
  enrolledCount:    number;
  observedCount:    number;
  pendingCount:     number;
  unmatchedCount:   number;
  stats:            LaneOutcomeStats;
  recommendation:   FamilyLaneRecommendation;
  recommendationReason: string;
}

/** Report shape for the NO_BM_RESEARCH shadow lane (BubbleMaps ignored for enrollment). */
export interface ResearchLaneReport {
  lane:             'NO_BM_RESEARCH';
  cohortName:       string;
  cohortPath:       string;
  describe:         string;
  enrolledCount:    number;
  observedCount:    number;
  pendingCount:     number;
  unmatchedCount:   number;
  stats:            LaneOutcomeStats;
  recommendation:   FamilyLaneRecommendation;
  recommendationReason: string;
  bmIgnoredForResearch: true;
}

export interface FamilyReportResult {
  generatedAt:    string;
  dataDir:        string;
  baseline:       LaneOutcomeStats;   // OVERALL_APPROVED observed paper population
  lanes:          LaneReport[];
  researchLane?:  ResearchLaneReport; // NO_BM_RESEARCH shadow lane (separate file)
  ranking: {
    byObservedN:        LaneKey[];
    byWinRate:          LaneKey[];
    byMedian:           LaneKey[];
    byCappedAvg:        LaneKey[];
    byRedLossAsc:       LaneKey[];
    byOutlierDepAsc:    LaneKey[];
  };
  familyRecommendation: FamilyLaneRecommendation;
  config: { minForwardN: number; pnlCapPct: number };
  safetyLabel:    string;

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

export interface FamilyReportOptions extends PaperTradeSimulationOptions {
  dataDir?:     string;
  minForwardN?: number;
  generatedAt?: string;
  /** Test-only injection. */
  _trades?:          SimulatedTrade[];
  _cohortRowsByLane?: Partial<Record<LaneKey, FamilyCohortRow[]>>;
  _researchCohortRows?: ResearchCohortRow[];
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
  clusterRisk:     string | null;
}

function statsFromOutcomes(rows: OutcomeRow[]): LaneOutcomeStats {
  const n = rows.length;
  const pnls   = rows.map(r => r.simulatedPnlPct);
  const capped = pnls.map(cap);
  const winners = rows.filter(r => r.simulatedPnlPct > 0).length;
  const flats   = rows.filter(r => r.simulatedPnlPct === 0).length;
  const losers  = rows.filter(r => r.simulatedPnlPct < 0).length;
  return {
    n,
    winRate:     n ? winners / n : 0,
    redLossRate: n ? losers  / n : 0,
    flatRate:    n ? flats   / n : 0,
    avgPnlRaw:    avg(pnls),
    avgPnlCapped: avg(capped),
    medianPnl:    median(pnls),
    worstPnl:     pnls.length ? Math.min(...pnls) : 0,
    bestPnl:      pnls.length ? Math.max(...pnls) : 0,
    outlierDependence: outlierDependence(capped),
    clusterBreakdown: tally(rows.map(r => r.clusterRisk)),
    m5BandBreakdown:  tally(rows.map(r => r.m5Band), 'UNAVAILABLE'),
  };
}

/** Minimal cohort-row shape needed to join to outcomes — satisfied by strict + research rows. */
interface JoinableCohortRow {
  contract:    string;
  capturedAt:  string | null;
  m5Band:      string;
  clusterRisk: string | null;
}

/** Join cohort rows to observed outcomes by contract. Outcome fields used here ONLY for scoring. */
function joinOutcomes(
  cohortRows: JoinableCohortRow[],
  tradesByContract: Map<string, SimulatedTrade[]>,
): { observed: OutcomeRow[]; observedCount: number; pendingCount: number; unmatchedCount: number } {
  const observed: OutcomeRow[] = [];
  let observedCount = 0, pendingCount = 0, unmatchedCount = 0;

  for (const row of cohortRows) {
    const candidates = tradesByContract.get(row.contract) ?? [];
    let matchTrade: SimulatedTrade | null = null;
    let status: CohortOutcomeStatus;

    if (candidates.length === 0) {
      status = 'PENDING';
    } else if (candidates.length === 1) {
      status = 'OBSERVED';
      matchTrade = candidates[0]!;
    } else {
      const capMs = row.capturedAt ? Date.parse(row.capturedAt) : NaN;
      if (Number.isNaN(capMs)) {
        status = 'OUTCOME_UNMATCHED';
      } else {
        const scored = candidates.map(t => {
          const ts = Date.parse(t.targetEntryAt || t.observedAt || '');
          return { t, dist: Number.isNaN(ts) ? Infinity : Math.abs(ts - capMs) };
        }).sort((a, b) => a.dist - b.dist);
        const best = scored[0]!, second = scored[1]!;
        if (Number.isFinite(best.dist) && best.dist < second.dist) { status = 'OBSERVED'; matchTrade = best.t; }
        else status = 'OUTCOME_UNMATCHED';
      }
    }

    if (status === 'OBSERVED' && matchTrade) {
      observedCount++;
      observed.push({ simulatedPnlPct: matchTrade.simulatedPnlPct, m5Band: row.m5Band, clusterRisk: row.clusterRisk });
    } else if (status === 'PENDING') {
      pendingCount++;
    } else {
      unmatchedCount++;
    }
  }
  return { observed, observedCount, pendingCount, unmatchedCount };
}

function laneRecommendation(
  s: LaneOutcomeStats, observedCount: number, baseline: LaneOutcomeStats, minN: number,
): { rec: FamilyLaneRecommendation; reason: string } {
  if (observedCount < minN) {
    return { rec: 'FORWARD_SAMPLE_TOO_SMALL', reason: `observed n=${observedCount} < ${minN}` };
  }
  // Conservative "better than baseline": ahead on win rate AND capped avg, not worse on median
  // or red-loss, and not outlier-driven.
  const better =
    s.winRate      > baseline.winRate &&
    s.avgPnlCapped > baseline.avgPnlCapped &&
    s.medianPnl    >= baseline.medianPnl &&
    s.redLossRate  <= baseline.redLossRate &&
    s.outlierDependence <= OUTLIER_MAX;
  if (better) {
    return {
      rec: 'PAPER_ONLY_CANDIDATE',
      reason: `n=${observedCount}: win ${(s.winRate * 100).toFixed(1)}% > base ${(baseline.winRate * 100).toFixed(1)}%, ` +
        `cappedAvg ${s.avgPnlCapped.toFixed(2)}% > base ${baseline.avgPnlCapped.toFixed(2)}%, outlierDep ${s.outlierDependence.toFixed(2)} — PAPER ONLY`,
    };
  }
  return { rec: 'KEEP_COLLECTING', reason: `n=${observedCount} but not clearly better than baseline` };
}

export function runFamilyReport(opts: FamilyReportOptions = {}): FamilyReportResult {
  const dataDir     = opts.dataDir     ?? DEFAULT_DATA_DIR;
  const minForwardN = opts.minForwardN ?? FAMILY_MIN_FORWARD_N;
  const generatedAt = opts.generatedAt ?? new Date(opts.nowMs ?? Date.now()).toISOString();

  const trades: SimulatedTrade[] = opts._trades ?? runPaperTradeSimulationReport({
    intentsPath: opts.intentsPath,
    memoryPath:  opts.memoryPath,
    cyclesDir:   opts.cyclesDir,
    nowMs:       opts.nowMs,
  }).simulatedTrades;

  const tradesByContract = new Map<string, SimulatedTrade[]>();
  for (const t of trades) {
    const list = tradesByContract.get(t.contract) ?? [];
    list.push(t);
    tradesByContract.set(t.contract, list);
  }

  // Baseline = the full observed approved paper population (read-only, scoring only).
  const baseline = statsFromOutcomes(trades.map(t => ({
    simulatedPnlPct: t.simulatedPnlPct, m5Band: t.m5Band, clusterRisk: t.clusterRisk,
  })));

  const lanes: LaneReport[] = LANES.map(def => {
    const cohortPath = laneFilePath(dataDir, def.key);
    const cohortRows = opts._cohortRowsByLane?.[def.key] ?? readJsonl<FamilyCohortRow>(cohortPath);
    const joined = joinOutcomes(cohortRows, tradesByContract);
    const stats  = statsFromOutcomes(joined.observed);
    const { rec, reason } = laneRecommendation(stats, joined.observedCount, baseline, minForwardN);
    return {
      lane: def.key, cohortName: def.cohortName, cohortPath, describe: def.describe,
      enrolledCount: cohortRows.length,
      observedCount: joined.observedCount,
      pendingCount:  joined.pendingCount,
      unmatchedCount: joined.unmatchedCount,
      stats, recommendation: rec, recommendationReason: reason,
    };
  });

  // NO_BM_RESEARCH shadow lane report (separate cohort file; BubbleMaps ignored for enrollment).
  const researchPath = researchLaneFilePath(dataDir);
  const researchRows = opts._researchCohortRows ?? readJsonl<ResearchCohortRow>(researchPath);
  const researchJoined = joinOutcomes(researchRows, tradesByContract);
  const researchStats  = statsFromOutcomes(researchJoined.observed);
  const researchRec = laneRecommendation(researchStats, researchJoined.observedCount, baseline, minForwardN);
  const researchLane: ResearchLaneReport = {
    lane: 'NO_BM_RESEARCH', cohortName: NO_BM_RESEARCH_COHORT, cohortPath: researchPath,
    describe: NO_BM_RESEARCH_DESCRIBE,
    enrolledCount: researchRows.length,
    observedCount: researchJoined.observedCount,
    pendingCount:  researchJoined.pendingCount,
    unmatchedCount: researchJoined.unmatchedCount,
    stats: researchStats, recommendation: researchRec.rec, recommendationReason: researchRec.reason,
    bmIgnoredForResearch: true,
  };

  const rankBy = (cmp: (a: LaneReport, b: LaneReport) => number): LaneKey[] =>
    [...lanes].sort(cmp).map(l => l.lane);

  const ranking = {
    byObservedN:     rankBy((a, b) => b.observedCount - a.observedCount),
    byWinRate:       rankBy((a, b) => b.stats.winRate - a.stats.winRate),
    byMedian:        rankBy((a, b) => b.stats.medianPnl - a.stats.medianPnl),
    byCappedAvg:     rankBy((a, b) => b.stats.avgPnlCapped - a.stats.avgPnlCapped),
    byRedLossAsc:    rankBy((a, b) => a.stats.redLossRate - b.stats.redLossRate),
    byOutlierDepAsc: rankBy((a, b) => a.stats.outlierDependence - b.stats.outlierDependence),
  };

  const familyRecommendation: FamilyLaneRecommendation =
    lanes.some(l => l.recommendation === 'PAPER_ONLY_CANDIDATE') ? 'PAPER_ONLY_CANDIDATE' :
    lanes.some(l => l.observedCount >= minForwardN)              ? 'KEEP_COLLECTING' :
    'FORWARD_SAMPLE_TOO_SMALL';

  return {
    generatedAt, dataDir, baseline, lanes, researchLane, ranking, familyRecommendation,
    config: { minForwardN, pnlCapPct: PNL_CAP_PCT },
    safetyLabel: WATCH_SAFETY_LABEL,
    reportOnly: true, readOnly: true, paperOnly: true, realTradingLocked: true,
    tradingExecuted: 0, noGateChanges: true, noBuySignal: true, noPaperIntentMutation: true,
    unknownNeverClean: true,
  };
}

// ── Report renderer ──────────────────────────────────────────────────────────────────

function pctS(v: number): string { return (v * 100).toFixed(1) + '%'; }
function pnlS(v: number): string { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function bd(b: Record<string, number>): string {
  const e = Object.entries(b).sort((a, b2) => b2[1] - a[1]);
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join('  ') : '(none)';
}

export function renderFamilyReport(r: FamilyReportResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — FORWARD COHORT FAMILY REPORT (PAPER ONLY — NOT A BUY SIGNAL)');
  L.push('  [REPORT ONLY — READ ONLY — PAPER ONLY — UNKNOWN ≠ CLEAN]');
  L.push('  Cohort membership uses ENTRY-TIME fields only (never outcome/P&L).');
  L.push(SEP, '');
  L.push(`  Generated at : ${r.generatedAt}`);
  L.push(`  Data dir     : ${r.dataDir}`);
  L.push('');
  L.push(`  ${SEP2}`);
  L.push('  BASELINE — OVERALL_APPROVED (observed paper population)');
  L.push(`  ${SEP2}`);
  L.push(`    n=${r.baseline.n}  win=${pctS(r.baseline.winRate)}  redLoss=${pctS(r.baseline.redLossRate)}  ` +
    `flat=${pctS(r.baseline.flatRate)}  med=${pnlS(r.baseline.medianPnl)}  cappedAvg=${pnlS(r.baseline.avgPnlCapped)}  ` +
    `outlierDep=${r.baseline.outlierDependence.toFixed(2)}`);
  L.push('');

  for (const lane of r.lanes) {
    const s = lane.stats;
    L.push(`  ${SEP2}`);
    L.push(`  LANE ${lane.lane}  [${lane.recommendation}]`);
    L.push(`  ${SEP2}`);
    L.push(`    ${lane.describe}`);
    L.push(`    cohort file : ${lane.cohortPath}`);
    L.push(`    enrolled=${lane.enrolledCount}  observed=${lane.observedCount}  ` +
      `pending=${lane.pendingCount}  unmatched=${lane.unmatchedCount}`);
    L.push(`    win=${pctS(s.winRate)}  redLoss=${pctS(s.redLossRate)}  flat=${pctS(s.flatRate)}`);
    L.push(`    avgRaw=${pnlS(s.avgPnlRaw)}  cappedAvg=${pnlS(s.avgPnlCapped)}  med=${pnlS(s.medianPnl)}  ` +
      `worst=${pnlS(s.worstPnl)}  best=${pnlS(s.bestPnl)}  outlierDep=${s.outlierDependence.toFixed(2)}`);
    L.push(`    cluster: ${bd(s.clusterBreakdown)}`);
    L.push(`    m5 band: ${bd(s.m5BandBreakdown)}`);
    L.push(`    → ${lane.recommendationReason}`);
    L.push('');
  }

  if (r.researchLane) {
    const rl = r.researchLane;
    const s = rl.stats;
    L.push(`  ${SEP2}`);
    L.push(`  LANE ${rl.lane}  [${rl.recommendation}]  (BubbleMaps IGNORED for enrollment)`);
    L.push(`  ${SEP2}`);
    L.push(`    ${rl.describe}`);
    L.push(`    cohort file : ${rl.cohortPath}`);
    L.push('    bmIgnoredForResearch=true  paperOnly=true  notBuySignal=true  unknownNotClean=true');
    L.push(`    enrolled=${rl.enrolledCount}  observed=${rl.observedCount}  ` +
      `pending=${rl.pendingCount}  unmatched=${rl.unmatchedCount}`);
    L.push(`    win=${pctS(s.winRate)}  redLoss=${pctS(s.redLossRate)}  flat=${pctS(s.flatRate)}`);
    L.push(`    avgRaw=${pnlS(s.avgPnlRaw)}  cappedAvg=${pnlS(s.avgPnlCapped)}  med=${pnlS(s.medianPnl)}  ` +
      `worst=${pnlS(s.worstPnl)}  best=${pnlS(s.bestPnl)}  outlierDep=${s.outlierDependence.toFixed(2)}`);
    L.push(`    cluster: ${bd(s.clusterBreakdown)}  (UNKNOWN is recorded, NEVER treated as CLEAN)`);
    L.push(`    m5 band: ${bd(s.m5BandBreakdown)}`);
    L.push(`    → ${rl.recommendationReason}`);
    L.push('');
  }

  // STRICT_BM vs NO_BM_RESEARCH vs baseline comparison.
  L.push(`  ${SEP2}`);
  L.push('  COMPARISON — STRICT_BM vs NO_BM_RESEARCH vs BASELINE');
  L.push(`  ${SEP2}`);
  const fmtRow = (label: string, n: number, st: LaneOutcomeStats): string =>
    `    ${label.padEnd(20)} obs=${String(n).padStart(5)}  win=${pctS(st.winRate).padStart(6)}  ` +
    `redLoss=${pctS(st.redLossRate).padStart(6)}  flat=${pctS(st.flatRate).padStart(6)}  ` +
    `med=${pnlS(st.medianPnl).padStart(8)}  cappedAvg=${pnlS(st.avgPnlCapped).padStart(8)}  ` +
    `outlierDep=${st.outlierDependence.toFixed(2)}`;
  L.push(fmtRow('BASELINE', r.baseline.n, r.baseline));
  for (const lane of r.lanes) L.push(fmtRow(`STRICT_BM:${lane.lane}`, lane.observedCount, lane.stats));
  if (r.researchLane) L.push(fmtRow('NO_BM_RESEARCH', r.researchLane.observedCount, r.researchLane.stats));
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  COMPARISON — LANE RANKINGS');
  L.push(`  ${SEP2}`);
  L.push(`    by observed n      : ${r.ranking.byObservedN.join(' > ')}`);
  L.push(`    by win rate        : ${r.ranking.byWinRate.join(' > ')}`);
  L.push(`    by median P/L      : ${r.ranking.byMedian.join(' > ')}`);
  L.push(`    by capped avg P/L  : ${r.ranking.byCappedAvg.join(' > ')}`);
  L.push(`    by red-loss (asc)  : ${r.ranking.byRedLossAsc.join(' > ')}`);
  L.push(`    by outlier-dep(asc): ${r.ranking.byOutlierDepAsc.join(' > ')}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  FAMILY RECOMMENDATION');
  L.push(`  ${SEP2}`);
  L.push(`    [${r.familyRecommendation}]`);
  L.push('    Conservative: a PAPER_ONLY_CANDIDATE is paper-only research — NOT a buy signal.');
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`);
  L.push('  PAPER_ONLY_WATCH_NOT_BUY');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push('  DO_NOT_PROMOTE_TO_REAL_TRADING');
  L.push('  DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push('  A cohort lane is NOT a buy signal. No gates changed. No intents/trades mutated.');
  L.push('  UNKNOWN_CLUSTER_RISK_IS_NEVER_TREATED_AS_CLEAN=true');
  L.push('  reportOnly=true  readOnly=true  paperOnly=true  realTradingLocked=true  tradingExecuted=0');
  L.push(SEP, '');
  return L.join('\n');
}
