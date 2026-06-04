import type { AppDb } from '../db';
import type { AppConfig, TokenCandidate } from '../types';

const DEFAULT_HOURS = 6;
const DEFAULT_LIMIT = 50;
const DEFAULT_TOP = 20;
const DEFAULT_MIN_LIQUIDITY = 50_000;
const DEFAULT_MAX_MOVED = 25;
const DEFAULT_MIN_BSR = 2.0;
const DEFAULT_MIN_PC5M = 3;
const DEFAULT_MAX_PC5M = 75;
const DEFAULT_MAX_SLIPPAGE_BPS = 200;
const WINNER_MIN_GAIN_PCT = 100;

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '-';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

function fmtPct(v: number | null | undefined, d = 1): string {
  if (v == null) return '-';
  return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
}

function minutesSince(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / 60_000;
}

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${minutes.toFixed(0)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

function bsr(snap: TokenCandidate): number {
  return (snap.buys5m ?? 0) / Math.max(1, snap.sells5m ?? 0);
}

export type ShadowLabel = 'SHADOW_MATCH' | 'WATCH_MORE' | 'REJECT';

interface RejectReason {
  field: string;
  detail: string;
}

export interface ShadowRow {
  watchId: number;
  tokenId: number;
  symbol: string;
  source: string;
  createdAt: string;
  watchStatus: string;
  label: ShadowLabel;
  tradabilityUnknown: boolean;
  liquidityUsd: number | null;
  priceUsd: number | null;
  buySellRatio: number;
  priceChange5mPct: number | null;
  volume5mUsd: number | null;
  movedBeforeDiscoveryPct: number | null;
  estimatedSlippageBps: number | null;
  freezeAuthority: string;
  mintAuthority: string;
  sellQuoteAvailable: string;
  return15m: number | null;
  return30m: number | null;
  bestGainPct: number | null;
  worstDrawdownPct: number | null;
  rejectReasons: RejectReason[];
  watchMoreReasons: string[];
}

export interface HistoricalWinnerRow {
  tokenId: number;
  symbol: string;
  bestGainPct: number;
  entryLiquidityUsd: number | null;
  entryBuySellRatio: number | null;
  entryPc5mPct: number | null;
  entryMovedPct: number | null;
  entrySlippageBps: number | null;
}

export interface ShadowCandidateReport {
  hoursWindow: number;
  limit: number;
  top: number;
  cutoff: string;
  params: {
    minLiquidity: number;
    maxMoved: number;
    minBsr: number;
    minPc5m: number;
    maxPc5m: number;
    maxSlippageBps: number;
  };
  totalScanned: number;
  shadowMatches: ShadowRow[];
  watchMore: ShadowRow[];
  rejected: ShadowRow[];
  historicalWinners: HistoricalWinnerRow[];
  noTradingBehaviorChanged: true;
}

interface ShadowParams {
  minLiquidity: number;
  maxMoved: number;
  minBsr: number;
  minPc5m: number;
  maxPc5m: number;
  maxSlippageBps: number;
}

function evaluateCandidate(
  snap: TokenCandidate,
  return15m: number | null,
  return30m: number | null,
  params: ShadowParams
): {
  label: ShadowLabel;
  rejectReasons: RejectReason[];
  watchMoreReasons: string[];
  tradabilityUnknown: boolean;
} {
  const rejectReasons: RejectReason[] = [];

  if ((snap.liquidityUsd ?? 0) < params.minLiquidity) {
    rejectReasons.push({
      field: 'liquidityUsd',
      detail: `${fmtMoney(snap.liquidityUsd)} < ${fmtMoney(params.minLiquidity)} threshold`,
    });
  }

  if (snap.movedBeforeDiscoveryPct !== null && snap.movedBeforeDiscoveryPct >= params.maxMoved) {
    rejectReasons.push({
      field: 'movedBeforeDiscoveryPct',
      detail: `${snap.movedBeforeDiscoveryPct.toFixed(1)}% >= ${params.maxMoved}% max`,
    });
  }

  const ratio = bsr(snap);
  if (ratio < params.minBsr) {
    rejectReasons.push({
      field: 'buySellRatio',
      detail: `${ratio.toFixed(2)} < ${params.minBsr} min`,
    });
  }

  const pc5m = snap.priceChange5mPct;
  if (pc5m === null) {
    rejectReasons.push({
      field: 'priceChange5mPct',
      detail: `null — required ${params.minPc5m}–${params.maxPc5m}%`,
    });
  } else if (pc5m < params.minPc5m || pc5m > params.maxPc5m) {
    rejectReasons.push({
      field: 'priceChange5mPct',
      detail: `${fmtPct(pc5m)} outside ${params.minPc5m}–${params.maxPc5m}% range`,
    });
  }

  if (snap.freezeAuthority === 'UNSAFE') {
    rejectReasons.push({ field: 'freezeAuthority', detail: 'UNSAFE' });
  }

  if (snap.mintAuthority === 'UNSAFE') {
    rejectReasons.push({ field: 'mintAuthority', detail: 'UNSAFE' });
  }

  if (snap.sellQuoteAvailable === 'NO') {
    rejectReasons.push({
      field: 'sellQuoteAvailable',
      detail: 'NO (sell quote explicitly unavailable)',
    });
  }

  // Slippage: if available and exceeds threshold, hard reject
  if (snap.estimatedSlippageBps !== null && snap.estimatedSlippageBps > params.maxSlippageBps) {
    rejectReasons.push({
      field: 'estimatedSlippageBps',
      detail: `${snap.estimatedSlippageBps}bps > ${params.maxSlippageBps}bps max`,
    });
  }

  if (rejectReasons.length > 0) {
    return { label: 'REJECT', rejectReasons, watchMoreReasons: [], tradabilityUnknown: false };
  }

  // Survival window: available data that is negative → reject
  if (return15m !== null && return15m < 0) {
    return {
      label: 'REJECT',
      rejectReasons: [{ field: 'return15m', detail: `${fmtPct(return15m)} (negative at 15m)` }],
      watchMoreReasons: [],
      tradabilityUnknown: false,
    };
  }
  if (return30m !== null && return30m < 0) {
    return {
      label: 'REJECT',
      rejectReasons: [{ field: 'return30m', detail: `${fmtPct(return30m)} (negative at 30m)` }],
      watchMoreReasons: [],
      tradabilityUnknown: false,
    };
  }

  // WATCH_MORE: passes core but uncertain
  const watchMoreReasons: string[] = [];
  const tradabilityUnknown = snap.sellQuoteAvailable === 'UNKNOWN';
  if (tradabilityUnknown) watchMoreReasons.push('TRADABILITY_UNKNOWN (sellQuoteAvailable=UNKNOWN)');
  if (return15m === null) watchMoreReasons.push('15m return data missing');
  if (return30m === null) watchMoreReasons.push('30m return data missing');

  if (watchMoreReasons.length > 0) {
    return { label: 'WATCH_MORE', rejectReasons: [], watchMoreReasons, tradabilityUnknown };
  }

  return { label: 'SHADOW_MATCH', rejectReasons: [], watchMoreReasons: [], tradabilityUnknown: false };
}

export function buildShadowCandidateReport(
  db: AppDb,
  _config: AppConfig,
  options: {
    hours?: number;
    limit?: number;
    top?: number;
    minLiquidity?: number;
    maxMoved?: number;
    minBsr?: number;
    minPc5m?: number;
    maxPc5m?: number;
    maxSlippageBps?: number;
  } = {}
): ShadowCandidateReport {
  const hours = options.hours ?? DEFAULT_HOURS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const top = options.top ?? DEFAULT_TOP;
  const params: ShadowParams = {
    minLiquidity: options.minLiquidity ?? DEFAULT_MIN_LIQUIDITY,
    maxMoved: options.maxMoved ?? DEFAULT_MAX_MOVED,
    minBsr: options.minBsr ?? DEFAULT_MIN_BSR,
    minPc5m: options.minPc5m ?? DEFAULT_MIN_PC5M,
    maxPc5m: options.maxPc5m ?? DEFAULT_MAX_PC5M,
    maxSlippageBps: options.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS,
  };
  const sql = db.sqlite;

  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();

  // Recent watch_only_candidates with latest snapshot and 15m / 30m outcome data
  const candidateRows = sql.prepare(`
    SELECT
      wc.id             AS watch_id,
      wc.created_at,
      wc.status         AS watch_status,
      wc.best_gain_pct,
      wc.worst_drawdown_pct,
      t.id              AS token_id,
      t.symbol,
      t.source,
      snap.raw_json     AS snapshot_raw,
      o15.return_pct    AS return_15m,
      o30.return_pct    AS return_30m
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots
      WHERE token_id = wc.token_id
      ORDER BY id DESC
      LIMIT 1
    )
    LEFT JOIN watch_only_outcomes o15 ON o15.id = (
      SELECT id FROM watch_only_outcomes
      WHERE watch_candidate_id = wc.id AND target_minutes = 15
      ORDER BY observed_at DESC
      LIMIT 1
    )
    LEFT JOIN watch_only_outcomes o30 ON o30.id = (
      SELECT id FROM watch_only_outcomes
      WHERE watch_candidate_id = wc.id AND target_minutes = 30
      ORDER BY observed_at DESC
      LIMIT 1
    )
    WHERE wc.created_at >= ?
    ORDER BY wc.created_at DESC
    LIMIT ?
  `).all(cutoff, limit) as Array<{
    watch_id: number;
    created_at: string;
    watch_status: string;
    best_gain_pct: number | null;
    worst_drawdown_pct: number | null;
    token_id: number;
    symbol: string;
    source: string;
    snapshot_raw: string | null;
    return_15m: number | null;
    return_30m: number | null;
  }>;

  const shadowMatches: ShadowRow[] = [];
  const watchMore: ShadowRow[] = [];
  const rejected: ShadowRow[] = [];

  for (const row of candidateRows) {
    const snap: TokenCandidate | null = row.snapshot_raw
      ? (JSON.parse(row.snapshot_raw) as TokenCandidate)
      : null;

    if (!snap) {
      rejected.push({
        watchId: row.watch_id,
        tokenId: row.token_id,
        symbol: row.symbol ?? 'UNKNOWN',
        source: row.source ?? 'unknown',
        createdAt: row.created_at,
        watchStatus: row.watch_status ?? 'unknown',
        label: 'REJECT',
        tradabilityUnknown: false,
        liquidityUsd: null,
        priceUsd: null,
        buySellRatio: 0,
        priceChange5mPct: null,
        volume5mUsd: null,
        movedBeforeDiscoveryPct: null,
        estimatedSlippageBps: null,
        freezeAuthority: 'UNKNOWN',
        mintAuthority: 'UNKNOWN',
        sellQuoteAvailable: 'UNKNOWN',
        return15m: null,
        return30m: null,
        bestGainPct: row.best_gain_pct ?? null,
        worstDrawdownPct: row.worst_drawdown_pct ?? null,
        rejectReasons: [{ field: 'snapshot', detail: 'no snapshot stored' }],
        watchMoreReasons: [],
      });
      continue;
    }

    const { label, rejectReasons, watchMoreReasons, tradabilityUnknown } = evaluateCandidate(
      snap,
      row.return_15m,
      row.return_30m,
      params
    );

    const r: ShadowRow = {
      watchId: row.watch_id,
      tokenId: row.token_id,
      symbol: row.symbol ?? 'UNKNOWN',
      source: row.source ?? 'unknown',
      createdAt: row.created_at,
      watchStatus: row.watch_status ?? 'unknown',
      label,
      tradabilityUnknown,
      liquidityUsd: snap.liquidityUsd ?? null,
      priceUsd: snap.priceUsd ?? null,
      buySellRatio: bsr(snap),
      priceChange5mPct: snap.priceChange5mPct ?? null,
      volume5mUsd: snap.volume5mUsd ?? null,
      movedBeforeDiscoveryPct: snap.movedBeforeDiscoveryPct ?? null,
      estimatedSlippageBps: snap.estimatedSlippageBps ?? null,
      freezeAuthority: snap.freezeAuthority,
      mintAuthority: snap.mintAuthority,
      sellQuoteAvailable: snap.sellQuoteAvailable,
      return15m: row.return_15m,
      return30m: row.return_30m,
      bestGainPct: row.best_gain_pct ?? null,
      worstDrawdownPct: row.worst_drawdown_pct ?? null,
      rejectReasons,
      watchMoreReasons,
    };

    if (label === 'SHADOW_MATCH') shadowMatches.push(r);
    else if (label === 'WATCH_MORE') watchMore.push(r);
    else rejected.push(r);
  }

  // Historical winner comparison: use earliest token_snapshot for entry metrics
  const winnerRows = sql.prepare(`
    SELECT
      t.id              AS token_id,
      t.symbol,
      wc.best_gain_pct,
      entry.raw_json    AS entry_raw
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    LEFT JOIN token_snapshots entry ON entry.id = (
      SELECT id FROM token_snapshots
      WHERE token_id = wc.token_id
      ORDER BY id ASC
      LIMIT 1
    )
    WHERE wc.best_gain_pct >= ?
    ORDER BY wc.best_gain_pct DESC
    LIMIT ?
  `).all(WINNER_MIN_GAIN_PCT, top) as Array<{
    token_id: number;
    symbol: string;
    best_gain_pct: number;
    entry_raw: string | null;
  }>;

  const historicalWinners: HistoricalWinnerRow[] = winnerRows.map((row) => {
    const snap: TokenCandidate | null = row.entry_raw
      ? (JSON.parse(row.entry_raw) as TokenCandidate)
      : null;
    return {
      tokenId: row.token_id,
      symbol: row.symbol ?? 'UNKNOWN',
      bestGainPct: row.best_gain_pct,
      entryLiquidityUsd: snap?.liquidityUsd ?? null,
      entryBuySellRatio: snap ? bsr(snap) : null,
      entryPc5mPct: snap?.priceChange5mPct ?? null,
      entryMovedPct: snap?.movedBeforeDiscoveryPct ?? null,
      entrySlippageBps: snap?.estimatedSlippageBps ?? null,
    };
  });

  return {
    hoursWindow: hours,
    limit,
    top,
    cutoff,
    params,
    totalScanned: candidateRows.length,
    shadowMatches,
    watchMore,
    rejected,
    historicalWinners,
    noTradingBehaviorChanged: true,
  };
}

export function renderShadowCandidateReport(report: ShadowCandidateReport): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);
  const { params } = report;

  // ── Section 1: Header ──────────────────────────────────────
  lines.push('Shadow Candidate Report');
  lines.push(sep);
  lines.push(
    `Timeframe: last ${report.hoursWindow}h  |  Cutoff: ${new Date(report.cutoff).toISOString()}`
  );
  lines.push(
    `Parameters: liq>=${fmtMoney(params.minLiquidity)}  moved<${params.maxMoved}%` +
      `  bsr>=${params.minBsr}  pc5m=${params.minPc5m}–${params.maxPc5m}%  slippage<=${params.maxSlippageBps}bps`
  );
  lines.push(
    `Scanned: ${report.totalScanned}  |  ` +
      `SHADOW_MATCH: ${report.shadowMatches.length}  |  ` +
      `WATCH_MORE: ${report.watchMore.length}  |  ` +
      `REJECT: ${report.rejected.length}`
  );
  lines.push('');

  // ── Section 2: Current Shadow Matches ─────────────────────
  lines.push(`Current Shadow Matches (${report.shadowMatches.length})`);
  lines.push(sep);
  if (report.shadowMatches.length === 0) {
    lines.push('  (none in this window)');
  } else {
    for (let i = 0; i < report.shadowMatches.length; i++) {
      const c = report.shadowMatches[i];
      lines.push(
        `  #${i + 1}  [wid:${c.watchId}] ${c.symbol.padEnd(12)}` +
          `  created=${fmtAge(minutesSince(c.createdAt))} ago  src=${c.source}`
      );
      lines.push(
        `       liq=${fmtMoney(c.liquidityUsd)}` +
          `  bsr=${c.buySellRatio.toFixed(2)}` +
          `  pc5m=${fmtPct(c.priceChange5mPct)}` +
          `  moved=${c.movedBeforeDiscoveryPct != null ? `${c.movedBeforeDiscoveryPct.toFixed(1)}%` : '-'}` +
          `  slippage=${c.estimatedSlippageBps != null ? `${c.estimatedSlippageBps}bps` : '-'}`
      );
      lines.push(
        `       15m=${fmtPct(c.return15m)}  30m=${fmtPct(c.return30m)}` +
          `  sellQuote=${c.sellQuoteAvailable}` +
          `  watch=${c.watchStatus}` +
          (c.bestGainPct != null ? `  bestGain=${fmtPct(c.bestGainPct)}` : '')
      );
    }
  }
  lines.push('');

  // ── Section 3: Watch More ──────────────────────────────────
  lines.push(`Watch More (${report.watchMore.length})`);
  lines.push(sep);
  if (report.watchMore.length === 0) {
    lines.push('  (none in this window)');
  } else {
    for (let i = 0; i < report.watchMore.length; i++) {
      const c = report.watchMore[i];
      lines.push(
        `  #${i + 1}  [wid:${c.watchId}] ${c.symbol.padEnd(12)}` +
          `  created=${fmtAge(minutesSince(c.createdAt))} ago  src=${c.source}`
      );
      lines.push(
        `       liq=${fmtMoney(c.liquidityUsd)}` +
          `  bsr=${c.buySellRatio.toFixed(2)}` +
          `  pc5m=${fmtPct(c.priceChange5mPct)}` +
          `  moved=${c.movedBeforeDiscoveryPct != null ? `${c.movedBeforeDiscoveryPct.toFixed(1)}%` : '-'}` +
          `  slippage=${c.estimatedSlippageBps != null ? `${c.estimatedSlippageBps}bps` : '-'}`
      );
      lines.push(
        `       15m=${fmtPct(c.return15m)}  30m=${fmtPct(c.return30m)}` +
          `  sellQuote=${c.sellQuoteAvailable}`
      );
      lines.push(`       → ${c.watchMoreReasons.join(' / ')}`);
    }
  }
  lines.push('');

  // ── Section 4: Rejection Reasons ──────────────────────────
  lines.push(`Rejection Reasons (${report.rejected.length} rejected)`);
  lines.push(sep);

  // Aggregate by field name
  const fieldCounts = new Map<string, number>();
  for (const c of report.rejected) {
    const primary = c.rejectReasons[0]?.field ?? 'unknown';
    fieldCounts.set(primary, (fieldCounts.get(primary) ?? 0) + 1);
  }
  const sorted = [...fieldCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    lines.push('  (no rejections)');
  } else {
    lines.push('  Top primary rejection fields:');
    for (const [field, count] of sorted) {
      lines.push(`    [${String(count).padStart(3)}]  ${field}`);
    }
    lines.push('');
    lines.push(`  Recent rejections (up to ${report.top}):`);
    for (const c of report.rejected.slice(0, report.top)) {
      lines.push(
        `  [wid:${c.watchId}] ${c.symbol.padEnd(12)}` +
          `  liq=${fmtMoney(c.liquidityUsd)}  bsr=${c.buySellRatio.toFixed(2)}` +
          `  pc5m=${fmtPct(c.priceChange5mPct)}` +
          `  moved=${c.movedBeforeDiscoveryPct != null ? `${c.movedBeforeDiscoveryPct.toFixed(1)}%` : '-'}`
      );
      for (const r of c.rejectReasons) {
        lines.push(`         - ${r.field}: ${r.detail}`);
      }
    }
  }
  lines.push('');

  // ── Section 5: Comparison to Historical Winners ────────────
  lines.push(`Comparison to Historical Winners (top ${report.top} by gain >= ${WINNER_MIN_GAIN_PCT}%)`);
  lines.push(sep);
  if (report.historicalWinners.length === 0) {
    lines.push('  No historical winners found (best_gain_pct >= 100% not yet in DB).');
  } else {
    const hdr = `  ${'SYMBOL'.padEnd(12)}  ${'BEST GAIN'.padStart(9)}  ${'ENTRY LIQ'.padStart(10)}  ${'BSR'.padStart(5)}  ${'PC5M'.padStart(6)}  ${'MOVED'.padStart(6)}  ${'SLIP'.padStart(6)}`;
    lines.push(hdr);
    lines.push('  ' + '─'.repeat(58));
    for (const w of report.historicalWinners) {
      lines.push(
        `  ${w.symbol.padEnd(12)}` +
          `  ${fmtPct(w.bestGainPct).padStart(9)}` +
          `  ${fmtMoney(w.entryLiquidityUsd).padStart(10)}` +
          `  ${(w.entryBuySellRatio != null ? w.entryBuySellRatio.toFixed(2) : '-').padStart(5)}` +
          `  ${fmtPct(w.entryPc5mPct).padStart(6)}` +
          `  ${(w.entryMovedPct != null ? `${w.entryMovedPct.toFixed(1)}%` : '-').padStart(6)}` +
          `  ${(w.entrySlippageBps != null ? `${w.entrySlippageBps}bps` : '-').padStart(6)}`
      );
    }

    // Pattern fit summary
    const w = report.historicalWinners;
    const withLiq = w.filter((h) => h.entryLiquidityUsd != null);
    const withBsr = w.filter((h) => h.entryBuySellRatio != null);
    const withPc5m = w.filter((h) => h.entryPc5mPct != null);
    const withMoved = w.filter((h) => h.entryMovedPct != null);
    const liqHit = withLiq.filter((h) => (h.entryLiquidityUsd ?? 0) >= params.minLiquidity).length;
    const bsrHit = withBsr.filter((h) => (h.entryBuySellRatio ?? 0) >= params.minBsr).length;
    const pc5mHit = withPc5m.filter(
      (h) =>
        h.entryPc5mPct != null &&
        h.entryPc5mPct >= params.minPc5m &&
        h.entryPc5mPct <= params.maxPc5m
    ).length;
    const movedHit = withMoved.filter(
      (h) => h.entryMovedPct != null && h.entryMovedPct < params.maxMoved
    ).length;

    lines.push('');
    lines.push('  Pattern fit vs shadow criteria (of winners with data):');
    lines.push(
      `    liq >= ${fmtMoney(params.minLiquidity)}:   ${liqHit}/${withLiq.length}` +
        (withLiq.length > 0 ? ` (${((liqHit / withLiq.length) * 100).toFixed(0)}%)` : '')
    );
    lines.push(
      `    bsr >= ${params.minBsr}:           ${bsrHit}/${withBsr.length}` +
        (withBsr.length > 0 ? ` (${((bsrHit / withBsr.length) * 100).toFixed(0)}%)` : '')
    );
    lines.push(
      `    pc5m ${params.minPc5m}–${params.maxPc5m}%:        ${pc5mHit}/${withPc5m.length}` +
        (withPc5m.length > 0 ? ` (${((pc5mHit / withPc5m.length) * 100).toFixed(0)}%)` : '')
    );
    lines.push(
      `    moved < ${params.maxMoved}%:         ${movedHit}/${withMoved.length}` +
        (withMoved.length > 0 ? ` (${((movedHit / withMoved.length) * 100).toFixed(0)}%)` : '')
    );
  }
  lines.push('');

  // ── Section 6: Decision Note ───────────────────────────────
  lines.push('Decision Note');
  lines.push(sep);
  if (report.shadowMatches.length > 0) {
    lines.push(
      `  ${report.shadowMatches.length} token(s) labelled SHADOW_MATCH in the last ${report.hoursWindow}h.`
    );
    lines.push(`  Review in the watch-only lane. No action has been taken.`);
  } else {
    lines.push(`  No SHADOW_MATCH tokens in the last ${report.hoursWindow}h.`);
  }
  if (report.watchMore.length > 0) {
    lines.push(`  ${report.watchMore.length} token(s) labelled WATCH_MORE — missing outcome data or tradability unknown.`);
  }
  lines.push(`  These labels are for research only. No trades proposed. No positions opened.`);
  lines.push('');

  // ── Section 7: Safety Footer ───────────────────────────────
  lines.push('Safety');
  lines.push(sep);
  lines.push('  Report only. No DB writes. No network calls. No proposals created.');
  lines.push('  No trading behavior changed. No thresholds changed.');
  lines.push('  Real trading remains locked.');

  return lines.join('\n');
}
