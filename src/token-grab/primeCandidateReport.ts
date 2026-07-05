// TOKEN GRAB — PRIME CANDIDATE REPORT (read-only)
//
// REPORT_ONLY  NO_TRADES  DO_NOT_ENABLE_REAL_TRADING  REAL_TRADING=false  READY_FOR_REAL_TRADING=false
// NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true
//
// Searches ALL paper/research outcomes (the research-shadow valued-closed trades) for narrow
// strategy "pockets" that MIGHT be trade-worthy, by slicing the data into many cohorts and scoring
// each with fee/slippage haircuts and top-trade-dependency checks. It is READ-ONLY: it opens no
// positions, changes no gates, no live-shadow behaviour, and no brain policy, and never runs the
// auto-paper or paper-buy commands. UNKNOWN risk labels are never upgraded to CLEAN.
//
// P/L is measured ONLY over valued closed trades (valuationUsable). VALUATION_UNAVAILABLE trades
// are excluded from every P/L statistic and are NEVER counted as flat. Sells are joined to their
// opening buy (contract|lane|sourceCycle) to recover the full 7-key profile + ripperScore + the
// brainAction era marker (older sells predate those fields).

import * as fs from 'fs';
import { median, cappedAverage, RESEARCH_PNL_CAP_PCT } from './researchShadowReport';
import { DEFAULT_RESEARCH_SHADOW_EVENTS_PATH } from './researchShadow';
import { DEFAULT_BRAIN_POLICY_MEMORY_PATH, loadBrainPolicyMemory, policyProfileKey, type BrainPolicyMemory, type PolicyProfileParts } from './brainPolicy';

// ── Constants ─────────────────────────────────────────────────────────────────────────────────

export const HAIRCUT_2_PCT = 2;   // percentage-point fee/slippage haircut (round-trip)
export const HAIRCUT_5_PCT = 5;
/** Minimum valued sample for an exact 7-key profile to appear in the "top exact profiles" cohort. */
export const PRIME_MIN_EXACT_SAMPLE = 10;

export type Readiness = 'TOO_SMALL' | 'WEAK' | 'WATCH' | 'PROMISING' | 'PRIME_CANDIDATE';

// ── Structural views (read-only, tolerant of missing fields) ────────────────────────────────────

interface BuyEvent {
  type: 'RESEARCH_WOULD_BUY';
  contract: string; symbol?: string; lane: string; sourceCycle: string;
  productionGateApproved: boolean; launchAgeBucket: string;
  m5Band: string; liquidityBucket: string; vlrBucket: string; ripperScoreBand: string; ripperScore: number;
  brainAction?: string;
}
interface SellEvent {
  type: 'RESEARCH_WOULD_SELL';
  contract: string; symbol?: string; lane: string; sourceCycle: string;
  productionGateApproved: boolean; launchAgeBucket: string;
  m5Band?: string; liquidityBucket?: string; vlrBucket?: string; ripperScoreBand?: string;
  valuationUsable: boolean; pnlPct: number | null; pnlUsd: number | null;
}
type AnyEvent = BuyEvent | SellEvent | { type: string; [k: string]: unknown };

/** A profile-like shape shared by buys and trade records so one predicate applies to both. */
export interface ProfileLike {
  lane: string;
  productionGateApproved: boolean;
  launchAgeBucket: string;
  m5Band: string;
  liquidityBucket: string;
  vlrBucket: string;
  ripperScoreBand: string;
  ripperScore: number | null;
  brainAction?: string | null;
}

export interface TradeRec extends ProfileLike {
  contract: string;
  symbol?: string;
  valued: boolean;
  pnlPct: number | null;
  pnlUsd: number | null;
}

// ── Types ─────────────────────────────────────────────────────────────────────────────────────

export interface TradeRef { contract: string; symbol?: string; pnlUsd: number; pnlPct: number; }

export interface CohortStats {
  name: string;
  category: string;
  buys: number;
  valuedClosed: number;
  unvaluedExcluded: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number;                 // over valued
  redLossRate: number;             // over valued (0..1)
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
  bestTrade: TradeRef | null;
  worstTrade: TradeRef | null;
  netCappedAvgAfter2: number | null;   // cappedAvg - 2 pts
  netCappedAvgAfter5: number | null;   // cappedAvg - 5 pts
  topTradeDependencyPts: number | null;  // cappedAvg points contributed by the single best trade
  top3TradeDependencyPts: number | null; // cappedAvg points contributed by the best three trades
  readiness: Readiness;
}

