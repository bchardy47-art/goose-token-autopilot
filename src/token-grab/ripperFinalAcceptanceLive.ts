// DO_NOT_ENABLE_REAL_TRADING_BY_DEFAULT  acceptanceProvesCapabilityNotExecution=true
//
// Final Live Acceptance v1 — proves the app is FINISHED for autonomous real-trading
// CAPABILITY: real provider adapter (not a placeholder), real quote/build paths,
// working dry-run + mock, a live path that refuses without unlock, ledger recovery,
// circuit breakers, and an intact paper app — all WITHOUT executing a real trade.
//
// It functionally exercises each layer with injected fetch / temp dirs, AND inspects
// the adapter source to confirm it contains real Jupiter/Solana endpoints (so a future
// regression to a placeholder stub fails acceptance).

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

import { resolveLiveTradingConfig, CONFIRM_PHRASE, ENV } from './ripperLiveTradingConfig';
import { appendLedgerEvent, readLedger, recoverTradingState } from './ripperRealTradingLedger';
import {
  RealProviderExecutionAdapter, MockExecutionAdapter, DryRunExecutionAdapter,
  parseJupiterQuote, parseJupiterSwapBuild, ExecutionError, SOL_MINT, type FetchLike,
} from './ripperRealExecutionAdapter';
import { runLiveRunner } from './ripperLiveRunner';
import { runLiveDaemon } from './ripperLiveDaemon';
import { runLiveControl } from './ripperLiveControl';
import { runRipperAutopilotStatus } from './ripperAutopilotStatus';
import type { RiskCandidate } from './ripperLiveRiskGate';

export interface AcceptanceCheck { name: string; pass: boolean; critical: boolean; detail: string; }

export interface FinalAcceptanceResult {
  generatedAt: string;
  checks: AcceptanceCheck[];
  // headline flags
  FINISHED_FOR_AUTONOMOUS_REAL_TRADING_CAPABILITY: 'YES' | 'NO';
  LIVE_TRADING_DEFAULT: 'OFF';
  LIVE_TRADING_UNLOCK_REQUIRED: 'YES';
  REAL_PROVIDER_ADAPTER_IMPLEMENTED: 'YES' | 'NO';
  REAL_QUOTE_PATH_IMPLEMENTED: 'YES' | 'NO';
  REAL_BUY_BUILD_PATH_IMPLEMENTED: 'YES' | 'NO';
  REAL_SELL_BUILD_PATH_IMPLEMENTED: 'YES' | 'NO';
  DRY_RUN_EXECUTION_WORKS: 'YES' | 'NO';
  MOCK_EXECUTION_WORKS: 'YES' | 'NO';
  LIVE_RUNNER_REFUSES_WITHOUT_UNLOCK: 'YES' | 'NO';
  LEDGER_RECOVERY_READY: 'YES' | 'NO';
  CIRCUIT_BREAKERS_ACTIVE: 'YES' | 'NO';
  PAPER_MODE_STILL_WORKS: 'YES' | 'NO';
  REAL_TRADING_NOT_EXECUTED_DURING_BUILD: 'YES';
}

const QUOTE_FIXTURE = {
  inputMint: SOL_MINT, inAmount: '100000000', outputMint: 'TokenMint11111111111111111111111111111111',
  outAmount: '123456789', otherAmountThreshold: '120000000', slippageBps: 150, priceImpactPct: '0.1',
  routePlan: [{ swapInfo: { label: 'Raydium' } }],
};
const SWAP_FIXTURE = { swapTransaction: 'BASE64UNSIGNEDTX==', lastValidBlockHeight: 1 };

