import type { AppDb } from '../db';
import type { AppConfig, TokenCandidate } from '../types';

const DEFAULT_HOURS = 6;
const DEFAULT_LIMIT = 50;
const DEFAULT_TOP = 20;

// Watch-only gate thresholds (mirror qualifiesForWatchOnly in watchOnly.ts)
const WATCH_LIQUIDITY_MIN = 5000;
const WATCH_MAX_TOKEN_AGE_HOURS = 24;

function minutesSince(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / 60_000;
}

function tokenAgeHours(snap: TokenCandidate): number | null {
  const ms = new Date(snap.tokenCreatedAt).getTime();
  if (Number.isNaN(ms)) return null;
  return (Date.now() - ms) / 3_600_000;
}

function buySellRatio(snap: TokenCandidate): number {
  return (snap.buys5m ?? 0) / Math.max(1, snap.sells5m ?? 0);
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '-';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function fmtPct(v: number | null | undefined, d = 1): string {
  if (v == null) return '-';
  return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
}

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${minutes.toFixed(0)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

// Returns all criteria failures for a snapshot — not just the first one.
// Mirrors the checks in qualifiesForWatchOnly but collects all reasons.
function analyzeRejections(snap: TokenCandidate | null): string[] {
  if (!snap) return ['no snapshot stored'];

  const reasons: string[] = [];

  if (snap.source !== 'dexscreener' && snap.source !== 'geckoterminal') {
    reasons.push(`source=${snap.source} — watch-only lane requires source=dexscreener or source=geckoterminal`);
  }
  if ((snap.priceUsd ?? 0) <= 0) reasons.push('missing price (priceUsd=0)');
  if ((snap.liquidityUsd ?? 0) < WATCH_LIQUIDITY_MIN) {
    reasons.push(`liquidity ${fmtMoney(snap.liquidityUsd)} < $${WATCH_LIQUIDITY_MIN} watch threshold`);
  }
  if ((snap.marketCapUsd ?? 0) <= 0) reasons.push('missing market cap / fdv');

  const ageH = tokenAgeHours(snap);
  if (ageH !== null && ageH > WATCH_MAX_TOKEN_AGE_HOURS) {
    reasons.push(`token age ${ageH.toFixed(1)}h > ${WATCH_MAX_TOKEN_AGE_HOURS}h limit`);
  }

  if (snap.mintAuthority === 'UNSAFE') reasons.push('mint authority UNSAFE');
  if (snap.freezeAuthority === 'UNSAFE') reasons.push('freeze authority UNSAFE');
  if (snap.sellQuoteAvailable === 'NO') reasons.push('sell quote explicitly NO');

  const hasPC5m = (snap.priceChange5mPct ?? 0) > 20;
  const hasPC1h = (snap.priceChange1hPct ?? 0) > 50;
  const hasVol5m = (snap.volume5mUsd ?? 0) > 5000;
  const hasBuys = (snap.buys5m ?? 0) >= 20;
  const hasBsr = buySellRatio(snap) >= 1.5 && (snap.buys5m ?? 0) >= 20;

  if (!hasPC5m && !hasPC1h && !hasVol5m && !hasBuys && !hasBsr) {
    reasons.push(
      `no watch momentum signal (pc5m=${fmtPct(snap.priceChange5mPct)} pc1h=${fmtPct(snap.priceChange1hPct)} vol5m=${fmtMoney(snap.volume5mUsd)} buys5m=${snap.buys5m ?? 0})`
    );
  }

  return reasons;
}

// Normalize reason string for counting by stripping numeric values
function normalizeKey(reason: string): string {
  return reason
    .replace(/\$[\d.,]+[kKmM]?/g, '$X')
    .replace(/\d+\.\d+h/g, 'X.Xh')
    .replace(/\+[\d.]+%/g, '+X%')
    .replace(/-[\d.]+%/g, '-X%')
    .replace(/=[\d.-]+/g, '=X');
}

interface TokenDiagRow {
  tokenId: number;
  symbol: string;
  source: string;
  firstSeenAt: string;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  priceChange5mPct: number | null;
  movedBeforeDiscoveryPct: number | null;
  verdict: string | null;
  totalScore: number | null;
  isWatchlisted: boolean;
  rejectionReasons: string[];
  // Near miss: only blocked by source gate, would pass all other criteria
  isNearMiss: boolean;
}

export interface ScanRejectionReport {
  hoursWindow: number;
  limit: number;
  cutoff: string;
  totalRecentTokens: number;
  watchlistedCount: number;
  notWatchlistedCount: number;
  conversionRatePct: number;
  sourceSummaryAvailable: boolean;
  scanRunsInWindow: number;
  totalSourceAccepted: number;
  totalSourceRejectedLowLiquidity: number;
  totalSourceRejectedStale: number;
  totalSourceRejectedMissingMint: number;
  geckoMinReserveUsd: number;
  topRejectionReasons: Array<{ reason: string; count: number }>;
  verdictCounts: Record<string, number>;
  notWatchlistedTokens: TokenDiagRow[];
  nearMisses: TokenDiagRow[];
  diagnosisPoints: string[];
  noTradingBehaviorChanged: true;
}

export function buildScanRejectionReport(
  db: AppDb,
  config: AppConfig,
  options: { hours?: number; limit?: number; top?: number } = {}
): ScanRejectionReport {
  const hours = options.hours ?? DEFAULT_HOURS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const top = options.top ?? DEFAULT_TOP;
  const sql = db.sqlite;

  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();

  // Recent tokens with latest snapshot, score, and watch-list status
  const tokenRows = sql.prepare(`
    SELECT
      t.id          AS token_id,
      t.symbol,
      t.source,
      t.first_seen_at,
      snap.raw_json AS snapshot_raw,
      s.verdict,
      s.total_score,
      CASE WHEN wc.id IS NOT NULL THEN 1 ELSE 0 END AS is_watchlisted
    FROM tokens t
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = t.id ORDER BY id DESC LIMIT 1
    )
    LEFT JOIN token_scores s ON s.id = (
      SELECT id FROM token_scores WHERE token_id = t.id ORDER BY scored_at DESC, id DESC LIMIT 1
    )
    LEFT JOIN watch_only_candidates wc ON wc.token_id = t.id
    WHERE t.first_seen_at >= ?
    ORDER BY t.first_seen_at DESC
    LIMIT ?
  `).all(cutoff, limit) as Array<{
    token_id: number;
    symbol: string;
    source: string;
    first_seen_at: string;
    snapshot_raw: string | null;
    verdict: string | null;
    total_score: number | null;
    is_watchlisted: number;
  }>;

  // Scan run_logs for source-level summary
  const scanLogs = sql.prepare(`
    SELECT summary_json
    FROM run_logs
    WHERE run_type = 'token:scan'
      AND started_at >= ?
      AND status = 'SUCCESS'
    ORDER BY id DESC
    LIMIT 100
  `).all(cutoff) as Array<{ summary_json: string }>;

  let totalSourceAccepted = 0;
  let totalSourceRejectedLowLiquidity = 0;
  let totalSourceRejectedStale = 0;
  let totalSourceRejectedMissingMint = 0;

  for (const log of scanLogs) {
    const summary = JSON.parse(log.summary_json) as Record<string, unknown>;
    const ss = summary.sourceSummary as Record<string, number> | null | undefined;
    if (ss) {
      totalSourceAccepted += ss.candidatesAccepted ?? 0;
      totalSourceRejectedLowLiquidity += ss.lowLiquidityRejectedCount ?? 0;
      totalSourceRejectedStale += ss.staleRejectedCount ?? 0;
      totalSourceRejectedMissingMint += ss.missingMintRejectedCount ?? 0;
    }
  }

  // Build per-token diagnostics
  const diagRows: TokenDiagRow[] = tokenRows.map((row) => {
    const snap: TokenCandidate | null = row.snapshot_raw ? JSON.parse(row.snapshot_raw) as TokenCandidate : null;
    const rejections = analyzeRejections(snap);
    const onlySourceGate = rejections.length === 1 && rejections[0].startsWith('source=');

    return {
      tokenId: row.token_id,
      symbol: row.symbol ?? 'UNKNOWN',
      source: row.source ?? 'unknown',
      firstSeenAt: row.first_seen_at,
      liquidityUsd: snap?.liquidityUsd ?? null,
      volume5mUsd: snap?.volume5mUsd ?? null,
      priceChange5mPct: snap?.priceChange5mPct ?? null,
      movedBeforeDiscoveryPct: snap?.movedBeforeDiscoveryPct ?? null,
      verdict: row.verdict ?? null,
      totalScore: row.total_score ?? null,
      isWatchlisted: row.is_watchlisted === 1,
      rejectionReasons: rejections,
      isNearMiss: onlySourceGate,
    };
  });

  const watchlistedCount = diagRows.filter((r) => r.isWatchlisted).length;
  const notWatchlistedRows = diagRows.filter((r) => !r.isWatchlisted);
  const nearMisses = notWatchlistedRows.filter((r) => r.isNearMiss).slice(0, top);

  // Aggregate primary rejection reasons (first failure per token)
  const reasonCounts = new Map<string, number>();
  for (const row of notWatchlistedRows) {
    const primary = row.rejectionReasons[0] ?? 'unknown';
    const key = normalizeKey(primary);
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  const topRejectionReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([reason, count]) => ({ reason, count }));

  const verdictCounts: Record<string, number> = {};
  for (const row of diagRows) {
    const v = row.verdict ?? 'NO_SCORE';
    verdictCounts[v] = (verdictCounts[v] ?? 0) + 1;
  }

  // Diagnosis
  const diagnosisPoints: string[] = [];
  const sourceGateCount = notWatchlistedRows.filter((r) =>
    r.rejectionReasons.some((s) => s.startsWith('source='))
  ).length;
  const noMomentumCount = notWatchlistedRows.filter((r) =>
    r.rejectionReasons.some((s) => s.startsWith('no watch momentum'))
  ).length;

  if (diagRows.length === 0) {
    diagnosisPoints.push(
      `No tokens found in the last ${hours}h. No recent scan activity or DB is empty for this window.`
    );
  } else if (config.tokenSource === 'geckoterminal' && sourceGateCount > 0) {
    diagnosisPoints.push(
      `${sourceGateCount} token(s) rejected by source gate (watch-only requires dexscreener or geckoterminal).`
    );
    diagnosisPoints.push(
      `GeckoTerminal tokens are now eligible for the watch-only lane when they meet all other criteria.`
    );
  } else if (sourceGateCount > 0) {
    diagnosisPoints.push(
      `${sourceGateCount} token(s) rejected by source gate (watch-only requires dexscreener).`
    );
  }

  if (totalSourceRejectedLowLiquidity > 0 && scanLogs.length > 0) {
    diagnosisPoints.push(
      `GeckoTerminal source filter: ${totalSourceRejectedLowLiquidity} pool(s) rejected for reserve < $${(config.geckoTerminalMinReserveUsd / 1000).toFixed(0)}k across ${scanLogs.length} scan run(s). Most pools never reach the DB.`
    );
  }

  if (noMomentumCount > 0) {
    diagnosisPoints.push(
      `${noMomentumCount} token(s) also lack momentum (pc5m>20%, pc1h>50%, vol5m>$5k, or buys5m>=20) — would fail watch gate even if source were fixed.`
    );
  }

  if (diagnosisPoints.length === 0) {
    diagnosisPoints.push('No dominant rejection pattern found. Review per-token rows below.');
  }

  return {
    hoursWindow: hours,
    limit,
    cutoff,
    totalRecentTokens: diagRows.length,
    watchlistedCount,
    notWatchlistedCount: notWatchlistedRows.length,
    conversionRatePct: diagRows.length > 0 ? (watchlistedCount / diagRows.length) * 100 : 0,
    sourceSummaryAvailable: scanLogs.length > 0,
    scanRunsInWindow: scanLogs.length,
    totalSourceAccepted,
    totalSourceRejectedLowLiquidity,
    totalSourceRejectedStale,
    totalSourceRejectedMissingMint,
    geckoMinReserveUsd: config.geckoTerminalMinReserveUsd,
    topRejectionReasons,
    verdictCounts,
    notWatchlistedTokens: notWatchlistedRows.slice(0, top),
    nearMisses,
    diagnosisPoints,
    noTradingBehaviorChanged: true,
  };
}

export function renderScanRejectionReport(report: ScanRejectionReport): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  // 1. Header
  lines.push('Scan Rejection Report');
  lines.push(sep);
  lines.push(`Timeframe: last ${report.hoursWindow}h | Cutoff: ${new Date(report.cutoff).toISOString()}`);
  lines.push(`Total recent tokens:       ${report.totalRecentTokens}`);
  lines.push(`Watch-only candidates:     ${report.watchlistedCount}`);
  lines.push(`Not watchlisted:           ${report.notWatchlistedCount}`);
  lines.push(`Conversion rate:           ${report.conversionRatePct.toFixed(1)}%`);
  lines.push('');

  // 2. Source-level
  lines.push('Source-Level Rejections');
  lines.push(sep);
  if (!report.sourceSummaryAvailable) {
    lines.push('  No scan run_logs found in this window.');
    lines.push('  Source-level summaries (lowLiquidity/stale counts) are not persisted across sessions.');
    lines.push('  Run token:scan or token:watch-cycle first, then re-run this report in the same session window.');
  } else {
    lines.push(`  Scan runs in window:                ${report.scanRunsInWindow}`);
    lines.push(`  Candidates accepted past source:    ${report.totalSourceAccepted}`);
    lines.push(`  Rejected low liquidity (< $${(report.geckoMinReserveUsd / 1000).toFixed(0)}k): ${report.totalSourceRejectedLowLiquidity}`);
    lines.push(`  Rejected stale pool/data:           ${report.totalSourceRejectedStale}`);
    lines.push(`  Rejected missing mint:              ${report.totalSourceRejectedMissingMint}`);
    lines.push(`  GeckoTerminal min reserve:          $${report.geckoMinReserveUsd.toLocaleString()}`);
  }
  lines.push('');

  // 3. Scoring / watchlist gate
  lines.push('Scoring / Watchlist Rejections');
  lines.push(sep);
  lines.push('  Verdict counts (all recent tokens):');
  for (const [verdict, count] of Object.entries(report.verdictCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${verdict.padEnd(24)} ${count}`);
  }
  lines.push('');
  lines.push(`  Top primary rejection reasons (${report.notWatchlistedCount} not-watchlisted):`);
  if (report.topRejectionReasons.length === 0) {
    lines.push('    (none)');
  } else {
    for (const { reason, count } of report.topRejectionReasons) {
      lines.push(`    [${String(count).padStart(3)}]  ${reason}`);
    }
  }
  lines.push('');

  // 4. Per-token rows
  lines.push('Recent Scanned Tokens Not Watchlisted');
  lines.push(sep);
  if (report.notWatchlistedTokens.length === 0) {
    lines.push('  (none — all recent tokens are watchlisted, or no recent tokens found)');
  } else {
    for (const t of report.notWatchlistedTokens) {
      const age = fmtAge(minutesSince(t.firstSeenAt));
      lines.push(
        `  [${t.tokenId}] ${t.symbol.padEnd(14)} src=${t.source.padEnd(14)} age=${age.padEnd(6)}` +
        ` liq=${fmtMoney(t.liquidityUsd).padEnd(8)} vol5m=${fmtMoney(t.volume5mUsd).padEnd(8)}` +
        ` pc5m=${fmtPct(t.priceChange5mPct).padEnd(8)} verdict=${t.verdict ?? 'none'}`
      );
      for (const reason of t.rejectionReasons) {
        lines.push(`         - ${reason}`);
      }
    }
  }
  lines.push('');

  // 5. Near misses
  lines.push('Near Misses');
  lines.push(sep);
  lines.push('  (tokens blocked only by source gate; would qualify if source=dexscreener or source=geckoterminal)');
  if (report.nearMisses.length === 0) {
    lines.push('  (none in this window)');
  } else {
    for (const t of report.nearMisses) {
      lines.push(
        `  [${t.tokenId}] ${t.symbol.padEnd(14)}` +
        ` liq=${fmtMoney(t.liquidityUsd).padEnd(8)} vol5m=${fmtMoney(t.volume5mUsd).padEnd(8)}` +
        ` pc5m=${fmtPct(t.priceChange5mPct)} moved=${fmtPct(t.movedBeforeDiscoveryPct)}`
      );
    }
  }
  lines.push('');

  // 6. Diagnosis
  lines.push('Diagnosis');
  lines.push(sep);
  for (const point of report.diagnosisPoints) {
    lines.push(`  * ${point}`);
  }
  lines.push('');

  // 7. Safety footer
  lines.push('Safety');
  lines.push(sep);
  lines.push('  Report only. No DB writes. No network calls.');
  lines.push('  No trading behavior changed. No thresholds changed.');
  lines.push('  Real trading remains locked.');

  return lines.join('\n');
}
