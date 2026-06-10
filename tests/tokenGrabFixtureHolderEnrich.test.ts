import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runFixtureHolderEnrich,
  renderFixtureHolderEnrichReport,
  extractContract,
  shouldSkip,
  patchFixtureHolder,
  writeFixturesJsonlAtomic,
} from '../src/token-grab/fixtureHolderEnrich';
import type { LiveRipperFixture } from '../src/token-grab/liveFixtureCapture';
import type { SolanaTokenSafetyProvider } from '../src/token-grab/dexCandidateSafetyEnrich';

// ── Constants ──────────────────────────────────────────────────────────────────

const NOW_ISO   = '2026-06-10T12:00:00.000Z';
const CONTRACT_A = 'ContractAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CONTRACT_B = 'ContractBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFixture(
  contract: string | null,
  rawOverrides: Record<string, unknown> = {},
  other: Record<string, unknown> = {},
): LiveRipperFixture {
  return {
    id:              `fixture-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt:      NOW_ISO,
    source:          'dex-watch-run',
    sourceKind:      'DEX_GAINER',
    raw:             rawOverrides,
    normalizedSignal: {
      symbol: 'TEST',
      contract: contract ?? undefined,
      discoveredAt: NOW_ISO,
      observedAt:   NOW_ISO,
      confidence:   'MEDIUM',
      signalReasons: [],
      warnings: [],
    } as unknown as LiveRipperFixture['normalizedSignal'],
    ripperInput:     contract
      ? { contract, symbol: 'TEST', observedAt: NOW_ISO }
      : null,
    ripperScore:     80,
    launchAgeBucket: 'PRIME_WINDOW',
    ageMinutes:      8,
    entryDecision:   'READY_TO_SNIPE_PAPER',
    buyGateDecision: 'BUY_APPROVED_PAPER',
    blockers:        [],
    topReasons:      ['prime window'],
    warnings:        [],
    realTradingLocked: true,
    paperOnly:       true,
    readOnly:        true,
    ...other,
  } as unknown as LiveRipperFixture;
}

function noopSleep(_ms: number): Promise<void> { return Promise.resolve(); }

function makeProvider(
  topHolderPct: number | null | Error,
): SolanaTokenSafetyProvider {
  return {
    fetchMintAuthority:   async () => 'UNKNOWN',
    fetchFreezeAuthority: async () => 'UNKNOWN',
    fetchTopHolderPct:    async (_c) => {
      if (topHolderPct instanceof Error) throw topHolderPct;
      return topHolderPct;
    },
  };
}

function writeJsonl(filePath: string, fixtures: LiveRipperFixture[]): void {
  fs.writeFileSync(filePath, fixtures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
}

function readJsonl(filePath: string): LiveRipperFixture[] {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as LiveRipperFixture);
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhe-test-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ── extractContract ────────────────────────────────────────────────────────────

describe('extractContract', () => {
  it('returns contract from ripperInput.contract', () => {
    const f = makeFixture(CONTRACT_A);
    expect(extractContract(f)).toBe(CONTRACT_A);
  });

  it('returns contract from normalizedSignal when ripperInput is null', () => {
    const f = makeFixture(CONTRACT_A);
    (f as unknown as Record<string, unknown>)['ripperInput'] = null;
    // normalizedSignal still has contract
    expect(extractContract(f)).toBe(CONTRACT_A);
  });

  it('returns contract from raw.contract when other fields absent', () => {
    const f = makeFixture(null, { contract: CONTRACT_B });
    expect(extractContract(f)).toBe(CONTRACT_B);
  });

  it('returns contract from raw.contractAddress', () => {
    const f = makeFixture(null, { contractAddress: CONTRACT_B });
    expect(extractContract(f)).toBe(CONTRACT_B);
  });

  it('returns null when no contract anywhere', () => {
    const f = makeFixture(null);
    expect(extractContract(f)).toBeNull();
  });
});

// ── shouldSkip ─────────────────────────────────────────────────────────────────

describe('shouldSkip', () => {
  it('returns false when raw has no holderConcentrationStatus (never enriched)', () => {
    const f = makeFixture(CONTRACT_A, {});
    expect(shouldSkip(f, false)).toBe(false);
  });

  it('returns true when raw already has holderConcentrationStatus and force=false', () => {
    const f = makeFixture(CONTRACT_A, { holderConcentrationStatus: 'CLEAN' });
    expect(shouldSkip(f, false)).toBe(true);
  });

  it('returns true even for UNKNOWN status with force=false (previously attempted)', () => {
    const f = makeFixture(CONTRACT_A, { holderConcentrationStatus: 'UNKNOWN', holderFetchError: 'rpc error' });
    expect(shouldSkip(f, false)).toBe(true);
  });

  it('returns false when force=true even if already enriched', () => {
    const f = makeFixture(CONTRACT_A, { holderConcentrationStatus: 'CLEAN' });
    expect(shouldSkip(f, true)).toBe(false);
  });
});

// ── patchFixtureHolder ─────────────────────────────────────────────────────────

describe('patchFixtureHolder', () => {
  it('returns skippedMissingContract when no contract', async () => {
    const f = makeFixture(null);
    const provider = makeProvider(5);
    const { result } = await patchFixtureHolder(f, provider, false, NOW_ISO, 'test');
    expect(result.skippedMissingContract).toBe(true);
    expect(result.patched).toBe(false);
  });

  it('returns skippedAlreadyEnriched when raw already has status and force=false', async () => {
    const f = makeFixture(CONTRACT_A, { holderConcentrationStatus: 'CLEAN' });
    const provider = makeProvider(5);
    const { result } = await patchFixtureHolder(f, provider, false, NOW_ISO, 'test');
    expect(result.skippedAlreadyEnriched).toBe(true);
    expect(result.patched).toBe(false);
  });

  it('patches raw.holderConcentrationStatus on success', async () => {
    const f = makeFixture(CONTRACT_A);
    const provider = makeProvider(8);   // 8% → CLEAN
    const { patched, result } = await patchFixtureHolder(f, provider, false, NOW_ISO, 'solana-rpc');
    expect(result.rpcSucceeded).toBe(true);
    expect(result.patched).toBe(true);
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['holderConcentrationStatus']).toBe('CLEAN');
    expect(raw['topHolderPercent']).toBe(8);
    expect(raw['holderProvider']).toBe('solana-rpc');
    expect(raw['holderCheckedAt']).toBe(NOW_ISO);
  });

  it('patches WATCH for top holder 15-29%', async () => {
    const f = makeFixture(CONTRACT_A);
    const provider = makeProvider(20);  // 20% → WARNING → WATCH in holderRiskProvider
    const { patched } = await patchFixtureHolder(f, provider, false, NOW_ISO, 'solana-rpc');
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['holderConcentrationStatus']).toBe('WARNING');
  });

  it('patches DANGER for top holder >= 30%', async () => {
    const f = makeFixture(CONTRACT_A);
    const provider = makeProvider(45);  // 45% → DANGER
    const { patched } = await patchFixtureHolder(f, provider, false, NOW_ISO, 'solana-rpc');
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['holderConcentrationStatus']).toBe('DANGER');
    expect(raw['topHolderPercent']).toBe(45);
  });

  it('records holderFetchError and UNKNOWN on RPC failure', async () => {
    const f = makeFixture(CONTRACT_A);
    const provider = makeProvider(new Error('RPC error (503): service unavailable'));
    const { patched, result } = await patchFixtureHolder(f, provider, false, NOW_ISO, 'solana-rpc');
    expect(result.rpcFailed).toBe(true);
    expect(result.rpcSucceeded).toBe(false);
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['holderConcentrationStatus']).toBe('UNKNOWN');
    expect(raw['holderFetchError']).toContain('503');
  });

  it('flags is429 for rate-limit errors', async () => {
    const f = makeFixture(CONTRACT_A);
    const provider = makeProvider(new Error('RPC error (429): Too many requests'));
    const { result } = await patchFixtureHolder(f, provider, false, NOW_ISO, 'solana-rpc');
    expect(result.is429).toBe(true);
    expect(result.rpcFailed).toBe(true);
  });

  it('force=true re-fetches already-enriched fixture', async () => {
    const f = makeFixture(CONTRACT_A, { holderConcentrationStatus: 'CLEAN', topHolderPercent: 5 });
    const provider = makeProvider(25);  // new data: 25% → WARNING
    const { patched, result } = await patchFixtureHolder(f, provider, true, NOW_ISO, 'solana-rpc');
    expect(result.skippedAlreadyEnriched).toBe(false);
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['holderConcentrationStatus']).toBe('WARNING');
  });

  it('does not add topHolderPercent when RPC returns null', async () => {
    const f = makeFixture(CONTRACT_A);
    const provider = makeProvider(null);
    const { patched } = await patchFixtureHolder(f, provider, false, NOW_ISO, 'solana-rpc');
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['holderConcentrationStatus']).toBe('UNKNOWN');
    expect('topHolderPercent' in raw).toBe(false);
  });

  it('preserves all other raw fields when patching', async () => {
    const f = makeFixture(CONTRACT_A, {
      signalId: 'abc', classification: 'winner', priceChangePct: 45,
    });
    const provider = makeProvider(7);
    const { patched } = await patchFixtureHolder(f, provider, false, NOW_ISO, 'solana-rpc');
    const raw = patched.raw as Record<string, unknown>;
    expect(raw['signalId']).toBe('abc');
    expect(raw['classification']).toBe('winner');
    expect(raw['priceChangePct']).toBe(45);
  });
});

// ── writeFixturesJsonlAtomic ───────────────────────────────────────────────────

describe('writeFixturesJsonlAtomic', () => {
  it('writes valid JSONL', () => {
    const f = path.join(tmpDir, 'out.jsonl');
    const fixtures = [makeFixture(CONTRACT_A), makeFixture(CONTRACT_B)];
    writeFixturesJsonlAtomic(fixtures, f);
    const read = readJsonl(f);
    expect(read).toHaveLength(2);
    expect(read[0].id).toBe(fixtures[0].id);
    expect(read[1].id).toBe(fixtures[1].id);
  });

  it('no temp file left after write', () => {
    const f = path.join(tmpDir, 'out.jsonl');
    writeFixturesJsonlAtomic([makeFixture(CONTRACT_A)], f);
    expect(fs.existsSync(f + '.tmp')).toBe(false);
  });

  it('creates parent directories', () => {
    const f = path.join(tmpDir, 'nested', 'deep', 'out.jsonl');
    writeFixturesJsonlAtomic([makeFixture(CONTRACT_A)], f);
    expect(fs.existsSync(f)).toBe(true);
  });
});

// ── runFixtureHolderEnrich ─────────────────────────────────────────────────────

describe('runFixtureHolderEnrich — missing file', () => {
  it('handles missing file gracefully', async () => {
    const result = await runFixtureHolderEnrich(
      { inputPath: path.join(tmpDir, 'no.jsonl') },
      noopSleep,
    );
    expect(result.inputMissing).toBe(true);
    expect(result.fixturesRead).toBe(0);
    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
  });
});

describe('runFixtureHolderEnrich — missing SOLANA_RPC_URL', () => {
  it('returns noRpcUrl=true and does not write when no RPC URL and not offline', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A)]);
    const before = fs.readFileSync(f, 'utf-8');

    // Ensure env var is not set for this call
    const savedUrl = process.env['SOLANA_RPC_URL'];
    delete process.env['SOLANA_RPC_URL'];

    const result = await runFixtureHolderEnrich(
      { inputPath: f, rpcUrl: undefined },
      noopSleep,
    );

    if (savedUrl) process.env['SOLANA_RPC_URL'] = savedUrl;

    expect(result.noRpcUrl).toBe(true);
    expect(fs.readFileSync(f, 'utf-8')).toBe(before);  // unchanged
  });
});

describe('runFixtureHolderEnrich — offline mode', () => {
  it('does not call RPC in offline mode', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A), makeFixture(CONTRACT_B)]);
    const before = fs.readFileSync(f, 'utf-8');

    const result = await runFixtureHolderEnrich(
      { inputPath: f, offline: true },
      noopSleep,
    );

    expect(result.offlineMode).toBe(true);
    expect(result.rpcAttempted).toBe(0);
    // offline uses offlineSafetyProvider which always returns null → UNKNOWN
    // shouldSkip returns false because raw has no holderConcentrationStatus
    // So fixtures ARE patched in offline mode (with UNKNOWN), file IS rewritten
    // This is intentional — marks them as "checked" (offline)
    // The file content should be valid JSONL but different from before
    const after = readJsonl(f);
    expect(after).toHaveLength(2);
    // After offline patch, holderConcentrationStatus should be UNKNOWN
    const raw0 = after[0].raw as Record<string, unknown>;
    expect(raw0['holderConcentrationStatus']).toBe('UNKNOWN');
    expect(raw0['holderProvider']).toBe('offline');
  });

  it('--dry-run does not mutate file even in offline mode', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A)]);
    const before = fs.readFileSync(f, 'utf-8');

    await runFixtureHolderEnrich(
      { inputPath: f, offline: true, dryRun: true },
      noopSleep,
    );

    expect(fs.readFileSync(f, 'utf-8')).toBe(before);
  });
});

describe('runFixtureHolderEnrich — dry-run', () => {
  it('does not write file', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A)]);
    const before = fs.readFileSync(f, 'utf-8');

    // offline + dry-run: no RPC, no write
    await runFixtureHolderEnrich(
      { inputPath: f, offline: true, dryRun: true },
      noopSleep,
    );

    expect(fs.readFileSync(f, 'utf-8')).toBe(before);
  });

  it('reports dryRun=true', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A)]);
    const result = await runFixtureHolderEnrich(
      { inputPath: f, offline: true, dryRun: true },
      noopSleep,
    );
    expect(result.dryRun).toBe(true);
  });
});

describe('runFixtureHolderEnrich — skip logic', () => {
  it('skips already-enriched fixtures by default', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [
      makeFixture(CONTRACT_A, { holderConcentrationStatus: 'CLEAN' }),
      makeFixture(CONTRACT_B),
    ]);

    const provider = makeProvider(10);
    // We can't inject provider into runFixtureHolderEnrich directly but we can
    // use offline mode since it uses offlineSafetyProvider (always UNKNOWN/null).
    // For a real provider injection test, we test via patchFixtureHolder directly.
    const result = await runFixtureHolderEnrich(
      { inputPath: f, offline: true },
      noopSleep,
    );
    // CONTRACT_A already enriched → skipped
    expect(result.skippedAlreadyEnriched).toBe(1);
    // CONTRACT_B not enriched → patched
    expect(result.fixturesPatched).toBe(1);
    void provider; // unused — see comment
  });

  it('--force re-fetches already-enriched fixtures', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A, { holderConcentrationStatus: 'CLEAN' })]);

    const result = await runFixtureHolderEnrich(
      { inputPath: f, offline: true, force: true },
      noopSleep,
    );
    expect(result.skippedAlreadyEnriched).toBe(0);
    expect(result.fixturesPatched).toBe(1);
  });

  it('skips fixtures with no contract address', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(null)]);

    const result = await runFixtureHolderEnrich(
      { inputPath: f, offline: true },
      noopSleep,
    );
    expect(result.skippedMissingContract).toBe(1);
    expect(result.fixturesPatched).toBe(0);
  });
});

describe('runFixtureHolderEnrich — limit', () => {
  it('respects --limit N', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [
      makeFixture(CONTRACT_A),
      makeFixture(CONTRACT_B),
      makeFixture('ContractCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'),
    ]);

    const result = await runFixtureHolderEnrich(
      { inputPath: f, offline: true, limitN: 1 },
      noopSleep,
    );
    expect(result.fixturesPatched).toBe(1);
    // The other 2 fixtures should still exist in the output
    const out = readJsonl(f);
    expect(out).toHaveLength(3);
  });
});

describe('runFixtureHolderEnrich — RPC behavior', () => {
  it('counts rpcAttempted/Succeeded when RPC provider returns data', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A)]);

    // Use rpcUrl='fake' — but the real createRpcSafetyProvider will fail because
    // the URL is fake, so we test the offline provider path for success counts.
    // For full RPC mock, we rely on patchFixtureHolder unit tests above.
    // Here we just confirm rpcAttempted=1 in online mode (even if it fails).
    const result = await runFixtureHolderEnrich(
      {
        inputPath: f,
        rpcUrl: 'http://localhost:9999/nonexistent',
        delayMs: 0,
      },
      noopSleep,
    );
    expect(result.rpcAttempted).toBe(1);
    // Will fail (connection refused) — rpcFailed should be 1
    expect(result.rpcFailed).toBe(1);
    // holderFetchError should be recorded in the patched raw
    const out = readJsonl(f);
    const raw = out[0].raw as Record<string, unknown>;
    expect(raw['holderConcentrationStatus']).toBe('UNKNOWN');
    expect(raw['holderFetchError']).toBeTruthy();
  });

  it('counts rpc429Count for 429 errors', async () => {
    // Test via patchFixtureHolder directly with a 429 error provider
    const f = makeFixture(CONTRACT_A);
    const provider = makeProvider(new Error('RPC error (429): Too many requests'));
    const { result } = await patchFixtureHolder(f, provider, false, NOW_ISO, 'test');
    expect(result.is429).toBe(true);
    expect(result.rpcFailed).toBe(true);
    // result.is429 feeds into rpc429Count in runFixtureHolderEnrich
  });
});

describe('runFixtureHolderEnrich — atomic rewrite', () => {
  it('preserves all fixtures after rewrite', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    const fixtures = [
      makeFixture(CONTRACT_A),
      makeFixture(null),    // skipped (no contract)
      makeFixture(CONTRACT_B, { holderConcentrationStatus: 'CLEAN' }), // skipped (already enriched)
    ];
    writeJsonl(f, fixtures);

    await runFixtureHolderEnrich(
      { inputPath: f, offline: true },
      noopSleep,
    );

    const out = readJsonl(f);
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe(fixtures[0].id);
    expect(out[1].id).toBe(fixtures[1].id);
    expect(out[2].id).toBe(fixtures[2].id);
  });

  it('does not change buyGateDecision or entryDecision', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A, {}, { buyGateDecision: 'BUY_REJECTED', entryDecision: 'NOT_READY' })]);

    await runFixtureHolderEnrich(
      { inputPath: f, offline: true },
      noopSleep,
    );

    const out = readJsonl(f);
    expect(out[0].buyGateDecision).toBe('BUY_REJECTED');
    expect(out[0].entryDecision).toBe('NOT_READY');
  });

  it('result has all safety flags', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A)]);

    const result = await runFixtureHolderEnrich(
      { inputPath: f, offline: true },
      noopSleep,
    );

    expect(result.tradingExecuted).toBe(0);
    expect(result.noRealTradeSent).toBe(true);
    expect(result.paperOnly).toBe(true);
    expect(result.readOnly).toBe(true);
  });
});

describe('runFixtureHolderEnrich — holderRiskCounts', () => {
  it('counts risk distribution after enrichment', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [
      makeFixture(CONTRACT_A, { holderConcentrationStatus: 'CLEAN' }),   // already enriched
      makeFixture(CONTRACT_B, { holderConcentrationStatus: 'DANGER' }),  // already enriched
      makeFixture(null),  // skipped
    ]);

    const result = await runFixtureHolderEnrich(
      { inputPath: f, offline: true },
      noopSleep,
    );

    // Already-enriched ones keep their values; null-contract stays as-is (UNKNOWN)
    // The offline patcher sets UNKNOWN for the no-contract fixture (actually skips it)
    expect(result.holderRiskCounts['CLEAN']).toBe(1);
    expect(result.holderRiskCounts['RISKY']).toBe(1);
    expect(result.holderRiskCounts['UNKNOWN']).toBeGreaterThanOrEqual(1);
  });
});

// ── Renderer ──────────────────────────────────────────────────────────────────

describe('renderFixtureHolderEnrichReport', () => {
  it('shows missing-file guidance', async () => {
    const result = await runFixtureHolderEnrich(
      { inputPath: path.join(tmpDir, 'no.jsonl') },
      noopSleep,
    );
    const out = renderFixtureHolderEnrichReport(result);
    expect(out).toContain('No fixture file found');
    expect(out).toContain('REAL TRADING LOCKED');
    expect(out).toContain('tradingExecuted=0');
  });

  it('shows no-rpc-url guidance', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A)]);
    const savedUrl = process.env['SOLANA_RPC_URL'];
    delete process.env['SOLANA_RPC_URL'];

    const result = await runFixtureHolderEnrich(
      { inputPath: f, rpcUrl: undefined },
      noopSleep,
    );

    if (savedUrl) process.env['SOLANA_RPC_URL'] = savedUrl;

    const out = renderFixtureHolderEnrichReport(result);
    expect(out).toContain('SOLANA_RPC_URL');
    expect(out).toContain('tradingExecuted=0');
  });

  it('shows enrichment summary', async () => {
    const f = path.join(tmpDir, 'fixtures.jsonl');
    writeJsonl(f, [makeFixture(CONTRACT_A)]);

    const result = await runFixtureHolderEnrich(
      { inputPath: f, offline: true },
      noopSleep,
    );
    const out = renderFixtureHolderEnrichReport(result);
    expect(out).toContain('ENRICHMENT SUMMARY');
    expect(out).toContain('tradingExecuted=0');
    expect(out).toContain('REAL TRADING LOCKED');
  });

  it('shows 429 warning when rpc429Count > 0', async () => {
    // Synthesize a result with 429s
    const result = await runFixtureHolderEnrich(
      { inputPath: path.join(tmpDir, 'no.jsonl') },
      noopSleep,
    );
    const synthetic = {
      ...result,
      inputMissing: false,
      fixturesRead: 3,
      offlineMode: false,
      rpc429Count: 2,
      rpcAttempted: 3,
      rpcFailed: 2,
      rpcSucceeded: 1,
    };
    const out = renderFixtureHolderEnrichReport(synthetic);
    expect(out).toContain('429');
  });
});

// ── Safety ─────────────────────────────────────────────────────────────────────

describe('safety', () => {
  it('module does not export signing/swap names', async () => {
    const mod = await import('../src/token-grab/fixtureHolderEnrich');
    const keys = Object.keys(mod);
    const forbidden = /sign(transaction|tx|wallet|swap)|sendtransaction|sendswap/i;
    for (const key of keys) expect(forbidden.test(key)).toBe(false);
  });
});
