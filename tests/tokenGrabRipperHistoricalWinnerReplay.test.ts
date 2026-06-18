import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runHistoricalWinnerReplay,
  renderHistoricalWinnerReplay,
  FOCUS_PATTERN_DEFS,
  FocusPatternDef,
} from '../src/token-grab/ripperHistoricalWinnerReplay';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hwReplay-'));
}

function writeLines(filePath: string, rows: object[]): void {
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function makeRow(overrides: Record<string, unknown> = {}): object {
  return {
    contract:              'CONTRACT_DEFAULT',
    outcomeLabel:          'FLAT_JUNK',
    priceChangePct:        0,
    launchAgeBucket:       'PRIME_WINDOW',
    liquidityBucket:       'LIQ_10K_30K',
    liquidityUsd:          15000,
    clusterRisk:           'CLEAN',
    ripperScore:           60,
    vlrBucket:             'VLR_0_5_TO_2',
    timingPath:            'ENTER_NOW',
    entryDecision:         'READY_TO_SNIPE_PAPER',
    gateDecision:          'BUY_APPROVED_PAPER',
    wouldRejectByLiqOrAge: false,
    ageMinutes:            5.0,
    capturedAt:            '2026-06-15T10:00:00.000Z',
    observedAt:            '2026-06-15T10:15:00.000Z',
    memoryUniverse:        'enrolled',
    sourceFiles:           ['some-cycle.jsonl'],
    ...overrides,
  };
}

// ── Focus pattern matching ────────────────────────────────────────────────────

describe('ripperHistoricalWinnerReplay — focus pattern matching', () => {
  const defByName = (name: string): FocusPatternDef =>
    FOCUS_PATTERN_DEFS.find(d => d.name === name)!;

  it('LIQ_UNKNOWN+WATCH+ENTER_NOW matches correctly', () => {
    const def = defByName('LIQ_UNKNOWN+WATCH+ENTER_NOW');
    const hit  = makeRow({ liquidityBucket: 'LIQ_UNKNOWN', clusterRisk: 'WATCH', timingPath: 'ENTER_NOW' });
    const miss1 = makeRow({ liquidityBucket: 'LIQ_10K_30K', clusterRisk: 'WATCH', timingPath: 'ENTER_NOW' });
    const miss2 = makeRow({ liquidityBucket: 'LIQ_UNKNOWN', clusterRisk: 'CLEAN', timingPath: 'ENTER_NOW' });
    const miss3 = makeRow({ liquidityBucket: 'LIQ_UNKNOWN', clusterRisk: 'WATCH', timingPath: 'WAIT_10M' });
    expect(def.matches(hit as any)).toBe(true);
    expect(def.matches(miss1 as any)).toBe(false);
    expect(def.matches(miss2 as any)).toBe(false);
    expect(def.matches(miss3 as any)).toBe(false);
  });

  it('LIQ_UNKNOWN+WATCH matches regardless of timingPath', () => {
    const def = defByName('LIQ_UNKNOWN+WATCH');
    expect(def.matches(makeRow({ liquidityBucket: 'LIQ_UNKNOWN', clusterRisk: 'WATCH', timingPath: 'ENTER_NOW' }) as any)).toBe(true);
    expect(def.matches(makeRow({ liquidityBucket: 'LIQ_UNKNOWN', clusterRisk: 'WATCH', timingPath: 'WAIT_10M' }) as any)).toBe(true);
    expect(def.matches(makeRow({ liquidityBucket: 'LIQ_10K_30K', clusterRisk: 'WATCH' }) as any)).toBe(false);
  });

  it('VLR_UNKNOWN+WATCH+ENTER_NOW matches correctly', () => {
    const def = defByName('VLR_UNKNOWN+WATCH+ENTER_NOW');
    expect(def.matches(makeRow({ vlrBucket: 'VLR_UNKNOWN', clusterRisk: 'WATCH', timingPath: 'ENTER_NOW' }) as any)).toBe(true);
    expect(def.matches(makeRow({ vlrBucket: 'VLR_0_5_TO_2', clusterRisk: 'WATCH', timingPath: 'ENTER_NOW' }) as any)).toBe(false);
    expect(def.matches(makeRow({ vlrBucket: 'VLR_UNKNOWN', clusterRisk: 'CLEAN', timingPath: 'ENTER_NOW' }) as any)).toBe(false);
  });

  it('VLR_UNKNOWN+WATCH matches regardless of timingPath', () => {
    const def = defByName('VLR_UNKNOWN+WATCH');
    expect(def.matches(makeRow({ vlrBucket: 'VLR_UNKNOWN', clusterRisk: 'WATCH', timingPath: 'WAIT_10M' }) as any)).toBe(true);
    expect(def.matches(makeRow({ vlrBucket: 'VLR_GTE_2', clusterRisk: 'WATCH' }) as any)).toBe(false);
  });

  it('LIQ_LT_10K+PRIME_WINDOW matches correctly', () => {
    const def = defByName('LIQ_LT_10K+PRIME_WINDOW');
    expect(def.matches(makeRow({ liquidityBucket: 'LIQ_LT_10K', launchAgeBucket: 'PRIME_WINDOW' }) as any)).toBe(true);
    expect(def.matches(makeRow({ liquidityBucket: 'LIQ_10K_30K', launchAgeBucket: 'PRIME_WINDOW' }) as any)).toBe(false);
    expect(def.matches(makeRow({ liquidityBucket: 'LIQ_LT_10K', launchAgeBucket: 'TOO_EARLY' }) as any)).toBe(false);
  });
});

// ── Unique contract grouping ──────────────────────────────────────────────────

describe('ripperHistoricalWinnerReplay — unique contract grouping', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('counts unique contracts not total rows', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const customPattern: FocusPatternDef = {
      name:    'TEST_PATTERN',
      label:   'test',
      matches: r => (r as any).liquidityBucket === 'LIQ_UNKNOWN',
    };
    writeLines(mp, [
      makeRow({ contract: 'AAA', liquidityBucket: 'LIQ_UNKNOWN', outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'AAA', liquidityBucket: 'LIQ_UNKNOWN', outcomeLabel: 'BIG_WINNER' }),  // same contract
      makeRow({ contract: 'BBB', liquidityBucket: 'LIQ_UNKNOWN', outcomeLabel: 'FLAT_JUNK' }),
    ]);
    const result = runHistoricalWinnerReplay({
      learningMemoryPath: mp,
      patterns: [customPattern],
    });
    const p = result.patterns[0]!;
    expect(p.total).toBe(3);
    expect(p.uniqueContracts).toBe(2);  // AAA and BBB
  });

  it('same contract appearing multiple times counts all outcome rows', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const customPattern: FocusPatternDef = {
      name:    'P',
      label:   'p',
      matches: r => (r as any).clusterRisk === 'WATCH',
    };
    writeLines(mp, [
      makeRow({ contract: 'X1', clusterRisk: 'WATCH', outcomeLabel: 'BIG_WINNER', priceChangePct: 50 }),
      makeRow({ contract: 'X1', clusterRisk: 'WATCH', outcomeLabel: 'DUMP',       priceChangePct: -20 }),
      makeRow({ contract: 'X2', clusterRisk: 'WATCH', outcomeLabel: 'FLAT_JUNK',  priceChangePct: 0 }),
    ]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [customPattern] });
    const p = result.patterns[0]!;
    expect(p.total).toBe(3);
    expect(p.uniqueContracts).toBe(2);
    expect(p.bigWinner).toBe(1);
    expect(p.dump).toBe(1);
    expect(p.flatJunk).toBe(1);
  });
});

