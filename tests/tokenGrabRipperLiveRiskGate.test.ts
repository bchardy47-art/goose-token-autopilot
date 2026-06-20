import { describe, it, expect } from 'vitest';
import { evaluateLiveRiskGate, type RiskGateInput, type RiskCandidate } from '../src/token-grab/ripperLiveRiskGate';
import { resolveLiveTradingConfig, CONFIRM_PHRASE, ENV } from '../src/token-grab/ripperLiveTradingConfig';
import type { OpenPosition } from '../src/token-grab/ripperRealTradingLedger';

function unlockedConfig() {
  return resolveLiveTradingConfig({ env: {
    [ENV.ENABLED]: '1', [ENV.CONFIRM]: CONFIRM_PHRASE, [ENV.KILL_SWITCH]: '0',
    [ENV.MAX_POSITION]: '50', [ENV.MAX_DAILY_LOSS]: '100', [ENV.MAX_OPEN]: '3',
    [ENV.MAX_TRADES]: '10', [ENV.MAX_SLIPPAGE]: '150', [ENV.MIN_LIQUIDITY]: '20000',
    [ENV.RPC_URL]: 'https://rpc', [ENV.WALLET_PUBKEY]: '7vWf8YxkqTfQ1xH2bN3cD4eF5gH6jK7mN8pQ9rS1tUv',
    [ENV.SWAP_PROVIDER]: 'jupiter',
  } });
}

function candidate(over: Partial<RiskCandidate> = {}): RiskCandidate {
  return {
    contract: 'MINT1', symbol: 'AAA', buyGateDecision: 'BUY_APPROVED_PAPER',
    clusterRisk: 'CLEAN', liquidityUsd: 50000, entryMomentumPct: 0,
    expectedBaselinePnl: 60, liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5',
    ...over,
  };
}

function baseInput(over: Partial<RiskGateInput> = {}): RiskGateInput {
  return {
    candidate: candidate(), intendedUsd: 25, mode: 'dry-run', config: unlockedConfig(),
    openPositions: [], tradesToday: 0, dailyLoss: 0,
    latestCycleTime: '2026-06-20T11:55:00Z', now: new Date('2026-06-20T12:00:00Z'),
    ...over,
  };
}

describe('Live Risk Gate v1', () => {
  it('allows a valid dry-run candidate', () => {
    const r = evaluateLiveRiskGate(baseInput());
    expect(r.allow).toBe(true);
    expect(r.blockReasons).toHaveLength(0);
  });

  it('blocks UNKNOWN cluster (never CLEAN) unless override', () => {
    const blocked = evaluateLiveRiskGate(baseInput({ candidate: candidate({ clusterRisk: 'UNKNOWN' }) }));
    expect(blocked.allow).toBe(false);
    expect(blocked.blockReasons.join(' ')).toMatch(/UNKNOWN/);

    const overridden = evaluateLiveRiskGate(baseInput({
      candidate: candidate({ clusterRisk: 'UNKNOWN' }), allowUnknownClusterOverride: true,
    }));
    expect(overridden.allow).toBe(true);
    expect(overridden.warnings.join(' ')).toMatch(/UNKNOWN/);
  });

  it('blocks negative execution-adjusted edge', () => {
    // tiny baseline on thin liquidity → adjusted edge negative
    const r = evaluateLiveRiskGate(baseInput({ candidate: candidate({ expectedBaselinePnl: 1, liquidityBucket: 'LIQ_LT_10K' }) }));
    expect(r.allow).toBe(false);
    expect(r.blockReasons.join(' ')).toMatch(/adjusted edge is negative/i);
  });

  it('blocks when intended size exceeds max position', () => {
    const r = evaluateLiveRiskGate(baseInput({ intendedUsd: 999 }));
    expect(r.allow).toBe(false);
    expect(r.blockReasons.join(' ')).toMatch(/exceeds max position/);
  });

  it('blocks when daily loss limit reached', () => {
    const r = evaluateLiveRiskGate(baseInput({ dailyLoss: 100 }));
    expect(r.allow).toBe(false);
    expect(r.blockReasons.join(' ')).toMatch(/daily loss/i);
  });

  it('blocks a stale feed', () => {
    const r = evaluateLiveRiskGate(baseInput({ latestCycleTime: '2026-06-20T10:00:00Z' }));  // 120m old
    expect(r.allow).toBe(false);
    expect(r.blockReasons.join(' ')).toMatch(/stale/i);
  });

  it('blocks a duplicate open position', () => {
    const open: OpenPosition[] = [{
      contract: 'MINT1', symbol: 'AAA', runId: 'r', openedAt: '2026-06-20T11:00:00Z',
      entryPrice: 1, tokenAmount: 100, intendedUsd: 25, actualUsd: 25, txSignature: null, walletPublicKey: null, mode: 'live',
    }];
    const r = evaluateLiveRiskGate(baseInput({ openPositions: open }));
    expect(r.allow).toBe(false);
    expect(r.blockReasons.join(' ')).toMatch(/Duplicate open position/);
  });

  it('blocks max open positions reached', () => {
    const open: OpenPosition[] = Array.from({ length: 3 }, (_, i) => ({
      contract: `OTHER${i}`, symbol: null, runId: 'r', openedAt: '2026-06-20T11:00:00Z',
      entryPrice: 1, tokenAmount: 100, intendedUsd: 25, actualUsd: 25, txSignature: null, walletPublicKey: null, mode: 'live',
    }));
    const r = evaluateLiveRiskGate(baseInput({ openPositions: open }));
    expect(r.allow).toBe(false);
    expect(r.blockReasons.join(' ')).toMatch(/Max open positions/);
  });

  it('blocks below-min liquidity and unknown liquidity', () => {
    const low = evaluateLiveRiskGate(baseInput({ candidate: candidate({ liquidityUsd: 100 }) }));
    expect(low.allow).toBe(false);
    const unknownLiq = evaluateLiveRiskGate(baseInput({ candidate: candidate({ liquidityUsd: null }) }));
    expect(unknownLiq.allow).toBe(false);
  });

  it('refuses live mode without unlock', () => {
    const lockedCfg = resolveLiveTradingConfig({ env: {} });
    const r = evaluateLiveRiskGate(baseInput({ mode: 'live', config: lockedCfg }));
    expect(r.allow).toBe(false);
    expect(r.blockReasons.join(' ')).toMatch(/Live mode requires/);
  });

  it('blocks non-approved candidate', () => {
    const r = evaluateLiveRiskGate(baseInput({ candidate: candidate({ buyGateDecision: 'BUY_REJECTED' }) }));
    expect(r.allow).toBe(false);
    expect(r.blockReasons.join(' ')).toMatch(/not currently approved/);
  });

  it('produces a risk snapshot', () => {
    const r = evaluateLiveRiskGate(baseInput());
    expect(r.riskSnapshot.contract).toBe('MINT1');
    expect(r.riskSnapshot.adjustedEdge).not.toBeNull();
    expect(r.riskSnapshot.maxPositionUsd).toBe(50);
  });
});
