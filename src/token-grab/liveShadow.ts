// LIVE-SHADOW EXECUTION MODE (constant-learning shadow engine)
//
// DO_NOT_ENABLE_REAL_TRADING  LIVE_SHADOW_ONLY=true  REAL_TRADING=false
// NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true
//
// Simulates real autonomous research decisions in real time. By DEFAULT it reads the LATEST
// FRESH ripper cycle (data/token-grab/ripper/cycles/cycle-*.jsonl) — NOT the stale legacy
// dex-winner-candidates-today.json file (which is now an explicit legacy/debug option only).
//
// WOULD_BUY decisions are made by paper-only INTERNAL RESEARCH lanes (NO_BM_INTERNAL_BROAD /
// NO_BM_BEST_VLR / NO_BM_PULLBACK) that reuse the entry-time NO_BM_RESEARCH membership logic —
// NOT the production buy gate. The production buy gate outcome is still reported separately as
// `productionGateApproved`, but it never blocks a shadow-only research decision.
//
// Source freshness is enforced: if the newest cycle is older than the freshness window the
// whole cycle is SKIPPED with STALE_SOURCE and NO would-buy events are created.
//
// No wallet, no private keys, no signing, no swap execution, no real funds are ever touched.
// This module never calls token:auto-paper or token:paper-buy, and there is no live-execution
// flag. UNKNOWN risk labels (holderRisk, clusterRisk, botRisk) are carried through verbatim and
// are NEVER upgraded to CLEAN here.

import * as fs from 'fs';
import * as path from 'path';
import {
  scoreRipper,
  checkPaperBuyGate,
  evaluateSell,
  DEFAULT_RIPPER_CONFIG,
  type RipperSignal,
  type RipperPaperPosition,
  type RipperSellReason,
  type RipperEntryDecision,
  type LaunchAgeBucket,
  type LiquidityQuality,
  type HolderRisk,
  type ClusterRisk,
  type BotRisk,
} from './dexRipperEngine';
import { loadCandidates, winnerCandidateToRipperInput } from './dexRipperSession';
import { bucketLiquidity, bucketVlr } from './ripperLearningMemory';
import { m5BandLabel } from './ripperSubgroupWatch';
import { ripperScoreBand } from './ripperNoBmQualityReport';
import { findLatestRawCycleFile } from './ripperWatchRawCycle';
import { NO_BM_RESEARCH_MIN_SCORE } from './ripperWatchCohortFamily';
import {
  recordResearchShadow,
  RESEARCH_SHADOW_EVENTS_FILENAME,
  RESEARCH_SHADOW_STATE_FILENAME,
  type RecordResearchShadowResult,
} from './researchShadow';

// ── Safety constants ──────────────────────────────────────────────────────────────────────

export const LIVE_SHADOW_ONLY = true;
export const REAL_TRADING = false;
export const NO_WALLET = true;
export const NO_SWAP = true;
export const NO_SIGNING = true;
export const READY_FOR_REAL_TRADING = false;

// ── Default paths (live-shadow writes ONLY under its own directory) ──────────────────────────

/** DEFAULT source: latest fresh ripper cycle is discovered inside this directory. */
export const DEFAULT_LIVE_SHADOW_CYCLES_DIR  = 'data/token-grab/ripper/cycles';
/** LEGACY/DEBUG source only — no longer the default. Kept for `--legacy-feed`. */
export const DEFAULT_LIVE_SHADOW_FEED_PATH   = 'data/token-grab/legitimacy/dex-winner-candidates-today.json';
export const DEFAULT_LIVE_SHADOW_STATE_PATH  = 'data/token-grab/live-shadow/live-shadow-state.json';
export const DEFAULT_LIVE_SHADOW_EVENTS_PATH = 'data/token-grab/live-shadow/live-shadow-events.jsonl';
export const DEFAULT_LIVE_SHADOW_DIAGNOSTICS_PATH = 'data/token-grab/live-shadow/live-shadow-diagnostics.jsonl';

/** A source older than this many minutes is STALE — the cycle is skipped, no would-buy events. */
export const DEFAULT_MAX_SOURCE_AGE_MINUTES = 15;

// ── Internal shadow research lanes (paper-only; entry-time signals only) ─────────────────────
//
// These reuse the entry-time NO_BM_RESEARCH membership logic (m5 band / liquidity bucket / vlr
// bucket / ripper score) — cluster/holder/bot risk are recorded verbatim but NEVER used to
// approve. UNKNOWN stays UNKNOWN.

const LIQ_NEAR  = new Set(['LIQ_10K_30K', 'LIQ_30K_100K']);   // "liquidity near" — matches NO_BM_RESEARCH
const M5_FAMILY = new Set(['-20 to -5', '-5 to +5']);          // momentum family
const BEST_SUBGROUP_VLR = 'VLR_0_5_TO_2';                      // strongest VLR subgroup (NO_BM quality report)
const PULLBACK_M5_BAND  = '-20 to -5';                          // pullback band

export type ShadowLane = 'NO_BM_INTERNAL_BROAD' | 'NO_BM_BEST_VLR' | 'NO_BM_PULLBACK';

// ── Normalized reject-reason buckets (never per-minute strings) ──────────────────────────────

export const REJECT_DEAD_WINDOW_TOO_OLD = 'DEAD_WINDOW_TOO_OLD';
export const REJECT_STALE_SOURCE        = 'STALE_SOURCE';
export const REJECT_SCORE_BELOW_FLOOR   = 'SCORE_BELOW_FLOOR';
export const REJECT_M5_OUTSIDE_LANE     = 'M5_OUTSIDE_LANE';
export const REJECT_LIQUIDITY_OUTSIDE_LANE = 'LIQUIDITY_OUTSIDE_LANE';
export const REJECT_VLR_OUTSIDE_LANE    = 'VLR_OUTSIDE_LANE';
export const REJECT_DUPLICATE_OPEN      = 'DUPLICATE_OPEN_SHADOW_POSITION';
export const REJECT_RISK_LIMIT          = 'RISK_LIMIT';

// ── Bankroll tiers ────────────────────────────────────────────────────────────────────────

export const BANKROLL_TIERS = [20, 50, 100] as const;
export type BankrollTier = (typeof BANKROLL_TIERS)[number];

export interface RiskLimitConfig {
  maxPositionSizeUsd: number;
  maxDailyBuys: number;
  maxDailyLossUsd: number;
  openPositionCap: number;
}

export const DEFAULT_RISK_LIMITS: Record<BankrollTier, RiskLimitConfig> = {
  20:  { maxPositionSizeUsd: 2,  maxDailyBuys: 4, maxDailyLossUsd: 4,  openPositionCap: 2 },
  50:  { maxPositionSizeUsd: 5,  maxDailyBuys: 5, maxDailyLossUsd: 10, openPositionCap: 3 },
  100: { maxPositionSizeUsd: 10, maxDailyBuys: 6, maxDailyLossUsd: 20, openPositionCap: 4 },
};

// ── Risk labels (UNKNOWN stays UNKNOWN — never upgraded to CLEAN) ───────────────────────────

export interface LiveShadowRiskLabels {
  ripperScore: number;
  launchAgeBucket: LaunchAgeBucket;
  liquidityQuality: LiquidityQuality;
  holderRisk: HolderRisk;
  clusterRisk: ClusterRisk;
  botRisk: BotRisk;
}

// ── Simulated position ────────────────────────────────────────────────────────────────────

export interface LiveShadowPosition {
  contract: string;
  symbol?: string;
  bankroll: BankrollTier;
  openedAt: string;
  lane: ShadowLane;
  sourceCycle: string;
  entryPriceChangePct?: number;
  entryLiquidityChangePct?: number;
  entryVlr?: number;
  entryRipperScore: number;
  positionSizeUsd: number;
  peakPriceChangePct?: number;
  // Real absolute entry valuation (e.g. priceUsd) — the basis for realized P/L.
  entryValuation?: number | null;
  valuationField?: string | null;
  riskLabels: LiveShadowRiskLabels;
  status: 'OPEN' | 'CLOSED';
  closedAt?: string;
  exitReason?: RipperSellReason;
  exitPriceChangePct?: number;
  exitValuation?: number | null;
  valuationUsable?: boolean;              // true only when P/L came from real entry+exit valuations
  valuationStatus?: 'OK' | 'VALUATION_UNAVAILABLE';
  valuationMissing?: string[];           // which valuation inputs were missing (when unusable)
  pnlPct?: number | null;                // null when valuation unavailable (NOT a fake 0)
  pnlUsd?: number | null;
  holdMinutes?: number;
}

