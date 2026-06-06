import { describe, expect, it } from 'vitest';
import {
  selectWatchCandidates,
  renderWatchSnapshotSummary,
  WATCH_WORTHY_LANES,
  type WatchSnapshotSummary,
} from '../src/token-grab/watchSnapshot';
import type { TokenGrabAutopsyCandidate } from '../src/token-grab/autopsy';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeCandidate(
  overrides: Partial<TokenGrabAutopsyCandidate> = {},
): TokenGrabAutopsyCandidate {
  return {
    id: 'tg-001',
    tokenName: 'TestToken',
    ticker: 'TEST',
    contractAddress: 'TestContractAddress11111111111111111111',
    lane: 'FRESH_LAUNCH_CANDIDATE',
    decision: 'ALERT_ONLY',
    scoreAtDetection: 60,
    detectedAt: '2026-06-06T10:00:00Z',
    reasons: [],
    redFlags: [],
    ...overrides,
  };
}

// ── WATCH_WORTHY_LANES ────────────────────────────────────────────────────────

describe('WATCH_WORTHY_LANES', () => {
  it('includes EARLY_VELOCITY_WATCH, FRESH_LAUNCH_CANDIDATE, PRE_LAUNCH_WATCH, MEME_EVENT_CANDIDATE', () => {
    expect(WATCH_WORTHY_LANES).toContain('EARLY_VELOCITY_WATCH');
    expect(WATCH_WORTHY_LANES).toContain('FRESH_LAUNCH_CANDIDATE');
    expect(WATCH_WORTHY_LANES).toContain('PRE_LAUNCH_WATCH');
    expect(WATCH_WORTHY_LANES).toContain('MEME_EVENT_CANDIDATE');
  });

  it('does not include NOISE_RUG_LIKELY', () => {
    expect(WATCH_WORTHY_LANES).not.toContain('NOISE_RUG_LIKELY');
  });
});

// ── selectWatchCandidates ─────────────────────────────────────────────────────

