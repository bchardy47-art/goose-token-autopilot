import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  runPaperTradeSimulationReport,
  renderPaperTradeSimulationReport,
} from '../src/token-grab/ripperPaperTradeSimulationReport';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir:    string;
let intentsPath: string;
let memoryPath:  string;
let cyclesDir:   string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-'));
  intentsPath = path.join(tmpDir, 'paper-intents.jsonl');
  memoryPath  = path.join(tmpDir, 'learning-memory.jsonl');
  cyclesDir   = path.join(tmpDir, 'cycles');
  fs.mkdirSync(cyclesDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function makeIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentId:         'intent-aaa',
    contract:         'CONTRACT_A',
    symbol:           'TKN',
    status:           'OBSERVED',
    approvedAt:       '2026-06-18T10:00:00.000Z',
    targetEntryAt:    '2026-06-18T10:10:00.000Z',
    paperEntryTiming: 'WAIT_10M',
    reason:           'HIGH_QUALITY_WAIT10_SUBGROUP',
    sourceCycle:      'cycle-2026-06-18-100000',
    clusterRisk:      'CLEAN',
    ripperScore:      90,
    launchAgeBucket:  'PRIME_WINDOW',
    entryDecision:    'READY_TO_SNIPE_PAPER',
    observedAt:       '2026-06-18T10:11:00.000Z',
    priceChangePct:   12.5,
    realTradingLocked: true,
    paperOnly:        true,
    tradingExecuted:  0,
    ...overrides,
  };
}

function makeMemRow(contract: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract,
    liquidityBucket: 'LIQ_10K_30K',
    vlrBucket:       'VLR_LT_0_5',
    timingPath:      'WAIT_10M',
    ...overrides,
  };
}

function makeCycleRow(contract: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    normalizedSignal: { contract },
    entryMomentumPct:         null,
    entryMomentumSource:      'UNAVAILABLE',
    entryMomentumWindowLabel: 'UNAVAILABLE',
    ...overrides,
  };
}

// ── Tests: safety flags ───────────────────────────────────────────────────────

describe('runPaperTradeSimulationReport — safety flags', () => {
  it('always sets all safety flags regardless of data', () => {
    writeJsonl(intentsPath, []);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.noGateChanges).toBe(true);
    expect(r.noFakeTradeMutation).toBe(true);
    expect(r.noRealTrading).toBe(true);
    expect(r.noWallet).toBe(true);
    expect(r.noSwap).toBe(true);
    expect(r.noSigning).toBe(true);
  });
});

// ── Tests: empty / missing data ───────────────────────────────────────────────

describe('runPaperTradeSimulationReport — empty data', () => {
  it('returns zeros when no intents file exists', () => {
    const r = runPaperTradeSimulationReport({
      intentsPath: path.join(tmpDir, 'nonexistent.jsonl'),
      memoryPath,
      cyclesDir,
    });
    expect(r.totalSimulated).toBe(0);
    expect(r.winners).toBe(0);
    expect(r.losers).toBe(0);
    expect(r.winRate).toBe(0);
    expect(r.bestTrade).toBeNull();
    expect(r.worstTrade).toBeNull();
  });

  it('returns zero simulated trades when file is empty', () => {
    writeJsonl(intentsPath, []);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.totalSimulated).toBe(0);
    expect(r.simulatedTrades).toHaveLength(0);
  });

  it('recommendation is SIGNAL_TOO_THIN with 0 trades', () => {
    writeJsonl(intentsPath, []);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.recommendation).toBe('SIGNAL_TOO_THIN');
  });
});

// ── Tests: status filtering ───────────────────────────────────────────────────

