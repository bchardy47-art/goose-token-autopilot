import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runLearningLoopAudit,
  renderLearningLoopAudit,
  type LearningLoopAuditResult,
} from '../src/token-grab/ripperLearningLoopPropagationAudit';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function writeJson(filePath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj));
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

function makeDexRun(
  dir: string,
  fname: string,
  generatedAt: string,
  outcomes: Array<{ contract: string; symbol?: string; entryPriceChangeM5?: number | null }>,
): void {
  const winners = outcomes.slice(0, 2);
  const losers  = outcomes.slice(2);
  writeJson(path.join(dir, fname), { generatedAt, winners, losers });
}

function makeCycleJsonl(
  dir: string,
  fname: string,
  rows: Array<{ contract: string; capturedAt: string; m5?: number | null; m5Source?: string }>,
): void {
  writeJsonl(
    path.join(dir, fname),
    rows.map(r => ({
      capturedAt:          r.capturedAt,
      entryMomentumPct:    r.m5 ?? null,
      entryMomentumSource: r.m5Source ?? (r.m5 != null ? 'DEX_SCREENER_M5' : 'UNAVAILABLE'),
      normalizedSignal:    { contract: r.contract, symbol: 'TKN' },
    })),
  );
}

interface TmpDirs {
  root:       string;
  dexRunsDir: string;
  cyclesDir:  string;
  intentsPath: string;
  obsPath:     string;
  memoryPath:  string;
}

function makeTmpDirs(): TmpDirs {
  const root       = fs.mkdtempSync(path.join(os.tmpdir(), 'lla-test-'));
  const dexRunsDir = path.join(root, 'dex-watch-runs');
  const cyclesDir  = path.join(root, 'cycles');
  fs.mkdirSync(dexRunsDir, { recursive: true });
  fs.mkdirSync(cyclesDir,  { recursive: true });
  return {
    root,
    dexRunsDir,
    cyclesDir,
    intentsPath: path.join(root, 'paper-intents.jsonl'),
    obsPath:     path.join(root, 'paper-intent-observations.jsonl'),
    memoryPath:  path.join(root, 'learning-memory.jsonl'),
  };
}

