import * as fs from 'fs';

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_LEDGER_PATH = 'data/token-grab/ripper/target-profile-review-ledger.jsonl';

// ── Types ──────────────────────────────────────────────────────────────────────
export type UniqueStatsRecommendation =
  | 'KEEP_COLLECTING'
  | 'REJECT_IF_UNIQUE_FLATDUMP_GT_60'
  | 'PROMISING_ONLY_IF_UNIQUE_WIN5_GT_50_AND_UNIQUE_N>=20';

interface LedgerRow {
  contract?:     string;
  symbol?:       string | null;
  cycleId?:      string;
  capturedAt?:   string;
  reviewedAt?:   string;
  outcomeStatus?: string;
  outcomeLabel?: string | null;
}

export interface UniqueContractSummary {
  contract:       string;
  symbol:         string | null;
  rowCount:       number;
  cycleIds:       string[];
  outcomeLabels:  string[];
  deducedOutcome: 'BIG_WINNER' | 'FLAT_JUNK_OR_DUMP' | 'UNKNOWN';
}

export interface LedgerUniqueStatsResult {
  ledgerPath:             string;
  totalReviewedRows:      number;
  uniqueContractCount:    number;
  repeatedContractCount:  number;
  duplicateExposureCount: number;

  // Row-level (all rows, counting duplicates)
  rowLevelObservedCount:  number;
  rowLevelWin5Count:      number;
  rowLevelWin5Rate:       number;
  rowLevelFlatDumpCount:  number;
  rowLevelFlatDumpRate:   number;

  // Unique-contract level (one outcome per contract)
  uniqueObservedCount:    number;
  uniqueWin5Count:        number;
  uniqueWin5Rate:         number;
  uniqueFlatDumpCount:    number;
  uniqueFlatDumpRate:     number;
  uniqueUnknownCount:     number;

  repeatedContracts:      UniqueContractSummary[];
  recommendation:         UniqueStatsRecommendation;

  reportOnly:             true;
  readOnly:               true;
  paperOnly:              true;
  realTradingLocked:      true;
  tradingExecuted:        0;
}

export interface LedgerUniqueStatsOptions {
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

function pct(rate: number): string {
  return (rate * 100).toFixed(1) + '%';
}

// For a set of rows for the same contract, derive a single canonical outcome.
// BIG_WINNER if any row is BIG_WINNER; FLAT_JUNK_OR_DUMP if any is FLAT_JUNK/DUMP; else UNKNOWN.
function deduceOutcome(
  rows: LedgerRow[],
): 'BIG_WINNER' | 'FLAT_JUNK_OR_DUMP' | 'UNKNOWN' {
  const labels = rows.map(r => r.outcomeLabel).filter(Boolean) as string[];
  if (labels.includes('BIG_WINNER'))                       return 'BIG_WINNER';
  if (labels.some(l => l === 'FLAT_JUNK' || l === 'DUMP')) return 'FLAT_JUNK_OR_DUMP';
  return 'UNKNOWN';
}

// ── Main function ──────────────────────────────────────────────────────────────
export function runLedgerUniqueStats(
  options: LedgerUniqueStatsOptions = {},
): LedgerUniqueStatsResult {
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const rows       = readJsonl<LedgerRow>(ledgerPath);

  // Group by contract
  const byContract = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    if (!row.contract) continue;
    if (!byContract.has(row.contract)) byContract.set(row.contract, []);
    byContract.get(row.contract)!.push(row);
  }

  const uniqueContractCount    = byContract.size;
  const repeatedContractCount  = [...byContract.values()].filter(rs => rs.length > 1).length;
  const duplicateExposureCount = rows.length - uniqueContractCount;

  // Row-level stats (counting every row, including duplicates)
  let rowLevelObservedCount  = 0;
  let rowLevelWin5Count      = 0;
  let rowLevelFlatDumpCount  = 0;

