import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runResearchShadowReport,
  renderResearchShadowReport,
  renderResearchShadowReportUsage,
  median,
  cappedAverage,
  RESEARCH_PNL_CAP_PCT,
} from '../src/token-grab/researchShadowReport';

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-report-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

// ── Synthetic event builders ─────────────────────────────────────────────────────────────────

function buy(o: { lane: string; gate: boolean; launchAge: string; contract: string }) {
  return {
    type: 'RESEARCH_WOULD_BUY', ts: '2026-07-01T12:00:00.000Z', contract: o.contract, symbol: o.contract.slice(0, 4),
    lane: o.lane, m5Band: '-20 to -5', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_0_5_TO_2',
    ripperScoreBand: 'BAND_60_80', ripperScore: 70, productionGateApproved: o.gate, clusterRisk: 'UNKNOWN',
    sourceCycle: 'cycle-2026-07-01-115500', entryValuation: 0.001, valuationField: 'priceUsd',
    entryMomentumPct: -10, entryLiquidityChangePct: 10, entryVlr: 0.6, launchAgeBucket: o.launchAge,
    paperOnly: true, researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true, notBuySignal: true,
  };
}

function sell(o: { lane: string; gate: boolean; launchAge: string; contract: string; usable: boolean; pnlPct: number | null; pnlUsd: number | null }) {
  return {
    type: 'RESEARCH_WOULD_SELL', ts: '2026-07-01T12:35:00.000Z', contract: o.contract, symbol: o.contract.slice(0, 4),
    lane: o.lane, sourceCycle: 'cycle-2026-07-01-115500', exitReason: o.usable ? 'MAX_HOLD_TIME' : 'DATA_STALE_EXIT',
    note: 'test', entryValuation: 0.001, exitValuation: o.usable ? 0.0015 : null, valuationField: 'priceUsd',
    valuationUsable: o.usable, valuationStatus: o.usable ? 'OK' : 'VALUATION_UNAVAILABLE',
    valuationMissing: o.usable ? [] : ['contractNotInLatestCycle'], pnlPct: o.pnlPct, pnlUsd: o.pnlUsd, holdMinutes: 35,
    productionGateApproved: o.gate, launchAgeBucket: o.launchAge,
    paperOnly: true, researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true, notBuySignal: true,
  };
}

function writeScenario(): { eventsPath: string; statePath: string } {
  const dir = tmpDir();
  const eventsPath = path.join(dir, 'research-shadow-events.jsonl');
  const statePath  = path.join(dir, 'research-shadow-state.json');

  const events = [
    buy({ lane: 'NO_BM_INTERNAL_BROAD', gate: true,  launchAge: 'PRIME_WINDOW', contract: 'AAAA111' }),
    buy({ lane: 'NO_BM_INTERNAL_BROAD', gate: false, launchAge: 'TOO_EARLY',    contract: 'BBBB222' }),
    buy({ lane: 'NO_BM_BEST_VLR',       gate: true,  launchAge: 'PRIME_WINDOW', contract: 'CCCC333' }),
    buy({ lane: 'NO_BM_PULLBACK',       gate: false, launchAge: 'PRIME_WINDOW', contract: 'DDDD444' }),
    buy({ lane: 'NO_BM_INTERNAL_BROAD', gate: true,  launchAge: 'TOO_EARLY',    contract: 'EEEE555' }),
    // Sells: 4 valued (2 win, 1 loss, 1 flat) + 1 unvalued.
    sell({ lane: 'NO_BM_INTERNAL_BROAD', gate: true,  launchAge: 'PRIME_WINDOW', contract: 'AAAA111', usable: true,  pnlPct: 50,   pnlUsd: 0.5 }),
    sell({ lane: 'NO_BM_INTERNAL_BROAD', gate: false, launchAge: 'TOO_EARLY',    contract: 'BBBB222', usable: true,  pnlPct: -20,  pnlUsd: -0.2 }),
    sell({ lane: 'NO_BM_BEST_VLR',       gate: true,  launchAge: 'PRIME_WINDOW', contract: 'CCCC333', usable: true,  pnlPct: 200,  pnlUsd: 2.0 }),
    sell({ lane: 'NO_BM_PULLBACK',       gate: false, launchAge: 'PRIME_WINDOW', contract: 'DDDD444', usable: false, pnlPct: null, pnlUsd: null }),
    sell({ lane: 'NO_BM_INTERNAL_BROAD', gate: true,  launchAge: 'PRIME_WINDOW', contract: 'EEEE555', usable: true,  pnlPct: 0,    pnlUsd: 0 }),
  ];
  fs.writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  fs.writeFileSync(statePath, JSON.stringify({ openPositions: [{ contract: 'OPEN1' }, { contract: 'OPEN2' }], closedPositions: [], recordedBuyKeys: [] }), 'utf-8');
  return { eventsPath, statePath };
}

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────

