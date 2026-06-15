import * as fs from 'fs';
import * as path from 'path';
import { extractRipperContract, extractRipperPriceChangePct } from './ripperExtractors';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutcomeClass = 'WIN_5PCT' | 'WIN_3PCT' | 'WIN_1PCT' | 'DUMP' | 'FLAT_JUNK' | 'UNOBSERVED';

export interface DimRow {
  dimension:    string;
  value:        string;
  total:        number;
  winners:      number;
  flatJunk:     number;
  dumps:        number;
  unobserved:   number;
  observed:     number;
  winRate:      number | null;
  flatJunkRate: number | null;
  dumpRate:     number | null;
}

export interface RejectFilter {
  dimension:      string;
  value:          string;
  winnersKept:    number;
  winnersTotal:   number;
  junkRemoved:    number;
  junkTotal:      number;
  keepRate:       number;
  junkRemoveRate: number;
  verdict:        'STRONG' | 'WEAK' | 'INSUFFICIENT_DATA';
  note:           string;
}

export interface FlatJunkReducerResult {
  generatedAt:        string;
  candidatesAnalyzed: number;
  observedCandidates: number;
  obsFilesRead:       number;
  obsRowsRead:        number;
  win5Count:          number;
  win3Count:          number;
  win1Count:          number;
  flatJunkCount:      number;
  dumpCount:          number;
  unobservedCount:    number;
  winnerCount:        number;
  winRate:            number | null;
  flatJunkRate:       number | null;
  dumpRate:           number | null;
  dimensionBreakdowns: DimRow[];
  winnerProfile:      string[];
  flatJunkProfile:    string[];
  rejectFilters:      RejectFilter[];
  gateDecision:       'HOLD_CURRENT_GATES' | 'TEST_NEXT_FILTER';
  gateNote:           string;
  outPath:            string;
  rowsWritten:        number;
  reportOnly:         true;
  readOnly:           true;
  tradingExecuted:    0;
  realTradingLocked:  true;
  paperOnly:          true;
}

