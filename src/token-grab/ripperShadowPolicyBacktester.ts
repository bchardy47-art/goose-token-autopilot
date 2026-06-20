// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  NO_GATE_CHANGES  NO_FILTER_CHANGE
//
// Shadow Policy Backtester v1 — a REPORT_ONLY study that evaluates candidate rule
// ideas against learned evidence WITHOUT changing any gate, filter, or policy. Each
// candidate policy is a predicate over ENTRY FEATURES only (M5 band, liquidity, VLR,
// cluster) — never over outcome fields. Outcomes are used only to SCORE the resulting
// would-approve set, on EXECUTION-ADJUSTED P/L (reusing the Execution Realism model)
// so a policy can never be promoted on illusory paper profit.
//
// HARD RULE: this command never modifies actual gates or policy. The strongest
// possible promotion is "ready for a SEPARATE manual gate proposal review".

import * as fs from 'fs';

import {
  m5ToBand,
  getConfidenceTier,
  type M5Band,
  type ConfidenceTier,
} from './ripperM5EvidenceDashboard';
import {
  adjustExecutionPnl,
  type ExecutionParams,
} from './ripperExecutionRealismSimulator';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_PATH = 'data/token-grab/ripper/learning-memory.jsonl';
const PNL_CAP        = 300;
const WIN_PCT        = 10;
const BIG_WIN_PCT    = 50;
const LOSS_PCT       = -20;
const BIG_LOSS_PCT   = -50;
const USABLE_N       = 200;   // minimum would-approve P/L rows for a non-trivial verdict

// Execution params used to score policies honestly (matches Execution Realism defaults).
const SCORING_PARAMS: ExecutionParams = {
  slippageBps: 100, feeBps: 30, latencySeconds: 5, maxPnlCap: PNL_CAP, thinLiqPenalty: 5, failedExitHaircut: 0.2,
};

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

const THIN_LIQ      = new Set(['LIQ_LT_10K']);
const HIGH_RISK_M5: M5Band[] = ['M5_STRONG', 'M5_VERY_STRONG'];

// ── Types ───────────────────────────────────────────────────────────────────────

export type PolicyKind = 'BASELINE' | 'SELECTION' | 'FILTER' | 'INFORMATIONAL';

export type PromotionStatus =
  | 'REJECT_POLICY'
  | 'STUDY_ONLY'
  | 'NEEDS_MORE_DATA'
  | 'READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW';

export interface PolicyResult {
  id:                 string;
  label:              string;
  kind:               PolicyKind;
  wouldApprove:       number;
  wouldReject:        number;
  approveWithPnl:     number;
  overlapCurrentApproved: number;
  missedWinners:      number;   // would-reject AND winner
  avoidedLosers:      number;   // would-reject AND loser
  bigWinnersCaptured: number;   // would-approve AND big winner
  bigLosersAvoided:   number;   // would-reject AND big loser
  rawAvgPnl:          number | null;   // would-approve raw paper avg (reference)
  adjAvgPnl:          number | null;   // would-approve execution-adjusted avg (scoring)
  adjMedianPnl:       number | null;
  adjWinRate:         number | null;
  sampleTier:         ConfidenceTier;
  riskWarnings:       string[];
  promotion:          PromotionStatus;
  promotionReason:    string;
}

export interface ShadowPolicyBacktestResult {
  generatedAt:  string;
  memoryRows:   number;
  universePnlRows: number;
  scoringParams: ExecutionParams;
  baselineId:   string;
  policies:     PolicyResult[];
  recommendations: string[];

