import * as fs from 'fs';
import {
  readFixturesFromJsonl,
  SHADOW_POLICY_PRICE_GT_0_25,
} from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ShadowPortfolioGroup = 'ALL' | 'PASS' | 'FAIL' | 'MISSING';
export type EntryClassification  = 'WINNER' | 'LOSER' | 'PENDING_PRICE';

export interface PortfolioCandidate {
  contractKey:         string;
  contractKeyShort:    string;
  symbol?:             string;
  sourceFile:          string;
  approvedAt:          string;
  approvalInstanceKey: string;
  repeatedContract:    boolean;
  shadowPolicyId:      string;
  shadowPolicyPass:    boolean | null;
  shadowPolicyValue:   number | null;
  outcomePctChange:    number | null;
  classification:      EntryClassification;
}

export interface PortfolioGroupStats {
  group:          ShadowPortfolioGroup;
  count:          number;
  pricedCount:    number;
  pendingCount:   number;
  winners:        number;
  losers:         number;
  winRate:        number | null;
  avgPct:         number | null;
  medianPct:      number | null;
  totalSimPct:    number | null;
  avgWinnerPct:   number | null;
  avgLoserPct:    number | null;
  bestCandidate:  PortfolioCandidate | null;
  worstCandidate: PortfolioCandidate | null;
  candidates:     PortfolioCandidate[];
}

export interface PolicyReadComparison {
  passAvgPct:          number | null;
  failAvgPct:          number | null;
  passWinRate:         number | null;
  failWinRate:         number | null;
  passWorstLossPct:    number | null;
  failWorstLossPct:    number | null;
  passPendingCount:    number;
  failPendingCount:    number;
  totalPricedCount:    number;
  passIsOutperforming: boolean | null;
}

export interface RipperShadowPortfolioReportOptions {
  approvalPaths: string[];
  outcomePaths:  string[];
  nowMs?:        number;
}

