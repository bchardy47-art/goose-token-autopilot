import type { TokenSource } from './source';
import type { TokenCandidate } from '../types';

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

export class FixtureTokenSource implements TokenSource {
  readonly name = 'fixture';

  async fetchCandidates(): Promise<TokenCandidate[]> {
    return [
      {
        chain: 'solana',
        mint: 'SAFE11111111111111111111111111111111111111111',
        symbol: 'SAFE',
        name: 'Safe Goose',
        source: 'fixture',
        sourceUrl: 'fixture://safe-goose',
        discoveredAt: isoMinutesAgo(5),
        tokenCreatedAt: isoHoursAgo(2),
        priceUsd: 0.012,
        liquidityUsd: 95000,
        marketCapUsd: 350000,
        volume5mUsd: 18000,
        volume1hUsd: 115000,
        volume24hUsd: 640000,
        priceChange5mPct: 12,
        priceChange1hPct: 44,
        buys5m: 34,
        sells5m: 11,
        liquidityGrowthPct: 18,
        freezeAuthority: 'SAFE',
        mintAuthority: 'SAFE',
        sellQuoteAvailable: 'YES',
        estimatedSlippageBps: 220,
        metadataPresent: true,
        websitePresent: true,
        socialsPresent: true,
        holderConcentration: 'SAFE',
        creatorStatus: 'SAFE',
        movedBeforeDiscoveryPct: 65,
        dataUpdatedAt: new Date().toISOString(),
        raw: { pair: 'SAFE/SOL' }
      },
      {
        chain: 'solana',
        mint: 'WATCH111111111111111111111111111111111111111',
        symbol: 'WATCH',
        name: 'Watch Goose',
        source: 'fixture',
        sourceUrl: 'fixture://watch-goose',
        discoveredAt: isoMinutesAgo(3),
        tokenCreatedAt: isoHoursAgo(3),
        priceUsd: 0.006,
        liquidityUsd: 30000,
        marketCapUsd: 180000,
        volume5mUsd: 3500,
        volume1hUsd: 15000,
        volume24hUsd: 120000,
        priceChange5mPct: 3,
        priceChange1hPct: 18,
        buys5m: 12,
        sells5m: 9,
        liquidityGrowthPct: 5,
        freezeAuthority: 'SAFE',
        mintAuthority: 'SAFE',
        sellQuoteAvailable: 'YES',
        estimatedSlippageBps: 290,
        metadataPresent: true,
        websitePresent: false,
        socialsPresent: false,
        holderConcentration: 'SAFE',
        creatorStatus: 'SAFE',
        movedBeforeDiscoveryPct: 35,
        dataUpdatedAt: new Date().toISOString(),
        raw: { pair: 'WATCH/SOL' }
      },
      {
        chain: 'solana',
        mint: 'RUG11111111111111111111111111111111111111111',
        symbol: 'RUG',
        name: 'Rug Goose',
        source: 'fixture',
        sourceUrl: 'fixture://rug-goose',
        discoveredAt: isoMinutesAgo(2),
        tokenCreatedAt: isoMinutesAgo(20),
        priceUsd: 0.09,
        liquidityUsd: 4000,
        marketCapUsd: 150000,
        volume5mUsd: 26000,
        volume1hUsd: 190000,
        volume24hUsd: 200000,
        priceChange5mPct: 55,
        priceChange1hPct: 210,
        buys5m: 40,
        sells5m: 2,
        liquidityGrowthPct: 2,
        freezeAuthority: 'UNKNOWN',
        mintAuthority: 'UNSAFE',
        sellQuoteAvailable: 'UNKNOWN',
        estimatedSlippageBps: 950,
        metadataPresent: false,
        websitePresent: false,
        socialsPresent: false,
        holderConcentration: 'UNKNOWN',
        creatorStatus: 'RISKY',
        movedBeforeDiscoveryPct: 250,
        dataUpdatedAt: isoMinutesAgo(30),
        raw: { pair: 'RUG/SOL' }
      }
    ];
  }
}
