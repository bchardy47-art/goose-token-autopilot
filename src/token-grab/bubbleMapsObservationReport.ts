import * as fs from 'fs';
import { readFixturesFromJsonl, type LiveRipperFixture } from './liveFixtureCapture';
import type { ClusterRisk } from './dexRipperEngine';

export interface BubbleMapsObservationReportOptions {
  inputPath?: string;
  generatedAt?: string;
  sinceMinutes?: number;
}

export interface BubbleMapsObservationRow {
  symbol: string;
  contractShort: string;
  clusterProvider: string;
  clusterRisk: ClusterRisk;
  clusterNotesSummary: string;
  buyGateDecision: string;
  realTradingLocked: boolean;
  tradingExecuted: 0;
}

export interface BubbleMapsObservationReportResult {
  inputPath: string;
  inputMissing: boolean;
  generatedAt: string;
  sinceMinutes: number | null;
  totalFixtures: number;
  newestCaptureAt: string | null;
  oldestCaptureAt: string | null;
  ageBucketCounts: {
    last15Minutes: number;
    last1Hour: number;
    last24Hours: number;
    olderThan24Hours: number;
    unknown: number;
  };
  bubblemapsProviderCount: number;
  offlineProviderCount: number;
  clusterRiskCounts: Record<ClusterRisk, number>;
  clusterFetchErrorCount: number;
  latestClusterCheckedAt: string | null;
  sampleRecentRows: BubbleMapsObservationRow[];
  tradingExecuted: 0;
  noRealTradeSent: true;
  paperOnly: true;
  readOnly: true;
}

const DEFAULT_INPUT = 'data/token-grab/ripper/live-fixtures.jsonl';

function getRaw(f: LiveRipperFixture): Record<string, unknown> {
  return (f.raw as Record<string, unknown> | undefined) ?? {};
}

function getClusterRisk(f: LiveRipperFixture): ClusterRisk {
  const v = getRaw(f)['clusterRisk'];
  if (v === 'CLEAN') return 'CLEAN';
  if (v === 'WATCH') return 'WATCH';
  if (v === 'RISKY') return 'RISKY';
  return 'UNKNOWN';
}

function getClusterProvider(f: LiveRipperFixture): string {
  const v = getRaw(f)['clusterProvider'];
  return typeof v === 'string' && v.trim() ? v : 'unknown';
}

function getClusterCheckedAt(f: LiveRipperFixture): string | null {
  const v = getRaw(f)['clusterCheckedAt'];
  return typeof v === 'string' && v.trim() ? v : null;
}

function getClusterFetchError(f: LiveRipperFixture): string | null {
  const v = getRaw(f)['clusterFetchError'];
  return typeof v === 'string' && v.trim() ? v : null;
}

function getClusterNotesSummary(f: LiveRipperFixture): string {
  const v = getRaw(f)['clusterNotes'];
  if (!Array.isArray(v) || v.length === 0) return '—';
  const joined = v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .slice(0, 2)
    .join('; ');
  return joined || '—';
}

function getSymbol(f: LiveRipperFixture): string {
  const sig = f.normalizedSignal as Record<string, unknown> | undefined;
  const v = sig?.['symbol'];
  return typeof v === 'string' && v.trim() ? v : 'UNKNOWN';
}

function getContract(f: LiveRipperFixture): string {
  const ripperInput = f.ripperInput as Record<string, unknown> | null;
  if (typeof ripperInput?.['contract'] === 'string' && ripperInput['contract']) return ripperInput['contract'];
  const sig = f.normalizedSignal as Record<string, unknown> | undefined;
  if (typeof sig?.['contract'] === 'string' && sig['contract']) return sig['contract'];
  const raw = getRaw(f);
  if (typeof raw['contract'] === 'string' && raw['contract']) return raw['contract'] as string;
  if (typeof raw['contractAddress'] === 'string' && raw['contractAddress']) return raw['contractAddress'] as string;
  return 'unknown';
}

