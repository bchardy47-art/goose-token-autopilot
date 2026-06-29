// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  tradingExecuted=0
//
// Regression guard for the fast-test dry-run plumbing bug: --dry-run-enroll must prevent ALL
// cohort writes inside token:ripper-fast-test, INCLUDING the inner ripper-learning-loop watch
// cohort enroll path. Previously the learning loop ignored the flag and appended a row while the
// final fast-test family-enroll section said DRY RUN — the two disagreed and a cohort file mutated.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { enrollWatchCohort } from '../src/token-grab/ripperWatchCohort';
import {
  enrollCohortFamily, runFamilyReport, laneFilePath, researchLaneFilePath, LANES,
} from '../src/token-grab/ripperWatchCohortFamily';
import { runFastTest, type FastTestDeps } from '../src/token-grab/ripperFastTest';

const CLI_SRC = fs.readFileSync(path.resolve(__dirname, '../src/cli.ts'), 'utf-8');

// ── CLI plumbing guards (prevent regression of the exact wiring gap) ────────────────────

describe('fast-test → learning-loop --dry-run-enroll plumbing', () => {
  it('fast-test derives a dry-run flag from --dry-run-enroll', () => {
    expect(CLI_SRC).toMatch(/ftDryRunEnroll\s*=\s*process\.argv\.includes\(['"]--dry-run-enroll['"]\)/);
  });

  it('fast-test FORWARDS --dry-run-enroll into the spawned learning loop', () => {
    // The spawn args for the inner learning loop must conditionally include --dry-run-enroll.
    expect(CLI_SRC).toMatch(/if\s*\(\s*ftDryRunEnroll\s*\)\s*llArgs\.push\(['"]--dry-run-enroll['"]\)/);
  });

  it('learning-loop case derives rllDryRunEnroll from --dry-run-enroll', () => {
    expect(CLI_SRC).toMatch(/rllDryRunEnroll\s*=\s*process\.argv\.includes\(['"]--dry-run-enroll['"]\)/);
  });

  it('learning-loop watch-cohort enroll passes dryRun: rllDryRunEnroll (so it can NO-WRITE)', () => {
    expect(CLI_SRC).toMatch(/enrollWatchCohort\(\{[\s\S]*?dryRun:\s*rllDryRunEnroll[\s\S]*?\}\)/);
  });
});

// ── Functional reinforcement: the exact enroll call the loop makes, under dry-run ───────

describe('enrollWatchCohort dry-run (the inner loop path) writes no cohort file', () => {
  let dir: string, cyclesDir: string, cohortPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftdry-'));
    cyclesDir = path.join(dir, 'cycles');
    cohortPath = path.join(dir, 'watch-cohort.jsonl');
    fs.mkdirSync(cyclesDir);
    // A real watch hit (ENTER_NOW + m5 -20..-5 + LIQ_10K_30K, approved, cluster UNKNOWN).
    fs.writeFileSync(path.join(cyclesDir, 'cycle-2026-06-27-090000.jsonl'),
      JSON.stringify({
        capturedAt: '2026-06-27T09:00:00.000Z', buyGateDecision: 'BUY_APPROVED_PAPER',
        entryDecision: 'READY_TO_SNIPE_PAPER', entryMomentumPct: -10, ripperScore: 90,
        launchAgeBucket: 'PRIME_WINDOW',
        normalizedSignal: { contract: 'K1', symbol: 'S1', liquidityUsd: 20000, volumeLiquidityRatio: 1 },
        ripperInput: { contract: 'K1', clusterRisk: 'UNKNOWN' },
      }) + '\n', 'utf-8');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('dry-run reports a would-append hit but writes nothing; UNKNOWN never becomes CLEAN', () => {
    const r = enrollWatchCohort({ cyclesDir, cohortPath, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.hitsFound).toBe(1);          // there WAS a real hit
    expect(r.rowsAppended).toBe(1);       // would append
    expect(fs.existsSync(cohortPath)).toBe(false); // but wrote nothing
    // Sanity: cluster of the hit stays UNKNOWN (research/strict never relabel to CLEAN).
    expect(r.appendedRows[0]?.clusterRisk).toBe('UNKNOWN');
    expect(r.appendedRows[0]?.clusterRisk).not.toBe('CLEAN');
  });

  it('non-dry-run DOES write — proving dry-run is what suppresses the inner-loop write', () => {
    const r = enrollWatchCohort({ cyclesDir, cohortPath, dryRun: false });
    expect(r.rowsAppended).toBe(1);
    expect(fs.existsSync(cohortPath)).toBe(true);
    expect(fs.readFileSync(cohortPath, 'utf-8').split('\n').filter(Boolean)).toHaveLength(1);
  });
});

// ── Full fast-test orchestration: dry-run writes NOTHING across ALL four enroll paths ───
// Drives runFastTest with the REAL enroll functions (same calls the CLI makes), so the test
// covers: internal learning-loop, strict watch-cohort enroll, cohort family enroll, and the
// NO_BM_RESEARCH lane — all at once, deterministically and without any network.

describe('runFastTest --dry-run-enroll writes no cohort files anywhere', () => {
  let dir: string, cyclesDir: string, dataDir: string, watchCohortPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftall-'));
    cyclesDir = path.join(dir, 'cycles');
    dataDir   = path.join(dir, 'data');
    watchCohortPath = path.join(dir, 'watch-cohort.jsonl');
    fs.mkdirSync(cyclesDir); fs.mkdirSync(dataDir);
    // One approved row that is a hit for ALL paths: strict watch (EXACT), family lanes, and
    // NO_BM_RESEARCH (ENTER_NOW + m5 -20..-5 + LIQ_10K_30K + score 90, cluster UNKNOWN).
    fs.writeFileSync(path.join(cyclesDir, 'cycle-2026-06-29-090000.jsonl'),
      JSON.stringify({
        capturedAt: '2026-06-29T09:00:00.000Z', buyGateDecision: 'BUY_APPROVED_PAPER',
        entryDecision: 'READY_TO_SNIPE_PAPER', entryMomentumPct: -10, ripperScore: 90,
        launchAgeBucket: 'PRIME_WINDOW',
        normalizedSignal: { contract: 'ALLHIT1', symbol: 'AH', liquidityUsd: 20000, volumeLiquidityRatio: 1 },
        ripperInput: { contract: 'ALLHIT1', clusterRisk: 'UNKNOWN' },
      }) + '\n', 'utf-8');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Deps mirror the CLI fast-test wiring: the learning-loop dep forwards dryRunEnroll to the
  // strict watch enroll; enrollFamily receives runFastTest's dryRunEnroll.
  function deps(dryRunEnroll: boolean): FastTestDeps {
    return {
      refreshFeed: () => {},
      runLearningLoop: () => {
        // mirrors CLI: inner learning-loop's watch-cohort enroll honoring --dry-run-enroll
        enrollWatchCohort({ cyclesDir, cohortPath: watchCohortPath, dryRun: dryRunEnroll });
      },
      latestCycle: () => ({ id: 'cycle-2026-06-29-090000', time: '2026-06-29T09:00:00Z' }),
      enrollFamily: (dryRun) => enrollCohortFamily({ cyclesDir, dataDir, dryRun }),
      familyReport: () => runFamilyReport({ dataDir, _trades: [] }),
      autopilotStatus: () => ({ realTradingLocked: true, tradingExecuted: 0, approvedCount: 1, rejectedCount: 0 }),
    };
  }

  function anyCohortFileExists(): boolean {
    if (fs.existsSync(watchCohortPath)) return true;
    if (fs.existsSync(researchLaneFilePath(dataDir))) return true;
    return LANES.some(l => fs.existsSync(laneFilePath(dataDir, l.key)));
  }

  it('dry-run: strict watch, family lanes, and NO_BM_RESEARCH all write NOTHING', () => {
    const summary = runFastTest({ skipDayWatch: true, dryRunEnroll: true, loops: 1 }, deps(true));
    // The family-enroll dry-run still reports would-append hits (so we KNOW there were writes to suppress).
    expect(summary.enroll.dryRun).toBe(true);
    expect(summary.enroll.perLane.some(l => l.rowsAppended > 0)).toBe(true);
    // …but not a single cohort file exists anywhere.
    expect(anyCohortFileExists()).toBe(false);
    expect(fs.existsSync(watchCohortPath)).toBe(false);
    expect(fs.existsSync(researchLaneFilePath(dataDir))).toBe(false);
    // Safety invariants preserved.
    expect(summary.safety.realTradingLocked).toBe(true);
    expect(summary.safety.tradingExecuted).toBe(0);
  });

  it('control (no dry-run): the SAME flow DOES write cohort files — proving dry-run is the suppressor', () => {
    runFastTest({ skipDayWatch: true, dryRunEnroll: false, loops: 1 }, deps(false));
    expect(fs.existsSync(watchCohortPath)).toBe(true);                 // strict watch wrote
    expect(fs.existsSync(researchLaneFilePath(dataDir))).toBe(true);   // NO_BM_RESEARCH wrote
    expect(fs.existsSync(laneFilePath(dataDir, 'EXACT_WATCH'))).toBe(true); // family lane wrote
  });
});
