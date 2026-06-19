import * as fs from 'fs';
import {
  m5ToBand,
  getMaturity,
  getConfidenceTier,
  M5_BAND_ORDER,
  type M5Band,
  type EvidenceMaturity,
  type ConfidenceTier,
  type RawMemRow,
} from './ripperM5EvidenceDashboard';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_PATH = 'data/token-grab/ripper/learning-memory.jsonl';
const DEFAULT_TOP_N       = 10;
const PNL_CAP             = 500;

const SEP  = '━'.repeat(64);
const SEP2 = '─'.repeat(64);

// ── Types ─────────────────────────────────────────────────────────────────────

export type DeepDiveRecommendation =
  | 'KEEP_COLLECTING'
  | 'STUDY_M5_NEUTRAL'
  | 'STUDY_M5_STRONG_EXHAUSTION'
  | 'READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW';

export interface BandScoreboard {
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
  lowNWarning:    boolean;
}

export interface SubgroupStats {
  key:            string;
  n:              number;
  pnlN:           number;
  wins:           number;
  losses:         number;
  winRate:        number | null;
  lossRate:       number | null;
  avgPnlCapped:   number | null;
  medianPnl:      number | null;
  bigWinners:     number;
  bigLosers:      number;
  confidenceTier: ConfidenceTier;
}

export interface CrossTabCellExtended {
  m5Band:         M5Band;
  secondaryKey:   string;
  n:              number;
  pnlN:           number;
  wins:           number;
  winRate:        number | null;
  avgPnlCapped:   number | null;
  medianPnl:      number | null;
  bigWinners:     number;
  bigLosers:      number;
  confidenceTier: ConfidenceTier;
}

export interface TradeRecord {
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

export interface BandDeepDive {
  band:          M5Band;
  totalN:        number;
  pnlN:          number;
  wins:          number;
  losses:        number;
  winRate:       number | null;
  avgPnlCapped:  number | null;
  medianPnl:     number | null;
  bigWinners:    number;
  bigLosers:     number;
  byLiquidity:   SubgroupStats[];
  byVlr:         SubgroupStats[];
  byCluster:     SubgroupStats[];
  byTiming:      SubgroupStats[];
  topWinners:    TradeRecord[];
  topLosers:     TradeRecord[];
  conclusion:    string;
}

export interface CandidateRule {
  description:    string;
  n:              number;
  confidenceTier: ConfidenceTier;
  studyOnly:      true;
}

export interface M5UsableSampleDeepDiveResult {
  generatedAt: string;

  // §1 — overview
  totalRows:        number;
  rowsWithM5:       number;
  rowsWithPnl:      number;
  m5RowsWithPnl:    number;
  m5CoveragePct:    number;
  latestObservedAt: string | null;
  latestCapturedAt: string | null;
  evidenceMaturity: EvidenceMaturity;
  maturityLabel:    string;

  // §2 — band scoreboard
  bandScoreboard: BandScoreboard[];
  bestBand:       M5Band | null;

  // §3 — M5_NEUTRAL deep dive
  neutralDeepDive: BandDeepDive;

  // §4 — M5_STRONG deep dive
  strongDeepDive: BandDeepDive;

  // §5-8 — cross-tabs (extended)
  liqCrossTab:     CrossTabCellExtended[];
  vlrCrossTab:     CrossTabCellExtended[];
  clusterCrossTab: CrossTabCellExtended[];
  timingCrossTab:  CrossTabCellExtended[];

  // §9 — candidate rules
  candidateRules: CandidateRule[];

  // §10 — not proven yet
  notProvenYet: string[];

