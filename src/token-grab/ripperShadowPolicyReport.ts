import * as fs from 'fs';
import {
  readFixturesFromJsonl,
  SHADOW_POLICY_PRICE_GT_0_25,
  type LiveRipperFixture,
} from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ShadowPolicyGroup = 'PASS' | 'FAIL' | 'MISSING';
export type EntryClassification = 'WINNER' | 'LOSER' | 'PENDING_PRICE';

export interface ShadowPolicyCandidate {
  contractKey:       string;
  contractKeyShort:  string;
  symbol?:           string;
  shadowPolicyId:    string;
  shadowPolicyGroup: ShadowPolicyGroup;
  shadowPolicyPass:  boolean | null;
  shadowPolicyValue: number | null;
  outcomePctChange:  number | null;
  classification:    EntryClassification;
}

export interface ShadowPolicyGroupSummary {
  group:             ShadowPolicyGroup;
  count:             number;
  pricedCount:       number;
  winners:           number;
  losers:            number;
  pendingPrice:      number;
  avgOutcomePct:     number | null;
  medianOutcomePct:  number | null;
  bestCandidate:     ShadowPolicyCandidate | null;
  worstCandidate:    ShadowPolicyCandidate | null;
}

export interface RipperShadowPolicyReportOptions {
  approvalPaths: string[];
  outcomePaths:  string[];
  nowMs?:        number;
}

