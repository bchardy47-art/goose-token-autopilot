// Ripper Learning Memory v1 — paper/shadow-only, append-only learning evidence.
//
// SAFETY GUARANTEES (do not weaken):
//   * This module is REPORT_ONLY / READ_ONLY / APPEND_ONLY.
//   * It never calls trading-execution code, simulated-buy helpers, swap
//     primitives, or any wallet/signing module.
//   * It never modifies production gate logic or simulated-trade decision
//     policy.
//   * It never changes autopilot trading behavior. It only reads existing
//     evidence files (cycles, enrollments, observations, dex-watch-runs) and
//     appends a learning-memory.jsonl row per unique candidate observation.
//   * Every row carries explicit safety flags: reportOnly=true, readOnly=true,
//     paperOnly=true, realTradingLocked=true, tradingExecuted=0.

import * as fs from 'fs';
import * as path from 'path';
import { extractRipperContract, extractRipperPriceChangePct } from './ripperExtractors';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutcomeLabel =
  | 'BIG_WINNER'
  | 'WINNER'
  | 'SMALL_WINNER'
  | 'FLAT_JUNK'
  | 'DUMP'
  | 'UNKNOWN';

// Classifies which evidence universe each learning-memory row belongs to.
// Used by the summary report to keep policy-promotion math apples-to-apples
// with the shadow enrolled outcome report (SHADOW_ENROLLED_APPROVED only).
export type MemoryUniverse =
  | 'SHADOW_ENROLLED_APPROVED'    // BUY_APPROVED_PAPER + present in shadow-reject-filter-enrollments
  | 'PAPER_POLICY_TEST_APPROVED'  // BUY_APPROVED_PAPER + not in enrollment file
  | 'PAPER_INTENT_OBSERVED'       // BUY_APPROVED_PAPER + outcome source is paper-intent-observations
  | 'DEX_WATCH_GENERAL'           // non-approved, matched via dex-watch run (.json)
  | 'UNKNOWN_GENERAL';            // everything else (rejected, unmatched, etc.)

// Infers memoryUniverse from existing row fields — used for backward-compat
// deserialization of rows written before this field existed.
export function inferMemoryUniverse(r: {
  gateDecision?:  string | null;
  sourceFiles?:   string[];
  outcomeSource?: string | null;
}): MemoryUniverse {
  if (r.gateDecision === 'BUY_APPROVED_PAPER') {
    if (r.sourceFiles?.some(f => f.includes('shadow-reject-filter-enrollments'))) {
      return 'SHADOW_ENROLLED_APPROVED';
    }
    if (r.outcomeSource?.includes('paper-intent')) return 'PAPER_INTENT_OBSERVED';
    return 'PAPER_POLICY_TEST_APPROVED';
  }
  if (r.outcomeSource?.endsWith('.json')) return 'DEX_WATCH_GENERAL';
  return 'UNKNOWN_GENERAL';
}

export type LiquidityBucket =
  | 'LIQ_LT_10K'
  | 'LIQ_10K_30K'
  | 'LIQ_30K_100K'
  | 'LIQ_GTE_100K'
  | 'LIQ_UNKNOWN';

export type VlrBucket =
  | 'VLR_LT_0_5'
  | 'VLR_0_5_TO_2'
  | 'VLR_GTE_2'
  | 'VLR_UNKNOWN';

export type TimingPath = 'ENTER_NOW' | 'WAIT_10M' | null;

// ── Cluster UNKNOWN reason normalization ────────────────────────────────────────
// Canonical normalizer shared with the Cluster Coverage Audit. Classifies WHY a
// cluster lookup produced UNKNOWN from the row-level clusterNotes / clusterFetchError
// provenance. UNKNOWN is NEVER treated as CLEAN — these labels only describe the gap.

export const CLUSTER_UNKNOWN_REASONS = [
  'API_CAP_SKIPPED',
  'API_ERROR',
  'NOT_REQUESTED',
  'NOT_FOUND',
  'CACHE_MISS',
  'SCHEMA_MISSING',
  'UNKNOWN_REASON_NOT_RECORDED',
  'MIXED_OR_UNCLEAR',
] as const;
export type ClusterUnknownReason = (typeof CLUSTER_UNKNOWN_REASONS)[number];

