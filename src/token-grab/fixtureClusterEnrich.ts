import * as fs from 'fs';
import * as path from 'path';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { LiveRipperFixture } from './liveFixtureCapture';
import {
  offlineClusterRiskProvider,
  createClusterRiskProvider,
  type ClusterRiskProvider,
  type ClusterRiskResult,
} from './clusterRiskProvider';
import {
  callPriorityTier,
  type TargetingFixture,
} from './ripperBubbleMapsTargeting';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FixtureClusterEnrichOptions {
  inputPath?:   string;
  outputPath?:  string;
  limitN?:      number;
  delayMs?:     number;
  force?:       boolean;
  offline?:     boolean;
  dryRun?:      boolean;
  all?:         boolean;  // enrich all fixtures, not just approved candidates
  apiUrl?:      string;
  apiKey?:      string;
  generatedAt?: string;
  // ── Approved+M5+live-runner-first targeting (opt-in; default off keeps order stable) ──
  // When set, the capped BubbleMaps budget is spent in priority order so the live
  // runner's approved+M5+UNKNOWN candidates are covered FIRST. Never changes gates,
  // never re-cleans a known result, never forces UNKNOWN→CLEAN.
  prioritize?:             boolean;
  topLiveRunnerContracts?: string[];
}

// Map a fixture to the targeting view (gate + M5 + current clusterRisk).
function toTargetingFixture(f: LiveRipperFixture): TargetingFixture {
  const raw = f.raw as Record<string, unknown> | undefined;
  return {
    contract: extractContractForCluster(f),
    buyGateDecision: (f.buyGateDecision as string | undefined) ?? null,
    entryDecision: (f.entryDecision as string | undefined) ?? null,
    entryMomentumPct: typeof f.entryMomentumPct === 'number' ? f.entryMomentumPct : null,
    clusterRisk: typeof raw?.['clusterRisk'] === 'string' ? (raw['clusterRisk'] as string) : null,
  };
}

export interface FixtureClusterEnrichResult {
  inputPath:              string;
  outputPath:             string;
  inputMissing:           boolean;
  offlineMode:            boolean;
  dryRun:                 boolean;
  configNote:             string | null;
  fixturesRead:           number;
  candidatesEvaluated:    number;
  fixturesPatched:        number;
  skippedAlreadyEnriched: number;
  skippedMissingContract: number;
  skippedNotCandidate:    number;
  rpcAttempted:           number;
  rpcSucceeded:           number;
  rpcFailed:              number;
  httpStatusCounts:       Record<number, number>;
  firstFailureDetail:     string | null;
  clusterRiskCounts:      Record<string, number>;
  tradingExecuted:        0;
  noRealTradeSent:        true;
  paperOnly:              true;
  readOnly:               true;
}

// ── Contract extraction ───────────────────────────────────────────────────────

export function extractContractForCluster(fixture: LiveRipperFixture): string | null {
  const ri = fixture.ripperInput as Record<string, unknown> | null;
  if (ri?.['contract'] && typeof ri['contract'] === 'string') return ri['contract'];
  const ns = fixture.normalizedSignal as Record<string, unknown> | undefined;
  if (ns?.['contract'] && typeof ns['contract'] === 'string') return ns['contract'];
  const raw = fixture.raw as Record<string, unknown> | undefined;
  if (raw?.['contract'] && typeof raw['contract'] === 'string') return raw['contract'];
  if (raw?.['contractAddress'] && typeof raw['contractAddress'] === 'string') return raw['contractAddress'];
  return null;
}

// ── Skip logic ────────────────────────────────────────────────────────────────

export function shouldSkipCluster(fixture: LiveRipperFixture, force: boolean): boolean {
  if (force) return false;
  const raw = fixture.raw as Record<string, unknown> | undefined;
  if (!raw) return false;
  if (raw['clusterCheckedAt'] === undefined) return false;
  // Allow online provider to replace offline results
  if (raw['clusterProvider'] === 'offline') return false;
  return true;
}

// ── Candidate filter ──────────────────────────────────────────────────────────

