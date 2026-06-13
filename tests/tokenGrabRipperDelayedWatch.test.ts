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

const NOW_MS  = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

function makeFixture(overrides: Partial<{
  contract: string;
  symbol: string;
  buyGateDecision: string;
  score: number;
  ageMinutes: number;
  priceChangePct: number;
  clusterRisk: string;
  entryPriceUsd: number;
  capturedAt: string;
  postApprovalObservation: boolean;
  originalApprovedAt: string;
}> = {}): LiveRipperFixture {
  const contract = overrides.contract ?? 'ContractAAAA1111BBBB2222CCCC3333';
  const base: Record<string, unknown> = {
    id:         `fixture:${contract}`,
    capturedAt: overrides.capturedAt ?? NOW_ISO,
    source:     'dex-watch',
    sourceKind: 'DEX_NEW_POOL',
    normalizedSignal: {
      id:             contract,
      source:         'dex-watch',
      sourceKind:     'DEX_NEW_POOL',
      contract,
      symbol:         overrides.symbol ?? 'FRESH',
      discoveredAt:   NOW_ISO,
      observedAt:     NOW_ISO,
      priceChangePct: overrides.priceChangePct ?? 10,
      raw: {
        entry: { priceUsd: overrides.entryPriceUsd ?? 0.0001 },
      },
    },
    ripperInput:     null,
    ripperScore:     overrides.score ?? 82,
    ageMinutes:      overrides.ageMinutes ?? 3.5,
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
  };
  if (overrides.postApprovalObservation) base['postApprovalObservation'] = true;
  if (overrides.originalApprovedAt) base['originalApprovedAt'] = overrides.originalApprovedAt;
  return base as unknown as LiveRipperFixture;
}

function writeJsonl(filePath: string, fixtures: Array<Record<string, unknown> | LiveRipperFixture>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delayed-watch-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fp(name: string): string { return path.join(tmpDir, name); }
function outFp(name = 'watch.json'): string { return path.join(tmpDir, 'out', name); }

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

  it('sets immediateApprovalCount equal to only immediate approvals found', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A' }),
      makeFixture({ contract: 'B' }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.immediateApprovalCount).toBe(2);
    expect(result.candidatesFound).toBe(2);
  });
});

