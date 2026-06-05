import type { AppDb } from '../db';
import type { AppConfig, TokenCandidate } from '../types';

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 200;
const DEFAULT_MIN_GAIN = 30;
// Chase entry thresholds — same values as the shadow rule defaults so "chase" = "would have failed these rules"
const DEFAULT_CHASE_MOVED_PCT = 25;   // movedBeforeDiscoveryPct >= this → chase entry
const DEFAULT_CHASE_PC5M_PCT = 75;    // priceChange5mPct > this → already-spiked entry

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
  return `$${v.toFixed(2)}`;
}

function fmtNum(v: number | null | undefined, d = 2): string {
  return v == null ? '-' : v.toFixed(d);
}

function calcBsr(snap: TokenCandidate): number {
  return (snap.buys5m ?? 0) / Math.max(1, snap.sells5m ?? 0);
}

// What signal drove the "chase" classification for this candidate
type ChaseSignal = 'movedBeforeDiscovery' | 'pc5m-spike' | 'both';

interface ChaseCandidateRow {
  candidateId: number;
  tokenId: number;
  symbol: string;
  source: string;
  mint: string;
  createdAt: string;
  signalClass: string | null;
  bestGainPct: number | null;
  worstDrawdownPct: number | null;
  movedBeforeDiscoveryPct: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  priceChange5mPct: number | null;
  buySellRatio: number;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  sellQuoteAvailable: string | null;
  chaseSignal: ChaseSignal;
  isRunner: boolean;   // best_gain_pct >= minGain
}

interface NonChaseCandidateRow {
  signalClass: string | null;
  bestGainPct: number | null;
  worstDrawdownPct: number | null;
  movedBeforeDiscoveryPct: number | null;
  liquidityUsd: number | null;
  priceChange5mPct: number | null;
  buySellRatio: number;
}

interface OutcomeStats {
  count: number;
  avgGain: number | null;
  medGain: number | null;
  avgMoved: number | null;
  avgPc5m: number | null;
  avgLiq: number | null;
  avgBsr: number | null;
  runnerCount: number;   // bestGainPct >= minGain
  dumpCount: number;     // INSTANT_DUMP
  noiseCount: number;    // DEAD_NOISE or null
}

export interface ChaseWatchReport {
  windowHours: number;
  limit: number;
  minGainPct: number;
  chaseMovedPct: number;
  chasePc5mPct: number;
  cutoff: string;
  totalScanned: number;
  totalWithSnapshot: number;
  noSnapshot: number;
  chaseCandidateCount: number;
  nonChaseCandidateCount: number;
  chaseRunners: ChaseCandidateRow[];
  chaseNonRunners: ChaseCandidateRow[];
  chaseStats: OutcomeStats;
  nonChaseStats: OutcomeStats;
  chaseSignalBreakdown: Array<{ signal: ChaseSignal; count: number; runnerCount: number; runnerPct: number }>;
  dataWarnings: string[];
  noTradingBehaviorChanged: true;
}

function buildOutcomeStats(rows: Array<{
  bestGainPct: number | null;
  worstDrawdownPct: number | null;
  movedBeforeDiscoveryPct: number | null;
  liquidityUsd: number | null;
  priceChange5mPct: number | null;
  buySellRatio: number;
  signalClass: string | null;
}>, minGain: number): OutcomeStats {
  const pick = (vals: Array<number | null>) => vals.filter((v): v is number => v != null);
  return {
    count: rows.length,
    avgGain: avg(pick(rows.map((r) => r.bestGainPct))),
    medGain: median(pick(rows.map((r) => r.bestGainPct))),
    avgMoved: avg(pick(rows.map((r) => r.movedBeforeDiscoveryPct))),
    avgPc5m: avg(pick(rows.map((r) => r.priceChange5mPct))),
    avgLiq: avg(pick(rows.map((r) => r.liquidityUsd))),
    avgBsr: avg(pick(rows.map((r) => r.buySellRatio))),
    runnerCount: rows.filter((r) => (r.bestGainPct ?? 0) >= minGain).length,
    dumpCount: rows.filter((r) => r.signalClass === 'INSTANT_DUMP').length,
    noiseCount: rows.filter((r) => r.signalClass === 'DEAD_NOISE' || r.signalClass == null).length,
  };
}

