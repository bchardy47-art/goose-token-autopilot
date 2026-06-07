import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDexWatchReport,
  type DexWatchOutcome,
  type DexWatchReport,
} from '../src/token-grab/dexWatch';
import {
  parseWatchReport,
  loadWatchReports,
  outcomesFromReport,
  buildDexWatchSummary,
  renderDexWatchSummary,
  DRAIN_PCT,
  REPEAT_MIN,
} from '../src/token-grab/dexWatchSummary';

// ── Fixtures ────────────────────────────────────────────────────────────────────────

function outcome(over: Partial<DexWatchOutcome> & Pick<DexWatchOutcome, 'contract' | 'classification'>): DexWatchOutcome {
  return {
    signalId: `sig-${over.contract}`,
    chainId: 'solana',
    ...over,
  };
}

function report(outcomes: DexWatchOutcome[], generatedAt: string): DexWatchReport {
  return buildDexWatchReport({
    generatedAt,
    signalsRead: outcomes.length,
    outcomes,
    chain: 'solana',
    minutes: 10,
    intervalSeconds: 60,
    dryRun: false,
  });
}

const MURICA = 'MuRiCa1111111111111111111111111111111111111';
const GOOSE = 'GooSe22222222222222222222222222222222222222';
const FROG = 'FroG333333333333333333333333333333333333333';

// MURICA loses in two runs (repeat loser, liquidity drains both times).
const RUN_1 = report(
  [
    outcome({ contract: MURICA, symbol: 'MURICA', classification: 'loser', priceChangePct: -45, liquidityChangePct: -30, volumeToLiquidityRatio: 4.0 }),
    outcome({ contract: GOOSE, symbol: 'GOOSE', classification: 'winner', priceChangePct: 60, liquidityChangePct: 25, volumeToLiquidityRatio: 1.5 }),
    outcome({ contract: FROG, symbol: 'FROG', classification: 'flat', priceChangePct: 2, liquidityChangePct: 1, volumeToLiquidityRatio: 0.3 }),
  ],
  '2026-06-07T10:00:00.000Z',
);
const RUN_2 = report(
  [
    outcome({ contract: MURICA, symbol: 'MURICA', classification: 'loser', priceChangePct: -55, liquidityChangePct: -40, volumeToLiquidityRatio: 6.0 }),
    outcome({ contract: GOOSE, symbol: 'GOOSE', classification: 'winner', priceChangePct: 40, liquidityChangePct: 15, volumeToLiquidityRatio: 2.5 }),
    outcome({ contract: FROG, symbol: 'FROG', classification: 'missing' }),
  ],
  '2026-06-07T10:20:00.000Z',
);

function writeReports(reports: DexWatchReport[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexsummary-'));
  reports.forEach((r, i) => {
    fs.writeFileSync(path.join(dir, `run-${i}.json`), JSON.stringify(r, null, 2), 'utf-8');
  });
  return dir;
}

// ── Saving / loading ──────────────────────────────────────────────────────────────────

describe('parseWatchReport', () => {
  it('accepts a valid watch report', () => {
    expect(parseWatchReport(RUN_1)).not.toBeNull();
  });
  it('rejects non-reports', () => {
    expect(parseWatchReport(null)).toBeNull();
    expect(parseWatchReport({ winners: [] })).toBeNull(); // missing other arrays
    expect(parseWatchReport(42)).toBeNull();
  });
});

describe('saves and loads watch report JSON', () => {
  it('round-trips a saved report from disk', () => {
    const dir = writeReports([RUN_1]);
    const loaded = loadWatchReports(dir, 20);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].winners.length + loaded[0].losers.length + loaded[0].flat.length + loaded[0].missing.length).toBe(3);
  });

  it('returns [] for a missing directory', () => {
    expect(loadWatchReports(path.join(os.tmpdir(), 'does-not-exist-xyz'), 20)).toEqual([]);
  });

  it('ignores non-json and unparseable files', () => {
    const dir = writeReports([RUN_1]);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello', 'utf-8');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not valid', 'utf-8');
    expect(loadWatchReports(dir, 20)).toHaveLength(1);
  });

  it('orders newest first by generatedAt and respects limit', () => {
    const dir = writeReports([RUN_1, RUN_2]); // RUN_2 is newer
    const loaded = loadWatchReports(dir, 1);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].generatedAt).toBe('2026-06-07T10:20:00.000Z');
  });
});

// ── Flattening ────────────────────────────────────────────────────────────────────────

describe('outcomesFromReport', () => {
  it('reassembles all outcomes with their bucket classification', () => {
    const all = outcomesFromReport(RUN_1);
    expect(all).toHaveLength(3);
    expect(all.find(o => o.contract === MURICA)!.classification).toBe('loser');
    expect(all.find(o => o.contract === GOOSE)!.classification).toBe('winner');
  });
});

// ── Aggregation ─────────────────────────────────────────────────────────────────────────

