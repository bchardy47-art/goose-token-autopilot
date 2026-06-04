import type { AppDb } from '../db';
import type { AppConfig } from '../types';
import { buildEarlyRefreshPlan } from './earlyRefreshPlan';
import { runWatchRefresh } from './watchRefresh';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EarlyRefreshCycleSummary {
  cycleNumber: number;
  timestamp: string;
  dueWindows: number;
  doneWindows: number;
  waitWindows: number;
  missedWindows: number;
  refreshRan: boolean;
  dryRun: boolean;
  selected: number;
  refreshed: number;
  failed: number;
  snapshotsInserted: number;
}

export interface EarlyRefreshLoopResult {
  cyclesRun: number;
  intervalMs: number;
  maxCycles: number;
  windowHours: number;
  limit: number;
  dryRun: boolean;
  totalSnapshotsInserted: number;
  totalRefreshRuns: number;
  totalFailed: number;
  cycleSummaries: EarlyRefreshCycleSummary[];
  noTradingBehaviorChanged: true;
}

export interface EarlyRefreshLoopOptions {
  intervalMs?: number;
  maxCycles?: number;
  windowHours?: number;
  limit?: number;
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
  onCycle?: (summary: EarlyRefreshCycleSummary) => void | Promise<void>;
}

export async function runEarlyRefreshLoop(
  db: AppDb,
  config: AppConfig,
  options: EarlyRefreshLoopOptions = {}
): Promise<EarlyRefreshLoopResult> {
  const intervalMs = options.intervalMs ?? 15 * 60_000;
  const maxCycles = options.maxCycles ?? 4;
  const windowHours = options.windowHours ?? 6;
  const limit = options.limit ?? 20;
  const dryRun = options.dryRun ?? false;
  const sleep = options.sleep ?? wait;

  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('early refresh loop intervalMs must be a non-negative number');
  }
  if (!Number.isInteger(maxCycles) || maxCycles < 1) {
    throw new Error('early refresh loop maxCycles must be a positive integer');
  }

  const cycleSummaries: EarlyRefreshCycleSummary[] = [];
  let totalSnapshotsInserted = 0;
  let totalRefreshRuns = 0;
  let totalFailed = 0;

  for (let cycleNumber = 1; cycleNumber <= maxCycles; cycleNumber += 1) {
    const timestamp = new Date().toISOString();
    const plan = buildEarlyRefreshPlan(db, config, { windowHours, limit });

    let refreshRan = false;
    let selected = 0;
    let refreshed = 0;
    let failed = 0;
    let snapshotsInserted = 0;

    if (plan.dueWindows > 0) {
      refreshRan = true;
      if (!dryRun) {
        const refreshReport = await runWatchRefresh(db, config, { windowHours, limit, dryRun: false });
        selected = refreshReport.candidatesSelected;
        refreshed = refreshReport.refreshed;
        failed = refreshReport.failed;
        snapshotsInserted = refreshReport.snapshotsInserted;
        totalSnapshotsInserted += snapshotsInserted;
        totalRefreshRuns += 1;
        totalFailed += failed;
      } else {
        // dry-run: call runWatchRefresh in dry-run mode for selection preview
        const dryReport = await runWatchRefresh(db, config, { windowHours, limit, dryRun: true });
        selected = dryReport.candidatesSelected;
        refreshRan = true;
      }
    }

    const cycleSummary: EarlyRefreshCycleSummary = {
      cycleNumber,
      timestamp,
      dueWindows: plan.dueWindows,
      doneWindows: plan.doneWindows,
      waitWindows: plan.waitWindows,
      missedWindows: plan.missedWindows,
      refreshRan,
      dryRun,
      selected,
      refreshed,
      failed,
      snapshotsInserted,
    };

    cycleSummaries.push(cycleSummary);
    await options.onCycle?.(cycleSummary);

    if (cycleNumber < maxCycles) {
      await sleep(intervalMs);
    }
  }

  return {
    cyclesRun: cycleSummaries.length,
    intervalMs,
    maxCycles,
    windowHours,
    limit,
    dryRun,
    totalSnapshotsInserted,
    totalRefreshRuns,
    totalFailed,
    cycleSummaries,
    noTradingBehaviorChanged: true,
  };
}

export function renderEarlyRefreshLoopResult(result: EarlyRefreshLoopResult): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);
  const intervalMin = (result.intervalMs / 60_000).toFixed(0);

  lines.push(result.dryRun ? 'Early Refresh Loop [DRY RUN]' : 'Early Refresh Loop');
  lines.push(sep);
  lines.push(
    `Window: last ${result.windowHours}h | Limit: ${result.limit}` +
      ` | Cycles: ${result.cyclesRun}/${result.maxCycles}` +
      ` | Interval: ${intervalMin}m`
  );
  lines.push(
    `Cumulative: snapshots inserted=${result.totalSnapshotsInserted}` +
      `  refresh runs=${result.totalRefreshRuns}` +
      `  failures=${result.totalFailed}`
  );
  lines.push('');

  for (const c of result.cycleSummaries) {
    lines.push(`Cycle ${c.cycleNumber} / ${result.maxCycles}  [${c.timestamp}]`);
    lines.push(sep);
    lines.push(
      `  Planner: DONE=${c.doneWindows}  DUE=${c.dueWindows}  WAIT=${c.waitWindows}  MISSED=${c.missedWindows}`
    );

    if (!c.refreshRan) {
      lines.push(`  Refresh: no-op (DUE=0 — nothing due this cycle)`);
    } else if (c.dryRun) {
      lines.push(
        `  Refresh: DRY RUN — would attempt ${c.selected} candidate(s) (DUE=${c.dueWindows})`
      );
    } else {
      lines.push(
        `  Refresh: selected=${c.selected}  refreshed=${c.refreshed}` +
          `  failed=${c.failed}  snapshots inserted=${c.snapshotsInserted}`
      );
    }
    lines.push('');
  }

  lines.push('Safety');
  lines.push(sep);
  lines.push('  No trading behavior changed.');
  lines.push('  No proposals created. No positions opened.');
  lines.push('  Real trading remains locked.');

  return lines.join('\n');
}
