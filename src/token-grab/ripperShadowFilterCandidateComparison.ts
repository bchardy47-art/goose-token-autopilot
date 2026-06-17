// DO_NOT_ENABLE_REAL_TRADING  reportOnly=true  readOnly=true  paperOnly=true  tradingExecuted=0

import * as fs from 'fs';
import * as path from 'path';
import { extractRipperContract, extractRipperPriceChangePct } from './ripperExtractors';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CandidateOutcome =
  | 'WIN_5PCT'
  | 'WIN_3PCT'
  | 'WIN_1PCT'
  | 'DUMP'
  | 'FLAT_JUNK'
  | 'UNOBSERVED';

export type CandidateRecommendation =
  | 'PROMISING_SHADOW_FILTER'
  | 'NEEDS_MORE_DATA'
  | 'NO_CLEAR_EDGE';

export interface CandidateStats {
  candidateName:            string;
  predicate:                string;
  enrolledCount:            number;
  observedCount:            number;
  unobservedCount:          number;
  flatJunkCount:            number;
  flatJunkRate:             number | null;
  dumpCount:                number;
  dumpRate:                 number | null;
  win1Count:                number;
  win1Rate:                 number | null;
  win3Count:                number;
  win3Rate:                 number | null;
  win5Count:                number;
  win5Rate:                 number | null;
  avgMove:                  number | null;
  medianMove:               number | null;
  controlObservedCount:     number;
  controlWin1Count:         number;
  controlWin1Rate:          number | null;
  controlVsBlockedMultiple: number | null;
  recommendation:           CandidateRecommendation;
}

export interface ShadowFilterCandidateComparisonResult {
  generatedAt:       string;
  enrollmentsRead:   number;
  observedTotal:     number;
  unobservedTotal:   number;
  candidates:        CandidateStats[];
  reportOnly:        true;
  readOnly:          true;
  tradingExecuted:   0;
  realTradingLocked: true;
  paperOnly:         true;
}

export interface ShadowFilterCandidateComparisonOptions {
  enrollmentsPath:   string;
  paperIntentsPath?: string;
  observationPaths:  string[];
  nowMs?:            number;
}

// ── Internal ──────────────────────────────────────────────────────────────────

interface EnrolledRow {
  contract:          string;
  capturedAt:        string;
  cycleId:           string;
  symbol:            string | null;
  ripperScore:       number | null;
  clusterRisk:       string | null;
  launchAgeBucket:   string | null;
  ageMinutes:        number | null;
  liquidityUsd:      number | null;
  // flags from enrollment file
  age_gte10m:        boolean;
  liq_lt10k:         boolean;
  liq_OR_age:        boolean;
  isCleanScore100Prime: boolean;
  isScore100:        boolean;
}

interface ClassifiedRow extends EnrolledRow {
  outcome:        CandidateOutcome;
  priceChangePct: number | null;
}

interface ObsEntry {
  observedAt:     string;
  priceChangePct: number | null;
}

// ── Filter candidates ─────────────────────────────────────────────────────────

interface FilterDef {
  name:      string;
  predicate: string;
  fn:        (r: EnrolledRow) => boolean;
}

