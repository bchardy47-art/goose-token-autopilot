// DO_NOT_ENABLE_REAL_TRADING_BY_DEFAULT  defaultMode=dry-run  exitsBeforeEntries=true
//
// Live Runner v1 — one autonomous trade cycle: recover state → monitor exits FIRST →
// fetch approved candidates → per candidate (entry signal → risk gate → quote → buy).
// Default mode is dry-run (plans only). Mock executes a synthetic fill. Live submits a
// real order ONLY when fully unlocked AND a signer is injected (the adapter enforces
// this). Every step writes a ledger event before/after.
//
// Never calls forbidden commands (token:auto-paper / token:paper-buy). Never holds keys.

import * as fs   from 'fs';
import * as path from 'path';

import {
  resolveLiveTradingConfig, type LiveTradingConfig, type ExecutionMode,
} from './ripperLiveTradingConfig';
import {
  appendLedgerEvent, recoverTradingState, getTradesToday, getDailyLoss, readLedger,
  DEFAULT_LEDGER_PATH, type LedgerEvent, type OpenPosition,
} from './ripperRealTradingLedger';
import {
  createExecutionAdapter, usdToLamports, SOL_MINT,
  type ExecutionAdapter, type TransactionSigner, type FetchLike,
} from './ripperRealExecutionAdapter';
import { evaluateLiveRiskGate, type RiskCandidate } from './ripperLiveRiskGate';
import {
  recoverOpenPositions, priceOpenPositions, evaluateExit, buildExitOrder, closePosition,
  DEFAULT_EXIT_POLICY, type Pricer, type ExitPolicy,
} from './ripperLivePositionManager';

const DEFAULT_CYCLES_DIR = 'data/token-grab/ripper/cycles';
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_INTENDED_USD   = 10;
const DEFAULT_SOL_USD        = 150;   // fallback SOL/USD for sizing if no pricer

export interface LiveRunnerOptions {
  mode?:            ExecutionMode;
  once?:            boolean;
  maxCandidates?:   number;
  intendedUsd?:     number;
  maxPositionUsd?:  number;
  maxOpenPositions?: number;
  maxDailyLossUsd?: number;
  maxTradesPerDay?: number;
  bubbleMapsCap?:   number;          // accepted/forwarded (no live BubbleMaps call here)
  allowUnknownClusterOverride?: boolean;
  // paths / injection
  cyclesDir?:       string;
  ledgerPath?:      string;
  runId?:           string;
  now?:             Date;
  // dependency injection (tests)
  env?:             Record<string, string | undefined>;
  config?:          LiveTradingConfig;
  adapter?:         ExecutionAdapter;
  pricer?:          Pricer;
  loadCandidates?:  () => RiskCandidate[];
  latestCycleTime?: string | null;
  signer?:          TransactionSigner | null;
  exitPolicy?:      ExitPolicy;
  fetchFn?:         FetchLike;
  solUsdPrice?:     number;
}

export interface CandidateOutcome {
  contract:    string;
  symbol:      string | null;
  gatePassed:  boolean;
  action:      'PLANNED_BUY' | 'MOCK_BUY' | 'LIVE_BUY_SUBMITTED' | 'BLOCKED' | 'QUOTE_ONLY';
  reasons:     string[];
  txSignature: string | null;
  quoteId:     string | null;
}

export interface ExitOutcome {
  contract:    string;
  trigger:     string;
  action:      'PLANNED_SELL' | 'MOCK_SELL' | 'LIVE_SELL_SUBMITTED' | 'HELD' | 'BLOCKED';
  txSignature: string | null;
}

export interface LiveRunnerResult {
  runId:           string;
  mode:            ExecutionMode;
  liveUnlocked:    boolean;
  blocked:         boolean;
  blockReason:     string | null;
  openPositionsAtStart: number;
  exitsEvaluated:  ExitOutcome[];
  candidatesConsidered: number;
  candidateOutcomes: CandidateOutcome[];
  tradesToday:     number;
  dailyLoss:       number;
  ledgerEventsWritten: number;
  safetyFlags:     Record<string, unknown>;
}

