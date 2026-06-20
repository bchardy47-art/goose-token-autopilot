// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  NO_GATE_CHANGES  NO_AUTO_ENABLEMENT
//
// BubbleMaps Paper Coverage Enablement Proposal v1 — a REPORT_ONLY proposal that
// describes how holder-risk (BubbleMaps) coverage COULD be safely re-enabled in
// PAPER_ONLY mode, with approved-first priority, strict caps, and cache-first
// behavior. It does NOT apply any config, does NOT call BubbleMaps, does NOT change
// gates or policy, and does NOT enable anything. UNKNOWN is NEVER treated as CLEAN.
//
// The proposal reads the real config surface (env flags, cache file) and reuses the
// approved-priority study simulation to estimate the data improvement that paper
// coverage would yield — purely as a recommendation for a SEPARATE manual decision.

import * as fs from 'fs';

import {
  runApprovedPriorityStudy,
  type ApprovedPriorityStudyResult,
} from './ripperBubbleMapsApprovedPriorityStudy';
import {
  DEFAULT_CACHE_PATH,
  BUBBLEMAPS_MAX_CALLS_PER_RUN_DEFAULT,
} from './bubbleMapsCache';

// ── Constants ──────────────────────────────────────────────────────────────────

const ENV_DISABLED_FLAG = 'TOKEN_GRAB_BUBBLEMAPS_DISABLED';
const ENV_CAP_FLAG      = 'TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN';

// Conservative bounds for the FIRST paper-only cap. Intentionally small — this is a
// data-collection ramp, not a throughput target.
const MIN_INITIAL_CAP = 5;
const MAX_INITIAL_CAP = 20;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ───────────────────────────────────────────────────────────────────────

export interface BubbleMapsConfigState {
  disabledFlagName:    string;
  disabledFlagValue:   string | null;
  disabledActive:      boolean;
  capFlagName:         string;
  capFlagValue:        string | null;
  effectiveCap:        number;        // resolved cap given env (default if unset)
  defaultCap:          number;
  mode:                'DISABLED' | 'CACHE_ONLY' | 'LIVE_CAPPED';
  cachePath:           string;
  cacheExists:         boolean;
  cacheEntryCount:     number;
  supportsSafePaperMode: boolean;     // does the app already have a paper-only path?
  note:                string;
}

export interface CapPlan {
  observedApprovedDemandPerCycle: number;   // recent approved UNKNOWN per cycle
  recommendedInitialCap:          number;
  minInitialCap:                  number;
  maxInitialCap:                  number;
  rationale:                      string;
}

export interface CacheFirstPlan {
  cacheEntryCount:        number;
  ttlNote:                string;
  approvedRowsMaybeCached: number;          // approved UNKNOWN rows that MAY resolve from cache
  note:                   string;
}

export interface ExpectedImprovement {
  approvedUnknownTotal:           number;
  approvedUnknownResolvedEstimate: number;  // under the recommended cap, approved-first
  m5ApprovedUnknownResolvedEstimate: number;
  rejectedDeferredEstimate:       number;
  currentApprovedCoveragePct:     number | null;
  projectedApprovedCoveragePct:   number | null;
  approvedCoverageImprovementPct: number | null;
  assumedCapUsed:                 number;
  note:                           string;
}

export type ProposalRecommendation =
  | 'DO_NOT_ENABLE_YET'
  | 'PAPER_COVERAGE_PROPOSAL_READY'
  | 'NEEDS_CONFIG_DISCOVERY'
  | 'NEEDS_FALLBACK_PROVIDER'
  | 'NEEDS_INVESTIGATION';

export interface PaperCoverageProposalResult {
  generatedAt: string;

  // §2
  configState: BubbleMapsConfigState;

  // §3 — coverage gap (from the approved-priority study)
  approvedUnknownPct:  number | null;
  rejectedUnknownPct:  number | null;
  approvedUnknownGapVsRejected: number | null;
  bubbleMapsDisabledCycles: number;
  recentCyclesScanned:      number;

