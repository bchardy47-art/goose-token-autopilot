import fs from 'node:fs';
import type { PreSignal } from './xEarsPreSignal';
import { sleep } from './snapshot';

// ── Constants ───────────────────────────────────────────────────────────────────

const DEX_TOKENS_BASE = 'https://api.dexscreener.com/latest/dex/tokens';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Movement thresholds (percent). */
export const WINNER_PCT = 20;
export const LOSER_PCT = -20;

// ── Public types ─────────────────────────────────────────────────────────────────

/** A single read-only price/liquidity/volume observation for one contract. */
export interface DexPairSnapshot {
  contract: string;
  chainId: string;
  pairAddress?: string;
  pairUrl?: string;
  symbol?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
  observedAt: string;
}

export type DexWatchClass = 'winner' | 'loser' | 'flat' | 'missing';

/** Entry → final outcome for one watched signal. */
export interface DexWatchOutcome {
  signalId: string;
  contract: string;
  symbol?: string;
  chainId: string;
  pairUrl?: string;
  entry?: DexPairSnapshot;
  final?: DexPairSnapshot;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeToLiquidityRatio?: number;
  classification: DexWatchClass;
}

export interface DexWatchReport {
  signalsRead: number;
  signalsWatched: number;
  contractsFiltered: number;
  snapshotsFound: number;
  snapshotsMissing: number;
  chain: string;
  minutes: number;
  intervalSeconds: number;
  winners: DexWatchOutcome[];
  losers: DexWatchOutcome[];
  flat: DexWatchOutcome[];
  missing: DexWatchOutcome[];
  topMovers: DexWatchOutcome[];
  dryRun: boolean;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

function toPositiveNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Solana addresses are base58, 32-44 chars, no 0x prefix. */
export function isSolanaContract(addr: unknown): addr is string {
  if (typeof addr !== 'string') return false;
  if (addr.startsWith('0x')) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

// ── Signal loading + filtering — pure ─────────────────────────────────────────────

export function parsePresignals(raw: unknown): PreSignal[] {
  if (!Array.isArray(raw)) return [];
  const out: PreSignal[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj['id'] !== 'string') continue;
    out.push(obj as unknown as PreSignal);
  }
  return out;
}

export function loadPresignals(signalsPath: string): PreSignal[] {
  const raw = JSON.parse(fs.readFileSync(signalsPath, 'utf-8')) as unknown;
  return parsePresignals(raw);
}

/**
 * Keeps only signals carrying a usable Solana contract address, deduped by contract.
 * Non-Solana / contract-less signals are dropped (we cannot watch them on DEX Screener Solana).
 */
export function filterContractSignals(signals: PreSignal[], chain = 'solana'): PreSignal[] {
  const seen = new Set<string>();
  const out: PreSignal[] = [];
  const wantSolana = chain.toLowerCase() === 'solana';
  for (const sig of signals) {
    const contract = sig.contract;
    if (typeof contract !== 'string' || contract.length === 0) continue;
    if (wantSolana && !isSolanaContract(contract)) continue;
    const key = contract.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sig);
  }
  return out;
}

// ── DEX Screener pair response parsing — pure ─────────────────────────────────────

interface RawPair {
  chainId?: string;
  pairAddress?: string;
  url?: string;
  baseToken?: { address?: string; symbol?: string };
  priceUsd?: string | number;
  liquidity?: { usd?: string | number };
  volume?: { h24?: string | number; h6?: string | number; h1?: string | number; m5?: string | number };
}

/**
 * Parses a DEX Screener `/latest/dex/tokens/{addr}` response into a single best snapshot.
 * Picks the pair with the highest USD liquidity. Returns null when no usable pair exists.
 */
export function parsePairResponse(
  raw: unknown,
  contract: string,
  observedAt: string,
  chain = 'solana',
): DexPairSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const pairs = (raw as { pairs?: unknown }).pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) return null;

  const wantChain = chain.toLowerCase();
  let best: RawPair | undefined;
  let bestLiq = -1;
  for (const p of pairs) {
    if (typeof p !== 'object' || p === null) continue;
    const pair = p as RawPair;
    if (typeof pair.chainId === 'string' && pair.chainId.toLowerCase() !== wantChain) continue;
    const liq = toPositiveNumber(pair.liquidity?.usd) ?? 0;
    if (liq > bestLiq) {
      bestLiq = liq;
      best = pair;
    }
  }
  if (!best) return null;

  return {
    contract,
    chainId: typeof best.chainId === 'string' ? best.chainId : chain,
    pairAddress: typeof best.pairAddress === 'string' ? best.pairAddress : undefined,
    pairUrl: typeof best.url === 'string' ? best.url : undefined,
    symbol: typeof best.baseToken?.symbol === 'string' ? best.baseToken.symbol : undefined,
    priceUsd: toPositiveNumber(best.priceUsd),
    liquidityUsd: toPositiveNumber(best.liquidity?.usd),
    volumeUsd: toPositiveNumber(best.volume?.h1 ?? best.volume?.m5 ?? best.volume?.h24),
    observedAt,
  };
}

