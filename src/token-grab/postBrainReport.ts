// TOKEN GRAB — POST-BRAIN REPORT (read-only)
//
// REPORT_ONLY  NO_TRADES  DO_NOT_ENABLE_REAL_TRADING  REAL_TRADING=false  READY_FOR_REAL_TRADING=false
// NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true
//
// Measures whether Brain v1.1 improved research-shadow performance AFTER it started influencing
// entries. It splits the RESEARCH_WOULD_BUY / RESEARCH_WOULD_SELL stream into two eras:
//   • PRE-BRAIN  — entry decisions made before the brain was consulted (buy has NO brainAction).
//   • POST-BRAIN — entry decisions made while the brain was active (buy carries a brainAction).
// A closed trade (sell) is attributed to the era of its OPENING buy (joined by contract|lane|
// sourceCycle), because that is when the brain could have influenced the decision.
//
// P/L is measured ONLY over valued closed trades (valuationUsable). VALUATION_UNAVAILABLE trades
// are excluded from every P/L statistic and are NEVER counted as flat. This module reads only —
// it opens no positions, changes no gates, changes no brain rules, and never touches a wallet,
// swap, signature, or the auto-paper / paper-buy commands.

import * as fs from 'fs';
import { median, cappedAverage, RESEARCH_PNL_CAP_PCT } from './researchShadowReport';
import { DEFAULT_RESEARCH_SHADOW_EVENTS_PATH } from './researchShadow';
import { DEFAULT_BRAIN_POLICY_MEMORY_PATH, loadBrainPolicyMemory, type BrainPolicyMemory } from './brainPolicy';

// ── Minimal structural views of the stream (read-only; tolerant of missing fields) ──────────────

interface BuyEvent {
  type: 'RESEARCH_WOULD_BUY';
  ts: string; contract: string; lane: string; sourceCycle: string;
  productionGateApproved: boolean; launchAgeBucket: string;
  brainAction?: string;
}
interface SellEvent {
  type: 'RESEARCH_WOULD_SELL';
  ts: string; contract: string; lane: string; sourceCycle: string;
  productionGateApproved: boolean; launchAgeBucket: string;
  valuationUsable: boolean; pnlPct: number | null; pnlUsd: number | null;
}
interface SkipEvent {
  type: 'RESEARCH_SKIPPED_BY_BRAIN';
  ts: string; contract: string; lane: string;
  brainStatus: 'KILL' | 'DEMOTE';
}
type AnyEvent = BuyEvent | SellEvent | SkipEvent | { type: string; [k: string]: unknown };

export type Era = 'pre' | 'post';

// ── Types ─────────────────────────────────────────────────────────────────────────────────────

export interface EraStats {
  valuedClosed: number;
  unvaluedClosed: number;      // VALUATION_UNAVAILABLE — excluded from P/L, NEVER counted as flat
  wins: number;
  losses: number;
  flats: number;               // REAL flat only (valued AND pnl == 0)
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
  redLossRate: number;
}

export interface LaneEraStats { lane: string; pre: EraStats; post: EraStats; }
export interface GateEraStats { productionGateApproved: boolean; pre: EraStats; post: EraStats; }

export interface KilledLaneSuppression {
  lane: string;
  buysPre: number;
  buysPost: number;
  skipsPost: number;
  suppressionRate: number;     // skips / (skips + post-brain buys)
  stoppedOpening: boolean;     // no post-brain buys at all
  // v1.2 sticky-KILL view: measured against the sticky killedAt (not just brain activation).
  killedAt: string | null;
  recoveryState: string | null;
  buysAfterKill: number;       // research buys in this lane with ts >= killedAt
  skipsAfterKill: number;      // skips in this lane with ts >= killedAt
  trulyStoppedAfterKill: boolean;  // sticky KILL held: zero buys opened after killedAt
}

export interface PostBrainReportResult {
  generatedAt: string;
  eventsPath: string;
  memoryPath: string;
  brainActivatedAt: string | null;
  brainActive: boolean;
  pre: EraStats;
  post: EraStats;
  laneStats: LaneEraStats[];
  gateStats: GateEraStats[];
  skippedByBrainTotal: number;
  skippedByStatus: { KILL: number; DEMOTE: number };
  promoteAnnotations: number;
  watchAnnotations: number;
  killDemoteSuppressions: number;
  killedLaneSuppression: KilledLaneSuppression[];
  // Safety.
  reportOnly: true;
  noTrades: true;
  readyForRealTrading: false;
  realTrading: false;
  noWallet: true;
  noSwap: true;
  noSigning: true;
}

export interface PostBrainReportOptions {
  eventsPath?: string;
  memoryPath?: string;
  generatedAt: string;
}

// ── I/O ─────────────────────────────────────────────────────────────────────────────────────