describe('selectWatchCandidates — basic filtering', () => {
  it('returns only watch-worthy lane candidates by default', () => {
    const all = [
      makeCandidate({ id: 'tg-001', lane: 'FRESH_LAUNCH_CANDIDATE' }),
      makeCandidate({ id: 'tg-002', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' }),
      makeCandidate({ id: 'tg-003', lane: 'EARLY_VELOCITY_WATCH' }),
    ];
    const result = selectWatchCandidates(all);
    expect(result.candidates.map(c => c.id)).toEqual(['tg-001', 'tg-003']);
  });

  it('returns hasWatchWorthy: false and empty array when all candidates are NOISE_RUG_LIKELY', () => {
    const all = [
      makeCandidate({ id: 'tg-001', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' }),
      makeCandidate({ id: 'tg-002', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' }),
    ];
    const result = selectWatchCandidates(all);
    expect(result.hasWatchWorthy).toBe(false);
    expect(result.candidates).toHaveLength(0);
    expect(result.totalWatchWorthy).toBe(0);
  });

  it('includes all four watch-worthy lane types', () => {
    const all = [
      makeCandidate({ id: 'tg-001', lane: 'FRESH_LAUNCH_CANDIDATE' }),
      makeCandidate({ id: 'tg-002', lane: 'PRE_LAUNCH_WATCH', decision: 'WATCH' }),
      makeCandidate({ id: 'tg-003', lane: 'MEME_EVENT_CANDIDATE', decision: 'WATCH' }),
      makeCandidate({ id: 'tg-004', lane: 'EARLY_VELOCITY_WATCH', decision: 'WATCH' }),
      makeCandidate({ id: 'tg-005', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' }),
    ];
    const result = selectWatchCandidates(all);
    expect(result.candidates).toHaveLength(4);
    expect(result.lanesIncluded.sort()).toEqual([
      'EARLY_VELOCITY_WATCH',
      'FRESH_LAUNCH_CANDIDATE',
      'MEME_EVENT_CANDIDATE',
      'PRE_LAUNCH_WATCH',
    ]);
  });
});

// ── selectWatchCandidates — startAt / limit ───────────────────────────────────

describe('selectWatchCandidates — startAt and limit', () => {
  it('applies limit within the watch-worthy filtered set', () => {
    const all = [
      makeCandidate({ id: 'tg-001', lane: 'FRESH_LAUNCH_CANDIDATE' }),
      makeCandidate({ id: 'tg-002', lane: 'EARLY_VELOCITY_WATCH' }),
      makeCandidate({ id: 'tg-003', lane: 'PRE_LAUNCH_WATCH' }),
      makeCandidate({ id: 'tg-004', lane: 'MEME_EVENT_CANDIDATE' }),
    ];
    const result = selectWatchCandidates(all, { limit: 2 });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.id).toBe('tg-001');
    expect(result.candidates[1]!.id).toBe('tg-002');
    expect(result.totalWatchWorthy).toBe(4);
  });

  it('applies startAt to skip earlier watch-worthy candidates', () => {
    const all = [
      makeCandidate({ id: 'tg-001', lane: 'FRESH_LAUNCH_CANDIDATE' }),
      makeCandidate({ id: 'tg-002', lane: 'EARLY_VELOCITY_WATCH' }),
      makeCandidate({ id: 'tg-003', lane: 'PRE_LAUNCH_WATCH' }),
    ];
    const result = selectWatchCandidates(all, { startAt: 1, limit: 2 });
    expect(result.candidates.map(c => c.id)).toEqual(['tg-002', 'tg-003']);
    expect(result.totalWatchWorthy).toBe(3);
  });
});

// ── selectWatchCandidates — reject inclusion ──────────────────────────────────

describe('selectWatchCandidates — reject inclusion', () => {
  it('includes all NOISE_RUG_LIKELY candidates when includeRejects: true', () => {
    const all = [
      makeCandidate({ id: 'tg-001', lane: 'EARLY_VELOCITY_WATCH', decision: 'WATCH' }),
      makeCandidate({ id: 'tg-002', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' }),
      makeCandidate({ id: 'tg-003', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' }),
    ];
    const result = selectWatchCandidates(all, { includeRejects: true });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map(c => c.id)).toContain('tg-002');
    expect(result.candidates.map(c => c.id)).toContain('tg-003');
  });

  it('includes only top-N rejects by scoreAtDetection when topRejects is set', () => {
    const all = [
      makeCandidate({ id: 'tg-001', lane: 'FRESH_LAUNCH_CANDIDATE', scoreAtDetection: 70 }),
      makeCandidate({ id: 'tg-002', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT', scoreAtDetection: 30 }),
      makeCandidate({ id: 'tg-003', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT', scoreAtDetection: 10 }),
      makeCandidate({ id: 'tg-004', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT', scoreAtDetection: 20 }),
    ];
    const result = selectWatchCandidates(all, { topRejects: 2 });
    const ids = result.candidates.map(c => c.id);
    expect(ids).toContain('tg-001');
    expect(ids).toContain('tg-002');
    expect(ids).toContain('tg-004');
    expect(ids).not.toContain('tg-003');
  });
});

// ── renderWatchSnapshotSummary ────────────────────────────────────────────────

describe('renderWatchSnapshotSummary', () => {
  it('renders all summary fields and NO TRADING EXECUTED', () => {
    const summary: WatchSnapshotSummary = {
      sessionPath: '/data/sessions/test-session.json',
      outPath: '/data/snapshots/test-snap.json',
      candidatesLoaded: 20,
      watchWorthyFound: 3,
      lanesIncluded: ['EARLY_VELOCITY_WATCH', 'FRESH_LAUNCH_CANDIDATE'],
      startAt: 0,
      limit: 10,
      candidatesAttempted: 3,
      snapshotsWritten: 2,
      skipped: 1,
      noTradingExecuted: true,
    };
    const rendered = renderWatchSnapshotSummary(summary);
    expect(rendered).toContain('test-session.json');
    expect(rendered).toContain('test-snap.json');
    expect(rendered).toContain('20');
    expect(rendered).toContain('3');
    expect(rendered).toContain('EARLY_VELOCITY_WATCH');
    expect(rendered).toContain('FRESH_LAUNCH_CANDIDATE');
    expect(rendered).toContain('NO TRADING EXECUTED');
  });

  it('shows (none) for lanesIncluded when the list is empty', () => {
    const summary: WatchSnapshotSummary = {
      sessionPath: '/data/sessions/empty.json',
      outPath: '/data/snapshots/empty-snap.json',
      candidatesLoaded: 5,
      watchWorthyFound: 0,
      lanesIncluded: [],
      startAt: 0,
      limit: 10,
      candidatesAttempted: 0,
      snapshotsWritten: 0,
      skipped: 0,
      noTradingExecuted: true,
    };
    const rendered = renderWatchSnapshotSummary(summary);
    expect(rendered).toContain('(none)');
    expect(rendered).toContain('NO TRADING EXECUTED');
  });
});
