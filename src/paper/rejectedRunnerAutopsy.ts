import type { AppDb } from '../db';
import type { AppConfig, TokenCandidate } from '../types';

const DEFAULT_MIN_GAIN = 50;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 200;

// Shadow rule defaults (same as shadowCandidateReport.ts for consistency)
const DEFAULT_MIN_LIQUIDITY = 50_000;
const DEFAULT_MAX_MOVED = 25;
const DEFAULT_MIN_BSR = 2.0;
const DEFAULT_MIN_PC5M = 3;
const DEFAULT_MAX_PC5M = 75;
const DEFAULT_MAX_SLIPPAGE_BPS = 200;

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

interface ShadowRejectReason {
  field: string;
  detail: string;
}

interface ShadowParams {
  minLiquidity: number;
  maxMoved: number;
  minBsr: number;
  minPc5m: number;
  maxPc5m: number;
  maxSlippageBps: number;
}

function calcBsr(snap: TokenCandidate): number {
  return (snap.buys5m ?? 0) / Math.max(1, snap.sells5m ?? 0);
}

function evaluateShadowRules(snap: TokenCandidate, params: ShadowParams): ShadowRejectReason[] {
  const reasons: ShadowRejectReason[] = [];

  if ((snap.liquidityUsd ?? 0) < params.minLiquidity) {
    reasons.push({
      field: 'liquidity',
      detail: `${fmtMoney(snap.liquidityUsd)} < ${fmtMoney(params.minLiquidity)} threshold`,
    });
  }

  if (snap.movedBeforeDiscoveryPct !== null && snap.movedBeforeDiscoveryPct >= params.maxMoved) {
    reasons.push({
      field: 'movedBeforeDiscovery',
      detail: `${snap.movedBeforeDiscoveryPct.toFixed(1)}% >= ${params.maxMoved}% max`,
    });
  }

  const ratio = calcBsr(snap);
  if (ratio < params.minBsr) {
    reasons.push({
      field: 'BSR',
      detail: `${ratio.toFixed(2)} < ${params.minBsr} min`,
    });
  }

  const pc5m = snap.priceChange5mPct;
  if (pc5m === null) {
    reasons.push({ field: 'pc5m', detail: `null — required ${params.minPc5m}–${params.maxPc5m}%` });
  } else if (pc5m < params.minPc5m || pc5m > params.maxPc5m) {
    reasons.push({ field: 'pc5m', detail: `${fmtPct(pc5m)} outside ${params.minPc5m}–${params.maxPc5m}% range` });
  }

  if (snap.freezeAuthority === 'UNSAFE') {
    reasons.push({ field: 'freezeAuthority', detail: 'UNSAFE' });
  }

  if (snap.mintAuthority === 'UNSAFE') {
    reasons.push({ field: 'mintAuthority', detail: 'UNSAFE' });
  }

  if (snap.sellQuoteAvailable === 'NO') {
    reasons.push({ field: 'sellQuoteAvailable', detail: 'NO (sell quote explicitly unavailable)' });
  }

  if (snap.estimatedSlippageBps !== null && snap.estimatedSlippageBps > params.maxSlippageBps) {
    reasons.push({ field: 'slippage', detail: `${snap.estimatedSlippageBps}bps > ${params.maxSlippageBps}bps max` });
  }

  return reasons;
}

interface RunnerRow {
  candidateId: number;
  tokenId: number;
  symbol: string;
  source: string;
  mint: string;
  createdAt: string;
  signalClass: string;
  bestGainPct: number;
  worstDrawdownPct: number | null;
  movedBeforeDiscoveryPct: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  priceChange5mPct: number | null;
  buySellRatio: number;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  sellQuoteAvailable: string | null;
  shadowRejectReasons: ShadowRejectReason[];
  shadowPassed: boolean;
}

interface RunnerStats {
  count: number;
  avgGain: number | null;
  medGain: number | null;
  avgLiq: number | null;
  avgBsr: number | null;
  avgPc5m: number | null;
  avgMoved: number | null;
}