function makeRunId(now: Date): string {
  return `run_${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${process.pid.toString(36)}`;
}

// ── Default candidate loader: latest cycle file, approved rows only ───────────────
function loadApprovedCandidatesFromCycles(cyclesDir: string): { candidates: RiskCandidate[]; latestCycleTime: string | null } {
  if (!fs.existsSync(cyclesDir)) return { candidates: [], latestCycleTime: null };
  const files = fs.readdirSync(cyclesDir)
    .filter(f => /^cycle-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(f)).sort();
  const latest = files.at(-1);
  if (!latest) return { candidates: [], latestCycleTime: null };
  const candidates: RiskCandidate[] = [];
  let latestCycleTime: string | null = null;
  for (const line of fs.readFileSync(path.join(cyclesDir, latest), 'utf-8').split('\n')) {
    const t = line.trim(); if (!t) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(t); } catch { continue; }
    const capturedAt = typeof d['capturedAt'] === 'string' ? (d['capturedAt'] as string) : null;
    if (capturedAt && (!latestCycleTime || capturedAt > latestCycleTime)) latestCycleTime = capturedAt;
    if (d['buyGateDecision'] !== 'BUY_APPROVED_PAPER') continue;
    const ns = (d['normalizedSignal'] ?? {}) as Record<string, unknown>;
    const raw = (d['raw'] ?? {}) as Record<string, unknown>;
    candidates.push({
      contract: String(ns['contract'] ?? raw['contract'] ?? 'unknown'),
      symbol: (ns['symbol'] as string) ?? null,
      buyGateDecision: 'BUY_APPROVED_PAPER',
      clusterRisk: (raw['clusterRisk'] as string) ?? null,
      liquidityUsd: typeof ns['liquidityUsd'] === 'number' ? (ns['liquidityUsd'] as number) : null,
      entryMomentumPct: typeof d['entryMomentumPct'] === 'number' ? (d['entryMomentumPct'] as number) : null,
      expectedBaselinePnl: null,   // no forward predictor wired — gate warns rather than fabricates edge
      capturedAt,
    });
  }
  return { candidates, latestCycleTime };
}

