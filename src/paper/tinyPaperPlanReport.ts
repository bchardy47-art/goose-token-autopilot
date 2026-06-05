import type { AppDb } from '../db';
import type { AppConfig } from '../types';
import { buildPaperReadinessReport } from './paperReadinessReport';

export interface TinyPaperPlanOptions {
  windowHours: number;
  limit: number;
  maxPaperPositionUsd: number;
  maxOpenPositions: number;
  maxDailyPaperBuys: number;
  minLiquidity: number;
  maxSlippageBps: number;
  minShadowSamples: number;
  requireQuoteCheck: boolean;
}

interface CandidateEval {
  symbol: string;
  tokenId: number;
  candidateId: number;
  createdAt: string;
  signalClass: string | null;
  liquidity: number | null;
  movedBeforePct: number | null;
  bsr: number | null;
  pc5m: number | null;
  slippageBps: number | null;
  sellQuoteAvail: string | null;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  hasForwardCapture: boolean;
  passLiq: boolean | null;
  passMoved: boolean | null;
  passBsr: boolean | null;
  passPc5m: boolean | null;
  passSlippage: boolean | null;
  passQuote: boolean | null;
  passSafety: boolean | null;
  shadowPass: boolean;
  failReasons: string[];
}

export interface TinyPaperPlanReport {
  // Readiness gate (derived from paperReadinessReport)
  readinessVerdict: string;
  readinessPassCount: number;
  readinessTotalGates: number;
  readinessBlockers: string[];
  planAllowed: boolean;

  // Envelope parameters (from CLI opts)
  maxPaperPositionUsd: number;
  maxOpenPositions: number;
  maxDailyPaperBuys: number;
  minLiquidity: number;
  maxSlippageBps: number;
  minShadowSamples: number;
  requireQuoteCheck: boolean;
  windowHours: number;

  // Candidate pool analysis
  totalCandidates: number;        // all-time classified
  windowCandidates: number;       // in the requested window
  allTimeShadowPass: number;      // all-time candidates passing shadow screen
  allTimeShadowPassWithCapture: number; // + have at least one forward-capture outcome
  windowShadowPass: number;       // in-window shadow passes
  failReasonCounts: Record<string, number>;
  topWindowCandidates: CandidateEval[];

  // Blocker: not enough historical shadow samples with forward capture
  shadowSampleBlocker: boolean;
  shadowSampleBlockerMsg: string;

  // Computed flag counts (for data quality display)
  unknownMovedCount: number;
  unknownBsrCount: number;
  unknownSlippageCount: number;
  unknownQuoteCount: number;

  noTradingBehaviorChanged: true;
}

