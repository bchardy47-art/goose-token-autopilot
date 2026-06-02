import type { AppDb } from './db';
import type { AppConfig, TokenCandidate, TokenScoreResult, WatchOnlyCandidate, WatchOnlyOutcome, WatchOnlySignalAnalysis, WatchOnlySignalClass, SolanaSafetyEnrichmentRow } from './types';

const ALL_CLASSES: WatchOnlySignalClass[] = ['EARLY_RUNNER', 'LATE_RUNNER', 'INSTANT_DUMP', 'DEAD_NOISE', 'TOO_DANGEROUS'];
const ALL_WINDOWS = ['15m', '1h', '6h', '24h'] as const;
const DEFAULT_SIGNAL_AUDIT_LIMIT = 50;

type AuditFormat = 'json' | 'table';

interface ParsedWatchCandidateRaw {
  score?: TokenScoreResult;
  snapshot?: TokenCandidate;
  redFlags?: string[];
}

interface CandidateRowBuildContext {
  analysis: WatchOnlySignalAnalysis | null;
  tokenRecord: any | null;
  entrySnapshot: TokenCandidate | null;
  latestSnapshot: TokenCandidate | null;
  entryScore: TokenScoreResult | null;
  latestEnrichment: SolanaSafetyEnrichmentRow | null;
}

export interface SignalAuditCandidateRow {
  watchCandidateId: number;
  tokenId: number;
  symbol: string | null;
  name: string | null;
  signalClass: WatchOnlySignalClass | null;
  createdAt: string;
  tokenAgeMinutesAtEntry: number | null;
  entryPriceUsd: number | null;
  latestPriceUsd: number | null;
  bestGainPct: number | null;
  worstDrawdownPct: number | null;
  movedBeforeDiscoveryPct: number | null;
  liquidityUsdAtEntry: number | null;
  latestLiquidityUsd: number | null;
  volume5mUsdAtEntry: number | null;
  volume1hUsdAtEntry: number | null;
  latestVolume5mUsd: number | null;
  latestVolume1hUsd: number | null;
  buySellRatioAtEntry: number | null;
  latestBuySellRatio: number | null;
  scoreTotalAtEntry: number | null;
  momentumScoreAtEntry: number | null;
  safetyScoreAtEntry: number | null;
  socialScoreAtEntry: number | null;
  websitePresent: boolean | null;
  socialsPresent: boolean | null;
  metadataPresent: boolean | null;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  sellQuoteAvailable: string | null;
  holderConcentration: string | null;
  creatorStatus: string | null;
  topRedFlags: string[];
  topPositiveReasons: string[];
  sourceUrl: string | null;
}

export interface SignalAuditReport {
  summary: Record<string, unknown>;
  candidateRows: SignalAuditCandidateRow[];
  classSections: Record<string, unknown>;
  comparison: Record<string, unknown>;
  operatorConclusion: string[];
  finalSafetyStatus: 'Real trading remains locked.';
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) return fallback;
  return value;
}

function parseFormat(raw: string | undefined): AuditFormat {
  return raw === 'table' ? 'table' : 'json';
}

function parseClassFilter(raw: string | undefined): WatchOnlySignalClass[] | null {
  if (!raw) return null;
  const requested = raw.split(',').map((value) => value.trim()).filter(Boolean);
  const valid = requested.filter((value): value is WatchOnlySignalClass => ALL_CLASSES.includes(value as WatchOnlySignalClass));
  return valid.length > 0 ? valid : null;
}

function parseParsedRaw(rawJson: string): ParsedWatchCandidateRaw {
  try {
    return JSON.parse(rawJson) as ParsedWatchCandidateRaw;
  } catch {
    return {};
  }
}

function safeAverage(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (filtered.length === 0) return null;
  return Number((filtered.reduce((sum, value) => sum + value, 0) / filtered.length).toFixed(4));
}

function safeMax(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (filtered.length === 0) return null;
  return Number(Math.max(...filtered).toFixed(4));
}

function safeMin(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (filtered.length === 0) return null;
  return Number(Math.min(...filtered).toFixed(4));
}

function topItems(items: string[], limit = 5): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function buySellRatio(snapshot: TokenCandidate | null): number | null {
  if (!snapshot) return null;
  return Number((((snapshot.buys5m ?? 0) / Math.max(1, snapshot.sells5m ?? 0))).toFixed(4));
}

function tokenAgeMinutesAtEntry(snapshot: TokenCandidate | null, createdAt: string): number | null {
  if (!snapshot?.tokenCreatedAt) return null;
  const created = new Date(snapshot.tokenCreatedAt).getTime();
  const entry = new Date(createdAt).getTime();
  if (Number.isNaN(created) || Number.isNaN(entry)) return null;
  return Number(((entry - created) / 60_000).toFixed(2));
}

