import type { AppDb } from '../db';
import type { AppConfig, PaperPositionView } from '../types';
import { summarizeWatchOnlySignalAnalysis } from '../watchAnalysis';
import { buildPaperEligibilityDiagnostics } from './autoPaper';
import { buildPaperPerformanceReport } from './performance';

function topItems(items: string[], limit = 5): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function fmtMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `$${value.toFixed(2)}`;
}

function fmtPct(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `${value.toFixed(2)}%`;
}

function renderOpenPosition(position: PaperPositionView): string {
  return `${position.symbol.padEnd(10)} ${position.status.padEnd(6)} entry=${fmtMoney(position.entryPriceUsd)} latest=${fmtMoney(position.latestPriceUsd)} pnl=${fmtPct(position.unrealizedPnlPct)} best=${fmtPct(position.bestGainPct)} worst=${fmtPct(position.worstDrawdownPct)}`;
}

function renderClosedPosition(position: PaperPositionView): string {
  return `${position.symbol.padEnd(10)} pnl=${fmtPct(position.realizedPnlPct)} usd=${fmtMoney(position.realizedPnlUsd)} best=${fmtPct(position.bestGainPct)} worst=${fmtPct(position.worstDrawdownPct)}`;
}

export function renderPaperDashboard(db: AppDb, _config: AppConfig): string {
  const report = buildPaperPerformanceReport(db) as any;
  const openPositions = report.openPositions as PaperPositionView[];
  const closedPositions = report.closedPositions as PaperPositionView[];
  const wins = closedPositions.filter((position) => (position.realizedPnlUsd ?? 0) > 0);
  const winRate = closedPositions.length > 0 ? (wins.length / closedPositions.length) * 100 : 0;
  const bestTrade = [...closedPositions].sort((a, b) => (b.realizedPnlUsd ?? 0) - (a.realizedPnlUsd ?? 0))[0] ?? null;
  const worstTrade = [...closedPositions].sort((a, b) => (a.realizedPnlUsd ?? 0) - (b.realizedPnlUsd ?? 0))[0] ?? null;
  const lines: string[] = [];
  lines.push('Paper Trading Dashboard');
  lines.push('');
  lines.push(`Open Positions (${openPositions.length})`);
  for (const position of openPositions) lines.push(`- ${renderOpenPosition(position)}`);
  if (openPositions.length === 0) lines.push('- none');
  lines.push('');
  lines.push(`Closed Positions (${closedPositions.length})`);
  for (const position of closedPositions) lines.push(`- ${renderClosedPosition(position)}`);
  if (closedPositions.length === 0) lines.push('- none');
  lines.push('');
  lines.push('Summary');
  lines.push(`- open count: ${openPositions.length}`);
  lines.push(`- closed count: ${closedPositions.length}`);
  lines.push(`- win rate: ${fmtPct(winRate)}`);
  lines.push(`- current P/L $: ${fmtMoney(report.currentPnlUsd)}`);
  lines.push(`- realized P/L $: ${fmtMoney(report.realizedPnlUsd)}`);
  lines.push(`- unrealized P/L $: ${fmtMoney(report.unrealizedPnlUsd)}`);
  lines.push(`- best trade: ${bestTrade ? `${bestTrade.symbol} ${fmtPct(bestTrade.realizedPnlPct)} ${fmtMoney(bestTrade.realizedPnlUsd)}` : 'none'}`);
  lines.push(`- worst trade: ${worstTrade ? `${worstTrade.symbol} ${fmtPct(worstTrade.realizedPnlPct)} ${fmtMoney(worstTrade.realizedPnlUsd)}` : 'none'}`);
  lines.push('');
  lines.push('Real trading remains locked.');
  lines.push('Paper only.');
  return lines.join('\n');
}

