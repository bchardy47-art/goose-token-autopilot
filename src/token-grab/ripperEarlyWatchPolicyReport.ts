import * as fs from 'fs';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Constants ──────────────────────────────────────────────────────────────────

export const WATCH_EARLY_RIP_POLICY_ID = 'WATCH_EARLY_RIP';
export const WATCH_EARLY_RIP_LIQ_MIN   = 30_000;
export const WATCH_EARLY_RIP_VOL_MIN   = 20_000;
export const WATCH_EARLY_RIP_PCT_MIN   = -1;
export const WATCH_EARLY_RIP_PCT_MAX   = 0.25;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WatchUniqueCandidate {
  contractKey:            string;
  contractKeyShort:       string;
  symbol?:                string;
  firstWatchAt:           string;
  watchPriceChangePct:    number | null;
  watchLiquidityUsd:      number | null;
  watchVolumeUsd:         number | null;
  // outcome — earliest later approval for this contract
  laterApproved:          boolean;
  approvedAt:             string | null;
  minutesToApproval:      number | null;
  approvalPriceChangePct: number | null;
  approvalLiquidityUsd:   number | null;
  approvalVolumeUsd:      number | null;
  laterPriceGt025:        boolean;
  laterFullCombo:         boolean;
}

export interface EarlyWatchPolicySummary {
  observationFilesRead:    number;
  observationFilesMissing: number;
  approvalFilesRead:       number;
  approvalFilesMissing:    number;
  observationsLoaded:      number;
  approvalsLoaded:         number;
  uniqueObservedContracts: number;
  watchEarlyRipHits:       number;
  uniqueWatchContracts:    number;
  hitsLaterApproved:       number;
  hitsLaterPriceGt025:     number;
  hitsLaterFullCombo:      number;
  avgMinutesToApproval:    number | null;
  medianMinutesToApproval: number | null;
}

export interface EarlyWatchPolicyFunnel {
  totalUniqueCandidates: number;
  laterApprovedCount:    number;
  laterApprovedPct:      number | null;
  laterPriceGt025Count:  number;
  laterPriceGt025Pct:    number | null;
  laterFullComboCount:   number;
  laterFullComboPct:     number | null;
  neverApprovedCount:    number;
  neverApprovedPct:      number | null;
}

export interface RipperEarlyWatchPolicyOptions {
  observationPaths: string[];
  approvalPaths:    string[];
  nowMs?:           number;
}

