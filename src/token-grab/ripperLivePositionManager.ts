// DO_NOT_ENABLE_REAL_TRADING_BY_DEFAULT  exitsRunBeforeEntries=true
//
// Live Position Manager v1 — recovers open real positions from the ledger, prices them
// (via injected pricer), evaluates exit triggers (stop-loss / take-profit / trailing /
// max-hold / kill-switch / liquidity-collapse / cluster-deterioration / manual / stale
// price), builds exit (sell) orders, and closes positions. Every exit writes ledger
// events. A live SELL refuses without unlock + signer (delegated to the adapter).
//
// Pure logic where possible; the actual sell submit is delegated to the execution
// adapter, which enforces the unlock/signer rules. This module never holds keys.

import type { ExecutionAdapter, NormalizedQuote, BuiltTransaction, TransactionSigner, SubmitResult } from './ripperRealExecutionAdapter';
import { SOL_MINT } from './ripperRealExecutionAdapter';
import type { OpenPosition, LedgerEvent } from './ripperRealTradingLedger';
import { recoverTradingState } from './ripperRealTradingLedger';

export interface ExitPolicy {
  stopLossPct:        number;   // e.g. -30 → exit at -30%
  takeProfitPct:      number;   // e.g. +50 → exit at +50%
  trailingStopPct:    number | null;  // e.g. 20 → exit if price falls 20% from peak
  maxHoldMinutes:     number;
  minLiquidityUsd:    number | null;  // exit if liquidity collapses below this
}

export const DEFAULT_EXIT_POLICY: ExitPolicy = {
  stopLossPct: -30, takeProfitPct: 50, trailingStopPct: 25, maxHoldMinutes: 60, minLiquidityUsd: 5000,
};

export type ExitTrigger =
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'TRAILING_STOP'
  | 'MAX_HOLD'
  | 'KILL_SWITCH'
  | 'LIQUIDITY_COLLAPSE'
  | 'CLUSTER_RISK_DETERIORATION'
  | 'MANUAL_CLOSE'
  | 'STALE_PRICE'
  | 'NONE';

export interface PositionPricing {
  contract:     string;
  currentPrice: number | null;
  peakPrice:    number | null;   // highest observed since open (for trailing)
  liquidityUsd: number | null;
  clusterRisk:  string | null;
  pricedAt:     string;
  stale:        boolean;
}

export interface ExitEvaluation {
  contract:    string;
  trigger:     ExitTrigger;
  shouldExit:  boolean;
  reason:      string;
  pnlPct:      number | null;
  warnings:    string[];
}

// ── Recover ──────────────────────────────────────────────────────────────────────

export function recoverOpenPositions(events: LedgerEvent[]): OpenPosition[] {
  return recoverTradingState(events).open;
}

// ── Price (delegated) ──────────────────────────────────────────────────────────────

export interface Pricer {
  // Returns current price (USD) + liquidity + cluster for a contract, or nulls if stale.
  price(contract: string): Promise<{ price: number | null; liquidityUsd: number | null; clusterRisk: string | null }>;
}

export async function priceOpenPositions(
  positions: OpenPosition[],
  pricer: Pricer,
  now: Date,
  peaks: Map<string, number> = new Map(),
): Promise<PositionPricing[]> {
  const out: PositionPricing[] = [];
  for (const p of positions) {
    let priced;
    try { priced = await pricer.price(p.contract); }
    catch { priced = { price: null, liquidityUsd: null, clusterRisk: null }; }
    const stale = priced.price == null;
    const prevPeak = peaks.get(p.contract) ?? p.entryPrice ?? null;
    const peak = priced.price != null ? Math.max(prevPeak ?? priced.price, priced.price) : prevPeak;
    if (peak != null) peaks.set(p.contract, peak);
    out.push({
      contract: p.contract, currentPrice: priced.price, peakPrice: peak,
      liquidityUsd: priced.liquidityUsd, clusterRisk: priced.clusterRisk,
      pricedAt: now.toISOString(), stale,
    });
  }
  return out;
}

// ── Evaluate exit ──────────────────────────────────────────────────────────────────

export interface EvaluateExitInput {
  position:     OpenPosition;
  pricing:      PositionPricing;
  policy:       ExitPolicy;
  now:          Date;
  killSwitchOn: boolean;
  manualClose?: boolean;
}

