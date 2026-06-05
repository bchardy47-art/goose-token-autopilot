import type { AppDb } from '../db';
import type { AppConfig } from '../types';
import { runWatchCycle, type WatchCycleSummary } from '../watchLoop';
import { AppLogger } from '../logger';
import { runEarlyRefreshLoop, renderEarlyRefreshLoopResult, type EarlyRefreshLoopResult } from './earlyRefreshLoop';
import { buildRefreshCoverageSummary, renderRefreshCoverageSummary, type RefreshCoverageSummary } from './refreshCoverageSummary';
import { buildShadowCandidateReport, renderShadowCandidateReport, type ShadowCandidateReport } from './shadowCandidateReport';

export interface FreshCaptureSessionOptions {
  windowHours?: number;
  limit?: number;
  cycles?: number;
  intervalMs?: number;
  dryRun?: boolean;
  skipWatchCycle?: boolean;
  onPhase?: (phase: string) => void;
}

export interface FreshCaptureSessionResult {
  windowHours: number;
  limit: number;
  cycles: number;
  intervalMs: number;
  dryRun: boolean;
  skippedWatchCycle: boolean;
  watchCycleSummary: WatchCycleSummary | null;
  loopResult: EarlyRefreshLoopResult;
  coverageSummary: RefreshCoverageSummary;
  shadowReport: ShadowCandidateReport;
  noTradingBehaviorChanged: true;
  paperBuysOpened: 0;
  realTradeAttempts: 0;
}

export async function runFreshCaptureSession(
  db: AppDb,
  config: AppConfig,
  options: FreshCaptureSessionOptions = {}
): Promise<FreshCaptureSessionResult> {
  const windowHours = options.windowHours ?? 6;
  const limit = options.limit ?? 20;
  const cycles = options.cycles ?? 4;
  const intervalMs = options.intervalMs ?? 15 * 60_000;
  const dryRun = options.dryRun ?? false;
  const skipWatchCycle = options.skipWatchCycle ?? false;
  const onPhase = options.onPhase ?? (() => {});

  // Phase 1: watch-cycle (skipped in dry-run or when --skip-watch-cycle)
  let watchCycleSummary: WatchCycleSummary | null = null;
  const skippedWatchCycle = dryRun || skipWatchCycle;

  if (!skippedWatchCycle) {
    onPhase('watch-cycle');
    watchCycleSummary = await runWatchCycle(db, config, 1, new AppLogger());
  } else {
    onPhase('watch-cycle: skipped');
  }

  // Phase 2: early-refresh-loop (bounded)
  onPhase(`early-refresh-loop: ${cycles} cycle(s), window=${windowHours}h, limit=${limit}, interval=${intervalMs / 60_000}m`);
  const loopResult = await runEarlyRefreshLoop(db, config, {
    windowHours,
    limit,
    maxCycles: cycles,
    intervalMs,
    dryRun,
    onCycle: (s) => {
      onPhase(
        `  cycle ${s.cycleNumber}/${cycles}: due=${s.dueWindows} refreshRan=${s.refreshRan} snapshots=${s.snapshotsInserted}`
      );
    },
  });

  // Phase 3: refresh-coverage-summary (read-only)
  onPhase('refresh-coverage-summary');
  const coverageSummary = buildRefreshCoverageSummary(db, config, { windowHours, limit });

  // Phase 4: shadow-candidate-report (read-only)
  onPhase('shadow-candidate-report');
  const shadowReport = buildShadowCandidateReport(db, config, { hours: windowHours, limit });

  return {
    windowHours,
    limit,
    cycles,
    intervalMs,
    dryRun,
    skippedWatchCycle,
    watchCycleSummary,
    loopResult,
    coverageSummary,
    shadowReport,
    noTradingBehaviorChanged: true,
    paperBuysOpened: 0,
    realTradeAttempts: 0,
  };
}

