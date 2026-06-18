import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runEarlyFingerprintReport,
  renderEarlyFingerprintReport,
  sampleWarning,
  computeArtifactRisk,
  computeFingerprintRec,
} from '../src/token-grab/ripperHistoricalEarlyFingerprintReport';

// ── Helpers ────────────────────────────────────────────────────────────────────
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-'));
}

function writeMemory(memPath: string, rows: object[]): void {
  fs.writeFileSync(memPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function makeRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract:              'CONTRACT_A',
    capturedAt:            '2026-06-18T10:00:00.000Z',
    observedAt:            '2026-06-18T10:05:00.000Z',
    outcomeLabel:          'BIG_WINNER',
    clusterRisk:           'CLEAN',
    liquidityBucket:       'LIQ_10K_30K',
    vlrBucket:             'VLR_LT_0_5',
    ripperScore:           85,
    ageMinutes:            3,
    bubbleMapsScore:       60,
    entryDecision:         'READY_TO_SNIPE_PAPER',
    gateDecision:          'BUY_APPROVED_PAPER',
    timingPath:            'ENTER_NOW',
    priceChangePct:        30,
    blockedByLowLiquidity: false,
    blockedByAgeGte10m:    false,
    reportOnly: true, readOnly: true, paperOnly: true, realTradingLocked: true, tradingExecuted: 0,
    ...o,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────────
let dir: string;
let memPath: string;

beforeEach(() => {
  dir     = tmpDir();
  memPath = path.join(dir, 'learning-memory.jsonl');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// ── Tests ──────────────────────────────────────────────────────────────────────

// Test 1: unique contract count — 2 rows same contract → uniqueContracts=1
it('deduplicates multiple rows for the same contract', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T10:00:00.000Z' }),
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T11:00:00.000Z', outcomeLabel: 'FLAT_JUNK' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.uniqueContracts).toBe(1);
  expect(result.totalMemoryRows).toBe(2);
});

// Test 2: first-seen row uses earliest capturedAt
it('uses the earliest capturedAt row for first-seen feature profile', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T12:00:00.000Z', clusterRisk: 'WATCH' }),
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T10:00:00.000Z', clusterRisk: 'CLEAN', outcomeLabel: 'BIG_WINNER' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  // Winner profile should show CLEAN (the earlier row), not WATCH
  expect(result.winnerProfile['clusterRisk']?.['CLEAN']).toBe(1);
  expect(result.winnerProfile['clusterRisk']?.['WATCH']).toBeUndefined();
});

// Test 3: canonical outcome = highest priority across all rows (UNKNOWN + BIG_WINNER → BIG_WINNER)
it('uses canonical outcome as highest priority across all contract rows', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T10:00:00.000Z', outcomeLabel: 'UNKNOWN' }),
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T11:00:00.000Z', outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'C2', capturedAt: '2026-06-18T10:00:00.000Z', outcomeLabel: 'UNKNOWN' }),
    makeRow({ contract: 'C2', capturedAt: '2026-06-18T11:00:00.000Z', outcomeLabel: 'FLAT_JUNK' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.bigWinnerCount).toBe(1);
  expect(result.flatJunkCount).toBe(1);
  expect(result.unknownCount).toBe(0);
});

// Test 4: winner grouping — BIG_WINNER and WINNER both count as winners
it('groups BIG_WINNER and WINNER as winners', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'C1', outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'C2', outcomeLabel: 'WINNER' }),
    makeRow({ contract: 'C3', outcomeLabel: 'FLAT_JUNK' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.bigWinnerCount).toBe(1);
  expect(result.winnerCount).toBe(1);
  const totalWinners = result.winnerProfile['clusterRisk'] ? Object.values(result.winnerProfile['clusterRisk']).reduce((a, b) => a + b, 0) : 0;
  expect(totalWinners).toBe(2);
});

// Test 5: junk grouping — FLAT_JUNK and DUMP both count as junk
it('groups FLAT_JUNK and DUMP as junk', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'C1', outcomeLabel: 'FLAT_JUNK' }),
    makeRow({ contract: 'C2', outcomeLabel: 'DUMP' }),
    makeRow({ contract: 'C3', outcomeLabel: 'BIG_WINNER' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.flatJunkCount).toBe(1);
  expect(result.dumpCount).toBe(1);
  const totalJunks = result.junkProfile['clusterRisk'] ? Object.values(result.junkProfile['clusterRisk']).reduce((a, b) => a + b, 0) : 0;
  expect(totalJunks).toBe(2);
});

