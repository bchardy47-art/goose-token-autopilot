import fs from 'node:fs';
import path from 'node:path';
import {
  buildDexLegitimacyReport,
  loadDexPaperPositionsFile,
  type DexLegitimacyReport,
  type LegitimacyItem,
  type BlockedMoverItem,
} from './dexLegitimacyReport';
import { loadDayLog } from './dexDayWatch';

// ── Types ─────────────────────────────────────────────────────────────────────────────────

export type WinnerTier = 'PASS_TO_HUMAN' | 'HIGH_CONVICTION_WATCH' | 'WATCH';
export type WinnerFinalRecommendation = 'PASS_TO_HUMAN' | 'HIGH_CONVICTION_WATCH' | 'WATCH' | 'NO_CANDIDATES';

export interface WinnerCandidate {
  tier: WinnerTier;
  symbol?: string;
  contract: string;
  sourceRunFile?: string;
  observedAt?: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  volumeLiquidityRatio?: number;
  paperExitReason?: string;
  paperFakePnlDollars?: number;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  reasons: string[];
  missingSafetySignals: string[];
}

export interface RejectedCandidate {
  symbol?: string;
  contract: string;
  rejectCategory: string;
  rejectReasons: string[];
}

export interface DexWinnerCandidateReport {
  generatedAt: string;
  sourceFile: string;
  candidateCount: number;
  passToHumanCount: number;
  highConvictionWatchCount: number;
  watchCount: number;
  rejectedCount: number;
  rejectCategoryCounts: Record<string, number>;
  candidates: WinnerCandidate[];
  rejected?: RejectedCandidate[];
  finalRecommendation: WinnerFinalRecommendation;
  tradingExecuted: 0;
  noRealTradeSent: true;
  readOnly: true;
  paperOnly: true;
}

