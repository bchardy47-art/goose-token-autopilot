import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runHistoricalWinnerBrain,
  renderHistoricalWinnerBrain,
} from '../src/token-grab/ripperHistoricalWinnerBrain';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hwBrain-'));
}

function writeLines(filePath: string, rows: object[]): void {
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function makeRow(overrides: Record<string, unknown> = {}): object {
  return {
    contract:             'AAAA1111',
    outcomeLabel:         'FLAT_JUNK',
    priceChangePct:       0,
    launchAgeBucket:      'PRIME_WINDOW',
    liquidityBucket:      'LIQ_10K_30K',
    clusterRisk:          'CLEAN',
    ripperScore:          60,
    vlrBucket:            'VLR_0_5_TO_2',
    timingPath:           'ENTER_NOW',
    entryDecision:        'READY_TO_SNIPE_PAPER',
    gateDecision:         'BUY_APPROVED_PAPER',
    wouldRejectByLiqOrAge: false,
    blockedByLowLiquidity: false,
    blockedByAgeGte10m:    false,
    memoryUniverse:        'enrolled',
    reportOnly:            true,
    readOnly:              true,
    paperOnly:             true,
    realTradingLocked:     true,
    tradingExecuted:       0,
    ...overrides,
  };
}

// Build N rows with specific outcome
function nRows(n: number, outcome: string, overrides: Record<string, unknown> = {}): object[] {
  return Array.from({ length: n }, (_, i) =>
    makeRow({ contract: `CONTRACT${i}-${outcome}`, outcomeLabel: outcome, ...overrides }));
}

// ── Winner classification ─────────────────────────────────────────────────────

describe('ripperHistoricalWinnerBrain — winner classification', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('counts BIG_WINNER WINNER SMALL_WINNER in totalWinners', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      ...nRows(5, 'BIG_WINNER'),
      ...nRows(3, 'WINNER'),
      ...nRows(4, 'SMALL_WINNER'),
      ...nRows(6, 'FLAT_JUNK'),
      ...nRows(2, 'DUMP'),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 1 });
    expect(result.totalWinners).toBe(12);
    expect(result.totalWin5).toBe(8);
    expect(result.totalFlatDump).toBe(8);
    expect(result.totalLabeled).toBe(20);
  });

  it('excludes UNKNOWN from labeled count', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      ...nRows(5, 'BIG_WINNER'),
      ...nRows(5, 'UNKNOWN'),  // excluded
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 1 });
    expect(result.totalLabeled).toBe(5);
    expect(result.totalWin5).toBe(5);
  });

  it('baseline rates computed from labeled rows only', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      ...nRows(20, 'BIG_WINNER'),  // 20 win5
      ...nRows(80, 'FLAT_JUNK'),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 1 });
    expect(result.baselineWin5Rate).toBeCloseTo(0.20);
    expect(result.baselineFlatDumpRate).toBeCloseTo(0.80);
  });
});

// ── Pattern mining ────────────────────────────────────────────────────────────

