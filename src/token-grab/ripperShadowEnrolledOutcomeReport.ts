import * as fs from 'fs';
import * as path from 'path';
import { extractRipperContract, extractRipperPriceChangePct } from './ripperExtractors';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutcomeClass =
  | 'WIN_5PCT'
  | 'WIN_3PCT'
  | 'WIN_1PCT'
  | 'DUMP'
  | 'FLAT_JUNK'
  | 'UNOBSERVED';

export type GroupRecommendation =
  | 'PROMISING_SHADOW_FILTER'
  | 'WATCH_MORE_DATA'
  | 'TOO_MANY_WINNERS_KILLED'
  | 'NO_CLEAR_EDGE';

export interface GroupStats {
  groupName:       string;
  enrolledCount:   number;
  observedCount:   number;
  unobservedCount: number;
  flatJunkCount:   number;
  dumpCount:       number;
  win1Count:       number;
  win3Count:       number;
  win5Count:       number;
  flatJunkRate:    number | null;
  dumpRate:        number | null;
  win1Rate:        number | null;
  win3Rate:        number | null;
  win5Rate:        number | null;
  avgMove:         number | null;
  medianMove:      number | null;
  recommendation:  GroupRecommendation;
}

export interface ShadowEnrolledOutcomeResult {
  generatedAt:          string;
  enrollmentsRead:      number;
  observedEnrollments:  number;
  unobservedEnrollments: number;
  bestComboCount:       number;
  bestComboObserved:    number;
  bestComboGroup:       GroupStats;
  controlGroup:         GroupStats;
  ageGte10mGroup:       GroupStats;
  liqLt10kGroup:        GroupStats;
  liqOrAgeGroup:        GroupStats;
  overallDecision:      'READY_FOR_PAPER_POLICY_TEST' | 'KEEP_SHADOW_TESTING';
  outPath:              string;
  rowsWritten:          number;
  reportOnly:           true;
  readOnly:             true;
  tradingExecuted:      0;
  realTradingLocked:    true;
  paperOnly:            true;
}

export interface ShadowEnrolledOutcomeOptions {
  enrollmentPaths:  string[];
  observationPaths: string[];
  outPath:          string;
  nowMs?:           number;
}

// ── Internal ──────────────────────────────────────────────────────────────────

interface EnrolledRow {
  contract:              string;
  capturedAt:            string;
  symbol:                string | null;
  wouldRejectByBestCombo: boolean;
  ageGte10m:             boolean;
  liqLt10k:              boolean;
  liqOrAge:              boolean;
  ageMinutes:            number | null;
  liquidityUsd:          number | null;
  volumeLiquidityRatio:  number | null;
}

interface ClassifiedRow extends EnrolledRow {
  outcome:        OutcomeClass;
  priceChangePct: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyOutcome(pct: number | null): OutcomeClass {
  if (pct == null) return 'UNOBSERVED';
  if (pct >= 5)   return 'WIN_5PCT';
  if (pct >= 3)   return 'WIN_3PCT';
  if (pct >= 1)   return 'WIN_1PCT';
  if (pct <= -3)  return 'DUMP';
  return 'FLAT_JUNK';
}

function isAnyWinner(o: OutcomeClass): boolean {
  return o === 'WIN_1PCT' || o === 'WIN_3PCT' || o === 'WIN_5PCT';
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
  observedCount: number;
  flatJunkRate:  number | null;
  win1Rate:      number | null;
}): GroupRecommendation {
  if (stats.observedCount < 20) return 'WATCH_MORE_DATA';
  if (stats.win1Rate != null && stats.win1Rate > 10) return 'TOO_MANY_WINNERS_KILLED';
  if (
    stats.flatJunkRate != null && stats.flatJunkRate >= 70 &&
    stats.win1Rate != null     && stats.win1Rate <= 5
  ) return 'PROMISING_SHADOW_FILTER';
  return 'NO_CLEAR_EDGE';
}

function buildGroupStats(groupName: string, rows: ClassifiedRow[]): GroupStats {
  const observed = rows.filter(r => r.outcome !== 'UNOBSERVED');
  const moves    = observed.map(r => r.priceChangePct!).filter((v): v is number => v != null);

  const flatJunkCount = observed.filter(r => r.outcome === 'FLAT_JUNK').length;
  const dumpCount     = observed.filter(r => r.outcome === 'DUMP').length;
  const win1Count     = observed.filter(r => isAnyWinner(r.outcome)).length;
  const win3Count     = observed.filter(r => r.outcome === 'WIN_3PCT' || r.outcome === 'WIN_5PCT').length;
  const win5Count     = observed.filter(r => r.outcome === 'WIN_5PCT').length;

  const flatJunkRate = pct(flatJunkCount, observed.length);
  const dumpRate     = pct(dumpCount,     observed.length);
  const win1Rate     = pct(win1Count,     observed.length);
  const win3Rate     = pct(win3Count,     observed.length);
  const win5Rate     = pct(win5Count,     observed.length);

  return {
    groupName,
    enrolledCount:   rows.length,
    observedCount:   observed.length,
    unobservedCount: rows.length - observed.length,
    flatJunkCount,
    dumpCount,
    win1Count,
    win3Count,
    win5Count,
    flatJunkRate,
    dumpRate,
    win1Rate,
    win3Rate,
    win5Rate,
    avgMove:        average(moves),
    medianMove:     median(moves),
    recommendation: recommend({ observedCount: observed.length, flatJunkRate, win1Rate }),
  };
}

