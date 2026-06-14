import * as fs from 'fs';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ObsApprovalRow {
  contractKey:          string;
  contractKeyShort:     string;
  symbol?:              string;
  firstObsApprovedAt:   string;
  ripperScore:          number | null;
  liquidityUsd:         number | null;
  volumeUsd:            number | null;
  priceChangePct:       number | null;
  sourceFile:           string;
  nearestFileApprovalAt: string | null;
}

export interface RipperApprovalPersistenceAuditOptions {
  observationPaths: string[];
  approvalPaths:    string[];
}

export interface RipperApprovalPersistenceAuditResult {
  generatedAt:       string;
  totalObsApproved:  number;
  totalFileApproved: number;
  matchedCount:      number;
  obsOnlyCount:      number;
  fileOnlyCount:     number;
  obsOnlyRows:       ObsApprovalRow[];
  fileOnlyKeys:      string[];
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

// Binary search for nearest timestamp in a sorted ms array
function nearestTimestamp(sortedMs: number[], targetMs: number): number | null {
  if (sortedMs.length === 0) return null;
  let lo = 0, hi = sortedMs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedMs[mid] < targetMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return sortedMs[0];
  const before = sortedMs[lo - 1];
  const after  = sortedMs[lo];
  return Math.abs(after - targetMs) <= Math.abs(before - targetMs) ? after : before;
}

// ── Internal record ───────────────────────────────────────────────────────────

interface ObsApprovalCandidate {
  contractKey:  string;
  capturedAtMs: number;
  capturedAt:   string;
  symbol?:      string;
  ripperScore:  number | null;
  liquidityUsd: number | null;
  volumeUsd:    number | null;
  priceChangePct: number | null;
  sourceFile:   string;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperApprovalPersistenceAudit(
  options: RipperApprovalPersistenceAuditOptions,
): RipperApprovalPersistenceAuditResult {
  const generatedAt = new Date().toISOString();

  // ── Load observation approvals ─────────────────────────────────────────────
  // Keep earliest BUY_APPROVED_PAPER record per contract from obs fixtures
  const obsApprMap = new Map<string, ObsApprovalCandidate>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) continue;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      const contractKey  = signalKey(f.normalizedSignal);
      const capturedAtMs = Date.parse(f.capturedAt);
      if (!Number.isFinite(capturedAtMs)) continue;
      const existing = obsApprMap.get(contractKey);
      if (existing && existing.capturedAtMs <= capturedAtMs) continue;

