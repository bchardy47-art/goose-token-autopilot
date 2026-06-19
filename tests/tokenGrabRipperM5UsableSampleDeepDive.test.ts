import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runM5UsableSampleDeepDive,
  renderM5UsableSampleDeepDive,
  type M5UsableSampleDeepDiveResult,
} from '../src/token-grab/ripperM5UsableSampleDeepDive';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

interface TmpPaths {
  root:       string;
  memoryPath: string;
}

function makeTmp(): TmpPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm5deep-'));
  return { root, memoryPath: path.join(root, 'learning-memory.jsonl') };
}

function baseOpts(t: TmpPaths) {
  return { memoryPath: t.memoryPath, generatedAt: '2026-06-19T05:00:00.000Z' };
}

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract:        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa',
    capturedAt:      '2026-06-19T04:57:00.000Z',
    observedAt:      '2026-06-19T04:57:00.000Z',
    priceChangePct:  10,
    liquidityBucket: 'LIQ_10K_30K',
    vlrBucket:       'VLR_LT_0_5',
    clusterRisk:     'CLEAN',
    timingPath:      'ENTER_NOW',
    gateDecision:    'BUY_APPROVED_PAPER',
    entryDecision:   'READY_TO_SNIPE_PAPER',
    reportOnly:      true,
    readOnly:        true,
    paperOnly:       true,
    realTradingLocked: true,
    tradingExecuted:   0,
    ...overrides,
  };
}

function makeNeutralRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeRow({ entryMomentumPct: 2, ...overrides });
}

function makeStrongRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeRow({ entryMomentumPct: 30, ...overrides });
}

// ── Missing memory file ───────────────────────────────────────────────────────

describe('missing memory file', () => {
  let t: TmpPaths;
  beforeEach(() => { t = makeTmp(); });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('handles missing memory file safely (no crash)', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.totalRows).toBe(0);
  });

  it('returns NO_M5_DATA maturity for missing file', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.evidenceMaturity).toBe('NO_M5_DATA');
  });

  it('returns KEEP_COLLECTING recommendation for missing file', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.recommendation).toBe('KEEP_COLLECTING');
  });

  it('returns safe band scoreboard with 7 entries', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.bandScoreboard).toHaveLength(7); // 6 bands + UNAVAILABLE
  });

  it('neutralDeepDive has no PNL rows', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.neutralDeepDive.pnlN).toBe(0);
  });

  it('strongDeepDive has no PNL rows', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.strongDeepDive.pnlN).toBe(0);
  });
});

// ── No M5+PNL rows ────────────────────────────────────────────────────────────

describe('no M5+PNL rows', () => {
  let t: TmpPaths;
  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeRow({ priceChangePct: 10  }),
      makeRow({ priceChangePct: -5  }),
      makeRow({ priceChangePct: 30  }),
    ]);
  });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('m5RowsWithPnl = 0', () => {
    expect(runM5UsableSampleDeepDive(baseOpts(t)).m5RowsWithPnl).toBe(0);
  });

  it('KEEP_COLLECTING when no M5+PNL rows', () => {
    expect(runM5UsableSampleDeepDive(baseOpts(t)).recommendation).toBe('KEEP_COLLECTING');
  });

  it('rowsWithPnl = 3 even without M5', () => {
    expect(runM5UsableSampleDeepDive(baseOpts(t)).rowsWithPnl).toBe(3);
  });
});

// ── M5 band scoreboard ────────────────────────────────────────────────────────