export interface PrimeCandidateReportResult {
  generatedAt: string;
  eventsPath: string;
  memoryPath: string;
  totalValuedClosed: number;
  totalUnvaluedExcluded: number;
  cohorts: CohortStats[];
  bestByNetAfter2: CohortStats[];
  bestByMedian: CohortStats[];
  worstToAvoid: CohortStats[];
  primeCandidateFound: boolean;
  conclusion: string;
  // Safety.
  reportOnly: true;
  noTrades: true;
  readyForRealTrading: false;
  realTrading: false;
  noWallet: true;
  noSwap: true;
  noSigning: true;
}

export interface PrimeCandidateReportOptions {
  eventsPath?: string;
  memoryPath?: string;
  generatedAt: string;
}

// ── I/O ─────────────────────────────────────────────────────────────────────────────────────

export function readEvents(eventsPath: string): AnyEvent[] {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as AnyEvent; } catch { return null; } })
    .filter((e): e is AnyEvent => e != null);
}

// ── Pure metric helpers ─────────────────────────────────────────────────────────────────────

function clampPnl(v: number): number { return Math.max(-RESEARCH_PNL_CAP_PCT, Math.min(RESEARCH_PNL_CAP_PCT, v)); }
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

/** Leave-one-out contribution (in cappedAvg points) of the best N trades. */
function topTradeDependency(cappedSortedDesc: number[], n: number): number | null {
  if (cappedSortedDesc.length === 0) return null;
  const all = mean(cappedSortedDesc);
  const ex = mean(cappedSortedDesc.slice(n));   // drop the top n; mean([]) = 0 → fully dependent
  return all - ex;
}

// ── Readiness rules (exactly as specified) ───────────────────────────────────────────────────

export function readinessLabel(args: {
  valuedClosed: number;
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
  redLossRate: number;             // 0..1
  netAfter2: number | null;
  netAfter5: number | null;
}): Readiness {
  const { valuedClosed, medianPnlPct, cappedAveragePnlPct, redLossRate, netAfter2, netAfter5 } = args;
  const median = medianPnlPct ?? -Infinity;
  const capped = cappedAveragePnlPct ?? -Infinity;
  const redLossPct = redLossRate * 100;
  const n2 = netAfter2 ?? -Infinity;
  const n5 = netAfter5 ?? -Infinity;

  if (valuedClosed < 20) return 'TOO_SMALL';

  const prime     = valuedClosed >= 50 && median > 3 && capped > 7 && redLossPct <= 40 && n5 > 2;
  const promising = valuedClosed >= 40 && median > 2 && capped > 5 && redLossPct <= 42 && n2 > 2;
  const watch     = valuedClosed >= 30 && median > 0 && capped > 3 && redLossPct <= 45;

  if (prime) return 'PRIME_CANDIDATE';
  if (promising) return 'PROMISING';
  if (watch) return 'WATCH';
  // valued >= 20 but not good enough for WATCH → WEAK (covers "net after 2% haircut <= 0" and all else).
  return 'WEAK';
}

// ── Cohort computation ─────────────────────────────────────────────────────────────────────────

export function computeCohort(name: string, category: string, buys: BuyEvent[], trades: TradeRec[], pred: (p: ProfileLike) => boolean): CohortStats {
  const cohortBuys = buys.filter(pred).length;
  const matched = trades.filter(pred);
  const valued = matched.filter(t => t.valued);
  const unvalued = matched.length - valued.length;

  const pn = valued.map(t => t.pnlPct as number);
  const wins = pn.filter(x => x > 0).length;
  const losses = pn.filter(x => x < 0).length;
  const flats = pn.filter(x => x === 0).length;
  const v = valued.length;

  const cappedAvg = cappedAverage(pn, RESEARCH_PNL_CAP_PCT);
  const cappedSorted = pn.map(clampPnl).sort((a, b) => b - a);

  let best: TradeRef | null = null, worst: TradeRef | null = null;
  for (const t of valued) {
    const ref: TradeRef = { contract: t.contract, symbol: t.symbol, pnlUsd: t.pnlUsd ?? 0, pnlPct: t.pnlPct ?? 0 };
    if (best == null  || ref.pnlUsd > best.pnlUsd)  best = ref;
    if (worst == null || ref.pnlUsd < worst.pnlUsd) worst = ref;
  }

  const netAfter2 = cappedAvg == null ? null : cappedAvg - HAIRCUT_2_PCT;
  const netAfter5 = cappedAvg == null ? null : cappedAvg - HAIRCUT_5_PCT;
  const redLossRate = v ? losses / v : 0;

  return {
    name, category,
    buys: cohortBuys, valuedClosed: v, unvaluedExcluded: unvalued,
    wins, losses, flats,
    winRate: v ? wins / v : 0,
    redLossRate,
    medianPnlPct: median(pn),
    cappedAveragePnlPct: cappedAvg,
    bestTrade: best, worstTrade: worst,
    netCappedAvgAfter2: netAfter2,
    netCappedAvgAfter5: netAfter5,
    topTradeDependencyPts: topTradeDependency(cappedSorted, 1),
    top3TradeDependencyPts: topTradeDependency(cappedSorted, 3),
    readiness: readinessLabel({ valuedClosed: v, medianPnlPct: median(pn), cappedAveragePnlPct: cappedAvg, redLossRate, netAfter2, netAfter5 }),
  };
}