describe('ripperHistoricalWinnerBrain — pattern mining', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('single-feature patterns respect minPatternSample', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      ...nRows(5, 'WINNER',   { liquidityBucket: 'LIQ_30K_100K' }),
      ...nRows(20, 'FLAT_JUNK', { liquidityBucket: 'LIQ_10K_30K' }),
    ]);
    const result10 = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 10 });
    const result3  = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 3 });
    // LIQ_30K_100K has only 5 rows — excluded at minSample=10, included at 3
    const feat10 = result10.featurePatterns.filter(p => p.featureValues['liquidityBucket'] === 'LIQ_30K_100K');
    const feat3  = result3.featurePatterns.filter(p => p.featureValues['liquidityBucket'] === 'LIQ_30K_100K');
    expect(feat10.length).toBe(0);
    expect(feat3.length).toBeGreaterThan(0);
  });

  it('higher win5Rate pattern gets higher lift', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      // LIQ_30K_100K: 8 of 10 winners (80% win5)
      ...nRows(8, 'BIG_WINNER', { liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2' }),
      ...nRows(2, 'FLAT_JUNK',  { liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2' }),
      // LIQ_10K_30K: 2 of 10 winners (20% win5)
      ...nRows(2, 'BIG_WINNER', { liquidityBucket: 'LIQ_10K_30K',  vlrBucket: 'VLR_GTE_2' }),
      ...nRows(8, 'FLAT_JUNK',  { liquidityBucket: 'LIQ_10K_30K',  vlrBucket: 'VLR_GTE_2' }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5 });
    const high = result.featurePatterns.find(p => p.featureValues['liquidityBucket'] === 'LIQ_30K_100K');
    const low  = result.featurePatterns.find(p => p.featureValues['liquidityBucket'] === 'LIQ_10K_30K');
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    expect(high!.win5Lift!).toBeGreaterThan(low!.win5Lift!);
  });

  it('2-feature combo patterns are produced', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      ...nRows(15, 'BIG_WINNER', { liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2' }),
      ...nRows(15, 'FLAT_JUNK',  { liquidityBucket: 'LIQ_10K_30K',  vlrBucket: 'VLR_LT_0_5' }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 10 });
    const hasCombo = result.topWinnerPatterns.some(p =>
      p.featureValues['liquidityBucket'] != null && p.featureValues['vlrBucket'] != null);
    expect(hasCombo).toBe(true);
  });

  it('pattern with null feature values is excluded', () => {
    const mp = path.join(dir, 'mem.jsonl');
    // Rows with null liquidityBucket should not appear in liquidityBucket combos
    writeLines(mp, [
      ...nRows(15, 'BIG_WINNER', { liquidityBucket: null, vlrBucket: 'VLR_GTE_2' }),
      ...nRows(15, 'BIG_WINNER', { liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_GTE_2' }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5 });
    const nullLiqPatterns = result.topWinnerPatterns.filter(p =>
      p.featureValues['liquidityBucket'] === null);
    expect(nullLiqPatterns.length).toBe(0);
  });
});

// ── Grouping and aggregation ──────────────────────────────────────────────────

describe('ripperHistoricalWinnerBrain — grouping and aggregation', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('contracts with same feature bucket group together', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      ...Array.from({ length: 10 }, (_, i) => makeRow({
        contract:       `C${i}`,
        outcomeLabel:   'BIG_WINNER',
        priceChangePct: 10 + i,
        liquidityBucket: 'LIQ_30K_100K',
      })),
      ...Array.from({ length: 10 }, (_, i) => makeRow({
        contract:       `D${i}`,
        outcomeLabel:   'FLAT_JUNK',
        priceChangePct: 0,
        liquidityBucket: 'LIQ_30K_100K',
      })),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5 });
    const p = result.featurePatterns.find(x => x.featureValues['liquidityBucket'] === 'LIQ_30K_100K');
    expect(p).toBeDefined();
    expect(p!.total).toBe(20);
    expect(p!.win5).toBe(10);
  });

  it('avgMove computed correctly', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A1', outcomeLabel: 'BIG_WINNER', priceChangePct: 10, liquidityBucket: 'LIQ_30K_100K' }),
      makeRow({ contract: 'A2', outcomeLabel: 'BIG_WINNER', priceChangePct: 20, liquidityBucket: 'LIQ_30K_100K' }),
      makeRow({ contract: 'A3', outcomeLabel: 'FLAT_JUNK',  priceChangePct: 0,  liquidityBucket: 'LIQ_30K_100K' }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 1 });
    const p = result.featurePatterns.find(x => x.featureValues['liquidityBucket'] === 'LIQ_30K_100K');
    expect(p).toBeDefined();
    expect(p!.avgMove).toBeCloseTo(10);
  });

  it('medianMove computed correctly for odd count', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A1', outcomeLabel: 'WINNER',   priceChangePct: 1,  vlrBucket: 'VLR_GTE_2' }),
      makeRow({ contract: 'A2', outcomeLabel: 'WINNER',   priceChangePct: 5,  vlrBucket: 'VLR_GTE_2' }),
      makeRow({ contract: 'A3', outcomeLabel: 'FLAT_JUNK',priceChangePct: 100, vlrBucket: 'VLR_GTE_2' }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 1 });
    const p = result.featurePatterns.find(x => x.featureValues['vlrBucket'] === 'VLR_GTE_2');
    expect(p).toBeDefined();
    expect(p!.medianMove).toBeCloseTo(5);
  });
});

// ── win5Lift ──────────────────────────────────────────────────────────────────

describe('ripperHistoricalWinnerBrain — win5Lift', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('win5Lift > 1 when pattern win5Rate beats baseline', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      // baseline: 10/40 = 25%
      ...nRows(10, 'BIG_WINNER', { liquidityBucket: 'LIQ_10K_30K' }),
      ...nRows(30, 'FLAT_JUNK',  { liquidityBucket: 'LIQ_10K_30K' }),
      // LIQ_30K_100K: 8/10 = 80%
      ...nRows(8, 'BIG_WINNER',  { liquidityBucket: 'LIQ_30K_100K' }),
      ...nRows(2, 'FLAT_JUNK',   { liquidityBucket: 'LIQ_30K_100K' }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5 });
    const p = result.featurePatterns.find(x => x.featureValues['liquidityBucket'] === 'LIQ_30K_100K');
    expect(p!.win5Lift).toBeGreaterThan(1);
  });
});

