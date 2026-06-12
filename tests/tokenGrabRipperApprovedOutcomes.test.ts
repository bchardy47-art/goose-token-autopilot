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

// ── Time anchor ───────────────────────────────────────────────────────────────

const NOW_MS  = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeFixture(overrides: Partial<{
  contract: string;
  symbol: string;
  buyGateDecision: string;
  ripperScore: number;
  ageMinutes: number;
  launchAgeBucket: string;
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
      id:           contract,
      source:       'dex-watch-run',
      sourceKind:   'DEX_NEW_POOL',
      contract,
      symbol:       overrides.symbol ?? 'FRESH',
      discoveredAt: NOW_ISO,
      observedAt:   NOW_ISO,
      priceChangePct: 45,
      raw: {
        entry:       { priceUsd: overrides.entryPriceUsd ?? 0.00015 },
        clusterRisk: overrides.clusterRisk ?? 'CLEAN',
      },
    },
    ripperInput:      null,
    ripperScore:      overrides.ripperScore     ?? 82,
    launchAgeBucket:  overrides.launchAgeBucket ?? 'PRIME_WINDOW',
    ageMinutes:       overrides.ageMinutes      ?? 8.5,
    entryDecision:    'READY_TO_SNIPE_PAPER',
    buyGateDecision:  overrides.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    blockers:         [],
    topReasons:       ['score high', 'cluster CLEAN'],
    warnings:         [],
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
  const lines = fixtures.map(f => JSON.stringify(f));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

/** Mock price provider: returns prices from the supplied map; null when absent. */
function mockProvider(prices: Record<string, number>): RipperPriceProvider {
  return async (contractKey) => ({
    priceUsd: prices[contractKey] ?? null,
    note:     prices[contractKey] != null ? undefined : 'not found in mock',
  });
}

// ── Temp dir setup ────────────────────────────────────────────────────────────

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

// ── extraction ────────────────────────────────────────────────────────────────

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

  it('ignores rejected candidates', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'RejA', buyGateDecision: 'BUY_REJECTED' }),
      makeFixture({ contract: 'RejB', buyGateDecision: 'BUY_REJECTED' }),
    ]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.approvedTotal).toBe(0);
    expect(result.uniqueApproved).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it('collects approved across multiple input files', async () => {
    const jsonl1 = path.join(tmpDir, 'c1.jsonl');
    const jsonl2 = path.join(tmpDir, 'c2.jsonl');
    writeJsonl(jsonl1, [makeFixture({ contract: 'TokenA', buyGateDecision: 'BUY_APPROVED_PAPER' })]);
    writeJsonl(jsonl2, [makeFixture({ contract: 'TokenB', buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl1, jsonl2], outPath: outPath() });

    expect(result.filesRead).toBe(2);
    expect(result.uniqueApproved).toBe(2);
    const keys = result.candidates.map(c => c.contractKey);
    expect(keys).toContain('TokenA');
    expect(keys).toContain('TokenB');
  });

  it('records symbol, score, ageMinutes, clusterRisk from fixture', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({
        contract:    'ScoredToken',
        symbol:      'MEGA',
        ripperScore: 91,
        ageMinutes:  10.5,
        clusterRisk: 'CLEAN',
        buyGateDecision: 'BUY_APPROVED_PAPER',
      }),
    ]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    const c = result.candidates[0];
    expect(c.symbol).toBe('MEGA');
    expect(c.score).toBe(91);
    expect(c.ageMinutes).toBe(10.5);
    expect(c.clusterRisk).toBe('CLEAN');
  });

  it('records entryPriceUsd from raw.entry.priceUsd', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'PricedToken', entryPriceUsd: 0.000123, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.candidates[0].entryPriceUsd).toBe(0.000123);
  });

  it('sorts candidates by score descending', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'LowScore',  ripperScore: 65, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'HighScore', ripperScore: 91, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'MidScore',  ripperScore: 78, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.candidates[0].contractKey).toBe('HighScore');
    expect(result.candidates[1].contractKey).toBe('MidScore');
    expect(result.candidates[2].contractKey).toBe('LowScore');
  });

  it('records sourceArtifact path for each candidate', async () => {
    const jsonl = path.join(tmpDir, 'my-cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.candidates[0].sourceArtifact).toBe(jsonl);
  });
});

// ── deduplication ─────────────────────────────────────────────────────────────