// ── Events (appended to the live-shadow jsonl file only) ────────────────────────────────────

export interface LiveShadowSafetyFlags {
  liveShadowOnly: true;
  realTrading: false;
  noWallet: true;
  noSwap: true;
  noSigning: true;
  simulated: true;
}

function safetyFlags(): LiveShadowSafetyFlags {
  return { liveShadowOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true, simulated: true };
}

export interface LiveShadowWouldBuyEvent extends LiveShadowSafetyFlags {
  type: 'WOULD_BUY';
  ts: string;
  bankroll: BankrollTier;
  contract: string;
  symbol?: string;
  // Required shadow-research fields.
  lane: ShadowLane;
  m5Band: string;
  liquidityBucket: string;
  vlrBucket: string;
  ripperScoreBand: string;
  clusterRisk: ClusterRisk;   // verbatim — UNKNOWN stays UNKNOWN
  sourceCycle: string;
  paperOnly: true;
  liveShadowOnly: true;
  realTrading: false;
  notBuySignal: true;
  // Real absolute entry valuation (basis for realized P/L on exit).
  entryValuation: number | null;
  valuationField: string | null;   // e.g. 'priceUsd'; null when no valuation field was captured
  // Simulation bookkeeping.
  entryPriceChangePct?: number;
  entryLiquidityChangePct?: number;
  entryVlr?: number;
  positionSizeUsd: number;
  ripperScore: number;
  productionGateApproved: boolean;   // reported, never blocking
  riskLabels: LiveShadowRiskLabels;
  topReasons: string[];
}

export interface LiveShadowWouldSellEvent extends LiveShadowSafetyFlags {
  type: 'WOULD_SELL';
  ts: string;
  bankroll: BankrollTier;
  contract: string;
  symbol?: string;
  lane: ShadowLane;
  sourceCycle: string;
  exitReason: RipperSellReason;
  note: string;
  entryPriceChangePct?: number;
  exitPriceChangePct?: number;
  // Real valuation-based realized P/L. null (with VALUATION_UNAVAILABLE) — never a fake 0.
  entryValuation: number | null;
  exitValuation: number | null;
  valuationField: string | null;
  valuationUsable: boolean;
  valuationStatus: 'OK' | 'VALUATION_UNAVAILABLE';
  valuationMissing: string[];
  pnlPct: number | null;
  pnlUsd: number | null;
  holdMinutes: number;
  paperOnly: true;
  notBuySignal: true;
}

export type LiveShadowEvent = LiveShadowWouldBuyEvent | LiveShadowWouldSellEvent;

// ── Session state (persisted; only bankroll-tracking numbers, no wallet data) ───────────────

export interface LiveShadowBankrollState {
  bankroll: BankrollTier;
  openPositions: LiveShadowPosition[];
  closedPositions: LiveShadowPosition[];
  totalWouldBuys: number;
  totalWouldSells: number;
  dailyBuyCount: number;
  dailyLossUsd: number;
  dailyResetDate: string;
  killSwitchActive: boolean;
  killSwitchReason?: string;
  skippedByRiskLimit: number;
}

export interface LiveShadowState {
  sessionId: string;
  startedAt: string;
  lastCycleAt: string | null;
  cycleCount: number;
  bankrolls: Record<BankrollTier, LiveShadowBankrollState>;
  liveShadowOnly: true;
  realTrading: false;
  noWallet: true;
  noSwap: true;
  noSigning: true;
  tradingExecuted: 0;
}

function todayStr(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function makeEmptyBankrollState(tier: BankrollTier, today: string): LiveShadowBankrollState {
  return {
    bankroll: tier,
    openPositions: [],
    closedPositions: [],
    totalWouldBuys: 0,
    totalWouldSells: 0,
    dailyBuyCount: 0,
    dailyLossUsd: 0,
    dailyResetDate: today,
    killSwitchActive: false,
    skippedByRiskLimit: 0,
  };
}

function makeEmptyState(nowIso: string): LiveShadowState {
  const today = todayStr(new Date(nowIso).getTime());
  const bankrolls = {} as Record<BankrollTier, LiveShadowBankrollState>;
  for (const tier of BANKROLL_TIERS) bankrolls[tier] = makeEmptyBankrollState(tier, today);
  return {
    sessionId: `live-shadow-${nowIso.slice(0, 10)}`,
    startedAt: nowIso,
    lastCycleAt: null,
    cycleCount: 0,
    bankrolls,
    liveShadowOnly: true,
    realTrading: false,
    noWallet: true,
    noSwap: true,
    noSigning: true,
    tradingExecuted: 0,
  };
}

export function loadOrCreateLiveShadowState(statePath: string, nowIso: string): LiveShadowState {
  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, 'utf-8');
      const parsed = JSON.parse(raw) as LiveShadowState;
      for (const tier of BANKROLL_TIERS) {
        if (!parsed.bankrolls?.[tier]) {
          parsed.bankrolls = parsed.bankrolls ?? ({} as Record<BankrollTier, LiveShadowBankrollState>);
          parsed.bankrolls[tier] = makeEmptyBankrollState(tier, todayStr(new Date(nowIso).getTime()));
        }
      }
      // Always enforce safety constants regardless of what is on disk.
      return {
        ...parsed,
        liveShadowOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true, tradingExecuted: 0,
      };
    } catch {
      // Corrupted state — start fresh.
    }
  }
  return makeEmptyState(nowIso);
}

export function saveLiveShadowState(state: LiveShadowState, statePath: string): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function appendLiveShadowEvents(events: LiveShadowEvent[], eventsPath: string): void {
  if (events.length === 0) return;
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(eventsPath, lines, 'utf-8');
}

function resetDailyIfNeeded(bs: LiveShadowBankrollState, today: string): void {
  if (bs.dailyResetDate !== today) {
    bs.dailyResetDate = today;
    bs.dailyBuyCount = 0;
    bs.dailyLossUsd = 0;
    bs.killSwitchActive = false;
    bs.killSwitchReason = undefined;
  }
}

// ── Risk limit gate ───────────────────────────────────────────────────────────────────────

export interface RiskLimitCheck {
  allowed: boolean;
  reason?: string;
}

export function checkRiskLimits(bs: LiveShadowBankrollState, cfg: RiskLimitConfig): RiskLimitCheck {
  if (bs.killSwitchActive) {
    return { allowed: false, reason: bs.killSwitchReason ?? 'kill-switch active — max daily loss exceeded' };
  }
  if (bs.openPositions.length >= cfg.openPositionCap) {
    return { allowed: false, reason: `open position cap reached (${bs.openPositions.length}/${cfg.openPositionCap})` };
  }
  if (bs.dailyBuyCount >= cfg.maxDailyBuys) {
    return { allowed: false, reason: `max daily buys reached (${bs.dailyBuyCount}/${cfg.maxDailyBuys})` };
  }
  return { allowed: true };
}

// ── Shadow candidate (unified entry-time model for lane decisions + simulation) ─────────────

export interface ShadowCandidate {
  contract: string;
  symbol: string | null;
  capturedAt: string | null;         // entry-time timestamp (cycle capture / legacy observedAt)
  ripperScore: number;               // entry-time ripper score (0 when unknown)
  launchAgeBucket: LaunchAgeBucket;
  productionGateApproved: boolean;   // production buy gate outcome — reported, never blocking
  clusterRisk: ClusterRisk;          // verbatim — UNKNOWN stays UNKNOWN
  holderRisk: HolderRisk;
  botRisk: BotRisk;
  liquidityQuality: LiquidityQuality;
  entryMomentumPct: number | null;   // m5 momentum
  m5Band: string;
  liquidityUsd: number | null;
  liquidityBucket: string;
  volumeLiquidityRatio: number | null;
  vlrBucket: string;
  ripperScoreBand: string;
  priceChangePct: number | null;
  liquidityChangePct: number | null;
  // Real absolute valuation snapshot for this row (e.g. priceUsd) — basis for realized P/L.
  valuation: number | null;
  valuationField: string | null;
  valuationChecked: string[];   // semantic valuation fields we looked for (for missing reporting)
  topReasons: string[];
  /** Current-snapshot signal used only for exit evaluation (evaluateSell). */
  signal: RipperSignal;
}

