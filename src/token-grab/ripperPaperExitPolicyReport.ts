import * as fs from 'fs';
import * as path from 'path';
import type { PaperIntent } from './ripperPaperDecisionPolicy';
import { readPaperIntents } from './ripperPaperIntentLedger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExitPolicyName =
  | 'TAKE_1PCT_STOP_3PCT'
  | 'TAKE_3PCT_STOP_3PCT'
  | 'TAKE_5PCT_STOP_5PCT'
  | 'TIME_EXIT_10M'
  | 'TIME_EXIT_30M'
  | 'TRAILING_AFTER_3PCT';

export interface ExitPolicyStats {
  policy:              ExitPolicyName;
  candidatesAnalyzed:  number;
  candidatesWithData:  number;
  coveragePct:         number;
  avgSimulatedPL:      number | null;
  medianSimulatedPL:   number | null;
  winRate:             number | null;
  dumpRate:            number | null;
  worstDrawdown:       number | null;
  supported:           boolean;
  unsupportedReason?:  string;
}

export interface RipperPaperExitPolicyReportResult {
  generatedAt:           string;
  candidatesAnalyzed:    number;
  observedCandidates:    number;
  policyStats:           ExitPolicyStats[];
  bestByAvgPL:           ExitPolicyName | null;
  bestByMedianPL:        ExitPolicyName | null;
  bestByDrawdownProtect: ExitPolicyName | null;
  outPath:               string;
  rowsWritten:           number;
  reportOnly:            true;
  readOnly:              true;
  tradingExecuted:       0;
  realTradingLocked:     true;
  paperOnly:             true;
}

export interface RipperPaperExitPolicyReportOptions {
  intentsPath:      string;
  observationPaths: string[];
  outPath:          string;
  nowMs?:           number;
}

// ── Internal ──────────────────────────────────────────────────────────────────

interface ObsEntry {
  contract:       string;
  capturedAt:     string;
  priceChangePct: number | null;
}

function readObservations(paths: string[]): Map<string, ObsEntry[]> {
  const byContract = new Map<string, ObsEntry[]>();
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f   = JSON.parse(line) as Record<string, unknown>;
        const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
        const raw = f['raw']             as Record<string, unknown> | undefined;
        const contract   = (ns?.['contract'] ?? raw?.['contract']) as string | undefined;
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;
        let pct: number | null = null;
        if (typeof ns?.['priceChangePct'] === 'number')       pct = ns['priceChangePct']  as number;
        else if (typeof raw?.['priceChangePct'] === 'number') pct = raw['priceChangePct'] as number;
        const list = byContract.get(contract) ?? [];
        list.push({ contract, capturedAt, priceChangePct: pct });
        byContract.set(contract, list);
      } catch { /* skip */ }
    }
  }
  for (const list of byContract.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  return byContract;
}

// ── Simulation helpers ────────────────────────────────────────────────────────

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function simulatePL(
  price: number,
  policy: ExitPolicyName,
): number {
  switch (policy) {
    case 'TAKE_1PCT_STOP_3PCT':
      if (price >=  1) return  1;
      if (price <= -3) return -3;
      return price;
    case 'TAKE_3PCT_STOP_3PCT':
      if (price >=  3) return  3;
      if (price <= -3) return -3;
      return price;
    case 'TAKE_5PCT_STOP_5PCT':
      if (price >=  5) return  5;
      if (price <= -5) return -5;
      return price;
    case 'TIME_EXIT_10M':
    case 'TIME_EXIT_30M':
      return price;
    case 'TRAILING_AFTER_3PCT':
      return price; // simplified: use final price
  }
}

function computePolicyStats(
  policy: ExitPolicyName,
  intents: PaperIntent[],
  byContract: Map<string, ObsEntry[]>,
): ExitPolicyStats {
  const observedIntents = intents.filter(i => i.status === 'OBSERVED');
  const candidatesAnalyzed = intents.length;
  const simulated: number[] = [];
  let worstDrawdown: number | null = null;

  for (const intent of observedIntents) {
    const obs = byContract.get(intent.contract) ?? [];
    const entry = obs.find(o => o.capturedAt >= intent.targetEntryAt);
    if (!entry || entry.priceChangePct == null) continue;
    const pl = simulatePL(entry.priceChangePct, policy);
    simulated.push(pl);
    if (worstDrawdown == null || pl < worstDrawdown) worstDrawdown = pl;
  }

  const candidatesWithData = simulated.length;
  const coveragePct = candidatesAnalyzed > 0
    ? Math.round((candidatesWithData / candidatesAnalyzed) * 100)
    : 0;

  if (candidatesWithData === 0) {
    return {
      policy, candidatesAnalyzed, candidatesWithData, coveragePct,
      avgSimulatedPL: null, medianSimulatedPL: null,
      winRate: null, dumpRate: null, worstDrawdown: null,
      supported: policy !== 'TRAILING_AFTER_3PCT',
      unsupportedReason: policy === 'TRAILING_AFTER_3PCT' ? 'requires multi-observation sequences' : undefined,
    };
  }

  const avg    = simulated.reduce((s, n) => s + n, 0) / simulated.length;
  const med    = median(simulated)!;
  const winRate   = (simulated.filter(p => p > 0).length / simulated.length) * 100;
  const dumpRate  = (simulated.filter(p => p <= -3).length / simulated.length) * 100;

  return {
    policy,
    candidatesAnalyzed,
    candidatesWithData,
    coveragePct,
    avgSimulatedPL:    Math.round(avg * 100) / 100,
    medianSimulatedPL: Math.round(med * 100) / 100,
    winRate:           Math.round(winRate * 10) / 10,
    dumpRate:          Math.round(dumpRate * 10) / 10,
    worstDrawdown:     worstDrawdown != null ? Math.round(worstDrawdown * 100) / 100 : null,
    supported:         policy !== 'TRAILING_AFTER_3PCT',
    unsupportedReason: policy === 'TRAILING_AFTER_3PCT' ? 'requires multi-observation sequences' : undefined,
  };
}