describe('runRipperApprovedOutcomes — deduplication', () => {
  it('dedupes the same contract key across files', async () => {
    const jsonl1 = path.join(tmpDir, 'c1.jsonl');
    const jsonl2 = path.join(tmpDir, 'c2.jsonl');
    writeJsonl(jsonl1, [makeFixture({ contract: 'DupToken', buyGateDecision: 'BUY_APPROVED_PAPER' })]);
    writeJsonl(jsonl2, [makeFixture({ contract: 'DupToken', buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl1, jsonl2], outPath: outPath() });

    expect(result.approvedTotal).toBe(2);
    expect(result.uniqueApproved).toBe(1);
    expect(result.duplicatesSkipped).toBe(1);
    expect(result.candidates).toHaveLength(1);
  });

  it('dedupes within a single file', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'SameToken', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'SameToken', buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.uniqueApproved).toBe(1);
    expect(result.duplicatesSkipped).toBe(1);
  });

  it('keeps distinct contracts separate', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'TokenA', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'TokenB', buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.uniqueApproved).toBe(2);
    expect(result.duplicatesSkipped).toBe(0);
  });
});

// ── missing files ─────────────────────────────────────────────────────────────

describe('runRipperApprovedOutcomes — missing files', () => {
  it('counts missing files without throwing', async () => {
    const result = await runRipperApprovedOutcomes({
      inputPaths: [path.join(tmpDir, 'no-such-file.jsonl')],
      outPath:    outPath(),
    });

    expect(result.filesMissing).toBe(1);
    expect(result.filesRead).toBe(0);
    expect(result.uniqueApproved).toBe(0);
  });

  it('processes present files even when others are missing', async () => {
    const jsonl = path.join(tmpDir, 'exists.jsonl');
    writeJsonl(jsonl, [makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const result = await runRipperApprovedOutcomes({
      inputPaths: [path.join(tmpDir, 'ghost.jsonl'), jsonl],
      outPath:    outPath(),
    });

    expect(result.filesMissing).toBe(1);
    expect(result.filesRead).toBe(1);
    expect(result.uniqueApproved).toBe(1);
  });

  it('returns zero counts when all files are missing', async () => {
    const result = await runRipperApprovedOutcomes({
      inputPaths: [path.join(tmpDir, 'a.jsonl'), path.join(tmpDir, 'b.jsonl')],
      outPath:    outPath(),
    });

    expect(result.fixturesScanned).toBe(0);
    expect(result.approvedTotal).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });
});

// ── output file ───────────────────────────────────────────────────────────────

describe('runRipperApprovedOutcomes — output file', () => {
  it('writes JSON output to specified path', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const out = outPath('result.json');
    await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: out });

    expect(fs.existsSync(out)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(Array.isArray(parsed.candidates)).toBe(true);
  });

  it('creates output directory if it does not exist', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const out = path.join(tmpDir, 'nested', 'deep', 'out.json');
    await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: out });

    expect(fs.existsSync(out)).toBe(true);
  });

  it('written JSON includes safety fields', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const out = outPath();
    await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: out });

    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(parsed.realTradingLocked).toBe(true);
    expect(parsed.tradingExecuted).toBe(0);
    expect(parsed.noRealTradeSent).toBe(true);
    expect(parsed.paperOnly).toBe(true);
    expect(parsed.readOnly).toBe(true);
  });

  it('written JSON includes generatedAt and summary counts', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'A', buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'B', buyGateDecision: 'BUY_REJECTED' }),
    ]);

    const out = outPath();
    await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: out, nowMs: NOW_MS });

    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(parsed.generatedAt).toBe(NOW_ISO);
    expect(parsed.fixturesScanned).toBe(2);
    expect(parsed.approvedTotal).toBe(1);
    expect(parsed.uniqueApproved).toBe(1);
  });
});

// ── safety fields ─────────────────────────────────────────────────────────────