// Test 6: SMALL_WINNER is counted in overview but excluded from observed (winner+junk) analysis
it('counts SMALL_WINNER in overview but excludes it from observed W+J analysis', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'C1', outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'C2', outcomeLabel: 'SMALL_WINNER' }),
    makeRow({ contract: 'C3', outcomeLabel: 'FLAT_JUNK' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.smallWinnerCount).toBe(1);
  // observedContracts = only BIG_WINNER + FLAT_JUNK (W+J) = 2
  expect(result.observedContracts).toBe(2);
});

// Test 7: feature separation lift — feature always in winners has lift > 1
it('computes lift > 1 for feature value concentrated in winners', () => {
  const rows: object[] = [];
  // 10 winner contracts with clusterRisk=SUPER_CLEAN (made-up value)
  for (let i = 0; i < 10; i++) {
    rows.push(makeRow({ contract: `WIN_${i}`, outcomeLabel: 'BIG_WINNER', clusterRisk: 'SUPER_CLEAN' }));
  }
  // 10 junk contracts with clusterRisk=DIRTY
  for (let i = 0; i < 10; i++) {
    rows.push(makeRow({ contract: `JUNK_${i}`, outcomeLabel: 'FLAT_JUNK', clusterRisk: 'DIRTY' }));
  }
  writeMemory(memPath, rows);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  const superCleanStat = result.featureStats.find(
    s => s.featureName === 'clusterRisk' && s.featureValue === 'SUPER_CLEAN',
  );
  expect(superCleanStat).toBeDefined();
  expect(superCleanStat!.lift).toBeGreaterThan(1);
  expect(superCleanStat!.winRate).toBe(1.0);
});

// Test 8: false reject winner — winner with PAPER_BUY_BLOCKED appears in falseRejectWinners
it('identifies winner with PAPER_BUY_BLOCKED as a false reject', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'WIN_BLOCKED', outcomeLabel: 'BIG_WINNER', entryDecision: 'PAPER_BUY_BLOCKED' }),
    makeRow({ contract: 'WIN_OK',      outcomeLabel: 'BIG_WINNER', entryDecision: 'READY_TO_SNIPE_PAPER' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.falseRejectWinners).toHaveLength(1);
  expect(result.falseRejectWinners[0]!.contract).toBe('WIN_BLOCKED');
  expect(result.falseRejectWinners[0]!.entryDecision).toBe('PAPER_BUY_BLOCKED');
  expect(result.falseRejectWinners[0]!.missedReason).toContain('PAPER_BUY_BLOCKED');
});

// Test 9: false reject winner — WATCH entryDecision also caught as false reject
it('identifies winner with WATCH entryDecision as a false reject', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'WIN_WATCH', outcomeLabel: 'WINNER', entryDecision: 'WATCH' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.falseRejectWinners).toHaveLength(1);
  expect(result.falseRejectWinners[0]!.entryDecision).toBe('WATCH');
});

// Test 10: false approve junk — junk with READY_TO_SNIPE_PAPER appears in falseApproveJunks
it('identifies junk with READY_TO_SNIPE_PAPER as a false approve', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'JUNK_APPROVED', outcomeLabel: 'FLAT_JUNK', entryDecision: 'READY_TO_SNIPE_PAPER', ripperScore: 90 }),
    makeRow({ contract: 'JUNK_BLOCKED',  outcomeLabel: 'DUMP',      entryDecision: 'PAPER_BUY_BLOCKED' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.falseApproveJunks).toHaveLength(1);
  expect(result.falseApproveJunks[0]!.contract).toBe('JUNK_APPROVED');
  expect(result.falseApproveJunks[0]!.fooledReason).toContain('paper entry approved');
});

// Test 11: junk with non-READY_TO_SNIPE_PAPER should NOT appear in falseApproveJunks
it('does not include junk with PAPER_BUY_BLOCKED in falseApproveJunks', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'JUNK_BLOCKED', outcomeLabel: 'FLAT_JUNK', entryDecision: 'PAPER_BUY_BLOCKED' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.falseApproveJunks).toHaveLength(0);
});

