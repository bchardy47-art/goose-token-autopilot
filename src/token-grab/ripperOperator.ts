// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_PROMOTE_TO_REAL_TRADING  DO_NOT_TRADE
//
// Ripper Operator v1 — the final terminal operator command. One command that decides whether to
// COLLECT now, SKIP, or keep collecting. Terminal-first proof operation; no UI.
//
// It reads current proof state, checks latest-cycle freshness and the BubbleMaps rate-limit
// cooldown, classifies the window GOOD/BAD, and (only on a good window, or when --force is given)
// runs the bounded paper-only collection (fast-test --loops 1 --append-proof-log). It detects
// NO_NEW_EVIDENCE by comparing cohort observed counts before/after.
//
// Strictly paper-only research. Never enables real trading, never signs/swaps, never handles
// private keys, never calls the auto-paper or paper-buy commands, never adds live-execution
// behavior, never loosens gates or changes policy, never mutates trade/intent ledgers. UNKNOWN
// cluster risk is never treated as CLEAN. Decision logic is pure + dependency-injected for tests.

import * as fs from 'fs';

import {
  buildProofStatus, type ProofStatus, type ProofCycleInfo, type ConfidenceTier, type ProofDecision,
} from './ripperProof';
import type { FamilyReportResult, LaneKey } from './ripperWatchCohortFamily';

// ── Types ───────────────────────────────────────────────────────────────────────────

export type OperatorWindow = 'GOOD_WINDOW' | 'BAD_WINDOW';

export type OperatorReason =
  | 'COOLDOWN_ACTIVE'
  | 'STALE_FEED'
  | 'NO_FRESH_CANDIDATES'
  | 'NO_NEW_EVIDENCE';

export type OperatorFinalDecision = 'BAD_WINDOW_SKIP' | 'GOOD_WINDOW_COLLECT';

export interface OperatorCooldown {
  active:           boolean;
  expiresAt:        string | null;
  minutesRemaining: number | null;
}

export interface OperatorDecision {
  generatedAt:        string;
  bmEnabled:          boolean;         // BubbleMaps mode (OFF by default; cooldown ignored when off)
  latestCycle:        string | null;
  cycleFreshness:     ProofCycleInfo['status'];
  cooldownActive:     boolean;         // EFFECTIVE cooldown (always false when BM disabled)
  cooldownExpiresAt:  string | null;
  approvedLatest:     number;
  rejectedLatest:     number;
  bestLane:           LaneKey | null;
  bestLaneObserved:   number | null;
  bestLaneMedian:     number | null;
  bestLaneCappedAvg:  number | null;
  bestLaneRedLoss:    number | null;
  confidenceTier:     ConfidenceTier;
  proofRecommendation: ProofDecision;        // KEEP_COLLECTING / INVESTIGATE_LANE / PAPER_ONLY_CANDIDATE
  window:             OperatorWindow;
  collected:          boolean;
  forced:             boolean;
  reasons:            OperatorReason[];
  finalDecision:      OperatorFinalDecision;
  appendedSkippedProofLog: boolean;
  safety: {
    PAPER_ONLY:                true;
    realTradingLocked:         boolean;
    tradingExecuted:           number;
    UNKNOWN_NEVER_CLEAN:       true;
    DO_NOT_TRADE:              true;
    DO_NOT_ENABLE_REAL_TRADING: true;
  };
}

// ── Cooldown reader (read-only) ───────────────────────────────────────────────────────

/** Read the BubbleMaps rate-limit cooldown marker. Missing/malformed → inactive. Never throws. */
export function readOperatorCooldown(cooldownPath: string, nowMs: number): OperatorCooldown {
  if (!fs.existsSync(cooldownPath)) return { active: false, expiresAt: null, minutesRemaining: null };
  let parsed: { expiresAt?: string };
  try {
    parsed = JSON.parse(fs.readFileSync(cooldownPath, 'utf-8')) as typeof parsed;
  } catch {
    return { active: false, expiresAt: null, minutesRemaining: null };
  }
  const expiresMs = parsed.expiresAt ? Date.parse(parsed.expiresAt) : NaN;
  const active = !Number.isNaN(expiresMs) && nowMs < expiresMs;
  return {
    active,
    expiresAt:        parsed.expiresAt ?? null,
    minutesRemaining: active ? Math.max(0, Math.ceil((expiresMs - nowMs) / 60_000)) : null,
  };
}