export function isClusterCandidate(fixture: LiveRipperFixture, all: boolean): boolean {
  if (all) return true;
  const dec = fixture.buyGateDecision ?? fixture.entryDecision ?? '';
  if (dec === 'BUY_APPROVED_PAPER') return true;
  if (dec === 'READY_TO_SNIPE_PAPER') return true;
  return false;
}

// ── Atomic JSONL write ────────────────────────────────────────────────────────

export function writeFixturesJsonlAtomicCluster(
  fixtures: LiveRipperFixture[],
  outputPath: string,
): void {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = outputPath + '.tmp';
  fs.writeFileSync(tmpPath, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  fs.renameSync(tmpPath, outputPath);
}

// ── Patch one fixture ─────────────────────────────────────────────────────────

export interface PatchClusterResult {
  skippedMissingContract: boolean;
  skippedAlreadyEnriched: boolean;
  skippedNotCandidate:    boolean;
  attempted:              boolean;
  succeeded:              boolean;
  failed:                 boolean;
  patched:                boolean;
  httpStatus?:            number;
  failureDetail?:         string;
}

export async function patchFixtureCluster(
  fixture: LiveRipperFixture,
  provider: ClusterRiskProvider,
  force: boolean,
  all: boolean,
  checkedAt: string,
): Promise<{ patched: LiveRipperFixture; result: PatchClusterResult }> {
  const empty: PatchClusterResult = {
    skippedMissingContract: false, skippedAlreadyEnriched: false, skippedNotCandidate: false,
    attempted: false, succeeded: false, failed: false, patched: false,
  };

  if (!isClusterCandidate(fixture, all)) {
    return { patched: fixture, result: { ...empty, skippedNotCandidate: true } };
  }

  const contract = extractContractForCluster(fixture);
  if (!contract) {
    return { patched: fixture, result: { ...empty, skippedMissingContract: true } };
  }

  if (shouldSkipCluster(fixture, force)) {
    return { patched: fixture, result: { ...empty, skippedAlreadyEnriched: true } };
  }

  let clusterResult: ClusterRiskResult;
  try {
    clusterResult = await provider.fetchClusterRisk(contract);
  } catch (err) {
    clusterResult = {
      clusterRisk:       'UNKNOWN',
      clusterProvider:   provider.name,
      clusterCheckedAt:  checkedAt,
      clusterConfidence: 'UNKNOWN',
      clusterNotes:      [],
      clusterFetchError: err instanceof Error ? err.message : 'cluster fetch failed',
    };
  }

  const existingRaw = (fixture.raw as Record<string, unknown> | undefined) ?? {};
  const patchedRaw: Record<string, unknown> = {
    ...existingRaw,
    clusterRisk:        clusterResult.clusterRisk,
    clusterProvider:    clusterResult.clusterProvider,
    clusterCheckedAt:   checkedAt,
    clusterConfidence:  clusterResult.clusterConfidence,
    clusterNotes:       clusterResult.clusterNotes,
  };
  if (clusterResult.clusterFetchError !== undefined) {
    patchedRaw['clusterFetchError'] = clusterResult.clusterFetchError;
  }
  if (clusterResult.rawMetrics !== undefined) {
    patchedRaw['clusterRawMetrics'] = clusterResult.rawMetrics;
  }

  const succeeded = !clusterResult.clusterFetchError;
  const failed    = !!clusterResult.clusterFetchError;

  return {
    patched: { ...fixture, raw: patchedRaw },
    result: {
      skippedMissingContract: false, skippedAlreadyEnriched: false, skippedNotCandidate: false,
      attempted: true, succeeded, failed, patched: true,
      httpStatus:    clusterResult.httpStatus,
      failureDetail: clusterResult.clusterFetchError,
    },
  };
}

// ── Sleep helper ──────────────────────────────────────────────────────────────

export type SleepFn = (ms: number) => Promise<void>;
export const defaultSleep: SleepFn = (ms) => new Promise(r => setTimeout(r, ms));

// ── Cluster risk from raw (for count reporting) ───────────────────────────────

function clusterRiskFromRaw(raw: Record<string, unknown> | undefined): string {
  const v = raw?.['clusterRisk'];
  if (v === 'CLEAN') return 'CLEAN';
  if (v === 'WATCH')  return 'WATCH';
  if (v === 'RISKY')  return 'RISKY';
  return 'UNKNOWN';
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

export async function runFixtureClusterEnrich(
  options: FixtureClusterEnrichOptions = {},
  sleepFn: SleepFn = defaultSleep,
): Promise<FixtureClusterEnrichResult> {
  const inputPath  = options.inputPath  ?? DEFAULT_INPUT;
  const outputPath = options.outputPath ?? inputPath;
  const force      = options.force      ?? false;
  const offline    = options.offline    ?? false;
  const dryRun     = options.dryRun     ?? false;
  const delayMs    = options.delayMs    ?? 500;
  const all        = options.all        ?? false;
  const limitN     = options.limitN;
  const checkedAt  = options.generatedAt ?? new Date().toISOString();

  const base = {
    fixturesRead: 0, candidatesEvaluated: 0, fixturesPatched: 0,
    skippedAlreadyEnriched: 0, skippedMissingContract: 0, skippedNotCandidate: 0,
    rpcAttempted: 0, rpcSucceeded: 0, rpcFailed: 0,
    httpStatusCounts: {} as Record<number, number>,
    firstFailureDetail: null as string | null,
    clusterRiskCounts: {} as Record<string, number>,
    tradingExecuted: 0 as const, noRealTradeSent: true as const,
    paperOnly: true as const, readOnly: true as const,
  };

  if (!fs.existsSync(inputPath)) {
    return { inputPath, outputPath, inputMissing: true, offlineMode: offline, dryRun, configNote: null, ...base };
  }

  const fixturesRaw = readFixturesFromJsonl(inputPath);
  base.fixturesRead = fixturesRaw.length;

  // ── Approved+M5+live-runner-first targeting (opt-in) ──
  // Reorder so the capped budget is spent on the highest-priority UNKNOWN candidates
  // first. Stable sort by call priority tier; original order within a tier is preserved.
  const topSet = new Set(options.topLiveRunnerContracts ?? []);
  const tierOf = (f: LiveRipperFixture): number =>
    options.prioritize ? callPriorityTier(toTargetingFixture(f), topSet) : 99;
  const fixtures = options.prioritize
    ? fixturesRaw.map((f, i) => ({ f, i, tier: tierOf(f) }))
        .sort((a, b) => (a.tier - b.tier) || (a.i - b.i))
        .map(x => x.f)
    : fixturesRaw;

  let provider: ClusterRiskProvider;
  let configNote: string | null = null;

  if (offline) {
    provider = offlineClusterRiskProvider;
  } else {
    const resolved = createClusterRiskProvider({ apiUrl: options.apiUrl, apiKey: options.apiKey });
    provider    = resolved.provider;
    configNote  = resolved.configNote;
  }

  const enriched: LiveRipperFixture[] = [];
  let candidatesEvaluated = 0, fixturesPatched = 0;
  let skippedAlreadyEnriched = 0, skippedMissingContract = 0, skippedNotCandidate = 0;
  let rpcAttempted = 0, rpcSucceeded = 0, rpcFailed = 0;
  const httpStatusCounts: Record<number, number> = {};
  let firstFailureDetail: string | null = null;

  for (const fixture of fixtures) {
    const underLimit = limitN === undefined || candidatesEvaluated < limitN;

    if (!underLimit) {
      if (options.prioritize) {
        const tier = tierOf(fixture);
        const praw = (fixture.raw ?? {}) as Record<string, unknown>;
        if (tier < 99) {   // a real UNKNOWN target that the cap skipped
          praw['bubbleMapsCallPriorityTier']  = tier;
          praw['bubbleMapsSelectedForCall']   = false;
          praw['bubbleMapsLiveCallUsed']      = false;
          praw['bubbleMapsCacheHit']          = false;
          praw['bubbleMapsCallSkippedReason'] = 'CAP_REACHED';
          (fixture as unknown as Record<string, unknown>)['raw'] = praw;
        }
      }
      enriched.push(fixture);
      continue;
    }

    const { patched, result: pr } = await patchFixtureCluster(
      fixture, provider, force, all, checkedAt,
    );

    if (pr.skippedNotCandidate)    { skippedNotCandidate++;    enriched.push(fixture); continue; }
    if (pr.skippedMissingContract) { skippedMissingContract++; enriched.push(fixture); continue; }
    if (pr.skippedAlreadyEnriched) { skippedAlreadyEnriched++; enriched.push(fixture); continue; }

    candidatesEvaluated++;
    if (pr.attempted && !offline) {
      rpcAttempted++;
      if (pr.httpStatus !== undefined) {
        httpStatusCounts[pr.httpStatus] = (httpStatusCounts[pr.httpStatus] ?? 0) + 1;
      }
    }
    if (pr.succeeded  && !offline) rpcSucceeded++;
    if (pr.failed     && !offline) {
      rpcFailed++;
      if (firstFailureDetail === null && pr.failureDetail) {
        firstFailureDetail = pr.failureDetail;
      }
    }
    if (pr.patched) fixturesPatched++;

    // ── Stamp call-allocation metadata (only when targeting is enabled) ──
    if (options.prioritize) {
      const tier = tierOf(patched);
      const praw = (patched.raw ?? {}) as Record<string, unknown>;
      const resultRisk = clusterRiskFromRaw(praw);
      const isTarget = tier < 99;
      const liveCallUsed = pr.attempted && !offline;
      const cacheHit = isTarget && !pr.attempted && pr.patched;  // resolved without a live attempt
      praw['bubbleMapsCallPriorityTier']  = tier;
      praw['bubbleMapsSelectedForCall']   = isTarget;
      praw['bubbleMapsLiveCallUsed']      = liveCallUsed;
      praw['bubbleMapsCacheHit']          = cacheHit;
      praw['bubbleMapsCallResult']        = resultRisk;
      praw['bubbleMapsCallSkippedReason'] =
        !isTarget ? 'ALREADY_KNOWN' : cacheHit ? 'CACHE_HIT_FRESH' : liveCallUsed ? null : 'NOT_ATTEMPTED';
      (patched as unknown as Record<string, unknown>)['raw'] = praw;
    }

    enriched.push(patched);

    if (pr.attempted && delayMs > 0) {
      await sleepFn(delayMs);
    }
  }

  // Count clusterRisk distribution after enrichment
  const clusterRiskCounts: Record<string, number> = {};
  for (const f of enriched) {
    const risk = clusterRiskFromRaw(f.raw as Record<string, unknown> | undefined);
    clusterRiskCounts[risk] = (clusterRiskCounts[risk] ?? 0) + 1;
  }

  if (!dryRun) {
    writeFixturesJsonlAtomicCluster(enriched, outputPath);
  }

  return {
    inputPath, outputPath, inputMissing: false, offlineMode: offline, dryRun, configNote,
    fixturesRead: fixtures.length,
    candidatesEvaluated,
    fixturesPatched,
    skippedAlreadyEnriched,
    skippedMissingContract,
    skippedNotCandidate,
    rpcAttempted, rpcSucceeded, rpcFailed,
    httpStatusCounts, firstFailureDetail,
    clusterRiskCounts,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderFixtureClusterEnrichReport(result: FixtureClusterEnrichResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — FIXTURE CLUSTER ENRICH');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.inputMissing) {
    lines.push('');
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run the learning loop first.');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  if (result.configNote) {
    lines.push('');
    lines.push(`  CONFIG NOTE: ${result.configNote}`);
  }

  const mode = result.offlineMode ? '(offline — no API)' : result.dryRun ? '(dry-run — no write)' : '';

  lines.push('');
  lines.push(`  Input  : ${result.inputPath}`);
  lines.push(`  Output : ${result.outputPath}${result.dryRun ? '  [NOT written — dry-run]' : ''}`);
  if (mode) lines.push(`  Mode   : ${mode}`);
  lines.push('');

  lines.push('  ENRICHMENT SUMMARY');
  lines.push(`  Fixtures read              : ${result.fixturesRead}`);
  lines.push(`  Candidates evaluated       : ${result.candidatesEvaluated}`);
  lines.push(`  Fixtures patched           : ${result.fixturesPatched}`);
  lines.push(`  Skipped already enriched   : ${result.skippedAlreadyEnriched}`);
  lines.push(`  Skipped missing contract   : ${result.skippedMissingContract}`);
  lines.push(`  Skipped not candidate      : ${result.skippedNotCandidate}`);
  lines.push('');

  if (!result.offlineMode && result.candidatesEvaluated > 0) {
    lines.push('  API CALLS (cluster provider — read-only)');
    lines.push(`  Attempted  : ${result.rpcAttempted}`);
    lines.push(`  Succeeded  : ${result.rpcSucceeded}`);
    lines.push(`  Failed     : ${result.rpcFailed}`);
    const statusEntries = Object.entries(result.httpStatusCounts ?? {});
    if (statusEntries.length > 0) {
      const statusStr = statusEntries.map(([k, v]) => `${k}×${v}`).join('  ');
      lines.push(`  HTTP status: ${statusStr}`);
    }
    if (result.firstFailureDetail) {
      lines.push(`  Error      : ${result.firstFailureDetail}`);
    }
    lines.push('');
  }

  if (Object.keys(result.clusterRiskCounts).length > 0) {
    const total = result.fixturesRead;
    const pct = (n: number) => total > 0 ? ` (${((n / total) * 100).toFixed(1)}%)` : '';
    lines.push('  CLUSTER RISK DISTRIBUTION (all fixtures after enrichment)');
    for (const risk of ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN']) {
      const n = result.clusterRiskCounts[risk] ?? 0;
      if (n > 0) lines.push(`    ${risk.padEnd(8)} : ${String(n).padStart(3)}${pct(n)}`);
    }
    lines.push('');
  }

  if (!result.offlineMode && result.configNote) {
    lines.push('  To enable cluster enrichment:');
    lines.push('    export BUBBLEMAPS_API_URL=https://api.bubblemaps.io/v1');
    lines.push('    export BUBBLEMAPS_API_KEY=your_key_here');
    lines.push('    npm run token:fixture-cluster-enrich');
    lines.push('');
  } else if (result.fixturesPatched > 0 && !result.dryRun) {
    lines.push('  Next steps:');
    lines.push('    npm run token:cluster-risk-audit');
    lines.push('    npm run token:autonomy-readiness-audit');
    lines.push('');
  }

  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderFixtureClusterEnrichUsage(): string {
  return `
token:fixture-cluster-enrich — enrich live fixtures with cluster risk data

Usage:
  npm run token:fixture-cluster-enrich [options]

Options:
  --input <path>     Input JSONL file (default: data/token-grab/ripper/live-fixtures.jsonl)
  --output <path>    Output path (default: overwrite input atomically)
  --limit <n>        Only evaluate up to N candidates this run
  --delay-ms <n>     Milliseconds between API calls (default: 500)
  --force            Re-fetch already-enriched fixtures
  --all              Enrich all fixtures, not just BUY_APPROVED_PAPER
  --offline          Skip API calls, leave all cluster fields UNKNOWN
  --dry-run          Show what would be done, do not write output
  --api-url <url>    BubbleMaps/cluster API URL (or set BUBBLEMAPS_API_URL)
  --api-key <key>    API key (or set BUBBLEMAPS_API_KEY)
  --help             Show this message

API config:
  Set environment variables before running:
    export BUBBLEMAPS_API_URL=https://api.bubblemaps.io/v1
    export BUBBLEMAPS_API_KEY=your_key_here

  Without API config, command runs in offline mode — all clusterRisk stays UNKNOWN.

Patched fields:
  clusterRisk, clusterProvider, clusterCheckedAt, clusterConfidence,
  clusterNotes, clusterFetchError (on failure), clusterRawMetrics (raw response)

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Read-only.
`.trim();
}
