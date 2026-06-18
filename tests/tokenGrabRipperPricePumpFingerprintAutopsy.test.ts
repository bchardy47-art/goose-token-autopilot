import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runPricePumpAutopsy,
  renderPricePumpAutopsy,
  classifyPricePump,
} from '../src/token-grab/ripperPricePumpFingerprintAutopsy';

// ── Helpers ────────────────────────────────────────────────────────────────────
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ppa-'));
}

function writeMemory(p: string, rows: object[]): void {
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function makeRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract:              'CONTRACT_A',
    capturedAt:            '2026-06-18T10:00:00.000Z',
    observedAt:            '2026-06-18T10:15:00.000Z',
    outcomeLabel:          'BIG_WINNER',
    clusterRisk:           'CLEAN',
    liquidityBucket:       'LIQ_10K_30K',
    liquidityUsd:          15000,
    vlrBucket:             'VLR_LT_0_5',
    ripperScore:           85,
    ageMinutes:            3,
    bubbleMapsScore:       65,
    entryDecision:         'READY_TO_SNIPE_PAPER',
    gateDecision:          'BUY_APPROVED_PAPER',
    timingPath:            'ENTER_NOW',
    priceChangePct:        28,
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

// ── Test 1: first-seen row selection uses earliest capturedAt ─────────────────
it('selects earliest capturedAt as first-seen row for PRICE_PUMP detection', () => {
  writeMemory(memPath, [
    // Earlier row: pcp=30 (PRICE_PUMP)
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T09:00:00.000Z', priceChangePct: 30, outcomeLabel: 'BIG_WINNER' }),
    // Later row: pcp=-50 (PRICE_DUMP) — should NOT be used for first-seen
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T10:00:00.000Z', priceChangePct: -50, outcomeLabel: 'DUMP' }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  // Contract should be in PRICE_PUMP because first-seen pcp=30 > 20
  expect(result.pricePumpContracts).toBe(1);
  expect(result.uniqueContracts).toBe(1);
});

// ── Test 2: PRICE_PUMP threshold is strictly > 20 ────────────────────────────
it('classifies pcp=20 as NOT PRICE_PUMP (boundary exclusive)', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'C1', priceChangePct: 20, outcomeLabel: 'WINNER' }),
    makeRow({ contract: 'C2', priceChangePct: 20.1, outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'C3', priceChangePct: 19.9, outcomeLabel: 'WINNER' }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  // Only C2 has pcp > 20
  expect(result.pricePumpContracts).toBe(1);
});

// ── Test 3: canonical outcome = best priority across all rows ─────────────────
it('uses best-priority canonical outcome (BIG_WINNER > DUMP)', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T10:00:00.000Z', priceChangePct: 25, outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T11:00:00.000Z', priceChangePct: -80, outcomeLabel: 'DUMP' }),
    makeRow({ contract: 'C2', capturedAt: '2026-06-18T10:00:00.000Z', priceChangePct: -60, outcomeLabel: 'DUMP' }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  expect(result.bigWinnerCount).toBe(1);  // C1 canonical = BIG_WINNER
  expect(result.dumpCount).toBe(1);       // C2 canonical = DUMP
  // C1 is PRICE_PUMP (first-seen pcp=25), C2 is not
  expect(result.pricePumpContracts).toBe(1);
});

// ── Test 4: baseline win rate excludes UNKNOWN and SMALL_WINNER ───────────────
it('computes baseline win rate using only W+J observed contracts', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'W1', priceChangePct: 5,  outcomeLabel: 'WINNER' }),
    makeRow({ contract: 'W2', priceChangePct: 5,  outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'J1', priceChangePct: -5, outcomeLabel: 'FLAT_JUNK' }),
    makeRow({ contract: 'J2', priceChangePct: -5, outcomeLabel: 'DUMP' }),
    makeRow({ contract: 'U1', priceChangePct: 5,  outcomeLabel: 'UNKNOWN' }),
    makeRow({ contract: 'S1', priceChangePct: 5,  outcomeLabel: 'SMALL_WINNER' }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  // observed = W1+W2+J1+J2 = 4, winners = 2, baseline = 0.5
  expect(result.baselineWinRate).toBeCloseTo(0.5, 5);
  expect(result.observedContracts).toBe(4);
});