// ── Window assessment (pure) ──────────────────────────────────────────────────────────

export interface AssessWindowInput {
  cooldownActive:  boolean;
  freshness:       ProofCycleInfo['status'];
  approvedLatest:  number;
  force:           boolean;
}

export interface WindowAssessment {
  window:        OperatorWindow;
  badReasons:    OperatorReason[];   // pre-collection reasons (never includes NO_NEW_EVIDENCE)
  shouldCollect: boolean;
}

function isStaleFreshness(s: ProofCycleInfo['status']): boolean {
  return s !== 'FRESH';
}

export function assessWindow(input: AssessWindowInput): WindowAssessment {
  const badReasons: OperatorReason[] = [];
  if (input.cooldownActive)              badReasons.push('COOLDOWN_ACTIVE');
  if (isStaleFreshness(input.freshness)) badReasons.push('STALE_FEED');
  if (input.approvedLatest <= 0)         badReasons.push('NO_FRESH_CANDIDATES');

  const window: OperatorWindow = badReasons.length > 0 ? 'BAD_WINDOW' : 'GOOD_WINDOW';
  const shouldCollect = window === 'GOOD_WINDOW' || input.force;
  return { window, badReasons, shouldCollect };
}

// ── Decision assembly (pure) ──────────────────────────────────────────────────────────

export interface AssembleOperatorInput {
  generatedAt:             string;
  bmEnabled:               boolean;
  status:                  ProofStatus;     // proof state to REPORT (post-collection if collected)
  cooldown:                OperatorCooldown; // EFFECTIVE cooldown (already gated by BM mode)
  approvedLatest:          number;
  rejectedLatest:          number;
  window:                  OperatorWindow;
  badReasons:              OperatorReason[];
  forced:                  boolean;
  collected:              boolean;
  noNewEvidence:          boolean;
  appendedSkippedProofLog: boolean;
  realTradingLocked:       boolean;
  tradingExecuted:         number;
}

export function assembleOperatorDecision(input: AssembleOperatorInput): OperatorDecision {
  const { status } = input;
  const bestKey = status.bestLane?.lane ?? null;
  const bestLaneMetrics = bestKey ? status.lanes.find(l => l.lane === bestKey) ?? null : null;

  const reasons: OperatorReason[] = [...input.badReasons];
  if (input.collected && input.noNewEvidence) reasons.push('NO_NEW_EVIDENCE');

  const finalDecision: OperatorFinalDecision = input.collected ? 'GOOD_WINDOW_COLLECT' : 'BAD_WINDOW_SKIP';

  return {
    generatedAt:        input.generatedAt,
    bmEnabled:          input.bmEnabled,
    latestCycle:        status.latestCycle.id,
    cycleFreshness:     status.latestCycle.status,
    cooldownActive:     input.cooldown.active,
    cooldownExpiresAt:  input.cooldown.expiresAt,
    approvedLatest:     input.approvedLatest,
    rejectedLatest:     input.rejectedLatest,
    bestLane:           bestKey,
    bestLaneObserved:   status.bestLane?.observed ?? null,
    bestLaneMedian:     bestLaneMetrics ? bestLaneMetrics.medianPnl : null,
    bestLaneCappedAvg:  bestLaneMetrics ? bestLaneMetrics.avgPnlCapped : null,
    bestLaneRedLoss:    bestLaneMetrics ? bestLaneMetrics.redLossRate : null,
    confidenceTier:     status.confidenceTier,
    proofRecommendation: status.decision,
    window:             input.window,
    collected:          input.collected,
    forced:             input.forced,
    reasons,
    finalDecision,
    appendedSkippedProofLog: input.appendedSkippedProofLog,
    safety: {
      PAPER_ONLY:                 true,
      realTradingLocked:          input.realTradingLocked,
      tradingExecuted:            input.tradingExecuted,
      UNKNOWN_NEVER_CLEAN:        true,
      DO_NOT_TRADE:               true,
      DO_NOT_ENABLE_REAL_TRADING: true,
    },
  };
}