// Pure classifier — given the notes/fetchError provenance, returns the normalized
// reason. Empty/absent provenance → UNKNOWN_REASON_NOT_RECORDED. Multiple distinct
// categories on the same row → MIXED_OR_UNCLEAR. Never invents a reason.
export function classifyClusterUnknownReason(
  clusterNotes: string[] | string | null | undefined,
  clusterFetchError: string | null | undefined,
): ClusterUnknownReason {
  const notes = Array.isArray(clusterNotes)
    ? clusterNotes.map(n => String(n))
    : (typeof clusterNotes === 'string' && clusterNotes.trim() ? [clusterNotes] : []);
  const fetchError = typeof clusterFetchError === 'string' ? clusterFetchError.trim() : '';
  const blob = notes.join(' | ').toLowerCase();
  const matched = new Set<ClusterUnknownReason>();

  if (/disabled|not requested|no live calls/.test(blob))        matched.add('NOT_REQUESTED');
  if (/per-run cap|cap of \d+|cap reached/.test(blob))          matched.add('API_CAP_SKIPPED');
  if (/http \d|429|timeout|fetch error|error/.test(blob) || fetchError !== '') matched.add('API_ERROR');
  if (/cache miss|not cached/.test(blob))                       matched.add('CACHE_MISS');
  if (/not found|no data|404|unknown token/.test(blob))         matched.add('NOT_FOUND');
  if (/schema|missing field|malformed/.test(blob))              matched.add('SCHEMA_MISSING');

  if (matched.size === 0) {
    return notes.length === 0 ? 'UNKNOWN_REASON_NOT_RECORDED' : 'MIXED_OR_UNCLEAR';
  }
  if (matched.size === 1) return [...matched][0];
  return 'MIXED_OR_UNCLEAR';
}

export interface LearningMemoryRow {
  contract:              string;
  cycleId:               string;
  capturedAt:            string;
  observedAt:            string | null;
  outcomeSource:         string | null;
  gateDecision:          string | null;
  clusterRisk:           string | null;
  // ── Cluster provenance / UNKNOWN reason (carried forward from cycle rows) ──────
  // All optional so older memory rows written before this field existed still load.
  clusterProvider?:      string | null;
  clusterConfidence?:    string | number | null;
  clusterNotes?:         string[] | string | null;
  clusterUnknownReason?: ClusterUnknownReason | string | null;
  clusterFetchError?:    string | null;
  ripperScore:           number | null;
  launchAgeBucket:       string | null;
  ageMinutes:            number | null;
  liquidityUsd:          number | null;
  liquidityBucket:       LiquidityBucket;
  bubbleMapsScore:       number | null;
  vlrBucket:             VlrBucket;
  entryDecision:         string | null;
  entryMomentumPct?:     number | null;
  timingPath:            TimingPath;
  priceChangePct:        number | null;
  outcomeLabel:          OutcomeLabel;
  memoryUniverse:        MemoryUniverse;
  wouldRejectByLiqOrAge: boolean;
  blockedByLowLiquidity: boolean;
  blockedByAgeGte10m:    boolean;
  sourceFiles:           string[];
  reportOnly:            true;
  readOnly:              true;
  paperOnly:             true;
  realTradingLocked:     true;
  tradingExecuted:       0;
}

export interface LearningMemoryResult {
  cycleFilesRead:     number;
  observationsRead:   number;
  enrollmentsRead:    number;
  paperIntentObsRead: number;
  dexWatchRunsRead:   number;
  candidatesProcessed:number;
  rowsAppended:       number;
  duplicatesSkipped:  number;
  observedRows:       number;
  unknownRows:        number;
  blockedByLiqOrAge:  number;
  outPath:            string;
  reportOnly:         true;
  readOnly:           true;
  paperOnly:          true;
  realTradingLocked:  true;
  tradingExecuted:    0;
}

