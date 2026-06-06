import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildAutopsyResult,
  buildTokenGrabAutopsyReport,
  renderTokenGrabAutopsyReport,
  RUN_GAIN_PCT,
  DIED_DRAWDOWN_PCT,
} from '../src/token-grab/autopsy';
import { loadAutopsyCandidatesFromFile, loadAutopsySnapshotsFromFile, loadAutopsySnapshotsFromFiles } from '../src/token-grab/autopsyLoaders';
import type { TokenGrabAutopsyCandidate, TokenGrabAutopsySnapshot } from '../src/token-grab/autopsy';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<TokenGrabAutopsyCandidate> = {}): TokenGrabAutopsyCandidate {
  return {
    id: 'ac-test',
    tokenName: 'TestToken',
    ticker: 'TEST',
    contractAddress: 'TestCAFakeForTestingPurposesNa11111111111',
    lane: 'FRESH_LAUNCH_CANDIDATE',
    decision: 'ALERT_ONLY',
    scoreAtDetection: 80,
    detectedAt: '2026-06-05T10:00:00Z',
    reasons: [],
    redFlags: [],
    ...overrides,
  };
}

function makeSnap(
  minutesAfterDetection: number,
  priceUsd: number,
  overrides: Partial<TokenGrabAutopsySnapshot> = {},
): TokenGrabAutopsySnapshot {
  return {
    candidateId: 'ac-test',
    observedAt: '2026-06-05T10:00:00Z',
    minutesAfterDetection,
    priceUsd,
    source: 'fixture',
    ...overrides,
  };
}

// ── buildAutopsyResult — core outcome logic ───────────────────────────────────

