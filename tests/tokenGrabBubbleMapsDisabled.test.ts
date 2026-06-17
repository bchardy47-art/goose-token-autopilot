// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  BubbleMapsCache,
  createBubbleMapsCachedProvider,
  BUBBLEMAPS_CACHE_TTL_MS,
} from '../src/token-grab/bubbleMapsCache';
import type { ClusterRiskProvider, ClusterRiskResult } from '../src/token-grab/clusterRiskProvider';

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-disabled-test-'));
  delete process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'];
  delete process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'];
  delete process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
});

function makeCachePath(): string {
  return path.join(tmpDir, 'bubblemaps-cache.jsonl');
}

function makeProvider(result: Partial<ClusterRiskResult> = {}): ClusterRiskProvider & { calls: number } {
  let calls = 0;
  return {
    name: 'mock-bubblemaps',
    get calls() { return calls; },
    async fetchClusterRisk(): Promise<ClusterRiskResult> {
      calls++;
      return {
        clusterRisk:       'CLEAN',
        clusterProvider:   'mock-bubblemaps',
        clusterCheckedAt:  new Date().toISOString(),
        clusterConfidence: 'HIGH',
        clusterNotes:      ['mock result'],
        ...result,
      };
    },
  };
}

function writeCacheEntry(cachePath: string, contract: string, ageMs = 0): void {
  const entry = {
    contract,
    cachedAt: new Date(Date.now() - ageMs).toISOString(),
    result: {
      clusterRisk: 'CLEAN',
      clusterProvider: 'bubblemaps',
      clusterCheckedAt: new Date(Date.now() - ageMs).toISOString(),
      clusterConfidence: 'HIGH',
      clusterNotes: ['cached result'],
    },
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.appendFileSync(cachePath, JSON.stringify(entry) + '\n', 'utf-8');
}

// ── Safety strings ────────────────────────────────────────────────────────────

describe('safety strings', () => {
  it('source file has DO_NOT_ENABLE_REAL_TRADING', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/token-grab/bubbleMapsCache.ts'),
      'utf-8',
    );
    expect(src).toContain('DO_NOT_ENABLE_REAL_TRADING');
  });

  it('source file has HOLD_CURRENT_GATES', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/token-grab/bubbleMapsCache.ts'),
      'utf-8',
    );
    expect(src).toContain('HOLD_CURRENT_GATES');
  });

  it('source file has no signTransaction', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/token-grab/bubbleMapsCache.ts'),
      'utf-8',
    );
    expect(src).not.toContain('signTransaction');
  });

  it('source file has no token:auto-paper', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/token-grab/bubbleMapsCache.ts'),
      'utf-8',
    );
    expect(src).not.toContain('token:auto-paper');
  });
});

// ── Disabled mode: constructor ─────────────────────────────────────────────────

