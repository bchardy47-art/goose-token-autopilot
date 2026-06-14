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

export type LeadValueLabel =
  | 'SAME_OBS_APPROVAL'
  | 'USEFUL_PRE_APPROVAL_MOVE'
  | 'LEAD_TIME_BUT_NO_PRE_MOVE'
  | 'NO_APPROVAL';

export type LeadValueApprovalSource = 'obs' | 'file' | 'both';

export interface LeadValueRow {
  contractKey:            string;
  contractKeyShort:       string;
  symbol?:                string;
  firstWatchAt:           string;
  approvedAt:             string | null;
  approvalSource:         LeadValueApprovalSource | null;
  minToApp:               number | null;
  watchPriceChangePct:    number | null;
  bestBeforeApprovalPct:  number | null;
  approvalPriceChangePct: number | null;
  bestAfterApprovalPct:   number | null;
  preApprovalMovePct:     number | null;
  postApprovalMovePct:    number | null;
  label:                  LeadValueLabel;
}

export interface LeadValueSummary {
  totalCandidates:          number;
  approvedCount:            number;
  sameObsCount:             number;
  positiveLeadCount:        number;
  usefulPreMoveCount:       number;
  noPreMoveCount:           number;
  avgPreApprovalMovePct:    number | null;
  medianPreApprovalMovePct: number | null;
}

export interface RipperEarlyWatchLeadValueOptions {
  observationPaths: string[];
  approvalPaths:    string[];
}

export interface RipperEarlyWatchLeadValueResult {
  generatedAt:       string;
  rows:              LeadValueRow[];
  summary:           LeadValueSummary;
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

function passesPolicy(pct: number | null, liq: number | null, vol: number | null): boolean {
  return (
    liq != null && liq >= WATCH_EARLY_RIP_LIQ_MIN &&
    vol != null && vol >= WATCH_EARLY_RIP_VOL_MIN &&
    pct != null && pct >= WATCH_EARLY_RIP_PCT_MIN && pct <= WATCH_EARLY_RIP_PCT_MAX
  );
}

function maxPct(obs: ObsRecord[]): number | null {
  let best: number | null = null;
  for (const o of obs) {
    if (o.priceChangePct != null && (best == null || o.priceChangePct > best)) {
      best = o.priceChangePct;
    }
  }
  return best;
}

function closestPct(allObs: ObsRecord[], targetMs: number): number | null {
  if (allObs.length === 0) return null;
  let closest = allObs[0];
  let minDiff = Math.abs(allObs[0].capturedAtMs - targetMs);
  for (let i = 1; i < allObs.length; i++) {
    const diff = Math.abs(allObs[i].capturedAtMs - targetMs);
    if (diff < minDiff) { minDiff = diff; closest = allObs[i]; }
  }
  return closest.priceChangePct;
}

function calcMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ── Internal type ─────────────────────────────────────────────────────────────

interface ObsRecord {
  capturedAtMs:   number;
  priceChangePct: number | null;
  liquidityUsd:   number | null;
  volumeUsd:      number | null;
  symbol?:        string;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperEarlyWatchLeadValueReport(
  options: RipperEarlyWatchLeadValueOptions,
): RipperEarlyWatchLeadValueResult {
  const generatedAt = new Date().toISOString();

  // ── Load observations ──────────────────────────────────────────────────────
  const allObsMap       = new Map<string, ObsRecord[]>();
  const firstHitMap     = new Map<string, { contractKey: string; capturedAt: string; capturedAtMs: number; symbol?: string; priceChangePct: number | null; liquidityUsd: number | null; volumeUsd: number | null }>();
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

      const rec: ObsRecord = {
        capturedAtMs,
        priceChangePct: pct,
        liquidityUsd:   liq,
        volumeUsd:      vol,
        symbol:         f.normalizedSignal.symbol,
      };

      const list = allObsMap.get(contractKey);
      if (list) list.push(rec);
      else allObsMap.set(contractKey, [rec]);

      if (passesPolicy(pct, liq, vol)) {
        const existing = firstHitMap.get(contractKey);
        if (!existing || capturedAtMs < existing.capturedAtMs) {
          firstHitMap.set(contractKey, {
            contractKey,
            capturedAt:    f.capturedAt,
            capturedAtMs,
            symbol:        f.normalizedSignal.symbol,
            priceChangePct: pct,
            liquidityUsd:   liq,
            volumeUsd:      vol,
          });
        }
      }

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
  const instanceKeySet = new Set<string>();
  const approvalsMap   = new Map<string, number[]>();

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
      const list = approvalsMap.get(contractKey);
      if (list) list.push(capturedAtMs);
      else approvalsMap.set(contractKey, [capturedAtMs]);
    }
  }

