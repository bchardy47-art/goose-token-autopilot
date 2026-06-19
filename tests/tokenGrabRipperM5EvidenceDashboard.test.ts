import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import {
  runM5EvidenceDashboard,
  renderM5EvidenceDashboard,
  m5ToBand,
  getMaturity,
  getConfidenceTier,
  type M5EvidenceDashboardResult,
} from '../src/token-grab/ripperM5EvidenceDashboard';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n'));
}

interface TmpPaths {
  root:        string;
  memoryPath:  string;
  intentsPath: string;
}

function makeTmp(): TmpPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm5dash-'));
  return {
    root,
    memoryPath:  path.join(root, 'learning-memory.jsonl'),
    intentsPath: path.join(root, 'paper-intents.jsonl'),
  };
}

function baseOpts(t: TmpPaths) {
  return { memoryPath: t.memoryPath, intentsPath: t.intentsPath, generatedAt: '2026-06-19T05:00:00.000Z' };
}

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract:        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa',
    capturedAt:      '2026-06-19T04:57:55.975Z',
    observedAt:      '2026-06-19T04:57:55.975Z',
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

// ── Pure function tests ───────────────────────────────────────────────────────

describe('m5ToBand', () => {
  it('returns UNAVAILABLE for null', () => expect(m5ToBand(null)).toBe('UNAVAILABLE'));
  it('returns UNAVAILABLE for undefined', () => expect(m5ToBand(undefined)).toBe('UNAVAILABLE'));
  it('returns UNAVAILABLE for NaN', () => expect(m5ToBand(NaN)).toBe('UNAVAILABLE'));
  it('returns M5_VERY_NEGATIVE for -20', () => expect(m5ToBand(-20)).toBe('M5_VERY_NEGATIVE'));
  it('returns M5_VERY_NEGATIVE for -100', () => expect(m5ToBand(-100)).toBe('M5_VERY_NEGATIVE'));
  it('returns M5_NEGATIVE for -19.9', () => expect(m5ToBand(-19.9)).toBe('M5_NEGATIVE'));
  it('returns M5_NEGATIVE for -5.1', () => expect(m5ToBand(-5.1)).toBe('M5_NEGATIVE'));
  it('returns M5_NEUTRAL for -5', () => expect(m5ToBand(-5)).toBe('M5_NEUTRAL'));
  it('returns M5_NEUTRAL for 0', () => expect(m5ToBand(0)).toBe('M5_NEUTRAL'));
  it('returns M5_NEUTRAL for 5', () => expect(m5ToBand(5)).toBe('M5_NEUTRAL'));
  it('returns M5_POSITIVE for 5.1', () => expect(m5ToBand(5.1)).toBe('M5_POSITIVE'));
  it('returns M5_POSITIVE for 20', () => expect(m5ToBand(20)).toBe('M5_POSITIVE'));
  it('returns M5_STRONG for 20.1', () => expect(m5ToBand(20.1)).toBe('M5_STRONG'));
  it('returns M5_STRONG for 50', () => expect(m5ToBand(50)).toBe('M5_STRONG'));
  it('returns M5_VERY_STRONG for 50.1', () => expect(m5ToBand(50.1)).toBe('M5_VERY_STRONG'));
  it('returns M5_VERY_STRONG for 999', () => expect(m5ToBand(999)).toBe('M5_VERY_STRONG'));
});

describe('getMaturity', () => {
  it('NO_M5_DATA for 0', ()    => expect(getMaturity(0)).toBe('NO_M5_DATA'));
  it('TINY_SAMPLE for 1', ()   => expect(getMaturity(1)).toBe('TINY_SAMPLE'));
  it('TINY_SAMPLE for 49', ()  => expect(getMaturity(49)).toBe('TINY_SAMPLE'));
  it('EARLY_SAMPLE for 50', () => expect(getMaturity(50)).toBe('EARLY_SAMPLE'));
  it('EARLY_SAMPLE for 199', ()=> expect(getMaturity(199)).toBe('EARLY_SAMPLE'));
  it('USABLE_SAMPLE for 200', ()=> expect(getMaturity(200)).toBe('USABLE_SAMPLE'));
  it('USABLE_SAMPLE for 499', ()=> expect(getMaturity(499)).toBe('USABLE_SAMPLE'));
  it('STRONG_SAMPLE for 500', ()=> expect(getMaturity(500)).toBe('STRONG_SAMPLE'));
});

