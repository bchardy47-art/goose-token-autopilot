import * as fs from 'fs';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import type { RipperEarSignal } from './ripperEars';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ShadowFilterId =
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I'
  | 'J' | 'K' | 'L' | 'M' | 'N';

export type EntryClassification = 'WINNER' | 'LOSER' | 'PENDING_PRICE';

export interface ShadowCandidate {
  contractKey:             string;
  symbol?:                 string;
  classification:          EntryClassification;
  outcomePctChange:        number | null;
  approvalScore:           number | null;
  approvalAgeMinutes:      number | null;
  approvalPriceChangePct:  number | null;
  liquidityUsd:            number | null;
  volumeUsd:               number | null;
  clusterRisk:             string;
  latestObsScore:          number | null;
  filterResults:           Record<ShadowFilterId, boolean>;
}

export interface FilterSummary {
  filterId:              ShadowFilterId;
  filterLabel:           string;
  filterDescription:     string;
  candidatesPassed:      number;
  candidatesRejected:    number;
  winnersKept:           number;
  winnersRejected:       number;
  losersKept:            number;
  losersRejected:        number;
  pendingKept:           number;
  pendingRejected:       number;
  keptWinnerPct:         number | null;
  rejectedLoserPct:      number | null;
  keptAvgOutcomePct:     number | null;
  rejectedAvgOutcomePct: number | null;
  keptGuardian:          boolean;
  rejectedTrilly:        boolean;
  rejectedSpcx69:        boolean;
}

export interface BestFilterRank {
  filterId:          ShadowFilterId;
  filterLabel:       string;
  filterDescription: string;
  score:             number;
  reasons:           string[];
}

export interface RipperShadowFilterReportOptions {
  approvalPaths:    string[];
  observationPaths: string[];
  outcomePaths:     string[];
  nowMs?:           number;
}