describe('runRipperApprovedOutcomes — safety fields', () => {
  it('result always has realTradingLocked=true tradingExecuted=0', async () => {
    const result = await runRipperApprovedOutcomes({
      inputPaths: [path.join(tmpDir, 'no-such.jsonl')],
      outPath:    outPath(),
    });

    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('priceDataAvailable is false without checkpoint label', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.priceDataAvailable).toBe(false);
    expect(result.priceTrackingNote).toContain('pending');
  });

  it('safety fields remain true with _priceProvider injected', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ contract: 'TokenX', buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const result = await runRipperApprovedOutcomes({
      inputPaths:              [jsonl],
      outPath:                 outPath(),
      checkpointLabel:         'now',
      _priceProvider:          mockProvider({ TokenX: 0.0003 }),
      delayBetweenFetchesMs:   0,
    });

    expect(result.realTradingLocked).toBe(true);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

// ── price checkpoints ─────────────────────────────────────────────────────────

describe('runRipperApprovedOutcomes — price checkpoints', () => {
  it('populates currentPriceUsd from provider', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Minted', entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({
      inputPaths:            [jsonl],
      outPath:               outPath(),
      checkpointLabel:       'now',
      _priceProvider:        mockProvider({ Minted: 0.0002 }),
      delayBetweenFetchesMs: 0,
    });

    expect(result.candidates[0].currentPriceUsd).toBe(0.0002);
  });

  it('computes pctChangeFromEntry correctly', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Token100', entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({
      inputPaths:            [jsonl],
      outPath:               outPath(),
      checkpointLabel:       'now',
      _priceProvider:        mockProvider({ Token100: 0.00015 }),
      delayBetweenFetchesMs: 0,
    });

    // (0.00015 - 0.0001) / 0.0001 * 100 = +50%
    expect(result.candidates[0].pctChangeFromEntry).toBeCloseTo(50, 5);
  });

  it('computes multipleFromEntry correctly', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Token2x', entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({
      inputPaths:            [jsonl],
      outPath:               outPath(),
      checkpointLabel:       'now',
      _priceProvider:        mockProvider({ Token2x: 0.0002 }),
      delayBetweenFetchesMs: 0,
    });

    expect(result.candidates[0].multipleFromEntry).toBeCloseTo(2.0, 5);
  });

  it('handles missing price gracefully', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'MissingPrice', buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({
      inputPaths:            [jsonl],
      outPath:               outPath(),
      checkpointLabel:       'now',
      _priceProvider:        mockProvider({}),
      delayBetweenFetchesMs: 0,
    });

    expect(result.candidates[0].currentPriceUsd).toBeNull();
    expect(result.candidates[0].pctChangeFromEntry).toBeNull();
    expect(result.priceUnavailableCount).toBe(1);
    expect(result.candidatesWithPrice).toBe(0);
  });

  it('counts winners and losers correctly', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Winner', entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'Loser',  entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'NoData', entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({
      inputPaths:            [jsonl],
      outPath:               outPath(),
      checkpointLabel:       'now',
      _priceProvider:        mockProvider({ Winner: 0.0002, Loser: 0.00005 }),
      delayBetweenFetchesMs: 0,
    });

    expect(result.winnersCount).toBe(1);
    expect(result.losersCount).toBe(1);
    expect(result.candidatesWithPrice).toBe(2);
    expect(result.priceUnavailableCount).toBe(1);
  });

  it('computes averagePctChange across candidates with price', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Up50',    entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'Down10',  entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({
      inputPaths:            [jsonl],
      outPath:               outPath(),
      checkpointLabel:       'now',
      _priceProvider:        mockProvider({ Up50: 0.00015, Down10: 0.00009 }),
      delayBetweenFetchesMs: 0,
    });

    // avg = (+50 + -10) / 2 = +20
    expect(result.averagePctChange).toBeCloseTo(20, 5);
  });

  it('identifies best and worst candidates', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'Best',  entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'Worst', entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
      makeFixture({ contract: 'Mid',   entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const result = await runRipperApprovedOutcomes({
      inputPaths:            [jsonl],
      outPath:               outPath(),
      checkpointLabel:       'now',
      _priceProvider:        mockProvider({ Best: 0.0003, Worst: 0.00005, Mid: 0.00012 }),
      delayBetweenFetchesMs: 0,
    });

    expect(result.bestCandidate?.contractKey).toBe('Best');
    expect(result.worstCandidate?.contractKey).toBe('Worst');
  });

  it('stores checkpointLabel in result', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const result = await runRipperApprovedOutcomes({
      inputPaths:            [jsonl],
      outPath:               outPath(),
      checkpointLabel:       '4h',
      _priceProvider:        mockProvider({}),
      delayBetweenFetchesMs: 0,
    });

    expect(result.checkpointLabel).toBe('4h');
    expect(result.checkpointAt).toBeDefined();
  });

  it('no price fetch when neither checkpointLabel nor _priceProvider set', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER' })]);

    const result = await runRipperApprovedOutcomes({ inputPaths: [jsonl], outPath: outPath() });

    expect(result.candidates[0].currentPriceUsd).toBeNull();
    expect(result.candidatesWithPrice).toBe(0);
    expect(result.checkpointAt).toBeUndefined();
    expect(result.priceTrackingNote).toContain('pending');
  });

  it('handles no approved candidates with price fetch enabled', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [makeFixture({ buyGateDecision: 'BUY_REJECTED' })]);

    const result = await runRipperApprovedOutcomes({
      inputPaths:            [jsonl],
      outPath:               outPath(),
      checkpointLabel:       'now',
      _priceProvider:        mockProvider({}),
      delayBetweenFetchesMs: 0,
    });

    expect(result.uniqueApproved).toBe(0);
    expect(result.candidatesWithPrice).toBe(0);
    expect(result.winnersCount).toBe(0);
    expect(result.averagePctChange).toBeNull();
    expect(result.bestCandidate).toBeUndefined();
  });

  it('written JSON includes checkpoint fields', async () => {
    const jsonl = path.join(tmpDir, 'cycle.jsonl');
    writeJsonl(jsonl, [
      makeFixture({ contract: 'ChkToken', entryPriceUsd: 0.0001, buyGateDecision: 'BUY_APPROVED_PAPER' }),
    ]);

    const out = outPath();
    await runRipperApprovedOutcomes({
      inputPaths:            [jsonl],
      outPath:               out,
      checkpointLabel:       'now',
      _priceProvider:        mockProvider({ ChkToken: 0.0002 }),
      delayBetweenFetchesMs: 0,
    });

    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(parsed.checkpointLabel).toBe('now');
    expect(parsed.candidatesWithPrice).toBe(1);
    expect(parsed.candidates[0].currentPriceUsd).toBe(0.0002);
    expect(parsed.candidates[0].pctChangeFromEntry).toBeCloseTo(100, 1);
  });
});

