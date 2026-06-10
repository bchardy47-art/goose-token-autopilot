import * as fs from 'fs';
import * as path from 'path';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { LiveRipperFixture } from './liveFixtureCapture';

// ── Constants ─────────────────────────────────────────────────────────────────

const SOL_MINT           = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_API  = 'https://lite-api.jup.ag/swap/v1/quote';
const DEFAULT_AMOUNT_LAMPORTS = 10_000_000; // 0.01 SOL (small preview buy)

// ── Thresholds (exported for tests) ──────────────────────────────────────────

export const QUOTE_PREVIEW_THRESHOLDS = {
  CLEAN_MAX_IMPACT_PCT: 3,
  WATCH_MAX_IMPACT_PCT: 10,
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export type SlippageRisk      = 'CLEAN' | 'WATCH' | 'RISKY' | 'UNKNOWN';
export type LiquidityTradable = 'GOOD'  | 'WATCH' | 'RISKY' | 'UNKNOWN';

export interface QuoteRawResult {
  routeFound:          boolean;
  priceImpactPct:      number | null;
  estimatedSlippagePct: number | null;
  tried:               boolean; // false = offline/skipped — do not classify as RISKY
  error?:              string;
}

export interface QuotePreviewProvider {
  readonly name: string;
  fetchBuyQuote(tokenMint: string, amountLamports: number): Promise<QuoteRawResult>;
}

export interface QuotePreviewPatchResult {
  skippedMissingContract: boolean;
  skippedAlreadyQuoted:   boolean;
  skippedNotCandidate:    boolean;
  attempted:              boolean;
  succeeded:              boolean;
  failed:                 boolean;
  patched:                boolean;
}

export interface FixtureQuotePreviewOptions {
  inputPath?:    string;
  outputPath?:   string;
  limitN?:       number;
  delayMs?:      number;
  force?:        boolean;
  offline?:      boolean;
  dryRun?:       boolean;
  rpcUrl?:       string;
  amountUsd?:    number;
  includeWatch?: boolean;
  generatedAt?:  string;
}

export interface FixtureQuotePreviewResult {
  inputPath:              string;
  outputPath:             string;
  inputMissing:           boolean;
  offlineMode:            boolean;
  dryRun:                 boolean;
  fixturesRead:           number;
  candidatesEvaluated:    number;
  fixturesPatched:        number;
  skippedAlreadyQuoted:   number;
  skippedMissingContract: number;
  skippedNotCandidate:    number;
  rpcAttempted:           number;
  rpcSucceeded:           number;
  rpcFailed:              number;
  slippageRiskCounts:     Record<string, number>;
  tradingExecuted:        0;
  noRealTradeSent:        true;
  paperOnly:              true;
  readOnly:               true;
}

// ── Classification ────────────────────────────────────────────────────────────

export function classifySlippageRisk(
  priceImpactPct: number | null,
  routeFound: boolean,
  tried: boolean,
): SlippageRisk {
  if (!tried)      return 'UNKNOWN';
  if (!routeFound) return 'RISKY';
  if (priceImpactPct === null) return 'UNKNOWN';
  if (priceImpactPct <= QUOTE_PREVIEW_THRESHOLDS.CLEAN_MAX_IMPACT_PCT) return 'CLEAN';
  if (priceImpactPct <= QUOTE_PREVIEW_THRESHOLDS.WATCH_MAX_IMPACT_PCT) return 'WATCH';
  return 'RISKY';
}

export function classifyLiquidityTradable(
  routeFound: boolean,
  slippageRisk: SlippageRisk,
  tried: boolean,
): LiquidityTradable {
  if (!tried)                    return 'UNKNOWN';
  if (!routeFound)               return 'RISKY';
  if (slippageRisk === 'CLEAN')  return 'GOOD';
  if (slippageRisk === 'WATCH')  return 'WATCH';
  if (slippageRisk === 'RISKY')  return 'RISKY';
  return 'UNKNOWN';
}

// ── Offline provider ──────────────────────────────────────────────────────────

export const offlineQuotePreviewProvider: QuotePreviewProvider = {
  name: 'offline',
  async fetchBuyQuote(_mint, _amount) {
    return { routeFound: false, priceImpactPct: null, estimatedSlippagePct: null, tried: false };
  },
};

// ── Jupiter provider (reuses same API endpoint as quoteCheck.ts) ──────────────

export function createJupiterQuotePreviewProvider(
  apiUrl: string = JUPITER_QUOTE_API,
): QuotePreviewProvider {
  return {
    name: 'jupiter',
    async fetchBuyQuote(tokenMint: string, amountLamports: number): Promise<QuoteRawResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const url = new URL(apiUrl);
        url.searchParams.set('inputMint',       SOL_MINT);
        url.searchParams.set('outputMint',      tokenMint);
        url.searchParams.set('amount',          String(amountLamports));
        url.searchParams.set('slippageBps',     '500');
        url.searchParams.set('onlyDirectRoutes', 'false');

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': 'goose-token-autopilot/1.0' },
          signal: controller.signal,
        });

        if (!response.ok) {
          return {
            routeFound: false, priceImpactPct: null, estimatedSlippagePct: null, tried: true,
            error: `quote http ${response.status}`,
          };
        }

        const data = await response.json() as Record<string, unknown>;
        const rawImpact  = data?.['priceImpactPct'];
        const priceImpactPct = rawImpact === undefined ? null : Number(rawImpact);
        const routePlan  = Array.isArray(data?.['routePlan']) ? data['routePlan'] : [];
        const outAmount  = typeof data?.['outAmount'] === 'string' ? data['outAmount'] : null;
        const routeFound = (routePlan as unknown[]).length > 0 && outAmount !== null;

        return {
          routeFound,
          priceImpactPct: Number.isFinite(priceImpactPct as number) ? priceImpactPct : null,
          estimatedSlippagePct: Number.isFinite(priceImpactPct as number) ? priceImpactPct : null,
          tried: true,
          error: routeFound ? undefined : 'no buy route available',
        };
      } catch (err) {
        return {
          routeFound: false, priceImpactPct: null, estimatedSlippagePct: null, tried: true,
          error: err instanceof Error ? err.message : 'quote fetch failed',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ── Contract extraction ───────────────────────────────────────────────────────

export function extractContractForQuote(fixture: LiveRipperFixture): string | null {
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

export function shouldSkipQuote(fixture: LiveRipperFixture, force: boolean): boolean {
  if (force) return false;
  const raw = fixture.raw as Record<string, unknown> | undefined;
  if (!raw) return false;
  const checkedAt = raw['quoteCheckedAt'];
  if (checkedAt === undefined) return false;
  // Allow online to replace offline results
  if (raw['quoteProvider'] === 'offline') return false;
  return true;
}

// ── Candidate filter ──────────────────────────────────────────────────────────

export function isQuoteCandidate(fixture: LiveRipperFixture, includeWatch: boolean): boolean {
  const dec = fixture.buyGateDecision ?? fixture.entryDecision ?? '';
  if (dec === 'BUY_APPROVED_PAPER') return true;
  if (dec === 'READY_TO_SNIPE_PAPER') return true;
  if (includeWatch && dec === 'WATCH') return true;
  return false;
}

// ── Patch one fixture ─────────────────────────────────────────────────────────

export async function patchFixtureQuote(
  fixture: LiveRipperFixture,
  provider: QuotePreviewProvider,
  force: boolean,
  includeWatch: boolean,
  checkedAt: string,
  amountLamports: number,
  amountUsd: number,
): Promise<{ patched: LiveRipperFixture; result: QuotePreviewPatchResult }> {
  const empty: QuotePreviewPatchResult = {
    skippedMissingContract: false, skippedAlreadyQuoted: false, skippedNotCandidate: false,
    attempted: false, succeeded: false, failed: false, patched: false,
  };

  if (!isQuoteCandidate(fixture, includeWatch)) {
    return { patched: fixture, result: { ...empty, skippedNotCandidate: true } };
  }

  const contract = extractContractForQuote(fixture);
  if (!contract) {
    return { patched: fixture, result: { ...empty, skippedMissingContract: true } };
  }

  if (shouldSkipQuote(fixture, force)) {
    return { patched: fixture, result: { ...empty, skippedAlreadyQuoted: true } };
  }

  const raw = await provider.fetchBuyQuote(contract, amountLamports);
  const slippageRisk       = classifySlippageRisk(raw.priceImpactPct, raw.routeFound, raw.tried);
  const liquidityTradable  = classifyLiquidityTradable(raw.routeFound, slippageRisk, raw.tried);
  const quoteOk            = raw.tried && raw.routeFound && !raw.error;

  const existingRaw = (fixture.raw as Record<string, unknown> | undefined) ?? {};
  const patchedRaw: Record<string, unknown> = {
    ...existingRaw,
    quoteProvider:        provider.name,
    quoteCheckedAt:       checkedAt,
    quoteOk,
    quoteInputUsd:        amountUsd,
    routeFound:           raw.routeFound,
    slippageRisk,
    liquidityTradable,
  };
  if (raw.priceImpactPct !== null) {
    patchedRaw['priceImpactPct']       = raw.priceImpactPct;
    patchedRaw['estimatedSlippagePct'] = raw.estimatedSlippagePct ?? raw.priceImpactPct;
  }
  if (raw.error !== undefined) {
    patchedRaw['quoteFetchError'] = raw.error;
  }

  const succeeded = raw.tried && !raw.error;
  const failed    = raw.tried && !!raw.error;

  return {
    patched: { ...fixture, raw: patchedRaw },
    result: {
      skippedMissingContract: false, skippedAlreadyQuoted: false, skippedNotCandidate: false,
      attempted: raw.tried, succeeded, failed, patched: true,
    },
  };
}

// ── Atomic JSONL write ────────────────────────────────────────────────────────

export function writeFixturesJsonlAtomicQuote(
  fixtures: LiveRipperFixture[],
  outputPath: string,
): void {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = outputPath + '.tmp';
  fs.writeFileSync(tmpPath, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  fs.renameSync(tmpPath, outputPath);
}

// ── Sleep helper ──────────────────────────────────────────────────────────────

export type SleepFn = (ms: number) => Promise<void>;
export const defaultSleep: SleepFn = (ms) => new Promise(r => setTimeout(r, ms));

// ── Slippage risk from raw ────────────────────────────────────────────────────

function slippageRiskFromRaw(raw: Record<string, unknown> | undefined): SlippageRisk {
  const v = raw?.['slippageRisk'];
  if (v === 'CLEAN') return 'CLEAN';
  if (v === 'WATCH')  return 'WATCH';
  if (v === 'RISKY')  return 'RISKY';
  return 'UNKNOWN';
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

export async function runFixtureQuotePreview(
  options: FixtureQuotePreviewOptions = {},
  sleepFn: SleepFn = defaultSleep,
): Promise<FixtureQuotePreviewResult> {
  const inputPath    = options.inputPath  ?? DEFAULT_INPUT;
  const outputPath   = options.outputPath ?? inputPath;
  const force        = options.force       ?? false;
  const offline      = options.offline     ?? false;
  const dryRun       = options.dryRun      ?? false;
  const delayMs      = options.delayMs     ?? 500;
  const limitN       = options.limitN;
  const includeWatch = options.includeWatch ?? false;
  const amountUsd    = options.amountUsd   ?? 10;
  const amountLamports = DEFAULT_AMOUNT_LAMPORTS;
  const checkedAt    = options.generatedAt  ?? new Date().toISOString();

  const base = {
    fixturesRead: 0, candidatesEvaluated: 0, fixturesPatched: 0,
    skippedAlreadyQuoted: 0, skippedMissingContract: 0, skippedNotCandidate: 0,
    rpcAttempted: 0, rpcSucceeded: 0, rpcFailed: 0,
    slippageRiskCounts: {} as Record<string, number>,
    tradingExecuted: 0 as const, noRealTradeSent: true as const,
    paperOnly: true as const, readOnly: true as const,
  };

  if (!fs.existsSync(inputPath)) {
    return { inputPath, outputPath, inputMissing: true, offlineMode: offline, dryRun, ...base };
  }

  const fixtures = readFixturesFromJsonl(inputPath);
  base.fixturesRead = fixtures.length;

  const provider: QuotePreviewProvider = offline
    ? offlineQuotePreviewProvider
    : createJupiterQuotePreviewProvider();

  const enriched: LiveRipperFixture[] = [];
  let candidatesEvaluated = 0, fixturesPatched = 0;
  let skippedAlreadyQuoted = 0, skippedMissingContract = 0, skippedNotCandidate = 0;
  let rpcAttempted = 0, rpcSucceeded = 0, rpcFailed = 0;

  for (const fixture of fixtures) {
    const underLimit = limitN === undefined || candidatesEvaluated < limitN;

    if (!underLimit) {
      enriched.push(fixture);
      continue;
    }

    const { patched, result: pr } = await patchFixtureQuote(
      fixture, provider, force, includeWatch, checkedAt, amountLamports, amountUsd,
    );

    if (pr.skippedNotCandidate)    { skippedNotCandidate++;    enriched.push(fixture); continue; }
    if (pr.skippedMissingContract) { skippedMissingContract++; enriched.push(fixture); continue; }
    if (pr.skippedAlreadyQuoted)   { skippedAlreadyQuoted++;   enriched.push(fixture); continue; }

    candidatesEvaluated++;
    if (pr.attempted && !offline) { rpcAttempted++; }
    if (pr.succeeded  && !offline) rpcSucceeded++;
    if (pr.failed     && !offline) rpcFailed++;
    if (pr.patched) fixturesPatched++;

    enriched.push(patched);

    if (pr.attempted && delayMs > 0) {
      await sleepFn(delayMs);
    }
  }

  // Slippage risk counts after enrichment
  const slippageRiskCounts: Record<string, number> = {};
  for (const f of enriched) {
    const risk = slippageRiskFromRaw(f.raw as Record<string, unknown> | undefined);
    slippageRiskCounts[risk] = (slippageRiskCounts[risk] ?? 0) + 1;
  }

  if (!dryRun) {
    writeFixturesJsonlAtomicQuote(enriched, outputPath);
  }

  return {
    inputPath, outputPath, inputMissing: false, offlineMode: offline, dryRun,
    fixturesRead: fixtures.length,
    candidatesEvaluated,
    fixturesPatched,
    skippedAlreadyQuoted,
    skippedMissingContract,
    skippedNotCandidate,
    rpcAttempted, rpcSucceeded, rpcFailed,
    slippageRiskCounts,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderFixtureQuotePreviewReport(result: FixtureQuotePreviewResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — FIXTURE QUOTE PREVIEW');
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

  const mode = result.offlineMode ? '(offline — no RPC)' : result.dryRun ? '(dry-run — no write)' : '';

  lines.push('');
  lines.push(`  Input  : ${result.inputPath}`);
  lines.push(`  Output : ${result.outputPath}${result.dryRun ? '  [NOT written — dry-run]' : ''}`);
  if (mode) lines.push(`  Mode   : ${mode}`);
  lines.push('');

  lines.push('  QUOTE PREVIEW SUMMARY');
  lines.push(`  Fixtures read              : ${result.fixturesRead}`);
  lines.push(`  Candidates evaluated       : ${result.candidatesEvaluated}`);
  lines.push(`  Fixtures patched           : ${result.fixturesPatched}`);
  lines.push(`  Skipped already quoted     : ${result.skippedAlreadyQuoted}`);
  lines.push(`  Skipped missing contract   : ${result.skippedMissingContract}`);
  lines.push(`  Skipped not candidate      : ${result.skippedNotCandidate}`);
  lines.push('');

  if (!result.offlineMode && result.candidatesEvaluated > 0) {
    lines.push('  RPC CALLS (Jupiter quote API — read-only)');
    lines.push(`  Attempted  : ${result.rpcAttempted}`);
    lines.push(`  Succeeded  : ${result.rpcSucceeded}`);
    lines.push(`  Failed     : ${result.rpcFailed}`);
    lines.push('');
  }

  if (Object.keys(result.slippageRiskCounts).length > 0) {
    const total = result.fixturesRead;
    const pct = (n: number) => total > 0 ? ` (${((n / total) * 100).toFixed(1)}%)` : '';
    lines.push('  SLIPPAGE RISK DISTRIBUTION (all fixtures after preview)');
    for (const risk of ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN']) {
      const n = result.slippageRiskCounts[risk] ?? 0;
      if (n > 0) lines.push(`    ${risk.padEnd(8)} : ${String(n).padStart(3)}${pct(n)}`);
    }
    lines.push('');
  }

  if (result.fixturesPatched > 0 && !result.dryRun && !result.offlineMode) {
    lines.push('  Run these to see updated results:');
    lines.push('    npm run token:quote-preview-audit');
    lines.push('    npm run token:prime-gate-audit -- --strict-preview');
    lines.push('');
  }

  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderFixtureQuotePreviewUsage(): string {
  return `
token:fixture-quote-preview — estimate buy slippage/liquidity for live fixture candidates

Usage:
  npm run token:fixture-quote-preview [options]

Options:
  --input <path>        Input JSONL fixture file (default: data/token-grab/ripper/live-fixtures.jsonl)
  --output <path>       Output path (default: overwrite input atomically)
  --limit <n>           Only evaluate up to N candidates this run
  --delay-ms <n>        Milliseconds between Jupiter API calls (default: 500)
  --amount-usd <n>      Approximate USD label for the preview buy (default: 10)
  --force               Re-fetch even already-quoted fixtures
  --include-watch       Also quote WATCH-tier candidates (default: only BUY_APPROVED_PAPER + READY_TO_SNIPE_PAPER)
  --offline             Skip API calls, leave all quote fields UNKNOWN
  --dry-run             Show what would be done, do not write output
  --help                Show this message

Behavior:
  For each candidate fixture (BUY_APPROVED_PAPER or READY_TO_SNIPE_PAPER), queries the
  Jupiter quote API (SOL → token, 0.01 SOL ≈ $1-2) to estimate price impact.
  Patches fixture.raw with: quoteProvider, quoteCheckedAt, quoteOk, slippageRisk,
  liquidityTradable, priceImpactPct, routeFound, quoteFetchError (if failed).
  Skips fixtures that already have quoteCheckedAt (from a non-offline run) unless --force.
  Writes output atomically (temp + rename).

Slippage classification:
  CLEAN  : priceImpact ≤ 3%
  WATCH  : priceImpact 3–10%
  RISKY  : priceImpact > 10% or no viable route
  UNKNOWN: no quote data / offline / error

Reuses Jupiter quote API endpoint from existing quoteCheck.ts infrastructure.
No transactions created. No signing. No swap execution.

After preview:
  npm run token:quote-preview-audit      → see slippage distribution
  npm run token:prime-gate-audit -- --strict-preview → see gate impact

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Read-only.
`.trim();
}
