// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE
//
// BubbleMaps value report — reads existing memory data only.
// Does NOT call the BubbleMaps API. Does NOT change gates or scoring.

import * as fs from 'fs';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BubbleMapsValueConclusion =
  | 'KEEP_BUBBLEMAPS'          // Score tiers show ≥5% win rate differential
  | 'CACHE_ONLY'               // Score tiers show <5% delta; non-BM predictors show more signal
  | 'REMOVE_LIVE_BUBBLEMAPS'   // Essentially 0% delta AND all enrolled are CLEAN → minimal value
  | 'NEEDS_MORE_DATA';         // fewer than 50 observed rows

export interface TierStats {
  tier:          string;
  enrolledCount: number;
  observedCount: number;
  winCount:      number;
  winRate:       number | null;
}

export interface BucketStats {
  bucket:        string;
  observedCount: number;
  winCount:      number;
  winRate:       number | null;
}

export interface BubbleMapsValueResult {
  generatedAt:         string;
  totalEnrolledRows:   number;
  totalObservedRows:   number;
  // ── BubbleMaps-based groupings ────────────────────────────────────────────
  scoreTiers:          TierStats[];
  clusterRiskGroups:   TierStats[];
  bubbleMapsWinDelta:  number | null;   // max − min win rate across tiers with obs ≥ 10
  pctWithScore:        number | null;   // % enrolled rows that have a bubbleMapsScore
  pctRisky:            number | null;   // % enrolled rows with clusterRisk RISKY (expect ~0 — gate blocks)
  // ── Non-BubbleMaps groupings ──────────────────────────────────────────────
  liquidityBuckets:    BucketStats[];
  vlrBuckets:          BucketStats[];
  liquidityWinDelta:   number | null;
  vlrWinDelta:         number | null;
  // ── Conclusion ────────────────────────────────────────────────────────────
  conclusion:          BubbleMapsValueConclusion;
  conclusionNote:      string;
  callSites:           string[];        // BubbleMaps live-call sites from code survey
  // ── Safety ───────────────────────────────────────────────────────────────
  reportOnly:          true;
  readOnly:            true;
  tradingExecuted:     0;
  realTradingLocked:   true;
  paperOnly:           true;
}

export interface BubbleMapsValueOptions {
  learningMemoryPath?: string;
  nowMs?:              number;
}

// ── Call site registry (from code survey — no live calls made here) ───────────

