import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildFailureAutopsyReport,
  buildAutopsyTrades,
  orderedValuedPocket,
  windowStat,
  classifyTrend,
  buildPocketAutopsy,
  detectCollapseReasons,
  renderFailureAutopsyReport,
  renderFailureAutopsyReportUsage,
  isBroadPocket,
  isExactPocket,
  EXACT_POCKET_KEY,
  BROAD_POCKET_LANE,
  SAFE_RED_LOSS_RATE,
  type AutopsyTrade,
  type WindowStat,
  type ProfileLike,
} from '../src/token-grab/failureAutopsyReport';

const GEN = '2026-07-07T00:00:00.000Z';

// ── Event builders (mirror the research-shadow event shape) ─────────────────────────────────────

interface Prof { lane?: string; gate?: boolean; age?: string; m5?: string; liq?: string; vlr?: string; scoreBand?: string; score?: number; }
function profParts(o: Prof) {
  return {
    lane: o.lane ?? BROAD_POCKET_LANE,
    productionGateApproved: o.gate ?? true,
    launchAgeBucket: o.age ?? 'PRIME_WINDOW',
    m5Band: o.m5 ?? '-5 to +5',
    liquidityBucket: o.liq ?? 'LIQ_10K_30K',
    vlrBucket: o.vlr ?? 'VLR_LT_0_5',
    ripperScoreBand: o.scoreBand ?? 'SCORE_100',
    ripperScore: o.score ?? 100,
  };
}
let seq = 0;
function pair(o: Prof & { pnl: number | null; usable?: boolean; ts?: string }) {
  const p = profParts(o);
  const contract = `C${seq++}${'z'.repeat(42)}`.slice(0, 43);
  const cyc = `cyc-${contract}`;
  const usable = o.usable ?? true;
  const ts = o.ts ?? GEN;
  const buy: any = {
    type: 'RESEARCH_WOULD_BUY', ts, contract, symbol: contract.slice(0, 4), sourceCycle: cyc,
    lane: p.lane, m5Band: p.m5Band, liquidityBucket: p.liquidityBucket, vlrBucket: p.vlrBucket,
    ripperScoreBand: p.ripperScoreBand, ripperScore: p.ripperScore, productionGateApproved: p.productionGateApproved,
    launchAgeBucket: p.launchAgeBucket, brainAction: 'WATCH',
  };
  const sell: any = {
    type: 'RESEARCH_WOULD_SELL', ts, contract, symbol: contract.slice(0, 4), sourceCycle: cyc, lane: p.lane,
    valuationUsable: usable, valuationStatus: usable ? 'OK' : 'VALUATION_UNAVAILABLE',
    pnlPct: usable ? o.pnl : null, pnlUsd: usable && o.pnl != null ? o.pnl / 100 : null,
    productionGateApproved: p.productionGateApproved, launchAgeBucket: p.launchAgeBucket,
  };
  return [buy, sell];
}
function build(events: any[]) {
  return buildFailureAutopsyReport(events, { eventsPath: 'e.jsonl', memoryPath: 'm.json', generatedAt: GEN });
}
function win(r: ReturnType<typeof build>, pocket: 'broadPocket' | 'exactPocket', label: string): WindowStat {
  const w = r[pocket].windows.find(x => x.label === label);
  if (!w) throw new Error(`window not found: ${label}`);
  return w;
}

// A minimal AutopsyTrade for pure-helper tests.
function tr(o: Partial<AutopsyTrade> & { pnl: number; ts: string; valued?: boolean }): AutopsyTrade {
  const p = profParts({});
  return {
    contract: `K${seq++}`, symbol: 'K', ...p,
    ripperScore: p.ripperScore, brainAction: 'WATCH',
    valued: o.valued ?? true, pnlPct: o.pnl, pnlUsd: o.pnl / 100, ts: o.ts,
  } as AutopsyTrade;
}

// ── Pocket filtering ────────────────────────────────────────────────────────────────────────────

