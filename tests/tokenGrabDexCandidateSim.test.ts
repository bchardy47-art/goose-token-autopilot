import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDexWatchReport,
  type DexWatchOutcome,
  type DexWatchReport,
} from '../src/token-grab/dexWatch';
import { loadWatchReports } from '../src/token-grab/dexWatchSummary';
import {
  buildDexCandidateSimReport,
  renderDexCandidateSimReport,
  simulateTrade,
  normalizeBlockReason,
  historyRiskReasons,
  HISTORY_AVG_VLR_MAX,
} from '../src/token-grab/dexCandidateSim';

// ── Fixtures ────────────────────────────────────────────────────────────────────────

function outcome(over: Partial<DexWatchOutcome> & Pick<DexWatchOutcome, 'contract' | 'classification'>): DexWatchOutcome {
  return { signalId: `sig-${over.contract}`, chainId: 'solana', ...over };
}

function report(outcomes: DexWatchOutcome[], generatedAt = '2026-06-07T10:00:00.000Z'): DexWatchReport {
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

const winO = (contract: string, symbol: string, price: number, liq: number, vlr: number): DexWatchOutcome =>
  outcome({ contract, symbol, classification: 'winner', priceChangePct: price, liquidityChangePct: liq, volumeToLiquidityRatio: vlr });
const loseO = (contract: string, symbol: string, price: number, liq: number, vlr: number): DexWatchOutcome =>
  outcome({ contract, symbol, classification: 'loser', priceChangePct: price, liquidityChangePct: liq, volumeToLiquidityRatio: vlr });
const missO = (contract: string, symbol: string): DexWatchOutcome =>
  outcome({ contract, symbol, classification: 'missing' });

/** Spread one token's per-run outcomes across separate reports (one outcome per run). */
function runsOf(outcomes: DexWatchOutcome[]): DexWatchReport[] {
  return outcomes.map(o => report([o]));
}

const SATOSHI = 'SatoSh11111111111111111111111111111111111111';
const ELON = 'eLonBuck2222222222222222222222222222222222222';
const ONE = 'OneChurn333333333333333333333333333333333333';
const MAD = 'MadInsta44444444444444444444444444444444444444';
const NOLIQ = 'NoLiq5555555555555555555555555555555555555555';

// Single-window fixtures (each token appears once).
const O_SATOSHI = winO(SATOSHI, 'SATOSHI', 54, 23, 0.33);
const O_ELON = winO(ELON, 'elonbucks', 29, 13, 0.44);
const O_ONE = winO(ONE, '1', 34, 16, 2.93); // strongest vlr 2.93 > PASS_VLR_MAX → not a candidate
const O_MAD = loseO(MAD, '$MAD', -30, -25, 0.5); // strongest price < 20 → not a candidate
const O_NOLIQ = outcome({ contract: NOLIQ, symbol: 'NOLIQ', classification: 'winner', priceChangePct: 40, liquidityChangePct: undefined, volumeToLiquidityRatio: 0.5 });

const FULL = report([O_SATOSHI, O_ELON, O_ONE, O_MAD, O_NOLIQ]);

// ── simulateTrade unit ──────────────────────────────────────────────────────────────────

describe('simulateTrade', () => {
  it('computes fake P/L dollars and percent from position size', () => {
    const t = simulateTrade({ contract: SATOSHI, symbol: 'SATOSHI', priceChangePct: 54 }, 1)!;
    expect(t.pnlDollars).toBeCloseTo(0.54);
    expect(t.pnlPct).toBeCloseTo(54);
    expect(t.outcome).toBe('winner');
  });
  it('scales P/L by position size', () => {
    expect(simulateTrade({ contract: ELON, priceChangePct: 29 }, 5)!.pnlDollars).toBeCloseTo(1.45);
  });
  it('returns null when priceChangePct is missing', () => {
    expect(simulateTrade({ contract: NOLIQ }, 1)).toBeNull();
  });
});

// ── normalizeBlockReason ────────────────────────────────────────────────────────────────

describe('normalizeBlockReason', () => {
  it('drops parenthetical detail so reasons group', () => {
    expect(normalizeBlockReason('loseCount >= 1 (loseCount=4)')).toBe('loseCount >= 1');
    expect(normalizeBlockReason('avgVolumeLiquidityRatio > 1 (2.93)')).toBe('avgVolumeLiquidityRatio > 1');
    expect(normalizeBlockReason('missingCount >= 1 (missingCount=2)')).toBe('missingCount >= 1');
  });
});

// ── historyRiskReasons unit ─────────────────────────────────────────────────────────────

describe('historyRiskReasons', () => {
  it('is empty for a clean history', () => {
    expect(historyRiskReasons({ loseCount: 0, drainCount: 0, missingCount: 0, avgVolumeLiquidityRatio: 0.5 })).toEqual([]);
  });
  it('flags lose / drain / missing / high-avg-vlr', () => {
    const r = historyRiskReasons({ loseCount: 2, drainCount: 1, missingCount: 1, avgVolumeLiquidityRatio: 2.0 });
    expect(r.join(' ')).toMatch(/loseCount >= 1/);
    expect(r.join(' ')).toMatch(/drainCount >= 1/);
    expect(r.join(' ')).toMatch(/missingCount >= 1/);
    expect(r.join(' ')).toMatch(/avgVolumeLiquidityRatio >/);
  });
  it('treats avg v/l exactly at the cap as clean', () => {
    expect(historyRiskReasons({ loseCount: 0, drainCount: 0, missingCount: 0, avgVolumeLiquidityRatio: HISTORY_AVG_VLR_MAX })).toEqual([]);
  });
});

// ── Single-window report ────────────────────────────────────────────────────────────────

describe('buildDexCandidateSimReport — single window', () => {
  const sim = buildDexCandidateSimReport([FULL], { dir: 'd', fakeBankroll: 20, positionSize: 1 });

  it('counts only PASS-threshold contracts as candidates found', () => {
    expect(sim.candidatesFound).toBe(2); // SATOSHI + ELON (ONE fails vlr, MAD fails price, NOLIQ missing liq)
  });

  it('simulates clean candidates and reports fake P/L', () => {
    expect(sim.tradesSimulated).toBe(2);
    expect(sim.trades.map(t => t.contract).sort()).toEqual([SATOSHI, ELON].sort());
    expect(sim.fakeRealizedPnlDollars).toBeCloseTo(0.54 + 0.29);
    expect(sim.winRate).toBeCloseTo(1.0);
  });

  it('blocks nothing by history in a clean single window', () => {
    expect(sim.blockedByHistoryRisk).toBe(0);
    expect(sim.historyRiskBlocked).toEqual([]);
  });

  it('computes best/worst and averages', () => {
    expect(sim.bestTrade!.contract).toBe(SATOSHI);
    expect(sim.worstTrade!.contract).toBe(ELON);
    expect(sim.avgWinnerPct).toBeCloseTo((54 + 29) / 2);
    expect(sim.avgLoserPct).toBeUndefined();
  });

  it('always reports no real trading', () => {
    expect(sim.tradingExecuted).toBe(0);
    expect(sim.noRealTradeSent).toBe(true);
    expect(sim.dryRun).toBe(false);
  });

  it('keeps back-compat aliases for the paper runner', () => {
    expect(sim.candidatesPassed).toBe(sim.candidatesFound);
    expect(sim.blockedCount).toBe(sim.blockedByHistoryRisk);
    expect(sim.topBlockedReasons).toBe(sim.historyRiskBlockReasons);
  });

  it('handles an empty report set', () => {
    const empty = buildDexCandidateSimReport([], { dir: 'd' });
    expect(empty.candidatesFound).toBe(0);
    expect(empty.tradesSimulated).toBe(0);
    expect(empty.winRate).toBe(0);
    expect(empty.bestTrade).toBeUndefined();
  });
});

// ── History-risk filter (multi-run) ─────────────────────────────────────────────────────

// $1-style: 3 wins (one strong, low-churn) + 4 losses (high-churn) → loseCount + high avg v/l.
const ONE_HIST = runsOf([
  winO(ONE, '1', 34, 16, 0.8),
  winO(ONE, '1', 22, 11, 0.9),
  winO(ONE, '1', 25, 12, 0.7),
  loseO(ONE, '1', -20, -5, 3.0),
  loseO(ONE, '1', -25, -8, 3.2),
  loseO(ONE, '1', -30, -10, 3.5),
  loseO(ONE, '1', -18, -4, 3.1),
]);

// Ronaldo-style: 3 wins + 3 drains (liq <= -20) → loseCount + drainCount.
const RONALDO = 'RonaLdo66666666666666666666666666666666666666';
const RON_HIST = runsOf([
  winO(RONALDO, 'RONALDO', 40, 15, 0.5),
  winO(RONALDO, 'RONALDO', 23, 12, 0.4),
  winO(RONALDO, 'RONALDO', 28, 14, 0.6),
  loseO(RONALDO, 'RONALDO', -25, -30, 0.6),
  loseO(RONALDO, 'RONALDO', -22, -28, 0.5),
  loseO(RONALDO, 'RONALDO', -27, -35, 0.7),
]);

// BagBounty-style: wins + missing runs + a high-churn run → missingCount + high avg v/l.
const BAGBOUNTY = 'BagBnty77777777777777777777777777777777777777';
const BAG_HIST = runsOf([
  winO(BAGBOUNTY, 'BagBounty', 30, 12, 0.9),
  winO(BAGBOUNTY, 'BagBounty', 25, 11, 2.5),
  missO(BAGBOUNTY, 'BagBounty'),
  missO(BAGBOUNTY, 'BagBounty'),
]);

// Clean Satoshi-style: all wins, low churn → survives the filter.
const SAT_HIST = runsOf([
  winO(SATOSHI, 'SATOSHI', 54, 23, 0.33),
  winO(SATOSHI, 'SATOSHI', 30, 14, 0.30),
  winO(SATOSHI, 'SATOSHI', 41, 19, 0.40),
]);

const HISTORY_RUNS = [...ONE_HIST, ...RON_HIST, ...BAG_HIST, ...SAT_HIST];

describe('history-risk filter', () => {
  const sim = buildDexCandidateSimReport(HISTORY_RUNS, { dir: 'd', fakeBankroll: 20, positionSize: 1 });

  it('finds all four as candidates (each has a PASS-threshold strongest outcome)', () => {
    expect(sim.candidatesFound).toBe(4);
  });

  it('blocks $1-style W3 L4 high-churn token', () => {
    const b = sim.historyRiskBlocked.find(x => x.contract === ONE);
    expect(b).toBeDefined();
    expect(b!.loseCount).toBe(4);
    expect(b!.reasons.join(' ')).toMatch(/loseCount >= 1/);
    expect(b!.reasons.join(' ')).toMatch(/avgVolumeLiquidityRatio >/);
    expect(sim.trades.some(t => t.contract === ONE)).toBe(false);
  });

  it('blocks Ronaldo-style W3 L3 drain token', () => {
    const b = sim.historyRiskBlocked.find(x => x.contract === RONALDO);
    expect(b).toBeDefined();
    expect(b!.drainCount).toBe(3);
    expect(b!.reasons.join(' ')).toMatch(/drainCount >= 1/);
    expect(sim.trades.some(t => t.contract === RONALDO)).toBe(false);
  });

  it('blocks BagBounty-style missing / high-vl token', () => {
    const b = sim.historyRiskBlocked.find(x => x.contract === BAGBOUNTY);
    expect(b).toBeDefined();
    expect(b!.missingCount).toBe(2);
    expect(b!.reasons.join(' ')).toMatch(/missingCount >= 1/);
    expect(b!.reasons.join(' ')).toMatch(/avgVolumeLiquidityRatio >/);
    expect(sim.trades.some(t => t.contract === BAGBOUNTY)).toBe(false);
  });

  it('still passes clean Satoshi-style token', () => {
    expect(sim.trades.some(t => t.contract === SATOSHI)).toBe(true);
    expect(sim.tradesSimulated).toBe(1);
    expect(sim.blockedByHistoryRisk).toBe(3);
  });

  it('reports fake P/L only for survivors', () => {
    // Satoshi strongest is +54% → $0.54 on a $1 position.
    expect(sim.fakeRealizedPnlDollars).toBeCloseTo(0.54);
    expect(sim.winRate).toBeCloseTo(1.0);
  });

  it('ranks history-risk block reasons', () => {
    const reasons = sim.historyRiskBlockReasons.map(r => r.reason);
    expect(reasons).toContain('loseCount >= 1');
    expect(reasons).toContain('drainCount >= 1');
    expect(reasons).toContain('missingCount >= 1');
  });
});

// ── Reading saved reports ───────────────────────────────────────────────────────────────

describe('reads saved watch reports', () => {
  it('loads from disk and simulates with history filter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexsim-'));
    HISTORY_RUNS.forEach((r, i) => fs.writeFileSync(path.join(dir, `run-${i}.json`), JSON.stringify(r, null, 2), 'utf-8'));
    const reports = loadWatchReports(dir, 50);
    const sim = buildDexCandidateSimReport(reports, { dir });
    expect(sim.candidatesFound).toBe(4);
    expect(sim.blockedByHistoryRisk).toBe(3);
    expect(sim.tradesSimulated).toBe(1);
  });
});

