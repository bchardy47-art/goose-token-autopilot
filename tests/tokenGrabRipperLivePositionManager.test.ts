import { describe, it, expect } from 'vitest';
import {
  evaluateExit,
  buildExitOrder,
  closePosition,
  priceOpenPositions,
  heartbeatPositions,
  DEFAULT_EXIT_POLICY,
  type ExitPolicy,
  type Pricer,
} from '../src/token-grab/ripperLivePositionManager';
import {
  MockExecutionAdapter,
  RealProviderExecutionAdapter,
  DryRunExecutionAdapter,
  parseJupiterSwapBuild,
  type FetchLike,
} from '../src/token-grab/ripperRealExecutionAdapter';
import type { OpenPosition } from '../src/token-grab/ripperRealTradingLedger';

function pos(over: Partial<OpenPosition> = {}): OpenPosition {
  return {
    contract: 'MINT1', symbol: 'AAA', runId: 'r', openedAt: '2026-06-20T11:00:00Z',
    entryPrice: 1.0, tokenAmount: 1000, intendedUsd: 25, actualUsd: 25, txSignature: 'sig', walletPublicKey: 'pub', mode: 'live',
    ...over,
  };
}
const POLICY: ExitPolicy = { ...DEFAULT_EXIT_POLICY };
const NOW = new Date('2026-06-20T11:30:00Z');

function pricing(over: Partial<import('../src/token-grab/ripperLivePositionManager').PositionPricing> = {}) {
  return { contract: 'MINT1', currentPrice: 1.0, peakPrice: 1.0, liquidityUsd: 50000, clusterRisk: 'CLEAN', pricedAt: NOW.toISOString(), stale: false, ...over };
}

