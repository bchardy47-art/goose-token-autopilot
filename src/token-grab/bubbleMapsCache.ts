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

// ── Rate-limit cooldown ─────────────────────────────────────────────────────────
//
// When a live BubbleMaps call returns 429 RATE_LIMITED, we persist a small cooldown
// marker so that LATER runs do not immediately hammer the API again. While the marker
// is unexpired, live calls are skipped (UNKNOWN, never CLEAN). This is the cross-run
// companion to the in-run stop-on-first-429 guard.

export const BUBBLEMAPS_RATE_LIMIT_COOLDOWN_MINUTES_DEFAULT = 60;          // conservative default
export const BUBBLEMAPS_RATE_LIMIT_COOLDOWN_MS_DEFAULT =
  BUBBLEMAPS_RATE_LIMIT_COOLDOWN_MINUTES_DEFAULT * 60 * 1000;
export const BUBBLEMAPS_COOLDOWN_FILENAME = 'bubblemaps-rate-limit-cooldown.json';
export const DEFAULT_COOLDOWN_PATH =
  'data/token-grab/ripper/bubblemaps-rate-limit-cooldown.json';

/** Cooldown marker persisted to disk after a 429 RATE_LIMITED live call. */
export interface BubbleMapsCooldownFile {
  createdAt:     string;            // ISO — when the cooldown was written
  expiresAt:     string;            // ISO — live calls resume once now() passes this
  reason:        'RATE_LIMITED';
  httpStatus:    number;            // 429
  lastContract?: string;            // the contract whose call triggered the 429
  note:          string;
}

