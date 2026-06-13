import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperDelayedWatch,
  renderRipperDelayedWatch,
  type RipperDelayedWatchResult,
} from '../src/token-grab/ripperDelayedWatch';
import type { LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';

// ── Time anchor ───────────────────────────────────────────────────────────────

const NOW_MS  = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

// ── Fixture factory ───────────────────────────────────────────────────────────

function makeFixture(overrides: Partial<{
  contract:        string;
  symbol:          string;
  buyGateDecision: string;
  score:           number;
  ageMinutes:      number;
  priceChangePct:  number;
  clusterRisk:     string;
  entryPriceUsd:   number;
}> = {}): LiveRipperFixture {
  const contract = overrides.contract ?? 'ContractAAAA1111BBBB2222CCCC3333';
  return {
    id:         `fixture:${contract}`,
    capturedAt: NOW_ISO,
    source:     'dex-watch',
    sourceKind: 'DEX_NEW_POOL',
    normalizedSignal: {
      id:           contract,
      source:       'dex-watch',
      sourceKind:   'DEX_NEW_POOL',
      contract,
      symbol:       overrides.symbol ?? 'FRESH',
      discoveredAt: NOW_ISO,
      observedAt:   NOW_ISO,
      priceChangePct: overrides.priceChangePct ?? 10,
      raw: {
        entry:       { priceUsd: overrides.entryPriceUsd ?? 0.0001 },
        clusterRisk: overrides.clusterRisk ?? 'CLEAN',
      },
    },
    ripperInput:     null,
    ripperScore:     overrides.score        ?? 82,
    ageMinutes:      overrides.ageMinutes   ?? 3.5,
    buyGateDecision: overrides.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    entryDecision:   'READY_TO_SNIPE_PAPER',
    blockers:        [],
    topReasons:      [],
    warnings:        [],
    raw: {
      clusterRisk:     overrides.clusterRisk ?? 'CLEAN',
      clusterProvider: 'offline',
    },
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  } as unknown as LiveRipperFixture;
}

function writeJsonl(filePath: string, fixtures: LiveRipperFixture[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
}

// ── Temp dir ──────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-watch-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fp(name: string): string { return path.join(tmpDir, name); }
function outFp(name = 'watch.json'): string { return path.join(tmpDir, 'out', name); }

// ── extraction ────────────────────────────────────────────────────────────────

describe('runRipperDelayedWatch — extraction', () => {
  it('extracts BUY_APPROVED_PAPER candidates', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Approved', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'Rejected', buyGateDecision: 'BUY_REJECTED' }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidatesFound).toBe(1);
    expect(result.candidates[0].contractKey).toBe('Approved');
  });

  it('ignores non-approved fixtures', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ buyGateDecision: 'BUY_REJECTED' })]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidatesFound).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it('records all expected fields on each candidate', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({
        contract:        'DetailToken',
        symbol:          'DET',
        score:           90,
        ageMinutes:      4.0,
        clusterRisk:     'CLEAN',
        priceChangePct:  8,
        entryPriceUsd:   0.000123,
        buyGateDecision: 'BUY_APPROVED_PAPER',
      }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });
    const c = result.candidates[0];

    expect(c.contractKey).toBe('DetailToken');
    expect(c.symbol).toBe('DET');
    expect(c.score).toBe(90);
    expect(c.ageMinutes).toBe(4.0);
    expect(c.clusterRisk).toBe('CLEAN');
    expect(c.priceChangePct).toBe(8);
    expect(c.entryPriceUsd).toBe(0.000123);
    expect(c.approvedAt).toBe(NOW_ISO);
    expect(c.sourceArtifact).toBe(jsonl);
    expect(c.immediateApproved).toBe(true);
    expect(c.delayTargetMinutes).toBe(5);
  });

  it('sets immediateApprovalCount equal to candidatesFound', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A' }),
      makeFixture({ contract: 'B' }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.immediateApprovalCount).toBe(result.candidatesFound);
    expect(result.immediateApprovalCount).toBe(2);
  });
});

// ── delayRemainingMinutes ─────────────────────────────────────────────────────

