import type { AppDb } from '../db';
import type { AppConfig, ResearchStatus, WatchOnlyCandidate } from '../types';
import { createGeckoTerminalSourceFromConfig } from '../scanner/geckoTerminalSource';

const DEFAULT_LIMIT = 25;
const DEFAULT_WINDOW_HOURS = 24;

function minutesSince(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / 60_000;
}

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null) return '-';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '-';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

interface SelectedEntry {
  candidate: WatchOnlyCandidate;
  symbol: string;
  mint: string;
  discoveryAgeMinutes: number;
}

export interface RefreshResult {
  symbol: string;
  mint: string;
  candidateId: number;
  tokenId: number;
  status: 'refreshed' | 'failed' | 'skipped';
  failReason?: string;
  entryPriceUsd: number | null;
  latestPriceUsd: number | null;
  returnPct: number | null;
  bestGainPct: number | null;
  snapshotInserted: boolean;
  watchUpdated: boolean;
}

export interface WatchRefreshReport {
  dryRun: boolean;
  windowHours: number;
  limit: number;
  totalWatchCandidates: number;
  geckoTerminalCandidates: number;
  candidatesSelected: number;
  candidatesSkipped: number;
  skipReasons: Record<string, number>;
  refreshed: number;
  failed: number;
  snapshotsInserted: number;
  watchUpdates: number;
  results: RefreshResult[];
  topMovers: Array<{ symbol: string; returnPct: number | null; bestGainPct: number | null }>;
  geckoSummary: Record<string, unknown>;
  finalSafetyStatus: string;
  noTradingBehaviorChanged: true;
}

