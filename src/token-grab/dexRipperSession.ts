import * as fs from 'fs';
import * as path from 'path';
import type { WinnerCandidate, DexWinnerCandidateReport } from './dexWinnerCandidateReport';
import {
  scoreRipper,
  checkPaperBuyGate,
  evaluateSell,
  DEFAULT_RIPPER_CONFIG,
  type RipperConfig,
  type RipperInput,
  type RipperSignal,
  type RipperPaperPosition,
  type PaperBuyGateResult,
  type SellEvalResult,
} from './dexRipperEngine';

// ── Session state ─────────────────────────────────────────────────────────────────────────

export interface RipperSessionState {
  sessionId: string;
  startedAt: string;
  lastCycleAt: string | null;
  cycleCount: number;
  openPositions: RipperPaperPosition[];
  closedPositions: RipperPaperPosition[];
  totalPaperBuys: number;
  totalPaperSells: number;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

function makeEmptyState(nowIso: string): RipperSessionState {
  return {
    sessionId: `ripper-${nowIso.slice(0, 10)}`,
    startedAt: nowIso,
    lastCycleAt: null,
    cycleCount: 0,
    openPositions: [],
    closedPositions: [],
    totalPaperBuys: 0,
    totalPaperSells: 0,
    tradingExecuted: 0,
    noRealTradeSent: true,
    paperOnly: true,
    readOnly: true,
  };
}

export function loadOrCreateSessionState(statePath: string, nowIso: string): RipperSessionState {
  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, 'utf-8');
      const parsed = JSON.parse(raw) as RipperSessionState;
      // Always enforce safety constants
      return { ...parsed, tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true };
    } catch {
      // Corrupted state — start fresh
    }
  }
  return makeEmptyState(nowIso);
}

export function saveSessionState(state: RipperSessionState, statePath: string): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ── Input conversion ──────────────────────────────────────────────────────────────────────

export function winnerCandidateToRipperInput(c: WinnerCandidate): RipperInput {
  return {
    contract: c.contract,
    symbol: c.symbol,
    observedAt: c.observedAt,
    priceChangePct: c.priceChangePct,
    liquidityChangePct: c.liquidityChangePct,
    volumeLiquidityRatio: c.volumeLiquidityRatio,
  };
}

// ── Session options and result ────────────────────────────────────────────────────────────

export interface RipperSessionOptions {
  candidatesPath: string;
  sessionStatePath: string;
  config?: Partial<RipperConfig>;
  debug?: boolean;
  nowMs?: number; // injectable for tests
}

export interface NearMiss {
  signal: RipperSignal;
  gateResult: PaperBuyGateResult;
}

