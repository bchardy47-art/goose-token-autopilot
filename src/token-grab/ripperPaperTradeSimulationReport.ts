import * as fs   from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_INTENTS_PATH = 'data/token-grab/ripper/paper-intents.jsonl';
const DEFAULT_MEMORY_PATH  = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_CYCLES_DIR   = 'data/token-grab/ripper/cycles';

const WIN_THRESHOLD  = 0;    // pcp > WIN_THRESHOLD → win
const MAX_DANGER_ROWS = 10;  // per danger bucket

const M5_BANDS = [
  { label: 'M5 <= -20',  test: (m: number) => m <= -20 },
  { label: '-20 to -5',  test: (m: number) => m > -20 && m <= -5 },
  { label: '-5 to +5',   test: (m: number) => m > -5  && m <= 5  },
  { label: '+5 to +20',  test: (m: number) => m > 5   && m <= 20 },
  { label: '+20 to +50', test: (m: number) => m > 20  && m <= 50 },
  { label: '> +50',      test: (m: number) => m > 50  },
];

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SimulatedTrade {
  intentId:                string;
  symbol:                  string;
  contract:                string;
  paperEntryTiming:        string;
  reason:                  string;
  sourceCycle:             string;
  clusterRisk:             string | null;
  ripperScore:             number | null;
  launchAgeBucket:         string | null;
  entryDecision:           string | null;
  targetEntryAt:           string;
  observedAt:              string;
  priceChangePct:          number;
  simulatedPnlPct:         number;
  entryMomentumPct:        number | null;
  entryMomentumSource:     string;
  entryMomentumWindowLabel: string;
  liquidityBucket:         string | null;
  vlrBucket:               string | null;
  timingPath:              string | null;
  m5Band:                  string;
}

export interface GroupStat {
  label:     string;
  n:         number;
  winners:   number;
  losers:    number;
  winRate:   number;
  avgPnl:    number;
  medianPnl: number;
  tier:      string;
}

export interface DangerCase {
  contract:         string;
  symbol:           string;
  simulatedPnlPct:  number;
  ripperScore:      number | null;
  clusterRisk:      string | null;
  entryMomentumPct: number | null;
  m5Band:           string;
  dangerType:       string;
}

export interface PaperTradeSimulationResult {
  simulatedTrades:      SimulatedTrade[];
  observedIntentsRead:  number;
  skippedNonObserved:   number;

  totalSimulated:  number;
  winners:         number;
  losers:          number;
  flat:            number;
  winRate:         number;
  lossRate:        number;
  avgPnlPct:       number;
  avgPnlPctTrimmed: number;  // excluding pcp > 500%
  medianPnlPct:    number;
  bestTrade:       SimulatedTrade | null;
  worstTrade:      SimulatedTrade | null;

  byPaperEntryTiming: GroupStat[];
  byEntryDecision:    GroupStat[];
  byM5Band:           GroupStat[];
  byLiquidityBucket:  GroupStat[];
  byVlrBucket:        GroupStat[];

  highScoreLosers:   DangerCase[];
  cleanLosers:       DangerCase[];
  posM5Losers:       DangerCase[];
  negM5Winners:      DangerCase[];
  notObviousWinners: DangerCase[];

  recommendation:       string;
  recommendationReason: string;

  reportOnly:          true;
  readOnly:            true;
  paperOnly:           true;
  realTradingLocked:   true;
  tradingExecuted:     0;
  noGateChanges:       true;
  noFakeTradeMutation: true;
  noRealTrading:       true;
  noWallet:            true;
  noSwap:              true;
  noSigning:           true;
}

export interface PaperTradeSimulationOptions {
  intentsPath?: string;
  memoryPath?:  string;
  cyclesDir?:   string;
  nowMs?:       number;
}

// ── Internal raw types ─────────────────────────────────────────────────────────

interface RawIntent {
  intentId?:          string;
  contract?:          string;
  symbol?:            string;
  status?:            string;
  approvedAt?:        string;
  targetEntryAt?:     string;
  paperEntryTiming?:  string;
  reason?:            string;
  sourceCycle?:       string;
  clusterRisk?:       string | null;
  ripperScore?:       number | null;
  launchAgeBucket?:   string | null;
  entryDecision?:     string | null;
  entryMomentumPct?:  number | null;
  observedAt?:        string;
  priceChangePct?:    number | null;
}

