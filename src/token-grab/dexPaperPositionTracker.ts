import fs from 'node:fs';
import path from 'node:path';
import type { DexWatchReport, DexWatchOutcome, DexPairSnapshot } from './dexWatch';
import type { DexPaperEntryPlanReport, PaperEntryPlan } from './dexPaperEntryPlanner';
import { PLAN_STOP_LOSS_PCT, PLAN_FIRST_TP_PCT, PLAN_RUNNER_TARGET_PCT } from './dexPaperEntryPlanner';
import { loadRunsWithFiles, type LoadedRun } from './dexPaperJournal';
import { loadDayLog, type DayWatchCycleEntry } from './dexDayWatch';

// ── Constants ──────────────────────────────────────────────────────────────────────────

const LIQUIDITY_DUMP_PCT = -25;
const VLR_SPIKE_THRESHOLD = 3.0;
const DEFAULT_MAX_HOLD_MINUTES = 20;

// ── Types ──────────────────────────────────────────────────────────────────────────────

export type ExitReason =
  | 'RUNNER_TARGET'
  | 'TAKE_PROFIT'
  | 'STOP_LOSS'
  | 'LIQUIDITY_DUMP'
  | 'VLR_SPIKE'
  | 'MAX_HOLD_TIMEOUT'
  | 'STILL_OPEN'
  | 'MISSING_OR_STALE';

export type PositionStatus = 'CLOSED' | 'OPEN';

export interface TrackedPosition {
  symbol?: string;
  contract: string;
  sourceRunFile: string;
  entryObservedAt: string;
  exitObservedAt?: string;
  entryPriceUsd?: number;
  exitPriceUsd?: number;
  entryLiquidityUsd?: number;
  exitLiquidityUsd?: number;
  entryVolumeLiquidityRatio?: number;
  exitVolumeLiquidityRatio?: number;
  maxRunupPct: number;
  maxDrawdownPct: number;
  holdMinutes: number;
  exitReason: ExitReason;
  fakePnlDollars: number;
  status: PositionStatus;
}

export interface DexPaperPositionReport {
  generatedAt: string;
  sourcePlanner: string;
  sourceMode?: 'planner' | 'day-log';
  runsDir: string;
  totalPositions: number;
  openPositions: number;
  closedPositions: number;
  totalFakePnlDollars: number;
  winRatePct: number;
  positions: TrackedPosition[];
  tradingExecuted: 0;
  noRealTradeSent: true;
  readOnly: true;
  paperOnly: true;
}

export interface DexPaperPositionTrackerOptions {
  plannerFile: string;
  runsDir: string;
  out: string;
  positionSize?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  runnerTargetPct?: number;
  maxHoldMinutes?: number;
  generatedAt?: string;
  dayLogFile?: string;
  sourceMode?: 'planner' | 'day-log';
}

// ── Pure helpers ────────────────────────────────────────────────────────────────────────

export function getAllOutcomes(report: DexWatchReport): DexWatchOutcome[] {
  return [...report.winners, ...report.losers, ...report.flat, ...report.missing];
}

export function computeSnapshotVlr(snap?: DexPairSnapshot): number | undefined {
  if (!snap?.volumeUsd || !snap?.liquidityUsd || snap.liquidityUsd === 0) return undefined;
  return snap.volumeUsd / snap.liquidityUsd;
}

function pctChange(from?: number, to?: number): number | undefined {
  if (from == null || to == null || from === 0) return undefined;
  return ((to - from) / from) * 100;
}

// ── Position builder — pure ──────────────────────────────────────────────────────────────

interface PositionOpts {
  positionSize: number;
  stopLossPct: number;
  takeProfitPct: number;
  runnerTargetPct: number;
  maxHoldMinutes: number;
}