  // §6 — cap plan
  capPlan: CapPlan;

  // §7 — cache-first plan
  cacheFirstPlan: CacheFirstPlan;

  // §9 — expected improvement
  expectedImprovement: ExpectedImprovement;

  // failure / rollback
  failureModes:  string[];
  rollbackSteps: string[];

  // what this does NOT change
  doesNotChange: string[];

  // §11 — recommendation
  recommendations:       ProposalRecommendation[];
  exactConfigChange:     string[];   // the precise env change, described, NOT applied
  recommendationNotes:   string[];

  // safety
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  noMutation:        true;
  noRealTrading:     true;
  noGateChanges:     true;
  noPolicyChange:    true;
  noConfigApplied:   true;
  noAutoEnable:      true;
  noBubbleMapsCall:  true;
  noWallet:          true;
  noSwap:            true;
  noSigning:         true;
  realTradingLocked: true;
  configChanged:     false;
  tradingExecuted:   0;
}

export interface PaperCoverageProposalOptions {
  cyclesDir?:   string;
  memoryPath?:  string;
  intentsPath?: string;
  recent?:      number;
  cachePath?:   string;
  // env overrides (testability — defaults read process.env)
  disabledEnv?: string | null;
  capEnv?:      string | null;
  generatedAt?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function countCacheEntries(cachePath: string): number {
  if (!fs.existsSync(cachePath)) return 0;
  try {
    return fs.readFileSync(cachePath, 'utf-8').split('\n').filter(l => l.trim()).length;
  } catch {
    return 0;
  }
}

function isDisabledFlag(v: string | null): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true';
}

