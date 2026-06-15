import * as fs from 'fs';
import * as path from 'path';
import { extractRipperContract, extractRipperPriceChangePct } from './ripperExtractors';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutcomeClass = 'WIN_5PCT' | 'WIN_3PCT' | 'WIN_1PCT' | 'DUMP' | 'FLAT_JUNK' | 'UNOBSERVED';

export type FilterRecommendation =
  | 'SHADOW_TEST_NEXT'
  | 'WATCH_ONLY'
  | 'REJECT_FILTER_TOO_AGGRESSIVE'
  | 'NO_EDGE';

export interface FilterResult {
  filterName:         string;
  filterDesc:         string;
  candidatesRejected: number;
  observedRejected:   number;
  flatJunkRejected:   number;
  dumpRejected:       number;
  winners1Killed:     number;
  winners3Killed:     number;
  winners5Killed:     number;
  totalObserved:      number;
  totalFlatJunk:      number;
  totalWinners1:      number;
  totalWinners3:      number;
  totalWinners5:      number;
  junkRemovalRate:    number | null;
  winner1KillRate:    number | null;
  winner3KillRate:    number | null;
  winner5KillRate:    number | null;
  netScore:           number | null;
  recommendation:     FilterRecommendation;
}

export interface ShadowRejectFilterResult {
  generatedAt:          string;
  candidatesAnalyzed:   number;
  observedCandidates:   number;
  obsFilesRead:         number;
  obsRowsRead:          number;
  totalFlatJunk:        number;
  totalDumps:           number;
  totalWinners1:        number;
  totalWinners3:        number;
  totalWinners5:        number;
  unobservedCount:      number;
  individualFilters:    FilterResult[];
  comboFilters:         FilterResult[];
  shadowTestFilters:    string[];
  tooAggressiveFilters: string[];
  overallDecision:      'TEST_SHADOW_REJECT_FILTERS_ONLY' | 'HOLD_CURRENT_GATES';
  decisionNote:         string;
  outPath:              string;
  rowsWritten:          number;
  reportOnly:           true;
  readOnly:             true;
  tradingExecuted:      0;
  realTradingLocked:    true;
  paperOnly:            true;
}

export interface ShadowRejectFilterOptions {
  cyclePaths:       string[];
  observationPaths: string[];
  outPath:          string;
  nowMs?:           number;
}

// ── Internal candidate type ───────────────────────────────────────────────────

interface ClassifiedCandidate {
  contract:             string;
  capturedAt:           string;
  outcome:              OutcomeClass;
  bubbleMapsScore:      number | null;
  liquidityUsd:         number | null;
  volumeLiquidityRatio: number | null;
  ageMinutes:           number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseBubbleMapsScore(notes: unknown): number | null {
  if (!Array.isArray(notes)) return null;
  for (const n of notes) {
    if (typeof n === 'string') {
      const m = n.match(/bubbleMapsScore\s+([\d.]+)/i);
      if (m) return parseFloat(m[1]!);
    }
  }
  return null;
}

function classifyOutcome(pct: number | null): OutcomeClass {
  if (pct == null) return 'UNOBSERVED';
  if (pct >= 5)    return 'WIN_5PCT';
  if (pct >= 3)    return 'WIN_3PCT';
  if (pct >= 1)    return 'WIN_1PCT';
  if (pct <= -3)   return 'DUMP';
  return 'FLAT_JUNK';
}

function isAnyWinner(o: OutcomeClass): boolean {
  return o === 'WIN_1PCT' || o === 'WIN_3PCT' || o === 'WIN_5PCT';
}

function isWinner3(o: OutcomeClass): boolean {
  return o === 'WIN_3PCT' || o === 'WIN_5PCT';
}

function pct(n: number, total: number): number | null {
  if (total === 0) return null;
  return Math.round((n / total) * 1000) / 10;
}

// ── Data loading ──────────────────────────────────────────────────────────────

interface ObsEntry {
  capturedAt:     string;
  priceChangePct: number | null;
}

function readObsMap(paths: string[]): { byContract: Map<string, ObsEntry[]>; filesRead: number; rowsRead: number } {
  const map = new Map<string, ObsEntry[]>();
  let filesRead = 0;
  let rowsRead  = 0;
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    filesRead++;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f          = JSON.parse(line) as Record<string, unknown>;
        rowsRead++;
        const contract   = extractRipperContract(f);
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;
        const list = map.get(contract) ?? [];
        list.push({ capturedAt, priceChangePct: extractRipperPriceChangePct(f) });
        map.set(contract, list);
      } catch { /* skip */ }
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  return { byContract: map, filesRead, rowsRead };
}

