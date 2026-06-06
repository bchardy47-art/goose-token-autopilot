import { describe, expect, it } from 'vitest';
import {
  buildBadRejectReview,
  renderBadRejectReview,
} from '../src/token-grab/badRejectReview';
import { buildTokenGrabAutopsyReport } from '../src/token-grab/autopsy';
import type { TokenGrabAutopsyCandidate, TokenGrabAutopsySnapshot } from '../src/token-grab/autopsy';

// ── Factories ─────────────────────────────────────────────────────────────────

const DETECTED_AT = '2026-06-06T10:00:00.000Z';
const SNAP1_AT    = '2026-06-06T10:20:00.000Z'; // +20 min
const SNAP2_AT    = '2026-06-06T11:00:00.000Z'; // +60 min

function makeCandidate(overrides: Partial<TokenGrabAutopsyCandidate> = {}): TokenGrabAutopsyCandidate {
  return {
    id: 'tg-001',
    tokenName: 'DoneToken',
    ticker: 'DONE',
    contractAddress: 'DoneCAFakeAddr11111111111111111111111111',
    lane: 'NOISE_RUG_LIKELY',
    decision: 'REJECT',
    scoreAtDetection: 0,
    detectedAt: DETECTED_AT,
    reasons: [],
    redFlags: ['-15: No social/event/pre-launch context found for this pool'],
    ...overrides,
  };
}

function makeSnap(
  candidateId: string,
  observedAt: string,
  minutesAfterDetection: number,
  priceUsd: number,
  liquidityUsd?: number,
  volumeUsd?: number,
): TokenGrabAutopsySnapshot {
  return { candidateId, observedAt, minutesAfterDetection, priceUsd, liquidityUsd, volumeUsd, source: 'geckoterminal' };
}

// Produces a BAD_REJECT: NOISE_RUG_LIKELY REJECT that later RAN
function badRejectSnapshots(
  candidateId = 'tg-001',
  basePrice = 0.0001,
  firstRunMin = 20,
  liquidityStart = 10_000,
  liquidityEnd = 85_200,
): TokenGrabAutopsySnapshot[] {
  return [
    makeSnap(candidateId, SNAP1_AT, firstRunMin, basePrice, liquidityStart, 3000),
    makeSnap(candidateId, SNAP2_AT, 60, basePrice * 8.67, liquidityEnd, 120_000),
  ];
}

// ── No BAD_REJECTs ────────────────────────────────────────────────────────────

describe('buildBadRejectReview — no BAD_REJECTs', () => {
  it('returns empty items and zero summary when no BAD_REJECT results', () => {
    const candidate = makeCandidate({ lane: 'FRESH_LAUNCH_CANDIDATE', decision: 'ALERT_ONLY', scoreAtDetection: 75 });
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 20, 0.0001, 50000),
      makeSnap('tg-001', SNAP2_AT, 60, 0.00012, 55000),
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    expect(review.items).toHaveLength(0);
    expect(review.badRejectCount).toBe(0);
    expect(review.summary.badRejectCount).toBe(0);
    expect(review.summary.tradingExecuted).toBe(0);
    expect(review.tradingStatus).toBe('LOCKED / NO TRADING EXECUTED');
  });

  it('summary shows correct candidatesReviewed even with zero bad rejects', () => {
    const c1 = makeCandidate({ id: 'tg-001', lane: 'FRESH_LAUNCH_CANDIDATE', decision: 'ALERT_ONLY', scoreAtDetection: 80 });
    const c2 = makeCandidate({ id: 'tg-002', ticker: 'FLAT', tokenName: 'FlatToken', scoreAtDetection: 0 });
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 20, 0.0001),
      makeSnap('tg-001', SNAP2_AT, 60, 0.00011),
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([c1, c2], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([c1, c2], snaps, autopsyReport.results);

    expect(review.summary.candidatesReviewed).toBe(2);
    expect(review.summary.badRejectCount).toBe(0);
  });
});

// ── BAD_REJECT detection ──────────────────────────────────────────────────────

