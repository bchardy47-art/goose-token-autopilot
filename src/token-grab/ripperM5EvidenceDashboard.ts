import * as fs   from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_PATH  = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_INTENTS_PATH = 'data/token-grab/ripper/paper-intents.jsonl';
const DEFAULT_MIN_N        = 1;
const DEFAULT_TOP_N        = 10;
const PNL_CAP              = 500;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── M5 Band definitions ────────────────────────────────────────────────────────

export type M5Band =
  | 'M5_VERY_NEGATIVE'  // <= -20
  | 'M5_NEGATIVE'       // -20 to -5
  | 'M5_NEUTRAL'        // -5 to +5
  | 'M5_POSITIVE'       // +5 to +20
  | 'M5_STRONG'         // +20 to +50
  | 'M5_VERY_STRONG'    // > +50
  | 'UNAVAILABLE';

export const M5_BAND_ORDER: M5Band[] = [
  'M5_VERY_NEGATIVE',
  'M5_NEGATIVE',
  'M5_NEUTRAL',
  'M5_POSITIVE',
  'M5_STRONG',
  'M5_VERY_STRONG',
  'UNAVAILABLE',
];

export function m5ToBand(m5: number | null | undefined): M5Band {
  if (m5 == null || !Number.isFinite(m5)) return 'UNAVAILABLE';
  if (m5 <= -20) return 'M5_VERY_NEGATIVE';
  if (m5 < -5)   return 'M5_NEGATIVE';
  if (m5 <= 5)   return 'M5_NEUTRAL';
  if (m5 <= 20)  return 'M5_POSITIVE';
  if (m5 <= 50)  return 'M5_STRONG';
  return 'M5_VERY_STRONG';
}

// ── Evidence maturity ──────────────────────────────────────────────────────────

export type EvidenceMaturity =
  | 'NO_M5_DATA'
  | 'TINY_SAMPLE'
  | 'EARLY_SAMPLE'
  | 'USABLE_SAMPLE'
  | 'STRONG_SAMPLE';

export function getMaturity(m5RowCount: number): EvidenceMaturity {
  if (m5RowCount === 0)   return 'NO_M5_DATA';
  if (m5RowCount < 50)    return 'TINY_SAMPLE';
  if (m5RowCount < 200)   return 'EARLY_SAMPLE';
  if (m5RowCount < 500)   return 'USABLE_SAMPLE';
  return 'STRONG_SAMPLE';
}

// ── Confidence tier ────────────────────────────────────────────────────────────

export type ConfidenceTier =
  | 'IGNORE'
  | 'INTERESTING_ONLY'
  | 'EARLY_EVIDENCE'
  | 'USABLE_SIGNAL'
  | 'STRONGER';

export function getConfidenceTier(n: number): ConfidenceTier {
  if (n < 20)  return 'IGNORE';
  if (n < 50)  return 'INTERESTING_ONLY';
  if (n < 200) return 'EARLY_EVIDENCE';
  if (n < 500) return 'USABLE_SIGNAL';
  return 'STRONGER';
}

// ── Recommendation ─────────────────────────────────────────────────────────────

export type Recommendation =
  | 'KEEP_COLLECTING'
  | 'STUDY_ONLY'
  | 'READY_FOR_GATE_PROPOSAL';

// ── Raw memory row ─────────────────────────────────────────────────────────────

export interface RawMemRow {
  contract?:         string;
  symbol?:           string;
  capturedAt?:       string;
  observedAt?:       string | null;
  entryMomentumPct?: number | null;
  priceChangePct?:   number | null;
  liquidityBucket?:  string;
  vlrBucket?:        string;
  clusterRisk?:      string;
  timingPath?:       string;
  gateDecision?:     string;
  entryDecision?:    string;
  outcomeLabel?:     string;
}

// ── Band stats ─────────────────────────────────────────────────────────────────

export interface BandStats {
  band:           M5Band;
  n:              number;
  pnlN:           number;
  wins:           number;
  losses:         number;
  winRate:        number | null;
  lossRate:       number | null;
  avgPnlRaw:      number | null;
  avgPnlCapped:   number | null;
  medianPnl:      number | null;
  bigWinners:     number;
  bigLosers:      number;
  confidenceTier: ConfidenceTier;
}

