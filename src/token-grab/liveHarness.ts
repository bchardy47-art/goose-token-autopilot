import type { TokenGrabAutopsyCandidate, TokenGrabAutopsySnapshot } from './autopsy';
import type { TokenGrabLane } from './types';
import type { LiveAssistedDecision, LiveAssistedPnL } from './liveAssistedWatch';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_LIVE_POSITION_V1 = 1;
const LIVE_UNLOCK_ENV_REQUIRED_VALUE = 'I_UNDERSTAND_THIS_CAN_LOSE_MONEY';
const REQUIRED_CONFIRMATION_PHRASE = 'LIVE BUY $1 CONFIRM';
const MIN_ENTRY_LIQUIDITY_USD = 1_000;

const LIVE_BUY_ELIGIBLE_LANES: ReadonlySet<TokenGrabLane> = new Set([
  'EARLY_VELOCITY_WATCH',
  'FRESH_LAUNCH_CANDIDATE',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveHarnessStatus =
  | 'DRY_RUN_ONLY'
  | 'NO_TRADE'
  | 'LIVE_BLOCKED'
  | 'LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED'
  | 'LIVE_REQUIRES_CONFIRMATION'
  | 'LIVE_REJECTED_BY_GATES';

export type EntryConfirmationVerdict =
  | 'CONFIRMED'
  | 'REJECTED_PRICE_WEAK'
  | 'REJECTED_PRICE_DRAWDOWN'
  | 'REJECTED_LIQUIDITY_FADE'
  | 'REJECTED_CONFIRMED_LIQUIDITY_LOW'
  | 'REJECTED_CONFIRMED_LIQUIDITY_WEAK'
  | 'REJECTED_MISSING_SNAPSHOT'
  | 'NOT_REQUIRED';

export interface ConfirmedEntryQualityDiagnostics {
  minPriceChangePct: number;
  minLiquidityChangePct: number;
  minConfirmedLiquidityUsd: number;
  maxDrawdownPct: number;
  drawdownPass: boolean;
  pricePass: boolean;
  confirmedLiquidityPass: boolean;
  liquidityGrowthPass: boolean;
  volumeEntryUsd?: number;
  volumeConfirmUsd?: number;
  volumeChangePct?: number;
  entryVolumeToLiquidityRatio?: number;
  confirmVolumeToLiquidityRatio?: number;
  overallPass: boolean;
  failReasons: string[];
}

export interface EntryConfirmationResult {
  verdict: EntryConfirmationVerdict;
  entryPrice: number | null;
  confirmPrice: number | null;
  priceChangePct: number | null;
  entryLiquidityUsd: number | null;
  confirmLiquidityUsd: number | null;
  liquidityChangePct: number | null;
  reason: string;
  qualityDiagnostics?: ConfirmedEntryQualityDiagnostics;
}

export interface EvaluateEntryConfirmationInput {
  entrySnapshot: TokenGrabAutopsySnapshot | undefined;
  confirmSnapshot: TokenGrabAutopsySnapshot | undefined;
  minPriceChangePct: number;
  minLiquidityChangePct: number;
  maxDrawdownPct: number;
  minConfirmedLiquidityUsd: number;
}

export interface LiveTradePlan {
  candidateId: string;
  tokenName: string;
  ticker: string;
  contractAddress?: string;
  poolAddress?: string;
  lane: TokenGrabLane;
  entryPrice: number;
  liquidityAtEntry: number;
  maxLivePosition: number;
  slippageWarning: string;
  exitRule: string;
  status: 'PLAN_ONLY';
  planCreatedAt: string;
  qualityDiagnostics?: ConfirmedEntryQualityDiagnostics;
}

export interface LiveReadinessGateResult {
  gate: string;
  passed: boolean;
  reason?: string;
}

export interface LiveReadinessReport {
  status: LiveHarnessStatus;
  gates: LiveReadinessGateResult[];
  allGatesPassed: boolean;
}

export interface LiveHarnessSummary {
  ts: string;
  outDir: string;
  planFilePath?: string;
  status: LiveHarnessStatus;
  decision: LiveAssistedDecision;
  tradePlan?: LiveTradePlan;
  readiness: LiveReadinessReport;
  liveIntent: boolean;
  requireConfirmation: boolean;
  maxLivePosition: number;
  maxOpenPositions: 1;
  candidatesDetected: number;
  laneSummary: Record<string, number>;
  watchWorthyCount: number;
  notAutonomous: true;
  noRealTradeSent: true;
  autoPaperNotRun: true;
  skipSleepMode: boolean;
  watchCycle: boolean;
  watchCycleSkipped?: boolean;
  watchCycleSkipReason?: string;
  fakeBankroll: number;
  confirmMinConfirmedLiquidityUsd?: number;
  exitSnapshotPath?: string;
  fakePnL?: LiveAssistedPnL;
  confirmEntry: boolean;
  confirmMinutes: number;
  confirmSnapshotPath?: string;
  entryConfirmation?: EntryConfirmationResult;
}

export interface EvaluateLiveReadinessGatesInput {
  liveIntent: boolean;
  requireConfirmation: boolean;
  maxLivePosition: number;
  unlockEnvValue: string | undefined;
  decision: LiveAssistedDecision;
  candidate: TokenGrabAutopsyCandidate | undefined;
  snapshot: TokenGrabAutopsySnapshot | undefined;
  candidateCount: number;
  typedConfirmation?: string;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Returns percentage change from `from` to `to`. Returns 0 if `from` is zero.
 */
export function calculatePctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

/**
 * Builds per-criterion pass/fail diagnostics for a confirmed entry.
 * Volume fields are computed from snapshot data when available and are informational only — not blocking.
 * Pure — no I/O, no side effects.
 */
export function buildConfirmedEntryQualityDiagnostics(
  input: EvaluateEntryConfirmationInput,
  priceChangePct: number,
  liquidityChangePct: number | null,
  confirmLiquidityUsd: number | null,
): ConfirmedEntryQualityDiagnostics {
  const { minPriceChangePct, minLiquidityChangePct, maxDrawdownPct, minConfirmedLiquidityUsd, entrySnapshot, confirmSnapshot } = input;

  const drawdownPass = priceChangePct >= maxDrawdownPct;
  const pricePass = priceChangePct >= minPriceChangePct;
  const confirmedLiquidityPass = confirmLiquidityUsd == null || confirmLiquidityUsd >= minConfirmedLiquidityUsd;
  const liquidityGrowthPass = liquidityChangePct == null || liquidityChangePct >= minLiquidityChangePct;

  const failReasons: string[] = [];
  if (!drawdownPass) {
    failReasons.push(`price drawdown ${priceChangePct.toFixed(2)}% beyond threshold ${maxDrawdownPct}%`);
  }
  if (!pricePass) {
    failReasons.push(`price gain ${priceChangePct.toFixed(2)}% below required ${minPriceChangePct}%`);
  }
  if (!confirmedLiquidityPass && confirmLiquidityUsd != null) {
    failReasons.push(`confirmed liquidity $${confirmLiquidityUsd.toFixed(0)} below floor $${minConfirmedLiquidityUsd.toFixed(0)}`);
  }
  if (!liquidityGrowthPass && liquidityChangePct != null) {
    failReasons.push(`liquidity growth ${liquidityChangePct.toFixed(2)}% below required ${minLiquidityChangePct}%`);
  }

  const overallPass = drawdownPass && pricePass && confirmedLiquidityPass && liquidityGrowthPass;

  const volumeEntryUsd = entrySnapshot?.volumeUsd;
  const volumeConfirmUsd = confirmSnapshot?.volumeUsd;
  const entryLiqUsd = entrySnapshot?.liquidityUsd;
  const confirmLiqUsd = confirmSnapshot?.liquidityUsd;

  let volumeChangePct: number | undefined;
  if (volumeEntryUsd != null && volumeConfirmUsd != null && volumeEntryUsd > 0) {
    volumeChangePct = calculatePctChange(volumeEntryUsd, volumeConfirmUsd);
  }

  let entryVolumeToLiquidityRatio: number | undefined;
  if (volumeEntryUsd != null && entryLiqUsd != null && entryLiqUsd > 0) {
    entryVolumeToLiquidityRatio = volumeEntryUsd / entryLiqUsd;
  }

  let confirmVolumeToLiquidityRatio: number | undefined;
  if (volumeConfirmUsd != null && confirmLiqUsd != null && confirmLiqUsd > 0) {
    confirmVolumeToLiquidityRatio = volumeConfirmUsd / confirmLiqUsd;
  }

  return {
    minPriceChangePct,
    minLiquidityChangePct,
    minConfirmedLiquidityUsd,
    maxDrawdownPct,
    drawdownPass,
    pricePass,
    confirmedLiquidityPass,
    liquidityGrowthPass,
    volumeEntryUsd,
    volumeConfirmUsd,
    volumeChangePct,
    entryVolumeToLiquidityRatio,
    confirmVolumeToLiquidityRatio,
    overallPass,
    failReasons,
  };
}

/**
 * Evaluates the entry confirmation gate — checks that a second snapshot taken
 * after the entry shows sufficient price strength and liquidity health.
 * Pure — no I/O, no side effects.
 */
export function evaluateEntryConfirmation(
  input: EvaluateEntryConfirmationInput,
): EntryConfirmationResult {
  const { entrySnapshot, confirmSnapshot, minPriceChangePct, minLiquidityChangePct, maxDrawdownPct } = input;

  const entryPrice = entrySnapshot?.priceUsd ?? null;
  const confirmPrice = confirmSnapshot?.priceUsd ?? null;
  const entryLiquidityUsd = entrySnapshot?.liquidityUsd ?? null;
  const confirmLiquidityUsd = confirmSnapshot?.liquidityUsd ?? null;

  if (entrySnapshot == null || entryPrice == null || entryPrice <= 0) {
    return {
      verdict: 'REJECTED_MISSING_SNAPSHOT',
      entryPrice, confirmPrice,
      priceChangePct: null, entryLiquidityUsd, confirmLiquidityUsd, liquidityChangePct: null,
      reason: 'Entry snapshot or entry price unavailable',
    };
  }

  if (confirmSnapshot == null || confirmPrice == null || confirmPrice <= 0) {
    return {
      verdict: 'REJECTED_MISSING_SNAPSHOT',
      entryPrice, confirmPrice,
      priceChangePct: null, entryLiquidityUsd, confirmLiquidityUsd, liquidityChangePct: null,
      reason: 'Confirmation snapshot or confirmation price unavailable',
    };
  }

  const priceChangePct = calculatePctChange(entryPrice, confirmPrice);
  const liquidityChangePct =
    entryLiquidityUsd != null && entryLiquidityUsd > 0 && confirmLiquidityUsd != null
      ? calculatePctChange(entryLiquidityUsd, confirmLiquidityUsd)
      : null;

  // Build quality diagnostics for all subsequent returns (informational — does not affect verdict order).
  const qualityDiagnostics = buildConfirmedEntryQualityDiagnostics(
    input, priceChangePct, liquidityChangePct, confirmLiquidityUsd,
  );

  if (priceChangePct < maxDrawdownPct) {
    return {
      verdict: 'REJECTED_PRICE_DRAWDOWN',
      entryPrice, confirmPrice, priceChangePct, entryLiquidityUsd, confirmLiquidityUsd, liquidityChangePct, qualityDiagnostics,
      reason: `Price dropped ${priceChangePct.toFixed(2)}% — beyond drawdown threshold of ${maxDrawdownPct}%`,
    };
  }

  if (priceChangePct < minPriceChangePct) {
    return {
      verdict: 'REJECTED_PRICE_WEAK',
      entryPrice, confirmPrice, priceChangePct, entryLiquidityUsd, confirmLiquidityUsd, liquidityChangePct, qualityDiagnostics,
      reason: `Price gain ${priceChangePct.toFixed(2)}% below confirmation threshold of ${minPriceChangePct}%`,
    };
  }

  if (confirmLiquidityUsd !== null && confirmLiquidityUsd < input.minConfirmedLiquidityUsd) {
    return {
      verdict: 'REJECTED_CONFIRMED_LIQUIDITY_LOW',
      entryPrice, confirmPrice, priceChangePct, entryLiquidityUsd, confirmLiquidityUsd, liquidityChangePct, qualityDiagnostics,
      reason: `Confirmed liquidity $${confirmLiquidityUsd.toFixed(0)} below minimum $${input.minConfirmedLiquidityUsd.toFixed(0)}`,
    };
  }

  if (liquidityChangePct !== null && liquidityChangePct < minLiquidityChangePct) {
    const isActuallyFading = liquidityChangePct < 0;
    return {
      verdict: isActuallyFading ? 'REJECTED_LIQUIDITY_FADE' : 'REJECTED_CONFIRMED_LIQUIDITY_WEAK',
      entryPrice, confirmPrice, priceChangePct, entryLiquidityUsd, confirmLiquidityUsd, liquidityChangePct, qualityDiagnostics,
      reason: isActuallyFading
        ? `Liquidity faded ${liquidityChangePct.toFixed(2)}% — below threshold of ${minLiquidityChangePct}%`
        : `Liquidity growth ${liquidityChangePct.toFixed(2)}% below required threshold of ${minLiquidityChangePct}%`,
    };
  }

  const liqStr = liquidityChangePct != null
    ? `, liquidity ${liquidityChangePct >= 0 ? '+' : ''}${liquidityChangePct.toFixed(2)}%`
    : '';
  return {
    verdict: 'CONFIRMED',
    entryPrice, confirmPrice, priceChangePct, entryLiquidityUsd, confirmLiquidityUsd, liquidityChangePct, qualityDiagnostics,
    reason: `Price +${priceChangePct.toFixed(2)}% confirmed${liqStr}`,
  };
}

/**
 * Throws if maxLivePosition exceeds the V1 hard cap of $1.
 */
export function assertMaxLivePosition(maxLivePosition: number): void {
  if (maxLivePosition > MAX_LIVE_POSITION_V1) {
    throw new Error(
      `--max-live-position cannot exceed $${MAX_LIVE_POSITION_V1} in V1. Got: ${maxLivePosition}`,
    );
  }
}

/**
 * Returns the exact confirmation phrase the user must type to proceed.
 */
export function getRequiredConfirmationPhrase(): string {
  return REQUIRED_CONFIRMATION_PHRASE;
}

/**
 * Returns true if TOKEN_GRAB_LIVE_UNLOCK equals the required unlock value.
 */
export function parseLiveUnlockEnv(env: Record<string, string | undefined>): boolean {
  return env['TOKEN_GRAB_LIVE_UNLOCK'] === LIVE_UNLOCK_ENV_REQUIRED_VALUE;
}

/**
 * Builds a LiveTradePlan from a candidate and entry snapshot.
 * Pure — no I/O, no network, no execution.
 */
export function buildLiveTradePlan(
  candidate: TokenGrabAutopsyCandidate,
  snapshot: TokenGrabAutopsySnapshot,
  maxLivePosition: number,
  qualityDiagnostics?: ConfirmedEntryQualityDiagnostics,
): LiveTradePlan {
  return {
    candidateId: candidate.id,
    tokenName: candidate.tokenName,
    ticker: candidate.ticker,
    contractAddress: candidate.contractAddress,
    poolAddress: candidate.poolAddress,
    lane: candidate.lane,
    entryPrice: snapshot.priceUsd ?? 0,
    liquidityAtEntry: snapshot.liquidityUsd ?? 0,
    maxLivePosition,
    slippageWarning: 'High slippage risk on low-liquidity pools. V1: manual exit only.',
    exitRule: 'Manual exit only in V1. No auto-sell. No stop-loss execution.',
    status: 'PLAN_ONLY',
    planCreatedAt: snapshot.observedAt,
    qualityDiagnostics,
  };
}

/**
 * Evaluates all live readiness gates in order.
 * Returns early with DRY_RUN_ONLY (no liveIntent) or NO_TRADE (NO_BUY decision)
 * before running any gates.
 * Pure — no I/O, no side effects.
 */
export function evaluateLiveReadinessGates(
  input: EvaluateLiveReadinessGatesInput,
): LiveReadinessReport {
  if (input.decision === 'NO_BUY') {
    return { status: 'NO_TRADE', gates: [], allGatesPassed: false };
  }

  if (!input.liveIntent) {
    return { status: 'DRY_RUN_ONLY', gates: [], allGatesPassed: false };
  }

  const gates: LiveReadinessGateResult[] = [];

  const unlockOk = input.unlockEnvValue === LIVE_UNLOCK_ENV_REQUIRED_VALUE;
  gates.push({
    gate: 'UNLOCK_ENV',
    passed: unlockOk,
    reason: unlockOk
      ? undefined
      : 'TOKEN_GRAB_LIVE_UNLOCK env var is missing or incorrect',
  });

  gates.push({
    gate: 'REQUIRE_CONFIRMATION_FLAG',
    passed: input.requireConfirmation,
    reason: input.requireConfirmation ? undefined : '--require-confirmation flag not present',
  });

  const posOk = input.maxLivePosition <= MAX_LIVE_POSITION_V1;
  gates.push({
    gate: 'MAX_POSITION_LIMIT',
    passed: posOk,
    reason: posOk
      ? undefined
      : `maxLivePosition ${input.maxLivePosition} exceeds V1 limit of $${MAX_LIVE_POSITION_V1}`,
  });

  const singleOk = input.candidateCount === 1;
  gates.push({
    gate: 'SINGLE_CANDIDATE',
    passed: singleOk,
    reason: singleOk
      ? undefined
      : `Expected exactly 1 candidate, got ${input.candidateCount}`,
  });

  const laneOk =
    input.candidate != null &&
    (LIVE_BUY_ELIGIBLE_LANES as ReadonlySet<string>).has(input.candidate.lane);
  gates.push({
    gate: 'CANDIDATE_LANE',
    passed: laneOk,
    reason: laneOk
      ? undefined
      : `Candidate lane ${input.candidate?.lane ?? '(none)'} not in allowed set: EARLY_VELOCITY_WATCH, FRESH_LAUNCH_CANDIDATE`,
  });

  const snapOk = input.snapshot != null;
  gates.push({
    gate: 'ENTRY_SNAPSHOT_EXISTS',
    passed: snapOk,
    reason: snapOk ? undefined : 'Entry snapshot missing for selected candidate',
  });

  const priceOk =
    input.snapshot != null &&
    input.snapshot.priceUsd != null &&
    input.snapshot.priceUsd > 0;
  gates.push({
    gate: 'ENTRY_PRICE_VALID',
    passed: priceOk,
    reason: priceOk
      ? undefined
      : `Entry price unavailable or zero: ${input.snapshot?.priceUsd ?? '(none)'}`,
  });

  const liqOk =
    input.snapshot != null &&
    input.snapshot.liquidityUsd != null &&
    input.snapshot.liquidityUsd >= MIN_ENTRY_LIQUIDITY_USD;
  gates.push({
    gate: 'ENTRY_LIQUIDITY_MINIMUM',
    passed: liqOk,
    reason: liqOk
      ? undefined
      : `Liquidity $${(input.snapshot?.liquidityUsd ?? 0).toFixed(0)} below minimum $${MIN_ENTRY_LIQUIDITY_USD}`,
  });

  const nonConfirmFailed = gates.some(g => !g.passed);
  if (nonConfirmFailed) {
    return { status: 'LIVE_REJECTED_BY_GATES', gates, allGatesPassed: false };
  }

  // Confirmation gate — only reached when requireConfirmation passed (gate above)
  if (input.requireConfirmation) {
    if (input.typedConfirmation === undefined) {
      gates.push({ gate: 'CONFIRMATION_PHRASE', passed: false, reason: 'Confirmation not yet provided' });
      return { status: 'LIVE_REQUIRES_CONFIRMATION', gates, allGatesPassed: false };
    }
    const phraseOk = input.typedConfirmation === REQUIRED_CONFIRMATION_PHRASE;
    gates.push({
      gate: 'CONFIRMATION_PHRASE',
      passed: phraseOk,
      reason: phraseOk ? undefined : 'Typed confirmation phrase did not match required phrase',
    });
    if (!phraseOk) {
      return { status: 'LIVE_REJECTED_BY_GATES', gates, allGatesPassed: false };
    }
  }

  // All gates passed — V1 stops here; no executor exists
  return { status: 'LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED', gates, allGatesPassed: true };
}

/**
 * Renders the live harness summary as a terminal report.
 * Always includes safety confirmation lines.
 * No wallet, swap, signing, or key references.
 */
export function renderLiveHarnessReport(s: LiveHarnessSummary): string {
  const WIDE = '═'.repeat(64);
  const THIN = '─'.repeat(64);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  MANUAL-APPROVED LIVE HARNESS V1');
  lines.push('  NOT AUTONOMOUS');
  lines.push(
    `  DEFAULT DRY RUN: ${!s.liveIntent ? 'YES (--live-intent not set)' : 'NO (--live-intent set)'}`,
  );
  lines.push(`  MAX LIVE POSITION: $${s.maxLivePosition}`);
  lines.push(`  MAX OPEN POSITIONS: ${s.maxOpenPositions}`);
  lines.push('  token:auto-paper was NOT run');
  lines.push(WIDE);
  lines.push('');

  lines.push(THIN);
  lines.push('Detection');
  lines.push(THIN);
  lines.push(`  TS              : ${s.ts}`);
  lines.push(`  Candidates      : ${s.candidatesDetected}`);
  lines.push(`  Watch-worthy    : ${s.watchWorthyCount}`);
  for (const [lane, count] of Object.entries(s.laneSummary)) {
    lines.push(`    ${lane}: ${count}`);
  }
  if (s.skipSleepMode) lines.push('  [skip-sleep mode active]');
  lines.push('');

  lines.push(THIN);
  lines.push(`Paper Decision    : ${s.decision}`);
  lines.push(THIN);
  lines.push(`  Status          : ${s.status}`);
  lines.push('');

  if (s.confirmEntry && s.entryConfirmation) {
    const ec = s.entryConfirmation;
    lines.push(THIN);
    lines.push('Entry Confirmation Gate  [DRY-RUN — PAPER ONLY]');
    lines.push(THIN);
    lines.push(`  Verdict         : ${ec.verdict}`);
    const ep = ec.entryPrice != null ? `$${ec.entryPrice.toExponential(4)}` : '(unavailable)';
    const cp = ec.confirmPrice != null ? `$${ec.confirmPrice.toExponential(4)}` : '(unavailable)';
    lines.push(`  Entry price     : ${ep}`);
    lines.push(`  Confirm price   : ${cp}`);
    const pctStr = ec.priceChangePct != null
      ? `${ec.priceChangePct >= 0 ? '+' : ''}${ec.priceChangePct.toFixed(2)}%`
      : 'N/A';
    lines.push(`  Price change    : ${pctStr}`);
    if (ec.confirmLiquidityUsd != null) {
      lines.push(`  Confirm liq     : $${ec.confirmLiquidityUsd.toFixed(0)}`);
    }
    if (s.confirmMinConfirmedLiquidityUsd != null) {
      lines.push(`  Min confirm liq : $${s.confirmMinConfirmedLiquidityUsd}`);
    }
    if (ec.liquidityChangePct != null) {
      lines.push(`  Liquidity chg   : ${ec.liquidityChangePct >= 0 ? '+' : ''}${ec.liquidityChangePct.toFixed(2)}%`);
    }
    if (s.confirmSnapshotPath) {
      lines.push(`  Confirm snap    : ${s.confirmSnapshotPath}`);
    }
    if (ec.verdict !== 'CONFIRMED') {
      lines.push(`  Reject reason   : ${ec.reason}`);
    }
    lines.push('');

    // Quality diagnostics block (shown whenever confirmation ran, pass or fail)
    if (ec.qualityDiagnostics) {
      const diag = ec.qualityDiagnostics;
      lines.push(THIN);
      lines.push('Confirmed Entry Quality Diagnostics');
      lines.push(THIN);

      const priceStr = ec.priceChangePct != null
        ? `${ec.priceChangePct >= 0 ? '+' : ''}${ec.priceChangePct.toFixed(2)}%`
        : 'N/A';
      lines.push(`  Price          : ${diag.pricePass ? 'PASS' : 'FAIL'} ${priceStr} / required +${diag.minPriceChangePct}%`);

      const liqChangeStr = ec.liquidityChangePct != null
        ? `${ec.liquidityChangePct >= 0 ? '+' : ''}${ec.liquidityChangePct.toFixed(2)}%`
        : 'N/A';
      lines.push(`  Liquidity growth: ${diag.liquidityGrowthPass ? 'PASS' : 'FAIL'} ${liqChangeStr} / required +${diag.minLiquidityChangePct}%`);

      const liqAmountStr = ec.confirmLiquidityUsd != null ? `$${ec.confirmLiquidityUsd.toFixed(0)}` : 'N/A';
      lines.push(`  Confirmed liq  : ${diag.confirmedLiquidityPass ? 'PASS' : 'FAIL'} ${liqAmountStr} / required $${diag.minConfirmedLiquidityUsd}`);

      lines.push(`  Drawdown       : ${diag.drawdownPass ? 'PASS' : 'FAIL'}`);

      if (diag.entryVolumeToLiquidityRatio != null || diag.confirmVolumeToLiquidityRatio != null) {
        const entryR = diag.entryVolumeToLiquidityRatio != null ? diag.entryVolumeToLiquidityRatio.toFixed(2) : 'N/A';
        const confirmR = diag.confirmVolumeToLiquidityRatio != null ? diag.confirmVolumeToLiquidityRatio.toFixed(2) : 'N/A';
        lines.push(`  Vol/liq ratio  : ${entryR} entry → ${confirmR} confirm`);
      }

      lines.push(`  Overall        : ${diag.overallPass ? 'PASS' : 'FAIL'}`);

      if (!diag.overallPass && diag.failReasons.length > 0) {
        lines.push('  Fail reasons   :');
        for (const reason of diag.failReasons) {
          lines.push(`    - ${reason}`);
        }
      }
      lines.push('');
    }
  }

  if (s.tradePlan) {
    lines.push(THIN);
    lines.push('Live Trade Plan  [PLAN_ONLY — NOT EXECUTED]');
    lines.push(THIN);
    lines.push(`  Token           : $${s.tradePlan.ticker} (${s.tradePlan.lane})`);
    lines.push(`  Contract        : ${s.tradePlan.contractAddress ?? '(unknown)'}`);
    lines.push(`  Entry price     : $${s.tradePlan.entryPrice.toExponential(4)}`);
    lines.push(`  Liquidity       : $${s.tradePlan.liquidityAtEntry.toFixed(0)}`);
    lines.push(`  Max live pos    : $${s.tradePlan.maxLivePosition}`);
    lines.push(`  Exit rule       : ${s.tradePlan.exitRule}`);
    lines.push(`  Slippage warn   : ${s.tradePlan.slippageWarning}`);
    lines.push(`  Plan status     : ${s.tradePlan.status}`);
    if (s.planFilePath) lines.push(`  Plan file       : ${s.planFilePath}`);
    lines.push('');
  }

  if (s.readiness.gates.length > 0) {
    lines.push(THIN);
    lines.push('Live Readiness Gates');
    lines.push(THIN);
    for (const g of s.readiness.gates) {
      const icon = g.passed ? 'PASS' : 'FAIL';
      const reason = g.reason ? `  -> ${g.reason}` : '';
      lines.push(`  [${icon}] ${g.gate}${reason}`);
    }
    lines.push('');
  }

  if (s.watchCycle) {
    lines.push(THIN);
    lines.push('Watch Cycle  [DRY-RUN — PAPER ONLY]');
    lines.push(THIN);
    if (s.watchCycleSkipped) {
      lines.push(`  Skipped         : ${s.watchCycleSkipReason ?? 'No PLAN_ONLY trade plan was created.'}`);
    } else {
      if (s.exitSnapshotPath) {
        lines.push(`  Exit snapshot   : ${s.exitSnapshotPath}`);
      }
      if (s.fakePnL) {
        const exitPriceStr = s.fakePnL.fakeExitPrice != null
          ? `$${s.fakePnL.fakeExitPrice.toExponential(4)}`
          : '(unavailable)';
        lines.push(`  Exit price      : ${exitPriceStr}`);
        const sign = s.fakePnL.pnlDollars >= 0 ? '+' : '';
        lines.push(`  Fake P/L        : ${sign}$${s.fakePnL.pnlDollars.toFixed(4)} / ${sign}${s.fakePnL.pnlPct.toFixed(2)}%`);
        lines.push(`  Outcome         : ${s.fakePnL.outcome}`);
        lines.push(`  Ending bankroll : $${s.fakePnL.endingBankroll.toFixed(4)}`);
      } else if (s.decision === 'FAKE_BUY') {
        lines.push('  Exit price      : (unavailable)');
        lines.push('  Fake P/L        : UNKNOWN');
      }
    }
    lines.push('');
  }

  lines.push(THIN);
  lines.push('  Exact reason execution is blocked:');
  switch (s.status) {
    case 'DRY_RUN_ONLY':
      lines.push('  --live-intent was not passed. Running in dry-run mode.');
      lines.push('  No trade will be sent regardless of candidate quality.');
      break;
    case 'NO_TRADE':
      lines.push('  Paper decision was NO_BUY. No trade plan was prepared.');
      break;
    case 'LIVE_REJECTED_BY_GATES':
      lines.push('  One or more live readiness gates failed. See gates above.');
      break;
    case 'LIVE_REQUIRES_CONFIRMATION':
      lines.push(`  Awaiting confirmation phrase: "${getRequiredConfirmationPhrase()}"`);
      break;
    case 'LIVE_READY_BUT_EXECUTOR_NOT_IMPLEMENTED':
      lines.push('  All gates passed, but V1 has no trade executor.');
      lines.push('  Real execution requires a future PR with a safe executor abstraction.');
      break;
    case 'LIVE_BLOCKED':
      lines.push('  Execution is blocked. Check configuration.');
      break;
  }
  lines.push('');

  lines.push(WIDE);
  lines.push('  NOT AUTONOMOUS');
  lines.push('  NO REAL TRADE SENT');
  lines.push('  token:auto-paper was NOT run');
  lines.push('  No signing, swap execution, or key-loading performed in this run');
  lines.push('  Real trading remains locked until a future PR adds a safe executor');
  lines.push(WIDE);

  return lines.join('\n');
}