describe('getConfidenceTier', () => {
  it('IGNORE for 0', ()             => expect(getConfidenceTier(0)).toBe('IGNORE'));
  it('IGNORE for 19', ()            => expect(getConfidenceTier(19)).toBe('IGNORE'));
  it('INTERESTING_ONLY for 20', ()  => expect(getConfidenceTier(20)).toBe('INTERESTING_ONLY'));
  it('INTERESTING_ONLY for 49', ()  => expect(getConfidenceTier(49)).toBe('INTERESTING_ONLY'));
  it('EARLY_EVIDENCE for 50', ()    => expect(getConfidenceTier(50)).toBe('EARLY_EVIDENCE'));
  it('EARLY_EVIDENCE for 199', ()   => expect(getConfidenceTier(199)).toBe('EARLY_EVIDENCE'));
  it('USABLE_SIGNAL for 200', ()    => expect(getConfidenceTier(200)).toBe('USABLE_SIGNAL'));
  it('STRONGER for 500', ()         => expect(getConfidenceTier(500)).toBe('STRONGER'));
});

// ── runM5EvidenceDashboard tests ─────────────────────────────────────────────

describe('runM5EvidenceDashboard', () => {
  let t: TmpPaths;
  beforeEach(() => { t = makeTmp(); });
  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  // ── Missing files ───────────────────────────────────────────────────────

  describe('missing memory file', () => {
    it('handles missing memory file safely (no crash)', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.totalRows).toBe(0);
    });

    it('returns NO_M5_DATA maturity for empty file', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.evidenceMaturity).toBe('NO_M5_DATA');
    });

    it('returns KEEP_COLLECTING recommendation when no data', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.recommendation).toBe('KEEP_COLLECTING');
    });

    it('returns empty band stats with correct band order', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.bandStats).toHaveLength(7); // 6 M5 bands + UNAVAILABLE
      expect(r.bandStats.map(b => b.band)).toContain('UNAVAILABLE');
    });
  });

  // ── No M5 rows ──────────────────────────────────────────────────────────

  describe('no M5 rows', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ priceChangePct: 10  }),
        makeRow({ priceChangePct: -5  }),
        makeRow({ priceChangePct: 30  }),
      ]);
    });

    it('rowsWithM5 = 0', () => {
      expect(runM5EvidenceDashboard(baseOpts(t)).rowsWithM5).toBe(0);
    });

    it('rowsWithoutM5 = 3', () => {
      expect(runM5EvidenceDashboard(baseOpts(t)).rowsWithoutM5).toBe(3);
    });

    it('m5CoveragePct = 0', () => {
      expect(runM5EvidenceDashboard(baseOpts(t)).m5CoveragePct).toBe(0);
    });

    it('evidenceMaturity = NO_M5_DATA', () => {
      expect(runM5EvidenceDashboard(baseOpts(t)).evidenceMaturity).toBe('NO_M5_DATA');
    });

    it('m5RowsWithPnl = 0', () => {
      expect(runM5EvidenceDashboard(baseOpts(t)).m5RowsWithPnl).toBe(0);
    });

    it('all bands have n=0 for M5 bands', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const m5Bands = r.bandStats.filter(b => b.band !== 'UNAVAILABLE');
      expect(m5Bands.every(b => b.n === 0)).toBe(true);
    });

    it('UNAVAILABLE band gets all 3 rows', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const unavail = r.bandStats.find(b => b.band === 'UNAVAILABLE');
      expect(unavail?.n).toBe(3);
    });
  });

  // ── TINY_SAMPLE classification ───────────────────────────────────────────

  describe('TINY_SAMPLE classification', () => {
    beforeEach(() => {
      // 10 rows with M5
      writeJsonl(t.memoryPath, Array.from({ length: 10 }, (_, i) =>
        makeRow({ entryMomentumPct: (i - 5) * 3, priceChangePct: i * 2 }),
      ));
    });

    it('evidenceMaturity = TINY_SAMPLE', () => {
      expect(runM5EvidenceDashboard(baseOpts(t)).evidenceMaturity).toBe('TINY_SAMPLE');
    });

    it('rowsWithM5 = 10', () => {
      expect(runM5EvidenceDashboard(baseOpts(t)).rowsWithM5).toBe(10);
    });

    it('m5CoveragePct = 100', () => {
      expect(runM5EvidenceDashboard(baseOpts(t)).m5CoveragePct).toBe(100);
    });

    it('recommendation = KEEP_COLLECTING', () => {
      expect(runM5EvidenceDashboard(baseOpts(t)).recommendation).toBe('KEEP_COLLECTING');
    });
  });

  // ── M5 band stats ────────────────────────────────────────────────────────

  describe('M5 band stats computation', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ entryMomentumPct: 10,  priceChangePct: 50  }),  // M5_POSITIVE winner
        makeRow({ entryMomentumPct: 10,  priceChangePct: -5  }),  // M5_POSITIVE loser
        makeRow({ entryMomentumPct: -10, priceChangePct: 20  }),  // M5_NEGATIVE winner
        makeRow({ entryMomentumPct: -10, priceChangePct: 30  }),  // M5_NEGATIVE winner
        makeRow({ entryMomentumPct: 2,   priceChangePct: 0   }),  // M5_NEUTRAL flat
      ]);
    });

    it('M5_POSITIVE band has n=2', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const b = r.bandStats.find(x => x.band === 'M5_POSITIVE');
      expect(b?.n).toBe(2);
    });

    it('M5_POSITIVE band win rate = 0.5', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const b = r.bandStats.find(x => x.band === 'M5_POSITIVE');
      expect(b?.winRate).toBeCloseTo(0.5);
    });

    it('M5_NEGATIVE band has 2 wins', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const b = r.bandStats.find(x => x.band === 'M5_NEGATIVE');
      expect(b?.wins).toBe(2);
      expect(b?.winRate).toBe(1);
    });

    it('M5_NEUTRAL band has flat pnl = 0', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const b = r.bandStats.find(x => x.band === 'M5_NEUTRAL');
      expect(b?.avgPnlRaw).toBeCloseTo(0);
    });

    it('big winner counted when pnl >= 20', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const b = r.bandStats.find(x => x.band === 'M5_POSITIVE');
      expect(b?.bigWinners).toBe(1); // 50% qualifies
    });

    it('big loser counted when pnl <= -20', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      // -5 does not qualify as big loser
      const b = r.bandStats.find(x => x.band === 'M5_POSITIVE');
      expect(b?.bigLosers).toBe(0);
    });
  });

  // ── Capped avg P/L ───────────────────────────────────────────────────────

  describe('capped avg P/L', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ entryMomentumPct: 10, priceChangePct: 1000 }), // capped to 500
        makeRow({ entryMomentumPct: 10, priceChangePct: 100  }),
      ]);
    });

    it('avgPnlRaw reflects uncapped value', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const b = r.bandStats.find(x => x.band === 'M5_POSITIVE');
      expect(b?.avgPnlRaw).toBeCloseTo(550);
    });

    it('avgPnlCapped uses 500 cap', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const b = r.bandStats.find(x => x.band === 'M5_POSITIVE');
      expect(b?.avgPnlCapped).toBeCloseTo(300); // (500+100)/2
    });
  });

  // ── Median P/L ───────────────────────────────────────────────────────────

  describe('median P/L', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ entryMomentumPct: 3, priceChangePct: 1  }),
        makeRow({ entryMomentumPct: 3, priceChangePct: 3  }),
        makeRow({ entryMomentumPct: 3, priceChangePct: 5  }),
        makeRow({ entryMomentumPct: 3, priceChangePct: 7  }),
        makeRow({ entryMomentumPct: 3, priceChangePct: 9  }),
      ]);
    });

    it('median of odd-length array', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const b = r.bandStats.find(x => x.band === 'M5_NEUTRAL');
      expect(b?.medianPnl).toBe(5);
    });
  });

  // ── Liquidity cross-tab ──────────────────────────────────────────────────

  describe('liquidity cross-tab', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ entryMomentumPct: 10, liquidityBucket: 'LIQ_10K_30K',   priceChangePct: 20 }),
        makeRow({ entryMomentumPct: 10, liquidityBucket: 'LIQ_10K_30K',   priceChangePct: -5 }),
        makeRow({ entryMomentumPct: 10, liquidityBucket: 'LIQ_30K_100K',  priceChangePct: 50 }),
      ]);
    });

    it('has cells for M5_POSITIVE x LIQ_10K_30K and M5_POSITIVE x LIQ_30K_100K', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const keys = r.liqCrossTab.map(c => `${c.m5Band}:${c.secondaryKey}`);
      expect(keys).toContain('M5_POSITIVE:LIQ_10K_30K');
      expect(keys).toContain('M5_POSITIVE:LIQ_30K_100K');
    });

    it('LIQ_10K_30K cell win rate = 0.5 (1 win, 1 loss)', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const cell = r.liqCrossTab.find(c => c.secondaryKey === 'LIQ_10K_30K');
      expect(cell?.winRate).toBeCloseTo(0.5);
    });

    it('does not include UNAVAILABLE band in cross-tabs', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.liqCrossTab.every(c => c.m5Band !== 'UNAVAILABLE')).toBe(true);
    });
  });

  // ── VLR cross-tab ────────────────────────────────────────────────────────

  describe('VLR cross-tab', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ entryMomentumPct: -10, vlrBucket: 'VLR_LT_0_5',   priceChangePct: 15 }),
        makeRow({ entryMomentumPct: -10, vlrBucket: 'VLR_0_5_TO_2', priceChangePct: -10 }),
      ]);
    });

    it('has VLR cells for M5_NEGATIVE band', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.vlrCrossTab.some(c => c.m5Band === 'M5_NEGATIVE')).toBe(true);
    });

    it('VLR_LT_0_5 cell has 1 win', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const cell = r.vlrCrossTab.find(c => c.secondaryKey === 'VLR_LT_0_5');
      expect(cell?.wins).toBe(1);
    });
  });

  // ── Cluster cross-tab ────────────────────────────────────────────────────

  describe('cluster cross-tab', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ entryMomentumPct: 3, clusterRisk: 'CLEAN', priceChangePct: 25 }),
        makeRow({ entryMomentumPct: 3, clusterRisk: 'WATCH', priceChangePct: -8 }),
      ]);
    });

    it('has CLEAN and WATCH cells', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const keys = r.clusterCrossTab.map(c => c.secondaryKey);
      expect(keys).toContain('CLEAN');
      expect(keys).toContain('WATCH');
    });

    it('CLEAN cell big winner count = 1 (pnl=25 >= 20)', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const cell = r.clusterCrossTab.find(c => c.secondaryKey === 'CLEAN');
      expect(cell?.bigWinners).toBe(1);
    });
  });

  // ── Timing path cross-tab ────────────────────────────────────────────────

  describe('timing cross-tab', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ entryMomentumPct: 8, timingPath: 'ENTER_NOW', priceChangePct: 30 }),
        makeRow({ entryMomentumPct: 8, timingPath: 'WAIT_10M',  priceChangePct: -2 }),
      ]);
    });

    it('has ENTER_NOW and WAIT_10M cells for M5_POSITIVE', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const keys = r.timingCrossTab.map(c => c.secondaryKey);
      expect(keys).toContain('ENTER_NOW');
      expect(keys).toContain('WAIT_10M');
    });

    it('ENTER_NOW win rate = 1', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const cell = r.timingCrossTab.find(c => c.secondaryKey === 'ENTER_NOW');
      expect(cell?.winRate).toBe(1);
    });
  });

  // ── False comfort cases ──────────────────────────────────────────────────

  describe('false comfort cases (positive M5, losing)', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ entryMomentumPct: 10, priceChangePct: -5  }),   // false comfort
        makeRow({ entryMomentumPct: 25, priceChangePct: -15 }),   // false comfort (bigger loss first)
        makeRow({ entryMomentumPct: 8,  priceChangePct: 20  }),   // not false comfort (winner)
        makeRow({ entryMomentumPct: -5, priceChangePct: -3  }),   // not false comfort (negative M5)
      ]);
    });

    it('detects 2 false comfort cases', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.falseComfortCases).toHaveLength(2);
    });

    it('false comfort cases all have positive M5', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.falseComfortCases.every(c => c.m5 > 0)).toBe(true);
    });

    it('false comfort cases all have non-positive PNL', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.falseComfortCases.every(c => c.pnl <= 0)).toBe(true);
    });

    it('worst loss appears first (sorted by pnl ascending)', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.falseComfortCases[0].pnl).toBe(-15);
    });

    it('false comfort includes m5Band', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.falseComfortCases[0].m5Band).toBeDefined();
    });
  });

  // ── Negative M5 winners ──────────────────────────────────────────────────

  describe('negative M5 winners (M5 <= 0, positive PNL)', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ entryMomentumPct: -8,  priceChangePct: 30  }),  // neg M5 winner
        makeRow({ entryMomentumPct: 0,   priceChangePct: 5   }),  // flat M5 winner
        makeRow({ entryMomentumPct: 5,   priceChangePct: 20  }),  // positive M5 — not in this list
        makeRow({ entryMomentumPct: -3,  priceChangePct: -2  }),  // neg M5 loser — not included
      ]);
    });

    it('detects 2 negative M5 winners', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.negativeM5Winners).toHaveLength(2);
    });

    it('all negative M5 winners have M5 <= 0', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.negativeM5Winners.every(c => c.m5 <= 0)).toBe(true);
    });

    it('all negative M5 winners have positive PNL', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.negativeM5Winners.every(c => c.pnl > 0)).toBe(true);
    });

    it('best winner appears first (sorted by pnl descending)', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.negativeM5Winners[0].pnl).toBe(30);
    });
  });

  // ── Recommendation ───────────────────────────────────────────────────────

  describe('recommendation', () => {
    it('KEEP_COLLECTING when m5RowsWithPnl < 200', () => {
      writeJsonl(t.memoryPath, Array.from({ length: 10 }, () =>
        makeRow({ entryMomentumPct: 5, priceChangePct: 10 }),
      ));
      expect(runM5EvidenceDashboard(baseOpts(t)).recommendation).toBe('KEEP_COLLECTING');
    });

    it('KEEP_COLLECTING when memory file is empty', () => {
      expect(runM5EvidenceDashboard(baseOpts(t)).recommendation).toBe('KEEP_COLLECTING');
    });

    it('KEEP_COLLECTING when m5RowsWithPnl = 0 even if many non-M5 rows exist', () => {
      writeJsonl(t.memoryPath, Array.from({ length: 300 }, () =>
        makeRow({ priceChangePct: 10 }), // no M5
      ));
      expect(runM5EvidenceDashboard(baseOpts(t)).recommendation).toBe('KEEP_COLLECTING');
    });
  });

  // ── Symbol lookup from intents ────────────────────────────────────────────

  describe('symbol lookup from intents', () => {
    beforeEach(() => {
      writeJsonl(t.intentsPath, [
        { contract: 'CONTRACTabcdef', symbol: 'MYSYM' },
      ]);
      writeJsonl(t.memoryPath, [
        makeRow({ contract: 'CONTRACTabcdef', entryMomentumPct: 10, priceChangePct: -5 }),
      ]);
    });

    it('resolves symbol from intents for false comfort cases', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      const fc = r.falseComfortCases.find(c => c.contract === 'CONTRACTabcdef');
      expect(fc?.symbol).toBe('MYSYM');
    });
  });

  // ── File not mutated ─────────────────────────────────────────────────────

  describe('no file mutation', () => {
    it('does not write to memory file', () => {
      writeJsonl(t.memoryPath, [
        makeRow({ entryMomentumPct: 5, priceChangePct: 10 }),
      ]);
      const before = fs.readFileSync(t.memoryPath, 'utf-8');
      runM5EvidenceDashboard(baseOpts(t));
      const after = fs.readFileSync(t.memoryPath, 'utf-8');
      expect(after).toBe(before);
    });
  });

  // ── Safety flags ─────────────────────────────────────────────────────────

  describe('safety flags', () => {
    it('always returns all safety flags correctly', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
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

  // ── generatedAt ──────────────────────────────────────────────────────────

  describe('generatedAt', () => {
    it('uses the provided generatedAt', () => {
      const r = runM5EvidenceDashboard({ ...baseOpts(t), generatedAt: '2026-06-19T05:00:00.000Z' });
      expect(r.generatedAt).toBe('2026-06-19T05:00:00.000Z');
    });
  });

  // ── Latest timestamps ────────────────────────────────────────────────────

  describe('latest timestamps', () => {
    beforeEach(() => {
      writeJsonl(t.memoryPath, [
        makeRow({ observedAt: '2026-06-19T01:00:00Z', capturedAt: '2026-06-19T00:00:00Z' }),
        makeRow({ observedAt: '2026-06-19T03:00:00Z', capturedAt: '2026-06-19T02:00:00Z' }),
      ]);
    });

    it('picks latest observedAt', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.latestObservedAt).toBe('2026-06-19T03:00:00Z');
    });

    it('picks latest capturedAt', () => {
      const r = runM5EvidenceDashboard(baseOpts(t));
      expect(r.latestCapturedAt).toBe('2026-06-19T02:00:00Z');
    });
  });
});