export interface LearningMemoryOptions {
  cyclesDir?:            string;
  enrollmentsPath?:      string;
  paperIntentsPath?:     string;   // for targetEntryAt timing on enrolled rows
  paperIntentObsPath?:   string;
  observationsDir?:      string;
  dexWatchRunsDir?:      string;
  outPath:               string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJsonlLines(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  const text = fs.readFileSync(file, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as Record<string, unknown>); }
    catch { /* skip malformed */ }
  }
  return out;
}

function listFilesIn(dir: string, predicate: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(predicate).sort().map(n => path.join(dir, n));
}

// Dedup key uses capturedAt (stable), not observedAt, so re-runs with corrected
// observation timing (targetEntryAt-based) don't create duplicate rows.
function candidateKey(contract: string, cycleId: string, capturedAt: string): string {
  return `${contract}::${cycleId}::${capturedAt}`;
}

function readExistingKeys(outPath: string): Set<string> {
  const keys = new Set<string>();
  if (!fs.existsSync(outPath)) return keys;
  for (const r of readJsonlLines(outPath)) {
    const contract   = typeof r['contract']   === 'string' ? r['contract']   as string : null;
    const cycleId    = typeof r['cycleId']    === 'string' ? r['cycleId']    as string : null;
    const capturedAt = typeof r['capturedAt'] === 'string' ? r['capturedAt'] as string : null;
    if (!contract || !cycleId || !capturedAt) continue;
    keys.add(candidateKey(contract, cycleId, capturedAt));
  }
  return keys;
}

// Builds contract::sourceCycle → targetEntryAt index from paper-intents.jsonl.
// Used so SHADOW_ENROLLED_APPROVED rows use the paper-intent observation window
// (after targetEntryAt) instead of capturedAt, matching the shadow enrolled report.
function buildPaperIntentTargetIndex(paperIntentsPath: string | undefined): Map<string, string> {
  const index = new Map<string, string>();
  if (!paperIntentsPath || !fs.existsSync(paperIntentsPath)) return index;
  for (const r of readJsonlLines(paperIntentsPath)) {
    const contract    = typeof r['contract']      === 'string' ? r['contract']      as string : null;
    const sourceCycle = typeof r['sourceCycle']   === 'string' ? r['sourceCycle']   as string : null;
    const targetAt    = typeof r['targetEntryAt'] === 'string' ? r['targetEntryAt'] as string : null;
    if (!contract || !sourceCycle || !targetAt) continue;
    const key = `${contract}::${sourceCycle}`;
    if (!index.has(key)) index.set(key, targetAt);
  }
  return index;
}

export function classifyOutcome(priceChangePct: number | null | undefined): OutcomeLabel {
  if (priceChangePct == null || !Number.isFinite(priceChangePct)) return 'UNKNOWN';
  if (priceChangePct >= 5)  return 'BIG_WINNER';
  if (priceChangePct >= 3)  return 'WINNER';
  if (priceChangePct >= 1)  return 'SMALL_WINNER';
  if (priceChangePct > -1)  return 'FLAT_JUNK';
  return 'DUMP';
}

export function bucketLiquidity(liquidityUsd: number | null): LiquidityBucket {
  if (liquidityUsd == null || !Number.isFinite(liquidityUsd)) return 'LIQ_UNKNOWN';
  if (liquidityUsd < 10_000)  return 'LIQ_LT_10K';
  if (liquidityUsd < 30_000)  return 'LIQ_10K_30K';
  if (liquidityUsd < 100_000) return 'LIQ_30K_100K';
  return 'LIQ_GTE_100K';
}

export function bucketVlr(vlr: number | null): VlrBucket {
  if (vlr == null || !Number.isFinite(vlr)) return 'VLR_UNKNOWN';
  if (vlr < 0.5) return 'VLR_LT_0_5';
  if (vlr < 2)   return 'VLR_0_5_TO_2';
  return 'VLR_GTE_2';
}

function cycleIdFromFile(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, '');
}

