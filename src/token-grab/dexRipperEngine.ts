import type { HolderConcentrationStatus, MintAuthorityStatus, FreezeAuthorityStatus } from './dexLegitimacyReport';

// ── Types ─────────────────────────────────────────────────────────────────────────────────

export type LaunchAgeBucket = 'TOO_EARLY' | 'PRIME_WINDOW' | 'LATE' | 'DEAD_WINDOW';
export type HolderRisk     = 'CLEAN' | 'WATCH' | 'RISKY' | 'UNKNOWN';
export type ClusterRisk    = 'CLEAN' | 'WATCH' | 'RISKY' | 'UNKNOWN';
export type BotRisk        = 'CLEAN' | 'WATCH' | 'RISKY' | 'UNKNOWN';
export type LiquidityQuality = 'GOOD' | 'THIN' | 'ONE_SIDED' | 'SUSPICIOUS' | 'UNKNOWN';
export type RipperEntryDecision =
  | 'IGNORE'
  | 'WATCH'
  | 'READY_TO_SNIPE_PAPER'
  | 'PAPER_BUY_BLOCKED';

export type RipperSellReason =
  | 'TAKE_PROFIT_FAST'
  | 'MOMENTUM_FADE'
  | 'TRAILING_STOP'
  | 'LIQUIDITY_RISK_SPIKE'
  | 'HOLDER_RISK_SPIKE'
  | 'BOT_RISK_SPIKE'
  | 'MAX_HOLD_TIME'
  | 'STOP_LOSS'
  | 'DATA_STALE_EXIT';

export type PaperBuyDecision = 'BUY_APPROVED_PAPER' | 'BUY_REJECTED';

// ── Sub-profiles ──────────────────────────────────────────────────────────────────────────

export interface HolderClusterProfile {
  holderRisk: HolderRisk;
  clusterRisk: ClusterRisk; // UNKNOWN in V1 (BubbleMaps not connected)
  concentrationNotes: string[];
}

export interface BotRiskProfile {
  botRisk: BotRisk;
  botNotes: string[];
}

export interface LiquidityProfile {
  quality: LiquidityQuality;
  volumeLiquidityRatio?: number;
  notes: string[];
}

// ── Primary signal output ─────────────────────────────────────────────────────────────────

export interface RipperInput {
  contract: string;
  symbol?: string;
  observedAt?: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  // Optional enrichment (from dexCandidateSafetyEnrich or dexLegitimacyReport)
  mintAuthorityStatus?: MintAuthorityStatus;
  freezeAuthorityStatus?: FreezeAuthorityStatus;
  holderConcentrationStatus?: HolderConcentrationStatus;
  topHolderPercent?: number;
}

export interface RipperSignal {
  contract: string;
  symbol?: string;
  observedAt?: string;
  ageMinutes?: number;
  launchAgeBucket: LaunchAgeBucket;
  liquidityProfile: LiquidityProfile;
  holderCluster: HolderClusterProfile;
  botRiskProfile: BotRiskProfile;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  ripperScore: number; // 0–100
  entryDecision: RipperEntryDecision;
  topReasons: string[];  // max 5 positive reasons
  blockers: string[];    // max 5 blockers
}

// ── Paper position state ──────────────────────────────────────────────────────────────────

export interface RipperPaperPosition {
  contract: string;
  symbol?: string;
  openedAt: string;
  entryPriceChangePct?: number;
  entryLiquidityChangePct?: number;
  entryVlr?: number;
  entryRipperScore: number;
  positionSizeUsd: number;
  peakPriceChangePct?: number;
  status: 'OPEN' | 'CLOSED';
  closedAt?: string;
  exitReason?: RipperSellReason;
  exitPriceChangePct?: number;
  fakePnlPct?: number;
  fakePnlUsd?: number;
  holdMinutes?: number;
}

// ── Gate and sell results ─────────────────────────────────────────────────────────────────

export interface PaperBuyGateResult {
  decision: PaperBuyDecision;
  reasons: string[];
  blockers: string[];
}

export interface SellEvalResult {
  shouldSell: boolean;
  reason?: RipperSellReason;
  note: string;
  fakePnlPct?: number;
}

// ── Config ────────────────────────────────────────────────────────────────────────────────

export interface RipperConfig {
  // Age buckets (minutes)
  tooEarlyMaxMinutes: number;
  primeWindowMaxMinutes: number;
  lateWindowMaxMinutes: number;
  // Score thresholds
  minScoreToWatch: number;
  minScoreToReady: number;
  minScoreToBuy: number;
  // Buy gate
  requirePrimeWindow: boolean;
  // Sell rules
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopFromPeakPct: number;
  maxHoldMinutes: number;
  vlrSpikeThreshold: number;
  // Paper position
  positionSizeUsd: number;
}

