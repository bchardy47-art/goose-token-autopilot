import fs from 'node:fs';
import path from 'node:path';
import type { DexWatchOutcome } from './dexWatch';
import { loadPresignals as dexLoadPresignals, parsePresignals } from './dexWatch';
import { outcomesFromReport, DRAIN_PCT } from './dexWatchSummary';
import { PASS_PRICE_PCT, PASS_LIQ_PCT, PASS_VLR_MAX, BLOCK_VLR_MAX } from './dexWatchCandidates';
import { historyRiskReasons, HISTORY_RISK_MIN } from './dexCandidateSim';
import { loadRunsWithFiles, type LoadedRun, type DexPaperJournal } from './dexPaperJournal';
import type { PreSignal } from './xEarsPreSignal';

// ── Plan defaults ─────────────────────────────────────────────────────────────

export const PLAN_STOP_LOSS_PCT = -20;
export const PLAN_FIRST_TP_PCT = 25;
export const PLAN_RUNNER_TARGET_PCT = 50;

const CANCEL_CONDITIONS = [
  'liquidity falls below entry level',
  `volume/liquidity ratio exceeds ${BLOCK_VLR_MAX} (dangerous churn)`,
  'token snapshot missing (no entry or final data)',
  'history-risk appears in subsequent watch run',
];

// ── Types ───────────────────────────────────────────────────────────────────────────

export type PlanRecommendation =
  | 'PAPER_ENTRY_CANDIDATE'
  | 'WATCH_ONLY'
  | 'BLOCKED_HISTORY_RISK'
  | 'NO_ENTRY';

export interface PaperEntryPlan {
  symbol?: string;
  contract: string;
  recommendation: PlanRecommendation;
  fakeEntrySize: number;
  fakeStopLossPct: number;
  fakeTakeProfitPct: number;
  fakeRunnerTargetPct: number;
  cancelConditions: string[];
  reasons: string[];
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  historyRiskStatus: 'CLEAN' | 'BLOCKED' | 'UNKNOWN';
  historyRiskReasons?: string[];
  journalSimilarity?: string;
  sourceSignalFile?: string;
  sourceRunFile?: string;
  // safety
  tradingExecuted: 0;
  noRealTradeSent: true;
  readOnly: true;
  paperOnly: true;
}

export interface DexPaperEntryPlanReport {
  plannedAt?: string;
  signalsFile: string;
  runsDir: string;
  journalFile: string;
  fakeBankroll: number;
  fakePositionSize: number;

  totalPlans: number;
  paperEntryCandidates: number;
  watchOnly: number;
  blockedHistoryRisk: number;
  noEntry: number;

  plans: PaperEntryPlan[];

  readOnly: true;
  paperOnly: true;
  tradingExecuted: 0;
  noRealTradeSent: true;
}

