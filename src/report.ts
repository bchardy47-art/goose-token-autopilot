import { getConfigSafetyStatus } from './config';
import type { AppConfig, ReportData } from './types';
import type { AppDb } from './db';
import { isKillSwitchActive } from './trading/guards';

export function buildReport(db: AppDb, config: AppConfig): ReportData {
  const topRanked = db.getRankedTokens(10).map((row) => ({
    symbol: row.symbol,
    mint: row.mint,
    totalScore: row.total_score,
    verdict: row.verdict,
    liquidityUsd: row.liquidity_usd,
    priceUsd: row.price_usd
  }));

  return {
    latestScanTime: db.getLatestScanTime(),
    tokensSeen: db.getTokenCount(),
    topRanked,
    verdictCounts: db.getVerdictCounts(),
    openPositions: db.listPositions('PAPER').filter((item) => item.status === 'OPEN'),
    closedPaperPnlUsd: db.getClosedPaperPnl(),
    blockedRealTradeAttempts: db.getBlockedRealTradeAttempts(),
    safetyEventSummary: db.getSafetyEventSummary(),
    safetyStatus: {
      dryRun: config.tokenRadarDryRun,
      tradingDisabled: config.tradingDisabled,
      realBuysEnabled: config.enableRealBuys,
      realSellsEnabled: config.enableRealSells,
      killSwitchActive: isKillSwitchActive(config)
    }
  };
}

export function formatReport(report: ReportData, config: AppConfig): string {
  const safety = getConfigSafetyStatus(config) as Record<string, unknown>;
  const topLines = report.topRanked.map((token, index) => `${index + 1}. ${token.symbol} ${token.verdict} total=${token.totalScore} price=${token.priceUsd ?? 'n/a'} liq=${token.liquidityUsd ?? 'n/a'}`);
  const openLines = report.openPositions.length === 0
    ? ['none']
    : report.openPositions.map((position) => `${position.id}. ${position.symbol} qty=${position.quantity.toFixed(6)} entry=${position.entryPriceUsd} latest=${position.latestPriceUsd ?? 'n/a'} unrealized=${position.unrealizedPnlUsd ?? 'n/a'} best=${position.bestGainPct ?? 'n/a'}%`);

  return [
    'Goose Token Autopilot V1 Report',
    `Latest scan time: ${report.latestScanTime ?? 'never'}`,
    `Tokens seen: ${report.tokensSeen}`,
    'Top 10 ranked tokens:',
    ...topLines,
    `Verdict counts: ${JSON.stringify(report.verdictCounts)}`,
    'Open paper positions:',
    ...openLines,
    `Closed paper P/L: ${report.closedPaperPnlUsd}`,
    `Blocked real trade attempts: ${report.blockedRealTradeAttempts}`,
    `Safety event summary: ${JSON.stringify(report.safetyEventSummary)}`,
    `Config safety status: ${JSON.stringify(safety)}`,
    'Real trading remains locked by default in V1.'
  ].join('\n');
}
