// DO_NOT_ENABLE_REAL_TRADING  paperOnly=true  capRespected=true  cacheFirst=true
//
// BubbleMaps Targeting v1 — the REAL approved+M5+live-runner-first call-allocation lane.
// Given the candidate fixtures, the per-run cap, the cache contents, and the set of
// contracts the live runner cares about most, it decides WHICH contracts spend the
// limited BubbleMaps live-call budget, in this strict priority order:
//
//   1. top live-runner + BUY_APPROVED_PAPER + M5 present + UNKNOWN
//   2. BUY_APPROVED_PAPER + M5 present + UNKNOWN
//   3. top live-runner + BUY_APPROVED_PAPER + UNKNOWN
//   4. BUY_APPROVED_PAPER + UNKNOWN
//   5. BUY_REJECTED + M5 present + UNKNOWN
//   6. BUY_REJECTED + UNKNOWN
//
// Cache-first (a fresh cached contract never spends a call), cap-respecting, dedupe,
// UNKNOWN is never forced to CLEAN, no gate/policy change, no real trade. Pure logic.

export interface TargetingFixture {
  contract:         string | null;
  buyGateDecision?: string | null;
  entryDecision?:   string | null;
  entryMomentumPct?: number | null;
  clusterRisk?:     string | null;   // current clusterRisk (UNKNOWN = needs a call)
}

export type CallSkippedReason =
  | null
  | 'ALREADY_KNOWN'          // not UNKNOWN → no call needed
  | 'CACHE_HIT_FRESH'        // resolved from fresh cache → no live call
  | 'CAP_REACHED'            // cap exhausted before reaching this contract
  | 'DUPLICATE_IN_RUN'       // same contract already handled this run
  | 'NOT_A_CANDIDATE';       // not approved/rejected/UNKNOWN target

export interface CallAllocation {
  contract:                  string;
  bubbleMapsCallPriorityTier: number;       // 1..6, or 99 for non-targets
  bubbleMapsSelectedForCall: boolean;       // a live call would be spent on this
  bubbleMapsCacheHit:        boolean;
  bubbleMapsLiveCallUsed:    boolean;
  bubbleMapsCallSkippedReason: CallSkippedReason;
  bubbleMapsCallResult:      string | null; // filled after the call (UNKNOWN until known)
}

export interface AllocateOptions {
  cap:                  number;          // per-run live-call cap
  freshCacheContracts?: Set<string>;     // contracts with a FRESH known cache entry
  topLiveRunnerContracts?: Set<string>;  // contracts the live runner cares about most
}

export interface AllocationSummary {
  allocations:        CallAllocation[];
  liveCallsPlanned:   number;
  cacheHits:          number;
  capSkipped:         number;
  duplicates:         number;
  byTier:             Record<number, number>;
}

function hasM5(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function normCluster(v: unknown): string {
  if (typeof v !== 'string') return 'MISSING';
  const u = v.trim().toUpperCase();
  if (u === 'CLEAN' || u === 'WATCH' || u === 'RISKY' || u === 'UNKNOWN') return u;
  return 'MISSING';
}

function gateOf(f: TargetingFixture): string {
  // BUY_APPROVED_PAPER and READY_TO_SNIPE_PAPER both count as approved-lane candidates.
  const dec = f.buyGateDecision ?? f.entryDecision ?? '';
  if (dec === 'BUY_APPROVED_PAPER' || dec === 'READY_TO_SNIPE_PAPER') return 'BUY_APPROVED_PAPER';
  if (dec === 'BUY_REJECTED') return 'BUY_REJECTED';
  return 'OTHER';
}

// The priority tier (lower = sooner). Only UNKNOWN-cluster rows are call targets; known
// rows return 99 (no call needed). Exported for direct testing.
export function callPriorityTier(f: TargetingFixture, topLiveRunnerContracts: Set<string>): number {
  const cluster = normCluster(f.clusterRisk);
  if (cluster !== 'UNKNOWN') return 99;            // already known → no call (never re-clean)
  const gate = gateOf(f);
  const m5 = hasM5(f.entryMomentumPct);
  const isTop = f.contract != null && topLiveRunnerContracts.has(f.contract);
  if (gate === 'BUY_APPROVED_PAPER') {
    if (m5) return isTop ? 1 : 2;
    return isTop ? 3 : 4;
  }
  if (gate === 'BUY_REJECTED') {
    return m5 ? 5 : 6;
  }
  return 7;                                         // other UNKNOWN rows last
}

// Stable priority sort of the call-eligible fixtures (UNKNOWN targets first by tier).
export function prioritizeClusterCandidates(
  fixtures: TargetingFixture[],
  topLiveRunnerContracts: Set<string> = new Set(),
): TargetingFixture[] {
  return fixtures
    .map((f, i) => ({ f, i, tier: callPriorityTier(f, topLiveRunnerContracts) }))
    .sort((a, b) => (a.tier - b.tier) || (a.i - b.i))
    .map(x => x.f);
}

// Allocate the capped live-call budget over the prioritized candidates. Cache-first,
// dedupe, cap-respecting. Returns per-contract allocation metadata. Pure — no I/O.
export function allocateBubbleMapsCalls(
  fixtures: TargetingFixture[],
  opts: AllocateOptions,
): AllocationSummary {
  const freshCache = opts.freshCacheContracts ?? new Set<string>();
  const top = opts.topLiveRunnerContracts ?? new Set<string>();
  const ordered = prioritizeClusterCandidates(fixtures, top);

  const allocations: CallAllocation[] = [];
  const seen = new Set<string>();
  let liveCallsPlanned = 0, cacheHits = 0, capSkipped = 0, duplicates = 0;
  const byTier: Record<number, number> = {};

  for (const f of ordered) {
    const contract = f.contract;
    const tier = callPriorityTier(f, top);
    if (!contract) continue;

    if (tier >= 99) {
      // Already known → no call needed (never re-clean a known result).
      allocations.push(alloc(contract, tier, false, false, false, 'ALREADY_KNOWN'));
      continue;
    }
    if (seen.has(contract)) {
      duplicates++;
      allocations.push(alloc(contract, tier, false, false, false, 'DUPLICATE_IN_RUN'));
      continue;
    }
    seen.add(contract);

    if (freshCache.has(contract)) {
      cacheHits++;
      allocations.push(alloc(contract, tier, false, true, false, 'CACHE_HIT_FRESH'));
      continue;
    }
    if (liveCallsPlanned >= opts.cap) {
      capSkipped++;
      allocations.push(alloc(contract, tier, false, false, false, 'CAP_REACHED'));
      continue;
    }
    // A live call is spent on this contract.
    liveCallsPlanned++;
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    allocations.push(alloc(contract, tier, true, false, true, null));
  }

  return { allocations, liveCallsPlanned, cacheHits, capSkipped, duplicates, byTier };
}

function alloc(
  contract: string, tier: number, selected: boolean, cacheHit: boolean,
  liveCallUsed: boolean, skipped: CallSkippedReason,
): CallAllocation {
  return {
    contract,
    bubbleMapsCallPriorityTier: tier,
    bubbleMapsSelectedForCall: selected,
    bubbleMapsCacheHit: cacheHit,
    bubbleMapsLiveCallUsed: liveCallUsed,
    bubbleMapsCallSkippedReason: skipped,
    bubbleMapsCallResult: null,
  };
}