describe('buildBadRejectReview — BAD_REJECT detection', () => {
  it('produces a review item for each BAD_REJECT', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    expect(review.items).toHaveLength(1);
    expect(review.badRejectCount).toBe(1);
    const item = review.items[0]!;
    expect(item.candidateId).toBe('tg-001');
    expect(item.ticker).toBe('DONE');
    expect(item.outcome).toBe('RAN');
    expect(item.noTradingExecuted).toBe(true);
  });

  it('item carries detection red flags and reasons from session candidate', () => {
    const candidate = makeCandidate({
      reasons: ['Pool matched by name'],
      redFlags: ['-15: No social/event/pre-launch context found for this pool', '-10: Liquidity below $20k'],
    });
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const item = review.items[0]!;
    expect(item.reasons).toContain('Pool matched by name');
    expect(item.redFlags).toContain('-15: No social/event/pre-launch context found for this pool');
    expect(item.redFlags).toContain('-10: Liquidity below $20k');
  });

  it('item includes contractAddress and poolAddress from candidate', () => {
    const candidate = makeCandidate({
      contractAddress: 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      poolAddress: 'PoolAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const item = review.items[0]!;
    expect(item.contractAddress).toBe('ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(item.poolAddress).toBe('PoolAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('item includes maxGainPct, liquidityChangePct, firstRunAtMinutes', () => {
    const candidate = makeCandidate();
    // baseline at +5min, run detected at +60min (firstRunAtMinutes = 60)
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 5, 0.0001, 10_000),
      makeSnap('tg-001', SNAP2_AT, 60, 0.0001 * 8.67, 85_200),
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const item = review.items[0]!;
    expect(item.maxGainPct).toBeDefined();
    expect(item.maxGainPct!).toBeGreaterThan(700);
    expect(item.liquidityChangePct).toBeDefined();
    expect(item.liquidityChangePct!).toBeGreaterThan(700);
    // firstRunAtMinutes is the minute of the snapshot where RAN was first triggered
    expect(item.firstRunAtMinutes).toBe(60);
  });
});

// ── Snapshot timeline ─────────────────────────────────────────────────────────

describe('buildBadRejectReview — snapshot timeline', () => {
  it('timeline is populated from snapshots for the candidate', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const timeline = review.items[0]!.snapshotTimeline;
    expect(timeline).toHaveLength(2);
    expect(timeline[0]!.minutesAfterDetection).toBe(20);
    expect(timeline[1]!.minutesAfterDetection).toBe(60);
    expect(timeline[0]!.priceUsd).toBeCloseTo(0.0001, 6);
  });

  it('timeline is sorted by observedAt (earliest first)', () => {
    const candidate = makeCandidate();
    // Deliberately reverse order
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP2_AT, 60, 0.00087, 85_200),
      makeSnap('tg-001', SNAP1_AT, 20, 0.0001, 10_000),
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const timeline = review.items[0]!.snapshotTimeline;
    expect(timeline[0]!.observedAt).toBe(SNAP1_AT);
    expect(timeline[1]!.observedAt).toBe(SNAP2_AT);
  });

  it('timeline is empty when no snapshots match the candidateId', () => {
    const candidate = makeCandidate();
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-OTHER', SNAP1_AT, 20, 0.0001),
      makeSnap('tg-OTHER', SNAP2_AT, 60, 0.00087),
    ];
    // Run through autopsy — candidate has no snapshots so no BAD_REJECT...
    // Force a BAD_REJECT via autopsyResults manually
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    // candidate has no snaps → INSUFFICIENT_DATA, not BAD_REJECT
    // So create a BAD_REJECT manually for this test
    const fakeResult = {
      ...autopsyReport.results[0]!,
      verdict: 'BAD_REJECT' as const,
      outcome: 'RAN' as const,
    };
    const review = buildBadRejectReview([candidate], snaps, [fakeResult]);
    expect(review.items[0]!.snapshotTimeline).toHaveLength(0);
  });
});

// ── Missed-signal notes ───────────────────────────────────────────────────────

