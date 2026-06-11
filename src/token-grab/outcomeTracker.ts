import * as fs from 'fs';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import { extractReadinessFields, classifyReadinessLevel } from './autonomyReadinessAudit';
import { fetchPairSnapshot, type DexPairSnapshot } from './dexWatch';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutcomeStatus = 'RIPPED' | 'MOVED' | 'FLAT' | 'DUMPED' | 'UNKNOWN';

export interface OutcomeCandidate {
  contract:          string;
  symbol:            string;
  chainId:           string;
  pairUrl:           string | null;
  pairAddress:       string | null;
  detectedAt:        string;
  detectedPriceUsd:  number | null;
  latestPriceUsd:    number | null;
  liquidityUsd:      number | null;
  topHolderPercent:  number | null;
  clusterRisk:       string;
  currentReturnPct:  number | null;
  status:            OutcomeStatus;
}

export interface OutcomeTrackerOptions {
  inputPath?:   string;
  generatedAt?: string;
  fetch?:       (contract: string, chain: string, observedAt: string) => Promise<DexPairSnapshot | null>;
}

export interface OutcomeTrackerResult {
  inputPath:    string;
  inputMissing: boolean;
  generatedAt:  string;
  candidateCount: number;
  statusCounts:   Record<OutcomeStatus, number>;
  candidates:     OutcomeCandidate[];
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly:       true;
  readOnly:        true;
}

// ── Status classification ─────────────────────────────────────────────────────

export function classifyOutcomeStatus(returnPct: number | null): OutcomeStatus {
  if (returnPct === null) return 'UNKNOWN';
  if (returnPct >= 50)   return 'RIPPED';
  if (returnPct >= 15)   return 'MOVED';
  if (returnPct <= -15)  return 'DUMPED';
  return 'FLAT';
}

// ── Field extraction helpers ──────────────────────────────────────────────────

