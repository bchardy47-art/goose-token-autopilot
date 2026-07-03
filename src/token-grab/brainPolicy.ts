// TOKEN GRAB BRAIN v1 — adaptive paper-only policy memory
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
// A profile is the 7-tuple: lane, productionGateApproved, launchAgeBucket, m5Band, liquidityBucket,
// vlrBucket, ripperScoreBand. Win/loss/flat and P/L are measured ONLY over valued closed trades
// (valuationUsable) — trades whose price could not be valued are excluded, NEVER counted as flat.

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

/** Thresholds — pure constants so the rules are auditable and testable. */
export const BRAIN_THRESHOLDS = {
  minValuedForStrong: 20,
  minValuedForWatchTier: 10,
  killRedLossRate: 0.75,
  demoteRedLossRate: 0.60,
  promoteMaxRedLossRate: 0.45,
  promoteMinValued: 20,
} as const;

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

export interface BrainPolicyMemory {
  version: 1;
  generatedAt: string;
  eventsPath: string;
  totalProfiles: number;
  profiles: Record<string, PolicyProfile>;
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

/** Resolve the remembered policy status for a candidate profile. Unknown profiles default to WATCH. */
export function resolvePolicyStatus(memory: BrainPolicyMemory | null, parts: PolicyProfileParts): PolicyStatus {
  if (!memory) return 'WATCH';
  return memory.profiles[policyProfileKey(parts)]?.policyStatus ?? 'WATCH';
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

  // Sample size = every research buy observed for the profile.
  for (const b of buys) ensure(partsFromBuy(b)).sampleSize += 1;

  // Outcomes measured ONLY over valued closed trades; unvalued excluded (never counted as flat).
  for (const s of sells) {
    const parts = buyProfileByJoinKey.get(`${s.contract}|${s.lane}|${s.sourceCycle}`) ?? partsFromSell(s);
    const a = ensure(parts);
    if (!isValuedSell(s)) { a.unvaluedClosed += 1; continue; }
    const pnlPct = s.pnlPct as number;
    a.valuedPnlPct.push(pnlPct);
    a.valuedRefs.push({ contract: s.contract, symbol: s.symbol, pnlUsd: s.pnlUsd ?? 0, pnlPct });
    if (pnlPct > 0) a.wins += 1; else if (pnlPct < 0) a.losses += 1; else a.flats += 1;
  }

  const profiles: Record<string, PolicyProfile> = {};
  for (const [key, a] of acc) {
    const valuedClosed = a.valuedPnlPct.length;
    const redLossRate = valuedClosed ? a.losses / valuedClosed : 0;
    const medianPnlPct = brainMedian(a.valuedPnlPct);
    const cappedAveragePnlPct = brainCappedAverage(a.valuedPnlPct, BRAIN_PNL_CAP_PCT);
    let best: BrainTradeRef | null = null, worst: BrainTradeRef | null = null;
    for (const r of a.valuedRefs) {
      if (best == null  || r.pnlUsd > best.pnlUsd)  best = r;
      if (worst == null || r.pnlUsd < worst.pnlUsd) worst = r;
    }
    profiles[key] = {
      ...a.parts, key,
      sampleSize: a.sampleSize,
      valuedClosed,
      unvaluedClosed: a.unvaluedClosed,
      wins: a.wins, losses: a.losses, flats: a.flats,
      medianPnlPct, cappedAveragePnlPct, redLossRate,
      bestTrade: best, worstTrade: worst,
      lastUpdated: opts.generatedAt,
      confidenceTier: confidenceTier(valuedClosed),
      policyStatus: policyStatus({ valuedClosed, medianPnlPct, cappedAveragePnlPct, redLossRate }),
    };
  }

  return {
    version: 1, generatedAt: opts.generatedAt, eventsPath: opts.eventsPath ?? DEFAULT_BRAIN_RESEARCH_EVENTS_PATH,
    totalProfiles: Object.keys(profiles).length, profiles,
    realTrading: false, readyForRealTrading: false, noWallet: true, noSwap: true, noSigning: true,
    paperOnly: true, researchOnly: true, unknownStaysUnknown: true, tradingExecuted: 0,
  };
}

// ── Refresh (build + diff + persist) ───────────────────────────────────────────────────────────

export interface BrainRefreshChange {
  key: string;
  kind: 'NEW' | 'STATUS_CHANGE' | 'REMOVED';
  from?: PolicyStatus;
  to?: PolicyStatus;
}

export interface BrainRefreshResult {
  memory: BrainPolicyMemory;
  memoryPath: string;
  eventsPath: string;
  previousExisted: boolean;
  changes: BrainRefreshChange[];
  promoted: PolicyProfile[];
  killed: PolicyProfile[];
  demoted: PolicyProfile[];
  watch: PolicyProfile[];
  tooSmall: PolicyProfile[];
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