// ── renderM5EvidenceDashboard ─────────────────────────────────────────────────

describe('renderM5EvidenceDashboard', () => {
  let t: TmpPaths;

  beforeEach(() => {
    t = makeTmp();
    writeJsonl(t.memoryPath, [
      makeRow({ entryMomentumPct: 10,  priceChangePct: 30,  contract: 'CON1' }),
      makeRow({ entryMomentumPct: -5,  priceChangePct: -10, contract: 'CON2' }),
      makeRow({ entryMomentumPct: 15,  priceChangePct: -8,  contract: 'CON3' }),
      makeRow({ entryMomentumPct: -12, priceChangePct: 25,  contract: 'CON4' }),
      makeRow({ priceChangePct: 5,                          contract: 'CON5' }),
    ]);
  });

  afterEach(() => { fs.rmSync(t.root, { recursive: true, force: true }); });

  it('renders all 11 section headers', () => {
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
    for (let i = 1; i <= 11; i++) {
      expect(out).toContain(`SECTION ${i}`);
    }
  });

  it('renders OVERVIEW section with coverage', () => {
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
    expect(out).toContain('M5 coverage');
    expect(out).toContain('Evidence maturity');
  });

  it('renders M5 BAND PERFORMANCE section', () => {
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
    expect(out).toContain('M5 BAND PERFORMANCE');
    expect(out).toContain('M5_POSITIVE');
  });

  it('renders cross-tab sections', () => {
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
    expect(out).toContain('M5 × LIQUIDITY');
    expect(out).toContain('M5 × VLR');
    expect(out).toContain('M5 × CLUSTER RISK');
    expect(out).toContain('TIMING PATH BY M5 BAND');
  });

  it('renders FALSE COMFORT section', () => {
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
    expect(out).toContain('FALSE COMFORT CASES');
  });

  it('renders NEGATIVE M5 WINNERS section', () => {
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
    expect(out).toContain('NEGATIVE M5 WINNERS');
  });

  it('renders EVIDENCE CONCLUSIONS section', () => {
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
    expect(out).toContain('EVIDENCE CONCLUSIONS');
    expect(out).toContain('Not proven yet');
  });

  it('renders RECOMMENDATION section', () => {
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
    expect(out).toContain('RECOMMENDATION');
    expect(out).toContain(r.recommendation);
  });

  it('renders safety footer with all required flags', () => {
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
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
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('renders banner with report-only labels', () => {
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
    expect(out).toContain('M5 EVIDENCE DASHBOARD');
    expect(out).toContain('REPORT ONLY');
    expect(out).toContain('READ ONLY');
    expect(out).toContain('NO MUTATION');
    expect(out).toContain('NO GATE CHANGES');
    expect(out).toContain('NO POLICY CHANGE');
  });

  it('does not change gates or policy', () => {
    // Render should produce no action verbs implying gate changes
    const r = runM5EvidenceDashboard(baseOpts(t));
    const out = renderM5EvidenceDashboard(r);
    expect(out).not.toContain('GATE_CHANGE_APPROVED');
    expect(out).not.toContain('POLICY_CHANGED');
  });
});
