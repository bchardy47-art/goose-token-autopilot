// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  noApiCalls=true
//
// BubbleMaps Live-Runner Coverage Diagnostic v1 — explains, from data only, WHY
// BubbleMaps calls are not clearing the live runner's UNKNOWN blocker. It cross-checks
// the live runner's top candidates against the BubbleMaps cache and learning memory and
// shows exactly where coverage breaks: not prioritized, returns UNKNOWN, not propagated,
// runner reads raw rows, cap too low, stale cache, etc.
//
// Makes NO API calls, mutates nothing, never treats UNKNOWN as CLEAN.

import * as fs   from 'fs';
import * as path from 'path';

import { BUBBLEMAPS_CACHE_TTL_MS, DEFAULT_CACHE_PATH } from './bubbleMapsCache';

const DEFAULT_CYCLES_DIR  = 'data/token-grab/ripper/cycles';
const DEFAULT_MEMORY_PATH = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_TOP_N       = 10;
const DEFAULT_LAST_CALLS  = 15;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ───────────────────────────────────────────────────────────────────────

export type ClusterCat = 'CLEAN' | 'WATCH' | 'RISKY' | 'UNKNOWN' | 'MISSING';

export interface CandidateCoverageRow {
  rank:               number;
  contract:           string;
  symbol:             string | null;
  buyGateDecision:    string | null;
  hasM5:              boolean;
  rawClusterRisk:     ClusterCat;       // what the live runner currently sees (raw cycle)
  inCache:            boolean;
  cacheRisk:          ClusterCat | null;
  cacheFresh:         boolean | null;   // null when not cached
  cacheAgeHours:      number | null;
  inMemoryKnown:      boolean;          // learning memory has a known cluster for this contract
  memoryRisk:         ClusterCat | null;
  // derived per-candidate signals
  calledReturnedUnknown: boolean;       // cache present & UNKNOWN
  calledReturnedKnown:   boolean;       // cache present & known (CLEAN/WATCH/RISKY)
  knownButNotPropagated: boolean;       // fresh known available but raw cycle still UNKNOWN
  skippedDueToCapLikely: boolean;       // approved UNKNOWN, not cached, and cap pressure present
  liveRunnerWouldSeeUnknown: boolean;   // final: does the runner still see UNKNOWN today?
}

export interface RecentCallTarget {
  contract:        string;
  cachedAt:        string;
  cacheRisk:       ClusterCat;
  classification:  'CURRENT_APPROVED' | 'CURRENT_REJECTED' | 'NOT_IN_CURRENT_CYCLE' | 'DUPLICATE';
  // UNKNOWN reason visibility fields (populated from cache result)
  unknownReason:   string | null;
  httpStatus:      number | null;
  errorMessage:    string | null;
  chain:           string | null;
  symbol:          string | null;
}

export type CoverageDiagnosis =
  | 'LIVE_RUNNER_CANDIDATES_NOT_PRIORITIZED'
  | 'BUBBLEMAPS_CALLS_RETURN_UNKNOWN'
  | 'BUBBLEMAPS_RESULTS_NOT_PROPAGATED'
  | 'LIVE_RUNNER_READS_RAW_UNENRICHED_ROWS'
  | 'APPROVED_FIRST_ONLY_SIMULATED_NOT_IMPLEMENTED'
  | 'CAP_TOO_LOW_FOR_INCOMING_UNKNOWN_VOLUME'
  | 'DUPLICATE_CALL_WASTE'
  | 'CACHE_NOT_REUSED'
  | 'COVERAGE_PATH_WORKING'
  | 'UNKNOWN_REMAINS_VALID_BLOCKER'
  | 'REPORT_ONLY_NO_POLICY_CHANGE';

export interface CoverageDiagnosticResult {
  generatedAt:       string;
  latestCycleFile:   string | null;

  topCandidates:     CandidateCoverageRow[];
  approvedUnknownTotal: number;
  approvedTotal:     number;
  cacheEntryCount:   number;
  cacheFreshKnownCount: number;
  cacheStaleCount:   number;
  recentCalls:       RecentCallTarget[];
  recentCallsOnCurrentApproved: number;
  recentCallsOnRejectedOrOld:   number;

