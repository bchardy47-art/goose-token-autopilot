import fs from 'node:fs';
import path from 'node:path';
import type { WinnerCandidate, DexWinnerCandidateReport } from './dexWinnerCandidateReport';
import type {
  MintAuthorityStatus,
  FreezeAuthorityStatus,
  HolderConcentrationStatus,
} from './dexLegitimacyReport';

// ── Provider interface ────────────────────────────────────────────────────────────────────

// Injectable so tests use mocks and real provider can be swapped in without
// @solana/web3.js — we drive Solana via raw JSON-RPC fetch, same as solanaSafety.ts.
export interface SolanaTokenSafetyProvider {
  fetchMintAuthority(contract: string): Promise<MintAuthorityStatus>;
  fetchFreezeAuthority(contract: string): Promise<FreezeAuthorityStatus>;
  fetchTopHolderPct(contract: string): Promise<number | null>;
}

// Offline provider — all fields UNKNOWN, zero network calls.  Used by --offline and tests.
export const offlineSafetyProvider: SolanaTokenSafetyProvider = {
  fetchMintAuthority: async (_c) => 'UNKNOWN',
  fetchFreezeAuthority: async (_c) => 'UNKNOWN',
  fetchTopHolderPct: async (_c) => null,
};

// ── Real RPC provider (raw fetch, no @solana/web3.js needed) ─────────────────────────────

async function rpcRequest(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown };
  return json.result ?? null;
}

