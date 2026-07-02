// RESEARCH-SHADOW REPORT
//
// DO_NOT_ENABLE_REAL_TRADING  READY_FOR_REAL_TRADING=false always.
// Report-only, read-only. Never mutates research-shadow state or events. No wallet, no signing,
// no swap. Summarizes the bankroll-independent RESEARCH_WOULD_BUY / RESEARCH_WOULD_SELL stream.
//
// RESEARCH_ONLY_NOT_EXECUTABLE — NOT_A_BUY_SIGNAL. These are simulated research observations only.

import * as fs from 'fs';
import {
  DEFAULT_RESEARCH_SHADOW_EVENTS_PATH,
  DEFAULT_RESEARCH_SHADOW_STATE_PATH,
  loadOrCreateResearchShadowState,
  type ResearchShadowEvent,
  type ResearchWouldBuyEvent,
  type ResearchWouldSellEvent,
} from './researchShadow';
import type { ShadowLane } from './liveShadow';

// ── Constants ────────────────────────────────────────────────────────────────────────────────

/** Each trade's pnlPct is clamped to ±this before the capped average, to limit outlier influence. */
export const RESEARCH_PNL_CAP_PCT = 100;

const ALL_LANES: ShadowLane[] = ['NO_BM_INTERNAL_BROAD', 'NO_BM_BEST_VLR', 'NO_BM_PULLBACK'];

// ── Pure stats helpers ─────────────────────────────────────────────────────────────────────

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Average after clamping each value to [-cap, +cap] — winsorized so a single moonshot/rug can't dominate. */
export function cappedAverage(values: number[], cap: number): number | null {
  if (values.length === 0) return null;
  const clamped = values.map(v => Math.max(-cap, Math.min(cap, v)));
  return clamped.reduce((s, v) => s + v, 0) / clamped.length;
}

// ── Types ─────────────────────────────────────────────────────────────────────────────────

export interface ResearchTradeRef {
  contract: string;
  symbol?: string;
  lane: ShadowLane;
  pnlUsd: number;
  pnlPct: number;
}

export interface ResearchLaneStats {
  lane: ShadowLane;
  buys: number;
  sells: number;
  valuedClosed: number;
  unvaluedClosed: number;
  wins: number;
  losses: number;
  flats: number;
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
}

export interface ResearchGateSplit {
  buys: number;
  valuedClosed: number;
  wins: number;
  losses: number;
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
}

export interface ResearchLaunchAgeSplit {
  buys: number;
  valuedClosed: number;
  wins: number;
  losses: number;
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
}

export interface ResearchShadowReportResult {
  generatedAt: string;
  eventsPath: string;
  statePath: string;
  // Headline counts.
  totalResearchBuys: number;
  totalResearchSells: number;
  openResearchPositions: number;
  closedValued: number;
  closedUnvalued: number;
  // Valued-trade outcomes.
  wins: number;
  losses: number;
  flats: number;
  winRate: number;
  redLossRate: number;
  medianPnlPct: number | null;
  cappedAveragePnlPct: number | null;
  cappedAveragePnlUsd: number | null;
  pnlCapPct: number;
  bestTrade: ResearchTradeRef | null;
  worstTrade: ResearchTradeRef | null;
  // Breakdowns.
  laneStats: ResearchLaneStats[];
  gateApproved: ResearchGateSplit;
  gateNotApproved: ResearchGateSplit;
  launchAge: Record<'TOO_EARLY' | 'PRIME_WINDOW' | 'OTHER', ResearchLaunchAgeSplit>;
  launchAgeAvailable: boolean;
  // Safety.
  researchOnly: true;
  notABuySignal: true;
  readyForRealTrading: false;
  realTrading: false;
  noWallet: true;
  noSwap: true;
  noSigning: true;
}

export interface ResearchShadowReportOptions {
  eventsPath?: string;
  statePath?: string;
  generatedAt?: string;
  nowMs?: number;
}

// ── I/O ─────────────────────────────────────────────────────────────────────────────────────

function readResearchEvents(eventsPath: string): ResearchShadowEvent[] {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as ResearchShadowEvent; } catch { return null; } })
    .filter((e): e is ResearchShadowEvent => e != null);
}

// ── Aggregation over valued sell events ──────────────────────────────────────────────────────

interface ValuedOutcome { wins: number; losses: number; flats: number; medianPnlPct: number | null; cappedAveragePnlPct: number | null; }