function loadClassifiedCandidates(
  cyclePaths: string[],
  obsByContract: Map<string, ObsEntry[]>,
): ClassifiedCandidate[] {
  const seen   = new Set<string>();
  const result: ClassifiedCandidate[] = [];

  for (const p of cyclePaths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f = JSON.parse(line) as Record<string, unknown>;
        if (f['buyGateDecision'] !== 'BUY_APPROVED_PAPER') continue;

        const contract   = extractRipperContract(f);
        const capturedAt = f['capturedAt'] as string | undefined;
        if (!contract || !capturedAt) continue;

        const key = `${contract}::${capturedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const ns  = f['normalizedSignal'] as Record<string, unknown> | undefined;
        const raw = f['raw']             as Record<string, unknown> | undefined;
        const ri  = f['ripperInput']     as Record<string, unknown> | undefined;

        const bubbleMapsScore = parseBubbleMapsScore(raw?.['clusterNotes']);

        const liquidityUsd: number | null =
          typeof ns?.['liquidityUsd'] === 'number' ? (ns['liquidityUsd'] as number) : null;

        const volumeLiquidityRatio: number | null =
          typeof ns?.['volumeLiquidityRatio'] === 'number'
            ? (ns['volumeLiquidityRatio'] as number)
            : typeof ri?.['volumeLiquidityRatio'] === 'number'
              ? (ri['volumeLiquidityRatio'] as number)
              : null;

        const ageMinutes: number | null =
          typeof f['ageMinutes'] === 'number' ? (f['ageMinutes'] as number) : null;

        const obs = (obsByContract.get(contract) ?? [])
          .find(o => o.capturedAt >= capturedAt && o.priceChangePct != null);

        result.push({
          contract,
          capturedAt,
          outcome:              classifyOutcome(obs?.priceChangePct ?? null),
          bubbleMapsScore,
          liquidityUsd,
          volumeLiquidityRatio,
          ageMinutes,
        });
      } catch { /* skip */ }
    }
  }

  return result;
}

// ── Filter predicates ─────────────────────────────────────────────────────────

type FilterPredicate = (c: ClassifiedCandidate) => boolean;

const FILTER_BUBBLE_LT70: FilterPredicate =
  c => c.bubbleMapsScore != null && c.bubbleMapsScore < 70;

const FILTER_LIQ_LT10K: FilterPredicate =
  c => c.liquidityUsd != null && c.liquidityUsd < 10_000;

const FILTER_VLR_UNKNOWN: FilterPredicate =
  c => c.volumeLiquidityRatio == null;

const FILTER_AGE_GTE10: FilterPredicate =
  c => c.ageMinutes != null && c.ageMinutes >= 10;

interface FilterDef {
  name:      string;
  desc:      string;
  predicate: FilterPredicate;
}

const INDIVIDUAL_FILTERS: FilterDef[] = [
  { name: 'bubble_lt70',   desc: 'bubbleMapsScore < 70',             predicate: FILTER_BUBBLE_LT70  },
  { name: 'liq_lt10k',     desc: 'liquidityUsd < $10k',              predicate: FILTER_LIQ_LT10K    },
  { name: 'vlr_unknown',   desc: 'volumeLiquidityRatio unknown/null', predicate: FILTER_VLR_UNKNOWN  },
  { name: 'age_gte10m',    desc: 'ageMinutes >= 10',                  predicate: FILTER_AGE_GTE10    },
];

const COMBO_FILTERS: FilterDef[] = [
  {
    name: 'bubble_OR_liq',
    desc: 'bubbleMapsScore < 70 OR liquidityUsd < $10k',
    predicate: c => FILTER_BUBBLE_LT70(c) || FILTER_LIQ_LT10K(c),
  },
  {
    name: 'bubble_OR_vlr',
    desc: 'bubbleMapsScore < 70 OR vlr unknown',
    predicate: c => FILTER_BUBBLE_LT70(c) || FILTER_VLR_UNKNOWN(c),
  },
  {
    name: 'liq_OR_age',
    desc: 'liquidityUsd < $10k OR ageMinutes >= 10',
    predicate: c => FILTER_LIQ_LT10K(c) || FILTER_AGE_GTE10(c),
  },
  {
    name: 'all_four_OR',
    desc: 'bubble < 70 OR liq < $10k OR vlr unknown OR age >= 10',
    predicate: c =>
      FILTER_BUBBLE_LT70(c) || FILTER_LIQ_LT10K(c) ||
      FILTER_VLR_UNKNOWN(c) || FILTER_AGE_GTE10(c),
  },
];

// ── Filter evaluation ─────────────────────────────────────────────────────────

function evaluateFilter(
  def:        FilterDef,
  candidates: ClassifiedCandidate[],
  totals: {
    totalObserved: number;
    totalFlatJunk: number;
    totalWinners1: number;
    totalWinners3: number;
    totalWinners5: number;
  },
): FilterResult {
  const rejected = candidates.filter(def.predicate);

  const candidatesRejected = rejected.length;
  const observedRejected   = rejected.filter(c => c.outcome !== 'UNOBSERVED').length;
  const flatJunkRejected   = rejected.filter(c => c.outcome === 'FLAT_JUNK').length;
  const dumpRejected       = rejected.filter(c => c.outcome === 'DUMP').length;
  const winners1Killed     = rejected.filter(c => isAnyWinner(c.outcome)).length;
  const winners3Killed     = rejected.filter(c => isWinner3(c.outcome)).length;
  const winners5Killed     = rejected.filter(c => c.outcome === 'WIN_5PCT').length;

  const junkRemovalRate = pct(flatJunkRejected, totals.totalFlatJunk);
  const winner1KillRate = pct(winners1Killed, totals.totalWinners1);
  const winner3KillRate = pct(winners3Killed, totals.totalWinners3);
  const winner5KillRate = pct(winners5Killed, totals.totalWinners5);

  const netScore =
    junkRemovalRate != null && winner1KillRate != null
      ? Math.round((junkRemovalRate - winner1KillRate) * 10) / 10
      : null;

  let recommendation: FilterRecommendation;
  if (winner1KillRate != null && winner1KillRate > 15) {
    recommendation = 'REJECT_FILTER_TOO_AGGRESSIVE';
  } else if (
    junkRemovalRate != null && junkRemovalRate >= 10 &&
    winner1KillRate != null && winner1KillRate <= 15 &&
    observedRejected >= 10
  ) {
    recommendation = 'SHADOW_TEST_NEXT';
  } else if (observedRejected < 10) {
    recommendation = 'WATCH_ONLY';
  } else {
    recommendation = 'NO_EDGE';
  }

  return {
    filterName:         def.name,
    filterDesc:         def.desc,
    candidatesRejected,
    observedRejected,
    flatJunkRejected,
    dumpRejected,
    winners1Killed,
    winners3Killed,
    winners5Killed,
    totalObserved:      totals.totalObserved,
    totalFlatJunk:      totals.totalFlatJunk,
    totalWinners1:      totals.totalWinners1,
    totalWinners3:      totals.totalWinners3,
    totalWinners5:      totals.totalWinners5,
    junkRemovalRate,
    winner1KillRate,
    winner3KillRate,
    winner5KillRate,
    netScore,
    recommendation,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runShadowRejectFilterReport(
  options: ShadowRejectFilterOptions,
): ShadowRejectFilterResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const { byContract, filesRead, rowsRead } = readObsMap(options.observationPaths);
  const candidates = loadClassifiedCandidates(options.cyclePaths, byContract);

  const totalWinners1   = candidates.filter(c => isAnyWinner(c.outcome)).length;
  const totalWinners3   = candidates.filter(c => isWinner3(c.outcome)).length;
  const totalWinners5   = candidates.filter(c => c.outcome === 'WIN_5PCT').length;
  const totalFlatJunk   = candidates.filter(c => c.outcome === 'FLAT_JUNK').length;
  const totalDumps      = candidates.filter(c => c.outcome === 'DUMP').length;
  const unobservedCount = candidates.filter(c => c.outcome === 'UNOBSERVED').length;
  const observedCount   = candidates.length - unobservedCount;

  const totals = {
    totalObserved: observedCount,
    totalFlatJunk,
    totalWinners1,
    totalWinners3,
    totalWinners5,
  };

  const individualFilters = INDIVIDUAL_FILTERS.map(def => evaluateFilter(def, candidates, totals));
  const comboFilters      = COMBO_FILTERS.map(def => evaluateFilter(def, candidates, totals));

  const allFilters       = [...individualFilters, ...comboFilters];
  const shadowTestFilters = allFilters
    .filter(f => f.recommendation === 'SHADOW_TEST_NEXT')
    .map(f => `${f.filterName}: ${f.filterDesc}`);
  const tooAggressiveFilters = allFilters
    .filter(f => f.recommendation === 'REJECT_FILTER_TOO_AGGRESSIVE')
    .map(f => `${f.filterName}: ${f.filterDesc}`);

  const hasShadowTest    = shadowTestFilters.length > 0;
  const overallDecision  = hasShadowTest
    ? 'TEST_SHADOW_REJECT_FILTERS_ONLY'
    : 'HOLD_CURRENT_GATES';
  const decisionNote     = hasShadowTest
    ? 'Shadow test candidates found. Apply in paper-only shadow mode — do NOT wire into live or auto-paper gates.'
    : 'No filter shows sufficient signal. Continue collecting observations before proposing any gate change.';

  // Write JSONL — one row per candidate with rejection flags
  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });

  const rows = candidates.map(c => ({
    ...c,
    generatedAt,
    rejectedBy: {
      bubble_lt70: FILTER_BUBBLE_LT70(c),
      liq_lt10k:   FILTER_LIQ_LT10K(c),
      vlr_unknown: FILTER_VLR_UNKNOWN(c),
      age_gte10m:  FILTER_AGE_GTE10(c),
    },
  }));
  const content = rows.length > 0 ? rows.map(r => JSON.stringify(r)).join('\n') + '\n' : '';
  fs.writeFileSync(options.outPath, content, 'utf-8');

  return {
    generatedAt,
    candidatesAnalyzed: candidates.length,
    observedCandidates: observedCount,
    obsFilesRead:       filesRead,
    obsRowsRead:        rowsRead,
    totalFlatJunk,
    totalDumps,
    totalWinners1,
    totalWinners3,
    totalWinners5,
    unobservedCount,
    individualFilters,
    comboFilters,
    shadowTestFilters,
    tooAggressiveFilters,
    overallDecision,
    decisionNote,
    outPath:            options.outPath,
    rowsWritten:        rows.length,
    reportOnly:         true,
    readOnly:           true,
    tradingExecuted:    0,
    realTradingLocked:  true,
    paperOnly:          true,
  };
}

// ── Renderer helpers ──────────────────────────────────────────────────────────

function recLabel(r: FilterRecommendation): string {
  switch (r) {
    case 'SHADOW_TEST_NEXT':              return '✓ SHADOW_TEST_NEXT';
    case 'REJECT_FILTER_TOO_AGGRESSIVE':  return '✗ TOO_AGGRESSIVE';
    case 'WATCH_ONLY':                    return '~ WATCH_ONLY';
    case 'NO_EDGE':                       return '- NO_EDGE';
  }
}

function fmtRate(v: number | null): string {
  return v != null ? `${v}%` : 'n/a';
}

function renderFilterTable(filters: FilterResult[], lines: string[]): void {
  const SEP2 = '────────────────────────────────────────────────────────────────';
  lines.push('  filter                  rej  obs  junkRm%  win1Kill%  netScore  verdict');
  lines.push(`  ${SEP2}`);
  for (const f of filters) {
    const name    = f.filterName.padEnd(23);
    const rej     = String(f.candidatesRejected).padEnd(4);
    const obs     = String(f.observedRejected).padEnd(4);
    const junk    = fmtRate(f.junkRemovalRate).padEnd(8);
    const kill    = fmtRate(f.winner1KillRate).padEnd(10);
    const net     = f.netScore != null ? `${f.netScore >= 0 ? '+' : ''}${f.netScore}`.padEnd(9) : 'n/a'.padEnd(9);
    const verdict = recLabel(f.recommendation);
    lines.push(`  ${name} ${rej} ${obs} ${junk} ${kill} ${net} ${verdict}`);
  }
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderShadowRejectFilterReport(result: ShadowRejectFilterResult): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — SHADOW REJECT FILTER REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push('  DO NOT ENABLE REAL TRADING  |  DO NOT CHANGE PRODUCTION GATES');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Candidates analyzed   : ${result.candidatesAnalyzed}`);
  lines.push(`  Observed candidates   : ${result.observedCandidates}`);
  lines.push(`  Obs files read        : ${result.obsFilesRead}`);
  lines.push(`  Obs rows read         : ${result.obsRowsRead}`);
  lines.push('');
  lines.push(`  Total flat junk       : ${result.totalFlatJunk}`);
  lines.push(`  Total dumps           : ${result.totalDumps}`);
  lines.push(`  Total winners >= +1%  : ${result.totalWinners1}`);
  lines.push(`  Total winners >= +3%  : ${result.totalWinners3}`);
  lines.push(`  Total winners >= +5%  : ${result.totalWinners5}`);
  lines.push(`  Unobserved            : ${result.unobservedCount}`);
  lines.push(`  Generated at          : ${result.generatedAt}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  INDIVIDUAL FILTER RESULTS');
  lines.push(`  ${SEP2}`, '');
  renderFilterTable(result.individualFilters, lines);
  lines.push('');
  lines.push('  junkRm% = flatJunk removed / total flatJunk');
  lines.push('  win1Kill% = winners(>=1%) killed / total winners(>=1%)');
  lines.push('  netScore = junkRm% - win1Kill%');
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  COMBO FILTER RESULTS (OR combinations)');
  lines.push(`  ${SEP2}`, '');
  renderFilterTable(result.comboFilters, lines);
  lines.push('');

  // Per-filter detail
  const allFilters = [...result.individualFilters, ...result.comboFilters];
  for (const f of allFilters) {
    lines.push(`  ${SEP2}`);
    lines.push(`  ${f.filterName.toUpperCase()}: ${f.filterDesc}`);
    lines.push(`  ${SEP2}`);
    lines.push(`  Candidates rejected   : ${f.candidatesRejected}`);
    lines.push(`  Observed rejected     : ${f.observedRejected}`);
    lines.push(`  Flat junk removed     : ${f.flatJunkRejected} / ${f.totalFlatJunk} (${fmtRate(f.junkRemovalRate)})`);
    lines.push(`  Dumps removed         : ${f.dumpRejected}`);
    lines.push(`  Winners>=1% killed    : ${f.winners1Killed} / ${f.totalWinners1} (${fmtRate(f.winner1KillRate)})`);
    lines.push(`  Winners>=3% killed    : ${f.winners3Killed} / ${f.totalWinners3} (${fmtRate(f.winner3KillRate)})`);
    lines.push(`  Winners>=5% killed    : ${f.winners5Killed} / ${f.totalWinners5} (${fmtRate(f.winner5KillRate)})`);
    lines.push(`  Net score             : ${f.netScore != null ? (f.netScore >= 0 ? '+' : '') + f.netScore : 'n/a'}`);
    lines.push(`  Recommendation        : ${recLabel(f.recommendation)}`);
    lines.push('');
  }

  if (result.shadowTestFilters.length > 0) {
    lines.push(`  ${SEP2}`);
    lines.push('  RECOMMENDED SHADOW TEST FILTERS');
    lines.push(`  ${SEP2}`, '');
    for (const f of result.shadowTestFilters) lines.push(`  * ${f}`);
    lines.push('');
    lines.push('  These filters remove meaningful flat junk while preserving most winners.');
    lines.push('  Apply in paper-only shadow mode ONLY. Do NOT wire into live or auto-paper gates.');
    lines.push('');
  }

  if (result.tooAggressiveFilters.length > 0) {
    lines.push(`  ${SEP2}`);
    lines.push('  FILTERS NOT SAFE ENOUGH');
    lines.push(`  ${SEP2}`, '');
    for (const f of result.tooAggressiveFilters) lines.push(`  ✗ ${f}`);
    lines.push('');
    lines.push('  Winner kill rate > 15% — do not apply.');
    lines.push('');
  }

  lines.push(`  ${SEP2}`);
  lines.push('  DECISION');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  ${result.overallDecision}`);
  lines.push(`  ${result.decisionNote}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * Do NOT change production gate logic.');
  lines.push('  * Do NOT change paper decision policy.');
  lines.push('  * Do NOT wire reject filters into autopilot.');
  lines.push('  * This is report-only analysis.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(SEP, '');
  return lines.join('\n');
}
