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
} from './token-grab/xEarsPreSignal';

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
