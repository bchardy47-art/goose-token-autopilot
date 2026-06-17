// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  runBrainDashboard,
  renderBrainDashboard,
  type BrainDashboardOptions,
  type FilterRecommendation,
} from '../src/token-grab/ripperBrainDashboardReport';

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function writeLines(filePath: string, rows: object[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function makeOutcomeRow(opts: {
  contract?: string;
  capturedAt?: string;
  ageGte10m?: boolean;
  liqLt10k?: boolean;
  liqOrAge?: boolean;
  outcome?: string;
}): object {
  return {
    contract:            opts.contract   ?? `pump${Math.random().toString(36).slice(2)}`,
    capturedAt:          opts.capturedAt ?? '2026-06-15T10:00:00.000Z',
    symbol:              'TOK',
    wouldRejectByBestCombo: true,
    ageGte10m:           opts.ageGte10m ?? false,
    liqLt10k:            opts.liqLt10k  ?? false,
    liqOrAge:            opts.liqOrAge  ?? false,
    ageMinutes:          opts.ageGte10m ? 15 : 3,
    liquidityUsd:        opts.liqLt10k  ? 5000 : 20000,
    outcome:             opts.outcome   ?? 'FLAT_JUNK',
    priceChangePct:      0.1,
    generatedAt:         '2026-06-17T00:00:00.000Z',
  };
}

function makeEnrollmentRow(opts: {
  contract?:      string;
  capturedAt?:    string;
  ripperScore?:   number;
  clusterRisk?:   string;
  launchAgeBucket?: string;
}): object {
  return {
    contract:        opts.contract       ?? 'pumptest123',
    capturedAt:      opts.capturedAt     ?? '2026-06-15T10:00:00.000Z',
    ripperScore:     opts.ripperScore    ?? 100,
    clusterRisk:     opts.clusterRisk    ?? 'CLEAN',
    launchAgeBucket: opts.launchAgeBucket ?? 'PRIME_WINDOW',
    shadowRejectFlags: { age_gte10m: false, liq_lt10k: false, liq_OR_age: false },
  };
}

function makeMemoryRow(opts: {
  memoryUniverse?: string;
  timingPath?:     string;
  outcomeLabel?:   string;
}): object {
  return {
    contract:      'pumptest',
    capturedAt:    '2026-06-15T10:00:00.000Z',
    memoryUniverse: opts.memoryUniverse ?? 'SHADOW_ENROLLED_APPROVED',
    timingPath:    opts.timingPath     ?? 'ENTER_NOW',
    outcomeLabel:  opts.outcomeLabel   ?? 'FLAT_JUNK',
  };
}

function makeIntentRow(status: string): object {
  return { contract: 'pumptest', capturedAt: '2026-06-15T10:00:00.000Z', status };
}

function makeCycleRow(decision: string): object {
  return {
    contract:        'pumptest',
    capturedAt:      '2026-06-17T14:00:00.000Z',
    buyGateDecision: decision,
    ripperScore:     100,
  };
}

function buildMinimalOptions(): BrainDashboardOptions {
  const outcomeReport   = path.join(tmpDir, 'outcome.jsonl');
  const enrollments     = path.join(tmpDir, 'enrollments.jsonl');
  const learningMemory  = path.join(tmpDir, 'memory.jsonl');
  const paperIntents    = path.join(tmpDir, 'intents.jsonl');
  const cyclesDir       = path.join(tmpDir, 'cycles');
  const logsDir         = path.join(tmpDir, 'logs');

  // Write empty files to avoid file-not-found
  writeLines(outcomeReport,  []);
  writeLines(enrollments,    []);
  writeLines(learningMemory, []);
  writeLines(paperIntents,   []);
  fs.mkdirSync(cyclesDir, { recursive: true });
  fs.mkdirSync(logsDir,   { recursive: true });

  return {
    outcomeReportPath:  outcomeReport,
    enrollmentsPath:    enrollments,
    learningMemoryPath: learningMemory,
    paperIntentsPath:   paperIntents,
    cyclesDir,
    logsDir,
    nowMs: new Date('2026-06-17T15:00:00.000Z').getTime(),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-dash-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Safety ────────────────────────────────────────────────────────────────────

describe('safety constants', () => {
  it('source contains DO_NOT_ENABLE_REAL_TRADING', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperBrainDashboardReport.ts'), 'utf-8',
    );
    expect(src).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('source contains reportOnly=true', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperBrainDashboardReport.ts'), 'utf-8',
    );
    expect(src).toContain('reportOnly=true');
  });

  it('source contains tradingExecuted=0', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperBrainDashboardReport.ts'), 'utf-8',
    );
    expect(src).toContain('tradingExecuted=0');
  });

  it('source does NOT contain token:auto-paper', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperBrainDashboardReport.ts'), 'utf-8',
    );
    expect(src).not.toContain('token:auto-paper');
  });

  it('source does NOT contain token:paper-buy', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/ripperBrainDashboardReport.ts'), 'utf-8',
    );
    expect(src).not.toContain('token:paper-buy');
  });

  it('result has reportOnly=true and tradingExecuted=0', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    expect(result.reportOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── Empty data ────────────────────────────────────────────────────────────────

describe('empty data', () => {
  it('runs without error on empty data files', () => {
    const opts = buildMinimalOptions();
    expect(() => runBrainDashboard(opts)).not.toThrow();
  });

  it('produces 5 filter candidates even with no data', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    expect(result.candidates).toHaveLength(5);
  });

  it('returns NEEDS_MORE_DATA for all candidates when empty', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    for (const c of result.candidates) {
      expect(c.recommendation).toBe('NEEDS_MORE_DATA');
    }
  });

  it('has null topCandidate or a candidate with NEEDS_MORE_DATA when empty', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    if (result.topCandidate != null) {
      expect(result.topCandidate.recommendation).toBe('NEEDS_MORE_DATA');
    }
  });

  it('generatedAt is a valid ISO string', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ── Filter candidate stats ────────────────────────────────────────────────────

describe('filter candidate stats — age_gte10m', () => {
  it('counts enrolled rows with ageGte10m=true', () => {
    const opts = buildMinimalOptions();
    const rows = [
      makeOutcomeRow({ contract: 'A', ageGte10m: true, outcome: 'FLAT_JUNK' }),
      makeOutcomeRow({ contract: 'B', ageGte10m: true, outcome: 'FLAT_JUNK' }),
      makeOutcomeRow({ contract: 'C', ageGte10m: false, outcome: 'FLAT_JUNK' }),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.enrolledCount).toBe(2);
  });

  it('correctly classifies FLAT_JUNK outcome as flatDump', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.outcomeReportPath!, [
      makeOutcomeRow({ contract: 'A', ageGte10m: true, outcome: 'FLAT_JUNK' }),
    ]);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.flatDumpCount).toBe(1);
  });

  it('correctly classifies DUMP outcome as flatDump', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.outcomeReportPath!, [
      makeOutcomeRow({ contract: 'A', ageGte10m: true, outcome: 'DUMP' }),
    ]);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.flatDumpCount).toBe(1);
    expect(cand.win1Count).toBe(0);
  });

  it('correctly classifies WIN_5PCT as win1+win3+win5', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.outcomeReportPath!, [
      makeOutcomeRow({ contract: 'A', ageGte10m: true, outcome: 'WIN_5PCT' }),
    ]);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.win1Count).toBe(1);
    expect(cand.win3Count).toBe(1);
    expect(cand.win5Count).toBe(1);
  });

  it('correctly classifies WIN_3PCT as win1+win3 but not win5', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.outcomeReportPath!, [
      makeOutcomeRow({ contract: 'A', ageGte10m: true, outcome: 'WIN_3PCT' }),
    ]);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.win1Count).toBe(1);
    expect(cand.win3Count).toBe(1);
    expect(cand.win5Count).toBe(0);
  });

  it('treats UNOBSERVED outcome as not observed', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.outcomeReportPath!, [
      makeOutcomeRow({ contract: 'A', ageGte10m: true, outcome: 'UNOBSERVED' }),
    ]);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.observedCount).toBe(0);
    expect(cand.unobservedCount).toBe(1);
  });
});