  // safety
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  noMutation:        true;
  noRealTrading:     true;
  noGateChanges:     true;
  noPolicyChange:    true;
  noFilterChange:    true;
  noWallet:          true;
  noSwap:            true;
  noSigning:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface ShadowPolicyBacktestOptions {
  memoryPath?:  string;
  generatedAt?: string;
}

// ── Raw row ──────────────────────────────────────────────────────────────────

interface RawMemRow {
  contract?:         string;
  gateDecision?:     string;
  priceChangePct?:   number | null;
  entryMomentumPct?: number | null;
  liquidityBucket?:  string;
  vlrBucket?:        string;
  clusterRisk?:      string;
  timingPath?:       string;
}

// Enriched row with derived entry features (NO outcome leakage into predicates).
interface Row {
  raw:        RawMemRow;
  m5Band:     M5Band;
  liq:        string;
  vlr:        string;
  cluster:    string;
  currentlyApproved: boolean;
  rawPnl:     number;
  adjPnl:     number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

function hasNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

function avg(arr: number[]): number | null {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function normCluster(v: unknown): string {
  if (typeof v !== 'string') return 'MISSING';
  const u = v.trim().toUpperCase();
  if (u === 'CLEAN' || u === 'WATCH' || u === 'RISKY' || u === 'UNKNOWN') return u;
  return 'MISSING';
}

// ── Policy definitions (predicates over ENTRY FEATURES only) ──────────────────────

interface Policy {
  id:    string;
  label: string;
  kind:  PolicyKind;
  approve: (r: Row) => boolean;
}

// Exported so tests can assert the policy set is stable.
export function buildPolicies(): Policy[] {
  return [
    {
      id: 'baseline', label: 'Baseline — current behavior (BUY_APPROVED_PAPER)', kind: 'BASELINE',
      approve: r => r.currentlyApproved,
    },
    {
      id: 'neutral_nonthin', label: 'M5_NEUTRAL + non-thin liquidity', kind: 'SELECTION',
      approve: r => r.m5Band === 'M5_NEUTRAL' && !THIN_LIQ.has(r.liq),
    },
    {
      id: 'neutral_vlr_mid', label: 'M5_NEUTRAL + VLR_0_5_TO_2', kind: 'SELECTION',
      approve: r => r.m5Band === 'M5_NEUTRAL' && r.vlr === 'VLR_0_5_TO_2',
    },
    {
      id: 'reject_risky_combo', label: 'Reject M5_POSITIVE/STRONG + LIQ_LT_10K + VLR_GTE_2 (filter on current)', kind: 'FILTER',
      approve: r => r.currentlyApproved && !(
        (r.m5Band === 'M5_POSITIVE' || r.m5Band === 'M5_STRONG' || r.m5Band === 'M5_VERY_STRONG') &&
        r.liq === 'LIQ_LT_10K' && r.vlr === 'VLR_GTE_2'),
    },
    {
      id: 'require_known_cluster_highrisk', label: 'Require non-UNKNOWN cluster for high-risk M5 bands (filter)', kind: 'FILTER',
      approve: r => r.currentlyApproved && !(HIGH_RISK_M5.includes(r.m5Band) && r.cluster === 'UNKNOWN'),
    },
    {
      id: 'wait10_neutral', label: 'WAIT_10M preference for M5_NEUTRAL (neutral + non-thin + non-UNKNOWN cluster)', kind: 'SELECTION',
      approve: r => r.m5Band === 'M5_NEUTRAL' && !THIN_LIQ.has(r.liq) && r.cluster !== 'UNKNOWN' && r.cluster !== 'MISSING',
    },
    {
      id: 'approved_first_coverage', label: 'Approved-first BubbleMaps paper coverage (informational only)', kind: 'INFORMATIONAL',
      approve: r => r.currentlyApproved,
    },
  ];
}

// ── Policy evaluation ────────────────────────────────────────────────────────────

function evaluatePolicy(policy: Policy, rows: Row[], baseline: { adjAvg: number | null; adjWinRate: number | null } | null): PolicyResult {
  const approveRows: Row[] = [];
  const rejectRows:  Row[] = [];
  for (const r of rows) (policy.approve(r) ? approveRows : rejectRows).push(r);

  const approveWithPnl = approveRows;  // every row in universe has pnl (filtered upstream)
  const adjs = approveWithPnl.map(r => r.adjPnl);
  const raws = approveWithPnl.map(r => r.rawPnl);
  const adjWins = adjs.filter(p => p > 0).length;

  const missedWinners  = rejectRows.filter(r => r.rawPnl >= WIN_PCT).length;
  const avoidedLosers  = rejectRows.filter(r => r.rawPnl <= LOSS_PCT).length;
  const bigWinnersCaptured = approveRows.filter(r => r.rawPnl >= BIG_WIN_PCT).length;
  const bigLosersAvoided   = rejectRows.filter(r => r.rawPnl <= BIG_LOSS_PCT).length;
  const overlap = approveRows.filter(r => r.currentlyApproved).length;

  const adjAvg = avg(adjs);
  const adjWinRate = approveRows.length ? adjWins / approveRows.length : null;
  const sampleTier = getConfidenceTier(approveRows.length);

  const riskWarnings = computeRiskWarnings(approveRows);
  const { promotion, promotionReason } = computePromotion(
    policy.kind, approveRows.length, adjAvg, adjWinRate, sampleTier, baseline);

  return {
    id: policy.id, label: policy.label, kind: policy.kind,
    wouldApprove: approveRows.length,
    wouldReject:  rejectRows.length,
    approveWithPnl: approveWithPnl.length,
    overlapCurrentApproved: overlap,
    missedWinners, avoidedLosers, bigWinnersCaptured, bigLosersAvoided,
    rawAvgPnl: avg(raws),
    adjAvgPnl: adjAvg,
    adjMedianPnl: median(adjs),
    adjWinRate,
    sampleTier,
    riskWarnings,
    promotion, promotionReason,
  };
}

function computeRiskWarnings(approveRows: Row[]): string[] {
  const w: string[] = [];
  if (approveRows.length === 0) { w.push('Empty approve-set — policy selects nothing.'); return w; }
  const unknownShare = approveRows.filter(r => r.cluster === 'UNKNOWN').length / approveRows.length;
  const thinShare    = approveRows.filter(r => THIN_LIQ.has(r.liq)).length / approveRows.length;
  if (unknownShare >= 0.4) w.push(`${(unknownShare * 100).toFixed(0)}% of approve-set is UNKNOWN cluster (holder risk unresolved).`);
  if (thinShare >= 0.4)    w.push(`${(thinShare * 100).toFixed(0)}% of approve-set is thin liquidity (execution risk).`);
  if (approveRows.length < USABLE_N) w.push(`Approve-set below ${USABLE_N} rows — sample is not yet decisive.`);
  return w;
}

function computePromotion(
  kind: PolicyKind,
  approveN: number,
  adjAvg: number | null,
  adjWinRate: number | null,
  tier: ConfidenceTier,
  baseline: { adjAvg: number | null; adjWinRate: number | null } | null,
): { promotion: PromotionStatus; promotionReason: string } {
  if (kind === 'INFORMATIONAL') {
    return { promotion: 'STUDY_ONLY', promotionReason: 'Informational policy — coverage ordering, not a selection rule. Study only.' };
  }
  if (kind === 'BASELINE') {
    return { promotion: 'STUDY_ONLY', promotionReason: 'Baseline reference for comparison — not a promotion candidate.' };
  }
  if (approveN < USABLE_N) {
    return { promotion: 'NEEDS_MORE_DATA', promotionReason: `Approve-set ${approveN} < ${USABLE_N} rows (${tier}). Collect more before judging.` };
  }
  const bAvg = baseline?.adjAvg ?? null;
  const bWin = baseline?.adjWinRate ?? null;
  const beatsAvg = adjAvg != null && (bAvg == null || adjAvg > bAvg);
  const beatsWin = adjWinRate != null && bWin != null && adjWinRate > bWin + 0.05;
  const positive = adjAvg != null && adjAvg > 0;
  const worse = (adjAvg != null && bAvg != null && adjAvg < bAvg - 0.5) ||
                (adjWinRate != null && bWin != null && adjWinRate < bWin - 0.05);

  if (positive && beatsAvg && beatsWin && (tier === 'USABLE_SIGNAL' || tier === 'STRONGER')) {
    return {
      promotion: 'READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW',
      promotionReason: 'Execution-adjusted edge is positive AND beats baseline on a usable sample. ' +
        'Eligible for a SEPARATE manual gate proposal review (no change made here).',
    };
  }
  if (worse) {
    return { promotion: 'REJECT_POLICY', promotionReason: 'Execution-adjusted result is worse than baseline — do not pursue.' };
  }
  return { promotion: 'STUDY_ONLY', promotionReason: 'Mixed/insufficient edge after execution costs — keep studying, no proposal.' };
}

// ── Main runner ──────────────────────────────────────────────────────────────────

export function runShadowPolicyBacktester(
  opts: ShadowPolicyBacktestOptions = {},
): ShadowPolicyBacktestResult {
  const memoryPath  = opts.memoryPath ?? DEFAULT_MEMORY_PATH;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  const memRows = readJsonl<RawMemRow>(memoryPath);
  // Universe = rows with an observed outcome (so policies can be scored).
  const rows: Row[] = memRows
    .filter(r => hasNum(r.priceChangePct))
    .map(r => {
      const rawPnl = clamp(r.priceChangePct as number, -PNL_CAP, PNL_CAP);
      return {
        raw: r,
        m5Band: m5ToBand(r.entryMomentumPct),
        liq: r.liquidityBucket ?? 'LIQ_UNKNOWN',
        vlr: r.vlrBucket ?? 'VLR_UNKNOWN',
        cluster: normCluster(r.clusterRisk),
        currentlyApproved: r.gateDecision === 'BUY_APPROVED_PAPER',
        rawPnl,
        adjPnl: adjustExecutionPnl(r.priceChangePct as number, r, SCORING_PARAMS),
      };
    });

  const policies = buildPolicies();
  // Evaluate baseline first so candidate policies compare against it.
  const baselinePolicy = policies.find(p => p.kind === 'BASELINE')!;
  const baselineResult = evaluatePolicy(baselinePolicy, rows, null);
  const baselineRef = { adjAvg: baselineResult.adjAvgPnl, adjWinRate: baselineResult.adjWinRate };

  const results: PolicyResult[] = policies.map(p =>
    p.id === baselinePolicy.id ? baselineResult : evaluatePolicy(p, rows, baselineRef));

  const recommendations = computeRecommendations(results);

  return {
    generatedAt,
    memoryRows: memRows.length,
    universePnlRows: rows.length,
    scoringParams: SCORING_PARAMS,
    baselineId: baselinePolicy.id,
    policies: results,
    recommendations,
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    noMutation:        true,
    noRealTrading:     true,
    noGateChanges:     true,
    noPolicyChange:    true,
    noFilterChange:    true,
    noWallet:          true,
    noSwap:            true,
    noSigning:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
  };
}

function computeRecommendations(results: PolicyResult[]): string[] {
  const recs: string[] = [];
  recs.push('This backtester NEVER changes gates, filters, or policy. All results are study evidence.');
  const ready = results.filter(r => r.promotion === 'READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW');
  if (ready.length > 0) {
    recs.push(`${ready.length} policy(ies) cleared execution-adjusted scoring on a usable sample: ` +
      `${ready.map(r => r.id).join(', ')}. These are eligible for a SEPARATE manual gate proposal review only.`);
  } else {
    recs.push('No candidate policy beat baseline on execution-adjusted P/L with a usable sample. ' +
      'No gate proposal is warranted yet — keep collecting and studying.');
  }
  recs.push('Policies are scored on EXECUTION-ADJUSTED P/L (slippage/fees/latency/haircuts) to avoid paper illusion.');
  recs.push('Real trading stays locked. The strongest allowed outcome is "ready for separate gate proposal review".');
  return recs;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmt1(v: number | null | undefined): string {
  if (v == null) return ' n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}
function pctRate(v: number | null | undefined): string {
  if (v == null) return '  n/a';
  return (v * 100).toFixed(1) + '%';
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderShadowPolicyBacktester(r: ShadowPolicyBacktestResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — SHADOW POLICY BACKTESTER v1');
  L.push('  [REPORT ONLY — PAPER ONLY — NO GATE CHANGES — NO POLICY CHANGE — NO FILTER CHANGE]');
  L.push('  Tests candidate rules vs learned evidence on EXECUTION-ADJUSTED P/L. Never changes gates.');
  L.push('  Strongest possible outcome: "ready for SEPARATE manual gate proposal review".');
  L.push(SEP, '');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Generated at        : ${r.generatedAt}`);
  L.push(`  Memory rows         : ${r.memoryRows}`);
  L.push(`  Universe (P/L rows) : ${r.universePnlRows}`);
  L.push(`  Scoring             : execution-adjusted (slippage=${r.scoringParams.slippageBps}bps fee=${r.scoringParams.feeBps}bps latency=${r.scoringParams.latencySeconds}s)`);
  L.push('');

  const baseline = r.policies.find(p => p.id === r.baselineId);
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — POLICY RESULTS (scored on execution-adjusted P/L)');
  L.push(`  ${SEP2}`, '');
  if (baseline) {
    L.push(`  Baseline adjusted: avg ${fmt1(baseline.adjAvgPnl)}%  win ${pctRate(baseline.adjWinRate)}  (n=${baseline.wouldApprove})`);
    L.push('');
  }
  for (const p of r.policies) {
    L.push(`  ── ${p.id}  [${p.kind}] ──`);
    L.push(`     ${p.label}`);
    L.push(`     would-approve ${p.wouldApprove}  would-reject ${p.wouldReject}  overlap-w-current ${p.overlapCurrentApproved}`);
    L.push(`     missed winners ${p.missedWinners}  avoided losers ${p.avoidedLosers}  big-win captured ${p.bigWinnersCaptured}  big-loss avoided ${p.bigLosersAvoided}`);
    L.push(`     raw avg ${fmt1(p.rawAvgPnl)}%   adj avg ${fmt1(p.adjAvgPnl)}%   adj median ${fmt1(p.adjMedianPnl)}%   adj win ${pctRate(p.adjWinRate)}   tier ${p.sampleTier}`);
    if (p.riskWarnings.length > 0) for (const w of p.riskWarnings) L.push(`     ⚠ ${w}`);
    const flag = p.promotion === 'READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW' ? '✓'
      : p.promotion === 'REJECT_POLICY' ? '✗' : 'ℹ';
    L.push(`     ${flag} PROMOTION: ${p.promotion} — ${p.promotionReason}`);
    L.push('');
  }

  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — RECOMMENDATION (STUDY ONLY — NO GATE/POLICY CHANGE)');
  L.push(`  ${SEP2}`, '');
  for (const rec of r.recommendations) L.push(`  • ${rec}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true   READ_ONLY=true   PAPER_ONLY=true   NO_MUTATION=true');
  L.push('  NO_REAL_TRADING=true   NO_GATE_CHANGES=true   NO_POLICY_CHANGE=true   NO_FILTER_CHANGE=true');
  L.push('  NO_WALLET=true   NO_SWAP=true   NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING   tradingExecuted=0   realTradingLocked=true');
  L.push('  No gates/policy/filters modified. Policies scored on execution-adjusted P/L. UNKNOWN ≠ CLEAN.');
  L.push(SEP, '');

  return L.join('\n');
}
