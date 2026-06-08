import type { DexWatchReport, DexWatchOutcome } from './dexWatch';
import { outcomesFromReport, DRAIN_PCT } from './dexWatchSummary';
import { PASS_PRICE_PCT, PASS_LIQ_PCT, PASS_VLR_MAX } from './dexWatchCandidates';

// ── History-risk threshold (V2) ───────────────────────────────────────────────────────

/** Average volume/liquidity ratio above this is treated as chronic churn. */
export const HISTORY_AVG_VLR_MAX = 1.0;
/** A token's aggregate history blocks a fake trade at or above this count. */
export const HISTORY_RISK_MIN = 1;

// ── Types ───────────────────────────────────────────────────────────────────────────

/** A single fake (paper) trade derived from a candidate that survived the history filter. */
export interface SimTrade {
  contract: string;
  symbol?: string;
  priceChangePct: number;
  positionSize: number;
  pnlDollars: number;
  pnlPct: number;
  outcome: 'winner' | 'loser';
}

/** Minimal shape needed to simulate a trade. */
export interface SimTradeInput {
  contract: string;
  symbol?: string;
  priceChangePct?: number;
}

export interface BlockedReasonCount {
  reason: string;
  count: number;
}

/** A candidate that met the PASS thresholds but was blocked by ugly prior history. */
export interface HistoryRiskBlock {
  contract: string;
  symbol?: string;
  priceChangePct?: number;
  loseCount: number;
  drainCount: number;
  missingCount: number;
  avgVolumeLiquidityRatio?: number;
  reasons: string[];
}

export interface DexCandidateSimReport {
  dir: string;
  runsRead: number;

  candidatesFound: number; // strongest outcome meets PASS thresholds
  blockedByHistoryRisk: number;

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

  historyRiskBlocked: HistoryRiskBlock[];
  historyRiskBlockReasons: BlockedReasonCount[];
  trades: SimTrade[];

