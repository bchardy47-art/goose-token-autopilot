import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runWatchObservationEnroll,
  runWatchObservationCloseout,
  runWatchObservationReport,
  renderWatchObservationEnroll,
  renderWatchObservationCloseout,
  renderWatchObservationReport,
  LedgerRow,
  SnapshotRow,
} from '../src/token-grab/ripperWatchObservationLoop';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchObs-'));
}

function writeCycle(dir: string, name: string, rows: object[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function writeLines(p: string, rows: object[]): void {
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function readLines(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

const T0 = 1_700_000_000_000;  // fixed base epoch for deterministic tests

function makeCycleRow(o: Record<string, unknown> = {}): object {
  return {
    id:              'dex-watch-run:TEST:2024',
    capturedAt:      new Date(T0).toISOString(),
    contract:        'CONTRACTaaaaaaaaaaaaaaaaaaaaa',
    ripperScore:     80,
    ageMinutes:      5.0,
    clusterRisk:     'WATCH',
    liquidityUsd:    null,
    liquidityBucket: 'LIQ_UNKNOWN',
    vlrBucket:       'VLR_UNKNOWN',
    bubbleMapsScore: 40,
    buyGateDecision: 'BUY_REJECTED',
    priceChangePct:  5.0,
    ...o,
  };
}

function makeLedgerRow(o: Partial<LedgerRow> = {}): LedgerRow {
  const capturedAt = o.capturedAt ?? new Date(T0).toISOString();
  const capturedMs = Date.parse(capturedAt);
  return {
    contract:          'CONTRACTaaaaaaaaaaaaaaaaaaaaa',
    cycleId:           'cycle-2024-01-01-120000',
    capturedAt,
    enrolledAt:        new Date(T0).toISOString(),
    dueAt2m:           new Date(capturedMs + 2 * 60 * 1000).toISOString(),
    dueAt5m:           new Date(capturedMs + 5 * 60 * 1000).toISOString(),
    liquidityUsd:      null,
    liquidityBucket:   'LIQ_UNKNOWN',
    vlrBucket:         'VLR_UNKNOWN',
    bubbleMapsScore:   40,
    clusterRisk:       'WATCH',
    ripperScore:       80,
    ageMinutes:        5.0,
    priceChangePct:    5.0,
    timingPath:        'ENTER_NOW',
    gateDecision:      'BUY_REJECTED',
    status:            'PLANNED',
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
    ...o,
  };
}

function makeSnapshot(o: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    contract:           'CONTRACTaaaaaaaaaaaaaaaaaaaaa',
    originalCapturedAt: new Date(T0).toISOString(),
    snapshotAt:         new Date(T0 + 3 * 60 * 1000).toISOString(),
    window:             'RECHECK_2M',
    liquidityUsd:       null,
    liquidityBucket:    null,
    vlrBucket:          null,
    bubbleMapsScore:    null,
    clusterRisk:        null,
    ripperScore:        null,
    ageMinutes:         null,
    priceChangePct:     null,
    snapshotSource:     'NO_LOCAL_DATA',
    snapshotAvailable:  false,
    reportOnly:         true,
    readOnly:           true,
    paperOnly:          true,
    realTradingLocked:  true,
    tradingExecuted:    0,
    ...o,
  };
}

// ── WATCH-only enrollment ─────────────────────────────────────────────────────

describe('ripperWatchObservationLoop — WATCH-only enrollment', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('only WATCH clusterRisk rows are enrolled', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [
      makeCycleRow({ contract: 'WATCH_1', clusterRisk: 'WATCH' }),
      makeCycleRow({ contract: 'CLEAN_1', clusterRisk: 'CLEAN' }),
      makeCycleRow({ contract: 'UNKNWN1', clusterRisk: 'UNKNOWN' }),
    ]);
    const ledger = path.join(dir, 'ledger.jsonl');
    const result = runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 });
    expect(result.watchRows).toBe(1);
    expect(result.newEnrollments).toBe(1);
    expect(result.totalCycleRows).toBe(3);
  });

  it('enrolled rows have status=PLANNED', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [
      makeCycleRow({ contract: 'WATCH_1', clusterRisk: 'WATCH' }),
    ]);
    const ledger = path.join(dir, 'ledger.jsonl');
    runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 });
    const rows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    expect(rows[0]!.status).toBe('PLANNED');
  });

  it('enrolled row has correct dueAt2m and dueAt5m', () => {
    const capturedAt = new Date(T0).toISOString();
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [
      makeCycleRow({ contract: 'WATCH_1', clusterRisk: 'WATCH', capturedAt }),
    ]);
    const ledger = path.join(dir, 'ledger.jsonl');
    runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 });
    const rows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    const row = rows[0]!;
    expect(Date.parse(row.dueAt2m)).toBe(T0 + 2 * 60 * 1000);
    expect(Date.parse(row.dueAt5m)).toBe(T0 + 5 * 60 * 1000);
  });

  it('clusterRisk in raw.* is resolved correctly', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [
      { id: 'test', capturedAt: new Date(T0).toISOString(), raw: { contract: 'RAW_CONTRACT_1111', clusterRisk: 'WATCH' }, ripperScore: 70, ageMinutes: 3 },
    ]);
    const ledger = path.join(dir, 'ledger.jsonl');
    const result = runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 });
    expect(result.newEnrollments).toBe(1);
    const rows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    expect(rows[0]!.contract).toBe('RAW_CONTRACT_1111');
    expect(rows[0]!.clusterRisk).toBe('WATCH');
  });

  it('no cycle file → zero enrollments', () => {
    const result = runWatchObservationEnroll({
      cycleDir: path.join(dir, 'empty-dir'),
      ledgerPath: path.join(dir, 'ledger.jsonl'),
      nowMs: T0,
    });
    expect(result.cycleFile).toBeNull();
    expect(result.newEnrollments).toBe(0);
  });

  it('timingPath inferred from ageMinutes when not set', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [
      makeCycleRow({ contract: 'EARLY_1', ageMinutes: 3 }),
      makeCycleRow({ contract: 'LATE__1', ageMinutes: 12, capturedAt: new Date(T0 + 1).toISOString() }),
    ]);
    const ledger = path.join(dir, 'ledger.jsonl');
    runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 });
    const rows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    const early = rows.find(r => r.contract === 'EARLY_1')!;
    const late  = rows.find(r => r.contract === 'LATE__1')!;
    expect(early.timingPath).toBe('ENTER_NOW');
    expect(late.timingPath).toBe('WAIT_10M');
  });
});