export interface RipperEarlyWatchPolicyResult {
  generatedAt:       string;
  summary:           EarlyWatchPolicySummary;
  funnel:            EarlyWatchPolicyFunnel;
  candidates:        WatchUniqueCandidate[];
  realTradingLocked: true;
  tradingExecuted:   0;
  noRealTradeSent:   true;
  paperOnly:         true;
  readOnly:          true;
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

function passesWatchEarlyRip(pct: number | null, liq: number | null, vol: number | null): boolean {
  return (
    liq != null && liq >= WATCH_EARLY_RIP_LIQ_MIN &&
    vol != null && vol >= WATCH_EARLY_RIP_VOL_MIN &&
    pct != null && pct >= WATCH_EARLY_RIP_PCT_MIN && pct <= WATCH_EARLY_RIP_PCT_MAX
  );
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface ObsHit {
  contractKey:    string;
  capturedAtMs:   number;
  capturedAt:     string;
  symbol?:        string;
  priceChangePct: number | null;
  liquidityUsd:   number | null;
  volumeUsd:      number | null;
}

interface ApprovalEntry {
  contractKey:    string;
  capturedAt:     string;
  capturedAtMs:   number;
  priceChangePct: number | null;
  liquidityUsd:   number | null;
  volumeUsd:      number | null;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperEarlyWatchPolicyReport(
  options: RipperEarlyWatchPolicyOptions,
): RipperEarlyWatchPolicyResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Step 1: Load observations ────────────────────────────────────────────────
  let observationFilesRead    = 0;
  let observationFilesMissing = 0;
  let observationsLoaded      = 0;

  // All unique contracts seen in obs files (regardless of policy)
  const allObsContracts = new Set<string>();
  // Total WATCH_EARLY_RIP hits (may include duplicates per contract)
  let watchEarlyRipHits = 0;
  // Per-contract: list of hits sorted ascending (for dedup later)
  const hitsMap = new Map<string, ObsHit[]>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) { observationFilesMissing++; continue; }
    observationFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      const contractKey  = signalKey(f.normalizedSignal);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;
      observationsLoaded++;
      allObsContracts.add(contractKey);

      const sig = f.normalizedSignal as Record<string, unknown>;
      const pct = toFiniteNum(sig['priceChangePct']);
      const liq = toFiniteNum(sig['liquidityUsd']);
      const vol = toFiniteNum(sig['volumeUsd']);

      if (!passesWatchEarlyRip(pct, liq, vol)) continue;

      watchEarlyRipHits++;
      const hit: ObsHit = {
        contractKey,
        capturedAtMs,
        capturedAt:  f.capturedAt,
        symbol:      f.normalizedSignal.symbol,
        priceChangePct: pct,
        liquidityUsd:   liq,
        volumeUsd:      vol,
      };
      const list = hitsMap.get(contractKey);
      if (list) list.push(hit);
      else hitsMap.set(contractKey, [hit]);
    }
  }

  // ── Step 2: Load approvals ───────────────────────────────────────────────────
  let approvalFilesRead    = 0;
  let approvalFilesMissing = 0;
  let approvalsLoaded      = 0;

  const instanceKeySet = new Set<string>();
  // Per-contract: all BUY_APPROVED_PAPER entries
  const approvalsMap = new Map<string, ApprovalEntry[]>();

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) { approvalFilesMissing++; continue; }
    approvalFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      const contractKey  = signalKey(f.normalizedSignal);
      const instanceKey  = `${contractKey}::${f.capturedAt}`;
      if (instanceKeySet.has(instanceKey)) continue;
      instanceKeySet.add(instanceKey);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;
      approvalsLoaded++;

      const sig = f.normalizedSignal as Record<string, unknown>;
      const entry: ApprovalEntry = {
        contractKey,
        capturedAt:    f.capturedAt,
        capturedAtMs,
        priceChangePct: toFiniteNum(sig['priceChangePct']),
        liquidityUsd:   toFiniteNum(sig['liquidityUsd']),
        volumeUsd:      toFiniteNum(sig['volumeUsd']),
      };
      const list = approvalsMap.get(contractKey);
      if (list) list.push(entry);
      else approvalsMap.set(contractKey, [entry]);
    }
  }

  // ── Step 3: Build unique candidates (earliest hit per contract) ───────────────
  const candidates: WatchUniqueCandidate[] = [];

  for (const [contractKey, hits] of hitsMap) {
    // Sort hits ascending, take the earliest
    const sorted     = [...hits].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
    const firstHit   = sorted[0];
    const firstWatchAtMs = firstHit.capturedAtMs;

    // Find earliest later approval (approvedAtMs >= firstWatchAtMs)
    const contractApprovals = approvalsMap.get(contractKey) ?? [];
    const laterApprovals    = contractApprovals
      .filter(a => a.capturedAtMs >= firstWatchAtMs)
      .sort((a, b) => a.capturedAtMs - b.capturedAtMs);
    const approval = laterApprovals[0] ?? null;

    const laterApproved = approval != null;
    const aPct = approval?.priceChangePct ?? null;
    const aLiq = approval?.liquidityUsd   ?? null;
    const aVol = approval?.volumeUsd      ?? null;

    const laterPriceGt025 = laterApproved && aPct != null && aPct > 0.25;
    const laterFullCombo  =
      laterPriceGt025 &&
      aLiq != null && aLiq >= 30_000 &&
      aVol != null && aVol >= 20_000;

    const minutesToApproval = laterApproved
      ? (approval!.capturedAtMs - firstWatchAtMs) / 60_000
      : null;

    candidates.push({
      contractKey,
      contractKeyShort:       shortKey(contractKey),
      symbol:                 firstHit.symbol,
      firstWatchAt:           firstHit.capturedAt,
      watchPriceChangePct:    firstHit.priceChangePct,
      watchLiquidityUsd:      firstHit.liquidityUsd,
      watchVolumeUsd:         firstHit.volumeUsd,
      laterApproved,
      approvedAt:             approval?.capturedAt ?? null,
      minutesToApproval,
      approvalPriceChangePct: aPct,
      approvalLiquidityUsd:   aLiq,
      approvalVolumeUsd:      aVol,
      laterPriceGt025,
      laterFullCombo,
    });
  }

  // Sort candidates by firstWatchAt ascending
  candidates.sort((a, b) => a.firstWatchAt.localeCompare(b.firstWatchAt));

  // ── Step 4: Summary ──────────────────────────────────────────────────────────
  const approvedCands   = candidates.filter(c => c.laterApproved);
  const minsList        = approvedCands.map(c => c.minutesToApproval).filter((v): v is number => v != null);

  const summary: EarlyWatchPolicySummary = {
    observationFilesRead,
    observationFilesMissing,
    approvalFilesRead,
    approvalFilesMissing,
    observationsLoaded,
    approvalsLoaded,
    uniqueObservedContracts:  allObsContracts.size,
    watchEarlyRipHits,
    uniqueWatchContracts:     hitsMap.size,
    hitsLaterApproved:        approvedCands.length,
    hitsLaterPriceGt025:      candidates.filter(c => c.laterPriceGt025).length,
    hitsLaterFullCombo:       candidates.filter(c => c.laterFullCombo).length,
    avgMinutesToApproval:     avgOf(minsList),
    medianMinutesToApproval:  medianOf(minsList),
  };

  // ── Step 5: Funnel ────────────────────────────────────────────────────────────
  const total    = candidates.length;
  const approved = approvedCands.length;
  const pg025    = candidates.filter(c => c.laterPriceGt025).length;
  const fc       = candidates.filter(c => c.laterFullCombo).length;
  const never    = candidates.filter(c => !c.laterApproved).length;
  const pct      = (n: number): number | null => total > 0 ? (n / total) * 100 : null;

  const funnel: EarlyWatchPolicyFunnel = {
    totalUniqueCandidates: total,
    laterApprovedCount:    approved,
    laterApprovedPct:      pct(approved),
    laterPriceGt025Count:  pg025,
    laterPriceGt025Pct:    pct(pg025),
    laterFullComboCount:   fc,
    laterFullComboPct:     pct(fc),
    neverApprovedCount:    never,
    neverApprovedPct:      pct(never),
  };

  return {
    generatedAt,
    summary,
    funnel,
    candidates,
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

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function renderSummarySection(s: EarlyWatchPolicySummary): string[] {
  const lines: string[] = [];
  lines.push(`  Observation files read         : ${s.observationFilesRead}${s.observationFilesMissing > 0 ? ` (${s.observationFilesMissing} missing)` : ''}`);
  lines.push(`  Approval files read            : ${s.approvalFilesRead}${s.approvalFilesMissing > 0 ? ` (${s.approvalFilesMissing} missing)` : ''}`);
  lines.push(`  Observations loaded            : ${s.observationsLoaded}`);
  lines.push(`  Approvals loaded               : ${s.approvalsLoaded}`);
  lines.push(`  Unique observed contracts      : ${s.uniqueObservedContracts}`);
  lines.push('');
  lines.push(`  WATCH_EARLY_RIP hits (total)   : ${s.watchEarlyRipHits}`);
  lines.push(`  Unique WATCH_EARLY_RIP contracts: ${s.uniqueWatchContracts}`);
  lines.push('');
  lines.push(`  Later BUY_APPROVED_PAPER       : ${s.hitsLaterApproved}`);
  lines.push(`  Later price_gt_0_25            : ${s.hitsLaterPriceGt025}`);
  lines.push(`  Later full combo               : ${s.hitsLaterFullCombo}`);
  lines.push(`  Avg minutes to approval        : ${fmtMin(s.avgMinutesToApproval)}`);
  lines.push(`  Median minutes to approval     : ${fmtMin(s.medianMinutesToApproval)}`);
  return lines;
}

function renderFunnelSection(f: EarlyWatchPolicyFunnel): string[] {
  const lines: string[] = [];
  lines.push(`  Total unique candidates        : ${f.totalUniqueCandidates}`);
  lines.push(`  Later approved                 : ${f.laterApprovedCount} (${fmtRate(f.laterApprovedPct)})`);
  lines.push(`  Later price_gt_0_25            : ${f.laterPriceGt025Count} (${fmtRate(f.laterPriceGt025Pct)})`);
  lines.push(`  Later full combo               : ${f.laterFullComboCount} (${fmtRate(f.laterFullComboPct)})`);
  lines.push(`  Never approved                 : ${f.neverApprovedCount} (${fmtRate(f.neverApprovedPct)})`);
  return lines;
}

function renderDetailsSection(candidates: WatchUniqueCandidate[]): string[] {
  const lines: string[] = [];

  if (candidates.length === 0) {
    lines.push('  (no WATCH_EARLY_RIP candidates)');
    lines.push('');
    return lines;
  }

  const hdr = [
    'sym/addr'.padEnd(16),
    'firstWatchAt'.padEnd(20),
    'wPct'.padStart(7),
    'wLiq'.padStart(8),
    'wVol'.padStart(8),
    'approvedAt'.padEnd(20),
    'minToApp'.padStart(9),
    'aPct'.padStart(7),
    'aLiq'.padStart(8),
    'aVol'.padStart(8),
    'p>0.25'.padStart(6),
    'combo'.padStart(5),
  ].join('  ');
  lines.push(`  ${hdr}`);
  lines.push(`  ${'─'.repeat(hdr.length)}`);

  for (const c of candidates) {
    const lbl       = c.symbol ? `$${c.symbol}` : c.contractKeyShort;
    const watchTs   = c.firstWatchAt.slice(0, 19).replace('T', ' ');
    const approveTs = c.approvedAt ? c.approvedAt.slice(0, 19).replace('T', ' ') : 'missing             ';

    const row = [
      lbl.padEnd(16),
      watchTs.padEnd(20),
      fmtPct(c.watchPriceChangePct).padStart(7),
      fmtUsd(c.watchLiquidityUsd).padStart(8),
      fmtUsd(c.watchVolumeUsd).padStart(8),
      approveTs.padEnd(20),
      fmtMin(c.minutesToApproval).padStart(9),
      fmtPct(c.approvalPriceChangePct).padStart(7),
      fmtUsd(c.approvalLiquidityUsd).padStart(8),
      fmtUsd(c.approvalVolumeUsd).padStart(8),
      (c.laterPriceGt025 ? 'yes' : 'no').padStart(6),
      (c.laterFullCombo  ? 'yes' : 'no').padStart(5),
    ].join('  ');
    lines.push(`  ${row}`);
  }
  lines.push('');
  return lines;
}

export function renderRipperEarlyWatchPolicyReport(
  result: RipperEarlyWatchPolicyResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER EARLY WATCH POLICY REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO APPROVAL CHANGES — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated : ${result.generatedAt}`);
  lines.push('');
  lines.push(`  Policy: WATCH_EARLY_RIP`);
  lines.push(`    liquidityUsd >= ${WATCH_EARLY_RIP_LIQ_MIN.toLocaleString()}`);
  lines.push(`    volumeUsd    >= ${WATCH_EARLY_RIP_VOL_MIN.toLocaleString()}`);
  lines.push(`    priceChangePct in [${WATCH_EARLY_RIP_PCT_MIN}, ${WATCH_EARLY_RIP_PCT_MAX}]`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  EARLY WATCH POLICY SUMMARY');
  lines.push(`  ${SEP2}`);
  lines.push('');
  for (const l of renderSummarySection(result.summary)) lines.push(l);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  WATCH_EARLY_RIP OUTCOME FUNNEL');
  lines.push(`  ${SEP2}`);
  lines.push('');
  for (const l of renderFunnelSection(result.funnel)) lines.push(l);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  WATCH_EARLY_RIP DETAILS');
  lines.push(`  ${SEP2}`);
  lines.push('');
  for (const l of renderDetailsSection(result.candidates)) lines.push(l);

  lines.push(`  ${SEP2}`);
  lines.push('  DO NOT APPLY YET');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  * Report-only shadow policy — no real or paper positions were opened.');
  lines.push('  * Do NOT enable real trading.');
  lines.push('  * Do NOT change approval or buy gate logic.');
  lines.push('  * Do NOT change scoring weights.');
  lines.push('  * Do NOT call auto-paper.');
  lines.push('  * This is a measurement-only report. WATCH_EARLY_RIP is not wired to any trade path.');
  lines.push('');
  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true  reportOnly=true`);
  lines.push(SEP);
  lines.push('');

  return lines.join('\n');
}
