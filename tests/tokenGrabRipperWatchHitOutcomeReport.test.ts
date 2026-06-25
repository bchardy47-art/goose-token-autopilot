// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import {
  runWatchHitOutcomeReport,
  renderWatchHitOutcomeReport,
} from '../src/token-grab/ripperWatchHitOutcomeReport';
import type { SimulatedTrade } from '../src/token-grab/ripperPaperTradeSimulationReport';

// ── SimulatedTrade factory ──────────────────────────────────────────────────────

let idc = 0;
beforeEach(() => { idc = 0; });

/** Default = a WATCH HIT (ENTER_NOW | -20 to -5 | LIQ_10K_30K). Override to vary. */
function mkTrade(over: Partial<SimulatedTrade> = {}): SimulatedTrade {
  idc++;
  return {
    intentId:                 `i${idc}`,
    symbol:                   `S${idc}`,
    contract:                 `C${idc}`,
    paperEntryTiming:         'ENTER_NOW',
    reason:                   '',
    sourceCycle:              'cycle-2026-06-25-000000',
    clusterRisk:              'UNKNOWN',
    ripperScore:              100,
    launchAgeBucket:          'PRIME_WINDOW',
    entryDecision:            'READY_TO_SNIPE_PAPER',
    targetEntryAt:            '',
    observedAt:               '',
    priceChangePct:           0,
    simulatedPnlPct:          0,
    entryMomentumPct:         -10,
    entryMomentumSource:      'DEX_SCREENER_M5',
    entryMomentumWindowLabel: 'M5',
    liquidityBucket:          'LIQ_10K_30K',
    vlrBucket:                'VLR_0_5_TO_2',
    timingPath:               'ENTER_NOW',
    m5Band:                   '-20 to -5',
    ...over,
  };
}

function watch(pnls: number[], over: Partial<SimulatedTrade> = {}): SimulatedTrade[] {
  return pnls.map(p => mkTrade({ simulatedPnlPct: p, ...over }));
}

/** Non-watch: same approval, but M5 band outside the target subgroup. */
function nonWatch(pnls: number[], over: Partial<SimulatedTrade> = {}): SimulatedTrade[] {
  return pnls.map(p => mkTrade({ simulatedPnlPct: p, m5Band: '-5 to +5', entryMomentumPct: 0, ...over }));
}

// ── Separation ──────────────────────────────────────────────────────────────────

describe('group separation', () => {
  it('separates watch hits from non-watch approvals; overall = sum', () => {
    const trades = [...watch([5, 5, 5]), ...nonWatch([1, 1])];
    const r = runWatchHitOutcomeReport({ _trades: trades });
    expect(r.watchHits.n).toBe(3);
    expect(r.nonWatchApproved.n).toBe(2);
    expect(r.overallApproved.n).toBe(5);
    expect(r.watchHits.n + r.nonWatchApproved.n).toBe(r.overallApproved.n);
  });

  it('does not match when M5 band is wrong', () => {
    const r = runWatchHitOutcomeReport({ _trades: nonWatch([5, 5, 5]) });
    expect(r.watchHits.n).toBe(0);
    expect(r.nonWatchApproved.n).toBe(3);
  });

  it('does not match when liquidity bucket is wrong', () => {
    const r = runWatchHitOutcomeReport({ _trades: watch([5, 5], { liquidityBucket: 'LIQ_30K_100K' }) });
    expect(r.watchHits.n).toBe(0);
    expect(r.nonWatchApproved.n).toBe(2);
  });
});

// ── Watch classifier uses entry-time fields only ──────────────────────────────────

describe('watch classification ignores outcome fields', () => {
  it('classifies a losing watch-fields row as a watch hit (outcome irrelevant)', () => {
    // A row with the watch entry-time fields but a TERRIBLE outcome is still a watch hit.
    const r = runWatchHitOutcomeReport({ _trades: [mkTrade({ simulatedPnlPct: -50 })] });
    expect(r.watchHits.n).toBe(1);
    expect(r.watchHits.worstPnl).toBe(-50);
  });

  it('does NOT classify a winning non-watch row as a watch hit (outcome irrelevant)', () => {
    // Great outcome but wrong M5 band → not a watch hit. Outcome never promotes membership.
    const r = runWatchHitOutcomeReport({ _trades: [mkTrade({ simulatedPnlPct: 999, m5Band: '+20 to +50', entryMomentumPct: 30 })] });
    expect(r.watchHits.n).toBe(0);
    expect(r.nonWatchApproved.n).toBe(1);
  });

  it('identical entry-time fields yield identical membership regardless of P/L', () => {
    const trades = [mkTrade({ simulatedPnlPct: 800 }), mkTrade({ simulatedPnlPct: -90 })];
    const r = runWatchHitOutcomeReport({ _trades: trades });
    expect(r.watchHits.n).toBe(2); // both are watch hits — only entry-time fields decided it
  });
});

