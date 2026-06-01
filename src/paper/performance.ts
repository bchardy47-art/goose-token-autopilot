import type { AppDb } from '../db';

export function buildPaperPerformanceReport(db: AppDb): Record<string, unknown> {
  const positions = db.listPositions('PAPER');
  const open = positions.filter((position) => position.status === 'OPEN');
  const closed = positions.filter((position) => position.status === 'CLOSED');
  const realizedPnl = closed.reduce((sum, position) => sum + (position.realizedPnlUsd ?? 0), 0);
  const unrealizedPnl = open.reduce((sum, position) => sum + (position.unrealizedPnlUsd ?? 0), 0);
  const bestGain = positions.reduce((max, position) => Math.max(max, position.bestGainPct ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
  const worstDrawdown = positions.reduce((min, position) => Math.min(min, position.worstDrawdownPct ?? Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  const exitReasonCounts: Record<string, number> = {};

  for (const position of closed) {
    const note = position.notes ?? 'unknown';
    exitReasonCounts[note] = (exitReasonCounts[note] ?? 0) + 1;
  }

  return {
    openPositions: open,
    closedPositions: closed,
    bestGainPct: Number.isFinite(bestGain) ? bestGain : null,
    worstDrawdownPct: Number.isFinite(worstDrawdown) ? worstDrawdown : null,
    currentPnlUsd: Number((realizedPnl + unrealizedPnl).toFixed(6)),
    realizedPnlUsd: Number(realizedPnl.toFixed(6)),
    unrealizedPnlUsd: Number(unrealizedPnl.toFixed(6)),
    exitReasonCounts
  };
}