describe('buildDexWatchSummary', () => {
  it('reads multiple reports and counts totals', () => {
    const s = buildDexWatchSummary([RUN_1, RUN_2]);
    expect(s.totalRuns).toBe(2);
    expect(s.contractsWatched).toBe(3); // MURICA, GOOSE, FROG
    expect(s.winnersCount).toBe(2); // GOOSE x2
    expect(s.losersCount).toBe(2); // MURICA x2
    expect(s.flatCount).toBe(1);
    expect(s.missingCount).toBe(1);
  });

  it('identifies a repeat loser (MURICA style) and lists it as repeatedly losing', () => {
    const s = buildDexWatchSummary([RUN_1, RUN_2]);
    const murica = s.repeatLosers.find(a => a.contract === MURICA);
    expect(murica).toBeDefined();
    expect(murica!.loseCount).toBeGreaterThanOrEqual(REPEAT_MIN);
    expect(s.repeatedlyLosing.some(a => a.contract === MURICA)).toBe(true);
    expect(s.repeatLosersCount).toBe(1);
  });

  it('puts a repeat loser / liquidity-drainer on the avoid-list', () => {
    const s = buildDexWatchSummary([RUN_1, RUN_2]);
    const murica = s.avoidList.find(a => a.contract === MURICA);
    expect(murica).toBeDefined();
    expect(murica!.drainCount).toBe(2); // both runs drained <= DRAIN_PCT
    expect(DRAIN_PCT).toBeLessThan(0);
  });

  it('identifies a winner with price + liquidity up and lists it on the watch-list', () => {
    const s = buildDexWatchSummary([RUN_1, RUN_2]);
    const goose = s.watchList.find(a => a.contract === GOOSE);
    expect(goose).toBeDefined();
    expect(goose!.winCount).toBeGreaterThanOrEqual(REPEAT_MIN);
    expect(goose!.priceUpLiqUpCount).toBe(2); // both runs price & liquidity up
    expect(s.repeatWinners.some(a => a.contract === GOOSE)).toBe(true);
  });

  it('avoids listing winners on the avoid-list and losers on the watch-list', () => {
    const s = buildDexWatchSummary([RUN_1, RUN_2]);
    expect(s.avoidList.some(a => a.contract === GOOSE)).toBe(false);
    expect(s.watchList.some(a => a.contract === MURICA)).toBe(false);
  });

  it('computes average winner / loser price and liquidity metrics', () => {
    const s = buildDexWatchSummary([RUN_1, RUN_2]);
    expect(s.avgWinnerPricePct).toBeCloseTo((60 + 40) / 2); // 50
    expect(s.avgWinnerLiquidityPct).toBeCloseTo((25 + 15) / 2); // 20
    expect(s.avgLoserPricePct).toBeCloseTo((-45 + -55) / 2); // -50
    expect(s.avgLoserLiquidityPct).toBeCloseTo((-30 + -40) / 2); // -35
  });

  it('ranks top v/l churn contracts by average ratio', () => {
    const s = buildDexWatchSummary([RUN_1, RUN_2]);
    expect(s.topVlChurn[0].contract).toBe(MURICA); // avg (4+6)/2 = 5 highest
  });

  it('always reports no real trading', () => {
    const s = buildDexWatchSummary([RUN_1, RUN_2]);
    expect(s.tradingExecuted).toBe(0);
    expect(s.noRealTradeSent).toBe(true);
    expect(s.dryRun).toBe(false);
  });

  it('handles an empty report set', () => {
    const s = buildDexWatchSummary([]);
    expect(s.totalRuns).toBe(0);
    expect(s.contractsWatched).toBe(0);
    expect(s.avgWinnerPricePct).toBeUndefined();
    expect(s.avoidList).toEqual([]);
    expect(s.watchList).toEqual([]);
  });
});

// ── Rendering / safety ──────────────────────────────────────────────────────────────────

describe('renderDexWatchSummary', () => {
  it('shows avoid-list, watch-list and read-only banner', () => {
    const out = renderDexWatchSummary(buildDexWatchSummary([RUN_1, RUN_2], 'data/token-grab/dex-watch-runs'));
    expect(out).toContain('AVOID-LIST');
    expect(out).toContain('WATCH-LIST');
    expect(out).toContain('Repeat winners');
    expect(out).toContain('Repeat losers');
    expect(out).toContain('READ-ONLY');
    expect(out).toContain('tradingExecuted: 0');
    expect(out).toContain('NO PLAN_ONLY gate granted');
  });

  it('contains no trading / swap / signing terms beyond explicit negations', () => {
    const out = renderDexWatchSummary(buildDexWatchSummary([RUN_1, RUN_2]));
    expect(out).not.toMatch(/LIVE_EXECUTED/);
    expect(out).not.toMatch(/private key/i);
    expect(out).not.toMatch(/sign(ing)? transaction/i);
    for (const word of ['swap', 'wallet', 'signing']) {
      const lines = out.split('\n').filter(l => l.toLowerCase().includes(word));
      for (const l of lines) expect(l.toLowerCase()).toMatch(/no /);
    }
  });
});

describe('dexWatchSummary source safety', () => {
  it('module exposes no trading / swap / signing primitives', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/token-grab/dexWatchSummary.ts'), 'utf-8');
    expect(src).not.toMatch(/sendTransaction|signTransaction|privateKey|Keypair|jupiter\.swap|executeSwap|LIVE_EXECUTED|puppeteer|playwright|selenium/);
  });
});
