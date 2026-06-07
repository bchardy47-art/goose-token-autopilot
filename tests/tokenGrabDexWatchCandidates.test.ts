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
  buildDexWatchCandidatesReport,
  renderDexWatchCandidatesReport,
  evaluateRollup,
  rankCandidates,
  type DexWatchCandidate,
  PASS_PRICE_PCT,
  PASS_LIQ_PCT,
  PASS_VLR_MAX,
  BLOCK_VLR_MAX,
} from '../src/token-grab/dexWatchCandidates';

// ── Fixtures ────────────────────────────────────────────────────────────────────────

function outcome(over: Partial<DexWatchOutcome> & Pick<DexWatchOutcome, 'contract' | 'classification'>): DexWatchOutcome {
  return {
    signalId: `sig-${over.contract}`,
    chainId: 'solana',
    ...over,
  };
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

// PASS — Satoshi-style: price +54, liq +23, v/l 0.33
const O_SATOSHI = outcome({ contract: SATOSHI, symbol: 'SATOSHI', classification: 'winner', priceChangePct: 54, liquidityChangePct: 23, volumeToLiquidityRatio: 0.33 });
// PASS — elonbucks-style: price +29, liq +13, v/l 0.44
const O_ELON = outcome({ contract: ELON, symbol: 'elonbucks', classification: 'winner', priceChangePct: 29, liquidityChangePct: 13, volumeToLiquidityRatio: 0.44 });
// BLOCK — $1-style churn: price +34, liq +16, v/l 2.93 (churn over BLOCK_VLR_MAX)
const O_ONE = outcome({ contract: ONE, symbol: '1', classification: 'winner', priceChangePct: 34, liquidityChangePct: 16, volumeToLiquidityRatio: 2.93 });
// BLOCK — $$MAD-style instability: a losing/draining run
const O_MAD = outcome({ contract: MAD, symbol: '$MAD', classification: 'loser', priceChangePct: -30, liquidityChangePct: -25, volumeToLiquidityRatio: 0.5 });
// BLOCK — missing liquidity
const O_NOLIQ = outcome({ contract: NOLIQ, symbol: 'NOLIQ', classification: 'winner', priceChangePct: 40, liquidityChangePct: undefined, volumeToLiquidityRatio: 0.5 });

const FULL = report([O_SATOSHI, O_ELON, O_ONE, O_MAD, O_NOLIQ]);

// ── Loading ────────────────────────────────────────────────────────────────────────────

describe('reads saved watch reports', () => {
  it('loads reports written to disk and feeds the candidate builder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexcand-'));
    fs.writeFileSync(path.join(dir, 'run-0.json'), JSON.stringify(FULL, null, 2), 'utf-8');
    const reports = loadWatchReports(dir, 20);
    expect(reports).toHaveLength(1);
    const out = buildDexWatchCandidatesReport(reports, dir);
    expect(out.runsRead).toBe(1);
    expect(out.outcomesScanned).toBe(5);
    expect(out.contractsEvaluated).toBe(5);
  });
});

// ── PASS cases ────────────────────────────────────────────────────────────────────────

describe('PASS candidates', () => {
  it('passes Satoshi-style candidate (price +54, liq +23, v/l 0.33)', () => {
    const out = buildDexWatchCandidatesReport([report([O_SATOSHI])]);
    expect(out.passedCount).toBe(1);
    const c = out.passed[0];
    expect(c.contract).toBe(SATOSHI);
    expect(c.status).toBe('PASS');
    expect(c.label).toBe('DEX_PLAN_ONLY_CANDIDATE');
  });

  it('passes elonbucks-style candidate (price +29, liq +13, v/l 0.44)', () => {
    const out = buildDexWatchCandidatesReport([report([O_ELON])]);
    expect(out.passedCount).toBe(1);
    expect(out.passed[0].contract).toBe(ELON);
    expect(out.passed[0].label).toBe('DEX_PLAN_ONLY_CANDIDATE');
  });
});

// ── BLOCK cases ───────────────────────────────────────────────────────────────────────

