// DO_NOT_ENABLE_REAL_TRADING  UNKNOWN_NEVER_BECOMES_CLEAN=true  noApiCalls=true
//
// Candidate Cluster Resolver v1 — produces the best EXPLAINABLE cluster view of a
// candidate for the live risk gate, by combining the raw cycle row with the BubbleMaps
// cache and learning memory. It makes NO API calls and NEVER turns UNKNOWN into CLEAN.
//
// Precedence (safety-first):
//   1. A known RISKY from any source beats UNKNOWN (risk is never hidden).
//   2. A known CLEAN/WATCH enriches a raw UNKNOWN ONLY when it is FRESH and provider
//      confidence is valid (stale cache can never silently "clean" a candidate).
//   3. Otherwise UNKNOWN stays UNKNOWN.
// Cache may enrich only when fresh + provider result is known. Memory may enrich only
// when the contract matches and its timestamp is valid. Every enrichment is explained.

import * as fs from 'fs';

import { BUBBLEMAPS_CACHE_TTL_MS, DEFAULT_CACHE_PATH } from './bubbleMapsCache';

const DEFAULT_MEMORY_PATH = 'data/token-grab/ripper/learning-memory.jsonl';
// Memory cluster fields are considered usable only within this window (kept conservative).
const DEFAULT_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

export type ClusterCat = 'CLEAN' | 'WATCH' | 'RISKY' | 'UNKNOWN' | 'MISSING';
export type ResolverSource = 'cycle' | 'cache' | 'memory' | 'unresolved';

export interface RawCandidate {
  contract:          string;
  clusterRisk?:      string | null;
  clusterProvider?:  string | null;
  clusterConfidence?: string | null;
  clusterUnknownReason?: string | null;
  clusterFetchError?: string | null;
}

export interface CacheRecord { clusterRisk: ClusterCat; provider: string | null; confidence: string | null; cachedAt: string; }
export interface MemoryRecord { clusterRisk: ClusterCat; observedAt: string | null; }

export interface ResolverContext {
  now:           Date;
  cacheTtlMs?:   number;
  memoryTtlMs?:  number;
  // Injected lookups (pure; default loaders read the real files once and index them).
  cacheLookup?:  (contract: string) => CacheRecord | null;
  memoryLookup?: (contract: string) => MemoryRecord | null;
}

export interface ResolvedCluster {
  clusterRisk:          ClusterCat;
  clusterProvider:      string | null;
  clusterConfidence:    string | null;
  clusterUnknownReason: string | null;
  clusterFetchError:    string | null;
  sourceUsed:           ResolverSource;
  isFresh:              boolean;
  explanation:          string;
}

function normCluster(v: unknown): ClusterCat {
  if (typeof v !== 'string') return 'MISSING';
  const u = v.trim().toUpperCase();
  if (u === 'CLEAN' || u === 'WATCH' || u === 'RISKY' || u === 'UNKNOWN') return u;
  return 'MISSING';
}
function isKnown(c: ClusterCat): boolean { return c === 'CLEAN' || c === 'WATCH' || c === 'RISKY'; }

function freshWithin(iso: string | null | undefined, now: Date, ttlMs: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= ttlMs && now.getTime() - t >= -60_000;  // allow slight clock skew
}

// Confidence must be valid (not UNKNOWN/empty) for a cache CLEAN to enrich.
function validConfidence(conf: string | null | undefined): boolean {
  if (!conf) return true;   // absence is tolerated; only an explicit UNKNOWN/LOW blocks "clean"
  const u = conf.trim().toUpperCase();
  return u === 'HIGH' || u === 'MEDIUM';
}

// ── Core resolver (pure) ──────────────────────────────────────────────────────────