function evalCandidate(
  row: {
    candidateId: number; tokenId: number; symbol: string; createdAt: string;
    signalClass: string | null;
    wsa_liq: number | null; wc_liq: number | null; snap_liq: number | null;
    movedBeforePct: number | null;
    buys5m: number | null; sells5m: number | null;
    pc5m: number | null;
    slippageBps: number | null;
    sellQuoteAvail: string | null;
    freezeAuthority: string | null; mintAuthority: string | null;
    hasForwardCapture: boolean;
  },
  opts: { minLiquidity: number; maxSlippageBps: number }
): CandidateEval {
  const liquidity = row.wsa_liq ?? row.wc_liq ?? row.snap_liq;
  const bsr =
    row.buys5m != null && row.sells5m != null && row.sells5m > 0
      ? row.buys5m / row.sells5m
      : null;

  const passLiq = liquidity != null ? liquidity >= opts.minLiquidity : null;
  const passMoved = row.movedBeforePct != null ? row.movedBeforePct < 25 : null;
  const passBsr = bsr != null ? bsr >= 2.0 : null;
  const passPc5m = row.pc5m != null ? row.pc5m >= 3 && row.pc5m <= 75 : null;
  const passSlippage = row.slippageBps != null ? row.slippageBps <= opts.maxSlippageBps : null;
  const passQuote =
    row.sellQuoteAvail != null ? row.sellQuoteAvail === 'YES' : null;
  const passSafety =
    row.freezeAuthority != null && row.mintAuthority != null
      ? row.freezeAuthority !== 'UNSAFE' && row.mintAuthority !== 'UNSAFE'
      : null;

  const failReasons: string[] = [];
  if (passLiq === false) failReasons.push('low-liquidity');
  if (passMoved === false) failReasons.push('moved-before-discovery');
  if (passBsr === false) failReasons.push('low-bsr');
  if (passPc5m === false) failReasons.push('pc5m-out-of-range');
  if (passSlippage === false) failReasons.push('high-slippage');
  if (passQuote === false) failReasons.push('no-sell-quote');
  if (passSafety === false) failReasons.push('unsafe-authority');

  // shadowPass = no explicit fails AND liquidity is known and passes
  const shadowPass = failReasons.length === 0 && passLiq === true;

  return {
    symbol: row.symbol, tokenId: row.tokenId, candidateId: row.candidateId,
    createdAt: row.createdAt, signalClass: row.signalClass,
    liquidity, movedBeforePct: row.movedBeforePct, bsr, pc5m: row.pc5m,
    slippageBps: row.slippageBps, sellQuoteAvail: row.sellQuoteAvail,
    freezeAuthority: row.freezeAuthority, mintAuthority: row.mintAuthority,
    hasForwardCapture: row.hasForwardCapture,
    passLiq, passMoved, passBsr, passPc5m, passSlippage, passQuote, passSafety,
    shadowPass, failReasons,
  };
}