// ── Recommendation rules ──────────────────────────────────────────────────────────

describe('recommendation', () => {
  it('returns WATCH_SAMPLE_TOO_SMALL when watch n < 50', () => {
    const r = runWatchHitOutcomeReport({ _trades: [...watch(new Array(30).fill(8)), ...nonWatch(new Array(40).fill(1))] });
    expect(r.watchHits.n).toBe(30);
    expect(r.recommendation).toBe('WATCH_SAMPLE_TOO_SMALL');
  });

  it('returns WATCH_HITS_OUTPERFORMING_PAPER_ONLY for a strong, stable watch group', () => {
    const watchTrades = watch([...new Array(50).fill(8), ...new Array(10).fill(-3)]);   // n=60, win 83%, med +8
    const nonWatchTrades = nonWatch([...new Array(40).fill(3), ...new Array(60).fill(-2)]); // win 40%, med -2, cap avg 0
    const r = runWatchHitOutcomeReport({ _trades: [...watchTrades, ...nonWatchTrades] });
    expect(r.watchHits.n).toBe(60);
    expect(r.comparison.winRateLiftPp).toBeGreaterThanOrEqual(10);
    expect(r.watchHits.outlierDependence).toBeLessThanOrEqual(0.25);
    expect(r.recommendation).toBe('WATCH_HITS_OUTPERFORMING_PAPER_ONLY');
  });

  it('returns WATCH_HITS_NOT_OUTPERFORMING when watch underperforms non-watch', () => {
    const watchTrades = watch([...new Array(20).fill(2), ...new Array(40).fill(-3)]);    // win 33%, med -3
    const nonWatchTrades = nonWatch([...new Array(40).fill(5), ...new Array(20).fill(-2)]); // win 66%, med +5
    const r = runWatchHitOutcomeReport({ _trades: [...watchTrades, ...nonWatchTrades] });
    expect(r.watchHits.n).toBe(60);
    expect(r.recommendation).toBe('WATCH_HITS_NOT_OUTPERFORMING');
  });

  it('does NOT promote an outlier-dependent watch group', () => {
    // One giant winner carries the gains → outlierDep >> 0.25, so not OUTPERFORMING.
    const watchTrades = watch([1000, ...new Array(35).fill(0.5), ...new Array(24).fill(-1)]); // n=60, win 60%, med +0.5
    const nonWatchTrades = nonWatch([...new Array(30).fill(1), ...new Array(30).fill(-1)]);    // win 50%, med 0
    const r = runWatchHitOutcomeReport({ _trades: [...watchTrades, ...nonWatchTrades] });
    expect(r.watchHits.n).toBe(60);
    expect(r.watchHits.outlierDependence).toBeGreaterThan(0.25);
    expect(r.recommendation).not.toBe('WATCH_HITS_OUTPERFORMING_PAPER_ONLY');
    expect(r.recommendation).toBe('KEEP_COLLECTING_WATCH_DATA');
  });
});

// ── UNKNOWN cluster handling ──────────────────────────────────────────────────────

describe('UNKNOWN cluster risk', () => {
  it('keeps UNKNOWN as UNKNOWN and never as CLEAN in the breakdown', () => {
    const r = runWatchHitOutcomeReport({ _trades: watch(new Array(3).fill(5), { clusterRisk: 'UNKNOWN' }) });
    expect(r.watchHits.clusterBreakdown['UNKNOWN']).toBe(3);
    expect(r.watchHits.clusterBreakdown['CLEAN']).toBeUndefined();
    expect(r.unknownNeverClean).toBe(true);
  });

  it('null clusterRisk maps to UNKNOWN, not CLEAN', () => {
    const r = runWatchHitOutcomeReport({ _trades: watch([5, 5], { clusterRisk: null }) });
    expect(r.watchHits.clusterBreakdown['UNKNOWN']).toBe(2);
    expect(r.watchHits.clusterBreakdown['CLEAN']).toBeUndefined();
  });
});

