import type { AppDb } from '../db';
import type { AppConfig } from '../types';

// Minimum thresholds for each readiness gate
const GATE_MIN_CLASSIFIED = 50;       // G1: total signal-analysed candidates
const GATE_MIN_EARLY_RUNNERS = 15;    // G2: EARLY_RUNNER sample size
const GATE_MAX_DUMP_RATE_PCT = 40;    // G3: INSTANT_DUMP / total < this
const GATE_MIN_RUNNER_RATE_PCT = 10;  // G4: EARLY_RUNNER / total >= this
const GATE_MIN_DECAY_COVERAGE = 10;   // G5: EARLY_RUNNERs with a 15m snapshot
const GATE_MIN_RUNNER_AVG_GAIN = 40;  // G6: EARLY_RUNNER avg bestGainPct
const GATE_MIN_ENRICHED = 5;          // G7: tokens with safety enrichment records
const GATE_MIN_QUOTE_COVERAGE = 10;   // G8: tokens with quote/slippage checks (HARD BLOCKER)

function fmtPct(v: number | null | undefined, d = 1): string {
  if (v == null) return '-';
  return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
}

function avg(vs: number[]): number | null {
  return vs.length === 0 ? null : vs.reduce((a, b) => a + b, 0) / vs.length;
}

type GateResult = 'PASS' | 'FAIL' | 'WARN';

interface Gate {
  id: string;
  label: string;
  result: GateResult;
  actual: string;
  threshold: string;
  note: string;
}

type ReadinessVerdict = 'NOT_READY' | 'APPROACHING' | 'READY_TO_CONSIDER';

export interface PaperReadinessReport {
  // Signal analysis summary
  totalClassified: number;
  earlyRunnerCount: number;
  lateRunnerCount: number;
  instantDumpCount: number;
  deadNoiseCount: number;
  tooDangerousCount: number;
  unclassifiedCount: number;
  earlyRunnerRate: number | null;
  dumpRate: number | null;
  earlyRunnerAvgGain: number | null;
  earlyRunnerAvgWorstDraw: number | null;

  // Decay coverage
  earlyRunnersWithDecay15m: number;
  decayCoverage15mPct: number | null;

  // Data quality
  totalWatchCandidates: number;
  enrichedCount: number;
  quoteCheckedCount: number;

  // Config state (informational)
  tradingDisabled: boolean;
  enableRealBuys: boolean;
  enableRealSells: boolean;
  enableAutoPaperTrading: boolean;
  enableSolanaSafetyEnrichment: boolean;
  enableQuoteCheck: boolean;

  // Positions
  openPaperPositions: number;
  totalPaperPositions: number;

  // Readiness gates
  gates: Gate[];
  passCount: number;
  verdict: ReadinessVerdict;
  verdictReason: string;

  // What's missing
  gaps: string[];
  nextSteps: string[];

  noTradingBehaviorChanged: true;
}

