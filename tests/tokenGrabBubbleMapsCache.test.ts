// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  BubbleMapsCache,
  createBubbleMapsCachedProvider,
  BUBBLEMAPS_CACHE_TTL_MS,
  BUBBLEMAPS_MAX_CALLS_PER_RUN_DEFAULT,
  DEFAULT_CACHE_PATH,
  type BubbleMapsCacheEntry,
} from '../src/token-grab/bubbleMapsCache';
import type { ClusterRiskProvider, ClusterRiskResult } from '../src/token-grab/clusterRiskProvider';

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-cache-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCachePath(): string {
  return path.join(tmpDir, 'bubblemaps-cache.jsonl');
}

function makeCleanResult(contract: string, score = 80): ClusterRiskResult {
  return {
    clusterRisk:       'CLEAN',
    clusterProvider:   'bubblemaps',
    clusterCheckedAt:  '2026-06-17T10:00:00.000Z',
    clusterConfidence: 'HIGH',
    clusterNotes:      [`bubbleMapsScore ${score}`],
    rawMetrics:        { decentralisationScore: score },
  };
}

function makeFailResult(): ClusterRiskResult {
  return {
    clusterRisk:       'UNKNOWN',
    clusterProvider:   'bubblemaps',
    clusterCheckedAt:  '2026-06-17T10:00:00.000Z',
    clusterConfidence: 'UNKNOWN',
    clusterNotes:      ['http 429 (rate limited)'],
    clusterFetchError: 'http 429',
  };
}

/** Builds a mock ClusterRiskProvider that counts calls and returns the given result */
function makeMockProvider(result: ClusterRiskResult | ((mint: string) => ClusterRiskResult) = makeCleanResult('any')): {
  provider: ClusterRiskProvider;
  callCount: () => number;
  calls:     () => string[];
} {
  let callCount_ = 0;
  const calls_: string[] = [];
  const resultFn = typeof result === 'function' ? result : () => result;
  return {
    provider: {
      name: 'mock-bubblemaps',
      async fetchClusterRisk(tokenMint: string): Promise<ClusterRiskResult> {
        callCount_++;
        calls_.push(tokenMint);
        return resultFn(tokenMint);
      },
    },
    callCount: () => callCount_,
    calls:     () => [...calls_],
  };
}

// ── Safety ────────────────────────────────────────────────────────────────────

