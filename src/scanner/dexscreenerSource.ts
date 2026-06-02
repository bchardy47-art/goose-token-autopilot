import type { TokenCandidate } from '../types';
import type { TokenSource } from './source';

type FetchImpl = typeof fetch;

interface DexScreenerProfile {
  url?: string;
  chainId?: string;
  tokenAddress?: string;
  updatedAt?: string;
  description?: string;
  links?: Array<{ label?: string; type?: string; url?: string }>;
}

interface DexScreenerPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  pairCreatedAt?: number;
  priceUsd?: string | number;
  marketCap?: number;
  fdv?: number;
  txns?: {
    m5?: { buys?: number; sells?: number };
  };
  volume?: {
    m5?: number;
    h1?: number;
    h24?: number;
  };
  priceChange?: {
    m5?: number;
    h1?: number;
    h24?: number;
  };
  liquidity?: {
    usd?: number;
  };
  info?: {
    websites?: Array<{ url?: string; label?: string }>;
    socials?: Array<{ url?: string; type?: string }>;
    imageUrl?: string;
    header?: string;
    openGraph?: string;
  };
  baseToken?: {
    address?: string;
    symbol?: string;
    name?: string;
  };
  quoteToken?: {
    address?: string;
    symbol?: string;
    name?: string;
  };
}

interface DexScreenerTokenResponse {
  pairs?: DexScreenerPair[];
}

interface DexScreenerSourceOptions {
  fetchImpl?: FetchImpl;
  profilesUrl?: string;
  tokensBaseUrl?: string;
  maxTokens?: number;
  batchSize?: number;
}

const DEFAULT_PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
const DEFAULT_TOKENS_BASE_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const DEFAULT_MAX_TOKENS = 25;
const DEFAULT_BATCH_SIZE = 20;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function pickBestPair(pairs: DexScreenerPair[]): DexScreenerPair | null {
  if (pairs.length === 0) return null;
  return [...pairs].sort((left, right) => {
    const leftLiquidity = toNumber(left.liquidity?.usd) ?? -1;
    const rightLiquidity = toNumber(right.liquidity?.usd) ?? -1;
    if (rightLiquidity !== leftLiquidity) return rightLiquidity - leftLiquidity;

    const leftVolume = toNumber(left.volume?.h24) ?? -1;
    const rightVolume = toNumber(right.volume?.h24) ?? -1;
    if (rightVolume !== leftVolume) return rightVolume - leftVolume;

    const leftCreated = toNumber(left.pairCreatedAt) ?? -1;
    const rightCreated = toNumber(right.pairCreatedAt) ?? -1;
    return rightCreated - leftCreated;
  })[0] ?? null;
}

function deriveWebsitePresent(profile: DexScreenerProfile, pair: DexScreenerPair | null): boolean {
  const infoWebsite = pair?.info?.websites?.some((website) => Boolean(website.url));
  const profileWebsite = profile.links?.some((link) => Boolean(link.url) && (link.label?.toLowerCase() === 'website' || link.type?.toLowerCase() === 'website'));
  return Boolean(infoWebsite || profileWebsite);
}

function deriveSocialsPresent(profile: DexScreenerProfile, pair: DexScreenerPair | null): boolean {
  const infoSocial = pair?.info?.socials?.some((social) => Boolean(social.url));
  const profileSocial = profile.links?.some((link) => Boolean(link.url) && link.label?.toLowerCase() !== 'website');
  return Boolean(infoSocial || profileSocial);
}

function deriveMetadataPresent(pair: DexScreenerPair | null): boolean {
  return Boolean(pair?.baseToken?.address && pair.baseToken.symbol && pair.baseToken.name);
}

function deriveMovedBeforeDiscoveryPct(pair: DexScreenerPair | null): number {
  const values = [
    toNumber(pair?.priceChange?.m5),
    toNumber(pair?.priceChange?.h1),
    toNumber(pair?.priceChange?.h24)
  ].filter((value): value is number => value !== null && value > 0);
  return values.length > 0 ? Math.max(...values) : 0;
}

function normalizeFallbackSymbol(address: string): string {
  return `UNK-${address.slice(0, 4)}`;
}

