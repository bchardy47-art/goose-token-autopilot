import type { AppDb } from '../db';
import type { AppConfig } from '../types';

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 200;
const DEFAULT_TOP = 20;

const WINDOWS = [15, 30, 60, 90] as const;
type Window = (typeof WINDOWS)[number];

// Accept a snapshot within [W - lo, W + hi] minutes post-discovery as coverage
const WINDOW_BOUNDS: Record<Window, [lo: number, hi: number]> = {
  15: [5, 20],
  30: [10, 25],
  60: [20, 45],
  90: [20, 30],
};

type WindowStatus = 'DONE' | 'DUE' | 'WAIT' | 'MISSED';

interface SnapPoint {
  minutesAfter: number;
  priceUsd: number | null;
}

interface WindowCoverage {
  window: Window;
  status: WindowStatus;
  returnPct: number | null;
}

interface CandidateCoverage {
  candidateId: number;
  tokenId: number;
  symbol: string;
  source: string;
  discoveredAt: string;
  discoveryAgeMinutes: number;
  hasPoolAddress: boolean;
  hasAnyPostDiscoverySnapshot: boolean;
  windows: WindowCoverage[];
  doneCount: number;
  dueCount: number;
  waitCount: number;
  missedCount: number;
  latestReturnPct: number | null;
  bestGainPct: number | null;
}

export interface RefreshCoverageSummary {
  windowHours: number;
  limit: number;
  top: number;
  totalWatchCandidates: number;
  candidatesInWindow: number;
  shown: number;
  sourceBreakdown: Array<{ source: string; count: number }>;
  totalExpectedWindows: number;
  doneWindows: number;
  dueWindows: number;
  waitWindows: number;
  missedWindows: number;
  coveragePct: number;
  windowStats: Array<{ window: Window; done: number; total: number; coveragePct: number }>;
  sourceStats: Array<{ source: string; candidates: number; done: number; missed: number; coveragePct: number }>;
  worstCandidates: CandidateCoverage[];
  bestCandidates: CandidateCoverage[];
  noPoolAddress: CandidateCoverage[];
  poolAddressButNoSnapshots: CandidateCoverage[];
  shouldRunLoop: boolean;
  suggestedWindowHours: number;
  suggestedLimit: number;
  noRecentCandidates: boolean;
  noTradingBehaviorChanged: true;
}

function minutesSince(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / 60_000;
}

function minutesBetween(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
}

function fmtAge(minutes: number): string {
  return minutes < 60 ? `${minutes.toFixed(0)}m` : `${(minutes / 60).toFixed(1)}h`;
}

