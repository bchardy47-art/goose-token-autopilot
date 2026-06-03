import type { AppConfig, TokenCandidate } from '../types';
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
  recentUpdatesUrl?: string;
  includeRecentUpdates?: boolean;
  tokensBaseUrl?: string;
  maxTokens?: number;
  batchSize?: number;
  maxPairAgeMinutes?: number;
  maxDataAgeMinutes?: number;
  maxMovedBeforeDiscoveryPct?: number;
  freshDiscoveryLimit?: number;
}

interface DexScreenerFetchSummary {
  profilesFetched: number;
  latestProfilesFetched: number;
  recentProfilesFetched: number;
  profilesAfterDedupe: number;
  duplicateProfilesRemoved: number;
  recentUpdatesEnabled: boolean;
  solanaProfilesConsidered: number;
  candidatesAccepted: number;
  freshAcceptedCount: number;
  staleRejectedCount: number;
  alreadyMovedRejectedCount: number;
  missingPairRejectedCount: number;
  limitedOutCount: number;
}

const DEFAULT_PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
const DEFAULT_RECENT_UPDATES_URL = 'https://api.dexscreener.com/token-profiles/recent-updates/v1';
const DEFAULT_TOKENS_BASE_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const DEFAULT_MAX_TOKENS = 25;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_PAIR_AGE_MINUTES = 180;
const DEFAULT_MAX_DATA_AGE_MINUTES = 60;
const DEFAULT_MAX_MOVED_BEFORE_DISCOVERY_PCT = 150;
const DEFAULT_INCLUDE_RECENT_UPDATES = true;
const MS_PER_MINUTE = 60_000;

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

