// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  NO_GATE_CHANGES
//
// App Readiness Dashboard v1 — a REPORT_ONLY aggregator that answers one question:
// "Is Token Grab ready for anything beyond paper?" It runs (read-only) the upstream
// reports, extracts their key signals, and grades readiness across nine dimensions.
//
// HARD RULE: this dashboard NEVER recommends enabling real trading. The strongest
// allowed verdict is "ready for a SEPARATE manual gate proposal review", and only if
// the evidence supports it. UNKNOWN cluster risk is never treated as CLEAN.

import { runLearningLoopAudit }        from './ripperLearningLoopPropagationAudit';
import { runM5EvidenceDashboard }      from './ripperM5EvidenceDashboard';
import { runM5UsableSampleDeepDive }   from './ripperM5UsableSampleDeepDive';
import { runClusterCoverageAudit }     from './ripperClusterCoverageAudit';
import { runApprovedPriorityStudy }    from './ripperBubbleMapsApprovedPriorityStudy';
import { runRejectedOutcomeTracker }   from './ripperRejectedOutcomeTracker';
import { runExecutionRealismSimulator } from './ripperExecutionRealismSimulator';
import { runShadowPolicyBacktester }   from './ripperShadowPolicyBacktester';
import { runRipperAutopilotStatus }    from './ripperAutopilotStatus';

// ── Constants ──────────────────────────────────────────────────────────────────

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ───────────────────────────────────────────────────────────────────────

export type DimensionStatus = 'OK' | 'STUDY' | 'BLOCKED' | 'LOCKED';

export type ReadinessLabel =
  | 'PAPER_LOOP_HEALTHY'
  | 'EVIDENCE_COLLECTION_READY'
  | 'STUDY_READY'
  | 'GATE_PROPOSAL_REVIEW_READY'
  | 'NOT_READY_FOR_REAL_TRADING'
  | 'BLOCKED_BY_CLUSTER_COVERAGE'
  | 'BLOCKED_BY_EXECUTION_REALISM'
  | 'BLOCKED_BY_REJECTED_OUTCOME_GAP'
  | 'BLOCKED_BY_SAMPLE_SIZE'
  | 'SAFETY_LOCKS_OK';

export interface ReadinessDimension {
  name:    string;
  status:  DimensionStatus;
  labels:  ReadinessLabel[];
  detail:  string;
}

export interface AppReadinessResult {
  generatedAt: string;

  // raw child signals (compact — for JSON consumers / tests)
  signals: {
    m5PersistenceStatus:        string;
    m5EvidenceRecommendation:   string;
    m5EvidenceMaturity:         string;
    m5RowsWithPnl:              number;
    deepDiveRecommendation:     string;
    approvedUnknownPct:         number | null;
    approvedSufficientlyCovered: boolean;
    bubbleMapsDisabledCycles:   number;
    recentCyclesScanned:        number;
    rejectedWinners:            number;
    rejectedFalseRejectRate:    number | null;
    rejectedEvidenceMaturity:   string;
    execBaselineAvg:            number | null;
    execAdjustedAvg:            number | null;
    paperPnlOverstated:         boolean;
    shadowReadyPolicies:        string[];
    autopilotDecision:          string;
    realTradingLocked:          boolean;
    tradingExecuted:            number;
    mode:                       string;
  };

  dimensions:      ReadinessDimension[];
  blockers:        ReadinessLabel[];
  readinessLabels: ReadinessLabel[];
  nextBestAction:  string;
  finalVerdict:    string;
  childErrors:     string[];

