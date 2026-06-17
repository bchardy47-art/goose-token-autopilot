// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runWinnerProfileReport,
  renderWinnerProfileReport,
} from '../src/token-grab/ripperWinnerProfileReport';

// ── Temp dir lifecycle ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winner-profile-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(opts = {}) {
  return {
    contract:        'So11111111111111111111111111111111111111112',
    capturedAt:      '2026-06-14T10:00:00Z',
    memoryUniverse:  'SHADOW_ENROLLED_APPROVED',
    outcomeLabel:    'FLAT_JUNK',
    liquidityBucket: 'LIQ_10K_30K',
    vlrBucket:       'VLR_0_5_TO_2',
    clusterRisk:     'CLEAN',
    launchAgeBucket: 'PRIME_WINDOW',
    timingPath:      'ENTER_NOW',
    gateDecision:    'BUY_APPROVED_PAPER',
    ripperScore:     100,
    bubbleMapsScore: 75,
    priceChangePct:  null,
    ...opts,
  };
}

function writeMemory(filePath: string, rows: object[]): void {
  const content = rows.map(r => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, content, 'utf-8');
}

function memoryPath(): string {
  return path.join(tmpDir, 'learning-memory.jsonl');
}

// ── 1. Safety: source file checks ────────────────────────────────────────────

describe('safety', () => {
  const srcPath = path.resolve(__dirname, '../src/token-grab/ripperWinnerProfileReport.ts');

  it('source contains DO_NOT_ENABLE_REAL_TRADING', () => {
    const src = fs.readFileSync(srcPath, 'utf-8');
    expect(src).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('source contains HOLD_CURRENT_GATES', () => {
    const src = fs.readFileSync(srcPath, 'utf-8');
    expect(src).toContain('HOLD_CURRENT_GATES');
  });

  it('source does NOT contain signTransaction', () => {
    const src = fs.readFileSync(srcPath, 'utf-8');
    expect(src).not.toContain('signTransaction');
  });

  it('source does NOT contain token:auto-paper or token:paper-buy', () => {
    const src = fs.readFileSync(srcPath, 'utf-8');
    expect(src).not.toContain('token:auto-paper');
    expect(src).not.toContain('token:paper-buy');
  });
});

// ── 2. Result safety fields ───────────────────────────────────────────────────

describe('result safety fields', () => {
  it('all safety fields are set correctly', () => {
    writeMemory(memoryPath(), [makeRow()]);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath() });
    expect(result.reportOnly).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.realTradingLocked).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
  });
});

// ── 3. Reads memory rows ──────────────────────────────────────────────────────

describe('reads memory rows', () => {
  it('totalRows matches file line count', () => {
    const rows = [makeRow(), makeRow({ contract: 'AAA' }), makeRow({ contract: 'BBB' })];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath() });
    expect(result.totalRows).toBe(3);
  });

  it('only SHADOW_ENROLLED_APPROVED rows appear in enrolledOnly section', () => {
    const rows = [
      makeRow({ memoryUniverse: 'SHADOW_ENROLLED_APPROVED', contract: 'AAA', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ memoryUniverse: 'DEX_WATCH_GENERAL',        contract: 'BBB', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ memoryUniverse: 'UNKNOWN_GENERAL',          contract: 'CCC', outcomeLabel: 'WINNER' }),
    ];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath() });
    expect(result.enrolledOnly.totalRows).toBe(1);
    expect(result.generalReference.totalRows).toBe(1);
    expect(result.allObserved.totalRows).toBe(3);
  });
});

// ── 4. Baseline rates ─────────────────────────────────────────────────────────

