import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runWatchTargetProfileReport,
  renderWatchTargetProfileReport,
} from '../src/token-grab/ripperWatchTargetProfileReport';

// ── Test helpers ───────────────────────────────────────────────────────────────
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchTarget-'));
}

function writeLines(p: string, rows: object[]): void {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const T0 = 1_700_000_000_000;

function makeMemRow(o: Record<string, unknown> = {}): object {
  return {
    contract:        'MEM_AAAA',
    cycleId:         'cycle-test',
    capturedAt:      new Date(T0).toISOString(),
    liquidityBucket: 'LIQ_10K_30K',
    clusterRisk:     'WATCH',
    timingPath:      'ENTER_NOW',
    vlrBucket:       'VLR_LT_0_5',
    outcomeLabel:    'BIG_WINNER',
    priceChangePct:  60,
    reportOnly:      true,
    readOnly:        true,
    paperOnly:       true,
    realTradingLocked: true,
    tradingExecuted: 0,
    ...o,
  };
}

function makeLedgerRow(o: Record<string, unknown> = {}): object {
  const capturedAt = new Date(T0).toISOString();
  return {
    contract:        'LEDGER_AAAA',
    cycleId:         'cycle-fresh',
    capturedAt,
    enrolledAt:      capturedAt,
    dueAt2m:         new Date(T0 + 2 * 60 * 1000).toISOString(),
    dueAt5m:         new Date(T0 + 5 * 60 * 1000).toISOString(),
    liquidityUsd:    null,
    liquidityBucket: null,
    vlrBucket:       null,
    clusterRisk:     'WATCH',
    priceChangePct:  null,
    status:          'COMPLETE',
    reportOnly:      true,
    readOnly:        true,
    paperOnly:       true,
    realTradingLocked: true,
    tradingExecuted: 0,
    ...o,
  };
}

function makeSnap(o: Record<string, unknown> = {}): object {
  return {
    contract:           'LEDGER_AAAA',
    originalCapturedAt: new Date(T0).toISOString(),
    snapshotAt:         new Date(T0 + 3 * 60 * 1000).toISOString(),
    window:             'RECHECK_5M',
    liquidityUsd:       null,
    liquidityBucket:    null,
    vlrBucket:          null,
    clusterRisk:        null,
    ripperScore:        null,
    ageMinutes:         null,
    priceChangePct:     null,
    snapshotSource:     'NO_LOCAL_DATA',
    snapshotAvailable:  false,
    sourceFile:         null,
    minutesFromTarget:  null,
    reportOnly:         true,
    readOnly:           true,
    paperOnly:          true,
    realTradingLocked:  true,
    tradingExecuted:    0,
    ...o,
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────────
describe('runWatchTargetProfileReport', () => {
  let dir: string;
  let memPath: string;
  let ledPath: string;
  let snapPath: string;

  beforeEach(() => {
    dir      = tmpDir();
    memPath  = path.join(dir, 'learning-memory.jsonl');
    ledPath  = path.join(dir, 'ledger.jsonl');
    snapPath = path.join(dir, 'snapshots.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Test 1: Primary profile matches LIQ_10K_30K + WATCH rows only
  it('primary profile includes only LIQ_10K_30K + WATCH rows', () => {
    writeLines(memPath, [
      makeMemRow({ outcomeLabel: 'BIG_WINNER' }),
      makeMemRow({ outcomeLabel: 'BIG_WINNER' }),
      makeMemRow({ outcomeLabel: 'DUMP', liquidityBucket: 'LIQ_LT_10K' }),  // excluded
      makeMemRow({ outcomeLabel: 'DUMP', clusterRisk: 'CLEAN' }),             // excluded
    ]);
    writeLines(ledPath, []);
    writeLines(snapPath, []);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    const primary = result.profiles[0]!;
    expect(primary.name).toBe('LIQ_10K_30K + WATCH');
    expect(primary.totalRows).toBe(2);
    expect(primary.bigWinner).toBe(2);
    expect(primary.dump).toBe(0);
  });

  // Test 2: ENTER_NOW subgroup is a subset of the primary profile
  it('ENTER_NOW subgroup contains only ENTER_NOW rows from LIQ_10K_30K + WATCH', () => {
    writeLines(memPath, [
      makeMemRow({ timingPath: 'ENTER_NOW', outcomeLabel: 'BIG_WINNER' }),
      makeMemRow({ timingPath: 'ENTER_NOW', outcomeLabel: 'BIG_WINNER' }),
      makeMemRow({ timingPath: 'WAIT_10M',  outcomeLabel: 'DUMP' }),
    ]);
    writeLines(ledPath, []);
    writeLines(snapPath, []);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    const enterNow = result.profiles[1]!;
    expect(enterNow.name).toBe('LIQ_10K_30K + WATCH + ENTER_NOW');
    expect(enterNow.totalRows).toBe(2);
    expect(enterNow.bigWinner).toBe(2);
  });

  // Test 3: VLR bucket subgroups split correctly
  it('VLR subgroups split rows by vlrBucket within LIQ_10K_30K + WATCH', () => {
    writeLines(memPath, [
      makeMemRow({ vlrBucket: 'VLR_LT_0_5',  outcomeLabel: 'BIG_WINNER' }),
      makeMemRow({ vlrBucket: 'VLR_0_5_TO_2', outcomeLabel: 'WINNER' }),
      makeMemRow({ vlrBucket: 'VLR_GTE_2',    outcomeLabel: 'DUMP' }),
    ]);
    writeLines(ledPath, []);
    writeLines(snapPath, []);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    const [,, lt05, mid, gte2] = result.profiles;
    expect(lt05!.name).toBe('LIQ_10K_30K + VLR_LT_0_5 + WATCH');
    expect(lt05!.totalRows).toBe(1);
    expect(mid!.totalRows).toBe(1);
    expect(gte2!.totalRows).toBe(1);
    expect(gte2!.dump).toBe(1);
  });

  // Test 4: Baseline win5 uses ALL observed rows (including non-target)
  it('baseline win5 uses all observed rows globally', () => {
    writeLines(memPath, [
      // Non-target rows: 10 BIG_WINNER, 40 DUMP  → baseline = 10/50 = 20%
      ...Array.from({ length: 10 }, () => makeMemRow({ liquidityBucket: 'LIQ_LT_10K', outcomeLabel: 'BIG_WINNER' })),
      ...Array.from({ length: 40 }, () => makeMemRow({ liquidityBucket: 'LIQ_LT_10K', outcomeLabel: 'DUMP' })),
      // Target: 1 BIG_WINNER, 1 DUMP → win5 = 1/2 = 50%
      makeMemRow({ outcomeLabel: 'BIG_WINNER' }),
      makeMemRow({ outcomeLabel: 'DUMP' }),
    ]);
    writeLines(ledPath, []);
    writeLines(snapPath, []);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    // baseline = 11/52 ≈ 21.15%  (10 from non-target + 1 from target)
    expect(result.observedRows).toBe(52);
    expect(result.baselineWin5Rate).toBeCloseTo(11 / 52, 4);
    expect(result.profiles[0]!.win5Rate).toBeCloseTo(1 / 2, 4);
    expect(result.profiles[0]!.liftVsBaseline).toBeCloseTo((1 / 2) / (11 / 52), 2);
  });

  // Test 5a: PROMISING_PAPER_REVIEW when conditions met
  it('returns TARGET_PROFILE_PROMISING_PAPER_REVIEW when win5 > 1.5x baseline and flatDump < 55% and obs >= 75', () => {
    // 120 non-target rows: 10 BIG_WINNER, 110 DUMP → non-target BW = 10
    const nonTarget = [
      ...Array.from({ length: 10 }, () => makeMemRow({ liquidityBucket: 'LIQ_LT_10K', outcomeLabel: 'BIG_WINNER' })),
      ...Array.from({ length: 110 }, () => makeMemRow({ liquidityBucket: 'LIQ_LT_10K', outcomeLabel: 'DUMP' })),
    ];
    // 80 target rows: 50 BIG_WINNER, 20 DUMP, 10 FLAT_JUNK
    // target win5 = 50/80 = 62.5%, flatDump = 30/80 = 37.5%
    // global observed = 200, global BW = 60, baseline = 30%, 1.5x = 45%
    // 62.5% > 45% ✓  37.5% < 55% ✓  80 >= 75 ✓
    const target = [
      ...Array.from({ length: 50 }, () => makeMemRow({ outcomeLabel: 'BIG_WINNER' })),
      ...Array.from({ length: 20 }, () => makeMemRow({ outcomeLabel: 'DUMP' })),
      ...Array.from({ length: 10 }, () => makeMemRow({ outcomeLabel: 'FLAT_JUNK' })),
    ];
    writeLines(memPath, [...nonTarget, ...target]);
    writeLines(ledPath, []);
    writeLines(snapPath, []);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    expect(result.recommendation).toBe('TARGET_PROFILE_PROMISING_PAPER_REVIEW');
    expect(result.profiles[0]!.recommendation).toBe('TARGET_PROFILE_PROMISING_PAPER_REVIEW');
  });

  // Test 5b: REJECT_JUNK_HEAVY when flatDump > 70%
  it('returns TARGET_PROFILE_REJECT_JUNK_HEAVY when flatDump > 70%', () => {
    // 80 target rows: 5 BIG_WINNER, 40 DUMP, 35 FLAT_JUNK → flatDump = 75/80 = 93.75% > 70%
    // baseline: all target, so baseline = 5/80 = 6.25%
    writeLines(memPath, [
      ...Array.from({ length: 5  }, () => makeMemRow({ outcomeLabel: 'BIG_WINNER' })),
      ...Array.from({ length: 40 }, () => makeMemRow({ outcomeLabel: 'DUMP' })),
      ...Array.from({ length: 35 }, () => makeMemRow({ outcomeLabel: 'FLAT_JUNK' })),
    ]);
    writeLines(ledPath, []);
    writeLines(snapPath, []);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    expect(result.profiles[0]!.recommendation).toBe('TARGET_PROFILE_REJECT_JUNK_HEAVY');
  });

  // Test 5c: TOO_SMALL for individual profile when < 75 observed
  it('profile recommendation is TARGET_PROFILE_TOO_SMALL when observed < 75', () => {
    // 50 target rows: 35 BIG_WINNER, 10 DUMP, 5 FLAT_JUNK → obs=50 < 75
    writeLines(memPath, [
      ...Array.from({ length: 35 }, () => makeMemRow({ outcomeLabel: 'BIG_WINNER' })),
      ...Array.from({ length: 10 }, () => makeMemRow({ outcomeLabel: 'DUMP' })),
      ...Array.from({ length: 5  }, () => makeMemRow({ outcomeLabel: 'FLAT_JUNK' })),
    ]);
    writeLines(ledPath, []);
    writeLines(snapPath, []);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    expect(result.profiles[0]!.recommendation).toBe('TARGET_PROFILE_TOO_SMALL');
    // Overall recommendation also KEEP_COLLECTING because obs < 75
    expect(result.recommendation).toBe('TARGET_PROFILE_KEEP_COLLECTING');
  });

  // Test 5d: KEEP_COLLECTING when obs >= 75 but win5 doesn't clear threshold
  it('returns TARGET_PROFILE_KEEP_COLLECTING when obs >= 75 but win5 below threshold', () => {
    // 80 target rows all (baseline = target win5): 20 BIG_WINNER, 25 DUMP, 35 FLAT_JUNK
    // win5 = 25%, flatDump = 75% > 70% → actually that's REJECT
    // Let's use: 20 BIG_WINNER, 20 DUMP, 10 FLAT_JUNK, 30 SMALL_WINNER → flatDump=30/80=37.5%, win5=25%
    // baseline = 25%, 1.5x = 37.5%, win5=25% < 37.5% → not PROMISING
    writeLines(memPath, [
      ...Array.from({ length: 20 }, () => makeMemRow({ outcomeLabel: 'BIG_WINNER' })),
      ...Array.from({ length: 20 }, () => makeMemRow({ outcomeLabel: 'DUMP' })),
      ...Array.from({ length: 10 }, () => makeMemRow({ outcomeLabel: 'FLAT_JUNK' })),
      ...Array.from({ length: 30 }, () => makeMemRow({ outcomeLabel: 'SMALL_WINNER' })),
    ]);
    writeLines(ledPath, []);
    writeLines(snapPath, []);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    expect(result.profiles[0]!.recommendation).toBe('TARGET_PROFILE_KEEP_COLLECTING');
    expect(result.recommendation).toBe('TARGET_PROFILE_KEEP_COLLECTING');
  });

  // Test 6: improved-into-target detected from snapshots
  it('improvedIntoTarget increments when enrolled LIQ_UNKNOWN resolves to LIQ_10K_30K in snapshot', () => {
    writeLines(memPath, []);
    const capturedAt = new Date(T0).toISOString();
    writeLines(ledPath, [
      makeLedgerRow({ contract: 'CONTRACT_A', capturedAt, liquidityBucket: null }),
      makeLedgerRow({ contract: 'CONTRACT_B', capturedAt, liquidityBucket: 'LIQ_10K_30K' }),
    ]);
    writeLines(snapPath, [
      // CONTRACT_A: 5m snapshot resolves to LIQ_10K_30K → improvedIntoTarget++
      makeSnap({ contract: 'CONTRACT_A', originalCapturedAt: capturedAt, window: 'RECHECK_5M', liquidityBucket: 'LIQ_10K_30K', snapshotAvailable: true }),
      // CONTRACT_B: was already LIQ_10K_30K but snapshot shows different → fellOutOfTarget++
      makeSnap({ contract: 'CONTRACT_B', originalCapturedAt: capturedAt, window: 'RECHECK_5M', liquidityBucket: 'LIQ_LT_10K', snapshotAvailable: true }),
    ]);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    const fp = result.freshObservationProfile;
    expect(fp.improvedIntoTarget).toBe(1);
    expect(fp.match5m).toBe(1);
    expect(fp.matchingTarget).toBe(1);  // CONTRACT_B enrolled as LIQ_10K_30K
    expect(fp.fellOutOfTarget).toBe(1);
  });

  // Test 7: source breakdown tracks snapshot sources
  it('source breakdown counts snapshotSource per snapshot processed', () => {
    writeLines(memPath, []);
    const capturedAt = new Date(T0).toISOString();
    writeLines(ledPath, [
      makeLedgerRow({ contract: 'CONTRACT_A', capturedAt }),
      makeLedgerRow({ contract: 'CONTRACT_B', capturedAt }),
    ]);
    writeLines(snapPath, [
      makeSnap({ contract: 'CONTRACT_A', originalCapturedAt: capturedAt, window: 'RECHECK_2M', snapshotSource: 'DEX_WATCH_RUN', snapshotAvailable: true }),
      makeSnap({ contract: 'CONTRACT_A', originalCapturedAt: capturedAt, window: 'RECHECK_5M', snapshotSource: 'RIPPER_OBS', snapshotAvailable: true }),
      makeSnap({ contract: 'CONTRACT_B', originalCapturedAt: capturedAt, window: 'RECHECK_5M', snapshotSource: 'NO_LOCAL_DATA', snapshotAvailable: false }),
    ]);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    const bd = result.freshObservationProfile.sourceBreakdown;
    expect(bd['DEX_WATCH_RUN']).toBe(1);
    expect(bd['RIPPER_OBS']).toBe(1);
    expect(bd['NO_LOCAL_DATA']).toBe(1);
  });

  // Test 8: UNKNOWN rows excluded from observed count
  it('UNKNOWN outcomeLabel rows are excluded from observed count', () => {
    writeLines(memPath, [
      makeMemRow({ outcomeLabel: 'BIG_WINNER' }),
      makeMemRow({ outcomeLabel: 'UNKNOWN' }),
      makeMemRow({ outcomeLabel: 'DUMP' }),
    ]);
    writeLines(ledPath, []);
    writeLines(snapPath, []);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    const primary = result.profiles[0]!;
    expect(primary.observedRows).toBe(2);
    expect(primary.unknownRows).toBe(1);
    expect(primary.totalRows).toBe(3);
  });

  // Test 9: safety flags are set on result
  it('result includes safety flags all set to locked values', () => {
    writeLines(memPath, []);
    writeLines(ledPath, []);
    writeLines(snapPath, []);
    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });

  // Test 10: render output contains safety strings and no file mutation
  it('render includes safety footer and no files are mutated', () => {
    writeLines(memPath, [makeMemRow()]);
    writeLines(ledPath, [makeLedgerRow()]);
    writeLines(snapPath, [makeSnap()]);

    const memBefore  = fs.readFileSync(memPath,  'utf-8');
    const ledBefore  = fs.readFileSync(ledPath,  'utf-8');
    const snapBefore = fs.readFileSync(snapPath, 'utf-8');

    const result = runWatchTargetProfileReport({ memoryPath: memPath, ledgerPath: ledPath, snapshotsPath: snapPath });
    const rendered = renderWatchTargetProfileReport(result);

    expect(fs.readFileSync(memPath,  'utf-8')).toBe(memBefore);
    expect(fs.readFileSync(ledPath,  'utf-8')).toBe(ledBefore);
    expect(fs.readFileSync(snapPath, 'utf-8')).toBe(snapBefore);

    expect(rendered).toContain('REPORT ONLY');
    expect(rendered).toContain('NO TRADES');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('tradingExecuted=0');
    expect(rendered).toContain('paperOnly=true');
    expect(rendered).toContain('WATCH TARGET PROFILE REPORT');
  });
});