export function renderPaperAutopsy(db: AppDb, _config: AppConfig): string {
  const closedPositions = db.listPositions('PAPER').filter((position) => position.status === 'CLOSED');
  const winners = closedPositions.filter((position) => (position.realizedPnlUsd ?? 0) > 0);
  const losers = closedPositions.filter((position) => (position.realizedPnlUsd ?? 0) < 0);
  const avgWinnerPct = winners.length > 0 ? winners.reduce((sum, position) => sum + (position.realizedPnlPct ?? 0), 0) / winners.length : 0;
  const avgLoserPct = losers.length > 0 ? losers.reduce((sum, position) => sum + (position.realizedPnlPct ?? 0), 0) / losers.length : 0;
  const bestWinner = [...winners].sort((a, b) => (b.realizedPnlUsd ?? 0) - (a.realizedPnlUsd ?? 0))[0] ?? null;
  const worstLoser = [...losers].sort((a, b) => (a.realizedPnlUsd ?? 0) - (b.realizedPnlUsd ?? 0))[0] ?? null;
  const loserRedFlags = losers.flatMap((position) => db.getLatestScore(position.tokenId)?.redFlags ?? []);
  const lines: string[] = [];

  lines.push('Paper Trade Autopsy');
  lines.push('');
  for (const position of closedPositions) {
    const score = db.getLatestScore(position.tokenId);
    const snapshot = db.getLatestSnapshot(position.tokenId);
    lines.push(`- ${position.symbol} pnl=${fmtPct(position.realizedPnlPct)} usd=${fmtMoney(position.realizedPnlUsd)} entry=${position.openedAt} exit=${position.closedAt ?? '-'} reason=${position.notes ?? 'unknown'} best=${fmtPct(position.bestGainPct)} worst=${fmtPct(position.worstDrawdownPct)} entryPx=${fmtMoney(position.entryPriceUsd)} exitPx=${fmtMoney(position.exitPriceUsd)}`);
    lines.push(`  score total=${score?.totalScore ?? '-'} safety=${score?.safetyScore ?? '-'} momentum=${score?.momentumScore ?? '-'} verdict=${score?.verdict ?? '-'} redFlags=${(score?.redFlags ?? []).join(', ') || '-'}`);
    lines.push(`  snapshot liq=${fmtMoney(snapshot?.liquidityUsd)} sellQuote=${snapshot?.sellQuoteAvailable ?? '-'} slip=${snapshot?.estimatedSlippageBps ?? '-'} holder=${snapshot?.holderConcentration ?? '-'} mintAuth=${snapshot?.mintAuthority ?? '-'} freezeAuth=${snapshot?.freezeAuthority ?? '-'}`);
  }
  if (closedPositions.length === 0) lines.push('- none');
  lines.push('');
  lines.push('Summary');
  lines.push(`- winners count: ${winners.length}`);
  lines.push(`- losers count: ${losers.length}`);
  lines.push(`- average winner %: ${fmtPct(avgWinnerPct)}`);
  lines.push(`- average loser %: ${fmtPct(avgLoserPct)}`);
  lines.push(`- best winner: ${bestWinner ? `${bestWinner.symbol} ${fmtPct(bestWinner.realizedPnlPct)} ${fmtMoney(bestWinner.realizedPnlUsd)}` : 'none'}`);
  lines.push(`- worst loser: ${worstLoser ? `${worstLoser.symbol} ${fmtPct(worstLoser.realizedPnlPct)} ${fmtMoney(worstLoser.realizedPnlUsd)}` : 'none'}`);
  lines.push(`- common loser red flags: ${topItems(loserRedFlags).map((item) => `${item.value} (${item.count})`).join(', ') || 'none'}`);
  lines.push('');
  lines.push('Real trading remains locked. Paper only.');
  return lines.join('\n');
}