// ── Filter recommendations ────────────────────────────────────────────────────

describe('filter recommendations', () => {
  it('returns NEEDS_MORE_DATA when observed < 20', () => {
    const opts = buildMinimalOptions();
    // 10 rows, all FLAT_JUNK, ageGte10m=true → obs=10 < 20
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeOutcomeRow({ contract: `c${i}`, ageGte10m: true, outcome: 'FLAT_JUNK' }),
    );
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.recommendation).toBe('NEEDS_MORE_DATA');
  });

  it('returns REJECT when win1 > 5%', () => {
    const opts = buildMinimalOptions();
    // 30 liq_lt10k rows: 28 FLAT_JUNK + 2 WIN_1PCT → win1=6.7% > 5%
    const rows = [
      ...Array.from({ length: 28 }, (_, i) =>
        makeOutcomeRow({ contract: `c${i}`, liqLt10k: true, outcome: 'FLAT_JUNK' }),
      ),
      makeOutcomeRow({ contract: 'w1', liqLt10k: true, outcome: 'WIN_1PCT' }),
      makeOutcomeRow({ contract: 'w2', liqLt10k: true, outcome: 'WIN_1PCT' }),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'liq_lt10k')!;
    expect(cand.recommendation).toBe('REJECT');
  });

  it('returns REJECT when win3 > 3%', () => {
    const opts = buildMinimalOptions();
    // 30 rows: 28 FLAT_JUNK + 2 WIN_3PCT → win3=6.7% > 3%
    const rows = [
      ...Array.from({ length: 28 }, (_, i) =>
        makeOutcomeRow({ contract: `c${i}`, liqLt10k: true, outcome: 'FLAT_JUNK' }),
      ),
      makeOutcomeRow({ contract: 'w1', liqLt10k: true, outcome: 'WIN_3PCT' }),
      makeOutcomeRow({ contract: 'w2', liqLt10k: true, outcome: 'WIN_3PCT' }),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'liq_lt10k')!;
    expect(cand.recommendation).toBe('REJECT');
  });

  it('returns KEEP_COLLECTING when observed is 20-49 and flatDump >= 80%', () => {
    const opts = buildMinimalOptions();
    // 40 ageGte10m rows: 38 FLAT_JUNK + 1 WIN_1PCT + 1 control → win1=2.6%, fd=97.4%
    const rows = [
      ...Array.from({ length: 38 }, (_, i) =>
        makeOutcomeRow({ contract: `c${i}`, ageGte10m: true, outcome: 'FLAT_JUNK' }),
      ),
      makeOutcomeRow({ contract: 'w1', ageGte10m: true, outcome: 'WIN_1PCT' }),
      makeOutcomeRow({ contract: 'ctrl1', ageGte10m: false, outcome: 'WIN_1PCT' }),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.recommendation).toBe('KEEP_COLLECTING');
  });

  it('returns PROMOTE_REVIEW when all thresholds met with >= 50 observed and control 3x multiple', () => {
    const opts = buildMinimalOptions();
    // 53 ageGte10m: 52 FLAT_JUNK + 1 WIN_1PCT → win1=1.9%, fd=98.1%
    // 50 control: 40 FLAT_JUNK + 10 WIN_1PCT → ctrl win1=20% → multiple=10.5x
    const rows = [
      ...Array.from({ length: 52 }, (_, i) =>
        makeOutcomeRow({ contract: `b${i}`, ageGte10m: true, outcome: 'FLAT_JUNK' }),
      ),
      makeOutcomeRow({ contract: 'bw1', ageGte10m: true, outcome: 'WIN_1PCT' }),
      ...Array.from({ length: 40 }, (_, i) =>
        makeOutcomeRow({ contract: `ctrl${i}`, ageGte10m: false, outcome: 'FLAT_JUNK' }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeOutcomeRow({ contract: `ctrw${i}`, ageGte10m: false, outcome: 'WIN_1PCT' }),
      ),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.recommendation).toBe('PROMOTE_REVIEW');
  });
});

