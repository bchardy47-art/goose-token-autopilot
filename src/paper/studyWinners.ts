import type { AppDb } from '../db';
import type { AppConfig } from '../types';

const WINNER_GAIN_THRESHOLD_PCT = 50;

function fmtPct(v: number | null | undefined, digits = 1): string {
  return v == null ? '-' : `${v.toFixed(digits)}%`;
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '-';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function fmtNum(v: number | null | undefined, digits = 1): string {
  return v == null ? '-' : v.toFixed(digits);
}

function shortenMint(mint: string): string {
  return mint.length <= 12 ? mint : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

type SignalClass = 'EARLY_RUNNER' | 'LATE_RUNNER' | 'TOO_DANGEROUS' | 'INSTANT_DUMP' | 'DEAD_NOISE';

export interface ClassStats {
  signalClass: SignalClass;
  total: number;
  avgGainPct: number | null;
  maxGainPct: number | null;
  avgDrawdownPct: number | null;
  winnerCount: number;
  tpHitRate1h: number | null;
  avgLiqUsd: number | null;
  avgVol5mUsd: number | null;
  avgMovedBeforePct: number | null;
  freezeSafeCount: number;
}

export interface EarlySignalRow {
  signalClass: SignalClass;
  avgPriceChange5mPct: number | null;
  avgPriceChange1hPct: number | null;
  avgBuys5m: number | null;
  avgSells5m: number | null;
  avgLiqUsd: number | null;
  avgVol5mUsd: number | null;
}

export interface TopWinnerRow {
  symbol: string;
  mint: string;
  signalClass: SignalClass;
  bestGainPct: number;
  entryLiqUsd: number | null;
  vol5mUsd: number | null;
  movedBeforeDiscoveryPct: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  buys5m: number | null;
  sells5m: number | null;
  freezeAuthority: string | null;
}

export interface WinnerStudyReport {
  totalCandidates: number;
  geckoTerminalCandidates: number;
  watchCandidatesWithOutcomes: number;
  outcomeWindowsAvailable: string[];
  allWithOutcomes: boolean;
  dateRangeFirst: string | null;
  dateRangeLast: string | null;
  winnerThresholdPct: number;
  winnerCount: number;
  gainDistribution: { lt10: number; lt25: number; lt50: number; lt100: number; ge100: number };
  byClass: ClassStats[];
  earlySignals: EarlySignalRow[];
  topWinners: TopWinnerRow[];
  missingForFullStudy: string[];
  nextBuild: string;
}

export function buildWinnerStudyReport(db: AppDb, _config: AppConfig): WinnerStudyReport {
  const s = db.sqlite;

  const totalRow = s.prepare('SELECT COUNT(*) as c FROM tokens').get() as { c: number };
  const geckoRow = s.prepare("SELECT COUNT(*) as c FROM tokens WHERE source = 'geckoterminal'").get() as { c: number };
  const watchTotalRow = s.prepare('SELECT COUNT(*) as c FROM watch_only_candidates').get() as { c: number };
  const withOutcomeRow = s.prepare(
    'SELECT COUNT(DISTINCT wc.id) as c FROM watch_only_candidates wc JOIN watch_only_outcomes wo ON wo.watch_candidate_id = wc.id'
  ).get() as { c: number };
  const windowRows = s.prepare(
    'SELECT DISTINCT window_label FROM watch_only_outcomes ORDER BY target_minutes'
  ).all() as Array<{ window_label: string }>;
  const dateRow = s.prepare('SELECT MIN(first_seen_at) as first, MAX(last_seen_at) as last FROM tokens').get() as {
    first: string | null;
    last: string | null;
  };

  const distRow = s.prepare(`
    SELECT
      SUM(CASE WHEN best_gain_pct >= 0 AND best_gain_pct < 10 THEN 1 ELSE 0 END) as lt10,
      SUM(CASE WHEN best_gain_pct >= 10 AND best_gain_pct < 25 THEN 1 ELSE 0 END) as lt25,
      SUM(CASE WHEN best_gain_pct >= 25 AND best_gain_pct < 50 THEN 1 ELSE 0 END) as lt50,
      SUM(CASE WHEN best_gain_pct >= 50 AND best_gain_pct < 100 THEN 1 ELSE 0 END) as lt100,
      SUM(CASE WHEN best_gain_pct >= 100 THEN 1 ELSE 0 END) as ge100
    FROM watch_only_candidates
  `).get() as { lt10: number; lt25: number; lt50: number; lt100: number; ge100: number };

  const winnerRow = s.prepare('SELECT COUNT(*) as c FROM watch_only_candidates WHERE best_gain_pct >= ?').get(
    WINNER_GAIN_THRESHOLD_PCT
  ) as { c: number };

  const byClassRows = s.prepare(`
    SELECT wsa.signal_class,
      COUNT(*) as total,
      AVG(wc.best_gain_pct) as avg_gain,
      MAX(wc.best_gain_pct) as max_gain,
      AVG(wc.worst_drawdown_pct) as avg_drawdown,
      SUM(CASE WHEN wc.best_gain_pct >= ? THEN 1 ELSE 0 END) as winner_count,
      AVG(wc.liquidity_usd) as avg_liq,
      AVG(wc.volume_5m_usd) as avg_vol5m,
      AVG(wsa.moved_before_discovery_pct) as avg_moved_before,
      SUM(CASE WHEN wsa.freeze_authority = 'SAFE' THEN 1 ELSE 0 END) as freeze_safe
    FROM watch_only_candidates wc
    JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    GROUP BY wsa.signal_class
    ORDER BY avg_gain DESC
  `).all(WINNER_GAIN_THRESHOLD_PCT) as any[];

  const tpRows = s.prepare(`
    SELECT wsa.signal_class,
      CAST(SUM(wo.would_hit_take_profit) AS REAL) / COUNT(*) as tp_rate
    FROM watch_only_outcomes wo
    JOIN watch_only_candidates wc ON wc.id = wo.watch_candidate_id
    JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    WHERE wo.window_label = '1h'
    GROUP BY wsa.signal_class
  `).all() as Array<{ signal_class: string; tp_rate: number }>;
  const tpByClass = Object.fromEntries(tpRows.map((r) => [r.signal_class, r.tp_rate]));

  const byClass: ClassStats[] = byClassRows.map((r: any) => ({
    signalClass: r.signal_class as SignalClass,
    total: r.total,
    avgGainPct: r.avg_gain,
    maxGainPct: r.max_gain,
    avgDrawdownPct: r.avg_drawdown,
    winnerCount: r.winner_count,
    tpHitRate1h: tpByClass[r.signal_class] ?? null,
    avgLiqUsd: r.avg_liq,
    avgVol5mUsd: r.avg_vol5m,
    avgMovedBeforePct: r.avg_moved_before,
    freezeSafeCount: r.freeze_safe
  }));

  const earlySignalRows = s.prepare(`
    SELECT wsa.signal_class,
      AVG(snap.price_change_5m_pct) as avg_pc5m,
      AVG(snap.price_change_1h_pct) as avg_pc1h,
      AVG(snap.buys_5m) as avg_buys5m,
      AVG(snap.sells_5m) as avg_sells5m,
      AVG(wc.liquidity_usd) as avg_liq,
      AVG(wc.volume_5m_usd) as avg_vol5m
    FROM watch_only_candidates wc
    JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = wc.token_id ORDER BY id LIMIT 1
    )
    GROUP BY wsa.signal_class
    ORDER BY
      CASE wsa.signal_class
        WHEN 'EARLY_RUNNER' THEN 1
        WHEN 'LATE_RUNNER' THEN 2
        WHEN 'TOO_DANGEROUS' THEN 3
        WHEN 'INSTANT_DUMP' THEN 4
        WHEN 'DEAD_NOISE' THEN 5
        ELSE 6
      END
  `).all() as any[];

  const earlySignals: EarlySignalRow[] = earlySignalRows.map((r: any) => ({
    signalClass: r.signal_class as SignalClass,
    avgPriceChange5mPct: r.avg_pc5m,
    avgPriceChange1hPct: r.avg_pc1h,
    avgBuys5m: r.avg_buys5m,
    avgSells5m: r.avg_sells5m,
    avgLiqUsd: r.avg_liq,
    avgVol5mUsd: r.avg_vol5m
  }));

  const topWinnerRows = s.prepare(`
    SELECT t.symbol, t.mint, wsa.signal_class,
      wc.best_gain_pct, wc.liquidity_usd, wc.volume_5m_usd,
      wsa.moved_before_discovery_pct, wsa.freeze_authority,
      snap.price_change_5m_pct, snap.price_change_1h_pct, snap.buys_5m, snap.sells_5m
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = wc.token_id ORDER BY id LIMIT 1
    )
    WHERE wc.best_gain_pct >= ?
    ORDER BY wc.best_gain_pct DESC
    LIMIT 10
  `).all(WINNER_GAIN_THRESHOLD_PCT) as any[];

  const topWinners: TopWinnerRow[] = topWinnerRows.map((r: any) => ({
    symbol: r.symbol,
    mint: r.mint,
    signalClass: r.signal_class as SignalClass,
    bestGainPct: r.best_gain_pct,
    entryLiqUsd: r.liquidity_usd,
    vol5mUsd: r.volume_5m_usd,
    movedBeforeDiscoveryPct: r.moved_before_discovery_pct,
    priceChange5mPct: r.price_change_5m_pct,
    priceChange1hPct: r.price_change_1h_pct,
    buys5m: r.buys_5m,
    sells5m: r.sells_5m,
    freezeAuthority: r.freeze_authority
  }));

  return {
    totalCandidates: totalRow.c,
    geckoTerminalCandidates: geckoRow.c,
    watchCandidatesWithOutcomes: withOutcomeRow.c,
    outcomeWindowsAvailable: windowRows.map((r) => r.window_label),
    allWithOutcomes: withOutcomeRow.c === watchTotalRow.c && watchTotalRow.c > 0,
    dateRangeFirst: dateRow.first,
    dateRangeLast: dateRow.last,
    winnerThresholdPct: WINNER_GAIN_THRESHOLD_PCT,
    winnerCount: winnerRow.c,
    gainDistribution: {
      lt10: distRow.lt10,
      lt25: distRow.lt25,
      lt50: distRow.lt50,
      lt100: distRow.lt100,
      ge100: distRow.ge100
    },
    byClass,
    earlySignals,
    topWinners,
    missingForFullStudy: [
      'Multi-week history (data spans only ~3 days so far; more history needed to confirm winner profile)',
      'Price snapshots at each outcome window (outcomes use live-fetched price, not a stored snapshot)',
      'Token age at discovery for all candidates (pool_age_minutes not always populated)',
      'On-chain holder data timestamped to discovery (safety enrichments collected asynchronously)'
    ],
    nextBuild:
      'token:watch-refresh — re-fetch price for active EARLY_RUNNER candidates hourly to build a time-series for the first 6h and harden the winner identification loop.'
  };
}

export function renderWinnerStudyReport(db: AppDb, config: AppConfig): string {
  const r = buildWinnerStudyReport(db, config);
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  lines.push('Historical Winner Study');
  lines.push(sep);

  // 1. Readiness
  lines.push('1. Historical Study Readiness');
  const ready = r.allWithOutcomes ? 'READY' : 'PARTIAL';
  lines.push(`   Status: ${ready}`);
  lines.push(`   Watch candidates: ${r.geckoTerminalCandidates} | With outcomes: ${r.watchCandidatesWithOutcomes}`);
  lines.push(`   Outcome windows: ${r.outcomeWindowsAvailable.join(', ')}`);
  lines.push(`   Data range: ${r.dateRangeFirst?.slice(0, 10) ?? '-'} → ${r.dateRangeLast?.slice(0, 10) ?? '-'}`);
  lines.push('');

  // 2. Candidate count
  lines.push('2. Current Stored Candidate Count');
  lines.push(`   Total tokens in DB: ${r.totalCandidates}`);
  lines.push(`   GeckoTerminal watch candidates: ${r.geckoTerminalCandidates}`);
  lines.push(`   Winners (best peak gain >= ${r.winnerThresholdPct}%): ${r.winnerCount} / ${r.geckoTerminalCandidates} (${((r.winnerCount / Math.max(1, r.geckoTerminalCandidates)) * 100).toFixed(1)}%)`);
  lines.push('   Gain distribution (peak best):');
  lines.push(`     0–10%:   ${r.gainDistribution.lt10} tokens`);
  lines.push(`     10–25%:  ${r.gainDistribution.lt25} tokens`);
  lines.push(`     25–50%:  ${r.gainDistribution.lt50} tokens`);
  lines.push(`     50–100%: ${r.gainDistribution.lt100} tokens`);
  lines.push(`     >100%:   ${r.gainDistribution.ge100} tokens`);
  lines.push('');

  // 3. Early signals
  lines.push('3. Available Early Signals');
  lines.push('   Fields at discovery: price_usd, liquidity_usd, volume_5m_usd, volume_1h_usd,');
  lines.push('   price_change_5m_pct, price_change_1h_pct, buys_5m, sells_5m, market_cap_usd,');
  lines.push('   moved_before_discovery_pct, signal_class, mint_authority, freeze_authority');
  lines.push('');
  lines.push('   Avg signals at discovery by outcome class:');
  const hdr = `   ${'Class'.padEnd(15)} ${'pc5m'.padStart(7)} ${'pc1h'.padStart(8)} ${'buys5m'.padStart(7)} ${'sells5m'.padStart(8)} ${'BSR'.padStart(5)} ${'liq'.padStart(7)} ${'vol5m'.padStart(7)}`;
  lines.push(hdr);
  for (const sig of r.earlySignals) {
    const bsr = (sig.avgBuys5m != null && sig.avgSells5m != null && sig.avgSells5m > 0)
      ? (sig.avgBuys5m / sig.avgSells5m).toFixed(2)
      : '-';
    lines.push(
      `   ${sig.signalClass.padEnd(15)} ${fmtPct(sig.avgPriceChange5mPct, 0).padStart(7)} ${fmtPct(sig.avgPriceChange1hPct, 0).padStart(8)} ${fmtNum(sig.avgBuys5m, 0).padStart(7)} ${fmtNum(sig.avgSells5m, 0).padStart(8)} ${bsr.padStart(5)} ${fmtMoney(sig.avgLiqUsd).padStart(7)} ${fmtMoney(sig.avgVol5mUsd).padStart(7)}`
    );
  }
  lines.push('   BSR = avg(buys_5m) / avg(sells_5m)');
  lines.push('');

  // 4. Outcome signals by class
  lines.push('4. Available Later Outcome Signals');
  lines.push(`   ${'Class'.padEnd(15)} ${'n'.padStart(3)} ${'avgGain'.padStart(9)} ${'maxGain'.padStart(9)} ${'winners'.padStart(8)} ${'1h-TP%'.padStart(7)} ${'avgDraw'.padStart(9)} ${'moved_b4'.padStart(9)}`);
  for (const cls of r.byClass) {
    const tp = cls.tpHitRate1h != null ? `${(cls.tpHitRate1h * 100).toFixed(0)}%` : '-';
    lines.push(
      `   ${cls.signalClass.padEnd(15)} ${String(cls.total).padStart(3)} ${fmtPct(cls.avgGainPct, 0).padStart(9)} ${fmtPct(cls.maxGainPct, 0).padStart(9)} ${String(cls.winnerCount).padStart(8)} ${tp.padStart(7)} ${fmtPct(cls.avgDrawdownPct, 0).padStart(9)} ${fmtPct(cls.avgMovedBeforePct, 0).padStart(9)}`
    );
  }
  lines.push('   1h-TP% = fraction of tokens that hit take-profit within 1 hour of discovery');
  lines.push('   moved_b4 = avg % price already moved before scanner discovered the token');
  lines.push('');

  // 5. Missing data
  lines.push('5. Missing Data for a Complete Winner Study');
  for (const m of r.missingForFullStudy) {
    lines.push(`   - ${m}`);
  }
  lines.push('');

  // 6. Next build
  lines.push('6. Recommended Next Build');
  lines.push(`   ${r.nextBuild}`);
  lines.push('');

  // Top winners appendix
  if (r.topWinners.length > 0) {
    lines.push(sep);
    lines.push(`Top ${r.topWinners.length} Winners (best peak gain >= ${r.winnerThresholdPct}%)`);
    for (const w of r.topWinners) {
      const bsr = (w.buys5m != null && w.sells5m != null && w.sells5m > 0)
        ? (w.buys5m / w.sells5m).toFixed(2)
        : '-';
      lines.push(`   ${w.symbol.padEnd(16)} +${fmtPct(w.bestGainPct, 0).padStart(8)} [${w.signalClass}]`);
      lines.push(`     liq=${fmtMoney(w.entryLiqUsd)} vol5m=${fmtMoney(w.vol5mUsd)} pc5m=${fmtPct(w.priceChange5mPct, 0)} bsr=${bsr} moved_b4=${fmtPct(w.movedBeforeDiscoveryPct, 0)} freeze=${w.freezeAuthority ?? '-'} mint=${shortenMint(w.mint)}`);
    }
  }
  lines.push('');
  lines.push('Real trading remains locked. Report only.');

  return lines.join('\n');
}