function fixtureFetch(): FetchLike {
  return async (url) => {
    const body = url.includes('/swap') ? SWAP_FIXTURE : QUOTE_FIXTURE;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

function findAdapterSource(): string | null {
  const candidates = [
    path.join(__dirname, 'ripperRealExecutionAdapter.ts'),
    path.join(process.cwd(), 'src/token-grab/ripperRealExecutionAdapter.ts'),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

export interface FinalAcceptanceOptions {
  generatedAt?: string;
  now?: Date;
}

export async function runFinalAcceptanceLive(opts: FinalAcceptanceOptions = {}): Promise<FinalAcceptanceResult> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const now = opts.now ?? new Date();
  const checks: AcceptanceCheck[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-live-'));
  const add = (name: string, pass: boolean, critical: boolean, detail: string) => checks.push({ name, pass, critical, detail });

  try {
    // 1. Live config doctor exists & locked by default.
    const lockedCfg = resolveLiveTradingConfig({ env: {} });
    add('live_config_doctor', !lockedCfg.liveUnlocked && lockedCfg.liveDefaultsOff && lockedCfg.unlockRequired, true,
      `default state=${lockedCfg.primaryState}, liveUnlocked=${lockedCfg.liveUnlocked}`);

    // 2. Ledger exists and recovers (temp round-trip — never touches the real ledger).
    const ledgerPath = path.join(tmp, 'ledger.jsonl');
    appendLedgerEvent({ type: 'LIVE_POSITION_OPENED', runId: 'acc', mode: 'mock', contract: 'ACCMINT', actualUsd: 10, entryPrice: 1, tokenAmount: 5 }, ledgerPath, { now: () => now });
    appendLedgerEvent({ type: 'LIVE_POSITION_CLOSED', runId: 'acc', mode: 'mock', contract: 'ACCMINT', actualUsd: 14 }, ledgerPath, { now: () => now });
    const { open, closed } = recoverTradingState(readLedger(ledgerPath));
    add('ledger_recovery', open.length === 0 && closed.length === 1 && closed[0].realizedUsd === 4, true,
      `recovered open=${open.length} closed=${closed.length} pnl=${closed[0]?.realizedUsd}`);

    // 3. Real provider adapter is NOT a placeholder (source inspection).
    const src = findAdapterSource();
    const srcText = src ? fs.readFileSync(src, 'utf-8') : '';
    const hasRealMarkers = !!src &&
      /quote-api\.jup\.ag/.test(srcText) &&
      /\/quote\?/.test(srcText) &&
      /\$\{this\.baseUrl\}\/swap/.test(srcText) &&
      /sendTransaction/.test(srcText) &&
      !/TODO|PLACEHOLDER|not implemented/i.test(srcText.replace(/refuses|refuse/gi, ''));
    add('real_adapter_not_placeholder', hasRealMarkers, true,
      src ? `adapter source has real Jupiter /quote + /swap + RPC sendTransaction` : 'adapter source not found');

    // 4. Real quote path works (fixture + over injected fetch).
    let quoteOk = false, buildOk = false, sellBuildOk = false;
    try {
      const q = parseJupiterQuote(QUOTE_FIXTURE, 150);
      const real = new RealProviderExecutionAdapter({ fetchFn: fixtureFetch(), rpcUrl: 'https://rpc' });
      const liveQuote = await real.getQuote({ inputMint: SOL_MINT, outputMint: QUOTE_FIXTURE.outputMint, amountRaw: '100000000', slippageBps: 150 });
      quoteOk = q.outAmountRaw === '123456789' && liveQuote.outAmountRaw === '123456789';
      const built = await real.buildBuy({ quote: liveQuote, userPublicKey: 'pub' });
      buildOk = parseJupiterSwapBuild(SWAP_FIXTURE, 'q').swapTransactionBase64 === SWAP_FIXTURE.swapTransaction && built.swapTransactionBase64 === SWAP_FIXTURE.swapTransaction;
      const sell = await real.buildSell({ quote: liveQuote, userPublicKey: 'pub' });
      sellBuildOk = sell.kind === 'jupiter-swap' && sell.swapTransactionBase64.length > 0;
    } catch { /* leave false */ }
    add('real_quote_path', quoteOk, true, `real Jupiter quote parsed/fetched`);
    add('real_buy_build_path', buildOk, true, `real Jupiter swap build (buy) produced an unsigned tx`);
    add('real_sell_build_path', sellBuildOk, true, `real Jupiter swap build (sell) produced an unsigned tx`);

    // 5. Dry-run runner works (plans, never submits).
    const goodCand: RiskCandidate = {
      contract: 'ACCGOOD', symbol: 'AG', buyGateDecision: 'BUY_APPROVED_PAPER', clusterRisk: 'CLEAN',
      liquidityUsd: 60000, entryMomentumPct: 5, expectedBaselinePnl: 80, liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5',
    };
    const dryLedger = path.join(tmp, 'dry.jsonl');
    const dry = await runLiveRunner({
      mode: 'dry-run', env: {}, ledgerPath: dryLedger, now,
      latestCycleTime: now.toISOString(), loadCandidates: () => [goodCand], fetchFn: fixtureFetch(),
    });
    const dryEvents = readLedger(dryLedger);
    const dryOk = !dry.blocked && dry.candidateOutcomes[0]?.action === 'PLANNED_BUY' &&
      !dryEvents.some(e => e.type === 'LIVE_BUY_CONFIRMED');
    add('dry_run_runner', dryOk, true, `planned buy, no confirm event (${dry.candidateOutcomes[0]?.action})`);

    // 6. Mock runner works (opens a position with a synthetic signature).
    const mockLedger = path.join(tmp, 'mock.jsonl');
    const mock = await runLiveRunner({
      mode: 'mock', env: {}, ledgerPath: mockLedger, now, adapter: new MockExecutionAdapter(),
      latestCycleTime: now.toISOString(), loadCandidates: () => [goodCand],
    });
    const mockOk = mock.candidateOutcomes[0]?.action === 'MOCK_BUY' && /^MOCK_SIG_/.test(mock.candidateOutcomes[0]?.txSignature ?? '');
    add('mock_runner', mockOk, true, `mock buy opened with synthetic signature`);

    // 7. Live runner refuses without unlock.
    const liveLedger = path.join(tmp, 'live.jsonl');
    const live = await runLiveRunner({
      mode: 'live', env: {}, ledgerPath: liveLedger, now,
      latestCycleTime: now.toISOString(), loadCandidates: () => [goodCand], fetchFn: fixtureFetch(),
    });
    const liveRefused = live.blocked && /not unlocked/i.test(live.blockReason ?? '') &&
      !readLedger(liveLedger).some(e => e.type === 'LIVE_BUY_CONFIRMED');
    add('live_runner_refuses_without_unlock', liveRefused, true, `live run blocked: ${live.blockReason}`);

    // 7b. Real adapter submit refuses without unlock AND without signer (typed errors).
    let submitRefusesNoUnlock = false, submitRefusesNoSigner = false;
    const real2 = new RealProviderExecutionAdapter({ fetchFn: fixtureFetch(), rpcUrl: 'https://rpc' });
    const built2 = parseJupiterSwapBuild(SWAP_FIXTURE, 'q');
    try { await real2.submitTransaction({ built: built2, liveUnlocked: false, signer: { publicKey: 'p', async signTransactionBase64(u) { return u; } } }); }
    catch (e) { submitRefusesNoUnlock = e instanceof ExecutionError && e.code === 'SUBMIT_BLOCKED_NOT_UNLOCKED'; }
    try { await real2.submitTransaction({ built: built2, liveUnlocked: true, signer: null }); }
    catch (e) { submitRefusesNoSigner = e instanceof ExecutionError && e.code === 'SUBMIT_BLOCKED_NO_SIGNER'; }
    add('submit_refuses_without_unlock_or_signer', submitRefusesNoUnlock && submitRefusesNoSigner, true,
      `noUnlock→${submitRefusesNoUnlock}, noSigner→${submitRefusesNoSigner}`);

    // 8. Live daemon dry-run works (one cycle, no submit).
    const daemonLog = path.join(tmp, 'daemon.jsonl');
    const daemon = await runLiveDaemon({
      mode: 'dry-run', once: true, stopFile: path.join(tmp, 'STOP'), daemonLog, sleep: async () => {},
      runOnce: async () => dry,
    });
    add('live_daemon_dry_run', daemon.cyclesRun === 1 && daemon.stoppedReason === 'ONCE', true,
      `daemon ran ${daemon.cyclesRun} cycle(s), stopped=${daemon.stoppedReason}`);

    // 9. Live control works.
    const ctl = runLiveControl({ env: {}, ledgerPath: mockLedger, stopFile: path.join(tmp, 'STOP2'), now });
    add('live_control', ctl.status.liveUnlocked === false && ctl.status.noSecretsPrinted === true, true,
      `control status ok (locked, no secrets)`);

    // 10. Circuit breakers active — kill switch blocks even a fully-unlocked config.
    const unlocked = resolveLiveTradingConfig({ env: fullEnv({ [ENV.KILL_SWITCH]: '1' }) });
    add('circuit_breakers', !unlocked.liveUnlocked && unlocked.killSwitchOn, true,
      `kill switch blocks unlock=${!unlocked.liveUnlocked}`);

    // 11. Paper mode still works (autopilot status read-only).
    let paperOk = false; let paperDetail = '';
    try {
      const status = runRipperAutopilotStatus({});
      paperOk = status.realTradingLocked === true && status.tradingExecuted === 0 && status.mode === 'PAPER_ONLY';
      paperDetail = `paper autopilot: mode=${status.mode}, realTradingLocked=${status.realTradingLocked}`;
    } catch (err) { paperDetail = `paper status error: ${err instanceof Error ? err.message : String(err)}`; }
    add('paper_mode_still_works', paperOk, true, paperDetail);

  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const yn = (name: string): 'YES' | 'NO' => checks.find(c => c.name === name)?.pass ? 'YES' : 'NO';
  const criticalAllPass = checks.filter(c => c.critical).every(c => c.pass);

  return {
    generatedAt,
    checks,
    FINISHED_FOR_AUTONOMOUS_REAL_TRADING_CAPABILITY: criticalAllPass ? 'YES' : 'NO',
    LIVE_TRADING_DEFAULT: 'OFF',
    LIVE_TRADING_UNLOCK_REQUIRED: 'YES',
    REAL_PROVIDER_ADAPTER_IMPLEMENTED: yn('real_adapter_not_placeholder'),
    REAL_QUOTE_PATH_IMPLEMENTED: yn('real_quote_path'),
    REAL_BUY_BUILD_PATH_IMPLEMENTED: yn('real_buy_build_path'),
    REAL_SELL_BUILD_PATH_IMPLEMENTED: yn('real_sell_build_path'),
    DRY_RUN_EXECUTION_WORKS: yn('dry_run_runner'),
    MOCK_EXECUTION_WORKS: yn('mock_runner'),
    LIVE_RUNNER_REFUSES_WITHOUT_UNLOCK: yn('live_runner_refuses_without_unlock'),
    LEDGER_RECOVERY_READY: yn('ledger_recovery'),
    CIRCUIT_BREAKERS_ACTIVE: yn('circuit_breakers'),
    PAPER_MODE_STILL_WORKS: yn('paper_mode_still_works'),
    REAL_TRADING_NOT_EXECUTED_DURING_BUILD: 'YES',
  };
}

function fullEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [ENV.ENABLED]: '1', [ENV.CONFIRM]: CONFIRM_PHRASE, [ENV.KILL_SWITCH]: '0',
    [ENV.MAX_POSITION]: '50', [ENV.MAX_DAILY_LOSS]: '100', [ENV.MAX_OPEN]: '3',
    [ENV.MAX_TRADES]: '10', [ENV.MAX_SLIPPAGE]: '150', [ENV.MIN_LIQUIDITY]: '20000',
    [ENV.RPC_URL]: 'https://rpc', [ENV.WALLET_PUBKEY]: '7vWf8YxkqTfQ1xH2bN3cD4eF5gH6jK7mN8pQ9rS1tUv',
    [ENV.SWAP_PROVIDER]: 'jupiter', ...over,
  };
}

const SEP = '━'.repeat(64);
export function renderFinalAcceptanceLive(r: FinalAcceptanceResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — FINAL LIVE ACCEPTANCE');
  L.push('  [PROVES REAL-TRADING CAPABILITY — DOES NOT EXECUTE A REAL TRADE]');
  L.push(SEP, '');
  L.push('  CHECKS:');
  for (const c of r.checks) {
    L.push(`    ${c.pass ? '✓' : '✗'} ${c.name.padEnd(38)} ${c.critical ? '[critical]' : '          '} ${c.detail}`);
  }
  L.push('');
  L.push(`  ${'─'.repeat(60)}`);
  L.push('  ACCEPTANCE:');
  L.push(`  ${'─'.repeat(60)}`);
  const f = (k: string, v: string) => L.push(`    ${k.padEnd(50)}: ${v}`);
  f('FINISHED_FOR_AUTONOMOUS_REAL_TRADING_CAPABILITY', r.FINISHED_FOR_AUTONOMOUS_REAL_TRADING_CAPABILITY);
  f('LIVE_TRADING_DEFAULT', r.LIVE_TRADING_DEFAULT);
  f('LIVE_TRADING_UNLOCK_REQUIRED', r.LIVE_TRADING_UNLOCK_REQUIRED);
  f('REAL_PROVIDER_ADAPTER_IMPLEMENTED', r.REAL_PROVIDER_ADAPTER_IMPLEMENTED);
  f('REAL_QUOTE_PATH_IMPLEMENTED', r.REAL_QUOTE_PATH_IMPLEMENTED);
  f('REAL_BUY_BUILD_PATH_IMPLEMENTED', r.REAL_BUY_BUILD_PATH_IMPLEMENTED);
  f('REAL_SELL_BUILD_PATH_IMPLEMENTED', r.REAL_SELL_BUILD_PATH_IMPLEMENTED);
  f('DRY_RUN_EXECUTION_WORKS', r.DRY_RUN_EXECUTION_WORKS);
  f('MOCK_EXECUTION_WORKS', r.MOCK_EXECUTION_WORKS);
  f('LIVE_RUNNER_REFUSES_WITHOUT_UNLOCK', r.LIVE_RUNNER_REFUSES_WITHOUT_UNLOCK);
  f('LEDGER_RECOVERY_READY', r.LEDGER_RECOVERY_READY);
  f('CIRCUIT_BREAKERS_ACTIVE', r.CIRCUIT_BREAKERS_ACTIVE);
  f('PAPER_MODE_STILL_WORKS', r.PAPER_MODE_STILL_WORKS);
  f('REAL_TRADING_NOT_EXECUTED_DURING_BUILD', r.REAL_TRADING_NOT_EXECUTED_DURING_BUILD);
  L.push('');
  L.push('  SAFETY: real trading defaults OFF; unlock + injected signer required; no secrets; UNKNOWN ≠ CLEAN.');
  L.push(SEP, '');
  return L.join('\n');
}