describe('runPaperTradeSimulationReport — status filtering', () => {
  it('only includes OBSERVED intents in simulated trades', () => {
    writeJsonl(intentsPath, [
      makeIntent({ status: 'OBSERVED',       intentId: 'obs-1',     priceChangePct: 10 }),
      makeIntent({ status: 'ENTRY_DUE',      intentId: 'due-1',     contract: 'C2' }),
      makeIntent({ status: 'PLANNED',        intentId: 'plan-1',    contract: 'C3' }),
      makeIntent({ status: 'EXPIRED_NO_DATA', intentId: 'exp-1',    contract: 'C4' }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.totalSimulated).toBe(1);
    expect(r.observedIntentsRead).toBe(1);
    expect(r.skippedNonObserved).toBe(3);
    expect(r.simulatedTrades[0].intentId).toBe('obs-1');
  });

  it('skippedNonObserved counts all non-OBSERVED rows', () => {
    writeJsonl(intentsPath, [
      makeIntent({ status: 'OBSERVED',        intentId: 'o1', contract: 'C1', priceChangePct: 5 }),
      makeIntent({ status: 'EXPIRED_NO_DATA', intentId: 'e1', contract: 'C2' }),
      makeIntent({ status: 'EXPIRED_NO_DATA', intentId: 'e2', contract: 'C3' }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.observedIntentsRead).toBe(1);
    expect(r.skippedNonObserved).toBe(2);
  });
});

// ── Tests: simulatedPnlPct = priceChangePct ───────────────────────────────────

describe('runPaperTradeSimulationReport — simulatedPnlPct', () => {
  it('simulatedPnlPct equals priceChangePct from the intent', () => {
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 25.5 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].simulatedPnlPct).toBeCloseTo(25.5);
    expect(r.simulatedTrades[0].priceChangePct).toBeCloseTo(25.5);
  });

  it('handles negative priceChangePct as a loss', () => {
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: -15.0 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].simulatedPnlPct).toBeCloseTo(-15.0);
    expect(r.losers).toBe(1);
    expect(r.winners).toBe(0);
  });

  it('handles zero priceChangePct as a loser (not a win)', () => {
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 0 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.winners).toBe(0);
    expect(r.losers).toBe(1);
    expect(r.flat).toBe(1);
  });
});

// ── Tests: statistics ─────────────────────────────────────────────────────────