function isValuedSell(e: ResearchWouldSellEvent): boolean {
  return e.valuationUsable === true && e.pnlPct != null;
}

function summarizeValued(sells: ResearchWouldSellEvent[]): ValuedOutcome {
  const valued = sells.filter(isValuedSell);
  const pcts = valued.map(s => s.pnlPct as number);
  return {
    wins:   valued.filter(s => (s.pnlPct as number) > 0).length,
    losses: valued.filter(s => (s.pnlPct as number) < 0).length,
    flats:  valued.filter(s => (s.pnlPct as number) === 0).length,
    medianPnlPct: median(pcts),
    cappedAveragePnlPct: cappedAverage(pcts, RESEARCH_PNL_CAP_PCT),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────

export function runResearchShadowReport(opts: ResearchShadowReportOptions = {}): ResearchShadowReportResult {
  const eventsPath  = opts.eventsPath ?? DEFAULT_RESEARCH_SHADOW_EVENTS_PATH;
  const statePath   = opts.statePath  ?? DEFAULT_RESEARCH_SHADOW_STATE_PATH;
  const nowMs       = opts.nowMs ?? Date.now();
  const generatedAt = opts.generatedAt ?? new Date(nowMs).toISOString();

  const events = readResearchEvents(eventsPath);
  const buys  = events.filter((e): e is ResearchWouldBuyEvent  => e.type === 'RESEARCH_WOULD_BUY');
  const sells = events.filter((e): e is ResearchWouldSellEvent => e.type === 'RESEARCH_WOULD_SELL');
  const state = loadOrCreateResearchShadowState(statePath, generatedAt);

  const valued   = sells.filter(isValuedSell);
  const unvalued = sells.filter(s => !isValuedSell(s));
  const pcts = valued.map(s => s.pnlPct as number);

  const wins   = valued.filter(s => (s.pnlPct as number) > 0).length;
  const losses = valued.filter(s => (s.pnlPct as number) < 0).length;
  const flats  = valued.filter(s => (s.pnlPct as number) === 0).length;
  const v = valued.length;

  // Best / worst by realized USD (over valued trades only — never fabricated).
  let bestTrade: ResearchTradeRef | null = null;
  let worstTrade: ResearchTradeRef | null = null;
  for (const s of valued) {
    const ref: ResearchTradeRef = { contract: s.contract, symbol: s.symbol, lane: s.lane, pnlUsd: s.pnlUsd ?? 0, pnlPct: s.pnlPct ?? 0 };
    if (bestTrade == null  || ref.pnlUsd > bestTrade.pnlUsd)  bestTrade = ref;
    if (worstTrade == null || ref.pnlUsd < worstTrade.pnlUsd) worstTrade = ref;
  }

  const cappedAveragePnlPct = cappedAverage(pcts, RESEARCH_PNL_CAP_PCT);
  const cappedAveragePnlUsd = v ? cappedAverage(valued.map(s => s.pnlUsd ?? 0), Infinity) : null;

  // Lane-level stats.
  const laneStats: ResearchLaneStats[] = ALL_LANES.map(lane => {
    const laneSells = sells.filter(s => s.lane === lane);
    const laneValued = laneSells.filter(isValuedSell);
    const o = summarizeValued(laneSells);
    return {
      lane,
      buys: buys.filter(b => b.lane === lane).length,
      sells: laneSells.length,
      valuedClosed: laneValued.length,
      unvaluedClosed: laneSells.length - laneValued.length,
      wins: o.wins, losses: o.losses, flats: o.flats,
      medianPnlPct: o.medianPnlPct, cappedAveragePnlPct: o.cappedAveragePnlPct,
    };
  });

  // productionGateApproved true vs false.
  const gateSplit = (approved: boolean): ResearchGateSplit => {
    const gBuys  = buys.filter(b => b.productionGateApproved === approved).length;
    const gSells = sells.filter(s => s.productionGateApproved === approved);
    const gValued = gSells.filter(isValuedSell);
    const o = summarizeValued(gSells);
    return { buys: gBuys, valuedClosed: gValued.length, wins: o.wins, losses: o.losses, medianPnlPct: o.medianPnlPct, cappedAveragePnlPct: o.cappedAveragePnlPct };
  };

  // too-early vs prime-window (launchAgeBucket is carried on every research event).
  const launchAgeSplit = (match: (b: string) => boolean): ResearchLaunchAgeSplit => {
    const aBuys  = buys.filter(b => match(b.launchAgeBucket)).length;
    const aSells = sells.filter(s => match(s.launchAgeBucket));
    const aValued = aSells.filter(isValuedSell);
    const o = summarizeValued(aSells);
    return { buys: aBuys, valuedClosed: aValued.length, wins: o.wins, losses: o.losses, medianPnlPct: o.medianPnlPct, cappedAveragePnlPct: o.cappedAveragePnlPct };
  };
  const launchAgeAvailable = buys.some(b => b.launchAgeBucket != null);

  return {
    generatedAt, eventsPath, statePath,
    totalResearchBuys: buys.length,
    totalResearchSells: sells.length,
    openResearchPositions: state.openPositions.length,
    closedValued: valued.length,
    closedUnvalued: unvalued.length,
    wins, losses, flats,
    winRate:     v ? wins   / v : 0,
    redLossRate: v ? losses / v : 0,
    medianPnlPct: median(pcts),
    cappedAveragePnlPct,
    cappedAveragePnlUsd,
    pnlCapPct: RESEARCH_PNL_CAP_PCT,
    bestTrade, worstTrade,
    laneStats,
    gateApproved: gateSplit(true),
    gateNotApproved: gateSplit(false),
    launchAge: {
      TOO_EARLY:    launchAgeSplit(b => b === 'TOO_EARLY'),
      PRIME_WINDOW: launchAgeSplit(b => b === 'PRIME_WINDOW'),
      OTHER:        launchAgeSplit(b => b !== 'TOO_EARLY' && b !== 'PRIME_WINDOW'),
    },
    launchAgeAvailable,
    researchOnly: true, notABuySignal: true, readyForRealTrading: false,
    realTrading: false, noWallet: true, noSwap: true, noSigning: true,
  };
}

// ── Renderer ─────────────────────────────────────────────────────────────────────────────────

function pctS(v: number): string { return (v * 100).toFixed(1) + '%'; }
function pnlS(v: number | null): string { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function usdS(v: number | null): string { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + '$' + v.toFixed(2); }
function tradeS(t: ResearchTradeRef | null): string {
  if (!t) return '(none)';
  const sym = t.symbol ? `$${t.symbol}` : t.contract.slice(0, 10) + '…';
  return `${sym}  ${usdS(t.pnlUsd)}  (${pnlS(t.pnlPct)})  [${t.lane}]`;
}

export function renderResearchShadowReport(r: ResearchShadowReportResult): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const L: string[] = [];

  L.push(WIDE);
  L.push('  TOKEN GRAB — RESEARCH-SHADOW REPORT (bankroll-independent learning stream)');
  L.push('  RESEARCH_ONLY_NOT_EXECUTABLE — NOT_A_BUY_SIGNAL — SIMULATED');
  L.push('  [REPORT ONLY — READ ONLY — DO_NOT_ENABLE_REAL_TRADING]');
  L.push(WIDE);
  L.push('');
  L.push(`  Generated at            : ${r.generatedAt}`);
  L.push(`  Events file             : ${r.eventsPath}`);
  L.push(`  State file              : ${r.statePath}`);
  L.push('');
  L.push(THIN);
  L.push('  HEADLINE');
  L.push(THIN);
  L.push(`    Total research buys   : ${r.totalResearchBuys}`);
  L.push(`    Total research sells  : ${r.totalResearchSells}`);
  L.push(`    Open research positions: ${r.openResearchPositions}`);
  L.push(`    Closed valued/unvalued: ${r.closedValued} / ${r.closedUnvalued}  ${r.closedUnvalued > 0 ? '(VALUATION_UNAVAILABLE — excluded from P/L, NOT counted as flat)' : ''}`);
  L.push('');
  L.push(`    Win / Loss / Flat     : ${r.wins} / ${r.losses} / ${r.flats}   (flat = real $0 move only; over ${r.closedValued} valued)`);
  L.push(`    Win rate              : ${pctS(r.winRate)}`);
  L.push(`    Red-loss rate         : ${pctS(r.redLossRate)}`);
  L.push(`    Median P/L            : ${pnlS(r.medianPnlPct)}`);
  L.push(`    Capped average P/L    : ${pnlS(r.cappedAveragePnlPct)}  (each trade clamped to ±${r.pnlCapPct}% before averaging)`);
  L.push(`    Capped average P/L $  : ${usdS(r.cappedAveragePnlUsd)}`);
  L.push(`    Best trade            : ${tradeS(r.bestTrade)}`);
  L.push(`    Worst trade           : ${tradeS(r.worstTrade)}`);
  L.push('');

  L.push(THIN);
  L.push('  LANE-LEVEL STATS (paper-only research lanes)');
  L.push(THIN);
  for (const s of r.laneStats) {
    L.push(`    ${s.lane}`);
    L.push(`      buys ${s.buys}  sells ${s.sells}  valued ${s.valuedClosed}  unvalued ${s.unvaluedClosed}  ` +
      `W/L/F ${s.wins}/${s.losses}/${s.flats}  median ${pnlS(s.medianPnlPct)}  cappedAvg ${pnlS(s.cappedAveragePnlPct)}`);
  }
  L.push('');

  L.push(THIN);
  L.push('  PRODUCTION GATE (reported — NEVER blocking a research decision)');
  L.push(THIN);
  L.push(`    productionGateApproved=true  : buys ${r.gateApproved.buys}  valued ${r.gateApproved.valuedClosed}  ` +
    `W/L ${r.gateApproved.wins}/${r.gateApproved.losses}  median ${pnlS(r.gateApproved.medianPnlPct)}  cappedAvg ${pnlS(r.gateApproved.cappedAveragePnlPct)}`);
  L.push(`    productionGateApproved=false : buys ${r.gateNotApproved.buys}  valued ${r.gateNotApproved.valuedClosed}  ` +
    `W/L ${r.gateNotApproved.wins}/${r.gateNotApproved.losses}  median ${pnlS(r.gateNotApproved.medianPnlPct)}  cappedAvg ${pnlS(r.gateNotApproved.cappedAveragePnlPct)}`);
  L.push('');

  L.push(THIN);
  L.push('  LAUNCH-AGE WINDOW (too-early vs prime-window)');
  L.push(THIN);
  if (r.launchAgeAvailable) {
    const rows: Array<['TOO_EARLY' | 'PRIME_WINDOW' | 'OTHER', string]> = [
      ['TOO_EARLY', 'TOO_EARLY   '], ['PRIME_WINDOW', 'PRIME_WINDOW'], ['OTHER', 'OTHER       '],
    ];
    for (const [k, label] of rows) {
      const s = r.launchAge[k];
      L.push(`    ${label} : buys ${s.buys}  valued ${s.valuedClosed}  W/L ${s.wins}/${s.losses}  ` +
        `median ${pnlS(s.medianPnlPct)}  cappedAvg ${pnlS(s.cappedAveragePnlPct)}`);
    }
  } else {
    L.push('    launchAgeBucket not available on recorded events.');
  }
  L.push('');

  L.push(THIN);
  L.push('  READINESS & SAFETY');
  L.push(THIN);
  L.push('  RESEARCH_ONLY_NOT_EXECUTABLE');
  L.push('  NOT_A_BUY_SIGNAL');
  L.push('  READY_FOR_REAL_TRADING=false');
  L.push('  REAL_TRADING=false  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true');
  L.push('  UNKNOWN stays UNKNOWN — never CLEAN.  Independent of bankroll caps; never executes trades.');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);

  return L.join('\n');
}

export function renderResearchShadowReportUsage(): string {
  return `
token:research-shadow-report — summarize the bankroll-independent RESEARCH-SHADOW stream.

Records a RESEARCH_WOULD_BUY for every fresh candidate that matches an internal shadow lane —
even when the $20/$50/$100 bankroll daily-buy caps blocked the normal would-buy — so research
never stops accumulating. This report is RESEARCH_ONLY_NOT_EXECUTABLE and NOT_A_BUY_SIGNAL.

Usage:
  npm run token:research-shadow-report [options]

Options:
  --events <path>   research-shadow events jsonl (default: ${DEFAULT_RESEARCH_SHADOW_EVENTS_PATH})
  --state <path>    research-shadow state file   (default: ${DEFAULT_RESEARCH_SHADOW_STATE_PATH})
  --json             emit machine-readable JSON instead of the text report
  --help              show this message

Safety:
  Report only. Never mutates research-shadow state or events. READY_FOR_REAL_TRADING=false.
  No wallet, no signing, no swap. Does not run token:auto-paper or token:paper-buy.
`.trim();
}
