import fs from 'node:fs';
import path from 'node:path';
import { runDexPaperRunner, type DexPaperCycleResult, type EndpointFetcher } from './dexPaperRunner';
import { runDexPaperJournal, type DexPaperJournalOptions } from './dexPaperJournal';
import { runDexPaperEntryPlanner, type DexPaperEntryPlannerOptions, type DexPaperEntryPlanReport } from './dexPaperEntryPlanner';
import { type TopEntry, type TopBlockedMover, determineRecommendation, type ValidationCycleSummary } from './dexValidationLoop';

// ── Types ───────────────────────────────────────────────────────────────────────────────

export type DayVerdict =
  | 'MANUAL_REVIEW_READY'
  | 'FILTERS_WORKING'
  | 'NO_CLEAN_ENTRIES_YET'
  | 'NEED_MORE_DATA';

export interface DayWatchCycleEntry {
  generatedAt: string;
  cycleNumber: number;
  newestRunFile: string;
  contractsWatched: number;
  winners: number;
  losers: number;
  flat: number;
  missing: number;
  runnerCandidateTrades: number;
  runnerFakePnl: number;
  journalTotalSimulated: number;
  journalFakePnl: number;
  plannerLatestRealRun: string;
  currentCyclePaperEntry: number;
  historicalJournalWinners: number;
  blockedHistoryRisk: number;
  watchOnly: number;
  noEntry: number;
  finalRecommendation: string;
  topCurrentCycleEntries: TopEntry[];
  topBlockedMovers: TopBlockedMover[];
  tradingExecuted: 0;
  noRealTradeSent: true;
  readOnly: true;
  paperOnly: true;
}

export interface RepeatedBlockedMover {
  contract: string;
  symbol?: string;
  appearedCount: number;
  blockReasons: string[];
}

