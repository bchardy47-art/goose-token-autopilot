import fs from 'node:fs';
import path from 'node:path';
import { runDexPaperRunner, type DexPaperCycleResult, type DexPaperRunnerOptions, type EndpointFetcher } from './dexPaperRunner';
import { runDexPaperJournal, type DexPaperJournalOptions } from './dexPaperJournal';
import { runDexPaperEntryPlanner, type DexPaperEntryPlannerOptions, type DexPaperEntryPlanReport } from './dexPaperEntryPlanner';

// ── Types ──────────────────────────────────────────────────────────────────────────────

export type ValidationRecommendation =
  | 'MANUAL_REVIEW_NEEDED'
  | 'FILTERS_WORKING'
  | 'KEEP_WATCHING'
  | 'NO_SIGNAL';

export interface TopEntry {
  symbol?: string;
  contract: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
}

export interface TopBlockedMover {
  symbol?: string;
  contract: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  blockReasons: string[];
}

export interface ValidationCycleSummary {
  cycle: number;
  newestRunFile: string;
  contractsWatched: number;
  winners: number;
  losers: number;
  flat: number;
  missing: number;
  runnerCandidateTrades: number;
  fakePnl: number;
  currentCyclePaperEntry: number;
  historicalJournalWinners: number;
  blockedHistoryRisk: number;
  watchOnly: number;
  noEntry: number;
  topCurrentCycleEntries: TopEntry[];
  topBlockedMovers: TopBlockedMover[];
}