describe('exact pocket filtering', () => {
  it('EXACT_POCKET_KEY is the specified 7-key string', () => {
    expect(EXACT_POCKET_KEY).toBe(
      'NO_BM_INTERNAL_BROAD|gate=true|age=PRIME_WINDOW|m5=-5 to +5|liq=LIQ_10K_30K|vlr=VLR_LT_0_5|score=SCORE_100');
  });

  it('isBroadPocket needs gate=true AND the broad lane', () => {
    expect(isBroadPocket(profParts({ gate: true, lane: BROAD_POCKET_LANE }) as ProfileLike)).toBe(true);
    expect(isBroadPocket(profParts({ gate: false, lane: BROAD_POCKET_LANE }) as ProfileLike)).toBe(false);
    expect(isBroadPocket(profParts({ gate: true, lane: 'NO_BM_PULLBACK' }) as ProfileLike)).toBe(false);
  });

  it('isExactPocket only matches all 7 keys; any deviation excludes it', () => {
    expect(isExactPocket(profParts({}) as ProfileLike)).toBe(true);
    expect(isExactPocket(profParts({ age: 'TOO_EARLY' }) as ProfileLike)).toBe(false);
    expect(isExactPocket(profParts({ m5: '-20 to -5' }) as ProfileLike)).toBe(false);
    expect(isExactPocket(profParts({ vlr: 'VLR_0_5_1' }) as ProfileLike)).toBe(false);
    expect(isExactPocket(profParts({ scoreBand: 'SCORE_90_99' }) as ProfileLike)).toBe(false);
  });

  it('broad pocket is a superset of the exact pocket in a mixed stream', () => {
    seq = 0;
    const ev = [
      ...Array.from({ length: 6 }, () => pair({ pnl: 5 })).flat(),                       // exact + broad
      ...Array.from({ length: 4 }, () => pair({ age: 'TOO_EARLY', pnl: 5 })).flat(),     // broad only (not exact)
      ...Array.from({ length: 3 }, () => pair({ gate: false, pnl: 5 })).flat(),          // neither
      ...Array.from({ length: 2 }, () => pair({ lane: 'NO_BM_PULLBACK', pnl: 5 })).flat(),// neither
    ];
    const r = build(ev);
    expect(r.broadPocket.totalValued).toBe(10);
    expect(r.exactPocket.totalValued).toBe(6);
  });
});

// ── Valuation exclusion ─────────────────────────────────────────────────────────────────────────

describe('never counts valuation-unusable trades as flat', () => {
  it('unvalued sells are excluded from the pocket entirely, not flat', () => {
    seq = 0;
    const ev = [
      ...Array.from({ length: 5 }, () => pair({ pnl: 10 })).flat(),
      ...Array.from({ length: 3 }, () => pair({ pnl: null, usable: false })).flat(),
    ];
    const r = build(ev);
    const w = win(r, 'broadPocket', 'all valued');
    expect(w.valuedClosed).toBe(5);
    expect(w.flats).toBe(0);
    expect(w.wins).toBe(5);
    expect(r.totalValuedClosed).toBe(5);
    expect(r.totalUnvaluedExcluded).toBe(3);
  });

  it('orderedValuedPocket drops unvalued trades', () => {
    const trades = buildAutopsyTrades([
      ...pair({ pnl: 5 }),
      ...pair({ pnl: null, usable: false }),
    ]);
    const ordered = orderedValuedPocket(trades, isBroadPocket);
    expect(ordered.length).toBe(1);
    expect(ordered.every(t => t.valued)).toBe(true);
  });
});

// ── Ordering + window comparison logic ──────────────────────────────────────────────────────────

