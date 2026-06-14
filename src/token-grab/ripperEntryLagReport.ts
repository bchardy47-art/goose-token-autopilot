import * as fs from 'fs';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export const FULL_COMBO_LAG_POLICY_ID = 'price_gt_0_25_and_liq_30k_and_vol_20k';

export interface EntryLagCandidate {
  contractKey:             string;
  contractKeyShort:        string;
  symbol?:                 string;
  approvedAt:              string;
  approvalInstanceKey:     string;
  approvalPriceChangePct:  number | null;
  liquidityUsd:            number | null;
  volumeUsd:               number | null;
  hasObservation:          boolean;
  firstSeenAt:             string | null;
  lagMinutes:              number | null;
  firstSeenPriceChangePct: number | null;
  preApprovalMovePct:      number | null;
  bestPreApprovalPct:      number | null;
  preRip_1pct:             boolean;
  preRip_3pct:             boolean;
  preRip_5pct:             boolean;
}

export interface LagSummary {
  totalApprovals:          number;
  approvalWithObs:         number;
  missingPreApprovalObs:   number;
  avgLagMinutes:           number | null;
  medianLagMinutes:        number | null;
  preRip_1pct_count:       number;
  preRip_3pct_count:       number;
  preRip_5pct_count:       number;
  preRip_1pct_pct:         number | null;
  preRip_3pct_pct:         number | null;
  preRip_5pct_pct:         number | null;
}

export interface PolicyLagReport {
  policyId:                 string;
  description:              string;
  candidates:               EntryLagCandidate[];
  matchedWithObs:           number;
  avgLagMinutes:            number | null;
  medianLagMinutes:         number | null;
  avgPreApprovalMovePct:    number | null;
  medianPreApprovalMovePct: number | null;
  preRip_1pct_count:        number;
  preRip_3pct_count:        number;
  preRip_5pct_count:        number;
  preRip_1pct_pct:          number | null;
  preRip_3pct_pct:          number | null;
  preRip_5pct_pct:          number | null;
}

export interface RipperEntryLagReportOptions {
  approvalPaths:    string[];
  observationPaths: string[];
  nowMs?:           number;
}

export interface RipperEntryLagReportResult {
  generatedAt:             string;
  approvalFilesRead:       number;
  approvalFilesMissing:    number;
  observationFilesRead:    number;
  observationFilesMissing: number;
  approvalsLoaded:         number;
  observationsLoaded:      number;
  summary:                 LagSummary;
  policies:                PolicyLagReport[];
  realTradingLocked:       true;
  tradingExecuted:         0;
  noRealTradeSent:         true;
  paperOnly:               true;
  readOnly:                true;
}

// ── Policy definitions ─────────────────────────────────────────────────────────

interface PolicyDef {
  id:          string;
  description: string;
  evaluate:    (c: EntryLagCandidate) => boolean;
}

