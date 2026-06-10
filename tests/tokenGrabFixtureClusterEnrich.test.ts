import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runFixtureClusterEnrich,
  renderFixtureClusterEnrichReport,
  extractContractForCluster,
  shouldSkipCluster,
  isClusterCandidate,
  patchFixtureCluster,
  writeFixturesJsonlAtomicCluster,
} from '../src/token-grab/fixtureClusterEnrich';
import {
  runAutonomyReadinessAudit,
} from '../src/token-grab/autonomyReadinessAudit';
import type { LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';
import type { ClusterRiskProvider, ClusterRiskResult } from '../src/token-grab/clusterRiskProvider';

// ── Constants ─────────────────────────────────────────────────────────────────

const NOW_ISO    = '2026-06-10T12:00:00.000Z';
const CONTRACT_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFixture(opts: {
  id?:              string;
  contract?:        string | null;
  rawOverrides?:    Record<string, unknown>;
  buyGateDecision?: string;
  entryDecision?:   string;
} = {}): LiveRipperFixture {
  const contract = opts.contract !== undefined ? opts.contract : CONTRACT_A;
  return {
    id:              opts.id ?? 'fixture-1',
    capturedAt:      NOW_ISO,
    source:          'dex-watch-run',
    sourceKind:      'DEX_GAINER',
    raw:             opts.rawOverrides ?? {},
    normalizedSignal: contract ? {
      symbol: 'TEST',
      contract,
      discoveredAt: NOW_ISO,
      observedAt:   NOW_ISO,
      confidence:   'MEDIUM',
      signalReasons: [],
      warnings: [],
    } as unknown as LiveRipperFixture['normalizedSignal'] : null,
    ripperInput: contract
      ? { contract, symbol: 'TEST', volumeLiquidityRatio: 0.5, observedAt: NOW_ISO }
      : null,
    ripperScore:     80,
    launchAgeBucket: 'PRIME_WINDOW',
    ageMinutes:      8,
    entryDecision:   opts.entryDecision   ?? 'BUY_APPROVED_PAPER',
    buyGateDecision: opts.buyGateDecision ?? 'BUY_APPROVED_PAPER',
    blockers:        [],
    topReasons:      ['prime window'],
    warnings:        [],
    realTradingLocked: true,
    paperOnly:       true,
    readOnly:        true,
  } as unknown as LiveRipperFixture;
}

function noopSleep(_ms: number): Promise<void> { return Promise.resolve(); }

function makeClusterProvider(
  result: Partial<ClusterRiskResult> | Error,
): ClusterRiskProvider {
  return {
    name: 'test',
    fetchClusterRisk: async (_mint) => {
      if (result instanceof Error) throw result;
      return {
        clusterRisk:       result.clusterRisk       ?? 'UNKNOWN',
        clusterProvider:   result.clusterProvider   ?? 'test',
        clusterCheckedAt:  result.clusterCheckedAt  ?? NOW_ISO,
        clusterConfidence: result.clusterConfidence ?? 'HIGH',
        clusterNotes:      result.clusterNotes      ?? [],
        clusterFetchError: result.clusterFetchError,
        rawMetrics:        result.rawMetrics,
      };
    },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-enrich-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpJsonl(fixtures: LiveRipperFixture[], name = 'fixtures.jsonl'): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  return filePath;
}

function readJsonlFixtures(filePath: string): LiveRipperFixture[] {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as LiveRipperFixture);
}

// ── extractContractForCluster ─────────────────────────────────────────────────

describe('extractContractForCluster', () => {
  it('reads contract from ripperInput first', () => {
    const f = makeFixture({ contract: CONTRACT_A });
    expect(extractContractForCluster(f)).toBe(CONTRACT_A);
  });

  it('falls back to normalizedSignal.contract', () => {
    const f = makeFixture({ contract: null });
    (f as Record<string, unknown>).ripperInput = null;
    (f as Record<string, unknown>).normalizedSignal = { contract: CONTRACT_B };
    expect(extractContractForCluster(f)).toBe(CONTRACT_B);
  });

  it('falls back to raw.contract', () => {
    const f = makeFixture({ contract: null, rawOverrides: { contract: CONTRACT_A } });
    (f as Record<string, unknown>).ripperInput = null;
    (f as Record<string, unknown>).normalizedSignal = null;
    expect(extractContractForCluster(f)).toBe(CONTRACT_A);
  });

  it('falls back to raw.contractAddress', () => {
    const f = makeFixture({ contract: null, rawOverrides: { contractAddress: CONTRACT_B } });
    (f as Record<string, unknown>).ripperInput = null;
    (f as Record<string, unknown>).normalizedSignal = null;
    expect(extractContractForCluster(f)).toBe(CONTRACT_B);
  });

  it('returns null when no contract found', () => {
    const f = makeFixture({ contract: null });
    (f as Record<string, unknown>).ripperInput = null;
    (f as Record<string, unknown>).normalizedSignal = null;
    (f as Record<string, unknown>).raw = {};
    expect(extractContractForCluster(f)).toBeNull();
  });
});

// ── shouldSkipCluster ─────────────────────────────────────────────────────────

describe('shouldSkipCluster', () => {
  it('returns false when no clusterCheckedAt in raw', () => {
    const f = makeFixture({});
    expect(shouldSkipCluster(f, false)).toBe(false);
  });

  it('returns true when clusterCheckedAt present and provider is not offline', () => {
    const f = makeFixture({ rawOverrides: { clusterCheckedAt: NOW_ISO, clusterProvider: 'bubblemaps' } });
    expect(shouldSkipCluster(f, false)).toBe(true);
  });

  it('returns false when clusterProvider=offline (allow online to replace)', () => {
    const f = makeFixture({ rawOverrides: { clusterCheckedAt: NOW_ISO, clusterProvider: 'offline' } });
    expect(shouldSkipCluster(f, false)).toBe(false);
  });

  it('force=true always returns false', () => {
    const f = makeFixture({ rawOverrides: { clusterCheckedAt: NOW_ISO, clusterProvider: 'bubblemaps' } });
    expect(shouldSkipCluster(f, true)).toBe(false);
  });
});

// ── isClusterCandidate ────────────────────────────────────────────────────────

describe('isClusterCandidate', () => {
  it('BUY_APPROVED_PAPER is a candidate', () => {
    const f = makeFixture({ buyGateDecision: 'BUY_APPROVED_PAPER' });
    expect(isClusterCandidate(f, false)).toBe(true);
  });

  it('READY_TO_SNIPE_PAPER is a candidate', () => {
    const f = makeFixture({ buyGateDecision: 'READY_TO_SNIPE_PAPER' });
    expect(isClusterCandidate(f, false)).toBe(true);
  });

  it('BUY_REJECTED is not a candidate', () => {
    const f = makeFixture({ buyGateDecision: 'BUY_REJECTED', entryDecision: 'BUY_REJECTED' });
    expect(isClusterCandidate(f, false)).toBe(false);
  });

  it('all=true includes non-approved fixtures', () => {
    const f = makeFixture({ buyGateDecision: 'BUY_REJECTED', entryDecision: 'BUY_REJECTED' });
    expect(isClusterCandidate(f, true)).toBe(true);
  });
});

// ── patchFixtureCluster ───────────────────────────────────────────────────────

describe('patchFixtureCluster', () => {
  it('patches clusterRisk/clusterProvider/clusterCheckedAt on success', async () => {
    const f = makeFixture({ contract: CONTRACT_A });
    const provider = makeClusterProvider({ clusterRisk: 'CLEAN', clusterProvider: 'test' });
    const { patched, result } = await patchFixtureCluster(f, provider, false, false, NOW_ISO);
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['clusterRisk']).toBe('CLEAN');
    expect(raw['clusterProvider']).toBe('test');
    expect(raw['clusterCheckedAt']).toBe(NOW_ISO);
    expect(result.patched).toBe(true);
    expect(result.attempted).toBe(true);
    expect(result.succeeded).toBe(true);
    expect(result.failed).toBe(false);
  });

  it('records clusterFetchError when provider throws', async () => {
    const f = makeFixture({ contract: CONTRACT_A });
    const provider = makeClusterProvider(new Error('API timeout'));
    const { patched, result } = await patchFixtureCluster(f, provider, false, false, NOW_ISO);
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['clusterFetchError']).toContain('API timeout');
    expect(raw['clusterRisk']).toBe('UNKNOWN');
    expect(result.patched).toBe(true);
    expect(result.attempted).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(result.failed).toBe(true);
  });

  it('records clusterFetchError from provider result', async () => {
    const f = makeFixture({ contract: CONTRACT_A });
    const provider = makeClusterProvider({ clusterRisk: 'UNKNOWN', clusterFetchError: 'http 429' });
    const { patched, result } = await patchFixtureCluster(f, provider, false, false, NOW_ISO);
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['clusterFetchError']).toBe('http 429');
    expect(result.failed).toBe(true);
  });

  it('skips fixture with missing contract', async () => {
    const f = makeFixture({ contract: null });
    (f as Record<string, unknown>).ripperInput = null;
    (f as Record<string, unknown>).normalizedSignal = null;
    (f as Record<string, unknown>).raw = {};
    const provider = makeClusterProvider({ clusterRisk: 'CLEAN' });
    const { result } = await patchFixtureCluster(f, provider, false, false, NOW_ISO);
    expect(result.skippedMissingContract).toBe(true);
    expect(result.patched).toBe(false);
  });

  it('skips already-enriched fixture when force=false', async () => {
    const f = makeFixture({ rawOverrides: { clusterCheckedAt: NOW_ISO, clusterProvider: 'bubblemaps', clusterRisk: 'CLEAN' } });
    const provider = makeClusterProvider({ clusterRisk: 'RISKY' });
    const { patched, result } = await patchFixtureCluster(f, provider, false, false, NOW_ISO);
    const raw = patched.raw as Record<string, unknown>;
    expect(result.skippedAlreadyEnriched).toBe(true);
    expect(raw['clusterRisk']).toBe('CLEAN'); // unchanged
  });

  it('re-enriches already-enriched fixture when force=true', async () => {
    const f = makeFixture({ rawOverrides: { clusterCheckedAt: NOW_ISO, clusterProvider: 'bubblemaps', clusterRisk: 'CLEAN' } });
    const provider = makeClusterProvider({ clusterRisk: 'RISKY' });
    const { patched, result } = await patchFixtureCluster(f, provider, true, false, NOW_ISO);
    const raw = patched.raw as Record<string, unknown>;
    expect(result.skippedAlreadyEnriched).toBe(false);
    expect(raw['clusterRisk']).toBe('RISKY');
  });

  it('skips non-candidate fixture when all=false', async () => {
    const f = makeFixture({ buyGateDecision: 'BUY_REJECTED', entryDecision: 'BUY_REJECTED' });
    const provider = makeClusterProvider({ clusterRisk: 'CLEAN' });
    const { result } = await patchFixtureCluster(f, provider, false, false, NOW_ISO);
    expect(result.skippedNotCandidate).toBe(true);
  });

  it('does not modify original fixture object', async () => {
    const f = makeFixture({ contract: CONTRACT_A });
    const originalRaw = { ...(f.raw as Record<string, unknown>) };
    const provider = makeClusterProvider({ clusterRisk: 'WATCH' });
    await patchFixtureCluster(f, provider, false, false, NOW_ISO);
    expect(f.raw).toEqual(originalRaw);
  });

  it('patches rawMetrics when provider returns them', async () => {
    const f = makeFixture({ contract: CONTRACT_A });
    const provider = makeClusterProvider({
      clusterRisk: 'WATCH',
      rawMetrics: { topClusterPct: 35 },
    });
    const { patched } = await patchFixtureCluster(f, provider, false, false, NOW_ISO);
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['clusterRawMetrics']).toEqual({ topClusterPct: 35 });
  });
});

