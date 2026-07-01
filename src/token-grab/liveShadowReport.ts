// LIVE-SHADOW REPORT
//
// DO_NOT_ENABLE_REAL_TRADING  READY_FOR_REAL_TRADING=false always
// Report-only, read-only. Never mutates live-shadow state or events. No wallet, no signing,
// no swap execution — this module never touches real funds.

import * as fs from 'fs';
import {
  BANKROLL_TIERS,
  DEFAULT_RISK_LIMITS,
  DEFAULT_LIVE_SHADOW_STATE_PATH,
  DEFAULT_LIVE_SHADOW_EVENTS_PATH,
  loadOrCreateLiveShadowState,
  type BankrollTier,
  type LiveShadowEvent,
  type LiveShadowPosition,
} from './liveShadow';

// ── Types ─────────────────────────────────────────────────────────────────────────────────

export interface LiveShadowTradeRef {
  contract: string;
  symbol?: string;
  pnlUsd: number;
  pnlPct: number;
}

export interface LiveShadowBankrollReport {
  bankroll: BankrollTier;
  wouldBuyEvents: number;
  wouldSellEvents: number;
  openPositions: number;
  closedPositions: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number;
  redLossRate: number;
  simulatedPnlUsd: number;
  simulatedPnlPct: number;
  maxDrawdownUsd: number;
  worstTrade: LiveShadowTradeRef | null;
  bestTrade: LiveShadowTradeRef | null;
  riskLimitViolations: number;
  killSwitchActive: boolean;
  killSwitchReason?: string;
  maxPositionSizeUsd: number;
  maxDailyBuys: number;
  maxDailyLossUsd: number;
  openPositionCap: number;
}

export interface LiveShadowReportResult {
  generatedAt: string;
  eventsPath: string;
  statePath: string;
  totalWouldBuyEvents: number;
  totalWouldSellEvents: number;
  bankrolls: LiveShadowBankrollReport[];
  readyForRealTrading: false;
  liveShadowOnly: true;
  realTrading: false;
  noWallet: true;
  noSwap: true;
  noSigning: true;
}

export interface LiveShadowReportOptions {
  eventsPath?: string;
  statePath?: string;
  generatedAt?: string;
  nowMs?: number;
}

// ── I/O helpers ───────────────────────────────────────────────────────────────────────────

function readLiveShadowEvents(eventsPath: string): LiveShadowEvent[] {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as LiveShadowEvent; } catch { return null; } })
    .filter((e): e is LiveShadowEvent => e != null);
}

function maxDrawdownUsd(closed: LiveShadowPosition[]): number {
  const sorted = [...closed]
    .filter(p => p.closedAt != null)
    .sort((a, b) => (a.closedAt! < b.closedAt! ? -1 : a.closedAt! > b.closedAt! ? 1 : 0));

  let equity = 0, peak = 0, worstDrawdown = 0;
  for (const p of sorted) {
    equity += p.pnlUsd ?? 0;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > worstDrawdown) worstDrawdown = drawdown;
  }
  return worstDrawdown;
}