  // ── Build rows ─────────────────────────────────────────────────────────────
  const rows: LeadValueRow[] = [];

  for (const [contractKey, firstHit] of firstHitMap) {
    const firstWatchAtMs = firstHit.capturedAtMs;
    const allObs         = allObsMap.get(contractKey) ?? [];

    // Dual-source approval
    const obsApprTimes  = (obsApprovalsMap.get(contractKey) ?? []).filter(t => t >= firstWatchAtMs);
    const fileApprTimes = (approvalsMap.get(contractKey)    ?? []).filter(t => t >= firstWatchAtMs);
    const obsApproved   = obsApprTimes.length  > 0;
    const fileApproved  = fileApprTimes.length > 0;
    const laterBuyApproved = obsApproved || fileApproved;

    let approvedAtMs:   number | null = null;
    let approvedAt:     string | null = null;
    let approvalSource: LeadValueApprovalSource | null = null;
    let minToApp:       number | null = null;

    if (laterBuyApproved) {
      const earliestObs  = obsApproved  ? Math.min(...obsApprTimes)  : Infinity;
      const earliestFile = fileApproved ? Math.min(...fileApprTimes) : Infinity;
      approvedAtMs   = Math.min(earliestObs, earliestFile);
      approvedAt     = new Date(approvedAtMs).toISOString();
      approvalSource = obsApproved && fileApproved ? 'both' : obsApproved ? 'obs' : 'file';
      minToApp       = (approvedAtMs - firstWatchAtMs) / 60_000;
    }

    // Price slices
    const beforeObs = approvedAtMs != null
      ? allObs.filter(o => o.capturedAtMs > firstWatchAtMs && o.capturedAtMs < approvedAtMs!)
      : [];
    const afterObs = approvedAtMs != null
      ? allObs.filter(o => o.capturedAtMs > approvedAtMs!)
      : [];

    const bestBeforeApprovalPct  = maxPct(beforeObs);
    const approvalPriceChangePct = approvedAtMs != null ? closestPct(allObs, approvedAtMs) : null;
    const bestAfterApprovalPct   = maxPct(afterObs);

    const watchPct = firstHit.priceChangePct;
    const preApprovalMovePct  = bestBeforeApprovalPct != null && watchPct != null
      ? bestBeforeApprovalPct - watchPct
      : null;
    const postApprovalMovePct = bestAfterApprovalPct != null && approvalPriceChangePct != null
      ? bestAfterApprovalPct - approvalPriceChangePct
      : null;

    // Value label
    let label: LeadValueLabel;
    if (!laterBuyApproved) {
      label = 'NO_APPROVAL';
    } else if (minToApp != null && minToApp <= 0.5) {
      label = 'SAME_OBS_APPROVAL';
    } else if (preApprovalMovePct != null && preApprovalMovePct >= 0.5) {
      label = 'USEFUL_PRE_APPROVAL_MOVE';
    } else {
      label = 'LEAD_TIME_BUT_NO_PRE_MOVE';
    }

    rows.push({
      contractKey,
      contractKeyShort:       shortKey(contractKey),
      symbol:                 firstHit.symbol,
      firstWatchAt:           firstHit.capturedAt,
      approvedAt,
      approvalSource,
      minToApp,
      watchPriceChangePct:    watchPct,
      bestBeforeApprovalPct,
      approvalPriceChangePct,
      bestAfterApprovalPct,
      preApprovalMovePct,
      postApprovalMovePct,
      label,
    });
  }

  rows.sort((a, b) => a.firstWatchAt.localeCompare(b.firstWatchAt));

  // ── Summary ────────────────────────────────────────────────────────────────
  const approvedRows        = rows.filter(r => r.label !== 'NO_APPROVAL');
  const positiveLeadRows    = rows.filter(r => r.minToApp != null && r.minToApp > 0.5);
  const preMoveValues       = positiveLeadRows
    .filter(r => r.preApprovalMovePct != null)
    .map(r => r.preApprovalMovePct as number);

  const summary: LeadValueSummary = {
    totalCandidates:       rows.length,
    approvedCount:         approvedRows.length,
    sameObsCount:          rows.filter(r => r.label === 'SAME_OBS_APPROVAL').length,
    positiveLeadCount:     positiveLeadRows.length,
    usefulPreMoveCount:    rows.filter(r => r.label === 'USEFUL_PRE_APPROVAL_MOVE').length,
    noPreMoveCount:        rows.filter(r => r.label === 'LEAD_TIME_BUT_NO_PRE_MOVE').length,
    avgPreApprovalMovePct:    preMoveValues.length > 0
      ? preMoveValues.reduce((a, b) => a + b, 0) / preMoveValues.length
      : null,
    medianPreApprovalMovePct: preMoveValues.length > 0
      ? calcMedian(preMoveValues)
      : null,
  };

