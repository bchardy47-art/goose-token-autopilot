import fs from 'node:fs';
import path from 'node:path';
import type { TokenGrabAutopsyCandidate, TokenGrabAutopsySnapshot } from './autopsy';

// ── Constants ─────────────────────────────────────────────────────────────────

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const DEFAULT_TIMEOUT_MS = 10_000;

// ── Raw GeckoTerminal shapes (inline — keeps module self-contained) ────────────

interface GeckoPoolAttrs {
  reserve_in_usd?: string | number;
  volume_usd?: { m5?: string | number; h1?: string | number; h6?: string | number; h24?: string | number };
  price_in_usd?: string | number;
  base_token_price_usd?: string | number;
  market_cap_usd?: string | number;
  fdv_usd?: string | number;
}

interface GeckoTokenAttrs {
  price_usd?: string | number;
  total_reserve_in_usd?: string | number;
  volume_usd?: { m5?: string | number; h1?: string | number; h6?: string | number; h24?: string | number };
  market_cap_usd?: string | number;
  fdv_usd?: string | number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toPositiveNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000);
}

async function geckoGet(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'goose-token-autopilot/1.0' },
    });
    if (!res.ok) return { ok: false, status: res.status, body: null };
    const body = await res.json();
    return { ok: true, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface SnapshotFetchResult {
  snapshot?: TokenGrabAutopsySnapshot;
  skipped: boolean;
  reason?: string;
}

export interface FetchSessionSnapshotsOptions {
  candidates: TokenGrabAutopsyCandidate[];
  nowIso?: string;
  startAt?: number;
  limit?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface FetchSessionSnapshotsResult {
  snapshots: TokenGrabAutopsySnapshot[];
  skipped: number;
  skipReasons: Array<{ candidateId: string; ticker: string; reason: string }>;
}

// ── Per-candidate fetch ───────────────────────────────────────────────────────

/**
 * Fetches a single price/liquidity snapshot for one candidate.
 * Prefers poolAddress (pool-level precision) over contractAddress (token aggregate).
 * Never throws — returns skipped: true on any error.
 * No DB writes, no scheduling, report-only.
 */
export async function fetchCandidateSnapshot(
  candidate: TokenGrabAutopsyCandidate,
  options: {
    nowIso?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<SnapshotFetchResult> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!candidate.poolAddress && !candidate.contractAddress) {
    return { skipped: true, reason: 'no poolAddress or contractAddress available' };
  }

  const minutesAfterDetection = minutesBetween(candidate.detectedAt, nowIso);

  if (candidate.poolAddress) {
    return fetchByPool(candidate, candidate.poolAddress, nowIso, minutesAfterDetection, fetchImpl, timeoutMs);
  }
  return fetchByToken(candidate, candidate.contractAddress!, nowIso, minutesAfterDetection, fetchImpl, timeoutMs);
}

async function fetchByPool(
  candidate: TokenGrabAutopsyCandidate,
  poolAddress: string,
  nowIso: string,
  minutesAfterDetection: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SnapshotFetchResult> {
  const url = `${GECKO_BASE}/networks/solana/pools/${poolAddress}`;
  let result: { ok: boolean; status: number; body: unknown };
  try {
    result = await geckoGet(url, fetchImpl, timeoutMs);
  } catch (e) {
    return { skipped: true, reason: `fetch error: ${(e as Error).message}` };
  }

  if (!result.ok) {
    if (result.status === 404) return { skipped: true, reason: `pool not found (404): ${poolAddress}` };
    if (result.status === 429) return { skipped: true, reason: 'rate limited (429)' };
    return { skipped: true, reason: `HTTP ${result.status}` };
  }

  const attrs = (result.body as { data?: { attributes?: GeckoPoolAttrs } })?.data?.attributes;
  return {
    skipped: false,
    snapshot: {
      candidateId: candidate.id,
      observedAt: nowIso,
      minutesAfterDetection,
      priceUsd: toPositiveNumber(attrs?.price_in_usd ?? attrs?.base_token_price_usd),
      liquidityUsd: toPositiveNumber(attrs?.reserve_in_usd),
      volumeUsd: toPositiveNumber(attrs?.volume_usd?.h1 ?? attrs?.volume_usd?.m5),
      marketCapUsd: toPositiveNumber(attrs?.market_cap_usd ?? attrs?.fdv_usd),
      source: 'geckoterminal',
    },
  };
}

async function fetchByToken(
  candidate: TokenGrabAutopsyCandidate,
  contractAddress: string,
  nowIso: string,
  minutesAfterDetection: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SnapshotFetchResult> {
  const url = `${GECKO_BASE}/networks/solana/tokens/${contractAddress}`;
  let result: { ok: boolean; status: number; body: unknown };
  try {
    result = await geckoGet(url, fetchImpl, timeoutMs);
  } catch (e) {
    return { skipped: true, reason: `fetch error: ${(e as Error).message}` };
  }

  if (!result.ok) {
    if (result.status === 404) return { skipped: true, reason: `token not found (404): ${contractAddress}` };
    if (result.status === 429) return { skipped: true, reason: 'rate limited (429)' };
    return { skipped: true, reason: `HTTP ${result.status}` };
  }

  const attrs = (result.body as { data?: { attributes?: GeckoTokenAttrs } })?.data?.attributes;
  return {
    skipped: false,
    snapshot: {
      candidateId: candidate.id,
      observedAt: nowIso,
      minutesAfterDetection,
      priceUsd: toPositiveNumber(attrs?.price_usd),
      liquidityUsd: toPositiveNumber(attrs?.total_reserve_in_usd),
      volumeUsd: toPositiveNumber(attrs?.volume_usd?.h1 ?? attrs?.volume_usd?.m5),
      marketCapUsd: toPositiveNumber(attrs?.market_cap_usd ?? attrs?.fdv_usd),
      source: 'geckoterminal',
    },
  };
}

// ── Helpers ── (batch) ────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Batch fetch ───────────────────────────────────────────────────────────────

/**
 * Fetches snapshots for candidates in a session, starting at startAt, up to limit.
 * Sleeps delayMs between requests (not after the last) to avoid rate limits.
 * A failed lookup for one candidate does not fail the rest.
 * No DB writes, no scheduling, report-only.
 */
export async function fetchSessionSnapshots(
  options: FetchSessionSnapshotsOptions,
): Promise<FetchSessionSnapshotsResult> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const startAt = options.startAt ?? 0;
  const delayMs = options.delayMs ?? 0;
  const sleepImpl = options.sleepImpl ?? sleep;

  const afterStart = options.candidates.slice(startAt);
  const candidates = options.limit != null
    ? afterStart.slice(0, options.limit)
    : afterStart;

  const snapshots: TokenGrabAutopsySnapshot[] = [];
  const skipReasons: Array<{ candidateId: string; ticker: string; reason: string }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const result = await fetchCandidateSnapshot(candidate, {
      nowIso,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });

    if (result.snapshot) {
      snapshots.push(result.snapshot);
    } else {
      skipReasons.push({
        candidateId: candidate.id,
        ticker: candidate.ticker,
        reason: result.reason ?? 'unknown',
      });
    }

    if (delayMs > 0 && i < candidates.length - 1) {
      await sleepImpl(delayMs);
    }
  }

  return { snapshots, skipped: skipReasons.length, skipReasons };
}

// ── File I/O ──────────────────────────────────────────────────────────────────

export function writeSnapshotFile(filePath: string, snapshots: TokenGrabAutopsySnapshot[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(snapshots, null, 2), 'utf-8');
}
