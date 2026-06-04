import type { AppDb } from '../db';
import type { AppConfig } from '../types';

const DEFAULT_LIMIT = 25;
const DEFAULT_WINDOW_HOURS = 72;
const DEFAULT_MIN_BSR = 1.5;
const DEFAULT_MAX_MOVED = 100;
const DEFAULT_MIN_PC5M = 40;

export type FilterLabel = 'PROFILE_MATCH' | 'NO_MATCH' | 'DUMP_RISK';

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

function fmtNum(v: number | null | undefined, digits = 2): string {
  return v == null ? '-' : v.toFixed(digits);
}

function bsr(buys: number | null, sells: number | null): number | null {
  if (buys == null || sells == null || sells <= 0) return null;
  return buys / sells;
}

interface FilterCriteria {
  minBsr: number;
  maxMovedPct: number;
  minPc5mPct: number;
}

interface CandidateRow {
  candidateId: number;
  tokenId: number;
  symbol: string;
  createdAt: string;
  ageMinutes: number;
  entryPriceUsd: number | null;
  latestPriceUsd: number | null;
  bestGainPct: number | null;
  worstDrawdownPct: number | null;
  liquidityUsd: number | null;
  vol5mUsd: number | null;
  signalClass: string | null;
  movedBeforePct: number | null;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  sellQuoteAvailable: string | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  buys5m: number | null;
  sells5m: number | null;
  bsr: number | null;
  currentReturnPct: number | null;
}

export interface FilteredCandidate {
  row: CandidateRow;
  label: FilterLabel;
  matchReasons: string[];
  failReasons: string[];
  dumpReasons: string[];
}

export interface EarlySignalFilterReport {
  criteria: FilterCriteria;
  windowHours: number;
  limit: number;
  totalChecked: number;
  profileMatchCount: number;
  noMatchCount: number;
  dumpRiskCount: number;
  candidates: FilteredCandidate[];
  topFailReasons: Array<{ reason: string; count: number }>;
  topDumpReasons: Array<{ reason: string; count: number }>;
}

function classifyCandidate(row: CandidateRow, criteria: FilterCriteria): FilteredCandidate {
  const dumpReasons: string[] = [];
  const matchReasons: string[] = [];
  const failReasons: string[] = [];

  // --- DUMP_RISK signals ---
  if (row.freezeAuthority === 'UNSAFE') dumpReasons.push('freeze_authority UNSAFE');
  if (row.mintAuthority === 'UNSAFE') dumpReasons.push('mint_authority UNSAFE');

  // Already collapsed: latest price < 30% of entry
  if (row.entryPriceUsd != null && row.latestPriceUsd != null && row.entryPriceUsd > 0) {
    const ratio = row.latestPriceUsd / row.entryPriceUsd;
    if (ratio < 0.3) dumpReasons.push(`price collapsed to ${(ratio * 100).toFixed(0)}% of entry`);
  }

  // Weak BSR despite 5m spike — looks like a rug pump
  if ((row.priceChange5mPct ?? 0) > 50 && (row.bsr ?? 2) < 1.0) {
    dumpReasons.push('5m price spike with BSR < 1.0 (sell pressure dominant)');
  }

  // Extreme 5m spike but already worst drawdown > -60% (pumped then dumped)
  if ((row.priceChange5mPct ?? 0) > 80 && (row.worstDrawdownPct ?? 0) < -50) {
    dumpReasons.push('extreme 5m spike but worst_drawdown > -50% (pump-dump pattern)');
  }

  if (dumpReasons.length > 0) {
    return { row, label: 'DUMP_RISK', matchReasons, failReasons, dumpReasons };
  }

  // --- PROFILE_MATCH criteria ---
  const movedOk = (row.movedBeforePct ?? 999) < criteria.maxMovedPct;
  const bsrOk = row.bsr != null && row.bsr >= criteria.minBsr;
  const pc5mOk = (row.priceChange5mPct ?? -999) >= criteria.minPc5mPct;
  const freezeOk = row.freezeAuthority !== 'UNSAFE';

  if (movedOk) {
    matchReasons.push(`moved_before=${fmtPct(row.movedBeforePct, 0)} < ${criteria.maxMovedPct}%`);
  } else {
    failReasons.push(`moved_before=${fmtPct(row.movedBeforePct, 0)} >= ${criteria.maxMovedPct}% (already pumped)`);
  }

  if (bsrOk) {
    matchReasons.push(`BSR=${fmtNum(row.bsr)} >= ${criteria.minBsr}`);
  } else if (row.bsr == null) {
    failReasons.push('BSR unavailable (no buys/sells data)');
  } else {
    failReasons.push(`BSR=${fmtNum(row.bsr)} < ${criteria.minBsr} (weak buy pressure)`);
  }

  if (pc5mOk) {
    matchReasons.push(`pc5m=${fmtPct(row.priceChange5mPct, 0)} >= ${criteria.minPc5mPct}%`);
  } else {
    failReasons.push(`pc5m=${fmtPct(row.priceChange5mPct, 0)} < ${criteria.minPc5mPct}% (not actively pumping)`);
  }

  if (freezeOk) {
    matchReasons.push(`freeze=${row.freezeAuthority ?? 'UNKNOWN'}`);
  }

  if (movedOk && bsrOk && pc5mOk && freezeOk) {
    return { row, label: 'PROFILE_MATCH', matchReasons, failReasons: [], dumpReasons };
  }

  return { row, label: 'NO_MATCH', matchReasons: [], failReasons, dumpReasons };
}