export function buildPaperReadinessReport(db: AppDb, config: AppConfig): PaperReadinessReport {
  const sql = db.sqlite;

  // ── Signal analysis distribution ──────────────────────────
  const classRows = sql.prepare(`
    SELECT signal_class, COUNT(*) AS cnt,
      AVG(best_gain_pct) AS avg_gain,
      AVG(worst_drawdown_pct) AS avg_draw
    FROM watch_only_signal_analysis
    GROUP BY signal_class
  `).all() as Array<{ signal_class: string; cnt: number; avg_gain: number | null; avg_draw: number | null }>;

  const byClass = (cls: string) => classRows.find((r) => r.signal_class === cls);
  const earlyRow = byClass('EARLY_RUNNER');
  const lateRow = byClass('LATE_RUNNER');
  const dumpRow = byClass('INSTANT_DUMP');
  const noiseRow = byClass('DEAD_NOISE');
  const dangerRow = byClass('TOO_DANGEROUS');

  const earlyRunnerCount = earlyRow?.cnt ?? 0;
  const lateRunnerCount = lateRow?.cnt ?? 0;
  const instantDumpCount = dumpRow?.cnt ?? 0;
  const deadNoiseCount = noiseRow?.cnt ?? 0;
  const tooDangerousCount = dangerRow?.cnt ?? 0;
  const totalClassified = classRows.reduce((s, r) => s + r.cnt, 0);

  // Total watch-only candidates (may have some without signal analysis)
  const wcRow = sql.prepare('SELECT COUNT(*) AS cnt FROM watch_only_candidates').get() as { cnt: number };
  const totalWatchCandidates = wcRow.cnt;
  const unclassifiedCount = Math.max(0, totalWatchCandidates - totalClassified);

  const earlyRunnerRate = totalClassified > 0 ? (earlyRunnerCount / totalClassified) * 100 : null;
  const dumpRate = totalClassified > 0 ? (instantDumpCount / totalClassified) * 100 : null;
  const earlyRunnerAvgGain = earlyRow?.avg_gain ?? null;
  const earlyRunnerAvgWorstDraw = earlyRow?.avg_draw ?? null;

  // ── Decay coverage for EARLY_RUNNER ───────────────────────
  // Count EARLY_RUNNER watch candidates that have at least one outcome at ~15m
  const decayRow = sql.prepare(`
    SELECT COUNT(DISTINCT wsa.id) AS cnt
    FROM watch_only_signal_analysis wsa
    JOIN watch_only_outcomes wo ON wo.watch_candidate_id = wsa.watch_candidate_id
    WHERE wsa.signal_class = 'EARLY_RUNNER'
      AND wo.target_minutes = 15
  `).get() as { cnt: number };
  const earlyRunnersWithDecay15m = decayRow.cnt;
  const decayCoverage15mPct =
    earlyRunnerCount > 0 ? (earlyRunnersWithDecay15m / earlyRunnerCount) * 100 : null;

  // ── Safety enrichment coverage ─────────────────────────────
  let enrichedCount = 0;
  try {
    const enrichRow = sql.prepare(
      'SELECT COUNT(DISTINCT token_id) AS cnt FROM solana_safety_enrichments'
    ).get() as { cnt: number };
    enrichedCount = enrichRow.cnt;
  } catch {
    // table may not be populated
  }

  let quoteCheckedCount = 0;
  try {
    const quoteRow = sql.prepare(
      'SELECT COUNT(DISTINCT token_id) AS cnt FROM quote_sellability_checks'
    ).get() as { cnt: number };
    quoteCheckedCount = quoteRow.cnt;
  } catch {
    // table may not be populated
  }

  // ── Position counts ─────────────────────────────────────────
  let openPaperPositions = 0;
  let totalPaperPositions = 0;
  try {
    const openRow = sql.prepare(
      "SELECT COUNT(*) AS cnt FROM positions WHERE position_type = 'PAPER' AND status = 'OPEN'"
    ).get() as { cnt: number };
    const totalRow = sql.prepare(
      "SELECT COUNT(*) AS cnt FROM positions WHERE position_type = 'PAPER'"
    ).get() as { cnt: number };
    openPaperPositions = openRow.cnt;
    totalPaperPositions = totalRow.cnt;
  } catch {
    // table may be empty
  }

  // ── Readiness gates ─────────────────────────────────────────
  const gates: Gate[] = [
    {
      id: 'G1',
      label: 'Signal analysis volume',
      result: totalClassified >= GATE_MIN_CLASSIFIED ? 'PASS' : 'FAIL',
      actual: `${totalClassified} classified`,
      threshold: `>= ${GATE_MIN_CLASSIFIED}`,
      note: 'Need enough history to see a pattern — not just lucky outliers.',
    },
    {
      id: 'G2',
      label: 'EARLY_RUNNER sample size',
      result: earlyRunnerCount >= GATE_MIN_EARLY_RUNNERS ? 'PASS' : 'FAIL',
      actual: `${earlyRunnerCount} EARLY_RUNNER`,
      threshold: `>= ${GATE_MIN_EARLY_RUNNERS}`,
      note: 'Need enough clean-discovery runners to estimate a reliable entry profile.',
    },
    {
      id: 'G3',
      label: 'Dump rate acceptable',
      result:
        dumpRate === null ? 'WARN'
        : dumpRate < GATE_MAX_DUMP_RATE_PCT ? 'PASS'
        : 'FAIL',
      actual: dumpRate !== null ? `${dumpRate.toFixed(0)}% INSTANT_DUMP` : 'no data',
      threshold: `< ${GATE_MAX_DUMP_RATE_PCT}%`,
      note: 'High dump rate means most candidates would stop-out — unsustainable even with a good signal.',
    },
    {
      id: 'G4',
      label: 'Signal separation (runner rate)',
      result:
        earlyRunnerRate === null ? 'WARN'
        : earlyRunnerRate >= GATE_MIN_RUNNER_RATE_PCT ? 'PASS'
        : 'FAIL',
      actual: earlyRunnerRate !== null ? `${earlyRunnerRate.toFixed(0)}% EARLY_RUNNER rate` : 'no data',
      threshold: `>= ${GATE_MIN_RUNNER_RATE_PCT}%`,
      note: 'Signal drowning in noise means random entry would do as well.',
    },
    {
      id: 'G5',
      label: 'Decay snapshot coverage',
      result: earlyRunnersWithDecay15m >= GATE_MIN_DECAY_COVERAGE ? 'PASS' : 'FAIL',
      actual: `${earlyRunnersWithDecay15m} EARLY_RUNNERs with 15m outcome`,
      threshold: `>= ${GATE_MIN_DECAY_COVERAGE}`,
      note: 'Need 15m snapshots to know if gains hold — peak gain alone could be noise.',
    },
    {
      id: 'G6',
      label: 'EARLY_RUNNER average gain',
      result:
        earlyRunnerAvgGain === null ? 'WARN'
        : earlyRunnerAvgGain >= GATE_MIN_RUNNER_AVG_GAIN ? 'PASS'
        : 'FAIL',
      actual:
        earlyRunnerAvgGain !== null ? `avg ${fmtPct(earlyRunnerAvgGain, 0)}` : 'no data',
      threshold: `avg >= +${GATE_MIN_RUNNER_AVG_GAIN}%`,
      note: 'Gains must cover expected costs (slippage, timing, false starts).',
    },
    {
      id: 'G7',
      label: 'Safety enrichment active and populated',
      result: config.enableSolanaSafetyEnrichment && enrichedCount >= GATE_MIN_ENRICHED ? 'PASS' : 'FAIL',
      actual: `ENABLE_SOLANA_SAFETY_ENRICHMENT=${config.enableSolanaSafetyEnrichment}, ${enrichedCount} enriched`,
      threshold: `flag=true and >= ${GATE_MIN_ENRICHED} enriched tokens`,
      note: 'Mint/freeze authority unknown without enrichment — would enter on ruggable tokens.',
    },
    {
      id: 'G8',
      label: 'Quote/slippage check active and populated [HARD BLOCKER]',
      result: config.enableQuoteCheck && quoteCheckedCount >= GATE_MIN_QUOTE_COVERAGE ? 'PASS' : 'FAIL',
      actual: `ENABLE_QUOTE_CHECK=${config.enableQuoteCheck}, ${quoteCheckedCount} quote-checked`,
      threshold: `flag=true and >= ${GATE_MIN_QUOTE_COVERAGE} tokens quote-checked`,
      note: 'Sell route and slippage unknown without quote checks — cannot confirm tokens are tradable. READY_TO_CONSIDER requires this gate to pass.',
    },
  ];

  const passCount = gates.filter((g) => g.result === 'PASS').length;
  const failCount = gates.filter((g) => g.result === 'FAIL').length;
  // G8 (quote/slippage) is a hard blocker: verdict cannot reach READY_TO_CONSIDER if it fails
  const quoteBlocker = gates.find((g) => g.id === 'G8')?.result !== 'PASS';

  let verdict: ReadinessVerdict;
  let verdictReason: string;

  if (passCount <= 3) {
    verdict = 'NOT_READY';
    verdictReason = `${failCount} of ${gates.length} readiness gates failing. Insufficient evidence — continue accumulating watch-only history.`;
  } else if (passCount <= 6 || quoteBlocker) {
    verdict = 'APPROACHING';
    if (quoteBlocker && passCount >= 7) {
      verdictReason = `${passCount} of ${gates.length} readiness gates passing, but G8 (quote/slippage coverage) is a hard blocker. ` +
        'Cannot reach READY_TO_CONSIDER without complete quote and slippage data.';
    } else {
      verdictReason = `${passCount} of ${gates.length} readiness gates passing. Evidence is building but key gaps remain.`;
    }
  } else {
    verdict = 'READY_TO_CONSIDER';
    verdictReason = `${passCount} of ${gates.length} readiness gates passing. Evidence level is sufficient to consider a tiny paper test window — but this is a human decision, not automatic enablement.`;
  }

  // ── Gaps & next steps ───────────────────────────────────────
  const gaps: string[] = [];
  const nextSteps: string[] = [];

  if (totalClassified < GATE_MIN_CLASSIFIED) {
    gaps.push(`Only ${totalClassified} candidates classified — need ${GATE_MIN_CLASSIFIED - totalClassified} more. Run more watch cycles.`);
    nextSteps.push('Run token:watch-cycle or token:watch-loop to accumulate more candidates.');
    nextSteps.push('Run token:watch-analysis after each batch to classify new candidates.');
  }
  if (earlyRunnerCount < GATE_MIN_EARLY_RUNNERS) {
    gaps.push(`Only ${earlyRunnerCount} EARLY_RUNNER — need ${GATE_MIN_EARLY_RUNNERS - earlyRunnerCount} more clean-discovery runners.`);
  }
  if (dumpRate !== null && dumpRate >= GATE_MAX_DUMP_RATE_PCT) {
    gaps.push(`Dump rate ${dumpRate.toFixed(0)}% is high — review scanner quality, filter criteria, or time-of-day patterns.`);
  }
  if (earlyRunnersWithDecay15m < GATE_MIN_DECAY_COVERAGE) {
    gaps.push(`Only ${earlyRunnersWithDecay15m} EARLY_RUNNERs have 15m decay snapshots — need ${GATE_MIN_DECAY_COVERAGE - earlyRunnersWithDecay15m} more.`);
    nextSteps.push('Run token:early-refresh-plan --run regularly to capture 15m/30m/60m snapshots.');
    nextSteps.push('Or run token:watch-refresh to catch active movers.');
  }
  // G7: safety enrichment
  if (gates.find((g) => g.id === 'G7')?.result !== 'PASS') {
    if (!config.enableSolanaSafetyEnrichment) {
      gaps.push('ENABLE_SOLANA_SAFETY_ENRICHMENT=false — mint/freeze authority unknown for most candidates.');
      nextSteps.push('Set ENABLE_SOLANA_SAFETY_ENRICHMENT=true to populate authority data before paper.');
    } else {
      gaps.push(`Only ${enrichedCount} safety-enriched tokens — run token:safety-enrich to build coverage.`);
    }
  }
  // G8: quote/slippage coverage — hard blocker, always emit specific text
  if (quoteBlocker) {
    gaps.push(
      'Quote/slippage verification is incomplete. Enable quote checks and collect sellability/slippage coverage before paper readiness.'
    );
    if (!config.enableQuoteCheck) {
      nextSteps.push('Set ENABLE_QUOTE_CHECK=true to populate slippage and sell-route data before paper.');
    } else {
      nextSteps.push(
        `Run token:quote-check to build sellability coverage (${quoteCheckedCount} tokens checked — need >= ${GATE_MIN_QUOTE_COVERAGE}).`
      );
    }
  }
  if (earlyRunnerAvgGain !== null && earlyRunnerAvgGain < GATE_MIN_RUNNER_AVG_GAIN) {
    gaps.push(`EARLY_RUNNER avg gain ${fmtPct(earlyRunnerAvgGain, 0)} is below +${GATE_MIN_RUNNER_AVG_GAIN}% threshold — gains may not justify entry costs.`);
  }
  if (earlyRunnerRate !== null && earlyRunnerRate < GATE_MIN_RUNNER_RATE_PCT) {
    gaps.push(`EARLY_RUNNER rate ${earlyRunnerRate.toFixed(0)}% is below ${GATE_MIN_RUNNER_RATE_PCT}% — signal is too noisy relative to DEAD_NOISE.`);
  }

  // Always add these forward-looking steps
  nextSteps.push('Run token:historical-winner-autopsy to review winner signal profiles in detail.');
  nextSteps.push('Run token:decay-rate to see 15m/30m/60m survival rates by signal class.');
  nextSteps.push('Run token:dump-risk-profile to compare EARLY_RUNNER vs INSTANT_DUMP entry signals.');
  if (verdict === 'READY_TO_CONSIDER') {
    nextSteps.push('If enabling paper: set ENABLE_AUTO_PAPER_TRADING=true, keep MAX_AUTO_PAPER_BUY_USD=$2, TRADING_DISABLED=true for first review cycle.');
    nextSteps.push('Monitor token:paper-dashboard and token:paper-autopsy daily for the first week.');
  }

  return {
    totalClassified,
    earlyRunnerCount,
    lateRunnerCount,
    instantDumpCount,
    deadNoiseCount,
    tooDangerousCount,
    unclassifiedCount,
    earlyRunnerRate,
    dumpRate,
    earlyRunnerAvgGain,
    earlyRunnerAvgWorstDraw,
    earlyRunnersWithDecay15m,
    decayCoverage15mPct,
    totalWatchCandidates,
    enrichedCount,
    quoteCheckedCount,
    tradingDisabled: config.tradingDisabled,
    enableRealBuys: config.enableRealBuys,
    enableRealSells: config.enableRealSells,
    enableAutoPaperTrading: config.enableAutoPaperTrading,
    enableSolanaSafetyEnrichment: config.enableSolanaSafetyEnrichment,
    enableQuoteCheck: config.enableQuoteCheck,
    openPaperPositions,
    totalPaperPositions,
    gates,
    passCount,
    verdict,
    verdictReason,
    gaps,
    nextSteps: [...new Set(nextSteps)],
    noTradingBehaviorChanged: true,
  };
}