describe('M5 band scoreboard', () => {
  let t: TmpPaths;
  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeNeutralRow({ priceChangePct: 50  }),  // big winner
      makeNeutralRow({ priceChangePct: -5  }),  // loser
      makeNeutralRow({ priceChangePct: 10  }),  // winner
      makeStrongRow({  priceChangePct: -25 }),  // big loser
    ]);
  });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('M5_NEUTRAL has n=3', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const b = r.bandScoreboard.find(x => x.band === 'M5_NEUTRAL');
    expect(b?.n).toBe(3);
  });

  it('M5_NEUTRAL win rate = 2/3', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const b = r.bandScoreboard.find(x => x.band === 'M5_NEUTRAL');
    expect(b?.winRate).toBeCloseTo(2 / 3);
  });

  it('M5_NEUTRAL has 1 big winner (pnl >= 20)', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const b = r.bandScoreboard.find(x => x.band === 'M5_NEUTRAL');
    expect(b?.bigWinners).toBe(1);
  });

  it('M5_STRONG has 1 big loser (pnl <= -20)', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const b = r.bandScoreboard.find(x => x.band === 'M5_STRONG');
    expect(b?.bigLosers).toBe(1);
  });

  it('low-n warning is true when pnlN < 50', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const b = r.bandScoreboard.find(x => x.band === 'M5_NEUTRAL');
    expect(b?.lowNWarning).toBe(true);
  });

  it('capped avg P/L respects 500 cap', () => {
    const t2 = makeTmp();
    writeJsonl(t2.memoryPath, [
      makeNeutralRow({ priceChangePct: 1000 }),
      makeNeutralRow({ priceChangePct: 100  }),
    ]);
    const r = runM5UsableSampleDeepDive({ ...baseOpts(t2) });
    const b = r.bandScoreboard.find(x => x.band === 'M5_NEUTRAL');
    expect(b?.avgPnlCapped).toBeCloseTo(300); // (500 + 100) / 2
    expect(b?.avgPnlRaw).toBeCloseTo(550);
    fs.rmSync(t2.root, { recursive: true, force: true });
  });

  it('median P/L is computed correctly', () => {
    const t2 = makeTmp();
    writeJsonl(t2.memoryPath, [
      makeNeutralRow({ priceChangePct: 1 }),
      makeNeutralRow({ priceChangePct: 3 }),
      makeNeutralRow({ priceChangePct: 5 }),
      makeNeutralRow({ priceChangePct: 7 }),
      makeNeutralRow({ priceChangePct: 9 }),
    ]);
    const r = runM5UsableSampleDeepDive({ ...baseOpts(t2) });
    const b = r.bandScoreboard.find(x => x.band === 'M5_NEUTRAL');
    expect(b?.medianPnl).toBe(5);
    fs.rmSync(t2.root, { recursive: true, force: true });
  });
});

// ── M5_NEUTRAL deep dive ──────────────────────────────────────────────────────