export interface CrossTabCell {
  m5Band:         M5Band;
  secondaryKey:   string;
  n:              number;
  pnlN:           number;
  wins:           number;
  winRate:        number | null;
  avgPnlCapped:   number | null;
  bigWinners:     number;
  confidenceTier: ConfidenceTier;
}

export interface FalseComfortCase {
  contract:        string;
  symbol:          string | null;
  pnl:             number;
  m5:              number;
  m5Band:          M5Band;
  liquidityBucket: string;
  vlrBucket:       string;
  clusterRisk:     string;
  timingPath:      string;
}

export interface NegativeM5Winner {
  contract:        string;
  symbol:          string | null;
  pnl:             number;
  m5:              number;
  m5Band:          M5Band;
  liquidityBucket: string;
  vlrBucket:       string;
  clusterRisk:     string;
  timingPath:      string;
}

// ── Dashboard result ───────────────────────────────────────────────────────────

export interface M5EvidenceDashboardResult {
  generatedAt:              string;

  // §1 — overview
  totalRows:                number;
  rowsWithM5:               number;
  rowsWithoutM5:            number;
  m5CoveragePct:            number;
  rowsWithPnl:              number;
  m5RowsWithPnl:            number;
  latestObservedAt:         string | null;
  latestCapturedAt:         string | null;
  evidenceMaturity:         EvidenceMaturity;

  // §2 — band performance
  bandStats:                BandStats[];

  // §3-6 — cross-tabs
  liqCrossTab:              CrossTabCell[];
  vlrCrossTab:              CrossTabCell[];
  clusterCrossTab:          CrossTabCell[];
  timingCrossTab:           CrossTabCell[];

  // §7-8 — case samples
  falseComfortCases:        FalseComfortCase[];
  negativeM5Winners:        NegativeM5Winner[];

  // §9 — conclusions
  topHints:                 string[];
  warnings:                 string[];
  notProvenYet:             string[];
  minSamplesNeeded:         string;