describe('buildAutopsyResult', () => {
  it('FRESH_LAUNCH_CANDIDATE with big later gain → RAN / GOOD_WATCH', () => {
    const candidate = makeCandidate({
      id: 'ac-goose',
      ticker: 'GOOSE',
      lane: 'FRESH_LAUNCH_CANDIDATE',
      decision: 'ALERT_ONLY',
    });
    const snapshots: TokenGrabAutopsySnapshot[] = [
      makeSnap(5, 0.0001, { candidateId: 'ac-goose', liquidityUsd: 45000, volumeUsd: 8200 }),
      makeSnap(42, 0.00034, { candidateId: 'ac-goose', liquidityUsd: 142000, volumeUsd: 89000 }),
      makeSnap(60, 0.00031, { candidateId: 'ac-goose', liquidityUsd: 120000, volumeUsd: 65000 }),
    ];

    const result = buildAutopsyResult(candidate, snapshots);

    expect(result.outcome).toBe('RAN');
    expect(result.verdict).toBe('GOOD_WATCH');
    expect(result.maxGainPct).toBeCloseTo(240, 0);
    expect(result.firstRunAtMinutes).toBe(42);
    expect(result.noTradingExecuted).toBe(true);
    expect(result.lessons).toContain('Social-confirmed fresh launch later ran.');
  });

  it('NOISE_RUG_LIKELY with price collapse → DIED / GOOD_REJECT', () => {
    const candidate = makeCandidate({
      id: 'ac-scamgem',
      ticker: 'SCAMGEM',
      lane: 'NOISE_RUG_LIKELY',
      decision: 'REJECT',
    });
    const snapshots: TokenGrabAutopsySnapshot[] = [
      makeSnap(5, 0.00005, { candidateId: 'ac-scamgem', liquidityUsd: 4000 }),
      makeSnap(30, 0.000008, { candidateId: 'ac-scamgem', liquidityUsd: 800 }),
      makeSnap(60, 0.000002, { candidateId: 'ac-scamgem', liquidityUsd: 150 }),
    ];

    const result = buildAutopsyResult(candidate, snapshots);

    expect(result.outcome).toBe('DIED');
    expect(result.verdict).toBe('GOOD_REJECT');
    expect(result.maxGainPct).toBeUndefined();
    expect(result.maxDrawdownPct).toBeDefined();
    expect(result.maxDrawdownPct!).toBeLessThan(DIED_DRAWDOWN_PCT);
    expect(result.noTradingExecuted).toBe(true);
    expect(result.lessons).toContain('Spam/no-context rejection was correct.');
  });

  it('NOISE_RUG_LIKELY with surprise run → RAN / BAD_REJECT', () => {
    const candidate = makeCandidate({
      id: 'ac-rnd999',
      ticker: 'RND999',
      lane: 'NOISE_RUG_LIKELY',
      decision: 'REJECT',
    });
    const snapshots: TokenGrabAutopsySnapshot[] = [
      makeSnap(5, 0.00002, { candidateId: 'ac-rnd999' }),
      makeSnap(45, 0.000065, { candidateId: 'ac-rnd999' }),
      makeSnap(60, 0.000078, { candidateId: 'ac-rnd999' }),
    ];

    const result = buildAutopsyResult(candidate, snapshots);

    expect(result.outcome).toBe('RAN');
    expect(result.verdict).toBe('BAD_REJECT');
    expect(result.maxGainPct).toBeGreaterThan(RUN_GAIN_PCT);
    expect(result.noTradingExecuted).toBe(true);
    expect(result.lessons).toContain('Rejected candidate later ran; inspect red flags/scoring.');
  });

  it('PRE_LAUNCH_WATCH with no snapshots → TOO_EARLY / NEEDS_MORE_DATA', () => {
    const candidate = makeCandidate({
      id: 'ac-moodeng',
      ticker: 'MOODENG',
      lane: 'PRE_LAUNCH_WATCH',
      decision: 'WATCH',
    });

    const result = buildAutopsyResult(candidate, []);

    expect(result.outcome).toBe('TOO_EARLY');
    expect(result.verdict).toBe('NEEDS_MORE_DATA');
    expect(result.noTradingExecuted).toBe(true);
    expect(result.lessons).toContain('No pool or snapshots yet; candidate is pre-formation.');
  });

  it('MEME_EVENT_CANDIDATE with no snapshots → TOO_EARLY / NEEDS_MORE_DATA', () => {
    const candidate = makeCandidate({
      id: 'ac-ptoad',
      ticker: 'PTOAD',
      lane: 'MEME_EVENT_CANDIDATE',
      decision: 'WATCH',
    });

    const result = buildAutopsyResult(candidate, []);

    expect(result.outcome).toBe('TOO_EARLY');
    expect(result.verdict).toBe('NEEDS_MORE_DATA');
    expect(result.noTradingExecuted).toBe(true);
  });

  it('single price snapshot → INSUFFICIENT_DATA / NEEDS_MORE_DATA', () => {
    const candidate = makeCandidate({
      lane: 'FRESH_LAUNCH_CANDIDATE',
      decision: 'ALERT_ONLY',
    });

    const result = buildAutopsyResult(candidate, [makeSnap(5, 0.0001)]);

    expect(result.outcome).toBe('INSUFFICIENT_DATA');
    expect(result.verdict).toBe('NEEDS_MORE_DATA');
    expect(result.noTradingExecuted).toBe(true);
    expect(result.lessons).toContain('Not enough price snapshots to determine outcome.');
  });

  it('FRESH_LAUNCH_CANDIDATE with no snapshots → INSUFFICIENT_DATA (not TOO_EARLY)', () => {
    const candidate = makeCandidate({
      lane: 'FRESH_LAUNCH_CANDIDATE',
      decision: 'ALERT_ONLY',
    });

    const result = buildAutopsyResult(candidate, []);

    expect(result.outcome).toBe('INSUFFICIENT_DATA');
    expect(result.verdict).toBe('NEEDS_MORE_DATA');
  });

  it('PRE_LAUNCH_WATCH that runs → MISSED_RUN verdict', () => {
    const candidate = makeCandidate({
      lane: 'PRE_LAUNCH_WATCH',
      decision: 'WATCH',
    });
    const snapshots = [
      makeSnap(5, 0.0001),
      makeSnap(30, 0.00025),
      makeSnap(60, 0.00032),
    ];

    const result = buildAutopsyResult(candidate, snapshots);

    expect(result.outcome).toBe('RAN');
    expect(result.verdict).toBe('MISSED_RUN');
    expect(result.lessons).toContain(
      'Pre-launch watch later ran; consider faster lane escalation on similar setups.',
    );
  });

  it('FLAT outcome for ALERT_ONLY → NO_SIGNAL verdict', () => {
    const candidate = makeCandidate({ decision: 'ALERT_ONLY' });
    const snapshots = [
      makeSnap(5, 0.0001),
      makeSnap(60, 0.000105),
    ];

    const result = buildAutopsyResult(candidate, snapshots);

    expect(result.outcome).toBe('FLAT');
    expect(result.verdict).toBe('NO_SIGNAL');
  });

  it('FLAT outcome for REJECT → GOOD_REJECT verdict', () => {
    const candidate = makeCandidate({ lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' });
    const snapshots = [
      makeSnap(5, 0.0001),
      makeSnap(60, 0.000095),
    ];

    const result = buildAutopsyResult(candidate, snapshots);

    expect(result.outcome).toBe('FLAT');
    expect(result.verdict).toBe('GOOD_REJECT');
  });

  it('liquidityChangePct is computed from first to last liquidity snapshot', () => {
    const candidate = makeCandidate();
    const snapshots = [
      makeSnap(5, 0.0001, { liquidityUsd: 50000 }),
      makeSnap(60, 0.0001, { liquidityUsd: 10000 }),
    ];

    const result = buildAutopsyResult(candidate, snapshots);

    expect(result.liquidityChangePct).toBeCloseTo(-80, 0);
  });

  it('volumePeakUsd is the highest volume across all snapshots', () => {
    const candidate = makeCandidate();
    const snapshots = [
      makeSnap(5, 0.0001, { volumeUsd: 5000 }),
      makeSnap(30, 0.00025, { volumeUsd: 92000 }),
      makeSnap(60, 0.00022, { volumeUsd: 45000 }),
    ];

    const result = buildAutopsyResult(candidate, snapshots);

    expect(result.volumePeakUsd).toBe(92000);
  });

  it('liquidity-only DIED: low price drawdown but big liquidity drop triggers DIED', () => {
    const candidate = makeCandidate({ lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' });
    const snapshots = [
      makeSnap(5, 0.0001, { liquidityUsd: 100000 }),
      makeSnap(60, 0.00007, { liquidityUsd: 30000 }),
    ];

    const result = buildAutopsyResult(candidate, snapshots);

    // price drop is -30% (not below DIED threshold), but liq dropped -70% (below LIQUIDITY_DROP_PCT)
    expect(result.outcome).toBe('DIED');
    expect(result.verdict).toBe('GOOD_REJECT');
  });
});

// ── buildTokenGrabAutopsyReport ───────────────────────────────────────────────

describe('buildTokenGrabAutopsyReport', () => {
  it('returns one result per candidate', () => {
    const candidates = [
      makeCandidate({ id: 'c1', ticker: 'AAA' }),
      makeCandidate({ id: 'c2', ticker: 'BBB', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' }),
    ];
    const report = buildTokenGrabAutopsyReport(candidates, []);

    expect(report.results).toHaveLength(2);
    expect(report.mode).toBe('fixture-only');
    expect(report.tradingStatus).toBe('LOCKED / NO TRADING EXECUTED');
  });

  it('summary counts are correct for mixed outcomes', () => {
    const goose = makeCandidate({ id: 'ac-goose', ticker: 'GOOSE' });
    const scam = makeCandidate({ id: 'ac-scam', ticker: 'SCAM', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' });
    const rnd = makeCandidate({ id: 'ac-rnd', ticker: 'RND', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' });
    const moodeng = makeCandidate({ id: 'ac-moodeng', ticker: 'MOODENG', lane: 'PRE_LAUNCH_WATCH', decision: 'WATCH' });

    const snapshots: TokenGrabAutopsySnapshot[] = [
      // GOOSE: runs +240%
      makeSnap(5, 0.0001, { candidateId: 'ac-goose' }),
      makeSnap(42, 0.00034, { candidateId: 'ac-goose' }),
      // SCAM: collapses -84%
      makeSnap(5, 0.00005, { candidateId: 'ac-scam' }),
      makeSnap(60, 0.000008, { candidateId: 'ac-scam' }),
      // RND: surprise run +225%
      makeSnap(5, 0.00002, { candidateId: 'ac-rnd' }),
      makeSnap(45, 0.000065, { candidateId: 'ac-rnd' }),
      // MOODENG: no snapshots → TOO_EARLY
    ];

    const report = buildTokenGrabAutopsyReport([goose, scam, rnd, moodeng], snapshots);

    expect(report.summary.candidatesReviewed).toBe(4);
    expect(report.summary.ran).toBe(2);
    expect(report.summary.died).toBe(1);
    expect(report.summary.tooEarly).toBe(1);
    expect(report.summary.goodWatches).toBe(1);
    expect(report.summary.badRejects).toBe(1);
    expect(report.summary.goodRejects).toBe(1);
    expect(report.summary.tradingExecuted).toBe(0);
  });

  it('every result has noTradingExecuted: true', () => {
    const candidates = [
      makeCandidate({ id: 'c1' }),
      makeCandidate({ id: 'c2', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' }),
    ];
    const report = buildTokenGrabAutopsyReport(candidates, []);

    for (const r of report.results) {
      expect(r.noTradingExecuted).toBe(true);
    }
  });

  it('empty candidates produces empty results with zero summary', () => {
    const report = buildTokenGrabAutopsyReport([], []);

    expect(report.results).toHaveLength(0);
    expect(report.summary.candidatesReviewed).toBe(0);
    expect(report.summary.tradingExecuted).toBe(0);
  });

  it('snapshots are correctly scoped to their candidate — no cross-contamination', () => {
    const a = makeCandidate({ id: 'cA', ticker: 'AAA' });
    const b = makeCandidate({ id: 'cB', ticker: 'BBB', lane: 'PRE_LAUNCH_WATCH', decision: 'WATCH' });

    const snapshots: TokenGrabAutopsySnapshot[] = [
      makeSnap(5, 0.0001, { candidateId: 'cA' }),
      makeSnap(60, 0.00034, { candidateId: 'cA' }),
      // cB gets no snapshots
    ];

    const report = buildTokenGrabAutopsyReport([a, b], snapshots);

    const resultA = report.results.find(r => r.ticker === 'AAA')!;
    const resultB = report.results.find(r => r.ticker === 'BBB')!;
    expect(resultA.outcome).toBe('RAN');
    expect(resultB.outcome).toBe('TOO_EARLY');
  });
});

// ── renderTokenGrabAutopsyReport ──────────────────────────────────────────────

describe('renderTokenGrabAutopsyReport', () => {
  it('output includes NO TRADING EXECUTED', () => {
    const report = buildTokenGrabAutopsyReport([makeCandidate()], []);
    const text = renderTokenGrabAutopsyReport(report);

    expect(text).toContain('NO TRADING EXECUTED');
  });

  it('output includes candidate ticker and verdict', () => {
    const candidate = makeCandidate({ ticker: 'GOOSE' });
    const snapshots = [
      makeSnap(5, 0.0001),
      makeSnap(42, 0.00034),
    ];
    const report = buildTokenGrabAutopsyReport([candidate], snapshots);
    const text = renderTokenGrabAutopsyReport(report);

    expect(text).toContain('GOOSE');
    expect(text).toContain('GOOD_WATCH');
    expect(text).toContain('RAN');
    expect(text).toContain('+240%');
  });

  it('summary section shows correct counts', () => {
    const c1 = makeCandidate({ id: 'c1', ticker: 'A' });
    const c2 = makeCandidate({ id: 'c2', ticker: 'B', lane: 'NOISE_RUG_LIKELY', decision: 'REJECT' });
    const snaps: TokenGrabAutopsySnapshot[] = [
      makeSnap(5, 0.0001, { candidateId: 'c1' }),
      makeSnap(60, 0.00034, { candidateId: 'c1' }),
    ];
    const report = buildTokenGrabAutopsyReport([c1, c2], snaps);
    const text = renderTokenGrabAutopsyReport(report);

    expect(text).toContain('Candidates reviewed : 2');
    expect(text).toContain('Ran                 : 1');
    expect(text).toContain('Trading executed    : 0');
  });
});

// ── Loaders ───────────────────────────────────────────────────────────────────

describe('loadAutopsyCandidatesFromFile', () => {
  it('loads autopsy-candidates.json fixture without error', () => {
    const filePath = path.join(__dirname, '../fixtures/token-grab/autopsy-candidates.json');
    const candidates = loadAutopsyCandidatesFromFile(filePath);

    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toHaveProperty('id');
    expect(candidates[0]).toHaveProperty('ticker');
    expect(candidates[0]).toHaveProperty('lane');
    expect(candidates[0]).toHaveProperty('decision');
    expect(candidates[0]).toHaveProperty('scoreAtDetection');
  });

  it('throws descriptive error for non-existent file', () => {
    expect(() => loadAutopsyCandidatesFromFile('/no/such/candidates.json')).toThrow(
      'Cannot read file',
    );
  });

  it('throws descriptive error for malformed JSON', () => {
    const tmp = path.join(os.tmpdir(), `tg-autopsy-bad-${process.pid}.json`);
    fs.writeFileSync(tmp, '{ not valid json }');
    try {
      expect(() => loadAutopsyCandidatesFromFile(tmp)).toThrow('Invalid JSON');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('throws descriptive error when JSON is not an array', () => {
    const tmp = path.join(os.tmpdir(), `tg-autopsy-obj-${process.pid}.json`);
    fs.writeFileSync(tmp, '{"id":"ac1"}');
    try {
      expect(() => loadAutopsyCandidatesFromFile(tmp)).toThrow('Expected JSON array');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('loadAutopsySnapshotsFromFile', () => {
  it('loads autopsy-snapshots.json fixture without error', () => {
    const filePath = path.join(__dirname, '../fixtures/token-grab/autopsy-snapshots.json');
    const snapshots = loadAutopsySnapshotsFromFile(filePath);

    expect(Array.isArray(snapshots)).toBe(true);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]).toHaveProperty('candidateId');
    expect(snapshots[0]).toHaveProperty('minutesAfterDetection');
    expect(snapshots[0]).toHaveProperty('source');
  });

  it('throws descriptive error for non-existent file', () => {
    expect(() => loadAutopsySnapshotsFromFile('/no/such/snapshots.json')).toThrow(
      'Cannot read file',
    );
  });
});

// ── loadAutopsySnapshotsFromFiles ─────────────────────────────────────────────

describe('loadAutopsySnapshotsFromFiles', () => {
  function writeTmpSnapshots(label: string, snapshots: TokenGrabAutopsySnapshot[]): string {
    const filePath = path.join(os.tmpdir(), `tg-multi-snap-${label}-${process.pid}.json`);
    fs.writeFileSync(filePath, JSON.stringify(snapshots));
    return filePath;
  }

  it('loads a single path and returns its snapshots', () => {
    const filePath = path.join(__dirname, '../fixtures/token-grab/autopsy-snapshots.json');
    const snapshots = loadAutopsySnapshotsFromFiles([filePath]);

    expect(Array.isArray(snapshots)).toBe(true);
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('combines snapshots from two files into one array', () => {
    const snapA: TokenGrabAutopsySnapshot[] = [
      { candidateId: 'cA', observedAt: '2026-06-06T10:00:00.000Z', minutesAfterDetection: 10, priceUsd: 0.001, source: 'geckoterminal' },
    ];
    const snapB: TokenGrabAutopsySnapshot[] = [
      { candidateId: 'cB', observedAt: '2026-06-06T11:00:00.000Z', minutesAfterDetection: 20, priceUsd: 0.002, source: 'geckoterminal' },
    ];
    const pathA = writeTmpSnapshots('combineA', snapA);
    const pathB = writeTmpSnapshots('combineB', snapB);

    try {
      const combined = loadAutopsySnapshotsFromFiles([pathA, pathB]);
      expect(combined).toHaveLength(2);
      const ids = combined.map(s => s.candidateId);
      expect(ids).toContain('cA');
      expect(ids).toContain('cB');
    } finally {
      fs.rmSync(pathA, { force: true });
      fs.rmSync(pathB, { force: true });
    }
  });

  it('result is sorted by observedAt', () => {
    const snapsLate: TokenGrabAutopsySnapshot[] = [
      { candidateId: 'cLate', observedAt: '2026-06-06T12:00:00.000Z', minutesAfterDetection: 60, source: 'geckoterminal' },
    ];
    const snapsEarly: TokenGrabAutopsySnapshot[] = [
      { candidateId: 'cEarly', observedAt: '2026-06-06T09:00:00.000Z', minutesAfterDetection: 5, source: 'geckoterminal' },
    ];
    const pathLate = writeTmpSnapshots('sortLate', snapsLate);
    const pathEarly = writeTmpSnapshots('sortEarly', snapsEarly);

    try {
      const combined = loadAutopsySnapshotsFromFiles([pathLate, pathEarly]);
      expect(combined[0]!.candidateId).toBe('cEarly');
      expect(combined[1]!.candidateId).toBe('cLate');
    } finally {
      fs.rmSync(pathLate, { force: true });
      fs.rmSync(pathEarly, { force: true });
    }
  });

  it('throws clearly when a snapshot file is missing', () => {
    expect(() => loadAutopsySnapshotsFromFiles(['/no/such/snap.json'])).toThrow(
      'Cannot read file',
    );
  });

  it('combining two files with two snapshots per candidate enables outcome (not INSUFFICIENT_DATA)', () => {
    const snapA: TokenGrabAutopsySnapshot[] = [
      { candidateId: 'cX', observedAt: '2026-06-06T10:00:00.000Z', minutesAfterDetection: 10, priceUsd: 0.0001, source: 'geckoterminal' },
    ];
    const snapB: TokenGrabAutopsySnapshot[] = [
      { candidateId: 'cX', observedAt: '2026-06-06T11:00:00.000Z', minutesAfterDetection: 70, priceUsd: 0.00034, source: 'geckoterminal' },
    ];
    const pathA = writeTmpSnapshots('outcomeA', snapA);
    const pathB = writeTmpSnapshots('outcomeB', snapB);

    const candidate = makeCandidate({ id: 'cX', ticker: 'XTEST', lane: 'FRESH_LAUNCH_CANDIDATE', decision: 'ALERT_ONLY' });

    try {
      const combined = loadAutopsySnapshotsFromFiles([pathA, pathB]);
      const report = buildTokenGrabAutopsyReport([candidate], combined, { mode: 'session-file' });
      const result = report.results[0]!;
      // Two snapshots → outcome is determinable, not INSUFFICIENT_DATA
      expect(result.outcome).not.toBe('INSUFFICIENT_DATA');
      expect(result.outcome).toBe('RAN');
      expect(result.noTradingExecuted).toBe(true);
    } finally {
      fs.rmSync(pathA, { force: true });
      fs.rmSync(pathB, { force: true });
    }
  });

  it('empty paths array returns empty array', () => {
    const result = loadAutopsySnapshotsFromFiles([]);
    expect(result).toHaveLength(0);
  });
});

// ── End-to-end: fixture files → full report ───────────────────────────────────

describe('end-to-end: fixture files produce expected verdicts', () => {
  const candidatesPath = path.join(__dirname, '../fixtures/token-grab/autopsy-candidates.json');
  const snapshotsPath = path.join(__dirname, '../fixtures/token-grab/autopsy-snapshots.json');

  it('GOOSE (FRESH_LAUNCH_CANDIDATE) with +240% run → GOOD_WATCH', () => {
    const candidates = loadAutopsyCandidatesFromFile(candidatesPath);
    const snapshots = loadAutopsySnapshotsFromFile(snapshotsPath);
    const report = buildTokenGrabAutopsyReport(candidates, snapshots);

    const goose = report.results.find(r => r.ticker === 'GOOSE');
    expect(goose).toBeDefined();
    expect(goose!.outcome).toBe('RAN');
    expect(goose!.verdict).toBe('GOOD_WATCH');
    expect(goose!.maxGainPct).toBeCloseTo(240, 0);
    expect(goose!.firstRunAtMinutes).toBe(42);
    expect(goose!.noTradingExecuted).toBe(true);
  });

  it('SCAMGEM (NOISE_RUG_LIKELY) with collapse → GOOD_REJECT', () => {
    const candidates = loadAutopsyCandidatesFromFile(candidatesPath);
    const snapshots = loadAutopsySnapshotsFromFile(snapshotsPath);
    const report = buildTokenGrabAutopsyReport(candidates, snapshots);

    const scam = report.results.find(r => r.ticker === 'SCAMGEM');
    expect(scam).toBeDefined();
    expect(scam!.outcome).toBe('DIED');
    expect(scam!.verdict).toBe('GOOD_REJECT');
    expect(scam!.noTradingExecuted).toBe(true);
  });

  it('RND999 (NOISE_RUG_LIKELY) with surprise run → BAD_REJECT', () => {
    const candidates = loadAutopsyCandidatesFromFile(candidatesPath);
    const snapshots = loadAutopsySnapshotsFromFile(snapshotsPath);
    const report = buildTokenGrabAutopsyReport(candidates, snapshots);

    const rnd = report.results.find(r => r.ticker === 'RND999');
    expect(rnd).toBeDefined();
    expect(rnd!.outcome).toBe('RAN');
    expect(rnd!.verdict).toBe('BAD_REJECT');
    expect(rnd!.noTradingExecuted).toBe(true);
  });

  it('MOODENG (PRE_LAUNCH_WATCH) with no snapshots → NEEDS_MORE_DATA', () => {
    const candidates = loadAutopsyCandidatesFromFile(candidatesPath);
    const snapshots = loadAutopsySnapshotsFromFile(snapshotsPath);
    const report = buildTokenGrabAutopsyReport(candidates, snapshots);

    const moodeng = report.results.find(r => r.ticker === 'MOODENG');
    expect(moodeng).toBeDefined();
    expect(moodeng!.outcome).toBe('TOO_EARLY');
    expect(moodeng!.verdict).toBe('NEEDS_MORE_DATA');
  });

  it('PTOAD (MEME_EVENT_CANDIDATE) with no snapshots → TOO_EARLY', () => {
    const candidates = loadAutopsyCandidatesFromFile(candidatesPath);
    const snapshots = loadAutopsySnapshotsFromFile(snapshotsPath);
    const report = buildTokenGrabAutopsyReport(candidates, snapshots);

    const ptoad = report.results.find(r => r.ticker === 'PTOAD');
    expect(ptoad).toBeDefined();
    expect(ptoad!.outcome).toBe('TOO_EARLY');
    expect(ptoad!.verdict).toBe('NEEDS_MORE_DATA');
  });

  it('full fixture report: trading executed is always 0', () => {
    const candidates = loadAutopsyCandidatesFromFile(candidatesPath);
    const snapshots = loadAutopsySnapshotsFromFile(snapshotsPath);
    const report = buildTokenGrabAutopsyReport(candidates, snapshots);

    expect(report.summary.tradingExecuted).toBe(0);
    for (const r of report.results) {
      expect(r.noTradingExecuted).toBe(true);
    }
  });
});