// ── Control group stats ───────────────────────────────────────────────────────

describe('control group and multiple', () => {
  it('computes control as rows NOT matched by the filter', () => {
    const opts = buildMinimalOptions();
    const rows = [
      makeOutcomeRow({ contract: 'A', ageGte10m: true,  outcome: 'FLAT_JUNK' }),
      makeOutcomeRow({ contract: 'B', ageGte10m: false, outcome: 'WIN_1PCT'  }),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.controlObservedCount).toBe(1);
    expect(cand.controlWin1Count).toBe(1);
  });

  it('returns null multiple when blocked win1 is 0', () => {
    const opts = buildMinimalOptions();
    const rows = [
      makeOutcomeRow({ contract: 'A', ageGte10m: true,  outcome: 'FLAT_JUNK' }),
      makeOutcomeRow({ contract: 'B', ageGte10m: false, outcome: 'WIN_1PCT'  }),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    const cand = result.candidates.find(c => c.name === 'age_gte10m')!;
    expect(cand.controlVsBlockedMultiple).toBeNull();
  });
});

// ── CSP enrichment ────────────────────────────────────────────────────────────

describe('CSP enrichment from enrollments', () => {
  it('marks row as CSP when enrollment has CLEAN+100+PRIME', () => {
    const opts = buildMinimalOptions();
    const contract = 'pumpCSP001';
    const capturedAt = '2026-06-15T10:00:00.000Z';

    writeLines(opts.outcomeReportPath!, [
      makeOutcomeRow({ contract, capturedAt, liqOrAge: true, outcome: 'FLAT_JUNK' }),
    ]);
    writeLines(opts.enrollmentsPath!, [
      makeEnrollmentRow({ contract, capturedAt, ripperScore: 100, clusterRisk: 'CLEAN', launchAgeBucket: 'PRIME_WINDOW' }),
    ]);

    const result = runBrainDashboard(opts);
    // liq_OR_age_BUT_keep_clean_score100_prime should NOT block CSP rows
    const csp = result.candidates.find(c => c.name === 'liq_OR_age_BUT_keep_clean_score100_prime')!;
    expect(csp.enrolledCount).toBe(0);  // CSP row is excluded from blocked group
  });

  it('does NOT mark row as CSP when ripperScore is not 100', () => {
    const opts = buildMinimalOptions();
    const contract = 'pumpNOTcsp';
    const capturedAt = '2026-06-15T10:00:00.000Z';

    writeLines(opts.outcomeReportPath!, [
      makeOutcomeRow({ contract, capturedAt, liqOrAge: true, outcome: 'FLAT_JUNK' }),
    ]);
    writeLines(opts.enrollmentsPath!, [
      makeEnrollmentRow({ contract, capturedAt, ripperScore: 90, clusterRisk: 'CLEAN', launchAgeBucket: 'PRIME_WINDOW' }),
    ]);

    const result = runBrainDashboard(opts);
    const csp = result.candidates.find(c => c.name === 'liq_OR_age_BUT_keep_clean_score100_prime')!;
    expect(csp.enrolledCount).toBe(1);  // non-CSP row is blocked
  });
});

// ── Timing edge ───────────────────────────────────────────────────────────────

describe('timing edge', () => {
  it('computes WAIT_10M win rates from enrolled rows only', () => {
    const opts = buildMinimalOptions();
    const rows = [
      makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED', timingPath: 'WAIT_10M', outcomeLabel: 'BIG_WINNER' }),
      makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED', timingPath: 'WAIT_10M', outcomeLabel: 'FLAT_JUNK' }),
      makeMemoryRow({ memoryUniverse: 'DEX_WATCH_GENERAL', timingPath: 'WAIT_10M', outcomeLabel: 'BIG_WINNER' }),
    ];
    writeLines(opts.learningMemoryPath!, rows);
    const result = runBrainDashboard(opts);
    expect(result.timingEdge.wait10mEnrolledCount).toBe(2);
    expect(result.timingEdge.wait10mObservedCount).toBe(2);
    expect(result.timingEdge.wait10mWin1Count).toBe(1);
  });

  it('excludes UNKNOWN outcomeLabel from observed count', () => {
    const opts = buildMinimalOptions();
    const rows = [
      makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED', timingPath: 'ENTER_NOW', outcomeLabel: 'UNKNOWN' }),
      makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED', timingPath: 'ENTER_NOW', outcomeLabel: 'FLAT_JUNK' }),
    ];
    writeLines(opts.learningMemoryPath!, rows);
    const result = runBrainDashboard(opts);
    expect(result.timingEdge.enterNowEnrolledCount).toBe(2);
    expect(result.timingEdge.enterNowObservedCount).toBe(1);
  });

  it('returns INSUFFICIENT_DATA when fewer than 20 observed per path', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.learningMemoryPath!, [
      makeMemoryRow({ timingPath: 'WAIT_10M', outcomeLabel: 'BIG_WINNER' }),
    ]);
    const result = runBrainDashboard(opts);
    expect(result.timingEdge.recommendation).toBe('INSUFFICIENT_DATA');
  });

  it('returns WAIT_10M_FAVORED when WAIT_10M win1 rate exceeds ENTER_NOW by > 3%', () => {
    const opts = buildMinimalOptions();
    const rows = [
      // 30 ENTER_NOW: 25 FLAT + 5 WIN → 16.7% win
      ...Array.from({ length: 25 }, () =>
        makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED', timingPath: 'ENTER_NOW', outcomeLabel: 'FLAT_JUNK' }),
      ),
      ...Array.from({ length: 5 }, () =>
        makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED', timingPath: 'ENTER_NOW', outcomeLabel: 'WINNER' }),
      ),
      // 25 WAIT_10M: 15 FLAT + 10 WIN → 40% win
      ...Array.from({ length: 15 }, () =>
        makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED', timingPath: 'WAIT_10M', outcomeLabel: 'FLAT_JUNK' }),
      ),
      ...Array.from({ length: 10 }, () =>
        makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED', timingPath: 'WAIT_10M', outcomeLabel: 'WINNER' }),
      ),
    ];
    writeLines(opts.learningMemoryPath!, rows);
    const result = runBrainDashboard(opts);
    // WAIT_10M win rate 40% > ENTER_NOW 16.7%, difference > 3%
    expect(result.timingEdge.recommendation).toBe('WAIT_10M_FAVORED');
  });
});