  // §10 — recommendation
  recommendation:           Recommendation;
  recommendationReason:     string;

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

// ── Options ────────────────────────────────────────────────────────────────────

export interface M5EvidenceDashboardOptions {
  memoryPath?:   string;
  intentsPath?:  string;
  minN?:         number;
  topN?:         number;
  generatedAt?:  string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((r): r is T => r != null);
}

function cap(pnl: number): number {
  return Math.max(-PNL_CAP, Math.min(PNL_CAP, pnl));
}

function avg(arr: number[]): number | null {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function computeBandStats(band: M5Band, rows: RawMemRow[]): BandStats {
  const pnlRows = rows.filter(r => r.priceChangePct != null);
  const pnls    = pnlRows.map(r => r.priceChangePct!);
  const wins    = pnls.filter(p => p > 0).length;
  const losses  = pnls.filter(p => p <= 0).length;
  return {
    band,
    n:              rows.length,
    pnlN:           pnlRows.length,
    wins,
    losses,
    winRate:        pnlRows.length > 0 ? wins / pnlRows.length : null,
    lossRate:       pnlRows.length > 0 ? losses / pnlRows.length : null,
    avgPnlRaw:      avg(pnls),
    avgPnlCapped:   avg(pnls.map(cap)),
    medianPnl:      median(pnls),
    bigWinners:     pnls.filter(p => p >= 20).length,
    bigLosers:      pnls.filter(p => p <= -20).length,
    confidenceTier: getConfidenceTier(pnlRows.length),
  };
}

function computeCrossTabCell(m5Band: M5Band, secondaryKey: string, rows: RawMemRow[]): CrossTabCell {
  const pnlRows = rows.filter(r => r.priceChangePct != null);
  const pnls    = pnlRows.map(r => r.priceChangePct!);
  const wins    = pnls.filter(p => p > 0).length;
  return {
    m5Band,
    secondaryKey,
    n:              rows.length,
    pnlN:           pnlRows.length,
    wins,
    winRate:        pnlRows.length > 0 ? wins / pnlRows.length : null,
    avgPnlCapped:   avg(pnls.map(cap)),
    bigWinners:     pnls.filter(p => p >= 20).length,
    confidenceTier: getConfidenceTier(pnlRows.length),
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runM5EvidenceDashboard(
  opts: M5EvidenceDashboardOptions = {},
): M5EvidenceDashboardResult {
  const memoryPath  = opts.memoryPath  ?? DEFAULT_MEMORY_PATH;
  const intentsPath = opts.intentsPath ?? DEFAULT_INTENTS_PATH;
  const topN        = opts.topN        ?? DEFAULT_TOP_N;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  // Build symbol lookup from intents (optional — best effort)
  const symbolMap = new Map<string, string>();
  const rawIntents = readJsonl<{ contract?: string; symbol?: string }>(intentsPath);
  for (const r of rawIntents) {
    if (r.contract && r.symbol && !symbolMap.has(r.contract)) {
      symbolMap.set(r.contract, r.symbol);
    }
  }

  const allRows = readJsonl<RawMemRow>(memoryPath);

  let latestObservedAt: string | null = null;
  let latestCapturedAt: string | null = null;

  for (const r of allRows) {
    if (r.observedAt && (!latestObservedAt || r.observedAt > latestObservedAt)) {
      latestObservedAt = r.observedAt;
    }
    if (r.capturedAt && (!latestCapturedAt || r.capturedAt > latestCapturedAt)) {
      latestCapturedAt = r.capturedAt;
    }
  }

  const totalRows   = allRows.length;
  const rowsWithM5  = allRows.filter(r => r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct)).length;
  const rowsWithPnl = allRows.filter(r => r.priceChangePct != null).length;
  const m5RowsWithPnl = allRows.filter(
    r => r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct) && r.priceChangePct != null,
  ).length;

  const m5CoveragePct   = totalRows > 0 ? (rowsWithM5 / totalRows) * 100 : 0;
  const evidenceMaturity = getMaturity(rowsWithM5);

  // Group all rows by M5 band
  const byBand = new Map<M5Band, RawMemRow[]>();
  for (const band of M5_BAND_ORDER) byBand.set(band, []);
  for (const r of allRows) {
    const band = m5ToBand(r.entryMomentumPct);
    byBand.get(band)!.push(r);
  }

  const bandStats: BandStats[] = M5_BAND_ORDER.map(band =>
    computeBandStats(band, byBand.get(band)!),
  );

  // Cross-tabs — only include M5 rows (exclude UNAVAILABLE for cross-tabs)
  const m5Rows = allRows.filter(r => r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct));

  function buildCrossTab(getKey: (r: RawMemRow) => string): CrossTabCell[] {
    const cells: CrossTabCell[] = [];
    for (const band of M5_BAND_ORDER) {
      if (band === 'UNAVAILABLE') continue;
      const bandRows = byBand.get(band)!.filter(r =>
        r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct),
      );
      const keys = new Set(bandRows.map(getKey));
      for (const key of Array.from(keys).sort()) {
        const cellRows = bandRows.filter(r => getKey(r) === key);
        cells.push(computeCrossTabCell(band, key, cellRows));
      }
    }
    return cells;
  }

  const liqCrossTab     = buildCrossTab(r => r.liquidityBucket ?? 'UNKNOWN');
  const vlrCrossTab     = buildCrossTab(r => r.vlrBucket       ?? 'UNKNOWN');
  const clusterCrossTab = buildCrossTab(r => r.clusterRisk     ?? 'UNKNOWN');
  const timingCrossTab  = buildCrossTab(r => r.timingPath      ?? 'UNKNOWN');

  // False comfort: positive M5, losing outcome
  const falseComfortRaw = m5Rows
    .filter(r => r.entryMomentumPct! > 0 && r.priceChangePct != null && r.priceChangePct <= 0)
    .sort((a, b) => (a.priceChangePct ?? 0) - (b.priceChangePct ?? 0))
    .slice(0, topN);