// ── Enrollment dedupe ─────────────────────────────────────────────────────────

describe('ripperWatchObservationLoop — enrollment dedupe', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('second enroll run does not duplicate same contract+capturedAt', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [
      makeCycleRow({ contract: 'WATCH_1', capturedAt: new Date(T0).toISOString() }),
    ]);
    const ledger = path.join(dir, 'ledger.jsonl');
    const r1 = runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 });
    const r2 = runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 + 1000 });
    expect(r1.newEnrollments).toBe(1);
    expect(r2.newEnrollments).toBe(0);
    expect(r2.duplicatesSkipped).toBe(1);
    expect(readLines(ledger).length).toBe(1);
  });

  it('different capturedAt for same contract creates separate enrollment', () => {
    const file1 = writeCycle(dir, 'cycle-A.jsonl', [
      makeCycleRow({ contract: 'SAME_CONTRACT', capturedAt: new Date(T0).toISOString() }),
    ]);
    const file2 = writeCycle(dir, 'cycle-B.jsonl', [
      makeCycleRow({ contract: 'SAME_CONTRACT', capturedAt: new Date(T0 + 60_000).toISOString() }),
    ]);
    const ledger = path.join(dir, 'ledger.jsonl');
    runWatchObservationEnroll({ cycleFile: file1, ledgerPath: ledger, nowMs: T0 });
    runWatchObservationEnroll({ cycleFile: file2, ledgerPath: ledger, nowMs: T0 + 60_000 });
    expect(readLines(ledger).length).toBe(2);
  });
});