function reasonsFromScore(score: TokenScoreResult | null): string[] {
  return score?.reasons ?? [];
}

function redFlagsFromParsedRaw(parsedRaw: ParsedWatchCandidateRaw, score: TokenScoreResult | null): string[] {
  return (parsedRaw.redFlags ?? score?.redFlags ?? []).slice(0, 5);
}

function preferKnown<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (value === 'UNKNOWN') continue;
    return value as T;
  }
  for (const value of values) {
    if (value !== undefined && value !== null) return value as T;
  }
  return null;
}

function buildCandidateRow(
  candidate: WatchOnlyCandidate,
  context: CandidateRowBuildContext
): SignalAuditCandidateRow {
  const { analysis, tokenRecord, entrySnapshot, latestSnapshot, entryScore, latestEnrichment } = context;
  const positiveReasons = reasonsFromScore(entryScore).filter((reason) => /supportive|liquidity|slippage|passes|strong enough|momentum/i.test(reason)).slice(0, 5);
  const parsedRaw = parseParsedRaw(candidate.rawJson);

  return {
    watchCandidateId: candidate.id,
    tokenId: candidate.tokenId,
    symbol: tokenRecord?.symbol ?? entrySnapshot?.symbol ?? latestSnapshot?.symbol ?? null,
    name: tokenRecord?.name ?? entrySnapshot?.name ?? latestSnapshot?.name ?? null,
    signalClass: analysis?.signalClass ?? null,
    createdAt: candidate.createdAt,
    tokenAgeMinutesAtEntry: tokenAgeMinutesAtEntry(entrySnapshot, candidate.createdAt),
    entryPriceUsd: candidate.entryPriceUsd,
    latestPriceUsd: latestSnapshot?.priceUsd ?? candidate.latestPriceUsd,
    bestGainPct: candidate.bestGainPct,
    worstDrawdownPct: candidate.worstDrawdownPct,
    movedBeforeDiscoveryPct: analysis?.movedBeforeDiscoveryPct ?? entrySnapshot?.movedBeforeDiscoveryPct ?? null,
    liquidityUsdAtEntry: candidate.liquidityUsd,
    latestLiquidityUsd: latestSnapshot?.liquidityUsd ?? candidate.liquidityUsd,
    volume5mUsdAtEntry: candidate.volume5mUsd,
    volume1hUsdAtEntry: candidate.volume1hUsd,
    latestVolume5mUsd: latestSnapshot?.volume5mUsd ?? null,
    latestVolume1hUsd: latestSnapshot?.volume1hUsd ?? null,
    buySellRatioAtEntry: buySellRatio(entrySnapshot),
    latestBuySellRatio: buySellRatio(latestSnapshot),
    scoreTotalAtEntry: entryScore?.totalScore ?? null,
    momentumScoreAtEntry: entryScore?.momentumScore ?? null,
    safetyScoreAtEntry: entryScore?.safetyScore ?? null,
    socialScoreAtEntry: entryScore?.socialScore ?? null,
    websitePresent: entrySnapshot?.websitePresent ?? latestSnapshot?.websitePresent ?? null,
    socialsPresent: entrySnapshot?.socialsPresent ?? latestSnapshot?.socialsPresent ?? null,
    metadataPresent: entrySnapshot?.metadataPresent ?? latestSnapshot?.metadataPresent ?? null,
    freezeAuthority: preferKnown(latestEnrichment?.freezeAuthority, analysis?.freezeAuthority, latestSnapshot?.freezeAuthority, entrySnapshot?.freezeAuthority),
    mintAuthority: preferKnown(latestEnrichment?.mintAuthority, analysis?.mintAuthority, latestSnapshot?.mintAuthority, entrySnapshot?.mintAuthority),
    sellQuoteAvailable: preferKnown(analysis?.sellQuoteAvailable, latestSnapshot?.sellQuoteAvailable, entrySnapshot?.sellQuoteAvailable),
    holderConcentration: preferKnown(latestEnrichment?.holderConcentrationStatus, latestSnapshot?.holderConcentration, entrySnapshot?.holderConcentration),
    creatorStatus: preferKnown(latestEnrichment?.creatorStatus, latestSnapshot?.creatorStatus, entrySnapshot?.creatorStatus),
    topRedFlags: redFlagsFromParsedRaw(parsedRaw, entryScore),
    topPositiveReasons: positiveReasons,
    sourceUrl: entrySnapshot?.sourceUrl ?? latestSnapshot?.sourceUrl ?? tokenRecord?.source_url ?? null
  };
}

