// TOKEN GRAB BRAIN v1.1 — adaptive paper-only policy memory (exact + GLOBAL policy groups)
//
// DO_NOT_ENABLE_REAL_TRADING  RESEARCH_ONLY=true  REAL_TRADING=false
// READY_FOR_REAL_TRADING=false  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true
//
// The brain reads the append-only RESEARCH_WOULD_BUY / RESEARCH_WOULD_SELL stream and REMEMBERS,
// per candidate profile, whether that profile has been winning or losing on real valuation-based
// P/L. It then feeds that memory back into research-shadow so future research decisions adapt:
// KILL profiles stop opening new research positions, DEMOTE profiles are recorded but not opened
// (unless observation mode), PROMOTE profiles are annotated. This is paper-only research memory —
// it NEVER creates a live buy signal, never touches a wallet/swap/signature, and never upgrades an
// UNKNOWN risk label to CLEAN. The production real-trading flags are untouched.
//
// EXACT profiles are the 7-tuple: lane, productionGateApproved, launchAgeBucket, m5Band,
// liquidityBucket, vlrBucket, ripperScoreBand. These are precise but slow to accumulate enough
// valued samples to act on.
//
// v1.1 adds GLOBAL POLICY GROUPS: single-dimension slices (gate=true/false, launchAge, lane, vlr,
// liquidity, m5Band) that accumulate valued samples far faster, so the brain can act on higher-level
// dimensions while exact profiles are still TOO_SMALL. Global groups use SEPARATE thresholds from
// exact profiles. Win/loss/flat and P/L are measured ONLY over valued closed trades (valuationUsable)
// — trades whose price could not be valued are excluded, NEVER counted as flat.

import * as fs from 'fs';
import * as path from 'path';
import type {
  ResearchShadowEvent,
  ResearchWouldBuyEvent,
  ResearchWouldSellEvent,
} from './researchShadow';
import type { ShadowLane } from './liveShadow';

// ── Paths + constants ────────────────────────────────────────────────────────────────────────

export const DEFAULT_BRAIN_POLICY_MEMORY_PATH = 'data/token-grab/brain/policy-memory.json';
export const DEFAULT_BRAIN_RESEARCH_EVENTS_PATH = 'data/token-grab/live-shadow/research-shadow-events.jsonl';

/** Each trade's pnlPct is clamped to ±this before the capped average (winsorized). */
export const BRAIN_PNL_CAP_PCT = 100;

// ── Confidence tier + policy status ────────────────────────────────────────────────────────

export type ConfidenceTier = 'TOO_SMALL' | 'WATCH' | 'STRONG';
export type PolicyStatus   = 'PROMOTE' | 'WATCH' | 'DEMOTE' | 'KILL';
/** Global groups add a lighter PROMOTE_LIGHT tier (winning but not yet strong enough for full PROMOTE). */
export type GlobalPolicyStatus = 'PROMOTE' | 'PROMOTE_LIGHT' | 'WATCH' | 'DEMOTE' | 'KILL';

/** EXACT-profile thresholds (v1) — pure constants so the rules are auditable and testable. */
export const BRAIN_THRESHOLDS = {
  minValuedForStrong: 20,
  minValuedForWatchTier: 10,
  killRedLossRate: 0.75,
  demoteRedLossRate: 0.60,
  promoteMaxRedLossRate: 0.45,
  promoteMinValued: 20,
} as const;

/** GLOBAL-group thresholds (v1.1) — separate, faster-acting rules over single-dimension slices. */
export const GLOBAL_THRESHOLDS = {
  minValued: 10,
  strongValued: 20,
  demoteRedLossRate: 0.65,
  killRedLossRate: 0.65,      // KILL uses the same rate but requires a larger valued sample (>= killMinValued)
  killMinValued: 20,
  promoteLightMaxRedLossRate: 0.50,
  promoteLightMinValued: 10,
  promoteMaxRedLossRate: 0.45,
  promoteMinValued: 20,
} as const;

/** The six single-dimension slices a candidate profile belongs to (v1.1 global groups). */
export const GLOBAL_DIMENSIONS = ['gate', 'age', 'lane', 'vlr', 'liq', 'm5'] as const;
export type GlobalDimension = (typeof GLOBAL_DIMENSIONS)[number];

// ── Types ─────────────────────────────────────────────────────────────────────────────────

export interface PolicyProfileParts {
  lane: string;
  productionGateApproved: boolean;
  launchAgeBucket: string;
  m5Band: string;
  liquidityBucket: string;
  vlrBucket: string;
  ripperScoreBand: string;
}

export interface BrainTradeRef {
  contract: string;
  symbol?: string;
  pnlUsd: number;
  pnlPct: number;
}