// Test 12: sampleWarning thresholds
it('returns correct sampleWarning values', () => {
  expect(sampleWarning(0)).toBe('TOO_SMALL');
  expect(sampleWarning(19)).toBe('TOO_SMALL');
  expect(sampleWarning(20)).toBe('EARLY');
  expect(sampleWarning(49)).toBe('EARLY');
  expect(sampleWarning(50)).toBe('USABLE');
  expect(sampleWarning(100)).toBe('USABLE');
});

// Test 13: artifactRisk thresholds
it('returns correct artifactRisk values', () => {
  expect(computeArtifactRisk(10, 2.0)).toBe('HIGH');   // n < 20
  expect(computeArtifactRisk(19, 1.5)).toBe('HIGH');   // n < 20
  expect(computeArtifactRisk(30, 6.0)).toBe('MEDIUM'); // lift > 5
  expect(computeArtifactRisk(30, 2.0)).toBe('MEDIUM'); // n < 50
  expect(computeArtifactRisk(50, 2.0)).toBe('LOW');    // n >= 50, lift <= 5
  expect(computeArtifactRisk(100, 3.0)).toBe('LOW');
});

// Test 14: fingerprintRec logic
it('returns correct FingerprintRec values', () => {
  expect(computeFingerprintRec(10,  0.6, 0.4, 1.2)).toBe('NEEDS_MORE_DATA'); // n < 20
  expect(computeFingerprintRec(25,  0.2, 0.8, 0.4)).toBe('REJECT_JUNK_HEAVY'); // flatDump > 0.6
  expect(computeFingerprintRec(30,  0.8, 0.2, 6.0)).toBe('LIKELY_ARTIFACT');   // lift > 5, n < 50
  expect(computeFingerprintRec(25,  0.5, 0.5, 1.5)).toBe('TEST_FORWARD');       // win>30%, lift>=1.3, n>=20
  expect(computeFingerprintRec(50,  0.2, 0.8, 0.4)).toBe('REJECT_JUNK_HEAVY'); // flatDump > 0.6
  expect(computeFingerprintRec(20,  0.25, 0.75, 0.5)).toBe('REJECT_JUNK_HEAVY'); // flatDump > 0.6
});

// Test 15: baseline win rate calculated correctly
it('computes baseline win rate as winners / (winners + junks)', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'W1', outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'W2', outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'W3', outcomeLabel: 'WINNER' }),
    makeRow({ contract: 'J1', outcomeLabel: 'FLAT_JUNK' }),
    makeRow({ contract: 'J2', outcomeLabel: 'DUMP' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  // 3 winners, 2 junks → baseline = 3/5 = 0.6
  expect(result.baselineWinRate).toBeCloseTo(0.6, 5);
  expect(result.observedContracts).toBe(5);
});

// Test 16: UNKNOWN contracts excluded from observed, baselineWinRate, featureStats
it('excludes UNKNOWN contracts from observedContracts and lift analysis', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'W1', outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'U1', outcomeLabel: 'UNKNOWN' }),
    makeRow({ contract: 'U2', outcomeLabel: 'UNKNOWN' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  // Only W1 is in observed (isWinner || isJunk)
  expect(result.observedContracts).toBe(1);
  expect(result.unknownCount).toBe(2);
  // With only 1 observed contract and 0 junks, baselineWinRate = 1.0 (1/1)
  expect(result.baselineWinRate).toBe(1.0);
});

// Test 17: safety flags
it('always returns correct safety flags', () => {
  writeMemory(memPath, [makeRow()]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.reportOnly).toBe(true);
  expect(result.readOnly).toBe(true);
  expect(result.paperOnly).toBe(true);
  expect(result.realTradingLocked).toBe(true);
  expect(result.tradingExecuted).toBe(0);
});

// Test 18: no mutation of input — memory file unchanged after run
it('does not mutate the memory file', () => {
  writeMemory(memPath, [makeRow(), makeRow({ contract: 'C2', outcomeLabel: 'FLAT_JUNK' })]);
  const before = fs.readFileSync(memPath, 'utf-8');
  runEarlyFingerprintReport({ memoryPath: memPath });
  const after = fs.readFileSync(memPath, 'utf-8');
  expect(after).toBe(before);
});