export interface DexWinnerCandidateReportOptions {
  legitimacyPath?: string;
  dayLogPath?: string;
  positionsPath?: string;
  runsDir?: string;
  outPath: string;
  debug?: boolean;
  generatedAt?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────────────────

const PASS_PRICE_PCT = 15;
const PASS_LIQ_PCT = 5;
const PASS_VLR_MAX = 1;
const TIER_ORDER: WinnerTier[] = ['PASS_TO_HUMAN', 'HIGH_CONVICTION_WATCH', 'WATCH'];

// ── Pure classification helper ────────────────────────────────────────────────────────────

export type ClassifyResult =
  | { type: 'candidate'; tier: WinnerTier; candidate: WinnerCandidate }
  | { type: 'rejected'; category: string; reasons: string[] };

export function tryClassifyItem(item: LegitimacyItem): ClassifyResult {
  // ── Hard kills — excluded from candidate list entirely ──

  if (item.freezeAuthorityStatus === 'ACTIVE') {
    return { type: 'rejected', category: 'FREEZE_AUTHORITY_ACTIVE', reasons: ['freeze authority is ACTIVE'] };
  }

  if (item.holderConcentrationStatus === 'DANGER') {
    return { type: 'rejected', category: 'HOLDER_DANGER', reasons: ['holder concentration DANGER'] };
  }

  if (item.paperExitReason === 'STOP_LOSS') {
    return { type: 'rejected', category: 'STOP_LOSS', reasons: ['paper position: STOP_LOSS'] };
  }

  if (item.paperExitReason === 'LIQUIDITY_DUMP') {
    return { type: 'rejected', category: 'LIQUIDITY_DUMP', reasons: ['paper position: LIQUIDITY_DUMP'] };
  }

  if (item.paperExitReason === 'VLR_SPIKE') {
    return { type: 'rejected', category: 'VLR_SPIKE', reasons: ['paper position: VLR_SPIKE'] };
  }

  if (item.paperExitReason === 'MISSING_OR_STALE') {
    return { type: 'rejected', category: 'MISSING_DATA', reasons: ['paper position data missing or stale'] };
  }

  // ── Market gate ──

  const priceOk = item.priceChangePct != null && item.priceChangePct >= PASS_PRICE_PCT;
  const liqOk = item.liquidityChangePct != null && item.liquidityChangePct >= PASS_LIQ_PCT;
  const vlrOk = item.volumeLiquidityRatio == null || item.volumeLiquidityRatio <= PASS_VLR_MAX;

  if (!priceOk || !liqOk || !vlrOk) {
    const failReasons: string[] = [];
    if (!priceOk) {
      failReasons.push(
        item.priceChangePct != null
          ? `price ${item.priceChangePct.toFixed(1)}% < ${PASS_PRICE_PCT}%`
          : 'price missing',
      );
    }
    if (!liqOk) {
      failReasons.push(
        item.liquidityChangePct != null
          ? `liquidity ${item.liquidityChangePct.toFixed(1)}% < ${PASS_LIQ_PCT}%`
          : 'liquidity missing',
      );
    }
    if (!vlrOk) {
      failReasons.push(`VLR ${item.volumeLiquidityRatio!.toFixed(2)} > ${PASS_VLR_MAX}`);
    }
    return { type: 'rejected', category: 'HARD_MARKET_FAIL', reasons: failReasons };
  }

  // ── Soft downgrades — reduce tier ceiling without killing ──

  let maxTierIdx = 0; // starts at PASS_TO_HUMAN (index 0 = best)
  const downgrades: string[] = [];

  if (item.mintAuthorityStatus === 'ACTIVE') {
    maxTierIdx = Math.max(maxTierIdx, 2); // cap at WATCH
    downgrades.push('mint authority ACTIVE');
  }

  if (item.holderConcentrationStatus === 'WARNING') {
    maxTierIdx = Math.max(maxTierIdx, 1); // cap at HIGH_CONVICTION_WATCH
    downgrades.push('holder concentration WARNING');
  }

  // ── Tier based on paper result ──

  let tierIdx: number;
  const isGoodExit =
    item.paperExitReason === 'TAKE_PROFIT' || item.paperExitReason === 'RUNNER_TARGET';
  const isMaxHoldPositive =
    item.paperExitReason === 'MAX_HOLD_TIMEOUT' && (item.paperFakePnlDollars ?? 0) > 0;
  const isStillOpen = item.paperExitReason === 'STILL_OPEN';

  if (isGoodExit) {
    tierIdx = 0; // PASS_TO_HUMAN
  } else if (isMaxHoldPositive || isStillOpen) {
    tierIdx = 1; // HIGH_CONVICTION_WATCH
  } else {
    tierIdx = 2; // WATCH — no position, max_hold with no gain, or other inconclusive
  }

  // Apply soft downgrade ceiling.
  const finalTierIdx = Math.max(tierIdx, maxTierIdx);
  const tier = TIER_ORDER[finalTierIdx];

  // ── Confidence — never HIGH if all safety data is UNKNOWN ──

  const anySafetyKnown =
    item.mintAuthorityStatus !== 'UNKNOWN' ||
    item.freezeAuthorityStatus !== 'UNKNOWN' ||
    item.holderConcentrationStatus !== 'UNKNOWN';

  let confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  if (tier === 'PASS_TO_HUMAN' && anySafetyKnown) {
    confidence = 'HIGH';
  } else if (tier === 'PASS_TO_HUMAN') {
    confidence = 'MEDIUM'; // safety fields not yet enriched
  } else if (tier === 'HIGH_CONVICTION_WATCH') {
    confidence = 'MEDIUM';
  } else {
    confidence = 'LOW';
  }

  // ── Reasons (positive, 1–3 lines) ──

  const reasons: string[] = [];
  if (item.priceChangePct != null) reasons.push(`price +${item.priceChangePct.toFixed(1)}%`);
  if (item.liquidityChangePct != null) reasons.push(`liquidity +${item.liquidityChangePct.toFixed(1)}%`);
  if (isGoodExit) {
    reasons.push(`paper: ${item.paperExitReason}`);
  } else if (isMaxHoldPositive) {
    reasons.push(`paper: MAX_HOLD_TIMEOUT +$${item.paperFakePnlDollars!.toFixed(2)}`);
  } else if (isStillOpen) {
    reasons.push('paper: STILL_OPEN (watching)');
  }
  for (const d of downgrades) reasons.push(`⚠ ${d}`); // ⚠

  // ── Missing safety signals (relevant ones only) ──

  const missingSafetySignals: string[] = [];
  if (item.mintAuthorityStatus === 'UNKNOWN' || item.freezeAuthorityStatus === 'UNKNOWN') {
    missingSafetySignals.push('MINT_FREEZE_NOT_CONNECTED');
  }
  if (item.holderConcentrationStatus === 'UNKNOWN') {
    missingSafetySignals.push('HOLDER_MAP_NOT_CONNECTED');
  }

  const candidate: WinnerCandidate = {
    tier,
    symbol: item.symbol,
    contract: item.contract,
    sourceRunFile: item.sourceRunFile,
    observedAt: item.observedAt,
    priceChangePct: item.priceChangePct,
    liquidityChangePct: item.liquidityChangePct,
    volumeLiquidityRatio: item.volumeLiquidityRatio,
    paperExitReason: item.paperExitReason,
    paperFakePnlDollars: item.paperFakePnlDollars,
    confidence,
    reasons: reasons.slice(0, 3),
    missingSafetySignals,
  };

  return { type: 'candidate', tier, candidate };
}

// ── Builder — pure ─────────────────────────────────────────────────────────────────────────

export function buildDexWinnerCandidateReport(
  legitimacyReport: DexLegitimacyReport,
  opts: { sourceFile: string; debug?: boolean; generatedAt?: string },
): DexWinnerCandidateReport {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  const candidates: WinnerCandidate[] = [];
  const itemRejected: RejectedCandidate[] = [];

  for (const item of legitimacyReport.items) {
    const result = tryClassifyItem(item);
    if (result.type === 'candidate') {
      candidates.push(result.candidate);
    } else {
      itemRejected.push({
        symbol: item.symbol,
        contract: item.contract,
        rejectCategory: result.category,
        rejectReasons: result.reasons,
      });
    }
  }

  // Blocked movers from the legitimacy report are always rejected (history risk).
  const blockedRejected: RejectedCandidate[] = legitimacyReport.blockedMovers.map(b => ({
    symbol: b.symbol,
    contract: b.contract,
    rejectCategory: 'BLOCKED_HISTORY',
    rejectReasons: b.blockedReasons,
  }));

  const allRejected = [...itemRejected, ...blockedRejected];

  // Count by category.
  const rejectCategoryCounts: Record<string, number> = {};
  for (const r of allRejected) {
    rejectCategoryCounts[r.rejectCategory] = (rejectCategoryCounts[r.rejectCategory] ?? 0) + 1;
  }

  // Sort candidates: best tier first, then by priceChangePct descending within tier.
  candidates.sort((a, b) => {
    const tierDiff = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
    if (tierDiff !== 0) return tierDiff;
    return (b.priceChangePct ?? -Infinity) - (a.priceChangePct ?? -Infinity);
  });

  const passToHumanCount = candidates.filter(c => c.tier === 'PASS_TO_HUMAN').length;
  const highConvictionWatchCount = candidates.filter(c => c.tier === 'HIGH_CONVICTION_WATCH').length;
  const watchCount = candidates.filter(c => c.tier === 'WATCH').length;

  let finalRecommendation: WinnerFinalRecommendation;
  if (passToHumanCount > 0) finalRecommendation = 'PASS_TO_HUMAN';
  else if (highConvictionWatchCount > 0) finalRecommendation = 'HIGH_CONVICTION_WATCH';
  else if (watchCount > 0) finalRecommendation = 'WATCH';
  else finalRecommendation = 'NO_CANDIDATES';

  return {
    generatedAt,
    sourceFile: opts.sourceFile,
    candidateCount: candidates.length,
    passToHumanCount,
    highConvictionWatchCount,
    watchCount,
    rejectedCount: allRejected.length,
    rejectCategoryCounts,
    candidates,
    ...(opts.debug ? { rejected: allRejected } : {}),
    finalRecommendation,
    tradingExecuted: 0,
    noRealTradeSent: true,
    readOnly: true,
    paperOnly: true,
  };
}

// ── I/O helpers ───────────────────────────────────────────────────────────────────────────

export function loadLegitimacyReportFile(filePath: string): DexLegitimacyReport | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DexLegitimacyReport;
  } catch {
    return null;
  }
}

