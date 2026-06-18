import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runWatchProfileOutcomeReport,
  renderWatchProfileOutcomeReport,
} from '../src/token-grab/ripperWatchProfileOutcomeReport';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wpOutcome-'));
}

function writeLines(filePath: string, rows: object[]): void {
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// Enrollment rows
function enroll(contract: string, profileName: string, profileLabel = 'test'): object {
  return { contract, profileName, profileLabel };
}

// Memory rows
function mem(contract: string, outcomeLabel: string | null, priceChangePct: number | null = null): object {
  return { contract, outcomeLabel, priceChangePct, memoryUniverse: 'enrolled' };
}

// ── Safety fields ─────────────────────────────────────────────────────────────

describe('ripperWatchProfileOutcomeReport — safety fields', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('result has all required safety fields', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, []);
    writeLines(mp, []);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });
});

// ── Missing files ─────────────────────────────────────────────────────────────

describe('ripperWatchProfileOutcomeReport — missing files', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('handles missing enrollment file gracefully', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [mem('AAA', 'WINNER', 10)]);
    const result = runWatchProfileOutcomeReport({
      enrollmentsPath:    path.join(dir, 'missing.jsonl'),
      learningMemoryPath: mp,
    });
    expect(result.enrollmentsRead).toBe(0);
    expect(result.profiles.length).toBe(0);
  });

  it('handles missing memory file gracefully', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    writeLines(ep, [enroll('AAA', 'PROFILE_X')]);
    const result = runWatchProfileOutcomeReport({
      enrollmentsPath:    ep,
      learningMemoryPath: path.join(dir, 'missing.jsonl'),
    });
    expect(result.memoryRowsRead).toBe(0);
    expect(result.baselineWin5Rate).toBeNull();
  });
});

// ── Baseline rate ─────────────────────────────────────────────────────────────

describe('ripperWatchProfileOutcomeReport — baseline', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('computes baseline win5 rate from all labeled memory rows', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, []);
    writeLines(mp, [
      mem('A1', 'BIG_WINNER', 30),  // win5
      mem('A2', 'WINNER',     15),  // win5
      mem('A3', 'SMALL_WINNER', 5),
      mem('A4', 'FLAT_JUNK',   0),
      mem('A5', 'DUMP',       -20),
    ]);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    expect(result.baselineWin5Rate).toBeCloseTo(2 / 5);
  });

  it('baseline null when no labeled rows', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, []);
    writeLines(mp, [{ contract: 'X1' }]); // no outcomeLabel
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    expect(result.baselineWin5Rate).toBeNull();
  });
});

// ── Per-profile stats ─────────────────────────────────────────────────────────

describe('ripperWatchProfileOutcomeReport — per-profile stats', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('computes win5/win3/flatDump counts and rates', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, [
      enroll('A1', 'PROF_X'),
      enroll('A2', 'PROF_X'),
      enroll('A3', 'PROF_X'),
      enroll('A4', 'PROF_X'),
    ]);
    writeLines(mp, [
      mem('A1', 'BIG_WINNER', 30),
      mem('A2', 'WINNER',     15),
      mem('A3', 'FLAT_JUNK',   0),
      mem('A4', 'DUMP',       -10),
      // extra memory row not in enrollments — should not affect profile stats
      mem('A5', 'BIG_WINNER', 50),
    ]);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'PROF_X')!;
    expect(p.enrolled).toBe(4);
    expect(p.observed).toBe(4);
    expect(p.unobserved).toBe(0);
    expect(p.win5Count).toBe(2);
    expect(p.win3Count).toBe(2);
    expect(p.flatDumpCount).toBe(2);
    expect(p.win5Rate).toBeCloseTo(0.5);
    expect(p.flatDumpRate).toBeCloseTo(0.5);
  });

  it('unobserved = enrolled - observed', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, [
      enroll('A1', 'PROF_Y'),
      enroll('A2', 'PROF_Y'),
      enroll('A3', 'PROF_Y'),
    ]);
    writeLines(mp, [
      mem('A1', 'WINNER', 12), // observed
      // A2, A3 not in memory
    ]);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'PROF_Y')!;
    expect(p.enrolled).toBe(3);
    expect(p.observed).toBe(1);
    expect(p.unobserved).toBe(2);
  });

  it('avgMove and medianMove computed from priceChangePct', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, [
      enroll('A1', 'PROF_Z'),
      enroll('A2', 'PROF_Z'),
      enroll('A3', 'PROF_Z'),
    ]);
    writeLines(mp, [
      mem('A1', 'WINNER',   10),
      mem('A2', 'FLAT_JUNK', 0),
      mem('A3', 'DUMP',     -5),
    ]);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'PROF_Z')!;
    expect(p.avgMove).toBeCloseTo((10 + 0 + -5) / 3);
    expect(p.medianMove).toBeCloseTo(0); // sorted: -5, 0, 10 → median = 0
  });

  it('avgMove and medianMove null when no priceChangePct', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, [enroll('A1', 'PROF_W')]);
    writeLines(mp, [{ contract: 'A1', outcomeLabel: 'WINNER' }]); // no priceChangePct
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'PROF_W')!;
    expect(p.avgMove).toBeNull();
    expect(p.medianMove).toBeNull();
  });
});

