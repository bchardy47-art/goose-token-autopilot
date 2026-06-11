import * as fs from 'fs';
import {
  runOutcomeTracker,
  type OutcomeTrackerOptions,
  type OutcomeCandidate,
} from './outcomeTracker';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import { extractReadinessFields, classifyReadinessLevel } from './autonomyReadinessAudit';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function toPositiveNum(v: unknown): number | null {
  const n = toNum(v);
  return n !== null && n > 0 ? n : null;
}

function avg(values: (number | null | undefined)[]): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ── Extended record ───────────────────────────────────────────────────────────

export interface AutopsyRecord extends OutcomeCandidate {
  holderConcentrationStatus: string;
  bubbleMapsScore:           number | null;
  clusterNotes:              string[];
  entryVolumeUsd:            number | null;
  volumeToLiquidityRatio:    number | null;
  liquidityChangePct:        number | null;
  priceChangePctCapture:     number | null;
  slippageRisk:              string;
  estimatedSlippagePct:      number | null;
  routeFound:                boolean | null;
  liquidityTradable:         string;
}

// ── Comparison averages ───────────────────────────────────────────────────────

export interface ComparisonMetrics {
  avgTopHolderPercent:       number | null;
  avgEntryLiquidityUsd:      number | null;
  avgEntryVolumeUsd:         number | null;
  avgVolumeToLiquidityRatio: number | null;
  avgLiquidityChangePct:     number | null;
  avgPriceChangePctCapture:  number | null;
  avgEstimatedSlippagePct:   number | null;
  avgBubbleMapsScore:        number | null;
}

// ── Result ────────────────────────────────────────────────────────────────────

export interface OutcomeAutopsyResult {
  inputPath:        string;
  inputMissing:     boolean;
  generatedAt:      string;
  totalCandidates:  number;
  winnerCount:      number;
  loserCount:       number;
  flatCount:        number;
  unknownCount:     number;
  winRate:          number | null;
  averageReturnPct: number | null;
  bestCandidate:    AutopsyRecord | null;
  worstCandidate:   AutopsyRecord | null;
  winnerMetrics:    ComparisonMetrics;
  loserMetrics:     ComparisonMetrics;
  records:          AutopsyRecord[];
  tradingExecuted:  0;
  noRealTradeSent:  true;
  paperOnly:        true;
  readOnly:         true;
}

export interface OutcomeAutopsyOptions extends OutcomeTrackerOptions {}

// ── Field enrichment ──────────────────────────────────────────────────────────