export function buildTrackedPosition(
  plan: PaperEntryPlan,
  sourceRun: LoadedRun,
  laterRuns: LoadedRun[],
  opts: PositionOpts,
): TrackedPosition {
  const contractKey = plan.contract.toLowerCase();
  const sourceOutcome = getAllOutcomes(sourceRun.report).find(
    o => o.contract.toLowerCase() === contractKey,
  );

  const stale = (): TrackedPosition => ({
    symbol: plan.symbol,
    contract: plan.contract,
    sourceRunFile: sourceRun.file,
    entryObservedAt: sourceRun.report.generatedAt ?? '',
    maxRunupPct: 0,
    maxDrawdownPct: 0,
    holdMinutes: 0,
    exitReason: 'MISSING_OR_STALE',
    fakePnlDollars: 0,
    status: 'CLOSED',
  });

  const entry = sourceOutcome?.entry;
  if (!entry?.priceUsd) return stale();

  const entryPrice = entry.priceUsd;
  const entryLiq = entry.liquidityUsd;
  const entryVlr = computeSnapshotVlr(entry);
  const entryAt = entry.observedAt;
  const entryMs = new Date(entryAt).getTime();
  if (isNaN(entryMs)) return stale();

  // Collect all post-entry price observations in chronological order.
  const observations: DexPairSnapshot[] = [];
  if (sourceOutcome?.final) observations.push(sourceOutcome.final);
  for (const run of laterRuns) {
    const o = getAllOutcomes(run.report).find(x => x.contract.toLowerCase() === contractKey);
    if (o?.entry) observations.push(o.entry);
    if (o?.final) observations.push(o.final);
  }
  observations.sort((a, b) => a.observedAt.localeCompare(b.observedAt));

  if (observations.length === 0) {
    return {
      ...stale(),
      entryObservedAt: entryAt,
      entryPriceUsd: entryPrice,
      entryLiquidityUsd: entryLiq,
      entryVolumeLiquidityRatio: entryVlr,
    };
  }

  let maxRunupPct = 0;
  let maxDrawdownPct = 0;
  let exitObs: DexPairSnapshot | undefined;
  let exitReason: ExitReason = 'STILL_OPEN';

  for (const obs of observations) {
    if (!obs.priceUsd) continue;

    const obsMs = new Date(obs.observedAt).getTime();
    const holdMins = isNaN(obsMs) ? 0 : (obsMs - entryMs) / 60000;

    // Time boundary checked first — out-of-window snapshots must not trigger price exits.
    if (holdMins >= opts.maxHoldMinutes) {
      exitObs = obs; exitReason = 'MAX_HOLD_TIMEOUT'; break;
    }

    const priceChg = ((obs.priceUsd - entryPrice) / entryPrice) * 100;
    const liqChg = pctChange(entryLiq, obs.liquidityUsd);
    const vlr = computeSnapshotVlr(obs);

    if (priceChg > maxRunupPct) maxRunupPct = priceChg;
    if (priceChg < maxDrawdownPct) maxDrawdownPct = priceChg;

    if (priceChg >= opts.runnerTargetPct) {
      exitObs = obs; exitReason = 'RUNNER_TARGET'; break;
    }
    if (priceChg >= opts.takeProfitPct) {
      exitObs = obs; exitReason = 'TAKE_PROFIT'; break;
    }
    if (priceChg <= opts.stopLossPct) {
      exitObs = obs; exitReason = 'STOP_LOSS'; break;
    }
    if (liqChg != null && liqChg <= LIQUIDITY_DUMP_PCT) {
      exitObs = obs; exitReason = 'LIQUIDITY_DUMP'; break;
    }
    if (vlr != null && vlr >= VLR_SPIKE_THRESHOLD) {
      exitObs = obs; exitReason = 'VLR_SPIKE'; break;
    }
  }

  // STILL_OPEN: use last known observation as current state.
  const lastObs = exitObs ?? observations[observations.length - 1];
  const exitPrice = lastObs?.priceUsd;
  const exitAt = lastObs?.observedAt;
  const exitLiq = lastObs?.liquidityUsd;
  const exitVlr = computeSnapshotVlr(lastObs);

  const finalPriceChg = exitPrice ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
  const fakePnlDollars = opts.positionSize * (finalPriceChg / 100);
  const exitMs = exitAt ? new Date(exitAt).getTime() : NaN;
  const rawHoldMinutes = isNaN(exitMs) ? 0 : (exitMs - entryMs) / 60000;
  // MAX_HOLD_TIMEOUT exits the position at the window boundary, not at the (later) snapshot time.
  const holdMinutes = exitReason === 'MAX_HOLD_TIMEOUT'
    ? Math.min(rawHoldMinutes, opts.maxHoldMinutes)
    : rawHoldMinutes;

  return {
    symbol: plan.symbol,
    contract: plan.contract,
    sourceRunFile: sourceRun.file,
    entryObservedAt: entryAt,
    exitObservedAt: exitAt,
    entryPriceUsd: entryPrice,
    exitPriceUsd: exitPrice,
    entryLiquidityUsd: entryLiq,
    exitLiquidityUsd: exitLiq,
    entryVolumeLiquidityRatio: entryVlr,
    exitVolumeLiquidityRatio: exitVlr,
    maxRunupPct,
    maxDrawdownPct,
    holdMinutes,
    exitReason,
    fakePnlDollars,
    status: exitReason === 'STILL_OPEN' ? 'OPEN' : 'CLOSED',
  };
}