const POLICIES: PolicyDef[] = [
  {
    id:          'ALL',
    description: 'All approved candidates (baseline)',
    evaluate:    () => true,
  },
  {
    id:          'price_gt_0_25',
    description: 'approvalPriceChangePct > 0.25',
    evaluate:    c => c.approvalPriceChangePct != null && c.approvalPriceChangePct > 0.25,
  },
  {
    id:          FULL_COMBO_LAG_POLICY_ID,
    description: 'approvalPriceChangePct > 0.25 AND liquidityUsd >= 30000 AND volumeUsd >= 20000',
    evaluate:    c =>
      c.approvalPriceChangePct != null && c.approvalPriceChangePct > 0.25 &&
      c.liquidityUsd           != null && c.liquidityUsd >= 30_000 &&
      c.volumeUsd              != null && c.volumeUsd >= 20_000,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function toFiniteNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shortKey(k: string): string {
  return k.length > 14 ? `${k.slice(0, 14)}…` : k;
}

function avgOf(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((s, n) => s + n, 0) / xs.length : null;
}

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface ObsEntry {
  capturedAtMs:   number;
  capturedAt:     string;
  priceChangePct: number | null;
}

// ── Policy stats builder ──────────────────────────────────────────────────────

function buildPolicyReport(
  policyId:    string,
  description: string,
  candidates:  EntryLagCandidate[],
): PolicyLagReport {
  const matched  = candidates.filter(c => c.hasObservation);
  const lagMins  = matched.map(c => c.lagMinutes).filter((v): v is number => v != null);
  const movePcts = matched
    .map(c => c.preApprovalMovePct)
    .filter((v): v is number => v != null);
  const preRip1 = candidates.filter(c => c.preRip_1pct).length;
  const preRip3 = candidates.filter(c => c.preRip_3pct).length;
  const preRip5 = candidates.filter(c => c.preRip_5pct).length;
  const base    = matched.length;

  return {
    policyId,
    description,
    candidates,
    matchedWithObs:           matched.length,
    avgLagMinutes:            avgOf(lagMins),
    medianLagMinutes:         medianOf(lagMins),
    avgPreApprovalMovePct:    avgOf(movePcts),
    medianPreApprovalMovePct: medianOf(movePcts),
    preRip_1pct_count: preRip1,
    preRip_3pct_count: preRip3,
    preRip_5pct_count: preRip5,
    preRip_1pct_pct:   base > 0 ? (preRip1 / base) * 100 : null,
    preRip_3pct_pct:   base > 0 ? (preRip3 / base) * 100 : null,
    preRip_5pct_pct:   base > 0 ? (preRip5 / base) * 100 : null,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperEntryLagReport(
  options: RipperEntryLagReportOptions,
): RipperEntryLagReportResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Step 1: Load approval fixtures ─────────────────────────────────────────
  let approvalFilesRead    = 0;
  let approvalFilesMissing = 0;
  let approvalsLoaded      = 0;

  interface ApprovalEntry {
    contractKey:            string;
    approvedAt:             string;
    approvedAtMs:           number;
    instanceKey:            string;
    symbol?:                string;
    approvalPriceChangePct: number | null;
    liquidityUsd:           number | null;
    volumeUsd:              number | null;
  }

  const instanceKeySet = new Set<string>();
  const approvals: ApprovalEntry[] = [];

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) { approvalFilesMissing++; continue; }
    approvalFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      const contractKey = signalKey(f.normalizedSignal);
      const instanceKey = `${contractKey}::${f.capturedAt}`;
      if (instanceKeySet.has(instanceKey)) continue;
      instanceKeySet.add(instanceKey);
      approvalsLoaded++;
      const approvedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(approvedAtMs)) continue;
      const sig = f.normalizedSignal as Record<string, unknown>;
      approvals.push({
        contractKey,
        approvedAt:             f.capturedAt,
        approvedAtMs,
        instanceKey,
        symbol:                 f.normalizedSignal.symbol,
        approvalPriceChangePct: toFiniteNum(sig['priceChangePct']),
        liquidityUsd:           toFiniteNum(sig['liquidityUsd']),
        volumeUsd:              toFiniteNum(sig['volumeUsd']),
      });
    }
  }

  // ── Step 2: Load observations ───────────────────────────────────────────────
  let observationFilesRead    = 0;
  let observationFilesMissing = 0;
  let observationsLoaded      = 0;
  const obsMap = new Map<string, ObsEntry[]>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) { observationFilesMissing++; continue; }
    observationFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      const key          = signalKey(f.normalizedSignal);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;
      observationsLoaded++;
      const entry: ObsEntry = {
        capturedAtMs,
        capturedAt:     f.capturedAt,
        priceChangePct: toFiniteNum((f.normalizedSignal as Record<string, unknown>)['priceChangePct']),
      };
      const list = obsMap.get(key);
      if (list) list.push(entry);
      else obsMap.set(key, [entry]);
    }
  }

  // ── Step 3: Build per-instance candidates ───────────────────────────────────
  const allCandidates: EntryLagCandidate[] = [];

  for (const a of approvals) {
    const obs = obsMap.get(a.contractKey) ?? [];

    // Only pre-approval observations (at or before approvedAt) are eligible
    const preApprovalObs = obs.filter(o => o.capturedAtMs <= a.approvedAtMs);

    if (preApprovalObs.length === 0) {
      allCandidates.push({
        contractKey:             a.contractKey,
        contractKeyShort:        shortKey(a.contractKey),
        symbol:                  a.symbol,
        approvedAt:              a.approvedAt,
        approvalInstanceKey:     a.instanceKey,
        approvalPriceChangePct:  a.approvalPriceChangePct,
        liquidityUsd:            a.liquidityUsd,
        volumeUsd:               a.volumeUsd,
        hasObservation:          false,
        firstSeenAt:             null,
        lagMinutes:              null,
        firstSeenPriceChangePct: null,
        preApprovalMovePct:      null,
        bestPreApprovalPct:      null,
        preRip_1pct:             false,
        preRip_3pct:             false,
        preRip_5pct:             false,
      });
      continue;
    }

    // Earliest pre-approval observation → lag is always >= 0
    const sorted     = [...preApprovalObs].sort((x, y) => x.capturedAtMs - y.capturedAtMs);
    const firstObs   = sorted[0];
    const lagMinutes = (a.approvedAtMs - firstObs.capturedAtMs) / 60_000;

    // Best pct among all pre-approval observations
    const validPcts       = preApprovalObs.map(o => o.priceChangePct).filter((v): v is number => v != null);
    const bestPreApprovalPct: number | null = validPcts.length > 0 ? Math.max(...validPcts) : null;

    const firstSeenPct       = firstObs.priceChangePct;
    const preApprovalMovePct =
      a.approvalPriceChangePct != null && firstSeenPct != null
        ? a.approvalPriceChangePct - firstSeenPct
        : null;

    allCandidates.push({
      contractKey:             a.contractKey,
      contractKeyShort:        shortKey(a.contractKey),
      symbol:                  a.symbol,
      approvedAt:              a.approvedAt,
      approvalInstanceKey:     a.instanceKey,
      approvalPriceChangePct:  a.approvalPriceChangePct,
      liquidityUsd:            a.liquidityUsd,
      volumeUsd:               a.volumeUsd,
      hasObservation:          true,
      firstSeenAt:             firstObs.capturedAt,
      lagMinutes,
      firstSeenPriceChangePct: firstSeenPct,
      preApprovalMovePct,
      bestPreApprovalPct,
      preRip_1pct: preApprovalMovePct != null && preApprovalMovePct >= 1,
      preRip_3pct: preApprovalMovePct != null && preApprovalMovePct >= 3,
      preRip_5pct: preApprovalMovePct != null && preApprovalMovePct >= 5,
    });
  }

  // ── Step 4: Overall summary ─────────────────────────────────────────────────
  const matched  = allCandidates.filter(c => c.hasObservation);
  const lagMins  = matched.map(c => c.lagMinutes).filter((v): v is number => v != null);
  const preRip1  = allCandidates.filter(c => c.preRip_1pct).length;
  const preRip3  = allCandidates.filter(c => c.preRip_3pct).length;
  const preRip5  = allCandidates.filter(c => c.preRip_5pct).length;
  const base     = matched.length;

  const summary: LagSummary = {
    totalApprovals:        allCandidates.length,
    approvalWithObs:       matched.length,
    missingPreApprovalObs: allCandidates.length - matched.length,
    avgLagMinutes:         avgOf(lagMins),
    medianLagMinutes:      medianOf(lagMins),
    preRip_1pct_count: preRip1,
    preRip_3pct_count: preRip3,
    preRip_5pct_count: preRip5,
    preRip_1pct_pct:   base > 0 ? (preRip1 / base) * 100 : null,
    preRip_3pct_pct:   base > 0 ? (preRip3 / base) * 100 : null,
    preRip_5pct_pct:   base > 0 ? (preRip5 / base) * 100 : null,
  };

  // ── Step 5: Per-policy reports ────────────────────────────────────────────
  const policies = POLICIES.map(pol => {
    const cands = allCandidates.filter(c => pol.evaluate(c));
    return buildPolicyReport(pol.id, pol.description, cands);
  });

  return {
    generatedAt,
    approvalFilesRead,
    approvalFilesMissing,
    observationFilesRead,
    observationFilesMissing,
    approvalsLoaded,
    observationsLoaded,
    summary,
    policies,
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtRate(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  return `${n.toFixed(0)}%`;
}

function fmtMin(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  return `${n.toFixed(1)}m`;
}

function fmtPreRipFlag(c: EntryLagCandidate): string {
  if (c.preRip_5pct) return '≥5%';
  if (c.preRip_3pct) return '≥3%';
  if (c.preRip_1pct) return '≥1%';
  if (!c.hasObservation) return 'n/obs';
  if (c.preApprovalMovePct == null) return 'n/pct';
  return '—';
}

function renderLagSummary(s: LagSummary): string[] {
  const lines: string[] = [];
  lines.push(`  Total approvals              : ${s.totalApprovals}`);
  lines.push(`  With pre-approval observation: ${s.approvalWithObs}`);
  lines.push(`  Missing pre-approval obs     : ${s.missingPreApprovalObs}`);
  lines.push(`  Avg lag (firstSeen→approval) : ${fmtMin(s.avgLagMinutes)}`);
  lines.push(`  Median lag                   : ${fmtMin(s.medianLagMinutes)}`);
  lines.push(`  preRip ≥1%                   : ${s.preRip_1pct_count} / ${s.approvalWithObs} (${fmtRate(s.preRip_1pct_pct)})`);
  lines.push(`  preRip ≥3%                   : ${s.preRip_3pct_count} / ${s.approvalWithObs} (${fmtRate(s.preRip_3pct_pct)})`);
  lines.push(`  preRip ≥5%                   : ${s.preRip_5pct_count} / ${s.approvalWithObs} (${fmtRate(s.preRip_5pct_pct)})`);
  return lines;
}

function renderPolicyComparisonTable(policies: PolicyLagReport[]): string[] {
  const lines: string[] = [];
  const COL = {
    policy:  42,
    cands:    6,
    matched:  8,
    avgLag:   7,
    medLag:   7,
    avgMove:  8,
    medMove:  8,
    rip1:     6,
    rip3:     6,
    rip5:     6,
  };

  const hdr = [
    'policy'.padEnd(COL.policy),
    'cands'.padStart(COL.cands),
    'matched'.padStart(COL.matched),
    'avgLag'.padStart(COL.avgLag),
    'medLag'.padStart(COL.medLag),
    'avgMove'.padStart(COL.avgMove),
    'medMove'.padStart(COL.medMove),
    'rip1%'.padStart(COL.rip1),
    'rip3%'.padStart(COL.rip3),
    'rip5%'.padStart(COL.rip5),
  ].join('  ');
  lines.push(`  ${hdr}`);
  lines.push(`  ${'─'.repeat(hdr.length)}`);

  for (const p of policies) {
    const row = [
      p.policyId.padEnd(COL.policy),
      String(p.candidates.length).padStart(COL.cands),
      String(p.matchedWithObs).padStart(COL.matched),
      fmtMin(p.avgLagMinutes).padStart(COL.avgLag),
      fmtMin(p.medianLagMinutes).padStart(COL.medLag),
      fmtPct(p.avgPreApprovalMovePct).padStart(COL.avgMove),
      fmtPct(p.medianPreApprovalMovePct).padStart(COL.medMove),
      fmtRate(p.preRip_1pct_pct).padStart(COL.rip1),
      fmtRate(p.preRip_3pct_pct).padStart(COL.rip3),
      fmtRate(p.preRip_5pct_pct).padStart(COL.rip5),
    ].join('  ');
    lines.push(`  ${row}`);
  }
  return lines;
}

function renderFullComboLagDetails(report: PolicyLagReport | undefined): string[] {
  const lines: string[] = [];
  if (!report || report.candidates.length === 0) {
    lines.push('  (no full combo candidates)');
    lines.push('');
    return lines;
  }

  const hdr = [
    'sym/addr'.padEnd(16),
    'firstSeenAt'.padEnd(20),
    'approvedAt'.padEnd(20),
    'lagMin'.padStart(7),
    'firstPct'.padStart(9),
    'approvPct'.padStart(10),
    'preMove'.padStart(8),
    'bestPre'.padStart(8),
    'preRip'.padStart(7),
  ].join('  ');
  lines.push(`  ${hdr}`);
  lines.push(`  ${'─'.repeat(hdr.length)}`);

  for (const c of report.candidates) {
    const lbl        = c.symbol ? `$${c.symbol}` : c.contractKeyShort;
    const firstSeen  = c.hasObservation && c.firstSeenAt
      ? c.firstSeenAt.slice(0, 19).replace('T', ' ')
      : 'missing';
    const approved   = c.approvedAt.slice(0, 19).replace('T', ' ');
    const row = [
      lbl.padEnd(16),
      firstSeen.padEnd(20),
      approved.padEnd(20),
      fmtMin(c.lagMinutes).padStart(7),
      fmtPct(c.firstSeenPriceChangePct).padStart(9),
      fmtPct(c.approvalPriceChangePct).padStart(10),
      fmtPct(c.preApprovalMovePct).padStart(8),
      fmtPct(c.bestPreApprovalPct).padStart(8),
      fmtPreRipFlag(c).padStart(7),
    ].join('  ');
    lines.push(`  ${row}`);
  }
  lines.push('');
  return lines;
}

export function renderRipperEntryLagReport(
  result: RipperEntryLagReportResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER ENTRY LAG REPORT');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY — SHADOW ANALYSIS]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated            : ${result.generatedAt}`);
  lines.push('');
  lines.push('  Inputs:');
  lines.push(`    Approval files     : ${result.approvalFilesRead}${result.approvalFilesMissing > 0 ? ` (${result.approvalFilesMissing} missing)` : ''}`);
  lines.push(`    Observation files  : ${result.observationFilesRead}${result.observationFilesMissing > 0 ? ` (${result.observationFilesMissing} missing)` : ''}`);
  lines.push(`    Approvals loaded   : ${result.approvalsLoaded}`);
  lines.push(`    Observations loaded: ${result.observationsLoaded}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  ENTRY LAG SUMMARY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  for (const l of renderLagSummary(result.summary)) lines.push(l);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  POLICY ENTRY LAG COMPARISON');
  lines.push(`  ${SEP2}`);
  lines.push('');
  for (const l of renderPolicyComparisonTable(result.policies)) lines.push(l);
  lines.push('');

  const fullCombo = result.policies.find(p => p.policyId === FULL_COMBO_LAG_POLICY_ID);
  lines.push(`  ${SEP2}`);
  lines.push('  FULL COMBO ENTRY LAG DETAILS');
  lines.push(`  ${SEP2}`);
  lines.push('');
  for (const l of renderFullComboLagDetails(fullCombo)) lines.push(l);

  lines.push(`  ${SEP2}`);
  lines.push('  DO NOT APPLY YET');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  * Entry lag analysis only — no real or paper positions were opened.');
  lines.push('  * Do NOT enable real trading.');
  lines.push('  * Do NOT change paper approval logic.');
  lines.push('  * Do NOT change scoring weights or buy gates.');
  lines.push('  * Do NOT call auto-paper.');
  lines.push('  * PASS is NOT a buy signal — it is a research measurement only.');
  lines.push('');
  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');

  return lines.join('\n');
}

export function renderRipperEntryLagReportUsage(): string {
  return `
token:ripper-entry-lag-report — measure how much a token moved before approval

Usage:
  npm run token:ripper-entry-lag-report -- \\
    --approvals    <cycle-jsonl...>  \\
    --observations <obs-jsonl...>

Options:
  --approvals    <paths>   cycle JSONL files containing BUY_APPROVED_PAPER fixtures
  --observations <paths>   observation JSONL files (any-time snapshots)
  --help                   show this message

Measurements:
  firstSeenAt           : earliest observation at or before approvedAt (null if none)
  lagMinutes            : approvedAt - firstSeenAt in minutes (always >= 0, null if no pre-approval obs)
  firstSeenPriceChangePct : priceChangePct at first pre-approval observation
  preApprovalMovePct    : approvalPct - firstSeenPct (positive = pre-rip)
  bestPreApprovalPct    : max pct among all observations at or before approvedAt
  preRip flags          : preApprovalMovePct >= 1%, 3%, 5%

Policies compared:
  ALL                                    — all approvals (baseline)
  price_gt_0_25                          — approvalPriceChangePct > 0.25
  price_gt_0_25_and_liq_30k_and_vol_20k — full combo (all three)

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap.
  No live API calls. Read-only artifact scan. No gate or scoring changes.
`.trim();
}
