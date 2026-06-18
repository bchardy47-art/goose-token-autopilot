import * as fs from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_CYCLE_DIR = 'data/token-grab/ripper/cycles';

// ── Types ──────────────────────────────────────────────────────────────────────
export type PaperReviewLabel =
  | 'TARGET_PROFILE_EXACT_MATCH'
  | 'TARGET_PROFILE_NEAR_MISS_WAIT'
  | 'TARGET_PROFILE_REJECT_NOT_TARGET';

export type PaperReviewRecommendation =
  | 'TARGET_PROFILE_MANUAL_PAPER_REVIEW'
  | 'TARGET_PROFILE_KEEP_WATCHING'
  | 'TARGET_PROFILE_NO_MATCHES';

export interface ReviewCandidate {
  contract:         string;
  symbol:           string | null;
  ageMinutes:       number | null;
  liquidityUsd:     number | null;
  liquidityBucket:  string;
  vlrBucket:        string;
  clusterRisk:      string | null;
  bubbleMapsScore:  number | null;
  ripperScore:      number | null;
  timingPath:       string;
  gateDecision:     string | null;
  entryDecision:    string | null;
  reason:           string;
  paperReviewLabel: PaperReviewLabel;
}

export interface TargetProfilePaperReviewResult {
  cycleFile:         string;
  totalRowsScanned:  number;
  exactMatches:      number;
  nearMisses:        number;
  candidates:        ReviewCandidate[];
  recommendation:    PaperReviewRecommendation;
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface TargetProfilePaperReviewOptions {
  cycleFile?: string;
  cycleDir?:  string;
}

// ── Internal types ─────────────────────────────────────────────────────────────
interface CycleRow {
  ripperInput?:    Record<string, unknown>;
  normalizedSignal?: Record<string, unknown>;
  raw?:            Record<string, unknown>;
  ripperScore?:    number | null;
  ageMinutes?:     number | null;
  entryDecision?:  string | null;
  buyGateDecision?: string | null;
  blockers?:       string[];
  topReasons?:     string[];
  warnings?:       string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const SAFETY = {
  reportOnly:        true  as const,
  readOnly:          true  as const,
  paperOnly:         true  as const,
  realTradingLocked: true  as const,
  tradingExecuted:   0     as const,
};

const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const SEP2 = '────────────────────────────────────────────────────────────────';

function deriveLiqBucket(liqUsd: number | null): string {
  if (liqUsd == null || !Number.isFinite(liqUsd)) return 'LIQ_UNKNOWN';
  if (liqUsd < 10_000)  return 'LIQ_LT_10K';
  if (liqUsd < 30_000)  return 'LIQ_10K_30K';
  if (liqUsd < 100_000) return 'LIQ_30K_100K';
  return 'LIQ_GTE_100K';
}

function deriveVlrBucket(vlr: number | null): string {
  if (vlr == null || !Number.isFinite(vlr)) return 'VLR_UNKNOWN';
  if (vlr < 0.5) return 'VLR_LT_0_5';
  if (vlr < 2)   return 'VLR_0_5_TO_2';
  return 'VLR_GTE_2';
}

function parseBubbleMapsScore(clusterNotes: unknown): number | null {
  if (!Array.isArray(clusterNotes)) return null;
  for (const note of clusterNotes) {
    const m = String(note).match(/bubbleMapsScore\s+([\d.]+)/);
    if (m) return parseFloat(m[1]!);
  }
  return null;
}

function deriveTimingPath(ageMinutes: number | null): string {
  if (ageMinutes == null) return 'UNKNOWN';
  return ageMinutes < 10 ? 'ENTER_NOW' : 'WAIT_10M';
}

function findLatestCycleFile(cycleDir: string): string | null {
  if (!fs.existsSync(cycleDir)) return null;
  const files = fs.readdirSync(cycleDir)
    .filter(f => /^cycle-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(f))
    .sort();
  if (files.length === 0) return null;
  return path.join(cycleDir, files[files.length - 1]!);
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const rows: T[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as T); } catch { /* skip */ }
  }
  return rows;
}

