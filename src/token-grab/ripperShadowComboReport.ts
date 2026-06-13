import * as fs from 'fs';
import { readFixturesFromJsonl } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComboCandidateClassification = 'WINNER' | 'LOSER' | 'PENDING_PRICE';

export interface ComboCandidate {
  contractKey:            string;
  contractKeyShort:       string;
  symbol?:                string;
  sourceFile:             string;
  approvedAt:             string;
  approvalInstanceKey:    string;
  repeatedContract:       boolean;
  approvalPriceChangePct: number | null;
  liquidityUsd:           number | null;
  volumeUsd:              number | null;
  outcomePctChange:       number | null;
  classification:         ComboCandidateClassification;
}

export interface ComboPolicyDef {
  id:          string;
  description: string;
  evaluate:    (c: ComboCandidate) => boolean;
}

export interface ComboPolicyStats {
  policyId:       string;
  description:    string;
  passCount:      number;
  pricedCount:    number;
  pendingCount:   number;
  winners:        number;
  losers:         number;
  winRate:        number | null;
  avgPct:         number | null;
  medianPct:      number | null;
  totalSimPct:    number | null;
  avgWinnerPct:   number | null;
  avgLoserPct:    number | null;
  bestCandidate:  ComboCandidate | null;
  worstCandidate: ComboCandidate | null;
  candidates:     ComboCandidate[];
}

export interface ComboLeader {
  policyId:    string;
  description: string;
  avgPct:      number;
  medianPct:   number;
  worstLoss:   number | null;
  pricedCount: number;
  winRate:     number | null;
}

export interface FullComboWatchlistSummary {
  totalCount:         number;
  pricedCount:        number;
  pendingCount:       number;
  winners:            number;
  losers:             number;
  winRate:            number | null;
  avgPct:             number | null;
  medianPct:          number | null;
  worstLoss:          number | null;
  oldestPendingAgeMs: number | null;
  newestPendingAgeMs: number | null;
}

export interface FullComboWatchlist {
  policyId:    string;
  description: string;
  candidates:  ComboCandidate[];
  summary:     FullComboWatchlistSummary;
}

export interface UniqueContractEntry {
  contractKey:                string;
  contractKeyShort:           string;
  symbol?:                    string;
  firstApprovedAt:            string;
  latestApprovedAt:           string;
  instanceCount:              number;
  repeated:                   boolean;
  bestApprovalPriceChangePct: number | null;
  bestLiquidityUsd:           number | null;
  bestVolumeUsd:              number | null;
  outcomePctChange:           number | null;
  classification:             ComboCandidateClassification;
  anyInstancePassedFullCombo: boolean;
}

export interface FullComboUniqueContractSummary {
  uniqueContractCount:       number;
  totalInstancesRepresented: number;
  repeatedContractCount:     number;
  pricedUniqueContracts:     number;
  pendingUniqueContracts:    number;
  winnerUniqueContracts:     number;
  loserUniqueContracts:      number;
  uniqueContractWinRate:     number | null;
  avgPct:                    number | null;
  medianPct:                 number | null;
  worstLoss:                 number | null;
  bestWinner:                UniqueContractEntry | null;
  worstLoser:                UniqueContractEntry | null;
}

export interface ComboInstanceVsUniqueComparison {
  instanceCandidates: number;
  instancePriced:     number;
  instancePending:    number;
  instanceWinners:    number;
  instanceLosers:     number;
  instanceWinRate:    number | null;
  instanceAvgPct:     number | null;
  instanceMedianPct:  number | null;
  instanceWorstLoss:  number | null;
  uniqueContracts:    number;
  uniquePriced:       number;
  uniquePending:      number;
  uniqueWinners:      number;
  uniqueLosers:       number;
  uniqueWinRate:      number | null;
  uniqueAvgPct:       number | null;
  uniqueMedianPct:    number | null;
  uniqueWorstLoss:    number | null;
}

export interface FullComboUniqueContractView {
  entries:    UniqueContractEntry[];
  summary:    FullComboUniqueContractSummary;
  comparison: ComboInstanceVsUniqueComparison;
}

export interface RipperShadowComboReportOptions {
  approvalPaths: string[];
  outcomePaths:  string[];
  nowMs?:        number;
}

export interface RipperShadowComboReportResult {
  generatedAt:             string;
  approvalFilesRead:       number;
  approvalFilesMissing:    number;
  outcomeFilesRead:        number;
  outcomeFilesMissing:     number;
  approvalInstancesLoaded: number;
  exactDuplicatesSkipped:  number;
  uniqueContracts:         number;
  repeatedContractsCount:  number;
  totalCandidates:         number;
  allStats:                ComboPolicyStats;
  policyStats:             ComboPolicyStats[];
  currentLeader:               ComboLeader | null;
  fullComboWatchlist:          FullComboWatchlist;
  fullComboUniqueContractView: FullComboUniqueContractView;
  realTradingLocked:           true;
  tradingExecuted:         0;
  noRealTradeSent:         true;
  paperOnly:               true;
  readOnly:                true;
}

// ── Policy definitions ────────────────────────────────────────────────────────

