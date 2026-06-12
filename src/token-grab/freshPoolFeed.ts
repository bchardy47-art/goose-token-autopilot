import * as fs from 'fs';
import * as path from 'path';
import type { RipperEarSignal } from './ripperEars';

// ── Default paths ─────────────────────────────────────────────────────────────

const DEFAULT_RUNS_DIR    = 'data/token-grab/dex-watch-runs';
const DEFAULT_OUTPUT_PATH = 'data/token-grab/ripper/ripper-ears-input.json';
// Matches DEFAULT_RIPPER_CONFIG.primeWindowMaxMinutes — signals older than this will score as
// LATE or DEAD in the ripper, so pre-filter them here before enrichment/scoring.
const DEFAULT_MAX_AGE_MIN = 20;

const NEXT_STEP_LINES = [
  '  Run a fresh watch cycle to generate new pool data:',
  '    npm run token:dex-day-watch',
  '  Then retry:',
  '    npm run token:fresh-pool-feed',
  '    npm run token:live-fixture-capture',
];

// ── Thin source types ─────────────────────────────────────────────────────────

interface DexPairSnapshotRaw {
  contract: string;
  chainId?: string;
  pairAddress?: string;
  pairUrl?: string;
  symbol?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
  observedAt: string;
}

interface DexWatchOutcomeRaw {
  signalId?: string;
  contract: string;
  symbol?: string;
  chainId?: string;
  pairUrl?: string;
  entry?: DexPairSnapshotRaw;
  final?: DexPairSnapshotRaw;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeToLiquidityRatio?: number;
  classification?: string;
  [key: string]: unknown;
}

interface DexWatchRunFileRaw {
  generatedAt?: string;
  signalsRead?: number;
  winners?: DexWatchOutcomeRaw[];
  losers?: DexWatchOutcomeRaw[];
  flat?: DexWatchOutcomeRaw[];
  missing?: DexWatchOutcomeRaw[];
  [key: string]: unknown;
}

interface FreshPoolRaw {
  id?: string;
  contractAddress?: string;
  ticker?: string;
  tokenName?: string;
  createdAt?: string;
  liquidityUsd?: number;
  volume5mUsd?: number;
  poolAddress?: string;
  source?: string;
  [key: string]: unknown;
}

// ── Converters (pure) ─────────────────────────────────────────────────────────

function confidenceFromClassification(
  classification: string | undefined,
  priceChangePct: number | undefined,
): 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' {
  if (classification === 'winner') {
    return (priceChangePct ?? 0) >= 40 ? 'HIGH' : 'MEDIUM';
  }
  if (classification === 'flat') return 'LOW';
  return 'UNKNOWN';
}

export function dexWatchOutcomeToEarSignal(
  outcome: DexWatchOutcomeRaw,
  nowIso: string,
): RipperEarSignal {
  const discoveredAt = outcome.entry?.observedAt ?? nowIso;
  const id = `dexwatch:${outcome.contract}:${discoveredAt.slice(0, 13).replace('T', '-')}`;

  const warnings: string[] = [];
  if (!outcome.entry?.observedAt) {
    warnings.push('entry.observedAt missing — using now as discoveredAt (age will be 0)');
  }

  const signalReasons: string[] = [];
  if (outcome.classification) signalReasons.push(`classification:${outcome.classification}`);
  if (outcome.priceChangePct != null) {
    const sign = outcome.priceChangePct >= 0 ? '+' : '';
    signalReasons.push(`price ${sign}${outcome.priceChangePct.toFixed(1)}%`);
  }
  if (outcome.liquidityChangePct != null) {
    const sign = outcome.liquidityChangePct >= 0 ? '+' : '';
    signalReasons.push(`liquidity ${sign}${outcome.liquidityChangePct.toFixed(1)}%`);
  }

  return {
    id,
    source: 'dex-watch-run',
    sourceKind: 'DEX_NEW_POOL',
    contract: outcome.contract,
    symbol: outcome.symbol,
    url: outcome.pairUrl ?? outcome.entry?.pairUrl,
    poolAddress: outcome.entry?.pairAddress,
    discoveredAt,
    observedAt: nowIso,
    confidence: confidenceFromClassification(outcome.classification, outcome.priceChangePct),
    signalReasons,
    warnings,
    liquidityUsd: outcome.entry?.liquidityUsd,
    volumeUsd: outcome.entry?.volumeUsd,
    priceChangePct: outcome.priceChangePct,
    liquidityChangePct: outcome.liquidityChangePct,
    volumeLiquidityRatio: outcome.volumeToLiquidityRatio,
    raw: outcome,
  };
}