export interface RipperSessionResult {
  candidatesScanned: number;
  ignoredCount: number;
  watchCount: number;
  readyCount: number;
  blockedCount: number;
  paperBuysOpened: number;
  paperSellsClosed: number;
  topNearMisses: NearMiss[];
  topBlockers: string[];
  openPositions: RipperPaperPosition[];
  closedThisCycle: RipperPaperPosition[];
  allSignals: RipperSignal[];
  sessionState: RipperSessionState;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

function loadCandidates(candidatesPath: string): WinnerCandidate[] {
  if (!fs.existsSync(candidatesPath)) return [];
  try {
    const raw = fs.readFileSync(candidatesPath, 'utf-8');
    const parsed = JSON.parse(raw) as DexWinnerCandidateReport | WinnerCandidate[];
    if (Array.isArray(parsed)) return parsed;
    if (parsed.candidates) return parsed.candidates;
    return [];
  } catch {
    return [];
  }
}

function extractTopBlockers(signals: RipperSignal[]): string[] {
  const counts = new Map<string, number>();
  for (const s of signals) {
    for (const b of s.blockers) {
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([b, n]) => `${b} (×${n})`);
}

// ── Core session runner ───────────────────────────────────────────────────────────────────

export function runRipperSession(options: RipperSessionOptions): RipperSessionResult {
  const nowMs   = options.nowMs ?? Date.now();
  const nowIso  = new Date(nowMs).toISOString();
  const config  = { ...DEFAULT_RIPPER_CONFIG, ...(options.config ?? {}) };

  const candidates = loadCandidates(options.candidatesPath);
  const state      = loadOrCreateSessionState(options.sessionStatePath, nowIso);

  // Score every candidate
  const signals = candidates.map(c => scoreRipper(winnerCandidateToRipperInput(c), config, nowMs));
  const signalByContract = new Map<string, RipperSignal>(signals.map(s => [s.contract, s]));

  // ── Evaluate open positions for exits ──
  const closedThisCycle: RipperPaperPosition[] = [];
  const stillOpen: RipperPaperPosition[] = [];

  for (const pos of state.openPositions) {
    const currentSignal = signalByContract.get(pos.contract) ?? null;
    const sellResult: SellEvalResult = evaluateSell(pos, currentSignal, config, nowMs);

    if (sellResult.shouldSell) {
      const entryPct   = pos.entryPriceChangePct ?? 0;
      const currentPct = currentSignal?.priceChangePct ?? entryPct;
      const pnlPct     = sellResult.fakePnlPct ?? ((100 + currentPct) / (100 + entryPct) - 1) * 100;
      const holdMinutes = (nowMs - new Date(pos.openedAt).getTime()) / 60000;

      const closed: RipperPaperPosition = {
        ...pos,
        status: 'CLOSED',
        closedAt: nowIso,
        exitReason: sellResult.reason,
        exitPriceChangePct: currentPct,
        fakePnlPct: pnlPct,
        fakePnlUsd: (pnlPct / 100) * pos.positionSizeUsd,
        holdMinutes,
      };
      closedThisCycle.push(closed);
      state.closedPositions.unshift(closed);
    } else {
      // Update peak
      const currentPct = currentSignal?.priceChangePct;
      if (currentPct != null && (pos.peakPriceChangePct == null || currentPct > pos.peakPriceChangePct)) {
        pos.peakPriceChangePct = currentPct;
      }
      stillOpen.push(pos);
    }
  }
  state.openPositions   = stillOpen;
  state.totalPaperSells += closedThisCycle.length;

  // ── Evaluate buy gate for ready candidates ──
  const openContracts = new Set<string>(state.openPositions.map(p => p.contract));
  const buysThisCycle: RipperPaperPosition[] = [];
  const nearMisses: NearMiss[] = [];

  for (const signal of signals) {
    if (signal.entryDecision === 'IGNORE') continue;

    const gateResult = checkPaperBuyGate(signal, config);

    if (gateResult.decision === 'BUY_REJECTED') {
      // Near-miss: scored high enough to consider but blocked
      if (signal.ripperScore >= config.minScoreToWatch + 10) {
        nearMisses.push({ signal, gateResult });
      }
      continue;
    }

    // Duplicate prevention
    if (openContracts.has(signal.contract)) continue;

    const newPos: RipperPaperPosition = {
      contract: signal.contract,
      symbol: signal.symbol,
      openedAt: nowIso,
      entryPriceChangePct: signal.priceChangePct,
      entryLiquidityChangePct: signal.liquidityChangePct,
      entryVlr: signal.volumeLiquidityRatio,
      entryRipperScore: signal.ripperScore,
      positionSizeUsd: config.positionSizeUsd,
      peakPriceChangePct: signal.priceChangePct,
      status: 'OPEN',
    };

    state.openPositions.push(newPos);
    buysThisCycle.push(newPos);
    openContracts.add(signal.contract);
  }
  state.totalPaperBuys += buysThisCycle.length;

  // ── Update state ──
  state.cycleCount   += 1;
  state.lastCycleAt   = nowIso;

  saveSessionState(state, options.sessionStatePath);

  // ── Build result ──
  const ignoredCount  = signals.filter(s => s.entryDecision === 'IGNORE').length;
  const watchCount    = signals.filter(s => s.entryDecision === 'WATCH').length;
  const readyCount    = signals.filter(s => s.entryDecision === 'READY_TO_SNIPE_PAPER').length;
  const blockedCount  = signals.filter(s => s.entryDecision === 'PAPER_BUY_BLOCKED').length;

  return {
    candidatesScanned: signals.length,
    ignoredCount,
    watchCount,
    readyCount,
    blockedCount,
    paperBuysOpened: buysThisCycle.length,
    paperSellsClosed: closedThisCycle.length,
    topNearMisses: nearMisses.sort((a, b) => b.signal.ripperScore - a.signal.ripperScore).slice(0, 5),
    topBlockers: extractTopBlockers(signals),
    openPositions: state.openPositions,
    closedThisCycle,
    allSignals: signals,
    sessionState: state,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Autopilot loop ────────────────────────────────────────────────────────────────────────

export interface RipperAutopilotOptions extends RipperSessionOptions {
  intervalMs: number;
  maxCycles?: number;
  onCycle?: (result: RipperSessionResult, cycleNum: number) => void;
}

export async function runRipperAutopilot(options: RipperAutopilotOptions): Promise<void> {
  const maxCycles = options.maxCycles ?? 0;
  let cycleNum = 0;
  let running = true;

  process.on('SIGINT', () => {
    running = false;
    console.log('\n[ripper-autopilot] SIGINT received — stopping after current cycle');
  });

  while (running) {
    cycleNum += 1;
    if (maxCycles > 0 && cycleNum > maxCycles) break;

    const result = runRipperSession(options);
    if (options.onCycle) {
      options.onCycle(result, cycleNum);
    }

    if (!running) break;
    if (maxCycles > 0 && cycleNum >= maxCycles) break;

    await new Promise<void>(resolve => setTimeout(resolve, options.intervalMs));
  }
}

// ── Renderer ──────────────────────────────────────────────────────────────────────────────

function fmtPnl(pct: number | undefined): string {
  if (pct == null) return 'n/a';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function fmtScore(n: number): string {
  const bars = Math.round(n / 10);
  return '█'.repeat(bars) + '░'.repeat(10 - bars) + ` ${n}`;
}

export function renderRipperSessionSummary(
  result: RipperSessionResult,
  debug = false,
): string {
  const lines: string[] = [];
  const { sessionState: state } = result;

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — RIPPER SESSION');
  lines.push(`  Cycle #${state.cycleCount}   ${state.lastCycleAt ?? ''}   [${'REAL TRADING LOCKED — PAPER ONLY'}]`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  // Scan summary
  lines.push('  CANDIDATE SCAN');
  lines.push(`    Scanned      : ${result.candidatesScanned}`);
  lines.push(`    Ignored      : ${result.ignoredCount}`);
  lines.push(`    Watch        : ${result.watchCount}`);
  lines.push(`    Blocked      : ${result.blockedCount}`);
  lines.push(`    Ready        : ${result.readyCount}`);
  lines.push(`    Paper buys   : +${result.paperBuysOpened}`);
  lines.push(`    Paper sells  : -${result.paperSellsClosed}`);
  lines.push('');

  // Near-misses
  if (result.topNearMisses.length > 0) {
    lines.push('  NEAR-MISSES (high score, buy blocked)');
    for (const nm of result.topNearMisses) {
      const sym = nm.signal.symbol ? `$${nm.signal.symbol}` : nm.signal.contract.slice(0, 8) + '…';
      lines.push(`    ${sym.padEnd(14)}  score=${fmtScore(nm.signal.ripperScore)}  age=${nm.signal.launchAgeBucket}`);
      for (const b of nm.gateResult.blockers.slice(0, 2)) {
        lines.push(`      ✗ ${b}`);
      }
    }
    lines.push('');
  }

  // Top blockers across all candidates
  if (result.topBlockers.length > 0) {
    lines.push('  TOP BLOCKERS (across all candidates)');
    for (const b of result.topBlockers) {
      lines.push(`    • ${b}`);
    }
    lines.push('');
  }

  // Closed this cycle
  if (result.closedThisCycle.length > 0) {
    lines.push('  PAPER EXITS THIS CYCLE');
    for (const p of result.closedThisCycle) {
      const sym = p.symbol ? `$${p.symbol}` : p.contract.slice(0, 8) + '…';
      const pnl = fmtPnl(p.fakePnlPct);
      const hold = p.holdMinutes != null ? `${p.holdMinutes.toFixed(0)}m` : 'n/a';
      lines.push(`    ${sym.padEnd(14)}  ${(p.exitReason ?? '').padEnd(20)}  P/L ${pnl.padStart(8)}  held ${hold}`);
    }
    lines.push('');
  }

  // Open positions
  lines.push('  OPEN PAPER POSITIONS');
  if (state.openPositions.length === 0) {
    lines.push('    (none)');
  } else {
    for (const p of state.openPositions) {
      const sym   = p.symbol ? `$${p.symbol}` : p.contract.slice(0, 8) + '…';
      const age   = `${((Date.now() - new Date(p.openedAt).getTime()) / 60000).toFixed(0)}m`;
      lines.push(`    ${sym.padEnd(14)}  entry-score=${p.entryRipperScore}  opened ${age} ago`);
    }
  }
  lines.push('');

  // Lifetime stats
  lines.push('  SESSION STATS');
  lines.push(`    Total paper buys  : ${state.totalPaperBuys}`);
  lines.push(`    Total paper sells : ${state.totalPaperSells}`);
  lines.push(`    Cycles run        : ${state.cycleCount}`);
  lines.push(`    Started           : ${state.startedAt.slice(0, 19).replace('T', ' ')}`);
  lines.push('');

  // Debug: per-candidate signals
  if (debug && result.allSignals.length > 0) {
    lines.push('  ── DEBUG: ALL SIGNALS ──');
    for (const s of result.allSignals) {
      const sym = s.symbol ? `$${s.symbol}` : s.contract.slice(0, 12) + '…';
      lines.push(`  ${sym.padEnd(16)} score=${s.ripperScore.toString().padStart(3)}  ${s.entryDecision.padEnd(22)} age=${s.launchAgeBucket}`);
      if (s.blockers.length > 0) {
        for (const b of s.blockers) lines.push(`    ✗ ${b}`);
      }
      if (s.topReasons.length > 0) {
        for (const r of s.topReasons) lines.push(`    ✓ ${r}`);
      }
    }
    lines.push('');
  }

  lines.push(`  tradingExecuted=${result.tradingExecuted}  noRealTradeSent=${result.noRealTradeSent}  paperOnly=true  readOnly=true`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  return lines.join('\n');
}

export function renderRipperDashboard(state: RipperSessionState): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — RIPPER DASHBOARD');
  lines.push(`  Session: ${state.sessionId}   Cycles: ${state.cycleCount}   [REAL TRADING LOCKED]`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  lines.push(`  Open positions : ${state.openPositions.length}`);
  lines.push(`  Total buys     : ${state.totalPaperBuys}`);
  lines.push(`  Total sells    : ${state.totalPaperSells}`);
  lines.push(`  Last cycle     : ${state.lastCycleAt ? state.lastCycleAt.slice(0, 19).replace('T', ' ') : 'never'}`);
  lines.push('');

  if (state.openPositions.length > 0) {
    lines.push('  OPEN POSITIONS');
    for (const p of state.openPositions) {
      const sym   = p.symbol ? `$${p.symbol}` : p.contract.slice(0, 12) + '…';
      const age   = `${((Date.now() - new Date(p.openedAt).getTime()) / 60000).toFixed(0)}m`;
      lines.push(`    ${sym.padEnd(16)}  score=${p.entryRipperScore}  entry-price=${p.entryPriceChangePct?.toFixed(1) ?? 'n/a'}%  held ${age}`);
    }
    lines.push('');
  }

  const recent = state.closedPositions.slice(0, 10);
  if (recent.length > 0) {
    lines.push('  RECENT CLOSED POSITIONS');
    for (const p of recent) {
      const sym  = p.symbol ? `$${p.symbol}` : p.contract.slice(0, 12) + '…';
      const pnl  = fmtPnl(p.fakePnlPct);
      const hold = p.holdMinutes != null ? `${p.holdMinutes.toFixed(0)}m` : 'n/a';
      lines.push(`    ${sym.padEnd(16)}  ${(p.exitReason ?? '').padEnd(20)}  P/L ${pnl.padStart(8)}  held ${hold}`);
    }
    lines.push('');
  }

  lines.push(`  tradingExecuted=${state.tradingExecuted}  noRealTradeSent=${state.noRealTradeSent}  paperOnly=true  readOnly=true`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  return lines.join('\n');
}

export function renderRipperSessionUsage(): string {
  return `
token:ripper-session — score fresh candidates, open/close paper positions, print summary

Usage:
  npm run token:ripper-session [options]

Options:
  --candidates <path>       winner candidates JSON (default: data/token-grab/legitimacy/dex-winner-candidates-today.json)
  --session-state <path>    ripper session state file (default: data/token-grab/ripper/ripper-session.json)
  --min-score <N>           minimum ripper score to open a paper buy (default: 65)
  --max-hold-minutes <N>    max hold time before forced sell (default: 30)
  --no-prime-required       allow LATE window buys (default: prime window required)
  --reset                   clear session state and start fresh
  --debug                   show per-candidate signal details
  --help                    show this message

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Paper only.
`.trim();
}

export function renderRipperAutopilotUsage(): string {
  return `
token:ripper-autopilot — continuously run ripper sessions at a configurable interval

Usage:
  npm run token:ripper-autopilot [options]

Options:
  --candidates <path>       winner candidates JSON (default: data/token-grab/legitimacy/dex-winner-candidates-today.json)
  --session-state <path>    ripper session state file (default: data/token-grab/ripper/ripper-session.json)
  --interval-minutes <N>    seconds between cycles (default: 5)
  --cycles <N>              max cycles, 0=unlimited (default: 0)
  --min-score <N>           minimum ripper score to buy (default: 65)
  --max-hold-minutes <N>    max hold time (default: 30)
  --no-prime-required       allow LATE window buys
  --reset                   clear session state before starting
  --debug                   show per-candidate details each cycle
  --help                    show this message

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Paper only.
`.trim();
}

export function renderRipperDashboardUsage(): string {
  return `
token:ripper-dashboard — display current ripper session state

Usage:
  npm run token:ripper-dashboard [options]

Options:
  --session-state <path>    ripper session state file (default: data/token-grab/ripper/ripper-session.json)
  --help                    show this message
`.trim();
}