// ── Orchestration (dependency-injected) ───────────────────────────────────────────────

export interface OperatorProofState {
  report:       FamilyReportResult;
  cycle:        ProofCycleInfo;
  runsObserved: number | null;
}

export interface OperatorDeps {
  /** Read current proof state (read-only family report + latest cycle + proof-log run count). */
  readProofState: () => OperatorProofState;
  /** Read the BubbleMaps cooldown marker. */
  readCooldown:   () => OperatorCooldown;
  /** Read autopilot gate counts + safety (read-only). */
  autopilot:      () => { approvedCount: number; rejectedCount: number; realTradingLocked: boolean; tradingExecuted: number };
  /** Run the bounded paper-only collection (fast-test --loops 1 --append-proof-log). */
  runCollection:  (opts: { dryRunEnroll: boolean; skipDayWatch: boolean }) => void;
  /** Append ONE skipped proof snapshot (only called when --append-skipped-proof-log). */
  appendSkippedProof: (status: ProofStatus, cycle: ProofCycleInfo) => void;
  now:            () => number;
}

export interface OperatorOptions {
  force?:                 boolean;
  dryRunEnroll?:          boolean;
  skipDayWatch?:          boolean;
  appendSkippedProofLog?: boolean;
  bmEnabled?:             boolean;   // BubbleMaps mode — default OFF; when off, cooldown never blocks
  generatedAt?:           string;
}

function totalObserved(status: ProofStatus): number {
  return status.lanes.reduce((sum, l) => sum + l.observed, 0);
}

export function runOperator(opts: OperatorOptions, deps: OperatorDeps): OperatorDecision {
  const force                 = opts.force ?? false;
  const dryRunEnroll          = opts.dryRunEnroll ?? false;
  const skipDayWatch          = opts.skipDayWatch ?? false;
  const appendSkippedProofLog = opts.appendSkippedProofLog ?? false;
  const bmEnabled             = opts.bmEnabled ?? false;   // BubbleMaps OFF by default
  const generatedAt           = opts.generatedAt ?? new Date(deps.now()).toISOString();

  // 1-4. Read current proof state, cooldown, autopilot.
  const before   = deps.readProofState();
  const auto     = deps.autopilot();
  // BubbleMaps cooldown ONLY matters when BubbleMaps is enabled. When BM is disabled (the
  // default, research-only mode), the operator NEVER reads/respects the cooldown — it must not
  // block paper-evidence collection. Stale-feed / no-fresh-candidate skips still apply.
  const cooldown: OperatorCooldown = bmEnabled
    ? deps.readCooldown()
    : { active: false, expiresAt: null, minutesRemaining: null };
  const statusBefore = buildProofStatus({
    generatedAt, report: before.report, cycle: before.cycle, fastTestRunsObserved: before.runsObserved,
  });

  // 5. Classify the window from pre-collection signals.
  const assess = assessWindow({
    cooldownActive: cooldown.active,
    freshness:      before.cycle.status,
    approvedLatest: auto.approvedCount,
    force,
  });

  let collected = false;
  let noNewEvidence = false;
  let statusFinal = statusBefore;
  let appendedSkipped = false;

  if (assess.shouldCollect) {
    // 7. Collect: run bounded fast-test (which appends a proof snapshot itself).
    const observedBefore = totalObserved(statusBefore);
    deps.runCollection({ dryRunEnroll, skipDayWatch });
    const after = deps.readProofState();
    statusFinal = buildProofStatus({
      generatedAt, report: after.report, cycle: after.cycle, fastTestRunsObserved: after.runsObserved,
    });
    collected = true;
    noNewEvidence = totalObserved(statusFinal) <= observedBefore;
  } else if (appendSkippedProofLog) {
    // 6. Skipped — only append a skipped snapshot when explicitly requested.
    deps.appendSkippedProof(statusBefore, before.cycle);
    appendedSkipped = true;
  }

  return assembleOperatorDecision({
    generatedAt,
    bmEnabled,
    status:            statusFinal,
    cooldown,
    approvedLatest:    auto.approvedCount,
    rejectedLatest:    auto.rejectedCount,
    window:            assess.window,
    badReasons:        assess.badReasons,
    forced:            force && assess.window === 'BAD_WINDOW',
    collected,
    noNewEvidence,
    appendedSkippedProofLog: appendedSkipped,
    realTradingLocked: auto.realTradingLocked,
    tradingExecuted:   auto.tradingExecuted,
  });
}

