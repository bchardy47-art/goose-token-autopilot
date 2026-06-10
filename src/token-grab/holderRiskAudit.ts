import * as fs from 'fs';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import { maybeHolderRiskFromFixture, type HolderRiskRawInput } from './holderRiskProvider';
import type { HolderClusterResult } from './holderClusterAdapter';

// ── Result types ──────────────────────────────────────────────────────────────

export interface HolderRiskAuditEntry {
  id: string;
  capturedAt: string;
  symbol: string;
  source: string;
  buyGateDecision: string;
  ripperScore: number | undefined;
  holderResult: HolderClusterResult | null;
  holderRisk: string;
  hasHolderData: boolean;
}

export interface HolderRiskAuditOptions {
  inputPath?: string;
}

export interface HolderRiskAuditResult {
  inputPath: string;
  inputMissing: boolean;
  totalFixtures: number;
  withHolderData: number;
  withoutHolderData: number;
  holderRiskCounts: Record<string, number>;
  approvedCount: number;
  approvedWithHolderData: number;
  approvedUnknownHolder: number;
  approvedRiskyHolder: number;
  approvedWatchHolder: number;
  approvedCleanHolder: number;
  entries: HolderRiskAuditEntry[];
  approvedEntries: HolderRiskAuditEntry[];
  riskyApprovedEntries: HolderRiskAuditEntry[];
  unknownApprovedEntries: HolderRiskAuditEntry[];
  recommendedNextStep: string;
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

export function runHolderRiskAudit(options: HolderRiskAuditOptions = {}): HolderRiskAuditResult {
  const inputPath = options.inputPath ?? DEFAULT_INPUT;

  const empty: HolderRiskAuditResult = {
    inputPath, inputMissing: true,
    totalFixtures: 0, withHolderData: 0, withoutHolderData: 0,
    holderRiskCounts: {},
    approvedCount: 0, approvedWithHolderData: 0,
    approvedUnknownHolder: 0, approvedRiskyHolder: 0,
    approvedWatchHolder: 0, approvedCleanHolder: 0,
    entries: [], approvedEntries: [], riskyApprovedEntries: [], unknownApprovedEntries: [],
    recommendedNextStep: 'Run the learning loop: npm run token:dex-day-watch && npm run token:fresh-pool-feed && npm run token:live-fixture-capture',
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };

  if (!fs.existsSync(inputPath)) return empty;

  const fixtures = readFixturesFromJsonl(inputPath);
  if (fixtures.length === 0) return { ...empty, inputMissing: false };

  const entries: HolderRiskAuditEntry[] = fixtures.map(f => {
    const holderResult  = maybeHolderRiskFromFixture(f);
    const holderRisk    = holderResult?.holderRisk ?? 'UNKNOWN';
    const sig           = f.normalizedSignal as Record<string, unknown> | undefined;
    const symbol        = (sig?.symbol ?? (f as unknown as Record<string, unknown>).symbol ?? 'UNKNOWN') as string;

    return {
      id:             f.id,
      capturedAt:     f.capturedAt,
      symbol,
      source:         f.source,
      buyGateDecision: f.buyGateDecision ?? 'UNKNOWN',
      ripperScore:    f.ripperScore,
      holderResult,
      holderRisk,
      hasHolderData:  holderResult !== null,
    };
  });

  const holderRiskCounts: Record<string, number> = {};
  let withHolderData    = 0;
  let withoutHolderData = 0;

  for (const e of entries) {
    if (e.hasHolderData) withHolderData++;
    else withoutHolderData++;
    holderRiskCounts[e.holderRisk] = (holderRiskCounts[e.holderRisk] ?? 0) + 1;
  }

  const approved               = entries.filter(e => e.buyGateDecision === 'BUY_APPROVED_PAPER');
  const approvedWithHolderData = approved.filter(e => e.hasHolderData).length;
  const approvedUnknown        = approved.filter(e => e.holderRisk === 'UNKNOWN');
  const approvedRisky          = approved.filter(e => e.holderRisk === 'RISKY');
  const approvedWatch          = approved.filter(e => e.holderRisk === 'WATCH');
  const approvedClean          = approved.filter(e => e.holderRisk === 'CLEAN');

  // Recommended next step
  let nextStep = '';
  if (approvedRisky.length > 0) {
    nextStep = `${approvedRisky.length} approved candidates have RISKY holderRisk — review immediately before paper deployment`;
  } else if (approvedUnknown.length === approved.length) {
    nextStep = 'All approved candidates lack holder data. Connect a holder concentration provider or run token:dex-candidate-safety-enrich to get CLEAN/RISKY classification before trusting approvals.';
  } else if (approvedUnknown.length > 0) {
    nextStep = `${approvedUnknown.length}/${approved.length} approved candidates lack holder data — run token:dex-candidate-safety-enrich on fresh candidates to fill gaps.`;
  } else {
    nextStep = 'Holder data coverage looks good. Run token:prime-gate-audit --strict-preview to assess overall gate strength.';
  }

  return {
    inputPath, inputMissing: false,
    totalFixtures: fixtures.length,
    withHolderData, withoutHolderData,
    holderRiskCounts,
    approvedCount: approved.length,
    approvedWithHolderData,
    approvedUnknownHolder: approvedUnknown.length,
    approvedRiskyHolder:   approvedRisky.length,
    approvedWatchHolder:   approvedWatch.length,
    approvedCleanHolder:   approvedClean.length,
    entries,
    approvedEntries: approved,
    riskyApprovedEntries:   approvedRisky,
    unknownApprovedEntries: approvedUnknown,
    recommendedNextStep: nextStep,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

export function renderHolderRiskAuditReport(result: HolderRiskAuditResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — HOLDER RISK AUDIT');
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

  const { totalFixtures, withHolderData, withoutHolderData, holderRiskCounts,
          approvedCount, approvedWithHolderData, approvedUnknownHolder,
          approvedRiskyHolder, approvedWatchHolder, approvedCleanHolder,
          riskyApprovedEntries, unknownApprovedEntries, recommendedNextStep } = result;

  // 1. Data coverage
  lines.push('');
  lines.push('  1. FIXTURE COVERAGE');
  lines.push(`     Total fixtures      : ${totalFixtures}`);
  lines.push(`     With holder data    : ${withHolderData}  (${pct(withHolderData, totalFixtures)})`);
  lines.push(`     Without holder data : ${withoutHolderData}  (${pct(withoutHolderData, totalFixtures)})`);
  lines.push('');

  // 2. holderRisk distribution
  lines.push('  2. HOLDER RISK DISTRIBUTION (all fixtures)');
  const riskOrder = ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN'];
  for (const risk of riskOrder) {
    const count = holderRiskCounts[risk] ?? 0;
    if (count > 0) {
      lines.push(`     ${risk.padEnd(8)} : ${String(count).padStart(3)}  (${pct(count, totalFixtures)})`);
    }
  }
  lines.push('');

  // 3. Approved breakdown
  lines.push('  3. APPROVED CANDIDATES (BUY_APPROVED_PAPER)');
  lines.push(`     Total approved      : ${approvedCount}`);
  lines.push(`     With holder data    : ${approvedWithHolderData}  (${pct(approvedWithHolderData, approvedCount)})`);
  lines.push(`     UNKNOWN holderRisk  : ${approvedUnknownHolder}  (${pct(approvedUnknownHolder, approvedCount)})`);
  lines.push(`     WATCH holderRisk    : ${approvedWatchHolder}  (${pct(approvedWatchHolder, approvedCount)})`);
  lines.push(`     CLEAN holderRisk    : ${approvedCleanHolder}  (${pct(approvedCleanHolder, approvedCount)})`);
  if (approvedRiskyHolder > 0) {
    lines.push(`     RISKY holderRisk    : ${approvedRiskyHolder}  ← NEEDS REVIEW`);
  } else {
    lines.push(`     RISKY holderRisk    : 0`);
  }
  lines.push('');

  // 4. Risky approved candidates
  if (riskyApprovedEntries.length > 0) {
    lines.push('  4. RISKY APPROVED CANDIDATES — REVIEW IMMEDIATELY');
    for (const e of riskyApprovedEntries) {
      lines.push(`     ⚠ $${e.symbol}  score=${e.ripperScore ?? '?'}  ${e.holderResult?.concentrationNotes.join(', ') ?? ''}`);
    }
    lines.push('');
  }

  // 5. Unknown approved candidates (sample)
  if (unknownApprovedEntries.length > 0) {
    lines.push(`  5. APPROVED WITH UNKNOWN HOLDER RISK (${unknownApprovedEntries.length} total)`);
    lines.push('     These were approved without holder concentration verification.');
    lines.push(`     Source breakdown:`);
    const srcMap: Record<string, number> = {};
    for (const e of unknownApprovedEntries) {
      srcMap[e.source] = (srcMap[e.source] ?? 0) + 1;
    }
    for (const [src, count] of Object.entries(srcMap)) {
      lines.push(`       ${src}: ${count}`);
    }
    lines.push('');
    lines.push('     Sample (top 5):');
    for (const e of unknownApprovedEntries.slice(0, 5)) {
      lines.push(`       $${e.symbol}  score=${e.ripperScore ?? '?'}  source=${e.source}`);
    }
    if (unknownApprovedEntries.length > 5) {
      lines.push(`       … and ${unknownApprovedEntries.length - 5} more`);
    }
    lines.push('');
  }

  // 6. Recommended next step
  lines.push('  6. RECOMMENDED NEXT STEP');
  lines.push(`     ${recommendedNextStep}`);
  lines.push('');

  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}

export function renderHolderRiskAuditUsage(): string {
  return `
token:holder-risk-audit — audit holder concentration risk across live fixtures

Usage:
  npm run token:holder-risk-audit [options]

Options:
  --fixtures <path>    input JSONL fixture file (default: data/token-grab/ripper/live-fixtures.jsonl)
  --help               show this message

Report sections:
  1. Fixture coverage (with/without holder data)
  2. Holder risk distribution (CLEAN/WATCH/RISKY/UNKNOWN)
  3. Approved candidates breakdown by holder risk
  4. RISKY approved candidates (needs review)
  5. Approved with UNKNOWN holder risk
  6. Recommended next step

Data source:
  Reads holderConcentrationStatus, topHolderPercent from fixture raw fields.
  Enriched candidates (dex-winner-candidates-enriched) carry this from token:dex-candidate-safety-enrich.
  Fresh pool candidates (dex-watch-run) do not have holder data.

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap. Read-only.
`.trim();
}