export interface RipperShadowPolicyReportResult {
  generatedAt:              string;
  approvalFilesRead:        number;
  approvalFilesMissing:     number;
  outcomeFilesRead:         number;
  outcomeFilesMissing:      number;
  approvalsRead:            number;
  outcomesRead:             number;
  totalCandidates:          number;
  totalPass:                number;
  totalFail:                number;
  totalMissing:             number;
  candidates:               ShadowPolicyCandidate[];
  groupSummaries:           ShadowPolicyGroupSummary[];
  realTradingLocked:        true;
  tradingExecuted:          0;
  noRealTradeSent:          true;
  paperOnly:                true;
  readOnly:                 true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function toFiniteNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function shortKey(k: string): string {
  return k.length > 14 ? `${k.slice(0, 14)}…` : k;
}

function safeRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function safeStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function classifyFromOutcome(outcomePctChange: number | null): EntryClassification {
  if (outcomePctChange == null) return 'PENDING_PRICE';
  return outcomePctChange > 0 ? 'WINNER' : 'LOSER';
}

function shadowGroupFrom(f: LiveRipperFixture): ShadowPolicyGroup {
  if (f.shadowPolicyPass === true)  return 'PASS';
  if (f.shadowPolicyPass === false) return 'FAIL';
  return 'MISSING';
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperShadowPolicyReport(
  options: RipperShadowPolicyReportOptions,
): RipperShadowPolicyReportResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Step 1: Read approval fixtures (earliest capturedAt per key) ──────────
  let approvalFilesRead    = 0;
  let approvalFilesMissing = 0;
  let approvalsRead        = 0;
  const approvalMap        = new Map<string, LiveRipperFixture>();

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) { approvalFilesMissing++; continue; }
    approvalFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      approvalsRead++;
      const key = signalKey(f.normalizedSignal);
      const ex  = approvalMap.get(key);
      if (!ex || f.capturedAt < ex.capturedAt) approvalMap.set(key, f);
    }
  }

  // ── Step 2: Read outcome data (latest checkpointAt per contractKey) ───────
  let outcomeFilesRead    = 0;
  let outcomeFilesMissing = 0;
  let outcomesRead        = 0;

  interface OutcomeEntry { pctChangeFromEntry: number | null; checkpointAt: string }
  const outcomeMap = new Map<string, OutcomeEntry>();

  for (const p of options.outcomePaths) {
    if (!fs.existsSync(p)) { outcomeFilesMissing++; continue; }
    outcomeFilesRead++;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { continue; }
    const rec = safeRecord(parsed);
    const fileCheckpointAt = safeStr(rec['checkpointAt']) ?? safeStr(rec['generatedAt']) ?? '';
    const cands = Array.isArray(rec['candidates']) ? rec['candidates'] as unknown[] : [];
    for (const c of cands) {
      const cr  = safeRecord(c);
      const key = safeStr(cr['contractKey']);
      if (!key) continue;
      outcomesRead++;
      const ckAt = safeStr(cr['checkpointAt']) ?? fileCheckpointAt;
      const ex   = outcomeMap.get(key);
      if (!ex || ckAt >= ex.checkpointAt) {
        outcomeMap.set(key, { pctChangeFromEntry: toFiniteNum(cr['pctChangeFromEntry']), checkpointAt: ckAt });
      }
    }
  }

  // ── Step 3: Build per-candidate records ────────────────────────────────────
  const candidates: ShadowPolicyCandidate[] = [];

  for (const [key, f] of approvalMap) {
    const out = outcomeMap.get(key);
    const outcomePctChange: number | null = out?.pctChangeFromEntry ?? null;

    candidates.push({
      contractKey:       key,
      contractKeyShort:  shortKey(key),
      symbol:            f.normalizedSignal.symbol,
      shadowPolicyId:    f.shadowPolicyId ?? SHADOW_POLICY_PRICE_GT_0_25,
      shadowPolicyGroup: shadowGroupFrom(f),
      shadowPolicyPass:  f.shadowPolicyPass ?? null,
      shadowPolicyValue: f.shadowPolicyValue ?? null,
      outcomePctChange,
      classification:    classifyFromOutcome(outcomePctChange),
    });
  }

  // Sort: priced first (desc), then pending
  candidates.sort((a, b) => {
    if (a.outcomePctChange != null && b.outcomePctChange != null) return b.outcomePctChange - a.outcomePctChange;
    if (a.outcomePctChange != null) return -1;
    if (b.outcomePctChange != null) return  1;
    return 0;
  });

  // ── Step 4: Build per-group summaries ──────────────────────────────────────
  const groupOrder: ShadowPolicyGroup[] = ['PASS', 'FAIL', 'MISSING'];
  const groupSummaries: ShadowPolicyGroupSummary[] = groupOrder.map(group => {
    const members = candidates.filter(c => c.shadowPolicyGroup === group);
    const priced  = members.filter(c => c.outcomePctChange != null);
    const outcomes = priced.map(c => c.outcomePctChange as number);
    const winners  = priced.filter(c => c.classification === 'WINNER').length;
    const losers   = priced.filter(c => c.classification === 'LOSER').length;
    const pending  = members.filter(c => c.classification === 'PENDING_PRICE').length;

    const best  = priced.length > 0 ? priced.reduce((a, b) =>
      (a.outcomePctChange as number) >= (b.outcomePctChange as number) ? a : b
    ) : null;
    const worst = priced.length > 0 ? priced.reduce((a, b) =>
      (a.outcomePctChange as number) <= (b.outcomePctChange as number) ? a : b
    ) : null;

    return {
      group,
      count:            members.length,
      pricedCount:      priced.length,
      winners,
      losers,
      pendingPrice:     pending,
      avgOutcomePct:    avgOf(outcomes),
      medianOutcomePct: medianOf(outcomes),
      bestCandidate:    best,
      worstCandidate:   worst,
    };
  });

  const totalPass    = candidates.filter(c => c.shadowPolicyGroup === 'PASS').length;
  const totalFail    = candidates.filter(c => c.shadowPolicyGroup === 'FAIL').length;
  const totalMissing = candidates.filter(c => c.shadowPolicyGroup === 'MISSING').length;

  return {
    generatedAt,
    approvalFilesRead,
    approvalFilesMissing,
    outcomeFilesRead,
    outcomeFilesMissing,
    approvalsRead,
    outcomesRead,
    totalCandidates:   candidates.length,
    totalPass,
    totalFail,
    totalMissing,
    candidates,
    groupSummaries,
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '   n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtGroup(g: ShadowPolicyGroup): string {
  if (g === 'PASS')    return '✓PASS   ';
  if (g === 'FAIL')    return '✗FAIL   ';
  return '?MISSING';
}

function fmtClass(c: EntryClassification): string {
  if (c === 'WINNER')       return 'WINNER ';
  if (c === 'LOSER')        return 'LOSER  ';
  return 'PENDING';
}