export interface DexPaperEntryPlannerOptions {
  signalsFile: string;
  runsDir: string;
  journalFile: string;
  out: string;
  fakeBankroll?: number;
  positionSize?: number;
  plannedAt?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────────────

function avg(nums: number[]): number | undefined {
  if (!nums.length) return undefined;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

interface ContractHistory {
  contract: string;
  symbol?: string;
  loseCount: number;
  drainCount: number;
  missingCount: number;
  vlrs: number[];
  strongest?: DexWatchOutcome;
  strongestRunFile?: string;
}

function rollupHistory(runs: LoadedRun[]): Map<string, ContractHistory> {
  const map = new Map<string, ContractHistory>();
  for (const run of runs) {
    for (const o of outcomesFromReport(run.report)) {
      const key = o.contract.toLowerCase();
      let h = map.get(key);
      if (!h) {
        h = { contract: o.contract, symbol: o.symbol, loseCount: 0, drainCount: 0, missingCount: 0, vlrs: [] };
        map.set(key, h);
      }
      if (!h.symbol && o.symbol) h.symbol = o.symbol;
      if (o.classification === 'loser') h.loseCount += 1;
      if (o.classification === 'missing') h.missingCount += 1;
      if (typeof o.liquidityChangePct === 'number' && o.liquidityChangePct <= DRAIN_PCT) h.drainCount += 1;
      if (typeof o.volumeToLiquidityRatio === 'number') h.vlrs.push(o.volumeToLiquidityRatio);
      const curPct = h.strongest?.priceChangePct;
      const nextPct = o.priceChangePct;
      if (!h.strongest || (typeof nextPct === 'number' && (typeof curPct !== 'number' || nextPct > curPct))) {
        h.strongest = o;
        h.strongestRunFile = run.file;
      }
    }
  }
  return map;
}

function meetsPassThresholds(o?: DexWatchOutcome): boolean {
  if (!o) return false;
  return (
    typeof o.priceChangePct === 'number' && o.priceChangePct >= PASS_PRICE_PCT &&
    typeof o.liquidityChangePct === 'number' && o.liquidityChangePct >= PASS_LIQ_PCT &&
    typeof o.volumeToLiquidityRatio === 'number' && o.volumeToLiquidityRatio <= PASS_VLR_MAX
  );
}

function hasAnyMovement(o?: DexWatchOutcome): boolean {
  if (!o) return false;
  return (
    (typeof o.priceChangePct === 'number' && o.priceChangePct > 0) ||
    (typeof o.liquidityChangePct === 'number' && o.liquidityChangePct > 0)
  );
}

function journalSimilarityNote(
  contract: string,
  symbol: string | undefined,
  journal: DexPaperJournal,
): string | undefined {
  const key = contract.toLowerCase();
  const exact = journal.trades.find(t => t.contract.toLowerCase() === key);
  if (exact) {
    const tag = symbol ? `$${symbol}` : contract.slice(0, 8);
    return `prior winner in journal: ${tag} (fake P/L +${exact.fakePnlPct.toFixed(1)}%)`;
  }
  if (symbol) {
    const symMatch = journal.trades.find(
      t => t.symbol?.toLowerCase() === symbol.toLowerCase() && t.contract.toLowerCase() !== key,
    );
    if (symMatch) {
      return `similar symbol seen winning: $${symMatch.symbol} (different contract, fake P/L +${symMatch.fakePnlPct.toFixed(1)}%)`;
    }
  }
  return undefined;
}

const RECOMMENDATION_ORDER: Record<PlanRecommendation, number> = {
  PAPER_ENTRY_CANDIDATE: 0,
  WATCH_ONLY: 1,
  BLOCKED_HISTORY_RISK: 2,
  NO_ENTRY: 3,
};

// ── Plan builder — pure ────────────────────────────────────────────────────────────────

export function buildDexPaperEntryPlans(
  runs: LoadedRun[],
  signals: PreSignal[],
  journal: DexPaperJournal,
  options: DexPaperEntryPlannerOptions,
): DexPaperEntryPlanReport {
  const positionSize = options.positionSize ?? 1;
  const fakeBankroll = options.fakeBankroll ?? 20;

  const histories = rollupHistory(runs);
  const plans: PaperEntryPlan[] = [];

  // Evaluate each contract seen in watch runs
  for (const h of histories.values()) {
    const avgVlr = avg(h.vlrs);
    const strongest = h.strongest;
    const price = strongest?.priceChangePct;
    const liq = strongest?.liquidityChangePct;
    const vlr = strongest?.volumeToLiquidityRatio;

    const riskReasons = historyRiskReasons({
      loseCount: h.loseCount,
      drainCount: h.drainCount,
      missingCount: h.missingCount,
      avgVolumeLiquidityRatio: avgVlr,
    });

    const passes = meetsPassThresholds(strongest);
    const isBlocked = riskReasons.length > 0;
    const anyMovement = hasAnyMovement(strongest);

    let recommendation: PlanRecommendation;
    const reasons: string[] = [];

    if (passes && !isBlocked) {
      recommendation = 'PAPER_ENTRY_CANDIDATE';
      reasons.push(`price +${price!.toFixed(1)}% >= +${PASS_PRICE_PCT}% threshold`);
      reasons.push(`liquidity +${liq!.toFixed(1)}% >= +${PASS_LIQ_PCT}% threshold`);
      reasons.push(`v/l ratio ${vlr!.toFixed(2)} <= ${PASS_VLR_MAX} threshold`);
      reasons.push('history clean — no losses, no drains, no missing data');
    } else if (passes && isBlocked) {
      recommendation = 'BLOCKED_HISTORY_RISK';
      reasons.push(`would pass PASS thresholds (price +${price!.toFixed(1)}%, liq +${liq!.toFixed(1)}%, v/l ${vlr!.toFixed(2)})`);
      for (const r of riskReasons) reasons.push(`BLOCKED: ${r}`);
    } else if (anyMovement && isBlocked) {
      recommendation = 'BLOCKED_HISTORY_RISK';
      reasons.push('has some movement but history-risk blocks');
      for (const r of riskReasons) reasons.push(`BLOCKED: ${r}`);
    } else if (anyMovement) {
      recommendation = 'WATCH_ONLY';
      if (typeof price === 'number' && price < PASS_PRICE_PCT) {
        reasons.push(`price +${price.toFixed(1)}% below +${PASS_PRICE_PCT}% threshold`);
      } else if (price == null) {
        reasons.push('price data missing');
      }
      if (typeof liq === 'number' && liq < PASS_LIQ_PCT) {
        reasons.push(`liquidity +${liq.toFixed(1)}% below +${PASS_LIQ_PCT}% threshold`);
      } else if (liq == null) {
        reasons.push('liquidity data missing');
      }
      if (typeof vlr === 'number' && vlr > PASS_VLR_MAX) {
        reasons.push(`v/l ${vlr.toFixed(2)} above ${PASS_VLR_MAX} threshold`);
      }
      reasons.push('moving but not clean enough for paper entry');
    } else {
      recommendation = 'NO_ENTRY';
      if (price == null) reasons.push('no price data available');
      else if (price <= 0) reasons.push(`price flat or negative (${price.toFixed(1)}%)`);
      if (liq == null) reasons.push('no liquidity data');
      if (h.missingCount >= HISTORY_RISK_MIN) reasons.push('missing snapshot history');
      if (!reasons.length) reasons.push('insufficient movement or data');
    }

    const sigKey = h.contract.toLowerCase();
    const matchedSignal = signals.find(s => s.contract?.toLowerCase() === sigKey);
    const sim = journalSimilarityNote(h.contract, h.symbol, journal);

    plans.push({
      symbol: h.symbol,
      contract: h.contract,
      recommendation,
      fakeEntrySize: positionSize,
      fakeStopLossPct: PLAN_STOP_LOSS_PCT,
      fakeTakeProfitPct: PLAN_FIRST_TP_PCT,
      fakeRunnerTargetPct: PLAN_RUNNER_TARGET_PCT,
      cancelConditions: CANCEL_CONDITIONS,
      reasons,
      priceChangePct: price,
      liquidityChangePct: liq,
      volumeLiquidityRatio: vlr,
      historyRiskStatus: isBlocked ? 'BLOCKED' : 'CLEAN',
      historyRiskReasons: riskReasons.length > 0 ? riskReasons : undefined,
      journalSimilarity: sim,
      sourceSignalFile: matchedSignal ? options.signalsFile : undefined,
      sourceRunFile: h.strongestRunFile,
      tradingExecuted: 0,
      noRealTradeSent: true,
      readOnly: true,
      paperOnly: true,
    });
  }

  // Signals not seen in any run → NO_ENTRY
  for (const sig of signals) {
    if (!sig.contract) continue;
    const key = sig.contract.toLowerCase();
    if (!histories.has(key)) {
      plans.push({
        symbol: sig.symbol,
        contract: sig.contract,
        recommendation: 'NO_ENTRY',
        fakeEntrySize: positionSize,
        fakeStopLossPct: PLAN_STOP_LOSS_PCT,
        fakeTakeProfitPct: PLAN_FIRST_TP_PCT,
        fakeRunnerTargetPct: PLAN_RUNNER_TARGET_PCT,
        cancelConditions: CANCEL_CONDITIONS,
        reasons: ['in signals file but no watch run data available'],
        historyRiskStatus: 'UNKNOWN',
        sourceSignalFile: options.signalsFile,
        tradingExecuted: 0,
        noRealTradeSent: true,
        readOnly: true,
        paperOnly: true,
      });
    }
  }

  plans.sort((a, b) => {
    const od = RECOMMENDATION_ORDER[a.recommendation] - RECOMMENDATION_ORDER[b.recommendation];
    if (od !== 0) return od;
    return (b.priceChangePct ?? -Infinity) - (a.priceChangePct ?? -Infinity);
  });

  return {
    plannedAt: options.plannedAt,
    signalsFile: options.signalsFile,
    runsDir: options.runsDir,
    journalFile: options.journalFile,
    fakeBankroll,
    fakePositionSize: positionSize,
    totalPlans: plans.length,
    paperEntryCandidates: plans.filter(p => p.recommendation === 'PAPER_ENTRY_CANDIDATE').length,
    watchOnly: plans.filter(p => p.recommendation === 'WATCH_ONLY').length,
    blockedHistoryRisk: plans.filter(p => p.recommendation === 'BLOCKED_HISTORY_RISK').length,
    noEntry: plans.filter(p => p.recommendation === 'NO_ENTRY').length,
    plans,
    readOnly: true,
    paperOnly: true,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

// ── I/O helpers ────────────────────────────────────────────────────────────────────────

export function loadPlannerSignals(signalsFile: string): PreSignal[] {
  if (!fs.existsSync(signalsFile)) return [];
  try {
    return dexLoadPresignals(signalsFile);
  } catch {
    return [];
  }
}

export function loadPlannerJournal(journalFile: string): DexPaperJournal | null {
  if (!fs.existsSync(journalFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(journalFile, 'utf-8')) as DexPaperJournal;
  } catch {
    return null;
  }
}

export function writePlan(report: DexPaperEntryPlanReport, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
}

function emptyJournal(options: DexPaperEntryPlannerOptions): DexPaperJournal {
  return {
    dir: options.runsDir,
    out: options.out,
    fakeBankroll: options.fakeBankroll ?? 20,
    fakePositionSize: options.positionSize ?? 1,
    totalSimulatedTrades: 0,
    totalFakePnlDollars: 0,
    totalFakePnlPct: 0,
    winRate: 0,
    blockedByHistoryRisk: 0,
    trades: [],
    blocked: [],
    readOnly: true,
    paperOnly: true,
    dryRun: false,
    tradingExecuted: 0,
    noRealTradeSent: true,
  };
}

export function runDexPaperEntryPlanner(options: DexPaperEntryPlannerOptions): DexPaperEntryPlanReport {
  const runs = loadRunsWithFiles(options.runsDir);
  const signals = loadPlannerSignals(options.signalsFile);
  const journal = loadPlannerJournal(options.journalFile) ?? emptyJournal(options);

  const report = buildDexPaperEntryPlans(runs, signals, journal, options);
  writePlan(report, options.out);
  return report;
}

// ── Renderer — pure ────────────────────────────────────────────────────────────────────

function fmtPct(v?: number): string {
  if (v == null) return 'n/a';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

export function renderDexPaperEntryPlanReport(report: DexPaperEntryPlanReport): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX PAPER ENTRY PLANNER V1');
  lines.push('  READ-ONLY — PAPER ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  No wallet. No signing. No swap. No liveHarness changes.');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Signals file             : ${report.signalsFile}`);
  lines.push(`  Runs dir                 : ${report.runsDir}`);
  lines.push(`  Journal file             : ${report.journalFile}`);
  lines.push(`  Fake bankroll            : $${report.fakeBankroll.toFixed(2)}`);
  lines.push(`  Fake position size       : $${report.fakePositionSize.toFixed(2)}`);
  lines.push(`  Total plans              : ${report.totalPlans}`);
  lines.push('');
  lines.push(`  PAPER_ENTRY_CANDIDATE    : ${report.paperEntryCandidates}`);
  lines.push(`  WATCH_ONLY               : ${report.watchOnly}`);
  lines.push(`  BLOCKED_HISTORY_RISK     : ${report.blockedHistoryRisk}`);
  lines.push(`  NO_ENTRY                 : ${report.noEntry}`);

  const topPlans = report.plans.filter(p => p.recommendation !== 'NO_ENTRY').slice(0, 5);
  if (topPlans.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Top plans (PAPER_ENTRY_CANDIDATE and WATCH_ONLY, top 5):');
    for (const p of topPlans) {
      const sym = (p.symbol ? `$${p.symbol}` : '(no sym)').padEnd(14);
      const vlr = p.volumeLiquidityRatio != null ? p.volumeLiquidityRatio.toFixed(2) : 'n/a';
      lines.push(
        `    ${p.recommendation.padEnd(24)} ${sym}` +
          ` price ${fmtPct(p.priceChangePct).padStart(8)}` +
          `  liq ${fmtPct(p.liquidityChangePct).padStart(8)}  v/l ${vlr.padStart(6)}`,
      );
      if (p.journalSimilarity) lines.push(`      JOURNAL: ${p.journalSimilarity}`);
      lines.push(`      stop ${p.fakeStopLossPct}%  first-TP +${p.fakeTakeProfitPct}%  runner +${p.fakeRunnerTargetPct}%`);
      lines.push(`      ${p.reasons.slice(0, 2).join(' | ')}`);
      if (p.sourceRunFile) lines.push(`      source run: ${p.sourceRunFile}`);
    }
  }

  if (report.blockedHistoryRisk > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push(`  BLOCKED_HISTORY_RISK (${report.blockedHistoryRisk}):`);
    for (const p of report.plans.filter(q => q.recommendation === 'BLOCKED_HISTORY_RISK').slice(0, 10)) {
      const sym = (p.symbol ? `$${p.symbol}` : '(no sym)').padEnd(14);
      lines.push(`    ${sym} ${p.contract.slice(0, 8)}…  — ${(p.historyRiskReasons ?? []).join('; ')}`);
    }
  }

  lines.push('');
  lines.push(WIDE);
  lines.push('  PAPER PLANNER ONLY — read-only — no positions opened by this command');
  lines.push('  Stop/TP/cancel are hypothetical — for planning purposes only');
  lines.push('  token:auto-paper was NOT run — tradingExecuted: 0 — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
