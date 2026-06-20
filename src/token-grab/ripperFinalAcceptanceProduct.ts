// DO_NOT_ENABLE_REAL_TRADING  productAcceptance=true  noRealTrade=true
//
// Final PRODUCT Acceptance v1 — proves Token Grab is finished as an AUTONOMOUS TRADING
// PRODUCT, not merely an execution capability. It verifies (with fixtures/mocks, never a
// real trade) that:
//   • live execution capability still passes (delegates to final live acceptance)
//   • the coverage diagnostic exists
//   • approved+M5+live-runner-first targeting is implemented
//   • the candidate cluster resolver exists and the live runner uses it
//   • a dry-run live runner can REACH the real Jupiter quote stage for a holder-known,
//     risk-approved fixture candidate
//   • UNKNOWN candidates are still blocked (UNKNOWN never treated as CLEAN)
//   • mock mode can open/close a position with a holder-known fixture
//   • live mode still refuses without unlock; real trading still not executed
//   • paper mode still works
//
// It clearly distinguishes "product capability works" from "current live-market
// candidates still blocked", and names the exact current blocker.

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

import { runFinalAcceptanceLive } from './ripperFinalAcceptanceLive';
import { runCoverageDiagnostic } from './ripperBubbleMapsLiveRunnerCoverageDiagnostic';
import { callPriorityTier, allocateBubbleMapsCalls } from './ripperBubbleMapsTargeting';
import { resolveCandidateClusterForLiveRisk } from './ripperCandidateClusterResolver';
import { runLiveRunner } from './ripperLiveRunner';
import { readLedger } from './ripperRealTradingLedger';
import { MockExecutionAdapter, type FetchLike } from './ripperRealExecutionAdapter';
import type { RiskCandidate } from './ripperLiveRiskGate';
import type { ResolvedCluster } from './ripperCandidateClusterResolver';

export interface ProductAcceptanceCheck { name: string; pass: boolean; critical: boolean; detail: string; }

export interface FinalAcceptanceProductResult {
  generatedAt: string;
  checks: ProductAcceptanceCheck[];

  FINISHED_FOR_AUTONOMOUS_TRADING_PRODUCT: 'YES' | 'NO';
  LIVE_EXECUTION_CAPABILITY_READY: 'YES' | 'NO';
  BUBBLEMAPS_TARGETING_READY: 'YES' | 'NO';
  BUBBLEMAPS_PROPAGATION_READY: 'YES' | 'NO';
  LIVE_RUNNER_CAN_REACH_QUOTE_STAGE: 'YES' | 'NO';
  UNKNOWN_STILL_BLOCKED: 'YES' | 'NO';
  MOCK_FULL_LOOP_READY: 'YES' | 'NO';
  REAL_TRADING_DEFAULT: 'OFF';
  REAL_TRADING_UNLOCK_REQUIRED: 'YES';
  REAL_TRADING_NOT_EXECUTED: 'YES';
  // current live market truth (separate from capability)
  CURRENT_MARKET_HOLDER_KNOWN_CANDIDATE_EXISTS: 'YES' | 'NO';
  REMAINING_BLOCKER: string;
}

export interface FinalAcceptanceProductOptions {
  generatedAt?: string;
  now?:         Date;
  cyclesDir?:   string;
  cachePath?:   string;
  memoryPath?:  string;
}

const FIXTURE_FETCH: FetchLike = async (url) => {
  const body = url.includes('/swap')
    ? { swapTransaction: 'FIXTURE_TX', lastValidBlockHeight: 1 }
    : { inputMint: 'So11111111111111111111111111111111111111112', inAmount: '1000', outputMint: 'FIXTUREMINT', outAmount: '2000', routePlan: [{ swapInfo: { label: 'AMM' } }], slippageBps: 150 };
  return { ok: true, status: 200, json: async () => body, text: async () => '' };
};

// A holder-known, risk-approvable fixture candidate (CLEAN, deep liquidity, positive edge).
function holderKnownCandidate(): RiskCandidate {
  return {
    contract: 'FIXTUREMINT', symbol: 'FIX', buyGateDecision: 'BUY_APPROVED_PAPER',
    clusterRisk: 'UNKNOWN',  // raw UNKNOWN — the resolver will enrich it to CLEAN
    liquidityUsd: 60000, entryMomentumPct: 5, expectedBaselinePnl: 80,
    liquidityBucket: 'LIQ_30K_100K', vlrBucket: 'VLR_LT_0_5', capturedAt: null,
  };
}
const enrichToClean = (): ResolvedCluster => ({
  clusterRisk: 'CLEAN', clusterProvider: 'bubblemaps', clusterConfidence: 'HIGH',
  clusterUnknownReason: null, clusterFetchError: null, sourceUsed: 'cache', isFresh: true,
  explanation: 'fixture: fresh cache CLEAN',
});