// ── Outcome distribution ──────────────────────────────────────────────────────

describe('ripperHistoricalWinnerReplay — outcome distribution', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function onePattern(matches: (r: any) => boolean): FocusPatternDef {
    return { name: 'P', label: 'p', matches };
  }

  it('computes all outcome counts correctly', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER',   clusterRisk: 'WATCH' }),
      makeRow({ contract: 'B', outcomeLabel: 'WINNER',        clusterRisk: 'WATCH' }),
      makeRow({ contract: 'C', outcomeLabel: 'SMALL_WINNER',  clusterRisk: 'WATCH' }),
      makeRow({ contract: 'D', outcomeLabel: 'FLAT_JUNK',     clusterRisk: 'WATCH' }),
      makeRow({ contract: 'E', outcomeLabel: 'DUMP',          clusterRisk: 'WATCH' }),
      makeRow({ contract: 'F', outcomeLabel: 'UNKNOWN',       clusterRisk: 'WATCH' }),
    ]);
    const result = runHistoricalWinnerReplay({
      learningMemoryPath: mp,
      patterns: [onePattern(r => r.clusterRisk === 'WATCH')],
    });
    const p = result.patterns[0]!;
    expect(p.bigWinner).toBe(1);
    expect(p.winner).toBe(1);
    expect(p.smallWinner).toBe(1);
    expect(p.flatJunk).toBe(1);
    expect(p.dump).toBe(1);
    expect(p.unlabeled).toBe(1);  // UNKNOWN
    expect(p.labeled).toBe(5);
    expect(p.total).toBe(6);
  });

  it('win5Rate = (BIG_WINNER + WINNER) / labeled', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER', clusterRisk: 'WATCH' }),
      makeRow({ contract: 'B', outcomeLabel: 'WINNER',     clusterRisk: 'WATCH' }),
      makeRow({ contract: 'C', outcomeLabel: 'FLAT_JUNK',  clusterRisk: 'WATCH' }),
      makeRow({ contract: 'D', outcomeLabel: 'FLAT_JUNK',  clusterRisk: 'WATCH' }),
    ]);
    const result = runHistoricalWinnerReplay({
      learningMemoryPath: mp,
      patterns: [onePattern(r => r.clusterRisk === 'WATCH')],
    });
    const p = result.patterns[0]!;
    expect(p.win5Rate).toBeCloseTo(0.5);   // 2/4
    expect(p.flatDumpRate).toBeCloseTo(0.5);
  });

  it('bestMove and worstMove from labeled priceChangePct', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER', priceChangePct: 80, clusterRisk: 'WATCH' }),
      makeRow({ contract: 'B', outcomeLabel: 'DUMP',       priceChangePct: -50, clusterRisk: 'WATCH' }),
      makeRow({ contract: 'C', outcomeLabel: 'FLAT_JUNK',  priceChangePct: 2,   clusterRisk: 'WATCH' }),
    ]);
    const result = runHistoricalWinnerReplay({
      learningMemoryPath: mp,
      patterns: [onePattern(r => r.clusterRisk === 'WATCH')],
    });
    const p = result.patterns[0]!;
    expect(p.bestMove).toBeCloseTo(80);
    expect(p.worstMove).toBeCloseTo(-50);
  });

  it('medianMove computed correctly', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', outcomeLabel: 'BIG_WINNER', priceChangePct: 10, clusterRisk: 'WATCH' }),
      makeRow({ contract: 'B', outcomeLabel: 'DUMP',       priceChangePct: -5, clusterRisk: 'WATCH' }),
      makeRow({ contract: 'C', outcomeLabel: 'FLAT_JUNK',  priceChangePct: 3,  clusterRisk: 'WATCH' }),
    ]);
    const result = runHistoricalWinnerReplay({
      learningMemoryPath: mp,
      patterns: [onePattern(r => r.clusterRisk === 'WATCH')],
    });
    const p = result.patterns[0]!;
    expect(p.medianMove).toBeCloseTo(3);  // sorted: -5, 3, 10 → 3
  });
});