export function buildChaseWatchReport(
  db: AppDb,
  _config: AppConfig,
  options: {
    windowHours?: number;
    limit?: number;
    minGain?: number;
    chaseMovedPct?: number;
    chasePc5mPct?: number;
  } = {}
): ChaseWatchReport {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const minGain = options.minGain ?? DEFAULT_MIN_GAIN;
  const chaseMovedPct = options.chaseMovedPct ?? DEFAULT_CHASE_MOVED_PCT;
  const chasePc5mPct = options.chasePc5mPct ?? DEFAULT_CHASE_PC5M_PCT;
  const sql = db.sqlite;

  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const rawRows = sql.prepare(`
    SELECT
      wc.id              AS candidate_id,
      wc.token_id,
      wc.created_at,
      wc.best_gain_pct,
      wc.worst_drawdown_pct,
      wc.liquidity_usd   AS wc_liquidity,
      wc.volume_5m_usd   AS wc_vol5m,
      t.symbol,
      t.source,
      t.mint,
      wsa.signal_class,
      wsa.moved_before_discovery_pct AS wsa_moved,
      wsa.freeze_authority           AS wsa_freeze,
      wsa.mint_authority             AS wsa_mint,
      wsa.sell_quote_available       AS wsa_sell_quote,
      snap.raw_json                  AS entry_raw,
      snap.liquidity_usd             AS snap_liq,
      snap.volume_5m_usd             AS snap_vol5m,
      snap.price_change_5m_pct,
      snap.buys_5m,
      snap.sells_5m
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    LEFT JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots WHERE token_id = wc.token_id ORDER BY id ASC LIMIT 1
    )
    WHERE wc.created_at >= ?
    ORDER BY wc.created_at DESC
    LIMIT ?
  `).all(cutoff, limit) as any[];

  const totalScanned = rawRows.length;
  let totalWithSnapshot = 0;
  let noSnapshot = 0;

  const chaseCandidates: ChaseCandidateRow[] = [];
  const nonChaseCandidates: NonChaseCandidateRow[] = [];

  for (const r of rawRows) {
    const snap: TokenCandidate | null = r.entry_raw
      ? (JSON.parse(r.entry_raw) as TokenCandidate)
      : null;

    if (!snap) {
      noSnapshot++;
      continue;
    }
    totalWithSnapshot++;

    const movedBefore = snap.movedBeforeDiscoveryPct ?? r.wsa_moved ?? null;
    const pc5m = snap.priceChange5mPct ?? r.price_change_5m_pct ?? null;
    const liquidityUsd = snap.liquidityUsd ?? r.snap_liq ?? r.wc_liquidity ?? null;
    const volume5mUsd = snap.volume5mUsd ?? r.snap_vol5m ?? r.wc_vol5m ?? null;
    const buySellRatio = calcBsr(snap);
    const signalClass: string | null = r.signal_class ?? null;
    const bestGainPct: number | null = r.best_gain_pct ?? null;

    const movedChase = movedBefore !== null && movedBefore >= chaseMovedPct;
    const pc5mChase = pc5m !== null && pc5m > chasePc5mPct;

    if (movedChase || pc5mChase) {
      let chaseSignal: ChaseSignal;
      if (movedChase && pc5mChase) chaseSignal = 'both';
      else if (movedChase) chaseSignal = 'movedBeforeDiscovery';
      else chaseSignal = 'pc5m-spike';

      chaseCandidates.push({
        candidateId: r.candidate_id,
        tokenId: r.token_id,
        symbol: r.symbol ?? 'UNKNOWN',
        source: r.source ?? 'unknown',
        mint: r.mint ?? '',
        createdAt: r.created_at,
        signalClass,
        bestGainPct,
        worstDrawdownPct: r.worst_drawdown_pct ?? null,
        movedBeforeDiscoveryPct: movedBefore,
        liquidityUsd,
        volume5mUsd,
        priceChange5mPct: pc5m,
        buySellRatio,
        freezeAuthority: snap.freezeAuthority ?? r.wsa_freeze ?? null,
        mintAuthority: snap.mintAuthority ?? r.wsa_mint ?? null,
        sellQuoteAvailable: snap.sellQuoteAvailable ?? r.wsa_sell_quote ?? null,
        chaseSignal,
        isRunner: (bestGainPct ?? 0) >= minGain,
      });
    } else {
      nonChaseCandidates.push({
        signalClass,
        bestGainPct,
        worstDrawdownPct: r.worst_drawdown_pct ?? null,
        movedBeforeDiscoveryPct: movedBefore,
        liquidityUsd,
        priceChange5mPct: pc5m,
        buySellRatio,
      });
    }
  }

  const chaseRunners = chaseCandidates.filter((c) => c.isRunner)
    .sort((a, b) => (b.bestGainPct ?? 0) - (a.bestGainPct ?? 0));
  const chaseNonRunners = chaseCandidates.filter((c) => !c.isRunner)
    .sort((a, b) => (b.bestGainPct ?? 0) - (a.bestGainPct ?? 0));

  // Breakdown by chase signal type
  const signalTypes: ChaseSignal[] = ['movedBeforeDiscovery', 'pc5m-spike', 'both'];
  const chaseSignalBreakdown = signalTypes
    .map((signal) => {
      const group = chaseCandidates.filter((c) => c.chaseSignal === signal);
      const runners = group.filter((c) => c.isRunner).length;
      return {
        signal,
        count: group.length,
        runnerCount: runners,
        runnerPct: group.length > 0 ? (runners / group.length) * 100 : 0,
      };
    })
    .filter((b) => b.count > 0);

  const dataWarnings: string[] = [];
  if (totalScanned === 0) {
    dataWarnings.push(`No watch_only_candidates found in last ${windowHours}h. Try --window-hours=168.`);
  }
  if (noSnapshot > 0) {
    dataWarnings.push(`${noSnapshot} candidate(s) skipped — no entry snapshot stored.`);
  }
  if (chaseCandidates.length === 0) {
    dataWarnings.push(
      `No chase candidates found (movedBefore >= ${chaseMovedPct}% or pc5m > ${chasePc5mPct}%). ` +
        `Try --chase-moved-pct=10 or --window-hours=168.`
    );
  }
  if (chaseCandidates.length > 0 && chaseCandidates.length < 5) {
    dataWarnings.push('Small chase sample — widen window before drawing conclusions.');
  }
  if (chaseCandidates.filter((c) => c.signalClass !== null).length === 0 && chaseCandidates.length > 0) {
    dataWarnings.push(
      'Chase candidates have no signal_class yet — run token:watch-analysis to classify them.'
    );
  }

  return {
    windowHours,
    limit,
    minGainPct: minGain,
    chaseMovedPct,
    chasePc5mPct,
    cutoff,
    totalScanned,
    totalWithSnapshot,
    noSnapshot,
    chaseCandidateCount: chaseCandidates.length,
    nonChaseCandidateCount: nonChaseCandidates.length,
    chaseRunners,
    chaseNonRunners,
    chaseStats: buildOutcomeStats(chaseCandidates, minGain),
    nonChaseStats: buildOutcomeStats(nonChaseCandidates, minGain),
    chaseSignalBreakdown,
    dataWarnings,
    noTradingBehaviorChanged: true,
  };
}

