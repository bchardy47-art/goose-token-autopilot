// LIVE-SHADOW EXECUTION MODE
//
// DO_NOT_ENABLE_REAL_TRADING  LIVE_SHADOW_ONLY=true  REAL_TRADING=false
// NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true
//
// Simulates real autonomous trading decisions in real time using the existing internal
// NO_BM research candidate logic (scoreRipper / checkPaperBuyGate / evaluateSell from
// dexRipperEngine — the SAME gates used elsewhere, never loosened here). No wallet, no
// private keys, no signing, no swap execution, no real funds are ever touched. This module
// never calls token:auto-paper or token:paper-buy, and there is no live-execution flag.
//
// WOULD_BUY / WOULD_SELL decisions are appended to a dedicated live-shadow events file and
// tracked against three independent bankroll simulations ($20 / $50 / $100), each with its
// own max position size, max daily buys, max daily loss, open-position cap, and kill-switch.
//
// UNKNOWN risk labels (holderRisk, clusterRisk, botRisk) are carried through verbatim from
// the scorer and are NEVER upgraded to CLEAN here.

import * as fs from 'fs';
import * as path from 'path';
import {
  scoreRipper,
  checkPaperBuyGate,
  evaluateSell,
  DEFAULT_RIPPER_CONFIG,
  type RipperPaperPosition,
  type RipperSellReason,
  type LaunchAgeBucket,
  type LiquidityQuality,
  type HolderRisk,
  type ClusterRisk,
  type BotRisk,
} from './dexRipperEngine';
import { loadCandidates, winnerCandidateToRipperInput } from './dexRipperSession';
import { bucketVlr } from './ripperLearningMemory';
import { m5BandLabel } from './ripperSubgroupWatch';
import { ripperScoreBand } from './ripperNoBmQualityReport';
import { NO_BM_RESEARCH_MIN_SCORE } from './ripperWatchCohortFamily';

// ── Safety constants ──────────────────────────────────────────────────────────────────────

export const LIVE_SHADOW_ONLY = true;
export const REAL_TRADING = false;
export const NO_WALLET = true;
export const NO_SWAP = true;
export const NO_SIGNING = true;

// ── Default paths (live-shadow writes ONLY under this directory) ────────────────────────────

export const DEFAULT_LIVE_SHADOW_FEED_PATH   = 'data/token-grab/legitimacy/dex-winner-candidates-today.json';
export const DEFAULT_LIVE_SHADOW_STATE_PATH  = 'data/token-grab/live-shadow/live-shadow-state.json';
export const DEFAULT_LIVE_SHADOW_EVENTS_PATH = 'data/token-grab/live-shadow/live-shadow-events.jsonl';
export const DEFAULT_LIVE_SHADOW_DIAGNOSTICS_PATH = 'data/token-grab/live-shadow/live-shadow-diagnostics.jsonl';

const M5_FAMILY_BANDS   = new Set(['-20 to -5', '-5 to +5']);
const BEST_SUBGROUP_VLR = 'VLR_0_5_TO_2';   // strongest VLR subgroup from the NO_BM quality report

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
  entryPriceChangePct?: number;
  entryLiquidityChangePct?: number;
  entryVlr?: number;
  entryRipperScore: number;
  positionSizeUsd: number;
  peakPriceChangePct?: number;
  riskLabels: LiveShadowRiskLabels;
  status: 'OPEN' | 'CLOSED';
  closedAt?: string;
  exitReason?: RipperSellReason;
  exitPriceChangePct?: number;
  pnlPct?: number;
  pnlUsd?: number;
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
  entryPriceChangePct?: number;
  entryLiquidityChangePct?: number;
  entryVlr?: number;
  positionSizeUsd: number;
  ripperScore: number;
  riskLabels: LiveShadowRiskLabels;
  topReasons: string[];
}