  const falseComfortCases: FalseComfortCase[] = falseComfortRaw.map(r => ({
    contract:        r.contract ?? 'unknown',
    symbol:          r.symbol ?? symbolMap.get(r.contract ?? '') ?? null,
    pnl:             r.priceChangePct!,
    m5:              r.entryMomentumPct!,
    m5Band:          m5ToBand(r.entryMomentumPct),
    liquidityBucket: r.liquidityBucket ?? 'UNKNOWN',
    vlrBucket:       r.vlrBucket       ?? 'UNKNOWN',
    clusterRisk:     r.clusterRisk     ?? 'UNKNOWN',
    timingPath:      r.timingPath      ?? 'UNKNOWN',
  }));

  // Negative M5 winners: m5 <= 0, positive PNL
  const negativeM5WinnersRaw = m5Rows
    .filter(r => r.entryMomentumPct! <= 0 && r.priceChangePct != null && r.priceChangePct > 0)
    .sort((a, b) => (b.priceChangePct ?? 0) - (a.priceChangePct ?? 0))
    .slice(0, topN);

  const negativeM5Winners: NegativeM5Winner[] = negativeM5WinnersRaw.map(r => ({
    contract:        r.contract ?? 'unknown',
    symbol:          r.symbol ?? symbolMap.get(r.contract ?? '') ?? null,
    pnl:             r.priceChangePct!,
    m5:              r.entryMomentumPct!,
    m5Band:          m5ToBand(r.entryMomentumPct),
    liquidityBucket: r.liquidityBucket ?? 'UNKNOWN',
    vlrBucket:       r.vlrBucket       ?? 'UNKNOWN',
    clusterRisk:     r.clusterRisk     ?? 'UNKNOWN',
    timingPath:      r.timingPath      ?? 'UNKNOWN',
  }));

  // Evidence conclusions
  const topHints: string[] = [];
  const warnings: string[] = [];
  const notProvenYet: string[] = [];

  const usableBands = bandStats.filter(b => b.band !== 'UNAVAILABLE' && b.confidenceTier !== 'IGNORE');
  const bestBand    = usableBands.length > 0
    ? usableBands.reduce((a, b) => (b.avgPnlCapped ?? -Infinity) > (a.avgPnlCapped ?? -Infinity) ? b : a)
    : null;
  const worstBand   = usableBands.length > 0
    ? usableBands.reduce((a, b) => (b.avgPnlCapped ?? Infinity) < (a.avgPnlCapped ?? Infinity) ? b : a)
    : null;

  if (m5RowsWithPnl === 0) {
    warnings.push('No M5 rows with PNL outcomes yet — all stats are empty.');
  } else {
    if (bestBand) {
      topHints.push(`Best M5 band by capped avg P/L: ${bestBand.band} (n=${bestBand.pnlN}, avg=${fmt1(bestBand.avgPnlCapped)}%, win=${pct(bestBand.winRate)}, tier=${bestBand.confidenceTier})`);
    }
    if (worstBand && worstBand !== bestBand) {
      topHints.push(`Weakest M5 band by capped avg P/L: ${worstBand.band} (n=${worstBand.pnlN}, avg=${fmt1(worstBand.avgPnlCapped)}%, win=${pct(worstBand.winRate)}, tier=${worstBand.confidenceTier})`);
    }
    if (falseComfortCases.length > 0) {
      warnings.push(`${falseComfortCases.length} false comfort case(s): positive M5 entry but losing outcome. Positive momentum is not a reliable buy signal yet.`);
    }
    if (negativeM5Winners.length > 0) {
      topHints.push(`${negativeM5Winners.length} negative/flat M5 winner(s): entry succeeded despite negative momentum — M5 alone is not a veto signal.`);
    }
  }

  if (evidenceMaturity === 'TINY_SAMPLE' || evidenceMaturity === 'NO_M5_DATA') {
    warnings.push(`Only ${rowsWithM5} M5 rows (need >= 50 for EARLY_SAMPLE). All band stats are too thin to trust.`);
  }
  if (evidenceMaturity === 'EARLY_SAMPLE') {
    warnings.push(`EARLY_SAMPLE (${rowsWithM5} M5 rows). Band stats directional only — do not tune gates.`);
  }

  notProvenYet.push('M5 momentum causality vs. correlation not established.');
  notProvenYet.push('No band has >= 200 PNL rows — USABLE_SIGNAL threshold not reached.');
  notProvenYet.push('Cross-tab cells are all IGNORE or INTERESTING_ONLY — interactions unproven.');
  notProvenYet.push('READY_FOR_GATE_PROPOSAL requires a band with pnlN >= 500.');

