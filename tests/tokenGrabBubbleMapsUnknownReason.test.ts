// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  readOnly=true  tradingExecuted=0
//
// BubbleMaps UNKNOWN reason classification tests.
// Verifies that every call path that returns UNKNOWN carries the correct
// unknownReason classification so the coverage diagnostic can explain WHY
// a call returned UNKNOWN (NO_MAP_YET, AUTH_ERROR, RATE_LIMITED, etc.).
//
// Safety invariant: clusterRisk=UNKNOWN is NEVER promoted to CLEAN, regardless
// of the reason. These tests verify the reason field without loosening any gate.

import * as os   from 'os';
import * as fs   from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createBubbleMapsClusterProvider,
  offlineClusterRiskProvider,
} from '../src/token-grab/clusterRiskProvider';
import {
  BubbleMapsCache,
} from '../src/token-grab/bubbleMapsCache';
import type { ClusterRiskProvider, ClusterRiskResult } from '../src/token-grab/clusterRiskProvider';

// ── Helpers ───────────────────────────────────────────────────────────────────

function abortError(): Error {
  const e = new Error('The operation was aborted');
  Object.defineProperty(e, 'name', { value: 'AbortError', configurable: true });
  return e;
}

function mockFetch(response: Partial<Response & { text?: () => Promise<string> }>): void {
  global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

function mockFetchThrows(err: Error): void {
  global.fetch = vi.fn().mockRejectedValue(err) as unknown as typeof fetch;
}

function makeProvider(apiKey?: string): ReturnType<typeof createBubbleMapsClusterProvider> {
  return createBubbleMapsClusterProvider({ apiUrl: 'https://test.api/v1', apiKey });
}

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

// ── 404 → NO_MAP_YET ─────────────────────────────────────────────────────────

describe('404 → NO_MAP_YET', () => {
  it('sets unknownReason=NO_MAP_YET for 404', async () => {
    mockFetch({ ok: false, status: 404 });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('NO_MAP_YET');
  });

  it('keeps clusterRisk=UNKNOWN — does NOT promote to CLEAN', async () => {
    mockFetch({ ok: false, status: 404 });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterRisk).not.toBe('CLEAN');
  });

  it('sets dataAvailable=false for 404', async () => {
    mockFetch({ ok: false, status: 404 });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.dataAvailable).toBe(false);
  });

  it('sets chain=solana for 404', async () => {
    mockFetch({ ok: false, status: 404 });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.chain).toBe('solana');
  });
});

// ── 400 variants ──────────────────────────────────────────────────────────────