export function createRpcSafetyProvider(rpcUrl: string): SolanaTokenSafetyProvider {
  // Cache getAccountInfo per contract so mint + freeze share a single RPC call.
  const mintAccountCache = new Map<string, Promise<{ mint: MintAuthorityStatus; freeze: FreezeAuthorityStatus }>>();

  function getMintAccount(contract: string) {
    if (!mintAccountCache.has(contract)) {
      mintAccountCache.set(
        contract,
        (async () => {
          try {
            const result = await rpcRequest(rpcUrl, 'getAccountInfo', [contract, { encoding: 'jsonParsed' }]) as { value?: { data?: { parsed?: { info?: { mintAuthority?: string | null; freezeAuthority?: string | null } } } } } | null;
            const info = result?.value?.data?.parsed?.info;
            if (!info) return { mint: 'UNKNOWN' as MintAuthorityStatus, freeze: 'UNKNOWN' as FreezeAuthorityStatus };
            return {
              mint: (info.mintAuthority == null ? 'RENOUNCED' : 'ACTIVE') as MintAuthorityStatus,
              freeze: (info.freezeAuthority == null ? 'RENOUNCED' : 'ACTIVE') as FreezeAuthorityStatus,
            };
          } catch {
            return { mint: 'UNKNOWN' as MintAuthorityStatus, freeze: 'UNKNOWN' as FreezeAuthorityStatus };
          }
        })(),
      );
    }
    return mintAccountCache.get(contract)!;
  }

  return {
    async fetchMintAuthority(contract) {
      return (await getMintAccount(contract)).mint;
    },
    async fetchFreezeAuthority(contract) {
      return (await getMintAccount(contract)).freeze;
    },
    async fetchTopHolderPct(contract) {
      try {
        const largest = await rpcRequest(rpcUrl, 'getTokenLargestAccounts', [contract]) as { value?: Array<{ amount?: string }> } | null;
        const value = largest?.value;
        if (!Array.isArray(value) || value.length === 0) return null;
        const supply = await rpcRequest(rpcUrl, 'getTokenSupply', [contract]) as { value?: { amount?: string } } | null;
        const supplyAmt = Number(supply?.value?.amount ?? 0);
        if (supplyAmt <= 0) return null;
        const topAmt = Number(value[0]?.amount ?? 0);
        if (topAmt <= 0) return null;
        return (topAmt / supplyAmt) * 100;
      } catch {
        return null;
      }
    },
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────────────────

export type CandidateSafetyVerdict = 'PASS_TO_HUMAN' | 'HIGH_CONVICTION_WATCH' | 'WATCH' | 'KILL';
export type SafetyFinalRecommendation = 'PASS_TO_HUMAN' | 'HIGH_CONVICTION_WATCH' | 'WATCH' | 'NO_SURVIVORS';

export interface EnrichedCandidate {
  originalTier: string;
  symbol?: string;
  contract: string;
  sourceRunFile?: string;
  observedAt?: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  paperExitReason?: string;
  paperFakePnlDollars?: number;
  mintAuthorityStatus: MintAuthorityStatus;
  freezeAuthorityStatus: FreezeAuthorityStatus;
  holderConcentrationStatus: HolderConcentrationStatus;
  topHolderPercent?: number;
  safetyVerdict: CandidateSafetyVerdict;
  safetyReasons: string[];
  missingSignals: string[];
}

export interface KilledCandidate {
  symbol?: string;
  contract: string;
  killReasons: string[];
}

export interface DexCandidateSafetyEnrichReport {
  generatedAt: string;
  sourceFile: string;
  candidatesEnriched: number;
  killedCount: number;
  passToHumanCount: number;
  highConvictionWatchCount: number;
  watchCount: number;
  candidates: EnrichedCandidate[];
  killed?: KilledCandidate[];
  finalRecommendation: SafetyFinalRecommendation;
  rpcAvailable: boolean;
  tradingExecuted: 0;
  noRealTradeSent: true;
  readOnly: true;
  paperOnly: true;
}

export interface DexCandidateSafetyEnrichOptions {
  candidatesPath?: string;
  outPath: string;
  rpcUrl?: string;
  debug?: boolean;
  offline?: boolean;
  generatedAt?: string;
}

// ── Pure enrichment helpers ───────────────────────────────────────────────────────────────

const SAFETY_TIER_ORDER = ['PASS_TO_HUMAN', 'HIGH_CONVICTION_WATCH', 'WATCH'] as const;

export function holderPctToStatus(pct: number | null): HolderConcentrationStatus {
  if (pct === null) return 'UNKNOWN';
  if (pct >= 30) return 'DANGER';
  if (pct >= 15) return 'WARNING';
  return 'CLEAN';
}

export type EnrichResult =
  | { type: 'survivor'; candidate: EnrichedCandidate }
  | { type: 'killed'; killed: KilledCandidate };

export async function enrichCandidateResult(
  candidate: WinnerCandidate,
  provider: SolanaTokenSafetyProvider,
): Promise<EnrichResult> {
  const [mintStatus, freezeStatus, topHolderPct] = await Promise.all([
    provider.fetchMintAuthority(candidate.contract).catch((): MintAuthorityStatus => 'UNKNOWN'),
    provider.fetchFreezeAuthority(candidate.contract).catch((): FreezeAuthorityStatus => 'UNKNOWN'),
    provider.fetchTopHolderPct(candidate.contract).catch(() => null as null),
  ]);

  const holderStatus = holderPctToStatus(topHolderPct);

  // ── Hard kills ──
  const killReasons: string[] = [];
  if (freezeStatus === 'ACTIVE') killReasons.push('freeze authority ACTIVE');
  if (holderStatus === 'DANGER') {
    killReasons.push(`top holder ${topHolderPct!.toFixed(1)}% >= 30% (DANGER)`);
  } else if (topHolderPct !== null && topHolderPct >= 30) {
    killReasons.push(`top holder ${topHolderPct.toFixed(1)}% >= 30%`);
  }

  if (killReasons.length > 0) {
    return {
      type: 'killed',
      killed: { symbol: candidate.symbol, contract: candidate.contract, killReasons },
    };
  }

  // ── Soft downgrades — reduce tier ceiling ──
  let tierIdx = SAFETY_TIER_ORDER.indexOf(candidate.tier as (typeof SAFETY_TIER_ORDER)[number]);
  if (tierIdx < 0) tierIdx = 2;

  const safetyReasons: string[] = [];
  const missingSignals: string[] = [];

  // mint ACTIVE: never PASS_TO_HUMAN; stays HIGH_CONVICTION_WATCH if other safety clean
  if (mintStatus === 'ACTIVE') {
    tierIdx = Math.max(tierIdx, 1);
    safetyReasons.push('mint authority ACTIVE — capped below PASS_TO_HUMAN');
  } else if (mintStatus === 'RENOUNCED') {
    safetyReasons.push('mint authority RENOUNCED');
  }

  // holder WARNING: downgrade to WATCH
  if (holderStatus === 'WARNING') {
    tierIdx = Math.max(tierIdx, 2);
    safetyReasons.push(`top holder ${topHolderPct!.toFixed(1)}% >= 15% (WARNING) — downgraded to WATCH`);
  } else if (holderStatus === 'CLEAN') {
    safetyReasons.push(`top holder ${topHolderPct!.toFixed(1)}% < 15% (CLEAN)`);
  }

  if (freezeStatus === 'RENOUNCED') safetyReasons.push('freeze authority RENOUNCED');

  if (mintStatus === 'UNKNOWN' || freezeStatus === 'UNKNOWN') missingSignals.push('MINT_FREEZE_NOT_CONNECTED');
  if (holderStatus === 'UNKNOWN') missingSignals.push('HOLDER_MAP_NOT_CONNECTED');

  const safetyVerdict = SAFETY_TIER_ORDER[Math.min(tierIdx, 2)] as CandidateSafetyVerdict;

  return {
    type: 'survivor',
    candidate: {
      originalTier: candidate.tier,
      symbol: candidate.symbol,
      contract: candidate.contract,
      sourceRunFile: candidate.sourceRunFile,
      observedAt: candidate.observedAt,
      priceChangePct: candidate.priceChangePct,
      liquidityChangePct: candidate.liquidityChangePct,
      volumeLiquidityRatio: candidate.volumeLiquidityRatio,
      paperExitReason: candidate.paperExitReason,
      paperFakePnlDollars: candidate.paperFakePnlDollars,
      mintAuthorityStatus: mintStatus,
      freezeAuthorityStatus: freezeStatus,
      holderConcentrationStatus: holderStatus,
      topHolderPercent: topHolderPct ?? undefined,
      safetyVerdict,
      safetyReasons: safetyReasons.slice(0, 5),
      missingSignals,
    },
  };
}

// ── Builder — pure async ──────────────────────────────────────────────────────────────────

export async function buildDexCandidateSafetyEnrichReport(
  winnerReport: DexWinnerCandidateReport,
  opts: {
    sourceFile: string;
    provider: SolanaTokenSafetyProvider;
    debug?: boolean;
    generatedAt?: string;
    rpcAvailable?: boolean;
  },
): Promise<DexCandidateSafetyEnrichReport> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const survivors: EnrichedCandidate[] = [];
  const killed: KilledCandidate[] = [];

  // Only enrich listed candidates — never touch rejected tokens.
  for (const c of winnerReport.candidates) {
    const result = await enrichCandidateResult(c, opts.provider);
    if (result.type === 'survivor') {
      survivors.push(result.candidate);
    } else {
      killed.push(result.killed);
    }
  }

  const passToHumanCount = survivors.filter(c => c.safetyVerdict === 'PASS_TO_HUMAN').length;
  const highConvictionWatchCount = survivors.filter(c => c.safetyVerdict === 'HIGH_CONVICTION_WATCH').length;
  const watchCount = survivors.filter(c => c.safetyVerdict === 'WATCH').length;

  let finalRecommendation: SafetyFinalRecommendation;
  if (passToHumanCount > 0) finalRecommendation = 'PASS_TO_HUMAN';
  else if (highConvictionWatchCount > 0) finalRecommendation = 'HIGH_CONVICTION_WATCH';
  else if (watchCount > 0) finalRecommendation = 'WATCH';
  else finalRecommendation = 'NO_SURVIVORS';

  return {
    generatedAt,
    sourceFile: opts.sourceFile,
    candidatesEnriched: winnerReport.candidateCount,
    killedCount: killed.length,
    passToHumanCount,
    highConvictionWatchCount,
    watchCount,
    candidates: survivors,
    ...(opts.debug ? { killed } : {}),
    finalRecommendation,
    rpcAvailable: opts.rpcAvailable ?? false,
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  };
}

// ── I/O helpers ───────────────────────────────────────────────────────────────────────────

export function loadDexWinnerCandidateReportFile(filePath: string): DexWinnerCandidateReport | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DexWinnerCandidateReport;
  } catch {
    return null;
  }
}