// ── Executability fields ──────────────────────────────────────────────────────

describe('ripperHistoricalWinnerReplay — executability fields', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('liquidityUsdNullPct is 1 when all liqUsd null', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, clusterRisk: 'WATCH' }),
      makeRow({ contract: 'B', liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, clusterRisk: 'WATCH' }),
    ]);
    const customPattern: FocusPatternDef = {
      name: 'P', label: 'p',
      matches: r => (r as any).liquidityBucket === 'LIQ_UNKNOWN',
    };
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [customPattern] });
    expect(result.patterns[0]!.executability.liquidityUsdNullPct).toBe(1);
    expect(result.patterns[0]!.executability.liquidityUsdMin).toBeNull();
  });

  it('wouldRejectByGatePct computed from matched rows', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', clusterRisk: 'WATCH', wouldRejectByLiqOrAge: true }),
      makeRow({ contract: 'B', clusterRisk: 'WATCH', wouldRejectByLiqOrAge: true }),
      makeRow({ contract: 'C', clusterRisk: 'WATCH', wouldRejectByLiqOrAge: false }),
      makeRow({ contract: 'D', clusterRisk: 'WATCH', wouldRejectByLiqOrAge: false }),
    ]);
    const customPattern: FocusPatternDef = {
      name: 'P', label: 'p',
      matches: r => (r as any).clusterRisk === 'WATCH',
    };
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [customPattern] });
    expect(result.patterns[0]!.executability.wouldRejectByGatePct).toBeCloseTo(0.5);
  });

  it('ageMinutes range and avg computed', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [
      makeRow({ contract: 'A', clusterRisk: 'WATCH', ageMinutes: 2 }),
      makeRow({ contract: 'B', clusterRisk: 'WATCH', ageMinutes: 4 }),
      makeRow({ contract: 'C', clusterRisk: 'WATCH', ageMinutes: 6 }),
    ]);
    const customPattern: FocusPatternDef = {
      name: 'P', label: 'p',
      matches: r => (r as any).clusterRisk === 'WATCH',
    };
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [customPattern] });
    const e = result.patterns[0]!.executability;
    expect(e.ageMinutesMin).toBeCloseTo(2);
    expect(e.ageMinutesMax).toBeCloseTo(6);
    expect(e.ageMinutesAvg).toBeCloseTo(4);
  });
});