const FILTER_DEFS: FilterDef[] = [
  {
    name:      'age_gte10m',
    predicate: 'ageMinutes >= 10',
    fn:        r => r.age_gte10m,
  },
  {
    name:      'liq_lt10k',
    predicate: 'liquidityUsd < 10000',
    fn:        r => r.liq_lt10k,
  },
  {
    name:      'liq_OR_age',
    predicate: 'liq_lt10k OR age_gte10m',
    fn:        r => r.liq_OR_age,
  },
  {
    name:      'liq_lt10k_AND_not_clean_score100_prime',
    predicate: 'liq_lt10k AND NOT (CLEAN + score=100 + PRIME_WINDOW)',
    fn:        r => r.liq_lt10k && !r.isCleanScore100Prime,
  },
  {
    name:      'liq_lt10k_AND_not_score100',
    predicate: 'liq_lt10k AND NOT (ripperScore=100)',
    fn:        r => r.liq_lt10k && !r.isScore100,
  },
  {
    name:      'liq_OR_age_BUT_keep_clean_score100_prime',
    predicate: 'liq_OR_age AND NOT (CLEAN + score=100 + PRIME_WINDOW)',
    fn:        r => r.liq_OR_age && !r.isCleanScore100Prime,
  },
  {
    name:      'liq_OR_age_BUT_keep_score100',
    predicate: 'liq_OR_age AND NOT (ripperScore=100)',
    fn:        r => r.liq_OR_age && !r.isScore100,
  },
  {
    name:      'liq_OR_age_BUT_keep_liq_10k_plus',
    predicate: 'liq_OR_age AND NOT (liquidityUsd >= 10000) [effectively liq_lt10k]',
    fn:        r => r.liq_OR_age && !(r.liquidityUsd != null && r.liquidityUsd >= 10_000),
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

function classifyOutcome(pct: number | null): CandidateOutcome {
  if (pct == null) return 'UNOBSERVED';
  if (pct >= 5)   return 'WIN_5PCT';
  if (pct >= 3)   return 'WIN_3PCT';
  if (pct >= 1)   return 'WIN_1PCT';
  if (pct <= -1)  return 'DUMP';
  return 'FLAT_JUNK';
}

function pct(n: number, total: number): number | null {
  if (total === 0) return null;
  return Math.round((n / total) * 1000) / 10;
}

function average(vals: number[]): number | null {
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 100) / 100
    : sorted[mid]!;
}

function recommend(stats: {
  observedCount:    number;
  flatJunkRate:     number | null;
  dumpRate:         number | null;
  win1Rate:         number | null;
  win1Count:        number;
  win3Rate:         number | null;
  win5Rate:         number | null;
  controlVsBlockedMultiple: number | null;
}): CandidateRecommendation {
  if (stats.observedCount < 50) return 'NEEDS_MORE_DATA';
  const flatAndDumpRate =
    stats.flatJunkRate != null && stats.dumpRate != null
      ? Math.round((stats.flatJunkRate + stats.dumpRate) * 10) / 10
      : null;
  // multiple condition: trivially met when 0 blocked winners (can't do better than killing 0 winners)
  const multipleOk =
    stats.win1Count === 0 ||
    (stats.controlVsBlockedMultiple != null && stats.controlVsBlockedMultiple >= 3);
  if (
    flatAndDumpRate != null && flatAndDumpRate >= 90 &&
    stats.win1Rate  != null && stats.win1Rate  <= 5  &&
    stats.win3Rate  != null && stats.win3Rate  <= 3  &&
    stats.win5Rate  != null && stats.win5Rate  <= 2  &&
    multipleOk
  ) {
    return 'PROMISING_SHADOW_FILTER';
  }
  return 'NO_CLEAR_EDGE';
}

// ── Data loading ──────────────────────────────────────────────────────────────

function readEnrollments(enrollmentsPath: string): EnrolledRow[] {
  const seen   = new Set<string>();
  const result: EnrolledRow[] = [];

  for (const line of readLines(enrollmentsPath)) {
    try {
      const f          = JSON.parse(line) as Record<string, unknown>;
      const contract   = typeof f['contract']   === 'string' ? f['contract']   : null;
      const capturedAt = typeof f['capturedAt'] === 'string' ? f['capturedAt'] : null;
      const cycleFile  = typeof f['cycleFile']  === 'string' ? f['cycleFile']  : null;
      if (!contract || !capturedAt || !cycleFile) continue;

      // Only enrolled approved rows
      if (f['buyGateDecision'] !== 'BUY_APPROVED_PAPER') continue;

      const key = `${contract}::${capturedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const cycleId = cycleFile.replace(/\.jsonl$/, '');
      const flags   = (f['shadowRejectFlags'] ?? {}) as Record<string, unknown>;
      const liq     = typeof f['liquidityUsd'] === 'number' ? f['liquidityUsd'] as number : null;
      const age     = typeof f['ageMinutes']   === 'number' ? f['ageMinutes']   as number : null;

      const age_gte10m = flags['age_gte10m'] === true;
      const liq_lt10k  = flags['liq_lt10k']  === true;
      const liq_OR_age = flags['liq_OR_age']  === true;

      const ripperScore      = typeof f['ripperScore']     === 'number' ? f['ripperScore']     as number : null;
      const clusterRisk      = typeof f['clusterRisk']     === 'string' ? f['clusterRisk']     as string : null;
      const launchAgeBucket  = typeof f['launchAgeBucket'] === 'string' ? f['launchAgeBucket'] as string : null;

      const isCleanScore100Prime =
        clusterRisk === 'CLEAN' && ripperScore === 100 && launchAgeBucket === 'PRIME_WINDOW';
      const isScore100 = ripperScore === 100;

      result.push({
        contract,
        capturedAt,
        cycleId,
        symbol:           typeof f['symbol'] === 'string' ? f['symbol'] : null,
        ripperScore,
        clusterRisk,
        launchAgeBucket,
        ageMinutes:       age,
        liquidityUsd:     liq,
        age_gte10m,
        liq_lt10k,
        liq_OR_age,
        isCleanScore100Prime,
        isScore100,
      });
    } catch { /* skip */ }
  }
  return result;
}

function buildPaperIntentIndex(paperIntentsPath: string | undefined): Map<string, string> {
  const index = new Map<string, string>();
  if (!paperIntentsPath || !fs.existsSync(paperIntentsPath)) return index;
  for (const line of readLines(paperIntentsPath)) {
    try {
      const r           = JSON.parse(line) as Record<string, unknown>;
      const contract    = typeof r['contract']      === 'string' ? r['contract']      : null;
      const sourceCycle = typeof r['sourceCycle']   === 'string' ? r['sourceCycle']   : null;
      const targetAt    = typeof r['targetEntryAt'] === 'string' ? r['targetEntryAt'] : null;
      if (!contract || !sourceCycle || !targetAt) continue;
      const key = `${contract}::${sourceCycle}`;
      if (!index.has(key)) index.set(key, targetAt);
    } catch { /* skip */ }
  }
  return index;
}

function readObsMap(paths: string[]): Map<string, ObsEntry[]> {
  const map = new Map<string, ObsEntry[]>();

  for (const p of paths) {
    if (!fs.existsSync(p)) continue;

    for (const line of readLines(p)) {
      try {
        const f          = JSON.parse(line) as Record<string, unknown>;
        const contract   = extractRipperContract(f);
        const capturedAt = typeof f['capturedAt'] === 'string' ? f['capturedAt'] : null;
        if (!contract || !capturedAt) continue;

        const list = map.get(contract) ?? [];
        list.push({ observedAt: capturedAt, priceChangePct: extractRipperPriceChangePct(f) });
        map.set(contract, list);
      } catch { /* skip */ }
    }
  }

  for (const list of map.values()) {
    list.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }
  return map;
}

// ── Stats builder ─────────────────────────────────────────────────────────────

function buildCandidateStats(
  def:         FilterDef,
  allRows:     ClassifiedRow[],
): CandidateStats {
  const blocked = allRows.filter(r => def.fn(r));
  const control = allRows.filter(r => !def.fn(r));

  const blockedObs = blocked.filter(r => r.outcome !== 'UNOBSERVED');
  const controlObs = control.filter(r => r.outcome !== 'UNOBSERVED');

  const moves        = blockedObs.map(r => r.priceChangePct!).filter((v): v is number => v != null);
  const flatJunkCount = blockedObs.filter(r => r.outcome === 'FLAT_JUNK').length;
  const dumpCount     = blockedObs.filter(r => r.outcome === 'DUMP').length;
  const win1Count     = blockedObs.filter(r => r.outcome === 'WIN_1PCT' || r.outcome === 'WIN_3PCT' || r.outcome === 'WIN_5PCT').length;
  const win3Count     = blockedObs.filter(r => r.outcome === 'WIN_3PCT' || r.outcome === 'WIN_5PCT').length;
  const win5Count     = blockedObs.filter(r => r.outcome === 'WIN_5PCT').length;

  const flatJunkRate = pct(flatJunkCount, blockedObs.length);
  const dumpRate     = pct(dumpCount,     blockedObs.length);
  const win1Rate     = pct(win1Count,     blockedObs.length);
  const win3Rate     = pct(win3Count,     blockedObs.length);
  const win5Rate     = pct(win5Count,     blockedObs.length);

  const controlWin1Count = controlObs.filter(r => r.outcome === 'WIN_1PCT' || r.outcome === 'WIN_3PCT' || r.outcome === 'WIN_5PCT').length;
  const controlWin1Rate  = pct(controlWin1Count, controlObs.length);

  const controlVsBlockedMultiple =
    controlWin1Rate != null && win1Rate != null && win1Rate > 0
      ? Math.round((controlWin1Rate / win1Rate) * 10) / 10
      : controlWin1Rate != null && win1Count === 0 && blockedObs.length >= 50
        ? null  // can't compute multiple when blocked winners = 0
        : null;

  const rec = recommend({
    observedCount:            blockedObs.length,
    flatJunkRate,
    dumpRate,
    win1Rate,
    win1Count,
    win3Rate,
    win5Rate,
    controlVsBlockedMultiple,
  });

  return {
    candidateName:            def.name,
    predicate:                def.predicate,
    enrolledCount:            blocked.length,
    observedCount:            blockedObs.length,
    unobservedCount:          blocked.length - blockedObs.length,
    flatJunkCount,
    flatJunkRate,
    dumpCount,
    dumpRate,
    win1Count,
    win1Rate,
    win3Count,
    win3Rate,
    win5Count,
    win5Rate,
    avgMove:                  average(moves),
    medianMove:               median(moves),
    controlObservedCount:     controlObs.length,
    controlWin1Count,
    controlWin1Rate,
    controlVsBlockedMultiple,
    recommendation:           rec,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runShadowFilterCandidateComparison(
  options: ShadowFilterCandidateComparisonOptions,
): ShadowFilterCandidateComparisonResult {
  // SAFETY LOCK: report-only, no trading, no wallet, no swap execution
  const _reportOnly:        true = true;
  const _readOnly:          true = true;
  const _tradingExecuted:   0    = 0;
  const _realTradingLocked: true = true;
  const _paperOnly:         true = true;

  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const enrollments  = readEnrollments(options.enrollmentsPath);
  const paperIntents = buildPaperIntentIndex(
    options.paperIntentsPath ?? 'data/token-grab/ripper/paper-intents.jsonl',
  );
  const obsByContract = readObsMap(options.observationPaths);

  // Classify each enrollment using targetEntryAt floor where available
  const classified: ClassifiedRow[] = enrollments.map(e => {
    const intentKey     = `${e.contract}::${e.cycleId}`;
    const targetEntryAt = paperIntents.get(intentKey) ?? null;
    const obsFloor      = targetEntryAt ?? e.capturedAt;

    const obs = (obsByContract.get(e.contract) ?? [])
      .find(o => o.observedAt >= obsFloor && o.priceChangePct != null);

    const priceChangePct = obs?.priceChangePct ?? null;
    return { ...e, outcome: classifyOutcome(priceChangePct), priceChangePct };
  });

  const observedTotal   = classified.filter(r => r.outcome !== 'UNOBSERVED').length;
  const unobservedTotal = classified.filter(r => r.outcome === 'UNOBSERVED').length;

  const candidates = FILTER_DEFS.map(def => buildCandidateStats(def, classified));

  return {
    generatedAt,
    enrollmentsRead:   enrollments.length,
    observedTotal,
    unobservedTotal,
    candidates,
    reportOnly:        _reportOnly,
    readOnly:          _readOnly,
    tradingExecuted:   _tradingExecuted,
    realTradingLocked: _realTradingLocked,
    paperOnly:         _paperOnly,
  };
}

// ── Renderer helpers ──────────────────────────────────────────────────────────

function fmtRate(v: number | null): string {
  return v != null ? `${v}%` : 'n/a';
}

function fmtNum(v: number | null): string {
  return v != null ? String(v) : 'n/a';
}

function fmtMultiple(v: number | null): string {
  return v != null ? `${v}x` : 'n/a';
}

function recLabel(r: CandidateRecommendation): string {
  switch (r) {
    case 'PROMISING_SHADOW_FILTER': return '✓ PROMISING_SHADOW_FILTER';
    case 'NEEDS_MORE_DATA':         return '~ NEEDS_MORE_DATA';
    case 'NO_CLEAR_EDGE':           return '- NO_CLEAR_EDGE';
  }
}

function renderCandidateBlock(c: CandidateStats, lines: string[]): void {
  const SEP2 = '────────────────────────────────────────────────────────────────';
  lines.push(`  ${SEP2}`);
  lines.push(`  ${c.candidateName.toUpperCase()}`);
  lines.push(`  Predicate : ${c.predicate}`);
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Enrolled (would-reject)   : ${c.enrolledCount}`);
  lines.push(`  Observed                  : ${c.observedCount}`);
  lines.push(`  Unobserved                : ${c.unobservedCount}`);
  lines.push('');
  lines.push(`  Flat junk                 : ${c.flatJunkCount} / ${c.observedCount} (${fmtRate(c.flatJunkRate)})`);
  lines.push(`  Dumps (<= -1%)            : ${c.dumpCount} / ${c.observedCount} (${fmtRate(c.dumpRate)})`);
  lines.push(`  Winners >= +1%            : ${c.win1Count} / ${c.observedCount} (${fmtRate(c.win1Rate)})`);
  lines.push(`  Winners >= +3%            : ${c.win3Count} / ${c.observedCount} (${fmtRate(c.win3Rate)})`);
  lines.push(`  Winners >= +5%            : ${c.win5Count} / ${c.observedCount} (${fmtRate(c.win5Rate)})`);
  lines.push(`  Avg price change          : ${fmtNum(c.avgMove)}%`);
  lines.push(`  Median price change       : ${fmtNum(c.medianMove)}%`);
  lines.push('');
  lines.push(`  Control (would-pass) obs  : ${c.controlObservedCount}`);
  lines.push(`  Control winners >= +1%    : ${c.controlWin1Count} / ${c.controlObservedCount} (${fmtRate(c.controlWin1Rate)})`);
  lines.push(`  Control vs blocked mult   : ${fmtMultiple(c.controlVsBlockedMultiple)}`);
  lines.push('');
  lines.push(`  Recommendation            : ${recLabel(c.recommendation)}`);
  lines.push('');
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderShadowFilterCandidateComparison(
  result: ShadowFilterCandidateComparisonResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — SHADOW FILTER CANDIDATE COMPARISON v1');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push('  DO NOT ENABLE REAL TRADING  |  DO NOT CHANGE PRODUCTION GATES');
  lines.push('  DO NOT WIRE INTO AUTOPILOT DECISIONS');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Enrollments read          : ${result.enrollmentsRead}`);
  lines.push(`  Observed total            : ${result.observedTotal}`);
  lines.push(`  Unobserved total          : ${result.unobservedTotal}`);
  lines.push(`  Generated at              : ${result.generatedAt}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  FILTER CANDIDATE RESULTS');
  lines.push('  (Only SHADOW_ENROLLED_APPROVED rows — DEX_WATCH_GENERAL excluded)');
  lines.push('  (Observation floor: targetEntryAt from paper-intents when available,');
  lines.push('   otherwise capturedAt — consistent with learning memory timing)');
  lines.push(`  ${SEP2}`, '');

  for (const c of result.candidates) {
    renderCandidateBlock(c, lines);
  }

  // Summary table
  lines.push(`  ${SEP2}`);
  lines.push('  SIDE-BY-SIDE SUMMARY TABLE');
  lines.push(`  ${SEP2}`, '');
  lines.push('  Candidate                                  | Obs  | Win1%  | Ctrl/Blk | Rec');
  lines.push('  -------------------------------------------|------|--------|----------|-------------------');
  for (const c of result.candidates) {
    const name   = c.candidateName.padEnd(42);
    const obs    = String(c.observedCount).padStart(4);
    const w1     = fmtRate(c.win1Rate).padStart(6);
    const mult   = fmtMultiple(c.controlVsBlockedMultiple).padStart(8);
    const rec    = recLabel(c.recommendation);
    lines.push(`  ${name} | ${obs} | ${w1} | ${mult} | ${rec}`);
  }
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  PROMOTING CANDIDATES');
  lines.push(`  ${SEP2}`, '');
  const promising = result.candidates.filter(c => c.recommendation === 'PROMISING_SHADOW_FILTER');
  if (promising.length === 0) {
    lines.push('  None — no candidate meets PROMISING_SHADOW_FILTER threshold at this time.');
    lines.push('  Threshold: observed >= 50, flat+dump >= 90%, win1 <= 5%, win3 <= 3%,');
    lines.push('             win5 <= 2%, control_win1 >= 3x blocked_win1');
  } else {
    for (const c of promising) {
      lines.push(`  ✓ ${c.candidateName}`);
      lines.push(`    ${c.predicate}`);
      lines.push(`    observed=${c.observedCount}, win1=${fmtRate(c.win1Rate)}, ctrl/blk=${fmtMultiple(c.controlVsBlockedMultiple)}`);
    }
  }
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  SAFETY');
  lines.push(`  ${SEP2}`, '');
  lines.push('  reportOnly        : true');
  lines.push('  readOnly          : true');
  lines.push('  tradingExecuted   : 0');
  lines.push('  realTradingLocked : true');
  lines.push('  paperOnly         : true');
  lines.push('');
  lines.push('  DO NOT change production gates based on this report.');
  lines.push('  DO NOT wire any candidate into the autopilot decision flow.');
  lines.push('  DO NOT invoke auto-paper or paper-buy npm scripts.');
  lines.push(SEP, '');

  return lines.join('\n');
}
