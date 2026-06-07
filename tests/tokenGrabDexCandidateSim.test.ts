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
} from '../src/token-grab/dexCandidateSim';
import type { DexWatchCandidate } from '../src/token-grab/dexWatchCandidates';

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

const SATOSHI = 'SatoSh11111111111111111111111111111111111111';
const ELON = 'eLonBuck2222222222222222222222222222222222222';
const ONE = 'OneChurn333333333333333333333333333333333333';
const MAD = 'MadInsta44444444444444444444444444444444444444';
const NOLIQ = 'NoLiq5555555555555555555555555555555555555555';

const O_SATOSHI = outcome({ contract: SATOSHI, symbol: 'SATOSHI', classification: 'winner', priceChangePct: 54, liquidityChangePct: 23, volumeToLiquidityRatio: 0.33 });
const O_ELON = outcome({ contract: ELON, symbol: 'elonbucks', classification: 'winner', priceChangePct: 29, liquidityChangePct: 13, volumeToLiquidityRatio: 0.44 });
const O_ONE = outcome({ contract: ONE, symbol: '1', classification: 'winner', priceChangePct: 34, liquidityChangePct: 16, volumeToLiquidityRatio: 2.93 });
const O_MAD = outcome({ contract: MAD, symbol: '$MAD', classification: 'loser', priceChangePct: -30, liquidityChangePct: -25, volumeToLiquidityRatio: 0.5 });
const O_NOLIQ = outcome({ contract: NOLIQ, symbol: 'NOLIQ', classification: 'winner', priceChangePct: 40, liquidityChangePct: undefined, volumeToLiquidityRatio: 0.5 });

const FULL = report([O_SATOSHI, O_ELON, O_ONE, O_MAD, O_NOLIQ]);

// ── Reading saved reports ──────────────────────────────────────────────────────────────

describe('reads saved watch reports', () => {
  it('loads from disk and simulates from passed candidates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexsim-'));
    fs.writeFileSync(path.join(dir, 'run-0.json'), JSON.stringify(FULL, null, 2), 'utf-8');
    const reports = loadWatchReports(dir, 20);
    const sim = buildDexCandidateSimReport(reports, { dir, fakeBankroll: 20, positionSize: 1 });
    expect(sim.runsRead).toBe(1);
    expect(sim.tradesSimulated).toBe(2); // SATOSHI + ELON pass
  });
});

// ── simulateTrade unit ──────────────────────────────────────────────────────────────────

describe('simulateTrade', () => {
  it('computes fake P/L dollars and percent from position size', () => {
    const cand: DexWatchCandidate = {
      contract: SATOSHI, symbol: 'SATOSHI', chainId: 'solana',
      priceChangePct: 54, liquidityChangePct: 23, volumeLiquidityRatio: 0.33,
      loseCount: 0, drainCount: 0, status: 'PASS', label: 'DEX_PLAN_ONLY_CANDIDATE', blockReasons: [],
    };
    const t = simulateTrade(cand, 1)!;
    expect(t.pnlDollars).toBeCloseTo(0.54);
    expect(t.pnlPct).toBeCloseTo(54);
    expect(t.outcome).toBe('winner');
  });
  it('scales P/L by position size', () => {
    const cand: DexWatchCandidate = {
      contract: ELON, chainId: 'solana', priceChangePct: 29,
      liquidityChangePct: 13, volumeLiquidityRatio: 0.44,
      loseCount: 0, drainCount: 0, status: 'PASS', label: 'DEX_PLAN_ONLY_CANDIDATE', blockReasons: [],
    };
    expect(simulateTrade(cand, 5)!.pnlDollars).toBeCloseTo(1.45); // 5 * 0.29
  });
});

// ── Aggregation ─────────────────────────────────────────────────────────────────────────