export function renderChaseWatchReport(report: ChaseWatchReport): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  const chaseRunnerPct =
    report.chaseCandidateCount > 0
      ? ((report.chaseRunners.length / report.chaseCandidateCount) * 100).toFixed(0)
      : '-';
  const nonChaseRunnerPct =
    report.nonChaseCandidateCount > 0
      ? ((report.nonChaseStats.runnerCount / report.nonChaseCandidateCount) * 100).toFixed(0)
      : '-';

  // ── 1. Header ──────────────────────────────────────────────
  lines.push('Chase Watch Report');
  lines.push(sep);
  lines.push(`Window:            last ${report.windowHours}h  (cutoff: ${report.cutoff})`);
  lines.push(`Min gain:          >= ${report.minGainPct}% (runner threshold)`);
  lines.push(`Chase-entry signals:`);
  lines.push(`  movedBeforeDiscovery >= ${report.chaseMovedPct}%  OR  pc5m > ${report.chasePc5mPct}%`);
  lines.push(`Limit:             ${report.limit}`);
  lines.push('');
  lines.push(`Total scanned:     ${report.totalScanned} watch-only candidates`);
  lines.push(`With snapshot:     ${report.totalWithSnapshot}`);
  lines.push(
    `Chase candidates:  ${report.chaseCandidateCount}` +
      (report.totalWithSnapshot > 0
        ? ` (${((report.chaseCandidateCount / report.totalWithSnapshot) * 100).toFixed(0)}% of scanned)`
        : '')
  );
  lines.push(
    `Non-chase:         ${report.nonChaseCandidateCount}`
  );
  lines.push('');
  lines.push(
    `Chase runners:     ${report.chaseRunners.length} of ${report.chaseCandidateCount}` +
      (report.chaseCandidateCount > 0 ? ` (${chaseRunnerPct}% run rate)` : '')
  );
  lines.push(
    `Non-chase runners: ${report.nonChaseStats.runnerCount} of ${report.nonChaseCandidateCount}` +
      (report.nonChaseCandidateCount > 0 ? ` (${nonChaseRunnerPct}% run rate)` : '')
  );

  if (report.dataWarnings.length > 0) {
    lines.push('');
    for (const w of report.dataWarnings) lines.push(`  ⚠  ${w}`);
  }
  lines.push('');

  if (report.totalScanned === 0 || report.chaseCandidateCount === 0) {
    lines.push('No chase candidates in this window. Adjust --chase-moved-pct or --window-hours.');
    lines.push('');
    lines.push(sep);
    lines.push('Safety');
    lines.push(sep);
    lines.push('  Report only. No DB writes. No trading behavior changed.');
    lines.push('  Real trading remains locked.');
    return lines.join('\n');
  }

  // ── 2. Chase Runners ──────────────────────────────────────
  lines.push(`Chase Runners (${report.chaseRunners.length} — gain >= ${report.minGainPct}%)`);
  lines.push(sep);
  lines.push('  These tokens were "already moving" at discovery AND still gained.');
  lines.push('');

  if (report.chaseRunners.length === 0) {
    lines.push('  (none in this window)');
  } else {
    for (const c of report.chaseRunners) {
      const classTag = c.signalClass ?? 'UNCLASSIFIED';
      lines.push(
        `  ${c.symbol.padEnd(14)} src=${c.source.padEnd(13)}` +
          ` best=${fmtPct(c.bestGainPct, 0).padStart(8)}` +
          ` draw=${fmtPct(c.worstDrawdownPct, 0).padStart(8)}` +
          `  class=${classTag}`
      );
      lines.push(
        `    liq=${fmtMoney(c.liquidityUsd).padEnd(8)}` +
          ` vol5m=${fmtMoney(c.volume5mUsd).padEnd(8)}` +
          ` pc5m=${fmtPct(c.priceChange5mPct, 0).padEnd(8)}` +
          ` bsr=${fmtNum(c.buySellRatio).padEnd(5)}` +
          ` moved_b4=${fmtPct(c.movedBeforeDiscoveryPct, 0)}`
      );
      lines.push(`    chase_signal=${c.chaseSignal}  sell_quote=${c.sellQuoteAvailable ?? '-'}  freeze=${c.freezeAuthority ?? '-'}  mint=${c.mintAuthority ?? '-'}`);
      lines.push('');
    }
  }

  // ── 3. Chase Non-Runners ──────────────────────────────────
  const maxNonRunners = 10;
  lines.push(
    `Chase Non-Runners (${report.chaseNonRunners.length} — gain < ${report.minGainPct}%, showing top ${Math.min(maxNonRunners, report.chaseNonRunners.length)})`
  );
  lines.push(sep);
  lines.push('  These tokens were "already moving" at discovery and did NOT produce a run.');
  lines.push('');

  if (report.chaseNonRunners.length === 0) {
    lines.push('  (none — all chase candidates reached the runner threshold)');
  } else {
    for (const c of report.chaseNonRunners.slice(0, maxNonRunners)) {
      const classTag = c.signalClass ?? 'UNCLASSIFIED';
      lines.push(
        `  ${c.symbol.padEnd(14)} src=${c.source.padEnd(13)}` +
          ` best=${fmtPct(c.bestGainPct, 0).padStart(8)}` +
          ` draw=${fmtPct(c.worstDrawdownPct, 0).padStart(8)}` +
          `  class=${classTag}`
      );
      lines.push(
        `    liq=${fmtMoney(c.liquidityUsd).padEnd(8)}` +
          ` vol5m=${fmtMoney(c.volume5mUsd).padEnd(8)}` +
          ` pc5m=${fmtPct(c.priceChange5mPct, 0).padEnd(8)}` +
          ` bsr=${fmtNum(c.buySellRatio).padEnd(5)}` +
          ` moved_b4=${fmtPct(c.movedBeforeDiscoveryPct, 0)}`
      );
      lines.push(`    chase_signal=${c.chaseSignal}`);
      lines.push('');
    }
    if (report.chaseNonRunners.length > maxNonRunners) {
      lines.push(`  ... and ${report.chaseNonRunners.length - maxNonRunners} more (use --limit to expand)`);
      lines.push('');
    }
  }

  // ── 4. Chase Signal Type Breakdown ────────────────────────
  lines.push('Chase Signal Breakdown');
  lines.push(sep);
  lines.push('  What drove the "chase" classification:');
  lines.push('');
  if (report.chaseSignalBreakdown.length === 0) {
    lines.push('  (no data)');
  } else {
    for (const b of report.chaseSignalBreakdown) {
      const bar = '█'.repeat(Math.max(1, Math.round(b.runnerPct / 5)));
      lines.push(
        `    ${b.signal.padEnd(22)} ${String(b.count).padStart(3)} candidate(s)` +
          `  runners=${b.runnerCount}/${b.count}` +
          `  (${b.runnerPct.toFixed(0)}% run rate)  ${bar}`
      );
    }
  }
  lines.push('');

  // ── 5. Chase vs Non-Chase Signal Comparison ───────────────
  lines.push('Chase vs Non-Chase Outcome Comparison');
  lines.push(sep);

  const cs = report.chaseStats;
  const ns = report.nonChaseStats;
  const FW = 20;
  const VW = 16;

  lines.push(`  ${'Metric'.padEnd(FW)} ${'chase-entry'.padStart(VW)} ${'non-chase'.padStart(VW)}`);
  lines.push('  ' + '─'.repeat(FW + VW * 2 + 2));

  const rows: Array<[string, string, string]> = [
    ['n', String(cs.count), String(ns.count)],
    ['runners', `${cs.runnerCount} (${chaseRunnerPct}%)`, `${ns.runnerCount} (${nonChaseRunnerPct}%)`],
    ['dumps (INST_DUMP)', String(cs.dumpCount), String(ns.dumpCount)],
    ['noise/unclassified', String(cs.noiseCount), String(ns.noiseCount)],
    ['avg gain', fmtPct(cs.avgGain, 0), fmtPct(ns.avgGain, 0)],
    ['med gain', fmtPct(cs.medGain, 0), fmtPct(ns.medGain, 0)],
    ['avg moved_b4', fmtPct(cs.avgMoved, 0), fmtPct(ns.avgMoved, 0)],
    ['avg pc5m', fmtPct(cs.avgPc5m, 0), fmtPct(ns.avgPc5m, 0)],
    ['avg liquidity', fmtMoney(cs.avgLiq), fmtMoney(ns.avgLiq)],
    ['avg BSR', fmtNum(cs.avgBsr), fmtNum(ns.avgBsr)],
  ];

  for (const [field, cv, nv] of rows) {
    lines.push(`  ${field.padEnd(FW)} ${cv.padStart(VW)} ${nv.padStart(VW)}`);
  }
  lines.push('');

  // ── 6. Pattern Hypotheses ─────────────────────────────────
  lines.push('Pattern Hypotheses (research notes — NOT active rules)');
  lines.push(sep);
  lines.push('');
  lines.push('  Is there a usable CHASE_WATCH research lane?');
  lines.push('');

  const chaseRunRate = report.chaseCandidateCount > 0
    ? (report.chaseRunners.length / report.chaseCandidateCount) * 100
    : null;
  const nonChaseRunRate = report.nonChaseCandidateCount > 0
    ? (report.nonChaseStats.runnerCount / report.nonChaseCandidateCount) * 100
    : null;

  if (chaseRunRate !== null && nonChaseRunRate !== null) {
    const diff = chaseRunRate - nonChaseRunRate;
    if (diff > 5) {
      lines.push(
        `  Chase run rate (${chaseRunRate.toFixed(0)}%) is HIGHER than non-chase (${nonChaseRunRate.toFixed(0)}%).`
      );
      lines.push('  This could suggest a momentum-continuation pattern, but:');
    } else if (diff < -5) {
      lines.push(
        `  Chase run rate (${chaseRunRate.toFixed(0)}%) is LOWER than non-chase (${nonChaseRunRate.toFixed(0)}%).`
      );
      lines.push('  Chase entries appear worse on average in this window, but:');
    } else {
      lines.push(
        `  Chase run rate (${chaseRunRate.toFixed(0)}%) is similar to non-chase (${nonChaseRunRate.toFixed(0)}%).`
      );
      lines.push('  No clear separation in this window, but:');
    }
    lines.push('');
  }

  lines.push('  Limitations of this window:');
  lines.push('  → "Run rate" counts tokens that hit the gain threshold at any point — not at a safe entry.');
  lines.push('  → Chase entries have higher moved_b4, meaning less upside remains at discovery.');
  lines.push('  → High pc5m at discovery could mean: (a) still running, or (b) near the top.');
  lines.push('  → This window is too small to distinguish luck from pattern.');
  lines.push('');
  lines.push('  What would make a CHASE_WATCH lane worth formalizing?');
  lines.push('  → Consistent run rate over 7+ days and 50+ chase candidates.');
  lines.push('  → Chase runners showing LOWER drawdown (not just peak gain).');
  lines.push('  → Chase runners with clear entry-time separators (e.g., liq >= $50k, BSR >= 3).');
  lines.push('  → Forward test: classify CHASE entries in real-time and track outcomes separately.');
  lines.push('');
  lines.push('  What NOT to do based on this report:');
  lines.push('  → Do NOT add CHASE_WATCH as a DB status based on one window.');
  lines.push('  → Do NOT loosen shadow rules to let chase entries through.');
  lines.push('  → Do NOT add chase-entry buy signals.');
  lines.push('  → Do NOT change movedBeforeDiscovery or pc5m thresholds.');
  lines.push('');
  lines.push('  Suggested next steps (research only):');
  lines.push(`  → Run with --window-hours=168 to compare across a full week.`);
  lines.push('  → Run token:rejected-runner-autopsy to see classified runners that failed shadow rules.');
  lines.push('  → Run token:historical-winner-autopsy for full signal class breakdown.');
  lines.push('');

  // ── 7. Safety Footer ──────────────────────────────────────
  lines.push(sep);
  lines.push('Safety');
  lines.push(sep);
  lines.push('  Report only. No DB writes. No network calls. No proposals created.');
  lines.push('  No trading behavior changed. No thresholds changed. No filters loosened.');
  lines.push('  CHASE_WATCH not added as a DB status. Shadow rules unchanged.');
  lines.push('  Real trading remains locked.');

  return lines.join('\n');
}