  // §11 — recommendation
  recommendation:       DeepDiveRecommendation;
  recommendationReason: string;

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

export interface M5UsableSampleDeepDiveOptions {
  memoryPath?:  string;
  topN?:        number;
  generatedAt?: string;
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

function computeSubgroup(key: string, rows: RawMemRow[]): SubgroupStats {
  const pnlRows = rows.filter(r => r.priceChangePct != null);
  const pnls    = pnlRows.map(r => r.priceChangePct!);
  const wins    = pnls.filter(p => p > 0).length;
  const losses  = pnls.filter(p => p <= 0).length;
  return {
    key,
    n:              rows.length,
    pnlN:           pnlRows.length,
    wins,
    losses,
    winRate:        pnlRows.length > 0 ? wins / pnlRows.length : null,
    lossRate:       pnlRows.length > 0 ? losses / pnlRows.length : null,
    avgPnlCapped:   avg(pnls.map(cap)),
    medianPnl:      median(pnls),
    bigWinners:     pnls.filter(p => p >= 20).length,
    bigLosers:      pnls.filter(p => p <= -20).length,
    confidenceTier: getConfidenceTier(pnlRows.length),
  };
}

function subgroupsFor(rows: RawMemRow[], getKey: (r: RawMemRow) => string): SubgroupStats[] {
  const map = new Map<string, RawMemRow[]>();
  for (const r of rows) {
    const k = getKey(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, rs]) => computeSubgroup(k, rs));
}

function computeBandDeepDive(
  band: M5Band,
  bandRows: RawMemRow[],
  topN: number,
): BandDeepDive {
  const pnlRows = bandRows.filter(r => r.priceChangePct != null);
  const pnls    = pnlRows.map(r => r.priceChangePct!);
  const wins    = pnls.filter(p => p > 0).length;
  const losses  = pnls.filter(p => p <= 0).length;

  const byLiquidity = subgroupsFor(pnlRows, r => r.liquidityBucket ?? 'UNKNOWN');
  const byVlr       = subgroupsFor(pnlRows, r => r.vlrBucket       ?? 'UNKNOWN');
  const byCluster   = subgroupsFor(pnlRows, r => r.clusterRisk     ?? 'UNKNOWN');
  const byTiming    = subgroupsFor(pnlRows, r => r.timingPath      ?? 'UNKNOWN');

  const topWinners: TradeRecord[] = pnlRows
    .filter(r => (r.priceChangePct ?? 0) > 0)
    .sort((a, b) => (b.priceChangePct ?? 0) - (a.priceChangePct ?? 0))
    .slice(0, topN)
    .map(r => ({
      contract:        r.contract        ?? 'unknown',
      symbol:          r.symbol          ?? null,
      pnl:             r.priceChangePct!,
      m5:              r.entryMomentumPct!,
      m5Band:          band,
      liquidityBucket: r.liquidityBucket ?? 'UNKNOWN',
      vlrBucket:       r.vlrBucket       ?? 'UNKNOWN',
      clusterRisk:     r.clusterRisk     ?? 'UNKNOWN',
      timingPath:      r.timingPath      ?? 'UNKNOWN',
    }));

  const topLosers: TradeRecord[] = pnlRows
    .filter(r => (r.priceChangePct ?? 0) <= 0)
    .sort((a, b) => (a.priceChangePct ?? 0) - (b.priceChangePct ?? 0))
    .slice(0, topN)
    .map(r => ({
      contract:        r.contract        ?? 'unknown',
      symbol:          r.symbol          ?? null,
      pnl:             r.priceChangePct!,
      m5:              r.entryMomentumPct!,
      m5Band:          band,
      liquidityBucket: r.liquidityBucket ?? 'UNKNOWN',
      vlrBucket:       r.vlrBucket       ?? 'UNKNOWN',
      clusterRisk:     r.clusterRisk     ?? 'UNKNOWN',
      timingPath:      r.timingPath      ?? 'UNKNOWN',
    }));

  const conclusion = computeBandConclusion(band, pnlRows, wins, losses, byCluster, byLiquidity);

  return {
    band,
    totalN:       bandRows.length,
    pnlN:         pnlRows.length,
    wins,
    losses,
    winRate:      pnlRows.length > 0 ? wins / pnlRows.length : null,
    avgPnlCapped: avg(pnls.map(cap)),
    medianPnl:    median(pnls),
    bigWinners:   pnls.filter(p => p >= 20).length,
    bigLosers:    pnls.filter(p => p <= -20).length,
    byLiquidity,
    byVlr,
    byCluster,
    byTiming,
    topWinners,
    topLosers,
    conclusion,
  };
}

function computeBandConclusion(
  band: M5Band,
  pnlRows: RawMemRow[],
  wins: number,
  losses: number,
  byCluster: SubgroupStats[],
  byLiquidity: SubgroupStats[],
): string {
  const n = pnlRows.length;
  if (n === 0) return 'NO_DATA — no PNL rows for this band.';

  if (band === 'M5_STRONG') {
    if (n < 20) return `SAMPLE_TOO_SMALL (n=${n}) — cannot determine chase/exhaustion. Collect more data.`;
    const lossRate = losses / n;
    const avgCap   = avg(pnlRows.map(r => cap(r.priceChangePct!)));
    if (lossRate >= 0.6 && (avgCap ?? 0) < -10) {
      return `PROBABLE_EXHAUSTION (n=${n}) — loss rate ${(lossRate * 100).toFixed(0)}% and avg capped P/L ${(avgCap ?? 0).toFixed(1)}% suggest chase/exhaustion pattern. STUDY_ONLY.`;
    }
    return `NO_CLEAR_SIGNAL (n=${n}) — insufficient evidence for exhaustion or strength claim.`;
  }

  if (band === 'M5_NEUTRAL') {
    if (n < 20) return `SAMPLE_TOO_SMALL (n=${n}) — data too thin for conclusions.`;
    const unknownCluster = byCluster.find(s => s.key === 'UNKNOWN');
    const unknownPct = unknownCluster ? unknownCluster.n / n : 0;
    const liqUnknown = byLiquidity.find(s => s.key === 'LIQ_UNKNOWN');
    const liqUnknownPct = liqUnknown ? liqUnknown.n / n : 0;
    const winRate = n > 0 ? wins / n : 0;

    const warnings: string[] = [];
    if (unknownPct > 0.5) {
      warnings.push(`CLUSTER_ARTIFACT — ${(unknownPct * 100).toFixed(0)}% of rows have UNKNOWN cluster risk, potentially inflating apparent win rate`);
    }
    if (liqUnknownPct > 0.2) {
      warnings.push(`LIQ_ARTIFACT — ${(liqUnknownPct * 100).toFixed(0)}% of rows have unknown liquidity`);
    }

    if (warnings.length > 0) {
      return `CANDIDATE_PATTERN_WITH_ARTIFACTS (n=${n}, win_rate=${(winRate * 100).toFixed(0)}%) — ${warnings.join('; ')}. Verify CLEAN subset before concluding pattern is real.`;
    }
    if (winRate >= 0.55 && n >= 50) {
      return `CANDIDATE_PATTERN (n=${n}, win_rate=${(winRate * 100).toFixed(0)}%) — M5_NEUTRAL shows above-average win rate. STUDY_ONLY — not a gate.`;
    }
    return `WEAK_SIGNAL (n=${n}, win_rate=${(winRate * 100).toFixed(0)}%) — modest positive lean but no strong pattern evident.`;
  }

  return `BAND_SUMMARY (n=${n}, wins=${wins}, losses=${losses}).`;
}

function computeCrossTabExtended(
  band: M5Band,
  bandRows: RawMemRow[],
  getKey: (r: RawMemRow) => string,
): CrossTabCellExtended[] {
  const map = new Map<string, RawMemRow[]>();
  for (const r of bandRows) {
    const k = getKey(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const pnlRows = rows.filter(r => r.priceChangePct != null);
      const pnls    = pnlRows.map(r => r.priceChangePct!);
      const wins    = pnls.filter(p => p > 0).length;
      return {
        m5Band:         band,
        secondaryKey:   key,
        n:              rows.length,
        pnlN:           pnlRows.length,
        wins,
        winRate:        pnlRows.length > 0 ? wins / pnlRows.length : null,
        avgPnlCapped:   avg(pnls.map(cap)),
        medianPnl:      median(pnls),
        bigWinners:     pnls.filter(p => p >= 20).length,
        bigLosers:      pnls.filter(p => p <= -20).length,
        confidenceTier: getConfidenceTier(pnlRows.length),
      };
    });
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runM5UsableSampleDeepDive(
  opts: M5UsableSampleDeepDiveOptions = {},
): M5UsableSampleDeepDiveResult {
  const memoryPath  = opts.memoryPath  ?? DEFAULT_MEMORY_PATH;
  const topN        = opts.topN        ?? DEFAULT_TOP_N;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  const allRows = readJsonl<RawMemRow>(memoryPath);

  let latestObservedAt: string | null = null;
  let latestCapturedAt: string | null = null;
  for (const r of allRows) {
    if (r.observedAt && (!latestObservedAt || r.observedAt > latestObservedAt)) latestObservedAt = r.observedAt;
    if (r.capturedAt && (!latestCapturedAt || r.capturedAt > latestCapturedAt)) latestCapturedAt = r.capturedAt;
  }

  const rowsWithM5  = allRows.filter(r => r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct)).length;
  const rowsWithPnl = allRows.filter(r => r.priceChangePct != null).length;
  const m5RowsWithPnl = allRows.filter(
    r => r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct) && r.priceChangePct != null,
  ).length;