describe('runRipperDelayedWatch — delayRemainingMinutes', () => {
  it('computes delayRemainingMinutes as max(0, target - age)', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ ageMinutes: 3.0 })]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidates[0].delayRemainingMinutes).toBeCloseTo(2.0, 5);
  });

  it('delayRemainingMinutes is 0 when candidate already meets delay target', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ ageMinutes: 7.0 })]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidates[0].delayRemainingMinutes).toBe(0);
  });

  it('delayRemainingMinutes is 0 when age exactly equals target', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ ageMinutes: 5.0 })]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidates[0].delayRemainingMinutes).toBe(0);
  });

  it('uses delayTargetMinutes as remaining when ageMinutes is unknown', () => {
    const jsonl = fp('cycle.jsonl');
    const f = makeFixture({ contract: 'NoAge' });
    (f as unknown as Record<string, unknown>).ageMinutes = undefined;
    writeJsonl(jsonl, [f]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidates[0].delayRemainingMinutes).toBe(5);
  });
});

// ── eligibleForDelayedEntry ──────────────────────────────────────────────────

describe('runRipperDelayedWatch — eligibleForDelayedEntry', () => {
  it('eligibleForDelayedEntry=false when ageMinutes < delayTarget', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ ageMinutes: 3.0 })]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidates[0].eligibleForDelayedEntry).toBe(false);
    expect(result.tooYoungCount).toBe(1);
    expect(result.eligibleCount).toBe(0);
  });

  it('eligibleForDelayedEntry=true when ageMinutes >= delayTarget', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ ageMinutes: 6.0 })]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidates[0].eligibleForDelayedEntry).toBe(true);
    expect(result.eligibleCount).toBe(1);
    expect(result.tooYoungCount).toBe(0);
  });

  it('eligibleForDelayedEntry=true when ageMinutes exactly equals delayTarget', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ ageMinutes: 5.0 })]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidates[0].eligibleForDelayedEntry).toBe(true);
    expect(result.eligibleCount).toBe(1);
  });

  it('eligibleForDelayedEntry=false when ageMinutes is null', () => {
    const jsonl = fp('cycle.jsonl');
    const f = makeFixture({ contract: 'NoAge' });
    (f as unknown as Record<string, unknown>).ageMinutes = undefined;
    writeJsonl(jsonl, [f]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidates[0].eligibleForDelayedEntry).toBe(false);
  });

  it('correctly partitions tooYoungCount and eligibleCount', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Young1', ageMinutes: 2.0 }),
      makeFixture({ contract: 'Young2', ageMinutes: 4.9 }),
      makeFixture({ contract: 'Old1',   ageMinutes: 5.0 }),
      makeFixture({ contract: 'Old2',   ageMinutes: 9.0 }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.tooYoungCount).toBe(2);
    expect(result.eligibleCount).toBe(2);
  });

  it('respects different delayTargetMinutes values', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ ageMinutes: 7.5 })]);

    const r8  = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp('r8.json'),  delayTargetMinutes: 8  });
    const r10 = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp('r10.json'), delayTargetMinutes: 10 });

    expect(r8.candidates[0].eligibleForDelayedEntry).toBe(false);
    expect(r10.candidates[0].eligibleForDelayedEntry).toBe(false);
    expect(r8.candidates[0].delayRemainingMinutes).toBeCloseTo(0.5, 5);
    expect(r10.candidates[0].delayRemainingMinutes).toBeCloseTo(2.5, 5);
  });
});

// ── deduplication ─────────────────────────────────────────────────────────────

describe('runRipperDelayedWatch — deduplication', () => {
  it('dedupes by contractKey keeping first seen', () => {
    const j1 = fp('c1.jsonl');
    const j2 = fp('c2.jsonl');
    writeJsonl(j1, [makeFixture({ contract: 'DupToken', score: 90 })]);
    writeJsonl(j2, [makeFixture({ contract: 'DupToken', score: 60 })]);

    const result = runRipperDelayedWatch({ inputPaths: [j1, j2], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidatesFound).toBe(1);
    expect(result.candidates[0].score).toBe(90);
  });

  it('dedupes within a single file', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'SameKey' }),
      makeFixture({ contract: 'SameKey' }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidatesFound).toBe(1);
  });

  it('keeps distinct contractKeys separate', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'TokenA' }),
      makeFixture({ contract: 'TokenB' }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidatesFound).toBe(2);
  });
});

// ── aggregate stats ───────────────────────────────────────────────────────────

