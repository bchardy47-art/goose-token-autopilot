import type { AppDb } from '../db';
import type { AppConfig, PaperReviewDecision } from '../types';
import { paperSell } from '../trading/paper';

function heldMinutes(openedAt: string): number {
  return (Date.now() - new Date(openedAt).getTime()) / 60_000;
}

export function capturePaperPerformance(db: AppDb, positionId: number): void {
  const position = db.listPositions('PAPER').find((item) => item.id === positionId);
  if (!position) return;
  const snapshot = db.getLatestSnapshot(position.tokenId);
  db.createPaperPerformanceSnapshot(
    position.id,
    position.tokenId,
    new Date().toISOString(),
    snapshot?.priceUsd ?? null,
    position.unrealizedPnlUsd,
    position.unrealizedPnlPct,
    snapshot?.liquidityUsd ?? null,
    snapshot?.marketCapUsd ?? null,
    snapshot?.volume5mUsd ?? null,
    snapshot?.volume1hUsd ?? null,
    { symbol: position.symbol, mint: position.mint }
  );
}

export function runPaperReview(db: AppDb, config: AppConfig): { decisions: PaperReviewDecision[] } {
  const runLogId = db.createRunLog('token:paper-review');
  try {
    const decisions: PaperReviewDecision[] = [];
    const openPositions = db.listPositions('PAPER').filter((position) => position.status === 'OPEN');

    for (const position of openPositions) {
      capturePaperPerformance(db, position.id);
      const latest = db.listPositions('PAPER').find((item) => item.id === position.id)!;
      const pnlPct = latest.unrealizedPnlPct ?? 0;
      const minutesHeld = heldMinutes(latest.openedAt);
      let reason: string | null = null;

      if (pnlPct >= config.paperTakeProfitPct) reason = 'take_profit';
      else if (pnlPct <= config.paperStopLossPct) reason = 'stop_loss';
      else if (minutesHeld >= config.paperMaxHoldMinutes) reason = 'max_hold_time';

      if (reason) {
        const result = paperSell(db, { positionId: latest.id });
        const closed = db.listPositions('PAPER').find((item) => item.id === latest.id)!;
        db.logSafetyEvent(closed.tokenId, 'INFO', 'paper_position_closed', `Paper position closed via ${reason}`, { positionId: closed.id, realizedPnlUsd: result.realizedPnlUsd, exitReason: reason });
        decisions.push({ positionId: latest.id, symbol: latest.symbol, action: 'CLOSED', reason, pnlPct });
      } else {
        db.logSafetyEvent(latest.tokenId, 'INFO', 'paper_position_held', 'Paper position held after review', { positionId: latest.id, pnlPct, minutesHeld });
        decisions.push({ positionId: latest.id, symbol: latest.symbol, action: 'HELD', reason: 'hold', pnlPct });
      }
    }

    db.finishRunLog(runLogId, 'SUCCESS', { reviewed: openPositions.length, decisions });
    return { decisions };
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'unknown paper review error' });
    throw error;
  }
}
