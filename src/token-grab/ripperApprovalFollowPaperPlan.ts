import * as fs from 'fs';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BestEntryDelay =
  | 'ENTER_NOW'
  | 'WAIT_1M'
  | 'WAIT_3M'
  | 'WAIT_5M'
  | 'WAIT_15M'
  | 'SKIP_NO_EDGE'
  | 'NO_AFTER_DATA';

export type EntryPlanApprovalSource = 'obs' | 'file' | 'both';

export interface EntryPlanRow {
  contractKey:            string;
  contractKeyShort:       string;
  symbol?:                string;
  approvedAt:             string;
  approvalSource:         EntryPlanApprovalSource;
  approvalPriceChangePct: number | null;
  approvalLiquidityUsd:   number | null;
  approvalVolumeUsd:      number | null;
  entryNowPct:            number | null;
  entry1mPct:             number | null;
  entry3mPct:             number | null;
  entry5mPct:             number | null;
  entry15mPct:            number | null;
  bestAfterPct:           number | null;
  maxDrawdownAfterPct:    number | null;
  upsideNow:              number | null;
  upside1m:               number | null;
  upside3m:               number | null;
  upside5m:               number | null;
  upside15m:              number | null;
  bestEntryDelay:         BestEntryDelay;
}

export interface EntryPlanSummary {
  totalApproved:    number;
  enterNowCount:    number;
  wait1mCount:      number;
  wait3mCount:      number;
  wait5mCount:      number;
  wait15mCount:     number;
  skipNoEdgeCount:  number;
  noAfterDataCount: number;
  avgUpsideNow:     number | null;
  medianUpsideNow:  number | null;
  avgUpside1m:      number | null;
  medianUpside1m:   number | null;
  avgUpside3m:      number | null;
  medianUpside3m:   number | null;
  avgUpside5m:      number | null;
  medianUpside5m:   number | null;
  avgUpside15m:     number | null;
  medianUpside15m:  number | null;
  recommendation:   string;
}

export interface RipperApprovalFollowPaperPlanOptions {
  observationPaths: string[];
  approvalPaths:    string[];
}