describe('runRipperDelayedWatch — aggregate stats', () => {
  it('computes avgAge across all candidates', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A', ageMinutes: 3.0 }),
      makeFixture({ contract: 'B', ageMinutes: 7.0 }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.avgAge).toBeCloseTo(5.0, 5);
  });

  it('computes avgScore across all candidates', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A', score: 80 }),
      makeFixture({ contract: 'B', score: 100 }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.avgScore).toBeCloseTo(90, 5);
  });

  it('computes clusterBreakdown', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A', clusterRisk: 'CLEAN' }),
      makeFixture({ contract: 'B', clusterRisk: 'CLEAN' }),
      makeFixture({ contract: 'C', clusterRisk: 'WATCH' }),
      makeFixture({ contract: 'D', clusterRisk: 'RISKY' }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.clusterBreakdown.CLEAN).toBe(2);
    expect(result.clusterBreakdown.WATCH).toBe(1);
    expect(result.clusterBreakdown.RISKY).toBe(1);
    expect(result.clusterBreakdown.UNKNOWN).toBe(0);
  });

  it('counts fixturesScanned including non-approved', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A' }),
      makeFixture({ contract: 'B', buyGateDecision: 'BUY_REJECTED' }),
      makeFixture({ contract: 'C', buyGateDecision: 'BUY_REJECTED' }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.fixturesScanned).toBe(3);
    expect(result.candidatesFound).toBe(1);
  });

  it('eligible candidates come before too-young in output', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Young', ageMinutes: 2.0 }),
      makeFixture({ contract: 'Old',   ageMinutes: 8.0 }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidates[0].contractKey).toBe('Old');
    expect(result.candidates[1].contractKey).toBe('Young');
  });
});

// ── output file ───────────────────────────────────────────────────────────────

describe('runRipperDelayedWatch — output file', () => {
  it('writes JSON to the specified outPath', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture()]);
    const out = outFp();

    runRipperDelayedWatch({ inputPaths: [jsonl], outPath: out, delayTargetMinutes: 5 });

    expect(fs.existsSync(out)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(Array.isArray(parsed.candidates)).toBe(true);
  });

  it('creates output directory if missing', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture()]);
    const out = path.join(tmpDir, 'deep', 'nested', 'watch.json');

    runRipperDelayedWatch({ inputPaths: [jsonl], outPath: out, delayTargetMinutes: 5 });

    expect(fs.existsSync(out)).toBe(true);
  });

  it('written JSON includes safety fields', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture()]);
    const out = outFp();

    runRipperDelayedWatch({ inputPaths: [jsonl], outPath: out, delayTargetMinutes: 5 });

    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(parsed.realTradingLocked).toBe(true);
    expect(parsed.tradingExecuted).toBe(0);
    expect(parsed.noRealTradeSent).toBe(true);
    expect(parsed.paperOnly).toBe(true);
    expect(parsed.readOnly).toBe(true);
  });

  it('written JSON includes delayTargetMinutes', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture()]);
    const out = outFp();

    runRipperDelayedWatch({ inputPaths: [jsonl], outPath: out, delayTargetMinutes: 8 });

    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(parsed.delayTargetMinutes).toBe(8);
  });
});

// ── missing files ─────────────────────────────────────────────────────────────

describe('runRipperDelayedWatch — missing files', () => {
  it('counts missing files without throwing', () => {
    const result = runRipperDelayedWatch({
      inputPaths:         [fp('ghost.jsonl')],
      outPath:            outFp(),
      delayTargetMinutes: 5,
    });

    expect(result.filesMissing).toBe(1);
    expect(result.filesRead).toBe(0);
    expect(result.candidatesFound).toBe(0);
  });

  it('processes present files when others are missing', () => {
    const jsonl = fp('exists.jsonl');
    writeJsonl(jsonl, [makeFixture()]);

    const result = runRipperDelayedWatch({
      inputPaths:         [fp('ghost.jsonl'), jsonl],
      outPath:            outFp(),
      delayTargetMinutes: 5,
    });

    expect(result.filesMissing).toBe(1);
    expect(result.filesRead).toBe(1);
    expect(result.candidatesFound).toBe(1);
  });

  it('returns zero counts with no input files', () => {
    const result = runRipperDelayedWatch({
      inputPaths:         [],
      outPath:            outFp(),
      delayTargetMinutes: 5,
    });

    expect(result.candidatesFound).toBe(0);
    expect(result.tooYoungCount).toBe(0);
    expect(result.eligibleCount).toBe(0);
    expect(result.avgAge).toBeNull();
  });
});

// ── safety fields ─────────────────────────────────────────────────────────────