  const minSamplesNeeded = `Need ${Math.max(0, 200 - m5RowsWithPnl)} more M5+PNL rows for USABLE_SAMPLE; ${Math.max(0, 500 - m5RowsWithPnl)} more for READY_FOR_GATE_PROPOSAL.`;

  // Recommendation
  let recommendation: Recommendation;
  let recommendationReason: string;

  const strongBand = bandStats.find(b => b.band !== 'UNAVAILABLE' && b.pnlN >= 500);
  if (m5RowsWithPnl < 200) {
    recommendation = 'KEEP_COLLECTING';
    recommendationReason = `Only ${m5RowsWithPnl} M5+PNL rows. Minimum 200 needed before study phase.`;
  } else if (!strongBand) {
    recommendation = 'STUDY_ONLY';
    recommendationReason = `>= 200 M5+PNL rows but no band reaches pnlN >= 500. Study patterns without gate changes.`;
  } else {
    recommendation = 'READY_FOR_GATE_PROPOSAL';
    recommendationReason = `Band ${strongBand.band} has pnlN=${strongBand.pnlN} >= 500 with material performance signal.`;
  }

  return {
    generatedAt,
    totalRows,
    rowsWithM5,
    rowsWithoutM5: totalRows - rowsWithM5,
    m5CoveragePct,
    rowsWithPnl,
    m5RowsWithPnl,
    latestObservedAt,
    latestCapturedAt,
    evidenceMaturity,

    bandStats,
    liqCrossTab,
    vlrCrossTab,
    clusterCrossTab,
    timingCrossTab,

    falseComfortCases,
    negativeM5Winners,

    topHints,
    warnings,
    notProvenYet,
    minSamplesNeeded,

    recommendation,
    recommendationReason,

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

// ── Format helpers ─────────────────────────────────────────────────────────────

function fmt1(v: number | null | undefined): string {
  if (v == null) return '  n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}

function pct(v: number | null): string {
  if (v == null) return '  n/a';
  return (v * 100).toFixed(1) + '%';
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderM5EvidenceDashboard(result: M5EvidenceDashboardResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — M5 EVIDENCE DASHBOARD v1');
  L.push('  [REPORT ONLY — READ ONLY — NO MUTATION — NO GATE CHANGES — NO POLICY CHANGE]');
  L.push(SEP, '');

  // §1 — Overview
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Generated at            : ${result.generatedAt}`);
  L.push(`  Total memory rows       : ${result.totalRows}`);
  L.push(`  Rows with M5            : ${result.rowsWithM5}`);
  L.push(`  Rows without M5         : ${result.rowsWithoutM5}  (UNAVAILABLE)`);
  L.push(`  M5 coverage             : ${result.m5CoveragePct.toFixed(1)}%`);
  L.push(`  Rows with PNL (all)     : ${result.rowsWithPnl}`);
  L.push(`  M5 rows with PNL        : ${result.m5RowsWithPnl}`);
  L.push(`  Latest observedAt       : ${result.latestObservedAt ?? '(none)'}`);
  L.push(`  Latest capturedAt       : ${result.latestCapturedAt ?? '(none)'}`);
  L.push(`  Evidence maturity       : ${result.evidenceMaturity}`);
  L.push('');

  // §2 — M5 Band Performance
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — M5 BAND PERFORMANCE');
  L.push(`  ${SEP2}`, '');
  L.push(`  ${'band'.padEnd(20)} ${'n'.padStart(5)} ${'pnl_n'.padStart(6)} ${'win%'.padStart(6)} ${'loss%'.padStart(6)} ${'avg_raw'.padStart(9)} ${'avg_cap'.padStart(9)} ${'median'.padStart(8)} ${'bw'.padStart(4)} ${'bl'.padStart(4)}  tier`);
  L.push(`  ${'─'.repeat(20)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(8)} ${'─'.repeat(4)} ${'─'.repeat(4)}  ${'─'.repeat(18)}`);
  for (const s of result.bandStats) {
    L.push(
      `  ${s.band.padEnd(20)} ` +
      `${String(s.n).padStart(5)} ` +
      `${String(s.pnlN).padStart(6)} ` +
      `${pct(s.winRate).padStart(6)} ` +
      `${pct(s.lossRate).padStart(6)} ` +
      `${(fmt1(s.avgPnlRaw) + '%').padStart(9)} ` +
      `${(fmt1(s.avgPnlCapped) + '%').padStart(9)} ` +
      `${(fmt1(s.medianPnl) + '%').padStart(8)} ` +
      `${String(s.bigWinners).padStart(4)} ` +
      `${String(s.bigLosers).padStart(4)}  ` +
      `${s.confidenceTier}`,
    );
  }
  L.push('  (bw=big winners pcp>=20%, bl=big losers pcp<=-20%, avg_cap=capped at ±500%)');
  L.push('');

  // §3 — M5 × Liquidity
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — M5 × LIQUIDITY CROSS-TAB');
  L.push(`  ${SEP2}`, '');
  renderCrossTab(L, result.liqCrossTab, 'liquidityBucket');

  // §4 — M5 × VLR
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — M5 × VLR CROSS-TAB');
  L.push(`  ${SEP2}`, '');
  renderCrossTab(L, result.vlrCrossTab, 'vlrBucket');

  // §5 — M5 × Cluster Risk
  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — M5 × CLUSTER RISK CROSS-TAB');
  L.push(`  ${SEP2}`, '');
  renderCrossTab(L, result.clusterCrossTab, 'clusterRisk');

  // §6 — Timing by M5 Band
  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — TIMING PATH BY M5 BAND');
  L.push(`  ${SEP2}`, '');
  renderCrossTab(L, result.timingCrossTab, 'timingPath');

  // §7 — False Comfort
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 7 — FALSE COMFORT CASES (positive M5 → losing outcome, top ${result.falseComfortCases.length})`);
  L.push(`  ${SEP2}`, '');
  if (result.falseComfortCases.length === 0) {
    L.push('  (none — either no M5 data or no positive-M5 losses yet)');
  } else {
    L.push(`  ${'symbol'.padEnd(14)} ${'contract (prefix)'.padEnd(22)} ${'pnl'.padStart(8)} ${'m5'.padStart(8)} ${'band'.padEnd(20)} ${'liq'.padEnd(16)} ${'vlr'.padEnd(16)} ${'cluster'.padEnd(10)} timing`);
    L.push(`  ${'─'.repeat(14)} ${'─'.repeat(22)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(20)} ${'─'.repeat(16)} ${'─'.repeat(16)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
    for (const c of result.falseComfortCases) {
      const sym     = (c.symbol ?? '???').slice(0, 13).padEnd(14);
      const con     = c.contract.slice(0, 20).padEnd(22);
      const pnlStr  = (fmt1(c.pnl) + '%').padStart(8);
      const m5Str   = (fmt1(c.m5) + '%').padStart(8);
      const band    = c.m5Band.padEnd(20);
      const liq     = (c.liquidityBucket ?? '?').padEnd(16);
      const vlr     = (c.vlrBucket ?? '?').padEnd(16);
      const cluster = (c.clusterRisk ?? '?').padEnd(10);
      const timing  = c.timingPath ?? '?';
      L.push(`  ${sym} ${con} ${pnlStr} ${m5Str} ${band} ${liq} ${vlr} ${cluster} ${timing}`);
    }
  }
  L.push('');

  // §8 — Negative M5 Winners
  L.push(`  ${SEP2}`);
  L.push(`  SECTION 8 — NEGATIVE M5 WINNERS (M5 <= 0, positive outcome, top ${result.negativeM5Winners.length})`);
  L.push(`  ${SEP2}`, '');
  if (result.negativeM5Winners.length === 0) {
    L.push('  (none — either no M5 data or no negative-M5 winners yet)');
  } else {
    L.push(`  ${'symbol'.padEnd(14)} ${'contract (prefix)'.padEnd(22)} ${'pnl'.padStart(8)} ${'m5'.padStart(8)} ${'band'.padEnd(20)} ${'liq'.padEnd(16)} ${'vlr'.padEnd(16)} ${'cluster'.padEnd(10)} timing`);
    L.push(`  ${'─'.repeat(14)} ${'─'.repeat(22)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(20)} ${'─'.repeat(16)} ${'─'.repeat(16)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
    for (const c of result.negativeM5Winners) {
      const sym     = (c.symbol ?? '???').slice(0, 13).padEnd(14);
      const con     = c.contract.slice(0, 20).padEnd(22);
      const pnlStr  = (fmt1(c.pnl) + '%').padStart(8);
      const m5Str   = (fmt1(c.m5) + '%').padStart(8);
      const band    = c.m5Band.padEnd(20);
      const liq     = (c.liquidityBucket ?? '?').padEnd(16);
      const vlr     = (c.vlrBucket ?? '?').padEnd(16);
      const cluster = (c.clusterRisk ?? '?').padEnd(10);
      const timing  = c.timingPath ?? '?';
      L.push(`  ${sym} ${con} ${pnlStr} ${m5Str} ${band} ${liq} ${vlr} ${cluster} ${timing}`);
    }
  }
  L.push('');

  // §9 — Evidence Conclusions
  L.push(`  ${SEP2}`);
  L.push('  SECTION 9 — EVIDENCE CONCLUSIONS');
  L.push(`  ${SEP2}`, '');
  L.push('  Top hints:');
  if (result.topHints.length === 0) {
    L.push('    (no hints yet — sample too small)');
  } else {
    for (const h of result.topHints) L.push(`    • ${h}`);
  }
  L.push('');
  L.push('  Warnings:');
  for (const w of result.warnings) L.push(`    ⚠ ${w}`);
  L.push('');
  L.push('  Not proven yet:');
  for (const n of result.notProvenYet) L.push(`    ✗ ${n}`);
  L.push('');
  L.push(`  Min samples needed: ${result.minSamplesNeeded}`);
  L.push('');

  // §10 — Recommendation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 10 — RECOMMENDATION');
  L.push(`  ${SEP2}`, '');
  const recIcon = result.recommendation === 'READY_FOR_GATE_PROPOSAL' ? '✓' : '⚠';
  L.push(`  ${recIcon} ${result.recommendation}`);
  L.push(`    ${result.recommendationReason}`);
  L.push('');
  L.push('  DO NOT change gates or policy based on this report alone.');
  L.push('  DO NOT enable real trading.');
  L.push('');

  // §11 — Safety Footer
  L.push(`  ${SEP2}`);
  L.push('  SECTION 11 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true    READ_ONLY=true    PAPER_ONLY=true    NO_MUTATION=true');
  L.push('  NO_REAL_TRADING=true   NO_GATE_CHANGES=true   NO_POLICY_CHANGE=true');
  L.push('  NO_WALLET=true         NO_SWAP=true           NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING    tradingExecuted=0    realTradingLocked=true');
  L.push('  No data files mutated.  No gates changed.  No policy changed.');
  L.push(SEP, '');

  return L.join('\n');
}

function renderCrossTab(L: string[], cells: CrossTabCell[], _secondaryLabel: string): void {
  if (cells.length === 0) {
    L.push('  (no data)');
    L.push('');
    return;
  }
  L.push(`  ${'m5_band'.padEnd(20)} ${'secondary'.padEnd(18)} ${'n'.padStart(5)} ${'pnl_n'.padStart(6)} ${'win%'.padStart(6)} ${'avg_cap'.padStart(9)} ${'bw'.padStart(4)}  tier`);
  L.push(`  ${'─'.repeat(20)} ${'─'.repeat(18)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(4)}  ${'─'.repeat(18)}`);
  for (const c of cells) {
    L.push(
      `  ${c.m5Band.padEnd(20)} ` +
      `${c.secondaryKey.padEnd(18)} ` +
      `${String(c.n).padStart(5)} ` +
      `${String(c.pnlN).padStart(6)} ` +
      `${pct(c.winRate).padStart(6)} ` +
      `${(fmt1(c.avgPnlCapped) + '%').padStart(9)} ` +
      `${String(c.bigWinners).padStart(4)}  ` +
      `${c.confidenceTier}`,
    );
  }
  L.push('');
}