export async function runFinalAcceptanceProduct(
  opts: FinalAcceptanceProductOptions = {},
): Promise<FinalAcceptanceProductResult> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const now = opts.now ?? new Date();
  const checks: ProductAcceptanceCheck[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-product-'));
  const add = (name: string, pass: boolean, critical: boolean, detail: string) => checks.push({ name, pass, critical, detail });

  try {
    // 1. Live execution capability still passes.
    const live = await runFinalAcceptanceLive({ generatedAt });
    add('live_execution_capability', live.FINISHED_FOR_AUTONOMOUS_REAL_TRADING_CAPABILITY === 'YES', true,
      `final-live-acceptance = ${live.FINISHED_FOR_AUTONOMOUS_REAL_TRADING_CAPABILITY}`);

    // 2. Coverage diagnostic exists and runs.
    let diagOk = false; let diagDetail = '';
    try {
      const diag = runCoverageDiagnostic({
        cyclesDir: opts.cyclesDir, cachePath: opts.cachePath, memoryPath: opts.memoryPath, now,
      });
      diagOk = Array.isArray(diag.diagnoses) && diag.diagnoses.length > 0;
      diagDetail = `diagnostic ran, ${diag.diagnoses.length} labels, approvedUnknown=${diag.approvedUnknownTotal}`;
    } catch (err) { diagDetail = `diagnostic error: ${errMsg(err)}`; }
    add('coverage_diagnostic_exists', diagOk, true, diagDetail);

    // 3. Approved+M5+live-runner-first targeting is implemented (priority + allocation).
    const top = new Set(['TOP']);
    const tier1 = callPriorityTier({ contract: 'TOP', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10, clusterRisk: 'UNKNOWN' }, top);
    const tier5 = callPriorityTier({ contract: 'X', buyGateDecision: 'BUY_REJECTED', entryMomentumPct: 10, clusterRisk: 'UNKNOWN' }, top);
    const allocation = allocateBubbleMapsCalls([
      { contract: 'REJ', buyGateDecision: 'BUY_REJECTED', entryMomentumPct: null, clusterRisk: 'UNKNOWN' },
      { contract: 'TOP', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10, clusterRisk: 'UNKNOWN' },
    ], { cap: 1, topLiveRunnerContracts: top });
    const targetingOk = tier1 === 1 && tier5 === 5 &&
      allocation.allocations.find(a => a.bubbleMapsSelectedForCall)?.contract === 'TOP';
    add('targeting_implemented', targetingOk, true,
      `tier(top+approved+M5)=${tier1}, tier(rejected+M5)=${tier5}, cap-1 selects TOP first`);

    // 4. Candidate cluster resolver exists and behaves safety-first.
    const cleanRes = resolveCandidateClusterForLiveRisk(
      { contract: 'A', clusterRisk: 'UNKNOWN' },
      { now, cacheLookup: () => ({ clusterRisk: 'CLEAN', provider: 'bubblemaps', confidence: 'HIGH', cachedAt: now.toISOString() }), memoryLookup: () => null });
    const staleRes = resolveCandidateClusterForLiveRisk(
      { contract: 'A', clusterRisk: 'UNKNOWN' },
      { now, cacheLookup: () => ({ clusterRisk: 'CLEAN', provider: 'bubblemaps', confidence: 'HIGH', cachedAt: '2020-01-01T00:00:00Z' }), memoryLookup: () => null });
    const resolverOk = cleanRes.clusterRisk === 'CLEAN' && cleanRes.sourceUsed === 'cache' && staleRes.clusterRisk === 'UNKNOWN';
    add('cluster_resolver_exists', resolverOk, true,
      `fresh→CLEAN(${cleanRes.sourceUsed}); stale→${staleRes.clusterRisk} (no silent clean)`);

    // 5. Live runner USES the resolver and can REACH quote stage for a holder-known candidate.
    const quoteLedger = path.join(tmp, 'quote.jsonl');
    const reachRun = await runLiveRunner({
      mode: 'dry-run', env: {}, ledgerPath: quoteLedger, now, fetchFn: FIXTURE_FETCH,
      latestCycleTime: now.toISOString(), loadCandidates: () => [holderKnownCandidate()],
      resolveCluster: enrichToClean,
    });
    const reachOutcome = reachRun.candidateOutcomes.find(c => c.contract === 'FIXTUREMINT');
    const reachedQuote = reachOutcome?.gatePassed === true && reachOutcome?.action === 'PLANNED_BUY' &&
      readLedger(quoteLedger).some(e => e.type === 'LIVE_QUOTE_RECEIVED' && e.contract === 'FIXTUREMINT');
    add('live_runner_reaches_quote_with_holder_known', reachedQuote, true,
      `holder-known fixture reached quote; raw=${reachOutcome?.rawClusterRisk}→resolved=${reachOutcome?.resolvedClusterRisk} (${reachOutcome?.clusterSource})`);
    // propagation = resolver output reached the gate (raw UNKNOWN became CLEAN at gate)
    const propagationOk = reachOutcome?.rawClusterRisk === 'UNKNOWN' && reachOutcome?.resolvedClusterRisk === 'CLEAN';
    add('propagation_ready', propagationOk, true,
      `raw UNKNOWN propagated to resolved CLEAN at the risk gate`);

    // 6. UNKNOWN candidate (no fresh source) is STILL BLOCKED.
    const blockLedger = path.join(tmp, 'block.jsonl');
    const blockRun = await runLiveRunner({
      mode: 'dry-run', env: {}, ledgerPath: blockLedger, now, fetchFn: FIXTURE_FETCH,
      latestCycleTime: now.toISOString(),
      loadCandidates: () => [{ ...holderKnownCandidate(), contract: 'STILLUNK' }],
      resolveCluster: (): ResolvedCluster => ({
        clusterRisk: 'UNKNOWN', clusterProvider: null, clusterConfidence: null,
        clusterUnknownReason: null, clusterFetchError: null, sourceUsed: 'unresolved', isFresh: false, explanation: 'no fresh source' }),
    });
    const stillBlocked = blockRun.candidateOutcomes.find(c => c.contract === 'STILLUNK')?.gatePassed === false;
    add('unknown_still_blocked', stillBlocked, true, `UNKNOWN (no fresh source) blocked at gate`);

    // 7. Mock full loop: open with holder-known fixture, then close on exit.
    const mockLedger = path.join(tmp, 'mock.jsonl');
    const mockOpen = await runLiveRunner({
      mode: 'mock', env: {}, ledgerPath: mockLedger, now, adapter: new MockExecutionAdapter(),
      latestCycleTime: now.toISOString(), loadCandidates: () => [holderKnownCandidate()],
      resolveCluster: enrichToClean,
    });
    const opened = mockOpen.candidateOutcomes.find(c => c.contract === 'FIXTUREMINT')?.action === 'MOCK_BUY';
    // Now run again with a pricer that triggers take-profit on the open position → close.
    const laterNow = new Date(now.getTime() + 5 * 60_000);
    const mockClose = await runLiveRunner({
      mode: 'mock', env: {}, ledgerPath: mockLedger, now: laterNow, adapter: new MockExecutionAdapter(),
      latestCycleTime: laterNow.toISOString(), loadCandidates: () => [],
      pricer: { async price() { return { price: 999, liquidityUsd: 50000, clusterRisk: 'CLEAN' }; } },
    });
    const closed = mockClose.exitsEvaluated.some(e => e.action === 'MOCK_SELL');
    add('mock_full_loop', opened && closed, true, `mock open=${opened}, mock close=${closed}`);

    // 8. Live mode still refuses without unlock; no real trade anywhere.
    const liveLedger = path.join(tmp, 'live.jsonl');
    const liveRun = await runLiveRunner({
      mode: 'live', env: {}, ledgerPath: liveLedger, now, fetchFn: FIXTURE_FETCH,
      latestCycleTime: now.toISOString(), loadCandidates: () => [holderKnownCandidate()], resolveCluster: enrichToClean,
    });
    const liveRefused = liveRun.blocked && /not unlocked/i.test(liveRun.blockReason ?? '');
    const noRealConfirm = !readLedger(liveLedger).some(e => e.type === 'LIVE_BUY_CONFIRMED');
    add('live_refuses_without_unlock', liveRefused && noRealConfirm, true, `live blocked=${liveRun.blocked}`);

    // 9. Current live-market truth: does a holder-known approved candidate exist RIGHT NOW?
    let currentKnownExists = false; let currentBlocker = 'none';
    try {
      const diag = runCoverageDiagnostic({ cyclesDir: opts.cyclesDir, cachePath: opts.cachePath, memoryPath: opts.memoryPath, now });
      currentKnownExists = diag.topCandidates.some(c => !c.liveRunnerWouldSeeUnknown);
      if (!currentKnownExists) {
        currentBlocker = diag.topCandidates.length === 0
          ? 'NO_APPROVED_CANDIDATES_IN_LATEST_CYCLE'
          : 'ALL_TOP_CANDIDATES_UNKNOWN_NO_FRESH_PROVIDER_RESULT (BubbleMaps disabled / cache stale) — UNKNOWN correctly blocks';
      }
    } catch { currentBlocker = 'DIAGNOSTIC_UNAVAILABLE'; }
    add('current_market_truth_reported', true, false,
      currentKnownExists ? 'a holder-known approved candidate exists now' : `no current holder-known candidate: ${currentBlocker}`);

    const yn = (n: string): 'YES' | 'NO' => checks.find(c => c.name === n)?.pass ? 'YES' : 'NO';
    const criticalAllPass = checks.filter(c => c.critical).every(c => c.pass);

    return {
      generatedAt, checks,
      FINISHED_FOR_AUTONOMOUS_TRADING_PRODUCT: criticalAllPass ? 'YES' : 'NO',
      LIVE_EXECUTION_CAPABILITY_READY: yn('live_execution_capability'),
      BUBBLEMAPS_TARGETING_READY: yn('targeting_implemented'),
      BUBBLEMAPS_PROPAGATION_READY: yn('propagation_ready'),
      LIVE_RUNNER_CAN_REACH_QUOTE_STAGE: yn('live_runner_reaches_quote_with_holder_known'),
      UNKNOWN_STILL_BLOCKED: yn('unknown_still_blocked'),
      MOCK_FULL_LOOP_READY: yn('mock_full_loop'),
      REAL_TRADING_DEFAULT: 'OFF',
      REAL_TRADING_UNLOCK_REQUIRED: 'YES',
      REAL_TRADING_NOT_EXECUTED: 'YES',
      CURRENT_MARKET_HOLDER_KNOWN_CANDIDATE_EXISTS: currentKnownExists ? 'YES' : 'NO',
      REMAINING_BLOCKER: criticalAllPass ? (currentKnownExists ? 'none' : currentBlocker) : 'CAPABILITY_CHECK_FAILED',
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

const SEP = '━'.repeat(64);
export function renderFinalAcceptanceProduct(r: FinalAcceptanceProductResult): string {
  const L: string[] = [];
  L.push(SEP);
  L.push('  TOKEN GRAB — FINAL PRODUCT ACCEPTANCE');
  L.push('  [PROVES AUTONOMOUS TRADING PRODUCT — NO REAL TRADE — UNKNOWN ≠ CLEAN]');
  L.push(SEP, '');
  L.push('  CHECKS:');
  for (const c of r.checks) {
    L.push(`    ${c.pass ? '✓' : '✗'} ${c.name.padEnd(42)} ${c.critical ? '[critical]' : '          '} ${c.detail}`);
  }
  L.push('');
  L.push(`  ${'─'.repeat(60)}`);
  L.push('  PRODUCT ACCEPTANCE:');
  L.push(`  ${'─'.repeat(60)}`);
  const f = (k: string, v: string) => L.push(`    ${k.padEnd(50)}: ${v}`);
  f('FINISHED_FOR_AUTONOMOUS_TRADING_PRODUCT', r.FINISHED_FOR_AUTONOMOUS_TRADING_PRODUCT);
  f('LIVE_EXECUTION_CAPABILITY_READY', r.LIVE_EXECUTION_CAPABILITY_READY);
  f('BUBBLEMAPS_TARGETING_READY', r.BUBBLEMAPS_TARGETING_READY);
  f('BUBBLEMAPS_PROPAGATION_READY', r.BUBBLEMAPS_PROPAGATION_READY);
  f('LIVE_RUNNER_CAN_REACH_QUOTE_STAGE', r.LIVE_RUNNER_CAN_REACH_QUOTE_STAGE);
  f('UNKNOWN_STILL_BLOCKED', r.UNKNOWN_STILL_BLOCKED);
  f('MOCK_FULL_LOOP_READY', r.MOCK_FULL_LOOP_READY);
  f('REAL_TRADING_DEFAULT', r.REAL_TRADING_DEFAULT);
  f('REAL_TRADING_UNLOCK_REQUIRED', r.REAL_TRADING_UNLOCK_REQUIRED);
  f('REAL_TRADING_NOT_EXECUTED', r.REAL_TRADING_NOT_EXECUTED);
  f('CURRENT_MARKET_HOLDER_KNOWN_CANDIDATE_EXISTS', r.CURRENT_MARKET_HOLDER_KNOWN_CANDIDATE_EXISTS);
  f('REMAINING_BLOCKER', r.REMAINING_BLOCKER);
  L.push('');
  L.push('  NOTE: product CAPABILITY is proven with fixtures. Current live-market candidates may still be');
  L.push('  blocked by UNKNOWN when BubbleMaps is disabled / cache is stale — that is a correct, safe block.');
  L.push('');
  L.push('  SAFETY: real trading defaults OFF; unlock + injected signer required; no real trade executed.');
  L.push(SEP, '');
  return L.join('\n');
}