describe('baseline rates', () => {
  it('baseline observedCount excludes UNKNOWN rows', () => {
    const rows = [
      makeRow({ outcomeLabel: 'BIG_WINNER' }),
      makeRow({ outcomeLabel: 'FLAT_JUNK',  contract: 'B' }),
      makeRow({ outcomeLabel: 'UNKNOWN',    contract: 'C' }),
      makeRow({ outcomeLabel: null,         contract: 'D' }),
    ];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath() });
    expect(result.enrolledOnly.baseline.observedCount).toBe(2);
  });

  it('baseline win5Rate computed correctly (bigWinCount/observed * 100)', () => {
    // 2 BIG_WINNER out of 4 observed = 50%
    const rows = [
      makeRow({ outcomeLabel: 'BIG_WINNER', contract: 'A' }),
      makeRow({ outcomeLabel: 'BIG_WINNER', contract: 'B' }),
      makeRow({ outcomeLabel: 'FLAT_JUNK',  contract: 'C' }),
      makeRow({ outcomeLabel: 'DUMP',       contract: 'D' }),
    ];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath() });
    expect(result.enrolledOnly.baseline.win5Rate).toBe(50);
  });

  it('baseline flatDumpRate computed correctly', () => {
    // 1 FLAT_JUNK + 1 DUMP out of 4 = 50%
    const rows = [
      makeRow({ outcomeLabel: 'BIG_WINNER', contract: 'A' }),
      makeRow({ outcomeLabel: 'WINNER',     contract: 'B' }),
      makeRow({ outcomeLabel: 'FLAT_JUNK',  contract: 'C' }),
      makeRow({ outcomeLabel: 'DUMP',       contract: 'D' }),
    ];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath() });
    expect(result.enrolledOnly.baseline.flatDumpRate).toBe(50);
  });
});

// ── 5. Feature lift ───────────────────────────────────────────────────────────

describe('feature lift', () => {
  it('featureProfile for liquidityBucket has correct buckets', () => {
    const rows = [
      makeRow({ outcomeLabel: 'BIG_WINNER', liquidityBucket: 'LIQ_10K_30K', contract: 'A' }),
      makeRow({ outcomeLabel: 'FLAT_JUNK',  liquidityBucket: 'LIQ_LT_10K',  contract: 'B' }),
      makeRow({ outcomeLabel: 'DUMP',       liquidityBucket: 'LIQ_LT_10K',  contract: 'C' }),
    ];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath(), minSample: 1 });
    const liqProfile = result.enrolledOnly.featureProfiles.find(p => p.feature === 'liquidityBucket');
    expect(liqProfile).toBeDefined();
    const bucketValues = liqProfile!.buckets.map(b => b.value);
    expect(bucketValues).toContain('LIQ_10K_30K');
    expect(bucketValues).toContain('LIQ_LT_10K');
  });

  it('win5Lift is ratio of bucket win5Rate to baseline win5Rate, rounded to 1 decimal', () => {
    // Baseline: 1/4 = 25% win5. Bucket LIQ_10K_30K: 1/1 = 100% win5. Lift = 100/25 = 4.0x
    const rows = [
      makeRow({ outcomeLabel: 'BIG_WINNER', liquidityBucket: 'LIQ_10K_30K', contract: 'A' }),
      makeRow({ outcomeLabel: 'FLAT_JUNK',  liquidityBucket: 'LIQ_LT_10K',  contract: 'B' }),
      makeRow({ outcomeLabel: 'FLAT_JUNK',  liquidityBucket: 'LIQ_LT_10K',  contract: 'C' }),
      makeRow({ outcomeLabel: 'DUMP',       liquidityBucket: 'LIQ_LT_10K',  contract: 'D' }),
    ];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath(), minSample: 1 });
    const liqProfile = result.enrolledOnly.featureProfiles.find(p => p.feature === 'liquidityBucket');
    const topBucket = liqProfile!.buckets.find(b => b.value === 'LIQ_10K_30K');
    expect(topBucket).toBeDefined();
    expect(topBucket!.win5Lift).toBe(4.0);
  });

  it('tinyFlag=true when observedCount < minSample', () => {
    const rows = [
      makeRow({ outcomeLabel: 'BIG_WINNER', contract: 'A' }),
    ];
    writeMemory(memoryPath(), rows);
    // minSample=5, only 1 row → should be tiny
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath(), minSample: 5 });
    const liqProfile = result.enrolledOnly.featureProfiles.find(p => p.feature === 'liquidityBucket');
    const bucket = liqProfile!.buckets.find(b => b.value === 'LIQ_10K_30K');
    expect(bucket).toBeDefined();
    expect(bucket!.tinyFlag).toBe(true);
  });
});

// ── 6. Combo mining ───────────────────────────────────────────────────────────

