import * as fs from 'fs';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { LiveRipperFixture } from './liveFixtureCapture';
import type { ClusterRisk } from './dexRipperEngine';
import { extractClusterRiskFromCandidate } from './clusterRiskProvider';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClusterRiskAuditOptions {
  inputPath?:   string;
  generatedAt?: string;
}

export interface ClusterRiskAuditResult {
  inputPath:                        string;
  inputMissing:                     boolean;
  generatedAt:                      string;
  totalFixtures:                    number;
  fixturesWithCluster:              number;
  fixturesMissingCluster:           number;
  clusterRiskCounts:                Record<ClusterRisk, number>;
  approvedCount:                    number;
  approvedByClusterRisk:            Record<ClusterRisk, number>;
  autonomyBlockedByClusterCount:    number;  // approved + holderRisk CLEAN + slippage CLEAN + cluster UNKNOWN
  futureCandidateIfCleanCount:      number;  // what would become FUTURE_AUTONOMY_CANDIDATE if cluster=CLEAN
  topRiskyCluster:                  Array<{ symbol: string; ripperScore: number; reason: string }>;
  tradingExecuted:                  0;
  noRealTradeSent:                  true;
  paperOnly:                        true;
  readOnly:                         true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRaw(f: LiveRipperFixture): Record<string, unknown> {
  return (f.raw as Record<string, unknown> | undefined) ?? {};
}

function getClusterRisk(f: LiveRipperFixture): ClusterRisk {
  const v = getRaw(f)['clusterRisk'];
  if (v === 'CLEAN') return 'CLEAN';
  if (v === 'WATCH')  return 'WATCH';
  if (v === 'RISKY')  return 'RISKY';
  return 'UNKNOWN';
}

function getHolderRisk(f: LiveRipperFixture): string {
  const v = getRaw(f)['holderConcentrationStatus'];
  if (v === 'CLEAN') return 'CLEAN';
  if (v === 'WARNING') return 'WATCH';
  if (v === 'DANGER')  return 'RISKY';
  return 'UNKNOWN';
}

function getSlippageRisk(f: LiveRipperFixture): string {
  return String(getRaw(f)['slippageRisk'] ?? 'UNKNOWN');
}

function isApproved(f: LiveRipperFixture): boolean {
  return (f.buyGateDecision ?? f.entryDecision ?? '') === 'BUY_APPROVED_PAPER';
}

function getSymbol(f: LiveRipperFixture): string {
  const sig = f.normalizedSignal as Record<string, unknown> | undefined;
  return String(sig?.['symbol'] ?? (f as unknown as Record<string, unknown>)['symbol'] ?? 'UNKNOWN');
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

export function runClusterRiskAudit(
  options: ClusterRiskAuditOptions = {},
): ClusterRiskAuditResult {
  const inputPath   = options.inputPath  ?? DEFAULT_INPUT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const emptyClusterCounts: Record<ClusterRisk, number> = { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 };

  const base: Omit<ClusterRiskAuditResult, 'inputPath' | 'inputMissing' | 'generatedAt'> = {
    totalFixtures: 0,
    fixturesWithCluster: 0,
    fixturesMissingCluster: 0,
    clusterRiskCounts: { ...emptyClusterCounts },
    approvedCount: 0,
    approvedByClusterRisk: { ...emptyClusterCounts },
    autonomyBlockedByClusterCount: 0,
    futureCandidateIfCleanCount: 0,
    topRiskyCluster: [],
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };

  if (!fs.existsSync(inputPath)) {
    return { inputPath, inputMissing: true, generatedAt, ...base };
  }

  let fixtures: LiveRipperFixture[];
  try { fixtures = readFixturesFromJsonl(inputPath); } catch {
    return { inputPath, inputMissing: true, generatedAt, ...base };
  }

  base.totalFixtures = fixtures.length;
  const topRiskyCluster: Array<{ symbol: string; ripperScore: number; reason: string }> = [];

  for (const f of fixtures) {
    const raw = getRaw(f);
    const clusterResult = extractClusterRiskFromCandidate(raw);
    const hasCluster = clusterResult !== null;

    if (hasCluster) base.fixturesWithCluster++; else base.fixturesMissingCluster++;

    const clusterRisk = getClusterRisk(f);
    base.clusterRiskCounts[clusterRisk]++;

    if (isApproved(f)) {
      base.approvedCount++;
      base.approvedByClusterRisk[clusterRisk]++;

      const holderRisk  = getHolderRisk(f);
      const slipRisk    = getSlippageRisk(f);
      const isAutonomyBlocked =
        clusterRisk === 'UNKNOWN' &&
        holderRisk  === 'CLEAN'   &&
        slipRisk    === 'CLEAN';
      if (isAutonomyBlocked) base.autonomyBlockedByClusterCount++;

      // Count how many would become FUTURE_AUTONOMY_CANDIDATE if cluster=CLEAN
      const wouldBeFutureCandidate =
        holderRisk  === 'CLEAN' &&
        slipRisk    === 'CLEAN' &&
        (clusterRisk === 'UNKNOWN' || clusterRisk === 'CLEAN');
      if (wouldBeFutureCandidate) base.futureCandidateIfCleanCount++;
    }

    if (clusterRisk === 'RISKY') {
      const notes = clusterResult?.clusterNotes ?? [];
      topRiskyCluster.push({
        symbol:      getSymbol(f),
        ripperScore: f.ripperScore ?? 0,
        reason:      notes[0] ?? 'clusterRisk RISKY',
      });
    }
  }

  base.topRiskyCluster = topRiskyCluster
    .sort((a, b) => b.ripperScore - a.ripperScore)
    .slice(0, 10);

  return { inputPath, inputMissing: false, generatedAt, ...base };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

export function renderClusterRiskAuditReport(result: ClusterRiskAuditResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — CLUSTER RISK AUDIT');
  lines.push('  [REAL TRADING LOCKED — AUDIT ONLY — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.inputMissing) {
    lines.push('');
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run the learning loop first.');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  const { totalFixtures, approvedCount, clusterRiskCounts, approvedByClusterRisk } = result;

  lines.push('');
  lines.push(`  Generated  : ${result.generatedAt}`);
  lines.push(`  Input      : ${result.inputPath}`);
  lines.push('');

  lines.push('  CLUSTER DATA COVERAGE');
  lines.push(`  Total fixtures       : ${totalFixtures}`);
  lines.push(`  With cluster data    : ${result.fixturesWithCluster}  (${pct(result.fixturesWithCluster, totalFixtures)})`);
  lines.push(`  Missing cluster data : ${result.fixturesMissingCluster}  (${pct(result.fixturesMissingCluster, totalFixtures)})`);
  lines.push('');

  lines.push('  CLUSTER RISK DISTRIBUTION (all fixtures)');
  for (const risk of ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN'] as const) {
    const n = clusterRiskCounts[risk];
    lines.push(`    ${risk.padEnd(8)} : ${String(n).padStart(4)}  ${pct(n, totalFixtures).padStart(6)}`);
  }
  lines.push('');

  lines.push(`  BUY_APPROVED_PAPER BREAKDOWN  (${approvedCount} approved)`);
  for (const risk of ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN'] as const) {
    const n = approvedByClusterRisk[risk];
    lines.push(`    ${risk.padEnd(8)} : ${String(n).padStart(4)}  ${pct(n, approvedCount).padStart(6)}`);
  }
  lines.push('');

  lines.push('  AUTONOMY PATH');
  lines.push(`  Blocked by cluster UNKNOWN  : ${result.autonomyBlockedByClusterCount}`);
  lines.push(`    (approved + holderRisk=CLEAN + slippageRisk=CLEAN, blocked only by missing cluster data)`);
  lines.push(`  Would be FUTURE_AUTONOMY if cluster=CLEAN : ${result.futureCandidateIfCleanCount}`);
  lines.push('');

  if (result.topRiskyCluster.length > 0) {
    lines.push('  TOP RISKY CLUSTER CANDIDATES');
    for (const r of result.topRiskyCluster) {
      lines.push(`    $${r.symbol.padEnd(14)} score=${r.ripperScore}  ${r.reason}`);
    }
    lines.push('');
  }

  lines.push('  RECOMMENDED NEXT STEP');
  if (result.fixturesMissingCluster === result.totalFixtures) {
    lines.push('  → No cluster data yet. Set API config and run:');
    lines.push('       export BUBBLEMAPS_API_URL=https://api.bubblemaps.io/v1');
    lines.push('       export BUBBLEMAPS_API_KEY=your_key_here');
    lines.push('       npm run token:fixture-cluster-enrich');
  } else if (result.autonomyBlockedByClusterCount > 0) {
    lines.push(`  → ${result.autonomyBlockedByClusterCount} approved candidate(s) blocked only by UNKNOWN cluster.`);
    lines.push('     After cluster enrichment with real data, re-run:');
    lines.push('       npm run token:autonomy-readiness-audit');
  } else if (result.clusterRiskCounts['RISKY'] > 0) {
    lines.push(`  → ${result.clusterRiskCounts['RISKY']} fixture(s) have RISKY cluster — review before promoting.`);
  } else {
    lines.push('  → Cluster data looks healthy. Run autonomy readiness audit:');
    lines.push('       npm run token:autonomy-readiness-audit');
  }
  lines.push('');

  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}
