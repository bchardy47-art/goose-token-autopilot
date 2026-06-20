// DO_NOT_ENABLE_REAL_TRADING_BY_DEFAULT  everyOrderMustPassThisGate=true
//
// Live Risk Gate v1 — the mandatory pre-trade check that every real (or simulated)
// order must pass before any quote/build/submit. It enforces config readiness, kill
// switch, position/loss/trade limits, slippage, liquidity, duplicate-position, cluster
// risk (UNKNOWN is blocked unless explicitly overridden — never treated as CLEAN), a
// non-negative execution-adjusted edge, feed freshness, and that the candidate is
// currently approved by the existing gate logic.
//
// Pure & side-effect-free: it reads inputs and returns a verdict. It never trades.

import type { LiveTradingConfig } from './ripperLiveTradingConfig';
import type { OpenPosition } from './ripperRealTradingLedger';
import { adjustExecutionPnl, type ExecutionParams } from './ripperExecutionRealismSimulator';

const DEFAULT_STALE_MINUTES = 30;

// Execution params for the adjusted-edge check (matches Execution Realism defaults).
const EDGE_PARAMS: ExecutionParams = {
  slippageBps: 100, feeBps: 30, latencySeconds: 5, maxPnlCap: 300, thinLiqPenalty: 5, failedExitHaircut: 0.2,
};

export interface RiskCandidate {
  contract:         string;
  symbol:           string | null;
  buyGateDecision:  string | null;   // must be BUY_APPROVED_PAPER
  clusterRisk:      string | null;
  liquidityUsd:     number | null;
  entryMomentumPct: number | null;
  // A baseline expected move used only to sanity-check the execution-adjusted edge.
  // Conservative default 0 → adjusted edge will be negative → blocks (safe default).
  expectedBaselinePnl?: number | null;
  liquidityBucket?: string;
  vlrBucket?:       string;
  capturedAt?:      string | null;
}

export interface RiskGateInput {
  candidate:       RiskCandidate;
  intendedUsd:     number;
  mode:            'dry-run' | 'mock' | 'live';
  config:          LiveTradingConfig;
  openPositions:   OpenPosition[];
  tradesToday:     number;
  dailyLoss:       number;          // positive number
  latestCycleTime: string | null;   // ISO of latest cycle; for staleness
  now:             Date;
  allowUnknownClusterOverride?: boolean;
  staleMinutes?:   number;
}

export interface RiskSnapshot {
  contract:        string;
  intendedUsd:     number;
  mode:            string;
  clusterRisk:     string | null;
  liquidityUsd:    number | null;
  adjustedEdge:    number | null;
  openPositions:   number;
  tradesToday:     number;
  dailyLoss:       number;
  maxPositionUsd:  number | null;
  maxOpenPositions: number | null;
  maxTradesPerDay: number | null;
  maxDailyLossUsd: number | null;
  maxSlippageBps:  number | null;
  minLiquidityUsd: number | null;
  feedAgeMinutes:  number | null;
}

export interface RiskGateResult {
  allow:        boolean;
  blockReasons: string[];
  warnings:     string[];
  riskSnapshot: RiskSnapshot;
}

function minutesBetween(aIso: string | null, b: Date): number | null {
  if (!aIso) return null;
  const a = new Date(aIso).getTime();
  if (Number.isNaN(a)) return null;
  return (b.getTime() - a) / 60000;
}

function normCluster(v: unknown): string {
  if (typeof v !== 'string') return 'MISSING';
  const u = v.trim().toUpperCase();
  if (u === 'CLEAN' || u === 'WATCH' || u === 'RISKY' || u === 'UNKNOWN') return u;
  return 'MISSING';
}