export function renderPaperReadinessReport(report: PaperReadinessReport): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  const verdictIcon =
    report.verdict === 'NOT_READY' ? '✗'
    : report.verdict === 'APPROACHING' ? '◑'
    : '✓';

  // ── 1. Header ──────────────────────────────────────────────
  lines.push('Paper Readiness Report');
  lines.push(sep);
  lines.push('Purpose: go/no-go diagnostic for tiny paper trading readiness.');
  lines.push('This report does NOT enable paper trading. It only evaluates evidence.');
  lines.push('');
  lines.push(`Verdict:  ${verdictIcon}  ${report.verdict}`);
  lines.push(`          ${report.verdictReason}`);
  lines.push('');

  // ── 2. Readiness Gates ────────────────────────────────────
  lines.push('Readiness Gates');
  lines.push(sep);
  lines.push(`  ${report.passCount} of ${report.gates.length} gates passing`);
  lines.push('');

  for (const g of report.gates) {
    const icon = g.result === 'PASS' ? '[PASS]' : g.result === 'WARN' ? '[WARN]' : '[FAIL]';
    lines.push(`  ${icon}  ${g.id}  ${g.label}`);
    lines.push(`         actual:    ${g.actual}`);
    lines.push(`         required:  ${g.threshold}`);
    lines.push(`         note:      ${g.note}`);
    lines.push('');
  }

  // ── 3. Signal Analysis Summary ────────────────────────────
  lines.push('Watch-Only Signal Analysis Summary');
  lines.push(sep);
  lines.push(`  Total watch candidates:  ${report.totalWatchCandidates}`);
  lines.push(`  Classified:              ${report.totalClassified}`);
  lines.push(`  Unclassified:            ${report.unclassifiedCount}`);
  lines.push('');

  const FW = 18;
  const NW = 8;
  const PW = 8;
  lines.push(`  ${'Class'.padEnd(FW)} ${'Count'.padStart(NW)} ${'Rate'.padStart(PW)}`);
  lines.push('  ' + '─'.repeat(FW + NW + PW + 2));

  const classRows: Array<[string, number]> = [
    ['EARLY_RUNNER', report.earlyRunnerCount],
    ['LATE_RUNNER', report.lateRunnerCount],
    ['INSTANT_DUMP', report.instantDumpCount],
    ['DEAD_NOISE', report.deadNoiseCount],
    ['TOO_DANGEROUS', report.tooDangerousCount],
  ];
  for (const [cls, cnt] of classRows) {
    const pct = report.totalClassified > 0 ? `${((cnt / report.totalClassified) * 100).toFixed(0)}%` : '-';
    lines.push(`  ${cls.padEnd(FW)} ${String(cnt).padStart(NW)} ${pct.padStart(PW)}`);
  }
  lines.push('');
  lines.push(`  EARLY_RUNNER avg gain:       ${report.earlyRunnerAvgGain !== null ? `${report.earlyRunnerAvgGain.toFixed(0)}%` : '-'}`);
  lines.push(`  EARLY_RUNNER avg worst draw: ${report.earlyRunnerAvgWorstDraw !== null ? `${report.earlyRunnerAvgWorstDraw.toFixed(0)}%` : '-'}`);
  lines.push(`  EARLY_RUNNER with 15m decay: ${report.earlyRunnersWithDecay15m}` +
    (report.decayCoverage15mPct !== null ? ` (${report.decayCoverage15mPct.toFixed(0)}% of EARLY_RUNNERs)` : ''));
  lines.push('');

  // ── 4. Data Quality ───────────────────────────────────────
  lines.push('Data Quality');
  lines.push(sep);
  lines.push(`  Safety enrichment records: ${report.enrichedCount}`);
  lines.push(`  Quote check records:       ${report.quoteCheckedCount}`);
  lines.push(`  ENABLE_SOLANA_SAFETY_ENRICHMENT: ${report.enableSolanaSafetyEnrichment}`);
  lines.push(`  ENABLE_QUOTE_CHECK:              ${report.enableQuoteCheck}`);
  lines.push('');

  // ── 5. Config State (informational) ───────────────────────
  lines.push('Config State (informational — no changes recommended here)');
  lines.push(sep);
  lines.push(`  TRADING_DISABLED:          ${report.tradingDisabled}`);
  lines.push(`  ENABLE_REAL_BUYS:          ${report.enableRealBuys}`);
  lines.push(`  ENABLE_REAL_SELLS:         ${report.enableRealSells}`);
  lines.push(`  ENABLE_AUTO_PAPER_TRADING: ${report.enableAutoPaperTrading}`);
  lines.push(`  Open paper positions:      ${report.openPaperPositions}`);
  lines.push(`  Total paper positions:     ${report.totalPaperPositions}`);
  lines.push('');

  // ── 6. Gaps ───────────────────────────────────────────────
  lines.push('Gaps Before Paper Trading');
  lines.push(sep);
  if (report.gaps.length === 0) {
    lines.push('  (no critical gaps identified)');
  } else {
    for (const g of report.gaps) lines.push(`  • ${g}`);
  }
  lines.push('');

  // ── 7. Next Steps ─────────────────────────────────────────
  lines.push('Suggested Next Steps (research only)');
  lines.push(sep);
  for (const s of report.nextSteps) lines.push(`  → ${s}`);
  lines.push('');

  // ── 8. Safety Footer ─────────────────────────────────────
  lines.push(sep);
  lines.push('Safety');
  lines.push(sep);
  lines.push('  Report only. No DB writes. No network calls. No proposals created.');
  lines.push('  No trading behavior changed. No thresholds changed. No filters loosened.');
  lines.push('  Real trading remains locked.');

  return lines.join('\n');
}
