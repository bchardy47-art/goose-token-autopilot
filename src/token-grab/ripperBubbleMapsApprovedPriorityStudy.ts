// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  NO_GATE_CHANGES  NO_FILTER_CHANGE
//
// BubbleMaps Approved Candidate Priority Study v1 — a REPORT_ONLY simulation that
// asks: if a limited BubbleMaps holder-risk call budget were spent on
// BUY_APPROVED_PAPER candidates BEFORE BUY_REJECTED candidates, would approved-row
// holder coverage improve?
//
// This is a STUDY. It does NOT change behavior. It does NOT change gates, policy,
// or filters. It does NOT call BubbleMaps or any API. It does NOT mutate any file.
// It does NOT re-enable live trading or live holder lookups. UNKNOWN cluster risk
// is NEVER treated as CLEAN.

import * as fs   from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_CYCLES_DIR   = 'data/token-grab/ripper/cycles';
const DEFAULT_MEMORY_PATH  = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_INTENTS_PATH = 'data/token-grab/ripper/paper-intents.jsonl';
const DEFAULT_RECENT       = 10;
const DEFAULT_TOP_N        = 10;
// Hypothetical per-cycle call cap used ONLY for the "if BubbleMaps were enabled"
// simulation when no real cap was observed. Configurable via --assumed-cap. This
// is a STUDY parameter — it never enables anything.
const DEFAULT_ASSUMED_CAP  = 10;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

const APPROVED_GATE = 'BUY_APPROVED_PAPER';
const REJECTED_GATE = 'BUY_REJECTED';

// ── Types ───────────────────────────────────────────────────────────────────────

// A candidate row that is UNKNOWN at the cluster layer and therefore WOULD have
// needed a BubbleMaps holder call to resolve. priorityTier encodes the approved-first
// ordering: 1 = approved+M5, 2 = approved, 3 = rejected+M5, 4 = rejected.
export interface PriorityCandidate {
  contract:     string;
  symbol:       string | null;
  gate:         'BUY_APPROVED_PAPER' | 'BUY_REJECTED';
  hasM5:        boolean;
  priorityTier: 1 | 2 | 3 | 4;
}

export interface CoverageStats {
  scope:                 string;   // 'all-cycles' | 'recent'
  approvedTotal:         number;
  approvedUnknown:       number;
  approvedKnownCoveragePct: number | null;
  rejectedTotal:         number;
  rejectedUnknown:       number;
  rejectedKnownCoveragePct: number | null;
  m5ApprovedUnknown:     number;
  m5RejectedUnknown:     number;
  approvedUnknownPct:    number | null;
  rejectedUnknownPct:    number | null;
}

export interface BubbleMapsUsage {
  recentCyclesScanned:        number;
  liveCallsUsed:              number;
  cacheHits:                  number;
  capSkippedRows:             number;
  bubbleMapsDisabledCycles:   number;
  estimatedCallCap:           number | null;   // parsed from cycle notes when present
  approvedRowsNeedingCalls:   number;          // approved UNKNOWN rows (recent)
  rejectedRowsNeedingCalls:   number;          // rejected UNKNOWN rows (recent)
  note:                       string;
}

export interface AllocationSimulation {
  label:                  'observed' | 'hypothetical-enabled';
  perCycleCapModel:       string;
  cyclesSimulated:        number;
  cyclesWithZeroCap:      number;   // disabled / no budget → priority cannot help
  totalCap:               number;
  approvedUnknownDemand:  number;
  rejectedUnknownDemand:  number;
  approvedCoveredFirst:   number;   // approved UNKNOWN rows that get a call under approved-first
  approvedM5CoveredFirst: number;   // tier-1 (approved+M5) rows covered
  rejectedCovered:        number;
  rejectedDeferred:       number;   // rejected UNKNOWN deferred because approved took priority
  approvedStillUncovered: number;   // cap not enough even after prioritizing approved
  baselineApprovedCovered: number;  // proportional (un-prioritized) baseline
  approvedCoverageImprovementRows: number;
  currentApprovedCoveragePct:   number | null;
  projectedApprovedCoveragePct: number | null;
  approvedCoverageImprovementPct: number | null;
  note:                   string;
}

export type DiagnosisLabel =
  | 'APPROVED_ROWS_UNDER_COVERED'
  | 'BUBBLEMAPS_DISABLED_DOMINATES'
  | 'CAP_PRIORITY_WOULD_HELP'
  | 'CAP_PRIORITY_NOT_ENOUGH'
  | 'M5_APPROVED_UNKNOWN_DOMINATES'
  | 'STUDY_ONLY_NO_POLICY_CHANGE';

export interface SamplePriorityRow {
  symbol:         string | null;
  contractPrefix: string;
  gate:           string;
  hasM5:          boolean;
  priorityTier:   number;
  cycleFile:      string;
}

export interface ApprovedPriorityStudyResult {
  generatedAt: string;

