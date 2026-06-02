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
import { runPaperReview } from './paper/review';
import { buildPaperPerformanceReport } from './paper/performance';
import { buildDailyReport, renderPaperDashboard } from './paper/dailyReport';
import { buildWatchOnlyReport, runWatchOnly } from './watchOnly';
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
      case 'token:paper-review':
        console.log(JSON.stringify(await runPaperReview(db, config), null, 2));
        break;
      case 'token:paper-performance':
        console.log(JSON.stringify(buildPaperPerformanceReport(db), null, 2));
        break;
      case 'token:paper-dashboard':
        console.log(renderPaperDashboard(db, config));
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