// ── Build the full report ────────────────────────────────────────────────────────────────────

const BEST_VLR_LANE = 'NO_BM_BEST_VLR';

function partsOf(p: ProfileLike): PolicyProfileParts {
  return {
    lane: p.lane, productionGateApproved: p.productionGateApproved, launchAgeBucket: p.launchAgeBucket,
    m5Band: p.m5Band, liquidityBucket: p.liquidityBucket, vlrBucket: p.vlrBucket, ripperScoreBand: p.ripperScoreBand,
  };
}

export function buildPrimeCandidateReport(events: AnyEvent[], memory: BrainPolicyMemory | null, opts: PrimeCandidateReportOptions): PrimeCandidateReportResult {
  const buys  = events.filter((e): e is BuyEvent  => e.type === 'RESEARCH_WOULD_BUY');
  const sells = events.filter((e): e is SellEvent => e.type === 'RESEARCH_WOULD_SELL');

  // Join sells → opening buys to recover full profile + ripperScore + brainAction era.
  const buyByKey = new Map<string, BuyEvent>();
  for (const b of buys) buyByKey.set(`${b.contract}|${b.lane}|${b.sourceCycle}`, b);

  const trades: TradeRec[] = sells.map(s => {
    const b = buyByKey.get(`${s.contract}|${s.lane}|${s.sourceCycle}`);
    return {
      contract: s.contract, symbol: s.symbol,
      lane: s.lane,
      productionGateApproved: s.productionGateApproved,
      launchAgeBucket: s.launchAgeBucket,
      m5Band: b?.m5Band ?? s.m5Band ?? 'UNAVAILABLE',
      liquidityBucket: b?.liquidityBucket ?? s.liquidityBucket ?? 'UNAVAILABLE',
      vlrBucket: b?.vlrBucket ?? s.vlrBucket ?? 'UNAVAILABLE',
      ripperScoreBand: b?.ripperScoreBand ?? s.ripperScoreBand ?? 'UNAVAILABLE',
      ripperScore: b?.ripperScore ?? null,
      brainAction: b?.brainAction ?? null,
      valued: s.valuationUsable === true && s.pnlPct != null,
      pnlPct: s.pnlPct, pnlUsd: s.pnlUsd,
    };
  });

  // Exact-profile status lookup (memory) for cohort 10.
  const exactStatus = (p: ProfileLike): string => memory?.profiles[policyProfileKey(partsOf(p))]?.policyStatus ?? 'WATCH';

  // Precompute "surprisingly positive" gate=false exact profiles (cohort 11): exact 7-key groups over
  // gate=false valued trades with a positive capped average and a minimum sample.
  const gateFalseByExact = new Map<string, number[]>();
  for (const t of trades) {
    if (t.productionGateApproved !== false || !t.valued) continue;
    const k = policyProfileKey(partsOf(t));
    (gateFalseByExact.get(k) ?? gateFalseByExact.set(k, []).get(k)!).push(t.pnlPct as number);
  }
  const surprisinglyPositive = new Set<string>();
  for (const [k, arr] of gateFalseByExact) {
    if (arr.length >= PRIME_MIN_EXACT_SAMPLE && (cappedAverage(arr, RESEARCH_PNL_CAP_PCT) ?? -1) > 0) surprisinglyPositive.add(k);
  }

  const gateTrue = (p: ProfileLike) => p.productionGateApproved === true;
  const score90 = (p: ProfileLike) => (p.ripperScore ?? -1) >= 90;

  const distinct = (fn: (b: BuyEvent) => string) => [...new Set(buys.map(fn))].sort();

  const cohortSpecs: Array<{ name: string; category: string; pred: (p: ProfileLike) => boolean }> = [
    { name: 'all post-brain', category: '1 baseline', pred: p => p.brainAction != null },
    { name: 'gate=true', category: '2 gate', pred: gateTrue },
    { name: 'gate=true + PRIME_WINDOW', category: '3 gate+age', pred: p => gateTrue(p) && p.launchAgeBucket === 'PRIME_WINDOW' },
    { name: 'gate=true + score>=90', category: '4 gate+score', pred: p => gateTrue(p) && score90(p) },
    { name: 'gate=true + PRIME_WINDOW + score>=90', category: '5 gate+age+score', pred: p => gateTrue(p) && p.launchAgeBucket === 'PRIME_WINDOW' && score90(p) },
    { name: 'gate=true excl NO_BM_BEST_VLR', category: '6 gate-exclLane', pred: p => gateTrue(p) && p.lane !== BEST_VLR_LANE },
    { name: 'gate=true + VLR_LT_0_5', category: '7 gate+vlr', pred: p => gateTrue(p) && p.vlrBucket === 'VLR_LT_0_5' },
    { name: 'gate=true + NO_BM_INTERNAL_BROAD', category: '8 gate+lane', pred: p => gateTrue(p) && p.lane === 'NO_BM_INTERNAL_BROAD' },
    { name: 'gate=true + NO_BM_PULLBACK', category: '9 gate+lane', pred: p => gateTrue(p) && p.lane === 'NO_BM_PULLBACK' },
    { name: 'gate=true + exact not DEMOTE/KILL', category: '10 gate+exactOK', pred: p => gateTrue(p) && exactStatus(p) !== 'DEMOTE' && exactStatus(p) !== 'KILL' },
    { name: 'gate=false + surprisingly-positive exact profiles', category: '11 gateFalsePositive', pred: p => p.productionGateApproved === false && surprisinglyPositive.has(policyProfileKey(partsOf(p))) },
  ];

  // 12 — each lane
  for (const v of distinct(b => b.lane)) cohortSpecs.push({ name: `lane=${v}`, category: '12 lane', pred: p => p.lane === v });
  // 13 — each launch age
  for (const v of distinct(b => b.launchAgeBucket)) cohortSpecs.push({ name: `age=${v}`, category: '13 age', pred: p => p.launchAgeBucket === v });
  // 14 — each m5 band
  for (const v of distinct(b => b.m5Band)) cohortSpecs.push({ name: `m5=${v}`, category: '14 m5', pred: p => p.m5Band === v });
  // 15 — each liquidity bucket
  for (const v of distinct(b => b.liquidityBucket)) cohortSpecs.push({ name: `liq=${v}`, category: '15 liq', pred: p => p.liquidityBucket === v });
  // 16 — each VLR bucket
  for (const v of distinct(b => b.vlrBucket)) cohortSpecs.push({ name: `vlr=${v}`, category: '16 vlr', pred: p => p.vlrBucket === v });

  const cohorts = cohortSpecs.map(c => computeCohort(c.name, c.category, buys, trades, c.pred));

  // 17 — top exact profiles by cappedAvg (minimum sample), each rendered as its own cohort.
  const exactGroups = new Map<string, TradeRec[]>();
  for (const t of trades) {
    if (!t.valued) continue;
    const k = policyProfileKey(partsOf(t));
    (exactGroups.get(k) ?? exactGroups.set(k, []).get(k)!).push(t);
  }
  const exactCohorts: CohortStats[] = [];
  for (const [k, arr] of exactGroups) {
    if (arr.length < PRIME_MIN_EXACT_SAMPLE) continue;
    exactCohorts.push(computeCohort(`exact:${k}`, '17 topExact', buys, trades, p => policyProfileKey(partsOf(p)) === k));
  }
  exactCohorts.sort((a, b) => (b.cappedAveragePnlPct ?? -Infinity) - (a.cappedAveragePnlPct ?? -Infinity));
  cohorts.push(...exactCohorts);

  // Rankings (exclude TOO_SMALL / <20 valued from best/worst to suppress noise).
  const rankable = cohorts.filter(c => c.valuedClosed >= 20);
  const bestByNetAfter2 = [...rankable].sort((a, b) => (b.netCappedAvgAfter2 ?? -Infinity) - (a.netCappedAvgAfter2 ?? -Infinity)).slice(0, 10);
  const bestByMedian    = [...rankable].sort((a, b) => (b.medianPnlPct ?? -Infinity) - (a.medianPnlPct ?? -Infinity)).slice(0, 10);
  const worstToAvoid    = [...rankable].sort((a, b) => (a.netCappedAvgAfter2 ?? Infinity) - (b.netCappedAvgAfter2 ?? Infinity)).slice(0, 10);

  const primeCandidateFound = cohorts.some(c => c.readiness === 'PRIME_CANDIDATE');

  return {
    generatedAt: opts.generatedAt,
    eventsPath: opts.eventsPath ?? DEFAULT_RESEARCH_SHADOW_EVENTS_PATH,
    memoryPath: opts.memoryPath ?? DEFAULT_BRAIN_POLICY_MEMORY_PATH,
    totalValuedClosed: trades.filter(t => t.valued).length,
    totalUnvaluedExcluded: trades.filter(t => !t.valued).length,
    cohorts,
    bestByNetAfter2, bestByMedian, worstToAvoid,
    primeCandidateFound,
    conclusion: primeCandidateFound ? 'Prime candidate found' : 'No prime candidate found',
    reportOnly: true, noTrades: true, readyForRealTrading: false, realTrading: false,
    noWallet: true, noSwap: true, noSigning: true,
  };
}