describe('runPaperTradeSimulationReport — statistics', () => {
  it('calculates win rate correctly', () => {
    writeJsonl(intentsPath, [
      makeIntent({ intentId: 'a', contract: 'C1', priceChangePct: 10 }),
      makeIntent({ intentId: 'b', contract: 'C2', priceChangePct: -5 }),
      makeIntent({ intentId: 'c', contract: 'C3', priceChangePct: 15 }),
      makeIntent({ intentId: 'd', contract: 'C4', priceChangePct: -2 }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.winners).toBe(2);
    expect(r.losers).toBe(2);
    expect(r.winRate).toBeCloseTo(0.5);
    expect(r.lossRate).toBeCloseTo(0.5);
  });

  it('calculates avg P/L correctly', () => {
    writeJsonl(intentsPath, [
      makeIntent({ intentId: 'a', contract: 'C1', priceChangePct: 10 }),
      makeIntent({ intentId: 'b', contract: 'C2', priceChangePct: 20 }),
      makeIntent({ intentId: 'c', contract: 'C3', priceChangePct: -6 }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    // avg = (10 + 20 - 6) / 3 = 24/3 = 8
    expect(r.avgPnlPct).toBeCloseTo(8);
  });

  it('calculates median P/L correctly', () => {
    writeJsonl(intentsPath, [
      makeIntent({ intentId: 'a', contract: 'C1', priceChangePct: 1 }),
      makeIntent({ intentId: 'b', contract: 'C2', priceChangePct: 3 }),
      makeIntent({ intentId: 'c', contract: 'C3', priceChangePct: 5 }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.medianPnlPct).toBeCloseTo(3);
  });

  it('identifies bestTrade (highest pnl)', () => {
    writeJsonl(intentsPath, [
      makeIntent({ intentId: 'low', contract: 'C1', symbol: 'LOW', priceChangePct: 5 }),
      makeIntent({ intentId: 'high', contract: 'C2', symbol: 'HIGH', priceChangePct: 50 }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.bestTrade?.symbol).toBe('HIGH');
    expect(r.bestTrade?.simulatedPnlPct).toBeCloseTo(50);
  });

  it('identifies worstTrade (lowest pnl)', () => {
    writeJsonl(intentsPath, [
      makeIntent({ intentId: 'low', contract: 'C1', symbol: 'BAD', priceChangePct: -20 }),
      makeIntent({ intentId: 'high', contract: 'C2', symbol: 'GOOD', priceChangePct: 30 }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.worstTrade?.symbol).toBe('BAD');
    expect(r.worstTrade?.simulatedPnlPct).toBeCloseTo(-20);
  });

  it('avgPnlPctTrimmed excludes values > 500%', () => {
    writeJsonl(intentsPath, [
      makeIntent({ intentId: 'a', contract: 'C1', priceChangePct: 10 }),
      makeIntent({ intentId: 'b', contract: 'C2', priceChangePct: 10 }),
      makeIntent({ intentId: 'x', contract: 'C3', priceChangePct: 100000 }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.avgPnlPct).toBeGreaterThan(1000);  // heavily skewed by outlier
    expect(r.avgPnlPctTrimmed).toBeCloseTo(10); // outlier excluded
  });
});

// ── Tests: groupings ─────────────────────────────────────────────────────────

describe('runPaperTradeSimulationReport — groupings', () => {
  it('groups by paperEntryTiming', () => {
    writeJsonl(intentsPath, [
      makeIntent({ intentId: 'a', contract: 'C1', paperEntryTiming: 'ENTER_NOW', priceChangePct: 20 }),
      makeIntent({ intentId: 'b', contract: 'C2', paperEntryTiming: 'ENTER_NOW', priceChangePct: -5 }),
      makeIntent({ intentId: 'c', contract: 'C3', paperEntryTiming: 'WAIT_10M',  priceChangePct: 10 }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const enNow  = r.byPaperEntryTiming.find(g => g.label === 'ENTER_NOW');
    const wait10 = r.byPaperEntryTiming.find(g => g.label === 'WAIT_10M');
    expect(enNow?.n).toBe(2);
    expect(wait10?.n).toBe(1);
  });

  it('groups by M5 band correctly', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-18-100000.jsonl');
    fs.writeFileSync(cycleFile,
      JSON.stringify(makeCycleRow('CONTRACT_A', { entryMomentumPct: 8.5, entryMomentumSource: 'DEX_SCREENER_M5', entryMomentumWindowLabel: 'M5' })) + '\n',
    );
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 15 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const band = r.byM5Band.find(g => g.label === '+5 to +20');
    expect(band?.n).toBe(1);
  });

  it('assigns UNAVAILABLE M5 band when no cycle data', () => {
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 10 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const band = r.byM5Band.find(g => g.label === 'UNAVAILABLE');
    expect(band?.n).toBe(1);
    expect(r.simulatedTrades[0].m5Band).toBe('UNAVAILABLE');
    expect(r.simulatedTrades[0].entryMomentumSource).toBe('UNAVAILABLE');
  });

  it('groups by liquidity bucket from learning-memory', () => {
    writeJsonl(memoryPath, [makeMemRow('CONTRACT_A', { liquidityBucket: 'LIQ_10K_30K' })]);
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 5 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].liquidityBucket).toBe('LIQ_10K_30K');
    const liqGroup = r.byLiquidityBucket.find(g => g.label === 'LIQ_10K_30K');
    expect(liqGroup?.n).toBe(1);
  });

  it('groups by VLR bucket from learning-memory', () => {
    writeJsonl(memoryPath, [makeMemRow('CONTRACT_A', { vlrBucket: 'VLR_GTE_2' })]);
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 5 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].vlrBucket).toBe('VLR_GTE_2');
    const vlrGroup = r.byVlrBucket.find(g => g.label === 'VLR_GTE_2');
    expect(vlrGroup?.n).toBe(1);
  });

  it('uses UNKNOWN for liquidity when no memory match', () => {
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 5 })]);
    // No memoryPath rows
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].liquidityBucket).toBeNull();
    const liqGroup = r.byLiquidityBucket.find(g => g.label === 'UNKNOWN');
    expect(liqGroup?.n).toBe(1);
  });
});

// ── Tests: M5 band boundaries ─────────────────────────────────────────────────

describe('runPaperTradeSimulationReport — M5 band boundaries', () => {
  function makeCycle(m5: number): void {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-18-100000.jsonl');
    fs.writeFileSync(cycleFile,
      JSON.stringify(makeCycleRow('CONTRACT_A', { entryMomentumPct: m5, entryMomentumSource: 'DEX_SCREENER_M5', entryMomentumWindowLabel: 'M5' })) + '\n',
    );
  }

  it('assigns M5 <= -20 band for -25', () => {
    makeCycle(-25);
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 5 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].m5Band).toBe('M5 <= -20');
  });

  it('assigns -5 to +5 band for 0', () => {
    makeCycle(0);
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 5 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].m5Band).toBe('-5 to +5');
  });

  it('assigns +5 to +20 band for 10', () => {
    makeCycle(10);
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 5 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].m5Band).toBe('+5 to +20');
  });

  it('assigns > +50 band for 75', () => {
    makeCycle(75);
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 5 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].m5Band).toBe('> +50');
  });
});

