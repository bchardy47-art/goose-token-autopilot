import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runLiveShadowCycle } from '../src/token-grab/liveShadow';
import { runLiveShadowReport, renderLiveShadowReport } from '../src/token-grab/liveShadowReport';

const NOW_MS = new Date('2026-07-01T12:00:00Z').getTime();
const nowIso = new Date(NOW_MS).toISOString();

// ── Cycle fixtures (fresh ripper cycle rows) ────────────────────────────────────────────────

function cycleRow(contract: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  const m5 = (o.entryMomentumPct as number) ?? -10;
  const captured = (o.capturedAt as string) ?? nowIso;
  return {
    capturedAt: captured,
    ripperScore: (o.ripperScore as number) ?? 70,
    launchAgeBucket: (o.launchAgeBucket as string) ?? 'PRIME_WINDOW',
    buyGateDecision: 'BUY_REJECTED',
    entryDecision: 'READY_TO_SNIPE_PAPER',
    entryMomentumPct: m5,
    topReasons: [],
    ripperInput: { contract, clusterRisk: 'UNKNOWN' },
    normalizedSignal: {
      contract, symbol: contract.slice(0, 4),
      liquidityUsd: 20_000, volumeLiquidityRatio: 0.6,
      priceChangePct: (o.priceChangePct as number) ?? 35, liquidityChangePct: 10,
      entryPriceChangeM5: m5, observedAt: captured,
    },
  };
}
function writeCycle(cyclesDir: string, slug: string, rows: Record<string, unknown>[]): void {
  fs.mkdirSync(cyclesDir, { recursive: true });
  fs.writeFileSync(path.join(cyclesDir, `cycle-${slug}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

const dirs: string[] = [];
function tmpDir(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-shadow-report-')); dirs.push(dir); return dir; }
function cyclesDirIn(base: string): string { const d = path.join(base, 'cycles'); fs.mkdirSync(d, { recursive: true }); return d; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

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

  it('reflects buys, sells, win/loss, P/L, drawdown, and best/worst after a lane-driven cycle', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');
    const contract = 'ReportToken1111111111111111111111111111111';

    writeCycle(cyclesDir, '2026-07-01-115500', [cycleRow(contract, { priceChangePct: 35 })]);
    runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: NOW_MS });

    // Next cycle: same contract takes profit (price 120). Score below floor so it is NOT re-bought
    // after the exit closes it — exit uses the price snapshot, entry uses the shadow lanes.
    const t2 = NOW_MS + 5 * 60_000;
    writeCycle(cyclesDir, '2026-07-01-116000', [cycleRow(contract, { priceChangePct: 120, ripperScore: 40, capturedAt: new Date(t2).toISOString() })]);
    runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: t2 });

    const report = runLiveShadowReport({ eventsPath, statePath, nowMs: t2 + 60_000 });
    expect(report.totalWouldBuyEvents).toBe(3);
    expect(report.totalWouldSellEvents).toBe(3);

    for (const b of report.bankrolls) {
      expect(b.wins).toBe(1);
      expect(b.losses).toBe(0);
      expect(b.winRate).toBe(1);
      expect(b.redLossRate).toBe(0);
      expect(b.simulatedPnlUsd).toBeGreaterThan(0);
      expect(b.bestTrade).not.toBeNull();
      expect(b.bestTrade!.contract).toBe(contract);
      expect(b.maxDrawdownUsd).toBe(0);
    }
  });

  it('reports risk-limit violations and kill-switch status per bankroll', () => {
    const dir = tmpDir();
    const cyclesDir = cyclesDirIn(dir);
    const statePath = path.join(dir, 'state.json');
    const eventsPath = path.join(dir, 'events.jsonl');
    writeCycle(cyclesDir, '2026-07-01-115500', [
      cycleRow('RLToken1111111111111111111111111111111111'),
      cycleRow('RLToken2222222222222222222222222222222222'),
      cycleRow('RLToken3333333333333333333333333333333333'),
    ]);
    runLiveShadowCycle({ cyclesDir, statePath, eventsPath, nowMs: NOW_MS });

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
