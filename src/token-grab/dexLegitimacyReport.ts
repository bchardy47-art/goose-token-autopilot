import fs from 'node:fs';
import path from 'node:path';
import { loadDayLog, type DayWatchCycleEntry } from './dexDayWatch';
import type { TopEntry, TopBlockedMover } from './dexValidationLoop';
import type {
  DexPaperPositionReport,
  TrackedPosition,
  ExitReason,
  PositionStatus,
} from './dexPaperPositionTracker';

// ── Types ────────────────────────────────────────────────────────────────────────────────

export type LegitimacyVerdict = 'PASS_TO_HUMAN' | 'WATCH' | 'IGNORE' | 'DANGER';
export type LegitimacyConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type FinalRecommendation =
  | 'MANUAL_REVIEW_READY'
  | 'COLLECT_MORE_DATA'
  | 'TOO_MUCH_JUNK'
  | 'NO_CLEAN_SIGNAL';

export interface LegitimacyItem {
  symbol?: string;
  contract: string;
  sourceRunFile?: string;
  observedAt?: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  paperPositionStatus?: PositionStatus;
  paperExitReason?: ExitReason;
  paperFakePnlDollars?: number;
  maxRunupPct?: number;
  maxDrawdownPct?: number;
  legitimacyVerdict: LegitimacyVerdict;
  confidence: LegitimacyConfidence;
  reasons: string[];
  missingSignals: string[];
  holderConcentrationStatus: 'UNKNOWN';
  creatorWalletStatus: 'UNKNOWN';
  bubbleMapStatus: 'UNKNOWN';
  socialChatterStatus: 'UNKNOWN';
  mintAuthorityStatus: 'UNKNOWN';
  freezeAuthorityStatus: 'UNKNOWN';
  liquidityLockStatus: 'UNKNOWN';
}

export interface BlockedMoverItem {
  symbol?: string;
  contract: string;
  sourceRunFile?: string;
  cycle?: number;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  blockedReasons: string[];
  verdict: 'DANGER' | 'IGNORE';
}

export interface DexLegitimacyReport {
  generatedAt: string;
  dayLogPath: string;
  runsDir: string;
  positionsPath?: string;
  totalCurrentCycleEntriesReviewed: number;
  passToHumanCount: number;
  watchCount: number;
  ignoreCount: number;
  dangerCount: number;
  items: LegitimacyItem[];
  blockedMovers: BlockedMoverItem[];
  finalRecommendation: FinalRecommendation;
  missingSignalSummary: string[];
  tradingExecuted: 0;
  noRealTradeSent: true;
  readOnly: true;
  paperOnly: true;
}

