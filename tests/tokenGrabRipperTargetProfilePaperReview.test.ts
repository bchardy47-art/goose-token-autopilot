import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runTargetProfilePaperReview,
  renderTargetProfilePaperReview,
} from '../src/token-grab/ripperTargetProfilePaperReview';
import {
  runTargetProfileReviewLedgerReport,
  renderTargetProfileReviewLedgerReport,
} from '../src/token-grab/ripperTargetProfileReviewLedgerReport';

// ── Helpers ────────────────────────────────────────────────────────────────────
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tppr-'));
}

function writeCycle(dir: string, name: string, rows: object[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function readLedger(ledgerPath: string): object[] {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l));
}

function makeCycleRow(o: {
  clusterRisk?: string;
  liquidityUsd?: number | null;
  vlr?: number | null;
  ageMinutes?: number | null;
  symbol?: string;
  contract?: string;
  capturedAt?: string;
  entryDecision?: string;
  gateDecision?: string;
  bubbleMapsScore?: number | null;
  ripperScore?: number | null;
} = {}): object {
  const contract   = o.contract   ?? 'CONTRACT_AAAA1111pump';
  const symbol     = o.symbol     ?? 'TEST';
  const liq        = o.liquidityUsd ?? 15_000;
  const vlr        = o.vlr        ?? 0.3;
  const age        = o.ageMinutes ?? 3;
  const cr         = o.clusterRisk ?? 'WATCH';
  const capturedAt = o.capturedAt ?? '2026-06-18T10:00:00.000Z';

  const clusterNotes = o.bubbleMapsScore != null
    ? [`bubbleMapsScore ${o.bubbleMapsScore}`]
    : [];

  return {
    id:             `dex-watch-run:${contract}:test`,
    capturedAt,
    source:         'dex-watch-run',
    ripperInput: {
      contract, symbol,
      observedAt:          capturedAt,
      priceChangePct:       5,
      liquidityChangePct:   0,
      volumeLiquidityRatio: vlr,
      clusterRisk:          cr,
    },
    normalizedSignal: {
      contract, symbol,
      liquidityUsd:         liq,
      volumeLiquidityRatio: vlr,
      priceChangePct:       5,
    },
    raw: {
      clusterProvider: 'bubblemaps',
      clusterNotes,
    },
    ripperScore:     o.ripperScore ?? 0.82,
    ageMinutes:      age,
    entryDecision:   o.entryDecision ?? 'READY_TO_SNIPE_PAPER',
    buyGateDecision: o.gateDecision  ?? 'BUY_REJECTED',
    blockers:        ['cluster risk WATCH — buy downgraded to review'],
    topReasons:      ['prime window', 'liquidity quality GOOD'],
    warnings:        [],
    realTradingLocked: true,
    paperOnly:       true,
    readOnly:        true,
  };
}