  const m5CoveragePct   = allRows.length > 0 ? (rowsWithM5 / allRows.length) * 100 : 0;
  const evidenceMaturity = getMaturity(rowsWithM5);
  const maturityLabel    = `${evidenceMaturity} (${rowsWithM5} M5 rows, ${m5RowsWithPnl} with PNL)`;

  // Group all rows by M5 band
  const byBand = new Map<M5Band, RawMemRow[]>();
  for (const band of M5_BAND_ORDER) byBand.set(band, []);
  for (const r of allRows) byBand.get(m5ToBand(r.entryMomentumPct))!.push(r);

  // §2 — Band scoreboard
  const bandScoreboard: BandScoreboard[] = M5_BAND_ORDER.map(band => {
    const rows    = byBand.get(band)!;
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
      lowNWarning:    pnlRows.length < 50,
    };
  });

  // Best band by capped avg P/L (non-UNAVAILABLE, non-IGNORE)
  const scorableRows = bandScoreboard.filter(
    b => b.band !== 'UNAVAILABLE' && b.confidenceTier !== 'IGNORE' && b.avgPnlCapped != null,
  );
  const bestBand: M5Band | null = scorableRows.length > 0
    ? scorableRows.reduce((a, b) => (b.avgPnlCapped! > a.avgPnlCapped! ? b : a)).band
    : null;