describe('runRipperDelayedWatch — observations', () => {
  it('reads normal approval fixture plus later observation fixture for same contract', () => {
    const cycle = fp('cycle.jsonl');
    const obs = fp('obs.jsonl');
    writeJsonl(cycle, [makeFixture({ contract: 'ObsToken', ageMinutes: 3.3, score: 88, priceChangePct: 12 })]);
    writeJsonl(obs, [makeFixture({
      contract: 'ObsToken',
      ageMinutes: 6.5,
      score: 91,
      priceChangePct: 18,
      postApprovalObservation: true,
      originalApprovedAt: NOW_ISO,
      capturedAt: new Date(NOW_MS + 60_000).toISOString(),
    })]);

    const result = runRipperDelayedWatch({ inputPaths: [cycle, obs], outPath: outFp(), delayTargetMinutes: 5 });
    const c = result.candidates[0];

    expect(result.immediateApprovalCount).toBe(1);
    expect(result.postApprovalObservationsRead).toBe(1);
    expect(result.candidatesFound).toBe(1);
    expect(c.ageMinutes).toBe(3.3);
    expect(c.latestObservedAgeMinutes).toBe(6.5);
    expect(c.latestObservedScore).toBe(91);
    expect(c.latestObservedPriceChangePct).toBe(18);
    expect(c.eligibleForDelayedEntry).toBe(true);
  });

  it('uses later observation age for 5m/8m eligibility', () => {
    const cycle = fp('cycle.jsonl');
    const obs = fp('obs.jsonl');
    writeJsonl(cycle, [makeFixture({ contract: 'AgeToken', ageMinutes: 3.4 })]);
    writeJsonl(obs, [makeFixture({
      contract: 'AgeToken',
      ageMinutes: 6.1,
      postApprovalObservation: true,
      originalApprovedAt: NOW_ISO,
      capturedAt: new Date(NOW_MS + 60_000).toISOString(),
    })]);

    const r5 = runRipperDelayedWatch({ inputPaths: [cycle, obs], outPath: outFp('r5.json'), delayTargetMinutes: 5 });
    const r8 = runRipperDelayedWatch({ inputPaths: [cycle, obs], outPath: outFp('r8.json'), delayTargetMinutes: 8 });

    expect(r5.candidates[0].eligibleForDelayedEntry).toBe(true);
    expect(r5.eligibleCount).toBe(1);
    expect(r8.candidates[0].eligibleForDelayedEntry).toBe(false);
    expect(r8.tooYoungCount).toBe(1);
  });

  it('does not double-count duplicate observations and keeps highest-age/latest observation', () => {
    const cycle = fp('cycle.jsonl');
    const obs = fp('obs.jsonl');
    writeJsonl(cycle, [makeFixture({ contract: 'DupObs', ageMinutes: 3.0 })]);
    writeJsonl(obs, [
      makeFixture({ contract: 'DupObs', ageMinutes: 4.0, score: 85, postApprovalObservation: true, originalApprovedAt: NOW_ISO, capturedAt: new Date(NOW_MS + 60_000).toISOString() }),
      makeFixture({ contract: 'DupObs', ageMinutes: 7.0, score: 95, postApprovalObservation: true, originalApprovedAt: NOW_ISO, capturedAt: new Date(NOW_MS + 120_000).toISOString() }),
      makeFixture({ contract: 'DupObs', ageMinutes: 6.0, score: 90, postApprovalObservation: true, originalApprovedAt: NOW_ISO, capturedAt: new Date(NOW_MS + 180_000).toISOString() }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [cycle, obs], outPath: outFp(), delayTargetMinutes: 5 });
    const c = result.candidates[0];

    expect(result.candidatesFound).toBe(1);
    expect(result.postApprovalObservationsRead).toBe(3);
    expect(c.postApprovalObservationCount).toBe(3);
    expect(c.latestObservedAgeMinutes).toBe(7.0);
    expect(c.latestObservedScore).toBe(95);
    expect(c.eligibleForDelayedEntry).toBe(true);
  });
});

describe('runRipperDelayedWatch — delayRemainingMinutes', () => {
  it('computes delayRemainingMinutes as max(0, target - latest age)', () => {
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

  it('uses delayTargetMinutes as remaining when ageMinutes is unknown', () => {
    const jsonl = fp('cycle.jsonl');
    const f = makeFixture({ contract: 'NoAge' }) as unknown as Record<string, unknown>;
    f['ageMinutes'] = undefined;
    writeJsonl(jsonl, [f]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.candidates[0].delayRemainingMinutes).toBe(5);
  });
});

describe('runRipperDelayedWatch — aggregate stats', () => {
  it('computes avgAge across latest ages', () => {
    const jsonl = fp('cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A', ageMinutes: 3.0 }),
      makeFixture({ contract: 'B', ageMinutes: 7.0 }),
    ]);

    const result = runRipperDelayedWatch({ inputPaths: [jsonl], outPath: outFp(), delayTargetMinutes: 5 });

    expect(result.avgAge).toBeCloseTo(5.0, 5);
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
});

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
});

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
});

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
});

describe('renderRipperDelayedWatch', () => {
  function makeResult(overrides: Partial<RipperDelayedWatchResult> = {}): RipperDelayedWatchResult {
    return {
      generatedAt:            NOW_ISO,
      outPath:                '/tmp/watch.json',
      delayTargetMinutes:     5,
      filesRead:              2,
      filesMissing:           0,
      fixturesScanned:        20,
      candidatesFound:        4,
      immediateApprovalCount: 2,
      postApprovalObservationsRead: 3,
      tooYoungCount:          3,
      eligibleCount:          1,
      avgAge:                 4.2,
      avgScore:               84,
      clusterBreakdown:       { CLEAN: 3, WATCH: 1, RISKY: 0, UNKNOWN: 0 },
      candidates:             [],
      realTradingLocked:      true,
      tradingExecuted:        0,
      noRealTradeSent:        true,
      paperOnly:              true,
      readOnly:               true,
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

  it('shows post-approval observation count', () => {
    expect(renderRipperDelayedWatch(makeResult())).toContain('Post-approval obs');
  });

  it('shows no candidates message when list is empty', () => {
    const out = renderRipperDelayedWatch(makeResult({ candidatesFound: 0, candidates: [] }));
    expect(out).toContain('no approved candidates found');
  });
}
);
