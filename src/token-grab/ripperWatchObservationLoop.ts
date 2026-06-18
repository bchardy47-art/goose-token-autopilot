// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE
//
// WATCH Observation Loop — enroll WATCH candidates from cycle files,
// record 2m/5m recheck snapshots (paper-only, no live API), classify.
// No gate, no trade, no policy change.

import * as fs from 'fs';
import * as path from 'path';

// ── Paths ─────────────────────────────────────────────────────────────────────

const DEFAULT_CYCLE_DIR      = 'data/token-grab/ripper/cycles';
const DEFAULT_LEDGER_PATH    = 'data/token-grab/ripper/watch-observations/watch-observation-ledger.jsonl';
const DEFAULT_SNAPSHOTS_PATH = 'data/token-grab/ripper/watch-observations/watch-observation-snapshots.jsonl';
const DEFAULT_REPORT_PATH    = 'data/token-grab/ripper/watch-observations/watch-observation-report.jsonl';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LedgerStatus =
  | 'PLANNED'
  | 'DUE_2M_CAPTURED'
  | 'DUE_5M_CAPTURED'
  | 'EXPIRED_NO_DATA'
  | 'COMPLETE';

export type SnapshotWindow = 'RECHECK_2M' | 'RECHECK_5M';

export type WatchClassification =
  | 'WATCH_CONFIRMED_RIPPER'
  | 'WATCH_IMPROVING'
  | 'WATCH_DATA_GAP'
  | 'WATCH_FAKE_SPIKE'
  | 'WATCH_REJECT_OBSERVE_ONLY';

export type FinalRecommendation =
  | 'WATCH_OBSERVATION_KEEP_COLLECTING'
  | 'WATCH_OBSERVATION_READY_FOR_PAPER_REVIEW'
  | 'WATCH_OBSERVATION_TOO_MUCH_DATA_GAP';