export function runPrimeCandidateReport(opts: Partial<PrimeCandidateReportOptions> = {}): PrimeCandidateReportResult {
  const eventsPath = opts.eventsPath ?? DEFAULT_RESEARCH_SHADOW_EVENTS_PATH;
  const memoryPath = opts.memoryPath ?? DEFAULT_BRAIN_POLICY_MEMORY_PATH;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const events = readEvents(eventsPath);
  const memory = loadBrainPolicyMemory(memoryPath);
  return buildPrimeCandidateReport(events, memory, { eventsPath, memoryPath, generatedAt });
}

// ── Renderer ─────────────────────────────────────────────────────────────────────────────────

function pnlS(v: number | null): string { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function ptsS(v: number | null): string { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1); }
function pctS(v: number): string { return (v * 100).toFixed(0) + '%'; }
function tradeS(t: TradeRef | null): string {
  if (!t) return '(none)';
  const sym = t.symbol ? `$${t.symbol}` : t.contract.slice(0, 8) + '…';
  return `${sym} ${t.pnlUsd >= 0 ? '+' : ''}$${t.pnlUsd.toFixed(2)} (${pnlS(t.pnlPct)})`;
}

function cohortBlock(c: CohortStats): string[] {
  return [
    `  [${c.readiness.padEnd(15)}] ${c.name}`,
    `      buys ${c.buys}  valued ${c.valuedClosed}  unvalued-excl ${c.unvaluedExcluded}  W/L/F ${c.wins}/${c.losses}/${c.flats}  ` +
      `win ${pctS(c.winRate)}  redLoss ${pctS(c.redLossRate)}`,
    `      median ${pnlS(c.medianPnlPct)}  cappedAvg ${pnlS(c.cappedAveragePnlPct)}  ` +
      `net-2% ${ptsS(c.netCappedAvgAfter2)}  net-5% ${ptsS(c.netCappedAvgAfter5)}  ` +
      `top1-dep ${ptsS(c.topTradeDependencyPts)}pts  top3-dep ${ptsS(c.top3TradeDependencyPts)}pts`,
    `      best ${tradeS(c.bestTrade)}  worst ${tradeS(c.worstTrade)}`,
  ];
}