export interface RipperShadowPortfolioReportResult {
  generatedAt:             string;
  approvalFilesRead:       number;
  approvalFilesMissing:    number;
  outcomeFilesRead:        number;
  outcomeFilesMissing:     number;
  approvalsRead:           number;
  approvalInstancesLoaded: number;
  exactDuplicatesSkipped:  number;
  uniqueContracts:         number;
  repeatedContractsCount:  number;
  outcomesRead:            number;
  totalCandidates:         number;
  groups:                  Record<ShadowPortfolioGroup, PortfolioGroupStats>;
  policyRead:              PolicyReadComparison;
  realTradingLocked:       true;
  tradingExecuted:         0;
  noRealTradeSent:         true;
  paperOnly:               true;
  readOnly:                true;
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

function classify(outcomePctChange: number | null): EntryClassification {
  if (outcomePctChange == null) return 'PENDING_PRICE';
  return outcomePctChange > 0 ? 'WINNER' : 'LOSER';
}

function groupOf(shadowPolicyPass: boolean | null): Exclude<ShadowPortfolioGroup, 'ALL'> {
  if (shadowPolicyPass === true)  return 'PASS';
  if (shadowPolicyPass === false) return 'FAIL';
  return 'MISSING';
}

function buildGroupStats(
  group:      ShadowPortfolioGroup,
  candidates: PortfolioCandidate[],
): PortfolioGroupStats {
  const priced  = candidates.filter(c => c.outcomePctChange != null);
  const pending = candidates.filter(c => c.outcomePctChange == null);
  const winners = priced.filter(c => c.classification === 'WINNER');
  const losers  = priced.filter(c => c.classification === 'LOSER');
  const outcomes     = priced.map(c => c.outcomePctChange as number);
  const winnerOuts   = winners.map(c => c.outcomePctChange as number);
  const loserOuts    = losers.map(c => c.outcomePctChange as number);
  const totalSimPct  = outcomes.length > 0 ? outcomes.reduce((s, n) => s + n, 0) : null;

  const sorted = [...priced].sort((a, b) =>
    (b.outcomePctChange as number) - (a.outcomePctChange as number),
  );
  const best  = sorted[0]                    ?? null;
  const worst = sorted[sorted.length - 1]    ?? null;

  return {
    group,
    count:         candidates.length,
    pricedCount:   priced.length,
    pendingCount:  pending.length,
    winners:       winners.length,
    losers:        losers.length,
    winRate:       priced.length > 0 ? (winners.length / priced.length) * 100 : null,
    avgPct:        avgOf(outcomes),
    medianPct:     medianOf(outcomes),
    totalSimPct,
    avgWinnerPct:  avgOf(winnerOuts),
    avgLoserPct:   avgOf(loserOuts),
    bestCandidate:  best,
    worstCandidate: worst,
    candidates,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperShadowPortfolioReport(
  options: RipperShadowPortfolioReportOptions,
): RipperShadowPortfolioReportResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Step 1: Read approval fixtures (dedup only exact duplicates) ──────────
  let approvalFilesRead    = 0;
  let approvalFilesMissing = 0;
  let approvalsRead        = 0;
  let exactDuplicatesSkipped = 0;

  interface InstanceEntry {
    fixture:     ReturnType<typeof readFixturesFromJsonl>[number];
    sourceFile:  string;
    instanceKey: string;
    contractKey: string;
  }
  const instanceKeySet = new Set<string>();
  const instances: InstanceEntry[] = [];

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) { approvalFilesMissing++; continue; }
    approvalFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      approvalsRead++;
      const contractKey = signalKey(f.normalizedSignal);
      const instanceKey = `${contractKey}::${f.capturedAt}`;
      if (instanceKeySet.has(instanceKey)) {
        exactDuplicatesSkipped++;
      } else {
        instanceKeySet.add(instanceKey);
        instances.push({ fixture: f, sourceFile: p, instanceKey, contractKey });
      }
    }
  }

  const contractKeyCounts = new Map<string, number>();
  for (const inst of instances) {
    contractKeyCounts.set(inst.contractKey, (contractKeyCounts.get(inst.contractKey) ?? 0) + 1);
  }
  const uniqueContracts        = contractKeyCounts.size;
  const repeatedContractsCount = [...contractKeyCounts.values()].filter(n => n > 1).length;

  // ── Step 2: Read outcome data (latest checkpointAt per contractKey) ────────
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
  const all: PortfolioCandidate[] = [];

  for (const { fixture: f, sourceFile, instanceKey, contractKey: key } of instances) {
    const out              = outcomeMap.get(key);
    const outcomePctChange = out?.pctChangeFromEntry ?? null;
    const shadowPolicyPass = f.shadowPolicyPass ?? null;

    all.push({
      contractKey:         key,
      contractKeyShort:    shortKey(key),
      symbol:              f.normalizedSignal.symbol,
      sourceFile,
      approvedAt:          f.capturedAt,
      approvalInstanceKey: instanceKey,
      repeatedContract:    (contractKeyCounts.get(key) ?? 1) > 1,
      shadowPolicyId:      f.shadowPolicyId ?? SHADOW_POLICY_PRICE_GT_0_25,
      shadowPolicyPass,
      shadowPolicyValue:   f.shadowPolicyValue ?? null,
      outcomePctChange,
      classification:      classify(outcomePctChange),
    });
  }

  // Sort: priced desc, then pending
  all.sort((a, b) => {
    if (a.outcomePctChange != null && b.outcomePctChange != null) return b.outcomePctChange - a.outcomePctChange;
    if (a.outcomePctChange != null) return -1;
    if (b.outcomePctChange != null) return  1;
    return 0;
  });

  // ── Step 4: Build group stats ───────────────────────────────────────────────
  const pass    = all.filter(c => c.shadowPolicyPass === true);
  const fail    = all.filter(c => c.shadowPolicyPass === false);
  const missing = all.filter(c => c.shadowPolicyPass == null);

  const groups: Record<ShadowPortfolioGroup, PortfolioGroupStats> = {
    ALL:     buildGroupStats('ALL',     all),
    PASS:    buildGroupStats('PASS',    pass),
    FAIL:    buildGroupStats('FAIL',    fail),
    MISSING: buildGroupStats('MISSING', missing),
  };

  // ── Step 5: Policy read comparison ─────────────────────────────────────────
  const passStats = groups['PASS'];
  const failStats = groups['FAIL'];

  const passWorstLoss = passStats.worstCandidate?.outcomePctChange ?? null;
  const failWorstLoss = failStats.worstCandidate?.outcomePctChange ?? null;

  const passIsOutperforming =
    passStats.avgPct != null && failStats.avgPct != null
      ? passStats.avgPct > failStats.avgPct
      : null;

  const policyRead: PolicyReadComparison = {
    passAvgPct:          passStats.avgPct,
    failAvgPct:          failStats.avgPct,
    passWinRate:         passStats.winRate,
    failWinRate:         failStats.winRate,
    passWorstLossPct:    passWorstLoss,
    failWorstLossPct:    failWorstLoss,
    passPendingCount:    passStats.pendingCount,
    failPendingCount:    failStats.pendingCount,
    totalPricedCount:    groups['ALL'].pricedCount,
    passIsOutperforming,
  };

  return {
    generatedAt,
    approvalFilesRead,
    approvalFilesMissing,
    outcomeFilesRead,
    outcomeFilesMissing,
    approvalsRead,
    approvalInstancesLoaded: approvalsRead,
    exactDuplicatesSkipped,
    uniqueContracts,
    repeatedContractsCount,
    outcomesRead,
    totalCandidates: all.length,
    groups,
    policyRead,
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
  return `${sign}${n.toFixed(1)}%`;
}

