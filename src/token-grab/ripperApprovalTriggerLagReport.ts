import * as fs from 'fs';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';
import {
  WATCH_EARLY_RIP_LIQ_MIN,
  WATCH_EARLY_RIP_VOL_MIN,
  WATCH_EARLY_RIP_PCT_MIN,
  WATCH_EARLY_RIP_PCT_MAX,
} from './ripperEarlyWatchPolicyReport';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TriggerLagLabel =
  | 'INSTANT_RIP'
  | 'FAST_RIP_5M'
  | 'SLOW_RIP_15M'
  | 'LATE_RIP'
  | 'NO_RIP_AFTER_APPROVAL'
  | 'NO_AFTER_DATA';

export type TriggerLagApprovalSource = 'obs' | 'file' | 'both';

export interface TriggerLagRow {
  contractKey:            string;
  contractKeyShort:       string;
  symbol?:                string;
  approvedAt:             string;
  approvalSource:         TriggerLagApprovalSource;
  approvalPriceChangePct: number | null;
  approvalLiquidityUsd:   number | null;
  approvalVolumeUsd:      number | null;
  best1mPct:              number | null;
  best5mPct:              number | null;
  best15mPct:             number | null;
  bestAfterPct:           number | null;
  minAfterPct:            number | null;
  move1m:                 number | null;
  move5m:                 number | null;
  move15m:                number | null;
  maxDrawdown:            number | null;
  label:                  TriggerLagLabel;
}

export interface TriggerLagSummary {
  totalApproved:          number;
  instantRipCount:        number;
  fastRip5mCount:         number;
  slowRip15mCount:        number;
  lateRipCount:           number;
  noRipCount:             number;
  noAfterDataCount:       number;
  avgMove1m:              number | null;
  medianMove1m:           number | null;
  avgMove5m:              number | null;
  medianMove5m:           number | null;
  avgMove15m:             number | null;
  medianMove15m:          number | null;
  avgDrawdown:            number | null;
  maxDrawdown:            number | null;
  cadenceRecommendation:  string;
}

export interface RipperApprovalTriggerLagOptions {
  observationPaths: string[];
  approvalPaths:    string[];
}

export interface RipperApprovalTriggerLagResult {
  generatedAt:       string;
  rows:              TriggerLagRow[];
  summary:           TriggerLagSummary;
  reportOnly:        true;
  readOnly:          true;
  tradingExecuted:   0;
  realTradingLocked: true;
  paperOnly:         true;
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

function shortKey(k: string): string {
  return k.length > 14 ? `${k.slice(0, 14)}…` : k;
}

interface ObsRecord {
  capturedAtMs:   number;
  priceChangePct: number | null;
  liquidityUsd:   number | null;
  volumeUsd:      number | null;
}

function maxPct(obs: ObsRecord[]): number | null {
  let best: number | null = null;
  for (const o of obs) {
    if (o.priceChangePct != null && (best == null || o.priceChangePct > best)) best = o.priceChangePct;
  }
  return best;
}

function minPct(obs: ObsRecord[]): number | null {
  let worst: number | null = null;
  for (const o of obs) {
    if (o.priceChangePct != null && (worst == null || o.priceChangePct < worst)) worst = o.priceChangePct;
  }
  return worst;
}

function closestObs(allObs: ObsRecord[], targetMs: number): ObsRecord | null {
  if (allObs.length === 0) return null;
  let best = allObs[0];
  let bestDiff = Math.abs(allObs[0].capturedAtMs - targetMs);
  for (let i = 1; i < allObs.length; i++) {
    const diff = Math.abs(allObs[i].capturedAtMs - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = allObs[i]; }
  }
  return best;
}

function calcAvg(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function calcMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperApprovalTriggerLagReport(
  options: RipperApprovalTriggerLagOptions,
): RipperApprovalTriggerLagResult {
  const generatedAt = new Date().toISOString();

  // ── Load all observations ──────────────────────────────────────────────────
  const allObsMap       = new Map<string, ObsRecord[]>();
  const symbolMap       = new Map<string, string>();
  const obsApprovalsMap = new Map<string, number[]>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      const contractKey  = signalKey(f.normalizedSignal);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;

      const sig = f.normalizedSignal as unknown as Record<string, unknown>;
      const pct = toFiniteNum(sig['priceChangePct']);
      const liq = toFiniteNum(sig['liquidityUsd']);
      const vol = toFiniteNum(sig['volumeUsd']);
      const sym = f.normalizedSignal.symbol;

      if (sym && !symbolMap.has(contractKey)) symbolMap.set(contractKey, sym);

      const rec: ObsRecord = { capturedAtMs, priceChangePct: pct, liquidityUsd: liq, volumeUsd: vol };
      const list = allObsMap.get(contractKey);
      if (list) list.push(rec);
      else allObsMap.set(contractKey, [rec]);

      if (f.buyGateDecision === 'BUY_APPROVED_PAPER') {
        const list2 = obsApprovalsMap.get(contractKey);
        if (list2) list2.push(capturedAtMs);
        else obsApprovalsMap.set(contractKey, [capturedAtMs]);
      }
    }
  }