// Converter for FreshPool format (fixtures/token-grab/fresh-pools.json, geckoFreshPools output)
export function freshPoolToEarSignal(
  pool: FreshPoolRaw,
  nowIso: string,
): RipperEarSignal | null {
  if (!pool.contractAddress) return null;

  const discoveredAt = pool.createdAt ?? nowIso;
  const id = `geckofp:${pool.contractAddress}:${discoveredAt.slice(0, 13).replace('T', '-')}`;

  const warnings: string[] = [];
  if (!pool.createdAt) {
    warnings.push('createdAt missing — using now as discoveredAt (age may be inaccurate)');
  }

  const liquidityUsd = pool.liquidityUsd;
  const volumeUsd    = pool.volume5mUsd;
  let vlr: number | undefined;
  if (volumeUsd != null && liquidityUsd != null && liquidityUsd > 0) {
    vlr = volumeUsd / liquidityUsd;
  }

  const signalReasons: string[] = ['source:gecko-fresh-pool'];
  if (liquidityUsd != null) signalReasons.push(`liquidity $${liquidityUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

  return {
    id,
    source: 'gecko-fresh-pools',
    sourceKind: 'DEX_NEW_POOL',
    contract: pool.contractAddress,
    symbol: pool.ticker,
    name: pool.tokenName,
    poolAddress: pool.poolAddress,
    discoveredAt,
    observedAt: nowIso,
    confidence: liquidityUsd != null && liquidityUsd >= 10_000 ? 'MEDIUM' : 'LOW',
    signalReasons,
    warnings,
    liquidityUsd,
    volumeUsd,
    volumeLiquidityRatio: vlr,
    raw: pool,
  };
}

// ── Age helpers ───────────────────────────────────────────────────────────────

export function ageMinutes(isoTimestamp: string, nowMs: number): number {
  return (nowMs - new Date(isoTimestamp).getTime()) / 60_000;
}

function withinAgeLimit(discoveredAt: string, nowMs: number, maxAgeMinutes: number): boolean {
  return ageMinutes(discoveredAt, nowMs) <= maxAgeMinutes;
}

// ── Run-file discovery ────────────────────────────────────────────────────────

export function findMostRecentRunFile(runsDir: string): string | null {
  if (!fs.existsSync(runsDir)) return null;
  try {
    const files = fs.readdirSync(runsDir)
      .filter(f => f.startsWith('run-') && f.endsWith('.json'))
      .sort()
      .reverse();
    return files.length > 0 ? path.join(runsDir, files[0]) : null;
  } catch {
    return null;
  }
}

export function loadOutcomesFromRunFile(
  filePath: string,
): { outcomes: DexWatchOutcomeRaw[]; generatedAt: string | null; warnings: string[] } {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DexWatchRunFileRaw;
    const outcomes: DexWatchOutcomeRaw[] = [
      ...(raw.winners ?? []),
      ...(raw.flat ?? []),
      ...(raw.losers ?? []),
      ...(raw.missing ?? []),
    ];
    return { outcomes, generatedAt: raw.generatedAt ?? null, warnings: [] };
  } catch (err) {
    return {
      outcomes: [],
      generatedAt: null,
      warnings: [`could not parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

// ── Options / Result ──────────────────────────────────────────────────────────

export interface FreshPoolFeedOptions {
  runsDir?: string;
  outputPath?: string;
  maxAgeMinutes?: number;
  includeOld?: boolean;
  nowMs?: number;
}

export interface FreshPoolFeedResult {
  sourceUsed: string | null;
  sourceType: 'dex-watch-run' | null;
  sourceMissing: boolean;          // true ONLY when no run files exist at all
  noFreshSignals: boolean;         // true when run file found but all candidates too old
  nextStep: string | null;
  outputPath: string;
  rawCandidatesRead: number;
  signalsWritten: number;
  skippedOldCount: number;
  freshestAgeMinutes: number | null;
  primeWindowCount: number;
  signals: RipperEarSignal[];
  warnings: string[];
  writeVerified: boolean;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

function makeEmptyResult(outputPath: string): FreshPoolFeedResult {
  return {
    sourceUsed: null,
    sourceType: null,
    sourceMissing: true,
    noFreshSignals: false,
    nextStep: 'npm run token:dex-day-watch',
    outputPath,
    rawCandidatesRead: 0,
    signalsWritten: 0,
    skippedOldCount: 0,
    freshestAgeMinutes: null,
    primeWindowCount: 0,
    signals: [],
    warnings: [],
    writeVerified: false,
    tradingExecuted: 0,
    noRealTradeSent: true,
    paperOnly: true,
    readOnly: true,
  };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export function runFreshPoolFeed(options: FreshPoolFeedOptions = {}): FreshPoolFeedResult {
  const nowMs         = options.nowMs ?? Date.now();
  const nowIso        = new Date(nowMs).toISOString();
  const maxAgeMinutes = options.maxAgeMinutes ?? DEFAULT_MAX_AGE_MIN;
  const includeOld    = options.includeOld ?? false;
  const runsDir       = options.runsDir ?? DEFAULT_RUNS_DIR;
  const outputPath    = options.outputPath ?? DEFAULT_OUTPUT_PATH;

  const allWarnings: string[] = [];

  // Find most recent run file
  const runFilePath = findMostRecentRunFile(runsDir);
  if (!runFilePath) {
    return {
      ...makeEmptyResult(outputPath),
      warnings: ['no run files found in ' + runsDir],
    };
  }

  // Load outcomes
  const { outcomes, warnings: loadWarnings } = loadOutcomesFromRunFile(runFilePath);
  allWarnings.push(...loadWarnings);
  const rawCandidatesRead = outcomes.length;

  // Convert to signals
  const allSignals = outcomes.map(o => dexWatchOutcomeToEarSignal(o, nowIso));

  // Age filter
  let filteredSignals: RipperEarSignal[];
  let skippedOldCount: number;

  if (includeOld) {
    filteredSignals = allSignals;
    skippedOldCount = 0;
  } else {
    filteredSignals = allSignals.filter(s => withinAgeLimit(s.discoveredAt, nowMs, maxAgeMinutes));
    skippedOldCount = allSignals.length - filteredSignals.length;
  }

  // No fresh signals — do not write anything, guide user to run dex-day-watch
  if (filteredSignals.length === 0) {
    const note = skippedOldCount > 0
      ? `all ${skippedOldCount} candidates from ${path.basename(runFilePath)} are older than ${maxAgeMinutes}m — run token:dex-day-watch for fresh data`
      : `no candidates in ${path.basename(runFilePath)}`;
    return {
      ...makeEmptyResult(outputPath),
      sourceUsed: runFilePath,
      sourceMissing: false,
      noFreshSignals: true,
      rawCandidatesRead,
      skippedOldCount,
      warnings: [note, ...allWarnings],
    };
  }

  // Freshness metrics
  const ages = filteredSignals
    .map(s => ageMinutes(s.discoveredAt, nowMs))
    .filter(a => isFinite(a) && a >= 0);
  const freshestAgeMinutes = ages.length > 0 ? Math.min(...ages) : null;
  const primeWindowCount = filteredSignals.filter(s => {
    const age = ageMinutes(s.discoveredAt, nowMs);
    return age >= 2 && age <= 20;
  }).length;

  // Write output
  let writeVerified = false;
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ signals: filteredSignals }, null, 2), 'utf-8');
    writeVerified = fs.existsSync(outputPath);
  } catch (err) {
    allWarnings.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    sourceUsed: runFilePath,
    sourceType: 'dex-watch-run',
    sourceMissing: false,
    noFreshSignals: false,
    nextStep: null,
    outputPath,
    rawCandidatesRead,
    signalsWritten: filteredSignals.length,
    skippedOldCount,
    freshestAgeMinutes,
    primeWindowCount,
    signals: filteredSignals,
    warnings: allWarnings,
    writeVerified,
    tradingExecuted: 0,
    noRealTradeSent: true,
    paperOnly: true,
    readOnly: true,
  };
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function fmtAge(m: number | null): string {
  if (m == null) return 'n/a';
  if (m < 1) return '<1m';
  if (m < 60) return `${m.toFixed(0)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export function renderFreshPoolFeedResult(result: FreshPoolFeedResult, debug = false): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — FRESH POOL FEED');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  if (result.sourceMissing && !result.sourceUsed) {
    lines.push('  No run files found. Run a fresh watch cycle first:');
    lines.push('');
    for (const l of NEXT_STEP_LINES) lines.push(l);
    lines.push('');
    for (const w of result.warnings) lines.push(`  ⚠ ${w}`);
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  if (result.noFreshSignals) {
    lines.push(`  Source: ${result.sourceUsed}`);
    lines.push(`  Read  : ${result.rawCandidatesRead} candidates, ${result.skippedOldCount} too old`);
    lines.push('');
    lines.push('  No fresh signals within age limit. Run a new watch cycle:');
    lines.push('');
    for (const l of NEXT_STEP_LINES) lines.push(l);
    lines.push('');
    for (const w of result.warnings) lines.push(`  ⚠ ${w}`);
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`  Source         : ${result.sourceUsed}`);
  lines.push(`  Raw candidates : ${result.rawCandidatesRead}`);
  lines.push(`  Skipped (old)  : ${result.skippedOldCount}`);
  lines.push(`  Signals written: ${result.signalsWritten}`);
  lines.push(`  Freshest age   : ${fmtAge(result.freshestAgeMinutes)}`);
  lines.push(`  Prime window   : ${result.primeWindowCount}`);

  if (result.writeVerified) {
    lines.push(`  ✓ Written      : ${result.outputPath}`);
  } else {
    lines.push(`  ✗ WRITE FAILED : ${result.outputPath}`);
    lines.push('    Check directory permissions and disk space.');
  }
  lines.push('');

  if (result.warnings.length > 0) {
    for (const w of result.warnings) lines.push(`  ⚠ ${w}`);
    lines.push('');
  }

  if (debug) {
    lines.push('  ── DEBUG: SIGNALS ──');
    for (const s of result.signals.slice(0, 20)) {
      const sym = s.symbol ? `$${s.symbol}` : (s.contract ?? '').slice(0, 10) + '…';
      const age = fmtAge(ageMinutes(s.discoveredAt, Date.now()));
      lines.push(`  ${sym.padEnd(14)} age=${age.padEnd(6)} ${s.confidence.padEnd(8)} ${s.signalReasons.slice(0, 2).join(', ')}`);
    }
    if (result.signals.length > 20) lines.push(`  … and ${result.signals.length - 20} more`);
    lines.push('');
  }

  lines.push('  Next: npm run token:live-fixture-capture');
  lines.push('');
  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderFreshPoolFeedUsage(): string {
  return `
token:fresh-pool-feed — feed the ripper from fresh pool watch-run data

Usage:
  npm run token:fresh-pool-feed [options]

Options:
  --runs-dir <path>         watch run directory (default: data/token-grab/dex-watch-runs)
  --output <path>           output path (default: data/token-grab/ripper/ripper-ears-input.json)
  --max-age-minutes <n>     only include pools ≤ n minutes old (default: 20)
  --include-old             bypass age filter, include all candidates
  --debug                   print per-signal details
  --help                    show this message

Age classification:
  0–2m    TOO_EARLY (ripper will not buy, but captures the signal)
  2–20m   PRIME_WINDOW (ripper target zone)
  >20m    LATE/DEAD — filtered out by default (matches ripper prime window)

If no fresh source exists:
  Run: npm run token:dex-day-watch
  Then retry: npm run token:fresh-pool-feed

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Read-only.
`.trim();
}