export function buildTinyPaperPlanReport(
  db: AppDb,
  config: AppConfig,
  opts: TinyPaperPlanOptions
): TinyPaperPlanReport {
  const sql = db.sqlite;

  // ── 1. Readiness gate ──────────────────────────────────────
  const readiness = buildPaperReadinessReport(db, config);
  const readinessBlockers = readiness.gates
    .filter((g) => g.result === 'FAIL')
    .map((g) => `[FAIL] ${g.id} ${g.label}: ${g.actual} (required: ${g.threshold})`);
  const planAllowed = readiness.verdict === 'READY_TO_CONSIDER';

  // ── 2. Load slippage map from quote_sellability_checks ─────
  const slippageMap = new Map<number, { slippageBps: number | null; routeAvailable: number | null }>();
  try {
    const rows = sql.prepare(`
      SELECT token_id, estimated_slippage_bps, route_available
      FROM quote_sellability_checks
      WHERE id IN (SELECT MAX(id) FROM quote_sellability_checks GROUP BY token_id)
    `).all() as Array<{ token_id: number; estimated_slippage_bps: number | null; route_available: number | null }>;
    for (const r of rows) {
      slippageMap.set(r.token_id, { slippageBps: r.estimated_slippage_bps, routeAvailable: r.route_available });
    }
  } catch { /* table may be empty */ }

  // ── 3. Load forward-capture set (any watch_only_outcomes row) ─
  const forwardCaptureIds = new Set<number>();
  try {
    const rows = sql.prepare('SELECT DISTINCT watch_candidate_id FROM watch_only_outcomes').all() as Array<{ watch_candidate_id: number }>;
    for (const r of rows) forwardCaptureIds.add(r.watch_candidate_id);
  } catch { /* table may be empty */ }

  // ── 4. Query all candidates (limit for safety, but high enough to capture all) ─
  type RawRow = {
    candidate_id: number; token_id: number; symbol: string; created_at: string;
    signal_class: string | null;
    wsa_liq: number | null; wc_liq: number | null; snap_liq: number | null;
    moved_before: number | null;
    buys_5m: number | null; sells_5m: number | null;
    pc5m: number | null;
    sell_quote_available: string | null;
    freeze_authority: string | null; mint_authority: string | null;
  };

  const rawRows = sql.prepare(`
    SELECT
      wc.id                          AS candidate_id,
      wc.token_id,
      wc.created_at,
      wc.liquidity_usd               AS wc_liq,
      t.symbol,
      wsa.signal_class,
      wsa.liquidity_usd              AS wsa_liq,
      wsa.moved_before_discovery_pct AS moved_before,
      wsa.sell_quote_available,
      wsa.freeze_authority,
      wsa.mint_authority,
      snap.liquidity_usd             AS snap_liq,
      snap.price_change_5m_pct       AS pc5m,
      snap.buys_5m,
      snap.sells_5m
    FROM watch_only_candidates wc
    JOIN tokens t ON t.id = wc.token_id
    LEFT JOIN watch_only_signal_analysis wsa ON wsa.watch_candidate_id = wc.id
    LEFT JOIN token_snapshots snap ON snap.id = (
      SELECT id FROM token_snapshots
      WHERE token_id = wc.token_id
      ORDER BY id ASC LIMIT 1
    )
    ORDER BY wc.created_at DESC
    LIMIT 2000
  `).all() as RawRow[];

  const evalOpts = { minLiquidity: opts.minLiquidity, maxSlippageBps: opts.maxSlippageBps };
  const windowCutoff = new Date(Date.now() - opts.windowHours * 60 * 60 * 1000).toISOString();

  const allEvals: CandidateEval[] = rawRows.map((r) => {
    const slipData = slippageMap.get(r.token_id) ?? null;
    return evalCandidate(
      {
        candidateId: r.candidate_id, tokenId: r.token_id, symbol: r.symbol,
        createdAt: r.created_at, signalClass: r.signal_class,
        wsa_liq: r.wsa_liq, wc_liq: r.wc_liq, snap_liq: r.snap_liq,
        movedBeforePct: r.moved_before,
        buys5m: r.buys_5m, sells5m: r.sells_5m, pc5m: r.pc5m,
        slippageBps: slipData?.slippageBps ?? null,
        sellQuoteAvail: r.sell_quote_available,
        freezeAuthority: r.freeze_authority, mintAuthority: r.mint_authority,
        hasForwardCapture: forwardCaptureIds.has(r.candidate_id),
      },
      evalOpts
    );
  });

  const windowEvals = allEvals.filter((e) => e.createdAt >= windowCutoff).slice(0, opts.limit);

  const totalCandidates = allEvals.length;
  const windowCandidates = windowEvals.length;

  const allTimeShadowPass = allEvals.filter((e) => e.shadowPass).length;
  const allTimeShadowPassWithCapture = allEvals.filter((e) => e.shadowPass && e.hasForwardCapture).length;
  const windowShadowPass = windowEvals.filter((e) => e.shadowPass).length;

  // Fail reason counts across the window
  const failReasonCounts: Record<string, number> = {};
  for (const e of windowEvals) {
    for (const r of e.failReasons) {
      failReasonCounts[r] = (failReasonCounts[r] ?? 0) + 1;
    }
  }

  // Top window candidates (shadow-pass first, then by signal class preference)
  const topWindowCandidates = [...windowEvals]
    .sort((a, b) => {
      if (a.shadowPass !== b.shadowPass) return a.shadowPass ? -1 : 1;
      const classOrder = ['EARLY_RUNNER', 'LATE_RUNNER', 'INSTANT_DUMP', 'TOO_DANGEROUS', 'DEAD_NOISE'];
      return (classOrder.indexOf(a.signalClass ?? '') ?? 99) - (classOrder.indexOf(b.signalClass ?? '') ?? 99);
    })
    .slice(0, 10);

  // Unknown-data counts across window
  const unknownMovedCount = windowEvals.filter((e) => e.passMoved === null).length;
  const unknownBsrCount = windowEvals.filter((e) => e.passBsr === null).length;
  const unknownSlippageCount = windowEvals.filter((e) => e.passSlippage === null).length;
  const unknownQuoteCount = windowEvals.filter((e) => e.passQuote === null).length;

  // Shadow sample blocker
  const shadowSampleBlocker = allTimeShadowPassWithCapture < opts.minShadowSamples;
  const shadowSampleBlockerMsg = shadowSampleBlocker
    ? `Only ${allTimeShadowPassWithCapture} historical shadow-pass candidates have forward-capture outcomes — need >= ${opts.minShadowSamples}. Run more watch cycles + token:watch-outcomes before calibrating a paper plan.`
    : '';

  return {
    readinessVerdict: readiness.verdict,
    readinessPassCount: readiness.passCount,
    readinessTotalGates: readiness.gates.length,
    readinessBlockers,
    planAllowed,

    maxPaperPositionUsd: opts.maxPaperPositionUsd,
    maxOpenPositions: opts.maxOpenPositions,
    maxDailyPaperBuys: opts.maxDailyPaperBuys,
    minLiquidity: opts.minLiquidity,
    maxSlippageBps: opts.maxSlippageBps,
    minShadowSamples: opts.minShadowSamples,
    requireQuoteCheck: opts.requireQuoteCheck,
    windowHours: opts.windowHours,

    totalCandidates,
    windowCandidates,
    allTimeShadowPass,
    allTimeShadowPassWithCapture,
    windowShadowPass,
    failReasonCounts,
    topWindowCandidates,

    shadowSampleBlocker,
    shadowSampleBlockerMsg,

    unknownMovedCount,
    unknownBsrCount,
    unknownSlippageCount,
    unknownQuoteCount,

    noTradingBehaviorChanged: true,
  };
}