export async function runWatchRefresh(
  db: AppDb,
  config: AppConfig,
  options: { limit?: number; windowHours?: number; dryRun?: boolean } = {}
): Promise<WatchRefreshReport> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const dryRun = options.dryRun ?? false;
  const windowMinutes = windowHours * 60;

  const allCandidates = db.listWatchOnlyCandidates();
  const totalWatchCandidates = allCandidates.length;

  const skipReasons: Record<string, number> = {};
  const selected: SelectedEntry[] = [];
  let geckoCount = 0;

  for (const candidate of allCandidates) {
    const tokenRecord = db.getTokenRecord(candidate.tokenId);
    if (!tokenRecord) continue;

    const discoveryAgeMinutes = minutesSince(candidate.createdAt);
    if (discoveryAgeMinutes > windowMinutes) {
      skipReasons['too_old'] = (skipReasons['too_old'] ?? 0) + 1;
      continue;
    }

    // Use the earliest snapshot (discovery state) to find the pool address
    const snapshot = db.getLatestSnapshot(candidate.tokenId);
    if (!snapshot) {
      skipReasons['no_snapshot'] = (skipReasons['no_snapshot'] ?? 0) + 1;
      continue;
    }

    const poolAddress = (snapshot.raw?.selectedPair as Record<string, unknown> | undefined)?.pairAddress;
    if (typeof poolAddress !== 'string' || !poolAddress) {
      skipReasons['no_pool_address'] = (skipReasons['no_pool_address'] ?? 0) + 1;
      continue;
    }

    geckoCount += 1;
    if (selected.length >= limit) break;
    selected.push({ candidate, symbol: tokenRecord.symbol, mint: tokenRecord.mint, discoveryAgeMinutes });
  }

  const candidatesSkipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);

  if (dryRun) {
    const results: RefreshResult[] = selected.map(({ candidate, symbol, mint }) => ({
      symbol,
      mint,
      candidateId: candidate.id,
      tokenId: candidate.tokenId,
      status: 'skipped',
      failReason: 'dry-run',
      entryPriceUsd: candidate.entryPriceUsd,
      latestPriceUsd: candidate.latestPriceUsd,
      returnPct: null,
      bestGainPct: candidate.bestGainPct,
      snapshotInserted: false,
      watchUpdated: false
    }));

    const topMovers = [...results]
      .filter((r) => r.bestGainPct != null)
      .sort((a, b) => (b.bestGainPct ?? 0) - (a.bestGainPct ?? 0))
      .slice(0, 5)
      .map((r) => ({ symbol: r.symbol, returnPct: r.returnPct, bestGainPct: r.bestGainPct }));

    return {
      dryRun: true,
      windowHours,
      limit,
      totalWatchCandidates,
      geckoTerminalCandidates: geckoCount,
      candidatesSelected: selected.length,
      candidatesSkipped,
      skipReasons,
      refreshed: 0,
      failed: 0,
      snapshotsInserted: 0,
      watchUpdates: 0,
      results,
      topMovers,
      geckoSummary: { dryRun: true, wouldAttempt: selected.length },
      finalSafetyStatus: 'Real trading remains locked.',
      noTradingBehaviorChanged: true
    };
  }

  // Live run: fetch current pool data from GeckoTerminal
  const geckoSource = createGeckoTerminalSourceFromConfig(config);
  const snapshotsForRefresh = selected.map(({ candidate }) => db.getLatestSnapshot(candidate.tokenId)!);

  // Pass windowMinutes as maxCandidateAgeMinutes so age filtering is based on our window, not token creation time
  const { refreshed: refreshedCandidates, summary: geckoSummary } =
    await geckoSource.refreshCandidatesByPoolAddresses(snapshotsForRefresh, windowMinutes, limit);

  const refreshedByMint = new Map(refreshedCandidates.map((c) => [c.mint, c]));

  const results: RefreshResult[] = [];
  let snapshotsInserted = 0;
  let watchUpdates = 0;
  let refreshedCount = 0;
  let failedCount = 0;

  for (const { candidate, symbol, mint } of selected) {
    const refreshed = refreshedByMint.get(mint);

    if (!refreshed) {
      failedCount += 1;
      results.push({
        symbol,
        mint,
        candidateId: candidate.id,
        tokenId: candidate.tokenId,
        status: 'failed',
        failReason: 'gecko refresh returned no data',
        entryPriceUsd: candidate.entryPriceUsd,
        latestPriceUsd: candidate.latestPriceUsd,
        returnPct: null,
        bestGainPct: candidate.bestGainPct,
        snapshotInserted: false,
        watchUpdated: false
      });
      continue;
    }

    db.insertSnapshot(candidate.tokenId, refreshed);
    snapshotsInserted += 1;

    db.upsertWatchOnlyCandidate(
      candidate.tokenId,
      candidate.status as ResearchStatus,
      candidate.reason,
      candidate.entryPriceUsd,
      refreshed.priceUsd ?? null,
      refreshed.liquidityUsd ?? null,
      refreshed.volume5mUsd ?? null,
      refreshed.volume1hUsd ?? null,
      { refreshSource: 'watch-refresh', refreshedAt: new Date().toISOString() }
    );
    watchUpdates += 1;
    refreshedCount += 1;

    const returnPct =
      candidate.entryPriceUsd != null && refreshed.priceUsd != null && candidate.entryPriceUsd > 0
        ? ((refreshed.priceUsd - candidate.entryPriceUsd) / candidate.entryPriceUsd) * 100
        : null;

    const newBestGainPct =
      returnPct != null
        ? Math.max(returnPct, candidate.bestGainPct ?? Number.NEGATIVE_INFINITY)
        : (candidate.bestGainPct ?? null);

    results.push({
      symbol,
      mint,
      candidateId: candidate.id,
      tokenId: candidate.tokenId,
      status: 'refreshed',
      entryPriceUsd: candidate.entryPriceUsd,
      latestPriceUsd: refreshed.priceUsd ?? null,
      returnPct,
      bestGainPct: newBestGainPct,
      snapshotInserted: true,
      watchUpdated: true
    });
  }

  const topMovers = [...results]
    .filter((r) => r.bestGainPct != null)
    .sort((a, b) => (b.bestGainPct ?? 0) - (a.bestGainPct ?? 0))
    .slice(0, 5)
    .map((r) => ({ symbol: r.symbol, returnPct: r.returnPct, bestGainPct: r.bestGainPct }));

  return {
    dryRun: false,
    windowHours,
    limit,
    totalWatchCandidates,
    geckoTerminalCandidates: geckoCount,
    candidatesSelected: selected.length,
    candidatesSkipped,
    skipReasons,
    refreshed: refreshedCount,
    failed: failedCount,
    snapshotsInserted,
    watchUpdates,
    results,
    topMovers,
    geckoSummary: geckoSummary as unknown as Record<string, unknown>,
    finalSafetyStatus: 'Real trading remains locked.',
    noTradingBehaviorChanged: true
  };
}