// ── Test 5: PRICE_PUMP lift calculation ───────────────────────────────────────
it('computes correct PRICE_PUMP lift vs baseline', () => {
  writeMemory(memPath, [
    // 2 winners, 2 junks total — baseline = 0.5
    makeRow({ contract: 'W1', priceChangePct: 5,  outcomeLabel: 'WINNER' }),
    makeRow({ contract: 'J1', priceChangePct: -5, outcomeLabel: 'FLAT_JUNK' }),
    makeRow({ contract: 'J2', priceChangePct: -5, outcomeLabel: 'DUMP' }),
    // PRICE_PUMP contract
    makeRow({ contract: 'PP', priceChangePct: 30, outcomeLabel: 'BIG_WINNER' }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  // PP win rate = 1.0 (1 winner, 0 junks), baseline = 0.5 (2 winners, 3 junks total wait...)
  // Actually: W1+J1+J2+PP = 4 observed, winners = W1+PP = 2, junks = J1+J2 = 2, baseline = 0.5
  // PP subgroup = 1 winner, 0 junk, pp_win_rate = 1.0, lift = 2.0
  expect(result.pricePumpWinRate).toBeCloseTo(1.0, 5);
  expect(result.pricePumpLift).toBeCloseTo(2.0, 5);
});

// ── Test 6: classifyPricePump — VIOLENT_SPIKE detection ──────────────────────
it('classifies VIOLENT_SPIKE when pcp>60 and thin liquidity', () => {
  const cls = classifyPricePump({
    priceChangePct:  80,
    ageMinutes:      3,
    liquidityUsd:    5000,   // thin
    vlrBucket:       'VLR_LT_0_5',
    clusterRisk:     'CLEAN',
    liquidityBucket: 'LIQ_LT_10K',
  });
  expect(cls).toBe('VIOLENT_SPIKE');
});

// ── Test 7: classifyPricePump — VIOLENT_SPIKE via VLR_GTE_2 ──────────────────
it('classifies VIOLENT_SPIKE when pcp>60 and VLR_GTE_2 (even with decent liquidity)', () => {
  const cls = classifyPricePump({
    priceChangePct:  70,
    ageMinutes:      3,
    liquidityUsd:    20000,
    vlrBucket:       'VLR_GTE_2',
    clusterRisk:     'CLEAN',
    liquidityBucket: 'LIQ_10K_30K',
  });
  expect(cls).toBe('VIOLENT_SPIKE');
});

// ── Test 8: classifyPricePump — LATE_CHASE when age > 5m ─────────────────────
it('classifies LATE_CHASE when ageMinutes > 5', () => {
  const cls = classifyPricePump({
    priceChangePct:  25,
    ageMinutes:      8,
    liquidityUsd:    15000,
    vlrBucket:       'VLR_LT_0_5',
    clusterRisk:     'CLEAN',
    liquidityBucket: 'LIQ_10K_30K',
  });
  expect(cls).toBe('LATE_CHASE');
});

// ── Test 9: classifyPricePump — LATE_CHASE when pcp > 100 ────────────────────
it('classifies LATE_CHASE when pcp > 100 (even if young)', () => {
  const cls = classifyPricePump({
    priceChangePct:  120,
    ageMinutes:      2,
    liquidityUsd:    15000,
    vlrBucket:       'VLR_LT_0_5',
    clusterRisk:     'CLEAN',
    liquidityBucket: 'LIQ_10K_30K',
  });
  expect(cls).toBe('LATE_CHASE');
});

// ── Test 10: classifyPricePump — CLEAN_PUMP ───────────────────────────────────
it('classifies CLEAN_PUMP when CLEAN cluster + liq>=10k + moderate pump', () => {
  const cls = classifyPricePump({
    priceChangePct:  35,
    ageMinutes:      3,
    liquidityUsd:    20000,
    vlrBucket:       'VLR_LT_0_5',
    clusterRisk:     'CLEAN',
    liquidityBucket: 'LIQ_10K_30K',
  });
  expect(cls).toBe('CLEAN_PUMP');
});

// ── Test 11: classifyPricePump — EARLY_MOMENTUM fallback ─────────────────────
it('classifies EARLY_MOMENTUM when age<=5m, pcp<=60, not CLEAN', () => {
  const cls = classifyPricePump({
    priceChangePct:  40,
    ageMinutes:      4,
    liquidityUsd:    15000,
    vlrBucket:       'VLR_LT_0_5',
    clusterRisk:     'WATCH',
    liquidityBucket: 'LIQ_10K_30K',
  });
  expect(cls).toBe('EARLY_MOMENTUM');
});

// ── Test 12: VIOLENT_SPIKE takes priority over LATE_CHASE ────────────────────
it('VIOLENT_SPIKE takes priority over LATE_CHASE classification', () => {
  // age>5m (would be LATE_CHASE) but also pcp>60 + thin liq (VIOLENT_SPIKE)
  const cls = classifyPricePump({
    priceChangePct:  75,
    ageMinutes:      8,
    liquidityUsd:    4000,
    vlrBucket:       'VLR_LT_0_5',
    clusterRisk:     'CLEAN',
    liquidityBucket: 'LIQ_LT_10K',
  });
  expect(cls).toBe('VIOLENT_SPIKE');
});

// ── Test 13: false safety check is definitionally empty ──────────────────────
it('false safety check is definitionally empty — pcp>20 contracts are all BIG_WINNER', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'PP1', priceChangePct: 30, outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'PP2', priceChangePct: 50, outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'J1',  priceChangePct: -5, outcomeLabel: 'FLAT_JUNK' }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  expect(result.falseSafetyCases).toHaveLength(0);
  expect(result.falseSafetyDefinitionallyEmpty).toBe(true);
});

// ── Test 14: missed PRICE_PUMP winners detection ──────────────────────────────
it('identifies PRICE_PUMP winners with non-approved entryDecision as missed', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'MISS1', priceChangePct: 35, outcomeLabel: 'BIG_WINNER', entryDecision: 'PAPER_BUY_BLOCKED' }),
    makeRow({ contract: 'MISS2', priceChangePct: 25, outcomeLabel: 'BIG_WINNER', entryDecision: 'WATCH' }),
    makeRow({ contract: 'OK1',   priceChangePct: 28, outcomeLabel: 'BIG_WINNER', entryDecision: 'READY_TO_SNIPE_PAPER' }),
    makeRow({ contract: 'J1',    priceChangePct: -5, outcomeLabel: 'FLAT_JUNK',  entryDecision: 'READY_TO_SNIPE_PAPER' }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  expect(result.missedPricePumpWinners).toHaveLength(2);
  const contracts = result.missedPricePumpWinners.map(m => m.contract);
  expect(contracts).toContain('MISS1');
  expect(contracts).toContain('MISS2');
  expect(contracts).not.toContain('OK1');
});