function fmtPct(v: number | null): string {
  if (v == null) return 'N/A';
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

function classifyWindow(
  candidateAgeMinutes: number,
  snaps: SnapPoint[],
  w: Window,
  entryPriceUsd: number | null
): WindowCoverage {
  const [lo, hi] = WINDOW_BOUNDS[w];
  const wMin = w - lo;
  const wMax = w + hi;
  const hit = snaps.find((s) => s.minutesAfter >= wMin && s.minutesAfter <= wMax);
  if (hit) {
    const returnPct =
      entryPriceUsd != null && hit.priceUsd != null && entryPriceUsd > 0
        ? Number((((hit.priceUsd - entryPriceUsd) / entryPriceUsd) * 100).toFixed(2))
        : null;
    return { window: w, status: 'DONE', returnPct };
  }
  if (candidateAgeMinutes < wMin) return { window: w, status: 'WAIT', returnPct: null };
  if (candidateAgeMinutes <= wMax) return { window: w, status: 'DUE', returnPct: null };
  return { window: w, status: 'MISSED', returnPct: null };
}

function deriveReturnPct(entry: number | null, latest: number | null): number | null {
  if (entry == null || latest == null || entry <= 0) return null;
  return Number((((latest - entry) / entry) * 100).toFixed(2));
}

export function buildRefreshCoverageSummary(
  db: AppDb,
  _config: AppConfig,
  options: { windowHours?: number; limit?: number; top?: number } = {}
): RefreshCoverageSummary {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const top = options.top ?? DEFAULT_TOP;
  const sql = db.sqlite;

  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const totalWatchCandidates = (
    sql.prepare(`SELECT COUNT(*) as n FROM watch_only_candidates`).get() as { n: number }
  ).n;

  const candidatesInWindow = (
    sql.prepare(`SELECT COUNT(*) as n FROM watch_only_candidates WHERE created_at >= ?`).get(cutoff) as { n: number }
  ).n;

  const candidateRows = sql.prepare(`
    SELECT wc.id as candidate_id, wc.token_id, t.symbol, t.source,
           wc.created_at, wc.entry_price_usd, wc.best_gain_pct, wc.latest_price_usd
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    WHERE wc.created_at >= ?
    ORDER BY wc.created_at DESC
    LIMIT ?
  `).all(cutoff, limit) as Array<{
    candidate_id: number;
    token_id: number;
    symbol: string;
    source: string;
    created_at: string;
    entry_price_usd: number | null;
    best_gain_pct: number | null;
    latest_price_usd: number | null;
  }>;

  const sourceBreakdownRows = sql.prepare(`
    SELECT t.source, COUNT(*) as cnt
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    WHERE wc.created_at >= ?
    GROUP BY t.source
    ORDER BY cnt DESC
  `).all(cutoff) as Array<{ source: string; cnt: number }>;

  const sourceBreakdown = sourceBreakdownRows.map((r) => ({ source: r.source, count: r.cnt }));

  // Pool address presence — read from earliest snapshot's raw.selectedPair.pairAddress.
  // This matches the exact field watchRefresh uses to select candidates for refresh.
  // solana_safety_enrichments.lp_or_pool_address is NOT used here: SSE enrichment is a
  // separate pipeline that many recent GeckoTerminal candidates have never gone through.
  const snapPoolRows = sql.prepare(`
    SELECT wc.token_id, snap.raw_json
    FROM watch_only_candidates wc
    JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = wc.token_id ORDER BY observed_at ASC LIMIT 1
    )
    WHERE wc.created_at >= ?
  `).all(cutoff) as Array<{ token_id: number; raw_json: string }>;

  const poolAddressSet = new Set<number>();
  for (const r of snapPoolRows) {
    try {
      const parsed = JSON.parse(r.raw_json) as Record<string, unknown>;
      const inner = parsed?.raw as Record<string, unknown> | undefined;
      const selectedPair = inner?.selectedPair as Record<string, unknown> | undefined;
      const pairAddress = selectedPair?.pairAddress;
      if (typeof pairAddress === 'string' && pairAddress.length > 0) {
        poolAddressSet.add(r.token_id);
      }
    } catch {
      // skip malformed raw_json
    }
  }

  // post-discovery snapshots
  const snapRows = sql.prepare(`
    SELECT snap.token_id, snap.observed_at, snap.price_usd, wc.created_at as candidate_created_at
    FROM token_snapshots snap
    JOIN watch_only_candidates wc ON wc.token_id = snap.token_id
    WHERE snap.observed_at > wc.created_at
      AND wc.created_at >= ?
    ORDER BY snap.token_id, snap.observed_at
  `).all(cutoff) as Array<{
    token_id: number;
    observed_at: string;
    price_usd: number | null;
    candidate_created_at: string;
  }>;

  const snapsByToken = new Map<number, SnapPoint[]>();
  for (const r of snapRows) {
    const minutesAfter = minutesBetween(r.candidate_created_at, r.observed_at);
    if (!snapsByToken.has(r.token_id)) snapsByToken.set(r.token_id, []);
    snapsByToken.get(r.token_id)!.push({ minutesAfter, priceUsd: r.price_usd });
  }

  const candidates: CandidateCoverage[] = candidateRows.map((r) => {
    const ageMinutes = minutesSince(r.created_at);
    const snaps = snapsByToken.get(r.token_id) ?? [];
    const windows = WINDOWS.map((w) => classifyWindow(ageMinutes, snaps, w, r.entry_price_usd));
    return {
      candidateId: r.candidate_id,
      tokenId: r.token_id,
      symbol: r.symbol,
      source: r.source,
      discoveredAt: r.created_at,
      discoveryAgeMinutes: ageMinutes,
      hasPoolAddress: poolAddressSet.has(r.token_id),
      hasAnyPostDiscoverySnapshot: snaps.length > 0,
      windows,
      doneCount: windows.filter((w) => w.status === 'DONE').length,
      dueCount: windows.filter((w) => w.status === 'DUE').length,
      waitCount: windows.filter((w) => w.status === 'WAIT').length,
      missedCount: windows.filter((w) => w.status === 'MISSED').length,
      latestReturnPct: deriveReturnPct(r.entry_price_usd, r.latest_price_usd),
      bestGainPct: r.best_gain_pct,
    };
  });

  const allWindowSlots = candidates.flatMap((c) => c.windows);
  const doneWindows = allWindowSlots.filter((w) => w.status === 'DONE').length;
  const dueWindows = allWindowSlots.filter((w) => w.status === 'DUE').length;
  const waitWindows = allWindowSlots.filter((w) => w.status === 'WAIT').length;
  const missedWindows = allWindowSlots.filter((w) => w.status === 'MISSED').length;
  const totalExpectedWindows = allWindowSlots.length;
  const coveragePct =
    totalExpectedWindows > 0 ? Number(((doneWindows / totalExpectedWindows) * 100).toFixed(1)) : 0;

  const windowStats = WINDOWS.map((w) => {
    const slots = candidates.map((c) => c.windows.find((x) => x.window === w)!);
    const done = slots.filter((s) => s.status === 'DONE').length;
    const total = slots.length;
    return {
      window: w,
      done,
      total,
      coveragePct: total > 0 ? Number(((done / total) * 100).toFixed(1)) : 0,
    };
  });

  const sources = [...new Set(candidates.map((c) => c.source))];
  const sourceStats = sources
    .map((source) => {
      const sc = candidates.filter((c) => c.source === source);
      const done = sc.reduce((sum, c) => sum + c.doneCount, 0);
      const missed = sc.reduce((sum, c) => sum + c.missedCount, 0);
      const total = sc.length * WINDOWS.length;
      return {
        source,
        candidates: sc.length,
        done,
        missed,
        coveragePct: total > 0 ? Number(((done / total) * 100).toFixed(1)) : 0,
      };
    })
    .sort((a, b) => b.candidates - a.candidates);

  const worstCandidates = candidates
    .filter((c) => c.missedCount > 0)
    .sort((a, b) => b.missedCount - a.missedCount || a.doneCount - b.doneCount)
    .slice(0, top);

  const bestCandidates = candidates
    .filter((c) => c.doneCount > 0)
    .sort((a, b) => b.doneCount - a.doneCount || a.missedCount - b.missedCount)
    .slice(0, top);

  const noPoolAddress = candidates.filter((c) => !c.hasPoolAddress).slice(0, top);
  const poolAddressButNoSnapshots = candidates
    .filter((c) => c.hasPoolAddress && !c.hasAnyPostDiscoverySnapshot)
    .slice(0, top);

  const noRecentCandidates = candidateRows.length === 0;
  const shouldRunLoop = dueWindows > 0;
  const suggestedWindowHours = windowHours;
  const suggestedLimit = Math.max(candidateRows.length, 20);

  return {
    windowHours,
    limit,
    top,
    totalWatchCandidates,
    candidatesInWindow,
    shown: candidateRows.length,
    sourceBreakdown,
    totalExpectedWindows,
    doneWindows,
    dueWindows,
    waitWindows,
    missedWindows,
    coveragePct,
    windowStats,
    sourceStats,
    worstCandidates,
    bestCandidates,
    noPoolAddress,
    poolAddressButNoSnapshots,
    shouldRunLoop,
    suggestedWindowHours,
    suggestedLimit,
    noRecentCandidates,
    noTradingBehaviorChanged: true,
  };
}

export function renderRefreshCoverageSummary(summary: RefreshCoverageSummary): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  // 1. Refresh Coverage Summary
  lines.push('Refresh Coverage Summary');
  lines.push(sep);
  lines.push(`Window: last ${summary.windowHours}h | Limit: ${summary.limit} | Top: ${summary.top}`);
  lines.push(`Total watch candidates (all time): ${summary.totalWatchCandidates}`);
  lines.push(`In window (${summary.windowHours}h):            ${summary.candidatesInWindow}`);
  lines.push(`Shown:                             ${summary.shown}`);
  lines.push('');
  lines.push('Source Breakdown (in window):');
  if (summary.sourceBreakdown.length === 0) {
    lines.push('  (no candidates in window)');
  } else {
    for (const s of summary.sourceBreakdown) {
      lines.push(`  ${s.source.padEnd(16)} ${s.count}`);
    }
  }
  lines.push('');
  lines.push(
    `Total expected windows:  ${summary.totalExpectedWindows}  (${summary.shown} candidates × 4 windows: 15m/30m/60m/90m)`
  );
  lines.push(`  DONE   : ${summary.doneWindows}`);
  lines.push(`  DUE    : ${summary.dueWindows}  ← needs refresh now`);
  lines.push(`  WAIT   : ${summary.waitWindows}  ← not old enough yet`);
  lines.push(`  MISSED : ${summary.missedWindows}  ← window passed without snapshot`);
  lines.push(`  Coverage: ${summary.coveragePct}%  (DONE / total expected)`);
  lines.push('');

  // 2. Coverage by Window
  lines.push('Coverage by Window');
  lines.push(sep);
  if (summary.shown === 0) {
    lines.push('  (no candidates in window)');
  } else {
    for (const ws of summary.windowStats) {
      lines.push(`  ${ws.window}m window: DONE=${ws.done}/${ws.total}  (${ws.coveragePct}%)`);
    }
  }
  lines.push('');

  // 3. Coverage by Source
  lines.push('Coverage by Source');
  lines.push(sep);
  if (summary.sourceStats.length === 0) {
    lines.push('  (no candidates in window)');
  } else {
    for (const s of summary.sourceStats) {
      lines.push(
        `  ${s.source.padEnd(16)} candidates=${s.candidates}  done=${s.done}  missed=${s.missed}  coverage=${s.coveragePct}%`
      );
    }
  }
  lines.push('');

  // 4. Worst Coverage Candidates
  lines.push('Worst Coverage Candidates');
  lines.push(sep);
  if (summary.worstCandidates.length === 0) {
    lines.push('  (no candidates with missed windows)');
  } else {
    for (const c of summary.worstCandidates) {
      const missedList = c.windows
        .filter((w) => w.status === 'MISSED')
        .map((w) => `${w.window}m`)
        .join(',');
      const poolStr = c.hasPoolAddress ? 'pool=yes' : 'pool=NO ';
      const retStr = fmtPct(c.latestReturnPct);
      const gainStr = fmtPct(c.bestGainPct);
      lines.push(
        `  ${c.symbol.padEnd(14)} src=${c.source.padEnd(13)} age=${fmtAge(c.discoveryAgeMinutes).padEnd(6)} ${poolStr}  missed=[${missedList}]  ret=${retStr}  best=${gainStr}`
      );
    }
  }
  lines.push('');

  // 5. Best Covered Candidates
  lines.push('Best Covered Candidates');
  lines.push(sep);
  if (summary.bestCandidates.length === 0) {
    lines.push('  (no candidates with completed windows)');
  } else {
    for (const c of summary.bestCandidates) {
      const retsByWindow = WINDOWS.map((w) => {
        const wc = c.windows.find((x) => x.window === w);
        if (!wc) return `${w}m=?`;
        if (wc.status === 'DONE') return `${w}m=${wc.returnPct != null ? fmtPct(wc.returnPct) : 'DONE'}`;
        return `${w}m=${wc.status}`;
      }).join('  ');
      lines.push(`  ${c.symbol.padEnd(14)} src=${c.source.padEnd(13)} ${retsByWindow}`);
    }
  }
  lines.push('');

  // 6. No-Data / Refresh Failure Clues
  lines.push('No-Data / Refresh Failure Clues');
  lines.push(sep);
  lines.push('  NOTE: Refresh failure history is not persisted in the DB.');
  lines.push('  Failure clues are inferred from snapshot absence only.');
  lines.push('');
  lines.push(`  Candidates with no pool address: ${summary.noPoolAddress.length}`);
  if (summary.noPoolAddress.length === 0) {
    lines.push('    (none)');
  } else {
    const shown = summary.noPoolAddress.slice(0, 10);
    for (const c of shown) {
      lines.push(`    ${c.symbol.padEnd(14)} src=${c.source}  age=${fmtAge(c.discoveryAgeMinutes)}`);
    }
    if (summary.noPoolAddress.length > 10) {
      lines.push(`    ... and ${summary.noPoolAddress.length - 10} more`);
    }
  }
  lines.push('');
  lines.push(`  Pool address present but no post-discovery snapshots: ${summary.poolAddressButNoSnapshots.length}`);
  if (summary.poolAddressButNoSnapshots.length === 0) {
    lines.push('    (none)');
  } else {
    const shown = summary.poolAddressButNoSnapshots.slice(0, 10);
    for (const c of shown) {
      lines.push(`    ${c.symbol.padEnd(14)} src=${c.source}  age=${fmtAge(c.discoveryAgeMinutes)}`);
    }
    if (summary.poolAddressButNoSnapshots.length > 10) {
      lines.push(`    ... and ${summary.poolAddressButNoSnapshots.length - 10} more`);
    }
  }
  lines.push('');

  // 7. Operational Recommendation
  lines.push('Operational Recommendation');
  lines.push(sep);
  if (summary.noRecentCandidates) {
    lines.push(`  WARNING: No candidates found in the last ${summary.windowHours}h window.`);
    lines.push('  Consider running token:watch-cycle to discover new candidates,');
    lines.push(`  or widen --window-hours (currently ${summary.windowHours}h).`);
  } else if (summary.shouldRunLoop) {
    lines.push(`  ${summary.dueWindows} window(s) due now — run token:early-refresh-loop to capture them.`);
    lines.push(
      `  Suggested: npm run token:early-refresh-loop -- --window-hours=${summary.suggestedWindowHours} --limit=${summary.suggestedLimit} --cycles=1`
    );
  } else if (summary.waitWindows > 0 && summary.dueWindows === 0) {
    lines.push('  No windows due yet — candidates are still within tolerance or waiting.');
    lines.push('  Re-run this report after the next refresh window opens.');
  } else if (summary.missedWindows > 0 && summary.doneWindows === 0) {
    lines.push('  All actionable windows are missed. early-refresh-loop was likely not running.');
    lines.push('  Consider increasing loop frequency for new candidates going forward.');
  } else {
    lines.push('  Coverage looks healthy. No immediate action needed.');
    lines.push(
      `  Coverage: ${summary.coveragePct}% | DONE=${summary.doneWindows} MISSED=${summary.missedWindows}`
    );
  }
  lines.push('');

  // 8. Safety Footer
  lines.push('Safety');
  lines.push(sep);
  lines.push('  Report only. No DB writes. No live network calls. Stored data only.');
  lines.push('  No trading behavior changed.');
  lines.push('  No proposals created. No positions opened.');
  lines.push('  Real trading remains locked.');

  return lines.join('\n');
}