function extractBubbleMapsScore(raw: Record<string, unknown> | undefined): number | null {
  if (!raw) return null;
  const notes = raw['clusterNotes'];
  if (Array.isArray(notes)) {
    for (const n of notes) {
      if (typeof n === 'string') {
        const m = n.match(/bubbleMapsScore\s+([\-0-9.]+)/i);
        if (m) {
          const v = Number(m[1]);
          if (Number.isFinite(v)) return v;
        }
      }
    }
  }
  const direct = raw['bubbleMapsScore'];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  return null;
}

// Carries cluster provenance forward from a cycle row's raw/ripperInput blocks.
// Returns null for any field not present (backward/forward compatible). Computes
// clusterUnknownReason ONLY when clusterRisk is UNKNOWN — never for CLEAN/WATCH/RISKY.
interface ClusterProvenance {
  clusterProvider:      string | null;
  clusterConfidence:    string | number | null;
  clusterNotes:         string[] | null;
  clusterFetchError:    string | null;
  clusterUnknownReason: ClusterUnknownReason | null;
}

function extractClusterProvenance(
  raw: Record<string, unknown> | undefined,
  ripperInput: Record<string, unknown> | undefined,
  clusterRisk: string | null,
): ClusterProvenance {
  const provider =
    typeof raw?.['clusterProvider']         === 'string' ? raw!['clusterProvider']         as string :
    typeof ripperInput?.['clusterProvider'] === 'string' ? ripperInput!['clusterProvider'] as string : null;

  const confRaw = raw?.['clusterConfidence'] ?? ripperInput?.['clusterConfidence'];
  const confidence =
    typeof confRaw === 'string' ? confRaw :
    (typeof confRaw === 'number' && Number.isFinite(confRaw)) ? confRaw : null;

  const notesRaw = raw?.['clusterNotes'] ?? ripperInput?.['clusterNotes'];
  const notes = Array.isArray(notesRaw)
    ? notesRaw.filter((n): n is string => typeof n === 'string')
    : (typeof notesRaw === 'string' && notesRaw.trim() ? [notesRaw] : null);

  const feRaw = raw?.['clusterFetchError'] ?? ripperInput?.['clusterFetchError'];
  const fetchError = typeof feRaw === 'string' && feRaw.trim() ? feRaw : null;

  const clusterUnknownReason = clusterRisk === 'UNKNOWN'
    ? classifyClusterUnknownReason(notes, fetchError)
    : null;

  return {
    clusterProvider:   provider,
    clusterConfidence: confidence,
    clusterNotes:      notes,
    clusterFetchError: fetchError,
    clusterUnknownReason,
  };
}

