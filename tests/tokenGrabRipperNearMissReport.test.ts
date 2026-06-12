import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperNearMissReport,
  renderRipperNearMissReport,
  classifyBlocker,
} from '../src/token-grab/ripperNearMissReport';
import type { LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnmr-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Fixture factory ───────────────────────────────────────────────────────────

const BASE_ISO = '2026-06-12T00:00:00.000Z';

function makeFixture(overrides: Partial<LiveRipperFixture> = {}): LiveRipperFixture {
  return {
    id:          'test:TokenAAA111:2026-06-12-0000',
    capturedAt:  BASE_ISO,
    source:      'dex-watch',
    sourceKind:  'DEX_NEW_POOL',
    raw:         { clusterRisk: 'UNKNOWN' },
    normalizedSignal: {
      id:           'test-001',
      source:       'dex-watch',
      sourceKind:   'DEX_NEW_POOL',
      contract:     'TokenAAA111222333444',
      symbol:       'FRESH',
      discoveredAt: BASE_ISO,
      observedAt:   BASE_ISO,
      confidence:   'MEDIUM',
      warnings:     [],
    },
    ripperInput:     null,
    ripperScore:     50,
    launchAgeBucket: 'PRIME_WINDOW',
    ageMinutes:      8,
    entryDecision:   'READY_TO_SNIPE_PAPER',
    buyGateDecision: 'BUY_REJECTED',
    blockers:        ['score 50 below buy threshold 60'],
    topReasons:      [],
    warnings:        [],
    realTradingLocked: true,
    paperOnly:       true,
    readOnly:        true,
    ...overrides,
  };
}

function writeJsonl(filePath: string, fixtures: LiveRipperFixture[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    fixtures.map(f => JSON.stringify(f)).join('\n') + '\n',
    'utf-8',
  );
}

// ── classifyBlocker ───────────────────────────────────────────────────────────

describe('classifyBlocker', () => {
  it('classifies too early scorer blocker', () => {
    expect(classifyBlocker('too early (1m) — wait for prime window')).toBe('tooEarly');
  });

  it('classifies launch age TOO_EARLY gate blocker', () => {
    expect(classifyBlocker('launch age TOO_EARLY — must be PRIME_WINDOW')).toBe('tooEarly');
  });

  it('classifies launch age DEAD_WINDOW gate blocker', () => {
    expect(classifyBlocker('launch age DEAD_WINDOW — must be PRIME_WINDOW')).toBe('deadWindow');
  });

  it('classifies dead window scorer blocker', () => {
    expect(classifyBlocker('dead window (65m) — outside viable range')).toBe('deadWindow');
  });

  it('classifies launch age LATE gate blocker', () => {
    expect(classifyBlocker('launch age LATE — must be PRIME_WINDOW')).toBe('late');
  });

  it('classifies late window scorer blocker', () => {
    expect(classifyBlocker('late window (25m) — ripper window closing')).toBe('late');
  });

  it('classifies score below threshold', () => {
    expect(classifyBlocker('score 42 below buy threshold 60')).toBe('scoreBelow');
  });

  it('classifies entry decision blocker', () => {
    expect(classifyBlocker('entry decision is WATCH')).toBe('entryDecision');
  });

  it('classifies cluster risk RISKY', () => {
    expect(classifyBlocker('cluster risk RISKY — buy blocked')).toBe('clusterRisky');
  });

  it('classifies cluster risk WATCH', () => {
    expect(classifyBlocker('cluster risk WATCH — buy downgraded to review')).toBe('clusterWatch');
  });

  it('classifies holderRisk RISKY', () => {
    expect(classifyBlocker('holderRisk RISKY — top holder concentration unsafe (>40%)')).toBe('holderRisky');
  });

  it('classifies holder concentration RISKY scorer blocker', () => {
    expect(classifyBlocker('holder concentration RISKY')).toBe('holderRisky');
  });

  it('classifies bot/pump risk RISKY', () => {
    expect(classifyBlocker('bot/pump risk RISKY — buy blocked')).toBe('botPumpRisky');
  });

  it('classifies suspicious liquidity', () => {
    expect(classifyBlocker('suspicious liquidity — buy blocked')).toBe('suspiciousLiquidity');
  });

  it('classifies one-sided liquidity', () => {
    expect(classifyBlocker('one-sided liquidity — buy blocked')).toBe('oneSidedLiquidity');
  });

  it('classifies price declining', () => {
    expect(classifyBlocker('price declining 15.2%')).toBe('priceDecline');
  });

  it('classifies liquidity thinning', () => {
    expect(classifyBlocker('liquidity thinning')).toBe('liquidityThin');
  });

  it('returns other for unrecognized blockers', () => {
    expect(classifyBlocker('some unknown blocker text')).toBe('other');
  });
});

// ── runRipperNearMissReport — empty/missing inputs ─────────────────────────────

describe('runRipperNearMissReport — empty and missing inputs', () => {
  it('returns all zeros when inputPaths is empty', () => {
    const result = runRipperNearMissReport({ inputPaths: [] });
    expect(result.filesRead).toBe(0);
    expect(result.filesMissing).toBe(0);
    expect(result.fixturesAnalyzed).toBe(0);
    expect(result.approvedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(result.nearMisses).toHaveLength(0);
  });

  it('counts missing files correctly', () => {
    const result = runRipperNearMissReport({
      inputPaths: [
        path.join(tmpDir, 'does-not-exist-1.jsonl'),
        path.join(tmpDir, 'does-not-exist-2.jsonl'),
      ],
    });
    expect(result.filesRead).toBe(0);
    expect(result.filesMissing).toBe(2);
    expect(result.fixturesAnalyzed).toBe(0);
  });

  it('skips missing files and reads present ones', () => {
    const present = path.join(tmpDir, 'cycle-001.jsonl');
    writeJsonl(present, [makeFixture()]);

    const result = runRipperNearMissReport({
      inputPaths: [
        path.join(tmpDir, 'missing.jsonl'),
        present,
      ],
    });
    expect(result.filesRead).toBe(1);
    expect(result.filesMissing).toBe(1);
    expect(result.fixturesAnalyzed).toBe(1);
  });

  it('always has safety fields regardless of empty input', () => {
    const result = runRipperNearMissReport({ inputPaths: [] });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── runRipperNearMissReport — summary counts ────────────────────────────────

describe('runRipperNearMissReport — summary counts', () => {
  it('counts approved and rejected correctly', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER', blockers: [] }),
      makeFixture({ buyGateDecision: 'BUY_REJECTED', blockers: ['score 30 below buy threshold 60'] }),
      makeFixture({ buyGateDecision: 'BUY_REJECTED', blockers: ['too early (1m) — wait for prime window'] }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.approvedCount).toBe(1);
    expect(result.rejectedCount).toBe(2);
    expect(result.fixturesAnalyzed).toBe(3);
  });

  it('counts age buckets correctly', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ launchAgeBucket: 'TOO_EARLY',    buyGateDecision: 'BUY_REJECTED', blockers: ['too early (1m) — wait for prime window', 'launch age TOO_EARLY — must be PRIME_WINDOW'] }),
      makeFixture({ launchAgeBucket: 'TOO_EARLY',    buyGateDecision: 'BUY_REJECTED', blockers: ['too early (1m) — wait for prime window', 'launch age TOO_EARLY — must be PRIME_WINDOW'] }),
      makeFixture({ launchAgeBucket: 'PRIME_WINDOW', buyGateDecision: 'BUY_REJECTED', blockers: ['score 50 below buy threshold 60'] }),
      makeFixture({ launchAgeBucket: 'LATE',         buyGateDecision: 'BUY_REJECTED', blockers: ['launch age LATE — must be PRIME_WINDOW'] }),
      makeFixture({ launchAgeBucket: 'DEAD_WINDOW',  buyGateDecision: 'BUY_REJECTED', blockers: ['launch age DEAD_WINDOW — must be PRIME_WINDOW'] }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.tooEarlyCount).toBe(2);
    expect(result.primeWindowCount).toBe(1);
    expect(result.lateCount).toBe(1);
    expect(result.deadWindowCount).toBe(1);
  });

  it('counts cluster risk from fixture raw field', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ raw: { clusterRisk: 'CLEAN' },   buyGateDecision: 'BUY_REJECTED', blockers: ['score 30 below buy threshold 60'] }),
      makeFixture({ raw: { clusterRisk: 'WATCH' },   buyGateDecision: 'BUY_REJECTED', blockers: ['score 30 below buy threshold 60'] }),
      makeFixture({ raw: { clusterRisk: 'RISKY' },   buyGateDecision: 'BUY_REJECTED', blockers: ['score 30 below buy threshold 60'] }),
      makeFixture({ raw: { clusterRisk: 'UNKNOWN' }, buyGateDecision: 'BUY_REJECTED', blockers: ['score 30 below buy threshold 60'] }),
      makeFixture({ raw: undefined,                  buyGateDecision: 'BUY_REJECTED', blockers: ['score 30 below buy threshold 60'] }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.clusterRiskCounts['CLEAN']).toBe(1);
    expect(result.clusterRiskCounts['WATCH']).toBe(1);
    expect(result.clusterRiskCounts['RISKY']).toBe(1);
    expect(result.clusterRiskCounts['UNKNOWN']).toBe(2); // missing raw also becomes UNKNOWN
  });

  it('reads across multiple files and sums counts', () => {
    const f1 = path.join(tmpDir, 'cycle-001.jsonl');
    const f2 = path.join(tmpDir, 'cycle-002.jsonl');
    writeJsonl(f1, [makeFixture({ ripperScore: 70 }), makeFixture({ ripperScore: 60 })]);
    writeJsonl(f2, [makeFixture({ ripperScore: 80 }), makeFixture({ ripperScore: 40 })]);

    const result = runRipperNearMissReport({ inputPaths: [f1, f2] });
    expect(result.filesRead).toBe(2);
    expect(result.fixturesAnalyzed).toBe(4);
    expect(result.rejectedCount).toBe(4);
  });
});

