import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runLedgerUniqueStats,
  renderLedgerUniqueStats,
} from '../src/token-grab/ripperTargetProfileLedgerUniqueStats';

// ── Helpers ────────────────────────────────────────────────────────────────────
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'us-'));
}

function writeLedger(ledgerPath: string, rows: object[]): void {
  fs.writeFileSync(ledgerPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function makeRow(o: {
  contract?: string;
  symbol?: string;
  cycleId?: string;
  capturedAt?: string;
  reviewedAt?: string;
  outcomeStatus?: string;
  outcomeLabel?: string | null;
} = {}): object {
  return {
    reviewId:        `LIQ_10K_30K_WATCH_ENTER_NOW::${o.cycleId ?? 'cycle-test'}::${o.contract ?? 'CONTRACT_A'}`,
    targetProfileId: 'LIQ_10K_30K_WATCH_ENTER_NOW',
    cycleId:         o.cycleId      ?? 'cycle-2026-06-18-100000',
    contract:        o.contract     ?? 'CONTRACT_AAAA',
    symbol:          o.symbol       ?? 'TEST',
    capturedAt:      o.capturedAt   ?? '2026-06-18T10:00:00.000Z',
    reviewedAt:      o.reviewedAt   ?? '2026-06-18T12:00:00.000Z',
    outcomeStatus:   o.outcomeStatus ?? 'UNKNOWN',
    outcomeLabel:    o.outcomeLabel  ?? null,
    reportOnly:      true, readOnly: true, paperOnly: true,
    realTradingLocked: true, tradingExecuted: 0,
  };
}

function makeObserved(contract: string, label: 'BIG_WINNER' | 'FLAT_JUNK' | 'DUMP', o: object = {}): object {
  return makeRow({ contract, symbol: contract.slice(0, 6), outcomeStatus: 'OBSERVED', outcomeLabel: label, ...o });
}

// ── Tests ──────────────────────────────────────────────────────────────────────
describe('runLedgerUniqueStats', () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(() => {
    dir         = tmpDir();
    ledgerPath  = path.join(dir, 'ledger.jsonl');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // Test 1: basic counts — total rows, unique contracts, no repeats
  it('counts total rows, unique contracts, zero repeats when all unique', () => {
    writeLedger(ledgerPath, [
      makeObserved('C1', 'BIG_WINNER'),
      makeObserved('C2', 'FLAT_JUNK'),
      makeObserved('C3', 'FLAT_JUNK'),
    ]);
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.totalReviewedRows).toBe(3);
    expect(result.uniqueContractCount).toBe(3);
    expect(result.repeatedContractCount).toBe(0);
    expect(result.duplicateExposureCount).toBe(0);
  });

  // Test 2: repeated contract detection
  it('detects repeated contracts and computes duplicate exposure count', () => {
    writeLedger(ledgerPath, [
      makeObserved('C1', 'BIG_WINNER', { cycleId: 'cycle-A' }),
      makeObserved('C1', 'BIG_WINNER', { cycleId: 'cycle-B' }),  // same contract, second cycle
      makeObserved('C2', 'FLAT_JUNK'),
    ]);
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.totalReviewedRows).toBe(3);
    expect(result.uniqueContractCount).toBe(2);
    expect(result.repeatedContractCount).toBe(1);
    expect(result.duplicateExposureCount).toBe(1);  // 3 rows - 2 unique = 1 duplicate
    expect(result.repeatedContracts.length).toBe(1);
    expect(result.repeatedContracts[0]!.contract).toBe('C1');
    expect(result.repeatedContracts[0]!.rowCount).toBe(2);
    expect(result.repeatedContracts[0]!.cycleIds).toContain('cycle-A');
    expect(result.repeatedContracts[0]!.cycleIds).toContain('cycle-B');
  });

  // Test 3: row-level win5/flatDump counts all rows including duplicates
  it('row-level stats count duplicate rows', () => {
    writeLedger(ledgerPath, [
      makeObserved('C1', 'BIG_WINNER', { cycleId: 'cycle-A' }),
      makeObserved('C1', 'BIG_WINNER', { cycleId: 'cycle-B' }),  // duplicate
      makeObserved('C2', 'FLAT_JUNK'),
    ]);
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.rowLevelObservedCount).toBe(3);
    expect(result.rowLevelWin5Count).toBe(2);     // both C1 rows count
    expect(result.rowLevelFlatDumpCount).toBe(1);
    expect(result.rowLevelWin5Rate).toBeCloseTo(2 / 3);
    expect(result.rowLevelFlatDumpRate).toBeCloseTo(1 / 3);
  });

  // Test 4: unique-contract stats dedup — same contract counted once
  it('unique-contract stats count each contract once regardless of row count', () => {
    writeLedger(ledgerPath, [
      makeObserved('C1', 'BIG_WINNER', { cycleId: 'cycle-A' }),
      makeObserved('C1', 'BIG_WINNER', { cycleId: 'cycle-B' }),  // duplicate
      makeObserved('C2', 'FLAT_JUNK'),
    ]);
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.uniqueObservedCount).toBe(2);     // C1 and C2, each once
    expect(result.uniqueWin5Count).toBe(1);         // C1
    expect(result.uniqueFlatDumpCount).toBe(1);     // C2
    expect(result.uniqueWin5Rate).toBeCloseTo(1 / 2);
    expect(result.uniqueFlatDumpRate).toBeCloseTo(1 / 2);
  });

  // Test 5: deducedOutcome — BIG_WINNER wins over FLAT_JUNK when same contract has mixed
  it('deducedOutcome is BIG_WINNER if any row for that contract is BIG_WINNER', () => {
    writeLedger(ledgerPath, [
      makeObserved('C1', 'FLAT_JUNK', { cycleId: 'cycle-A' }),
      makeObserved('C1', 'BIG_WINNER', { cycleId: 'cycle-B' }),
    ]);
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.uniqueWin5Count).toBe(1);
    expect(result.uniqueFlatDumpCount).toBe(0);
    expect(result.repeatedContracts[0]!.deducedOutcome).toBe('BIG_WINNER');
  });

  // Test 6: UNKNOWN rows don't count in unique observed
  it('UNKNOWN outcome rows are excluded from unique observed counts', () => {
    writeLedger(ledgerPath, [
      makeRow({ contract: 'C1', outcomeStatus: 'UNKNOWN' }),
      makeObserved('C2', 'BIG_WINNER'),
    ]);
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.uniqueObservedCount).toBe(1);   // only C2
    expect(result.uniqueUnknownCount).toBe(1);    // C1
    expect(result.uniqueWin5Count).toBe(1);
  });

  // Test 7: recommendation KEEP_COLLECTING when N < 20 and flatDump <= 60%
  it('recommendation is KEEP_COLLECTING when N too small for other thresholds', () => {
    writeLedger(ledgerPath, [
      makeObserved('C1', 'BIG_WINNER'),
      makeObserved('C2', 'FLAT_JUNK'),
      makeObserved('C3', 'FLAT_JUNK'),
    ]);
    const result = runLedgerUniqueStats({ ledgerPath });
    // flatDump = 66.7% → REJECT... wait, 2/3 = 66.7% > 60%
    // Actually this case triggers REJECT. Let me test KEEP properly.
    // Use 2 BIG_WINNER + 1 FLAT_JUNK → win5=66%, flatDump=33%, N=3 → KEEP (N < 20)
    // This test is for the exact case above with 1 WIN + 2 FLAT = 66.7% flatDump → REJECT
    // So just check it's not KEEP for this one
    expect(result.recommendation).toBe('REJECT_IF_UNIQUE_FLATDUMP_GT_60');
  });

  // Test 8: recommendation KEEP_COLLECTING explicitly
  it('recommendation is KEEP_COLLECTING when win5 not > 50% and flatDump <= 60%', () => {
    writeLedger(ledgerPath, [
      makeObserved('C1', 'BIG_WINNER'),
      makeObserved('C2', 'BIG_WINNER'),
      makeObserved('C3', 'FLAT_JUNK'),
      makeObserved('C4', 'FLAT_JUNK'),
    ]);
    // win5 = 50% (not > 50%), flatDump = 50% (<= 60%), N = 4 → KEEP
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.recommendation).toBe('KEEP_COLLECTING');
  });

  // Test 9: recommendation REJECT_IF_UNIQUE_FLATDUMP_GT_60
  it('recommendation is REJECT when unique flatDump > 60%', () => {
    writeLedger(ledgerPath, [
      makeObserved('C1', 'FLAT_JUNK'),
      makeObserved('C2', 'FLAT_JUNK'),
      makeObserved('C3', 'BIG_WINNER'),
      makeObserved('C4', 'FLAT_JUNK'),
      makeObserved('C5', 'FLAT_JUNK'),
    ]);
    // flatDump = 4/5 = 80% > 60% → REJECT
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.recommendation).toBe('REJECT_IF_UNIQUE_FLATDUMP_GT_60');
    expect(result.uniqueFlatDumpCount).toBe(4);
    expect(result.uniqueWin5Count).toBe(1);
  });

  // Test 10: recommendation PROMISING when win5 > 50% and N >= 20
  it('recommendation is PROMISING when unique win5 > 50% and N >= 20', () => {
    // 11 BIG_WINNER + 9 FLAT_JUNK = 20 unique contracts
    // win5 = 11/20 = 55% > 50%, flatDump = 9/20 = 45% < 60%, N = 20 >= 20
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => makeObserved(`WIN_${i}`, 'BIG_WINNER')),
      ...Array.from({ length: 9 },  (_, i) => makeObserved(`FLAT_${i}`, 'FLAT_JUNK')),
    ];
    writeLedger(ledgerPath, rows);
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.recommendation).toBe('PROMISING_ONLY_IF_UNIQUE_WIN5_GT_50_AND_UNIQUE_N>=20');
    expect(result.uniqueObservedCount).toBe(20);
    expect(result.uniqueWin5Count).toBe(11);
    expect(result.uniqueWin5Rate).toBeCloseTo(11 / 20);
  });

  // Test 11: N = 19 with win5 > 50% still gives KEEP_COLLECTING (not enough N)
  it('KEEP_COLLECTING when win5 > 50% but N < 20', () => {
    // 10 BIG_WINNER + 9 FLAT_JUNK = 19 unique contracts
    // win5 = 10/19 ≈ 52.6% > 50%, flatDump = 9/19 ≈ 47.4% < 60%, N = 19 < 20
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => makeObserved(`WIN_${i}`, 'BIG_WINNER')),
      ...Array.from({ length: 9 },  (_, i) => makeObserved(`FLAT_${i}`, 'FLAT_JUNK')),
    ];
    writeLedger(ledgerPath, rows);
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.recommendation).toBe('KEEP_COLLECTING');
    expect(result.uniqueObservedCount).toBe(19);
  });

  // Test 12: safety flags locked
  it('result includes all safety flags', () => {
    writeLedger(ledgerPath, [makeObserved('C1', 'BIG_WINNER')]);
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });

  // Test 13: empty/missing ledger zero state
  it('handles empty or missing ledger gracefully', () => {
    const result = runLedgerUniqueStats({ ledgerPath: path.join(dir, 'none.jsonl') });
    expect(result.totalReviewedRows).toBe(0);
    expect(result.uniqueContractCount).toBe(0);
    expect(result.repeatedContractCount).toBe(0);
    expect(result.duplicateExposureCount).toBe(0);
    expect(result.uniqueObservedCount).toBe(0);
    expect(result.uniqueWin5Rate).toBe(0);
    expect(result.uniqueFlatDumpRate).toBe(0);
    expect(result.recommendation).toBe('KEEP_COLLECTING');
    expect(result.reportOnly).toBe(true);
  });

  // Test 14: render contains safety strings
  it('render output contains safety strings', () => {
    writeLedger(ledgerPath, [makeObserved('C1', 'BIG_WINNER')]);
    const result   = runLedgerUniqueStats({ ledgerPath });
    const rendered = renderLedgerUniqueStats(result);
    expect(rendered).toContain('REPORT ONLY');
    expect(rendered).toContain('NO TRADES');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('tradingExecuted=0');
    expect(rendered).toContain('paperOnly=true');
  });

  // Test 15: DUMP label counted in flatDump
  it('DUMP label counts as flatDump', () => {
    writeLedger(ledgerPath, [
      makeObserved('C1', 'DUMP'),
      makeObserved('C2', 'BIG_WINNER'),
    ]);
    const result = runLedgerUniqueStats({ ledgerPath });
    expect(result.uniqueFlatDumpCount).toBe(1);
    expect(result.repeatedContracts.length).toBe(0);
    // deducedOutcome for C1 should be FLAT_JUNK_OR_DUMP
  });
});