describe('M5_NEUTRAL deep dive', () => {
  let t: TmpPaths;
  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeNeutralRow({ priceChangePct: 30, liquidityBucket: 'LIQ_10K_30K',  vlrBucket: 'VLR_LT_0_5',   clusterRisk: 'CLEAN', timingPath: 'ENTER_NOW' }),
      makeNeutralRow({ priceChangePct: -8, liquidityBucket: 'LIQ_LT_10K',   vlrBucket: 'VLR_GTE_2',    clusterRisk: 'WATCH', timingPath: 'WAIT_10M'  }),
      makeNeutralRow({ priceChangePct: 15, liquidityBucket: 'LIQ_10K_30K',  vlrBucket: 'VLR_LT_0_5',   clusterRisk: 'CLEAN', timingPath: 'ENTER_NOW' }),
      makeNeutralRow({ priceChangePct: -3, liquidityBucket: 'LIQ_GTE_100K', vlrBucket: 'VLR_UNKNOWN',   clusterRisk: 'UNKNOWN', timingPath: 'ENTER_NOW' }),
    ]);
  });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('neutralDeepDive band is M5_NEUTRAL', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.neutralDeepDive.band).toBe('M5_NEUTRAL');
  });

  it('neutralDeepDive pnlN = 4', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.neutralDeepDive.pnlN).toBe(4);
  });

  it('neutralDeepDive wins = 2, losses = 2', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.neutralDeepDive.wins).toBe(2);
    expect(r.neutralDeepDive.losses).toBe(2);
  });

  it('byLiquidity splits by liquidityBucket', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const keys = r.neutralDeepDive.byLiquidity.map(s => s.key);
    expect(keys).toContain('LIQ_10K_30K');
    expect(keys).toContain('LIQ_LT_10K');
    expect(keys).toContain('LIQ_GTE_100K');
  });

  it('byVlr splits by vlrBucket', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const keys = r.neutralDeepDive.byVlr.map(s => s.key);
    expect(keys).toContain('VLR_LT_0_5');
    expect(keys).toContain('VLR_GTE_2');
    expect(keys).toContain('VLR_UNKNOWN');
  });

  it('byCluster splits by clusterRisk', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const keys = r.neutralDeepDive.byCluster.map(s => s.key);
    expect(keys).toContain('CLEAN');
    expect(keys).toContain('WATCH');
    expect(keys).toContain('UNKNOWN');
  });

  it('byTiming splits by timingPath', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const keys = r.neutralDeepDive.byTiming.map(s => s.key);
    expect(keys).toContain('ENTER_NOW');
    expect(keys).toContain('WAIT_10M');
  });

  it('top winners sorted by pnl desc', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const pnls = r.neutralDeepDive.topWinners.map(w => w.pnl);
    expect(pnls[0]).toBeGreaterThanOrEqual(pnls[1] ?? -Infinity);
  });

  it('top losers sorted by pnl asc', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const pnls = r.neutralDeepDive.topLosers.map(l => l.pnl);
    if (pnls.length > 1) {
      expect(pnls[0]).toBeLessThanOrEqual(pnls[1]);
    }
  });

  it('conclusion is non-empty string', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(typeof r.neutralDeepDive.conclusion).toBe('string');
    expect(r.neutralDeepDive.conclusion.length).toBeGreaterThan(0);
  });
});

// ── M5_STRONG deep dive ───────────────────────────────────────────────────────

describe('M5_STRONG deep dive', () => {
  let t: TmpPaths;
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('strongDeepDive band is M5_STRONG', () => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [makeStrongRow({ priceChangePct: -10 })]);
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.strongDeepDive.band).toBe('M5_STRONG');
  });

  it('SAMPLE_TOO_SMALL conclusion when pnlN < 20', () => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeStrongRow({ priceChangePct: -15 }),
      makeStrongRow({ priceChangePct: -20 }),
      makeStrongRow({ priceChangePct: 5   }),
    ]);
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.strongDeepDive.conclusion).toContain('SAMPLE_TOO_SMALL');
  });

  it('PROBABLE_EXHAUSTION conclusion when loss rate >= 60% and avg < -10 with n >= 20', () => {
    t = makeTmp();
    const rows = Array.from({ length: 20 }, (_, i) =>
      makeStrongRow({ priceChangePct: i < 15 ? -25 : 5 }),
    );
    writeJsonl(t.memoryPath, rows);
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.strongDeepDive.conclusion).toContain('PROBABLE_EXHAUSTION');
  });

  it('CANDIDATE_PATTERN_WITH_ARTIFACTS in neutral conclusion when >50% UNKNOWN cluster', () => {
    t = makeTmp();
    // Need n >= 20 to pass SAMPLE_TOO_SMALL threshold
    const rows = [
      ...Array.from({ length: 15 }, () => makeNeutralRow({ clusterRisk: 'UNKNOWN', priceChangePct: 10 })),
      ...Array.from({ length: 6  }, () => makeNeutralRow({ clusterRisk: 'CLEAN',   priceChangePct: 5  })),
    ];
    writeJsonl(t.memoryPath, rows);
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.neutralDeepDive.conclusion).toContain('ARTIFACT');
  });
});

// ── Liquidity cross-tab ───────────────────────────────────────────────────────

