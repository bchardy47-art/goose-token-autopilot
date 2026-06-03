import { runScan } from '../scanner';
import { scoreToken } from '../scoring/scoreToken';
import type { AppDb } from '../db';
import type { AppConfig, AutoPaperDecision, PaperEligibilityDiagnosticRow } from '../types';
import { paperBuy } from '../trading/paper';
import { AppLogger } from '../logger';
import { applyLatestQuoteResultToSnapshot, buildPaperEntryContext, getPaperEntryBlockers, isAutoPaperResearchBlocked, isPaperQuoteReady, minutesSince } from './entryIntegrity';

export { applyLatestQuoteResultToSnapshot, isPaperQuoteReady } from './entryIntegrity';
export const isPaperResearchBlocked = isAutoPaperResearchBlocked;

function getSkipReason(db: AppDb, config: AppConfig, tokenId: number, snapshot: any, score: any): string | null {
  const paperBlocker = isAutoPaperResearchBlocked(snapshot, score, config);
  if (paperBlocker) return paperBlocker;
  if (db.getLatestOpenPositionByToken(tokenId, 'PAPER')) return 'duplicate open paper position exists';
  if (db.getOpenPositionCount('PAPER') >= config.maxOpenPositions) return 'max open paper positions reached';
  if (db.getDailyPaperBuyCount() >= config.maxDailyPaperBuys) return 'daily paper buy cap reached';
  return null;
}

function buildUsefulRankReason(row: PaperEligibilityDiagnosticRow, config: AppConfig): string {
  if (row.blockerCount === 0) return 'eligible now';
  if (row.isEntryStale) return `demoted: entry data stale (${row.dataAgeMinutes ?? 'n/a'}m)`;
  if (row.isMovedBeforeDiscoveryBlocked) return `demoted: moved before discovery (${row.movedBeforeDiscoveryPct ?? 'n/a'}% > ${config.maxChasePct}%)`;
  if (row.sellQuoteAvailable !== 'YES') return `demoted: sell quote ${String(row.sellQuoteAvailable ?? 'UNKNOWN').toLowerCase()}`;
  if (row.estimatedSlippageBps === null || row.estimatedSlippageBps === undefined) return 'demoted: slippage missing';
  if (row.estimatedSlippageBps > config.maxSlippageBps) return `demoted: slippage high (${row.estimatedSlippageBps}bps > ${config.maxSlippageBps}bps)`;
  return `closest by blocker count=${row.blockerCount} distance=${row.distanceToPaperScore ?? 'n/a'} score=${row.totalScore ?? 'n/a'}`;
}

function rankPaperEligibilityRows(left: PaperEligibilityDiagnosticRow, right: PaperEligibilityDiagnosticRow, config: AppConfig): number {
  const eligibleDelta = Number(left.blockerCount !== 0) - Number(right.blockerCount !== 0);
  if (eligibleDelta !== 0) return eligibleDelta;

  const blockerDelta = left.blockerCount - right.blockerCount;
  if (blockerDelta !== 0) return blockerDelta;

  const staleDelta = Number(left.isEntryStale) - Number(right.isEntryStale);
  if (staleDelta !== 0) return staleDelta;

  const movedDelta = Number(left.isMovedBeforeDiscoveryBlocked) - Number(right.isMovedBeforeDiscoveryBlocked);
  if (movedDelta !== 0) return movedDelta;

  const quoteReadyDelta = Number(left.sellQuoteAvailable !== 'YES') - Number(right.sellQuoteAvailable !== 'YES');
  if (quoteReadyDelta !== 0) return quoteReadyDelta;

  const slippageMissingDelta = Number(left.estimatedSlippageBps == null) - Number(right.estimatedSlippageBps == null);
  if (slippageMissingDelta !== 0) return slippageMissingDelta;

  const leftHighSlippage = (left.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) > config.maxSlippageBps;
  const rightHighSlippage = (right.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) > config.maxSlippageBps;
  const highSlippageDelta = Number(leftHighSlippage) - Number(rightHighSlippage);
  if (highSlippageDelta !== 0) return highSlippageDelta;

  const leftDataAge = left.dataAgeMinutes ?? Number.POSITIVE_INFINITY;
  const rightDataAge = right.dataAgeMinutes ?? Number.POSITIVE_INFINITY;
  if (leftDataAge !== rightDataAge) return leftDataAge - rightDataAge;

  const leftMoved = left.movedBeforeDiscoveryPct ?? Number.POSITIVE_INFINITY;
  const rightMoved = right.movedBeforeDiscoveryPct ?? Number.POSITIVE_INFINITY;
  if (leftMoved !== rightMoved) return leftMoved - rightMoved;

  const distanceDelta = (left.distanceToPaperScore ?? Number.POSITIVE_INFINITY) - (right.distanceToPaperScore ?? Number.POSITIVE_INFINITY);
  if (distanceDelta !== 0) return distanceDelta;

  return (right.totalScore ?? Number.NEGATIVE_INFINITY) - (left.totalScore ?? Number.NEGATIVE_INFINITY);
}

