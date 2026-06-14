import fs from 'node:fs';
import path from 'node:path';
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
import { fetchSessionSnapshots, writeSnapshotFile, sleep } from './token-grab/snapshot';
import {
  selectWatchCandidates,
  renderWatchSnapshotSummary,
  type WatchSnapshotSummary,
} from './token-grab/watchSnapshot';
import {
  chooseLiveAssistedCandidate,
  isFakeBuyEligible,
  calculateFakePosition,
  calculateFakePnL,
  buildLiveAssistedSummary,
  renderLiveAssistedReport,
  type FakeBuyRecord,
  type LiveAssistedPnL,
} from './token-grab/liveAssistedWatch';
import {
  assertMaxLivePosition,
  getRequiredConfirmationPhrase,
  parseLiveUnlockEnv,
  buildLiveTradePlan,
  evaluateLiveReadinessGates,
  evaluateEntryConfirmation,
  renderLiveHarnessReport,
  updatePaperExitState,
  evaluatePaperExitGuard,
  type LiveTradePlan,
  type LiveHarnessSummary,
  type EntryConfirmationResult,
  type PaperExitGuardSummary,
  type PaperExitState,
  type PaperExitReason,
} from './token-grab/liveHarness';
import readline from 'node:readline';
import { buildFieldRunSummary, renderFieldRunSummary } from './token-grab/fieldSummary';
import {
  buildPreSignalReport,
  renderPreSignalReport,
  buildPreSignalBridge,
  loadPreSignals,
  type PreSignalBridgeSummary,
  type PreSignal,
  type PreSignalSource,
} from './token-grab/xEarsPreSignal';
import {
  buildEarsCollectorReport,
  renderEarsCollectorReport,
} from './token-grab/earsCollector';
import { runWatchCycle, renderWatchCycleReport } from './token-grab/earsWatcher';
import {
  loadRssConfig,
  fetchFeedItems,
  buildRssAdapterReport,
  renderRssAdapterReport,
  type FeedResult,
} from './token-grab/rssEarsAdapter';
import {
  parseSourceFile,
  buildEarsIngestReport,
  renderEarsIngestReport,
} from './token-grab/earsIngest';
import {
  loadAutomatedEarsConfig,
  buildRssConnectorResult,
  runXConnector,
  runTelegramConnector,
  runDiscordConnector,
  buildAutomatedEarsReport,
  renderAutomatedEarsReport,
  type ConnectorResult,
} from './token-grab/automatedEars';
import {
  loadDexEarsConfig,
  fetchLatestProfiles,
  fetchLatestBoosts,
  fetchTopBoosts,
  buildDexEarsReport,
  renderDexEarsReport,
} from './token-grab/dexEars';
import { runDexWatch, renderDexWatchReport } from './token-grab/dexWatch';
import { loadWatchReports, buildDexWatchSummary, renderDexWatchSummary } from './token-grab/dexWatchSummary';
import { buildDexWatchCandidatesReport, renderDexWatchCandidatesReport } from './token-grab/dexWatchCandidates';
import { buildDexCandidateSimReport, renderDexCandidateSimReport } from './token-grab/dexCandidateSim';
import { runDexPaperRunner, renderDexPaperRunnerReport } from './token-grab/dexPaperRunner';
import { runDexPaperJournal, renderDexPaperJournal } from './token-grab/dexPaperJournal';
import { runDexPaperEntryPlanner, renderDexPaperEntryPlanReport } from './token-grab/dexPaperEntryPlanner';
import { runDexValidationLoop, renderValidationLoopSummary, renderValidationLoopUsage } from './token-grab/dexValidationLoop';
import { runDexDayWatch, renderDayWatchUsage, loadDayLog, buildDayReport, renderDayReport, renderDayReportUsage } from './token-grab/dexDayWatch';
import { runDexPaperPositionTracker, renderDexPaperPositionTrackerReport, renderDexPaperPositionTrackerUsage } from './token-grab/dexPaperPositionTracker';
import { runDexLegitimacyReport, renderDexLegitimacyReport, renderDexLegitimacyReportUsage } from './token-grab/dexLegitimacyReport';
import { runDexWinnerCandidateReport, renderDexWinnerCandidateReport, renderDexWinnerCandidateReportUsage } from './token-grab/dexWinnerCandidateReport';
import { runDexCandidateSafetyEnrich, renderDexCandidateSafetyEnrichReport, renderDexCandidateSafetyEnrichUsage } from './token-grab/dexCandidateSafetyEnrich';
import { runRipperSession, runRipperAutopilot, loadOrCreateSessionState, renderRipperSessionSummary, renderRipperDashboard, renderRipperSessionUsage, renderRipperAutopilotUsage, renderRipperDashboardUsage } from './token-grab/dexRipperSession';
import { runRipperEarsReport, runRipperNearMiss, renderRipperEarsReport, renderRipperNearMissReport, renderRipperEarsUsage, renderRipperNearMissUsage, type EarsInputFormat } from './token-grab/ripperEarsReport';
import { runLiveFixtureCapture, runLiveFixtureReport, runLiveFixtureAutopsy, renderCaptureResult, renderFixtureReport, renderAutopsyReport, renderLiveFixtureCaptureUsage, renderLiveFixtureReportUsage, renderLiveFixtureAutopsyUsage } from './token-grab/liveFixtureCapture';
import { runRipperFeed, renderRipperFeedResult, renderRipperFeedUsage } from './token-grab/ripperFeed';
import { runFreshPoolFeed, renderFreshPoolFeedResult, renderFreshPoolFeedUsage } from './token-grab/freshPoolFeed';
import { runPrimeGateAudit, renderPrimeGateAuditReport, renderPrimeGateAuditUsage } from './token-grab/primeGateAudit';
import { runHolderRiskAudit, renderHolderRiskAuditReport, renderHolderRiskAuditUsage } from './token-grab/holderRiskAudit';
import { runFixtureHolderEnrich, renderFixtureHolderEnrichReport, renderFixtureHolderEnrichUsage } from './token-grab/fixtureHolderEnrich';
import { runFixtureQuotePreview, renderFixtureQuotePreviewReport, renderFixtureQuotePreviewUsage } from './token-grab/fixtureQuotePreview';
import { runQuotePreviewAudit, renderQuotePreviewAuditReport } from './token-grab/quotePreviewAudit';
import { runAutonomyReadinessAudit, renderAutonomyReadinessAuditReport } from './token-grab/autonomyReadinessAudit';
import { runFixtureClusterEnrich, renderFixtureClusterEnrichReport, renderFixtureClusterEnrichUsage } from './token-grab/fixtureClusterEnrich';
import { runClusterRiskAudit, renderClusterRiskAuditReport } from './token-grab/clusterRiskAudit';
import { runBubbleMapsObservationReport, renderBubbleMapsObservationReport } from './token-grab/bubbleMapsObservationReport';
import { createClusterRiskProvider } from './token-grab/clusterRiskProvider';
import { runRipperPaperCycle, renderRipperPaperCycleResult, renderRipperPaperCycleUsage } from './token-grab/ripperPaperCycle';
import { runRipperPaperLoop, renderLoopCycleLine, renderRipperPaperLoopResult, renderRipperPaperLoopUsage } from './token-grab/ripperPaperLoop';
import { runRipperNearMissReport as runCycleNearMissReport, renderRipperNearMissReport as renderCycleNearMissReport, renderRipperNearMissReportUsage } from './token-grab/ripperNearMissReport';
import { runRipperApprovedOutcomes, renderRipperApprovedOutcomes, renderRipperApprovedOutcomesUsage } from './token-grab/ripperApprovedOutcomes';
import { runRipperApprovedAutopsy, renderRipperApprovedAutopsy } from './token-grab/ripperApprovedAutopsy';
import { runRipperEntrySim, renderRipperEntrySim } from './token-grab/ripperEntrySim';
import { runRipperDelayedWatch, renderRipperDelayedWatch } from './token-grab/ripperDelayedWatch';
import { runRipperApprovedObservationAutopsy, renderRipperApprovedObservationAutopsy } from './token-grab/ripperApprovedObservationAutopsy';
import { runRipperExitSim, renderRipperExitSim } from './token-grab/ripperExitSim';
import { runRipperEntryFeatureAutopsy, renderRipperEntryFeatureAutopsy } from './token-grab/ripperEntryFeatureAutopsy';
import { runRipperShadowFilterReport, renderRipperShadowFilterReport } from './token-grab/ripperShadowFilterReport';
import { runRipperShadowPolicyReport, renderRipperShadowPolicyReport } from './token-grab/ripperShadowPolicyReport';
import { runRipperShadowPortfolioReport, renderRipperShadowPortfolioReport } from './token-grab/ripperShadowPortfolioReport';
import { runRipperShadowComboReport, renderRipperShadowComboReport } from './token-grab/ripperShadowComboReport';
import { runRipperExitWindowReport, renderRipperExitWindowReport } from './token-grab/ripperExitWindowReport';
import { runRipperEntryLagReport, renderRipperEntryLagReport } from './token-grab/ripperEntryLagReport';
import { runRipperEarlyWatchPolicyReport, renderRipperEarlyWatchPolicyReport } from './token-grab/ripperEarlyWatchPolicyReport';
import { runRipperEarlyWatchTrackedLaneReport, renderRipperEarlyWatchTrackedLaneReport } from './token-grab/ripperEarlyWatchTrackedLaneReport';
import { runRipperEarlyWatchBlockerAutopsy, renderRipperEarlyWatchBlockerAutopsy } from './token-grab/ripperEarlyWatchBlockerAutopsy';
import { runRipperApprovalPersistenceAudit, renderRipperApprovalPersistenceAudit } from './token-grab/ripperApprovalPersistenceAudit';
import { runRipperEarlyWatchLeadValueReport, renderRipperEarlyWatchLeadValueReport } from './token-grab/ripperEarlyWatchLeadValueReport';
import { runRipperApprovalTriggerLagReport, renderRipperApprovalTriggerLagReport } from './token-grab/ripperApprovalTriggerLagReport';
import { runRipperApprovalFollowPaperPlan, renderRipperApprovalFollowPaperPlan } from './token-grab/ripperApprovalFollowPaperPlan';
import { runRipperApprovalFollowPaperSession, renderRipperApprovalFollowPaperSession } from './token-grab/ripperApprovalFollowPaperSession';
import { runRipperApprovalFollowPaperSessionReport, renderRipperApprovalFollowPaperSessionReport } from './token-grab/ripperApprovalFollowPaperSessionReport';
import { runRipperWait5PaperShadow, renderRipperWait5PaperShadow } from './token-grab/ripperWait5PaperShadow';
import { runOutcomeTracker, renderOutcomeTrackerReport } from './token-grab/outcomeTracker';
import { runOutcomeAutopsy, renderOutcomeAutopsyReport } from './token-grab/outcomeAutopsy';
import { runOutcomeTrackerV2, renderOutcomeTrackerV2Report } from './token-grab/outcomeTrackerV2';
import { runOutcomeWatchSession, renderOutcomeWatchSessionReport } from './token-grab/outcomeWatchSession';
import { runResolvedLedger, renderResolvedLedgerReport } from './token-grab/resolvedCandidateLedger';
import { runLedgerAnalytics, renderLedgerAnalyticsReport } from './token-grab/ledgerAnalytics';

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

      case 'token:watch-snapshot': {
        const sessionPath = getArgValue('--session');
        const outPath = getArgValue('--out');

        if (!sessionPath) throw new Error('token:watch-snapshot requires --session <path>');
        if (!outPath) throw new Error('token:watch-snapshot requires --out <path>');

        const includeRejects = process.argv.includes('--include-rejects');
        const topRejects = parseNumberArg('--top-rejects', 0, { integer: true, min: 0 });
        const startAt = parseNumberArg('--start-at', 0, { integer: true, min: 0 });
        const limit = parseNumberArg('--limit', 10, { integer: true, min: 1 });
        const delayMs = parseNumberArg('--delay-ms', 1500, { integer: true, min: 0 });
        const timeoutMs = parseNumberArg('--timeout-ms', 10_000, { integer: true, min: 500 });

        const session = loadTokenGrabSession(sessionPath);
        const selected = selectWatchCandidates(session.candidates, {
          includeRejects,
          topRejects,
          startAt,
          limit,
        });

        if (!selected.hasWatchWorthy) {
          writeSnapshotFile(outPath, []);
          console.log('No watch-worthy candidates found. Wrote empty snapshot array.');
          console.log(`Output: ${outPath}`);
          console.log('');
          console.log('NO TRADING EXECUTED');
          break;
        }

        console.log(`Session   : ${sessionPath}`);
        console.log(`Output    : ${outPath}`);
        console.log(`Candidates: ${session.candidates.length} loaded, ${selected.totalWatchWorthy} watch-worthy`);
        console.log(`Lanes     : ${selected.lanesIncluded.join(', ')}`);
        if (delayMs > 0) {
          console.log(`Delay     : ${delayMs}ms between requests`);
        }
        console.log('Fetching snapshots from GeckoTerminal...');
        console.log('');

        const watchResult = await fetchSessionSnapshots({
          candidates: selected.candidates,
          delayMs,
          timeoutMs,
        });

        writeSnapshotFile(outPath, watchResult.snapshots);

        const watchSummary: WatchSnapshotSummary = {
          sessionPath,
          outPath,
          candidatesLoaded: session.candidates.length,
          watchWorthyFound: selected.totalWatchWorthy,
          lanesIncluded: selected.lanesIncluded,
          startAt,
          limit,
          candidatesAttempted: selected.candidates.length,
          snapshotsWritten: watchResult.snapshots.length,
          skipped: watchResult.skipped,
          noTradingExecuted: true,
        };

        console.log(renderWatchSnapshotSummary(watchSummary));

        if (watchResult.skipReasons.length > 0) {
          for (const s of watchResult.skipReasons) {
            console.log(`  ! ${s.ticker} (${s.candidateId}): ${s.reason}`);
          }
        }
        break;
      }

      case 'token:live-assisted-watch': {
        const fakeBankroll = parseNumberArg('--fake-bankroll', 20, { min: 0.01 });
        const maxFakePosition = parseNumberArg('--max-fake-position', 5, { min: 0.01 });
        const watchMinutes = parseNumberArg('--watch-minutes', 10, { min: 0.01 });
        const geckoLimit = parseNumberArg('--gecko-limit', 20, { integer: true, min: 1 });
        const delayMs = parseNumberArg('--delay-ms', 5000, { integer: true, min: 0 });
        const outDir = getArgValue('--out-dir') ?? 'data/token-grab/live-assisted';
        const tsArg = getArgValue('--timestamp');
        const skipSleep = process.argv.includes('--skip-sleep');
        const jsonMode = process.argv.includes('--json');

        if (maxFakePosition > fakeBankroll) {
          throw new Error(`--max-fake-position (${maxFakePosition}) cannot exceed --fake-bankroll (${fakeBankroll})`);
        }

        const now = new Date();
        const ts = tsArg ?? [
          now.getUTCFullYear(),
          String(now.getUTCMonth() + 1).padStart(2, '0'),
          String(now.getUTCDate()).padStart(2, '0'),
        ].join('') + '-' + [
          String(now.getUTCHours()).padStart(2, '0'),
          String(now.getUTCMinutes()).padStart(2, '0'),
        ].join('');

        const sessionPath = `${outDir}/session-${ts}.json`;
        const entryPath = `${outDir}/session-${ts}-entry.json`;
        const exitPath = `${outDir}/session-${ts}-exit.json`;

        // 1. Safety banner
        const LIVE_WIDE = '═'.repeat(62);
        console.log(LIVE_WIDE);
        console.log('  LIVE-ASSISTED PAPER MODE — Token Grab V1');
        console.log(LIVE_WIDE);
        console.log('  NO REAL TRADING EXECUTED');
        console.log('  token:auto-paper was NOT run');
        console.log(`  Fake bankroll      : $${fakeBankroll}`);
        console.log(`  Max fake position  : $${maxFakePosition}`);
        console.log(`  Watch minutes      : ${watchMinutes}`);
        if (skipSleep) console.log('  [skip-sleep mode active]');
        console.log('');

        // 2. Detect fresh pools
        console.log('Detecting fresh Solana pools from GeckoTerminal...');
        const livePools = await fetchGeckoFreshPools({ limit: geckoLimit });
        const freshPools = dedupeFreshPools(livePools);
        const liveReport = buildTokenGrabReport({ socialSignals: [], eventSignals: [], freshPools });

        // 3. Save session
        const liveSession: TokenGrabSessionFile = {
          schema: 'token-grab-session-v1',
          generatedAt: liveReport.generatedAt,
          source: { social: 'none', freshPools: 'geckoterminal', events: 'none' },
          flags: { geckoFreshPools: true, geckoLimit },
          summary: liveReport.summary,
          candidates: tokenGrabReportToAutopsyCandidates(liveReport),
          safety: {
            reportOnly: true,
            noTradingExecuted: true,
            tradingExecuted: 0,
            dbWrites: false,
            scheduler: false,
          },
        };
        saveTokenGrabSession(sessionPath, liveSession);

        const allCandidates = liveSession.candidates;
        const laneSummary: Record<string, number> = {};
        for (const c of allCandidates) {
          laneSummary[c.lane] = (laneSummary[c.lane] ?? 0) + 1;
        }

        console.log(`Detected ${allCandidates.length} candidates:`);
        for (const [lane, count] of Object.entries(laneSummary)) {
          console.log(`  ${lane}: ${count}`);
        }
        console.log('');

        // 4. Select watch-worthy candidates
        const liveSelected = selectWatchCandidates(allCandidates);

        if (!liveSelected.hasWatchWorthy) {
          writeSnapshotFile(entryPath, []);
          writeSnapshotFile(exitPath, []);
          const noWatchSummary = buildLiveAssistedSummary({
            ts, sessionPath, entrySnapshotPath: entryPath, exitSnapshotPath: exitPath,
            fakeBankroll, maxFakePosition, watchMinutes,
            candidatesDetected: allCandidates.length,
            laneSummary, watchWorthyCount: 0,
            decision: 'NO_BUY',
            noBuyReason: 'No watch-worthy candidates found in this detection round.',
            skipSleepMode: skipSleep,
          });
          if (jsonMode) {
            console.log(JSON.stringify(noWatchSummary, null, 2));
          } else {
            console.log(renderLiveAssistedReport(noWatchSummary));
          }
          break;
        }

        // 5. Entry snapshot
        console.log(`${liveSelected.candidates.length} watch-worthy candidate(s). Fetching entry snapshots...`);
        const entryResult = await fetchSessionSnapshots({
          candidates: liveSelected.candidates,
          delayMs,
        });
        writeSnapshotFile(entryPath, entryResult.snapshots);
        console.log(`Entry snapshots: ${entryResult.snapshots.length} written, ${entryResult.skipped} skipped.`);
        console.log('');

        // 6. Fake buy decision
        const chosen = chooseLiveAssistedCandidate(liveSelected.candidates, entryResult.snapshots);
        const entrySnapshot = chosen?.snapshot;
        const fakeBuyOk = chosen != null && isFakeBuyEligible(
          chosen.candidate, entrySnapshot, maxFakePosition, fakeBankroll,
        );

        let fakeBuyRecord: FakeBuyRecord | undefined;
        let noBuyReason: string | undefined;

        if (fakeBuyOk && chosen && entrySnapshot && entrySnapshot.priceUsd) {
          const positionSize = calculateFakePosition(fakeBankroll, maxFakePosition);
          const fakeTokensHeld = positionSize / entrySnapshot.priceUsd;
          fakeBuyRecord = {
            candidateId: chosen.candidate.id,
            tokenName: chosen.candidate.tokenName,
            ticker: chosen.candidate.ticker,
            lane: chosen.candidate.lane,
            fakePositionSize: positionSize,
            fakeEntryPrice: entrySnapshot.priceUsd,
            fakeLiquidityAtEntry: entrySnapshot.liquidityUsd ?? 0,
            fakeTokensHeld,
            paperStopNote: 'Paper stop only; no real order placed',
            fakeExitRule: `Exit at ${watchMinutes}-minute snapshot`,
          };
          console.log(`FAKE BUY: $${fakeBuyRecord.ticker} @ $${fakeBuyRecord.fakeEntryPrice.toExponential(4)}`);
          console.log(`  Position size : $${positionSize.toFixed(2)}`);
          console.log(`  Tokens held   : ${fakeTokensHeld.toFixed(6)}`);
          console.log(`  Lane          : ${chosen.candidate.lane}`);
          console.log(`  Liquidity     : $${entrySnapshot.liquidityUsd?.toFixed(0) ?? 'n/a'}`);
          console.log('  [PAPER ONLY — NO REAL ORDER PLACED]');
        } else {
          if (!chosen) {
            noBuyReason = 'No watch candidate found.';
          } else if (!entrySnapshot) {
            noBuyReason = `Entry snapshot missing for ${chosen.candidate.ticker}.`;
          } else if (!entrySnapshot.priceUsd || entrySnapshot.priceUsd <= 0) {
            noBuyReason = `Entry price unavailable for ${chosen.candidate.ticker}.`;
          } else if (!entrySnapshot.liquidityUsd || entrySnapshot.liquidityUsd < 1000) {
            noBuyReason = `Liquidity too low ($${(entrySnapshot.liquidityUsd ?? 0).toFixed(0)} < $1000) for ${chosen.candidate.ticker}.`;
          } else {
            noBuyReason = `Lane ${chosen.candidate.lane} not eligible for fake buy in V1.`;
          }
          console.log(`NO_BUY: ${noBuyReason}`);
        }
        console.log('');

        // 7. Sleep
        if (!skipSleep) {
          console.log(`Sleeping ${watchMinutes} minute(s) before exit snapshot...`);
          await sleep(watchMinutes * 60 * 1000);
        } else {
          console.log('[skip-sleep: proceeding immediately to exit snapshot]');
        }

        // 8. Exit snapshot
        console.log('Fetching exit snapshots...');
        const exitResult = await fetchSessionSnapshots({
          candidates: liveSelected.candidates,
          delayMs,
        });
        writeSnapshotFile(exitPath, exitResult.snapshots);
        console.log(`Exit snapshots: ${exitResult.snapshots.length} written, ${exitResult.skipped} skipped.`);
        console.log('');

        // 9. Autopsy
        const allSnapshots = [...entryResult.snapshots, ...exitResult.snapshots];
        const liveAutopsy = buildTokenGrabAutopsyReport(liveSelected.candidates, allSnapshots, { mode: 'session-file' });
        const chosenAutopsyResult = chosen
          ? liveAutopsy.results.find(r => r.candidateId === chosen.candidate.id)
          : undefined;

        // 10. P/L
        let livePnL: LiveAssistedPnL | undefined;
        if (fakeBuyRecord) {
          const exitSnap = exitResult.snapshots.find(s => s.candidateId === fakeBuyRecord!.candidateId);
          livePnL = calculateFakePnL(
            fakeBuyRecord.fakePositionSize,
            fakeBuyRecord.fakeEntryPrice,
            fakeBuyRecord.fakeTokensHeld,
            exitSnap?.priceUsd,
            fakeBankroll,
          );
        }

        // 11. Final report
        const liveSummary = buildLiveAssistedSummary({
          ts, sessionPath, entrySnapshotPath: entryPath, exitSnapshotPath: exitPath,
          fakeBankroll, maxFakePosition, watchMinutes,
          candidatesDetected: allCandidates.length,
          laneSummary, watchWorthyCount: liveSelected.totalWatchWorthy,
          decision: fakeBuyRecord ? 'FAKE_BUY' : 'NO_BUY',
          noBuyReason,
          fakeBuy: fakeBuyRecord,
          fakePnL: livePnL,
          autopsyResult: chosenAutopsyResult,
          skipSleepMode: skipSleep,
        });

        if (jsonMode) {
          console.log(JSON.stringify(liveSummary, null, 2));
        } else {
          console.log(renderLiveAssistedReport(liveSummary));
        }
        break;
      }

      case 'token:live-harness': {
        const liveIntent = process.argv.includes('--live-intent');
        const requireConfirmation = process.argv.includes('--require-confirmation');
        const fakeBankroll = parseNumberArg('--fake-bankroll', 20, { min: 0.01 });
        const maxLivePosition = parseNumberArg('--max-live-position', 1, { min: 0.01 });
        const watchMinutes = parseNumberArg('--watch-minutes', 10, { min: 0.01 });
        const geckoLimit = parseNumberArg('--gecko-limit', 20, { integer: true, min: 1 });
        const delayMs = parseNumberArg('--delay-ms', 5000, { integer: true, min: 0 });
        const outDir = getArgValue('--out-dir') ?? 'data/token-grab/live-harness';
        const tsArg = getArgValue('--timestamp');
        const skipSleep = process.argv.includes('--skip-sleep');
        const watchCycle = process.argv.includes('--watch-cycle');
        const confirmEntry = process.argv.includes('--confirm-entry');
        const confirmMinutes = parseNumberArg('--confirm-minutes', 2, { min: 0.01 });
        const confirmMinPriceChangePct = parseNumberArg('--confirm-min-price-change-pct', confirmEntry ? 20 : 5);
        const confirmMinLiquidityChangePct = parseNumberArg('--confirm-min-liquidity-change-pct', confirmEntry ? 10 : 0);
        const confirmMaxDrawdownPct = parseNumberArg('--confirm-max-drawdown-pct', -10);
        const confirmMinConfirmedLiquidityUsd = parseNumberArg('--confirm-min-confirmed-liquidity', 2500, { min: 0 });
        const jsonMode = process.argv.includes('--json');
        const paperExitGuardEnabled = process.argv.includes('--paper-exit-guard');
        const paperExitIntervalSeconds = parseNumberArg('--paper-exit-interval-seconds', 60, { min: 1 });
        const paperExitHardStopPct = parseNumberArg('--paper-exit-hard-stop-pct', -25);
        const paperExitTakeProfitPct = parseNumberArg('--paper-exit-take-profit-pct', 50);
        const paperExitTrailingActivatePct = parseNumberArg('--paper-exit-trailing-activate-pct', 30);
        const paperExitTrailingDropPct = parseNumberArg('--paper-exit-trailing-drop-pct', 20);
        const paperExitMomentumFloor = process.argv.includes('--paper-exit-momentum-floor');
        const preSignalsPath = getArgValue('--pre-signals');
        const fieldNote = getArgValue('--field-note');
        const fieldTagsRaw = getArgValue('--field-tags');
        const fieldTags = fieldTagsRaw
          ? fieldTagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0)
          : undefined;

        // V1 hard cap — fail-fast before any network calls
        assertMaxLivePosition(maxLivePosition);

        const now = new Date();
        const ts = tsArg ?? [
          now.getUTCFullYear(),
          String(now.getUTCMonth() + 1).padStart(2, '0'),
          String(now.getUTCDate()).padStart(2, '0'),
        ].join('') + '-' + [
          String(now.getUTCHours()).padStart(2, '0'),
          String(now.getUTCMinutes()).padStart(2, '0'),
        ].join('');

        const sessionPath = `${outDir}/session-${ts}.json`;
        const entryPath = `${outDir}/session-${ts}-entry.json`;
        const planFilePath = `${outDir}/plan-${ts}.json`;

        fs.mkdirSync(outDir, { recursive: true });

        // 1. Safety banner
        const LIVE_WIDE = '═'.repeat(64);
        console.log(LIVE_WIDE);
        console.log('  MANUAL-APPROVED LIVE HARNESS V1');
        console.log('  NOT AUTONOMOUS');
        console.log('  DEFAULT DRY RUN');
        console.log(`  MAX LIVE POSITION: $${maxLivePosition}`);
        console.log('  MAX OPEN POSITIONS: 1');
        console.log('  token:auto-paper was NOT run');
        if (!liveIntent) console.log('  [dry-run mode — pass --live-intent to enable live gates]');
        if (watchCycle) console.log('  [watch-cycle: will sleep and take exit snapshot]');
        if (confirmEntry) console.log(`  [confirm-entry: ${confirmMinutes} min window, >${confirmMinPriceChangePct}% price required]`);
        if (skipSleep) console.log('  [skip-sleep mode active]');
        console.log(LIVE_WIDE);
        console.log('');

        // 2. Detect fresh pools
        console.log('Detecting fresh Solana pools from GeckoTerminal...');
        const livePools = await fetchGeckoFreshPools({ limit: geckoLimit });
        const freshPools = dedupeFreshPools(livePools);
        const liveReport = buildTokenGrabReport({ socialSignals: [], eventSignals: [], freshPools });

        // 3. Save session
        const liveSession: TokenGrabSessionFile = {
          schema: 'token-grab-session-v1',
          generatedAt: liveReport.generatedAt,
          source: { social: 'none', freshPools: 'geckoterminal', events: 'none' },
          flags: { geckoFreshPools: true, geckoLimit },
          summary: liveReport.summary,
          candidates: tokenGrabReportToAutopsyCandidates(liveReport),
          safety: {
            reportOnly: true,
            noTradingExecuted: true,
            tradingExecuted: 0,
            dbWrites: false,
            scheduler: false,
          },
          fieldNote,
          fieldTags,
        };
        saveTokenGrabSession(sessionPath, liveSession);

        const allCandidates = liveSession.candidates;
        const laneSummary: Record<string, number> = {};
        for (const c of allCandidates) {
          laneSummary[c.lane] = (laneSummary[c.lane] ?? 0) + 1;
        }

        console.log(`Detected ${allCandidates.length} candidates:`);
        for (const [lane, count] of Object.entries(laneSummary)) {
          console.log(`  ${lane}: ${count}`);
        }
        console.log('');

        // 4. Select watch-worthy candidates
        const liveSelected = selectWatchCandidates(allCandidates);

        // 4a. Pre-signal bridge — match pre-signals against watch-worthy candidates (WATCH ONLY)
        let preSignalBridge: PreSignalBridgeSummary | undefined;
        if (preSignalsPath) {
          const { valid: preSignals } = loadPreSignals(preSignalsPath);
          const bridgeCandidates = liveSelected.candidates.map(c => ({
            ticker: c.ticker,
            name: c.tokenName,
            contract: c.contractAddress,
          }));
          preSignalBridge = buildPreSignalBridge(preSignals, bridgeCandidates, preSignalsPath);
          if (preSignalBridge.matchCount > 0) {
            console.log(`[pre-signal] ${preSignalBridge.matchCount} candidate match(es) from ${preSignalBridge.signalsLoaded} signal(s) — WATCH ONLY`);
            for (const m of preSignalBridge.matchedCandidates) {
              console.log(`  $${m.candidateTicker} — ${m.matchReason} / ${m.matchStrength} / ${m.signalConfidence} / ${m.signalSource}`);
            }
          } else {
            console.log(`[pre-signal] 0 matches from ${preSignalBridge.signalsLoaded} signal(s) loaded`);
          }
          console.log('');
        }

        // Helper to build and emit the final summary
        const emitSummary = (summary: LiveHarnessSummary): void => {
          if (jsonMode) {
            console.log(JSON.stringify(summary, null, 2));
          } else {
            console.log(renderLiveHarnessReport(summary));
          }
        };

        if (!liveSelected.hasWatchWorthy) {
          writeSnapshotFile(entryPath, []);
          const readiness = evaluateLiveReadinessGates({
            liveIntent,
            requireConfirmation,
            maxLivePosition,
            unlockEnvValue: process.env['TOKEN_GRAB_LIVE_UNLOCK'],
            decision: 'NO_BUY',
            candidate: undefined,
            snapshot: undefined,
            candidateCount: 0,
          });
          const summary: LiveHarnessSummary = {
            ts, outDir, status: 'NO_TRADE', decision: 'NO_BUY',
            readiness, liveIntent, requireConfirmation, maxLivePosition,
            maxOpenPositions: 1, candidatesDetected: allCandidates.length,
            laneSummary, watchWorthyCount: 0,
            notAutonomous: true, noRealTradeSent: true, autoPaperNotRun: true,
            skipSleepMode: skipSleep,
            watchCycle: false,
            fakeBankroll,
            confirmMinConfirmedLiquidityUsd,
            confirmEntry, confirmMinutes,
            preSignalBridge,
            fieldNote,
            fieldTags,
          };
          emitSummary(summary);
          break;
        }

        // 5. Entry snapshot
        console.log(`${liveSelected.candidates.length} watch-worthy candidate(s). Fetching entry snapshots...`);
        const entryResult = await fetchSessionSnapshots({ candidates: liveSelected.candidates, delayMs });
        writeSnapshotFile(entryPath, entryResult.snapshots);
        console.log(`Entry snapshots: ${entryResult.snapshots.length} written, ${entryResult.skipped} skipped.`);
        console.log('');

        // 6. Paper decision (reuses live-assisted logic)
        const chosen = chooseLiveAssistedCandidate(liveSelected.candidates, entryResult.snapshots);
        const entrySnapshot = chosen?.snapshot;
        const fakeBuyOk = chosen != null && isFakeBuyEligible(
          chosen.candidate, entrySnapshot, maxLivePosition, fakeBankroll,
        );

        let decision: 'FAKE_BUY' | 'NO_BUY' = fakeBuyOk ? 'FAKE_BUY' : 'NO_BUY';
        let noBuyReason: string | undefined;

        if (!fakeBuyOk) {
          if (!chosen) {
            noBuyReason = 'No watch candidate found.';
          } else if (!entrySnapshot) {
            noBuyReason = `Entry snapshot missing for ${chosen.candidate.ticker}.`;
          } else if (!entrySnapshot.priceUsd || entrySnapshot.priceUsd <= 0) {
            noBuyReason = `Entry price unavailable for ${chosen.candidate.ticker}.`;
          } else if (!entrySnapshot.liquidityUsd || entrySnapshot.liquidityUsd < 1000) {
            noBuyReason = `Liquidity too low ($${(entrySnapshot.liquidityUsd ?? 0).toFixed(0)} < $1000) for ${chosen.candidate.ticker}.`;
          } else {
            noBuyReason = `Lane ${chosen.candidate.lane} not eligible in V1.`;
          }
          console.log(`Paper decision: NO_BUY — ${noBuyReason}`);
        } else {
          console.log(`Paper decision: FAKE_BUY — $${chosen!.candidate.ticker} @ lane ${chosen!.candidate.lane}`);
        }
        console.log('');

        // 6a. Entry confirmation gate (requires --confirm-entry and a FAKE_BUY candidate)
        let entryConfirmation: EntryConfirmationResult | undefined;
        let confirmSnapshotPath: string | undefined;

        if (confirmEntry && decision === 'FAKE_BUY' && chosen && entrySnapshot) {
          if (!skipSleep) {
            console.log(`[confirm-entry] Sleeping ${confirmMinutes} minute(s) before confirmation snapshot...`);
            await sleep(confirmMinutes * 60 * 1000);
          } else {
            console.log('[confirm-entry] skip-sleep: proceeding immediately to confirmation snapshot');
          }

          confirmSnapshotPath = `${outDir}/session-${ts}-confirm.json`;
          console.log('[confirm-entry] Fetching confirmation snapshot...');
          const confirmResult = await fetchSessionSnapshots({ candidates: [chosen.candidate], delayMs });
          writeSnapshotFile(confirmSnapshotPath, confirmResult.snapshots);
          const confirmSnap = confirmResult.snapshots.find(s => s.candidateId === chosen.candidate.id);

          entryConfirmation = evaluateEntryConfirmation({
            entrySnapshot,
            confirmSnapshot: confirmSnap,
            minPriceChangePct: confirmMinPriceChangePct,
            minLiquidityChangePct: confirmMinLiquidityChangePct,
            maxDrawdownPct: confirmMaxDrawdownPct,
            minConfirmedLiquidityUsd: confirmMinConfirmedLiquidityUsd,
          });

          console.log(`[confirm-entry] Verdict: ${entryConfirmation.verdict}`);

          if (entryConfirmation.verdict !== 'CONFIRMED') {
            decision = 'NO_BUY';
            console.log(`[confirm-entry] Rejected — ${entryConfirmation.reason}`);
            console.log('');

            const rejReadiness = evaluateLiveReadinessGates({
              liveIntent, requireConfirmation, maxLivePosition,
              unlockEnvValue: process.env['TOKEN_GRAB_LIVE_UNLOCK'],
              decision: 'NO_BUY', candidate: undefined, snapshot: undefined, candidateCount: 0,
            });
            const rejChosenMatch = preSignalBridge?.matchedCandidates.find(
              m => m.candidateTicker === chosen?.candidate.ticker,
            );
            const rejSummary: LiveHarnessSummary = {
              ts, outDir, status: 'NO_TRADE', decision: 'NO_BUY',
              readiness: rejReadiness, liveIntent, requireConfirmation, maxLivePosition,
              maxOpenPositions: 1, candidatesDetected: allCandidates.length, laneSummary,
              watchWorthyCount: liveSelected.totalWatchWorthy,
              notAutonomous: true, noRealTradeSent: true, autoPaperNotRun: true,
              skipSleepMode: skipSleep,
              watchCycle,
              watchCycleSkipped: watchCycle ? true : undefined,
              watchCycleSkipReason: watchCycle ? 'No PLAN_ONLY trade plan was created.' : undefined,
              fakeBankroll,
              confirmMinConfirmedLiquidityUsd,
              confirmEntry, confirmMinutes, confirmSnapshotPath, entryConfirmation,
              preSignalBridge,
              preSignalAnnotation: rejChosenMatch
                ? { preSignalMatch: true, preSignalReason: rejChosenMatch.matchReason, preSignalConfidence: rejChosenMatch.signalConfidence, preSignalSource: rejChosenMatch.signalSource, laneLabel: 'PRE_SIGNAL_MATCH', watchOnly: true, planOnlyNotGranted: true }
                : undefined,
              fieldNote,
              fieldTags,
            };
            emitSummary(rejSummary);
            break;
          }

          const pctStr = entryConfirmation.priceChangePct != null
            ? `${entryConfirmation.priceChangePct >= 0 ? '+' : ''}${entryConfirmation.priceChangePct.toFixed(2)}%`
            : 'N/A';
          console.log(`[confirm-entry] Confirmed — price ${pctStr} change`);
          console.log('');
        }

        // 7. Build trade plan if FAKE_BUY
        let tradePlan: LiveTradePlan | undefined;
        if (fakeBuyOk && chosen && entrySnapshot && decision === 'FAKE_BUY') {
          tradePlan = buildLiveTradePlan(chosen.candidate, entrySnapshot, maxLivePosition, entryConfirmation?.qualityDiagnostics);
          fs.writeFileSync(planFilePath, JSON.stringify(tradePlan, null, 2), 'utf-8');
          console.log(`Trade plan written: ${planFilePath}`);
          console.log('  Status: PLAN_ONLY — no real trade sent');
          console.log('');
        }

        // candidateCount is 1 when a single candidate was chosen for live consideration
        const chosenCandidateCount = chosen ? 1 : 0;

        // 8. Evaluate live readiness gates (without confirmation initially)
        const preReadiness = evaluateLiveReadinessGates({
          liveIntent,
          requireConfirmation,
          maxLivePosition,
          unlockEnvValue: process.env['TOKEN_GRAB_LIVE_UNLOCK'],
          decision,
          candidate: chosen?.candidate,
          snapshot: entrySnapshot,
          candidateCount: chosenCandidateCount,
          typedConfirmation: undefined,
        });

        // 9. If confirmation is needed, prompt for it
        let finalReadiness = preReadiness;
        if (preReadiness.status === 'LIVE_REQUIRES_CONFIRMATION') {
          const phrase = getRequiredConfirmationPhrase();
          console.log(`All other live gates passed.`);
          console.log(`Type exactly to proceed: ${phrase}`);
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const typedConfirmation = await new Promise<string>((resolve) => {
            rl.question('> ', (answer) => { rl.close(); resolve(answer.trim()); });
          });
          finalReadiness = evaluateLiveReadinessGates({
            liveIntent,
            requireConfirmation,
            maxLivePosition,
            unlockEnvValue: process.env['TOKEN_GRAB_LIVE_UNLOCK'],
            decision,
            candidate: chosen?.candidate,
            snapshot: entrySnapshot,
            candidateCount: chosenCandidateCount,
            typedConfirmation,
          });
        }

        // 10. Watch cycle — sleep + exit snapshot (optional, requires --watch-cycle and PLAN_ONLY)
        let exitSnapshotPath: string | undefined;
        let watchCyclePnL: LiveAssistedPnL | undefined;
        let watchCycleSkipped = false;
        let watchCycleSkipReason: string | undefined;
        let paperExitGuardResult: PaperExitGuardSummary | undefined;

        if (watchCycle) {
          if (!tradePlan) {
            watchCycleSkipped = true;
            watchCycleSkipReason = 'No PLAN_ONLY trade plan was created.';
            console.log('[watch-cycle] Skipped — No PLAN_ONLY trade plan was created.');
            console.log('');
          } else if (liveSelected.hasWatchWorthy && chosen) {
            const entryPrice = tradePlan.entryPrice;
            const confirmPriceForFloor = entryConfirmation?.confirmPrice ?? undefined;

            if (paperExitGuardEnabled) {
              // Paper exit guard: interval-based simulation
              const maxChecks = Math.max(1, Math.ceil((watchMinutes * 60) / paperExitIntervalSeconds));
              console.log(`[paper-exit-guard] Starting interval simulation: ${maxChecks} checks × ${paperExitIntervalSeconds}s`);

              let pegState: PaperExitState = { checksRun: 0, trailingActive: false };
              let pegReason: PaperExitReason | null = null;

              for (let i = 0; i < maxChecks; i++) {
                if (!skipSleep) {
                  await sleep(paperExitIntervalSeconds * 1000);
                }

                const checkResult = await fetchSessionSnapshots({ candidates: [chosen.candidate], delayMs });
                const checkSnap = checkResult.snapshots.find(s => s.candidateId === chosen.candidate.id);

                if (checkSnap?.priceUsd) {
                  pegState = updatePaperExitState(pegState, checkSnap.priceUsd, entryPrice, paperExitTrailingActivatePct);
                  pegReason = evaluatePaperExitGuard({
                    state: pegState,
                    hardStopPct: paperExitHardStopPct,
                    takeProfitPct: paperExitTakeProfitPct,
                    trailingActivatePct: paperExitTrailingActivatePct,
                    trailingDropPct: paperExitTrailingDropPct,
                    momentumFloorEnabled: paperExitMomentumFloor,
                    confirmPrice: confirmPriceForFloor,
                  });
                  const sign = (pegState.currentPnLPct ?? 0) >= 0 ? '+' : '';
                  console.log(`[paper-exit-guard] check ${i + 1}/${maxChecks}: P/L ${sign}${(pegState.currentPnLPct ?? 0).toFixed(2)}% trailing=${pegState.trailingActive}`);
                } else {
                  pegState = { ...pegState, checksRun: pegState.checksRun + 1 };
                  console.log(`[paper-exit-guard] check ${i + 1}/${maxChecks}: price unavailable`);
                }

                if (pegReason !== null) {
                  console.log(`[paper-exit-guard] Exit triggered: ${pegReason}`);
                  break;
                }
              }

              if (pegReason === null) pegReason = 'MAX_HOLD';

              paperExitGuardResult = {
                enabled: true,
                intervalSeconds: paperExitIntervalSeconds,
                checksRun: pegState.checksRun,
                exitReason: pegReason,
                entryPrice,
                confirmPrice: confirmPriceForFloor,
                exitPrice: pegState.currentPrice,
                exitPnLPct: pegState.currentPnLPct,
                peakPrice: pegState.peakPrice,
                peakPnLPct: pegState.peakPnLPct,
                hardStopPct: paperExitHardStopPct,
                takeProfitPct: paperExitTakeProfitPct,
                trailingActivatePct: paperExitTrailingActivatePct,
                trailingDropPct: paperExitTrailingDropPct,
                momentumFloorEnabled: paperExitMomentumFloor,
                noRealTradeSent: true,
              };

              // Also record a final exit snapshot for the record
              exitSnapshotPath = `${outDir}/session-${ts}-exit.json`;
              const lastCheckResult = await fetchSessionSnapshots({ candidates: liveSelected.candidates, delayMs });
              writeSnapshotFile(exitSnapshotPath, lastCheckResult.snapshots);

              if (pegState.currentPnLPct != null) {
                const sign = pegState.currentPnLPct >= 0 ? '+' : '';
                console.log(`[paper-exit-guard] Exit P/L: ${sign}${pegState.currentPnLPct.toFixed(2)}% reason=${pegReason}`);
              }
              console.log('');
            } else {
              // Standard watch-cycle: single sleep + exit snapshot
              if (!skipSleep) {
                console.log(`[watch-cycle] Sleeping ${watchMinutes} minute(s) before exit snapshot...`);
                await sleep(watchMinutes * 60 * 1000);
              } else {
                console.log('[watch-cycle] skip-sleep: proceeding immediately to exit snapshot');
              }

              exitSnapshotPath = `${outDir}/session-${ts}-exit.json`;
              console.log('[watch-cycle] Fetching exit snapshots...');
              const exitResult = await fetchSessionSnapshots({ candidates: liveSelected.candidates, delayMs });
              writeSnapshotFile(exitSnapshotPath, exitResult.snapshots);
              console.log(`[watch-cycle] Exit snapshots: ${exitResult.snapshots.length} written, ${exitResult.skipped} skipped.`);

              const exitSnap = exitResult.snapshots.find(s => s.candidateId === chosen.candidate.id);
              const fakeTokensHeld = tradePlan.maxLivePosition / tradePlan.entryPrice;
              watchCyclePnL = calculateFakePnL(
                tradePlan.maxLivePosition,
                tradePlan.entryPrice,
                fakeTokensHeld,
                exitSnap?.priceUsd,
                fakeBankroll,
              );
              const sign = watchCyclePnL.pnlDollars >= 0 ? '+' : '';
              if (watchCyclePnL.outcome !== 'UNKNOWN') {
                console.log(`[watch-cycle] Fake P/L: ${sign}$${watchCyclePnL.pnlDollars.toFixed(4)} / ${sign}${watchCyclePnL.pnlPct.toFixed(2)}% (${watchCyclePnL.outcome})`);
              } else {
                console.log('[watch-cycle] Exit price unavailable — P/L unknown');
              }
              console.log('');
            }
          }
        }

        const finalSummary: LiveHarnessSummary = {
          ts,
          outDir,
          planFilePath: tradePlan ? planFilePath : undefined,
          status: finalReadiness.status,
          decision,
          tradePlan,
          readiness: finalReadiness,
          liveIntent,
          requireConfirmation,
          maxLivePosition,
          maxOpenPositions: 1,
          candidatesDetected: allCandidates.length,
          laneSummary,
          watchWorthyCount: liveSelected.totalWatchWorthy,
          notAutonomous: true,
          noRealTradeSent: true,
          autoPaperNotRun: true,
          skipSleepMode: skipSleep,
          watchCycle,
          watchCycleSkipped: watchCycleSkipped || undefined,
          watchCycleSkipReason,
          fakeBankroll,
          confirmMinConfirmedLiquidityUsd,
          exitSnapshotPath,
          fakePnL: watchCyclePnL,
          confirmEntry,
          confirmMinutes,
          confirmSnapshotPath,
          entryConfirmation,
          paperExitGuardEnabled: paperExitGuardEnabled || undefined,
          paperExitGuard: paperExitGuardResult,
          preSignalBridge,
          preSignalAnnotation: (() => {
            const m = preSignalBridge?.matchedCandidates.find(
              mc => mc.candidateTicker === chosen?.candidate.ticker,
            );
            if (!m) return undefined;
            return {
              preSignalMatch: true as const,
              preSignalReason: m.matchReason,
              preSignalConfidence: m.signalConfidence,
              preSignalSource: m.signalSource,
              laneLabel: 'PRE_SIGNAL_MATCH' as const,
              watchOnly: true as const,
              planOnlyNotGranted: true as const,
            };
          })(),
          fieldNote,
          fieldTags,
        };

        emitSummary(finalSummary);
        break;
      }

      case 'token:field-summary': {
        const fieldDir = getArgValue('--dir') ?? 'data/token-grab/live-harness';
        const fieldLimit = parseNumberArg('--limit', 20, { integer: true, min: 1 });
        const fieldSince = getArgValue('--since');
        const fieldJson = process.argv.includes('--json');

        const fieldSummary = buildFieldRunSummary({
          dir: fieldDir,
          limit: fieldLimit,
          since: fieldSince,
          generatedAt: new Date().toISOString(),
        });

        if (fieldJson) {
          console.log(JSON.stringify(fieldSummary, null, 2));
        } else {
          console.log(renderFieldRunSummary(fieldSummary));
        }
        break;
      }

      case 'token:presignal-report': {
        const signalsPath = getArgValue('--signals') ?? 'data/token-grab/x-ears/presignals.json';
        const psLimit = parseNumberArg('--limit', 20, { integer: true, min: 1 });
        const psJson = process.argv.includes('--json');

        let rawSignals: unknown = [];
        try {
          rawSignals = JSON.parse(fs.readFileSync(signalsPath, 'utf-8')) as unknown;
        } catch {
          // file missing or unreadable — report will show 0 signals
        }

        const psReport = buildPreSignalReport({
          signalsPath,
          rawSignals,
          limit: psLimit,
          generatedAt: new Date().toISOString(),
        });

        if (psJson) {
          console.log(JSON.stringify(psReport, null, 2));
        } else {
          console.log(renderPreSignalReport(psReport));
        }
        break;
      }

      case 'token:ears-collect': {
        const ecInputPath = getArgValue('--input') ?? 'data/token-grab/x-ears/ears-input.txt';
        const ecOutPath = getArgValue('--out') ?? 'data/token-grab/x-ears/presignals.generated.json';
        const ecSourceRaw = (getArgValue('--source') ?? 'x_manual') as PreSignalSource;
        const ecAppend = process.argv.includes('--append');

        let ecRawContent = '';
        try {
          ecRawContent = fs.readFileSync(ecInputPath, 'utf-8');
        } catch (e) {
          throw new Error(
            `[token:ears-collect] Cannot read input: ${ecInputPath} — ${(e as Error).message}`,
          );
        }

        let ecExisting: PreSignal[] = [];
        if (ecAppend && fs.existsSync(ecOutPath)) {
          try {
            ecExisting = JSON.parse(fs.readFileSync(ecOutPath, 'utf-8')) as PreSignal[];
          } catch {
            ecExisting = [];
          }
        }

        const ecReport = buildEarsCollectorReport({
          inputPath: ecInputPath,
          rawContent: ecRawContent,
          outputPath: ecOutPath,
          source: ecSourceRaw,
          append: ecAppend,
          existingSignals: ecExisting,
          generatedAt: new Date().toISOString(),
        });

        const ecOutDir = path.dirname(ecOutPath);
        fs.mkdirSync(ecOutDir, { recursive: true });
        fs.writeFileSync(ecOutPath, JSON.stringify(ecReport.signals, null, 2), 'utf-8');

        console.log(renderEarsCollectorReport(ecReport));
        break;
      }

      case 'token:ears-watch': {
        const ewInputPath = getArgValue('--input') ?? 'data/token-grab/x-ears/ears-input.txt';
        const ewOutPath = getArgValue('--out') ?? 'data/token-grab/x-ears/presignals.json';
        const ewSourceRaw = (getArgValue('--source') ?? 'x_manual') as PreSignalSource;
        const ewCycles = parseNumberArg('--cycles', 1, { integer: true, min: 0 });
        const ewIntervalSeconds = parseNumberArg('--interval-seconds', 60, { integer: true, min: 1 });
        const ewDryRun = process.argv.includes('--dry-run');
        const ewJson = process.argv.includes('--json');

        const ewSleep = (ms: number): Promise<void> =>
          new Promise(resolve => setTimeout(resolve, ms));

        let ewCycle = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          ewCycle++;
          const ewGeneratedAt = new Date().toISOString();

          let ewRawContent = '';
          try {
            ewRawContent = fs.readFileSync(ewInputPath, 'utf-8');
          } catch (e) {
            throw new Error(
              `[token:ears-watch] Cannot read input: ${ewInputPath} — ${(e as Error).message}`,
            );
          }

          let ewExisting: PreSignal[] = [];
          if (!ewDryRun && fs.existsSync(ewOutPath)) {
            try {
              ewExisting = JSON.parse(fs.readFileSync(ewOutPath, 'utf-8')) as PreSignal[];
            } catch {
              ewExisting = [];
            }
          }

          const ewOutput = runWatchCycle({
            rawContent: ewRawContent,
            existingSignals: ewExisting,
            source: ewSourceRaw,
            generatedAt: ewGeneratedAt,
            cycleNumber: ewCycle,
            inputPath: ewInputPath,
            outputPath: ewOutPath,
            dryRun: ewDryRun,
          });

          if (!ewDryRun && ewOutput.uniqueSignals.length > 0) {
            const ewUpdated = [...ewExisting, ...ewOutput.uniqueSignals];
            const ewOutDir = path.dirname(ewOutPath);
            fs.mkdirSync(ewOutDir, { recursive: true });
            fs.writeFileSync(ewOutPath, JSON.stringify(ewUpdated, null, 2), 'utf-8');
          }

          if (ewJson) {
            console.log(JSON.stringify(ewOutput, null, 2));
          } else {
            console.log(renderWatchCycleReport(ewOutput));
          }

          // Exit if cycle target reached (0 means run forever)
          if (ewCycles > 0 && ewCycle >= ewCycles) break;

          // Sleep before next cycle
          console.log(`\nNext cycle in ${ewIntervalSeconds}s. Press Ctrl+C to stop.\n`);
          await ewSleep(ewIntervalSeconds * 1000);
        }
        break;
      }

      case 'token:ears-rss': {
        const rssConfigPath = getArgValue('--config') ?? 'config/rss-feeds.example.json';
        const rssOutPath = getArgValue('--out') ?? 'data/token-grab/x-ears/presignals.json';
        const rssDryRun = process.argv.includes('--dry-run');
        const rssJson = process.argv.includes('--json');
        const rssGeneratedAt = new Date().toISOString();

        const rssConfig = loadRssConfig(rssConfigPath);

        let rssExisting: PreSignal[] = [];
        if (!rssDryRun && fs.existsSync(rssOutPath)) {
          try {
            rssExisting = JSON.parse(fs.readFileSync(rssOutPath, 'utf-8')) as PreSignal[];
          } catch {
            rssExisting = [];
          }
        }

        const rssFeedResults: FeedResult[] = [];
        for (const feed of rssConfig.feeds) {
          const result = await fetchFeedItems(feed, rssConfig.maxItemsPerFeed);
          rssFeedResults.push({ feed, ...result });
        }

        const rssReport = buildRssAdapterReport({
          feedResults: rssFeedResults,
          existingSignals: rssExisting,
          config: rssConfig,
          generatedAt: rssGeneratedAt,
          dryRun: rssDryRun,
          outputPath: rssOutPath,
        });

        if (!rssDryRun && rssReport.uniqueSignals.length > 0) {
          const rssUpdated = [...rssExisting, ...rssReport.uniqueSignals];
          const rssOutDir = path.dirname(rssOutPath);
          fs.mkdirSync(rssOutDir, { recursive: true });
          fs.writeFileSync(rssOutPath, JSON.stringify(rssUpdated, null, 2), 'utf-8');
        }

        if (rssJson) {
          console.log(JSON.stringify(rssReport, null, 2));
        } else {
          console.log(renderRssAdapterReport(rssReport));
        }
        break;
      }

      case 'token:ears-ingest': {
        const ingestSourcesDir = getArgValue('--sources-dir') ?? 'data/token-grab/x-ears/source-drops';
        const ingestOutPath = getArgValue('--out') ?? 'data/token-grab/x-ears/presignals.json';
        const ingestDefaultSource = (getArgValue('--source') ?? 'x_manual') as PreSignalSource;
        const ingestAppend = process.argv.includes('--append');
        const ingestDryRun = process.argv.includes('--dry-run');
        const ingestJson = process.argv.includes('--json');
        const ingestGeneratedAt = new Date().toISOString();

        // Read all supported files from sources dir
        const INGEST_EXTS = new Set(['.txt', '.md', '.json']);
        let dirEntries: string[] = [];
        try {
          dirEntries = fs.readdirSync(ingestSourcesDir)
            .filter(f => INGEST_EXTS.has(path.extname(f).toLowerCase()))
            .sort();
        } catch (e) {
          throw new Error(`[token:ears-ingest] Cannot read sources dir: ${ingestSourcesDir} — ${(e as Error).message}`);
        }

        const ingestSourceFiles = dirEntries.map(filename => {
          const fullPath = path.join(ingestSourcesDir, filename);
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            return parseSourceFile(fullPath, content, ingestDefaultSource);
          } catch (e) {
            return { filename: fullPath, source: ingestDefaultSource, items: [], error: (e as Error).message };
          }
        });

        // Load existing signals for append/dedup
        let ingestExisting: PreSignal[] = [];
        if (ingestAppend && fs.existsSync(ingestOutPath)) {
          try {
            ingestExisting = JSON.parse(fs.readFileSync(ingestOutPath, 'utf-8')) as PreSignal[];
          } catch {
            ingestExisting = [];
          }
        }

        const ingestReport = buildEarsIngestReport({
          sourceFiles: ingestSourceFiles,
          existingSignals: ingestExisting,
          generatedAt: ingestGeneratedAt,
          dryRun: ingestDryRun,
          outputPath: ingestOutPath,
        });

        if (!ingestDryRun && ingestReport.uniqueSignals.length > 0) {
          const ingestWritten = ingestAppend
            ? [...ingestExisting, ...ingestReport.uniqueSignals]
            : ingestReport.uniqueSignals;
          const ingestOutDir = path.dirname(ingestOutPath);
          fs.mkdirSync(ingestOutDir, { recursive: true });
          fs.writeFileSync(ingestOutPath, JSON.stringify(ingestWritten, null, 2), 'utf-8');
        }

        if (ingestJson) {
          console.log(JSON.stringify(ingestReport, null, 2));
        } else {
          console.log(renderEarsIngestReport(ingestReport));
        }
        break;
      }

      case 'token:ears-auto': {
        const autoConfigPath = getArgValue('--config') ?? 'config/automated-ears.example.json';
        const autoOutPath = getArgValue('--out') ?? 'data/token-grab/x-ears/presignals.json';
        const autoCycles = parseNumberArg('--cycles', 1, { integer: true, min: 1 });
        const autoIntervalSeconds = parseNumberArg('--interval-seconds', 60, { min: 1 });
        const autoDryRun = process.argv.includes('--dry-run');
        const autoJson = process.argv.includes('--json');

        const autoConfig = loadAutomatedEarsConfig(autoConfigPath);

        for (let autoCycle = 1; autoCycle <= autoCycles; autoCycle++) {
          const autoGeneratedAt = new Date().toISOString();
          if (autoCycles > 1) console.log(`\n[ears-auto] cycle ${autoCycle}/${autoCycles}`);

          let autoExisting: PreSignal[] = [];
          if (!autoDryRun && fs.existsSync(autoOutPath)) {
            try {
              autoExisting = JSON.parse(fs.readFileSync(autoOutPath, 'utf-8')) as PreSignal[];
            } catch {
              autoExisting = [];
            }
          }

          const autoConnectorResults: ConnectorResult[] = [];

          // RSS
          if (autoConfig.rss.enabled) {
            const rssFeedResults: FeedResult[] = [];
            for (const feed of autoConfig.rss.feeds) {
              const result = await fetchFeedItems(feed, autoConfig.rss.maxItemsPerFeed);
              rssFeedResults.push({ feed, ...result });
            }
            autoConnectorResults.push(buildRssConnectorResult(rssFeedResults, autoConfig.keywords));
          } else {
            autoConnectorResults.push({
              name: 'rss', source: 'news_manual', enabled: false, skipped: true,
              skipReason: 'DISABLED', itemsFetched: 0, items: [],
            });
          }

          // X, Telegram, Discord
          autoConnectorResults.push(await runXConnector(autoConfig.x, process.env['X_BEARER_TOKEN']));
          autoConnectorResults.push(await runTelegramConnector(autoConfig.telegram, process.env['TELEGRAM_BOT_TOKEN']));
          autoConnectorResults.push(await runDiscordConnector(autoConfig.discord, process.env['DISCORD_BOT_TOKEN']));

          const autoReport = buildAutomatedEarsReport({
            connectorResults: autoConnectorResults,
            existingSignals: autoExisting,
            generatedAt: autoGeneratedAt,
            dryRun: autoDryRun,
            outputPath: autoOutPath,
          });

          if (!autoDryRun && autoReport.uniqueSignals.length > 0) {
            const autoUpdated = [...autoExisting, ...autoReport.uniqueSignals];
            fs.mkdirSync(path.dirname(autoOutPath), { recursive: true });
            fs.writeFileSync(autoOutPath, JSON.stringify(autoUpdated, null, 2), 'utf-8');
          }

          if (autoJson) {
            console.log(JSON.stringify(autoReport, null, 2));
          } else {
            console.log(renderAutomatedEarsReport(autoReport));
          }

          if (autoCycle < autoCycles) {
            await sleep(autoIntervalSeconds * 1000);
          }
        }
        break;
      }

      case 'token:ears-dex': {
        const dexConfigPath = getArgValue('--config') ?? 'config/dex-ears.example.json';
        const dexOutPath = getArgValue('--out') ?? 'data/token-grab/x-ears/presignals.json';
        const dexDryRun = process.argv.includes('--dry-run');
        const dexJson = process.argv.includes('--json');
        const dexChainArg = getArgValue('--chain');
        const dexMinConfArg = getArgValue('--min-confidence') as 'low' | 'medium' | 'high' | undefined;
        const dexGeneratedAt = new Date().toISOString();

        const dexConfig = loadDexEarsConfig(dexConfigPath);
        const dexChain = dexChainArg ?? dexConfig.chain;
        const dexMinConf = dexMinConfArg ?? dexConfig.minConfidence;

        let dexExisting: PreSignal[] = [];
        if (!dexDryRun && fs.existsSync(dexOutPath)) {
          try {
            dexExisting = JSON.parse(fs.readFileSync(dexOutPath, 'utf-8')) as PreSignal[];
          } catch {
            dexExisting = [];
          }
        }

        const dexEndpointResults = await Promise.all([
          dexConfig.endpoints.latestProfiles
            ? fetchLatestProfiles(dexConfig.maxItemsPerEndpoint, dexConfig.timeoutMs)
            : Promise.resolve(null),
          dexConfig.endpoints.latestBoosts
            ? fetchLatestBoosts(dexConfig.maxItemsPerEndpoint, dexConfig.timeoutMs)
            : Promise.resolve(null),
          dexConfig.endpoints.topBoosts
            ? fetchTopBoosts(dexConfig.maxItemsPerEndpoint, dexConfig.timeoutMs)
            : Promise.resolve(null),
        ]);

        const dexReport = buildDexEarsReport({
          endpointResults: dexEndpointResults.filter((r): r is NonNullable<typeof r> => r !== null),
          existingSignals: dexExisting,
          generatedAt: dexGeneratedAt,
          chain: dexChain,
          minConfidence: dexMinConf,
          dryRun: dexDryRun,
          outputPath: dexOutPath,
        });

        if (!dexDryRun && dexReport.uniqueSignals.length > 0) {
          const dexUpdated = [...dexExisting, ...dexReport.uniqueSignals];
          fs.mkdirSync(path.dirname(dexOutPath), { recursive: true });
          fs.writeFileSync(dexOutPath, JSON.stringify(dexUpdated, null, 2), 'utf-8');
        }

        if (dexJson) {
          console.log(JSON.stringify(dexReport, null, 2));
        } else {
          console.log(renderDexEarsReport(dexReport));
        }
        break;
      }

      case 'token:ears-dex-watch': {
        const dwSignals = getArgValue('--signals') ?? 'data/token-grab/x-ears/presignals.dex.json';
        const dwMinutes = Number(getArgValue('--minutes') ?? '10');
        const dwInterval = Number(getArgValue('--interval-seconds') ?? '60');
        const dwChain = getArgValue('--chain') ?? 'solana';
        const dwDryRun = process.argv.includes('--dry-run');
        const dwJson = process.argv.includes('--json');
        const dwSkipSleep = process.argv.includes('--skip-sleep');
        const dwSave = getArgValue('--save');

        if (!Number.isFinite(dwMinutes) || dwMinutes < 0) {
          throw new Error(`[token:ears-dex-watch] --minutes must be a non-negative number`);
        }
        if (!Number.isFinite(dwInterval) || dwInterval <= 0) {
          throw new Error(`[token:ears-dex-watch] --interval-seconds must be a positive number`);
        }
        if (!fs.existsSync(dwSignals)) {
          throw new Error(`[token:ears-dex-watch] Cannot read signals: ${dwSignals}`);
        }

        const dwReport = await runDexWatch({
          signalsPath: dwSignals,
          minutes: dwMinutes,
          intervalSeconds: dwInterval,
          chain: dwChain,
          dryRun: dwDryRun,
          sleepImpl: dwSkipSleep ? () => Promise.resolve() : undefined,
          log: dwJson ? undefined : (msg: string) => console.error(msg),
        });

        if (dwSave) {
          fs.mkdirSync(path.dirname(dwSave), { recursive: true });
          fs.writeFileSync(dwSave, JSON.stringify(dwReport, null, 2), 'utf-8');
          if (!dwJson) console.error(`Saved watch report to ${dwSave}`);
        }

        if (dwJson) {
          console.log(JSON.stringify(dwReport, null, 2));
        } else {
          console.log(renderDexWatchReport(dwReport));
        }
        break;
      }

      case 'token:dex-watch-summary': {
        const dsDir = getArgValue('--dir') ?? 'data/token-grab/dex-watch-runs';
        const dsLimit = Number(getArgValue('--limit') ?? '20');
        const dsJson = process.argv.includes('--json');

        if (!Number.isFinite(dsLimit) || dsLimit <= 0) {
          throw new Error(`[token:dex-watch-summary] --limit must be a positive number`);
        }

        const dsReports = loadWatchReports(dsDir, dsLimit);
        const dsSummary = buildDexWatchSummary(dsReports, dsDir);

        if (dsJson) {
          console.log(JSON.stringify(dsSummary, null, 2));
        } else {
          console.log(renderDexWatchSummary(dsSummary));
        }
        break;
      }

      case 'token:dex-watch-candidates': {
        const dcDir = getArgValue('--dir') ?? 'data/token-grab/dex-watch-runs';
        const dcLimit = Number(getArgValue('--limit') ?? '20');
        const dcJson = process.argv.includes('--json');

        if (!Number.isFinite(dcLimit) || dcLimit <= 0) {
          throw new Error(`[token:dex-watch-candidates] --limit must be a positive number`);
        }

        const dcReports = loadWatchReports(dcDir, dcLimit);
        const dcReport = buildDexWatchCandidatesReport(dcReports, dcDir);

        if (dcJson) {
          console.log(JSON.stringify(dcReport, null, 2));
        } else {
          console.log(renderDexWatchCandidatesReport(dcReport));
        }
        break;
      }

      case 'token:dex-candidate-sim': {
        const csDir = getArgValue('--dir') ?? 'data/token-grab/dex-watch-runs';
        const csLimit = Number(getArgValue('--limit') ?? '20');
        const csBankroll = Number(getArgValue('--fake-bankroll') ?? '20');
        const csPosition = Number(getArgValue('--position-size') ?? '1');
        const csJson = process.argv.includes('--json');

        if (!Number.isFinite(csLimit) || csLimit <= 0) {
          throw new Error(`[token:dex-candidate-sim] --limit must be a positive number`);
        }
        if (!Number.isFinite(csBankroll) || csBankroll < 0) {
          throw new Error(`[token:dex-candidate-sim] --fake-bankroll must be a non-negative number`);
        }
        if (!Number.isFinite(csPosition) || csPosition <= 0) {
          throw new Error(`[token:dex-candidate-sim] --position-size must be a positive number`);
        }

        const csReports = loadWatchReports(csDir, csLimit);
        const csReport = buildDexCandidateSimReport(csReports, {
          dir: csDir,
          fakeBankroll: csBankroll,
          positionSize: csPosition,
        });

        if (csJson) {
          console.log(JSON.stringify(csReport, null, 2));
        } else {
          console.log(renderDexCandidateSimReport(csReport));
        }
        break;
      }

      case 'token:dex-paper-runner': {
        const prConfig = getArgValue('--dex-config') ?? 'config/dex-ears.example.json';
        const prSignalsOut = getArgValue('--signals-out') ?? 'data/token-grab/x-ears/presignals.dex.json';
        const prRunsDir = getArgValue('--runs-dir') ?? 'data/token-grab/dex-watch-runs';
        const prMinutes = Number(getArgValue('--minutes') ?? '10');
        const prInterval = Number(getArgValue('--interval-seconds') ?? '60');
        const prBankroll = Number(getArgValue('--fake-bankroll') ?? '20');
        const prPosition = Number(getArgValue('--position-size') ?? '1');
        const prCycles = Number(getArgValue('--cycles') ?? '1');
        const prJson = process.argv.includes('--json');
        const prSkipSleep = process.argv.includes('--skip-sleep');
        const prFreshOnly = process.argv.includes('--fresh-only');

        if (!fs.existsSync(prConfig)) {
          throw new Error(`[token:dex-paper-runner] Cannot read --dex-config: ${prConfig}`);
        }
        if (!Number.isFinite(prMinutes) || prMinutes < 0) {
          throw new Error(`[token:dex-paper-runner] --minutes must be a non-negative number`);
        }
        if (!Number.isFinite(prInterval) || prInterval <= 0) {
          throw new Error(`[token:dex-paper-runner] --interval-seconds must be a positive number`);
        }
        if (!Number.isFinite(prBankroll) || prBankroll < 0) {
          throw new Error(`[token:dex-paper-runner] --fake-bankroll must be a non-negative number`);
        }
        if (!Number.isFinite(prPosition) || prPosition <= 0) {
          throw new Error(`[token:dex-paper-runner] --position-size must be a positive number`);
        }
        if (!Number.isFinite(prCycles) || prCycles < 1) {
          throw new Error(`[token:dex-paper-runner] --cycles must be >= 1`);
        }

        const prReport = await runDexPaperRunner({
          dexConfigPath: prConfig,
          signalsOut: prSignalsOut,
          runsDir: prRunsDir,
          minutes: prMinutes,
          intervalSeconds: prInterval,
          fakeBankroll: prBankroll,
          positionSize: prPosition,
          cycles: prCycles,
          freshOnly: prFreshOnly,
          sleepImpl: prSkipSleep ? () => Promise.resolve() : undefined,
          log: prJson ? undefined : (msg: string) => console.error(msg),
        });

        if (prJson) {
          console.log(JSON.stringify(prReport, null, 2));
        } else {
          console.log(renderDexPaperRunnerReport(prReport));
        }
        break;
      }

      case 'token:dex-paper-journal': {
        const pjDir = getArgValue('--dir') ?? 'data/token-grab/dex-watch-runs';
        const pjOut = getArgValue('--out') ?? 'data/token-grab/paper-journal/dex-paper-journal.json';
        const pjBankroll = Number(getArgValue('--fake-bankroll') ?? '20');
        const pjPosition = Number(getArgValue('--position-size') ?? '1');
        const pjJson = process.argv.includes('--json');

        if (!Number.isFinite(pjBankroll) || pjBankroll < 0) {
          throw new Error(`[token:dex-paper-journal] --fake-bankroll must be a non-negative number`);
        }
        if (!Number.isFinite(pjPosition) || pjPosition <= 0) {
          throw new Error(`[token:dex-paper-journal] --position-size must be a positive number`);
        }

        const pjJournal = runDexPaperJournal({
          dir: pjDir,
          out: pjOut,
          fakeBankroll: pjBankroll,
          positionSize: pjPosition,
          journaledAt: new Date().toISOString(),
        });

        if (pjJson) {
          console.log(JSON.stringify(pjJournal, null, 2));
        } else {
          console.log(renderDexPaperJournal(pjJournal));
        }
        break;
      }

      case 'token:dex-paper-entry-plan': {
        const epConfig   = getArgValue('--dex-config')    ?? 'config/dex-ears.example.json';
        const epSignals  = getArgValue('--signals-out')   ?? 'data/token-grab/x-ears/presignals.dex.json';
        const epRunsDir  = getArgValue('--runs-dir')      ?? 'data/token-grab/dex-watch-runs';
        const epJournal  = getArgValue('--journal')       ?? 'data/token-grab/paper-journal/dex-paper-journal.json';
        const epOut      = getArgValue('--out')           ?? 'data/token-grab/paper-plans/dex-paper-entry-plan.json';
        const epBankroll = Number(getArgValue('--fake-bankroll')  ?? '20');
        const epPosition = Number(getArgValue('--position-size')  ?? '1');
        const epJson     = process.argv.includes('--json');

        void epConfig; // loaded by the runner's signal file; kept for parity with other dex commands

        if (!Number.isFinite(epBankroll) || epBankroll < 0) {
          throw new Error(`[token:dex-paper-entry-plan] --fake-bankroll must be a non-negative number`);
        }
        if (!Number.isFinite(epPosition) || epPosition <= 0) {
          throw new Error(`[token:dex-paper-entry-plan] --position-size must be a positive number`);
        }

        const epReport = runDexPaperEntryPlanner({
          signalsFile: epSignals,
          runsDir: epRunsDir,
          journalFile: epJournal,
          out: epOut,
          fakeBankroll: epBankroll,
          positionSize: epPosition,
          plannedAt: new Date().toISOString(),
        });

        if (epJson) {
          console.log(JSON.stringify(epReport, null, 2));
        } else {
          console.log(renderDexPaperEntryPlanReport(epReport));
        }
        break;
      }

      case 'token:dex-validation-loop': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderValidationLoopUsage());
          break;
        }
        const vlConfig      = getArgValue('--dex-config')                   ?? 'config/dex-ears.example.json';
        const vlSignals     = getArgValue('--signals-out')                  ?? 'data/token-grab/x-ears/presignals.dex.json';
        const vlRunsDir     = getArgValue('--runs-dir')                     ?? 'data/token-grab/dex-watch-runs';
        const vlJournal     = getArgValue('--journal')                      ?? 'data/token-grab/paper-journal/dex-paper-journal.json';
        const vlPlannerOut  = getArgValue('--planner-out')                  ?? 'data/token-grab/paper-plans/dex-paper-entry-plan.json';
        const vlSummaryOut  = getArgValue('--summary-out')                  ?? 'data/token-grab/validation/dex-validation-loop-summary.json';
        const vlBankroll    = Number(getArgValue('--fake-bankroll')         ?? '20');
        const vlPosition    = Number(getArgValue('--position-size')         ?? '1');
        const vlCycles      = Number(getArgValue('--cycles')                ?? '3');
        const vlMinutes     = Number(getArgValue('--minutes')               ?? '10');
        const vlInterval    = Number(getArgValue('--interval-seconds')      ?? '60');
        const vlSleepMins   = Number(getArgValue('--sleep-between-cycles-minutes') ?? '15');
        const vlJson        = process.argv.includes('--json');

        if (!Number.isFinite(vlBankroll) || vlBankroll < 0) {
          throw new Error(`[token:dex-validation-loop] --fake-bankroll must be a non-negative number`);
        }
        if (!Number.isFinite(vlPosition) || vlPosition <= 0) {
          throw new Error(`[token:dex-validation-loop] --position-size must be a positive number`);
        }
        if (!Number.isFinite(vlCycles) || vlCycles < 1) {
          throw new Error(`[token:dex-validation-loop] --cycles must be >= 1`);
        }
        if (!Number.isFinite(vlMinutes) || vlMinutes < 0) {
          throw new Error(`[token:dex-validation-loop] --minutes must be a non-negative number`);
        }
        if (!Number.isFinite(vlInterval) || vlInterval <= 0) {
          throw new Error(`[token:dex-validation-loop] --interval-seconds must be a positive number`);
        }
        if (!Number.isFinite(vlSleepMins) || vlSleepMins < 0) {
          throw new Error(`[token:dex-validation-loop] --sleep-between-cycles-minutes must be a non-negative number`);
        }
        if (!fs.existsSync(vlConfig)) {
          throw new Error(`[token:dex-validation-loop] Cannot read --dex-config: ${vlConfig}`);
        }

        const vlSummary = await runDexValidationLoop({
          dexConfigPath: vlConfig,
          signalsOut: vlSignals,
          runsDir: vlRunsDir,
          journalOut: vlJournal,
          plannerOut: vlPlannerOut,
          summaryOut: vlSummaryOut,
          fakeBankroll: vlBankroll,
          positionSize: vlPosition,
          cycles: vlCycles,
          minutes: vlMinutes,
          intervalSeconds: vlInterval,
          sleepBetweenCyclesMs: vlSleepMins * 60 * 1000,
          freshOnly: true,
          generatedAt: new Date().toISOString(),
          log: (m) => console.log(m),
        });

        if (vlJson) {
          console.log(JSON.stringify(vlSummary, null, 2));
        } else {
          console.log(renderValidationLoopSummary(vlSummary));
        }
        break;
      }

      case 'token:dex-day-watch': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderDayWatchUsage());
          break;
        }
        const dwConfig     = getArgValue('--dex-config')                   ?? 'config/dex-ears.example.json';
        const dwSignals    = getArgValue('--signals-out')                  ?? 'data/token-grab/x-ears/presignals.dex.json';
        const dwRunsDir    = getArgValue('--runs-dir')                     ?? 'data/token-grab/dex-watch-runs';
        const dwJournal    = getArgValue('--journal')                      ?? 'data/token-grab/paper-journal/dex-paper-journal.json';
        const dwPlannerOut = getArgValue('--planner-out')                  ?? 'data/token-grab/paper-plans/dex-paper-entry-plan.json';
        const dwDayLog     = getArgValue('--day-log')                      ?? 'data/token-grab/day-watch/dex-day-watch.jsonl';
        const dwBankroll   = Number(getArgValue('--fake-bankroll')         ?? '20');
        const dwPosition   = Number(getArgValue('--position-size')         ?? '1');
        const dwCycles     = Number(getArgValue('--cycles')                ?? '24');
        const dwMinutes    = Number(getArgValue('--minutes')               ?? '10');
        const dwInterval   = Number(getArgValue('--interval-seconds')      ?? '60');
        const dwSleepMins  = Number(getArgValue('--sleep-between-cycles-minutes') ?? '20');

        if (!Number.isFinite(dwBankroll) || dwBankroll < 0) {
          throw new Error(`[token:dex-day-watch] --fake-bankroll must be a non-negative number`);
        }
        if (!Number.isFinite(dwPosition) || dwPosition <= 0) {
          throw new Error(`[token:dex-day-watch] --position-size must be a positive number`);
        }
        if (!Number.isFinite(dwCycles) || dwCycles < 1) {
          throw new Error(`[token:dex-day-watch] --cycles must be >= 1`);
        }
        if (!Number.isFinite(dwMinutes) || dwMinutes < 0) {
          throw new Error(`[token:dex-day-watch] --minutes must be a non-negative number`);
        }
        if (!Number.isFinite(dwInterval) || dwInterval <= 0) {
          throw new Error(`[token:dex-day-watch] --interval-seconds must be a positive number`);
        }
        if (!Number.isFinite(dwSleepMins) || dwSleepMins < 0) {
          throw new Error(`[token:dex-day-watch] --sleep-between-cycles-minutes must be a non-negative number`);
        }
        if (!fs.existsSync(dwConfig)) {
          throw new Error(`[token:dex-day-watch] Cannot read --dex-config: ${dwConfig}`);
        }

        const stopSignal = { stopped: false };
        process.on('SIGINT', () => {
          console.log('\n  [day-watch] Ctrl+C received — stopping after current cycle…');
          stopSignal.stopped = true;
        });

        const dwResult = await runDexDayWatch({
          dexConfigPath: dwConfig,
          signalsOut: dwSignals,
          runsDir: dwRunsDir,
          journalOut: dwJournal,
          plannerOut: dwPlannerOut,
          dayLogPath: dwDayLog,
          fakeBankroll: dwBankroll,
          positionSize: dwPosition,
          cycles: dwCycles,
          minutes: dwMinutes,
          intervalSeconds: dwInterval,
          sleepBetweenCyclesMs: dwSleepMins * 60 * 1000,
          stopSignal,
          log: (m) => console.log(m),
        });

        console.log(`\n  Day watch complete. ${dwResult.cyclesRun} cycles written to ${dwResult.dayLogPath}`);
        console.log(`  Run: npm run token:dex-day-report -- --day-log ${dwResult.dayLogPath}`);
        break;
      }

      case 'token:dex-day-report': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderDayReportUsage());
          break;
        }
        const drDayLog = getArgValue('--day-log') ?? 'data/token-grab/day-watch/dex-day-watch.jsonl';
        const drJson   = process.argv.includes('--json');

        const drEntries = loadDayLog(drDayLog);
        const drReport  = buildDayReport(drEntries, new Date().toISOString());

        if (drJson) {
          console.log(JSON.stringify(drReport, null, 2));
        } else {
          console.log(renderDayReport(drReport));
        }
        break;
      }

      case 'token:dex-paper-position-tracker': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderDexPaperPositionTrackerUsage());
          break;
        }
        const ptRunsDir   = getArgValue('--runs-dir')           ?? 'data/token-grab/dex-watch-runs';
        const ptPlanner   = getArgValue('--planner')            ?? 'data/token-grab/paper-plans/dex-paper-entry-plan.json';
        const ptDayLog    = getArgValue('--day-log');
        const ptOut       = getArgValue('--out')                ?? 'data/token-grab/paper-positions/dex-paper-positions.json';
        const ptSize      = Number(getArgValue('--position-size')      ?? '1');
        const ptStop      = Number(getArgValue('--stop-loss-pct')      ?? '-20');
        const ptTp        = Number(getArgValue('--take-profit-pct')    ?? '25');
        const ptRunner    = Number(getArgValue('--runner-target-pct')  ?? '50');
        const ptMaxHold   = Number(getArgValue('--max-hold-minutes')   ?? '20');
        const ptJson      = process.argv.includes('--json');

        if (!Number.isFinite(ptSize) || ptSize <= 0) {
          throw new Error(`[token:dex-paper-position-tracker] --position-size must be a positive number`);
        }
        if (!Number.isFinite(ptStop) || ptStop >= 0) {
          throw new Error(`[token:dex-paper-position-tracker] --stop-loss-pct must be negative`);
        }
        if (!Number.isFinite(ptTp) || ptTp <= 0) {
          throw new Error(`[token:dex-paper-position-tracker] --take-profit-pct must be positive`);
        }
        if (!Number.isFinite(ptRunner) || ptRunner <= 0) {
          throw new Error(`[token:dex-paper-position-tracker] --runner-target-pct must be positive`);
        }
        if (!Number.isFinite(ptMaxHold) || ptMaxHold <= 0) {
          throw new Error(`[token:dex-paper-position-tracker] --max-hold-minutes must be positive`);
        }

        const ptReport = runDexPaperPositionTracker({
          plannerFile: ptPlanner,
          dayLogFile: ptDayLog ?? undefined,
          runsDir: ptRunsDir,
          out: ptOut,
          positionSize: ptSize,
          stopLossPct: ptStop,
          takeProfitPct: ptTp,
          runnerTargetPct: ptRunner,
          maxHoldMinutes: ptMaxHold,
          generatedAt: new Date().toISOString(),
        });

        if (ptJson) {
          console.log(JSON.stringify(ptReport, null, 2));
        } else {
          console.log(renderDexPaperPositionTrackerReport(ptReport));
        }
        break;
      }

      case 'token:dex-legitimacy-report': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderDexLegitimacyReportUsage());
          break;
        }
        const lrDayLog   = getArgValue('--day-log')   ?? 'data/token-grab/day-watch/dex-day-watch-today.jsonl';
        const lrRunsDir  = getArgValue('--runs-dir')  ?? 'data/token-grab/dex-watch-runs';
        const lrPositions = getArgValue('--positions') ?? 'data/token-grab/paper-positions/dex-paper-positions-today.json';
        const lrOut      = getArgValue('--out')       ?? 'data/token-grab/legitimacy/dex-legitimacy-report.json';
        const lrJson     = process.argv.includes('--json');

        const lrReport = runDexLegitimacyReport({
          dayLogPath: lrDayLog,
          runsDir: lrRunsDir,
          positionsPath: lrPositions,
          outPath: lrOut,
          generatedAt: new Date().toISOString(),
        });

        if (lrJson) {
          console.log(JSON.stringify(lrReport, null, 2));
        } else {
          console.log(renderDexLegitimacyReport(lrReport));
        }
        break;
      }

      case 'token:dex-winner-candidates': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderDexWinnerCandidateReportUsage());
          break;
        }
        const wcLegitimacy = getArgValue('--legitimacy') ?? 'data/token-grab/legitimacy/dex-legitimacy-report-today.json';
        const wcDayLog     = getArgValue('--day-log');
        const wcPositions  = getArgValue('--positions');
        const wcOut        = getArgValue('--out') ?? 'data/token-grab/legitimacy/dex-winner-candidates-today.json';
        const wcDebug      = process.argv.includes('--debug');
        const wcJson       = process.argv.includes('--json');

        const wcReport = runDexWinnerCandidateReport({
          legitimacyPath: wcLegitimacy,
          dayLogPath: wcDayLog,
          positionsPath: wcPositions,
          outPath: wcOut,
          debug: wcDebug,
          generatedAt: new Date().toISOString(),
        });

        if (wcJson) {
          console.log(JSON.stringify(wcReport, null, 2));
        } else {
          console.log(renderDexWinnerCandidateReport(wcReport, wcDebug));
        }
        break;
      }

      case 'token:dex-candidate-safety-enrich': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderDexCandidateSafetyEnrichUsage());
          break;
        }
        const cseOut        = getArgValue('--out')        ?? 'data/token-grab/legitimacy/dex-winner-candidates-enriched-today.json';
        const cseCandidates = getArgValue('--candidates') ?? 'data/token-grab/legitimacy/dex-winner-candidates-today.json';
        const cseRpcUrl     = getArgValue('--rpc-url');
        const cseOffline    = process.argv.includes('--offline');
        const cseDebug      = process.argv.includes('--debug');
        const cseJson       = process.argv.includes('--json');

        const cseReport = await runDexCandidateSafetyEnrich({
          candidatesPath: cseCandidates,
          outPath: cseOut,
          rpcUrl: cseRpcUrl ?? undefined,
          offline: cseOffline,
          debug: cseDebug,
          generatedAt: new Date().toISOString(),
        });

        if (cseJson) {
          console.log(JSON.stringify(cseReport, null, 2));
        } else {
          console.log(renderDexCandidateSafetyEnrichReport(cseReport, cseDebug));
        }
        break;
      }

      case 'token:ripper-session': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderRipperSessionUsage());
          break;
        }
        const rsCandidates  = getArgValue('--candidates')    ?? 'data/token-grab/legitimacy/dex-winner-candidates-today.json';
        const rsState       = getArgValue('--session-state') ?? 'data/token-grab/ripper/ripper-session.json';
        const rsMinScore    = getArgValue('--min-score');
        const rsMaxHold     = getArgValue('--max-hold-minutes');
        const rsNoPrime     = process.argv.includes('--no-prime-required');
        const rsReset       = process.argv.includes('--reset');
        const rsDebug       = process.argv.includes('--debug');

        if (rsReset && fs.existsSync(rsState)) fs.unlinkSync(rsState);

        const rsConfig: Record<string, number | boolean> = {};
        if (rsMinScore) rsConfig['minScoreToBuy'] = parseInt(rsMinScore, 10);
        if (rsMaxHold)  rsConfig['maxHoldMinutes'] = parseInt(rsMaxHold, 10);
        if (rsNoPrime)  rsConfig['requirePrimeWindow'] = false;

        const rsResult = runRipperSession({
          candidatesPath: rsCandidates,
          sessionStatePath: rsState,
          config: rsConfig as Parameters<typeof runRipperSession>[0]['config'],
          debug: rsDebug,
        });

        console.log(renderRipperSessionSummary(rsResult, rsDebug));
        break;
      }

      case 'token:ripper-autopilot': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderRipperAutopilotUsage());
          break;
        }
        const raCandidates    = getArgValue('--candidates')       ?? 'data/token-grab/legitimacy/dex-winner-candidates-today.json';
        const raState         = getArgValue('--session-state')    ?? 'data/token-grab/ripper/ripper-session.json';
        const raIntervalStr   = getArgValue('--interval-minutes') ?? '5';
        const raCyclesStr     = getArgValue('--cycles')           ?? '0';
        const raMinScore      = getArgValue('--min-score');
        const raMaxHold       = getArgValue('--max-hold-minutes');
        const raNoPrime       = process.argv.includes('--no-prime-required');
        const raReset         = process.argv.includes('--reset');
        const raDebug         = process.argv.includes('--debug');

        if (raReset && fs.existsSync(raState)) fs.unlinkSync(raState);

        const raConfig: Record<string, number | boolean> = {};
        if (raMinScore) raConfig['minScoreToBuy'] = parseInt(raMinScore, 10);
        if (raMaxHold)  raConfig['maxHoldMinutes'] = parseInt(raMaxHold, 10);
        if (raNoPrime)  raConfig['requirePrimeWindow'] = false;

        const raIntervalMs = parseFloat(raIntervalStr) * 60 * 1000;
        const raCycles     = parseInt(raCyclesStr, 10);

        console.log(`[ripper-autopilot] Starting — interval=${raIntervalStr}m  maxCycles=${raCycles === 0 ? 'unlimited' : raCycles}  REAL TRADING LOCKED`);

        await runRipperAutopilot({
          candidatesPath: raCandidates,
          sessionStatePath: raState,
          config: raConfig as Parameters<typeof runRipperSession>[0]['config'],
          debug: raDebug,
          intervalMs: raIntervalMs,
          maxCycles: raCycles === 0 ? undefined : raCycles,
          onCycle: (result, cycleNum) => {
            console.log(`\n[ripper-autopilot] Cycle ${cycleNum}`);
            console.log(renderRipperSessionSummary(result, raDebug));
          },
        });
        break;
      }

      case 'token:ripper-dashboard': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderRipperDashboardUsage());
          break;
        }
        const rdState = getArgValue('--session-state') ?? 'data/token-grab/ripper/ripper-session.json';
        const rdSessionState = loadOrCreateSessionState(rdState, new Date().toISOString());
        console.log(renderRipperDashboard(rdSessionState));
        break;
      }

      case 'token:ripper-ears': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderRipperEarsUsage());
          break;
        }
        const reInput    = getArgValue('--input')  ?? 'data/token-grab/ripper/ripper-ears-input.json';
        const reFormatRaw = getArgValue('--format') ?? 'ear-signals';
        const reFormat: EarsInputFormat = reFormatRaw === 'dexscreener' ? 'dexscreener' : 'ear-signals';
        const reMinScore  = getArgValue('--min-score');
        const reDebug     = process.argv.includes('--debug');

        const reConfig: Record<string, number> = {};
        if (reMinScore) reConfig['minScoreToBuy'] = parseInt(reMinScore, 10);

        const reResult = runRipperEarsReport({
          inputPath: reInput,
          format: reFormat,
          config: reConfig as Parameters<typeof runRipperEarsReport>[0]['config'],
        });

        console.log(renderRipperEarsReport(reResult, reDebug));
        break;
      }

      case 'token:ripper-near-miss': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderRipperNearMissUsage());
          break;
        }
        const rnInput    = getArgValue('--input')  ?? 'data/token-grab/ripper/ripper-ears-input.json';
        const rnFormatRaw = getArgValue('--format') ?? 'ear-signals';
        const rnFormat: EarsInputFormat = rnFormatRaw === 'dexscreener' ? 'dexscreener' : 'ear-signals';

        const rnResult = runRipperNearMiss({ inputPath: rnInput, format: rnFormat });
        console.log(renderRipperNearMissReport(rnResult));
        break;
      }

      case 'token:fresh-pool-feed': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderFreshPoolFeedUsage());
          break;
        }
        const fpfRunsDir   = getArgValue('--runs-dir') ?? 'data/token-grab/dex-watch-runs';
        const fpfOutput    = getArgValue('--output')   ?? 'data/token-grab/ripper/ripper-ears-input.json';
        const fpfMaxAge    = getArgValue('--max-age-minutes');
        const fpfIncludeOld = process.argv.includes('--include-old');
        const fpfDebug     = process.argv.includes('--debug');

        const fpfResult = runFreshPoolFeed({
          runsDir: fpfRunsDir,
          outputPath: fpfOutput,
          maxAgeMinutes: fpfMaxAge != null ? parseFloat(fpfMaxAge) : undefined,
          includeOld: fpfIncludeOld,
        });
        console.log(renderFreshPoolFeedResult(fpfResult, fpfDebug));
        break;
      }

      case 'token:ripper-paper-cycle': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderRipperPaperCycleUsage());
          break;
        }
        const rpcRunsDir   = getArgValue('--runs-dir')   ?? 'data/token-grab/dex-watch-runs';
        const rpcCyclesDir = getArgValue('--cycles-dir') ?? 'data/token-grab/ripper/cycles';

        const { provider: rpcClusterProvider, configNote: rpcClusterNote } =
          createClusterRiskProvider();
        if (rpcClusterNote) console.warn(`[cluster-risk] ${rpcClusterNote}`);

        const rpcResult = await runRipperPaperCycle({
          runsDir:             rpcRunsDir,
          cyclesDir:           rpcCyclesDir,
          clusterRiskProvider: rpcClusterProvider,
        });
        console.log(renderRipperPaperCycleResult(rpcResult));
        break;
      }

      case 'token:ripper-paper-loop': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderRipperPaperLoopUsage());
          break;
        }
        const rplRunsDir      = getArgValue('--runs-dir')          ?? 'data/token-grab/dex-watch-runs';
        const rplCyclesDir    = getArgValue('--cycles-dir')        ?? 'data/token-grab/ripper/cycles';
        const rplStopFile     = getArgValue('--stop-file');
        const rplInterval     = parseNumberArg('--interval-seconds', 180, { min: 1 });
        const rplMaxCycles    = parseNumberArg('--max-cycles',       10,  { min: 1 });
        const rplRefreshSrc   = process.argv.includes('--refresh-source');

        const { provider: rplClusterProvider, configNote: rplClusterNote } =
          createClusterRiskProvider();
        if (rplClusterNote) console.warn(`[cluster-risk] ${rplClusterNote}`);

        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('  TOKEN GRAB — RIPPER PAPER LOOP');
        console.log('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY]');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`  max cycles     : ${rplMaxCycles}`);
        console.log(`  interval       : ${rplInterval}s`);
        if (rplStopFile)    console.log(`  stop file      : ${rplStopFile}`);
        if (rplRefreshSrc)  console.log(`  refresh source : YES (dex-day-watch before each cycle)`);
        console.log('');

        const rplResult = await runRipperPaperLoop({
          runsDir:             rplRunsDir,
          cyclesDir:           rplCyclesDir,
          clusterRiskProvider: rplClusterProvider,
          intervalSeconds:     rplInterval,
          maxCycles:           rplMaxCycles,
          stopFilePath:        rplStopFile ?? undefined,
          refreshSource:       rplRefreshSrc,
          _refreshSource: rplRefreshSrc
            ? async () => {
                try {
                  await runDexDayWatch({
                    dexConfigPath:         'config/dex-ears.example.json',
                    signalsOut:            'data/token-grab/x-ears/presignals.dex.json',
                    runsDir:               rplRunsDir,
                    journalOut:            'data/token-grab/paper-journal/dex-paper-journal.json',
                    plannerOut:            'data/token-grab/paper-plans/dex-paper-entry-plan.json',
                    dayLogPath:            'data/token-grab/day-watch/dex-day-watch.jsonl',
                    fakeBankroll:          20,
                    positionSize:          1,
                    cycles:                1,
                    minutes:               1,
                    intervalSeconds:       30,
                    sleepBetweenCyclesMs:  0,
                  });
                  return { success: true, note: 'dex-day-watch cycle completed' };
                } catch (err) {
                  return { success: false, note: err instanceof Error ? err.message : 'dex-day-watch failed' };
                }
              }
            : undefined,
          onCycleComplete: (cycleResult, cycleNumber, sourceRefresh) => {
            console.log(renderLoopCycleLine(cycleResult, cycleNumber, rplMaxCycles, sourceRefresh));
          },
        });
        console.log(renderRipperPaperLoopResult(rplResult, rplMaxCycles));
        break;
      }

      case 'token:ripper-near-miss-report': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderRipperNearMissReportUsage());
          break;
        }
        // Collect all paths after --input until the next --flag (supports shell glob expansion)
        const rnmrInputPaths: string[] = [];
        const rnmrFlagIdx = process.argv.indexOf('--input');
        if (rnmrFlagIdx !== -1) {
          for (let i = rnmrFlagIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rnmrInputPaths.push(process.argv[i]);
          }
        }
        if (rnmrInputPaths.length === 0) {
          console.error('[token:ripper-near-miss-report] No --input files specified.');
          console.error(`  Usage: npm run token:ripper-near-miss-report -- --input data/token-grab/ripper/cycles/cycle-*.jsonl`);
          process.exit(1);
        }
        const rnmrTopN = parseNumberArg('--top-n', 20, { integer: true, min: 1 });
        const rnmrResult = runCycleNearMissReport({ inputPaths: rnmrInputPaths, topN: rnmrTopN });
        console.log(renderCycleNearMissReport(rnmrResult));
        break;
      }

      case 'token:ripper-feed': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderRipperFeedUsage());
          break;
        }
        const rfOutput = getArgValue('--output') ?? 'data/token-grab/ripper/ripper-ears-input.json';
        const rfResult = runRipperFeed({ outputPath: rfOutput });
        console.log(renderRipperFeedResult(rfResult));
        break;
      }

      case 'token:live-fixture-capture': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderLiveFixtureCaptureUsage());
          break;
        }
        const lfcInput   = getArgValue('--input')   ?? 'data/token-grab/ripper/ripper-ears-input.json';
        const lfcOutput  = getArgValue('--output')  ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const lfcFmtRaw  = getArgValue('--format')  ?? 'ear-signals';
        const lfcFormat: EarsInputFormat = lfcFmtRaw === 'dexscreener' ? 'dexscreener' : 'ear-signals';
        const lfcReset   = process.argv.includes('--reset');
        const lfcDebug   = process.argv.includes('--debug');

        const { provider: lfcClusterProvider, configNote: lfcClusterNote } =
          createClusterRiskProvider();
        if (lfcClusterNote) console.warn(`[cluster-risk] ${lfcClusterNote}`);

        const lfcResult = await runLiveFixtureCapture({
          inputPath: lfcInput,
          outputPath: lfcOutput,
          format: lfcFormat,
          reset: lfcReset,
          clusterRiskProvider: lfcClusterProvider,
        });
        console.log(renderCaptureResult(lfcResult, lfcDebug));
        break;
      }

      case 'token:live-fixture-report': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderLiveFixtureReportUsage());
          break;
        }
        const lfrFixtures = getArgValue('--fixtures') ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const lfrResult   = runLiveFixtureReport(lfrFixtures);
        console.log(renderFixtureReport(lfrResult));
        break;
      }

      case 'token:live-fixture-autopsy': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderLiveFixtureAutopsyUsage());
          break;
        }
        const lfaFixtures = getArgValue('--fixtures') ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const lfaResult   = runLiveFixtureAutopsy(lfaFixtures);
        console.log(renderAutopsyReport(lfaResult));
        break;
      }

      case 'token:prime-gate-audit': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderPrimeGateAuditUsage());
          break;
        }
        const pgaFixtures     = getArgValue('--fixtures') ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const pgaStrictPreview = process.argv.includes('--strict-preview');
        const pgaResult = runPrimeGateAudit({ inputPath: pgaFixtures, strictPreview: pgaStrictPreview });
        console.log(renderPrimeGateAuditReport(pgaResult));
        break;
      }

      case 'token:holder-risk-audit': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderHolderRiskAuditUsage());
          break;
        }
        const hraFixtures = getArgValue('--fixtures') ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const hraResult   = runHolderRiskAudit({ inputPath: hraFixtures });
        console.log(renderHolderRiskAuditReport(hraResult));
        break;
      }

      case 'token:fixture-holder-enrich': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderFixtureHolderEnrichUsage());
          break;
        }
        const fheInput    = getArgValue('--input');
        const fheOutput   = getArgValue('--output');
        const fheLimit    = getArgValue('--limit')    ? parseInt(getArgValue('--limit')!,    10) : undefined;
        const fheDelay    = getArgValue('--delay-ms') ? parseInt(getArgValue('--delay-ms')!, 10) : undefined;
        const fheRpcUrl   = getArgValue('--rpc-url');
        const fheForce    = process.argv.includes('--force');
        const fheOffline  = process.argv.includes('--offline');
        const fheDryRun   = process.argv.includes('--dry-run');
        const fheResult   = await runFixtureHolderEnrich({
          inputPath:  fheInput,
          outputPath: fheOutput,
          limitN:     fheLimit,
          delayMs:    fheDelay,
          rpcUrl:     fheRpcUrl,
          force:      fheForce,
          offline:    fheOffline,
          dryRun:     fheDryRun,
        });
        console.log(renderFixtureHolderEnrichReport(fheResult));
        break;
      }

      case 'token:fixture-quote-preview': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderFixtureQuotePreviewUsage());
          break;
        }
        const fqpInput       = getArgValue('--input');
        const fqpOutput      = getArgValue('--output');
        const fqpLimit       = getArgValue('--limit')     ? parseInt(getArgValue('--limit')!,     10) : undefined;
        const fqpDelay       = getArgValue('--delay-ms')  ? parseInt(getArgValue('--delay-ms')!,  10) : undefined;
        const fqpAmountUsd   = getArgValue('--amount-usd') ? parseFloat(getArgValue('--amount-usd')!) : undefined;
        const fqpForce       = process.argv.includes('--force');
        const fqpOffline     = process.argv.includes('--offline');
        const fqpDryRun      = process.argv.includes('--dry-run');
        const fqpIncludeWatch = process.argv.includes('--include-watch');
        const fqpResult      = await runFixtureQuotePreview({
          inputPath:    fqpInput,
          outputPath:   fqpOutput,
          limitN:       fqpLimit,
          delayMs:      fqpDelay,
          amountUsd:    fqpAmountUsd,
          force:        fqpForce,
          offline:      fqpOffline,
          dryRun:       fqpDryRun,
          includeWatch: fqpIncludeWatch,
        });
        console.log(renderFixtureQuotePreviewReport(fqpResult));
        break;
      }

      case 'token:autonomy-readiness-audit': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:autonomy-readiness-audit — classify fixture readiness for autonomous trading');
          break;
        }
        const araInput  = getArgValue('--input') ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const araResult = runAutonomyReadinessAudit({ inputPath: araInput });
        console.log(renderAutonomyReadinessAuditReport(araResult));
        break;
      }

      case 'token:fixture-cluster-enrich': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderFixtureClusterEnrichUsage());
          break;
        }
        const fceInput   = getArgValue('--input');
        const fceOutput  = getArgValue('--output');
        const fceLimit   = getArgValue('--limit')    ? parseInt(getArgValue('--limit')!,    10) : undefined;
        const fceDelay   = getArgValue('--delay-ms') ? parseInt(getArgValue('--delay-ms')!, 10) : undefined;
        const fceApiUrl  = getArgValue('--api-url');
        const fceApiKey  = getArgValue('--api-key');
        const fceForce   = process.argv.includes('--force');
        const fceOffline = process.argv.includes('--offline');
        const fceDryRun  = process.argv.includes('--dry-run');
        const fceAll     = process.argv.includes('--all');
        const fceResult  = await runFixtureClusterEnrich({
          inputPath:  fceInput,
          outputPath: fceOutput,
          limitN:     fceLimit,
          delayMs:    fceDelay,
          apiUrl:     fceApiUrl ?? undefined,
          apiKey:     fceApiKey ?? undefined,
          force:      fceForce,
          offline:    fceOffline,
          dryRun:     fceDryRun,
          all:        fceAll,
        });
        console.log(renderFixtureClusterEnrichReport(fceResult));
        break;
      }

      case 'token:cluster-risk-audit': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:cluster-risk-audit — audit cluster risk coverage in live fixtures');
          break;
        }
        const craInput  = getArgValue('--input') ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const craResult = runClusterRiskAudit({ inputPath: craInput });
        console.log(renderClusterRiskAuditReport(craResult));
        break;
      }

      case 'token:bubblemaps-observation-report': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:bubblemaps-observation-report — summarize BubbleMaps cluster outcomes from live fixtures');
          break;
        }
        const bmorInput = getArgValue('--input') ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const bmorSinceMinutes = getArgValue('--since-minutes') != null
          ? parseNumberArg('--since-minutes', 0, { min: 0 })
          : undefined;
        const bmorResult = runBubbleMapsObservationReport({ inputPath: bmorInput, sinceMinutes: bmorSinceMinutes });
        console.log(renderBubbleMapsObservationReport(bmorResult));
        break;
      }

      case 'token:outcome-tracker': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:outcome-tracker — fetch current prices and track outcomes for FUTURE_AUTONOMY_CANDIDATE fixtures');
          break;
        }
        const otInput  = getArgValue('--input') ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const otResult = await runOutcomeTracker({ inputPath: otInput });
        console.log(renderOutcomeTrackerReport(otResult));
        break;
      }

      case 'token:outcome-autopsy': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:outcome-autopsy — read-only autopsy comparing FUTURE_AUTONOMY_CANDIDATE winners vs losers');
          break;
        }
        const oaInput  = getArgValue('--input') ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const oaResult = await runOutcomeAutopsy({ inputPath: oaInput });
        console.log(renderOutcomeAutopsyReport(oaResult));
        break;
      }

      case 'token:outcome-tracker-v2': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:outcome-tracker-v2 — checkpoint tracking and exit simulation for FUTURE_AUTONOMY_CANDIDATE fixtures');
          break;
        }
        const otv2Input  = getArgValue('--input')       ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const otv2Watch  = getArgValue('--watch-input') ?? 'data/token-grab/outcomes/outcome-watch-snapshots.jsonl';
        const otv2Result = await runOutcomeTrackerV2({ inputPath: otv2Input, watchInputPath: otv2Watch });
        console.log(renderOutcomeTrackerV2Report(otv2Result));
        break;
      }

      case 'token:resolved-ledger': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:resolved-ledger — build/update durable JSONL ledger of resolved FUTURE_AUTONOMY_CANDIDATE outcomes');
          break;
        }
        const rlInput  = getArgValue('--input')       ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const rlWatch  = getArgValue('--watch-input') ?? 'data/token-grab/outcomes/outcome-watch-snapshots.jsonl';
        const rlLedger = getArgValue('--ledger')      ?? 'data/token-grab/outcomes/resolved-candidate-ledger.jsonl';
        const rlResult = await runResolvedLedger({ inputPath: rlInput, watchInputPath: rlWatch, ledgerPath: rlLedger });
        console.log(renderResolvedLedgerReport(rlResult));
        break;
      }

      case 'token:ledger-analytics': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:ledger-analytics — read-only analytics report over resolved-candidate-ledger.jsonl');
          break;
        }
        const laLedger = getArgValue('--ledger') ?? 'data/token-grab/outcomes/resolved-candidate-ledger.jsonl';
        const laResult = runLedgerAnalytics({ ledgerPath: laLedger });
        console.log(renderLedgerAnalyticsReport(laResult));
        break;
      }

      case 'token:outcome-watch-session': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:outcome-watch-session — watch FUTURE_AUTONOMY_CANDIDATE prices over time and store checkpoint snapshots');
          break;
        }
        const owsInput   = getArgValue('--input')  ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const owsOutput  = getArgValue('--output') ?? 'data/token-grab/outcomes/outcome-watch-snapshots.jsonl';
        const owsCycles  = parseNumberArg('--cycles', 1, { integer: true, min: 1 });
        const owsInterval = parseNumberArg('--interval-seconds', 60, { min: 0 });
        const owsLimitRaw = getArgValue('--limit');
        const owsLimit   = owsLimitRaw != null ? parseInt(owsLimitRaw, 10) : undefined;
        const owsResult  = await runOutcomeWatchSession({
          inputPath: owsInput, outputPath: owsOutput,
          cycles: owsCycles, intervalSeconds: owsInterval,
          limit: owsLimit,
        });
        console.log(renderOutcomeWatchSessionReport(owsResult));
        break;
      }

      case 'token:quote-preview-audit': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:quote-preview-audit — audit quote/slippage coverage in live fixtures');
          break;
        }
        const qpaInput  = getArgValue('--input') ?? 'data/token-grab/ripper/live-fixtures.jsonl';
        const qpaResult = runQuotePreviewAudit({ inputPath: qpaInput });
        console.log(renderQuotePreviewAuditReport(qpaResult));
        break;
      }

      case 'token:ripper-approved-outcomes': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log(renderRipperApprovedOutcomesUsage());
          break;
        }
        const raoPaths: string[] = [];
        const raoFlagIdx = process.argv.indexOf('--input');
        if (raoFlagIdx !== -1) {
          for (let i = raoFlagIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            raoPaths.push(process.argv[i]);
          }
        }
        if (raoPaths.length === 0) {
          console.error('[token:ripper-approved-outcomes] No --input files specified.');
          console.error('  Usage: npm run token:ripper-approved-outcomes -- --input data/token-grab/ripper/cycles/cycle-*.jsonl');
          process.exit(1);
        }
        const raoOut = getArgValue('--out') ?? 'data/token-grab/ripper/outcomes/ripper-approved-outcomes.json';
        const raoCheckpointLabel = getArgValue('--checkpoint-label');
        const raoResult = await runRipperApprovedOutcomes({
          inputPaths: raoPaths,
          outPath: raoOut,
          checkpointLabel: raoCheckpointLabel,
        });
        console.log(renderRipperApprovedOutcomes(raoResult));
        break;
      }

      case 'token:ripper-approved-autopsy': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:ripper-approved-autopsy — compare approved ripper candidates across saved outcome checkpoint JSON files');
          console.log('Usage: npm run token:ripper-approved-autopsy -- --input data/token-grab/ripper/outcomes/ripper-approved-outcomes-*.json');
          break;
        }
        const raaPaths: string[] = [];
        const raaFlagIdx = process.argv.indexOf('--input');
        if (raaFlagIdx !== -1) {
          for (let i = raaFlagIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            raaPaths.push(process.argv[i]);
          }
        }
        if (raaPaths.length === 0) {
          console.error('[token:ripper-approved-autopsy] No --input files specified.');
          console.error('  Usage: npm run token:ripper-approved-autopsy -- --input data/token-grab/ripper/outcomes/ripper-approved-outcomes-*.json');
          process.exit(1);
        }
        const raaResult = runRipperApprovedAutopsy({ inputPaths: raaPaths });
        console.log(renderRipperApprovedAutopsy(raaResult));
        break;
      }

      case 'token:ripper-entry-sim': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:ripper-entry-sim — simulate stricter/delayed entry rules against ripper cycle artifacts');
          console.log('Usage: npm run token:ripper-entry-sim -- --input <cycle-jsonl...> [--outcomes <outcome-json...>]');
          break;
        }
        const resPaths: string[] = [];
        const resInputIdx = process.argv.indexOf('--input');
        if (resInputIdx !== -1) {
          for (let i = resInputIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            resPaths.push(process.argv[i]);
          }
        }
        if (resPaths.length === 0) {
          console.error('[token:ripper-entry-sim] No --input cycle files specified.');
          console.error('  Usage: npm run token:ripper-entry-sim -- --input data/token-grab/ripper/cycles/cycle-*.jsonl');
          process.exit(1);
        }
        const resOutcomePaths: string[] = [];
        const resOutcomeIdx = process.argv.indexOf('--outcomes');
        if (resOutcomeIdx !== -1) {
          for (let i = resOutcomeIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            resOutcomePaths.push(process.argv[i]);
          }
        }
        const resResult = runRipperEntrySim({
          inputPaths:   resPaths,
          outcomePaths: resOutcomePaths.length > 0 ? resOutcomePaths : undefined,
        });
        console.log(renderRipperEntrySim(resResult));
        break;
      }

      case 'token:ripper-delayed-watch': {
        if (process.argv.includes('--help') || process.argv.includes('-h')) {
          console.log('token:ripper-delayed-watch — record approved candidates that would be delayed under a stricter age rule');
          console.log('Usage: npm run token:ripper-delayed-watch -- --input <cycle-jsonl...> --delay-minutes <n> --out <path>');
          break;
        }
        const rdwPaths: string[] = [];
        const rdwInputIdx = process.argv.indexOf('--input');
        if (rdwInputIdx !== -1) {
          for (let i = rdwInputIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rdwPaths.push(process.argv[i]);
          }
        }
        if (rdwPaths.length === 0) {
          console.error('[token:ripper-delayed-watch] No --input cycle files specified.');
          console.error('  Usage: npm run token:ripper-delayed-watch -- --input data/token-grab/ripper/cycles/cycle-*.jsonl --delay-minutes 5');
          process.exit(1);
        }
        const rdwDelay = parseNumberArg('--delay-minutes', 5, { min: 0 });
        const rdwOut   = getArgValue('--out') ?? 'data/token-grab/ripper/delayed-watch/watch.json';
        const rdwResult = runRipperDelayedWatch({
          inputPaths:         rdwPaths,
          outPath:            rdwOut,
          delayTargetMinutes: rdwDelay,
        });
        console.log(renderRipperDelayedWatch(rdwResult));
        break;
      }

      case 'token:ripper-approved-observation-autopsy': {
        const raoaApprovalsIdx = process.argv.indexOf('--approvals');
        const raoaApprovalPaths: string[] = [];
        if (raoaApprovalsIdx !== -1) {
          for (let i = raoaApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            raoaApprovalPaths.push(process.argv[i]);
          }
        }
        const raoaObsIdx = process.argv.indexOf('--observations');
        const raoaObsPaths: string[] = [];
        if (raoaObsIdx !== -1) {
          for (let i = raoaObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            raoaObsPaths.push(process.argv[i]);
          }
        }
        const raoaOutcomesIdx = process.argv.indexOf('--outcomes');
        const raoaOutcomePaths: string[] = [];
        if (raoaOutcomesIdx !== -1) {
          for (let i = raoaOutcomesIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            raoaOutcomePaths.push(process.argv[i]);
          }
        }
        if (raoaApprovalPaths.length === 0) {
          console.error('[token:ripper-approved-observation-autopsy] No --approvals files specified.');
          console.error('  Usage: npm run token:ripper-approved-observation-autopsy -- --approvals data/token-grab/ripper/cycles/cycle-*.jsonl --observations data/token-grab/ripper/observations/obs-*.jsonl --outcomes data/token-grab/ripper/outcomes/ripper-approved-outcomes-*.json');
          process.exit(1);
        }
        const raoaResult = runRipperApprovedObservationAutopsy({
          approvalPaths:    raoaApprovalPaths,
          observationPaths: raoaObsPaths,
          outcomePaths:     raoaOutcomePaths,
        });
        console.log(renderRipperApprovedObservationAutopsy(raoaResult));
        break;
      }

      case 'token:ripper-exit-sim': {
        const resApprovalsIdx = process.argv.indexOf('--approvals');
        const resApprovalPaths: string[] = [];
        if (resApprovalsIdx !== -1) {
          for (let i = resApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            resApprovalPaths.push(process.argv[i]);
          }
        }
        const resObsIdx = process.argv.indexOf('--observations');
        const resObsPaths: string[] = [];
        if (resObsIdx !== -1) {
          for (let i = resObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            resObsPaths.push(process.argv[i]);
          }
        }
        const resOutcomesIdx = process.argv.indexOf('--outcomes');
        const resOutcomePaths: string[] = [];
        if (resOutcomesIdx !== -1) {
          for (let i = resOutcomesIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            resOutcomePaths.push(process.argv[i]);
          }
        }
        if (resApprovalPaths.length === 0) {
          console.error('[token:ripper-exit-sim] No --approvals files specified.');
          console.error('  Usage: npm run token:ripper-exit-sim -- --approvals data/token-grab/ripper/cycles/cycle-*.jsonl --observations data/token-grab/ripper/observations/obs-*.jsonl --outcomes data/token-grab/ripper/outcomes/ripper-approved-outcomes-*.json');
          process.exit(1);
        }
        const resResult = runRipperExitSim({
          approvalPaths:    resApprovalPaths,
          observationPaths: resObsPaths,
          outcomePaths:     resOutcomePaths,
        });
        console.log(renderRipperExitSim(resResult));
        break;
      }

      case 'token:ripper-entry-feature-autopsy': {
        const refaApprovalsIdx = process.argv.indexOf('--approvals');
        const refaApprovalPaths: string[] = [];
        if (refaApprovalsIdx !== -1) {
          for (let i = refaApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            refaApprovalPaths.push(process.argv[i]);
          }
        }
        const refaObsIdx = process.argv.indexOf('--observations');
        const refaObsPaths: string[] = [];
        if (refaObsIdx !== -1) {
          for (let i = refaObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            refaObsPaths.push(process.argv[i]);
          }
        }
        const refaOutcomesIdx = process.argv.indexOf('--outcomes');
        const refaOutcomePaths: string[] = [];
        if (refaOutcomesIdx !== -1) {
          for (let i = refaOutcomesIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            refaOutcomePaths.push(process.argv[i]);
          }
        }
        if (refaApprovalPaths.length === 0) {
          console.error('[token:ripper-entry-feature-autopsy] No --approvals files specified.');
          console.error('  Usage: npm run token:ripper-entry-feature-autopsy -- --approvals data/token-grab/ripper/cycles/cycle-*.jsonl --observations data/token-grab/ripper/observations/obs-*.jsonl --outcomes data/token-grab/ripper/outcomes/ripper-approved-outcomes-*.json');
          process.exit(1);
        }
        const refaResult = runRipperEntryFeatureAutopsy({
          approvalPaths:    refaApprovalPaths,
          observationPaths: refaObsPaths,
          outcomePaths:     refaOutcomePaths,
        });
        console.log(renderRipperEntryFeatureAutopsy(refaResult));
        break;
      }

      case 'token:ripper-shadow-filter-report': {
        const rsfrApprovalsIdx = process.argv.indexOf('--approvals');
        const rsfrApprovalPaths: string[] = [];
        if (rsfrApprovalsIdx !== -1) {
          for (let i = rsfrApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rsfrApprovalPaths.push(process.argv[i]);
          }
        }
        const rsfrObsIdx = process.argv.indexOf('--observations');
        const rsfrObsPaths: string[] = [];
        if (rsfrObsIdx !== -1) {
          for (let i = rsfrObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rsfrObsPaths.push(process.argv[i]);
          }
        }
        const rsfrOutcomesIdx = process.argv.indexOf('--outcomes');
        const rsfrOutcomePaths: string[] = [];
        if (rsfrOutcomesIdx !== -1) {
          for (let i = rsfrOutcomesIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rsfrOutcomePaths.push(process.argv[i]);
          }
        }
        if (rsfrApprovalPaths.length === 0) {
          console.error('[token:ripper-shadow-filter-report] No --approvals files specified.');
          console.error('  Usage: npm run token:ripper-shadow-filter-report -- --approvals data/token-grab/ripper/cycles/cycle-*.jsonl --observations data/token-grab/ripper/observations/obs-*.jsonl --outcomes data/token-grab/ripper/outcomes/ripper-approved-outcomes-*.json');
          process.exit(1);
        }
        const rsfrResult = runRipperShadowFilterReport({
          approvalPaths:    rsfrApprovalPaths,
          observationPaths: rsfrObsPaths,
          outcomePaths:     rsfrOutcomePaths,
        });
        console.log(renderRipperShadowFilterReport(rsfrResult));
        break;
      }

      case 'token:ripper-shadow-policy-report': {
        const rsprApprovalsIdx = process.argv.indexOf('--approvals');
        const rsprApprovalPaths: string[] = [];
        if (rsprApprovalsIdx !== -1) {
          for (let i = rsprApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rsprApprovalPaths.push(process.argv[i]);
          }
        }
        const rsprOutcomesIdx = process.argv.indexOf('--outcomes');
        const rsprOutcomePaths: string[] = [];
        if (rsprOutcomesIdx !== -1) {
          for (let i = rsprOutcomesIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rsprOutcomePaths.push(process.argv[i]);
          }
        }
        if (rsprApprovalPaths.length === 0) {
          console.error('[token:ripper-shadow-policy-report] No --approvals files specified.');
          console.error('  Usage: npm run token:ripper-shadow-policy-report -- --approvals data/token-grab/ripper/cycles/cycle-*.jsonl --outcomes data/token-grab/ripper/outcomes/ripper-approved-outcomes-*.json');
          process.exit(1);
        }
        const rsprResult = runRipperShadowPolicyReport({
          approvalPaths: rsprApprovalPaths,
          outcomePaths:  rsprOutcomePaths,
        });
        console.log(renderRipperShadowPolicyReport(rsprResult));
        break;
      }

      case 'token:ripper-shadow-portfolio-report': {
        const rsppApprovalsIdx = process.argv.indexOf('--approvals');
        const rsppApprovalPaths: string[] = [];
        if (rsppApprovalsIdx !== -1) {
          for (let i = rsppApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rsppApprovalPaths.push(process.argv[i]);
          }
        }
        const rsppOutcomesIdx = process.argv.indexOf('--outcomes');
        const rsppOutcomePaths: string[] = [];
        if (rsppOutcomesIdx !== -1) {
          for (let i = rsppOutcomesIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rsppOutcomePaths.push(process.argv[i]);
          }
        }
        if (rsppApprovalPaths.length === 0) {
          console.error('[token:ripper-shadow-portfolio-report] No --approvals files specified.');
          console.error('  Usage: npm run token:ripper-shadow-portfolio-report -- --approvals data/token-grab/ripper/cycles/cycle-*.jsonl --outcomes data/token-grab/ripper/outcomes/ripper-approved-outcomes-*.json');
          process.exit(1);
        }
        const rsppResult = runRipperShadowPortfolioReport({
          approvalPaths: rsppApprovalPaths,
          outcomePaths:  rsppOutcomePaths,
        });
        console.log(renderRipperShadowPortfolioReport(rsppResult));
        break;
      }

      case 'token:ripper-shadow-combo-report': {
        const rscApprovalsIdx = process.argv.indexOf('--approvals');
        const rscApprovalPaths: string[] = [];
        if (rscApprovalsIdx !== -1) {
          for (let i = rscApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rscApprovalPaths.push(process.argv[i]);
          }
        }
        const rscOutcomesIdx = process.argv.indexOf('--outcomes');
        const rscOutcomePaths: string[] = [];
        if (rscOutcomesIdx !== -1) {
          for (let i = rscOutcomesIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rscOutcomePaths.push(process.argv[i]);
          }
        }
        if (rscApprovalPaths.length === 0) {
          console.error('[token:ripper-shadow-combo-report] No --approvals files specified.');
          console.error('  Usage: npm run token:ripper-shadow-combo-report -- --approvals data/token-grab/ripper/cycles/cycle-*.jsonl --outcomes data/token-grab/ripper/outcomes/ripper-approved-outcomes-*.json');
          process.exit(1);
        }
        const rscResult = runRipperShadowComboReport({
          approvalPaths: rscApprovalPaths,
          outcomePaths:  rscOutcomePaths,
        });
        console.log(renderRipperShadowComboReport(rscResult));
        break;
      }

      case 'token:ripper-exit-window-report': {
        const rewrApprovalsIdx = process.argv.indexOf('--approvals');
        const rewrApprovalPaths: string[] = [];
        if (rewrApprovalsIdx !== -1) {
          for (let i = rewrApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rewrApprovalPaths.push(process.argv[i]);
          }
        }
        const rewrObservationsIdx = process.argv.indexOf('--observations');
        const rewrObservationPaths: string[] = [];
        if (rewrObservationsIdx !== -1) {
          for (let i = rewrObservationsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rewrObservationPaths.push(process.argv[i]);
          }
        }
        if (rewrApprovalPaths.length === 0) {
          console.error('[token:ripper-exit-window-report] No --approvals files specified.');
          console.error('  Usage: npm run token:ripper-exit-window-report -- --approvals data/token-grab/ripper/cycles/cycle-*.jsonl --observations data/token-grab/ripper/observations/*.jsonl');
          process.exit(1);
        }
        const rewrResult = runRipperExitWindowReport({
          approvalPaths:     rewrApprovalPaths,
          observationPaths:  rewrObservationPaths,
        });
        console.log(renderRipperExitWindowReport(rewrResult));
        break;
      }

      case 'token:ripper-entry-lag-report': {
        const relrApprovalsIdx = process.argv.indexOf('--approvals');
        const relrApprovalPaths: string[] = [];
        if (relrApprovalsIdx !== -1) {
          for (let i = relrApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            relrApprovalPaths.push(process.argv[i]);
          }
        }
        const relrObservationsIdx = process.argv.indexOf('--observations');
        const relrObservationPaths: string[] = [];
        if (relrObservationsIdx !== -1) {
          for (let i = relrObservationsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            relrObservationPaths.push(process.argv[i]);
          }
        }
        if (relrApprovalPaths.length === 0) {
          console.error('[token:ripper-entry-lag-report] No --approvals files specified.');
          console.error('  Usage: npm run token:ripper-entry-lag-report -- --approvals data/token-grab/ripper/cycles/cycle-*.jsonl --observations data/token-grab/ripper/observations/*.jsonl');
          process.exit(1);
        }
        const relrResult = runRipperEntryLagReport({
          approvalPaths:    relrApprovalPaths,
          observationPaths: relrObservationPaths,
        });
        console.log(renderRipperEntryLagReport(relrResult));
        break;
      }

      case 'token:ripper-early-watch-policy-report': {
        const rewprObsIdx = process.argv.indexOf('--observations');
        const rewprObsPaths: string[] = [];
        if (rewprObsIdx !== -1) {
          for (let i = rewprObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rewprObsPaths.push(process.argv[i]);
          }
        }
        const rewprApprovalsIdx = process.argv.indexOf('--approvals');
        const rewprApprovalPaths: string[] = [];
        if (rewprApprovalsIdx !== -1) {
          for (let i = rewprApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rewprApprovalPaths.push(process.argv[i]);
          }
        }
        if (rewprObsPaths.length === 0) {
          console.error('[token:ripper-early-watch-policy-report] No --observations files specified.');
          console.error('  Usage: npm run token:ripper-early-watch-policy-report -- --observations data/token-grab/ripper/observations/*.jsonl --approvals data/token-grab/ripper/cycles/cycle-*.jsonl');
          process.exit(1);
        }
        const rewprResult = runRipperEarlyWatchPolicyReport({
          observationPaths: rewprObsPaths,
          approvalPaths:    rewprApprovalPaths,
        });
        console.log(renderRipperEarlyWatchPolicyReport(rewprResult));
        break;
      }

      case 'token:ripper-early-watch-tracked-lane-report': {
        const rewtlrObsIdx = process.argv.indexOf('--observations');
        const rewtlrObsPaths: string[] = [];
        if (rewtlrObsIdx !== -1) {
          for (let i = rewtlrObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rewtlrObsPaths.push(process.argv[i]);
          }
        }
        const rewtlrApprovalsIdx = process.argv.indexOf('--approvals');
        const rewtlrApprovalPaths: string[] = [];
        if (rewtlrApprovalsIdx !== -1) {
          for (let i = rewtlrApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rewtlrApprovalPaths.push(process.argv[i]);
          }
        }
        if (rewtlrObsPaths.length === 0) {
          console.error('[token:ripper-early-watch-tracked-lane-report] No --observations files specified.');
          console.error('  Usage: npm run token:ripper-early-watch-tracked-lane-report -- --observations data/token-grab/ripper/observations/*.jsonl --approvals data/token-grab/ripper/cycles/cycle-*.jsonl');
          process.exit(1);
        }
        const rewtlrResult = runRipperEarlyWatchTrackedLaneReport({
          observationPaths: rewtlrObsPaths,
          approvalPaths:    rewtlrApprovalPaths,
        });
        console.log(renderRipperEarlyWatchTrackedLaneReport(rewtlrResult));
        break;
      }

      case 'token:ripper-early-watch-blocker-autopsy': {
        const rewebaObsIdx = process.argv.indexOf('--observations');
        const rewebaObsPaths: string[] = [];
        if (rewebaObsIdx !== -1) {
          for (let i = rewebaObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rewebaObsPaths.push(process.argv[i]);
          }
        }
        const rewebaApprovalsIdx = process.argv.indexOf('--approvals');
        const rewebaApprovalPaths: string[] = [];
        if (rewebaApprovalsIdx !== -1) {
          for (let i = rewebaApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rewebaApprovalPaths.push(process.argv[i]);
          }
        }
        if (rewebaObsPaths.length === 0) {
          console.error('[token:ripper-early-watch-blocker-autopsy] No --observations files specified.');
          console.error('  Usage: npm run token:ripper-early-watch-blocker-autopsy -- --observations data/token-grab/ripper/observations/*.jsonl --approvals data/token-grab/ripper/cycles/cycle-*.jsonl');
          process.exit(1);
        }
        const rewebaResult = runRipperEarlyWatchBlockerAutopsy({
          observationPaths: rewebaObsPaths,
          approvalPaths:    rewebaApprovalPaths,
        });
        console.log(renderRipperEarlyWatchBlockerAutopsy(rewebaResult));
        break;
      }

      case 'token:ripper-approval-persistence-audit': {
        const rapaObsIdx = process.argv.indexOf('--observations');
        const rapaObsPaths: string[] = [];
        if (rapaObsIdx !== -1) {
          for (let i = rapaObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rapaObsPaths.push(process.argv[i]);
          }
        }
        const rapaApprovalsIdx = process.argv.indexOf('--approvals');
        const rapaApprovalPaths: string[] = [];
        if (rapaApprovalsIdx !== -1) {
          for (let i = rapaApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rapaApprovalPaths.push(process.argv[i]);
          }
        }
        if (rapaObsPaths.length === 0 && rapaApprovalPaths.length === 0) {
          console.error('[token:ripper-approval-persistence-audit] No --observations or --approvals files specified.');
          console.error('  Usage: npm run token:ripper-approval-persistence-audit -- --observations data/token-grab/ripper/observations/*.jsonl --approvals data/token-grab/ripper/cycles/cycle-*.jsonl');
          process.exit(1);
        }
        const rapaResult = runRipperApprovalPersistenceAudit({
          observationPaths: rapaObsPaths,
          approvalPaths:    rapaApprovalPaths,
        });
        console.log(renderRipperApprovalPersistenceAudit(rapaResult));
        break;
      }

      case 'token:ripper-early-watch-lead-value-report': {
        const rewlvrObsIdx = process.argv.indexOf('--observations');
        const rewlvrObsPaths: string[] = [];
        if (rewlvrObsIdx !== -1) {
          for (let i = rewlvrObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rewlvrObsPaths.push(process.argv[i]);
          }
        }
        const rewlvrApprovalsIdx = process.argv.indexOf('--approvals');
        const rewlvrApprovalPaths: string[] = [];
        if (rewlvrApprovalsIdx !== -1) {
          for (let i = rewlvrApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rewlvrApprovalPaths.push(process.argv[i]);
          }
        }
        if (rewlvrObsPaths.length === 0) {
          console.error('[token:ripper-early-watch-lead-value-report] No --observations files specified.');
          console.error('  Usage: npm run token:ripper-early-watch-lead-value-report -- --observations data/token-grab/ripper/observations/*.jsonl --approvals data/token-grab/ripper/cycles/cycle-*.jsonl');
          process.exit(1);
        }
        const rewlvrResult = runRipperEarlyWatchLeadValueReport({
          observationPaths: rewlvrObsPaths,
          approvalPaths:    rewlvrApprovalPaths,
        });
        console.log(renderRipperEarlyWatchLeadValueReport(rewlvrResult));
        break;
      }

      case 'token:ripper-approval-trigger-lag-report': {
        const ratlrObsIdx = process.argv.indexOf('--observations');
        const ratlrObsPaths: string[] = [];
        if (ratlrObsIdx !== -1) {
          for (let i = ratlrObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            ratlrObsPaths.push(process.argv[i]);
          }
        }
        const ratlrApprovalsIdx = process.argv.indexOf('--approvals');
        const ratlrApprovalPaths: string[] = [];
        if (ratlrApprovalsIdx !== -1) {
          for (let i = ratlrApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            ratlrApprovalPaths.push(process.argv[i]);
          }
        }
        if (ratlrObsPaths.length === 0 && ratlrApprovalPaths.length === 0) {
          console.error('[token:ripper-approval-trigger-lag-report] No --observations or --approvals files specified.');
          console.error('  Usage: npm run token:ripper-approval-trigger-lag-report -- --observations data/token-grab/ripper/observations/*.jsonl --approvals data/token-grab/ripper/cycles/cycle-*.jsonl');
          process.exit(1);
        }
        const ratlrResult = runRipperApprovalTriggerLagReport({
          observationPaths: ratlrObsPaths,
          approvalPaths:    ratlrApprovalPaths,
        });
        console.log(renderRipperApprovalTriggerLagReport(ratlrResult));
        break;
      }

      case 'token:ripper-approval-follow-paper-plan': {
        const raffppObsIdx = process.argv.indexOf('--observations');
        const raffppObsPaths: string[] = [];
        if (raffppObsIdx !== -1) {
          for (let i = raffppObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            raffppObsPaths.push(process.argv[i]);
          }
        }
        const raffppApprovalsIdx = process.argv.indexOf('--approvals');
        const raffppApprovalPaths: string[] = [];
        if (raffppApprovalsIdx !== -1) {
          for (let i = raffppApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            raffppApprovalPaths.push(process.argv[i]);
          }
        }
        if (raffppObsPaths.length === 0 && raffppApprovalPaths.length === 0) {
          console.error('[token:ripper-approval-follow-paper-plan] No --observations or --approvals files specified.');
          console.error('  Usage: npm run token:ripper-approval-follow-paper-plan -- --observations data/token-grab/ripper/observations/*.jsonl --approvals data/token-grab/ripper/cycles/cycle-*.jsonl');
          process.exit(1);
        }
        const raffppResult = runRipperApprovalFollowPaperPlan({
          observationPaths: raffppObsPaths,
          approvalPaths:    raffppApprovalPaths,
        });
        console.log(renderRipperApprovalFollowPaperPlan(raffppResult));
        break;
      }

      case 'token:ripper-approval-follow-paper-session': {
        const rafpsObsIdx = process.argv.indexOf('--observations');
        const rafpsObsPaths: string[] = [];
        if (rafpsObsIdx !== -1) {
          for (let i = rafpsObsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rafpsObsPaths.push(process.argv[i]);
          }
        }
        const rafpsApprovalsIdx = process.argv.indexOf('--approvals');
        const rafpsApprovalPaths: string[] = [];
        if (rafpsApprovalsIdx !== -1) {
          for (let i = rafpsApprovalsIdx + 1; i < process.argv.length; i++) {
            if (process.argv[i].startsWith('--')) break;
            rafpsApprovalPaths.push(process.argv[i]);
          }
        }
        const rafpsOutIdx = process.argv.indexOf('--out');
        const rafpsOutPath = rafpsOutIdx !== -1 ? process.argv[rafpsOutIdx + 1] : null;
        if (rafpsObsPaths.length === 0 && rafpsApprovalPaths.length === 0) {
          console.error('[token:ripper-approval-follow-paper-session] No --observations or --approvals files specified.');
          console.error('  Usage: npm run token:ripper-approval-follow-paper-session -- --observations data/token-grab/ripper/observations/*.jsonl --approvals data/token-grab/ripper/cycles/cycle-*.jsonl --out data/token-grab/ripper/approval-follow-paper-session.jsonl');
          process.exit(1);
        }
        if (!rafpsOutPath) {
          console.error('[token:ripper-approval-follow-paper-session] --out <path> is required.');
          process.exit(1);
        }
        const rafpsResult = runRipperApprovalFollowPaperSession({
          observationPaths: rafpsObsPaths,
          approvalPaths:    rafpsApprovalPaths,
          outPath:          rafpsOutPath,
        });
        console.log(renderRipperApprovalFollowPaperSession(rafpsResult));
        break;
      }

      case 'token:ripper-approval-follow-paper-session-report': {
        const rafpsrSessionIdx = process.argv.indexOf('--session');
        const rafpsrSessionPath = rafpsrSessionIdx !== -1 ? process.argv[rafpsrSessionIdx + 1] : null;
        if (!rafpsrSessionPath) {
          console.error('[token:ripper-approval-follow-paper-session-report] --session <path> is required.');
          console.error('  Usage: npm run token:ripper-approval-follow-paper-session-report -- --session data/token-grab/ripper/approval-follow-paper-session.jsonl');
          process.exit(1);
        }
        const rafpsrResult = runRipperApprovalFollowPaperSessionReport({ sessionPath: rafpsrSessionPath });
        console.log(renderRipperApprovalFollowPaperSessionReport(rafpsrResult));
        break;
      }

      case 'token:ripper-wait5-paper-shadow': {
        const rw5Idx = process.argv.indexOf('--session');
        const rw5Path = rw5Idx !== -1 ? process.argv[rw5Idx + 1] : null;
        if (!rw5Path) {
          console.error('[token:ripper-wait5-paper-shadow] --session <path> is required.');
          console.error('  Usage: npm run token:ripper-wait5-paper-shadow -- --session data/token-grab/ripper/approval-follow-paper-session.jsonl');
          process.exit(1);
        }
        console.log(renderRipperWait5PaperShadow(runRipperWait5PaperShadow(rw5Path)));
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