describe('liquidity cross-tab', () => {
  let t: TmpPaths;
  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeNeutralRow({ liquidityBucket: 'LIQ_10K_30K',  priceChangePct: 20 }),
      makeNeutralRow({ liquidityBucket: 'LIQ_10K_30K',  priceChangePct: -5 }),
      makeNeutralRow({ liquidityBucket: 'LIQ_LT_10K',   priceChangePct: -15 }),
      makeNeutralRow({ liquidityBucket: 'LIQ_GTE_100K', priceChangePct: 50 }),
    ]);
  });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('has cells for M5_NEUTRAL × LIQ_10K_30K', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.liqCrossTab.some(c => c.m5Band === 'M5_NEUTRAL' && c.secondaryKey === 'LIQ_10K_30K')).toBe(true);
  });

  it('LIQ_LT_10K cell has correct pnlN', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const cell = r.liqCrossTab.find(c => c.secondaryKey === 'LIQ_LT_10K');
    expect(cell?.pnlN).toBe(1);
  });

  it('liqCrossTab cells include bigLosers field', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    for (const c of r.liqCrossTab) {
      expect(typeof c.bigLosers).toBe('number');
    }
  });

  it('liqCrossTab cells include medianPnl field', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const cell = r.liqCrossTab.find(c => c.secondaryKey === 'LIQ_GTE_100K');
    expect(cell?.medianPnl).toBeDefined();
  });

  it('does not include UNAVAILABLE band in cross-tabs', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.liqCrossTab.every(c => c.m5Band !== 'UNAVAILABLE')).toBe(true);
  });
});

// ── VLR cross-tab ─────────────────────────────────────────────────────────────

describe('VLR cross-tab', () => {
  let t: TmpPaths;
  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeNeutralRow({ vlrBucket: 'VLR_LT_0_5',   priceChangePct: 20 }),
      makeNeutralRow({ vlrBucket: 'VLR_GTE_2',    priceChangePct: -10 }),
      makeNeutralRow({ vlrBucket: 'VLR_UNKNOWN',  priceChangePct: 5   }),
      makeStrongRow({  vlrBucket: 'VLR_GTE_2',    priceChangePct: -20 }),
    ]);
  });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('has VLR cells for M5_NEUTRAL', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.vlrCrossTab.some(c => c.m5Band === 'M5_NEUTRAL')).toBe(true);
  });

  it('has VLR_GTE_2 cell for M5_STRONG', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.vlrCrossTab.some(c => c.m5Band === 'M5_STRONG' && c.secondaryKey === 'VLR_GTE_2')).toBe(true);
  });

  it('VLR_UNKNOWN cell is present when data exists', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.vlrCrossTab.some(c => c.secondaryKey === 'VLR_UNKNOWN')).toBe(true);
  });
});

// ── Cluster cross-tab ─────────────────────────────────────────────────────────

describe('cluster cross-tab', () => {
  let t: TmpPaths;
  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeNeutralRow({ clusterRisk: 'CLEAN',   priceChangePct: 30  }),
      makeNeutralRow({ clusterRisk: 'WATCH',   priceChangePct: -8  }),
      makeNeutralRow({ clusterRisk: 'UNKNOWN', priceChangePct: 5   }),
      makeNeutralRow({ clusterRisk: 'UNKNOWN', priceChangePct: 10  }),
    ]);
  });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('has CLEAN, WATCH, UNKNOWN cells', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const keys = r.clusterCrossTab.map(c => c.secondaryKey);
    expect(keys).toContain('CLEAN');
    expect(keys).toContain('WATCH');
    expect(keys).toContain('UNKNOWN');
  });

  it('CLEAN cell has big winner (pnl=30 >= 20)', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const cell = r.clusterCrossTab.find(c => c.secondaryKey === 'CLEAN');
    expect(cell?.bigWinners).toBe(1);
  });

  it('UNKNOWN cluster cell is NOT filtered out (artifact visibility preserved)', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const unknownCell = r.clusterCrossTab.find(c => c.secondaryKey === 'UNKNOWN');
    expect(unknownCell).toBeDefined();
    expect(unknownCell?.pnlN).toBe(2);
  });
});

// ── Timing cross-tab ──────────────────────────────────────────────────────────