export const DEFAULT_RIPPER_CONFIG: RipperConfig = {
  tooEarlyMaxMinutes: 2,
  primeWindowMaxMinutes: 20,
  lateWindowMaxMinutes: 60,
  minScoreToWatch: 35,
  minScoreToReady: 60,
  minScoreToBuy: 65,
  requirePrimeWindow: true,
  takeProfitPct: 40,
  stopLossPct: -20,
  trailingStopFromPeakPct: 25,
  maxHoldMinutes: 30,
  vlrSpikeThreshold: 2.0,
  positionSizeUsd: 1.0,
};

// ── Pure scoring helpers ──────────────────────────────────────────────────────────────────

export function classifyLaunchAge(
  ageMinutes: number | null | undefined,
  config: RipperConfig,
): LaunchAgeBucket {
  if (ageMinutes == null || !Number.isFinite(ageMinutes) || ageMinutes < 0) return 'DEAD_WINDOW';
  if (ageMinutes < config.tooEarlyMaxMinutes) return 'TOO_EARLY';
  if (ageMinutes < config.primeWindowMaxMinutes) return 'PRIME_WINDOW';
  if (ageMinutes < config.lateWindowMaxMinutes) return 'LATE';
  return 'DEAD_WINDOW';
}

export function scoreLiquidityProfile(
  liquidityChangePct: number | undefined,
  volumeLiquidityRatio: number | undefined,
): LiquidityProfile {
  const vlr = volumeLiquidityRatio;
  const liq = liquidityChangePct;
  const notes: string[] = [];

  if (vlr == null && liq == null) {
    return { quality: 'UNKNOWN', notes: ['no liquidity data'] };
  }

  // Extreme VLR → pump/bot risk
  if (vlr != null && vlr > 5) {
    notes.push(`VLR ${vlr.toFixed(2)} — extreme volume vs liquidity`);
    return { quality: 'SUSPICIOUS', volumeLiquidityRatio: vlr, notes };
  }

  // Liquidity collapsing while sell pressure is high → one-sided
  if (liq != null && liq < -20 && vlr != null && vlr > 1.5) {
    notes.push(`liq ${liq.toFixed(1)}% with VLR ${vlr.toFixed(2)} — one-sided sell pressure`);
    return { quality: 'ONE_SIDED', volumeLiquidityRatio: vlr, notes };
  }

  // Rapidly thinning liquidity
  if (liq != null && liq < -30) {
    notes.push(`liq ${liq.toFixed(1)}% — thinning fast`);
    return { quality: 'THIN', volumeLiquidityRatio: vlr, notes };
  }

  // Elevated but not extreme VLR with no other red flags → thin
  if (vlr != null && vlr > 2) {
    notes.push(`VLR ${vlr.toFixed(2)} — elevated`);
    if (liq != null) notes.push(`liq ${liq >= 0 ? '+' : ''}${liq.toFixed(1)}%`);
    return { quality: 'THIN', volumeLiquidityRatio: vlr, notes };
  }

  // Healthy
  if (liq != null) notes.push(`liq ${liq >= 0 ? '+' : ''}${liq.toFixed(1)}%`);
  if (vlr != null) notes.push(`VLR ${vlr.toFixed(2)}`);
  return { quality: 'GOOD', volumeLiquidityRatio: vlr, notes };
}

export function scoreHolderCluster(
  holderConcentrationStatus: HolderConcentrationStatus | undefined,
  topHolderPercent: number | undefined,
): HolderClusterProfile {
  const concentrationNotes: string[] = [];
  let holderRisk: HolderRisk = 'UNKNOWN';

  if (
    holderConcentrationStatus === 'DANGER' ||
    (topHolderPercent != null && topHolderPercent >= 30)
  ) {
    holderRisk = 'RISKY';
    concentrationNotes.push(
      topHolderPercent != null
        ? `top holder ${topHolderPercent.toFixed(1)}% — DANGER`
        : 'holder concentration DANGER',
    );
  } else if (
    holderConcentrationStatus === 'WARNING' ||
    (topHolderPercent != null && topHolderPercent >= 15)
  ) {
    holderRisk = 'WATCH';
    concentrationNotes.push(
      topHolderPercent != null
        ? `top holder ${topHolderPercent.toFixed(1)}% — WARNING`
        : 'holder concentration WARNING',
    );
  } else if (holderConcentrationStatus === 'CLEAN') {
    holderRisk = 'CLEAN';
    if (topHolderPercent != null) {
      concentrationNotes.push(`top holder ${topHolderPercent.toFixed(1)}% — CLEAN`);
    }
  }

  // Cluster risk: UNKNOWN in V1 — BubbleMaps integration not yet connected.
  return { holderRisk, clusterRisk: 'UNKNOWN', concentrationNotes };
}