  for (const row of rows) {
    if (row.outcomeStatus !== 'OBSERVED') continue;
    rowLevelObservedCount++;
    if (row.outcomeLabel === 'BIG_WINNER')                                  rowLevelWin5Count++;
    if (row.outcomeLabel === 'FLAT_JUNK' || row.outcomeLabel === 'DUMP')    rowLevelFlatDumpCount++;
  }

  // Unique-contract level stats
  const summaries: UniqueContractSummary[] = [];
  let uniqueObservedCount  = 0;
  let uniqueWin5Count      = 0;
  let uniqueFlatDumpCount  = 0;
  let uniqueUnknownCount   = 0;

  for (const [contract, contractRows] of byContract) {
    const symbol        = contractRows[0]?.symbol ?? null;
    const cycleIds      = [...new Set(contractRows.map(r => r.cycleId).filter(Boolean) as string[])];
    const outcomeLabels = [...new Set(contractRows.map(r => r.outcomeLabel).filter(Boolean) as string[])];
    const deducedOutcome = deduceOutcome(contractRows);
    const hasObserved   = contractRows.some(r => r.outcomeStatus === 'OBSERVED');

    if (hasObserved) {
      uniqueObservedCount++;
      if (deducedOutcome === 'BIG_WINNER')        uniqueWin5Count++;
      if (deducedOutcome === 'FLAT_JUNK_OR_DUMP') uniqueFlatDumpCount++;
    } else {
      uniqueUnknownCount++;
    }

    summaries.push({ contract, symbol, rowCount: contractRows.length, cycleIds, outcomeLabels, deducedOutcome });
  }

  const rowLevelWin5Rate    = rowLevelObservedCount > 0 ? rowLevelWin5Count    / rowLevelObservedCount : 0;
  const rowLevelFlatDumpRate= rowLevelObservedCount > 0 ? rowLevelFlatDumpCount/ rowLevelObservedCount : 0;
  const uniqueWin5Rate      = uniqueObservedCount   > 0 ? uniqueWin5Count      / uniqueObservedCount   : 0;
  const uniqueFlatDumpRate  = uniqueObservedCount   > 0 ? uniqueFlatDumpCount  / uniqueObservedCount   : 0;

  const repeatedContracts = summaries.filter(s => s.rowCount > 1);

  // Recommendation
  let recommendation: UniqueStatsRecommendation;
  if (uniqueFlatDumpRate > 0.60) {
    recommendation = 'REJECT_IF_UNIQUE_FLATDUMP_GT_60';
  } else if (uniqueWin5Rate > 0.50 && uniqueObservedCount >= 20) {
    recommendation = 'PROMISING_ONLY_IF_UNIQUE_WIN5_GT_50_AND_UNIQUE_N>=20';
  } else {
    recommendation = 'KEEP_COLLECTING';
  }