const BUBBLEMAPS_CALL_SITES: string[] = [
  'src/token-grab/clusterRiskProvider.ts — createBubbleMapsClusterProvider() → fetchClusterRisk()',
  'src/token-grab/liveFixtureCapture.ts — runLiveFixtureCapture() (calls via ClusterRiskProvider)',
  'src/token-grab/bubbleMapsCache.ts    — BubbleMapsCache.fetchClusterRisk() (wraps provider, adds cache+cap)',
  'src/cli.ts                           — token:ripper-paper-cycle, token:ripper-paper-loop, token:live-fixture-capture',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

type OutcomeLabel = string | null;

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

function isWin(label: OutcomeLabel): boolean {
  return label === 'SMALL_WINNER' || label === 'WINNER' || label === 'BIG_WINNER';
}

function isObserved(label: OutcomeLabel): boolean {
  return label != null && label !== 'UNKNOWN';
}

function pct(n: number, d: number): number | null {
  if (d === 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

function winDelta(tiers: TierStats[], minObs = 10): number | null {
  const qualified = tiers.filter(t => t.observedCount >= minObs && t.winRate != null);
  if (qualified.length < 2) return null;
  const rates = qualified.map(t => t.winRate as number);
  return Math.round((Math.max(...rates) - Math.min(...rates)) * 10) / 10;
}

function bucketDelta(buckets: BucketStats[], minObs = 10): number | null {
  const qualified = buckets.filter(b => b.observedCount >= minObs && b.winRate != null);
  if (qualified.length < 2) return null;
  const rates = qualified.map(b => b.winRate as number);
  return Math.round((Math.max(...rates) - Math.min(...rates)) * 10) / 10;
}

// ── Score tier logic ──────────────────────────────────────────────────────────

function scoreTier(score: number | null | undefined): string {
  if (score == null) return 'SCORE_NONE';
  if (score >= 80)   return 'SCORE_GTE_80';
  if (score >= 60)   return 'SCORE_60_TO_79';
  return 'SCORE_LT_60';
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runBubbleMapsValueReport(
  options: BubbleMapsValueOptions = {},
): BubbleMapsValueResult {
  const nowMs      = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const memoryPath  = options.learningMemoryPath
    ?? 'data/token-grab/ripper/learning-memory.jsonl';

  // ── Read enrolled rows ────────────────────────────────────────────────────
  const enrolledRows: Record<string, unknown>[] = [];
  for (const line of readLines(memoryPath)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r['memoryUniverse'] === 'SHADOW_ENROLLED_APPROVED') {
        enrolledRows.push(r);
      }
    } catch { /* skip malformed */ }
  }

  const totalEnrolledRows = enrolledRows.length;
  const observedRows      = enrolledRows.filter(r => isObserved(r['outcomeLabel'] as OutcomeLabel));
  const totalObservedRows = observedRows.length;

  // pct with score
  const withScore  = enrolledRows.filter(r => r['bubbleMapsScore'] != null).length;
  const pctWithScore = pct(withScore, totalEnrolledRows);

  // pct risky (should be near 0 — the gate blocks them before enrollment)
  const riskyCount = enrolledRows.filter(r => r['clusterRisk'] === 'RISKY').length;
  const pctRisky   = pct(riskyCount, totalEnrolledRows);

  // ── Score tier grouping ───────────────────────────────────────────────────
  const tierEnrolled:  Record<string, number> = {};
  const tierObserved:  Record<string, number> = {};
  const tierWins:      Record<string, number> = {};
  const TIER_ORDER = ['SCORE_GTE_80', 'SCORE_60_TO_79', 'SCORE_LT_60', 'SCORE_NONE'];
  for (const t of TIER_ORDER) { tierEnrolled[t] = 0; tierObserved[t] = 0; tierWins[t] = 0; }

  for (const r of enrolledRows) {
    const score  = r['bubbleMapsScore'] as number | null | undefined;
    const label  = r['outcomeLabel'] as OutcomeLabel;
    const t      = scoreTier(score);
    tierEnrolled[t] = (tierEnrolled[t] ?? 0) + 1;
    if (isObserved(label)) {
      tierObserved[t] = (tierObserved[t] ?? 0) + 1;
      if (isWin(label)) tierWins[t] = (tierWins[t] ?? 0) + 1;
    }
  }

  const scoreTiers: TierStats[] = TIER_ORDER.map(t => ({
    tier:          t,
    enrolledCount: tierEnrolled[t] ?? 0,
    observedCount: tierObserved[t] ?? 0,
    winCount:      tierWins[t] ?? 0,
    winRate:       pct(tierWins[t] ?? 0, tierObserved[t] ?? 0),
  }));

  // ── Cluster risk grouping ─────────────────────────────────────────────────
  const crObs: Record<string, number>  = {};
  const crWins: Record<string, number> = {};
  const crEnr:  Record<string, number> = {};
  const CR_ORDER = ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN'];
  for (const cr of CR_ORDER) { crEnr[cr] = 0; crObs[cr] = 0; crWins[cr] = 0; }

  for (const r of enrolledRows) {
    const cr    = (r['clusterRisk'] as string | undefined) ?? 'UNKNOWN';
    const label = r['outcomeLabel'] as OutcomeLabel;
    crEnr[cr] = (crEnr[cr] ?? 0) + 1;
    if (isObserved(label)) {
      crObs[cr] = (crObs[cr] ?? 0) + 1;
      if (isWin(label)) crWins[cr] = (crWins[cr] ?? 0) + 1;
    }
  }

  const clusterRiskGroups: TierStats[] = CR_ORDER.map(cr => ({
    tier:          cr,
    enrolledCount: crEnr[cr] ?? 0,
    observedCount: crObs[cr] ?? 0,
    winCount:      crWins[cr] ?? 0,
    winRate:       pct(crWins[cr] ?? 0, crObs[cr] ?? 0),
  }));

  const bubbleMapsWinDelta = winDelta(scoreTiers);

  // ── Liquidity bucket grouping ─────────────────────────────────────────────
  const liqBuckets: Record<string, [number, number]> = {};  // [observed, wins]
  for (const r of observedRows) {
    const b = (r['liquidityBucket'] as string | undefined) ?? 'UNKNOWN';
    if (!liqBuckets[b]) liqBuckets[b] = [0, 0];
    liqBuckets[b]![0]++;
    if (isWin(r['outcomeLabel'] as OutcomeLabel)) liqBuckets[b]![1]++;
  }
  const LIQ_ORDER = ['LIQ_LT_10K', 'LIQ_10K_30K', 'LIQ_30K_100K', 'LIQ_GTE_100K', 'LIQ_UNKNOWN'];
  const liquidityBuckets: BucketStats[] = [...LIQ_ORDER, ...Object.keys(liqBuckets).filter(k => !LIQ_ORDER.includes(k))]
    .filter(b => liqBuckets[b])
    .map(b => {
      const [obs, wins] = liqBuckets[b]!;
      return { bucket: b, observedCount: obs, winCount: wins, winRate: pct(wins, obs) };
    });
  const liquidityWinDelta = bucketDelta(liquidityBuckets);

  // ── VLR bucket grouping ───────────────────────────────────────────────────
  const vlrBuckets_: Record<string, [number, number]> = {};
  for (const r of observedRows) {
    const b = (r['vlrBucket'] as string | undefined) ?? 'UNKNOWN';
    if (!vlrBuckets_[b]) vlrBuckets_[b] = [0, 0];
    vlrBuckets_[b]![0]++;
    if (isWin(r['outcomeLabel'] as OutcomeLabel)) vlrBuckets_[b]![1]++;
  }
  const VLR_ORDER = ['VLR_LT_0_5', 'VLR_0_5_TO_2', 'VLR_GTE_2', 'VLR_UNKNOWN'];
  const vlrBuckets: BucketStats[] = [...VLR_ORDER, ...Object.keys(vlrBuckets_).filter(k => !VLR_ORDER.includes(k))]
    .filter(b => vlrBuckets_[b])
    .map(b => {
      const [obs, wins] = vlrBuckets_[b]!;
      return { bucket: b, observedCount: obs, winCount: wins, winRate: pct(wins, obs) };
    });
  const vlrWinDelta = bucketDelta(vlrBuckets);

  // ── Conclusion ────────────────────────────────────────────────────────────
  let conclusion: BubbleMapsValueConclusion;
  let conclusionNote: string;

  if (totalObservedRows < 50) {
    conclusion = 'NEEDS_MORE_DATA';
    conclusionNote =
      `Only ${totalObservedRows} observed rows — need ≥50 for reliable conclusion.`;
  } else if (bubbleMapsWinDelta != null && bubbleMapsWinDelta >= 5) {
    conclusion = 'KEEP_BUBBLEMAPS';
    conclusionNote =
      `BubbleMaps score tiers show ${bubbleMapsWinDelta}% win rate differential — ` +
      `score is predictive. Keep live calls.`;
  } else if (bubbleMapsWinDelta != null && bubbleMapsWinDelta < 1) {
    conclusion = 'REMOVE_LIVE_BUBBLEMAPS';
    conclusionNote =
      `BubbleMaps score tiers show only ${bubbleMapsWinDelta ?? 0}% delta across enrolled rows. ` +
      `All enrolled rows are CLEAN (gate already blocks RISKY before enrollment). ` +
      `Live calls add no observable predictive value within the enrolled cohort. ` +
      `Consider switching to cache-only or removing live calls for enrolled flow.`;
  } else {
    conclusion = 'CACHE_ONLY';
    const bestNonBM = Math.max(liquidityWinDelta ?? 0, vlrWinDelta ?? 0);
    conclusionNote =
      `BubbleMaps score tiers show ${bubbleMapsWinDelta ?? 0}% win delta. ` +
      `Non-BubbleMaps predictors show up to ${bestNonBM}% delta ` +
      `(liq: ${liquidityWinDelta ?? 0}%, VLR: ${vlrWinDelta ?? 0}%). ` +
      `Live BubbleMaps calls are not clearly adding predictive value within the enrolled cohort. ` +
      `Persistent cache preserves existing scoring; live calls can be capped at the default ` +
      `TOKEN_GRAB_BUBBLEMAPS_MAX_CALLS_PER_RUN limit with no expected loss of signal.`;
  }

  return {
    generatedAt,
    totalEnrolledRows,
    totalObservedRows,
    scoreTiers,
    clusterRiskGroups,
    bubbleMapsWinDelta,
    pctWithScore,
    pctRisky,
    liquidityBuckets,
    vlrBuckets,
    liquidityWinDelta,
    vlrWinDelta,
    conclusion,
    conclusionNote,
    callSites: BUBBLEMAPS_CALL_SITES,
    reportOnly:        true,
    readOnly:          true,
    tradingExecuted:   0,
    realTradingLocked: true,
    paperOnly:         true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtRate(r: number | null): string {
  return r != null ? `${r}%` : 'n/a';
}

export function renderBubbleMapsValueReport(result: BubbleMapsValueResult): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];

  lines.push('  TOKEN GRAB — BUBBLEMAPS VALUE REPORT');
  lines.push('  [REPORT ONLY — NO API CALLS — READ ONLY — NO GATE CHANGES]');
  lines.push(`  Generated : ${result.generatedAt}`);
  lines.push(SEP, '');

  // ── Overview ──────────────────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  OVERVIEW');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Enrolled rows       : ${result.totalEnrolledRows}`);
  lines.push(`  Observed rows       : ${result.totalObservedRows}`);
  lines.push(`  % with BM score     : ${fmtRate(result.pctWithScore)}`);
  lines.push(`  % RISKY (in enrolled): ${fmtRate(result.pctRisky)}  ← gate blocks RISKY before enrollment`);
  lines.push('');

  // ── BubbleMaps score tiers ────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  BUBBLEMAPS SCORE TIERS  (win = SMALL_WINNER | WINNER | BIG_WINNER)');
  lines.push(`  ${SEP2}`, '');
  lines.push('  Tier             | Enrolled | Observed | Wins  | Win%');
  lines.push('  -----------------|----------|----------|-------|------');
  for (const t of result.scoreTiers) {
    const name = t.tier.padEnd(16);
    const enr  = String(t.enrolledCount).padStart(8);
    const obs  = String(t.observedCount).padStart(8);
    const win  = String(t.winCount).padStart(5);
    const rate = fmtRate(t.winRate).padStart(6);
    lines.push(`  ${name} | ${enr} | ${obs} | ${win} | ${rate}`);
  }
  lines.push('');
  lines.push(`  Win rate delta across score tiers (obs≥10): ${fmtRate(result.bubbleMapsWinDelta)}`);
  lines.push('');

  // ── Cluster risk groups ───────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  CLUSTER RISK GROUPS');
  lines.push(`  ${SEP2}`, '');
  lines.push('  Risk      | Enrolled | Observed | Wins  | Win%');
  lines.push('  ----------|----------|----------|-------|------');
  for (const g of result.clusterRiskGroups) {
    const name = g.tier.padEnd(9);
    const enr  = String(g.enrolledCount).padStart(8);
    const obs  = String(g.observedCount).padStart(8);
    const win  = String(g.winCount).padStart(5);
    const rate = fmtRate(g.winRate).padStart(6);
    lines.push(`  ${name} | ${enr} | ${obs} | ${win} | ${rate}`);
  }
  lines.push('');

  // ── Non-BubbleMaps predictors ─────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  NON-BUBBLEMAPS PREDICTORS');
  lines.push(`  ${SEP2}`, '');
  lines.push('  Liquidity bucket      | Observed | Wins  | Win%');
  lines.push('  ----------------------|----------|-------|------');
  for (const b of result.liquidityBuckets) {
    const name = b.bucket.padEnd(21);
    const obs  = String(b.observedCount).padStart(8);
    const win  = String(b.winCount).padStart(5);
    const rate = fmtRate(b.winRate).padStart(6);
    lines.push(`  ${name} | ${obs} | ${win} | ${rate}`);
  }
  lines.push(`  Win delta across liq buckets (obs≥10): ${fmtRate(result.liquidityWinDelta)}`);
  lines.push('');
  lines.push('  VLR bucket            | Observed | Wins  | Win%');
  lines.push('  ----------------------|----------|-------|------');
  for (const b of result.vlrBuckets) {
    const name = b.bucket.padEnd(21);
    const obs  = String(b.observedCount).padStart(8);
    const win  = String(b.winCount).padStart(5);
    const rate = fmtRate(b.winRate).padStart(6);
    lines.push(`  ${name} | ${obs} | ${win} | ${rate}`);
  }
  lines.push(`  Win delta across VLR buckets (obs≥10): ${fmtRate(result.vlrWinDelta)}`);
  lines.push('');

  // ── BubbleMaps call sites ─────────────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  BUBBLEMAPS LIVE CALL SITES  (from code survey)');
  lines.push(`  ${SEP2}`, '');
  for (const site of result.callSites) {
    lines.push(`  • ${site}`);
  }
  lines.push('');

  // ── Conclusion ────────────────────────────────────────────────────────────
  lines.push(SEP);
  lines.push('  CONCLUSION');
  lines.push(SEP, '');
  lines.push(`  ${result.conclusion}`);
  lines.push('');
  lines.push(`  ${result.conclusionNote}`);
  lines.push('');
  lines.push('  Safety: reportOnly=true  readOnly=true  tradingExecuted=0');
  lines.push('          HOLD_CURRENT_GATES  NO_POLICY_CHANGE  DO_NOT_ENABLE_REAL_TRADING');
  lines.push('');
  lines.push(SEP, '');

  return lines.join('\n');
}