  // §1 — overview
  latestCycleFile:        string | null;
  totalCycleFiles:        number;
  totalCycleRowsScanned:  number;
  totalMemoryRowsScanned: number;
  assumedCapUsed:         number;

  // §2 — current coverage (all-time + recent)
  coverageAll:    CoverageStats;
  coverageRecent: CoverageStats;

  // §3 — BubbleMaps usage / disabled / cap pressure
  bubbleMapsUsage: BubbleMapsUsage;

  // §4 — simulated approved-first allocation
  observedSimulation:     AllocationSimulation;
  hypotheticalSimulation: AllocationSimulation;

  // §5 — top-priority sample candidates (approved UNKNOWN first)
  topPriorityCandidates: SamplePriorityRow[];

  // §6 — diagnosis
  diagnoses: DiagnosisLabel[];

  // §7 — recommendation
  recommendations: string[];

  // §8 — what priority would NOT fix
  whatPriorityWouldNotFix: string[];

  // safety
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  noMutation:        true;
  noRealTrading:     true;
  noGateChanges:     true;
  noPolicyChange:    true;
  noFilterChange:    true;
  noApiCalls:        true;
  noBubbleMapsCall:  true;
  noWallet:          true;
  noSwap:            true;
  noSigning:         true;
  noBubbleMapsReEnable: true;
  realTradingLocked: true;
  behaviorChanged:   false;
  tradingExecuted:   0;
}

export interface ApprovedPriorityStudyOptions {
  cyclesDir?:   string;
  memoryPath?:  string;
  intentsPath?: string;
  recent?:      number;
  topN?:        number;
  assumedCap?:  number;
  generatedAt?: string;
}

// ── Raw row types (defensive — do not assume schema) ────────────────────────────

interface RawCycleRow {
  capturedAt?:       string;
  entryMomentumPct?: number | null;
  buyGateDecision?:  string;
  normalizedSignal?: { contract?: string; symbol?: string };
  ripperInput?:      { contract?: string; clusterRisk?: string };
  raw?: {
    contract?:        string;
    symbol?:          string;
    clusterRisk?:     string;
    clusterProvider?: string;
    clusterNotes?:    string[];
  };
}

interface RawMemRow {
  clusterRisk?:      string;
  entryMomentumPct?: number | null;
  gateDecision?:     string;
  [k: string]: unknown;
}

// ── Helpers (self-contained — no behavior-changing imports) ─────────────────────

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

// Absent / unrecognized → MISSING. UNKNOWN stays UNKNOWN, never CLEAN.
function normalizeCluster(value: unknown): 'CLEAN' | 'WATCH' | 'RISKY' | 'UNKNOWN' | 'MISSING' {
  if (typeof value !== 'string') return 'MISSING';
  const v = value.trim().toUpperCase();
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY' || v === 'UNKNOWN') return v;
  return 'MISSING';
}

function cycleCluster(row: RawCycleRow): 'CLEAN' | 'WATCH' | 'RISKY' | 'UNKNOWN' | 'MISSING' {
  if (row.raw?.clusterRisk != null)         return normalizeCluster(row.raw.clusterRisk);
  if (row.ripperInput?.clusterRisk != null) return normalizeCluster(row.ripperInput.clusterRisk);
  return 'MISSING';
}

function hasM5(m5: unknown): m5 is number {
  return typeof m5 === 'number' && Number.isFinite(m5);
}

function cycleContract(row: RawCycleRow): string {
  return row.normalizedSignal?.contract ?? row.ripperInput?.contract ?? row.raw?.contract ?? 'unknown';
}

function cycleSymbol(row: RawCycleRow): string | null {
  return row.normalizedSignal?.symbol ?? row.raw?.symbol ?? null;
}

function parseCapFromNotes(notes: string[] | undefined): number | null {
  if (!notes) return null;
  for (const n of notes) {
    const m = String(n).match(/cap of (\d+)|per-run cap[:\s]+(\d+)|current:\s*(\d+)/i);
    if (m) {
      const v = m[1] ?? m[2] ?? m[3];
      if (v != null) return Number(v);
    }
  }
  return null;
}

function notesIndicateDisabled(notes: string[] | undefined): boolean {
  if (!notes) return false;
  return notes.some(n => /disabled/i.test(String(n)));
}

// ── Per-cycle scan ──────────────────────────────────────────────────────────────

interface CycleScan {
  fileName:        string;
  totalRows:       number;
  approvedTotal:   number;
  approvedUnknown: number;
  rejectedTotal:   number;
  rejectedUnknown: number;
  m5ApprovedUnknown: number;
  m5RejectedUnknown: number;
  liveCalls:       number;
  cacheHits:       number;
  capSkippedRows:  number;
  disabled:        boolean;
  parsedCap:       number | null;
  candidates:      PriorityCandidate[];   // UNKNOWN approved/rejected rows needing a call
}