describe('median / cappedAverage', () => {
  it('median handles odd and even lengths', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([-20, 0, 50, 200])).toBe(25);
    expect(median([])).toBeNull();
  });
  it('cappedAverage clamps each value before averaging', () => {
    expect(cappedAverage([50, -20, 200, 0], 100)).toBeCloseTo((50 - 20 + 100 + 0) / 4, 5);
    expect(cappedAverage([], 100)).toBeNull();
  });
});

// ── Headline stats ────────────────────────────────────────────────────────────────────────────

describe('runResearchShadowReport headline stats', () => {
  it('computes buys/sells/open/valued/unvalued and win-loss-flat', () => {
    const { eventsPath, statePath } = writeScenario();
    const r = runResearchShadowReport({ eventsPath, statePath, generatedAt: '2026-07-01T13:00:00.000Z' });

    expect(r.totalResearchBuys).toBe(5);
    expect(r.totalResearchSells).toBe(5);
    expect(r.openResearchPositions).toBe(2);
    expect(r.closedValued).toBe(4);
    expect(r.closedUnvalued).toBe(1);
    expect(r.wins).toBe(2);
    expect(r.losses).toBe(1);
    expect(r.flats).toBe(1);
    expect(r.winRate).toBeCloseTo(0.5, 5);
    expect(r.redLossRate).toBeCloseTo(0.25, 5);
  });

  it('median and capped average use valued trades, capping outliers', () => {
    const { eventsPath, statePath } = writeScenario();
    const r = runResearchShadowReport({ eventsPath, statePath });
    expect(r.pnlCapPct).toBe(RESEARCH_PNL_CAP_PCT);
    expect(r.medianPnlPct).toBe(25);                                    // median of [-20,0,50,200]
    expect(r.cappedAveragePnlPct).toBeCloseTo((50 - 20 + 100 + 0) / 4, 5); // +200 clamped to +100
  });

  it('best/worst come only from valued trades', () => {
    const { eventsPath, statePath } = writeScenario();
    const r = runResearchShadowReport({ eventsPath, statePath });
    expect(r.bestTrade?.contract).toBe('CCCC333');
    expect(r.bestTrade?.pnlUsd).toBeCloseTo(2.0, 5);
    expect(r.worstTrade?.contract).toBe('BBBB222');
    expect(r.worstTrade?.pnlUsd).toBeCloseTo(-0.2, 5);
  });
});

// ── Lane-level stats ──────────────────────────────────────────────────────────────────────────

describe('runResearchShadowReport lane-level stats', () => {
  it('includes all three internal lanes with per-lane counts', () => {
    const { eventsPath, statePath } = writeScenario();
    const r = runResearchShadowReport({ eventsPath, statePath });
    const byLane = Object.fromEntries(r.laneStats.map(s => [s.lane, s]));

    expect(Object.keys(byLane).sort()).toEqual(['NO_BM_BEST_VLR', 'NO_BM_INTERNAL_BROAD', 'NO_BM_PULLBACK']);

    const broad = byLane['NO_BM_INTERNAL_BROAD'];
    expect(broad.buys).toBe(3);
    expect(broad.sells).toBe(3);
    expect(broad.valuedClosed).toBe(3);
    expect(broad.wins).toBe(1);
    expect(broad.losses).toBe(1);
    expect(broad.flats).toBe(1);

    const bestVlr = byLane['NO_BM_BEST_VLR'];
    expect(bestVlr.buys).toBe(1);
    expect(bestVlr.wins).toBe(1);

    const pullback = byLane['NO_BM_PULLBACK'];
    expect(pullback.buys).toBe(1);
    expect(pullback.valuedClosed).toBe(0);
    expect(pullback.unvaluedClosed).toBe(1);
  });
});

