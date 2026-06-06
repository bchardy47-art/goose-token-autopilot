import fs from 'node:fs';
import { loadConfig } from './config';
import { createDb } from './db';
import { runScan } from './scanner';
import { scoreAllTokens } from './scoring/scoreToken';
import { buildReport, formatReport } from './report';
import { createTopProposal } from './proposals/createProposal';
import { paperBuy, paperSell, getPositionsSummary } from './trading/paper';
import { verifySafety } from './verifySafety';
import { activateKillSwitch } from './kill';
import { runAutopilot } from './autopilot/runAutopilot';
import { buildPaperEligibilityDiagnostics, runAutoPaper } from './paper/autoPaper';
import { renderFreshCandidateWatchlist } from './paper/freshWatchlist';
import { renderFreshRejectionAnalytics } from './paper/freshRejections';
import { renderTooEarlyWatchReport } from './paper/tooEarlyWatch';
import { renderTokenSessionSummary } from './paper/sessionSummary';
import { renderNearMissShadowReport } from './paper/nearMiss';
import { renderWinnerStudyReport } from './paper/studyWinners';
import { renderWinnerProfileReport } from './paper/winnerProfile';
import { renderEarlySignalFilterReport } from './paper/earlySignalFilter';
import { renderProfileMatchOutcomesReport } from './paper/profileMatchOutcomes';
import { renderDumpRiskProfileReport } from './paper/dumpRiskProfile';
import { renderDumpRiskForwardValidationReport } from './paper/dumpRiskForwardValidation';
import { renderDumpRiskSubtypesReport } from './paper/dumpRiskSubtypes';
import { renderDecayRateReport } from './paper/decayRate';
import { buildEarlyRefreshPlan, renderEarlyRefreshPlan } from './paper/earlyRefreshPlan';
import { buildScanRejectionReport, renderScanRejectionReport } from './paper/scanRejectionReport';
import { runWatchRefresh, renderWatchRefreshReport } from './paper/watchRefresh';
import { runPaperReview, runPaperReviewLoop, type PaperReviewLoopCycleSummary } from './paper/review';
import { buildPaperPerformanceReport } from './paper/performance';
import { buildDailyReport, renderPaperAutopsy, renderPaperDashboard } from './paper/dailyReport';
import { buildWatchOnlyReport, renderWatchAutopsy, runWatchOnly } from './watchOnly';
import { runWatchOutcomes } from './watchOutcomes';
import { runWatchAnalysis } from './watchAnalysis';
import { runWatchCycle, runWatchLoop } from './watchLoop';
import { buildSignalAuditReport, renderSignalAudit } from './signalAudit';
import { buildSignalCompareReport, renderSignalCompare } from './signalCompare';
import { runSafetyEnrich } from './safetyEnrich';
import { buildSafetyEnrichDebugReport, renderSafetyEnrichDebug } from './safetyEnrichDebug';
import { buildSafetyRpcProofReport, renderSafetyRpcProof } from './safetyRpcProof';
import { runQuoteCheck } from './quoteCheck';
import { renderHistoricalWinnerAutopsy } from './paper/historicalWinnerAutopsy';
import { buildShadowCandidateReport, renderShadowCandidateReport } from './paper/shadowCandidateReport';
import { runEarlyRefreshLoop, renderEarlyRefreshLoopResult } from './paper/earlyRefreshLoop';
import { buildRefreshCoverageSummary, renderRefreshCoverageSummary } from './paper/refreshCoverageSummary';
import { runFreshCaptureSession, renderFreshCaptureSessionResult } from './paper/freshCaptureSession';
import { buildRejectedRunnerAutopsy, renderRejectedRunnerAutopsy } from './paper/rejectedRunnerAutopsy';
import { buildChaseWatchReport, renderChaseWatchReport } from './paper/chaseWatchReport';
import { buildPaperReadinessReport, renderPaperReadinessReport } from './paper/paperReadinessReport';
import { buildTinyPaperPlanReport, renderTinyPaperPlanReport } from './paper/tinyPaperPlanReport';
import { startControlCenterServer } from './dashboard/controlCenterServer';
import { buildXEarsReport, renderXEarsReport, type SocialPost, type XEarsSourceMode } from './social/xEarsAnalyzer';
import { loadTokenGrabFixtures } from './token-grab/fixtures';
import { buildTokenGrabReport, renderTokenGrabReport } from './token-grab/report';
import { mapXEarsReportToSocialSignals } from './token-grab/xEarsAdapter';
import { loadFreshPoolsFromFile, loadEventSignalsFromFile } from './token-grab/loaders';
import { fetchGeckoFreshPools, dedupeFreshPools } from './token-grab/geckoFreshPools';
import { buildTokenGrabAutopsyReport, renderTokenGrabAutopsyReport } from './token-grab/autopsy';
import { buildBadRejectReview, renderBadRejectReview } from './token-grab/badRejectReview';
import { loadAutopsyCandidatesFromFile, loadAutopsySnapshotsFromFile, loadAutopsySnapshotsFromFiles } from './token-grab/autopsyLoaders';
import {
  tokenGrabReportToAutopsyCandidates,
  saveTokenGrabSession,
  loadTokenGrabSession,
  type TokenGrabSessionFile,
} from './token-grab/sessionCapture';
import { fetchSessionSnapshots, writeSnapshotFile } from './token-grab/snapshot';