export function buildPaperEligibilityDiagnostics(db: AppDb, config: AppConfig): Record<string, unknown> {
  const rows: Array<PaperEligibilityDiagnosticRow & { warnings: string[] }> = db.listLatestTokenStates(50).map((state) => {
    const latestQuote = db.getLatestQuoteSellabilityCheck(state.tokenId);
    const preparedSnapshot = applyLatestQuoteResultToSnapshot(state.snapshot, latestQuote, config);
    const latestSnapshot = db.getLatestSnapshot(state.tokenId);
    const diagnosticSnapshot = applyLatestQuoteResultToSnapshot(latestSnapshot, latestQuote, config);
    const preparedScore = preparedSnapshot ? scoreToken(state.tokenId, preparedSnapshot, config) : state.score;
    const blockers = [
      ...getPaperEntryBlockers(diagnosticSnapshot, preparedScore, config),
      db.getLatestOpenPositionByToken(state.tokenId, 'PAPER') ? 'duplicate open paper position exists' : null,
      db.getOpenPositionCount('PAPER') >= config.maxOpenPositions ? 'max open paper positions reached' : null,
      db.getDailyPaperBuyCount() >= config.maxDailyPaperBuys ? 'daily paper buy cap reached' : null
    ].filter((value): value is string => Boolean(value));
    const warnings = [...new Set(preparedScore?.redFlags ?? [])];
    const uniqueBlockers = [...new Set(blockers)];
    const dataAgeMinutes = diagnosticSnapshot?.dataUpdatedAt ? Number(minutesSince(diagnosticSnapshot.dataUpdatedAt).toFixed(4)) : null;
    const movedBeforeDiscoveryPct = diagnosticSnapshot?.movedBeforeDiscoveryPct ?? preparedSnapshot?.movedBeforeDiscoveryPct ?? null;

    const row: PaperEligibilityDiagnosticRow & { warnings: string[] } = {
      tokenId: state.tokenId,
      symbol: state.symbol,
      mint: state.mint,
      totalScore: preparedScore?.totalScore ?? null,
      safetyScore: preparedScore?.safetyScore ?? null,
      momentumScore: preparedScore?.momentumScore ?? null,
      liquidityUsd: preparedSnapshot?.liquidityUsd ?? null,
      sellQuoteAvailable: preparedSnapshot?.sellQuoteAvailable ?? null,
      estimatedSlippageBps: preparedSnapshot?.estimatedSlippageBps ?? null,
      mintAuthority: preparedSnapshot?.mintAuthority ?? null,
      freezeAuthority: preparedSnapshot?.freezeAuthority ?? null,
      holderConcentration: preparedSnapshot?.holderConcentration ?? null,
      verdict: preparedScore?.verdict ?? null,
      blockers: uniqueBlockers,
      warnings,
      distanceToPaperScore: preparedScore ? Number(Math.max(0, config.paperMinTotalScore - preparedScore.totalScore).toFixed(2)) : null,
      dataAgeMinutes,
      isEntryStale: uniqueBlockers.includes('entry data stale blocks paper eligibility'),
      movedBeforeDiscoveryPct,
      isMovedBeforeDiscoveryBlocked: uniqueBlockers.includes('moved before discovery blocks paper eligibility'),
      blockerCount: uniqueBlockers.length,
      warningCount: warnings.length,
      usefulRankReason: ''
    };
    row.usefulRankReason = buildUsefulRankReason(row, config);
    return row;
  });

  const topItems = (items: string[], limit = 10) => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
  };

  const eligibleForPaper = rows.filter((row) => row.blockers.length === 0);
  const closest = [...rows].sort((a, b) => rankPaperEligibilityRows(a, b, config)).slice(0, 10);

  return {
    totalCandidatesEvaluated: rows.length,
    quoteReadyCount: rows.filter((row) => row.sellQuoteAvailable === 'YES').length,
    quoteUnknownCount: rows.filter((row) => row.sellQuoteAvailable === 'UNKNOWN' || row.sellQuoteAvailable === null).length,
    quoteNoRouteCount: rows.filter((row) => row.sellQuoteAvailable === 'NO').length,
    slippageMissingCount: rows.filter((row) => row.estimatedSlippageBps === null).length,
    highSlippageCount: rows.filter((row) => (row.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) > config.maxSlippageBps).length,
    mintUnsafeCount: rows.filter((row) => row.mintAuthority === 'UNSAFE').length,
    freezeUnsafeCount: rows.filter((row) => row.freezeAuthority === 'UNSAFE').length,
    holderRiskyCount: rows.filter((row) => row.holderConcentration === 'RISKY').length,
    holderUnknownCount: rows.filter((row) => row.holderConcentration === 'UNKNOWN' || row.holderConcentration === null).length,
    failedTotalScoreCount: rows.filter((row) => row.blockers.includes('total score below paper minimum')).length,
    failedSafetyScoreCount: rows.filter((row) => row.blockers.includes('safety score below paper minimum')).length,
    failedMomentumScoreCount: rows.filter((row) => row.blockers.includes('momentum score below paper minimum')).length,
    failedLiquidityCount: rows.filter((row) => row.blockers.includes('latest liquidity missing')).length,
    failedAgeWindowCount: rows.filter((row) => row.blockers.includes('token age outside configured range')).length,
    failedEntryStaleCount: rows.filter((row) => row.blockers.includes('entry data stale blocks paper eligibility')).length,
    failedAlreadyMovedCount: rows.filter((row) => row.blockers.includes('moved before discovery blocks paper eligibility')).length,
    verdictAvoidCount: rows.filter((row) => row.verdict === 'AVOID').length,
    verdictWatchCount: rows.filter((row) => row.verdict === 'WATCH').length,
    verdictPaperBuyCount: rows.filter((row) => row.verdict === 'PAPER_BUY').length,
    eligibleForPaperCount: eligibleForPaper.length,
    paperBuysWouldOpenCount: Math.max(0, Math.min(eligibleForPaper.length, config.maxDailyPaperBuys - db.getDailyPaperBuyCount(), config.maxOpenPositions - db.getOpenPositionCount('PAPER'))),
    topSkipReasons: topItems(rows.flatMap((row) => row.blockers)),
    topWarnings: topItems(rows.flatMap((row) => row.warnings)),
    topClosestCandidates: closest,
    finalSafetyStatus: 'Real trading remains locked.'
  };
}