export function scoreBotRisk(
  volumeLiquidityRatio: number | undefined,
  liquidityChangePct: number | undefined,
  priceChangePct: number | undefined,
): BotRiskProfile {
  const vlr = volumeLiquidityRatio;
  const liq = liquidityChangePct;
  const price = priceChangePct;
  const botNotes: string[] = [];

  if (vlr != null && vlr > 5) {
    botNotes.push(`VLR ${vlr.toFixed(2)} — extreme velocity, bot/pump risk`);
    return { botRisk: 'RISKY', botNotes };
  }

  // Classic dump pattern: big price move + liquidity collapsing
  if (price != null && price > 50 && liq != null && liq < -20) {
    botNotes.push(`price +${price.toFixed(1)}% while liq ${liq.toFixed(1)}% — dump risk`);
    return { botRisk: 'RISKY', botNotes };
  }

  if (vlr != null && vlr > 2) {
    botNotes.push(`VLR ${vlr.toFixed(2)} — elevated, monitoring`);
    return { botRisk: 'WATCH', botNotes };
  }

  if (vlr == null && liq == null && price == null) {
    return { botRisk: 'UNKNOWN', botNotes: ['no market data'] };
  }

  return { botRisk: 'CLEAN', botNotes: [] };
}

// ── Main scorer ───────────────────────────────────────────────────────────────────────────