export interface LiveShadowWouldSellEvent extends LiveShadowSafetyFlags {
  type: 'WOULD_SELL';
  ts: string;
  bankroll: BankrollTier;
  contract: string;
  symbol?: string;
  exitReason: RipperSellReason;
  note: string;
  entryPriceChangePct?: number;
  exitPriceChangePct?: number;
  pnlPct: number;
  pnlUsd: number;
  holdMinutes: number;
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

// ── Cycle options and result ─────────────────────────────────────────────────────────────

export interface LiveShadowOptions {
  feedPath: string;
  statePath: string;
  eventsPath: string;
  diagnosticsPath?: string;   // when set, append one per-cycle diagnostic record (append-only)
  nowMs?: number; // injectable for tests
}

// ── Reject diagnostic (why each candidate is ignored / watched / blocked / ready) ───────────

export type LiveShadowDecision = 'IGNORED' | 'WATCH' | 'BLOCKED' | 'READY';

export interface LiveShadowCandidateDiagnostic {
  symbol:              string | null;
  contract:            string;
  decision:            LiveShadowDecision;
  rejectReasons:       string[];
  m5Band:              string;
  liquidityBucket:     string;   // liquidity-quality bucket from the scorer (feed has no USD liquidity)
  vlrBucket:           string;
  ripperScoreBand:     string;
  ripperScore:         number;
  clusterRisk:         ClusterRisk;   // UNKNOWN stays UNKNOWN, never CLEAN
  buyGateDecision:     string;
  matchesNoBmResearch: boolean;
  matchesBestSubgroup: boolean;       // VLR_0_5_TO_2
}

export interface LiveShadowDiagnosticRecord {
  schemaVersion:        number;
  ts:                   string;
  feedPath:             string;
  totalCandidates:      number;
  decisionCounts:       Record<LiveShadowDecision, number>;
  ignoredByReason:      Record<string, number>;
  blockedByReason:      Record<string, number>;
  missingConditionTally: Record<string, number>;
  readyCount:           number;
  wouldBuyCount:        number;
  approvedGateCount:    number;
  approvedGateExplain:  string;
  matchesNoBmResearchCount: number;
  matchesBestSubgroupCount: number;
  topMissingCondition:  string | null;
  liveShadowOnly:       true;
  realTrading:          false;
  noWallet:             true;
  noSwap:               true;
  noSigning:            true;
  unknownNeverClean:    true;
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
  feedPath: string;
  candidatesScanned: number;
  ignoredCount: number;
  watchCount: number;
  readyCount: number;
  blockedCount: number;
  approvedCount: number;
  bankrollSummaries: LiveShadowBankrollCycleSummary[];
  eventsWritten: LiveShadowEvent[];
  state: LiveShadowState;
  tradingExecuted: 0;
  diagnostics: LiveShadowCandidateDiagnostic[];
  diagnosticRecord: LiveShadowDiagnosticRecord;
  approvedGateExplain: string;
}

// ── Core cycle runner ─────────────────────────────────────────────────────────────────────
//
// Reads the live/current token feed, scores every candidate with the SAME internal NO_BM
// research candidate logic used elsewhere (scoreRipper / checkPaperBuyGate / evaluateSell,
// DEFAULT_RIPPER_CONFIG — no gate is loosened here), and simulates WOULD_BUY / WOULD_SELL
// decisions against three independent bankroll tiers. No trade is ever executed.

export function runLiveShadowCycle(options: LiveShadowOptions): LiveShadowCycleResult {
  const nowMs  = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const today  = todayStr(nowMs);
  const config = DEFAULT_RIPPER_CONFIG;

  const candidates = loadCandidates(options.feedPath);
  const state = loadOrCreateLiveShadowState(options.statePath, nowIso);

  const signals = candidates.map(c => scoreRipper(winnerCandidateToRipperInput(c), config, nowMs));
  const signalByContract = new Map(signals.map(s => [s.contract, s]));

  const eventsWritten: LiveShadowEvent[] = [];
  const bankrollSummaries: LiveShadowBankrollCycleSummary[] = [];
  // Reference tier ($20, the tightest) drives the per-candidate READY/BLOCKED diagnostic.
  const REF_TIER = 20 as BankrollTier;
  const refRiskSkipped = new Map<string, string>();

  for (const tier of BANKROLL_TIERS) {
    const bs = state.bankrolls[tier];
    resetDailyIfNeeded(bs, today);
    const riskCfg = DEFAULT_RISK_LIMITS[tier];

    // ── Exits — evaluated with the exact same paper-exit assumptions as the ripper session ──
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
        const entryPct   = pos.entryPriceChangePct ?? 0;
        const currentPct = currentSignal?.priceChangePct ?? entryPct;
        const pnlPct = sellResult.fakePnlPct ?? ((100 + currentPct) / (100 + entryPct) - 1) * 100;
        const pnlUsd = (pnlPct / 100) * pos.positionSizeUsd;
        const holdMinutes = (nowMs - new Date(pos.openedAt).getTime()) / 60000;

        const closed: LiveShadowPosition = {
          ...pos,
          status: 'CLOSED',
          closedAt: nowIso,
          exitReason: sellResult.reason,
          exitPriceChangePct: currentPct,
          pnlPct,
          pnlUsd,
          holdMinutes,
        };
        bs.closedPositions.unshift(closed);
        bs.totalWouldSells += 1;
        wouldSellsThisCycle += 1;
        if (pnlUsd < 0) bs.dailyLossUsd += Math.abs(pnlUsd);

        eventsWritten.push({
          type: 'WOULD_SELL', ts: nowIso, bankroll: tier, contract: pos.contract, symbol: pos.symbol,
          exitReason: sellResult.reason!, note: sellResult.note,
          entryPriceChangePct: pos.entryPriceChangePct, exitPriceChangePct: currentPct,
          pnlPct, pnlUsd, holdMinutes,
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

    // ── Entries — same buy gate as the paper ripper session; never loosened for live-shadow ──
    const openContracts = new Set(bs.openPositions.map(p => p.contract));
    let wouldBuysThisCycle = 0;

    for (const signal of signals) {
      if (signal.entryDecision === 'IGNORE') continue;
      const gateResult = checkPaperBuyGate(signal, config);
      if (gateResult.decision !== 'BUY_APPROVED_PAPER') continue;
      if (openContracts.has(signal.contract)) continue;

      const riskCheck = checkRiskLimits(bs, riskCfg);
      if (!riskCheck.allowed) {
        bs.skippedByRiskLimit += 1;
        if (tier === REF_TIER) refRiskSkipped.set(signal.contract, riskCheck.reason ?? 'RISK_LIMIT');
        continue;
      }

      const riskLabels: LiveShadowRiskLabels = {
        ripperScore: signal.ripperScore,
        launchAgeBucket: signal.launchAgeBucket,
        liquidityQuality: signal.liquidityProfile.quality,
        holderRisk: signal.holderCluster.holderRisk,
        clusterRisk: signal.holderCluster.clusterRisk,
        botRisk: signal.botRiskProfile.botRisk,
      };

      const newPos: LiveShadowPosition = {
        contract: signal.contract,
        symbol: signal.symbol,
        bankroll: tier,
        openedAt: nowIso,
        entryPriceChangePct: signal.priceChangePct,
        entryLiquidityChangePct: signal.liquidityChangePct,
        entryVlr: signal.volumeLiquidityRatio,
        entryRipperScore: signal.ripperScore,
        positionSizeUsd: riskCfg.maxPositionSizeUsd,
        peakPriceChangePct: signal.priceChangePct,
        riskLabels,
        status: 'OPEN',
      };
      bs.openPositions.push(newPos);
      openContracts.add(signal.contract);
      bs.totalWouldBuys += 1;
      bs.dailyBuyCount += 1;
      wouldBuysThisCycle += 1;

      eventsWritten.push({
        type: 'WOULD_BUY', ts: nowIso, bankroll: tier, contract: signal.contract, symbol: signal.symbol,
        entryPriceChangePct: signal.priceChangePct, entryLiquidityChangePct: signal.liquidityChangePct,
        entryVlr: signal.volumeLiquidityRatio, positionSizeUsd: riskCfg.maxPositionSizeUsd,
        ripperScore: signal.ripperScore, riskLabels, topReasons: signal.topReasons,
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

  const ignoredCount = signals.filter(s => s.entryDecision === 'IGNORE').length;
  const watchCount   = signals.filter(s => s.entryDecision === 'WATCH').length;
  const readyCount   = signals.filter(s => s.entryDecision === 'READY_TO_SNIPE_PAPER').length;
  const blockedCount = signals.filter(s => s.entryDecision === 'PAPER_BUY_BLOCKED').length;
  const approvedCount = signals.filter(s => checkPaperBuyGate(s, config).decision === 'BUY_APPROVED_PAPER').length;

  // ── Per-candidate reject diagnostics (why each was IGNORED / WATCH / BLOCKED / READY) ──────
  const diagnostics: LiveShadowCandidateDiagnostic[] = signals.map(s =>
    buildCandidateDiagnostic(s, checkPaperBuyGate(s, config), refRiskSkipped.get(s.contract)));
  const approvedGateExplain = explainApprovedGate(approvedCount, diagnostics);
  const diagnosticRecord = buildLiveShadowDiagnosticRecord(nowIso, options.feedPath, diagnostics, approvedCount, approvedGateExplain);

  // Optional append-only diagnostics file (only when a path is provided — keeps the default
  // "writes only state + events" contract intact).
  if (options.diagnosticsPath) appendLiveShadowDiagnostics([diagnosticRecord], options.diagnosticsPath);

  return {
    ts: nowIso, feedPath: options.feedPath,
    candidatesScanned: signals.length, ignoredCount, watchCount, readyCount, blockedCount, approvedCount,
    bankrollSummaries, eventsWritten, state,
    tradingExecuted: 0,
    diagnostics, diagnosticRecord, approvedGateExplain,
    ...safetyFlags(),
  };
}

// ── Diagnostic builders ─────────────────────────────────────────────────────────────────────

function buildCandidateDiagnostic(
  s: ReturnType<typeof scoreRipper>,
  gate: ReturnType<typeof checkPaperBuyGate>,
  refRiskReason: string | undefined,
): LiveShadowCandidateDiagnostic {
  const m5Band          = m5BandLabel(s.priceChangePct ?? null);
  const vlrBucket       = bucketVlr(s.volumeLiquidityRatio ?? null);
  const scoreBand       = ripperScoreBand(s.ripperScore);
  const liquidityBucket = s.liquidityProfile.quality;   // scorer's liquidity classification
  const clusterRisk     = s.holderCluster.clusterRisk;  // UNKNOWN stays UNKNOWN

  // Internal NO_BM research match (this feed lacks USD liquidity, so use momentum + vlr + score).
  const matchesNoBmResearch =
    M5_FAMILY_BANDS.has(m5Band) && s.ripperScore >= NO_BM_RESEARCH_MIN_SCORE && vlrBucket !== 'VLR_UNKNOWN';
  const matchesBestSubgroup = vlrBucket === BEST_SUBGROUP_VLR;

  let decision: LiveShadowDecision;
  let rejectReasons: string[];
  if (s.entryDecision === 'IGNORE') {
    decision = 'IGNORED';
    rejectReasons = s.blockers.length ? s.blockers.slice() : ['ENTRY_DECISION_IGNORE'];
  } else if (s.entryDecision === 'WATCH') {
    decision = 'WATCH';
    rejectReasons = s.blockers.length ? s.blockers.slice() : ['ENTRY_DECISION_WATCH'];
  } else if (s.entryDecision === 'PAPER_BUY_BLOCKED') {
    decision = 'BLOCKED';
    rejectReasons = s.blockers.length ? s.blockers.slice() : ['ENTRY_DECISION_PAPER_BUY_BLOCKED'];
  } else {
    // READY_TO_SNIPE_PAPER — buy only if the (never-loosened) gate approves AND risk allows.
    if (gate.decision !== 'BUY_APPROVED_PAPER') {
      decision = 'BLOCKED';
      rejectReasons = gate.blockers.length ? gate.blockers.slice() : ['BUY_GATE_REJECTED'];
    } else if (refRiskReason) {
      decision = 'BLOCKED';
      rejectReasons = [`RISK_LIMIT: ${refRiskReason}`];
    } else {
      decision = 'READY';
      rejectReasons = [];
    }
  }

  return {
    symbol: s.symbol ?? null, contract: s.contract, decision, rejectReasons,
    m5Band, liquidityBucket, vlrBucket, ripperScoreBand: scoreBand, ripperScore: s.ripperScore,
    clusterRisk, buyGateDecision: gate.decision, matchesNoBmResearch, matchesBestSubgroup,
  };
}

function explainApprovedGate(approvedCount: number, diagnostics: LiveShadowCandidateDiagnostic[]): string {
  if (approvedCount > 0) return `Production buy gate approved ${approvedCount}.`;
  const tally: Record<string, number> = {};
  for (const d of diagnostics) if (d.decision !== 'READY') for (const r of d.rejectReasons) tally[r] = (tally[r] ?? 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];
  return `Production buy gate approved 0 (gate NOT loosened). Top blocking condition: ${top ?? '(none — no candidates)'}. ` +
    `UNKNOWN cluster risk stays UNKNOWN (never CLEAN).`;
}

export function buildLiveShadowDiagnosticRecord(
  ts: string, feedPath: string, diagnostics: LiveShadowCandidateDiagnostic[],
  approvedGateCount: number, approvedGateExplain: string,
): LiveShadowDiagnosticRecord {
  const decisionCounts: Record<LiveShadowDecision, number> = { IGNORED: 0, WATCH: 0, BLOCKED: 0, READY: 0 };
  const ignoredByReason: Record<string, number> = {};
  const blockedByReason: Record<string, number> = {};
  const missingConditionTally: Record<string, number> = {};
  let matchesNoBmResearchCount = 0, matchesBestSubgroupCount = 0;
  for (const d of diagnostics) {
    decisionCounts[d.decision]++;
    if (d.matchesNoBmResearch) matchesNoBmResearchCount++;
    if (d.matchesBestSubgroup) matchesBestSubgroupCount++;
    if (d.decision === 'IGNORED') for (const r of d.rejectReasons) { bump(ignoredByReason, r); bump(missingConditionTally, r); }
    if (d.decision === 'BLOCKED') for (const r of d.rejectReasons) { bump(blockedByReason, r); bump(missingConditionTally, r); }
    if (d.decision === 'WATCH')   for (const r of d.rejectReasons) { bump(missingConditionTally, r); }
  }
  const topMissingCondition = Object.entries(missingConditionTally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    schemaVersion: 1, ts, feedPath, totalCandidates: diagnostics.length,
    decisionCounts, ignoredByReason, blockedByReason, missingConditionTally,
    readyCount: decisionCounts.READY, wouldBuyCount: decisionCounts.READY,
    approvedGateCount, approvedGateExplain, matchesNoBmResearchCount, matchesBestSubgroupCount, topMissingCondition,
    liveShadowOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true, unknownNeverClean: true,
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

function fmtUsd(n: number): string {
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
}

export function renderLiveShadowCycleSummary(r: LiveShadowCycleResult): string {
  const WIDE = '═'.repeat(70);
  const THIN = '─'.repeat(70);
  const L: string[] = [];

  L.push(WIDE);
  L.push('  TOKEN GRAB — LIVE-SHADOW EXECUTION MODE');
  L.push('  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);
  L.push('');
  L.push(`  TS              : ${r.ts}`);
  L.push(`  Feed            : ${r.feedPath}`);
  L.push(`  Candidates      : ${r.candidatesScanned}`);
  L.push(`  Ignored         : ${r.ignoredCount}`);
  L.push(`  Watch           : ${r.watchCount}`);
  L.push(`  Blocked         : ${r.blockedCount}`);
  L.push(`  Ready           : ${r.readyCount}`);
  L.push(`  Approved (gate) : ${r.approvedCount}`);
  L.push(`    ${r.approvedGateExplain}`);
  L.push('');

  // Per-candidate reject diagnostics
  L.push(THIN);
  L.push('  CANDIDATE DIAGNOSTICS (why each is IGNORED / WATCH / BLOCKED / READY)');
  L.push(THIN);
  if (r.diagnostics.length === 0) L.push('  (no candidates in current feed)');
  for (const d of r.diagnostics) {
    const c = d.contract.length > 12 ? d.contract.slice(0, 5) + '..' + d.contract.slice(-4) : d.contract;
    L.push(`  [${d.decision.padEnd(7)}] ${(d.symbol ?? '-').slice(0, 12).padEnd(12)} ${c.padEnd(12)} ` +
      `m5=${d.m5Band}  liq=${d.liquidityBucket}  vlr=${d.vlrBucket}  score=${d.ripperScoreBand}  cluster=${d.clusterRisk}`);
    L.push(`             noBmResearch=${d.matchesNoBmResearch ? 'YES' : 'no'}  bestSubgroup(VLR_0_5_TO_2)=${d.matchesBestSubgroup ? 'YES' : 'no'}  ` +
      `gate=${d.buyGateDecision}` + (d.rejectReasons.length ? `  reasons=[${d.rejectReasons.join('; ')}]` : ''));
  }
  L.push('');

  L.push(THIN);
  L.push('  BANKROLL SIMULATIONS');
  L.push(THIN);
  for (const b of r.bankrollSummaries) {
    L.push(`  $${b.bankroll} bankroll`);
    L.push(`    Would-buy this cycle  : ${b.wouldBuys}`);
    L.push(`    Would-sell this cycle : ${b.wouldSells}`);
    L.push(`    Open positions        : ${b.openPositions}`);
    L.push(`    Max position size     : $${b.riskLimits.maxPositionSizeUsd}`);
    L.push(`    Max daily buys        : ${b.riskLimits.maxDailyBuys}`);
    L.push(`    Max daily loss        : $${b.riskLimits.maxDailyLossUsd}`);
    L.push(`    Open position cap     : ${b.riskLimits.openPositionCap}`);
    L.push(`    Skipped (risk limit)  : ${b.skippedByRiskLimit}`);
    L.push(`    Kill-switch           : ${b.killSwitchActive ? `ACTIVE — ${b.killSwitchReason ?? ''}` : 'inactive'}`);
    L.push('');
  }

  L.push(THIN);
  L.push('  SAFETY');
  L.push(THIN);
  L.push('  LIVE_SHADOW_ONLY=true');
  L.push('  REAL_TRADING=false');
  L.push('  NO_WALLET=true');
  L.push('  NO_SWAP=true');
  L.push('  NO_SIGNING=true');
  L.push('  tradingExecuted=0  token:auto-paper NOT run  token:paper-buy NOT run  live-execution flag NOT supported');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);

  return L.join('\n');
}

export function renderLiveShadowUsage(): string {
  return `
token:live-shadow — LIVE-SHADOW execution mode: simulate real-time autonomous buy/sell
decisions using the current internal NO_BM research candidate logic. No wallet, no
private keys, no signing, no swap execution, no real funds.

Usage:
  npm run token:live-shadow [options]

Options:
  --feed <path>       live/current token feed JSON
                       (default: ${DEFAULT_LIVE_SHADOW_FEED_PATH})
  --state <path>       live-shadow state file
                       (default: ${DEFAULT_LIVE_SHADOW_STATE_PATH})
  --events <path>      live-shadow events jsonl
                       (default: ${DEFAULT_LIVE_SHADOW_EVENTS_PATH})
  --reset               clear live-shadow state before starting
  --help                 show this message

Safety:
  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true
  No wallet, no private keys, no signing, no swap execution, no real trades.
  Does not run token:auto-paper or token:paper-buy. No live-execution flag exists.
  Buy/sell gates are never loosened. UNKNOWN risk labels stay UNKNOWN — never CLEAN.
  DO_NOT_ENABLE_REAL_TRADING
`.trim();
}