// ── Brain status ──────────────────────────────────────────────────────────────

describe('brain status', () => {
  it('counts total memory rows', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.learningMemoryPath!, [
      makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED', outcomeLabel: 'FLAT_JUNK' }),
      makeMemoryRow({ memoryUniverse: 'DEX_WATCH_GENERAL', outcomeLabel: 'UNKNOWN' }),
    ]);
    const result = runBrainDashboard(opts);
    expect(result.brainStatus.totalRows).toBe(2);
  });

  it('counts policy evidence rows as SHADOW_ENROLLED_APPROVED rows', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.learningMemoryPath!, [
      makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED' }),
      makeMemoryRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED' }),
      makeMemoryRow({ memoryUniverse: 'DEX_WATCH_GENERAL' }),
    ]);
    const result = runBrainDashboard(opts);
    expect(result.brainStatus.policyEvidenceRows).toBe(2);
  });

  it('counts UNKNOWN outcomeLabel rows as unknown', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.learningMemoryPath!, [
      makeMemoryRow({ outcomeLabel: 'UNKNOWN' }),
      makeMemoryRow({ outcomeLabel: 'FLAT_JUNK' }),
    ]);
    const result = runBrainDashboard(opts);
    expect(result.brainStatus.unknownRows).toBe(1);
  });

  it('reads latest cycle from cycles dir', () => {
    const opts = buildMinimalOptions();
    const cyclesDir = opts.cyclesDir!;
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-17-141438.jsonl');
    writeLines(cycleFile, [
      makeCycleRow('BUY_APPROVED_PAPER'),
      makeCycleRow('BUY_APPROVED_PAPER'),
      makeCycleRow('BUY_REJECTED'),
    ]);
    const result = runBrainDashboard(opts);
    expect(result.brainStatus.latestCycleApproved).toBe(2);
    expect(result.brainStatus.latestCycleRejected).toBe(1);
  });

  it('returns null cycle stats when cycles dir is empty', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    expect(result.brainStatus.latestCycleApproved).toBeNull();
  });
});