export function scoreRipper(
  input: RipperInput,
  config: RipperConfig,
  nowMs: number,
): RipperSignal {
  let ageMinutes: number | undefined;
  if (input.observedAt) {
    const ms = new Date(input.observedAt).getTime();
    if (Number.isFinite(ms)) ageMinutes = (nowMs - ms) / 60000;
  }

  const launchAgeBucket  = classifyLaunchAge(ageMinutes, config);
  const liquidityProfile = scoreLiquidityProfile(input.liquidityChangePct, input.volumeLiquidityRatio);
  const holderCluster    = scoreHolderCluster(input.holderConcentrationStatus, input.topHolderPercent);
  const botRiskProfile   = scoreBotRisk(input.volumeLiquidityRatio, input.liquidityChangePct, input.priceChangePct);

  let score = 50;
  const topReasons: string[] = [];
  const blockers: string[]   = [];

  // ── Age ──
  switch (launchAgeBucket) {
    case 'PRIME_WINDOW':
      score += 25;
      topReasons.push(`prime window (${ageMinutes!.toFixed(0)}m old)`);
      break;
    case 'TOO_EARLY':
      score += 5;
      blockers.push(`too early (${ageMinutes!.toFixed(0)}m) — wait for prime window`);
      break;
    case 'LATE':
      score -= 15;
      blockers.push(`late window (${ageMinutes!.toFixed(0)}m) — ripper window closing`);
      break;
    case 'DEAD_WINDOW':
      score -= 50;
      blockers.push(
        ageMinutes != null
          ? `dead window (${ageMinutes.toFixed(0)}m) — too old for ripper`
          : 'age unknown — dead window',
      );
      break;
  }

  // ── Price momentum ──
  const price = input.priceChangePct;
  if (price != null) {
    if (price >= 50)       { score += 15; topReasons.push(`strong momentum +${price.toFixed(1)}%`); }
    else if (price >= 20)  { score += 10; topReasons.push(`momentum +${price.toFixed(1)}%`); }
    else if (price >= 0)   { score += 3;  }
    else                   { score -= 20; blockers.push(`price declining ${price.toFixed(1)}%`); }
  }

  // ── Liquidity quality ──
  switch (liquidityProfile.quality) {
    case 'GOOD':       score += 12; topReasons.push('liquidity quality GOOD'); break;
    case 'THIN':       score -= 10; blockers.push('liquidity thinning'); break;
    case 'ONE_SIDED':  score -= 20; blockers.push('one-sided liquidity — sell pressure'); break;
    case 'SUSPICIOUS': score -= 30; blockers.push('suspicious liquidity — possible pump'); break;
  }

  // ── VLR health ──
  const vlr = input.volumeLiquidityRatio;
  if (vlr != null) {
    if (vlr <= 0.5)      score += 8;
    else if (vlr <= 1)   score += 4;
    else if (vlr <= 2)   { /* neutral */ }
    else if (vlr <= 5)   score -= 10;
    else                 score -= 25;
  }

  // ── Holder risk ──
  switch (holderCluster.holderRisk) {
    case 'CLEAN':   score += 10; topReasons.push('holder concentration CLEAN'); break;
    case 'WATCH':   break;
    case 'RISKY':   score -= 35; blockers.push('holder concentration RISKY'); break;
    case 'UNKNOWN': break;
  }

  // ── Cluster risk ──
  switch (holderCluster.clusterRisk) {
    case 'CLEAN':   score += 8; topReasons.push('cluster risk CLEAN'); break;
    case 'WATCH':   break;
    case 'RISKY':   score -= 25; blockers.push('cluster risk RISKY'); break;
    case 'UNKNOWN': break;
  }

  // ── Bot risk ──
  switch (botRiskProfile.botRisk) {
    case 'CLEAN':   score += 5; break;
    case 'WATCH':   score -= 5; break;
    case 'RISKY':
      score -= 30;
      blockers.push(`bot/pump risk: ${botRiskProfile.botNotes[0] ?? 'RISKY'}`);
      break;
    case 'UNKNOWN': break;
  }

  const ripperScore = Math.max(0, Math.min(100, Math.round(score)));

  // ── Entry decision ──
  const hasRiskySignals =
    holderCluster.holderRisk === 'RISKY' ||
    holderCluster.clusterRisk === 'RISKY' ||
    botRiskProfile.botRisk === 'RISKY' ||
    liquidityProfile.quality === 'SUSPICIOUS';

  let entryDecision: RipperEntryDecision;
  if (launchAgeBucket === 'DEAD_WINDOW') {
    entryDecision = 'IGNORE';
  } else if (hasRiskySignals) {
    // Show PAPER_BUY_BLOCKED (not IGNORE) so the caller sees the specific reason.
    entryDecision = 'PAPER_BUY_BLOCKED';
  } else if (ripperScore < config.minScoreToWatch) {
    entryDecision = 'IGNORE';
  } else if (ripperScore < config.minScoreToReady) {
    entryDecision = 'WATCH';
  } else {
    entryDecision = 'READY_TO_SNIPE_PAPER';
  }

  return {
    contract: input.contract,
    symbol: input.symbol,
    observedAt: input.observedAt,
    ageMinutes,
    launchAgeBucket,
    liquidityProfile,
    holderCluster,
    botRiskProfile,
    priceChangePct: input.priceChangePct,
    liquidityChangePct: input.liquidityChangePct,
    volumeLiquidityRatio: input.volumeLiquidityRatio,
    ripperScore,
    entryDecision,
    topReasons: topReasons.slice(0, 5),
    blockers: blockers.slice(0, 5),
  };
}

// ── Paper buy gate ────────────────────────────────────────────────────────────────────────

export function checkPaperBuyGate(
  signal: RipperSignal,
  config: RipperConfig,
): PaperBuyGateResult {
  const blockers: string[] = [];

  if (signal.entryDecision !== 'READY_TO_SNIPE_PAPER') {
    blockers.push(`entry decision is ${signal.entryDecision}`);
  }
  if (signal.ripperScore < config.minScoreToBuy) {
    blockers.push(`score ${signal.ripperScore} below buy threshold ${config.minScoreToBuy}`);
  }
  if (config.requirePrimeWindow && signal.launchAgeBucket !== 'PRIME_WINDOW') {
    blockers.push(`launch age ${signal.launchAgeBucket} — must be PRIME_WINDOW`);
  }
  if (signal.holderCluster.holderRisk === 'RISKY') {
    blockers.push('holder concentration RISKY — buy blocked');
  }
  if (signal.holderCluster.clusterRisk === 'RISKY') {
    blockers.push('cluster risk RISKY — buy blocked');
  }
  if (signal.botRiskProfile.botRisk === 'RISKY') {
    blockers.push('bot/pump risk RISKY — buy blocked');
  }
  if (signal.liquidityProfile.quality === 'SUSPICIOUS') {
    blockers.push('suspicious liquidity — buy blocked');
  }
  if (signal.liquidityProfile.quality === 'ONE_SIDED') {
    blockers.push('one-sided liquidity — buy blocked');
  }
  // Include any scorer blockers not already captured
  for (const b of signal.blockers) {
    if (!blockers.some(x => x.startsWith(b.slice(0, 12)))) blockers.push(b);
  }

  if (blockers.length > 0) {
    return { decision: 'BUY_REJECTED', reasons: [], blockers };
  }

  const reasons = [...signal.topReasons, `ripperScore ${signal.ripperScore}`];
  return { decision: 'BUY_APPROVED_PAPER', reasons, blockers: [] };
}