// ── Valuation extraction (real absolute price/valuation from a cycle row) ────────────────────
//
// Cycle rows do not carry marketCap/fdv today, but they DO carry an absolute token price under
// raw.final.priceUsd / raw.entry.priceUsd. We prefer that. The check order is future-proofed for
// marketCap / fdv / priceNative should they appear later. `priceChangePct` is NOT a valuation —
// it is ~0 at capture, which is exactly why momentum-based P/L reads flat.

export const VALUATION_FIELDS_CHECKED = ['priceUsd', 'marketCapUsd', 'fdvUsd', 'priceNative'] as const;

export interface ValuationExtract { value: number | null; field: string | null; checked: string[]; }

// ── Source resolution + freshness ───────────────────────────────────────────────────────────

export interface LiveShadowSourceInfo {
  sourceMode: 'FRESH_CYCLE' | 'LEGACY_FEED' | 'NONE';
  sourceFile: string | null;
  sourceTimestamp: string | null;
  sourceAgeMinutes: number | null;
  candidateCount: number;
  staleSource: boolean;
  maxSourceAgeMinutes: number;
}

interface RawCycleObj { [k: string]: unknown }

function readJsonlObjects(filePath: string): RawCycleObj[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as RawCycleObj; } catch { return null; } })
    .filter((r): r is RawCycleObj => r != null);
}