// ── runRipperNearMissReport — blocker groups ────────────────────────────────

describe('runRipperNearMissReport — blocker group counts', () => {
  it('counts one per fixture per category, not per blocker occurrence', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    // Fixture with two too-early blockers — should still count as 1 for tooEarly
    writeJsonl(file, [
      makeFixture({
        buyGateDecision: 'BUY_REJECTED',
        blockers: [
          'too early (1m) — wait for prime window',
          'launch age TOO_EARLY — must be PRIME_WINDOW',
        ],
      }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.blockerGroups.tooEarly).toBe(1);
  });

  it('counts multiple categories for one fixture with diverse blockers', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({
        buyGateDecision: 'BUY_REJECTED',
        blockers: [
          'score 42 below buy threshold 60',
          'cluster risk WATCH — buy downgraded to review',
        ],
      }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.blockerGroups.scoreBelow).toBe(1);
    expect(result.blockerGroups.clusterWatch).toBe(1);
  });

  it('does not count approved fixtures in blocker groups', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER', blockers: [] }),
      makeFixture({ buyGateDecision: 'BUY_REJECTED', blockers: ['score 30 below buy threshold 60'] }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.blockerGroups.scoreBelow).toBe(1);
    expect(result.blockerGroups.tooEarly).toBe(0);
  });

  it('correctly counts each blocker category across multiple fixtures', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ buyGateDecision: 'BUY_REJECTED', blockers: ['score 30 below buy threshold 60'] }),
      makeFixture({ buyGateDecision: 'BUY_REJECTED', blockers: ['score 45 below buy threshold 60'] }),
      makeFixture({ buyGateDecision: 'BUY_REJECTED', blockers: ['cluster risk RISKY — buy blocked'] }),
      makeFixture({ buyGateDecision: 'BUY_REJECTED', blockers: ['price declining 20.0%'] }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.blockerGroups.scoreBelow).toBe(2);
    expect(result.blockerGroups.clusterRisky).toBe(1);
    expect(result.blockerGroups.priceDecline).toBe(1);
  });
});

