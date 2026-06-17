// Ripper Learning Summary Report v1 — paper/shadow-only dashboard.
//
// SAFETY GUARANTEES (do not weaken):
//   * This module is REPORT-ONLY / READ-ONLY.
//   * It reads learning-memory.jsonl and prints a dashboard.
//   * It does NOT change gates, paper policy, autopilot, or wallet code.
//   * Its recommendation output is advisory text only — nothing acts on it.

import * as fs from 'fs';
import {
  inferMemoryUniverse,
  type LearningMemoryRow,
  type OutcomeLabel,
  type TimingPath,
} from './ripperLearningMemory';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Recommendation =
  | 'KEEP_COLLECTING'
  | 'PROMOTE_TO_PAPER_ONLY_TEST_REVIEW'
  | 'DO_NOT_PROMOTE';

export interface OutcomeCounts {
  big_winner:   number;
  winner:       number;
  small_winner: number;
  flat_junk:    number;
  dump:         number;
  unknown:      number;
  total:        number;
}

export interface BucketStats {
  observedRows:           number;
  unknownRows:            number;
  outcomes:               OutcomeCounts;
  winnerRatePct:          number | null; // winners (>= +1%) / observed
  smallWinnerRatePct:     number | null; // small winners only / observed
  flatJunkDumpPct:        number | null; // flat + junk + dump / observed
  winnerOnePctToFivePct:  number | null; // winners >= +1% AND <= +5% rate / observed
}

export interface PatternRow {
  pattern: string;
  count:   number;
  share:   number;
}

export interface LearningSummary {
  totalRows:            number;
  observedRows:         number;
  unknownRows:          number;
  // ── All-rows buckets (broad reference — includes all universes) ──────────────
  overall:              BucketStats;
  liqOrAgeBlocked:      BucketStats;  // ALL rows, wouldRejectByLiqOrAge=true
  control:              BucketStats;  // ALL rows, wouldRejectByLiqOrAge=false
  waitTenMinutes:       BucketStats;
  enterNow:             BucketStats;
  cleanScore100Prime:   BucketStats;
  // ── Policy evidence universe (SHADOW_ENROLLED_APPROVED only) ─────────────────
  policyEvidenceRows:       number;
  generalMarketRows:        number;
  policyLiqOrAgeBlocked:    BucketStats;  // policy rows, blocked=true (drives promotion)
  policyControl:            BucketStats;  // policy rows, blocked=false
  // ── Patterns / recommendation ─────────────────────────────────────────────────
  topJunkPatterns:      PatternRow[];
  topWinnerPatterns:    PatternRow[];
  recommendation:       Recommendation;
  recommendationReason: string;
  reportOnly:           true;
  readOnly:             true;
  paperOnly:            true;
  realTradingLocked:    true;
  tradingExecuted:      0;
}

export interface LearningSummaryOptions {
  memoryPath: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readMemoryRows(memoryPath: string): LearningMemoryRow[] {
  if (!fs.existsSync(memoryPath)) return [];
  const rows: LearningMemoryRow[] = [];
  const text = fs.readFileSync(memoryPath, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const r = JSON.parse(trimmed) as LearningMemoryRow;
      // Backward-compat: resolve memoryUniverse for rows written before this field existed.
      if (!r.memoryUniverse) {
        r.memoryUniverse = inferMemoryUniverse({
          gateDecision:  r.gateDecision,
          sourceFiles:   r.sourceFiles,
          outcomeSource: r.outcomeSource,
        });
      }
      rows.push(r);
    }
    catch { /* skip malformed */ }
  }
  return rows;
}

function emptyOutcomeCounts(): OutcomeCounts {
  return {
    big_winner: 0, winner: 0, small_winner: 0,
    flat_junk: 0, dump: 0, unknown: 0, total: 0,
  };
}

function tallyOutcome(counts: OutcomeCounts, label: OutcomeLabel): void {
  counts.total++;
  switch (label) {
    case 'BIG_WINNER':   counts.big_winner++;   break;
    case 'WINNER':       counts.winner++;       break;
    case 'SMALL_WINNER': counts.small_winner++; break;
    case 'FLAT_JUNK':    counts.flat_junk++;    break;
    case 'DUMP':         counts.dump++;         break;
    case 'UNKNOWN':      counts.unknown++;      break;
  }
}

function safeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function buildBucketStats(rows: LearningMemoryRow[]): BucketStats {
  const counts = emptyOutcomeCounts();
  let observed = 0;
  let unknown  = 0;
  let winnerOneToFive = 0;
  for (const r of rows) {
    tallyOutcome(counts, r.outcomeLabel);
    if (r.outcomeLabel === 'UNKNOWN') unknown++;
    else observed++;
    const pct = r.priceChangePct;
    if (pct != null && Number.isFinite(pct) && pct >= 1 && pct <= 5) {
      winnerOneToFive++;
    }
  }
  const winners       = counts.big_winner + counts.winner + counts.small_winner;
  const flatJunkDumps = counts.flat_junk + counts.dump;
  return {
    observedRows:          observed,
    unknownRows:           unknown,
    outcomes:              counts,
    winnerRatePct:         safeRate(winners, observed),
    smallWinnerRatePct:    safeRate(counts.small_winner, observed),
    flatJunkDumpPct:       safeRate(flatJunkDumps, observed),
    winnerOnePctToFivePct: safeRate(winnerOneToFive, observed),
  };
}

function summarizePatterns(
  rows: LearningMemoryRow[],
  predicate: (r: LearningMemoryRow) => boolean,
  limit: number,
): PatternRow[] {
  const matching = rows.filter(predicate);
  if (matching.length === 0) return [];
  const counts = new Map<string, number>();
  for (const r of matching) {
    const pattern = [
      `liqBucket=${r.liquidityBucket}`,
      `cluster=${r.clusterRisk ?? 'NA'}`,
      `bucket=${r.launchAgeBucket ?? 'NA'}`,
      `score=${r.ripperScore ?? 'NA'}`,
      `vlr=${r.vlrBucket}`,
    ].join(' | ');
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([pattern, count]) => ({
      pattern,
      count,
      share: count / matching.length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function isCleanScore100PrimeWindow(r: LearningMemoryRow): boolean {
  return r.clusterRisk === 'CLEAN'
    && r.ripperScore === 100
    && r.launchAgeBucket === 'PRIME_WINDOW';
}

function isWaitTenMinutes(r: LearningMemoryRow): boolean {
  return r.timingPath === 'WAIT_10M';
}

function isEnterNow(r: LearningMemoryRow): boolean {
  return r.timingPath === 'ENTER_NOW';
}

function isJunky(label: OutcomeLabel): boolean {
  return label === 'FLAT_JUNK' || label === 'DUMP';
}

function isWinner(label: OutcomeLabel): boolean {
  return label === 'BIG_WINNER' || label === 'WINNER' || label === 'SMALL_WINNER';
}

// ── Recommendation Logic ──────────────────────────────────────────────────────
//
// KEEP_COLLECTING        : blocked observed < 150 (not enough evidence)
// PROMOTE_TO_PAPER_ONLY_TEST_REVIEW : only if ALL of:
//     - blocked observed >= 150
//     - blocked flat+junk+dumps >= 90% of blocked observed
//     - blocked winners (>= +1%) rate is between 1% and 5%
//     - control winner rate >= 3x blocked winner rate
// DO_NOT_PROMOTE         : otherwise

export interface RecommendationDecision {
  recommendation: Recommendation;
  reason:         string;
}

export function decideRecommendation(blocked: BucketStats, control: BucketStats): RecommendationDecision {
  if (blocked.observedRows < 150) {
    return {
      recommendation: 'KEEP_COLLECTING',
      reason:         `liq_OR_age observed (${blocked.observedRows}) < 150 — keep collecting evidence.`,
    };
  }
  const reasons: string[] = [];

  const blockedJunkPct = blocked.flatJunkDumpPct ?? -1;
  if (!(blockedJunkPct >= 90)) {
    reasons.push(`blocked flat+junk+dumps ${(blockedJunkPct).toFixed(1)}% < 90%`);
  }

  const blockedWinPct = blocked.winnerRatePct ?? -1;
  const blockedWinnersInBand = blockedWinPct >= 1 && blockedWinPct <= 5;
  if (!blockedWinnersInBand) {
    reasons.push(`blocked winner rate ${(blockedWinPct).toFixed(1)}% outside [1%, 5%]`);
  }

  const controlWinPct = control.winnerRatePct ?? -1;
  const meetsControlRatio = controlWinPct >= 0 && blockedWinPct > 0
    && controlWinPct >= blockedWinPct * 3;
  if (!meetsControlRatio) {
    reasons.push(
      `control winner rate ${(controlWinPct).toFixed(1)}% not >= 3x blocked ${(blockedWinPct).toFixed(1)}%`,
    );
  }

  if (reasons.length === 0) {
    return {
      recommendation: 'PROMOTE_TO_PAPER_ONLY_TEST_REVIEW',
      reason:         'All strict thresholds met. Promote to paper-only test review (manual review required, no auto-policy change).',
    };
  }
  return {
    recommendation: 'DO_NOT_PROMOTE',
    reason:         `Thresholds not met: ${reasons.join('; ')}.`,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runRipperLearningSummary(options: LearningSummaryOptions): LearningSummary {
  const rows = readMemoryRows(options.memoryPath);

  // ── All-rows buckets ─────────────────────────────────────────────────────────
  const overall  = buildBucketStats(rows);
  const blocked  = buildBucketStats(rows.filter(r => r.wouldRejectByLiqOrAge));
  const control  = buildBucketStats(rows.filter(r => !r.wouldRejectByLiqOrAge));
  const waitTen  = buildBucketStats(rows.filter(isWaitTenMinutes));
  const enterNow = buildBucketStats(rows.filter(isEnterNow));
  const cleanPW  = buildBucketStats(rows.filter(isCleanScore100PrimeWindow));

  // ── Policy evidence universe: SHADOW_ENROLLED_APPROVED only ─────────────────
  // Promotion recommendation is computed from this universe, NOT from all rows,
  // so it stays apples-to-apples with the shadow enrolled outcome report.
  const policyRows  = rows.filter(r => r.memoryUniverse === 'SHADOW_ENROLLED_APPROVED');
  const generalRows = rows.filter(r => r.memoryUniverse !== 'SHADOW_ENROLLED_APPROVED');
  const policyBlocked = buildBucketStats(policyRows.filter(r => r.wouldRejectByLiqOrAge));
  const policyCtrl    = buildBucketStats(policyRows.filter(r => !r.wouldRejectByLiqOrAge));

  const topJunk = summarizePatterns(rows, r => isJunky(r.outcomeLabel), 5);
  const topWin  = summarizePatterns(rows, r => isWinner(r.outcomeLabel), 5);

  // Recommendation driven by policy evidence only.
  const decision = decideRecommendation(policyBlocked, policyCtrl);

  return {
    totalRows:            rows.length,
    observedRows:         overall.observedRows,
    unknownRows:          overall.unknownRows,
    overall,
    liqOrAgeBlocked:      blocked,
    control,
    waitTenMinutes:       waitTen,
    enterNow,
    cleanScore100Prime:   cleanPW,
    policyEvidenceRows:       policyRows.length,
    generalMarketRows:        generalRows.length,
    policyLiqOrAgeBlocked:    policyBlocked,
    policyControl:            policyCtrl,
    topJunkPatterns:      topJunk,
    topWinnerPatterns:    topWin,
    recommendation:       decision.recommendation,
    recommendationReason: decision.reason,
    reportOnly:           true,
    readOnly:             true,
    paperOnly:            true,
    realTradingLocked:    true,
    tradingExecuted:      0,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  if (v == null) return 'n/a';
  return `${v.toFixed(1)}%`;
}

function renderBucketBlock(label: string, stats: BucketStats, lines: string[], SEP2: string): void {
  lines.push(`  ${SEP2}`);
  lines.push(`  ${label}`);
  lines.push(`  ${SEP2}`, '');
  lines.push(`  observed rows                : ${stats.observedRows}`);
  lines.push(`  unknown rows                 : ${stats.unknownRows}`);
  lines.push(`  BIG_WINNER (>=+5%)           : ${stats.outcomes.big_winner}`);
  lines.push(`  WINNER (>=+3%)               : ${stats.outcomes.winner}`);
  lines.push(`  SMALL_WINNER (>=+1%)         : ${stats.outcomes.small_winner}`);
  lines.push(`  FLAT_JUNK (>-1% & <+1%)      : ${stats.outcomes.flat_junk}`);
  lines.push(`  DUMP (<=-1%)                 : ${stats.outcomes.dump}`);
  lines.push(`  winner rate                  : ${fmtPct(stats.winnerRatePct)}`);
  lines.push(`  flat+junk+dump rate          : ${fmtPct(stats.flatJunkDumpPct)}`);
  lines.push(`  winners in [+1%,+5%] band    : ${fmtPct(stats.winnerOnePctToFivePct)}`);
  lines.push('');
}

export function renderRipperLearningSummary(summary: LearningSummary): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — RIPPER LEARNING SUMMARY v1');
  lines.push('  [REPORT ONLY — NO POLICY CHANGE — PAPER/SHADOW ONLY]');
  lines.push('  HOLD_CURRENT_GATES');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push('  REPORT_ONLY');
  lines.push('  NO_POLICY_CHANGE');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  TOTAL MEMORY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  total memory rows            : ${summary.totalRows}`);
  lines.push(`  observed rows                : ${summary.observedRows}`);
  lines.push(`  unknown rows                 : ${summary.unknownRows}`);
  lines.push('');

  renderBucketBlock('OVERALL OUTCOMES (all universes)',     summary.overall,              lines, SEP2);

  // ── Policy evidence universe ─────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  POLICY EVIDENCE UNIVERSE (SHADOW_ENROLLED_APPROVED rows only)');
  lines.push('  [Used for promotion recommendation — apples-to-apples with shadow enrolled report]');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Policy evidence rows         : ${summary.policyEvidenceRows}`);
  lines.push(`  General market rows          : ${summary.generalMarketRows}`);
  lines.push('');
  renderBucketBlock('liq_OR_age BLOCKED (POLICY EVIDENCE)',  summary.policyLiqOrAgeBlocked, lines, SEP2);
  renderBucketBlock('CONTROL (POLICY EVIDENCE, not blocked)', summary.policyControl,         lines, SEP2);

  // ── General market memory ─────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  GENERAL MARKET MEMORY (DEX_WATCH_GENERAL + non-enrolled rows)');
  lines.push('  [Broad context — NOT used for promotion math]');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Rows in general market       : ${summary.generalMarketRows}`);
  lines.push(`  liq_OR_age blocked (broad)   : ${summary.liqOrAgeBlocked.observedRows + summary.liqOrAgeBlocked.unknownRows}`);
  lines.push(`  control (broad)              : ${summary.control.observedRows + summary.control.unknownRows}`);
  lines.push('');

  // ── Reference buckets (all rows) ─────────────────────────────────────────────
  renderBucketBlock('liq_OR_age BLOCKED (ALL ROWS — reference)',  summary.liqOrAgeBlocked, lines, SEP2);
  renderBucketBlock('CONTROL (ALL ROWS — reference, not blocked)', summary.control,        lines, SEP2);
  renderBucketBlock('TIMING: WAIT_10M',                    summary.waitTenMinutes,       lines, SEP2);
  renderBucketBlock('TIMING: ENTER_NOW',                   summary.enterNow,             lines, SEP2);
  renderBucketBlock('CLEAN + score100 + PRIME_WINDOW',     summary.cleanScore100Prime,   lines, SEP2);

  lines.push(`  ${SEP2}`);
  lines.push('  TOP JUNK PATTERNS  (flat+dump rows)');
  lines.push(`  ${SEP2}`, '');
  if (summary.topJunkPatterns.length === 0) {
    lines.push('  (none observed)');
  } else {
    for (const p of summary.topJunkPatterns) {
      lines.push(`  [${p.count}] ${(p.share * 100).toFixed(1)}%  ${p.pattern}`);
    }
  }
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  TOP WINNER PATTERNS  (small_winner+winner+big_winner)');
  lines.push(`  ${SEP2}`, '');
  if (summary.topWinnerPatterns.length === 0) {
    lines.push('  (none observed)');
  } else {
    for (const p of summary.topWinnerPatterns) {
      lines.push(`  [${p.count}] ${(p.share * 100).toFixed(1)}%  ${p.pattern}`);
    }
  }
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  CURRENT RECOMMENDATION (based on POLICY EVIDENCE UNIVERSE only)');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  RECOMMENDATION : ${summary.recommendation}`);
  lines.push(`  REASON         : ${summary.recommendationReason}`);
  lines.push('');
  lines.push('  This recommendation is ADVISORY ONLY.');
  lines.push('  It is based solely on SHADOW_ENROLLED_APPROVED rows, not broad dex-watch data.');
  lines.push('  PROMOTE_TO_PAPER_ONLY_TEST_REVIEW does NOT change gates or paper policy.');
  lines.push('  It only flags that the evidence may merit a manual, paper-only review.');
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  HOLD_CURRENT_GATES');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push('  REPORT_ONLY');
  lines.push('  NO_POLICY_CHANGE');
  lines.push('  reportOnly=true  readOnly=true  paperOnly=true  realTradingLocked=true  tradingExecuted=0');
  lines.push(SEP, '');
  return lines.join('\n');
}
