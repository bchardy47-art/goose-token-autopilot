import type { AppDb } from '../db';
import type { AppConfig, PaperReviewDecision } from '../types';
import { paperSell } from '../trading/paper';
import * as scanner from '../scanner';

export interface PaperReviewResult {
  decisions: PaperReviewDecision[];
  refreshedCount: number;
  reviewedCount: number;
  remainingOpenCount: number;
}

export interface PaperReviewLoopCycleSummary {
  cycleNumber: number;
  reviewedCount: number;
  refreshedCount: number;
  remainingOpenCount: number;
  decisions: PaperReviewDecision[];
}

export interface PaperReviewLoopResult {
  cyclesRun: number;
  intervalMs: number;
  maxCycles: number;
  stoppedReason: 'no_open_positions' | 'max_cycles_reached';
  cycleSummaries: PaperReviewLoopCycleSummary[];
}

export interface PaperReviewLoopOptions {
  intervalMs?: number;
  maxCycles?: number;
  sleep?: (ms: number) => Promise<void>;
  onCycle?: (summary: PaperReviewLoopCycleSummary) => void | Promise<void>;
}

function heldMinutes(openedAt: string): number {
  return (Date.now() - new Date(openedAt).getTime()) / 60_000;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function runPaperReview(db: AppDb, config: AppConfig): Promise<PaperReviewResult> {
  const runLogId = db.createRunLog('token:paper-review');
  try {
    const decisions: PaperReviewDecision[] = [];
    const openPositions = db.listPositions('PAPER').filter((position) => position.status === 'OPEN');
    const reviewedCount = openPositions.length;
    const refreshTargets = [...new Set(openPositions.map((position) => position.mint))];
    let refreshedCount = 0;

    if (refreshTargets.length > 0) {
      try {
        const refresh = await scanner.refreshSnapshotsForTokenAddresses(db, config, refreshTargets);
        refreshedCount = refresh.refreshed;
      } catch {
        refreshedCount = 0;
      }
    }

    for (const position of openPositions) {
      const oldSnapshot = db.getLatestSnapshot(position.tokenId);
      capturePaperPerformance(db, position.id);
      const latest = db.listPositions('PAPER').find((item) => item.id === position.id)!;
      const newSnapshot = db.getLatestSnapshot(position.tokenId);
      const pnlPct = latest.unrealizedPnlPct ?? 0;
      const minutesHeld = heldMinutes(latest.openedAt);
      const bestGainPct = Math.max(position.bestGainPct ?? Number.NEGATIVE_INFINITY, latest.bestGainPct ?? Number.NEGATIVE_INFINITY, 0);
      const pullbackFromPeakPct = Number((bestGainPct - pnlPct).toFixed(4));
      let reason: string | null = null;

      if (pnlPct >= config.paperTakeProfitPct) reason = 'take_profit';
      else if (pnlPct <= config.paperStopLossPct) reason = 'stop_loss';
      else if (minutesHeld >= config.paperMaxHoldMinutes) reason = 'max_hold_time';
      else if (
        config.paperTrailingStopEnabled &&
        bestGainPct >= config.paperTrailingActivationPct &&
        pullbackFromPeakPct >= config.paperTrailingStopPct
      ) reason = 'trailing_stop';

      const refreshMeta = {
        priceRefreshed: (oldSnapshot?.priceUsd ?? null) !== (newSnapshot?.priceUsd ?? null),
        oldPriceUsd: oldSnapshot?.priceUsd ?? null,
        newPriceUsd: newSnapshot?.priceUsd ?? null,
        pullbackFromPeakPct,
        bestGainPct,
        refreshError: newSnapshot ? null : 'refresh_failed_or_missing_snapshot'
      };

      if (reason) {
        const result = paperSell(db, { positionId: latest.id });
        const closed = db.listPositions('PAPER').find((item) => item.id === latest.id)!;
        db.logSafetyEvent(closed.tokenId, 'INFO', 'paper_position_closed', `Paper position closed via ${reason}`, { positionId: closed.id, realizedPnlUsd: result.realizedPnlUsd, exitReason: reason, ...refreshMeta });
        decisions.push({ positionId: latest.id, symbol: latest.symbol, action: 'CLOSED', reason, pnlPct });
      } else {
        db.logSafetyEvent(latest.tokenId, 'INFO', 'paper_position_held', 'Paper position held after review', { positionId: latest.id, pnlPct, minutesHeld, ...refreshMeta });
        decisions.push({ positionId: latest.id, symbol: latest.symbol, action: 'HELD', reason: 'hold', pnlPct });
      }
    }

    const remainingOpenCount = db.getOpenPositionCount('PAPER');
    db.finishRunLog(runLogId, 'SUCCESS', { reviewed: reviewedCount, refreshedCount, remainingOpenCount, decisions });
    return { decisions, refreshedCount, reviewedCount, remainingOpenCount };
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'unknown paper review error' });
    throw error;
  }
}

export async function runPaperReviewLoop(db: AppDb, config: AppConfig, options: PaperReviewLoopOptions = {}): Promise<PaperReviewLoopResult> {
  const intervalMs = options.intervalMs ?? 60_000;
  const maxCycles = options.maxCycles ?? 30;
  const sleep = options.sleep ?? wait;

  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('paper review loop intervalMs must be a non-negative number');
  }

  if (!Number.isInteger(maxCycles) || maxCycles < 0) {
    throw new Error('paper review loop maxCycles must be a non-negative integer');
  }

  const cycleSummaries: PaperReviewLoopCycleSummary[] = [];

  if (db.getOpenPositionCount('PAPER') === 0) {
    return {
      cyclesRun: 0,
      intervalMs,
      maxCycles,
      stoppedReason: 'no_open_positions',
      cycleSummaries
    };
  }

  for (let cycleNumber = 1; cycleNumber <= maxCycles; cycleNumber += 1) {
    const review = await runPaperReview(db, config);
    const cycleSummary: PaperReviewLoopCycleSummary = {
      cycleNumber,
      reviewedCount: review.reviewedCount,
      refreshedCount: review.refreshedCount,
      remainingOpenCount: review.remainingOpenCount,
      decisions: review.decisions
    };

    cycleSummaries.push(cycleSummary);
    await options.onCycle?.(cycleSummary);

    if (cycleSummary.remainingOpenCount === 0) {
      return {
        cyclesRun: cycleSummaries.length,
        intervalMs,
        maxCycles,
        stoppedReason: 'no_open_positions',
        cycleSummaries
      };
    }

    if (cycleNumber < maxCycles) {
      await sleep(intervalMs);
    }
  }

  return {
    cyclesRun: cycleSummaries.length,
    intervalMs,
    maxCycles,
    stoppedReason: 'max_cycles_reached',
    cycleSummaries
  };
}