  return {
    ledgerPath,
    totalReviewedRows:     rows.length,
    uniqueContractCount,
    repeatedContractCount,
    duplicateExposureCount,
    rowLevelObservedCount,
    rowLevelWin5Count,
    rowLevelWin5Rate,
    rowLevelFlatDumpCount,
    rowLevelFlatDumpRate,
    uniqueObservedCount,
    uniqueWin5Count,
    uniqueWin5Rate,
    uniqueFlatDumpCount,
    uniqueFlatDumpRate,
    uniqueUnknownCount,
    repeatedContracts,
    recommendation,
    ...SAFETY,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────────
export function renderLedgerUniqueStats(result: LedgerUniqueStatsResult): string {
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — TARGET PROFILE LEDGER UNIQUE OUTCOME STATS v1');
  L.push('  [REPORT ONLY — NO TRADES — NO WALLET — READ ONLY]');
  L.push(SEP, '');

  // Overview
  L.push(`  ${SEP2}`);
  L.push('  OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Ledger path              : ${result.ledgerPath}`);
  L.push(`  Total reviewed rows      : ${result.totalReviewedRows}`);
  L.push(`  Unique contracts         : ${result.uniqueContractCount}`);
  L.push(`  Repeated contract count  : ${result.repeatedContractCount}`);
  L.push(`  Duplicate exposure count : ${result.duplicateExposureCount}`);
  L.push('');

  // Row-level stats
  L.push(`  ${SEP2}`);
  L.push('  ROW-LEVEL WIN5 / FLAT-DUMP  (all rows, duplicates counted)');
  L.push(`  ${SEP2}`, '');
  L.push(`  Observed rows    : ${result.rowLevelObservedCount}`);
  L.push(`  win5             : ${result.rowLevelWin5Count} / ${result.rowLevelObservedCount}  =  ${pct(result.rowLevelWin5Rate)}`);
  L.push(`  flatDump         : ${result.rowLevelFlatDumpCount} / ${result.rowLevelObservedCount}  =  ${pct(result.rowLevelFlatDumpRate)}`);
  L.push('');

  // Unique-contract stats
  L.push(`  ${SEP2}`);
  L.push('  UNIQUE-CONTRACT WIN5 / FLAT-DUMP  (one outcome per contract)');
  L.push(`  ${SEP2}`, '');
  L.push(`  Unique observed  : ${result.uniqueObservedCount}`);
  L.push(`  Unique UNKNOWN   : ${result.uniqueUnknownCount}`);
  L.push(`  win5             : ${result.uniqueWin5Count} / ${result.uniqueObservedCount}  =  ${pct(result.uniqueWin5Rate)}`);
  L.push(`  flatDump         : ${result.uniqueFlatDumpCount} / ${result.uniqueObservedCount}  =  ${pct(result.uniqueFlatDumpRate)}`);
  L.push('');

  // Repeated contracts
  if (result.repeatedContracts.length > 0) {
    L.push(`  ${SEP2}`);
    L.push('  CONTRACTS REPEATED ACROSS CYCLES');
    L.push(`  ${SEP2}`, '');
    for (const c of result.repeatedContracts) {
      const sym = c.symbol ?? c.contract.slice(0, 8);
      L.push(`  ${sym.padEnd(14)}  rows=${c.rowCount}  outcome=${c.deducedOutcome}`);
      L.push(`    contract : ${c.contract}`);
      L.push(`    cycles   : ${c.cycleIds.join(', ')}`);
      L.push(`    labels   : ${c.outcomeLabels.join(', ') || '(none observed)'}`);
      L.push('');
    }
  } else {
    L.push(`  No repeated contracts (all ${result.uniqueContractCount} are unique across cycles).`);
    L.push('');
  }

  // Recommendation
  L.push(`  ${SEP2}`);
  L.push('  RECOMMENDATION');
  L.push(`  ${SEP2}`, '');
  L.push(`  ${result.recommendation}`);
  L.push('');
  if (result.recommendation === 'REJECT_IF_UNIQUE_FLATDUMP_GT_60') {
    L.push(`  Unique flatDump rate ${pct(result.uniqueFlatDumpRate)} exceeds 60% threshold.`);
    L.push('  Majority of unique target-profile contracts are junk/dumps.');
    L.push('  Continue paper collection but do not scale this profile without further review.');
  } else if (result.recommendation === 'PROMISING_ONLY_IF_UNIQUE_WIN5_GT_50_AND_UNIQUE_N>=20') {
    L.push(`  Unique win5 rate ${pct(result.uniqueWin5Rate)} (N=${result.uniqueObservedCount} >= 20).`);
    L.push('  More than half of unique contracts in this profile are BIG_WINNER.');
    L.push('  Profile shows signal — escalate to deeper paper review.');
  } else {
    L.push(`  Unique observed N=${result.uniqueObservedCount} (need >= 20 with win5 > 50% for PROMISING).`);
    L.push('  Continue collecting. No action yet.');
  }
  L.push('');

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
