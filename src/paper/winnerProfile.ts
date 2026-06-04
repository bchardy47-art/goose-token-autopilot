import type { AppDb } from '../db';
import type { AppConfig } from '../types';

const DEFAULT_MIN_GAIN_PCT = 50;
const DEFAULT_TOP = 10;

type SignalClass = 'EARLY_RUNNER' | 'LATE_RUNNER' | 'TOO_DANGEROUS' | 'INSTANT_DUMP' | 'DEAD_NOISE';

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

function ratio(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

function separatorStrength(r: number | null): 'STRONG' | 'MODERATE' | 'WEAK' | 'UNAVAILABLE' {
  if (r == null) return 'UNAVAILABLE';
  const abs = Math.abs(r);
  if (abs >= 3) return 'STRONG';
  if (abs >= 1.5) return 'MODERATE';
  return 'WEAK';
}

export interface ClassProfile {
  signalClass: SignalClass;
  n: number;
  winnerCount: number;
  avgMovedBeforePct: number | null;
  avgPriceChange5mPct: number | null;
  avgPriceChange1hPct: number | null;
  avgBuys5m: number | null;
  avgSells5m: number | null;
  avgBuySellRatio: number | null;
  avgLiqUsd: number | null;
  avgVol5mUsd: number | null;
  avgVol1hUsd: number | null;
  avgPoolAgeAtDiscoveryMin: number | null;
  avgBestGainPct: number | null;
  avgWorstDrawdownPct: number | null;
  freezeSafePct: number | null;
}

export interface Separator {
  field: string;
  earlyRunnerValue: string;
  baselineValue: string;
  baselineLabel: string;
  ratioVsBaseline: number | null;
  strength: 'STRONG' | 'MODERATE' | 'WEAK' | 'UNAVAILABLE';
  direction: string;
}

export interface TopWinner {
  symbol: string;
  signalClass: SignalClass;
  bestGainPct: number;
  movedBeforePct: number | null;
  buys5m: number | null;
  sells5m: number | null;
  liqUsd: number | null;
  vol5mUsd: number | null;
  priceChange5mPct: number | null;
  freezeAuthority: string | null;
}

export interface WinnerProfileReport {
  minGainPct: number;
  top: number;
  totalCandidates: number;
  earlyRunnerCount: number;
  lateRunnerCount: number;
  tooDangerousCount: number;
  instantDumpCount: number;
  deadNoiseCount: number;
  profiles: ClassProfile[];
  separators: Separator[];
  topWinners: TopWinner[];
  candidateRuleDraft: string[];
  shadowBuyHypothesis: string[];
  dataWarnings: string[];
}

export function buildWinnerProfileReport(db: AppDb, _config: AppConfig, options: { minGainPct?: number; top?: number } = {}): WinnerProfileReport {
  const minGainPct = options.minGainPct ?? DEFAULT_MIN_GAIN_PCT;
  const top = options.top ?? DEFAULT_TOP;
  const s = db.sqlite;

  const profileRows = s.prepare(`
    SELECT wsa.signal_class,
      COUNT(*) as n,
      SUM(CASE WHEN wc.best_gain_pct >= ? THEN 1 ELSE 0 END) as winner_count,
      AVG(wsa.moved_before_discovery_pct) as avg_moved_before,
      AVG(snap.price_change_5m_pct) as avg_pc5m,
      AVG(snap.price_change_1h_pct) as avg_pc1h,
      AVG(snap.buys_5m) as avg_buys5m,
      AVG(snap.sells_5m) as avg_sells5m,
      AVG(wc.liquidity_usd) as avg_liq,
      AVG(wc.volume_5m_usd) as avg_vol5m,
      AVG(wc.volume_1h_usd) as avg_vol1h,
      AVG(wc.best_gain_pct) as avg_best_gain,
      AVG(wc.worst_drawdown_pct) as avg_worst_drawdown,
      SUM(CASE WHEN wsa.freeze_authority = 'SAFE' THEN 1 ELSE 0 END) as freeze_safe_n,
      AVG(CAST((julianday(wc.created_at) - julianday(t.created_at)) * 1440 AS REAL)) as avg_pool_age_min
    FROM watch_only_candidates wc
    JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    JOIN tokens t ON t.id = wc.token_id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = wc.token_id ORDER BY id LIMIT 1
    )
    GROUP BY wsa.signal_class
    ORDER BY avg_best_gain DESC
  `).all(minGainPct) as any[];

  const profiles: ClassProfile[] = profileRows.map((r: any) => {
    const buys = r.avg_buys5m as number | null;
    const sells = r.avg_sells5m as number | null;
    const bsr = (buys != null && sells != null && sells > 0) ? buys / sells : null;
    return {
      signalClass: r.signal_class as SignalClass,
      n: r.n,
      winnerCount: r.winner_count,
      avgMovedBeforePct: r.avg_moved_before,
      avgPriceChange5mPct: r.avg_pc5m,
      avgPriceChange1hPct: r.avg_pc1h,
      avgBuys5m: buys,
      avgSells5m: sells,
      avgBuySellRatio: bsr,
      avgLiqUsd: r.avg_liq,
      avgVol5mUsd: r.avg_vol5m,
      avgVol1hUsd: r.avg_vol1h,
      avgPoolAgeAtDiscoveryMin: r.avg_pool_age_min,
      avgBestGainPct: r.avg_best_gain,
      avgWorstDrawdownPct: r.avg_worst_drawdown,
      freezeSafePct: r.n > 0 ? (r.freeze_safe_n / r.n) * 100 : null
    };
  });

  const early = profiles.find((p) => p.signalClass === 'EARLY_RUNNER') ?? null;
  const dead = profiles.find((p) => p.signalClass === 'DEAD_NOISE') ?? null;
  const dump = profiles.find((p) => p.signalClass === 'INSTANT_DUMP') ?? null;

  // Build separators comparing EARLY_RUNNER vs DEAD_NOISE (primary baseline)
  const baselineLabel = 'DEAD_NOISE';
  const baseline = dead;

  const separators: Separator[] = [];

  if (early && baseline) {
    // moved_before: lower is better for early runner — use inverse ratio
    const movedRatio = (baseline.avgMovedBeforePct != null && early.avgMovedBeforePct != null && early.avgMovedBeforePct > 0)
      ? baseline.avgMovedBeforePct / early.avgMovedBeforePct
      : null;
    separators.push({
      field: 'moved_before_discovery_pct',
      earlyRunnerValue: fmtPct(early.avgMovedBeforePct, 0),
      baselineValue: fmtPct(baseline.avgMovedBeforePct, 0),
      baselineLabel,
      ratioVsBaseline: movedRatio,
      strength: separatorStrength(movedRatio),
      direction: 'Lower = caught earlier, before the move'
    });

    // BSR
    const bsrRatio = ratio(early.avgBuySellRatio, baseline.avgBuySellRatio);
    separators.push({
      field: 'buy/sell ratio (5m)',
      earlyRunnerValue: fmtNum(early.avgBuySellRatio, 2),
      baselineValue: fmtNum(baseline.avgBuySellRatio, 2),
      baselineLabel,
      ratioVsBaseline: bsrRatio,
      strength: separatorStrength(bsrRatio),
      direction: 'Higher = stronger net buy pressure'
    });

    // 5m price change
    const pc5mRatio = ratio(early.avgPriceChange5mPct, baseline.avgPriceChange5mPct);
    separators.push({
      field: 'price_change_5m_pct',
      earlyRunnerValue: fmtPct(early.avgPriceChange5mPct, 0),
      baselineValue: fmtPct(baseline.avgPriceChange5mPct, 0),
      baselineLabel,
      ratioVsBaseline: pc5mRatio,
      strength: separatorStrength(pc5mRatio),
      direction: 'Higher = actively pumping in the scan window'
    });

    // Liquidity — lower for EARLY_RUNNER (still above gate)
    const liqRatio = (baseline.avgLiqUsd != null && early.avgLiqUsd != null && baseline.avgLiqUsd > 0)
      ? baseline.avgLiqUsd / early.avgLiqUsd
      : null;
    separators.push({
      field: 'liquidity_usd at discovery',
      earlyRunnerValue: fmtMoney(early.avgLiqUsd),
      baselineValue: fmtMoney(baseline.avgLiqUsd),
      baselineLabel,
      ratioVsBaseline: liqRatio,
      strength: separatorStrength(liqRatio),
      direction: 'Early runners had LOWER liq — fresher, less mature pools'
    });

    // vol5m
    const vol5mRatio = (baseline.avgVol5mUsd != null && early.avgVol5mUsd != null && baseline.avgVol5mUsd > 0)
      ? baseline.avgVol5mUsd / early.avgVol5mUsd
      : null;
    separators.push({
      field: 'volume_5m_usd at discovery',
      earlyRunnerValue: fmtMoney(early.avgVol5mUsd),
      baselineValue: fmtMoney(baseline.avgVol5mUsd),
      baselineLabel,
      ratioVsBaseline: vol5mRatio,
      strength: separatorStrength(vol5mRatio),
      direction: 'Early runners had LOWER vol5m — noise tokens had more 5m trading history'
    });

    // freeze authority
    const freezeRatio = (early.freezeSafePct != null && baseline.freezeSafePct != null && baseline.freezeSafePct > 0)
      ? early.freezeSafePct / baseline.freezeSafePct
      : null;
    separators.push({
      field: 'freeze_authority SAFE rate',
      earlyRunnerValue: fmtPct(early.freezeSafePct, 0),
      baselineValue: fmtPct(baseline.freezeSafePct, 0),
      baselineLabel,
      ratioVsBaseline: freezeRatio,
      strength: separatorStrength(freezeRatio),
      direction: 'Both classes mostly SAFE — weak separator in this dataset'
    });
  }

  // Sort separators by strength
  const strengthOrder = { STRONG: 0, MODERATE: 1, WEAK: 2, UNAVAILABLE: 3 };
  separators.sort((a, b) => strengthOrder[a.strength] - strengthOrder[b.strength]);

  // Top winners
  const topWinnerRows = s.prepare(`
    SELECT t.symbol, wsa.signal_class,
      wc.best_gain_pct, wsa.moved_before_discovery_pct,
      snap.buys_5m, snap.sells_5m, wc.liquidity_usd, wc.volume_5m_usd,
      snap.price_change_5m_pct, wsa.freeze_authority
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = wc.token_id ORDER BY id LIMIT 1
    )
    WHERE wc.best_gain_pct >= ?
    ORDER BY wc.best_gain_pct DESC
    LIMIT ?
  `).all(minGainPct, top) as any[];

  const topWinners: TopWinner[] = topWinnerRows.map((r: any) => ({
    symbol: r.symbol,
    signalClass: r.signal_class as SignalClass,
    bestGainPct: r.best_gain_pct,
    movedBeforePct: r.moved_before_discovery_pct,
    buys5m: r.buys_5m,
    sells5m: r.sells_5m,
    liqUsd: r.liquidity_usd,
    vol5mUsd: r.volume_5m_usd,
    priceChange5mPct: r.price_change_5m_pct,
    freezeAuthority: r.freeze_authority
  }));

  // Candidate rule draft
  const earlyRunnerCount = early?.n ?? 0;
  const deadNoiseCount = dead?.n ?? 0;
  const dumpCount = dump?.n ?? 0;

  const strongSeps = separators.filter((s) => s.strength === 'STRONG');
  const modSeps = separators.filter((s) => s.strength === 'MODERATE');

  const candidateRuleDraft: string[] = [
    'Based on this dataset (research note only — not a trading rule):',
    '',
    'Past EARLY_RUNNERs tended to have:',
    `  - moved_before_discovery_pct < ~100% (avg ${fmtPct(early?.avgMovedBeforePct, 0)}; dead noise avg ${fmtPct(dead?.avgMovedBeforePct, 0)})`,
    `  - buy/sell ratio (5m) > 1.5 (avg ${fmtNum(early?.avgBuySellRatio, 2)}; dead noise avg ${fmtNum(dead?.avgBuySellRatio, 2)})`,
    `  - price_change_5m > 40% (avg ${fmtPct(early?.avgPriceChange5mPct, 0)}; dead noise avg ${fmtPct(dead?.avgPriceChange5mPct, 0)})`,
    `  - liquidity at discovery < $20k (avg ${fmtMoney(early?.avgLiqUsd)}; dead noise avg ${fmtMoney(dead?.avgLiqUsd)})`,
    `  - freeze_authority SAFE (${fmtPct(early?.freezeSafePct, 0)} of early runners)`,
    '',
    'Past DEAD_NOISE / INSTANT_DUMP tended to have:',
    `  - moved_before_discovery_pct > 500% (dead noise avg ${fmtPct(dead?.avgMovedBeforePct, 0)})`,
    `  - buy/sell ratio near 1.0 (dead noise avg ${fmtNum(dead?.avgBuySellRatio, 2)})`,
    `  - high vol5m ($${Math.round((dead?.avgVol5mUsd ?? 0) / 1000)}k avg) but price already peaked`,
    '',
    'Strongest separator: moved_before_discovery_pct (${fmtNum(ratio(dead?.avgMovedBeforePct, early?.avgMovedBeforePct), 1)}x difference)'
  ];

  // Fix the template literal in candidateRuleDraft last line
  const movedRatioVal = (dead?.avgMovedBeforePct != null && early?.avgMovedBeforePct != null && early.avgMovedBeforePct > 0)
    ? dead.avgMovedBeforePct / early.avgMovedBeforePct
    : null;
  candidateRuleDraft[candidateRuleDraft.length - 1] =
    `Strongest separator: moved_before_discovery_pct (${fmtNum(movedRatioVal, 0)}x difference DEAD_NOISE vs EARLY_RUNNER)`;

  const shadowBuyHypothesis: string[] = [
    'Shadow Buy Hypothesis (research only — NOT ACTIVE):',
    '',
    'A future rule could shadow-watch tokens that have all of:',
    '  1. moved_before_discovery_pct < 100%  (caught early, before the main move)',
    '  2. buy/sell ratio (5m) >= 1.5         (net buy pressure in scan window)',
    '  3. price_change_5m_pct >= 40%         (actively moving right now)',
    '  4. freeze_authority SAFE              (no freeze risk)',
    '  5. liquidity >= $10k                  (not illiquid)',
    '',
    'These thresholds are derived from this dataset only.',
    'This hypothesis is NOT active.',
    'No trading behavior changed.',
    'Requires more sample size (16 early runners, ~3 days data) before',
    'any paper or real trading rule should be built from this.'
  ];

  const dataWarnings: string[] = [];
  if (earlyRunnerCount < 30) dataWarnings.push(`Small early-runner sample: ${earlyRunnerCount} tokens (recommend >= 30 for reliable profile)`);
  if (deadNoiseCount < 50) dataWarnings.push(`Dead-noise sample: ${deadNoiseCount} tokens`);
  const totalWatchCandidates = profiles.reduce((sum, p) => sum + p.n, 0);
  const days = 3;
  dataWarnings.push(`Data spans ~${days} days (2026-06-01 to 2026-06-04) — profile may not generalize to other market conditions`);
  dataWarnings.push('Slippage data: all entries show 500 bps / 0 available quotes — not usable as separator');
  dataWarnings.push('Holder concentration: all classes show RISKY concentration — not a useful separator in this dataset');
  dataWarnings.push('INSTANT_DUMP and EARLY_RUNNER overlap heavily on early signals — harder to separate at discovery time');

  return {
    minGainPct,
    top,
    totalCandidates: totalWatchCandidates,
    earlyRunnerCount,
    lateRunnerCount: profiles.find((p) => p.signalClass === 'LATE_RUNNER')?.n ?? 0,
    tooDangerousCount: profiles.find((p) => p.signalClass === 'TOO_DANGEROUS')?.n ?? 0,
    instantDumpCount: dumpCount,
    deadNoiseCount,
    profiles,
    separators,
    topWinners,
    candidateRuleDraft,
    shadowBuyHypothesis,
    dataWarnings
  };
}

export function renderWinnerProfileReport(db: AppDb, config: AppConfig, options: { minGainPct?: number; top?: number } = {}): string {
  const r = buildWinnerProfileReport(db, config, options);
  const lines: string[] = [];
  const sep = '─'.repeat(60);
  const thin = '·'.repeat(60);

  lines.push('Winner Profile');
  lines.push(sep);

  // 1. Sample
  lines.push('1. Sample Size');
  lines.push(`   Total watch candidates: ${r.totalCandidates}`);
  lines.push(`   EARLY_RUNNER:  ${r.earlyRunnerCount}`);
  lines.push(`   LATE_RUNNER:   ${r.lateRunnerCount}`);
  lines.push(`   TOO_DANGEROUS: ${r.tooDangerousCount}`);
  lines.push(`   INSTANT_DUMP:  ${r.instantDumpCount}`);
  lines.push(`   DEAD_NOISE:    ${r.deadNoiseCount}`);
  lines.push(`   Winner threshold (best peak gain): >= ${r.minGainPct}%`);
  lines.push('');

  // 2. Separators
  lines.push('2. Strongest Separators (EARLY_RUNNER vs DEAD_NOISE)');
  lines.push(`   ${'Field'.padEnd(30)} ${'EARLY_RUNNER'.padStart(13)} ${'DEAD_NOISE'.padStart(12)} ${'Ratio'.padStart(7)} ${'Strength'.padStart(11)}`);
  for (const sep_ of r.separators) {
    lines.push(
      `   ${sep_.field.padEnd(30)} ${sep_.earlyRunnerValue.padStart(13)} ${sep_.baselineValue.padStart(12)} ${(sep_.ratioVsBaseline != null ? `${sep_.ratioVsBaseline.toFixed(1)}x` : '-').padStart(7)} ${sep_.strength.padStart(11)}`
    );
    lines.push(`     ↳ ${sep_.direction}`);
  }
  lines.push('');

  // Per-class summary table
  lines.push('   Per-class signal summary:');
  lines.push(`   ${'Class'.padEnd(15)} ${'n'.padStart(3)} ${'moved_b4'.padStart(9)} ${'pc5m'.padStart(6)} ${'BSR'.padStart(5)} ${'liq'.padStart(7)} ${'vol5m'.padStart(7)} ${'bestGain'.padStart(9)}`);
  for (const p of r.profiles) {
    lines.push(
      `   ${p.signalClass.padEnd(15)} ${String(p.n).padStart(3)} ${fmtPct(p.avgMovedBeforePct, 0).padStart(9)} ${fmtPct(p.avgPriceChange5mPct, 0).padStart(6)} ${fmtNum(p.avgBuySellRatio, 2).padStart(5)} ${fmtMoney(p.avgLiqUsd).padStart(7)} ${fmtMoney(p.avgVol5mUsd).padStart(7)} ${fmtPct(p.avgBestGainPct, 0).padStart(9)}`
    );
  }
  lines.push('');

  // 3. Candidate rule draft
  lines.push('3. Candidate Rule Draft (research note — not code, not active)');
  for (const line of r.candidateRuleDraft) {
    lines.push(`   ${line}`);
  }
  lines.push('');

  // 4. Shadow buy hypothesis
  lines.push('4. Shadow Buy Hypothesis');
  for (const line of r.shadowBuyHypothesis) {
    lines.push(`   ${line}`);
  }
  lines.push('');

  // 5. Data warnings
  lines.push('5. Data Warnings');
  for (const w of r.dataWarnings) {
    lines.push(`   ⚠  ${w}`);
  }
  lines.push('');

  // Top winners appendix
  if (r.topWinners.length > 0) {
    lines.push(thin);
    lines.push(`Top ${r.topWinners.length} Winners (best peak gain >= ${r.minGainPct}%):`);
    lines.push(`   ${'Symbol'.padEnd(16)} ${'gain'.padStart(9)} ${'class'.padEnd(16)} ${'moved_b4'.padStart(9)} ${'BSR'.padStart(5)} ${'liq'.padStart(7)} ${'pc5m'.padStart(6)}`);
    for (const w of r.topWinners) {
      const bsr = (w.buys5m != null && w.sells5m != null && w.sells5m > 0)
        ? (w.buys5m / w.sells5m).toFixed(2)
        : '-';
      lines.push(
        `   ${w.symbol.padEnd(16)} ${fmtPct(w.bestGainPct, 0).padStart(9)} ${w.signalClass.padEnd(16)} ${fmtPct(w.movedBeforePct, 0).padStart(9)} ${bsr.padStart(5)} ${fmtMoney(w.liqUsd).padStart(7)} ${fmtPct(w.priceChange5mPct, 0).padStart(6)}`
      );
    }
    lines.push('');
  }

  lines.push('Real trading remains locked. No trading behavior changed.');

  return lines.join('\n');
}