describe('timing cross-tab', () => {
  let t: TmpPaths;
  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeNeutralRow({ timingPath: 'ENTER_NOW', priceChangePct: 25 }),
      makeNeutralRow({ timingPath: 'ENTER_NOW', priceChangePct: 10 }),
      makeNeutralRow({ timingPath: 'WAIT_10M',  priceChangePct: -5 }),
      makeStrongRow({  timingPath: 'ENTER_NOW', priceChangePct: -30 }),
    ]);
  });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('has ENTER_NOW and WAIT_10M cells for M5_NEUTRAL', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const neutralTiming = r.timingCrossTab.filter(c => c.m5Band === 'M5_NEUTRAL');
    const keys = neutralTiming.map(c => c.secondaryKey);
    expect(keys).toContain('ENTER_NOW');
    expect(keys).toContain('WAIT_10M');
  });

  it('M5_NEUTRAL ENTER_NOW win rate = 1.0', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const cell = r.timingCrossTab.find(c => c.m5Band === 'M5_NEUTRAL' && c.secondaryKey === 'ENTER_NOW');
    expect(cell?.winRate).toBe(1);
  });

  it('M5_STRONG ENTER_NOW has big loser (pnl=-30 <= -20)', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const cell = r.timingCrossTab.find(c => c.m5Band === 'M5_STRONG' && c.secondaryKey === 'ENTER_NOW');
    expect(cell?.bigLosers).toBe(1);
  });
});

// ── Candidate rules ───────────────────────────────────────────────────────────

describe('candidate rules', () => {
  let t: TmpPaths;
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('candidate rules are all studyOnly=true', () => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeNeutralRow({ priceChangePct: 10 }),
      makeStrongRow({  priceChangePct: -25 }),
    ]);
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.candidateRules.every(c => c.studyOnly === true)).toBe(true);
  });

  it('candidate rules include n and confidenceTier', () => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      ...Array.from({ length: 25 }, () => makeNeutralRow({ priceChangePct: 10 })),
      ...Array.from({ length: 20 }, () => makeStrongRow({  priceChangePct: -25 })),
    ]);
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    for (const rule of r.candidateRules) {
      expect(typeof rule.n).toBe('number');
      expect(rule.confidenceTier).toBeDefined();
    }
  });

  it('candidate rule description contains STUDY_ONLY', () => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      ...Array.from({ length: 25 }, () => makeNeutralRow({ priceChangePct: 10 })),
    ]);
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    if (r.candidateRules.length > 0) {
      expect(r.candidateRules.some(c => c.studyOnly === true)).toBe(true);
    }
  });
});

// ── Recommendation rules ──────────────────────────────────────────────────────

describe('recommendation rules', () => {
  let t: TmpPaths;
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('KEEP_COLLECTING when m5RowsWithPnl < 200', () => {
    t = makeTmp();
    writeJsonl(t.memoryPath, Array.from({ length: 10 }, () =>
      makeNeutralRow({ priceChangePct: 10 }),
    ));
    expect(runM5UsableSampleDeepDive(baseOpts(t)).recommendation).toBe('KEEP_COLLECTING');
  });

  it('KEEP_COLLECTING when strongest band pnlN < 200 even if total >= 200', () => {
    t = makeTmp();
    // 250 total M5+PNL rows, but spread across bands so none has >= 200
    const rows = [
      ...Array.from({ length: 100 }, () => makeNeutralRow({ priceChangePct: 5  })),
      ...Array.from({ length: 80  }, () => makeStrongRow({  priceChangePct: -5 })),
      ...Array.from({ length: 70  }, () => makeRow({ entryMomentumPct: -10, priceChangePct: 5 })),  // M5_NEGATIVE
    ];
    writeJsonl(t.memoryPath, rows);
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.m5RowsWithPnl).toBe(250);
    expect(r.recommendation).toBe('KEEP_COLLECTING');
  });

  it('does not output READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW when m5RowsWithPnl < 500', () => {
    t = makeTmp();
    writeJsonl(t.memoryPath, Array.from({ length: 300 }, () =>
      makeNeutralRow({ priceChangePct: 10 }),
    ));
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.recommendation).not.toBe('READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW');
  });

  it('STUDY_M5_NEUTRAL when neutral pnlN >= 200 and total < 500', () => {
    t = makeTmp();
    writeJsonl(t.memoryPath, Array.from({ length: 250 }, () =>
      makeNeutralRow({ priceChangePct: 10 }),
    ));
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.recommendation).toBe('STUDY_M5_NEUTRAL');
  });

  it('READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW when best band pnlN >= 500', () => {
    t = makeTmp();
    writeJsonl(t.memoryPath, Array.from({ length: 550 }, () =>
      makeNeutralRow({ priceChangePct: 10 }),
    ));
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.recommendation).toBe('READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW');
    expect(r.m5RowsWithPnl).toBeGreaterThanOrEqual(500);
  });
});