function rankLine(c: CohortStats): string {
  return `    [${c.readiness.padEnd(15)}] ${c.name.padEnd(48)} ` +
    `valued ${String(c.valuedClosed).padStart(3)}  median ${pnlS(c.medianPnlPct).padStart(7)}  ` +
    `cappedAvg ${pnlS(c.cappedAveragePnlPct).padStart(7)}  net-2% ${ptsS(c.netCappedAvgAfter2).padStart(6)}  redLoss ${pctS(c.redLossRate)}`;
}

export function renderPrimeCandidateReport(r: PrimeCandidateReportResult): string {
  const WIDE = '═'.repeat(78);
  const THIN = '─'.repeat(78);
  const L: string[] = [];

  L.push(WIDE);
  L.push('  TOKEN GRAB — PRIME CANDIDATE REPORT (search for trade-worthy pockets)');
  L.push('  REPORT_ONLY  NO_TRADES  SIMULATED — NOT A BUY SIGNAL');
  L.push('  [READ ONLY — DO_NOT_ENABLE_REAL_TRADING]');
  L.push(WIDE);
  L.push('');
  L.push(`  Generated at         : ${r.generatedAt}`);
  L.push(`  Events file          : ${r.eventsPath}`);
  L.push(`  Memory file          : ${r.memoryPath}`);
  L.push(`  Total valued closed  : ${r.totalValuedClosed}   (unvalued excluded: ${r.totalUnvaluedExcluded} — never counted as flat)`);
  L.push(`  Cohorts evaluated    : ${r.cohorts.length}`);
  L.push(`  Haircuts             : 2% and 5% (percentage-point round-trip fee/slippage)`);
  L.push('');

  // Cohorts grouped by category.
  let lastCat = '';
  for (const c of r.cohorts) {
    if (c.category !== lastCat) {
      L.push(THIN);
      L.push(`  COHORT GROUP ${c.category}`);
      L.push(THIN);
      lastCat = c.category;
    }
    L.push(...cohortBlock(c));
  }
  L.push('');

  const rankSection = (title: string, rows: CohortStats[]) => {
    L.push(THIN);
    L.push(`  ${title}`);
    L.push(THIN);
    if (rows.length === 0) { L.push('    (no cohorts with >= 20 valued)'); L.push(''); return; }
    for (const c of rows) L.push(rankLine(c));
    L.push('');
  };
  rankSection('BEST 10 COHORTS by net cappedAvg after 2% haircut', r.bestByNetAfter2);
  rankSection('BEST 10 COHORTS by median P/L', r.bestByMedian);
  rankSection('WORST 10 COHORTS TO AVOID (by net cappedAvg after 2% haircut)', r.worstToAvoid);

  L.push(THIN);
  L.push('  CONCLUSION');
  L.push(THIN);
  L.push(`  >>> ${r.conclusion.toUpperCase()} <<<`);
  if (r.primeCandidateFound) {
    L.push('  A cohort met the PRIME_CANDIDATE bar — this is still PAPER research, NOT a live buy signal.');
  } else {
    L.push('  No cohort cleared the PRIME_CANDIDATE bar. Keep collecting paper/research evidence.');
  }
  L.push('');

  L.push(THIN);
  L.push('  SAFETY');
  L.push(THIN);
  L.push('  REPORT_ONLY');
  L.push('  NO_TRADES');
  L.push('  READY_FOR_REAL_TRADING=false');
  L.push('  REAL_TRADING=false');
  L.push('  NO_WALLET=true');
  L.push('  NO_SWAP=true');
  L.push('  NO_SIGNING=true');
  L.push('  UNKNOWN stays UNKNOWN — never CLEAN. Report only — no trades, no gates changed, no brain/live-shadow changes.');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);

  return L.join('\n');
}

export function renderPrimeCandidateReportUsage(): string {
  return `
token:prime-candidate-report — read-only search across ALL paper/research outcomes for narrow
strategy pockets that MIGHT be trade-worthy. Slices valued-closed research trades into many cohorts
(gate, launch-age, lane, m5, liquidity, VLR, score, exact profiles) and scores each with 2%/5%
haircuts, top-trade-dependency, and a readiness label (TOO_SMALL → PRIME_CANDIDATE).

Usage:
  npm run token:prime-candidate-report [options]

Options:
  --events <path>   research-shadow events jsonl (default: ${DEFAULT_RESEARCH_SHADOW_EVENTS_PATH})
  --memory <path>   brain policy memory json     (default: ${DEFAULT_BRAIN_POLICY_MEMORY_PATH})
  --json             emit machine-readable JSON instead of the text report
  --help              show this message

Safety:
  REPORT_ONLY  NO_TRADES  READY_FOR_REAL_TRADING=false. Excludes VALUATION_UNAVAILABLE from P/L
  (never counted as flat). Changes no gates, no brain policy, no live-shadow behaviour, and does not
  run the auto-paper or paper-buy commands. DO_NOT_ENABLE_REAL_TRADING.
`.trim();
}
