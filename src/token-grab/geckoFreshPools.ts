import type { FreshPool } from './types';

// ── Raw GeckoTerminal shapes (inline — keeps token-grab self-contained) ────────

interface GeckoPoolAttributes {
  address?: string;
  name?: string;
  pool_created_at?: string;
  reserve_in_usd?: string | number;
  volume_usd?: { m5?: string | number };
}

interface GeckoPoolRelRef {
  data?: { id?: string };
}

interface GeckoPoolRaw {
  attributes?: GeckoPoolAttributes;
  relationships?: {
    base_token?: GeckoPoolRelRef;
    quote_token?: GeckoPoolRelRef;
  };
}

interface GeckoPoolsResponse {
  data?: GeckoPoolRaw[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';
const DEFAULT_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 10_000;

// Tickers that are quote/stable tokens and should NOT be picked as the candidate.
const STABLE_TICKERS = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'WBTC', 'ETH']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseMint(relationshipId: string | undefined): string | undefined {
  if (!relationshipId) return undefined;
  return relationshipId.startsWith('solana_')
    ? relationshipId.slice('solana_'.length)
    : undefined;
}

// Pool name is typically "TICKER/SOL" or "TICKER/USDC".
// Return the left side (base token ticker), uppercased and truncated.
function parseBaseTicker(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const [left] = name.split('/');
  const ticker = left?.trim().toUpperCase().slice(0, 20);
  return ticker || undefined;
}

// ── Public exports ────────────────────────────────────────────────────────────

/**
 * Maps a single raw GeckoTerminal pool record to a FreshPool.
 * Returns undefined if the record is missing essential fields (pool address or
 * base token mint). Does not throw.
 *
 * Token selection: uses base_token relationship (left side of pair name).
 * Metadata (website/x/telegram) is not available from the new_pools endpoint
 * and is omitted in V1.
 */
export function mapGeckoPoolToFreshPool(
  pool: GeckoPoolRaw,
  nowIso?: string,
): FreshPool | undefined {
  const poolAddress = pool.attributes?.address?.trim();
  if (!poolAddress) return undefined;

  const baseMint = parseMint(pool.relationships?.base_token?.data?.id);
  if (!baseMint) return undefined;

  const ticker = parseBaseTicker(pool.attributes?.name);
  if (!ticker || STABLE_TICKERS.has(ticker)) return undefined;

  const createdAt = pool.attributes?.pool_created_at ?? nowIso ?? new Date().toISOString();

  return {
    id: poolAddress,
    chain: 'solana',
    tokenName: ticker,
    ticker,
    contractAddress: baseMint,
    poolAddress,
    createdAt,
    liquidityUsd: toNumber(pool.attributes?.reserve_in_usd),
    volume5mUsd: toNumber(pool.attributes?.volume_usd?.m5),
    source: 'geckoterminal',
  };
}

/**
 * Deduplicates FreshPool[] by contractAddress (primary) then poolAddress
 * (secondary). First occurrence wins.
 */
export function dedupeFreshPools(pools: FreshPool[]): FreshPool[] {
  const seenContracts = new Set<string>();
  const seenPools = new Set<string>();
  const out: FreshPool[] = [];
  for (const p of pools) {
    if (seenContracts.has(p.contractAddress)) continue;
    if (p.poolAddress && seenPools.has(p.poolAddress)) continue;
    seenContracts.add(p.contractAddress);
    if (p.poolAddress) seenPools.add(p.poolAddress);
    out.push(p);
  }
  return out;
}

export interface FetchGeckoFreshPoolsOptions {
  url?: string;
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches fresh Solana pools from GeckoTerminal new_pools endpoint.
 * Always returns FreshPool[]. Never throws — returns [] on any error and
 * logs a warning to stderr.
 *
 * Safety: one GET request, no DB writes, no scheduling, no retries.
 */
export async function fetchGeckoFreshPools(
  options: FetchGeckoFreshPoolsOptions = {},
): Promise<FreshPool[]> {
  const url = options.url ?? DEFAULT_URL;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'goose-token-autopilot/1.0',
      },
    });

    if (res.status === 429) {
      console.error('[gecko-fresh-pools] Rate limited by GeckoTerminal (429). Returning empty list.');
      return [];
    }
    if (!res.ok) {
      console.error(`[gecko-fresh-pools] HTTP ${res.status} from GeckoTerminal. Returning empty list.`);
      return [];
    }

    const nowIso = new Date().toISOString();
    const body = (await res.json()) as GeckoPoolsResponse;
    const rawPools = Array.isArray(body?.data) ? body.data : [];

    const pools: FreshPool[] = [];
    for (const raw of rawPools) {
      const pool = mapGeckoPoolToFreshPool(raw, nowIso);
      if (pool) pools.push(pool);
      if (pools.length >= limit) break;
    }
    return pools;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[gecko-fresh-pools] Fetch failed: ${msg}. Returning empty list.`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
