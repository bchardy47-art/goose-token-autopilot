import * as fs from 'fs';
import {
  scoreRipper,
  DEFAULT_RIPPER_CONFIG,
  type RipperInput,
  type HolderRisk,
  type ClusterRisk,
  type BotRisk,
  type LiquidityQuality,
} from './dexRipperEngine';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import { maybeHolderRiskFromFixture } from './holderRiskProvider';
import { type SlippageRisk } from './fixtureQuotePreview';

// ── Readiness levels (ordered worst → best) ───────────────────────────────────

export type ReadinessLevel =
  | 'HARD_REJECT'
  | 'PAPER_WATCH'
  | 'REVIEW_READY_PAPER'
  | 'AUTONOMY_BLOCKED_CLUSTER_UNKNOWN'
  | 'FUTURE_AUTONOMY_CANDIDATE';

export const READINESS_ORDER: ReadinessLevel[] = [
  'HARD_REJECT',
  'PAPER_WATCH',
  'REVIEW_READY_PAPER',
  'AUTONOMY_BLOCKED_CLUSTER_UNKNOWN',
  'FUTURE_AUTONOMY_CANDIDATE',
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReadinessFields {
  holderRisk:       HolderRisk;
  clusterRisk:      ClusterRisk;
  botRisk:          BotRisk;
  liquidityQuality: LiquidityQuality;
  slippageRisk:     SlippageRisk;
  routeFound:       boolean | null;
  hasQuoteData:     boolean;
  buyGateDecision:  string;
  entryDecision:    string;
}

export interface AuditedFixture {
  id:               string;
  capturedAt:       string;
  symbol:           string;
  source:           string;
  ripperScore:      number;
  launchAgeBucket:  string;
  ageMinutes:       number;
  level:            ReadinessLevel;
  levelReasons:     string[];
  fields:           ReadinessFields;
}

export interface AutonomyReadinessAuditOptions {
  inputPath?:   string;
  generatedAt?: string;
}

export interface AutonomyReadinessAuditResult {
  inputPath:                        string;
  inputMissing:                     boolean;
  generatedAt:                      string;
  totalFixtures:                    number;
  approvedCount:                    number;
  levelCounts:                      Record<ReadinessLevel, number>;
  futureAutonomyCandidateCount:     number;
  autonomyBlockedClusterUnknownCount: number;
  reviewReadyPaperCount:            number;
  paperWatchCount:                  number;
  hardRejectCount:                  number;
  hardRejectHolderRiskyCount:       number;
  hardRejectSlippageRiskyCount:     number;
  topReviewReadyPaper:              AuditedFixture[];
  topHardRejects:                   AuditedFixture[];
  allAudited:                       AuditedFixture[];
  tradingExecuted:                  0;
  noRealTradeSent:                  true;
  paperOnly:                        true;
  readOnly:                         true;
}

// ── Field extraction ──────────────────────────────────────────────────────────

export function extractReadinessFields(fixture: LiveRipperFixture): ReadinessFields {
  const ripperInput   = fixture.ripperInput as RipperInput | null;
  const capturedAtMs  = new Date(fixture.capturedAt).getTime();

  let holderRisk:       HolderRisk      = 'UNKNOWN';
  let clusterRisk:      ClusterRisk     = 'UNKNOWN';
  let botRisk:          BotRisk         = 'UNKNOWN';
  let liquidityQuality: LiquidityQuality = 'UNKNOWN';

  if (ripperInput) {
    const scored   = scoreRipper(ripperInput, DEFAULT_RIPPER_CONFIG, capturedAtMs);
    holderRisk      = scored.holderCluster.holderRisk;
    clusterRisk     = scored.holderCluster.clusterRisk;
    botRisk         = scored.botRiskProfile.botRisk;
    liquidityQuality = scored.liquidityProfile.quality;
  }

  const raw = fixture.raw as Record<string, unknown> | undefined;

  // holderRisk override from enriched raw fields (higher fidelity than ripperInput inference)
  const holderFromRaw = maybeHolderRiskFromFixture(fixture);
  if (holderFromRaw) {
    holderRisk = holderFromRaw.holderRisk;
  }

  // clusterRisk override from fixture.raw cluster enrichment data.
  // Reads raw.clusterRisk directly so test fixtures (no clusterCheckedAt) and enriched fixtures both work.
  // maybeClusterRiskFromFixture is used by primeGateAudit for the stricter "was it enriched?" check.
  const rawCluster = raw?.['clusterRisk'];
  if (rawCluster === 'CLEAN' || rawCluster === 'WATCH' || rawCluster === 'RISKY') {
    clusterRisk = rawCluster;
  }

  const rawSlip = raw?.['slippageRisk'];
  const slippageRisk: SlippageRisk =
    rawSlip === 'CLEAN' ? 'CLEAN' :
    rawSlip === 'WATCH'  ? 'WATCH'  :
    rawSlip === 'RISKY'  ? 'RISKY'  : 'UNKNOWN';

  const hasQuoteData = raw?.['quoteCheckedAt'] !== undefined;
  const routeFound   = raw?.['routeFound'] === true
    ? true
    : raw?.['routeFound'] === false ? false : null;

  const buyGateDecision = fixture.buyGateDecision ?? fixture.entryDecision ?? '';
  const entryDecision   = fixture.entryDecision   ?? '';

  return { holderRisk, clusterRisk, botRisk, liquidityQuality, slippageRisk, routeFound, hasQuoteData, buyGateDecision, entryDecision };
}

// ── Classification ────────────────────────────────────────────────────────────

export function classifyReadinessLevel(
  fields: ReadinessFields,
): { level: ReadinessLevel; levelReasons: string[] } {
  // ── HARD_REJECT ────────────────────────────────────────────────────────────
  const hardReasons: string[] = [];
  if (fields.holderRisk === 'RISKY')          hardReasons.push('holderRisk RISKY');
  if (fields.slippageRisk === 'RISKY') {
    if (fields.routeFound === false)             hardReasons.push('no buy route found');
    else                                         hardReasons.push('slippageRisk RISKY (price impact >10%)');
  }
  if (fields.buyGateDecision === 'BUY_REJECTED') hardReasons.push('buyGateDecision BUY_REJECTED');
  if (fields.entryDecision   === 'IGNORE')        hardReasons.push('entryDecision IGNORE');

  if (hardReasons.length > 0) {
    return { level: 'HARD_REJECT', levelReasons: hardReasons };
  }

  const isApproved   = fields.buyGateDecision === 'BUY_APPROVED_PAPER';
  const holderClean  = fields.holderRisk       === 'CLEAN';
  const slippageClean = fields.slippageRisk    === 'CLEAN';
  const routeOk      = fields.routeFound       === true;
  const botOk        = fields.botRisk === 'CLEAN' || fields.botRisk === 'WATCH';
  const liqOk        = fields.liquidityQuality === 'GOOD';

  // ── FUTURE_AUTONOMY_CANDIDATE ──────────────────────────────────────────────
  if (isApproved && holderClean && slippageClean && routeOk && fields.clusterRisk === 'CLEAN' && botOk && liqOk) {
    return { level: 'FUTURE_AUTONOMY_CANDIDATE', levelReasons: [] };
  }

  // ── AUTONOMY_BLOCKED_CLUSTER_UNKNOWN ───────────────────────────────────────
  if (isApproved && holderClean && slippageClean && routeOk && fields.clusterRisk === 'UNKNOWN' && botOk && liqOk) {
    return {
      level: 'AUTONOMY_BLOCKED_CLUSTER_UNKNOWN',
      levelReasons: ['clusterRisk UNKNOWN — BubbleMaps/cluster provider not connected'],
    };
  }

  // ── REVIEW_READY_PAPER ─────────────────────────────────────────────────────
  if (isApproved) {
    const reasons: string[] = [];
    if (fields.holderRisk === 'WATCH')          reasons.push('holderRisk WATCH');
    if (fields.holderRisk === 'UNKNOWN')         reasons.push('holderRisk UNKNOWN');
    if (fields.slippageRisk === 'WATCH')         reasons.push('slippageRisk WATCH');
    if (fields.slippageRisk === 'UNKNOWN')       reasons.push('slippageRisk UNKNOWN — no quote data');
    if (fields.clusterRisk === 'RISKY')          reasons.push('clusterRisk RISKY');
    if (fields.clusterRisk === 'WATCH')          reasons.push('clusterRisk WATCH');
    if (!routeOk)                                reasons.push('routeFound not confirmed');
    if (!botOk)                                  reasons.push(`botRisk ${fields.botRisk}`);
    if (!liqOk)                                  reasons.push(`liquidityQuality ${fields.liquidityQuality}`);
    if (fields.clusterRisk === 'UNKNOWN' && (!holderClean || !slippageClean || !routeOk)) {
      reasons.push('clusterRisk UNKNOWN');
    }
    return { level: 'REVIEW_READY_PAPER', levelReasons: reasons };
  }

  // ── PAPER_WATCH ────────────────────────────────────────────────────────────
  const watchReasons: string[] = [];
  if (fields.holderRisk === 'WATCH')            watchReasons.push('holderRisk WATCH');
  if (fields.slippageRisk === 'WATCH')          watchReasons.push('slippageRisk WATCH');
  if (!fields.hasQuoteData)                     watchReasons.push('missing quote data');
  if (fields.holderRisk === 'UNKNOWN')          watchReasons.push('missing holder data');
  if (fields.buyGateDecision)                   watchReasons.push(`buyGateDecision ${fields.buyGateDecision}`);
  return { level: 'PAPER_WATCH', levelReasons: watchReasons };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

export function runAutonomyReadinessAudit(
  options: AutonomyReadinessAuditOptions = {},
): AutonomyReadinessAuditResult {
  const inputPath  = options.inputPath  ?? DEFAULT_INPUT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const emptyLevelCounts: Record<ReadinessLevel, number> = {
    FUTURE_AUTONOMY_CANDIDATE:          0,
    AUTONOMY_BLOCKED_CLUSTER_UNKNOWN:   0,
    REVIEW_READY_PAPER:                 0,
    PAPER_WATCH:                        0,
    HARD_REJECT:                        0,
  };

  const emptyResult: AutonomyReadinessAuditResult = {
    inputPath, inputMissing: true, generatedAt,
    totalFixtures: 0, approvedCount: 0,
    levelCounts: { ...emptyLevelCounts },
    futureAutonomyCandidateCount: 0,
    autonomyBlockedClusterUnknownCount: 0,
    reviewReadyPaperCount: 0,
    paperWatchCount: 0,
    hardRejectCount: 0,
    hardRejectHolderRiskyCount: 0,
    hardRejectSlippageRiskyCount: 0,
    topReviewReadyPaper: [],
    topHardRejects: [],
    allAudited: [],
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };

  if (!fs.existsSync(inputPath)) return emptyResult;

  let fixtures: LiveRipperFixture[];
  try {
    fixtures = readFixturesFromJsonl(inputPath);
  } catch {
    return emptyResult;
  }

  const allAudited: AuditedFixture[] = fixtures.map(f => {
    const fields = extractReadinessFields(f);
    const { level, levelReasons } = classifyReadinessLevel(fields);
    const sig    = f.normalizedSignal as Record<string, unknown> | undefined;
    const symbol = (sig?.['symbol'] ?? (f as unknown as Record<string, unknown>)['symbol'] ?? 'UNKNOWN') as string;
    return {
      id:              f.id,
      capturedAt:      f.capturedAt,
      symbol,
      source:          f.source,
      ripperScore:     f.ripperScore ?? 0,
      launchAgeBucket: f.launchAgeBucket ?? 'UNKNOWN',
      ageMinutes:      f.ageMinutes ?? 0,
      level,
      levelReasons,
      fields,
    };
  });

  const levelCounts: Record<ReadinessLevel, number> = { ...emptyLevelCounts };
  let approvedCount                  = 0;
  let hardRejectHolderRiskyCount     = 0;
  let hardRejectSlippageRiskyCount   = 0;

  for (const a of allAudited) {
    levelCounts[a.level]++;
    if (a.fields.buyGateDecision === 'BUY_APPROVED_PAPER') approvedCount++;
    if (a.level === 'HARD_REJECT') {
      if (a.fields.holderRisk   === 'RISKY') hardRejectHolderRiskyCount++;
      if (a.fields.slippageRisk === 'RISKY') hardRejectSlippageRiskyCount++;
    }
  }

  const topReviewReadyPaper = allAudited
    .filter(a => a.level === 'REVIEW_READY_PAPER')
    .sort((a, b) => b.ripperScore - a.ripperScore)
    .slice(0, 15);

  const topAutonomyBlocked = allAudited
    .filter(a => a.level === 'AUTONOMY_BLOCKED_CLUSTER_UNKNOWN')
    .sort((a, b) => b.ripperScore - a.ripperScore)
    .slice(0, 15);

  const topHardRejects = allAudited
    .filter(a => a.level === 'HARD_REJECT')
    .sort((a, b) => b.ripperScore - a.ripperScore)
    .slice(0, 10);

  // topReviewReadyPaper in the result includes AUTONOMY_BLOCKED for the "good candidates" list
  const topReviewDisplay = [...topAutonomyBlocked, ...topReviewReadyPaper]
    .sort((a, b) => b.ripperScore - a.ripperScore)
    .slice(0, 15);

  return {
    inputPath, inputMissing: false, generatedAt,
    totalFixtures: fixtures.length,
    approvedCount,
    levelCounts,
    futureAutonomyCandidateCount:         levelCounts['FUTURE_AUTONOMY_CANDIDATE'],
    autonomyBlockedClusterUnknownCount:   levelCounts['AUTONOMY_BLOCKED_CLUSTER_UNKNOWN'],
    reviewReadyPaperCount:                levelCounts['REVIEW_READY_PAPER'],
    paperWatchCount:                      levelCounts['PAPER_WATCH'],
    hardRejectCount:                      levelCounts['HARD_REJECT'],
    hardRejectHolderRiskyCount,
    hardRejectSlippageRiskyCount,
    topReviewReadyPaper:   topReviewDisplay,
    topHardRejects,
    allAudited,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

export function renderAutonomyReadinessAuditReport(result: AutonomyReadinessAuditResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — AUTONOMY READINESS AUDIT');
  lines.push('  [REAL TRADING LOCKED — AUDIT ONLY — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.inputMissing) {
    lines.push('');
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run the learning loop first:');
    lines.push('    npm run token:dex-day-watch');
    lines.push('    npm run token:fresh-pool-feed');
    lines.push('    npm run token:live-fixture-capture');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  const {
    totalFixtures, approvedCount, levelCounts,
    futureAutonomyCandidateCount, autonomyBlockedClusterUnknownCount,
    reviewReadyPaperCount, paperWatchCount, hardRejectCount,
    hardRejectHolderRiskyCount, hardRejectSlippageRiskyCount,
    topReviewReadyPaper, topHardRejects,
  } = result;

  // 1. Summary
  lines.push('');
  lines.push('  1. SUMMARY');
  lines.push(`     Generated          : ${result.generatedAt}`);
  lines.push(`     Total fixtures     : ${totalFixtures}`);
  lines.push(`     BUY_APPROVED_PAPER : ${approvedCount}`);
  lines.push('');

  // 2. Readiness ladder
  lines.push('  2. READINESS LADDER (best → worst)');
  const ladderRows: [string, number, string][] = [
    ['FUTURE_AUTONOMY_CANDIDATE',       futureAutonomyCandidateCount,    '← live-ready (when cluster + live execution connected)'],
    ['AUTONOMY_BLOCKED_CLUSTER_UNKNOWN', autonomyBlockedClusterUnknownCount, '← strong candidate, blocked: cluster provider missing'],
    ['REVIEW_READY_PAPER',              reviewReadyPaperCount,           '← approved, manual review advised, not autonomous'],
    ['PAPER_WATCH',                     paperWatchCount,                 '← not approved or data gaps'],
    ['HARD_REJECT',                     hardRejectCount,                 '← blocked by hard safety signal'],
  ];
  for (const [label, count, note] of ladderRows) {
    const pctStr = pct(count, totalFixtures).padStart(6);
    lines.push(`     ${label.padEnd(35)} : ${String(count).padStart(4)}  ${pctStr}  ${note}`);
  }
  lines.push('');

  // 3. Hard reject breakdown
  lines.push('  3. HARD REJECT BREAKDOWN');
  lines.push(`     Caused by holderRisk RISKY            : ${hardRejectHolderRiskyCount}`);
  lines.push(`     Caused by slippageRisk RISKY/no route : ${hardRejectSlippageRiskyCount}`);
  const otherHardReject = hardRejectCount - hardRejectHolderRiskyCount - hardRejectSlippageRiskyCount;
  if (otherHardReject > 0) {
    lines.push(`     Caused by gate/decision reject         : ${otherHardReject}`);
  }
  lines.push('');

  // 4. Top candidates (AUTONOMY_BLOCKED + REVIEW_READY)
  const topCount = topReviewReadyPaper.length;
  lines.push(`  4. TOP CANDIDATES  (AUTONOMY_BLOCKED + REVIEW_READY_PAPER, top ${topCount})`);
  if (topCount === 0) {
    lines.push('     None.');
  } else {
    lines.push('     Level                               Symbol         Score  Age    holder  slip    liq      cluster');
    lines.push('     ────────────────────────────────────────────────────────────────────────────────────────────────');
    for (const a of topReviewReadyPaper) {
      const lvlShort = a.level === 'AUTONOMY_BLOCKED_CLUSTER_UNKNOWN' ? 'BLOCKED_CLUSTER' :
                       a.level === 'REVIEW_READY_PAPER' ? 'REVIEW_READY   ' : a.level.padEnd(15);
      const sym  = `$${a.symbol}`.padEnd(14);
      const scr  = String(a.ripperScore).padStart(5);
      const age  = `${a.ageMinutes.toFixed(0)}m`.padEnd(6);
      const hr   = a.fields.holderRisk.padEnd(7);
      const sr   = a.fields.slippageRisk.padEnd(7);
      const lq   = a.fields.liquidityQuality.padEnd(8);
      const cr   = a.fields.clusterRisk;
      lines.push(`     ${lvlShort}  ${sym}${scr}  ${age} ${hr} ${sr} ${lq} ${cr}`);
      if (a.levelReasons.length > 0) {
        lines.push(`       ↳ gaps: ${a.levelReasons.slice(0, 2).join(' | ')}`);
      }
    }
  }
  lines.push('');

  // 5. Hard rejects sample
  if (topHardRejects.length > 0) {
    lines.push('  5. HARD REJECT SAMPLE');
    for (const a of topHardRejects.slice(0, 5)) {
      lines.push(`     $${a.symbol.padEnd(14)} score=${a.ripperScore}  ${a.levelReasons.join(', ')}`);
    }
    lines.push('');
  }

  // 6. Recommended next step
  lines.push('  6. RECOMMENDED NEXT STEP');
  if (futureAutonomyCandidateCount > 0) {
    lines.push(`  → ${futureAutonomyCandidateCount} FUTURE_AUTONOMY_CANDIDATE(s) ready for live execution`);
    lines.push('     NOTE: Live execution remains locked. Connect live harness under safety review first.');
  } else if (autonomyBlockedClusterUnknownCount > 0) {
    lines.push(`  → ${autonomyBlockedClusterUnknownCount} AUTONOMY_BLOCKED_CLUSTER_UNKNOWN candidate(s)`);
    lines.push('     Next: Connect BubbleMaps/cluster provider → run token:fixture-cluster-enrich');
    lines.push('     After cluster enrichment, re-run this audit — some may become FUTURE_AUTONOMY_CANDIDATE');
  } else if (reviewReadyPaperCount > 0) {
    lines.push(`  → ${reviewReadyPaperCount} REVIEW_READY_PAPER candidate(s) available`);
    lines.push('     These are approved but have data gaps (WATCH holder/slippage, missing cluster).');
    lines.push('     Enrich with: token:fixture-holder-enrich, token:fixture-quote-preview');
  } else if (hardRejectHolderRiskyCount > 0) {
    lines.push(`  → All ${hardRejectCount} HARD_REJECT. ${hardRejectHolderRiskyCount} caused by RISKY holder.`);
    lines.push('     Run learning loop to capture fresh candidates with better holder distribution.');
  } else {
    lines.push('  → No strong candidates yet. Run the learning loop:');
    lines.push('       npm run token:dex-day-watch  +  token:live-fixture-capture');
  }
  lines.push('');

  // Autonomy gate reminder
  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('  AUTONOMY GATE (informational — all gates currently locked):');
  lines.push('    holderRisk=CLEAN  slippageRisk=CLEAN  routeFound=true');
  lines.push('    clusterRisk=CLEAN  botRisk=CLEAN|WATCH  liquidityQuality=GOOD');
  lines.push('    + live harness (not built)  + live execution (locked)');
  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}