// ── Safety strings in render ──────────────────────────────────────────────────────

describe('safety output', () => {
  function renderedReport(): string {
    return renderWatchHitOutcomeReport(runWatchHitOutcomeReport({ _trades: watch([5, 5]) }));
  }

  it('includes PAPER_ONLY_WATCH_NOT_BUY', () => {
    expect(renderedReport()).toContain('PAPER_ONLY_WATCH_NOT_BUY');
  });
  it('includes DO_NOT_PROMOTE_TO_REAL_TRADING', () => {
    expect(renderedReport()).toContain('DO_NOT_PROMOTE_TO_REAL_TRADING');
  });
  it('includes DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE', () => {
    expect(renderedReport()).toContain('DO_NOT_CHANGE_GATES_FROM_THIS_REPORT_ALONE');
  });
  it('includes DO_NOT_ENABLE_REAL_TRADING', () => {
    expect(renderedReport()).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });
  it('uses only DO_NOT_ forms of real-trading language', () => {
    const txt = renderedReport();
    expect(txt).not.toMatch(/(?<!DO_NOT_)ENABLE_REAL_TRADING/);
    expect(txt).not.toMatch(/(?<!DO_NOT_)PROMOTE_TO_REAL_TRADING/);
  });
  it('sets all safety flags', () => {
    const r = runWatchHitOutcomeReport({ _trades: watch([5, 5]) });
    expect(r.reportOnly).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.paperOnly).toBe(true);
    expect(r.realTradingLocked).toBe(true);
    expect(r.tradingExecuted).toBe(0);
    expect(r.noGateChanges).toBe(true);
    expect(r.noBuySignal).toBe(true);
    expect(r.noFakeTradeMutation).toBe(true);
    expect(r.noPaperIntentMutation).toBe(true);
    expect(r.unknownNeverClean).toBe(true);
  });
});

// ── No mutation of input files (real pipeline path) ───────────────────────────────

describe('read-only / no mutation', () => {
  let tmpDir: string, intentsPath: string, memoryPath: string, cyclesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'who-'));
    intentsPath = path.join(tmpDir, 'paper-intents.jsonl');
    memoryPath  = path.join(tmpDir, 'learning-memory.jsonl');
    cyclesDir   = path.join(tmpDir, 'cycles');
    fs.mkdirSync(cyclesDir);
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeJsonl(p: string, rows: unknown[]): void {
    fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  }

  it('does not mutate intents or memory files', () => {
    const intents = Array.from({ length: 5 }, (_, i) => ({
      intentId: `id${i}`, contract: `K${i}`, symbol: 'TKN', status: 'OBSERVED',
      paperEntryTiming: 'ENTER_NOW', entryDecision: 'READY_TO_SNIPE_PAPER',
      sourceCycle: 'cycle-2026-06-25-000000', clusterRisk: 'UNKNOWN', ripperScore: 100,
      entryMomentumPct: -10, observedAt: '2026-06-25T00:01:00.000Z', priceChangePct: 6,
      realTradingLocked: true, paperOnly: true, tradingExecuted: 0,
    }));
    const mem = intents.map(i => ({ contract: i.contract, liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2' }));
    writeJsonl(intentsPath, intents);
    writeJsonl(memoryPath, mem);

    const beforeIntents = fs.readFileSync(intentsPath, 'utf-8');
    const beforeMem     = fs.readFileSync(memoryPath, 'utf-8');

    const r = runWatchHitOutcomeReport({ intentsPath, memoryPath, cyclesDir });
    expect(r.overallApproved.n).toBe(5);
    expect(r.watchHits.n).toBe(5); // all match the watch subgroup

    expect(fs.readFileSync(intentsPath, 'utf-8')).toBe(beforeIntents);
    expect(fs.readFileSync(memoryPath, 'utf-8')).toBe(beforeMem);
  });

  it('produces JSON-serialisable output', () => {
    writeJsonl(intentsPath, []);
    const r = runWatchHitOutcomeReport({ intentsPath, memoryPath, cyclesDir });
    const parsed = JSON.parse(JSON.stringify(r));
    expect(parsed.reportOnly).toBe(true);
    expect(parsed.recommendation).toBe('WATCH_SAMPLE_TOO_SMALL'); // empty → n=0 < 50
  });
});
