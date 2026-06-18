import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runWatchProfileEnrollment,
  renderWatchProfileEnrollment,
  WATCH_PROFILE_DEFS,
  WatchProfileEnrollmentOptions,
} from '../src/token-grab/ripperWatchProfileEnrollment';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wpEnroll-'));
}

function writeLines(filePath: string, rows: object[]): void {
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function readEnrollments(filePath: string): object[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// Base memory row with all feature fields filled in
const ROW_A = {
  contract:       'AAAA1111',
  capturedAt:     '2026-06-01T00:00:00.000Z',
  cycleId:        'cycle-001',
  memoryUniverse: 'enrolled',
  gateDecision:   'APPROVE',
  liquidityBucket:'LIQ_10K_30K',
  vlrBucket:      'VLR_0_5_TO_2',
  clusterRisk:    'UNKNOWN',
  timingPath:     'ENTER_NOW',
  ripperScore:    72,
  launchAgeBucket:'AGE_5_15_MIN',
  outcomeLabel:   'WINNER',
  priceChangePct: 12.5,
};

// Profile B+C match: LIQ_30K_100K + VLR_0_5_TO_2
const ROW_B = {
  ...ROW_A,
  contract:       'BBBB2222',
  liquidityBucket:'LIQ_30K_100K',
  vlrBucket:      'VLR_0_5_TO_2',
  clusterRisk:    'LOW',
  timingPath:     'ENTER_NOW',
};

// Profile A only: VLR_0_5_TO_2 + clusterRisk=UNKNOWN (wrong liq bucket)
const ROW_C = {
  ...ROW_A,
  contract:       'CCCC3333',
  liquidityBucket:'LIQ_100K_500K',
  vlrBucket:      'VLR_0_5_TO_2',
  clusterRisk:    'UNKNOWN',
  timingPath:     'WAIT',
};

// No profile match
const ROW_MISS = {
  ...ROW_A,
  contract:       'MISS4444',
  liquidityBucket:'LIQ_100K_500K',
  vlrBucket:      'VLR_2_TO_10',
  clusterRisk:    'LOW',
  timingPath:     'WAIT',
};

// ── Safety field tests ────────────────────────────────────────────────────────

describe('ripperWatchProfileEnrollment — safety fields', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('result has all required safety fields', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_A]);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });

  it('enrolled rows have safety fields locked to true/0', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_A]);
    runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    const rows = readEnrollments(outPath) as any[];
    for (const row of rows) {
      expect(row.reportOnly).toBe(true);
      expect(row.readOnly).toBe(true);
      expect(row.paperOnly).toBe(true);
      expect(row.realTradingLocked).toBe(true);
      expect(row.tradingExecuted).toBe(0);
    }
  });
});

// ── Profile matching ──────────────────────────────────────────────────────────

describe('ripperWatchProfileEnrollment — profile matching', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('profile A matches VLR_0_5_TO_2 + UNKNOWN', () => {
    const defA = WATCH_PROFILE_DEFS[0]!;
    expect(defA.matches(ROW_A as any)).toBe(true);
    expect(defA.matches({ ...ROW_A, vlrBucket: 'VLR_2_TO_10' } as any)).toBe(false);
    expect(defA.matches({ ...ROW_A, clusterRisk: 'LOW' } as any)).toBe(false);
  });

  it('profile B matches LIQ_30K_100K + VLR_0_5_TO_2', () => {
    const defB = WATCH_PROFILE_DEFS[1]!;
    expect(defB.matches(ROW_B as any)).toBe(true);
    expect(defB.matches({ ...ROW_B, liquidityBucket: 'LIQ_10K_30K' } as any)).toBe(false);
    expect(defB.matches({ ...ROW_B, vlrBucket: 'VLR_2_TO_10' } as any)).toBe(false);
  });

  it('profile C matches LIQ_30K_100K + VLR_0_5_TO_2 + ENTER_NOW', () => {
    const defC = WATCH_PROFILE_DEFS[2]!;
    expect(defC.matches(ROW_B as any)).toBe(true); // ROW_B has timingPath=ENTER_NOW
    expect(defC.matches({ ...ROW_B, timingPath: 'WAIT' } as any)).toBe(false);
  });

  it('non-matching row is not enrolled', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_MISS]);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    expect(result.enrollmentsAppended).toBe(0);
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it('ROW_A matches profile A only', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_C]); // LIQ_100K_500K, VLR_0_5_TO_2, UNKNOWN
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    expect(result.enrollmentsAppended).toBe(1);
    const rows = readEnrollments(outPath) as any[];
    expect(rows[0].profileName).toBe('VLR_0_5_TO_2+CLUSTER_UNKNOWN');
  });

  it('ROW_B matches profiles B and C', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_B]);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    expect(result.enrollmentsAppended).toBe(2);
    const rows = readEnrollments(outPath) as any[];
    const names = rows.map((r: any) => r.profileName).sort();
    expect(names).toContain('LIQ_30K_100K+VLR_0_5_TO_2');
    expect(names).toContain('LIQ_30K_100K+VLR_0_5_TO_2+ENTER_NOW');
  });
});

