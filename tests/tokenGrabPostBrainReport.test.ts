import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPostBrainReport,
  runPostBrainReport,
  renderPostBrainReport,
  renderPostBrainReportUsage,
  type PostBrainReportResult,
} from '../src/token-grab/postBrainReport';
import type { BrainPolicyMemory } from '../src/token-grab/brainPolicy';

const ISO_PRE  = '2026-07-01T10:00:00.000Z';
const ISO_POST = '2026-07-01T20:00:00.000Z';
const GEN = '2026-07-02T00:00:00.000Z';

const dirs: string[] = [];
function tmpDir(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'postbrain-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

// ── Event builders ──────────────────────────────────────────────────────────────────────────

let seq = 0;
function buy(o: { ts: string; lane: string; gate: boolean; brainAction?: string; contract?: string; sourceCycle?: string; launchAge?: string }) {
  const contract = o.contract ?? `C${seq++}${'z'.repeat(42)}`.slice(0, 43);
  const e: any = {
    type: 'RESEARCH_WOULD_BUY', ts: o.ts, contract, symbol: 'X', lane: o.lane,
    m5Band: '-20 to -5', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_LT_0_5', ripperScoreBand: 'SCORE_60_79',
    ripperScore: 70, productionGateApproved: o.gate, clusterRisk: 'UNKNOWN', sourceCycle: o.sourceCycle ?? `cyc-${contract}`,
    entryValuation: 0.001, valuationField: 'priceUsd', entryMomentumPct: -10, entryLiquidityChangePct: 5, entryVlr: 0.4,
    launchAgeBucket: o.launchAge ?? 'PRIME_WINDOW',
    notBuySignal: true, paperOnly: true, researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true,
  };
  if (o.brainAction !== undefined) e.brainAction = o.brainAction;   // presence marks POST-brain
  return { e, contract, sourceCycle: e.sourceCycle };
}
function sell(o: { ts: string; lane: string; gate: boolean; contract: string; sourceCycle: string; usable: boolean; pnlPct: number | null; launchAge?: string }) {
  return {
    type: 'RESEARCH_WOULD_SELL', ts: o.ts, contract: o.contract, symbol: 'X', lane: o.lane, sourceCycle: o.sourceCycle,
    exitReason: o.usable ? 'MAX_HOLD_TIME' : 'DATA_STALE_EXIT', note: 't',
    entryValuation: 0.001, exitValuation: o.usable ? 0.0011 : null, valuationField: 'priceUsd',
    valuationUsable: o.usable, valuationStatus: o.usable ? 'OK' : 'VALUATION_UNAVAILABLE',
    valuationMissing: o.usable ? [] : ['contractNotInLatestCycle'],
    pnlPct: o.usable ? o.pnlPct : null, pnlUsd: o.usable && o.pnlPct != null ? o.pnlPct / 100 : null, holdMinutes: 30,
    productionGateApproved: o.gate, launchAgeBucket: o.launchAge ?? 'PRIME_WINDOW',
    m5Band: '-20 to -5', liquidityBucket: 'LIQ_10K_30K', vlrBucket: 'VLR_LT_0_5', ripperScoreBand: 'SCORE_60_79',
    notBuySignal: true, paperOnly: true, researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true,
  };
}
function skip(o: { ts: string; lane: string; brainStatus: 'KILL' | 'DEMOTE'; contract?: string }) {
  return {
    type: 'RESEARCH_SKIPPED_BY_BRAIN', ts: o.ts, contract: o.contract ?? `S${seq++}${'z'.repeat(42)}`.slice(0, 43),
    symbol: 'X', lane: o.lane, sourceCycle: 'cyc-skip', m5Band: '-5 to +5', liquidityBucket: 'LIQ_10K_30K',
    vlrBucket: 'VLR_0_5_TO_2', ripperScoreBand: 'SCORE_60_79', productionGateApproved: false, launchAgeBucket: 'PRIME_WINDOW',
    clusterRisk: 'UNKNOWN', brainStatus: o.brainStatus, reason: 'GLOBAL global group ' + o.brainStatus,
    notBuySignal: true, paperOnly: true, researchOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true,
  };
}

/** A pre-brain trade (buy without brainAction) + its valued sell. */
function preTrade(lane: string, gate: boolean, pnlPct: number, usable = true) {
  const b = buy({ ts: ISO_PRE, lane, gate });
  return [b.e, sell({ ts: ISO_PRE, lane, gate, contract: b.contract, sourceCycle: b.sourceCycle, usable, pnlPct })];
}
/** A post-brain trade (buy WITH brainAction) + its valued sell. */
function postTrade(lane: string, gate: boolean, pnlPct: number, brainAction = 'WATCH', usable = true) {
  const b = buy({ ts: ISO_POST, lane, gate, brainAction });
  return [b.e, sell({ ts: ISO_POST, lane, gate, contract: b.contract, sourceCycle: b.sourceCycle, usable, pnlPct })];
}

function build(events: any[], memory: BrainPolicyMemory | null = null): PostBrainReportResult {
  return buildPostBrainReport(events, memory, { eventsPath: 'e.jsonl', memoryPath: 'm.json', generatedAt: GEN });
}

// ── Pre/post separation ───────────────────────────────────────────────────────────────────────

describe('post-brain report separates pre/post brain events', () => {
  it('classifies trades by whether the opening buy carried a brainAction', () => {
    seq = 0;
    const ev = [
      ...preTrade('NO_BM_INTERNAL_BROAD', false, -10),
      ...preTrade('NO_BM_INTERNAL_BROAD', false, -20),
      ...postTrade('NO_BM_INTERNAL_BROAD', true, 30, 'PROMOTE'),
      ...postTrade('NO_BM_INTERNAL_BROAD', true, 10, 'PROMOTE'),
      ...postTrade('NO_BM_INTERNAL_BROAD', true, 20, 'WATCH'),
    ];
    const r = build(ev);
    expect(r.brainActive).toBe(true);
    expect(r.brainActivatedAt).toBe(ISO_POST);
    expect(r.pre.valuedClosed).toBe(2);
    expect(r.post.valuedClosed).toBe(3);
    // Pre are losers, post are winners → post median/cappedAvg strictly better.
    expect(r.pre.medianPnlPct!).toBeLessThan(0);
    expect(r.post.medianPnlPct!).toBeGreaterThan(0);
    expect(r.post.cappedAveragePnlPct!).toBeGreaterThan(r.pre.cappedAveragePnlPct!);
    expect(r.post.redLossRate).toBeLessThan(r.pre.redLossRate);
  });

  it('brainActive=false when no brainAction and no skips exist (all pre)', () => {
    seq = 0;
    const r = build([...preTrade('NO_BM_INTERNAL_BROAD', false, 5), ...preTrade('NO_BM_INTERNAL_BROAD', false, -5)]);
    expect(r.brainActive).toBe(false);
    expect(r.brainActivatedAt).toBeNull();
    expect(r.post.valuedClosed).toBe(0);
    expect(r.pre.valuedClosed).toBe(2);
  });
});

// ── Valuation exclusion ────────────────────────────────────────────────────────────────────────

describe('excludes VALUATION_UNAVAILABLE (never flat)', () => {
  it('unvalued sells are excluded from P/L and not counted as flat', () => {
    seq = 0;
    const ev = [
      ...postTrade('NO_BM_INTERNAL_BROAD', true, 20, 'PROMOTE', true),   // valued win
      ...postTrade('NO_BM_INTERNAL_BROAD', true, 0, 'PROMOTE', false),   // VALUATION_UNAVAILABLE (pnl null)
    ];
    const r = build(ev);
    expect(r.post.valuedClosed).toBe(1);
    expect(r.post.unvaluedClosed).toBe(1);
    expect(r.post.flats).toBe(0);          // unvalued NOT a flat
    expect(r.post.wins).toBe(1);
    expect(r.post.redLossRate).toBe(0);
  });
});

// ── Counts ──────────────────────────────────────────────────────────────────────────────────

describe('counts skipped-by-brain and promote annotations', () => {
  it('counts RESEARCH_SKIPPED_BY_BRAIN by status and PROMOTE/WATCH annotations', () => {
    seq = 0;
    const ev = [
      ...postTrade('NO_BM_INTERNAL_BROAD', true, 10, 'PROMOTE'),
      ...postTrade('NO_BM_INTERNAL_BROAD', true, 10, 'PROMOTE'),
      ...postTrade('NO_BM_INTERNAL_BROAD', false, -5, 'WATCH'),
      skip({ ts: ISO_POST, lane: 'NO_BM_BEST_VLR', brainStatus: 'KILL' }),
      skip({ ts: ISO_POST, lane: 'NO_BM_BEST_VLR', brainStatus: 'KILL' }),
      skip({ ts: ISO_POST, lane: 'NO_BM_INTERNAL_BROAD', brainStatus: 'DEMOTE' }),
    ];
    const r = build(ev);
    expect(r.skippedByBrainTotal).toBe(3);
    expect(r.skippedByStatus.KILL).toBe(2);
    expect(r.skippedByStatus.DEMOTE).toBe(1);
    expect(r.killDemoteSuppressions).toBe(3);
    expect(r.promoteAnnotations).toBe(2);
    expect(r.watchAnnotations).toBe(1);
  });
});

// ── Killed lane suppression (#12) ────────────────────────────────────────────────────────────────

describe('shows killed lane suppression', () => {
  it('a killed lane opens pre-brain but is skipped (not opened) post-brain', () => {
    seq = 0;
    const ev = [
      // Pre-brain: the BEST_VLR lane was still opening research positions.
      ...preTrade('NO_BM_BEST_VLR', false, -30),
      ...preTrade('NO_BM_BEST_VLR', false, -25),
      // Post-brain: it is now skipped by a global KILL, not opened.
      skip({ ts: ISO_POST, lane: 'NO_BM_BEST_VLR', brainStatus: 'KILL' }),
      skip({ ts: ISO_POST, lane: 'NO_BM_BEST_VLR', brainStatus: 'KILL' }),
      skip({ ts: ISO_POST, lane: 'NO_BM_BEST_VLR', brainStatus: 'KILL' }),
      // An unrelated lane keeps opening post-brain.
      ...postTrade('NO_BM_INTERNAL_BROAD', true, 15, 'WATCH'),
    ];
    const r = build(ev);
    const killed = r.killedLaneSuppression.find(k => k.lane === 'NO_BM_BEST_VLR')!;
    expect(killed).toBeTruthy();
    expect(killed.buysPre).toBe(2);
    expect(killed.buysPost).toBe(0);         // stopped opening
    expect(killed.skipsPost).toBe(3);
    expect(killed.stoppedOpening).toBe(true);
    expect(killed.suppressionRate).toBe(1);  // 3 skips / (0 buys + 3 skips)
  });

  it('also treats a lane-scoped global KILL in memory as a killed lane', () => {
    seq = 0;
    const memory = {
      version: 1.1, generatedAt: GEN, eventsPath: 'x', totalProfiles: 0, profiles: {},
      totalGlobalGroups: 1,
      globalGroups: {
        'lane:NO_BM_BEST_VLR': {
          key: 'lane:NO_BM_BEST_VLR', dimension: 'lane', value: 'NO_BM_BEST_VLR', buys: 40, valuedClosed: 39,
          unvaluedClosed: 1, wins: 13, losses: 26, flats: 0, medianPnlPct: -4, cappedAveragePnlPct: -8, redLossRate: 0.67,
          bestTrade: null, worstTrade: null, lastUpdated: GEN, confidenceTier: 'STRONG', policyStatus: 'KILL',
        },
      },
      realTrading: false, readyForRealTrading: false, noWallet: true, noSwap: true, noSigning: true,
      paperOnly: true, researchOnly: true, unknownStaysUnknown: true, tradingExecuted: 0,
    } as unknown as BrainPolicyMemory;
    const ev = [...preTrade('NO_BM_BEST_VLR', false, -20)];
    const r = build(ev, memory);
    expect(r.killedLaneSuppression.some(k => k.lane === 'NO_BM_BEST_VLR')).toBe(true);
  });

  it('sticky KILL: measures buys/skips AFTER killedAt and trulyStoppedAfterKill', () => {
    seq = 0;
    const killedAt = '2026-07-01T15:00:00.000Z';
    const memory = {
      version: 1.2, generatedAt: GEN, eventsPath: 'x', totalProfiles: 0, profiles: {}, totalGlobalGroups: 1,
      globalGroups: {
        'lane:NO_BM_BEST_VLR': {
          key: 'lane:NO_BM_BEST_VLR', dimension: 'lane', value: 'NO_BM_BEST_VLR', buys: 40, valuedClosed: 39,
          unvaluedClosed: 1, wins: 13, losses: 26, flats: 0, medianPnlPct: -4, cappedAveragePnlPct: -8, redLossRate: 0.67,
          bestTrade: null, worstTrade: null, lastUpdated: GEN, confidenceTier: 'STRONG', policyStatus: 'KILL',
          killedAt, recoveryState: 'RECOVERING', postKillValuedClosed: 8, recoveryProgress: 0.4,
        },
      },
      realTrading: false, readyForRealTrading: false, noWallet: true, noSwap: true, noSigning: true,
      paperOnly: true, researchOnly: true, unknownStaysUnknown: true, tradingExecuted: 0,
    } as unknown as BrainPolicyMemory;
    // A buy BEFORE the kill, and two skips AFTER the kill → truly stopped opening post-kill.
    const b = buy({ ts: '2026-07-01T14:00:00.000Z', lane: 'NO_BM_BEST_VLR', gate: false, brainAction: 'WATCH' });
    const ev = [
      b.e,
      skip({ ts: '2026-07-01T16:00:00.000Z', lane: 'NO_BM_BEST_VLR', brainStatus: 'KILL' }),
      skip({ ts: '2026-07-01T16:30:00.000Z', lane: 'NO_BM_BEST_VLR', brainStatus: 'KILL' }),
    ];
    const r = build(ev, memory);
    const k = r.killedLaneSuppression.find(x => x.lane === 'NO_BM_BEST_VLR')!;
    expect(k.killedAt).toBe(killedAt);
    expect(k.recoveryState).toBe('RECOVERING');
    expect(k.buysAfterKill).toBe(0);           // the only buy was before killedAt
    expect(k.skipsAfterKill).toBe(2);
    expect(k.trulyStoppedAfterKill).toBe(true);

    // The report renders the sticky line.
    const text = renderPostBrainReport(r);
    expect(text).toContain('sticky killedAt');
    expect(text).toContain('trulyStoppedAfterKill=true');
  });
});

// ── Safety ──────────────────────────────────────────────────────────────────────────────────

describe('safety strings + read-only', () => {
  it('render includes all required safety strings', () => {
    seq = 0;
    const text = renderPostBrainReport(build([...postTrade('NO_BM_INTERNAL_BROAD', true, 10, 'PROMOTE')]));
    for (const s of ['REPORT_ONLY', 'NO_TRADES', 'READY_FOR_REAL_TRADING=false', 'REAL_TRADING=false',
      'NO_WALLET=true', 'NO_SWAP=true', 'NO_SIGNING=true', 'DO_NOT_ENABLE_REAL_TRADING']) {
      expect(text).toContain(s);
    }
  });

  it('result object carries read-only / no-trade safety flags', () => {
    seq = 0;
    const r = build([...postTrade('NO_BM_INTERNAL_BROAD', true, 10, 'PROMOTE')]);
    expect(r.reportOnly).toBe(true);
    expect(r.noTrades).toBe(true);
    expect(r.readyForRealTrading).toBe(false);
    expect(r.realTrading).toBe(false);
    expect(r.noWallet).toBe(true);
    expect(r.noSwap).toBe(true);
    expect(r.noSigning).toBe(true);
  });

  it('module source contains no real-trading / wallet / swap / signing code', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/postBrainReport.ts'), 'utf-8');
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|executeSwap|sendTransaction|Keypair\.|Connection\(/i);
    expect(src).not.toMatch(/execSync|spawn|child_process|token:auto-paper|token:paper-buy/);
    expect(src).not.toMatch(/READY_FOR_REAL_TRADING\s*=\s*true|readyForRealTrading:\s*true/);
  });

  it('usage documents report-only nature', () => {
    const u = renderPostBrainReportUsage();
    expect(u).toContain('post-brain-report');
    expect(u).toContain('READY_FOR_REAL_TRADING=false');
    expect(u).toContain('REPORT_ONLY');
  });
});

// ── Empty stream ──────────────────────────────────────────────────────────────────────────────

describe('robustness', () => {
  it('runPostBrainReport on a missing events file yields zeroed, safe result', () => {
    const dir = tmpDir();
    const r = runPostBrainReport({ eventsPath: path.join(dir, 'none.jsonl'), memoryPath: path.join(dir, 'none.json'), generatedAt: GEN });
    expect(r.pre.valuedClosed).toBe(0);
    expect(r.post.valuedClosed).toBe(0);
    expect(r.brainActive).toBe(false);
    expect(r.readyForRealTrading).toBe(false);
  });
});
