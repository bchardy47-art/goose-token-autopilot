import type { AppDb } from '../db';
import type { AppConfig } from '../types';

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
    topRedFlags: topItems(redFlags),
    topSkipReasons: topItems(skippedReasons),
    topPositiveReasons: topItems(positiveReasons),
    finalSafetyStatus: 'Real trading remains locked.'
  };
}
