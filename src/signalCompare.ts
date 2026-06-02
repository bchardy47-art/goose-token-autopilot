import type { AppDb } from './db';
import type { AppConfig, WatchOnlySignalClass } from './types';
import { buildSignalAuditReport, type SignalAuditCandidateRow } from './signalAudit';

const DEFAULT_LEFT_CLASS: WatchOnlySignalClass = 'EARLY_RUNNER';
const DEFAULT_RIGHT_CLASS: WatchOnlySignalClass = 'INSTANT_DUMP';

type CompareFormat = 'json' | 'table';
type RoughDirection = 'HIGHER_IN_EARLY_RUNNERS' | 'HIGHER_IN_INSTANT_DUMPS' | 'SIMILAR' | 'INSUFFICIENT_DATA';

export interface SignalCompareReport {
  summary: Record<string, unknown>;
  metricComparison: Record<string, unknown>;
  booleanProfileComparison: Record<string, unknown>;
  redFlagComparison: Record<string, unknown>;
  positiveReasonComparison: Record<string, unknown>;
  candidateExamples: Record<string, unknown>;
  operatorRecommendation: string[];
  finalSafetyStatus: 'Real trading remains locked.';
}

function parseFormat(raw: string | undefined): CompareFormat {
  return raw === 'table' ? 'table' : 'json';
}

function parseClass(raw: string | undefined, fallback: WatchOnlySignalClass): WatchOnlySignalClass {
  const allowed: WatchOnlySignalClass[] = ['EARLY_RUNNER', 'LATE_RUNNER', 'INSTANT_DUMP', 'DEAD_NOISE', 'TOO_DANGEROUS'];
  return allowed.includes(raw as WatchOnlySignalClass) ? (raw as WatchOnlySignalClass) : fallback;
}

function average(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (filtered.length === 0) return null;
  return Number((filtered.reduce((sum, value) => sum + value, 0) / filtered.length).toFixed(4));
}

function median(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (filtered.length === 0) return null;
  const mid = Math.floor(filtered.length / 2);
  return filtered.length % 2 === 0
    ? Number(((filtered[mid - 1] + filtered[mid]) / 2).toFixed(4))
    : Number(filtered[mid].toFixed(4));
}

function difference(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return Number((left - right).toFixed(4));
}

function roughDirection(left: number | null, right: number | null): RoughDirection {
  if (left === null || right === null) return 'INSUFFICIENT_DATA';
  const delta = left - right;
  if (Math.abs(delta) < 0.0001) return 'SIMILAR';
  return delta > 0 ? 'HIGHER_IN_EARLY_RUNNERS' : 'HIGHER_IN_INSTANT_DUMPS';
}

function topItems(items: string[], limit = 5): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function moreCommon(left: SignalAuditCandidateRow[], right: SignalAuditCandidateRow[], selector: (row: SignalAuditCandidateRow) => string[]): Array<{ value: string; leftCount: number; rightCount: number; difference: number }> {
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();

  for (const row of left) {
    for (const value of selector(row)) leftCounts.set(value, (leftCounts.get(value) ?? 0) + 1);
  }
  for (const row of right) {
    for (const value of selector(row)) rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);
  }

  const values = new Set([...leftCounts.keys(), ...rightCounts.keys()]);
  return [...values]
    .map((value) => {
      const leftCount = leftCounts.get(value) ?? 0;
      const rightCount = rightCounts.get(value) ?? 0;
      return { value, leftCount, rightCount, difference: leftCount - rightCount };
    })
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.value.localeCompare(b.value))
    .slice(0, 5);
}

function knownPercent(rows: SignalAuditCandidateRow[], selector: (row: SignalAuditCandidateRow) => string | null): number | null {
  if (rows.length === 0) return null;
  return Number((((rows.filter((row) => {
    const value = selector(row);
    return value !== null && value !== 'UNKNOWN';
  }).length / rows.length) * 100)).toFixed(2));
}