// ── Tests: danger section ─────────────────────────────────────────────────────

describe('runPaperTradeSimulationReport — danger cases', () => {
  it('identifies high-score losers (score >= 80, pnl <= 0)', () => {
    writeJsonl(intentsPath, [
      makeIntent({ intentId: 'a', contract: 'C1', ripperScore: 95, priceChangePct: -10 }),
      makeIntent({ intentId: 'b', contract: 'C2', ripperScore: 50, priceChangePct: -10 }),
      makeIntent({ intentId: 'c', contract: 'C3', ripperScore: 95, priceChangePct: 20 }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.highScoreLosers).toHaveLength(1);
    expect(r.highScoreLosers[0].dangerType).toBe('HIGH_SCORE_LOSER');
  });

  it('identifies CLEAN cluster losers', () => {
    writeJsonl(intentsPath, [
      makeIntent({ intentId: 'a', contract: 'C1', clusterRisk: 'CLEAN', priceChangePct: -5 }),
      makeIntent({ intentId: 'b', contract: 'C2', clusterRisk: 'WATCH', priceChangePct: -5 }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.cleanLosers).toHaveLength(1);
    expect(r.cleanLosers[0].dangerType).toBe('CLEAN_LOSER');
  });

  it('identifies positive M5 losers from cycle data', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-18-100000.jsonl');
    fs.writeFileSync(cycleFile,
      JSON.stringify(makeCycleRow('CONTRACT_A', {
        entryMomentumPct: 12.0,
        entryMomentumSource: 'DEX_SCREENER_M5',
        entryMomentumWindowLabel: 'M5',
      })) + '\n',
    );
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: -8.0 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.posM5Losers).toHaveLength(1);
    expect(r.posM5Losers[0].dangerType).toBe('POSITIVE_M5_LOSER');
  });

  it('identifies negative M5 winners from cycle data', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-18-100000.jsonl');
    fs.writeFileSync(cycleFile,
      JSON.stringify(makeCycleRow('CONTRACT_A', {
        entryMomentumPct: -3.5,
        entryMomentumSource: 'DEX_SCREENER_M5',
        entryMomentumWindowLabel: 'M5',
      })) + '\n',
    );
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 18.0 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.negM5Winners).toHaveLength(1);
    expect(r.negM5Winners[0].dangerType).toBe('NEGATIVE_M5_WINNER');
  });

  it('posM5Losers is empty when no cycle data (all UNAVAILABLE)', () => {
    // No cycle files — all entryMomentumPct = null
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: -5.0 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.posM5Losers).toHaveLength(0);
    expect(r.negM5Winners).toHaveLength(0);
  });
});

// ── Tests: recommendation logic ───────────────────────────────────────────────