// ── win5Lift ──────────────────────────────────────────────────────────────────

describe('ripperWatchProfileOutcomeReport — win5Lift', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('win5Lift = profile win5Rate / baseline win5Rate', () => {
    // All rows count toward baseline.
    // Memory: X1=WINNER, X2-X4=FLAT, E1=BIG_WINNER, E2=WINNER → 3/6 = 0.5 baseline
    // Profile enrolled: E1, E2 → 2/2 = 1.0 profile win5 → lift = 1.0/0.5 = 2x
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, [
      enroll('E1', 'PROF_LIFT'),
      enroll('E2', 'PROF_LIFT'),
    ]);
    writeLines(mp, [
      mem('X1', 'WINNER',    10),   // baseline winner
      mem('X2', 'FLAT_JUNK',  0),
      mem('X3', 'FLAT_JUNK',  0),
      mem('X4', 'DUMP',      -5),
      mem('E1', 'BIG_WINNER', 30),  // profile winner
      mem('E2', 'WINNER',     15),  // profile winner
    ]);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'PROF_LIFT')!;
    // baseline = 3/6 = 0.5, profile = 2/2 = 1.0, lift = 2.0
    expect(p.win5Lift).toBeCloseTo(2.0);
  });

  it('win5Lift null when baseline win5Rate is 0 (no winners at all)', () => {
    // baseline = 0 because no WINNER/BIG_WINNER in memory at all
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, [enroll('E1', 'PROF_X')]);
    writeLines(mp, [
      mem('X1', 'FLAT_JUNK',  0),
      mem('E1', 'FLAT_JUNK',  0),  // enrolled but not a winner
    ]);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'PROF_X')!;
    expect(p.win5Lift).toBeNull();
  });

  it('win5Lift null when observed=0', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, [enroll('E1', 'PROF_NONE')]);
    writeLines(mp, [mem('X1', 'WINNER', 10)]);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'PROF_NONE')!;
    expect(p.win5Lift).toBeNull();
  });
});

// ── Recommendation logic ──────────────────────────────────────────────────────