function metricBlock(left: SignalAuditCandidateRow[], right: SignalAuditCandidateRow[], selector: (row: SignalAuditCandidateRow) => number | null | undefined) {
  const leftAverage = average(left.map(selector));
  const rightAverage = average(right.map(selector));
  return {
    leftAverage,
    rightAverage,
    leftMedian: median(left.map(selector)),
    rightMedian: median(right.map(selector)),
    difference: difference(leftAverage, rightAverage),
    roughDirection: roughDirection(leftAverage, rightAverage)
  };
}

function booleanPercent(rows: SignalAuditCandidateRow[], selector: (row: SignalAuditCandidateRow) => boolean): number | null {
  if (rows.length === 0) return null;
  return Number((((rows.filter(selector).length / rows.length) * 100)).toFixed(2));
}

function compactExample(row: SignalAuditCandidateRow) {
  return {
    id: row.watchCandidateId,
    symbol: row.symbol,
    bestGainPct: row.bestGainPct,
    worstDrawdownPct: row.worstDrawdownPct,
    movedBeforeDiscoveryPct: row.movedBeforeDiscoveryPct,
    liquidityUsdAtEntry: row.liquidityUsdAtEntry,
    volume5mUsdAtEntry: row.volume5mUsdAtEntry,
    volume1hUsdAtEntry: row.volume1hUsdAtEntry,
    buySellRatioAtEntry: row.buySellRatioAtEntry,
    tokenAgeMinutesAtEntry: row.tokenAgeMinutesAtEntry,
    mintAuth: row.mintAuthority,
    freezeAuth: row.freezeAuthority,
    holder: row.holderConcentration,
    top10Pct: row.top10HolderPct,
    safetyStatus: row.safetyStatus,
    topRedFlags: row.topRedFlags,
    topPositiveReasons: row.topPositiveReasons,
    sourceUrl: row.sourceUrl
  };
}