// ── Test 15: missed PRICE_PUMP winner missedReason includes entryDecision ─────
it('missedReason includes PAPER_BUY_BLOCKED for blocked PRICE_PUMP winner', () => {
  writeMemory(memPath, [
    makeRow({
      contract:      'BLOCKED',
      priceChangePct: 40,
      outcomeLabel:  'BIG_WINNER',
      entryDecision: 'PAPER_BUY_BLOCKED',
      clusterRisk:   'CLEAN',
      ripperScore:   0,
    }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  const missed = result.missedPricePumpWinners[0];
  expect(missed).toBeDefined();
  expect(missed!.missedReason).toContain('PAPER_BUY_BLOCKED');
  expect(missed!.missedReason).toContain('ripperScore=0');
});

// ── Test 16: pricePumpSubBucket distribution included in profile ───────────────
it('includes pricePumpSubBucket distribution in pricePumpProfile', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'A', priceChangePct: 25,  outcomeLabel: 'BIG_WINNER' }),  // PCP_20_30
    makeRow({ contract: 'B', priceChangePct: 45,  outcomeLabel: 'BIG_WINNER' }),  // PCP_30_60
    makeRow({ contract: 'C', priceChangePct: 80,  outcomeLabel: 'BIG_WINNER' }),  // PCP_60_100
    makeRow({ contract: 'D', priceChangePct: 150, outcomeLabel: 'BIG_WINNER' }),  // PCP_GT_100
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  expect(result.pricePumpProfile['pricePumpSubBucket']?.['PCP_20_30']).toBe(1);
  expect(result.pricePumpProfile['pricePumpSubBucket']?.['PCP_30_60']).toBe(1);
  expect(result.pricePumpProfile['pricePumpSubBucket']?.['PCP_60_100']).toBe(1);
  expect(result.pricePumpProfile['pricePumpSubBucket']?.['PCP_GT_100']).toBe(1);
});