// ── Render / safety ──────────────────────────────────────────────────────────────────────

describe('renderDexCandidateSimReport', () => {
  const out = renderDexCandidateSimReport(buildDexCandidateSimReport(HISTORY_RUNS, { dir: 'd', fakeBankroll: 20, positionSize: 1 }));

  it('shows the V2 header and read-only banner', () => {
    expect(out).toContain('TOKEN GRAB DEX CANDIDATE SIM V2');
    expect(out).toContain('READ-ONLY — NO REAL TRADE SENT');
  });
  it('includes HISTORY_RISK_BLOCK', () => {
    expect(out).toContain('HISTORY_RISK_BLOCK');
  });
  it('shows original candidates found, blocked by history risk and simulated after filter', () => {
    expect(out).toMatch(/Original candidates found/);
    expect(out).toMatch(/Blocked by history risk/);
    expect(out).toMatch(/Simulated after filter/);
  });
  it('still says PAPER SIMULATION ONLY / NO REAL TRADE SENT / tradingExecuted: 0', () => {
    expect(out).toContain('PAPER SIMULATION ONLY');
    expect(out).toContain('NO REAL TRADE SENT');
    expect(out).toContain('tradingExecuted: 0');
  });
  it('contains no trading / swap / signing terms beyond explicit negations', () => {
    expect(out).not.toMatch(/LIVE_EXECUTED/);
    expect(out).not.toMatch(/private key/i);
    expect(out).not.toMatch(/sign(ing)? transaction/i);
    for (const word of ['swap', 'wallet', 'signing']) {
      const lines = out.split('\n').filter(l => l.toLowerCase().includes(word));
      for (const l of lines) expect(l.toLowerCase()).toMatch(/no /);
    }
  });
});

describe('dexCandidateSim source safety', () => {
  it('module exposes no wallet / key / swap / signing / browser primitives', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/token-grab/dexCandidateSim.ts'), 'utf-8');
    expect(src).not.toMatch(/sendTransaction|signTransaction|privateKey|Keypair|seed phrase|wallet\.connect|jupiter\.swap|executeSwap|LIVE_EXECUTED|puppeteer|playwright|selenium/i);
  });
});
