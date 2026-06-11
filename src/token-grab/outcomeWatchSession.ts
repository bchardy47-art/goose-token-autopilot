import * as fs from 'fs';
import * as path from 'path';
import {
  runOutcomeTracker,
  type OutcomeCandidate,
} from './outcomeTracker';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import { extractReadinessFields, classifyReadinessLevel } from './autonomyReadinessAudit';
import { fetchPairSnapshot, type DexPairSnapshot } from './dexWatch';
import { sleep as defaultSleep } from './snapshot';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OutcomeWatchSnapshot {
  observedAt:                string;
  symbol:                    string;
  contract:                  string;
  pairAddress:               string | null;
  pairUrl:                   string | null;
  chainId:                   string;
  entryObservedAt:           string | null;
  entryPriceUsd:             number | null;
  latestPriceUsd:            number | null;
  latestLiquidityUsd:        number | null;
  latestVolumeUsd:           number | null;
  returnPctFromEntry:        number | null;
  holderConcentrationStatus: string | null;
  topHolderPercent:          number | null;
  clusterRisk:               string;
  bubbleMapsScore:           number | null;
  slippageRisk:              string | null;
  estimatedSlippagePct:      number | null;
  source:                    'outcome-watch-session';
}

export interface OutcomeWatchSessionOptions {
  inputPath?:       string;
  outputPath?:      string;
  cycles?:          number;
  intervalSeconds?: number;
  limit?:           number;
  generatedAt?:     string;
  fetch?:           (contract: string, chain: string, observedAt: string) => Promise<DexPairSnapshot | null>;
  sleep?:           (ms: number) => Promise<void>;
  appendLine?:      (filePath: string, line: string) => void;
}