function tierFor(gate: 'BUY_APPROVED_PAPER' | 'BUY_REJECTED', m5: boolean): 1 | 2 | 3 | 4 {
  if (gate === APPROVED_GATE) return m5 ? 1 : 2;
  return m5 ? 3 : 4;
}

function scanCycle(fileName: string, rows: RawCycleRow[]): CycleScan {
  const s: CycleScan = {
    fileName,
    totalRows: rows.length,
    approvedTotal: 0,
    approvedUnknown: 0,
    rejectedTotal: 0,
    rejectedUnknown: 0,
    m5ApprovedUnknown: 0,
    m5RejectedUnknown: 0,
    liveCalls: 0,
    cacheHits: 0,
    capSkippedRows: 0,
    disabled: false,
    parsedCap: null,
    candidates: [],
  };
  for (const row of rows) {
    const cl   = cycleCluster(row);
    const m5   = hasM5(row.entryMomentumPct);
    const gate = row.buyGateDecision ?? null;

    if (gate === APPROVED_GATE) {
      s.approvedTotal++;
      if (cl === 'UNKNOWN') {
        s.approvedUnknown++;
        if (m5) s.m5ApprovedUnknown++;
        s.candidates.push({
          contract: cycleContract(row), symbol: cycleSymbol(row),
          gate: APPROVED_GATE, hasM5: m5, priorityTier: tierFor(APPROVED_GATE, m5),
        });
      }
    } else if (gate === REJECTED_GATE) {
      s.rejectedTotal++;
      if (cl === 'UNKNOWN') {
        s.rejectedUnknown++;
        if (m5) s.m5RejectedUnknown++;
        s.candidates.push({
          contract: cycleContract(row), symbol: cycleSymbol(row),
          gate: REJECTED_GATE, hasM5: m5, priorityTier: tierFor(REJECTED_GATE, m5),
        });
      }
    }

    const provider = row.raw?.clusterProvider;
    if (provider === 'bubblemaps') s.liveCalls++;
    else if (provider === 'bubblemaps-cached') s.cacheHits++;

    const notes = row.raw?.clusterNotes ?? [];
    if (notesIndicateDisabled(notes)) s.disabled = true;
    if (/cap of|per-run cap/i.test(notes.join(' | '))) s.capSkippedRows++;
    const parsed = parseCapFromNotes(notes);
    if (parsed != null) s.parsedCap = parsed;
  }
  return s;
}

// ── Priority sort (exported & tested) ───────────────────────────────────────────

// Stable sort by priorityTier ascending: approved+M5, approved, rejected+M5, rejected.
export function prioritizeCandidates(candidates: PriorityCandidate[]): PriorityCandidate[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.priorityTier - b.c.priorityTier) || (a.i - b.i))
    .map(x => x.c);
}

// ── Coverage aggregation ────────────────────────────────────────────────────────

function buildCoverage(scope: string, scans: CycleScan[]): CoverageStats {
  let approvedTotal = 0, approvedUnknown = 0, rejectedTotal = 0, rejectedUnknown = 0;
  let m5ApprovedUnknown = 0, m5RejectedUnknown = 0;
  for (const s of scans) {
    approvedTotal     += s.approvedTotal;
    approvedUnknown   += s.approvedUnknown;
    rejectedTotal     += s.rejectedTotal;
    rejectedUnknown   += s.rejectedUnknown;
    m5ApprovedUnknown += s.m5ApprovedUnknown;
    m5RejectedUnknown += s.m5RejectedUnknown;
  }
  const approvedKnownCoveragePct = approvedTotal > 0
    ? ((approvedTotal - approvedUnknown) / approvedTotal) * 100 : null;
  const rejectedKnownCoveragePct = rejectedTotal > 0
    ? ((rejectedTotal - rejectedUnknown) / rejectedTotal) * 100 : null;
  return {
    scope,
    approvedTotal, approvedUnknown, approvedKnownCoveragePct,
    rejectedTotal, rejectedUnknown, rejectedKnownCoveragePct,
    m5ApprovedUnknown, m5RejectedUnknown,
    approvedUnknownPct: approvedTotal > 0 ? (approvedUnknown / approvedTotal) * 100 : null,
    rejectedUnknownPct: rejectedTotal > 0 ? (rejectedUnknown / rejectedTotal) * 100 : null,
  };
}

// ── Allocation simulation ───────────────────────────────────────────────────────

