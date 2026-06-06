export type TokenGrabLane =
  | 'PRE_LAUNCH_WATCH'
  | 'FRESH_LAUNCH_CANDIDATE'
  | 'MEME_EVENT_CANDIDATE'
  | 'NOISE_RUG_LIKELY';

export type TokenGrabDecision = 'WATCH' | 'ALERT_ONLY' | 'REJECT';

export interface SocialSignalEngagement {
  likes?: number;
  reposts?: number;
  replies?: number;
  views?: number;
}

export interface SocialSignalExtracted {
  tickers: string[];
  tokenNames: string[];
  contractAddresses: string[];
  urls: string[];
  phrases: string[];
}

export interface SocialSignalFlags {
  knownCaller?: boolean;
  officialProjectAccount?: boolean;
  suspectedBot?: boolean;
  identicalSpamCluster?: boolean;
}

export interface SocialSignal {
  id: string;
  source: 'x' | 'manual' | 'fixture';
  authorHandle: string;
  authorDisplayName?: string;
  authorFollowers?: number;
  authorCredibility?: number;
  text: string;
  url?: string;
  firstSeenAt: string;
  createdAt?: string;
  engagement?: SocialSignalEngagement;
  extracted: SocialSignalExtracted;
  flags: SocialSignalFlags;
}

export interface EventSignal {
  id: string;
  source: string;
  phrase: string;
  normalizedPhrase: string;
  category: 'celebrity' | 'politics' | 'sports' | 'internet' | 'ai' | 'finance' | 'crypto' | 'other';
  firstSeenAt: string;
  velocityScore: number;
  evidenceCount: number;
  relatedTerms: string[];
  exampleUrls: string[];
}

export interface LaunchSignal {
  id: string;
  projectName?: string;
  ticker?: string;
  chain?: string;
  expectedLaunchAt?: string;
  firstSeenAt: string;
  sourceSignalIds: string[];
  officialLinks: string[];
  confidence: number;
}

export interface FreshPoolMetadata {
  website?: string;
  x?: string;
  telegram?: string;
  description?: string;
}

export interface FreshPool {
  id: string;
  chain: string;
  tokenName: string;
  ticker: string;
  contractAddress: string;
  poolAddress?: string;
  createdAt: string;
  liquidityUsd?: number;
  volume5mUsd?: number;
  holders?: number;
  source?: string;
  metadata?: FreshPoolMetadata;
}

export interface FreshPoolMatch {
  poolId: string;
  matchedSocialSignalIds: string[];
  matchedEventSignalIds: string[];
  matchedLaunchSignalIds: string[];
  reasons: string[];
  redFlags: string[];
}

export interface TokenGrabRadarCandidate {
  id: string;
  tokenName?: string;
  ticker?: string;
  contractAddress?: string;
  poolAddress?: string;
  lane: TokenGrabLane;
  decision: TokenGrabDecision;
  score: number;
  firstSeenAt: string;
  poolCreatedAt?: string;
  poolAgeMinutes?: number;
  matchedSocialSignals: SocialSignal[];
  matchedEventSignals: EventSignal[];
  matchedLaunchSignals: LaunchSignal[];
  reasons: string[];
  redFlags: string[];
  noTradingExecuted: true;
}

export interface TokenGrabFixtures {
  socialSignals: SocialSignal[];
  eventSignals: EventSignal[];
  freshPools: FreshPool[];
}

export interface TokenGrabReport {
  generatedAt: string;
  mode: 'fixture-only';
  tradingStatus: 'LOCKED / NO TRADING EXECUTED';
  candidates: TokenGrabRadarCandidate[];
  summary: {
    prelaunchWatch: number;
    memeEventCandidates: number;
    freshLaunchCandidates: number;
    rejectedNoise: number;
    tradingExecuted: 0;
  };
}
