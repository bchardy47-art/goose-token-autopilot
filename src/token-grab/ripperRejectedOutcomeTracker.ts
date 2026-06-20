// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  NO_GATE_CHANGES
//
// Rejected Outcome Tracker v1 — a REPORT_ONLY study that teaches the system from
// REJECTED tokens, not only approved paper tokens. It answers: which rejected tokens
// became winners (false rejects), which were correctly rejected (junk/dumps), which
// reject reasons may be too strict, and whether the gates are missing catchable
// winners.
//
// Does NOT change gates/policy/filters. Does NOT mutate any file. Outcome fields
// (priceChangePct/outcomeLabel) are studied as OUTCOMES here — never used as entry
// predictors. UNKNOWN cluster risk is NEVER treated as CLEAN.

import * as fs from 'fs';

import {
  m5ToBand,
  getMaturity,
  M5_BAND_ORDER,
  type M5Band,
  type EvidenceMaturity,
} from './ripperM5EvidenceDashboard';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_PATH = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_TOP_N       = 20;
const PNL_CAP             = 500;

// Outcome thresholds (study parameters — overridable via CLI flags).
const DEFAULT_WIN_PCT     = 10;    // >= → winner
const DEFAULT_BIG_WIN_PCT = 50;    // >= → big winner
const DEFAULT_LOSS_PCT    = -20;   // <= → loser (dump-like)

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

const REJECT_GATE = 'BUY_REJECTED';

// ── Types ───────────────────────────────────────────────────────────────────────

export interface GroupStats {
  key:          string;
  total:        number;
  withOutcome:  number;
  winners:      number;
  bigWinners:   number;
  losers:       number;
  winRate:      number | null;     // winners / withOutcome
  avgPnlCapped: number | null;
  medianPnl:    number | null;
}

export interface RejectSampleRow {
  symbol:         string | null;
  contractPrefix: string;
  pnl:            number;
  m5:             number | null;
  m5Band:         M5Band;
  clusterRisk:    string;
  liquidityBucket: string;
  vlrBucket:      string;
  rejectReason:   string;
  entryDecision:  string;
  outcomeLabel:   string;
}

export type RejectDiagnosis =
  | 'REJECTED_WINNERS_EXIST'
  | 'REJECTS_MOSTLY_JUNK'
  | 'GATES_MAY_BE_TOO_STRICT'
  | 'REJECT_REASON_NEEDS_REVIEW'
  | 'REJECT_OUTCOME_DATA_INCOMPLETE'
  | 'STUDY_ONLY_NO_GATE_CHANGE';

export interface RejectedOutcomeTrackerResult {
  generatedAt: string;

  winPct:    number;
  bigWinPct: number;
  lossPct:   number;

  // §1 — headline counts
  totalRejectedRows:    number;
  rejectedWithOutcome:  number;
  rejectedWinners:      number;
  rejectedBigWinners:   number;
  rejectedLosers:       number;
  correctRejects:       number;
  falseRejects:         number;
  falseRejectRate:      number | null;   // falseRejects / withOutcome
  correctRejectRate:    number | null;
  evidenceMaturity:     EvidenceMaturity;

  // breakdowns
  byRejectReason:   GroupStats[];
  byEntryDecision:  GroupStats[];
  winnersByM5Band:  GroupStats[];   // among rejected WINNERS only
  winnersByLiquidity: GroupStats[];
  winnersByVlr:     GroupStats[];
  winnersByCluster: GroupStats[];

  // samples
  topFalseRejects:  RejectSampleRow[];
  topCorrectRejects: RejectSampleRow[];

  // diagnosis + recommendation
  diagnoses:        RejectDiagnosis[];
  recommendations:  string[];

  // safety
  reportOnly:        true;
  readOnly:          true;
  paperOnly:         true;
  noMutation:        true;
  noRealTrading:     true;
  noGateChanges:     true;
  noPolicyChange:    true;
  noWallet:          true;
  noSwap:            true;
  noSigning:         true;
  realTradingLocked: true;
  tradingExecuted:   0;
}