// ── Data loading ──────────────────────────────────────────────────────────────

interface ObsEntry {
  capturedAt:     string;
  priceChangePct: number | null;
}

function readObsMap(
  paths: string[],
): Map<string, ObsEntry[]> {
  const map = new Map<string, ObsEntry[]>();
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f          = JSON.parse(line) as Record<string, unknown>;
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
  return map;
}

function readEnrollments(paths: string[]): EnrolledRow[] {
  const seen   = new Set<string>();
  const result: EnrolledRow[] = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const f          = JSON.parse(line) as Record<string, unknown>;
        const contract   = typeof f['contract'] === 'string' ? f['contract'] : null;
        const capturedAt = typeof f['capturedAt'] === 'string' ? f['capturedAt'] : null;
        if (!contract || !capturedAt) continue;

        const key = `${contract}::${capturedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const flags = f['shadowRejectFlags'] as Record<string, unknown> | undefined;

        result.push({
          contract,
          capturedAt,
          symbol:                typeof f['symbol'] === 'string' ? f['symbol'] : null,
          wouldRejectByBestCombo: f['wouldRejectByBestCombo'] === true,
          ageGte10m:             flags?.['age_gte10m'] === true,
          liqLt10k:              flags?.['liq_lt10k']  === true,
          liqOrAge:              flags?.['liq_OR_age']  === true,
          ageMinutes:            typeof f['ageMinutes']   === 'number' ? f['ageMinutes']   as number : null,
          liquidityUsd:          typeof f['liquidityUsd'] === 'number' ? f['liquidityUsd'] as number : null,
          volumeLiquidityRatio:  typeof f['volumeLiquidityRatio'] === 'number' ? f['volumeLiquidityRatio'] as number : null,
        });
      } catch { /* skip */ }
    }
  }
  return result;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runShadowEnrolledOutcomeReport(
  options: ShadowEnrolledOutcomeOptions,
): ShadowEnrolledOutcomeResult {
  const nowMs       = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();

  const obsByContract = readObsMap(options.observationPaths);
  const enrollments   = readEnrollments(options.enrollmentPaths);

  // Classify each enrollment
  const classified: ClassifiedRow[] = enrollments.map(e => {
    const obs = (obsByContract.get(e.contract) ?? [])
      .find(o => o.capturedAt >= e.capturedAt && o.priceChangePct != null);
    const priceChangePct = obs?.priceChangePct ?? null;
    return { ...e, outcome: classifyOutcome(priceChangePct), priceChangePct };
  });

  const observedAll   = classified.filter(r => r.outcome !== 'UNOBSERVED');
  const unobservedAll = classified.filter(r => r.outcome === 'UNOBSERVED');

  const bestComboRows  = classified.filter(r => r.wouldRejectByBestCombo);
  const controlRows    = classified.filter(r => !r.wouldRejectByBestCombo);
  const ageGte10mRows  = classified.filter(r => r.ageGte10m);
  const liqLt10kRows   = classified.filter(r => r.liqLt10k);
  const liqOrAgeRows   = classified.filter(r => r.liqOrAge);

  const bestComboGroup = buildGroupStats('wouldRejectByBestCombo=true',  bestComboRows);
  const controlGroup   = buildGroupStats('wouldRejectByBestCombo=false', controlRows);
  const ageGte10mGroup = buildGroupStats('age_gte10m=true',              ageGte10mRows);
  const liqLt10kGroup  = buildGroupStats('liq_lt10k=true',               liqLt10kRows);
  const liqOrAgeGroup  = buildGroupStats('liq_OR_age=true',              liqOrAgeRows);

  const overallDecision: ShadowEnrolledOutcomeResult['overallDecision'] =
    bestComboGroup.recommendation === 'PROMISING_SHADOW_FILTER'
      ? 'READY_FOR_PAPER_POLICY_TEST'
      : 'KEEP_SHADOW_TESTING';

  // Write one JSONL row per classified enrollment
  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
  const content = classified.length > 0
    ? classified.map(r => JSON.stringify({ ...r, generatedAt })).join('\n') + '\n'
    : '';
  fs.writeFileSync(options.outPath, content, 'utf-8');

  return {
    generatedAt,
    enrollmentsRead:       enrollments.length,
    observedEnrollments:   observedAll.length,
    unobservedEnrollments: unobservedAll.length,
    bestComboCount:        bestComboRows.length,
    bestComboObserved:     bestComboRows.filter(r => r.outcome !== 'UNOBSERVED').length,
    bestComboGroup,
    controlGroup,
    ageGte10mGroup,
    liqLt10kGroup,
    liqOrAgeGroup,
    overallDecision,
    outPath:               options.outPath,
    rowsWritten:           classified.length,
    reportOnly:            true,
    readOnly:              true,
    tradingExecuted:       0,
    realTradingLocked:     true,
    paperOnly:             true,
  };
}

// ── Renderer helpers ──────────────────────────────────────────────────────────

function fmtRate(v: number | null): string {
  return v != null ? `${v}%` : 'n/a';
}

function fmtNum(v: number | null): string {
  return v != null ? String(v) : 'n/a';
}

function recLabel(r: GroupRecommendation): string {
  switch (r) {
    case 'PROMISING_SHADOW_FILTER':   return '✓ PROMISING_SHADOW_FILTER';
    case 'WATCH_MORE_DATA':           return '~ WATCH_MORE_DATA';
    case 'TOO_MANY_WINNERS_KILLED':   return '✗ TOO_MANY_WINNERS_KILLED';
    case 'NO_CLEAR_EDGE':             return '- NO_CLEAR_EDGE';
  }
}

function renderGroupBlock(g: GroupStats, lines: string[]): void {
  const SEP2 = '────────────────────────────────────────────────────────────────';
  lines.push(`  ${SEP2}`);
  lines.push(`  ${g.groupName.toUpperCase()}`);
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Enrolled              : ${g.enrolledCount}`);
  lines.push(`  Observed              : ${g.observedCount}`);
  lines.push(`  Unobserved            : ${g.unobservedCount}`);
  lines.push('');
  lines.push(`  Flat junk             : ${g.flatJunkCount} / ${g.observedCount} (${fmtRate(g.flatJunkRate)})`);
  lines.push(`  Dumps                 : ${g.dumpCount} / ${g.observedCount} (${fmtRate(g.dumpRate)})`);
  lines.push(`  Winners >= +1%        : ${g.win1Count} / ${g.observedCount} (${fmtRate(g.win1Rate)})`);
  lines.push(`  Winners >= +3%        : ${g.win3Count} / ${g.observedCount} (${fmtRate(g.win3Rate)})`);
  lines.push(`  Winners >= +5%        : ${g.win5Count} / ${g.observedCount} (${fmtRate(g.win5Rate)})`);
  lines.push(`  Avg price change      : ${fmtNum(g.avgMove)}%`);
  lines.push(`  Median price change   : ${fmtNum(g.medianMove)}%`);
  lines.push(`  Recommendation        : ${recLabel(g.recommendation)}`);
  lines.push('');
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderShadowEnrolledOutcomeReport(
  result: ShadowEnrolledOutcomeResult,
): string {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const SEP2 = '────────────────────────────────────────────────────────────────';
  const lines: string[] = ['', SEP];
  lines.push('  TOKEN GRAB — SHADOW ENROLLED OUTCOME REPORT');
  lines.push('  [REPORT ONLY — NO TRADES — NO PAPER POSITIONS — READ ONLY]');
  lines.push('  DO NOT ENABLE REAL TRADING  |  DO NOT CHANGE PRODUCTION GATES');
  lines.push(SEP, '');

  lines.push(`  ${SEP2}`);
  lines.push('  SUMMARY');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  Enrollments read          : ${result.enrollmentsRead}`);
  lines.push(`  Observed enrollments      : ${result.observedEnrollments}`);
  lines.push(`  Unobserved enrollments    : ${result.unobservedEnrollments}`);
  lines.push(`  Best combo would-reject   : ${result.bestComboCount}`);
  lines.push(`  Best combo observed       : ${result.bestComboObserved}`);
  lines.push(`  Generated at              : ${result.generatedAt}`);
  lines.push('');

  lines.push(`  ${SEP2}`);
  lines.push('  BEST COMBO OUTCOME  (liq_OR_age — candidates that WOULD have been rejected)');
  lines.push(`  ${SEP2}`, '');
  renderGroupBlock(result.bestComboGroup, lines);

  lines.push(`  ${SEP2}`);
  lines.push('  CONTROL GROUP OUTCOME  (candidates that would NOT have been rejected)');
  lines.push(`  ${SEP2}`, '');
  renderGroupBlock(result.controlGroup, lines);

  lines.push(`  ${SEP2}`);
  lines.push('  INDIVIDUAL FILTER OUTCOMES');
  lines.push(`  ${SEP2}`, '');
  renderGroupBlock(result.ageGte10mGroup, lines);
  renderGroupBlock(result.liqLt10kGroup,  lines);
  renderGroupBlock(result.liqOrAgeGroup,  lines);

  lines.push(`  ${SEP2}`);
  lines.push('  DECISION');
  lines.push(`  ${SEP2}`, '');
  lines.push(`  ${result.overallDecision}`);
  if (result.overallDecision === 'READY_FOR_PAPER_POLICY_TEST') {
    lines.push('  Best combo shows promising signal.');
    lines.push('  Next step: propose paper-only policy test. Do NOT change production gates.');
  } else {
    lines.push('  Continue shadow enrollment. Collect more observations before proposing gate changes.');
  }
  lines.push('  HOLD_CURRENT_GATES');
  lines.push('  DO_NOT_ENABLE_REAL_TRADING');
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