describe('Live Position Manager v1', () => {
  it('triggers stop loss', () => {
    const ev = evaluateExit({ position: pos(), pricing: pricing({ currentPrice: 0.6 }), policy: POLICY, now: NOW, killSwitchOn: false });
    expect(ev.trigger).toBe('STOP_LOSS');     // -40% <= -30%
    expect(ev.shouldExit).toBe(true);
  });

  it('triggers take profit', () => {
    const ev = evaluateExit({ position: pos(), pricing: pricing({ currentPrice: 1.6, peakPrice: 1.6 }), policy: POLICY, now: NOW, killSwitchOn: false });
    expect(ev.trigger).toBe('TAKE_PROFIT');   // +60% >= +50%
  });

  it('triggers max hold', () => {
    const late = new Date('2026-06-20T13:00:00Z');  // 120m later
    const ev = evaluateExit({ position: pos(), pricing: pricing({ currentPrice: 1.05, peakPrice: 1.05 }), policy: POLICY, now: late, killSwitchOn: false });
    expect(ev.trigger).toBe('MAX_HOLD');
  });

  it('kill switch forces exit regardless of price', () => {
    const ev = evaluateExit({ position: pos(), pricing: pricing({ currentPrice: 1.1 }), policy: POLICY, now: NOW, killSwitchOn: true });
    expect(ev.trigger).toBe('KILL_SWITCH');
    expect(ev.shouldExit).toBe(true);
  });

  it('triggers trailing stop from peak', () => {
    // peak 2.0, now 1.4 → 30% drop >= 25% trail
    const ev = evaluateExit({ position: pos(), pricing: pricing({ currentPrice: 1.4, peakPrice: 2.0 }), policy: POLICY, now: NOW, killSwitchOn: false });
    expect(ev.trigger).toBe('TRAILING_STOP');
  });

  it('warns and exits on stale price', () => {
    const ev = evaluateExit({ position: pos(), pricing: pricing({ currentPrice: null, stale: true }), policy: POLICY, now: NOW, killSwitchOn: false });
    expect(ev.trigger).toBe('STALE_PRICE');
    expect(ev.warnings.length).toBeGreaterThan(0);
  });

  it('triggers liquidity collapse and cluster deterioration', () => {
    const liq = evaluateExit({ position: pos(), pricing: pricing({ liquidityUsd: 100 }), policy: POLICY, now: NOW, killSwitchOn: false });
    expect(liq.trigger).toBe('LIQUIDITY_COLLAPSE');
    const cluster = evaluateExit({ position: pos(), pricing: pricing({ clusterRisk: 'RISKY' }), policy: POLICY, now: NOW, killSwitchOn: false });
    expect(cluster.trigger).toBe('CLUSTER_RISK_DETERIORATION');
  });

  it('does not exit when no trigger met', () => {
    const ev = evaluateExit({ position: pos(), pricing: pricing({ currentPrice: 1.05, peakPrice: 1.05 }), policy: POLICY, now: NOW, killSwitchOn: false });
    expect(ev.shouldExit).toBe(false);
    expect(ev.trigger).toBe('NONE');
  });

  it('mock close (sell) succeeds; produces a synthetic signature', async () => {
    const adapter = new MockExecutionAdapter();
    const { built } = await buildExitOrder({ adapter, position: pos(), slippageBps: 150, userPublicKey: 'pub' });
    const res = await closePosition({ adapter, built, liveUnlocked: false, signer: null, rpcUrl: null });
    expect(res.submitted).toBe(true);
    expect(res.txSignature).toMatch(/^MOCK_SIG_/);
  });

  it('live sell REFUSES without unlock', async () => {
    const fetchOk: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ swapTransaction: 'TX', lastValidBlockHeight: 1 }), text: async () => '' });
    const adapter = new RealProviderExecutionAdapter({ fetchFn: fetchOk, rpcUrl: 'https://rpc' });
    const built = parseJupiterSwapBuild({ swapTransaction: 'TX', lastValidBlockHeight: 1 }, 'q');
    await expect(closePosition({ adapter, built, liveUnlocked: false, signer: null, rpcUrl: 'https://rpc' }))
      .rejects.toMatchObject({ code: 'SUBMIT_BLOCKED_NOT_UNLOCKED' });
  });

  it('dry-run sell never submits', async () => {
    const fetchOk: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ inAmount: '1', outAmount: '2', inputMint: 'x', outputMint: 'y', routePlan: [{ swapInfo: { label: 'AMM' } }] }), text: async () => '' });
    const real = new RealProviderExecutionAdapter({ fetchFn: fetchOk, rpcUrl: 'https://rpc' });
    const adapter = new DryRunExecutionAdapter(real);
    const built = parseJupiterSwapBuild({ swapTransaction: 'TX', lastValidBlockHeight: 1 }, 'q');
    const res = await closePosition({ adapter, built, liveUnlocked: true, signer: { publicKey: 'p', async signTransactionBase64(u) { return u; } }, rpcUrl: 'https://rpc' });
    expect(res.submitted).toBe(false);
  });

  it('prices positions and tracks peak; heartbeat flags exits', async () => {
    const pricer: Pricer = { async price() { return { price: 1.5, liquidityUsd: 40000, clusterRisk: 'CLEAN' }; } };
    const peaks = new Map<string, number>();
    const pricings = await priceOpenPositions([pos()], pricer, NOW, peaks);
    expect(pricings[0].currentPrice).toBe(1.5);
    expect(peaks.get('MINT1')).toBe(1.5);
    const hb = heartbeatPositions([pos()], pricings, POLICY, NOW, false);
    expect(hb[0].trigger).toBe('TAKE_PROFIT');  // +50% exactly at threshold
  });

  it('recovers exit ledger reason field through closePosition flow (mock)', async () => {
    const adapter = new MockExecutionAdapter();
    const { built } = await buildExitOrder({ adapter, position: pos(), slippageBps: 100, userPublicKey: 'pub' });
    const res = await closePosition({ adapter, built, liveUnlocked: false, signer: null, rpcUrl: null });
    expect(res.reason).toMatch(/MOCK/);
  });
});