export interface RejectedRunnerAutopsyReport {
  minGainPct: number;
  windowHours: number;
  limit: number;
  params: ShadowParams;
  cutoff: string;
  totalRunnersFound: number;
  totalWithSnapshot: number;
  noSnapshot: number;
  shadowRejectedCount: number;
  shadowPassedCount: number;
  runners: RunnerRow[];
  topRejectionFields: Array<{ field: string; count: number; pct: number }>;
  rejectedStats: RunnerStats;
  passedStats: RunnerStats;
  dataWarnings: string[];
  noTradingBehaviorChanged: true;
}

function buildStats(label: string, rows: RunnerRow[]): RunnerStats {
  const pick = (vals: Array<number | null>) => vals.filter((v): v is number => v != null);
  return {
    count: rows.length,
    avgGain: avg(pick(rows.map((r) => r.bestGainPct))),
    medGain: median(pick(rows.map((r) => r.bestGainPct))),
    avgLiq: avg(pick(rows.map((r) => r.liquidityUsd))),
    avgBsr: avg(pick(rows.map((r) => r.buySellRatio))),
    avgPc5m: avg(pick(rows.map((r) => r.priceChange5mPct))),
    avgMoved: avg(pick(rows.map((r) => r.movedBeforeDiscoveryPct))),
  };
}