describe('runRipperDelayedWatch — safety', () => {
  it('result always has safety fields set correctly', () => {
    const result = runRipperDelayedWatch({
      inputPaths:         [],
      outPath:            outFp(),
      delayTargetMinutes: 5,
    });

    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('safety fields unchanged when candidates are present', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [makeFixture()]);

    const result = runRipperDelayedWatch({
      inputPaths:         [jsonl],
      outPath:            outFp(),
      delayTargetMinutes: 5,
    });

    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
  });
});

// ── renderer ──────────────────────────────────────────────────────────────────

describe('renderRipperDelayedWatch', () => {
  function makeResult(overrides: Partial<RipperDelayedWatchResult> = {}): RipperDelayedWatchResult {
    return {
      generatedAt:           NOW_ISO,
      outPath:               '/tmp/watch.json',
      delayTargetMinutes:    5,
      filesRead:             2,
      filesMissing:          0,
      fixturesScanned:       20,
      candidatesFound:       4,
      immediateApprovalCount: 4,
      tooYoungCount:         3,
      eligibleCount:         1,
      avgAge:                4.2,
      avgScore:              84,
      clusterBreakdown:      { CLEAN: 3, WATCH: 1, RISKY: 0, UNKNOWN: 0 },
      candidates:            [],
      realTradingLocked:     true,
      tradingExecuted:       0,
      noRealTradeSent:       true,
      paperOnly:             true,
      readOnly:              true,
      ...overrides,
    };
  }

  it('contains REAL TRADING LOCKED header', () => {
    expect(renderRipperDelayedWatch(makeResult())).toContain('REAL TRADING LOCKED');
  });

  it('contains safety footer', () => {
    const out = renderRipperDelayedWatch(makeResult());
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('paperOnly=true');
    expect(out).toContain('readOnly=true');
  });

  it('shows delay target', () => {
    expect(renderRipperDelayedWatch(makeResult({ delayTargetMinutes: 8 }))).toContain('8m');
  });

  it('shows summary counts', () => {
    const out = renderRipperDelayedWatch(makeResult());
    expect(out).toContain('4');  // candidatesFound
    expect(out).toContain('3');  // tooYoungCount
    expect(out).toContain('1');  // eligibleCount
  });

  it('shows missing files count when > 0', () => {
    expect(renderRipperDelayedWatch(makeResult({ filesMissing: 2 }))).toContain('2 missing');
  });

  it('shows no candidates message when list is empty', () => {
    const out = renderRipperDelayedWatch(makeResult({ candidatesFound: 0, candidates: [] }));
    expect(out).toContain('no approved candidates found');
  });

  it('shows candidate rows in eligible section', () => {
    const result = makeResult({
      candidates: [{
        contractKey:             'EligToken1234567',
        symbol:                  'ELIG',
        score:                   88,
        ageMinutes:              7.0,
        clusterRisk:             'CLEAN',
        entryPriceUsd:           0.0001,
        priceChangePct:          12,
        approvedAt:              NOW_ISO,
        sourceArtifact:          '/tmp/c.jsonl',
        immediateApproved:       true,
        delayTargetMinutes:      5,
        delayRemainingMinutes:   0,
        eligibleForDelayedEntry: true,
      }],
      eligibleCount:  1,
      tooYoungCount:  0,
      candidatesFound: 1,
    });
    const out = renderRipperDelayedWatch(result);
    expect(out).toContain('$ELIG');
    expect(out).toContain('eligible');
  });

  it('shows wait time in too-young section', () => {
    const result = makeResult({
      candidates: [{
        contractKey:             'YoungToken123456',
        symbol:                  'YUNG',
        score:                   75,
        ageMinutes:              2.5,
        clusterRisk:             'CLEAN',
        entryPriceUsd:           0.0001,
        priceChangePct:          5,
        approvedAt:              NOW_ISO,
        sourceArtifact:          '/tmp/c.jsonl',
        immediateApproved:       true,
        delayTargetMinutes:      5,
        delayRemainingMinutes:   2.5,
        eligibleForDelayedEntry: false,
      }],
      eligibleCount:  0,
      tooYoungCount:  1,
      candidatesFound: 1,
    });
    const out = renderRipperDelayedWatch(result);
    expect(out).toContain('$YUNG');
    expect(out).toContain('wait=');
  });

  it('shows output path', () => {
    expect(renderRipperDelayedWatch(makeResult({ outPath: '/my/watch.json' }))).toContain('/my/watch.json');
  });
});
