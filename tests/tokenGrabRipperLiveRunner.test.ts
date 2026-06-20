import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { runLiveRunner, type LiveRunnerOptions } from '../src/token-grab/ripperLiveRunner';
import { resolveLiveTradingConfig, CONFIRM_PHRASE, ENV } from '../src/token-grab/ripperLiveTradingConfig';
import { readLedger, appendLedgerEvent } from '../src/token-grab/ripperRealTradingLedger';
import { MockExecutionAdapter, RealProviderExecutionAdapter, createExecutionAdapter, type FetchLike } from '../src/token-grab/ripperRealExecutionAdapter';
import type { RiskCandidate } from '../src/token-grab/ripperLiveRiskGate';
import type { Pricer } from '../src/token-grab/ripperLivePositionManager';

let root: string;
let ledgerPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lrun-test-'));
  ledgerPath = path.join(root, 'real-trading-ledger.jsonl');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const NOW = new Date('2026-06-20T12:00:00Z');

function unlockedEnv() {
  return {
    [ENV.ENABLED]: '1', [ENV.CONFIRM]: CONFIRM_PHRASE, [ENV.KILL_SWITCH]: '0',
    [ENV.MAX_POSITION]: '50', [ENV.MAX_DAILY_LOSS]: '100', [ENV.MAX_OPEN]: '3',
    [ENV.MAX_TRADES]: '10', [ENV.MAX_SLIPPAGE]: '150', [ENV.MIN_LIQUIDITY]: '20000',
    [ENV.RPC_URL]: 'https://rpc', [ENV.WALLET_PUBKEY]: '7vWf8YxkqTfQ1xH2bN3cD4eF5gH6jK7mN8pQ9rS1tUv',
    [ENV.SWAP_PROVIDER]: 'jupiter',
  };
}

// A clean, gate-passing candidate (CLEAN cluster, deep liquidity, positive edge).
function goodCandidate(over: Partial<RiskCandidate> = {}): RiskCandidate {
  return {
    contract: 'GOODMINT', symbol: 'GOOD', buyGateDecision: 'BUY_APPROVED_PAPER',
    clusterRisk: 'CLEAN', liquidityUsd: 60000, entryMomentumPct: 5,
    expectedBaselinePnl: 80, liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5',
    capturedAt: '2026-06-20T11:58:00Z', ...over,
  };
}

// Default injected fetch so dry-run/live quote calls never hit the network in tests.
const QUOTE_STUB: FetchLike = async (url) => {
  const body = url.includes('/swap')
    ? { swapTransaction: 'TX', lastValidBlockHeight: 1 }
    : { inputMint: 'So11111111111111111111111111111111111111112', inAmount: '1000', outputMint: 'GOODMINT', outAmount: '2000', routePlan: [{ swapInfo: { label: 'AMM' } }], slippageBps: 150 };
  return { ok: true, status: 200, json: async () => body, text: async () => '' };
};

function base(over: Partial<LiveRunnerOptions> = {}): LiveRunnerOptions {
  return {
    ledgerPath, now: NOW, latestCycleTime: '2026-06-20T11:58:00Z',
    loadCandidates: () => [goodCandidate()],
    fetchFn: QUOTE_STUB,
    // Point the cluster resolver at the (empty) tmp dir so it reads no real files —
    // deterministic: lookups return null, so raw cluster is preserved unchanged.
    cachePath: path.join(root, 'bubblemaps-cache.jsonl'),
    memoryPath: path.join(root, 'learning-memory.jsonl'),
    ...over,
  };
}

