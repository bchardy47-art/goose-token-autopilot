import type { AppConfig, TokenCandidate } from '../types';
import type { TokenSource } from './source';

type FetchImpl = typeof fetch;

interface GeckoTerminalPoolRelationshipRef {
  data?: { id?: string; type?: string };
}

interface GeckoTerminalPool {
  id?: string;
  type?: string;
  attributes?: {
    address?: string;
    name?: string;
    pool_created_at?: string;
    reserve_in_usd?: string | number;
    fdv_usd?: string | number;
    market_cap_usd?: string | number | null;
    price_change_percentage?: {
      m5?: string | number;
      h1?: string | number;
      h24?: string | number;
    };
    transactions?: {
      m5?: { buys?: number; sells?: number };
      h1?: { buys?: number; sells?: number };
      h24?: { buys?: number; sells?: number };
    };
    volume_usd?: {
      m5?: string | number;
      h1?: string | number;
      h24?: string | number;
    };
    base_token_price_usd?: string | number;
    quote_token_price_usd?: string | number;
  };
  relationships?: {
    base_token?: GeckoTerminalPoolRelationshipRef;
    quote_token?: GeckoTerminalPoolRelationshipRef;
    dex?: GeckoTerminalPoolRelationshipRef;
  };
}

interface GeckoTerminalPoolsResponse {
  data?: GeckoTerminalPool[];
}

interface GeckoTerminalPoolResponse {
  data?: GeckoTerminalPool;
}

interface GeckoTerminalSourceOptions {
  fetchImpl?: FetchImpl;
  newPoolsUrl?: string;
  maxPoolAgeMinutes?: number;
  maxDataAgeMinutes?: number;
  minReserveUsd?: number;
  limit?: number;
}

export interface GeckoTerminalPoolRefreshResult {
  refreshed: TokenCandidate[];
  summary: GeckoTerminalRefreshSummary;
}

interface GeckoTerminalRefreshSummary {
  geckoRefreshAttempted: number;
  geckoRefreshSucceeded: number;
  geckoRefreshMissingPoolAddress: number;
  geckoRefreshFailed: number;
  geckoRefreshSkippedOld: number;
}

interface GeckoTerminalFetchSummary {
  poolsFetched: number;
  solanaPoolsConsidered: number;
  candidatesAccepted: number;
  missingMintRejectedCount: number;
  missingPoolRejectedCount: number;
  staleRejectedCount: number;
  lowLiquidityRejectedCount: number;
  limitedOutCount: number;
  newestPoolAgeMinutes: number | null;
  oldestPoolAgeMinutes: number | null;
  medianPoolAgeMinutes: number | null;
}

const DEFAULT_NEW_POOLS_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';
const DEFAULT_MAX_POOL_AGE_MINUTES = 60;
const DEFAULT_MAX_DATA_AGE_MINUTES = 30;
const DEFAULT_MIN_RESERVE_USD = 20000;
const DEFAULT_LIMIT = 20;
const MS_PER_MINUTE = 60_000;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesSince(timestamp: string, observedAt: string): number | null {
  const timestampMs = new Date(timestamp).getTime();
  const observedMs = new Date(observedAt).getTime();
  if (Number.isNaN(timestampMs) || Number.isNaN(observedMs)) return null;
  return Math.max(0, (observedMs - timestampMs) / MS_PER_MINUTE);
}

function median(numbers: number[]): number | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  return left != null && right != null ? (left + right) / 2 : null;
}

function parseMintFromRelationshipId(value: string | undefined): string | null {
  if (!value) return null;
  return value.startsWith('solana_') ? value.slice('solana_'.length) : null;
}

function fallbackSymbol(mint: string): string {
  return `UNK-${mint.slice(0, 4)}`;
}

function parseNameParts(name: string | undefined): { symbol: string | null; name: string | null } {
  if (!name || !name.trim()) return { symbol: null, name: null };
  const [left] = name.split('/').map((part) => part.trim());
  if (!left) return { symbol: null, name: null };
  return { symbol: left.toUpperCase().slice(0, 12), name: left };
}