export interface FlatJunkReducerOptions {
  cyclePaths:       string[];
  observationPaths: string[];
  outPath:          string;
  nowMs?:           number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface RawCandidate {
  contract:            string;
  symbol:              string | null;
  capturedAt:          string;
  clusterRisk:         string;
  clusterConfidence:   string | null;
  bubbleMapsScore:     number | null;
  ripperScore:         number | null;
  launchAgeBucket:     string | null;
  ageMinutes:          number | null;
  entryDecision:       string | null;
  sourceKind:          string | null;
  entryPriceChangePct: number | null;
  liquidityUsd:        number | null;
  volumeUsd:           number | null;
  volumeLiquidityRatio: number | null;
  liquidityChangePct:  number | null;
  warnings:            string[];
}

interface CandidateWithOutcome extends RawCandidate {
  outcome:               OutcomeClass;
  outcomePct:            number | null;
  scoreBand:             string;
  ageBucket:             string;
  liquidityBucket:       string;
  volumeBucket:          string;
  vlrBucket:             string;
  entryPctBucket:        string;
  bubbleMapsScoreBucket: string;
  warningCount:          number;
}

interface ObsEntry {
  capturedAt:     string;
  priceChangePct: number | null;
}

// ── Bucketing helpers ─────────────────────────────────────────────────────────

function toScoreBand(score: number | null): string {
  if (score == null) return 'unknown';
  if (score >= 100) return '100';
  if (score >= 90)  return '90-99';
  if (score >= 80)  return '80-89';
  if (score >= 70)  return '70-79';
  return 'below70';
}

function toAgeBucket(age: number | null): string {
  if (age == null) return 'unknown';
  if (age < 2)     return '<2m';
  if (age < 5)     return '2-5m';
  if (age < 10)    return '5-10m';
  return '10m+';
}

function toLiquidityBucket(liq: number | null): string {
  if (liq == null)      return 'unknown';
  if (liq < 10_000)     return '<$10k';
  if (liq < 25_000)     return '$10k-25k';
  if (liq < 50_000)     return '$25k-50k';
  return '$50k+';
}

function toVolumeBucket(vol: number | null): string {
  if (vol == null)    return 'unknown';
  if (vol < 5_000)    return '<$5k';
  if (vol < 15_000)   return '$5k-15k';
  if (vol < 30_000)   return '$15k-30k';
  return '$30k+';
}

function toVlrBucket(vlr: number | null): string {
  if (vlr == null) return 'unknown';
  if (vlr < 0.3)   return '<0.3';
  if (vlr < 0.7)   return '0.3-0.7';
  if (vlr < 1.5)   return '0.7-1.5';
  return '1.5+';
}

function toEntryPctBucket(pct: number | null): string {
  if (pct == null) return 'unknown';
  if (pct < 5)     return '<5%';
  if (pct < 20)    return '5-20%';
  if (pct < 50)    return '20-50%';
  return '50%+';
}

function toBubbleMapsScoreBucket(score: number | null): string {
  if (score == null) return 'unknown';
  if (score < 70)    return '<70';
  if (score < 85)    return '70-84';
  if (score < 95)    return '85-94';
  return '95+';
}

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

// ── Classification ────────────────────────────────────────────────────────────

function classifyOutcome(pct: number | null): OutcomeClass {
  if (pct == null) return 'UNOBSERVED';
  if (pct >= 5)    return 'WIN_5PCT';
  if (pct >= 3)    return 'WIN_3PCT';
  if (pct >= 1)    return 'WIN_1PCT';
  if (pct <= -3)   return 'DUMP';
  return 'FLAT_JUNK';
}

function isWinner(o: OutcomeClass): boolean {
  return o === 'WIN_1PCT' || o === 'WIN_3PCT' || o === 'WIN_5PCT';
}

// ── Data readers ──────────────────────────────────────────────────────────────

function readApprovedCandidates(cyclePaths: string[]): RawCandidate[] {
  const seen   = new Set<string>();
  const result: RawCandidate[] = [];
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

        const cr = raw?.['clusterRisk'] ?? ri?.['clusterRisk'] ?? 'UNKNOWN';
        const clusterRisk = (cr === 'CLEAN' || cr === 'WATCH' || cr === 'RISKY')
          ? (cr as string)
          : 'UNKNOWN';

        result.push({
          contract,
          symbol:              typeof ns?.['symbol'] === 'string'
                                 ? (ns['symbol'] as string)
                                 : (typeof f['symbol'] === 'string' ? (f['symbol'] as string) : null),
          capturedAt,
          clusterRisk,
          clusterConfidence:   typeof raw?.['clusterConfidence'] === 'string'
                                 ? (raw['clusterConfidence'] as string) : null,
          bubbleMapsScore:     parseBubbleMapsScore(raw?.['clusterNotes']),
          ripperScore:         typeof f['ripperScore'] === 'number'     ? (f['ripperScore']     as number) : null,
          launchAgeBucket:     typeof f['launchAgeBucket'] === 'string' ? (f['launchAgeBucket'] as string) : null,
          ageMinutes:          typeof f['ageMinutes'] === 'number'      ? (f['ageMinutes']      as number) : null,
          entryDecision:       typeof f['entryDecision'] === 'string'   ? (f['entryDecision']   as string) : null,
          sourceKind:          typeof ns?.['sourceKind'] === 'string'   ? (ns['sourceKind']     as string) : null,
          entryPriceChangePct: extractRipperPriceChangePct(f),
          liquidityUsd:        typeof ns?.['liquidityUsd'] === 'number' ? (ns['liquidityUsd']   as number) : null,
          volumeUsd:           typeof ns?.['volumeUsd'] === 'number'    ? (ns['volumeUsd']      as number) : null,
          volumeLiquidityRatio: typeof ns?.['volumeLiquidityRatio'] === 'number'
                                 ? (ns['volumeLiquidityRatio'] as number)
                                 : (typeof ri?.['volumeLiquidityRatio'] === 'number'
                                     ? (ri['volumeLiquidityRatio'] as number) : null),
          liquidityChangePct:  typeof ns?.['liquidityChangePct'] === 'number'
                                 ? (ns['liquidityChangePct'] as number) : null,
          warnings:            Array.isArray(f['warnings']) ? (f['warnings'] as string[]) : [],
        });
      } catch { /* skip */ }
    }
  }
  return result;
}