  // UNKNOWN reason breakdown (counts from cache entries with clusterRisk=UNKNOWN)
  unknownReasonCounts:          Partial<Record<string, number>>;
  unknownWithoutReason:         number;  // legacy cache entries lacking unknownReason field

  // structural facts
  liveRunnerReadsRawRows: boolean;        // the runner sources clusterRisk from raw cycle only
  approvedFirstImplemented: boolean;      // approved-first actually drives the call lane
  observedPerRunCap: number | null;

  diagnoses:         CoverageDiagnosis[];
  explanation:       string[];

  // safety
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  noMutation:        true;
  noApiCalls:        true;
  noRealTrading:     true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface CoverageDiagnosticOptions {
  cyclesDir?:   string;
  cachePath?:   string;
  memoryPath?:  string;
  topN?:        number;
  lastCalls?:   number;
  now?:         Date;
  generatedAt?: string;
  // Structural inputs (default reflect the SHIPPED behavior; the product acceptance
  // and wiring update these as the live runner adopts the resolver / targeting).
  liveRunnerReadsRawRows?:   boolean;
  approvedFirstImplemented?: boolean;
  observedPerRunCap?:        number | null;
}

// ── Raw readers ──────────────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

function normCluster(v: unknown): ClusterCat {
  if (typeof v !== 'string') return 'MISSING';
  const u = v.trim().toUpperCase();
  if (u === 'CLEAN' || u === 'WATCH' || u === 'RISKY' || u === 'UNKNOWN') return u;
  return 'MISSING';
}

interface CacheEntry {
  contract?: string;
  cachedAt?: string;
  result?: {
    clusterRisk?:      string;
    unknownReason?:    string;
    httpStatus?:       number;
    clusterFetchError?: string;
    clusterNotes?:     string[];
    chain?:            string;
  };
}
interface CycleRow {
  capturedAt?: string; buyGateDecision?: string; entryMomentumPct?: number | null;
  normalizedSignal?: { contract?: string; symbol?: string };
  raw?: { contract?: string; clusterRisk?: string };
}
interface MemRow { contract?: string; clusterRisk?: string; observedAt?: string | null; capturedAt?: string }

function latestCycleFile(cyclesDir: string): string | null {
  if (!fs.existsSync(cyclesDir)) return null;
  const files = fs.readdirSync(cyclesDir).filter(f => /^cycle-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(f)).sort();
  return files.at(-1) ?? null;
}

// ── Main runner ──────────────────────────────────────────────────────────────────

export function runCoverageDiagnostic(opts: CoverageDiagnosticOptions = {}): CoverageDiagnosticResult {
  const cyclesDir  = opts.cyclesDir  ?? DEFAULT_CYCLES_DIR;
  const cachePath  = opts.cachePath  ?? DEFAULT_CACHE_PATH;
  const memoryPath = opts.memoryPath ?? DEFAULT_MEMORY_PATH;
  const topN       = opts.topN       ?? DEFAULT_TOP_N;
  const lastCalls  = opts.lastCalls  ?? DEFAULT_LAST_CALLS;
  const now        = opts.now        ?? new Date();
  const generatedAt = opts.generatedAt ?? now.toISOString();
  // Default structural facts reflect the shipped live runner (reads raw rows; no real
  // approved-first targeting). Callers that have wired the resolver/targeting pass true/false.
  const liveRunnerReadsRawRows  = opts.liveRunnerReadsRawRows ?? true;
  const approvedFirstImplemented = opts.approvedFirstImplemented ?? false;

  // ── Cache index ───────────────────────────────────────────────────────────────
  const cacheRows = readJsonl<CacheEntry>(cachePath);
  const cacheByContract = new Map<string, { risk: ClusterCat; cachedAt: string }>();
  for (const c of cacheRows) {
    if (!c.contract) continue;
    // last-write-wins (JSONL append order)
    cacheByContract.set(c.contract, { risk: normCluster(c.result?.clusterRisk), cachedAt: c.cachedAt ?? '' });
  }
  const ageHours = (iso: string): number | null => {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return null;
    return (now.getTime() - t) / 3_600_000;
  };
  const isFresh = (iso: string): boolean => {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return false;
    return now.getTime() - t <= BUBBLEMAPS_CACHE_TTL_MS;
  };

  let cacheFreshKnownCount = 0, cacheStaleCount = 0;
  for (const [, v] of cacheByContract) {
    const fresh = isFresh(v.cachedAt);
    if (!fresh) cacheStaleCount++;
    else if (v.risk === 'CLEAN' || v.risk === 'WATCH' || v.risk === 'RISKY') cacheFreshKnownCount++;
  }

  // ── Memory index (known cluster only) ─────────────────────────────────────────
  const memByContract = new Map<string, ClusterCat>();
  for (const m of readJsonl<MemRow>(memoryPath)) {
    if (!m.contract) continue;
    const r = normCluster(m.clusterRisk);
    if (r === 'CLEAN' || r === 'WATCH' || r === 'RISKY') memByContract.set(m.contract, r);
  }

  // ── UNKNOWN reason counts from all cache entries ──────────────────────────────
  const unknownReasonCounts: Partial<Record<string, number>> = {};
  let unknownWithoutReason = 0;
  for (const c of cacheRows) {
    if (normCluster(c.result?.clusterRisk) !== 'UNKNOWN') continue;
    const reason = c.result?.unknownReason;
    if (reason) {
      unknownReasonCounts[reason] = (unknownReasonCounts[reason] ?? 0) + 1;
    } else {
      // Legacy entry — infer from available fields
      const status = c.result?.httpStatus;
      const err = c.result?.clusterFetchError ?? '';
      const notes = (c.result?.clusterNotes ?? []).join(' ');
      const inferred =
        status === 404 ? 'NO_MAP_YET' :
        status === 400 && !err ? 'NO_MAP_YET' :
        status === 400 && err.includes('unsupported chain') ? 'UNSUPPORTED_CHAIN' :
        status === 400 && err.includes('invalid contract') ? 'INVALID_CONTRACT' :
        status === 400 ? 'PROVIDER_ERROR' :
        status === 401 || status === 403 ? 'AUTH_ERROR' :
        status === 429 ? 'RATE_LIMITED' :
        err.includes('timeout') || err.includes('aborted') ? 'TIMEOUT' :
        err.includes('JSON') || err.includes('parse') ? 'PARSE_ERROR' :
        err.includes('empty') ? 'EMPTY_RESPONSE' :
        notes.includes('not yet available') ? 'NO_MAP_YET' :
        status === 200 ? 'UNKNOWN_UNCLASSIFIED' :
        null;
      if (inferred) {
        unknownReasonCounts[inferred] = (unknownReasonCounts[inferred] ?? 0) + 1;
      } else {
        unknownWithoutReason++;
      }
    }
  }

  // ── Latest cycle: approved candidates (the live runner's universe) ────────────
  const cycleFile = latestCycleFile(cyclesDir);
  const cycleRows = cycleFile ? readJsonl<CycleRow>(path.join(cyclesDir, cycleFile)) : [];
  const approvedRows = cycleRows.filter(r => r.buyGateDecision === 'BUY_APPROVED_PAPER');
  const rejectedContracts = new Set(cycleRows
    .filter(r => r.buyGateDecision === 'BUY_REJECTED')
    .map(r => r.normalizedSignal?.contract ?? r.raw?.contract).filter(Boolean) as string[]);
  const approvedContracts = new Set(approvedRows
    .map(r => r.normalizedSignal?.contract ?? r.raw?.contract).filter(Boolean) as string[]);

  // symbol lookup from cycle rows
  const symByContract = new Map<string, string>();
  for (const r of cycleRows) {
    const contract = r.normalizedSignal?.contract ?? r.raw?.contract;
    const symbol   = r.normalizedSignal?.symbol;
    if (contract && symbol) symByContract.set(contract, symbol);
  }

  const approvedTotal = approvedRows.length;
  const approvedUnknownTotal = approvedRows.filter(r => normCluster(r.raw?.clusterRisk) === 'UNKNOWN').length;
  const observedPerRunCap = opts.observedPerRunCap ?? null;
  const capPressure = observedPerRunCap != null && approvedUnknownTotal > observedPerRunCap;

  // Top candidates: prioritise approved+M5+UNKNOWN, then approved+UNKNOWN, then rest —
  // i.e. the order the live runner *should* care about. (This mirrors the intended
  // priority; it does NOT change any policy.)
  const ranked = [...approvedRows]
    .map(r => {
      const contract = r.normalizedSignal?.contract ?? r.raw?.contract ?? 'unknown';
      const hasM5 = typeof r.entryMomentumPct === 'number' && Number.isFinite(r.entryMomentumPct);
      const raw = normCluster(r.raw?.clusterRisk);
      const tier = raw === 'UNKNOWN' ? (hasM5 ? 0 : 1) : 2;  // UNKNOWN+M5 first, then UNKNOWN, then known
      return { r, contract, hasM5, raw, tier };
    })
    .sort((a, b) => a.tier - b.tier);

  const topCandidates: CandidateCoverageRow[] = ranked.slice(0, topN).map((x, i) => {
    const cache = cacheByContract.get(x.contract) ?? null;
    const cacheRisk = cache ? cache.risk : null;
    const cacheFresh = cache ? isFresh(cache.cachedAt) : null;
    const cacheAge = cache ? ageHours(cache.cachedAt) : null;
    const memRisk = memByContract.get(x.contract) ?? null;
    const cachedKnown = cacheRisk != null && (cacheRisk === 'CLEAN' || cacheRisk === 'WATCH' || cacheRisk === 'RISKY');
    const freshKnownAvailable =
      (cachedKnown && cacheFresh === true) || (memRisk != null);
    // What does the live runner see TODAY? Raw row if it reads raw; else best resolved.
    const liveRunnerWouldSeeUnknown = liveRunnerReadsRawRows
      ? x.raw === 'UNKNOWN'
      : (freshKnownAvailable ? false : x.raw === 'UNKNOWN');
    return {
      rank: i + 1,
      contract: x.contract,
      symbol: x.r.normalizedSignal?.symbol ?? null,
      buyGateDecision: 'BUY_APPROVED_PAPER',
      hasM5: x.hasM5,
      rawClusterRisk: x.raw,
      inCache: cache != null,
      cacheRisk,
      cacheFresh,
      cacheAgeHours: cacheAge,
      inMemoryKnown: memRisk != null,
      memoryRisk: memRisk,
      calledReturnedUnknown: cacheRisk === 'UNKNOWN',
      calledReturnedKnown: cachedKnown,
      knownButNotPropagated: freshKnownAvailable && x.raw === 'UNKNOWN' && liveRunnerReadsRawRows,
      skippedDueToCapLikely: x.raw === 'UNKNOWN' && cache == null && capPressure,
      liveRunnerWouldSeeUnknown,
    };
  });

  // ── Recent call targets (last N cache entries by append order) ────────────────
  const recentRaw = cacheRows.slice(-lastCalls);
  const seen = new Set<string>();
  const recentCalls: RecentCallTarget[] = [];
  for (const c of recentRaw) {
    if (!c.contract) continue;
    const dup = seen.has(c.contract);
    seen.add(c.contract);
    const cls: RecentCallTarget['classification'] =
      dup ? 'DUPLICATE' :
      approvedContracts.has(c.contract) ? 'CURRENT_APPROVED' :
      rejectedContracts.has(c.contract) ? 'CURRENT_REJECTED' :
      'NOT_IN_CURRENT_CYCLE';
    const errorMessage = c.result?.clusterFetchError ?? (c.result?.clusterNotes?.[0] ?? null);
    recentCalls.push({
      contract:      c.contract,
      cachedAt:      c.cachedAt ?? '',
      cacheRisk:     normCluster(c.result?.clusterRisk),
      classification: cls,
      unknownReason: c.result?.unknownReason ?? null,
      httpStatus:    c.result?.httpStatus ?? null,
      errorMessage:  errorMessage ?? null,
      chain:         c.result?.chain ?? null,
      symbol:        symByContract.get(c.contract) ?? null,
    });
  }
  const recentCallsOnCurrentApproved = recentCalls.filter(c => c.classification === 'CURRENT_APPROVED').length;
  const recentCallsOnRejectedOrOld = recentCalls.filter(c => c.classification === 'CURRENT_REJECTED' || c.classification === 'NOT_IN_CURRENT_CYCLE').length;
  const duplicateCalls = recentCalls.filter(c => c.classification === 'DUPLICATE').length;

  // ── Diagnoses ─────────────────────────────────────────────────────────────────
  const diagnoses: CoverageDiagnosis[] = [];
  const explanation: string[] = [];

  const anyKnownNotPropagated = topCandidates.some(c => c.knownButNotPropagated);
  const anyFreshKnownInCacheButRunnerRaw = topCandidates.some(c =>
    (c.calledReturnedKnown && c.cacheFresh) || c.inMemoryKnown);

  if (liveRunnerReadsRawRows) {
    diagnoses.push('LIVE_RUNNER_READS_RAW_UNENRICHED_ROWS');
    explanation.push('The live runner sources clusterRisk from the raw latest-cycle row only; it does not consult the BubbleMaps cache or learning memory.');
  }
  if (anyKnownNotPropagated) {
    diagnoses.push('BUBBLEMAPS_RESULTS_NOT_PROPAGATED');
    diagnoses.push('CACHE_NOT_REUSED');
    explanation.push('At least one top candidate has a fresh KNOWN cluster in cache/memory, but the raw cycle row the runner reads still shows UNKNOWN — the result is not propagating into the runner source.');
  }
  if (!approvedFirstImplemented) {
    diagnoses.push('APPROVED_FIRST_ONLY_SIMULATED_NOT_IMPLEMENTED');
    if (recentCallsOnRejectedOrOld > recentCallsOnCurrentApproved) {
      diagnoses.push('LIVE_RUNNER_CANDIDATES_NOT_PRIORITIZED');
      explanation.push(`Recent BubbleMaps calls landed more on rejected/old rows (${recentCallsOnRejectedOrOld}) than on current approved candidates (${recentCallsOnCurrentApproved}) — the budget is not prioritised toward live-runner candidates.`);
    } else {
      explanation.push('Approved-first priority exists only in the simulation report, not in the actual capped call lane.');
    }
  }
  if (topCandidates.some(c => c.calledReturnedUnknown)) {
    diagnoses.push('BUBBLEMAPS_CALLS_RETURN_UNKNOWN');
    explanation.push('Some candidates were called and the provider returned UNKNOWN (disabled/cap/no-route) — UNKNOWN stays UNKNOWN.');
  }
  if (capPressure) {
    diagnoses.push('CAP_TOO_LOW_FOR_INCOMING_UNKNOWN_VOLUME');
    explanation.push(`Approved UNKNOWN volume (${approvedUnknownTotal}) exceeds the per-run cap (${observedPerRunCap}); most approved UNKNOWN rows never get a call.`);
  }
  if (duplicateCalls > 0) {
    diagnoses.push('DUPLICATE_CALL_WASTE');
    explanation.push(`${duplicateCalls} of the last ${recentCalls.length} calls were to a contract already called in the window.`);
  }

  // UNKNOWN remains a valid blocker whenever no fresh-known result is actually available.
  const anyResolvableNow = topCandidates.some(c => !c.liveRunnerWouldSeeUnknown);
  if (!anyResolvableNow) {
    diagnoses.push('UNKNOWN_REMAINS_VALID_BLOCKER');
    explanation.push('No top candidate has a fresh, provider-known cluster available right now — UNKNOWN is a correct, safe blocker (UNKNOWN is never treated as CLEAN).');
  }
  if (!liveRunnerReadsRawRows && approvedFirstImplemented && !anyKnownNotPropagated && anyResolvableNow) {
    diagnoses.push('COVERAGE_PATH_WORKING');
    explanation.push('Targeting + propagation are wired and at least one candidate is resolvable to a known cluster.');
  }

  diagnoses.push('REPORT_ONLY_NO_POLICY_CHANGE');

  return {
    generatedAt,
    latestCycleFile: cycleFile,
    topCandidates,
    approvedUnknownTotal,
    approvedTotal,
    cacheEntryCount: cacheByContract.size,
    cacheFreshKnownCount,
    cacheStaleCount,
    recentCalls,
    recentCallsOnCurrentApproved,
    recentCallsOnRejectedOrOld,
    unknownReasonCounts,
    unknownWithoutReason,
    liveRunnerReadsRawRows,
    approvedFirstImplemented,
    observedPerRunCap,
    diagnoses: dedupe(diagnoses),
    explanation,
    reportOnly: true, readOnly: true, paperOnly: true, noMutation: true, noApiCalls: true,
    noRealTrading: true, realTradingLocked: true, tradingExecuted: 0,
  };
}

function dedupe<T>(a: T[]): T[] { return [...new Set(a)]; }

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderCoverageDiagnostic(r: CoverageDiagnosticResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — BUBBLEMAPS LIVE-RUNNER COVERAGE DIAGNOSTIC');
  L.push('  [REPORT ONLY — NO API CALLS — NO MUTATION — UNKNOWN ≠ CLEAN]');
  L.push('  Explains why BubbleMaps calls are not clearing the live runner UNKNOWN blocker.');
  L.push(SEP, '');

  L.push(`  Generated at        : ${r.generatedAt}`);
  L.push(`  Latest cycle        : ${r.latestCycleFile ?? '(none)'}`);
  L.push(`  Approved rows       : ${r.approvedTotal}  (UNKNOWN: ${r.approvedUnknownTotal})`);
  L.push(`  Cache entries       : ${r.cacheEntryCount}  (fresh-known: ${r.cacheFreshKnownCount}, stale: ${r.cacheStaleCount})`);
  L.push(`  Live runner reads   : ${r.liveRunnerReadsRawRows ? 'RAW cycle rows (unenriched)' : 'ENRICHED via resolver'}`);
  L.push(`  Approved-first       : ${r.approvedFirstImplemented ? 'IMPLEMENTED in call lane' : 'NOT implemented (simulation only)'}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  BUBBLEMAPS UNKNOWN REASONS');
  L.push(`  ${SEP2}`, '');
  const REASON_ORDER = [
    'NO_MAP_YET', 'UNKNOWN_UNCLASSIFIED', 'EMPTY_RESPONSE', 'PARSE_ERROR',
    'AUTH_ERROR', 'RATE_LIMITED', 'PROVIDER_ERROR', 'TIMEOUT',
    'UNSUPPORTED_CHAIN', 'INVALID_CONTRACT', 'OFFLINE', 'CAP_REACHED', 'DISABLED',
  ];
  const allUnknownCount = Object.values(r.unknownReasonCounts).reduce((s, v) => s + (v ?? 0), 0) + r.unknownWithoutReason;
  if (allUnknownCount === 0) {
    L.push('  (no UNKNOWN results in cache)');
  } else {
    L.push('  Reason breakdown from cache entries (all-time UNKNOWN results):');
    for (const reason of REASON_ORDER) {
      const count = r.unknownReasonCounts[reason] ?? 0;
      if (count > 0) L.push(`    ${reason.padEnd(22)}: ${count}`);
    }
    // show any extra reasons not in the canonical list
    for (const [reason, count] of Object.entries(r.unknownReasonCounts)) {
      if (!REASON_ORDER.includes(reason) && (count ?? 0) > 0) {
        L.push(`    ${reason.padEnd(22)}: ${count}`);
      }
    }
    if (r.unknownWithoutReason > 0) {
      L.push(`    ${'(no reason field)'.padEnd(22)}: ${r.unknownWithoutReason}  ← legacy entries; re-run enrichment to classify`);
    }
  }
  L.push('');

  // Recent calls table (last N entries from cache)
  if (r.recentCalls.length > 0) {
    L.push('  Last cache entries (most recent first, read from JSONL tail):');
    L.push(`  ${'symbol'.padEnd(10)} ${'contract'.padEnd(14)} ${'chain'.padEnd(7)} ${'HTTP'.padStart(4)} ${'reason'.padEnd(22)} message`);
    for (const c of [...r.recentCalls].reverse().slice(0, 10)) {
      const sym      = (c.symbol ?? '-').slice(0, 9).padEnd(10);
      const contract = (c.contract.slice(0, 6) + '..' + c.contract.slice(-4)).padEnd(14);
      const chain    = (c.chain ?? '-').slice(0, 6).padEnd(7);
      const status   = c.httpStatus != null ? String(c.httpStatus).padStart(4) : '   -';
      const reason   = (c.unknownReason ?? (c.cacheRisk !== 'UNKNOWN' ? `(${c.cacheRisk})` : '?')).padEnd(22);
      const msg      = (c.errorMessage ?? '').slice(0, 50);
      L.push(`  ${sym} ${contract} ${chain} ${status} ${reason} ${msg}`);
    }
  }
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  TOP LIVE-RUNNER CANDIDATES');
  L.push(`  ${SEP2}`, '');
  if (r.topCandidates.length === 0) L.push('  (no approved candidates in latest cycle)');
  else {
    L.push(`  ${'#'.padStart(2)} ${'symbol'.padEnd(12)} ${'raw'.padEnd(8)} ${'m5'.padEnd(3)} ${'cache'.padEnd(8)} ${'fresh'.padEnd(6)} ${'ageH'.padStart(6)} ${'mem'.padEnd(6)} note`);
    for (const c of r.topCandidates) {
      const note = c.knownButNotPropagated ? 'KNOWN-not-propagated'
        : c.skippedDueToCapLikely ? 'likely cap-skipped'
        : c.calledReturnedUnknown ? 'called→UNKNOWN'
        : c.liveRunnerWouldSeeUnknown ? 'runner sees UNKNOWN' : 'resolvable';
      L.push(
        `  ${String(c.rank).padStart(2)} ` +
        `${(c.symbol ?? c.contract.slice(0, 10)).slice(0, 11).padEnd(12)} ` +
        `${c.rawClusterRisk.padEnd(8)} ` +
        `${(c.hasM5 ? 'yes' : 'no').padEnd(3)} ` +
        `${(c.cacheRisk ?? '-').padEnd(8)} ` +
        `${(c.cacheFresh == null ? '-' : c.cacheFresh ? 'fresh' : 'STALE').padEnd(6)} ` +
        `${(c.cacheAgeHours == null ? '-' : c.cacheAgeHours.toFixed(1)).padStart(6)} ` +
        `${(c.memoryRisk ?? '-').padEnd(6)} ` +
        `${note}`,
      );
    }
  }
  L.push('');

  L.push(`  ${SEP2}`);
  L.push(`  WHERE THE LAST ${r.recentCalls.length} BUBBLEMAPS CACHE ENTRIES WENT`);
  L.push(`  ${SEP2}`, '');
  L.push(`  on current approved : ${r.recentCallsOnCurrentApproved}`);
  L.push(`  on rejected/old     : ${r.recentCallsOnRejectedOrOld}`);
  const cls = (k: string) => r.recentCalls.filter(c => c.classification === k).length;
  L.push(`  breakdown           : approved=${cls('CURRENT_APPROVED')} rejected=${cls('CURRENT_REJECTED')} not-in-cycle=${cls('NOT_IN_CURRENT_CYCLE')} duplicate=${cls('DUPLICATE')}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  DIAGNOSIS');
  L.push(`  ${SEP2}`, '');
  for (const d of r.diagnoses) {
    const neutral = d === 'COVERAGE_PATH_WORKING' || d === 'UNKNOWN_REMAINS_VALID_BLOCKER' || d === 'REPORT_ONLY_NO_POLICY_CHANGE';
    L.push(`  ${neutral ? 'ℹ' : '⚠'} ${d}`);
  }
  L.push('');
  for (const e of r.explanation) L.push(`  • ${e}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true  READ_ONLY=true  PAPER_ONLY=true  NO_MUTATION=true  NO_API_CALLS=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING  tradingExecuted=0  realTradingLocked=true  UNKNOWN≠CLEAN');
  L.push(SEP, '');
  return L.join('\n');
}