function getArgValue(flag: string): string | undefined {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === flag) return process.argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function getArgValues(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === flag && process.argv[i + 1] !== undefined) {
      values.push(process.argv[i + 1]!);
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}

function parseNumberArg(flag: string, fallback: number, options: { integer?: boolean; min?: number } = {}): number {
  const raw = getArgValue(flag);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${flag} must be a valid number`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${flag} must be an integer`);
  }
  if (options.min != null && value < options.min) {
    throw new Error(`${flag} must be >= ${options.min}`);
  }
  return value;
}

function printPaperReviewLoopCycleSummary(summary: PaperReviewLoopCycleSummary): void {
  console.log(
    `[paper-review-loop] cycle ${summary.cycleNumber}: reviewed=${summary.reviewedCount} refreshed=${summary.refreshedCount} remainingOpen=${summary.remainingOpenCount}`
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config);
  const command = process.argv[2];

  try {
    switch (command) {
      case 'token:scan':
        console.log(JSON.stringify(await runScan(db, config), null, 2));
        break;
      case 'token:score':
        console.log(JSON.stringify(scoreAllTokens(db, config), null, 2));
        break;
      case 'token:report':
        console.log(formatReport(buildReport(db, config), config));
        break;
      case 'token:propose':
        console.log(JSON.stringify(createTopProposal(db, config), null, 2));
        break;
      case 'token:paper-buy': {
        const proposalId = getArgValue('--proposal-id');
        const mint = getArgValue('--mint');
        console.log(JSON.stringify(paperBuy(db, config, { proposalId: proposalId ? Number(proposalId) : undefined, mint }), null, 2));
        break;
      }
      case 'token:paper-sell': {
        const positionId = getArgValue('--position-id');
        const mint = getArgValue('--mint');
        console.log(JSON.stringify(paperSell(db, { positionId: positionId ? Number(positionId) : undefined, mint }), null, 2));
        break;
      }
      case 'token:positions':
        console.log(JSON.stringify(getPositionsSummary(db), null, 2));
        break;
      case 'token:auto-paper':
        console.log(JSON.stringify(await runAutoPaper(db, config), null, 2));
        break;
      case 'token:paper-eligibility':
        console.log(JSON.stringify(buildPaperEligibilityDiagnostics(db, config), null, 2));
        break;
      case 'token:fresh-watchlist': {
        const maxAgeMinutes = parseNumberArg('--max-age-minutes', 30, { min: 0 });
        const limit = parseNumberArg('--limit', 10, { integer: true, min: 1 });
        console.log(renderFreshCandidateWatchlist(db, config, { maxAgeMinutes, limit }));
        break;
      }
      case 'token:fresh-rejections': {
        const maxAgeMinutes = parseNumberArg('--max-age-minutes', 60, { min: 0 });
        const limit = parseNumberArg('--limit', 5, { integer: true, min: 1 });
        console.log(renderFreshRejectionAnalytics(db, config, { maxAgeMinutes, limit }));
        break;
      }
      case 'token:too-early-watch': {
        const maxAgeMinutes = parseNumberArg('--max-age-minutes', 15, { min: 0 });
        const limit = parseNumberArg('--limit', 10, { integer: true, min: 1 });
        console.log(renderTooEarlyWatchReport(db, config, { maxAgeMinutes, limit }));
        break;
      }
      case 'token:session-summary': {
        const windowMinutes = parseNumberArg('--window-minutes', 60, { min: 0 });
        console.log(renderTokenSessionSummary(db, config, { windowMinutes }));
        break;
      }
      case 'token:near-miss': {
        const windowMinutes = parseNumberArg('--window-minutes', 60, { min: 0 });
        console.log(renderNearMissShadowReport(db, config, { windowMinutes }));
        break;
      }
      case 'token:study-winners':
        console.log(renderWinnerStudyReport(db, config));
        break;
      case 'token:winner-profile': {
        const minGain = parseNumberArg('--min-gain', 50, { min: 0 });
        const topN = parseNumberArg('--top', 10, { integer: true, min: 1 });
        console.log(renderWinnerProfileReport(db, config, { minGainPct: minGain, top: topN }));
        break;
      }
      case 'token:early-signal-filter': {
        const limit = parseNumberArg('--limit', 25, { integer: true, min: 1 });
        const windowHours = parseNumberArg('--window-hours', 72, { min: 0 });
        const minBsr = parseNumberArg('--min-bsr', 1.5, { min: 0 });
        const maxMoved = parseNumberArg('--max-moved', 100, { min: 0 });
        const minPc5m = parseNumberArg('--min-pc5m', 40, { min: 0 });
        console.log(renderEarlySignalFilterReport(db, config, { limit, windowHours, minBsr, maxMoved, minPc5m }));
        break;
      }
      case 'token:dump-risk-profile': {
        const limit = parseNumberArg('--limit', 121, { integer: true, min: 1 });
        const top = parseNumberArg('--top', 10, { integer: true, min: 1 });
        const minGain = parseNumberArg('--min-gain', 50, { min: 0 });
        console.log(renderDumpRiskProfileReport(db, config, { limit, top, minGain }));
        break;
      }
      case 'token:decay-rate': {
        const limit = parseNumberArg('--limit', 121, { integer: true, min: 1 });
        const top = parseNumberArg('--top', 10, { integer: true, min: 1 });
        console.log(renderDecayRateReport(db, config, { limit, top }));
        break;
      }
      case 'token:scan-rejection-report': {
        const hours = parseNumberArg('--hours', 6, { min: 0 });
        const limit = parseNumberArg('--limit', 50, { integer: true, min: 1 });
        const top = parseNumberArg('--top', 20, { integer: true, min: 1 });
        console.log(renderScanRejectionReport(buildScanRejectionReport(db, config, { hours, limit, top })));
        break;
      }
      case 'token:early-refresh-plan': {
        const windowHours = parseNumberArg('--window-hours', 2, { min: 0 });
        const limit = parseNumberArg('--limit', 10, { integer: true, min: 1 });
        const top = parseNumberArg('--top', 10, { integer: true, min: 1 });
        const doRun = process.argv.includes('--run');
        const sep = '─'.repeat(60);

        const plan = buildEarlyRefreshPlan(db, config, { windowHours, limit, top });
        console.log(renderEarlyRefreshPlan(plan));

        if (doRun) {
          console.log(sep);
          console.log('Bounded Fallback Refresh [--run]');
          console.log(sep);
          console.log('Note: precise due-window targeting is not available; refreshing bounded recent pool.');
          console.log(`Window: last ${windowHours}h | Limit: ${limit}`);
          console.log('');
          const refreshReport = await runWatchRefresh(db, config, { limit, windowHours, dryRun: false });
          console.log(renderWatchRefreshReport(refreshReport));
          console.log('');
          console.log(sep);
          console.log('Run Safety');
          console.log(sep);
          console.log('  One-shot manual run. No daemon. No schedule.');
          console.log('  No trading behavior changed.');
          console.log('  Real trading remains locked.');
        }
        break;
      }
      case 'token:dump-risk-subtypes': {
        const limit = parseNumberArg('--limit', 121, { integer: true, min: 1 });
        const windowHours = parseNumberArg('--window-hours', 72, { min: 0 });
        const minBsr = parseNumberArg('--min-bsr', 1.5, { min: 0 });
        const maxMoved = parseNumberArg('--max-moved', 100, { min: 0 });
        const minPc5m = parseNumberArg('--min-pc5m', 40, { min: 0 });
        const top = parseNumberArg('--top', 10, { integer: true, min: 1 });
        console.log(renderDumpRiskSubtypesReport(db, config, { limit, windowHours, minBsr, maxMoved, minPc5m, top }));
        break;
      }
      case 'token:dump-risk-forward-validation': {
        const limit = parseNumberArg('--limit', 121, { integer: true, min: 1 });
        const windowHours = parseNumberArg('--window-hours', 72, { min: 0 });
        const minBsr = parseNumberArg('--min-bsr', 1.5, { min: 0 });
        const maxMoved = parseNumberArg('--max-moved', 100, { min: 0 });
        const minPc5m = parseNumberArg('--min-pc5m', 40, { min: 0 });
        const top = parseNumberArg('--top', 10, { integer: true, min: 1 });
        console.log(renderDumpRiskForwardValidationReport(db, config, { limit, windowHours, minBsr, maxMoved, minPc5m, top }));
        break;
      }
      case 'token:profile-match-outcomes': {
        const limit = parseNumberArg('--limit', 121, { integer: true, min: 1 });
        const windowHours = parseNumberArg('--window-hours', 72, { min: 0 });
        const minBsr = parseNumberArg('--min-bsr', 1.5, { min: 0 });
        const maxMoved = parseNumberArg('--max-moved', 100, { min: 0 });
        const minPc5m = parseNumberArg('--min-pc5m', 40, { min: 0 });
        console.log(renderProfileMatchOutcomesReport(db, config, { limit, windowHours, minBsr, maxMoved, minPc5m }));
        break;
      }
      case 'token:watch-refresh': {
        const limit = parseNumberArg('--limit', 25, { integer: true, min: 1 });
        const windowHours = parseNumberArg('--window-hours', 24, { min: 0 });
        const dryRun = process.argv.includes('--dry-run');
        console.log(renderWatchRefreshReport(await runWatchRefresh(db, config, { limit, windowHours, dryRun })));
        break;
      }
      case 'token:paper-review':
        console.log(JSON.stringify(await runPaperReview(db, config), null, 2));
        break;
      case 'token:paper-review-loop': {
        const intervalSeconds = parseNumberArg('--interval-seconds', 60, { min: 0 });
        const maxCycles = parseNumberArg('--max-cycles', 30, { integer: true, min: 0 });
        const result = await runPaperReviewLoop(db, config, {
          intervalMs: intervalSeconds * 1000,
          maxCycles,
          onCycle: printPaperReviewLoopCycleSummary
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'token:paper-performance':
        console.log(JSON.stringify(buildPaperPerformanceReport(db), null, 2));
        break;
      case 'token:paper-dashboard':
        console.log(renderPaperDashboard(db, config));
        break;
      case 'token:paper-autopsy':
        console.log(renderPaperAutopsy(db, config));
        break;
      case 'token:daily-report':
        console.log(JSON.stringify(buildDailyReport(db, config), null, 2));
        break;
      case 'token:watch-only':
        console.log(JSON.stringify(await runWatchOnly(db, config), null, 2));
        break;
      case 'token:watch-outcomes':
        console.log(JSON.stringify(await runWatchOutcomes(db, config), null, 2));
        break;
      case 'token:watch-analysis':
        console.log(JSON.stringify(await runWatchAnalysis(db, config), null, 2));
        break;
      case 'token:watch-cycle':
        console.log(JSON.stringify(await runWatchCycle(db, config), null, 2));
        break;
      case 'token:watch-loop':
        console.log(JSON.stringify(await runWatchLoop(db, config), null, 2));
        break;
      case 'token:signal-audit':
        console.log(renderSignalAudit(buildSignalAuditReport(db, config), process.env));
        break;
      case 'token:signal-compare':
        console.log(renderSignalCompare(buildSignalCompareReport(db, config), process.env));
        break;
      case 'token:safety-enrich':
        console.log(JSON.stringify(await runSafetyEnrich(db, config), null, 2));
        break;
      case 'token:safety-enrich-debug':
        console.log(renderSafetyEnrichDebug(await buildSafetyEnrichDebugReport(db, config, process.env), process.env));
        break;
      case 'token:safety-rpc-proof':
        console.log(renderSafetyRpcProof(await buildSafetyRpcProofReport(db, config, process.env), process.env));
        break;
      case 'token:quote-check':
        console.log(JSON.stringify(await runQuoteCheck(db, config), null, 2));
        break;
      case 'token:watch-report':
        console.log(JSON.stringify(buildWatchOnlyReport(db, config), null, 2));
        break;
      case 'token:watch-autopsy':
        console.log(renderWatchAutopsy(db, config));
        break;
      case 'token:verify-safety':
        console.log(JSON.stringify(verifySafety(config), null, 2));
        break;
      case 'token:kill':
        console.log(JSON.stringify(activateKillSwitch(config), null, 2));
        break;
      case 'token:autopilot':
        console.log(JSON.stringify(await runAutopilot(db, config), null, 2));
        break;
      case 'token:early-refresh-loop': {
        const windowHours = parseNumberArg('--window-hours', 6, { min: 0 });
        const limit = parseNumberArg('--limit', 20, { integer: true, min: 1 });
        const cycles = parseNumberArg('--cycles', 4, { integer: true, min: 1 });
        const intervalMinutes = parseNumberArg('--interval-minutes', 15, { min: 0 });
        const dryRun = process.argv.includes('--dry-run');
        const result = await runEarlyRefreshLoop(db, config, {
          windowHours,
          limit,
          maxCycles: cycles,
          intervalMs: intervalMinutes * 60_000,
          dryRun,
          onCycle: (s) => {
            console.log(
              `[early-refresh-loop] cycle ${s.cycleNumber}: due=${s.dueWindows} refreshRan=${s.refreshRan} snapshots=${s.snapshotsInserted}`
            );
          },
        });
        console.log(renderEarlyRefreshLoopResult(result));
        break;
      }
      case 'token:shadow-candidate-report': {
        const hours = parseNumberArg('--hours', 6, { min: 0 });
        const limit = parseNumberArg('--limit', 50, { integer: true, min: 1 });
        const top = parseNumberArg('--top', 20, { integer: true, min: 1 });
        const minLiquidity = parseNumberArg('--min-liquidity', 50_000, { min: 0 });
        const maxMoved = parseNumberArg('--max-moved', 25, { min: 0 });
        const minBsr = parseNumberArg('--min-bsr', 2.0, { min: 0 });
        const minPc5m = parseNumberArg('--min-pc5m', 3, { min: 0 });
        const maxPc5m = parseNumberArg('--max-pc5m', 75, { min: 0 });
        const maxSlippageBps = parseNumberArg('--max-slippage-bps', 200, { min: 0 });
        console.log(
          renderShadowCandidateReport(
            buildShadowCandidateReport(db, config, {
              hours, limit, top, minLiquidity, maxMoved, minBsr, minPc5m, maxPc5m, maxSlippageBps,
            })
          )
        );
        break;
      }
      case 'token:historical-winner-autopsy': {
        const minGain = parseNumberArg('--min-gain', 100, { min: 0 });
        const limit = parseNumberArg('--limit', 50, { integer: true, min: 1 });
        const top = parseNumberArg('--top', 20, { integer: true, min: 1 });
        console.log(renderHistoricalWinnerAutopsy(db, config, { minGain, limit, top }));
        break;
      }
      case 'token:refresh-coverage-summary': {
        const windowHours = parseNumberArg('--window-hours', 24, { min: 0 });
        const limit = parseNumberArg('--limit', 200, { integer: true, min: 1 });
        const top = parseNumberArg('--top', 20, { integer: true, min: 1 });
        console.log(renderRefreshCoverageSummary(buildRefreshCoverageSummary(db, config, { windowHours, limit, top })));
        break;
      }
      case 'token:fresh-capture-session': {
        const windowHours = parseNumberArg('--window-hours', 6, { min: 0 });
        const limit = parseNumberArg('--limit', 20, { integer: true, min: 1 });
        const cycles = parseNumberArg('--cycles', 4, { integer: true, min: 1 });
        const intervalMinutes = parseNumberArg('--interval-minutes', 15, { min: 0 });
        const dryRun = process.argv.includes('--dry-run');
        const skipWatchCycle = process.argv.includes('--skip-watch-cycle');
        const result = await runFreshCaptureSession(db, config, {
          windowHours,
          limit,
          cycles,
          intervalMs: intervalMinutes * 60_000,
          dryRun,
          skipWatchCycle,
          onPhase: (phase) => console.log(`[fresh-capture-session] ${phase}`),
        });
        console.log(renderFreshCaptureSessionResult(result));
        break;
      }
      case 'token:rejected-runner-autopsy': {
        const minGain = parseNumberArg('--min-gain', 50, { min: 0 });
        const windowHours = parseNumberArg('--window-hours', 24, { min: 0 });
        const limit = parseNumberArg('--limit', 200, { integer: true, min: 1 });
        const minLiquidity = parseNumberArg('--min-liquidity', 50_000, { min: 0 });
        const maxMoved = parseNumberArg('--max-moved', 25, { min: 0 });
        const minBsr = parseNumberArg('--min-bsr', 2.0, { min: 0 });
        const minPc5m = parseNumberArg('--min-pc5m', 3, { min: 0 });
        const maxPc5m = parseNumberArg('--max-pc5m', 75, { min: 0 });
        const maxSlippageBps = parseNumberArg('--max-slippage-bps', 200, { min: 0 });
        console.log(
          renderRejectedRunnerAutopsy(
            buildRejectedRunnerAutopsy(db, config, {
              minGain, windowHours, limit,
              minLiquidity, maxMoved, minBsr, minPc5m, maxPc5m, maxSlippageBps,
            })
          )
        );
        break;
      }
      case 'token:chase-watch-report': {
        const windowHours = parseNumberArg('--window-hours', 24, { min: 0 });
        const limit = parseNumberArg('--limit', 200, { integer: true, min: 1 });
        const minGain = parseNumberArg('--min-gain', 30, { min: 0 });
        const chaseMovedPct = parseNumberArg('--chase-moved-pct', 25, { min: 0 });
        const chasePc5mPct = parseNumberArg('--chase-pc5m-pct', 75, { min: 0 });
        console.log(
          renderChaseWatchReport(
            buildChaseWatchReport(db, config, {
              windowHours, limit, minGain, chaseMovedPct, chasePc5mPct,
            })
          )
        );
        break;
      }
      case 'token:paper-readiness-report': {
        console.log(renderPaperReadinessReport(buildPaperReadinessReport(db, config)));
        break;
      }
      case 'token:tiny-paper-plan-report': {
        const windowHours = parseNumberArg('--window-hours', 24, { min: 0 });
        const limit = parseNumberArg('--limit', 200, { integer: true, min: 1 });
        const maxPaperPositionUsd = parseNumberArg('--max-paper-position-usd', 5, { min: 0 });
        const maxOpenPositions = parseNumberArg('--max-open-positions', 1, { integer: true, min: 1 });
        const maxDailyPaperBuys = parseNumberArg('--max-daily-paper-buys', 1, { integer: true, min: 1 });
        const minLiquidity = parseNumberArg('--min-liquidity', 50_000, { min: 0 });
        const maxSlippageBps = parseNumberArg('--max-slippage-bps', 200, { min: 0 });
        const minShadowSamples = parseNumberArg('--min-shadow-samples', 3, { integer: true, min: 0 });
        const requireQuoteCheck = !process.argv.includes('--no-require-quote-check');
        console.log(
          renderTinyPaperPlanReport(
            buildTinyPaperPlanReport(db, config, {
              windowHours, limit, maxPaperPositionUsd, maxOpenPositions,
              maxDailyPaperBuys, minLiquidity, maxSlippageBps,
              minShadowSamples, requireQuoteCheck,
            })
          )
        );
        break;
      }
      case 'token:x-ears-report': {
        const limit = parseNumberArg('--limit', 50, { integer: true, min: 1 });
        const windowMinutes = parseNumberArg('--window-minutes', 90, { min: 1 });
        const fixturePath = getArgValue('--fixture');
        const jsonMode = process.argv.includes('--json');

        let posts: SocialPost[] = [];
        let sourceMode: XEarsSourceMode = 'api_unavailable';

        if (fixturePath) {
          const raw = fs.readFileSync(fixturePath, 'utf-8');
          posts = JSON.parse(raw) as SocialPost[];
          sourceMode = 'fixture';
        } else if (process.env.X_BEARER_TOKEN) {
          console.error('[x-ears] X_BEARER_TOKEN detected but live API is not implemented in V1.');
          console.error('[x-ears] Use --fixture=<path> to test with local sample data.');
        }

        const slicedPosts = posts.slice(0, limit);
        const report = buildXEarsReport(slicedPosts, { windowMinutes, sourceMode });

        if (jsonMode) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(renderXEarsReport(report));
        }
        break;
      }
      case 'token:control-center': {
        const port = parseNumberArg('--port', 3030, { integer: true, min: 1 });
        const server = await startControlCenterServer(db, config, { port });
        console.log(`Control Center running at http://127.0.0.1:${port}`);
        console.log('Read-only dashboard. Press Ctrl+C to stop.');
        await new Promise<void>((resolve) => {
          const shutdown = () => {
            server.close(() => resolve());
          };
          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);
        });
        break;
      }
      case 'token:ears-report': {
        const limit = parseNumberArg('--limit', 50, { integer: true, min: 1 });
        const windowMinutes = parseNumberArg('--window-minutes', 90, { min: 1 });
        const fixturePath = getArgValue('--fixture');
        const freshPoolsPath = getArgValue('--fresh-pools');
        const eventsPath = getArgValue('--events');
        const useGecko = process.argv.includes('--gecko-fresh-pools');
        const geckoLimit = parseNumberArg('--gecko-limit', 20, { integer: true, min: 1 });
        const geckoTimeoutMs = parseNumberArg('--gecko-timeout-ms', 10_000, { integer: true, min: 500 });
        const jsonMode = process.argv.includes('--json');
        const saveSessionPath = getArgValue('--save-session');

        let xSocialSignals: ReturnType<typeof mapXEarsReportToSocialSignals> = [];

        if (fixturePath) {
          const raw = fs.readFileSync(fixturePath, 'utf-8');
          const posts = JSON.parse(raw) as SocialPost[];
          const xReport = buildXEarsReport(posts.slice(0, limit), { windowMinutes, sourceMode: 'fixture' });
          xSocialSignals = mapXEarsReportToSocialSignals(xReport);
        } else if (process.env.X_BEARER_TOKEN) {
          console.error('[ears-report] Live X API not implemented in V1. Use --fixture <path>.');
        }

        const localPools = freshPoolsPath ? loadFreshPoolsFromFile(freshPoolsPath) : [];
        const geckoPools = useGecko
          ? await fetchGeckoFreshPools({ limit: geckoLimit, timeoutMs: geckoTimeoutMs })
          : [];
        const freshPools = dedupeFreshPools([...localPools, ...geckoPools]);
        const eventSignals = eventsPath ? loadEventSignalsFromFile(eventsPath) : [];

        const report = buildTokenGrabReport({
          socialSignals: xSocialSignals,
          eventSignals,
          freshPools,
        });

        if (saveSessionPath) {
          const freshPoolsSource =
            useGecko && freshPoolsPath ? 'mixed' :
            useGecko ? 'geckoterminal' :
            freshPoolsPath ? 'local' : 'none';
          const sessionFlags: TokenGrabSessionFile['flags'] = {
            geckoFreshPools: useGecko,
          };
          if (useGecko) sessionFlags.geckoLimit = geckoLimit;
          if (freshPoolsPath) sessionFlags.freshPoolsPath = freshPoolsPath;
          if (eventsPath) sessionFlags.eventsPath = eventsPath;
          if (fixturePath) sessionFlags.fixturePath = fixturePath;
          const session: TokenGrabSessionFile = {
            schema: 'token-grab-session-v1',
            generatedAt: report.generatedAt,
            source: {
              social: fixturePath ? 'fixture' : process.env.X_BEARER_TOKEN ? 'x-ears' : 'none',
              freshPools: freshPoolsSource,
              events: eventsPath ? 'local' : 'none',
            },
            flags: sessionFlags,
            summary: report.summary,
            candidates: tokenGrabReportToAutopsyCandidates(report),
            safety: {
              reportOnly: true,
              noTradingExecuted: true,
              tradingExecuted: 0,
              dbWrites: false,
              scheduler: false,
            },
          };
          saveTokenGrabSession(saveSessionPath, session);
          console.log(`Saved Token Grab session: ${saveSessionPath}`);
        }

        if (jsonMode) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(renderTokenGrabReport(report));
        }
        break;
      }
      case 'token:ears-autopsy': {
        const sessionPath = getArgValue('--session');
        const snapshotPathArgs = getArgValues('--snapshots');
        const resolvedSnapshotPaths = snapshotPathArgs.length > 0
          ? snapshotPathArgs
          : ['fixtures/token-grab/autopsy-snapshots.json'];
        const jsonMode = process.argv.includes('--json');

        let autopsyCandidates: ReturnType<typeof loadAutopsyCandidatesFromFile>;
        let sessionMeta: TokenGrabSessionFile | undefined;

        if (sessionPath) {
          const session = loadTokenGrabSession(sessionPath);
          autopsyCandidates = session.candidates;
          sessionMeta = session;
        } else {
          const candidatesPath = getArgValue('--candidates') ?? 'fixtures/token-grab/autopsy-candidates.json';
          autopsyCandidates = loadAutopsyCandidatesFromFile(candidatesPath);
        }

        const snapshots = loadAutopsySnapshotsFromFiles(resolvedSnapshotPaths);
        const autopsyMode = sessionPath ? 'session-file' as const : 'fixture-only' as const;
        const report = buildTokenGrabAutopsyReport(autopsyCandidates, snapshots, { mode: autopsyMode });

        if (jsonMode) {
          if (sessionMeta) {
            console.log(JSON.stringify({
              ...report,
              sessionSource: sessionMeta.source,
              sessionFlags: sessionMeta.flags,
              sessionGeneratedAt: sessionMeta.generatedAt,
            }, null, 2));
          } else {
            console.log(JSON.stringify(report, null, 2));
          }
        } else {
          console.log(renderTokenGrabAutopsyReport(report));
        }
        break;
      }
      case 'token:ears-demo': {
        const jsonMode = process.argv.includes('--json');
        const fixturesPath = getArgValue('--fixtures-dir');
        const fixtures = loadTokenGrabFixtures(fixturesPath);
        const report = buildTokenGrabReport(fixtures);
        if (jsonMode) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(renderTokenGrabReport(report));
        }
        break;
      }
      case 'token:bad-reject-review': {
        const sessionPath = getArgValue('--session');
        if (!sessionPath) throw new Error('token:bad-reject-review requires --session <path>');

        const snapshotPaths = getArgValues('--snapshots');
        const resolvedSnapshotPaths = snapshotPaths.length > 0
          ? snapshotPaths
          : ['fixtures/token-grab/autopsy-snapshots.json'];

        const jsonMode = process.argv.includes('--json');

        const session = loadTokenGrabSession(sessionPath);
        const snapshots = loadAutopsySnapshotsFromFiles(resolvedSnapshotPaths);
        const autopsyReport = buildTokenGrabAutopsyReport(session.candidates, snapshots, { mode: 'session-file' });
        const review = buildBadRejectReview(session.candidates, snapshots, autopsyReport.results);

        if (jsonMode) {
          console.log(JSON.stringify(review, null, 2));
        } else {
          console.log(renderBadRejectReview(review));
        }
        break;
      }
      case 'token:ears-snapshot': {
        const sessionPath = getArgValue('--session');
        const outPath = getArgValue('--out');

        if (!sessionPath) throw new Error('token:ears-snapshot requires --session <path>');
        if (!outPath) throw new Error('token:ears-snapshot requires --out <path>');

        const startAt = parseNumberArg('--start-at', 0, { integer: true, min: 0 });
        const limit = parseNumberArg('--limit', 20, { integer: true, min: 1 });
        const delayMs = parseNumberArg('--delay-ms', 0, { integer: true, min: 0 });
        const timeoutMs = parseNumberArg('--timeout-ms', 10_000, { integer: true, min: 500 });

        const session = loadTokenGrabSession(sessionPath);
        const candidatesAttempted = Math.min(
          session.candidates.length - startAt,
          limit,
        );

        console.log(`Session   : ${sessionPath}`);
        console.log(`Output    : ${outPath}`);
        console.log(`Candidates: ${session.candidates.length} loaded, starting at ${startAt}, limit ${limit}`);
        if (delayMs > 0) {
          console.log(`Delay     : ${delayMs}ms between requests`);
        }
        console.log('Fetching snapshots from GeckoTerminal...');
        console.log('');

        const result = await fetchSessionSnapshots({
          candidates: session.candidates,
          startAt,
          limit,
          delayMs,
          timeoutMs,
        });

        writeSnapshotFile(outPath, result.snapshots);

        const THIN = '─'.repeat(50);
        console.log(THIN);
        console.log(`Session              : ${sessionPath}`);
        console.log(`Output               : ${outPath}`);
        console.log(`Candidates loaded    : ${session.candidates.length}`);
        console.log(`Start at             : ${startAt}`);
        console.log(`Limit                : ${limit}`);
        console.log(`Candidates attempted : ${candidatesAttempted}`);
        console.log(`Snapshots written    : ${result.snapshots.length}`);
        console.log(`Skipped / failed     : ${result.skipped}`);
        if (result.skipReasons.length > 0) {
          for (const s of result.skipReasons) {
            console.log(`  ! ${s.ticker} (${s.candidateId}): ${s.reason}`);
          }
        }
        console.log('');
        console.log('NO TRADING EXECUTED');
        console.log(THIN);
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