function shortenContract(contract: string): string {
  if (contract.length <= 12) return contract;
  return `${contract.slice(0, 4)}…${contract.slice(-4)}`;
}

function toTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function runBubbleMapsObservationReport(
  options: BubbleMapsObservationReportOptions = {},
): BubbleMapsObservationReportResult {
  const inputPath = options.inputPath ?? DEFAULT_INPUT;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sinceMinutes = options.sinceMinutes ?? null;
  const emptyCounts: Record<ClusterRisk, number> = { CLEAN: 0, WATCH: 0, RISKY: 0, UNKNOWN: 0 };
  const generatedAtMs = toTimeMs(generatedAt);

  const base: Omit<BubbleMapsObservationReportResult, 'inputPath' | 'inputMissing' | 'generatedAt'> = {
    sinceMinutes,
    totalFixtures: 0,
    newestCaptureAt: null,
    oldestCaptureAt: null,
    ageBucketCounts: {
      last15Minutes: 0,
      last1Hour: 0,
      last24Hours: 0,
      olderThan24Hours: 0,
      unknown: 0,
    },
    bubblemapsProviderCount: 0,
    offlineProviderCount: 0,
    clusterRiskCounts: { ...emptyCounts },
    clusterFetchErrorCount: 0,
    latestClusterCheckedAt: null,
    sampleRecentRows: [],
    tradingExecuted: 0,
    noRealTradeSent: true,
    paperOnly: true,
    readOnly: true,
  };

  if (!fs.existsSync(inputPath)) {
    return { inputPath, inputMissing: true, generatedAt, ...base };
  }

  const allFixtures = readFixturesFromJsonl(inputPath);
  const sinceCutoffMs = sinceMinutes != null && generatedAtMs != null
    ? generatedAtMs - sinceMinutes * 60_000
    : null;

  const fixtures = sinceCutoffMs == null
    ? allFixtures
    : allFixtures.filter(f => {
        const capturedMs = toTimeMs(f.capturedAt);
        return capturedMs != null && capturedMs >= sinceCutoffMs;
      });

  base.totalFixtures = fixtures.length;

  for (const f of fixtures) {
    const provider = getClusterProvider(f);
    if (provider === 'bubblemaps') base.bubblemapsProviderCount++;
    if (provider === 'offline') base.offlineProviderCount++;
    base.clusterRiskCounts[getClusterRisk(f)]++;
    if (getClusterFetchError(f)) base.clusterFetchErrorCount++;

    const checkedAt = getClusterCheckedAt(f);
    if (checkedAt && (!base.latestClusterCheckedAt || checkedAt > base.latestClusterCheckedAt)) {
      base.latestClusterCheckedAt = checkedAt;
    }

    const capturedAt = typeof f.capturedAt === 'string' && f.capturedAt.trim() ? f.capturedAt : null;
    if (capturedAt && (!base.newestCaptureAt || capturedAt > base.newestCaptureAt)) {
      base.newestCaptureAt = capturedAt;
    }
    if (capturedAt && (!base.oldestCaptureAt || capturedAt < base.oldestCaptureAt)) {
      base.oldestCaptureAt = capturedAt;
    }

    const capturedMs = toTimeMs(capturedAt);
    if (capturedMs == null || generatedAtMs == null) {
      base.ageBucketCounts.unknown++;
    } else {
      const ageMinutes = (generatedAtMs - capturedMs) / 60_000;
      if (ageMinutes <= 15) base.ageBucketCounts.last15Minutes++;
      else if (ageMinutes <= 60) base.ageBucketCounts.last1Hour++;
      else if (ageMinutes <= 24 * 60) base.ageBucketCounts.last24Hours++;
      else base.ageBucketCounts.olderThan24Hours++;
    }
  }

  base.sampleRecentRows = [...fixtures]
    .sort((a, b) => {
      const aTs = getClusterCheckedAt(a) ?? a.capturedAt ?? '';
      const bTs = getClusterCheckedAt(b) ?? b.capturedAt ?? '';
      return bTs.localeCompare(aTs);
    })
    .slice(0, 5)
    .map(f => ({
      symbol: getSymbol(f),
      contractShort: shortenContract(getContract(f)),
      clusterProvider: getClusterProvider(f),
      clusterRisk: getClusterRisk(f),
      clusterNotesSummary: getClusterNotesSummary(f),
      buyGateDecision: f.buyGateDecision ?? 'UNKNOWN',
      realTradingLocked: f.realTradingLocked === true,
      tradingExecuted: 0 as const,
    }));

  return { inputPath, inputMissing: false, generatedAt, ...base };
}

