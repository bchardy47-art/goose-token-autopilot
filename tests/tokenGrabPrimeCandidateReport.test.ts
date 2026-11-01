import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildPrimeCandidateReport,
  computeCohort,
  readinessLabel,
  renderPrimeCandidateReport,
  renderPrimeCandidateReportUsage,
  HAIRCUT_2_PCT,
  HAIRCUT_5_PCT,
  type ProfileLike,
  type TradeRec,
  type Readiness,
} from '../src/token-grab/primeCandidateReport';

const GEN = '2026-07-04T00:00:00.000Z';

// ── Event builders ──────────────────────────────────────────────────────────────────────────

interface Prof { lane?: string; gate?: boolean; age?: string; m5?: string; liq?: string; vlr?: string; scoreBand?: string; score?: number; }
function prof(o: Prof) {
  return {
    lane: o.lane ?? 'NO_BM_INTERNAL_BROAD', productionGateApproved: o.gate ?? true, launchAgeBucket: o.age ?? 'PRIME_WINDOW',
    m5Band: o.m5 ?? '-20 to -5', liquidityBucket: o.liq ?? 'LIQ_10K_30K', vlrBucket: o.vlr ?? 'VLR_LT_0_5',
    ripperScoreBand: o.scoreBand ?? 'SCORE_90_99', ripperScore: o.score ?? 95,
  };
}
let seq = 0;
function pair(o: Prof & { pnl: number | null; usable?: boolean; brainAction?: string | null }) {
  const p = prof(o);
  const contract = `C${seq++}${'z'.repeat(42)}`.slice(0, 43);
  const cyc = `cyc-${contract}`;
  const usable = o.usable ?? true;
  const buy: any = {
    type: 'RESEARCH_WOULD_BUY', ts: GEN, contract, symbol: contract.slice(0, 4), sourceCycle: cyc,
    lane: p.lane, m5Band: p.m5Band, liquidityBucket: p.liquidityBucket, vlrBucket: p.vlrBucket,
    ripperScoreBand: p.ripperScoreBand, ripperScore: p.ripperScore, productionGateApproved: p.productionGateApproved,
    clusterRisk: 'UNKNOWN', launchAgeBucket: p.launchAgeBucket, entryValuation: 0.001, valuationField: 'priceUsd',
    notBuySignal: true, paperOnly: true, researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true,
  };
  if (o.brainAction !== undefined) { if (o.brainAction !== null) buy.brainAction = o.brainAction; }
  else buy.brainAction = 'WATCH';   // default: post-brain
  const sell: any = {
    type: 'RESEARCH_WOULD_SELL', ts: GEN, contract, symbol: contract.slice(0, 4), sourceCycle: cyc, lane: p.lane,
    exitReason: usable ? 'MAX_HOLD_TIME' : 'DATA_STALE_EXIT', note: 't', entryValuation: 0.001,
    exitValuation: usable ? 0.001 * (1 + (o.pnl ?? 0) / 100) : null, valuationField: 'priceUsd',
    valuationUsable: usable, valuationStatus: usable ? 'OK' : 'VALUATION_UNAVAILABLE',
    valuationMissing: usable ? [] : ['x'], pnlPct: usable ? o.pnl : null, pnlUsd: usable && o.pnl != null ? o.pnl / 100 : null,
    holdMinutes: 30, productionGateApproved: p.productionGateApproved, launchAgeBucket: p.launchAgeBucket,
    notBuySignal: true, paperOnly: true, researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true,
  };
  return [buy, sell];
}
function build(events: any[], memory: any = null) {
  return buildPrimeCandidateReport(events, memory, { eventsPath: 'e.jsonl', memoryPath: 'm.json', generatedAt: GEN });
}
function cohort(r: ReturnType<typeof build>, name: string) {
  const c = r.cohorts.find(x => x.name === name);
  if (!c) throw new Error(`cohort not found: ${name}`);
  return c;
}

// ── Cohort computation ────────────────────────────────────────────────────────────────────────

