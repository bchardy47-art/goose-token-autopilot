import { describe, it, expect } from 'vitest';
import {
  RealProviderExecutionAdapter,
  DryRunExecutionAdapter,
  MockExecutionAdapter,
  createExecutionAdapter,
  parseJupiterQuote,
  parseJupiterSwapBuild,
  ExecutionError,
  SOL_MINT,
  type FetchLike,
  type TransactionSigner,
} from '../src/token-grab/ripperRealExecutionAdapter';

// ── Jupiter fixtures (shape matches quote-api v6) ───────────────────────────────

const QUOTE_FIXTURE = {
  inputMint: SOL_MINT,
  inAmount: '100000000',                 // 0.1 SOL
  outputMint: 'TokenMint1111111111111111111111111111111111',
  outAmount: '123456789',
  otherAmountThreshold: '120000000',
  swapMode: 'ExactIn',
  slippageBps: 150,
  priceImpactPct: '0.12',
  routePlan: [{ swapInfo: { label: 'Raydium' }, percent: 100 }],
  contextSlot: 99887766,
};

const SWAP_FIXTURE = {
  swapTransaction: 'AQAABASE64UNSIGNEDTRANSACTIONPAYLOAD==',
  lastValidBlockHeight: 250000000,
};

function fetchOk(body: unknown): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
}
function fetchSeq(...bodies: unknown[]): FetchLike {
  let i = 0;
  return async () => {
    const b = bodies[Math.min(i, bodies.length - 1)]; i += 1;
    return { ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) };
  };
}
function fetchHttpError(status: number): FetchLike {
  return async () => ({ ok: false, status, json: async () => ({}), text: async () => 'err' });
}

const QUOTE_INPUT = { inputMint: SOL_MINT, outputMint: QUOTE_FIXTURE.outputMint, amountRaw: '100000000', slippageBps: 150 };

function lockedCfg() { return { liveUnlocked: false } as never; }

describe('Real Execution Adapter v1 — parsers', () => {
  it('real provider quote parser works with a fixture', () => {
    const q = parseJupiterQuote(QUOTE_FIXTURE, 150);
    expect(q.inAmountRaw).toBe('100000000');
    expect(q.outAmountRaw).toBe('123456789');
    expect(q.routeLabels).toEqual(['Raydium']);
    expect(q.priceImpactPct).toBeCloseTo(0.12, 5);
    expect(q.raw).toBe(QUOTE_FIXTURE);
  });

  it('real provider build parser works with a fixture', () => {
    const b = parseJupiterSwapBuild(SWAP_FIXTURE, 'q_1');
    expect(b.kind).toBe('jupiter-swap');
    expect(b.swapTransactionBase64).toBe(SWAP_FIXTURE.swapTransaction);
    expect(b.lastValidBlockHeight).toBe(250000000);
  });

  it('quote parser throws typed error on no route', () => {
    expect(() => parseJupiterQuote({ routePlan: [] }, 150)).toThrow(ExecutionError);
    try { parseJupiterQuote({ routePlan: [] }, 150); }
    catch (e) { expect((e as ExecutionError).code).toBe('QUOTE_NO_ROUTE'); }
  });

  it('build parser throws typed error on missing swapTransaction', () => {
    try { parseJupiterSwapBuild({ lastValidBlockHeight: 1 }, 'q'); expect.fail('should throw'); }
    catch (e) { expect((e as ExecutionError).code).toBe('PROVIDER_BAD_RESPONSE'); }
  });
});