export interface LedgerRow {
  contract:          string;
  cycleId:           string;
  capturedAt:        string;
  enrolledAt:        string;
  dueAt2m:           string;
  dueAt5m:           string;
  liquidityUsd:      number | null;
  liquidityBucket:   string | null;
  vlrBucket:         string | null;
  bubbleMapsScore:   number | null;
  clusterRisk:       string | null;
  ripperScore:       number | null;
  ageMinutes:        number | null;
  priceChangePct:    number | null;
  timingPath:        string | null;
  gateDecision:      string | null;
  status:            LedgerStatus;
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface SnapshotRow {
  contract:           string;
  originalCapturedAt: string;
  snapshotAt:         string;
  window:             SnapshotWindow;
  liquidityUsd:       number | null;
  liquidityBucket:    string | null;
  vlrBucket:          string | null;
  bubbleMapsScore:    number | null;
  clusterRisk:        string | null;
  ripperScore:        number | null;
  ageMinutes:         number | null;
  priceChangePct:     number | null;
  snapshotSource:     string;
  snapshotAvailable:  boolean;
  sourceFile:         string | null;
  minutesFromTarget:  number | null;
  reportOnly:         true;
  readOnly:           true;
  paperOnly:          true;
  realTradingLocked:  true;
  tradingExecuted:    0;
}

export interface ClassifiedCandidate {
  contract:           string;
  capturedAt:         string;
  classification:     WatchClassification;
  classificationNote: string;
  snap2mAvailable:    boolean;
  snap5mAvailable:    boolean;
  originalLiqBucket:  string | null;
  originalVlrBucket:  string | null;
  originalCluster:    string | null;
  originalPrice:      number | null;
  price2m:            number | null;
  price5m:            number | null;
}

export interface WatchObservationEnrollResult {
  cycleFile:         string | null;
  totalCycleRows:    number;
  watchRows:         number;
  newEnrollments:    number;
  duplicatesSkipped: number;
  totalLedgerRows:   number;
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface WatchObservationCloseoutResult {
  ledgerRowsRead:    number;
  dueFor2m:          number;
  dueFor5m:          number;
  snapshotsWritten:  number;
  snapshotsSkipped:  number;
  ledgerRowsUpdated: number;
  sourceBreakdown:   Record<string, number>;
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface WatchObservationReportResult {
  totalEnrolled:        number;
  snap2mCaptured:       number;
  snap2mMissing:        number;
  snap5mCaptured:       number;
  snap5mMissing:        number;
  classifications:      Record<WatchClassification, number>;
  candidates:           ClassifiedCandidate[];
  strongestCandidates:  ClassifiedCandidate[];
  fakeSpikeExamples:    ClassifiedCandidate[];
  dataGapExamples:      ClassifiedCandidate[];
  recommendation:       FinalRecommendation;
  recommendationNote:   string;
  sourceBreakdown:      Record<string, number>;
  avgMinutesFromTarget: number | null;
  reportOnly:           true;
  readOnly:             true;
  paperOnly:            true;
  realTradingLocked:    true;
  tradingExecuted:      0;
}

export interface WatchObservationEnrollOptions {
  cycleDir?:   string;
  cycleFile?:  string;   // override: skip discovery, use this exact file
  ledgerPath?: string;
  nowMs?:      number;
}

export interface WatchObservationCloseoutOptions {
  ledgerPath?:         string;
  snapshotsPath?:      string;
  nowMs?:              number;
  ripperObsDir?:       string;
  dexWatchRunDir?:     string;
  paperIntentObsPath?: string;
  cycleDir?:           string;
}

export interface WatchObservationReportOptions {
  ledgerPath?:    string;
  snapshotsPath?: string;
  reportPath?:    string;
}

// ── Cycle row (flexible schema — top-level fields may also live in raw.*) ─────

interface CycleRow {
  id?:               string;
  capturedAt?:       string;
  contract?:         string;
  ripperScore?:      number | null;
  ageMinutes?:       number | null;
  launchAgeBucket?:  string | null;
  entryDecision?:    string | null;
  buyGateDecision?:  string | null;
  gateDecision?:     string | null;
  clusterRisk?:      string | null;
  liquidityUsd?:     number | null;
  liquidityBucket?:  string | null;
  vlrBucket?:        string | null;
  bubbleMapsScore?:  number | null;
  timingPath?:       string | null;
  priceChangePct?:   number | null;
  raw?: {
    contract?:        string;
    clusterRisk?:     string;
    liquidityUsd?:    number;
    liquidityBucket?: string;
    vlrBucket?:       string;
    bubbleMapsScore?: number;
    timingPath?:      string;
    priceChangePct?:  number;
    buyGateDecision?: string;
    gateDecision?:    string;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cycleStr(row: CycleRow, key: string): string | null {
  const top = (row as Record<string, unknown>)[key];
  if (top != null && top !== '') return String(top);
  const raw = (row.raw as Record<string, unknown> | undefined)?.[key];
  if (raw != null && raw !== '') return String(raw);
  return null;
}

function cycleNum(row: CycleRow, key: string): number | null {
  const top = (row as Record<string, unknown>)[key];
  if (typeof top === 'number') return top;
  const raw = (row.raw as Record<string, unknown> | undefined)?.[key];
  if (typeof raw === 'number') return raw;
  return null;
}

function getContract(row: CycleRow): string | null {
  return row.contract ?? row.raw?.contract ?? null;
}

function resolveTimingPath(ageMinutes: number | null): string | null {
  if (ageMinutes == null) return null;
  return ageMinutes < 10 ? 'ENTER_NOW' : 'WAIT_10M';
}

function findLatestCycleFile(cycleDir: string): string | null {
  if (!fs.existsSync(cycleDir)) return null;
  const files = fs.readdirSync(cycleDir)
    .filter(f => f.startsWith('cycle-') && f.endsWith('.jsonl'))
    .sort();
  return files.length > 0 ? path.join(cycleDir, files[files.length - 1]!) : null;
}

function readLedger(ledgerPath: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of readLines(ledgerPath)) {
    try {
      const r = JSON.parse(line) as LedgerRow;
      if (r.contract && r.capturedAt) rows.push(r);
    } catch { /* skip */ }
  }
  return rows;
}

const STATUS_ORDER: Record<LedgerStatus, number> = {
  PLANNED: 0, DUE_2M_CAPTURED: 1, DUE_5M_CAPTURED: 2, EXPIRED_NO_DATA: 3, COMPLETE: 4,
};

function mergeLedgerRows(rows: LedgerRow[]): LedgerRow[] {
  const merged = new Map<string, LedgerRow>();
  for (const row of rows) {
    const key = `${row.contract}::${row.capturedAt}`;
    const existing = merged.get(key);
    if (!existing || STATUS_ORDER[row.status] > STATUS_ORDER[existing.status]) {
      merged.set(key, row);
    }
  }
  return [...merged.values()];
}

function readSnapshots(snapshotsPath: string): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const line of readLines(snapshotsPath)) {
    try {
      const r = JSON.parse(line) as SnapshotRow;
      if (r.contract && r.originalCapturedAt) rows.push(r);
    } catch { /* skip */ }
  }
  return rows;
}

const SAFETY = {
  reportOnly:        true  as const,
  readOnly:          true  as const,
  paperOnly:         true  as const,
  realTradingLocked: true  as const,
  tradingExecuted:   0     as const,
};

// ── Snapshot source resolver ───────────────────────────────────────────────────

const DEFAULT_RIPPER_OBS_DIR        = 'data/token-grab/ripper/observations';
const DEFAULT_DEX_WATCH_RUN_DIR     = 'data/token-grab/dex-watch-runs';
const DEFAULT_PAPER_INTENT_OBS_PATH = 'data/token-grab/ripper/paper-intent-observations.jsonl';

const MAX_SKEW_MS = 15 * 60 * 1000;  // 15 minutes

function deriveLiqBucket(liqUsd: number | null): string {
  if (liqUsd == null || !Number.isFinite(liqUsd)) return 'LIQ_UNKNOWN';
  if (liqUsd < 10_000)  return 'LIQ_LT_10K';
  if (liqUsd < 30_000)  return 'LIQ_10K_30K';
  if (liqUsd < 100_000) return 'LIQ_30K_100K';
  return 'LIQ_GTE_100K';
}

function deriveVlrBucket(vlr: number | null): string {
  if (vlr == null || !Number.isFinite(vlr)) return 'VLR_UNKNOWN';
  if (vlr < 0.5) return 'VLR_LT_0_5';
  if (vlr < 2)   return 'VLR_0_5_TO_2';
  return 'VLR_GTE_2';
}

function parseBubbleMapsScore(clusterNotes: unknown): number | null {
  if (!Array.isArray(clusterNotes)) return null;
  for (const note of clusterNotes) {
    const m = String(note).match(/bubbleMapsScore\s+([\d.]+)/);
    if (m) return parseFloat(m[1]!);
  }
  return null;
}

// Filename timestamp parsers — used for pre-filtering files by proximity to target

function parseCycleFileMs(name: string): number | null {
  const m = name.match(/^cycle-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

function parseDexRunFileMs(name: string): number | null {
  const m = name.match(/^run-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

function parseObsFileMs(name: string): number | null {
  const m = name.match(/^(?:loose-extra-)?obs-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

interface SnapshotCandidate {
  capturedAtMs:    number;
  liquidityUsd:    number | null;
  liquidityBucket: string | null;
  vlrBucket:       string | null;
  bubbleMapsScore: number | null;
  clusterRisk:     string | null;
  ripperScore:     number | null;
  ageMinutes:      number | null;
  priceChangePct:  number | null;
  sourceTag:       string;
  sourceFile:      string;
}

function searchRipperObservations(
  contract: string,
  targetMs: number,
  obsDir: string,
): SnapshotCandidate | null {
  if (!fs.existsSync(obsDir)) return null;
  const files = fs.readdirSync(obsDir)
    .filter(f => f.endsWith('.jsonl'))
    .filter(f => {
      const fMs = parseObsFileMs(f);
      return fMs != null && Math.abs(fMs - targetMs) <= MAX_SKEW_MS;
    });

  let best: SnapshotCandidate | null = null;
  let bestSkew = Infinity;

  for (const fname of files) {
    for (const line of readLines(path.join(obsDir, fname))) {
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

      const ns = row.normalizedSignal as Record<string, unknown> | undefined;
      if ((ns?.contract as string | undefined) !== contract) continue;

      const capturedAt = row.capturedAt as string | undefined;
      if (!capturedAt) continue;
      const capturedAtMs = Date.parse(capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;

      const skew = Math.abs(capturedAtMs - targetMs);
      if (skew > MAX_SKEW_MS || skew >= bestSkew) continue;

      const liqUsd = ns?.liquidityUsd as number | null | undefined;
      const vlr    = ns?.volumeLiquidityRatio as number | null | undefined;
      const raw    = row.raw as Record<string, unknown> | undefined;

      bestSkew = skew;
      best = {
        capturedAtMs,
        liquidityUsd:    typeof liqUsd === 'number' ? liqUsd : null,
        liquidityBucket: deriveLiqBucket(typeof liqUsd === 'number' ? liqUsd : null),
        vlrBucket:       deriveVlrBucket(typeof vlr   === 'number' ? vlr   : null),
        bubbleMapsScore: parseBubbleMapsScore(raw?.clusterNotes),
        clusterRisk:     (raw?.clusterRisk as string | undefined) ?? null,
        ripperScore:     typeof row.ripperScore === 'number' ? row.ripperScore : null,
        ageMinutes:      typeof row.ageMinutes  === 'number' ? row.ageMinutes  : null,
        priceChangePct:  typeof ns?.priceChangePct === 'number' ? (ns.priceChangePct as number) : null,
        sourceTag:       'RIPPER_OBS',
        sourceFile:      fname,
      };
    }
  }
  return best;
}

function searchDexWatchRuns(
  contract: string,
  targetMs: number,
  runDir: string,
): SnapshotCandidate | null {
  if (!fs.existsSync(runDir)) return null;
  const files = fs.readdirSync(runDir)
    .filter(f => f.startsWith('run-') && f.endsWith('.json'))
    .filter(f => {
      const fMs = parseDexRunFileMs(f);
      return fMs != null && Math.abs(fMs - targetMs) <= MAX_SKEW_MS;
    });

  let best: SnapshotCandidate | null = null;
  let bestSkew = Infinity;

  for (const fname of files) {
    let runData: Record<string, unknown>;
    try { runData = JSON.parse(fs.readFileSync(path.join(runDir, fname), 'utf-8')) as Record<string, unknown>; } catch { continue; }

    const generatedAt = runData.generatedAt as string | undefined;
    const fileMs      = parseDexRunFileMs(fname)!;
    const fileTimeMs  = generatedAt ? (Date.parse(generatedAt) || fileMs) : fileMs;

    const arrays = [
      ...((runData.winners as unknown[]) ?? []),
      ...((runData.losers  as unknown[]) ?? []),
      ...((runData.flat    as unknown[]) ?? []),
    ];

    for (const item of arrays) {
      const rec = item as Record<string, unknown>;
      if (rec.contract !== contract) continue;

      const final = rec.final as Record<string, unknown> | undefined;
      const capturedAtMs = final?.observedAt
        ? (Date.parse(final.observedAt as string) || fileTimeMs)
        : fileTimeMs;

      const skew = Math.abs(capturedAtMs - targetMs);
      if (skew > MAX_SKEW_MS || skew >= bestSkew) continue;

      const entry  = rec.entry as Record<string, unknown> | undefined;
      const liqUsd = entry?.liquidityUsd as number | null | undefined;
      const vlr    = rec.volumeToLiquidityRatio as number | null | undefined;

      bestSkew = skew;
      best = {
        capturedAtMs,
        liquidityUsd:    typeof liqUsd === 'number' ? liqUsd : null,
        liquidityBucket: deriveLiqBucket(typeof liqUsd === 'number' ? liqUsd : null),
        vlrBucket:       deriveVlrBucket(typeof vlr    === 'number' ? vlr    : null),
        bubbleMapsScore: null,
        clusterRisk:     null,
        ripperScore:     null,
        ageMinutes:      null,
        priceChangePct:  typeof rec.priceChangePct === 'number' ? rec.priceChangePct : null,
        sourceTag:       'DEX_WATCH_RUN',
        sourceFile:      fname,
      };
    }
  }
  return best;
}

function searchPaperIntentObs(
  contract: string,
  targetMs: number,
  obsPath: string,
): SnapshotCandidate | null {
  if (!fs.existsSync(obsPath)) return null;

  let best: SnapshotCandidate | null = null;
  let bestSkew = Infinity;

  for (const line of readLines(obsPath)) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    const ns = row.normalizedSignal as Record<string, unknown> | undefined;
    const rowContract = (ns?.contract ?? (row.raw as Record<string, unknown> | undefined)?.contract) as string | undefined;
    if (rowContract !== contract) continue;

    const capturedAt = row.capturedAt as string | undefined;
    if (!capturedAt) continue;
    const capturedAtMs = Date.parse(capturedAt);
    if (!Number.isFinite(capturedAtMs)) continue;

    const skew = Math.abs(capturedAtMs - targetMs);
    if (skew > MAX_SKEW_MS || skew >= bestSkew) continue;

    bestSkew = skew;
    best = {
      capturedAtMs,
      liquidityUsd:    null,
      liquidityBucket: null,
      vlrBucket:       null,
      bubbleMapsScore: null,
      clusterRisk:     null,
      ripperScore:     null,
      ageMinutes:      null,
      priceChangePct:  typeof ns?.priceChangePct === 'number' ? (ns.priceChangePct as number) : null,
      sourceTag:       'PAPER_INTENT_OBS',
      sourceFile:      path.basename(obsPath),
    };
  }
  return best;
}

function searchCycleRows(
  contract: string,
  targetMs: number,
  cycleDir: string,
): SnapshotCandidate | null {
  if (!fs.existsSync(cycleDir)) return null;
  const files = fs.readdirSync(cycleDir)
    .filter(f => f.endsWith('.jsonl'))
    .filter(f => {
      const fMs = parseCycleFileMs(f);
      return fMs != null && Math.abs(fMs - targetMs) <= MAX_SKEW_MS;
    });

  let best: SnapshotCandidate | null = null;
  let bestSkew = Infinity;

  for (const fname of files) {
    for (const line of readLines(path.join(cycleDir, fname))) {
      let row: CycleRow;
      try { row = JSON.parse(line) as CycleRow; } catch { continue; }

      if (getContract(row) !== contract) continue;

      const capturedAt = row.capturedAt;
      if (!capturedAt) continue;
      const capturedAtMs = Date.parse(capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;

      const skew = Math.abs(capturedAtMs - targetMs);
      if (skew > MAX_SKEW_MS || skew >= bestSkew) continue;

      const rawTyped = row.raw as (Record<string, unknown> & { entry?: { liquidityUsd?: number } }) | undefined;
      const liqUsd = cycleNum(row, 'liquidityUsd') ?? rawTyped?.entry?.liquidityUsd ?? null;
      const vlr    = cycleNum(row, 'volumeToLiquidityRatio');

      bestSkew = skew;
      best = {
        capturedAtMs,
        liquidityUsd:    liqUsd,
        liquidityBucket: cycleStr(row, 'liquidityBucket') ?? deriveLiqBucket(liqUsd),
        vlrBucket:       cycleStr(row, 'vlrBucket')       ?? deriveVlrBucket(vlr),
        bubbleMapsScore: cycleNum(row, 'bubbleMapsScore')  ?? parseBubbleMapsScore(rawTyped?.clusterNotes),
        clusterRisk:     cycleStr(row, 'clusterRisk'),
        ripperScore:     cycleNum(row, 'ripperScore'),
        ageMinutes:      cycleNum(row, 'ageMinutes'),
        priceChangePct:  cycleNum(row, 'priceChangePct'),
        sourceTag:       'CYCLE_ROW',
        sourceFile:      fname,
      };
    }
  }
  return best;
}

function resolveLocalSnapshot(
  row: LedgerRow,
  window: SnapshotWindow,
  snapshotAt: string,
  sources: {
    ripperObsDir?:       string;
    dexWatchRunDir?:     string;
    paperIntentObsPath?: string;
    cycleDir?:           string;
  },
): SnapshotRow {
  const targetMs = window === 'RECHECK_2M' ? Date.parse(row.dueAt2m) : Date.parse(row.dueAt5m);

  const candidate =
    (sources.ripperObsDir       ? searchRipperObservations(row.contract, targetMs, sources.ripperObsDir)      : null) ??
    (sources.dexWatchRunDir     ? searchDexWatchRuns(row.contract, targetMs, sources.dexWatchRunDir)           : null) ??
    (sources.paperIntentObsPath ? searchPaperIntentObs(row.contract, targetMs, sources.paperIntentObsPath)     : null) ??
    (sources.cycleDir           ? searchCycleRows(row.contract, targetMs, sources.cycleDir)                    : null);

  if (!candidate) {
    return {
      contract:           row.contract,
      originalCapturedAt: row.capturedAt,
      snapshotAt,
      window,
      liquidityUsd:       null,
      liquidityBucket:    null,
      vlrBucket:          null,
      bubbleMapsScore:    null,
      clusterRisk:        null,
      ripperScore:        null,
      ageMinutes:         null,
      priceChangePct:     null,
      snapshotSource:     'NO_LOCAL_DATA',
      snapshotAvailable:  false,
      sourceFile:         null,
      minutesFromTarget:  null,
      ...SAFETY,
    };
  }

  return {
    contract:           row.contract,
    originalCapturedAt: row.capturedAt,
    snapshotAt,
    window,
    liquidityUsd:       candidate.liquidityUsd,
    liquidityBucket:    candidate.liquidityBucket,
    vlrBucket:          candidate.vlrBucket,
    bubbleMapsScore:    candidate.bubbleMapsScore,
    clusterRisk:        candidate.clusterRisk,
    ripperScore:        candidate.ripperScore,
    ageMinutes:         candidate.ageMinutes,
    priceChangePct:     candidate.priceChangePct,
    snapshotSource:     candidate.sourceTag,
    snapshotAvailable:  true,
    sourceFile:         candidate.sourceFile,
    minutesFromTarget:  parseFloat((Math.abs(candidate.capturedAtMs - targetMs) / 60_000).toFixed(2)),
    ...SAFETY,
  };
}

function makeSnapshot(
  row: LedgerRow,
  window: SnapshotWindow,
  snapshotAt: string,
): SnapshotRow {
  return resolveLocalSnapshot(row, window, snapshotAt, {});
}

// ── Command 1: Enroll ─────────────────────────────────────────────────────────

export function runWatchObservationEnroll(
  options: WatchObservationEnrollOptions = {},
): WatchObservationEnrollResult {
  const cycleDir   = options.cycleDir   ?? DEFAULT_CYCLE_DIR;
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const nowMs      = options.nowMs      ?? Date.now();

  const cycleFilePath = options.cycleFile ?? findLatestCycleFile(cycleDir);
  if (!cycleFilePath) {
    return {
      cycleFile: null, totalCycleRows: 0, watchRows: 0,
      newEnrollments: 0, duplicatesSkipped: 0, totalLedgerRows: 0,
      ...SAFETY,
    };
  }

  const cycleFileName = path.basename(cycleFilePath);
  const cycleId       = cycleFileName.replace(/\.jsonl$/, '');

  // Build dedup set from existing ledger
  const existing     = readLedger(ledgerPath);
  const existingKeys = new Set(existing.map(r => `${r.contract}::${r.capturedAt}`));

  const cycleLines = readLines(cycleFilePath);
  let totalCycleRows = 0;
  let watchRows      = 0;
  let dupeCount      = 0;
  const newRows: LedgerRow[] = [];

  const enrolledAt = new Date(nowMs).toISOString();

  for (const line of cycleLines) {
    let row: CycleRow;
    try { row = JSON.parse(line) as CycleRow; } catch { continue; }
    totalCycleRows++;

    const contract = getContract(row);
    if (!contract) continue;

    const clusterRisk = cycleStr(row, 'clusterRisk');
    if (clusterRisk !== 'WATCH') continue;
    watchRows++;

    const capturedAt = row.capturedAt ?? enrolledAt;
    const key        = `${contract}::${capturedAt}`;
    if (existingKeys.has(key)) { dupeCount++; continue; }
    existingKeys.add(key);

    const ageMinutes  = cycleNum(row, 'ageMinutes');
    const capturedMs  = Date.parse(capturedAt);
    const dueAt2m     = new Date(capturedMs + 2 * 60 * 1000).toISOString();
    const dueAt5m     = new Date(capturedMs + 5 * 60 * 1000).toISOString();

    const timingPath  = cycleStr(row, 'timingPath') ?? resolveTimingPath(ageMinutes);
    const gateDecision =
      row.gateDecision ?? row.buyGateDecision ?? row.raw?.gateDecision ?? row.raw?.buyGateDecision ?? null;

    newRows.push({
      contract,
      cycleId,
      capturedAt,
      enrolledAt,
      dueAt2m,
      dueAt5m,
      liquidityUsd:    cycleNum(row, 'liquidityUsd'),
      liquidityBucket: cycleStr(row, 'liquidityBucket'),
      vlrBucket:       cycleStr(row, 'vlrBucket'),
      bubbleMapsScore: cycleNum(row, 'bubbleMapsScore'),
      clusterRisk,
      ripperScore:     cycleNum(row, 'ripperScore'),
      ageMinutes,
      priceChangePct:  cycleNum(row, 'priceChangePct'),
      timingPath,
      gateDecision,
      status:          'PLANNED',
      ...SAFETY,
    });
  }

  ensureDir(ledgerPath);
  if (newRows.length > 0) {
    fs.appendFileSync(ledgerPath, newRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  return {
    cycleFile:         cycleFileName,
    totalCycleRows,
    watchRows,
    newEnrollments:    newRows.length,
    duplicatesSkipped: dupeCount,
    totalLedgerRows:   existing.length + newRows.length,
    ...SAFETY,
  };
}

// ── Command 2: Closeout ───────────────────────────────────────────────────────

export function runWatchObservationCloseout(
  options: WatchObservationCloseoutOptions = {},
): WatchObservationCloseoutResult {
  const ledgerPath    = options.ledgerPath    ?? DEFAULT_LEDGER_PATH;
  const snapshotsPath = options.snapshotsPath ?? DEFAULT_SNAPSHOTS_PATH;
  const nowMs         = options.nowMs         ?? Date.now();
  const snapshotAt    = new Date(nowMs).toISOString();

  const sourceDirs = {
    ripperObsDir:       options.ripperObsDir       ?? DEFAULT_RIPPER_OBS_DIR,
    dexWatchRunDir:     options.dexWatchRunDir      ?? DEFAULT_DEX_WATCH_RUN_DIR,
    paperIntentObsPath: options.paperIntentObsPath  ?? DEFAULT_PAPER_INTENT_OBS_PATH,
    cycleDir:           options.cycleDir            ?? DEFAULT_CYCLE_DIR,
  };

  const rawLedger  = readLedger(ledgerPath);
  const ledger     = mergeLedgerRows(rawLedger);
  const existing   = readSnapshots(snapshotsPath);

  // Index existing snapshots to prevent duplicates
  const snapKeys = new Set(existing.map(s => `${s.contract}::${s.originalCapturedAt}::${s.window}`));

  let dueFor2m = 0, dueFor5m = 0;
  let snapshotsWritten = 0, snapshotsSkipped = 0, ledgerRowsUpdated = 0;
  const sourceBreakdown: Record<string, number> = {};
  const newSnapshots: SnapshotRow[] = [];
  const updatedLedger: LedgerRow[]  = [];

  for (const row of ledger) {
    let updated     = { ...row };
    const past2m    = nowMs >= Date.parse(row.dueAt2m);
    const past5m    = nowMs >= Date.parse(row.dueAt5m);
    let changed     = false;

    // ── 2m window ─────────────────────────────────────────────────────────────
    if (past2m && updated.status === 'PLANNED') {
      dueFor2m++;
      const k2m = `${row.contract}::${row.capturedAt}::RECHECK_2M`;
      if (snapKeys.has(k2m)) {
        snapshotsSkipped++;
      } else {
        const snap = resolveLocalSnapshot(row, 'RECHECK_2M', snapshotAt, sourceDirs);
        sourceBreakdown[snap.snapshotSource] = (sourceBreakdown[snap.snapshotSource] ?? 0) + 1;
        newSnapshots.push(snap);
        snapshotsWritten++;
        snapKeys.add(k2m);
      }
      updated = { ...updated, status: 'DUE_2M_CAPTURED' };
      changed = true;
    }

    // ── 5m window ─────────────────────────────────────────────────────────────
    if (past5m && (updated.status === 'DUE_2M_CAPTURED' || updated.status === 'PLANNED')) {
      dueFor5m++;
      const k5m = `${row.contract}::${row.capturedAt}::RECHECK_5M`;
      if (snapKeys.has(k5m)) {
        snapshotsSkipped++;
      } else {
        const snap = resolveLocalSnapshot(row, 'RECHECK_5M', snapshotAt, sourceDirs);
        sourceBreakdown[snap.snapshotSource] = (sourceBreakdown[snap.snapshotSource] ?? 0) + 1;
        newSnapshots.push(snap);
        snapshotsWritten++;
        snapKeys.add(k5m);
      }
      // EXPIRED_NO_DATA if we missed the live 2m window (was still PLANNED when 5m hit)
      // COMPLETE if 2m was already processed in a prior closeout run or this run
      const wasPlannedThisRun = row.status === 'PLANNED';
      updated = { ...updated, status: wasPlannedThisRun ? 'EXPIRED_NO_DATA' : 'COMPLETE' };
      changed = true;
    }

    if (changed) ledgerRowsUpdated++;
    updatedLedger.push(updated);
  }

  // Append new snapshots (append-only)
  if (newSnapshots.length > 0) {
    ensureDir(snapshotsPath);
    fs.appendFileSync(snapshotsPath, newSnapshots.map(s => JSON.stringify(s)).join('\n') + '\n');
  }

  // Rewrite ledger with updated statuses
  if (ledgerRowsUpdated > 0 && updatedLedger.length > 0) {
    ensureDir(ledgerPath);
    fs.writeFileSync(ledgerPath, updatedLedger.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  return {
    ledgerRowsRead:    ledger.length,
    dueFor2m,
    dueFor5m,
    snapshotsWritten,
    snapshotsSkipped,
    ledgerRowsUpdated,
    sourceBreakdown,
    ...SAFETY,
  };
}

// ── Classification ────────────────────────────────────────────────────────────

function classifyCandidate(
  enrollment: LedgerRow,
  snap2m: SnapshotRow | null,
  snap5m: SnapshotRow | null,
): { classification: WatchClassification; note: string } {
  const has2m = snap2m?.snapshotAvailable === true;
  const has5m = snap5m?.snapshotAvailable === true;

  if (!has2m && !has5m) {
    return {
      classification: 'WATCH_DATA_GAP',
      note: 'No snapshot data available. snapshotAvailable=false for all windows.',
    };
  }

  const latest      = has5m ? snap5m! : snap2m!;
  const origPrice   = enrollment.priceChangePct ?? 0;
  const latestPrice = latest.priceChangePct ?? 0;

  // Fake spike: was showing a pump at capture, collapsed by recheck
  if (origPrice > 15 && latestPrice < -10) {
    return {
      classification: 'WATCH_FAKE_SPIKE',
      note: `Price was ${origPrice.toFixed(1)}% at capture, collapsed to ${latestPrice.toFixed(1)}% by ${has5m ? '5m' : '2m'}.`,
    };
  }

  // Confirmed ripper: sustained positive momentum
  if (latestPrice >= 10) {
    return {
      classification: 'WATCH_CONFIRMED_RIPPER',
      note: `Price sustained at ${latestPrice.toFixed(1)}% at ${has5m ? '5m' : '2m'} — ripper momentum confirmed.`,
    };
  }

  // Improving: liq/VLR/cluster resolved from unknown
  const origLiqUnk = enrollment.liquidityBucket === 'LIQ_UNKNOWN' || enrollment.liquidityBucket == null;
  const origVlrUnk = enrollment.vlrBucket       === 'VLR_UNKNOWN' || enrollment.vlrBucket == null;
  const liqResolved    = origLiqUnk && latest.liquidityBucket !== 'LIQ_UNKNOWN' && latest.liquidityBucket != null;
  const vlrResolved    = origVlrUnk && latest.vlrBucket       !== 'VLR_UNKNOWN' && latest.vlrBucket != null;
  const clusterUpgrade = enrollment.clusterRisk === 'WATCH' && latest.clusterRisk === 'CLEAN';

  if (liqResolved || vlrResolved || clusterUpgrade) {
    const reasons: string[] = [];
    if (liqResolved)    reasons.push('liquidityBucket resolved from LIQ_UNKNOWN');
    if (vlrResolved)    reasons.push('vlrBucket resolved from VLR_UNKNOWN');
    if (clusterUpgrade) reasons.push('clusterRisk improved WATCH→CLEAN');
    return {
      classification: 'WATCH_IMPROVING',
      note: `Signal quality improving: ${reasons.join('; ')}.`,
    };
  }

  // Dump pattern
  if (latestPrice < -15) {
    return {
      classification: 'WATCH_REJECT_OBSERVE_ONLY',
      note: `Price declined to ${latestPrice.toFixed(1)}% — dump pattern detected.`,
    };
  }

  return {
    classification: 'WATCH_REJECT_OBSERVE_ONLY',
    note: `No clear ripper pattern or improvement at ${has5m ? '5m' : '2m'} recheck (price=${latestPrice.toFixed(1)}%).`,
  };
}

function buildFinalRecommendation(
  total: number,
  dataGap: number,
  confirmed: number,
  improving: number,
): { recommendation: FinalRecommendation; note: string } {
  if (total === 0) {
    return {
      recommendation: 'WATCH_OBSERVATION_KEEP_COLLECTING',
      note: 'No enrolled candidates yet. Run token:ripper-watch-observation-enroll first.',
    };
  }
  const dataGapPct = dataGap / total;
  if (dataGapPct > 0.70) {
    return {
      recommendation: 'WATCH_OBSERVATION_TOO_MUCH_DATA_GAP',
      note: `${(dataGapPct * 100).toFixed(0)}% of candidates have no snapshot data. Run closeout after 5+ minutes to capture snapshots.`,
    };
  }
  const withData = total - dataGap;
  const ripperRate = (confirmed + improving) / Math.max(withData, 1);
  if (confirmed >= 3 && ripperRate >= 0.30) {
    return {
      recommendation: 'WATCH_OBSERVATION_READY_FOR_PAPER_REVIEW',
      note: `${confirmed} confirmed rippers + ${improving} improving (${(ripperRate * 100).toFixed(0)}% of observed). Sufficient signal for paper review.`,
    };
  }
  return {
    recommendation: 'WATCH_OBSERVATION_KEEP_COLLECTING',
    note: `${confirmed} confirmed, ${improving} improving, ${dataGap} data gaps. Keep collecting recheck data.`,
  };
}

// ── Command 3: Report ─────────────────────────────────────────────────────────

export function runWatchObservationReport(
  options: WatchObservationReportOptions = {},
): WatchObservationReportResult {
  const ledgerPath    = options.ledgerPath    ?? DEFAULT_LEDGER_PATH;
  const snapshotsPath = options.snapshotsPath ?? DEFAULT_SNAPSHOTS_PATH;
  const reportPath    = options.reportPath    ?? DEFAULT_REPORT_PATH;

  const ledger    = mergeLedgerRows(readLedger(ledgerPath));
  const snapshots = readSnapshots(snapshotsPath);

  const snap2mIdx = new Map<string, SnapshotRow>();
  const snap5mIdx = new Map<string, SnapshotRow>();
  for (const s of snapshots) {
    const key = `${s.contract}::${s.originalCapturedAt}`;
    if (s.window === 'RECHECK_2M') snap2mIdx.set(key, s);
    if (s.window === 'RECHECK_5M') snap5mIdx.set(key, s);
  }

  let snap2mCaptured = 0, snap2mMissing = 0;
  let snap5mCaptured = 0, snap5mMissing = 0;

  const classCounts: Record<WatchClassification, number> = {
    WATCH_CONFIRMED_RIPPER:    0,
    WATCH_IMPROVING:           0,
    WATCH_DATA_GAP:            0,
    WATCH_FAKE_SPIKE:          0,
    WATCH_REJECT_OBSERVE_ONLY: 0,
  };

  const candidates: ClassifiedCandidate[] = [];

  for (const row of ledger) {
    const key   = `${row.contract}::${row.capturedAt}`;
    const snap2m = snap2mIdx.get(key) ?? null;
    const snap5m = snap5mIdx.get(key) ?? null;

    if (snap2m) { snap2m.snapshotAvailable ? snap2mCaptured++ : snap2mMissing++; }
    if (snap5m) { snap5m.snapshotAvailable ? snap5mCaptured++ : snap5mMissing++; }

    const { classification, note } = classifyCandidate(row, snap2m, snap5m);
    classCounts[classification]++;

    candidates.push({
      contract:           row.contract,
      capturedAt:         row.capturedAt,
      classification,
      classificationNote: note,
      snap2mAvailable:    snap2m?.snapshotAvailable === true,
      snap5mAvailable:    snap5m?.snapshotAvailable === true,
      originalLiqBucket:  row.liquidityBucket,
      originalVlrBucket:  row.vlrBucket,
      originalCluster:    row.clusterRisk,
      originalPrice:      row.priceChangePct,
      price2m:            snap2m?.priceChangePct ?? null,
      price5m:            snap5m?.priceChangePct ?? null,
    });
  }

  const strongestCandidates = candidates
    .filter(c => c.classification === 'WATCH_CONFIRMED_RIPPER' || c.classification === 'WATCH_IMPROVING')
    .slice(0, 5);
  const fakeSpikeExamples = candidates.filter(c => c.classification === 'WATCH_FAKE_SPIKE').slice(0, 3);
  const dataGapExamples   = candidates.filter(c => c.classification === 'WATCH_DATA_GAP').slice(0, 3);

  const { recommendation, note: recommendationNote } = buildFinalRecommendation(
    candidates.length,
    classCounts.WATCH_DATA_GAP,
    classCounts.WATCH_CONFIRMED_RIPPER,
    classCounts.WATCH_IMPROVING,
  );

  // Aggregate source breakdown and avg minutes from target across all snapshots
  const sourceBreakdown: Record<string, number> = {};
  let minutesSum = 0, minutesCount = 0;
  for (const s of snapshots) {
    sourceBreakdown[s.snapshotSource] = (sourceBreakdown[s.snapshotSource] ?? 0) + 1;
    if (s.snapshotAvailable && s.minutesFromTarget != null) {
      minutesSum += s.minutesFromTarget;
      minutesCount++;
    }
  }
  const avgMinutesFromTarget = minutesCount > 0
    ? parseFloat((minutesSum / minutesCount).toFixed(2))
    : null;

  try {
    ensureDir(reportPath);
    fs.appendFileSync(reportPath, JSON.stringify({
      totalEnrolled: candidates.length, classifications: classCounts, recommendation, ...SAFETY,
    }) + '\n');
  } catch { /* fail-soft */ }

  return {
    totalEnrolled: candidates.length,
    snap2mCaptured, snap2mMissing,
    snap5mCaptured, snap5mMissing,
    classifications: classCounts,
    candidates,
    strongestCandidates,
    fakeSpikeExamples,
    dataGapExamples,
    recommendation,
    recommendationNote,
    sourceBreakdown,
    avgMinutesFromTarget,
    ...SAFETY,
  };
}

// ── Renderers ─────────────────────────────────────────────────────────────────

const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const SEP2 = '────────────────────────────────────────────────────────────────';

function safetyFooter(): string[] {
  return [
    `  ${SEP2}`,
    '  SAFETY',
    `  ${SEP2}`, '',
    '  REPORT_ONLY=true  READ_ONLY=true  NO_POLICY_CHANGE=true',
    '  DO_NOT_ENABLE_REAL_TRADING  tradingExecuted=0  realTradingLocked=true',
    '  paperOnly=true  reportOnly=true',
    '  No gate, autopilot, policy, or trade logic modified.',
    `  ${SEP}`, '',
  ];
}

export function renderWatchObservationEnroll(result: WatchObservationEnrollResult): string {
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — WATCH OBSERVATION ENROLL v1');
  L.push('  [REPORT ONLY — NO TRADES — NO POLICY CHANGES — READ ONLY]');
  L.push(SEP, '');
  L.push(`  Cycle file          : ${result.cycleFile ?? 'NOT FOUND'}`);
  L.push(`  Total cycle rows    : ${result.totalCycleRows}`);
  L.push(`  WATCH rows found    : ${result.watchRows}`);
  L.push(`  New enrollments     : ${result.newEnrollments}`);
  L.push(`  Duplicates skipped  : ${result.duplicatesSkipped}`);
  L.push(`  Total ledger rows   : ${result.totalLedgerRows}`);
  L.push('');
  L.push(...safetyFooter());
  return L.join('\n');
}

export function renderWatchObservationCloseout(result: WatchObservationCloseoutResult): string {
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — WATCH OBSERVATION CLOSEOUT v1');
  L.push('  [REPORT ONLY — NO TRADES — NO POLICY CHANGES — READ ONLY]');
  L.push(SEP, '');
  L.push(`  Ledger rows read      : ${result.ledgerRowsRead}`);
  L.push(`  Due for 2m snapshot   : ${result.dueFor2m}`);
  L.push(`  Due for 5m snapshot   : ${result.dueFor5m}`);
  L.push(`  Snapshots written     : ${result.snapshotsWritten}`);
  L.push(`  Snapshots skipped     : ${result.snapshotsSkipped}  (already captured)`);
  L.push(`  Ledger rows updated   : ${result.ledgerRowsUpdated}`);
  if (Object.keys(result.sourceBreakdown).length > 0) {
    L.push('');
    L.push('  Source breakdown:');
    for (const [src, count] of Object.entries(result.sourceBreakdown).sort()) {
      L.push(`    ${src.padEnd(22)}: ${count}`);
    }
  }
  L.push('');
  L.push(...safetyFooter());
  return L.join('\n');
}

export function renderWatchObservationReport(result: WatchObservationReportResult): string {
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — WATCH OBSERVATION REPORT v1');
  L.push('  [REPORT ONLY — NO TRADES — NO POLICY CHANGES — READ ONLY]');
  L.push(SEP, '');

  L.push(`  ${SEP2}`);
  L.push('  OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Total enrolled      : ${result.totalEnrolled}`);
  L.push(`  2m snapshots        : ${result.snap2mCaptured} captured / ${result.snap2mMissing} missing`);
  L.push(`  5m snapshots        : ${result.snap5mCaptured} captured / ${result.snap5mMissing} missing`);
  if (result.avgMinutesFromTarget != null) {
    L.push(`  Avg minutes from target: ${result.avgMinutesFromTarget.toFixed(1)} min`);
  }
  if (Object.keys(result.sourceBreakdown).length > 0) {
    L.push('  Source breakdown:');
    for (const [src, count] of Object.entries(result.sourceBreakdown).sort()) {
      L.push(`    ${src.padEnd(22)}: ${count}`);
    }
  }
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  CLASSIFICATIONS');
  L.push(`  ${SEP2}`, '');
  L.push(`  WATCH_CONFIRMED_RIPPER    : ${result.classifications.WATCH_CONFIRMED_RIPPER}`);
  L.push(`  WATCH_IMPROVING           : ${result.classifications.WATCH_IMPROVING}`);
  L.push(`  WATCH_DATA_GAP            : ${result.classifications.WATCH_DATA_GAP}`);
  L.push(`  WATCH_FAKE_SPIKE          : ${result.classifications.WATCH_FAKE_SPIKE}`);
  L.push(`  WATCH_REJECT_OBSERVE_ONLY : ${result.classifications.WATCH_REJECT_OBSERVE_ONLY}`);
  L.push('');

  if (result.strongestCandidates.length > 0) {
    L.push(`  ${SEP2}`);
    L.push('  STRONGEST WATCH CANDIDATES');
    L.push(`  ${SEP2}`, '');
    for (const c of result.strongestCandidates) {
      L.push(`  [${c.classification}]  ${c.contract.slice(0, 20)}...`);
      L.push(`    orig=${c.originalPrice?.toFixed(1) ?? 'n/a'}%  2m=${c.price2m?.toFixed(1) ?? 'n/a'}%  5m=${c.price5m?.toFixed(1) ?? 'n/a'}%`);
      L.push(`    ${c.classificationNote}`);
      L.push('');
    }
  }

  if (result.fakeSpikeExamples.length > 0) {
    L.push(`  ${SEP2}`);
    L.push('  FAKE SPIKE EXAMPLES');
    L.push(`  ${SEP2}`, '');
    for (const c of result.fakeSpikeExamples) {
      L.push(`  ${c.contract.slice(0, 20)}...  ${c.classificationNote}`);
    }
    L.push('');
  }

  if (result.dataGapExamples.length > 0) {
    L.push(`  ${SEP2}`);
    L.push('  DATA GAP EXAMPLES  (no snapshot data available)');
    L.push(`  ${SEP2}`, '');
    for (const c of result.dataGapExamples) {
      L.push(`  ${c.contract.slice(0, 20)}...  captured=${c.capturedAt}`);
    }
    L.push('');
  }

  L.push(`  ${SEP2}`);
  L.push('  RECOMMENDATION');
  L.push(`  ${SEP2}`, '');
  L.push(`  [${result.recommendation}]`);
  L.push(`  ${result.recommendationNote}`);
  L.push('');

  L.push(...safetyFooter());
  return L.join('\n');
}
