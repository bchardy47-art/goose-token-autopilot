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

export type TrackedLaneStatus =
  | 'GRADUATED_APPROVED'
  | 'PRICE_MOVED'
  | 'FAILED_LIQUIDITY'
  | 'FAILED_VOLUME'
  | 'STALLED'
  | 'WATCHING';

export type ApprovalSource = 'obs' | 'file' | 'both';

export interface TrackedLaneRow {
  contractKey:             string;
  contractKeyShort:        string;
  symbol?:                 string;
  firstWatchAt:            string;
  minutesSinceFirstWatch:  number;
  watchPriceChangePct:     number | null;
  watchLiquidityUsd:       number | null;
  watchVolumeUsd:          number | null;
  latestPriceChangePct:    number | null;
  latestLiquidityUsd:      number | null;
  latestVolumeUsd:         number | null;
  bestLaterPriceChangePct: number | null;
  laterBuyApproved:        boolean;
  approvedAt:              string | null;
  approvalSource:          ApprovalSource | null;
  minToApp:                number | null;
  liquidityHeld:           boolean;
  volumeHeld:              boolean;
  status:                  TrackedLaneStatus;
}

export interface RipperEarlyWatchTrackedLaneOptions {
  observationPaths: string[];
  approvalPaths:    string[];
  nowMs?:           number;
}

export interface RipperEarlyWatchTrackedLaneResult {
  generatedAt:       string;
  totalCandidates:   number;
  rows:              TrackedLaneRow[];
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

// ── Internal types ─────────────────────────────────────────────────────────────

interface ObsRecord {
  contractKey:    string;
  capturedAtMs:   number;
  capturedAt:     string;
  symbol?:        string;
  priceChangePct: number | null;
  liquidityUsd:   number | null;
  volumeUsd:      number | null;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperEarlyWatchTrackedLaneReport(
  options: RipperEarlyWatchTrackedLaneOptions,
): RipperEarlyWatchTrackedLaneResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Load observations ──────────────────────────────────────────────────────
  // allObsMap: ALL observations per contract (for latest-obs and later-obs tracking)
  const allObsMap   = new Map<string, ObsRecord[]>();
  // firstHitMap: earliest WATCH_EARLY_RIP-passing obs per contract
  const firstHitMap = new Map<string, ObsRecord>();
  // obsApprovalsMap: obs fixtures that carry BUY_APPROVED_PAPER (dual-source detection)
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
        contractKey,
        capturedAtMs,
        capturedAt:  f.capturedAt,
        symbol:      f.normalizedSignal.symbol,
        priceChangePct: pct,
        liquidityUsd:   liq,
        volumeUsd:      vol,
      };

      const list = allObsMap.get(contractKey);
      if (list) list.push(rec);
      else allObsMap.set(contractKey, [rec]);

      if (passesPolicy(pct, liq, vol)) {
        const existing = firstHitMap.get(contractKey);
        if (!existing || capturedAtMs < existing.capturedAtMs) {
          firstHitMap.set(contractKey, rec);
        }
      }