export interface DayReport {
  generatedAt: string;
  cyclesRun: number;
  timeRange: { from: string; to: string } | null;
  totalContractsWatched: number;
  totalWinners: number;
  totalLosers: number;
  totalFlat: number;
  totalMissing: number;
  totalRunnerCandidateTrades: number;
  totalRunnerFakePnl: number;
  latestJournalFakePnl: number;
  totalCurrentCyclePaperEntryEvents: number;
  cyclesWithCurrentCycleEntry: number;
  repeatedBlockedMovers: RepeatedBlockedMover[];
  topBlockedMovers: TopBlockedMover[];
  topCurrentCycleEntries: TopEntry[];
  verdict: DayVerdict;
  readOnly: true;
  paperOnly: true;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

export interface DayWatchOptions {
  dexConfigPath: string;
  signalsOut: string;
  runsDir: string;
  journalOut: string;
  plannerOut: string;
  dayLogPath: string;
  fakeBankroll: number;
  positionSize: number;
  cycles: number;
  minutes: number;
  intervalSeconds: number;
  sleepBetweenCyclesMs: number;
  endpointFetcher?: EndpointFetcher;
  watchFetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowFn?: () => Date;
  log?: (msg: string) => void;
  stopSignal?: { stopped: boolean };
}

export interface DayWatchResult {
  cyclesRun: number;
  dayLogPath: string;
}

// ── Pure helpers ────────────────────────────────────────────────────────────────────────

export function determineDayVerdict(
  totalCurrentCyclePaperEntryEvents: number,
  totalWinners: number,
  totalBlocked: number,
): DayVerdict {
  if (totalCurrentCyclePaperEntryEvents > 0) return 'MANUAL_REVIEW_READY';
  if (totalWinners > 0 && totalBlocked > 0) return 'FILTERS_WORKING';
  if (totalWinners > 0) return 'NO_CLEAN_ENTRIES_YET';
  return 'NEED_MORE_DATA';
}

export function buildDayWatchCycleEntry(
  cycleNumber: number,
  generatedAt: string,
  runnerCycle: DexPaperCycleResult,
  journalTotalSimulated: number,
  journalFakePnl: number,
  planReport: DexPaperEntryPlanReport,
): DayWatchCycleEntry {
  const missing = Math.max(
    0,
    runnerCycle.contractsWatched - runnerCycle.winners - runnerCycle.losers - runnerCycle.flat,
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

  // Derive per-cycle recommendation by running determineRecommendation on a single-cycle view.
  const cycleSummary: ValidationCycleSummary = {
    cycle: cycleNumber,
    newestRunFile: runnerCycle.savedRunPath ? path.basename(runnerCycle.savedRunPath) : '',
    contractsWatched: runnerCycle.contractsWatched,
    winners: runnerCycle.winners,
    losers: runnerCycle.losers,
    flat: runnerCycle.flat,
    missing,
    runnerCandidateTrades: runnerCycle.tradesSimulated,
    fakePnl: runnerCycle.fakePnlDollars,
    currentCyclePaperEntry: planReport.currentCyclePaperEntry,
    historicalJournalWinners: planReport.historicalJournalWinners,
    blockedHistoryRisk: planReport.blockedHistoryRisk,
    watchOnly: planReport.watchOnly,
    noEntry: planReport.noEntry,
    topCurrentCycleEntries,
    topBlockedMovers,
  };

  return {
    generatedAt,
    cycleNumber,
    newestRunFile: runnerCycle.savedRunPath ? path.basename(runnerCycle.savedRunPath) : '',
    contractsWatched: runnerCycle.contractsWatched,
    winners: runnerCycle.winners,
    losers: runnerCycle.losers,
    flat: runnerCycle.flat,
    missing,
    runnerCandidateTrades: runnerCycle.tradesSimulated,
    runnerFakePnl: runnerCycle.fakePnlDollars,
    journalTotalSimulated,
    journalFakePnl,
    plannerLatestRealRun: planReport.latestRealRunFile ?? '',
    currentCyclePaperEntry: planReport.currentCyclePaperEntry,
    historicalJournalWinners: planReport.historicalJournalWinners,
    blockedHistoryRisk: planReport.blockedHistoryRisk,
    watchOnly: planReport.watchOnly,
    noEntry: planReport.noEntry,
    finalRecommendation: determineRecommendation([cycleSummary]),
    topCurrentCycleEntries,
    topBlockedMovers,
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  };
}

export function buildDayReport(entries: DayWatchCycleEntry[], generatedAt: string): DayReport {
  if (entries.length === 0) {
    return {
      generatedAt,
      cyclesRun: 0,
      timeRange: null,
      totalContractsWatched: 0,
      totalWinners: 0,
      totalLosers: 0,
      totalFlat: 0,
      totalMissing: 0,
      totalRunnerCandidateTrades: 0,
      totalRunnerFakePnl: 0,
      latestJournalFakePnl: 0,
      totalCurrentCyclePaperEntryEvents: 0,
      cyclesWithCurrentCycleEntry: 0,
      repeatedBlockedMovers: [],
      topBlockedMovers: [],
      topCurrentCycleEntries: [],
      verdict: 'NEED_MORE_DATA',
      readOnly: true,
      paperOnly: true,
      tradingExecuted: 0,
      noRealTradeSent: true,
    };
  }

  const timeRange = { from: entries[0].generatedAt, to: entries[entries.length - 1].generatedAt };
  const totalContractsWatched = entries.reduce((s, e) => s + e.contractsWatched, 0);
  const totalWinners = entries.reduce((s, e) => s + e.winners, 0);
  const totalLosers = entries.reduce((s, e) => s + e.losers, 0);
  const totalFlat = entries.reduce((s, e) => s + e.flat, 0);
  const totalMissing = entries.reduce((s, e) => s + e.missing, 0);
  const totalRunnerCandidateTrades = entries.reduce((s, e) => s + e.runnerCandidateTrades, 0);
  const totalRunnerFakePnl = entries.reduce((s, e) => s + e.runnerFakePnl, 0);
  const latestJournalFakePnl = entries[entries.length - 1].journalFakePnl;
  const totalCurrentCyclePaperEntryEvents = entries.reduce((s, e) => s + e.currentCyclePaperEntry, 0);
  const cyclesWithCurrentCycleEntry = entries.filter(e => e.currentCyclePaperEntry > 0).length;
  const totalBlocked = entries.reduce((s, e) => s + e.blockedHistoryRisk, 0);

  // Repeated blocked movers: contracts that appeared in topBlockedMovers in more than one cycle.
  const blockedMap = new Map<string, { symbol?: string; count: number; reasons: Set<string> }>();
  for (const entry of entries) {
    for (const b of entry.topBlockedMovers) {
      if (!blockedMap.has(b.contract)) {
        blockedMap.set(b.contract, { symbol: b.symbol, count: 0, reasons: new Set() });
      }
      const rec = blockedMap.get(b.contract)!;
      rec.count += 1;
      for (const r of b.blockReasons) rec.reasons.add(r);
    }
  }
  const repeatedBlockedMovers: RepeatedBlockedMover[] = [...blockedMap.entries()]
    .filter(([, v]) => v.count > 1)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([contract, v]) => ({
      contract,
      symbol: v.symbol,
      appearedCount: v.count,
      blockReasons: [...v.reasons],
    }));

  // Top blocked movers across all cycles: dedupe by contract, keep highest priceChangePct.
  const topBlockedByContract = new Map<string, TopBlockedMover>();
  for (const entry of entries) {
    for (const b of entry.topBlockedMovers) {
      const existing = topBlockedByContract.get(b.contract);
      if (!existing || (b.priceChangePct ?? -Infinity) > (existing.priceChangePct ?? -Infinity)) {
        topBlockedByContract.set(b.contract, b);
      }
    }
  }
  const topBlockedMovers = [...topBlockedByContract.values()]
    .sort((a, b) => (b.priceChangePct ?? -Infinity) - (a.priceChangePct ?? -Infinity))
    .slice(0, 5);

  // Top current-cycle entries from the latest cycle that had any.
  const latestWithEntry = [...entries].reverse().find(e => e.topCurrentCycleEntries.length > 0);
  const topCurrentCycleEntries = latestWithEntry?.topCurrentCycleEntries ?? [];

  return {
    generatedAt,
    cyclesRun: entries.length,
    timeRange,
    totalContractsWatched,
    totalWinners,
    totalLosers,
    totalFlat,
    totalMissing,
    totalRunnerCandidateTrades,
    totalRunnerFakePnl,
    latestJournalFakePnl,
    totalCurrentCyclePaperEntryEvents,
    cyclesWithCurrentCycleEntry,
    repeatedBlockedMovers,
    topBlockedMovers,
    topCurrentCycleEntries,
    verdict: determineDayVerdict(totalCurrentCyclePaperEntryEvents, totalWinners, totalBlocked),
    readOnly: true,
    paperOnly: true,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── I/O helpers ─────────────────────────────────────────────────────────────────────────

export function appendDayWatchEntry(entry: DayWatchCycleEntry, dayLogPath: string): void {
  fs.mkdirSync(path.dirname(dayLogPath), { recursive: true });
  fs.appendFileSync(dayLogPath, JSON.stringify(entry) + '\n', 'utf-8');
}

export function loadDayLog(dayLogPath: string): DayWatchCycleEntry[] {
  if (!fs.existsSync(dayLogPath)) return [];
  const raw = fs.readFileSync(dayLogPath, 'utf-8');
  return raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as DayWatchCycleEntry);
}

// ── Orchestration ────────────────────────────────────────────────────────────────────────

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function runDexDayWatch(options: DayWatchOptions): Promise<DayWatchResult> {
  const log = options.log ?? (() => {});
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const nowFn = options.nowFn ?? (() => new Date());
  const stopSignal = options.stopSignal ?? { stopped: false };

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

  const runnerBaseOpts = {
    dexConfigPath: options.dexConfigPath,
    signalsOut: options.signalsOut,
    runsDir: options.runsDir,
    minutes: options.minutes,
    intervalSeconds: options.intervalSeconds,
    fakeBankroll: options.fakeBankroll,
    positionSize: options.positionSize,
    freshOnly: true,
    endpointFetcher: options.endpointFetcher,
    watchFetchImpl: options.watchFetchImpl,
    sleepImpl,
    nowFn: options.nowFn,
    log: (m: string) => log(`  [runner] ${m}`),
  };

  let cyclesRun = 0;

  for (let i = 1; i <= options.cycles; i++) {
    if (stopSignal.stopped) {
      log(`  [day-watch] Stop signal received, exiting after ${cyclesRun} cycles`);
      break;
    }

    log(`══ Day Watch cycle ${i}/${options.cycles} ══`);
    const now = nowFn();

    const runnerReport = await runDexPaperRunner({ ...runnerBaseOpts, cycles: 1 });
    const runnerCycle = runnerReport.cycles[0];

    if (!runnerCycle || runnerCycle.watchSkipped) {
      log(`  [cycle ${i}] watch skipped — no fresh signals`);
      const skipped: DayWatchCycleEntry = {
        generatedAt: now.toISOString(),
        cycleNumber: i,
        newestRunFile: '',
        contractsWatched: 0,
        winners: 0,
        losers: 0,
        flat: 0,
        missing: 0,
        runnerCandidateTrades: 0,
        runnerFakePnl: 0,
        journalTotalSimulated: 0,
        journalFakePnl: 0,
        plannerLatestRealRun: '',
        currentCyclePaperEntry: 0,
        historicalJournalWinners: 0,
        blockedHistoryRisk: 0,
        watchOnly: 0,
        noEntry: 0,
        finalRecommendation: 'NO_SIGNAL',
        topCurrentCycleEntries: [],
        topBlockedMovers: [],
        tradingExecuted: 0,
        noRealTradeSent: true,
        readOnly: true,
        paperOnly: true,
      };
      appendDayWatchEntry(skipped, options.dayLogPath);
      cyclesRun++;
    } else {
      log(`  [cycle ${i}] run saved: ${path.basename(runnerCycle.savedRunPath)}`);
      log(`  [cycle ${i}] winners/losers/flat: ${runnerCycle.winners}/${runnerCycle.losers}/${runnerCycle.flat}`);

      const journal = runDexPaperJournal({
        ...journalOpts,
        journaledAt: nowFn().toISOString(),
      });
      log(`  [cycle ${i}] journal: ${journal.totalSimulatedTrades} simulated, P/L $${journal.totalFakePnlDollars.toFixed(2)}`);

      const planReport = runDexPaperEntryPlanner({
        ...plannerOpts,
        plannedAt: nowFn().toISOString(),
      });
      log(`  [cycle ${i}] planner: CURRENT=${planReport.currentCyclePaperEntry} HISTORICAL=${planReport.historicalJournalWinners} BLOCKED=${planReport.blockedHistoryRisk}`);

      const entry = buildDayWatchCycleEntry(
        i,
        now.toISOString(),
        runnerCycle,
        journal.totalSimulatedTrades,
        journal.totalFakePnlDollars,
        planReport,
      );
      appendDayWatchEntry(entry, options.dayLogPath);
      cyclesRun++;
    }

    if (i < options.cycles && options.sleepBetweenCyclesMs > 0 && !stopSignal.stopped) {
      const mins = (options.sleepBetweenCyclesMs / 60000).toFixed(1);
      log(`  sleeping ${mins}m before cycle ${i + 1}/${options.cycles}…`);
      await sleepImpl(options.sleepBetweenCyclesMs);
    }
  }

  log(`══ Day Watch complete: ${cyclesRun} cycles run ══`);
  log(`  day log: ${options.dayLogPath}`);

  return { cyclesRun, dayLogPath: options.dayLogPath };
}

// ── Usage strings — pure ─────────────────────────────────────────────────────────────────

export function renderDayWatchUsage(): string {
  return [
    'Usage: npm run token:dex-day-watch -- [options]',
    '',
    'Paper-only all-day watcher: runner → journal → planner, repeated on interval.',
    'Appends compact cycle summaries to a JSONL day log. Runs unattended.',
    'READ-ONLY. PAPER ONLY. No wallet. No signing. No swap. tradingExecuted: 0.',
    '',
    'Options:',
    '  --dex-config <path>                    DEX ears config (default: config/dex-ears.example.json)',
    '  --signals-out <path>                   Presignals output (default: data/token-grab/x-ears/presignals.dex.json)',
    '  --runs-dir <path>                      Watch runs directory (default: data/token-grab/dex-watch-runs)',
    '  --journal <path>                       Paper journal output (default: data/token-grab/paper-journal/dex-paper-journal.json)',
    '  --planner-out <path>                   Planner output (default: data/token-grab/paper-plans/dex-paper-entry-plan.json)',
    '  --day-log <path>                       Day watch JSONL log (default: data/token-grab/day-watch/dex-day-watch.jsonl)',
    '  --fake-bankroll <n>                    Fake bankroll in USD (default: 20)',
    '  --position-size <n>                    Fake position size in USD (default: 1)',
    '  --cycles <n>                           Max cycles to run (default: 24)',
    '  --minutes <n>                          Watch window per cycle in minutes (default: 10)',
    '  --interval-seconds <n>                 Snapshot interval per cycle (default: 60)',
    '  --sleep-between-cycles-minutes <n>     Sleep between cycles in minutes (default: 20)',
    '  --help, -h                             Show this help and exit',
    '',
    'Press Ctrl+C to stop cleanly after the current cycle.',
    'Writes JSONL under data/token-grab/day-watch/ by default.',
    'Run token:dex-day-report to view accumulated results.',
  ].join('\n');
}

export function renderDayReportUsage(): string {
  return [
    'Usage: npm run token:dex-day-report -- [options]',
    '',
    'Reads the day watch JSONL log and prints a human-readable report.',
    'READ-ONLY. PAPER ONLY. No wallet. No signing. No swap. tradingExecuted: 0.',
    '',
    'Options:',
    '  --day-log <path>   Day watch JSONL log (default: data/token-grab/day-watch/dex-day-watch.jsonl)',
    '  --json             Output JSON instead of text',
    '  --help, -h         Show this help and exit',
    '',
    'Final verdict values:',
    '  MANUAL_REVIEW_READY    — at least one clean current-cycle entry appeared',
    '  FILTERS_WORKING        — movers were spotted but blocked by history risk',
    '  NO_CLEAN_ENTRIES_YET   — winners moved but did not clear all thresholds',
    '  NEED_MORE_DATA         — nothing moved above thresholds yet',
  ].join('\n');
}

// ── Report renderer — pure ────────────────────────────────────────────────────────────────

function fmtPct(v?: number): string {
  if (v == null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function fmtUsd(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

const VERDICT_DESC: Record<DayVerdict, string> = {
  MANUAL_REVIEW_READY:  'At least one contract passed all filters — manual review recommended',
  FILTERS_WORKING:      'Movers were spotted and blocked by history risk — filters are active',
  NO_CLEAN_ENTRIES_YET: 'Winners spotted but did not clear all thresholds — keep watching',
  NEED_MORE_DATA:       'No contracts moved above thresholds yet — need more cycles',
};

export function renderDayReport(report: DayReport): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX DAY WATCH REPORT V1');
  lines.push('  PAPER ONLY — READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  No wallet. No signing. No swap. No liveHarness changes.');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Generated at    : ${report.generatedAt}`);
  lines.push(`  Cycles run      : ${report.cyclesRun}`);
  if (report.timeRange) {
    lines.push(`  From            : ${report.timeRange.from}`);
    lines.push(`  To              : ${report.timeRange.to}`);
  }

  lines.push('');
  lines.push(THIN);
  lines.push('  Totals');
  lines.push(THIN);
  lines.push(`  Contracts watched                : ${report.totalContractsWatched}`);
  lines.push(`  Winners                          : ${report.totalWinners}`);
  lines.push(`  Losers                           : ${report.totalLosers}`);
  lines.push(`  Flat                             : ${report.totalFlat}`);
  lines.push(`  Missing                          : ${report.totalMissing}`);
  lines.push(`  Runner candidate trades          : ${report.totalRunnerCandidateTrades}`);
  lines.push(`  Total runner fake P/L            : ${fmtUsd(report.totalRunnerFakePnl)}`);
  lines.push(`  Latest journal fake P/L          : ${fmtUsd(report.latestJournalFakePnl)}`);
  lines.push('');
  lines.push(`  CURRENT_CYCLE_PAPER_ENTRY events : ${report.totalCurrentCyclePaperEntryEvents}`);
  lines.push(`  Cycles with clean entry          : ${report.cyclesWithCurrentCycleEntry}`);

  if (report.topCurrentCycleEntries.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Top current-cycle entries');
    lines.push(THIN);
    for (const e of report.topCurrentCycleEntries) {
      const sym = (e.symbol ? `$${e.symbol}` : '(no sym)').padEnd(14);
      const vlr = e.volumeLiquidityRatio != null ? e.volumeLiquidityRatio.toFixed(2) : 'n/a';
      lines.push(
        `    ${sym} price ${fmtPct(e.priceChangePct).padStart(8)}` +
          `  liq ${fmtPct(e.liquidityChangePct).padStart(8)}  v/l ${vlr}`,
      );
    }
  }

  if (report.repeatedBlockedMovers.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Repeated blocked movers (appeared in multiple cycles)');
    lines.push(THIN);
    for (const b of report.repeatedBlockedMovers) {
      const sym = (b.symbol ? `$${b.symbol}` : '(no sym)').padEnd(14);
      lines.push(`    ${sym} appeared ${b.appearedCount}x — ${b.blockReasons.slice(0, 2).join('; ')}`);
    }
  }

  if (report.topBlockedMovers.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Top blocked movers');
    lines.push(THIN);
    for (const b of report.topBlockedMovers) {
      const sym = (b.symbol ? `$${b.symbol}` : '(no sym)').padEnd(14);
      const vlr = b.volumeLiquidityRatio != null ? b.volumeLiquidityRatio.toFixed(2) : 'n/a';
      lines.push(
        `    ${sym} price ${fmtPct(b.priceChangePct).padStart(8)}` +
          `  liq ${fmtPct(b.liquidityChangePct).padStart(8)}  v/l ${vlr}`,
      );
      if (b.blockReasons.length > 0) {
        lines.push(`      blocked: ${b.blockReasons.slice(0, 2).join('; ')}`);
      }
    }
  }

  lines.push('');
  lines.push(THIN);
  lines.push(`  Final verdict   : ${report.verdict}`);
  lines.push(`  ${VERDICT_DESC[report.verdict]}`);
  lines.push(THIN);

  lines.push('');
  lines.push(WIDE);
  lines.push('  DAY WATCH — paper-only — no positions opened');
  lines.push('  Fake P/L is hypothetical — no trading, no wallet, no signing, no swap');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
