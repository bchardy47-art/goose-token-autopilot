import * as fs from 'fs';
import * as path from 'path';
import {
  createRpcSafetyProvider,
  offlineSafetyProvider,
  holderPctToStatus,
  type SolanaTokenSafetyProvider,
} from './dexCandidateSafetyEnrich';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { LiveRipperFixture } from './liveFixtureCapture';

// ── Options & result types ────────────────────────────────────────────────────

export interface FixtureHolderEnrichOptions {
  inputPath?: string;
  outputPath?: string;
  limitN?: number;
  delayMs?: number;
  force?: boolean;
  offline?: boolean;
  dryRun?: boolean;
  rpcUrl?: string;
  generatedAt?: string;
}

export interface FixtureHolderEnrichResult {
  inputPath: string;
  outputPath: string;
  inputMissing: boolean;
  noRpcUrl: boolean;
  offlineMode: boolean;
  dryRun: boolean;
  fixturesRead: number;
  fixturesPatched: number;
  skippedAlreadyEnriched: number;
  skippedMissingContract: number;
  rpcAttempted: number;
  rpcSucceeded: number;
  rpcFailed: number;
  rpc429Count: number;
  holderRiskCounts: Record<string, number>;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

// ── Contract extraction ───────────────────────────────────────────────────────

export function extractContract(fixture: LiveRipperFixture): string | null {
  const ri = fixture.ripperInput as Record<string, unknown> | null;
  if (ri?.contract && typeof ri.contract === 'string') return ri.contract;

  const ns = fixture.normalizedSignal as Record<string, unknown> | undefined;
  if (ns?.contract && typeof ns.contract === 'string') return ns.contract;

  const raw = fixture.raw as Record<string, unknown> | undefined;
  if (raw?.contract && typeof raw.contract === 'string') return raw.contract;
  if (raw?.contractAddress && typeof raw.contractAddress === 'string') return raw.contractAddress;

  return null;
}

// ── Skip logic ────────────────────────────────────────────────────────────────

export function shouldSkip(fixture: LiveRipperFixture, force: boolean): boolean {
  const raw = fixture.raw as Record<string, unknown> | undefined;
  if (!raw) return false;
  const status = raw['holderConcentrationStatus'];
  if (status === undefined) return false;
  // Already has a real status or a previously-failed attempt → skip unless --force
  return !force;
}

// ── Patch one fixture's raw field ─────────────────────────────────────────────

export interface HolderPatchResult {
  skippedMissingContract: boolean;
  skippedAlreadyEnriched: boolean;
  rpcAttempted: boolean;
  rpcSucceeded: boolean;
  rpcFailed: boolean;
  is429: boolean;
  patched: boolean;
}

export async function patchFixtureHolder(
  fixture: LiveRipperFixture,
  provider: SolanaTokenSafetyProvider,
  force: boolean,
  checkedAt: string,
  providerName: string,
): Promise<{ patched: LiveRipperFixture; result: HolderPatchResult }> {
  const empty: HolderPatchResult = {
    skippedMissingContract: false, skippedAlreadyEnriched: false,
    rpcAttempted: false, rpcSucceeded: false, rpcFailed: false,
    is429: false, patched: false,
  };

  const contract = extractContract(fixture);
  if (!contract) {
    return { patched: fixture, result: { ...empty, skippedMissingContract: true } };
  }

  if (shouldSkip(fixture, force)) {
    return { patched: fixture, result: { ...empty, skippedAlreadyEnriched: true } };
  }

  let topHolderPct: number | null = null;
  let holderFetchError: string | undefined;
  let is429 = false;

  try {
    topHolderPct = await provider.fetchTopHolderPct(contract);
  } catch (err) {
    holderFetchError = err instanceof Error ? err.message : String(err);
    is429 = holderFetchError.includes('429') || holderFetchError.toLowerCase().includes('too many');
  }

  const holderConcentrationStatus = holderPctToStatus(topHolderPct);
  const existingRaw = (fixture.raw as Record<string, unknown> | undefined) ?? {};

  const patchedRaw: Record<string, unknown> = {
    ...existingRaw,
    holderConcentrationStatus,
    holderProvider: providerName,
    holderCheckedAt: checkedAt,
  };
  if (topHolderPct !== null) patchedRaw['topHolderPercent'] = topHolderPct;
  if (holderFetchError !== undefined) patchedRaw['holderFetchError'] = holderFetchError;

  const patched: LiveRipperFixture = { ...fixture, raw: patchedRaw };

  return {
    patched,
    result: {
      skippedMissingContract: false,
      skippedAlreadyEnriched: false,
      rpcAttempted: true,
      rpcSucceeded: holderFetchError === undefined,
      rpcFailed: holderFetchError !== undefined,
      is429,
      patched: true,
    },
  };
}

// ── Atomic JSONL write ────────────────────────────────────────────────────────

export function writeFixturesJsonlAtomic(fixtures: LiveRipperFixture[], outputPath: string): void {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = outputPath + '.tmp';
  fs.writeFileSync(tmpPath, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  fs.renameSync(tmpPath, outputPath);
}

// ── Delay helper (injectable for tests) ──────────────────────────────────────

export type SleepFn = (ms: number) => Promise<void>;
export const defaultSleep: SleepFn = (ms) => new Promise(r => setTimeout(r, ms));

// ── Holder-risk summary from enriched raw fields ──────────────────────────────

function holderRiskFromRaw(raw: Record<string, unknown> | undefined): string {
  if (!raw) return 'UNKNOWN';
  const status = raw['holderConcentrationStatus'];
  if (status === 'DANGER') return 'RISKY';
  if (status === 'WARNING') return 'WATCH';
  if (status === 'CLEAN') return 'CLEAN';
  return 'UNKNOWN';
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const DEFAULT_INPUT  = 'data/token-grab/ripper/live-fixtures.jsonl';
const PROVIDER_NAME  = 'solana-rpc';

export async function runFixtureHolderEnrich(
  options: FixtureHolderEnrichOptions = {},
  sleepFn: SleepFn = defaultSleep,
): Promise<FixtureHolderEnrichResult> {
  const inputPath   = options.inputPath  ?? DEFAULT_INPUT;
  const outputPath  = options.outputPath ?? inputPath;
  const force       = options.force      ?? false;
  const offline     = options.offline    ?? false;
  const dryRun      = options.dryRun     ?? false;
  const delayMs     = options.delayMs    ?? 500;
  const limitN      = options.limitN;
  const checkedAt   = options.generatedAt ?? new Date().toISOString();

  const base: Omit<FixtureHolderEnrichResult, 'inputMissing'|'noRpcUrl'|'offlineMode'|'dryRun'|'inputPath'|'outputPath'> = {
    fixturesRead: 0, fixturesPatched: 0,
    skippedAlreadyEnriched: 0, skippedMissingContract: 0,
    rpcAttempted: 0, rpcSucceeded: 0, rpcFailed: 0, rpc429Count: 0,
    holderRiskCounts: {},
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };

  if (!fs.existsSync(inputPath)) {
    return { inputPath, outputPath, inputMissing: true, noRpcUrl: false, offlineMode: offline, dryRun, ...base };
  }

  const fixtures = readFixturesFromJsonl(inputPath);
  base.fixturesRead = fixtures.length;

  const rpcUrl = options.rpcUrl ?? process.env['SOLANA_RPC_URL'] ?? '';
  const noRpcUrl = !offline && !rpcUrl;

  if (noRpcUrl) {
    // No RPC and not offline — leave file unchanged, just report
    const counts: Record<string, number> = {};
    for (const f of fixtures) {
      const risk = holderRiskFromRaw(f.raw as Record<string, unknown> | undefined);
      counts[risk] = (counts[risk] ?? 0) + 1;
    }
    return {
      inputPath, outputPath, inputMissing: false, noRpcUrl: true, offlineMode: false, dryRun,
      ...base, fixturesRead: fixtures.length, holderRiskCounts: counts,
    };
  }

  let provider: SolanaTokenSafetyProvider;
  let providerName: string;
  if (offline) {
    provider = offlineSafetyProvider;
    providerName = 'offline';
  } else {
    provider = createRpcSafetyProvider(rpcUrl);
    providerName = PROVIDER_NAME;
  }

  const enriched: LiveRipperFixture[] = [];
  let patched = 0, skippedEnriched = 0, skippedNoContract = 0;
  let rpcAttempted = 0, rpcSucceeded = 0, rpcFailed = 0, rpc429Count = 0;
  let enrichedThisBatch = 0;

  for (const fixture of fixtures) {
    const shouldEnrich = limitN === undefined || enrichedThisBatch < limitN;
    let result: LiveRipperFixture;

    if (!shouldEnrich) {
      enriched.push(fixture);
      continue;
    }

    const { patched: patchedFixture, result: pr } = await patchFixtureHolder(
      fixture, provider, force, checkedAt, providerName,
    );

    result = patchedFixture;

    if (pr.skippedMissingContract)  { skippedNoContract++;  enriched.push(fixture); continue; }
    if (pr.skippedAlreadyEnriched)  { skippedEnriched++;    enriched.push(fixture); continue; }
    if (pr.rpcAttempted)            { enrichedThisBatch++; }
    if (pr.rpcAttempted && !offline) { rpcAttempted++; }
    if (pr.rpcSucceeded && !offline) rpcSucceeded++;
    if (pr.rpcFailed   && !offline) rpcFailed++;
    if (pr.is429       && !offline) rpc429Count++;
    if (pr.patched)                 patched++;

    enriched.push(result);

    // Rate limiting between RPC calls
    if (pr.rpcAttempted && delayMs > 0) {
      await sleepFn(delayMs);
    }
  }

  // Holder-risk counts across all enriched fixtures
  const holderRiskCounts: Record<string, number> = {};
  for (const f of enriched) {
    const risk = holderRiskFromRaw(f.raw as Record<string, unknown> | undefined);
    holderRiskCounts[risk] = (holderRiskCounts[risk] ?? 0) + 1;
  }

  if (!dryRun) {
    writeFixturesJsonlAtomic(enriched, outputPath);
  }

  return {
    inputPath, outputPath, inputMissing: false, noRpcUrl: false, offlineMode: offline, dryRun,
    fixturesRead: fixtures.length,
    fixturesPatched: patched,
    skippedAlreadyEnriched: skippedEnriched,
    skippedMissingContract: skippedNoContract,
    rpcAttempted, rpcSucceeded, rpcFailed, rpc429Count,
    holderRiskCounts,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderFixtureHolderEnrichReport(result: FixtureHolderEnrichResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — FIXTURE HOLDER ENRICH');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.inputMissing) {
    lines.push('');
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run the learning loop first:');
    lines.push('    npm run token:dex-day-watch');
    lines.push('    npm run token:fresh-pool-feed');
    lines.push('    npm run token:live-fixture-capture');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  if (result.noRpcUrl) {
    lines.push('');
    lines.push('  SOLANA_RPC_URL is not set — cannot fetch holder data.');
    lines.push('  Options:');
    lines.push('    1. Set SOLANA_RPC_URL=https://... and re-run');
    lines.push('    2. Pass --offline to skip RPC and keep existing UNKNOWN fields');
    lines.push('');
    lines.push(`  Input  : ${result.inputPath}`);
    lines.push(`  Fixtures : ${result.fixturesRead} (unchanged)`);
    lines.push('');
    _appendRiskCounts(lines, result.holderRiskCounts, result.fixturesRead);
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  const mode = result.offlineMode ? '(offline — no RPC)' : result.dryRun ? '(dry-run — no write)' : '';

  lines.push('');
  lines.push(`  Input  : ${result.inputPath}`);
  lines.push(`  Output : ${result.outputPath}${result.dryRun ? '  [NOT written — dry-run]' : ''}`);
  if (mode) lines.push(`  Mode   : ${mode}`);
  lines.push('');

  lines.push('  ENRICHMENT SUMMARY');
  lines.push(`  Fixtures read              : ${result.fixturesRead}`);
  lines.push(`  Fixtures patched           : ${result.fixturesPatched}`);
  lines.push(`  Skipped already enriched   : ${result.skippedAlreadyEnriched}`);
  lines.push(`  Skipped missing contract   : ${result.skippedMissingContract}`);
  lines.push('');

  if (!result.offlineMode) {
    lines.push('  RPC CALLS');
    lines.push(`  Attempted  : ${result.rpcAttempted}`);
    lines.push(`  Succeeded  : ${result.rpcSucceeded}`);
    lines.push(`  Failed     : ${result.rpcFailed}`);
    if (result.rpc429Count > 0) {
      lines.push(`  429/rate-limit : ${result.rpc429Count}  ← increase --delay-ms or use paid RPC`);
    }
    lines.push('');
  }

  if (Object.keys(result.holderRiskCounts).length > 0) {
    lines.push('  HOLDER RISK DISTRIBUTION (after enrichment)');
    _appendRiskCounts(lines, result.holderRiskCounts, result.fixturesRead);
    lines.push('');
  }

  if (result.fixturesPatched > 0 && !result.dryRun && !result.offlineMode) {
    lines.push(`  Run these to see updated results:`);
    lines.push('    npm run token:holder-risk-audit');
    lines.push('    npm run token:prime-gate-audit -- --strict-preview');
    lines.push('');
  }

  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

function _appendRiskCounts(
  lines: string[],
  counts: Record<string, number>,
  total: number,
): void {
  const order = ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN'];
  const pct = (n: number) => total > 0 ? ` (${((n / total) * 100).toFixed(1)}%)` : '';
  for (const risk of order) {
    const n = counts[risk] ?? 0;
    if (n > 0) lines.push(`    ${risk.padEnd(8)} : ${String(n).padStart(3)}${pct(n)}`);
  }
}

export function renderFixtureHolderEnrichUsage(): string {
  return `
token:fixture-holder-enrich — enrich live fixture holder concentration fields via Solana RPC

Usage:
  npm run token:fixture-holder-enrich [options]

Options:
  --input <path>     Input JSONL fixture file (default: data/token-grab/ripper/live-fixtures.jsonl)
  --output <path>    Output path (default: overwrite input atomically)
  --limit <n>        Only enrich up to N unenriched fixtures this run
  --delay-ms <n>     Milliseconds between RPC calls (default: 500)
  --force            Re-fetch even fixtures that already have holder data
  --offline          Skip RPC, leave all holder fields UNKNOWN
  --dry-run          Show what would be done, do not write output
  --rpc-url <url>    Solana RPC URL (or set SOLANA_RPC_URL env var)
  --help             Show this message

Behavior:
  Reads live-fixtures.jsonl and enriches each fixture's raw field with:
    holderConcentrationStatus, topHolderPercent, holderProvider, holderCheckedAt
  Skips fixtures that already have holderConcentrationStatus unless --force.
  Skips fixtures with no detectable contract address.
  Writes output atomically (temp file + rename).
  Uses existing dexCandidateSafetyEnrich.ts RPC provider — no new RPC code.

After enrichment:
  npm run token:holder-risk-audit          → see updated risk distribution
  npm run token:prime-gate-audit -- --strict-preview → see gate impact

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Read-only.
`.trim();
}