export interface PolicyProfile extends PolicyProfileParts {
  key: string;
  sampleSize: number;            // research buys observed for this profile
  valuedClosed: number;          // closed trades with real valuation-based P/L
  unvaluedClosed: number;        // closed trades excluded from P/L (VALUATION_UNAVAILABLE)
  wins: number;
  losses: number;
  flats: number;                 // REAL flat only (valued AND pnl == 0)
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
  redLossRate: number;
  bestTrade: BrainTradeRef | null;
  worstTrade: BrainTradeRef | null;
  lastUpdated: string;
  confidenceTier: ConfidenceTier;
  policyStatus: PolicyStatus;
}

/** A v1.1 GLOBAL policy group — one single-dimension slice (e.g. gate=false, launchAge=TOO_EARLY). */
export interface GlobalPolicyGroup {
  key: string;                   // e.g. 'gate:false'
  dimension: GlobalDimension;    // 'gate' | 'age' | 'lane' | 'vlr' | 'liq' | 'm5'
  value: string;                 // e.g. 'false', 'TOO_EARLY', 'NO_BM_BEST_VLR'
  buys: number;
  valuedClosed: number;
  unvaluedClosed: number;
  wins: number;
  losses: number;
  flats: number;
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
  redLossRate: number;
  bestTrade: BrainTradeRef | null;
  worstTrade: BrainTradeRef | null;
  lastUpdated: string;
  confidenceTier: ConfidenceTier;
  policyStatus: GlobalPolicyStatus;
}

export interface BrainPolicyMemory {
  version: number;
  generatedAt: string;
  eventsPath: string;
  totalProfiles: number;
  profiles: Record<string, PolicyProfile>;
  // v1.1 — single-dimension global policy groups (act faster than exact profiles).
  totalGlobalGroups: number;
  globalGroups: Record<string, GlobalPolicyGroup>;
  // Safety — persisted and always re-enforced on load.
  realTrading: false;
  readyForRealTrading: false;
  noWallet: true;
  noSwap: true;
  noSigning: true;
  paperOnly: true;
  researchOnly: true;
  unknownStaysUnknown: true;
  tradingExecuted: 0;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────

export function policyProfileKey(p: PolicyProfileParts): string {
  return [
    p.lane,
    `gate=${p.productionGateApproved}`,
    `age=${p.launchAgeBucket}`,
    `m5=${p.m5Band}`,
    `liq=${p.liquidityBucket}`,
    `vlr=${p.vlrBucket}`,
    `score=${p.ripperScoreBand}`,
  ].join('|');
}

export function brainMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function brainCappedAverage(values: number[], cap: number): number | null {
  if (values.length === 0) return null;
  const clamped = values.map(v => Math.max(-cap, Math.min(cap, v)));
  return clamped.reduce((s, v) => s + v, 0) / clamped.length;
}

/** Confidence tier is a pure function of the valued-closed sample size. */
export function confidenceTier(valuedClosed: number): ConfidenceTier {
  if (valuedClosed < BRAIN_THRESHOLDS.minValuedForWatchTier) return 'TOO_SMALL';
  if (valuedClosed < BRAIN_THRESHOLDS.minValuedForStrong) return 'WATCH';
  return 'STRONG';
}

/**
 * Policy status from the profile's valued-trade record. Order matters: KILL (worst) is checked
 * before DEMOTE, and both before PROMOTE. Profiles without enough valued data stay WATCH.
 */
export function policyStatus(args: {
  valuedClosed: number;
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
  redLossRate: number;
}): PolicyStatus {
  const { valuedClosed, medianPnlPct, cappedAveragePnlPct, redLossRate } = args;
  const T = BRAIN_THRESHOLDS;

  // Not enough valued closed trades yet — always WATCH (never promote/kill on thin data).
  if (valuedClosed < T.minValuedForWatchTier) return 'WATCH';

  // KILL — very high red-loss rate.
  if (redLossRate >= T.killRedLossRate) return 'KILL';

  // DEMOTE — losing on both median and capped average with a high (but sub-kill) red-loss rate.
  if (medianPnlPct != null && cappedAveragePnlPct != null
    && medianPnlPct < 0 && cappedAveragePnlPct < 0 && redLossRate >= T.demoteRedLossRate) {
    return 'DEMOTE';
  }

  // PROMOTE — winning on both median and capped average, low red-loss rate, and strong sample.
  if (valuedClosed >= T.promoteMinValued
    && medianPnlPct != null && cappedAveragePnlPct != null
    && medianPnlPct > 0 && cappedAveragePnlPct > 0 && redLossRate <= T.promoteMaxRedLossRate) {
    return 'PROMOTE';
  }

  return 'WATCH';
}

/**
 * GLOBAL-group policy status (v1.1) — separate, faster-acting rules over a single-dimension slice.
 * Order matters: KILL (worst) → DEMOTE → PROMOTE → PROMOTE_LIGHT → WATCH.
 */
export function globalPolicyStatus(args: {
  valuedClosed: number;
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
  redLossRate: number;
}): GlobalPolicyStatus {
  const { valuedClosed, medianPnlPct, cappedAveragePnlPct, redLossRate } = args;
  const G = GLOBAL_THRESHOLDS;

  // Thin data → WATCH (TOO_SMALL tier). No "explicitly severe" early-kill rule is defined, so we
  // never KILL/DEMOTE below the minimum valued sample — the brain stays conservative on thin data.
  if (valuedClosed < G.minValued) return 'WATCH';

  const losingBoth  = medianPnlPct != null && cappedAveragePnlPct != null && medianPnlPct < 0 && cappedAveragePnlPct < 0;
  const winningBoth = medianPnlPct != null && cappedAveragePnlPct != null && medianPnlPct > 0 && cappedAveragePnlPct > 0;

  // KILL — losing on both, high red-loss, and a strong valued sample.
  if (valuedClosed >= G.killMinValued && redLossRate >= G.killRedLossRate && losingBoth) return 'KILL';

  // DEMOTE — losing on both with a high red-loss rate (10..19 valued, or 20+ that missed KILL).
  if (redLossRate >= G.demoteRedLossRate && losingBoth) return 'DEMOTE';

  // PROMOTE — winning on both, low red-loss, strong valued sample.
  if (valuedClosed >= G.promoteMinValued && winningBoth && redLossRate <= G.promoteMaxRedLossRate) return 'PROMOTE';

  // PROMOTE_LIGHT — winning on both, modestly low red-loss, moderate valued sample.
  if (valuedClosed >= G.promoteLightMinValued && winningBoth && redLossRate <= G.promoteLightMaxRedLossRate) return 'PROMOTE_LIGHT';

  return 'WATCH';
}

/** The six single-dimension global slices a candidate profile belongs to. */
export function globalGroupsForParts(parts: PolicyProfileParts): Array<{ key: string; dimension: GlobalDimension; value: string }> {
  return [
    { dimension: 'gate', value: String(parts.productionGateApproved), key: `gate:${parts.productionGateApproved}` },
    { dimension: 'age',  value: parts.launchAgeBucket,                 key: `age:${parts.launchAgeBucket}` },
    { dimension: 'lane', value: parts.lane,                            key: `lane:${parts.lane}` },
    { dimension: 'vlr',  value: parts.vlrBucket,                       key: `vlr:${parts.vlrBucket}` },
    { dimension: 'liq',  value: parts.liquidityBucket,                 key: `liq:${parts.liquidityBucket}` },
    { dimension: 'm5',   value: parts.m5Band,                          key: `m5:${parts.m5Band}` },
  ];
}

// ── I/O ───────────────────────────────────────────────────────────────────────────────────────

export function readResearchEvents(eventsPath: string): ResearchShadowEvent[] {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as ResearchShadowEvent; } catch { return null; } })
    .filter((e): e is ResearchShadowEvent => e != null);
}

