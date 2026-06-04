import type { AppDb } from '../db';
import type { AppConfig } from '../types';

const DEFAULT_WINDOW_HOURS = 2;
const DEFAULT_LIMIT = 10;
const DEFAULT_TOP = 10;

const WINDOWS = [15, 30, 60, 90] as const;
type Window = (typeof WINDOWS)[number];

// Accept a snapshot within [W - lo, W + hi] minutes after discovery as coverage for window W
const WINDOW_BOUNDS: Record<Window, [lo: number, hi: number]> = {
  15: [5, 20],  // accept 10–35 min post-discovery
  30: [10, 25], // accept 20–55 min post-discovery
  60: [20, 45], // accept 40–105 min post-discovery
  90: [20, 30], // accept 70–120 min post-discovery
};

type WindowStatus = 'DONE' | 'DUE' | 'WAIT' | 'MISSED';

interface WindowCoverage {
  window: Window;
  status: WindowStatus;
  actualMinsAfter: number | null;
}

export interface CandidatePlan {
  candidateId: number;
  tokenId: number;
  symbol: string;
  discoveredAt: string;
  discoveryAgeMinutes: number;
  windows: WindowCoverage[];
  dueCount: number;
  missedCount: number;
}

export interface EarlyRefreshPlan {
  windowHours: number;
  limit: number;
  totalWatchCandidates: number;
  recentCandidates: number;
  candidates: CandidatePlan[];
  totalWindowSlots: number;
  doneWindows: number;
  dueWindows: number;
  waitWindows: number;
  missedWindows: number;
  candidatesDueNow: CandidatePlan[];
  candidatesWaiting: CandidatePlan[];
  candidatesMissed: CandidatePlan[];
  suggestedCommand: string;
  noTradingBehaviorChanged: true;
}

function minutesSince(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / 60_000;
}

function minutesBetween(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
}

function fmtAge(minutes: number): string {
  return minutes < 60 ? `${minutes.toFixed(0)}m` : `${(minutes / 60).toFixed(1)}h`;
}

function classifyWindow(
  candidateAgeMinutes: number,
  snaps: Array<{ minutesAfter: number }>,
  w: Window
): WindowCoverage {
  const [lo, hi] = WINDOW_BOUNDS[w];
  const wMin = w - lo;
  const wMax = w + hi;
  const hit = snaps.find((s) => s.minutesAfter >= wMin && s.minutesAfter <= wMax);
  if (hit) return { window: w, status: 'DONE', actualMinsAfter: hit.minutesAfter };
  if (candidateAgeMinutes < wMin) return { window: w, status: 'WAIT', actualMinsAfter: null };
  if (candidateAgeMinutes <= wMax) return { window: w, status: 'DUE', actualMinsAfter: null };
  return { window: w, status: 'MISSED', actualMinsAfter: null };
}

export function buildEarlyRefreshPlan(
  db: AppDb,
  _config: AppConfig,
  options: { windowHours?: number; limit?: number; top?: number } = {}
): EarlyRefreshPlan {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const top = options.top ?? DEFAULT_TOP;
  const sql = db.sqlite;

  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const candidateRows = sql.prepare(`
    SELECT wc.id as candidate_id, wc.token_id, t.symbol, wc.created_at
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    ORDER BY wc.created_at DESC
  `).all() as Array<{ candidate_id: number; token_id: number; symbol: string; created_at: string }>;

  const totalWatchCandidates = candidateRows.length;
  const recentRows = candidateRows.filter((r) => r.created_at >= cutoff);

  const snapRows = sql.prepare(`
    SELECT snap.token_id, snap.observed_at, wc.created_at as candidate_created_at
    FROM token_snapshots snap
    JOIN watch_only_candidates wc ON wc.token_id = snap.token_id
    WHERE snap.observed_at > wc.created_at
      AND wc.created_at >= ?
    ORDER BY snap.token_id, snap.observed_at
  `).all(cutoff) as Array<{ token_id: number; observed_at: string; candidate_created_at: string }>;

  const snapsByToken = new Map<number, Array<{ minutesAfter: number }>>();
  for (const row of snapRows) {
    const minutesAfter = minutesBetween(row.candidate_created_at, row.observed_at);
    if (!snapsByToken.has(row.token_id)) snapsByToken.set(row.token_id, []);
    snapsByToken.get(row.token_id)!.push({ minutesAfter });
  }

  const limitedRows = recentRows.slice(0, limit);

  const candidates: CandidatePlan[] = limitedRows.map((r) => {
    const ageMinutes = minutesSince(r.created_at);
    const snaps = snapsByToken.get(r.token_id) ?? [];
    const windows = WINDOWS.map((w) => classifyWindow(ageMinutes, snaps, w));
    return {
      candidateId: r.candidate_id,
      tokenId: r.token_id,
      symbol: r.symbol,
      discoveredAt: r.created_at,
      discoveryAgeMinutes: ageMinutes,
      windows,
      dueCount: windows.filter((w) => w.status === 'DUE').length,
      missedCount: windows.filter((w) => w.status === 'MISSED').length,
    };
  });

  const allStatuses = candidates.flatMap((c) => c.windows.map((w) => w.status));
  const doneWindows = allStatuses.filter((st) => st === 'DONE').length;
  const dueWindows = allStatuses.filter((st) => st === 'DUE').length;
  const waitWindows = allStatuses.filter((st) => st === 'WAIT').length;
  const missedWindows = allStatuses.filter((st) => st === 'MISSED').length;

  const candidatesDueNow = candidates
    .filter((c) => c.dueCount > 0)
    .sort((a, b) => b.dueCount - a.dueCount)
    .slice(0, top);

  const candidatesWaiting = candidates
    .filter((c) => c.dueCount === 0 && c.missedCount === 0 && c.windows.some((w) => w.status === 'WAIT'))
    .slice(0, top);

  const candidatesMissed = candidates
    .filter((c) => c.missedCount > 0 && c.dueCount === 0)
    .sort((a, b) => b.missedCount - a.missedCount)
    .slice(0, top);

  const suggestedCommand = `npm run token:watch-refresh -- --window-hours ${windowHours} --limit ${limit}`;

  return {
    windowHours,
    limit,
    totalWatchCandidates,
    recentCandidates: recentRows.length,
    candidates,
    totalWindowSlots: allStatuses.length,
    doneWindows,
    dueWindows,
    waitWindows,
    missedWindows,
    candidatesDueNow,
    candidatesWaiting,
    candidatesMissed,
    suggestedCommand,
    noTradingBehaviorChanged: true,
  };
}