function baseOpts(dirs: TmpDirs) {
  return {
    dexWatchRunsDir: dirs.dexRunsDir,
    cyclesDir:       dirs.cyclesDir,
    intentsPath:     dirs.intentsPath,
    obsPath:         dirs.obsPath,
    memoryPath:      dirs.memoryPath,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runLearningLoopAudit', () => {
  let dirs: TmpDirs;

  beforeEach(() => { dirs = makeTmpDirs(); });
  afterEach(() => { fs.rmSync(dirs.root, { recursive: true, force: true }); });

  // ── Scenario 1: empty dirs ──────────────────────────────────────────────

  describe('Scenario 1 — empty data', () => {
    it('returns null timestamps when no data exists', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.latestDexWatchFile).toBeNull();
      expect(r.latestDexWatchGeneratedAt).toBeNull();
      expect(r.latestCycleFile).toBeNull();
      expect(r.latestIntentApprovedAt).toBeNull();
      expect(r.latestObservationCapturedAt).toBeNull();
      expect(r.latestMemoryTimestamp).toBeNull();
    });

    it('returns zero counts for all stages', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.intentsTotal).toBe(0);
      expect(r.observationsTotal).toBe(0);
      expect(r.memoryTotal).toBe(0);
    });

    it('diagnoses M5_NEW_ROWS_NOT_CREATED_YET when all stages are empty', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).toContain('M5_NEW_ROWS_NOT_CREATED_YET');
    });

    it('recentRowsForM5 defaults to 50', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.recentRowsForM5).toBe(50);
    });
  });

  // ── Scenario 2: DEX_ADVANCING_RIPPER_STALE ────────────────────────────

  describe('Scenario 2 — dex-watch run far ahead of latest cycle', () => {
    beforeEach(() => {
      makeDexRun(dirs.dexRunsDir, 'run-20260619-040510.json', '2026-06-19T04:05:10Z', [
        { contract: 'AAA', symbol: 'ALPHA', entryPriceChangeM5: 12.5 },
        { contract: 'BBB', symbol: 'BETA',  entryPriceChangeM5: -3.2 },
      ]);
      makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
        { contract: 'AAA', capturedAt: '2026-06-18T22:05:28Z', m5: 12.5 },
      ]);
      writeJsonl(dirs.intentsPath, [
        { contract: 'AAA', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z' },
      ]);
      writeJsonl(dirs.obsPath, [
        { capturedAt: '2026-06-18T22:17:39Z', normalizedSignal: { contract: 'AAA' } },
      ]);
      writeJsonl(dirs.memoryPath, [
        { contract: 'AAA', capturedAt: '2026-06-18T22:17:39Z' },
      ]);
    });

    it('detects DEX_ADVANCING_RIPPER_STALE', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).toContain('DEX_ADVANCING_RIPPER_STALE');
    });

    it('freshness gap from dex-watch to cycle is stale', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      const gap = r.freshnessGaps.find(g => g.fromStage === 'dex-watch-run');
      expect(gap?.stale).toBe(true);
    });

    it('picks up latest dex-watch generatedAt', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.latestDexWatchGeneratedAt).toBe('2026-06-19T04:05:10Z');
    });

    it('counts dex-watch outcomes with M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      const latest = r.recentDexWatchRuns.at(-1)!;
      expect(latest.outcomesTotal).toBe(2);
      expect(latest.withM5).toBe(2);
    });
  });

  // ── Scenario 3: M5_NOT_PERSISTED_TO_MEMORY ────────────────────────────

  describe('Scenario 3 — M5 in cycles but not in intents/observations/memory', () => {
    beforeEach(() => {
      makeDexRun(dirs.dexRunsDir, 'run-20260618-220528.json', '2026-06-18T22:05:28Z', [
        { contract: 'AAA', symbol: 'ALPHA', entryPriceChangeM5: 10 },
        { contract: 'BBB', symbol: 'BETA',  entryPriceChangeM5: -5 },
      ]);
      makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
        { contract: 'AAA', capturedAt: '2026-06-18T22:05:28Z', m5: 10 },
        { contract: 'BBB', capturedAt: '2026-06-18T22:05:28Z', m5: -5 },
      ]);
      // Intents do NOT have entryMomentumPct
      writeJsonl(dirs.intentsPath, [
        { contract: 'AAA', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z' },
        { contract: 'BBB', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z' },
      ]);
      writeJsonl(dirs.obsPath, [
        { capturedAt: '2026-06-18T22:17:39Z', normalizedSignal: { contract: 'AAA' } },
        { capturedAt: '2026-06-18T22:17:39Z', normalizedSignal: { contract: 'BBB' } },
      ]);
      writeJsonl(dirs.memoryPath, [
        { contract: 'AAA', capturedAt: '2026-06-18T22:17:39Z' },
        { contract: 'BBB', capturedAt: '2026-06-18T22:17:39Z' },
      ]);
    });

    it('diagnoses M5_NOT_PERSISTED_TO_MEMORY', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).toContain('M5_NOT_PERSISTED_TO_MEMORY');
    });

    it('shows 0 intents with M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.intentsWithM5).toBe(0);
    });

    it('shows 0 observations with M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.observationsWithM5).toBe(0);
    });

    it('shows 0 memory rows with M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.memoryWithM5).toBe(0);
    });

    it('shows 2 cycle rows with DEX_SCREENER_M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.latestCycleM5DexScreener).toBe(2);
    });

    it('m5StopsAt mentions cycle-rows', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.m5StopsAt).toContain('cycle-rows');
    });
  });

  // ── Scenario 4: HEALTHY_FLOW ──────────────────────────────────────────

  describe('Scenario 4 — healthy flow, no significant gaps, M5 in memory', () => {
    beforeEach(() => {
      makeDexRun(dirs.dexRunsDir, 'run-20260618-220528.json', '2026-06-18T22:05:28Z', [
        { contract: 'AAA', entryPriceChangeM5: 10 },
      ]);
      makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
        { contract: 'AAA', capturedAt: '2026-06-18T22:05:28Z', m5: 10 },
      ]);
      writeJsonl(dirs.intentsPath, [
        { contract: 'AAA', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z', entryMomentumPct: 10 },
      ]);
      writeJsonl(dirs.obsPath, [
        { capturedAt: '2026-06-18T22:10:00Z', entryMomentumPct: 10, normalizedSignal: { contract: 'AAA' } },
      ]);
      writeJsonl(dirs.memoryPath, [
        { contract: 'AAA', capturedAt: '2026-06-18T22:10:00Z', entryMomentumPct: 10 },
      ]);
    });

    it('diagnoses HEALTHY_FLOW', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).toContain('HEALTHY_FLOW');
    });

    it('shows 1 intent with M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.intentsWithM5).toBe(1);
    });

    it('shows 1 observation with M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.observationsWithM5).toBe(1);
    });

    it('shows 1 memory row with M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.memoryWithM5).toBe(1);
    });

    it('m5StopsAt mentions learning-memory', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.m5StopsAt).toContain('learning-memory');
    });

    it('no freshness gaps stale', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.freshnessGaps.every(g => !g.stale)).toBe(true);
    });
  });

  // ── Scenario 5: contract sample traces ────────────────────────────────

  describe('Scenario 5 — contract sample propagation trace', () => {
    beforeEach(() => {
      makeDexRun(dirs.dexRunsDir, 'run-20260618-220000.json', '2026-06-18T22:00:00Z', [
        { contract: 'AAA', symbol: 'ALPHA', entryPriceChangeM5: 5 },
        { contract: 'BBB', symbol: 'BETA',  entryPriceChangeM5: null },
        { contract: 'CCC', symbol: 'GAMMA', entryPriceChangeM5: -2 },
      ]);
      makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220000.jsonl', [
        { contract: 'AAA', capturedAt: '2026-06-18T22:00:00Z', m5: 5 },
        { contract: 'CCC', capturedAt: '2026-06-18T22:00:00Z', m5: -2 },
        // BBB not in cycle
      ]);
      writeJsonl(dirs.intentsPath, [
        { contract: 'AAA', status: 'OBSERVED', approvedAt: '2026-06-18T22:00:00Z' },
        { contract: 'BBB', status: 'OBSERVED', approvedAt: '2026-06-18T22:00:00Z' },
        // CCC not in intents
      ]);
      writeJsonl(dirs.obsPath, [
        { capturedAt: '2026-06-18T22:10:00Z', normalizedSignal: { contract: 'AAA' } },
        // BBB and CCC not in obs
      ]);
      writeJsonl(dirs.memoryPath, [
        { contract: 'AAA', capturedAt: '2026-06-18T22:10:00Z' },
        { contract: 'BBB', capturedAt: '2026-06-18T22:10:00Z' },
        // CCC not in memory
      ]);
    });

    it('traces AAA through all stages', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      const trace = r.contractSample.find(t => t.contract === 'AAA');
      expect(trace?.inCycle).toBe(true);
      expect(trace?.inIntents).toBe(true);
      expect(trace?.inObservations).toBe(true);
      expect(trace?.inMemory).toBe(true);
    });

    it('shows CCC missing from intents and memory', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      const trace = r.contractSample.find(t => t.contract === 'CCC');
      expect(trace?.inCycle).toBe(true);
      expect(trace?.inIntents).toBe(false);
      expect(trace?.inMemory).toBe(false);
    });

    it('captures M5 in cycle for AAA', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      const trace = r.contractSample.find(t => t.contract === 'AAA');
      expect(trace?.m5InLatestCycle).toBe(5);
    });

    it('m5InLatestCycle is null for BBB (not in cycle)', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      const trace = r.contractSample.find(t => t.contract === 'BBB');
      expect(trace?.m5InLatestCycle).toBeNull();
    });
  });

  // ── Scenario 6: intent status counting ────────────────────────────────

  describe('Scenario 6 — intent status breakdown', () => {
    beforeEach(() => {
      writeJsonl(dirs.intentsPath, [
        { contract: 'A', status: 'OBSERVED',       approvedAt: '2026-06-18T22:00:00Z' },
        { contract: 'B', status: 'OBSERVED',       approvedAt: '2026-06-18T21:00:00Z' },
        { contract: 'C', status: 'EXPIRED_NO_DATA', approvedAt: '2026-06-18T20:00:00Z' },
        { contract: 'D', status: 'ENTRY_DUE',       approvedAt: '2026-06-18T19:00:00Z' },
      ]);
    });

    it('counts intentsTotal correctly', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.intentsTotal).toBe(4);
    });

    it('counts intentsObserved correctly', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.intentsObserved).toBe(2);
    });

    it('counts intentsExpired correctly', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.intentsExpired).toBe(1);
    });

    it('counts intentsOpen (non-terminal) correctly', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.intentsOpen).toBe(1);  // ENTRY_DUE
    });

    it('counts intentsDue correctly', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.intentsDue).toBe(1);
    });

    it('picks latest approvedAt across all intents', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.latestIntentApprovedAt).toBe('2026-06-18T22:00:00Z');
    });
  });

  // ── Scenario 7: recent-N option ───────────────────────────────────────

  describe('Scenario 7 — recent-N limits rows shown', () => {
    beforeEach(() => {
      for (let i = 1; i <= 15; i++) {
        const hh = String(i).padStart(2, '0');
        makeDexRun(
          dirs.dexRunsDir,
          `run-20260618-${hh}0000.json`,
          `2026-06-18T${hh}:00:00Z`,
          [{ contract: `C${i}`, entryPriceChangeM5: i }],
        );
        makeCycleJsonl(
          dirs.cyclesDir,
          `cycle-2026-06-18-${hh}0000.jsonl`,
          [{ contract: `C${i}`, capturedAt: `2026-06-18T${hh}:00:00Z`, m5: i }],
        );
      }
    });

    it('limits recentDexWatchRuns to N=5', () => {
      const r = runLearningLoopAudit({ ...baseOpts(dirs), recent: 5 });
      expect(r.recentDexWatchRuns.length).toBe(5);
    });

    it('limits recentCycleFiles to N=5', () => {
      const r = runLearningLoopAudit({ ...baseOpts(dirs), recent: 5 });
      expect(r.recentCycleFiles.length).toBe(5);
    });

    it('always uses the very latest cycle for M5 propagation regardless of recent N', () => {
      const r = runLearningLoopAudit({ ...baseOpts(dirs), recent: 5 });
      // Latest cycle is cycle-2026-06-18-150000.jsonl with C15 → m5=15
      const trace = r.contractSample.find(t => t.contract === 'C15');
      expect(trace?.inCycle).toBe(true);
    });
  });

  // ── Scenario 8: combined diagnoses ────────────────────────────────────

  describe('Scenario 8 — multiple diagnoses stack', () => {
    beforeEach(() => {
      // dex-watch run is very new, cycle is old → DEX_ADVANCING_RIPPER_STALE
      makeDexRun(dirs.dexRunsDir, 'run-20260619-080000.json', '2026-06-19T08:00:00Z', [
        { contract: 'AAA', entryPriceChangeM5: 20 },
      ]);
      makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
        { contract: 'AAA', capturedAt: '2026-06-18T22:05:28Z', m5: 20 },
      ]);
      writeJsonl(dirs.intentsPath, [
        // No entryMomentumPct → M5_NOT_PERSISTED_TO_MEMORY
        { contract: 'AAA', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z' },
      ]);
      writeJsonl(dirs.obsPath, [
        { capturedAt: '2026-06-18T22:17:39Z', normalizedSignal: { contract: 'AAA' } },
      ]);
      writeJsonl(dirs.memoryPath, [
        { contract: 'AAA', capturedAt: '2026-06-18T22:17:39Z' },
      ]);
    });

    it('includes both DEX_ADVANCING_RIPPER_STALE and M5_NOT_PERSISTED_TO_MEMORY', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).toContain('DEX_ADVANCING_RIPPER_STALE');
      expect(r.diagnoses).toContain('M5_NOT_PERSISTED_TO_MEMORY');
    });

    it('does NOT include HEALTHY_FLOW when there are diagnoses', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).not.toContain('HEALTHY_FLOW');
    });
  });

  // ── Scenario 9: M5_ONLY_AVAILABLE_BY_CYCLE_JOIN ──────────────────────

  describe('Scenario 9 — M5 in cycle file, intents have sourceCycle but no direct M5', () => {
    beforeEach(() => {
      makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
        { contract: 'AAA', capturedAt: '2026-06-18T22:05:28Z', m5: 10 },
        { contract: 'BBB', capturedAt: '2026-06-18T22:05:28Z', m5: -5 },
      ]);
      writeJsonl(dirs.intentsPath, [
        { contract: 'AAA', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z', sourceCycle: 'cycle-2026-06-18-220528' },
        { contract: 'BBB', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z', sourceCycle: 'cycle-2026-06-18-220528' },
      ]);
      writeJsonl(dirs.obsPath, [
        { capturedAt: '2026-06-18T22:17:00Z', normalizedSignal: { contract: 'AAA' } },
      ]);
      writeJsonl(dirs.memoryPath, [
        { contract: 'AAA', capturedAt: '2026-06-18T22:17:00Z' },
      ]);
    });

    it('detects M5_ONLY_AVAILABLE_BY_CYCLE_JOIN persistence status', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.m5PersistenceStatus).toBe('M5_ONLY_AVAILABLE_BY_CYCLE_JOIN');
    });

    it('diagnoses M5_ONLY_AVAILABLE_BY_CYCLE_JOIN', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).toContain('M5_ONLY_AVAILABLE_BY_CYCLE_JOIN');
    });

    it('m5AvailableViaCycleJoin counts both intents whose cycle file has M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.m5AvailableViaCycleJoin).toBe(2);
    });

    it('m5NotAvailableViaCycleJoin is 0 when all intents have a joinable cycle M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.m5NotAvailableViaCycleJoin).toBe(0);
    });

    it('cycleJoinSampleSize equals count of recent intents without direct M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.cycleJoinSampleSize).toBe(2);
    });

    it('recentIntentsWithM5 is 0 — intents themselves carry no M5', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.recentIntentsWithM5).toBe(0);
    });
  });

  // ── Scenario 10: M5_NEW_ROWS_NOT_CREATED_YET ─────────────────────────

  describe('Scenario 10 — cycle has M5 but no intents exist yet', () => {
    beforeEach(() => {
      makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
        { contract: 'AAA', capturedAt: '2026-06-18T22:05:28Z', m5: 10 },
      ]);
      // No intents, no obs, no memory written
    });

    it('diagnoses M5_NEW_ROWS_NOT_CREATED_YET', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).toContain('M5_NEW_ROWS_NOT_CREATED_YET');
    });

    it('m5PersistenceStatus is M5_NEW_ROWS_NOT_CREATED_YET', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.m5PersistenceStatus).toBe('M5_NEW_ROWS_NOT_CREATED_YET');
    });

    it('intentsTotal is 0', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.intentsTotal).toBe(0);
    });

    it('cycleJoinSampleSize is 0 when no intents exist to sample', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.cycleJoinSampleSize).toBe(0);
    });
  });

  // ── Scenario 11: recentRowsForM5 option ───────────────────────────────

  describe('Scenario 11 — recentRowsForM5 option controls recent-N window', () => {
    beforeEach(() => {
      makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
        { contract: 'NEW1', capturedAt: '2026-06-18T22:05:28Z', m5: 5 },
      ]);
      const rows: unknown[] = [];
      for (let i = 1; i <= 7; i++) {
        rows.push({ contract: `OLD${i}`, status: 'OBSERVED', approvedAt: `2026-06-17T${String(i).padStart(2, '0')}:00:00Z` });
      }
      rows.push({ contract: 'NEW1', status: 'OBSERVED', approvedAt: '2026-06-18T21:00:00Z', entryMomentumPct: 5 });
      rows.push({ contract: 'NEW2', status: 'OBSERVED', approvedAt: '2026-06-18T22:00:00Z', entryMomentumPct: -2 });
      rows.push({ contract: 'NEW3', status: 'OBSERVED', approvedAt: '2026-06-18T23:00:00Z', entryMomentumPct: 0 });
      writeJsonl(dirs.intentsPath, rows);
    });

    it('recentIntentsWithM5 = 3 when recentRowsForM5 = 5 (last 5 rows include 3 with M5)', () => {
      const r = runLearningLoopAudit({ ...baseOpts(dirs), recentRowsForM5: 5 });
      expect(r.recentIntentsWithM5).toBe(3);
      expect(r.recentRowsForM5).toBe(5);
    });

    it('recentIntentsWithM5 = 2 when recentRowsForM5 = 2 (last 2 rows both have M5)', () => {
      const r = runLearningLoopAudit({ ...baseOpts(dirs), recentRowsForM5: 2 });
      expect(r.recentIntentsWithM5).toBe(2);
    });

    it('all-time intentsWithM5 = 3 regardless of recentRowsForM5', () => {
      const r = runLearningLoopAudit({ ...baseOpts(dirs), recentRowsForM5: 2 });
      expect(r.intentsWithM5).toBe(3);
    });

    it('exposes recentRowsForM5 on result', () => {
      const r = runLearningLoopAudit({ ...baseOpts(dirs), recentRowsForM5: 7 });
      expect(r.recentRowsForM5).toBe(7);
    });
  });

  // ── Scenario 12: cycle-join unavailable when sourceCycle missing ───────

  describe('Scenario 12 — cycle-join not available when intent has no sourceCycle', () => {
    beforeEach(() => {
      makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
        { contract: 'AAA', capturedAt: '2026-06-18T22:05:28Z', m5: 10 },
      ]);
      writeJsonl(dirs.intentsPath, [
        { contract: 'AAA', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z' },
        // No sourceCycle field
      ]);
    });

    it('m5NotAvailableViaCycleJoin counts intents missing sourceCycle', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.m5NotAvailableViaCycleJoin).toBe(1);
    });

    it('m5AvailableViaCycleJoin is 0 when no sourceCycle links exist', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.m5AvailableViaCycleJoin).toBe(0);
    });

    it('does NOT diagnose M5_ONLY_AVAILABLE_BY_CYCLE_JOIN', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).not.toContain('M5_ONLY_AVAILABLE_BY_CYCLE_JOIN');
    });

    it('intents with no sourceCycle fall into M5_NOT_PERSISTED_TO_MEMORY catch-all', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).toContain('M5_NOT_PERSISTED_TO_MEMORY');
    });
  });

  // ── Scenario 13: M5_FULLY_PERSISTED triggers HEALTHY_FLOW ────────────

  describe('Scenario 13 — M5_FULLY_PERSISTED causes HEALTHY_FLOW when all stages exist', () => {
    beforeEach(() => {
      makeDexRun(dirs.dexRunsDir, 'run-20260618-220528.json', '2026-06-18T22:05:28Z', [
        { contract: 'AAA', entryPriceChangeM5: 10 },
      ]);
      makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
        { contract: 'AAA', capturedAt: '2026-06-18T22:05:28Z', m5: 10 },
      ]);
      writeJsonl(dirs.intentsPath, [
        { contract: 'AAA', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z', entryMomentumPct: 10 },
      ]);
      writeJsonl(dirs.obsPath, [
        { capturedAt: '2026-06-18T22:10:00Z', entryMomentumPct: 10, normalizedSignal: { contract: 'AAA' } },
      ]);
      writeJsonl(dirs.memoryPath, [
        { contract: 'AAA', capturedAt: '2026-06-18T22:10:00Z', entryMomentumPct: 10 },
      ]);
    });

    it('m5PersistenceStatus is M5_FULLY_PERSISTED', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.m5PersistenceStatus).toBe('M5_FULLY_PERSISTED');
    });

    it('HEALTHY_FLOW is in diagnoses', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).toContain('HEALTHY_FLOW');
    });

    it('M5_FULLY_PERSISTED is in diagnoses alongside HEALTHY_FLOW', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.diagnoses).toContain('M5_FULLY_PERSISTED');
    });

    it('recent counts all reflect M5 present', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.recentIntentsWithM5).toBe(1);
      expect(r.recentObsWithM5).toBe(1);
      expect(r.recentMemoryWithM5).toBe(1);
    });
  });

  // ── Safety flags ──────────────────────────────────────────────────────

  describe('safety flags', () => {
    it('always returns all safety flags as true/0', () => {
      const r = runLearningLoopAudit(baseOpts(dirs));
      expect(r.reportOnly).toBe(true);
      expect(r.readOnly).toBe(true);
      expect(r.paperOnly).toBe(true);
      expect(r.noMutation).toBe(true);
      expect(r.noRealTrading).toBe(true);
      expect(r.noGateChanges).toBe(true);
      expect(r.noWallet).toBe(true);
      expect(r.noSwap).toBe(true);
      expect(r.noSigning).toBe(true);
      expect(r.realTradingLocked).toBe(true);
      expect(r.tradingExecuted).toBe(0);
    });
  });
});