// Simulate approved-first allocation across `scans`, given a per-cycle cap resolver.
// For each cycle: sort UNKNOWN candidates by priority, allocate the first `cap`,
// and count how many approved (and approved+M5) rows are covered first, how many
// rejected rows are deferred, and how a proportional (un-prioritized) baseline
// compares. Aggregates are summed across cycles. PURE — no I/O, no mutation.
function simulate(
  label: 'observed' | 'hypothetical-enabled',
  perCycleCapModel: string,
  scans: CycleScan[],
  capOf: (s: CycleScan) => number,
  coverage: CoverageStats,
): AllocationSimulation {
  let totalCap = 0, cyclesWithZeroCap = 0;
  let approvedCoveredFirst = 0, approvedM5CoveredFirst = 0;
  let rejectedCovered = 0, baselineApprovedCovered = 0;
  let approvedUnknownDemand = 0, rejectedUnknownDemand = 0;

  for (const s of scans) {
    const cap = Math.max(0, Math.floor(capOf(s)));
    totalCap += cap;
    if (cap === 0) cyclesWithZeroCap++;

    const approvedDemand = s.approvedUnknown;
    const rejectedDemand = s.rejectedUnknown;
    const demand = approvedDemand + rejectedDemand;
    approvedUnknownDemand += approvedDemand;
    rejectedUnknownDemand += rejectedDemand;
    if (demand === 0 || cap === 0) continue;

    const allocated = prioritizeCandidates(s.candidates).slice(0, cap);
    approvedCoveredFirst   += allocated.filter(c => c.gate === APPROVED_GATE).length;
    approvedM5CoveredFirst += allocated.filter(c => c.priorityTier === 1).length;
    rejectedCovered        += allocated.filter(c => c.gate === REJECTED_GATE).length;

    // Proportional (un-prioritized) baseline: a budget spent without regard to
    // approval would resolve approved rows only in proportion to their share.
    const served = Math.min(cap, demand);
    baselineApprovedCovered += Math.round(served * (approvedDemand / demand));
  }

  const rejectedDeferred       = rejectedUnknownDemand - rejectedCovered;
  const approvedStillUncovered = approvedUnknownDemand - approvedCoveredFirst;
  const approvedCoverageImprovementRows = approvedCoveredFirst - baselineApprovedCovered;

  const approvedTotal = coverage.approvedTotal;
  const approvedKnown = approvedTotal - coverage.approvedUnknown;
  const currentApprovedCoveragePct = approvedTotal > 0 ? (approvedKnown / approvedTotal) * 100 : null;
  const projectedApprovedCoveragePct = approvedTotal > 0
    ? ((approvedKnown + approvedCoveredFirst) / approvedTotal) * 100 : null;
  const approvedCoverageImprovementPct =
    currentApprovedCoveragePct != null && projectedApprovedCoveragePct != null
      ? projectedApprovedCoveragePct - currentApprovedCoveragePct : null;

  let note: string;
  if (label === 'observed' && cyclesWithZeroCap === scans.length && scans.length > 0) {
    note = 'Every simulated cycle had ZERO live BubbleMaps budget (disabled / no calls). ' +
           'Approved-first priority CANNOT help until live holder coverage is enabled. ' +
           'See the hypothetical-enabled simulation for what priority WOULD do if coverage existed.';
  } else if (approvedCoveredFirst > 0 && approvedCoverageImprovementRows > 0) {
    note = `Under approved-first allocation, ${approvedCoveredFirst} approved UNKNOWN rows would be ` +
           `holder-covered first (${approvedCoverageImprovementRows} more than a proportional un-prioritized ` +
           `budget), deferring ${rejectedDeferred} rejected rows. STUDY ONLY — no behavior changed.`;
  } else if (approvedCoveredFirst > 0) {
    note = `Approved-first allocation covers ${approvedCoveredFirst} approved UNKNOWN rows; the budget is ` +
           `large enough that prioritization adds little over a proportional split. STUDY ONLY.`;
  } else {
    note = 'No approved UNKNOWN rows could be covered under this simulation (no demand or no budget). STUDY ONLY.';
  }

  return {
    label, perCycleCapModel,
    cyclesSimulated: scans.length,
    cyclesWithZeroCap, totalCap,
    approvedUnknownDemand, rejectedUnknownDemand,
    approvedCoveredFirst, approvedM5CoveredFirst,
    rejectedCovered, rejectedDeferred, approvedStillUncovered,
    baselineApprovedCovered, approvedCoverageImprovementRows,
    currentApprovedCoveragePct, projectedApprovedCoveragePct, approvedCoverageImprovementPct,
    note,
  };
}

// ── Diagnosis ───────────────────────────────────────────────────────────────────