export function buildSignalCompareReport(db: AppDb, config: AppConfig, env: NodeJS.ProcessEnv = process.env): SignalCompareReport {
  const leftClass = parseClass(env.SIGNAL_COMPARE_LEFT_CLASS, DEFAULT_LEFT_CLASS);
  const rightClass = parseClass(env.SIGNAL_COMPARE_RIGHT_CLASS, DEFAULT_RIGHT_CLASS);
  const audit = buildSignalAuditReport(db, config, { ...env, SIGNAL_AUDIT_LIMIT: env.SIGNAL_AUDIT_LIMIT ?? '1000' });
  const rows = audit.candidateRows;
  const leftRows = rows.filter((row) => row.signalClass === leftClass);
  const rightRows = rows.filter((row) => row.signalClass === rightClass);
  const sampleSizeWarning = leftRows.length < 10 || rightRows.length < 10
    ? `Small sample warning: ${leftClass}=${leftRows.length}, ${rightClass}=${rightRows.length}`
    : null;

  const summary = {
    leftClass,
    rightClass,
    leftCount: leftRows.length,
    rightCount: rightRows.length,
    sampleSizeWarning,
    finalSafetyStatus: 'Real trading remains locked.',
    conclusion: [
      'Research only',
      'No trade readiness',
      'Need safety enrichment before paper/live trading'
    ],
    knownSafetyFieldComparison: {
      freezeAuthorityKnownPct: { left: knownPercent(leftRows, (row) => row.freezeAuthority), right: knownPercent(rightRows, (row) => row.freezeAuthority) },
      mintAuthorityKnownPct: { left: knownPercent(leftRows, (row) => row.mintAuthority), right: knownPercent(rightRows, (row) => row.mintAuthority) },
      sellQuoteAvailableKnownPct: { left: knownPercent(leftRows, (row) => row.sellQuoteAvailable), right: knownPercent(rightRows, (row) => row.sellQuoteAvailable) },
      holderConcentrationKnownPct: { left: knownPercent(leftRows, (row) => row.holderConcentration), right: knownPercent(rightRows, (row) => row.holderConcentration) }
    },
    safetyComparison: {
      holderSafePct: { left: booleanPercent(leftRows, (row) => row.holderConcentration === 'SAFE'), right: booleanPercent(rightRows, (row) => row.holderConcentration === 'SAFE') },
      holderRiskyPct: { left: booleanPercent(leftRows, (row) => row.holderConcentration === 'RISKY'), right: booleanPercent(rightRows, (row) => row.holderConcentration === 'RISKY') },
      holderUnknownPct: { left: booleanPercent(leftRows, (row) => row.holderConcentration === 'UNKNOWN' || row.holderConcentration === null), right: booleanPercent(rightRows, (row) => row.holderConcentration === 'UNKNOWN' || row.holderConcentration === null) },
      freezeAuthorityUnsafePct: { left: booleanPercent(leftRows, (row) => row.freezeAuthority === 'UNSAFE'), right: booleanPercent(rightRows, (row) => row.freezeAuthority === 'UNSAFE') },
      mintAuthorityUnsafePct: { left: booleanPercent(leftRows, (row) => row.mintAuthority === 'UNSAFE'), right: booleanPercent(rightRows, (row) => row.mintAuthority === 'UNSAFE') },
      averageTopHolderPct: { left: average(leftRows.map((row) => row.topHolderPct)), right: average(rightRows.map((row) => row.topHolderPct)) },
      averageTop10HolderPct: { left: average(leftRows.map((row) => row.top10HolderPct)), right: average(rightRows.map((row) => row.top10HolderPct)) },
      averageBestGainForRiskyHolder: { left: average(leftRows.filter((row) => row.holderConcentration === 'RISKY').map((row) => row.bestGainPct)), right: average(rightRows.filter((row) => row.holderConcentration === 'RISKY').map((row) => row.bestGainPct)) },
      averageWorstDrawdownForRiskyHolder: { left: average(leftRows.filter((row) => row.holderConcentration === 'RISKY').map((row) => row.worstDrawdownPct)), right: average(rightRows.filter((row) => row.holderConcentration === 'RISKY').map((row) => row.worstDrawdownPct)) },
      averageBestGainForSafeHolder: { left: average(leftRows.filter((row) => row.holderConcentration === 'SAFE').map((row) => row.bestGainPct)), right: average(rightRows.filter((row) => row.holderConcentration === 'SAFE').map((row) => row.bestGainPct)) },
      averageWorstDrawdownForSafeHolder: { left: average(leftRows.filter((row) => row.holderConcentration === 'SAFE').map((row) => row.worstDrawdownPct)), right: average(rightRows.filter((row) => row.holderConcentration === 'SAFE').map((row) => row.worstDrawdownPct)) }
    }
  };

  const metricComparison = {
    bestGainPct: metricBlock(leftRows, rightRows, (row) => row.bestGainPct),
    worstDrawdownPct: metricBlock(leftRows, rightRows, (row) => row.worstDrawdownPct),
    movedBeforeDiscoveryPct: metricBlock(leftRows, rightRows, (row) => row.movedBeforeDiscoveryPct),
    liquidityUsdAtEntry: metricBlock(leftRows, rightRows, (row) => row.liquidityUsdAtEntry),
    latestLiquidityUsd: metricBlock(leftRows, rightRows, (row) => row.latestLiquidityUsd),
    volume5mUsdAtEntry: metricBlock(leftRows, rightRows, (row) => row.volume5mUsdAtEntry),
    volume1hUsdAtEntry: metricBlock(leftRows, rightRows, (row) => row.volume1hUsdAtEntry),
    latestVolume5mUsd: metricBlock(leftRows, rightRows, (row) => row.latestVolume5mUsd),
    latestVolume1hUsd: metricBlock(leftRows, rightRows, (row) => row.latestVolume1hUsd),
    buySellRatioAtEntry: metricBlock(leftRows, rightRows, (row) => row.buySellRatioAtEntry),
    latestBuySellRatio: metricBlock(leftRows, rightRows, (row) => row.latestBuySellRatio),
    tokenAgeMinutesAtEntry: metricBlock(leftRows, rightRows, (row) => row.tokenAgeMinutesAtEntry),
    scoreTotalAtEntry: metricBlock(leftRows, rightRows, (row) => row.scoreTotalAtEntry),
    momentumScoreAtEntry: metricBlock(leftRows, rightRows, (row) => row.momentumScoreAtEntry),
    safetyScoreAtEntry: metricBlock(leftRows, rightRows, (row) => row.safetyScoreAtEntry),
    socialScoreAtEntry: metricBlock(leftRows, rightRows, (row) => row.socialScoreAtEntry)
  };

  const booleanProfileComparison = {
    websitePresent: { leftPercentTrue: booleanPercent(leftRows, (row) => row.websitePresent === true), rightPercentTrue: booleanPercent(rightRows, (row) => row.websitePresent === true) },
    socialsPresent: { leftPercentTrue: booleanPercent(leftRows, (row) => row.socialsPresent === true), rightPercentTrue: booleanPercent(rightRows, (row) => row.socialsPresent === true) },
    metadataPresent: { leftPercentTrue: booleanPercent(leftRows, (row) => row.metadataPresent === true), rightPercentTrue: booleanPercent(rightRows, (row) => row.metadataPresent === true) },
    freezeAuthorityKnown: { leftPercentTrue: booleanPercent(leftRows, (row) => row.freezeAuthority !== null && row.freezeAuthority !== 'UNKNOWN'), rightPercentTrue: booleanPercent(rightRows, (row) => row.freezeAuthority !== null && row.freezeAuthority !== 'UNKNOWN') },
    mintAuthorityKnown: { leftPercentTrue: booleanPercent(leftRows, (row) => row.mintAuthority !== null && row.mintAuthority !== 'UNKNOWN'), rightPercentTrue: booleanPercent(rightRows, (row) => row.mintAuthority !== null && row.mintAuthority !== 'UNKNOWN') },
    sellQuoteAvailableKnown: { leftPercentTrue: booleanPercent(leftRows, (row) => row.sellQuoteAvailable !== null && row.sellQuoteAvailable !== 'UNKNOWN'), rightPercentTrue: booleanPercent(rightRows, (row) => row.sellQuoteAvailable !== null && row.sellQuoteAvailable !== 'UNKNOWN') },
    holderConcentrationKnown: { leftPercentTrue: booleanPercent(leftRows, (row) => row.holderConcentration !== null && row.holderConcentration !== 'UNKNOWN'), rightPercentTrue: booleanPercent(rightRows, (row) => row.holderConcentration !== null && row.holderConcentration !== 'UNKNOWN') },
    creatorStatusKnown: { leftPercentTrue: booleanPercent(leftRows, (row) => row.creatorStatus !== null && row.creatorStatus !== 'UNKNOWN'), rightPercentTrue: booleanPercent(rightRows, (row) => row.creatorStatus !== null && row.creatorStatus !== 'UNKNOWN') }
  };

  const redFlagComparison = {
    commonInLeftClass: topItems(leftRows.flatMap((row) => row.topRedFlags)),
    commonInRightClass: topItems(rightRows.flatMap((row) => row.topRedFlags)),
    moreCommonInDumps: moreCommon(rightRows, leftRows, (row) => row.topRedFlags),
    moreCommonInEarlyRunners: moreCommon(leftRows, rightRows, (row) => row.topRedFlags)
  };

  const positiveReasonComparison = {
    commonInLeftClass: topItems(leftRows.flatMap((row) => row.topPositiveReasons)),
    commonInRightClass: topItems(rightRows.flatMap((row) => row.topPositiveReasons)),
    moreCommonInEarlyRunners: moreCommon(leftRows, rightRows, (row) => row.topPositiveReasons),
    moreCommonInDumps: moreCommon(rightRows, leftRows, (row) => row.topPositiveReasons)
  };

  const candidateExamples = {
    leftClassTopRows: [...leftRows].sort((a, b) => (b.bestGainPct ?? Number.NEGATIVE_INFINITY) - (a.bestGainPct ?? Number.NEGATIVE_INFINITY)).slice(0, 5).map(compactExample),
    rightClassTopRows: [...rightRows].sort((a, b) => (a.worstDrawdownPct ?? Number.POSITIVE_INFINITY) - (b.worstDrawdownPct ?? Number.POSITIVE_INFINITY)).slice(0, 5).map(compactExample)
  };

  const operatorRecommendation: string[] = [];
  if (rows.length < 50) operatorRecommendation.push('Need more samples; continue collecting watch loop data.');
  const unknownDominates = rows.length > 0 && rows.filter((row) => row.freezeAuthority === 'UNKNOWN' || row.mintAuthority === 'UNKNOWN' || row.sellQuoteAvailable === 'UNKNOWN' || row.holderConcentration === 'UNKNOWN').length / rows.length >= 0.5;
  if (unknownDominates) operatorRecommendation.push('Safety enrichment is required before paper/live trading.');
  if (leftRows.some((row) => row.holderConcentration === 'RISKY') && rightRows.some((row) => row.holderConcentration === 'RISKY')) {
    operatorRecommendation.push('Holder concentration is a risk penalty, not a clean filter.');
  }
  if (rows.some((row) => row.freezeAuthority === 'UNSAFE')) {
    operatorRecommendation.push('Freeze authority unsafe should remain a hard red flag.');
  }
  if (rows.some((row) => row.mintAuthority === 'UNSAFE')) {
    operatorRecommendation.push('Mint authority unsafe should remain a hard red flag.');
  }
  if (rows.some((row) => row.sellQuoteAvailable === 'UNKNOWN' || row.sellQuoteAvailable === 'NO' || row.sellQuoteAvailable === null)) {
    operatorRecommendation.push('Quote/sellability checks are still required before paper/live trading.');
  }

  const candidateSignals = Object.entries(metricComparison)
    .filter(([, value]) => (value as any).roughDirection !== 'SIMILAR' && (value as any).roughDirection !== 'INSUFFICIENT_DATA')
    .slice(0, 5)
    .map(([metric, value]) => `${metric} is a candidate signal (${(value as any).roughDirection}).`);
  operatorRecommendation.push(...candidateSignals);
  operatorRecommendation.push('Recommended next action: collect more loop data, add safety enrichment, and tune watch-only classification only—not trading gates.');

  return {
    summary,
    metricComparison,
    booleanProfileComparison,
    redFlagComparison,
    positiveReasonComparison,
    candidateExamples,
    operatorRecommendation,
    finalSafetyStatus: 'Real trading remains locked.'
  };
}