export function renderBubbleMapsObservationReport(result: BubbleMapsObservationReportResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('  TOKEN GRAB — BUBBLEMAPS OBSERVATION REPORT');
  lines.push('  [REAL TRADING LOCKED — REPORT ONLY — READ ONLY]');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  if (result.inputMissing) {
    lines.push(`  No fixture file found at: ${result.inputPath}`);
    lines.push('  Run token:live-fixture-capture first.');
    lines.push('');
    lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`  Generated              : ${result.generatedAt}`);
  lines.push(`  Input                  : ${result.inputPath}`);
  if (result.sinceMinutes != null) {
    lines.push(`  Filter                 : captured within last ${result.sinceMinutes} minute(s)`);
  }
  lines.push(`  Total fixtures         : ${result.totalFixtures}`);
  lines.push(`  Newest capture         : ${result.newestCaptureAt ?? 'n/a'}`);
  lines.push(`  Oldest capture         : ${result.oldestCaptureAt ?? 'n/a'}`);
  lines.push(`  Provider=bubblemaps    : ${result.bubblemapsProviderCount}`);
  lines.push(`  Provider=offline       : ${result.offlineProviderCount}`);
  lines.push(`  clusterFetchError count: ${result.clusterFetchErrorCount}`);
  lines.push(`  Latest clusterCheckedAt: ${result.latestClusterCheckedAt ?? 'n/a'}`);
  lines.push('');

  lines.push('  FIXTURE AGE BUCKETS');
  lines.push(`    last 15 minutes : ${result.ageBucketCounts.last15Minutes}`);
  lines.push(`    last 1 hour     : ${result.ageBucketCounts.last1Hour}`);
  lines.push(`    last 24 hours   : ${result.ageBucketCounts.last24Hours}`);
  lines.push(`    older than 24h  : ${result.ageBucketCounts.olderThan24Hours}`);
  lines.push(`    unknown         : ${result.ageBucketCounts.unknown}`);
  lines.push('');

  if (result.ageBucketCounts.olderThan24Hours > 0 && result.sinceMinutes == null) {
    lines.push('  NOTE');
    lines.push('  Older fixtures may predate current BubbleMaps gate behavior; use --since-minutes for fresh validation.');
    lines.push('');
  }

  lines.push('  CLUSTER RISK COUNTS');
  for (const risk of ['CLEAN', 'WATCH', 'RISKY', 'UNKNOWN'] as const) {
    lines.push(`    ${risk.padEnd(8)} : ${result.clusterRiskCounts[risk]}`);
  }
  lines.push('');

  if (result.sampleRecentRows.length > 0) {
    lines.push('  RECENT SAMPLE ROWS');
    for (const row of result.sampleRecentRows) {
      lines.push(
        `    $${row.symbol.padEnd(10)} ${row.contractShort.padEnd(10)} ${row.clusterProvider.padEnd(11)} ${row.clusterRisk.padEnd(7)} ${row.buyGateDecision}`,
      );
      lines.push(
        `      notes=${row.clusterNotesSummary} | realTradingLocked=${row.realTradingLocked} | tradingExecuted=${row.tradingExecuted}`,
      );
    }
    lines.push('');
  }

  lines.push('  SAFETY');
  lines.push('  This report is read-only, makes no API calls, and performs no trading.');
  lines.push('  tradingExecuted=0  noRealTradeSent=true  paperOnly=true  readOnly=true');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  return lines.join('\n');
}