// ── runRipperNearMissReport — near-miss ranking ────────────────────────────

describe('runRipperNearMissReport — near-miss ranking', () => {
  it('ranks rejected fixtures by ripperScore descending', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ ripperScore: 30, normalizedSignal: { ...makeFixture().normalizedSignal, contract: 'Token30' } }),
      makeFixture({ ripperScore: 80, normalizedSignal: { ...makeFixture().normalizedSignal, contract: 'Token80' } }),
      makeFixture({ ripperScore: 55, normalizedSignal: { ...makeFixture().normalizedSignal, contract: 'Token55' } }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.nearMisses[0].ripperScore).toBe(80);
    expect(result.nearMisses[1].ripperScore).toBe(55);
    expect(result.nearMisses[2].ripperScore).toBe(30);
  });

  it('respects topN limit', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, Array.from({ length: 30 }, (_, i) =>
      makeFixture({ ripperScore: i + 10 }),
    ));

    const result = runRipperNearMissReport({ inputPaths: [file], topN: 5 });
    expect(result.nearMisses).toHaveLength(5);
    expect(result.nearMisses[0].ripperScore).toBe(39); // highest
  });

  it('defaults to top 20', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, Array.from({ length: 25 }, (_, i) =>
      makeFixture({ ripperScore: i + 10 }),
    ));

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.nearMisses).toHaveLength(20);
  });

  it('sets nearestBlocker to first blocker', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ blockers: ['score 40 below buy threshold 60', 'cluster risk WATCH — buy downgraded to review'] }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.nearMisses[0].nearestBlocker).toBe('score 40 below buy threshold 60');
  });

  it('sets nearestBlocker to fallback when no blockers', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ blockers: [], buyGateDecision: 'BUY_REJECTED' }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.nearMisses[0].nearestBlocker).toBe('(no blockers recorded)');
  });

  it('does not include approved fixtures in near misses', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER', blockers: [], ripperScore: 99 }),
      makeFixture({ buyGateDecision: 'BUY_REJECTED',       blockers: ['score 30 below buy threshold 60'], ripperScore: 30 }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.nearMisses).toHaveLength(1);
    expect(result.nearMisses[0].ripperScore).toBe(30);
  });
});