export interface DexLegitimacyReportOptions {
  dayLogPath: string;
  runsDir: string;
  positionsPath?: string;
  outPath: string;
  generatedAt?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────────────────

const PASS_PRICE_PCT = 15;
const PASS_LIQ_PCT = 5;
const PASS_VLR_MAX = 1;

const DANGER_BLOCK_KEYWORDS = [
  'drain', 'lose', 'missing', 'vlr', 'liquidity', 'dump', 'spike',
];

export const ALWAYS_MISSING_SIGNALS: string[] = [
  'HOLDER_MAP_NOT_CONNECTED',
  'CREATOR_WALLET_NOT_CONNECTED',
  'BUBBLE_MAP_NOT_CONNECTED',
  'SOCIAL_CHATTER_NOT_CONNECTED',
  'MINT_FREEZE_NOT_CONNECTED',
  'LP_LOCK_NOT_CONNECTED',
];

// ── Pure scoring helpers ──────────────────────────────────────────────────────────────────

export function scoreEntry(
  entry: TopEntry,
  position?: TrackedPosition,
): { verdict: LegitimacyVerdict; confidence: LegitimacyConfidence; reasons: string[] } {
  const reasons: string[] = [];

  const hasPrice = entry.priceChangePct != null;
  const hasLiq = entry.liquidityChangePct != null;
  const hasVlr = entry.volumeLiquidityRatio != null;

  // DANGER: paper position triggered a safety exit.
  if (position) {
    const badExit =
      position.exitReason === 'STOP_LOSS' ||
      position.exitReason === 'LIQUIDITY_DUMP' ||
      position.exitReason === 'VLR_SPIKE';
    if (badExit) {
      reasons.push(`paper position exited: ${position.exitReason}`);
      return { verdict: 'DANGER', confidence: 'HIGH', reasons };
    }
  }

  // DANGER: VLR too high.
  if (hasVlr && entry.volumeLiquidityRatio! > PASS_VLR_MAX) {
    reasons.push(`VLR too high: ${entry.volumeLiquidityRatio!.toFixed(2)}`);
    return { verdict: 'DANGER', confidence: 'MEDIUM', reasons };
  }

  // No useful market data at all.
  if (!hasPrice && !hasLiq && !hasVlr) {
    reasons.push('INSUFFICIENT_MARKET_DATA');
    return { verdict: 'IGNORE', confidence: 'LOW', reasons };
  }

  const priceOk = hasPrice && entry.priceChangePct! >= PASS_PRICE_PCT;
  const liqOk = hasLiq && entry.liquidityChangePct! >= PASS_LIQ_PCT;
  const vlrOk = !hasVlr || entry.volumeLiquidityRatio! <= PASS_VLR_MAX;

  // PASS_TO_HUMAN: all market thresholds met.
  if (priceOk && liqOk && vlrOk) {
    reasons.push(`price +${entry.priceChangePct!.toFixed(1)}%`);
    reasons.push(`liquidity +${entry.liquidityChangePct!.toFixed(1)}%`);
    if (hasVlr) reasons.push(`VLR ${entry.volumeLiquidityRatio!.toFixed(2)} ≤ ${PASS_VLR_MAX}`);

    if (position) {
      const inconclusive =
        position.exitReason === 'MAX_HOLD_TIMEOUT' ||
        position.exitReason === 'STILL_OPEN' ||
        position.exitReason === 'MISSING_OR_STALE';
      if (inconclusive) {
        reasons.push(`paper result inconclusive: ${position.exitReason}`);
        return { verdict: 'WATCH', confidence: 'MEDIUM', reasons };
      }
    }

    const confidence: LegitimacyConfidence = position ? 'HIGH' : 'MEDIUM';
    if (!position) reasons.push('no paper position matched — market data looks clean');
    return { verdict: 'PASS_TO_HUMAN', confidence, reasons };
  }

  // WATCH: partial conditions met (some but not all thresholds).
  if (priceOk || liqOk) {
    if (priceOk) reasons.push(`price ok: +${entry.priceChangePct!.toFixed(1)}%`);
    if (!priceOk && hasPrice) reasons.push(`price weak: ${entry.priceChangePct!.toFixed(1)}%`);
    if (liqOk) reasons.push(`liquidity ok: +${entry.liquidityChangePct!.toFixed(1)}%`);
    if (!liqOk && hasLiq) reasons.push(`liquidity weak: ${entry.liquidityChangePct!.toFixed(1)}%`);
    if (!hasVlr) reasons.push('VLR_MISSING');
    return { verdict: 'WATCH', confidence: 'LOW', reasons };
  }

  // IGNORE: weak movement or insufficient info.
  if (hasPrice) reasons.push(`price weak: ${entry.priceChangePct!.toFixed(1)}%`);
  if (hasLiq) reasons.push(`liquidity weak: ${entry.liquidityChangePct!.toFixed(1)}%`);
  if (!hasPrice && !hasLiq) reasons.push('INSUFFICIENT_MARKET_DATA');
  return { verdict: 'IGNORE', confidence: 'LOW', reasons };
}

export function scoreBlockedMover(b: TopBlockedMover): 'DANGER' | 'IGNORE' {
  const hasDangerReason = b.blockReasons.some(r =>
    DANGER_BLOCK_KEYWORDS.some(kw => r.toLowerCase().includes(kw)),
  );
  const vlrHigh = b.volumeLiquidityRatio != null && b.volumeLiquidityRatio > PASS_VLR_MAX;
  return hasDangerReason || vlrHigh ? 'DANGER' : 'IGNORE';
}

export function determineFinalRecommendation(
  passToHumanCount: number,
  watchCount: number,
  _ignoreCount: number,
  dangerCount: number,
): FinalRecommendation {
  if (passToHumanCount > 0) return 'MANUAL_REVIEW_READY';
  if (dangerCount > 0 && dangerCount > passToHumanCount + watchCount) return 'TOO_MUCH_JUNK';
  if (watchCount > 0) return 'COLLECT_MORE_DATA';
  return 'NO_CLEAN_SIGNAL';
}

// ── Builder — pure ────────────────────────────────────────────────────────────────────────

export function buildDexLegitimacyReport(
  dayLogEntries: DayWatchCycleEntry[],
  positions: DexPaperPositionReport | null,
  opts: {
    dayLogPath: string;
    runsDir: string;
    positionsPath?: string;
    generatedAt?: string;
  },
): DexLegitimacyReport {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  // Collect unique current-cycle entries from all day-log cycles (first occurrence wins).
  const entryMap = new Map<string, { entry: TopEntry; cycleEntry: DayWatchCycleEntry }>();
  for (const cycleEntry of dayLogEntries) {
    for (const e of cycleEntry.topCurrentCycleEntries) {
      const key = e.contract.toLowerCase();
      if (!entryMap.has(key)) {
        entryMap.set(key, { entry: e, cycleEntry });
      }
    }
  }

  // Index paper positions by contract.
  const positionMap = new Map<string, TrackedPosition>();
  if (positions) {
    for (const p of positions.positions) {
      positionMap.set(p.contract.toLowerCase(), p);
    }
  }

  // Build one legitimacy item per unique current-cycle token.
  const items: LegitimacyItem[] = [];
  for (const [key, { entry, cycleEntry }] of entryMap) {
    const position = positionMap.get(key);
    const { verdict, confidence, reasons } = scoreEntry(entry, position);

    const item: LegitimacyItem = {
      symbol: entry.symbol,
      contract: entry.contract,
      sourceRunFile: cycleEntry.newestRunFile || undefined,
      observedAt: cycleEntry.generatedAt,
      priceChangePct: entry.priceChangePct,
      liquidityChangePct: entry.liquidityChangePct,
      volumeLiquidityRatio: entry.volumeLiquidityRatio,
      ...(position != null && {
        paperPositionStatus: position.status,
        paperExitReason: position.exitReason,
        paperFakePnlDollars: position.fakePnlDollars,
        maxRunupPct: position.maxRunupPct,
        maxDrawdownPct: position.maxDrawdownPct,
      }),
      legitimacyVerdict: verdict,
      confidence,
      reasons,
      missingSignals: [...ALWAYS_MISSING_SIGNALS],
      holderConcentrationStatus: 'UNKNOWN',
      creatorWalletStatus: 'UNKNOWN',
      bubbleMapStatus: 'UNKNOWN',
      socialChatterStatus: 'UNKNOWN',
      mintAuthorityStatus: 'UNKNOWN',
      freezeAuthorityStatus: 'UNKNOWN',
      liquidityLockStatus: 'UNKNOWN',
    };
    items.push(item);
  }

  // Collect blocked movers across all cycles, deduplicated by contract (keep highest price).
  const blockedMap = new Map<
    string,
    { mover: TopBlockedMover; cycleEntry: DayWatchCycleEntry; cycle: number }
  >();
  let cycleIdx = 0;
  for (const cycleEntry of dayLogEntries) {
    cycleIdx++;
    for (const b of cycleEntry.topBlockedMovers) {
      const key = b.contract.toLowerCase();
      const existing = blockedMap.get(key);
      if (
        !existing ||
        (b.priceChangePct ?? -Infinity) > (existing.mover.priceChangePct ?? -Infinity)
      ) {
        blockedMap.set(key, { mover: b, cycleEntry, cycle: cycleIdx });
      }
    }
  }

  const blockedMovers: BlockedMoverItem[] = [...blockedMap.values()]
    .sort(
      (a, b) =>
        (b.mover.priceChangePct ?? -Infinity) - (a.mover.priceChangePct ?? -Infinity),
    )
    .slice(0, 10)
    .map(({ mover, cycleEntry, cycle }) => ({
      symbol: mover.symbol,
      contract: mover.contract,
      sourceRunFile: cycleEntry.newestRunFile || undefined,
      cycle,
      priceChangePct: mover.priceChangePct,
      liquidityChangePct: mover.liquidityChangePct,
      volumeLiquidityRatio: mover.volumeLiquidityRatio,
      blockedReasons: mover.blockReasons,
      verdict: scoreBlockedMover(mover),
    }));

  const passToHumanCount = items.filter(i => i.legitimacyVerdict === 'PASS_TO_HUMAN').length;
  const watchCount = items.filter(i => i.legitimacyVerdict === 'WATCH').length;
  const ignoreCount = items.filter(i => i.legitimacyVerdict === 'IGNORE').length;
  const dangerCount = items.filter(i => i.legitimacyVerdict === 'DANGER').length;

  const finalRecommendation = determineFinalRecommendation(
    passToHumanCount,
    watchCount,
    ignoreCount,
    dangerCount,
  );

  return {
    generatedAt,
    dayLogPath: opts.dayLogPath,
    runsDir: opts.runsDir,
    positionsPath: opts.positionsPath,
    totalCurrentCycleEntriesReviewed: items.length,
    passToHumanCount,
    watchCount,
    ignoreCount,
    dangerCount,
    items,
    blockedMovers,
    finalRecommendation,
    missingSignalSummary: [...ALWAYS_MISSING_SIGNALS],
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  };
}

// ── I/O helpers ───────────────────────────────────────────────────────────────────────────

export function loadDexPaperPositionsFile(positionsPath: string): DexPaperPositionReport | null {
  if (!fs.existsSync(positionsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(positionsPath, 'utf-8')) as DexPaperPositionReport;
  } catch {
    return null;
  }
}

export function writeDexLegitimacyReport(report: DexLegitimacyReport, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
}

// ── Orchestrator ──────────────────────────────────────────────────────────────────────────

export function runDexLegitimacyReport(options: DexLegitimacyReportOptions): DexLegitimacyReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const dayLogEntries = loadDayLog(options.dayLogPath);
  const positions = options.positionsPath
    ? loadDexPaperPositionsFile(options.positionsPath)
    : null;