describe('safety constants', () => {
  it('source file contains DO_NOT_ENABLE_REAL_TRADING', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/bubbleMapsCache.ts'), 'utf-8',
    );
    expect(src).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('source file contains HOLD_CURRENT_GATES', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/bubbleMapsCache.ts'), 'utf-8',
    );
    expect(src).toContain('HOLD_CURRENT_GATES');
  });

  it('source does NOT contain token:auto-paper', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/bubbleMapsCache.ts'), 'utf-8',
    );
    expect(src).not.toContain('token:auto-paper');
  });

  it('source does NOT contain token:paper-buy', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/bubbleMapsCache.ts'), 'utf-8',
    );
    expect(src).not.toContain('token:paper-buy');
  });

  it('source does NOT contain signTransaction or wallet signing', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/token-grab/bubbleMapsCache.ts'), 'utf-8',
    );
    expect(src).not.toMatch(/signTransaction|walletSign|keypair\.sign/i);
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('BUBBLEMAPS_CACHE_TTL_MS is 24 hours', () => {
    expect(BUBBLEMAPS_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('BUBBLEMAPS_MAX_CALLS_PER_RUN_DEFAULT is 20', () => {
    expect(BUBBLEMAPS_MAX_CALLS_PER_RUN_DEFAULT).toBe(20);
  });

  it('DEFAULT_CACHE_PATH is under data/token-grab/ripper', () => {
    expect(DEFAULT_CACHE_PATH).toContain('data/token-grab/ripper');
    expect(DEFAULT_CACHE_PATH).toContain('bubblemaps-cache.jsonl');
  });
});

// ── Cache hit avoids live API call ────────────────────────────────────────────

describe('cache hit avoids live API call', () => {
  it('does not call provider when fresh cache entry exists', async () => {
    const cachePath = makeCachePath();
    const contract  = 'pumpCACHED001';
    const cachedResult = makeCleanResult(contract, 90);

    // Pre-populate cache file
    const entry: BubbleMapsCacheEntry = {
      contract,
      cachedAt: new Date().toISOString(),
      result:   cachedResult,
    };
    fs.writeFileSync(cachePath, JSON.stringify(entry) + '\n');

    const { provider, callCount } = makeMockProvider();
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    const result = await cache.fetchClusterRisk(contract);

    expect(callCount()).toBe(0);
    expect(result.clusterRisk).toBe('CLEAN');
    expect(cache.getStats().cacheHitsThisRun).toBe(1);
    expect(cache.getStats().liveCallsThisRun).toBe(0);
  });

  it('returns cached result fields correctly', async () => {
    const cachePath = makeCachePath();
    const contract  = 'pumpCACHED002';
    const cachedResult = makeCleanResult(contract, 75);
    const entry: BubbleMapsCacheEntry = {
      contract,
      cachedAt: new Date().toISOString(),
      result: cachedResult,
    };
    fs.writeFileSync(cachePath, JSON.stringify(entry) + '\n');

    const { provider } = makeMockProvider();
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    const result = await cache.fetchClusterRisk(contract);
    expect(result.rawMetrics?.decentralisationScore).toBe(75);
  });

  it('second call to same contract within a run uses in-memory cache, not disk', async () => {
    const cachePath = makeCachePath();
    const contract  = 'pumpCACHED003';

    const { provider, callCount } = makeMockProvider(makeCleanResult(contract));
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk(contract);  // live call → cached in memory
    await cache.fetchClusterRisk(contract);  // should hit in-memory cache

    expect(callCount()).toBe(1);
    expect(cache.getStats().cacheHitsThisRun).toBe(1);
    expect(cache.getStats().liveCallsThisRun).toBe(1);
  });

  it('expired cache entry triggers a live call', async () => {
    const cachePath = makeCachePath();
    const contract  = 'pumpEXPIRED001';

    const expiredCachedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const entry: BubbleMapsCacheEntry = {
      contract,
      cachedAt: expiredCachedAt,
      result:   makeCleanResult(contract, 88),
    };
    fs.writeFileSync(cachePath, JSON.stringify(entry) + '\n');

    const { provider, callCount } = makeMockProvider(makeCleanResult(contract, 88));
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk(contract);
    expect(callCount()).toBe(1);
    expect(cache.getStats().liveCallsThisRun).toBe(1);
    expect(cache.getStats().cacheHitsThisRun).toBe(0);
  });

  it('duplicate contracts in cache file — last entry wins', async () => {
    const cachePath = makeCachePath();
    const contract  = 'pumpDUPE001';

    const oldEntry: BubbleMapsCacheEntry = {
      contract,
      cachedAt: new Date(Date.now() - 1000).toISOString(),
      result: { ...makeCleanResult(contract, 60), clusterNotes: ['old'] },
    };
    const newEntry: BubbleMapsCacheEntry = {
      contract,
      cachedAt: new Date().toISOString(),
      result: { ...makeCleanResult(contract, 99), clusterNotes: ['new'] },
    };
    fs.writeFileSync(cachePath,
      JSON.stringify(oldEntry) + '\n' + JSON.stringify(newEntry) + '\n',
    );

    const { provider, callCount } = makeMockProvider();
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    const result = await cache.fetchClusterRisk(contract);
    expect(callCount()).toBe(0);
    expect(result.clusterNotes).toContain('new');
  });
});

// ── Per-run cap ────────────────────────────────────────────────────────────────

describe('per-run cap stops further live calls', () => {
  it('stops live calls after cap is reached', async () => {
    const cachePath = makeCachePath();
    const { provider, callCount } = makeMockProvider(
      (mint: string) => makeCleanResult(mint),
    );
    const cache = new BubbleMapsCache(provider, cachePath, 3, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk('contractA');
    await cache.fetchClusterRisk('contractB');
    await cache.fetchClusterRisk('contractC');
    await cache.fetchClusterRisk('contractD'); // should be capped
    await cache.fetchClusterRisk('contractE'); // should be capped

    expect(callCount()).toBe(3);
    expect(cache.getStats().liveCallsThisRun).toBe(3);
    expect(cache.getStats().skippedDueToCap).toBe(2);
  });

  it('capped calls return UNKNOWN with cap note', async () => {
    const cachePath = makeCachePath();
    const { provider } = makeMockProvider((mint: string) => makeCleanResult(mint));
    const cache = new BubbleMapsCache(provider, cachePath, 1, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk('contractA'); // live
    const cappedResult = await cache.fetchClusterRisk('contractB'); // capped

    expect(cappedResult.clusterRisk).toBe('UNKNOWN');
    expect(cappedResult.clusterNotes.some(n => n.includes('cap'))).toBe(true);
  });

  it('cap=0 makes zero live calls (all skipped)', async () => {
    const cachePath = makeCachePath();
    const { provider, callCount } = makeMockProvider();
    const cache = new BubbleMapsCache(provider, cachePath, 0, BUBBLEMAPS_CACHE_TTL_MS);

    const result = await cache.fetchClusterRisk('anyContract');

    expect(callCount()).toBe(0);
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(cache.getStats().liveCallsThisRun).toBe(0);
    expect(cache.getStats().skippedDueToCap).toBe(1);
  });

  it('stats.capLimit reflects constructor argument', () => {
    const { provider } = makeMockProvider();
    const cache = new BubbleMapsCache(provider, makeCachePath(), 7, BUBBLEMAPS_CACHE_TTL_MS);
    expect(cache.getStats().capLimit).toBe(7);
  });
});

// ── Persistent disk cache ─────────────────────────────────────────────────────

describe('persistent disk cache', () => {
  it('writes a successful result to the cache file', async () => {
    const cachePath = makeCachePath();
    const contract  = 'pumpWRITE001';
    const { provider } = makeMockProvider(makeCleanResult(contract));
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk(contract);

    expect(fs.existsSync(cachePath)).toBe(true);
    const lines = fs.readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!) as BubbleMapsCacheEntry;
    expect(entry.contract).toBe(contract);
    expect(entry.result.clusterRisk).toBe('CLEAN');
  });

  it('writes UNKNOWN results from live calls to disk, including transient-error results', async () => {
    const cachePath = makeCachePath();
    const { provider } = makeMockProvider(makeFailResult());
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk('pumpFAIL001');

    // UNKNOWN live-call results must be cached so diagnostics can show WHY calls failed
    expect(fs.existsSync(cachePath)).toBe(true);
    const lines = fs.readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const stored = JSON.parse(lines[0]!) as BubbleMapsCacheEntry;
    expect(stored.contract).toBe('pumpFAIL001');
    expect(stored.result.clusterRisk).toBe('UNKNOWN');
    expect(stored.result.clusterFetchError).toBeDefined();
  });

  it('does NOT write DISABLED results to disk (returns before live call)', async () => {
    const cachePath = makeCachePath();
    const { provider } = makeMockProvider(makeCleanResult('any'));
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS, undefined, true);

    await cache.fetchClusterRisk('contractA');

    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('does NOT write CAP_REACHED results to disk (returns before live call)', async () => {
    const cachePath = makeCachePath();
    const { provider } = makeMockProvider(makeCleanResult('any'));
    const cache = new BubbleMapsCache(provider, cachePath, 0, BUBBLEMAPS_CACHE_TTL_MS); // cap=0

    await cache.fetchClusterRisk('contractA');

    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('loads existing cache from disk on construction', async () => {
    const cachePath = makeCachePath();
    const contract  = 'pumpLOAD001';
    const entry: BubbleMapsCacheEntry = {
      contract,
      cachedAt: new Date().toISOString(),
      result:   makeCleanResult(contract, 85),
    };
    fs.writeFileSync(cachePath, JSON.stringify(entry) + '\n');

    const { provider, callCount } = makeMockProvider();
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);
    const result = await cache.fetchClusterRisk(contract);

    expect(callCount()).toBe(0);
    expect(result.clusterRisk).toBe('CLEAN');
  });

  it('handles non-existent cache path gracefully (fresh start)', async () => {
    const cachePath = path.join(tmpDir, 'subdir', 'does-not-exist.jsonl');
    const { provider, callCount } = makeMockProvider(makeCleanResult('c'));
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    const result = await cache.fetchClusterRisk('c');
    expect(callCount()).toBe(1);
    expect(result.clusterRisk).toBe('CLEAN');
  });
});

// ── Stats reporting ───────────────────────────────────────────────────────────

describe('getStats', () => {
  it('starts with all zeros', () => {
    const { provider } = makeMockProvider();
    const cache = new BubbleMapsCache(provider, makeCachePath(), 20, BUBBLEMAPS_CACHE_TTL_MS);
    expect(cache.getStats()).toEqual({
      liveCallsThisRun: 0,
      cacheHitsThisRun: 0,
      skippedDueToCap:  0,
      capLimit:         20,
      mode:             'LIVE_CAPPED',
    });
  });

  it('correctly tracks mixed live, hit, and capped calls', async () => {
    const cachePath = makeCachePath();

    // Pre-populate cache for contractB (warm hit)
    const entryB: BubbleMapsCacheEntry = {
      contract: 'contractB',
      cachedAt: new Date().toISOString(),
      result:   makeCleanResult('contractB'),
    };
    fs.writeFileSync(cachePath, JSON.stringify(entryB) + '\n');

    const { provider } = makeMockProvider((mint: string) => makeCleanResult(mint));
    const cache = new BubbleMapsCache(provider, cachePath, 2, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk('contractA'); // live (1)
    await cache.fetchClusterRisk('contractB'); // cache hit
    await cache.fetchClusterRisk('contractC'); // live (2)
    await cache.fetchClusterRisk('contractD'); // capped

    const stats = cache.getStats();
    expect(stats.liveCallsThisRun).toBe(2);
    expect(stats.cacheHitsThisRun).toBe(1);
    expect(stats.skippedDueToCap).toBe(1);
    expect(stats.capLimit).toBe(2);
  });

  it('getStats returns a copy (mutation does not affect internal state)', () => {
    const { provider } = makeMockProvider();
    const cache = new BubbleMapsCache(provider, makeCachePath(), 20, BUBBLEMAPS_CACHE_TTL_MS);
    const stats = cache.getStats();
    stats.liveCallsThisRun = 999;
    expect(cache.getStats().liveCallsThisRun).toBe(0);
  });
});

// ── Factory function ──────────────────────────────────────────────────────────

describe('createBubbleMapsCachedProvider factory', () => {
  it('returns a BubbleMapsCache instance', () => {
    const { provider } = makeMockProvider();
    const cache = createBubbleMapsCachedProvider(provider, { cachePath: makeCachePath() });
    expect(cache).toBeInstanceOf(BubbleMapsCache);
    expect(cache.name).toBe('bubblemaps-cached');
  });

  it('uses default cap of 20 when env var not set', () => {
    const savedEnv = process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
    delete process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
    const { provider } = makeMockProvider();
    const cache = createBubbleMapsCachedProvider(provider, { cachePath: makeCachePath() });
    expect(cache.getStats().capLimit).toBe(20);
    if (savedEnv !== undefined) process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'] = savedEnv;
  });

  it('reads cap from TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN env var', () => {
    process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'] = '5';
    const { provider } = makeMockProvider();
    const cache = createBubbleMapsCachedProvider(provider, { cachePath: makeCachePath() });
    expect(cache.getStats().capLimit).toBe(5);
    delete process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
  });

  it('cap=0 via env var makes zero live calls', async () => {
    process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'] = '0';
    const { provider, callCount } = makeMockProvider();
    const cache = createBubbleMapsCachedProvider(provider, { cachePath: makeCachePath() });
    await cache.fetchClusterRisk('anyContract');
    expect(callCount()).toBe(0);
    expect(cache.getStats().skippedDueToCap).toBe(1);
    delete process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
  });

  it('opts.maxCallsPerRun overrides env var', () => {
    process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'] = '5';
    const { provider } = makeMockProvider();
    const cache = createBubbleMapsCachedProvider(provider, {
      cachePath:      makeCachePath(),
      maxCallsPerRun: 42,
    });
    expect(cache.getStats().capLimit).toBe(42);
    delete process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
  });
});

// ── Provider error handling ───────────────────────────────────────────────────

describe('provider error handling', () => {
  it('wraps unexpected provider throws in UNKNOWN result', async () => {
    const cachePath = makeCachePath();
    const throwingProvider: ClusterRiskProvider = {
      name: 'throwing-provider',
      async fetchClusterRisk(): Promise<ClusterRiskResult> {
        throw new Error('network failure');
      },
    };
    const cache = new BubbleMapsCache(throwingProvider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);
    const result = await cache.fetchClusterRisk('anyContract');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toContain('network failure');
  });

  it('writes unexpected-throw results to disk as UNKNOWN/PROVIDER_ERROR', async () => {
    const cachePath = makeCachePath();
    const throwingProvider: ClusterRiskProvider = {
      name: 'throwing-provider',
      async fetchClusterRisk(): Promise<ClusterRiskResult> {
        throw new Error('boom');
      },
    };
    const cache = new BubbleMapsCache(throwingProvider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);
    await cache.fetchClusterRisk('anyContract');
    // Unexpected throws are also live-call results and must be cached
    expect(fs.existsSync(cachePath)).toBe(true);
    const lines = fs.readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
    const stored = JSON.parse(lines[0]!) as BubbleMapsCacheEntry;
    expect(stored.result.clusterRisk).toBe('UNKNOWN');
    expect(stored.result.clusterFetchError).toContain('boom');
    expect(stored.result.unknownReason).toBe('PROVIDER_ERROR');
  });
});

// ── Rate-limit guard (stop-on-first-429) ──────────────────────────────────────

describe('rate-limit guard stops live calls after first RATE_LIMITED result', () => {
  function makeRateLimitedResult(): ClusterRiskResult {
    return {
      clusterRisk:       'UNKNOWN',
      clusterProvider:   'bubblemaps',
      clusterCheckedAt:  new Date().toISOString(),
      clusterConfidence: 'UNKNOWN',
      clusterNotes:      ['http 429 (rate limited)'],
      clusterFetchError: 'http 429 (rate limited)',
      unknownReason:     'RATE_LIMITED',
    };
  }

  it('first RATE_LIMITED result is returned and written to disk', async () => {
    const cachePath = makeCachePath();
    const { provider, callCount } = makeMockProvider(makeRateLimitedResult());
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    const result = await cache.fetchClusterRisk('contractA');

    expect(callCount()).toBe(1);
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.unknownReason).toBe('RATE_LIMITED');
    expect(fs.existsSync(cachePath)).toBe(true);
    const lines = fs.readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const stored = JSON.parse(lines[0]!) as BubbleMapsCacheEntry;
    expect(stored.result.unknownReason).toBe('RATE_LIMITED');
  });

  it('second call after RATE_LIMITED skips live call and is NOT written to disk', async () => {
    const cachePath = makeCachePath();
    const { provider, callCount } = makeMockProvider(makeRateLimitedResult());
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk('contractA');  // first: live, RATE_LIMITED, cached
    const second = await cache.fetchClusterRisk('contractB');  // second: skipped

    expect(callCount()).toBe(1);  // provider called only once
    expect(second.clusterRisk).toBe('UNKNOWN');
    expect(second.unknownReason).toBe('CAP_REACHED');
    expect(second.clusterNotes.some(n => n.includes('rate limit hit earlier this run'))).toBe(true);
    // Only the first RATE_LIMITED result should be in the cache file
    const lines = fs.readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const stored = JSON.parse(lines[0]!) as BubbleMapsCacheEntry;
    expect(stored.contract).toBe('contractA');
  });

  it('multiple calls after RATE_LIMITED all skip — provider never called again', async () => {
    const cachePath = makeCachePath();
    const { provider, callCount } = makeMockProvider(makeRateLimitedResult());
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk('contractA');  // first 429
    await cache.fetchClusterRisk('contractB');  // skipped
    await cache.fetchClusterRisk('contractC');  // skipped
    await cache.fetchClusterRisk('contractD');  // skipped

    expect(callCount()).toBe(1);
    expect(cache.getStats().liveCallsThisRun).toBe(1);
    expect(cache.getStats().skippedDueToCap).toBe(3);
  });

  it('rate-limit skip returns UNKNOWN not CLEAN — gate remains blocked', async () => {
    const cachePath = makeCachePath();
    const { provider } = makeMockProvider(makeRateLimitedResult());
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk('contractA');
    const skipped = await cache.fetchClusterRisk('contractB');

    expect(skipped.clusterRisk).toBe('UNKNOWN');
    expect(skipped.clusterRisk).not.toBe('CLEAN');
  });

  it('normal run with no 429s still calls provider up to cap', async () => {
    const cachePath = makeCachePath();
    const { provider, callCount } = makeMockProvider((mint: string) => makeCleanResult(mint));
    const cache = new BubbleMapsCache(provider, cachePath, 3, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk('contractA');
    await cache.fetchClusterRisk('contractB');
    await cache.fetchClusterRisk('contractC');

    expect(callCount()).toBe(3);
    expect(cache.getStats().liveCallsThisRun).toBe(3);
    expect(cache.getStats().skippedDueToCap).toBe(0);
  });
});

// ── Cross-run rate-limit cooldown ─────────────────────────────────────────────

describe('rate-limit cooldown persists across runs', () => {
  function makeRateLimitedResult(): ClusterRiskResult {
    return {
      clusterRisk:       'UNKNOWN',
      clusterProvider:   'bubblemaps',
      clusterCheckedAt:  new Date().toISOString(),
      clusterConfidence: 'UNKNOWN',
      clusterNotes:      ['http 429 (rate limited)'],
      clusterFetchError: 'http 429 (rate limited)',
      httpStatus:        429,
      unknownReason:     'RATE_LIMITED',
    };
  }

  function cooldownPath(): string {
    return path.join(tmpDir, 'bubblemaps-rate-limit-cooldown.json');
  }

  it('writes a cooldown file when a live call returns RATE_LIMITED', async () => {
    const cachePath = makeCachePath();
    const { provider } = makeMockProvider(makeRateLimitedResult());
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk('pumpRL001');

    expect(fs.existsSync(cooldownPath())).toBe(true);
    const marker = JSON.parse(fs.readFileSync(cooldownPath(), 'utf-8')) as {
      createdAt: string; expiresAt: string; reason: string; httpStatus: number;
      lastContract?: string; note: string;
    };
    expect(marker.reason).toBe('RATE_LIMITED');
    expect(marker.httpStatus).toBe(429);
    expect(marker.lastContract).toBe('pumpRL001');
    expect(new Date(marker.expiresAt).getTime()).toBeGreaterThan(new Date(marker.createdAt).getTime());
    expect(marker.note.toLowerCase()).toContain('cooldown');
  });

  it('active cooldown (from a prior run) prevents any provider call', async () => {
    const cachePath = makeCachePath();
    // Simulate a previous run having written an active cooldown marker.
    fs.writeFileSync(cooldownPath(), JSON.stringify({
      createdAt:  new Date(Date.now() - 60_000).toISOString(),
      expiresAt:  new Date(Date.now() + 30 * 60_000).toISOString(), // 30 min in future
      reason:     'RATE_LIMITED',
      httpStatus: 429,
      note:       'prior 429',
    }));

    const { provider, callCount } = makeMockProvider(makeCleanResult('any'));
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    const result = await cache.fetchClusterRisk('pumpRL002');

    expect(callCount()).toBe(0);
    expect(cache.getStats().liveCallsThisRun).toBe(0);
    expect(cache.getStats().skippedDueToCap).toBe(1);
    expect(result.clusterNotes.some(n => n.includes('rate-limit cooldown active'))).toBe(true);
  });

  it('active cooldown skip is UNKNOWN, never CLEAN', async () => {
    const cachePath = makeCachePath();
    fs.writeFileSync(cooldownPath(), JSON.stringify({
      createdAt:  new Date().toISOString(),
      expiresAt:  new Date(Date.now() + 30 * 60_000).toISOString(),
      reason:     'RATE_LIMITED',
      httpStatus: 429,
      note:       'prior 429',
    }));

    const { provider } = makeMockProvider(makeCleanResult('any'));
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    const result = await cache.fetchClusterRisk('pumpRL003');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterRisk).not.toBe('CLEAN');
  });

  it('active cooldown skip is NOT written to the cache file', async () => {
    const cachePath = makeCachePath();
    fs.writeFileSync(cooldownPath(), JSON.stringify({
      createdAt:  new Date().toISOString(),
      expiresAt:  new Date(Date.now() + 30 * 60_000).toISOString(),
      reason:     'RATE_LIMITED',
      httpStatus: 429,
      note:       'prior 429',
    }));

    const { provider } = makeMockProvider(makeCleanResult('any'));
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    await cache.fetchClusterRisk('pumpRL004');
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('expired cooldown is ignored — provider IS called', async () => {
    const cachePath = makeCachePath();
    fs.writeFileSync(cooldownPath(), JSON.stringify({
      createdAt:  new Date(Date.now() - 120 * 60_000).toISOString(),
      expiresAt:  new Date(Date.now() - 60 * 60_000).toISOString(), // expired 60 min ago
      reason:     'RATE_LIMITED',
      httpStatus: 429,
      note:       'old 429',
    }));

    const { provider, callCount } = makeMockProvider(makeCleanResult('pumpRL005'));
    const cache = new BubbleMapsCache(provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS);

    const result = await cache.fetchClusterRisk('pumpRL005');
    expect(callCount()).toBe(1);
    expect(result.clusterRisk).toBe('CLEAN');
  });

  it('cooldownMs=0 disables the cooldown (RATE_LIMITED writes no marker)', async () => {
    const cachePath = makeCachePath();
    const { provider } = makeMockProvider(makeRateLimitedResult());
    const cache = new BubbleMapsCache(
      provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS, undefined, false, 0,
    );
    await cache.fetchClusterRisk('pumpRL006');
    expect(fs.existsSync(cooldownPath())).toBe(false);
  });

  it('factory reads TOKEN_GRAB_BUBBLEMAPS_RATE_LIMIT_COOLDOWN_MINUTES env override', async () => {
    process.env['TOKEN_GRAB_BUBBLEMAPS_RATE_LIMIT_COOLDOWN_MINUTES'] = '5';
    const cachePath = makeCachePath();
    const { provider } = makeMockProvider(makeRateLimitedResult());
    const cache = createBubbleMapsCachedProvider(provider, { cachePath });
    await cache.fetchClusterRisk('pumpRL007');
    const marker = JSON.parse(fs.readFileSync(cooldownPath(), 'utf-8')) as {
      createdAt: string; expiresAt: string;
    };
    const spanMin = (new Date(marker.expiresAt).getTime() - new Date(marker.createdAt).getTime()) / 60_000;
    expect(Math.round(spanMin)).toBe(5);
    delete process.env['TOKEN_GRAB_BUBBLEMAPS_RATE_LIMIT_COOLDOWN_MINUTES'];
  });
});

// ── package.json / CLI registration ──────────────────────────────────────────

describe('CLI registration', () => {
  it('package.json has token:ripper-bubblemaps-value-report entry', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['token:ripper-bubblemaps-value-report']).toBeDefined();
    expect(pkg.scripts['token:ripper-bubblemaps-value-report']).toContain('cli.ts');
  });
});