export function evaluateLiveRiskGate(input: RiskGateInput): RiskGateResult {
  const { candidate: c, config, intendedUsd, mode } = input;
  const limits = config.limits;
  const blockReasons: string[] = [];
  const warnings: string[] = [];
  const staleMinutes = input.staleMinutes ?? DEFAULT_STALE_MINUTES;

  const cluster = normCluster(c.clusterRisk);
  const adjustedEdge = c.expectedBaselinePnl != null
    ? adjustExecutionPnl(c.expectedBaselinePnl, {
        entryMomentumPct: c.entryMomentumPct, liquidityBucket: c.liquidityBucket,
        vlrBucket: c.vlrBucket, clusterRisk: c.clusterRisk ?? undefined,
      }, EDGE_PARAMS)
    : null;
  const feedAge = minutesBetween(input.latestCycleTime, input.now);

  // ── Live-mode unlock requirement ────────────────────────────────────────────
  if (mode === 'live' && !config.liveUnlocked) {
    blockReasons.push('Live mode requires a fully unlocked live config (it is not unlocked).');
  }
  if (config.killSwitchOn) {
    blockReasons.push('Kill switch is ON — all orders blocked.');
  }
  // For live mode we require complete limits; dry-run/mock can proceed to exercise the path.
  if (mode === 'live' && !config.limitsComplete) {
    blockReasons.push('Live mode requires all real-trading limits to be set and positive.');
  }

  // ── Candidate must be currently approved by the existing gate logic ──────────
  if (c.buyGateDecision !== 'BUY_APPROVED_PAPER') {
    blockReasons.push(`Candidate is not currently approved (buyGateDecision=${c.buyGateDecision ?? 'none'}).`);
  }

  // ── Cluster risk: UNKNOWN never treated as CLEAN ─────────────────────────────
  if (cluster === 'UNKNOWN') {
    if (input.allowUnknownClusterOverride) {
      warnings.push('clusterRisk is UNKNOWN — proceeding only because an explicit override was set.');
    } else {
      blockReasons.push('clusterRisk is UNKNOWN (holder risk unresolved) — blocked. UNKNOWN is never CLEAN.');
    }
  } else if (cluster === 'RISKY') {
    blockReasons.push('clusterRisk is RISKY — blocked.');
  } else if (cluster === 'MISSING') {
    blockReasons.push('clusterRisk is MISSING — blocked (cannot confirm holder safety).');
  }

  // ── Execution-adjusted edge must not be negative ────────────────────────────
  if (adjustedEdge != null && adjustedEdge < 0) {
    blockReasons.push(`Execution-adjusted edge is negative (${adjustedEdge.toFixed(1)}%) — blocked.`);
  } else if (adjustedEdge == null) {
    warnings.push('No expected baseline P/L provided — execution-adjusted edge unknown; treat with caution.');
  }

  // ── Position sizing ─────────────────────────────────────────────────────────
  if (limits.maxPositionUsd != null && intendedUsd > limits.maxPositionUsd) {
    blockReasons.push(`Intended size $${intendedUsd} exceeds max position $${limits.maxPositionUsd}.`);
  }
  if (intendedUsd <= 0) blockReasons.push('Intended size must be positive.');

  // ── Open position / duplicate ───────────────────────────────────────────────
  if (limits.maxOpenPositions != null && input.openPositions.length >= limits.maxOpenPositions) {
    blockReasons.push(`Max open positions reached (${input.openPositions.length}/${limits.maxOpenPositions}).`);
  }
  if (input.openPositions.some(p => p.contract === c.contract)) {
    blockReasons.push(`Duplicate open position for ${c.contract} — already holding.`);
  }

  // ── Trades / loss limits ────────────────────────────────────────────────────
  if (limits.maxTradesPerDay != null && input.tradesToday >= limits.maxTradesPerDay) {
    blockReasons.push(`Max trades per day reached (${input.tradesToday}/${limits.maxTradesPerDay}).`);
  }
  if (limits.maxDailyLossUsd != null && input.dailyLoss >= limits.maxDailyLossUsd) {
    blockReasons.push(`Max daily loss reached ($${input.dailyLoss} >= $${limits.maxDailyLossUsd}).`);
  }

  // ── Liquidity ───────────────────────────────────────────────────────────────
  if (limits.minLiquidityUsd != null) {
    if (c.liquidityUsd == null) {
      blockReasons.push('Liquidity unknown — cannot confirm min liquidity; blocked.');
    } else if (c.liquidityUsd < limits.minLiquidityUsd) {
      blockReasons.push(`Liquidity $${c.liquidityUsd} below min $${limits.minLiquidityUsd}.`);
    }
  }

  // ── Feed freshness ──────────────────────────────────────────────────────────
  if (feedAge == null) {
    warnings.push('Latest cycle time unknown — cannot confirm feed freshness.');
  } else if (feedAge > staleMinutes) {
    blockReasons.push(`Feed is stale (${feedAge.toFixed(0)}m > ${staleMinutes}m) — blocked.`);
  }

  const riskSnapshot: RiskSnapshot = {
    contract: c.contract, intendedUsd, mode,
    clusterRisk: cluster, liquidityUsd: c.liquidityUsd, adjustedEdge,
    openPositions: input.openPositions.length, tradesToday: input.tradesToday, dailyLoss: input.dailyLoss,
    maxPositionUsd: limits.maxPositionUsd, maxOpenPositions: limits.maxOpenPositions,
    maxTradesPerDay: limits.maxTradesPerDay, maxDailyLossUsd: limits.maxDailyLossUsd,
    maxSlippageBps: limits.maxSlippageBps, minLiquidityUsd: limits.minLiquidityUsd,
    feedAgeMinutes: feedAge,
  };

  return { allow: blockReasons.length === 0, blockReasons, warnings, riskSnapshot };
}