describe('window comparison logic', () => {
  it('orders valued trades chronologically by sell timestamp', () => {
    seq = 0;
    const trades = buildAutopsyTrades([
      ...pair({ pnl: 3, ts: '2026-07-03T00:00:00.000Z' }),
      ...pair({ pnl: 1, ts: '2026-07-01T00:00:00.000Z' }),
      ...pair({ pnl: 2, ts: '2026-07-02T00:00:00.000Z' }),
    ]);
    const ordered = orderedValuedPocket(trades, isBroadPocket);
    expect(ordered.map(t => t.pnlPct)).toEqual([1, 2, 3]);
  });

  it('windowStat over "first N" uses only the first N valued trades', () => {
    seq = 0;
    // 25 strong then 25 terrible → first-25 window sees only the strong ones.
    const ordered: AutopsyTrade[] = [
      ...Array.from({ length: 25 }, (_, i) => tr({ pnl: 10, ts: `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z` })),
      ...Array.from({ length: 25 }, (_, i) => tr({ pnl: -10, ts: `2026-07-02T00:00:${String(i).padStart(2, '0')}.000Z` })),
    ];
    const first25 = windowStat(ordered, 'first 25 valued', 25);
    const all = windowStat(ordered, 'all valued', null);
    expect(first25.valuedClosed).toBe(25);
    expect(first25.wins).toBe(25);
    expect(first25.medianPnlPct).toBeCloseTo(10, 5);
    expect(all.valuedClosed).toBe(50);
    expect(all.medianPnlPct).toBeCloseTo(0, 5);   // half +10, half -10
  });

  it('the four sample windows are produced with the requested sizes', () => {
    seq = 0;
    const r = build(Array.from({ length: 80 }, () => pair({ pnl: 1 })).flat());
    expect(r.broadPocket.windows.map(w => w.label)).toEqual(
      ['first 25 valued', 'first 50 valued', 'first 75 valued', 'all valued']);
    expect(win(r, 'broadPocket', 'first 25 valued').valuedClosed).toBe(25);
    expect(win(r, 'broadPocket', 'first 75 valued').valuedClosed).toBe(75);
    expect(win(r, 'broadPocket', 'all valued').valuedClosed).toBe(80);
  });
});

// ── Trend / collapse detection ──────────────────────────────────────────────────────────────────