export function writeDexWinnerCandidateReport(
  report: DexWinnerCandidateReport,
  outPath: string,
): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
}

// ── Orchestrator ──────────────────────────────────────────────────────────────────────────

export function runDexWinnerCandidateReport(
  options: DexWinnerCandidateReportOptions,
): DexWinnerCandidateReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  let legitimacyReport: DexLegitimacyReport | null = null;
  let sourceFile = options.legitimacyPath ?? options.dayLogPath ?? '';

  // Primary: load existing legitimacy report JSON.
  if (options.legitimacyPath) {
    legitimacyReport = loadLegitimacyReportFile(options.legitimacyPath);
  }

  // Fallback: build from day-log + positions in-memory (no file write).
  if (!legitimacyReport && options.dayLogPath) {
    const entries = loadDayLog(options.dayLogPath);
    const positions = options.positionsPath
      ? loadDexPaperPositionsFile(options.positionsPath)
      : null;
    legitimacyReport = buildDexLegitimacyReport(entries, positions, {
      dayLogPath: options.dayLogPath,
      runsDir: options.runsDir ?? 'data/token-grab/dex-watch-runs',
      positionsPath: options.positionsPath,
      generatedAt,
    });
    sourceFile = options.dayLogPath;
  }

  // Empty fallback: nothing to read.
  if (!legitimacyReport) {
    legitimacyReport = buildDexLegitimacyReport([], null, {
      dayLogPath: '',
      runsDir: options.runsDir ?? '',
      generatedAt,
    });
  }

  const report = buildDexWinnerCandidateReport(legitimacyReport, {
    sourceFile,
    debug: options.debug,
    generatedAt,
  });

  writeDexWinnerCandidateReport(report, options.outPath);
  return report;
}

