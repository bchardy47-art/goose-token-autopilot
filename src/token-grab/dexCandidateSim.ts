import type { DexWatchReport } from './dexWatch';
import {
  buildDexWatchCandidatesReport,
  type DexWatchCandidate,
} from './dexWatchCandidates';

// ── Types ───────────────────────────────────────────────────────────────────────────

/** A single fake (paper) trade derived from a passed DEX candidate. */
export interface SimTrade {
  contract: string;
  symbol?: string;
  priceChangePct: number;
  positionSize: number;
  pnlDollars: number;
  pnlPct: number;
  outcome: 'winner' | 'loser';
}

export interface BlockedReasonCount {
  reason: string;
  count: number;
}

export interface DexCandidateSimReport {
  dir: string;
  runsRead: number;
  candidatesPassed: number;
  blockedCount: number;

  fakeBankroll: number;
  fakePositionSize: number;

  tradesSimulated: number;
  winners: number;
  losers: number;
  winRate: number; // 0..1

  fakeRealizedPnlDollars: number;
  fakeRealizedPnlPct: number; // relative to total fake capital deployed
  totalDeployed: number;

  bestTrade?: SimTrade;
  worstTrade?: SimTrade;
  avgWinnerPct?: number;
  avgLoserPct?: number;

  topBlockedReasons: BlockedReasonCount[];
  trades: SimTrade[];