export function loadBrainPolicyMemory(memoryPath: string): BrainPolicyMemory | null {
  if (!fs.existsSync(memoryPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(memoryPath, 'utf-8')) as BrainPolicyMemory;
    // Always re-enforce safety constants regardless of what is on disk.
    return {
      ...parsed,
      profiles: parsed.profiles ?? {},
      globalGroups: parsed.globalGroups ?? {},
      totalGlobalGroups: parsed.totalGlobalGroups ?? Object.keys(parsed.globalGroups ?? {}).length,
      realTrading: false, readyForRealTrading: false, noWallet: true, noSwap: true, noSigning: true,
      paperOnly: true, researchOnly: true, unknownStaysUnknown: true, tradingExecuted: 0,
    };
  } catch {
    return null;
  }
}

export function saveBrainPolicyMemory(memory: BrainPolicyMemory, memoryPath: string): void {
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2), 'utf-8');
}

// ── Lookup used by research-shadow integration ────────────────────────────────────────────────

/** Resolve the remembered EXACT-profile policy status for a candidate. Unknown profiles → WATCH. */
export function resolvePolicyStatus(memory: BrainPolicyMemory | null, parts: PolicyProfileParts): PolicyStatus {
  if (!memory) return 'WATCH';
  return memory.profiles[policyProfileKey(parts)]?.policyStatus ?? 'WATCH';
}

/** Combined brain decision (v1.1): exact profile FIRST, then global groups. */
export interface BrainDecision {
  action: 'OPEN' | 'SKIP' | 'OBSERVE_ONLY';   // SKIP=never open, OBSERVE_ONLY=open only in observation mode
  status: 'KILL' | 'DEMOTE' | 'PROMOTE' | 'WATCH';
  source: 'EXACT' | 'GLOBAL' | 'DEFAULT';
  reason: string;
}

