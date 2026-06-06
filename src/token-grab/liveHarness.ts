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
  fakeBankroll: number;
  exitSnapshotPath?: string;
  fakePnL?: LiveAssistedPnL;
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