// ── Change math — pure ────────────────────────────────────────────────────────────

/** Percentage change from → to. Undefined when entry value is missing or zero. */
export function computeChangePct(from?: number, to?: number): number | undefined {
  if (from == null || to == null) return undefined;
  if (from === 0) return undefined;
  return ((to - from) / from) * 100;
}

export function classifyOutcome(priceChangePct?: number): DexWatchClass {
  if (priceChangePct == null) return 'flat';
  if (priceChangePct >= WINNER_PCT) return 'winner';
  if (priceChangePct <= LOSER_PCT) return 'loser';
  return 'flat';
}

/** Combines a signal's entry + final snapshots into a scored outcome. */
export function buildOutcome(
  signal: PreSignal,
  entry: DexPairSnapshot | null,
  final: DexPairSnapshot | null,
): DexWatchOutcome {
  const contract = signal.contract ?? '';
  const base = {
    signalId: signal.id,
    contract,
    symbol: entry?.symbol ?? signal.symbol,
    chainId: entry?.chainId ?? final?.chainId ?? 'solana',
    pairUrl: entry?.pairUrl ?? final?.pairUrl,
    entry: entry ?? undefined,
    final: final ?? undefined,
  };

  // Missing entry or final means we cannot score the move.
  if (!entry || !final) {
    return { ...base, classification: 'missing' };
  }

  const priceChangePct = computeChangePct(entry.priceUsd, final.priceUsd);
  const liquidityChangePct = computeChangePct(entry.liquidityUsd, final.liquidityUsd);
  const volumeToLiquidityRatio =
    final.volumeUsd != null && final.liquidityUsd != null && final.liquidityUsd > 0
      ? final.volumeUsd / final.liquidityUsd
      : undefined;

  return {
    ...base,
    priceChangePct,
    liquidityChangePct,
    volumeToLiquidityRatio,
    classification: classifyOutcome(priceChangePct),
  };
}

// ── Report builder — pure ─────────────────────────────────────────────────────────

export interface BuildDexWatchReportInput {
  signalsRead: number;
  outcomes: DexWatchOutcome[];
  chain: string;
  minutes: number;
  intervalSeconds: number;
  dryRun: boolean;
}

export function buildDexWatchReport(input: BuildDexWatchReportInput): DexWatchReport {
  const { outcomes } = input;

  const winners = outcomes.filter(o => o.classification === 'winner');
  const losers = outcomes.filter(o => o.classification === 'loser');
  const flat = outcomes.filter(o => o.classification === 'flat');
  const missing = outcomes.filter(o => o.classification === 'missing');

  // snapshotsFound = signals where BOTH entry and final were captured.
  const snapshotsFound = outcomes.filter(o => o.entry && o.final).length;
  const snapshotsMissing = outcomes.length - snapshotsFound;

  const topMovers = outcomes
    .filter(o => o.priceChangePct != null)
    .sort((a, b) => Math.abs(b.priceChangePct!) - Math.abs(a.priceChangePct!))
    .slice(0, 10);

  return {
    signalsRead: input.signalsRead,
    signalsWatched: outcomes.length,
    contractsFiltered: outcomes.length,
    snapshotsFound,
    snapshotsMissing,
    chain: input.chain,
    minutes: input.minutes,
    intervalSeconds: input.intervalSeconds,
    winners,
    losers,
    flat,
    missing,
    topMovers,
    dryRun: input.dryRun,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Renderer — pure ───────────────────────────────────────────────────────────────

function fmtPct(v?: number): string {
  if (v == null) return '   n/a';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function fmtUsd(v?: number): string {
  if (v == null) return 'n/a';
  if (v >= 1) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${v.toPrecision(4)}`;
}

export function renderDexWatchReport(report: DexWatchReport): string {
  const WIDE = '═'.repeat(64);
  const THIN = '─'.repeat(64);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX SIGNAL WATCH V1' + (report.dryRun ? ' [DRY RUN]' : ''));
  lines.push('  READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Chain            : ${report.chain}`);
  lines.push(`  Window           : ${report.minutes} min (every ${report.intervalSeconds}s)`);
  lines.push(`  Signals read     : ${report.signalsRead}`);
  lines.push(`  Contracts watched: ${report.signalsWatched}`);
  lines.push(`  Snapshots found  : ${report.snapshotsFound}`);
  lines.push(`  Snapshots missing: ${report.snapshotsMissing}`);
  lines.push('');
  lines.push(`  Winners (>= +${WINNER_PCT}%): ${report.winners.length}`);
  lines.push(`  Losers  (<= ${LOSER_PCT}%): ${report.losers.length}`);
  lines.push(`  Flat             : ${report.flat.length}`);
  lines.push(`  Missing pair     : ${report.missing.length}`);

  const renderRow = (o: DexWatchOutcome): string => {
    const sym = (o.symbol ? `$${o.symbol}` : '(no sym)').padEnd(10);
    const price = fmtPct(o.priceChangePct).padStart(8);
    const liq = fmtPct(o.liquidityChangePct).padStart(8);
    const vlr = o.volumeToLiquidityRatio != null ? o.volumeToLiquidityRatio.toFixed(2) : 'n/a';
    return `    ${sym} price ${price}  liq ${liq}  v/l ${vlr.padStart(6)}  ${o.contract.slice(0, 6)}…`;
  };

  if (report.topMovers.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Top movers (by |price change|):');
    for (const o of report.topMovers) lines.push(renderRow(o));
  }

  if (report.winners.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Winners:');
    for (const o of report.winners) lines.push(renderRow(o));
  }

  if (report.losers.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Losers:');
    for (const o of report.losers) lines.push(renderRow(o));
  }

  if (report.missing.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Missing pair (no entry and/or final snapshot):');
    for (const o of report.missing) {
      const sym = (o.symbol ? `$${o.symbol}` : '(no sym)').padEnd(10);
      lines.push(`    ${sym} ${o.contract.slice(0, 12)}…`);
    }
  }

  lines.push('');
  lines.push(WIDE);
  lines.push('  READ-ONLY WATCH — no trading, no wallet, no signing, no swap');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run');
  lines.push(WIDE);

  return lines.join('\n');
}

// ── Fetch — async I/O ─────────────────────────────────────────────────────────────

/**
 * Fetches one read-only snapshot for a contract from the public DEX Screener API.
 * Never throws — returns null on any error / missing pair.
 */
export async function fetchPairSnapshot(
  contract: string,
  options: {
    observedAt: string;
    chain?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<DexPairSnapshot | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chain = options.chain ?? 'solana';
  const url = `${DEX_TOKENS_BASE}/${contract}`;
  try {
    const resp = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'goose-token-autopilot/1.0' },
    });
    if (!resp.ok) return null;
    const raw = (await resp.json()) as unknown;
    return parsePairResponse(raw, contract, options.observedAt, chain);
  } catch {
    return null;
  }
}