describe('buildBadRejectReview — missed-signal notes', () => {
  it('LIQUIDITY_VELOCITY note fires when liquidityChangePct > 200', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots('tg-001', 0.0001, 20, 10_000, 100_000); // +900% liq
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const noteTypes = review.items[0]!.missedSignalNotes.map(n => n.type);
    expect(noteTypes).toContain('LIQUIDITY_VELOCITY');
  });

  it('EARLY_CADENCE note fires when firstRunAtMinutes <= 30', () => {
    const candidate = makeCandidate();
    // baseline at +5min, run-triggering snapshot at +20min → firstRunAtMinutes=20 (≤30)
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 5, 0.0001, 10_000),
      makeSnap('tg-001', SNAP2_AT, 20, 0.001, 85_200), // +900%, ≤30min → EARLY_CADENCE
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const noteTypes = review.items[0]!.missedSignalNotes.map(n => n.type);
    expect(noteTypes).toContain('EARLY_CADENCE');
  });

  it('EARLY_CADENCE note does NOT fire when firstRunAtMinutes > 30', () => {
    const candidate = makeCandidate({ scoreAtDetection: 0 });
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 35, 0.0001, 10_000),        // +35 min (> 30)
      makeSnap('tg-001', SNAP2_AT, 60, 0.0001 * 8.67, 85_200), // still runs
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const noteTypes = review.items[0]!.missedSignalNotes.map(n => n.type);
    expect(noteTypes).not.toContain('EARLY_CADENCE');
  });

  it('ZERO_SCORE_MAJOR_RUN note fires when scoreAtDetection=0 and maxGainPct > 500', () => {
    const candidate = makeCandidate({ scoreAtDetection: 0 }); // score = 0
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 20, 0.0001, 10_000),
      makeSnap('tg-001', SNAP2_AT, 60, 0.0007, 85_200), // +600%
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const noteTypes = review.items[0]!.missedSignalNotes.map(n => n.type);
    expect(noteTypes).toContain('ZERO_SCORE_MAJOR_RUN');
  });

  it('ZERO_SCORE_MAJOR_RUN note does NOT fire when maxGainPct <= 500', () => {
    const candidate = makeCandidate({ scoreAtDetection: 0 });
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 20, 0.0001, 10_000),
      makeSnap('tg-001', SNAP2_AT, 60, 0.00020, 20_000), // +100%, well below 500
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const noteTypes = review.items[0]!.missedSignalNotes.map(n => n.type);
    expect(noteTypes).not.toContain('ZERO_SCORE_MAJOR_RUN');
  });

  it('NO_SOCIAL_CONTEXT note fires when red flags include no-context string', () => {
    const candidate = makeCandidate({
      redFlags: ['-15: No social/event/pre-launch context found for this pool'],
    });
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const noteTypes = review.items[0]!.missedSignalNotes.map(n => n.type);
    expect(noteTypes).toContain('NO_SOCIAL_CONTEXT');
  });

  it('NO_SOCIAL_CONTEXT note does NOT fire when red flags have no no-context string', () => {
    const candidate = makeCandidate({ redFlags: ['-10: Liquidity below $20k'] });
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const noteTypes = review.items[0]!.missedSignalNotes.map(n => n.type);
    expect(noteTypes).not.toContain('NO_SOCIAL_CONTEXT');
  });

  it('DUPLICATE_TICKER note fires when another candidate shares the same ticker', () => {
    const c1 = makeCandidate({ id: 'tg-001', ticker: 'DONE', tokenName: 'DoneToken' });
    const c2 = makeCandidate({ id: 'tg-002', ticker: 'DONE', tokenName: 'DoneToken2', redFlags: [] });
    const snaps = badRejectSnapshots('tg-001');
    const autopsyReport = buildTokenGrabAutopsyReport([c1, c2], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([c1, c2], snaps, autopsyReport.results);

    const item = review.items.find(i => i.candidateId === 'tg-001')!;
    const noteTypes = item.missedSignalNotes.map(n => n.type);
    expect(noteTypes).toContain('DUPLICATE_TICKER');
  });

  it('DUPLICATE_TICKER note does NOT fire when ticker is unique in session', () => {
    const candidate = makeCandidate({ ticker: 'UNIQUEXYZ' });
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const noteTypes = review.items[0]!.missedSignalNotes.map(n => n.type);
    expect(noteTypes).not.toContain('DUPLICATE_TICKER');
  });

  it('LIQUIDITY_ARRIVED_LATE note fires when first snap has no liquidityUsd but later one does', () => {
    const candidate = makeCandidate();
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 20, 0.0001, undefined),   // no liquidity at detection
      makeSnap('tg-001', SNAP2_AT, 60, 0.00087, 85_000),     // liquidity arrived later
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const noteTypes = review.items[0]!.missedSignalNotes.map(n => n.type);
    expect(noteTypes).toContain('LIQUIDITY_ARRIVED_LATE');
  });
});

// ── Recommendations ───────────────────────────────────────────────────────────

describe('buildBadRejectReview — recommendations', () => {
  it('always includes DO_NOT_LOOSEN_YET', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const recs = review.items[0]!.recommendations;
    expect(recs.some(r => r.startsWith('DO_NOT_LOOSEN_YET'))).toBe(true);
  });

  it('always includes NEEDS_MORE_SESSIONS', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const recs = review.items[0]!.recommendations;
    expect(recs.some(r => r.startsWith('NEEDS_MORE_SESSIONS'))).toBe(true);
  });

  it('REVIEW_ONLY liquidity velocity recommendation appears when LIQUIDITY_VELOCITY note fires', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots('tg-001', 0.0001, 20, 10_000, 100_000);
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);

    const recs = review.items[0]!.recommendations;
    expect(recs.some(r => r.includes('liquidity velocity lane'))).toBe(true);
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────

