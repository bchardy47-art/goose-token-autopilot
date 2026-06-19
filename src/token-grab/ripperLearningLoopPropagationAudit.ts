import * as fs   from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_DEX_WATCH_RUNS_DIR    = 'data/token-grab/dex-watch-runs';
const DEFAULT_CYCLES_DIR            = 'data/token-grab/ripper/cycles';
const DEFAULT_INTENTS_PATH          = 'data/token-grab/ripper/paper-intents.jsonl';
const DEFAULT_OBS_PATH              = 'data/token-grab/ripper/paper-intent-observations.jsonl';
const DEFAULT_MEMORY_PATH           = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_RECENT                = 10;
const DEFAULT_RECENT_ROWS_FOR_M5    = 50;
const STALE_MINUTES                 = 120;
const CONTRACT_SAMPLE_SIZE          = 10;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DexWatchRunSummary {
  fileName:      string;
  generatedAt:   string | null;
  outcomesTotal: number;
  withM5:        number;
}

export interface CycleFileSummary {
  fileName:          string;
  capturedAt:        string | null;
  rowCount:          number;
  withM5NonNull:     number;
  withDexScreenerM5: number;
}

export interface FreshnessGap {
  fromStage:  string;
  toStage:    string;
  fromTs:     string | null;
  toTs:       string | null;
  gapMinutes: number | null;
  stale:      boolean;
}

export interface ContractTrace {
  contract:        string;
  symbol:          string | null;
  m5InLatestCycle: number | null;
  inCycle:         boolean;
  inIntents:       boolean;
  inObservations:  boolean;
  inMemory:        boolean;
}

export type M5PersistenceStatus =
  | 'M5_FULLY_PERSISTED'
  | 'M5_ONLY_AVAILABLE_BY_CYCLE_JOIN'
  | 'M5_NEW_ROWS_NOT_CREATED_YET'
  | 'M5_INTENTS_OK_OBSERVATIONS_STALE'
  | 'M5_OBSERVATIONS_OK_MEMORY_STALE'
  | 'M5_NOT_CAPTURED_ANYWHERE';

export interface LearningLoopAuditResult {
  // §1 — overview
  latestDexWatchFile:          string | null;
  latestDexWatchGeneratedAt:   string | null;
  latestCycleFile:             string | null;
  latestCycleCapturedAt:       string | null;
  latestIntentApprovedAt:      string | null;
  latestObservationCapturedAt: string | null;
  latestMemoryTimestamp:       string | null;

  // §2 — stage counts
  recentDexWatchRuns: DexWatchRunSummary[];
  recentCycleFiles:   CycleFileSummary[];
  intentsTotal:       number;
  intentsOpen:        number;
  intentsDue:         number;
  intentsObserved:    number;
  intentsExpired:     number;
  observationsTotal:  number;
  memoryTotal:        number;

  // §3 — freshness gaps
  freshnessGaps: FreshnessGap[];

  // §4 — M5 propagation (all-time totals)
  latestCycleTotalRows:      number;
  latestCycleM5NonNull:      number;
  latestCycleM5DexScreener:  number;
  intentsWithM5:             number;
  observationsWithM5:        number;
  memoryWithM5:              number;
  m5StopsAt:                 string;

  // §4b — recent-row M5 check (last recentRowsForM5 rows of each type)
  recentRowsForM5:          number;
  recentIntentsWithM5:      number;
  recentObsWithM5:          number;
  recentMemoryWithM5:       number;

  // §4c — cycle-join availability for recent intents without direct M5
  cycleJoinSampleSize:         number;
  m5AvailableViaCycleJoin:     number;
  m5NotAvailableViaCycleJoin:  number;
  m5PersistenceStatus:         M5PersistenceStatus;

  // §5 — contract sample
  contractSample:    ContractTrace[];
  sampleSourceLabel: string;

  // §6 — diagnoses
  diagnoses: string[];

  // §7 — next actions
  nextActions: string[];