export function readResearchEvents(eventsPath: string): AnyEvent[] {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as AnyEvent; } catch { return null; } })
    .filter((e): e is AnyEvent => e != null);
}

// ── Pure computation ─────────────────────────────────────────────────────────────────────────

function isValued(s: SellEvent): boolean {
  return s.valuationUsable === true && s.pnlPct != null;
}

function eraStats(sells: SellEvent[]): EraStats {
  const valued = sells.filter(isValued);
  const pn = valued.map(s => s.pnlPct as number);
  const losses = pn.filter(x => x < 0).length;
  return {
    valuedClosed: valued.length,
    unvaluedClosed: sells.length - valued.length,
    wins: pn.filter(x => x > 0).length,
    losses,
    flats: pn.filter(x => x === 0).length,
    medianPnlPct: median(pn),
    cappedAveragePnlPct: cappedAverage(pn, RESEARCH_PNL_CAP_PCT),
    redLossRate: valued.length ? losses / valued.length : 0,
  };
}

export function buildPostBrainReport(events: AnyEvent[], memory: BrainPolicyMemory | null, opts: PostBrainReportOptions): PostBrainReportResult {
  const buys  = events.filter((e): e is BuyEvent  => e.type === 'RESEARCH_WOULD_BUY');
  const sells = events.filter((e): e is SellEvent => e.type === 'RESEARCH_WOULD_SELL');
  const skips = events.filter((e): e is SkipEvent => e.type === 'RESEARCH_SKIPPED_BY_BRAIN');

  // Brain activation boundary: the earliest event that proves the brain was active — a buy carrying
  // a brainAction, or any RESEARCH_SKIPPED_BY_BRAIN. Null → brain never active → all events are pre.
  const activationTs = [
    ...buys.filter(b => b.brainAction != null).map(b => b.ts),
    ...skips.map(s => s.ts),
  ].filter(Boolean).sort();
  const brainActivatedAt = activationTs[0] ?? null;

  // Opening-buy join so a sell inherits its entry decision's era.
  const buyByKey = new Map<string, BuyEvent>();
  for (const b of buys) buyByKey.set(`${b.contract}|${b.lane}|${b.sourceCycle}`, b);

  const buyEra = (b: BuyEvent): Era => (b.brainAction != null ? 'post' : 'pre');
  const sellEra = (s: SellEvent): Era => {
    const b = buyByKey.get(`${s.contract}|${s.lane}|${s.sourceCycle}`);
    if (b) return buyEra(b);
    return brainActivatedAt != null && s.ts >= brainActivatedAt ? 'post' : 'pre';
  };

  const preSells  = sells.filter(s => sellEra(s) === 'pre');
  const postSells = sells.filter(s => sellEra(s) === 'post');

  // Lane pre/post.
  const lanes = [...new Set(sells.map(s => s.lane))].sort();
  const laneStats: LaneEraStats[] = lanes.map(lane => ({
    lane,
    pre:  eraStats(preSells.filter(s => s.lane === lane)),
    post: eraStats(postSells.filter(s => s.lane === lane)),
  }));

  // productionGateApproved pre/post.
  const gateStats: GateEraStats[] = [true, false].map(g => ({
    productionGateApproved: g,
    pre:  eraStats(preSells.filter(s => s.productionGateApproved === g)),
    post: eraStats(postSells.filter(s => s.productionGateApproved === g)),
  }));

  // Suppression counters.
  const skippedByStatus = { KILL: 0, DEMOTE: 0 };
  for (const s of skips) { if (s.brainStatus === 'KILL') skippedByStatus.KILL++; else if (s.brainStatus === 'DEMOTE') skippedByStatus.DEMOTE++; }
  const promoteAnnotations = buys.filter(b => b.brainAction === 'PROMOTE').length;
  const watchAnnotations   = buys.filter(b => b.brainAction === 'WATCH').length;

  // Killed/suppressed lanes — ground truth from skip events, plus lane-scoped global KILL/DEMOTE.
  // Also capture the sticky killedAt anchor (v1.2) so we can measure "did it stop opening after
  // the kill became sticky", not just after brain activation.
  const suppressedLanes = new Set<string>(skips.map(s => s.lane));
  const laneKilledAt = new Map<string, string | null>();
  const laneRecoveryState = new Map<string, string | null>();
  if (memory) {
    for (const g of Object.values(memory.globalGroups ?? {})) {
      if (g.dimension === 'lane' && (g.policyStatus === 'KILL' || g.policyStatus === 'DEMOTE')) {
        suppressedLanes.add(g.value);
        laneKilledAt.set(g.value, g.killedAt ?? null);
        laneRecoveryState.set(g.value, g.recoveryState ?? null);
      }
    }
  }
  const killedLaneSuppression: KilledLaneSuppression[] = [...suppressedLanes].sort().map(lane => {
    const buysPre  = buys.filter(b => b.lane === lane && buyEra(b) === 'pre').length;
    const buysPost = buys.filter(b => b.lane === lane && buyEra(b) === 'post').length;
    const skipsPost = skips.filter(s => s.lane === lane).length;
    const denom = buysPost + skipsPost;
    const killedAt = laneKilledAt.get(lane) ?? null;
    const buysAfterKill  = killedAt ? buys.filter(b => b.lane === lane && b.ts >= killedAt).length : buysPost;
    const skipsAfterKill = killedAt ? skips.filter(s => s.lane === lane && s.ts >= killedAt).length : skipsPost;
    return {
      lane, buysPre, buysPost, skipsPost,
      suppressionRate: denom ? skipsPost / denom : 0,
      stoppedOpening: buysPost === 0,
      killedAt,
      recoveryState: laneRecoveryState.get(lane) ?? null,
      buysAfterKill, skipsAfterKill,
      trulyStoppedAfterKill: killedAt != null && buysAfterKill === 0,
    };
  });

  return {
    generatedAt: opts.generatedAt,
    eventsPath: opts.eventsPath ?? DEFAULT_RESEARCH_SHADOW_EVENTS_PATH,
    memoryPath: opts.memoryPath ?? DEFAULT_BRAIN_POLICY_MEMORY_PATH,
    brainActivatedAt,
    brainActive: brainActivatedAt != null,
    pre: eraStats(preSells),
    post: eraStats(postSells),
    laneStats,
    gateStats,
    skippedByBrainTotal: skips.length,
    skippedByStatus,
    promoteAnnotations,
    watchAnnotations,
    killDemoteSuppressions: skips.length,
    killedLaneSuppression,
    reportOnly: true, noTrades: true, readyForRealTrading: false, realTrading: false,
    noWallet: true, noSwap: true, noSigning: true,
  };
}