// ── Not proven yet ────────────────────────────────────────────────────────────

describe('not proven yet', () => {
  let t: TmpPaths;
  beforeEach(() => { t = makeTmp(); });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('notProvenYet contains gate-change disclaimer', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.notProvenYet.some(s => s.toLowerCase().includes('gate'))).toBe(true);
  });

  it('notProvenYet contains real-trading disclaimer', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.notProvenYet.some(s => s.toLowerCase().includes('real-trading'))).toBe(true);
  });

  it('notProvenYet is non-empty', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.notProvenYet.length).toBeGreaterThan(0);
  });
});

// ── Safety flags ──────────────────────────────────────────────────────────────

describe('safety flags', () => {
  let t: TmpPaths;
  beforeEach(() => { t = makeTmp(); });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('all safety flags are always set correctly', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.noMutation).toBe(true);
    expect(r.noRealTrading).toBe(true);
    expect(r.noGateChanges).toBe(true);
    expect(r.noPolicyChange).toBe(true);
    expect(r.noWallet).toBe(true);
    expect(r.noSwap).toBe(true);
    expect(r.noSigning).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
  });
});

// ── File not mutated ──────────────────────────────────────────────────────────

describe('no file mutation', () => {
  let t: TmpPaths;
  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [makeNeutralRow({ priceChangePct: 5 })]);
  });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('does not mutate the memory file', () => {
    const before = fs.readFileSync(t.memoryPath, 'utf-8');
    runM5UsableSampleDeepDive(baseOpts(t));
    const after = fs.readFileSync(t.memoryPath, 'utf-8');
    expect(after).toBe(before);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderM5UsableSampleDeepDive', () => {
  let t: TmpPaths;

  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeNeutralRow({ priceChangePct: 30,  liquidityBucket: 'LIQ_10K_30K',  clusterRisk: 'CLEAN',   timingPath: 'ENTER_NOW', vlrBucket: 'VLR_LT_0_5' }),
      makeNeutralRow({ priceChangePct: -8,  liquidityBucket: 'LIQ_LT_10K',   clusterRisk: 'WATCH',   timingPath: 'WAIT_10M',  vlrBucket: 'VLR_GTE_2' }),
      makeStrongRow({  priceChangePct: -25, liquidityBucket: 'LIQ_30K_100K', clusterRisk: 'UNKNOWN', timingPath: 'ENTER_NOW', vlrBucket: 'VLR_UNKNOWN' }),
      makeRow({ priceChangePct: 5 }), // no M5
    ]);
  });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('renders all 12 section headers', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    for (let i = 1; i <= 12; i++) {
      expect(out).toContain(`SECTION ${i}`);
    }
  });

  it('renders OVERVIEW section with M5+PNL count', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).toContain('M5+PNL rows');
    expect(out).toContain('Evidence maturity');
  });

  it('renders M5 BAND SCOREBOARD section', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).toContain('M5 BAND SCOREBOARD');
    expect(out).toContain('M5_NEUTRAL');
    expect(out).toContain('M5_STRONG');
  });

  it('renders M5_NEUTRAL DEEP DIVE section', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).toContain('M5_NEUTRAL DEEP DIVE');
    expect(out).toContain('By liquidityBucket');
    expect(out).toContain('By clusterRisk');
    expect(out).toContain('By timingPath');
  });

  it('renders M5_STRONG DEEP DIVE section', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).toContain('M5_STRONG DEEP DIVE');
  });

  it('renders all four cross-tab sections', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).toContain('LIQUIDITY INTERACTION');
    expect(out).toContain('VLR INTERACTION');
    expect(out).toContain('CLUSTER INTERACTION');
    expect(out).toContain('TIMING INTERACTION');
  });

  it('renders CANDIDATE RULES section', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).toContain('CANDIDATE RULES');
  });

  it('renders NOT PROVEN YET section', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).toContain('NOT PROVEN YET');
  });

  it('renders RECOMMENDATION section', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).toContain('RECOMMENDATION');
    expect(out).toContain(r.recommendation);
  });

  it('renders safety footer with all required flags', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).toContain('REPORT_ONLY=true');
    expect(out).toContain('READ_ONLY=true');
    expect(out).toContain('PAPER_ONLY=true');
    expect(out).toContain('NO_MUTATION=true');
    expect(out).toContain('NO_REAL_TRADING=true');
    expect(out).toContain('NO_GATE_CHANGES=true');
    expect(out).toContain('NO_POLICY_CHANGE=true');
    expect(out).toContain('NO_WALLET=true');
    expect(out).toContain('NO_SWAP=true');
    expect(out).toContain('NO_SIGNING=true');
    expect(out).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('realTradingLocked=true');
  });

  it('renders banner with report-only labels', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).toContain('M5 USABLE SAMPLE DEEP DIVE');
    expect(out).toContain('REPORT ONLY');
    expect(out).toContain('READ ONLY');
    expect(out).toContain('NO MUTATION');
    expect(out).toContain('NO GATE CHANGES');
    expect(out).toContain('NO POLICY CHANGE');
  });

  it('does not contain gate-change approval markers', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const out = renderM5UsableSampleDeepDive(r);
    expect(out).not.toContain('GATE_CHANGE_APPROVED');
    expect(out).not.toContain('POLICY_CHANGED');
  });
});

