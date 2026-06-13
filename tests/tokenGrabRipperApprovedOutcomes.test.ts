import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runRipperApprovedOutcomes,
  renderRipperApprovedOutcomes,
  type RipperApprovedOutcomesResult,
  type RipperPriceProvider,
} from '../src/token-grab/ripperApprovedOutcomes';
import type { LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';

const NOW_MS  = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

function makeFixture(overrides: Partial<{
  contract: string;
  symbol: string;
  buyGateDecision: string;
  ripperScore: number;
  ageMinutes: number;
  clusterRisk: string;
  entryPriceUsd: number;
  capturedAt: string;
}> = {}): LiveRipperFixture {
  const contract = overrides.contract ?? 'ContractAAA111222333444555666777888999000';
  return {
    id:         `fixture:${contract}`,
    capturedAt: overrides.capturedAt ?? NOW_ISO,
    source:     'dex-watch-run',
    sourceKind: 'DEX_NEW_POOL',
    normalizedSignal: {
      id:             contract,
      source:         'dex-watch-run',
      sourceKind:     'DEX_NEW_POOL',
      contract,
      symbol:         overrides.symbol ?? 'FRESH',
      discoveredAt:   NOW_ISO,
      observedAt:     NOW_ISO,
      priceChangePct: 45,
      raw: { entry: { priceUsd: overrides.entryPriceUsd ?? 0.00015 } },
    },
    ripperInput:       null,
    ripperScore:       overrides.ripperScore ?? 82,
    ageMinutes:        overrides.ageMinutes ?? 8.5,
    entryDecision:     'READY_TO_SNIPE_PAPER',
    buyGateDecision:   overrides.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    blockers:          [],
    topReasons:        ['score high', 'cluster CLEAN'],
    warnings:          [],
    raw: { clusterRisk: overrides.clusterRisk ?? 'CLEAN', clusterProvider: 'offline' },
    realTradingLocked: true,
    paperOnly:         true,
    readOnly:          true,
  } as unknown as LiveRipperFixture;
}

function writeJsonl(filePath: string, fixtures: Array<Record<string, unknown> | LiveRipperFixture>): void {
  const lines = fixtures.map(f => JSON.stringify(f));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

function mockProvider(prices: Record<string, number>): RipperPriceProvider {
  return async (contractKey) => ({
    priceUsd: prices[contractKey] ?? null,
    note: prices[contractKey] != null ? undefined : 'not found in mock',
  });
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rao-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function outPath(name = 'out.json'): string {
  return path.join(tmpDir, 'outcomes', name);
}

describe('runRipperApprovedOutcomes — extraction', () => {
  it('extracts approved candidates from a single JSONL file', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'ApprovedToken', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'RejectedToken', buyGateDecision: 'BUY_REJECTED' }),
    ]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.fixturesScanned).toBe(2);
    expect(result.approvedTotal).toBe(1);
    expect(result.uniqueApproved).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].contractKey).toBe('ApprovedToken');
  });

  it('dedupes the same contract key across files', async () => {
    const jsonl1 = path.join(tmpDir, 'c1.jsonl');
    const jsonl2 = path.join(tmpDir, 'c2.jsonl');
    writeJsonl(jsonl1, [makeFixture({ contract: 'DupToken', buyGateDecision: 'BUY_APPROVED_PAPER' })]);
    writeJsonl(jsonl2, [makeFixture({ contract: 'DupToken', buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl1, jsonl2], outPath: outPath() });

    expect(result.approvedTotal).toBe(2);
    expect(result.uniqueApproved).toBe(1);
    expect(result.duplicatesSkipped).toBe(1);
  });

  it('skips observation artifacts safely', async () => {
    const jsonl = path.join(tmpDir, 'obs.jsonl');
    writeJsonl(jsonl, [{
      ...makeFixture({ contract: 'ObsOnly' }),
      postApprovalObservation: true,
      originalApprovedAt: NOW_ISO,
    }]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.approvedTotal).toBe(0);
    expect(result.uniqueApproved).toBe(0);
    expect(result.malformedSkipped).toBe(0);
  });
});

