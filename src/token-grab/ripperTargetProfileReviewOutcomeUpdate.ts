import * as fs from 'fs';

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_LEDGER_PATH = 'data/token-grab/ripper/target-profile-review-ledger.jsonl';
const DEFAULT_MEMORY_PATH = 'data/token-grab/ripper/learning-memory.jsonl';

// ── Types ──────────────────────────────────────────────────────────────────────
type MatchQuality = 'CONTRACT_AND_TIME' | 'CONTRACT_ONLY_FALLBACK';

// LedgerRow uses index signature so we can spread-preserve all original fields
interface LedgerRow {
  reviewId:       string;
  contract:       string;
  symbol?:        string | null;
  capturedAt:     string;
  outcomeStatus:  string;
  [key: string]:  unknown;
}

interface MemoryRow {
  contract?:      string | null;
  cycleId?:       string | null;
  capturedAt?:    string | null;
  observedAt?:    string | null;
  outcomeLabel?:  string | null;
  priceChangePct?: number | null;
  outcomeSource?: string | null;
  gateDecision?:  string | null;
}

export interface UpdatedCandidate {
  reviewId:           string;
  contract:           string;
  symbol:             string | null;
  priorOutcomeStatus: string;
  newOutcomeStatus:   'OBSERVED';
  outcomeLabel:       string;
  priceChangePct:     number | null;
  observedAt:         string | null;
  matchQuality:       MatchQuality;
}

export interface OutcomeUpdateResult {
  ledgerPath:         string;
  memoryPath:         string;
  ledgerRowsRead:     number;
  memoryRowsRead:     number;
  unknownBefore:      number;
  matchedOutcomes:    number;
  updatedRows:        number;
  stillUnknown:       number;
  dryRun:             boolean;
  writeEnabled:       boolean;
  outcomeLabelCounts: Record<string, number>;
  updatedCandidates:  UpdatedCandidate[];
  reportOnly:         true;
  readOnly:           true;
  paperOnly:          true;
  realTradingLocked:  true;
  tradingExecuted:    0;
}

