import fs from 'node:fs';
import path from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RejectionPattern =
  | 'FLAT_NO_MOMENTUM'
  | 'LIQUIDITY_DRAIN_CHURN'
  | 'LOW_LIQUIDITY'
  | 'WEAK_MOMENTUM'
  | 'MISSING_CONFIRMATION'
  | 'OTHER';

export interface FieldRunRow {
  ts: string;
  tokenSelected?: string;
  candidatesCount?: number;
  watchWorthyCount?: number;
  verdict?: string;
  priceChangePct?: number;
  liquidityChangePct?: number;
  confirmedLiquidityUsd?: number;
  entryVolumeToLiquidityRatio?: number;
  confirmVolumeToLiquidityRatio?: number;
  hasPlan: boolean;
  paperExitGuardRan: boolean;
  exitReason?: string;
  fakePnLPct?: number;
  rejectionPattern?: RejectionPattern;
}

export interface FieldRunAggregate {
  totalRuns: number;
  rejectedCount: number;
  planOnlyCount: number;
  missingConfirmationCount: number;
  rejectedPriceWeakCount: number;
  rejectedLiquidityLowCount: number;
  rejectedLiquidityWeakCount: number;
  rejectedDrawdownCount: number;
  paperExitGuardRuns: number;
  exitReasonCounts: Record<string, number>;
  winnersCount: number;
  losersCount: number;
  flatCount: number;
  rejectionPatternCounts: Record<RejectionPattern, number>;
}

export interface FieldRunSummary {
  directory: string;
  runCount: number;
  tsRange: { earliest: string; latest: string } | null;
  generatedAt: string;
  readOnly: true;
  tradingExecuted: 0;
  rows: FieldRunRow[];
  aggregate: FieldRunAggregate;
  recommendation: string;
}

// ── File parsing helpers ──────────────────────────────────────────────────────

/**
 * Parses session timestamp from a session filename like session-YYYYMMDD-HHMM.json.
 * Returns null if the filename does not match the expected pattern.
 * Pure — no I/O.
 */
export function parseSessionTimestamp(filename: string): string | null {
  const m = filename.match(/^session-(\d{8}-\d{4})\.json$/);
  return m ? (m[1] ?? null) : null;
}

/**
 * Lists session base timestamps in the given directory, sorted ascending.
 * Reads directory only — does not mutate any files.
 */