// ── Enrollment output ─────────────────────────────────────────────────────────

describe('ripperWatchProfileEnrollment — output rows', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('enrollment row has all required fields', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_A]);
    runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    const rows = readEnrollments(outPath) as any[];
    const row = rows[0];
    expect(row.enrolledAt).toBeDefined();
    expect(row.capturedAt).toBe(ROW_A.capturedAt);
    expect(row.contract).toBe(ROW_A.contract);
    expect(row.profileName).toBeDefined();
    expect(row.profileLabel).toBeDefined();
    expect(row.liquidityBucket).toBe(ROW_A.liquidityBucket);
    expect(row.vlrBucket).toBe(ROW_A.vlrBucket);
    expect(row.clusterRisk).toBe(ROW_A.clusterRisk);
    expect(row.timingPath).toBe(ROW_A.timingPath);
    expect(row.ripperScore).toBe(ROW_A.ripperScore);
    expect(row.cycleId).toBe(ROW_A.cycleId);
    expect(row.memoryUniverse).toBe(ROW_A.memoryUniverse);
    expect(row.gateDecision).toBe(ROW_A.gateDecision);
  });

  it('missing feature fields stored as null', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    const sparse = { contract: 'SPARSE11', vlrBucket: 'VLR_0_5_TO_2', clusterRisk: 'UNKNOWN' };
    writeLines(memPath, [sparse]);
    runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    const rows = readEnrollments(outPath) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].liquidityBucket).toBeNull();
    expect(rows[0].timingPath).toBeNull();
    expect(rows[0].ripperScore).toBeNull();
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('ripperWatchProfileEnrollment — deduplication', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('re-running with same memory does not duplicate', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_A]);
    const r1 = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    const r2 = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    expect(r1.enrollmentsAppended).toBeGreaterThan(0);
    expect(r2.enrollmentsAppended).toBe(0);
    expect(r2.duplicatesSkipped).toBeGreaterThan(0);
    const rows = readEnrollments(outPath);
    expect(rows.length).toBe(r1.enrollmentsAppended);
  });

  it('same contract enrolled under different profiles is allowed', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    // ROW_B matches profiles B and C
    writeLines(memPath, [ROW_B]);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    expect(result.enrollmentsAppended).toBe(2);
  });

  it('same contract+profile key within a single run enrolled only once', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    // Two identical rows should not double-enroll
    writeLines(memPath, [ROW_A, ROW_A]);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    const rows = readEnrollments(outPath) as any[];
    const profileARows = rows.filter((r: any) => r.profileName === 'VLR_0_5_TO_2+CLUSTER_UNKNOWN');
    expect(profileARows.length).toBe(1);
    expect(result.duplicatesSkipped).toBeGreaterThan(0);
  });
});

// ── Memory reading ────────────────────────────────────────────────────────────

