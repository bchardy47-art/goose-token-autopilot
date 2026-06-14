import * as fs from 'fs';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExitWindowMinutes = 5 | 10 | 15 | 30 | 60;

export const EXIT_WINDOWS: ExitWindowMinutes[] = [5, 10, 15, 30, 60];

export const FULL_COMBO_WINDOW_POLICY_ID = 'price_gt_0_25_and_liq_30k_and_vol_20k';

export interface WindowObservation {
  windowMinutes: ExitWindowMinutes;
  obsTimestamp:  string | null;
  obsOffsetMs:   number | null;
  pctChange:     number | null;
  missing:       boolean;
}

export interface ExitWindowCandidate {
  contractKey:            string;
  contractKeyShort:       string;
  symbol?:                string;
  approvedAt:             string;
  approvalInstanceKey:    string;
  approvalPriceChangePct: number | null;
  liquidityUsd:           number | null;
  volumeUsd:              number | null;
  windows:                WindowObservation[];
  bestWindowMinutes:      ExitWindowMinutes | null;
  worstWindowMinutes:     ExitWindowMinutes | null;
}

export interface WindowStats {
  windowMinutes:  ExitWindowMinutes;
  candidateCount: number;
  missingCount:   number;
  pricedCount:    number;
  winners:        number;
  losers:         number;
  winRate:        number | null;
  avgPct:         number | null;
  medianPct:      number | null;
  worstLoss:      number | null;
  bestGain:       number | null;
  bestGainKey:    string | null;
  worstLossKey:   string | null;
}

export interface PolicyWindowReport {
  policyId:    string;
  description: string;
  candidates:  ExitWindowCandidate[];
  windows:     WindowStats[];
}

export interface RipperExitWindowReportOptions {
  approvalPaths:    string[];
  observationPaths: string[];
  nowMs?:           number;
}

export interface RipperExitWindowReportResult {
  generatedAt:             string;
  approvalFilesRead:       number;
  approvalFilesMissing:    number;
  observationFilesRead:    number;
  observationFilesMissing: number;
  approvalsLoaded:         number;
  observationsLoaded:      number;
  policies:                PolicyWindowReport[];
  realTradingLocked:       true;
  tradingExecuted:         0;
  noRealTradeSent:         true;
  paperOnly:               true;
  readOnly:                true;
}

// ── Policy definitions ────────────────────────────────────────────────────────

