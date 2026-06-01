import type { AppDb } from './db';
import type { AppConfig, WatchOnlySignalClass } from './types';
import { AppLogger } from './logger';
import { runWatchOnly, buildWatchOnlyReport } from './watchOnly';
import { runWatchOutcomes } from './watchOutcomes';
import { runWatchAnalysis } from './watchAnalysis';
import { buildDailyReport } from './paper/dailyReport';
import { verifySafety } from './verifySafety';

const DEFAULT_WATCH_LOOP_INTERVAL_SECONDS = 300;
const DEFAULT_WATCH_LOOP_MAX_CYCLES = 12;

export interface WatchLoopOptions {
  intervalSeconds?: number;
  maxCycles?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: AppLogger;
  onCycleSummary?: (summary: WatchCycleSummary) => void;
  stopSignal?: { stopped: boolean };
  registerSignalHandlers?: boolean;
}

export interface WatchCycleSummary {
  cycleNumber: number;
  timestamp: string;
  newOrUpdatedWatchOnlyCandidates: number;
  outcomesRecorded: number;
  totalWatchOnlyCandidates: number;
  signalClassCounts: Record<WatchOnlySignalClass, number>;
  bestCurrentMover: unknown;
  worstCurrentMover: unknown;
  paperBuysOpened: number;
  realTradeAttempts: number;
  tokensScannedToday: number | null;
  tokensScoredToday: number | null;
  finalSafetyStatus: string;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    return fallback;
  }
  return value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCycleSummary(summary: WatchCycleSummary): string {
  return [
    `[watch-cycle ${summary.cycleNumber}] ${summary.timestamp}`,
    `scanned/scored today=${summary.tokensScannedToday ?? 'n/a'}/${summary.tokensScoredToday ?? 'n/a'}`,
    `watch-only total=${summary.totalWatchOnlyCandidates}`,
    `new-updated=${summary.newOrUpdatedWatchOnlyCandidates}`,
    `outcomes=${summary.outcomesRecorded}`,
    `classes=${JSON.stringify(summary.signalClassCounts)}`,
    `best=${JSON.stringify(summary.bestCurrentMover)}`,
    `worst=${JSON.stringify(summary.worstCurrentMover)}`,
    `paper buys opened=${summary.paperBuysOpened}`,
    `real trade attempts=${summary.realTradeAttempts}`,
    summary.finalSafetyStatus
  ].join(' | ');
}

export async function runWatchCycle(db: AppDb, config: AppConfig, cycleNumber = 1, logger = new AppLogger()): Promise<WatchCycleSummary> {
  const timestamp = new Date().toISOString();
  const watchOnlyResult = await runWatchOnly(db, config, logger);
  const outcomesResult = await runWatchOutcomes(db, config, logger);
  const analysisResult = await runWatchAnalysis(db, config, logger);
  const watchReport = buildWatchOnlyReport(db, config) as Record<string, any>;
  const dailyReport = buildDailyReport(db, config) as Record<string, any>;
  const safety = verifySafety(config) as Record<string, any>;

  const summary: WatchCycleSummary = {
    cycleNumber,
    timestamp,
    newOrUpdatedWatchOnlyCandidates: Number(watchOnlyResult.createdOrUpdated ?? 0),
    outcomesRecorded: Number(outcomesResult.recorded ?? 0),
    totalWatchOnlyCandidates: Number(watchReport.totalWatchOnlyCandidates ?? 0),
    signalClassCounts: (watchReport.watchOnlySignalClassCounts as Record<WatchOnlySignalClass, number>) ?? {
      EARLY_RUNNER: 0,
      LATE_RUNNER: 0,
      INSTANT_DUMP: 0,
      DEAD_NOISE: 0,
      TOO_DANGEROUS: 0
    },
    bestCurrentMover: watchReport.bestMover ?? null,
    worstCurrentMover: watchReport.worstMover ?? null,
    paperBuysOpened: Number(dailyReport.paperBuysOpened ?? 0),
    realTradeAttempts: Number(dailyReport.blockedRealTradeAttempts ?? 0),
    tokensScannedToday: dailyReport.tokensScannedToday === undefined ? null : Number(dailyReport.tokensScannedToday),
    tokensScoredToday: dailyReport.tokensScoredToday === undefined ? null : Number(dailyReport.tokensScoredToday),
    finalSafetyStatus: String(watchReport.finalSafetyStatus ?? safety.finalSafetyStatus ?? 'Real trading remains locked.')
  };

  logger.info(formatCycleSummary(summary));
  return summary;
}

export function createStopSignal(): { stopped: boolean } {
  return { stopped: false };
}

export function installWatchLoopSignalHandlers(stopSignal: { stopped: boolean }, logger = new AppLogger()): () => void {
  const handleSignal = () => {
    stopSignal.stopped = true;
    logger.warn('Received stop signal for watch loop; finishing current cycle and exiting cleanly.');
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  return () => {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  };
}

export async function runWatchLoop(db: AppDb, config: AppConfig, options: WatchLoopOptions = {}): Promise<{ cyclesCompleted: number; stoppedGracefully: boolean; summaries: WatchCycleSummary[] }> {
  const intervalSeconds = options.intervalSeconds ?? parsePositiveInteger(process.env.WATCH_LOOP_INTERVAL_SECONDS, DEFAULT_WATCH_LOOP_INTERVAL_SECONDS);
  const maxCycles = options.maxCycles ?? parsePositiveInteger(process.env.WATCH_LOOP_MAX_CYCLES, DEFAULT_WATCH_LOOP_MAX_CYCLES);
  const sleep = options.sleep ?? defaultSleep;
  const logger = options.logger ?? new AppLogger();
  const stopSignal = options.stopSignal ?? createStopSignal();
  const registerSignalHandlers = options.registerSignalHandlers ?? true;
  const cleanup = registerSignalHandlers ? installWatchLoopSignalHandlers(stopSignal, logger) : () => {};
  const summaries: WatchCycleSummary[] = [];

  try {
    for (let cycleNumber = 1; cycleNumber <= maxCycles; cycleNumber += 1) {
      if (stopSignal.stopped) break;
      const summary = await runWatchCycle(db, config, cycleNumber, logger);
      summaries.push(summary);
      options.onCycleSummary?.(summary);
      if (stopSignal.stopped || cycleNumber >= maxCycles) break;
      await sleep(intervalSeconds * 1000);
    }

    return {
      cyclesCompleted: summaries.length,
      stoppedGracefully: stopSignal.stopped,
      summaries
    };
  } finally {
    cleanup();
  }
}