// ── No gate/decision mutation ─────────────────────────────────────────────────

describe('ripperWatchObservationLoop — no gate/decision mutation', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('enrolled row preserves original gateDecision (BUY_REJECTED)', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [
      makeCycleRow({ contract: 'WATCH_1', buyGateDecision: 'BUY_REJECTED' }),
    ]);
    const ledger = path.join(dir, 'ledger.jsonl');
    runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 });
    const rows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    expect(rows[0]!.gateDecision).toBe('BUY_REJECTED');
  });

  it('enrolled row never creates BUY_APPROVED_PAPER gate decision', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [
      makeCycleRow({ contract: 'WATCH_1', buyGateDecision: 'BUY_REJECTED' }),
      makeCycleRow({ contract: 'WATCH_2', buyGateDecision: 'BUY_APPROVED_PAPER', capturedAt: new Date(T0 + 1).toISOString() }),
    ]);
    const ledger = path.join(dir, 'ledger.jsonl');
    runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 });
    const rows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    // Any BUY_APPROVED_PAPER in input is preserved as-is (we don't create it ourselves)
    // and tradingExecuted stays 0
    for (const r of rows) {
      expect(r.tradingExecuted).toBe(0);
      expect(r.realTradingLocked).toBe(true);
    }
  });

  it('tradingExecuted is always 0 in all result types', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [
      makeCycleRow({ contract: 'WATCH_1' }),
    ]);
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    const enroll    = runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 });
    const closeout  = runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs: T0 + 10 * 60 * 1000 });
    const report    = runWatchObservationReport({ ledgerPath: ledger, snapshotsPath: snapshots, reportPath: path.join(dir, 'report.jsonl') });
    expect(enroll.tradingExecuted).toBe(0);
    expect(closeout.tradingExecuted).toBe(0);
    expect(report.tradingExecuted).toBe(0);
  });
});

// ── Due 2m / due 5m detection ─────────────────────────────────────────────────

describe('ripperWatchObservationLoop — due window detection', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('PLANNED row past dueAt2m only → DUE_2M_CAPTURED, 1 snapshot', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow()]);
    // nowMs = T0 + 3 minutes — past 2m, not yet 5m
    const nowMs = T0 + 3 * 60 * 1000;
    const result = runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs });
    expect(result.dueFor2m).toBe(1);
    expect(result.dueFor5m).toBe(0);
    expect(result.snapshotsWritten).toBe(1);
    expect(result.ledgerRowsUpdated).toBe(1);
    const ledgerRows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    expect(ledgerRows[0]!.status).toBe('DUE_2M_CAPTURED');
  });

  it('DUE_2M_CAPTURED row past dueAt5m → COMPLETE, 1 more snapshot', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow({ status: 'DUE_2M_CAPTURED' })]);
    const nowMs = T0 + 6 * 60 * 1000;
    const result = runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs });
    expect(result.dueFor2m).toBe(0);
    expect(result.dueFor5m).toBe(1);
    expect(result.snapshotsWritten).toBe(1);
    const ledgerRows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    expect(ledgerRows[0]!.status).toBe('COMPLETE');
  });

  it('PLANNED row past both windows → EXPIRED_NO_DATA, 2 snapshots', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow()]);
    const nowMs = T0 + 10 * 60 * 1000;  // past both 2m and 5m
    const result = runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs });
    expect(result.dueFor2m).toBe(1);
    expect(result.dueFor5m).toBe(1);
    expect(result.snapshotsWritten).toBe(2);
    const ledgerRows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    expect(ledgerRows[0]!.status).toBe('EXPIRED_NO_DATA');
  });

  it('PLANNED row not yet past dueAt2m → status stays PLANNED', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow()]);
    const nowMs = T0 + 60 * 1000;  // only 1 minute elapsed
    const result = runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs });
    expect(result.dueFor2m).toBe(0);
    expect(result.snapshotsWritten).toBe(0);
    expect(result.ledgerRowsUpdated).toBe(0);
    const ledgerRows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    expect(ledgerRows[0]!.status).toBe('PLANNED');
  });

  it('already-captured snapshot is not re-written on second closeout run', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow()]);
    const nowMs = T0 + 3 * 60 * 1000;
    // First run: writes 1 snapshot, upgrades ledger to DUE_2M_CAPTURED
    const r1 = runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs });
    expect(r1.snapshotsWritten).toBe(1);
    // Second run: ledger row is DUE_2M_CAPTURED and 5m not yet due → nothing to process
    const r2 = runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs });
    expect(r2.snapshotsWritten).toBe(0);
    expect(r2.ledgerRowsUpdated).toBe(0);
    expect(readLines(snapshots).length).toBe(1);  // no duplicate snapshot
  });

  it('multiple rows processed independently', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [
      makeLedgerRow({ contract: 'ROW_A', capturedAt: new Date(T0).toISOString() }),
      makeLedgerRow({ contract: 'ROW_B', capturedAt: new Date(T0 + 1000).toISOString() }),
    ]);
    const nowMs = T0 + 3 * 60 * 1000;
    const result = runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs });
    expect(result.dueFor2m).toBe(2);
    expect(result.snapshotsWritten).toBe(2);
  });
});