describe('combo mining', () => {
  function makeEnrolledRows(count: number, overrides = {}) {
    return Array.from({ length: count }, (_, i) =>
      makeRow({ contract: `addr${i}`, ...overrides }),
    );
  }

  it('topWin5Combos contains combo results sorted by win5Rate desc', () => {
    // Create 2 distinct combos: one with high win rate, one with low
    const rows = [
      // High win group: LIQ_10K_30K + ENTER_NOW — 5 rows, all BIG_WINNER
      ...Array.from({ length: 5 }, (_, i) =>
        makeRow({
          contract: `high${i}`,
          outcomeLabel: 'BIG_WINNER',
          liquidityBucket: 'LIQ_10K_30K',
          timingPath: 'ENTER_NOW',
        }),
      ),
      // Low win group: LIQ_LT_10K + WAIT_10M — 5 rows, all DUMP
      ...Array.from({ length: 5 }, (_, i) =>
        makeRow({
          contract: `low${i}`,
          outcomeLabel: 'DUMP',
          liquidityBucket: 'LIQ_LT_10K',
          timingPath: 'WAIT_10M',
        }),
      ),
    ];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath(), minSample: 3 });
    expect(result.topWin5Combos.length).toBeGreaterThan(0);
    // Should be sorted desc by win5Rate
    for (let i = 0; i < result.topWin5Combos.length - 1; i++) {
      const a = result.topWin5Combos[i].stats.win5Rate ?? -1;
      const b = result.topWin5Combos[i + 1].stats.win5Rate ?? -1;
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });

  it('topFlatDumpCombos sorted by flatDumpRate desc', () => {
    const rows = [
      // High dump group
      ...Array.from({ length: 5 }, (_, i) =>
        makeRow({ contract: `dump${i}`, outcomeLabel: 'DUMP', liquidityBucket: 'LIQ_LT_10K', timingPath: 'WAIT_10M' }),
      ),
      // Low dump group
      ...Array.from({ length: 5 }, (_, i) =>
        makeRow({ contract: `win${i}`, outcomeLabel: 'BIG_WINNER', liquidityBucket: 'LIQ_10K_30K', timingPath: 'ENTER_NOW' }),
      ),
    ];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath(), minSample: 3 });
    expect(result.topFlatDumpCombos.length).toBeGreaterThan(0);
    for (let i = 0; i < result.topFlatDumpCombos.length - 1; i++) {
      const a = result.topFlatDumpCombos[i].stats.flatDumpRate ?? -1;
      const b = result.topFlatDumpCombos[i + 1].stats.flatDumpRate ?? -1;
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });

  it('tinyFlag=true on combos with fewer than minSample observations', () => {
    // Only 2 enrolled rows — should produce tiny combos with minSample=5
    const rows = [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', outcomeLabel: 'DUMP' }),
    ];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath(), minSample: 5 });
    // All combos should be tiny
    const allCombos = [
      ...result.topWin5Combos,
      ...result.topFlatDumpCombos,
      ...result.topWin1Combos,
    ];
    // Since all are tiny, non-tiny combos lists are empty
    expect(allCombos.length).toBe(0);
  });

  it('combos with win1Lift >= 1.25 appear in watchCandidates', () => {
    // Baseline: 2/10 = 20% win1.
    // Group with all SMALL_WINNER: 5/5 = 100% win1. Lift = 5x => >= 1.25
    const baseRows = Array.from({ length: 5 }, (_, i) =>
      makeRow({ contract: `base${i}`, outcomeLabel: 'FLAT_JUNK', liquidityBucket: 'LIQ_LT_10K', timingPath: 'WAIT_10M' }),
    );
    const winRows = Array.from({ length: 5 }, (_, i) =>
      makeRow({ contract: `win${i}`, outcomeLabel: 'SMALL_WINNER', liquidityBucket: 'LIQ_10K_30K', timingPath: 'ENTER_NOW' }),
    );
    writeMemory(memoryPath(), [...baseRows, ...winRows]);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath(), minSample: 3 });
    expect(result.watchCandidates.length).toBeGreaterThan(0);
    for (const c of result.watchCandidates) {
      expect(c.win1Lift).not.toBeNull();
      expect(c.win1Lift!).toBeGreaterThanOrEqual(1.25);
    }
  });
});

// ── 7. Conclusion ─────────────────────────────────────────────────────────────