// ── Sell evaluation ───────────────────────────────────────────────────────────────────────

export function evaluateSell(
  position: RipperPaperPosition,
  currentSignal: RipperSignal | null,
  config: RipperConfig,
  nowMs: number,
): SellEvalResult {
  // Token fell off the candidate list
  if (!currentSignal) {
    return { shouldSell: true, reason: 'DATA_STALE_EXIT', note: 'token no longer in candidate list' };
  }

  const holdMinutes = (nowMs - new Date(position.openedAt).getTime()) / 60000;

  if (holdMinutes >= config.maxHoldMinutes) {
    return {
      shouldSell: true,
      reason: 'MAX_HOLD_TIME',
      note: `held ${holdMinutes.toFixed(0)}m — max ${config.maxHoldMinutes}m reached`,
    };
  }

  // Fake P/L: ((100 + currentPct) / (100 + entryPct) - 1) * 100
  const entryPct   = position.entryPriceChangePct ?? 0;
  const currentPct = currentSignal.priceChangePct ?? entryPct;
  const pnlPct     = ((100 + currentPct) / (100 + entryPct) - 1) * 100;

  if (pnlPct <= config.stopLossPct) {
    return {
      shouldSell: true,
      reason: 'STOP_LOSS',
      note: `fake P/L ${pnlPct.toFixed(1)}% ≤ stop loss ${config.stopLossPct}%`,
      fakePnlPct: pnlPct,
    };
  }

  if (pnlPct >= config.takeProfitPct) {
    return {
      shouldSell: true,
      reason: 'TAKE_PROFIT_FAST',
      note: `fake P/L ${pnlPct.toFixed(1)}% ≥ take profit ${config.takeProfitPct}%`,
      fakePnlPct: pnlPct,
    };
  }

  // Trailing stop from peak
  const peakPct    = position.peakPriceChangePct ?? entryPct;
  const peakPnl    = ((100 + peakPct) / (100 + entryPct) - 1) * 100;
  const pullback   = peakPnl - pnlPct;
  if (peakPnl > 10 && pullback >= config.trailingStopFromPeakPct) {
    return {
      shouldSell: true,
      reason: 'TRAILING_STOP',
      note: `peaked at +${peakPnl.toFixed(1)}%, pulled back ${pullback.toFixed(1)}% — trailing stop`,
      fakePnlPct: pnlPct,
    };
  }

  // VLR spike post-entry
  const currentVlr = currentSignal.volumeLiquidityRatio ?? 0;
  const entryVlr   = position.entryVlr ?? 0;
  if (currentVlr >= config.vlrSpikeThreshold && entryVlr < config.vlrSpikeThreshold) {
    return {
      shouldSell: true,
      reason: 'LIQUIDITY_RISK_SPIKE',
      note: `VLR spiked to ${currentVlr.toFixed(2)} (was ${entryVlr.toFixed(2)} at entry)`,
      fakePnlPct: pnlPct,
    };
  }

  // Safety escalation post-entry
  if (currentSignal.holderCluster.holderRisk === 'RISKY') {
    return {
      shouldSell: true,
      reason: 'HOLDER_RISK_SPIKE',
      note: 'holder concentration became RISKY post-entry',
      fakePnlPct: pnlPct,
    };
  }
  if (currentSignal.botRiskProfile.botRisk === 'RISKY') {
    return {
      shouldSell: true,
      reason: 'BOT_RISK_SPIKE',
      note: 'bot/pump risk became RISKY post-entry',
      fakePnlPct: pnlPct,
    };
  }

  // Momentum dead
  if (currentSignal.launchAgeBucket === 'DEAD_WINDOW') {
    return {
      shouldSell: true,
      reason: 'MOMENTUM_FADE',
      note: 'token entered dead window — ripper window closed',
      fakePnlPct: pnlPct,
    };
  }

  return {
    shouldSell: false,
    note: `holding — P/L ${pnlPct.toFixed(1)}%, ${holdMinutes.toFixed(0)}m held`,
    fakePnlPct: pnlPct,
  };
}