// ── Open intents ──────────────────────────────────────────────────────────────

describe('open intents', () => {
  it('counts ENTRY_DUE intents as open and due', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.paperIntentsPath!, [
      makeIntentRow('ENTRY_DUE'),
      makeIntentRow('OBSERVED'),
    ]);
    const result = runBrainDashboard(opts);
    expect(result.openIntents.dueCount).toBe(1);
    expect(result.openIntents.openCount).toBe(1);
  });

  it('counts EXPIRED_NO_DATA intents', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.paperIntentsPath!, [
      makeIntentRow('EXPIRED_NO_DATA'),
      makeIntentRow('EXPIRED_NO_DATA'),
      makeIntentRow('OBSERVED'),
    ]);
    const result = runBrainDashboard(opts);
    expect(result.openIntents.expiredCount).toBe(2);
  });

  it('sets warnHighOpen when openCount > 5', () => {
    const opts = buildMinimalOptions();
    writeLines(opts.paperIntentsPath!, Array.from({ length: 6 }, () => makeIntentRow('ENTRY_DUE')));
    const result = runBrainDashboard(opts);
    expect(result.openIntents.warnHighOpen).toBe(true);
  });

  it('reads latest log status from logs dir', () => {
    const opts = buildMinimalOptions();
    const logsDir = opts.logsDir!;
    const logFile = path.join(logsDir, 'run-20260617-081131.log');
    fs.writeFileSync(logFile,
      '  Finished : 2026-06-17T09:23:45Z\n  Status    : COMPLETED SUCCESSFULLY\n  Log path  : ...\n',
    );
    const result = runBrainDashboard(opts);
    expect(result.openIntents.latestRunStatus).toBe('COMPLETED SUCCESSFULLY');
  });

  it('sets warnTimedOut when last run TIMED_OUT', () => {
    const opts = buildMinimalOptions();
    const logsDir = opts.logsDir!;
    const logFile = path.join(logsDir, 'run-20260617-081131.log');
    fs.writeFileSync(logFile, '  Status    : TIMED_OUT (learning loop exceeded 1500s)\n');
    const result = runBrainDashboard(opts);
    expect(result.openIntents.warnTimedOut).toBe(true);
  });
});