describe('conclusion', () => {
  it('NEEDS_MORE_DATA when enrolled observedRows < 100', () => {
    // Only 3 enrolled rows with known outcomes
    const rows = [
      makeRow({ outcomeLabel: 'BIG_WINNER', contract: 'A' }),
      makeRow({ outcomeLabel: 'FLAT_JUNK',  contract: 'B' }),
      makeRow({ outcomeLabel: 'DUMP',       contract: 'C' }),
    ];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath() });
    expect(result.conclusion).toBe('NEEDS_MORE_DATA');
  });

  it('WATCH_PROFILE_CANDIDATE when any watchCandidate has win5Lift >= 1.5', () => {
    // Need >= 100 enrolled observed rows.
    // Build 100 rows where a specific combo has high win5 rate to get win5Lift >= 1.5
    // Baseline: 10/100 = 10% win5
    // Combo LIQ_10K_30K+ENTER_NOW: 20/20 = 100% win5 => lift = 10x
    const baseRows = Array.from({ length: 80 }, (_, i) =>
      makeRow({ contract: `base${i}`, outcomeLabel: 'FLAT_JUNK', liquidityBucket: 'LIQ_LT_10K', timingPath: 'WAIT_10M' }),
    );
    const bigWinRows = Array.from({ length: 10 }, (_, i) =>
      makeRow({ contract: `bw${i}`, outcomeLabel: 'BIG_WINNER', liquidityBucket: 'LIQ_LT_10K', timingPath: 'WAIT_10M' }),
    );
    const comboRows = Array.from({ length: 20 }, (_, i) =>
      makeRow({ contract: `cbo${i}`, outcomeLabel: 'BIG_WINNER', liquidityBucket: 'LIQ_10K_30K', timingPath: 'ENTER_NOW' }),
    );
    writeMemory(memoryPath(), [...baseRows, ...bigWinRows, ...comboRows]);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath(), minSample: 5 });
    expect(result.enrolledOnly.observedRows).toBeGreaterThanOrEqual(100);
    // watchCandidates should include the high-lift combo
    const hasHighLift = result.watchCandidates.some(c => c.win5Lift != null && c.win5Lift >= 1.5);
    expect(hasHighLift).toBe(true);
    expect(result.conclusion).toBe('WATCH_PROFILE_CANDIDATE');
  });

  it('NO_CLEAR_EDGE when sufficient data but no strong lift', () => {
    // 100 rows all with same values = no combo shows lift > 1.0
    const rows = Array.from({ length: 100 }, (_, i) =>
      makeRow({
        contract: `addr${i}`,
        outcomeLabel: i % 5 === 0 ? 'BIG_WINNER' : 'FLAT_JUNK',
        liquidityBucket: 'LIQ_10K_30K',
        timingPath: 'ENTER_NOW',
        vlrBucket: 'VLR_0_5_TO_2',
        clusterRisk: 'CLEAN',
        launchAgeBucket: 'PRIME_WINDOW',
      }),
    );
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath(), minSample: 5 });
    expect(result.enrolledOnly.observedRows).toBeGreaterThanOrEqual(100);
    // All rows have same feature values => combos have same rate as baseline => lift = 1.0 < 1.25
    expect(result.conclusion).toBe('NO_CLEAR_EDGE');
  });
});

// ── 8. Renderer ───────────────────────────────────────────────────────────────

describe('renderer', () => {
  it('renders without throwing', () => {
    const rows = [makeRow(), makeRow({ contract: 'B', outcomeLabel: 'BIG_WINNER' })];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath() });
    expect(() => renderWinnerProfileReport(result)).not.toThrow();
  });

  it('output contains WINNER PROFILE REPORT, REPORT ONLY, CONCLUSION', () => {
    const rows = [makeRow(), makeRow({ contract: 'B', outcomeLabel: 'DUMP' })];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath() });
    const output = renderWinnerProfileReport(result);
    expect(output).toContain('WINNER PROFILE REPORT');
    expect(output).toContain('REPORT ONLY');
    expect(output).toContain('CONCLUSION');
  });

  it('output contains safety markers: reportOnly=true, HOLD_CURRENT_GATES, DO_NOT_ENABLE_REAL_TRADING', () => {
    const rows = [makeRow()];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath() });
    const output = renderWinnerProfileReport(result);
    expect(output).toContain('reportOnly=true');
    expect(output).toContain('HOLD_CURRENT_GATES');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });
});

// ── 9. Tiny sample labeling ───────────────────────────────────────────────────

describe('tiny sample labeling', () => {
  it('rendered output contains DO_NOT_TRUST_TINY_SAMPLE for buckets below minSample', () => {
    // With only 1 observed row and minSample=5, the bucket is tiny
    const rows = [makeRow({ outcomeLabel: 'BIG_WINNER' })];
    writeMemory(memoryPath(), rows);
    const result = runWinnerProfileReport({ learningMemoryPath: memoryPath(), minSample: 5 });
    const output = renderWinnerProfileReport(result);
    expect(output).toContain('DO_NOT_TRUST_TINY_SAMPLE');
  });
});