interface MemRow {
  contract?:          string;
  liquidityBucket?:   string | null;
  vlrBucket?:         string | null;
  timingPath?:        string | null;
  entryMomentumPct?:  number | null;
}

interface CycleRow {
  normalizedSignal?:      { contract?: string } & Record<string, unknown>;
  ripperInput?:           { contract?: string } & Record<string, unknown>;
  entryMomentumPct?:      number | null;
  entryMomentumSource?:   string;
  entryMomentumWindowLabel?: string;
}

// ── File helpers ───────────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

// ── M5 band classifier ─────────────────────────────────────────────────────────

function m5BandLabel(pct: number | null): string {
  if (pct == null) return 'UNAVAILABLE';
  for (const b of M5_BANDS) {
    if (b.test(pct)) return b.label;
  }
  return 'UNAVAILABLE';
}

// ── Statistics helpers ─────────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function evidenceTier(n: number): string {
  if (n < 20)  return 'IGNORE';
  if (n < 50)  return 'INTERESTING_ONLY';
  if (n < 100) return 'EARLY_EVIDENCE';
  if (n < 200) return 'USABLE_SIGNAL';
  return 'STRONGER';
}

function buildGroupStat(label: string, trades: SimulatedTrade[]): GroupStat {
  const n = trades.length;
  const winners  = trades.filter(t => t.simulatedPnlPct > WIN_THRESHOLD).length;
  const losers   = trades.filter(t => t.simulatedPnlPct <= WIN_THRESHOLD).length;
  const pnls     = trades.map(t => t.simulatedPnlPct);
  return {
    label,
    n,
    winners,
    losers,
    winRate:   n > 0 ? winners / n : 0,
    avgPnl:    avg(pnls),
    medianPnl: median(pnls),
    tier:      evidenceTier(n),
  };
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(item);
  }
  return m;
}

// ── Cycle file cache ──────────────────────────────────────────────────────────

function buildCycleCache(cyclesDir: string, sourceCycles: Set<string>): Map<string, Map<string, CycleRow>> {
  // Map<cycleId, Map<contract, row>>
  const cache = new Map<string, Map<string, CycleRow>>();
  if (!fs.existsSync(cyclesDir)) return cache;
  for (const cycleId of sourceCycles) {
    const filePath = path.join(cyclesDir, `${cycleId}.jsonl`);
    if (!fs.existsSync(filePath)) continue;
    const contractMap = new Map<string, CycleRow>();
    const rows = readJsonl<CycleRow>(filePath);
    for (const row of rows) {
      const contract = row.normalizedSignal?.contract ?? row.ripperInput?.contract;
      if (contract && !contractMap.has(contract)) {
        contractMap.set(contract, row);
      }
    }
    cache.set(cycleId, contractMap);
  }
  return cache;
}

// ── Main runner ────────────────────────────────────────────────────────────────