export interface OutcomeUpdateOptions {
  ledgerPath?: string;
  memoryPath?: string;
  write?:      boolean;
  updatedAt?:  string;  // injectable for tests; defaults to new Date().toISOString()
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

function findBestMatch(
  contract: string,
  ledgerCapturedAt: string,
  memByContract: Map<string, MemoryRow[]>,
): { memory: MemoryRow; matchQuality: MatchQuality } | null {
  const allForContract = memByContract.get(contract) ?? [];
  const observed = allForContract.filter(
    m => m.outcomeLabel && m.outcomeLabel !== 'UNKNOWN',
  );
  if (observed.length === 0) return null;

  // Rows where capturedAt >= ledger capturedAt (chronologically consistent)
  const afterRows = observed.filter(m => (m.capturedAt ?? '') >= ledgerCapturedAt);

  if (afterRows.length > 0) {
    // Pick earliest observedAt (or capturedAt fallback) among qualifying rows
    const sorted = [...afterRows].sort((a, b) => {
      const ta = a.observedAt ?? a.capturedAt ?? '';
      const tb = b.observedAt ?? b.capturedAt ?? '';
      return ta.localeCompare(tb);
    });
    return { memory: sorted[0]!, matchQuality: 'CONTRACT_AND_TIME' };
  }

  // Fallback: latest available memory row (before ledger capturedAt)
  const sorted = [...observed].sort((a, b) =>
    (b.capturedAt ?? '').localeCompare(a.capturedAt ?? ''),
  );
  return { memory: sorted[0]!, matchQuality: 'CONTRACT_ONLY_FALLBACK' };
}

// ── Main function ──────────────────────────────────────────────────────────────
export function runTargetProfileReviewOutcomeUpdate(
  options: OutcomeUpdateOptions = {},
): OutcomeUpdateResult {
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const memoryPath = options.memoryPath ?? DEFAULT_MEMORY_PATH;
  const write      = options.write      ?? false;
  const updatedAt  = options.updatedAt  ?? new Date().toISOString();

  const ledgerRows = readJsonl<LedgerRow>(ledgerPath);
  const memoryRows = readJsonl<MemoryRow>(memoryPath);

  // Index memory by contract
  const memByContract = new Map<string, MemoryRow[]>();
  for (const m of memoryRows) {
    if (!m.contract) continue;
    if (!memByContract.has(m.contract)) memByContract.set(m.contract, []);
    memByContract.get(m.contract)!.push(m);
  }

  const unknownBefore      = ledgerRows.filter(r => r.outcomeStatus === 'UNKNOWN').length;
  const updatedCandidates: UpdatedCandidate[]      = [];
  const outcomeLabelCounts: Record<string, number> = {};
  const outputRows: LedgerRow[]                    = [];

  for (const row of ledgerRows) {
    if (row.outcomeStatus !== 'UNKNOWN') {
      outputRows.push(row);
      continue;
    }

    const match = findBestMatch(row.contract, row.capturedAt, memByContract);
    if (!match) {
      outputRows.push(row);
      continue;
    }

    const { memory, matchQuality } = match;
    const outcomeLabel  = memory.outcomeLabel!;
    const priceChangePct = memory.priceChangePct ?? null;
    const observedAt    = memory.observedAt ?? null;

    outcomeLabelCounts[outcomeLabel] = (outcomeLabelCounts[outcomeLabel] ?? 0) + 1;
    updatedCandidates.push({
      reviewId:           row.reviewId,
      contract:           row.contract,
      symbol:             (row.symbol as string | null) ?? null,
      priorOutcomeStatus: 'UNKNOWN',
      newOutcomeStatus:   'OBSERVED',
      outcomeLabel,
      priceChangePct,
      observedAt,
      matchQuality,
    });

    outputRows.push({
      ...row,
      outcomeStatus:      'OBSERVED',
      outcomeLabel,
      priceChangePct,
      observedAt,
      outcomeSource:      memory.outcomeSource   ?? null,
      memoryCycleId:      memory.cycleId         ?? null,
      memoryCapturedAt:   memory.capturedAt       ?? null,
      memoryGateDecision: memory.gateDecision     ?? null,
      matchQuality,
      updatedAt,
    });
  }

  const matchedOutcomes = updatedCandidates.length;
  const stillUnknown    = unknownBefore - matchedOutcomes;

  if (write && matchedOutcomes > 0) {
    fs.writeFileSync(
      ledgerPath,
      outputRows.map(r => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
  }

  return {
    ledgerPath,
    memoryPath,
    ledgerRowsRead:    ledgerRows.length,
    memoryRowsRead:    memoryRows.length,
    unknownBefore,
    matchedOutcomes,
    updatedRows:       write ? matchedOutcomes : 0,
    stillUnknown,
    dryRun:            !write,
    writeEnabled:      write,
    outcomeLabelCounts,
    updatedCandidates,
    ...SAFETY,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────────
export function renderTargetProfileReviewOutcomeUpdate(
  result: OutcomeUpdateResult,
): string {
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — TARGET PROFILE REVIEW OUTCOME UPDATE v1');
  L.push('  [PAPER ONLY — NO WALLET — NO REAL TRADING — READ ONLY for market data]');
  L.push(SEP, '');

  // Overview
  L.push(`  ${SEP2}`);
  L.push('  OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Ledger path      : ${result.ledgerPath}`);
  L.push(`  Memory path      : ${result.memoryPath}`);
  L.push(`  Ledger rows read : ${result.ledgerRowsRead}`);
  L.push(`  Memory rows read : ${result.memoryRowsRead}`);
  L.push(`  UNKNOWN before   : ${result.unknownBefore}`);
  L.push(`  Matched outcomes : ${result.matchedOutcomes}`);
  L.push(`  Updated rows     : ${result.updatedRows}${result.dryRun ? '  (dry-run — pass --write to apply)' : ''}`);
  L.push(`  Still unknown    : ${result.stillUnknown}`);
  L.push(`  Mode             : ${result.dryRun ? 'DRY-RUN (read-only preview)' : 'WRITE ENABLED'}`);
  L.push('');

  // Outcome label counts
  if (Object.keys(result.outcomeLabelCounts).length > 0) {
    L.push('  Outcome label counts (matched):');
    for (const [label, n] of Object.entries(result.outcomeLabelCounts).sort()) {
      L.push(`    ${label.padEnd(16)}: ${n}`);
    }
    L.push('');
  }

  // Updated candidates
  L.push(`  ${SEP2}`);
  L.push(`  ${result.dryRun ? 'WOULD UPDATE' : 'UPDATED'} CANDIDATES`);
  L.push(`  ${SEP2}`, '');
  if (result.updatedCandidates.length === 0) {
    L.push('  (no matches found — all rows remain UNKNOWN)');
  } else {
    for (const c of result.updatedCandidates) {
      const sym = c.symbol ?? c.contract.slice(0, 8);
      L.push(`  ${sym.padEnd(14)}  ${c.outcomeLabel}  (${c.matchQuality})`);
      L.push(`    contract     : ${c.contract}`);
      L.push(`    UNKNOWN → OBSERVED`);
      if (c.priceChangePct != null) L.push(`    priceChangePct: ${c.priceChangePct.toFixed(4)}%`);
      if (c.observedAt)            L.push(`    observedAt    : ${c.observedAt}`);
      L.push('');
    }
  }

  // Safety footer
  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  PAPER_ONLY=true  NO_REAL_TRADING  NO_WALLET  NO_POLICY_CHANGE');
  L.push('  DO_NOT_MUTATE_LEARNING_MEMORY  tradingExecuted=0  realTradingLocked=true');
  L.push(`  Ledger mutated: ${result.writeEnabled && result.updatedRows > 0 ? 'YES (--write passed)' : 'NO'}`);
  L.push(SEP, '');

  return L.join('\n');
}
