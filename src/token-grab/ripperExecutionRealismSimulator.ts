// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0
// HOLD_CURRENT_GATES  NO_POLICY_CHANGE  NO_GATE_CHANGES
//
// Execution Realism Simulator v1 — a REPORT_ONLY study that converts optimistic paper
// P/L into a more execution-realistic estimate by subtracting slippage, fees, latency
// chase, thin-liquidity penalties, high-VLR penalties, extreme-M5 exhaustion, and
// sellability / failed-exit haircuts. The model is DETERMINISTIC (expected-value, no
// randomness) and fully parameterized — it changes NO behavior, gate, or policy.
//
// Purpose: expose "paper profit illusion" so the system never trusts a fake edge.
// Does NOT mutate any file. UNKNOWN cluster risk is treated as an execution RISK
// (never as CLEAN).

import * as fs from 'fs';

import {
  m5ToBand,
  getConfidenceTier,
  M5_BAND_ORDER,
  type M5Band,
  type ConfidenceTier,
} from './ripperM5EvidenceDashboard';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_PATH = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_TOP_N       = 20;

// Default execution parameters (all overridable via CLI flags).
const DEFAULT_SLIPPAGE_BPS       = 100;   // per side (1.0%)
const DEFAULT_FEE_BPS            = 30;    // per side (0.3%)
const DEFAULT_LATENCY_SECONDS    = 5;
const DEFAULT_MAX_PNL_CAP        = 300;   // cap |P/L| at ±300%
const DEFAULT_THIN_LIQ_PENALTY   = 5;     // extra % haircut on thin pools
const DEFAULT_FAILED_EXIT_HAIRCUT = 0.2;  // fraction of positive gains lost to bad exits

// Internal model factors (not user-tunable — kept conservative & explicit).
const CHASE_FACTOR        = 0.5;   // share of strong-M5 momentum lost to latency chase
const CHASE_M5_THRESHOLD  = 20;    // only M5 > this is treated as a chase/exhaustion risk
const CHASE_M5_CAP        = 100;   // cap the momentum used in the chase term
const RISKY_SELL_HAIRCUT  = 0.10;  // extra positive-gain haircut for RISKY/UNKNOWN cluster
const THIN_SELL_HAIRCUT   = 0.10;  // extra positive-gain haircut for thin liquidity
const MAX_SELL_HAIRCUT    = 0.90;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ───────────────────────────────────────────────────────────────────────

export interface ExecutionParams {
  slippageBps:       number;
  feeBps:            number;
  latencySeconds:    number;
  maxPnlCap:         number;
  thinLiqPenalty:    number;
  failedExitHaircut: number;
}

export interface PnlGroupStats {
  key:              string;
  n:                number;
  baselineAvg:      number | null;
  adjustedAvg:      number | null;
  avgDrop:          number | null;   // baselineAvg - adjustedAvg
  baselineWinRate:  number | null;
  adjustedWinRate:  number | null;
  baselineMedian:   number | null;
  adjustedMedian:   number | null;
  confidenceTier:   ConfidenceTier;
}

export interface WorstCaseRow {
  symbol:          string | null;
  contractPrefix:  string;
  baselinePnl:     number;
  adjustedPnl:     number;
  drop:            number;
  m5Band:          M5Band;
  liquidityBucket: string;
  vlrBucket:       string;
  clusterRisk:     string;
}

export type ExecutionDiagnosis =
  | 'PAPER_PNL_OVERSTATED'
  | 'THIN_LIQUIDITY_EXECUTION_RISK'
  | 'M5_STRONG_CHASE_RISK'
  | 'UNKNOWN_CLUSTER_EXECUTION_RISK'
  | 'EXECUTION_MODEL_READY_FOR_STUDY'
  | 'NO_REAL_TRADING';

export interface ExecutionRealismResult {
  generatedAt: string;
  params:      ExecutionParams;

  universeLabel:   string;
  totalRows:       number;
  pnlRows:         number;

