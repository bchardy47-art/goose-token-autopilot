// DO_NOT_PRINT_SECRETS  realProvider=jupiter  liveRequiresUnlockAndSigner=true
//
// Real Execution Adapter v1 — three concrete adapters behind one interface:
//
//   1. DryRunExecutionAdapter  — gets REAL quotes (read-only) but NEVER submits.
//   2. MockExecutionAdapter    — deterministic in-memory buy/sell; no network, no money.
//   3. RealProviderExecutionAdapter — REAL Jupiter (Solana) quote + swap-transaction
//      build, and a submit path that REFUSES unless (a) live config is unlocked and
//      (b) a signer is injected at runtime. No private keys are ever stored or printed.
//
// Jupiter is the configured Solana swap provider. The adapter speaks raw HTTP via an
// injectable `fetchFn` (matching the repo's no-SDK, raw-fetch convention), and a raw
// JSON-RPC `sendRawTransaction` via the same fetch. Signing is delegated to an injected
// `TransactionSigner` — this module never holds key material.

import type { LiveTradingConfig } from './ripperLiveTradingConfig';

// ── Constants ──────────────────────────────────────────────────────────────────

export const SOL_MINT  = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DEFAULT_JUPITER_BASE_URL = 'https://quote-api.jup.ag/v6';
const LAMPORTS_PER_SOL = 1_000_000_000;

// ── Public types ─────────────────────────────────────────────────────────────────

export type AdapterMode = 'dry-run' | 'mock' | 'live';

export interface QuoteInput {
  inputMint:   string;
  outputMint:  string;
  amountRaw:   string | number;   // in the input mint's smallest unit (lamports for SOL)
  slippageBps: number;
}

export interface NormalizedQuote {
  quoteId:        string;
  inputMint:      string;
  outputMint:     string;
  inAmountRaw:    string;
  outAmountRaw:   string;
  otherAmountThreshold: string;
  priceImpactPct: number | null;
  slippageBps:    number;
  routeLabels:    string[];
  raw:            unknown;        // provider raw (kept for build); never logged wholesale
}

export interface BuildInput {
  quote:           NormalizedQuote;
  userPublicKey:   string;        // PUBLIC key only
  wrapAndUnwrapSol?: boolean;
  prioritizationFeeLamports?: number | 'auto';
}

export interface BuiltTransaction {
  kind:                 'jupiter-swap';
  swapTransactionBase64: string;  // unsigned versioned transaction (base64)
  lastValidBlockHeight: number | null;
  quoteId:              string;
}

export interface SubmitInput {
  built:         BuiltTransaction;
  // Live config must be unlocked for a real submit. Provided by the caller.
  liveUnlocked:  boolean;
  // Injected signer — REQUIRED for a real submit. Without it the adapter refuses.
  signer?:       TransactionSigner | null;
  rpcUrl?:       string;
}

export interface SubmitResult {
  submitted:   boolean;
  txSignature: string | null;
  reason:      string;
}

export interface TxStatus {
  signature:   string;
  confirmed:   boolean;
  err:         unknown | null;
}

// A runtime-injected signer. The adapter NEVER constructs one and NEVER sees a key:
// the operator's harness supplies an object that can sign a base64 tx and (optionally)
// expose the public key. Implementations live outside this repo.
export interface TransactionSigner {
  publicKey: string;
  // Returns a base64-encoded SIGNED transaction. May throw on failure.
  signTransactionBase64(unsignedBase64: string): Promise<string>;
}

// Minimal fetch shape so tests can inject a stub.
export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

// ── Typed errors ─────────────────────────────────────────────────────────────────

export type ExecErrorCode =
  | 'PROVIDER_HTTP_ERROR'
  | 'PROVIDER_BAD_RESPONSE'
  | 'QUOTE_NO_ROUTE'
  | 'SLIPPAGE_EXCEEDS_LIMIT'
  | 'SUBMIT_BLOCKED_NOT_UNLOCKED'
  | 'SUBMIT_BLOCKED_NO_SIGNER'
  | 'SUBMIT_BLOCKED_DRY_RUN'
  | 'RPC_ERROR'
  | 'NOT_IMPLEMENTED_IN_MODE';

