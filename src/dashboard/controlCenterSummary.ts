import type { AppDb } from '../db';
import type { AppConfig } from '../types';
import { verifySafety } from '../verifySafety';
import { buildWatchOnlyReport } from '../watchOnly';
import { buildDailyReport } from '../paper/dailyReport';
import { buildRefreshCoverageSummary } from '../paper/refreshCoverageSummary';
import { buildShadowCandidateReport } from '../paper/shadowCandidateReport';
import { buildPaperReadinessReport } from '../paper/paperReadinessReport';
import { buildTinyPaperPlanReport } from '../paper/tinyPaperPlanReport';

const DEFAULT_SCAN_WINDOW_MINUTES = 60;
const COVERAGE_WINDOW_HOURS = 24;

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function topItems(items: string[], limit = 5): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildGuidance(input: {
  realTradingLocked: boolean;
  shadowMatches: number;
  paperReadinessVerdict: string;
  tinyPaperPlanAllowed: boolean;
  tinyPaperSampleBlocked: boolean;
  coverageHealthy: boolean;
}): { headline: string; bullets: string[] } {
  const bullets: string[] = [];
  if (input.realTradingLocked) bullets.push('System safe, research only.');
  if (input.shadowMatches === 0) bullets.push('No shadow matches right now.');
  if (input.paperReadinessVerdict === 'APPROACHING' || input.tinyPaperSampleBlocked) {
    bullets.push('Paper readiness is close, but sample size is too low.');
  }
  if (input.coverageHealthy) {
    bullets.push('Fresh capture coverage is healthy.');
  } else {
    bullets.push('Fresh capture coverage needs attention.');
  }
  return {
    headline: bullets[0] ?? 'Read-only operator dashboard.',
    bullets,
  };
}