function fmtPctPad(n: number | null | undefined, width = 8): string {
  return fmtPct(n).padStart(width);
}

function fmtRate(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  return `${n.toFixed(0)}%`;
}

const PASS_LABEL    = '✓ PASS   ';
const FAIL_LABEL    = '✗ FAIL   ';
const MISSING_LABEL = '? MISSING';

function groupLabel(g: ShadowPortfolioGroup): string {
  if (g === 'PASS')    return PASS_LABEL;
  if (g === 'FAIL')    return FAIL_LABEL;
  if (g === 'MISSING') return MISSING_LABEL;
  return 'ALL      ';
}

function fmtClass(c: EntryClassification): string {
  if (c === 'WINNER')       return 'WINNER ';
  if (c === 'LOSER')        return 'LOSER  ';
  return 'PENDING';
}

function renderGroupBlock(stats: PortfolioGroupStats): string[] {
  const lines: string[] = [];
  const tag = groupLabel(stats.group);
  lines.push(`  ${tag}  (${stats.count} candidate${stats.count === 1 ? '' : 's'})`);
  if (stats.count === 0) {
    lines.push('    (no candidates in this group)');
    return lines;
  }
  lines.push(`    Priced/Pending : ${stats.pricedCount} / ${stats.pendingCount}`);
  lines.push(`    Winners/Losers : ${stats.winners} / ${stats.losers}  win rate: ${fmtRate(stats.winRate)}`);
  if (stats.avgPct != null)        lines.push(`    Avg outcome    : ${fmtPct(stats.avgPct)}`);
  if (stats.medianPct != null)     lines.push(`    Median outcome : ${fmtPct(stats.medianPct)}`);
  if (stats.totalSimPct != null)   lines.push(`    Total sim pct  : ${fmtPct(stats.totalSimPct)}`);
  if (stats.avgWinnerPct != null)  lines.push(`    Avg winner     : ${fmtPct(stats.avgWinnerPct)}`);
  if (stats.avgLoserPct != null)   lines.push(`    Avg loser      : ${fmtPct(stats.avgLoserPct)}`);
  if (stats.bestCandidate) {
    const b = stats.bestCandidate;
    const label = b.symbol ? `$${b.symbol}` : b.contractKeyShort;
    lines.push(`    Best           : ${label}  ${fmtPct(b.outcomePctChange)}`);
  }
  if (stats.worstCandidate && stats.worstCandidate !== stats.bestCandidate) {
    const w = stats.worstCandidate;
    const label = w.symbol ? `$${w.symbol}` : w.contractKeyShort;
    lines.push(`    Worst          : ${label}  ${fmtPct(w.outcomePctChange)}`);
  }
  return lines;
}