/** Default cooldown file path lives alongside the cache file. */
export function deriveCooldownPath(cachePath: string): string {
  return path.join(path.dirname(cachePath), BUBBLEMAPS_COOLDOWN_FILENAME);
}

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
  private liveCallsThisRun   = 0;
  private cacheHitsThisRun   = 0;
  private skippedThisRun     = 0;
  private rateLimitedThisRun = false;

  private readonly cooldownPath: string;

  constructor(
    private readonly provider:        ClusterRiskProvider,
    private readonly cachePath:       string,
    private readonly maxCallsPerRun:  number,
    private readonly ttlMs:           number,
    private readonly nowMs:           () => number = () => Date.now(),
    private readonly disabled:        boolean = false,
    private readonly cooldownMs:      number = BUBBLEMAPS_RATE_LIMIT_COOLDOWN_MS_DEFAULT,
    cooldownPath?:                    string,
  ) {
    this.cooldownPath = cooldownPath ?? deriveCooldownPath(cachePath);
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

    // 3.5. Rate-limit guard: if a previous live call this run returned RATE_LIMITED,
    // skip further calls to avoid wasting cap slots against an already-exhausted quota.
    // The first RATE_LIMITED result is cached (step 5 below); these subsequent skips are not.
    if (this.rateLimitedThisRun) {
      this.skippedThisRun++;
      return {
        clusterRisk:       'UNKNOWN',
        clusterProvider:   'bubblemaps-cached',
        clusterCheckedAt:  new Date(this.nowMs()).toISOString(),
        clusterConfidence: 'UNKNOWN',
        clusterNotes: [
          'BubbleMaps call skipped: rate limit hit earlier this run',
          'The API returned 429 on a previous call — further calls skipped until next run',
        ],
        unknownReason: 'CAP_REACHED',
      };
    }

    // 3.6. Cross-run rate-limit cooldown: a PREVIOUS run hit 429 and wrote a cooldown
    // marker. While that marker is unexpired, skip live calls entirely so we don't hammer
    // an already-rate-limited API on every fresh run. UNKNOWN, never CLEAN; this synthetic
    // skip is NOT written to the cache. An expired marker is ignored (a call is allowed).
    const cooldown = this.readActiveCooldown();
    if (cooldown) {
      this.skippedThisRun++;
      return {
        clusterRisk:       'UNKNOWN',
        clusterProvider:   'bubblemaps-cached',
        clusterCheckedAt:  new Date(this.nowMs()).toISOString(),
        clusterConfidence: 'UNKNOWN',
        clusterNotes: [
          'BubbleMaps call skipped: rate-limit cooldown active',
          `Cooldown active until ${cooldown.expiresAt} (set after a prior 429)`,
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
        unknownReason:     'PROVIDER_ERROR',
      };
    }

    // If this call was rate-limited, set the in-run flag (skip further live calls this run)
    // AND persist a cross-run cooldown marker so later runs back off too.
    if (result.unknownReason === 'RATE_LIMITED') {
      this.rateLimitedThisRun = true;
      this.writeCooldown(tokenMint, result.httpStatus);
    }

    // 5. Persist all live-call results, including UNKNOWN with clusterFetchError.
    // DISABLED (step 2) and CAP_REACHED (step 3) return early above and never reach here.
    // Caching error-UNKNOWN results is intentional: diagnostics can show WHY calls are failing
    // (AUTH_ERROR, RATE_LIMITED, NO_MAP_YET, etc.), and the 24h TTL ensures eventual retry.
    // clusterFetchError is already API-key-redacted by the BubbleMaps HTTP provider.
    const entry: BubbleMapsCacheEntry = {
      contract: tokenMint,
      cachedAt: new Date(this.nowMs()).toISOString(),
      result,
    };
    this.memCache.set(tokenMint, entry);
    this.appendToDisk(entry);

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

  /**
   * Returns the cooldown marker only if it exists and has not yet expired.
   * An expired (or malformed / unreadable) marker returns null → a live call is allowed.
   */
  private readActiveCooldown(): BubbleMapsCooldownFile | null {
    if (this.cooldownMs <= 0) return null;        // cooldown disabled
    if (!fs.existsSync(this.cooldownPath)) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(this.cooldownPath, 'utf-8');
    } catch {
      return null;                                 // unreadable → treat as no cooldown
    }
    let parsed: BubbleMapsCooldownFile;
    try {
      parsed = JSON.parse(raw) as BubbleMapsCooldownFile;
    } catch {
      return null;                                 // malformed → ignore
    }
    const expiresMs = new Date(parsed.expiresAt).getTime();
    if (Number.isNaN(expiresMs)) return null;
    return this.nowMs() < expiresMs ? parsed : null; // future → active; past → expired/ignore
  }

  /** Persist a cooldown marker after a 429 RATE_LIMITED live call. Non-fatal on write error. */
  private writeCooldown(contract: string, httpStatus?: number): void {
    if (this.cooldownMs <= 0) return;
    const now = this.nowMs();
    const minutes = Math.round(this.cooldownMs / 60_000);
    const marker: BubbleMapsCooldownFile = {
      createdAt:    new Date(now).toISOString(),
      expiresAt:    new Date(now + this.cooldownMs).toISOString(),
      reason:       'RATE_LIMITED',
      httpStatus:   httpStatus ?? 429,
      lastContract: contract,
      note: `BubbleMaps returned 429 RATE_LIMITED; live calls paused for ~${minutes} min until expiresAt. ` +
            'Override with TOKEN_GRAB_BUBBLEMAPS_RATE_LIMIT_COOLDOWN_MINUTES.',
    };
    try {
      fs.mkdirSync(path.dirname(this.cooldownPath), { recursive: true });
      fs.writeFileSync(this.cooldownPath, JSON.stringify(marker, null, 2) + '\n', 'utf-8');
    } catch { /* non-fatal — cooldown is best-effort */ }
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
    cooldownMs?:     number;
    cooldownPath?:   string;
  } = {},
): BubbleMapsCache {
  const disabledEnv = process.env['TOKEN_GRAB_BUBBLEMAPS_DISABLED'];
  const disabled = opts.disabled ?? (disabledEnv === '1' || disabledEnv?.toLowerCase() === 'true');

  const rawEnv = process.env['TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN'];
  const envCap = rawEnv != null && rawEnv.trim() !== '' ? Number(rawEnv) : NaN;
  const maxCallsPerRun =
    opts.maxCallsPerRun ??
    (Number.isFinite(envCap) && envCap >= 0 ? Math.floor(envCap) : BUBBLEMAPS_MAX_CALLS_PER_RUN_DEFAULT);

  // Cooldown minutes: opts override env override default. Negative/NaN falls back to default.
  const rawCooldownEnv = process.env['TOKEN_GRAB_BUBBLEMAPS_RATE_LIMIT_COOLDOWN_MINUTES'];
  const envCooldownMin =
    rawCooldownEnv != null && rawCooldownEnv.trim() !== '' ? Number(rawCooldownEnv) : NaN;
  const cooldownMs =
    opts.cooldownMs ??
    (Number.isFinite(envCooldownMin) && envCooldownMin >= 0
      ? Math.floor(envCooldownMin) * 60 * 1000
      : BUBBLEMAPS_RATE_LIMIT_COOLDOWN_MS_DEFAULT);

  return new BubbleMapsCache(
    provider,
    opts.cachePath ?? DEFAULT_CACHE_PATH,
    maxCallsPerRun,
    opts.ttlMs     ?? BUBBLEMAPS_CACHE_TTL_MS,
    opts.nowMs,
    disabled,
    cooldownMs,
    opts.cooldownPath,
  );
}