// ── renderer ──────────────────────────────────────────────────────────────────

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

  it('shows summary counts', () => {
    const out = renderRipperApprovedOutcomes(makeResult({
      filesRead: 3, fixturesScanned: 50, approvedTotal: 7, uniqueApproved: 6, duplicatesSkipped: 1,
    }));
    expect(out).toContain('3');
    expect(out).toContain('50');
    expect(out).toContain('7');
    expect(out).toContain('6');
  });

  it('shows missing file count when > 0', () => {
    expect(renderRipperApprovedOutcomes(makeResult({ filesMissing: 2 }))).toContain('2 missing');
  });

  it('shows candidate list when approved candidates exist', () => {
    const result = makeResult({
      candidates: [{
        contractKey:       'TokenABC123DEF456',
        symbol:            'MOON',
        approvedAt:        NOW_ISO,
        discoveredAt:      NOW_ISO,
        score:             88,
        ageMinutes:        9.2,
        clusterRisk:       'CLEAN',
        entryPriceUsd:     0.00012,
        priceChangePct:    45,
        sourceArtifact:    '/tmp/cycle.jsonl',
        currentPriceUsd:   null,
        pctChangeFromEntry: null,
        multipleFromEntry: null,
      }],
      uniqueApproved: 1,
    });
    const out = renderRipperApprovedOutcomes(result);
    expect(out).toContain('MOON');
    expect(out).toContain('88');
    expect(out).toContain('CLEAN');
  });

  it('shows no approved message when candidates is empty', () => {
    expect(renderRipperApprovedOutcomes(makeResult({ candidates: [], uniqueApproved: 0 }))).toContain('no approved candidates');
  });

  it('shows output path', () => {
    expect(renderRipperApprovedOutcomes(makeResult({ outPath: '/my/custom/out.json' }))).toContain('/my/custom/out.json');
  });

  it('shows checkpoint section when checkpointLabel is set', () => {
    const out = renderRipperApprovedOutcomes(makeResult({
      checkpointLabel:      'now',
      checkpointAt:         NOW_ISO,
      candidatesWithPrice:  3,
      priceUnavailableCount: 1,
      winnersCount:         2,
      losersCount:          1,
      averagePctChange:     45.2,
      bestCandidate: {
        contractKey:       'BestToken',
        symbol:            'MOON',
        pctChangeFromEntry: 120.5,
        multipleFromEntry:  2.2,
      },
    }));
    expect(out).toContain('now');
    expect(out).toContain('+45.2%');
    expect(out).toContain('MOON');
    expect(out).toContain('+120.5%');
  });

  it('shows current price in candidate row when available', () => {
    const result = makeResult({
      candidates: [{
        contractKey:       'PricedCandidate',
        symbol:            'PRCD',
        approvedAt:        NOW_ISO,
        score:             85,
        ageMinutes:        9.0,
        clusterRisk:       'CLEAN',
        entryPriceUsd:     0.0001,
        sourceArtifact:    '/tmp/c.jsonl',
        currentPriceUsd:   0.00015,
        pctChangeFromEntry: 50,
        multipleFromEntry:  1.5,
        checkpointAt:      NOW_ISO,
      }],
      checkpointLabel: 'now',
      checkpointAt:    NOW_ISO,
      uniqueApproved:  1,
      candidatesWithPrice: 1,
    });
    const out = renderRipperApprovedOutcomes(result);
    expect(out).toContain('+50.0%');
    expect(out).toContain('1.50×');
  });
});