// ── Production gate split ────────────────────────────────────────────────────────────────────

describe('runResearchShadowReport productionGateApproved split', () => {
  it('splits buys and valued outcomes by productionGateApproved true vs false', () => {
    const { eventsPath, statePath } = writeScenario();
    const r = runResearchShadowReport({ eventsPath, statePath });

    expect(r.gateApproved.buys).toBe(3);
    expect(r.gateApproved.valuedClosed).toBe(3);
    expect(r.gateApproved.wins).toBe(2);
    expect(r.gateApproved.losses).toBe(0);

    expect(r.gateNotApproved.buys).toBe(2);
    expect(r.gateNotApproved.valuedClosed).toBe(1);
    expect(r.gateNotApproved.losses).toBe(1);
  });
});

// ── Launch-age split ─────────────────────────────────────────────────────────────────────────

describe('runResearchShadowReport too-early vs prime-window', () => {
  it('splits buys by launchAgeBucket when available', () => {
    const { eventsPath, statePath } = writeScenario();
    const r = runResearchShadowReport({ eventsPath, statePath });
    expect(r.launchAgeAvailable).toBe(true);
    expect(r.launchAge.TOO_EARLY.buys).toBe(2);
    expect(r.launchAge.PRIME_WINDOW.buys).toBe(3);
    expect(r.launchAge.OTHER.buys).toBe(0);
  });
});

// ── Renderer + safety ────────────────────────────────────────────────────────────────────────

describe('renderResearchShadowReport safety + content', () => {
  it('states RESEARCH_ONLY_NOT_EXECUTABLE, NOT_A_BUY_SIGNAL, READY_FOR_REAL_TRADING=false', () => {
    const { eventsPath, statePath } = writeScenario();
    const text = renderResearchShadowReport(runResearchShadowReport({ eventsPath, statePath }));
    expect(text).toContain('RESEARCH_ONLY_NOT_EXECUTABLE');
    expect(text).toContain('NOT_A_BUY_SIGNAL');
    expect(text).toContain('READY_FOR_REAL_TRADING=false');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
    expect(text).toContain('NO_WALLET=true');
  });

  it('renders lane-level and production-gate sections', () => {
    const { eventsPath, statePath } = writeScenario();
    const text = renderResearchShadowReport(runResearchShadowReport({ eventsPath, statePath }));
    expect(text).toContain('LANE-LEVEL STATS');
    expect(text).toContain('NO_BM_INTERNAL_BROAD');
    expect(text).toContain('NO_BM_BEST_VLR');
    expect(text).toContain('NO_BM_PULLBACK');
    expect(text).toContain('productionGateApproved=true');
    expect(text).toContain('productionGateApproved=false');
    expect(text).toContain('too-early vs prime-window');
  });

  it('report result carries READY_FOR_REAL_TRADING=false and research-only flags', () => {
    const { eventsPath, statePath } = writeScenario();
    const r = runResearchShadowReport({ eventsPath, statePath });
    expect(r.readyForRealTrading).toBe(false);
    expect(r.researchOnly).toBe(true);
    expect(r.notABuySignal).toBe(true);
    expect(r.realTrading).toBe(false);
    expect(r.noWallet).toBe(true);
  });

  it('empty stream yields zeroed stats, not crashes', () => {
    const dir = tmpDir();
    const r = runResearchShadowReport({ eventsPath: path.join(dir, 'none.jsonl'), statePath: path.join(dir, 'none.json') });
    expect(r.totalResearchBuys).toBe(0);
    expect(r.medianPnlPct).toBeNull();
    expect(r.bestTrade).toBeNull();
    expect(r.readyForRealTrading).toBe(false);
  });

  it('usage text documents the research-only nature', () => {
    const usage = renderResearchShadowReportUsage();
    expect(usage).toContain('research-shadow-report');
    expect(usage).toContain('READY_FOR_REAL_TRADING=false');
  });
});
