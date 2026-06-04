import type { AppDb } from '../db';
import type { AppConfig } from '../types';

const DEFAULT_MIN_GAIN = 100;
const DEFAULT_LIMIT = 50;
const DEFAULT_TOP = 20;

// Decay window bounds consistent with decayRate.ts and earlyRefreshPlan.ts
const WINDOW_BOUNDS: Record<15 | 30 | 60, [lo: number, hi: number]> = {
  15: [5, 20],
  30: [10, 25],
  60: [20, 45],
};

function avg(vs: number[]): number | null {
  return vs.length === 0 ? null : vs.reduce((a, b) => a + b, 0) / vs.length;
}

function median(vs: number[]): number | null {
  if (vs.length === 0) return null;
  const s = [...vs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2 : (s[m] ?? null);
}

function fmtPct(v: number | null | undefined, d = 1): string {
  if (v == null) return '-';
  return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '-';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function fmtNum(v: number | null | undefined, d = 2): string {
  return v == null ? '-' : v.toFixed(d);
}

function fmtAge(minutes: number | null | undefined): string {
  if (minutes == null) return '-';
  return minutes < 60 ? `${minutes.toFixed(0)}m` : `${(minutes / 60).toFixed(1)}h`;
}

interface WinnerRow {
  tokenId: number;
  symbol: string;
  name: string;
  source: string;
  mint: string;
  candidateCreatedAt: string;
  poolCreatedAt: string | null;
  discoveryAgeMinutes: number | null;
  entryPriceUsd: number | null;
  latestPriceUsd: number | null;
  currentReturnPct: number | null;
  bestGainPct: number;
  worstDrawdownPct: number | null;
  peakGapPct: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  volume24hUsd: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  buys5m: number | null;
  sells5m: number | null;
  bsr: number | null;
  movedBeforePct: number | null;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  sellQuoteAvailable: string | null;
  estimatedSlippageBps: number | null;
  holderConcentration: string | null;
  creatorStatus: string | null;
  websitePresent: boolean | null;
  socialsPresent: boolean | null;
  metadataPresent: boolean | null;
  signalClass: string | null;
  isPumpDump: boolean;
  isTradable: boolean | null;
  snap15mReturnPct: number | null;
  snap30mReturnPct: number | null;
  snap60mReturnPct: number | null;
}

interface GroupStats {
  label: string;
  count: number;
  avgMovedBefore: number | null;
  medMovedBefore: number | null;
  avgLiqUsd: number | null;
  medLiqUsd: number | null;
  avgVol5mUsd: number | null;
  medVol5mUsd: number | null;
  avgBsr: number | null;
  medBsr: number | null;
  avgPc5m: number | null;
  medPc5m: number | null;
  avgBestGain: number | null;
  medBestGain: number | null;
  avgWorstDraw: number | null;
  medWorstDraw: number | null;
  sellQuoteAvailablePct: number | null;
}

export interface HistoricalWinnerAutopsy {
  minGainPct: number;
  limit: number;
  totalCandidates: number;
  totalWithSignalAnalysis: number;
  winnersFound: number;
  dataWarnings: string[];
  winners: WinnerRow[];
  winnerStats: GroupStats;
  dumpStats: GroupStats;
  noiseStats: GroupStats;
  noMatchStats: GroupStats | null;
  decayCoverage: { winners: number; with15m: number; with30m: number; with60m: number };
  ruleHypotheses: string[];
  decisionNote: string[];
}

function buildGroupStats(label: string, rows: Array<{
  movedBefore: number | null;
  liq: number | null;
  vol5m: number | null;
  bsr: number | null;
  pc5m: number | null;
  bestGain: number | null;
  worstDraw: number | null;
  sellQuote: string | null;
}>): GroupStats {
  const pick = <T>(vs: Array<T | null>): T[] => vs.filter((v): v is T => v != null);
  return {
    label,
    count: rows.length,
    avgMovedBefore: avg(pick(rows.map((r) => r.movedBefore))),
    medMovedBefore: median(pick(rows.map((r) => r.movedBefore))),
    avgLiqUsd: avg(pick(rows.map((r) => r.liq))),
    medLiqUsd: median(pick(rows.map((r) => r.liq))),
    avgVol5mUsd: avg(pick(rows.map((r) => r.vol5m))),
    medVol5mUsd: median(pick(rows.map((r) => r.vol5m))),
    avgBsr: avg(pick(rows.map((r) => r.bsr))),
    medBsr: median(pick(rows.map((r) => r.bsr))),
    avgPc5m: avg(pick(rows.map((r) => r.pc5m))),
    medPc5m: median(pick(rows.map((r) => r.pc5m))),
    avgBestGain: avg(pick(rows.map((r) => r.bestGain))),
    medBestGain: median(pick(rows.map((r) => r.bestGain))),
    avgWorstDraw: avg(pick(rows.map((r) => r.worstDraw))),
    medWorstDraw: median(pick(rows.map((r) => r.worstDraw))),
    sellQuoteAvailablePct: rows.length > 0
      ? (rows.filter((r) => r.sellQuote === 'AVAILABLE').length / rows.length) * 100
      : null,
  };
}

export function buildHistoricalWinnerAutopsy(
  db: AppDb,
  _config: AppConfig,
  options: { minGain?: number; limit?: number; top?: number } = {}
): HistoricalWinnerAutopsy {
  const minGain = options.minGain ?? DEFAULT_MIN_GAIN;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const sql = db.sqlite;

  const totalRow = sql.prepare('SELECT COUNT(*) as c FROM watch_only_candidates').get() as { c: number };
  const analysisRow = sql.prepare('SELECT COUNT(*) as c FROM watch_only_signal_analysis').get() as { c: number };

  // Main winners query
  const winnerRawRows = sql.prepare(`
    SELECT
      wc.id          AS candidate_id,
      wc.token_id,
      wc.created_at  AS candidate_created_at,
      wc.entry_price_usd,
      wc.latest_price_usd,
      wc.best_gain_pct,
      wc.worst_drawdown_pct,
      wc.liquidity_usd   AS wc_liquidity,
      wc.volume_5m_usd   AS wc_vol5m,
      wc.volume_1h_usd   AS wc_vol1h,
      t.symbol,
      t.name,
      t.source,
      t.mint,
      t.first_seen_at,
      wsa.signal_class,
      wsa.moved_before_discovery_pct,
      wsa.freeze_authority,
      wsa.mint_authority,
      wsa.sell_quote_available,
      snap.price_usd     AS snap_price,
      snap.liquidity_usd AS snap_liq,
      snap.market_cap_usd,
      snap.volume_5m_usd AS snap_vol5m,
      snap.volume_1h_usd AS snap_vol1h,
      snap.volume_24h_usd,
      snap.price_change_5m_pct,
      snap.price_change_1h_pct,
      snap.buys_5m,
      snap.sells_5m,
      json_extract(snap.raw_json, '$.holderConcentration')   AS holder_concentration,
      json_extract(snap.raw_json, '$.creatorStatus')          AS creator_status,
      json_extract(snap.raw_json, '$.websitePresent')         AS website_present,
      json_extract(snap.raw_json, '$.socialsPresent')         AS socials_present,
      json_extract(snap.raw_json, '$.metadataPresent')        AS metadata_present,
      json_extract(snap.raw_json, '$.estimatedSlippageBps')   AS estimated_slippage_bps,
      json_extract(snap.raw_json, '$.tokenCreatedAt')         AS token_created_at
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    LEFT JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = wc.token_id ORDER BY id LIMIT 1
    )
    WHERE wc.best_gain_pct >= ?
    ORDER BY wc.best_gain_pct DESC
    LIMIT ?
  `).all(minGain, limit) as any[];

  // Decay snapshots for winners: all snapshots after discovery for these token IDs
  const winnerTokenIds = winnerRawRows.map((r: any) => r.token_id as number);
  const decaySnapsByToken = new Map<number, Array<{ minsAfter: number; priceUsd: number | null }>>();

  if (winnerTokenIds.length > 0) {
    const placeholders = winnerTokenIds.map(() => '?').join(',');
    const decayRows = sql.prepare(`
      SELECT snap.token_id, snap.price_usd,
        CAST((julianday(snap.observed_at) - julianday(wc.created_at)) * 1440 AS REAL) AS mins_after
      FROM token_snapshots snap
      JOIN watch_only_candidates wc ON wc.token_id = snap.token_id
      WHERE snap.token_id IN (${placeholders})
        AND snap.observed_at > wc.created_at
      ORDER BY snap.token_id, snap.observed_at
    `).all(...winnerTokenIds) as Array<{ token_id: number; price_usd: number | null; mins_after: number }>;

    for (const row of decayRows) {
      if (!decaySnapsByToken.has(row.token_id)) decaySnapsByToken.set(row.token_id, []);
      decaySnapsByToken.get(row.token_id)!.push({ minsAfter: row.mins_after, priceUsd: row.price_usd });
    }
  }

  function windowReturn(
    tokenId: number,
    entryPrice: number | null,
    windowMin: 15 | 30 | 60
  ): number | null {
    if (!entryPrice || entryPrice <= 0) return null;
    const snaps = decaySnapsByToken.get(tokenId) ?? [];
    const [lo, hi] = WINDOW_BOUNDS[windowMin];
    const hit = snaps.find((s) => s.minsAfter >= windowMin - lo && s.minsAfter <= windowMin + hi);
    if (!hit || hit.priceUsd == null) return null;
    return ((hit.priceUsd - entryPrice) / entryPrice) * 100;
  }

  const winners: WinnerRow[] = winnerRawRows.map((r: any) => {
    const entryPrice = r.entry_price_usd ?? r.snap_price ?? null;
    const currentReturn =
      entryPrice != null && r.latest_price_usd != null && entryPrice > 0
        ? ((r.latest_price_usd - entryPrice) / entryPrice) * 100
        : null;
    const peakGapPct =
      r.best_gain_pct != null && currentReturn != null ? r.best_gain_pct - currentReturn : null;
    const bsr =
      r.buys_5m != null && r.sells_5m != null && r.sells_5m > 0 ? r.buys_5m / r.sells_5m : null;
    const poolCreatedAt = r.token_created_at ?? null;
    const discoveryAgeMinutes =
      poolCreatedAt && r.candidate_created_at
        ? (new Date(r.candidate_created_at).getTime() - new Date(poolCreatedAt).getTime()) / 60_000
        : null;
    // Pump-dump: peaked at >=minGain but current return is deeply negative
    const isPumpDump =
      r.best_gain_pct >= minGain &&
      currentReturn != null &&
      currentReturn < -50;
    const isTradable =
      r.sell_quote_available != null ? r.sell_quote_available === 'AVAILABLE' : null;

    return {
      tokenId: r.token_id,
      symbol: r.symbol,
      name: r.name,
      source: r.source,
      mint: r.mint,
      candidateCreatedAt: r.candidate_created_at,
      poolCreatedAt,
      discoveryAgeMinutes: discoveryAgeMinutes != null && discoveryAgeMinutes >= 0 ? discoveryAgeMinutes : null,
      entryPriceUsd: entryPrice,
      latestPriceUsd: r.latest_price_usd ?? null,
      currentReturnPct: currentReturn,
      bestGainPct: r.best_gain_pct,
      worstDrawdownPct: r.worst_drawdown_pct ?? null,
      peakGapPct,
      liquidityUsd: r.snap_liq ?? r.wc_liquidity ?? null,
      marketCapUsd: r.market_cap_usd ?? null,
      volume5mUsd: r.snap_vol5m ?? r.wc_vol5m ?? null,
      volume1hUsd: r.snap_vol1h ?? r.wc_vol1h ?? null,
      volume24hUsd: r.volume_24h_usd ?? null,
      priceChange5mPct: r.price_change_5m_pct ?? null,
      priceChange1hPct: r.price_change_1h_pct ?? null,
      buys5m: r.buys_5m ?? null,
      sells5m: r.sells_5m ?? null,
      bsr,
      movedBeforePct: r.moved_before_discovery_pct ?? null,
      freezeAuthority: r.freeze_authority ?? null,
      mintAuthority: r.mint_authority ?? null,
      sellQuoteAvailable: r.sell_quote_available ?? null,
      estimatedSlippageBps: r.estimated_slippage_bps ?? null,
      holderConcentration: r.holder_concentration ?? null,
      creatorStatus: r.creator_status ?? null,
      websitePresent: r.website_present != null ? Boolean(r.website_present) : null,
      socialsPresent: r.socials_present != null ? Boolean(r.socials_present) : null,
      metadataPresent: r.metadata_present != null ? Boolean(r.metadata_present) : null,
      signalClass: r.signal_class ?? null,
      isPumpDump,
      isTradable,
      snap15mReturnPct: windowReturn(r.token_id, entryPrice, 15),
      snap30mReturnPct: windowReturn(r.token_id, entryPrice, 30),
      snap60mReturnPct: windowReturn(r.token_id, entryPrice, 60),
    };
  });

  // Comparison groups — queried fresh, not filtered to winners only
  const compRawRows = sql.prepare(`
    SELECT
      wsa.signal_class,
      wsa.moved_before_discovery_pct,
      wsa.sell_quote_available,
      wc.liquidity_usd   AS wc_liq,
      wc.volume_5m_usd   AS wc_vol5m,
      wc.best_gain_pct,
      wc.worst_drawdown_pct,
      snap.liquidity_usd AS snap_liq,
      snap.volume_5m_usd AS snap_vol5m,
      snap.price_change_5m_pct,
      snap.buys_5m,
      snap.sells_5m
    FROM watch_only_candidates wc
    LEFT JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = wc.token_id ORDER BY id LIMIT 1
    )
  `).all() as any[];

  type CompRow = {
    movedBefore: number | null;
    liq: number | null;
    vol5m: number | null;
    bsr: number | null;
    pc5m: number | null;
    bestGain: number | null;
    worstDraw: number | null;
    sellQuote: string | null;
    signalClass: string | null;
  };

  const toCompRow = (r: any): CompRow => ({
    movedBefore: r.moved_before_discovery_pct ?? null,
    liq: r.snap_liq ?? r.wc_liq ?? null,
    vol5m: r.snap_vol5m ?? r.wc_vol5m ?? null,
    bsr: r.buys_5m != null && r.sells_5m != null && r.sells_5m > 0 ? r.buys_5m / r.sells_5m : null,
    pc5m: r.price_change_5m_pct ?? null,
    bestGain: r.best_gain_pct ?? null,
    worstDraw: r.worst_drawdown_pct ?? null,
    sellQuote: r.sell_quote_available ?? null,
    signalClass: r.signal_class ?? null,
  });

  const allCompRows = compRawRows.map(toCompRow);
  const dumpRows = allCompRows.filter((r) => r.signalClass === 'INSTANT_DUMP');
  const noiseRows = allCompRows.filter((r) => r.signalClass === 'DEAD_NOISE');
  const noMatchRows = allCompRows.filter((r) => r.signalClass == null || r.signalClass === 'NO_MATCH');
  const winnerCompRows = winners.map((w) => ({
    movedBefore: w.movedBeforePct,
    liq: w.liquidityUsd,
    vol5m: w.volume5mUsd,
    bsr: w.bsr,
    pc5m: w.priceChange5mPct,
    bestGain: w.bestGainPct,
    worstDraw: w.worstDrawdownPct,
    sellQuote: w.sellQuoteAvailable,
  }));

  const decayCoverage = {
    winners: winners.length,
    with15m: winners.filter((w) => w.snap15mReturnPct != null).length,
    with30m: winners.filter((w) => w.snap30mReturnPct != null).length,
    with60m: winners.filter((w) => w.snap60mReturnPct != null).length,
  };

  const dataWarnings: string[] = [];
  if (winners.length === 0) dataWarnings.push(`No winners found with best_gain_pct >= ${minGain}%. Try --min-gain=50.`);
  if (winners.length < 5) dataWarnings.push(`Only ${winners.length} winner(s) — comparisons are directional only.`);
  if (decayCoverage.with15m === 0) dataWarnings.push('No 15m decay snapshots available for winners — run token:early-refresh-plan --run to collect them.');
  if (totalRow.c > 0 && analysisRow.c === 0) dataWarnings.push('No watch_only_signal_analysis rows found — run token:watch-analysis to classify signal classes.');

  const ruleHypotheses = [
    'Rule Hypotheses (plain language, research notes only — NOT ACTIVE):',
    '',
    '- Winners tend to have liquidity >= $20k at discovery; dumps/noise tend to be lower or similar.',
    '- Winners may have moderate pc5m (25–150%) rather than extreme spikes (>300%) which favor dumps.',
    '- Winners tend to have buy/sell ratio >= 1.5 at discovery; though dumps also show this.',
    '- Pool age at discovery is likely shorter for winners — caught earlier in the momentum window.',
    '- Survival test: winners that also have positive 15m/30m snapshots suggest sustained momentum.',
    '- moved_before_discovery_pct: lower may favor winners (less pre-move = more upside remaining).',
    '- Sell quote + slippage availability improves tradability but is currently sparse in this dataset.',
    '- Pump-dump signature: bestGainPct high + currentReturnPct deeply negative = spike-then-collapse.',
    '- Unsafe mint/freeze authority winners are chart-only wins — not tradable safely at any threshold.',
    '',
    'None of these are active rules. All require forward validation before paper or real application.',
  ];

  const decisionNote = [
    'Does this support paper trading?',
    '  → Not yet. Winner profiles are visible in hindsight but entry-time separation from dumps is weak.',
    '  → More historical data (1–2 weeks) and 15m/30m decay snapshots needed before forward testing.',
    '',
    'What data is still missing?',
    '  → 15m/30m/60m decay snapshots for most winners (run token:early-refresh-plan regularly).',
    '  → Sell quote and slippage data for most candidates (ENABLE_QUOTE_CHECK enrichment).',
    '  → Signal analysis classification for new GeckoTerminal candidates.',
    '  → Multi-week history to confirm profile consistency across market conditions.',
    '',
    'What to validate next?',
    '  → Run token:dump-risk-profile to compare EARLY_RUNNER vs INSTANT_DUMP entry signals.',
    '  → Run token:decay-rate to see 15m/30m/60m survival rates across signal classes.',
    '  → Continue accumulating watch-only history before any paper-buy threshold changes.',
  ];

  return {
    minGainPct: minGain,
    limit,
    totalCandidates: totalRow.c,
    totalWithSignalAnalysis: analysisRow.c,
    winnersFound: winners.length,
    dataWarnings,
    winners,
    winnerStats: buildGroupStats(`winners (>=${minGain}%)`, winnerCompRows),
    dumpStats: buildGroupStats('INSTANT_DUMP', dumpRows),
    noiseStats: buildGroupStats('DEAD_NOISE', noiseRows),
    noMatchStats: noMatchRows.length > 0 ? buildGroupStats('NO_MATCH / unclassified', noMatchRows) : null,
    decayCoverage,
    ruleHypotheses,
    decisionNote,
  };
}

export function renderHistoricalWinnerAutopsy(
  db: AppDb,
  config: AppConfig,
  options: { minGain?: number; limit?: number; top?: number } = {}
): string {
  const r = buildHistoricalWinnerAutopsy(db, config, options);
  const top = options.top ?? DEFAULT_TOP;
  const lines: string[] = [];
  const sep = '─'.repeat(60);
  const thin = '·'.repeat(60);

  // ── 1. Header ──────────────────────────────────────────────
  lines.push('Historical Winner Autopsy');
  lines.push(sep);
  lines.push(`Min gain threshold:  >=${r.minGainPct}%`);
  lines.push(`Winners found:       ${r.winnersFound} of ${r.totalCandidates} watch-only candidates`);
  lines.push(`Signal analysis:     ${r.totalWithSignalAnalysis} candidates classified`);
  if (r.dataWarnings.length > 0) {
    lines.push('');
    for (const w of r.dataWarnings) lines.push(`  ⚠  ${w}`);
  }
  lines.push('');

  if (r.winnersFound === 0) {
    lines.push('No winners found. Adjust --min-gain or run more watch cycles.');
    lines.push('');
    lines.push(sep);
    lines.push('Safety');
    lines.push(sep);
    lines.push('  Report only. No DB writes. No trading behavior changed.');
    lines.push('  Real trading remains locked.');
    return lines.join('\n');
  }

  // ── 2. Top Winners Table ───────────────────────────────────
  lines.push('Top Winners Table');
  lines.push(sep);
  const topWinners = r.winners.slice(0, top);
  lines.push(`Showing top ${topWinners.length} winners (sorted by best gain):`);
  lines.push('');

  for (const w of topWinners) {
    const flags: string[] = [];
    if (w.isPumpDump) flags.push('PUMP-DUMP');
    if (w.isTradable === false) flags.push('SELL-BLOCKED');
    if (w.isTradable === true) flags.push('TRADABLE');
    if (w.freezeAuthority === 'UNSAFE' || w.mintAuthority === 'UNSAFE') flags.push('UNSAFE-AUTH');
    if (w.freezeAuthority === 'UNKNOWN' && w.mintAuthority === 'UNKNOWN') flags.push('AUTH-UNKNOWN');
    const flagStr = flags.length > 0 ? `  [${flags.join(' ')}]` : '';
    const bsr = w.bsr != null ? fmtNum(w.bsr) : '-';

    lines.push(`  ${w.symbol.padEnd(14)} src=${w.source.padEnd(13)} best=${fmtPct(w.bestGainPct, 0).padStart(8)} cur=${fmtPct(w.currentReturnPct, 0).padStart(8)} draw=${fmtPct(w.worstDrawdownPct, 0).padStart(8)}${flagStr}`);
    lines.push(`    liq=${fmtMoney(w.liquidityUsd).padEnd(8)} vol5m=${fmtMoney(w.volume5mUsd).padEnd(8)} pc5m=${fmtPct(w.priceChange5mPct, 0).padEnd(8)} bsr=${bsr.padEnd(5)} moved_b4=${fmtPct(w.movedBeforePct, 0)}`);
    lines.push(`    class=${w.signalClass ?? 'UNCLASSIFIED'} freeze=${w.freezeAuthority ?? '-'} mint=${w.mintAuthority ?? '-'} holder=${w.holderConcentration ?? '-'} creator=${w.creatorStatus ?? '-'}`);
    lines.push(`    decay: 15m=${fmtPct(w.snap15mReturnPct, 0)} 30m=${fmtPct(w.snap30mReturnPct, 0)} 60m=${fmtPct(w.snap60mReturnPct, 0)}  discovery_age=${fmtAge(w.discoveryAgeMinutes)}  slippage=${w.estimatedSlippageBps != null ? `${w.estimatedSlippageBps}bps` : '-'}`);
    lines.push('');
  }

  // ── 3. Pre-Run Signal Summary ──────────────────────────────
  lines.push('Pre-Run Signal Summary');
  lines.push(sep);
  lines.push(`Comparing entry-time signals: winners vs INSTANT_DUMP vs DEAD_NOISE`);
  lines.push('');

  const groups = [r.winnerStats, r.dumpStats, r.noiseStats];
  if (r.noMatchStats) groups.push(r.noMatchStats);

  const statRows: Array<{ field: string; values: Array<string> }> = [
    {
      field: 'n',
      values: groups.map((g) => String(g.count)),
    },
    {
      field: 'moved_before avg',
      values: groups.map((g) => fmtPct(g.avgMovedBefore, 0)),
    },
    {
      field: 'moved_before med',
      values: groups.map((g) => fmtPct(g.medMovedBefore, 0)),
    },
    {
      field: 'liquidity avg',
      values: groups.map((g) => fmtMoney(g.avgLiqUsd)),
    },
    {
      field: 'liquidity med',
      values: groups.map((g) => fmtMoney(g.medLiqUsd)),
    },
    {
      field: 'vol5m avg',
      values: groups.map((g) => fmtMoney(g.avgVol5mUsd)),
    },
    {
      field: 'vol5m med',
      values: groups.map((g) => fmtMoney(g.medVol5mUsd)),
    },
    {
      field: 'BSR avg',
      values: groups.map((g) => fmtNum(g.avgBsr)),
    },
    {
      field: 'BSR med',
      values: groups.map((g) => fmtNum(g.medBsr)),
    },
    {
      field: 'pc5m avg',
      values: groups.map((g) => fmtPct(g.avgPc5m, 0)),
    },
    {
      field: 'pc5m med',
      values: groups.map((g) => fmtPct(g.medPc5m, 0)),
    },
    {
      field: 'best_gain avg',
      values: groups.map((g) => fmtPct(g.avgBestGain, 0)),
    },
    {
      field: 'worst_draw avg',
      values: groups.map((g) => fmtPct(g.avgWorstDraw, 0)),
    },
    {
      field: 'sell_quote avail%',
      values: groups.map((g) => g.sellQuoteAvailablePct != null ? `${g.sellQuoteAvailablePct.toFixed(0)}%` : '-'),
    },
  ];

  const FW = 20;
  const VW = 14;
  const header = `  ${'Field'.padEnd(FW)} ${groups.map((g) => g.label.slice(0, VW - 1).padStart(VW)).join('')}`;
  lines.push(header);
  for (const row of statRows) {
    lines.push(`  ${row.field.padEnd(FW)} ${row.values.map((v) => v.padStart(VW)).join('')}`);
  }
  lines.push('');

  // ── 4. Safety / Tradability Summary ───────────────────────
  lines.push('Safety / Tradability Summary');
  lines.push(sep);

  const sellAvail = r.winners.filter((w) => w.sellQuoteAvailable === 'AVAILABLE').length;
  const sellUnknown = r.winners.filter((w) => w.sellQuoteAvailable === 'UNKNOWN' || w.sellQuoteAvailable == null).length;
  const sellBlocked = r.winners.filter((w) => w.sellQuoteAvailable === 'NO').length;
  const unsafeAuth = r.winners.filter((w) => w.freezeAuthority === 'UNSAFE' || w.mintAuthority === 'UNSAFE').length;
  const unknownAuth = r.winners.filter((w) => (w.freezeAuthority === 'UNKNOWN' || w.mintAuthority === 'UNKNOWN') && w.freezeAuthority !== 'UNSAFE' && w.mintAuthority !== 'UNSAFE').length;
  const safeAuth = r.winners.filter((w) => w.freezeAuthority === 'SAFE' && w.mintAuthority === 'SAFE').length;
  const tradableWinners = r.winners.filter((w) => w.isTradable === true && w.freezeAuthority !== 'UNSAFE' && w.mintAuthority !== 'UNSAFE').length;
  const pumpDumps = r.winners.filter((w) => w.isPumpDump).length;
  const withSlippage = r.winners.filter((w) => w.estimatedSlippageBps != null).length;

  lines.push(`  Total winners:       ${r.winnersFound}`);
  lines.push(`  Sell quote AVAILABLE: ${sellAvail} | UNKNOWN: ${sellUnknown} | NO: ${sellBlocked}`);
  lines.push(`  Authority SAFE both: ${safeAuth} | UNKNOWN: ${unknownAuth} | UNSAFE: ${unsafeAuth}`);
  lines.push(`  Slippage recorded:   ${withSlippage} of ${r.winnersFound}`);
  lines.push(`  Likely tradable:     ${tradableWinners} (sell quote AVAILABLE + no UNSAFE authority)`);
  lines.push(`  Pump-dump signature: ${pumpDumps} winner(s) later collapsed > -50% from entry`);
  lines.push(`  Chart-only wins:     ${unsafeAuth + sellBlocked} winner(s) with UNSAFE authority or blocked sell`);
  lines.push('');
  lines.push('  Note: UNKNOWN sell quote means the quote check was not run, not that selling is impossible.');
  lines.push('  Enable ENABLE_QUOTE_CHECK=true during watch cycles for better tradability data.');
  lines.push('');

  // ── 5. Decay / Survival Summary ───────────────────────────
  lines.push('Decay / Survival Summary');
  lines.push(sep);
  lines.push(`  Winners with decay snapshots:`);
  lines.push(`    15m coverage: ${r.decayCoverage.with15m} / ${r.decayCoverage.winners}`);
  lines.push(`    30m coverage: ${r.decayCoverage.with30m} / ${r.decayCoverage.winners}`);
  lines.push(`    60m coverage: ${r.decayCoverage.with60m} / ${r.decayCoverage.winners}`);

  const snap15Returns = r.winners.map((w) => w.snap15mReturnPct).filter((v): v is number => v != null);
  const snap30Returns = r.winners.map((w) => w.snap30mReturnPct).filter((v): v is number => v != null);
  const snap60Returns = r.winners.map((w) => w.snap60mReturnPct).filter((v): v is number => v != null);

  if (snap15Returns.length > 0) {
    lines.push(`    15m avg return: ${fmtPct(avg(snap15Returns), 1)} | med: ${fmtPct(median(snap15Returns), 1)}`);
  }
  if (snap30Returns.length > 0) {
    lines.push(`    30m avg return: ${fmtPct(avg(snap30Returns), 1)} | med: ${fmtPct(median(snap30Returns), 1)}`);
  }
  if (snap60Returns.length > 0) {
    lines.push(`    60m avg return: ${fmtPct(avg(snap60Returns), 1)} | med: ${fmtPct(median(snap60Returns), 1)}`);
  }

  if (r.decayCoverage.with15m === 0) {
    lines.push('    No decay snapshots collected yet. Run token:early-refresh-plan --run regularly.');
  }
  lines.push('');

  // ── 6. Pump-Dump / False Positive Notes ───────────────────
  lines.push('Pump-Dump / False Positive Notes');
  lines.push(sep);

  const pumpDumpWinners = r.winners.filter((w) => w.isPumpDump);
  const unsafeAuthWinners = r.winners.filter((w) => w.freezeAuthority === 'UNSAFE' || w.mintAuthority === 'UNSAFE');

  if (pumpDumpWinners.length === 0 && unsafeAuthWinners.length === 0) {
    lines.push('  No pump-dump or unsafe-authority winners found in top candidates.');
  }
  if (pumpDumpWinners.length > 0) {
    lines.push(`  Pump-dump winners (peak high, current deeply negative):`);
    for (const w of pumpDumpWinners.slice(0, 5)) {
      lines.push(`    ${w.symbol.padEnd(14)} best=${fmtPct(w.bestGainPct, 0).padStart(8)} cur=${fmtPct(w.currentReturnPct, 0).padStart(8)} — signal class: ${w.signalClass ?? 'UNCLASSIFIED'}`);
    }
    lines.push('  These peaked and collapsed. Best gain is a historical snapshot, not a sustained move.');
  }
  if (unsafeAuthWinners.length > 0) {
    lines.push('');
    lines.push(`  Unsafe authority winners (chart-only — not tradable safely):`);
    for (const w of unsafeAuthWinners.slice(0, 5)) {
      lines.push(`    ${w.symbol.padEnd(14)} best=${fmtPct(w.bestGainPct, 0).padStart(8)} freeze=${w.freezeAuthority ?? '-'} mint=${w.mintAuthority ?? '-'}`);
    }
    lines.push('  These have high UNSAFE authority risk. The chart move was real but safe exit is not guaranteed.');
    lines.push('  UNSAFE authority should block paper buy, not watch-only tracking.');
    lines.push('  Watch-only correctly captures these as observable data, not as tradable signals.');
  }
  lines.push('');

  // ── 7. Candidate Rule Hypotheses ──────────────────────────
  lines.push('Candidate Rule Hypotheses');
  lines.push(sep);
  for (const l of r.ruleHypotheses) lines.push(`  ${l}`);
  lines.push('');

  // ── 8. Decision Note ──────────────────────────────────────
  lines.push('Decision Note');
  lines.push(sep);
  for (const l of r.decisionNote) lines.push(`  ${l}`);
  lines.push('');

  // ── 9. Safety Footer ──────────────────────────────────────
  lines.push(sep);
  lines.push('Safety');
  lines.push(sep);
  lines.push('  Report only. No DB writes. No network calls.');
  lines.push('  No trading behavior changed. No thresholds changed.');
  lines.push('  Real trading remains locked.');

  return lines.join('\n');
}