  // safety
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  noMutation:        true;
  noRealTrading:     true;
  noGateChanges:     true;
  noPolicyChange:    true;
  noWallet:          true;
  noSwap:            true;
  noSigning:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface AppReadinessOptions {
  memoryPath?:       string;
  cyclesDir?:        string;
  intentsPath?:      string;
  observationsPath?: string;
  generatedAt?:      string;
}

// ── Helper: run a child safely ───────────────────────────────────────────────────

function safe<T>(label: string, fn: () => T, errors: string[]): T | null {
  try {
    return fn();
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Main runner ──────────────────────────────────────────────────────────────────

export function runAppReadinessDashboard(opts: AppReadinessOptions = {}): AppReadinessResult {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const childErrors: string[] = [];

  const mem      = opts.memoryPath;
  const cyclesD  = opts.cyclesDir;
  const intents  = opts.intentsPath;
  const obs      = opts.observationsPath;

  // ── Run all upstream reports (read-only). Each wrapped so one failure is non-fatal.
  const propagation = safe('propagation-audit', () => runLearningLoopAudit({
    memoryPath: mem, cyclesDir: cyclesD, intentsPath: intents, obsPath: obs,
  }), childErrors);
  const m5Evidence = safe('m5-evidence', () => runM5EvidenceDashboard({
    memoryPath: mem, intentsPath: intents, generatedAt,
  }), childErrors);
  const deepDive = safe('m5-deep-dive', () => runM5UsableSampleDeepDive({
    memoryPath: mem, generatedAt,
  }), childErrors);
  const cluster = safe('cluster-coverage', () => runClusterCoverageAudit({
    cyclesDir: cyclesD, memoryPath: mem, intentsPath: intents, observationsPath: obs, generatedAt,
  }), childErrors);
  const priority = safe('priority-study', () => runApprovedPriorityStudy({
    cyclesDir: cyclesD, memoryPath: mem, intentsPath: intents, generatedAt,
  }), childErrors);
  const rejected = safe('rejected-tracker', () => runRejectedOutcomeTracker({
    memoryPath: mem, generatedAt,
  }), childErrors);
  const execution = safe('execution-realism', () => runExecutionRealismSimulator({
    memoryPath: mem, generatedAt,
  }), childErrors);
  const shadow = safe('shadow-policy', () => runShadowPolicyBacktester({
    memoryPath: mem, generatedAt,
  }), childErrors);
  const autopilot = safe('autopilot-status', () => runRipperAutopilotStatus({
    cyclesDir: cyclesD, intentsPath: intents,
  }), childErrors);

  // ── Extract compact signals (defensive nulls). ──
  const shadowReady = (shadow?.policies ?? [])
    .filter(p => p.promotion === 'READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW')
    .map(p => p.id);

  const signals: AppReadinessResult['signals'] = {
    m5PersistenceStatus:        propagation?.m5PersistenceStatus ?? 'UNKNOWN',
    m5EvidenceRecommendation:   m5Evidence?.recommendation ?? 'UNKNOWN',
    m5EvidenceMaturity:         m5Evidence?.evidenceMaturity ?? 'UNKNOWN',
    m5RowsWithPnl:              m5Evidence?.m5RowsWithPnl ?? 0,
    deepDiveRecommendation:     deepDive?.recommendation ?? 'UNKNOWN',
    approvedUnknownPct:         cluster?.approvedVsRejected.approvedUnknownPct ?? null,
    approvedSufficientlyCovered: cluster?.approvedVsRejected.approvedSufficientlyCovered ?? false,
    bubbleMapsDisabledCycles:   priority?.bubbleMapsUsage.bubbleMapsDisabledCycles ?? 0,
    recentCyclesScanned:        priority?.bubbleMapsUsage.recentCyclesScanned ?? 0,
    rejectedWinners:            rejected?.rejectedWinners ?? 0,
    rejectedFalseRejectRate:    rejected?.falseRejectRate ?? null,
    rejectedEvidenceMaturity:   rejected?.evidenceMaturity ?? 'UNKNOWN',
    execBaselineAvg:            execution?.overall.baselineAvg ?? null,
    execAdjustedAvg:            execution?.overall.adjustedAvg ?? null,
    paperPnlOverstated:         execution?.diagnoses.includes('PAPER_PNL_OVERSTATED') ?? false,
    shadowReadyPolicies:        shadowReady,
    autopilotDecision:          autopilot?.decision ?? 'UNKNOWN',
    realTradingLocked:          autopilot?.realTradingLocked ?? true,
    tradingExecuted:            autopilot?.tradingExecuted ?? 0,
    mode:                       autopilot?.mode ?? 'PAPER_ONLY',
  };

  // ── Grade the nine dimensions. ──
  const dimensions: ReadinessDimension[] = [];

  // 1. Data plumbing
  {
    const ok = signals.m5PersistenceStatus === 'M5_FULLY_PERSISTED';
    dimensions.push({
      name: 'Data plumbing',
      status: ok ? 'OK' : 'BLOCKED',
      labels: ok ? ['PAPER_LOOP_HEALTHY'] : [],
      detail: `M5 persistence: ${signals.m5PersistenceStatus}. ` +
        (ok ? 'Learning loop propagates M5 through all stages.' : 'M5 not fully persisted — fix plumbing first.'),
    });
  }

  // 2. M5 evidence
  {
    const strongEnough = signals.m5RowsWithPnl >= 200;
    const status: DimensionStatus = strongEnough ? 'STUDY' : 'BLOCKED';
    const labels: ReadinessLabel[] = strongEnough ? ['EVIDENCE_COLLECTION_READY', 'STUDY_READY'] : ['BLOCKED_BY_SAMPLE_SIZE'];
    dimensions.push({
      name: 'M5 evidence',
      status,
      labels,
      detail: `${signals.m5RowsWithPnl} M5+PNL rows (${signals.m5EvidenceMaturity}); ` +
        `recommendation ${signals.m5EvidenceRecommendation}. ` +
        (strongEnough ? 'Usable for study; not yet gate-proposal strength (needs a band pnlN>=500).'
                      : 'Below 200 M5+PNL rows — keep collecting.'),
    });
  }

  // 3. Cluster / holder coverage
  {
    const blocked = !signals.approvedSufficientlyCovered ||
      (signals.recentCyclesScanned > 0 && signals.bubbleMapsDisabledCycles >= Math.ceil(signals.recentCyclesScanned / 2));
    dimensions.push({
      name: 'Cluster / holder coverage',
      status: blocked ? 'BLOCKED' : 'OK',
      labels: blocked ? ['BLOCKED_BY_CLUSTER_COVERAGE'] : [],
      detail: `Approved UNKNOWN ${fmtPct(signals.approvedUnknownPct)}; ` +
        `BubbleMaps disabled ${signals.bubbleMapsDisabledCycles}/${signals.recentCyclesScanned} recent cycles. ` +
        (blocked ? 'Approved rows are under-covered / BubbleMaps disabled — holder risk unresolved.'
                 : 'Approved holder coverage is sufficient.'),
    });
  }

  // 4. Rejected-outcome learning
  {
    const mature = signals.rejectedEvidenceMaturity === 'USABLE_SAMPLE' || signals.rejectedEvidenceMaturity === 'STRONG_SAMPLE';
    dimensions.push({
      name: 'Rejected-outcome learning',
      status: mature ? 'OK' : 'BLOCKED',
      labels: mature ? [] : ['BLOCKED_BY_REJECTED_OUTCOME_GAP'],
      detail: `${signals.rejectedWinners} rejected winners; false-reject rate ${fmtRate(signals.rejectedFalseRejectRate)}; ` +
        `maturity ${signals.rejectedEvidenceMaturity}. ` +
        (mature ? 'Rejected outcomes are being learned from on a usable sample.'
                : 'Rejected-outcome evidence is still thin.'),
    });
  }

  // 5. Execution realism
  {
    const blocked = signals.paperPnlOverstated;
    dimensions.push({
      name: 'Execution realism',
      status: blocked ? 'BLOCKED' : 'OK',
      labels: blocked ? ['BLOCKED_BY_EXECUTION_REALISM'] : [],
      detail: `Paper avg ${fmtPct(signals.execBaselineAvg)} → adjusted ${fmtPct(signals.execAdjustedAvg)} after costs. ` +
        (blocked ? 'Paper P/L is overstated — raw paper profit cannot justify any gate/trading change.'
                 : 'Execution-adjusted P/L holds up at current parameters.'),
    });
  }

  // 6. Shadow policy evidence
  {
    const anyReady = signals.shadowReadyPolicies.length > 0;
    dimensions.push({
      name: 'Shadow policy evidence',
      status: anyReady ? 'STUDY' : 'STUDY',
      labels: anyReady ? ['STUDY_READY', 'GATE_PROPOSAL_REVIEW_READY'] : ['STUDY_READY'],
      detail: anyReady
        ? `Policies eligible for SEPARATE gate proposal review: ${signals.shadowReadyPolicies.join(', ')} ` +
          '(subject to clearing blockers below — no change made).'
        : 'No candidate policy beat baseline on execution-adjusted P/L with a usable sample.',
    });
  }

  // 7. Safety locks
  {
    const ok = signals.realTradingLocked && signals.tradingExecuted === 0 && signals.mode === 'PAPER_ONLY';
    dimensions.push({
      name: 'Safety locks',
      status: ok ? 'LOCKED' : 'BLOCKED',
      labels: ok ? ['SAFETY_LOCKS_OK'] : [],
      detail: ok ? 'realTradingLocked=true, tradingExecuted=0, mode=PAPER_ONLY. Locks intact.'
                 : 'Safety locks not confirmed — investigate immediately.',
    });
  }

  // 8. Operational reliability
  {
    const staleDiag = (propagation?.diagnoses ?? []).some(d => /STALE/i.test(d));
    dimensions.push({
      name: 'Operational reliability',
      status: staleDiag ? 'STUDY' : 'OK',
      labels: [],
      detail: staleDiag
        ? 'Propagation audit reports a staleness condition — keep the normal loop running to advance observations.'
        : `Autopilot decision: ${signals.autopilotDecision}. Loop operational.`,
    });
  }

  // 9. Real-trading readiness — ALWAYS not ready.
  dimensions.push({
    name: 'Real-trading readiness',
    status: 'LOCKED',
    labels: ['NOT_READY_FOR_REAL_TRADING'],
    detail: 'Real trading is hard-locked and out of scope. It requires a SEPARATE manual approval process — ' +
      'this dashboard never authorizes it.',
  });

  // ── Aggregate. ──
  const blockers = uniq(dimensions.filter(d => d.status === 'BLOCKED').flatMap(d => d.labels)
    .filter(l => l.startsWith('BLOCKED_')) as ReadinessLabel[]);
  const readinessLabels = uniq([
    ...dimensions.flatMap(d => d.labels),
    'NOT_READY_FOR_REAL_TRADING' as ReadinessLabel,
  ]);

  const { nextBestAction, finalVerdict } = computeVerdict(signals, blockers, dimensions);

  return {
    generatedAt,
    signals,
    dimensions,
    blockers,
    readinessLabels,
    nextBestAction,
    finalVerdict,
    childErrors,
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    noMutation:        true,
    noRealTrading:     true,
    noGateChanges:     true,
    noPolicyChange:    true,
    noWallet:          true,
    noSwap:            true,
    noSigning:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
  };
}

function computeVerdict(
  signals: AppReadinessResult['signals'],
  blockers: ReadinessLabel[],
  _dimensions: ReadinessDimension[],
): { nextBestAction: string; finalVerdict: string } {
  // Next best action — highest-priority blocker first.
  let nextBestAction: string;
  if (blockers.includes('BLOCKED_BY_CLUSTER_COVERAGE')) {
    nextBestAction = 'Resolve holder coverage: review the BubbleMaps Paper Coverage Proposal and, in a SEPARATE ' +
      'manual step, consider enabling paper-only capped coverage so approved UNKNOWN rows get resolved.';
  } else if (blockers.includes('BLOCKED_BY_EXECUTION_REALISM')) {
    nextBestAction = 'Treat execution-adjusted P/L as the real baseline; do not act on raw paper profit. Study ' +
      'thin-liquidity and chase costs before any gate proposal.';
  } else if (blockers.includes('BLOCKED_BY_SAMPLE_SIZE')) {
    nextBestAction = 'Keep running the normal paper loop to grow M5+PNL evidence past the study thresholds.';
  } else if (blockers.includes('BLOCKED_BY_REJECTED_OUTCOME_GAP')) {
    nextBestAction = 'Mature rejected-outcome evidence by running the loop; many rejected rows still lack outcomes.';
  } else if (signals.shadowReadyPolicies.length > 0) {
    nextBestAction = `Prepare a SEPARATE manual gate proposal review for: ${signals.shadowReadyPolicies.join(', ')}. ` +
      'No automatic change.';
  } else {
    nextBestAction = 'Continue paper-only data collection and study. No gate proposal is warranted yet.';
  }

  // Final verdict — never authorizes real trading.
  const parts: string[] = [];
  parts.push('NOT_READY_FOR_REAL_TRADING (hard-locked, separate manual approval required).');
  if (signals.realTradingLocked && signals.tradingExecuted === 0) parts.push('Safety locks OK.');
  if (signals.m5RowsWithPnl >= 200) parts.push('STUDY_READY: evidence is usable for study.');
  if (signals.shadowReadyPolicies.length > 0 && blockers.length === 0) {
    parts.push(`GATE_PROPOSAL_REVIEW_READY for ${signals.shadowReadyPolicies.join(', ')} (separate manual review only).`);
  } else if (signals.shadowReadyPolicies.length > 0) {
    parts.push(`A gate proposal review for ${signals.shadowReadyPolicies.join(', ')} is premature — clear blockers first: ${blockers.join(', ')}.`);
  }
  if (blockers.length > 0) parts.push(`Blockers: ${blockers.join(', ')}.`);

  return { nextBestAction, finalVerdict: parts.join(' ') };
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function uniq<T>(arr: T[]): T[] { return [...new Set(arr)]; }
function fmtPct(v: number | null | undefined): string {
  if (v == null) return 'n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}
function fmtRate(v: number | null | undefined): string {
  if (v == null) return 'n/a';
  return (v * 100).toFixed(1) + '%';
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderAppReadinessDashboard(r: AppReadinessResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — APP READINESS DASHBOARD v1');
  L.push('  [REPORT ONLY — READ ONLY — PAPER ONLY — NO MUTATION — NEVER ENABLES REAL TRADING]');
  L.push('  Aggregates all reports. Strongest verdict: "ready for SEPARATE manual gate proposal review".');
  L.push(SEP, '');

  // §1 — Executive summary
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — EXECUTIVE SUMMARY');
  L.push(`  ${SEP2}`, '');
  L.push(`  Generated at      : ${r.generatedAt}`);
  L.push(`  Final verdict     : ${r.finalVerdict}`);
  L.push(`  Next best action  : ${r.nextBestAction}`);
  L.push(`  Blockers          : ${r.blockers.length ? r.blockers.join(', ') : '(none)'}`);
  L.push('');

  // §2 — Current mode
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — CURRENT MODE');
  L.push(`  ${SEP2}`, '');
  L.push(`  Mode              : ${r.signals.mode}`);
  L.push(`  Autopilot decision: ${r.signals.autopilotDecision}`);
  L.push(`  Real trading      : LOCKED (realTradingLocked=${r.signals.realTradingLocked}, tradingExecuted=${r.signals.tradingExecuted})`);
  L.push('');

  // §3–8 — dimension sections (mapped to the readiness dimensions)
  const dimSections: [string, string][] = [
    ['SECTION 3 — LEARNING LOOP HEALTH',     'Data plumbing'],
    ['SECTION 4 — EVIDENCE MATURITY',        'M5 evidence'],
    ['SECTION 5 — HOLDER / CLUSTER COVERAGE', 'Cluster / holder coverage'],
    ['SECTION 6 — EXECUTION REALISM',        'Execution realism'],
    ['SECTION 7 — REJECTED OUTCOME LEARNING', 'Rejected-outcome learning'],
    ['SECTION 8 — SHADOW POLICY RESULTS',    'Shadow policy evidence'],
  ];
  for (const [title, dimName] of dimSections) {
    const d = r.dimensions.find(x => x.name === dimName);
    L.push(`  ${SEP2}`);
    L.push(`  ${title}`);
    L.push(`  ${SEP2}`, '');
    if (d) {
      L.push(`  [${statusGlyph(d.status)} ${d.status}] ${d.labels.length ? d.labels.join(', ') : '(no label)'}`);
      L.push(`  ${d.detail}`);
    } else {
      L.push('  (signal unavailable)');
    }
    L.push('');
  }

  // §9 — Safety locks
  L.push(`  ${SEP2}`);
  L.push('  SECTION 9 — SAFETY LOCKS');
  L.push(`  ${SEP2}`, '');
  const safety = r.dimensions.find(d => d.name === 'Safety locks');
  const realtr = r.dimensions.find(d => d.name === 'Real-trading readiness');
  if (safety) L.push(`  [${statusGlyph(safety.status)} ${safety.status}] ${safety.detail}`);
  if (realtr) L.push(`  [${statusGlyph(realtr.status)} ${realtr.status}] ${realtr.detail}`);
  L.push('');

  // §10 — Blockers
  L.push(`  ${SEP2}`);
  L.push('  SECTION 10 — BLOCKERS');
  L.push(`  ${SEP2}`, '');
  if (r.blockers.length === 0) {
    L.push('  ✓ No hard blockers detected.');
  } else {
    for (const b of r.blockers) {
      const dim = r.dimensions.find(d => d.labels.includes(b));
      L.push(`  ⚠ ${b}${dim ? ` — ${dim.detail}` : ''}`);
    }
  }
  L.push('');

  // §11 — Next best action
  L.push(`  ${SEP2}`);
  L.push('  SECTION 11 — NEXT BEST ACTION');
  L.push(`  ${SEP2}`, '');
  L.push(`  ${r.nextBestAction}`);
  L.push('');

  // §12 — Final readiness verdict
  L.push(`  ${SEP2}`);
  L.push('  SECTION 12 — FINAL READINESS VERDICT');
  L.push(`  ${SEP2}`, '');
  L.push(`  ${r.finalVerdict}`);
  L.push('');
  L.push('  Readiness labels: ' + r.readinessLabels.join(', '));
  if (r.childErrors.length > 0) {
    L.push('');
    L.push('  Child report errors (non-fatal):');
    for (const e of r.childErrors) L.push(`    • ${e}`);
  }
  L.push('');

  // Safety footer
  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true   READ_ONLY=true   PAPER_ONLY=true   NO_MUTATION=true');
  L.push('  NO_REAL_TRADING=true   NO_GATE_CHANGES=true   NO_POLICY_CHANGE=true');
  L.push('  NO_WALLET=true   NO_SWAP=true   NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING   tradingExecuted=0   realTradingLocked=true');
  L.push('  This dashboard NEVER recommends enabling real trading. Real trading requires a separate manual process.');
  L.push(SEP, '');

  return L.join('\n');
}

function statusGlyph(s: DimensionStatus): string {
  return s === 'OK' ? '✓' : s === 'LOCKED' ? '🔒' : s === 'STUDY' ? 'ℹ' : '⚠';
}