// ── Renderer ──────────────────────────────────────────────────────────────────────────

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

function pctS(v: number | null): string { return v == null ? 'n/a' : (v * 100).toFixed(1) + '%'; }
function pnlS(v: number | null): string { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }

export function renderOperatorDecision(d: OperatorDecision): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — RIPPER OPERATOR (PAPER ONLY — TERMINAL PROOF OPERATION)');
  L.push('  [READ ONLY EXCEPT APPEND-ONLY PROOF/COHORT — UNKNOWN ≠ CLEAN — DO_NOT_TRADE]');
  L.push(SEP, '');
  L.push(`  Generated at      : ${d.generatedAt}`);
  L.push(`  Latest cycle      : ${d.latestCycle ?? '(none)'}`);
  L.push(`  BubbleMaps        : ${d.bmEnabled ? 'ENABLED' : 'DISABLED (research-only; cooldown ignored)'}`);
  L.push(`  Cycle freshness   : ${d.cycleFreshness}`);
  L.push(`  Cooldown active   : ${d.cooldownActive ? 'YES' : 'no'}` +
    `${!d.bmEnabled ? '  (BubbleMaps disabled)' : d.cooldownActive && d.cooldownExpiresAt ? `  (expires ${d.cooldownExpiresAt})` : ''}`);
  L.push(`  Approved / reject : ${d.approvedLatest} / ${d.rejectedLatest}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  BEST LANE');
  L.push(`  ${SEP2}`);
  if (d.bestLane) {
    L.push(`    ${d.bestLane}  observed=${d.bestLaneObserved ?? 0}  ` +
      `median=${pnlS(d.bestLaneMedian)}  cappedAvg=${pnlS(d.bestLaneCappedAvg)}  redLoss=${pctS(d.bestLaneRedLoss)}`);
  } else {
    L.push('    (no lane has observed outcomes yet)');
  }
  L.push(`    Confidence tier   : ${d.confidenceTier}`);
  L.push(`    Proof recommend.  : ${d.proofRecommendation}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  OPERATOR DECISION');
  L.push(`  ${SEP2}`);
  L.push(`    Window          : ${d.window}${d.forced ? '  (FORCED collect)' : ''}`);
  L.push(`    Collected       : ${d.collected ? 'YES' : 'no'}`);
  if (d.reasons.length > 0) L.push(`    Reasons         : ${d.reasons.join(', ')}`);
  if (d.appendedSkippedProofLog) L.push('    Skipped snapshot: appended to proof-log (--append-skipped-proof-log)');
  L.push(`    FINAL DECISION  : ${d.finalDecision}`);
  L.push('    A PAPER_ONLY_CANDIDATE is paper-only research — it is NEVER a buy signal.');
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`);
  L.push(`    PAPER_ONLY=true  realTradingLocked=${d.safety.realTradingLocked}  tradingExecuted=${d.safety.tradingExecuted}`);
  L.push('    UNKNOWN_NEVER_CLEAN=true  noBuySignal=true  noIntentMutation=true');
  L.push('    DO_NOT_ENABLE_REAL_TRADING  DO_NOT_PROMOTE_TO_REAL_TRADING  DO_NOT_TRADE');
  L.push('    DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  L.push(SEP, '');
  return L.join('\n');
}