function buildClassSection(rows: SignalAuditCandidateRow[]): Record<string, unknown> {
  return {
    count: rows.length,
    bestGain: safeMax(rows.map((row) => row.bestGainPct)),
    worstDrawdown: safeMin(rows.map((row) => row.worstDrawdownPct)),
    averageBestGain: safeAverage(rows.map((row) => row.bestGainPct)),
    averageWorstDrawdown: safeAverage(rows.map((row) => row.worstDrawdownPct)),
    averageMovedBeforeDiscovery: safeAverage(rows.map((row) => row.movedBeforeDiscoveryPct)),
    topRedFlags: topItems(rows.flatMap((row) => row.topRedFlags)),
    topPositiveReasons: topItems(rows.flatMap((row) => row.topPositiveReasons)),
    top5ByBestGain: [...rows]
      .sort((a, b) => (b.bestGainPct ?? Number.NEGATIVE_INFINITY) - (a.bestGainPct ?? Number.NEGATIVE_INFINITY))
      .slice(0, 5),
    top5ByWorstDrawdown: [...rows]
      .sort((a, b) => (a.worstDrawdownPct ?? Number.POSITIVE_INFINITY) - (b.worstDrawdownPct ?? Number.POSITIVE_INFINITY))
      .slice(0, 5)
  };
}

function buildComparisonSection(rows: SignalAuditCandidateRow[]): Record<string, unknown> {
  const early = rows.filter((row) => row.signalClass === 'EARLY_RUNNER');
  const instant = rows.filter((row) => row.signalClass === 'INSTANT_DUMP');
  const summarize = (items: SignalAuditCandidateRow[]) => ({
    averageLiquidity: safeAverage(items.map((row) => row.liquidityUsdAtEntry)),
    average5mVolume: safeAverage(items.map((row) => row.volume5mUsdAtEntry)),
    average1hVolume: safeAverage(items.map((row) => row.volume1hUsdAtEntry)),
    averageBuySellRatio: safeAverage(items.map((row) => row.buySellRatioAtEntry)),
    averageMovedBeforeDiscovery: safeAverage(items.map((row) => row.movedBeforeDiscoveryPct)),
    topRedFlags: topItems(items.flatMap((row) => row.topRedFlags)),
    topPositiveReasons: topItems(items.flatMap((row) => row.topPositiveReasons))
  });

  return {
    earlyRunnerVsInstantDump: {
      earlyRunner: summarize(early),
      instantDump: summarize(instant)
    }
  };
}

function buildOperatorConclusion(rows: SignalAuditCandidateRow[]): string[] {
  const conclusions: string[] = [];
  const earlyLateCount = rows.filter((row) => row.signalClass === 'EARLY_RUNNER' || row.signalClass === 'LATE_RUNNER').length;
  if (earlyLateCount > 0) conclusions.push('Radar is finding movement');

  const unknownSafetyRows = rows.filter((row) =>
    row.freezeAuthority === 'UNKNOWN' ||
    row.mintAuthority === 'UNKNOWN' ||
    row.sellQuoteAvailable === 'UNKNOWN' ||
    row.holderConcentration === 'UNKNOWN'
  );
  if (unknownSafetyRows.length > 0) conclusions.push('No trade readiness');

  if (rows.length > 0) {
    const mostlyUnknown = unknownSafetyRows.length / rows.length >= 0.5;
    if (mostlyUnknown) conclusions.push('Need safety enrichment');
  }

  if (rows.length < 50) conclusions.push('Need more samples');
  return conclusions;
}