      if (f.buyGateDecision === 'BUY_APPROVED_PAPER') {
        const obsApprList = obsApprovalsMap.get(contractKey);
        if (obsApprList) obsApprList.push(capturedAtMs);
        else obsApprovalsMap.set(contractKey, [capturedAtMs]);
      }
    }
  }

  // Sort all obs lists ascending by time
  for (const list of allObsMap.values()) {
    list.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  }

  // ── Load approvals ─────────────────────────────────────────────────────────
  const instanceKeySet = new Set<string>();
  const approvalsMap   = new Map<string, number[]>(); // contractKey -> capturedAtMs[]

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
  const rows: TrackedLaneRow[] = [];

  for (const [contractKey, firstHit] of firstHitMap) {
    const firstWatchAtMs = firstHit.capturedAtMs;
    const allObs         = allObsMap.get(contractKey) ?? [];

    // Later observations are strictly after first watch time
    const laterObs = allObs.filter(o => o.capturedAtMs > firstWatchAtMs);
    // Latest = last in sorted list (may equal firstHit if no other obs)
    const latestObs = allObs[allObs.length - 1] ?? firstHit;

    // Best priceChangePct among all later observations
    let bestLaterPriceChangePct: number | null = null;
    for (const o of laterObs) {
      if (o.priceChangePct != null) {
        if (bestLaterPriceChangePct == null || o.priceChangePct > bestLaterPriceChangePct) {
          bestLaterPriceChangePct = o.priceChangePct;
        }
      }
    }

    // Dual-source approval: check both obs fixtures and approval cycle files
    const obsApprTimes  = (obsApprovalsMap.get(contractKey) ?? []).filter(t => t >= firstWatchAtMs);
    const fileApprTimes = (approvalsMap.get(contractKey)    ?? []).filter(t => t >= firstWatchAtMs);

    const obsApproved  = obsApprTimes.length  > 0;
    const fileApproved = fileApprTimes.length > 0;
    const laterBuyApproved = obsApproved || fileApproved;

    let approvedAt:     string | null = null;
    let approvalSource: ApprovalSource | null = null;
    let minToApp:       number | null = null;

    if (laterBuyApproved) {
      const earliestObs  = obsApproved  ? Math.min(...obsApprTimes)  : Infinity;
      const earliestFile = fileApproved ? Math.min(...fileApprTimes) : Infinity;
      const earliest     = Math.min(earliestObs, earliestFile);
      approvedAt     = new Date(earliest).toISOString();
      approvalSource = obsApproved && fileApproved ? 'both'
                     : obsApproved                 ? 'obs'
                     :                              'file';
      minToApp = (earliest - firstWatchAtMs) / 60_000;
    }

    const latestLiq    = latestObs.liquidityUsd;
    const latestVol    = latestObs.volumeUsd;
    const liquidityHeld = latestLiq != null && latestLiq >= WATCH_EARLY_RIP_LIQ_MIN;
    const volumeHeld    = latestVol != null && latestVol >= WATCH_EARLY_RIP_VOL_MIN;

    // Status — ordered by priority
    let status: TrackedLaneStatus;
    if (laterBuyApproved) {
      status = 'GRADUATED_APPROVED';
    } else if (bestLaterPriceChangePct != null && bestLaterPriceChangePct > WATCH_EARLY_RIP_PCT_MAX) {
      status = 'PRICE_MOVED';
    } else if (!liquidityHeld) {
      status = 'FAILED_LIQUIDITY';
    } else if (!volumeHeld) {
      status = 'FAILED_VOLUME';
    } else if (laterObs.length === 0) {
      status = 'WATCHING';
    } else {
      status = 'STALLED';
    }

    rows.push({
      contractKey,
      contractKeyShort:       shortKey(contractKey),
      symbol:                 firstHit.symbol,
      firstWatchAt:           firstHit.capturedAt,
      minutesSinceFirstWatch: (nowMs - firstWatchAtMs) / 60_000,
      watchPriceChangePct:    firstHit.priceChangePct,
      watchLiquidityUsd:      firstHit.liquidityUsd,
      watchVolumeUsd:         firstHit.volumeUsd,
      latestPriceChangePct:   latestObs.priceChangePct,
      latestLiquidityUsd:     latestLiq,
      latestVolumeUsd:        latestVol,
      bestLaterPriceChangePct,
      laterBuyApproved,
      approvedAt,
      approvalSource,
      minToApp,
      liquidityHeld,
      volumeHeld,
      status,
    });
  }

  rows.sort((a, b) => a.firstWatchAt.localeCompare(b.firstWatchAt));

  return {
    generatedAt,
    totalCandidates:   rows.length,
    rows,
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

function fmtMin(n: number): string {
  return `${n.toFixed(1)}m`;
}

export function renderRipperEarlyWatchTrackedLaneReport(
  result: RipperEarlyWatchTrackedLaneResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER EARLY WATCH TRACKED LANE REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO APPROVAL CHANGES — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated : ${result.generatedAt}`);
  lines.push(`  Candidates: ${result.totalCandidates}`);
  lines.push('');
  lines.push(`  Policy: WATCH_EARLY_RIP`);
  lines.push(`    liquidityUsd >= ${WATCH_EARLY_RIP_LIQ_MIN.toLocaleString()}`);
  lines.push(`    volumeUsd    >= ${WATCH_EARLY_RIP_VOL_MIN.toLocaleString()}`);
  lines.push(`    priceChangePct in [${WATCH_EARLY_RIP_PCT_MIN}, ${WATCH_EARLY_RIP_PCT_MAX}]`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  TRACKED LANE ROWS');
  lines.push(`  ${SEP2}`);
  lines.push('');

  if (result.rows.length === 0) {
    lines.push('  (no WATCH_EARLY_RIP candidates)');
    lines.push('');
  } else {
    const hdr = [
      'sym/addr'.padEnd(16),
      'firstWatchAt'.padEnd(19),
      'minSince'.padStart(9),
      'wPct'.padStart(7),
      'wLiq'.padStart(8),
      'wVol'.padStart(8),
      'latPct'.padStart(7),
      'latLiq'.padStart(8),
      'latVol'.padStart(8),
      'bestPct'.padStart(8),
      'appSrc'.padStart(7),
      'appMin'.padStart(7),
      'liqHeld'.padStart(8),
      'volHeld'.padStart(8),
      'status',
    ].join('  ');
    lines.push(`  ${hdr}`);
    lines.push(`  ${'─'.repeat(hdr.length)}`);

    for (const r of result.rows) {
      const lbl    = r.symbol ? `$${r.symbol}` : r.contractKeyShort;
      const watchTs = r.firstWatchAt.slice(0, 19).replace('T', ' ');
      const appSrcStr = r.approvalSource ?? '-';
      const appMinStr = r.minToApp != null ? `${r.minToApp.toFixed(1)}m` : '-';
      const row = [
        lbl.padEnd(16),
        watchTs.padEnd(19),
        fmtMin(r.minutesSinceFirstWatch).padStart(9),
        fmtPct(r.watchPriceChangePct).padStart(7),
        fmtUsd(r.watchLiquidityUsd).padStart(8),
        fmtUsd(r.watchVolumeUsd).padStart(8),
        fmtPct(r.latestPriceChangePct).padStart(7),
        fmtUsd(r.latestLiquidityUsd).padStart(8),
        fmtUsd(r.latestVolumeUsd).padStart(8),
        fmtPct(r.bestLaterPriceChangePct).padStart(8),
        appSrcStr.padStart(7),
        appMinStr.padStart(7),
        (r.liquidityHeld ? 'yes' : 'no').padStart(8),
        (r.volumeHeld    ? 'yes' : 'no').padStart(8),
        r.status,
      ].join('  ');
      lines.push(`  ${row}`);
    }
    lines.push('');
  }

  lines.push(`  ${SEP2}`);
  lines.push('  STATUS KEY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  GRADUATED_APPROVED  later BUY_APPROVED_PAPER exists');
  lines.push('  PRICE_MOVED         best later priceChangePct > 0.25, no approval');
  lines.push('  FAILED_LIQUIDITY    latest liquidityUsd < 30,000');
  lines.push('  FAILED_VOLUME       latest volumeUsd < 20,000');
  lines.push('  STALLED             above floors, no price move, no approval');
  lines.push('  WATCHING            no later observations yet');
  lines.push('');

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