// ── runRipperNearMissReport — tuning candidates ────────────────────────────

describe('runRipperNearMissReport — tuning candidates', () => {
  it('highScoreRejected includes rejected with score >= 75', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ ripperScore: 80, buyGateDecision: 'BUY_REJECTED', blockers: ['cluster risk RISKY — buy blocked'] }),
      makeFixture({ ripperScore: 74, buyGateDecision: 'BUY_REJECTED', blockers: ['score 74 below buy threshold 75'] }),
      makeFixture({ ripperScore: 75, buyGateDecision: 'BUY_REJECTED', blockers: ['cluster risk WATCH — buy downgraded to review'] }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.tuning.highScoreRejected).toHaveLength(2); // 80 and 75, not 74
    expect(result.tuning.highScoreRejected.map(e => e.ripperScore).sort()).toEqual([75, 80]);
  });

  it('primeWindowRejected only includes PRIME_WINDOW rejected', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ launchAgeBucket: 'PRIME_WINDOW', buyGateDecision: 'BUY_REJECTED', blockers: ['score 50 below buy threshold 60'] }),
      makeFixture({ launchAgeBucket: 'TOO_EARLY',   buyGateDecision: 'BUY_REJECTED', blockers: ['too early (1m) — wait for prime window', 'launch age TOO_EARLY — must be PRIME_WINDOW'] }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.tuning.primeWindowRejected).toHaveLength(1);
    expect(result.tuning.primeWindowRejected[0].launchAgeBucket).toBe('PRIME_WINDOW');
  });

  it('singleBlockerRejected includes rejected with exactly 1 blocker', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ blockers: ['score 50 below buy threshold 60'] }),
      makeFixture({ blockers: ['score 50 below buy threshold 60', 'cluster risk WATCH — buy downgraded to review'] }),
      makeFixture({ blockers: [] }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.tuning.singleBlockerRejected).toHaveLength(1);
    expect(result.tuning.singleBlockerRejected[0].blockers).toHaveLength(1);
  });

  it('tuning lists are sorted by score desc', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ ripperScore: 76, buyGateDecision: 'BUY_REJECTED', blockers: ['cluster risk RISKY — buy blocked'], launchAgeBucket: 'PRIME_WINDOW' }),
      makeFixture({ ripperScore: 90, buyGateDecision: 'BUY_REJECTED', blockers: ['cluster risk RISKY — buy blocked'], launchAgeBucket: 'PRIME_WINDOW' }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    expect(result.tuning.highScoreRejected[0].ripperScore).toBe(90);
    expect(result.tuning.primeWindowRejected[0].ripperScore).toBe(90);
  });
});

