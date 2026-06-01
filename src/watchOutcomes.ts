import { runScan } from './scanner';
import { scoreAllTokens } from './scoring/scoreToken';
import type { AppDb } from './db';
import type { AppConfig, WatchOnlyCandidate } from './types';
import { AppLogger } from './logger';

const WINDOWS = [
  { label: '15m', targetMinutes: 15 },
  { label: '1h', targetMinutes: 60 },
  { label: '6h', targetMinutes: 360 },
  { label: '24h', targetMinutes: 1440 }
] as const;

function minutesSince(createdAt: string): number {
  return (Date.now() - new Date(createdAt).getTime()) / 60_000;
}

export function calculateReturnPct(entryPriceUsd: number | null, observedPriceUsd: number | null): number | null {
  if (!entryPriceUsd || !observedPriceUsd || entryPriceUsd <= 0) return null;
  return Number((((observedPriceUsd - entryPriceUsd) / entryPriceUsd) * 100).toFixed(4));
}

export function isDue(createdAt: string, targetMinutes: number): boolean {
  return minutesSince(createdAt) >= targetMinutes;
}

function outcomeRow(candidate: WatchOnlyCandidate, snapshot: any, config: AppConfig) {
  const returnPct = calculateReturnPct(candidate.entryPriceUsd, snapshot?.priceUsd ?? null);
  const bestGainPct = candidate.bestGainPct ?? returnPct;
  const worstDrawdownPct = candidate.worstDrawdownPct ?? returnPct;
  return {
    observedAt: new Date().toISOString(),
    entryPriceUsd: candidate.entryPriceUsd,
    observedPriceUsd: snapshot?.priceUsd ?? null,
    returnPct,
    bestGainPct,
    worstDrawdownPct,
    wouldHitTakeProfit: (bestGainPct ?? Number.NEGATIVE_INFINITY) >= config.paperTakeProfitPct,
    wouldHitStopLoss: (worstDrawdownPct ?? Number.POSITIVE_INFINITY) <= config.paperStopLossPct,
    liquidityUsd: snapshot?.liquidityUsd ?? null,
    volume5mUsd: snapshot?.volume5mUsd ?? null,
    volume1hUsd: snapshot?.volume1hUsd ?? null
  };
}

export async function runWatchOutcomes(db: AppDb, config: AppConfig, logger = new AppLogger()): Promise<{ recorded: number; skipped: number }> {
  const runLogId = db.createRunLog('token:watch-outcomes');
  try {
    await runScan(db, config, logger);
    scoreAllTokens(db, config);
    let recorded = 0;
    let skipped = 0;

    for (const candidate of db.listWatchOnlyCandidates()) {
      const snapshot = db.getLatestSnapshot(candidate.tokenId);
      for (const window of WINDOWS) {
        if (!isDue(candidate.createdAt, window.targetMinutes)) {
          skipped += 1;
          continue;
        }
        if (db.getWatchOnlyOutcome(candidate.id, window.label)) {
          skipped += 1;
          continue;
        }

        const row = outcomeRow(candidate, snapshot, config);
        db.createWatchOnlyOutcome(
          candidate.id,
          candidate.tokenId,
          window.label,
          window.targetMinutes,
          row.observedAt,
          row.entryPriceUsd,
          row.observedPriceUsd,
          row.returnPct,
          row.bestGainPct,
          row.worstDrawdownPct,
          row.wouldHitTakeProfit,
          row.wouldHitStopLoss,
          row.liquidityUsd,
          row.volume5mUsd,
          row.volume1hUsd,
          `watch-only outcome recorded for ${window.label}`,
          { windowLabel: window.label, targetMinutes: window.targetMinutes }
        );
        recorded += 1;
      }
    }

    db.finishRunLog(runLogId, 'SUCCESS', { recorded, skipped });
    return { recorded, skipped };
  } catch (error) {
    db.finishRunLog(runLogId, 'FAILED', { error: error instanceof Error ? error.message : 'unknown watch outcomes error' });
    throw error;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4)) : Number(sorted[mid].toFixed(4));
}

export function summarizeWatchOutcomes(db: AppDb, config: AppConfig): Record<string, unknown> {
  const outcomes = db.listWatchOnlyOutcomes();
  const windows = ['15m', '1h', '6h', '24h'];
  const summary: Record<string, unknown> = {};

  for (const windowLabel of windows) {
    const items = outcomes.filter((outcome) => outcome.windowLabel === windowLabel);
    const returns = items.map((item) => item.returnPct).filter((value): value is number => value !== null);
    const best = [...items].sort((a, b) => (b.returnPct ?? Number.NEGATIVE_INFINITY) - (a.returnPct ?? Number.NEGATIVE_INFINITY))[0] ?? null;
    const worst = [...items].sort((a, b) => (a.returnPct ?? Number.POSITIVE_INFINITY) - (b.returnPct ?? Number.POSITIVE_INFINITY))[0] ?? null;
    summary[windowLabel] = {
      count: items.length,
      averageReturnPct: returns.length > 0 ? Number((returns.reduce((sum, value) => sum + value, 0) / returns.length).toFixed(4)) : null,
      medianReturnPct: median(returns),
      bestCandidate: best,
      worstCandidate: worst,
      takeProfitHitPct: items.length > 0 ? Number(((items.filter((item) => item.wouldHitTakeProfit).length / items.length) * 100).toFixed(2)) : 0,
      stopLossHitPct: items.length > 0 ? Number(((items.filter((item) => item.wouldHitStopLoss).length / items.length) * 100).toFixed(2)) : 0
    };
  }

  const winners = outcomes.filter((outcome) => (outcome.returnPct ?? Number.NEGATIVE_INFINITY) > 0);
  const losers = outcomes.filter((outcome) => (outcome.returnPct ?? Number.POSITIVE_INFINITY) < 0);
  const states = db.listLatestTokenStates(100);
  const topPositiveSignals = (() => {
    const reasons = winners.flatMap((winner) => states.find((state) => state.tokenId === winner.tokenId)?.score?.reasons ?? []);
    const counts = new Map<string, number>();
    for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
  })();
  const topRedFlagsAmongLosers = (() => {
    const flags = losers.flatMap((loser) => states.find((state) => state.tokenId === loser.tokenId)?.score?.redFlags ?? []);
    const counts = new Map<string, number>();
    for (const flag of flags) counts.set(flag, (counts.get(flag) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
  })();

  return {
    outcomesRecordedByWindow: summary,
    paperTakeProfitPct: config.paperTakeProfitPct,
    paperStopLossPct: config.paperStopLossPct,
    topPositiveSignalsAmongWinners: topPositiveSignals,
    topRedFlagsAmongLosers,
    finalSafetyStatus: 'Real trading remains locked.'
  };
}