/**
 * Resolve the combined brain decision for a candidate. Precedence (per v1.1 spec):
 *   1. exact profile KILL      → SKIP        (exact KILL overrides any global PROMOTE)
 *   2. any global group KILL   → SKIP
 *   3. exact DEMOTE            → OBSERVE_ONLY
 *   4. any global DEMOTE       → OBSERVE_ONLY
 *   5. exact PROMOTE           → OPEN (PROMOTE)
 *   6. any global PROMOTE/PROMOTE_LIGHT → OPEN (PROMOTE)
 *   7. default                 → OPEN (WATCH)
 * Unknown profiles / no memory default to WATCH (open normally).
 */
export function resolveBrainDecision(memory: BrainPolicyMemory | null, parts: PolicyProfileParts): BrainDecision {
  if (!memory) return { action: 'OPEN', status: 'WATCH', source: 'DEFAULT', reason: 'no policy memory' };

  const exact = memory.profiles[policyProfileKey(parts)]?.policyStatus ?? 'WATCH';
  const groups = memory.globalGroups ?? {};
  const matched = globalGroupsForParts(parts)
    .map(g => groups[g.key])
    .filter((g): g is GlobalPolicyGroup => g != null);
  const globalWith = (s: GlobalPolicyStatus): GlobalPolicyGroup | undefined => matched.find(g => g.policyStatus === s);

  if (exact === 'KILL') return { action: 'SKIP', status: 'KILL', source: 'EXACT', reason: 'exact profile KILL' };
  const gKill = globalWith('KILL');
  if (gKill) return { action: 'SKIP', status: 'KILL', source: 'GLOBAL', reason: `global group KILL: ${gKill.key}` };

  if (exact === 'DEMOTE') return { action: 'OBSERVE_ONLY', status: 'DEMOTE', source: 'EXACT', reason: 'exact profile DEMOTE' };
  const gDemote = globalWith('DEMOTE');
  if (gDemote) return { action: 'OBSERVE_ONLY', status: 'DEMOTE', source: 'GLOBAL', reason: `global group DEMOTE: ${gDemote.key}` };

  if (exact === 'PROMOTE') return { action: 'OPEN', status: 'PROMOTE', source: 'EXACT', reason: 'exact profile PROMOTE' };
  const gPromote = globalWith('PROMOTE') ?? globalWith('PROMOTE_LIGHT');
  if (gPromote) return { action: 'OPEN', status: 'PROMOTE', source: 'GLOBAL', reason: `global group ${gPromote.policyStatus}: ${gPromote.key}` };

  return { action: 'OPEN', status: 'WATCH', source: 'DEFAULT', reason: 'default WATCH' };
}

// ── Build memory from the research-shadow event stream ────────────────────────────────────────

function partsFromBuy(b: ResearchWouldBuyEvent): PolicyProfileParts {
  return {
    lane: b.lane, productionGateApproved: b.productionGateApproved, launchAgeBucket: b.launchAgeBucket,
    m5Band: b.m5Band, liquidityBucket: b.liquidityBucket, vlrBucket: b.vlrBucket, ripperScoreBand: b.ripperScoreBand,
  };
}

function partsFromSell(s: ResearchWouldSellEvent): PolicyProfileParts {
  return {
    lane: s.lane, productionGateApproved: s.productionGateApproved, launchAgeBucket: s.launchAgeBucket,
    m5Band: s.m5Band ?? 'UNAVAILABLE', liquidityBucket: s.liquidityBucket ?? 'UNAVAILABLE',
    vlrBucket: s.vlrBucket ?? 'UNAVAILABLE', ripperScoreBand: s.ripperScoreBand ?? 'UNAVAILABLE',
  };
}

interface ProfileAccumulator {
  parts: PolicyProfileParts;
  sampleSize: number;
  valuedPnlPct: number[];
  valuedRefs: BrainTradeRef[];
  wins: number;
  losses: number;
  flats: number;
  unvaluedClosed: number;
}

interface GlobalAccumulator {
  key: string;
  dimension: GlobalDimension;
  value: string;
  buys: number;
  valuedPnlPct: number[];
  valuedRefs: BrainTradeRef[];
  wins: number;
  losses: number;
  flats: number;
  unvaluedClosed: number;
}

/** Finalize valued-trade stats shared by exact profiles and global groups. */
function finalizeStats(valuedPnlPct: number[], valuedRefs: BrainTradeRef[], losses: number): {
  valuedClosed: number; redLossRate: number; medianPnlPct: number | null; cappedAveragePnlPct: number | null;
  bestTrade: BrainTradeRef | null; worstTrade: BrainTradeRef | null;
} {
  const valuedClosed = valuedPnlPct.length;
  let best: BrainTradeRef | null = null, worst: BrainTradeRef | null = null;
  for (const r of valuedRefs) {
    if (best == null  || r.pnlUsd > best.pnlUsd)  best = r;
    if (worst == null || r.pnlUsd < worst.pnlUsd) worst = r;
  }
  return {
    valuedClosed,
    redLossRate: valuedClosed ? losses / valuedClosed : 0,
    medianPnlPct: brainMedian(valuedPnlPct),
    cappedAveragePnlPct: brainCappedAverage(valuedPnlPct, BRAIN_PNL_CAP_PCT),
    bestTrade: best, worstTrade: worst,
  };
}