  // §3 — M5_NEUTRAL deep dive (only rows with M5 data)
  const neutralRows = byBand.get('M5_NEUTRAL')!.filter(
    r => r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct),
  );
  const neutralDeepDive = computeBandDeepDive('M5_NEUTRAL', neutralRows, topN);

  // §4 — M5_STRONG deep dive
  const strongRows = byBand.get('M5_STRONG')!.filter(
    r => r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct),
  );
  const strongDeepDive = computeBandDeepDive('M5_STRONG', strongRows, topN);

  // §5-8 — Extended cross-tabs (M5 rows only, exclude UNAVAILABLE)
  const m5Rows = allRows.filter(r => r.entryMomentumPct != null && Number.isFinite(r.entryMomentumPct));

  const liqCrossTab: CrossTabCellExtended[]     = [];
  const vlrCrossTab: CrossTabCellExtended[]     = [];
  const clusterCrossTab: CrossTabCellExtended[] = [];
  const timingCrossTab: CrossTabCellExtended[]  = [];

  for (const band of M5_BAND_ORDER) {
    if (band === 'UNAVAILABLE') continue;
    const bandM5Rows = m5Rows.filter(r => m5ToBand(r.entryMomentumPct) === band);
    liqCrossTab.push(    ...computeCrossTabExtended(band, bandM5Rows, r => r.liquidityBucket ?? 'UNKNOWN'));
    vlrCrossTab.push(    ...computeCrossTabExtended(band, bandM5Rows, r => r.vlrBucket       ?? 'UNKNOWN'));
    clusterCrossTab.push(...computeCrossTabExtended(band, bandM5Rows, r => r.clusterRisk     ?? 'UNKNOWN'));
    timingCrossTab.push( ...computeCrossTabExtended(band, bandM5Rows, r => r.timingPath      ?? 'UNKNOWN'));
  }

  // §9 — Candidate rules
  const candidateRules: CandidateRule[] = [];

  const neutralScore = bandScoreboard.find(b => b.band === 'M5_NEUTRAL');
  const strongScore  = bandScoreboard.find(b => b.band === 'M5_STRONG');

  if (neutralScore && neutralScore.pnlN >= 20) {
    candidateRules.push({
      description:    `M5_NEUTRAL may be safer than M5_STRONG — win rate ${pct(neutralScore.winRate)} vs ${pct(strongScore?.winRate ?? null)}, avg capped P/L ${fmt1(neutralScore.avgPnlCapped)}% vs ${fmt1(strongScore?.avgPnlCapped ?? null)}%`,
      n:              neutralScore.pnlN,
      confidenceTier: neutralScore.confidenceTier,
      studyOnly:      true,
    });
  }

  if (strongScore && strongScore.pnlN >= 4 && (strongScore.lossRate ?? 0) >= 0.6) {
    candidateRules.push({
      description:    `M5_STRONG may indicate exhaustion/chase — ${(((strongScore.lossRate ?? 0)) * 100).toFixed(0)}% loss rate (n=${strongScore.pnlN}). Positive M5 momentum may mean the move is already over.`,
      n:              strongScore.pnlN,
      confidenceTier: strongScore.confidenceTier,
      studyOnly:      true,
    });
  }

  const liqLt10k = liqCrossTab.filter(c => c.secondaryKey === 'LIQ_LT_10K' && c.pnlN >= 5);
  if (liqLt10k.length > 0) {
    const liqLt10kAvg = avg(liqLt10k.map(c => c.avgPnlCapped ?? 0));
    const liqLt10kN   = liqLt10k.reduce((s, c) => s + c.pnlN, 0);
    candidateRules.push({
      description:    `Thin liquidity (LIQ_LT_10K) remains risky across M5 bands — avg capped P/L ${fmt1(liqLt10kAvg)}% (n=${liqLt10kN})`,
      n:              liqLt10kN,
      confidenceTier: getConfidenceTier(liqLt10kN),
      studyOnly:      true,
    });
  }

  const unknownClusterNeutral = clusterCrossTab.find(c => c.m5Band === 'M5_NEUTRAL' && c.secondaryKey === 'UNKNOWN');
  if (unknownClusterNeutral && unknownClusterNeutral.pnlN >= 20 && neutralScore) {
    const unknownPct = neutralScore.pnlN > 0 ? unknownClusterNeutral.pnlN / neutralScore.pnlN : 0;
    if (unknownPct > 0.4) {
      candidateRules.push({
        description:    `M5_NEUTRAL win rate may be artifact — ${(unknownPct * 100).toFixed(0)}% of M5_NEUTRAL PNL rows have UNKNOWN cluster risk (n=${unknownClusterNeutral.pnlN}). Do not treat UNKNOWN as clean.`,
        n:              unknownClusterNeutral.pnlN,
        confidenceTier: unknownClusterNeutral.confidenceTier,
        studyOnly:      true,
      });
    }
  }

  // §10 — Not proven yet
  const notProvenYet: string[] = [
    'No production gate change proven from this sample.',
    'No real-trading approval proven.',
    'No M5-only buy signal proven — M5 is one factor, not a standalone gate.',
    'No timing-path change proven — ENTER_NOW vs WAIT_10M requires larger per-path samples.',
    'No cluster-risk override proven — UNKNOWN cluster risk cannot be treated as CLEAN.',
    'M5 momentum correlation vs. causality not established.',
    `READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW requires M5+PNL >= 500 (current: ${m5RowsWithPnl}).`,
  ];

  // §11 — Recommendation
  let recommendation: DeepDiveRecommendation;
  let recommendationReason: string;

  if (m5RowsWithPnl < 200) {
    recommendation       = 'KEEP_COLLECTING';
    recommendationReason = `Only ${m5RowsWithPnl} M5+PNL rows. Minimum 200 needed before study phase.`;
  } else if (m5RowsWithPnl >= 500) {
    const strongestBand = bandScoreboard
      .filter(b => b.band !== 'UNAVAILABLE' && b.pnlN >= 500)
      .sort((a, b) => (b.avgPnlCapped ?? -Infinity) - (a.avgPnlCapped ?? -Infinity))[0];
    if (strongestBand) {
      recommendation       = 'READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW';
      recommendationReason = `${strongestBand.band} has pnlN=${strongestBand.pnlN} >= 500 with material performance signal (avg_cap=${fmt1(strongestBand.avgPnlCapped)}%).`;
    } else {
      recommendation       = 'STUDY_M5_NEUTRAL';
      recommendationReason = `${m5RowsWithPnl} M5+PNL rows accumulated but no single band has pnlN >= 500. Continue study.`;
    }
  } else {
    // 200 <= m5RowsWithPnl < 500 — check per-band strength
    const neutralPnlN = neutralScore?.pnlN ?? 0;
    const bestBandPnlN = bestBand
      ? (bandScoreboard.find(b => b.band === bestBand)?.pnlN ?? 0)
      : 0;

    if (bestBandPnlN < 200) {
      // "If strongest candidate has n < 200, keep recommendation conservative"
      recommendation       = 'KEEP_COLLECTING';
      recommendationReason = `Strongest candidate band (${bestBand ?? 'none'}) has only pnlN=${bestBandPnlN} < 200. Need more per-band samples before study conclusions.`;
    } else if (strongScore && strongScore.pnlN >= 20 && (strongScore.lossRate ?? 0) >= 0.65) {
      recommendation       = 'STUDY_M5_STRONG_EXHAUSTION';
      recommendationReason = `M5_STRONG shows high loss rate ${pct(strongScore.lossRate)} (n=${strongScore.pnlN}) with pnlN >= 20, suggesting possible exhaustion. Study only — no gate change.`;
    } else if (neutralPnlN >= 200) {
      recommendation       = 'STUDY_M5_NEUTRAL';
      recommendationReason = `M5_NEUTRAL has pnlN=${neutralPnlN} >= 200. Directional positive lean warrants deeper study. Not a gate proposal.`;
    } else {
      recommendation       = 'KEEP_COLLECTING';
      recommendationReason = `No single band has pnlN >= 200 yet. Best band has ${bestBandPnlN} rows. Keep accumulating.`;
    }
  }

  return {
    generatedAt,
    totalRows:        allRows.length,
    rowsWithM5,
    rowsWithPnl,
    m5RowsWithPnl,
    m5CoveragePct,
    latestObservedAt,
    latestCapturedAt,
    evidenceMaturity,
    maturityLabel,
    bandScoreboard,
    bestBand,
    neutralDeepDive,
    strongDeepDive,
    liqCrossTab,
    vlrCrossTab,
    clusterCrossTab,
    timingCrossTab,
    candidateRules,
    notProvenYet,
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

// ── Format helpers ────────────────────────────────────────────────────────────

function fmt1(v: number | null | undefined): string {
  if (v == null) return '  n/a';
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}

function pct(v: number | null | undefined): string {
  if (v == null) return '  n/a';
  return (v * 100).toFixed(1) + '%';
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderM5UsableSampleDeepDive(result: M5UsableSampleDeepDiveResult): string {
  const L: string[] = [];

  L.push(SEP);
  L.push('  TOKEN GRAB — M5 USABLE SAMPLE DEEP DIVE v1');
  L.push('  [REPORT ONLY — READ ONLY — NO MUTATION — NO GATE CHANGES — NO POLICY CHANGE]');
  L.push(SEP, '');

  // §1 — Overview
  L.push(`  ${SEP2}`);
  L.push('  SECTION 1 — OVERVIEW');
  L.push(`  ${SEP2}`, '');
  L.push(`  Generated at            : ${result.generatedAt}`);
  L.push(`  Total memory rows       : ${result.totalRows}`);
  L.push(`  Rows with M5            : ${result.rowsWithM5}`);
  L.push(`  Rows with PNL (all)     : ${result.rowsWithPnl}`);
  L.push(`  M5+PNL rows             : ${result.m5RowsWithPnl}`);
  L.push(`  M5 coverage             : ${result.m5CoveragePct.toFixed(1)}%`);
  L.push(`  Latest observedAt       : ${result.latestObservedAt ?? '(none)'}`);
  L.push(`  Latest capturedAt       : ${result.latestCapturedAt ?? '(none)'}`);
  L.push(`  Evidence maturity       : ${result.maturityLabel}`);
  L.push(`  Recommendation          : ${result.recommendation}`);
  L.push('');

  // §2 — M5 Band Scoreboard
  L.push(`  ${SEP2}`);
  L.push('  SECTION 2 — M5 BAND SCOREBOARD');
  L.push(`  ${SEP2}`, '');
  L.push(`  ${'band'.padEnd(20)} ${'n'.padStart(5)} ${'pnl_n'.padStart(6)} ${'win%'.padStart(6)} ${'loss%'.padStart(6)} ${'avg_raw'.padStart(9)} ${'avg_cap'.padStart(9)} ${'median'.padStart(8)} ${'bw'.padStart(4)} ${'bl'.padStart(4)}  tier`);
  L.push(`  ${'─'.repeat(20)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(8)} ${'─'.repeat(4)} ${'─'.repeat(4)}  ${'─'.repeat(18)}`);
  for (const s of result.bandScoreboard) {
    const warn = s.lowNWarning && s.pnlN > 0 ? ' ⚠low-n' : '';
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
      `${s.confidenceTier}${warn}`,
    );
  }
  L.push(`  (bw=big winners pcp>=20%, bl=big losers pcp<=-20%, avg_cap=capped at ±${PNL_CAP}%)`);
  L.push(`  Best band (by avg_cap)  : ${result.bestBand ?? '(none — insufficient data)'}`);
  L.push('');

  // §3 — M5_NEUTRAL Deep Dive
  L.push(`  ${SEP2}`);
  L.push('  SECTION 3 — M5_NEUTRAL DEEP DIVE');
  L.push('  (Current dashboard indicates M5_NEUTRAL may be best band)');
  L.push(`  ${SEP2}`, '');
  renderBandDeepDive(L, result.neutralDeepDive, true);

  // §4 — M5_STRONG Deep Dive
  L.push(`  ${SEP2}`);
  L.push('  SECTION 4 — M5_STRONG DEEP DIVE');
  L.push('  (Current dashboard indicates M5_STRONG may be worst band — checking for exhaustion/chase)');
  L.push(`  ${SEP2}`, '');
  renderBandDeepDive(L, result.strongDeepDive, false);

  // §5 — Liquidity Interaction
  L.push(`  ${SEP2}`);
  L.push('  SECTION 5 — LIQUIDITY INTERACTION (M5 band × liquidityBucket)');
  L.push(`  ${SEP2}`, '');
  renderCrossTabExtended(L, result.liqCrossTab);
  L.push('  Note: LIQ_LT_10K = thin liquidity risk; LIQ_GTE_100K = large pool; LIQ_UNKNOWN = artifact risk.');
  L.push('');

  // §6 — VLR Interaction
  L.push(`  ${SEP2}`);
  L.push('  SECTION 6 — VLR INTERACTION (M5 band × vlrBucket)');
  L.push(`  ${SEP2}`, '');
  renderCrossTabExtended(L, result.vlrCrossTab);
  L.push('  Note: VLR_GTE_2 = high volume/liquidity ratio; VLR_UNKNOWN = artifact risk.');
  L.push('');

  // §7 — Cluster Interaction
  L.push(`  ${SEP2}`);
  L.push('  SECTION 7 — CLUSTER INTERACTION (M5 band × clusterRisk)');
  L.push(`  ${SEP2}`, '');
  renderCrossTabExtended(L, result.clusterCrossTab);
  L.push('  Note: UNKNOWN cluster risk must NOT be treated as CLEAN. Verify CLEAN subset independently.');
  L.push('');

  // §8 — Timing Interaction
  L.push(`  ${SEP2}`);
  L.push('  SECTION 8 — TIMING INTERACTION (M5 band × timingPath)');
  L.push(`  ${SEP2}`, '');
  renderCrossTabExtended(L, result.timingCrossTab);
  L.push('  Note: Do not recommend timing changes unless per-path samples are robust (pnlN >= 50 per cell).');
  L.push('');

  // §9 — Candidate Rules
  L.push(`  ${SEP2}`);
  L.push('  SECTION 9 — CANDIDATE RULES (STUDY ONLY — not gates)');
  L.push(`  ${SEP2}`, '');
  if (result.candidateRules.length === 0) {
    L.push('  (no candidate rules — sample too small or no directional signal)');
  } else {
    for (const rule of result.candidateRules) {
      L.push(`  Candidate: ${rule.description}`);
      L.push(`    n=${rule.n}  confidence=${rule.confidenceTier}  STUDY_ONLY — not a gate`);
      L.push('');
    }
  }
  L.push('');

  // §10 — Not Proven Yet
  L.push(`  ${SEP2}`);
  L.push('  SECTION 10 — NOT PROVEN YET');
  L.push(`  ${SEP2}`, '');
  for (const item of result.notProvenYet) {
    L.push(`  ✗ ${item}`);
  }
  L.push('');

  // §11 — Recommendation
  L.push(`  ${SEP2}`);
  L.push('  SECTION 11 — RECOMMENDATION');
  L.push(`  ${SEP2}`, '');
  const recIcon = result.recommendation === 'READY_FOR_SEPARATE_GATE_PROPOSAL_REVIEW' ? '✓' : '⚠';
  L.push(`  ${recIcon} ${result.recommendation}`);
  L.push(`    ${result.recommendationReason}`);
  L.push('');
  L.push('  DO NOT change gates or policy based on this report alone.');
  L.push('  DO NOT enable real trading.');
  L.push('');

  // §12 — Safety Footer
  L.push(`  ${SEP2}`);
  L.push('  SECTION 12 — SAFETY');
  L.push(`  ${SEP2}`, '');
  L.push('  REPORT_ONLY=true    READ_ONLY=true    PAPER_ONLY=true    NO_MUTATION=true');
  L.push('  NO_REAL_TRADING=true   NO_GATE_CHANGES=true   NO_POLICY_CHANGE=true');
  L.push('  NO_WALLET=true         NO_SWAP=true           NO_SIGNING=true');
  L.push('  DO_NOT_ENABLE_REAL_TRADING    tradingExecuted=0    realTradingLocked=true');
  L.push('  No data files mutated.  No gates changed.  No policy changed.');
  L.push(SEP, '');

  return L.join('\n');
}

function renderBandDeepDive(L: string[], dive: BandDeepDive, includeWinners: boolean): void {
  const winPct  = dive.winRate != null ? (dive.winRate * 100).toFixed(1) + '%' : 'n/a';
  L.push(`  Band                    : ${dive.band}`);
  L.push(`  Total n                 : ${dive.totalN}`);
  L.push(`  PNL n                   : ${dive.pnlN}`);
  L.push(`  Winners                 : ${dive.wins}  (${winPct})`);
  L.push(`  Losers                  : ${dive.losses}`);
  L.push(`  Avg capped P/L          : ${fmt1(dive.avgPnlCapped)}%`);
  L.push(`  Median P/L              : ${fmt1(dive.medianPnl)}%`);
  L.push(`  Big winners (>=20%)     : ${dive.bigWinners}`);
  L.push(`  Big losers (<=-20%)     : ${dive.bigLosers}`);
  L.push('');

  renderSubgroupTable(L, 'By liquidityBucket', dive.byLiquidity);
  renderSubgroupTable(L, 'By vlrBucket',       dive.byVlr);
  renderSubgroupTable(L, 'By clusterRisk',     dive.byCluster);
  renderSubgroupTable(L, 'By timingPath',      dive.byTiming);

  if (includeWinners) {
    L.push(`  Top ${dive.topWinners.length} winners:`);
    renderTradeTable(L, dive.topWinners, '(none)');
  }
  L.push(`  Top ${dive.topLosers.length} losers:`);
  renderTradeTable(L, dive.topLosers, '(none)');

  L.push(`  Conclusion: ${dive.conclusion}`);
  L.push('');
}

function renderSubgroupTable(L: string[], label: string, subgroups: SubgroupStats[]): void {
  if (subgroups.length === 0) {
    L.push(`  ${label}: (no data)`);
    L.push('');
    return;
  }
  L.push(`  ${label}:`);
  L.push(`    ${'key'.padEnd(18)} ${'n'.padStart(5)} ${'pnl_n'.padStart(6)} ${'win%'.padStart(6)} ${'loss%'.padStart(6)} ${'avg_cap'.padStart(9)} ${'median'.padStart(8)} ${'bw'.padStart(4)} ${'bl'.padStart(4)}  tier`);
  L.push(`    ${'─'.repeat(18)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(8)} ${'─'.repeat(4)} ${'─'.repeat(4)}  ${'─'.repeat(18)}`);
  for (const s of subgroups) {
    L.push(
      `    ${s.key.padEnd(18)} ` +
      `${String(s.n).padStart(5)} ` +
      `${String(s.pnlN).padStart(6)} ` +
      `${pct(s.winRate).padStart(6)} ` +
      `${pct(s.lossRate).padStart(6)} ` +
      `${(fmt1(s.avgPnlCapped) + '%').padStart(9)} ` +
      `${(fmt1(s.medianPnl) + '%').padStart(8)} ` +
      `${String(s.bigWinners).padStart(4)} ` +
      `${String(s.bigLosers).padStart(4)}  ` +
      `${s.confidenceTier}`,
    );
  }
  L.push('');
}

function renderTradeTable(L: string[], trades: TradeRecord[], emptyMsg: string): void {
  if (trades.length === 0) {
    L.push(`    ${emptyMsg}`);
    L.push('');
    return;
  }
  L.push(`    ${'contract (prefix)'.padEnd(22)} ${'pnl'.padStart(8)} ${'m5'.padStart(8)} ${'liq'.padEnd(16)} ${'vlr'.padEnd(16)} ${'cluster'.padEnd(10)} timing`);
  L.push(`    ${'─'.repeat(22)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(16)} ${'─'.repeat(16)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
  for (const t of trades) {
    L.push(
      `    ${t.contract.slice(0, 20).padEnd(22)} ` +
      `${(fmt1(t.pnl) + '%').padStart(8)} ` +
      `${(fmt1(t.m5) + '%').padStart(8)} ` +
      `${t.liquidityBucket.padEnd(16)} ` +
      `${t.vlrBucket.padEnd(16)} ` +
      `${t.clusterRisk.padEnd(10)} ` +
      `${t.timingPath}`,
    );
  }
  L.push('');
}

function renderCrossTabExtended(L: string[], cells: CrossTabCellExtended[]): void {
  if (cells.length === 0) {
    L.push('  (no data)');
    L.push('');
    return;
  }
  L.push(`  ${'m5_band'.padEnd(20)} ${'secondary'.padEnd(18)} ${'n'.padStart(5)} ${'pnl_n'.padStart(6)} ${'win%'.padStart(6)} ${'avg_cap'.padStart(9)} ${'median'.padStart(8)} ${'bw'.padStart(4)} ${'bl'.padStart(4)}  tier`);
  L.push(`  ${'─'.repeat(20)} ${'─'.repeat(18)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(8)} ${'─'.repeat(4)} ${'─'.repeat(4)}  ${'─'.repeat(18)}`);
  for (const c of cells) {
    L.push(
      `  ${c.m5Band.padEnd(20)} ` +
      `${c.secondaryKey.padEnd(18)} ` +
      `${String(c.n).padStart(5)} ` +
      `${String(c.pnlN).padStart(6)} ` +
      `${pct(c.winRate).padStart(6)} ` +
      `${(fmt1(c.avgPnlCapped) + '%').padStart(9)} ` +
      `${(fmt1(c.medianPnl) + '%').padStart(8)} ` +
      `${String(c.bigWinners).padStart(4)} ` +
      `${String(c.bigLosers).padStart(4)}  ` +
      `${c.confidenceTier}`,
    );
  }
  L.push('');
}