describe('buildBadRejectReview — summary', () => {
  it('largestMissedGainPct is the highest maxGainPct across all BAD_REJECTs', () => {
    const c1 = makeCandidate({ id: 'tg-001', ticker: 'AA' });
    const c2 = makeCandidate({ id: 'tg-002', ticker: 'BB', redFlags: [] });
    const snapsC1: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 20, 0.0001, 10_000),
      makeSnap('tg-001', SNAP2_AT, 60, 0.001, 100_000),  // +900%
    ];
    const snapsC2: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-002', SNAP1_AT, 20, 0.0001, 10_000),
      makeSnap('tg-002', SNAP2_AT, 60, 0.0003, 30_000),  // +200%
    ];
    const allSnaps = [...snapsC1, ...snapsC2];
    const autopsyReport = buildTokenGrabAutopsyReport([c1, c2], allSnaps, { mode: 'session-file' });
    const review = buildBadRejectReview([c1, c2], allSnaps, autopsyReport.results);

    expect(review.summary.largestMissedGainPct).toBeDefined();
    expect(review.summary.largestMissedGainPct!).toBeGreaterThan(800);
  });

  it('earliestMissedRunMinutes is the minimum firstRunAtMinutes', () => {
    const c1 = makeCandidate({ id: 'tg-001', ticker: 'AA' });
    const c2 = makeCandidate({ id: 'tg-002', ticker: 'BB', redFlags: [] });
    // c1: baseline +5min, run at +15min → firstRunAtMinutes=15
    // c2: baseline +5min, run at +25min → firstRunAtMinutes=25
    // earliest = 15
    const allSnaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 5, 0.0001, 10_000),
      makeSnap('tg-001', SNAP2_AT, 15, 0.001, 100_000),
      makeSnap('tg-002', SNAP1_AT, 5, 0.0001, 10_000),
      makeSnap('tg-002', SNAP2_AT, 25, 0.0003, 30_000),
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([c1, c2], allSnaps, { mode: 'session-file' });
    const review = buildBadRejectReview([c1, c2], allSnaps, autopsyReport.results);

    expect(review.summary.earliestMissedRunMinutes).toBe(15);
  });

  it('tradingExecuted is always 0', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);
    expect(review.summary.tradingExecuted).toBe(0);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderBadRejectReview', () => {
  it('rendered output includes NO TRADING EXECUTED', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);
    const text = renderBadRejectReview(review);

    expect(text).toContain('NO TRADING EXECUTED');
  });

  it('rendered output includes ticker and DO_NOT_LOOSEN_YET', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);
    const text = renderBadRejectReview(review);

    expect(text).toContain('DONE');
    expect(text).toContain('DO_NOT_LOOSEN_YET');
    expect(text).toContain('BAD_REJECT');
  });

  it('rendered output includes max gain and liquidity change', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);
    const text = renderBadRejectReview(review);

    expect(text).toContain('Max gain');
    expect(text).toContain('Liquidity change');
    expect(text).toContain('First run');
  });

  it('rendered output for zero BAD_REJECTs says none found and includes NO TRADING EXECUTED', () => {
    const candidate = makeCandidate({ lane: 'FRESH_LAUNCH_CANDIDATE', decision: 'ALERT_ONLY', scoreAtDetection: 75 });
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap('tg-001', SNAP1_AT, 20, 0.0001, 50_000),
      makeSnap('tg-001', SNAP2_AT, 60, 0.00011, 52_000),
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);
    const text = renderBadRejectReview(review);

    expect(text).toContain('No BAD_REJECT candidates found');
    expect(text).toContain('NO TRADING EXECUTED');
  });

  it('rendered output includes snapshot timeline entries', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);
    const text = renderBadRejectReview(review);

    expect(text).toContain('Snapshot timeline');
    expect(text).toContain('+20min');
  });

  it('rendered output includes mode: session-file', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);
    const text = renderBadRejectReview(review);

    expect(text).toContain('session-file');
  });
});

// ── Safety: noTradingExecuted ─────────────────────────────────────────────────

describe('buildBadRejectReview — safety invariants', () => {
  it('every item has noTradingExecuted: true', () => {
    const c1 = makeCandidate({ id: 'tg-001', ticker: 'A' });
    const c2 = makeCandidate({ id: 'tg-002', ticker: 'B', redFlags: [] });
    const snaps = [
      ...badRejectSnapshots('tg-001'),
      ...badRejectSnapshots('tg-002'),
    ];
    const autopsyReport = buildTokenGrabAutopsyReport([c1, c2], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([c1, c2], snaps, autopsyReport.results);

    for (const item of review.items) {
      expect(item.noTradingExecuted).toBe(true);
    }
  });

  it('tradingStatus is LOCKED / NO TRADING EXECUTED', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);
    expect(review.tradingStatus).toBe('LOCKED / NO TRADING EXECUTED');
  });

  it('mode is always session-file', () => {
    const candidate = makeCandidate();
    const snaps = badRejectSnapshots();
    const autopsyReport = buildTokenGrabAutopsyReport([candidate], snaps, { mode: 'session-file' });
    const review = buildBadRejectReview([candidate], snaps, autopsyReport.results);
    expect(review.mode).toBe('session-file');
  });
});