// ── renderLearningLoopAudit ───────────────────────────────────────────────────

describe('renderLearningLoopAudit', () => {
  let dirs: TmpDirs;

  beforeEach(() => {
    dirs = makeTmpDirs();
    makeDexRun(dirs.dexRunsDir, 'run-20260619-040510.json', '2026-06-19T04:05:10Z', [
      { contract: 'AAA', symbol: 'ALPHA', entryPriceChangeM5: 12 },
    ]);
    makeCycleJsonl(dirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
      { contract: 'AAA', capturedAt: '2026-06-18T22:05:28Z', m5: 12 },
    ]);
    writeJsonl(dirs.intentsPath, [
      { contract: 'AAA', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z' },
    ]);
    writeJsonl(dirs.obsPath, [
      { capturedAt: '2026-06-18T22:17:39Z', normalizedSignal: { contract: 'AAA' } },
    ]);
    writeJsonl(dirs.memoryPath, [
      { contract: 'AAA', capturedAt: '2026-06-18T22:17:39Z' },
    ]);
  });

  afterEach(() => { fs.rmSync(dirs.root, { recursive: true, force: true }); });

  it('renders all 8 section headers', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain('SECTION 1');
    expect(out).toContain('SECTION 2');
    expect(out).toContain('SECTION 3');
    expect(out).toContain('SECTION 4');
    expect(out).toContain('SECTION 5');
    expect(out).toContain('SECTION 6');
    expect(out).toContain('SECTION 7');
    expect(out).toContain('SECTION 8');
  });

  it('renders OVERVIEW section with timestamps', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain('2026-06-19T04:05:10Z');
    expect(out).toContain('2026-06-18T22:05:28Z');
  });

  it('renders M5 propagation section', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain('ENTRY MOMENTUM');
    expect(out).toContain('M5 stops at');
  });

  it('renders diagnoses in DIAGNOSIS section', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain('DIAGNOSIS');
    for (const d of r.diagnoses) {
      expect(out).toContain(d);
    }
  });

  it('renders SAFETY section with all required flags', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain('REPORT_ONLY=true');
    expect(out).toContain('READ_ONLY=true');
    expect(out).toContain('PAPER_ONLY=true');
    expect(out).toContain('NO_MUTATION=true');
    expect(out).toContain('NO_REAL_TRADING=true');
    expect(out).toContain('NO_GATE_CHANGES=true');
    expect(out).toContain('NO_WALLET=true');
    expect(out).toContain('NO_SWAP=true');
    expect(out).toContain('NO_SIGNING=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('realTradingLocked=true');
  });

  it('renders freshness gaps with stale indicator', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain('FRESHNESS GAPS');
    expect(out).toContain('dex-watch-run');
    expect(out).toContain('ripper-cycle');
  });

  it('renders contract sample section', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain('CONTRACT PROPAGATION SAMPLE');
  });

  it('renders report header banner', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain('TOKEN GRAB — LEARNING LOOP PROPAGATION AUDIT');
    expect(out).toContain('REPORT ONLY');
    expect(out).toContain('READ ONLY');
    expect(out).toContain('NO MUTATION');
  });

  it('renders next actions section', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain('RECOMMENDED NEXT ACTIONS');
    expect(r.nextActions.length).toBeGreaterThan(0);
  });

  it('renders recent-N M5 sub-section header', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain(`Recent ${r.recentRowsForM5} rows per stage`);
  });

  it('renders M5 persistence status line', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    expect(out).toContain('M5 persistence status');
    expect(out).toContain(r.m5PersistenceStatus);
  });

  it('renders cycle-join availability sub-section when sample exists', () => {
    const r = runLearningLoopAudit(baseOpts(dirs));
    const out = renderLearningLoopAudit(r);
    // render test setup has 1 intent with no M5 and no sourceCycle → cycleJoinSampleSize=1
    if (r.cycleJoinSampleSize > 0) {
      expect(out).toContain('Cycle-join availability');
    }
  });

  it('renders M5_ONLY_AVAILABLE_BY_CYCLE_JOIN contextual note when that status is active', () => {
    // Build a scenario where cycle join IS available
    const localDirs = makeTmpDirs();
    try {
      makeCycleJsonl(localDirs.cyclesDir, 'cycle-2026-06-18-220528.jsonl', [
        { contract: 'AAA', capturedAt: '2026-06-18T22:05:28Z', m5: 10 },
      ]);
      writeJsonl(localDirs.intentsPath, [
        { contract: 'AAA', status: 'OBSERVED', approvedAt: '2026-06-18T22:05:28Z', sourceCycle: 'cycle-2026-06-18-220528' },
      ]);
      writeJsonl(localDirs.obsPath, []);
      writeJsonl(localDirs.memoryPath, []);
      const r2 = runLearningLoopAudit(baseOpts(localDirs));
      const out2 = renderLearningLoopAudit(r2);
      expect(out2).toContain('M5_ONLY_AVAILABLE_BY_CYCLE_JOIN');
    } finally {
      fs.rmSync(localDirs.root, { recursive: true, force: true });
    }
  });
});