function resolveCap(capEnv: string | null): number {
  if (capEnv != null && capEnv.trim() !== '') {
    const n = Number(capEnv);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return BUBBLEMAPS_MAX_CALLS_PER_RUN_DEFAULT;
}

// ── Main runner ──────────────────────────────────────────────────────────────────

export function runPaperCoverageProposal(
  opts: PaperCoverageProposalOptions = {},
): PaperCoverageProposalResult {
  const cachePath   = opts.cachePath ?? DEFAULT_CACHE_PATH;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  const disabledEnv = opts.disabledEnv !== undefined
    ? opts.disabledEnv : (process.env[ENV_DISABLED_FLAG] ?? null);
  const capEnv = opts.capEnv !== undefined
    ? opts.capEnv : (process.env[ENV_CAP_FLAG] ?? null);

  const disabledActive = isDisabledFlag(disabledEnv);
  const effectiveCap   = resolveCap(capEnv);
  const mode: BubbleMapsConfigState['mode'] =
    disabledActive       ? 'DISABLED'   :
    effectiveCap === 0   ? 'CACHE_ONLY' : 'LIVE_CAPPED';

  const cacheEntryCount = countCacheEntries(cachePath);

  // ── Pull coverage gap + simulation from the approved-priority study. ──
  // First pass uses the study's default assumed cap to learn the demand.
  const probe: ApprovedPriorityStudyResult = runApprovedPriorityStudy({
    cyclesDir:   opts.cyclesDir,
    memoryPath:  opts.memoryPath,
    intentsPath: opts.intentsPath,
    recent:      opts.recent,
    generatedAt,
  });

  const recentCycles = probe.bubbleMapsUsage.recentCyclesScanned;
  const approvedUnknownRecent = probe.coverageRecent.approvedUnknown;
  const observedApprovedDemandPerCycle = recentCycles > 0
    ? Math.ceil(approvedUnknownRecent / recentCycles) : 0;

  // Conservative initial cap: cover the per-cycle approved demand, clamped to a
  // small safe range. This is a data-collection ramp, not a throughput target.
  const recommendedInitialCap = Math.max(
    MIN_INITIAL_CAP,
    Math.min(MAX_INITIAL_CAP, observedApprovedDemandPerCycle || MIN_INITIAL_CAP),
  );

  // Re-run the study with the recommended cap so the estimate is tailored to the plan.
  const tailored: ApprovedPriorityStudyResult = runApprovedPriorityStudy({
    cyclesDir:   opts.cyclesDir,
    memoryPath:  opts.memoryPath,
    intentsPath: opts.intentsPath,
    recent:      opts.recent,
    assumedCap:  recommendedInitialCap,
    generatedAt,
  });
  const sim = tailored.hypotheticalSimulation;

  const configState: BubbleMapsConfigState = {
    disabledFlagName:  ENV_DISABLED_FLAG,
    disabledFlagValue: disabledEnv,
    disabledActive,
    capFlagName:       ENV_CAP_FLAG,
    capFlagValue:      capEnv,
    effectiveCap,
    defaultCap:        BUBBLEMAPS_MAX_CALLS_PER_RUN_DEFAULT,
    mode,
    cachePath,
    cacheExists:       cacheEntryCount > 0,
    cacheEntryCount,
    // The cluster-risk / BubbleMaps path is holder-risk evidence only — it NEVER
    // touches trading, wallet, or gates. A cache-first, capped, paper-only mode
    // already exists in code (BubbleMapsCache: DISABLED / CACHE_ONLY / LIVE_CAPPED).
    supportsSafePaperMode: true,
    note: disabledActive
      ? `BubbleMaps is DISABLED via ${ENV_DISABLED_FLAG}=${disabledEnv}. No live calls are made; ` +
        `every uncached lookup returns UNKNOWN. The app already supports a safe paper-only LIVE_CAPPED ` +
        `mode — it is simply turned off.`
      : mode === 'CACHE_ONLY'
        ? `BubbleMaps is in CACHE_ONLY mode (${ENV_CAP_FLAG}=0). Cache hits resolve; uncached lookups return UNKNOWN.`
        : `BubbleMaps is in LIVE_CAPPED mode (cap=${effectiveCap}). Live calls flow, cache-first, up to the cap.`,
  };

  const capPlan: CapPlan = {
    observedApprovedDemandPerCycle,
    recommendedInitialCap,
    minInitialCap: MIN_INITIAL_CAP,
    maxInitialCap: MAX_INITIAL_CAP,
    rationale:
      `Recent approved UNKNOWN demand is ~${observedApprovedDemandPerCycle}/cycle ` +
      `(${approvedUnknownRecent} approved UNKNOWN across ${recentCycles} recent cycles). ` +
      `A conservative initial cap of ${recommendedInitialCap} covers approved-first demand per cycle ` +
      `while bounding API usage. Raise gradually only if data quality improves and rate limits allow.`,
  };

  const approvedRowsMaybeCached = Math.min(cacheEntryCount, probe.coverageAll.approvedUnknown);
  const cacheFirstPlan: CacheFirstPlan = {
    cacheEntryCount,
    ttlNote: 'BubbleMaps cache TTL is 24h; cache-first lookups cost 0 live calls and return instantly.',
    approvedRowsMaybeCached,
    note:
      `${cacheEntryCount} cache entries present. Cache-first behavior is already built in: a lookup checks ` +
      `the persistent cache before spending any live call. Up to ~${approvedRowsMaybeCached} approved UNKNOWN ` +
      `rows could resolve from cache alone (upper bound; depends on contract overlap and 24h freshness).`,
  };

  const expectedImprovement: ExpectedImprovement = {
    approvedUnknownTotal:              probe.coverageAll.approvedUnknown,
    approvedUnknownResolvedEstimate:   sim.approvedCoveredFirst,
    m5ApprovedUnknownResolvedEstimate: sim.approvedM5CoveredFirst,
    rejectedDeferredEstimate:          sim.rejectedDeferred,
    currentApprovedCoveragePct:        sim.currentApprovedCoveragePct,
    projectedApprovedCoveragePct:      sim.projectedApprovedCoveragePct,
    approvedCoverageImprovementPct:    sim.approvedCoverageImprovementPct,
    assumedCapUsed:                    recommendedInitialCap,
    note:
      `Under approved-first allocation at a per-cycle cap of ${recommendedInitialCap}, an estimated ` +
      `${sim.approvedCoveredFirst} approved UNKNOWN rows (of which ${sim.approvedM5CoveredFirst} are M5) ` +
      `would be holder-covered first, deferring ~${sim.rejectedDeferred} rejected rows. ` +
      `Approved holder coverage would move from ${fmtPct(sim.currentApprovedCoveragePct)} to ` +
      `${fmtPct(sim.projectedApprovedCoveragePct)} (${fmtSigned(sim.approvedCoverageImprovementPct)}). ` +
      `ESTIMATE ONLY — paper evidence collection, no trading impact.`,
  };

  const failureModes: string[] = [
    'API rate limiting (429) — cache-first + per-run cap bound exposure; transient errors are NOT cached, so they retry later.',
    'API auth/endpoint errors (401/5xx) — provider degrades to UNKNOWN without crashing the cycle (never treated as CLEAN).',
    'Cache staleness — entries older than 24h TTL expire and re-fetch; stale holder data is not silently trusted.',
    'Cap too low — some approved UNKNOWN rows remain uncovered per cycle; raise the cap gradually (still paper-only).',
    'Provider returns UNKNOWN for thin/new tokens — coverage cannot be forced; UNKNOWN stays UNKNOWN.',
    'Cost/latency creep — live calls add wall-clock per cycle; the cap is the throttle.',
  ];

  const rollbackSteps: string[] = [
    `Set ${ENV_DISABLED_FLAG}=1 to immediately stop all live calls (instant revert to today's behavior).`,
    `Or set ${ENV_CAP_FLAG}=0 for CACHE_ONLY mode (cache hits only, no new live calls).`,
    'No gate, policy, or filter change is involved, so rollback is a single env flag — no code revert needed.',
    'The cache file is append-only and can be retained or cleared independently; clearing it only forces re-fetch.',
    'Paper P/L and gates are unaffected either way — holder risk is evidence, not an entry trigger.',
  ];

  const doesNotChange: string[] = [
    'Does NOT change any buy gate, rejection rule, or filter threshold.',
    'Does NOT change how clusterRisk is interpreted (UNKNOWN is still NOT CLEAN).',
    'Does NOT enable real trading, wallet, swap, or signing.',
    'Does NOT promote M5_NEUTRAL or any band to a gate.',
    'Does NOT auto-apply any config — the operator makes the env change manually in a separate step.',
  ];

  // ── Recommendation ──────────────────────────────────────────────────────────
  const { recommendations, exactConfigChange, recommendationNotes } =
    computeRecommendation(configState, probe, capPlan);

  return {
    generatedAt,
    configState,
    approvedUnknownPct: probe.coverageAll.approvedUnknownPct,
    rejectedUnknownPct: probe.coverageAll.rejectedUnknownPct,
    approvedUnknownGapVsRejected:
      probe.coverageAll.approvedUnknownPct != null && probe.coverageAll.rejectedUnknownPct != null
        ? probe.coverageAll.approvedUnknownPct - probe.coverageAll.rejectedUnknownPct : null,
    bubbleMapsDisabledCycles: probe.bubbleMapsUsage.bubbleMapsDisabledCycles,
    recentCyclesScanned:      recentCycles,
    capPlan,
    cacheFirstPlan,
    expectedImprovement,
    failureModes,
    rollbackSteps,
    doesNotChange,
    recommendations,
    exactConfigChange,
    recommendationNotes,
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    noMutation:        true,
    noRealTrading:     true,
    noGateChanges:     true,
    noPolicyChange:    true,
    noConfigApplied:   true,
    noAutoEnable:      true,
    noBubbleMapsCall:  true,
    noWallet:          true,
    noSwap:            true,
    noSigning:         true,
    realTradingLocked: true,
    configChanged:     false,
    tradingExecuted:   0,
  };
}

function computeRecommendation(
  cfg: BubbleMapsConfigState,
  probe: ApprovedPriorityStudyResult,
  capPlan: CapPlan,
): { recommendations: ProposalRecommendation[]; exactConfigChange: string[]; recommendationNotes: string[] } {
  const recs: ProposalRecommendation[] = [];
  const notes: string[] = [];

  const approvedGap = probe.coverageAll.approvedUnknownPct != null &&
    probe.coverageAll.approvedUnknownPct > 25;

  // The config surface IS discoverable (we read it) and a safe paper-only mode exists.
  if (!cfg.supportsSafePaperMode) {
    recs.push('NEEDS_CONFIG_DISCOVERY');
    notes.push('No paper-only BubbleMaps mode found in code — discovery needed before any proposal.');
  } else {
    // Proposal is well-formed and ready to hand to a human for a SEPARATE decision.
    recs.push('PAPER_COVERAGE_PROPOSAL_READY');
    if (approvedGap) {
      notes.push('Approved rows are under-covered and the app already supports a safe paper-only LIVE_CAPPED ' +
        'mode. This proposal is ready for a separate manual enable decision — it does NOT enable anything.');
    }
  }

  // Always hold the line: do not enable now.
  recs.push('DO_NOT_ENABLE_YET');
  notes.push('Per mission rules, this is a proposal only. No env change is applied. Real trading stays locked.');

  // If disabled is the dominant blocker and no provider redundancy exists, flag fallback as a future option.
  if (cfg.disabledActive && probe.bubbleMapsUsage.liveCallsUsed === 0) {
    recs.push('NEEDS_FALLBACK_PROVIDER');
    notes.push('Consider studying a holder-risk fallback provider so coverage does not depend on a single ' +
      'BubbleMaps endpoint (future study only — not part of this proposal).');
  }

  const exactConfigChange: string[] = [
    '── EXACT CONFIG CHANGE (DESCRIBED ONLY — DO NOT APPLY HERE) ──',
    `1. ${cfg.disabledFlagName}=0        # re-enable live BubbleMaps calls (currently ${cfg.disabledFlagValue ?? 'unset'})`,
    `2. ${cfg.capFlagName}=${capPlan.recommendedInitialCap}   # conservative initial per-run cap`,
    '3. Leave all gate/policy/filter env untouched. No other change.',
    'Apply ONLY via a separate, explicit, manual operator step — never from this report.',
  ];

  return { recommendations: recs, exactConfigChange, recommendationNotes: notes };
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtPct(v: number | null | undefined): string {
  if (v == null) return 'n/a';
  return v.toFixed(1) + '%';
}

function fmtSigned(v: number | null | undefined): string {
  if (v == null) return 'n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderPaperCoverageProposal(r: PaperCoverageProposalResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — BUBBLEMAPS PAPER COVERAGE ENABLEMENT PROPOSAL v1');
  L.push('  [REPORT ONLY — PAPER ONLY — NO CONFIG APPLIED — NO GATE/POLICY CHANGE — NO AUTO-ENABLE]');
  L.push('  Proposes (does NOT apply) a safe paper-only holder-risk coverage mode.');
  L.push('  Does NOT call BubbleMaps. UNKNOWN is NEVER treated as CLEAN. Real trading stays locked.');
  L.push(SEP, '');

  // §1 — Overview
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Generated at              : ${r.generatedAt}`);
  L.push(`  BubbleMaps mode           : ${r.configState.mode}`);
  L.push(`  Approved UNKNOWN coverage : ${fmtPct(r.approvedUnknownPct)} of approved rows are UNKNOWN`);
  L.push(`  Recommended initial cap   : ${r.capPlan.recommendedInitialCap}`);
  L.push(`  Headline recommendation   : ${r.recommendations[0] ?? '(none)'}`);
  L.push('');

  // §2 — Current BubbleMaps state
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — CURRENT BUBBLEMAPS STATE');
  L.push(`  ${SEP2}`, '');
  const c = r.configState;
  L.push(`  Disable flag              : ${c.disabledFlagName}=${c.disabledFlagValue ?? '(unset)'}  → active=${c.disabledActive}`);
  L.push(`  Cap flag                  : ${c.capFlagName}=${c.capFlagValue ?? '(unset)'}  → effectiveCap=${c.effectiveCap} (default ${c.defaultCap})`);
  L.push(`  Mode                      : ${c.mode}`);
  L.push(`  Cache path                : ${c.cachePath}`);
  L.push(`  Cache entries             : ${c.cacheEntryCount} (exists=${c.cacheExists})`);
  L.push(`  Supports safe paper mode  : ${c.supportsSafePaperMode ? 'YES (BubbleMapsCache: DISABLED/CACHE_ONLY/LIVE_CAPPED)' : 'NO'}`);
  L.push('');
  L.push(`  ${c.note}`);
  L.push('');

  // §3 — Current approved coverage gap
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — CURRENT APPROVED COVERAGE GAP');
  L.push(`  ${SEP2}`, '');
  L.push(`  Approved UNKNOWN %        : ${fmtPct(r.approvedUnknownPct)}`);
  L.push(`  Rejected UNKNOWN %        : ${fmtPct(r.rejectedUnknownPct)}`);
  L.push(`  Approved-minus-rejected   : ${fmtSigned(r.approvedUnknownGapVsRejected)} ` +
         `${r.approvedUnknownGapVsRejected != null && r.approvedUnknownGapVsRejected > 0 ? '(approved WORSE covered)' : ''}`);
  L.push(`  BubbleMaps disabled cycles: ${r.bubbleMapsDisabledCycles}/${r.recentCyclesScanned} (recent)`);
  L.push('');

  // §4 — Proposed paper-only coverage mode
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — PROPOSED PAPER-ONLY COVERAGE MODE');
  L.push(`  ${SEP2}`, '');
  L.push('  • Re-enable BubbleMaps live calls in LIVE_CAPPED mode for PAPER evidence ONLY.');
  L.push('  • Holder risk remains an evidence field — it never triggers a trade or changes a gate.');
  L.push('  • Cache-first: every lookup checks the 24h cache before spending a live call.');
  L.push('  • Strict per-run cap throttles API usage; approved candidates are covered first.');
  L.push('  • UNKNOWN stays UNKNOWN — coverage cannot be forced and UNKNOWN is never CLEAN.');
  L.push('');

  // §5 — Approved-first priority plan
  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — APPROVED-FIRST PRIORITY PLAN');
  L.push(`  ${SEP2}`, '');
  L.push('  Spend the limited call budget in priority order:');
  L.push('    1) BUY_APPROVED_PAPER + M5 present + UNKNOWN');
  L.push('    2) BUY_APPROVED_PAPER + UNKNOWN');
  L.push('    3) BUY_REJECTED + M5 present + UNKNOWN');
  L.push('    4) BUY_REJECTED + UNKNOWN');
  L.push('  This resolves the rows the system cares about most (approved paper candidates) first.');
  L.push('  (Priority is a FUTURE policy — this report does not implement it.)');
  L.push('');

  // §6 — Cap plan
  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — CAP PLAN');
  L.push(`  ${SEP2}`, '');
  const cp = r.capPlan;
  L.push(`  Observed approved demand/cycle : ${cp.observedApprovedDemandPerCycle}`);
  L.push(`  Recommended initial cap        : ${cp.recommendedInitialCap}  (range ${cp.minInitialCap}–${cp.maxInitialCap})`);
  L.push('');
  L.push(`  ${cp.rationale}`);
  L.push('');

  // §7 — Cache-first plan
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — CACHE-FIRST PLAN');
  L.push(`  ${SEP2}`, '');
  const cf = r.cacheFirstPlan;
  L.push(`  Cache entries                  : ${cf.cacheEntryCount}`);
  L.push(`  Approved rows maybe cached     : ${cf.approvedRowsMaybeCached} (upper bound)`);
  L.push(`  ${cf.ttlNote}`);
  L.push('');
  L.push(`  ${cf.note}`);
  L.push('');

  // §8 — Failure / rollback plan
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — FAILURE / ROLLBACK PLAN');
  L.push(`  ${SEP2}`, '');
  L.push('  Failure modes:');
  for (const f of r.failureModes) L.push(`    • ${f}`);
  L.push('');
  L.push('  Rollback steps:');
  for (const s of r.rollbackSteps) L.push(`    • ${s}`);
  L.push('');

  // §9 — Expected data improvement
  L.push(`  ${SEP2}`);
  L.push('  SECTION 9 — EXPECTED DATA IMPROVEMENT (ESTIMATE)');
  L.push(`  ${SEP2}`, '');
  const ei = r.expectedImprovement;
  L.push(`  Approved UNKNOWN total         : ${ei.approvedUnknownTotal}`);
  L.push(`  Approved UNKNOWN resolved est. : ${ei.approvedUnknownResolvedEstimate} (cap ${ei.assumedCapUsed}, approved-first)`);
  L.push(`  M5-approved UNKNOWN resolved   : ${ei.m5ApprovedUnknownResolvedEstimate}`);
  L.push(`  Rejected deferred (est.)       : ${ei.rejectedDeferredEstimate}`);
  L.push(`  Current approved coverage      : ${fmtPct(ei.currentApprovedCoveragePct)}`);
  L.push(`  Projected approved coverage    : ${fmtPct(ei.projectedApprovedCoveragePct)}`);
  L.push(`  Approved coverage improvement  : ${fmtSigned(ei.approvedCoverageImprovementPct)}`);
  L.push('');
  L.push(`  ${ei.note}`);
  L.push('');

  // §10 — What this does NOT change
  L.push(`  ${SEP2}`);
  L.push('  SECTION 10 — WHAT THIS DOES NOT CHANGE');
  L.push(`  ${SEP2}`, '');
  for (const d of r.doesNotChange) L.push(`  • ${d}`);
  L.push('');

  // §11 — Recommendation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 11 — RECOMMENDATION (PROPOSAL ONLY — NOTHING APPLIED)');
  L.push(`  ${SEP2}`, '');
  for (const rec of r.recommendations) {
    const neutral = rec === 'PAPER_COVERAGE_PROPOSAL_READY';
    L.push(`  ${neutral ? 'ℹ' : '⚠'} ${rec}`);
  }
  L.push('');
  for (const n of r.recommendationNotes) L.push(`  • ${n}`);
  L.push('');
  for (const line of r.exactConfigChange) L.push(`  ${line}`);
  L.push('');

  // §12 — Safety footer
  L.push(`  ${SEP2}`);
  L.push('  SECTION 12 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true   READ_ONLY=true   PAPER_ONLY=true   NO_MUTATION=true');
  L.push('  NO_REAL_TRADING=true   NO_GATE_CHANGES=true   NO_POLICY_CHANGE=true   NO_CONFIG_APPLIED=true');
  L.push('  NO_AUTO_ENABLE=true   NO_BUBBLEMAPS_CALL=true   NO_WALLET=true   NO_SWAP=true   NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING   tradingExecuted=0   realTradingLocked=true   configChanged=false');
  L.push('  No config applied. No data mutated. No gates/policy changed. UNKNOWN never treated as CLEAN.');
  L.push(SEP, '');

  return L.join('\n');
}