export function writeDexCandidateSafetyEnrichReport(
  report: DexCandidateSafetyEnrichReport,
  outPath: string,
): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
}

// ── Orchestrator ──────────────────────────────────────────────────────────────────────────

function buildEmptyWinnerReport(sourceFile: string, generatedAt: string): DexWinnerCandidateReport {
  return {
    generatedAt,
    sourceFile,
    candidateCount: 0,
    passToHumanCount: 0,
    highConvictionWatchCount: 0,
    watchCount: 0,
    rejectedCount: 0,
    rejectCategoryCounts: {},
    candidates: [],
    finalRecommendation: 'NO_CANDIDATES',
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  };
}

export async function runDexCandidateSafetyEnrich(
  options: DexCandidateSafetyEnrichOptions,
): Promise<DexCandidateSafetyEnrichReport> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const candidatesPath =
    options.candidatesPath ??
    'data/token-grab/legitimacy/dex-winner-candidates-today.json';

  const winnerReport =
    loadDexWinnerCandidateReportFile(candidatesPath) ??
    buildEmptyWinnerReport(candidatesPath, generatedAt);

  let provider: SolanaTokenSafetyProvider;
  let rpcAvailable = false;

  if (options.offline) {
    provider = offlineSafetyProvider;
  } else {
    const rpcUrl = options.rpcUrl ?? process.env['SOLANA_RPC_URL'] ?? '';
    if (rpcUrl) {
      provider = createRpcSafetyProvider(rpcUrl);
      rpcAvailable = true;
    } else {
      provider = offlineSafetyProvider;
    }
  }

  const report = await buildDexCandidateSafetyEnrichReport(winnerReport, {
    sourceFile: candidatesPath,
    provider,
    debug: options.debug,
    generatedAt,
    rpcAvailable,
  });

  writeDexCandidateSafetyEnrichReport(report, options.outPath);
  return report;
}