// ── Artifact warning logic ────────────────────────────────────────────────────

describe('ripperHistoricalWinnerReplay — artifact warning logic', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('HIGH artifact risk when all liqUsd null + >50% unlabeled', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const pDef: FocusPatternDef = {
      name: 'P', label: 'p',
      matches: r => (r as any).liquidityBucket === 'LIQ_UNKNOWN',
    };
    writeLines(mp, [
      makeRow({ contract: 'A', liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'UNKNOWN' }),
      makeRow({ contract: 'C', liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'UNKNOWN' }),
      makeRow({ contract: 'D', liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'UNKNOWN' }),
    ]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [pDef] });
    expect(result.patterns[0]!.artifact.artifactRisk).toBe('HIGH');
    expect(result.patterns[0]!.artifact.liquidityUsdAllNull).toBe(true);
  });

  it('LOW artifact risk when liqUsd known and >70% labeled', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const pDef: FocusPatternDef = {
      name: 'P', label: 'p',
      matches: r => (r as any).clusterRisk === 'CLEAN',
    };
    writeLines(mp, [
      makeRow({ contract: 'A', clusterRisk: 'CLEAN', liquidityUsd: 15000, outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', clusterRisk: 'CLEAN', liquidityUsd: 20000, outcomeLabel: 'FLAT_JUNK' }),
      makeRow({ contract: 'C', clusterRisk: 'CLEAN', liquidityUsd: 18000, outcomeLabel: 'DUMP' }),
      makeRow({ contract: 'D', clusterRisk: 'CLEAN', liquidityUsd: 12000, outcomeLabel: 'UNKNOWN' }),  // 25% unlabeled
    ]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [pDef] });
    expect(result.patterns[0]!.artifact.artifactRisk).toBe('LOW');
    expect(result.patterns[0]!.artifact.liquidityUsdAllNull).toBe(false);
  });

  it('MEDIUM risk when exactly 50% unlabeled (boundary uses strict >0.50 for HIGH)', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const pDef: FocusPatternDef = {
      name: 'P', label: 'p',
      matches: r => (r as any).clusterRisk === 'WATCH',
    };
    writeLines(mp, [
      makeRow({ contract: 'A', clusterRisk: 'WATCH', liquidityUsd: 15000, outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', clusterRisk: 'WATCH', liquidityUsd: 20000, outcomeLabel: 'FLAT_JUNK' }),
      makeRow({ contract: 'C', clusterRisk: 'WATCH', liquidityUsd: 18000, outcomeLabel: 'UNKNOWN' }),
      makeRow({ contract: 'D', clusterRisk: 'WATCH', liquidityUsd: 12000, outcomeLabel: 'UNKNOWN' }),
    ]);  // exactly 50% unlabeled → MEDIUM (HIGH requires >50%)
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [pDef] });
    expect(result.patterns[0]!.artifact.artifactRisk).toBe('MEDIUM');
    expect(result.patterns[0]!.artifact.unlabeledPct).toBeCloseTo(0.5);
  });

  it('observed win5Rate vs pessimistic rate shows divergence on biased sample', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const pDef: FocusPatternDef = {
      name: 'P', label: 'p',
      matches: r => (r as any).liquidityBucket === 'LIQ_UNKNOWN',
    };
    // 10 big winners labeled, 90 unlabeled → observed=100%, pessimistic=10%
    const winners = Array.from({ length: 10 }, (_, i) =>
      makeRow({ contract: `W${i}`, liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'BIG_WINNER' }));
    const unknowns = Array.from({ length: 90 }, (_, i) =>
      makeRow({ contract: `U${i}`, liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'UNKNOWN' }));
    writeLines(mp, [...winners, ...unknowns]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [pDef] });
    const art = result.patterns[0]!.artifact;
    expect(art.observedWin5Rate).toBeCloseTo(1.0);  // 10/10
    expect(art.pessimisticWin5Rate).toBeCloseTo(0.10);  // 10/100
    expect(art.artifactRisk).toBe('HIGH');
  });

  it('artifactNotes contains note about null liqUsd', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const pDef: FocusPatternDef = {
      name: 'P', label: 'p',
      matches: r => (r as any).liquidityBucket === 'LIQ_UNKNOWN',
    };
    writeLines(mp, [
      makeRow({ contract: 'A', liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'BIG_WINNER' }),
    ]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [pDef] });
    const notes = result.patterns[0]!.artifact.artifactNotes;
    expect(notes.some(n => n.includes('liquidityUsd=null'))).toBe(true);
  });

  it('LIKELY_ARTIFACT verdict when artifact risk HIGH and pessimistic rate low', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const pDef: FocusPatternDef = {
      name: 'P', label: 'p',
      matches: r => (r as any).liquidityBucket === 'LIQ_UNKNOWN',
    };
    // 5% pessimistic rate (5 winners, 95 unlabeled)
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeRow({ contract: `W${i}`, liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'BIG_WINNER' })),
      ...Array.from({ length: 95 }, (_, i) =>
        makeRow({ contract: `U${i}`, liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'UNKNOWN' })),
    ];
    writeLines(mp, rows);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [pDef] });
    expect(result.patterns[0]!.verdict).toBe('LIKELY_ARTIFACT');
  });

  it('UNCERTAIN verdict when artifact risk HIGH but pessimistic rate near baseline', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const pDef: FocusPatternDef = {
      name: 'P', label: 'p',
      matches: r => (r as any).liquidityBucket === 'LIQ_UNKNOWN',
    };
    // 20% pessimistic (20 winners, 80 unlabeled) — approaches baseline
    const rows = [
      ...Array.from({ length: 20 }, (_, i) =>
        makeRow({ contract: `W${i}`, liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'BIG_WINNER' })),
      ...Array.from({ length: 80 }, (_, i) =>
        makeRow({ contract: `U${i}`, liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'UNKNOWN' })),
    ];
    writeLines(mp, rows);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [pDef] });
    expect(result.patterns[0]!.verdict).toBe('UNCERTAIN');
  });
});