      const sig = f.normalizedSignal as unknown as Record<string, unknown>;
      obsApprMap.set(contractKey, {
        contractKey,
        capturedAtMs,
        capturedAt:    f.capturedAt,
        symbol:        f.normalizedSignal.symbol,
        ripperScore:   toFiniteNum(f.ripperScore),
        liquidityUsd:  toFiniteNum(sig['liquidityUsd']),
        volumeUsd:     toFiniteNum(sig['volumeUsd']),
        priceChangePct: toFiniteNum(sig['priceChangePct']),
        sourceFile:    p,
      });
    }
  }

  // ── Load file approvals ────────────────────────────────────────────────────
  const fileApprSet           = new Set<string>();
  const fileApprTimestampsMs: number[] = [];
  const instanceKeySet        = new Set<string>();

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
      fileApprSet.add(contractKey);
      fileApprTimestampsMs.push(capturedAtMs);
    }
  }

  fileApprTimestampsMs.sort((a, b) => a - b);

  // ── Categorize ────────────────────────────────────────────────────────────
  const obsKeys  = new Set(obsApprMap.keys());
  const fileKeys = new Set(fileApprSet);

  const obsOnlyRows: ObsApprovalRow[]  = [];
  const fileOnlyKeys: string[]         = [];
  let matchedCount = 0;

  for (const [contractKey, cand] of obsApprMap) {
    if (fileKeys.has(contractKey)) {
      matchedCount++;
    } else {
      const nearestMs = nearestTimestamp(fileApprTimestampsMs, cand.capturedAtMs);
      obsOnlyRows.push({
        contractKey,
        contractKeyShort:     shortKey(contractKey),
        symbol:               cand.symbol,
        firstObsApprovedAt:   cand.capturedAt,
        ripperScore:          cand.ripperScore,
        liquidityUsd:         cand.liquidityUsd,
        volumeUsd:            cand.volumeUsd,
        priceChangePct:       cand.priceChangePct,
        sourceFile:           cand.sourceFile,
        nearestFileApprovalAt: nearestMs != null ? new Date(nearestMs).toISOString() : null,
      });
    }
  }

  for (const k of fileKeys) {
    if (!obsKeys.has(k)) {
      fileOnlyKeys.push(k);
    }
  }

  obsOnlyRows.sort((a, b) => a.firstObsApprovedAt.localeCompare(b.firstObsApprovedAt));
  fileOnlyKeys.sort();

  return {
    generatedAt,
    totalObsApproved:  obsKeys.size,
    totalFileApproved: fileKeys.size,
    matchedCount,
    obsOnlyCount:      obsOnlyRows.length,
    fileOnlyCount:     fileOnlyKeys.length,
    obsOnlyRows,
    fileOnlyKeys,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtUsd(n: number | null): string {
  if (n == null) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtScore(n: number | null): string {
  return n == null ? 'n/a' : n.toFixed(2);
}

export function renderRipperApprovalPersistenceAudit(
  result: RipperApprovalPersistenceAuditResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER APPROVAL PERSISTENCE AUDIT');
  lines.push('  [REPORT ONLY — NO TRADES — NO APPROVAL CHANGES — READ ONLY]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated             : ${result.generatedAt}`);
  lines.push('');
  lines.push(`  Obs-approved contracts : ${result.totalObsApproved}`);
  lines.push(`  File-approved contracts: ${result.totalFileApproved}`);
  lines.push(`  Matched (both)         : ${result.matchedCount}`);
  lines.push(`  Obs-only (MISSING file): ${result.obsOnlyCount}`);
  lines.push(`  File-only (MISSING obs): ${result.fileOnlyCount}`);
  lines.push('');

  // Obs-only section
  lines.push(`  ${SEP2}`);
  lines.push('  OBS-APPROVED BUT MISSING FROM APPROVAL FILES');
  lines.push(`  ${SEP2}`);
  lines.push('');

  if (result.obsOnlyRows.length === 0) {
    lines.push('  (none — all obs approvals have matching approval file entries)');
    lines.push('');
  } else {
    const hdr = [
      'sym/addr'.padEnd(16),
      'firstObsApprovedAt'.padEnd(24),
      'score'.padStart(7),
      'pct'.padStart(7),
      'liq'.padStart(8),
      'vol'.padStart(8),
      'nearestFileApproval'.padEnd(24),
      'sourceFile',
    ].join('  ');
    lines.push(`  ${hdr}`);
    lines.push(`  ${'─'.repeat(hdr.length)}`);

    for (const r of result.obsOnlyRows) {
      const lbl      = r.symbol ? `$${r.symbol}` : r.contractKeyShort;
      const obsTs    = r.firstObsApprovedAt.slice(0, 23).replace('T', ' ');
      const nearTs   = r.nearestFileApprovalAt
        ? r.nearestFileApprovalAt.slice(0, 23).replace('T', ' ')
        : '(none)';
      const srcShort = r.sourceFile.length > 40 ? `…${r.sourceFile.slice(-39)}` : r.sourceFile;
      const row = [
        lbl.padEnd(16),
        obsTs.padEnd(24),
        fmtScore(r.ripperScore).padStart(7),
        fmtPct(r.priceChangePct).padStart(7),
        fmtUsd(r.liquidityUsd).padStart(8),
        fmtUsd(r.volumeUsd).padStart(8),
        nearTs.padEnd(24),
        srcShort,
      ].join('  ');
      lines.push(`  ${row}`);
    }
    lines.push('');
  }

  // File-only section
  lines.push(`  ${SEP2}`);
  lines.push('  FILE-APPROVED BUT MISSING FROM OBSERVATION FIXTURES');
  lines.push(`  ${SEP2}`);
  lines.push('');

  if (result.fileOnlyKeys.length === 0) {
    lines.push('  (none — all file approvals have matching observation fixture entries)');
    lines.push('');
  } else {
    for (const k of result.fileOnlyKeys) {
      lines.push(`  ${k}`);
    }
    lines.push('');
  }

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