export function buildDailyReport(db: AppDb, _config: AppConfig): Record<string, unknown> {
  const today = new Date().toISOString().slice(0, 10);
  const scanLogs = db.listRunLogs('token:scan', today);
  const scoreLogs = db.listRunLogs('token:score', today);
  const autoPaperLogs = db.listRunLogs('token:auto-paper', today);
  const safetyEvents = db.listSafetyEvents(today);
  const closed = db.listClosedPositionsToday('PAPER', today);
  const open = db.listPositions('PAPER').filter((position) => position.status === 'OPEN');
  const watchOnly = db.listWatchOnlyCandidates();
  const wins = closed.filter((position) => (position.realizedPnlUsd ?? 0) > 0);
  const losses = closed.filter((position) => (position.realizedPnlUsd ?? 0) < 0);
  const realizedPnl = closed.reduce((sum, position) => sum + (position.realizedPnlUsd ?? 0), 0);
  const unrealizedPnl = open.reduce((sum, position) => sum + (position.unrealizedPnlUsd ?? 0), 0);
  const bestTrade = [...closed].sort((a, b) => (b.realizedPnlUsd ?? 0) - (a.realizedPnlUsd ?? 0))[0] ?? null;
  const worstTrade = [...closed].sort((a, b) => (a.realizedPnlUsd ?? 0) - (b.realizedPnlUsd ?? 0))[0] ?? null;
  const skippedReasons = autoPaperLogs.flatMap((log) => ((log.summary.decisions as any[] | undefined) ?? []).filter((decision) => decision.action === 'SKIPPED').map((decision) => String(decision.reason)));
  const positiveReasons = db.listLatestTokenStates(50).flatMap((state) => state.score?.reasons ?? []).filter((reason) => /passes|supportive|liquidity|slippage|strong enough/i.test(reason));
  const redFlags = db.listLatestTokenStates(50).flatMap((state) => state.score?.redFlags ?? []);
  const safetyRejections = safetyEvents.filter((event) => event.eventType.includes('blocked') || event.eventType.includes('skipped'));
  const bestWatchOnly = [...watchOnly].sort((a, b) => (b.bestGainPct ?? Number.NEGATIVE_INFINITY) - (a.bestGainPct ?? Number.NEGATIVE_INFINITY))[0] ?? null;
  const worstWatchOnly = [...watchOnly].sort((a, b) => (a.worstDrawdownPct ?? Number.POSITIVE_INFINITY) - (b.worstDrawdownPct ?? Number.POSITIVE_INFINITY))[0] ?? null;
  const watchAnalysisSummary = summarizeWatchOnlySignalAnalysis(db);
  const enrichments = db.listSolanaSafetyEnrichments();
  const quoteChecks = db.listQuoteSellabilityChecks();
  const latestStates = db.listLatestTokenStates(100);

  const paperEligibilityDiagnostics = buildPaperEligibilityDiagnostics(db, _config);

  return {
    tokensScannedToday: scanLogs.reduce((sum, log) => sum + Number(log.summary.scanned ?? 0), 0),
    tokensScoredToday: scoreLogs.reduce((sum, log) => sum + Number(log.summary.scored ?? 0), 0),
    verdictCounts: db.getVerdictCountsForDate(today),
    safetyRejectionsCount: safetyRejections.length,
    topRejectionReasons: topItems(safetyRejections.map((event) => event.message)),
    paperBuysOpened: db.getDailyPaperBuyCount(today),
    paperSellsClosed: db.getDailyPaperSellCount(today),
    winRate: closed.length > 0 ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
    averageWinner: wins.length > 0 ? Number((wins.reduce((sum, position) => sum + (position.realizedPnlUsd ?? 0), 0) / wins.length).toFixed(6)) : 0,
    averageLoser: losses.length > 0 ? Number((losses.reduce((sum, position) => sum + (position.realizedPnlUsd ?? 0), 0) / losses.length).toFixed(6)) : 0,
    realizedPnlUsd: Number(realizedPnl.toFixed(6)),
    unrealizedPnlUsd: Number(unrealizedPnl.toFixed(6)),
    bestPaperTrade: bestTrade,
    worstPaperTrade: worstTrade,
    tokensStillOpen: open.length,
    blockedRealTradeAttempts: db.getBlockedRealTradeAttempts(),
    watchOnlyCandidateCount: watchOnly.length,
    bestWatchOnlyMover: bestWatchOnly,
    worstWatchOnlyMover: worstWatchOnly,
    watchOnlyResearchOnly: true,
    ...watchAnalysisSummary,
    safetyEnrichmentSummary: {
      totalRows: enrichments.length,
      mintAuthorityRenouncedCount: enrichments.filter((row) => row.mintAuthorityRenounced === true).length,
      freezeAuthorityRenouncedCount: enrichments.filter((row) => row.freezeAuthorityRenounced === true).length,
      highHolderConcentrationCount: enrichments.filter((row) => row.holderConcentrationLevel === 'HIGH').length,
      unknownAuthorityCount: enrichments.filter((row) => row.mintAuthority === 'UNKNOWN' || row.freezeAuthority === 'UNKNOWN').length
    },
    quoteSellabilitySummary: {
      totalRows: quoteChecks.length,
      routeAvailableCount: quoteChecks.filter((row) => row.routeAvailable === true).length,
      routeUnavailableCount: quoteChecks.filter((row) => row.routeAvailable === false).length,
      unknownOrErrorCount: quoteChecks.filter((row) => row.sellQuoteStatus === 'UNKNOWN' || row.errorSummary !== null).length,
      highSlippageCount: quoteChecks.filter((row) => (row.estimatedSlippageBps ?? Number.POSITIVE_INFINITY) > 500).length
    },
    paperEligibilitySummary: {
      totalCandidatesEvaluated: paperEligibilityDiagnostics.totalCandidatesEvaluated,
      eligibleForPaperCount: paperEligibilityDiagnostics.eligibleForPaperCount,
      paperBuysWouldOpenCount: paperEligibilityDiagnostics.paperBuysWouldOpenCount,
      topSkipReasons: paperEligibilityDiagnostics.topSkipReasons,
      topWarnings: paperEligibilityDiagnostics.topWarnings
    },
    safetyPenaltySummary: {
      riskyHolderCount: latestStates.filter((state) => state.snapshot?.holderConcentration === 'RISKY').length,
      unsafeMintCount: latestStates.filter((state) => state.snapshot?.mintAuthority === 'UNSAFE').length,
      unsafeFreezeCount: latestStates.filter((state) => state.snapshot?.freezeAuthority === 'UNSAFE').length,
      unknownSellabilityCount: latestStates.filter((state) => state.snapshot?.sellQuoteAvailable === 'UNKNOWN').length,
      enrichmentMissingCount: latestStates.filter((state) => state.snapshot?.mintAuthority === 'UNKNOWN' && state.snapshot?.freezeAuthority === 'UNKNOWN' && state.snapshot?.holderConcentration === 'UNKNOWN').length
    },
    topRedFlags: topItems(redFlags),
    topSkipReasons: topItems(skippedReasons),
    topPositiveReasons: topItems(positiveReasons),
    finalSafetyStatus: 'Real trading remains locked.'
  };
}
