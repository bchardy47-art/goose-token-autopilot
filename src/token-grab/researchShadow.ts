// RESEARCH-SHADOW RECORDER (bankroll-independent learning stream)
//
// DO_NOT_ENABLE_REAL_TRADING  RESEARCH_ONLY=true  REAL_TRADING=false
// NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true  READY_FOR_REAL_TRADING=false
//
// PROBLEM THIS SOLVES: the $20/$50/$100 bankroll simulations stop opening would-buys once the
// daily buy cap is reached, so learning stops even though many research-worthy candidates keep
// matching the internal shadow lanes. This recorder runs ALONGSIDE the bankroll simulations and
// records a RESEARCH_WOULD_BUY for EVERY fresh candidate that matches an internal shadow lane —
// even when the bankroll risk caps blocked the normal would-buy. It has its OWN append-only event
// stream and its OWN state, and it NEVER changes bankroll behavior, gates, or risk caps.
//
// It reuses the exact same lane membership (primaryLane), the exact same exit logic (evaluateSell,
// 30m max hold, DATA_STALE_EXIT), and the exact same valuation-based realized P/L (computeRealizedPnl)
// as live-shadow. When a price cannot be valued the trade is VALUATION_UNAVAILABLE — never a fake 0.
//
// No wallet, no private keys, no signing, no swap, no real funds. This is NOT a buy signal and is
// NOT executable. It never runs the auto-paper or paper-buy commands and there is no live path.

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_RIPPER_CONFIG,
  evaluateSell,
  type RipperPaperPosition,
  type RipperSellReason,
  type LaunchAgeBucket,
  type ClusterRisk,
} from './dexRipperEngine';
import {
  primaryLane,
  computeRealizedPnl,
  type ShadowCandidate,
  type ShadowLane,
} from './liveShadow';

// ── Paths (research stream lives beside the live-shadow stream) ──────────────────────────────

export const RESEARCH_SHADOW_EVENTS_FILENAME = 'research-shadow-events.jsonl';
export const RESEARCH_SHADOW_STATE_FILENAME  = 'research-shadow-state.json';
export const DEFAULT_RESEARCH_SHADOW_EVENTS_PATH = 'data/token-grab/live-shadow/research-shadow-events.jsonl';
export const DEFAULT_RESEARCH_SHADOW_STATE_PATH  = 'data/token-grab/live-shadow/research-shadow-state.json';

/** Fixed research notional (USD) — bankroll-independent; only used to express pnl in dollars. */
export const RESEARCH_NOTIONAL_USD = 1;

/** Normalized annotation when the bankroll tier could NOT have opened this (caps reached). */
export const BANKROLL_CAP_REACHED = 'BANKROLL_CAP_REACHED';

// ── Safety flags ────────────────────────────────────────────────────────────────────────────

export interface ResearchSafetyFlags {
  paperOnly: true;
  researchOnly: true;
  realTrading: false;
  noWallet: true;
  noSwap: true;
  noSigning: true;
}

export function researchSafetyFlags(): ResearchSafetyFlags {
  return { paperOnly: true, researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true };
}

// ── Position ──────────────────────────────────────────────────────────────────────────────

export interface ResearchShadowPosition {
  contract: string;
  symbol?: string;
  lane: ShadowLane;
  sourceCycle: string;
  openedAt: string;
  // Entry-time descriptors (carried for report splits).
  m5Band: string;
  liquidityBucket: string;
  vlrBucket: string;
  ripperScoreBand: string;
  ripperScore: number;
  launchAgeBucket: LaunchAgeBucket;
  clusterRisk: ClusterRisk;              // verbatim — UNKNOWN stays UNKNOWN
  productionGateApproved: boolean;       // reported, never blocking
  bankrollBlockedReason?: string;        // e.g. BANKROLL_CAP_REACHED when the bankroll tier was capped
  // Simulation bookkeeping (identical to live-shadow).
  entryMomentumPct?: number | null;
  entryPriceChangePct?: number;
  entryLiquidityChangePct?: number;
  entryVlr?: number;
  positionSizeUsd: number;
  peakPriceChangePct?: number;
  // Real absolute valuation (basis for realized P/L).
  entryValuation?: number | null;
  valuationField?: string | null;
  // Close fields.
  status: 'OPEN' | 'CLOSED';
  closedAt?: string;
  exitReason?: RipperSellReason;
  exitValuation?: number | null;
  valuationUsable?: boolean;
  valuationStatus?: 'OK' | 'VALUATION_UNAVAILABLE';
  valuationMissing?: string[];
  pnlPct?: number | null;                // null when valuation unavailable (NEVER a fake 0)
  pnlUsd?: number | null;
  holdMinutes?: number;
}