export function renderEarlyRefreshPlan(plan: EarlyRefreshPlan, showRun = false): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  // 1. Early Refresh Plan
  lines.push('Early Refresh Plan [report-only]');
  lines.push(sep);
  lines.push(`Discovery window: last ${plan.windowHours}h | Candidate limit: ${plan.limit}`);
  lines.push(`Watch candidates (total): ${plan.totalWatchCandidates}`);
  lines.push(`Recent (within ${plan.windowHours}h): ${plan.recentCandidates}`);
  lines.push(`Shown: ${plan.candidates.length}`);
  lines.push('');

  // 2. Window Coverage Summary
  lines.push('Window Coverage Summary');
  lines.push(sep);
  lines.push(`Total window slots: ${plan.totalWindowSlots}  (${plan.candidates.length} candidates × 4 windows: 15m/30m/60m/90m)`);
  lines.push(`  DONE   : ${plan.doneWindows}`);
  lines.push(`  DUE    : ${plan.dueWindows}  ← needs refresh now`);
  lines.push(`  WAIT   : ${plan.waitWindows}  ← not old enough yet`);
  lines.push(`  MISSED : ${plan.missedWindows}  ← window passed without snapshot`);
  lines.push('');

  // 3. Due Now
  lines.push('Due Now');
  lines.push(sep);
  if (plan.candidatesDueNow.length === 0) {
    lines.push('  (none due now)');
  } else {
    for (const c of plan.candidatesDueNow) {
      const dueList = c.windows
        .filter((w) => w.status === 'DUE')
        .map((w) => `${w.window}m`)
        .join(', ');
      lines.push(`  ${c.symbol.padEnd(16)} age=${fmtAge(c.discoveryAgeMinutes).padEnd(6)} due=[${dueList}]`);
    }
  }
  lines.push('');

  // 4. Waiting
  lines.push('Waiting');
  lines.push(sep);
  if (plan.candidatesWaiting.length === 0) {
    lines.push('  (none waiting)');
  } else {
    for (const c of plan.candidatesWaiting) {
      const next = c.windows.find((w) => w.status === 'WAIT');
      lines.push(`  ${c.symbol.padEnd(16)} age=${fmtAge(c.discoveryAgeMinutes).padEnd(6)} next-window=${next?.window ?? '?'}m`);
    }
  }
  lines.push('');

  // 5. Missed Coverage
  lines.push('Missed Coverage');
  lines.push(sep);
  if (plan.candidatesMissed.length === 0) {
    lines.push('  (none missed in this window)');
  } else {
    for (const c of plan.candidatesMissed) {
      const missedList = c.windows
        .filter((w) => w.status === 'MISSED')
        .map((w) => `${w.window}m`)
        .join(', ');
      lines.push(`  ${c.symbol.padEnd(16)} age=${fmtAge(c.discoveryAgeMinutes).padEnd(6)} missed=[${missedList}]`);
    }
  }
  lines.push('');

  // 6. Suggested Next Command
  lines.push('Suggested Next Command');
  lines.push(sep);
  if (plan.dueWindows > 0) {
    lines.push(`  ${plan.suggestedCommand}`);
  } else if (plan.waitWindows > 0) {
    lines.push('  No windows due yet — re-run this plan after the next window opens.');
  } else if (plan.recentCandidates === 0) {
    lines.push('  No recent candidates found. Run token:watch-cycle to discover new ones.');
  } else {
    lines.push('  All windows covered or past tolerance. Run token:watch-refresh for general refresh.');
    lines.push(`  ${plan.suggestedCommand}`);
  }
  if (showRun) {
    lines.push('');
    lines.push('  --run was passed. Bounded auto-refresh is not automated in this planner.');
    lines.push('  Targeting only due-window candidates via runWatchRefresh is not safe to automate here.');
    lines.push('  To run a bounded refresh manually:');
    lines.push(`  npm run token:watch-refresh -- --limit=${plan.limit}`);
  }
  lines.push('');

  // 7. Safety Footer
  lines.push('Safety');
  lines.push(sep);
  lines.push('  Report only by default. No DB writes. No network calls.');
  lines.push('  No trading behavior changed.');
  lines.push('  No daemon / no schedule installed.');
  lines.push('  Manual bounded refresh only.');

  return lines.join('\n');
}