  return {
    generatedAt,
    rows,
    summary,
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

function fmtMin(n: number | null): string {
  return n == null ? 'n/a' : `${n.toFixed(1)}m`;
}

export function renderRipperEarlyWatchLeadValueReport(
  result: RipperEarlyWatchLeadValueResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER EARLY WATCH LEAD VALUE REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO APPROVAL CHANGES — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated  : ${result.generatedAt}`);
  lines.push(`  Candidates : ${result.summary.totalCandidates}`);
  lines.push('');
  lines.push(`  Policy: WATCH_EARLY_RIP`);
  lines.push(`    liquidityUsd >= ${WATCH_EARLY_RIP_LIQ_MIN.toLocaleString()}`);
  lines.push(`    volumeUsd    >= ${WATCH_EARLY_RIP_VOL_MIN.toLocaleString()}`);
  lines.push(`    priceChangePct in [${WATCH_EARLY_RIP_PCT_MIN}, ${WATCH_EARLY_RIP_PCT_MAX}]`);
  lines.push('');

  // ── Row table ──────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  LEAD VALUE ROWS');
  lines.push(`  ${SEP2}`);
  lines.push('');

  if (result.rows.length === 0) {
    lines.push('  (no WATCH_EARLY_RIP candidates)');
    lines.push('');
  } else {
    const hdr = [
      'sym/addr'.padEnd(16),
      'firstWatchAt'.padEnd(19),
      'approvedAt'.padEnd(19),
      'src'.padStart(5),
      'appMin'.padStart(7),
      'wPct'.padStart(7),
      'bestBefore'.padStart(11),
      'atAppr'.padStart(7),
      'bestAfter'.padStart(10),
      'preMove'.padStart(8),
      'postMove'.padStart(9),
      'label',
    ].join('  ');
    lines.push(`  ${hdr}`);
    lines.push(`  ${'─'.repeat(hdr.length)}`);

    for (const r of result.rows) {
      const lbl      = r.symbol ? `$${r.symbol}` : r.contractKeyShort;
      const watchTs  = r.firstWatchAt.slice(0, 19).replace('T', ' ');
      const apprTs   = r.approvedAt ? r.approvedAt.slice(0, 19).replace('T', ' ') : '-';
      const row = [
        lbl.padEnd(16),
        watchTs.padEnd(19),
        apprTs.padEnd(19),
        (r.approvalSource ?? '-').padStart(5),
        fmtMin(r.minToApp).padStart(7),
        fmtPct(r.watchPriceChangePct).padStart(7),
        fmtPct(r.bestBeforeApprovalPct).padStart(11),
        fmtPct(r.approvalPriceChangePct).padStart(7),
        fmtPct(r.bestAfterApprovalPct).padStart(10),
        fmtPct(r.preApprovalMovePct).padStart(8),
        fmtPct(r.postApprovalMovePct).padStart(9),
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
  lines.push(`  Total candidates              : ${s.totalCandidates}`);
  lines.push(`  Approved candidates           : ${s.approvedCount}`);
  lines.push(`  Same-obs approvals            : ${s.sameObsCount}`);
  lines.push(`  Positive lead-time (>0.5m)    : ${s.positiveLeadCount}`);
  lines.push(`  Useful pre-approval move      : ${s.usefulPreMoveCount}`);
  lines.push(`  Lead time, no pre-move        : ${s.noPreMoveCount}`);
  lines.push('');
  lines.push(`  Avg pre-approval move (>0.5m) : ${s.avgPreApprovalMovePct    != null ? fmtPct(s.avgPreApprovalMovePct)    : 'n/a'}`);
  lines.push(`  Med pre-approval move (>0.5m) : ${s.medianPreApprovalMovePct != null ? fmtPct(s.medianPreApprovalMovePct) : 'n/a'}`);
  lines.push('');

  // ── Label key ──────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  LABEL KEY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  SAME_OBS_APPROVAL         minToApp <= 0.5m (no observable lead time)');
  lines.push('  USEFUL_PRE_APPROVAL_MOVE  minToApp > 0.5m and preApprovalMovePct >= 0.5%');
  lines.push('  LEAD_TIME_BUT_NO_PRE_MOVE minToApp > 0.5m and preApprovalMovePct < 0.5%');
  lines.push('  NO_APPROVAL               no BUY_APPROVED_PAPER found');
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