export async function runAutoPaper(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<{ decisions: AutoPaperDecision[]; scanned: number; scored: number }> {
  const runLogId = db.createRunLog('token:auto-paper');
  try {
    const scan = await runScan(db, config, logger);
    const decisions: AutoPaperDecision[] = [];
    let scored = 0;

    for (const state of db.listLatestTokenStates(50)) {
      const latestQuote = db.getLatestQuoteSellabilityCheck(state.tokenId);
      const preparedSnapshot = applyLatestQuoteResultToSnapshot(state.snapshot, latestQuote, config);
      const preparedScore = preparedSnapshot ? scoreToken(state.tokenId, preparedSnapshot, config) : state.score;
      if (preparedScore && preparedSnapshot) {
        db.saveScore(preparedScore);
        scored += 1;
      }

      const skipReason = getSkipReason(db, config, state.tokenId, preparedSnapshot, preparedScore);
      if (skipReason) {
        decisions.push({ tokenId: state.tokenId, symbol: state.symbol, mint: state.mint, action: 'SKIPPED', reason: skipReason });
        db.logSafetyEvent(state.tokenId, 'INFO', 'auto_paper_skipped', skipReason, { tokenId: state.tokenId, symbol: state.symbol, mint: state.mint });
        continue;
      }

      const entryContext = buildPaperEntryContext(preparedSnapshot!, preparedScore!, null, null);
      const proposalId = db.createProposal(
        state.tokenId,
        'BUY',
        Math.min(config.maxAutoPaperBuyUsd, config.maxBankrollUsd - db.getOpenExposureUsd('PAPER')),
        preparedScore!.verdict,
        `auto paper buy for ${state.symbol}; reasons=${preparedScore!.reasons.slice(0, 3).join(' | ')}`,
        'PENDING',
        {
          totalScore: preparedScore!.totalScore,
          safetyScore: preparedScore!.safetyScore,
          momentumScore: preparedScore!.momentumScore,
          redFlags: preparedScore!.redFlags,
          reasons: preparedScore!.reasons,
          sellQuoteAvailable: preparedSnapshot?.sellQuoteAvailable,
          estimatedSlippageBps: preparedSnapshot?.estimatedSlippageBps,
          holderConcentration: preparedSnapshot?.holderConcentration,
          mintAuthority: preparedSnapshot?.mintAuthority,
          freezeAuthority: preparedSnapshot?.freezeAuthority,
          movedBeforeDiscoveryPct: preparedSnapshot?.movedBeforeDiscoveryPct,
          dataUpdatedAt: preparedSnapshot?.dataUpdatedAt,
          paperEntryProfile: entryContext.profile,
          paperEntryPriority: entryContext.priority,
          paperEntryTokenAgeMinutes: entryContext.tokenAgeMinutes,
          paperEntryDataAgeMinutes: entryContext.dataAgeMinutes
        }
      );

      const result = paperBuy(db, config, { proposalId, paperApproved: true, snapshot: preparedSnapshot!, score: preparedScore! });
      db.logSafetyEvent(state.tokenId, 'INFO', 'auto_paper_bought', 'Auto paper buy executed', { proposalId, positionId: result.positionId, tokenId: state.tokenId });
      decisions.push({ tokenId: state.tokenId, symbol: state.symbol, mint: state.mint, action: 'BOUGHT', reason: 'eligible for auto paper buy', proposalId, positionId: result.positionId });
    }

    db.finishRunLog(runLogId, 'SUCCESS', { scanned: scan.scanned, scored, decisions });
    return { decisions, scanned: scan.scanned, scored };
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'unknown auto-paper error' });
    throw error;
  }
}