// ── Day-log plan extractor — pure ────────────────────────────────────────────────────────

export function buildPlansFromDayLog(entries: DayWatchCycleEntry[]): PaperEntryPlan[] {
  const seen = new Set<string>();
  const plans: PaperEntryPlan[] = [];
  for (const entry of entries) {
    if (!entry.newestRunFile) continue;
    for (const te of entry.topCurrentCycleEntries) {
      const key = `${te.contract.toLowerCase()}|${entry.newestRunFile}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plans.push({
        symbol: te.symbol,
        contract: te.contract,
        recommendation: 'CURRENT_CYCLE_PAPER_ENTRY',
        isCurrentCycle: true,
        sourceRunFile: entry.newestRunFile,
        latestRunFile: entry.newestRunFile,
        fakeEntrySize: 1,
        fakeStopLossPct: PLAN_STOP_LOSS_PCT,
        fakeTakeProfitPct: PLAN_FIRST_TP_PCT,
        fakeRunnerTargetPct: PLAN_RUNNER_TARGET_PCT,
        cancelConditions: [],
        reasons: [],
        historyRiskStatus: 'CLEAN',
        tradingExecuted: 0,
        noRealTradeSent: true,
        readOnly: true,
        paperOnly: true,
      });
    }
  }
  return plans;
}

// ── Report builder — pure ────────────────────────────────────────────────────────────────

export function buildDexPaperPositionReport(
  planReport: DexPaperEntryPlanReport,
  runs: LoadedRun[],
  options: DexPaperPositionTrackerOptions,
): DexPaperPositionReport {
  const positionSize = options.positionSize ?? 1;
  const stopLossPct = options.stopLossPct ?? PLAN_STOP_LOSS_PCT;
  const takeProfitPct = options.takeProfitPct ?? PLAN_FIRST_TP_PCT;
  const runnerTargetPct = options.runnerTargetPct ?? PLAN_RUNNER_TARGET_PCT;
  const maxHoldMinutes = options.maxHoldMinutes ?? DEFAULT_MAX_HOLD_MINUTES;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const posOpts: PositionOpts = { positionSize, stopLossPct, takeProfitPct, runnerTargetPct, maxHoldMinutes };

  // Sort runs lexicographically — run-YYYYMMDD-HHMMSS.json sorts correctly as time order.
  const sortedRuns = [...runs].sort((a, b) => a.file.localeCompare(b.file));

  const positions: TrackedPosition[] = [];
  for (const plan of planReport.plans) {
    if (plan.recommendation !== 'CURRENT_CYCLE_PAPER_ENTRY') continue;

    const sourceFile = plan.sourceRunFile ?? plan.latestRunFile;
    if (!sourceFile) {
      positions.push({
        symbol: plan.symbol,
        contract: plan.contract,
        sourceRunFile: '',
        entryObservedAt: '',
        maxRunupPct: 0,
        maxDrawdownPct: 0,
        holdMinutes: 0,
        exitReason: 'MISSING_OR_STALE',
        fakePnlDollars: 0,
        status: 'CLOSED',
      });
      continue;
    }

    const sourceIdx = sortedRuns.findIndex(r => r.file === sourceFile);
    if (sourceIdx < 0) {
      positions.push({
        symbol: plan.symbol,
        contract: plan.contract,
        sourceRunFile: sourceFile,
        entryObservedAt: '',
        maxRunupPct: 0,
        maxDrawdownPct: 0,
        holdMinutes: 0,
        exitReason: 'MISSING_OR_STALE',
        fakePnlDollars: 0,
        status: 'CLOSED',
      });
      continue;
    }

    positions.push(
      buildTrackedPosition(plan, sortedRuns[sourceIdx], sortedRuns.slice(sourceIdx + 1), posOpts),
    );
  }

  const closed = positions.filter(p => p.status === 'CLOSED');
  const open = positions.filter(p => p.status === 'OPEN');
  const totalFakePnl = positions.reduce((s, p) => s + p.fakePnlDollars, 0);
  const wins = closed.filter(p => p.fakePnlDollars > 0).length;
  const winRatePct = closed.length > 0 ? (wins / closed.length) * 100 : 0;

  return {
    generatedAt,
    sourcePlanner: options.plannerFile,
    sourceMode: options.sourceMode ?? 'planner',
    runsDir: options.runsDir,
    totalPositions: positions.length,
    openPositions: open.length,
    closedPositions: closed.length,
    totalFakePnlDollars: totalFakePnl,
    winRatePct,
    positions,
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  };
}

// ── I/O helpers ──────────────────────────────────────────────────────────────────────────

export function loadPlannerReport(plannerFile: string): DexPaperEntryPlanReport | null {
  if (!fs.existsSync(plannerFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(plannerFile, 'utf-8')) as DexPaperEntryPlanReport;
  } catch {
    return null;
  }
}

export function writeDexPaperPositionReport(report: DexPaperPositionReport, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
}

// ── Orchestrator ─────────────────────────────────────────────────────────────────────────

export function runDexPaperPositionTracker(options: DexPaperPositionTrackerOptions): DexPaperPositionReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  // Day-log mode: derive positions from JSONL cycle entries instead of the planner snapshot.
  if (options.dayLogFile) {
    const dayEntries = loadDayLog(options.dayLogFile);
    const plans = buildPlansFromDayLog(dayEntries);
    const syntheticPlanReport: DexPaperEntryPlanReport = {
      signalsFile: '',
      runsDir: options.runsDir,
      journalFile: '',
      fakeBankroll: 0,
      fakePositionSize: options.positionSize ?? 1,
      totalPlans: plans.length,
      currentCyclePaperEntry: plans.length,
      historicalJournalWinners: 0,
      watchOnly: 0,
      blockedHistoryRisk: 0,
      noEntry: 0,
      plans,
      readOnly: true,
      paperOnly: true,
      tradingExecuted: 0,
      noRealTradeSent: true,
    };
    const runs = loadRunsWithFiles(options.runsDir);
    const report = buildDexPaperPositionReport(syntheticPlanReport, runs, {
      ...options,
      plannerFile: options.dayLogFile,
      sourceMode: 'day-log',
      generatedAt,
    });
    writeDexPaperPositionReport(report, options.out);
    return report;
  }

  // Planner mode: read planner JSON snapshot.
  const planReport = loadPlannerReport(options.plannerFile);
  if (!planReport) {
    const empty: DexPaperPositionReport = {
      generatedAt,
      sourcePlanner: options.plannerFile,
      sourceMode: 'planner',
      runsDir: options.runsDir,
      totalPositions: 0,
      openPositions: 0,
      closedPositions: 0,
      totalFakePnlDollars: 0,
      winRatePct: 0,
      positions: [],
      tradingExecuted: 0,
      noRealTradeSent: true,
      readOnly: true,
      paperOnly: true,
    };
    writeDexPaperPositionReport(empty, options.out);
    return empty;
  }

  const runs = loadRunsWithFiles(options.runsDir);
  const report = buildDexPaperPositionReport(planReport, runs, { ...options, sourceMode: 'planner', generatedAt });
  writeDexPaperPositionReport(report, options.out);
  return report;
}

// ── Usage string — pure ──────────────────────────────────────────────────────────────────

export function renderDexPaperPositionTrackerUsage(): string {
  return [
    'Usage: npm run token:dex-paper-position-tracker -- [options]',
    '',
    'Paper-only position tracker: reads CURRENT_CYCLE_PAPER_ENTRY plans and',
    'computes what would have happened using later run data.',
    'READ-ONLY. PAPER ONLY. No wallet. No signing. No swap. tradingExecuted: 0.',
    '',
    'Options:',
    '  --runs-dir <path>           Watch runs directory (default: data/token-grab/dex-watch-runs)',
    '  --planner <path>            Planner output JSON (default: data/token-grab/paper-plans/dex-paper-entry-plan.json)',
    '  --day-log <path>            Day watch JSONL log (optional; overrides --planner as entry source)',
    '  --out <path>                Position report output (default: data/token-grab/paper-positions/dex-paper-positions.json)',
    '  --position-size <n>         Fake position size in USD (default: 1)',
    '  --stop-loss-pct <n>         Stop-loss percent (default: -20)',
    '  --take-profit-pct <n>       Take-profit percent (default: 25)',
    '  --runner-target-pct <n>     Runner target percent (default: 50)',
    '  --max-hold-minutes <n>      Max hold time in minutes (default: 20)',
    '  --json                      Output JSON instead of text',
    '  --help, -h                  Show this help and exit',
    '',
    'Exit reasons:',
    '  RUNNER_TARGET      — price reached +50% (or --runner-target-pct)',
    '  TAKE_PROFIT        — price reached +25% (or --take-profit-pct)',
    '  STOP_LOSS          — price fell to -20% (or --stop-loss-pct)',
    '  LIQUIDITY_DUMP     — liquidity dropped >= 25% from entry',
    '  VLR_SPIKE          — volume/liquidity ratio rose above 3.0 after entry',
    '  MAX_HOLD_TIMEOUT   — position held longer than --max-hold-minutes',
    '  STILL_OPEN         — no exit condition met, position still open',
    '  MISSING_OR_STALE   — later snapshots are missing or unusable',
  ].join('\n');
}

// ── Renderer — pure ──────────────────────────────────────────────────────────────────────

function fmtPct(v?: number): string {
  if (v == null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function fmtUsd(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

export function renderDexPaperPositionTrackerReport(report: DexPaperPositionReport): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX PAPER POSITION TRACKER V1');
  lines.push('  PAPER ONLY — READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  No wallet. No signing. No swap. No liveHarness changes.');
  lines.push(WIDE);
  lines.push('');
  const sourceMode = report.sourceMode ?? 'planner';
  const sourceLabel = sourceMode === 'day-log' ? 'Source day log   ' : 'Source planner   ';
  lines.push(`  Generated at     : ${report.generatedAt}`);
  lines.push(`  Source mode      : ${sourceMode}`);
  lines.push(`  ${sourceLabel}: ${report.sourcePlanner}`);
  lines.push(`  Runs dir         : ${report.runsDir}`);
  lines.push('');
  lines.push(`  Total positions  : ${report.totalPositions}`);
  lines.push(`  Closed           : ${report.closedPositions}`);
  lines.push(`  Open             : ${report.openPositions}`);
  lines.push(`  Total fake P/L   : ${fmtUsd(report.totalFakePnlDollars)}`);
  lines.push(`  Win rate         : ${report.winRatePct.toFixed(1)}%`);

  if (report.positions.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Positions');
    lines.push(THIN);

    for (const p of report.positions) {
      const sym = (p.symbol ? `$${p.symbol}` : '(no sym)').padEnd(14);
      const exit = p.exitReason.padEnd(18);
      const pnl = fmtUsd(p.fakePnlDollars).padStart(8);
      const maxUp = fmtPct(p.maxRunupPct).padStart(8);
      const maxDn = fmtPct(p.maxDrawdownPct).padStart(8);
      const hold = `${p.holdMinutes.toFixed(0)}m`.padStart(4);
      lines.push(`  ${sym} ${exit} P/L ${pnl}  max↑ ${maxUp}  max↓ ${maxDn}  hold ${hold}`);
    }

    // Exit reason counts
    const reasonCounts = new Map<string, number>();
    for (const p of report.positions) {
      reasonCounts.set(p.exitReason, (reasonCounts.get(p.exitReason) ?? 0) + 1);
    }
    lines.push('');
    lines.push(THIN);
    lines.push('  Exit reason breakdown');
    lines.push(THIN);
    const exitReasonOrder: ExitReason[] = [
      'RUNNER_TARGET', 'TAKE_PROFIT', 'STOP_LOSS', 'LIQUIDITY_DUMP',
      'VLR_SPIKE', 'MAX_HOLD_TIMEOUT', 'STILL_OPEN', 'MISSING_OR_STALE',
    ];
    for (const reason of exitReasonOrder) {
      const count = reasonCounts.get(reason);
      if (count) lines.push(`  ${reason.padEnd(20)}: ${count}`);
    }
  } else {
    lines.push('');
    lines.push('  No positions to track. Run day watch first, then check for CURRENT_CYCLE_PAPER_ENTRY.');
  }

  lines.push('');
  lines.push(WIDE);
  lines.push('  PAPER TRACKER — positions are hypothetical — no real entry or exit');
  lines.push('  Fake P/L is for simulation only — no trading, no wallet, no swap');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