export function runPaperTradeSimulationReport(
  opts: PaperTradeSimulationOptions = {},
): PaperTradeSimulationResult {
  const intentsPath = opts.intentsPath ?? DEFAULT_INTENTS_PATH;
  const memoryPath  = opts.memoryPath  ?? DEFAULT_MEMORY_PATH;
  const cyclesDir   = opts.cyclesDir   ?? DEFAULT_CYCLES_DIR;

  // ── Load intents ────────────────────────────────────────────────────────────
  const allIntents = readJsonl<RawIntent>(intentsPath);
  const observedIntents = allIntents.filter(r => r.status === 'OBSERVED');
  const skipped = allIntents.length - observedIntents.length;

  // ── Build learning-memory index (first row per contract) ────────────────────
  const memByContract = new Map<string, MemRow>();
  for (const row of readJsonl<MemRow>(memoryPath)) {
    const c = row.contract;
    if (c && !memByContract.has(c)) {
      memByContract.set(c, row);
    }
  }

  // ── Build cycle cache for entryMomentumPct ──────────────────────────────────
  const sourceCycles = new Set(observedIntents.map(r => r.sourceCycle ?? '').filter(Boolean));
  const cycleCache = buildCycleCache(cyclesDir, sourceCycles);

  // ── Build simulated trades ──────────────────────────────────────────────────
  const simulatedTrades: SimulatedTrade[] = [];

  for (const intent of observedIntents) {
    if (
      !intent.intentId ||
      !intent.contract ||
      typeof intent.priceChangePct !== 'number'
    ) continue;

    const mem = memByContract.get(intent.contract);
    const cycleRow = cycleCache.get(intent.sourceCycle ?? '')?.get(intent.contract);

    // Prefer: intent (direct) → memory row → cycle file (fallback join)
    const m5raw =
      intent.entryMomentumPct != null ? intent.entryMomentumPct :
      mem?.entryMomentumPct   != null ? mem.entryMomentumPct    :
      (cycleRow?.entryMomentumPct ?? null);
    const m5 = (typeof m5raw === 'number' && Number.isFinite(m5raw)) ? m5raw : null;

    simulatedTrades.push({
      intentId:                intent.intentId,
      symbol:                  intent.symbol ?? 'UNKNOWN',
      contract:                intent.contract,
      paperEntryTiming:        intent.paperEntryTiming ?? 'UNKNOWN',
      reason:                  intent.reason ?? '',
      sourceCycle:             intent.sourceCycle ?? '',
      clusterRisk:             intent.clusterRisk ?? null,
      ripperScore:             intent.ripperScore ?? null,
      launchAgeBucket:         intent.launchAgeBucket ?? null,
      entryDecision:           intent.entryDecision ?? null,
      targetEntryAt:           intent.targetEntryAt ?? '',
      observedAt:              intent.observedAt ?? '',
      priceChangePct:          intent.priceChangePct,
      simulatedPnlPct:         intent.priceChangePct,
      entryMomentumPct:        m5,
      entryMomentumSource:     m5 != null ? (cycleRow?.entryMomentumSource ?? 'DEX_SCREENER_M5') : 'UNAVAILABLE',
      entryMomentumWindowLabel: m5 != null ? (cycleRow?.entryMomentumWindowLabel ?? 'M5') : 'UNAVAILABLE',
      liquidityBucket:         mem?.liquidityBucket ?? null,
      vlrBucket:               mem?.vlrBucket ?? null,
      timingPath:              mem?.timingPath ?? null,
      m5Band:                  m5BandLabel(m5),
    });
  }

  // ── Overall stats ───────────────────────────────────────────────────────────
  const total    = simulatedTrades.length;
  const winners  = simulatedTrades.filter(t => t.simulatedPnlPct > WIN_THRESHOLD).length;
  const losers   = simulatedTrades.filter(t => t.simulatedPnlPct <= WIN_THRESHOLD).length;
  const flat     = simulatedTrades.filter(t => t.simulatedPnlPct === 0).length;
  const pnls     = simulatedTrades.map(t => t.simulatedPnlPct);
  const pnlsTrimmed = pnls.filter(p => p <= 500);

  const sorted = [...simulatedTrades].sort((a, b) => b.simulatedPnlPct - a.simulatedPnlPct);
  const bestTrade  = sorted[0] ?? null;
  const worstTrade = sorted[sorted.length - 1] ?? null;

  // ── Group stats ─────────────────────────────────────────────────────────────
  function makeGroups(keyFn: (t: SimulatedTrade) => string): GroupStat[] {
    const grouped = groupBy(simulatedTrades, keyFn);
    return [...grouped.entries()]
      .map(([label, trades]) => buildGroupStat(label, trades))
      .sort((a, b) => b.n - a.n);
  }

  const byPaperEntryTiming = makeGroups(t => t.paperEntryTiming);
  const byEntryDecision    = makeGroups(t => t.entryDecision ?? 'null');
  const byM5Band           = makeGroups(t => t.m5Band);
  const byLiquidityBucket  = makeGroups(t => t.liquidityBucket ?? 'UNKNOWN');
  const byVlrBucket        = makeGroups(t => t.vlrBucket ?? 'UNKNOWN');

  // ── Danger / false comfort section ─────────────────────────────────────────
  function toDanger(t: SimulatedTrade, dangerType: string): DangerCase {
    return {
      contract:         t.contract,
      symbol:           t.symbol,
      simulatedPnlPct:  t.simulatedPnlPct,
      ripperScore:      t.ripperScore,
      clusterRisk:      t.clusterRisk,
      entryMomentumPct: t.entryMomentumPct,
      m5Band:           t.m5Band,
      dangerType,
    };
  }

  const highScoreLosers = simulatedTrades
    .filter(t => (t.ripperScore ?? 0) >= 80 && t.simulatedPnlPct <= WIN_THRESHOLD)
    .sort((a, b) => a.simulatedPnlPct - b.simulatedPnlPct)
    .slice(0, MAX_DANGER_ROWS)
    .map(t => toDanger(t, 'HIGH_SCORE_LOSER'));

  const cleanLosers = simulatedTrades
    .filter(t => t.clusterRisk === 'CLEAN' && t.simulatedPnlPct <= WIN_THRESHOLD)
    .sort((a, b) => a.simulatedPnlPct - b.simulatedPnlPct)
    .slice(0, MAX_DANGER_ROWS)
    .map(t => toDanger(t, 'CLEAN_LOSER'));

  const posM5Losers = simulatedTrades
    .filter(t => t.entryMomentumPct != null && t.entryMomentumPct > 0 && t.simulatedPnlPct <= WIN_THRESHOLD)
    .sort((a, b) => a.simulatedPnlPct - b.simulatedPnlPct)
    .slice(0, MAX_DANGER_ROWS)
    .map(t => toDanger(t, 'POSITIVE_M5_LOSER'));

  const negM5Winners = simulatedTrades
    .filter(t => t.entryMomentumPct != null && t.entryMomentumPct <= 0 && t.simulatedPnlPct > WIN_THRESHOLD)
    .sort((a, b) => b.simulatedPnlPct - a.simulatedPnlPct)
    .slice(0, MAX_DANGER_ROWS)
    .map(t => toDanger(t, 'NEGATIVE_M5_WINNER'));

  const notObviousWinners = simulatedTrades
    .filter(t =>
      t.simulatedPnlPct > 20 &&
      ((t.ripperScore ?? 0) < 80 || t.clusterRisk !== 'CLEAN')
    )
    .sort((a, b) => b.simulatedPnlPct - a.simulatedPnlPct)
    .slice(0, MAX_DANGER_ROWS)
    .map(t => toDanger(t, 'NOT_OBVIOUS_WINNER'));

  // ── Recommendation ──────────────────────────────────────────────────────────
  let recommendation: string;
  let recommendationReason: string;

  if (total < 20) {
    recommendation = 'SIGNAL_TOO_THIN';
    recommendationReason = `Only ${total} simulated trades — n < 20, cannot draw conclusions.`;
  } else if (total < 50) {
    recommendation = 'KEEP_COLLECTING';
    recommendationReason = `${total} trades is interesting but n < 50. Continue collecting paper observations.`;
  } else {
    const winRate = total > 0 ? winners / total : 0;
    if (winRate < 0.35) {
      recommendation = 'BAD_APPROVAL_QUALITY';
      recommendationReason = `Win rate ${(winRate * 100).toFixed(1)}% with n=${total} suggests current approval criteria are not selecting for outperformers. Study false-approve junk patterns.`;
    } else if (winRate >= 0.50) {
      recommendation = 'POSSIBLE_EDGE_RESEARCH_ONLY';
      recommendationReason = `Win rate ${(winRate * 100).toFixed(1)}% with n=${total} suggests possible edge. Research-only — DO_NOT_PROMOTE_TO_GATES without forward paper evidence.`;
    } else {
      recommendation = 'KEEP_COLLECTING';
      recommendationReason = `Win rate ${(winRate * 100).toFixed(1)}% with n=${total}. Pattern not yet conclusive. Continue forward paper data collection.`;
    }
  }

  return {
    simulatedTrades,
    observedIntentsRead:  observedIntents.length,
    skippedNonObserved:   skipped,

    totalSimulated:   total,
    winners,
    losers,
    flat,
    winRate:          total > 0 ? winners / total : 0,
    lossRate:         total > 0 ? losers  / total : 0,
    avgPnlPct:        avg(pnls),
    avgPnlPctTrimmed: avg(pnlsTrimmed),
    medianPnlPct:     median(pnls),
    bestTrade,
    worstTrade,

    byPaperEntryTiming,
    byEntryDecision,
    byM5Band,
    byLiquidityBucket,
    byVlrBucket,

    highScoreLosers,
    cleanLosers,
    posM5Losers,
    negM5Winners,
    notObviousWinners,

    recommendation,
    recommendationReason,

    reportOnly:          true,
    readOnly:            true,
    paperOnly:           true,
    realTradingLocked:   true,
    tradingExecuted:     0,
    noGateChanges:       true,
    noFakeTradeMutation: true,
    noRealTrading:       true,
    noWallet:            true,
    noSwap:              true,
    noSigning:           true,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────────

function pct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

function pnlStr(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

function renderGroupTable(groups: GroupStat[]): string[] {
  const L: string[] = [];
  if (groups.length === 0) {
    L.push('  (no data)');
    return L;
  }
  const colW = 24;
  L.push(`  ${'group'.padEnd(colW)} ${'n'.padStart(5)} ${'win%'.padStart(6)} ${'avg P/L'.padStart(9)} ${'med P/L'.padStart(9)} tier`);
  L.push(`  ${'-'.repeat(colW)} ${'-----'} ${'------'} ${'--------'} ${'--------'} ----------------`);
  for (const g of groups) {
    if (g.n === 0) continue;
    const label = g.label.slice(0, colW).padEnd(colW);
    L.push(
      `  ${label} ${String(g.n).padStart(5)} ${pct(g.winRate).padStart(6)} ` +
      `${pnlStr(g.avgPnl).padStart(9)} ${pnlStr(g.medianPnl).padStart(9)} ${g.tier}`,
    );
  }
  return L;
}

export function renderPaperTradeSimulationReport(result: PaperTradeSimulationResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — PAPER TRADE SIMULATION REPORT');
  L.push('  [REPORT ONLY — NO REAL TRADES — NO FAKE TRADE MUTATION — READ ONLY]');
  L.push(SEP, '');
  L.push('  Note: simulatedPnlPct = priceChangePct from the OBSERVED paper intent.');
  L.push('  This is the observation window result, not a real trade P/L.');
  L.push('  Used as first approximation only. Subject to Brain Doctrine contamination warning.');
  L.push('');

  // §1 — Overall performance
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERALL SIMULATED PERFORMANCE');
  L.push(`  ${SEP2}`, '');
  L.push(`  Intents read (all statuses)    : ${result.observedIntentsRead + result.skippedNonObserved}`);
  L.push(`  Skipped (non-OBSERVED)         : ${result.skippedNonObserved}`);
  L.push(`  Simulated trades (OBSERVED)    : ${result.totalSimulated}`);
  L.push('');
  L.push(`  Winners (pcp > 0)              : ${result.winners}`);
  L.push(`  Losers  (pcp <= 0)             : ${result.losers}`);
  L.push(`  Flat    (pcp = 0)              : ${result.flat}`);
  L.push(`  Win rate                       : ${pct(result.winRate)}`);
  L.push(`  Loss rate                      : ${pct(result.lossRate)}`);
  L.push('');
  L.push(`  Avg simulated P/L (raw)        : ${pnlStr(result.avgPnlPct)}`);
  L.push(`  Avg simulated P/L (capped 500%): ${pnlStr(result.avgPnlPctTrimmed)}`);
  L.push(`  Median simulated P/L           : ${pnlStr(result.medianPnlPct)}`);
  L.push('');
  if (result.bestTrade) {
    L.push(`  Best trade  : ${result.bestTrade.symbol} (${result.bestTrade.contract.slice(0, 16)}…)`);
    L.push(`                pnl=${pnlStr(result.bestTrade.simulatedPnlPct)}  timing=${result.bestTrade.paperEntryTiming}`);
  }
  if (result.worstTrade) {
    L.push(`  Worst trade : ${result.worstTrade.symbol} (${result.worstTrade.contract.slice(0, 16)}…)`);
    L.push(`                pnl=${pnlStr(result.worstTrade.simulatedPnlPct)}  timing=${result.worstTrade.paperEntryTiming}`);
  }
  L.push('');

  // §2 — By paperEntryTiming
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — BY PAPER ENTRY TIMING');
  L.push(`  ${SEP2}`, '');
  L.push(...renderGroupTable(result.byPaperEntryTiming));
  L.push('');

  // §3 — By entryDecision
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — BY ENTRY DECISION');
  L.push(`  ${SEP2}`, '');
  L.push(...renderGroupTable(result.byEntryDecision));
  L.push('');

  // §4 — By M5 band
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — BY M5 MOMENTUM BAND (entryMomentumPct)');
  L.push(`  ${SEP2}`, '');
  L.push('  Note: UNAVAILABLE = cycle row predates 2026-06-18 entryMomentumPct field.');
  L.push('  Future token:dex-day-watch runs will populate DEX_SCREENER_M5 data.');
  L.push('');
  // Sort M5 bands in canonical order
  const m5Order = ['M5 <= -20', '-20 to -5', '-5 to +5', '+5 to +20', '+20 to +50', '> +50', 'UNAVAILABLE'];
  const m5Sorted = [...result.byM5Band].sort((a, b) =>
    m5Order.indexOf(a.label) - m5Order.indexOf(b.label)
  );
  L.push(...renderGroupTable(m5Sorted));
  L.push('');

  // §5 — By liquidity bucket
  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — BY LIQUIDITY BUCKET');
  L.push(`  ${SEP2}`, '');
  L.push(...renderGroupTable(result.byLiquidityBucket));
  L.push('');

  // §6 — By VLR bucket
  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — BY VLR BUCKET');
  L.push(`  ${SEP2}`, '');
  L.push(...renderGroupTable(result.byVlrBucket));
  L.push('');

  // §7 — False comfort / danger
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — FALSE COMFORT / DANGER CASES');
  L.push(`  ${SEP2}`, '');

  function renderDanger(cases: DangerCase[], heading: string, desc: string): void {
    L.push(`  [${heading}]  (n=${cases.length})`);
    L.push(`  ${desc}`);
    if (cases.length === 0) {
      L.push('  (none)');
    } else {
      for (const c of cases) {
        L.push(
          `    ${c.symbol.padEnd(14)} pnl=${pnlStr(c.simulatedPnlPct).padStart(10)}` +
          `  score=${c.ripperScore?.toFixed(0) ?? 'null'}` +
          `  cluster=${c.clusterRisk ?? 'null'}` +
          `  m5=${c.entryMomentumPct != null ? c.entryMomentumPct.toFixed(1) + '%' : 'n/a'}` +
          `  band=${c.m5Band}`,
        );
      }
    }
    L.push('');
  }

  renderDanger(
    result.highScoreLosers,
    'HIGH_SCORE_LOSERS',
    'ripperScore >= 80 but simulatedPnlPct <= 0. High score did not protect.',
  );
  renderDanger(
    result.cleanLosers,
    'CLEAN_CLUSTER_LOSERS',
    'clusterRisk=CLEAN but simulatedPnlPct <= 0. Clean holders did not ensure outcome.',
  );
  renderDanger(
    result.posM5Losers,
    'POSITIVE_M5_LOSERS',
    'entryMomentumPct > 0 but simulatedPnlPct <= 0. Positive M5 did not guarantee win.',
  );
  renderDanger(
    result.negM5Winners,
    'NEGATIVE_M5_WINNERS',
    'entryMomentumPct <= 0 but simulatedPnlPct > 0. Negative M5 did not prevent win.',
  );
  renderDanger(
    result.notObviousWinners,
    'NOT_OBVIOUS_WINNERS',
    'pnl > 20% but ripperScore < 80 or clusterRisk != CLEAN. Won despite imperfect signals.',
  );

  // §8 — Recommendation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — RECOMMENDATION');
  L.push(`  ${SEP2}`, '');
  L.push(`  [${result.recommendation}]`);
  L.push(`  ${result.recommendationReason}`);
  L.push('');
  L.push('  DO_NOT_PROMOTE_TO_GATES — this is simulated paper data only.');
  L.push('  No gate, scoring, or buy approval changes should follow from this report.');
  L.push('  Refer to Brain Doctrine v1: npm run token:ripper-brain-doctrine-report');
  L.push('');

  // §9 — Safety
  L.push(`  ${SEP2}`);
  L.push('  SECTION 9 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true      READ_ONLY=true       PAPER_ONLY=true');
  L.push('  NO_REAL_TRADING=true  NO_FAKE_TRADE_MUTATION=true  NO_GATE_CHANGES=true');
  L.push('  NO_WALLET=true        NO_SWAP=true         NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING    tradingExecuted=0    realTradingLocked=true');
  L.push('  No data files mutated.  No fake trade ledger appended.  No paper-buy called.');
  L.push('  Do not call token:paper-buy or token:auto-paper from this report.');
  L.push(SEP, '');

  return L.join('\n');
}
