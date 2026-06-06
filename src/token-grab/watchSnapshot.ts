import type { TokenGrabAutopsyCandidate } from './autopsy';
import type { TokenGrabLane } from './types';

// ── Watch-worthy lane constants ───────────────────────────────────────────────

export const WATCH_WORTHY_LANES: readonly TokenGrabLane[] = [
  'EARLY_VELOCITY_WATCH',
  'FRESH_LAUNCH_CANDIDATE',
  'PRE_LAUNCH_WATCH',
  'MEME_EVENT_CANDIDATE',
];

// ── Candidate selection ───────────────────────────────────────────────────────

export interface SelectWatchCandidatesOptions {
  includeRejects?: boolean;
  topRejects?: number;
  startAt?: number;
  limit?: number;
}

export interface SelectWatchCandidatesResult {
  candidates: TokenGrabAutopsyCandidate[];
  totalWatchWorthy: number;
  lanesIncluded: string[];
  hasWatchWorthy: boolean;
}

/**
 * Filters session candidates to watch-worthy lanes, optionally including rejected
 * noise candidates for control data. Applies startAt/limit within the filtered list.
 * Pure function — no network calls, no DB writes, no trading logic.
 */
export function selectWatchCandidates(
  allCandidates: TokenGrabAutopsyCandidate[],
  options: SelectWatchCandidatesOptions = {},
): SelectWatchCandidatesResult {
  const { includeRejects = false, topRejects = 0, startAt = 0, limit } = options;

  const watchWorthy = allCandidates.filter(c =>
    (WATCH_WORTHY_LANES as readonly string[]).includes(c.lane),
  );

  const noiseRejects = allCandidates.filter(c => c.lane === 'NOISE_RUG_LIKELY');
  let rejectIncludes: TokenGrabAutopsyCandidate[] = [];
  if (includeRejects) {
    rejectIncludes = noiseRejects;
  } else if (topRejects > 0) {
    rejectIncludes = [...noiseRejects]
      .sort((a, b) => b.scoreAtDetection - a.scoreAtDetection)
      .slice(0, topRejects);
  }

  const combined = [...watchWorthy, ...rejectIncludes];
  const totalWatchWorthy = combined.length;
  const lanesIncluded = [...new Set(combined.map(c => c.lane))];

  const end = limit != null ? startAt + limit : undefined;
  const candidates = combined.slice(startAt, end);

  return {
    candidates,
    totalWatchWorthy,
    lanesIncluded,
    hasWatchWorthy: totalWatchWorthy > 0,
  };
}

// ── Summary and renderer ──────────────────────────────────────────────────────

export interface WatchSnapshotSummary {
  sessionPath: string;
  outPath: string;
  candidatesLoaded: number;
  watchWorthyFound: number;
  lanesIncluded: string[];
  startAt: number;
  limit: number;
  candidatesAttempted: number;
  snapshotsWritten: number;
  skipped: number;
  noTradingExecuted: true;
}

export function renderWatchSnapshotSummary(s: WatchSnapshotSummary): string {
  const THIN = '─'.repeat(50);
  const lines: string[] = [
    THIN,
    `Session              : ${s.sessionPath}`,
    `Output               : ${s.outPath}`,
    `Candidates loaded    : ${s.candidatesLoaded}`,
    `Watch-worthy found   : ${s.watchWorthyFound}`,
    `Lanes included       : ${s.lanesIncluded.length > 0 ? s.lanesIncluded.join(', ') : '(none)'}`,
    `Start at             : ${s.startAt}`,
    `Limit                : ${s.limit}`,
    `Candidates attempted : ${s.candidatesAttempted}`,
    `Snapshots written    : ${s.snapshotsWritten}`,
    `Skipped / failed     : ${s.skipped}`,
    '',
    'NO TRADING EXECUTED',
    THIN,
  ];
  return lines.join('\n');
}