// ── Events (append-only) ─────────────────────────────────────────────────────────────────────

export interface ResearchWouldBuyEvent extends ResearchSafetyFlags {
  type: 'RESEARCH_WOULD_BUY';
  ts: string;
  contract: string;
  symbol?: string;
  lane: ShadowLane;
  m5Band: string;
  liquidityBucket: string;
  vlrBucket: string;
  ripperScoreBand: string;
  ripperScore: number;
  productionGateApproved: boolean;
  clusterRisk: ClusterRisk;
  sourceCycle: string;
  entryValuation: number | null;
  valuationField: string | null;
  entryMomentumPct: number | null;
  entryLiquidityChangePct: number | null;
  entryVlr: number | null;
  launchAgeBucket: LaunchAgeBucket;
  bankrollBlockedReason?: string;        // present only when the bankroll tier was capped
  notBuySignal: true;
}

export interface ResearchWouldSellEvent extends ResearchSafetyFlags {
  type: 'RESEARCH_WOULD_SELL';
  ts: string;
  contract: string;
  symbol?: string;
  lane: ShadowLane;
  sourceCycle: string;
  exitReason: RipperSellReason;
  note: string;
  entryValuation: number | null;
  exitValuation: number | null;
  valuationField: string | null;
  valuationUsable: boolean;
  valuationStatus: 'OK' | 'VALUATION_UNAVAILABLE';
  valuationMissing: string[];
  pnlPct: number | null;                 // null → VALUATION_UNAVAILABLE (never a fake 0)
  pnlUsd: number | null;
  holdMinutes: number;
  productionGateApproved: boolean;
  launchAgeBucket: LaunchAgeBucket;
  notBuySignal: true;
}

export type ResearchShadowEvent = ResearchWouldBuyEvent | ResearchWouldSellEvent;

// ── State ────────────────────────────────────────────────────────────────────────────────

export interface ResearchShadowState {
  sessionId: string;
  startedAt: string;
  lastCycleAt: string | null;
  cycleCount: number;
  openPositions: ResearchShadowPosition[];
  closedPositions: ResearchShadowPosition[];
  recordedBuyKeys: string[];             // dedup keys: `${contract}|${lane}|${sourceCycle}`
  totalResearchBuys: number;
  totalResearchSells: number;
  researchOnly: true;
  realTrading: false;
  noWallet: true;
  noSwap: true;
  noSigning: true;
  tradingExecuted: 0;
}

function makeEmptyResearchState(nowIso: string): ResearchShadowState {
  return {
    sessionId: `research-shadow-${nowIso.slice(0, 10)}`,
    startedAt: nowIso,
    lastCycleAt: null,
    cycleCount: 0,
    openPositions: [],
    closedPositions: [],
    recordedBuyKeys: [],
    totalResearchBuys: 0,
    totalResearchSells: 0,
    researchOnly: true,
    realTrading: false,
    noWallet: true,
    noSwap: true,
    noSigning: true,
    tradingExecuted: 0,
  };
}

export function loadOrCreateResearchShadowState(statePath: string, nowIso: string): ResearchShadowState {
  if (fs.existsSync(statePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Partial<ResearchShadowState>;
      return {
        ...makeEmptyResearchState(nowIso),
        ...parsed,
        openPositions: parsed.openPositions ?? [],
        closedPositions: parsed.closedPositions ?? [],
        recordedBuyKeys: parsed.recordedBuyKeys ?? [],
        // Always enforce safety constants regardless of what is on disk.
        researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true, tradingExecuted: 0,
      };
    } catch {
      // Corrupted state — start fresh.
    }
  }
  return makeEmptyResearchState(nowIso);
}