interface PolicyDef {
  id:          string;
  description: string;
  evaluate:    (c: ExitWindowCandidate) => boolean;
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
    id:          FULL_COMBO_WINDOW_POLICY_ID,
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

// Gain relative to approval entry: both pcts are from pool creation.
// entry → obs =  ((1 + obsPct/100) / (1 + approvalPct/100) - 1) * 100
function relGainFromApproval(approvalPct: number, obsPct: number): number {
  return ((1 + obsPct / 100) / (1 + approvalPct / 100) - 1) * 100;
}

function windowToleranceMs(w: ExitWindowMinutes): number {
  return (w <= 15 ? 2 : 5) * 60_000;
}

// ── Internal observation entry ─────────────────────────────────────────────────

interface ObsEntry {
  capturedAtMs:   number;
  obsTimestamp:   string;
  priceChangePct: number | null;
}

// ── Window matching ───────────────────────────────────────────────────────────

function findWindowObservation(
  approvedAtMs: number,
  w:            ExitWindowMinutes,
  obs:          ObsEntry[],
  approvalPct:  number | null,
): WindowObservation {
  const targetMs = approvedAtMs + w * 60_000;
  const tolMs    = windowToleranceMs(w);

  const within = obs.filter(o => Math.abs(o.capturedAtMs - targetMs) <= tolMs);
  if (within.length === 0) {
    return { windowMinutes: w, obsTimestamp: null, obsOffsetMs: null, pctChange: null, missing: true };
  }

  // Prefer smallest absolute offset; on tie prefer the one at/after target
  within.sort((a, b) => {
    const da = Math.abs(a.capturedAtMs - targetMs);
    const db = Math.abs(b.capturedAtMs - targetMs);
    if (da !== db) return da - db;
    const aAfter = a.capturedAtMs >= targetMs ? 0 : 1;
    const bAfter = b.capturedAtMs >= targetMs ? 0 : 1;
    return aAfter - bAfter;
  });

  const best      = within[0];
  const pctChange =
    approvalPct != null && best.priceChangePct != null
      ? relGainFromApproval(approvalPct, best.priceChangePct)
      : null;

  return {
    windowMinutes: w,
    obsTimestamp:  best.obsTimestamp,
    obsOffsetMs:   best.capturedAtMs - approvedAtMs,
    pctChange,
    missing:       false,
  };
}

// ── Per-window stats ──────────────────────────────────────────────────────────

function buildWindowStats(candidates: ExitWindowCandidate[], w: ExitWindowMinutes): WindowStats {
  const wObs    = candidates.map(c => c.windows.find(wo => wo.windowMinutes === w)!);
  const priced  = wObs.filter(wo => !wo.missing && wo.pctChange != null);
  const pcts    = priced.map(wo => wo.pctChange as number);
  const winners = priced.filter(wo => (wo.pctChange as number) > 0);
  const losers  = priced.filter(wo => (wo.pctChange as number) < 0);
  const missing = wObs.filter(wo => wo.missing);

  let bestGain: number | null = null;
  let bestGainKey: string | null = null;
  let worstLoss: number | null = null;
  let worstLossKey: string | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const pct = wObs[i].pctChange;
    if (pct == null || wObs[i].missing) continue;
    if (bestGain    == null || pct > bestGain)    { bestGain    = pct; bestGainKey  = candidates[i].contractKey; }
    if (worstLoss   == null || pct < worstLoss)   { worstLoss   = pct; worstLossKey = candidates[i].contractKey; }
  }

  return {
    windowMinutes:  w,
    candidateCount: candidates.length,
    missingCount:   missing.length,
    pricedCount:    priced.length,
    winners:        winners.length,
    losers:         losers.length,
    winRate:        priced.length > 0 ? (winners.length / priced.length) * 100 : null,
    avgPct:         avgOf(pcts),
    medianPct:      medianOf(pcts),
    worstLoss,
    bestGain,
    bestGainKey,
    worstLossKey,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperExitWindowReport(
  options: RipperExitWindowReportOptions,
): RipperExitWindowReportResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Step 1: Load approval fixtures (instance-aware, skip exact duplicates) ──
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
      const sig = f.normalizedSignal as Record<string, unknown>;
      const approvedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(approvedAtMs)) continue;
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

  // ── Step 2: Load observation JSONL files ───────────────────────────────────
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
        obsTimestamp:   f.capturedAt,
        priceChangePct: toFiniteNum((f.normalizedSignal as Record<string, unknown>)['priceChangePct']),
      };
      const list = obsMap.get(key);
      if (list) list.push(entry);
      else obsMap.set(key, [entry]);
    }
  }

  // ── Step 3: Build per-instance candidates ─────────────────────────────────
  const allCandidates: ExitWindowCandidate[] = [];

  for (const a of approvals) {
    const obs     = obsMap.get(a.contractKey) ?? [];
    const windows = EXIT_WINDOWS.map(w =>
      findWindowObservation(a.approvedAtMs, w, obs, a.approvalPriceChangePct),
    );

    const pricedWindows = windows.filter(wo => !wo.missing && wo.pctChange != null);
    const bestWindowMinutes: ExitWindowMinutes | null =
      pricedWindows.length > 0
        ? pricedWindows.reduce((best, wo) => (wo.pctChange! > best.pctChange! ? wo : best)).windowMinutes
        : null;
    const worstWindowMinutes: ExitWindowMinutes | null =
      pricedWindows.length > 0
        ? pricedWindows.reduce((worst, wo) => (wo.pctChange! < worst.pctChange! ? wo : worst)).windowMinutes
        : null;

    allCandidates.push({
      contractKey:            a.contractKey,
      contractKeyShort:       shortKey(a.contractKey),
      symbol:                 a.symbol,
      approvedAt:             a.approvedAt,
      approvalInstanceKey:    a.instanceKey,
      approvalPriceChangePct: a.approvalPriceChangePct,
      liquidityUsd:           a.liquidityUsd,
      volumeUsd:              a.volumeUsd,
      windows,
      bestWindowMinutes,
      worstWindowMinutes,
    });
  }

  // ── Step 4: Build per-policy reports ──────────────────────────────────────
  const policies: PolicyWindowReport[] = POLICIES.map(pol => {
    const cands = allCandidates.filter(c => pol.evaluate(c));
    return {
      policyId:    pol.id,
      description: pol.description,
      candidates:  cands,
      windows:     EXIT_WINDOWS.map(w => buildWindowStats(cands, w)),
    };
  });

  return {
    generatedAt,
    approvalFilesRead,
    approvalFilesMissing,
    observationFilesRead,
    observationFilesMissing,
    approvalsLoaded,
    observationsLoaded,
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
  return `${sign}${n.toFixed(1)}%`;
}