describe('computes cohorts correctly', () => {
  it('splits gate=true vs gate=false and lane cohorts with correct counts', () => {
    seq = 0;
    const ev = [
      ...Array.from({ length: 6 }, () => pair({ gate: true, lane: 'NO_BM_PULLBACK', pnl: 10 })).flat(),
      ...Array.from({ length: 4 }, () => pair({ gate: true, lane: 'NO_BM_BEST_VLR', pnl: -10 })).flat(),
      ...Array.from({ length: 5 }, () => pair({ gate: false, lane: 'NO_BM_INTERNAL_BROAD', pnl: 5 })).flat(),
    ];
    const r = build(ev);
    expect(cohort(r, 'gate=true').buys).toBe(10);
    expect(cohort(r, 'gate=true').valuedClosed).toBe(10);
    expect(cohort(r, 'gate=true excl NO_BM_BEST_VLR').valuedClosed).toBe(6);
    expect(cohort(r, 'lane=NO_BM_PULLBACK').valuedClosed).toBe(6);
    expect(cohort(r, 'gate=true + NO_BM_PULLBACK').valuedClosed).toBe(6);
    expect(cohort(r, 'gate=true + NO_BM_PULLBACK').wins).toBe(6);
    expect(cohort(r, 'lane=NO_BM_BEST_VLR').losses).toBe(4);
  });

  it('score>=90 and PRIME_WINDOW filters use the joined buy fields', () => {
    seq = 0;
    const ev = [
      ...Array.from({ length: 3 }, () => pair({ gate: true, score: 95, age: 'PRIME_WINDOW', pnl: 20 })).flat(),
      ...Array.from({ length: 3 }, () => pair({ gate: true, score: 70, age: 'TOO_EARLY', pnl: -20 })).flat(),
    ];
    const r = build(ev);
    expect(cohort(r, 'gate=true + score>=90').valuedClosed).toBe(3);
    expect(cohort(r, 'gate=true + PRIME_WINDOW + score>=90').valuedClosed).toBe(3);
    expect(cohort(r, 'gate=true + PRIME_WINDOW + score>=90').wins).toBe(3);
  });

  it('post-brain cohort only counts trades whose opening buy carried a brainAction', () => {
    seq = 0;
    const ev = [
      ...Array.from({ length: 4 }, () => pair({ pnl: 10, brainAction: 'WATCH' })).flat(),   // post
      ...Array.from({ length: 3 }, () => pair({ pnl: -10, brainAction: null })).flat(),     // pre (no brainAction)
    ];
    const r = build(ev);
    expect(cohort(r, 'all post-brain').valuedClosed).toBe(4);
    expect(cohort(r, 'all post-brain').buys).toBe(4);
  });
});

// ── Valuation exclusion ─────────────────────────────────────────────────────────────────────

describe('excludes valuation unavailable, never flat', () => {
  it('unvalued sells are excluded from valued/P/L and counted as unvaluedExcluded', () => {
    seq = 0;
    const ev = [
      ...Array.from({ length: 5 }, () => pair({ gate: true, pnl: 10 })).flat(),
      ...Array.from({ length: 3 }, () => pair({ gate: true, pnl: null, usable: false })).flat(),
    ];
    const r = build(ev);
    const c = cohort(r, 'gate=true');
    expect(c.valuedClosed).toBe(5);
    expect(c.unvaluedExcluded).toBe(3);
    expect(c.flats).toBe(0);            // unvalued NOT flat
    expect(c.wins).toBe(5);
    expect(r.totalUnvaluedExcluded).toBe(3);
  });
});

// ── Haircuts ────────────────────────────────────────────────────────────────────────────────