export function formatSignalCompareTable(report: SignalCompareReport): string {
  const summary = report.summary as Record<string, unknown>;
  const leftRows = (report.candidateExamples.leftClassTopRows as Array<Record<string, unknown>> | undefined) ?? [];
  const rightRows = (report.candidateExamples.rightClassTopRows as Array<Record<string, unknown>> | undefined) ?? [];

  const formatRows = (title: string, rows: Array<Record<string, unknown>>) => [
    title,
    ...rows.map((row) => `${row.id} | ${row.symbol} | best=${row.bestGainPct} | dd=${row.worstDrawdownPct} | moveBefore=${row.movedBeforeDiscoveryPct} | liq=${row.liquidityUsdAtEntry} | mintAuth=${row.mintAuth ?? '-'} | freezeAuth=${row.freezeAuth ?? '-'} | holder=${row.holder ?? '-'} | top10Pct=${row.top10Pct ?? '-'} | safetyStatus=${row.safetyStatus ?? '-'}`)
  ].join('\n');

  return [
    'Signal Compare Report',
    JSON.stringify(summary, null, 2),
    '',
    formatRows(String(summary.leftClass), leftRows),
    '',
    formatRows(String(summary.rightClass), rightRows),
    '',
    `Operator recommendation: ${report.operatorRecommendation.join(' ')}`,
    report.finalSafetyStatus
  ].join('\n');
}

export function renderSignalCompare(report: SignalCompareReport, env: NodeJS.ProcessEnv = process.env): string {
  return parseFormat(env.SIGNAL_COMPARE_FORMAT) === 'table'
    ? formatSignalCompareTable(report)
    : JSON.stringify(report, null, 2);
}