export function normalizeDexScreenerCandidate(profile: DexScreenerProfile, pairsForToken: DexScreenerPair[], observedAt = new Date().toISOString()): TokenCandidate | null {
  if (profile.chainId !== 'solana' || !profile.tokenAddress) {
    return null;
  }

  const pair = pickBestPair(pairsForToken.filter((item) => item.chainId === 'solana' && item.baseToken?.address === profile.tokenAddress));
  const tokenCreatedAt = toIsoDate(pair?.pairCreatedAt) ?? toIsoDate(profile.updatedAt) ?? observedAt;
  const dataUpdatedAt = toIsoDate(profile.updatedAt) ?? observedAt;

  return {
    chain: 'solana',
    mint: profile.tokenAddress,
    symbol: pair?.baseToken?.symbol ?? normalizeFallbackSymbol(profile.tokenAddress),
    name: pair?.baseToken?.name ?? `Unknown ${profile.tokenAddress.slice(0, 8)}`,
    source: 'dexscreener',
    sourceUrl: pair?.url ?? profile.url ?? null,
    discoveredAt: observedAt,
    tokenCreatedAt,
    priceUsd: toNumber(pair?.priceUsd),
    liquidityUsd: toNumber(pair?.liquidity?.usd),
    marketCapUsd: toNumber(pair?.marketCap) ?? toNumber(pair?.fdv),
    volume5mUsd: toNumber(pair?.volume?.m5),
    volume1hUsd: toNumber(pair?.volume?.h1),
    volume24hUsd: toNumber(pair?.volume?.h24),
    priceChange5mPct: toNumber(pair?.priceChange?.m5),
    priceChange1hPct: toNumber(pair?.priceChange?.h1),
    buys5m: toNumber(pair?.txns?.m5?.buys),
    sells5m: toNumber(pair?.txns?.m5?.sells),
    liquidityGrowthPct: null,
    freezeAuthority: 'UNKNOWN',
    mintAuthority: 'UNKNOWN',
    sellQuoteAvailable: 'UNKNOWN',
    estimatedSlippageBps: null,
    metadataPresent: deriveMetadataPresent(pair),
    websitePresent: deriveWebsitePresent(profile, pair),
    socialsPresent: deriveSocialsPresent(profile, pair),
    holderConcentration: 'UNKNOWN',
    creatorStatus: 'UNKNOWN',
    movedBeforeDiscoveryPct: deriveMovedBeforeDiscoveryPct(pair),
    dataUpdatedAt,
    raw: {
      profile,
      pairCount: pairsForToken.length,
      selectedPair: pair
        ? {
            pairAddress: pair.pairAddress,
            dexId: pair.dexId,
            quoteToken: pair.quoteToken,
            liquidityUsd: pair.liquidity?.usd ?? null,
            pairCreatedAt: pair.pairCreatedAt ?? null
          }
        : null
    }
  };
}

export class DexScreenerTokenSource implements TokenSource {
  readonly name = 'dexscreener';

  private readonly fetchImpl: FetchImpl;
  private readonly profilesUrl: string;
  private readonly tokensBaseUrl: string;
  private readonly maxTokens: number;
  private readonly batchSize: number;

  constructor(options: DexScreenerSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.profilesUrl = options.profilesUrl ?? DEFAULT_PROFILES_URL;
    this.tokensBaseUrl = options.tokensBaseUrl ?? DEFAULT_TOKENS_BASE_URL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async fetchCandidates(): Promise<TokenCandidate[]> {
    try {
      const observedAt = new Date().toISOString();
      const profiles = await this.fetchProfiles();
      const solanaProfiles = [...new Map(
        profiles
          .filter((profile) => profile.chainId === 'solana' && profile.tokenAddress)
          .slice(0, this.maxTokens)
          .map((profile) => [profile.tokenAddress as string, profile])
      ).values()];

      if (solanaProfiles.length === 0) {
        return [];
      }

      const pairMap = await this.fetchPairsForTokens(solanaProfiles.map((profile) => profile.tokenAddress as string));
      const candidates = solanaProfiles
        .map((profile) => normalizeDexScreenerCandidate(profile, pairMap.get(profile.tokenAddress as string) ?? [], observedAt))
        .filter((candidate): candidate is TokenCandidate => candidate !== null);

      return candidates;
    } catch {
      return [];
    }
  }

  async fetchCandidatesByTokenAddresses(tokenAddresses: string[], observedAt = new Date().toISOString()): Promise<TokenCandidate[]> {
    try {
      const unique = [...new Set(tokenAddresses.filter(Boolean))];
      if (unique.length === 0) return [];
      const pairMap = await this.fetchPairsForTokens(unique);
      return unique
        .map((tokenAddress) => normalizeDexScreenerCandidate({ chainId: 'solana', tokenAddress, updatedAt: observedAt }, pairMap.get(tokenAddress) ?? [], observedAt))
        .filter((candidate): candidate is TokenCandidate => candidate !== null);
    } catch {
      return [];
    }
  }

  private async fetchProfiles(): Promise<DexScreenerProfile[]> {
    try {
      const response = await this.fetchImpl(this.profilesUrl, {
        headers: {
          accept: 'application/json',
          'user-agent': 'goose-token-autopilot/1.0'
        }
      });

      if (response.status === 429 || !response.ok) {
        return [];
      }

      const data = await response.json();
      return Array.isArray(data) ? (data as DexScreenerProfile[]) : [];
    } catch {
      return [];
    }
  }

  private async fetchPairsForTokens(tokenAddresses: string[]): Promise<Map<string, DexScreenerPair[]>> {
    const pairsByToken = new Map<string, DexScreenerPair[]>();

    for (const batch of chunk(tokenAddresses, this.batchSize)) {
      try {
        const response = await this.fetchImpl(`${this.tokensBaseUrl}/${batch.join(',')}`, {
          headers: {
            accept: 'application/json',
            'user-agent': 'goose-token-autopilot/1.0'
          }
        });

        if (response.status === 429 || !response.ok) {
          continue;
        }

        const data = (await response.json()) as DexScreenerTokenResponse;
        const pairs = Array.isArray(data?.pairs) ? data.pairs : [];

        for (const pair of pairs) {
          const address = pair.baseToken?.address;
          if (!address) continue;
          const current = pairsByToken.get(address) ?? [];
          current.push(pair);
          pairsByToken.set(address, current);
        }
      } catch {
        continue;
      }
    }

    return pairsByToken;
  }
}