function extractVlr(ns: Record<string, unknown> | undefined, raw: Record<string, unknown> | undefined): number | null {
  const candidates = [
    ns?.['volumeLiquidityRatio'],
    ns?.['volumeToLiquidityRatio'],
    raw?.['volumeLiquidityRatio'],
    raw?.['volumeToLiquidityRatio'],
  ];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function timingPathFromAge(ageMinutes: number | null): TimingPath {
  if (ageMinutes == null) return null;
  if (ageMinutes >= 10) return 'WAIT_10M';
  return 'ENTER_NOW';
}

// ── Indexes ───────────────────────────────────────────────────────────────────

interface EnrollmentIndexEntry {
  age_gte10m:  boolean;
  liq_lt10k:   boolean;
  liq_OR_age:  boolean;
  sourceFile:  string;
}

function buildEnrollmentIndex(enrollmentsPath: string | undefined): {
  index: Map<string, EnrollmentIndexEntry>;
  count: number;
  sourceFile: string | null;
} {
  const index = new Map<string, EnrollmentIndexEntry>();
  if (!enrollmentsPath || !fs.existsSync(enrollmentsPath)) {
    return { index, count: 0, sourceFile: null };
  }
  const rows = readJsonlLines(enrollmentsPath);
  for (const r of rows) {
    const contract = typeof r['contract'] === 'string' ? r['contract'] as string : null;
    const cycleFile = typeof r['cycleFile'] === 'string' ? r['cycleFile'] as string : null;
    const capturedAt = typeof r['capturedAt'] === 'string' ? r['capturedAt'] as string : null;
    if (!contract || !cycleFile || !capturedAt) continue;
    const cycleId = cycleFile.replace(/\.jsonl$/, '');
    const flags = r['shadowRejectFlags'] as Record<string, unknown> | undefined;
    index.set(`${contract}::${cycleId}::${capturedAt}`, {
      age_gte10m: flags?.['age_gte10m'] === true,
      liq_lt10k:  flags?.['liq_lt10k']  === true,
      liq_OR_age: flags?.['liq_OR_age'] === true,
      sourceFile: path.basename(enrollmentsPath),
    });
  }
  return { index, count: rows.length, sourceFile: path.basename(enrollmentsPath) };
}

interface ObservationOutcome {
  observedAt:     string;
  priceChangePct: number | null;
  outcomeSource:  string;
}

function buildObservationIndex(observationsDir: string | undefined): {
  byContract: Map<string, ObservationOutcome[]>;
  count: number;
  files: string[];
} {
  const byContract = new Map<string, ObservationOutcome[]>();
  const files: string[] = [];
  let totalRows = 0;
  if (!observationsDir || !fs.existsSync(observationsDir)) {
    return { byContract, count: 0, files };
  }
  const obsFiles = listFilesIn(observationsDir, n =>
    n.startsWith('obs-') && n.endsWith('.jsonl'),
  );
  for (const file of obsFiles) {
    files.push(path.basename(file));
    const rows = readJsonlLines(file);
    totalRows += rows.length;
    for (const r of rows) {
      const contract = extractRipperContract(r);
      if (!contract) continue;
      const observedAt =
        typeof r['capturedAt'] === 'string' ? r['capturedAt'] as string : null;
      const priceChangePct = extractRipperPriceChangePct(r);
      if (!observedAt) continue;
      const list = byContract.get(contract) ?? [];
      list.push({
        observedAt,
        priceChangePct,
        outcomeSource: path.basename(file),
      });
      byContract.set(contract, list);
    }
  }
  for (const list of byContract.values()) {
    list.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }
  return { byContract, count: totalRows, files };
}

interface PaperIntentOutcome {
  observedAt:     string;
  priceChangePct: number | null;
  outcomeSource:  string;
}

function buildPaperIntentIndex(paperIntentObsPath: string | undefined): {
  byContract: Map<string, PaperIntentOutcome[]>;
  count: number;
  sourceFile: string | null;
} {
  const byContract = new Map<string, PaperIntentOutcome[]>();
  if (!paperIntentObsPath || !fs.existsSync(paperIntentObsPath)) {
    return { byContract, count: 0, sourceFile: null };
  }
  const rows = readJsonlLines(paperIntentObsPath);
  const baseName = path.basename(paperIntentObsPath);
  for (const r of rows) {
    const contract = extractRipperContract(r);
    const observedAt = typeof r['capturedAt'] === 'string' ? r['capturedAt'] as string : null;
    const priceChangePct = extractRipperPriceChangePct(r);
    if (!contract || !observedAt) continue;
    const list = byContract.get(contract) ?? [];
    list.push({ observedAt, priceChangePct, outcomeSource: baseName });
    byContract.set(contract, list);
  }
  for (const list of byContract.values()) {
    list.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }
  return { byContract, count: rows.length, sourceFile: baseName };
}

interface DexWatchOutcome {
  observedAt:     string;
  priceChangePct: number | null;
  outcomeSource:  string;
}

function buildDexWatchIndex(dexWatchRunsDir: string | undefined): {
  byContract: Map<string, DexWatchOutcome[]>;
  count: number;
  files: string[];
} {
  const byContract = new Map<string, DexWatchOutcome[]>();
  const files: string[] = [];
  let total = 0;
  if (!dexWatchRunsDir || !fs.existsSync(dexWatchRunsDir)) {
    return { byContract, count: 0, files };
  }
  const runFiles = listFilesIn(dexWatchRunsDir, n => n.startsWith('run-') && n.endsWith('.json'));
  for (const file of runFiles) {
    files.push(path.basename(file));
    let payload: Record<string, unknown> | null = null;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>; }
    catch { continue; }
    if (!payload) continue;
    const baseName = path.basename(file);
    const buckets: unknown[] = [];
    for (const k of ['winners', 'losers', 'movers', 'all']) {
      const v = payload[k];
      if (Array.isArray(v)) buckets.push(...v);
    }
    for (const item of buckets) {
      if (typeof item !== 'object' || item == null) continue;
      const obj = item as Record<string, unknown>;
      const contract = typeof obj['contract'] === 'string' ? obj['contract'] as string : null;
      const final = obj['final'] as Record<string, unknown> | undefined;
      const observedAt =
        typeof final?.['observedAt'] === 'string'
          ? final['observedAt'] as string
          : typeof obj['observedAt'] === 'string' ? obj['observedAt'] as string : null;
      const pct = typeof obj['priceChangePct'] === 'number' ? obj['priceChangePct'] as number : null;
      if (!contract || !observedAt) continue;
      const list = byContract.get(contract) ?? [];
      list.push({ observedAt, priceChangePct: pct, outcomeSource: baseName });
      byContract.set(contract, list);
      total++;
    }
  }
  for (const list of byContract.values()) {
    list.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }
  return { byContract, count: total, files };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperLearningMemory(options: LearningMemoryOptions): LearningMemoryResult {
  // SAFETY: read evidence files only. No trading code paths are invoked.
  const cyclesDir       = options.cyclesDir       ?? 'data/token-grab/ripper/cycles';
  const enrollmentsPath = options.enrollmentsPath ?? 'data/token-grab/ripper/shadow-reject-filter-enrollments.jsonl';
  const paperIntentPath = options.paperIntentObsPath ?? 'data/token-grab/ripper/paper-intent-observations.jsonl';
  const observationsDir = options.observationsDir ?? 'data/token-grab/ripper/observations';
  const dexWatchRunsDir = options.dexWatchRunsDir ?? 'data/token-grab/dex-watch-runs';
  const outPath         = options.outPath;

  const cycleFiles = listFilesIn(cyclesDir, n =>
    n.startsWith('cycle-') && n.endsWith('.jsonl'),
  );

  const enrollment       = buildEnrollmentIndex(enrollmentsPath);
  const paperIntentTgt   = buildPaperIntentTargetIndex(options.paperIntentsPath ?? 'data/token-grab/ripper/paper-intents.jsonl');
  const obsIndex         = buildObservationIndex(observationsDir);
  const paperIdx         = buildPaperIntentIndex(paperIntentPath);
  const dexIdx           = buildDexWatchIndex(dexWatchRunsDir);

  const existingKeys = readExistingKeys(outPath);

  let candidatesProcessed = 0;
  let duplicatesSkipped   = 0;
  let observedRows        = 0;
  let unknownRows         = 0;
  let blockedByLiqOrAge   = 0;
  const newRows: LearningMemoryRow[] = [];

  for (const cyclePath of cycleFiles) {
    const cycleId   = cycleIdFromFile(cyclePath);
    const cycleFile = path.basename(cyclePath);
    const rows      = readJsonlLines(cyclePath);

    for (const f of rows) {
      const contract = extractRipperContract(f);
      const capturedAt = typeof f['capturedAt'] === 'string' ? f['capturedAt'] as string : null;
      if (!contract || !capturedAt) continue;

      candidatesProcessed++;

      const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
      const raw = f['raw']             as Record<string, unknown> | undefined;

      const gateDecision    = typeof f['buyGateDecision']  === 'string' ? f['buyGateDecision']  as string : null;
      const ripperScore     = typeof f['ripperScore']      === 'number' ? f['ripperScore']      as number : null;
      const launchAgeBucket = typeof f['launchAgeBucket']  === 'string' ? f['launchAgeBucket']  as string : null;
      const ageMinutes      = typeof f['ageMinutes']       === 'number' ? f['ageMinutes']       as number : null;
      const entryDecision   = typeof f['entryDecision']    === 'string' ? f['entryDecision']    as string : null;
      // Normalize entryMomentumPct — accept both field names for robustness
      const m5v = f['entryMomentumPct'] ?? f['entryPriceChangeM5'];
      const entryMomentumPct = (typeof m5v === 'number' && Number.isFinite(m5v)) ? m5v : null;
      const ripperInput = f['ripperInput'] as Record<string, unknown> | undefined;
      const clusterRisk     =
        typeof raw?.['clusterRisk'] === 'string' ? raw['clusterRisk'] as string :
        typeof ripperInput?.['clusterRisk'] === 'string' ? ripperInput['clusterRisk'] as string :
        typeof f['clusterRisk']    === 'string' ? f['clusterRisk']    as string : null;
      // Carry cluster provenance + normalized UNKNOWN reason forward from the cycle row.
      const clusterProvenance = extractClusterProvenance(raw, ripperInput, clusterRisk);
      const liquidityUsd    =
        typeof ns?.['liquidityUsd'] === 'number' ? ns['liquidityUsd'] as number :
        typeof raw?.['liquidityUsd'] === 'number' ? raw['liquidityUsd'] as number : null;
      const bubbleMapsScore = extractBubbleMapsScore(raw);
      const vlr             = extractVlr(ns, raw);
      const vlrBucket       = bucketVlr(vlr);

      // ── Enrollment lookup (done before observation matching) ──────────────────
      const enrollKey = `${contract}::${cycleId}::${capturedAt}`;
      const enroll    = enrollment.index.get(enrollKey);
      const liqLt10k  = enroll ? enroll.liq_lt10k  : (liquidityUsd != null && liquidityUsd < 10_000);
      const ageGte10m = enroll ? enroll.age_gte10m : (ageMinutes   != null && ageMinutes   >= 10);
      const liqOrAge  = enroll ? enroll.liq_OR_age : (liqLt10k || ageGte10m);

      // For enrolled rows, use targetEntryAt from paper-intents as the observation
      // floor so stats align with ripperShadowEnrolledOutcomeReport timing.
      // Non-enrolled rows fall back to capturedAt (original behavior).
      const intentKey     = `${contract}::${cycleId}`;
      const targetEntryAt = enroll ? (paperIntentTgt.get(intentKey) ?? null) : null;
      const obsFloorMs    = new Date(targetEntryAt ?? capturedAt).getTime();

      // ── Outcome lookup: prefer paper-intent then observations then dex-watch ──
      const candidates: { observedAt: string; priceChangePct: number | null; outcomeSource: string }[] = [];
      const paperOutcomes = paperIdx.byContract.get(contract);
      if (paperOutcomes) candidates.push(...paperOutcomes);
      const obsOutcomes = obsIndex.byContract.get(contract);
      if (obsOutcomes) candidates.push(...obsOutcomes);
      const dexOutcomes = dexIdx.byContract.get(contract);
      if (dexOutcomes) candidates.push(...dexOutcomes);

      const future = candidates
        .filter(c => new Date(c.observedAt).getTime() >= obsFloorMs)
        .sort((a, b) =>
          new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime(),
        );
      // For enrolled rows, only use observations after the floor (targetEntryAt or capturedAt).
      // Do NOT fall back to pre-floor observations — mark as UNKNOWN instead, so stats
      // align with the shadow enrolled outcome report's timing window.
      const matched = future[0]
        ?? (enroll
          ? null  // enrolled: no fallback to pre-floor obs
          : candidates.sort((a, b) =>
              new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime(),
            )[0]
            ?? null);

      const observedAt     = matched?.observedAt ?? null;
      const outcomeSource  = matched?.outcomeSource ?? null;
      const priceChangePct = matched?.priceChangePct ?? null;
      const outcomeLabel   = classifyOutcome(priceChangePct);

      // Stable dedup key uses capturedAt (not observedAt) so re-runs with
      // corrected observation timing don't create duplicates.
      const key = candidateKey(contract, cycleId, capturedAt);
      if (existingKeys.has(key)) { duplicatesSkipped++; continue; }
      existingKeys.add(key);

      if (liqOrAge) blockedByLiqOrAge++;
      if (outcomeLabel === 'UNKNOWN') unknownRows++;
      else observedRows++;

      const sourceFiles = [cycleFile];
      if (enroll) sourceFiles.push(enroll.sourceFile);
      if (outcomeSource) sourceFiles.push(outcomeSource);

      const dedupeSourceFiles = Array.from(new Set(sourceFiles));
      const memoryUniverse = inferMemoryUniverse({
        gateDecision,
        sourceFiles: dedupeSourceFiles,
        outcomeSource,
      });

      const row: LearningMemoryRow = {
        contract,
        cycleId,
        capturedAt,
        observedAt,
        outcomeSource,
        gateDecision,
        clusterRisk,
        clusterProvider:       clusterProvenance.clusterProvider,
        clusterConfidence:     clusterProvenance.clusterConfidence,
        clusterNotes:          clusterProvenance.clusterNotes,
        clusterUnknownReason:  clusterProvenance.clusterUnknownReason,
        clusterFetchError:     clusterProvenance.clusterFetchError,
        ripperScore,
        launchAgeBucket,
        ageMinutes,
        liquidityUsd,
        liquidityBucket:       bucketLiquidity(liquidityUsd),
        bubbleMapsScore,
        vlrBucket,
        entryDecision,
        entryMomentumPct,
        timingPath:            timingPathFromAge(ageMinutes),
        priceChangePct,
        outcomeLabel,
        memoryUniverse,
        wouldRejectByLiqOrAge: liqOrAge,
        blockedByLowLiquidity: liqLt10k,
        blockedByAgeGte10m:    ageGte10m,
        sourceFiles:           dedupeSourceFiles,
        reportOnly:            true,
        readOnly:              true,
        paperOnly:             true,
        realTradingLocked:     true,
        tradingExecuted:       0,
      };
      newRows.push(row);
    }
  }

  if (newRows.length > 0) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.appendFileSync(
      outPath,
      newRows.map(r => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
  }

  return {
    cycleFilesRead:     cycleFiles.length,
    observationsRead:   obsIndex.count,
    enrollmentsRead:    enrollment.count,
    paperIntentObsRead: paperIdx.count,
    dexWatchRunsRead:   dexIdx.count,
    candidatesProcessed,
    rowsAppended:       newRows.length,
    duplicatesSkipped,
    observedRows,
    unknownRows,
    blockedByLiqOrAge,
    outPath,
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperLearningMemoryResult(result: LearningMemoryResult): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER LEARNING MEMORY v1');
  lines.push('  [REPORT ONLY — READ-ONLY EVIDENCE — APPEND-ONLY MEMORY]');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING  |  NO_POLICY_CHANGE  |  PAPER_ONLY');
  lines.push(SEP, '');
  lines.push(`  ${SEP2}`);
  lines.push('  INPUTS READ');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  cycle files read              : ${result.cycleFilesRead}`);
  lines.push(`  observation rows read         : ${result.observationsRead}`);
  lines.push(`  enrollment rows read          : ${result.enrollmentsRead}`);
  lines.push(`  paper-intent obs rows read    : ${result.paperIntentObsRead}`);
  lines.push(`  dex-watch run rows read       : ${result.dexWatchRunsRead}`);
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  MEMORY APPEND RESULT');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  candidates processed          : ${result.candidatesProcessed}`);
  lines.push(`  rows appended                 : ${result.rowsAppended}`);
  lines.push(`  duplicates skipped            : ${result.duplicatesSkipped}`);
  lines.push(`  observed rows (in batch)      : ${result.observedRows}`);
  lines.push(`  unknown rows (in batch)       : ${result.unknownRows}`);
  lines.push(`  blocked by liq_OR_age         : ${result.blockedByLiqOrAge}`);
  lines.push('');
  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * No trade execution, no swap, no wallet/signing code.');
  lines.push('  * Production gate logic unchanged. Simulated-trade decision policy unchanged.');
  lines.push('  * Memory file is append-only learning evidence.');
  lines.push('  reportOnly=true  readOnly=true  paperOnly=true  realTradingLocked=true  tradingExecuted=0');
  lines.push('  HOLD_CURRENT_GATES  |  DO_NOT_ENABLE_REAL_TRADING  |  REPORT_ONLY  |  NO_POLICY_CHANGE');
  lines.push(`  Output: ${result.outPath}`);
  lines.push(SEP, '');
  return lines.join('\n');
}
