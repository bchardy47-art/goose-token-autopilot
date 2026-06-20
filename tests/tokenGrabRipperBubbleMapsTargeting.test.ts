import { describe, it, expect } from 'vitest';
import {
  callPriorityTier,
  prioritizeClusterCandidates,
  allocateBubbleMapsCalls,
  type TargetingFixture,
} from '../src/token-grab/ripperBubbleMapsTargeting';

function f(over: Partial<TargetingFixture>): TargetingFixture {
  return { contract: 'C', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: null, clusterRisk: 'UNKNOWN', ...over };
}

describe('BubbleMaps Targeting v1 — priority tiers', () => {
  const top = new Set(['TOP']);

  it('top live-runner approved+M5 UNKNOWN is tier 1 (first)', () => {
    expect(callPriorityTier(f({ contract: 'TOP', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }), top)).toBe(1);
  });
  it('approved+M5 UNKNOWN (non-top) is tier 2', () => {
    expect(callPriorityTier(f({ contract: 'X', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }), top)).toBe(2);
  });
  it('top approved (no M5) is tier 3, plain approved is tier 4', () => {
    expect(callPriorityTier(f({ contract: 'TOP', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: null }), top)).toBe(3);
    expect(callPriorityTier(f({ contract: 'X', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: null }), top)).toBe(4);
  });
  it('rejected+M5 is tier 5, rejected is tier 6', () => {
    expect(callPriorityTier(f({ contract: 'X', buyGateDecision: 'BUY_REJECTED', entryMomentumPct: 10 }), top)).toBe(5);
    expect(callPriorityTier(f({ contract: 'X', buyGateDecision: 'BUY_REJECTED', entryMomentumPct: null }), top)).toBe(6);
  });
  it('known (non-UNKNOWN) cluster is tier 99 (no call needed)', () => {
    expect(callPriorityTier(f({ contract: 'X', clusterRisk: 'CLEAN' }), top)).toBe(99);
    expect(callPriorityTier(f({ contract: 'X', clusterRisk: 'WATCH' }), top)).toBe(99);
  });

  it('approved+M5 beats rejected in ordering', () => {
    const fixtures = [
      f({ contract: 'REJ', buyGateDecision: 'BUY_REJECTED', entryMomentumPct: 10 }),
      f({ contract: 'APP', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }),
    ];
    const ordered = prioritizeClusterCandidates(fixtures, new Set());
    expect(ordered[0].contract).toBe('APP');
    expect(ordered[1].contract).toBe('REJ');
  });

  it('top live-runner approved+M5 comes before non-top approved+M5', () => {
    const fixtures = [
      f({ contract: 'X', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }),
      f({ contract: 'TOP', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }),
    ];
    const ordered = prioritizeClusterCandidates(fixtures, top);
    expect(ordered[0].contract).toBe('TOP');
  });
});

describe('BubbleMaps Targeting v1 — allocation', () => {
  const top = new Set(['TOP']);

  it('spends the capped budget on highest-priority UNKNOWN first', () => {
    const fixtures = [
      f({ contract: 'REJ1', buyGateDecision: 'BUY_REJECTED', entryMomentumPct: null }),   // tier 6
      f({ contract: 'TOP',  buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }), // tier 1
      f({ contract: 'APP',  buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }), // tier 2
    ];
    const r = allocateBubbleMapsCalls(fixtures, { cap: 2, topLiveRunnerContracts: top });
    const selected = r.allocations.filter(a => a.bubbleMapsSelectedForCall).map(a => a.contract);
    expect(selected).toEqual(['TOP', 'APP']);   // tier 1 then tier 2; rejected deferred
    expect(r.liveCallsPlanned).toBe(2);
  });

  it('cache hit does not spend a call', () => {
    const fixtures = [
      f({ contract: 'CACHED', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }),
      f({ contract: 'FRESH',  buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }),
    ];
    const r = allocateBubbleMapsCalls(fixtures, { cap: 5, freshCacheContracts: new Set(['CACHED']) });
    const cached = r.allocations.find(a => a.contract === 'CACHED')!;
    expect(cached.bubbleMapsCacheHit).toBe(true);
    expect(cached.bubbleMapsLiveCallUsed).toBe(false);
    expect(cached.bubbleMapsCallSkippedReason).toBe('CACHE_HIT_FRESH');
    expect(r.cacheHits).toBe(1);
    expect(r.liveCallsPlanned).toBe(1);   // only FRESH spent a call
  });

  it('records cap-skipped reason', () => {
    const fixtures = [
      f({ contract: 'A', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }),
      f({ contract: 'B', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }),
    ];
    const r = allocateBubbleMapsCalls(fixtures, { cap: 1 });
    expect(r.capSkipped).toBe(1);
    const skipped = r.allocations.find(a => a.bubbleMapsCallSkippedReason === 'CAP_REACHED');
    expect(skipped).toBeTruthy();
  });

  it('does not call duplicate contracts twice', () => {
    const fixtures = [
      f({ contract: 'DUP', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }),
      f({ contract: 'DUP', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 }),
    ];
    const r = allocateBubbleMapsCalls(fixtures, { cap: 5 });
    expect(r.liveCallsPlanned).toBe(1);
    expect(r.duplicates).toBe(1);
    expect(r.allocations.some(a => a.bubbleMapsCallSkippedReason === 'DUPLICATE_IN_RUN')).toBe(true);
  });

  it('provider UNKNOWN stays UNKNOWN — known rows are not re-called (no re-clean)', () => {
    const fixtures = [f({ contract: 'KNOWN', clusterRisk: 'CLEAN', buyGateDecision: 'BUY_APPROVED_PAPER' })];
    const r = allocateBubbleMapsCalls(fixtures, { cap: 5 });
    const a = r.allocations.find(x => x.contract === 'KNOWN')!;
    expect(a.bubbleMapsSelectedForCall).toBe(false);
    expect(a.bubbleMapsCallSkippedReason).toBe('ALREADY_KNOWN');
  });

  it('no policy/gate fields are altered (pure allocation only)', () => {
    const fixtures = [f({ contract: 'A', buyGateDecision: 'BUY_APPROVED_PAPER', entryMomentumPct: 10 })];
    const snapshot = JSON.stringify(fixtures);
    allocateBubbleMapsCalls(fixtures, { cap: 5 });
    expect(JSON.stringify(fixtures)).toBe(snapshot);   // inputs untouched
  });
});