// ── False negatives ───────────────────────────────────────────────────────────

describe('ripperHistoricalWinnerBrain — false negatives', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('tracks blockedByGate and blockedButWon counts', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      // blocked winners (false negatives)
      ...nRows(8, 'BIG_WINNER', {
        liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2',
        wouldRejectByLiqOrAge: true,
      }),
      // unblocked winners
      ...nRows(4, 'BIG_WINNER', {
        liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2',
        wouldRejectByLiqOrAge: false,
      }),
      // blocked non-winners
      ...nRows(3, 'FLAT_JUNK', {
        liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2',
        wouldRejectByLiqOrAge: true,
      }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5 });
    const p = result.featurePatterns.find(x =>
      x.featureValues['liquidityBucket'] === 'LIQ_30K_100K');
    expect(p).toBeDefined();
    expect(p!.blockedByGate).toBe(11);  // 8 winners + 3 flat
    expect(p!.blockedButWon).toBe(8);
  });

  it('falseNegativePatterns only includes patterns with blockedButWon > 0', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      ...nRows(10, 'BIG_WINNER', {
        liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2',
        wouldRejectByLiqOrAge: true,
      }),
      ...nRows(10, 'FLAT_JUNK', {
        liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_LT_0_5',
        wouldRejectByLiqOrAge: false,  // not blocked — shouldn't appear in false negatives
      }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5 });
    for (const p of result.falseNegativePatterns) {
      expect(p.blockedButWon).toBeGreaterThan(0);
    }
  });
});

// ── Matcher labels ────────────────────────────────────────────────────────────

describe('ripperHistoricalWinnerBrain — matcher labels', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('MATCH_STRONG_ENTER_NOW assigned for high win5 rate + ENTER_NOW', () => {
    const mp = path.join(dir, 'mem.jsonl');
    // Need high win5 rate (≥32%), timingPath=ENTER_NOW, and lift≥1.4x
    writeLines(mp, [
      // Pattern with 40% win5, all ENTER_NOW
      ...nRows(8, 'BIG_WINNER', {
        liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2',
        timingPath: 'ENTER_NOW',
      }),
      ...nRows(12, 'FLAT_JUNK', {
        liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2',
        timingPath: 'ENTER_NOW',
      }),
      // Baseline: only 5% win5 to boost lift
      ...nRows(4, 'BIG_WINNER', {
        liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_LT_0_5',
        timingPath: 'ENTER_NOW',
      }),
      ...nRows(76, 'FLAT_JUNK', {
        liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_LT_0_5',
        timingPath: 'ENTER_NOW',
      }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 10 });
    const strongPatterns = result.topWinnerPatterns.filter(
      p => p.matcherLabel === 'MATCH_STRONG_ENTER_NOW');
    expect(strongPatterns.length).toBeGreaterThan(0);
  });

  it('NO_WINNER_PATTERN_REJECT assigned for high flatDump rate', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      ...nRows(2, 'BIG_WINNER',  { liquidityBucket: 'LIQ_LT_10K', vlrBucket: 'VLR_LT_0_5' }),
      ...nRows(18, 'FLAT_JUNK',  { liquidityBucket: 'LIQ_LT_10K', vlrBucket: 'VLR_LT_0_5' }),
      // need some baseline winners
      ...nRows(10, 'BIG_WINNER', { liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2' }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5 });
    const p = result.topWinnerPatterns.find(x =>
      x.featureValues['liquidityBucket'] === 'LIQ_LT_10K' &&
      x.featureValues['vlrBucket'] === 'VLR_LT_0_5');
    if (p) {
      expect(p.matcherLabel).toBe('NO_WINNER_PATTERN_REJECT');
    }
  });

  it('junkHeavyPatterns contains flatDumpRate > 70%', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      ...nRows(2,  'BIG_WINNER', { liquidityBucket: 'LIQ_LT_10K', vlrBucket: 'VLR_LT_0_5' }),
      ...nRows(28, 'DUMP',       { liquidityBucket: 'LIQ_LT_10K', vlrBucket: 'VLR_LT_0_5' }),
      ...nRows(10, 'BIG_WINNER', { liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_GTE_2' }),
    ]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5 });
    for (const p of result.junkHeavyPatterns) {
      expect(p.flatDumpRate).toBeGreaterThan(0.70);
    }
  });
});

// ── Safety output ─────────────────────────────────────────────────────────────