export class ExecutionError extends Error {
  constructor(public code: ExecErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionError';
  }
}

// ── Adapter interface ────────────────────────────────────────────────────────────

export interface ExecutionAdapter {
  readonly mode:        AdapterMode;
  readonly providerName: string;
  getQuote(input: QuoteInput): Promise<NormalizedQuote>;
  buildBuy(input: BuildInput): Promise<BuiltTransaction>;
  buildSell(input: BuildInput): Promise<BuiltTransaction>;
  submitTransaction(input: SubmitInput): Promise<SubmitResult>;
  getTransactionStatus(signature: string): Promise<TxStatus>;
  getWalletBalance(publicKey: string): Promise<number>;   // SOL balance
}

// Helper to convert a USD amount into SOL lamports given a SOL/USD price.
export function usdToLamports(usd: number, solUsdPrice: number): string {
  if (solUsdPrice <= 0) return '0';
  return Math.floor((usd / solUsdPrice) * LAMPORTS_PER_SOL).toString();
}

// ════════════════════════════════════════════════════════════════════════════════
//  Real Jupiter / Solana provider adapter
// ════════════════════════════════════════════════════════════════════════════════

export interface RealAdapterOptions {
  baseUrl?:  string;
  rpcUrl?:   string;
  fetchFn?:  FetchLike;
}

export class RealProviderExecutionAdapter implements ExecutionAdapter {
  readonly mode: AdapterMode = 'live';
  readonly providerName = 'jupiter';
  private readonly baseUrl: string;
  private readonly rpcUrl:  string | null;
  private readonly fetchFn: FetchLike;