// ── Usage string ──────────────────────────────────────────────────────────────────────────

export function renderDexCandidateSafetyEnrichUsage(): string {
  return [
    'Usage: npm run token:dex-candidate-safety-enrich -- [options]',
    '',
    'Reads the winner candidate report and enriches surviving candidates',
    '(PASS_TO_HUMAN, HIGH_CONVICTION_WATCH, WATCH) with on-chain safety data:',
    '  mint authority, freeze authority, top holder concentration.',
    '',
    'Junk tokens are never fetched or enriched — only candidates that survived',
    'the winner candidate report are checked against the chain.',
    'READ-ONLY. PAPER ONLY. No wallet. No signing. No swap. tradingExecuted: 0.',
    '',
    '@solana/web3.js is NOT required — raw Solana JSON-RPC via fetch is used.',
    'Set SOLANA_RPC_URL env var or pass --rpc-url. Without RPC all safety fields',
    'return UNKNOWN and missingSignals are flagged (no crash).',
    '',
    'Options:',
    '  --candidates <path>  Winner candidates JSON',
    '                       (default: data/token-grab/legitimacy/dex-winner-candidates-today.json)',
    '  --out <path>         Output JSON',
    '                       (default: data/token-grab/legitimacy/dex-winner-candidates-enriched-today.json)',
    '  --rpc-url <url>      Solana RPC URL (or set SOLANA_RPC_URL env var)',
    '  --offline            Skip RPC entirely — all safety data UNKNOWN',
    '  --debug              Show killed candidate symbols and reasons',
    '  --json               Output JSON instead of text',
    '  --help, -h           Show this help and exit',
    '',
    'Hard kill rules (candidate removed, listed as "Killed silently: X"):',
    '  freeze authority ACTIVE',
    '  top holder >= 30% (holder concentration DANGER)',
    '',
    'Soft downgrade rules (candidate survives at lower tier):',
    '  mint authority ACTIVE     → cap at HIGH_CONVICTION_WATCH (never PASS_TO_HUMAN)',
    '  top holder 15–29%         → downgrade to WATCH (WARNING)',
    '',
    'Output written to data/token-grab/legitimacy/ (untracked).',
    'Do not run token:auto-paper. No real trade is sent.',
  ].join('\n');
}