// ── writeFixturesJsonlAtomicCluster ───────────────────────────────────────────

describe('writeFixturesJsonlAtomicCluster', () => {
  it('writes a valid JSONL file readable back as fixtures', () => {
    const fixtures = [makeFixture({ id: 'f1' }), makeFixture({ id: 'f2' })];
    const outPath = path.join(tmpDir, 'out.jsonl');
    writeFixturesJsonlAtomicCluster(fixtures, outPath);
    const lines = fs.readFileSync(outPath, 'utf-8').split('\n').filter(l => l.trim());
    expect(lines).toHaveLength(2);
    const back = lines.map(l => JSON.parse(l) as LiveRipperFixture);
    expect(back[0].id).toBe('f1');
    expect(back[1].id).toBe('f2');
  });

  it('no .tmp file left behind after write', () => {
    const fixtures = [makeFixture()];
    const outPath = path.join(tmpDir, 'out.jsonl');
    writeFixturesJsonlAtomicCluster(fixtures, outPath);
    expect(fs.existsSync(outPath + '.tmp')).toBe(false);
  });

  it('preserves all raw fields on each fixture', () => {
    const f = makeFixture({ rawOverrides: { clusterRisk: 'WATCH', clusterProvider: 'test', clusterCheckedAt: NOW_ISO, clusterConfidence: 'HIGH', clusterNotes: ['note'] } });
    const outPath = path.join(tmpDir, 'out.jsonl');
    writeFixturesJsonlAtomicCluster([f], outPath);
    const back = readJsonlFixtures(outPath);
    const raw = back[0].raw as Record<string, unknown>;
    expect(raw['clusterRisk']).toBe('WATCH');
    expect(raw['clusterProvider']).toBe('test');
    expect(raw['clusterNotes']).toEqual(['note']);
  });
});