// ── Test 17: subgroup PRICE_PUMP + age<=5m counts correctly ──────────────────
it('subgroup PRICE_PUMP + age<=5m includes only young captures', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'YOUNG1', priceChangePct: 30, outcomeLabel: 'BIG_WINNER', ageMinutes: 3 }),
    makeRow({ contract: 'YOUNG2', priceChangePct: 25, outcomeLabel: 'BIG_WINNER', ageMinutes: 5 }),
    makeRow({ contract: 'OLD1',   priceChangePct: 35, outcomeLabel: 'BIG_WINNER', ageMinutes: 8 }),
    makeRow({ contract: 'J1',     priceChangePct: -5, outcomeLabel: 'FLAT_JUNK',  ageMinutes: 3 }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  const sub = result.subgroups.find(s => s.label === 'PRICE_PUMP + age<=5m');
  expect(sub).toBeDefined();
  expect(sub!.n).toBe(2);  // YOUNG1 + YOUNG2 (both observed and PRICE_PUMP)
  expect(sub!.winnerCount).toBe(2);
});

// ── Test 18: isCircularArtifact always true ───────────────────────────────────
it('isCircularArtifact is always true', () => {
  writeMemory(memPath, [makeRow()]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  expect(result.isCircularArtifact).toBe(true);
  expect(result.artifactExplanation).toContain('DEFINITIONALLY');
});

// ── Test 19: safety flags ─────────────────────────────────────────────────────
it('returns correct safety flags', () => {
  writeMemory(memPath, [makeRow()]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  expect(result.reportOnly).toBe(true);
  expect(result.readOnly).toBe(true);
  expect(result.paperOnly).toBe(true);
  expect(result.realTradingLocked).toBe(true);
  expect(result.tradingExecuted).toBe(0);
});

// ── Test 20: no input mutation ────────────────────────────────────────────────
it('does not mutate the memory file', () => {
  writeMemory(memPath, [makeRow(), makeRow({ contract: 'C2', priceChangePct: -30, outcomeLabel: 'DUMP' })]);
  const before = fs.readFileSync(memPath, 'utf-8');
  runPricePumpAutopsy({ memoryPath: memPath });
  const after = fs.readFileSync(memPath, 'utf-8');
  expect(after).toBe(before);
});

// ── Test 21: renderer includes all 9 section headers and safety ───────────────
it('renderer includes all 9 section headers and artifact warning', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'PP', priceChangePct: 28, outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'J1', priceChangePct: -5, outcomeLabel: 'FLAT_JUNK' }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  const rendered = renderPricePumpAutopsy(result);
  expect(rendered).toContain('SECTION 1 — OVERVIEW');
  expect(rendered).toContain('SECTION 2 — PRICE_PUMP FIRST-SEEN PROFILE');
  expect(rendered).toContain('SECTION 3 — WAS IT ALREADY TOO LATE?');
  expect(rendered).toContain('SECTION 4 — PRICE_PUMP SUBGROUP SEPARATION');
  expect(rendered).toContain('SECTION 5 — PRICE_PUMP FALSE SAFETY CHECK');
  expect(rendered).toContain('SECTION 6 — MISSED PRICE_PUMP WINNERS');
  expect(rendered).toContain('SECTION 7 — ENTRY TIMING READ');
  expect(rendered).toContain('SECTION 8 — FORWARD TEST CANDIDATES');
  expect(rendered).toContain('SECTION 9 — SAFETY');
  expect(rendered).toContain('ARTIFACT ALERT');
  expect(rendered).toContain('CIRCULAR ARTIFACT');
  expect(rendered).toContain('DEFINITIONALLY EMPTY');
  expect(rendered).toContain('tradingExecuted=0');
});

// ── Test 22: empty memory returns safe zero result ────────────────────────────
it('returns zero counts for empty memory file', () => {
  writeMemory(memPath, []);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  expect(result.totalMemoryRows).toBe(0);
  expect(result.pricePumpContracts).toBe(0);
  expect(result.baselineWinRate).toBe(0);
  expect(result.falseSafetyDefinitionallyEmpty).toBe(true);
});

// ── Test 23: unique-contract dedup — same contract, 2 rows → counted once ────
it('deduplicates contracts correctly', () => {
  writeMemory(memPath, [
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T10:00:00.000Z', priceChangePct: 25, outcomeLabel: 'BIG_WINNER' }),
    makeRow({ contract: 'C1', capturedAt: '2026-06-18T11:00:00.000Z', priceChangePct: 25, outcomeLabel: 'BIG_WINNER' }),
  ]);
  const result = runPricePumpAutopsy({ memoryPath: memPath });
  expect(result.uniqueContracts).toBe(1);
  expect(result.pricePumpContracts).toBe(1);
  expect(result.totalMemoryRows).toBe(2);
});