export function buildRejectedRunnerAutopsy(
  db: AppDb,
  _config: AppConfig,
  options: {
    minGain?: number;
    windowHours?: number;
    limit?: number;
    minLiquidity?: number;
    maxMoved?: number;
    minBsr?: number;
    minPc5m?: number;
    maxPc5m?: number;
    maxSlippageBps?: number;
  } = {}
): RejectedRunnerAutopsyReport {
  const minGain = options.minGain ?? DEFAULT_MIN_GAIN;
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const params: ShadowParams = {
    minLiquidity: options.minLiquidity ?? DEFAULT_MIN_LIQUIDITY,
    maxMoved: options.maxMoved ?? DEFAULT_MAX_MOVED,
    minBsr: options.minBsr ?? DEFAULT_MIN_BSR,
    minPc5m: options.minPc5m ?? DEFAULT_MIN_PC5M,
    maxPc5m: options.maxPc5m ?? DEFAULT_MAX_PC5M,
    maxSlippageBps: options.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS,
  };
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
      wsa.moved_before_discovery_pct,
      wsa.freeze_authority   AS wsa_freeze,
      wsa.mint_authority     AS wsa_mint,
      wsa.sell_quote_available AS wsa_sell_quote,
      snap.raw_json          AS entry_raw,
      snap.liquidity_usd     AS snap_liq,
      snap.volume_5m_usd     AS snap_vol5m,
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
      AND wc.best_gain_pct >= ?
      AND wsa.signal_class IN ('EARLY_RUNNER', 'LATE_RUNNER')
    ORDER BY wc.best_gain_pct DESC
    LIMIT ?
  `).all(cutoff, minGain, limit) as any[];

  const totalRunnersFound = rawRows.length;
  let totalWithSnapshot = 0;
  let noSnapshot = 0;
  const runners: RunnerRow[] = [];

  for (const r of rawRows) {
    const snap: TokenCandidate | null = r.entry_raw
      ? (JSON.parse(r.entry_raw) as TokenCandidate)
      : null;

    if (!snap) {
      noSnapshot++;
      continue;
    }
    totalWithSnapshot++;

    const shadowRejectReasons = evaluateShadowRules(snap, params);
    const liquidityUsd = snap.liquidityUsd ?? r.snap_liq ?? r.wc_liquidity ?? null;
    const volume5mUsd = snap.volume5mUsd ?? r.snap_vol5m ?? r.wc_vol5m ?? null;
    const priceChange5mPct = snap.priceChange5mPct ?? r.price_change_5m_pct ?? null;
    const buySellRatio = calcBsr(snap);

    runners.push({
      candidateId: r.candidate_id,
      tokenId: r.token_id,
      symbol: r.symbol ?? 'UNKNOWN',
      source: r.source ?? 'unknown',
      mint: r.mint ?? '',
      createdAt: r.created_at,
      signalClass: r.signal_class ?? 'UNCLASSIFIED',
      bestGainPct: r.best_gain_pct,
      worstDrawdownPct: r.worst_drawdown_pct ?? null,
      movedBeforeDiscoveryPct: snap.movedBeforeDiscoveryPct ?? r.moved_before_discovery_pct ?? null,
      liquidityUsd,
      volume5mUsd,
      priceChange5mPct,
      buySellRatio,
      freezeAuthority: snap.freezeAuthority ?? r.wsa_freeze ?? null,
      mintAuthority: snap.mintAuthority ?? r.wsa_mint ?? null,
      sellQuoteAvailable: snap.sellQuoteAvailable ?? r.wsa_sell_quote ?? null,
      shadowRejectReasons,
      shadowPassed: shadowRejectReasons.length === 0,
    });
  }

  const rejected = runners.filter((r) => !r.shadowPassed);
  const passed = runners.filter((r) => r.shadowPassed);

  // Count how often each rejection field appears across all rejected runners
  const fieldCounts = new Map<string, number>();
  for (const r of rejected) {
    for (const reason of r.shadowRejectReasons) {
      fieldCounts.set(reason.field, (fieldCounts.get(reason.field) ?? 0) + 1);
    }
  }
  const topRejectionFields = [...fieldCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([field, count]) => ({
      field,
      count,
      pct: rejected.length > 0 ? (count / rejected.length) * 100 : 0,
    }));

  const dataWarnings: string[] = [];
  if (totalRunnersFound === 0) {
    dataWarnings.push(
      `No runners with best_gain_pct >= ${minGain}% in last ${windowHours}h. Try --min-gain=30 or --window-hours=48.`
    );
  }
  if (noSnapshot > 0) {
    dataWarnings.push(`${noSnapshot} runner(s) skipped — no entry snapshot stored.`);
  }
  if (totalWithSnapshot < 5) {
    dataWarnings.push(
      `Only ${totalWithSnapshot} runner(s) with snapshot data — patterns are directional only.`
    );
  }
  if (totalWithSnapshot > 0 && totalWithSnapshot < 10) {
    dataWarnings.push('Small sample — widen window or lower min-gain before drawing conclusions.');
  }

  return {
    minGainPct: minGain,
    windowHours,
    limit,
    params,
    cutoff,
    totalRunnersFound,
    totalWithSnapshot,
    noSnapshot,
    shadowRejectedCount: rejected.length,
    shadowPassedCount: passed.length,
    runners,
    topRejectionFields,
    rejectedStats: buildStats('shadow-rejected', rejected),
    passedStats: buildStats('shadow-passed', passed),
    dataWarnings,
    noTradingBehaviorChanged: true,
  };
}

export function renderRejectedRunnerAutopsy(report: RejectedRunnerAutopsyReport): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);
  const { params } = report;

  const shadowRejectedPct =
    report.totalWithSnapshot > 0
      ? ((report.shadowRejectedCount / report.totalWithSnapshot) * 100).toFixed(0)
      : '-';

  // ── 1. Header ──────────────────────────────────────────────
  lines.push('Rejected Runner Autopsy');
  lines.push(sep);
  lines.push(`Window:       last ${report.windowHours}h  (cutoff: ${report.cutoff})`);
  lines.push(`Min gain:     >= ${report.minGainPct}%`);
  lines.push(`Limit:        ${report.limit}`);
  lines.push(
    `Shadow rules: liq>=${fmtMoney(params.minLiquidity)}  moved<${params.maxMoved}%` +
      `  bsr>=${params.minBsr}  pc5m=${params.minPc5m}–${params.maxPc5m}%  slippage<=${params.maxSlippageBps}bps`
  );
  lines.push('');
  lines.push(`Runners found:    ${report.totalRunnersFound} (EARLY_RUNNER + LATE_RUNNER, gain >= ${report.minGainPct}%)`);
  lines.push(`With snapshot:    ${report.totalWithSnapshot}`);
  lines.push(
    `Shadow rejected:  ${report.shadowRejectedCount} of ${report.totalWithSnapshot}` +
      (report.totalWithSnapshot > 0 ? ` (${shadowRejectedPct}%)` : '')
  );
  lines.push(`Shadow passed:    ${report.shadowPassedCount}`);

  if (report.dataWarnings.length > 0) {
    lines.push('');
    for (const w of report.dataWarnings) lines.push(`  ⚠  ${w}`);
  }
  lines.push('');

  if (report.totalRunnersFound === 0) {
    lines.push('No runners found in this window. Adjust --min-gain or --window-hours.');
    lines.push('');
    lines.push(sep);
    lines.push('Safety');
    lines.push(sep);
    lines.push('  Report only. No DB writes. No trading behavior changed.');
    lines.push('  Real trading remains locked.');
    return lines.join('\n');
  }

  // ── 2. Shadow-Rejected Runners ────────────────────────────
  const rejected = report.runners.filter((r) => !r.shadowPassed);
  lines.push(`Shadow-Rejected Runners (${rejected.length} tokens that ran but failed shadow rules)`);
  lines.push(sep);

  if (rejected.length === 0) {
    lines.push('  (none — all runners with snapshot data passed shadow rules)');
  } else {
    for (const r of rejected) {
      const reasons = r.shadowRejectReasons.map((x) => x.field).join(', ');
      lines.push(
        `  ${r.symbol.padEnd(14)} src=${r.source.padEnd(13)}` +
          ` best=${fmtPct(r.bestGainPct, 0).padStart(8)}` +
          ` draw=${fmtPct(r.worstDrawdownPct, 0).padStart(8)}` +
          `  class=${r.signalClass}`
      );
      lines.push(
        `    liq=${fmtMoney(r.liquidityUsd).padEnd(8)}` +
          ` vol5m=${fmtMoney(r.volume5mUsd).padEnd(8)}` +
          ` pc5m=${fmtPct(r.priceChange5mPct, 0).padEnd(8)}` +
          ` bsr=${fmtNum(r.buySellRatio).padEnd(5)}` +
          ` moved_b4=${fmtPct(r.movedBeforeDiscoveryPct, 0)}`
      );
      lines.push(`    failed: ${reasons}`);
      for (const x of r.shadowRejectReasons) {
        lines.push(`      - ${x.field}: ${x.detail}`);
      }
      lines.push('');
    }
  }

  // ── 3. Shadow-Passed Runners ──────────────────────────────
  const passed = report.runners.filter((r) => r.shadowPassed);
  lines.push(`Shadow-Passed Runners (${passed.length} tokens that ran AND passed shadow rules)`);
  lines.push(sep);

  if (passed.length === 0) {
    lines.push('  (none — all runners with snapshot data failed at least one shadow rule)');
    lines.push('');
  } else {
    for (const r of passed) {
      lines.push(
        `  ${r.symbol.padEnd(14)} src=${r.source.padEnd(13)}` +
          ` best=${fmtPct(r.bestGainPct, 0).padStart(8)}` +
          ` draw=${fmtPct(r.worstDrawdownPct, 0).padStart(8)}` +
          `  class=${r.signalClass}`
      );
      lines.push(
        `    liq=${fmtMoney(r.liquidityUsd).padEnd(8)}` +
          ` vol5m=${fmtMoney(r.volume5mUsd).padEnd(8)}` +
          ` pc5m=${fmtPct(r.priceChange5mPct, 0).padEnd(8)}` +
          ` bsr=${fmtNum(r.buySellRatio).padEnd(5)}` +
          ` moved_b4=${fmtPct(r.movedBeforeDiscoveryPct, 0)}`
      );
      lines.push('');
    }
  }

  // ── 4. Rejection Field Breakdown ──────────────────────────
  lines.push('Rejection Field Breakdown (among shadow-rejected runners)');
  lines.push(sep);

  if (report.topRejectionFields.length === 0) {
    lines.push('  (no rejections to aggregate)');
  } else {
    lines.push('  How often each shadow rule caused a rejection:');
    lines.push('');
    for (const { field, count, pct } of report.topRejectionFields) {
      const bar = '█'.repeat(Math.round(pct / 5));
      lines.push(
        `    ${field.padEnd(22)} ${String(count).padStart(3)} runner(s)` +
          `  (${pct.toFixed(0)}%)  ${bar}`
      );
    }
    lines.push('');
    lines.push(
      '  Note: one runner can fail multiple rules. Counts show how many runners failed each rule.'
    );
  }
  lines.push('');

  // ── 5. Rejected vs Passed Signal Comparison ───────────────
  lines.push('Signal Comparison: Shadow-Rejected vs Shadow-Passed Runners');
  lines.push(sep);

  const rs = report.rejectedStats;
  const ps = report.passedStats;

  const FW = 18;
  const VW = 16;
  const hdr = `  ${'Metric'.padEnd(FW)} ${'rejected'.padStart(VW)} ${'passed'.padStart(VW)}`;
  lines.push(hdr);
  lines.push('  ' + '─'.repeat(FW + VW * 2 + 2));

  const rows: Array<[string, string, string]> = [
    ['n', String(rs.count), String(ps.count)],
    ['avg gain', fmtPct(rs.avgGain, 0), fmtPct(ps.avgGain, 0)],
    ['med gain', fmtPct(rs.medGain, 0), fmtPct(ps.medGain, 0)],
    ['avg liquidity', fmtMoney(rs.avgLiq), fmtMoney(ps.avgLiq)],
    ['avg BSR', fmtNum(rs.avgBsr), fmtNum(ps.avgBsr)],
    ['avg pc5m', fmtPct(rs.avgPc5m, 0), fmtPct(ps.avgPc5m, 0)],
    ['avg moved_b4', fmtPct(rs.avgMoved, 0), fmtPct(ps.avgMoved, 0)],
  ];

  for (const [field, rv, pv] of rows) {
    lines.push(`  ${field.padEnd(FW)} ${rv.padStart(VW)} ${pv.padStart(VW)}`);
  }
  lines.push('');

  // ── 6. Pattern Hypotheses ─────────────────────────────────
  lines.push('Pattern Hypotheses (research notes — NOT active rules)');
  lines.push(sep);
  lines.push('');
  lines.push('  Question: Are shadow-rejected runners noise or a real "chase watch" pattern?');
  lines.push('');

  const movedB4Pct =
    rejected.length > 0
      ? (rejected.filter((r) => r.shadowRejectReasons.some((x) => x.field === 'movedBeforeDiscovery')).length /
          rejected.length) *
        100
      : 0;
  const bsrPct =
    rejected.length > 0
      ? (rejected.filter((r) => r.shadowRejectReasons.some((x) => x.field === 'BSR')).length /
          rejected.length) *
        100
      : 0;
  const pc5mPct =
    rejected.length > 0
      ? (rejected.filter((r) => r.shadowRejectReasons.some((x) => x.field === 'pc5m')).length /
          rejected.length) *
        100
      : 0;

  lines.push(`  - movedBeforeDiscovery fails in ${movedB4Pct.toFixed(0)}% of rejected runners.`);
  lines.push(`    If consistently high, these are tokens the scanner caught mid-move — "chase" entries.`);
  lines.push(`    High moved_b4 + still gaining = chased momentum. Risk: late entry, less upside.`);
  lines.push('');
  lines.push(`  - BSR fails in ${bsrPct.toFixed(0)}% of rejected runners.`);
  lines.push(`    Low BSR at discovery doesn't guarantee a dump — some move on sell-side pressure.`);
  lines.push(`    But low BSR is a weaker setup — these would require closer observation before buying.`);
  lines.push('');
  lines.push(`  - pc5m fails in ${pc5mPct.toFixed(0)}% of rejected runners.`);
  lines.push(`    pc5m outside 3–75% range could mean already-spiked (too late) or cooling (too early).`);
  lines.push(`    Split by direction before concluding anything.`);
  lines.push('');
  lines.push('  - "Chase watch" signal: movedBeforeDiscovery + pc5m-too-high together suggest a token');
  lines.push('    caught after the initial spike. These gains may not be reproducible with safe entry.');
  lines.push('');
  lines.push('  What this report cannot tell you:');
  lines.push('  → Whether these gains were achievable (safe sell exit, slippage, timing).');
  lines.push('  → Whether a trader entering at discovery could have captured them.');
  lines.push('  → Whether these patterns hold in future windows.');
  lines.push('');
  lines.push('  Next steps (research only):');
  lines.push('  → Run with --window-hours=72 to see if the pattern holds over more data.');
  lines.push('  → Compare signal class (EARLY_RUNNER vs LATE_RUNNER) in the rejected group.');
  lines.push('  → Run token:historical-winner-autopsy for full winner signal breakdown.');
  lines.push('  → Do NOT loosen shadow rules or add buy signals based on this report alone.');
  lines.push('');

  // ── 7. Safety Footer ──────────────────────────────────────
  lines.push(sep);
  lines.push('Safety');
  lines.push(sep);
  lines.push('  Report only. No DB writes. No network calls. No proposals created.');
  lines.push('  No trading behavior changed. No thresholds changed. No filters loosened.');
  lines.push('  Real trading remains locked.');

  return lines.join('\n');
}