export interface RipperShadowFilterReportResult {
  generatedAt:              string;
  approvalFilesRead:        number;
  approvalFilesMissing:     number;
  observationFilesRead:     number;
  observationFilesMissing:  number;
  outcomeFilesRead:         number;
  outcomeFilesMissing:      number;
  approvalsRead:            number;
  observationsRead:         number;
  outcomesRead:             number;
  totalCandidates:          number;
  winnersCount:             number;
  losersCount:              number;
  pendingCount:             number;
  overallAvgOutcomePct:     number | null;
  candidates:               ShadowCandidate[];
  filterSummaries:          FilterSummary[];
  bestLookingFilters:       BestFilterRank[];
  realTradingLocked:        true;
  tradingExecuted:          0;
  noRealTradeSent:          true;
  paperOnly:                true;
  readOnly:                 true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function signalKey(s: RipperEarSignal): string {
  return s.contract ?? s.tokenAddress ?? s.poolAddress ?? s.id;
}

function toFiniteNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgOf(xs: (number | null)[]): number | null {
  const nums = xs.filter((x): x is number => x != null);
  return nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

function safeRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function safeStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function getClusterRisk(f: LiveRipperFixture): string {
  const raw = safeRecord(f.raw);
  const v   = raw['clusterRisk'];
  if (v === 'CLEAN' || v === 'WATCH' || v === 'RISKY') return v;
  return 'UNKNOWN';
}

// ── Filter configuration ───────────────────────────────────────────────────────

interface FilterableFields {
  liquidityUsd:           number | null;
  volumeUsd:              number | null;
  approvalPriceChangePct: number | null;
}

interface FilterConfig {
  id:          ShadowFilterId;
  label:       string;
  description: string;
  evaluate:    (f: FilterableFields) => boolean;
}

const FILTER_CONFIGS: FilterConfig[] = [
  {
    id: 'A', label: 'liq≥50k',
    description: 'liquidityUsd >= 50000',
    evaluate: f => f.liquidityUsd != null && f.liquidityUsd >= 50_000,
  },
  {
    id: 'B', label: 'liq≥75k',
    description: 'liquidityUsd >= 75000',
    evaluate: f => f.liquidityUsd != null && f.liquidityUsd >= 75_000,
  },
  {
    id: 'C', label: 'liq≥100k',
    description: 'liquidityUsd >= 100000',
    evaluate: f => f.liquidityUsd != null && f.liquidityUsd >= 100_000,
  },
  {
    id: 'D', label: 'vol≥20k',
    description: 'volumeUsd >= 20000',
    evaluate: f => f.volumeUsd != null && f.volumeUsd >= 20_000,
  },
  {
    id: 'E', label: 'vol≥25k',
    description: 'volumeUsd >= 25000',
    evaluate: f => f.volumeUsd != null && f.volumeUsd >= 25_000,
  },
  {
    id: 'F', label: 'vol≥50k',
    description: 'volumeUsd >= 50000',
    evaluate: f => f.volumeUsd != null && f.volumeUsd >= 50_000,
  },
  {
    id: 'G', label: 'price>0.25%',
    description: 'approvalPriceChangePct > 0.25',
    evaluate: f => f.approvalPriceChangePct != null && f.approvalPriceChangePct > 0.25,
  },
  {
    id: 'H', label: 'price>0.5%',
    description: 'approvalPriceChangePct > 0.5',
    evaluate: f => f.approvalPriceChangePct != null && f.approvalPriceChangePct > 0.5,
  },
  {
    id: 'I', label: 'price>1%',
    description: 'approvalPriceChangePct > 1.0',
    evaluate: f => f.approvalPriceChangePct != null && f.approvalPriceChangePct > 1.0,
  },
  {
    id: 'J', label: 'liq≥75k+vol≥25k',
    description: 'liquidityUsd >= 75000 AND volumeUsd >= 25000',
    evaluate: f =>
      f.liquidityUsd != null && f.liquidityUsd >= 75_000 &&
      f.volumeUsd    != null && f.volumeUsd    >= 25_000,
  },
  {
    id: 'K', label: 'liq≥75k+price>0.5%',
    description: 'liquidityUsd >= 75000 AND approvalPriceChangePct > 0.5',
    evaluate: f =>
      f.liquidityUsd           != null && f.liquidityUsd           >= 75_000 &&
      f.approvalPriceChangePct != null && f.approvalPriceChangePct >  0.5,
  },
  {
    id: 'L', label: 'vol≥25k+price>0.5%',
    description: 'volumeUsd >= 25000 AND approvalPriceChangePct > 0.5',
    evaluate: f =>
      f.volumeUsd              != null && f.volumeUsd              >= 25_000 &&
      f.approvalPriceChangePct != null && f.approvalPriceChangePct >  0.5,
  },
  {
    id: 'M', label: 'liq≥75k+vol≥25k+price>0.5%',
    description: 'liquidityUsd >= 75000 AND volumeUsd >= 25000 AND approvalPriceChangePct > 0.5',
    evaluate: f =>
      f.liquidityUsd           != null && f.liquidityUsd           >= 75_000 &&
      f.volumeUsd              != null && f.volumeUsd              >= 25_000 &&
      f.approvalPriceChangePct != null && f.approvalPriceChangePct >  0.5,
  },
  {
    id: 'N', label: 'liq≥100k+vol≥50k+price>1%',
    description: 'liquidityUsd >= 100000 AND volumeUsd >= 50000 AND approvalPriceChangePct > 1.0',
    evaluate: f =>
      f.liquidityUsd           != null && f.liquidityUsd           >= 100_000 &&
      f.volumeUsd              != null && f.volumeUsd              >= 50_000  &&
      f.approvalPriceChangePct != null && f.approvalPriceChangePct >  1.0,
  },
];

// ── Filter scoring ────────────────────────────────────────────────────────────

function scoreFilter(
  summary:          FilterSummary,
  totalWinners:     number,
  totalLosers:      number,
  overallAvgOutcome: number | null,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // +3: kept GUARDIAN (highest-outcome candidate in this session)
  if (summary.keptGuardian) {
    score += 3; reasons.push('kept GUARDIAN');
  }

  // +2: rejected at least one loser
  if (summary.losersRejected >= 1) {
    score += 2; reasons.push(`rejected ${summary.losersRejected}/${totalLosers} loser(s)`);
  }

  // +1: rejected Trilly specifically
  if (summary.rejectedTrilly) {
    score += 1; reasons.push('rejected Trilly');
  }

  // +1: rejected SPCX69 specifically
  if (summary.rejectedSpcx69) {
    score += 1; reasons.push('rejected SPCX69');
  }

  // +1: kept >= 2 winners (or >= 2/3 of total winners)
  const winnerThreshold = totalWinners >= 3 ? 2 : totalWinners;
  if (totalWinners > 0 && summary.winnersKept >= winnerThreshold) {
    score += 1; reasons.push(`kept ${summary.winnersKept}/${totalWinners} winners`);
  }

  // +1: improved kept avg outcome vs overall avg
  if (
    summary.keptAvgOutcomePct != null &&
    overallAvgOutcome != null &&
    summary.keptAvgOutcomePct > overallAvgOutcome
  ) {
    score += 1;
    reasons.push(
      `improved avg outcome (${summary.keptAvgOutcomePct.toFixed(1)}% kept vs ${overallAvgOutcome.toFixed(1)}% overall)`,
    );
  }

  // Penalties
  if (totalWinners > 0 && summary.winnersKept === 0) {
    score -= 2; // all winners rejected
  }
  if (summary.winnersRejected > summary.losersRejected) {
    score -= 1; // rejecting more winners than losers = wrong direction
  }
  if (summary.candidatesPassed === 0) {
    score -= 2; // everything filtered out
  }

  return { score, reasons };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function runRipperShadowFilterReport(
  options: RipperShadowFilterReportOptions,
): RipperShadowFilterReportResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  // ── Step 1: Read approval fixtures (earliest per key) ──────────────────────
  let approvalFilesRead    = 0;
  let approvalFilesMissing = 0;
  let approvalsRead        = 0;
  const approvalMap        = new Map<string, LiveRipperFixture>();

  for (const p of options.approvalPaths) {
    if (!fs.existsSync(p)) { approvalFilesMissing++; continue; }
    approvalFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      if (f.buyGateDecision !== 'BUY_APPROVED_PAPER') continue;
      approvalsRead++;
      const key = signalKey(f.normalizedSignal);
      const ex  = approvalMap.get(key);
      if (!ex || f.capturedAt < ex.capturedAt) approvalMap.set(key, f);
    }
  }

  // ── Step 2: Read observation fixtures (latest per key) ────────────────────
  let observationFilesRead    = 0;
  let observationFilesMissing = 0;
  let observationsRead        = 0;

  interface ObsEntry { ageMinutes: number | null; score: number | null; capturedAt: string }
  const obsListMap = new Map<string, ObsEntry[]>();

  for (const p of options.observationPaths) {
    if (!fs.existsSync(p)) { observationFilesMissing++; continue; }
    observationFilesRead++;
    for (const f of readFixturesFromJsonl(p)) {
      observationsRead++;
      const key  = signalKey(f.normalizedSignal);
      const entry: ObsEntry = {
        ageMinutes: typeof f.ageMinutes  === 'number' ? f.ageMinutes  : null,
        score:      typeof f.ripperScore  === 'number' ? f.ripperScore  : null,
        capturedAt: f.capturedAt,
      };
      const list = obsListMap.get(key);
      if (list) list.push(entry); else obsListMap.set(key, [entry]);
    }
  }

  const latestObsMap = new Map<string, ObsEntry>();
  for (const [key, list] of obsListMap) {
    list.sort((a, b) => {
      if (a.ageMinutes != null && b.ageMinutes != null) return b.ageMinutes - a.ageMinutes;
      if (a.ageMinutes != null) return -1;
      if (b.ageMinutes != null) return  1;
      return b.capturedAt.localeCompare(a.capturedAt);
    });
    latestObsMap.set(key, list[0]);
  }

  // ── Step 3: Read outcome data (latest checkpointAt per key) ─────────────────
  let outcomeFilesRead    = 0;
  let outcomeFilesMissing = 0;
  let outcomesRead        = 0;

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
      outcomesRead++;
      const ckAt = safeStr(cr['checkpointAt']) ?? fileCheckpointAt;
      const ex   = outcomeMap.get(key);
      if (!ex || ckAt >= ex.checkpointAt) {
        outcomeMap.set(key, { pctChangeFromEntry: toFiniteNum(cr['pctChangeFromEntry']), checkpointAt: ckAt });
      }
    }
  }

  // ── Step 4: Build per-candidate records ────────────────────────────────────
  const candidates: ShadowCandidate[] = [];

  for (const [key, f] of approvalMap) {
    const sig = f.normalizedSignal;
    const out = outcomeMap.get(key);
    const obs = latestObsMap.get(key);

    const outcomePctChange: number | null = out?.pctChangeFromEntry ?? null;
    const classification: EntryClassification =
      outcomePctChange == null ? 'PENDING_PRICE'
      : outcomePctChange > 0  ? 'WINNER'
      : 'LOSER';

    const approvalPriceChangePct = toFiniteNum(sig.priceChangePct);
    const liquidityUsd           = toFiniteNum(sig.liquidityUsd);
    const volumeUsd              = toFiniteNum(sig.volumeUsd);

    const fields: FilterableFields = { liquidityUsd, volumeUsd, approvalPriceChangePct };

    const filterResults = {} as Record<ShadowFilterId, boolean>;
    for (const cfg of FILTER_CONFIGS) {
      filterResults[cfg.id] = cfg.evaluate(fields);
    }

    candidates.push({
      contractKey:            key,
      symbol:                 sig.symbol,
      classification,
      outcomePctChange,
      approvalScore:          typeof f.ripperScore === 'number' ? f.ripperScore : null,
      approvalAgeMinutes:     typeof f.ageMinutes  === 'number' ? f.ageMinutes  : null,
      approvalPriceChangePct,
      liquidityUsd,
      volumeUsd,
      clusterRisk:            getClusterRisk(f),
      latestObsScore:         obs?.score ?? null,
      filterResults,
    });
  }

  // Sort: winners first (desc), losers next, pending last
  candidates.sort((a, b) => {
    if (a.outcomePctChange != null && b.outcomePctChange != null) return b.outcomePctChange - a.outcomePctChange;
    if (a.outcomePctChange != null) return -1;
    if (b.outcomePctChange != null) return  1;
    return 0;
  });

  const winners = candidates.filter(c => c.classification === 'WINNER');
  const losers  = candidates.filter(c => c.classification === 'LOSER');
  const pending = candidates.filter(c => c.classification === 'PENDING_PRICE');
  const priced  = candidates.filter(c => c.outcomePctChange != null);

  const overallAvgOutcomePct = avgOf(priced.map(c => c.outcomePctChange));

  // ── Step 5: Build per-filter summaries ─────────────────────────────────────
  const filterSummaries: FilterSummary[] = FILTER_CONFIGS.map(cfg => {
    const passed   = candidates.filter(c => c.filterResults[cfg.id]);
    const rejected = candidates.filter(c => !c.filterResults[cfg.id]);

    const winnersKept     = winners.filter(c => c.filterResults[cfg.id]).length;
    const winnersRejected = winners.filter(c => !c.filterResults[cfg.id]).length;
    const losersKept      = losers.filter(c => c.filterResults[cfg.id]).length;
    const losersRejected  = losers.filter(c => !c.filterResults[cfg.id]).length;
    const pendingKept     = pending.filter(c => c.filterResults[cfg.id]).length;
    const pendingRejected = pending.filter(c => !c.filterResults[cfg.id]).length;

    const keptPriced     = passed.filter(c => c.outcomePctChange != null);
    const rejectedPriced = rejected.filter(c => c.outcomePctChange != null);

    // Track spotlight symbols (generic by symbol name)
    const keptGuardian  = passed.some(c => c.symbol === 'GUARDIAN');
    const rejectedTrilly  = rejected.some(c => c.symbol === 'Trilly');
    const rejectedSpcx69  = rejected.some(c => c.symbol === 'SPCX69');

    return {
      filterId:              cfg.id,
      filterLabel:           cfg.label,
      filterDescription:     cfg.description,
      candidatesPassed:      passed.length,
      candidatesRejected:    rejected.length,
      winnersKept,
      winnersRejected,
      losersKept,
      losersRejected,
      pendingKept,
      pendingRejected,
      keptWinnerPct:         winners.length > 0 ? (winnersKept / winners.length) * 100 : null,
      rejectedLoserPct:      losers.length  > 0 ? (losersRejected / losers.length) * 100 : null,
      keptAvgOutcomePct:     avgOf(keptPriced.map(c => c.outcomePctChange)),
      rejectedAvgOutcomePct: avgOf(rejectedPriced.map(c => c.outcomePctChange)),
      keptGuardian,
      rejectedTrilly,
      rejectedSpcx69,
    };
  });

  // ── Step 6: Rank best-looking filters ──────────────────────────────────────
  const ranked: BestFilterRank[] = [];
  for (const summary of filterSummaries) {
    const { score, reasons } = scoreFilter(summary, winners.length, losers.length, overallAvgOutcomePct);
    if (score > 0) {
      ranked.push({
        filterId:          summary.filterId,
        filterLabel:       summary.filterLabel,
        filterDescription: summary.filterDescription,
        score,
        reasons,
      });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.filterId.localeCompare(b.filterId));

  return {
    generatedAt,
    approvalFilesRead,
    approvalFilesMissing,
    observationFilesRead,
    observationFilesMissing,
    outcomeFilesRead,
    outcomeFilesMissing,
    approvalsRead,
    observationsRead,
    outcomesRead,
    totalCandidates:  candidates.length,
    winnersCount:     winners.length,
    losersCount:      losers.length,
    pendingCount:     pending.length,
    overallAvgOutcomePct,
    candidates,
    filterSummaries,
    bestLookingFilters: ranked,
    realTradingLocked: true,
    tradingExecuted:   0,
    noRealTradeSent:   true,
    paperOnly:         true,
    readOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '   n/a';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtK(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function shortKey(k: string): string {
  return k.length > 14 ? `${k.slice(0, 14)}…` : k;
}

const FILTER_IDS: ShadowFilterId[] = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'];

export function renderRipperShadowFilterReport(
  result: RipperShadowFilterReportResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = [];

  lines.push('');
  lines.push(SEP);
  lines.push('  TOKEN GRAB — RIPPER SHADOW FILTER REPORT');
  lines.push('  [REAL TRADING LOCKED — PAPER ONLY — READ ONLY — SHADOW ANALYSIS]');
  lines.push(SEP);
  lines.push('');
  lines.push(`  Generated           : ${result.generatedAt}`);
  lines.push('');
  lines.push('  Inputs:');
  lines.push(`    Approval files    : ${result.approvalFilesRead}${result.approvalFilesMissing > 0 ? ` (${result.approvalFilesMissing} missing)` : ''}`);
  lines.push(`    Observation files : ${result.observationFilesRead}${result.observationFilesMissing > 0 ? ` (${result.observationFilesMissing} missing)` : ''}`);
  lines.push(`    Outcome files     : ${result.outcomeFilesRead}${result.outcomeFilesMissing > 0 ? ` (${result.outcomeFilesMissing} missing)` : ''}`);
  lines.push('');
  lines.push('  Candidates:');
  lines.push(`    Total             : ${result.totalCandidates}`);
  lines.push(`    Winners           : ${result.winnersCount}`);
  lines.push(`    Losers            : ${result.losersCount}`);
  lines.push(`    Pending price     : ${result.pendingCount}`);
  if (result.overallAvgOutcomePct != null) {
    lines.push(`    Overall avg outcome (pre-filter): ${fmtPct(result.overallAvgOutcomePct)}`);
  }
  lines.push('');

  if (result.totalCandidates === 0) {
    lines.push('  (no candidates — check --approvals paths)');
    lines.push('');
  } else {
    // ── Filter legend ───────────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  FILTER LEGEND');
    lines.push(`  ${SEP2}`);
    for (const s of result.filterSummaries) {
      lines.push(`  [${s.filterId}] ${s.filterDescription}`);
    }
    lines.push('');

    // ── Candidate pass/fail grid ────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  CANDIDATE PASS/FAIL GRID  (✓=pass  ✗=fail)');
    lines.push(`  ${SEP2}`);
    lines.push('');
    const header = '  sym/addr         class        outcome   score  liq       vol      price%   ' +
                   FILTER_IDS.map(id => id.padStart(2)).join(' ');
    lines.push(header);

    for (const c of result.candidates) {
      const sym    = (c.symbol ? `$${c.symbol}` : shortKey(c.contractKey)).padEnd(16);
      const cls    = c.classification.padEnd(12);
      const out    = fmtPct(c.outcomePctChange).padEnd(9);
      const scr    = (c.approvalScore != null ? String(Math.round(c.approvalScore)) : '?').padStart(5);
      const liq    = fmtK(c.liquidityUsd).padEnd(9);
      const vol    = fmtK(c.volumeUsd).padEnd(8);
      const price  = fmtPct(c.approvalPriceChangePct).padEnd(8);
      const passes = FILTER_IDS.map(id => (c.filterResults[id] ? '✓' : '✗').padStart(2)).join(' ');
      lines.push(`  ${sym} ${cls} ${out} ${scr}  ${liq} ${vol} ${price}  ${passes}`);
    }
    lines.push('');

    // ── Per-filter summary table ────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  PER-FILTER SUMMARY');
    lines.push(`  ${SEP2}`);
    lines.push('');
    lines.push(
      '  ID  label                    pass rej  Wkept Wrej  Lkept Lrej  Pkept Prej' +
      '  W%kept  L%rej  keptAvg  rejAvg  GUARD Trilly SPCX69',
    );
    for (const s of result.filterSummaries) {
      const label    = s.filterLabel.padEnd(24).slice(0, 24);
      const wKeptPct = s.keptWinnerPct    != null ? `${s.keptWinnerPct.toFixed(0)}%`.padStart(6)    : '   n/a';
      const lRejPct  = s.rejectedLoserPct != null ? `${s.rejectedLoserPct.toFixed(0)}%`.padStart(6) : '   n/a';
      const kAvg     = s.keptAvgOutcomePct    != null ? fmtPct(s.keptAvgOutcomePct).padStart(7)    : '    n/a';
      const rAvg     = s.rejectedAvgOutcomePct != null ? fmtPct(s.rejectedAvgOutcomePct).padStart(7) : '    n/a';
      lines.push(
        `  [${s.filterId}] ${label}` +
        `  ${String(s.candidatesPassed).padStart(4)} ${String(s.candidatesRejected).padStart(3)}` +
        `  ${String(s.winnersKept).padStart(5)} ${String(s.winnersRejected).padStart(4)}` +
        `  ${String(s.losersKept).padStart(5)} ${String(s.losersRejected).padStart(4)}` +
        `  ${String(s.pendingKept).padStart(5)} ${String(s.pendingRejected).padStart(4)}` +
        `  ${wKeptPct}  ${lRejPct}  ${kAvg}  ${rAvg}` +
        `  ${s.keptGuardian ? 'YES' : 'no '}   ${s.rejectedTrilly ? 'YES' : 'no '}   ${s.rejectedSpcx69 ? 'YES' : 'no '}`,
      );
    }
    lines.push('');

    // ── Best-looking filters ────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  BEST-LOOKING FILTERS (conservative ranking — shadow analysis only)');
    lines.push(`  ${SEP2}`);
    lines.push('');
    if (result.bestLookingFilters.length === 0) {
      lines.push('  (no filter scored > 0 with this sample)');
    } else {
      for (let i = 0; i < result.bestLookingFilters.length; i++) {
        const r = result.bestLookingFilters[i];
        lines.push(`  #${i + 1}  [${r.filterId}] ${r.filterDescription}  (score=${r.score})`);
        for (const reason of r.reasons) {
          lines.push(`       • ${reason}`);
        }
        lines.push('');
      }
    }

    // ── Do Not Apply Yet ────────────────────────────────────────────────────
    lines.push(`  ${SEP2}`);
    lines.push('  DO NOT APPLY YET');
    lines.push(`  ${SEP2}`);
    lines.push('');
    lines.push('  * This is shadow analysis only — filters were not applied to live traffic.');
    lines.push('  * Do not change live buy gates from these findings.');
    lines.push('  * Do not change scoring weights.');
    lines.push('  * Do not change BubbleMaps gate behavior.');
    lines.push('  * Do not enable real trading.');
    lines.push('  * Need a much larger priced sample before any rule changes.');
    lines.push('');
  }

  lines.push(`  realTradingLocked=true  tradingExecuted=0  paperOnly=true  readOnly=true`);
  lines.push(SEP);
  lines.push('');
  return lines.join('\n');
}

export function renderRipperShadowFilterReportUsage(): string {
  return `
token:ripper-shadow-filter-report — test hypothetical entry filters against past paper approvals

Usage:
  npm run token:ripper-shadow-filter-report -- \\
    --approvals    <cycle-jsonl...>   \\
    --observations <obs-jsonl...>     \\
    --outcomes     <outcome-json...>

Options:
  --approvals    <paths>   cycle JSONL files containing BUY_APPROVED_PAPER fixtures
  --observations <paths>   observation JSONL files (from data/token-grab/ripper/observations/)
  --outcomes     <paths>   approved outcome JSON checkpoint files
  --help                   show this message

Filters tested (A–N):
  A. liquidityUsd >= 50000
  B. liquidityUsd >= 75000
  C. liquidityUsd >= 100000
  D. volumeUsd >= 20000
  E. volumeUsd >= 25000
  F. volumeUsd >= 50000
  G. approvalPriceChangePct > 0.25
  H. approvalPriceChangePct > 0.5
  I. approvalPriceChangePct > 1.0
  J. liquidityUsd >= 75000 AND volumeUsd >= 25000
  K. liquidityUsd >= 75000 AND approvalPriceChangePct > 0.5
  L. volumeUsd >= 25000 AND approvalPriceChangePct > 0.5
  M. liquidityUsd >= 75000 AND volumeUsd >= 25000 AND approvalPriceChangePct > 0.5
  N. liquidityUsd >= 100000 AND volumeUsd >= 50000 AND approvalPriceChangePct > 1.0

Safety:
  REAL TRADING LOCKED. tradingExecuted=0. No wallet. No signing. No swap.
  No live API calls. Read-only artifact scan. No gate or scoring changes.
`.trim();
}