describe('Live Runner v1', () => {
  it('dry-run completes and plans a buy without submitting', async () => {
    const r = await runLiveRunner(base({ mode: 'dry-run', env: {} }));
    expect(r.blocked).toBe(false);
    expect(r.mode).toBe('dry-run');
    const passed = r.candidateOutcomes.find(c => c.contract === 'GOODMINT')!;
    expect(passed.gatePassed).toBe(true);
    expect(passed.action).toBe('PLANNED_BUY');
    // ledger has a planned buy but NO confirmed buy / opened position
    const events = readLedger(ledgerPath);
    expect(events.some(e => e.type === 'LIVE_BUY_SUBMITTED')).toBe(true);
    expect(events.some(e => e.type === 'LIVE_BUY_CONFIRMED')).toBe(false);
    expect(events.some(e => e.type === 'LIVE_POSITION_OPENED')).toBe(false);
  });

  it('mock runner opens a position', async () => {
    const r = await runLiveRunner(base({ mode: 'mock', env: {}, adapter: new MockExecutionAdapter() }));
    const passed = r.candidateOutcomes.find(c => c.contract === 'GOODMINT')!;
    expect(passed.action).toBe('MOCK_BUY');
    expect(passed.txSignature).toMatch(/^MOCK_SIG_/);
    const events = readLedger(ledgerPath);
    expect(events.some(e => e.type === 'LIVE_POSITION_OPENED')).toBe(true);
  });

  it('live runner refuses without unlock (blocked run, no submit)', async () => {
    const fetchOk: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    const r = await runLiveRunner(base({ mode: 'live', env: {}, fetchFn: fetchOk }));
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/not unlocked/i);
    const events = readLedger(ledgerPath);
    expect(events.some(e => e.type === 'LIVE_RUN_BLOCKED')).toBe(true);
    expect(events.some(e => e.type === 'LIVE_BUY_CONFIRMED')).toBe(false);
  });

  it('live runner with unlock but no signer refuses at submit (no position opened)', async () => {
    // Real provider quote + build succeed; submit must refuse (no signer).
    const fetchFn: FetchLike = async (url) => {
      const body = url.includes('/swap')
        ? { swapTransaction: 'TX', lastValidBlockHeight: 1 }
        : { inputMint: 'So11111111111111111111111111111111111111112', inAmount: '1000', outputMint: 'GOODMINT', outAmount: '2000', routePlan: [{ swapInfo: { label: 'AMM' } }], slippageBps: 150 };
      return { ok: true, status: 200, json: async () => body, text: async () => '' };
    };
    const cfg = resolveLiveTradingConfig({ env: unlockedEnv(), modeOverride: 'live' });
    const adapter = new RealProviderExecutionAdapter({ fetchFn, rpcUrl: 'https://rpc' });
    const r = await runLiveRunner(base({ mode: 'live', env: unlockedEnv(), config: cfg, adapter, signer: null }));
    expect(r.blocked).toBe(false);                  // run proceeds (unlocked)
    const events = readLedger(ledgerPath);
    expect(events.some(e => e.type === 'LIVE_BUY_CONFIRMED')).toBe(false);   // submit refused → no confirm
    expect(events.some(e => e.type === 'LIVE_BUY_FAILED')).toBe(true);
    const outcome = r.candidateOutcomes.find(c => c.contract === 'GOODMINT')!;
    expect(outcome.action).toBe('BLOCKED');
  });

  it('runs exits BEFORE entries', async () => {
    // Seed an open position that should hit take-profit; mock adapter executes the sell.
    appendLedgerEvent({ type: 'LIVE_POSITION_OPENED', runId: 'prev', mode: 'mock', contract: 'OPENPOS', symbol: 'OP', entryPrice: 1, tokenAmount: 1000, actualUsd: 25 }, ledgerPath, { now: () => new Date('2026-06-20T11:00:00Z') });
    const pricer: Pricer = { async price() { return { price: 2.0, liquidityUsd: 50000, clusterRisk: 'CLEAN' }; } };
    const r = await runLiveRunner(base({ mode: 'mock', env: {}, adapter: new MockExecutionAdapter(), pricer }));
    expect(r.exitsEvaluated.some(e => e.contract === 'OPENPOS' && e.action === 'MOCK_SELL')).toBe(true);
    const events = readLedger(ledgerPath);
    const exitIdx = events.findIndex(e => e.type === 'LIVE_EXIT_SIGNAL');
    const entryIdx = events.findIndex(e => e.type === 'LIVE_ENTRY_SIGNAL');
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeLessThan(entryIdx);     // exit processed before entry
  });

  it('honors max-candidates', async () => {
    const cands = Array.from({ length: 5 }, (_, i) => goodCandidate({ contract: `M${i}` }));
    const r = await runLiveRunner(base({ mode: 'dry-run', env: {}, loadCandidates: () => cands, maxCandidates: 2 }));
    expect(r.candidatesConsidered).toBe(2);
    expect(r.candidateOutcomes).toHaveLength(2);
  });

  it('blocks UNKNOWN-cluster candidates (real data shape) at the gate', async () => {
    const r = await runLiveRunner(base({ mode: 'dry-run', env: {}, loadCandidates: () => [goodCandidate({ clusterRisk: 'UNKNOWN' })] }));
    const outcome = r.candidateOutcomes[0];
    expect(outcome.gatePassed).toBe(false);
    expect(outcome.action).toBe('BLOCKED');
    expect(outcome.reasons.join(' ')).toMatch(/UNKNOWN/);
  });

  it('writes ledger events (run started/finished)', async () => {
    await runLiveRunner(base({ mode: 'dry-run', env: {} }));
    const events = readLedger(ledgerPath);
    expect(events.some(e => e.type === 'LIVE_RUN_STARTED')).toBe(true);
    expect(events.some(e => e.type === 'LIVE_RUN_FINISHED')).toBe(true);
  });

  it('kill switch blocks the entire run', async () => {
    const r = await runLiveRunner(base({ mode: 'dry-run', env: { [ENV.KILL_SWITCH]: '1' } }));
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/Kill switch/i);
  });

  it('no real submit happens in any test mode (no non-mock, non-empty tx signatures)', async () => {
    await runLiveRunner(base({ mode: 'mock', env: {}, adapter: new MockExecutionAdapter() }));
    const events = readLedger(ledgerPath);
    const confirmed = events.filter(e => e.type === 'LIVE_BUY_CONFIRMED');
    for (const e of confirmed) expect(e.txSignature).toMatch(/^MOCK_SIG_/);  // only synthetic
  });

  it('factory adapter in dry-run never submits even if gate passes', async () => {
    const fetchFn: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ inputMint: 'So11111111111111111111111111111111111111112', inAmount: '1', outputMint: 'GOODMINT', outAmount: '2', routePlan: [{ swapInfo: { label: 'AMM' } }] }), text: async () => '' });
    const cfg = resolveLiveTradingConfig({ env: {} });
    const adapter = createExecutionAdapter('dry-run', cfg, 'https://rpc', { fetchFn });
    const r = await runLiveRunner(base({ mode: 'dry-run', env: {}, adapter }));
    expect(r.candidateOutcomes[0].action).toBe('PLANNED_BUY');
  });

  it('cluster resolver enriches a raw-UNKNOWN candidate to CLEAN (fresh) → reaches quote stage', async () => {
    // Raw candidate is UNKNOWN; an injected resolver returns CLEAN (fresh cache).
    const unknownCand: RiskCandidate = goodCandidate({ contract: 'ENRICHME', clusterRisk: 'UNKNOWN' });
    const r = await runLiveRunner(base({
      mode: 'dry-run', env: {},
      loadCandidates: () => [unknownCand],
      resolveCluster: () => ({
        clusterRisk: 'CLEAN', clusterProvider: 'bubblemaps', clusterConfidence: 'HIGH',
        clusterUnknownReason: null, clusterFetchError: null, sourceUsed: 'cache', isFresh: true,
        explanation: 'fresh cache CLEAN',
      }),
    }));
    const outcome = r.candidateOutcomes.find(c => c.contract === 'ENRICHME')!;
    expect(outcome.rawClusterRisk).toBe('UNKNOWN');
    expect(outcome.resolvedClusterRisk).toBe('CLEAN');
    expect(outcome.clusterSource).toBe('cache');
    expect(outcome.gatePassed).toBe(true);
    expect(outcome.action).toBe('PLANNED_BUY');     // reached quote → planned buy in dry-run
    const events = readLedger(ledgerPath);
    expect(events.some(e => e.type === 'LIVE_QUOTE_RECEIVED' && e.contract === 'ENRICHME')).toBe(true);
  });

  it('cluster resolver keeps UNKNOWN as UNKNOWN when no fresh source → still blocked', async () => {
    const unknownCand: RiskCandidate = goodCandidate({ contract: 'STILLUNK', clusterRisk: 'UNKNOWN' });
    const r = await runLiveRunner(base({
      mode: 'dry-run', env: {},
      loadCandidates: () => [unknownCand],
      resolveCluster: () => ({
        clusterRisk: 'UNKNOWN', clusterProvider: null, clusterConfidence: null,
        clusterUnknownReason: null, clusterFetchError: null, sourceUsed: 'unresolved', isFresh: false,
        explanation: 'no fresh source',
      }),
    }));
    const outcome = r.candidateOutcomes.find(c => c.contract === 'STILLUNK')!;
    expect(outcome.gatePassed).toBe(false);
    expect(outcome.resolvedClusterRisk).toBe('UNKNOWN');
    expect(outcome.reasons.join(' ')).toMatch(/UNKNOWN/);
  });

  it('cluster resolver RISKY blocks even if raw was UNKNOWN (risk preserved)', async () => {
    const unknownCand: RiskCandidate = goodCandidate({ contract: 'RISKYNOW', clusterRisk: 'UNKNOWN' });
    const r = await runLiveRunner(base({
      mode: 'dry-run', env: {},
      loadCandidates: () => [unknownCand],
      resolveCluster: () => ({
        clusterRisk: 'RISKY', clusterProvider: 'bubblemaps', clusterConfidence: 'HIGH',
        clusterUnknownReason: null, clusterFetchError: null, sourceUsed: 'cache', isFresh: true,
        explanation: 'cache RISKY',
      }),
    }));
    const outcome = r.candidateOutcomes.find(c => c.contract === 'RISKYNOW')!;
    expect(outcome.gatePassed).toBe(false);
    expect(outcome.resolvedClusterRisk).toBe('RISKY');
  });
});