  const report = buildDexLegitimacyReport(dayLogEntries, positions, {
    dayLogPath: options.dayLogPath,
    runsDir: options.runsDir,
    positionsPath: options.positionsPath,
    generatedAt,
  });

  writeDexLegitimacyReport(report, options.outPath);
  return report;
}

// ── Usage string — pure ───────────────────────────────────────────────────────────────────

export function renderDexLegitimacyReportUsage(): string {
  return [
    'Usage: npm run token:dex-legitimacy-report -- [options]',
    '',
    'Reads day-watch JSONL, runs-dir, and optional paper positions to score',
    'current-cycle token candidates for human review. Produces a ranked report.',
    'READ-ONLY. PAPER ONLY. No wallet. No signing. No swap. tradingExecuted: 0.',
    '',
    'Options:',
    '  --day-log <path>     Day watch JSONL log (default: data/token-grab/day-watch/dex-day-watch-today.jsonl)',
    '  --runs-dir <path>    Watch runs directory (default: data/token-grab/dex-watch-runs)',
    '  --positions <path>   Paper positions JSON (default: data/token-grab/paper-positions/dex-paper-positions-today.json)',
    '  --out <path>         Legitimacy report output (default: data/token-grab/legitimacy/dex-legitimacy-report.json)',
    '  --json               Output JSON instead of text',
    '  --help, -h           Show this help and exit',
    '',
    'Verdict values (per token):',
    '  PASS_TO_HUMAN  — passes all market thresholds, no safety exits — review this',
    '  WATCH          — partial data, inconclusive position, or weak signals',
    '  IGNORE         — weak movement or insufficient data',
    '  DANGER         — bad paper exit, VLR too high, or blocked history risk',
    '',
    'Final recommendation values:',
    '  MANUAL_REVIEW_READY  — at least one PASS_TO_HUMAN token found',
    '  COLLECT_MORE_DATA    — WATCH tokens present but nothing clean yet',
    '  TOO_MUCH_JUNK        — DANGER entries dominate, signals are noisy',
    '  NO_CLEAN_SIGNAL      — nothing moved above thresholds',
    '',
    'Placeholder signals (V1 — not yet connected):',
    '  HOLDER_MAP, CREATOR_WALLET, BUBBLE_MAP, SOCIAL_CHATTER, MINT_FREEZE, LP_LOCK',
    '',
    'Output written to data/token-grab/legitimacy/ (untracked).',
    'Do not run token:auto-paper. No real trade is sent.',
  ].join('\n');
}