function extremeTrade(closed: LiveShadowPosition[], pick: 'worst' | 'best'): LiveShadowTradeRef | null {
  if (closed.length === 0) return null;
  const chosen = closed.reduce((a, b) => {
    const av = a.pnlUsd ?? 0, bv = b.pnlUsd ?? 0;
    return pick === 'worst' ? (av <= bv ? a : b) : (av >= bv ? a : b);
  });
  return { contract: chosen.contract, symbol: chosen.symbol, pnlUsd: chosen.pnlUsd ?? 0, pnlPct: chosen.pnlPct ?? 0 };
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────

export function runLiveShadowReport(opts: LiveShadowReportOptions = {}): LiveShadowReportResult {
  const eventsPath  = opts.eventsPath ?? DEFAULT_LIVE_SHADOW_EVENTS_PATH;
  const statePath   = opts.statePath  ?? DEFAULT_LIVE_SHADOW_STATE_PATH;
  const nowMs       = opts.nowMs ?? Date.now();
  const generatedAt = opts.generatedAt ?? new Date(nowMs).toISOString();

  const events = readLiveShadowEvents(eventsPath);
  const state  = loadOrCreateLiveShadowState(statePath, generatedAt);

  const totalWouldBuyEvents  = events.filter(e => e.type === 'WOULD_BUY').length;
  const totalWouldSellEvents = events.filter(e => e.type === 'WOULD_SELL').length;

  const bankrolls: LiveShadowBankrollReport[] = BANKROLL_TIERS.map(tier => {
    const bs = state.bankrolls[tier];
    const closed = bs?.closedPositions ?? [];
    const n = closed.length;
    const wins   = closed.filter(p => (p.pnlPct ?? 0) > 0).length;
    const losses = closed.filter(p => (p.pnlPct ?? 0) < 0).length;
    const flats  = closed.filter(p => (p.pnlPct ?? 0) === 0).length;
    const simulatedPnlUsd = closed.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
    const simulatedPnlPct = n ? closed.reduce((s, p) => s + (p.pnlPct ?? 0), 0) / n : 0;
    const riskCfg = DEFAULT_RISK_LIMITS[tier];

    return {
      bankroll: tier,
      wouldBuyEvents:  events.filter(e => e.type === 'WOULD_BUY'  && e.bankroll === tier).length,
      wouldSellEvents: events.filter(e => e.type === 'WOULD_SELL' && e.bankroll === tier).length,
      openPositions: bs?.openPositions.length ?? 0,
      closedPositions: n,
      wins, losses, flats,
      winRate:     n ? wins   / n : 0,
      redLossRate: n ? losses / n : 0,
      simulatedPnlUsd, simulatedPnlPct,
      maxDrawdownUsd: maxDrawdownUsd(closed),
      worstTrade: extremeTrade(closed, 'worst'),
      bestTrade:  extremeTrade(closed, 'best'),
      riskLimitViolations: bs?.skippedByRiskLimit ?? 0,
      killSwitchActive: bs?.killSwitchActive ?? false,
      killSwitchReason: bs?.killSwitchReason,
      maxPositionSizeUsd: riskCfg.maxPositionSizeUsd,
      maxDailyBuys: riskCfg.maxDailyBuys,
      maxDailyLossUsd: riskCfg.maxDailyLossUsd,
      openPositionCap: riskCfg.openPositionCap,
    };
  });

  return {
    generatedAt, eventsPath, statePath,
    totalWouldBuyEvents, totalWouldSellEvents, bankrolls,
    readyForRealTrading: false,
    liveShadowOnly: true, realTrading: false, noWallet: true, noSwap: true, noSigning: true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────────────────

function pctS(v: number): string { return (v * 100).toFixed(1) + '%'; }
function pnlS(v: number): string { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function usdS(v: number): string { return (v >= 0 ? '+' : '') + '$' + v.toFixed(2); }
function tradeS(t: LiveShadowTradeRef | null): string {
  if (!t) return '(none)';
  const sym = t.symbol ? `$${t.symbol}` : t.contract.slice(0, 10) + '…';
  return `${sym}  ${usdS(t.pnlUsd)}  (${pnlS(t.pnlPct)})`;
}

export function renderLiveShadowReport(r: LiveShadowReportResult): string {
  const WIDE = '═'.repeat(70);
  const THIN = '─'.repeat(70);
  const L: string[] = [];

  L.push(WIDE);
  L.push('  TOKEN GRAB — LIVE-SHADOW REPORT (SIMULATED — NOT REAL TRADING)');
  L.push('  [REPORT ONLY — READ ONLY — DO_NOT_ENABLE_REAL_TRADING]');
  L.push(WIDE);
  L.push('');
  L.push(`  Generated at   : ${r.generatedAt}`);
  L.push(`  Events file    : ${r.eventsPath}`);
  L.push(`  State file     : ${r.statePath}`);
  L.push(`  Would-buy total  : ${r.totalWouldBuyEvents}`);
  L.push(`  Would-sell total : ${r.totalWouldSellEvents}`);
  L.push('');

  for (const b of r.bankrolls) {
    L.push(THIN);
    L.push(`  $${b.bankroll} BANKROLL`);
    L.push(THIN);
    L.push(`    Would-buy events   : ${b.wouldBuyEvents}`);
    L.push(`    Would-sell events  : ${b.wouldSellEvents}`);
    L.push(`    Open positions     : ${b.openPositions}`);
    L.push(`    Closed positions   : ${b.closedPositions}`);
    L.push(`    Win / Loss / Flat  : ${b.wins} / ${b.losses} / ${b.flats}`);
    L.push(`    Win rate           : ${pctS(b.winRate)}`);
    L.push(`    Red-loss rate      : ${pctS(b.redLossRate)}`);
    L.push(`    Simulated P/L      : ${usdS(b.simulatedPnlUsd)}  (avg ${pnlS(b.simulatedPnlPct)}/trade)`);
    L.push(`    Max drawdown       : $${b.maxDrawdownUsd.toFixed(2)}`);
    L.push(`    Worst trade        : ${tradeS(b.worstTrade)}`);
    L.push(`    Best trade         : ${tradeS(b.bestTrade)}`);
    L.push('');
    L.push(`    Max position size  : $${b.maxPositionSizeUsd}`);
    L.push(`    Max daily buys     : ${b.maxDailyBuys}`);
    L.push(`    Max daily loss     : $${b.maxDailyLossUsd}`);
    L.push(`    Open position cap  : ${b.openPositionCap}`);
    L.push(`    Risk limit skips   : ${b.riskLimitViolations}  ${b.riskLimitViolations > 0 ? '(would have violated risk limits)' : '(no violations)'}`);
    L.push(`    Kill-switch        : ${b.killSwitchActive ? `ACTIVE — ${b.killSwitchReason ?? ''}` : 'inactive'}`);
    L.push('');
  }

  L.push(THIN);
  L.push('  READINESS');
  L.push(THIN);
  L.push('  READY_FOR_REAL_TRADING=false');
  L.push('  This is simulated, paper-only research. No trade was ever executed.');
  L.push('');

  L.push(THIN);
  L.push('  SAFETY');
  L.push(THIN);
  L.push('  LIVE_SHADOW_ONLY=true  REAL_TRADING=false  NO_WALLET=true  NO_SWAP=true  NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING');
  L.push(WIDE);

  return L.join('\n');
}

export function renderLiveShadowReportUsage(): string {
  return `
token:live-shadow-report — summarize simulated LIVE-SHADOW would-buy/would-sell events.

Usage:
  npm run token:live-shadow-report [options]

Options:
  --events <path>   live-shadow events jsonl (default: ${DEFAULT_LIVE_SHADOW_EVENTS_PATH})
  --state <path>    live-shadow state file   (default: ${DEFAULT_LIVE_SHADOW_STATE_PATH})
  --json             emit machine-readable JSON instead of the text report
  --help              show this message

Safety:
  Report only. Never mutates live-shadow state or events. READY_FOR_REAL_TRADING=false.
`.trim();
}