describe('BLOCK candidates', () => {
  it('blocks $1-style churn (price +34, liq +16, v/l 2.93)', () => {
    const out = buildDexWatchCandidatesReport([report([O_ONE])]);
    expect(out.passedCount).toBe(0);
    expect(out.blockedCount).toBe(1);
    const c = out.blocked[0];
    expect(c.contract).toBe(ONE);
    expect(c.blockReasons.join(' ')).toMatch(/volumeLiquidityRatio >/);
  });

  it('blocks $$MAD-style instability (loss / drain count)', () => {
    const out = buildDexWatchCandidatesReport([report([O_MAD])]);
    expect(out.blockedCount).toBe(1);
    const reasons = out.blocked[0].blockReasons.join(' ');
    expect(reasons).toMatch(/loser count/);
    expect(reasons).toMatch(/drain count/);
  });

  it('blocks missing liquidity', () => {
    const out = buildDexWatchCandidatesReport([report([O_NOLIQ])]);
    expect(out.blockedCount).toBe(1);
    expect(out.blocked[0].blockReasons.join(' ')).toMatch(/liquidityChangePct missing/);
  });

  it('blocks a strong winner if it also lost in another run (instability over a single good move)', () => {
    const win = outcome({ contract: MAD, symbol: '$MAD', classification: 'winner', priceChangePct: 54, liquidityChangePct: 23, volumeToLiquidityRatio: 0.3 });
    const out = buildDexWatchCandidatesReport([report([win]), report([O_MAD])]);
    expect(out.passedCount).toBe(0);
    expect(out.blockedCount).toBe(1);
  });
});

// ── Ranking ───────────────────────────────────────────────────────────────────────────

describe('ranking', () => {
  it('ranks by price, then liquidity, then lowest v/l', () => {
    const out = buildDexWatchCandidatesReport([report([O_SATOSHI, O_ELON])]);
    expect(out.passed.map(c => c.contract)).toEqual([SATOSHI, ELON]); // 54 > 29
  });

  it('breaks price ties by higher liquidity then lower v/l', () => {
    const a = outcome({ contract: 'AAA11111111111111111111111111111111111111111', symbol: 'A', classification: 'winner', priceChangePct: 30, liquidityChangePct: 20, volumeToLiquidityRatio: 0.9 });
    const b = outcome({ contract: 'BBB22222222222222222222222222222222222222222', symbol: 'B', classification: 'winner', priceChangePct: 30, liquidityChangePct: 25, volumeToLiquidityRatio: 0.9 });
    const c = outcome({ contract: 'CCC33333333333333333333333333333333333333333', symbol: 'C', classification: 'winner', priceChangePct: 30, liquidityChangePct: 25, volumeToLiquidityRatio: 0.2 });
    const ranked = rankCandidates([a, b, c].map(o => evaluateRollup({
      contract: o.contract, symbol: o.symbol, chainId: 'solana', pairUrl: undefined,
      outcomes: [o], loseCount: 0, drainCount: 0, strongest: o,
    } as any)));
    expect(ranked.map(r => r.symbol)).toEqual(['C', 'B', 'A']);
  });
});

// ── Full report ───────────────────────────────────────────────────────────────────────

describe('full candidates report', () => {
  it('separates passed and blocked across a mixed run', () => {
    const out = buildDexWatchCandidatesReport([FULL], 'data/token-grab/dex-watch-runs');
    expect(out.passed.map(c => c.contract)).toEqual([SATOSHI, ELON]);
    expect(out.blocked.map(c => c.contract).sort()).toEqual([ONE, MAD, NOLIQ].sort());
    expect(out.tradingExecuted).toBe(0);
    expect(out.noRealTradeSent).toBe(true);
  });
});

// ── Render / safety ────────────────────────────────────────────────────────────────────

describe('renderDexWatchCandidatesReport', () => {
  const out = renderDexWatchCandidatesReport(buildDexWatchCandidatesReport([FULL], 'data/token-grab/dex-watch-runs'));

  it('includes DEX_PLAN_ONLY_CANDIDATE', () => {
    expect(out).toContain('DEX_PLAN_ONLY_CANDIDATE');
  });
  it('includes NO REAL TRADE SENT', () => {
    expect(out).toContain('NO REAL TRADE SENT');
  });
  it('includes tradingExecuted: 0', () => {
    expect(out).toContain('tradingExecuted: 0');
  });
  it('states observational-only and no live-harness gate changed', () => {
    expect(out).toMatch(/observational only/);
    expect(out).toMatch(/No live-harness gate changed/);
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

describe('dexWatchCandidates source safety', () => {
  it('module exposes no wallet / key / swap / signing / browser primitives', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/token-grab/dexWatchCandidates.ts'), 'utf-8');
    expect(src).not.toMatch(/sendTransaction|signTransaction|privateKey|Keypair|seed phrase|secret|wallet\.connect|jupiter\.swap|executeSwap|LIVE_EXECUTED|puppeteer|playwright|selenium/i);
  });
});

// ── Threshold sanity ────────────────────────────────────────────────────────────────────

describe('thresholds', () => {
  it('match the spec', () => {
    expect(PASS_PRICE_PCT).toBe(20);
    expect(PASS_LIQ_PCT).toBe(10);
    expect(PASS_VLR_MAX).toBe(1.0);
    expect(BLOCK_VLR_MAX).toBe(1.5);
  });
});