  // Diff vs previous memory.
  const changes: BrainRefreshChange[] = [];
  const prevProfiles = previous?.profiles ?? {};
  for (const [key, p] of Object.entries(memory.profiles)) {
    const prev = prevProfiles[key];
    if (!prev) changes.push({ key, kind: 'NEW', to: p.policyStatus });
    else if (prev.policyStatus !== p.policyStatus) changes.push({ key, kind: 'STATUS_CHANGE', from: prev.policyStatus, to: p.policyStatus });
  }
  for (const key of Object.keys(prevProfiles)) {
    if (!memory.profiles[key]) changes.push({ key, kind: 'REMOVED', from: prevProfiles[key].policyStatus });
  }

  const all = Object.values(memory.profiles);
  const byPnl = (a: PolicyProfile, b: PolicyProfile) => (b.cappedAveragePnlPct ?? -Infinity) - (a.cappedAveragePnlPct ?? -Infinity);
  const byRedLoss = (a: PolicyProfile, b: PolicyProfile) => b.redLossRate - a.redLossRate;

  const result: BrainRefreshResult = {
    memory, memoryPath, eventsPath,
    previousExisted: previous != null,
    changes,
    promoted: all.filter(p => p.policyStatus === 'PROMOTE').sort(byPnl),
    killed:   all.filter(p => p.policyStatus === 'KILL').sort(byRedLoss),
    demoted:  all.filter(p => p.policyStatus === 'DEMOTE').sort(byRedLoss),
    watch:    all.filter(p => p.policyStatus === 'WATCH' && p.confidenceTier !== 'TOO_SMALL'),
    tooSmall: all.filter(p => p.confidenceTier === 'TOO_SMALL'),
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

export function renderBrainRefreshReport(r: BrainRefreshResult): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const L: string[] = [];

  L.push(WIDE);
  L.push('  TOKEN GRAB BRAIN v1 — ADAPTIVE PAPER-ONLY POLICY MEMORY');
  L.push('  RESEARCH_ONLY_NOT_EXECUTABLE — NOT_A_BUY_SIGNAL — SIMULATED');
  L.push('  [READ ONLY — DO_NOT_ENABLE_REAL_TRADING]');
  L.push(WIDE);
  L.push('');
  L.push(`  Generated at   : ${r.memory.generatedAt}`);
  L.push(`  Events file    : ${r.eventsPath}`);
  L.push(`  Memory file    : ${r.memoryPath}`);
  L.push(`  Total profiles : ${r.memory.totalProfiles}`);
  L.push(`  Promoted ${r.promoted.length}  Killed ${r.killed.length}  Demoted ${r.demoted.length}  Watch ${r.watch.length}  Too-small ${r.tooSmall.length}`);
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

  section('TOP PROMOTED PROFILES', r.promoted);
  section('KILLED PROFILES', r.killed);
  section('DEMOTED PROFILES', r.demoted);
  section('WATCH PROFILES', r.watch);

  L.push(THIN);
  L.push(`  WHAT CHANGED SINCE LAST REFRESH (${r.previousExisted ? 'diff vs prior memory' : 'first refresh — all NEW'})`);
  L.push(THIN);
  if (r.changes.length === 0) {
    L.push('    (no status changes)');
  } else {
    for (const c of r.changes.slice(0, 25)) {
      if (c.kind === 'NEW') L.push(`    NEW      ${c.to}   ${c.key}`);
      else if (c.kind === 'STATUS_CHANGE') L.push(`    CHANGED  ${c.from} → ${c.to}   ${c.key}`);
      else L.push(`    REMOVED  (was ${c.from})   ${c.key}`);
    }
    if (r.changes.length > 25) L.push(`    … ${r.changes.length - 25} more`);
  }
  L.push('');

  L.push(THIN);
  L.push('  READINESS & SAFETY');
  L.push(THIN);
  L.push('  READY_FOR_REAL_TRADING=false');
  L.push('  REAL_TRADING=false  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true');
  L.push('  Paper-only research memory. UNKNOWN stays UNKNOWN — never CLEAN. Never a buy signal.');
  L.push('  Does not run the auto-paper or paper-buy commands. DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);

  return L.join('\n');
}

export function renderBrainRefreshUsage(): string {
  return `
token:brain-refresh — Token Grab Brain v1: build/update adaptive paper-only policy memory from the
research-shadow event stream, then report promoted / killed / demoted / watch profiles.

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