describe('400/no-data → NO_MAP_YET', () => {
  it('"not available" body → NO_MAP_YET', async () => {
    mockFetch({ ok: false, status: 400, text: async () => 'Map data not available for this token' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('NO_MAP_YET');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toBeUndefined();  // not a provider failure
  });

  it('"no data" body → NO_MAP_YET', async () => {
    mockFetch({ ok: false, status: 400, text: async () => 'no data found' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('NO_MAP_YET');
  });

  it('"not found" body → NO_MAP_YET', async () => {
    mockFetch({ ok: false, status: 400, text: async () => 'token not found' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('NO_MAP_YET');
  });

  it('empty body → NO_MAP_YET', async () => {
    mockFetch({ ok: false, status: 400, text: async () => '' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('NO_MAP_YET');
    expect(result.dataAvailable).toBe(false);
  });
});

describe('400/chain → UNSUPPORTED_CHAIN', () => {
  it('"unsupported chain" body → UNSUPPORTED_CHAIN', async () => {
    mockFetch({ ok: false, status: 400, text: async () => 'unsupported chain for this request' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('UNSUPPORTED_CHAIN');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toBeDefined();
  });

  it('"chain not supported" body → UNSUPPORTED_CHAIN', async () => {
    mockFetch({ ok: false, status: 400, text: async () => 'chain not supported' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('UNSUPPORTED_CHAIN');
  });
});

describe('400/invalid-contract → INVALID_CONTRACT', () => {
  it('"invalid address" body → INVALID_CONTRACT', async () => {
    mockFetch({ ok: false, status: 400, text: async () => 'invalid address format' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('INVALID_CONTRACT');
    expect(result.clusterRisk).toBe('UNKNOWN');
  });

  it('"invalid contract" body → INVALID_CONTRACT', async () => {
    mockFetch({ ok: false, status: 400, text: async () => 'invalid contract' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('INVALID_CONTRACT');
  });
});

describe('400/other → PROVIDER_ERROR', () => {
  it('generic 400 body → PROVIDER_ERROR', async () => {
    mockFetch({ ok: false, status: 400, text: async () => 'Something went wrong' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('PROVIDER_ERROR');
    expect(result.clusterFetchError).toBeDefined();
  });
});

// ── 401 / 403 → AUTH_ERROR ────────────────────────────────────────────────────

describe('401 → AUTH_ERROR', () => {
  it('sets unknownReason=AUTH_ERROR for 401', async () => {
    mockFetch({ ok: false, status: 401 });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('AUTH_ERROR');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toContain('401');
  });

  it('error message for 401 mentions BUBBLEMAPS_API_KEY (not the actual key)', async () => {
    mockFetch({ ok: false, status: 401 });
    const result = await makeProvider('my-secret-key').fetchClusterRisk('MINT');
    expect(result.clusterFetchError).toContain('BUBBLEMAPS_API_KEY');
    expect(result.clusterFetchError).not.toContain('my-secret-key');
  });
});

describe('403 → AUTH_ERROR', () => {
  it('sets unknownReason=AUTH_ERROR for 403', async () => {
    mockFetch({ ok: false, status: 403 });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('AUTH_ERROR');
    expect(result.clusterRisk).toBe('UNKNOWN');
  });
});

// ── 429 → RATE_LIMITED ───────────────────────────────────────────────────────

describe('429 → RATE_LIMITED', () => {
  it('sets unknownReason=RATE_LIMITED for 429', async () => {
    mockFetch({ ok: false, status: 429 });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('RATE_LIMITED');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toContain('429');
  });
});

// ── Other non-2xx → PROVIDER_ERROR ───────────────────────────────────────────

describe('other non-2xx → PROVIDER_ERROR', () => {
  it('503 → PROVIDER_ERROR', async () => {
    mockFetch({ ok: false, status: 503 });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('PROVIDER_ERROR');
    expect(result.clusterRisk).toBe('UNKNOWN');
  });

  it('500 → PROVIDER_ERROR', async () => {
    mockFetch({ ok: false, status: 500 });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('PROVIDER_ERROR');
  });
});

// ── 200 + empty body → EMPTY_RESPONSE ────────────────────────────────────────

describe('200/empty-body → EMPTY_RESPONSE', () => {
  it('sets unknownReason=EMPTY_RESPONSE for 200 with empty body', async () => {
    mockFetch({ ok: true, status: 200, text: async () => '' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('EMPTY_RESPONSE');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.httpStatus).toBe(200);
    expect(result.clusterFetchError).toBeDefined();
  });

  it('whitespace-only body → EMPTY_RESPONSE', async () => {
    mockFetch({ ok: true, status: 200, text: async () => '   \n  ' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('EMPTY_RESPONSE');
  });
});

// ── 200 + malformed JSON → PARSE_ERROR ───────────────────────────────────────

describe('200/malformed-JSON → PARSE_ERROR', () => {
  it('sets unknownReason=PARSE_ERROR for 200 with malformed JSON', async () => {
    mockFetch({ ok: true, status: 200, text: async () => '<html>Error</html>' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('PARSE_ERROR');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.httpStatus).toBe(200);
    expect(result.clusterFetchError).toBeDefined();
  });

  it('truncated JSON body → PARSE_ERROR', async () => {
    mockFetch({ ok: true, status: 200, text: async () => '{"metrics":{"scores":{' });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('PARSE_ERROR');
  });
});

// ── 200 + no recognisable metrics → UNKNOWN_UNCLASSIFIED ─────────────────────

describe('200/no-metrics → UNKNOWN_UNCLASSIFIED', () => {
  it('sets unknownReason=UNKNOWN_UNCLASSIFIED for 200 with parseable but unrecognised metrics', async () => {
    mockFetch({ ok: true, status: 200, text: async () => JSON.stringify({ metadata: {}, nodes: [] }) });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('UNKNOWN_UNCLASSIFIED');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toBeUndefined();  // 200 is not a fetch failure
  });

  it('no clusterFetchError on UNKNOWN_UNCLASSIFIED — it is an integration gap, not a provider error', async () => {
    mockFetch({ ok: true, status: 200, text: async () => JSON.stringify({ foo: 'bar' }) });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('UNKNOWN_UNCLASSIFIED');
    expect(result.clusterFetchError).toBeUndefined();
  });
});

// ── 200 + valid metrics → no unknownReason ────────────────────────────────────

describe('200/valid-metrics → no unknownReason', () => {
  it('CLEAN result has no unknownReason', async () => {
    mockFetch({ ok: true, text: async () => JSON.stringify({ metrics: { scores: { bubblemaps_score: 75 } } }) });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.clusterRisk).toBe('CLEAN');
    expect(result.unknownReason).toBeUndefined();
  });

  it('WATCH result has no unknownReason', async () => {
    mockFetch({ ok: true, text: async () => JSON.stringify({ metrics: { scores: { bubblemaps_score: 45 } } }) });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.clusterRisk).toBe('WATCH');
    expect(result.unknownReason).toBeUndefined();
  });
});

// ── Network timeout → TIMEOUT ─────────────────────────────────────────────────

describe('AbortError (timeout) → TIMEOUT', () => {
  it('sets unknownReason=TIMEOUT when fetch throws AbortError', async () => {
    mockFetchThrows(abortError());
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('TIMEOUT');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toContain('timeout');
  });
});

// ── Generic network error → PROVIDER_ERROR ────────────────────────────────────

describe('network error → PROVIDER_ERROR', () => {
  it('sets unknownReason=PROVIDER_ERROR when fetch throws a TypeError', async () => {
    mockFetchThrows(new TypeError('Failed to fetch'));
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.unknownReason).toBe('PROVIDER_ERROR');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toBeDefined();
  });
});

// ── Secret redaction ──────────────────────────────────────────────────────────

describe('secret redaction', () => {
  it('redacts API key from error messages when fetch throws', async () => {
    const secret = 'super-secret-api-key-xyz';
    mockFetchThrows(new Error(`Request failed: auth=${secret}`));
    const result = await makeProvider(secret).fetchClusterRisk('MINT');
    expect(result.clusterFetchError).not.toContain(secret);
    expect(result.clusterFetchError).toContain('[REDACTED]');
  });

  it('does not redact if no API key configured', async () => {
    mockFetchThrows(new Error('Request failed'));
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.clusterFetchError).toContain('Request failed');
  });

  it('serialized result never contains API key', async () => {
    const secret = 'leak-if-redaction-broken';
    mockFetchThrows(new Error(`Error: token=${secret}`));
    const result = await makeProvider(secret).fetchClusterRisk('MINT');
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

// ── chain field ───────────────────────────────────────────────────────────────

describe('chain field is always solana for BubbleMaps provider', () => {
  it.each([
    ['404', { ok: false, status: 404 }],
    ['401', { ok: false, status: 401 }],
    ['429', { ok: false, status: 429 }],
    ['503', { ok: false, status: 503 }],
    ['200/empty', { ok: true, status: 200, text: async () => '' }],
  ] as const)('%s → chain=solana', async (_label, resp) => {
    mockFetch(resp as unknown as Partial<Response>);
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.chain).toBe('solana');
  });

  it('network error → chain=solana', async () => {
    mockFetchThrows(new Error('net error'));
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.chain).toBe('solana');
  });
});

// ── offlineClusterRiskProvider → OFFLINE ─────────────────────────────────────

describe('offlineClusterRiskProvider → OFFLINE', () => {
  it('offline provider sets unknownReason=OFFLINE', async () => {
    const result = await offlineClusterRiskProvider.fetchClusterRisk('any-mint');
    expect(result.unknownReason).toBe('OFFLINE');
    expect(result.clusterRisk).toBe('UNKNOWN');
  });

  it('offline provider sets chain=solana', async () => {
    const result = await offlineClusterRiskProvider.fetchClusterRisk('any-mint');
    expect(result.chain).toBe('solana');
  });
});

// ── BubbleMapsCache cap-skipped → CAP_REACHED ────────────────────────────────

describe('BubbleMapsCache cap-skipped → CAP_REACHED', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function makeCleanResult(): ClusterRiskResult {
    return {
      clusterRisk: 'CLEAN', clusterProvider: 'mock', clusterCheckedAt: new Date().toISOString(),
      clusterConfidence: 'HIGH', clusterNotes: [],
    };
  }

  function makeMockProvider(): ClusterRiskProvider {
    return { name: 'mock', fetchClusterRisk: async () => makeCleanResult() };
  }

  it('second call past cap=1 returns unknownReason=CAP_REACHED', async () => {
    const cachePath = path.join(tmpDir, 'cache.jsonl');
    const cache = new BubbleMapsCache(makeMockProvider(), cachePath, 1, 24 * 60 * 60 * 1000);
    await cache.fetchClusterRisk('contractA');  // live call (uses the cap)
    const second = await cache.fetchClusterRisk('contractB');  // skipped
    expect(second.unknownReason).toBe('CAP_REACHED');
    expect(second.clusterRisk).toBe('UNKNOWN');
  });

  it('cap-skipped result still blocks gate (clusterRisk=UNKNOWN not CLEAN)', async () => {
    const cachePath = path.join(tmpDir, 'cache.jsonl');
    const cache = new BubbleMapsCache(makeMockProvider(), cachePath, 0, 24 * 60 * 60 * 1000);
    const result = await cache.fetchClusterRisk('contractA');  // cap=0 → immediate skip
    expect(result.unknownReason).toBe('CAP_REACHED');
    expect(result.clusterRisk).not.toBe('CLEAN');
  });

  it('CAP_REACHED skip result is NOT written to cache file (no live call was made)', async () => {
    const cachePath = path.join(tmpDir, 'cache.jsonl');
    const cache = new BubbleMapsCache(makeMockProvider(), cachePath, 0, 24 * 60 * 60 * 1000);
    await cache.fetchClusterRisk('contractA');  // cap=0 → immediate skip, no live call
    // CAP_REACHED is an infrastructure skip, not a live-call result — must NOT be cached
    expect(fs.existsSync(cachePath)).toBe(false);
  });
});

// ── BubbleMapsCache disabled → DISABLED ──────────────────────────────────────

describe('BubbleMapsCache disabled → DISABLED', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('disabled cache returns unknownReason=DISABLED', async () => {
    const provider: ClusterRiskProvider = {
      name: 'mock',
      fetchClusterRisk: async () => ({
        clusterRisk: 'CLEAN', clusterProvider: 'mock', clusterCheckedAt: new Date().toISOString(),
        clusterConfidence: 'HIGH', clusterNotes: [],
      }),
    };
    const cachePath = path.join(tmpDir, 'cache.jsonl');
    const cache = new BubbleMapsCache(provider, cachePath, 20, 24 * 60 * 60 * 1000, undefined, true);
    const result = await cache.fetchClusterRisk('contractA');
    expect(result.unknownReason).toBe('DISABLED');
    expect(result.clusterRisk).toBe('UNKNOWN');
  });

  it('DISABLED skip result is NOT written to cache file (no live call was made)', async () => {
    const provider: ClusterRiskProvider = {
      name: 'mock',
      fetchClusterRisk: async () => ({
        clusterRisk: 'CLEAN', clusterProvider: 'mock', clusterCheckedAt: new Date().toISOString(),
        clusterConfidence: 'HIGH', clusterNotes: [],
      }),
    };
    const cachePath = path.join(tmpDir, 'cache.jsonl');
    const cache = new BubbleMapsCache(provider, cachePath, 20, 24 * 60 * 60 * 1000, undefined, true);
    await cache.fetchClusterRisk('contractA');
    // DISABLED is an infrastructure skip, not a live-call result — must NOT be cached
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('DISABLED result clusterRisk is never promoted to CLEAN', async () => {
    const provider: ClusterRiskProvider = {
      name: 'mock',
      fetchClusterRisk: async () => ({
        clusterRisk: 'CLEAN', clusterProvider: 'mock', clusterCheckedAt: new Date().toISOString(),
        clusterConfidence: 'HIGH', clusterNotes: [],
      }),
    };
    const cachePath = path.join(tmpDir, 'cache.jsonl');
    const cache = new BubbleMapsCache(provider, cachePath, 20, 24 * 60 * 60 * 1000, undefined, true);
    const result = await cache.fetchClusterRisk('contractA');
    expect(result.clusterRisk).not.toBe('CLEAN');
    expect(result.clusterRisk).toBe('UNKNOWN');
  });
});

// ── UNKNOWN ≠ CLEAN invariant (all paths) ─────────────────────────────────────

describe('UNKNOWN is never promoted to CLEAN regardless of reason', () => {
  const unknownCases: Array<[string, Parameters<typeof mockFetch>[0] | null]> = [
    ['404/NO_MAP_YET',       { ok: false, status: 404 }],
    ['400/empty/NO_MAP_YET', { ok: false, status: 400, text: async () => '' }],
    ['401/AUTH_ERROR',       { ok: false, status: 401 }],
    ['429/RATE_LIMITED',     { ok: false, status: 429 }],
    ['200/empty/EMPTY',      { ok: true, status: 200, text: async () => '' }],
    ['200/html/PARSE',       { ok: true, status: 200, text: async () => '<err>' }],
    ['200/no-metrics/UNKLASS', { ok: true, status: 200, text: async () => JSON.stringify({ foo: 1 }) }],
  ];
  it.each(unknownCases)('%s clusterRisk stays UNKNOWN', async (_label, resp) => {
    mockFetch(resp as unknown as Partial<Response>);
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterRisk).not.toBe('CLEAN');
  });

  it('network timeout → clusterRisk=UNKNOWN not CLEAN', async () => {
    mockFetchThrows(abortError());
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterRisk).not.toBe('CLEAN');
  });
});

// ── No real trading / no mutation ─────────────────────────────────────────────

describe('safety: no real trading, no mutation', () => {
  it('provider result carries no wallet/signing/trading fields', async () => {
    mockFetch({ ok: false, status: 404 });
    const result = await makeProvider().fetchClusterRisk('MINT');
    expect((result as Record<string, unknown>)['tradingExecuted']).toBeUndefined();
    expect((result as Record<string, unknown>)['realTradingLocked']).toBeUndefined();
    expect((result as Record<string, unknown>)['walletAddress']).toBeUndefined();
    expect((result as Record<string, unknown>)['signedTx']).toBeUndefined();
  });

  it('offline provider makes no fetch calls', async () => {
    const spy = vi.fn();
    global.fetch = spy as unknown as typeof fetch;
    await offlineClusterRiskProvider.fetchClusterRisk('any-mint');
    expect(spy).not.toHaveBeenCalled();
    global.fetch = originalFetch;
  });
});