// ── Safety flags ──────────────────────────────────────────────────────────────

describe('ripperHistoricalWinnerReplay — safety flags', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('result has all required safety fields', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [] });
    expect(result.reportOnly).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });

  it('renderer contains REPORT_ONLY and DO_NOT_ENABLE_REAL_TRADING', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [] });
    const output = renderHistoricalWinnerReplay(result);
    expect(output).toContain('REPORT_ONLY=true');
    expect(output).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(output).toContain('NO_POLICY_CHANGE=true');
    expect(output).toContain('tradingExecuted=0');
    expect(output).toContain('realTradingLocked=true');
  });

  it('renderer contains disclaimer about not being wired into autopilot', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [] });
    const output = renderHistoricalWinnerReplay(result);
    expect(output).toContain('NOT wired into any gate');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('ripperHistoricalWinnerReplay — edge cases', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('handles missing file gracefully', () => {
    const result = runHistoricalWinnerReplay({
      learningMemoryPath: path.join(dir, 'missing.jsonl'),
      patterns: FOCUS_PATTERN_DEFS,
    });
    expect(result.totalMemoryRows).toBe(0);
    expect(result.patterns.every(p => p.total === 0)).toBe(true);
  });

  it('handles invalid JSON lines', () => {
    const mp = path.join(dir, 'mem.jsonl');
    fs.writeFileSync(mp,
      `{invalid json}\n${JSON.stringify(makeRow({ outcomeLabel: 'BIG_WINNER' }))}\n`);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [] });
    expect(result.totalMemoryRows).toBe(1);
  });

  it('empty pattern list returns empty patterns array', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [] });
    expect(result.patterns.length).toBe(0);
  });

  it('doNotBlockPatterns excludes HIGH artifact risk patterns', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const pDef: FocusPatternDef = {
      name: 'ART',
      label: 'artifact test',
      matches: r => (r as any).liquidityBucket === 'LIQ_UNKNOWN',
    };
    // High win5 but artifact risk HIGH — should be excluded from doNotBlock
    writeLines(mp, [
      ...Array.from({ length: 20 }, (_, i) =>
        makeRow({
          contract: `W${i}`,
          liquidityBucket: 'LIQ_UNKNOWN',
          liquidityUsd: null,
          outcomeLabel: 'BIG_WINNER',
          wouldRejectByLiqOrAge: true,
        })),
      ...Array.from({ length: 80 }, (_, i) =>
        makeRow({ contract: `U${i}`, liquidityBucket: 'LIQ_UNKNOWN', liquidityUsd: null, outcomeLabel: 'UNKNOWN' })),
    ]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [pDef] });
    const dontBlock = result.doNotBlockPatterns.find(p => p.patternName === 'ART');
    expect(dontBlock).toBeUndefined();  // excluded due to artifact risk
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('ripperHistoricalWinnerReplay — renderer', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('renders pattern name, verdict, and artifact risk', () => {
    const mp = path.join(dir, 'mem.jsonl');
    const pDef: FocusPatternDef = {
      name: 'MY_PATTERN', label: 'my test pattern',
      matches: r => (r as any).clusterRisk === 'WATCH',
    };
    writeLines(mp, [
      makeRow({ contract: 'A', clusterRisk: 'WATCH', liquidityUsd: 15000, outcomeLabel: 'BIG_WINNER' }),
      makeRow({ contract: 'B', clusterRisk: 'WATCH', liquidityUsd: 20000, outcomeLabel: 'FLAT_JUNK' }),
    ]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [pDef] });
    const output = renderHistoricalWinnerReplay(result);
    expect(output).toContain('MY_PATTERN');
    expect(output).toContain('Artifact Warning');
    expect(output).toContain('Verdict');
    expect(output).toContain('LIKELY_REAL_SIGNAL');
  });

  it('renders section headers', () => {
    const mp = path.join(dir, 'mem.jsonl');
    writeLines(mp, [makeRow()]);
    const result = runHistoricalWinnerReplay({ learningMemoryPath: mp, patterns: [] });
    const output = renderHistoricalWinnerReplay(result);
    expect(output).toContain('OVERVIEW');
    expect(output).toContain('DO-NOT-BLOCK PATTERNS');
    expect(output).toContain('SAFETY');
  });
});