export function listSessionTimestamps(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const tsList: string[] = [];
  for (const name of entries) {
    const ts = parseSessionTimestamp(name);
    if (ts) tsList.push(ts);
  }
  return tsList.sort();
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Rejection pattern classifier ─────────────────────────────────────────────

/**
 * Classifies a run's rejection into a pattern label.
 * Pure — no I/O, no side effects.
 */
export function classifyRejectionPattern(
  verdict: string | undefined,
  priceChangePct: number | undefined,
  liquidityChangePct: number | undefined,
  confirmedLiquidityUsd: number | undefined,
  entryVLR: number | undefined,
  confirmVLR: number | undefined,
): RejectionPattern {
  if (verdict === 'REJECTED_MISSING_SNAPSHOT' || verdict === undefined) {
    return 'MISSING_CONFIRMATION';
  }
  if (verdict === 'CONFIRMED') return 'OTHER';

  // LOW_LIQUIDITY: confirmed liq below $2500
  if (confirmedLiquidityUsd != null && confirmedLiquidityUsd < 2500) {
    return 'LOW_LIQUIDITY';
  }

  // LIQUIDITY_DRAIN_CHURN: liquidity fell >= 25% and vol/liq ratio increased (more churn)
  if (
    liquidityChangePct != null &&
    liquidityChangePct <= -25 &&
    entryVLR != null &&
    confirmVLR != null &&
    confirmVLR > entryVLR
  ) {
    return 'LIQUIDITY_DRAIN_CHURN';
  }

  // FLAT_NO_MOMENTUM: price near 0 and liquidity near 0
  if (
    priceChangePct != null &&
    Math.abs(priceChangePct) < 2 &&
    (liquidityChangePct == null || Math.abs(liquidityChangePct) < 2)
  ) {
    return 'FLAT_NO_MOMENTUM';
  }

  // WEAK_MOMENTUM: some price gain but below threshold
  if (priceChangePct != null && priceChangePct > 0) {
    return 'WEAK_MOMENTUM';
  }

  return 'OTHER';
}

// ── Per-run loader ────────────────────────────────────────────────────────────

interface SessionFile {
  candidates?: Array<{ tokenName?: string; ticker?: string }>;
  summary?: { earlyVelocityWatch?: number; freshLaunchCandidates?: number; rejectedNoise?: number };
}

interface SnapshotArray extends Array<{
  candidateId?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
}> {}

interface PlanFile {
  status?: string;
  entryPrice?: number;
  ticker?: string;
  tokenName?: string;
  qualityDiagnostics?: {
    pricePass?: boolean;
    liquidityGrowthPass?: boolean;
    confirmedLiquidityPass?: boolean;
    drawdownPass?: boolean;
    entryVolumeToLiquidityRatio?: number;
    confirmVolumeToLiquidityRatio?: number;
    overallPass?: boolean;
  };
}

/**
 * Loads all data for one session timestamp and returns a FieldRunRow.
 * Tolerant of missing files — each missing file contributes nulls.
 * Reads files only — does not mutate.
 */
export function loadFieldRunRow(dir: string, ts: string): FieldRunRow {
  const sessionPath = path.join(dir, `session-${ts}.json`);
  const entryPath = path.join(dir, `session-${ts}-entry.json`);
  const confirmPath = path.join(dir, `session-${ts}-confirm.json`);
  const planPath = path.join(dir, `plan-${ts}.json`);
  const exitPath = path.join(dir, `session-${ts}-exit.json`);

  const session = readJsonFile<SessionFile>(sessionPath);
  const entrySnaps = readJsonFile<SnapshotArray>(entryPath);
  const confirmSnaps = readJsonFile<SnapshotArray>(confirmPath);
  const plan = readJsonFile<PlanFile>(planPath);
  const exitSnaps = readJsonFile<SnapshotArray>(exitPath);

  // Derive candidate count and watch-worthy count from session
  const candidates = session?.candidates ?? [];
  const candidatesCount = candidates.length > 0 ? candidates.length : undefined;
  const watchWorthyCount = session?.summary
    ? (session.summary.earlyVelocityWatch ?? 0) + (session.summary.freshLaunchCandidates ?? 0)
    : undefined;

  // Token selected: first entry snapshot's candidate, cross-referenced with session candidates
  let tokenSelected: string | undefined;
  const entrySnap = entrySnaps?.[0];
  if (entrySnap?.candidateId) {
    const match = candidates.find((c) => {
      const cAny = c as Record<string, unknown>;
      return cAny['id'] === entrySnap.candidateId;
    });
    const matchAny = match as Record<string, unknown> | undefined;
    tokenSelected = (matchAny?.['ticker'] as string | undefined) ?? (matchAny?.['tokenName'] as string | undefined);
  }
  // Also check plan for token info
  if (!tokenSelected && plan?.ticker) tokenSelected = plan.ticker;

  // Confirmation data
  const confirmSnap = confirmSnaps?.[0];
  const entrySnap0 = entrySnaps?.[0];

  let priceChangePct: number | undefined;
  let liquidityChangePct: number | undefined;
  let confirmedLiquidityUsd: number | undefined;
  let entryVolumeToLiquidityRatio: number | undefined;
  let confirmVolumeToLiquidityRatio: number | undefined;

  if (entrySnap0?.priceUsd && confirmSnap?.priceUsd) {
    priceChangePct = ((confirmSnap.priceUsd - entrySnap0.priceUsd) / entrySnap0.priceUsd) * 100;
  }
  if (entrySnap0?.liquidityUsd && confirmSnap?.liquidityUsd != null) {
    liquidityChangePct = ((confirmSnap.liquidityUsd - entrySnap0.liquidityUsd) / entrySnap0.liquidityUsd) * 100;
  }
  if (confirmSnap?.liquidityUsd != null) {
    confirmedLiquidityUsd = confirmSnap.liquidityUsd;
  }
  if (entrySnap0?.volumeUsd != null && entrySnap0.liquidityUsd != null && entrySnap0.liquidityUsd > 0) {
    entryVolumeToLiquidityRatio = entrySnap0.volumeUsd / entrySnap0.liquidityUsd;
  }
  if (confirmSnap?.volumeUsd != null && confirmSnap.liquidityUsd != null && confirmSnap.liquidityUsd > 0) {
    confirmVolumeToLiquidityRatio = confirmSnap.volumeUsd / confirmSnap.liquidityUsd;
  }

  // Use qualityDiagnostics from plan if richer (plan-confirmed runs have this)
  if (plan?.qualityDiagnostics) {
    const d = plan.qualityDiagnostics;
    if (d.entryVolumeToLiquidityRatio != null) entryVolumeToLiquidityRatio = d.entryVolumeToLiquidityRatio;
    if (d.confirmVolumeToLiquidityRatio != null) confirmVolumeToLiquidityRatio = d.confirmVolumeToLiquidityRatio;
  }

  // Verdict: derive from presence of data
  let verdict: string | undefined;
  if (plan?.status === 'PLAN_ONLY') {
    verdict = 'CONFIRMED';
  } else if (confirmSnaps === null) {
    verdict = undefined; // missing confirmation file
  } else if (!confirmSnap?.priceUsd) {
    verdict = 'REJECTED_MISSING_SNAPSHOT';
  } else if (priceChangePct != null && confirmedLiquidityUsd != null) {
    // Reconstruct verdict logic from thresholds (20% price, $2500 liq, 10% liq growth)
    if (confirmedLiquidityUsd < 2500) {
      verdict = 'REJECTED_CONFIRMED_LIQUIDITY_LOW';
    } else if (liquidityChangePct != null && liquidityChangePct < 0) {
      verdict = 'REJECTED_LIQUIDITY_FADE';
    } else if (liquidityChangePct != null && liquidityChangePct < 10) {
      verdict = 'REJECTED_CONFIRMED_LIQUIDITY_WEAK';
    } else if (priceChangePct < 0) {
      verdict = 'REJECTED_PRICE_DRAWDOWN';
    } else if (priceChangePct < 20) {
      verdict = 'REJECTED_PRICE_WEAK';
    } else {
      verdict = 'CONFIRMED';
    }
  } else if (priceChangePct != null) {
    verdict = priceChangePct < 20 ? 'REJECTED_PRICE_WEAK' : 'CONFIRMED';
  }

  const hasPlan = plan?.status === 'PLAN_ONLY';

  // Exit / Paper Exit Guard
  const exitSnap = exitSnaps?.[0];
  const paperExitGuardRan = exitSnaps !== null && exitSnap != null && hasPlan;

  let exitReason: string | undefined;
  let fakePnLPct: number | undefined;

  if (hasPlan && exitSnap?.priceUsd && plan?.entryPrice) {
    fakePnLPct = ((exitSnap.priceUsd - plan.entryPrice) / plan.entryPrice) * 100;
    // Exit reason not stored in file — mark as MAX_HOLD (standard watch-cycle)
    exitReason = 'MAX_HOLD';
  }

  const rejectionPattern =
    verdict !== 'CONFIRMED'
      ? classifyRejectionPattern(
          verdict,
          priceChangePct,
          liquidityChangePct,
          confirmedLiquidityUsd,
          entryVolumeToLiquidityRatio,
          confirmVolumeToLiquidityRatio,
        )
      : undefined;

  return {
    ts,
    tokenSelected,
    candidatesCount,
    watchWorthyCount,
    verdict,
    priceChangePct,
    liquidityChangePct,
    confirmedLiquidityUsd,
    entryVolumeToLiquidityRatio,
    confirmVolumeToLiquidityRatio,
    hasPlan,
    paperExitGuardRan,
    exitReason,
    fakePnLPct,
    rejectionPattern,
  };
}

// ── Aggregation ───────────────────────────────────────────────────────────────

/**
 * Aggregates a list of FieldRunRows into summary counts.
 * Pure — no I/O, no side effects.
 */
export function aggregateFieldRuns(rows: FieldRunRow[]): FieldRunAggregate {
  const agg: FieldRunAggregate = {
    totalRuns: rows.length,
    rejectedCount: 0,
    planOnlyCount: 0,
    missingConfirmationCount: 0,
    rejectedPriceWeakCount: 0,
    rejectedLiquidityLowCount: 0,
    rejectedLiquidityWeakCount: 0,
    rejectedDrawdownCount: 0,
    paperExitGuardRuns: 0,
    exitReasonCounts: {},
    winnersCount: 0,
    losersCount: 0,
    flatCount: 0,
    rejectionPatternCounts: {
      FLAT_NO_MOMENTUM: 0,
      LIQUIDITY_DRAIN_CHURN: 0,
      LOW_LIQUIDITY: 0,
      WEAK_MOMENTUM: 0,
      MISSING_CONFIRMATION: 0,
      OTHER: 0,
    },
  };

  for (const row of rows) {
    if (row.hasPlan) {
      agg.planOnlyCount++;
    } else {
      agg.rejectedCount++;
    }

    if (!row.verdict || row.verdict === 'REJECTED_MISSING_SNAPSHOT') {
      agg.missingConfirmationCount++;
    }
    if (row.verdict === 'REJECTED_PRICE_WEAK' || row.verdict === 'REJECTED_PRICE_DRAWDOWN') {
      agg.rejectedPriceWeakCount++;
    }
    if (row.verdict === 'REJECTED_CONFIRMED_LIQUIDITY_LOW') {
      agg.rejectedLiquidityLowCount++;
    }
    if (row.verdict === 'REJECTED_CONFIRMED_LIQUIDITY_WEAK' || row.verdict === 'REJECTED_LIQUIDITY_FADE') {
      agg.rejectedLiquidityWeakCount++;
    }
    if (row.verdict === 'REJECTED_PRICE_DRAWDOWN') {
      agg.rejectedDrawdownCount++;
    }

    if (row.paperExitGuardRan) {
      agg.paperExitGuardRuns++;
    }

    if (row.exitReason) {
      agg.exitReasonCounts[row.exitReason] = (agg.exitReasonCounts[row.exitReason] ?? 0) + 1;
    }

    if (row.fakePnLPct != null) {
      if (row.fakePnLPct > 1) agg.winnersCount++;
      else if (row.fakePnLPct < -1) agg.losersCount++;
      else agg.flatCount++;
    }

    if (row.rejectionPattern) {
      agg.rejectionPatternCounts[row.rejectionPattern]++;
    }
  }

  return agg;
}

// ── Recommendation ────────────────────────────────────────────────────────────

/**
 * Produces a recommendation string from aggregate data.
 * Pure — no I/O, no side effects.
 */
export function deriveRecommendation(agg: FieldRunAggregate): string {
  if (agg.planOnlyCount === 0) {
    return 'No confirmed entries in this batch. Do not loosen thresholds from this alone; collect later-window data or expand sources.';
  }
  if (agg.losersCount > agg.winnersCount) {
    return 'Review exit guard intervals/rules before live execution.';
  }
  return 'Continue dry-run evidence collection; do not enable live execution yet.';
}

// ── Report builder ────────────────────────────────────────────────────────────

export interface BuildFieldRunSummaryInput {
  dir: string;
  limit: number;
  since?: string;
  generatedAt: string;
}

/**
 * Builds the full FieldRunSummary from disk.
 * Read-only — never mutates files.
 */
export function buildFieldRunSummary(input: BuildFieldRunSummaryInput): FieldRunSummary {
  const { dir, limit, since, generatedAt } = input;

  let tsList = listSessionTimestamps(dir);

  if (since) {
    tsList = tsList.filter((ts) => ts >= since);
  }

  // Most recent N
  if (tsList.length > limit) {
    tsList = tsList.slice(tsList.length - limit);
  }

  const rows = tsList.map((ts) => loadFieldRunRow(dir, ts));

  const tsRange =
    tsList.length > 0
      ? { earliest: tsList[0]!, latest: tsList[tsList.length - 1]! }
      : null;

  const aggregate = aggregateFieldRuns(rows);
  const recommendation = deriveRecommendation(aggregate);

  return {
    directory: dir,
    runCount: rows.length,
    tsRange,
    generatedAt,
    readOnly: true,
    tradingExecuted: 0,
    rows,
    aggregate,
    recommendation,
  };
}

// ── Text renderer ─────────────────────────────────────────────────────────────

/**
 * Renders the FieldRunSummary as a human-readable terminal report.
 * Pure — no I/O, no side effects.
 */
export function renderFieldRunSummary(s: FieldRunSummary): string {
  const WIDE = '═'.repeat(72);
  const THIN = '─'.repeat(72);
  const lines: string[] = [];

  lines.push(WIDE);
  lines.push('  TOKEN GRAB FIELD RUN SUMMARY V1');
  lines.push('  READ-ONLY — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push(WIDE);
  lines.push('');

  lines.push(`  Directory    : ${s.directory}`);
  lines.push(`  Runs shown   : ${s.runCount}`);
  if (s.tsRange) {
    lines.push(`  Range        : ${s.tsRange.earliest} → ${s.tsRange.latest}`);
  }
  lines.push(`  Generated at : ${s.generatedAt}`);
  lines.push('');

  // Run table
  lines.push(THIN);
  lines.push('Run Table');
  lines.push(THIN);
  lines.push(
    `  ${'TS'.padEnd(14)} ${'Token'.padEnd(12)} ${'Cands'.padStart(5)} ${'Watch'.padStart(5)} ${'Verdict'.padEnd(34)} ${'PricePct'.padStart(9)} ${'Plan'.padStart(4)} ${'PEG'.padStart(3)} ${'Exit'.padEnd(12)} ${'P/L'.padStart(8)}`
  );
  lines.push('  ' + '─'.repeat(114));

  for (const row of s.rows) {
    const tok = (row.tokenSelected ?? '—').slice(0, 11).padEnd(12);
    const cands = (row.candidatesCount != null ? String(row.candidatesCount) : '—').padStart(5);
    const watch = (row.watchWorthyCount != null ? String(row.watchWorthyCount) : '—').padStart(5);
    const verd = (row.verdict ?? '—').slice(0, 33).padEnd(34);
    const pct =
      row.priceChangePct != null
        ? `${row.priceChangePct >= 0 ? '+' : ''}${row.priceChangePct.toFixed(1)}%`.padStart(9)
        : '—'.padStart(9);
    const plan = (row.hasPlan ? 'YES' : 'no').padStart(4);
    const peg = (row.paperExitGuardRan ? 'YES' : 'no').padStart(3);
    const exit = (row.exitReason ?? '—').slice(0, 11).padEnd(12);
    const pnl =
      row.fakePnLPct != null
        ? `${row.fakePnLPct >= 0 ? '+' : ''}${row.fakePnLPct.toFixed(1)}%`.padStart(8)
        : '—'.padStart(8);

    lines.push(`  ${row.ts.padEnd(14)} ${tok} ${cands} ${watch} ${verd} ${pct} ${plan} ${peg} ${exit} ${pnl}`);
  }
  lines.push('');

  // Aggregates
  lines.push(THIN);
  lines.push('Aggregate Counts');
  lines.push(THIN);
  const a = s.aggregate;
  lines.push(`  Total runs            : ${a.totalRuns}`);
  lines.push(`  Rejected (no plan)    : ${a.rejectedCount}`);
  lines.push(`  PLAN_ONLY             : ${a.planOnlyCount}`);
  lines.push(`  Missing confirmation  : ${a.missingConfirmationCount}`);
  lines.push(`  Rejected price weak   : ${a.rejectedPriceWeakCount}`);
  lines.push(`  Rejected liq low      : ${a.rejectedLiquidityLowCount}`);
  lines.push(`  Rejected liq weak     : ${a.rejectedLiquidityWeakCount}`);
  lines.push(`  Rejected drawdown     : ${a.rejectedDrawdownCount}`);
  lines.push(`  Paper exit guard runs : ${a.paperExitGuardRuns}`);
  if (Object.keys(a.exitReasonCounts).length > 0) {
    lines.push('  Exit reasons:');
    for (const [reason, count] of Object.entries(a.exitReasonCounts)) {
      lines.push(`    ${reason}: ${count}`);
    }
  }
  lines.push(`  Winners (P/L > +1%)   : ${a.winnersCount}`);
  lines.push(`  Losers  (P/L < -1%)   : ${a.losersCount}`);
  lines.push(`  Flat                  : ${a.flatCount}`);
  lines.push('');

  // Rejection patterns
  lines.push(THIN);
  lines.push('Rejection Patterns');
  lines.push(THIN);
  const pc = a.rejectionPatternCounts;
  lines.push(`  FLAT_NO_MOMENTUM      : ${pc.FLAT_NO_MOMENTUM}`);
  lines.push(`  LIQUIDITY_DRAIN_CHURN : ${pc.LIQUIDITY_DRAIN_CHURN}`);
  lines.push(`  LOW_LIQUIDITY         : ${pc.LOW_LIQUIDITY}`);
  lines.push(`  WEAK_MOMENTUM         : ${pc.WEAK_MOMENTUM}`);
  lines.push(`  MISSING_CONFIRMATION  : ${pc.MISSING_CONFIRMATION}`);
  lines.push(`  OTHER                 : ${pc.OTHER}`);
  lines.push('');

  // Recommendation
  lines.push(THIN);
  lines.push('Recommendation');
  lines.push(THIN);
  lines.push(`  ${s.recommendation}`);
  lines.push('');

  lines.push(WIDE);
  lines.push('  READ-ONLY REPORT — NO REAL TRADE SENT — tradingExecuted: 0');
  lines.push('  token:auto-paper was NOT run');
  lines.push(WIDE);

  return lines.join('\n');
}
