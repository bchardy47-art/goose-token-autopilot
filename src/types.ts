export type Verdict = 'AVOID' | 'WATCH' | 'PAPER_BUY' | 'AUTOPILOT_ELIGIBLE';
export type AuthorityStatus = 'SAFE' | 'UNSAFE' | 'UNKNOWN';
export type AvailabilityStatus = 'YES' | 'NO' | 'UNKNOWN';
export type MetadataPresence = 'YES' | 'NO' | 'UNKNOWN';
export type ConcentrationStatus = 'SAFE' | 'RISKY' | 'UNKNOWN';
export type CreatorStatus = 'SAFE' | 'RISKY' | 'UNKNOWN';
export type TradeSide = 'BUY' | 'SELL';
export type PositionMode = 'PAPER' | 'REAL';
export type PositionStatus = 'OPEN' | 'CLOSED';
export type ProposalStatus = 'PENDING' | 'EXECUTED' | 'BLOCKED' | 'CANCELLED';
export type SafetySeverity = 'INFO' | 'WARN' | 'ERROR';
export type TokenSourceName = 'fixture' | 'dexscreener';

export interface TokenCandidate {
  chain: string;
  mint: string;
  symbol: string;
  name: string;
  source: string;
  sourceUrl?: string | null;
  discoveredAt: string;
  tokenCreatedAt: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  volume24hUsd: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  buys5m: number | null;
  sells5m: number | null;
  liquidityGrowthPct?: number | null;
  freezeAuthority: AuthorityStatus;
  mintAuthority: AuthorityStatus;
  sellQuoteAvailable: AvailabilityStatus;
  estimatedSlippageBps: number | null;
  metadataPresent: boolean;
  metadataStatus?: MetadataPresence;
  websitePresent?: boolean;
  socialsPresent?: boolean;
  holderConcentration: ConcentrationStatus;
  creatorStatus: CreatorStatus;
  movedBeforeDiscoveryPct: number | null;
  dataUpdatedAt: string;
  raw: Record<string, unknown>;
}

export interface SafetyEvaluation {
  hardRedFlags: string[];
  autopilotBlockers: string[];
  reasons: string[];
}

export interface TokenScoreResult {
  tokenId: number;
  scoredAt: string;
  momentumScore: number;
  safetyScore: number;
  socialScore: number;
  totalScore: number;
  verdict: Verdict;
  reasons: string[];
  redFlags: string[];
  autopilotBlocked: boolean;
  autopilotBlockers: string[];
}

export interface ProposalResult {
  id: number;
  tokenId: number;
  side: TradeSide;
  amountUsd: number;
  verdict: Verdict;
  reason: string;
  status: ProposalStatus;
  safetySnapshot: Record<string, unknown>;
}

export interface QuoteResult {
  ok: boolean;
  side: TradeSide;
  mint: string;
  amountUsd: number;
  estimatedSlippageBps: number;
  reason?: string;
  quoteId?: string;
}

export interface BuildSwapResult {
  ok: boolean;
  reason: string;
  payload?: Record<string, unknown>;
}

export interface ExecutionResult {
  ok: boolean;
  blocked: boolean;
  reason: string;
  attemptId: number;
}

export interface TokenState {
  tokenId: number;
  chain: string;
  mint: string;
  symbol: string;
  name: string;
  source: string;
  sourceUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  snapshot: TokenCandidate | null;
  score: TokenScoreResult | null;
}

export interface PaperPositionView {
  id: number;
  tokenId: number;
  symbol: string;
  mint: string;
  mode: PositionMode;
  status: PositionStatus;
  openedAt: string;
  closedAt: string | null;
  entryPriceUsd: number;
  exitPriceUsd: number | null;
  quantity: number;
  amountUsd: number;
  realizedPnlUsd: number | null;
  realizedPnlPct: number | null;
  latestPriceUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  bestGainPct: number | null;
  worstDrawdownPct: number | null;
  notes: string | null;
}

export interface ReportData {
  latestScanTime: string | null;
  tokensSeen: number;
  topRanked: Array<{
    symbol: string;
    mint: string;
    totalScore: number;
    verdict: Verdict;
    liquidityUsd: number | null;
    priceUsd: number | null;
  }>;
  verdictCounts: Record<Verdict, number>;
  openPositions: PaperPositionView[];
  closedPaperPnlUsd: number;
  blockedRealTradeAttempts: number;
  safetyEventSummary: Record<string, number>;
  safetyStatus: {
    dryRun: boolean;
    tradingDisabled: boolean;
    realBuysEnabled: boolean;
    realSellsEnabled: boolean;
    killSwitchActive: boolean;
  };
}

export interface AutoPaperDecision {
  tokenId: number;
  symbol: string;
  mint: string;
  action: 'BOUGHT' | 'SKIPPED';
  reason: string;
  proposalId?: number | null;
  positionId?: number | null;
}

export interface PaperReviewDecision {
  positionId: number;
  symbol: string;
  action: 'CLOSED' | 'HELD';
  reason: string;
  pnlPct: number;
}

export interface PaperPerformanceSnapshot {
  id: number;
  positionId: number;
  tokenId: number;
  observedAt: string;
  priceUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  rawJson: string;
}

export interface AppConfig {
  tokenRadarDryRun: boolean;
  tradingDisabled: boolean;
  enableRealBuys: boolean;
  enableRealSells: boolean;
  enableAutoPaperTrading: boolean;
  maxBankrollUsd: number;
  maxBuyUsd: number;
  maxDailyLossUsd: number;
  maxOpenPositions: number;
  maxDailyBuys: number;
  maxDailyPaperBuys: number;
  maxAutoPaperBuyUsd: number;
  paperMinTotalScore: number;
  paperMinSafetyScore: number;
  paperMinMomentumScore: number;
  paperTakeProfitPct: number;
  paperStopLossPct: number;
  paperMaxHoldMinutes: number;
  paperTrailingStopEnabled: boolean;
  paperTrailingStopPct: number;
  maxSlippageBps: number;
  minLiquidityUsd: number;
  maxChasePct: number;
  minTokenAgeMin: number;
  maxTokenAgeHours: number;
  minSafetyScoreForAutopilot: number;
  minMomentumScoreForAutopilot: number;
  minTotalScoreForAutopilot: number;
  databaseFile: string;
  tokenSource: TokenSourceName;
  killSwitchFile: string;
  enableSolanaSafetyEnrichment: boolean;
  solanaRpcUrl?: string;
  enableQuoteCheck: boolean;
  burnerWalletPublicKey?: string;
  burnerWalletPrivateKey?: string;
  mainWalletPresent: boolean;
}