export function evaluateExit(input: EvaluateExitInput): ExitEvaluation {
  const { position: pos, pricing: pr, policy, now } = input;
  const warnings: string[] = [];

  // Kill switch wins immediately.
  if (input.killSwitchOn) {
    return mk(pos.contract, 'KILL_SWITCH', true, 'Kill switch ON — force exit.', pnl(pos, pr), warnings);
  }
  if (input.manualClose) {
    return mk(pos.contract, 'MANUAL_CLOSE', true, 'Manual close requested.', pnl(pos, pr), warnings);
  }
  // Stale price → cannot value; recommend exit attempt (degrade safely) with a warning.
  if (pr.stale || pr.currentPrice == null) {
    warnings.push('Price is stale/unavailable.');
    return mk(pos.contract, 'STALE_PRICE', true, 'Stale/unavailable price — exit to avoid blind hold.', null, warnings);
  }
  // Liquidity collapse.
  if (policy.minLiquidityUsd != null && pr.liquidityUsd != null && pr.liquidityUsd < policy.minLiquidityUsd) {
    return mk(pos.contract, 'LIQUIDITY_COLLAPSE', true,
      `Liquidity $${pr.liquidityUsd} < floor $${policy.minLiquidityUsd}.`, pnl(pos, pr), warnings);
  }
  // Cluster risk deterioration → RISKY now.
  const cl = (pr.clusterRisk ?? '').toUpperCase();
  if (cl === 'RISKY') {
    return mk(pos.contract, 'CLUSTER_RISK_DETERIORATION', true, 'Cluster risk deteriorated to RISKY.', pnl(pos, pr), warnings);
  }

  const pnlPct = pnl(pos, pr);

  // Take profit.
  if (pnlPct != null && pnlPct >= policy.takeProfitPct) {
    return mk(pos.contract, 'TAKE_PROFIT', true, `P/L ${pnlPct.toFixed(1)}% >= TP ${policy.takeProfitPct}%.`, pnlPct, warnings);
  }
  // Stop loss.
  if (pnlPct != null && pnlPct <= policy.stopLossPct) {
    return mk(pos.contract, 'STOP_LOSS', true, `P/L ${pnlPct.toFixed(1)}% <= SL ${policy.stopLossPct}%.`, pnlPct, warnings);
  }
  // Trailing stop (from peak).
  if (policy.trailingStopPct != null && pr.peakPrice != null && pr.currentPrice != null && pr.peakPrice > 0) {
    const dropFromPeak = ((pr.peakPrice - pr.currentPrice) / pr.peakPrice) * 100;
    if (dropFromPeak >= policy.trailingStopPct) {
      return mk(pos.contract, 'TRAILING_STOP', true,
        `Dropped ${dropFromPeak.toFixed(1)}% from peak >= trail ${policy.trailingStopPct}%.`, pnlPct, warnings);
    }
  }
  // Max hold.
  const heldMin = (now.getTime() - new Date(pos.openedAt).getTime()) / 60000;
  if (heldMin >= policy.maxHoldMinutes) {
    return mk(pos.contract, 'MAX_HOLD', true, `Held ${heldMin.toFixed(0)}m >= max ${policy.maxHoldMinutes}m.`, pnlPct, warnings);
  }

  return mk(pos.contract, 'NONE', false, 'No exit trigger met.', pnlPct, warnings);
}

function pnl(pos: OpenPosition, pr: PositionPricing): number | null {
  if (pos.entryPrice == null || pos.entryPrice <= 0 || pr.currentPrice == null) return null;
  return ((pr.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
}
function mk(contract: string, trigger: ExitTrigger, shouldExit: boolean, reason: string, pnlPct: number | null, warnings: string[]): ExitEvaluation {
  return { contract, trigger, shouldExit, reason, pnlPct, warnings };
}

// ── Build exit (sell) order ─────────────────────────────────────────────────────────

export interface BuildExitInput {
  adapter:       ExecutionAdapter;
  position:      OpenPosition;
  outputMint?:   string;   // default: back to SOL
  slippageBps:   number;
  userPublicKey: string;
}

export async function buildExitOrder(input: BuildExitInput): Promise<{ quote: NormalizedQuote; built: BuiltTransaction }> {
  const tokenAmount = input.position.tokenAmount;
  if (tokenAmount == null || tokenAmount <= 0) {
    throw new Error('Cannot build exit: position has no token amount.');
  }
  // Sell = swap token → SOL.
  const quote = await input.adapter.getQuote({
    inputMint: input.position.contract,
    outputMint: input.outputMint ?? SOL_MINT,
    amountRaw: Math.floor(tokenAmount).toString(),
    slippageBps: input.slippageBps,
  });
  const built = await input.adapter.buildSell({ quote, userPublicKey: input.userPublicKey });
  return { quote, built };
}

// ── Close (submit sell) — delegated to adapter (refuses without unlock + signer) ──────

export interface ClosePositionInput {
  adapter:      ExecutionAdapter;
  built:        BuiltTransaction;
  liveUnlocked: boolean;
  signer:       TransactionSigner | null;
  rpcUrl:       string | null;
}

export async function closePosition(input: ClosePositionInput): Promise<SubmitResult> {
  // The adapter enforces: dry-run never submits; live refuses without unlock + signer.
  return input.adapter.submitTransaction({
    built: input.built,
    liveUnlocked: input.liveUnlocked,
    signer: input.signer,
    rpcUrl: input.rpcUrl ?? undefined,
  });
}

// ── Heartbeat summary ─────────────────────────────────────────────────────────────

export interface HeartbeatRow {
  contract:   string;
  symbol:     string | null;
  pnlPct:     number | null;
  trigger:    ExitTrigger;
  shouldExit: boolean;
}

export function heartbeatPositions(
  positions: OpenPosition[],
  pricings: PositionPricing[],
  policy: ExitPolicy,
  now: Date,
  killSwitchOn: boolean,
): HeartbeatRow[] {
  const byContract = new Map(pricings.map(p => [p.contract, p]));
  return positions.map(pos => {
    const pr = byContract.get(pos.contract);
    if (!pr) return { contract: pos.contract, symbol: pos.symbol, pnlPct: null, trigger: 'STALE_PRICE' as ExitTrigger, shouldExit: true };
    const ev = evaluateExit({ position: pos, pricing: pr, policy, now, killSwitchOn });
    return { contract: pos.contract, symbol: pos.symbol, pnlPct: ev.pnlPct, trigger: ev.trigger, shouldExit: ev.shouldExit };
  });
}
