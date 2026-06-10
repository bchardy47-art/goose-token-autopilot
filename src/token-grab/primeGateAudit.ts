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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InferredSafety {
  holderRisk: HolderRisk;
  clusterRisk: ClusterRisk;
  botRisk: BotRisk;
  liquidityQuality: LiquidityQuality;
  hasLiquidityUsd: boolean;
  hasSlippage: boolean;
  hasQuoteData: boolean;
  slippageRisk: SlippageRisk;
}

export interface AuditedApproval {
  id: string;
  capturedAt: string;
  symbol: string;
  source: string;
  ripperScore: number;
  launchAgeBucket: string;
  ageMinutes: number;
  topReasons: string[];
  warnings: string[];
  inferredSafety: InferredSafety;
  softApprovalReasons: string[];
  isSoftApproval: boolean;
}

export interface StrictPreviewResult {
  wouldApproveCount: number;
  rejectedByStrictGate: number;
  strictRejectionReasons: Record<string, number>;
}

export interface PrimeGateAuditOptions {
  inputPath?: string;
  strictPreview?: boolean;
}

export interface PrimeGateAuditResult {
  inputPath: string;
  inputMissing: boolean;
  totalFixtures: number;
  approvedCount: number;
  approvalRate: number;
  byAgeBucket: Record<string, number>;
  byScoreBand: Record<string, number>;
  unknownHolderCount: number;
  unknownClusterCount: number;
  unknownBotRiskCount: number;
  unknownLiquidityCount: number;
  missingLiquidityUsdCount: number;
  missingQuoteCount: number;
  slippageRiskCounts: Record<string, number>;
  softApprovalCount: number;
  approvals: AuditedApproval[];
  softApprovals: AuditedApproval[];
  strictPreview: StrictPreviewResult | null;
  gateTighteningNotes: string[];
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

// ── Safety inference ──────────────────────────────────────────────────────────

function inferSafety(fixture: LiveRipperFixture): InferredSafety {
  const ripperInput = fixture.ripperInput as RipperInput | null;
  const capturedAtMs = new Date(fixture.capturedAt).getTime();

  let holderRisk:      HolderRisk      = 'UNKNOWN';
  let clusterRisk:     ClusterRisk     = 'UNKNOWN';
  let botRisk:         BotRisk         = 'UNKNOWN';
  let liquidityQuality: LiquidityQuality = 'UNKNOWN';

  if (ripperInput) {
    const scored = scoreRipper(ripperInput, DEFAULT_RIPPER_CONFIG, capturedAtMs);
    holderRisk      = scored.holderCluster.holderRisk;
    clusterRisk     = scored.holderCluster.clusterRisk;
    botRisk         = scored.botRiskProfile.botRisk;
    liquidityQuality = scored.liquidityProfile.quality;
  }

  // Upgrade holderRisk from fixture raw when local enrichment data is present.
  // Enriched candidates store holderConcentrationStatus in raw; this is more
  // accurate than inferring from ripperInput (which may not carry holder fields).
  const holderFromRaw = maybeHolderRiskFromFixture(fixture);
  if (holderFromRaw) {
    holderRisk = holderFromRaw.holderRisk;
    // clusterRisk stays UNKNOWN — BubbleMaps not connected in V1
  }

  const sig = fixture.normalizedSignal as Record<string, unknown> | undefined;
  const hasLiquidityUsd = !!(sig?.liquidityUsd != null || (ripperInput as Record<string, unknown> | null)?.liquidityUsd != null);

  const rawFields = fixture.raw as Record<string, unknown> | undefined;
  const rawSlipRisk = rawFields?.['slippageRisk'];
  const slippageRisk: SlippageRisk =
    rawSlipRisk === 'CLEAN' ? 'CLEAN' :
    rawSlipRisk === 'WATCH'  ? 'WATCH'  :
    rawSlipRisk === 'RISKY'  ? 'RISKY'  : 'UNKNOWN';
  const hasQuoteData = rawFields?.['quoteCheckedAt'] !== undefined;
  const hasSlippage = hasQuoteData && slippageRisk !== 'UNKNOWN';

  return { holderRisk, clusterRisk, botRisk, liquidityQuality, hasLiquidityUsd, hasSlippage, hasQuoteData, slippageRisk };
}

// ── Soft approval classification ──────────────────────────────────────────────

function classifySoftApproval(approval: Omit<AuditedApproval, 'softApprovalReasons' | 'isSoftApproval'>): string[] {
  const reasons: string[] = [];
  const { inferredSafety, topReasons } = approval;

  if (inferredSafety.holderRisk === 'UNKNOWN') {
    reasons.push('UNKNOWN holderRisk — no holder concentration data');
  }
  if (inferredSafety.clusterRisk === 'UNKNOWN') {
    reasons.push('UNKNOWN clusterRisk — BubbleMaps not connected');
  }
  if (inferredSafety.botRisk === 'UNKNOWN') {
    reasons.push('UNKNOWN botRisk — no volume/liquidity data for bot scoring');
  }
  if (inferredSafety.liquidityQuality === 'UNKNOWN') {
    reasons.push('UNKNOWN liquidityQuality — no VLR data');
  }
  if (inferredSafety.slippageRisk === 'RISKY') {
    reasons.push('RISKY slippage — may not be tradable at acceptable price impact');
  } else if (!inferredSafety.hasSlippage) {
    reasons.push('missing slippage/quote data — V1 does not connect quote provider');
  }
  if (!inferredSafety.hasLiquidityUsd) {
    reasons.push('missing liquidityUsd — raw pool had no liquidity snapshot');
  }

  const reasonText = topReasons.join(' ');
  const onlyFresh  = topReasons.length > 0 &&
    topReasons.every(r => r.startsWith('prime window') || r.startsWith('ripperScore'));
  if (onlyFresh) {
    reasons.push('approved primarily because of prime window freshness, no momentum/liquidity signals');
  }

  return reasons;
}

// ── Strict preview ────────────────────────────────────────────────────────────

function applyStrictPreview(approvals: AuditedApproval[]): StrictPreviewResult {
  const rejectionReasons: Record<string, number> = {};
  let wouldApproveCount = 0;

  for (const a of approvals) {
    const reasons: string[] = [];
    const s = a.inferredSafety;

    if (s.holderRisk !== 'CLEAN') {
      reasons.push(`holderRisk ${s.holderRisk} (strict requires CLEAN)`);
    }
    if (s.clusterRisk !== 'CLEAN') {
      reasons.push(`clusterRisk ${s.clusterRisk} (strict requires CLEAN)`);
    }
    if (s.botRisk !== 'CLEAN' && s.botRisk !== 'WATCH') {
      reasons.push(`botRisk ${s.botRisk} (strict requires CLEAN or WATCH)`);
    }
    if (s.liquidityQuality !== 'GOOD') {
      reasons.push(`liquidityQuality ${s.liquidityQuality} (strict requires GOOD)`);
    }
    if (s.slippageRisk === 'CLEAN') {
      // CLEAN slippage — no strict rejection
    } else if (s.slippageRisk === 'UNKNOWN') {
      reasons.push('missing slippage data (strict requires quote confirmation)');
    } else {
      reasons.push(`slippageRisk ${s.slippageRisk} (strict requires CLEAN)`);
    }
    if (a.launchAgeBucket !== 'PRIME_WINDOW') {
      reasons.push(`age bucket ${a.launchAgeBucket} (strict requires PRIME_WINDOW)`);
    }

    if (reasons.length === 0) {
      wouldApproveCount++;
    } else {
      for (const r of reasons) {
        rejectionReasons[r] = (rejectionReasons[r] ?? 0) + 1;
      }
    }
  }

  return {
    wouldApproveCount,
    rejectedByStrictGate: approvals.length - wouldApproveCount,
    strictRejectionReasons: rejectionReasons,
  };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

function scoreBand(score: number): string {
  if (score >= 100) return '100';
  if (score >= 90)  return '90-99';
  if (score >= 80)  return '80-89';
  if (score >= 65)  return '65-79';
  return '<65';
}

export function runPrimeGateAudit(options: PrimeGateAuditOptions = {}): PrimeGateAuditResult {
  const inputPath = options.inputPath ?? DEFAULT_INPUT;

  const empty: PrimeGateAuditResult = {
    inputPath,
    inputMissing: true,
    totalFixtures: 0,
    approvedCount: 0,
    approvalRate: 0,
    byAgeBucket: {},
    byScoreBand: {},
    unknownHolderCount: 0,
    unknownClusterCount: 0,
    unknownBotRiskCount: 0,
    unknownLiquidityCount: 0,
    missingLiquidityUsdCount: 0,
    missingQuoteCount: 0,
    slippageRiskCounts: {},
    softApprovalCount: 0,
    approvals: [],
    softApprovals: [],
    strictPreview: null,
    gateTighteningNotes: [],
    tradingExecuted: 0,
    noRealTradeSent: true,
    paperOnly: true,
    readOnly: true,
  };

  if (!fs.existsSync(inputPath)) return empty;

  const allFixtures = readFixturesFromJsonl(inputPath);
  if (allFixtures.length === 0) return { ...empty, inputMissing: false };

  const approved = allFixtures.filter(f => f.buyGateDecision === 'BUY_APPROVED_PAPER');

  // Build audited approvals
  const auditedApprovals: AuditedApproval[] = approved.map(f => {
    const sig     = f.normalizedSignal as Record<string, unknown>;
    const symbol  = (sig?.symbol ?? (f as unknown as Record<string, unknown>).symbol ?? 'UNKNOWN') as string;
    const inferred = inferSafety(f);

    const base = {
      id:             f.id,
      capturedAt:     f.capturedAt,
      symbol,
      source:         f.source,
      ripperScore:    f.ripperScore ?? 0,
      launchAgeBucket: f.launchAgeBucket ?? 'UNKNOWN',
      ageMinutes:     f.ageMinutes ?? 0,
      topReasons:     f.topReasons ?? [],
      warnings:       f.warnings ?? [],
      inferredSafety: inferred,
    };

    const softReasons = classifySoftApproval(base);
    return { ...base, softApprovalReasons: softReasons, isSoftApproval: softReasons.length > 0 };
  });

  // Aggregates
  const byAgeBucket: Record<string, number>  = {};
  const byScoreBand: Record<string, number>  = {};
  let unknownHolder  = 0;
  let unknownCluster = 0;
  let unknownBotRisk = 0;
  let unknownLiq     = 0;
  let missingLiqUsd  = 0;
  let missingQuote   = 0;
  const slippageRiskCounts: Record<string, number> = {};

  for (const a of auditedApprovals) {
    byAgeBucket[a.launchAgeBucket] = (byAgeBucket[a.launchAgeBucket] ?? 0) + 1;
    const band = scoreBand(a.ripperScore);
    byScoreBand[band] = (byScoreBand[band] ?? 0) + 1;

    const s = a.inferredSafety;
    if (s.holderRisk      === 'UNKNOWN') unknownHolder++;
    if (s.clusterRisk     === 'UNKNOWN') unknownCluster++;
    if (s.botRisk         === 'UNKNOWN') unknownBotRisk++;
    if (s.liquidityQuality === 'UNKNOWN') unknownLiq++;
    if (!s.hasLiquidityUsd) missingLiqUsd++;
    if (!s.hasQuoteData)    missingQuote++;
    slippageRiskCounts[s.slippageRisk] = (slippageRiskCounts[s.slippageRisk] ?? 0) + 1;
  }

  const softApprovals = auditedApprovals.filter(a => a.isSoftApproval);

  // Gate tightening notes
  const notes: string[] = [];
  const pct = (n: number, d: number) => d > 0 ? `${((n / d) * 100).toFixed(0)}%` : '—';

  if (unknownHolder > 0) {
    notes.push(`${unknownHolder}/${approved.length} (${pct(unknownHolder, approved.length)}) approvals had UNKNOWN holderRisk — connect holder concentration provider`);
  }
  if (unknownCluster > 0) {
    notes.push(`${unknownCluster}/${approved.length} (${pct(unknownCluster, approved.length)}) approvals had UNKNOWN clusterRisk — connect BubbleMaps to enable cluster filtering`);
  }
  if (unknownBotRisk > 0) {
    notes.push(`${unknownBotRisk}/${approved.length} (${pct(unknownBotRisk, approved.length)}) approvals had UNKNOWN botRisk — signals lacked VLR/volume data needed for bot scoring`);
  }
  if (unknownLiq > 0) {
    notes.push(`${unknownLiq}/${approved.length} (${pct(unknownLiq, approved.length)}) approvals had UNKNOWN liquidityQuality — signals lacked VLR data`);
  }
  if (missingQuote === approved.length && approved.length > 0) {
    notes.push('slippage/quote data missing for all approvals — no quote provider connected in V1');
  } else if (missingQuote > 0) {
    notes.push(`${missingQuote}/${approved.length} (${pct(missingQuote, approved.length)}) approvals missing quote data — run token:fixture-quote-preview`);
  }

  const strictPreview = options.strictPreview ? applyStrictPreview(auditedApprovals) : null;

  return {
    inputPath,
    inputMissing: false,
    totalFixtures: allFixtures.length,
    approvedCount: approved.length,
    approvalRate: allFixtures.length > 0 ? (approved.length / allFixtures.length) * 100 : 0,
    byAgeBucket,
    byScoreBand,
    unknownHolderCount:      unknownHolder,
    unknownClusterCount:     unknownCluster,
    unknownBotRiskCount:     unknownBotRisk,
    unknownLiquidityCount:   unknownLiq,
    missingLiquidityUsdCount: missingLiqUsd,
    missingQuoteCount:       missingQuote,
    slippageRiskCounts,
    softApprovalCount: softApprovals.length,
    approvals: auditedApprovals,
    softApprovals,
    strictPreview,
    gateTighteningNotes: notes,
    tradingExecuted: 0,
    noRealTradeSent: true,
    paperOnly: true,
    readOnly: true,
  };
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function bar(n: number, total: number, width = 10): string {
  const filled = total > 0 ? Math.round((n / total) * width) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

export function renderPrimeGateAuditReport(result: PrimeGateAuditResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — PRIME GATE AUDIT');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
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

  const { totalFixtures, approvedCount, approvalRate, byAgeBucket, byScoreBand,
          unknownHolderCount, unknownClusterCount, unknownBotRiskCount,
          unknownLiquidityCount, missingLiquidityUsdCount, missingQuoteCount,
          softApprovalCount,
          approvals, softApprovals, strictPreview, gateTighteningNotes } = result;

  // 1. Summary
  lines.push('');
  lines.push('  1. SUMMARY');
  lines.push(`     Total fixtures     : ${totalFixtures}`);
  lines.push(`     BUY_APPROVED_PAPER : ${approvedCount}`);
  lines.push(`     Approval rate      : ${approvalRate.toFixed(1)}%`);
  lines.push('');

  // 2. By age bucket
  lines.push('  2. APPROVALS BY AGE BUCKET');
  for (const [bucket, count] of Object.entries(byAgeBucket).sort((a, b) => b[1] - a[1])) {
    lines.push(`     ${bucket.padEnd(14)} : ${String(count).padStart(3)}  ${bar(count, approvedCount)}  ${pct(count, approvedCount)}`);
  }
  if (Object.keys(byAgeBucket).length === 0) lines.push('     (no approvals)');
  lines.push('');

  // 3. By score band
  lines.push('  3. APPROVALS BY SCORE BAND');
  for (const [band, count] of Object.entries(byScoreBand).sort((a, b) => b[1] - a[1])) {
    lines.push(`     Score ${band.padEnd(6)} : ${String(count).padStart(3)}  ${bar(count, approvedCount)}  ${pct(count, approvedCount)}`);
  }
  if (Object.keys(byScoreBand).length === 0) lines.push('     (no approvals)');
  lines.push('');

  // 4. Safety data coverage
  lines.push('  4. SAFETY DATA COVERAGE (inferred from ripperInput)');
  lines.push(`     UNKNOWN holderRisk   : ${unknownHolderCount}/${approvedCount}  ${pct(unknownHolderCount, approvedCount)}`);
  lines.push(`     UNKNOWN clusterRisk  : ${unknownClusterCount}/${approvedCount}  ${pct(unknownClusterCount, approvedCount)}`);
  lines.push(`     UNKNOWN botRisk      : ${unknownBotRiskCount}/${approvedCount}  ${pct(unknownBotRiskCount, approvedCount)}`);
  lines.push(`     UNKNOWN liqQuality   : ${unknownLiquidityCount}/${approvedCount}  ${pct(unknownLiquidityCount, approvedCount)}`);
  lines.push(`     Missing liquidityUsd : ${missingLiquidityUsdCount}/${approvedCount}`);
  const slipLabel = missingQuoteCount === approvedCount && approvedCount > 0
    ? `${missingQuoteCount}/${approvedCount}  100.0%  ← V1 no quote provider`
    : `${missingQuoteCount}/${approvedCount}  ${pct(missingQuoteCount, approvedCount)}`;
  lines.push(`     Missing quote data   : ${slipLabel}`);
  lines.push('');

  // 5. Top approved candidates (up to 15)
  lines.push('  5. TOP APPROVED CANDIDATES');
  const sorted = [...approvals].sort((a, b) => b.ripperScore - a.ripperScore).slice(0, 15);
  for (const a of sorted) {
    const sym  = `$${a.symbol}`.padEnd(14);
    const age  = `${a.ageMinutes.toFixed(0)}m`.padEnd(5);
    const scr  = String(a.ripperScore).padEnd(4);
    const soft = a.isSoftApproval ? '⚠' : '✓';
    const liq  = a.inferredSafety.liquidityQuality.padEnd(8);
    const hr   = a.inferredSafety.holderRisk.padEnd(8);
    const br   = a.inferredSafety.botRisk.padEnd(8);
    lines.push(`     ${soft} ${sym} score=${scr} age=${age} liq=${liq} holder=${hr} bot=${br}`);
    const firstReason = a.topReasons.find(r => !r.startsWith('ripperScore'));
    if (firstReason) lines.push(`       ↳ ${firstReason}`);
  }
  if (approvals.length > 15) lines.push(`     … and ${approvals.length - 15} more`);
  lines.push('');

  // 6. Soft approvals
  lines.push(`  6. SOFT APPROVALS  (${softApprovalCount}/${approvedCount} — approved but with data gaps)`);
  if (softApprovals.length === 0) {
    lines.push('     None — all approvals had complete safety data.');
  } else {
    const reasonFreq: Record<string, number> = {};
    for (const a of softApprovals) {
      for (const r of a.softApprovalReasons) {
        reasonFreq[r] = (reasonFreq[r] ?? 0) + 1;
      }
    }
    for (const [reason, count] of Object.entries(reasonFreq).sort((a, b) => b[1] - a[1])) {
      lines.push(`     ${String(count).padStart(3)}×  ${reason}`);
    }
    lines.push('');
    lines.push('     Sample soft approvals:');
    for (const a of softApprovals.slice(0, 5)) {
      lines.push(`       $${a.symbol}  score=${a.ripperScore}  ${a.softApprovalReasons[0]}`);
    }
    if (softApprovals.length > 5) lines.push(`       … and ${softApprovals.length - 5} more`);
  }
  lines.push('');

  // 7. Gate tightening recommendations
  lines.push('  7. RECOMMENDED GATE TIGHTENING');
  if (gateTighteningNotes.length === 0) {
    lines.push('     No gaps detected.');
  } else {
    for (const note of gateTighteningNotes) {
      lines.push(`     • ${note}`);
    }
  }
  lines.push('');

  // 8. Strict preview
  if (strictPreview) {
    lines.push('  8. STRICT PREVIEW  (--strict-preview, reporting only — gate unchanged)');
    lines.push('     Rules: holderRisk=CLEAN, clusterRisk=CLEAN, botRisk=CLEAN|WATCH,');
    lines.push('            liquidityQuality=GOOD, slippage present, age=PRIME_WINDOW');
    lines.push('');
    lines.push(`     Would approve : ${strictPreview.wouldApproveCount} / ${approvedCount}`);
    lines.push(`     Would reject  : ${strictPreview.rejectedByStrictGate} / ${approvedCount}`);
    if (Object.keys(strictPreview.strictRejectionReasons).length > 0) {
      lines.push('');
      lines.push('     Strict rejection reasons:');
      for (const [reason, count] of Object.entries(strictPreview.strictRejectionReasons).sort((a, b) => b[1] - a[1])) {
        lines.push(`       ${String(count).padStart(3)}×  ${reason}`);
      }
    }
    lines.push('');
    lines.push('     Note: Strict preview does NOT change gate behavior. It shows what would');
    lines.push('           happen if stricter rules were enforced. Use gate-tightening notes');
    lines.push('           above to decide which rules to promote to hard blockers.');
    lines.push('');
  }

  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderPrimeGateAuditUsage(): string {
  return `
token:prime-gate-audit — audit why paper buy approvals were granted

Usage:
  npm run token:prime-gate-audit [options]

Options:
  --fixtures <path>    input JSONL fixture file (default: data/token-grab/ripper/live-fixtures.jsonl)
  --strict-preview     show how many approvals survive stricter safety requirements
  --help               show this message

Report sections:
  1. Summary (totals, approval rate)
  2. Approvals by age bucket
  3. Approvals by score band
  4. Safety data coverage (UNKNOWN counts)
  5. Top approved candidates
  6. Soft approvals (approved but with data gaps)
  7. Gate tightening recommendations
  8. Strict preview (--strict-preview only)

Strict preview rules (reporting only — does not change gate behavior):
  holderRisk=CLEAN, clusterRisk=CLEAN, botRisk=CLEAN|WATCH,
  liquidityQuality=GOOD, slippage present, age=PRIME_WINDOW

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Read-only.
`.trim();
}