  constructor(opts: RealAdapterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_JUPITER_BASE_URL).replace(/\/$/, '');
    this.rpcUrl  = opts.rpcUrl ?? null;
    // Default to global fetch (Node 18+). Tests inject a stub.
    this.fetchFn = opts.fetchFn ?? ((globalThis as unknown as { fetch: FetchLike }).fetch);
  }

  // ── REAL quote: GET {base}/quote ──────────────────────────────────────────────
  async getQuote(input: QuoteInput): Promise<NormalizedQuote> {
    const url = `${this.baseUrl}/quote?inputMint=${encodeURIComponent(input.inputMint)}` +
      `&outputMint=${encodeURIComponent(input.outputMint)}` +
      `&amount=${encodeURIComponent(String(input.amountRaw))}` +
      `&slippageBps=${encodeURIComponent(String(input.slippageBps))}` +
      `&swapMode=ExactIn`;
    let res;
    try {
      res = await this.fetchFn(url, { method: 'GET', headers: { accept: 'application/json' } });
    } catch (err) {
      throw new ExecutionError('PROVIDER_HTTP_ERROR', `Jupiter quote fetch failed: ${errMsg(err)}`);
    }
    if (!res.ok) {
      throw new ExecutionError('PROVIDER_HTTP_ERROR', `Jupiter quote HTTP ${res.status}`);
    }
    const body = await safeJson(res);
    return parseJupiterQuote(body, input.slippageBps);
  }

  // ── REAL build: POST {base}/swap → unsigned base64 versioned transaction ───────
  async buildBuy(input: BuildInput): Promise<BuiltTransaction>  { return this.buildSwap(input); }
  async buildSell(input: BuildInput): Promise<BuiltTransaction> { return this.buildSwap(input); }

  private async buildSwap(input: BuildInput): Promise<BuiltTransaction> {
    const payload = {
      quoteResponse: input.quote.raw,
      userPublicKey: input.userPublicKey,
      wrapAndUnwrapSol: input.wrapAndUnwrapSol ?? true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: input.prioritizationFeeLamports ?? 'auto',
    };
    let res;
    try {
      res = await this.fetchFn(`${this.baseUrl}/swap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new ExecutionError('PROVIDER_HTTP_ERROR', `Jupiter swap build failed: ${errMsg(err)}`);
    }
    if (!res.ok) {
      throw new ExecutionError('PROVIDER_HTTP_ERROR', `Jupiter swap HTTP ${res.status}`);
    }
    const body = await safeJson(res);
    return parseJupiterSwapBuild(body, input.quote.quoteId);
  }

  // ── Submit: REFUSE unless unlocked AND signer injected. ───────────────────────
  async submitTransaction(input: SubmitInput): Promise<SubmitResult> {
    if (!input.liveUnlocked) {
      throw new ExecutionError('SUBMIT_BLOCKED_NOT_UNLOCKED',
        'Refusing to submit: live trading is not unlocked (config gate failed).');
    }
    if (!input.signer) {
      throw new ExecutionError('SUBMIT_BLOCKED_NO_SIGNER',
        'Refusing to submit: no signer injected. A runtime signer is required for real submission.');
    }
    const rpc = input.rpcUrl ?? this.rpcUrl;
    if (!rpc) {
      throw new ExecutionError('RPC_ERROR', 'Refusing to submit: no RPC URL configured.');
    }
    // Sign via the injected signer (this module never holds the key).
    let signedBase64: string;
    try {
      signedBase64 = await input.signer.signTransactionBase64(input.built.swapTransactionBase64);
    } catch (err) {
      throw new ExecutionError('RPC_ERROR', `Signer failed: ${errMsg(err)}`);
    }
    // Broadcast via raw JSON-RPC sendTransaction (base64 encoding).
    const sig = await this.rpcSendRawTransaction(rpc, signedBase64);
    return { submitted: true, txSignature: sig, reason: 'submitted via injected signer + RPC' };
  }

  async getTransactionStatus(signature: string): Promise<TxStatus> {
    if (!this.rpcUrl) throw new ExecutionError('RPC_ERROR', 'No RPC URL configured.');
    const body = await this.rpcCall(this.rpcUrl, 'getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const value = (body as { result?: { value?: Array<{ confirmationStatus?: string; err?: unknown } | null> } })
      ?.result?.value?.[0] ?? null;
    return {
      signature,
      confirmed: value != null && (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') && value.err == null,
      err: value?.err ?? null,
    };
  }

  async getWalletBalance(publicKey: string): Promise<number> {
    if (!this.rpcUrl) throw new ExecutionError('RPC_ERROR', 'No RPC URL configured.');
    const body = await this.rpcCall(this.rpcUrl, 'getBalance', [publicKey]);
    const lamports = (body as { result?: { value?: number } })?.result?.value ?? 0;
    return lamports / LAMPORTS_PER_SOL;
  }

  // ── Raw JSON-RPC helpers (same convention as the rest of the repo) ─────────────
  private async rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
    let res;
    try {
      res = await this.fetchFn(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch (err) {
      throw new ExecutionError('RPC_ERROR', `RPC ${method} failed: ${errMsg(err)}`);
    }
    if (!res.ok) throw new ExecutionError('RPC_ERROR', `RPC ${method} HTTP ${res.status}`);
    const json = await safeJson(res) as { error?: { message?: string } };
    if (json && json.error) throw new ExecutionError('RPC_ERROR', `RPC ${method}: ${json.error.message ?? 'error'}`);
    return json;
  }

  private async rpcSendRawTransaction(rpcUrl: string, signedBase64: string): Promise<string> {
    const json = await this.rpcCall(rpcUrl, 'sendTransaction', [
      signedBase64, { encoding: 'base64', skipPreflight: false, maxRetries: 3 },
    ]) as { result?: string };
    if (!json.result) throw new ExecutionError('RPC_ERROR', 'sendTransaction returned no signature');
    return json.result;
  }
}

// ── Provider response parsers (exported for fixture tests) ─────────────────────────

export function parseJupiterQuote(body: unknown, requestedSlippageBps: number): NormalizedQuote {
  if (!body || typeof body !== 'object') {
    throw new ExecutionError('PROVIDER_BAD_RESPONSE', 'Jupiter quote: empty/non-object response');
  }
  const q = body as Record<string, unknown>;
  if (q['error'] || (Array.isArray(q['routePlan']) && (q['routePlan'] as unknown[]).length === 0)) {
    throw new ExecutionError('QUOTE_NO_ROUTE', `Jupiter quote: no route (${String(q['error'] ?? 'empty routePlan')})`);
  }
  const inAmount  = q['inAmount'];
  const outAmount = q['outAmount'];
  if (typeof inAmount !== 'string' || typeof outAmount !== 'string') {
    throw new ExecutionError('PROVIDER_BAD_RESPONSE', 'Jupiter quote: missing inAmount/outAmount');
  }
  const routeLabels = Array.isArray(q['routePlan'])
    ? (q['routePlan'] as Array<{ swapInfo?: { label?: string } }>).map(r => r?.swapInfo?.label ?? '?')
    : [];
  const priceImpactPct = q['priceImpactPct'] != null ? Number(q['priceImpactPct']) : null;
  return {
    quoteId: typeof q['contextSlot'] !== 'undefined' ? `q_${String(q['contextSlot'])}` : `q_${inAmount}_${outAmount}`,
    inputMint:  String(q['inputMint'] ?? ''),
    outputMint: String(q['outputMint'] ?? ''),
    inAmountRaw:  inAmount,
    outAmountRaw: outAmount,
    otherAmountThreshold: typeof q['otherAmountThreshold'] === 'string' ? q['otherAmountThreshold'] : outAmount,
    priceImpactPct: Number.isFinite(priceImpactPct as number) ? (priceImpactPct as number) : null,
    slippageBps: typeof q['slippageBps'] === 'number' ? (q['slippageBps'] as number) : requestedSlippageBps,
    routeLabels,
    raw: body,
  };
}

export function parseJupiterSwapBuild(body: unknown, quoteId: string): BuiltTransaction {
  if (!body || typeof body !== 'object') {
    throw new ExecutionError('PROVIDER_BAD_RESPONSE', 'Jupiter swap: empty/non-object response');
  }
  const s = body as Record<string, unknown>;
  const swapTx = s['swapTransaction'];
  if (typeof swapTx !== 'string' || swapTx.length === 0) {
    throw new ExecutionError('PROVIDER_BAD_RESPONSE', 'Jupiter swap: missing swapTransaction');
  }
  return {
    kind: 'jupiter-swap',
    swapTransactionBase64: swapTx,
    lastValidBlockHeight: typeof s['lastValidBlockHeight'] === 'number' ? (s['lastValidBlockHeight'] as number) : null,
    quoteId,
  };
}

// ════════════════════════════════════════════════════════════════════════════════
//  Dry-run adapter — REAL quotes, NEVER submits
// ════════════════════════════════════════════════════════════════════════════════

export class DryRunExecutionAdapter implements ExecutionAdapter {
  readonly mode: AdapterMode = 'dry-run';
  readonly providerName: string;
  constructor(private readonly real: RealProviderExecutionAdapter) {
    this.providerName = real.providerName;
  }
  getQuote(input: QuoteInput): Promise<NormalizedQuote> { return this.real.getQuote(input); }
  buildBuy(input: BuildInput): Promise<BuiltTransaction>  { return this.real.buildBuy(input); }
  buildSell(input: BuildInput): Promise<BuiltTransaction> { return this.real.buildSell(input); }
  async submitTransaction(_input: SubmitInput): Promise<SubmitResult> {
    // Dry-run NEVER submits, regardless of unlock/signer.
    return { submitted: false, txSignature: null, reason: 'DRY_RUN: submission intentionally skipped (no real order placed)' };
  }
  getTransactionStatus(signature: string): Promise<TxStatus> { return this.real.getTransactionStatus(signature); }
  getWalletBalance(publicKey: string): Promise<number> { return this.real.getWalletBalance(publicKey); }
}

// ════════════════════════════════════════════════════════════════════════════════
//  Mock adapter — deterministic, in-memory, no network, no money
// ════════════════════════════════════════════════════════════════════════════════

export interface MockAdapterOptions {
  // Fixed fill price (output per input unit) and a synthetic signature counter.
  fillRatio?:  number;   // outAmount = inAmount * fillRatio
  balanceSol?: number;
}

export class MockExecutionAdapter implements ExecutionAdapter {
  readonly mode: AdapterMode = 'mock';
  readonly providerName = 'mock';
  private sigCounter = 0;
  private readonly fillRatio: number;
  private readonly balanceSol: number;
  constructor(opts: MockAdapterOptions = {}) {
    this.fillRatio = opts.fillRatio ?? 1000;     // 1 SOL → 1000 tokens (arbitrary, deterministic)
    this.balanceSol = opts.balanceSol ?? 5;
  }
  async getQuote(input: QuoteInput): Promise<NormalizedQuote> {
    const inAmt = Number(input.amountRaw);
    const outAmt = Math.floor(inAmt * this.fillRatio);
    return {
      quoteId: `mock_${input.inputMint.slice(0, 4)}_${input.outputMint.slice(0, 4)}_${inAmt}`,
      inputMint: input.inputMint, outputMint: input.outputMint,
      inAmountRaw: String(inAmt), outAmountRaw: String(outAmt),
      otherAmountThreshold: String(Math.floor(outAmt * (1 - input.slippageBps / 10000))),
      priceImpactPct: 0.1, slippageBps: input.slippageBps,
      routeLabels: ['MOCK_AMM'], raw: { mock: true },
    };
  }
  async buildBuy(input: BuildInput): Promise<BuiltTransaction>  { return this.build(input); }
  async buildSell(input: BuildInput): Promise<BuiltTransaction> { return this.build(input); }
  private async build(input: BuildInput): Promise<BuiltTransaction> {
    return { kind: 'jupiter-swap', swapTransactionBase64: `MOCK_TX_${input.quote.quoteId}`, lastValidBlockHeight: 1, quoteId: input.quote.quoteId };
  }
  async submitTransaction(_input: SubmitInput): Promise<SubmitResult> {
    this.sigCounter += 1;
    // Mock "executes" without touching a chain — clearly synthetic signature.
    return { submitted: true, txSignature: `MOCK_SIG_${this.sigCounter}`, reason: 'MOCK: synthetic fill (no real order)' };
  }
  async getTransactionStatus(signature: string): Promise<TxStatus> {
    return { signature, confirmed: true, err: null };
  }
  async getWalletBalance(_publicKey: string): Promise<number> { return this.balanceSol; }
}

// ── Factory ───────────────────────────────────────────────────────────────────────

export interface BuildAdapterDeps {
  fetchFn?: FetchLike;
}

// Choose the adapter for a resolved live config + requested mode. The factory NEVER
// upgrades to live unless the config is actually unlocked AND mode === 'live'.
export function createExecutionAdapter(
  mode: AdapterMode,
  cfg: LiveTradingConfig,
  rpcUrl: string | null,
  deps: BuildAdapterDeps = {},
): ExecutionAdapter {
  if (mode === 'mock') return new MockExecutionAdapter();
  const real = new RealProviderExecutionAdapter({ rpcUrl: rpcUrl ?? undefined, fetchFn: deps.fetchFn });
  if (mode === 'live') {
    // Returning the real adapter is fine: its submit() still refuses without unlock+signer.
    return real;
  }
  // dry-run (default): real quotes, never submits.
  return new DryRunExecutionAdapter(real);
}

// ── Internal helpers ─────────────────────────────────────────────────────────────

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }
async function safeJson(res: { json: () => Promise<unknown>; text: () => Promise<string> }): Promise<unknown> {
  try { return await res.json(); }
  catch { throw new ExecutionError('PROVIDER_BAD_RESPONSE', 'response was not valid JSON'); }
}
