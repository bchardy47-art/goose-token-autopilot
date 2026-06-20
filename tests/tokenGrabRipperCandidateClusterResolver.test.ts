import { describe, it, expect } from 'vitest';
import {
  resolveCandidateClusterForLiveRisk,
  type ResolverContext,
  type CacheRecord,
  type MemoryRecord,
  type RawCandidate,
} from '../src/token-grab/ripperCandidateClusterResolver';

const NOW = new Date('2026-06-20T12:00:00.000Z');
const FRESH = '2026-06-20T11:00:00.000Z';     // 1h ago
const STALE = '2026-06-18T01:00:00.000Z';     // ~59h ago

function ctx(over: Partial<ResolverContext> = {}): ResolverContext {
  return { now: NOW, cacheLookup: () => null, memoryLookup: () => null, ...over };
}
function cand(over: Partial<RawCandidate> = {}): RawCandidate {
  return { contract: 'MINT1', clusterRisk: 'UNKNOWN', ...over };
}
function cache(over: Partial<CacheRecord>): CacheRecord {
  return { clusterRisk: 'CLEAN', provider: 'bubblemaps', confidence: 'HIGH', cachedAt: FRESH, ...over };
}
function mem(over: Partial<MemoryRecord>): MemoryRecord {
  return { clusterRisk: 'CLEAN', observedAt: FRESH, ...over };
}

describe('Candidate Cluster Resolver v1', () => {
  it('cache CLEAN enriches raw UNKNOWN when fresh', () => {
    const r = resolveCandidateClusterForLiveRisk(cand(), ctx({ cacheLookup: () => cache({}) }));
    expect(r.clusterRisk).toBe('CLEAN');
    expect(r.sourceUsed).toBe('cache');
    expect(r.isFresh).toBe(true);
  });

  it('cache RISKY enriches raw UNKNOWN and blocks (risk preserved)', () => {
    const r = resolveCandidateClusterForLiveRisk(cand(), ctx({ cacheLookup: () => cache({ clusterRisk: 'RISKY' }) }));
    expect(r.clusterRisk).toBe('RISKY');
    expect(r.sourceUsed).toBe('cache');
  });

  it('stale CLEAN does not enrich (UNKNOWN stays UNKNOWN)', () => {
    const r = resolveCandidateClusterForLiveRisk(cand(), ctx({ cacheLookup: () => cache({ cachedAt: STALE }) }));
    expect(r.clusterRisk).toBe('UNKNOWN');
    expect(r.sourceUsed).toBe('unresolved');
    expect(r.explanation).toMatch(/STALE/i);
  });

  it('low/UNKNOWN-confidence cache CLEAN does not clean', () => {
    const r = resolveCandidateClusterForLiveRisk(cand(), ctx({ cacheLookup: () => cache({ confidence: 'UNKNOWN' }) }));
    expect(r.clusterRisk).toBe('UNKNOWN');
    expect(r.sourceUsed).toBe('unresolved');
  });

  it('memory CLEAN enriches raw UNKNOWN when fresh', () => {
    const r = resolveCandidateClusterForLiveRisk(cand(), ctx({ memoryLookup: () => mem({}) }));
    expect(r.clusterRisk).toBe('CLEAN');
    expect(r.sourceUsed).toBe('memory');
  });

  it('stale memory CLEAN does not enrich', () => {
    const r = resolveCandidateClusterForLiveRisk(cand(), ctx({ memoryLookup: () => mem({ observedAt: STALE }) }));
    expect(r.clusterRisk).toBe('UNKNOWN');
    expect(r.sourceUsed).toBe('unresolved');
  });

  it('UNKNOWN remains UNKNOWN when no source available', () => {
    const r = resolveCandidateClusterForLiveRisk(cand(), ctx());
    expect(r.clusterRisk).toBe('UNKNOWN');
    expect(r.sourceUsed).toBe('unresolved');
    expect(r.isFresh).toBe(false);
  });

  it('raw RISKY is preserved over any cache CLEAN (never hide risk)', () => {
    const r = resolveCandidateClusterForLiveRisk(cand({ clusterRisk: 'RISKY' }), ctx({ cacheLookup: () => cache({ clusterRisk: 'CLEAN' }) }));
    expect(r.clusterRisk).toBe('RISKY');
    expect(r.sourceUsed).toBe('cycle');
  });

  it('raw already CLEAN uses cycle source', () => {
    const r = resolveCandidateClusterForLiveRisk(cand({ clusterRisk: 'CLEAN', clusterProvider: 'bubblemaps' }), ctx());
    expect(r.clusterRisk).toBe('CLEAN');
    expect(r.sourceUsed).toBe('cycle');
  });

  it('MISSING is treated as UNKNOWN, never CLEAN', () => {
    const r = resolveCandidateClusterForLiveRisk(cand({ clusterRisk: null }), ctx());
    expect(r.clusterRisk).toBe('UNKNOWN');
  });

  it('cache RISKY beats memory CLEAN (risk wins)', () => {
    const r = resolveCandidateClusterForLiveRisk(cand(), ctx({
      cacheLookup: () => cache({ clusterRisk: 'RISKY' }),
      memoryLookup: () => mem({ clusterRisk: 'CLEAN' }),
    }));
    expect(r.clusterRisk).toBe('RISKY');
  });

  it('sourceUsed is correct for cache vs memory precedence (fresh cache wins over memory)', () => {
    const r = resolveCandidateClusterForLiveRisk(cand(), ctx({
      cacheLookup: () => cache({ clusterRisk: 'WATCH' }),
      memoryLookup: () => mem({ clusterRisk: 'CLEAN' }),
    }));
    expect(r.clusterRisk).toBe('WATCH');
    expect(r.sourceUsed).toBe('cache');
  });
});