// ── JSON output check (minimal) ───────────────────────────────────────────────

describe('result is JSON-serializable', () => {
  let t: TmpPaths;
  beforeEach(() => { t = makeTmp(); });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('result serializes to JSON without error', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it('JSON output includes all required safety keys', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    const j = JSON.parse(JSON.stringify(r));
    expect(j.reportOnly).toBe(true);
    expect(j.realTradingLocked).toBe(true);
    expect(j.tradingExecuted).toBe(0);
  });
});

// ── generatedAt passthrough ───────────────────────────────────────────────────

describe('generatedAt', () => {
  let t: TmpPaths;
  beforeEach(() => { t = makeTmp(); });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('uses the provided generatedAt', () => {
    const r = runM5UsableSampleDeepDive({ ...baseOpts(t), generatedAt: '2026-06-19T05:00:00.000Z' });
    expect(r.generatedAt).toBe('2026-06-19T05:00:00.000Z');
  });
});

// ── Latest timestamps ─────────────────────────────────────────────────────────

describe('latest timestamps', () => {
  let t: TmpPaths;
  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeRow({ observedAt: '2026-06-19T01:00:00Z', capturedAt: '2026-06-19T00:00:00Z' }),
      makeRow({ observedAt: '2026-06-19T03:00:00Z', capturedAt: '2026-06-19T02:00:00Z' }),
    ]);
  });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('picks latest observedAt', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.latestObservedAt).toBe('2026-06-19T03:00:00Z');
  });

  it('picks latest capturedAt', () => {
    const r = runM5UsableSampleDeepDive(baseOpts(t));
    expect(r.latestCapturedAt).toBe('2026-06-19T02:00:00Z');
  });
});