// Test 19: empty memory file returns safe zero result
it('returns zero counts for empty memory file', () => {
  writeMemory(memPath, []);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  expect(result.totalMemoryRows).toBe(0);
  expect(result.uniqueContracts).toBe(0);
  expect(result.observedContracts).toBe(0);
  expect(result.baselineWinRate).toBe(0);
  expect(result.featureStats).toHaveLength(0);
  expect(result.falseRejectWinners).toHaveLength(0);
  expect(result.falseApproveJunks).toHaveLength(0);
});

// Test 20: fingerprint matches contract with matching multi-feature combination
it('fingerprint counts only profiles matching ALL specified features', () => {
  writeMemory(memPath, [
    // Matches LIQ_10K_30K + CLEAN
    makeRow({ contract: 'M1', outcomeLabel: 'BIG_WINNER', liquidityBucket: 'LIQ_10K_30K', clusterRisk: 'CLEAN' }),
    makeRow({ contract: 'M2', outcomeLabel: 'FLAT_JUNK',  liquidityBucket: 'LIQ_10K_30K', clusterRisk: 'CLEAN' }),
    // Only matches LIQ_10K_30K (not CLEAN)
    makeRow({ contract: 'N1', outcomeLabel: 'BIG_WINNER', liquidityBucket: 'LIQ_10K_30K', clusterRisk: 'WATCH' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  const fp = result.fingerprints.find(f => f.description === 'LIQ_10K_30K + CLEAN');
  expect(fp).toBeDefined();
  // Only M1 and M2 match (N1 has WATCH not CLEAN)
  expect(fp!.uniqueContracts).toBe(2);
  expect(fp!.winnerCount).toBe(1);
  expect(fp!.junkCount).toBe(1);
});

// Test 21: renderer includes all 9 section headers and safety footer
it('renderer includes all 9 section headers', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'W1', outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'J1', outcomeLabel: 'FLAT_JUNK' }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  const rendered = renderEarlyFingerprintReport(result);
  expect(rendered).toContain('SECTION 1 — OVERVIEW');
  expect(rendered).toContain('SECTION 2 — FIRST-SEEN WINNER PROFILE');
  expect(rendered).toContain('SECTION 3 — FIRST-SEEN JUNK/DUMP PROFILE');
  expect(rendered).toContain('SECTION 4 — FEATURE SEPARATION TABLE');
  expect(rendered).toContain('SECTION 5 — FALSE REJECT WINNERS');
  expect(rendered).toContain('SECTION 6 — FALSE APPROVE JUNK');
  expect(rendered).toContain('SECTION 7 — EARLY FINGERPRINT CANDIDATES');
  expect(rendered).toContain('SECTION 8 — FRESH PAIR TRUST RULES');
  expect(rendered).toContain('SECTION 9 — SAFETY');
  expect(rendered).toContain('REPORT_ONLY=true');
  expect(rendered).toContain('tradingExecuted=0');
});

// Test 22: missedReason includes clusterRisk for WATCH false reject
it('missedReason includes WATCH cluster risk for winner with WATCH entryDecision', () => {
  writeMemory(memPath, [
    makeRow({
      contract:      'MISS_WATCH',
      outcomeLabel:  'BIG_WINNER',
      entryDecision: 'WATCH',
      clusterRisk:   'WATCH',
    }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  const fr = result.falseRejectWinners[0];
  expect(fr).toBeDefined();
  expect(fr!.missedReason).toContain('WATCH cluster risk');
});

// Test 23: fooledReason includes high ripperScore for false approve junk
it('fooledReason includes high ripperScore for false approve junk', () => {
  writeMemory(memPath, [
    makeRow({
      contract:      'FOOL_SCORE',
      outcomeLabel:  'DUMP',
      entryDecision: 'READY_TO_SNIPE_PAPER',
      ripperScore:   95,
      clusterRisk:   'CLEAN',
    }),
  ]);
  const result = runEarlyFingerprintReport({ memoryPath: memPath });
  const fa = result.falseApproveJunks[0];
  expect(fa).toBeDefined();
  expect(fa!.fooledReason).toContain('ripperScore=95');
});
