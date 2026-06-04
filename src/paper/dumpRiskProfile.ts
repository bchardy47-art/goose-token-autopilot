import type { AppDb } from '../db';
import type { AppConfig } from '../types';

const DEFAULT_TOP = 10;
const DEFAULT_MIN_GAIN = 50;
const MIN_SAMPLE = 5;

function avg(vs: number[]): number | null {
  return vs.length === 0 ? null : vs.reduce((a, b) => a + b, 0) / vs.length;
}

function median(vs: number[]): number | null {
  if (vs.length === 0) return null;
  const s = [...vs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function fmtPct(v: number | null | undefined, d = 1): string {
  if (v == null) return '-';
  return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
}

function fmtNum(v: number | null | undefined, d = 2): string {
  return v == null ? '-' : v.toFixed(d);
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '-';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function fmtMin(v: number | null | undefined): string {
  if (v == null) return '-';
  return v >= 60 ? `${(v / 60).toFixed(1)}h` : `${v.toFixed(0)}m`;
}

function formatVal(v: number | null, unit: string): string {
  if (v == null) return '-';
  if (unit === '%') return fmtPct(v, 0);
  if (unit === 'x') return fmtNum(v, 2);
  if (unit === '$') return fmtMoney(v);
  if (unit === 'min') return fmtMin(v);
  return fmtNum(v);
}

function sepStrength(ratio: number | null): 'STRONG' | 'MODERATE' | 'WEAK' | 'UNAVAILABLE' {
  if (ratio == null) return 'UNAVAILABLE';
  if (Math.abs(ratio) >= 3) return 'STRONG';
  if (Math.abs(ratio) >= 1.5) return 'MODERATE';
  return 'WEAK';
}

// Strength based on absolute point difference (for fields where ratio is meaningless, e.g. sign flips)
function sepStrengthDiff(diff: number | null): 'STRONG' | 'MODERATE' | 'WEAK' | 'UNAVAILABLE' {
  if (diff == null) return 'UNAVAILABLE';
  const a = Math.abs(diff);
  if (a >= 50) return 'STRONG';
  if (a >= 20) return 'MODERATE';
  return 'WEAK';
}

interface Row {
  tokenId: number;
  symbol: string;
  signalClass: 'EARLY_RUNNER' | 'INSTANT_DUMP';
  movedBeforePct: number | null;
  pc5m: number | null;
  pc1h: number | null;
  buys5m: number | null;
  sells5m: number | null;
  bsr: number | null;
  vol5m: number | null;
  liq: number | null;
  poolAgeMin: number | null;
  bestGain: number | null;
  worstDraw: number | null;
  currentReturn: number | null;
  peakGap: number | null;
  freezeAuth: string | null;
  mintAuth: string | null;
  sellQuote: string | null;
}

export interface Separator {
  field: string;
  unit: string;
  isOutcome: boolean;
  earlyAvg: number | null;
  earlyMed: number | null;
  dumpAvg: number | null;
  dumpMed: number | null;
  ratio: number | null;
  strength: 'STRONG' | 'MODERATE' | 'WEAK' | 'UNAVAILABLE';
  direction: string;
  overlapNote: string;
}

export interface DumpRiskProfileReport {
  earlyRunnerCount: number;
  instantDumpCount: number;
  minGainPct: number;
  separators: Separator[];
  instantDumpExamples: Row[];
  earlyRunnerExamples: Row[];
  ruleNotes: string[];
  falsePositiveWarnings: string[];
  dataWarnings: string[];
}

function makeSep(
  field: string,
  unit: string,
  isOutcome: boolean,
  earlyVals: number[],
  dumpVals: number[],
  ratioFn: (e: number, d: number) => number | null,
  direction: string,
  overlapNote: string
): Separator {
  const earlyAvg = avg(earlyVals);
  const earlyMed = median(earlyVals);
  const dumpAvg = avg(dumpVals);
  const dumpMed = median(dumpVals);
  const ratio = earlyAvg != null && dumpAvg != null ? ratioFn(earlyAvg, dumpAvg) : null;
  return { field, unit, isOutcome, earlyAvg, earlyMed, dumpAvg, dumpMed, ratio, strength: sepStrength(ratio), direction, overlapNote };
}

function makeSepDiff(
  field: string,
  unit: string,
  isOutcome: boolean,
  earlyVals: number[],
  dumpVals: number[],
  direction: string,
  overlapNote: string
): Separator {
  const earlyAvg = avg(earlyVals);
  const earlyMed = median(earlyVals);
  const dumpAvg = avg(dumpVals);
  const dumpMed = median(dumpVals);
  const diff = earlyAvg != null && dumpAvg != null ? dumpAvg - earlyAvg : null;
  return {
    field, unit, isOutcome, earlyAvg, earlyMed, dumpAvg, dumpMed,
    ratio: diff,
    strength: sepStrengthDiff(diff),
    direction,
    overlapNote
  };
}

function catRate(rows: Row[], fn: (r: Row) => boolean): number | null {
  if (rows.length === 0) return null;
  return (rows.filter(fn).length / rows.length) * 100;
}

export function buildDumpRiskProfileReport(
  db: AppDb,
  _config: AppConfig,
  options: { limit?: number; top?: number; minGain?: number } = {}
): DumpRiskProfileReport {
  const top = options.top ?? DEFAULT_TOP;
  const minGainPct = options.minGain ?? DEFAULT_MIN_GAIN;
  const s = db.sqlite;

  const rawRows = s.prepare(`
    SELECT
      wc.token_id,
      t.symbol,
      wsa.signal_class,
      wsa.moved_before_discovery_pct,
      wsa.freeze_authority,
      wsa.mint_authority,
      wsa.sell_quote_available,
      snap.price_change_5m_pct,
      snap.price_change_1h_pct,
      snap.buys_5m,
      snap.sells_5m,
      wc.liquidity_usd,
      wc.volume_5m_usd,
      wc.best_gain_pct,
      wc.worst_drawdown_pct,
      wc.entry_price_usd,
      wc.latest_price_usd,
      CAST((julianday(wc.created_at) - julianday(t.created_at)) * 1440 AS REAL) as pool_age_minutes
    FROM watch_only_candidates wc
    JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    JOIN tokens t ON t.id = wc.token_id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = wc.token_id ORDER BY id LIMIT 1
    )
    WHERE wsa.signal_class IN ('EARLY_RUNNER', 'INSTANT_DUMP')
    ORDER BY wc.created_at DESC
  `).all() as any[];

  const rows: Row[] = rawRows.map((r: any) => {
    const bsr = r.buys_5m != null && r.sells_5m != null && r.sells_5m > 0 ? r.buys_5m / r.sells_5m : null;
    const currentReturn =
      r.entry_price_usd != null && r.latest_price_usd != null && r.entry_price_usd > 0
        ? ((r.latest_price_usd - r.entry_price_usd) / r.entry_price_usd) * 100
        : null;
    const peakGap = r.best_gain_pct != null && currentReturn != null ? r.best_gain_pct - currentReturn : null;
    const poolAgeMin = r.pool_age_minutes != null && r.pool_age_minutes >= 0 ? r.pool_age_minutes : null;
    return {
      tokenId: r.token_id,
      symbol: r.symbol,
      signalClass: r.signal_class as 'EARLY_RUNNER' | 'INSTANT_DUMP',
      movedBeforePct: r.moved_before_discovery_pct,
      pc5m: r.price_change_5m_pct,
      pc1h: r.price_change_1h_pct,
      buys5m: r.buys_5m,
      sells5m: r.sells_5m,
      bsr,
      vol5m: r.volume_5m_usd,
      liq: r.liquidity_usd,
      poolAgeMin,
      bestGain: r.best_gain_pct,
      worstDraw: r.worst_drawdown_pct,
      currentReturn,
      peakGap,
      freezeAuth: r.freeze_authority,
      mintAuth: r.mint_authority,
      sellQuote: r.sell_quote_available
    };
  });

  const early = rows.filter((r) => r.signalClass === 'EARLY_RUNNER');
  const dump = rows.filter((r) => r.signalClass === 'INSTANT_DUMP');

  const ev = <K extends keyof Row>(fn: (r: Row) => number | null) =>
    early.map(fn).filter((v): v is number => v != null);
  const dv = <K extends keyof Row>(fn: (r: Row) => number | null) =>
    dump.map(fn).filter((v): v is number => v != null);

  // ── Entry signals ──────────────────────────────────────────────────
  const sep_moved = makeSep(
    'moved_before_discovery_pct', '%', false,
    ev((r) => r.movedBeforePct), dv((r) => r.movedBeforePct),
    (e, d) => e > 0 ? d / e : null,
    'Higher INSTANT_DUMP ratio = more pre-moved before scan discovered it',
    'Both classes caught early — expect overlap here'
  );

  const sep_bsr = makeSep(
    'buy/sell ratio 5m', 'x', false,
    ev((r) => r.bsr), dv((r) => r.bsr),
    (e, d) => d > 0 ? e / d : null,
    'Higher early ratio = stronger net buy pressure in EARLY_RUNNER',
    'INSTANT_DUMP may also show high BSR during its pump phase — deceptive at entry'
  );

  const sep_pc5m = makeSep(
    'price_change_5m_pct', '%', false,
    ev((r) => r.pc5m), dv((r) => r.pc5m),
    (e, d) => e > 0 && d > 0 ? d / e : null,
    'Extreme 5m spike may favor INSTANT_DUMP (spike-then-collapse pattern)',
    'Range overlap is expected — extreme values only slightly predictive'
  );

  const sep_pc1h = makeSep(
    'price_change_1h_pct', '%', false,
    ev((r) => r.pc1h), dv((r) => r.pc1h),
    (e, d) => e != null && d != null && e !== 0 ? d / e : null,
    'INSTANT_DUMP may show larger 1h move if discovered mid-pump',
    'May not be available for very new tokens; interpret with caution'
  );

  const sep_age = makeSep(
    'pool_age_at_discovery_min', 'min', false,
    ev((r) => r.poolAgeMin), dv((r) => r.poolAgeMin),
    (e, d) => d > 0 ? e / d : null,
    'Older pools at discovery may indicate more stable tokens',
    'Pool age data may be incomplete; low confidence separator'
  );

  const sep_liq = makeSep(
    'liquidity_usd', '$', false,
    ev((r) => r.liq), dv((r) => r.liq),
    (e, d) => d > 0 ? e / d : null,
    'Higher liq in EARLY_RUNNER may indicate a more stable pool',
    'Both classes show similar liq ranges — low separation power expected'
  );

  const sep_vol5m = makeSep(
    'volume_5m_usd', '$', false,
    ev((r) => r.vol5m), dv((r) => r.vol5m),
    (e, d) => d > 0 ? e / d : null,
    'Volume alone is not a reliable separator in either direction',
    'High vol appears in both classes; no directional consensus'
  );

  // Categorical: freeze authority SAFE rate (stored as column-wide %)
  const earlyFreezeRate = catRate(early, (r) => r.freezeAuth === 'SAFE');
  const dumpFreezeRate = catRate(dump, (r) => r.freezeAuth === 'SAFE');
  const freezeRatio = earlyFreezeRate != null && dumpFreezeRate != null && dumpFreezeRate > 0
    ? earlyFreezeRate / dumpFreezeRate : null;
  const sep_freeze: Separator = {
    field: 'freeze_authority SAFE %', unit: '%', isOutcome: false,
    earlyAvg: earlyFreezeRate, earlyMed: null,
    dumpAvg: dumpFreezeRate, dumpMed: null,
    ratio: freezeRatio,
    strength: sepStrength(freezeRatio),
    direction: 'Higher SAFE rate = lower freeze-rug risk',
    overlapNote: 'Prior data: both classes mostly SAFE — not a useful separator in this dataset'
  };

  // Categorical: mint authority SAFE rate
  const earlyMintRate = catRate(early, (r) => r.mintAuth === 'SAFE');
  const dumpMintRate = catRate(dump, (r) => r.mintAuth === 'SAFE');
  const mintRatio = earlyMintRate != null && dumpMintRate != null && dumpMintRate > 0
    ? earlyMintRate / dumpMintRate : null;
  const sep_mint: Separator = {
    field: 'mint_authority SAFE %', unit: '%', isOutcome: false,
    earlyAvg: earlyMintRate, earlyMed: null,
    dumpAvg: dumpMintRate, dumpMed: null,
    ratio: mintRatio,
    strength: sepStrength(mintRatio),
    direction: 'Higher SAFE rate = mint cannot inflate supply',
    overlapNote: 'Likely overlaps — confirm with data'
  };

  // Categorical: sell quote available
  const earlySellRate = catRate(early, (r) => r.sellQuote === 'AVAILABLE');
  const dumpSellRate = catRate(dump, (r) => r.sellQuote === 'AVAILABLE');
  const sellRatio = earlySellRate != null && dumpSellRate != null && dumpSellRate > 0
    ? earlySellRate / dumpSellRate : null;
  const sep_sell: Separator = {
    field: 'sell_quote AVAILABLE %', unit: '%', isOutcome: false,
    earlyAvg: earlySellRate, earlyMed: null,
    dumpAvg: dumpSellRate, dumpMed: null,
    ratio: sellRatio,
    strength: sepStrength(sellRatio),
    direction: 'Higher AVAILABLE rate = token was sellable via quote check',
    overlapNote: 'All entries may show 0 available quotes — not usable per prior study'
  };

  // Winner rate (best_gain >= minGain) — a weak entry-time predictor if we had a crystal ball
  const earlyWinRate = catRate(early, (r) => (r.bestGain ?? -1) >= minGainPct);
  const dumpWinRate = catRate(dump, (r) => (r.bestGain ?? -1) >= minGainPct);
  const winRatio = earlyWinRate != null && dumpWinRate != null && dumpWinRate > 0
    ? earlyWinRate / dumpWinRate : null;
  const sep_win: Separator = {
    field: `winner_rate (peak >= ${minGainPct}%)`, unit: '%', isOutcome: true,
    earlyAvg: earlyWinRate, earlyMed: null,
    dumpAvg: dumpWinRate, dumpMed: null,
    ratio: winRatio,
    strength: sepStrength(winRatio),
    direction: `EARLY_RUNNER fraction that hit >${minGainPct}% peak; INSTANT_DUMP fraction is expected lower`,
    overlapNote: 'Outcome field — not observable at entry time'
  };

  // ── Outcome signals ────────────────────────────────────────────────
  const sep_worst = makeSep(
    'worst_drawdown_pct', '%', true,
    ev((r) => r.worstDraw), dv((r) => r.worstDraw),
    (e, d) => e !== 0 && e < 0 && d < 0 ? Math.abs(d) / Math.abs(e) : null,
    'INSTANT_DUMP drawdown far worse than EARLY_RUNNER — strongest post-discovery separator',
    'Outcome field — not observable at entry; needs price tracking after discovery'
  );

  const sep_best = makeSep(
    'best_gain_pct', '%', true,
    ev((r) => r.bestGain), dv((r) => r.bestGain),
    (e, d) => d > 0 ? e / d : null,
    'EARLY_RUNNER sustains higher peak gains; INSTANT_DUMP peak is short-lived',
    'Outcome field — peak may look similar if caught at top of INSTANT_DUMP pump'
  );

  const sep_gap = makeSep(
    'peak_to_current_gap', '%', true,
    ev((r) => r.peakGap), dv((r) => r.peakGap),
    (e, d) => e > 0 ? d / e : null,
    'INSTANT_DUMP shows large gap = huge spike then crash; EARLY_RUNNER gap is smaller',
    'Outcome field — requires multiple price snapshots; may be 0 if only 1 refresh'
  );

  const sep_cur = makeSepDiff(
    'current_return_pct', '%', true,
    ev((r) => r.currentReturn), dv((r) => r.currentReturn),
    'INSTANT_DUMP current return much lower vs entry than EARLY_RUNNER',
    'Outcome field — ratio meaningless when signs differ; using point-difference strength'
  );

  // Sort: entry signals by strength, then outcome signals by strength
  const strengthRank = { STRONG: 0, MODERATE: 1, WEAK: 2, UNAVAILABLE: 3 };
  const entrySeps = [sep_moved, sep_bsr, sep_pc5m, sep_pc1h, sep_age, sep_liq, sep_vol5m, sep_freeze, sep_mint, sep_sell]
    .sort((a, b) => strengthRank[a.strength] - strengthRank[b.strength]);
  const outcomeSeps = [sep_win, sep_worst, sep_best, sep_gap, sep_cur]
    .sort((a, b) => strengthRank[a.strength] - strengthRank[b.strength]);
  const separators = [...entrySeps, ...outcomeSeps];

  // Examples
  const instantDumpExamples = [...dump]
    .sort((a, b) => (a.worstDraw ?? 0) - (b.worstDraw ?? 0))
    .slice(0, top);

  const earlyRunnerExamples = [...early]
    .sort((a, b) => (b.bestGain ?? -Infinity) - (a.bestGain ?? -Infinity))
    .slice(0, top);

  const ruleNotes = [
    'Dump-Risk Rule Draft (research note only — NOT ACTIVE):',
    '',
    'A candidate may carry INSTANT_DUMP risk if at-discovery it shows:',
    '  - Extreme 5m price spike (pc5m >> 200%) — spike-then-collapse signature',
    '  - Very short pool age — less time for natural price discovery',
    '  - Low liquidity with extremely high vol5m — early pump-drain setup',
    '',
    'Post-discovery confirmation of dump (outcome signals, not filterable at entry):',
    '  - worst_drawdown_pct far below EARLY_RUNNER average',
    '  - Large peak_to_current_gap — pumped hard then lost all gains quickly',
    '  - current_return_pct deeply negative while EARLY_RUNNER holds positive',
    '',
    'NOT ACTIVE. Core problem: at entry, INSTANT_DUMP and EARLY_RUNNER look nearly',
    'identical on most fields. Separation requires price tracking after discovery.',
    'Requires more data and controlled study before any filtering rule is built.'
  ];

  const falsePositiveWarnings = [
    'buy/sell ratio 5m: INSTANT_DUMP may show high BSR during the pump phase — identical to EARLY_RUNNER at entry.',
    'price_change_5m_pct: INSTANT_DUMP spike can equal or exceed EARLY_RUNNER 5m momentum at discovery.',
    'moved_before_discovery_pct: Both classes may be caught early before the main move — same value range.',
    'freeze/mint authority: Prior data shows both classes mostly SAFE — not a reliable separator.',
    'sell_quote_available: All entries in prior study showed 0 available quotes — unusable as separator.',
    'Summary: No single entry signal reliably separates INSTANT_DUMP from EARLY_RUNNER at discovery.',
    'Best current approach: track price decay rate in the first 15–30 min post-discovery.'
  ];

  const dataWarnings: string[] = [];
  if (early.length < MIN_SAMPLE) {
    dataWarnings.push(`EARLY_RUNNER sample: ${early.length} — below minimum of ${MIN_SAMPLE} for reliable comparison.`);
  }
  if (dump.length < MIN_SAMPLE) {
    dataWarnings.push(`INSTANT_DUMP sample: ${dump.length} — below minimum of ${MIN_SAMPLE} for reliable comparison.`);
  }
  if (early.length > 0 || dump.length > 0) {
    const ec = early.filter((r) => r.currentReturn != null).length;
    const dc = dump.filter((r) => r.currentReturn != null).length;
    dataWarnings.push(`Current return available: EARLY_RUNNER ${ec}/${early.length}, INSTANT_DUMP ${dc}/${dump.length}.`);
    dataWarnings.push('Outcome signals improve with more token:watch-refresh cycles; entry signals are from first snapshot only.');
    dataWarnings.push('Data spans a short window. Profiles may not generalize to different market conditions.');
  }

  return {
    earlyRunnerCount: early.length,
    instantDumpCount: dump.length,
    minGainPct,
    separators,
    instantDumpExamples,
    earlyRunnerExamples,
    ruleNotes,
    falsePositiveWarnings,
    dataWarnings
  };
}

export function renderDumpRiskProfileReport(
  db: AppDb,
  config: AppConfig,
  options: { limit?: number; top?: number; minGain?: number } = {}
): string {
  const r = buildDumpRiskProfileReport(db, config, options);
  const lines: string[] = [];
  const sep = '─'.repeat(60);
  const thin = '·'.repeat(60);

  // 1. Dump Risk Profile
  lines.push('Dump Risk Profile');
  lines.push(sep);
  lines.push('1. Dump Risk Profile');
  lines.push(`   EARLY_RUNNER:  ${r.earlyRunnerCount} candidates`);
  lines.push(`   INSTANT_DUMP:  ${r.instantDumpCount} candidates`);
  lines.push(`   Winner threshold used: best_gain_pct >= ${r.minGainPct}%`);
  if (r.earlyRunnerCount < MIN_SAMPLE || r.instantDumpCount < MIN_SAMPLE) {
    lines.push('');
    lines.push('   ⚠  One or both classes have fewer than 5 candidates.');
    lines.push('   ⚠  Results below are directional only — do not draw firm conclusions.');
  }
  lines.push('');

  // 2. Strongest Dump Separators
  lines.push('2. Strongest Dump Separators (EARLY_RUNNER vs INSTANT_DUMP)');
  lines.push('');

  const FW = 32;  // field width
  const VW = 11;  // value width
  const RW = 8;   // ratio width
  const SW = 12;  // strength width

  const tableHeader = () =>
    `   ${'Field'.padEnd(FW)} ${'EARLY_RUN'.padStart(VW)} ${'INST_DUMP'.padStart(VW)} ${'Ratio'.padStart(RW)} ${'Strength'.padStart(SW)}`;

  const renderSep = (s: Separator) => {
    const eAvg = formatVal(s.earlyAvg, s.unit).padStart(VW);
    const dAvg = formatVal(s.dumpAvg, s.unit).padStart(VW);
    // For diff-based separators, show pp diff as the ratio column
    const ratioStr = s.ratio != null
      ? (s.field === 'current_return_pct' ? `${s.ratio > 0 ? '+' : ''}${s.ratio.toFixed(0)}pp` : `${s.ratio.toFixed(1)}x`)
      : '-';
    return `   ${s.field.padEnd(FW)} ${eAvg} ${dAvg} ${ratioStr.padStart(RW)} ${s.strength.padStart(SW)}`;
  };

  const renderMed = (s: Separator) => {
    if (s.earlyMed == null && s.dumpMed == null) return null;
    const em = formatVal(s.earlyMed, s.unit).padStart(VW);
    const dm = formatVal(s.dumpMed, s.unit).padStart(VW);
    return `   ${'(median)'.padEnd(FW)} ${em} ${dm}`;
  };

  const entrySeps = r.separators.filter((s) => !s.isOutcome);
  const outcomeSeps = r.separators.filter((s) => s.isOutcome);

  lines.push('   Entry signals (observable at discovery time):');
  lines.push(tableHeader());
  for (const s of entrySeps) {
    lines.push(renderSep(s));
    const med = renderMed(s);
    if (med) lines.push(med);
    lines.push(`     ↳ ${s.direction}`);
  }

  lines.push('');
  lines.push('   Outcome signals (stored after discovery — NOT observable at entry):');
  lines.push(tableHeader());
  for (const s of outcomeSeps) {
    lines.push(renderSep(s));
    const med = renderMed(s);
    if (med) lines.push(med);
    lines.push(`     ↳ ${s.direction}`);
  }
  lines.push('   Ratio column: for entry signals = earlyAvg/dumpAvg or dumpAvg/earlyAvg (noted per field).');
  lines.push('   current_return_pct ratio = pp difference (dumpAvg − earlyAvg); STRONG if |diff| >= 50pp.');
  lines.push('');

  // 3. Dump-Risk Rule Draft
  lines.push('3. Dump-Risk Rule Draft');
  for (const l of r.ruleNotes) lines.push(`   ${l}`);
  lines.push('');

  // 4. False Positive Warning
  lines.push('4. False Positive Warning');
  for (const w of r.falsePositiveWarnings) lines.push(`   ⚠  ${w}`);
  lines.push('');

  // 5. Candidate Examples
  lines.push('5. Candidate Examples');
  lines.push('');

  const exHdr = `   ${'Symbol'.padEnd(16)} ${'moved_b4'.padStart(9)} ${'pc5m'.padStart(7)} ${'BSR'.padStart(5)} ${'liq'.padStart(7)} ${'bestGain'.padStart(9)} ${'worstDraw'.padStart(10)} ${'curRet'.padStart(8)} ${'peakGap'.padStart(8)}`;

  if (r.instantDumpExamples.length > 0) {
    lines.push(`   INSTANT_DUMP (worst drawdown first, up to ${r.instantDumpExamples.length}):`);
    lines.push(exHdr);
    for (const e of r.instantDumpExamples) {
      lines.push(
        `   ${e.symbol.padEnd(16)} ${fmtPct(e.movedBeforePct, 0).padStart(9)} ${fmtPct(e.pc5m, 0).padStart(7)} ${fmtNum(e.bsr).padStart(5)} ${fmtMoney(e.liq).padStart(7)} ${fmtPct(e.bestGain, 0).padStart(9)} ${fmtPct(e.worstDraw, 0).padStart(10)} ${fmtPct(e.currentReturn, 0).padStart(8)} ${fmtPct(e.peakGap, 0).padStart(8)}`
      );
    }
    lines.push('');
  } else {
    lines.push('   No INSTANT_DUMP candidates found in DB.');
    lines.push('');
  }

  if (r.earlyRunnerExamples.length > 0) {
    lines.push(`   EARLY_RUNNER (best peak gain first, up to ${r.earlyRunnerExamples.length}):`);
    lines.push(exHdr);
    for (const e of r.earlyRunnerExamples) {
      lines.push(
        `   ${e.symbol.padEnd(16)} ${fmtPct(e.movedBeforePct, 0).padStart(9)} ${fmtPct(e.pc5m, 0).padStart(7)} ${fmtNum(e.bsr).padStart(5)} ${fmtMoney(e.liq).padStart(7)} ${fmtPct(e.bestGain, 0).padStart(9)} ${fmtPct(e.worstDraw, 0).padStart(10)} ${fmtPct(e.currentReturn, 0).padStart(8)} ${fmtPct(e.peakGap, 0).padStart(8)}`
      );
    }
    lines.push('');
  } else {
    lines.push('   No EARLY_RUNNER candidates found in DB.');
    lines.push('');
  }

  // Data warnings
  if (r.dataWarnings.length > 0) {
    lines.push(thin);
    lines.push('Data Warnings:');
    for (const w of r.dataWarnings) lines.push(`   ⚠  ${w}`);
    lines.push('');
  }

  // 6. Safety Footer
  lines.push(sep);
  lines.push('6. Safety');
  lines.push('   Report only.');
  lines.push('   No trading behavior changed.');
  lines.push('   Hypothesis not active.');
  lines.push('   Requires forward validation before paper or real trading.');

  return lines.join('\n');
}