// ── Renderer — pure ───────────────────────────────────────────────────────────────────────

function fmtPct(v?: number): string {
  if (v == null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

const FINAL_REC_DESC: Record<FinalRecommendation, string> = {
  MANUAL_REVIEW_READY: 'At least one token passed all market filters — review PASS_TO_HUMAN entries',
  COLLECT_MORE_DATA:   'WATCH tokens found — run more cycles to build confidence',
  TOO_MUCH_JUNK:       'DANGER entries dominate — signals are noisy, review blocked movers',
  NO_CLEAN_SIGNAL:     'No tokens cleared thresholds — need more cycles or wider signals',
};

export function renderDexLegitimacyReport(report: DexLegitimacyReport): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX LEGITIMACY REPORT V1');
  lines.push('  PAPER ONLY — READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  No wallet. No signing. No swap. No liveHarness changes.');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Generated at          : ${report.generatedAt}`);
  lines.push(`  Day log               : ${report.dayLogPath}`);
  lines.push(`  Runs dir              : ${report.runsDir}`);
  if (report.positionsPath) {
    lines.push(`  Positions file        : ${report.positionsPath}`);
  }

  lines.push('');
  lines.push(THIN);
  lines.push('  Summary');
  lines.push(THIN);
  lines.push(`  Current-cycle entries reviewed : ${report.totalCurrentCycleEntriesReviewed}`);
  lines.push(`  PASS_TO_HUMAN                  : ${report.passToHumanCount}`);
  lines.push(`  WATCH                          : ${report.watchCount}`);
  lines.push(`  IGNORE                         : ${report.ignoreCount}`);
  lines.push(`  DANGER                         : ${report.dangerCount}`);

  const passingItems = report.items.filter(
    i => i.legitimacyVerdict === 'PASS_TO_HUMAN' || i.legitimacyVerdict === 'WATCH',
  );
  if (passingItems.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  PASS_TO_HUMAN / WATCH tokens');
    lines.push(THIN);
    for (const item of passingItems) {
      const sym = (item.symbol ? `$${item.symbol}` : '(no sym)').padEnd(14);
      const verdict = item.legitimacyVerdict.padEnd(14);
      const conf = item.confidence.padEnd(6);
      const price = fmtPct(item.priceChangePct).padStart(8);
      const liq = fmtPct(item.liquidityChangePct).padStart(8);
      const vlr = item.volumeLiquidityRatio != null
        ? item.volumeLiquidityRatio.toFixed(2)
        : 'n/a';
      lines.push(`  ${sym} ${verdict} ${conf} price ${price}  liq ${liq}  v/l ${vlr}`);
      if (item.paperExitReason) {
        lines.push(`    paper exit: ${item.paperExitReason}  fake P/L: ${item.paperFakePnlDollars != null ? `$${item.paperFakePnlDollars.toFixed(2)}` : 'n/a'}`);
      }
      if (item.reasons.length > 0) {
        lines.push(`    ${item.reasons.slice(0, 2).join(' | ')}`);
      }
    }
  }

  const dangerItems = report.blockedMovers.filter(b => b.verdict === 'DANGER');
  if (dangerItems.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Top DANGER blocked movers');
    lines.push(THIN);
    for (const b of dangerItems.slice(0, 5)) {
      const sym = (b.symbol ? `$${b.symbol}` : '(no sym)').padEnd(14);
      const price = fmtPct(b.priceChangePct).padStart(8);
      const liq = fmtPct(b.liquidityChangePct).padStart(8);
      const vlr = b.volumeLiquidityRatio != null ? b.volumeLiquidityRatio.toFixed(2) : 'n/a';
      lines.push(`  ${sym} price ${price}  liq ${liq}  v/l ${vlr}`);
      if (b.blockedReasons.length > 0) {
        lines.push(`    blocked: ${b.blockedReasons.slice(0, 2).join('; ')}`);
      }
    }
  }

  lines.push('');
  lines.push(THIN);
  lines.push('  Missing signals (V1 — not yet connected)');
  lines.push(THIN);
  for (const sig of report.missingSignalSummary) {
    lines.push(`    ${sig}`);
  }

  lines.push('');
  lines.push(THIN);
  lines.push(`  Final recommendation : ${report.finalRecommendation}`);
  lines.push(`  ${FINAL_REC_DESC[report.finalRecommendation]}`);
  lines.push(THIN);

  lines.push('');
  lines.push(WIDE);
  lines.push('  LEGITIMACY REPORT — paper-only — no positions opened');
  lines.push('  All future signal fields (holder, bubble, social) are UNKNOWN in V1');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