describe('runPaperTradeSimulationReport — recommendation', () => {
  it('SIGNAL_TOO_THIN when n < 20', () => {
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 10 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.recommendation).toBe('SIGNAL_TOO_THIN');
  });

  it('KEEP_COLLECTING when 20 <= n < 50', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      makeIntent({ intentId: `id-${i}`, contract: `C${i}`, priceChangePct: 5 })
    );
    writeJsonl(intentsPath, rows);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.recommendation).toBe('KEEP_COLLECTING');
  });

  it('BAD_APPROVAL_QUALITY when win rate < 35% with n >= 50', () => {
    const losers  = Array.from({ length: 40 }, (_, i) =>
      makeIntent({ intentId: `L${i}`, contract: `L${i}`, priceChangePct: -5 })
    );
    const winners = Array.from({ length: 10 }, (_, i) =>
      makeIntent({ intentId: `W${i}`, contract: `W${i}`, priceChangePct: 5 })
    );
    writeJsonl(intentsPath, [...losers, ...winners]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.recommendation).toBe('BAD_APPROVAL_QUALITY');
  });

  it('POSSIBLE_EDGE_RESEARCH_ONLY when win rate >= 50% with n >= 50', () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      makeIntent({ intentId: `id-${i}`, contract: `C${i}`, priceChangePct: i % 2 === 0 ? 10 : -3 })
    );
    // 30 winners / 30 losers = 50%
    writeJsonl(intentsPath, rows);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.recommendation).toBe('POSSIBLE_EDGE_RESEARCH_ONLY');
  });
});

// ── Tests: no data mutation ───────────────────────────────────────────────────

describe('runPaperTradeSimulationReport — no mutation', () => {
  it('does not modify paper-intents.jsonl', () => {
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 10 })]);
    const before = fs.readFileSync(intentsPath, 'utf-8');
    runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const after  = fs.readFileSync(intentsPath, 'utf-8');
    expect(after).toBe(before);
  });

  it('does not create any new files in tmpDir', () => {
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 10 })]);
    const before = new Set(fs.readdirSync(tmpDir));
    runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const after  = new Set(fs.readdirSync(tmpDir));
    // Only the cycles sub-dir and the intents file should exist; nothing new added
    expect([...after].filter(f => !before.has(f))).toHaveLength(0);
  });
});

// ── Tests: entryMomentumPct from cycle file ───────────────────────────────────

describe('runPaperTradeSimulationReport — cycle file join', () => {
  it('reads entryMomentumPct from the correct cycle file', () => {
    const cycleFile = path.join(cyclesDir, 'cycle-2026-06-18-100000.jsonl');
    fs.writeFileSync(cycleFile,
      JSON.stringify(makeCycleRow('CONTRACT_A', {
        entryMomentumPct:         9.9,
        entryMomentumSource:      'DEX_SCREENER_M5',
        entryMomentumWindowLabel: 'M5',
      })) + '\n',
    );
    writeJsonl(intentsPath, [makeIntent({ priceChangePct: 5 })]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].entryMomentumPct).toBeCloseTo(9.9);
    expect(r.simulatedTrades[0].entryMomentumSource).toBe('DEX_SCREENER_M5');
    expect(r.simulatedTrades[0].entryMomentumWindowLabel).toBe('M5');
    expect(r.simulatedTrades[0].m5Band).toBe('+5 to +20');
  });

  it('uses UNAVAILABLE when cycle file does not exist', () => {
    writeJsonl(intentsPath, [
      makeIntent({ sourceCycle: 'cycle-2026-06-01-000000', priceChangePct: 5 })
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.simulatedTrades[0].entryMomentumPct).toBeNull();
    expect(r.simulatedTrades[0].entryMomentumSource).toBe('UNAVAILABLE');
  });

  it('does not cross-contaminate contracts between cycle files', () => {
    const cycleA = path.join(cyclesDir, 'cycle-2026-06-18-100000.jsonl');
    const cycleB = path.join(cyclesDir, 'cycle-2026-06-18-110000.jsonl');
    fs.writeFileSync(cycleA,
      JSON.stringify(makeCycleRow('CONTRACT_A', { entryMomentumPct: 15.0, entryMomentumSource: 'DEX_SCREENER_M5', entryMomentumWindowLabel: 'M5' })) + '\n',
    );
    fs.writeFileSync(cycleB,
      JSON.stringify(makeCycleRow('CONTRACT_B', { entryMomentumPct: -10.0, entryMomentumSource: 'DEX_SCREENER_M5', entryMomentumWindowLabel: 'M5' })) + '\n',
    );
    writeJsonl(intentsPath, [
      makeIntent({ intentId: 'ia', contract: 'CONTRACT_A', sourceCycle: 'cycle-2026-06-18-100000', priceChangePct: 10 }),
      makeIntent({ intentId: 'ib', contract: 'CONTRACT_B', sourceCycle: 'cycle-2026-06-18-110000', priceChangePct: 5 }),
    ]);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const tA = r.simulatedTrades.find(t => t.contract === 'CONTRACT_A');
    const tB = r.simulatedTrades.find(t => t.contract === 'CONTRACT_B');
    expect(tA?.entryMomentumPct).toBeCloseTo(15.0);
    expect(tB?.entryMomentumPct).toBeCloseTo(-10.0);
  });
});