describe('ripperWatchProfileOutcomeReport — recommendation', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function makeScenario(
    dir: string,
    profileName: string,
    outcomes: { label: string; price?: number }[],
    baselineWinners = 1,
    baselineTotal = 4,
  ) {
    const ep = path.join(dir, `${profileName}-e.jsonl`);
    const mp = path.join(dir, `${profileName}-m.jsonl`);
    const enrollRows = outcomes.map((_, i) => enroll(`C${i}`, profileName));
    const memRows = [
      // baseline rows (contracts not in profile)
      ...Array.from({ length: baselineTotal }, (_, i) =>
        mem(`BL${i}`, i < baselineWinners ? 'BIG_WINNER' : 'FLAT_JUNK', 0)),
      // profile rows
      ...outcomes.map((o, i) => mem(`C${i}`, o.label as any, o.price ?? 0)),
    ];
    writeLines(ep, enrollRows);
    writeLines(mp, memRows);
    return { ep, mp };
  }

  it('NEEDS_MORE_DATA when observed < 75', () => {
    const { ep, mp } = makeScenario(dir, 'FEW', Array.from({ length: 10 }, () => ({ label: 'WINNER', price: 10 })));
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'FEW')!;
    expect(p.recommendation).toBe('NEEDS_MORE_DATA');
  });

  it('WATCH_PROFILE_REJECT when flatDump > 80%', () => {
    const outcomes = [
      ...Array.from({ length: 85 }, () => ({ label: 'DUMP', price: -10 })),
      ...Array.from({ length: 15 }, () => ({ label: 'WINNER', price: 15 })),
    ];
    const { ep, mp } = makeScenario(dir, 'REJECT', outcomes, 10, 50);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'REJECT')!;
    expect(p.recommendation).toBe('WATCH_PROFILE_REJECT');
  });

  it('WATCH_PROFILE_PROMISING when all criteria met', () => {
    // 75+ observed, win5Lift >= 1.5x, win1 >= 35%, flatDump <= 65%
    // Profile: 50% win5, 50% flatDump → need baseline win5 <= 33% for 1.5x lift
    const outcomes = [
      ...Array.from({ length: 40 }, () => ({ label: 'BIG_WINNER', price: 20 })),
      ...Array.from({ length: 35 }, () => ({ label: 'FLAT_JUNK',  price: 0  })),
      ...Array.from({ length: 25 }, () => ({ label: 'DUMP',       price: -5 })),
    ];
    // baseline: 10/100 = 10% → profile 40/100 = 40% → lift=4x
    const { ep, mp } = makeScenario(dir, 'PROMISING', outcomes, 10, 100);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'PROMISING')!;
    expect(p.recommendation).toBe('WATCH_PROFILE_PROMISING');
  });

  it('WATCH_PROFILE_HOLD when obs >= 75 but criteria not met', () => {
    const outcomes = Array.from({ length: 80 }, () => ({ label: 'FLAT_JUNK', price: 0 }));
    // flatDump = 100% but wait... that should be REJECT.
    // Use mixed: 30% win5, 50% flatDump — doesn't reach PROMISING criteria
    const mixed = [
      ...Array.from({ length: 24 }, () => ({ label: 'WINNER',    price: 10 })),
      ...Array.from({ length: 40 }, () => ({ label: 'FLAT_JUNK', price: 0  })),
      ...Array.from({ length: 16 }, () => ({ label: 'DUMP',      price: -5 })),
    ];
    // baseline 1/1 = 100% → lift < 1 → not PROMISING
    const { ep, mp } = makeScenario(dir, 'HOLD', mixed, 1, 1);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const p = result.profiles.find(x => x.profileName === 'HOLD')!;
    expect(p.recommendation).toBe('WATCH_PROFILE_HOLD');
  });
});

// ── Multiple profiles ─────────────────────────────────────────────────────────

describe('ripperWatchProfileOutcomeReport — multiple profiles', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports each enrolled profile separately', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, [
      enroll('A1', 'PROFILE_ALPHA', 'alpha profile'),
      enroll('B1', 'PROFILE_BETA',  'beta profile'),
    ]);
    writeLines(mp, [
      mem('A1', 'WINNER',    10),
      mem('B1', 'FLAT_JUNK',  0),
    ]);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const names = result.profiles.map(p => p.profileName).sort();
    expect(names).toContain('PROFILE_ALPHA');
    expect(names).toContain('PROFILE_BETA');
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('ripperWatchProfileOutcomeReport — renderer', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('renders safety strings', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, []);
    writeLines(mp, []);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const output = renderWatchProfileOutcomeReport(result);
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('NO TRADES');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('HOLD_CURRENT_GATES');
    expect(output).toContain('NO_POLICY_CHANGE');
  });

  it('renders profile section with recommendation', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, [enroll('A1', 'MY_PROFILE', 'my label')]);
    writeLines(mp, [mem('A1', 'WINNER', 10), mem('BL', 'FLAT_JUNK', 0)]);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const output = renderWatchProfileOutcomeReport(result);
    expect(output).toContain('MY_PROFILE');
    expect(output).toContain('NEEDS_MORE_DATA');
  });

  it('renders NEEDS_MORE_DATA message when enrollments empty', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, []);
    writeLines(mp, []);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const output = renderWatchProfileOutcomeReport(result);
    expect(output).toContain('No enrolled profiles found');
  });

  it('renders baseline win5 rate', () => {
    const ep = path.join(dir, 'enroll.jsonl');
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(ep, []);
    writeLines(mp, [
      mem('X1', 'WINNER', 10),
      mem('X2', 'FLAT_JUNK', 0),
    ]);
    const result = runWatchProfileOutcomeReport({ enrollmentsPath: ep, learningMemoryPath: mp });
    const output = renderWatchProfileOutcomeReport(result);
    expect(output).toContain('Baseline win5 rate');
    expect(output).toContain('50.0%');
  });
});