export interface OutcomeWatchSessionResult {
  inputPath:        string;
  outputPath:       string;
  inputMissing:     boolean;
  generatedAt:      string;
  cyclesCompleted:  number;
  candidatesFound:  number;
  snapshotsWritten: number;
  bestReturnPct:    number | null;
  worstReturnPct:   number | null;
  hitTp25Count:     number;
  hitSl15Count:     number;
  snapshots:        OutcomeWatchSnapshot[];
  tradingExecuted:  0;
  noRealTradeSent:  true;
  paperOnly:        true;
  readOnly:         true;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_INPUT  = 'data/token-grab/ripper/live-fixtures.jsonl';
const DEFAULT_OUTPUT = 'data/token-grab/outcomes/outcome-watch-snapshots.jsonl';

const NULL_FETCH = async (): Promise<DexPairSnapshot | null> => null;

const DEFAULT_FETCH = (contract: string, chain: string, observedAt: string) =>
  fetchPairSnapshot(contract, { chain, observedAt });

function defaultAppendLine(filePath: string, line: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line + '\n', 'utf-8');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function toPositiveNum(v: unknown): number | null {
  const n = toNum(v);
  return n !== null && n > 0 ? n : null;
}

// ── Snapshot builder ──────────────────────────────────────────────────────────

export function buildWatchSnapshot(
  candidate: OutcomeCandidate,
  fixture: LiveRipperFixture | undefined,
  latestSnap: DexPairSnapshot | null,
  observedAt: string,
): OutcomeWatchSnapshot {
  const raw         = fixture?.raw as Record<string, unknown> | undefined;
  const ri          = fixture?.ripperInput as Record<string, unknown> | null | undefined;
  const rawEntry    = raw?.['entry'] as Record<string, unknown> | undefined;
  const clusterMets = raw?.['clusterRawMetrics'] as Record<string, unknown> | undefined;

  const entryObservedAt = (rawEntry?.['observedAt'] as string | undefined) ?? null;

  const latestPriceUsd     = toPositiveNum(latestSnap?.priceUsd)     ?? null;
  const latestLiquidityUsd = toPositiveNum(latestSnap?.liquidityUsd) ?? null;
  const latestVolumeUsd    = toPositiveNum(latestSnap?.volumeUsd)    ?? null;

  const pairAddress = latestSnap?.pairAddress ?? candidate.pairAddress ?? null;
  const pairUrl     = latestSnap?.pairUrl     ?? candidate.pairUrl     ?? null;

  const returnPctFromEntry =
    candidate.detectedPriceUsd !== null && latestPriceUsd !== null
      ? ((latestPriceUsd - candidate.detectedPriceUsd) / candidate.detectedPriceUsd) * 100
      : null;

  const holderConcentrationStatus =
    (raw?.['holderConcentrationStatus'] as string | undefined) ?? null;

  const topHolderPercent =
    toNum(raw?.['topHolderPercent']) ?? toNum(ri?.['topHolderPercent']);

  const clusterRisk =
    (raw?.['clusterRisk'] as string | undefined) ?? candidate.clusterRisk;

  const bubbleMapsScore =
    toNum(clusterMets?.['decentralisationScore']) ?? null;

  const slippageRisk =
    (raw?.['slippageRisk'] as string | undefined) ?? null;

  const estimatedSlippagePct =
    toNum(raw?.['estimatedSlippagePct']) ?? null;

  return {
    observedAt,
    symbol:                    candidate.symbol,
    contract:                  candidate.contract,
    pairAddress,
    pairUrl,
    chainId:                   candidate.chainId,
    entryObservedAt,
    entryPriceUsd:             candidate.detectedPriceUsd,
    latestPriceUsd,
    latestLiquidityUsd,
    latestVolumeUsd,
    returnPctFromEntry,
    holderConcentrationStatus,
    topHolderPercent,
    clusterRisk,
    bubbleMapsScore,
    slippageRisk,
    estimatedSlippagePct,
    source:                    'outcome-watch-session',
  };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runOutcomeWatchSession(
  options: OutcomeWatchSessionOptions = {},
): Promise<OutcomeWatchSessionResult> {
  const inputPath       = options.inputPath       ?? DEFAULT_INPUT;
  const outputPath      = options.outputPath      ?? DEFAULT_OUTPUT;
  const cycles          = Math.max(1, options.cycles ?? 1);
  const intervalSeconds = options.intervalSeconds ?? 60;
  const limit           = options.limit;
  const generatedAt     = options.generatedAt     ?? new Date().toISOString();
  const doFetch         = options.fetch           ?? DEFAULT_FETCH;
  const doSleep         = options.sleep           ?? defaultSleep;
  const doAppend        = options.appendLine      ?? defaultAppendLine;

  const emptyResult: OutcomeWatchSessionResult = {
    inputPath, outputPath, inputMissing: true, generatedAt,
    cyclesCompleted: 0, candidatesFound: 0, snapshotsWritten: 0,
    bestReturnPct: null, worstReturnPct: null,
    hitTp25Count: 0, hitSl15Count: 0, snapshots: [],
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };

  // Identify candidates (no price fetch — we fetch per-cycle below)
  const v1Result = await runOutcomeTracker({ inputPath, generatedAt, fetch: NULL_FETCH });
  if (v1Result.inputMissing) return emptyResult;

  // Re-read fixtures for raw field enrichment
  let fixtures: LiveRipperFixture[];
  try {
    fixtures = readFixturesFromJsonl(inputPath);
  } catch {
    return emptyResult;
  }

  // Build fixtureByContract (earliest FUTURE_AUTONOMY_CANDIDATE per contract)
  const fixtureByContract = new Map<string, LiveRipperFixture>();
  for (const fixture of fixtures) {
    const fields = extractReadinessFields(fixture);
    const { level } = classifyReadinessLevel(fields);
    if (level !== 'FUTURE_AUTONOMY_CANDIDATE') continue;
    const raw = fixture.raw as Record<string, unknown> | undefined;
    const ri  = fixture.ripperInput as Record<string, unknown> | null | undefined;
    const entry = raw?.['entry'] as Record<string, unknown> | undefined;
    const contract =
      (entry?.['contract']  as string | undefined) ??
      (raw?.['contract']    as string | undefined) ??
      (ri?.['contract']     as string | undefined) ??
      null;
    if (!contract) continue;
    const existing = fixtureByContract.get(contract);
    if (!existing || fixture.capturedAt < existing.capturedAt) {
      fixtureByContract.set(contract, fixture);
    }
  }

  // Apply limit
  let candidates: OutcomeCandidate[] = v1Result.candidates;
  if (limit != null && limit > 0) candidates = candidates.slice(0, limit);

  const candidatesFound = candidates.length;
  if (candidatesFound === 0) {
    return { ...emptyResult, inputMissing: false, candidatesFound: 0 };
  }

  // Ensure output directory
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  } catch { /* ignore if already exists */ }

  const allSnapshots: OutcomeWatchSnapshot[] = [];
  let snapshotsWritten = 0;
  let cyclesCompleted  = 0;

  for (let cycle = 0; cycle < cycles; cycle++) {
    const observedAt = new Date().toISOString();

    for (const candidate of candidates) {
      const fixture  = fixtureByContract.get(candidate.contract);
      const latestSnap = await doFetch(candidate.contract, candidate.chainId, observedAt);

      const snap = buildWatchSnapshot(candidate, fixture, latestSnap, observedAt);
      allSnapshots.push(snap);
      doAppend(outputPath, JSON.stringify(snap));
      snapshotsWritten++;
    }

    cyclesCompleted++;

    if (cycle < cycles - 1) {
      await doSleep(intervalSeconds * 1_000);
    }
  }

  // Aggregate
  let bestReturnPct:  number | null = null;
  let worstReturnPct: number | null = null;
  let hitTp25Count  = 0;
  let hitSl15Count  = 0;

  // Per-contract: best and worst return seen
  const bestByContract  = new Map<string, number>();
  const worstByContract = new Map<string, number>();

  for (const snap of allSnapshots) {
    const r = snap.returnPctFromEntry;
    if (r === null) continue;
    const prev  = bestByContract.get(snap.contract);
    const prevW = worstByContract.get(snap.contract);
    if (prev  === undefined || r > prev)  bestByContract.set(snap.contract, r);
    if (prevW === undefined || r < prevW) worstByContract.set(snap.contract, r);
    if (bestReturnPct  === null || r > bestReturnPct)  bestReturnPct  = r;
    if (worstReturnPct === null || r < worstReturnPct) worstReturnPct = r;
  }

  for (const best of bestByContract.values()) {
    if (best >= 25) hitTp25Count++;
  }
  for (const worst of worstByContract.values()) {
    if (worst <= -15) hitSl15Count++;
  }

  return {
    inputPath, outputPath, inputMissing: false, generatedAt,
    cyclesCompleted, candidatesFound, snapshotsWritten,
    bestReturnPct, worstReturnPct,
    hitTp25Count, hitSl15Count,
    snapshots: allSnapshots,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fp(n: number | null, d = 1, sign = false): string {
  if (n === null) return '—';
  const s = sign && n >= 0 ? '+' : '';
  return `${s}${n.toFixed(d)}%`;
}

export function renderOutcomeWatchSessionReport(result: OutcomeWatchSessionResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — OUTCOME WATCH SESSION');
  lines.push('  [REAL TRADING LOCKED — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.inputMissing) {
    lines.push('');
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run the learning loop first:');
    lines.push('    npm run token:live-fixture-capture');
    lines.push('    npm run token:fixture-cluster-enrich');
    lines.push('    npm run token:autonomy-readiness-audit');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('  SUMMARY');
  lines.push(`     Generated       : ${result.generatedAt}`);
  lines.push(`     Candidates found: ${result.candidatesFound}`);
  lines.push(`     Snapshots written: ${result.snapshotsWritten}`);
  lines.push(`     Cycles completed: ${result.cyclesCompleted}`);
  lines.push(`     Output path     : ${result.outputPath}`);
  lines.push(`     Best return     : ${fp(result.bestReturnPct, 1, true)}`);
  lines.push(`     Worst return    : ${fp(result.worstReturnPct, 1, true)}`);
  lines.push(`     Hit TP25 count  : ${result.hitTp25Count}`);
  lines.push(`     Hit SL15 count  : ${result.hitSl15Count}`);
  lines.push('');

  if (result.candidatesFound === 0) {
    lines.push('  No FUTURE_AUTONOMY_CANDIDATE fixtures found.');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  // Per-candidate snapshot summary (latest cycle only)
  const latestByContract = new Map<string, OutcomeWatchSnapshot>();
  for (const snap of result.snapshots) {
    const existing = latestByContract.get(snap.contract);
    if (!existing || snap.observedAt >= existing.observedAt) {
      latestByContract.set(snap.contract, snap);
    }
  }

  lines.push('  LATEST SNAPSHOT PER CANDIDATE');
  lines.push('     Symbol          Entry $       Latest $      Return %   BubbleMaps  Cluster');
  lines.push('     ' + '─'.repeat(80));

  for (const snap of latestByContract.values()) {
    const sym  = `$${snap.symbol}`.padEnd(15);
    const entr = snap.entryPriceUsd   !== null ? snap.entryPriceUsd.toFixed(8).padStart(12)  : '            —';
    const lat  = snap.latestPriceUsd  !== null ? snap.latestPriceUsd.toFixed(8).padStart(12) : '            —';
    const ret  = (snap.returnPctFromEntry !== null
      ? `${snap.returnPctFromEntry >= 0 ? '+' : ''}${snap.returnPctFromEntry.toFixed(1)}%`
      : '—').padStart(9);
    const bm   = snap.bubbleMapsScore !== null ? snap.bubbleMapsScore.toFixed(1).padStart(10) : '         —';
    lines.push(`     ${sym}${entr}  ${lat}  ${ret}  ${bm}  ${snap.clusterRisk}`);
    if (snap.pairUrl) lines.push(`       ↳ ${snap.pairUrl}`);
  }
  lines.push('');

  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('  Real trading remains locked. These are read-only watch snapshots.');
  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}
