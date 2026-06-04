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

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
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