describe('ripperWatchProfileEnrollment — memory file handling', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('missing memory file returns zero reads', () => {
    const memPath = path.join(dir, 'missing.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    expect(result.memoryRowsRead).toBe(0);
    expect(result.enrollmentsAppended).toBe(0);
  });

  it('rows without contract field are skipped', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [
      { vlrBucket: 'VLR_0_5_TO_2', clusterRisk: 'UNKNOWN' }, // no contract
      ROW_A,
    ]);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    expect(result.memoryRowsRead).toBe(1); // only ROW_A counted
  });

  it('invalid JSON lines are skipped', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    fs.writeFileSync(memPath, `{invalid json}\n${JSON.stringify(ROW_A)}\n`);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    expect(result.memoryRowsRead).toBe(1);
  });

  it('counts memoryRowsRead for all valid-contract rows', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_A, ROW_B, ROW_MISS]);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    expect(result.memoryRowsRead).toBe(3);
  });
});

// ── perProfile totals ─────────────────────────────────────────────────────────

describe('ripperWatchProfileEnrollment — perProfile counts', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('perProfile totalEnrolled accumulates across runs', () => {
    const memPath1 = path.join(dir, 'mem1.jsonl');
    const memPath2 = path.join(dir, 'mem2.jsonl');
    const outPath  = path.join(dir, 'enroll.jsonl');
    // First run: ROW_A matches profile A
    writeLines(memPath1, [ROW_A]);
    const r1 = runWatchProfileEnrollment({ learningMemoryPath: memPath1, outPath });
    const profA1 = r1.perProfile.find(p => p.profileName === 'VLR_0_5_TO_2+CLUSTER_UNKNOWN')!;
    expect(profA1.totalEnrolled).toBe(1);

    // Second run: a new contract matches profile A
    const newA = { ...ROW_A, contract: 'NEW_AAAA' };
    writeLines(memPath2, [newA]);
    const r2 = runWatchProfileEnrollment({ learningMemoryPath: memPath2, outPath });
    const profA2 = r2.perProfile.find(p => p.profileName === 'VLR_0_5_TO_2+CLUSTER_UNKNOWN')!;
    expect(profA2.totalEnrolled).toBe(2);
    expect(profA2.newEnrollments).toBe(1);
  });
});

// ── nowMs / enrolledAt ────────────────────────────────────────────────────────

describe('ripperWatchProfileEnrollment — timestamp', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('uses nowMs for enrolledAt', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    const nowMs = new Date('2026-06-15T12:00:00.000Z').getTime();
    writeLines(memPath, [ROW_A]);
    runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath, nowMs });
    const rows = readEnrollments(outPath) as any[];
    expect(rows[0].enrolledAt).toBe('2026-06-15T12:00:00.000Z');
  });
});

// ── Custom profiles (test override) ──────────────────────────────────────────

describe('ripperWatchProfileEnrollment — custom profiles', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('accepts custom profile list for testing', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_A]);
    const customProfiles = [{
      name:    'TEST_PROFILE',
      label:   'test only',
      matches: (r: any) => r.contract === 'AAAA1111',
    }];
    const result = runWatchProfileEnrollment({
      learningMemoryPath: memPath,
      outPath,
      profiles: customProfiles,
    });
    expect(result.enrollmentsAppended).toBe(1);
    const rows = readEnrollments(outPath) as any[];
    expect(rows[0].profileName).toBe('TEST_PROFILE');
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('ripperWatchProfileEnrollment — renderer', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('renders safety strings', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_A]);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    const output = renderWatchProfileEnrollment(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO TRADES');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('HOLD_CURRENT_GATES');
    expect(output).toContain('NO_POLICY_CHANGE');
  });

  it('renders per-profile section', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_A]);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    const output = renderWatchProfileEnrollment(result);
    expect(output).toContain('PER-PROFILE COUNTS');
    expect(output).toContain('VLR_0_5_TO_2+CLUSTER_UNKNOWN');
  });

  it('renders counts', () => {
    const memPath = path.join(dir, 'mem.jsonl');
    const outPath = path.join(dir, 'enroll.jsonl');
    writeLines(memPath, [ROW_A]);
    const result = runWatchProfileEnrollment({ learningMemoryPath: memPath, outPath });
    const output = renderWatchProfileEnrollment(result);
    expect(output).toContain('Memory rows read');
    expect(output).toContain('New enrollments');
    expect(output).toContain('Duplicates skipped');
  });
});