export interface RipperApprovalFollowPaperPlanResult {
  generatedAt:       string;
  rows:              EntryPlanRow[];
  summary:           EntryPlanSummary;
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

function closestObs(sortedObs: ObsRecord[], targetMs: number): ObsRecord | null {
  if (sortedObs.length === 0) return null;
  let best = sortedObs[0];
  let bestDiff = Math.abs(sortedObs[0].capturedAtMs - targetMs);
  for (let i = 1; i < sortedObs.length; i++) {
    const diff = Math.abs(sortedObs[i].capturedAtMs - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = sortedObs[i]; }
  }
  return best;
}

function firstObsAtOrAfter(sortedObs: ObsRecord[], targetMs: number): ObsRecord | null {
  for (const o of sortedObs) {
    if (o.capturedAtMs >= targetMs) return o;
  }
  return null;
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

function recommendation(summary: Pick<EntryPlanSummary,
  'totalApproved' | 'enterNowCount' | 'wait1mCount' | 'wait3mCount' |
  'wait5mCount'   | 'skipNoEdgeCount' | 'noAfterDataCount'>
): string {
  const total = summary.totalApproved;
  if (total === 0) return 'No approved contracts — insufficient data';
  const enterNowFrac = summary.enterNowCount / total;
  const delayFrac    = (summary.wait1mCount + summary.wait3mCount + summary.wait5mCount) / total;
  const skipFrac     = (summary.skipNoEdgeCount + summary.noAfterDataCount) / total;
  if (enterNowFrac > 0.5) return 'Immediate paper entry is favored — most approvals should be acted on right away';
  if (delayFrac    > 0.5) return 'Delayed confirm entry is favored — wait 1-5m after approval before entering';
  if (skipFrac     > 0.5) return 'Approval alone is not a reliable entry signal — need stronger confirmation';
  return 'Mixed signal — review individual rows to determine optimal entry timing';
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperApprovalFollowPaperPlan(
  options: RipperApprovalFollowPaperPlanOptions,
): RipperApprovalFollowPaperPlanResult {
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

  // ── Build rows ─────────────────────────────────────────────────────────────
  const allApprovedKeys = new Set([...obsApprovalsMap.keys(), ...fileApprovalsMap.keys()]);
  const rows: EntryPlanRow[] = [];

  for (const contractKey of allApprovedKeys) {
    const obsApprTimes  = obsApprovalsMap.get(contractKey)  ?? [];
    const fileApprTimes = fileApprovalsMap.get(contractKey) ?? [];
    const obsApproved   = obsApprTimes.length  > 0;
    const fileApproved  = fileApprTimes.length > 0;

    const earliestObs  = obsApproved  ? Math.min(...obsApprTimes)  : Infinity;
    const earliestFile = fileApproved ? Math.min(...fileApprTimes) : Infinity;
    const approvedAtMs = Math.min(earliestObs, earliestFile);
    const approvedAt   = new Date(approvedAtMs).toISOString();
    const approvalSource: EntryPlanApprovalSource =
      obsApproved && fileApproved ? 'both' : obsApproved ? 'obs' : 'file';

    const allObs   = allObsMap.get(contractKey) ?? [];
    const afterObs = allObs.filter(o => o.capturedAtMs > approvedAtMs);

    // Entry price candidates
    const apprObs     = closestObs(allObs, approvedAtMs);
    const entry1mObs  = firstObsAtOrAfter(allObs, approvedAtMs + 60_000);
    const entry3mObs  = firstObsAtOrAfter(allObs, approvedAtMs + 180_000);
    const entry5mObs  = firstObsAtOrAfter(allObs, approvedAtMs + 300_000);
    const entry15mObs = firstObsAtOrAfter(allObs, approvedAtMs + 900_000);

    const entryNowPct  = apprObs?.priceChangePct     ?? null;
    const entry1mPct   = entry1mObs?.priceChangePct  ?? null;
    const entry3mPct   = entry3mObs?.priceChangePct  ?? null;
    const entry5mPct   = entry5mObs?.priceChangePct  ?? null;
    const entry15mPct  = entry15mObs?.priceChangePct ?? null;

    const bestAfterPct       = maxPct(afterObs);
    const minAfterPct        = minPct(afterObs);
    const maxDrawdownAfterPct = apprObs?.priceChangePct != null && minAfterPct != null
      ? apprObs.priceChangePct - minAfterPct
      : null;

    const upsideNow = bestAfterPct != null && entryNowPct  != null ? bestAfterPct - entryNowPct  : null;
    const upside1m  = bestAfterPct != null && entry1mPct   != null ? bestAfterPct - entry1mPct   : null;
    const upside3m  = bestAfterPct != null && entry3mPct   != null ? bestAfterPct - entry3mPct   : null;
    const upside5m  = bestAfterPct != null && entry5mPct   != null ? bestAfterPct - entry5mPct   : null;
    const upside15m = bestAfterPct != null && entry15mPct  != null ? bestAfterPct - entry15mPct  : null;

    // Best entry delay: lowest entry pct among those with upside >= 1.0
    const candidates = [
      { label: 'ENTER_NOW' as BestEntryDelay, pct: entryNowPct,  upside: upsideNow  },
      { label: 'WAIT_1M'   as BestEntryDelay, pct: entry1mPct,   upside: upside1m   },
      { label: 'WAIT_3M'   as BestEntryDelay, pct: entry3mPct,   upside: upside3m   },
      { label: 'WAIT_5M'   as BestEntryDelay, pct: entry5mPct,   upside: upside5m   },
      { label: 'WAIT_15M'  as BestEntryDelay, pct: entry15mPct,  upside: upside15m  },
    ];

    let bestEntryDelay: BestEntryDelay;
    if (afterObs.length === 0) {
      bestEntryDelay = 'NO_AFTER_DATA';
    } else {
      const qualifying = candidates.filter(c => c.pct != null && c.upside != null && c.upside >= 1.0);
      if (qualifying.length === 0) {
        bestEntryDelay = 'SKIP_NO_EDGE';
      } else {
        const best = qualifying.reduce((a, b) => {
          if (a.pct! < b.pct!) return a;
          if (b.pct! < a.pct!) return b;
          return a; // tie: keep earlier (list already ordered now→15m)
        });
        bestEntryDelay = best.label;
      }
    }

    rows.push({
      contractKey,
      contractKeyShort:       shortKey(contractKey),
      symbol:                 symbolMap.get(contractKey),
      approvedAt,
      approvalSource,
      approvalPriceChangePct: apprObs?.priceChangePct ?? null,
      approvalLiquidityUsd:   apprObs?.liquidityUsd   ?? null,
      approvalVolumeUsd:      apprObs?.volumeUsd      ?? null,
      entryNowPct,
      entry1mPct,
      entry3mPct,
      entry5mPct,
      entry15mPct,
      bestAfterPct,
      maxDrawdownAfterPct,
      upsideNow,
      upside1m,
      upside3m,
      upside5m,
      upside15m,
      bestEntryDelay,
    });
  }

  rows.sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));

  // ── Summary ────────────────────────────────────────────────────────────────
  const enterNowCount    = rows.filter(r => r.bestEntryDelay === 'ENTER_NOW').length;
  const wait1mCount      = rows.filter(r => r.bestEntryDelay === 'WAIT_1M').length;
  const wait3mCount      = rows.filter(r => r.bestEntryDelay === 'WAIT_3M').length;
  const wait5mCount      = rows.filter(r => r.bestEntryDelay === 'WAIT_5M').length;
  const wait15mCount     = rows.filter(r => r.bestEntryDelay === 'WAIT_15M').length;
  const skipNoEdgeCount  = rows.filter(r => r.bestEntryDelay === 'SKIP_NO_EDGE').length;
  const noAfterDataCount = rows.filter(r => r.bestEntryDelay === 'NO_AFTER_DATA').length;

  const nonNullUpsidesNow  = rows.filter(r => r.upsideNow  != null).map(r => r.upsideNow  as number);
  const nonNullUpsides1m   = rows.filter(r => r.upside1m   != null).map(r => r.upside1m   as number);
  const nonNullUpsides3m   = rows.filter(r => r.upside3m   != null).map(r => r.upside3m   as number);
  const nonNullUpsides5m   = rows.filter(r => r.upside5m   != null).map(r => r.upside5m   as number);
  const nonNullUpsides15m  = rows.filter(r => r.upside15m  != null).map(r => r.upside15m  as number);

  const sumBase = {
    totalApproved: rows.length,
    enterNowCount,
    wait1mCount,
    wait3mCount,
    wait5mCount,
    skipNoEdgeCount,
    noAfterDataCount,
  };

  return {
    generatedAt,
    rows,
    summary: {
      ...sumBase,
      wait15mCount,
      avgUpsideNow:    calcAvg(nonNullUpsidesNow),
      medianUpsideNow: calcMedian(nonNullUpsidesNow),
      avgUpside1m:     calcAvg(nonNullUpsides1m),
      medianUpside1m:  calcMedian(nonNullUpsides1m),
      avgUpside3m:     calcAvg(nonNullUpsides3m),
      medianUpside3m:  calcMedian(nonNullUpsides3m),
      avgUpside5m:     calcAvg(nonNullUpsides5m),
      medianUpside5m:  calcMedian(nonNullUpsides5m),
      avgUpside15m:    calcAvg(nonNullUpsides15m),
      medianUpside15m: calcMedian(nonNullUpsides15m),
      recommendation:  recommendation(sumBase),
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

export function renderRipperApprovalFollowPaperPlan(
  result: RipperApprovalFollowPaperPlanResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER APPROVAL FOLLOW PAPER PLAN');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated          : ${result.generatedAt}`);
  lines.push(`  Approved contracts : ${result.summary.totalApproved}`);
  lines.push('');

  // ── Row table ──────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  ENTRY PLAN ROWS');
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
      'apprLiq'.padStart(8),
      'now'.padStart(7),
      '1m'.padStart(7),
      '3m'.padStart(7),
      '5m'.padStart(7),
      '15m'.padStart(7),
      'bestAfter'.padStart(10),
      'upNow'.padStart(7),
      'up1m'.padStart(6),
      'bestDelay',
    ].join('  ');
    lines.push(`  ${hdr}`);
    lines.push(`  ${'─'.repeat(hdr.length)}`);

    for (const r of result.rows) {
      const lbl    = r.symbol ? `$${r.symbol}` : r.contractKeyShort;
      const apprTs = r.approvedAt.slice(0, 19).replace('T', ' ');
      const row = [
        lbl.padEnd(16),
        apprTs.padEnd(19),
        r.approvalSource.padStart(5),
        fmtUsd(r.approvalLiquidityUsd).padStart(8),
        fmtPct(r.entryNowPct).padStart(7),
        fmtPct(r.entry1mPct).padStart(7),
        fmtPct(r.entry3mPct).padStart(7),
        fmtPct(r.entry5mPct).padStart(7),
        fmtPct(r.entry15mPct).padStart(7),
        fmtPct(r.bestAfterPct).padStart(10),
        fmtPct(r.upsideNow).padStart(7),
        fmtPct(r.upside1m).padStart(6),
        r.bestEntryDelay,
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
  lines.push(`  Total approved       : ${s.totalApproved}`);
  lines.push(`  ENTER_NOW            : ${s.enterNowCount}`);
  lines.push(`  WAIT_1M              : ${s.wait1mCount}`);
  lines.push(`  WAIT_3M              : ${s.wait3mCount}`);
  lines.push(`  WAIT_5M              : ${s.wait5mCount}`);
  lines.push(`  WAIT_15M             : ${s.wait15mCount}`);
  lines.push(`  SKIP_NO_EDGE         : ${s.skipNoEdgeCount}`);
  lines.push(`  NO_AFTER_DATA        : ${s.noAfterDataCount}`);
  lines.push('');
  lines.push(`  Avg upside now  : ${fmtPct(s.avgUpsideNow)}   (median: ${fmtPct(s.medianUpsideNow)})`);
  lines.push(`  Avg upside  1m  : ${fmtPct(s.avgUpside1m)}   (median: ${fmtPct(s.medianUpside1m)})`);
  lines.push(`  Avg upside  3m  : ${fmtPct(s.avgUpside3m)}   (median: ${fmtPct(s.medianUpside3m)})`);
  lines.push(`  Avg upside  5m  : ${fmtPct(s.avgUpside5m)}   (median: ${fmtPct(s.medianUpside5m)})`);
  lines.push(`  Avg upside 15m  : ${fmtPct(s.avgUpside15m)}   (median: ${fmtPct(s.medianUpside15m)})`);
  lines.push('');
  lines.push(`  Recommendation: ${s.recommendation}`);
  lines.push('');

  // ── Label key ──────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  LABEL KEY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  ENTER_NOW     lowest qualifying entry pct is at approval (upside >= 1.0%)');
  lines.push('  WAIT_1M       lowest qualifying entry pct is at +1m');
  lines.push('  WAIT_3M       lowest qualifying entry pct is at +3m');
  lines.push('  WAIT_5M       lowest qualifying entry pct is at +5m');
  lines.push('  WAIT_15M      lowest qualifying entry pct is at +15m');
  lines.push('  SKIP_NO_EDGE  no entry delay has upside >= 1.0% to bestAfterPct');
  lines.push('  NO_AFTER_DATA no observations recorded after approval');
  lines.push('');

  // ── Safety ─────────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  * Report-only — no real or paper positions opened.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('  * DO NOT CALL AUTO-PAPER');
  lines.push('  * DO NOT CALL PAPER-BUY');
  lines.push('');
  lines.push(`  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true`);
  lines.push(SEP);
  lines.push('');

  return lines.join('\n');
}