function ageMinutesFromIso(value: string | null, observedAt: string): number | null {
  if (!value) return null;
  const observedMs = new Date(observedAt).getTime();
  const valueMs = new Date(value).getTime();
  if (Number.isNaN(observedMs) || Number.isNaN(valueMs)) return null;
  return Math.max(0, (observedMs - valueMs) / MS_PER_MINUTE);
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function sortProfilesByFreshness(left: DexScreenerProfile, right: DexScreenerProfile): number {
  const leftUpdated = new Date(toIsoDate(left.updatedAt) ?? 0).getTime();
  const rightUpdated = new Date(toIsoDate(right.updatedAt) ?? 0).getTime();
  return rightUpdated - leftUpdated;
}

function mergeProfilesByNewest(profiles: DexScreenerProfile[]): { dedupedProfiles: DexScreenerProfile[]; duplicateProfilesRemoved: number } {
  const bestByKey = new Map<string, DexScreenerProfile>();
  for (const profile of profiles) {
    if (!profile.chainId || !profile.tokenAddress) continue;
    const key = `${profile.chainId}:${profile.tokenAddress}`;
    const current = bestByKey.get(key);
    if (!current) {
      bestByKey.set(key, profile);
      continue;
    }
    const profileUpdated = new Date(toIsoDate(profile.updatedAt) ?? 0).getTime();
    const currentUpdated = new Date(toIsoDate(current.updatedAt) ?? 0).getTime();
    if (profileUpdated >= currentUpdated) {
      bestByKey.set(key, profile);
    }
  }
  const dedupedProfiles = [...bestByKey.values()].sort(sortProfilesByFreshness);
  return { dedupedProfiles, duplicateProfilesRemoved: Math.max(0, profiles.length - dedupedProfiles.length) };
}

function pickBestPair(pairs: DexScreenerPair[]): DexScreenerPair | null {
  if (pairs.length === 0) return null;
  return [...pairs].sort((left, right) => {
    const leftCreated = toNumber(left.pairCreatedAt) ?? -1;
    const rightCreated = toNumber(right.pairCreatedAt) ?? -1;
    if (rightCreated !== leftCreated) return rightCreated - leftCreated;

    const leftLiquidity = toNumber(left.liquidity?.usd) ?? -1;
    const rightLiquidity = toNumber(right.liquidity?.usd) ?? -1;
    if (rightLiquidity !== leftLiquidity) return rightLiquidity - leftLiquidity;

    const leftVolume = toNumber(left.volume?.h24) ?? -1;
    const rightVolume = toNumber(right.volume?.h24) ?? -1;
    return rightVolume - leftVolume;
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
  const values = [toNumber(pair?.priceChange?.m5), toNumber(pair?.priceChange?.h1), toNumber(pair?.priceChange?.h24)].filter(
    (value): value is number => value !== null && value > 0
  );
  return values.length > 0 ? Math.max(...values) : 0;
}

function normalizeFallbackSymbol(address: string): string {
  return `UNK-${address.slice(0, 4)}`;
}

function getDiscoveryMetrics(profile: DexScreenerProfile, pair: DexScreenerPair | null, observedAt: string): {
  pairCreatedAt: string | null;
  dataUpdatedAt: string;
  pairAgeMinutes: number | null;
  dataAgeMinutes: number | null;
  movedBeforeDiscoveryPct: number;
} {
  const pairCreatedAt = toIsoDate(pair?.pairCreatedAt);
  const dataUpdatedAt = toIsoDate(profile.updatedAt) ?? pairCreatedAt ?? observedAt;
  return {
    pairCreatedAt,
    dataUpdatedAt,
    pairAgeMinutes: ageMinutesFromIso(pairCreatedAt, observedAt),
    dataAgeMinutes: ageMinutesFromIso(dataUpdatedAt, observedAt),
    movedBeforeDiscoveryPct: deriveMovedBeforeDiscoveryPct(pair)
  };
}

function candidateFreshnessValue(candidate: TokenCandidate, key: 'pairAgeMinutes' | 'dataAgeMinutes'): number {
  const value = (candidate.raw?.discovery as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function candidateDiscoveryPairCreatedAt(candidate: TokenCandidate): number {
  const value = (candidate.raw?.discovery as Record<string, unknown> | undefined)?.pairCreatedAt;
  const iso = typeof value === 'string' ? value : null;
  const parsed = iso ? new Date(iso).getTime() : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function candidateMovedBeforeDiscovery(candidate: TokenCandidate): number {
  return candidate.movedBeforeDiscoveryPct ?? Number.POSITIVE_INFINITY;
}

export function normalizeDexScreenerCandidate(profile: DexScreenerProfile, pairsForToken: DexScreenerPair[], observedAt = new Date().toISOString()): TokenCandidate | null {
  if (profile.chainId !== 'solana' || !profile.tokenAddress) {
    return null;
  }

  const pair = pickBestPair(pairsForToken.filter((item) => item.chainId === 'solana' && item.baseToken?.address === profile.tokenAddress));
  const discovery = getDiscoveryMetrics(profile, pair, observedAt);
  const tokenCreatedAt = discovery.pairCreatedAt ?? toIsoDate(profile.updatedAt) ?? observedAt;

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
    movedBeforeDiscoveryPct: discovery.movedBeforeDiscoveryPct,
    dataUpdatedAt: discovery.dataUpdatedAt,
    raw: {
      profile,
      pairCount: pairsForToken.length,
      selectedPair: pair
        ? {
            pairAddress: pair.pairAddress,
            dexId: pair.dexId,
            quoteToken: pair.quoteToken,
            liquidityUsd: pair.liquidity?.usd ?? null,
            volume24hUsd: pair.volume?.h24 ?? null,
            pairCreatedAt: discovery.pairCreatedAt,
            priceChange5mPct: pair.priceChange?.m5 ?? null,
            priceChange1hPct: pair.priceChange?.h1 ?? null,
            priceChange24hPct: pair.priceChange?.h24 ?? null
          }
        : null,
      discovery: {
        profileUpdatedAt: toIsoDate(profile.updatedAt),
        pairCreatedAt: discovery.pairCreatedAt,
        pairAgeMinutes: discovery.pairAgeMinutes,
        dataAgeMinutes: discovery.dataAgeMinutes,
        movedBeforeDiscoveryPct: discovery.movedBeforeDiscoveryPct
      }
    }
  };
}

export class DexScreenerTokenSource implements TokenSource {
  readonly name = 'dexscreener';

  private readonly fetchImpl: FetchImpl;
  private readonly profilesUrl: string;
  private readonly recentUpdatesUrl: string;
  private readonly includeRecentUpdates: boolean;
  private readonly tokensBaseUrl: string;
  private readonly maxTokens: number;
  private readonly batchSize: number;
  private readonly maxPairAgeMinutes: number;
  private readonly maxDataAgeMinutes: number;
  private readonly maxMovedBeforeDiscoveryPct: number;
  private readonly freshDiscoveryLimit: number;
  private lastFetchSummary: DexScreenerFetchSummary | null = null;

  constructor(options: DexScreenerSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.profilesUrl = options.profilesUrl ?? DEFAULT_PROFILES_URL;
    this.recentUpdatesUrl = options.recentUpdatesUrl ?? DEFAULT_RECENT_UPDATES_URL;
    this.includeRecentUpdates = options.includeRecentUpdates ?? DEFAULT_INCLUDE_RECENT_UPDATES;
    this.tokensBaseUrl = options.tokensBaseUrl ?? DEFAULT_TOKENS_BASE_URL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxPairAgeMinutes = options.maxPairAgeMinutes ?? DEFAULT_MAX_PAIR_AGE_MINUTES;
    this.maxDataAgeMinutes = options.maxDataAgeMinutes ?? DEFAULT_MAX_DATA_AGE_MINUTES;
    this.maxMovedBeforeDiscoveryPct = options.maxMovedBeforeDiscoveryPct ?? DEFAULT_MAX_MOVED_BEFORE_DISCOVERY_PCT;
    this.freshDiscoveryLimit = options.freshDiscoveryLimit ?? this.maxTokens;
  }

  getLastFetchSummary(): Record<string, unknown> | null {
    return this.lastFetchSummary;
  }

  async fetchCandidates(): Promise<TokenCandidate[]> {
    try {
      const observedAt = new Date().toISOString();
      const latestProfiles = await this.fetchProfiles(this.profilesUrl);
      const recentProfiles = this.includeRecentUpdates ? await this.fetchProfiles(this.recentUpdatesUrl) : [];
      const mergedProfiles = [...latestProfiles, ...recentProfiles];
      const { dedupedProfiles, duplicateProfilesRemoved } = mergeProfilesByNewest(mergedProfiles);
      const solanaProfiles = dedupedProfiles
        .filter((profile) => profile.chainId === 'solana' && profile.tokenAddress)
        .slice(0, this.maxTokens);

      if (solanaProfiles.length === 0) {
        this.lastFetchSummary = {
          profilesFetched: mergedProfiles.length,
          latestProfilesFetched: latestProfiles.length,
          recentProfilesFetched: recentProfiles.length,
          profilesAfterDedupe: dedupedProfiles.length,
          duplicateProfilesRemoved,
          recentUpdatesEnabled: this.includeRecentUpdates,
          solanaProfilesConsidered: 0,
          candidatesAccepted: 0,
          freshAcceptedCount: 0,
          staleRejectedCount: 0,
          alreadyMovedRejectedCount: 0,
          missingPairRejectedCount: 0,
          limitedOutCount: 0
        };
        return [];
      }

      const pairMap = await this.fetchPairsForTokens(solanaProfiles.map((profile) => profile.tokenAddress as string));
      const accepted: TokenCandidate[] = [];
      let staleRejectedCount = 0;
      let alreadyMovedRejectedCount = 0;
      let missingPairRejectedCount = 0;

      for (const profile of solanaProfiles) {
        const candidate = normalizeDexScreenerCandidate(profile, pairMap.get(profile.tokenAddress as string) ?? [], observedAt);
        if (!candidate) continue;

        const selectedPair = (candidate.raw?.selectedPair as Record<string, unknown> | undefined) ?? null;
        if (!selectedPair) {
          missingPairRejectedCount += 1;
          continue;
        }

        const discovery = (candidate.raw?.discovery as Record<string, unknown> | undefined) ?? {};
        const pairAgeMinutes = typeof discovery.pairAgeMinutes === 'number' ? discovery.pairAgeMinutes : null;
        const dataAgeMinutes = typeof discovery.dataAgeMinutes === 'number' ? discovery.dataAgeMinutes : null;
        const stalePair = pairAgeMinutes !== null && pairAgeMinutes > this.maxPairAgeMinutes;
        const staleData = dataAgeMinutes !== null && dataAgeMinutes > this.maxDataAgeMinutes;
        if (stalePair || staleData) {
          staleRejectedCount += 1;
          continue;
        }

        if ((candidate.movedBeforeDiscoveryPct ?? 0) > this.maxMovedBeforeDiscoveryPct) {
          alreadyMovedRejectedCount += 1;
          continue;
        }

        accepted.push(candidate);
      }

      const ranked = accepted.sort((left, right) => {
        const createdDelta = candidateDiscoveryPairCreatedAt(right) - candidateDiscoveryPairCreatedAt(left);
        if (createdDelta !== 0) return createdDelta;

        const dataAgeDelta = candidateFreshnessValue(left, 'dataAgeMinutes') - candidateFreshnessValue(right, 'dataAgeMinutes');
        if (dataAgeDelta !== 0) return dataAgeDelta;

        const movedDelta = candidateMovedBeforeDiscovery(left) - candidateMovedBeforeDiscovery(right);
        if (movedDelta !== 0) return movedDelta;

        const liquidityDelta = (right.liquidityUsd ?? -1) - (left.liquidityUsd ?? -1);
        if (liquidityDelta !== 0) return liquidityDelta;

        return (right.volume24hUsd ?? -1) - (left.volume24hUsd ?? -1);
      });

      const candidates = ranked.slice(0, this.freshDiscoveryLimit);
      this.lastFetchSummary = {
        profilesFetched: mergedProfiles.length,
        latestProfilesFetched: latestProfiles.length,
        recentProfilesFetched: recentProfiles.length,
        profilesAfterDedupe: dedupedProfiles.length,
        duplicateProfilesRemoved,
        recentUpdatesEnabled: this.includeRecentUpdates,
        solanaProfilesConsidered: solanaProfiles.length,
        candidatesAccepted: candidates.length,
        freshAcceptedCount: candidates.length,
        staleRejectedCount,
        alreadyMovedRejectedCount,
        missingPairRejectedCount,
        limitedOutCount: Math.max(0, ranked.length - candidates.length)
      };

      return candidates;
    } catch {
      this.lastFetchSummary = null;
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

  private async fetchProfiles(url: string): Promise<DexScreenerProfile[]> {
    try {
      const response = await this.fetchImpl(url, {
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

export function createDexScreenerSourceFromConfig(config: AppConfig, options: Omit<DexScreenerSourceOptions, 'recentUpdatesUrl' | 'includeRecentUpdates' | 'maxPairAgeMinutes' | 'maxDataAgeMinutes' | 'maxMovedBeforeDiscoveryPct' | 'freshDiscoveryLimit'> = {}): DexScreenerTokenSource {
  return new DexScreenerTokenSource({
    ...options,
    recentUpdatesUrl: config.dexScreenerRecentUpdatesUrl,
    includeRecentUpdates: config.dexScreenerIncludeRecentUpdates,
    maxPairAgeMinutes: config.dexScreenerMaxPairAgeMinutes,
    maxDataAgeMinutes: config.dexScreenerMaxDataAgeMinutes,
    maxMovedBeforeDiscoveryPct: config.dexScreenerMaxMovedBeforeDiscoveryPct,
    freshDiscoveryLimit: config.dexScreenerFreshDiscoveryLimit
  });
}