/** Parse the nominal UTC timestamp encoded in a `cycle-YYYY-MM-DD-HHMMSS(.jsonl)` filename. */
export function cycleFileTimestampMs(fileName: string): number | null {
  const m = path.basename(fileName).match(/^cycle-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asObj = (v: unknown): RawCycleObj => (v && typeof v === 'object' ? v as RawCycleObj : {});

/** First finite, strictly-positive number among the candidates (valuations must be > 0). */
function firstPositive(...vals: unknown[]): number | null {
  for (const v of vals) { const n = asNum(v); if (n != null && n > 0) return n; }
  return null;
}

/** Extract a real absolute valuation from a cycle row (priceUsd preferred; mcap/fdv/native next). */
export function extractCycleValuation(row: RawCycleObj): ValuationExtract {
  const ns      = asObj(row['normalizedSignal']);
  const raw     = asObj(row['raw']);
  const nsRaw   = asObj(ns['raw']);
  const rawFinal = asObj(raw['final']);
  const rawEntry = asObj(raw['entry']);
  const nsFinal  = asObj(nsRaw['final']);
  const nsEntry  = asObj(nsRaw['entry']);
  const checked = [...VALUATION_FIELDS_CHECKED];

  const priceUsd = firstPositive(
    rawFinal['priceUsd'], rawEntry['priceUsd'], nsFinal['priceUsd'], nsEntry['priceUsd'],
    ns['priceUsd'], row['priceUsd'],
  );
  if (priceUsd != null) return { value: priceUsd, field: 'priceUsd', checked };

  const marketCap = firstPositive(row['marketCap'], raw['marketCap'], ns['marketCap'], rawFinal['marketCap'], rawEntry['marketCap']);
  if (marketCap != null) return { value: marketCap, field: 'marketCapUsd', checked };

  const fdv = firstPositive(row['fdv'], raw['fdv'], ns['fdv'], rawFinal['fdv'], rawEntry['fdv']);
  if (fdv != null) return { value: fdv, field: 'fdvUsd', checked };

  const priceNative = firstPositive(rawFinal['priceNative'], rawEntry['priceNative'], ns['priceNative'], row['priceNative']);
  if (priceNative != null) return { value: priceNative, field: 'priceNative', checked };

  return { value: null, field: null, checked };
}

// ── Realized P/L from real valuations ────────────────────────────────────────────────────────

export interface RealizedPnl {
  entryValuation: number | null;
  exitValuation: number | null;
  pnlPct: number | null;    // null → VALUATION_UNAVAILABLE (NOT a fake 0)
  pnlUsd: number | null;
  usable: boolean;
  status: 'OK' | 'VALUATION_UNAVAILABLE';
  missing: string[];        // which valuation inputs were missing when unusable
}

interface PnlPositionLike { entryValuation?: number | null; positionSizeUsd: number }
interface PnlCandidateLike { valuation: number | null }

/**
 * Compute realized P/L strictly from real absolute valuations (e.g. priceUsd) at entry vs. the
 * matched current cycle. If either valuation is missing, returns VALUATION_UNAVAILABLE with
 * pnl=null — we NEVER pretend the trade was flat when we simply lacked a price.
 */
export function computeRealizedPnl(pos: PnlPositionLike, currentCandidate: PnlCandidateLike | null): RealizedPnl {
  const entryValuation = pos.entryValuation ?? null;
  const exitValuation  = currentCandidate?.valuation ?? null;
  const missing: string[] = [];
  if (entryValuation == null || !(entryValuation > 0)) missing.push('entryValuation');
  if (currentCandidate == null) missing.push('contractNotInLatestCycle');
  else if (exitValuation == null || !(exitValuation > 0)) missing.push('exitValuation');

  if (entryValuation != null && entryValuation > 0 && exitValuation != null && exitValuation > 0) {
    const pnlPct = (exitValuation / entryValuation - 1) * 100;
    const pnlUsd = (pnlPct / 100) * pos.positionSizeUsd;
    return { entryValuation, exitValuation, pnlPct, pnlUsd, usable: true, status: 'OK', missing: [] };
  }
  return { entryValuation, exitValuation, pnlPct: null, pnlUsd: null, usable: false, status: 'VALUATION_UNAVAILABLE', missing };
}

function normalizeClusterRisk(v: unknown): ClusterRisk {
  return v === 'CLEAN' || v === 'WATCH' || v === 'RISKY' ? v : 'UNKNOWN';   // UNKNOWN stays UNKNOWN
}
function normalizeHolderRisk(v: unknown): HolderRisk {
  return v === 'CLEAN' || v === 'WATCH' || v === 'RISKY' ? v : 'UNKNOWN';
}
function normalizeBotRisk(v: unknown): BotRisk {
  return v === 'CLEAN' || v === 'WATCH' || v === 'RISKY' ? v : 'UNKNOWN';
}
function normalizeLaunchAge(v: unknown): LaunchAgeBucket {
  return v === 'TOO_EARLY' || v === 'PRIME_WINDOW' || v === 'LATE' || v === 'DEAD_WINDOW' ? v : 'DEAD_WINDOW';
}
function normalizeLiquidityQuality(v: unknown): LiquidityQuality {
  return v === 'GOOD' || v === 'THIN' || v === 'ONE_SIDED' || v === 'SUSPICIOUS' ? v : 'UNKNOWN';
}

/** Convert one pre-scored ripper cycle row into a ShadowCandidate (uses entry-time values). */
function cycleRowToShadowCandidate(row: RawCycleObj): ShadowCandidate | null {
  const ns  = (row['normalizedSignal'] as RawCycleObj | undefined) ?? {};
  const ri  = (row['ripperInput']     as RawCycleObj | undefined) ?? {};
  const raw = (row['raw']             as RawCycleObj | undefined) ?? {};

  const contract = asStr(ns['contract']) ?? asStr(ri['contract']) ?? asStr(raw['contract']);
  if (!contract) return null;

  const symbol = asStr(ns['symbol']);
  const capturedAt = asStr(row['capturedAt']) ?? asStr(ns['observedAt']);
  const ripperScore = asNum(row['ripperScore']) ?? 0;
  const launchAgeBucket = normalizeLaunchAge(row['launchAgeBucket']);
  const productionGateApproved = row['buyGateDecision'] === 'BUY_APPROVED_PAPER';
  const clusterRisk = normalizeClusterRisk(ri['clusterRisk'] ?? raw['clusterRisk']);
  const holderRisk = normalizeHolderRisk(row['holderRisk']);
  const botRisk = normalizeBotRisk(row['botRisk']);
  const liquidityQuality = normalizeLiquidityQuality(row['liquidityQuality']);

  const entryMomentumPct = asNum(row['entryMomentumPct']) ?? asNum(ns['entryPriceChangeM5']);
  const liquidityUsd = asNum(ns['liquidityUsd']);
  const volumeLiquidityRatio = asNum(ns['volumeLiquidityRatio']);
  const priceChangePct = asNum(ns['priceChangePct']);
  const liquidityChangePct = asNum(ns['liquidityChangePct']);

  const m5Band = m5BandLabel(entryMomentumPct);
  const liquidityBucket = bucketLiquidity(liquidityUsd);
  const vlrBucket = bucketVlr(volumeLiquidityRatio);
  const scoreBand = ripperScoreBand(ripperScore);
  const valuation = extractCycleValuation(row);
  const topReasons = Array.isArray(row['topReasons']) ? (row['topReasons'] as string[]).slice(0, 5) : [];

  const signal: RipperSignal = {
    contract,
    symbol: symbol ?? undefined,
    observedAt: capturedAt ?? undefined,
    launchAgeBucket,
    liquidityProfile: { quality: liquidityQuality, volumeLiquidityRatio: volumeLiquidityRatio ?? undefined, notes: [] },
    holderCluster: { holderRisk, clusterRisk, concentrationNotes: [] },
    botRiskProfile: { botRisk, botNotes: [] },
    priceChangePct: priceChangePct ?? undefined,
    liquidityChangePct: liquidityChangePct ?? undefined,
    volumeLiquidityRatio: volumeLiquidityRatio ?? undefined,
    ripperScore,
    entryDecision: coerceEntryDecision(row['entryDecision']),
    topReasons,
    blockers: [],
  };

  return {
    contract, symbol, capturedAt, ripperScore, launchAgeBucket, productionGateApproved,
    clusterRisk, holderRisk, botRisk, liquidityQuality,
    entryMomentumPct, m5Band, liquidityUsd, liquidityBucket, volumeLiquidityRatio, vlrBucket,
    ripperScoreBand: scoreBand, priceChangePct, liquidityChangePct,
    valuation: valuation.value, valuationField: valuation.field, valuationChecked: valuation.checked,
    topReasons, signal,
  };
}

function coerceEntryDecision(v: unknown): RipperEntryDecision {
  return v === 'IGNORE' || v === 'WATCH' || v === 'READY_TO_SNIPE_PAPER' || v === 'PAPER_BUY_BLOCKED'
    ? v : 'IGNORE';
}

/** Legacy/debug source: score the old winner-candidate feed with scoreRipper at nowMs. */
function legacyFeedToShadowCandidates(feedPath: string, nowMs: number): ShadowCandidate[] {
  const candidates = loadCandidates(feedPath);
  return candidates.map(c => {
    const signal = scoreRipper(winnerCandidateToRipperInput(c), DEFAULT_RIPPER_CONFIG, nowMs);
    const gate = checkPaperBuyGate(signal, DEFAULT_RIPPER_CONFIG);
    const entryMomentumPct = signal.priceChangePct ?? null;   // legacy feed has no m5; use overall momentum
    return {
      contract: signal.contract,
      symbol: signal.symbol ?? null,
      capturedAt: signal.observedAt ?? null,
      ripperScore: signal.ripperScore,
      launchAgeBucket: signal.launchAgeBucket,
      productionGateApproved: gate.decision === 'BUY_APPROVED_PAPER',
      clusterRisk: signal.holderCluster.clusterRisk,
      holderRisk: signal.holderCluster.holderRisk,
      botRisk: signal.botRiskProfile.botRisk,
      liquidityQuality: signal.liquidityProfile.quality,
      entryMomentumPct,
      m5Band: m5BandLabel(entryMomentumPct),
      liquidityUsd: null,
      liquidityBucket: bucketLiquidity(null),
      volumeLiquidityRatio: signal.volumeLiquidityRatio ?? null,
      vlrBucket: bucketVlr(signal.volumeLiquidityRatio ?? null),
      ripperScoreBand: ripperScoreBand(signal.ripperScore),
      priceChangePct: signal.priceChangePct ?? null,
      liquidityChangePct: signal.liquidityChangePct ?? null,
      // Legacy winner-candidate feed carries no absolute valuation → VALUATION_UNAVAILABLE.
      valuation: null, valuationField: null, valuationChecked: [...VALUATION_FIELDS_CHECKED],
      topReasons: signal.topReasons,
      signal,
    } satisfies ShadowCandidate;
  });
}

export interface ResolvedSource {
  info: LiveShadowSourceInfo;
  candidates: ShadowCandidate[];
  sourceCycle: string;
}

export function resolveLiveShadowSource(options: LiveShadowOptions, nowMs: number): ResolvedSource {
  const maxAge = options.maxSourceAgeMinutes ?? DEFAULT_MAX_SOURCE_AGE_MINUTES;
  const legacyPath = options.legacyFeedPath ?? options.feedPath;

  // ── Legacy/debug source (explicit only) ──
  if (legacyPath) {
    const candidates = legacyFeedToShadowCandidates(legacyPath, nowMs);
    let tsMs: number | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as { generatedAt?: string };
      if (parsed.generatedAt) { const p = Date.parse(parsed.generatedAt); if (Number.isFinite(p)) tsMs = p; }
    } catch { /* ignore */ }
    if (tsMs == null && fs.existsSync(legacyPath)) tsMs = fs.statSync(legacyPath).mtimeMs;
    const ageMin = tsMs != null ? (nowMs - tsMs) / 60000 : null;
    const stale = ageMin == null || ageMin > maxAge;
    return {
      info: {
        sourceMode: 'LEGACY_FEED',
        sourceFile: legacyPath,
        sourceTimestamp: tsMs != null ? new Date(tsMs).toISOString() : null,
        sourceAgeMinutes: ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        candidateCount: candidates.length,
        staleSource: stale,
        maxSourceAgeMinutes: maxAge,
      },
      candidates,
      sourceCycle: `legacy:${path.basename(legacyPath)}`,
    };
  }

  // ── DEFAULT: latest fresh ripper cycle ──
  const cyclesDir = options.cyclesDir ?? DEFAULT_LIVE_SHADOW_CYCLES_DIR;
  const latestName = findLatestRawCycleFile(cyclesDir);
  if (!latestName) {
    return {
      info: {
        sourceMode: 'NONE', sourceFile: null, sourceTimestamp: null, sourceAgeMinutes: null,
        candidateCount: 0, staleSource: true, maxSourceAgeMinutes: maxAge,
      },
      candidates: [],
      sourceCycle: '(none)',
    };
  }
  const latestPath = path.join(cyclesDir, latestName);
  const rows = readJsonlObjects(latestPath);
  const candidates = rows.map(cycleRowToShadowCandidate).filter((c): c is ShadowCandidate => c != null);

  // Source timestamp: prefer the newest capturedAt in the file, fall back to the filename slug.
  let tsMs: number | null = null;
  for (const c of candidates) {
    if (!c.capturedAt) continue;
    const p = Date.parse(c.capturedAt);
    if (Number.isFinite(p) && (tsMs == null || p > tsMs)) tsMs = p;
  }
  if (tsMs == null) tsMs = cycleFileTimestampMs(latestName);

  const ageMin = tsMs != null ? (nowMs - tsMs) / 60000 : null;
  const stale = ageMin == null || ageMin > maxAge;

  return {
    info: {
      sourceMode: 'FRESH_CYCLE',
      sourceFile: latestPath,
      sourceTimestamp: tsMs != null ? new Date(tsMs).toISOString() : null,
      sourceAgeMinutes: ageMin != null ? Math.round(ageMin * 10) / 10 : null,
      candidateCount: candidates.length,
      staleSource: stale,
      maxSourceAgeMinutes: maxAge,
    },
    candidates,
    sourceCycle: latestName.replace(/\.jsonl$/, ''),
  };
}

// ── Lane membership (paper-only research; UNKNOWN never used to approve) ─────────────────────

export function matchesLaneBroad(c: ShadowCandidate): boolean {
  return M5_FAMILY.has(c.m5Band) && LIQ_NEAR.has(c.liquidityBucket) && c.ripperScore >= NO_BM_RESEARCH_MIN_SCORE;
}
export function matchesLaneBestVlr(c: ShadowCandidate): boolean {
  return matchesLaneBroad(c) && c.vlrBucket === BEST_SUBGROUP_VLR;
}
export function matchesLanePullback(c: ShadowCandidate): boolean {
  return c.m5Band === PULLBACK_M5_BAND && LIQ_NEAR.has(c.liquidityBucket) && c.ripperScore >= NO_BM_RESEARCH_MIN_SCORE;
}

/** All lanes a candidate matches (order = specificity, most specific first). */
export function matchedLanes(c: ShadowCandidate): ShadowLane[] {
  const lanes: ShadowLane[] = [];
  if (matchesLaneBestVlr(c)) lanes.push('NO_BM_BEST_VLR');
  if (matchesLanePullback(c)) lanes.push('NO_BM_PULLBACK');
  if (matchesLaneBroad(c)) lanes.push('NO_BM_INTERNAL_BROAD');
  return lanes;
}

/** Primary lane for a shadow-eligible candidate (most specific), or null if not eligible. */
export function primaryLane(c: ShadowCandidate): ShadowLane | null {
  return matchedLanes(c)[0] ?? null;
}

// ── Normalized reject reasons ────────────────────────────────────────────────────────────────

/** Why a candidate did not match ANY shadow lane, as normalized buckets (never per-minute). */
export function normalizedMissingConditions(c: ShadowCandidate): string[] {
  const reasons: string[] = [];
  if (c.launchAgeBucket === 'DEAD_WINDOW') reasons.push(REJECT_DEAD_WINDOW_TOO_OLD);
  if (c.ripperScore < NO_BM_RESEARCH_MIN_SCORE) reasons.push(REJECT_SCORE_BELOW_FLOOR);
  if (!M5_FAMILY.has(c.m5Band)) reasons.push(REJECT_M5_OUTSIDE_LANE);
  if (!LIQ_NEAR.has(c.liquidityBucket)) reasons.push(REJECT_LIQUIDITY_OUTSIDE_LANE);
  return reasons;
}

// ── Cycle options and result ─────────────────────────────────────────────────────────────

export interface LiveShadowOptions {
  cyclesDir?: string;         // DEFAULT source dir (latest cycle is auto-discovered)
  legacyFeedPath?: string;    // explicit legacy/debug source (old winner-candidate feed)
  feedPath?: string;          // alias for legacyFeedPath (back-compat)
  statePath: string;
  eventsPath: string;
  diagnosticsPath?: string;   // when set, append one per-cycle diagnostic record (append-only)
  maxSourceAgeMinutes?: number;
  nowMs?: number;             // injectable for tests
  // ── Research-shadow recorder (bankroll-independent learning stream) ──
  // Records a RESEARCH_WOULD_BUY for every lane-matching candidate even when bankroll caps block
  // the normal would-buy. Paths default to sitting BESIDE the live-shadow state/events files.
  recordResearch?: boolean;      // default true; set false to disable (e.g. isolated unit tests)
  researchEventsPath?: string;   // default: <dir of eventsPath>/research-shadow-events.jsonl
  researchStatePath?: string;    // default: <dir of statePath>/research-shadow-state.json
}

// ── Reject diagnostic (why each candidate is ignored / watched / blocked / ready) ───────────

export type LiveShadowDecision = 'IGNORED' | 'WATCH' | 'BLOCKED' | 'READY';

export interface LiveShadowCandidateDiagnostic {
  symbol:              string | null;
  contract:            string;
  decision:            LiveShadowDecision;
  rejectReasons:       string[];      // normalized buckets only
  m5Band:              string;
  liquidityBucket:     string;
  vlrBucket:           string;
  ripperScoreBand:     string;
  ripperScore:         number;
  clusterRisk:         ClusterRisk;   // UNKNOWN stays UNKNOWN, never CLEAN
  productionGateApproved: boolean;    // production gate, reported not blocking
  matchesNoBmResearch: boolean;       // NO_BM_INTERNAL_BROAD
  matchesBestSubgroup: boolean;       // NO_BM_BEST_VLR (VLR_0_5_TO_2)
  matchesPullback:     boolean;       // NO_BM_PULLBACK
  matchedLanes:        ShadowLane[];
  primaryLane:         ShadowLane | null;
}

export interface LiveShadowDiagnosticRecord {
  schemaVersion:        number;
  ts:                   string;
  sourceMode:           string;
  sourceFile:           string | null;
  sourceCycle:          string;
  sourceTimestamp:      string | null;
  sourceAgeMinutes:     number | null;
  staleSource:          boolean;
  maxSourceAgeMinutes:  number;
  skipped:              boolean;
  skipReason:           string | null;
  totalCandidates:      number;
  decisionCounts:       Record<LiveShadowDecision, number>;
  ignoredByReason:      Record<string, number>;
  blockedByReason:      Record<string, number>;
  missingConditionTally: Record<string, number>;
  readyCount:           number;
  wouldBuyCount:        number;
  productionGateApprovedCount: number;
  laneMatchCounts:      Record<ShadowLane, number>;
  matchesNoBmResearchCount: number;
  matchesBestSubgroupCount: number;
  matchesPullbackCount: number;
  topMissingCondition:  string | null;
  liveShadowOnly:       true;
  realTrading:          false;
  noWallet:             true;
  noSwap:               true;
  noSigning:            true;
  unknownNeverClean:    true;
  readyForRealTrading:  false;
}

export interface LiveShadowBankrollCycleSummary {
  bankroll: BankrollTier;
  wouldBuys: number;
  wouldSells: number;
  skippedByRiskLimit: number;
  killSwitchActive: boolean;
  killSwitchReason?: string;
  openPositions: number;
  riskLimits: RiskLimitConfig;
}

export interface LiveShadowCycleResult extends LiveShadowSafetyFlags {
  ts: string;
  source: LiveShadowSourceInfo;
  sourceCycle: string;
  skipped: boolean;
  skipReason: string | null;
  candidatesScanned: number;
  ignoredCount: number;
  watchCount: number;
  readyCount: number;
  blockedCount: number;
  wouldBuyCount: number;
  productionGateApprovedCount: number;
  laneMatchCounts: Record<ShadowLane, number>;
  bankrollSummaries: LiveShadowBankrollCycleSummary[];
  eventsWritten: LiveShadowEvent[];
  state: LiveShadowState;
  tradingExecuted: 0;
  readyForRealTrading: false;
  diagnostics: LiveShadowCandidateDiagnostic[];
  diagnosticRecord: LiveShadowDiagnosticRecord;
  /** Bankroll-independent research recorder result (null when disabled or the cycle was skipped). */
  research: RecordResearchShadowResult | null;
}

// ── Core cycle runner ─────────────────────────────────────────────────────────────────────
//
// Reads the LATEST FRESH ripper cycle by default (legacy feed only via --legacy-feed), enforces
// source freshness (STALE_SOURCE → skip, no would-buy), then decides WOULD_BUY via the paper-only
// internal research lanes. No trade is ever executed.

export function runLiveShadowCycle(options: LiveShadowOptions): LiveShadowCycleResult {
  const nowMs  = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const today  = todayStr(nowMs);
  const config = DEFAULT_RIPPER_CONFIG;

  const resolved = resolveLiveShadowSource(options, nowMs);
  const { info: source, candidates, sourceCycle } = resolved;
  const state = loadOrCreateLiveShadowState(options.statePath, nowIso);

  const eventsWritten: LiveShadowEvent[] = [];
  const bankrollSummaries: LiveShadowBankrollCycleSummary[] = [];

  // ── STALE SOURCE — skip the whole cycle: no would-buy, no would-sell, no positions opened ──
  if (source.staleSource) {
    for (const tier of BANKROLL_TIERS) {
      const bs = state.bankrolls[tier];
      resetDailyIfNeeded(bs, today);
      bankrollSummaries.push({
        bankroll: tier, wouldBuys: 0, wouldSells: 0, skippedByRiskLimit: bs.skippedByRiskLimit,
        killSwitchActive: bs.killSwitchActive, killSwitchReason: bs.killSwitchReason,
        openPositions: bs.openPositions.length, riskLimits: DEFAULT_RISK_LIMITS[tier],
      });
    }
    state.cycleCount += 1;
    state.lastCycleAt = nowIso;
    saveLiveShadowState(state, options.statePath);

    const diagnostics: LiveShadowCandidateDiagnostic[] = [];   // scoring skipped when stale
    const diagnosticRecord = buildLiveShadowDiagnosticRecord({
      ts: nowIso, source, sourceCycle, skipped: true, skipReason: REJECT_STALE_SOURCE,
      diagnostics, productionGateApprovedCount: 0,
    });
    if (options.diagnosticsPath) appendLiveShadowDiagnostics([diagnosticRecord], options.diagnosticsPath);

    return {
      ts: nowIso, source, sourceCycle, skipped: true, skipReason: REJECT_STALE_SOURCE,
      candidatesScanned: source.candidateCount,
      ignoredCount: 0, watchCount: 0, readyCount: 0, blockedCount: 0,
      wouldBuyCount: 0, productionGateApprovedCount: 0,
      laneMatchCounts: { NO_BM_INTERNAL_BROAD: 0, NO_BM_BEST_VLR: 0, NO_BM_PULLBACK: 0 },
      bankrollSummaries, eventsWritten, state, tradingExecuted: 0, readyForRealTrading: false,
      diagnostics, diagnosticRecord, research: null, ...safetyFlags(),
    };
  }

  const signalByContract = new Map(candidates.map(c => [c.contract, c.signal]));
  const candidateByContract = new Map(candidates.map(c => [c.contract, c]));

  // Reference tier ($20, the tightest) drives the per-candidate READY/BLOCKED diagnostic.
  const REF_TIER = 20 as BankrollTier;
  const refRiskSkipped = new Map<string, string>();
  const refDuplicate = new Set<string>();

  for (const tier of BANKROLL_TIERS) {
    const bs = state.bankrolls[tier];
    resetDailyIfNeeded(bs, today);
    const riskCfg = DEFAULT_RISK_LIMITS[tier];

    // ── Exits — same paper-exit assumptions as the ripper session ──
    const stillOpen: LiveShadowPosition[] = [];
    let wouldSellsThisCycle = 0;

    for (const pos of bs.openPositions) {
      const currentSignal = signalByContract.get(pos.contract) ?? null;
      const asRipperPos: RipperPaperPosition = {
        contract: pos.contract,
        symbol: pos.symbol,
        openedAt: pos.openedAt,
        entryPriceChangePct: pos.entryPriceChangePct,
        entryLiquidityChangePct: pos.entryLiquidityChangePct,
        entryVlr: pos.entryVlr,
        entryRipperScore: pos.entryRipperScore,
        positionSizeUsd: pos.positionSizeUsd,
        peakPriceChangePct: pos.peakPriceChangePct,
        status: 'OPEN',
      };
      const sellResult = evaluateSell(asRipperPos, currentSignal, config, nowMs);

      if (sellResult.shouldSell) {
        const currentCandidate = candidateByContract.get(pos.contract) ?? null;
        const currentPct = currentSignal?.priceChangePct ?? pos.entryPriceChangePct ?? 0;
        const holdMinutes = (nowMs - new Date(pos.openedAt).getTime()) / 60000;

        // Realized P/L from REAL absolute valuations (priceUsd) — never a fake 0. If either the
        // entry or the exit valuation is missing, P/L is VALUATION_UNAVAILABLE (null), not 0.
        const pnl = computeRealizedPnl(pos, currentCandidate);

        const closed: LiveShadowPosition = {
          ...pos,
          status: 'CLOSED',
          closedAt: nowIso,
          exitReason: sellResult.reason,
          exitPriceChangePct: currentPct,
          exitValuation: pnl.exitValuation,
          valuationUsable: pnl.usable,
          valuationStatus: pnl.status,
          valuationMissing: pnl.missing,
          pnlPct: pnl.pnlPct,
          pnlUsd: pnl.pnlUsd,
          holdMinutes,
        };
        bs.closedPositions.unshift(closed);
        bs.totalWouldSells += 1;
        wouldSellsThisCycle += 1;
        if (pnl.pnlUsd != null && pnl.pnlUsd < 0) bs.dailyLossUsd += Math.abs(pnl.pnlUsd);

        eventsWritten.push({
          type: 'WOULD_SELL', ts: nowIso, bankroll: tier, contract: pos.contract, symbol: pos.symbol,
          lane: pos.lane, sourceCycle: pos.sourceCycle,
          exitReason: sellResult.reason!, note: sellResult.note,
          entryPriceChangePct: pos.entryPriceChangePct, exitPriceChangePct: currentPct,
          entryValuation: pos.entryValuation ?? null, exitValuation: pnl.exitValuation,
          valuationField: pos.valuationField ?? null, valuationUsable: pnl.usable,
          valuationStatus: pnl.status, valuationMissing: pnl.missing,
          pnlPct: pnl.pnlPct, pnlUsd: pnl.pnlUsd, holdMinutes, paperOnly: true, notBuySignal: true,
          ...safetyFlags(),
        });
      } else {
        const currentPct = currentSignal?.priceChangePct;
        if (currentPct != null && (pos.peakPriceChangePct == null || currentPct > pos.peakPriceChangePct)) {
          pos.peakPriceChangePct = currentPct;
        }
        stillOpen.push(pos);
      }
    }
    bs.openPositions = stillOpen;

    // Kill-switch — trips once realized daily loss reaches the tier's cap. Only blocks new
    // WOULD_BUY decisions; exits for already-open positions keep being evaluated every cycle.
    if (!bs.killSwitchActive && bs.dailyLossUsd >= riskCfg.maxDailyLossUsd) {
      bs.killSwitchActive = true;
      bs.killSwitchReason = `daily loss $${bs.dailyLossUsd.toFixed(2)} reached max $${riskCfg.maxDailyLossUsd}`;
    }

    // ── Entries — decided by INTERNAL SHADOW LANES (NOT the production buy gate) ──
    const openContracts = new Set(bs.openPositions.map(p => p.contract));
    let wouldBuysThisCycle = 0;

    for (const c of candidates) {
      const lane = primaryLane(c);
      if (lane == null) continue;   // no shadow lane matched → not a would-buy

      if (openContracts.has(c.contract)) {
        if (tier === REF_TIER) refDuplicate.add(c.contract);
        continue;
      }

      const riskCheck = checkRiskLimits(bs, riskCfg);
      if (!riskCheck.allowed) {
        bs.skippedByRiskLimit += 1;
        if (tier === REF_TIER) refRiskSkipped.set(c.contract, riskCheck.reason ?? REJECT_RISK_LIMIT);
        continue;
      }

      const riskLabels: LiveShadowRiskLabels = {
        ripperScore: c.ripperScore,
        launchAgeBucket: c.launchAgeBucket,
        liquidityQuality: c.liquidityQuality,
        holderRisk: c.holderRisk,
        clusterRisk: c.clusterRisk,   // verbatim — UNKNOWN stays UNKNOWN
        botRisk: c.botRisk,
      };

      const newPos: LiveShadowPosition = {
        contract: c.contract,
        symbol: c.symbol ?? undefined,
        bankroll: tier,
        openedAt: nowIso,
        lane,
        sourceCycle,
        entryPriceChangePct: c.priceChangePct ?? undefined,
        entryLiquidityChangePct: c.liquidityChangePct ?? undefined,
        entryVlr: c.volumeLiquidityRatio ?? undefined,
        entryRipperScore: c.ripperScore,
        positionSizeUsd: riskCfg.maxPositionSizeUsd,
        peakPriceChangePct: c.priceChangePct ?? undefined,
        entryValuation: c.valuation,
        valuationField: c.valuationField,
        riskLabels,
        status: 'OPEN',
      };
      bs.openPositions.push(newPos);
      openContracts.add(c.contract);
      bs.totalWouldBuys += 1;
      bs.dailyBuyCount += 1;
      wouldBuysThisCycle += 1;

      eventsWritten.push({
        type: 'WOULD_BUY', ts: nowIso, bankroll: tier, contract: c.contract, symbol: c.symbol ?? undefined,
        lane, m5Band: c.m5Band, liquidityBucket: c.liquidityBucket, vlrBucket: c.vlrBucket,
        ripperScoreBand: c.ripperScoreBand, clusterRisk: c.clusterRisk, sourceCycle,
        paperOnly: true, notBuySignal: true,
        entryValuation: c.valuation, valuationField: c.valuationField,
        entryPriceChangePct: c.priceChangePct ?? undefined, entryLiquidityChangePct: c.liquidityChangePct ?? undefined,
        entryVlr: c.volumeLiquidityRatio ?? undefined, positionSizeUsd: riskCfg.maxPositionSizeUsd,
        ripperScore: c.ripperScore, productionGateApproved: c.productionGateApproved,
        riskLabels, topReasons: c.topReasons,
        ...safetyFlags(),
      });
    }

    bankrollSummaries.push({
      bankroll: tier,
      wouldBuys: wouldBuysThisCycle,
      wouldSells: wouldSellsThisCycle,
      skippedByRiskLimit: bs.skippedByRiskLimit,
      killSwitchActive: bs.killSwitchActive,
      killSwitchReason: bs.killSwitchReason,
      openPositions: bs.openPositions.length,
      riskLimits: riskCfg,
    });
  }

  state.cycleCount += 1;
  state.lastCycleAt = nowIso;

  saveLiveShadowState(state, options.statePath);
  appendLiveShadowEvents(eventsWritten, options.eventsPath);

  // ── Research-shadow recorder (bankroll-independent; never alters the bankroll sim above) ──
  // Records a RESEARCH_WOULD_BUY for EVERY lane-matching candidate — including those the $20 tier
  // could not open once its daily buy cap was reached (refRiskSkipped) — into a SEPARATE stream.
  let research: RecordResearchShadowResult | null = null;
  if (options.recordResearch !== false) {
    const researchEventsPath = options.researchEventsPath
      ?? path.join(path.dirname(options.eventsPath), RESEARCH_SHADOW_EVENTS_FILENAME);
    const researchStatePath = options.researchStatePath
      ?? path.join(path.dirname(options.statePath), RESEARCH_SHADOW_STATE_FILENAME);
    research = recordResearchShadow({
      candidates, sourceCycle, nowMs,
      statePath: researchStatePath, eventsPath: researchEventsPath,
      bankrollBlockedContracts: new Set(refRiskSkipped.keys()),
    });
  }

  // ── Per-candidate diagnostics (reference $20 tier drives READY/BLOCKED) ──
  const diagnostics: LiveShadowCandidateDiagnostic[] = candidates.map(c =>
    buildCandidateDiagnostic(c, refRiskSkipped.get(c.contract), refDuplicate.has(c.contract)));

  const productionGateApprovedCount = candidates.filter(c => c.productionGateApproved).length;
  const laneMatchCounts: Record<ShadowLane, number> = {
    NO_BM_INTERNAL_BROAD: candidates.filter(matchesLaneBroad).length,
    NO_BM_BEST_VLR:       candidates.filter(matchesLaneBestVlr).length,
    NO_BM_PULLBACK:       candidates.filter(matchesLanePullback).length,
  };

  const diagnosticRecord = buildLiveShadowDiagnosticRecord({
    ts: nowIso, source, sourceCycle, skipped: false, skipReason: null,
    diagnostics, productionGateApprovedCount,
  });
  if (options.diagnosticsPath) appendLiveShadowDiagnostics([diagnosticRecord], options.diagnosticsPath);

  const ignoredCount = diagnostics.filter(d => d.decision === 'IGNORED').length;
  const watchCount   = diagnostics.filter(d => d.decision === 'WATCH').length;
  const readyCount   = diagnostics.filter(d => d.decision === 'READY').length;
  const blockedCount = diagnostics.filter(d => d.decision === 'BLOCKED').length;
  const wouldBuyCount = eventsWritten.filter(e => e.type === 'WOULD_BUY' && e.bankroll === REF_TIER).length;

  return {
    ts: nowIso, source, sourceCycle, skipped: false, skipReason: null,
    candidatesScanned: candidates.length, ignoredCount, watchCount, readyCount, blockedCount,
    wouldBuyCount, productionGateApprovedCount, laneMatchCounts,
    bankrollSummaries, eventsWritten, state, tradingExecuted: 0, readyForRealTrading: false,
    diagnostics, diagnosticRecord, research, ...safetyFlags(),
  };
}

// ── Diagnostic builders ─────────────────────────────────────────────────────────────────────

function buildCandidateDiagnostic(
  c: ShadowCandidate,
  refRiskReason: string | undefined,
  isDuplicate: boolean,
): LiveShadowCandidateDiagnostic {
  const lanes = matchedLanes(c);
  const primary = lanes[0] ?? null;

  let decision: LiveShadowDecision;
  let rejectReasons: string[];

  if (primary != null) {
    // Shadow-eligible — READY unless the reference tier's risk/duplicate rules block it.
    if (isDuplicate) {
      decision = 'BLOCKED';
      rejectReasons = [REJECT_DUPLICATE_OPEN];
    } else if (refRiskReason) {
      decision = 'BLOCKED';
      rejectReasons = [`${REJECT_RISK_LIMIT}: ${refRiskReason}`];
    } else {
      decision = 'READY';
      rejectReasons = [];
    }
  } else {
    rejectReasons = normalizedMissingConditions(c);
    // WATCH = alive + at/above score floor + m5 known, just outside a lane; otherwise IGNORED.
    const near = c.ripperScore >= NO_BM_RESEARCH_MIN_SCORE
      && c.launchAgeBucket !== 'DEAD_WINDOW'
      && c.m5Band !== 'UNAVAILABLE';
    decision = near ? 'WATCH' : 'IGNORED';
  }

  return {
    symbol: c.symbol, contract: c.contract, decision, rejectReasons,
    m5Band: c.m5Band, liquidityBucket: c.liquidityBucket, vlrBucket: c.vlrBucket,
    ripperScoreBand: c.ripperScoreBand, ripperScore: c.ripperScore, clusterRisk: c.clusterRisk,
    productionGateApproved: c.productionGateApproved,
    matchesNoBmResearch: matchesLaneBroad(c),
    matchesBestSubgroup: matchesLaneBestVlr(c),
    matchesPullback: matchesLanePullback(c),
    matchedLanes: lanes,
    primaryLane: primary,
  };
}

export interface BuildDiagnosticRecordArgs {
  ts: string;
  source: LiveShadowSourceInfo;
  sourceCycle: string;
  skipped: boolean;
  skipReason: string | null;
  diagnostics: LiveShadowCandidateDiagnostic[];
  productionGateApprovedCount: number;
}

export function buildLiveShadowDiagnosticRecord(args: BuildDiagnosticRecordArgs): LiveShadowDiagnosticRecord {
  const { ts, source, sourceCycle, skipped, skipReason, diagnostics, productionGateApprovedCount } = args;

  const decisionCounts: Record<LiveShadowDecision, number> = { IGNORED: 0, WATCH: 0, BLOCKED: 0, READY: 0 };
  const ignoredByReason: Record<string, number> = {};
  const blockedByReason: Record<string, number> = {};
  const missingConditionTally: Record<string, number> = {};
  let matchesNoBmResearchCount = 0, matchesBestSubgroupCount = 0, matchesPullbackCount = 0;

  for (const d of diagnostics) {
    decisionCounts[d.decision]++;
    if (d.matchesNoBmResearch) matchesNoBmResearchCount++;
    if (d.matchesBestSubgroup) matchesBestSubgroupCount++;
    if (d.matchesPullback) matchesPullbackCount++;
    if (d.decision === 'IGNORED') for (const r of d.rejectReasons) { bump(ignoredByReason, r); bump(missingConditionTally, r); }
    if (d.decision === 'BLOCKED') for (const r of d.rejectReasons) { bump(blockedByReason, r); bump(missingConditionTally, r); }
    if (d.decision === 'WATCH')   for (const r of d.rejectReasons) { bump(missingConditionTally, r); }
  }

  // When the whole cycle is skipped for staleness, record STALE_SOURCE as the single reason.
  if (skipped && skipReason === REJECT_STALE_SOURCE) {
    ignoredByReason[REJECT_STALE_SOURCE] = source.candidateCount;
    missingConditionTally[REJECT_STALE_SOURCE] = source.candidateCount;
    decisionCounts.IGNORED = source.candidateCount;
  }

  const topMissingCondition = Object.entries(missingConditionTally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const readyCount = decisionCounts.READY;

  return {
    schemaVersion: 2, ts,
    sourceMode: source.sourceMode, sourceFile: source.sourceFile, sourceCycle,
    sourceTimestamp: source.sourceTimestamp, sourceAgeMinutes: source.sourceAgeMinutes,
    staleSource: source.staleSource, maxSourceAgeMinutes: source.maxSourceAgeMinutes,
    skipped, skipReason,
    totalCandidates: skipped && skipReason === REJECT_STALE_SOURCE ? source.candidateCount : diagnostics.length,
    decisionCounts, ignoredByReason, blockedByReason, missingConditionTally,
    readyCount, wouldBuyCount: readyCount, productionGateApprovedCount,
    laneMatchCounts: {
      NO_BM_INTERNAL_BROAD: matchesNoBmResearchCount,
      NO_BM_BEST_VLR:       matchesBestSubgroupCount,
      NO_BM_PULLBACK:       matchesPullbackCount,
    },
    matchesNoBmResearchCount, matchesBestSubgroupCount, matchesPullbackCount,
    topMissingCondition,
    liveShadowOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true,
    unknownNeverClean: true, readyForRealTrading: false,
  };
}

function bump(m: Record<string, number>, k: string): void { m[k] = (m[k] ?? 0) + 1; }

/** Append-only diagnostics write — ONLY to the given live-shadow diagnostics jsonl. */
export function appendLiveShadowDiagnostics(records: LiveShadowDiagnosticRecord[], diagnosticsPath: string): void {
  if (records.length === 0) return;
  fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true });
  fs.appendFileSync(diagnosticsPath, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

// ── Renderer ──────────────────────────────────────────────────────────────────────────────

export function renderLiveShadowCycleSummary(r: LiveShadowCycleResult): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const L: string[] = [];

  L.push(WIDE);
  L.push('  TOKEN GRAB — LIVE-SHADOW EXECUTION MODE (paper-only research lanes)');
  L.push('  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);
  L.push('');
  L.push(`  TS                 : ${r.ts}`);
  L.push('');
  L.push('  SOURCE FRESHNESS');
  L.push(THIN);
  L.push(`    Source mode      : ${r.source.sourceMode}`);
  L.push(`    Source file      : ${r.source.sourceFile ?? '(none found)'}`);
  L.push(`    Source cycle     : ${r.sourceCycle}`);
  L.push(`    Source timestamp : ${r.source.sourceTimestamp ?? '(unknown)'}`);
  L.push(`    Source age (min) : ${r.source.sourceAgeMinutes ?? '(unknown)'}   (max ${r.source.maxSourceAgeMinutes})`);
  L.push(`    Candidate count  : ${r.source.candidateCount}`);
  L.push(`    staleSource      : ${r.source.staleSource}`);
  L.push('');

  if (r.skipped) {
    L.push(THIN);
    L.push(`  CYCLE SKIPPED — ${r.skipReason}`);
    L.push('    Source is stale — no would-buy events created, no positions opened.');
    L.push('    Run a fresh capture (token:ripper-paper-cycle) then re-run live-shadow.');
    L.push('');
  } else {
    L.push(`  Candidates         : ${r.candidatesScanned}`);
    L.push(`  Ignored            : ${r.ignoredCount}`);
    L.push(`  Watch              : ${r.watchCount}`);
    L.push(`  Blocked            : ${r.blockedCount}`);
    L.push(`  Ready (would-buy)  : ${r.readyCount}`);
    L.push('');
    L.push('  SHADOW LANES (paper-only research — NOT the production buy gate)');
    L.push(THIN);
    L.push(`    NO_BM_INTERNAL_BROAD : ${r.laneMatchCounts.NO_BM_INTERNAL_BROAD}`);
    L.push(`    NO_BM_BEST_VLR       : ${r.laneMatchCounts.NO_BM_BEST_VLR}   (VLR_0_5_TO_2)`);
    L.push(`    NO_BM_PULLBACK       : ${r.laneMatchCounts.NO_BM_PULLBACK}   (m5 -20 to -5)`);
    L.push(`    Production buy gate approved (reported, NOT blocking) : ${r.productionGateApprovedCount}`);
    L.push('');

    // Per-candidate reject diagnostics
    L.push(THIN);
    L.push('  CANDIDATE DIAGNOSTICS (why each is IGNORED / WATCH / BLOCKED / READY)');
    L.push(THIN);
    if (r.diagnostics.length === 0) L.push('  (no candidates in current source)');
    for (const d of r.diagnostics.slice(0, 40)) {
      const c = d.contract.length > 12 ? d.contract.slice(0, 5) + '..' + d.contract.slice(-4) : d.contract;
      L.push(`  [${d.decision.padEnd(7)}] ${(d.symbol ?? '-').slice(0, 12).padEnd(12)} ${c.padEnd(12)} ` +
        `m5=${d.m5Band}  liq=${d.liquidityBucket}  vlr=${d.vlrBucket}  score=${d.ripperScoreBand}  cluster=${d.clusterRisk}`);
      L.push(`             lane=${d.primaryLane ?? '-'}  broad=${d.matchesNoBmResearch ? 'YES' : 'no'}  ` +
        `bestVlr(VLR_0_5_TO_2)=${d.matchesBestSubgroup ? 'YES' : 'no'}  pullback=${d.matchesPullback ? 'YES' : 'no'}  ` +
        `prodGate=${d.productionGateApproved ? 'APPROVED' : 'rejected'}` +
        (d.rejectReasons.length ? `  reasons=[${d.rejectReasons.join('; ')}]` : ''));
    }
    if (r.diagnostics.length > 40) L.push(`  … ${r.diagnostics.length - 40} more`);
    L.push('');
  }

  L.push(THIN);
  L.push('  BANKROLL SIMULATIONS');
  L.push(THIN);
  for (const b of r.bankrollSummaries) {
    L.push(`  $${b.bankroll} bankroll`);
    L.push(`    Would-buy this cycle  : ${b.wouldBuys}`);
    L.push(`    Would-sell this cycle : ${b.wouldSells}`);
    L.push(`    Open positions        : ${b.openPositions}`);
    L.push(`    Skipped (risk limit)  : ${b.skippedByRiskLimit}`);
    L.push(`    Kill-switch           : ${b.killSwitchActive ? `ACTIVE — ${b.killSwitchReason ?? ''}` : 'inactive'}`);
    L.push('');
  }

  if (r.research) {
    L.push(THIN);
    L.push('  RESEARCH SHADOW (bankroll-independent — separate stream, NOT a buy signal)');
    L.push(THIN);
    L.push(`    Research would-buys this cycle  : ${r.research.researchBuys}`);
    L.push(`    Research would-sells this cycle : ${r.research.researchSells}`);
    L.push(`    Open research positions         : ${r.research.openPositions}`);
    L.push('    Records lane matches even when bankroll daily-buy caps are reached.');
    L.push('    Report: npm run token:research-shadow-report');
    L.push('');
  }

  L.push(THIN);
  L.push('  SAFETY');
  L.push(THIN);
  L.push('  LIVE_SHADOW_ONLY=true');
  L.push('  REAL_TRADING=false');
  L.push('  READY_FOR_REAL_TRADING=false');
  L.push('  NO_WALLET=true');
  L.push('  NO_SWAP=true');
  L.push('  NO_SIGNING=true');
  L.push('  UNKNOWN stays UNKNOWN — never CLEAN');
  L.push('  tradingExecuted=0  token:auto-paper NOT run  token:paper-buy NOT run  live-execution flag NOT supported');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);

  return L.join('\n');
}

export function renderLiveShadowUsage(): string {
  return `
token:live-shadow — LIVE-SHADOW execution mode: simulate real-time autonomous research
decisions using paper-only INTERNAL SHADOW LANES over the latest FRESH ripper cycle.
No wallet, no private keys, no signing, no swap execution, no real funds.

Usage:
  npm run token:live-shadow [options]

Options:
  --cycles-dir <path>      directory of fresh ripper cycles (DEFAULT source)
                            (default: ${DEFAULT_LIVE_SHADOW_CYCLES_DIR})
  --legacy-feed <path>      LEGACY/DEBUG: read the old winner-candidate feed instead
                            (e.g. ${DEFAULT_LIVE_SHADOW_FEED_PATH})
  --max-source-age-minutes <N>  freshness window; older source → STALE_SOURCE skip
                            (default: ${DEFAULT_MAX_SOURCE_AGE_MINUTES})
  --state <path>            live-shadow state file
                            (default: ${DEFAULT_LIVE_SHADOW_STATE_PATH})
  --events <path>           live-shadow events jsonl
                            (default: ${DEFAULT_LIVE_SHADOW_EVENTS_PATH})
  --diagnostics <path>      append-only per-cycle diagnostics jsonl
  --reset                   clear live-shadow state before starting
  --json                    emit the diagnostic record as JSON
  --help                    show this message

Shadow lanes (paper-only research — NOT the production buy gate):
  NO_BM_INTERNAL_BROAD   entry-time NO_BM_RESEARCH membership (m5 family, liquidity near, score>=${NO_BM_RESEARCH_MIN_SCORE})
  NO_BM_BEST_VLR         broad + VLR_0_5_TO_2 subgroup
  NO_BM_PULLBACK         m5Band=-20 to -5, liquidity near, score floor

Safety:
  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  READY_FOR_REAL_TRADING=false
  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true
  No wallet, no private keys, no signing, no swap execution, no real trades.
  Does not run token:auto-paper or token:paper-buy. No live-execution flag exists.
  The production buy gate is reported but never blocks a shadow research decision.
  UNKNOWN risk labels stay UNKNOWN — never CLEAN.
  DO_NOT_ENABLE_REAL_TRADING
`.trim();
}