function classifyRow(row: CycleRow): ReviewCandidate | null {
  const ri  = row.ripperInput  ?? {};
  const ns  = row.normalizedSignal ?? {};
  const raw = row.raw ?? {};

  const clusterRisk = (ri['clusterRisk'] as string | null) ?? null;
  if (clusterRisk !== 'WATCH') return null;  // exclude non-WATCH from candidates table

  const contract    = (ri['contract']  as string) || (ns['contract']  as string) || '';
  const symbol      = (ri['symbol']    as string | null) ?? (ns['symbol'] as string | null) ?? null;
  const ageMinutes  = (row.ageMinutes  as number | null) ?? null;
  const liqUsd      = (ns['liquidityUsd'] as number | null) ?? null;
  const vlr         = (ns['volumeLiquidityRatio'] as number | null) ?? null;

  const liquidityBucket = deriveLiqBucket(liqUsd);
  const vlrBucket       = deriveVlrBucket(vlr);
  const timingPath      = deriveTimingPath(ageMinutes);

  const bubbleMapsScore = parseBubbleMapsScore(raw['clusterNotes']);
  const ripperScore     = (row.ripperScore as number | null) ?? null;
  const gateDecision    = (row.buyGateDecision as string | null) ?? null;
  const entryDecision   = (row.entryDecision   as string | null) ?? null;

  const reasons = [
    ...(row.topReasons ?? []),
    ...(row.blockers   ?? []),
  ].slice(0, 4).join(' | ');

  let paperReviewLabel: PaperReviewLabel;
  if (liquidityBucket === 'LIQ_10K_30K' && timingPath === 'ENTER_NOW') {
    paperReviewLabel = 'TARGET_PROFILE_EXACT_MATCH';
  } else if (liquidityBucket === 'LIQ_10K_30K' || liquidityBucket === 'LIQ_UNKNOWN') {
    paperReviewLabel = 'TARGET_PROFILE_NEAR_MISS_WAIT';
  } else {
    paperReviewLabel = 'TARGET_PROFILE_REJECT_NOT_TARGET';
  }

  return {
    contract, symbol, ageMinutes, liquidityUsd: liqUsd, liquidityBucket, vlrBucket,
    clusterRisk, bubbleMapsScore, ripperScore, timingPath,
    gateDecision, entryDecision, reason: reasons, paperReviewLabel,
  };
}

const LABEL_ORDER: Record<PaperReviewLabel, number> = {
  TARGET_PROFILE_EXACT_MATCH:      0,
  TARGET_PROFILE_NEAR_MISS_WAIT:   1,
  TARGET_PROFILE_REJECT_NOT_TARGET: 2,
};