describe('collapse detection', () => {
  const mk = (o: { median: number; net2: number; redLoss: number }): WindowStat => ({
    name: 'w', category: 'window', buys: 0, valuedClosed: 60, unvaluedExcluded: 0,
    wins: 0, losses: 0, flats: 0, winRate: 0, redLossRate: o.redLoss,
    medianPnlPct: o.median, cappedAveragePnlPct: o.net2 + 2, bestTrade: null, worstTrade: null,
    netCappedAvgAfter2: o.net2, netCappedAvgAfter5: o.net2 - 3,
    topTradeDependencyPts: 0, top3TradeDependencyPts: 0, readiness: 'WEAK',
    label: 'w', requested: null, trend: 'BASELINE',
  });

  it('first window is BASELINE', () => {
    expect(classifyTrend(null, mk({ median: 5, net2: 5, redLoss: 0.3 }))).toBe('BASELINE');
  });
  it('COLLAPSED when the median drops', () => {
    const prev = mk({ median: 3, net2: 3, redLoss: 0.35 });
    const cur = mk({ median: -1, net2: 2.5, redLoss: 0.35 });
    expect(classifyTrend(prev, cur)).toBe('COLLAPSED');
  });
  it('COLLAPSED when net-2% drops sharply or red-loss climbs', () => {
    const prev = mk({ median: 2, net2: 4, redLoss: 0.4 });
    expect(classifyTrend(prev, mk({ median: 2, net2: 1, redLoss: 0.4 }))).toBe('COLLAPSED');   // net drop
    expect(classifyTrend(prev, mk({ median: 2, net2: 4, redLoss: 0.5 }))).toBe('COLLAPSED');   // red-loss up
  });
  it('IMPROVED when median and net rise with red-loss not worsening', () => {
    const prev = mk({ median: 0, net2: 0, redLoss: 0.5 });
    expect(classifyTrend(prev, mk({ median: 2, net2: 3, redLoss: 0.4 }))).toBe('IMPROVED');
  });
  it('HELD when metrics barely move', () => {
    const prev = mk({ median: 1, net2: 2, redLoss: 0.45 });
    expect(classifyTrend(prev, mk({ median: 1.1, net2: 2.2, redLoss: 0.45 }))).toBe('HELD');
  });

  it('end-to-end: an early-promising pocket that decays is flagged COLLAPSED and reasons fire', () => {
    seq = 0;
    // First 25 valued: strong (+12%). Next 60: weak/red so the full sample washes out.
    const strong = Array.from({ length: 25 }, (_, i) =>
      pair({ pnl: 12, ts: `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z` })).flat();
    const weak = Array.from({ length: 60 }, (_, i) =>
      pair({ pnl: -3, ts: `2026-07-05T00:00:${String(i % 60).padStart(2, '0')}.000Z` })).flat();
    const r = build([...strong, ...weak]);

    const first = win(r, 'broadPocket', 'first 25 valued');
    const all = win(r, 'broadPocket', 'all valued');
    expect(first.medianPnlPct!).toBeGreaterThan(3);
    expect(all.medianPnlPct!).toBeLessThan(0);
    // The collapse registers as soon as the weak batch dilutes the early edge.
    expect(win(r, 'broadPocket', 'first 50 valued').trend).toBe('COLLAPSED');
    expect(r.broadPocket.windows.some(w => w.trend === 'COLLAPSED')).toBe(true);

    const codes = r.collapseReasons.filter(x => x.active).map(x => x.code);
    expect(codes).toContain('SAMPLE_SIZE_ILLUSION');
    expect(codes).toContain('MEDIAN_WENT_NEGATIVE');
    expect(codes).toContain('RED_LOSS_ROSE_ABOVE_SAFE_RANGE');
    expect(codes).toContain('BROAD_LANE_WASHED_OUT');
  });

  it('detects winners lifting cappedAvg while the typical trade is weak', () => {
    seq = 0;
    // 40 flat-to-red (median <= 0) + a few big winners → cappedAvg positive, median not.
    const ev = [
      ...Array.from({ length: 40 }, () => pair({ pnl: -1 })).flat(),
      ...Array.from({ length: 5 }, () => pair({ pnl: 90 })).flat(),
    ];
    const broad = buildPocketAutopsy('b', 'd', buildAutopsyTrades(ev), isBroadPocket);
    const exact = buildPocketAutopsy('e', 'd', buildAutopsyTrades(ev), isExactPocket);
    const codes = detectCollapseReasons(broad, exact).filter(x => x.active).map(x => x.code);
    expect(codes).toContain('WINNERS_LIFTING_CAPPEDAVG_WHILE_TYPICAL_WEAK');
  });

  it('a genuinely healthy pocket fires no collapse reasons', () => {
    seq = 0;
    const ev = Array.from({ length: 60 }, () => pair({ pnl: 8 })).flat();
    const r = build(ev);
    expect(r.collapseReasons.every(x => !x.active)).toBe(true);
    expect(win(r, 'broadPocket', 'all valued').readiness).not.toBe('WEAK');
  });

  it('exact-pocket failure is flagged independently of the broad lane', () => {
    seq = 0;
    // Broad lane healthy overall, but the exact sub-pocket is weak/red.
    const healthyBroadOnly = Array.from({ length: 40 }, () => pair({ age: 'TOO_EARLY', pnl: 9 })).flat();
    const weakExact = Array.from({ length: 30 }, () => pair({ pnl: -3 })).flat();
    const r = build([...healthyBroadOnly, ...weakExact]);
    const codes = r.collapseReasons.filter(x => x.active).map(x => x.code);
    expect(codes).toContain('EXACT_POCKET_FAILED_TO_HOLD');
  });

  it('SAFE_RED_LOSS_RATE gate: red-loss above the cap is flagged', () => {
    expect(SAFE_RED_LOSS_RATE).toBeGreaterThan(0);
    seq = 0;
    // 60 trades, 55% red → above the safe cap.
    const ev = [
      ...Array.from({ length: 33 }, () => pair({ pnl: -4 })).flat(),
      ...Array.from({ length: 27 }, () => pair({ pnl: 3 })).flat(),
    ];
    const broad = buildPocketAutopsy('b', 'd', buildAutopsyTrades(ev), isBroadPocket);
    const exact = buildPocketAutopsy('e', 'd', buildAutopsyTrades(ev), isExactPocket);
    const redReason = detectCollapseReasons(broad, exact).find(x => x.code === 'RED_LOSS_ROSE_ABOVE_SAFE_RANGE')!;
    expect(redReason.active).toBe(true);
  });
});