export function saveResearchShadowState(state: ResearchShadowState, statePath: string): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function appendResearchShadowEvents(events: ResearchShadowEvent[], eventsPath: string): void {
  if (events.length === 0) return;
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.appendFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

// ── Recorder ────────────────────────────────────────────────────────────────────────────────

export interface RecordResearchShadowOptions {
  candidates: ShadowCandidate[];
  sourceCycle: string;
  nowMs: number;
  statePath: string;
  eventsPath: string;
  /** Contracts the bankroll tier could NOT open due to risk caps (annotated BANKROLL_CAP_REACHED). */
  bankrollBlockedContracts?: Set<string>;
  /** Research notional in USD (default RESEARCH_NOTIONAL_USD). */
  positionSizeUsd?: number;
}

export interface RecordResearchShadowResult extends ResearchSafetyFlags {
  ts: string;
  sourceCycle: string;
  researchBuys: number;
  researchSells: number;
  openPositions: number;
  eventsWritten: ResearchShadowEvent[];
  state: ResearchShadowState;
  readyForRealTrading: false;
}

/**
 * Record a research cycle: close any open research positions whose exit fires (same evaluateSell /
 * 30m max-hold / DATA_STALE_EXIT logic as live-shadow), then open a research position for EVERY
 * fresh candidate that matches an internal shadow lane — regardless of bankroll caps. Deduplicated
 * by contract+lane+sourceCycle so repeated cron runs never spam duplicates.
 */
export function recordResearchShadow(options: RecordResearchShadowOptions): RecordResearchShadowResult {
  const nowMs  = options.nowMs;
  const nowIso = new Date(nowMs).toISOString();
  const config = DEFAULT_RIPPER_CONFIG;
  const positionSizeUsd = options.positionSizeUsd ?? RESEARCH_NOTIONAL_USD;
  const blocked = options.bankrollBlockedContracts ?? new Set<string>();

  const state = loadOrCreateResearchShadowState(options.statePath, nowIso);
  const candidates = options.candidates;
  const sourceCycle = options.sourceCycle;

  const signalByContract    = new Map(candidates.map(c => [c.contract, c.signal]));
  const candidateByContract = new Map(candidates.map(c => [c.contract, c]));

  const events: ResearchShadowEvent[] = [];

  // ── EXITS (independent of bankroll) — same logic as live-shadow ──
  const stillOpen: ResearchShadowPosition[] = [];
  let researchSells = 0;
  for (const pos of state.openPositions) {
    const currentSignal = signalByContract.get(pos.contract) ?? null;
    const asRipperPos: RipperPaperPosition = {
      contract: pos.contract,
      symbol: pos.symbol,
      openedAt: pos.openedAt,
      entryPriceChangePct: pos.entryPriceChangePct,
      entryLiquidityChangePct: pos.entryLiquidityChangePct,
      entryVlr: pos.entryVlr,
      entryRipperScore: pos.ripperScore,
      positionSizeUsd: pos.positionSizeUsd,
      peakPriceChangePct: pos.peakPriceChangePct,
      status: 'OPEN',
    };
    const sell = evaluateSell(asRipperPos, currentSignal, config, nowMs);

    if (sell.shouldSell) {
      const currentCandidate = candidateByContract.get(pos.contract) ?? null;
      // Realized P/L from REAL valuations — VALUATION_UNAVAILABLE (null) if a price is missing.
      const pnl = computeRealizedPnl(pos, currentCandidate);
      const holdMinutes = (nowMs - new Date(pos.openedAt).getTime()) / 60000;

      const closed: ResearchShadowPosition = {
        ...pos,
        status: 'CLOSED',
        closedAt: nowIso,
        exitReason: sell.reason,
        exitValuation: pnl.exitValuation,
        valuationUsable: pnl.usable,
        valuationStatus: pnl.status,
        valuationMissing: pnl.missing,
        pnlPct: pnl.pnlPct,
        pnlUsd: pnl.pnlUsd,
        holdMinutes,
      };
      state.closedPositions.unshift(closed);
      state.totalResearchSells += 1;
      researchSells += 1;

      events.push({
        type: 'RESEARCH_WOULD_SELL', ts: nowIso, contract: pos.contract, symbol: pos.symbol,
        lane: pos.lane, sourceCycle: pos.sourceCycle,
        exitReason: sell.reason!, note: sell.note,
        entryValuation: pos.entryValuation ?? null, exitValuation: pnl.exitValuation,
        valuationField: pos.valuationField ?? null, valuationUsable: pnl.usable,
        valuationStatus: pnl.status, valuationMissing: pnl.missing,
        pnlPct: pnl.pnlPct, pnlUsd: pnl.pnlUsd, holdMinutes,
        productionGateApproved: pos.productionGateApproved, launchAgeBucket: pos.launchAgeBucket,
        notBuySignal: true, ...researchSafetyFlags(),
      });
    } else {
      const currentPct = currentSignal?.priceChangePct;
      if (currentPct != null && (pos.peakPriceChangePct == null || currentPct > pos.peakPriceChangePct)) {
        pos.peakPriceChangePct = currentPct;
      }
      stillOpen.push(pos);
    }
  }
  state.openPositions = stillOpen;

  // ── ENTRIES — every lane match recorded, independent of bankroll caps ──
  const recordedKeys = new Set(state.recordedBuyKeys);
  const openByContractLane = new Set(state.openPositions.map(p => `${p.contract}|${p.lane}`));
  let researchBuys = 0;

  for (const c of candidates) {
    const lane = primaryLane(c);
    if (lane == null) continue;                    // no shadow lane matched → not a research buy

    const key = `${c.contract}|${lane}|${sourceCycle}`;
    if (recordedKeys.has(key)) continue;           // dedup: contract+lane+sourceCycle already recorded

    // Never hold two identical (contract,lane) research positions at once; still mark the key seen
    // so repeated runs stay idempotent.
    if (openByContractLane.has(`${c.contract}|${lane}`)) {
      recordedKeys.add(key);
      state.recordedBuyKeys.push(key);
      continue;
    }

    const bankrollBlockedReason = blocked.has(c.contract) ? BANKROLL_CAP_REACHED : undefined;

    const pos: ResearchShadowPosition = {
      contract: c.contract,
      symbol: c.symbol ?? undefined,
      lane,
      sourceCycle,
      openedAt: nowIso,
      m5Band: c.m5Band,
      liquidityBucket: c.liquidityBucket,
      vlrBucket: c.vlrBucket,
      ripperScoreBand: c.ripperScoreBand,
      ripperScore: c.ripperScore,
      launchAgeBucket: c.launchAgeBucket,
      clusterRisk: c.clusterRisk,                  // verbatim — UNKNOWN stays UNKNOWN
      productionGateApproved: c.productionGateApproved,
      bankrollBlockedReason,
      entryMomentumPct: c.entryMomentumPct,
      entryPriceChangePct: c.priceChangePct ?? undefined,
      entryLiquidityChangePct: c.liquidityChangePct ?? undefined,
      entryVlr: c.volumeLiquidityRatio ?? undefined,
      positionSizeUsd,
      peakPriceChangePct: c.priceChangePct ?? undefined,
      entryValuation: c.valuation,
      valuationField: c.valuationField,
      status: 'OPEN',
    };
    state.openPositions.push(pos);
    openByContractLane.add(`${c.contract}|${lane}`);
    recordedKeys.add(key);
    state.recordedBuyKeys.push(key);
    state.totalResearchBuys += 1;
    researchBuys += 1;

    events.push({
      type: 'RESEARCH_WOULD_BUY', ts: nowIso, contract: c.contract, symbol: c.symbol ?? undefined,
      lane, m5Band: c.m5Band, liquidityBucket: c.liquidityBucket, vlrBucket: c.vlrBucket,
      ripperScoreBand: c.ripperScoreBand, ripperScore: c.ripperScore,
      productionGateApproved: c.productionGateApproved, clusterRisk: c.clusterRisk, sourceCycle,
      entryValuation: c.valuation, valuationField: c.valuationField,
      entryMomentumPct: c.entryMomentumPct ?? null,
      entryLiquidityChangePct: c.liquidityChangePct ?? null,
      entryVlr: c.volumeLiquidityRatio ?? null,
      launchAgeBucket: c.launchAgeBucket, bankrollBlockedReason,
      notBuySignal: true, ...researchSafetyFlags(),
    });
  }

  state.cycleCount += 1;
  state.lastCycleAt = nowIso;
  saveResearchShadowState(state, options.statePath);
  appendResearchShadowEvents(events, options.eventsPath);

  return {
    ts: nowIso, sourceCycle, researchBuys, researchSells,
    openPositions: state.openPositions.length, eventsWritten: events, state,
    readyForRealTrading: false, ...researchSafetyFlags(),
  };
}