describe('BubbleMapsCache disabled mode — constructor flag', () => {
  it('makes zero live calls when disabled=true', async () => {
    const provider = makeProvider();
    const cache = new BubbleMapsCache(
      provider, makeCachePath(), 20, BUBBLEMAPS_CACHE_TTL_MS, () => Date.now(), true,
    );
    await cache.fetchClusterRisk('mint1');
    await cache.fetchClusterRisk('mint2');
    expect(provider.calls).toBe(0);
  });

  it('returns UNKNOWN with disabled note when no cache entry exists', async () => {
    const provider = makeProvider();
    const cache = new BubbleMapsCache(
      provider, makeCachePath(), 20, BUBBLEMAPS_CACHE_TTL_MS, () => Date.now(), true,
    );
    const result = await cache.fetchClusterRisk('mint-no-cache');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterNotes.some(n => n.includes('TOKEN_GRAB_BUBBLEMAPS_DISABLED'))).toBe(true);
  });

  it('returns cached result when cache entry exists (disabled still uses cache)', async () => {
    const cachePath = makeCachePath();
    writeCacheEntry(cachePath, 'cached-mint');
    const provider = makeProvider();
    const cache = new BubbleMapsCache(
      provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS, () => Date.now(), true,
    );
    const result = await cache.fetchClusterRisk('cached-mint');
    expect(result.clusterRisk).toBe('CLEAN');
    expect(provider.calls).toBe(0);
  });

  it('does not write disabled UNKNOWN results to disk', async () => {
    const cachePath = makeCachePath();
    const provider = makeProvider();
    const cache = new BubbleMapsCache(
      provider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS, () => Date.now(), true,
    );
    await cache.fetchClusterRisk('mint1');
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('getStats reports mode=DISABLED', async () => {
    const cache = new BubbleMapsCache(
      makeProvider(), makeCachePath(), 20, BUBBLEMAPS_CACHE_TTL_MS, () => Date.now(), true,
    );
    await cache.fetchClusterRisk('x');
    const stats = cache.getStats();
    expect(stats.mode).toBe('DISABLED');
  });

  it('getStats shows zero live calls and skipped count', async () => {
    const cache = new BubbleMapsCache(
      makeProvider(), makeCachePath(), 20, BUBBLEMAPS_CACHE_TTL_MS, () => Date.now(), true,
    );
    await cache.fetchClusterRisk('a');
    await cache.fetchClusterRisk('b');
    const stats = cache.getStats();
    expect(stats.liveCallsThisRun).toBe(0);
    expect(stats.skippedDueToCap).toBe(2);
    expect(stats.cacheHitsThisRun).toBe(0);
  });

  it('cache hits still counted when disabled and cache present', async () => {
    const cachePath = makeCachePath();
    writeCacheEntry(cachePath, 'mint-a');
    const cache = new BubbleMapsCache(
      makeProvider(), cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS, () => Date.now(), true,
    );
    await cache.fetchClusterRisk('mint-a'); // cache hit
    await cache.fetchClusterRisk('mint-b'); // no cache → skipped (disabled)
    const stats = cache.getStats();
    expect(stats.cacheHitsThisRun).toBe(1);
    expect(stats.skippedDueToCap).toBe(1);
    expect(stats.liveCallsThisRun).toBe(0);
  });

  it('disabled overrides per-run cap (disabled takes precedence)', async () => {
    const provider = makeProvider();
    // cap=0, disabled=true — disabled wins (both prevent live calls, but note should say disabled)
    const cache = new BubbleMapsCache(
      provider, makeCachePath(), 0, BUBBLEMAPS_CACHE_TTL_MS, () => Date.now(), true,
    );
    const result = await cache.fetchClusterRisk('x');
    expect(result.clusterNotes.some(n => n.includes('TOKEN_GRAB_BUBBLEMAPS_DISABLED'))).toBe(true);
    expect(result.clusterNotes.some(n => n.includes('per-run cap'))).toBe(false);
    expect(cache.getStats().mode).toBe('DISABLED');
  });
});

// ── Disabled mode: factory / env var ──────────────────────────────────────────

describe('createBubbleMapsCachedProvider disabled mode — env var', () => {
  it('TOKEN_GRAB_BUBBLEMAPS_DISABLED=1 results in zero live calls', async () => {
    process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'] = '1';
    const provider = makeProvider();
    const cache = createBubbleMapsCachedProvider(provider, { cachePath: makeCachePath() });
    await cache.fetchClusterRisk('mint1');
    await cache.fetchClusterRisk('mint2');
    expect(provider.calls).toBe(0);
    expect(cache.getStats().mode).toBe('DISABLED');
  });

  it('TOKEN_GRAB_BUBBLEMAPS_DISABLED=true (lowercase) also disables', async () => {
    process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'] = 'true';
    const provider = makeProvider();
    const cache = createBubbleMapsCachedProvider(provider, { cachePath: makeCachePath() });
    await cache.fetchClusterRisk('mint1');
    expect(provider.calls).toBe(0);
    expect(cache.getStats().mode).toBe('DISABLED');
  });

  it('TOKEN_GRAB_BUBBLEMAPS_DISABLED=0 does not disable (live calls allowed)', async () => {
    process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'] = '0';
    const provider = makeProvider();
    const cache = createBubbleMapsCachedProvider(provider, {
      cachePath: makeCachePath(),
      maxCallsPerRun: 5,
    });
    await cache.fetchClusterRisk('mint1');
    expect(provider.calls).toBe(1);
    expect(cache.getStats().mode).toBe('LIVE_CAPPED');
  });

  it('opts.disabled=true takes precedence over env var not set', async () => {
    const provider = makeProvider();
    const cache = createBubbleMapsCachedProvider(provider, {
      cachePath: makeCachePath(),
      disabled: true,
    });
    await cache.fetchClusterRisk('mint1');
    expect(provider.calls).toBe(0);
    expect(cache.getStats().mode).toBe('DISABLED');
  });

  it('disabled env var uses cached result without calling provider', async () => {
    process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'] = '1';
    const cachePath = makeCachePath();
    writeCacheEntry(cachePath, 'mint-cached');
    const provider = makeProvider();
    const cache = createBubbleMapsCachedProvider(provider, { cachePath });
    const result = await cache.fetchClusterRisk('mint-cached');
    expect(result.clusterRisk).toBe('CLEAN');
    expect(provider.calls).toBe(0);
  });
});

// ── mode field in stats ────────────────────────────────────────────────────────

describe('getStats mode field', () => {
  it('mode=LIVE_CAPPED when not disabled and cap > 0', () => {
    const cache = new BubbleMapsCache(
      makeProvider(), makeCachePath(), 20, BUBBLEMAPS_CACHE_TTL_MS,
    );
    expect(cache.getStats().mode).toBe('LIVE_CAPPED');
  });

  it('mode=CACHE_ONLY when cap=0 and not disabled', () => {
    const cache = new BubbleMapsCache(
      makeProvider(), makeCachePath(), 0, BUBBLEMAPS_CACHE_TTL_MS,
    );
    expect(cache.getStats().mode).toBe('CACHE_ONLY');
  });

  it('mode=DISABLED when disabled=true regardless of cap', () => {
    const cache = new BubbleMapsCache(
      makeProvider(), makeCachePath(), 0, BUBBLEMAPS_CACHE_TTL_MS,
      () => Date.now(), true,
    );
    expect(cache.getStats().mode).toBe('DISABLED');
  });
});

// ── API errors are swallowed even when not disabled ────────────────────────────

describe('API errors do not break learning loop', () => {
  it('provider that throws returns UNKNOWN result (not thrown)', async () => {
    const throwingProvider: ClusterRiskProvider = {
      name: 'throwing-provider',
      async fetchClusterRisk() {
        throw new Error('subscription canceled');
      },
    };
    const cache = new BubbleMapsCache(
      throwingProvider, makeCachePath(), 20, BUBBLEMAPS_CACHE_TTL_MS,
    );
    const result = await cache.fetchClusterRisk('mint1');
    expect(result.clusterRisk).toBe('UNKNOWN');
    expect(result.clusterFetchError).toContain('subscription canceled');
  });

  it('error result not written to disk', async () => {
    const cachePath = makeCachePath();
    const throwingProvider: ClusterRiskProvider = {
      name: 'throwing-provider',
      async fetchClusterRisk() { throw new Error('auth failed'); },
    };
    const cache = new BubbleMapsCache(
      throwingProvider, cachePath, 20, BUBBLEMAPS_CACHE_TTL_MS,
    );
    await cache.fetchClusterRisk('mint1');
    expect(fs.existsSync(cachePath)).toBe(false);
  });
});