  // safety
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  noMutation:        true;
  noRealTrading:     true;
  noGateChanges:     true;
  noWallet:          true;
  noSwap:            true;
  noSigning:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface LearningLoopAuditOptions {
  dexWatchRunsDir?:  string;
  cyclesDir?:        string;
  intentsPath?:      string;
  obsPath?:          string;
  memoryPath?:       string;
  recent?:           number;
  recentRowsForM5?:  number;
  nowMs?:            number;
}

// ── Internal raw types ─────────────────────────────────────────────────────────

interface RawOutcome {
  contract?:           string;
  symbol?:             string;
  entryPriceChangeM5?: number | null;
}

interface RawDexRun {
  generatedAt?: string;
  winners?:     RawOutcome[];
  losers?:      RawOutcome[];
  flat?:        RawOutcome[];
  missing?:     RawOutcome[];
  topMovers?:   RawOutcome[];
}

interface RawCycleRow {
  capturedAt?:           string;
  entryMomentumPct?:     number | null;
  entryMomentumSource?:  string;
  normalizedSignal?:     { contract?: string; symbol?: string };
  ripperInput?:          { contract?: string };
}

interface RawIntent {
  contract?:         string;
  symbol?:           string;
  status?:           string;
  approvedAt?:       string;
  sourceCycle?:      string | null;
  entryMomentumPct?: number | null;
  // check nested paths too
  normalizedSignal?: { entryMomentumPct?: number | null };
  raw?:              { entryMomentumPct?: number | null };
  entryPriceChangeM5?: number | null;
}

interface RawObs {
  capturedAt?:         string;
  intentId?:           string;
  entryMomentumPct?:   number | null;
  entryPriceChangeM5?: number | null;
  normalizedSignal?:   { contract?: string; entryMomentumPct?: number | null };
}

interface RawMemRow {
  contract?:         string;
  capturedAt?:       string;
  observedAt?:       string;
  entryMomentumPct?: number | null;
  entryPriceChangeM5?: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T; } catch { return null; }
}

function gapMinutes(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const diff = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(diff / 60_000);
}

// Returns true if this record has entryMomentumPct on ANY recognized field path.
function intentHasM5(r: RawIntent): boolean {
  if (r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct)) return true;
  if (r.entryPriceChangeM5 != null && Number.isFinite(r.entryPriceChangeM5)) return true;
  if (r.normalizedSignal?.entryMomentumPct != null &&
      Number.isFinite(r.normalizedSignal.entryMomentumPct)) return true;
  if (r.raw?.entryMomentumPct != null && Number.isFinite(r.raw.entryMomentumPct)) return true;
  return false;
}

function obsHasM5(r: RawObs): boolean {
  if (r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct)) return true;
  if (r.entryPriceChangeM5 != null && Number.isFinite(r.entryPriceChangeM5)) return true;
  if (r.normalizedSignal?.entryMomentumPct != null &&
      Number.isFinite(r.normalizedSignal.entryMomentumPct)) return true;
  return false;
}

function memHasM5(r: RawMemRow): boolean {
  if (r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct)) return true;
  if (r.entryPriceChangeM5 != null && Number.isFinite(r.entryPriceChangeM5)) return true;
  return false;
}

// ── Main runner ────────────────────────────────────────────────────────────────