function isValuedSell(e: ResearchWouldSellEvent): boolean {
  return e.valuationUsable === true && e.pnlPct != null;
}

export interface BuildPolicyMemoryOptions {
  eventsPath?: string;
  generatedAt: string;
}

export function buildPolicyMemory(events: ResearchShadowEvent[], opts: BuildPolicyMemoryOptions): BrainPolicyMemory {
  const buys  = events.filter((e): e is ResearchWouldBuyEvent  => e.type === 'RESEARCH_WOULD_BUY');
  const sells = events.filter((e): e is ResearchWouldSellEvent => e.type === 'RESEARCH_WOULD_SELL');

  // Join key: (contract|lane|sourceCycle) uniquely identifies the opening buy for each sell, so we
  // can always recover a sell's full 7-key profile from its buy (buys carry all descriptors).
  const buyProfileByJoinKey = new Map<string, PolicyProfileParts>();
  for (const b of buys) buyProfileByJoinKey.set(`${b.contract}|${b.lane}|${b.sourceCycle}`, partsFromBuy(b));

  const acc = new Map<string, ProfileAccumulator>();
  const ensure = (parts: PolicyProfileParts): ProfileAccumulator => {
    const key = policyProfileKey(parts);
    let a = acc.get(key);
    if (!a) { a = { parts, sampleSize: 0, valuedPnlPct: [], valuedRefs: [], wins: 0, losses: 0, flats: 0, unvaluedClosed: 0 }; acc.set(key, a); }
    return a;
  };

  // ── GLOBAL group accumulators (v1.1) — single-dimension slices ──
  const gacc = new Map<string, GlobalAccumulator>();
  const ensureGlobal = (dimension: GlobalDimension, value: string, key: string): GlobalAccumulator => {
    let a = gacc.get(key);
    if (!a) { a = { key, dimension, value, buys: 0, valuedPnlPct: [], valuedRefs: [], wins: 0, losses: 0, flats: 0, unvaluedClosed: 0 }; gacc.set(key, a); }
    return a;
  };

  // Sample size = every research buy observed for the profile (and each of its 6 global slices).
  for (const b of buys) {
    const parts = partsFromBuy(b);
    ensure(parts).sampleSize += 1;
    for (const g of globalGroupsForParts(parts)) ensureGlobal(g.dimension, g.value, g.key).buys += 1;
  }

  // Outcomes measured ONLY over valued closed trades; unvalued excluded (never counted as flat).
  for (const s of sells) {
    const parts = buyProfileByJoinKey.get(`${s.contract}|${s.lane}|${s.sourceCycle}`) ?? partsFromSell(s);
    const a = ensure(parts);
    const gAccs = globalGroupsForParts(parts).map(g => ensureGlobal(g.dimension, g.value, g.key));
    if (!isValuedSell(s)) {
      a.unvaluedClosed += 1;
      for (const ga of gAccs) ga.unvaluedClosed += 1;
      continue;
    }
    const pnlPct = s.pnlPct as number;
    const ref: BrainTradeRef = { contract: s.contract, symbol: s.symbol, pnlUsd: s.pnlUsd ?? 0, pnlPct };
    a.valuedPnlPct.push(pnlPct); a.valuedRefs.push(ref);
    if (pnlPct > 0) a.wins += 1; else if (pnlPct < 0) a.losses += 1; else a.flats += 1;
    for (const ga of gAccs) {
      ga.valuedPnlPct.push(pnlPct); ga.valuedRefs.push(ref);
      if (pnlPct > 0) ga.wins += 1; else if (pnlPct < 0) ga.losses += 1; else ga.flats += 1;
    }
  }

  const profiles: Record<string, PolicyProfile> = {};
  for (const [key, a] of acc) {
    const stats = finalizeStats(a.valuedPnlPct, a.valuedRefs, a.losses);
    profiles[key] = {
      ...a.parts, key,
      sampleSize: a.sampleSize,
      valuedClosed: stats.valuedClosed,
      unvaluedClosed: a.unvaluedClosed,
      wins: a.wins, losses: a.losses, flats: a.flats,
      medianPnlPct: stats.medianPnlPct, cappedAveragePnlPct: stats.cappedAveragePnlPct, redLossRate: stats.redLossRate,
      bestTrade: stats.bestTrade, worstTrade: stats.worstTrade,
      lastUpdated: opts.generatedAt,
      confidenceTier: confidenceTier(stats.valuedClosed),
      policyStatus: policyStatus({ valuedClosed: stats.valuedClosed, medianPnlPct: stats.medianPnlPct, cappedAveragePnlPct: stats.cappedAveragePnlPct, redLossRate: stats.redLossRate }),
    };
  }

  const globalGroups: Record<string, GlobalPolicyGroup> = {};
  for (const [key, a] of gacc) {
    const stats = finalizeStats(a.valuedPnlPct, a.valuedRefs, a.losses);
    globalGroups[key] = {
      key: a.key, dimension: a.dimension, value: a.value,
      buys: a.buys,
      valuedClosed: stats.valuedClosed,
      unvaluedClosed: a.unvaluedClosed,
      wins: a.wins, losses: a.losses, flats: a.flats,
      medianPnlPct: stats.medianPnlPct, cappedAveragePnlPct: stats.cappedAveragePnlPct, redLossRate: stats.redLossRate,
      bestTrade: stats.bestTrade, worstTrade: stats.worstTrade,
      lastUpdated: opts.generatedAt,
      confidenceTier: confidenceTier(stats.valuedClosed),
      policyStatus: globalPolicyStatus({ valuedClosed: stats.valuedClosed, medianPnlPct: stats.medianPnlPct, cappedAveragePnlPct: stats.cappedAveragePnlPct, redLossRate: stats.redLossRate }),
    };
  }

  return {
    version: 1.1, generatedAt: opts.generatedAt, eventsPath: opts.eventsPath ?? DEFAULT_BRAIN_RESEARCH_EVENTS_PATH,
    totalProfiles: Object.keys(profiles).length, profiles,
    totalGlobalGroups: Object.keys(globalGroups).length, globalGroups,
    realTrading: false, readyForRealTrading: false, noWallet: true, noSwap: true, noSigning: true,
    paperOnly: true, researchOnly: true, unknownStaysUnknown: true, tradingExecuted: 0,
  };
}