// ── runFixtureClusterEnrich ───────────────────────────────────────────────────

describe('runFixtureClusterEnrich', () => {
  it('returns inputMissing=true when file does not exist', async () => {
    const result = await runFixtureClusterEnrich(
      { inputPath: path.join(tmpDir, 'nonexistent.jsonl') },
      noopSleep,
    );
    expect(result.inputMissing).toBe(true);
    expect(result.fixturesPatched).toBe(0);
  });

  it('dry-run does not write the output file', async () => {
    const inPath  = writeTmpJsonl([makeFixture()]);
    const outPath = path.join(tmpDir, 'output.jsonl');
    await runFixtureClusterEnrich(
      { inputPath: inPath, outputPath: outPath, dryRun: true, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it('dry-run still returns correct counts', async () => {
    const inPath = writeTmpJsonl([makeFixture()]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, dryRun: true, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.dryRun).toBe(true);
    expect(result.fixturesRead).toBe(1);
  });

  it('offline mode patches fixtures with UNKNOWN cluster risk', async () => {
    const inPath  = writeTmpJsonl([makeFixture()]);
    const outPath = path.join(tmpDir, 'out.jsonl');
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, outputPath: outPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.offlineMode).toBe(true);
    expect(result.fixturesPatched).toBe(1);
    const back = readJsonlFixtures(outPath);
    const raw = back[0].raw as Record<string, unknown>;
    expect(raw['clusterRisk']).toBe('UNKNOWN');
    expect(raw['clusterProvider']).toBe('offline');
    expect(typeof raw['clusterCheckedAt']).toBe('string');
  });

  it('offline mode does not count rpcAttempted', async () => {
    const inPath = writeTmpJsonl([makeFixture(), makeFixture({ id: 'f2' })]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.rpcAttempted).toBe(0);
    expect(result.rpcSucceeded).toBe(0);
    expect(result.rpcFailed).toBe(0);
  });

  it('online mode counts rpcAttempted and rpcSucceeded', async () => {
    const f1 = makeFixture({ id: 'f1', contract: CONTRACT_A });
    const f2 = makeFixture({ id: 'f2', contract: CONTRACT_B });
    const inPath = writeTmpJsonl([f1, f2]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: false, apiUrl: 'dummy', generatedAt: NOW_ISO },
      noopSleep,
    );
    // Both should have been attempted (bubblemaps provider will fail HTTP → UNKNOWN + error)
    expect(result.rpcAttempted).toBeGreaterThan(0);
  });

  it('already-enriched rows are skipped by default', async () => {
    const enriched = makeFixture({ rawOverrides: { clusterCheckedAt: NOW_ISO, clusterProvider: 'bubblemaps', clusterRisk: 'CLEAN' } });
    const fresh    = makeFixture({ id: 'fresh' });
    const inPath   = writeTmpJsonl([enriched, fresh]);
    const result   = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.skippedAlreadyEnriched).toBe(1);
    expect(result.fixturesPatched).toBe(1);
  });

  it('force=true re-enriches already-enriched rows', async () => {
    const enriched = makeFixture({ rawOverrides: { clusterCheckedAt: NOW_ISO, clusterProvider: 'bubblemaps', clusterRisk: 'CLEAN' } });
    const inPath   = writeTmpJsonl([enriched]);
    const result   = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, force: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.skippedAlreadyEnriched).toBe(0);
    expect(result.fixturesPatched).toBe(1);
  });

  it('fixture with missing contract is skipped', async () => {
    const noContract = makeFixture({ contract: null });
    (noContract as Record<string, unknown>).ripperInput = null;
    (noContract as Record<string, unknown>).normalizedSignal = null;
    (noContract as Record<string, unknown>).raw = {};
    const inPath = writeTmpJsonl([noContract]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.skippedMissingContract).toBe(1);
    expect(result.fixturesPatched).toBe(0);
  });

  it('non-candidate rejected fixtures are skipped (not BUY_APPROVED_PAPER)', async () => {
    const f = makeFixture({ buyGateDecision: 'BUY_REJECTED', entryDecision: 'BUY_REJECTED' });
    const inPath = writeTmpJsonl([f]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.skippedNotCandidate).toBe(1);
    expect(result.fixturesPatched).toBe(0);
  });

  it('all=true enriches non-approved fixtures too', async () => {
    const f = makeFixture({ buyGateDecision: 'BUY_REJECTED', entryDecision: 'BUY_REJECTED' });
    const inPath = writeTmpJsonl([f]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, all: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.skippedNotCandidate).toBe(0);
    expect(result.fixturesPatched).toBe(1);
  });

  it('limit restricts how many candidates are evaluated', async () => {
    const fixtures = [
      makeFixture({ id: 'f1' }),
      makeFixture({ id: 'f2' }),
      makeFixture({ id: 'f3' }),
    ];
    const inPath = writeTmpJsonl(fixtures);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, limitN: 1, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.fixturesPatched).toBe(1);
    expect(result.fixturesRead).toBe(3);
  });

  it('atomic rewrite: output file is valid JSONL with all fixtures', async () => {
    const f1 = makeFixture({ id: 'f1' });
    const f2 = makeFixture({ id: 'f2', buyGateDecision: 'BUY_REJECTED', entryDecision: 'BUY_REJECTED' });
    const inPath  = writeTmpJsonl([f1, f2]);
    const outPath = path.join(tmpDir, 'out.jsonl');
    await runFixtureClusterEnrich(
      { inputPath: inPath, outputPath: outPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    const back = readJsonlFixtures(outPath);
    expect(back).toHaveLength(2);
    const ids = back.map(f => f.id);
    expect(ids).toContain('f1');
    expect(ids).toContain('f2');
  });

  it('result always has tradingExecuted=0, noRealTradeSent=true, paperOnly=true, readOnly=true', async () => {
    const inPath = writeTmpJsonl([makeFixture()]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('clusterRiskCounts reflects distribution after enrichment', async () => {
    const f1 = makeFixture({ id: 'f1' }); // will be patched offline → UNKNOWN
    const f2 = makeFixture({ id: 'f2', buyGateDecision: 'BUY_REJECTED', entryDecision: 'BUY_REJECTED' }); // skipped not-candidate
    const inPath = writeTmpJsonl([f1, f2]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.clusterRiskCounts['UNKNOWN']).toBeGreaterThanOrEqual(1);
  });

  it('sleep is called between API calls', async () => {
    const f1 = makeFixture({ id: 'f1' });
    const f2 = makeFixture({ id: 'f2', contract: CONTRACT_B });
    const inPath = writeTmpJsonl([f1, f2]);
    const sleepCalls: number[] = [];
    const trackSleep = (ms: number) => { sleepCalls.push(ms); return Promise.resolve(); };
    await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, delayMs: 100, generatedAt: NOW_ISO },
      trackSleep,
    );
    // Each patched fixture should have triggered a sleep
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
    expect(sleepCalls.every(ms => ms === 100)).toBe(true);
  });
});

// ── Integration: autonomyReadiness recognises clusterRisk CLEAN → FUTURE ──────

describe('autonomyReadinessAudit integration: cluster enrich → FUTURE_AUTONOMY_CANDIDATE', () => {
  it('fixture cluster-enriched as CLEAN → classifies as FUTURE_AUTONOMY_CANDIDATE', async () => {
    const cleanCluster = makeFixture({
      rawOverrides: {
        // Holder enrichment
        holderConcentrationStatus: 'CLEAN',
        topHolderPercent: 5,
        holderProvider: 'test',
        holderCheckedAt: NOW_ISO,
        // Cluster enrichment (simulates token:fixture-cluster-enrich output)
        clusterRisk:        'CLEAN',
        clusterProvider:    'bubblemaps',
        clusterCheckedAt:   NOW_ISO,
        clusterConfidence:  'HIGH',
        clusterNotes:       ['top cluster 5%'],
        // Quote enrichment
        slippageRisk:    'CLEAN',
        quoteCheckedAt:  NOW_ISO,
        quoteProvider:   'jupiter',
        routeFound:      true,
        priceImpactPct:  0.5,
      },
    });

    const inPath = path.join(tmpDir, 'fixtures.jsonl');
    fs.writeFileSync(inPath, JSON.stringify(cleanCluster) + '\n');

    const auditResult = await runAutonomyReadinessAudit({ inputPath: inPath });
    const audited = auditResult.allAudited;
    expect(audited).toHaveLength(1);
    expect(audited[0].level).toBe('FUTURE_AUTONOMY_CANDIDATE');
    expect(auditResult.futureAutonomyCandidateCount).toBe(1);
  });

  it('fixture cluster-enriched as UNKNOWN → AUTONOMY_BLOCKED_CLUSTER_UNKNOWN (not FUTURE)', async () => {
    const unknownCluster = makeFixture({
      rawOverrides: {
        holderConcentrationStatus: 'CLEAN',
        topHolderPercent: 5,
        holderProvider: 'test',
        holderCheckedAt: NOW_ISO,
        clusterRisk:        'UNKNOWN',
        clusterProvider:    'offline',
        clusterCheckedAt:   NOW_ISO,
        clusterConfidence:  'UNKNOWN',
        clusterNotes:       [],
        slippageRisk:    'CLEAN',
        quoteCheckedAt:  NOW_ISO,
        quoteProvider:   'jupiter',
        routeFound:      true,
      },
    });

    const inPath = path.join(tmpDir, 'fixtures2.jsonl');
    fs.writeFileSync(inPath, JSON.stringify(unknownCluster) + '\n');

    const auditResult = await runAutonomyReadinessAudit({ inputPath: inPath });
    const audited = auditResult.allAudited;
    expect(audited[0].level).toBe('AUTONOMY_BLOCKED_CLUSTER_UNKNOWN');
    expect(auditResult.autonomyBlockedClusterUnknownCount).toBe(1);
  });

  it('fixture cluster-enriched as RISKY → HARD_REJECT is not triggered (RISKY cluster → REVIEW_READY_PAPER)', async () => {
    // Note: RISKY cluster is not a hard reject condition — only holderRisk RISKY or slippageRisk RISKY are.
    // A RISKY cluster fixture with approved gate goes to REVIEW_READY_PAPER.
    const riskyCluster = makeFixture({
      rawOverrides: {
        holderConcentrationStatus: 'CLEAN',
        topHolderPercent: 5,
        holderProvider: 'test',
        holderCheckedAt: NOW_ISO,
        clusterRisk:        'RISKY',
        clusterProvider:    'bubblemaps',
        clusterCheckedAt:   NOW_ISO,
        clusterConfidence:  'HIGH',
        clusterNotes:       ['is_rug=true'],
        slippageRisk:    'CLEAN',
        quoteCheckedAt:  NOW_ISO,
        quoteProvider:   'jupiter',
        routeFound:      true,
      },
    });

    const inPath = path.join(tmpDir, 'fixtures3.jsonl');
    fs.writeFileSync(inPath, JSON.stringify(riskyCluster) + '\n');

    const auditResult = await runAutonomyReadinessAudit({ inputPath: inPath });
    const audited = auditResult.allAudited;
    expect(audited[0].level).toBe('REVIEW_READY_PAPER');
  });
});

// ── Safety invariants ─────────────────────────────────────────────────────────

describe('safety invariants', () => {
  it('never sets tradingExecuted to non-zero', async () => {
    const inPath = writeTmpJsonl([makeFixture()]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.tradingExecuted).toBe(0);
  });

  it('always sets noRealTradeSent=true', async () => {
    const inPath = writeTmpJsonl([makeFixture()]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.noRealTradeSent).toBe(true);
  });

  it('always sets paperOnly=true and readOnly=true', async () => {
    const inPath = writeTmpJsonl([makeFixture()]);
    const result = await runFixtureClusterEnrich(
      { inputPath: inPath, offline: true, generatedAt: NOW_ISO },
      noopSleep,
    );
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });

  it('inputMissing result also has tradingExecuted=0', async () => {
    const result = await runFixtureClusterEnrich(
      { inputPath: path.join(tmpDir, 'missing.jsonl') },
      noopSleep,
    );
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderFixtureClusterEnrichReport', () => {
  it('renders inputMissing report without error', () => {
    const result = {
      inputPath: '/path/to/file.jsonl', outputPath: '/path/to/file.jsonl',
      inputMissing: true, offlineMode: false, dryRun: false, configNote: null,
      fixturesRead: 0, candidatesEvaluated: 0, fixturesPatched: 0,
      skippedAlreadyEnriched: 0, skippedMissingContract: 0, skippedNotCandidate: 0,
      rpcAttempted: 0, rpcSucceeded: 0, rpcFailed: 0,
      clusterRiskCounts: {},
      tradingExecuted: 0 as const, noRealTradeSent: true as const,
      paperOnly: true as const, readOnly: true as const,
    };
    const report = renderFixtureClusterEnrichReport(result);
    expect(report).toContain('FIXTURE CLUSTER ENRICH');
    expect(report).toContain('No fixture file found');
    expect(report).toContain('tradingExecuted=0');
  });

  it('renders normal report without error', () => {
    const result = {
      inputPath: '/path/to/file.jsonl', outputPath: '/path/to/file.jsonl',
      inputMissing: false, offlineMode: true, dryRun: false, configNote: null,
      fixturesRead: 5, candidatesEvaluated: 3, fixturesPatched: 3,
      skippedAlreadyEnriched: 1, skippedMissingContract: 0, skippedNotCandidate: 1,
      rpcAttempted: 0, rpcSucceeded: 0, rpcFailed: 0,
      clusterRiskCounts: { UNKNOWN: 5 },
      tradingExecuted: 0 as const, noRealTradeSent: true as const,
      paperOnly: true as const, readOnly: true as const,
    };
    const report = renderFixtureClusterEnrichReport(result);
    expect(report).toContain('FIXTURE CLUSTER ENRICH');
    expect(report).toContain('REAL TRADING LOCKED');
    expect(report).toContain('tradingExecuted=0');
    expect(report).toContain('UNKNOWN');
  });

  it('includes configNote when present', () => {
    const result = {
      inputPath: '/path/to/file.jsonl', outputPath: '/path/to/file.jsonl',
      inputMissing: false, offlineMode: false, dryRun: false,
      configNote: 'No cluster API configured — using offline provider',
      fixturesRead: 2, candidatesEvaluated: 1, fixturesPatched: 1,
      skippedAlreadyEnriched: 0, skippedMissingContract: 0, skippedNotCandidate: 1,
      rpcAttempted: 0, rpcSucceeded: 0, rpcFailed: 0,
      clusterRiskCounts: { UNKNOWN: 2 },
      tradingExecuted: 0 as const, noRealTradeSent: true as const,
      paperOnly: true as const, readOnly: true as const,
    };
    const report = renderFixtureClusterEnrichReport(result);
    expect(report).toContain('CONFIG NOTE');
  });
});