  // ── Back-compat aliases (consumed by the paper runner / older callers) ──
  candidatesPassed: number; // == candidatesFound (PASS candidates)
  blockedCount: number; // == blockedByHistoryRisk
  topBlockedReasons: BlockedReasonCount[]; // == historyRiskBlockReasons

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
 * Turns one surviving candidate into a fake trade: enter at entry snapshot,
 * exit at final snapshot (encoded by priceChangePct). No real order is placed.
 */
export function simulateTrade(candidate: SimTradeInput, positionSize: number): SimTrade | null {
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

// ── Per-contract aggregate history (reuses outcomesFromReport + DRAIN_PCT) ──────────────

interface ContractHistory {
  contract: string;
  symbol?: string;
  appearances: number;
  loseCount: number;
  drainCount: number;
  missingCount: number;
  vlrs: number[];
  strongest?: DexWatchOutcome; // highest defined priceChangePct
}

function rollupHistory(reports: DexWatchReport[]): ContractHistory[] {
  const map = new Map<string, ContractHistory>();

  for (const report of reports) {
    for (const o of outcomesFromReport(report)) {
      const key = o.contract.toLowerCase();
      let h = map.get(key);
      if (!h) {
        h = {
          contract: o.contract,
          symbol: o.symbol,
          appearances: 0,
          loseCount: 0,
          drainCount: 0,
          missingCount: 0,
          vlrs: [],
        };
        map.set(key, h);
      }
      if (!h.symbol && o.symbol) h.symbol = o.symbol;
      h.appearances += 1;

      if (o.classification === 'loser') h.loseCount += 1;
      if (o.classification === 'missing') h.missingCount += 1;
      if (typeof o.liquidityChangePct === 'number' && o.liquidityChangePct <= DRAIN_PCT) {
        h.drainCount += 1;
      }
      if (typeof o.volumeToLiquidityRatio === 'number') h.vlrs.push(o.volumeToLiquidityRatio);

      const cur = h.strongest?.priceChangePct;
      const next = o.priceChangePct;
      if (h.strongest === undefined) {
        h.strongest = o;
      } else if (typeof next === 'number' && (typeof cur !== 'number' || next > cur)) {
        h.strongest = o;
      }
    }
  }

  return Array.from(map.values());
}

/** The strongest outcome meets the existing (unchanged) candidate PASS thresholds. */
function meetsPassThresholds(s?: DexWatchOutcome): boolean {
  if (!s) return false;
  return (
    typeof s.priceChangePct === 'number' && s.priceChangePct >= PASS_PRICE_PCT &&
    typeof s.liquidityChangePct === 'number' && s.liquidityChangePct >= PASS_LIQ_PCT &&
    typeof s.volumeToLiquidityRatio === 'number' && s.volumeToLiquidityRatio <= PASS_VLR_MAX
  );
}

/** History-risk reasons for a candidate; empty array means the history is clean. */
export function historyRiskReasons(h: {
  loseCount: number;
  drainCount: number;
  missingCount: number;
  avgVolumeLiquidityRatio?: number;
}): string[] {
  const reasons: string[] = [];
  if (h.loseCount >= HISTORY_RISK_MIN) reasons.push(`loseCount >= ${HISTORY_RISK_MIN} (loseCount=${h.loseCount})`);
  if (h.drainCount >= HISTORY_RISK_MIN) reasons.push(`drainCount >= ${HISTORY_RISK_MIN} (drainCount=${h.drainCount})`);
  if (h.missingCount >= HISTORY_RISK_MIN) reasons.push(`missingCount >= ${HISTORY_RISK_MIN} (missingCount=${h.missingCount})`);
  if (typeof h.avgVolumeLiquidityRatio === 'number' && h.avgVolumeLiquidityRatio > HISTORY_AVG_VLR_MAX) {
    reasons.push(`avgVolumeLiquidityRatio > ${HISTORY_AVG_VLR_MAX} (${h.avgVolumeLiquidityRatio.toFixed(2)})`);
  }
  return reasons;
}

// ── Report builder — pure ──────────────────────────────────────────────────────────────

export function buildDexCandidateSimReport(
  reports: DexWatchReport[],
  options: DexCandidateSimOptions = {},
): DexCandidateSimReport {
  const dir = options.dir ?? '';
  const fakeBankroll = options.fakeBankroll ?? 20;
  const positionSize = options.positionSize ?? 1;

  const histories = rollupHistory(reports);

  let candidatesFound = 0;
  const survivors: SimTradeInput[] = [];
  const historyRiskBlocked: HistoryRiskBlock[] = [];

  for (const h of histories) {
    // Candidacy uses the existing (unchanged) PASS thresholds on the strongest outcome.
    if (!meetsPassThresholds(h.strongest)) continue;
    candidatesFound += 1;

    const avgVlr = avg(h.vlrs);
    const reasons = historyRiskReasons({
      loseCount: h.loseCount,
      drainCount: h.drainCount,
      missingCount: h.missingCount,
      avgVolumeLiquidityRatio: avgVlr,
    });

    if (reasons.length > 0) {
      historyRiskBlocked.push({
        contract: h.contract,
        symbol: h.symbol,
        priceChangePct: h.strongest!.priceChangePct,
        loseCount: h.loseCount,
        drainCount: h.drainCount,
        missingCount: h.missingCount,
        avgVolumeLiquidityRatio: avgVlr,
        reasons,
      });
    } else {
      survivors.push({ contract: h.contract, symbol: h.symbol, priceChangePct: h.strongest!.priceChangePct });
    }
  }

  const trades = survivors
    .map(s => simulateTrade(s, positionSize))
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

  // Tally history-risk reasons by category.
  const reasonCounts = new Map<string, number>();
  for (const b of historyRiskBlocked) {
    for (const r of b.reasons) {
      const key = normalizeBlockReason(r);
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
  }
  const historyRiskBlockReasons: BlockedReasonCount[] = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    dir,
    runsRead: reports.length,

    candidatesFound,
    blockedByHistoryRisk: historyRiskBlocked.length,

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

    historyRiskBlocked,
    historyRiskBlockReasons,
    trades,

    // back-compat aliases
    candidatesPassed: candidatesFound,
    blockedCount: historyRiskBlocked.length,
    topBlockedReasons: historyRiskBlockReasons,

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
  lines.push('  TOKEN GRAB DEX CANDIDATE SIM V2 — history-risk filter');
  lines.push('  READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Runs dir                 : ${report.dir}`);
  lines.push(`  Runs read                : ${report.runsRead}`);
  lines.push(`  Original candidates found: ${report.candidatesFound}`);
  lines.push(`  Blocked by history risk  : ${report.blockedByHistoryRisk}`);
  lines.push(`  Simulated after filter   : ${report.tradesSimulated}`);
  lines.push(`  Fake bankroll            : $${report.fakeBankroll.toFixed(2)}`);
  lines.push(`  Fake position size       : $${report.fakePositionSize.toFixed(2)}`);
  lines.push(`  Total fake deployed      : $${report.totalDeployed.toFixed(2)}`);
  lines.push('');
  lines.push(`  Winners                  : ${report.winners}`);
  lines.push(`  Losers                   : ${report.losers}`);
  lines.push(`  Win rate                 : ${(report.winRate * 100).toFixed(1)}%`);
  lines.push(`  Fake realized P/L         : ${fmtUsd(report.fakeRealizedPnlDollars)} (${fmtPct(report.fakeRealizedPnlPct)})`);
  lines.push(`  Avg winner               : ${fmtPct(report.avgWinnerPct)}`);
  lines.push(`  Avg loser                : ${fmtPct(report.avgLoserPct)}`);
  if (report.bestTrade) {
    const b = report.bestTrade;
    lines.push(`  Best fake trade          : ${(b.symbol ? `$${b.symbol}` : b.contract.slice(0, 6))} ${fmtUsd(b.pnlDollars)} (${fmtPct(b.pnlPct)})`);
  }
  if (report.worstTrade) {
    const w = report.worstTrade;
    lines.push(`  Worst fake trade         : ${(w.symbol ? `$${w.symbol}` : w.contract.slice(0, 6))} ${fmtUsd(w.pnlDollars)} (${fmtPct(w.pnlPct)})`);
  }

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

  if (report.historyRiskBlocked.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push(`  HISTORY_RISK_BLOCK — candidates blocked by ugly prior history (${report.historyRiskBlocked.length}):`);
    for (const b of report.historyRiskBlocked.slice(0, 20)) {
      const sym = (b.symbol ? `$${b.symbol}` : '(no sym)').padEnd(12);
      lines.push(`    ${sym} ${b.contract.slice(0, 8)}…  — ${b.reasons.join('; ')}`);
    }
  }

  if (report.historyRiskBlockReasons.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  History-risk block reasons:');
    for (const r of report.historyRiskBlockReasons.slice(0, 5)) {
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