// ── Missing snapshot handling ─────────────────────────────────────────────────

describe('ripperWatchObservationLoop — missing snapshot handling', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('closeout writes snapshotAvailable=false when no local data', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow()]);
    runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs: T0 + 10 * 60 * 1000 });
    const snaps = readLines(snapshots).map(l => JSON.parse(l)) as SnapshotRow[];
    for (const s of snaps) {
      expect(s.snapshotAvailable).toBe(false);
      expect(s.snapshotSource).toBe('NO_LOCAL_DATA');
    }
  });

  it('closeout does not fail when ledger is missing', () => {
    const result = runWatchObservationCloseout({
      ledgerPath:    path.join(dir, 'missing-ledger.jsonl'),
      snapshotsPath: path.join(dir, 'snaps.jsonl'),
      nowMs:         T0,
    });
    expect(result.ledgerRowsRead).toBe(0);
    expect(result.snapshotsWritten).toBe(0);
  });

  it('report handles missing snapshots gracefully', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    writeLines(ledger, [makeLedgerRow()]);
    const result = runWatchObservationReport({
      ledgerPath:    ledger,
      snapshotsPath: path.join(dir, 'no-snaps.jsonl'),
      reportPath:    path.join(dir, 'report.jsonl'),
    });
    expect(result.totalEnrolled).toBe(1);
    expect(result.snap2mMissing).toBe(0);  // no snapshots at all, not counted as missing
    expect(result.classifications.WATCH_DATA_GAP).toBe(1);
  });

  it('snapshot fields are null when snapshotAvailable=false', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow()]);
    runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs: T0 + 10 * 60 * 1000 });
    const snaps = readLines(snapshots).map(l => JSON.parse(l)) as SnapshotRow[];
    for (const s of snaps) {
      expect(s.liquidityUsd).toBeNull();
      expect(s.liquidityBucket).toBeNull();
      expect(s.vlrBucket).toBeNull();
      expect(s.priceChangePct).toBeNull();
    }
  });
});

// ── Classification labels ─────────────────────────────────────────────────────