// ── Paper review tests ─────────────────────────────────────────────────────────
describe('runTargetProfilePaperReview', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // Test 1: exact target match (WATCH + LIQ_10K_30K + ENTER_NOW)
  it('classifies WATCH + LIQ_10K_30K + ageMinutes<10 as TARGET_PROFILE_EXACT_MATCH', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.exactMatches).toBe(1);
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_EXACT_MATCH');
    expect(result.candidates[0]!.liquidityBucket).toBe('LIQ_10K_30K');
    expect(result.candidates[0]!.timingPath).toBe('ENTER_NOW');
    expect(result.recommendation).toBe('TARGET_PROFILE_MANUAL_PAPER_REVIEW');
  });

  // Test 2: near miss — correct liq bucket but timing is WAIT_10M (ageMinutes >= 10)
  it('classifies WATCH + LIQ_10K_30K + ageMinutes>=10 as TARGET_PROFILE_NEAR_MISS_WAIT', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 15 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.exactMatches).toBe(0);
    expect(result.nearMisses).toBe(1);
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_NEAR_MISS_WAIT');
    expect(result.candidates[0]!.timingPath).toBe('WAIT_10M');
    expect(result.recommendation).toBe('TARGET_PROFILE_KEEP_WATCHING');
  });

  // Test 3: non-WATCH rows excluded from candidates table
  it('excludes non-WATCH rows from candidates table', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'CLEAN', liquidityUsd: 20_000, ageMinutes: 3 }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, contract: 'CONTRACT_BBBB' }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.totalRowsScanned).toBe(2);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]!.clusterRisk).toBe('WATCH');
  });

  // Test 4: wrong liquidity bucket (WATCH but liq too low) → REJECT_NOT_TARGET
  it('labels WATCH + LIQ_LT_10K as TARGET_PROFILE_REJECT_NOT_TARGET', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 5_000, ageMinutes: 3 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.exactMatches).toBe(0);
    expect(result.nearMisses).toBe(0);
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_REJECT_NOT_TARGET');
    expect(result.recommendation).toBe('TARGET_PROFILE_NO_MATCHES');
  });

  // Test 5: latest cycle file is selected automatically (highest lexicographic filename)
  it('selects the latest cycle file by filename when cycleDir provided', () => {
    writeCycle(dir, 'cycle-2026-06-18-090000.jsonl', [
      makeCycleRow({ clusterRisk: 'CLEAN', contract: 'CONTRACT_OLD' }),
    ]);
    writeCycle(dir, 'cycle-2026-06-18-110000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, contract: 'CONTRACT_NEW' }),
    ]);
    fs.writeFileSync(path.join(dir, 'cycle-2026-06-18-120000-feed.json'), '{}');
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.cycleFile).toBe('cycle-2026-06-18-110000.jsonl');
    expect(result.exactMatches).toBe(1);
  });

  // Test 6: --cycle-file option overrides latest-cycle selection
  it('uses specified --cycle-file path instead of latest', () => {
    const older = writeCycle(dir, 'cycle-2026-06-18-090000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    writeCycle(dir, 'cycle-2026-06-18-110000.jsonl', [
      makeCycleRow({ clusterRisk: 'CLEAN' }),
    ]);
    const result = runTargetProfilePaperReview({ cycleFile: older });
    expect(result.cycleFile).toBe('cycle-2026-06-18-090000.jsonl');
    expect(result.exactMatches).toBe(1);
  });

  // Test 7: safety footer in rendered output
  it('render output contains safety strings', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    const rendered = renderTargetProfilePaperReview(result);
    expect(rendered).toContain('REPORT ONLY');
    expect(rendered).toContain('NO TRADES');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('tradingExecuted=0');
    expect(rendered).toContain('paperOnly=true');
    expect(rendered).toContain('No gate');
  });

  // Test 8: no files are mutated during report (no --write-ledger)
  it('cycle file and no ledger are mutated without --write-ledger', () => {
    const cyclePath  = writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const cycleBefore = fs.readFileSync(cyclePath, 'utf-8');

    runTargetProfilePaperReview({ cycleFile: cyclePath, ledgerPath });

    expect(fs.readFileSync(cyclePath, 'utf-8')).toBe(cycleBefore);
    expect(fs.existsSync(ledgerPath)).toBe(false);  // ledger NOT created without --write-ledger
  });

  // Test 9: exact matches written to ledger when --write-ledger enabled
  it('writes exact matches to ledger when writeLedger=true', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, contract: 'EXACT_AAAA' }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 15, contract: 'NEARMISS_1' }),  // near miss
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 5_000, ageMinutes: 3, contract: 'REJECT_AAA' }),   // reject
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const result = runTargetProfilePaperReview({
      cycleDir: dir,
      writeLedger: true,
      ledgerPath,
      ledgerReviewedAt: '2026-06-18T12:00:00.000Z',
    });

    expect(result.exactMatchesWritten).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.ledgerWriteEnabled).toBe(true);

    const ledgerRows = readLedger(ledgerPath) as Record<string, unknown>[];
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]!['contract']).toBe('EXACT_AAAA');
    expect(ledgerRows[0]!['paperReviewLabel']).toBe('TARGET_PROFILE_EXACT_MATCH');
    expect(ledgerRows[0]!['status']).toBe('REVIEWED_ONLY');
    expect(ledgerRows[0]!['outcomeStatus']).toBe('UNKNOWN');
    expect(ledgerRows[0]!['targetProfileId']).toBe('LIQ_10K_30K_WATCH_ENTER_NOW');
  });

  // Test 10: near misses are NOT written to ledger
  it('near misses are not written to ledger even with writeLedger=true', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 15 }),  // near miss
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const result = runTargetProfilePaperReview({ cycleDir: dir, writeLedger: true, ledgerPath });
    expect(result.exactMatchesWritten).toBe(0);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  // Test 11: rejects are NOT written to ledger
  it('rejects are not written to ledger even with writeLedger=true', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 5_000, ageMinutes: 3 }),  // reject
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const result = runTargetProfilePaperReview({ cycleDir: dir, writeLedger: true, ledgerPath });
    expect(result.exactMatchesWritten).toBe(0);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  // Test 12: dedupe — second run with same cycle skips existing rows
  it('deduplicates by contract+cycleId+capturedAt+targetProfileId', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, contract: 'EXACT_AAAA' }),
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const opts = { cycleDir: dir, writeLedger: true, ledgerPath, ledgerReviewedAt: '2026-06-18T12:00:00.000Z' };

    const r1 = runTargetProfilePaperReview(opts);
    expect(r1.exactMatchesWritten).toBe(1);
    expect(r1.duplicatesSkipped).toBe(0);

    const r2 = runTargetProfilePaperReview(opts);
    expect(r2.exactMatchesWritten).toBe(0);
    expect(r2.duplicatesSkipped).toBe(1);

    const ledgerRows = readLedger(ledgerPath);
    expect(ledgerRows.length).toBe(1);  // only one row despite two runs
  });

  // Test 13: ledger rows contain all required safety flags
  it('ledger rows include safety flags', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3 }),
    ]);
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    runTargetProfilePaperReview({ cycleDir: dir, writeLedger: true, ledgerPath, ledgerReviewedAt: '2026-06-18T12:00:00.000Z' });
    const rows = readLedger(ledgerPath) as Record<string, unknown>[];
    expect(rows[0]!['reportOnly']).toBe(true);
    expect(rows[0]!['readOnly']).toBe(true);
    expect(rows[0]!['paperOnly']).toBe(true);
    expect(rows[0]!['realTradingLocked']).toBe(true);
    expect(rows[0]!['tradingExecuted']).toBe(0);
    expect(rows[0]!['historicalWin5Rate']).toBeCloseTo(0.627);
    expect(rows[0]!['historicalLift']).toBeCloseTo(3.31);
  });

  // Bonus: bubbleMapsScore parsed correctly
  it('parses bubbleMapsScore from raw.clusterNotes', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3, bubbleMapsScore: 80.3 }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.candidates[0]!.bubbleMapsScore).toBeCloseTo(80.3);
  });

  // Bonus: VLR bucket derived correctly
  it('derives vlrBucket from volumeLiquidityRatio', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, vlr: 0.2, ageMinutes: 3 }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, vlr: 1.5, ageMinutes: 3, contract: 'CONTRACT_B2' }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, vlr: 3.0, ageMinutes: 3, contract: 'CONTRACT_C3' }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    const vlrBuckets = result.candidates.map(c => c.vlrBucket);
    expect(vlrBuckets).toContain('VLR_LT_0_5');
    expect(vlrBuckets).toContain('VLR_0_5_TO_2');
    expect(vlrBuckets).toContain('VLR_GTE_2');
  });

  // Bonus: candidates sorted EXACT first, then NEAR_MISS, then REJECT
  it('candidates are sorted EXACT_MATCH first, then NEAR_MISS_WAIT, then REJECT_NOT_TARGET', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', [
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 5_000,  ageMinutes: 3,  contract: 'REJECT111' }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 15, contract: 'NEARMISS1' }),
      makeCycleRow({ clusterRisk: 'WATCH', liquidityUsd: 20_000, ageMinutes: 3,  contract: 'EXACT1111' }),
    ]);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.candidates[0]!.paperReviewLabel).toBe('TARGET_PROFILE_EXACT_MATCH');
    expect(result.candidates[1]!.paperReviewLabel).toBe('TARGET_PROFILE_NEAR_MISS_WAIT');
    expect(result.candidates[2]!.paperReviewLabel).toBe('TARGET_PROFILE_REJECT_NOT_TARGET');
  });

  // Bonus: result safety flags
  it('result includes all safety flags locked', () => {
    writeCycle(dir, 'cycle-2026-06-18-100000.jsonl', []);
    const result = runTargetProfilePaperReview({ cycleDir: dir });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });
});