export function buildEarlySignalFilterReport(
  db: AppDb,
  _config: AppConfig,
  options: { limit?: number; windowHours?: number; minBsr?: number; maxMoved?: number; minPc5m?: number } = {}
): EarlySignalFilterReport {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const windowMinutes = windowHours * 60;
  const criteria: FilterCriteria = {
    minBsr: options.minBsr ?? DEFAULT_MIN_BSR,
    maxMovedPct: options.maxMoved ?? DEFAULT_MAX_MOVED,
    minPc5mPct: options.minPc5m ?? DEFAULT_MIN_PC5M
  };

  const s = db.sqlite;

  const rows = s.prepare(`
    SELECT
      wc.id as candidate_id,
      wc.token_id,
      t.symbol,
      wc.created_at,
      wc.entry_price_usd,
      wc.latest_price_usd,
      wc.best_gain_pct,
      wc.worst_drawdown_pct,
      wc.liquidity_usd,
      wc.volume_5m_usd,
      wsa.signal_class,
      wsa.moved_before_discovery_pct,
      wsa.freeze_authority,
      wsa.mint_authority,
      wsa.sell_quote_available,
      snap.price_change_5m_pct,
      snap.price_change_1h_pct,
      snap.buys_5m,
      snap.sells_5m
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    LEFT JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = wc.token_id ORDER BY id LIMIT 1
    )
    ORDER BY wc.created_at DESC
  `).all() as any[];

  // Filter by window
  const inWindow = rows.filter((r: any) => minutesSince(r.created_at) <= windowMinutes);

  const candidateRows: CandidateRow[] = inWindow.map((r: any) => {
    const b = bsr(r.buys_5m, r.sells_5m);
    const currentReturnPct =
      r.entry_price_usd != null && r.latest_price_usd != null && r.entry_price_usd > 0
        ? ((r.latest_price_usd - r.entry_price_usd) / r.entry_price_usd) * 100
        : null;
    return {
      candidateId: r.candidate_id,
      tokenId: r.token_id,
      symbol: r.symbol,
      createdAt: r.created_at,
      ageMinutes: minutesSince(r.created_at),
      entryPriceUsd: r.entry_price_usd,
      latestPriceUsd: r.latest_price_usd,
      bestGainPct: r.best_gain_pct,
      worstDrawdownPct: r.worst_drawdown_pct,
      liquidityUsd: r.liquidity_usd,
      vol5mUsd: r.volume_5m_usd,
      signalClass: r.signal_class,
      movedBeforePct: r.moved_before_discovery_pct,
      freezeAuthority: r.freeze_authority,
      mintAuthority: r.mint_authority,
      sellQuoteAvailable: r.sell_quote_available,
      priceChange5mPct: r.price_change_5m_pct,
      priceChange1hPct: r.price_change_1h_pct,
      buys5m: r.buys_5m,
      sells5m: r.sells_5m,
      bsr: b,
      currentReturnPct
    };
  });

  const classified = candidateRows.map((row) => classifyCandidate(row, criteria));

  const profileMatches = classified.filter((c) => c.label === 'PROFILE_MATCH');
  const noMatches = classified.filter((c) => c.label === 'NO_MATCH');
  const dumpRisks = classified.filter((c) => c.label === 'DUMP_RISK');

  // Top fail reasons
  const failReasonCounts = new Map<string, number>();
  for (const c of noMatches) {
    for (const r of c.failReasons) {
      // Bucket by prefix
      const key = r.split('=')[0].trim();
      failReasonCounts.set(key, (failReasonCounts.get(key) ?? 0) + 1);
    }
  }
  const topFailReasons = [...failReasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([reason, count]) => ({ reason, count }));

  // Top dump reasons
  const dumpReasonCounts = new Map<string, number>();
  for (const c of dumpRisks) {
    for (const r of c.dumpReasons) {
      const key = r.split('(')[0].trim();
      dumpReasonCounts.set(key, (dumpReasonCounts.get(key) ?? 0) + 1);
    }
  }
  const topDumpReasons = [...dumpReasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, count]) => ({ reason, count }));

  // Apply limit across all, prioritising matches first
  const ordered = [...profileMatches, ...dumpRisks, ...noMatches].slice(0, limit);

  return {
    criteria,
    windowHours,
    limit,
    totalChecked: candidateRows.length,
    profileMatchCount: profileMatches.length,
    noMatchCount: noMatches.length,
    dumpRiskCount: dumpRisks.length,
    candidates: ordered,
    topFailReasons,
    topDumpReasons
  };
}