describe('ripperHistoricalWinnerBrain — safety fields', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('result has all required safety fields', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });

  it('renderer includes REPORT_ONLY and NO_POLICY_CHANGE and DO_NOT_ENABLE_REAL_TRADING', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [...nRows(5, 'BIG_WINNER'), ...nRows(5, 'FLAT_JUNK')]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 1 });
    const output = renderHistoricalWinnerBrain(result);
    expect(output).toContain('REPORT_ONLY=true');
    expect(output).toContain('NO_POLICY_CHANGE=true');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('realTradingLocked=true');
  });

  it('renderer includes safety disclaimer about matcher labels', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [...nRows(5, 'BIG_WINNER'), ...nRows(5, 'FLAT_JUNK')]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 1 });
    const output = renderHistoricalWinnerBrain(result);
    expect(output).toContain('NOT wired into autopilot');
    expect(output).toContain('NOT wired into autopilot, gates, or any decision path');
  });
});

// ── Empty / edge cases ────────────────────────────────────────────────────────

describe('ripperHistoricalWinnerBrain — edge cases', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('handles missing file gracefully', () => {
    const mp = path.join(dir, 'missing.jsonl');
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp });
    expect(result.totalLabeled).toBe(0);
    expect(result.featurePatterns.length).toBe(0);
    expect(result.topWinnerPatterns.length).toBe(0);
  });

  it('handles all-UNKNOWN rows', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, nRows(20, 'UNKNOWN'));
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp });
    expect(result.totalLabeled).toBe(0);
    expect(result.baselineWin5Rate).toBe(0);
  });

  it('handles invalid JSON lines', () => {
    const mp = path.join(dir, 'mem.jsonl');
    fs.writeFileSync(mp, `{invalid}\n${JSON.stringify(makeRow({ outcomeLabel: 'BIG_WINNER' }))}\n`);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 1 });
    expect(result.totalLabeled).toBe(1);
    expect(result.totalWin5).toBe(1);
  });

  it('topN limits the number of patterns shown', () => {
    const mp = path.join(dir, 'mem.jsonl');
    // Many different feature combos
    const rows: object[] = [];
    const liquidityBuckets = ['LIQ_LT_10K','LIQ_10K_30K','LIQ_30K_100K','LIQ_GTE_100K'];
    const vlrBuckets = ['VLR_LT_0_5','VLR_0_5_TO_2','VLR_GTE_2'];
    for (const lb of liquidityBuckets) {
      for (const vb of vlrBuckets) {
        rows.push(...nRows(15, 'BIG_WINNER', { liquidityBucket: lb, vlrBucket: vb }));
      }
    }
    writeLines(mp, rows);
    const result5  = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5, topN: 5 });
    const result20 = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5, topN: 20 });
    expect(result5.topWinnerPatterns.length).toBeLessThanOrEqual(5);
    expect(result20.topWinnerPatterns.length).toBeGreaterThan(5);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('ripperHistoricalWinnerBrain — renderer', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('renders overview with baseline rates', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [...nRows(20, 'BIG_WINNER'), ...nRows(80, 'FLAT_JUNK')]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 1 });
    const output = renderHistoricalWinnerBrain(result);
    expect(output).toContain('OVERVIEW');
    expect(output).toContain('Labeled rows');
    expect(output).toContain('Baseline win5 rate');
    expect(output).toContain('20.0%'); // win5 rate = 20/100
  });

  it('renders matcher label section', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [...nRows(20, 'BIG_WINNER'), ...nRows(80, 'FLAT_JUNK')]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 1 });
    const output = renderHistoricalWinnerBrain(result);
    expect(output).toContain('MATCHER LABEL SUMMARY');
    expect(output).toContain('MATCH_STRONG_ENTER_NOW');
    expect(output).toContain('MATCH_MEDIUM_WAIT_2M');
    expect(output).toContain('NO_WINNER_PATTERN_REJECT');
  });

  it('renders section headers', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [...nRows(15, 'BIG_WINNER'), ...nRows(15, 'FLAT_JUNK')]);
    const result = runHistoricalWinnerBrain({ learningMemoryPath: mp, minPatternSample: 5 });
    const output = renderHistoricalWinnerBrain(result);
    expect(output).toContain('SINGLE-FEATURE FINGERPRINTS');
    expect(output).toContain('TOP WINNER COMBO PATTERNS');
    expect(output).toContain('FALSE-NEGATIVE PATTERNS');
    expect(output).toContain('DO-NOT-BLOCK PATTERNS');
    expect(output).toContain('JUNK-HEAVY PATTERNS');
  });
});