  overall:         PnlGroupStats;
  byM5Band:        PnlGroupStats[];
  byLiquidity:     PnlGroupStats[];
  byVlr:           PnlGroupStats[];
  byCluster:       PnlGroupStats[];

  worstCases:      WorstCaseRow[];
  illusionWarnings: string[];

  diagnoses:       ExecutionDiagnosis[];
  recommendations: string[];

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

export interface ExecutionRealismOptions {
  memoryPath?:       string;
  topN?:             number;
  slippageBps?:      number;
  feeBps?:           number;
  latencySeconds?:   number;
  maxPnlCap?:        number;
  thinLiqPenalty?:   number;
  failedExitHaircut?: number;
  generatedAt?:      string;
}

// ── Raw row ──────────────────────────────────────────────────────────────────

interface RawMemRow {
  contract?:         string;
  symbol?:           string;
  gateDecision?:     string;
  priceChangePct?:   number | null;
  entryMomentumPct?: number | null;
  liquidityBucket?:  string;
  vlrBucket?:        string;
  clusterRisk?:      string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

function hasNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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

function normCluster(v: unknown): string {
  if (typeof v !== 'string') return 'MISSING';
  const u = v.trim().toUpperCase();
  if (u === 'CLEAN' || u === 'WATCH' || u === 'RISKY' || u === 'UNKNOWN') return u;
  return 'MISSING';
}

// ── Execution model (deterministic, expected-value) ──────────────────────────────

// Convert a baseline paper P/L (%) into an execution-adjusted P/L (%) for one row.
// Exported for direct unit testing.
export function adjustExecutionPnl(
  baselinePnl: number,
  row: { entryMomentumPct?: number | null; liquidityBucket?: string; vlrBucket?: string; clusterRisk?: string },
  p: ExecutionParams,
): number {
  // Cap the baseline first so a single corrupt outlier can't dominate.
  let adj = clamp(baselinePnl, -p.maxPnlCap, p.maxPnlCap);

  // 1. Round-trip explicit costs: slippage + fees, both sides (bps → %, /100).
  adj -= 2 * p.slippageBps / 100;
  adj -= 2 * p.feeBps / 100;

  // 2. Thin-liquidity execution penalty (extra slippage on shallow pools).
  const liq = row.liquidityBucket ?? 'LIQ_UNKNOWN';
  if (liq === 'LIQ_LT_10K')       adj -= p.thinLiqPenalty;
  else if (liq === 'LIQ_10K_30K') adj -= p.thinLiqPenalty * 0.5;

  // 3. High-VLR penalty (volume/liq imbalance → worse fills).
  if ((row.vlrBucket ?? '') === 'VLR_GTE_2') adj -= p.thinLiqPenalty * 0.5;

  // 4. Extreme-M5 chase/exhaustion: strong positive momentum entered late loses a
  //    fraction of the move, scaled by latency.
  const m5 = row.entryMomentumPct;
  if (hasNum(m5) && m5 > CHASE_M5_THRESHOLD) {
    adj -= Math.min(m5, CHASE_M5_CAP) * (p.latencySeconds / 60) * CHASE_FACTOR;
  }

  // 5. Sellability + failed-exit haircut on the remaining POSITIVE gain only.
  if (adj > 0) {
    let haircut = p.failedExitHaircut;
    const cl = normCluster(row.clusterRisk);
    if (cl === 'RISKY' || cl === 'UNKNOWN') haircut += RISKY_SELL_HAIRCUT;  // UNKNOWN ≠ CLEAN: treat as risk
    if (liq === 'LIQ_LT_10K')               haircut += THIN_SELL_HAIRCUT;
    haircut = clamp(haircut, 0, MAX_SELL_HAIRCUT);
    adj *= (1 - haircut);
  }

  // 6. Final cap.
  return clamp(adj, -p.maxPnlCap, p.maxPnlCap);
}

// ── Group stats ──────────────────────────────────────────────────────────────────

interface PnlRow { base: number; adj: number; }

function computeGroup(key: string, rows: PnlRow[]): PnlGroupStats {
  const bases = rows.map(r => r.base);
  const adjs  = rows.map(r => r.adj);
  const baseWins = bases.filter(p => p > 0).length;
  const adjWins  = adjs.filter(p => p > 0).length;
  const baselineAvg = avg(bases);
  const adjustedAvg = avg(adjs);
  return {
    key,
    n: rows.length,
    baselineAvg,
    adjustedAvg,
    avgDrop: baselineAvg != null && adjustedAvg != null ? baselineAvg - adjustedAvg : null,
    baselineWinRate: rows.length ? baseWins / rows.length : null,
    adjustedWinRate: rows.length ? adjWins / rows.length : null,
    baselineMedian: median(bases),
    adjustedMedian: median(adjs),
    confidenceTier: getConfidenceTier(rows.length),
  };
}

// ── Main runner ──────────────────────────────────────────────────────────────────

export function runExecutionRealismSimulator(
  opts: ExecutionRealismOptions = {},
): ExecutionRealismResult {
  const memoryPath  = opts.memoryPath ?? DEFAULT_MEMORY_PATH;
  const topN        = opts.topN       ?? DEFAULT_TOP_N;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const params: ExecutionParams = {
    slippageBps:       opts.slippageBps       ?? DEFAULT_SLIPPAGE_BPS,
    feeBps:            opts.feeBps            ?? DEFAULT_FEE_BPS,
    latencySeconds:    opts.latencySeconds    ?? DEFAULT_LATENCY_SECONDS,
    maxPnlCap:         opts.maxPnlCap         ?? DEFAULT_MAX_PNL_CAP,
    thinLiqPenalty:    opts.thinLiqPenalty    ?? DEFAULT_THIN_LIQ_PENALTY,
    failedExitHaircut: opts.failedExitHaircut ?? DEFAULT_FAILED_EXIT_HAIRCUT,
  };

  const allRows = readJsonl<RawMemRow>(memoryPath);
  // Execution realism applies to the PAPER-TRADED universe: approved paper rows with
  // an observed P/L. These are the rows whose "profit" could be an illusion.
  const universe = allRows.filter(
    r => r.gateDecision === 'BUY_APPROVED_PAPER' && hasNum(r.priceChangePct));

  const enriched = universe.map(r => {
    const base = clamp(r.priceChangePct as number, -params.maxPnlCap, params.maxPnlCap);
    const adj  = adjustExecutionPnl(r.priceChangePct as number, r, params);
    return { row: r, base, adj };
  });

  const overallPnl: PnlRow[] = enriched.map(e => ({ base: e.base, adj: e.adj }));
  const overall = computeGroup('OVERALL', overallPnl);

  const groupOf = (keyFn: (r: RawMemRow) => string, order?: string[]): PnlGroupStats[] => {
    const m = new Map<string, PnlRow[]>();
    for (const e of enriched) {
      const k = keyFn(e.row);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push({ base: e.base, adj: e.adj });
    }
    const keys = order ? order.filter(k => m.has(k)) : [...m.keys()];
    const extra = order ? [...m.keys()].filter(k => !order.includes(k)) : [];
    return [...keys, ...extra].map(k => computeGroup(k, m.get(k)!));
  };

  const byM5Band    = groupOf(r => m5ToBand(r.entryMomentumPct), M5_BAND_ORDER);
  const byLiquidity = groupOf(r => r.liquidityBucket ?? 'LIQ_UNKNOWN');
  const byVlr       = groupOf(r => r.vlrBucket ?? 'VLR_UNKNOWN');
  const byCluster   = groupOf(r => normCluster(r.clusterRisk));

  const worstCases: WorstCaseRow[] = [...enriched]
    .sort((a, b) => (b.base - b.adj) - (a.base - a.adj))
    .slice(0, topN)
    .map(e => ({
      symbol:          e.row.symbol ?? null,
      contractPrefix:  (e.row.contract ?? 'unknown').slice(0, 18),
      baselinePnl:     e.base,
      adjustedPnl:     e.adj,
      drop:            e.base - e.adj,
      m5Band:          m5ToBand(e.row.entryMomentumPct),
      liquidityBucket: e.row.liquidityBucket ?? 'LIQ_UNKNOWN',
      vlrBucket:       e.row.vlrBucket ?? 'VLR_UNKNOWN',
      clusterRisk:     normCluster(e.row.clusterRisk),
    }));

  const { diagnoses, illusionWarnings } = computeDiagnoses(overall, byM5Band, byLiquidity, byCluster);
  const recommendations = computeRecommendations(diagnoses);

  return {
    generatedAt,
    params,
    universeLabel: 'approved paper rows (BUY_APPROVED_PAPER) with observed P/L',
    totalRows: allRows.length,
    pnlRows:   universe.length,
    overall,
    byM5Band,
    byLiquidity,
    byVlr,
    byCluster,
    worstCases,
    illusionWarnings,
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

function computeDiagnoses(
  overall: PnlGroupStats,
  byM5Band: PnlGroupStats[],
  byLiquidity: PnlGroupStats[],
  byCluster: PnlGroupStats[],
): { diagnoses: ExecutionDiagnosis[]; illusionWarnings: string[] } {
  const d: ExecutionDiagnosis[] = [];
  const warnings: string[] = [];

  // Overstated if a positive baseline collapses materially (flips negative, or loses
  // most of its edge) after execution costs.
  if (overall.baselineAvg != null && overall.adjustedAvg != null) {
    const drop = overall.baselineAvg - overall.adjustedAvg;
    const flipped = overall.baselineAvg > 0 && overall.adjustedAvg <= 0;
    const lostMost = overall.baselineAvg > 0 && overall.adjustedAvg < overall.baselineAvg * 0.5;
    if (flipped || lostMost || drop >= 5) {
      d.push('PAPER_PNL_OVERSTATED');
      warnings.push(
        `Overall paper avg ${fmt1(overall.baselineAvg)}% → ${fmt1(overall.adjustedAvg)}% after execution costs ` +
        `(drop ${fmt1(drop)} pts)${flipped ? ' — edge FLIPS NEGATIVE' : ''}.`);
    }
  }
  // Win-rate collapse is its own illusion signal.
  if (overall.baselineWinRate != null && overall.adjustedWinRate != null &&
      overall.baselineWinRate - overall.adjustedWinRate >= 0.1) {
    warnings.push(
      `Win rate ${(overall.baselineWinRate * 100).toFixed(1)}% → ${(overall.adjustedWinRate * 100).toFixed(1)}% ` +
      `after costs — many "winners" are below the cost line.`);
  }

  const thin = byLiquidity.find(g => g.key === 'LIQ_LT_10K');
  if (thin && thin.avgDrop != null && thin.avgDrop >= 5 && thin.n >= 20) {
    d.push('THIN_LIQUIDITY_EXECUTION_RISK');
    warnings.push(`Thin liquidity (LIQ_LT_10K) loses ${fmt1(thin.avgDrop)} pts to execution — fills are unreliable.`);
  }

  const strong = byM5Band.filter(g => g.key === 'M5_STRONG' || g.key === 'M5_VERY_STRONG');
  if (strong.some(g => g.avgDrop != null && g.avgDrop >= 5 && g.n >= 20)) {
    d.push('M5_STRONG_CHASE_RISK');
    warnings.push('Strong/very-strong M5 bands lose material P/L to latency chase — entering a pump late is costly.');
  }

  const unknown = byCluster.find(g => g.key === 'UNKNOWN');
  if (unknown && unknown.adjustedAvg != null && unknown.avgDrop != null && unknown.avgDrop >= 3 && unknown.n >= 20) {
    d.push('UNKNOWN_CLUSTER_EXECUTION_RISK');
    warnings.push('UNKNOWN-cluster rows carry extra sellability haircut — holder risk is unresolved, so exits are uncertain.');
  }

  d.push('EXECUTION_MODEL_READY_FOR_STUDY');
  d.push('NO_REAL_TRADING');
  return { diagnoses: d, illusionWarnings: warnings };
}

function computeRecommendations(diagnoses: ExecutionDiagnosis[]): string[] {
  const recs: string[] = [];
  recs.push('Treat execution-adjusted P/L (not raw paper P/L) as the realistic baseline for any future study.');
  if (diagnoses.includes('PAPER_PNL_OVERSTATED')) {
    recs.push('Paper P/L is overstated once costs are applied — do NOT use raw paper profitability to justify any ' +
              'gate or trading change.');
  }
  if (diagnoses.includes('THIN_LIQUIDITY_EXECUTION_RISK')) {
    recs.push('Thin-liquidity rows are the least executable — weight them down in any future profitability study.');
  }
  if (diagnoses.includes('M5_STRONG_CHASE_RISK')) {
    recs.push('Strong-M5 chase entries lose edge to latency — study earlier/limit entries before trusting strong-M5 P/L.');
  }
  if (diagnoses.includes('UNKNOWN_CLUSTER_EXECUTION_RISK')) {
    recs.push('UNKNOWN-cluster execution risk reinforces the case for paper holder-coverage (see BubbleMaps proposal).');
  }
  recs.push('This is a parameterized study only. No gate, policy, or trading behavior changed. Real trading stays locked.');
  return recs;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmt1(v: number | null | undefined): string {
  if (v == null) return ' n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}
function pctRate(v: number | null | undefined): string {
  if (v == null) return '  n/a';
  return (v * 100).toFixed(1) + '%';
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function renderGroup(L: string[], title: string, groups: PnlGroupStats[]): void {
  L.push(`  ${title}`);
  if (groups.length === 0) { L.push('    (none)'); L.push(''); return; }
  L.push(`    ${'key'.padEnd(16)} ${'n'.padStart(5)} ${'baseAvg'.padStart(8)} ${'adjAvg'.padStart(8)} ${'drop'.padStart(7)} ${'baseWin'.padStart(8)} ${'adjWin'.padStart(7)} ${'adjMed'.padStart(7)}  tier`);
  for (const g of groups) {
    L.push(
      `    ${g.key.slice(0, 15).padEnd(16)} ` +
      `${String(g.n).padStart(5)} ` +
      `${(fmt1(g.baselineAvg) + '%').padStart(8)} ` +
      `${(fmt1(g.adjustedAvg) + '%').padStart(8)} ` +
      `${(fmt1(g.avgDrop)).padStart(7)} ` +
      `${pctRate(g.baselineWinRate).padStart(8)} ` +
      `${pctRate(g.adjustedWinRate).padStart(7)} ` +
      `${(fmt1(g.adjustedMedian) + '%').padStart(7)}  ` +
      `${g.confidenceTier}`,
    );
  }
  L.push('');
}

export function renderExecutionRealismSimulator(r: ExecutionRealismResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — EXECUTION REALISM SIMULATOR v1');
  L.push('  [REPORT ONLY — READ ONLY — PAPER ONLY — NO MUTATION — NO GATE CHANGES]');
  L.push('  Adjusts paper P/L for slippage, fees, latency, thin liquidity, chase, sellability.');
  L.push('  Deterministic & parameterized. UNKNOWN cluster = execution RISK, never CLEAN.');
  L.push(SEP, '');

  // §1 — Overview
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  const p = r.params;
  L.push(`  Generated at        : ${r.generatedAt}`);
  L.push(`  Universe            : ${r.universeLabel}`);
  L.push(`  Rows / P/L rows     : ${r.totalRows} / ${r.pnlRows}`);
  L.push(`  Params              : slippage=${p.slippageBps}bps/side  fee=${p.feeBps}bps/side  latency=${p.latencySeconds}s`);
  L.push(`                        maxCap=±${p.maxPnlCap}%  thinLiqPenalty=${p.thinLiqPenalty}%  failedExitHaircut=${p.failedExitHaircut}`);
  L.push(`  Headline diagnosis  : ${r.diagnoses[0] ?? '(none)'}`);
  L.push('');

  // §2 — Baseline / §3 — Adjusted (overall)
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 & 3 — BASELINE vs EXECUTION-ADJUSTED (OVERALL)');
  L.push(`  ${SEP2}`, '');
  const o = r.overall;
  L.push(`  Baseline avg P/L    : ${fmt1(o.baselineAvg)}%   (win rate ${pctRate(o.baselineWinRate)}, median ${fmt1(o.baselineMedian)}%)`);
  L.push(`  Adjusted avg P/L    : ${fmt1(o.adjustedAvg)}%   (win rate ${pctRate(o.adjustedWinRate)}, median ${fmt1(o.adjustedMedian)}%)`);
  L.push(`  Avg drop from costs : ${fmt1(o.avgDrop)} pts`);
  L.push('');

  // §4–7 — group tables
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — BY M5 BAND');
  L.push(`  ${SEP2}`, '');
  renderGroup(L, 'M5 band:', r.byM5Band);

  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — BY LIQUIDITY BUCKET');
  L.push(`  ${SEP2}`, '');
  renderGroup(L, 'Liquidity:', r.byLiquidity);

  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — BY VLR BUCKET');
  L.push(`  ${SEP2}`, '');
  renderGroup(L, 'VLR:', r.byVlr);

  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — BY CLUSTER RISK');
  L.push(`  ${SEP2}`, '');
  renderGroup(L, 'Cluster risk (UNKNOWN ≠ CLEAN):', r.byCluster);

  // §8 — worst cases
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — WORST EXECUTION-RISK CASES (largest P/L drop)');
  L.push(`  ${SEP2}`, '');
  if (r.worstCases.length === 0) {
    L.push('  (none)');
  } else {
    L.push(`  ${'symbol'.padEnd(12)} ${'contract'.padEnd(20)} ${'base'.padStart(8)} ${'adj'.padStart(8)} ${'drop'.padStart(8)} ${'m5band'.padEnd(15)} ${'liq'.padEnd(13)} cluster`);
    for (const w of r.worstCases) {
      L.push(
        `  ${(w.symbol ?? 'unknown').slice(0, 11).padEnd(12)} ` +
        `${w.contractPrefix.padEnd(20)} ` +
        `${(fmt1(w.baselinePnl) + '%').padStart(8)} ` +
        `${(fmt1(w.adjustedPnl) + '%').padStart(8)} ` +
        `${(fmt1(w.drop)).padStart(8)} ` +
        `${w.m5Band.padEnd(15)} ` +
        `${w.liquidityBucket.padEnd(13)} ` +
        `${w.clusterRisk}`,
      );
    }
  }
  L.push('');

  // §9 — illusion warnings
  L.push(`  ${SEP2}`);
  L.push('  SECTION 9 — PAPER PROFIT ILLUSION WARNINGS');
  L.push(`  ${SEP2}`, '');
  if (r.illusionWarnings.length === 0) {
    L.push('  ✓ No material illusion detected at current parameters.');
  } else {
    for (const w of r.illusionWarnings) L.push(`  ⚠ ${w}`);
  }
  L.push('');

  // §10 — recommendation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 10 — RECOMMENDATION (STUDY ONLY)');
  L.push(`  ${SEP2}`, '');
  for (const rec of r.recommendations) L.push(`  • ${rec}`);
  L.push('');

  // §11 — safety
  L.push(`  ${SEP2}`);
  L.push('  SECTION 11 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true   READ_ONLY=true   PAPER_ONLY=true   NO_MUTATION=true');
  L.push('  NO_REAL_TRADING=true   NO_GATE_CHANGES=true   NO_POLICY_CHANGE=true');
  L.push('  NO_WALLET=true   NO_SWAP=true   NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING   tradingExecuted=0   realTradingLocked=true');
  L.push('  No data mutated. No gates changed. Adjusted P/L is a study estimate, not a trading signal.');
  L.push(SEP, '');

  return L.join('\n');
}