// ── Refresh (build + diff + persist) ───────────────────────────────────────────────────────────

export interface BrainRefreshChange {
  scope: 'EXACT' | 'GLOBAL';
  key: string;
  kind: 'NEW' | 'STATUS_CHANGE' | 'REMOVED';
  from?: string;
  to?: string;
}

export interface BrainRefreshResult {
  memory: BrainPolicyMemory;
  memoryPath: string;
  eventsPath: string;
  previousExisted: boolean;
  changes: BrainRefreshChange[];
  // Exact profiles.
  promoted: PolicyProfile[];
  killed: PolicyProfile[];
  demoted: PolicyProfile[];
  watch: PolicyProfile[];
  tooSmall: PolicyProfile[];
  // v1.1 global groups.
  globalPromoted: GlobalPolicyGroup[];   // PROMOTE + PROMOTE_LIGHT
  globalKilled: GlobalPolicyGroup[];
  globalDemoted: GlobalPolicyGroup[];
  globalWatch: GlobalPolicyGroup[];
  readyForRealTrading: false;
}

export interface RefreshBrainPolicyOptions {
  eventsPath?: string;
  memoryPath?: string;
  generatedAt: string;
  /** When false (default), the built memory is persisted to memoryPath. */
  dryRun?: boolean;
}