export function runPostBrainReport(opts: Partial<PostBrainReportOptions> = {}): PostBrainReportResult {
  const eventsPath = opts.eventsPath ?? DEFAULT_RESEARCH_SHADOW_EVENTS_PATH;
  const memoryPath = opts.memoryPath ?? DEFAULT_BRAIN_POLICY_MEMORY_PATH;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const events = readResearchEvents(eventsPath);
  const memory = loadBrainPolicyMemory(memoryPath);
  return buildPostBrainReport(events, memory, { eventsPath, memoryPath, generatedAt });
}

// ── Renderer ─────────────────────────────────────────────────────────────────────────────────

function pnlS(v: number | null): string { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function pctS(v: number): string { return (v * 100).toFixed(0) + '%'; }
function deltaS(pre: number | null, post: number | null): string {
  if (pre == null || post == null) return '';
  const d = post - pre;
  return `  (Δ ${d >= 0 ? '+' : ''}${d.toFixed(1)})`;
}

function statLine(label: string, s: EraStats): string {
  return `    ${label.padEnd(6)} valued ${String(s.valuedClosed).padStart(3)}  W/L/F ${s.wins}/${s.losses}/${s.flats}  ` +
    `median ${pnlS(s.medianPnlPct)}  cappedAvg ${pnlS(s.cappedAveragePnlPct)}  redLoss ${pctS(s.redLossRate)}  ` +
    `(unvalued ${s.unvaluedClosed} excluded)`;
}

export function renderPostBrainReport(r: PostBrainReportResult): string {
  const WIDE = '═'.repeat(74);
  const THIN = '─'.repeat(74);
  const L: string[] = [];

  L.push(WIDE);
  L.push('  TOKEN GRAB — POST-BRAIN REPORT (did Brain v1.1 improve performance?)');
  L.push('  REPORT_ONLY  NO_TRADES  SIMULATED — NOT A BUY SIGNAL');
  L.push('  [READ ONLY — DO_NOT_ENABLE_REAL_TRADING]');
  L.push(WIDE);
  L.push('');
  L.push(`  Generated at     : ${r.generatedAt}`);
  L.push(`  Events file      : ${r.eventsPath}`);
  L.push(`  Memory file      : ${r.memoryPath}`);
  L.push(`  Brain active     : ${r.brainActive}`);
  L.push(`  Brain activated  : ${r.brainActivatedAt ?? '(never — all events are PRE-brain)'}`);
  L.push('  Era = era of the OPENING buy (brainAction present ⇒ POST). Unvalued excluded from P/L.');
  L.push('');

  L.push(THIN);
  L.push('  OVERALL VALUED CLOSED — PRE vs POST');
  L.push(THIN);
  L.push(`    Pre-brain valued closed  : ${r.pre.valuedClosed}    (unvalued excluded: ${r.pre.unvaluedClosed})`);
  L.push(`    Post-brain valued closed : ${r.post.valuedClosed}    (unvalued excluded: ${r.post.unvaluedClosed})`);
  L.push('');
  L.push(`    Win/Loss/Flat   PRE ${r.pre.wins}/${r.pre.losses}/${r.pre.flats}    POST ${r.post.wins}/${r.post.losses}/${r.post.flats}`);
  L.push(`    Median P/L      PRE ${pnlS(r.pre.medianPnlPct)}    POST ${pnlS(r.post.medianPnlPct)}${deltaS(r.pre.medianPnlPct, r.post.medianPnlPct)}`);
  L.push(`    CappedAvg P/L   PRE ${pnlS(r.pre.cappedAveragePnlPct)}    POST ${pnlS(r.post.cappedAveragePnlPct)}${deltaS(r.pre.cappedAveragePnlPct, r.post.cappedAveragePnlPct)}`);
  L.push(`    Red-loss rate   PRE ${pctS(r.pre.redLossRate)}    POST ${pctS(r.post.redLossRate)}  (Δ ${((r.post.redLossRate - r.pre.redLossRate) * 100).toFixed(0)} pts)`);
  L.push('');

  L.push(THIN);
  L.push('  LANE STATS — PRE vs POST');
  L.push(THIN);
  for (const ls of r.laneStats) {
    L.push(`  ${ls.lane}`);
    L.push(statLine('PRE', ls.pre));
    L.push(statLine('POST', ls.post));
  }
  L.push('');

  L.push(THIN);
  L.push('  productionGateApproved — PRE vs POST');
  L.push(THIN);
  for (const gs of r.gateStats) {
    L.push(`  gate=${gs.productionGateApproved}`);
    L.push(statLine('PRE', gs.pre));
    L.push(statLine('POST', gs.post));
  }
  L.push('');

  L.push(THIN);
  L.push('  BRAIN ACTIVITY');
  L.push(THIN);
  L.push(`    RESEARCH_SKIPPED_BY_BRAIN total : ${r.skippedByBrainTotal}   (KILL ${r.skippedByStatus.KILL}  DEMOTE ${r.skippedByStatus.DEMOTE})`);
  L.push(`    KILL/DEMOTE suppressions        : ${r.killDemoteSuppressions}`);
  L.push(`    PROMOTE annotations (buys)      : ${r.promoteAnnotations}`);
  L.push(`    WATCH annotations (buys)        : ${r.watchAnnotations}`);
  L.push('');

  L.push(THIN);
  L.push('  KILLED / SUPPRESSED LANE — DID IT STOP OPENING? (sticky KILL uses killedAt anchor)');
  L.push(THIN);
  if (r.killedLaneSuppression.length === 0) {
    L.push('    (no lanes killed/demoted yet)');
  } else {
    for (const k of r.killedLaneSuppression) {
      L.push(`    ${k.lane}`);
      L.push(`        [brain-activation] buys pre ${k.buysPre}   buys post ${k.buysPost}   skipped post ${k.skipsPost}   ` +
        `suppression ${pctS(k.suppressionRate)}   stoppedOpening=${k.stoppedOpening}`);
      if (k.killedAt) {
        L.push(`        [sticky killedAt ${k.killedAt} state=${k.recoveryState ?? 'KILLED'}] ` +
          `buys after kill ${k.buysAfterKill}   skips after kill ${k.skipsAfterKill}   ` +
          `trulyStoppedAfterKill=${k.trulyStoppedAfterKill}`);
      } else {
        L.push('        [sticky] not currently a sticky KILL in memory (no killedAt)');
      }
    }
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
  L.push('  UNKNOWN stays UNKNOWN — never CLEAN. Report only — no trades, no gates changed, no brain rules changed.');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);

  return L.join('\n');
}

export function renderPostBrainReportUsage(): string {
  return `
token:post-brain-report — read-only: did Brain v1.1 improve research-shadow performance after it
started influencing entries? Splits the research-shadow stream into PRE-brain (entry buys with no
brainAction) and POST-brain (buys carrying a brainAction) and compares valued-closed P/L, per lane
and per productionGateApproved, plus skip / promote / kill-suppression counts.

Usage:
  npm run token:post-brain-report [options]

Options:
  --events <path>   research-shadow events jsonl (default: ${DEFAULT_RESEARCH_SHADOW_EVENTS_PATH})
  --memory <path>   brain policy memory json     (default: ${DEFAULT_BRAIN_POLICY_MEMORY_PATH})
  --json             emit machine-readable JSON instead of the text report
  --help              show this message

Safety:
  REPORT_ONLY  NO_TRADES  READY_FOR_REAL_TRADING=false. Excludes VALUATION_UNAVAILABLE from P/L
  (never counted as flat). Opens no positions, changes no gates, changes no brain rules, and does
  not run the auto-paper or paper-buy commands. DO_NOT_ENABLE_REAL_TRADING.
`.trim();
}