function fmtMoney(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function tristate(v: boolean | null): string {
  if (v === true) return 'PASS';
  if (v === false) return 'FAIL';
  return 'unkn';
}

export function renderTinyPaperPlanReport(report: TinyPaperPlanReport): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  // ── 1. Header ──────────────────────────────────────────────
  lines.push('Tiny Paper Plan Report');
  lines.push(sep);
  lines.push('Purpose: design the safest possible tiny paper test plan.');
  lines.push('This report does NOT execute, schedule, or propose any trade.');
  lines.push('');

  // ── 2. Readiness Gate ─────────────────────────────────────
  lines.push('1. Readiness Gate');
  lines.push(sep);

  const verdictIcon =
    report.readinessVerdict === 'READY_TO_CONSIDER' ? '[PASS]'
    : report.readinessVerdict === 'APPROACHING' ? '[WARN]'
    : '[FAIL]';

  lines.push(`  ${verdictIcon}  paper-readiness-report verdict: ${report.readinessVerdict}`);
  lines.push(`          ${report.readinessPassCount} of ${report.readinessTotalGates} readiness gates passing`);

  if (!report.planAllowed) {
    lines.push('');
    lines.push('  Plan design shown below for reference, but it is NOT applicable until');
    lines.push('  paper-readiness-report returns READY_TO_CONSIDER.');
    lines.push('');
    lines.push('  Blockers:');
    for (const b of report.readinessBlockers) lines.push(`    • ${b}`);
  } else if (report.shadowSampleBlocker) {
    lines.push('');
    lines.push('  [WARN]  Shadow sample count is low:');
    lines.push(`    • ${report.shadowSampleBlockerMsg}`);
  } else {
    lines.push('');
    lines.push('  Readiness gates pass. Plan below is calibrated to current data.');
  }
  lines.push('');

  // ── 3. Proposed Test Envelope ─────────────────────────────
  lines.push('2. Proposed Test Envelope');
  lines.push(sep);
  lines.push('  These are the strictest safe parameters for an initial paper test.');
  lines.push('  None of these are active. They must be set explicitly before any run.');
  lines.push('');
  lines.push(`  Max position size:       $${report.maxPaperPositionUsd} USD (simulated)`);
  lines.push(`  Max open positions:      ${report.maxOpenPositions}`);
  lines.push(`  Max paper buys / day:    ${report.maxDailyPaperBuys}`);
  lines.push('  Execution mode:          manual-run only (no scheduler, no auto-paper)');
  lines.push('  Auto-paper:              disabled (ENABLE_AUTO_PAPER_TRADING must remain false)');
  lines.push('  Real trading:            disabled (ENABLE_REAL_BUYS must remain false)');
  lines.push('  Compounding:             none (fixed $5 per position)');
  lines.push('  Retry / chasing:         not allowed');
  lines.push('  Review cadence:          daily token:paper-autopsy after each run');
  lines.push('');

  // ── 4. Candidate Eligibility Rule ────────────────────────
  lines.push('3. Candidate Eligibility Rules');
  lines.push(sep);
  lines.push('  Only SHADOW_MATCH-style criteria. No CHASE_WATCH relaxations.');
  lines.push('');
  lines.push(`  liquidity          >= ${fmtMoney(report.minLiquidity)} at discovery`);
  lines.push('  movedBeforeDiscovery < 25%  (clean discovery required)');
  lines.push('  BSR (buy/sell ratio) >= 2.0');
  lines.push('  pc5m               in [3%, 75%]  (not dead, not already flying)');
  lines.push(`  slippage           <= ${report.maxSlippageBps} bps  (sell route must be usable)`);
  lines.push('  sell quote         available = YES  (confirmed before entry)');
  lines.push('  freeze authority   not UNSAFE');
  lines.push('  mint authority     not UNSAFE');
  lines.push('  forward capture    required (at least one outcome snapshot after discovery)');
  lines.push('');
  lines.push('  Current candidate pool:');
  lines.push(`    All-time classified candidates:                 ${report.totalCandidates}`);
  lines.push(`    All-time shadow-pass:                           ${report.allTimeShadowPass}`);
  lines.push(`    All-time shadow-pass with forward capture:      ${report.allTimeShadowPassWithCapture}` +
    (report.shadowSampleBlocker ? '  ← BELOW MIN' : ''));
  lines.push(`    In-window candidates (last ${report.windowHours}h):             ${report.windowCandidates}`);
  lines.push(`    In-window shadow-pass:                          ${report.windowShadowPass}`);

  if (Object.keys(report.failReasonCounts).length > 0) {
    lines.push('');
    lines.push('  In-window shadow fail reasons:');
    const sorted = Object.entries(report.failReasonCounts).sort((a, b) => b[1] - a[1]);
    for (const [reason, cnt] of sorted) {
      lines.push(`    ${reason.padEnd(26)} ${cnt}`);
    }
  }

  if (report.unknownMovedCount > 0 || report.unknownSlippageCount > 0 || report.unknownQuoteCount > 0) {
    lines.push('');
    lines.push('  Unknown data in window (criteria cannot be evaluated):');
    if (report.unknownMovedCount > 0)
      lines.push(`    movedBeforeDiscovery unknown: ${report.unknownMovedCount} candidates`);
    if (report.unknownBsrCount > 0)
      lines.push(`    BSR unknown:                  ${report.unknownBsrCount} candidates`);
    if (report.unknownSlippageCount > 0)
      lines.push(`    slippage unknown:             ${report.unknownSlippageCount} candidates  (enable quote check)`);
    if (report.unknownQuoteCount > 0)
      lines.push(`    sell quote unknown:           ${report.unknownQuoteCount} candidates`);
  }

  if (report.topWindowCandidates.length > 0) {
    lines.push('');
    lines.push('  Top candidates in window (shadow-pass first):');
    const H = `  ${'SYMBOL'.padEnd(12)} ${'CLASS'.padEnd(14)} ${'LIQ'.padStart(8)} ${'BSR'.padStart(5)} ${'PC5M'.padStart(6)} ${'MOVED'.padStart(6)} ${'SLIP'.padStart(6)} ${'QUOTE'.padStart(5)} ${'CAP'.padStart(4)}`;
    lines.push(H);
    lines.push('  ' + '─'.repeat(H.length - 2));
    for (const c of report.topWindowCandidates) {
      const liqStr = c.liquidity != null ? fmtMoney(c.liquidity) : '-';
      const bsrStr = c.bsr != null ? c.bsr.toFixed(1) : '-';
      const pc5mStr = c.pc5m != null ? `${c.pc5m > 0 ? '+' : ''}${c.pc5m.toFixed(0)}%` : '-';
      const movedStr = c.movedBeforePct != null ? `${c.movedBeforePct.toFixed(0)}%` : '-';
      const slipStr = c.slippageBps != null ? `${c.slippageBps}` : '-';
      const quoteStr = c.sellQuoteAvail ?? '-';
      const captureStr = c.hasForwardCapture ? 'YES' : 'NO';
      lines.push(
        `  ${c.symbol.padEnd(12)} ${(c.signalClass ?? '-').padEnd(14)}` +
        ` ${liqStr.padStart(8)} ${bsrStr.padStart(5)} ${pc5mStr.padStart(6)}` +
        ` ${movedStr.padStart(6)} ${slipStr.padStart(6)} ${quoteStr.padStart(5)} ${captureStr.padStart(4)}`
      );
    }
  }
  lines.push('');

  // ── 5. Exit Rules ─────────────────────────────────────────
  lines.push('4. Exit Rules  (proposed — not executed)');
  lines.push(sep);
  lines.push('  Time stop:          90 minutes after entry — exit regardless of P&L');
  lines.push('  Stop loss:          -35% from entry price');
  lines.push('  Take profit check:  at +50% — evaluate whether to hold or close');
  lines.push('  Take profit check:  at +100% — close at least 50% of position');
  lines.push('  Emergency exit:     if sell quote disappears (route_available = 0)');
  lines.push('  Emergency exit:     if slippage worsens > 2x entry slippage');
  lines.push('  Emergency exit:     if liquidity drops > 70% from entry liquidity');
  lines.push('');

  // ── 6. Kill Switch Conditions ─────────────────────────────
  lines.push('5. Kill Switch Conditions');
  lines.push(sep);
  lines.push('  Any of these immediately stops the paper experiment:');
  lines.push('  • 2 consecutive paper losses (stop-loss or worse)');
  lines.push('  • Any active position loses its sell route (route_available = 0)');
  lines.push('  • Any scan or score produces a no_data error on an active token');
  lines.push('  • Slippage on an open position exceeds max_slippage_bps at review time');
  lines.push('  • App error or unhandled exception during any paper-relevant command');
  lines.push('  • Laptop sleep or process interruption during a live session');
  lines.push('  • token:paper-autopsy shows report mismatch vs. expected P&L');
  lines.push('');

  // ── 7. What Must Be Built Before Any Paper Buy ────────────
  lines.push('6. Prerequisites — What Must Be Built First');
  lines.push(sep);
  lines.push('  Before any paper buy can happen, these must exist as separate commands:');
  lines.push('');
  lines.push('  [ ] A dry-run command that simulates a paper entry without writing it');
  lines.push('  [ ] A manual confirmation prompt before any position is opened');
  lines.push('  [ ] A position ledger verification step (no duplicate entries)');
  lines.push('  [ ] An exit simulation / pre-flight report before enabling auto-paper');
  lines.push('  [ ] A kill switch test — verify token:kill halts all activity cleanly');
  lines.push('  [ ] A quote-check gate — live slippage check immediately before entry');
  lines.push('  [ ] An entry snapshot logged at buy time (paper_entry_snapshots)');
  lines.push('  [ ] A review of token:paper-eligibility output before the first session');
  lines.push('  [ ] Confirmation that ENABLE_REAL_BUYS=false in the live .env');
  lines.push('  [ ] A paper trade ledger audit (token:paper-autopsy) after first run');
  lines.push('');
  lines.push('  There is no path from this report to actual paper buys.');
  lines.push('  This is a planning document only.');
  lines.push('');

  // ── 8. Safety Footer ─────────────────────────────────────
  lines.push(sep);
  lines.push('Safety');
  lines.push(sep);
  lines.push('  Report only. No DB writes. No network calls. No proposals created.');
  lines.push('  No positions opened. No trading behavior changed.');
  lines.push('  No thresholds changed. No filters loosened.');
  lines.push('  Real trading remains locked.');

  return lines.join('\n');
}
