// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  paperOnly=true  readOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE
//
// Persistent per-contract BubbleMaps cache with per-run call cap and optional disable mode.
// Wraps any ClusterRiskProvider; does NOT change scoring or gate logic.
// Only controls IF and WHEN the API is called — never the result interpretation.

import * as fs from 'fs';
import * as path from 'path';
import type {
  ClusterRiskProvider,
  ClusterRiskResult,
  ClusterRiskCacheStats,
} from './clusterRiskProvider';

// ── Constants ─────────────────────────────────────────────────────────────────

export const BUBBLEMAPS_CACHE_TTL_MS              = 24 * 60 * 60 * 1000;  // 24 h
export const BUBBLEMAPS_MAX_CALLS_PER_RUN_DEFAULT = 20;
export const DEFAULT_CACHE_PATH =
  'data/token-grab/ripper/bubblemaps-cache.jsonl';

// ── Cache entry ───────────────────────────────────────────────────────────────

export interface BubbleMapsCacheEntry {
  contract: string;
  cachedAt: string;           // ISO — when this result was fetched
  result:   ClusterRiskResult;
}

// ── Cache provider ────────────────────────────────────────────────────────────

export class BubbleMapsCache implements ClusterRiskProvider {
  readonly name = 'bubblemaps-cached';

  private readonly memCache = new Map<string, BubbleMapsCacheEntry>();
  private liveCallsThisRun  = 0;
  private cacheHitsThisRun  = 0;
  private skippedThisRun    = 0;

  constructor(
    private readonly provider:        ClusterRiskProvider,
    private readonly cachePath:       string,
    private readonly maxCallsPerRun:  number,
    private readonly ttlMs:           number,
    private readonly nowMs:           () => number = () => Date.now(),
    private readonly disabled:        boolean = false,
  ) {
    this.loadFromDisk();
  }

  async fetchClusterRisk(tokenMint: string): Promise<ClusterRiskResult> {
    // 1. Check in-memory cache (loaded from disk + entries written this run)
    const cached = this.memCache.get(tokenMint);
    if (cached && !this.isExpired(cached)) {
      this.cacheHitsThisRun++;
      return { ...cached.result };
    }

    // 2. Disabled mode — no live calls; return UNKNOWN if no cache hit
    if (this.disabled) {
      this.skippedThisRun++;
      return {
        clusterRisk:       'UNKNOWN',
        clusterProvider:   'bubblemaps-cached',
        clusterCheckedAt:  new Date(this.nowMs()).toISOString(),
        clusterConfidence: 'UNKNOWN',
        clusterNotes: [
          'BubbleMaps disabled (TOKEN_GRAB_BUBBLEMAPS_DISABLED=1)',
          'No live calls will be made; set TOKEN_GRAB_BUBBLEMAPS_DISABLED=0 to re-enable',
        ],
        unknownReason: 'DISABLED',
      };
    }

    // 3. Per-run cap check — degrade gracefully, never block the cycle
    if (this.liveCallsThisRun >= this.maxCallsPerRun) {
      this.skippedThisRun++;
      return {
        clusterRisk:       'UNKNOWN',
        clusterProvider:   'bubblemaps-cached',
        clusterCheckedAt:  new Date(this.nowMs()).toISOString(),
        clusterConfidence: 'UNKNOWN',
        clusterNotes: [
          `BubbleMaps call skipped: per-run cap of ${this.maxCallsPerRun} reached`,
          `Set TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN to raise cap (current: ${this.maxCallsPerRun})`,
        ],
        unknownReason: 'CAP_REACHED',
      };
    }

    // 4. Live API call through wrapped provider
    this.liveCallsThisRun++;
    let result: ClusterRiskResult;
    try {
      result = await this.provider.fetchClusterRisk(tokenMint);
    } catch (err) {
      // Unexpected provider throw — degrade without crashing
      result = {
        clusterRisk:       'UNKNOWN',
        clusterProvider:   this.provider.name,
        clusterCheckedAt:  new Date(this.nowMs()).toISOString(),
        clusterConfidence: 'UNKNOWN',
        clusterNotes:      ['CLUSTER_PROVIDER_UNAVAILABLE — provider threw unexpectedly'],
        clusterFetchError: err instanceof Error ? err.message : 'unexpected provider error',
      };
    }

    // 5. Persist only clean results — don't cache transient errors (429, 401, network)
    if (!result.clusterFetchError) {
      const entry: BubbleMapsCacheEntry = {
        contract: tokenMint,
        cachedAt: new Date(this.nowMs()).toISOString(),
        result,
      };
      this.memCache.set(tokenMint, entry);
      this.appendToDisk(entry);
    }

    return result;
  }

  getStats(): ClusterRiskCacheStats {
    const mode: ClusterRiskCacheStats['mode'] =
      this.disabled             ? 'DISABLED'   :
      this.maxCallsPerRun === 0 ? 'CACHE_ONLY' : 'LIVE_CAPPED';
    return {
      liveCallsThisRun: this.liveCallsThisRun,
      cacheHitsThisRun: this.cacheHitsThisRun,
      skippedDueToCap:  this.skippedThisRun,
      capLimit:         this.maxCallsPerRun,
      mode,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private loadFromDisk(): void {
    if (!fs.existsSync(this.cachePath)) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.cachePath, 'utf-8');
    } catch {
      return; // non-fatal — treat as empty cache
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as BubbleMapsCacheEntry;
        if (
          typeof entry.contract === 'string' && entry.contract.length > 0 &&
          typeof entry.cachedAt === 'string' &&
          entry.result != null
        ) {
          // Last-write-wins for duplicate contracts (JSONL append order)
          this.memCache.set(entry.contract, entry);
        }
      } catch { /* skip malformed lines */ }
    }
  }

  private appendToDisk(entry: BubbleMapsCacheEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.appendFileSync(this.cachePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch { /* non-fatal — live results still flow through even if disk write fails */ }
  }

  private isExpired(entry: BubbleMapsCacheEntry): boolean {
    const cachedAtMs = new Date(entry.cachedAt).getTime();
    if (Number.isNaN(cachedAtMs)) return true;
    return this.nowMs() - cachedAtMs > this.ttlMs;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createBubbleMapsCachedProvider(
  provider: ClusterRiskProvider,
  opts: {
    cachePath?:      string;
    maxCallsPerRun?: number;
    ttlMs?:          number;
    nowMs?:          () => number;
    disabled?:       boolean;
  } = {},
): BubbleMapsCache {
  const disabledEnv = process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'];
  const disabled = opts.disabled ?? (disabledEnv === '1' || disabledEnv?.toLowerCase() === 'true');

  const rawEnv = process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
  const envCap = rawEnv != null && rawEnv.trim() !== '' ? Number(rawEnv) : NaN;
  const maxCallsPerRun =
    opts.maxCallsPerRun ??
    (Number.isFinite(envCap) && envCap >= 0 ? Math.floor(envCap) : BUBBLEMAPS_MAX_CALLS_PER_RUN_DEFAULT);

  return new BubbleMapsCache(
    provider,
    opts.cachePath ?? DEFAULT_CACHE_PATH,
    maxCallsPerRun,
    opts.ttlMs     ?? BUBBLEMAPS_CACHE_TTL_MS,
    opts.nowMs,
    disabled,
  );
}