export function renderWatchRefreshReport(report: WatchRefreshReport): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  lines.push(report.dryRun ? 'Watch Refresh [DRY RUN — no DB writes]' : 'Watch Refresh');
  lines.push(sep);
  lines.push(`Window: last ${report.windowHours}h | Limit: ${report.limit}`);
  lines.push(`Watch candidates: ${report.totalWatchCandidates} total | ${report.geckoTerminalCandidates} with pool address`);
  lines.push(`Selected: ${report.candidatesSelected} | Skipped: ${report.candidatesSkipped}`);

  if (Object.keys(report.skipReasons).length > 0) {
    lines.push(`  Skip reasons: ${Object.entries(report.skipReasons).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  lines.push('');

  if (report.dryRun) {
    lines.push(`Would attempt refresh for ${report.candidatesSelected} candidates:`);
    for (const r of report.results) {
      lines.push(
        `  ${r.symbol.padEnd(16)} entry=${fmtMoney(r.entryPriceUsd)} current=${fmtMoney(r.latestPriceUsd)} best_gain=${fmtPct(r.bestGainPct)}`
      );
    }
  } else {
    lines.push(`Refreshed: ${report.refreshed} | Failed: ${report.failed}`);
    lines.push(`Snapshots inserted: ${report.snapshotsInserted} | Watch records updated: ${report.watchUpdates}`);

    if (report.topMovers.length > 0) {
      lines.push('');
      lines.push('Top movers since discovery (by best peak gain):');
      for (const m of report.topMovers) {
        lines.push(
          `  ${m.symbol.padEnd(16)} current=${fmtPct(m.returnPct).padStart(8)} best=${fmtPct(m.bestGainPct).padStart(8)}`
        );
      }
    }

    if (report.results.length > 0) {
      lines.push('');
      lines.push('Per-candidate:');
      for (const r of report.results) {
        const tag = r.status === 'refreshed' ? 'OK  ' : r.status === 'failed' ? 'FAIL' : 'SKIP';
        lines.push(
          `  [${tag}] ${r.symbol.padEnd(16)} entry=${fmtMoney(r.entryPriceUsd).padStart(8)} now=${fmtMoney(r.latestPriceUsd).padStart(8)} return=${fmtPct(r.returnPct).padStart(8)} best=${fmtPct(r.bestGainPct).padStart(8)}${r.failReason ? `  (${r.failReason})` : ''}`
        );
      }
    }

    const gs = report.geckoSummary;
    if (gs && typeof gs === 'object') {
      lines.push('');
      lines.push(
        `GeckoTerminal: attempted=${gs['geckoRefreshAttempted']} ok=${gs['geckoRefreshSucceeded']} failed=${gs['geckoRefreshFailed']} missing_addr=${gs['geckoRefreshMissingPoolAddress']} skipped_old=${gs['geckoRefreshSkippedOld']}`
      );
    }
  }

  lines.push('');
  lines.push(report.finalSafetyStatus);
  lines.push('No trading behavior changed.');

  return lines.join('\n');
}