const ALL_POLICIES: ExitPolicyName[] = [
  'TAKE_1PCT_STOP_3PCT',
  'TAKE_3PCT_STOP_3PCT',
  'TAKE_5PCT_STOP_5PCT',
  'TIME_EXIT_10M',
  'TIME_EXIT_30M',
  'TRAILING_AFTER_3PCT',
];

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperPaperExitPolicyReport(
  options: RipperPaperExitPolicyReportOptions,
): RipperPaperExitPolicyReportResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const intents     = readPaperIntents(options.intentsPath);
  const byContract  = readObservations(options.observationPaths);

  const policyStats = ALL_POLICIES.map(p =>
    computePolicyStats(p, intents, byContract),
  );

  const observedCandidates = intents.filter(i => i.status === 'OBSERVED').length;

  const supportedWithData = policyStats.filter(s => s.supported && s.candidatesWithData > 0);

  let bestByAvgPL:           ExitPolicyName | null = null;
  let bestByMedianPL:        ExitPolicyName | null = null;
  let bestByDrawdownProtect: ExitPolicyName | null = null;

  if (supportedWithData.length > 0) {
    bestByAvgPL = supportedWithData.reduce((best, s) =>
      (s.avgSimulatedPL as number) > (best.avgSimulatedPL as number) ? s : best,
    ).policy;
    bestByMedianPL = supportedWithData.reduce((best, s) =>
      (s.medianSimulatedPL as number) > (best.medianSimulatedPL as number) ? s : best,
    ).policy;
    // Best drawdown protection = least negative worst drawdown
    bestByDrawdownProtect = supportedWithData
      .filter(s => s.worstDrawdown != null)
      .reduce((best: ExitPolicyStats | null, s) => {
        if (best == null) return s;
        return (s.worstDrawdown as number) > (best.worstDrawdown as number) ? s : best;
      }, null)?.policy ?? null;
  }

  // Write output JSONL
  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  const rows = policyStats.map(s => ({ ...s, generatedAt }));
  const content = rows.length > 0
    ? rows.map(r => JSON.stringify(r)).join('\n') + '\n'
    : '';
  fs.writeFileSync(options.outPath, content, 'utf-8');

  return {
    generatedAt,
    candidatesAnalyzed:    intents.length,
    observedCandidates,
    policyStats,
    bestByAvgPL,
    bestByMedianPL,
    bestByDrawdownProtect,
    outPath:               options.outPath,
    rowsWritten:           rows.length,
    reportOnly:            true,
    readOnly:              true,
    tradingExecuted:       0,
    realTradingLocked:     true,
    paperOnly:             true,
  };
}

// ── Renderer helpers ──────────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  if (v == null) return 'n/a'.padEnd(7);
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`.padEnd(7);
}

function fmtRate(v: number | null): string {
  if (v == null) return 'n/a';
  return `${v.toFixed(0)}%`;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderRipperPaperExitPolicyReport(
  result: RipperPaperExitPolicyReportResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER PAPER EXIT POLICY REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push(SEP, '');

  lines.push(`  Candidates analyzed   : ${result.candidatesAnalyzed}`);
  lines.push(`  Observed candidates   : ${result.observedCandidates}`);
  lines.push(`  Generated at          : ${result.generatedAt}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  EXIT POLICY COMPARISON');
  lines.push(`  ${SEP2}`, '');
  lines.push('  Policy                   n     Cov  AvgP/L  MedP/L  WinRate  DumpRate  WorstDD');
  lines.push(`  ${SEP2}`);

  for (const s of result.policyStats) {
    if (!s.supported) {
      lines.push(`  ${s.policy.padEnd(24)} UNSUPPORTED: ${s.unsupportedReason ?? ''}`);
      continue;
    }
    const n    = String(s.candidatesWithData).padEnd(5);
    const cov  = `${s.coveragePct}%`.padEnd(4);
    const avg  = fmtPct(s.avgSimulatedPL);
    const med  = fmtPct(s.medianSimulatedPL);
    const wr   = fmtRate(s.winRate).padEnd(8);
    const dr   = fmtRate(s.dumpRate).padEnd(9);
    const dd   = fmtPct(s.worstDrawdown);
    lines.push(`  ${s.policy.padEnd(24)} ${n} ${cov} ${avg} ${med} ${wr} ${dr} ${dd}`);
  }
  lines.push('');

  if (result.bestByAvgPL || result.bestByMedianPL || result.bestByDrawdownProtect) {
    lines.push(`  ${SEP2}`);
    lines.push('  BEST EXIT POLICY');
    lines.push(`  ${SEP2}`, '');
    if (result.bestByAvgPL)           lines.push(`  Best by avg P/L           : ${result.bestByAvgPL}`);
    if (result.bestByMedianPL)        lines.push(`  Best by median P/L        : ${result.bestByMedianPL}`);
    if (result.bestByDrawdownProtect) lines.push(`  Best drawdown protection  : ${result.bestByDrawdownProtect}`);
    lines.push('');
  }

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * Report only — no trades, no paper positions, no gate changes.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CHANGE APPROVAL GATES');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(SEP, '');
  return lines.join('\n');
}