// ── Renderer — pure ───────────────────────────────────────────────────────────────────────

const FINAL_REC_DESC: Record<SafetyFinalRecommendation, string> = {
  PASS_TO_HUMAN: 'Clean candidate found — review PASS_TO_HUMAN entries before acting',
  HIGH_CONVICTION_WATCH: 'Strong watch candidate — safety checks pass, paper result inconclusive',
  WATCH: 'Weak watch — safety data passes but needs more cycles to confirm',
  NO_SURVIVORS: 'All candidates killed by safety rules — run more cycles or check data',
};

export function renderDexCandidateSafetyEnrichReport(
  report: DexCandidateSafetyEnrichReport,
  debug?: boolean,
): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB CANDIDATE SAFETY ENRICHMENT V1');
  lines.push('  PAPER ONLY — READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  No wallet. No signing. No swap. No liveHarness changes.');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Generated at        : ${report.generatedAt}`);
  lines.push(`  Source              : ${report.sourceFile}`);
  lines.push(
    `  RPC connected       : ${report.rpcAvailable ? 'YES' : 'NO (offline / SOLANA_RPC_URL not set)'}`,
  );
  lines.push('');
  lines.push(`  Final recommendation: ${report.finalRecommendation}`);
  lines.push(`  ${FINAL_REC_DESC[report.finalRecommendation]}`);
  lines.push('');
  lines.push(`  Candidates enriched : ${report.candidatesEnriched}`);
  lines.push(`  Killed              : ${report.killedCount}`);
  if (report.passToHumanCount > 0 || report.highConvictionWatchCount > 0 || report.watchCount > 0) {
    lines.push('  Survivors');
    if (report.passToHumanCount > 0)
      lines.push(`    PASS_TO_HUMAN         : ${report.passToHumanCount}`);
    if (report.highConvictionWatchCount > 0)
      lines.push(`    HIGH_CONVICTION_WATCH : ${report.highConvictionWatchCount}`);
    if (report.watchCount > 0)
      lines.push(`    WATCH                 : ${report.watchCount}`);
  }

  if (report.candidates.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Surviving Candidates');
    lines.push(THIN);

    for (const c of report.candidates) {
      const sym = (c.symbol ? `$${c.symbol}` : '(no sym)').padEnd(14);
      lines.push(`  ${sym} ${c.safetyVerdict}`);
      lines.push(`  ${c.contract}`);
      const holderStr =
        c.topHolderPercent != null
          ? ` (${c.topHolderPercent.toFixed(1)}%)`
          : '';
      lines.push(
        `  mint: ${c.mintAuthorityStatus}  freeze: ${c.freezeAuthorityStatus}  holder: ${c.holderConcentrationStatus}${holderStr}`,
      );
      if (c.safetyReasons.length > 0) {
        lines.push(`  ${c.safetyReasons.slice(0, 3).join(' | ')}`);
      }
      if (c.missingSignals.length > 0) {
        lines.push(`  missing: ${c.missingSignals.join(', ')}`);
      }
      lines.push('');
    }
  } else {
    lines.push('');
    lines.push('  No survivors this cycle.');
    lines.push('');
  }

  lines.push(`  Killed silently: ${report.killedCount}`);

  if (debug && report.killed && report.killed.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Killed (debug)');
    lines.push(THIN);
    for (const k of report.killed) {
      const sym = (k.symbol ? `$${k.symbol}` : '(no sym)').padEnd(14);
      lines.push(`  ${sym} ${k.killReasons.slice(0, 2).join('; ')}`);
    }
  }

  if (!report.rpcAvailable) {
    lines.push('');
    lines.push('  NOTE: SOLANA_RPC_URL not set — all safety fields are UNKNOWN.');
    lines.push('  To enrich with real data: set SOLANA_RPC_URL or pass --rpc-url <url>.');
  }

  lines.push('');
  lines.push(WIDE);
  lines.push('  SAFETY ENRICHMENT — paper-only — no positions opened');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