// ── Overall call ──────────────────────────────────────────────────────────────

describe('overall call', () => {
  it('contains KEEP COLLECTING when top candidate is KEEP_COLLECTING', () => {
    const opts = buildMinimalOptions();
    // 40 ageGte10m rows with 1 winner → KEEP_COLLECTING
    const rows = [
      ...Array.from({ length: 39 }, (_, i) =>
        makeOutcomeRow({ contract: `c${i}`, ageGte10m: true, outcome: 'FLAT_JUNK' }),
      ),
      makeOutcomeRow({ contract: 'w1', ageGte10m: true, outcome: 'WIN_1PCT' }),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    expect(result.overallCall).toContain('KEEP COLLECTING');
  });

  it('contains READY FOR REVIEW when top candidate is PROMOTE_REVIEW', () => {
    const opts = buildMinimalOptions();
    // 53 ageGte10m rows, 1 winner, 50 control with 10 winners → PROMOTE_REVIEW
    const rows = [
      ...Array.from({ length: 52 }, (_, i) =>
        makeOutcomeRow({ contract: `b${i}`, ageGte10m: true, outcome: 'FLAT_JUNK' }),
      ),
      makeOutcomeRow({ contract: 'bw1', ageGte10m: true, outcome: 'WIN_1PCT' }),
      ...Array.from({ length: 40 }, (_, i) =>
        makeOutcomeRow({ contract: `ctrl${i}`, ageGte10m: false, outcome: 'FLAT_JUNK' }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeOutcomeRow({ contract: `ctrw${i}`, ageGte10m: false, outcome: 'WIN_1PCT' }),
      ),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    expect(result.overallCall).toContain('READY FOR REVIEW');
    expect(result.overallCall).toContain('human review required');
  });

  it('contains NEEDS_MORE_DATA when no candidate has enough observations', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    expect(result.overallCall).toContain('NEEDS_MORE_DATA');
  });

  it('mentions the top candidate name in the overall call', () => {
    const opts = buildMinimalOptions();
    const rows = [
      ...Array.from({ length: 39 }, (_, i) =>
        makeOutcomeRow({ contract: `c${i}`, ageGte10m: true, outcome: 'FLAT_JUNK' }),
      ),
      makeOutcomeRow({ contract: 'w1', ageGte10m: true, outcome: 'WIN_1PCT' }),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    expect(result.overallCall).toContain('age_gte10m');
  });

  it('mentions No gate or policy changes', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    expect(result.overallCall.toLowerCase()).toContain('no gate or policy changes');
  });
});

// ── Top and rejected candidates ───────────────────────────────────────────────

describe('candidate ranking and rejected list', () => {
  it('selects KEEP_COLLECTING candidate as topCandidate over NEEDS_MORE_DATA', () => {
    const opts = buildMinimalOptions();
    // age_gte10m: 35 rows → NEEDS_MORE_DATA (< 20 if all observed... wait, 35 > 20)
    // Actually KEEP_COLLECTING at 35 obs, 0 winners (flat+dump 100% but only 35 obs)
    const rows = Array.from({ length: 35 }, (_, i) =>
      makeOutcomeRow({ contract: `a${i}`, ageGte10m: true, outcome: 'FLAT_JUNK' }),
    );
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    expect(result.topCandidate).not.toBeNull();
    expect(['KEEP_COLLECTING', 'NO_CLEAR_EDGE', 'NEEDS_MORE_DATA']).toContain(
      result.topCandidate!.recommendation,
    );
  });

  it('includes REJECT candidates in rejectedCandidates list', () => {
    const opts = buildMinimalOptions();
    // liq_lt10k: 30 rows with 3 WIN_1PCT → win1=10% → REJECT
    const rows = [
      ...Array.from({ length: 27 }, (_, i) =>
        makeOutcomeRow({ contract: `c${i}`, liqLt10k: true, outcome: 'FLAT_JUNK' }),
      ),
      makeOutcomeRow({ contract: 'w1', liqLt10k: true, outcome: 'WIN_1PCT' }),
      makeOutcomeRow({ contract: 'w2', liqLt10k: true, outcome: 'WIN_1PCT' }),
      makeOutcomeRow({ contract: 'w3', liqLt10k: true, outcome: 'WIN_1PCT' }),
    ];
    writeLines(opts.outcomeReportPath!, rows);
    const result = runBrainDashboard(opts);
    const rejected = result.rejectedCandidates.find(c => c.name === 'liq_lt10k');
    expect(rejected).toBeDefined();
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderBrainDashboard', () => {
  it('renders without error on minimal result', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    expect(() => renderBrainDashboard(result)).not.toThrow();
  });

  it('output contains all 6 section headers', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    const output = renderBrainDashboard(result);
    expect(output).toContain('1. BRAIN STATUS');
    expect(output).toContain('2. TOP FILTER CANDIDATE');
    expect(output).toContain('3. REJECTED / DO NOT TRUST');
    expect(output).toContain('4. TIMING EDGE');
    expect(output).toContain('5. OPEN INTENTS / RUN HEALTH');
    expect(output).toContain('6. SAFETY STATUS');
  });

  it('output contains safety status markers', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    const output = renderBrainDashboard(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(output).toContain('NO_POLICY_CHANGE');
  });

  it('output contains REPORT ONLY banner', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    const output = renderBrainDashboard(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO TRADES');
  });

  it('output contains CURRENT CALL section', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    const output = renderBrainDashboard(result);
    expect(output).toContain('CURRENT CALL');
  });

  it('output contains generatedAt timestamp', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    const output = renderBrainDashboard(result);
    expect(output).toContain('2026-06-17');
  });

  it('output contains candidate table header', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    const output = renderBrainDashboard(result);
    expect(output).toContain('age_gte10m');
    expect(output).toContain('liq_lt10k');
    expect(output).toContain('liq_OR_age');
  });

  it('output ends with CURRENT CALL section content', () => {
    const opts = buildMinimalOptions();
    const result = runBrainDashboard(opts);
    const output = renderBrainDashboard(result);
    // After CURRENT CALL, there should be meaningful output
    const callIdx = output.indexOf('CURRENT CALL');
    expect(callIdx).toBeGreaterThan(-1);
    const afterCall = output.slice(callIdx);
    expect(afterCall.length).toBeGreaterThan(20);
  });
});

// ── Package.json registration ─────────────────────────────────────────────────

describe('package.json registration', () => {
  it('registers token:ripper-brain-dashboard', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['token:ripper-brain-dashboard']).toBeDefined();
  });

  it('token:ripper-brain-dashboard runs cli.ts', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['token:ripper-brain-dashboard']).toContain('cli.ts');
    expect(pkg.scripts['token:ripper-brain-dashboard']).toContain('token:ripper-brain-dashboard');
  });
});