export function refreshBrainPolicy(opts: RefreshBrainPolicyOptions): BrainRefreshResult {
  const eventsPath = opts.eventsPath ?? DEFAULT_BRAIN_RESEARCH_EVENTS_PATH;
  const memoryPath = opts.memoryPath ?? DEFAULT_BRAIN_POLICY_MEMORY_PATH;

  const previous = loadBrainPolicyMemory(memoryPath);
  const events = readResearchEvents(eventsPath);
  const memory = buildPolicyMemory(events, { eventsPath, generatedAt: opts.generatedAt });

  // Diff vs previous memory — exact profiles + global groups.
  const changes: BrainRefreshChange[] = [];
  const prevProfiles = previous?.profiles ?? {};
  for (const [key, p] of Object.entries(memory.profiles)) {
    const prev = prevProfiles[key];
    if (!prev) changes.push({ scope: 'EXACT', key, kind: 'NEW', to: p.policyStatus });
    else if (prev.policyStatus !== p.policyStatus) changes.push({ scope: 'EXACT', key, kind: 'STATUS_CHANGE', from: prev.policyStatus, to: p.policyStatus });
  }
  for (const key of Object.keys(prevProfiles)) {
    if (!memory.profiles[key]) changes.push({ scope: 'EXACT', key, kind: 'REMOVED', from: prevProfiles[key].policyStatus });
  }
  const prevGlobals = previous?.globalGroups ?? {};
  for (const [key, g] of Object.entries(memory.globalGroups)) {
    const prev = prevGlobals[key];
    if (!prev) changes.push({ scope: 'GLOBAL', key, kind: 'NEW', to: g.policyStatus });
    else if (prev.policyStatus !== g.policyStatus) changes.push({ scope: 'GLOBAL', key, kind: 'STATUS_CHANGE', from: prev.policyStatus, to: g.policyStatus });
  }
  for (const key of Object.keys(prevGlobals)) {
    if (!memory.globalGroups[key]) changes.push({ scope: 'GLOBAL', key, kind: 'REMOVED', from: prevGlobals[key].policyStatus });
  }

  const all = Object.values(memory.profiles);
  const byPnl = (a: PolicyProfile, b: PolicyProfile) => (b.cappedAveragePnlPct ?? -Infinity) - (a.cappedAveragePnlPct ?? -Infinity);
  const byRedLoss = (a: PolicyProfile, b: PolicyProfile) => b.redLossRate - a.redLossRate;

  const gAll = Object.values(memory.globalGroups);
  const gByPnl = (a: GlobalPolicyGroup, b: GlobalPolicyGroup) => (b.cappedAveragePnlPct ?? -Infinity) - (a.cappedAveragePnlPct ?? -Infinity);
  const gByRedLoss = (a: GlobalPolicyGroup, b: GlobalPolicyGroup) => b.redLossRate - a.redLossRate;

  const result: BrainRefreshResult = {
    memory, memoryPath, eventsPath,
    previousExisted: previous != null,
    changes,
    promoted: all.filter(p => p.policyStatus === 'PROMOTE').sort(byPnl),
    killed:   all.filter(p => p.policyStatus === 'KILL').sort(byRedLoss),
    demoted:  all.filter(p => p.policyStatus === 'DEMOTE').sort(byRedLoss),
    watch:    all.filter(p => p.policyStatus === 'WATCH' && p.confidenceTier !== 'TOO_SMALL'),
    tooSmall: all.filter(p => p.confidenceTier === 'TOO_SMALL'),
    globalPromoted: gAll.filter(g => g.policyStatus === 'PROMOTE' || g.policyStatus === 'PROMOTE_LIGHT').sort(gByPnl),
    globalKilled:   gAll.filter(g => g.policyStatus === 'KILL').sort(gByRedLoss),
    globalDemoted:  gAll.filter(g => g.policyStatus === 'DEMOTE').sort(gByRedLoss),
    globalWatch:    gAll.filter(g => g.policyStatus === 'WATCH' && g.confidenceTier !== 'TOO_SMALL'),
    readyForRealTrading: false,
  };

  if (!opts.dryRun) saveBrainPolicyMemory(memory, memoryPath);
  return result;
}

// ── Renderer ─────────────────────────────────────────────────────────────────────────────────