export interface ValidationLoopSummary {
  generatedAt?: string;
  cyclesRun: number;
  cycles: ValidationCycleSummary[];
  totalCurrentCycleEntries: number;
  totalWinners: number;
  recommendation: ValidationRecommendation;
  readOnly: true;
  paperOnly: true;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

export interface ValidationLoopOptions {
  dexConfigPath: string;
  signalsOut: string;
  runsDir: string;
  journalOut: string;
  plannerOut: string;
  summaryOut: string;
  fakeBankroll: number;
  positionSize: number;
  cycles: number;
  minutes: number;
  intervalSeconds: number;
  sleepBetweenCyclesMs: number;
  freshOnly?: boolean;
  generatedAt?: string;
  // Injection points
  endpointFetcher?: EndpointFetcher;
  watchFetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowFn?: () => Date;
  log?: (msg: string) => void;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────────────

/** Derive recommendation from the set of completed cycle summaries. */
export function determineRecommendation(cycles: ValidationCycleSummary[]): ValidationRecommendation {
  const totalCurrentCycle = cycles.reduce((s, c) => s + c.currentCyclePaperEntry, 0);
  const totalWinners = cycles.reduce((s, c) => s + c.winners, 0);
  const totalBlocked = cycles.reduce((s, c) => s + c.blockedHistoryRisk, 0);

  if (totalCurrentCycle > 0) return 'MANUAL_REVIEW_NEEDED';
  if (totalWinners > 0 && totalBlocked > 0) return 'FILTERS_WORKING';
  if (totalWinners > 0) return 'KEEP_WATCHING';
  return 'NO_SIGNAL';
}

/** Build a compact cycle summary from a runner result and planner report (pure). */
export function buildCycleSummary(
  cycleIndex: number,
  runnerResult: DexPaperCycleResult,
  planReport: DexPaperEntryPlanReport,
): ValidationCycleSummary {
  const missing = Math.max(
    0,
    runnerResult.contractsWatched - runnerResult.winners - runnerResult.losers - runnerResult.flat,
  );

  const topCurrentCycleEntries: TopEntry[] = planReport.plans
    .filter(p => p.recommendation === 'CURRENT_CYCLE_PAPER_ENTRY')
    .slice(0, 5)
    .map(p => ({
      symbol: p.symbol,
      contract: p.contract,
      priceChangePct: p.priceChangePct,
      liquidityChangePct: p.liquidityChangePct,
      volumeLiquidityRatio: p.volumeLiquidityRatio,
    }));

  const topBlockedMovers: TopBlockedMover[] = planReport.plans
    .filter(p => p.recommendation === 'BLOCKED_HISTORY_RISK')
    .sort((a, b) => (b.priceChangePct ?? -Infinity) - (a.priceChangePct ?? -Infinity))
    .slice(0, 5)
    .map(p => ({
      symbol: p.symbol,
      contract: p.contract,
      priceChangePct: p.priceChangePct,
      liquidityChangePct: p.liquidityChangePct,
      volumeLiquidityRatio: p.volumeLiquidityRatio,
      blockReasons: p.historyRiskReasons ?? [],
    }));

  return {
    cycle: cycleIndex,
    newestRunFile: runnerResult.savedRunPath ? path.basename(runnerResult.savedRunPath) : '',
    contractsWatched: runnerResult.contractsWatched,
    winners: runnerResult.winners,
    losers: runnerResult.losers,
    flat: runnerResult.flat,
    missing,
    runnerCandidateTrades: runnerResult.tradesSimulated,
    fakePnl: runnerResult.fakePnlDollars,
    currentCyclePaperEntry: planReport.currentCyclePaperEntry,
    historicalJournalWinners: planReport.historicalJournalWinners,
    blockedHistoryRisk: planReport.blockedHistoryRisk,
    watchOnly: planReport.watchOnly,
    noEntry: planReport.noEntry,
    topCurrentCycleEntries,
    topBlockedMovers,
  };
}

/** Assemble the final summary from all completed cycle summaries (pure). */
export function buildValidationLoopSummary(
  cycleSummaries: ValidationCycleSummary[],
  generatedAt?: string,
): ValidationLoopSummary {
  const totalCurrentCycleEntries = cycleSummaries.reduce((s, c) => s + c.currentCyclePaperEntry, 0);
  const totalWinners = cycleSummaries.reduce((s, c) => s + c.winners, 0);
  const recommendation = determineRecommendation(cycleSummaries);

  return {
    generatedAt,
    cyclesRun: cycleSummaries.length,
    cycles: cycleSummaries,
    totalCurrentCycleEntries,
    totalWinners,
    recommendation,
    readOnly: true,
    paperOnly: true,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── I/O helper ─────────────────────────────────────────────────────────────────────────

export function writeSummary(summary: ValidationLoopSummary, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf-8');
}

// ── Orchestration ─────────────────────────────────────────────────────────────────────

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function runDexValidationLoop(options: ValidationLoopOptions): Promise<ValidationLoopSummary> {
  const log = options.log ?? (() => {});
  const sleepImpl = options.sleepImpl ?? defaultSleep;

  const journalOpts: DexPaperJournalOptions = {
    dir: options.runsDir,
    out: options.journalOut,
    fakeBankroll: options.fakeBankroll,
    positionSize: options.positionSize,
  };

  const plannerOpts: DexPaperEntryPlannerOptions = {
    signalsFile: options.signalsOut,
    runsDir: options.runsDir,
    journalFile: options.journalOut,
    out: options.plannerOut,
    fakeBankroll: options.fakeBankroll,
    positionSize: options.positionSize,
  };

  const runnerBaseOpts: Omit<DexPaperRunnerOptions, 'cycles'> = {
    dexConfigPath: options.dexConfigPath,
    signalsOut: options.signalsOut,
    runsDir: options.runsDir,
    minutes: options.minutes,
    intervalSeconds: options.intervalSeconds,
    fakeBankroll: options.fakeBankroll,
    positionSize: options.positionSize,
    freshOnly: options.freshOnly ?? true,
    endpointFetcher: options.endpointFetcher,
    watchFetchImpl: options.watchFetchImpl,
    sleepImpl,
    nowFn: options.nowFn,
    log: (m) => log(`  [runner] ${m}`),
  };

  const cycleSummaries: ValidationCycleSummary[] = [];

  for (let i = 1; i <= options.cycles; i++) {
    log(`══ Validation cycle ${i}/${options.cycles} ══`);

    // 1. Run one runner cycle (fresh-only watch).
    const runnerReport = await runDexPaperRunner({ ...runnerBaseOpts, cycles: 1 });
    const runnerCycle = runnerReport.cycles[0];
    if (!runnerCycle || runnerCycle.watchSkipped) {
      log(`  [cycle ${i}] watch skipped — no fresh signals this cycle`);
      // Still need a placeholder so cycle count is correct.
      cycleSummaries.push({
        cycle: i,
        newestRunFile: '',
        contractsWatched: 0,
        winners: 0,
        losers: 0,
        flat: 0,
        missing: 0,
        runnerCandidateTrades: 0,
        fakePnl: 0,
        currentCyclePaperEntry: 0,
        historicalJournalWinners: 0,
        blockedHistoryRisk: 0,
        watchOnly: 0,
        noEntry: 0,
        topCurrentCycleEntries: [],
        topBlockedMovers: [],
      });
    } else {
      log(`  [cycle ${i}] run saved: ${path.basename(runnerCycle.savedRunPath)}`);
      log(`  [cycle ${i}] winners/losers/flat: ${runnerCycle.winners}/${runnerCycle.losers}/${runnerCycle.flat}`);

      // 2. Run journal (cumulative across all saved runs).
      const journal = runDexPaperJournal({
        ...journalOpts,
        journaledAt: options.nowFn ? options.nowFn().toISOString() : undefined,
      });
      log(`  [cycle ${i}] journal: ${journal.totalSimulatedTrades} simulated, P/L +$${journal.totalFakePnlDollars.toFixed(2)}`);

      // 3. Run planner.
      const planReport = runDexPaperEntryPlanner({
        ...plannerOpts,
        plannedAt: options.nowFn ? options.nowFn().toISOString() : undefined,
      });
      log(`  [cycle ${i}] planner: CURRENT=${planReport.currentCyclePaperEntry} HISTORICAL=${planReport.historicalJournalWinners} BLOCKED=${planReport.blockedHistoryRisk}`);

      // 4. Record cycle summary.
      cycleSummaries.push(buildCycleSummary(i, runnerCycle, planReport));
    }

    // Sleep between cycles (not after the last one).
    if (i < options.cycles && options.sleepBetweenCyclesMs > 0) {
      const mins = (options.sleepBetweenCyclesMs / 60000).toFixed(1);
      log(`  sleeping ${mins}m before cycle ${i + 1}/${options.cycles}…`);
      await sleepImpl(options.sleepBetweenCyclesMs);
    }
  }

  const summary = buildValidationLoopSummary(cycleSummaries, options.generatedAt);
  writeSummary(summary, options.summaryOut);

  log(`══ Validation loop complete ══`);
  log(`  cycles run: ${summary.cyclesRun}`);
  log(`  total current-cycle entries: ${summary.totalCurrentCycleEntries}`);
  log(`  recommendation: ${summary.recommendation}`);

  return summary;
}

// ── Usage renderer — pure ──────────────────────────────────────────────────────────────

export function renderValidationLoopUsage(): string {
  return [
    'Usage: npm run token:dex-validation-loop -- [options]',
    '',
    'Paper-only validation loop: runner → journal → planner, repeated per cycle.',
    'READ-ONLY. PAPER ONLY. No wallet. No signing. No swap. tradingExecuted: 0.',
    '',
    'Options:',
    '  --dex-config <path>                    DEX ears config (default: config/dex-ears.example.json)',
    '  --signals-out <path>                   Presignals output (default: data/token-grab/x-ears/presignals.dex.json)',
    '  --runs-dir <path>                      Watch runs directory (default: data/token-grab/dex-watch-runs)',
    '  --journal <path>                       Paper journal output (default: data/token-grab/paper-journal/dex-paper-journal.json)',
    '  --planner-out <path>                   Planner output (default: data/token-grab/paper-plans/dex-paper-entry-plan.json)',
    '  --summary-out <path>                   Validation summary output (default: data/token-grab/validation/dex-validation-loop-summary.json)',
    '  --fake-bankroll <n>                    Fake bankroll in USD (default: 20)',
    '  --position-size <n>                    Fake position size in USD (default: 1)',
    '  --cycles <n>                           Number of validation cycles (default: 3)',
    '  --minutes <n>                          Watch window per cycle in minutes (default: 10)',
    '  --interval-seconds <n>                 Snapshot interval per cycle (default: 60)',
    '  --sleep-between-cycles-minutes <n>     Sleep between cycles in minutes (default: 15)',
    '  --json                                 Output JSON instead of text',
    '  --help, -h                             Show this help and exit',
    '',
    'Final recommendation values:',
    '  MANUAL_REVIEW_NEEDED   — a current-cycle paper entry passed all filters',
    '  FILTERS_WORKING        — winners appeared but were blocked by history risk / VLR',
    '  KEEP_WATCHING          — winners moved but did not clear thresholds',
    '  NO_SIGNAL              — nothing moved above thresholds',
  ].join('\n');
}

// ── Renderer — pure ────────────────────────────────────────────────────────────────────

function fmtPct(v?: number): string {
  if (v == null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function fmtUsd(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

export function renderValidationLoopSummary(summary: ValidationLoopSummary): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX VALIDATION LOOP V1');
  lines.push('  PAPER ONLY — READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  No wallet. No signing. No swap. No liveHarness changes.');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Cycles run                   : ${summary.cyclesRun}`);
  lines.push(`  Total current-cycle entries  : ${summary.totalCurrentCycleEntries}`);
  lines.push(`  Total winners across cycles  : ${summary.totalWinners}`);
  lines.push(`  Recommendation               : ${summary.recommendation}`);

  for (const c of summary.cycles) {
    lines.push('');
    lines.push(THIN);
    lines.push(`  Cycle ${c.cycle}`);
    if (!c.newestRunFile) {
      lines.push('    Watch skipped — no fresh signals');
      continue;
    }
    lines.push(`    Newest run file      : ${c.newestRunFile}`);
    lines.push(`    Contracts watched    : ${c.contractsWatched}`);
    lines.push(`    Winners/Losers/Flat  : ${c.winners} / ${c.losers} / ${c.flat}`);
    lines.push(`    Candidate trades     : ${c.runnerCandidateTrades}`);
    lines.push(`    Fake P/L             : ${fmtUsd(c.fakePnl)}`);
    lines.push(`    CURRENT_CYCLE_ENTRY  : ${c.currentCyclePaperEntry}`);
    lines.push(`    HISTORICAL_WINNER    : ${c.historicalJournalWinners}`);
    lines.push(`    BLOCKED_HISTORY_RISK : ${c.blockedHistoryRisk}`);
    lines.push(`    WATCH_ONLY           : ${c.watchOnly}`);

    if (c.topCurrentCycleEntries.length > 0) {
      lines.push('');
      lines.push('    Current-cycle paper entries:');
      for (const e of c.topCurrentCycleEntries) {
        const sym = (e.symbol ? `$${e.symbol}` : '(no sym)').padEnd(14);
        const vlr = e.volumeLiquidityRatio != null ? e.volumeLiquidityRatio.toFixed(2) : 'n/a';
        lines.push(
          `      ${sym} price ${fmtPct(e.priceChangePct).padStart(8)}` +
            `  liq ${fmtPct(e.liquidityChangePct).padStart(8)}  v/l ${vlr}`,
        );
      }
    }

    if (c.topBlockedMovers.length > 0) {
      lines.push('');
      lines.push('    Top blocked movers (high price/liq but bad VLR/history):');
      for (const b of c.topBlockedMovers) {
        const sym = (b.symbol ? `$${b.symbol}` : '(no sym)').padEnd(14);
        const vlr = b.volumeLiquidityRatio != null ? b.volumeLiquidityRatio.toFixed(2) : 'n/a';
        lines.push(
          `      ${sym} price ${fmtPct(b.priceChangePct).padStart(8)}` +
            `  liq ${fmtPct(b.liquidityChangePct).padStart(8)}  v/l ${vlr}`,
        );
        if (b.blockReasons.length > 0) {
          lines.push(`        blocked: ${b.blockReasons.slice(0, 2).join('; ')}`);
        }
      }
    }
  }

  lines.push('');
  lines.push(WIDE);
  lines.push('  VALIDATION LOOP — paper-only — no positions opened');
  lines.push('  Fake P/L is hypothetical — no trading, no wallet, no signing, no swap');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