// ── Usage string — pure ───────────────────────────────────────────────────────────────────

export function renderDexWinnerCandidateReportUsage(): string {
  return [
    'Usage: npm run token:dex-winner-candidates -- [options]',
    '',
    'Reads the legitimacy report (or builds from day-log) and surfaces only tokens',
    'worth human review: PASS_TO_HUMAN, HIGH_CONVICTION_WATCH, WATCH.',
    'Junk is silently rejected — not listed unless --debug is passed.',
    'READ-ONLY. PAPER ONLY. No wallet. No signing. No swap. tradingExecuted: 0.',
    '',
    'Options:',
    '  --legitimacy <path>   Legitimacy report JSON (default: data/token-grab/legitimacy/dex-legitimacy-report-today.json)',
    '  --day-log <path>      Day watch JSONL (fallback if --legitimacy file missing)',
    '  --positions <path>    Paper positions JSON (used with --day-log fallback)',
    '  --out <path>          Output JSON (default: data/token-grab/legitimacy/dex-winner-candidates-today.json)',
    '  --debug               Show rejected tokens and reject reasons',
    '  --json                Output JSON instead of text',
    '  --help, -h            Show this help and exit',
    '',
    'Candidate tiers:',
    '  PASS_TO_HUMAN         — clean paper exit (TAKE_PROFIT / RUNNER_TARGET), all market criteria pass',
    '  HIGH_CONVICTION_WATCH — MAX_HOLD_TIMEOUT with positive P/L, or STILL_OPEN with strong signals',
    '  WATCH                 — market criteria pass, paper result inconclusive or not yet available',
    '',
    'Hard kill rules (always excluded):',
    '  STOP_LOSS, LIQUIDITY_DUMP, VLR_SPIKE paper exits',
    '  Freeze authority ACTIVE',
    '  Holder concentration DANGER',
    '  Price < 15%, liquidity < 5%, VLR > 1',
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

const TIER_LABEL: Record<WinnerTier, string> = {
  PASS_TO_HUMAN: 'PASS_TO_HUMAN       ',
  HIGH_CONVICTION_WATCH: 'HIGH_CONVICTION_WATCH',
  WATCH: 'WATCH               ',
};

const FINAL_REC_DESC: Record<WinnerFinalRecommendation, string> = {
  PASS_TO_HUMAN:
    'Clean candidate found — review PASS_TO_HUMAN entries before acting',
  HIGH_CONVICTION_WATCH:
    'Strong watch candidate — good signals but paper result inconclusive',
  WATCH:
    'Weak watch — market data passes but needs more cycles to confirm',
  NO_CANDIDATES:
    'Nothing worth reviewing — run more cycles or check day-watch data',
};

export function renderDexWinnerCandidateReport(
  report: DexWinnerCandidateReport,
  debug?: boolean,
): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB DEX WINNER CANDIDATES V1');
  lines.push('  PAPER ONLY — READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  No wallet. No signing. No swap. No liveHarness changes.');
  lines.push(WIDE);
  lines.push('');
  lines.push(`  Generated at         : ${report.generatedAt}`);
  lines.push(`  Source               : ${report.sourceFile}`);
  lines.push('');
  lines.push(`  Final recommendation : ${report.finalRecommendation}`);
  lines.push(`  ${FINAL_REC_DESC[report.finalRecommendation]}`);
  lines.push('');
  lines.push(`  Candidates           : ${report.candidateCount}`);
  if (report.passToHumanCount > 0)
    lines.push(`    PASS_TO_HUMAN      : ${report.passToHumanCount}`);
  if (report.highConvictionWatchCount > 0)
    lines.push(`    HIGH_CONVICTION_WATCH : ${report.highConvictionWatchCount}`);
  if (report.watchCount > 0)
    lines.push(`    WATCH              : ${report.watchCount}`);

  if (report.candidates.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Candidates');
    lines.push(THIN);

    for (const c of report.candidates) {
      const sym = (c.symbol ? `$${c.symbol}` : '(no sym)').padEnd(14);
      const tier = TIER_LABEL[c.tier];
      const conf = c.confidence.padEnd(6);
      lines.push(`  ${sym} ${tier} ${conf}`);
      lines.push(`  ${c.contract}`);

      const price = fmtPct(c.priceChangePct).padStart(8);
      const liq = fmtPct(c.liquidityChangePct).padStart(8);
      const vlr = c.volumeLiquidityRatio != null
        ? c.volumeLiquidityRatio.toFixed(2)
        : 'n/a';
      lines.push(`  price ${price}  liq ${liq}  v/l ${vlr}`);

      if (c.paperExitReason) {
        const pnl = c.paperFakePnlDollars != null
          ? `  fake P/L: ${c.paperFakePnlDollars >= 0 ? '+' : ''}$${c.paperFakePnlDollars.toFixed(2)}`
          : '';
        lines.push(`  paper: ${c.paperExitReason}${pnl}`);
      }

      if (c.reasons.length > 0) {
        lines.push(`  ${c.reasons.join(' | ')}`);
      }

      if (c.missingSafetySignals.length > 0) {
        lines.push(`  missing: ${c.missingSafetySignals.join(', ')}`);
      }

      lines.push('');
    }
  } else {
    lines.push('');
    lines.push('  No candidates this cycle.');
    lines.push('');
  }

  lines.push(`  Rejected silently: ${report.rejectedCount}`);

  if (debug && report.rejected && report.rejected.length > 0) {
    lines.push('');
    lines.push(THIN);
    lines.push('  Rejected (debug)');
    lines.push(THIN);
    for (const r of report.rejected) {
      const sym = (r.symbol ? `$${r.symbol}` : '(no sym)').padEnd(14);
      lines.push(`  ${sym} [${r.rejectCategory}] ${r.rejectReasons.slice(0, 2).join('; ')}`);
    }
  }

  lines.push('');
  lines.push(WIDE);
  lines.push('  WINNER CANDIDATES — paper-only — no positions opened');
  lines.push('  tradingExecuted: 0 — token:auto-paper was NOT run — NO REAL TRADE SENT');
  lines.push(WIDE);

  return lines.join('\n');
}