  for (const list of allObsMap.values()) {
    list.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  }

  // ── Load file approvals ────────────────────────────────────────────────────
  const instanceKeySet   = new Set<string>();
  const fileApprovalsMap = new Map<string, number[]>();

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      const contractKey  = signalKey(f.normalizedSignal);
      const instanceKey  = `${contractKey}::${f.capturedAt}`;
      if (instanceKeySet.has(instanceKey)) continue;
      instanceKeySet.add(instanceKey);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;
      const list = fileApprovalsMap.get(contractKey);
      if (list) list.push(capturedAtMs);
      else fileApprovalsMap.set(contractKey, [capturedAtMs]);
      const sym = f.normalizedSignal.symbol;
      if (sym && !symbolMap.has(contractKey)) symbolMap.set(contractKey, sym);
    }
  }

  // ── Build rows for all approved contracts ──────────────────────────────────
  const allApprovedKeys = new Set([...obsApprovalsMap.keys(), ...fileApprovalsMap.keys()]);
  const rows: TriggerLagRow[] = [];

  for (const contractKey of allApprovedKeys) {
    const obsApprTimes  = obsApprovalsMap.get(contractKey)  ?? [];
    const fileApprTimes = fileApprovalsMap.get(contractKey) ?? [];
    const obsApproved   = obsApprTimes.length  > 0;
    const fileApproved  = fileApprTimes.length > 0;

    const earliestObs  = obsApproved  ? Math.min(...obsApprTimes)  : Infinity;
    const earliestFile = fileApproved ? Math.min(...fileApprTimes) : Infinity;
    const approvedAtMs = Math.min(earliestObs, earliestFile);
    const approvedAt   = new Date(approvedAtMs).toISOString();
    const approvalSource: TriggerLagApprovalSource =
      obsApproved && fileApproved ? 'both' : obsApproved ? 'obs' : 'file';

    const allObs   = allObsMap.get(contractKey) ?? [];
    const apprObs  = closestObs(allObs, approvedAtMs);
    const afterObs = allObs.filter(o => o.capturedAtMs > approvedAtMs);

    const apprPct = apprObs?.priceChangePct ?? null;
    const apprLiq = apprObs?.liquidityUsd   ?? null;
    const apprVol = apprObs?.volumeUsd      ?? null;

    const W1  = approvedAtMs + 60_000;
    const W5  = approvedAtMs + 300_000;
    const W15 = approvedAtMs + 900_000;

    const obs1m  = afterObs.filter(o => o.capturedAtMs <= W1);
    const obs5m  = afterObs.filter(o => o.capturedAtMs <= W5);
    const obs15m = afterObs.filter(o => o.capturedAtMs <= W15);

    const best1mPct   = maxPct(obs1m);
    const best5mPct   = maxPct(obs5m);
    const best15mPct  = maxPct(obs15m);
    const bestAfterPct = maxPct(afterObs);
    const minAfterPct  = minPct(afterObs);

    const move1m  = best1mPct   != null && apprPct != null ? best1mPct  - apprPct : null;
    const move5m  = best5mPct   != null && apprPct != null ? best5mPct  - apprPct : null;
    const move15m = best15mPct  != null && apprPct != null ? best15mPct - apprPct : null;
    const overallMove = bestAfterPct != null && apprPct != null ? bestAfterPct - apprPct : null;
    const maxDrawdown = apprPct != null && minAfterPct != null ? apprPct - minAfterPct : null;

    let label: TriggerLagLabel;
    if (afterObs.length === 0) {
      label = 'NO_AFTER_DATA';
    } else if (move1m != null && move1m >= 1.0) {
      label = 'INSTANT_RIP';
    } else if (move5m != null && move5m >= 1.0) {
      label = 'FAST_RIP_5M';
    } else if (move15m != null && move15m >= 1.0) {
      label = 'SLOW_RIP_15M';
    } else if (overallMove != null && overallMove >= 1.0) {
      label = 'LATE_RIP';
    } else {
      label = 'NO_RIP_AFTER_APPROVAL';
    }

    rows.push({
      contractKey,
      contractKeyShort:       shortKey(contractKey),
      symbol:                 symbolMap.get(contractKey),
      approvedAt,
      approvalSource,
      approvalPriceChangePct: apprPct,
      approvalLiquidityUsd:   apprLiq,
      approvalVolumeUsd:      apprVol,
      best1mPct,
      best5mPct,
      best15mPct,
      bestAfterPct,
      minAfterPct,
      move1m,
      move5m,
      move15m,
      maxDrawdown,
      label,
    });
  }

  rows.sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));

  // ── Summary ────────────────────────────────────────────────────────────────
  const instantRipCount  = rows.filter(r => r.label === 'INSTANT_RIP').length;
  const fastRip5mCount   = rows.filter(r => r.label === 'FAST_RIP_5M').length;
  const slowRip15mCount  = rows.filter(r => r.label === 'SLOW_RIP_15M').length;
  const lateRipCount     = rows.filter(r => r.label === 'LATE_RIP').length;
  const noRipCount       = rows.filter(r => r.label === 'NO_RIP_AFTER_APPROVAL').length;
  const noAfterDataCount = rows.filter(r => r.label === 'NO_AFTER_DATA').length;

  const move1mVals   = rows.filter(r => r.move1m  != null).map(r => r.move1m  as number);
  const move5mVals   = rows.filter(r => r.move5m  != null).map(r => r.move5m  as number);
  const move15mVals  = rows.filter(r => r.move15m != null).map(r => r.move15m as number);
  const drawdownVals = rows.filter(r => r.maxDrawdown != null).map(r => r.maxDrawdown as number);

  const total = rows.length;
  let cadenceRecommendation: string;
  if (total === 0) {
    cadenceRecommendation = 'No approved contracts — insufficient data';
  } else {
    const instantFrac = instantRipCount / total;
    const fast5mFrac  = (instantRipCount + fastRip5mCount) / total;
    if (instantFrac >= 0.3) {
      cadenceRecommendation = 'Sub-minute automation required — many INSTANT_RIP approvals';
    } else if (fast5mFrac >= 0.5) {
      cadenceRecommendation = '1-minute loop may work — most rips happen within 5m of approval';
    } else {
      cadenceRecommendation = 'Alert / refresh lane may be enough — rips are mostly slow or absent after approval';
    }
  }

  return {
    generatedAt,
    rows,
    summary: {
      totalApproved:    total,
      instantRipCount,
      fastRip5mCount,
      slowRip15mCount,
      lateRipCount,
      noRipCount,
      noAfterDataCount,
      avgMove1m:    calcAvg(move1mVals),
      medianMove1m: calcMedian(move1mVals),
      avgMove5m:    calcAvg(move5mVals),
      medianMove5m: calcMedian(move5mVals),
      avgMove15m:   calcAvg(move15mVals),
      medianMove15m: calcMedian(move15mVals),
      avgDrawdown:  calcAvg(drawdownVals),
      maxDrawdown:  drawdownVals.length > 0 ? Math.max(...drawdownVals) : null,
      cadenceRecommendation,
    },
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

export function renderRipperApprovalTriggerLagReport(
  result: RipperApprovalTriggerLagResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER APPROVAL TRIGGER LAG REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO APPROVAL CHANGES — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated        : ${result.generatedAt}`);
  lines.push(`  Approved contracts: ${result.summary.totalApproved}`);
  lines.push('');

  // ── Row table ──────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  APPROVED CONTRACT ROWS');
  lines.push(`  ${SEP2}`);
  lines.push('');

  if (result.rows.length === 0) {
    lines.push('  (no approved contracts found)');
    lines.push('');
  } else {
    const hdr = [
      'sym/addr'.padEnd(16),
      'approvedAt'.padEnd(19),
      'src'.padStart(5),
      'apprPct'.padStart(8),
      'apprLiq'.padStart(8),
      'move1m'.padStart(7),
      'move5m'.padStart(7),
      'move15m'.padStart(8),
      'bestAfter'.padStart(10),
      'drawdown'.padStart(9),
      'label',
    ].join('  ');
    lines.push(`  ${hdr}`);
    lines.push(`  ${'─'.repeat(hdr.length)}`);

    for (const r of result.rows) {
      const lbl    = r.symbol ? `$${r.symbol}` : r.contractKeyShort;
      const apprTs = r.approvedAt.slice(0, 19).replace('T', ' ');
      const overallMove = r.bestAfterPct != null && r.approvalPriceChangePct != null
        ? r.bestAfterPct - r.approvalPriceChangePct
        : null;
      const row = [
        lbl.padEnd(16),
        apprTs.padEnd(19),
        r.approvalSource.padStart(5),
        fmtPct(r.approvalPriceChangePct).padStart(8),
        fmtUsd(r.approvalLiquidityUsd).padStart(8),
        fmtPct(r.move1m).padStart(7),
        fmtPct(r.move5m).padStart(7),
        fmtPct(r.move15m).padStart(8),
        fmtPct(overallMove).padStart(10),
        fmtPct(r.maxDrawdown).padStart(9),
        r.label,
      ].join('  ');
      lines.push(`  ${row}`);
    }
    lines.push('');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const s = result.summary;
  lines.push(`  ${SEP2}`);
  lines.push('  SUMMARY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push(`  Total approved        : ${s.totalApproved}`);
  lines.push(`  INSTANT_RIP (<=1m)    : ${s.instantRipCount}`);
  lines.push(`  FAST_RIP_5M (1-5m)    : ${s.fastRip5mCount}`);
  lines.push(`  SLOW_RIP_15M (5-15m)  : ${s.slowRip15mCount}`);
  lines.push(`  LATE_RIP (>15m)       : ${s.lateRipCount}`);
  lines.push(`  NO_RIP_AFTER_APPROVAL : ${s.noRipCount}`);
  lines.push(`  NO_AFTER_DATA         : ${s.noAfterDataCount}`);
  lines.push('');
  lines.push(`  Avg move   1m  : ${fmtPct(s.avgMove1m)}   (median: ${fmtPct(s.medianMove1m)})`);
  lines.push(`  Avg move   5m  : ${fmtPct(s.avgMove5m)}   (median: ${fmtPct(s.medianMove5m)})`);
  lines.push(`  Avg move  15m  : ${fmtPct(s.avgMove15m)}   (median: ${fmtPct(s.medianMove15m)})`);
  lines.push(`  Avg drawdown   : ${fmtPct(s.avgDrawdown)}   (max: ${fmtPct(s.maxDrawdown)})`);
  lines.push('');
  lines.push(`  Cadence: ${s.cadenceRecommendation}`);
  lines.push('');

  // ── Label key ──────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  LABEL KEY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  INSTANT_RIP           move1m >= 1.0% (within 1m of approval)');
  lines.push('  FAST_RIP_5M           move5m >= 1.0% (within 5m, not 1m)');
  lines.push('  SLOW_RIP_15M          move15m >= 1.0% (within 15m, not 5m)');
  lines.push('  LATE_RIP              overall move >= 1.0% but not within 15m');
  lines.push('  NO_RIP_AFTER_APPROVAL overall move < 1.0% despite having after-data');
  lines.push('  NO_AFTER_DATA         no observations recorded after approval');
  lines.push('');

  // ── Safety ─────────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  * Report-only — no real or paper positions opened.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CALL AUTO-PAPER');
  lines.push('');
  lines.push(`  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true`);
  lines.push(SEP);
  lines.push('');

  return lines.join('\n');
}

// Re-export policy constants so callers can reference them without importing the policy module.
export { WATCH_EARLY_RIP_LIQ_MIN, WATCH_EARLY_RIP_VOL_MIN, WATCH_EARLY_RIP_PCT_MIN, WATCH_EARLY_RIP_PCT_MAX };