function toPositiveNum(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

function extractCandidateFields(fixture: LiveRipperFixture): {
  contract: string | null;
  symbol: string;
  chainId: string;
  pairUrl: string | null;
  pairAddress: string | null;
  detectedAt: string;
  detectedPriceUsd: number | null;
  liquidityUsd: number | null;
  topHolderPercent: number | null;
  clusterRisk: string;
} {
  const sig      = fixture.normalizedSignal as Record<string, unknown> | undefined;
  const raw      = fixture.raw as Record<string, unknown> | undefined;
  const ri       = fixture.ripperInput as Record<string, unknown> | null;
  const rawEntry = raw?.['entry'] as Record<string, unknown> | undefined;
  const rawFinal = raw?.['final'] as Record<string, unknown> | undefined;

  const contract =
    (rawEntry?.['contract'] as string | undefined) ??
    (raw?.['contract']      as string | undefined) ??
    (ri?.['contract']       as string | undefined) ??
    null;

  const symbol =
    (rawEntry?.['symbol'] as string | undefined) ??
    (sig?.['symbol']      as string | undefined) ??
    (raw?.['symbol']      as string | undefined) ??
    'UNKNOWN';

  const chainId =
    (rawEntry?.['chainId'] as string | undefined) ??
    (raw?.['chainId']      as string | undefined) ??
    (sig?.['chainId']      as string | undefined) ??
    'solana';

  const pairUrl =
    (rawEntry?.['pairUrl'] as string | undefined) ??
    (raw?.['pairUrl']      as string | undefined) ??
    (sig?.['pairUrl']      as string | undefined) ??
    null;

  const pairAddress =
    (rawEntry?.['pairAddress'] as string | undefined) ??
    (raw?.['pairAddress']      as string | undefined) ??
    (sig?.['pairAddress']      as string | undefined) ??
    null;

  // Detection timestamp: raw.entry.observedAt → raw.final.observedAt → raw.observedAt → sig.observedAt → capturedAt
  const detectedAt =
    (rawEntry?.['observedAt'] as string | undefined) ??
    (rawFinal?.['observedAt'] as string | undefined) ??
    (raw?.['observedAt']      as string | undefined) ??
    (sig?.['observedAt']      as string | undefined) ??
    fixture.capturedAt;

  // Detection price: raw.entry.priceUsd → raw.final.priceUsd → raw.priceUsd → sig.priceUsd → ri.priceUsd
  const detectedPriceUsd =
    toPositiveNum(rawEntry?.['priceUsd']) ??
    toPositiveNum(rawFinal?.['priceUsd']) ??
    toPositiveNum(raw?.['priceUsd'])      ??
    toPositiveNum(sig?.['priceUsd'])      ??
    toPositiveNum(ri?.['priceUsd']);

  // Liquidity: raw.entry.liquidityUsd → raw.liquidityUsd → sig.liquidityUsd → ri.liquidityUsd
  const liquidityUsd =
    toPositiveNum(rawEntry?.['liquidityUsd']) ??
    toPositiveNum(raw?.['liquidityUsd'])      ??
    toPositiveNum(sig?.['liquidityUsd'])      ??
    toPositiveNum(ri?.['liquidityUsd']);

  const rawHolder = raw?.['topHolderPercent'] ?? ri?.['topHolderPercent'];
  const topHolderPercent =
    typeof rawHolder === 'number' ? rawHolder : null;

  const rawCluster = raw?.['clusterRisk'];
  const clusterRisk =
    rawCluster === 'CLEAN' || rawCluster === 'WATCH' || rawCluster === 'RISKY'
      ? (rawCluster as string)
      : 'UNKNOWN';

  return { contract, symbol, chainId, pairUrl, pairAddress, detectedAt,
           detectedPriceUsd, liquidityUsd, topHolderPercent, clusterRisk };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

const DEFAULT_FETCH = (contract: string, chain: string, observedAt: string) =>
  fetchPairSnapshot(contract, { chain, observedAt });

export async function runOutcomeTracker(
  options: OutcomeTrackerOptions = {},
): Promise<OutcomeTrackerResult> {
  const inputPath   = options.inputPath   ?? DEFAULT_INPUT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const doFetch     = options.fetch ?? DEFAULT_FETCH;

  const emptyCounts: Record<OutcomeStatus, number> = {
    RIPPED: 0, MOVED: 0, FLAT: 0, DUMPED: 0, UNKNOWN: 0,
  };

  const emptyResult: OutcomeTrackerResult = {
    inputPath, inputMissing: true, generatedAt,
    candidateCount: 0, statusCounts: { ...emptyCounts }, candidates: [],
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };

  if (!fs.existsSync(inputPath)) return emptyResult;

  let fixtures: LiveRipperFixture[];
  try {
    fixtures = readFixturesFromJsonl(inputPath);
  } catch {
    return emptyResult;
  }

  // De-duplicate by contract: keep earliest FUTURE_AUTONOMY_CANDIDATE per contract
  const byContract = new Map<string, LiveRipperFixture>();
  for (const fixture of fixtures) {
    const fields = extractReadinessFields(fixture);
    const { level } = classifyReadinessLevel(fields);
    if (level !== 'FUTURE_AUTONOMY_CANDIDATE') continue;

    const { contract } = extractCandidateFields(fixture);
    if (!contract) continue;

    const existing = byContract.get(contract);
    if (!existing) {
      byContract.set(contract, fixture);
    } else {
      if (fixture.capturedAt < existing.capturedAt) {
        byContract.set(contract, fixture);
      }
    }
  }

  // Fetch current prices and build candidates
  const candidates: OutcomeCandidate[] = [];
  for (const [contract, fixture] of byContract) {
    const cf = extractCandidateFields(fixture);

    const snapshot = await doFetch(contract, cf.chainId, generatedAt);
    const latestPriceUsd = snapshot?.priceUsd ?? null;

    const currentReturnPct =
      cf.detectedPriceUsd !== null && latestPriceUsd !== null
        ? ((latestPriceUsd - cf.detectedPriceUsd) / cf.detectedPriceUsd) * 100
        : null;

    const status = classifyOutcomeStatus(currentReturnPct);

    candidates.push({
      contract,
      symbol:           cf.symbol,
      chainId:          cf.chainId,
      pairUrl:          cf.pairUrl,
      pairAddress:      cf.pairAddress,
      detectedAt:       cf.detectedAt,
      detectedPriceUsd: cf.detectedPriceUsd,
      latestPriceUsd,
      liquidityUsd:     cf.liquidityUsd,
      topHolderPercent: cf.topHolderPercent,
      clusterRisk:      cf.clusterRisk,
      currentReturnPct,
      status,
    });
  }

  const statusCounts: Record<OutcomeStatus, number> = { ...emptyCounts };
  for (const c of candidates) {
    statusCounts[c.status]++;
  }

  return {
    inputPath, inputMissing: false, generatedAt,
    candidateCount: candidates.length,
    statusCounts,
    candidates,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmt(n: number | null, decimals = 2, suffix = ''): string {
  if (n === null) return '—';
  return `${n.toFixed(decimals)}${suffix}`;
}

function ageLabel(detectedAt: string, generatedAt: string): string {
  const ms = new Date(generatedAt).getTime() - new Date(detectedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export function renderOutcomeTrackerReport(result: OutcomeTrackerResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — OUTCOME TRACKER');
  lines.push('  [REAL TRADING LOCKED — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.inputMissing) {
    lines.push('');
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run the learning loop first:');
    lines.push('    npm run token:dex-day-watch');
    lines.push('    npm run token:live-fixture-capture');
    lines.push('    npm run token:fixture-cluster-enrich');
    lines.push('    npm run token:autonomy-readiness-audit');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  const { candidateCount, statusCounts, candidates, generatedAt } = result;

  lines.push('');
  lines.push('  1. SUMMARY');
  lines.push(`     Generated                  : ${generatedAt}`);
  lines.push(`     FUTURE_AUTONOMY_CANDIDATES : ${candidateCount}`);
  lines.push('');

  if (candidateCount === 0) {
    lines.push('  No FUTURE_AUTONOMY_CANDIDATE fixtures found.');
    lines.push('  Run token:fixture-cluster-enrich then token:autonomy-readiness-audit');
    lines.push('  to promote candidates before tracking outcomes.');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('  2. STATUS COUNTS');
  const statusOrder: OutcomeStatus[] = ['RIPPED', 'MOVED', 'FLAT', 'DUMPED', 'UNKNOWN'];
  for (const s of statusOrder) {
    lines.push(`     ${s.padEnd(10)}: ${statusCounts[s]}`);
  }
  lines.push('');

  lines.push('  3. CANDIDATES');
  lines.push('     Symbol          Entry $       Latest $      Return %   Age     Holder%  Cluster  Status');
  lines.push('     ─────────────────────────────────────────────────────────────────────────────────────────');

  for (const c of candidates) {
    const sym    = `$${c.symbol}`.padEnd(15);
    const entry  = fmt(c.detectedPriceUsd, 8).padStart(12);
    const latest = fmt(c.latestPriceUsd,   8).padStart(12);
    const ret    = (c.currentReturnPct !== null ? `${c.currentReturnPct >= 0 ? '+' : ''}${c.currentReturnPct.toFixed(1)}%` : '—').padStart(9);
    const age    = ageLabel(c.detectedAt, generatedAt).padEnd(7);
    const holder = fmt(c.topHolderPercent, 1, '%').padStart(7);
    const cluster = c.clusterRisk.padEnd(8);
    lines.push(`     ${sym}${entry}  ${latest}  ${ret}  ${age} ${holder}  ${cluster} ${c.status}`);
    if (c.pairUrl) {
      lines.push(`       ↳ ${c.pairUrl}`);
    }
  }
  lines.push('');

  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('  Note: UNKNOWN return = no entry or latest price available.');
  lines.push('  Entry price is the USD price stored at detection time (often null');
  lines.push('  for pump.fun tokens without a stored priceUsd).');
  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}
