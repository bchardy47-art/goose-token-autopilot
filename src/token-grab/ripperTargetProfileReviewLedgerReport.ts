import * as fs from 'fs';

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_LEDGER_PATH = 'data/token-grab/ripper/target-profile-review-ledger.jsonl';
const LATEST_N = 10;

// ── Types ──────────────────────────────────────────────────────────────────────
interface LedgerRow {
  reviewId?:         string;
  targetProfileId?:  string;
  cycleId?:          string;
  contract?:         string;
  symbol?:           string | null;
  capturedAt?:       string;
  reviewedAt?:       string;
  ageMinutes?:       number | null;
  liquidityUsd?:     number | null;
  liquidityBucket?:  string;
  vlrBucket?:        string;
  clusterRisk?:      string | null;
  bubbleMapsScore?:  number | null;
  ripperScore?:      number | null;
  timingPath?:       string;
  paperReviewLabel?: string;
  status?:           string;
  outcomeStatus?:    string;
}

export interface ReviewLedgerReportResult {
  ledgerPath:          string;
  totalReviewed:       number;
  uniqueContracts:     number;
  byCycleId:           Record<string, number>;
  bySymbol:            Record<string, number>;
  outcomeStatusCounts: Record<string, number>;
  targetProfileCounts: Record<string, number>;
  latestCandidates:    LedgerRow[];
  reportOnly:          true;
  readOnly:            true;
  paperOnly:           true;
  realTradingLocked:   true;
  tradingExecuted:     0;
}

export interface ReviewLedgerReportOptions {
  ledgerPath?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const SAFETY = {
  reportOnly:        true  as const,
  readOnly:          true  as const,
  paperOnly:         true  as const,
  realTradingLocked: true  as const,
  tradingExecuted:   0     as const,
};

const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const SEP2 = '────────────────────────────────────────────────────────────────';

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: T[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as T); } catch { /* skip */ }
  }
  return rows;
}

function inc(obj: Record<string, number>, key: string): void {
  obj[key] = (obj[key] ?? 0) + 1;
}

// ── Main function ──────────────────────────────────────────────────────────────
export function runTargetProfileReviewLedgerReport(
  options: ReviewLedgerReportOptions = {},
): ReviewLedgerReportResult {
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const rows       = readJsonl<LedgerRow>(ledgerPath);

  const uniqueContracts     = new Set(rows.map(r => r.contract).filter(Boolean)).size;
  const byCycleId:           Record<string, number> = {};
  const bySymbol:            Record<string, number> = {};
  const outcomeStatusCounts: Record<string, number> = {};
  const targetProfileCounts: Record<string, number> = {};

  for (const r of rows) {
    if (r.cycleId)        inc(byCycleId,           r.cycleId);
    if (r.symbol)         inc(bySymbol,             r.symbol);
    if (r.outcomeStatus)  inc(outcomeStatusCounts,  r.outcomeStatus);
    if (r.targetProfileId) inc(targetProfileCounts, r.targetProfileId);
  }

  // Latest N by reviewedAt descending
  const latestCandidates = [...rows]
    .sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? ''))
    .slice(0, LATEST_N);

  return {
    ledgerPath,
    totalReviewed:    rows.length,
    uniqueContracts,
    byCycleId,
    bySymbol,
    outcomeStatusCounts,
    targetProfileCounts,
    latestCandidates,
    ...SAFETY,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────────
export function renderTargetProfileReviewLedgerReport(
  result: ReviewLedgerReportResult,
): string {
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — TARGET PROFILE REVIEW LEDGER REPORT v1');
  L.push('  [REPORT ONLY — NO TRADES — NO WALLET — READ ONLY]');
  L.push(SEP, '');

  // Overview
  L.push(`  ${SEP2}`);
  L.push('  OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Ledger path       : ${result.ledgerPath}`);
  L.push(`  Total reviewed    : ${result.totalReviewed}`);
  L.push(`  Unique contracts  : ${result.uniqueContracts}`);
  L.push('');

  // Target profile breakdown
  if (Object.keys(result.targetProfileCounts).length > 0) {
    L.push('  By target profile:');
    for (const [prof, n] of Object.entries(result.targetProfileCounts).sort()) {
      L.push(`    ${prof.padEnd(40)}: ${n}`);
    }
    L.push('');
  }

  // Outcome status counts
  L.push('  Outcome status:');
  if (Object.keys(result.outcomeStatusCounts).length === 0) {
    L.push('    (none yet)');
  } else {
    for (const [st, n] of Object.entries(result.outcomeStatusCounts).sort()) {
      L.push(`    ${st.padEnd(20)}: ${n}`);
    }
  }
  L.push('');

  // By cycle
  if (Object.keys(result.byCycleId).length > 0) {
    L.push(`  ${SEP2}`);
    L.push('  BY CYCLE');
    L.push(`  ${SEP2}`, '');
    for (const [cycleId, n] of Object.entries(result.byCycleId).sort().reverse()) {
      L.push(`    ${cycleId.padEnd(36)}: ${n}`);
    }
    L.push('');
  }

  // By symbol
  if (Object.keys(result.bySymbol).length > 0) {
    L.push(`  ${SEP2}`);
    L.push('  BY SYMBOL');
    L.push(`  ${SEP2}`, '');
    const sorted = Object.entries(result.bySymbol).sort(([, a], [, b]) => b - a);
    for (const [sym, n] of sorted) {
      L.push(`    ${sym.padEnd(20)}: ${n}`);
    }
    L.push('');
  }

  // Latest candidates
  L.push(`  ${SEP2}`);
  L.push(`  LATEST REVIEWED (up to ${LATEST_N})`);
  L.push(`  ${SEP2}`, '');
  if (result.latestCandidates.length === 0) {
    L.push('  (ledger is empty — run with --write-ledger to record exact matches)');
  } else {
    for (const r of result.latestCandidates) {
      const sym     = r.symbol ?? r.contract?.slice(0, 8) ?? '?';
      const liq     = r.liquidityUsd != null ? '$' + r.liquidityUsd.toFixed(0) : 'n/a';
      const bms     = r.bubbleMapsScore != null ? `  bms=${r.bubbleMapsScore}` : '';
      const outcome = r.outcomeStatus ?? 'UNKNOWN';
      L.push(`  ${sym.padEnd(14)}  ${r.cycleId ?? '?'}`);
      L.push(`    contract=${r.contract ?? '?'}  liq=${liq}  ${r.liquidityBucket ?? '?'}  ${r.vlrBucket ?? '?'}${bms}`);
      L.push(`    reviewedAt=${r.reviewedAt ?? '?'}  outcome=${outcome}`);
      L.push('');
    }
  }

  // Safety footer
  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true  READ_ONLY=true  NO_POLICY_CHANGE=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING  tradingExecuted=0  realTradingLocked=true');
  L.push('  paperOnly=true  reportOnly=true');
  L.push('  No gate, autopilot, policy, wallet, or trade logic modified.');
  L.push(SEP, '');

  return L.join('\n');
}