// ── Tests: renderer ───────────────────────────────────────────────────────────

describe('renderPaperTradeSimulationReport — section headers', () => {
  it('contains all 9 section headers', () => {
    writeJsonl(intentsPath, []);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const rendered = renderPaperTradeSimulationReport(r);
    expect(rendered).toContain('SECTION 1 — OVERALL SIMULATED PERFORMANCE');
    expect(rendered).toContain('SECTION 2 — BY PAPER ENTRY TIMING');
    expect(rendered).toContain('SECTION 3 — BY ENTRY DECISION');
    expect(rendered).toContain('SECTION 4 — BY M5 MOMENTUM BAND');
    expect(rendered).toContain('SECTION 5 — BY LIQUIDITY BUCKET');
    expect(rendered).toContain('SECTION 6 — BY VLR BUCKET');
    expect(rendered).toContain('SECTION 7 — FALSE COMFORT / DANGER CASES');
    expect(rendered).toContain('SECTION 8 — RECOMMENDATION');
    expect(rendered).toContain('SECTION 9 — SAFETY');
  });

  it('contains safety footer with all required flags', () => {
    writeJsonl(intentsPath, []);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const rendered = renderPaperTradeSimulationReport(r);
    expect(rendered).toContain('REPORT_ONLY=true');
    expect(rendered).toContain('READ_ONLY=true');
    expect(rendered).toContain('PAPER_ONLY=true');
    expect(rendered).toContain('NO_REAL_TRADING=true');
    expect(rendered).toContain('NO_FAKE_TRADE_MUTATION=true');
    expect(rendered).toContain('NO_GATE_CHANGES=true');
    expect(rendered).toContain('NO_WALLET=true');
    expect(rendered).toContain('NO_SWAP=true');
    expect(rendered).toContain('NO_SIGNING=true');
    expect(rendered).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(rendered).toContain('realTradingLocked=true');
    expect(rendered).toContain('tradingExecuted=0');
  });

  it('mentions DO_NOT_PROMOTE_TO_GATES in recommendation', () => {
    writeJsonl(intentsPath, []);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const rendered = renderPaperTradeSimulationReport(r);
    expect(rendered).toContain('DO_NOT_PROMOTE_TO_GATES');
  });

  it('shows the UNAVAILABLE note in M5 section', () => {
    writeJsonl(intentsPath, []);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const rendered = renderPaperTradeSimulationReport(r);
    expect(rendered).toContain('UNAVAILABLE = cycle row predates');
  });

  it('does not mention token:paper-buy as an action to take', () => {
    writeJsonl(intentsPath, []);
    const r = runPaperTradeSimulationReport({ intentsPath, memoryPath, cyclesDir });
    const rendered = renderPaperTradeSimulationReport(r);
    expect(rendered).toContain('Do not call token:paper-buy');
  });
});