export async function runLiveRunner(opts: LiveRunnerOptions = {}): Promise<LiveRunnerResult> {
  const now = opts.now ?? new Date();
  const runId = opts.runId ?? makeRunId(now);
  const ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const mode: ExecutionMode = opts.mode ?? opts.config?.executionMode ?? 'dry-run';
  const config = opts.config ?? resolveLiveTradingConfig({ env: opts.env, modeOverride: mode });
  const rpcUrl = (opts.env?.['TOKEN_GRAB_RPC_URL'] ?? opts.env?.['SOLANA_RPC_URL'] ?? process.env['TOKEN_GRAB_RPC_URL'] ?? process.env['SOLANA_RPC_URL'] ?? null);
  const adapter = opts.adapter ?? createExecutionAdapter(mode, config, rpcUrl, { fetchFn: opts.fetchFn });
  const exitPolicy = opts.exitPolicy ?? DEFAULT_EXIT_POLICY;
  const solUsd = opts.solUsdPrice ?? DEFAULT_SOL_USD;
  const dryRun = mode === 'dry-run', mock = mode === 'mock', live = mode === 'live';
  const safetyFlags = { mode, liveUnlocked: config.liveUnlocked, killSwitchOn: config.killSwitchOn, realTradingDefaultsOff: true };

  let ledgerWrites = 0;
  const append = (e: Parameters<typeof appendLedgerEvent>[0]) => {
    appendLedgerEvent({ runId, mode, dryRun, mock, live, walletPublicKey: config.walletPublicKey, ...e }, ledgerPath);
    ledgerWrites += 1;
  };

  // ── Run start / hard blocks ──────────────────────────────────────────────────
  if (config.killSwitchOn) {
    append({ type: 'LIVE_RUN_BLOCKED', reason: 'KILL_SWITCH_ON' });
    return blockedResult(runId, mode, config, 'Kill switch ON', ledgerWrites, safetyFlags);
  }
  if (live && !config.liveUnlocked) {
    append({ type: 'LIVE_RUN_BLOCKED', reason: 'LIVE_NOT_UNLOCKED' });
    return blockedResult(runId, mode, config, 'Live mode requested but config not unlocked', ledgerWrites, safetyFlags);
  }
  append({ type: 'LIVE_RUN_STARTED', reason: `mode=${mode}`, safetyFlags });

  const events: LedgerEvent[] = readLedger(ledgerPath);
  const openPositions: OpenPosition[] = recoverOpenPositions(events);
  const tradesToday = getTradesToday(events, now);
  const dailyLoss = getDailyLoss(events, now);

  // ── 1) EXITS FIRST ───────────────────────────────────────────────────────────
  const exitsEvaluated: ExitOutcome[] = [];
  if (openPositions.length > 0 && opts.pricer) {
    const pricings = await priceOpenPositions(openPositions, opts.pricer, now);
    const byContract = new Map(pricings.map(p => [p.contract, p]));
    for (const pos of openPositions) {
      const pr = byContract.get(pos.contract)!;
      const evalExit = evaluateExit({ position: pos, pricing: pr, policy: exitPolicy, now, killSwitchOn: config.killSwitchOn });
      if (!evalExit.shouldExit) { exitsEvaluated.push({ contract: pos.contract, trigger: evalExit.trigger, action: 'HELD', txSignature: null }); continue; }
      append({ type: 'LIVE_EXIT_SIGNAL', contract: pos.contract, symbol: pos.symbol, side: 'SELL', reason: evalExit.reason, decision: evalExit.trigger });
      try {
        const { quote, built } = await buildExitOrder({ adapter, position: pos, slippageBps: config.limits.maxSlippageBps ?? 150, userPublicKey: config.walletPublicKey ?? 'unknown' });
        append({ type: 'LIVE_SELL_SUBMITTED', contract: pos.contract, side: 'SELL', quoteId: quote.quoteId, reason: evalExit.trigger });
        const res = await closePosition({ adapter, built, liveUnlocked: config.liveUnlocked, signer: opts.signer ?? null, rpcUrl });
        if (res.submitted) {
          append({ type: 'LIVE_SELL_CONFIRMED', contract: pos.contract, side: 'SELL', txSignature: res.txSignature, reason: res.reason });
          append({ type: 'LIVE_POSITION_CLOSED', contract: pos.contract, symbol: pos.symbol, exitPrice: pr.currentPrice, reason: evalExit.trigger, txSignature: res.txSignature });
          exitsEvaluated.push({ contract: pos.contract, trigger: evalExit.trigger, action: mock ? 'MOCK_SELL' : 'LIVE_SELL_SUBMITTED', txSignature: res.txSignature });
        } else {
          append({ type: 'LIVE_EXIT_SIGNAL', contract: pos.contract, reason: `planned-only: ${res.reason}` });
          exitsEvaluated.push({ contract: pos.contract, trigger: evalExit.trigger, action: 'PLANNED_SELL', txSignature: null });
        }
      } catch (err) {
        append({ type: 'LIVE_SELL_FAILED', contract: pos.contract, reason: errMsg(err) });
        exitsEvaluated.push({ contract: pos.contract, trigger: evalExit.trigger, action: 'BLOCKED', txSignature: null });
      }
    }
  }

  // ── 2) ENTRIES ────────────────────────────────────────────────────────────────
  const loaded = opts.loadCandidates
    ? { candidates: opts.loadCandidates(), latestCycleTime: opts.latestCycleTime ?? null }
    : loadApprovedCandidatesFromCycles(opts.cyclesDir ?? DEFAULT_CYCLES_DIR);
  const latestCycleTime = opts.latestCycleTime ?? loaded.latestCycleTime;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const intendedUsd = Math.min(opts.intendedUsd ?? DEFAULT_INTENDED_USD, opts.maxPositionUsd ?? config.limits.maxPositionUsd ?? Infinity);

  const candidateOutcomes: CandidateOutcome[] = [];
  const considered = loaded.candidates.slice(0, maxCandidates);
  // Track open positions as we (hypothetically) add this run, so the gate respects max-open.
  const runningOpen = [...openPositions];

  for (const cand of considered) {
    append({ type: 'LIVE_ENTRY_SIGNAL', contract: cand.contract, symbol: cand.symbol, side: 'BUY', decision: cand.buyGateDecision });
    const gate = evaluateLiveRiskGate({
      candidate: cand, intendedUsd, mode, config,
      openPositions: runningOpen, tradesToday, dailyLoss, latestCycleTime, now,
      allowUnknownClusterOverride: opts.allowUnknownClusterOverride,
    });
    if (!gate.allow) {
      append({ type: 'LIVE_ENTRY_PRECHECK_BLOCKED', contract: cand.contract, reason: gate.blockReasons.join('; '), riskSnapshot: { ...gate.riskSnapshot } });
      candidateOutcomes.push({ contract: cand.contract, symbol: cand.symbol, gatePassed: false, action: 'BLOCKED', reasons: gate.blockReasons, txSignature: null, quoteId: null });
      continue;
    }
    append({ type: 'LIVE_ENTRY_PRECHECK_PASSED', contract: cand.contract, riskSnapshot: { ...gate.riskSnapshot }, intendedUsd });

    // Quote (real in dry-run/live; synthetic in mock).
    append({ type: 'LIVE_QUOTE_REQUESTED', contract: cand.contract, intendedUsd });
    let quoteId: string | null = null;
    try {
      const amountRaw = usdToLamports(intendedUsd, solUsd);
      const quote = await adapter.getQuote({ inputMint: SOL_MINT, outputMint: cand.contract, amountRaw, slippageBps: config.limits.maxSlippageBps ?? 150 });
      quoteId = quote.quoteId;
      append({ type: 'LIVE_QUOTE_RECEIVED', contract: cand.contract, quoteId, reason: `out=${quote.outAmountRaw}` });

      if (dryRun) {
        // Plan only — never build/submit.
        append({ type: 'LIVE_BUY_SUBMITTED', contract: cand.contract, side: 'BUY', quoteId, intendedUsd, reason: 'DRY_RUN_PLANNED (not submitted)' });
        candidateOutcomes.push({ contract: cand.contract, symbol: cand.symbol, gatePassed: true, action: 'PLANNED_BUY', reasons: [], txSignature: null, quoteId });
        continue;
      }
      // mock or live: build + submit (adapter enforces dry-run/unlock rules).
      const built = await adapter.buildBuy({ quote, userPublicKey: config.walletPublicKey ?? 'unknown' });
      append({ type: 'LIVE_BUY_SUBMITTED', contract: cand.contract, side: 'BUY', quoteId, intendedUsd });
      const res = await adapter.submitTransaction({ built, liveUnlocked: config.liveUnlocked, signer: opts.signer ?? null, rpcUrl: rpcUrl ?? undefined });
      if (res.submitted) {
        append({ type: 'LIVE_BUY_CONFIRMED', contract: cand.contract, side: 'BUY', txSignature: res.txSignature, intendedUsd, actualUsd: intendedUsd });
        append({ type: 'LIVE_POSITION_OPENED', contract: cand.contract, symbol: cand.symbol, entryPrice: priceFromQuote(quote.inAmountRaw, quote.outAmountRaw), tokenAmount: Number(quote.outAmountRaw), intendedUsd, actualUsd: intendedUsd, txSignature: res.txSignature });
        runningOpen.push({ contract: cand.contract, symbol: cand.symbol, runId, openedAt: now.toISOString(), entryPrice: null, tokenAmount: Number(quote.outAmountRaw), intendedUsd, actualUsd: intendedUsd, txSignature: res.txSignature, walletPublicKey: config.walletPublicKey, mode });
        candidateOutcomes.push({ contract: cand.contract, symbol: cand.symbol, gatePassed: true, action: mock ? 'MOCK_BUY' : 'LIVE_BUY_SUBMITTED', reasons: [], txSignature: res.txSignature, quoteId });
      } else {
        append({ type: 'LIVE_BUY_FAILED', contract: cand.contract, reason: res.reason });
        candidateOutcomes.push({ contract: cand.contract, symbol: cand.symbol, gatePassed: true, action: 'BLOCKED', reasons: [res.reason], txSignature: null, quoteId });
      }
    } catch (err) {
      append({ type: 'LIVE_BUY_FAILED', contract: cand.contract, reason: errMsg(err) });
      candidateOutcomes.push({ contract: cand.contract, symbol: cand.symbol, gatePassed: true, action: 'BLOCKED', reasons: [errMsg(err)], txSignature: null, quoteId });
    }
  }

  append({ type: 'LIVE_RUN_FINISHED', reason: `candidates=${candidateOutcomes.length} exits=${exitsEvaluated.length}` });

  return {
    runId, mode, liveUnlocked: config.liveUnlocked, blocked: false, blockReason: null,
    openPositionsAtStart: openPositions.length, exitsEvaluated,
    candidatesConsidered: considered.length, candidateOutcomes,
    tradesToday, dailyLoss, ledgerEventsWritten: ledgerWrites, safetyFlags,
  };
}