function deriveMovedBeforeDiscoveryPct(pool: GeckoTerminalPool): number {
  const values = [
    toNumber(pool.attributes?.price_change_percentage?.m5),
    toNumber(pool.attributes?.price_change_percentage?.h1),
    toNumber(pool.attributes?.price_change_percentage?.h24)
  ].filter((value): value is number => value !== null && value > 0);
  return values.length > 0 ? Math.max(...values) : 0;
}

function pickFirstNumber(...values: Array<unknown>): number | null {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function normalizeGeckoTerminalPool(pool: GeckoTerminalPool, observedAt = new Date().toISOString()): TokenCandidate | null {
  const baseMint = parseMintFromRelationshipId(pool.relationships?.base_token?.data?.id);
  const poolAddress = pool.attributes?.address ?? null;
  const poolCreatedAt = pool.attributes?.pool_created_at ?? observedAt;
  if (!baseMint || !poolAddress) return null;

  const parsedName = parseNameParts(pool.attributes?.name);
  return {
    chain: 'solana',
    mint: baseMint,
    symbol: parsedName.symbol ?? fallbackSymbol(baseMint),
    name: parsedName.name ?? `Unknown ${baseMint.slice(0, 8)}`,
    source: 'geckoterminal',
    sourceUrl: `https://www.geckoterminal.com/solana/pools/${poolAddress}`,
    discoveredAt: observedAt,
    tokenCreatedAt: poolCreatedAt,
    priceUsd: toNumber(pool.attributes?.base_token_price_usd),
    liquidityUsd: toNumber(pool.attributes?.reserve_in_usd),
    marketCapUsd: toNumber(pool.attributes?.market_cap_usd) ?? toNumber(pool.attributes?.fdv_usd),
    volume5mUsd: pickFirstNumber(pool.attributes?.volume_usd?.m5, pool.attributes?.volume_usd?.m15, pool.attributes?.volume_usd?.m30),
    volume1hUsd: pickFirstNumber(pool.attributes?.volume_usd?.h1, pool.attributes?.volume_usd?.m30),
    volume24hUsd: pickFirstNumber(pool.attributes?.volume_usd?.h24, pool.attributes?.volume_usd?.h6, pool.attributes?.volume_usd?.h1),
    priceChange5mPct: pickFirstNumber(pool.attributes?.price_change_percentage?.m5, pool.attributes?.price_change_percentage?.m15, pool.attributes?.price_change_percentage?.m30),
    priceChange1hPct: pickFirstNumber(pool.attributes?.price_change_percentage?.h1, pool.attributes?.price_change_percentage?.m30),
    buys5m: pool.attributes?.transactions?.m5?.buys ?? pool.attributes?.transactions?.m15?.buys ?? pool.attributes?.transactions?.m30?.buys ?? null,
    sells5m: pool.attributes?.transactions?.m5?.sells ?? pool.attributes?.transactions?.m15?.sells ?? pool.attributes?.transactions?.m30?.sells ?? null,
    liquidityGrowthPct: null,
    freezeAuthority: 'UNKNOWN',
    mintAuthority: 'UNKNOWN',
    sellQuoteAvailable: 'UNKNOWN',
    estimatedSlippageBps: null,
    metadataPresent: true,
    websitePresent: false,
    socialsPresent: false,
    holderConcentration: 'UNKNOWN',
    creatorStatus: 'UNKNOWN',
    movedBeforeDiscoveryPct: deriveMovedBeforeDiscoveryPct(pool),
    dataUpdatedAt: observedAt,
    raw: {
      geckoTerminalPoolId: pool.id ?? null,
      discoveryLane: 'geckoterminal-new-pools',
      selectedPair: {
        pairAddress: poolAddress,
        dexId: pool.relationships?.dex?.data?.id ?? null,
        pairCreatedAt: poolCreatedAt,
        liquidityUsd: toNumber(pool.attributes?.reserve_in_usd),
        volume5mUsd: pickFirstNumber(pool.attributes?.volume_usd?.m5, pool.attributes?.volume_usd?.m15, pool.attributes?.volume_usd?.m30),
        volume1hUsd: pickFirstNumber(pool.attributes?.volume_usd?.h1, pool.attributes?.volume_usd?.m30),
        volume24hUsd: pickFirstNumber(pool.attributes?.volume_usd?.h24, pool.attributes?.volume_usd?.h6, pool.attributes?.volume_usd?.h1),
        priceChange5mPct: pickFirstNumber(pool.attributes?.price_change_percentage?.m5, pool.attributes?.price_change_percentage?.m15, pool.attributes?.price_change_percentage?.m30),
        priceChange1hPct: pickFirstNumber(pool.attributes?.price_change_percentage?.h1, pool.attributes?.price_change_percentage?.m30),
        priceChange24hPct: pickFirstNumber(pool.attributes?.price_change_percentage?.h24, pool.attributes?.price_change_percentage?.h6, pool.attributes?.price_change_percentage?.h1)
      },
      discovery: {
        discoveryLane: 'geckoterminal-new-pools',
        pairCreatedAt: poolCreatedAt,
        pairAgeMinutes: minutesSince(poolCreatedAt, observedAt),
        dataAgeMinutes: 0,
        movedBeforeDiscoveryPct: deriveMovedBeforeDiscoveryPct(pool)
      }
    }
  };
}

function extractPoolAddress(candidate: TokenCandidate): string | null {
  const selectedPair = (candidate.raw?.selectedPair as Record<string, unknown> | undefined)
    ?? ((candidate.raw as any)?.selectedPair as Record<string, unknown> | undefined);
  return typeof selectedPair?.pairAddress === 'string' ? selectedPair.pairAddress : null;
}

export class GeckoTerminalTokenSource implements TokenSource {
  readonly name = 'geckoterminal';

  private readonly fetchImpl: FetchImpl;
  private readonly newPoolsUrl: string;
  private readonly poolsBaseUrl: string;
  private readonly maxPoolAgeMinutes: number;
  private readonly maxDataAgeMinutes: number;
  private readonly minReserveUsd: number;
  private readonly limit: number;
  private lastFetchSummary: GeckoTerminalFetchSummary | null = null;

  constructor(options: GeckoTerminalSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.newPoolsUrl = options.newPoolsUrl ?? DEFAULT_NEW_POOLS_URL;
    this.poolsBaseUrl = this.newPoolsUrl.replace(/\/new_pools$/, '/pools');
    this.maxPoolAgeMinutes = options.maxPoolAgeMinutes ?? DEFAULT_MAX_POOL_AGE_MINUTES;
    this.maxDataAgeMinutes = options.maxDataAgeMinutes ?? DEFAULT_MAX_DATA_AGE_MINUTES;
    this.minReserveUsd = options.minReserveUsd ?? DEFAULT_MIN_RESERVE_USD;
    this.limit = options.limit ?? DEFAULT_LIMIT;
  }

  getLastFetchSummary(): Record<string, unknown> | null {
    return this.lastFetchSummary;
  }

  async fetchCandidates(): Promise<TokenCandidate[]> {
    try {
      const observedAt = new Date().toISOString();
      const response = await this.fetchImpl(this.newPoolsUrl, {
        headers: {
          accept: 'application/json',
          'user-agent': 'goose-token-autopilot/1.0'
        }
      });
      if (response.status === 429 || !response.ok) {
        this.lastFetchSummary = null;
        return [];
      }

      const body = (await response.json()) as GeckoTerminalPoolsResponse;
      const pools = Array.isArray(body?.data) ? body.data : [];
      const candidates: TokenCandidate[] = [];
      const acceptedPoolAges: number[] = [];
      let missingMintRejectedCount = 0;
      let missingPoolRejectedCount = 0;
      let staleRejectedCount = 0;
      let lowLiquidityRejectedCount = 0;

      for (const pool of pools) {
        const mint = parseMintFromRelationshipId(pool.relationships?.base_token?.data?.id);
        if (!mint) {
          missingMintRejectedCount += 1;
          continue;
        }
        if (!pool.attributes?.address) {
          missingPoolRejectedCount += 1;
          continue;
        }
        const candidate = normalizeGeckoTerminalPool(pool, observedAt);
        if (!candidate) {
          missingMintRejectedCount += 1;
          continue;
        }
        const pairAgeMinutes = minutesSince(candidate.tokenCreatedAt, observedAt);
        const dataAgeMinutes = minutesSince(candidate.dataUpdatedAt, observedAt) ?? 0;
        if ((pairAgeMinutes ?? Number.POSITIVE_INFINITY) > this.maxPoolAgeMinutes || dataAgeMinutes > this.maxDataAgeMinutes) {
          staleRejectedCount += 1;
          continue;
        }
        if ((candidate.liquidityUsd ?? 0) < this.minReserveUsd) {
          lowLiquidityRejectedCount += 1;
          continue;
        }
        candidates.push(candidate);
        if (pairAgeMinutes != null) acceptedPoolAges.push(pairAgeMinutes);
      }

      const limited = candidates.slice(0, this.limit);
      this.lastFetchSummary = {
        poolsFetched: pools.length,
        solanaPoolsConsidered: pools.length,
        candidatesAccepted: limited.length,
        missingMintRejectedCount,
        missingPoolRejectedCount,
        staleRejectedCount,
        lowLiquidityRejectedCount,
        limitedOutCount: Math.max(0, candidates.length - limited.length),
        newestPoolAgeMinutes: acceptedPoolAges.length > 0 ? Math.min(...acceptedPoolAges) : null,
        oldestPoolAgeMinutes: acceptedPoolAges.length > 0 ? Math.max(...acceptedPoolAges) : null,
        medianPoolAgeMinutes: median(acceptedPoolAges)
      };
      return limited;
    } catch {
      this.lastFetchSummary = null;
      return [];
    }
  }

  async refreshCandidatesByPoolAddresses(candidates: TokenCandidate[], maxCandidateAgeMinutes = 60, maxCount = 20): Promise<GeckoTerminalPoolRefreshResult> {
    const observedAt = new Date().toISOString();
    const summary: GeckoTerminalRefreshSummary = {
      geckoRefreshAttempted: 0,
      geckoRefreshSucceeded: 0,
      geckoRefreshMissingPoolAddress: 0,
      geckoRefreshFailed: 0,
      geckoRefreshSkippedOld: 0
    };
    const refreshed: TokenCandidate[] = [];

    for (const candidate of candidates) {
      if (refreshed.length >= maxCount) break;
      const ageMinutes = minutesSince(candidate.tokenCreatedAt, observedAt);
      if ((ageMinutes ?? Number.POSITIVE_INFINITY) > maxCandidateAgeMinutes) {
        summary.geckoRefreshSkippedOld += 1;
        continue;
      }
      const poolAddress = extractPoolAddress(candidate);
      if (!poolAddress) {
        summary.geckoRefreshMissingPoolAddress += 1;
        continue;
      }

      summary.geckoRefreshAttempted += 1;
      try {
        const response = await this.fetchImpl(`${this.poolsBaseUrl}/${poolAddress}`, {
          headers: {
            accept: 'application/json',
            'user-agent': 'goose-token-autopilot/1.0'
          }
        });
        if (response.status === 429 || !response.ok) {
          summary.geckoRefreshFailed += 1;
          continue;
        }
        const body = (await response.json()) as GeckoTerminalPoolResponse;
        if (!body?.data) {
          summary.geckoRefreshFailed += 1;
          continue;
        }
        const refreshedCandidate = normalizeGeckoTerminalPool(body.data, observedAt);
        if (!refreshedCandidate) {
          summary.geckoRefreshFailed += 1;
          continue;
        }
        refreshed.push({
          ...refreshedCandidate,
          mint: candidate.mint,
          source: candidate.source,
          sourceUrl: candidate.sourceUrl ?? refreshedCandidate.sourceUrl
        });
        summary.geckoRefreshSucceeded += 1;
      } catch {
        summary.geckoRefreshFailed += 1;
      }
    }

    return { refreshed, summary };
  }
}

export function createGeckoTerminalSourceFromConfig(config: AppConfig, options: Omit<GeckoTerminalSourceOptions, 'newPoolsUrl' | 'maxPoolAgeMinutes' | 'maxDataAgeMinutes' | 'minReserveUsd' | 'limit'> = {}): GeckoTerminalTokenSource {
  return new GeckoTerminalTokenSource({
    ...options,
    newPoolsUrl: config.geckoTerminalNewPoolsUrl,
    maxPoolAgeMinutes: config.geckoTerminalMaxPoolAgeMinutes,
    maxDataAgeMinutes: config.geckoTerminalMaxDataAgeMinutes,
    minReserveUsd: config.geckoTerminalMinReserveUsd,
    limit: config.geckoTerminalLimit
  });
}