export function renderEarlySignalFilterReport(db: AppDb, config: AppConfig, options: { limit?: number; windowHours?: number; minBsr?: number; maxMoved?: number; minPc5m?: number } = {}): string {
  const r = buildEarlySignalFilterReport(db, config, options);
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  lines.push('Early Signal Filter');
  lines.push(sep);

  // 1. Summary
  lines.push('1. Early Signal Filter');
  lines.push(`   Window: last ${r.windowHours}h | Limit: ${r.limit}`);
  lines.push(`   Criteria: moved_before < ${r.criteria.maxMovedPct}% | BSR >= ${r.criteria.minBsr} | pc5m >= ${r.criteria.minPc5mPct}% | freeze SAFE`);
  lines.push(`   Total candidates checked: ${r.totalChecked}`);
  lines.push(`   PROFILE_MATCH: ${r.profileMatchCount}`);
  lines.push(`   NO_MATCH:      ${r.noMatchCount}`);
  lines.push(`   DUMP_RISK:     ${r.dumpRiskCount}`);
  lines.push('');

  // 2. Profile matches
  const matches = r.candidates.filter((c) => c.label === 'PROFILE_MATCH');
  lines.push('2. Profile Matches');
  if (matches.length === 0) {
    lines.push('   None in this window.');
  } else {
    for (const c of matches) {
      const row = c.row;
      const age = row.ageMinutes < 60
        ? `${row.ageMinutes.toFixed(0)}m ago`
        : `${(row.ageMinutes / 60).toFixed(1)}h ago`;
      lines.push(`   [PROFILE_MATCH] ${row.symbol} (#${row.tokenId}) — ${age}`);
      lines.push(`     moved_before=${fmtPct(row.movedBeforePct, 0)} | BSR=${fmtNum(row.bsr)} | pc5m=${fmtPct(row.priceChange5mPct, 0)} | liq=${fmtMoney(row.liquidityUsd)}`);
      lines.push(`     freeze=${row.freezeAuthority ?? '-'} | mint=${row.mintAuthority ?? '-'} | class=${row.signalClass ?? '-'}`);
      lines.push(`     current=${fmtPct(row.currentReturnPct, 0)} | best=${fmtPct(row.bestGainPct, 0)} | worst=${fmtPct(row.worstDrawdownPct, 0)}`);
      lines.push(`     why: ${c.matchReasons.join(' | ')}`);
    }
  }
  lines.push('');

  // 3. No match summary
  lines.push('3. No Match Summary');
  if (r.topFailReasons.length === 0) {
    lines.push('   No failures recorded.');
  } else {
    lines.push(`   Top failure reasons (${r.noMatchCount} candidates):`);
    for (const fr of r.topFailReasons) {
      lines.push(`   - ${fr.reason}: ${fr.count}`);
    }
  }
  lines.push('');

  // 4. Dump risk summary
  const dumps = r.candidates.filter((c) => c.label === 'DUMP_RISK');
  lines.push('4. Dump Risk Summary');
  if (dumps.length === 0) {
    lines.push('   No dump-risk candidates flagged.');
  } else {
    lines.push(`   ${r.dumpRiskCount} candidates flagged:`);
    for (const c of dumps) {
      lines.push(`   [DUMP_RISK] ${c.row.symbol} (#${c.row.tokenId}) — ${c.dumpReasons.join('; ')}`);
      lines.push(`     current=${fmtPct(c.row.currentReturnPct, 0)} | worst=${fmtPct(c.row.worstDrawdownPct, 0)} | freeze=${c.row.freezeAuthority ?? '-'}`);
    }
    if (r.topDumpReasons.length > 0) {
      lines.push('   Top dump flags:');
      for (const dr of r.topDumpReasons) {
        lines.push(`   - ${dr.reason}: ${dr.count}`);
      }
    }
  }
  lines.push('');

  // 5. Safety footer
  lines.push('5. Safety');
  lines.push('   Report only.');
  lines.push('   No trading behavior changed.');
  lines.push('   Hypothesis not active.');
  lines.push('   Requires forward validation before paper or real trading.');

  return lines.join('\n');
}