function pnlS(v: number | null): string { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function pctS(v: number): string { return (v * 100).toFixed(0) + '%'; }

function profileLine(p: PolicyProfile): string {
  return `    [${p.policyStatus.padEnd(7)} ${p.confidenceTier.padEnd(9)}] ` +
    `${p.lane}  gate=${p.productionGateApproved}  age=${p.launchAgeBucket}  m5=${p.m5Band}  liq=${p.liquidityBucket}  vlr=${p.vlrBucket}  score=${p.ripperScoreBand}\n` +
    `        sample ${p.sampleSize}  valued ${p.valuedClosed}  W/L/F ${p.wins}/${p.losses}/${p.flats}  ` +
    `median ${pnlS(p.medianPnlPct)}  cappedAvg ${pnlS(p.cappedAveragePnlPct)}  redLoss ${pctS(p.redLossRate)}`;
}

function globalLine(g: GlobalPolicyGroup): string {
  return `    [${g.policyStatus.padEnd(13)} ${g.confidenceTier.padEnd(9)}] ${g.key.padEnd(28)}` +
    `  buys ${g.buys}  valued ${g.valuedClosed}  W/L/F ${g.wins}/${g.losses}/${g.flats}  ` +
    `median ${pnlS(g.medianPnlPct)}  cappedAvg ${pnlS(g.cappedAveragePnlPct)}  redLoss ${pctS(g.redLossRate)}`;
}

export function renderBrainRefreshReport(r: BrainRefreshResult): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const L: string[] = [];

  L.push(WIDE);
  L.push('  TOKEN GRAB BRAIN v1.1 — ADAPTIVE PAPER-ONLY POLICY MEMORY');
  L.push('  EXACT PROFILES + GLOBAL POLICY GROUPS');
  L.push('  RESEARCH_ONLY_NOT_EXECUTABLE — NOT_A_BUY_SIGNAL — SIMULATED');
  L.push('  These are PAPER-ONLY research policies — never live trading, never a buy signal.');
  L.push('  [READ ONLY — DO_NOT_ENABLE_REAL_TRADING]');
  L.push(WIDE);
  L.push('');
  L.push(`  Generated at        : ${r.memory.generatedAt}`);
  L.push(`  Events file         : ${r.eventsPath}`);
  L.push(`  Memory file         : ${r.memoryPath}`);
  L.push(`  Exact profiles      : ${r.memory.totalProfiles}   (Promoted ${r.promoted.length}  Killed ${r.killed.length}  Demoted ${r.demoted.length}  Watch ${r.watch.length}  Too-small ${r.tooSmall.length})`);
  L.push(`  Global policy groups: ${r.memory.totalGlobalGroups}   (Promoted ${r.globalPromoted.length}  Killed ${r.globalKilled.length}  Demoted ${r.globalDemoted.length}  Watch ${r.globalWatch.length})`);
  L.push('');

  const section = (title: string, profiles: PolicyProfile[], limit = 10) => {
    L.push(THIN);
    L.push(`  ${title} (${profiles.length})`);
    L.push(THIN);
    if (profiles.length === 0) { L.push('    (none)'); L.push(''); return; }
    for (const p of profiles.slice(0, limit)) L.push(profileLine(p));
    if (profiles.length > limit) L.push(`    … ${profiles.length - limit} more`);
    L.push('');
  };
  const gSection = (title: string, groups: GlobalPolicyGroup[], limit = 20) => {
    L.push(THIN);
    L.push(`  ${title} (${groups.length})`);
    L.push(THIN);
    if (groups.length === 0) { L.push('    (none)'); L.push(''); return; }
    for (const g of groups.slice(0, limit)) L.push(globalLine(g));
    if (groups.length > limit) L.push(`    … ${groups.length - limit} more`);
    L.push('');
  };

  L.push('  ══ EXACT PROFILE STATUSES ══');
  L.push('');
  section('TOP PROMOTED PROFILES', r.promoted);
  section('KILLED PROFILES', r.killed);
  section('DEMOTED PROFILES', r.demoted);
  section('WATCH PROFILES', r.watch);

  L.push('  ══ GLOBAL POLICY GROUP STATUSES (v1.1 — act while exact profiles are still small) ══');
  L.push('');
  gSection('GLOBAL PROMOTED (PROMOTE / PROMOTE_LIGHT)', r.globalPromoted);
  gSection('GLOBAL KILLED', r.globalKilled);
  gSection('GLOBAL DEMOTED', r.globalDemoted);
  gSection('GLOBAL WATCH (enough data, neutral)', r.globalWatch);

  L.push(THIN);
  L.push(`  WHAT CHANGED SINCE LAST REFRESH (${r.previousExisted ? 'diff vs prior memory' : 'first refresh — all NEW'})`);
  L.push(THIN);
  if (r.changes.length === 0) {
    L.push('    (no status changes)');
  } else {
    for (const c of r.changes.slice(0, 30)) {
      const tag = c.scope === 'GLOBAL' ? 'GLOBAL' : 'EXACT ';
      if (c.kind === 'NEW') L.push(`    ${tag} NEW      ${c.to}   ${c.key}`);
      else if (c.kind === 'STATUS_CHANGE') L.push(`    ${tag} CHANGED  ${c.from} → ${c.to}   ${c.key}`);
      else L.push(`    ${tag} REMOVED  (was ${c.from})   ${c.key}`);
    }
    if (r.changes.length > 30) L.push(`    … ${r.changes.length - 30} more`);
  }
  L.push('');

  L.push(THIN);
  L.push('  READINESS & SAFETY');
  L.push(THIN);
  L.push('  READY_FOR_REAL_TRADING=false');
  L.push('  REAL_TRADING=false  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true');
  L.push('  Paper-only research policies. UNKNOWN stays UNKNOWN — never CLEAN. Never a buy signal.');
  L.push('  Does not run the auto-paper or paper-buy commands. DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);

  return L.join('\n');
}

export function renderBrainRefreshUsage(): string {
  return `
token:brain-refresh — Token Grab Brain v1.1: build/update adaptive paper-only policy memory from the
research-shadow event stream, then report exact-profile AND global-policy-group statuses (promoted /
killed / demoted / watch). Global groups act on single dimensions (gate, launchAge, lane, vlr,
liquidity, m5Band) so the brain can decide while exact 7-key profiles are still too small.

Usage:
  npm run token:brain-refresh [options]

Options:
  --events <path>   research-shadow events jsonl (default: ${DEFAULT_BRAIN_RESEARCH_EVENTS_PATH})
  --memory <path>   policy memory json           (default: ${DEFAULT_BRAIN_POLICY_MEMORY_PATH})
  --dry-run          build + report WITHOUT writing policy-memory.json
  --json             emit the policy memory as JSON
  --help              show this message

Safety:
  Paper-only research memory. READY_FOR_REAL_TRADING=false. No wallet, no signing, no swap.
  UNKNOWN stays UNKNOWN — never CLEAN. Never creates a live buy signal.
  Does not run the auto-paper or paper-buy commands. DO_NOT_ENABLE_REAL_TRADING.
`.trim();
}