// ── Main function ──────────────────────────────────────────────────────────────
export function runTargetProfilePaperReview(
  options: TargetProfilePaperReviewOptions = {},
): TargetProfilePaperReviewResult {
  const cycleDir = options.cycleDir ?? DEFAULT_CYCLE_DIR;
  const cycleFilePath = options.cycleFile ?? findLatestCycleFile(cycleDir);
  if (!cycleFilePath) {
    return {
      cycleFile:        '(none found)',
      totalRowsScanned: 0,
      exactMatches:     0,
      nearMisses:       0,
      candidates:       [],
      recommendation:   'TARGET_PROFILE_NO_MATCHES',
      ...SAFETY,
    };
  }

  const rows        = readJsonl<CycleRow>(cycleFilePath);
  const candidates  = rows
    .map(r => classifyRow(r))
    .filter((c): c is ReviewCandidate => c != null)
    .sort((a, b) => LABEL_ORDER[a.paperReviewLabel] - LABEL_ORDER[b.paperReviewLabel]);

  const exactMatches = candidates.filter(c => c.paperReviewLabel === 'TARGET_PROFILE_EXACT_MATCH').length;
  const nearMisses   = candidates.filter(c => c.paperReviewLabel === 'TARGET_PROFILE_NEAR_MISS_WAIT').length;

  let recommendation: PaperReviewRecommendation;
  if (exactMatches > 0) {
    recommendation = 'TARGET_PROFILE_MANUAL_PAPER_REVIEW';
  } else if (nearMisses > 0) {
    recommendation = 'TARGET_PROFILE_KEEP_WATCHING';
  } else {
    recommendation = 'TARGET_PROFILE_NO_MATCHES';
  }

  return {
    cycleFile:        path.basename(cycleFilePath),
    totalRowsScanned: rows.length,
    exactMatches,
    nearMisses,
    candidates,
    recommendation,
    ...SAFETY,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────────
export function renderTargetProfilePaperReview(
  result: TargetProfilePaperReviewResult,
): string {
  const L: string[] = ['', SEP];
  L.push('  TOKEN GRAB — TARGET PROFILE PAPER REVIEW v1');
  L.push('  [REPORT ONLY — NO TRADES — NO WALLET — READ ONLY]');
  L.push(SEP, '');

  // Summary
  L.push(`  ${SEP2}`);
  L.push('  SUMMARY');
  L.push(`  ${SEP2}`, '');
  L.push(`  Cycle file          : ${result.cycleFile}`);
  L.push(`  Total rows scanned  : ${result.totalRowsScanned}`);
  L.push(`  WATCH rows shown    : ${result.candidates.length}`);
  L.push(`  Exact matches       : ${result.exactMatches}  (LIQ_10K_30K + WATCH + ENTER_NOW)`);
  L.push(`  Near misses         : ${result.nearMisses}  (WATCH + wrong liq or timing)`);
  L.push('');
  L.push('  Target profile:');
  L.push('    clusterRisk=WATCH  liquidityBucket=LIQ_10K_30K  timingPath=ENTER_NOW (ageMinutes<10)');
  L.push('    Historical: win5=61.8%  flatDump=38.2%  lift=3.27x  observed=76');
  L.push('');

  // Candidate table
  if (result.candidates.length === 0) {
    L.push(`  ${SEP2}`);
    L.push('  CANDIDATES');
    L.push(`  ${SEP2}`, '');
    L.push('  (no WATCH rows in this cycle file)');
    L.push('');
  } else {
    L.push(`  ${SEP2}`);
    L.push('  CANDIDATES (WATCH rows)');
    L.push(`  ${SEP2}`, '');
    for (const c of result.candidates) {
      const label = c.paperReviewLabel === 'TARGET_PROFILE_EXACT_MATCH'
        ? '[★ EXACT MATCH]'
        : c.paperReviewLabel === 'TARGET_PROFILE_NEAR_MISS_WAIT'
        ? '[~ NEAR MISS  ]'
        : '[✗ REJECT     ]';
      L.push(`  ${label}  ${c.symbol ?? c.contract.slice(0, 8)}`);
      L.push(`    contract       : ${c.contract}`);
      L.push(`    ageMinutes     : ${c.ageMinutes != null ? c.ageMinutes.toFixed(1) : 'n/a'}`);
      L.push(`    liquidityUsd   : ${c.liquidityUsd != null ? '$' + c.liquidityUsd.toFixed(0) : 'n/a'}`);
      L.push(`    liquidityBucket: ${c.liquidityBucket}`);
      L.push(`    vlrBucket      : ${c.vlrBucket}`);
      L.push(`    clusterRisk    : ${c.clusterRisk ?? 'n/a'}`);
      if (c.bubbleMapsScore != null) {
        L.push(`    bubbleMapsScore: ${c.bubbleMapsScore}`);
      }
      if (c.ripperScore != null) {
        L.push(`    ripperScore    : ${c.ripperScore.toFixed(3)}`);
      }
      L.push(`    timingPath     : ${c.timingPath}`);
      L.push(`    gateDecision   : ${c.gateDecision ?? 'n/a'}`);
      L.push(`    entryDecision  : ${c.entryDecision ?? 'n/a'}`);
      if (c.reason) {
        L.push(`    reason         : ${c.reason}`);
      }
      L.push('');
    }
  }

  // Recommendation
  L.push(`  ${SEP2}`);
  L.push('  RECOMMENDATION');
  L.push(`  ${SEP2}`, '');
  L.push(`  [${result.recommendation}]`);
  if (result.recommendation === 'TARGET_PROFILE_MANUAL_PAPER_REVIEW') {
    L.push(`  ${result.exactMatches} exact-profile match(es) found. Review manually for paper entry.`);
    L.push('  Check contract age, liquidity trend, and bubbleMapsScore before any paper entry.');
  } else if (result.recommendation === 'TARGET_PROFILE_KEEP_WATCHING') {
    L.push(`  No exact matches but ${result.nearMisses} WATCH row(s) worth monitoring.`);
    L.push('  Re-run at next cycle to see if near-misses resolve into target profile.');
  } else {
    L.push('  No WATCH rows in this cycle. No action needed.');
  }
  L.push('');

  // Safety footer
  L.push(`  ${SEP2}`);
  L.push('  SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true  READ_ONLY=true  NO_POLICY_CHANGE=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING  tradingExecuted=0  realTradingLocked=true');
  L.push('  paperOnly=true  reportOnly=true');
  L.push('  No gate, autopilot, policy, wallet, or trade logic modified.');
  L.push(SEP, '');

  return L.join('\n');
}