function blockedResult(runId: string, mode: ExecutionMode, config: LiveTradingConfig, reason: string, writes: number, safetyFlags: Record<string, unknown>): LiveRunnerResult {
  return {
    runId, mode, liveUnlocked: config.liveUnlocked, blocked: true, blockReason: reason,
    openPositionsAtStart: 0, exitsEvaluated: [], candidatesConsidered: 0, candidateOutcomes: [],
    tradesToday: 0, dailyLoss: 0, ledgerEventsWritten: writes, safetyFlags,
  };
}

function priceFromQuote(inRaw: string, outRaw: string): number | null {
  const i = Number(inRaw), o = Number(outRaw);
  if (!Number.isFinite(i) || !Number.isFinite(o) || o <= 0) return null;
  return i / o;
}
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

// ── Renderer ──────────────────────────────────────────────────────────────────

const SEP = '━'.repeat(64);
export function renderLiveRunner(r: LiveRunnerResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — LIVE RUNNER');
  L.push(`  [mode=${r.mode}  liveUnlocked=${r.liveUnlocked}  REAL TRADING DEFAULTS OFF]`);
  L.push(SEP, '');
  L.push(`  runId               : ${r.runId}`);
  if (r.blocked) {
    L.push(`  RUN BLOCKED         : ${r.blockReason}`);
  }
  L.push(`  open positions      : ${r.openPositionsAtStart}`);
  L.push(`  exits evaluated     : ${r.exitsEvaluated.length}`);
  for (const e of r.exitsEvaluated) L.push(`    - ${e.contract.slice(0, 12)} ${e.trigger} → ${e.action}`);
  L.push(`  candidates          : ${r.candidatesConsidered}`);
  for (const c of r.candidateOutcomes) {
    L.push(`    - ${(c.symbol ?? c.contract.slice(0, 8)).padEnd(12)} ${c.gatePassed ? 'PASS' : 'BLOCK'} → ${c.action}${c.reasons.length ? '  (' + c.reasons[0] + ')' : ''}`);
  }
  L.push(`  trades today        : ${r.tradesToday}`);
  L.push(`  daily loss          : $${r.dailyLoss}`);
  L.push(`  ledger events       : ${r.ledgerEventsWritten}`);
  L.push('');
  L.push('  SAFETY: real trading defaults OFF; live requires unlock + injected signer; UNKNOWN ≠ CLEAN.');
  L.push(SEP, '');
  return L.join('\n');
}