export function buildControlCenterSummary(
  db: AppDb,
  config: AppConfig,
  options: { scanWindowMinutes?: number } = {}
): Record<string, unknown> {
  const generatedAt = new Date().toISOString();
  const scanWindowMinutes = options.scanWindowMinutes ?? DEFAULT_SCAN_WINDOW_MINUTES;
  const scanCutoff = new Date(Date.now() - scanWindowMinutes * 60_000).toISOString();
  const coverageSummary = buildRefreshCoverageSummary(db, config, { windowHours: COVERAGE_WINDOW_HOURS, limit: 200, top: 10 });
  const shadowReport = buildShadowCandidateReport(db, config, { hours: 24, limit: 50, top: 10 });
  const paperReadiness = buildPaperReadinessReport(db, config);
  const tinyPaperPlan = buildTinyPaperPlanReport(db, config, {
    windowHours: 24,
    limit: 200,
    maxPaperPositionUsd: 5,
    maxOpenPositions: 1,
    maxDailyPaperBuys: 1,
    minLiquidity: 50_000,
    maxSlippageBps: 200,
    minShadowSamples: 3,
    requireQuoteCheck: true,
  });
  const watchReport = buildWatchOnlyReport(db, config) as Record<string, unknown>;
  const dailyReport = buildDailyReport(db, config) as Record<string, unknown>;
  const safety = verifySafety(config) as Record<string, unknown>;

  const recentWatchRows = db.sqlite
    .prepare(
      `SELECT wc.created_at, t.source
       FROM watch_only_candidates wc
       JOIN tokens t ON t.id = wc.token_id
       WHERE wc.created_at >= ?
       ORDER BY wc.created_at DESC`
    )
    .all(new Date(Date.now() - 24 * 3_600_000).toISOString()) as Array<{ created_at: string; source: string }>;

  const recentOutcomeCount = (
    db.sqlite
      .prepare('SELECT COUNT(*) as n FROM watch_only_outcomes WHERE observed_at >= ?')
      .get(new Date(Date.now() - 24 * 3_600_000).toISOString()) as { n: number }
  ).n;

  const recentScans = db.sqlite
    .prepare('SELECT started_at, summary_json FROM run_logs WHERE run_type = ? AND started_at >= ? ORDER BY started_at DESC')
    .all('token:scan', scanCutoff) as Array<{ started_at: string; summary_json: string }>;

  const parsedScanSummaries = recentScans.map((row) => {
    try {
      return JSON.parse(row.summary_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  });

  const scannedAcceptedInWindow = parsedScanSummaries.reduce((sum, row) => sum + (safeNumber(row.scanned) ?? 0), 0);
  const scanSourceBreakdown = countBy(
    parsedScanSummaries.filter((row) => typeof row.source === 'string'),
    (row) => String(row.source)
  );

  const worstCovered = Array.isArray(coverageSummary.worstCandidates) ? coverageSummary.worstCandidates[0] ?? null : null;
  const topShadowRejectReasons = topItems(
    shadowReport.rejected.flatMap((row) => row.rejectReasons.map((reason) => reason.field)),
    5
  );
  const quoteGate = paperReadiness.gates.find((gate) => gate.id === 'G8') ?? null;
  const coverageHealthy = Boolean(
    (coverageSummary.coveragePct ?? 0) >= 70 &&
      (coverageSummary.missedWindows ?? 0) <= (coverageSummary.doneWindows ?? 0) &&
      ((coverageSummary.attemptStats?.no_data ?? 0) < 5)
  );

  const guidance = buildGuidance({
    realTradingLocked: Boolean(safety.realTradingLockedByDefault),
    shadowMatches: shadowReport.shadowMatches.length,
    paperReadinessVerdict: paperReadiness.verdict,
    tinyPaperPlanAllowed: tinyPaperPlan.planAllowed,
    tinyPaperSampleBlocked: tinyPaperPlan.shadowSampleBlocker,
    coverageHealthy,
  });

  return {
    generatedAt,
    readOnly: true,
    refreshSeconds: 15,
    systemSafety: {
      realTradingLock: Boolean(safety.realTradingLockedByDefault),
      autoPaperEnabled: Boolean(safety.autoPaperEnabled),
      paperBuysOpenedToday: safeNumber(dailyReport.paperBuysOpened) ?? 0,
      openPaperPositions: db.getOpenPositionCount('PAPER'),
      realTradeAttempts: safeNumber(dailyReport.blockedRealTradeAttempts) ?? 0,
      tokenSource: config.tokenSource,
      quoteCheckEnabled: Boolean(safety.quoteCheckEnabled),
      solanaSafetyEnrichmentEnabled: Boolean(safety.enrichmentEnabled),
      finalSafetyStatus: String(dailyReport.finalSafetyStatus ?? safety.finalSafetyStatus ?? 'Real trading remains locked.')
    },
    radarIntake: {
      totalWatchOnlyCandidates: safeNumber(watchReport.totalWatchOnlyCandidates) ?? 0,
      inWindowCandidates24h: safeNumber(coverageSummary.candidatesInWindow) ?? 0,
      newOrUpdatedRecentWindow: recentWatchRows.filter((row) => row.created_at >= scanCutoff).length,
      newOrUpdatedRecentWindowLabel: `Derived from watch_only_candidates.created_at in last ${scanWindowMinutes}m`,
      outcomesRecorded24h: recentOutcomeCount,
      signalClassCounts: watchReport.watchOnlySignalClassCounts ?? {
        EARLY_RUNNER: 0,
        LATE_RUNNER: 0,
        INSTANT_DUMP: 0,
        DEAD_NOISE: 0,
        TOO_DANGEROUS: 0,
      },
      latestWatchCycleIntake: 'Not yet wired (watch-cycle intake not persisted as a dedicated metric).',
      sourceBreakdown24h: countBy(recentWatchRows, (row) => row.source),
      recentScanRuns: recentScans.length,
      scannedAcceptedInLastWindow: scannedAcceptedInWindow,
      scanSourceBreakdownInLastWindow: scanSourceBreakdown,
    },
    freshCaptureCoverage: {
      coveragePct: safeNumber(coverageSummary.coveragePct),
      done: safeNumber(coverageSummary.doneWindows) ?? 0,
      due: safeNumber(coverageSummary.dueWindows) ?? 0,
      wait: safeNumber(coverageSummary.waitWindows) ?? 0,
      missed: safeNumber(coverageSummary.missedWindows) ?? 0,
      inWindowCandidateCount: safeNumber(coverageSummary.candidatesInWindow) ?? 0,
      topWorstCoveredCandidate: worstCovered
        ? {
            symbol: String(worstCovered.symbol ?? 'N/A'),
            doneCount: safeNumber(worstCovered.doneCount),
            dueCount: safeNumber(worstCovered.dueCount),
            waitCount: safeNumber(worstCovered.waitCount),
            missedCount: safeNumber(worstCovered.missedCount),
            source: String(worstCovered.source ?? 'N/A'),
          }
        : null,
      status: coverageHealthy ? 'GREEN' : (safeNumber(coverageSummary.missedWindows) ?? 0) > 0 || (safeNumber(coverageSummary.dueWindows) ?? 0) > 0 ? 'YELLOW' : 'RED',
      note: coverageHealthy ? 'Coverage healthy.' : 'Coverage has gaps or due windows.',
    },
    shadowResearchSignal: {
      shadowMatchCount: shadowReport.shadowMatches.length,
      watchMoreCount: shadowReport.watchMore.length,
      rejectCount: shadowReport.rejected.length,
      topRejectionReasons: topShadowRejectReasons,
      decisionNote:
        shadowReport.shadowMatches.length > 0
          ? 'Shadow matches exist for research review.'
          : shadowReport.watchMore.length > 0
            ? 'Some candidates need more observation.'
            : 'No current shadow matches.',
    },
    paperReadiness: {
      verdict: paperReadiness.verdict,
      gatesPassingCount: paperReadiness.passCount,
      totalGates: paperReadiness.gates.length,
      blockers: paperReadiness.gaps.slice(0, 5),
      warnings: paperReadiness.gates.filter((gate) => gate.result === 'WARN').map((gate) => `${gate.id} ${gate.label}`).slice(0, 5),
      quoteCheckBlocker: quoteGate && quoteGate.result !== 'PASS' ? quoteGate.note : null,
      verdictReason: paperReadiness.verdictReason,
    },
    tinyPaperPlan: {
      status: !tinyPaperPlan.planAllowed ? 'Plan not applicable yet' : tinyPaperPlan.shadowSampleBlocker ? 'Plan available but sample count still low' : 'Plan available',
      allTimeShadowPassCount: tinyPaperPlan.allTimeShadowPass,
      shadowPassWithForwardCaptureCount: tinyPaperPlan.allTimeShadowPassWithCapture,
      minimumSampleTarget: tinyPaperPlan.minShadowSamples,
      maxPaperPositionUsd: tinyPaperPlan.maxPaperPositionUsd,
      maxOpenPositions: tinyPaperPlan.maxOpenPositions,
      maxDailyPaperBuys: tinyPaperPlan.maxDailyPaperBuys,
    },
    movers: {
      bestCurrentMover: watchReport.bestMover ?? 'N/A',
      worstCurrentMover: watchReport.worstMover ?? 'N/A',
    },
    operatorGuidance: guidance,
    naMetrics: [
      'Latest watch-cycle intake as a dedicated persisted metric: Not yet wired.',
    ],
  };
}