describe('Real Execution Adapter v1 — real provider over injected fetch', () => {
  it('fetches a real quote via injected fetch', async () => {
    const real = new RealProviderExecutionAdapter({ fetchFn: fetchOk(QUOTE_FIXTURE), rpcUrl: 'https://rpc' });
    const q = await real.getQuote(QUOTE_INPUT);
    expect(q.outAmountRaw).toBe('123456789');
  });

  it('builds a real buy transaction via injected fetch', async () => {
    const real = new RealProviderExecutionAdapter({ fetchFn: fetchSeq(SWAP_FIXTURE), rpcUrl: 'https://rpc' });
    const q = parseJupiterQuote(QUOTE_FIXTURE, 150);
    const built = await real.buildBuy({ quote: q, userPublicKey: '7vWf8YxkqTfQ1xH2bN3cD4eF5gH6jK7mN8pQ9rS1tUv' });
    expect(built.swapTransactionBase64).toBe(SWAP_FIXTURE.swapTransaction);
  });

  it('returns typed error on provider HTTP failure', async () => {
    const real = new RealProviderExecutionAdapter({ fetchFn: fetchHttpError(503), rpcUrl: 'https://rpc' });
    await expect(real.getQuote(QUOTE_INPUT)).rejects.toMatchObject({ code: 'PROVIDER_HTTP_ERROR' });
  });

  it('live submit REFUSES without unlock', async () => {
    const real = new RealProviderExecutionAdapter({ fetchFn: fetchOk({}), rpcUrl: 'https://rpc' });
    const built = parseJupiterSwapBuild(SWAP_FIXTURE, 'q');
    await expect(real.submitTransaction({ built, liveUnlocked: false, signer: dummySigner() }))
      .rejects.toMatchObject({ code: 'SUBMIT_BLOCKED_NOT_UNLOCKED' });
  });

  it('live submit REFUSES without a signer even when unlocked', async () => {
    const real = new RealProviderExecutionAdapter({ fetchFn: fetchOk({}), rpcUrl: 'https://rpc' });
    const built = parseJupiterSwapBuild(SWAP_FIXTURE, 'q');
    await expect(real.submitTransaction({ built, liveUnlocked: true, signer: null }))
      .rejects.toMatchObject({ code: 'SUBMIT_BLOCKED_NO_SIGNER' });
  });

  it('live submit signs via injected signer + sends raw tx when fully unlocked', async () => {
    // RPC sendTransaction returns a signature.
    const real = new RealProviderExecutionAdapter({ fetchFn: fetchOk({ result: 'REALSIG123' }), rpcUrl: 'https://rpc' });
    const built = parseJupiterSwapBuild(SWAP_FIXTURE, 'q');
    let signedWith = '';
    const signer: TransactionSigner = {
      publicKey: 'pub',
      async signTransactionBase64(u) { signedWith = u; return 'SIGNED_' + u; },
    };
    const res = await real.submitTransaction({ built, liveUnlocked: true, signer, rpcUrl: 'https://rpc' });
    expect(res.submitted).toBe(true);
    expect(res.txSignature).toBe('REALSIG123');
    expect(signedWith).toBe(SWAP_FIXTURE.swapTransaction);   // adapter never holds a key, only delegates
  });
});

describe('Real Execution Adapter v1 — dry-run & mock', () => {
  it('dry-run gets real quotes but NEVER submits', async () => {
    const real = new RealProviderExecutionAdapter({ fetchFn: fetchOk(QUOTE_FIXTURE), rpcUrl: 'https://rpc' });
    const dry = new DryRunExecutionAdapter(real);
    const q = await dry.getQuote(QUOTE_INPUT);
    expect(q.outAmountRaw).toBe('123456789');                 // real quote path used
    const built = parseJupiterSwapBuild(SWAP_FIXTURE, 'q');
    const res = await dry.submitTransaction({ built, liveUnlocked: true, signer: dummySigner() });
    expect(res.submitted).toBe(false);                        // never submits, even if "unlocked"
    expect(res.reason).toMatch(/DRY_RUN/);
  });

  it('mock buy/sell works deterministically without network', async () => {
    const mock = new MockExecutionAdapter({ fillRatio: 1000 });
    const q = await mock.getQuote(QUOTE_INPUT);
    expect(Number(q.outAmountRaw)).toBe(100000000 * 1000);
    const built = await mock.buildBuy({ quote: q, userPublicKey: 'pub' });
    const res = await mock.submitTransaction({ built, liveUnlocked: false, signer: null });
    expect(res.submitted).toBe(true);
    expect(res.txSignature).toMatch(/^MOCK_SIG_/);
    const sell = await mock.buildSell({ quote: q, userPublicKey: 'pub' });
    expect(sell.swapTransactionBase64).toMatch(/^MOCK_TX_/);
  });

  it('factory returns the right adapter per mode and live submit still refuses', async () => {
    const dry = createExecutionAdapter('dry-run', lockedCfg(), 'https://rpc');
    expect(dry.mode).toBe('dry-run');
    const mock = createExecutionAdapter('mock', lockedCfg(), 'https://rpc');
    expect(mock.mode).toBe('mock');
    const live = createExecutionAdapter('live', lockedCfg(), 'https://rpc', { fetchFn: fetchOk({}) });
    expect(live.mode).toBe('live');
    const built = parseJupiterSwapBuild(SWAP_FIXTURE, 'q');
    await expect(live.submitTransaction({ built, liveUnlocked: false, signer: dummySigner() }))
      .rejects.toMatchObject({ code: 'SUBMIT_BLOCKED_NOT_UNLOCKED' });
  });

  it('does not store any private key anywhere in the adapter instances', () => {
    const real = new RealProviderExecutionAdapter({ fetchFn: fetchOk({}), rpcUrl: 'https://rpc' });
    const serialized = JSON.stringify(real);
    expect(serialized).not.toMatch(/privateKey|secretKey|keypair|mnemonic/i);
  });
});

function dummySigner(): TransactionSigner {
  return { publicKey: 'pub', async signTransactionBase64(u) { return 'SIGNED_' + u; } };
}
