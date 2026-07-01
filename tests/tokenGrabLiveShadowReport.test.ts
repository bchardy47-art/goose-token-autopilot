import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runLiveShadowCycle } from '../src/token-grab/liveShadow';
import { runLiveShadowReport, renderLiveShadowReport } from '../src/token-grab/liveShadowReport';

const NOW_MS = new Date('2026-06-10T12:00:00Z').getTime();

interface FixtureCandidate {
  contract: string;
  symbol?: string;
  observedAt?: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
}

function writeFeed(dir: string, candidates: FixtureCandidate[]): string {
  const filePath = path.join(dir, 'feed.json');
  const report = {
    generatedAt: new Date(NOW_MS).toISOString(),
    candidateCount: candidates.length,
    candidates: candidates.map(c => ({
      tier: 'WATCH',
      contract: c.contract,
      symbol: c.symbol ?? 'TEST',
      observedAt: c.observedAt ?? new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
      priceChangePct: c.priceChangePct ?? 35,
      liquidityChangePct: c.liquidityChangePct ?? 10,
      volumeLiquidityRatio: c.volumeLiquidityRatio ?? 0.6,
      confidence: 'MEDIUM',
      reasons: [],
      missingSafetySignals: [],
    })),
  };
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-shadow-report-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true });
});

describe('runLiveShadowReport', () => {
  it('is always READY_FOR_REAL_TRADING=false, even with no data', () => {
    const dir = tmpDir();
    const report = runLiveShadowReport({
      eventsPath: path.join(dir, 'missing-events.jsonl'),
      statePath: path.join(dir, 'missing-state.json'),
      nowMs: NOW_MS,
    });
    expect(report.readyForRealTrading).toBe(false);
    expect(report.totalWouldBuyEvents).toBe(0);
    expect(report.totalWouldSellEvents).toBe(0);
    expect(report.liveShadowOnly).toBe(true);
    expect(report.realTrading).toBe(false);
  });

  it('reflects buys, sells, win/loss, P/L, drawdown, and best/worst trade after a cycle', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');
    const contract = 'ReportToken1111111111111111111111111111111';

    const feed1 = writeFeed(dir, [{ contract }]);
    runLiveShadowCycle({ feedPath: feed1, statePath, eventsPath, nowMs: NOW_MS });

    // Take profit next cycle (well above the +40% take-profit threshold). The cycle also
    // advances past the prime window so the same contract is not immediately re-bought
    // after the exit closes it.
    const feed2 = writeFeed(dir, [{ contract, priceChangePct: 120 }]);
    runLiveShadowCycle({ feedPath: feed2, statePath, eventsPath, nowMs: NOW_MS + 25 * 60_000 });

    const report = runLiveShadowReport({ eventsPath, statePath, nowMs: NOW_MS + 6 * 60_000 });

    expect(report.totalWouldBuyEvents).toBe(3);  // one per bankroll tier
    expect(report.totalWouldSellEvents).toBe(3);

    for (const b of report.bankrolls) {
      expect(b.wins).toBe(1);
      expect(b.losses).toBe(0);
      expect(b.winRate).toBe(1);
      expect(b.redLossRate).toBe(0);
      expect(b.simulatedPnlUsd).toBeGreaterThan(0);
      expect(b.bestTrade).not.toBeNull();
      expect(b.worstTrade).not.toBeNull();
      expect(b.bestTrade!.contract).toBe(contract);
      expect(b.maxDrawdownUsd).toBe(0); // equity only ever rose
    }
  });

  it('reports risk-limit violations and kill-switch status per bankroll', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');
    const feedPath = writeFeed(dir, [
      { contract: 'RLToken1111111111111111111111111111111111' },
      { contract: 'RLToken2222222222222222222222222222222222' },
      { contract: 'RLToken3333333333333333333333333333333333' },
    ]);
    runLiveShadowCycle({ feedPath, statePath, eventsPath, nowMs: NOW_MS });

    const report = runLiveShadowReport({ eventsPath, statePath, nowMs: NOW_MS });
    const b20 = report.bankrolls.find(b => b.bankroll === 20)!;
    expect(b20.riskLimitViolations).toBeGreaterThan(0);
    expect(b20.openPositionCap).toBe(2);
    expect(b20.maxDailyBuys).toBeGreaterThan(0);
    expect(b20.maxDailyLossUsd).toBeGreaterThan(0);
    expect(b20.maxPositionSizeUsd).toBeGreaterThan(0);
    expect(typeof b20.killSwitchActive).toBe('boolean');
  });
});

describe('renderLiveShadowReport', () => {
  it('always states READY_FOR_REAL_TRADING=false and the safety banner', () => {
    const dir = tmpDir();
    const report = runLiveShadowReport({
      eventsPath: path.join(dir, 'events.jsonl'),
      statePath: path.join(dir, 'state.json'),
      nowMs: NOW_MS,
    });
    const text = renderLiveShadowReport(report);
    expect(text).toContain('READY_FOR_REAL_TRADING=false');
    expect(text).toContain('LIVE_SHADOW_ONLY=true');
    expect(text).toContain('REAL_TRADING=false');
    expect(text).toContain('NO_WALLET=true');
    expect(text).toContain('NO_SWAP=true');
    expect(text).toContain('NO_SIGNING=true');
    expect(text).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });
});

// ── Static safety guard ───────────────────────────────────────────────────────────────────

describe('liveShadowReport module introduces no unsafe behavior', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/token-grab/liveShadowReport.ts'), 'utf-8');
  it('no token:auto-paper', () => { expect(src).not.toContain('token:auto-paper'); });
  it('no token:paper-buy', () => { expect(src).not.toContain('token:paper-buy'); });
  it('no --live flag', () => { expect(src).not.toContain('--live'); });
  it('no wallet signing / swap / private key handling', () => {
    expect(src).not.toMatch(/signTransaction|walletSign|keypair|privateKey|secretKey|swapExecute|executeSwap|sendTransaction|Keypair\.|Connection\(/i);
  });
  it('report is read-only — never writes files', () => {
    expect(src).not.toContain('writeFileSync');
    expect(src).not.toContain('appendFileSync');
  });
});