describe('applies 2% and 5% haircut', () => {
  it('net cappedAvg = cappedAvg minus the haircut points', () => {
    seq = 0;
    // 10 trades all at +10% → cappedAvg = +10.
    const ev = Array.from({ length: 10 }, () => pair({ gate: true, pnl: 10 })).flat();
    const c = cohort(build(ev), 'gate=true');
    expect(c.cappedAveragePnlPct).toBeCloseTo(10, 5);
    expect(c.netCappedAvgAfter2).toBeCloseTo(10 - HAIRCUT_2_PCT, 5);
    expect(c.netCappedAvgAfter5).toBeCloseTo(10 - HAIRCUT_5_PCT, 5);
  });

  it('caps individual trades at ±100 before averaging', () => {
    seq = 0;
    // 9 at 0, 1 at +1000 (clamped to +100) → cappedAvg = 100/10 = 10.
    const ev = [
      ...Array.from({ length: 9 }, () => pair({ gate: true, pnl: 0 })).flat(),
      ...pair({ gate: true, pnl: 1000 }),
    ];
    const c = cohort(build(ev), 'gate=true');
    expect(c.cappedAveragePnlPct).toBeCloseTo(10, 5);
  });
});

// ── Top-trade dependency ───────────────────────────────────────────────────────────────────────

describe('detects top-trade dependency', () => {
  it('flags a cohort whose edge comes from one trade', () => {
    seq = 0;
    // 20 trades at 0% + 1 at +100% → cappedAvg = 100/21 ≈ 4.76, all of it from the top trade.
    const ev = [
      ...Array.from({ length: 20 }, () => pair({ gate: true, pnl: 0 })).flat(),
      ...pair({ gate: true, pnl: 100 }),
    ];
    const c = cohort(build(ev), 'gate=true');
    expect(c.cappedAveragePnlPct).toBeCloseTo(100 / 21, 3);
    // Removing the top trade drops cappedAvg to 0 → dependency ≈ full cappedAvg.
    expect(c.topTradeDependencyPts).toBeCloseTo(100 / 21, 3);
    expect(c.top3TradeDependencyPts).toBeGreaterThanOrEqual(c.topTradeDependencyPts!);
  });

  it('a broad, even cohort has low top-trade dependency', () => {
    seq = 0;
    const ev = Array.from({ length: 30 }, () => pair({ gate: true, pnl: 5 })).flat();
    const c = cohort(build(ev), 'gate=true');
    expect(Math.abs(c.topTradeDependencyPts ?? 0)).toBeLessThan(0.3);
  });
});

// ── Readiness labels ────────────────────────────────────────────────────────────────────────

describe('labels TOO_SMALL / WEAK / WATCH / PROMISING / PRIME correctly', () => {
  const call = (o: { v: number; med: number; cap: number; redLoss: number }): Readiness =>
    readinessLabel({ valuedClosed: o.v, medianPnlPct: o.med, cappedAveragePnlPct: o.cap, redLossRate: o.redLoss, netAfter2: o.cap - 2, netAfter5: o.cap - 5 });

  it('TOO_SMALL when valued < 20', () => {
    expect(call({ v: 19, med: 10, cap: 20, redLoss: 0.1 })).toBe('TOO_SMALL');
  });
  it('WEAK when valued >= 20 but net after 2% haircut <= 0', () => {
    expect(call({ v: 25, med: -1, cap: 1.5, redLoss: 0.6 })).toBe('WEAK');   // net2 = -0.5
  });
  it('WATCH when valued>=30, median>0, cappedAvg>3, redLoss<=45%', () => {
    expect(call({ v: 32, med: 1, cap: 4, redLoss: 0.44 })).toBe('WATCH');
  });
  it('PROMISING when valued>=40, median>2, cappedAvg>5, redLoss<=42%, net2>2', () => {
    expect(call({ v: 45, med: 3, cap: 6, redLoss: 0.40 })).toBe('PROMISING');   // net2 = 4
  });
  it('PRIME_CANDIDATE when valued>=50, median>3, cappedAvg>7, redLoss<=40%, net5>2', () => {
    expect(call({ v: 60, med: 5, cap: 10, redLoss: 0.35 })).toBe('PRIME_CANDIDATE');   // net5 = 5
  });
  it('does not promote a strong-but-small cohort past its sample gate', () => {
    // Great stats but only 45 valued → cannot be PRIME (needs 50), lands PROMISING.
    expect(call({ v: 45, med: 5, cap: 10, redLoss: 0.30 })).toBe('PROMISING');
    // 25 valued, positive but under WATCH's 30 → WEAK.
    expect(call({ v: 25, med: 1, cap: 4, redLoss: 0.3 })).toBe('WEAK');
  });

  it('computeCohort assigns PRIME_CANDIDATE end-to-end on a strong pocket', () => {
    seq = 0;
    // 55 trades: median and cappedAvg comfortably above the prime bar, low red-loss.
    const trades = Array.from({ length: 55 }, () => pair({ gate: true, pnl: 12 })).flat();
    const c = cohort(build(trades), 'gate=true');
    expect(c.valuedClosed).toBe(55);
    expect(c.readiness).toBe('PRIME_CANDIDATE');
  });
});