export interface RejectedOutcomeTrackerOptions {
  memoryPath?: string;
  topN?:       number;
  winPct?:     number;
  bigWinPct?:  number;
  lossPct?:    number;
  generatedAt?: string;
}

// ── Raw row ──────────────────────────────────────────────────────────────────

interface RawMemRow {
  contract?:              string;
  symbol?:                string;
  gateDecision?:          string;
  entryDecision?:         string;
  priceChangePct?:        number | null;
  entryMomentumPct?:      number | null;
  liquidityBucket?:       string;
  vlrBucket?:             string;
  clusterRisk?:           string;
  outcomeLabel?:          string;
  blockedByAgeGte10m?:    boolean;
  blockedByLowLiquidity?: boolean;
  wouldRejectByLiqOrAge?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

function capPnl(p: number): number {
  return Math.max(-PNL_CAP, Math.min(PNL_CAP, p));
}

function avg(arr: number[]): number | null {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function hasPnl(p: unknown): p is number {
  return typeof p === 'number' && Number.isFinite(p);
}

// Normalize clusterRisk; absent/unrecognized → MISSING. UNKNOWN stays UNKNOWN.
function normCluster(v: unknown): string {
  if (typeof v !== 'string') return 'MISSING';
  const u = v.trim().toUpperCase();
  if (u === 'CLEAN' || u === 'WATCH' || u === 'RISKY' || u === 'UNKNOWN') return u;
  return 'MISSING';
}

// Derive the primary rejection reason from the row's blocker fields, falling back
// to entryDecision. Conservative ordering: hard blockers first.
function rejectReason(r: RawMemRow): string {
  if (r.blockedByLowLiquidity === true) return 'LOW_LIQUIDITY';
  if (r.blockedByAgeGte10m    === true) return 'AGE_GTE_10M';
  const ed = r.entryDecision;
  if (ed === 'PAPER_BUY_BLOCKED') return 'PAPER_BUY_BLOCKED';
  if (ed === 'WATCH')             return 'WATCH';
  if (ed === 'IGNORE')            return 'IGNORE';
  if (r.wouldRejectByLiqOrAge === true) return 'LIQ_OR_AGE_SOFT';
  return 'OTHER_GATE';
}

interface Thresholds { winPct: number; bigWinPct: number; lossPct: number; }

function computeGroupStats(key: string, rows: RawMemRow[], t: Thresholds): GroupStats {
  const pnlRows = rows.filter(r => hasPnl(r.priceChangePct));
  const pnls = pnlRows.map(r => r.priceChangePct as number);
  const winners    = pnls.filter(p => p >= t.winPct).length;
  const bigWinners = pnls.filter(p => p >= t.bigWinPct).length;
  const losers     = pnls.filter(p => p <= t.lossPct).length;
  // Both avg and median use capped P/L so a single corrupt priceChangePct outlier
  // (the historical data has a few) cannot distort the displayed central tendency.
  const cappedPnls = pnls.map(capPnl);
  return {
    key,
    total:        rows.length,
    withOutcome:  pnlRows.length,
    winners,
    bigWinners,
    losers,
    winRate:      pnlRows.length > 0 ? winners / pnlRows.length : null,
    avgPnlCapped: avg(cappedPnls),
    medianPnl:    median(cappedPnls),
  };
}

function groupBy(rows: RawMemRow[], keyOf: (r: RawMemRow) => string): Map<string, RawMemRow[]> {
  const m = new Map<string, RawMemRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

function toSample(r: RawMemRow): RejectSampleRow {
  return {
    symbol:         r.symbol ?? null,
    contractPrefix: (r.contract ?? 'unknown').slice(0, 18),
    pnl:            r.priceChangePct as number,
    m5:             hasPnl(r.entryMomentumPct) ? (r.entryMomentumPct as number) : null,
    m5Band:         m5ToBand(r.entryMomentumPct),
    clusterRisk:    normCluster(r.clusterRisk),
    liquidityBucket: r.liquidityBucket ?? 'LIQ_UNKNOWN',
    vlrBucket:      r.vlrBucket ?? 'VLR_UNKNOWN',
    rejectReason:   rejectReason(r),
    entryDecision:  r.entryDecision ?? 'unknown',
    outcomeLabel:   r.outcomeLabel ?? 'UNKNOWN',
  };
}

// ── Main runner ──────────────────────────────────────────────────────────────────

export function runRejectedOutcomeTracker(
  opts: RejectedOutcomeTrackerOptions = {},
): RejectedOutcomeTrackerResult {
  const memoryPath  = opts.memoryPath ?? DEFAULT_MEMORY_PATH;
  const topN        = opts.topN       ?? DEFAULT_TOP_N;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const t: Thresholds = {
    winPct:    opts.winPct    ?? DEFAULT_WIN_PCT,
    bigWinPct: opts.bigWinPct ?? DEFAULT_BIG_WIN_PCT,
    lossPct:   opts.lossPct   ?? DEFAULT_LOSS_PCT,
  };

  const allRows = readJsonl<RawMemRow>(memoryPath);
  const rejected = allRows.filter(r => r.gateDecision === REJECT_GATE);
  const withOutcome = rejected.filter(r => hasPnl(r.priceChangePct));

  const rejectedWinners    = withOutcome.filter(r => (r.priceChangePct as number) >= t.winPct);
  const rejectedBigWinners = withOutcome.filter(r => (r.priceChangePct as number) >= t.bigWinPct);
  const rejectedLosers     = withOutcome.filter(r => (r.priceChangePct as number) <= t.lossPct);
  // A correct reject = rejected AND did NOT become a winner.
  const correctRejects = withOutcome.filter(r => (r.priceChangePct as number) < t.winPct);
  // A false reject = rejected BUT became a winner (potential missed catch).
  const falseRejects = rejectedWinners;

  const falseRejectRate   = withOutcome.length > 0 ? falseRejects.length / withOutcome.length : null;
  const correctRejectRate = withOutcome.length > 0 ? correctRejects.length / withOutcome.length : null;

  // ── Breakdowns ───────────────────────────────────────────────────────────────
  const byReasonMap = groupBy(rejected, rejectReason);
  const byRejectReason = [...byReasonMap.entries()]
    .map(([k, rows]) => computeGroupStats(k, rows, t))
    .sort((a, b) => b.total - a.total);

  const byEdMap = groupBy(rejected, r => r.entryDecision ?? 'unknown');
  const byEntryDecision = [...byEdMap.entries()]
    .map(([k, rows]) => computeGroupStats(k, rows, t))
    .sort((a, b) => b.total - a.total);

  // Breakdowns AMONG rejected winners (which kinds of winners are we rejecting?).
  const winnersByM5Band = M5_BAND_ORDER
    .map(band => computeGroupStats(band, rejectedWinners.filter(r => m5ToBand(r.entryMomentumPct) === band), t))
    .filter(g => g.total > 0);
  const winnersByLiquidity = [...groupBy(rejectedWinners, r => r.liquidityBucket ?? 'LIQ_UNKNOWN').entries()]
    .map(([k, rows]) => computeGroupStats(k, rows, t)).sort((a, b) => b.total - a.total);
  const winnersByVlr = [...groupBy(rejectedWinners, r => r.vlrBucket ?? 'VLR_UNKNOWN').entries()]
    .map(([k, rows]) => computeGroupStats(k, rows, t)).sort((a, b) => b.total - a.total);
  const winnersByCluster = [...groupBy(rejectedWinners, r => normCluster(r.clusterRisk)).entries()]
    .map(([k, rows]) => computeGroupStats(k, rows, t)).sort((a, b) => b.total - a.total);

  // ── Samples ────────────────────────────────────────────────────────────────────
  const topFalseRejects = [...falseRejects]
    .sort((a, b) => (b.priceChangePct as number) - (a.priceChangePct as number))
    .slice(0, topN).map(toSample);
  const topCorrectRejects = [...correctRejects]
    .sort((a, b) => (a.priceChangePct as number) - (b.priceChangePct as number))
    .slice(0, topN).map(toSample);

  const evidenceMaturity = getMaturity(withOutcome.length);

  // ── Diagnoses ──────────────────────────────────────────────────────────────────
  const diagnoses = computeDiagnoses({
    totalRejected: rejected.length,
    withOutcome:   withOutcome.length,
    falseRejects:  falseRejects.length,
    correctRejects: correctRejects.length,
    bigWinners:    rejectedBigWinners.length,
    falseRejectRate,
    correctRejectRate,
    byRejectReason,
  }, t);

  const recommendations = computeRecommendations(diagnoses);

  return {
    generatedAt,
    winPct: t.winPct, bigWinPct: t.bigWinPct, lossPct: t.lossPct,
    totalRejectedRows:   rejected.length,
    rejectedWithOutcome: withOutcome.length,
    rejectedWinners:     rejectedWinners.length,
    rejectedBigWinners:  rejectedBigWinners.length,
    rejectedLosers:      rejectedLosers.length,
    correctRejects:      correctRejects.length,
    falseRejects:        falseRejects.length,
    falseRejectRate,
    correctRejectRate,
    evidenceMaturity,
    byRejectReason,
    byEntryDecision,
    winnersByM5Band,
    winnersByLiquidity,
    winnersByVlr,
    winnersByCluster,
    topFalseRejects,
    topCorrectRejects,
    diagnoses,
    recommendations,
    reportOnly:        true,
    readOnly:          true,
    paperOnly:         true,
    noMutation:        true,
    noRealTrading:     true,
    noGateChanges:     true,
    noPolicyChange:    true,
    noWallet:          true,
    noSwap:            true,
    noSigning:         true,
    realTradingLocked: true,
    tradingExecuted:   0,
  };
}

function computeDiagnoses(ctx: {
  totalRejected: number;
  withOutcome: number;
  falseRejects: number;
  correctRejects: number;
  bigWinners: number;
  falseRejectRate: number | null;
  correctRejectRate: number | null;
  byRejectReason: GroupStats[];
}, _t: Thresholds): RejectDiagnosis[] {
  const d: RejectDiagnosis[] = [];

  if (ctx.falseRejects > 0) d.push('REJECTED_WINNERS_EXIST');

  // Most rejects were correctly junk/dump (the gates are doing their job).
  if (ctx.correctRejectRate != null && ctx.correctRejectRate >= 0.6) d.push('REJECTS_MOSTLY_JUNK');

  // A material slice of rejects became winners — gates may be too strict.
  if ((ctx.falseRejectRate != null && ctx.falseRejectRate >= 0.2) || ctx.bigWinners >= 50) {
    d.push('GATES_MAY_BE_TOO_STRICT');
  }

  // A specific reject reason has a high winner rate on a non-trivial sample.
  const suspectReason = ctx.byRejectReason.some(
    g => g.withOutcome >= 30 && (g.winRate ?? 0) >= 0.25);
  if (suspectReason) d.push('REJECT_REASON_NEEDS_REVIEW');

  // Outcome coverage is thin — many rejected rows lack an observed outcome.
  if (ctx.totalRejected > 0 && ctx.withOutcome / ctx.totalRejected < 0.5) {
    d.push('REJECT_OUTCOME_DATA_INCOMPLETE');
  }

  d.push('STUDY_ONLY_NO_GATE_CHANGE');
  return d;
}

function computeRecommendations(diagnoses: RejectDiagnosis[]): string[] {
  const recs: string[] = [];
  recs.push('Do NOT change any gate, filter, or rejection rule based on this report alone.');
  if (diagnoses.includes('GATES_MAY_BE_TOO_STRICT')) {
    recs.push('Some rejected tokens became winners. Feed the top false-reject patterns into the Shadow Policy ' +
              'Backtester (study only) before any gate proposal — do NOT loosen gates directly.');
  }
  if (diagnoses.includes('REJECT_REASON_NEEDS_REVIEW')) {
    recs.push('At least one reject reason shows a high winner rate. Study that reason in isolation; it may be ' +
              'over-rejecting catchable winners. (Evidence-labeled study only — no change.)');
  }
  if (diagnoses.includes('REJECTS_MOSTLY_JUNK')) {
    recs.push('Most rejects correctly avoided junk/dumps — the gates provide real protection. Preserve this ' +
              'when studying any loosening; do not trade protection for a few missed winners.');
  }
  if (diagnoses.includes('REJECT_OUTCOME_DATA_INCOMPLETE')) {
    recs.push('Many rejected rows have no observed outcome yet. Keep running the normal paper loop to mature ' +
              'reject-outcome evidence before drawing strong conclusions.');
  }
  recs.push('Never use outcome fields (priceChangePct/outcomeLabel) as entry predictors — they are hindsight.');
  recs.push('Real trading stays locked. Gates are HELD. This is study evidence only.');
  return recs;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function pctRate(v: number | null | undefined): string {
  if (v == null) return '   n/a';
  return (v * 100).toFixed(1) + '%';
}
function fmt1(v: number | null | undefined): string {
  if (v == null) return '  n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function renderGroupTable(L: string[], title: string, groups: GroupStats[]): void {
  L.push(`  ${title}`);
  if (groups.length === 0) { L.push('    (none)'); L.push(''); return; }
  L.push(`    ${'key'.padEnd(20)} ${'tot'.padStart(5)} ${'out'.padStart(5)} ${'win'.padStart(5)} ${'big'.padStart(4)} ${'lose'.padStart(5)} ${'win%'.padStart(7)} ${'avgPnl'.padStart(8)} ${'med'.padStart(7)}`);
  for (const g of groups) {
    L.push(
      `    ${g.key.slice(0, 19).padEnd(20)} ` +
      `${String(g.total).padStart(5)} ` +
      `${String(g.withOutcome).padStart(5)} ` +
      `${String(g.winners).padStart(5)} ` +
      `${String(g.bigWinners).padStart(4)} ` +
      `${String(g.losers).padStart(5)} ` +
      `${pctRate(g.winRate).padStart(7)} ` +
      `${(fmt1(g.avgPnlCapped) + '%').padStart(8)} ` +
      `${(fmt1(g.medianPnl) + '%').padStart(7)}`,
    );
  }
  L.push('');
}

function renderSamples(L: string[], title: string, rows: RejectSampleRow[]): void {
  L.push(`  ${title}`);
  if (rows.length === 0) { L.push('    (none)'); L.push(''); return; }
  L.push(`    ${'symbol'.padEnd(12)} ${'contract'.padEnd(20)} ${'pnl'.padStart(8)} ${'m5band'.padEnd(15)} ${'cluster'.padEnd(8)} ${'reason'.padEnd(16)} ${'liq'.padEnd(13)} outcome`);
  for (const s of rows) {
    L.push(
      `    ${(s.symbol ?? 'unknown').slice(0, 11).padEnd(12)} ` +
      `${s.contractPrefix.padEnd(20)} ` +
      `${(fmt1(s.pnl) + '%').padStart(8)} ` +
      `${s.m5Band.padEnd(15)} ` +
      `${s.clusterRisk.padEnd(8)} ` +
      `${s.rejectReason.padEnd(16)} ` +
      `${s.liquidityBucket.padEnd(13)} ` +
      `${s.outcomeLabel}`,
    );
  }
  L.push('');
}

export function renderRejectedOutcomeTracker(r: RejectedOutcomeTrackerResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — REJECTED OUTCOME TRACKER v1');
  L.push('  [REPORT ONLY — READ ONLY — PAPER ONLY — NO MUTATION — NO GATE CHANGES]');
  L.push('  Learns from REJECTED tokens: false rejects, correct rejects, too-strict reasons.');
  L.push('  Outcome fields are hindsight evidence — never entry predictors. UNKNOWN ≠ CLEAN.');
  L.push(SEP, '');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Generated at              : ${r.generatedAt}`);
  L.push(`  Thresholds                : winner >= +${r.winPct}%  big >= +${r.bigWinPct}%  loser <= ${r.lossPct}%`);
  L.push(`  Total rejected rows       : ${r.totalRejectedRows}`);
  L.push(`  Rejected with outcome     : ${r.rejectedWithOutcome}`);
  L.push(`  Evidence maturity         : ${r.evidenceMaturity}`);
  L.push(`  Headline diagnosis        : ${r.diagnoses[0] ?? '(none)'}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — REJECTED OUTCOME COUNTS');
  L.push(`  ${SEP2}`, '');
  L.push(`  Rejected WINNERS (>= +${r.winPct}%)   : ${r.rejectedWinners}`);
  L.push(`  Rejected BIG winners (>= +${r.bigWinPct}%): ${r.rejectedBigWinners}`);
  L.push(`  Rejected LOSERS (<= ${r.lossPct}%)    : ${r.rejectedLosers}`);
  L.push(`  Correct rejects (not winner)    : ${r.correctRejects}  (${pctRate(r.correctRejectRate)})`);
  L.push(`  False rejects (became winner)   : ${r.falseRejects}  (${pctRate(r.falseRejectRate)})`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — REJECT REASON / ENTRY DECISION BREAKDOWN');
  L.push(`  ${SEP2}`, '');
  renderGroupTable(L, 'By reject reason:', r.byRejectReason);
  renderGroupTable(L, 'By entryDecision:', r.byEntryDecision);

  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — REJECTED WINNERS BREAKDOWN (what kinds of winners we reject)');
  L.push(`  ${SEP2}`, '');
  renderGroupTable(L, 'Rejected winners by M5 band:', r.winnersByM5Band);
  renderGroupTable(L, 'Rejected winners by liquidity bucket:', r.winnersByLiquidity);
  renderGroupTable(L, 'Rejected winners by VLR bucket:', r.winnersByVlr);
  renderGroupTable(L, 'Rejected winners by cluster risk:', r.winnersByCluster);

  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — TOP SAMPLES');
  L.push(`  ${SEP2}`, '');
  renderSamples(L, `Top ${r.topFalseRejects.length} FALSE rejects (biggest missed winners):`, r.topFalseRejects);
  renderSamples(L, `Top ${r.topCorrectRejects.length} CORRECT rejects (biggest dumps avoided):`, r.topCorrectRejects);

  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — DIAGNOSIS');
  L.push(`  ${SEP2}`, '');
  for (const d of r.diagnoses) {
    const neutral = d === 'STUDY_ONLY_NO_GATE_CHANGE' || d === 'REJECTS_MOSTLY_JUNK';
    L.push(`  ${neutral ? 'ℹ' : '⚠'} ${d}`);
  }
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — RECOMMENDATION (STUDY ONLY — NO GATE CHANGE)');
  L.push(`  ${SEP2}`, '');
  for (const rec of r.recommendations) L.push(`  • ${rec}`);
  L.push('');

  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true   READ_ONLY=true   PAPER_ONLY=true   NO_MUTATION=true');
  L.push('  NO_REAL_TRADING=true   NO_GATE_CHANGES=true   NO_POLICY_CHANGE=true');
  L.push('  NO_WALLET=true   NO_SWAP=true   NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING   tradingExecuted=0   realTradingLocked=true');
  L.push('  No data files mutated. No gates changed. Outcome fields used as evidence only, not predictors.');
  L.push(SEP, '');

  return L.join('\n');
}