// ── Watch orchestration — async ────────────────────────────────────────────────────

export interface RunDexWatchOptions {
  signalsPath: string;
  minutes: number;
  intervalSeconds: number;
  chain?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowFn?: () => Date;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Reads DEX presignals, captures an entry snapshot per Solana contract, waits the
 * configured window (polling at the interval as keepalive), captures a final snapshot,
 * and returns a scored report. Read-only: no DB writes, no trading.
 */
export async function runDexWatch(options: RunDexWatchOptions): Promise<DexWatchReport> {
  const {
    signalsPath,
    minutes,
    intervalSeconds,
    chain = 'solana',
    dryRun = false,
    fetchImpl = fetch,
    sleepImpl = sleep,
    nowFn = () => new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = () => {},
  } = options;

  const all = loadPresignals(signalsPath);
  const watched = filterContractSignals(all, chain);
  log(`Read ${all.length} signals; watching ${watched.length} ${chain} contracts.`);

  // ── Entry snapshots ──
  const entries = new Map<string, DexPairSnapshot | null>();
  for (const sig of watched) {
    const snap = await fetchPairSnapshot(sig.contract!, {
      observedAt: nowFn().toISOString(),
      chain,
      fetchImpl,
      timeoutMs,
    });
    entries.set(sig.id, snap);
    log(`  entry ${sig.contract!.slice(0, 8)}… ${snap ? 'ok' : 'missing'}`);
  }

  // ── Wait window, polling at the interval as keepalive ──
  const totalMs = Math.max(0, minutes * 60 * 1000);
  const stepMs = Math.max(1000, intervalSeconds * 1000);
  let elapsed = 0;
  while (elapsed < totalMs) {
    const wait = Math.min(stepMs, totalMs - elapsed);
    await sleepImpl(wait);
    elapsed += wait;
    log(`  …waited ${Math.round(elapsed / 1000)}s / ${Math.round(totalMs / 1000)}s`);
  }

  // ── Final snapshots ──
  const outcomes: DexWatchOutcome[] = [];
  for (const sig of watched) {
    const final = await fetchPairSnapshot(sig.contract!, {
      observedAt: nowFn().toISOString(),
      chain,
      fetchImpl,
      timeoutMs,
    });
    outcomes.push(buildOutcome(sig, entries.get(sig.id) ?? null, final));
  }

  return buildDexWatchReport({
    signalsRead: all.length,
    outcomes,
    chain,
    minutes,
    intervalSeconds,
    dryRun,
  });
}