// ── Conclusion + rankings ───────────────────────────────────────────────────────────────────

describe('conclusion and rankings', () => {
  it('reports "No prime candidate found" when nothing clears the bar', () => {
    seq = 0;
    const ev = Array.from({ length: 25 }, () => pair({ gate: true, pnl: -5 })).flat();
    const r = build(ev);
    expect(r.primeCandidateFound).toBe(false);
    expect(r.conclusion).toBe('No prime candidate found');
  });
  it('reports "Prime candidate found" and ranks it when a pocket clears the bar', () => {
    seq = 0;
    const ev = Array.from({ length: 55 }, () => pair({ gate: true, pnl: 12 })).flat();
    const r = build(ev);
    expect(r.primeCandidateFound).toBe(true);
    expect(r.conclusion).toBe('Prime candidate found');
    expect(r.bestByNetAfter2.length).toBeGreaterThan(0);
    expect(r.bestByNetAfter2[0].netCappedAvgAfter2).toBeGreaterThan(0);
  });
});

// ── Safety ──────────────────────────────────────────────────────────────────────────────────

describe('safety strings + read-only', () => {
  it('render includes all required safety strings and the conclusion + always-false readiness flag', () => {
    seq = 0;
    const text = renderPrimeCandidateReport(build(Array.from({ length: 5 }, () => pair({ gate: true, pnl: 5 })).flat()));
    for (const s of ['REPORT_ONLY', 'NO_TRADES', 'READY_FOR_REAL_TRADING=false', 'REAL_TRADING=false',
      'NO_WALLET=true', 'NO_SWAP=true', 'NO_SIGNING=true', 'DO_NOT_ENABLE_REAL_TRADING']) {
      expect(text).toContain(s);
    }
    expect(text).toMatch(/NO PRIME CANDIDATE FOUND|PRIME CANDIDATE FOUND/);
  });

  it('result object carries read-only / no-trade safety flags', () => {
    seq = 0;
    const r = build(Array.from({ length: 5 }, () => pair({ gate: true, pnl: 5 })).flat());
    expect(r.reportOnly).toBe(true);
    expect(r.noTrades).toBe(true);
    expect(r.readyForRealTrading).toBe(false);
    expect(r.realTrading).toBe(false);
    expect(r.noWallet).toBe(true);
    expect(r.noSwap).toBe(true);
    expect(r.noSigning).toBe(true);
  });

  it('module source never calls trading commands or wallet/signing/swap code', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/primeCandidateReport.ts'), 'utf-8');
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap|sendTransaction|Keypair\.|Connection\(/i);
    expect(src).not.toMatch(/execSync|spawn|child_process|token:auto-paper|token:paper-buy/);
    expect(src).not.toMatch(/READY_FOR_REAL_TRADING\s*=\s*true|readyForRealTrading:\s*true/);
  });

  it('usage documents the report-only nature', () => {
    const u = renderPrimeCandidateReportUsage();
    expect(u).toContain('prime-candidate-report');
    expect(u).toContain('READY_FOR_REAL_TRADING=false');
    expect(u).toContain('REPORT_ONLY');
  });

  it('empty stream yields a safe zeroed result, not a crash', () => {
    const r = build([]);
    expect(r.totalValuedClosed).toBe(0);
    expect(r.primeCandidateFound).toBe(false);
    expect(r.conclusion).toBe('No prime candidate found');
    expect(r.readyForRealTrading).toBe(false);
  });
});