function computeDiagnoses(ctx: {
  coverageAll: CoverageStats;
  usage: BubbleMapsUsage;
  hypothetical: AllocationSimulation;
}): DiagnosisLabel[] {
  const d: DiagnosisLabel[] = [];
  const cov = ctx.coverageAll;

  // Approved rows under-covered vs rejected (or simply above the 25% UNKNOWN floor).
  const approvedWorse =
    cov.approvedUnknownPct != null &&
    (cov.approvedUnknownPct > 25 ||
      (cov.rejectedUnknownPct != null && cov.approvedUnknownPct > cov.rejectedUnknownPct));
  if (approvedWorse && cov.approvedTotal > 0) d.push('APPROVED_ROWS_UNDER_COVERED');

  // BubbleMaps disabled is the dominant blocker (most/all recent cycles disabled).
  if (ctx.usage.recentCyclesScanned > 0 &&
      ctx.usage.bubbleMapsDisabledCycles >= Math.ceil(ctx.usage.recentCyclesScanned / 2)) {
    d.push('BUBBLEMAPS_DISABLED_DOMINATES');
  }

  // Would approved-first help (if coverage existed)? Improvement rows > 0.
  if (ctx.hypothetical.approvedCoverageImprovementRows > 0) d.push('CAP_PRIORITY_WOULD_HELP');

  // Even with prioritization, the budget leaves approved rows uncovered.
  if (ctx.hypothetical.approvedStillUncovered > 0 && ctx.hypothetical.totalCap > 0) {
    d.push('CAP_PRIORITY_NOT_ENOUGH');
  }

  // M5 approved UNKNOWN rows are a dominant slice of the priority-1 bucket.
  if (cov.m5ApprovedUnknown > 0 && cov.approvedUnknown > 0 &&
      cov.m5ApprovedUnknown / cov.approvedUnknown >= 0.25) {
    d.push('M5_APPROVED_UNKNOWN_DOMINATES');
  }

  // Always present — this is a study, never a policy change.
  d.push('STUDY_ONLY_NO_POLICY_CHANGE');
  return d;
}

function computeRecommendations(diagnoses: DiagnosisLabel[]): string[] {
  const recs: string[] = [];
  if (diagnoses.includes('APPROVED_ROWS_UNDER_COVERED') || diagnoses.includes('CAP_PRIORITY_WOULD_HELP')) {
    recs.push('Study a FUTURE BubbleMaps priority policy that spends limited holder-risk calls on ' +
              'BUY_APPROVED_PAPER candidates first (approved+M5 before approved, before any rejected rows).');
  }
  if (diagnoses.includes('BUBBLEMAPS_DISABLED_DOMINATES')) {
    recs.push('Approved-first priority reallocates a budget; it cannot create coverage while BubbleMaps is ' +
              'disabled. The dominant blocker is the disable flag, not call ordering. (No automatic re-enable.)');
  }
  if (diagnoses.includes('CAP_PRIORITY_NOT_ENOUGH')) {
    recs.push('If a future priority policy is studied, note the observed/assumed cap is too small to cover all ' +
              'approved UNKNOWN rows — a cap increase would also be needed (future study only).');
  }
  recs.push('This study explicitly recommends NO change now. Specifically:');
  recs.push('  • no gate change');
  recs.push('  • no policy change');
  recs.push('  • no real trading');
  recs.push('  • no automatic BubbleMaps re-enable');
  recs.push('  • no production behavior change');
  return recs;
}

function computeWhatPriorityWouldNotFix(usage: BubbleMapsUsage, hypo: AllocationSimulation): string[] {
  const items: string[] = [];
  items.push('Priority only REORDERS a fixed call budget — it cannot increase total holder coverage.');
  if (usage.bubbleMapsDisabledCycles > 0) {
    items.push(`While BubbleMaps is disabled (${usage.bubbleMapsDisabledCycles} recent cycle(s)), there are 0 calls ` +
               'to reorder, so priority changes nothing until coverage is enabled.');
  }
  items.push('Rows that are UNKNOWN for non-cap reasons (API error, not found, schema gaps) stay UNKNOWN — ' +
             'a call would still resolve to UNKNOWN.');
  if (hypo.approvedStillUncovered > 0) {
    items.push(`Even approved-first, ${hypo.approvedStillUncovered} approved UNKNOWN rows remain uncovered under ` +
               'the assumed cap — priority alone does not close the gap.');
  }
  items.push('Priority does NOT change which candidates are approved or rejected — gates/filters are untouched.');
  return items;
}

// ── Top-priority sample rows ────────────────────────────────────────────────────

function buildTopPriorityCandidates(scans: CycleScan[], topN: number): SamplePriorityRow[] {
  const all: SamplePriorityRow[] = [];
  // Walk most-recent cycles first so the sample reflects current candidates.
  for (const s of [...scans].reverse()) {
    for (const c of prioritizeCandidates(s.candidates)) {
      all.push({
        symbol: c.symbol,
        contractPrefix: c.contract.slice(0, 16),
        gate: c.gate,
        hasM5: c.hasM5,
        priorityTier: c.priorityTier,
        cycleFile: s.fileName,
      });
    }
  }
  // Global stable sort by tier so the table leads with approved+M5 candidates.
  return all
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.priorityTier - b.r.priorityTier) || (a.i - b.i))
    .map(x => x.r)
    .slice(0, topN);
}

// ── Main runner ──────────────────────────────────────────────────────────────────