export function renderRipperShadowPolicyReport(
  result: RipperShadowPolicyReportResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER SHADOW POLICY REPORT');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY — SHADOW ANALYSIS]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated          : ${result.generatedAt}`);
  lines.push(`  Shadow policy      : price_gt_0_25  (approvalPriceChangePct > 0.25 — shadow only)`);
  lines.push('');
  lines.push('  Inputs:');
  lines.push(`    Approval files   : ${result.approvalFilesRead}${result.approvalFilesMissing > 0 ? ` (${result.approvalFilesMissing} missing)` : ''}`);
  lines.push(`    Outcome files    : ${result.outcomeFilesRead}${result.outcomeFilesMissing > 0 ? ` (${result.outcomeFilesMissing} missing)` : ''}`);
  lines.push('');
  lines.push('  Candidates:');
  lines.push(`    Total approvals  : ${result.totalCandidates}`);
  lines.push(`    Shadow PASS      : ${result.totalPass}`);
  lines.push(`    Shadow FAIL      : ${result.totalFail}`);
  lines.push(`    Shadow MISSING   : ${result.totalMissing}`);
  lines.push('');

  if (result.totalCandidates === 0) {
    lines.push('  (no approved candidates — check --approvals paths)');
    lines.push('');
  } else {
    // ── Per-candidate table ─────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  CANDIDATES');
    lines.push(`  ${SEP2}`);
    lines.push('');
    lines.push('  shadow    class    outcome  priceVal  sym/addr');
    for (const c of result.candidates) {
      const grp    = fmtGroup(c.shadowPolicyGroup);
      const cls    = fmtClass(c.classification);
      const out    = fmtPct(c.outcomePctChange).padEnd(8);
      const val    = c.shadowPolicyValue != null
        ? `${c.shadowPolicyValue >= 0 ? '+' : ''}${c.shadowPolicyValue.toFixed(2)}%`.padEnd(9)
        : '(missing) ';
      const label  = c.symbol ? `$${c.symbol}` : c.contractKeyShort;
      lines.push(`  ${grp} ${cls} ${out} ${val} ${label}`);
    }
    lines.push('');

    // ── Group summaries ─────────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  GROUP SUMMARY');
    lines.push(`  ${SEP2}`);
    lines.push('');
    for (const g of result.groupSummaries) {
      if (g.count === 0) continue;
      const tag = g.group === 'PASS' ? '✓ PASS' : g.group === 'FAIL' ? '✗ FAIL' : '? MISSING';
      lines.push(`  ${tag} — ${g.count} candidate(s)`);
      lines.push(`    Priced       : ${g.pricedCount}`);
      lines.push(`    Winners      : ${g.winners}`);
      lines.push(`    Losers       : ${g.losers}`);
      lines.push(`    Pending      : ${g.pendingPrice}`);
      if (g.avgOutcomePct != null) {
        lines.push(`    Avg outcome  : ${fmtPct(g.avgOutcomePct)}`);
      }
      if (g.medianOutcomePct != null) {
        lines.push(`    Median outcome: ${fmtPct(g.medianOutcomePct)}`);
      }
      if (g.bestCandidate) {
        const b = g.bestCandidate;
        const label = b.symbol ? `$${b.symbol}` : b.contractKeyShort;
        lines.push(`    Best         : ${label}  ${fmtPct(b.outcomePctChange)}`);
      }
      if (g.worstCandidate && g.worstCandidate !== g.bestCandidate) {
        const w = g.worstCandidate;
        const label = w.symbol ? `$${w.symbol}` : w.contractKeyShort;
        lines.push(`    Worst        : ${label}  ${fmtPct(w.outcomePctChange)}`);
      }
      lines.push('');
    }

    // ── Warning ─────────────────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  DO NOT APPLY — SHADOW ANALYSIS ONLY');
    lines.push(`  ${SEP2}`);
    lines.push('');
    lines.push('  * This is a shadow policy tag — it does NOT affect approvals, scoring, or gates.');
    lines.push('  * Do not turn price_gt_0_25 into a real buy gate.');
    lines.push('  * Do not block paper approvals based on these results.');
    lines.push('  * Sample is tiny. Do not draw conclusions without more data.');
    lines.push('');
  }

  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperShadowPolicyReportUsage(): string {
  return `
token:ripper-shadow-policy-report — compare outcomes by shadow policy group

Usage:
  npm run token:ripper-shadow-policy-report -- \\
    --approvals <cycle-jsonl...>   \\
    --outcomes  <outcome-json...>

Options:
  --approvals <paths>   cycle JSONL files containing BUY_APPROVED_PAPER fixtures
  --outcomes  <paths>   approved outcome JSON checkpoint files
  --help                show this message

Shadow policy:
  price_gt_0_25 — approvalPriceChangePct > 0.25
  Shadow-only: does not affect eligibility, scoring, or buy gates.

Groups:
  PASS    — approvalPriceChangePct was available and > 0.25
  FAIL    — approvalPriceChangePct was available but <= 0.25
  MISSING — approvalPriceChangePct was not available (old artifact or missing field)

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap.
  No live API calls. Read-only artifact scan. No gate or scoring changes.
`.trim();
}