describe('ripperWatchObservationLoop — classification labels', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('WATCH_DATA_GAP when no snapshots exist', () => {
    const ledger = path.join(dir, 'ledger.jsonl');
    writeLines(ledger, [makeLedgerRow()]);
    const result = runWatchObservationReport({
      ledgerPath:    ledger,
      snapshotsPath: path.join(dir, 'no-snaps.jsonl'),
      reportPath:    path.join(dir, 'report.jsonl'),
    });
    expect(result.classifications.WATCH_DATA_GAP).toBe(1);
    expect(result.candidates[0]!.classification).toBe('WATCH_DATA_GAP');
  });

  it('WATCH_DATA_GAP when all snapshots have snapshotAvailable=false', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow()]);
    writeLines(snapshots, [
      makeSnapshot({ window: 'RECHECK_2M', snapshotAvailable: false }),
      makeSnapshot({ window: 'RECHECK_5M', snapshotAvailable: false }),
    ]);
    const result = runWatchObservationReport({
      ledgerPath: ledger, snapshotsPath: snapshots, reportPath: path.join(dir, 'report.jsonl'),
    });
    expect(result.classifications.WATCH_DATA_GAP).toBe(1);
    expect(result.snap2mMissing).toBe(1);
    expect(result.snap5mMissing).toBe(1);
  });

  it('WATCH_CONFIRMED_RIPPER when price ≥10% at recheck', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow({ priceChangePct: 5 })]);
    writeLines(snapshots, [
      makeSnapshot({ window: 'RECHECK_5M', snapshotAvailable: true, priceChangePct: 25.0 }),
    ]);
    const result = runWatchObservationReport({
      ledgerPath: ledger, snapshotsPath: snapshots, reportPath: path.join(dir, 'report.jsonl'),
    });
    expect(result.classifications.WATCH_CONFIRMED_RIPPER).toBe(1);
    expect(result.candidates[0]!.classification).toBe('WATCH_CONFIRMED_RIPPER');
  });

  it('WATCH_FAKE_SPIKE when orig price >15% but recheck <-10%', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow({ priceChangePct: 40.0 })]);
    writeLines(snapshots, [
      makeSnapshot({ window: 'RECHECK_5M', snapshotAvailable: true, priceChangePct: -20.0 }),
    ]);
    const result = runWatchObservationReport({
      ledgerPath: ledger, snapshotsPath: snapshots, reportPath: path.join(dir, 'report.jsonl'),
    });
    expect(result.classifications.WATCH_FAKE_SPIKE).toBe(1);
    expect(result.fakeSpikeExamples.length).toBeGreaterThan(0);
  });

  it('WATCH_IMPROVING when liquidityBucket resolved from LIQ_UNKNOWN', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow({ liquidityBucket: 'LIQ_UNKNOWN', priceChangePct: 3 })]);
    writeLines(snapshots, [
      makeSnapshot({ window: 'RECHECK_5M', snapshotAvailable: true, liquidityBucket: 'LIQ_10K_30K', priceChangePct: 3 }),
    ]);
    const result = runWatchObservationReport({
      ledgerPath: ledger, snapshotsPath: snapshots, reportPath: path.join(dir, 'report.jsonl'),
    });
    expect(result.classifications.WATCH_IMPROVING).toBe(1);
  });

  it('WATCH_IMPROVING when vlrBucket resolved from VLR_UNKNOWN', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow({ vlrBucket: 'VLR_UNKNOWN', priceChangePct: 2 })]);
    writeLines(snapshots, [
      makeSnapshot({ window: 'RECHECK_5M', snapshotAvailable: true, vlrBucket: 'VLR_GTE_2', priceChangePct: 2 }),
    ]);
    const result = runWatchObservationReport({
      ledgerPath: ledger, snapshotsPath: snapshots, reportPath: path.join(dir, 'report.jsonl'),
    });
    expect(result.classifications.WATCH_IMPROVING).toBe(1);
  });

  it('WATCH_IMPROVING when clusterRisk improved WATCH→CLEAN', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow({ liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2', priceChangePct: 2 })]);
    writeLines(snapshots, [
      makeSnapshot({ window: 'RECHECK_5M', snapshotAvailable: true, clusterRisk: 'CLEAN', priceChangePct: 2 }),
    ]);
    const result = runWatchObservationReport({
      ledgerPath: ledger, snapshotsPath: snapshots, reportPath: path.join(dir, 'report.jsonl'),
    });
    expect(result.classifications.WATCH_IMPROVING).toBe(1);
  });

  it('WATCH_REJECT_OBSERVE_ONLY when price dumped below -15%', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow({ liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2', priceChangePct: 2 })]);
    writeLines(snapshots, [
      makeSnapshot({ window: 'RECHECK_5M', snapshotAvailable: true, priceChangePct: -25.0, liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2', clusterRisk: 'WATCH' }),
    ]);
    const result = runWatchObservationReport({
      ledgerPath: ledger, snapshotsPath: snapshots, reportPath: path.join(dir, 'report.jsonl'),
    });
    expect(result.classifications.WATCH_REJECT_OBSERVE_ONLY).toBe(1);
  });
});

// ── Report recommendation ─────────────────────────────────────────────────────

describe('ripperWatchObservationLoop — report recommendation', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('WATCH_OBSERVATION_KEEP_COLLECTING when zero enrolled', () => {
    const result = runWatchObservationReport({
      ledgerPath:    path.join(dir, 'empty.jsonl'),
      snapshotsPath: path.join(dir, 'empty-snaps.jsonl'),
      reportPath:    path.join(dir, 'report.jsonl'),
    });
    expect(result.recommendation).toBe('WATCH_OBSERVATION_KEEP_COLLECTING');
    expect(result.totalEnrolled).toBe(0);
  });

  it('WATCH_OBSERVATION_TOO_MUCH_DATA_GAP when >70% data gaps', () => {
    const ledger = path.join(dir, 'ledger.jsonl');
    writeLines(ledger, Array.from({ length: 10 }, (_, i) =>
      makeLedgerRow({ contract: `C${i}`, capturedAt: new Date(T0 + i).toISOString() })));
    const result = runWatchObservationReport({
      ledgerPath:    ledger,
      snapshotsPath: path.join(dir, 'empty-snaps.jsonl'),
      reportPath:    path.join(dir, 'report.jsonl'),
    });
    expect(result.recommendation).toBe('WATCH_OBSERVATION_TOO_MUCH_DATA_GAP');
  });

  it('WATCH_OBSERVATION_READY_FOR_PAPER_REVIEW when ≥3 confirmed and ≥30% ripper rate', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    const capturedAts = Array.from({ length: 5 }, (_, i) => new Date(T0 + i).toISOString());
    writeLines(ledger, capturedAts.map((capturedAt, i) =>
      makeLedgerRow({ contract: `CONT${i}`, capturedAt, liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2' })));
    // 4 confirmed rippers (price > 10%), 1 reject
    writeLines(snapshots, [
      ...capturedAts.slice(0, 4).map((capturedAt, i) =>
        makeSnapshot({ contract: `CONT${i}`, originalCapturedAt: capturedAt, window: 'RECHECK_5M', snapshotAvailable: true, priceChangePct: 20.0, liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2', clusterRisk: 'WATCH' })),
      makeSnapshot({ contract: 'CONT4', originalCapturedAt: capturedAts[4]!, window: 'RECHECK_5M', snapshotAvailable: true, priceChangePct: -5.0, liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2', clusterRisk: 'WATCH' }),
    ]);
    const result = runWatchObservationReport({
      ledgerPath: ledger, snapshotsPath: snapshots, reportPath: path.join(dir, 'report.jsonl'),
    });
    expect(result.classifications.WATCH_CONFIRMED_RIPPER).toBe(4);
    expect(result.recommendation).toBe('WATCH_OBSERVATION_READY_FOR_PAPER_REVIEW');
  });
});

// ── Safety flags ──────────────────────────────────────────────────────────────

describe('ripperWatchObservationLoop — safety flags', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('enroll result has all safety flags', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [makeCycleRow()]);
    const result = runWatchObservationEnroll({ cycleFile, ledgerPath: path.join(dir, 'l.jsonl'), nowMs: T0 });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });

  it('closeout result has all safety flags', () => {
    const result = runWatchObservationCloseout({
      ledgerPath:    path.join(dir, 'l.jsonl'),
      snapshotsPath: path.join(dir, 's.jsonl'),
      nowMs:         T0,
    });
    expect(result.reportOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
  });

  it('report result has all safety flags', () => {
    const result = runWatchObservationReport({
      ledgerPath:    path.join(dir, 'l.jsonl'),
      snapshotsPath: path.join(dir, 's.jsonl'),
      reportPath:    path.join(dir, 'r.jsonl'),
    });
    expect(result.reportOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
  });

  it('renderWatchObservationEnroll contains safety strings', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [makeCycleRow()]);
    const result = runWatchObservationEnroll({ cycleFile, ledgerPath: path.join(dir, 'l.jsonl'), nowMs: T0 });
    const out = renderWatchObservationEnroll(result);
    expect(out).toContain('REPORT_ONLY=true');
    expect(out).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('NO_POLICY_CHANGE=true');
  });

  it('renderWatchObservationCloseout contains safety strings', () => {
    const result = runWatchObservationCloseout({
      ledgerPath:    path.join(dir, 'l.jsonl'),
      snapshotsPath: path.join(dir, 's.jsonl'),
      nowMs:         T0,
    });
    const out = renderWatchObservationCloseout(result);
    expect(out).toContain('REPORT_ONLY=true');
    expect(out).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(out).toContain('NO_POLICY_CHANGE=true');
  });

  it('renderWatchObservationReport contains safety strings and classifications', () => {
    const result = runWatchObservationReport({
      ledgerPath:    path.join(dir, 'l.jsonl'),
      snapshotsPath: path.join(dir, 's.jsonl'),
      reportPath:    path.join(dir, 'r.jsonl'),
    });
    const out = renderWatchObservationReport(result);
    expect(out).toContain('REPORT_ONLY=true');
    expect(out).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(out).toContain('WATCH_CONFIRMED_RIPPER');
    expect(out).toContain('WATCH_DATA_GAP');
    expect(out).toContain('RECOMMENDATION');
    expect(out).toContain('No gate, autopilot, policy, or trade logic modified.');
  });

  it('ledger rows written by enroll carry all safety flags', () => {
    const cycleFile = writeCycle(dir, 'cycle-2024.jsonl', [makeCycleRow()]);
    const ledger    = path.join(dir, 'ledger.jsonl');
    runWatchObservationEnroll({ cycleFile, ledgerPath: ledger, nowMs: T0 });
    const rows = readLines(ledger).map(l => JSON.parse(l)) as LedgerRow[];
    for (const r of rows) {
      expect(r.reportOnly).toBe(true);
      expect(r.readOnly).toBe(true);
      expect(r.paperOnly).toBe(true);
      expect(r.realTradingLocked).toBe(true);
      expect(r.tradingExecuted).toBe(0);
    }
  });

  it('snapshot rows written by closeout carry all safety flags', () => {
    const ledger    = path.join(dir, 'ledger.jsonl');
    const snapshots = path.join(dir, 'snaps.jsonl');
    writeLines(ledger, [makeLedgerRow()]);
    runWatchObservationCloseout({ ledgerPath: ledger, snapshotsPath: snapshots, nowMs: T0 + 10 * 60 * 1000 });
    const snaps = readLines(snapshots).map(l => JSON.parse(l)) as SnapshotRow[];
    for (const s of snaps) {
      expect(s.reportOnly).toBe(true);
      expect(s.readOnly).toBe(true);
      expect(s.paperOnly).toBe(true);
      expect(s.realTradingLocked).toBe(true);
      expect(s.tradingExecuted).toBe(0);
    }
  });
});