describe('buildDexCandidateSimReport', () => {
  const sim = buildDexCandidateSimReport([FULL], { dir: 'd', fakeBankroll: 20, positionSize: 1 });

  it('simulates only passed candidates', () => {
    expect(sim.tradesSimulated).toBe(2);
    expect(sim.trades.map(t => t.contract).sort()).toEqual([SATOSHI, ELON].sort());
  });

  it('computes winners, losers and win rate', () => {
    expect(sim.winners).toBe(2);
    expect(sim.losers).toBe(0);
    expect(sim.winRate).toBeCloseTo(1.0);
  });

  it('computes fake realized P/L in dollars and percent', () => {
    expect(sim.fakeRealizedPnlDollars).toBeCloseTo(0.54 + 0.29); // 0.83
    expect(sim.totalDeployed).toBe(2);
    expect(sim.fakeRealizedPnlPct).toBeCloseTo((0.83 / 2) * 100); // 41.5
  });

  it('identifies best and worst fake trade', () => {
    expect(sim.bestTrade!.contract).toBe(SATOSHI);
    expect(sim.worstTrade!.contract).toBe(ELON);
  });

  it('computes average winner / average loser', () => {
    expect(sim.avgWinnerPct).toBeCloseTo((54 + 29) / 2); // 41.5
    expect(sim.avgLoserPct).toBeUndefined(); // no losers
  });

  it('reports blocked count and ranked block reasons', () => {
    expect(sim.blockedCount).toBe(3); // ONE, MAD, NOLIQ
    const reasons = sim.topBlockedReasons.map(r => r.reason);
    expect(reasons).toContain('liquidityChangePct missing');
    expect(reasons).toContain('volumeLiquidityRatio > 1.5');
    // MAD contributes two reasons (loser + drain)
    expect(sim.topBlockedReasons.find(r => r.reason.startsWith('loser count'))!.count).toBeGreaterThanOrEqual(1);
  });

  it('honors fake bankroll and position size echo', () => {
    expect(sim.fakeBankroll).toBe(20);
    expect(sim.fakePositionSize).toBe(1);
  });

  it('always reports no real trading', () => {
    expect(sim.tradingExecuted).toBe(0);
    expect(sim.noRealTradeSent).toBe(true);
    expect(sim.dryRun).toBe(false);
  });

  it('handles an empty report set', () => {
    const empty = buildDexCandidateSimReport([], { dir: 'd' });
    expect(empty.tradesSimulated).toBe(0);
    expect(empty.winRate).toBe(0);
    expect(empty.fakeRealizedPnlDollars).toBe(0);
    expect(empty.bestTrade).toBeUndefined();
  });
});

// ── normalizeBlockReason ────────────────────────────────────────────────────────────────

describe('normalizeBlockReason', () => {
  it('drops parenthetical detail so reasons group', () => {
    expect(normalizeBlockReason('loser count >= 1 (loseCount=2)')).toBe('loser count >= 1');
    expect(normalizeBlockReason('volumeLiquidityRatio > 1.5 (2.93)')).toBe('volumeLiquidityRatio > 1.5');
    expect(normalizeBlockReason('liquidityChangePct missing')).toBe('liquidityChangePct missing');
  });
});

// ── Render / safety ──────────────────────────────────────────────────────────────────────

describe('renderDexCandidateSimReport', () => {
  const out = renderDexCandidateSimReport(buildDexCandidateSimReport([FULL], { dir: 'd', fakeBankroll: 20, positionSize: 1 }));

  it('shows the V1 header and read-only banner', () => {
    expect(out).toContain('TOKEN GRAB DEX CANDIDATE SIM V1');
    expect(out).toContain('READ-ONLY — NO REAL TRADE SENT');
  });
  it('shows win rate, fake P/L, best/worst and blocked count', () => {
    expect(out).toMatch(/Win rate/);
    expect(out).toMatch(/Fake realized P\/L/);
    expect(out).toMatch(/Best fake trade/);
    expect(out).toMatch(/Worst fake trade/);
    expect(out).toMatch(/Blocked count/);
  });
  it('warns paper simulation only, no live-harness gate changed', () => {
    expect(out).toMatch(/PAPER SIMULATION ONLY/);
    expect(out).toMatch(/no live-harness gate changed/i);
  });
  it('includes tradingExecuted: 0', () => {
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