describe('runRipperApprovedOutcomes — malformed safety', () => {
  it('does not crash on fixture missing expected optional fields', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [{
      buyGateDecision: 'BUY_APPROVED_PAPER',
      normalizedSignal: { contract: 'BareToken' },
      capturedAt: NOW_ISO,
      raw: {},
      realTradingLocked: true,
      paperOnly: true,
      readOnly: true,
    }]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.approvedTotal).toBe(1);
    expect(result.uniqueApproved).toBe(1);
    expect(result.candidates[0].contractKey).toBe('BareToken');
  });

  it('skips malformed records safely instead of crashing', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      { buyGateDecision: 'BUY_APPROVED_PAPER', normalizedSignal: null },
      { buyGateDecision: 'BUY_APPROVED_PAPER' },
      makeFixture({ contract: 'GoodOne', buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.approvedTotal).toBe(3);
    expect(result.uniqueApproved).toBe(1);
    expect(result.malformedSkipped).toBe(2);
    expect(result.candidates[0].contractKey).toBe('GoodOne');
  });

  it('safety fields remain true with malformed records present', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [{ buyGateDecision: 'BUY_APPROVED_PAPER', normalizedSignal: null }]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

describe('runRipperApprovedOutcomes — price checkpoints', () => {
  it('computes pctChange and multiple when price exists', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ contract: 'Token2x', entryPriceUsd: 0.0001 })]);

    const result = await runRipperApprovedOutcomes({
      inputPaths: [jsonl],
      outPath: outPath(),
      checkpointLabel: 'now',
      _priceProvider: mockProvider({ Token2x: 0.0002 }),
      delayBetweenFetchesMs: 0,
    });

    expect(result.candidates[0].pctChangeFromEntry).toBeCloseTo(100, 5);
    expect(result.candidates[0].multipleFromEntry).toBeCloseTo(2, 5);
  });

  it('real command shape with checkpointLabel does not throw and render stays safe', async () => {
    const jsonl1 = path.join(tmpDir, 'c1.jsonl');
    const jsonl2 = path.join(tmpDir, 'c2.jsonl');
    writeJsonl(jsonl1, [
      makeFixture({ contract: 'RealA', entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      { buyGateDecision: 'BUY_APPROVED_PAPER', normalizedSignal: null },
    ]);
    writeJsonl(jsonl2, [
      makeFixture({ contract: 'RealB', entryPriceUsd: 0.0002, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({
      inputPaths: [jsonl1, jsonl2],
      outPath: outPath('real-shape.json'),
      checkpointLabel: 'now',
      _priceProvider: mockProvider({ RealA: 0.00015, RealB: 0.0001 }),
      delayBetweenFetchesMs: 0,
    });

    expect(() => renderRipperApprovedOutcomes(result)).not.toThrow();
    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.readOnly).toBe(true);
    expect(result.malformedSkipped).toBe(1);
    expect(result.candidates.length).toBe(2);
  });

  it('handles missing price gracefully', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ contract: 'MissingPrice' })]);

    const result = await runRipperApprovedOutcomes({
      inputPaths: [jsonl],
      outPath: outPath(),
      checkpointLabel: 'now',
      _priceProvider: mockProvider({}),
      delayBetweenFetchesMs: 0,
    });

    expect(result.candidates[0].currentPriceUsd).toBeNull();
    expect(result.candidatesWithPrice).toBe(0);
    expect(result.priceUnavailableCount).toBe(1);
  });
});

describe('renderRipperApprovedOutcomes', () => {
  function makeResult(overrides: Partial<RipperApprovedOutcomesResult> = {}): RipperApprovedOutcomesResult {
    return {
      generatedAt:          NOW_ISO,
      outPath:              '/tmp/out.json',
      filesRead:            1,
      filesMissing:         0,
      fixturesScanned:      5,
      approvedTotal:        2,
      uniqueApproved:       2,
      duplicatesSkipped:    0,
      malformedSkipped:     0,
      priceDataAvailable:   false,
      priceTrackingNote:    'V1 extraction-only — live price tracking pending',
      candidatesWithPrice:  0,
      priceUnavailableCount: 0,
      winnersCount:         0,
      losersCount:          0,
      averagePctChange:     null,
      candidates:           [],
      realTradingLocked:    true,
      tradingExecuted:      0,
      noRealTradeSent:      true,
      paperOnly:            true,
      readOnly:             true,
      ...overrides,
    };
  }

  it('contains REAL TRADING LOCKED header', () => {
    expect(renderRipperApprovedOutcomes(makeResult())).toContain('REAL TRADING LOCKED');
  });

  it('contains safety footer', () => {
    const out = renderRipperApprovedOutcomes(makeResult());
    expect(out).toContain('realTradingLocked=true');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('paperOnly=true');
    expect(out).toContain('readOnly=true');
  });

  it('shows malformed skip count when present', () => {
    expect(renderRipperApprovedOutcomes(makeResult({ malformedSkipped: 2 }))).toContain('Malformed skip');
  });
});