export function runLearningLoopAudit(
  opts: LearningLoopAuditOptions = {},
): LearningLoopAuditResult {
  const dexRunsDir       = opts.dexWatchRunsDir ?? DEFAULT_DEX_WATCH_RUNS_DIR;
  const cyclesDir        = opts.cyclesDir        ?? DEFAULT_CYCLES_DIR;
  const intentsPath      = opts.intentsPath      ?? DEFAULT_INTENTS_PATH;
  const obsPath          = opts.obsPath          ?? DEFAULT_OBS_PATH;
  const memoryPath       = opts.memoryPath       ?? DEFAULT_MEMORY_PATH;
  const recent           = opts.recent           ?? DEFAULT_RECENT;
  const recentRowsForM5  = opts.recentRowsForM5  ?? DEFAULT_RECENT_ROWS_FOR_M5;

  // ── dex-watch runs ──────────────────────────────────────────────────────────
  const allRunFiles = fs.existsSync(dexRunsDir)
    ? fs.readdirSync(dexRunsDir)
        .filter(f => f.startsWith('run-') && f.endsWith('.json'))
        .sort()
    : [];

  const recentRunFiles = allRunFiles.slice(-recent);
  const recentDexWatchRuns: DexWatchRunSummary[] = recentRunFiles.map(fname => {
    const run = readJson<RawDexRun>(path.join(dexRunsDir, fname));
    const outcomes = [
      ...(run?.winners ?? []),
      ...(run?.losers  ?? []),
      ...(run?.flat    ?? []),
      ...(run?.missing ?? []),
    ];
    return {
      fileName:      fname,
      generatedAt:   run?.generatedAt ?? null,
      outcomesTotal: outcomes.length,
      withM5:        outcomes.filter(o => o.entryPriceChangeM5 != null).length,
    };
  });

  const latestDexWatchFile        = allRunFiles.at(-1) ?? null;
  const latestDexWatchGeneratedAt = recentDexWatchRuns.at(-1)?.generatedAt ?? null;

  // ── cycle files (JSONL only) ───────────────────────────────────────────────
  const allCycleFiles = fs.existsSync(cyclesDir)
    ? fs.readdirSync(cyclesDir)
        .filter(f => f.match(/^cycle-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/))
        .sort()
    : [];

  const recentCycleFileNames = allCycleFiles.slice(-recent);
  const recentCycleFiles: CycleFileSummary[] = recentCycleFileNames.map(fname => {
    const rows = readJsonl<RawCycleRow>(path.join(cyclesDir, fname));
    const capturedAt = rows[0]?.capturedAt ?? null;
    return {
      fileName:          fname,
      capturedAt,
      rowCount:          rows.length,
      withM5NonNull:     rows.filter(r => r.entryMomentumPct != null).length,
      withDexScreenerM5: rows.filter(r => r.entryMomentumSource === 'DEX_SCREENER_M5').length,
    };
  });

  const latestCycleFile       = allCycleFiles.at(-1) ?? null;
  const latestCycleSummary    = recentCycleFiles.at(-1) ?? null;
  const latestCycleCapturedAt = latestCycleSummary?.capturedAt ?? null;

  // Latest full cycle rows for M5 propagation and contract sample
  const latestCycleRows = latestCycleFile
    ? readJsonl<RawCycleRow>(path.join(cyclesDir, latestCycleFile))
    : [];

  // Build cycle contract → symbol + m5 map
  const cycleContractMap = new Map<string, { symbol: string | null; m5: number | null }>();
  for (const row of latestCycleRows) {
    const contract = row.normalizedSignal?.contract ?? row.ripperInput?.contract;
    if (contract && !cycleContractMap.has(contract)) {
      cycleContractMap.set(contract, {
        symbol: row.normalizedSignal?.symbol ?? null,
        m5: (row.entryMomentumPct != null && Number.isFinite(row.entryMomentumPct))
          ? row.entryMomentumPct
          : null,
      });
    }
  }

  // Lazy cycle file cache: cycleId → Map<contract, m5>
  const cycleM5Cache = new Map<string, Map<string, number | null>>();
  function getCycleM5(cycleId: string, contract: string): number | null {
    if (!cycleM5Cache.has(cycleId)) {
      const filePath = path.join(cyclesDir, `${cycleId}.jsonl`);
      const contractMap = new Map<string, number | null>();
      if (fs.existsSync(filePath)) {
        for (const row of readJsonl<RawCycleRow>(filePath)) {
          const c = row.normalizedSignal?.contract ?? row.ripperInput?.contract;
          if (c && !contractMap.has(c)) {
            contractMap.set(c, (row.entryMomentumPct != null && Number.isFinite(row.entryMomentumPct))
              ? row.entryMomentumPct
              : null);
          }
        }
      }
      cycleM5Cache.set(cycleId, contractMap);
    }
    return cycleM5Cache.get(cycleId)?.get(contract) ?? null;
  }

  // ── paper intents ──────────────────────────────────────────────────────────
  const allIntents = readJsonl<RawIntent>(intentsPath);
  const intentsByStatus: Record<string, number> = {};
  let latestIntentApprovedAt: string | null = null;
  let intentsWithM5 = 0;
  const intentContractSet = new Set<string>();

  for (const r of allIntents) {
    const s = r.status ?? 'UNKNOWN';
    intentsByStatus[s] = (intentsByStatus[s] ?? 0) + 1;
    if (r.approvedAt && (!latestIntentApprovedAt || r.approvedAt > latestIntentApprovedAt)) {
      latestIntentApprovedAt = r.approvedAt;
    }
    if (intentHasM5(r)) intentsWithM5++;
    if (r.contract) intentContractSet.add(r.contract);
  }

  const terminalStatuses = new Set(['OBSERVED', 'EXPIRED_NO_DATA']);
  const intentsDue      = intentsByStatus['ENTRY_DUE'] ?? 0;
  const intentsObserved = intentsByStatus['OBSERVED']  ?? 0;
  const intentsExpired  = intentsByStatus['EXPIRED_NO_DATA'] ?? 0;
  const intentsOpen     = allIntents.filter(r =>
    r.status != null && !terminalStatuses.has(r.status)
  ).length;

  // Recent-N intents: last recentRowsForM5 rows by approvedAt order (file order)
  const recentIntentSlice = allIntents.slice(-recentRowsForM5);
  const recentIntentsWithM5 = recentIntentSlice.filter(intentHasM5).length;

  // ── cycle-join availability for recent intents ─────────────────────────────
  // For recent intents that lack direct M5, check if their sourceCycle file has M5
  const recentIntentsWithoutDirectM5 = recentIntentSlice.filter(r => !intentHasM5(r));
  let m5AvailableViaCycleJoin    = 0;
  let m5NotAvailableViaCycleJoin = 0;
  for (const intent of recentIntentsWithoutDirectM5) {
    if (!intent.contract || !intent.sourceCycle) {
      m5NotAvailableViaCycleJoin++;
      continue;
    }
    const m5 = getCycleM5(intent.sourceCycle, intent.contract);
    if (m5 != null) {
      m5AvailableViaCycleJoin++;
    } else {
      m5NotAvailableViaCycleJoin++;
    }
  }
  const cycleJoinSampleSize = recentIntentsWithoutDirectM5.length;

  // ── observations ──────────────────────────────────────────────────────────
  const allObs = readJsonl<RawObs>(obsPath);
  let latestObsCapturedAt: string | null = null;
  let observationsWithM5 = 0;
  const obsContractSet = new Set<string>();

  for (const r of allObs) {
    if (r.capturedAt && (!latestObsCapturedAt || r.capturedAt > latestObsCapturedAt)) {
      latestObsCapturedAt = r.capturedAt;
    }
    if (obsHasM5(r)) observationsWithM5++;
    const c = r.normalizedSignal?.contract;
    if (c) obsContractSet.add(c);
  }

  const recentObsSlice     = allObs.slice(-recentRowsForM5);
  const recentObsWithM5    = recentObsSlice.filter(obsHasM5).length;

  // ── learning memory ────────────────────────────────────────────────────────
  const allMem = readJsonl<RawMemRow>(memoryPath);
  let latestMemoryTs: string | null = null;
  let memoryWithM5 = 0;
  const memContractSet = new Set<string>();

  for (const r of allMem) {
    const ts = r.observedAt ?? r.capturedAt ?? null;
    if (ts && (!latestMemoryTs || ts > latestMemoryTs)) latestMemoryTs = ts;
    if (memHasM5(r)) memoryWithM5++;
    if (r.contract) memContractSet.add(r.contract);
  }

  const recentMemSlice     = allMem.slice(-recentRowsForM5);
  const recentMemoryWithM5 = recentMemSlice.filter(memHasM5).length;

  // ── freshness gaps ─────────────────────────────────────────────────────────
  function makeGap(fromStage: string, fromTs: string | null, toStage: string, toTs: string | null): FreshnessGap {
    const gap = gapMinutes(toTs, fromTs);  // positive = from is newer than to
    return {
      fromStage,
      toStage,
      fromTs,
      toTs,
      gapMinutes: gap,
      stale:      gap != null && gap > STALE_MINUTES,
    };
  }

  const freshnessGaps: FreshnessGap[] = [
    makeGap('dex-watch-run', latestDexWatchGeneratedAt, 'ripper-cycle', latestCycleCapturedAt),
    makeGap('ripper-cycle', latestCycleCapturedAt, 'paper-intents', latestIntentApprovedAt),
    makeGap('paper-intents', latestIntentApprovedAt, 'observations', latestObsCapturedAt),
    makeGap('observations', latestObsCapturedAt, 'learning-memory', latestMemoryTs),
  ];

  // ── M5 propagation summary ─────────────────────────────────────────────────
  const latestCycleTotalRows     = latestCycleSummary?.rowCount ?? 0;
  const latestCycleM5NonNull     = latestCycleSummary?.withM5NonNull ?? 0;
  const latestCycleM5DexScreener = latestCycleSummary?.withDexScreenerM5 ?? 0;

  let m5StopsAt: string;
  if (memoryWithM5 > 0) {
    m5StopsAt = 'learning-memory (flowing through all stages)';
  } else if (observationsWithM5 > 0) {
    m5StopsAt = 'observations (not persisted to learning-memory)';
  } else if (intentsWithM5 > 0) {
    m5StopsAt = 'paper-intents (not persisted to observations or learning-memory)';
  } else if (latestCycleM5DexScreener > 0) {
    m5StopsAt = 'cycle-rows (not persisted to paper-intents, observations, or learning-memory)';
  } else {
    m5StopsAt = 'not yet captured in any stage';
  }

  // ── M5 persistence status ─────────────────────────────────────────────────
  let m5PersistenceStatus: M5PersistenceStatus;
  if (recentIntentsWithM5 > 0 && recentObsWithM5 > 0 && recentMemoryWithM5 > 0) {
    m5PersistenceStatus = 'M5_FULLY_PERSISTED';
  } else if (recentObsWithM5 > 0 && recentMemoryWithM5 === 0) {
    m5PersistenceStatus = 'M5_OBSERVATIONS_OK_MEMORY_STALE';
  } else if (recentIntentsWithM5 > 0 && recentObsWithM5 === 0) {
    m5PersistenceStatus = 'M5_INTENTS_OK_OBSERVATIONS_STALE';
  } else if (recentIntentsWithM5 === 0 && m5AvailableViaCycleJoin > 0) {
    m5PersistenceStatus = 'M5_ONLY_AVAILABLE_BY_CYCLE_JOIN';
  } else if (latestCycleM5DexScreener === 0 && allIntents.length === 0) {
    m5PersistenceStatus = 'M5_NEW_ROWS_NOT_CREATED_YET';
  } else if (latestCycleM5DexScreener > 0 && allIntents.length === 0) {
    m5PersistenceStatus = 'M5_NEW_ROWS_NOT_CREATED_YET';
  } else {
    m5PersistenceStatus = 'M5_NOT_CAPTURED_ANYWHERE';
  }

  // ── contract sample ────────────────────────────────────────────────────────
  let sampleContracts: Array<{ contract: string; symbol: string | null; m5: number | null }> = [];
  let sampleSourceLabel = 'latest dex-watch run';

  if (allRunFiles.length > 0) {
    const latestRun = readJson<RawDexRun>(path.join(dexRunsDir, allRunFiles.at(-1)!));
    if (latestRun) {
      const outcomes = [
        ...(latestRun.winners ?? []),
        ...(latestRun.losers  ?? []),
        ...(latestRun.flat    ?? []),
        ...(latestRun.missing ?? []),
      ];
      const seen = new Set<string>();
      for (const o of outcomes) {
        if (o.contract && !seen.has(o.contract)) {
          seen.add(o.contract);
          sampleContracts.push({
            contract: o.contract,
            symbol:   o.symbol ?? null,
            m5:       (o.entryPriceChangeM5 != null && Number.isFinite(o.entryPriceChangeM5))
              ? o.entryPriceChangeM5
              : null,
          });
        }
        if (sampleContracts.length >= CONTRACT_SAMPLE_SIZE) break;
      }
    }
  }

  if (sampleContracts.length === 0 && cycleContractMap.size > 0) {
    sampleSourceLabel = 'latest cycle file';
    for (const [contract, { symbol, m5 }] of cycleContractMap) {
      sampleContracts.push({ contract, symbol, m5 });
      if (sampleContracts.length >= CONTRACT_SAMPLE_SIZE) break;
    }
  }

  const contractSample: ContractTrace[] = sampleContracts.map(({ contract, symbol, m5 }) => ({
    contract,
    symbol,
    m5InLatestCycle: cycleContractMap.get(contract)?.m5 ?? null,
    inCycle:         cycleContractMap.has(contract),
    inIntents:       intentContractSet.has(contract),
    inObservations:  obsContractSet.has(contract),
    inMemory:        memContractSet.has(contract),
  }));

  // ── diagnoses ──────────────────────────────────────────────────────────────
  const diagnoses: string[] = [];

  const [dexVsCycleGap, cycleVsIntentGap, intentVsObsGap, obsVsMemGap] = freshnessGaps;

  if (dexVsCycleGap.stale)    diagnoses.push('DEX_ADVANCING_RIPPER_STALE');
  if (cycleVsIntentGap.stale) diagnoses.push('CYCLE_ADVANCING_INTENTS_STALE');
  if (intentVsObsGap.stale)   diagnoses.push('INTENTS_ADVANCING_OBSERVATIONS_STALE');
  if (obsVsMemGap.stale)      diagnoses.push('OBSERVATIONS_ADVANCING_MEMORY_STALE');

  // M5 persistence diagnoses (from persistence status, never overlap)
  if (m5PersistenceStatus === 'M5_FULLY_PERSISTED') {
    diagnoses.push('M5_FULLY_PERSISTED');
  } else if (m5PersistenceStatus === 'M5_OBSERVATIONS_OK_MEMORY_STALE') {
    diagnoses.push('M5_OBSERVATIONS_OK_MEMORY_STALE');
  } else if (m5PersistenceStatus === 'M5_INTENTS_OK_OBSERVATIONS_STALE') {
    diagnoses.push('M5_INTENTS_OK_OBSERVATIONS_STALE');
  } else if (m5PersistenceStatus === 'M5_ONLY_AVAILABLE_BY_CYCLE_JOIN') {
    diagnoses.push('M5_ONLY_AVAILABLE_BY_CYCLE_JOIN');
  } else if (m5PersistenceStatus === 'M5_NEW_ROWS_NOT_CREATED_YET') {
    diagnoses.push('M5_NEW_ROWS_NOT_CREATED_YET');
  } else {
    diagnoses.push('M5_NOT_PERSISTED_TO_MEMORY');
  }

  // HEALTHY_FLOW override: all stages present, no freshness issues, M5 fully persisted
  if (
    diagnoses.length === 1 &&
    diagnoses[0] === 'M5_FULLY_PERSISTED' &&
    allRunFiles.length > 0 &&
    allCycleFiles.length > 0 &&
    allIntents.length > 0 &&
    allMem.length > 0
  ) {
    diagnoses.unshift('HEALTHY_FLOW');
  }

  // ── next actions ───────────────────────────────────────────────────────────
  const nextActions: string[] = [];

  if (diagnoses.includes('DEX_ADVANCING_RIPPER_STALE')) {
    nextActions.push('Run npm run token:ripper-paper-cycle to process latest dex-watch signals into a new ripper cycle.');
  }
  if (m5PersistenceStatus === 'M5_ONLY_AVAILABLE_BY_CYCLE_JOIN') {
    nextActions.push(
      'entryMomentumPct is NOT yet on paper intent records. ' +
      'Run token:ripper-paper-autopilot-cycle again — the post-fix code will write M5 on new intents. ' +
      'Until then, the simulation report gets M5 only via the cycle-join fallback.',
    );
    nextActions.push(
      'No backfill needed for historical rows — only new cycles going forward will carry M5.',
    );
  }
  if (m5PersistenceStatus === 'M5_INTENTS_OK_OBSERVATIONS_STALE') {
    nextActions.push('New intents have M5 but observations do not yet. ' +
      'Run token:ripper-paper-autopilot-cycle again to observe due intents — observations will carry M5.');
  }
  if (m5PersistenceStatus === 'M5_OBSERVATIONS_OK_MEMORY_STALE') {
    nextActions.push('Observations have M5 but learning memory does not yet. ' +
      'Run token:ripper-learning-memory to rebuild/append memory rows from cycles that have M5.');
  }
  if (m5PersistenceStatus === 'M5_FULLY_PERSISTED') {
    nextActions.push('M5 is fully persisted through all stages. Continue running the normal loop.');
  }
  if (m5PersistenceStatus === 'M5_NEW_ROWS_NOT_CREATED_YET') {
    nextActions.push('No paper intents exist yet for this cycle. Run token:ripper-paper-autopilot-cycle to create them.');
  }
  if (nextActions.length === 0) {
    nextActions.push('Investigate the flagged stages above before taking action.');
  }

  return {
    latestDexWatchFile,
    latestDexWatchGeneratedAt,
    latestCycleFile,
    latestCycleCapturedAt,
    latestIntentApprovedAt,
    latestObservationCapturedAt: latestObsCapturedAt,
    latestMemoryTimestamp:       latestMemoryTs,

    recentDexWatchRuns,
    recentCycleFiles,
    intentsTotal:     allIntents.length,
    intentsOpen,
    intentsDue,
    intentsObserved,
    intentsExpired,
    observationsTotal: allObs.length,
    memoryTotal:       allMem.length,

    freshnessGaps,

    latestCycleTotalRows,
    latestCycleM5NonNull,
    latestCycleM5DexScreener,
    intentsWithM5,
    observationsWithM5,
    memoryWithM5,
    m5StopsAt,

    recentRowsForM5,
    recentIntentsWithM5,
    recentObsWithM5,
    recentMemoryWithM5,

    cycleJoinSampleSize,
    m5AvailableViaCycleJoin,
    m5NotAvailableViaCycleJoin,
    m5PersistenceStatus,

    contractSample,
    sampleSourceLabel,

    diagnoses,
    nextActions,

    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    noMutation:        true,
    noRealTrading:     true,
    noGateChanges:     true,
    noWallet:          true,
    noSwap:            true,
    noSigning:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────────

function fmtTs(ts: string | null): string {
  return ts ?? '(none)';
}

function fmtGap(gap: number | null): string {
  if (gap == null) return 'unknown';
  if (gap < 0)  return `${Math.abs(gap)}m behind`;
  if (gap === 0) return 'same time';
  return `${gap}m ahead`;
}

export function renderLearningLoopAudit(result: LearningLoopAuditResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — LEARNING LOOP PROPAGATION AUDIT');
  L.push('  [REPORT ONLY — READ ONLY — NO MUTATION — NO GATE CHANGES]');
  L.push(SEP, '');

  // §1 — Overview
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Latest dex-watch run file  : ${result.latestDexWatchFile ?? '(none)'}`);
  L.push(`  Latest dex-watch generatedAt: ${fmtTs(result.latestDexWatchGeneratedAt)}`);
  L.push(`  Latest ripper cycle file   : ${result.latestCycleFile ?? '(none)'}`);
  L.push(`  Latest cycle capturedAt    : ${fmtTs(result.latestCycleCapturedAt)}`);
  L.push(`  Latest intent approvedAt   : ${fmtTs(result.latestIntentApprovedAt)}`);
  L.push(`  Latest observation         : ${fmtTs(result.latestObservationCapturedAt)}`);
  L.push(`  Latest memory timestamp    : ${fmtTs(result.latestMemoryTimestamp)}`);
  L.push('');

  // §2 — Stage counts
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — STAGE COUNTS');
  L.push(`  ${SEP2}`, '');
  L.push('  dex-watch runs shown (most recent):');
  if (result.recentDexWatchRuns.length === 0) {
    L.push('    (none)');
  } else {
    for (const r of result.recentDexWatchRuns) {
      L.push(`    ${r.fileName.padEnd(36)} outcomes=${String(r.outcomesTotal).padStart(3)}  with_m5=${String(r.withM5).padStart(3)}  ${r.generatedAt ?? ''}`);
    }
  }
  L.push('');
  L.push('  Cycle JSONL files shown (most recent):');
  if (result.recentCycleFiles.length === 0) {
    L.push('    (none)');
  } else {
    for (const c of result.recentCycleFiles) {
      L.push(`    ${c.fileName.padEnd(36)} rows=${String(c.rowCount).padStart(3)}  m5_non_null=${String(c.withM5NonNull).padStart(3)}  dex_m5=${String(c.withDexScreenerM5).padStart(3)}  ${c.capturedAt ?? ''}`);
    }
  }
  L.push('');
  L.push('  Paper intents:');
  L.push(`    Total       : ${result.intentsTotal}`);
  L.push(`    Open        : ${result.intentsOpen}`);
  L.push(`    Entry due   : ${result.intentsDue}`);
  L.push(`    Observed    : ${result.intentsObserved}`);
  L.push(`    Expired     : ${result.intentsExpired}`);
  L.push(`  Observations  : ${result.observationsTotal}`);
  L.push(`  Learning memory rows: ${result.memoryTotal}`);
  L.push('');

  // §3 — Freshness gaps
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — FRESHNESS GAPS');
  L.push(`  ${SEP2}`, '');
  L.push(`  Stale threshold: ${STALE_MINUTES} minutes`);
  L.push('');
  for (const g of result.freshnessGaps) {
    const flag = g.stale ? '  ⚠ STALE' : '  ✓ ok';
    L.push(`  ${g.fromStage.padEnd(22)} → ${g.toStage.padEnd(22)} gap=${fmtGap(g.gapMinutes)}${flag}`);
  }
  L.push('');

  // §4 — M5 propagation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — ENTRY MOMENTUM (M5) PROPAGATION');
  L.push(`  ${SEP2}`, '');

  L.push('  All-time totals:');
  L.push(`    Latest cycle total rows        : ${result.latestCycleTotalRows}`);
  L.push(`    Latest cycle rows with M5      : ${result.latestCycleM5NonNull}  (entryMomentumPct non-null)`);
  L.push(`    Latest cycle rows DEX_M5       : ${result.latestCycleM5DexScreener}  (source=DEX_SCREENER_M5)`);
  L.push(`    Paper intents with M5 (all)    : ${result.intentsWithM5}  / ${result.intentsTotal}`);
  L.push(`    Observations with M5 (all)     : ${result.observationsWithM5}  / ${result.observationsTotal}`);
  L.push(`    Memory rows with M5 (all)      : ${result.memoryWithM5}  / ${result.memoryTotal}`);
  L.push('');

  L.push(`  Recent ${result.recentRowsForM5} rows per stage:`);
  L.push(`    Recent intents with M5         : ${result.recentIntentsWithM5}  / ${Math.min(result.recentRowsForM5, result.intentsTotal)}`);
  L.push(`    Recent observations with M5    : ${result.recentObsWithM5}  / ${Math.min(result.recentRowsForM5, result.observationsTotal)}`);
  L.push(`    Recent memory rows with M5     : ${result.recentMemoryWithM5}  / ${Math.min(result.recentRowsForM5, result.memoryTotal)}`);
  L.push('');

  if (result.cycleJoinSampleSize > 0) {
    L.push('  Cycle-join availability (for recent intents without direct M5):');
    L.push(`    Intents without direct M5      : ${result.cycleJoinSampleSize}`);
    L.push(`    M5 available via cycle join    : ${result.m5AvailableViaCycleJoin}  (simulation can recover these)`);
    L.push(`    M5 unavailable even via join   : ${result.m5NotAvailableViaCycleJoin}  (cycle file also has no M5)`);
    L.push('');
  }

  L.push(`  M5 persistence status          : ${result.m5PersistenceStatus}`);
  L.push(`  M5 stops at (all-time)         : ${result.m5StopsAt}`);
  L.push('');

  // Contextual note based on status
  if (result.m5PersistenceStatus === 'M5_ONLY_AVAILABLE_BY_CYCLE_JOIN') {
    L.push('  ⚠ Recent paper intents do NOT carry entryMomentumPct directly.');
    L.push('    However, the simulation report can recover M5 via the cycle-join fallback.');
    L.push('    This means: the schema fix (ce9bba0) is deployed but token:ripper-paper-');
    L.push('    autopilot-cycle has not yet run to create NEW intents with the fix active.');
    L.push('    Action: run token:ripper-paper-autopilot-cycle once a new cycle is available.');
  } else if (result.m5PersistenceStatus === 'M5_FULLY_PERSISTED') {
    L.push('  ✓ M5 is persisted on recent records at all three stages.');
  } else if (result.m5PersistenceStatus === 'M5_INTENTS_OK_OBSERVATIONS_STALE') {
    L.push('  ℹ New intents carry M5 — observations not yet observed with M5 data.');
  } else if (result.m5PersistenceStatus === 'M5_OBSERVATIONS_OK_MEMORY_STALE') {
    L.push('  ℹ Observations carry M5 — memory rebuild not yet run with M5 rows.');
  } else if (result.m5PersistenceStatus === 'M5_NEW_ROWS_NOT_CREATED_YET') {
    L.push('  ℹ No paper intents have been created yet. Run token:ripper-paper-autopilot-cycle.');
  } else {
    L.push('  ⚠ M5 not persisted to any stage or not captured in cycle rows.');
  }
  L.push('');

  // §5 — Contract sample
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 5 — CONTRACT PROPAGATION SAMPLE (source: ${result.sampleSourceLabel})`);
  L.push(`  ${SEP2}`, '');
  if (result.contractSample.length === 0) {
    L.push('  (no contracts found in source)');
  } else {
    L.push(`  ${'symbol'.padEnd(16)} ${'contract (prefix)'.padEnd(20)} ${'cycle'.padStart(5)} ${'intent'.padStart(6)} ${'obs'.padStart(5)} ${'mem'.padStart(5)} ${'m5_in_cycle'.padStart(12)}`);
    L.push(`  ${'-'.repeat(16)} ${'-'.repeat(20)} ${'-----'} ${'------'} ${'-----'} ${'-----'} ${'------------'}`);
    for (const t of result.contractSample) {
      const sym  = (t.symbol ?? 'unknown').slice(0, 15).padEnd(16);
      const con  = t.contract.slice(0, 18).padEnd(20);
      const cyc  = (t.inCycle        ? '  yes' : '   no');
      const int_ = (t.inIntents      ? '   yes' : '    no');
      const obs  = (t.inObservations ? '  yes' : '   no');
      const mem  = (t.inMemory       ? '  yes' : '   no');
      const m5   = t.m5InLatestCycle != null ? `${t.m5InLatestCycle.toFixed(1)}%` : 'n/a';
      L.push(`  ${sym} ${con} ${cyc} ${int_} ${obs} ${mem} ${m5.padStart(12)}`);
    }
  }
  L.push('');

  // §6 — Diagnosis
  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — DIAGNOSIS');
  L.push(`  ${SEP2}`, '');
  for (const d of result.diagnoses) {
    const ok = d === 'HEALTHY_FLOW' || d === 'M5_FULLY_PERSISTED';
    L.push(`  ${ok ? '✓' : '⚠'} ${d}`);
  }
  L.push('');

  // §7 — Next actions
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — RECOMMENDED NEXT ACTIONS');
  L.push(`  ${SEP2}`, '');
  L.push('  (Report only — no auto-fix)');
  L.push('');
  for (const a of result.nextActions) {
    L.push(`  • ${a}`);
  }
  L.push('');

  // §8 — Safety
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true    READ_ONLY=true    PAPER_ONLY=true    NO_MUTATION=true');
  L.push('  NO_REAL_TRADING=true   NO_GATE_CHANGES=true   NO_WALLET=true');
  L.push('  NO_SWAP=true           NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING    tradingExecuted=0    realTradingLocked=true');
  L.push('  No data files mutated.  No gates changed.  No autopilot actions taken.');
  L.push(SEP, '');

  return L.join('\n');
}