function enrichFromFixture(fixture: LiveRipperFixture, candidate: OutcomeCandidate): AutopsyRecord {
  const raw      = (fixture.raw as Record<string, unknown> | undefined) ?? {};
  const ri       = fixture.ripperInput as Record<string, unknown> | null;
  const rawEntry = raw['entry'] as Record<string, unknown> | undefined;
  const rawFinal = raw['final'] as Record<string, unknown> | undefined;

  const holderConcentrationStatus = (raw['holderConcentrationStatus'] as string | undefined) ?? 'UNKNOWN';

  const clusterRawMetrics = raw['clusterRawMetrics'] as Record<string, unknown> | undefined;
  const bubbleMapsScore = toNum(clusterRawMetrics?.['decentralisationScore']);

  const rawNotes = raw['clusterNotes'];
  const clusterNotes: string[] = Array.isArray(rawNotes)
    ? rawNotes.filter((n): n is string => typeof n === 'string')
    : [];

  const entryVolumeUsd = toPositiveNum(rawEntry?.['volumeUsd']);

  // Vol/liq: prefer computed from entry snapshot, fall back to ripperInput ratio
  const volumeToLiquidityRatio =
    entryVolumeUsd !== null && candidate.liquidityUsd !== null && candidate.liquidityUsd > 0
      ? entryVolumeUsd / candidate.liquidityUsd
      : toPositiveNum(ri?.['volumeLiquidityRatio']);

  // Liquidity change during capture window (entry → final)
  const entryLiq = toPositiveNum(rawEntry?.['liquidityUsd']);
  const finalLiq = toPositiveNum(rawFinal?.['liquidityUsd']);
  const liquidityChangePct =
    entryLiq !== null && finalLiq !== null
      ? ((finalLiq - entryLiq) / entryLiq) * 100
      : null;

  // Price change during capture window (entry → final)
  const entryPrice = toPositiveNum(rawEntry?.['priceUsd']);
  const finalPrice = toPositiveNum(rawFinal?.['priceUsd']);
  const priceChangePctCapture =
    entryPrice !== null && finalPrice !== null
      ? ((finalPrice - entryPrice) / entryPrice) * 100
      : null;

  const slippageRisk = (raw['slippageRisk'] as string | undefined) ?? 'UNKNOWN';
  const estimatedSlippagePct = toNum(raw['estimatedSlippagePct']);
  const routeFound = raw['routeFound'] === true ? true : raw['routeFound'] === false ? false : null;
  const liquidityTradable = (raw['liquidityTradable'] as string | undefined) ?? 'UNKNOWN';

  return {
    ...candidate,
    holderConcentrationStatus,
    bubbleMapsScore,
    clusterNotes,
    entryVolumeUsd,
    volumeToLiquidityRatio: volumeToLiquidityRatio ?? null,
    liquidityChangePct,
    priceChangePctCapture,
    slippageRisk,
    estimatedSlippagePct,
    routeFound,
    liquidityTradable,
  };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

function emptyMetrics(): ComparisonMetrics {
  return {
    avgTopHolderPercent:       null,
    avgEntryLiquidityUsd:      null,
    avgEntryVolumeUsd:         null,
    avgVolumeToLiquidityRatio: null,
    avgLiquidityChangePct:     null,
    avgPriceChangePctCapture:  null,
    avgEstimatedSlippagePct:   null,
    avgBubbleMapsScore:        null,
  };
}

function buildMetrics(group: AutopsyRecord[]): ComparisonMetrics {
  return {
    avgTopHolderPercent:       avg(group.map(r => r.topHolderPercent)),
    avgEntryLiquidityUsd:      avg(group.map(r => r.liquidityUsd)),
    avgEntryVolumeUsd:         avg(group.map(r => r.entryVolumeUsd)),
    avgVolumeToLiquidityRatio: avg(group.map(r => r.volumeToLiquidityRatio)),
    avgLiquidityChangePct:     avg(group.map(r => r.liquidityChangePct)),
    avgPriceChangePctCapture:  avg(group.map(r => r.priceChangePctCapture)),
    avgEstimatedSlippagePct:   avg(group.map(r => r.estimatedSlippagePct)),
    avgBubbleMapsScore:        avg(group.map(r => r.bubbleMapsScore)),
  };
}

export async function runOutcomeAutopsy(
  options: OutcomeAutopsyOptions = {},
): Promise<OutcomeAutopsyResult> {
  const inputPath   = options.inputPath   ?? DEFAULT_INPUT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const baseEmpty: OutcomeAutopsyResult = {
    inputPath, inputMissing: true, generatedAt,
    totalCandidates: 0, winnerCount: 0, loserCount: 0, flatCount: 0, unknownCount: 0,
    winRate: null, averageReturnPct: null, bestCandidate: null, worstCandidate: null,
    winnerMetrics: emptyMetrics(), loserMetrics: emptyMetrics(),
    records: [],
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };

  // 1. Run outcome tracker for prices/returns
  const trackerResult = await runOutcomeTracker({ inputPath, generatedAt, fetch: options.fetch });
  if (trackerResult.inputMissing) return baseEmpty;

  // 2. Re-read fixtures to enrich candidates with extra fields
  let fixtures: LiveRipperFixture[];
  try {
    fixtures = readFixturesFromJsonl(inputPath);
  } catch {
    return baseEmpty;
  }

  // Build contract → earliest FUTURE_AUTONOMY_CANDIDATE fixture map
  const fixtureByContract = new Map<string, LiveRipperFixture>();
  for (const fixture of fixtures) {
    const fields = extractReadinessFields(fixture);
    const { level } = classifyReadinessLevel(fields);
    if (level !== 'FUTURE_AUTONOMY_CANDIDATE') continue;
    const raw = fixture.raw as Record<string, unknown> | undefined;
    const ri  = fixture.ripperInput as Record<string, unknown> | null;
    const entryObj = raw?.['entry'] as Record<string, unknown> | undefined;
    const contract =
      (entryObj?.['contract'] as string | undefined) ??
      (raw?.['contract']     as string | undefined) ??
      (ri?.['contract']      as string | undefined) ??
      null;
    if (!contract) continue;
    const existing = fixtureByContract.get(contract);
    if (!existing || fixture.capturedAt < existing.capturedAt) {
      fixtureByContract.set(contract, fixture);
    }
  }

  // 3. Merge tracker candidates with fixture enrichment
  const records: AutopsyRecord[] = trackerResult.candidates.map(candidate => {
    const fixture = fixtureByContract.get(candidate.contract);
    if (!fixture) {
      return {
        ...candidate,
        holderConcentrationStatus: 'UNKNOWN', bubbleMapsScore: null, clusterNotes: [],
        entryVolumeUsd: null, volumeToLiquidityRatio: null, liquidityChangePct: null,
        priceChangePctCapture: null, slippageRisk: 'UNKNOWN', estimatedSlippagePct: null,
        routeFound: null, liquidityTradable: 'UNKNOWN',
      };
    }
    return enrichFromFixture(fixture, candidate);
  });

  // 4. Summary counts
  let winnerCount = 0, loserCount = 0, flatCount = 0, unknownCount = 0;
  let bestCandidate: AutopsyRecord | null = null;
  let worstCandidate: AutopsyRecord | null = null;

  for (const r of records) {
    if (r.status === 'RIPPED' || r.status === 'MOVED') winnerCount++;
    else if (r.status === 'DUMPED') loserCount++;
    else if (r.status === 'FLAT') flatCount++;
    else unknownCount++;

    if (r.currentReturnPct !== null) {
      if (bestCandidate === null || r.currentReturnPct > (bestCandidate.currentReturnPct ?? -Infinity)) {
        bestCandidate = r;
      }
      if (worstCandidate === null || r.currentReturnPct < (worstCandidate.currentReturnPct ?? Infinity)) {
        worstCandidate = r;
      }
    }
  }

  const winRate = (winnerCount + loserCount) > 0
    ? winnerCount / (winnerCount + loserCount)
    : null;

  const returnsWithValues = records
    .map(r => r.currentReturnPct)
    .filter((v): v is number => v !== null);
  const averageReturnPct = returnsWithValues.length > 0
    ? returnsWithValues.reduce((a, b) => a + b, 0) / returnsWithValues.length
    : null;

  const winners = records.filter(r => r.status === 'RIPPED' || r.status === 'MOVED');
  const losers  = records.filter(r => r.status === 'DUMPED');

  return {
    inputPath, inputMissing: false, generatedAt,
    totalCandidates: records.length,
    winnerCount, loserCount, flatCount, unknownCount,
    winRate, averageReturnPct,
    bestCandidate, worstCandidate,
    winnerMetrics: buildMetrics(winners),
    loserMetrics:  buildMetrics(losers),
    records,
    tradingExecuted: 0, noRealTradeSent: true, paperOnly: true, readOnly: true,
  };
}

// ── Renderer helpers ──────────────────────────────────────────────────────────

function fmtPct(n: number | null, decimals = 1, showSign = false): string {
  if (n === null) return '—';
  const sign = showSign && n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
}

function fmtNum(n: number | null, decimals = 2): string {
  if (n === null) return '—';
  return n.toFixed(decimals);
}

function fmtK(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtAge(detectedAt: string, generatedAt: string): string {
  const ms = new Date(generatedAt).getTime() - new Date(detectedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function cmpRow(label: string, w: number | null, l: number | null, formatter: (v: number | null) => string): string {
  const labelPad = label.padEnd(30);
  const wStr = formatter(w).padStart(12);
  const lStr = formatter(l).padStart(12);
  return `     ${labelPad} ${wStr}  ${lStr}`;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderOutcomeAutopsyReport(result: OutcomeAutopsyResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — OUTCOME AUTOPSY');
  lines.push('  [REAL TRADING LOCKED — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (result.inputMissing) {
    lines.push('');
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run token:outcome-tracker first.');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  const {
    totalCandidates, winnerCount, loserCount, flatCount, unknownCount,
    winRate, averageReturnPct, bestCandidate, worstCandidate,
    winnerMetrics, loserMetrics, records, generatedAt,
  } = result;

  // ── Section 1: Summary ────────────────────────────────────────────────────
  lines.push('');
  lines.push('  1. SUMMARY');
  lines.push(`     Generated                : ${generatedAt}`);
  lines.push(`     Candidates analyzed      : ${totalCandidates}`);
  lines.push(`     Winners (RIPPED + MOVED) : ${winnerCount}`);
  lines.push(`     Losers  (DUMPED)         : ${loserCount}`);
  if (flatCount > 0)    lines.push(`     Flat                     : ${flatCount}`);
  if (unknownCount > 0) lines.push(`     Unknown (no price)       : ${unknownCount}`);
  lines.push(`     Win rate                 : ${winRate !== null ? `${(winRate * 100).toFixed(0)}%` : '— (need both winners and losers)'}`);
  lines.push(`     Average return           : ${fmtPct(averageReturnPct, 1, true)}`);
  if (bestCandidate) {
    lines.push(`     Best                     : $${bestCandidate.symbol} (${fmtPct(bestCandidate.currentReturnPct, 1, true)})`);
  }
  if (worstCandidate) {
    lines.push(`     Worst                    : $${worstCandidate.symbol} (${fmtPct(worstCandidate.currentReturnPct, 1, true)})`);
  }
  lines.push('');

  // ── Section 2: Winner vs Loser Comparison ─────────────────────────────────
  lines.push('  2. WINNER vs LOSER COMPARISON');
  if (winnerCount === 0 && loserCount === 0) {
    lines.push('     No winners or losers to compare (all FLAT/UNKNOWN).');
  } else {
    const wN = `Winners (n=${winnerCount})`;
    const lN = `Losers (n=${loserCount})`;
    lines.push(`     ${'Metric'.padEnd(30)} ${wN.padStart(12)}  ${lN.padStart(12)}`);
    lines.push(`     ${'─'.repeat(60)}`);
    lines.push(cmpRow('Top holder %',          winnerMetrics.avgTopHolderPercent,       loserMetrics.avgTopHolderPercent,       v => fmtPct(v)));
    lines.push(cmpRow('Entry liquidity',        winnerMetrics.avgEntryLiquidityUsd,      loserMetrics.avgEntryLiquidityUsd,      fmtK));
    lines.push(cmpRow('Entry volume',           winnerMetrics.avgEntryVolumeUsd,         loserMetrics.avgEntryVolumeUsd,         fmtK));
    lines.push(cmpRow('Vol/Liq ratio',          winnerMetrics.avgVolumeToLiquidityRatio, loserMetrics.avgVolumeToLiquidityRatio, v => fmtNum(v, 3)));
    lines.push(cmpRow('Liq change % (capture)', winnerMetrics.avgLiquidityChangePct,     loserMetrics.avgLiquidityChangePct,     v => fmtPct(v, 2, true)));
    lines.push(cmpRow('Price change % (capture)',winnerMetrics.avgPriceChangePctCapture,  loserMetrics.avgPriceChangePctCapture,  v => fmtPct(v, 2, true)));
    lines.push(cmpRow('Est. slippage %',        winnerMetrics.avgEstimatedSlippagePct,   loserMetrics.avgEstimatedSlippagePct,   v => fmtPct(v, 3)));
    lines.push(cmpRow('BubbleMaps score',       winnerMetrics.avgBubbleMapsScore,        loserMetrics.avgBubbleMapsScore,        v => fmtNum(v, 1)));
  }
  lines.push('');

  // ── Section 3: Candidate Table ─────────────────────────────────────────────
  lines.push('  3. CANDIDATES');
  const colHdr = [
    'Symbol'.padEnd(14),
    'Return'.padStart(8),
    'Status'.padEnd(8),
    'Holder%'.padStart(7),
    'Liq'.padStart(8),
    'Vol/Liq'.padStart(7),
    'LiqChg%'.padStart(8),
    'PriceChg%'.padStart(9),
    'Slip%'.padStart(6),
    'Bubble'.padStart(7),
    'HolderStatus',
  ].join('  ');
  lines.push(`     ${colHdr}`);
  lines.push(`     ${'─'.repeat(colHdr.length)}`);

  for (const r of records) {
    const sym     = `$${r.symbol}`.padEnd(14);
    const ret     = fmtPct(r.currentReturnPct, 1, true).padStart(8);
    const status  = r.status.padEnd(8);
    const holder  = fmtPct(r.topHolderPercent).padStart(7);
    const liq     = fmtK(r.liquidityUsd).padStart(8);
    const vliq    = fmtNum(r.volumeToLiquidityRatio, 3).padStart(7);
    const liqChg  = fmtPct(r.liquidityChangePct, 2, true).padStart(8);
    const priceChg = fmtPct(r.priceChangePctCapture, 2, true).padStart(9);
    const slip    = fmtPct(r.estimatedSlippagePct, 3).padStart(6);
    const bubble  = fmtNum(r.bubbleMapsScore, 1).padStart(7);
    const hStatus = r.holderConcentrationStatus;
    lines.push(`     ${sym}  ${ret}  ${status}  ${holder}  ${liq}  ${vliq}  ${liqChg}  ${priceChg}  ${slip}  ${bubble}  ${hStatus}`);
    if (r.pairUrl) {
      lines.push(`       ↳ ${r.pairUrl}`);
    }
    if (r.clusterNotes.length > 0) {
      lines.push(`       ↳ cluster: ${r.clusterNotes.join(', ')}`);
    }
    const age = fmtAge(r.detectedAt, generatedAt);
    lines.push(`       ↳ detected: ${r.detectedAt}  age: ${age}  entry: $${r.detectedPriceUsd ?? '—'}  latest: $${r.latestPriceUsd ?? '—'}`);
  }
  lines.push('');

  // ── Section 4: Early Recommendations ──────────────────────────────────────
  lines.push('  4. EARLY RECOMMENDATIONS');
  lines.push('  ─────────────────────────────────────────────────────────────────');

  if (totalCandidates < 20) {
    lines.push(`  ⚠  Do not go live from ${totalCandidates} sample${totalCandidates === 1 ? '' : 's'}`);
    lines.push('     Need more samples before changing gates (minimum 20 recommended).');
  }

  if (winnerCount > 0 && loserCount > 0) {
    // Compare BubbleMaps scores
    const wBubble = winnerMetrics.avgBubbleMapsScore;
    const lBubble = loserMetrics.avgBubbleMapsScore;
    if (wBubble !== null && lBubble !== null && Math.abs(wBubble - lBubble) > 5) {
      const dir = wBubble > lBubble ? 'winners had higher' : 'winners had lower';
      lines.push(`  ·  Potential weak signal: BubbleMaps score — ${dir} scores (${fmtNum(wBubble, 1)} vs ${fmtNum(lBubble, 1)})`);
      lines.push('     Not enough data to raise the threshold — observe more samples.');
    }
    // Compare vol/liq
    const wVL = winnerMetrics.avgVolumeToLiquidityRatio;
    const lVL = loserMetrics.avgVolumeToLiquidityRatio;
    if (wVL !== null && lVL !== null && Math.abs(wVL - lVL) > 0.1) {
      const dir = wVL > lVL ? 'winners had higher' : 'winners had lower';
      lines.push(`  ·  Potential weak signal: Vol/Liq ratio — ${dir} (${fmtNum(wVL, 3)} vs ${fmtNum(lVL, 3)})`);
      lines.push('     Not enough data to raise the threshold — observe more samples.');
    }
    // Compare holder %
    const wH = winnerMetrics.avgTopHolderPercent;
    const lH = loserMetrics.avgTopHolderPercent;
    if (wH !== null && lH !== null && Math.abs(wH - lH) > 3) {
      const dir = wH < lH ? 'winners had lower top-holder %' : 'winners had higher top-holder %';
      lines.push(`  ·  Potential weak signal: top-holder % — ${dir} (${fmtPct(wH)} vs ${fmtPct(lH)})`);
      lines.push('     Not enough data to raise the threshold — observe more samples.');
    }
  }

  if (winnerCount === 0 && loserCount > 0) {
    lines.push('  ·  All resolved candidates are DUMPED — gates may not be restrictive enough,');
    lines.push('     but sample is too small to conclude anything.');
  }

  lines.push('');
  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('  These observations are informational only. Gate changes require');
  lines.push('  a minimum of 20 resolved candidates with consistent signal.');
  lines.push('  ─────────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}