export function renderFreshCaptureSessionResult(result: FreshCaptureSessionResult): string {
  const sep = '─'.repeat(60);
  const lines: string[] = [];

  lines.push('Fresh Capture Session');
  lines.push(sep);
  lines.push(
    `Window: ${result.windowHours}h | Limit: ${result.limit} | Cycles: ${result.cycles} | Interval: ${result.intervalMs / 60_000}m${result.dryRun ? ' | DRY RUN' : ''}`
  );
  lines.push('');

  // 1. Watch cycle
  lines.push('Phase 1 — Watch Cycle');
  lines.push(sep);
  if (result.skippedWatchCycle) {
    lines.push(
      result.dryRun
        ? '  Skipped (dry-run mode). Run token:watch-cycle manually to discover new candidates.'
        : '  Skipped (--skip-watch-cycle).'
    );
  } else if (result.watchCycleSummary) {
    const w = result.watchCycleSummary;
    lines.push(`  Scanned today:    ${w.tokensScannedToday ?? 'n/a'}`);
    lines.push(`  Scored today:     ${w.tokensScoredToday ?? 'n/a'}`);
    lines.push(`  New/updated watch-only: ${w.newOrUpdatedWatchOnlyCandidates}`);
    lines.push(`  Total watch-only: ${w.totalWatchOnlyCandidates}`);
    lines.push(`  Outcomes recorded: ${w.outcomesRecorded}`);
    lines.push(`  Paper buys opened: ${w.paperBuysOpened}`);
    lines.push(`  Real trade attempts: ${w.realTradeAttempts}`);
    lines.push(`  ${w.finalSafetyStatus}`);
  }
  lines.push('');

  // 2. Refresh loop (full render)
  lines.push('Phase 2 — Early Refresh Loop');
  lines.push(sep);
  lines.push(renderEarlyRefreshLoopResult(result.loopResult));
  lines.push('');

  // 3. Coverage summary (full render)
  lines.push('Phase 3 — Refresh Coverage Summary');
  lines.push(sep);
  lines.push(renderRefreshCoverageSummary(result.coverageSummary));
  lines.push('');

  // 4. Shadow candidate report (full render)
  lines.push('Phase 4 — Shadow Candidate Report');
  lines.push(sep);
  lines.push(renderShadowCandidateReport(result.shadowReport));
  lines.push('');

  // 5. Final operator summary
  lines.push('Operator Summary');
  lines.push(sep);
  if (result.watchCycleSummary) {
    lines.push(`  watch-cycle scanned:    ${result.watchCycleSummary.tokensScannedToday ?? 'n/a'}`);
    lines.push(`  new/updated candidates: ${result.watchCycleSummary.newOrUpdatedWatchOnlyCandidates}`);
  } else {
    lines.push('  watch-cycle:            skipped');
  }
  lines.push(`  loop cycles completed:  ${result.loopResult.cyclesRun}`);
  lines.push(`  snapshots inserted:     ${result.loopResult.totalSnapshotsInserted}`);
  if (result.coverageSummary.attemptStats) {
    const a = result.coverageSummary.attemptStats;
    lines.push(`  attempt refreshed:      ${a.refreshed}`);
    lines.push(`  attempt no_data:        ${a.no_data}`);
    lines.push(`  attempt missing_pool:   ${a.missing_pool_address}`);
    lines.push(`  attempt failed:         ${a.failed}`);
  }
  lines.push(`  coverage:               ${result.coverageSummary.coveragePct}%`);
  lines.push(
    `  DONE=${result.coverageSummary.doneWindows} DUE=${result.coverageSummary.dueWindows} WAIT=${result.coverageSummary.waitWindows} MISSED=${result.coverageSummary.missedWindows}`
  );
  lines.push(`  SHADOW_MATCH:           ${result.shadowReport.shadowMatches.length}`);
  lines.push(`  WATCH_MORE:             ${result.shadowReport.watchMore.length}`);
  lines.push(`  REJECT:                 ${result.shadowReport.rejected.length}`);
  lines.push(`  paper buys opened:      0`);
  lines.push(`  real trade attempts:    0`);
  lines.push('');

  // Safety footer
  lines.push('Safety');
  lines.push(sep);
  lines.push('  No trading behavior changed.');
  lines.push('  No proposals created. No positions opened.');
  lines.push('  Real trading remains locked.');

  return lines.join('\n');
}