export function buildSignalAuditReport(db: AppDb, config: AppConfig, env: NodeJS.ProcessEnv = process.env): SignalAuditReport {
  const limit = parsePositiveInteger(env.SIGNAL_AUDIT_LIMIT, DEFAULT_SIGNAL_AUDIT_LIMIT);
  const minGainPct = env.SIGNAL_AUDIT_MIN_GAIN_PCT === undefined || env.SIGNAL_AUDIT_MIN_GAIN_PCT === '' ? null : Number(env.SIGNAL_AUDIT_MIN_GAIN_PCT);
  const classFilter = parseClassFilter(env.SIGNAL_AUDIT_CLASS);

  const candidates = db.listWatchOnlyCandidates();
  const analyses = db.listWatchOnlySignalAnalyses();
  const outcomes = db.listWatchOnlyOutcomes();
  const analysisByCandidate = new Map(analyses.map((analysis) => [analysis.watchCandidateId, analysis]));

  let rows = candidates.map((candidate) => {
    const tokenRecord = db.getTokenRecord(candidate.tokenId);
    const latestSnapshot = db.getLatestSnapshot(candidate.tokenId);
    const latestEnrichment = db.getLatestSolanaSafetyEnrichment(candidate.tokenId);
    const entryScore = (() => {
      const parsed = parseParsedRaw(candidate.rawJson);
      return parsed.score ?? db.getLatestScore(candidate.tokenId);
    })();
    const entrySnapshot = (() => {
      const parsed = parseParsedRaw(candidate.rawJson);
      return parsed.snapshot ?? latestSnapshot;
    })();
    return buildCandidateRow(candidate, {
      analysis: analysisByCandidate.get(candidate.id) ?? null,
      tokenRecord,
      entrySnapshot,
      latestSnapshot,
      entryScore,
      latestEnrichment
    });
  });

  if (classFilter) {
    rows = rows.filter((row) => row.signalClass !== null && classFilter.includes(row.signalClass));
  }
  if (Number.isFinite(minGainPct)) {
    rows = rows.filter((row) => (row.bestGainPct ?? Number.NEGATIVE_INFINITY) >= Number(minGainPct));
  }

  rows = [...rows]
    .sort((a, b) => (b.bestGainPct ?? Number.NEGATIVE_INFINITY) - (a.bestGainPct ?? Number.NEGATIVE_INFINITY))
    .slice(0, limit);

  const classCounts = Object.fromEntries(ALL_CLASSES.map((label) => [label, rows.filter((row) => row.signalClass === label).length]));
  const byWindow = Object.fromEntries(ALL_WINDOWS.map((windowLabel) => [windowLabel, outcomes.filter((outcome) => outcome.windowLabel === windowLabel).length]));
  const byClass = Object.fromEntries(ALL_CLASSES.map((label) => [label, buildClassSection(rows.filter((row) => row.signalClass === label))]));

  const summary = {
    totalWatchOnlyCandidates: db.listWatchOnlyCandidates().length,
    totalAnalyzedCandidates: db.listWatchOnlySignalAnalyses().length,
    signalClassCounts: classCounts,
    outcomeCountsByWindow: byWindow,
    bestGainOverall: safeMax(rows.map((row) => row.bestGainPct)),
    worstDrawdownOverall: safeMin(rows.map((row) => row.worstDrawdownPct)),
    averageBestGainByClass: Object.fromEntries(ALL_CLASSES.map((label) => [label, safeAverage(rows.filter((row) => row.signalClass === label).map((row) => row.bestGainPct))])),
    averageWorstDrawdownByClass: Object.fromEntries(ALL_CLASSES.map((label) => [label, safeAverage(rows.filter((row) => row.signalClass === label).map((row) => row.worstDrawdownPct))])),
    averageMovedBeforeDiscoveryByClass: Object.fromEntries(ALL_CLASSES.map((label) => [label, safeAverage(rows.filter((row) => row.signalClass === label).map((row) => row.movedBeforeDiscoveryPct))])),
    paperBuysOpened: db.getOpenPositionCount('PAPER'),
    realTradeAttempts: db.getBlockedRealTradeAttempts(),
    paperTakeProfitPct: config.paperTakeProfitPct,
    paperStopLossPct: config.paperStopLossPct,
    finalSafetyStatus: 'Real trading remains locked.'
  };

  return {
    summary,
    candidateRows: rows,
    classSections: byClass,
    comparison: buildComparisonSection(rows),
    operatorConclusion: buildOperatorConclusion(rows),
    finalSafetyStatus: 'Real trading remains locked.'
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : `${value}${' '.repeat(width - value.length)}`;
}

export function formatSignalAuditTable(report: SignalAuditReport): string {
  const header = [
    pad('id', 6),
    pad('symbol', 10),
    pad('class', 15),
    pad('bestGain', 10),
    pad('worstDD', 10),
    pad('moveBefore', 11),
    pad('liqEntry', 10),
    pad('source', 24)
  ].join(' | ');

  const rows = report.candidateRows.map((row) => [
    pad(String(row.watchCandidateId), 6),
    pad(String(row.symbol ?? '-'), 10),
    pad(String(row.signalClass ?? '-'), 15),
    pad(row.bestGainPct === null ? '-' : String(row.bestGainPct), 10),
    pad(row.worstDrawdownPct === null ? '-' : String(row.worstDrawdownPct), 10),
    pad(row.movedBeforeDiscoveryPct === null ? '-' : String(row.movedBeforeDiscoveryPct), 11),
    pad(row.liquidityUsdAtEntry === null ? '-' : String(row.liquidityUsdAtEntry), 10),
    pad(String(row.sourceUrl ?? '-'), 24)
  ].join(' | '));

  return [
    'Signal Audit Report',
    JSON.stringify(report.summary, null, 2),
    header,
    '-'.repeat(header.length),
    ...rows,
    '',
    `Operator conclusion: ${report.operatorConclusion.join('; ') || 'None'}`,
    report.finalSafetyStatus
  ].join('\n');
}

export function renderSignalAudit(report: SignalAuditReport, env: NodeJS.ProcessEnv = process.env): string {
  return parseFormat(env.SIGNAL_AUDIT_FORMAT) === 'table'
    ? formatSignalAuditTable(report)
    : JSON.stringify(report, null, 2);
}