export const FULL_COMBO_POLICY_ID = 'price_gt_0_25_and_liq_30k_and_vol_20k';

export const COMBO_POLICIES: ComboPolicyDef[] = [
  {
    id:          'price_gt_0_25',
    description: 'approvalPriceChangePct > 0.25',
    evaluate:    c => c.approvalPriceChangePct != null && c.approvalPriceChangePct > 0.25,
  },
  {
    id:          'price_gt_0_25_and_liq_30k',
    description: 'approvalPriceChangePct > 0.25 AND liquidityUsd >= 30000',
    evaluate:    c =>
      c.approvalPriceChangePct != null && c.approvalPriceChangePct > 0.25 &&
      c.liquidityUsd           != null && c.liquidityUsd >= 30_000,
  },
  {
    id:          'price_gt_0_25_and_vol_20k',
    description: 'approvalPriceChangePct > 0.25 AND volumeUsd >= 20000',
    evaluate:    c =>
      c.approvalPriceChangePct != null && c.approvalPriceChangePct > 0.25 &&
      c.volumeUsd              != null && c.volumeUsd >= 20_000,
  },
  {
    id:          'price_gt_0_25_and_liq_30k_and_vol_20k',
    description: 'approvalPriceChangePct > 0.25 AND liquidityUsd >= 30000 AND volumeUsd >= 20000',
    evaluate:    c =>
      c.approvalPriceChangePct != null && c.approvalPriceChangePct > 0.25 &&
      c.liquidityUsd           != null && c.liquidityUsd >= 30_000 &&
      c.volumeUsd              != null && c.volumeUsd >= 20_000,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function toFiniteNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function shortKey(k: string): string {
  return k.length > 14 ? `${k.slice(0, 14)}…` : k;
}

function safeRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function safeStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function classify(pct: number | null): ComboCandidateClassification {
  if (pct == null) return 'PENDING_PRICE';
  return pct > 0 ? 'WINNER' : 'LOSER';
}

function buildPolicyStats(
  policyId:    string,
  description: string,
  candidates:  ComboCandidate[],
): ComboPolicyStats {
  const priced  = candidates.filter(c => c.outcomePctChange != null);
  const pending = candidates.filter(c => c.outcomePctChange == null);
  const winners = priced.filter(c => c.classification === 'WINNER');
  const losers  = priced.filter(c => c.classification === 'LOSER');
  const outcomes   = priced.map(c => c.outcomePctChange as number);
  const winnerOuts = winners.map(c => c.outcomePctChange as number);
  const loserOuts  = losers.map(c => c.outcomePctChange as number);
  const totalSimPct = outcomes.length > 0 ? outcomes.reduce((s, n) => s + n, 0) : null;

  const sorted = [...priced].sort((a, b) =>
    (b.outcomePctChange as number) - (a.outcomePctChange as number),
  );

  return {
    policyId,
    description,
    passCount:      candidates.length,
    pricedCount:    priced.length,
    pendingCount:   pending.length,
    winners:        winners.length,
    losers:         losers.length,
    winRate:        priced.length > 0 ? (winners.length / priced.length) * 100 : null,
    avgPct:         avgOf(outcomes),
    medianPct:      medianOf(outcomes),
    totalSimPct,
    avgWinnerPct:   avgOf(winnerOuts),
    avgLoserPct:    avgOf(loserOuts),
    bestCandidate:  sorted[0]                 ?? null,
    worstCandidate: sorted[sorted.length - 1] ?? null,
    candidates,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperShadowComboReport(
  options: RipperShadowComboReportOptions,
): RipperShadowComboReportResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Step 1: Read approval fixtures (dedup only exact duplicates) ──────────
  let approvalFilesRead    = 0;
  let approvalFilesMissing = 0;
  let approvalsRead        = 0;
  let exactDuplicatesSkipped = 0;

  interface InstanceEntry {
    fixture:     ReturnType<typeof readFixturesFromJsonl>[number];
    sourceFile:  string;
    instanceKey: string;
    contractKey: string;
  }
  const instanceKeySet = new Set<string>();
  const instances: InstanceEntry[] = [];

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) { approvalFilesMissing++; continue; }
    approvalFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      approvalsRead++;
      const contractKey = signalKey(f.normalizedSignal);
      const instanceKey = `${contractKey}::${f.capturedAt}`;
      if (instanceKeySet.has(instanceKey)) {
        exactDuplicatesSkipped++;
      } else {
        instanceKeySet.add(instanceKey);
        instances.push({ fixture: f, sourceFile: p, instanceKey, contractKey });
      }
    }
  }

  const contractKeyCounts = new Map<string, number>();
  for (const inst of instances) {
    contractKeyCounts.set(inst.contractKey, (contractKeyCounts.get(inst.contractKey) ?? 0) + 1);
  }
  const uniqueContracts        = contractKeyCounts.size;
  const repeatedContractsCount = [...contractKeyCounts.values()].filter(n => n > 1).length;

  // ── Step 2: Read outcome data (latest checkpointAt per contractKey) ────────
  let outcomeFilesRead    = 0;
  let outcomeFilesMissing = 0;

  interface OutcomeEntry { pctChangeFromEntry: number | null; checkpointAt: string }
  const outcomeMap = new Map<string, OutcomeEntry>();

  for (const p of options.outcomePaths) {
    if (!fs.existsSync(p)) { outcomeFilesMissing++; continue; }
    outcomeFilesRead++;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { continue; }
    const rec = safeRecord(parsed);
    const fileCheckpointAt = safeStr(rec['checkpointAt']) ?? safeStr(rec['generatedAt']) ?? '';
    const cands = Array.isArray(rec['candidates']) ? rec['candidates'] as unknown[] : [];
    for (const c of cands) {
      const cr  = safeRecord(c);
      const key = safeStr(cr['contractKey']);
      if (!key) continue;
      const ckAt = safeStr(cr['checkpointAt']) ?? fileCheckpointAt;
      const ex   = outcomeMap.get(key);
      if (!ex || ckAt >= ex.checkpointAt) {
        outcomeMap.set(key, { pctChangeFromEntry: toFiniteNum(cr['pctChangeFromEntry']), checkpointAt: ckAt });
      }
    }
  }

  // ── Step 3: Build per-candidate records ────────────────────────────────────
  const allCandidates: ComboCandidate[] = [];

  for (const { fixture: f, sourceFile, instanceKey, contractKey: key } of instances) {
    const sig              = f.normalizedSignal as Record<string, unknown>;
    const out              = outcomeMap.get(key);
    const outcomePctChange = out?.pctChangeFromEntry ?? null;

    allCandidates.push({
      contractKey:            key,
      contractKeyShort:       shortKey(key),
      symbol:                 f.normalizedSignal.symbol,
      sourceFile,
      approvedAt:             f.capturedAt,
      approvalInstanceKey:    instanceKey,
      repeatedContract:       (contractKeyCounts.get(key) ?? 1) > 1,
      approvalPriceChangePct: toFiniteNum(sig['priceChangePct']),
      liquidityUsd:           toFiniteNum(sig['liquidityUsd']),
      volumeUsd:              toFiniteNum(sig['volumeUsd']),
      outcomePctChange,
      classification:         classify(outcomePctChange),
    });
  }

  // Sort: priced desc, then pending
  allCandidates.sort((a, b) => {
    if (a.outcomePctChange != null && b.outcomePctChange != null) return b.outcomePctChange - a.outcomePctChange;
    if (a.outcomePctChange != null) return -1;
    if (b.outcomePctChange != null) return  1;
    return 0;
  });

  // ── Step 4: Build policy stats ─────────────────────────────────────────────
  const allStats = buildPolicyStats('ALL', 'All approved candidates (baseline)', allCandidates);

  const policyStats = COMBO_POLICIES.map(p =>
    buildPolicyStats(p.id, p.description, allCandidates.filter(c => p.evaluate(c))),
  );

  // ── Step 5: Select current leader ──────────────────────────────────────────
  const allAvgPct    = allStats.avgPct;
  const allMedianPct = allStats.medianPct;
  const allWorstLoss = allStats.worstCandidate?.outcomePctChange ?? null;

  let currentLeader: ComboLeader | null = null;

  for (const ps of policyStats) {
    if (ps.pricedCount < 3)                                              continue;
    if (ps.avgPct    == null || allAvgPct    == null)                    continue;
    if (ps.avgPct    <= allAvgPct)                                       continue;
    if (ps.medianPct == null || allMedianPct == null)                    continue;
    if (ps.medianPct <= allMedianPct)                                    continue;
    const policyWorstLoss = ps.worstCandidate?.outcomePctChange ?? null;
    if (allWorstLoss != null && policyWorstLoss != null && policyWorstLoss < allWorstLoss) continue;

    if (
      currentLeader == null ||
      ps.avgPct > currentLeader.avgPct ||
      (ps.avgPct === currentLeader.avgPct && (ps.winRate ?? 0) > (currentLeader.winRate ?? 0))
    ) {
      currentLeader = {
        policyId:    ps.policyId,
        description: ps.description,
        avgPct:      ps.avgPct,
        medianPct:   ps.medianPct,
        worstLoss:   policyWorstLoss,
        pricedCount: ps.pricedCount,
        winRate:     ps.winRate,
      };
    }
  }

  // ── Step 6: Build full combo watchlist ────────────────────────────────────
  const fullComboPolicyDef = COMBO_POLICIES.find(p => p.id === FULL_COMBO_POLICY_ID)!;
  const fullComboCands     = allCandidates.filter(c => fullComboPolicyDef.evaluate(c));

  // Sort: PENDING_PRICE first (newest approvedAt first), then priced (newest approvedAt first)
  fullComboCands.sort((a, b) => {
    const aPending = a.classification === 'PENDING_PRICE';
    const bPending = b.classification === 'PENDING_PRICE';
    if (aPending !== bPending) return aPending ? -1 : 1;
    return b.approvedAt.localeCompare(a.approvedAt);
  });

  const fcPriced   = fullComboCands.filter(c => c.outcomePctChange != null);
  const fcPending  = fullComboCands.filter(c => c.outcomePctChange == null);
  const fcWinners  = fcPriced.filter(c => c.classification === 'WINNER');
  const fcLosers   = fcPriced.filter(c => c.classification === 'LOSER');
  const fcOutcomes = fcPriced.map(c => c.outcomePctChange as number);
  const fcWorstLoss = fcOutcomes.length > 0 ? Math.min(...fcOutcomes) : null;

  const pendingAges = fcPending
    .map(c => { const ms = nowMs - Date.parse(c.approvedAt); return Number.isFinite(ms) ? ms : null; })
    .filter((v): v is number => v != null);

  const fullComboWatchlist: FullComboWatchlist = {
    policyId:    FULL_COMBO_POLICY_ID,
    description: fullComboPolicyDef.description,
    candidates:  fullComboCands,
    summary: {
      totalCount:         fullComboCands.length,
      pricedCount:        fcPriced.length,
      pendingCount:       fcPending.length,
      winners:            fcWinners.length,
      losers:             fcLosers.length,
      winRate:            fcPriced.length > 0 ? (fcWinners.length / fcPriced.length) * 100 : null,
      avgPct:             avgOf(fcOutcomes),
      medianPct:          medianOf(fcOutcomes),
      worstLoss:          fcWorstLoss,
      oldestPendingAgeMs: pendingAges.length > 0 ? Math.max(...pendingAges) : null,
      newestPendingAgeMs: pendingAges.length > 0 ? Math.min(...pendingAges) : null,
    },
  };

  // ── Step 7: Build full combo unique-contract view ─────────────────────────
  const ucMap = new Map<string, UniqueContractEntry>();
  for (const c of fullComboCands) {
    const ex = ucMap.get(c.contractKey);
    if (!ex) {
      ucMap.set(c.contractKey, {
        contractKey:                c.contractKey,
        contractKeyShort:           c.contractKeyShort,
        symbol:                     c.symbol,
        firstApprovedAt:            c.approvedAt,
        latestApprovedAt:           c.approvedAt,
        instanceCount:              1,
        repeated:                   false,
        bestApprovalPriceChangePct: c.approvalPriceChangePct,
        bestLiquidityUsd:           c.liquidityUsd,
        bestVolumeUsd:              c.volumeUsd,
        outcomePctChange:           c.outcomePctChange,
        classification:             c.classification,
        anyInstancePassedFullCombo: true,
      });
    } else {
      ex.instanceCount++;
      if (c.approvedAt < ex.firstApprovedAt)  ex.firstApprovedAt  = c.approvedAt;
      if (c.approvedAt > ex.latestApprovedAt) ex.latestApprovedAt = c.approvedAt;
      if (c.approvalPriceChangePct != null &&
          (ex.bestApprovalPriceChangePct == null || c.approvalPriceChangePct > ex.bestApprovalPriceChangePct)) {
        ex.bestApprovalPriceChangePct = c.approvalPriceChangePct;
      }
      if (c.liquidityUsd != null &&
          (ex.bestLiquidityUsd == null || c.liquidityUsd > ex.bestLiquidityUsd)) {
        ex.bestLiquidityUsd = c.liquidityUsd;
      }
      if (c.volumeUsd != null &&
          (ex.bestVolumeUsd == null || c.volumeUsd > ex.bestVolumeUsd)) {
        ex.bestVolumeUsd = c.volumeUsd;
      }
      if (!ex.symbol && c.symbol) ex.symbol = c.symbol;
    }
  }
  for (const e of ucMap.values()) {
    e.repeated = e.instanceCount > 1;
  }

  const ucEntries = [...ucMap.values()];
  ucEntries.sort((a, b) => {
    const aPending = a.classification === 'PENDING_PRICE';
    const bPending = b.classification === 'PENDING_PRICE';
    if (aPending !== bPending) return aPending ? -1 : 1;
    return b.latestApprovedAt.localeCompare(a.latestApprovedAt);
  });

  const ucPriced   = ucEntries.filter(e => e.outcomePctChange != null);
  const ucPending  = ucEntries.filter(e => e.outcomePctChange == null);
  const ucWinners  = ucPriced.filter(e => e.classification === 'WINNER');
  const ucLosers   = ucPriced.filter(e => e.classification === 'LOSER');
  const ucOutcomes = ucPriced.map(e => e.outcomePctChange as number);

  const ucWinnersSorted = [...ucWinners].sort(
    (a, b) => (b.outcomePctChange as number) - (a.outcomePctChange as number),
  );
  const ucLosersSorted  = [...ucLosers].sort(
    (a, b) => (a.outcomePctChange as number) - (b.outcomePctChange as number),
  );

  const fullComboUniqueContractView: FullComboUniqueContractView = {
    entries: ucEntries,
    summary: {
      uniqueContractCount:       ucEntries.length,
      totalInstancesRepresented: ucEntries.reduce((s, e) => s + e.instanceCount, 0),
      repeatedContractCount:     ucEntries.filter(e => e.repeated).length,
      pricedUniqueContracts:     ucPriced.length,
      pendingUniqueContracts:    ucPending.length,
      winnerUniqueContracts:     ucWinners.length,
      loserUniqueContracts:      ucLosers.length,
      uniqueContractWinRate:     ucPriced.length > 0 ? (ucWinners.length / ucPriced.length) * 100 : null,
      avgPct:                    avgOf(ucOutcomes),
      medianPct:                 medianOf(ucOutcomes),
      worstLoss:                 ucOutcomes.length > 0 ? Math.min(...ucOutcomes) : null,
      bestWinner:                ucWinnersSorted[0]                 ?? null,
      worstLoser:                ucLosersSorted[0]                  ?? null,
    },
    comparison: {
      instanceCandidates: fullComboWatchlist.summary.totalCount,
      instancePriced:     fullComboWatchlist.summary.pricedCount,
      instancePending:    fullComboWatchlist.summary.pendingCount,
      instanceWinners:    fullComboWatchlist.summary.winners,
      instanceLosers:     fullComboWatchlist.summary.losers,
      instanceWinRate:    fullComboWatchlist.summary.winRate,
      instanceAvgPct:     fullComboWatchlist.summary.avgPct,
      instanceMedianPct:  fullComboWatchlist.summary.medianPct,
      instanceWorstLoss:  fullComboWatchlist.summary.worstLoss,
      uniqueContracts:    ucEntries.length,
      uniquePriced:       ucPriced.length,
      uniquePending:      ucPending.length,
      uniqueWinners:      ucWinners.length,
      uniqueLosers:       ucLosers.length,
      uniqueWinRate:      ucPriced.length > 0 ? (ucWinners.length / ucPriced.length) * 100 : null,
      uniqueAvgPct:       avgOf(ucOutcomes),
      uniqueMedianPct:    medianOf(ucOutcomes),
      uniqueWorstLoss:    ucOutcomes.length > 0 ? Math.min(...ucOutcomes) : null,
    },
  };

  return {
    generatedAt,
    approvalFilesRead,
    approvalFilesMissing,
    outcomeFilesRead,
    outcomeFilesMissing,
    approvalInstancesLoaded: approvalsRead,
    exactDuplicatesSkipped,
    uniqueContracts,
    repeatedContractsCount,
    totalCandidates:  allCandidates.length,
    allStats,
    policyStats,
    currentLeader,
    fullComboWatchlist,
    fullComboUniqueContractView,
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtRate(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  return `${n.toFixed(0)}%`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtClass(c: ComboCandidateClassification): string {
  if (c === 'WINNER') return 'WINNER ';
  if (c === 'LOSER')  return 'LOSER  ';
  return 'PENDING';
}

function fmtAge(ms: number): string {
  if (ms < 0) return '0m';
  const totalMin = Math.floor(ms / 60_000);
  const days  = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins  = totalMin % 60;
  if (days > 0)  return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function renderFullComboWatchlist(
  wl:          FullComboWatchlist,
  generatedAt: string,
): string[] {
  const lines: string[] = [];
  const nowMs = Date.parse(generatedAt);
  const s     = wl.summary;

  lines.push(`  Watchlist policy : ${wl.policyId}`);
  lines.push(`  Description      : ${wl.description}`);
  lines.push('');
  lines.push(`  Total: ${s.totalCount}   Priced: ${s.pricedCount}   Pending: ${s.pendingCount}`);
  lines.push(`  Winners: ${s.winners}   Losers: ${s.losers}   Win rate: ${fmtRate(s.winRate)}`);
  if (s.avgPct    != null) lines.push(`  Avg outcome : ${fmtPct(s.avgPct)}`);
  if (s.medianPct != null) lines.push(`  Median      : ${fmtPct(s.medianPct)}`);
  if (s.worstLoss != null) lines.push(`  Worst loss  : ${fmtPct(s.worstLoss)}`);
  if (s.oldestPendingAgeMs != null) lines.push(`  Oldest pending: ${fmtAge(s.oldestPendingAgeMs)} ago`);
  if (s.newestPendingAgeMs != null) lines.push(`  Newest pending: ${fmtAge(s.newestPendingAgeMs)} ago`);
  lines.push('');

  if (wl.candidates.length === 0) {
    lines.push('  (no candidates pass the full combo policy)');
    return lines;
  }

  lines.push('  class    age          outcome  pricePct  liqUsd         volUsd         approvedAt           sym/addr');
  let hasRepeated = false;
  for (const c of wl.candidates) {
    const cls   = fmtClass(c.classification);
    const ageMs = nowMs - Date.parse(c.approvedAt);
    const age   = Number.isFinite(ageMs) ? fmtAge(ageMs).padEnd(12) : '?'.padEnd(12);
    const out   = fmtPct(c.outcomePctChange).padStart(8);
    const prc   = c.approvalPriceChangePct != null
      ? `${c.approvalPriceChangePct >= 0 ? '+' : ''}${c.approvalPriceChangePct.toFixed(2)}%`.padEnd(9)
      : '     n/a ';
    const liq   = fmtUsd(c.liquidityUsd).padEnd(14);
    const vol   = fmtUsd(c.volumeUsd).padEnd(14);
    const ts    = c.approvedAt.slice(0, 19).replace('T', ' ');
    const lbl   = c.symbol ? `$${c.symbol}` : c.contractKeyShort;
    const rep   = c.repeatedContract ? ' [*]' : '';
    if (c.repeatedContract) hasRepeated = true;
    lines.push(`  ${cls} ${age} ${out}  ${prc}  ${liq}  ${vol}  ${ts}  ${lbl}${rep}`);
  }
  if (hasRepeated) {
    lines.push('  [*] Repeated contract: all instances share the same latest outcome (outcomes keyed by contractKey).');
  }
  return lines;
}

function renderFullComboUniqueContractView(
  view: FullComboUniqueContractView,
): string[] {
  const lines: string[] = [];
  const s = view.summary;

  lines.push(`  Unique contracts : ${s.uniqueContractCount}`);
  lines.push(`  Total instances  : ${s.totalInstancesRepresented}`);
  if (s.repeatedContractCount > 0) lines.push(`  Repeated         : ${s.repeatedContractCount}`);
  lines.push(`  Priced: ${s.pricedUniqueContracts}   Pending: ${s.pendingUniqueContracts}`);
  lines.push(`  Winners: ${s.winnerUniqueContracts}   Losers: ${s.loserUniqueContracts}   Win rate: ${fmtRate(s.uniqueContractWinRate)}`);
  if (s.avgPct    != null) lines.push(`  Avg outcome : ${fmtPct(s.avgPct)}`);
  if (s.medianPct != null) lines.push(`  Median      : ${fmtPct(s.medianPct)}`);
  if (s.worstLoss != null) lines.push(`  Worst loss  : ${fmtPct(s.worstLoss)}`);
  if (s.bestWinner) {
    const b = s.bestWinner;
    lines.push(`  Best winner : ${b.symbol ? `$${b.symbol}` : b.contractKeyShort}  ${fmtPct(b.outcomePctChange)}`);
  }
  if (s.worstLoser) {
    const w = s.worstLoser;
    lines.push(`  Worst loser : ${w.symbol ? `$${w.symbol}` : w.contractKeyShort}  ${fmtPct(w.outcomePctChange)}`);
  }
  lines.push('');

  if (view.entries.length === 0) {
    lines.push('  (no unique contracts)');
  } else {
    lines.push('  class    insts  outcome  bestPricePct  bestLiqUsd     bestVolUsd     latestApprovedAt     sym/addr');
    for (const e of view.entries) {
      const cls   = fmtClass(e.classification);
      const insts = String(e.instanceCount).padStart(5);
      const out   = fmtPct(e.outcomePctChange).padStart(8);
      const prc   = e.bestApprovalPriceChangePct != null
        ? `${e.bestApprovalPriceChangePct >= 0 ? '+' : ''}${e.bestApprovalPriceChangePct.toFixed(2)}%`.padEnd(13)
        : '          n/a ';
      const liq   = fmtUsd(e.bestLiquidityUsd).padEnd(14);
      const vol   = fmtUsd(e.bestVolumeUsd).padEnd(14);
      const ts    = e.latestApprovedAt.slice(0, 19).replace('T', ' ');
      const lbl   = e.symbol ? `$${e.symbol}` : e.contractKeyShort;
      const rep   = e.repeated ? ' [r]' : '';
      lines.push(`  ${cls} ${insts}  ${out}  ${prc}  ${liq}  ${vol}  ${ts}  ${lbl}${rep}`);
    }
    lines.push('');
  }

  // Side-by-side comparison
  const c = view.comparison;
  lines.push('  FULL COMBO INSTANCE VIEW vs UNIQUE CONTRACT VIEW');
  lines.push('');
  const compHdr = 'metric'.padEnd(22) + 'INSTANCE VIEW'.padStart(16) + 'UNIQUE CONTRACT'.padStart(18);
  lines.push(`  ${compHdr}`);
  lines.push(`  ${'-'.repeat(compHdr.length)}`);
  const compRows: [string, string, string][] = [
    ['candidates / unique', String(c.instanceCandidates), String(c.uniqueContracts)],
    ['priced',              String(c.instancePriced),     String(c.uniquePriced)],
    ['pending',             String(c.instancePending),    String(c.uniquePending)],
    ['winners',             String(c.instanceWinners),    String(c.uniqueWinners)],
    ['losers',              String(c.instanceLosers),     String(c.uniqueLosers)],
    ['win rate',            fmtRate(c.instanceWinRate),   fmtRate(c.uniqueWinRate)],
    ['avg',                 fmtPct(c.instanceAvgPct),     fmtPct(c.uniqueAvgPct)],
    ['median',              fmtPct(c.instanceMedianPct),  fmtPct(c.uniqueMedianPct)],
    ['worst loss',          fmtPct(c.instanceWorstLoss),  fmtPct(c.uniqueWorstLoss)],
  ];
  for (const [label, instVal, uniqVal] of compRows) {
    lines.push(`  ${label.padEnd(22)}${instVal.padStart(16)}${uniqVal.padStart(18)}`);
  }
  return lines;
}

function renderPolicyCandidateTable(stats: ComboPolicyStats): string[] {
  const lines: string[] = [];
  if (stats.candidates.length === 0) {
    lines.push('    (no candidates pass this policy)');
    return lines;
  }
  lines.push('    class    outcome  pricePct  liqUsd         volUsd         approvedAt           sym/addr');
  let hasRepeated = false;
  for (const c of stats.candidates) {
    const cls  = fmtClass(c.classification);
    const out  = fmtPct(c.outcomePctChange).padStart(8);
    const prc  = c.approvalPriceChangePct != null
      ? `${c.approvalPriceChangePct >= 0 ? '+' : ''}${c.approvalPriceChangePct.toFixed(2)}%`.padEnd(9)
      : '     n/a ';
    const liq  = fmtUsd(c.liquidityUsd).padEnd(14);
    const vol  = fmtUsd(c.volumeUsd).padEnd(14);
    const ts   = c.approvedAt.slice(0, 19).replace('T', ' ');
    const lbl  = c.symbol ? `$${c.symbol}` : c.contractKeyShort;
    const rep  = c.repeatedContract ? ' [*]' : '';
    if (c.repeatedContract) hasRepeated = true;
    lines.push(`    ${cls} ${out}  ${prc}  ${liq}  ${vol}  ${ts}  ${lbl}${rep}`);
  }
  if (hasRepeated) {
    lines.push('    [*] Repeated contract: all instances share the same latest outcome (outcomes keyed by contractKey).');
  }
  return lines;
}

function renderPolicyBlock(stats: ComboPolicyStats, isAll: boolean): string[] {
  const lines: string[] = [];
  const tag = isAll ? 'ALL (baseline)' : stats.policyId;
  lines.push(`  ── ${tag}`);
  lines.push(`     ${stats.description}`);
  lines.push(`     Pass count : ${stats.passCount}   Priced: ${stats.pricedCount}   Pending: ${stats.pendingCount}`);
  lines.push(`     Winners    : ${stats.winners}   Losers: ${stats.losers}   Win rate: ${fmtRate(stats.winRate)}`);
  if (stats.avgPct    != null) lines.push(`     Avg        : ${fmtPct(stats.avgPct)}`);
  if (stats.medianPct != null) lines.push(`     Median     : ${fmtPct(stats.medianPct)}`);
  if (stats.totalSimPct != null) lines.push(`     Total sim  : ${fmtPct(stats.totalSimPct)}`);
  if (stats.avgWinnerPct != null) lines.push(`     Avg winner : ${fmtPct(stats.avgWinnerPct)}`);
  if (stats.avgLoserPct  != null) lines.push(`     Avg loser  : ${fmtPct(stats.avgLoserPct)}`);
  if (stats.bestCandidate) {
    const b = stats.bestCandidate;
    lines.push(`     Best       : ${b.symbol ? `$${b.symbol}` : b.contractKeyShort}  ${fmtPct(b.outcomePctChange)}`);
  }
  if (stats.worstCandidate && stats.worstCandidate !== stats.bestCandidate) {
    const w = stats.worstCandidate;
    lines.push(`     Worst      : ${w.symbol ? `$${w.symbol}` : w.contractKeyShort}  ${fmtPct(w.outcomePctChange)}`);
  }
  lines.push('');
  for (const l of renderPolicyCandidateTable(stats)) lines.push(l);
  return lines;
}

export function renderRipperShadowComboReport(
  result: RipperShadowComboReportResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER SHADOW COMBO POLICY REPORT');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY — SHADOW ANALYSIS]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated         : ${result.generatedAt}`);
  lines.push('');
  lines.push('  Inputs:');
  lines.push(`    Approval files  : ${result.approvalFilesRead}${result.approvalFilesMissing > 0 ? ` (${result.approvalFilesMissing} missing)` : ''}`);
  lines.push(`    Outcome files   : ${result.outcomeFilesRead}${result.outcomeFilesMissing > 0 ? ` (${result.outcomeFilesMissing} missing)` : ''}`);
  {
    const dupNote  = result.exactDuplicatesSkipped > 0
      ? ` (${result.exactDuplicatesSkipped} exact dup${result.exactDuplicatesSkipped === 1 ? '' : 's'} skipped)`
      : '';
    const instWord = result.totalCandidates === 1 ? 'instance' : 'instances';
    lines.push(`    Approvals loaded: ${result.approvalInstancesLoaded} → ${result.totalCandidates} ${instWord}${dupNote}`);
    const repNote  = result.repeatedContractsCount > 0
      ? ` (${result.repeatedContractsCount} repeated [*])`
      : '';
    lines.push(`    Unique contracts: ${result.uniqueContracts}${repNote}`);
  }
  lines.push('');

  if (result.totalCandidates === 0) {
    lines.push('  (no approved candidates — check --approvals paths)');
    lines.push('');
  } else {
    // ── ALL baseline ──────────────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  BASELINE — ALL APPROVALS');
    lines.push(`  ${SEP2}`);
    lines.push('');
    for (const l of renderPolicyBlock(result.allStats, true)) lines.push(l);
    lines.push('');

    // ── Per-policy sections ───────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  POLICY VARIANTS');
    lines.push(`  ${SEP2}`);
    lines.push('');
    for (const ps of result.policyStats) {
      for (const l of renderPolicyBlock(ps, false)) lines.push(l);
      lines.push('');
    }

    // ── Policy read comparison table ──────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  POLICY READ COMPARISON (shadow only, small sample)');
    lines.push(`  ${SEP2}`);
    lines.push('');
    const hdr = 'policy'.padEnd(42) + 'priced'.padStart(7) + 'avg'.padStart(9) + 'median'.padStart(9) + 'winRate'.padStart(9) + 'worstLoss'.padStart(11);
    lines.push(`  ${hdr}`);
    lines.push(`  ${'-'.repeat(hdr.length)}`);

    const allRow = [
      'ALL (baseline)'.padEnd(42),
      String(result.allStats.pricedCount).padStart(7),
      fmtPct(result.allStats.avgPct).padStart(9),
      fmtPct(result.allStats.medianPct).padStart(9),
      fmtRate(result.allStats.winRate).padStart(9),
      fmtPct(result.allStats.worstCandidate?.outcomePctChange).padStart(11),
    ].join('');
    lines.push(`  ${allRow}`);

    for (const ps of result.policyStats) {
      const row = [
        ps.policyId.padEnd(42),
        String(ps.pricedCount).padStart(7),
        fmtPct(ps.avgPct).padStart(9),
        fmtPct(ps.medianPct).padStart(9),
        fmtRate(ps.winRate).padStart(9),
        fmtPct(ps.worstCandidate?.outcomePctChange).padStart(11),
      ].join('');
      lines.push(`  ${row}`);
    }
    lines.push('');
    lines.push(`  ⚠ Sample sizes are tiny. Numbers will shift as more outcomes resolve.`);
    lines.push('');
  }

  // ── Current leader (always shown) ─────────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  CURRENT LEADER');
  lines.push(`  ${SEP2}`);
  lines.push('');
  if (result.currentLeader == null) {
    lines.push('  No reliable leader yet.');
    lines.push('  (no policy meets: priced >= 3, avg > ALL, median > ALL, worst loss not worse than ALL)');
  } else {
    const l = result.currentLeader;
    lines.push(`  → ${l.policyId}`);
    lines.push(`    ${l.description}`);
    lines.push(`    Priced: ${l.pricedCount}  Avg: ${fmtPct(l.avgPct)}  Median: ${fmtPct(l.medianPct)}  Win rate: ${fmtRate(l.winRate)}`);
    if (l.worstLoss != null) lines.push(`    Worst loss: ${fmtPct(l.worstLoss)}`);
    lines.push('');
    lines.push('  ⚠ This is exploratory only. Do NOT use as a buy signal or gate.');
  }
  lines.push('');

  // ── Full combo watchlist (always shown) ───────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  FULL COMBO WATCHLIST');
  lines.push(`  ${SEP2}`);
  lines.push('');
  for (const l of renderFullComboWatchlist(result.fullComboWatchlist, result.generatedAt)) lines.push(l);
  lines.push('');

  // ── Full combo unique-contract view (always shown) ───────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  FULL COMBO UNIQUE-CONTRACT VIEW');
  lines.push(`  ${SEP2}`);
  lines.push('');
  for (const l of renderFullComboUniqueContractView(result.fullComboUniqueContractView)) lines.push(l);
  lines.push('');

  // ── Do Not Apply Yet (always shown) ───────────────────────────────────────
  lines.push(`  ${SEP2}`);
  lines.push('  DO NOT APPLY YET');
  lines.push(`  ${SEP2}`);
  lines.push('');
  lines.push('  * Shadow comparison only — no real or paper positions were opened.');
  lines.push('  * Do NOT enable real trading.');
  lines.push('  * Do NOT change paper approval logic.');
  lines.push('  * Do NOT change scoring weights.');
  lines.push('  * Do NOT change buy gates.');
  lines.push('  * Do NOT call auto-paper.');
  lines.push('  * PASS is NOT a buy signal — it is a research group with a tiny sample.');
  lines.push('  * Need a much larger priced sample before any rule changes.');
  lines.push('');

  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperShadowComboReportUsage(): string {
  return `
token:ripper-shadow-combo-report — compare shadow combo policies against approval/outcome files

Usage:
  npm run token:ripper-shadow-combo-report -- \\
    --approvals <cycle-jsonl...>   \\
    --outcomes  <outcome-json...>

Options:
  --approvals <paths>   cycle JSONL files containing BUY_APPROVED_PAPER fixtures
  --outcomes  <paths>   approved outcome JSON checkpoint files
  --help                show this message

Policies compared:
  ALL                              — baseline (all approvals)
  price_gt_0_25                    — approvalPriceChangePct > 0.25
  price_gt_0_25_and_liq_30k        — + liquidityUsd >= 30000
  price_gt_0_25_and_vol_20k        — + volumeUsd >= 20000
  price_gt_0_25_and_liq_30k_and_vol_20k — all three

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap.
  No live API calls. Read-only artifact scan. No gate or scoring changes.
`.trim();
}