export function resolveCandidateClusterForLiveRisk(
  candidate: RawCandidate,
  ctx: ResolverContext,
): ResolvedCluster {
  const cacheTtl = ctx.cacheTtlMs ?? BUBBLEMAPS_CACHE_TTL_MS;
  const memTtl   = ctx.memoryTtlMs ?? DEFAULT_MEMORY_TTL_MS;
  const rawCluster = normCluster(candidate.clusterRisk);

  const cache = ctx.cacheLookup?.(candidate.contract) ?? null;
  const mem   = ctx.memoryLookup?.(candidate.contract) ?? null;
  const cacheFresh = cache != null && freshWithin(cache.cachedAt, ctx.now, cacheTtl);
  const memFresh   = mem != null && freshWithin(mem.observedAt, ctx.now, memTtl);

  // ── 1) Known RISKY from ANY source beats UNKNOWN (never hide risk). ──
  if (rawCluster === 'RISKY') {
    return mk('RISKY', candidate.clusterProvider ?? 'cycle', candidate.clusterConfidence ?? null, candidate, 'cycle', true,
      'Raw cycle row already marks RISKY — risk preserved.');
  }
  if (cache && cache.clusterRisk === 'RISKY') {
    return mk('RISKY', cache.provider ?? 'bubblemaps-cache', cache.confidence, candidate, 'cache', cacheFresh,
      `Cache marks RISKY (fresh=${cacheFresh}) — risk preserved even if cycle said UNKNOWN.`);
  }
  if (mem && mem.clusterRisk === 'RISKY') {
    return mk('RISKY', 'memory', null, candidate, 'memory', memFresh,
      'Learning memory marks RISKY — risk preserved.');
  }

  // ── 2) Raw cycle already known (CLEAN/WATCH) → use it. ──
  if (isKnown(rawCluster)) {
    return mk(rawCluster, candidate.clusterProvider ?? 'cycle', candidate.clusterConfidence ?? null, candidate, 'cycle', true,
      `Raw cycle row is already known (${rawCluster}).`);
  }

  // From here, raw is UNKNOWN/MISSING. We may enrich ONLY with a fresh, known, valid source.
  // ── 2a) Fresh cache CLEAN/WATCH with valid confidence enriches. ──
  if (cache && (cache.clusterRisk === 'CLEAN' || cache.clusterRisk === 'WATCH')) {
    if (cacheFresh && validConfidence(cache.confidence)) {
      return mk(cache.clusterRisk, cache.provider ?? 'bubblemaps-cache', cache.confidence, candidate, 'cache', true,
        `Enriched raw UNKNOWN from FRESH cache ${cache.clusterRisk} (confidence=${cache.confidence ?? 'n/a'}).`);
    }
    // Stale or low-confidence cache cannot silently clean a candidate.
    return unresolved(candidate, rawCluster,
      cacheFresh ? 'Cache result has invalid/low confidence — not used to clean.' :
                   'Cache result is STALE — cannot clean a candidate. UNKNOWN stays UNKNOWN.');
  }

  // ── 2b) Fresh memory CLEAN/WATCH enriches (contract matched, timestamp valid). ──
  if (mem && (mem.clusterRisk === 'CLEAN' || mem.clusterRisk === 'WATCH')) {
    if (memFresh) {
      return mk(mem.clusterRisk, 'memory', null, candidate, 'memory', true,
        `Enriched raw UNKNOWN from FRESH learning memory ${mem.clusterRisk}.`);
    }
    return unresolved(candidate, rawCluster, 'Memory cluster is stale — not used to clean.');
  }

  // ── 3) Nothing fresh+known → UNKNOWN remains. ──
  return unresolved(candidate, rawCluster, 'No fresh, provider-known cluster available — UNKNOWN remains (never treated as CLEAN).');
}

function mk(
  risk: ClusterCat, provider: string | null, confidence: string | null,
  c: RawCandidate, source: ResolverSource, fresh: boolean, explanation: string,
): ResolvedCluster {
  return {
    clusterRisk: risk, clusterProvider: provider, clusterConfidence: confidence,
    clusterUnknownReason: risk === 'UNKNOWN' ? (c.clusterUnknownReason ?? null) : null,
    clusterFetchError: c.clusterFetchError ?? null,
    sourceUsed: source, isFresh: fresh, explanation,
  };
}
function unresolved(c: RawCandidate, raw: ClusterCat, explanation: string): ResolvedCluster {
  return {
    clusterRisk: raw === 'MISSING' ? 'UNKNOWN' : raw,   // MISSING is treated as UNKNOWN (never CLEAN)
    clusterProvider: c.clusterProvider ?? null,
    clusterConfidence: c.clusterConfidence ?? null,
    clusterUnknownReason: c.clusterUnknownReason ?? null,
    clusterFetchError: c.clusterFetchError ?? null,
    sourceUsed: 'unresolved', isFresh: false, explanation,
  };
}

// ── Default file-backed lookups (read once, index in memory) ──────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

export function buildCacheLookup(cachePath: string = DEFAULT_CACHE_PATH): (contract: string) => CacheRecord | null {
  interface Row { contract?: string; cachedAt?: string; result?: { clusterRisk?: string; clusterProvider?: string; clusterConfidence?: string } }
  const idx = new Map<string, CacheRecord>();
  for (const r of readJsonl<Row>(cachePath)) {
    if (!r.contract) continue;
    idx.set(r.contract, {   // last-write-wins
      clusterRisk: normCluster(r.result?.clusterRisk),
      provider: r.result?.clusterProvider ?? null,
      confidence: r.result?.clusterConfidence ?? null,
      cachedAt: r.cachedAt ?? '',
    });
  }
  return (contract: string) => idx.get(contract) ?? null;
}

export function buildMemoryLookup(memoryPath: string = DEFAULT_MEMORY_PATH): (contract: string) => MemoryRecord | null {
  interface Row { contract?: string; clusterRisk?: string; observedAt?: string | null; capturedAt?: string }
  const idx = new Map<string, MemoryRecord>();
  for (const r of readJsonl<Row>(memoryPath)) {
    if (!r.contract) continue;
    const risk = normCluster(r.clusterRisk);
    // Keep only the latest known cluster per contract.
    const observedAt = r.observedAt ?? r.capturedAt ?? null;
    const existing = idx.get(r.contract);
    if (!existing || (observedAt && existing.observedAt && observedAt > existing.observedAt) || !existing.observedAt) {
      idx.set(r.contract, { clusterRisk: risk, observedAt });
    }
  }
  return (contract: string) => idx.get(contract) ?? null;
}