function buildObsMap(paths: string[]): { byContract: Map<string, ObsEntry[]>; filesRead: number; rowsRead: number } {
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
        const pct  = extractRipperPriceChangePct(f);
        const list = map.get(contract) ?? [];
        list.push({ capturedAt, priceChangePct: pct });
        map.set(contract, list);
      } catch { /* skip */ }
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  return { byContract: map, filesRead, rowsRead };
}

// ── Breakdown computation ─────────────────────────────────────────────────────

type DimGetter = (c: CandidateWithOutcome) => string;

function computeDimBreakdown(
  candidates: CandidateWithOutcome[],
  getDimValue: DimGetter,
  dimensionName: string,
): DimRow[] {
  const buckets = new Map<string, { total: number; winners: number; flatJunk: number; dumps: number; unobserved: number }>();
  for (const c of candidates) {
    const v = getDimValue(c);
    const b = buckets.get(v) ?? { total: 0, winners: 0, flatJunk: 0, dumps: 0, unobserved: 0 };
    b.total++;
    if (isWinner(c.outcome)) b.winners++;
    else if (c.outcome === 'FLAT_JUNK') b.flatJunk++;
    else if (c.outcome === 'DUMP') b.dumps++;
    else b.unobserved++;
    buckets.set(v, b);
  }
  return [...buckets.entries()]
    .map(([value, b]) => {
      const observed = b.winners + b.flatJunk + b.dumps;
      return {
        dimension:    dimensionName,
        value,
        total:        b.total,
        winners:      b.winners,
        flatJunk:     b.flatJunk,
        dumps:        b.dumps,
        unobserved:   b.unobserved,
        observed,
        winRate:      observed > 0 ? Math.round((b.winners  / observed) * 1000) / 10 : null,
        flatJunkRate: observed > 0 ? Math.round((b.flatJunk / observed) * 1000) / 10 : null,
        dumpRate:     observed > 0 ? Math.round((b.dumps    / observed) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => b.total - a.total);
}

// ── Reject filter derivation ──────────────────────────────────────────────────

function deriveRejectFilters(
  candidates:       CandidateWithOutcome[],
  dimDefs:          Array<[string, DimGetter]>,
  winnersAll:       CandidateWithOutcome[],
  junkAll:          CandidateWithOutcome[],
  overallWinRate:   number,
): RejectFilter[] {
  if (winnersAll.length === 0 || junkAll.length === 0) return [];
  const filters: RejectFilter[] = [];

  for (const [dimName, getter] of dimDefs) {
    const values = new Set(candidates.map(getter));
    for (const v of values) {
      const subset         = candidates.filter(c => getter(c) === v);
      // Skip if this is the only value — removing it removes everything
      if (subset.length >= candidates.length * 0.9) continue;

      const subsetWinners  = subset.filter(c => isWinner(c.outcome));
      const subsetJunk     = subset.filter(c => c.outcome === 'FLAT_JUNK');
      const subsetObserved = subset.filter(c => c.outcome !== 'UNOBSERVED').length;

      if (subsetJunk.length < 5) continue;

      const winnersKept    = winnersAll.length - subsetWinners.length;
      const junkRemoved    = subsetJunk.length;
      const keepRate       = Math.round((winnersKept    / winnersAll.length) * 1000) / 10;
      const junkRemoveRate = Math.round((junkRemoved    / junkAll.length)    * 1000) / 10;
      const subsetWinRate  = subsetObserved > 0 ? subsetWinners.length / subsetObserved : 0;

      let verdict: RejectFilter['verdict'];
      if (subsetObserved < 10) {
        verdict = 'INSUFFICIENT_DATA';
      } else if (keepRate >= 85 && junkRemoveRate >= 10 && subsetWinRate < overallWinRate * 0.7) {
        verdict = 'STRONG';
      } else if (junkRemoveRate >= 5) {
        verdict = 'WEAK';
      } else {
        continue;
      }

      filters.push({
        dimension:      dimName,
        value:          v,
        winnersKept,
        winnersTotal:   winnersAll.length,
        junkRemoved,
        junkTotal:      junkAll.length,
        keepRate,
        junkRemoveRate,
        verdict,
        note: `Reject ${dimName}=${v}: keeps ${keepRate}% winners, removes ${junkRemoveRate}% flat junk`,
      });
    }
  }

  return filters.sort((a, b) => {
    const score = (f: RejectFilter) =>
      (f.verdict === 'STRONG' ? 10000 : f.verdict === 'WEAK' ? 1000 : 0) + f.junkRemoveRate;
    return score(b) - score(a);
  });
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runFlatJunkReducerReport(options: FlatJunkReducerOptions): FlatJunkReducerResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const rawCandidates = readApprovedCandidates(options.cyclePaths);
  const { byContract, filesRead, rowsRead } = buildObsMap(options.observationPaths);

  const candidates: CandidateWithOutcome[] = rawCandidates.map(c => {
    const obs    = (byContract.get(c.contract) ?? [])
      .find(o => o.capturedAt >= c.capturedAt && o.priceChangePct != null);
    const pct    = obs?.priceChangePct ?? null;
    return {
      ...c,
      outcome:               classifyOutcome(pct),
      outcomePct:            pct,
      scoreBand:             toScoreBand(c.ripperScore),
      ageBucket:             toAgeBucket(c.ageMinutes),
      liquidityBucket:       toLiquidityBucket(c.liquidityUsd),
      volumeBucket:          toVolumeBucket(c.volumeUsd),
      vlrBucket:             toVlrBucket(c.volumeLiquidityRatio),
      entryPctBucket:        toEntryPctBucket(c.entryPriceChangePct),
      bubbleMapsScoreBucket: toBubbleMapsScoreBucket(c.bubbleMapsScore),
      warningCount:          c.warnings.length,
    };
  });

  const win5Count       = candidates.filter(c => c.outcome === 'WIN_5PCT').length;
  const win3Count       = candidates.filter(c => c.outcome === 'WIN_3PCT').length;
  const win1Count       = candidates.filter(c => c.outcome === 'WIN_1PCT').length;
  const flatJunkCount   = candidates.filter(c => c.outcome === 'FLAT_JUNK').length;
  const dumpCount       = candidates.filter(c => c.outcome === 'DUMP').length;
  const unobservedCount = candidates.filter(c => c.outcome === 'UNOBSERVED').length;
  const winnerCount     = win5Count + win3Count + win1Count;
  const observedCount   = winnerCount + flatJunkCount + dumpCount;

  const pct = (n: number): number | null =>
    observedCount > 0 ? Math.round((n / observedCount) * 1000) / 10 : null;

  const winRate      = pct(winnerCount);
  const flatJunkRate = pct(flatJunkCount);
  const dumpRate     = pct(dumpCount);

  const dimDefs: Array<[string, DimGetter]> = [
    ['clusterRisk',         c => c.clusterRisk],
    ['clusterConfidence',   c => c.clusterConfidence ?? 'unknown'],
    ['scoreBand',           c => c.scoreBand],
    ['launchAgeBucket',     c => c.launchAgeBucket ?? 'unknown'],
    ['ageBucket',           c => c.ageBucket],
    ['entryDecision',       c => c.entryDecision ?? 'unknown'],
    ['sourceKind',          c => c.sourceKind ?? 'unknown'],
    ['entryPctBucket',      c => c.entryPctBucket],
    ['liquidityBucket',     c => c.liquidityBucket],
    ['volumeBucket',        c => c.volumeBucket],
    ['vlrBucket',           c => c.vlrBucket],
    ['bubbleMapsScoreBucket', c => c.bubbleMapsScoreBucket],
    ['warningCount',        c => String(c.warningCount)],
  ];

  const dimensionBreakdowns: DimRow[] = dimDefs
    .flatMap(([name, getter]) => computeDimBreakdown(candidates, getter, name))
    .filter(r => r.total > 0);

  const winnersAll = candidates.filter(c => isWinner(c.outcome));
  const junkAll    = candidates.filter(c => c.outcome === 'FLAT_JUNK');
  const overallWinRateDecimal = observedCount > 0 ? winnerCount / observedCount : 0;

  // Winner profile: dimension=value buckets with above-average win rate
  const winnerProfile = dimensionBreakdowns
    .filter(r => r.observed >= 5 && r.winRate != null && winRate != null && r.winRate > winRate)
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))
    .slice(0, 10)
    .map(r => `${r.dimension}=${r.value}: win ${r.winRate}% (${r.winners}/${r.observed} obs)`);

  if (winnerProfile.length === 0) winnerProfile.push('INSUFFICIENT_DATA — need more observed candidates');

  // Flat junk profile: dimension=value buckets with above-average flat junk rate
  const flatJunkProfile = dimensionBreakdowns
    .filter(r => r.observed >= 5 && r.flatJunkRate != null && flatJunkRate != null && r.flatJunkRate > flatJunkRate)
    .sort((a, b) => (b.flatJunkRate ?? 0) - (a.flatJunkRate ?? 0))
    .slice(0, 10)
    .map(r => `${r.dimension}=${r.value}: flat junk ${r.flatJunkRate}% (${r.flatJunk}/${r.observed} obs)`);

  if (flatJunkProfile.length === 0) flatJunkProfile.push('INSUFFICIENT_DATA — no clear flat junk signal');

  const rejectFilters = deriveRejectFilters(
    candidates, dimDefs, winnersAll, junkAll, overallWinRateDecimal,
  ).slice(0, 20);

  const hasStrong   = rejectFilters.some(f => f.verdict === 'STRONG');
  const gateDecision = hasStrong ? 'TEST_NEXT_FILTER' : 'HOLD_CURRENT_GATES';
  const gateNote     = hasStrong
    ? 'Strong filter candidate found. Propose for shadow test in next cycle — do not change live gates yet.'
    : 'No filter shows sufficient signal to propose a gate change. Continue collecting observations.';

  // Write JSONL output
  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  const rows    = candidates.map(c => ({ ...c, generatedAt }));
  const content = rows.length > 0 ? rows.map(r => JSON.stringify(r)).join('\n') + '\n' : '';
  fs.writeFileSync(options.outPath, content, 'utf-8');

  return {
    generatedAt,
    candidatesAnalyzed: candidates.length,
    observedCandidates: observedCount,
    obsFilesRead:       filesRead,
    obsRowsRead:        rowsRead,
    win5Count,
    win3Count,
    win1Count,
    flatJunkCount,
    dumpCount,
    unobservedCount,
    winnerCount,
    winRate,
    flatJunkRate,
    dumpRate,
    dimensionBreakdowns,
    winnerProfile,
    flatJunkProfile,
    rejectFilters,
    gateDecision,
    gateNote,
    outPath:            options.outPath,
    rowsWritten:        rows.length,
    reportOnly:         true,
    readOnly:           true,
    tradingExecuted:    0,
    realTradingLocked:  true,
    paperOnly:          true,
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderFlatJunkReducerReport(result: FlatJunkReducerResult): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — FLAT JUNK REDUCER REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push('  DO NOT ENABLE REAL TRADING  |  DO NOT CHANGE APPROVAL GATES');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Candidates analyzed   : ${result.candidatesAnalyzed}`);
  lines.push(`  Observed candidates   : ${result.observedCandidates}`);
  lines.push(`  Obs files read        : ${result.obsFilesRead}`);
  lines.push(`  Obs rows read         : ${result.obsRowsRead}`);
  lines.push('');
  const fmt = (n: number, r: number | null) => `${n} (${r != null ? r + '%' : 'n/a'} of observed)`;
  lines.push(`  Winners  >= +1%       : ${fmt(result.winnerCount, result.winRate)}`);
  lines.push(`    >= +1% only         : ${result.win1Count}`);
  lines.push(`    >= +3% only         : ${result.win3Count}`);
  lines.push(`    >= +5%              : ${result.win5Count}`);
  lines.push(`  Flat junk (> -3%, < +1%): ${fmt(result.flatJunkCount, result.flatJunkRate)}`);
  lines.push(`  Dump (<= -3%)         : ${fmt(result.dumpCount, result.dumpRate)}`);
  lines.push(`  Unobserved            : ${result.unobservedCount}`);
  lines.push(`  Generated at          : ${result.generatedAt}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  WINNER PROFILE  (dimensions with above-average win rate)');
  lines.push(`  ${SEP2}`, '');
  for (const p of result.winnerProfile) lines.push(`  * ${p}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  FLAT JUNK PROFILE  (dimensions with above-average flat junk rate)');
  lines.push(`  ${SEP2}`, '');
  for (const p of result.flatJunkProfile) lines.push(`  * ${p}`);
  lines.push('');

  if (result.dimensionBreakdowns.length > 0) {
    const dims = [...new Set(result.dimensionBreakdowns.map(r => r.dimension))];
    for (const dim of dims) {
      const rows = result.dimensionBreakdowns.filter(r => r.dimension === dim);
      if (rows.length === 0) continue;
      lines.push(`  ${SEP2}`);
      lines.push(`  ${dim.toUpperCase()}`);
      lines.push(`  ${SEP2}`);
      lines.push('  value                    total  obs  win%  junk%  dump%');
      for (const r of rows) {
        const val  = r.value.padEnd(24);
        const tot  = String(r.total).padEnd(6);
        const obs  = String(r.observed).padEnd(4);
        const win  = r.winRate      != null ? `${r.winRate}%`.padEnd(5)      : 'n/a  ';
        const junk = r.flatJunkRate != null ? `${r.flatJunkRate}%`.padEnd(6)  : 'n/a   ';
        const dump = r.dumpRate     != null ? `${r.dumpRate}%`                : 'n/a';
        lines.push(`  ${val} ${tot} ${obs} ${win} ${junk} ${dump}`);
      }
      lines.push('');
    }
  }

  if (result.rejectFilters.length > 0) {
    lines.push(`  ${SEP2}`);
    lines.push('  REJECT CANDIDATES TO TEST NEXT  (report-only, do not apply)');
    lines.push(`  ${SEP2}`, '');
    for (const f of result.rejectFilters) {
      lines.push(`  [${f.verdict}] ${f.note}`);
      lines.push(`    keeps ${f.winnersKept}/${f.winnersTotal} winners (${f.keepRate}%), removes ${f.junkRemoved}/${f.junkTotal} flat junk (${f.junkRemoveRate}%)`);
    }
    lines.push('');
  }

  lines.push(`  ${SEP2}`);
  lines.push('  GATE DECISION');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Decision : ${result.gateDecision}`);
  lines.push(`  Note     : ${result.gateNote}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  * This report does NOT recommend real trading.');
  lines.push('  * Do NOT modify decision policy or gate thresholds.');
  lines.push('  * Proposed filters are for future shadow testing only.');
  lines.push('  * DO NOT ENABLE REAL TRADING');
  lines.push('');
  lines.push('  reportOnly=true  readOnly=true  tradingExecuted=0  realTradingLocked=true  paperOnly=true');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
  lines.push(SEP, '');
  return lines.join('\n');
}