export function renderRipperShadowPortfolioReport(
  result: RipperShadowPortfolioReportResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER SHADOW PORTFOLIO REPORT');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY — SHADOW ANALYSIS]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated         : ${result.generatedAt}`);
  lines.push(`  Shadow policy     : price_gt_0_25  (approvalPriceChangePct > 0.25)`);
  lines.push('');
  lines.push('  Inputs:');
  lines.push(`    Approval files  : ${result.approvalFilesRead}${result.approvalFilesMissing > 0 ? ` (${result.approvalFilesMissing} missing)` : ''}`);
  lines.push(`    Outcome files   : ${result.outcomeFilesRead}${result.outcomeFilesMissing > 0 ? ` (${result.outcomeFilesMissing} missing)` : ''}`);
  {
    const dupNote  = result.exactDuplicatesSkipped > 0 ? ` (${result.exactDuplicatesSkipped} exact dup${result.exactDuplicatesSkipped === 1 ? '' : 's'} skipped)` : '';
    const instWord = result.totalCandidates === 1 ? 'instance' : 'instances';
    lines.push(`    Approvals loaded: ${result.approvalInstancesLoaded} → ${result.totalCandidates} ${instWord}${dupNote}`);
    const repNote  = result.repeatedContractsCount > 0 ? ` (${result.repeatedContractsCount} repeated [*])` : '';
    lines.push(`    Unique contracts: ${result.uniqueContracts}${repNote}`);
  }
  lines.push('');

  if (result.totalCandidates === 0) {
    lines.push('  (no approved candidates — check --approvals paths)');
  } else {
    // ── Candidate table ─────────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  CANDIDATES');
    lines.push(`  ${SEP2}`);
    lines.push('');
    lines.push('  shadow    class    outcome  priceVal  approvedAt           sym/addr');
    let hasRepeated = false;
    for (const c of result.groups['ALL'].candidates) {
      const grp   = groupLabel(c.shadowPolicyPass === true ? 'PASS' : c.shadowPolicyPass === false ? 'FAIL' : 'MISSING').trim().padEnd(7);
      const cls   = fmtClass(c.classification);
      const out   = fmtPctPad(c.outcomePctChange, 8);
      const val   = c.shadowPolicyValue != null
        ? `${c.shadowPolicyValue >= 0 ? '+' : ''}${c.shadowPolicyValue.toFixed(2)}%`.padEnd(9)
        : '(missing)';
      const ts    = c.approvedAt.slice(0, 19).replace('T', ' ');
      const label = c.symbol ? `$${c.symbol}` : c.contractKeyShort;
      const rep   = c.repeatedContract ? ' [*]' : '';
      if (c.repeatedContract) hasRepeated = true;
      lines.push(`  ${grp} ${cls} ${out}  ${val}  ${ts}  ${label}${rep}`);
    }
    if (hasRepeated) {
      lines.push('  [*] Contract approved in multiple sessions. All instances share the same latest outcome (outcomes are keyed by contractKey).');
    }
    lines.push('');

    // ── Portfolio group summaries ────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  PORTFOLIO GROUPS');
    lines.push(`  ${SEP2}`);
    lines.push('');
    const groupOrder: ShadowPortfolioGroup[] = ['ALL', 'PASS', 'FAIL', 'MISSING'];
    for (const g of groupOrder) {
      for (const line of renderGroupBlock(result.groups[g])) lines.push(line);
      lines.push('');
    }

    // ── Policy read ──────────────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  POLICY READ — price_gt_0_25 (shadow only, tiny sample)');
    lines.push(`  ${SEP2}`);
    lines.push('');
    const pr = result.policyRead;
    lines.push(`  PASS avg outcome   : ${fmtPct(pr.passAvgPct).padStart(8)}    FAIL avg outcome   : ${fmtPct(pr.failAvgPct)}`);
    lines.push(`  PASS win rate      : ${fmtRate(pr.passWinRate).padStart(8)}    FAIL win rate      : ${fmtRate(pr.failWinRate)}`);
    if (pr.passWorstLossPct != null || pr.failWorstLossPct != null) {
      lines.push(`  PASS worst outcome : ${fmtPct(pr.passWorstLossPct).padStart(8)}    FAIL worst outcome : ${fmtPct(pr.failWorstLossPct)}`);
    }
    lines.push('');
    if (pr.passPendingCount > 0) {
      lines.push(`  ⚠ PASS has ${pr.passPendingCount} pending candidate(s) — outcomes not yet priced. Numbers may shift.`);
    }
    if (pr.failPendingCount > 0) {
      lines.push(`  ⚠ FAIL has ${pr.failPendingCount} pending candidate(s) — outcomes not yet priced.`);
    }
    if (pr.passIsOutperforming === true) {
      lines.push('  → PASS is outperforming FAIL on avg outcome (shadow read only).');
    } else if (pr.passIsOutperforming === false) {
      lines.push('  → PASS is NOT outperforming FAIL on avg outcome.');
    } else {
      lines.push('  → Cannot compare: one or both groups have no priced candidates.');
    }
    lines.push(`  Sample: ${pr.totalPricedCount} priced candidate(s) total — too small to conclude.`);
    lines.push('');

    // ── Do Not Apply Yet ─────────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  DO NOT APPLY YET');
    lines.push(`  ${SEP2}`);
    lines.push('');
    lines.push('  * This is a shadow portfolio only — no real or paper positions were opened.');
    lines.push('  * Do NOT turn price_gt_0_25 into a real buy gate.');
    lines.push('  * Do NOT block approvals based on this policy.');
    lines.push('  * Do NOT change scoring weights.');
    lines.push('  * Do NOT enable real trading.');
    lines.push('  * PASS is NOT a buy signal — it is a research group with a tiny sample.');
    lines.push('  * Need a much larger priced sample before any rule changes.');
    lines.push('');
  }

  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperShadowPortfolioReportUsage(): string {
  return `
token:ripper-shadow-portfolio-report — shadow paper portfolios by policy group

Usage:
  npm run token:ripper-shadow-portfolio-report -- \\
    --approvals <cycle-jsonl...>   \\
    --outcomes  <outcome-json...>

Options:
  --approvals <paths>   cycle JSONL files containing BUY_APPROVED_PAPER fixtures
  --outcomes  <paths>   approved outcome JSON checkpoint files
  --help                show this message

Groups:
  ALL     — every approved candidate
  PASS    — approvalPriceChangePct > 0.25
  FAIL    — approvalPriceChangePct <= 0.25
  MISSING — approvalPriceChangePct not available (old artifact)

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap.
  No live API calls. Read-only artifact scan. No gate or scoring changes.
`.trim();
}