function fmtRate(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  return `${n.toFixed(0)}%`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtOffsetMs(ms: number | null): string {
  if (ms == null) return '  n/a  ';
  const sign  = ms >= 0 ? '+' : '-';
  const total = Math.round(Math.abs(ms) / 1000);
  const m     = Math.floor(total / 60);
  const s     = total % 60;
  return `${sign}${m}m${s > 0 ? `${s}s` : ''}`;
}

function renderPolicySection(report: PolicyWindowReport): string[] {
  const lines: string[] = [];
  const sep = '────────────────────────────────────────────────────────────────';
  lines.push(`  ── ${report.policyId}`);
  lines.push(`     ${report.description}`);
  lines.push(`     Candidates: ${report.candidates.length}`);
  lines.push('');

  if (report.candidates.length === 0) {
    lines.push('     (no candidates pass this policy)');
    lines.push('');
    return lines;
  }

  const hdr = `  ${'window'.padEnd(7)} ${'cands'.padStart(6)} ${'miss'.padStart(5)} ${'priced'.padStart(7)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'winRate'.padStart(8)} ${'avg'.padStart(8)} ${'median'.padStart(8)} ${'worst'.padStart(8)} ${'best'.padStart(8)}`;
  lines.push(hdr);
  lines.push(`  ${sep}`);

  for (const ws of report.windows) {
    const row = [
      `+${ws.windowMinutes}m`.padEnd(7),
      String(ws.candidateCount).padStart(6),
      String(ws.missingCount).padStart(5),
      String(ws.pricedCount).padStart(7),
      String(ws.winners).padStart(4),
      String(ws.losers).padStart(4),
      fmtRate(ws.winRate).padStart(8),
      fmtPct(ws.avgPct).padStart(8),
      fmtPct(ws.medianPct).padStart(8),
      fmtPct(ws.worstLoss).padStart(8),
      fmtPct(ws.bestGain).padStart(8),
    ].join(' ');
    lines.push(`  ${row}`);
  }
  lines.push('');
  return lines;
}

function renderFullComboDetails(report: PolicyWindowReport | undefined): string[] {
  const lines: string[] = [];
  if (!report || report.candidates.length === 0) {
    lines.push('  (no full combo candidates)');
    lines.push('');
    return lines;
  }

  const winCols = EXIT_WINDOWS.map(w => `+${w}m`.padStart(7)).join(' ');
  lines.push(`  ${'sym/addr'.padEnd(16)} ${'approvedAt'.padEnd(19)} ${'pricePct'.padStart(9)} ${'liqUsd'.padStart(9)} ${'volUsd'.padStart(9)}  ${winCols}  ${'best'.padStart(5)} ${'worst'.padStart(5)}`);
  lines.push(`  ${'─'.repeat(130)}`);

  for (const c of report.candidates) {
    const lbl     = c.symbol ? `$${c.symbol}` : c.contractKeyShort;
    const ts      = c.approvedAt.slice(0, 19).replace('T', ' ');
    const prc     = c.approvalPriceChangePct != null
      ? `${c.approvalPriceChangePct >= 0 ? '+' : ''}${c.approvalPriceChangePct.toFixed(2)}%`
      : 'n/a';
    const liq     = fmtUsd(c.liquidityUsd);
    const vol     = fmtUsd(c.volumeUsd);
    const winPcts = EXIT_WINDOWS.map(w => {
      const wo = c.windows.find(wo => wo.windowMinutes === w)!;
      return (wo.missing ? ' miss  ' : fmtPct(wo.pctChange)).padStart(7);
    }).join(' ');
    const best  = c.bestWindowMinutes  != null ? `+${c.bestWindowMinutes}m`  : 'n/a';
    const worst = c.worstWindowMinutes != null ? `+${c.worstWindowMinutes}m` : 'n/a';
    lines.push(`  ${lbl.padEnd(16)} ${ts.padEnd(19)} ${prc.padStart(9)} ${liq.padStart(9)} ${vol.padStart(9)}  ${winPcts}  ${best.padStart(5)} ${worst.padStart(5)}`);
  }
  lines.push('');
  return lines;
}

export function renderRipperExitWindowReport(
  result: RipperExitWindowReportResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER EXIT WINDOW REPORT');
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
  lines.push('  Windows: +5m (±2m tol)  +10m (±2m tol)  +15m (±2m tol)  +30m (±5m tol)  +60m (±5m tol)');
  lines.push('  Outcome: gain relative to approval entry price (pool-creation pct normalization)');
  lines.push('');

  if (result.approvalsLoaded === 0) {
    lines.push('  (no approved candidates — check --approvals paths)');
    lines.push('');
  } else {
    lines.push(`  ${SEP2}`);
    lines.push('  EXIT WINDOW PERFORMANCE BY POLICY');
    lines.push(`  ${SEP2}`);
    lines.push('');
    for (const pol of result.policies) {
      for (const l of renderPolicySection(pol)) lines.push(l);
    }
  }

  // Full combo details — always shown
  const fullCombo = result.policies.find(p => p.policyId === FULL_COMBO_WINDOW_POLICY_ID);
  lines.push(`  ${SEP2}`);
  lines.push('  FULL COMBO EXIT WINDOW DETAILS');
  lines.push(`  ${SEP2}`);
  lines.push('');
  for (const l of renderFullComboDetails(fullCombo)) lines.push(l);

  lines.push(`  ${SEP2}`);
  lines.push('  DO NOT APPLY YET');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  * Exit window analysis only — no real or paper positions were opened.');
  lines.push('  * Do NOT enable real trading.');
  lines.push('  * Do NOT change paper approval logic.');
  lines.push('  * Do NOT change scoring weights or buy gates.');
  lines.push('  * Do NOT call auto-paper.');
  lines.push('  * PASS is NOT a buy signal — it is a research measurement with a small sample.');
  lines.push('');

  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperExitWindowReportUsage(): string {
  return `
token:ripper-exit-window-report — measure approved candidates at fixed exit windows

Usage:
  npm run token:ripper-exit-window-report -- \\
    --approvals  <cycle-jsonl...>      \\
    --observations <obs-jsonl...>

Options:
  --approvals    <paths>   cycle JSONL files containing BUY_APPROVED_PAPER fixtures
  --observations <paths>   observation JSONL files (post-approval snapshots)
  --help                   show this message

Exit windows measured (relative to approvedAt):
  +5m   ±2 min tolerance
  +10m  ±2 min tolerance
  +15m  ±2 min tolerance
  +30m  ±5 min tolerance
  +60m  ±5 min tolerance

Policies compared:
  ALL                                    — all approvals (baseline)
  price_gt_0_25                          — approvalPriceChangePct > 0.25
  price_gt_0_25_and_liq_30k_and_vol_20k — full combo (all three)

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap.
  No live API calls. Read-only artifact scan. No gate or scoring changes.
`.trim();
}