// ── Conclusion + safety ─────────────────────────────────────────────────────────────────────────

describe('conclusion and safety', () => {
  it('always concludes NO PRIME CANDIDATE FOUND with a no-live/no-paper recommendation', () => {
    seq = 0;
    const r = build(Array.from({ length: 60 }, () => pair({ pnl: 8 })).flat());   // even a "healthy" pocket
    expect(r.conclusion).toBe('NO PRIME CANDIDATE FOUND');
    expect(r.primeCandidateFound).toBe(false);
    expect(r.recommendation).toMatch(/DO NOT ENABLE REAL TRADING/i);
    expect(r.recommendation).toMatch(/collect|tighten/i);
  });

  it('rendered output carries every required safety string and stays not-ready', () => {
    seq = 0;
    const text = renderFailureAutopsyReport(build(Array.from({ length: 5 }, () => pair({ pnl: 5 })).flat()));
    for (const s of ['REPORT_ONLY', 'NO_TRADES', 'READY_FOR_REAL_TRADING=false', 'REAL_TRADING=false',
      'NO_WALLET=true', 'NO_SWAP=true', 'NO_SIGNING=true', 'DO_NOT_ENABLE_REAL_TRADING']) {
      expect(text).toContain(s);
    }
    expect(text).toContain('NO PRIME CANDIDATE FOUND');
    expect(text).toContain('DO NOT ENABLE REAL TRADING.');
    expect(text).not.toMatch(/READY_FOR_REAL_TRADING=true/);
  });

  it('result object carries read-only / no-trade safety flags', () => {
    seq = 0;
    const r = build(Array.from({ length: 5 }, () => pair({ pnl: 5 })).flat());
    expect(r.reportOnly).toBe(true);
    expect(r.noTrades).toBe(true);
    expect(r.readyForRealTrading).toBe(false);
    expect(r.realTrading).toBe(false);
    expect(r.noWallet).toBe(true);
    expect(r.noSwap).toBe(true);
    expect(r.noSigning).toBe(true);
  });

  it('empty stream yields a safe zeroed result, not a crash', () => {
    const r = build([]);
    expect(r.totalValuedClosed).toBe(0);
    expect(r.broadPocket.totalValued).toBe(0);
    expect(r.exactPocket.totalValued).toBe(0);
    expect(r.conclusion).toBe('NO PRIME CANDIDATE FOUND');
    expect(r.readyForRealTrading).toBe(false);
    // Renders without throwing.
    expect(() => renderFailureAutopsyReport(r)).not.toThrow();
  });

  it('usage documents the report-only nature', () => {
    const u = renderFailureAutopsyReportUsage();
    expect(u).toContain('failure-autopsy-report');
    expect(u).toContain('READY_FOR_REAL_TRADING=false');
    expect(u).toContain('REPORT_ONLY');
  });

  it('module source never calls trading / paper / wallet / signing / swap code', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/failureAutopsyReport.ts'), 'utf-8');
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap|sendTransaction|Keypair\.|Connection\(/i);
    expect(src).not.toMatch(/execSync|spawn|child_process/);
    expect(src).not.toMatch(/token:auto-paper|token:paper-buy|runAutoPaper|paperBuy|autoPaper/);
    expect(src).not.toMatch(/saveBrainPolicyMemory|writeFileSync|writeFile\(|appendFile/);
    expect(src).not.toMatch(/READY_FOR_REAL_TRADING\s*=\s*true|readyForRealTrading:\s*true/);
  });
});