// ── Ledger report tests ────────────────────────────────────────────────────────
describe('runTargetProfileReviewLedgerReport', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeLedgerRows(ledgerPath: string, rows: object[]): void {
    fs.writeFileSync(ledgerPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  function makeLedgerRow(o: Record<string, unknown> = {}): object {
    return {
      reviewId:           'LIQ_10K_30K_WATCH_ENTER_NOW::cycle-test::CONTRACT_A',
      targetProfileId:    'LIQ_10K_30K_WATCH_ENTER_NOW',
      cycleId:            'cycle-2026-06-18-100000',
      cycleFile:          'cycle-2026-06-18-100000.jsonl',
      contract:           'CONTRACT_AAAA',
      symbol:             'TEST',
      capturedAt:         '2026-06-18T10:00:00.000Z',
      reviewedAt:         '2026-06-18T12:00:00.000Z',
      ageMinutes:         3,
      liquidityUsd:       20_000,
      liquidityBucket:    'LIQ_10K_30K',
      vlrBucket:          'VLR_LT_0_5',
      clusterRisk:        'WATCH',
      bubbleMapsScore:    44.4,
      ripperScore:        100,
      timingPath:         'ENTER_NOW',
      paperReviewLabel:   'TARGET_PROFILE_EXACT_MATCH',
      status:             'REVIEWED_ONLY',
      outcomeStatus:      'UNKNOWN',
      historicalWin5Rate: 0.627,
      reportOnly:         true,
      readOnly:           true,
      paperOnly:          true,
      realTradingLocked:  true,
      tradingExecuted:    0,
      ...o,
    };
  }

  // Test 14: ledger report counts rows correctly
  it('counts total reviewed and unique contracts', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    writeLedgerRows(ledgerPath, [
      makeLedgerRow({ contract: 'CONTRACT_A', symbol: 'AAA' }),
      makeLedgerRow({ contract: 'CONTRACT_B', symbol: 'BBB', cycleId: 'cycle-2026-06-18-110000' }),
      makeLedgerRow({ contract: 'CONTRACT_A', symbol: 'AAA', cycleId: 'cycle-2026-06-18-120000' }),  // dupe contract
    ]);
    const result = runTargetProfileReviewLedgerReport({ ledgerPath });
    expect(result.totalReviewed).toBe(3);
    expect(result.uniqueContracts).toBe(2);
    expect(result.byCycleId['cycle-2026-06-18-100000']).toBe(1);
    expect(result.byCycleId['cycle-2026-06-18-110000']).toBe(1);
    expect(result.bySymbol['AAA']).toBe(2);
    expect(result.bySymbol['BBB']).toBe(1);
    expect(result.outcomeStatusCounts['UNKNOWN']).toBe(3);
    expect(result.targetProfileCounts['LIQ_10K_30K_WATCH_ENTER_NOW']).toBe(3);
  });

  // Test 15: report command does not mutate the ledger
  it('report command does not mutate ledger file', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    writeLedgerRows(ledgerPath, [makeLedgerRow()]);
    const before = fs.readFileSync(ledgerPath, 'utf-8');
    runTargetProfileReviewLedgerReport({ ledgerPath });
    expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(before);
  });

  // Test 16: render contains safety strings
  it('render contains safety footer strings', () => {
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    writeLedgerRows(ledgerPath, [makeLedgerRow()]);
    const result   = runTargetProfileReviewLedgerReport({ ledgerPath });
    const rendered = renderTargetProfileReviewLedgerReport(result);
    expect(rendered).toContain('REPORT ONLY');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('tradingExecuted=0');
    expect(rendered).toContain('paperOnly=true');
  });

  // Test 17: empty ledger returns safe zero state
  it('handles empty or missing ledger gracefully', () => {
    const ledgerPath = path.join(dir, 'ledger-none.jsonl');
    const result = runTargetProfileReviewLedgerReport({ ledgerPath });
    expect(result.totalReviewed).toBe(0);
    expect(result.uniqueContracts).toBe(0);
    expect(result.latestCandidates.length).toBe(0);
    expect(result.reportOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });
});