export function runApprovedPriorityStudy(
  opts: ApprovedPriorityStudyOptions = {},
): ApprovedPriorityStudyResult {
  const cyclesDir   = opts.cyclesDir   ?? DEFAULT_CYCLES_DIR;
  const memoryPath  = opts.memoryPath  ?? DEFAULT_MEMORY_PATH;
  const intentsPath = opts.intentsPath ?? DEFAULT_INTENTS_PATH;
  const recent      = opts.recent      ?? DEFAULT_RECENT;
  const topN        = opts.topN        ?? DEFAULT_TOP_N;
  const assumedCap  = opts.assumedCap  ?? DEFAULT_ASSUMED_CAP;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  const allFiles = listCycleJsonlFiles(cyclesDir);
  const allScans: CycleScan[] = allFiles.map(f =>
    scanCycle(f, readJsonl<RawCycleRow>(path.join(cyclesDir, f))));
  const recentScans = allScans.slice(-recent);

  // paper-intents / learning-memory are READ for context only (row counts).
  const intentRows = readJsonl<Record<string, unknown>>(intentsPath);
  const memRows    = readJsonl<RawMemRow>(memoryPath);

  const coverageAll    = buildCoverage('all-cycles', allScans);
  const coverageRecent = buildCoverage('recent', recentScans);

  // §3 — usage (recent window)
  const usage: BubbleMapsUsage = (() => {
    const liveCallsUsed = recentScans.reduce((s, c) => s + c.liveCalls, 0);
    const cacheHits     = recentScans.reduce((s, c) => s + c.cacheHits, 0);
    const capSkipped    = recentScans.reduce((s, c) => s + c.capSkippedRows, 0);
    const disabled      = recentScans.filter(c => c.disabled).length;
    const cap           = recentScans.map(c => c.parsedCap).filter((v): v is number => v != null).at(-1) ?? null;
    let note: string;
    if (disabled === recentScans.length && recentScans.length > 0) {
      note = 'BubbleMaps is DISABLED across all recent cycles — 0 live calls available to prioritize. ' +
             'Priority cannot help until coverage is enabled (no automatic re-enable from this study).';
    } else if (disabled > 0) {
      note = `BubbleMaps is disabled in ${disabled}/${recentScans.length} recent cycles. Where calls exist, ` +
             'approved-first priority can reorder them (see simulation).';
    } else {
      note = 'BubbleMaps live calls observed in the recent window — priority would reorder the existing budget.';
    }
    return {
      recentCyclesScanned: recentScans.length,
      liveCallsUsed, cacheHits, capSkippedRows: capSkipped,
      bubbleMapsDisabledCycles: disabled,
      estimatedCallCap: cap,
      approvedRowsNeedingCalls: coverageRecent.approvedUnknown,
      rejectedRowsNeedingCalls: coverageRecent.rejectedUnknown,
      note,
    };
  })();

  // §4 — simulations over ALL cycles (headline coverage is all-time).
  // Observed: real per-cycle budget (0 when disabled / no parsed cap & no live calls).
  const observedSimulation = simulate(
    'observed',
    'per-cycle cap = 0 if disabled, else parsed cap, else observed live calls',
    allScans,
    s => s.disabled ? 0 : (s.parsedCap ?? s.liveCalls),
    coverageAll,
  );
  // Hypothetical-enabled: assume a per-cycle cap exists (parsed cap, else assumedCap),
  // ignoring the disable flag — shows what priority WOULD do IF coverage were enabled.
  const hypotheticalSimulation = simulate(
    'hypothetical-enabled',
    `per-cycle cap = parsed cap, else assumed cap of ${assumedCap} (study assumption; does NOT enable anything)`,
    allScans,
    s => s.parsedCap ?? assumedCap,
    coverageAll,
  );

  const topPriorityCandidates = buildTopPriorityCandidates(allScans, topN);
  const diagnoses = computeDiagnoses({ coverageAll, usage, hypothetical: hypotheticalSimulation });
  const recommendations = computeRecommendations(diagnoses);
  const whatPriorityWouldNotFix = computeWhatPriorityWouldNotFix(usage, hypotheticalSimulation);

  return {
    generatedAt,
    latestCycleFile: allFiles.at(-1) ?? null,
    totalCycleFiles: allFiles.length,
    totalCycleRowsScanned: allScans.reduce((s, c) => s + c.totalRows, 0),
    totalMemoryRowsScanned: memRows.length,
    assumedCapUsed: assumedCap,
    coverageAll,
    coverageRecent,
    bubbleMapsUsage: usage,
    observedSimulation,
    hypotheticalSimulation,
    topPriorityCandidates,
    diagnoses,
    recommendations,
    whatPriorityWouldNotFix,
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    noMutation:        true,
    noRealTrading:     true,
    noGateChanges:     true,
    noPolicyChange:    true,
    noFilterChange:    true,
    noApiCalls:        true,
    noBubbleMapsCall:  true,
    noWallet:          true,
    noSwap:            true,
    noSigning:         true,
    noBubbleMapsReEnable: true,
    realTradingLocked: true,
    behaviorChanged:   false,
    tradingExecuted:   0,
  };
  // Note: intentRows read above for context parity with the cluster coverage audit;
  // they are intentionally not used in coverage math (intents lack a gate split).
  void intentRows;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function pct(v: number | null | undefined): string {
  if (v == null) return '   n/a';
  return v.toFixed(1) + '%';
}

function signedPct(v: number | null | undefined): string {
  if (v == null) return '   n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderApprovedPriorityStudy(r: ApprovedPriorityStudyResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — BUBBLEMAPS APPROVED CANDIDATE PRIORITY STUDY v1');
  L.push('  [REPORT ONLY — READ ONLY — PAPER ONLY — NO MUTATION — NO GATE/POLICY/FILTER CHANGE]');
  L.push('  Simulates spending a limited holder-risk call budget on BUY_APPROVED_PAPER first.');
  L.push('  Does NOT call BubbleMaps. Does NOT change behavior. UNKNOWN is NEVER treated as CLEAN.');
  L.push(SEP, '');

  // §1 — Overview
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Generated at              : ${r.generatedAt}`);
  L.push(`  Latest cycle file         : ${r.latestCycleFile ?? '(none)'}`);
  L.push(`  Total cycle files scanned : ${r.totalCycleFiles}`);
  L.push(`  Total cycle rows scanned  : ${r.totalCycleRowsScanned}`);
  L.push(`  Total memory rows scanned : ${r.totalMemoryRowsScanned}`);
  L.push(`  Assumed per-cycle cap     : ${r.assumedCapUsed} (study assumption only — enables nothing)`);
  L.push(`  High-level diagnosis      : ${r.diagnoses[0] ?? '(none)'}`);
  L.push('');

  // §2 — Current approved vs rejected holder coverage
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — CURRENT APPROVED vs REJECTED HOLDER COVERAGE');
  L.push(`  ${SEP2}`, '');
  for (const cov of [r.coverageAll, r.coverageRecent]) {
    L.push(`  ── ${cov.scope} ──`);
    L.push(`  Approved total            : ${cov.approvedTotal}`);
    L.push(`  Approved UNKNOWN          : ${cov.approvedUnknown}  (${pct(cov.approvedUnknownPct)} UNKNOWN)`);
    L.push(`  Approved known coverage   : ${pct(cov.approvedKnownCoveragePct)}`);
    L.push(`  Rejected total            : ${cov.rejectedTotal}`);
    L.push(`  Rejected UNKNOWN          : ${cov.rejectedUnknown}  (${pct(cov.rejectedUnknownPct)} UNKNOWN)`);
    L.push(`  Rejected known coverage   : ${pct(cov.rejectedKnownCoveragePct)}`);
    L.push(`  M5 approved UNKNOWN       : ${cov.m5ApprovedUnknown}`);
    L.push(`  M5 rejected UNKNOWN       : ${cov.m5RejectedUnknown}`);
    const gap = cov.approvedUnknownPct != null && cov.rejectedUnknownPct != null
      ? cov.approvedUnknownPct - cov.rejectedUnknownPct : null;
    L.push(`  Approved-minus-rejected UNKNOWN gap: ${signedPct(gap)} ` +
           `${gap != null && gap > 0 ? '(approved WORSE covered)' : ''}`);
    L.push('');
  }

  // §3 — BubbleMaps disabled / cap pressure
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — BUBBLEMAPS DISABLED / CAP PRESSURE (recent window)');
  L.push(`  ${SEP2}`, '');
  const u = r.bubbleMapsUsage;
  L.push(`  Recent cycles scanned        : ${u.recentCyclesScanned}`);
  L.push(`  Live BubbleMaps calls used   : ${u.liveCallsUsed}`);
  L.push(`  Cache hits                   : ${u.cacheHits}`);
  L.push(`  Cap-skipped rows             : ${u.capSkippedRows}`);
  L.push(`  BubbleMaps disabled cycles   : ${u.bubbleMapsDisabledCycles}`);
  L.push(`  Estimated call cap           : ${u.estimatedCallCap ?? '(none recorded)'}`);
  L.push(`  Approved rows needing calls  : ${u.approvedRowsNeedingCalls}`);
  L.push(`  Rejected rows needing calls  : ${u.rejectedRowsNeedingCalls}`);
  L.push('');
  L.push(`  ${u.note}`);
  L.push('');

  // §4 — Simulated approved-first allocation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — SIMULATED APPROVED-FIRST ALLOCATION (REPORT ONLY)');
  L.push(`  ${SEP2}`, '');
  L.push('  Priority order: 1) approved+M5  2) approved  3) rejected+M5  4) rejected');
  L.push('');
  for (const sim of [r.observedSimulation, r.hypotheticalSimulation]) {
    L.push(`  ── ${sim.label} ──`);
    L.push(`  Cap model                    : ${sim.perCycleCapModel}`);
    L.push(`  Cycles simulated             : ${sim.cyclesSimulated}  (zero-budget: ${sim.cyclesWithZeroCap})`);
    L.push(`  Total call budget            : ${sim.totalCap}`);
    L.push(`  Approved UNKNOWN demand      : ${sim.approvedUnknownDemand}`);
    L.push(`  Rejected UNKNOWN demand      : ${sim.rejectedUnknownDemand}`);
    L.push(`  Approved covered FIRST       : ${sim.approvedCoveredFirst}  (of which M5: ${sim.approvedM5CoveredFirst})`);
    L.push(`  Rejected deferred            : ${sim.rejectedDeferred}`);
    L.push(`  Approved still uncovered     : ${sim.approvedStillUncovered}`);
    L.push(`  Proportional baseline (appr) : ${sim.baselineApprovedCovered}`);
    L.push(`  Approved coverage gain (rows): ${sim.approvedCoverageImprovementRows >= 0 ? '+' : ''}${sim.approvedCoverageImprovementRows}`);
    L.push(`  Current approved coverage    : ${pct(sim.currentApprovedCoveragePct)}`);
    L.push(`  Projected approved coverage  : ${pct(sim.projectedApprovedCoveragePct)}`);
    L.push(`  Approved coverage improvement: ${signedPct(sim.approvedCoverageImprovementPct)}`);
    L.push(`  ${sim.note}`);
    L.push('');
  }

  // §5 — M5-specific impact
  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — M5-SPECIFIC IMPACT');
  L.push(`  ${SEP2}`, '');
  L.push(`  M5 approved UNKNOWN (all)     : ${r.coverageAll.m5ApprovedUnknown}`);
  L.push(`  M5 rejected UNKNOWN (all)     : ${r.coverageAll.m5RejectedUnknown}`);
  L.push(`  M5 approved covered first     : ${r.hypotheticalSimulation.approvedM5CoveredFirst} ` +
         `(tier-1, hypothetical-enabled)`);
  L.push('  Approved+M5 rows are priority tier 1 — they would be holder-covered before any');
  L.push('  non-M5 approved row and before every rejected row. STUDY ONLY.');
  L.push('');
  if (r.topPriorityCandidates.length > 0) {
    L.push(`  Top ${r.topPriorityCandidates.length} priority candidates (approved+M5 lead):`);
    L.push(`    ${'tier'.padStart(4)} ${'symbol'.padEnd(12)} ${'contract'.padEnd(18)} ${'gate'.padEnd(18)} ${'m5'.padEnd(4)} cycle`);
    for (const c of r.topPriorityCandidates) {
      L.push(
        `    ${String(c.priorityTier).padStart(4)} ` +
        `${(c.symbol ?? 'unknown').slice(0, 11).padEnd(12)} ` +
        `${c.contractPrefix.padEnd(18)} ` +
        `${c.gate.padEnd(18)} ` +
        `${(c.hasM5 ? 'yes' : 'no').padEnd(4)} ` +
        `${c.cycleFile}`,
      );
    }
  } else {
    L.push('  (no UNKNOWN approved/rejected candidates found)');
  }
  L.push('');

  // §6 — What priority would NOT fix
  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — WHAT PRIORITY WOULD NOT FIX');
  L.push(`  ${SEP2}`, '');
  for (const item of r.whatPriorityWouldNotFix) L.push(`  • ${item}`);
  L.push('');

  // §7 — Diagnosis
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — DIAGNOSIS');
  L.push(`  ${SEP2}`, '');
  for (const d of r.diagnoses) {
    const neutral = d === 'STUDY_ONLY_NO_POLICY_CHANGE';
    L.push(`  ${neutral ? 'ℹ' : '⚠'} ${d}`);
  }
  L.push('');

  // §8 — Recommendation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — RECOMMENDATION (REPORT ONLY — NO BEHAVIOR CHANGE)');
  L.push(`  ${SEP2}`, '');
  for (const rec of r.recommendations) L.push(`  ${rec.startsWith('  ') ? rec : '• ' + rec}`);
  L.push('');
  L.push('  This report does NOT change behavior, gates, policy, or filters. No BubbleMaps call');
  L.push('  was made. No file was mutated. Nothing was re-enabled.');
  L.push('');

  // §9 — Safety
  L.push(`  ${SEP2}`);
  L.push('  SECTION 9 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true   READ_ONLY=true   PAPER_ONLY=true   NO_MUTATION=true');
  L.push('  NO_REAL_TRADING=true   NO_GATE_CHANGES=true   NO_POLICY_CHANGE=true   NO_FILTER_CHANGE=true');
  L.push('  NO_API_CALLS=true   NO_BUBBLEMAPS_CALL=true   NO_BUBBLEMAPS_RE_ENABLE=true');
  L.push('  NO_WALLET=true   NO_SWAP=true   NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING   tradingExecuted=0   realTradingLocked=true   behaviorChanged=false');
  L.push('  No data files mutated. No gates/policy/filters changed. UNKNOWN never treated as CLEAN.');
  L.push(SEP, '');

  return L.join('\n');
}