  dryRun: false;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

export interface DexCandidateSimOptions {
  dir?: string;
  fakeBankroll?: number;
  positionSize?: number;
}

// ── Helpers — pure ────────────────────────────────────────────────────────────────────

function avg(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

/** Collapses a block reason to its category (drops the parenthetical detail). */
export function normalizeBlockReason(reason: string): string {
  return reason.replace(/\s*\(.*\)\s*$/, '').trim();
}

/**
 * Turns one passed candidate into a fake trade: enter at entry snapshot,
 * exit at final snapshot (encoded by priceChangePct). No real order is placed.
 */
export function simulateTrade(candidate: DexWatchCandidate, positionSize: number): SimTrade | null {
  const pct = candidate.priceChangePct;
  if (typeof pct !== 'number') return null; // PASS guarantees this, but stay defensive
  const pnlDollars = positionSize * (pct / 100);
  return {
    contract: candidate.contract,
    symbol: candidate.symbol,
    priceChangePct: pct,
    positionSize,
    pnlDollars,
    pnlPct: pct,
    outcome: pnlDollars > 0 ? 'winner' : 'loser',
  };
}

// ── Report builder — pure ──────────────────────────────────────────────────────────────

export function buildDexCandidateSimReport(
  reports: DexWatchReport[],
  options: DexCandidateSimOptions = {},
): DexCandidateSimReport {
  const dir = options.dir ?? '';
  const fakeBankroll = options.fakeBankroll ?? 20;
  const positionSize = options.positionSize ?? 1;

  const candidates = buildDexWatchCandidatesReport(reports, dir);

  const trades = candidates.passed
    .map(c => simulateTrade(c, positionSize))
    .filter((t): t is SimTrade => t !== null);

  const winnerTrades = trades.filter(t => t.outcome === 'winner');
  const loserTrades = trades.filter(t => t.outcome === 'loser');

  const fakeRealizedPnlDollars = trades.reduce((s, t) => s + t.pnlDollars, 0);
  const totalDeployed = positionSize * trades.length;
  const fakeRealizedPnlPct = totalDeployed > 0 ? (fakeRealizedPnlDollars / totalDeployed) * 100 : 0;

  const bestTrade = trades.length
    ? trades.reduce((best, t) => (t.pnlDollars > best.pnlDollars ? t : best))
    : undefined;
  const worstTrade = trades.length
    ? trades.reduce((worst, t) => (t.pnlDollars < worst.pnlDollars ? t : worst))
    : undefined;

  // Tally and rank block reasons by category.
  const reasonCounts = new Map<string, number>();
  for (const b of candidates.blocked) {
    for (const r of b.blockReasons) {
      const key = normalizeBlockReason(r);
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
  }
  const topBlockedReasons: BlockedReasonCount[] = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    dir,
    runsRead: candidates.runsRead,
    candidatesPassed: candidates.passedCount,
    blockedCount: candidates.blockedCount,

    fakeBankroll,
    fakePositionSize: positionSize,

    tradesSimulated: trades.length,
    winners: winnerTrades.length,
    losers: loserTrades.length,
    winRate: trades.length > 0 ? winnerTrades.length / trades.length : 0,

    fakeRealizedPnlDollars,
    fakeRealizedPnlPct,
    totalDeployed,

    bestTrade,
    worstTrade,
    avgWinnerPct: avg(winnerTrades.map(t => t.pnlPct)),
    avgLoserPct: avg(loserTrades.map(t => t.pnlPct)),

    topBlockedReasons,
    trades,

    dryRun: false,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── Renderer — pure ────────────────────────────────────────────────────────────────────

function fmtUsd(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtPct(v?: number): string {
  if (v == null) return 'n/a';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

export function renderDexCandidateSimReport(report: DexCandidateSimReport): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX CANDIDATE SIM V1');
  lines.push('  READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Runs dir            : ${report.dir}`);
  lines.push(`  Runs read           : ${report.runsRead}`);
  lines.push(`  Candidate trades sim: ${report.tradesSimulated}`);
  lines.push(`  Fake bankroll       : $${report.fakeBankroll.toFixed(2)}`);
  lines.push(`  Fake position size  : $${report.fakePositionSize.toFixed(2)}`);
  lines.push(`  Total fake deployed : $${report.totalDeployed.toFixed(2)}`);
  lines.push('');
  lines.push(`  Winners             : ${report.winners}`);
  lines.push(`  Losers              : ${report.losers}`);
  lines.push(`  Win rate            : ${(report.winRate * 100).toFixed(1)}%`);
  lines.push(`  Fake realized P/L    : ${fmtUsd(report.fakeRealizedPnlDollars)} (${fmtPct(report.fakeRealizedPnlPct)})`);
  lines.push(`  Avg winner          : ${fmtPct(report.avgWinnerPct)}`);
  lines.push(`  Avg loser           : ${fmtPct(report.avgLoserPct)}`);
  if (report.bestTrade) {
    const b = report.bestTrade;
    lines.push(`  Best fake trade     : ${(b.symbol ? `$${b.symbol}` : b.contract.slice(0, 6))} ${fmtUsd(b.pnlDollars)} (${fmtPct(b.pnlPct)})`);
  }
  if (report.worstTrade) {
    const w = report.worstTrade;
    lines.push(`  Worst fake trade    : ${(w.symbol ? `$${w.symbol}` : w.contract.slice(0, 6))} ${fmtUsd(w.pnlDollars)} (${fmtPct(w.pnlPct)})`);
  }
  lines.push(`  Blocked count       : ${report.blockedCount}`);

  if (report.trades.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Simulated fake trades (top 10 by P/L):');
    const sorted = [...report.trades].sort((a, b) => b.pnlDollars - a.pnlDollars).slice(0, 10);
    for (const t of sorted) {
      const sym = (t.symbol ? `$${t.symbol}` : '(no sym)').padEnd(12);
      lines.push(`    ${sym} ${fmtUsd(t.pnlDollars).padStart(9)}  (${fmtPct(t.pnlPct)})  ${t.contract.slice(0, 6)}…`);
    }
  }

  if (report.topBlockedReasons.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Top blocked reasons:');
    for (const r of report.topBlockedReasons.slice(0, 5)) {
      lines.push(`    ${String(r.count).padStart(3)}  ${r.reason}`);
    }
  }

  lines.push('');
  lines.push(WIDE);
  lines.push('  PAPER SIMULATION ONLY — no live-harness gate changed');
  lines.push('  Fake P/L is hypothetical — no trading, no wallet, no signing, no swap');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