// ── renderRipperNearMissReport ─────────────────────────────────────────────

describe('renderRipperNearMissReport — output content', () => {
  it('includes REAL TRADING LOCKED header', () => {
    const result = runRipperNearMissReport({ inputPaths: [] });
    const out = renderRipperNearMissReport(result);
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('PAPER ONLY');
    expect(out).toContain('READ ONLY');
  });

  it('includes safety footer with all safety fields', () => {
    const result = runRipperNearMissReport({ inputPaths: [] });
    const out = renderRipperNearMissReport(result);
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('paperOnly=true');
    expect(out).toContain('readOnly=true');
  });

  it('shows fixture and file counts', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [makeFixture(), makeFixture()]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    const out = renderRipperNearMissReport(result);
    expect(out).toContain('Files read');
    expect(out).toContain('Fixtures');
    expect(out).toContain('Rejected');
  });

  it('shows BLOCKER BREAKDOWN section', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [makeFixture({ blockers: ['score 42 below buy threshold 60'] })]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    const out = renderRipperNearMissReport(result);
    expect(out).toContain('BLOCKER BREAKDOWN');
    expect(out).toContain('score below threshold');
  });

  it('shows TOP NEAR MISSES section', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [makeFixture({ ripperScore: 62, blockers: ['score 62 below buy threshold 65'] })]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    const out = renderRipperNearMissReport(result);
    expect(out).toContain('TOP NEAR MISSES');
    expect(out).toContain('score=62');
  });

  it('shows TUNING CANDIDATES section', () => {
    const result = runRipperNearMissReport({ inputPaths: [] });
    const out = renderRipperNearMissReport(result);
    expect(out).toContain('TUNING CANDIDATES');
    expect(out).toContain('High-score rejected');
    expect(out).toContain('Prime-window rejected');
    expect(out).toContain('Single-blocker rejected');
  });

  it('shows symbol when present', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({
        ripperScore: 55,
        blockers: ['score 55 below buy threshold 60'],
        normalizedSignal: { ...makeFixture().normalizedSignal, symbol: 'MOON' },
      }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    const out = renderRipperNearMissReport(result);
    expect(out).toContain('$MOON');
  });

  it('shows missing file count when files are absent', () => {
    const result = runRipperNearMissReport({
      inputPaths: [path.join(tmpDir, 'gone.jsonl')],
    });
    const out = renderRipperNearMissReport(result);
    expect(out).toContain('missing');
  });

  it('result has all safety fields set correctly', () => {
    const result = runRipperNearMissReport({ inputPaths: [] });
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('shows cluster risk breakdown in summary', () => {
    const file = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(file, [
      makeFixture({ raw: { clusterRisk: 'CLEAN' } }),
      makeFixture({ raw: { clusterRisk: 'RISKY' } }),
    ]);

    const result = runRipperNearMissReport({ inputPaths: [file] });
    const out = renderRipperNearMissReport(result);
    expect(out).toContain('Cluster risk');
    expect(out).toContain('CLEAN=1');
    expect(out).toContain('RISKY=1');
  });
});
